/**
 * 网关转发核心
 * 移植自上游:
 *   - internal/handler/gateway_forward_as_chat_completions.go:29
 *   - internal/handler/gateway_forward_as_responses.go:31
 *   - internal/service/gateway_upstream_request.go
 *   - internal/service/openai_gateway_forward.go
 *
 * 职责: 入站请求 -> 选号 -> 构造上游请求 -> 转发 -> 透传响应 -> 计费
 */

import {
  buildGeminiUrl,
  buildUpstreamHeaders,
  defaultBaseUrl,
  deriveUpstreamEndpoint,
  extractCredential,
  resolveProtocol,
  type Platform,
  type UpstreamProtocol,
} from './protocol';
import {
  computeTokenBreakdown,
  combineRateMultiplier,
  resolveModelPrice,
  parseDefaultPrice,
  fingerprintRequest,
  DEFAULT_PRICE,
  DEFAULT_PRICE_SETTING,
} from './billing';
import { applyBilling, logFailure } from './billing-repo';
import {
  checkAccountRpm,
  computeSessionHash,
  diagnoseUnavailable,
  releaseAccount,
  selectAccount,
} from './scheduler';
import { parseUsageFromJson, translateStreamingResponse, wrapStreamingResponse } from './stream';
import {
  createSseTranslator,
  detectInboundFormat,
  translateRequest,
  translateResponse,
  upstreamFormatFor,
  upstreamPathFor,
} from './translate';
import { EMPTY_USAGE, type AccountRow, type AuthContext, type Env, type ModelPrice } from './types';

/**
 * 占位凭证识别 —— 种子数据里是 sk-REPLACE_ME 这类假 key。
 * 命中时直接给出可操作的报错, 而不是把上游那句难懂的 401 甩给用户。
 */
const PLACEHOLDER_CREDENTIAL_RE = /REPLACE_ME|REPLACE-ME|PLACEHOLDER|your[_-]?api[_-]?key|xxx+$/i;

/** 允许转发的入站路径前缀 */
const GATEWAY_PATH_PREFIXES = ['/v1/', '/v1beta/', '/backend-api/', '/antigravity/', '/responses', '/chat/completions', '/embeddings', '/models', '/images/', '/videos/'];

export function isGatewayPath(pathname: string): boolean {
  return GATEWAY_PATH_PREFIXES.some((p) => pathname.startsWith(p));
}

/**
 * 「入口路径」路由命中结果 —— **由请求 URL 决定上游**, 不看模型名。
 *
 * 客户端请求 `/<entryPath>/v1/chat/completions` 时, 第一段就是某条上游账号
 * 在后台配置的入口路径, 网关据此直接锁定该账号(它的 base_url + 它的别名表)。
 */
export interface EntryRoute {
  /** URL 第一段, 即 accounts.entry_path */
  entryPath: string;
  accountId: number;
  platform: Platform;
}

/**
 * 把 `/<seg>/<rest>` 拆开 —— 只有**既不像协议路径、rest 又确实是网关路径**时
 * 才认为 seg 可能是入口路径。
 *
 * 单独抽出来是因为它是纯函数: 能直接单测(见 tools/test-entry-path.mjs),
 * 不用起 Worker 也能验证「哪类 URL 会被当成入口路径」。
 */
export function splitEntryPrefix(pathname: string): { seg: string; rest: string } | null {
  const segEnd = pathname.indexOf('/', 1);
  if (segEnd <= 1) return null;
  const seg = pathname.slice(1, segEnd);
  const rest = pathname.slice(segEnd); // 以 '/' 开头
  if (!seg || ENTRY_SEGMENT_BLOCKLIST.has(seg)) return null;
  if (!isGatewayPath(rest)) return null;
  return { seg, rest };
}

/** 这些第一段是协议/内建路径, 永远不该被当成入口路径去查库 */
export const ENTRY_SEGMENT_BLOCKLIST = new Set([
  'v1', 'v1beta', 'backend-api', 'antigravity',
  'responses', 'chat', 'completions', 'embeddings', 'models', 'images', 'videos',
  'admin', 'api', 'health', 'healthz', 'favicon.ico',
  // ---- 控制台菜单路径 (2026-09-21: 菜单从 /admin/<page> 挪到 /<page>) ----
  // 这些段被后台页面占用, 上游账号的 entry_path **不许**再使用它们, 否则
  // 一条 /<seg>/v1/... 的网关请求会先被页面路由截胡(表现为返回 HTML 而非 JSON)。
  // 后台保存入口路径时也会被 `isReservedEntrySegment()` 拦下(见 admin-api.ts)。
  // `discover` 是旧「模型获取」页的段名 —— 该页已并入「模型定价」, 但**继续保留**:
  // 保留段的名单放宽会让"以前存不进去的配置"突然变得能存, 收紧才是安全的改动方向。
  'dashboard', 'overview', 'mykeys', 'keys', 'accounts', 'discover', 'aliases',
  'groups', 'users', 'board', 'logs', 'usage', 'audit', 'announce', 'roles', 'profile',
  'settings', 'login', 'register',
]);

/** 该第一段是否为"被系统或控制台页面占用"的保留段(入口路径不可用) */
export function isReservedEntrySegment(seg: string): boolean {
  return ENTRY_SEGMENT_BLOCKLIST.has(String(seg ?? '').trim().toLowerCase());
}

/**
 * 按入口路径查上游账号。
 *
 * 只认 `status='active'` 且未删除的账号 —— 停用/删除的上游不该继续接流量,
 * 查不到就返回 null, 让请求退回通用路由, 而不是打到一条已下线的上游。
 *
 * 查库失败(典型: 迁移还没跑, entry_path 列不存在)同样返回 null ——
 * **不能因为读不到索引就把线上流量打挂**, 退化成老路由即可。
 */
export async function findAccountByEntryPath(
  env: Env,
  entryPath: string,
): Promise<{ id: number; platform: string } | null> {
  try {
    const row = await env.DB.prepare(
      `SELECT id, platform FROM accounts
        WHERE entry_path = ?1 AND deleted_at IS NULL AND status = 'active'
        LIMIT 1`,
    )
      .bind(entryPath)
      .first<{ id: number; platform: string }>();
    return row ?? null;
  } catch {
    return null;
  }
}

/**
 * 入口路径锁定的上游不可用时, 给出**可操作**的原因。
 *
 * 不查这一下的话, 用户只会看到 "No upstream account for platform X" ——
 * 那句话会误导人去分组里加账号, 而真正的原因可能是这条上游被停用、
 * 没绑分组、或者并发槽位占满了。
 */
