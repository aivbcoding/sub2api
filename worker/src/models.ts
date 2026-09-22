/**
 * GET /v1/models —— 模型列表中转
 *
 * 对标 one-api / new-api / sub2api 等中转项目的「获取模型」能力。
 *
 * 与普通转发路径的区别:
 *   普通请求会按 protocol 把 /v1/chat/completions 改写成 /v1/responses 转发,
 *   但模型列表必须走各自原生端点 (openai/anthropic -> /v1/models, gemini -> /v1beta/models),
 *   而且要**聚合**多个上游账号的结果、按分组白名单过滤、统一成 OpenAI 响应格式,
 *   这样任何 OpenAI 兼容客户端 (Cherry Studio / NextChat / LobeChat / Cursor …)
 *   拿着这个 Key 就能自动拉出可用模型。
 *
 * 🔑 核心不变式 (2026-09-21 起明确): **列表 = 本分组当前绑定的全部账号声明的模型集**。
 *   任何"不看 account_groups 就从别处补模型"的路径都是 bug ——
 *   它会让用户改了账号绑定却看不到列表变化(见 buildLocalModelsForPlatforms)。
 *
 *   三个容易踩的反面(都已修, 见 tools/test-models-group-scope.mjs):
 *     ① 用 isSchedulable 过滤候选账号 —— 429 冷却只代表"暂时不接流量",
 *        不代表"不声明模型"; 冷却中的账号照样要贡献它的模型集。
 *     ② 只读 `model_index` 不看 `extra.model_aliases` 的键 —— 线上账号
 *        常只有别名表, 忽略它就会出现"绑了却拉不到"。
 *     ③ 用全局累计 `collected.size` 决定跳过上游 —— 会让后面的平台被前一个
 *        平台的命中连带跳过, 漏掉整个平台。改用本平台自己的 `indexHit`。
 *
 * 两种模式 (env.MODELS_LIST_MODE):
 *   auto   (默认) 有一手数据就聚合; 上游全挂时退回本地定价表/白名单
 *   local         完全离线: 只返回分组白名单 / 定价表里的模型, 不打上游
 *   upstream      强制透传第一个可用上游的原生响应 (不做聚合/统一)
 */

import {
  defaultBaseUrl,
  deriveModelsEndpoint,
  resolveProtocol,
  extractCredential,
  buildUpstreamHeaders,
} from './protocol';
import { errorResponse } from './gateway';
import type { AccountRow, AuthContext, Env } from './types';
import type { Platform } from './protocol';

/** OpenAI /v1/models 的单个模型对象 */
interface ModelObject {
  id: string;
  object: 'model';
  created: number;
  owned_by: string;
}