async function describeEntryFailure(env: Env, entry: EntryRoute): Promise<string> {
  const head =
    `Entry path "/${entry.entryPath}" is pinned to upstream account #${entry.accountId}`;
  const fix = 'Fix it in /admin -> 上游账号.';
  try {
    const row = await env.DB.prepare(
      `SELECT name, status, schedulable, deleted_at,
              (SELECT COUNT(*) FROM account_groups ag WHERE ag.account_id = accounts.id) AS group_count
         FROM accounts WHERE id = ?1`,
    )
      .bind(entry.accountId)
      .first<{ name: string; status: string; schedulable: number; deleted_at: string | null; group_count: number }>();

    if (!row || row.deleted_at) {
      return `${head}, but that account no longer exists. Pick another entry path. ${fix}`;
    }
    if (String(row.status) !== 'active') {
      return `${head} ("${row.name}"), but its status is "${row.status}" — set it to active. ${fix}`;
    }
    if (Number(row.schedulable) !== 1) {
      return `${head} ("${row.name}"), but 可调度 is off — turn it on. ${fix}`;
    }
    if (Number(row.group_count) === 0) {
      return `${head} ("${row.name}"), but it is not bound to any group — this key cannot reach it. ${fix}`;
    }
    return (
      `${head} ("${row.name}"), but it has no free concurrency slot right now. ` +
      `Retry shortly, or raise 并发上限. ${fix}`
    );
  } catch {
    return `${head}, but it is not available right now. ${fix}`;
  }
}

/**
 * 按模型名推断平台 —— **[已废弃, 2026-09 停用]**
 *
 * 保留说明: 曾经用模型名前缀把 glm->zhipu / kimi->kimi / claude->anthropic,
 * 但接入中转上游后这个假设不成立(第三方中转上的 `glm-*` 并不由智普官方服务),
 * 猜出来的平台常常没有账号 -> 503。现在改为基于账号模型索引的"自动发现"
 * (见 buildAutoDiscoverIndex / inferPlatform 第 4 步)。
 *
 * 保留函数体供历史对比, 路由链路已不再调用。
 */
/* eslint-disable @typescript-eslint/no-unused-vars */
function inferPlatformFromModel(model: string): Platform | null {
  const m = model.toLowerCase();
  if (m.startsWith('claude') || m.includes('anthropic')) return 'anthropic';
  if (m.startsWith('gemini') || m.startsWith('models/gemini')) return 'gemini';
  if (m.startsWith('grok')) return 'grok';
  if (m.startsWith('deepseek') || m.includes('deepseek')) return 'deepseek';
  if (m.startsWith('moonshot') || m.startsWith('kimi')) return 'kimi';
  if (m.startsWith('glm') || m.startsWith('zhipu')) return 'zhipu';
  if (m.startsWith('minimax') || m.startsWith('abab')) return 'minimax';
  // OpenAI 家族 —— 没有这条时, Anthropic 客户端选 gpt-4o 会落到 anthropic 账号
  if (/^(gpt-|gpt$|o[1-9](-|$)|chatgpt|davinci|text-|dall-e|whisper|tts-)/.test(m) || m.includes('openai')) {
    return 'openai';
  }
  return null;
}
/* eslint-enable @typescript-eslint/no-unused-vars */

/**
 * 解析「模型 → 平台」重定向配置的一项
 *
 * 支持两种写法:
 *   "sensenova"                                        —— 只指定平台
 *   {"platform":"sensenova","model":"deepseek-v4-pro"} —— 顺带把模型名改写成对端要求的写法
 *
 * 第二种存在的理由: 不同上游对模型名**大小写**要求相反。
 * sensenova 只认全小写 `deepseek-v4-pro`, 而 chatapi 只认 `Deepseek-v4-flash`。
 * 让用户去记"这个名字该大写那个该小写"不现实, 所以在路由规则里一并声明。
 */
export function resolveModelPlatformRoute(
  ctx: AuthContext,
  model: string,
): { platform: string; model?: string; key?: string } | null {
  const hit = lookupModelRoute(ctx, model);
  if (!hit) return null;
  const routed = hit.value;

  if (typeof routed === 'string') {
    const p = routed.trim();
    return p ? { platform: p, key: hit.key } : null;
  }
  if (typeof routed === 'object') {
    const o = routed as Record<string, unknown>;
    const p = String(o.platform ?? '').trim();
    if (!p) return null;
    const m = o.model === undefined || o.model === null ? '' : String(o.model).trim();
    return m ? { platform: p, model: m, key: hit.key } : { platform: p, key: hit.key };
  }
  return null;
}

/**
 * 在重定向表里查一个模型 —— **精确优先, 其次大小写不敏感**
 *
 * 为什么要模糊一层: 不同客户端对模型名的大小写处理不一样 (有的原样透传,
 * 有的规范化成大写/小写)。用户配表时不可能穷举 GLM-5.2 / Glm-5.2 / glm-5.2,
 * 而漏掉的那个写法会直接掉进"按模型名推断"分支 —— 于是 glm-* 去找不存在的
 * zhipu 平台, 报 503 no_upstream_account。措辞看起来像"没配账号",
 * 实际是"配了但没命中"。
 *
 * 返回**命中的 key**: 简写形式下 key 就是"对端认识的名字", 调用方据此
 * 归一化大小写, 避免把 GLM-5.2 原样转发给只认小写的上游。
 *
 * 精确命中永远优先, 所以用户仍可用大小写区分同名不同源的模型(极少见);
 * 只有在精确查不到时才退化到不区分大小写。
 */
function lookupModelRoute(
  ctx: AuthContext,
  model: string,
): { key: string; value: string | { platform: string; model?: string } } | null {
  const table = ctx.groupModelPlatformRouting;
  if (!table || !model) return null;

  const exact = table[model];
  if (exact !== undefined) return { key: model, value: exact };

  const want = model.toLowerCase();
  for (const key of Object.keys(table)) {
    if (key.toLowerCase() === want) return { key, value: table[key] };
  }
  return null;
}

/**
 * 推断入站请求要发往哪个平台
 * 上游由分组 platform 决定(compositeTarget 中间件), 这里优先用分组配置,
 * 分组未指定时按入站路径特征推断
 *
 * 决策顺序 (2026-09 起, 「按模型名猜平台」已移除, 见下方说明):
 *   1. 分组「模型 → 平台」重定向表   —— 精确派发, 优先级最高
 *   2. 分组 platform 配置            —— 管理员显式指定
 *   3. 用户级平台白名单(恰好一个)     —— 收敛
 *   4. 自动发现(模型索引)            —— 哪个账号真的提供这个模型就往哪走
 *   5. 路径特征兜底                  —— /v1beta/ -> gemini, /messages -> anthropic
 *
 * **为什么删掉"按模型名推断平台"**(glm->zhipu / kimi->kimi):
 *   我们用中转上游(第三方兼容网关)。中转上叫 `glm-5.2` 的模型, 服务它的可能是
 *   任一平台账号, 而不是智普官方 —— 按名字猜出来的 `zhipu` 平台根本没账号,
 *   于是请求 503 no_upstream_account, 报错措辞还误导用户"没配账号"。
 *   现在改为「事实驱动」: 模型名出现在哪个账号的模型索引里, 就路由到那个平台;
 *   索引里查不到才退回路径推断。这样**新模型无需改任何配置**就能自动归到中转。
 */
export function inferPlatform(
  ctx: AuthContext,
  pathname: string,
  model = '',
  discover: Map<string, DiscoverHit> | null = null,
): Platform {
  // 用户级平台白名单先算出来 —— 后面所有分支都不能越界
  const access = (ctx.userPlatformAccess ?? '').split(',').map((s) => s.trim()).filter(Boolean);

  // ---- 显式「模型名 → 平台」重定向 (优先级最高) ----
  //
  // 场景: 同一个模型名需要精确派发到某个平台。典型例子是
  // `deepseek-v4-pro` 只有 sensenova 提供, 而 `deepseek-v4-flash` 只有 chatapi 提供
  // —— 光靠模型名推断两者都会命中 `deepseek`, 无法区分。
  // 分组里配 {"deepseek-v4-pro":"sensenova"} 就能把 pro 定向过去。
  const route = model ? resolveModelPlatformRoute(ctx, model) : null;
  if (route) {
    const target = route.platform as Platform;
    // 用户有白名单时不能越界 —— 越界就退回白名单首个平台
    if (access.length > 0 && !access.includes(target)) return access[0] as Platform;
    return target;
  }

  const gp = (ctx.groupPlatform ?? '').trim();
  if (gp) {
    const list = gp.split(',').map((s) => s.trim()).filter(Boolean);
    if (list.length === 1) return list[0] as Platform;
    // 多平台分组: 按路径挑最合适的
    if (pathname.startsWith('/v1beta/')) return 'gemini';
    if (pathname.startsWith('/backend-api/') || pathname.startsWith('/antigravity/')) {
      return list.includes('openai') ? 'openai' : (list[0] as Platform);
    }
    if (pathname.includes('/messages')) {
      const anth = list.find((p) => ['anthropic', 'kimi', 'zhipu', 'minimax'].includes(p));
      if (anth) return anth as Platform;
    }
    return list[0] as Platform;
  }

  // 用户级平台限制: 只允许一个平台时直接锁定 —— 修复"Claude 模型被路由到 OpenAI"
  if (access.length === 1) return access[0] as Platform;

  // ---- 自动发现: 以"账号模型索引"为事实依据, 取代"按模型名猜平台" ----
  // 新模型(glm-4.6 / kimi-k2 ...)只要曾在该账号「模型获取」里出现过, 就会命中。
  if (model && discover && discover.size > 0) {
    const hit = discover.get(model.toLowerCase());
    if (hit) {
      const target = hit.platform as Platform;
      // 白名单同样不能越界 —— 但比"猜平台"更值得尊重时仍受约束
      if (access.length > 0 && !access.includes(target)) return access[0] as Platform;
      return target;
    }
  }

  // ---- 路径特征兜底 (不再看模型名) ----
  if (pathname.startsWith('/v1beta/')) return 'gemini';
  if (pathname.includes('/messages')) return 'anthropic';
  return 'openai';
}

/** 加载 D1 模型定价表 */
async function loadDbPricing(env: Env): Promise<Map<string, ModelPrice>> {
  const map = new Map<string, ModelPrice>();
  try {
    const res = await env.DB.prepare(
      `SELECT model, input_price, output_price, cache_read_price, cache_creation_price FROM model_pricing`,
    ).all<ModelPrice & { model: string }>();
    for (const r of res.results ?? []) {
      map.set(r.model, {
        input_price: Number(r.input_price),
        output_price: Number(r.output_price),
        cache_read_price: Number(r.cache_read_price),
        cache_creation_price: Number(r.cache_creation_price),
      });
    }
  } catch {
    // 表不存在 = 还没配过任何价, 交给「默认单价」兜底
  }
  return map;
}

/**
 * 加载控制台里配的「默认单价」(`settings.model_pricing_default`)。
 *
 * 这是**唯一**的兜底来源 —— 代码里不再有按模型名硬编码的价格表。
 * 读不到 / 坏数据一律回出厂值, 且**绝不抛异常**: 计费链路上不能因为读设置失败把请求搞挂。
 */
async function loadDefaultPrice(env: Env): Promise<ModelPrice> {
  try {
    const row = await env.DB.prepare(`SELECT value FROM settings WHERE key = ?1`)
      .bind(DEFAULT_PRICE_SETTING)
      .first<{ value: string }>();
    return parseDefaultPrice(row?.value);
  } catch {
    return DEFAULT_PRICE;
  }
}

/** Gemini 原生路径里的模型名: /v1beta/models/{model}:generateContent */
function extractModelFromPath(pathname: string): string {
  const m = /\/models\/([^/:]+)/.exec(pathname);
  return m ? decodeURIComponent(m[1]) : '';
}

/** 从请求体里取模型名; 取不到时回退到 Gemini 原生路径(模型名在 URL 上而非 body) */
function extractModel(body: Record<string, unknown>, pathname = ''): string {
  const fromBody = body['model'];
  if (typeof fromBody === 'string' && fromBody) return fromBody;
  return extractModelFromPath(pathname);
}

/** 模型映射: 分组 default_mapped_model / model_routing */
function mapModel(ctx: AuthContext, model: string): { requested: string; mapped: string } {
  const requested = model;
  if (ctx.groupModelRoutingEnabled && ctx.groupModelRouting) {
    const routed = ctx.groupModelRouting[model];
    if (typeof routed === 'string' && routed) return { requested, mapped: routed };
  }
  if (ctx.groupDefaultMappedModel) {
    return { requested, mapped: ctx.groupDefaultMappedModel };
  }
  return { requested, mapped: model };
}