export async function handleModelsList(env: Env, ctx: AuthContext, req: Request): Promise<Response> {
  const mode = String(env['MODELS_LIST_MODE'] ?? 'auto').toLowerCase();

  // 用户级平台限制只有一个平台时, 只列这个平台
  const access = (ctx.userPlatformAccess ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  // 分组白名单优先 —— 它是最强的约束
  const allowlist = ctx.groupModelAllowlist ?? [];

  if (mode === 'local') {
    const local = await buildLocalModels(env, ctx, allowlist);
    if (local.length > 0) return jsonModels(local);
    return errorResponse(
      503,
      'api_error',
      'No model is configured for this API key. Set a group model allowlist or model pricing in the admin panel.',
      'no_model_configured',
    );
  }

  // ---- 确定要拉取哪些平台 ----
  //
  // 注意: resolveTargetPlatforms 只给出「默认应该列的平台」(openai/anthropic/gemini),
  // 但真正的可用平台取决于**账号表里实际存在哪些 platform**。像 deepseek / kimi 这类
  // 平台如果只按默认列表走, 会被整个漏掉 —— 客户端拉不到模型名, 就会报
  // "model may not exist", 即使转发链路其实完全正常。
  //
  // 所以这里把「默认平台」与「账号表里实际有的平台」做并集。
  const platforms = await resolveTargetPlatforms(env, ctx, access);

  // ---- 逐个平台聚合 ----
  const collected = new Set<string>();
  let passthrough: Response | null = null;

  // 上游拉不到列表的平台 (>0 表示该平台模型集为空, 需要靠本地定价表兜底)
  const platformsWithoutList: string[] = [];

  for (const platform of platforms) {
    // 候选账号取**本分组绑定的全部存活账号**(含 429 冷却中的) —— 这里是关键:
    //   · 429 冷却只代表"暂时不接流量", 不代表"这个账号不声明任何模型";
    //     账号在冷却期里它的模型照样是用户期望看到的(用户的原话:
    //     "key在所属分组，就应该能获取到当前分组下，所有上游账号的所有model集合")。
    //   · 旧实现用 loadCandidateAccounts(带 isSchedulable) 会把 429 冷却账号整个剔掉,
    //     于是 opencode 这种刚被 429 的账号, 它那 75 个模型会凭空消失。
    const accounts = await loadGroupAccounts(env, ctx.groupId, platform);
    if (accounts.length === 0) continue;

    // 索引 + 别名表键 —— 两边都是"该账号对外声明的模型名", 都要收。
    // 🚨 只读 model_index 是不够的: 线上账号普遍只有 extra.model_aliases,
    //    model_index 列是 NULL, 于是绑定改了列表却纹丝不动(2026-09-21 踩到)。
    let indexHit = 0;
    for (const account of accounts) {
      for (const id of accountDeclaredModels(account)) {
        collected.add(id);
        indexHit += 1;
      }
    }

    // 从索引拿到过就**不再打扰上游** —— 中转站大多限流, 每次拉列表都打一遍
    // 上游既慢又不划算。索引为空(或该平台根本没有索引)时才去实拉。
    if (mode !== 'upstream' && indexHit > 0) {
      continue;
    }

    // 用一个账号拉一次即可 (同平台模型集一致), 失败就换下一个
    let got = false;
    for (const account of accounts.slice(0, 3)) {
      try {
        const res = await fetchUpstreamModels(env, account, req);
        if (!res.ok) continue;

        if (mode === 'upstream' && !passthrough) {
          passthrough = res;
          got = true;
          break;
        }

        const ids = await extractModelIds(res, platform);
        for (const id of ids) collected.add(id);
        got = true;
        break;
      } catch {
        // 换下一个账号
      }
    }

    // 该平台所有账号都拉不到列表 (典型: 中转站未实现 GET /v1/models, 返回 400)。
    // 记下来, 后面用本分组账号的模型索引兜底补齐。
    if (!got) platformsWithoutList.push(platform);
  }

  // upstream 模式: 有原生响应就直接透传
  if (mode === 'upstream' && passthrough) {
    return passthrough;
  }

  // ---- 聚合为空: 退回本地 (定价表 + 白名单) ----
  if (collected.size === 0) {
    const local = await buildLocalModels(env, ctx, allowlist);
    if (local.length > 0) return jsonModels(local);
    return errorResponse(
      503,
      'api_error',
      platforms.length === 0
        ? 'No platform is available for this API key.'
        : `No upstream account could provide a model list for: ${platforms.join(', ')}.`,
      'no_available_account',
    );
  }

  // ---- 补漏: 有些平台的上游没有 GET /v1/models ----
  //
  // 最典型的例子是 chatapi.weixin.qq.com —— 它对 /v1/models 无论带不带 key
  // 都返回 400 "missing required parameter: model", 但它其实能正常跑对话。
  // 这类平台的模型不会出现在 collected 里, 客户端看不到模型名就会拒绝请求,
  // 表现成 "model may not exist", 而实际转发链路毫无问题。
  //
  // 兜底: 用本分组绑定的账号的 model_index 补齐 —— **只认本分组的账号**,
  // 否则改了账号绑定列表却不变(2026-09-21 修的缺陷, 见 buildLocalModelsForPlatforms)。
  if (platformsWithoutList.length > 0) {
    for (const id of await buildLocalModelsForPlatforms(env, platformsWithoutList, ctx.groupId)) {
      collected.add(id);
    }
  }

  // ---- 过滤 + 排序 ----
  let ids = [...collected];

  // 分组白名单是硬约束 —— 与 gateway.isModelAllowed 一样做大小写不敏感匹配,
  // 否则会出现"网关放行 GLM-5.2, 但列表里只列 glm-5.2"的割裂(客户端下拉里
  // 看到的是小写, 用户手输大写又能用, 很难理解)。
  if (allowlist.length > 0) {
    const allowed = new Set(allowlist.map((m) => m.toLowerCase()));
    ids = ids.filter((id) => allowed.has(id.toLowerCase()));
  }

  // 大小写去重: 多个上游对同一个模型大小写不一致时 (sensenova 用
  // `deepseek-v4-flash`, 定价表用 `Deepseek-v4-flash`), 列表里会出现
  // 两条只差大小写的记录, 客户端下拉框看着很脏。
  // 保留"上游原样"的名字 —— 即优先保留非定价表来源的那个。
  const seen = new Map<string, string>(); // lower -> 最终采用的名字
  for (const id of ids) {
    const k = id.toLowerCase();
    if (!seen.has(k)) seen.set(k, id);
  }
  ids = [...seen.values()];

  ids.sort((a, b) => a.localeCompare(b));

  const now = Math.floor(Date.now() / 1000);
  return jsonModels(
    ids.map((id) => ({ id, object: 'model' as const, created: now, owned_by: 'sub2api' })),
  );
}

/**
 * 决定列出哪些平台的模型
 *
 * 优先级: 用户级白名单 > 分组平台 > 全部启用的平台
 * 分组 platform 支持逗号分隔多平台, 与 inferPlatform 的约定保持一致。
 *
 * 当没有显式约束时, 返回「默认平台」∪「账号表里实际存在的平台」——
 * 后者保证自定义/非默认平台 (deepseek、kimi、第三方中转…) 也会被列出来。
 */
async function resolveTargetPlatforms(
  env: Env,
  ctx: AuthContext,
  access: string[],
): Promise<Platform[]> {
  if (access.length > 0) return access;

  const gp = (ctx.groupPlatform ?? '').trim();
  if (gp) {
    const list = gp.split(',').map((s) => s.trim()).filter(Boolean);
    if (list.length > 0) return list as Platform[];
  }

  const defaults: Platform[] = ['openai', 'anthropic', 'gemini'];

  // 账号表里实际出现过的平台 —— 这是"这台网关真正能服务哪些平台"的事实依据
  const present = new Set<string>();
  try {
    const res = await env.DB.prepare(
      `SELECT DISTINCT platform FROM accounts WHERE deleted_at IS NULL`,
    ).all<{ platform: string }>();
    for (const r of res.results ?? []) {
      const p = String(r?.platform ?? '').trim();
      if (p) present.add(p);
    }
  } catch {
    // 查不到就只按默认平台处理
  }

  const out = [...defaults];
  for (const p of present) {
    if (!out.includes(p as Platform)) out.push(p as Platform);
  }
  return out;
}

/** 向上游发起模型列表请求 */
async function fetchUpstreamModels(
  env: Env,
  account: AccountRow,
  req: Request,
): Promise<Response> {
  const base = account.base_url?.trim() || defaultBaseUrl(account.platform);
  if (!base) throw new Error(`account ${account.id} has no base_url`);

  const protocol = resolveProtocol(account.platform, account.protocol);
  const endpoint = deriveModelsEndpoint(protocol);
  const url = `${base.replace(/\/+$/, '')}${endpoint}`;

  let credentials: Record<string, unknown> = {};
  try {
    credentials = JSON.parse(account.credentials || '{}') as Record<string, unknown>;
  } catch {
    credentials = {};
  }
  const credential = extractCredential(credentials);
  if (!credential) throw new Error(`account ${account.id} has no credential`);

  // 复用 gateway 的鉴权头构造, 保证与真实转发路径完全一致
  const headers = buildUpstreamHeaders(req.headers, protocol, account.type, credential);

  return fetch(url, { method: 'GET', headers, redirect: 'manual' });
}

/**
 * 从上游响应里提取模型 id
 *
 * 兼容三种常见形状:
 *   OpenAI    { data: [ { id } ] }
 *   Gemini    { models: [ { name: "models/gemini-2.0-flash" } ] }
 *   部分中转  [ { id } ] 或 { models: ["gpt-4o"] }
 */
async function extractModelIds(res: Response, protocol: Platform): Promise<string[]> {
  let payload: unknown;
  try {
    payload = await res.json();
  } catch {
    return [];
  }

  const out: string[] = [];
  const push = (v: unknown) => {
    if (typeof v === 'string' && v.trim()) out.push(v.trim());
  };

  const obj = payload as Record<string, unknown> | null;
  const list = Array.isArray(payload)
    ? payload
    : Array.isArray(obj?.['data'])
      ? (obj!['data'] as unknown[])
      : Array.isArray(obj?.['models'])
        ? (obj!['models'] as unknown[])
        : [];

  for (const item of list) {
    if (typeof item === 'string') {
      push(item);
    } else if (item && typeof item === 'object') {
      const o = item as Record<string, unknown>;
      // Gemini 用 name= "models/xxx", 去掉前缀只留模型名
      const raw = o['id'] ?? o['name'] ?? o['model'];
      if (typeof raw === 'string') {
        push(raw.replace(/^models\//, ''));
      }
    }
  }

  // 少数上游把模型挂在顶层 map 的 key 上
  if (out.length === 0 && obj && protocol === 'openai') {
    for (const k of Object.keys(obj)) {
      if (/^(gpt|o[1-9]|claude|gemini|deepseek|grok|kimi|glm|qwen|text-|davinci)/i.test(k)) push(k);
    }
  }

  return out;
}

/**
 * 本地兜底: 分组白名单 + 分组定价表 (+ 有分组时的全局定价表)
 *
 * 用途: 上游拉不到模型时(凭证失效 / 网络不通 / 上游未实现该端点),
 * 至少把「这台网关承认的模型」告诉客户端, 而不是甩一个 503 让 GUI 报错。
 *
 * 🚨 全局定价表**只在挂过分组时**才并入 (2026-09-21 修):
 *   它是全库的模型定价表, 与"这个分组能服务哪些模型"毫无关系。
 *   以前无条件并入, 结果就是: 分组里一个账号都没有 / 账号全挂时,
 *   列表会退化成"定价表里配过的所有模型" —— 用户看到的正是这种陈旧数据。
 *   挂了分组时不并入的理由: 分组的账号索引已经是权威答案, 乱补只会再次
 *   出现"改了绑定列表不变"。
 */
async function buildLocalModels(
  env: Env,
  ctx: AuthContext,
  allowlist: string[],
): Promise<ModelObject[]> {
  const ids = new Set<string>(allowlist);

  // 分组定价表里配过的模型
  if (ctx.groupModelPricing) {
    for (const k of Object.keys(ctx.groupModelPricing)) ids.add(k);
  }

  // 全局定价表 —— 只在没有分组白名单/定价表可依据时兜底。
  // 挂了分组的情况下不并入: 那属于"绕过分组约束"。
  const hasGroupSignal = allowlist.length > 0 || Object.keys(ctx.groupModelPricing ?? {}).length > 0;
  if (!hasGroupSignal) {
    try {
      const res = await env.DB.prepare(`SELECT model FROM model_pricing`).all<{ model: string }>();
      for (const r of res.results ?? []) {
        if (r?.model) ids.add(String(r.model));
      }
    } catch {
      // 忽略: 纯兜底路径
    }
  }

  const now = Math.floor(Date.now() / 1000);
  return [...ids]
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b))
    .map((id) => ({ id, object: 'model' as const, created: now, owned_by: 'sub2api' }));
}

/**
 * 读账号对外声明的全部模型名 = `model_index` ∪ `extra.model_aliases` 的**键**
 *
 * 为什么两个都要读:
 *   · `model_index` 是后台「模型获取」从上游实拉回来的清单;
 *   · `model_aliases` 的**键**是管理员手动起的对外别名 (规范: `平台名-模型ID`)。
 * 两个字段是互补的, 线上常见"只有别名表、没有索引"的状态 ——
 * 只认其中一个就会出现"明明配了却拉不到"(2026-09-21 线上踩到)。
 */
function accountDeclaredModels(account: AccountRow): string[] {
  const out = readModelIndex(account);
  out.push(...readAliasKeys(account));
  return out;
}

/** 读 `extra.model_aliases` 的**键**(对外名); 值是对端认识的名字, 不算对外名 */
function readAliasKeys(account: AccountRow): string[] {
  const raw = account.extra;
  if (!raw) return [];
  let extra: unknown = raw;
  if (typeof raw === 'string') {
    const s = raw.trim();
    if (!s) return [];
    try {
      extra = JSON.parse(s);
    } catch {
      return [];
    }
  }
  if (!extra || typeof extra !== 'object' || Array.isArray(extra)) return [];
  const aliases = (extra as Record<string, unknown>)['model_aliases'];
  if (!aliases || typeof aliases !== 'object' || Array.isArray(aliases)) return [];
  const out: string[] = [];
  for (const k of Object.keys(aliases as Record<string, unknown>)) {
    const name = String(k ?? '').trim();
    if (name) out.push(name);
  }
  return out;
}

/**
 * 取**本分组绑定的全部存活账号**(不做 isSchedulable 过滤)
 *
 * 与 scheduler.queryAccounts 同一套连接条件, 唯一区别是不看冷却状态 ——
 * 模型列表要的是"这个分组声明了哪些模型", 而 429 冷却只是"暂时不接流量",
 * 两者不是一回事。账号一旦从分组解绑 / 被删 / 被停用, 它的模型立刻退出列表。
 */
async function loadGroupAccounts(
  env: Env,
  groupId: number | null,
  platform: Platform,
): Promise<AccountRow[]> {
  try {
    if (groupId !== null) {
      const res = await env.DB.prepare(
        `SELECT a.* FROM accounts a
           JOIN account_groups ag ON ag.account_id = a.id
          WHERE ag.group_id = ?1
            AND a.platform = ?2
            AND a.deleted_at IS NULL
            AND a.status = 'active'
          ORDER BY ag.priority ASC, a.priority ASC`,
      )
        .bind(groupId, platform)
        .all<AccountRow>();
      return res.results ?? [];
    }
    const res = await env.DB.prepare(
      `SELECT * FROM accounts
        WHERE platform = ?1 AND deleted_at IS NULL AND status = 'active'
        ORDER BY priority ASC, id ASC`,
    )
      .bind(platform)
      .all<AccountRow>();
    return res.results ?? [];
  } catch {
    return [];
  }
}

/**
 * 读取账号的模型索引 (accounts.model_index) —— 后台「模型获取」的落库结果
 *
 * 兼容 JSON 字符串 / 已解析数组; 坏数据一律当空, 不能让列表接口整体挂掉。
 */
function readModelIndex(account: AccountRow): string[] {
  const raw = account.model_index;
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
 * 兜底: 从**账号的模型索引 + 别名表**里补出该平台的模型列表
 *
 * 用途: 上游没有 GET /v1/models (如 chatapi.weixin.qq.com 返回 400) 时,
 * 让客户端至少能看到「这个平台能跑哪些模型名」。
 *
 * 🚨 **必须按分组过滤**(2026-09-21 修):
 *   旧实现只按 `platform` 全库捞账号, 完全无视 `account_groups` 绑定 ——
 *   于是「default 组」的 Key 能看到**根本没绑到这个组**的账号(甚至别的平台的)的模型。
 *   用户的症状是"上游账号绑定改了, 列表还是旧的", 根因就在这:
 *   他把某账号从 default 组解绑后, 该账号的 model_index 照样被并进来。
 *   现在只认**绑到本分组**(或分组为空时的全量, 见下)的账号。
 *
 * 为什么不再按模型名推断平台 (2026-09 变更):
 *   旧实现用 `glm->zhipu / kimi->kimi` 这类规则反推, 但接入中转上游后这个
 *   假设不成立 —— 中转上的 `glm-*` 由哪个平台服务是账号自己声明的事实,
 *   不是名字能猜的。现在只认账号的模型索引, 索引为空就诚实返回空
 *   (网关侧同样以索引为准, 两边行为一致)。
 *
 * @param groupId  分组 id; null 表示这把 Key 没有挂分组(继承不到任何绑定)
 */
async function buildLocalModelsForPlatforms(
  env: Env,
  platforms: string[],
  groupId: number | null,
): Promise<string[]> {
  if (platforms.length === 0) return [];

  // groupId 为 null 时: 该 Key 没挂分组, 与网关侧 `LEFT JOIN groups` 后
  // group_id=NULL 的语义一致 —— 它不继承任何分组绑定, 所以这里也**不给**
  // 任何账号维度的兜底(否则又是一个绕过分组约束的后门)。
  if (groupId === null) return [];

  const want = new Set(platforms.map((p) => p.toLowerCase()));
  const out: string[] = [];
  try {
    // 只取**绑到本分组**的账号 —— 与 scheduler.queryAccounts 同一套连接条件,
    // 保证"列表里能看到的"与"实际能被调度到的"是同一批账号。
    const res = await env.DB.prepare(
      `SELECT a.platform, a.model_index, a.extra
         FROM accounts a
         JOIN account_groups ag ON ag.account_id = a.id
        WHERE ag.group_id = ?1
          AND a.deleted_at IS NULL
          AND a.status = 'active'`,
    )
      .bind(groupId)
      .all<AccountRow>();
    for (const a of res.results ?? []) {
      const p = String(a.platform ?? '').trim();
      if (!p || !want.has(p.toLowerCase())) continue;
      // 索引 + 别名表键, 共用 accountDeclaredModels 的唯一口径
      for (const m of accountDeclaredModels(a)) out.push(m);
    }
  } catch {
    // 读不到就放弃兜底
  }
  return out;
}

/**
 * 按 OpenAI 规范输出
 *
 * 🚨 刻意**不设** Cache-Control 的 max-age (2026-09-21):
 *   这个列表直接反映"本分组当前绑定了哪些上游账号", 是随时会变的配置。
 *   以前发了 `public, max-age=60`, 客户端(以及中间层)会在 60 秒内一直用
 *   旧结果 —— 用户改完账号绑定, 列表还要等一分钟才变, 看起来就是"没实时更新"。
 *   这里改成 no-store: 列表本身很轻(一次 D1 查询), 且上游索引已落库,
 *   实时性远比省这几十毫秒重要。
 */
function jsonModels(models: ModelObject[]): Response {
  return new Response(JSON.stringify({ object: 'list', data: models }), {
    status: 200,
    headers: {
      // 客户端 SDK 常会跟着缓存, 显式禁掉
      'cache-control': 'no-store',
      'content-type': 'application/json; charset=utf-8',
    },
  });
}