/**
 * 从账号的 `extra` JSON 里取「模型名改写表」(可选)
 *
 * 场景 —— **模型 ID 冲突**: 同一个名字在不同上游指的不是同一个东西。
 * 例: 你的第三方中转把智谱的模型叫 `glm-5.2`, 而另一条上游也叫 `glm-5.2`
 * 但其实是别家的; 或者中转对某模型用了自己的内部名 (`my-glm-pro`)。
 *
 * `extra.model_aliases` 就是给**单个账号**声明:
 *   { "对外名": "这个上游认识的名字" }
 * 转发到该账号时把模型名换成后者 —— 于是「同一个对外模型名, 不同上游各有各的写法」
 * 这件事就有了归宿, 不必再往分组的路由表里堆全局规则。
 *
 * extra 是既有 JSON 列, 因此**不需要 schema 迁移**。
 */
function accountModelAliases(account: AccountRow): Record<string, string> {
  try {
    const extra = account.extra ? (JSON.parse(account.extra) as Record<string, unknown>) : null;
    const raw = extra?.['model_aliases'];
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      const name = String(k ?? '').trim();
      const target = String(v ?? '').trim();
      if (name && target) out[name] = target;
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * 解析入参里的模型索引 —— 既接受 JSON 字符串, 也接受已解析的数组。
 *
 * 统一出口的意义: schema 里它是 TEXT 列, 但路由时可能已经被 JSON.parse 过;
 * 两个来源都收敛到这里, 调用方不必关心。
 * 任何非数组 / 解析失败一律当空 —— 坏数据不能让路由整体挂掉。
 */
function toModelList(raw: unknown): string[] {
  let arr: unknown = raw;
  if (typeof raw === 'string') {
    const s = raw.trim();
    if (!s) return [];
    try {
      arr = JSON.parse(s);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(arr)) return [];
  const out: string[] = [];
  for (const item of arr) {
    const v = String(item ?? '').trim();
    if (v) out.push(v);
  }
  return out;
}

/**
 * 取账号"已知能提供"的模型名集合 (对外名, 小写归一)
 *
 * 来源有两个, 合并使用 —— 这正是"新模型自动归到中转"的数据基础:
 *   1. `accounts.model_index` —— 后台「模型获取」从上游拉回来的真实列表
 *   2. `extra.model_aliases` 的**键** —— 用户手工声明的对外名
 *      (值是对端认识的名字, 不是对外名, 所以不能参与匹配)
 *
 * 中小写归一, 因为客户端对模型名大小写处理不一致。
 */
function accountKnownModels(account: AccountRow): Set<string> {
  const out = new Set<string>();
  for (const m of toModelList(account.model_index)) out.add(m.toLowerCase());
  for (const k of Object.keys(accountModelAliases(account))) out.add(k.toLowerCase());
  return out;
}

/**
 * 读 `accounts.model_index` —— 兼容两种落库形态(JSON 字符串 / 已解析数组)。
 */
function accountModelIndex(account: AccountRow): string[] {
  return toModelList(account.model_index);
}

/** 模型名是否被该账号明确声明支持(大小写不敏感) —— 用于自动发现路由 */
function accountServesModel(account: AccountRow, model: string): boolean {
  if (!model) return false;
  return accountKnownModels(account).has(model.toLowerCase());
}

/**
 * 自动发现索引里的一条命中
 *
 * `accountId` 不能少: 别名是**账号级**的声明, 只知道 platform 的话,
 * 选号阶段会在该平台下随便挑一个账号 —— 同平台有多个账号(两个中转都填了
 * 同一个平台名)时就会挑错: 挑到的账号没有这条别名, 于是既不改名、
 * base_url 也不是用户配的那个, 上游直接 404。
 * 带上 accountId 后选号可以优先落在"真正声明了这个模型的账号"上。
 */
export interface DiscoverHit {
  platform: string;
  accountId: number;
  /**
   * 命中来源是**账号别名**时, 这里是别名的值(该上游认识的名字); 否则为 null。
   *
   * 用途: 分组白名单里写的是"对端名字"(如 glm-5.2), 而客户端可能发的是
   * 别名(如 sensenova-glm-5.2)。两者是同一个模型的两种叫法, 白名单校验
   * 必须把别名归一到对端名字再判, 否则别名会被 403 not allowed 挡掉 ——
   * 表现为"别名明明配了却用不了"。
   */
  outbound: string | null;
}

/**
 * 构建「模型名 -> 平台 + 账号」自动发现索引
 *
 * 场景(用户诉求): "模型 ID 是 glm 就跑到智普, 是 kimi 就跑到 kimi 那边"
 * 这类**按名字猜平台**的行为必须关掉 —— 因为中转上游(第三方)的模型名
 * 跟官方平台并不是一一对应的, 猜出来的平台往往没有账号, 结果 503。
 *
 * 替代方案: 让网关**以事实为准** —— 哪个账号的 model_index / 别名表里
 * 真的列出了这个模型名, 就把它路由到那个账号所在的平台, 并记住是哪个账号。
 *
 * 规则:
 *   - 同一模型名被多个平台声明时, 命中第一个(按账号 id 升序, 结果稳定可预期)
 *   - 索引为空时不产生任何条目 —— 调用方据此退回原有推断链
 */
function buildAutoDiscoverIndex(accounts: AccountRow[]): Map<string, DiscoverHit> {
  const idx = new Map<string, DiscoverHit>();
  const ordered = [...accounts].sort((a, b) => a.id - b.id);
  for (const acc of ordered) {
    const platform = String(acc.platform ?? '').trim();
    if (!platform) continue;

    // 别名表按小写索引 —— 与 accountKnownModels 的归一方式保持一致
    const aliases = accountModelAliases(acc);
    const aliasByLower = new Map<string, string>();
    for (const [k, v] of Object.entries(aliases)) {
      aliasByLower.set(k.toLowerCase(), String(v));
    }

    for (const m of accountKnownModels(acc)) {
      if (!idx.has(m)) {
        idx.set(m, {
          platform,
          accountId: Number(acc.id),
          outbound: aliasByLower.get(m) ?? null,
        });
      }
    }
  }
  return idx;
}

/**
 * 按账号的模型别名表改写模型名 —— 大小写不敏感(与路由表同一策略)
 *
 * 返回改后的名字; 没有命中就原样返回。
 */
function applyAccountAlias(account: AccountRow, model: string): string {
  const aliases = accountModelAliases(account);
  if (!model || Object.keys(aliases).length === 0) return model;
  const exact = aliases[model];
  if (exact) return exact;
  const want = model.toLowerCase();
  for (const [k, v] of Object.entries(aliases)) {
    if (k.toLowerCase() === want) return v;
  }
  return model;
}

/** 构造上游 URL */
function buildUpstreamUrl(
  protocol: UpstreamProtocol,
  account: AccountRow,
  inboundPath: string,
  model: string,
  stream: boolean,
  /** 协议转换后显式指定的上游路径; 为 null 时按入站路径推导 */
  explicitPath: string | null = null,
): string {
  // 自定义平台没有内置默认域名, 必须靠账号上的 base_url
  const base = account.base_url?.trim() || defaultBaseUrl(account.platform);

  if (!base) {
    // 理论上进不来(创建时已强制校验), 兜底避免拼出 undefined/xxx
    throw new Error(
      `Upstream account "${account.name}" has no base_url and platform "${account.platform}" has no default.`,
    );
  }

  if (protocol === 'gemini') {
    const action = stream ? 'streamGenerateContent' : 'generateContent';
    return buildGeminiUrl(base, model, action, stream);
  }

  const endpoint = explicitPath ?? deriveUpstreamEndpoint(protocol, inboundPath);
  return `${base.replace(/\/+$/, '')}${endpoint}`;
}

export async function handleGateway(
  req: Request,
  env: Env,
  ctx: AuthContext,
  requestId: string,
  /** 入口路径命中结果; 非空时**由 URL 直接指定上游**, 跳过全部模型名判定 */
  entry: EntryRoute | null = null,
): Promise<Response> {
  const url = new URL(req.url);
  const pathname = url.pathname;
  const startedAt = Date.now();

  // 客户端信息 —— 计费与失败日志都要用, 提前取
  const clientIp = req.headers.get('cf-connecting-ip') ?? '';
  const userAgent = req.headers.get('user-agent') ?? '';

  // ---- 解析请求体 ----
  let rawBody = '';
  let bodyObj: Record<string, unknown> = {};
  const method = req.method.toUpperCase();

  if (method !== 'GET' && method !== 'HEAD') {
    rawBody = await req.text();
    if (rawBody) {
      try {
        bodyObj = JSON.parse(rawBody) as Record<string, unknown>;
      } catch {
        return errorResponse(
          400,
          'invalid_request_error',
          'Request body must be valid JSON.',
        );
      }
    }
  }

  const requestedModel = extractModel(bodyObj, pathname);

  // ---- 平台判定 ----
  // 平台判定依赖模型名(含"自动发现"), 因此放在解析请求体之后。
  //
  // **入口路径 > 一切**: URL 上带了 /<entry>/ 前缀时, 上游是由 URL 指定的
  // —— 不需要、也不应该再看模型名(模型名对不对是该上游自己的事,
  // 它不认就是名字有问题, 网关不该替它猜)。下面整块模型名判定整段跳过。
  let platform: Platform;
  /** 入口路径锁定的账号(硬锁: 抢不到槽位就报错, 绝不悄悄换一条上游) */
  let lockedAccountId: number | null = null;
  /** 自动发现命中的账号 —— 供选号阶段**优先**落点(软优先) */
  let preferAccountId: number | null = null;
  /** 别名命中的"对端名字" */
  let aliasOutbound: string | null = null;

  if (entry) {
    platform = entry.platform;
    lockedAccountId = entry.accountId;
  } else {
    // 自动发现要查账号模型索引 —— 只在真的需要时才查(重定向表/分组配置能定死时省一次 DB):
    // 先按空索引试一次, 若结果落在"重定向/分组/白名单"三条显式规则上就不必查账号。
    // 但只要走了兜底(说明既没重定向也没分组), 就用账号索引再判一次。
    platform = inferPlatform(ctx, pathname, requestedModel);

    const explicitlyRouted =
      !!resolveModelPlatformRoute(ctx, requestedModel) ||
      !!((ctx.groupPlatform ?? '').trim()) ||
      (ctx.userPlatformAccess ?? '').split(',').map((s) => s.trim()).filter(Boolean).length === 1;

    // 自动发现命中时, 顺带记住"是哪个账号声明了这个模型" —— 供选号阶段优先落点。
    // 这样客户端用**账号别名**请求时, 能走到声明它的那个账号(也就是它的 base_url),
    // 而不是在同一平台的其它账号里随便挑一个(挑错就不改名 + base_url 也不对)。
    if (!explicitlyRouted && requestedModel) {
      // 只在必要时加载账号索引: 这条路径本来就会去查账号(selectAccount), 不额外增加往返。
      const discover = await loadAutoDiscoverIndex(env, ctx.groupId);
      if (discover.size > 0) {
        platform = inferPlatform(ctx, pathname, requestedModel, discover);
        // 只有"平台确实是被自动发现决定的"时才锁账号。若重定向表/分组平台已经
        // 把平台定死了, 就按正常调度挑号 —— 用户的显式配置优先。
        const hit = discover.get(requestedModel.toLowerCase());
        if (hit && hit.platform === platform) {
          preferAccountId = hit.accountId;
          aliasOutbound = hit.outbound ?? null;
        }
      }
    }
  }

  const { requested, mapped } = mapModel(ctx, requestedModel);
  let model = mapped || requested || 'unknown';

  // 平台重定向里若声明了"对端要求的模型名", 以它为准覆盖
  //
  // **入口路径命中时不看重定向表** —— 那条表管的正是"这个模型该去哪个平台",
  // 而 URL 已经把平台定死了, 再看它只会互相打架(URL 说 A, 表说 B, 听谁的都像 bug)。
  //
  // 不同上游对大小写要求相反 (sensenova 只认全小写, chatapi 只认首字母大写),
  // 让用户记这些细节不现实 —— 由路由规则统一声明, 网关负责改写。
  const route = entry ? null : resolveModelPlatformRoute(ctx, requestedModel);
  if (route?.model) {
    model = route.model;
  } else if (route && route.key) {
    // 简写形式 `"glm-5.2":"sensenova"` 没声明对端要求的写法。
    // 但**表里的 key 本身就是"对端认识的名字"** —— 用户把 glm-5.2 写进表里,
    // 说明 sensenova 认的就是这个小写形式。客户端若发 GLM-5.2, 直接转发会被
    // 上游 404 (model is not found)。
    // 所以这里统一改写成表里的 key —— 与 lookupModelRoute 的"大小写不敏感"
    // 配套, 让任意大小写变体最终都落到同一个规范名字上。
    model = route.key;
  }

  // 分组模型白名单校验 —— 对应上游 GroupModelAllowlist 中间件
  //
  // 大小写不敏感: 客户端对模型名的大小写处理不一致(有的原样透传、有的规范化)，
  // 用户在白名单里写 `glm-5.2` 时，收到 `GLM-5.2` 不该被判成"不允许" ——
  // 否则会出现"重定向已经认了大小写变体，白名单却把它挡在门外"的割裂行为。
  if (!isModelAllowedWithAlias(ctx.groupModelAllowlist, requested, aliasOutbound)) {
    return errorResponse(
      403,
      'permission_error',
      `Model ${requested} is not allowed for this group.`,
    );
  }

  // 模型映射需要回写请求体
  if (model !== requestedModel && bodyObj && requestedModel) {
    bodyObj['model'] = model;
    rawBody = JSON.stringify(bodyObj);
  }

  const stream = bodyObj['stream'] === true;

  // ---- 入站线格式 (决定要不要做协议转换) ----
  // 例: Anthropic 客户端(/v1/messages) 选了 Gemini 模型 -> 必须把 body 转成 Gemini 形状
  const inboundFormat = detectInboundFormat(pathname, bodyObj);

  // ---- 选号 ----
  const sessionHash = await computeSessionHash(rawBody || pathname, ctx.userId);
  const selected = await selectAccount(
    env, ctx, platform, sessionHash, requestId, preferAccountId, lockedAccountId,
  );

  if (!selected) {
    // 入口路径是"明说了就要这条上游", 失败时必须把话说清是哪条、为什么不行 ——
    // 泛泛的 "no upstream account for platform X" 会让人以为是分组没配账号。
    if (entry) {
      const why = await describeEntryFailure(env, entry);
      return errorResponse(503, 'api_error', why, 'entry_account_unavailable');
    }
    // 区分「账号全在冷却」与「压根没配账号」: 前者是 429 + Retry-After, 后者才是 503
    const requestedHint = requestedModel || model || '';
    const diag = await diagnoseUnavailable(env, ctx.groupId, platform);
    if (diag.retryAfterMs !== null) {
      const secs = Math.max(1, Math.ceil(diag.retryAfterMs / 1000));
      return errorResponse(
        429,
        'rate_limit_error',
        `All ${diag.totalAccounts} upstream account(s) for platform "${platform}" are temporarily ` +
          `rate-limited by the upstream. Please retry in about ${secs}s.`,
        'upstream_rate_limited',
        { 'retry-after': String(secs) },
      );
    }
    if (diag.totalAccounts === 0) {
      // 最常见的成因不是"忘了加账号", 而是**模型被判定到了没有账号的平台**。
      // 自动发现(账号模型索引)会在无重定向时兜底: 只要该模型在某个账号的
      // 「模型获取」结果里出现过, 就会自动路由过去。走到这里说明索引里也没有,
      // 因此要引导用户去补「模型获取」或加路由, 而不是继续手工猜平台。
      const available = await listAvailablePlatforms(env, ctx.groupId);
      const hint = available.length > 0
        ? ` Configured platforms: ${available.join(', ')}.` +
          ` If this model is served by one of them, run 模型获取 on that account` +
          ` (its model list drives automatic routing), or add a model→platform route for` +
          ` "${requestedHint}" in the group settings (模型 → 平台 重定向).`
        : '';
      return errorResponse(
        503,
        'api_error',
        `No upstream account configured for platform "${platform}". ` +
          `Add one in the admin panel (上游账号).${hint}`,
        'no_upstream_account',
      );
    }
    return errorResponse(
      503,
      'api_error',
      `No available upstream account for platform "${platform}".`,
      'no_available_account',
    );
  }

  const { account } = selected;

  // 账号级 RPM 检查
  if (!(await checkAccountRpm(env, account.id, 0))) {
    await releaseAccount(env, account.id, requestId);
    return errorResponse(429, 'rate_limit_error', 'Upstream account rate limit exceeded.');
  }

  // ---- 构造上游请求 ----
  let credentials: Record<string, unknown> = {};
  try {
    credentials = JSON.parse(account.credentials || '{}') as Record<string, unknown>;
  } catch {
    credentials = {};
  }

  const credential = extractCredential(credentials);
  if (!credential) {
    await releaseAccount(env, account.id, requestId);
    return errorResponse(
      502,
      'api_error',
      `Upstream account "${account.name}" has no usable credential.`,
    );
  }

  // 占位凭证: 种子数据里的 sk-REPLACE_ME 之类。
  // 与其把上游那句 "Incorrect API key provided: sk-REPLA*E_ME" 甩给用户,
  // 不如直接说清是哪个账号没配真 key。
  if (PLACEHOLDER_CREDENTIAL_RE.test(credential)) {
    await releaseAccount(env, account.id, requestId);
    return errorResponse(
      502,
      'api_error',
      `Upstream account "${account.name}" still uses a placeholder credential. ` +
        `Please set a real API key for it in the admin panel (/admin → 上游账号).`,
      'placeholder_credential',
    );
  }

  // 通信协议: 账号显式声明优先, 否则按平台推导(兼容老数据)
  const protocol = resolveProtocol(account.platform, account.protocol);

  // ---- 账号级模型别名 (extra.model_aliases) ----
  //
  // 解决「模型 ID 冲突」: 不同上游对同一个对外模型名各有各的叫法。
  // 例: 客户端发 `glm-5.2`, 但这个中转内部叫 `my-glm-pro` ——
  // 在该账号的 extra 里写 {"glm-5.2":"my-glm-pro"} 即可, 不用动全局路由表。
  //
  // 放在选号**之后**: 别名是"这个上游叫它什么", 天然属于某个具体账号,
  // 而平台/账号的挑选仍由上面的路由表与推断决定。
  const aliased = applyAccountAlias(account, model);
  if (aliased !== model) {
    model = aliased;
    if (bodyObj && typeof bodyObj === 'object') {
      bodyObj['model'] = model;
      // outboundBody 在下面由 rawBody 派生, 这里同步更新即可
      rawBody = JSON.stringify(bodyObj);
    }
  }

  // base_url 兜底: 自定义平台没有内置默认域名, 缺失时直接报错而不是发出坏请求
  const effectiveBaseUrl = account.base_url?.trim() || defaultBaseUrl(account.platform);
  if (!effectiveBaseUrl) {
    await releaseAccount(env, account.id, requestId);
    return errorResponse(
      502,
      'api_error',
      `Upstream account "${account.name}" (platform "${account.platform}") requires a base_url. ` +
        `Custom platforms have no default domain — please set it in the admin panel.`,
    );
  }

  // ---- 协议转换 ----
  // 入站格式与上游协议不一致时(如 Anthropic 客户端 -> Gemini 上游),
  // 把请求体改写成上游认识的形状, 并同时记下响应该怎么转回来。
  const upstreamFormat = upstreamFormatFor(protocol, inboundFormat);
  const needTranslate = upstreamFormat !== inboundFormat;

  let outboundBody = rawBody;
  let explicitPath: string | null = null;

  if (needTranslate && method !== 'GET' && method !== 'HEAD') {
    const translated = translateRequest(inboundFormat, upstreamFormat, bodyObj, model);
    if (translated) {
      outboundBody = JSON.stringify(translated);
      // Gemini 的路径由 buildGeminiUrl 拼(带 :action), 不走 explicitPath
      explicitPath = upstreamFormat === 'gemini' ? null : upstreamPathFor(upstreamFormat, model);
    }
  }

  let upstreamUrl: string;
  try {
    upstreamUrl = buildUpstreamUrl(protocol, account, pathname, model, stream, explicitPath);
  } catch (e) {
    await releaseAccount(env, account.id, requestId);
    return errorResponse(502, 'api_error', (e as Error).message);
  }

  const headers = buildUpstreamHeaders(req.headers, protocol, account.type, credential);

  const upstreamReq = new Request(upstreamUrl, {
    method,
    headers,
    body: method === 'GET' || method === 'HEAD' ? undefined : outboundBody || undefined,
    redirect: 'manual',
  });

  // ---- 转发 ----
  let upstreamRes: Response;
  try {
    upstreamRes = await fetch(upstreamReq);
  } catch (e) {
    await releaseAccount(env, account.id, requestId);
    await logFailure(env, ctx, requestId, platform, 502, (e as Error).message, {
      requestedModel: requestedModel || model,
      stream,
      userAgent,
      ip: clientIp,
      path: pathname,
    });
    return errorResponse(502, 'api_error', `Upstream request failed: ${(e as Error).message}`);
  }

  // ---- 429 / 529 冷却标记 (对应上游 rate_limited_at / overload_until) ----
  if (upstreamRes.status === 429 || upstreamRes.status === 529) {
    await markAccountCooldown(env, account.id, upstreamRes.status);
  }

  // ---- 上游报错: 透传状态码, 不扣费 ----
  if (!upstreamRes.ok) {
    await releaseAccount(env, account.id, requestId);
    const errText = await upstreamRes.text().catch(() => '');
    await logFailure(env, ctx, requestId, platform, upstreamRes.status, errText, {
      requestedModel: requestedModel || model,
      stream,
      userAgent,
      ip: clientIp,
      path: pathname,
    });
    return new Response(errText || 'Upstream error', {
      status: upstreamRes.status,
      headers: passthroughResponseHeaders(upstreamRes.headers),
    });
  }

  // ---- 计费结算 ----
  // 价格来源只有两处: model_pricing 表 → 控制台的「默认单价」(两者并行查, 省一次往返)。
  // 分组/账号对价格的影响**只通过倍率**体现, 见下面的 combineRateMultiplier。
  const [dbPricing, defaultPrice] = await Promise.all([
    loadDbPricing(env),
    loadDefaultPrice(env),
  ]);
  const price = resolveModelPrice(model, dbPricing, defaultPrice);
  const rateMultiplier = combineRateMultiplier(
    ctx.groupRateMultiplier,
    account.rate_multiplier,
  );

  const settle = async (usage: typeof EMPTY_USAGE, firstTokenMs: number | null) => {
    const breakdown = computeTokenBreakdown(usage, price, rateMultiplier);
    try {
      await applyBilling(env, {
        ctx,
        account,
        platform,
        requestId,
        fingerprint: fingerprintRequest([requested, model, ctx.keyId, stream ? 1 : 0]),
        model,
        requestedModel: requested || model,
        usage,
        breakdown,
        stream,
        durationMs: Date.now() - startedAt,
        firstTokenMs,
        userAgent,
        ipAddress: clientIp,
      });
    } finally {
      await releaseAccount(env, account.id, requestId);
    }
  };

  // ---- 流式响应 ----
  const contentType = upstreamRes.headers.get('content-type') ?? '';
  const isSse = contentType.includes('text/event-stream');

  if (stream || isSse) {
    if (!upstreamRes.body) {
      await settle({ ...EMPTY_USAGE }, null);
      return new Response(null, {
        status: 200,
        headers: passthroughResponseHeaders(upstreamRes.headers),
      });
    }

    const { stream: outStream, usage, firstTokenMs } = needTranslate
      ? translateStreamingResponse(
          upstreamRes.body,
          platform,
          startedAt,
          // translator 为 null 时理论上不会走到这里(needTranslate 已保证 from!=to)
          createSseTranslator(upstreamFormat, inboundFormat, model) ?? { line: () => '' },
        )
      : wrapStreamingResponse(upstreamRes.body, platform, startedAt);

    // 后台结算: 流被客户端消费完后触发 (waitUntil 保证 Worker 不提前退出)
    const settlePromise = (async () => {
      const [u, ft] = await Promise.all([usage, firstTokenMs]);
      await settle(u, ft);
    })();

    // 在 Worker 上下文中延后执行, 不阻塞响应返回
    try {
      // @ts-expect-error executionCtx 由 index.ts 注入到 env 上
      env.__ctx?.waitUntil?.(settlePromise);
    } catch {
      void settlePromise;
    }

    return new Response(outStream, {
      status: upstreamRes.status,
      headers: sseResponseHeaders(upstreamRes.headers),
    });
  }

  // ---- 非流式响应 ----
  const respText = await upstreamRes.text();
  let usage = { ...EMPTY_USAGE };
  let parsed: unknown;
  try {
    parsed = JSON.parse(respText);
    usage = parseUsageFromJson(parsed, platform);
  } catch {
    // 无法解析 JSON 时不计量 token
  }

  await settle(usage, null);

  // 协议转换: 把上游形状改成客户端期望的形状 (usage 已按上游形状解析完毕)
  let outText = respText;
  if (needTranslate && parsed !== undefined) {
    const translated = translateResponse(upstreamFormat, inboundFormat, parsed, model);
    if (translated) outText = JSON.stringify(translated);
  }

  return new Response(outText, {
    status: upstreamRes.status,
    headers: passthroughResponseHeaders(upstreamRes.headers),
  });
}

/**
 * 白名单匹配 —— 精确优先, 其次大小写不敏感
 *
 * 与 lookupModelRoute 同样的理由: 客户端的大小写处理不可控。白名单是"允许
 * 哪些模型"的语义, 不是"允许哪些字节序列", 所以不该因为大小写把请求挡掉。
 */
function isModelAllowed(allowlist: string[], model: string): boolean {
  if (allowlist.includes(model)) return true;
  const want = model.toLowerCase();
  return allowlist.some((m) => m.toLowerCase() === want);
}

/**
 * 分组白名单校验 —— **别名也要能过**
 *
 * 客户端可能发的是**别名**(账号 `extra.model_aliases` 的键), 而白名单里写的
 * 是它对端的名字(别名的值)。两者是同一个模型的两种叫法, 不该被判成"不允许":
 *   别名 {"sensenova-glm-5.2":"glm-5.2"} + 白名单含 "glm-5.2"
 *   -> 发 sensenova-glm-5.2 应当放行, 并按 glm-5.2 转发给那个账号。
 *
 * 不做这层归一化的话, 别名配了却永远 403 "is not allowed for this group" ——
 * 表现为「模型别名设置了也用不了」。
 *
 * `aliasOutbound` 来自自动发现索引的命中(别名的值); 非别名命中传 null。
 *
 * **2026-09-21 起: 分组白名单停用**(见 GROUP_ALLOWLIST_ENABLED), 这里恒为 true。
 * 判定逻辑整段保留 —— 想恢复白名单时把常量改回 true 即可, 不需要重写。
 */
const GROUP_ALLOWLIST_ENABLED = false;

export function isModelAllowedWithAlias(
  allowlist: string[] | null | undefined,
  requested: string,
  aliasOutbound: string | null,
): boolean {
  // 白名单停用: 配了上游就能用, 模型名对不对由上游自己判定(见常量处的说明)
  if (!GROUP_ALLOWLIST_ENABLED) return true;
  if (!allowlist || allowlist.length === 0) return true;
  if (!requested) return true;
  if (isModelAllowed(allowlist, requested)) return true;
  // 别名归一化: 把"对端的名字"拿去比对白名单
  return !!aliasOutbound && isModelAllowed(allowlist, aliasOutbound);
}

/**
 * 加载「模型名 -> 平台」自动发现索引 (分组内全部可用账号)
 *
 * 只取 schedulable 的账号 —— 停用/冷却中的账号不该参与路由决策,
 * 否则会把请求引到一个永远不会被选中的平台。
 *
 * 失败时返回空索引, 调用方自然退回路径推断 —— **不能因为索引读不到就 503**。
 */
async function loadAutoDiscoverIndex(
  env: Env,
  groupId: number | null,
): Promise<Map<string, DiscoverHit>> {
  try {
    const res = groupId !== null
      ? await env.DB.prepare(
          `SELECT a.id, a.platform, a.model_index, a.extra FROM accounts a
           JOIN account_groups ag ON ag.account_id = a.id
           WHERE ag.group_id = ?1 AND a.deleted_at IS NULL AND a.status = 'active'`,
        ).bind(groupId).all<AccountRow>()
      : await env.DB.prepare(
          `SELECT id, platform, model_index, extra FROM accounts
           WHERE deleted_at IS NULL AND status = 'active'`,
        ).all<AccountRow>();
    return buildAutoDiscoverIndex(res.results ?? []);
  } catch {
    return new Map();
  }
}

/**
 * 列出当前分组下"实际有账号的平台"
 *
 * 只在报 503 no_upstream_account 时调用 —— 这条路径本来就是异常分支, 多一次
 * 查询不会影响正常请求。目的是让报错能自解释:
 * 用户看到 "platform zhipu 没账号" 时会困惑("我配了账号啊"), 补一句
 * "你实际配了的平台是 sensenova/sensenova" 就能立刻指向「模型→平台重定向」。
 */
async function listAvailablePlatforms(env: Env, groupId: number | null): Promise<string[]> {
  try {
    const res = groupId !== null
      ? await env.DB.prepare(
          `SELECT DISTINCT a.platform FROM accounts a
           JOIN account_groups ag ON ag.account_id = a.id
           WHERE ag.group_id = ?1 AND a.deleted_at IS NULL AND a.status = 'active'`,
        ).bind(groupId).all<{ platform: string }>()
      : await env.DB.prepare(
          `SELECT DISTINCT platform FROM accounts
           WHERE deleted_at IS NULL AND status = 'active'`,
        ).all<{ platform: string }>();
    return (res.results ?? [])
      .map((r) => String(r?.platform ?? '').trim())
      .filter(Boolean)
      .sort();
  } catch {
    return [];
  }
}

/** 标记账号冷却 —— 对应上游 rate_limited_at / overload_until */async function markAccountCooldown(env: Env, accountId: number, status: number): Promise<void> {
  try {
    const now = Date.now();
    if (status === 429) {
      const cooldown = new Date(now + 60_000).toISOString();
      await env.DB.prepare(
        `UPDATE accounts SET rate_limited_at = ?1, rate_limit_reset_at = ?2 WHERE id = ?3`,
      )
        .bind(new Date(now).toISOString(), cooldown, accountId)
        .run();
    } else {
      const until = new Date(now + 30_000).toISOString();
      await env.DB.prepare(`UPDATE accounts SET overload_until = ?1 WHERE id = ?2`)
        .bind(until, accountId)
        .run();
    }
  } catch {
    // 冷却标记失败不影响响应
  }
}

/** 透传上游响应头, 剔除 hop-by-hop */
function passthroughResponseHeaders(src: Headers): Headers {
  const out = new Headers();
  for (const [k, v] of src.entries()) {
    const lk = k.toLowerCase();
    if (['connection', 'keep-alive', 'transfer-encoding', 'content-encoding', 'content-length'].includes(lk)) {
      continue;
    }
    out.set(k, v);
  }
  return out;
}

/** SSE 专用响应头 —— 上游 gateway_upstream_response.go:715-718 */
function sseResponseHeaders(src: Headers): Headers {
  const out = passthroughResponseHeaders(src);
  out.set('content-type', 'text/event-stream');
  out.set('cache-control', 'no-cache');
  out.set('x-accel-buffering', 'no');
  return out;
}

/** 统一错误响应 (OpenAI 风格) */
export function errorResponse(
  status: number,
  type: string,
  message: string,
  code?: string,
  extraHeaders?: Record<string, string>,
): Response {
  return new Response(
    JSON.stringify({
      error: {
        message,
        type,
        code: code ?? null,
      },
    }),
    {
      status,
      headers: { 'content-type': 'application/json', ...(extraHeaders ?? {}) },
    },
  );
}
