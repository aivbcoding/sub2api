/**
 * 管理后台 API
 * 对应上游 backend/internal/server/routes/admin.go
 *
 * 上游有 34 个路由分组、约 416 处路由。这里移植**网关运营必需**的核心模块:
 *   /dashboard  总览统计
 *   /users      用户管理
 *   /groups     分组管理
 *   /api-keys   API Key 管理
 *   /accounts   上游账号管理
 *   /usage      用量日志
 *   /audit      审计日志
 *   /settings   系统设置
 *
 * 未移植(非必需): 支付/兑换码/公告/代理/渠道监控/合规风控/插件/备份/订阅等
 */

import { auditLog, hashPassword, parseMenus, type AdminAuthResult } from './admin-auth';
import type { AccountRow, AuthContext, Env } from './types';
import { isTurnstileConfigured, verifyTurnstile, verifyCode } from './verify-code';
import {
  BUILTIN_PLATFORMS,
  DEFAULT_BASE_URLS,
  defaultBaseUrl,
  defaultProtocolFor,
  extractCredential,
  isBuiltinPlatform,
  isValidPlatformName,
  normalizePlatformName,
  PROTOCOL_BASE_URL_HINTS,
  resolveProtocol,
  UPSTREAM_PROTOCOLS,
  type UpstreamProtocol,
} from './protocol';
import { ENTRY_SEGMENT_BLOCKLIST, errorResponse } from './gateway';
import { DEFAULT_PRICE, DEFAULT_PRICE_SETTING, parseDefaultPrice } from './billing';

/** 微美元 -> 数值 */
const fromMicro = (v: unknown): number => Number(v ?? 0) / 1e8;

/**
 * 入口路径 —— 填了之后客户端请求 `/<entry_path>/v1/chat/completions` 就直接打到这条上游,
 * **不再用模型名判平台**。选填, 空 = 不启用入口路由(仍走原来的自动发现)。
 */
const ENTRY_PATH_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;

const normalizeEntryPath = (v: unknown): string => String(v ?? '').trim().toLowerCase();

/** 入口路径的合法性; 返回 null 表示可用, 否则返回给前端的报错文案 */
function entryPathError(p: string): string | null {
  if (!ENTRY_PATH_RE.test(p)) {
    return 'entry_path must be 1-32 chars: lowercase letters/digits/underscore/hyphen, starting with a letter or digit';
  }
  // 与内建协议路径撞名(v1 / models / chat ...)会让客户端的那类请求整段失效 —— 必须拦住
  if (ENTRY_SEGMENT_BLOCKLIST.has(p)) {
    return `entry_path "${p}" is reserved — it collides with a built-in API path`;
  }
  return null;
}

/** 入口路径唯一性检查(唯一索引是最后一道防线, 这里是为了给出可读的报错) */
async function findEntryPathConflict(
  env: Env,
  entryPath: string,
  selfId: number | null,
): Promise<number | null> {
  const row = selfId === null
    ? await env.DB.prepare(
        `SELECT id FROM accounts WHERE entry_path = ?1 AND deleted_at IS NULL LIMIT 1`,
      ).bind(entryPath).first<{ id: number }>()
    : await env.DB.prepare(
        `SELECT id FROM accounts WHERE entry_path = ?1 AND deleted_at IS NULL AND id <> ?2 LIMIT 1`,
      ).bind(entryPath, selfId).first<{ id: number }>();
  return row ? Number(row.id) : null;
}
/** 数值 -> 微美元 */
const toMicro = (v: unknown): number => Math.round(Number(v ?? 0) * 1e8);

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

function badRequest(message: string): Response {
  return json({ error: { message, type: 'invalid_request_error' } }, 400);
}

function notFound(message = 'Not found'): Response {
  return json({ error: { message, type: 'not_found' } }, 404);
}

/**
 * 读一个整数查询参数并夹到 [min, max]。
 *
 * 为什么要专门封一层: 分页参数会直接拼进 LIMIT/OFFSET, 而
 * `Number('abc')` 是 NaN —— `Math.min(Math.max(NaN, 1), 200)` 还是 NaN,
 * 绑给 D1 就成了 "LIMIT NaN", 直接 500。所以非法值一律退回默认值,
 * 而不是"尽量解析"。
 */
function intParam(url: URL, key: string, def: number, min: number, max: number): number {
  const raw = url.searchParams.get(key);
  const n = raw === null || raw.trim() === '' ? def : Number(raw);
  if (!Number.isFinite(n)) return def;
  return Math.min(Math.max(Math.floor(n), min), max);
}

// ============================================================
// 菜单权限
// ============================================================

/**
 * 菜单清单 —— 唯一权威来源。
 *
 * ⚠️ 这里的 key 必须与前端侧栏 `data-page="xxx"` 完全一致
 * (admin-ui.ts 的 PAGE_TITLES 也是同一份键)。两处对不上会出现
 * 「角色勾了这个菜单, 但侧栏没有对应按钮」或反过来的灵异现象,
 * 所以 tools/test-roles-guard.mjs 会静态比对两边的键集。
 */
export const MENU_CATALOG: { key: string; label: string }[] = [
  // ---- 我的(所有登录用户) ----
  { key: 'overview', label: '概览' },
  { key: 'mykeys', label: 'API秘钥' },
  { key: 'logs', label: '使用日志' },
  { key: 'profile', label: '个人资料' },
  // ---- 管理(通常只给管理员/运营) ----
  { key: 'dashboard', label: '总览' },
  { key: 'board', label: '数据看板' },
  { key: 'keys', label: 'API Key' },
  { key: 'accounts', label: '上游账号' },
  { key: 'groups', label: '分组' },
  { key: 'users', label: '用户' },
  { key: 'models', label: '模型管理' },
  { key: 'usage', label: '请求日志' },
  { key: 'audit', label: '操作审计' },
  { key: 'announce', label: '公告管理' },
  { key: 'roles', label: '角色权限' },
  { key: 'settings', label: '设置' },
];

/** 菜单键 -> 显示名, 用于 403 文案 */
const MENU_LABELS: Record<string, string> = Object.fromEntries(
  MENU_CATALOG.map((m) => [m.key, m.label]),
);

/**
 * API 资源 -> 菜单键。**权限闸门就挂在这张表上。**
 *
 * 规则: 每个 /api/admin/<resource> 都必须在这里登记; 没登记的资源一律 404 ——
 * fail-closed。这样"新加了一个接口但忘了挂权限"的后果是打不开, 而不是对所有人敞开。
 *
 * 注意 `models` 页面本身没有独立接口(它复用 accounts / models 的数据),
 * 所以后端只能按 accounts / models 拦; 前端菜单隐藏负责"看不看得见那一页"。
 * (2026-09-24: 独立「模型别名」菜单已并入「模型定价」页的「别名」标签, aliases 菜单键摘除。)
 * 🚨 「模型定价」页的**上游拉取**要读 `/accounts` —— 只给了 `models` 没给 `accounts`
 * 的角色能手动新增定价, 但拉不了上游列表(前端会给出这句提示, 不是白屏)。
 * `my` 资源是例外 —— 它属于"任何登录用户访问自己", 不挂菜单闸门, 见 handleAdminApi。
 */
export const MENUS_BY_RESOURCE: Record<string, string> = {
  dashboard: 'dashboard',
  board: 'board',
  overview: 'overview',
  profile: 'profile',
  logs: 'logs',
  users: 'users',
  groups: 'groups',
  'api-keys': 'keys',
  accounts: 'accounts',
  usage: 'usage',
  audit: 'audit',
  settings: 'settings',
  models: 'models',
  // /sticky/clear 是账号调度粘滞位的清理入口, 归属「上游账号」
  sticky: 'accounts',
  roles: 'roles',
  announcements: 'announce',
};

/** 当前身份是否有某个菜单 —— `['*']` 通配全部 */
function canAccessMenu(auth: AdminAuthResult, menu: string): boolean {
  const a = auth.admin;
  if (!a) return false;
  return a.menus.includes('*') || a.menus.includes(menu);
}

/** 权限不足的统一响应 */
function forbidden(menu: string): Response {
  const label = MENU_LABELS[menu] ?? menu;
  return json(
    { error: { message: `当前角色没有「${label}」权限, 请联系管理员在「角色权限」页调整。`, type: 'forbidden' } },
    403,
  );
}

// ============================================================
// 路由分发
// ============================================================

export async function handleAdminApi(
  req: Request,
  env: Env,
  pathname: string,
  auth: AdminAuthResult,
): Promise<Response> {
  const method = req.method.toUpperCase();
  const rest = pathname.replace(/^\/api\/admin/, '') || '/';
  const parts = rest.split('/').filter(Boolean);
  const resource = parts[0] ?? '';
  const id = parts[1] ? Number(parts[1]) : null;

  let body: Record<string, unknown> = {};
  // 🚨 DELETE 也要读体: 「请求日志 / 操作审计 / 模型定价」的批量删除都是
  //    `DELETE { ids: [...] }` / `{ models: [...] }` —— 把 id 放查询串会撞 URL 长度上限
  //    (一次能勾选 500 条), 所以走请求体。早先这里漏了 DELETE, 表现是删除接口
  //    永远报 "ids is required"(拿到的是空对象), 而 GET 一切正常, 很难一眼看出来。
  if (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') {
    // 有些动作(如 /sticky/clear)不需要请求体, 空体不视为错误
    const raw = await req.text();
    if (raw.trim()) {
      try {
        body = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        return badRequest('Request body must be valid JSON.');
      }
    }
  }

  // ---- 「我的」资源: 任何登录用户都能访问自己, 不进菜单闸门 ----
  // 它天然是自限的(所有查询都硬绑 auth.admin.id, 不接受 user_id 参数),
  // 所以"有没有 mykeys 菜单"只影响侧栏看不看得见, 不影响能不能调。
  if (resource === 'my') {
    try {
      return await handleMy(env, method, body, auth, req, parts);
    } catch (e) {
      return json({ error: { message: (e as Error).message, type: 'server_error' } }, 500);
    }
  }

  // ---- 已发布公告: 任何**登录用户**都能读, 不进菜单闸门 ----
  // 「公告管理」菜单管的是**增删改**; 读公告是每个用户的基本权利 ——
  // 否则业务用户(角色 user 无 announce 菜单)在顶栏点「公告」就会 403,
  // 而"登录后自动弹公告"这件事本身也对所有人成立。
  //
  // 🚨 只拦**精确的** `GET /announcements`(恰好一段路径 + GET):
  //    - POST /announcements           -> 落到下面的「公告管理」菜单闸门
  //    - GET  /announcements/all       -> 管理员列表(含草稿), 也走闸门
  //    - PUT|DELETE /announcements/<id> -> parts.length === 2, 同样走闸门
  // 早先写成"只要 parts.length===1 就只放 GET", 把 POST 新建一起 405 掉了;
  // 改对之后又发现管理员的"列表"是同一条 GET, 于是**永远只看到已发布**、
  // 草稿在管理页凭空消失 —— 所以列表单独开在 /announcements/all 上。
  if (resource === 'announcements' && parts.length === 1 && method === 'GET') {
    try {
      return await getLiveAnnouncements(env);
    } catch (e) {
      return json({ error: { message: (e as Error).message, type: 'server_error' } }, 500);
    }
  }

  // ---- 菜单权限闸门 ----
  // 前端藏菜单只是"看不见"; 真正的边界在这里: 拿不到菜单键就 403,
  // 于是手敲 fetch 也越不过去。未登记的资源直接 404(见 MENUS_BY_RESOURCE 注释)。
  const needMenu = MENUS_BY_RESOURCE[resource];
  if (!needMenu) return notFound(`Unknown admin resource: ${resource}`);
  if (!canAccessMenu(auth, needMenu)) return forbidden(needMenu);

  try {
    switch (resource) {
      case 'dashboard':
        return await getDashboard(env);
      case 'board':
        return await getBoard(env, auth);
      case 'overview':
        return await getOverview(env, auth);
      case 'profile':
        return await getProfile(env, auth, req);
      case 'logs':
        return await getSelfLogs(env, auth, req);
      case 'users':
        return await handleUsers(env, method, id, body, auth, req, parts);
      case 'groups':
        return await handleGroups(env, method, id, body, auth, req, parts);
      case 'api-keys':
        return await handleApiKeys(env, method, id, body, auth, req);
      case 'accounts':
        return await handleAccounts(env, method, id, body, auth, req, parts);
      case 'usage':
        return await getUsage(env, method, body, req, auth);
      case 'audit':
        return await getAudit(env, method, body, req, auth);
      case 'announcements':
        return await handleAnnouncements(env, method, id, body, auth, req, parts);
      case 'settings':
        return await handleSettings(env, method, body, auth, req);
      case 'models':
        return await handleModelPricing(env, method, body, auth, req);
      case 'roles':
        return await handleRoles(env, method, id, body, auth, req);
      case 'sticky':
        return await handleSticky(env, method, parts, auth, req);
      default:
        return notFound(`Unknown admin resource: ${resource}`);
    }
  } catch (e) {
    return json({ error: { message: (e as Error).message, type: 'server_error' } }, 500);
  }
}

// ============================================================
// 仪表盘
// ============================================================

async function getDashboard(env: Env): Promise<Response> {
  const [counts, today, models, trend] = await Promise.all([
    env.DB.prepare(
      `SELECT
         (SELECT COUNT(*) FROM users WHERE deleted_at IS NULL)            AS users,
         (SELECT COUNT(*) FROM api_keys WHERE deleted_at IS NULL)         AS api_keys,
         (SELECT COUNT(*) FROM api_keys WHERE deleted_at IS NULL AND status='active') AS api_keys_active,
         (SELECT COUNT(*) FROM accounts WHERE deleted_at IS NULL)         AS accounts,
         (SELECT COUNT(*) FROM accounts WHERE deleted_at IS NULL AND status='active' AND schedulable=1) AS accounts_active,
         (SELECT COUNT(*) FROM groups WHERE deleted_at IS NULL)           AS groups,
         (SELECT COALESCE(SUM(balance),0) FROM users WHERE deleted_at IS NULL) AS total_balance`,
    ).first<Record<string, number>>(),

    env.DB.prepare(
      `SELECT
         COUNT(*)                          AS requests,
         COALESCE(SUM(input_tokens),0)     AS input_tokens,
         COALESCE(SUM(output_tokens),0)    AS output_tokens,
         COALESCE(SUM(actual_cost),0)      AS cost,
         COALESCE(SUM(CASE WHEN stream=1 THEN 1 ELSE 0 END),0) AS stream_requests
       FROM usage_logs
       WHERE created_at >= datetime('now','-1 day')`,
    ).first<Record<string, number>>(),

    env.DB.prepare(
      `SELECT model,
              COUNT(*) AS requests,
              COALESCE(SUM(input_tokens),0)  AS input_tokens,
              COALESCE(SUM(output_tokens),0) AS output_tokens,
              COALESCE(SUM(actual_cost),0)   AS cost
       FROM usage_logs
       WHERE created_at >= datetime('now','-7 days')
       GROUP BY model
       ORDER BY cost DESC
       LIMIT 15`,
    ).all<Record<string, unknown>>(),

    env.DB.prepare(
      `SELECT date(created_at) AS day,
              COUNT(*) AS requests,
              COALESCE(SUM(actual_cost),0) AS cost
       FROM usage_logs
       WHERE created_at >= datetime('now','-14 days')
       GROUP BY day
       ORDER BY day ASC`,
    ).all<Record<string, unknown>>(),
  ]);

  // 账号状态分布
  const acctByPlatform = await env.DB.prepare(
    `SELECT platform,
            COUNT(*) AS total,
            SUM(CASE WHEN status='active' AND schedulable=1 THEN 1 ELSE 0 END) AS available
     FROM accounts WHERE deleted_at IS NULL
     GROUP BY platform ORDER BY total DESC`,
  ).all<Record<string, unknown>>();

  return json({
    counts: {
      users: counts?.users ?? 0,
      api_keys: counts?.api_keys ?? 0,
      api_keys_active: counts?.api_keys_active ?? 0,
      accounts: counts?.accounts ?? 0,
      accounts_active: counts?.accounts_active ?? 0,
      groups: counts?.groups ?? 0,
      total_balance: fromMicro(counts?.total_balance),
    },
    today: {
      requests: today?.requests ?? 0,
      stream_requests: today?.stream_requests ?? 0,
      input_tokens: today?.input_tokens ?? 0,
      output_tokens: today?.output_tokens ?? 0,
      cost: fromMicro(today?.cost),
    },
    models: (models.results ?? []).map((m) => ({
      model: m.model,
      requests: m.requests,
      input_tokens: m.input_tokens,
      output_tokens: m.output_tokens,
      cost: fromMicro(m.cost),
    })),
    trend: (trend.results ?? []).map((t) => ({
      day: t.day,
      requests: t.requests,
      cost: fromMicro(t.cost),
    })),
    accounts_by_platform: acctByPlatform.results ?? [],
  });
}

// ============================================================
// 概览 / 数据看板 / 个人资料 / 使用日志  (面向登录用户)
// ============================================================
//
// 这四个页面与「总览(dashboard)」的区别:
//   dashboard = 全站运营数据, 只有管理员该看
//   这一组   = **每个登录用户都能进**, 但非管理员一律只看自己那份
//
// 🚨 隔离方式与 getUsage 完全一致: **用户 id 从会话取, 不接受任何请求参数**。
// 若哪天给某个业务角色放开了 board/logs 菜单, 它们也不会因此看到别人的数据 ——
// 因为"看谁"这件事根本不由请求方决定。

/**
 * 北京时间「今天」的日期串 (YYYY-MM-DD)。
 *
 * 为什么要自己算: 签到判重、近 24h 统计都要求"天"的边界落在北京零点,
 * 而 Worker 的运行时区是 UTC。直接用 `datetime('now')` 会差 8 小时 ——
 * 北京时间凌晨签到的记录会被算进前一天, 于是"今天能再签一次"。
 */
function bjDayString(d: Date = new Date()): string {
  const ms = d.getTime() + 8 * 3600 * 1000;
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * GET /api/admin/overview —— 「概览」页。
 *
 * 四块: 额度信息(余额/额度窗口) / 公告 / 用量概览(近 24h 消耗) / 历史使用(按天)。
 * 请求计数一并给出(总请求、近 24h、近 7 天、失败数)。
 */
async function getOverview(env: Env, auth: AdminAuthResult): Promise<Response> {
  const me = auth.admin;
  if (!me) return json({ error: { message: 'Unauthorized' } }, 401);
  const isAdmin = me.is_admin;

  // 非管理员只看自己; 管理员看全站。用 `1=1`/`user_id=?` 两种 where 拼同一批查询。
  const scopeUser = isAdmin ? null : me.id;
  const whereUser = scopeUser === null ? '' : 'WHERE l.user_id = ?1';

  const [counts, day24, byDay, announce, meRow] = await Promise.all([
    env.DB.prepare(
      `SELECT
         COUNT(*) AS total_requests,
         COALESCE(SUM(CASE WHEN l.model LIKE 'error:%' THEN 1 ELSE 0 END), 0) AS error_requests,
         COALESCE(SUM(l.input_tokens + l.output_tokens), 0) AS total_tokens,
         COALESCE(SUM(l.actual_cost), 0) AS total_cost
       FROM usage_logs l ${whereUser}`,
    )
      .bind(...(scopeUser === null ? [] : [scopeUser]))
      .first<Record<string, number>>(),

    // 近 24 小时(滚动窗口, 不是"今天") —— 用 created_at 归一化后比较
    env.DB.prepare(
      `SELECT
         COUNT(*) AS requests,
         COALESCE(SUM(CASE WHEN l.model LIKE 'error:%' THEN 1 ELSE 0 END), 0) AS errors,
         COALESCE(SUM(l.input_tokens), 0)  AS input_tokens,
         COALESCE(SUM(l.output_tokens), 0) AS output_tokens,
         COALESCE(SUM(l.actual_cost), 0)   AS cost,
         COALESCE(SUM(CASE WHEN l.stream = 1 THEN 1 ELSE 0 END), 0) AS stream_requests
       FROM usage_logs l
       WHERE ${scopeUser === null ? '1=1' : 'l.user_id = ?1'}
         AND replace(substr(l.created_at, 1, 19), 'T', ' ') >= datetime('now', '-1 day')`,
    )
      .bind(...(scopeUser === null ? [] : [scopeUser]))
      .first<Record<string, number>>(),

    // 历史使用: 最近 30 天, 按**北京时区**的日期聚合
    env.DB.prepare(
      `SELECT date(replace(substr(l.created_at, 1, 19), 'T', ' '), '+8 hours') AS day,
              COUNT(*) AS requests,
              COALESCE(SUM(l.input_tokens + l.output_tokens), 0) AS tokens,
              COALESCE(SUM(l.actual_cost), 0) AS cost
       FROM usage_logs l
       WHERE ${scopeUser === null ? '1=1' : 'l.user_id = ?1'}
         AND replace(substr(l.created_at, 1, 19), 'T', ' ') >= datetime('now', '-30 days')
       GROUP BY day ORDER BY day DESC LIMIT 30`,
    )
      .bind(...(scopeUser === null ? [] : [scopeUser]))
      .all<Record<string, unknown>>(),

    // 公告: 存在 settings 表, 管理员在「设置」页维护。读不到就当没有公告(不报错)。
    env.DB.prepare(`SELECT value FROM settings WHERE key = 'announcement'`)
      .first<{ value: string }>()
      .catch(() => null),

    // 自己的余额/额度 —— 管理员也照常展示自己的, 不做特殊化
    env.DB.prepare(
      `SELECT id, username, email, balance, frozen_balance, status FROM users
        WHERE id = ?1 AND deleted_at IS NULL`,
    )
      .bind(me.id)
      .first<Record<string, unknown>>(),
  ]);

  return json({
    scope: isAdmin ? 'all' : 'self',
    me: {
      id: me.id,
      name: me.name,
      role: me.role,
      role_name: me.role_name,
      balance: fromMicro(meRow?.balance),
      frozen_balance: fromMicro(meRow?.frozen_balance),
    },
    counts: {
      total_requests: counts?.total_requests ?? 0,
      error_requests: counts?.error_requests ?? 0,
      total_tokens: counts?.total_tokens ?? 0,
      total_cost: fromMicro(counts?.total_cost),
    },
    last24h: {
      requests: day24?.requests ?? 0,
      errors: day24?.errors ?? 0,
      input_tokens: day24?.input_tokens ?? 0,
      output_tokens: day24?.output_tokens ?? 0,
      stream_requests: day24?.stream_requests ?? 0,
      cost: fromMicro(day24?.cost),
    },
    // 倒序拿到, 前端按时间正序画柱子
    history: (byDay.results ?? [])
      .map((r) => ({
        day: r.day,
        requests: r.requests,
        tokens: r.tokens,
        cost: fromMicro(r.cost),
      }))
      .reverse(),
    announcement: String(announce?.value ?? ''),
  });
}

/**
 * GET /api/admin/board —— 「数据看板」。
 *
 * 模型调用分析 / token 总数 / 消耗分布(按模型、按平台、按天)。
 * 非管理员强制只看自己 —— 这个菜单默认**只给 admin**(见 schema-roles.sql),
 * 但万一被授予自定义角色, 也不能因此泄露全站数据。
 */
async function getBoard(env: Env, auth: AdminAuthResult): Promise<Response> {
  const me = auth.admin;
  if (!me) return json({ error: { message: 'Unauthorized' } }, 401);
  const selfScoped = !me.is_admin;
  const whereUser = selfScoped ? 'WHERE l.user_id = ?1' : 'WHERE 1=1';
  const binds: unknown[] = selfScoped ? [me.id] : [];

  const [totals, byModel, byPlatform, byDay, topKeys] = await Promise.all([
    env.DB.prepare(
      `SELECT
         COUNT(*) AS requests,
         COALESCE(SUM(CASE WHEN l.model LIKE 'error:%' THEN 1 ELSE 0 END), 0) AS errors,
         COALESCE(SUM(l.input_tokens), 0)  AS input_tokens,
         COALESCE(SUM(l.output_tokens), 0) AS output_tokens,
         COALESCE(SUM(l.cache_read_tokens), 0) AS cache_read_tokens,
         COALESCE(SUM(l.actual_cost), 0)   AS cost,
         COALESCE(AVG(CASE WHEN l.model NOT LIKE 'error:%' THEN l.duration_ms END), 0) AS avg_duration_ms
       FROM usage_logs l ${whereUser}`,
    )
      .bind(...binds)
      .first<Record<string, number>>(),

    // 模型调用分析: 按模型聚合(取非错误的 model 名)
    env.DB.prepare(
      `SELECT l.model,
              COUNT(*) AS requests,
              COALESCE(SUM(l.input_tokens), 0)  AS input_tokens,
              COALESCE(SUM(l.output_tokens), 0) AS output_tokens,
              COALESCE(SUM(l.actual_cost), 0)   AS cost
       FROM usage_logs l ${whereUser}
         ${selfScoped ? 'AND' : 'AND'} l.model NOT LIKE 'error:%' AND l.model <> ''
       GROUP BY l.model ORDER BY requests DESC LIMIT 20`,
    )
      .bind(...binds)
      .all<Record<string, unknown>>(),

    // 消耗分布: 按上游平台
    env.DB.prepare(
      `SELECT COALESCE(a.platform, '(未知)') AS platform,
              COUNT(*) AS requests,
              COALESCE(SUM(l.actual_cost), 0) AS cost
       FROM usage_logs l
       LEFT JOIN accounts a ON a.id = l.account_id
       ${whereUser}
       GROUP BY platform ORDER BY cost DESC LIMIT 20`,
    )
      .bind(...binds)
      .all<Record<string, unknown>>(),

    // 消耗分布: 按天(北京时间), 近 14 天
    env.DB.prepare(
      `SELECT date(replace(substr(l.created_at, 1, 19), 'T', ' '), '+8 hours') AS day,
              COUNT(*) AS requests,
              COALESCE(SUM(l.actual_cost), 0) AS cost
       FROM usage_logs l
       ${whereUser}
         AND replace(substr(l.created_at, 1, 19), 'T', ' ') >= datetime('now', '-14 days')
       GROUP BY day ORDER BY day ASC`,
    )
      .bind(...binds)
      .all<Record<string, unknown>>(),

    // 消耗分布: 按 Key(只对管理员有意义 —— 业务用户只有自己的 Key)
    env.DB.prepare(
      `SELECT COALESCE(k.name, '(未命名)') AS key_name,
              l.api_key_id AS key_id,
              COUNT(*) AS requests,
              COALESCE(SUM(l.actual_cost), 0) AS cost
       FROM usage_logs l
       LEFT JOIN api_keys k ON k.id = l.api_key_id
       ${whereUser}
       GROUP BY l.api_key_id ORDER BY cost DESC LIMIT 10`,
    )
      .bind(...binds)
      .all<Record<string, unknown>>(),
  ]);

  const inp = Number(totals?.input_tokens ?? 0);
  const out = Number(totals?.output_tokens ?? 0);

  return json({
    scope: selfScoped ? 'self' : 'all',
    totals: {
      requests: totals?.requests ?? 0,
      errors: totals?.errors ?? 0,
      input_tokens: inp,
      output_tokens: out,
      total_tokens: inp + out,
      cache_read_tokens: totals?.cache_read_tokens ?? 0,
      cost: fromMicro(totals?.cost),
      avg_duration_ms: Math.round(Number(totals?.avg_duration_ms ?? 0)),
    },
    by_model: (byModel.results ?? []).map((m) => ({
      model: m.model,
      requests: m.requests,
      input_tokens: m.input_tokens,
      output_tokens: m.output_tokens,
      cost: fromMicro(m.cost),
    })),
    by_platform: (byPlatform.results ?? []).map((p) => ({
      platform: p.platform,
      requests: p.requests,
      cost: fromMicro(p.cost),
    })),
    by_day: (byDay.results ?? []).map((d) => ({
      day: d.day,
      requests: d.requests,
      cost: fromMicro(d.cost),
    })),
    by_key: (topKeys.results ?? []).map((k) => ({
      key_id: k.key_id,
      key_name: k.key_name,
      requests: k.requests,
      cost: fromMicro(k.cost),
    })),
  });
}

/** 连续签到天数(含今天) —— 从最近一次往前数, 断一天就停 */
function checkinStreak(days: string[], today: string): number {
  const set = new Set(days);
  if (!set.has(today)) return 0;
  let streak = 0;
  const cursor = new Date(today + 'T00:00:00Z');
  for (;;) {
    const d = cursor.toISOString().slice(0, 10);
    if (!set.has(d)) break;
    streak += 1;
    cursor.setUTCDate(cursor.getUTCDate() - 1);
  }
  return streak;
}

/**
 * GET  /api/admin/profile —— 「个人资料」页(资料 + 钱包 + 签到状态)
 * POST /api/admin/profile/checkin —— 每日签到
 *
 * 两者都**硬绑当前会话的用户 id**, 不接受任何 id 参数 —— 否则就是一个
 * "改别人余额"的接口。
 */
async function getProfile(env: Env, auth: AdminAuthResult, req: Request): Promise<Response> {
  const me = auth.admin;
  if (!me) return json({ error: { message: 'Unauthorized' } }, 401);

  const rest = new URL(req.url).pathname.replace(/^\/api\/admin\/profile/, '').replace(/^\//, '');
  if (rest === 'checkin' && req.method.toUpperCase() === 'POST') {
    return doCheckin(env, auth, req);
  }
  if (req.method.toUpperCase() !== 'GET') return badRequest('Unsupported method');

  const today = bjDayString();

  const [userRow, wallet, days, groups] = await Promise.all([
    env.DB.prepare(
      `SELECT id, username, email, role, status, balance, frozen_balance,
              concurrency, rpm_limit, notes, created_at, last_login_at
         FROM users WHERE id = ?1 AND deleted_at IS NULL`,
    )
      .bind(me.id)
      .first<Record<string, unknown>>(),

    // 钱包: 余额 + 累计用量 + 累计请求数
    env.DB.prepare(
      `SELECT COUNT(*) AS requests,
              COALESCE(SUM(l.input_tokens + l.output_tokens), 0) AS tokens,
              COALESCE(SUM(l.actual_cost), 0) AS cost
         FROM usage_logs l WHERE l.user_id = ?1`,
    )
      .bind(me.id)
      .first<Record<string, number>>(),

    // 签到记录(最近 60 天就够算连续天数)
    env.DB.prepare(
      `SELECT day, amount FROM user_checkins
        WHERE user_id = ?1 ORDER BY day DESC LIMIT 60`,
    )
      .bind(me.id)
      .all<Record<string, unknown>>()
      .catch(() => ({ results: [] as Record<string, unknown>[] })),

    // 所属分组(通过名下 Key 反查 —— 用户本身没有 group_id 列)
    env.DB.prepare(
      `SELECT DISTINCT g.id, g.name
         FROM api_keys k JOIN groups g ON g.id = k.group_id
        WHERE k.user_id = ?1 AND k.deleted_at IS NULL
        ORDER BY g.id ASC LIMIT 20`,
    )
      .bind(me.id)
      .all<Record<string, unknown>>(),
  ]);

  const dayList = (days.results ?? []).map((r) => String(r.day));
  const checkedToday = dayList.includes(today);

  return json({
    user: {
      id: me.id,
      username: String(userRow?.username ?? ''),
      email: String(userRow?.email ?? ''),
      role: me.role,
      role_name: me.role_name,
      status: String(userRow?.status ?? ''),
      concurrency: Number(userRow?.concurrency ?? 0),
      rpm_limit: Number(userRow?.rpm_limit ?? 0),
      notes: String(userRow?.notes ?? ''),
      created_at: userRow?.created_at ?? null,
      last_login_at: userRow?.last_login_at ?? null,
    },
    groups: (groups.results ?? []).map((g) => ({ id: g.id, name: g.name })),
    wallet: {
      balance: fromMicro(userRow?.balance),
      frozen_balance: fromMicro(userRow?.frozen_balance),
      total_tokens: wallet?.tokens ?? 0,
      total_requests: wallet?.requests ?? 0,
      total_cost: fromMicro(wallet?.cost),
    },
    checkin: {
      // 签到开关由 settings 控制, 默认开(与注册开关同一套 settingOn 语义)
      enabled: await checkinEnabled(env),
      checked_today: checkedToday,
      streak: checkinStreak(dayList, today),
      today: today,
      recent: (days.results ?? []).slice(0, 14).map((r) => ({
        day: r.day,
        amount: fromMicro(r.amount),
      })),
    },
  });
}

/** settings 里 key 缺失 = 默认开; 只有显式 'false' 才算关(与注册开关同一套语义) */
async function checkinEnabled(env: Env): Promise<boolean> {
  try {
    const r = await env.DB.prepare(`SELECT value FROM settings WHERE key = 'checkin_enabled'`)
      .first<{ value: string }>();
    return String(r?.value ?? 'true') !== 'false';
  } catch {
    return true;
  }
}

/**
 * 签到金额区间(**美元**) —— 100~200 之间随机整数。
 *
 * 🚨 单位坑 (2026-09-21 修): 旧实现把这个数字**直接**当成微美元写进
 * `users.balance`(= 加 100~200 微美元 = $0.000001 ~ $0.000002)。
 * 前端 `fmtMoney` 是 `toFixed(4)`, 于是界面上永远显示 `$0.0000` ——
 * 用户看到的就是"签到新增的金额是 0"。
 *
 * 正确语义: 用户说的"加 100~200"是**余额数字加 100~200**(100~200 美元)。
 * 落库前统一转成微美元: `× 1e8`。
 */
const CHECKIN_MIN = 100;
const CHECKIN_MAX = 200;

/**
 * 每日签到: 加余额 100~200 随机整数(美元)。
 *
 * 判重靠 `user_checkins(user_id, day)` 的主键 —— **不是**先查后写:
 * "查一次再插一次"在并发下两个人(或同一人两连点)会同时通过检查。
 * 这里直接 INSERT ... ON CONFLICT DO NOTHING, 靠 changes 判断是不是首次。
 */
async function doCheckin(env: Env, auth: AdminAuthResult, req: Request): Promise<Response> {
  const me = auth.admin;
  if (!me) return json({ error: { message: 'Unauthorized' } }, 401);

  if (!(await checkinEnabled(env))) {
    return json({ error: { message: '签到功能已关闭, 请联系管理员。', type: 'forbidden' } }, 403);
  }

  const today = bjDayString();
  // 先抽美元整数, 再一次性转微美元 —— 保证"界面上看到的数字"就是抽到的那个整数
  const amountUsd = CHECKIN_MIN + Math.floor(Math.random() * (CHECKIN_MAX - CHECKIN_MIN + 1));
  const amount = toMicro(amountUsd);

  let inserted = false;
  try {
    const res = await env.DB.prepare(
      `INSERT INTO user_checkins (user_id, day, amount, created_at)
       VALUES (?1, ?2, ?3, ?4)
       ON CONFLICT(user_id, day) DO NOTHING`,
    )
      .bind(me.id, today, amount, new Date().toISOString())
      .run();
    inserted = Number(res.meta?.changes ?? 0) > 0;
  } catch (e) {
    // 表不存在(迁移没跑) -> 明确报错而不是默默失败, 否则用户以为签到成功了
    return json(
      { error: { message: '签到表尚未初始化, 请联系管理员执行 user_checkins 迁移。', type: 'server_error' } },
      500,
    );
  }

  if (!inserted) {
    return json(
      { error: { message: '今天已经签到过了, 明天再来。', type: 'conflict' } },
      409,
    );
  }

  await env.DB.prepare(
    `UPDATE users SET balance = balance + ?1, updated_at = ?2 WHERE id = ?3`,
  )
    .bind(amount, new Date().toISOString(), me.id)
    .run();

  // 审计明细写**美元**而不是微美元 —— 这条是给人看的, `+19100000000` 读不出来
  await auditLog(env, auth.admin, 'checkin', 'user', me.id, `+$${amountUsd} (${today})`, req);

  const row = await env.DB.prepare(`SELECT balance FROM users WHERE id = ?1`)
    .bind(me.id)
    .first<{ balance: number }>();

  const allDays = await env.DB.prepare(
    `SELECT day FROM user_checkins WHERE user_id = ?1 ORDER BY day DESC LIMIT 60`,
  )
    .bind(me.id)
    .all<{ day: string }>()
    .catch(() => ({ results: [] as { day: string }[] }));

  return json({
    ok: true,
    amount: fromMicro(amount),
    day: today,
    balance: fromMicro(row?.balance),
    streak: checkinStreak((allDays.results ?? []).map((r) => String(r.day)), today),
  });
}

/**
 * GET /api/admin/logs —— 「使用日志」页: **只看自己的**调用记录。
 *
 * 与 /my/usage 是同一份数据, 但这里带分页与更全的列(详情弹窗要用)。
 * 刻意做成独立接口而不是复用 /my/usage: 后者是「API秘钥」页在用的轻量版本,
 * 字段/分页语义都不一样, 混在一起以后改一边就会踩另一边。
 */
async function getSelfLogs(env: Env, auth: AdminAuthResult, req: Request): Promise<Response> {
  const me = auth.admin;
  if (!me) return json({ error: { message: 'Unauthorized' } }, 401);

  const url = new URL(req.url);
  const limit = intParam(url, 'limit', 50, 1, 200);
  const offset = intParam(url, 'offset', 0, 0, Number.MAX_SAFE_INTEGER);
  const model = (url.searchParams.get('model') ?? '').trim();
  const status = (url.searchParams.get('status') ?? '').trim();

  const where: string[] = ['l.user_id = ?1'];
  const binds: unknown[] = [me.id];
  if (model) {
    binds.push(model);
    where.push(`l.model = ?${binds.length}`);
  }
  if (status === 'error') where.push(`l.model LIKE 'error:%'`);
  else if (status === 'success') where.push(`l.model NOT LIKE 'error:%'`);
  const whereSql = `WHERE ${where.join(' AND ')}`;

  // 🚨 面向业务用户: **不下发上游信息** —— 上游账号名/平台、User-Agent、上游模型名都是
  // 网关内部细节, 用户既用不上也会困惑(想知道落点账号请去看管理员侧的「请求日志」)。
  // 所以这里既不 SELECT 也不 JOIN accounts。
  const fromSql = `FROM usage_logs l
       LEFT JOIN api_keys k ON k.id = l.api_key_id`;

  const limitPh = `?${binds.length + 1}`;
  const offsetPh = `?${binds.length + 2}`;

  const [rows, total, agg, models] = await Promise.all([
    env.DB.prepare(
      `SELECT l.id, l.request_id, l.created_at, l.requested_model, l.model,
              l.input_tokens, l.output_tokens, l.cache_read_tokens, l.cache_creation_tokens,
              l.total_cost, l.actual_cost, l.duration_ms, l.first_token_ms,
              l.stream, l.ip_address,
              k.name AS key_name, k.id AS key_id, k.key AS key_value
       ${fromSql} ${whereSql}
       ORDER BY l.id DESC LIMIT ${limitPh} OFFSET ${offsetPh}`,
    )
      .bind(...binds, limit, offset)
      .all<Record<string, unknown>>(),

    env.DB.prepare(`SELECT COUNT(*) AS c ${fromSql} ${whereSql}`)
      .bind(...binds)
      .first<{ c: number }>(),

    env.DB.prepare(
      `SELECT
         COUNT(*) AS requests,
         COALESCE(SUM(CASE WHEN l.model LIKE 'error:%' THEN 1 ELSE 0 END), 0) AS errors,
         COALESCE(SUM(l.input_tokens + l.output_tokens), 0) AS tokens,
         COALESCE(SUM(l.actual_cost), 0) AS cost
       ${fromSql} ${whereSql}`,
    )
      .bind(...binds)
      .first<Record<string, number>>(),

    // 筛选下拉的模型候选(自己的历史模型, 与当前筛选无关)
    env.DB.prepare(
      `SELECT model, COUNT(*) AS c FROM usage_logs
        WHERE user_id = ?1 AND model NOT LIKE 'error:%' AND model <> ''
        GROUP BY model ORDER BY c DESC LIMIT 200`,
    )
      .bind(me.id)
      .all<Record<string, unknown>>(),
  ]);

  return json({
    logs: (rows.results ?? []).map((r) => ({
      id: r.id,
      request_id: r.request_id,
      created_at: r.created_at,
      requested_model: r.requested_model,
      model: r.model,
      input_tokens: r.input_tokens,
      output_tokens: r.output_tokens,
      cache_read_tokens: r.cache_read_tokens,
      cache_creation_tokens: r.cache_creation_tokens,
      cost: fromMicro(r.actual_cost ?? r.total_cost),
      duration_ms: r.duration_ms,
      first_token_ms: r.first_token_ms,
      stream: Number(r.stream ?? 0) === 1,
      ip_address: r.ip_address ?? '',
      key_id: r.key_id,
      key_name: r.key_name ?? '',
      key_value: maskKey(String(r.key_value ?? '')),
      error: String(r.model ?? '').startsWith('error:'),
    })),
    total: total?.c ?? 0,
    limit,
    offset,
    summary: {
      requests: agg?.requests ?? 0,
      errors: agg?.errors ?? 0,
      tokens: agg?.tokens ?? 0,
      cost: fromMicro(agg?.cost),
    },
    models: (models.results ?? []).map((m) => ({ model: m.model, count: m.c })),
  });
}

/**
 * Key 打码 —— 列表里**不要**下发完整明文 Key。
 *
 * 上游是明文存储(见 schema.sql 注释), 所以这里必须自己收口: 只留前缀 + 后 4 位,
 * 中间固定成 8 个星号。用户真要拿 key 明文请到「API秘钥」页复制,
 * 那是有意为之的一次显式操作。
 */
function maskKey(k: string): string {
  if (!k) return '';
  if (k.length <= 12) return k.slice(0, 4) + '****';
  return k.slice(0, 8) + '********' + k.slice(-4);
}

// ============================================================
// 用户管理
// ============================================================

/**
 * 新建用户时写入的默认密码。
 *
 * 背景: `users.password_hash` 一直是个空列 —— 后台建的用户没有任何密码。
 * 现在新建就写入这个默认密码的 PBKDF2 哈希(格式与后台管理员账号完全一致,
 * 见 admin-auth.ts::hashPassword), 管理员在弹窗里可以改成别的;
 * 终端用户自助登录端点**目前还没做**, 先把哈希落库, 以后加登录时不用回头补数据。
 *
 * ⚠️ 只改这一处即可换默认密码 —— 前端不硬编码, 通过 GET /users 的
 * `default_password` 字段拿到并显示在弹窗提示里(ADMIN_HTML 是纯模板字面量,
 * 里面塞不了 ${} 插值, 所以走接口而不是前端常量)。
 */
const DEFAULT_USER_PASSWORD = 'sub2api123';

/** 密码长度下限, 与「设置」页改管理员密码的规则保持一致 */
const MIN_PASSWORD_LENGTH = 8;

async function handleUsers(
  env: Env,
  method: string,
  id: number | null,
  body: Record<string, unknown>,
  auth: AdminAuthResult,
  req: Request,
  parts: string[],
): Promise<Response> {
  if (method === 'GET') {
    if (id !== null && Number.isInteger(id)) {
      const row = await env.DB.prepare(
        `SELECT * FROM users WHERE id = ?1 AND deleted_at IS NULL`,
      )
        .bind(id)
        .first<Record<string, unknown>>();
      if (!row) return notFound('User not found');
      return json({ user: serializeUser(row) });
    }
    const rows = await env.DB.prepare(
      `SELECT u.*,
              (SELECT COUNT(*) FROM api_keys k WHERE k.user_id=u.id AND k.deleted_at IS NULL) AS key_count
       FROM users u WHERE u.deleted_at IS NULL
       ORDER BY u.id DESC LIMIT 500`,
    ).all<Record<string, unknown>>();

    // 角色下拉的候选项 —— 随列表一起回传, 省一次请求; 也让"能选哪些角色"
    // 完全由 roles 表决定(自定义角色新建后立刻可选, 前端不写死 user/admin)
    const roleRows = await env.DB.prepare(
      `SELECT code, name FROM roles ORDER BY builtin DESC, id ASC`,
    ).all<{ code: string; name: string }>();

    return json({
      users: (rows.results ?? []).map(serializeUser),
      roles: (roleRows.results ?? []).map((r) => ({ code: r.code, name: r.name })),
      // 给后台弹窗显示用, 避免前端硬编码一份(两处不一致就会"提示的和实际的不一样")
      default_password: DEFAULT_USER_PASSWORD,
    });
  }

  if (method === 'POST') {
    // 子动作 /users/<action>: 这种路径下 parts[1] 不是数字(id = NaN)
    const action = Number.isNaN(Number(parts[1] ?? '')) ? String(parts[1] ?? '') : '';

    // 给所有「没有密码」的存量用户补默认密码(新建的已有, 主要是历史数据)。
    // 都是同一个默认密码, 所以复用同一个加盐哈希 —— 逐行跑 PBKDF2(10万次)在
    // Worker 的 CPU 预算里很不划算, 而且同密码同哈希不泄露额外信息。
    if (action === 'reset-missing-passwords') {
      const pending = await env.DB.prepare(
        `SELECT COUNT(*) AS c FROM users
         WHERE deleted_at IS NULL AND (password_hash IS NULL OR password_hash = '')`,
      ).first<{ c: number }>();
      const count = Number(pending?.c ?? 0);
      if (count > 0) {
        const hash = await hashPassword(DEFAULT_USER_PASSWORD);
        await env.DB.prepare(
          `UPDATE users SET password_hash = ?1, updated_at = ?2
           WHERE deleted_at IS NULL AND (password_hash IS NULL OR password_hash = '')`,
        )
          .bind(hash, new Date().toISOString())
          .run();
      }
      await auditLog(
        env,
        auth.admin,
        'update',
        'user_password',
        'missing',
        `补默认密码 count=${count}`,
        req,
      );
      return json({ ok: true, updated: count });
    }

    const email = String(body.email ?? '').trim();
    if (!email) return badRequest('email is required');

    // 与 PUT 同理: 建号时也不能自己指定角色, 除非是超管
    const wantRole = String(body.role ?? 'user').trim() || 'user';
    if (wantRole !== 'user' && !auth.admin?.is_admin) {
      return json(
        { error: { message: '只有超级管理员可以指定用户角色。', type: 'forbidden' } },
        403,
      );
    }

    const pwd = String(body.password ?? '').trim();
    if (pwd && pwd.length < MIN_PASSWORD_LENGTH) {
      return badRequest(`password must be at least ${MIN_PASSWORD_LENGTH} characters`);
    }
    // 留空 = 用默认密码(不是"没密码")
    const passwordHash = await hashPassword(pwd || DEFAULT_USER_PASSWORD);

    const res = await env.DB.prepare(
      `INSERT INTO users (email, password_hash, role, balance, concurrency, rpm_limit, status, username, notes, platform_access)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`,
    )
      .bind(
        email,
        passwordHash,
        wantRole,
        toMicro(body.balance ?? 0),
        Number(body.concurrency ?? 5),
        Number(body.rpm_limit ?? 0),
        String(body.status ?? 'active'),
        String(body.username ?? ''),
        String(body.notes ?? ''),
        String(body.platform_access ?? ''),
      )
      .run();

    const newId = res.meta?.last_row_id ?? 0;
    // 审计里**永远不记密码**: 只记"用了默认密码还是管理员指定的"
    await auditLog(
      env,
      auth.admin,
      'create',
      'user',
      newId,
      `email=${email} password=${pwd ? 'custom' : 'default'}`,
      req,
    );
    return json({ ok: true, id: newId, used_default_password: !pwd }, 201);
  }

  if (method === 'PUT' && id !== null) {
    // 角色是"能不能进后台"的总闸门, 只允许超管改 —— 否则一个拿到 users 菜单的
    // 自定义角色就能把自己(或别人)提成 admin, 菜单权限体系会当场失效。
    if (body.role !== undefined && !auth.admin?.is_admin) {
      return json(
        { error: { message: '只有超级管理员可以修改用户角色。', type: 'forbidden' } },
        403,
      );
    }

    const fields: string[] = [];
    const binds: unknown[] = [];

    const map: Record<string, (v: unknown) => unknown> = {
      email: (v) => String(v),
      role: (v) => String(v),
      status: (v) => String(v),
      username: (v) => String(v),
      notes: (v) => String(v),
      concurrency: (v) => Number(v),
      rpm_limit: (v) => Number(v),
      balance: (v) => toMicro(v),
      frozen_balance: (v) => toMicro(v),
      platform_access: (v) =>
        Array.isArray(v) ? v.join(',') : String(v ?? ''),
    };

    for (const [key, conv] of Object.entries(map)) {
      if (body[key] !== undefined) {
        fields.push(`${key} = ?${binds.length + 1}`);
        binds.push(conv(body[key]));
      }
    }

    // 密码单独处理: 要现算哈希, 而且**留空 = 不改**(不是清空)。
    // 绝不接受客户端直接传 password_hash —— 那等于允许写任意哈希。
    let pwdChanged = false;
    if (body.password !== undefined) {
      const pwd = String(body.password ?? '').trim();
      if (pwd) {
        if (pwd.length < MIN_PASSWORD_LENGTH) {
          return badRequest(`password must be at least ${MIN_PASSWORD_LENGTH} characters`);
        }
        fields.push(`password_hash = ?${binds.length + 1}`);
        binds.push(await hashPassword(pwd));
        pwdChanged = true;
      }
    }

    if (fields.length === 0) {
      return badRequest('No updatable fields provided');
    }

    fields.push(`updated_at = ?${binds.length + 1}`);
    binds.push(new Date().toISOString());
    binds.push(id);

    await env.DB.prepare(
      `UPDATE users SET ${fields.join(', ')} WHERE id = ?${binds.length}`,
    )
      .bind(...binds)
      .run();

    // 审计: 把密码字段换成标记, 免得明文进日志
    const auditBody: Record<string, unknown> = { ...body };
    if (auditBody.password !== undefined) auditBody.password = pwdChanged ? '***' : '(空, 未改)';
    await auditLog(env, auth.admin, 'update', 'user', id, JSON.stringify(auditBody).slice(0, 500), req);
    return json({ ok: true, password_changed: pwdChanged });
  }

  if (method === 'DELETE' && id !== null) {
    return await deleteUserCascade(env, id, auth, req);
  }

  return badRequest('Unsupported method');
}

/**
 * 物理删除用户 + 级联清理所有关联数据。
 *
 * 为什么是「物理删」而不是沿用软删除: 用户明确要求"删除用户时把 TA 创建的
 * API Key 和使用日志一起删掉"。软删除(置 deleted_at)会留下:
 *   - usage_logs 里的计费记录(user_id/api_key_id 仍指向已删用户, 统计里还在)
 *   - api_keys 里的 key(客户端拿 key 一调又会 401/404, 徒增困惑)
 * 而 key 一删, usage_logs.api_key_id 就成了孤儿 —— 所以必须连同
 * usage_logs / usage_billing_dedup / user_checkins / 邮箱验证码 一起清。
 *
 * 删除范围(与前端确认框文案一致, 改这里必改 delUser):
 *   - api_keys            (该用户的全部 Key, 物理删)
 *   - usage_logs          (该用户的全部使用日志)
 *   - usage_billing_dedup (该用户 Key 的计费幂等记录)
 *   - user_checkins       (签到记录)
 *   - email_verify_codes  (该邮箱的验证码)
 *   - email_verify_send_logs (该邮箱的验证码发送日志)
 *
 * 🚨 审计日志(admin_audit_logs)不删 —— 审计的意义就在于"删过什么、谁删的"
 *    要留痕, 级联删除审计会自己消灭自己。
 *
 * 🚨 追加安全: 管理员不能物理删除自己。误删自己=把自己锁在门外,
 *    而且本请求的执行上下文(会话 token 对应的用户)会变成不存在, 后续必挂。
 */
async function deleteUserCascade(
  env: Env,
  id: number,
  auth: AdminAuthResult,
  req: Request,
): Promise<Response> {
  if (auth.admin?.id === id) {
    return json(
      { error: { message: '不能删除当前登录的账号。如需注销, 请联系另一名超级管理员操作。', type: 'forbidden' } },
      400,
    );
  }

  // 先取用户信息(邮箱 + 属于他的 key 列表) —— 删除前必须拿到,
  // 否则删完之后 email / key_id 就无从查起了。
  const user = await env.DB.prepare(
    `SELECT id, email, username FROM users WHERE id = ?1 AND deleted_at IS NULL`,
  )
    .bind(id)
    .first<{ id: number; email: string; username: string }>();

  const email = String(user?.email ?? '');
  // 不存在 / 已软删(到这一步的入口本来就只查非软删, 但保持一致)
  if (!user) return notFound('User not found');

  const keys = await env.DB.prepare(`SELECT id FROM api_keys WHERE user_id = ?1`)
    .bind(id)
    .all<{ id: number }>();
  const keyIds = (keys.results ?? []).map((k) => k.id);

  const nowIso = new Date().toISOString();
  const statements: D1PreparedStatement[] = [];

  // ---- 1. 该用户的 API Key(物理删) ----
  statements.push(
    env.DB.prepare(`DELETE FROM api_keys WHERE user_id = ?1`).bind(id),
  );

  // ---- 2. 使用日志(user_id 维度, 覆盖所有 key 的请求) ----
  statements.push(
    env.DB.prepare(`DELETE FROM usage_logs WHERE user_id = ?1`).bind(id),
  );

  // ---- 3. 计费幂等(按 key 维度; 若上面 api_keys 删了, 这里显式按 key_id 清) ----
  if (keyIds.length > 0) {
    // 逐条删比 IN(...) 好拼; D1 batch 里不好做动态占位, 拆成多段插入
    for (const kid of keyIds) {
      statements.push(
        env.DB.prepare(`DELETE FROM usage_billing_dedup WHERE api_key_id = ?1`).bind(kid),
      );
    }
  }

  // ---- 4. 签到记录 ----
  statements.push(
    env.DB.prepare(`DELETE FROM user_checkins WHERE user_id = ?1`).bind(id),
  );

  // ---- 5. 邮箱验证码 + 发送日志(按该用户邮箱; 发送日志按 request_id 反查, 不需要算 hash) ----
  statements.push(
    env.DB.prepare(`DELETE FROM email_verify_codes WHERE email_normalized = ?1`).bind(email.toLowerCase()),
  );
  statements.push(
    env.DB.prepare(
      `DELETE FROM email_verify_send_logs
        WHERE request_id IN (SELECT request_id FROM email_verify_codes WHERE email_normalized = ?1)`,
    ).bind(email.toLowerCase()),
  );

  // ---- 6. 最后删用户本体(物理删) ----
  statements.push(
    env.DB.prepare(`DELETE FROM users WHERE id = ?1 AND deleted_at IS NULL`).bind(id),
  );

  await env.DB.batch(statements);

  // 审计: 记被删用户邮箱 + 连带删除的 key 数量(方便事后对账)
  await auditLog(
    env,
    auth.admin,
    'delete',
    'user',
    id,
    `email=${email} keys=${keyIds.length} cascade=1`,
    req,
  );
  return json({ ok: true, deleted_keys: keyIds.length });
}

function serializeUser(row: Record<string, unknown>) {
  return {
    id: row.id,
    email: row.email,
    role: row.role,
    balance: fromMicro(row.balance),
    frozen_balance: fromMicro(row.frozen_balance),
    concurrency: row.concurrency,
    rpm_limit: row.rpm_limit,
    status: row.status,
    username: row.username,
    notes: row.notes,
    // 允许访问的上游平台; 空 = 不限制
    platform_access: row.platform_access ?? '',
    key_count: row.key_count ?? 0,
    // 只回传"有没有密码", 绝不回传哈希本身
    has_password: String(row.password_hash ?? '').length > 0,
    last_login_at: row.last_login_at,
    created_at: row.created_at,
  };
}

// ============================================================
// 角色 ↔ 菜单权限
// ============================================================

/** 角色代码: 小写字母/数字/下划线/连字符, 首字符必须是字母或数字 */
const ROLE_CODE_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;

/** 把前端传来的菜单数组收敛成合法集合(过滤未知键 + 去重), 顺序按 catalog */
function normalizeMenus(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const wanted = new Set(v.map((x) => String(x ?? '').trim()).filter(Boolean));
  // '*' 是通配, 单独留着; 其余按 catalog 顺序输出, 保证同一组勾选总是存成同一个字符串
  const out: string[] = wanted.has('*') ? ['*'] : [];
  for (const m of MENU_CATALOG) if (wanted.has(m.key)) out.push(m.key);
  return out;
}

function serializeRole(row: Record<string, unknown>) {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    menus: parseMenus(row.menus),
    builtin: Number(row.builtin ?? 0) === 1,
    description: row.description ?? '',
    user_count: Number(row.user_count ?? 0),
    created_at: row.created_at,
  };
}

/**
 * 角色管理 (roles 表 CRUD)。
 *
 * 三条硬规则:
 *   1. `admin` 角色不可改权限、不可删 —— 否则管理员能把自己锁在门外;
 *   2. 内置角色(builtin=1)不可删; 非内置角色若仍有用户在用也不可删(改角色比删干净);
 *   3. `code` 一旦创建不可改 —— `users.role` 存的是 code, 改 code 等于悄悄改变
 *      所有存量用户的权限, 想要新代码请新建角色再迁移用户。
 */
async function handleRoles(
  env: Env,
  method: string,
  id: number | null,
  body: Record<string, unknown>,
  auth: AdminAuthResult,
  req: Request,
): Promise<Response> {
  if (method === 'GET') {
    const rows = await env.DB.prepare(
      `SELECT r.*,
              (SELECT COUNT(*) FROM users u
                WHERE u.deleted_at IS NULL AND u.role = r.code) AS user_count
         FROM roles r
        ORDER BY r.builtin DESC, r.id ASC`,
    ).all<Record<string, unknown>>();

    return json({
      roles: (rows.results ?? []).map(serializeRole),
      // 菜单清单由后端下发, 前端不再自己维护一份(两处不一致就会出现
      // "勾了却看不到"这种查半天的问题)。-- 已加 tools/test-roles-guard.mjs 静态比对
      menu_catalog: MENU_CATALOG,
    });
  }

  if (method === 'POST') {
    const code = String(body.code ?? '').trim().toLowerCase();
    if (!ROLE_CODE_RE.test(code)) {
      return badRequest(
        '角色代码只能用小写字母/数字/下划线/连字符, 1-32 位, 且首字符必须是字母或数字',
      );
    }
    const dup = await env.DB.prepare(`SELECT id FROM roles WHERE code = ?1`)
      .bind(code)
      .first<{ id: number }>();
    if (dup) return badRequest(`角色代码 ${code} 已存在`);

    const name = String(body.name ?? '').trim() || code;
    const menus = normalizeMenus(body.menus);

    const res = await env.DB.prepare(
      `INSERT INTO roles (code, name, menus, builtin, description)
       VALUES (?1, ?2, ?3, 0, ?4)`,
    )
      .bind(code, name, JSON.stringify(menus), String(body.description ?? ''))
      .run();

    const newId = res.meta?.last_row_id ?? 0;
    await auditLog(
      env,
      auth.admin,
      'create',
      'role',
      newId,
      `code=${code} menus=${menus.join(',') || '(空)'}`,
      req,
    );
    return json({ ok: true, id: newId }, 201);
  }

  if (method === 'PUT' && id !== null && Number.isInteger(id)) {
    const row = await env.DB.prepare(`SELECT * FROM roles WHERE id = ?1`)
      .bind(id)
      .first<Record<string, unknown>>();
    if (!row) return notFound('Role not found');

    const code = String(row.code);
    if (code === 'admin') {
      return badRequest('内置「超级管理员」角色的权限不可修改 —— 改坏了会把管理员自己锁在门外。');
    }

    const fields: string[] = [];
    const binds: unknown[] = [];
    if (body.name !== undefined) {
      fields.push(`name = ?${binds.length + 1}`);
      binds.push(String(body.name).trim() || code);
    }
    if (body.menus !== undefined) {
      fields.push(`menus = ?${binds.length + 1}`);
      binds.push(JSON.stringify(normalizeMenus(body.menus)));
    }
    if (body.description !== undefined) {
      fields.push(`description = ?${binds.length + 1}`);
      binds.push(String(body.description));
    }
    if (fields.length === 0) return badRequest('No updatable fields provided');

    fields.push(`updated_at = ?${binds.length + 1}`);
    binds.push(new Date().toISOString());
    binds.push(id);

    await env.DB.prepare(`UPDATE roles SET ${fields.join(', ')} WHERE id = ?${binds.length}`)
      .bind(...binds)
      .run();

    await auditLog(
      env,
      auth.admin,
      'update',
      'role',
      id,
      `code=${code} menus=${body.menus === undefined ? '(未改)' : JSON.stringify(normalizeMenus(body.menus))}`,
      req,
    );
    return json({ ok: true });
  }

  if (method === 'DELETE' && id !== null && Number.isInteger(id)) {
    const row = await env.DB.prepare(`SELECT id, code, builtin FROM roles WHERE id = ?1`)
      .bind(id)
      .first<{ id: number; code: string; builtin: number }>();
    if (!row) return notFound('Role not found');
    if (row.code === 'admin' || Number(row.builtin) === 1) {
      return badRequest('内置角色不可删除。');
    }

    const used = await env.DB.prepare(
      `SELECT COUNT(*) AS c FROM users WHERE deleted_at IS NULL AND role = ?1`,
    )
      .bind(String(row.code))
      .first<{ c: number }>();
    const usedCount = Number(used?.c ?? 0);
    if (usedCount > 0) {
      return badRequest(`还有 ${usedCount} 个用户在使用该角色, 请先把他们改成别的角色。`);
    }

    await env.DB.prepare(`DELETE FROM roles WHERE id = ?1`).bind(id).run();
    await auditLog(env, auth.admin, 'delete', 'role', id, `code=${row.code}`, req);
    return json({ ok: true });
  }

  return badRequest('Unsupported method');
}

// ============================================================
// 「我的」—— 自助 Key / 自助改密 / 我的用量
// ============================================================
//
// 设计前提: **任何登录账号都只能碰自己**。这个文件里所有 my* 查询的 user_id
// 都硬绑会话里的 id, 不接受请求体传入 —— 于是这里不存在越权读取的可能,
// 也不需要挂菜单权限(菜单只管"侧栏看不看得见")。

/** 单账号可持有的 Key 上限, 防止脚本刷爆表 */
const MAX_KEYS_PER_SELF = 20;

/**
 * 自助 Key 默认分组的设置键。
 * 兼容门户时期写入的 `portal_default_group_id`(老库里的值不该因为改个键名就丢掉)。
 */
const SELF_GROUP_SETTING = 'self_service_group_id';

async function readSetting(env: Env, key: string): Promise<string | null> {
  const row = await env.DB.prepare(`SELECT value FROM settings WHERE key = ?1`)
    .bind(key)
    .first<{ value: string }>();
  return row ? String(row.value ?? '') : null;
}

/** 写一条设置(upsert) —— 与「设置」页 PUT 的写法保持一致 */
async function writeSetting(env: Env, key: string, value: string): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES (?1, ?2, ?3)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  )
    .bind(key, value, new Date().toISOString())
    .run();
}

/**
 * 决定自助创建的 Key 挂哪个分组。
 *
 * **绝不能返回 null** —— 路由配置(平台重定向表 / 白名单 / 分组平台)全挂在分组上,
 * `group_id` 为 NULL 的 Key 什么都继承不到, 表现就是"Key 建出来了但一调就 404/503"。
 * 设置里指定的分组若已被删除, 退回"第一个分组"; 一个分组都没有就报错让管理员先建。
 */
async function resolveSelfGroupId(env: Env): Promise<number | null> {
  const raw =
    (await readSetting(env, SELF_GROUP_SETTING)) ??
    (await readSetting(env, 'portal_default_group_id')) ??
    '';
  const n = Number(String(raw).trim());
  if (String(raw).trim() && Number.isInteger(n) && n > 0) {
    const g = await env.DB.prepare(
      `SELECT id FROM groups WHERE id = ?1 AND deleted_at IS NULL`,
    )
      .bind(n)
      .first<{ id: number }>();
    if (g) return Number(g.id);
  }
  const first = await env.DB.prepare(
    `SELECT id FROM groups WHERE deleted_at IS NULL ORDER BY sort_order ASC, id ASC LIMIT 1`,
  ).first<{ id: number }>();
  return first ? Number(first.id) : null;
}

async function handleMy(
  env: Env,
  method: string,
  body: Record<string, unknown>,
  auth: AdminAuthResult,
  req: Request,
  parts: string[],
): Promise<Response> {
  const me = auth.admin;
  if (!me) return json({ error: { message: 'Unauthorized' } }, 401);

  const action = String(parts[1] ?? '');
  const subId = parts[2] ? Number(parts[2]) : null;

  // ---- GET /my/usage : 自己的调用记录 ----
  if (action === 'usage' && method === 'GET') {
    const url = new URL(req.url);
    const limit = intParam(url, 'limit', 20, 1, 100);
    const rows = await env.DB.prepare(
      `SELECT l.id, l.created_at, l.requested_model, l.upstream_model, l.model,
              l.input_tokens, l.output_tokens, l.total_cost, l.duration_ms,
              l.stream, k.name AS key_name
         FROM usage_logs l
         LEFT JOIN api_keys k ON k.id = l.api_key_id
        WHERE l.user_id = ?1
        ORDER BY l.id DESC LIMIT ?2`,
    )
      .bind(me.id, limit)
      .all<Record<string, unknown>>();

    return json({
      logs: (rows.results ?? []).map((r) => ({
        id: r.id,
        created_at: r.created_at,
        requested_model: r.requested_model,
        upstream_model: r.upstream_model,
        model: r.model,
        input_tokens: r.input_tokens,
        output_tokens: r.output_tokens,
        cost: fromMicro(r.total_cost),
        duration_ms: r.duration_ms,
        stream: Number(r.stream ?? 0) === 1,
        key_name: r.key_name ?? '',
        // model 以 error: 开头 = 上游返回了错误(网关把失败也记进 usage_logs)
        error: String(r.model ?? '').startsWith('error:'),
      })),
    });
  }

  // ---- GET /my/keys : 自己名下的 Key ----
  if (action === 'keys' && method === 'GET') {
    const [keyRows, userRow, groups] = await Promise.all([
      env.DB.prepare(
        `SELECT k.*, g.name AS group_name
           FROM api_keys k
           LEFT JOIN groups g ON g.id = k.group_id
          WHERE k.user_id = ?1 AND k.deleted_at IS NULL
          ORDER BY k.id DESC LIMIT 200`,
      )
        .bind(me.id)
        .all<Record<string, unknown>>(),
      env.DB.prepare(
        `SELECT id, email, username, balance, frozen_balance, status FROM users
          WHERE id = ?1 AND deleted_at IS NULL`,
      )
        .bind(me.id)
        .first<Record<string, unknown>>(),
      resolveSelfGroupId(env),
    ]);

    let defaultGroup: { id: number; name: string } | null = null;
    if (groups !== null) {
      const g = await env.DB.prepare(`SELECT id, name FROM groups WHERE id = ?1`)
        .bind(groups)
        .first<{ id: number; name: string }>();
      if (g) defaultGroup = { id: Number(g.id), name: String(g.name) };
    }

    return json({
      user: userRow
        ? {
            id: userRow.id,
            name: String(userRow.username || userRow.email || ''),
            email: userRow.email,
            balance: fromMicro(userRow.balance),
            frozen_balance: fromMicro(userRow.frozen_balance),
            status: userRow.status,
            role: me.role,
            role_name: me.role_name,
          }
        : null,
      api_keys: (keyRows.results ?? []).map(serializeApiKey),
      default_group: defaultGroup,
      max_keys: MAX_KEYS_PER_SELF,
    });
  }

  // ---- POST /my/keys : 给自己发一把 Key ----
  if (action === 'keys' && method === 'POST') {
    const countRow = await env.DB.prepare(
      `SELECT COUNT(*) AS c FROM api_keys WHERE user_id = ?1 AND deleted_at IS NULL`,
    )
      .bind(me.id)
      .first<{ c: number }>();
    if (Number(countRow?.c ?? 0) >= MAX_KEYS_PER_SELF) {
      return badRequest(`最多只能持有 ${MAX_KEYS_PER_SELF} 把 Key, 请先删除不用的。`);
    }

    const groupId = await resolveSelfGroupId(env);
    if (groupId === null) {
      return badRequest('系统里还没有任何分组, 请联系管理员先建一个分组。');
    }

    const prefix = (env as unknown as Record<string, string>)['API_KEY_PREFIX'] ?? 'sk-';
    const key = generateApiKey(prefix);
    const name = String(body.name ?? '').trim() || 'self-service';

    // 权限相关的列**全部硬编码**: 用户自己发的 Key 不能自带额度/白名单/自定义分组,
    // 否则"自助"就变成了自助提权。
    const res = await env.DB.prepare(
      `INSERT INTO api_keys (user_id, key, name, group_id, status)
       VALUES (?1, ?2, ?3, ?4, 'active')`,
    )
      .bind(me.id, key, name.slice(0, 64), groupId)
      .run();

    const newId = res.meta?.last_row_id ?? 0;
    await auditLog(env, auth.admin, 'create', 'api_key', newId, `self-service user=${me.id}`, req);
    // 明文 key 只在创建时返回一次
    return json({ ok: true, id: newId, key, group_id: groupId }, 201);
  }

  // ---- DELETE /my/keys/<id> : 删除自己的 Key ----
  if (action === 'keys' && method === 'DELETE' && subId !== null && Number.isInteger(subId)) {
    // 软删除; user_id 一并写进 WHERE —— 这样即使猜到了别人的 key id 也删不掉,
    // 且 changes=0 时能明确区分"不存在"与"不是你的"。
    const res = await env.DB.prepare(
      `UPDATE api_keys SET deleted_at = ?1, status = 'disabled', updated_at = ?1
        WHERE id = ?2 AND user_id = ?3 AND deleted_at IS NULL`,
    )
      .bind(new Date().toISOString(), subId, me.id)
      .run();

    if (Number(res.meta?.changes ?? 0) === 0) {
      return notFound('该 Key 不存在, 或不属于当前账号。');
    }
    await auditLog(env, auth.admin, 'delete', 'api_key', subId, 'self-service', req);
    return json({ ok: true });
  }

  return badRequest('Unsupported method');
}

// ============================================================
// 分组管理
// ============================================================

/**
 * 分组 ↔ 账号 绑定明细 / 整体替换。
 *
 * 为什么需要它: 账号是软删除, `account_groups` 里的关联行不会被清掉, 于是
 * 分组页的「账号数」会把早已删除的账号一起数进去(排查过一次: default 显示 6,
 * 实际只有 3 个活账号 —— 另外 3 条指向 2026-09-20 删掉的 anthropic-1 /
 * gemini-1 / openai-1)。运行期不受影响, 但后台数字对不上会让人怀疑配置没生效。
 *
 * GET  /groups/:id/accounts
 *   -> { group, accounts:[{id,name,platform,status,schedulable,bound,priority}],
 *        stale:[{account_id}] }
 *      accounts 只含**未删除**的账号(含 disabled / 不可调度的, 它们仍是活账号);
 *      stale 是"仍挂在关联表里、但账号已不存在或已软删除"的行。
 *
 * PUT  /groups/:id/accounts
 *   body { account_ids:number[], priority?:number, purge_stale?:boolean }
 *   -> 整体替换该分组的绑定。语义与账号侧 PUT /accounts/:id 的 group_ids 一致:
 *      **传什么就是什么**(不传 account_ids 则不碰绑定)。
 *      只接受存在且未删除的账号 id, 因此只要保存一次, 该分组下的幽灵绑定就会被
 *      顺手清掉; 想只清理、不改绑定, 传 { purge_stale: true } 即可。
 */
async function handleGroupAccounts(
  env: Env,
  method: string,
  groupId: number,
  body: Record<string, unknown>,
  auth: AdminAuthResult,
  req: Request,
): Promise<Response> {
  const group = await env.DB.prepare(
    `SELECT id, name FROM groups WHERE id = ?1 AND deleted_at IS NULL`,
  )
    .bind(groupId)
    .first<{ id: number; name: string }>();
  if (!group) return notFound('Group not found');

  if (method === 'GET') {
    const [acctRows, linkRows] = await Promise.all([
      env.DB.prepare(
        `SELECT id, name, platform, status, schedulable, priority
         FROM accounts WHERE deleted_at IS NULL
         ORDER BY priority ASC, id ASC`,
      ).all<Record<string, unknown>>(),

      env.DB.prepare(
        `SELECT ag.account_id, ag.priority, a.name AS account_name, a.platform AS account_platform,
                a.status AS account_status, a.deleted_at AS account_deleted
         FROM account_groups ag
         LEFT JOIN accounts a ON a.id = ag.account_id
         WHERE ag.group_id = ?1
         ORDER BY ag.priority ASC, ag.account_id ASC`,
      ).bind(groupId).all<Record<string, unknown>>(),
    ]);

    const links = linkRows.results ?? [];
    const boundMap = new Map<number, number>(); // account_id -> priority
    for (const r of links) boundMap.set(Number(r.account_id), Number(r.priority ?? 10));

    return json({
      group: { id: group.id, name: group.name },
      accounts: (acctRows.results ?? []).map((a) => ({
        id: a.id,
        name: a.name,
        platform: a.platform,
        status: a.status,
        schedulable: a.schedulable === 1,
        bound: boundMap.has(Number(a.id)),
        priority: boundMap.get(Number(a.id)) ?? 10,
      })),
      // 幽灵绑定: 关联行还在, 账号却已经不存在/被删 —— 它们就是「账号数」虚高的来源
      stale: links
        .filter((r) => r.account_deleted !== null || r.account_name === null)
        .map((r) => ({
          account_id: r.account_id,
          name: r.account_name ?? null,
          platform: r.account_platform ?? null,
        })),
    });
  }

  if (method === 'PUT') {
    const hasList = Array.isArray(body.account_ids);
    const purgeOnly = body.purge_stale === true || body.purge_stale === 1;

    if (!hasList && !purgeOnly) {
      return badRequest('Provide account_ids (full replacement) or purge_stale:true');
    }

    let removed = 0;

    if (hasList) {
      const raw = (body.account_ids as unknown[]).map(Number);
      const ids = Array.from(new Set(raw.filter((n) => Number.isInteger(n) && n > 0)));

      // 只允许绑定"存在且未删除"的账号 —— 前端即使传了已删账号 id 也会被丢掉
      let allowed: number[] = [];
      if (ids.length > 0) {
        const ph = ids.map((_, i) => `?${i + 1}`).join(',');
        const ok = await env.DB.prepare(
          `SELECT id FROM accounts WHERE deleted_at IS NULL AND id IN (${ph})`,
        ).bind(...ids).all<{ id: number }>();
        allowed = (ok.results ?? []).map((r) => Number(r.id));
      }

      const before = await env.DB.prepare(
        `SELECT COUNT(*) AS c FROM account_groups WHERE group_id = ?1`,
      ).bind(groupId).first<{ c: number }>();

      // 整体替换: 先清空该分组的旧关联(含幽灵绑定), 再按提交的清单重建
      await env.DB.prepare(`DELETE FROM account_groups WHERE group_id = ?1`)
        .bind(groupId)
        .run();

      const priority = Number(body.priority ?? 10);
      for (const aid of allowed) {
        await env.DB.prepare(
          `INSERT OR IGNORE INTO account_groups (account_id, group_id, priority) VALUES (?1,?2,?3)`,
        ).bind(aid, groupId, Number.isFinite(priority) ? priority : 10).run();
      }

      removed = Math.max(0, Number(before?.c ?? 0) - allowed.length);
      await auditLog(
        env,
        auth.admin,
        'update',
        'group_accounts',
        groupId,
        `bound=[${allowed.join(',')}] removed=${removed}`,
        req,
      );
      return json({ ok: true, bound: allowed.length, removed });
    }

    // 只清理幽灵绑定
    const res = await env.DB.prepare(
      `DELETE FROM account_groups
       WHERE group_id = ?1
         AND account_id NOT IN (SELECT id FROM accounts WHERE deleted_at IS NULL)`,
    ).bind(groupId).run();
    removed = Number(res.meta?.changes ?? 0);
    await auditLog(env, auth.admin, 'update', 'group_accounts', groupId, `purge_stale removed=${removed}`, req);
    return json({ ok: true, removed });
  }

  return badRequest('Unsupported method');
}

async function handleGroups(
  env: Env,
  method: string,
  id: number | null,
  body: Record<string, unknown>,
  auth: AdminAuthResult,
  req: Request,
  parts: string[] = [],
): Promise<Response> {
  // ---------------- 分组 ↔ 账号 绑定管理 ----------------
  // 背景: account_groups 是 (account_id, group_id) 关联表, 账号是**软删除**
  // (accounts.deleted_at), 而关联行不会被级联清掉 —— 删掉的账号会永远留在关联表里。
  // 网关侧 (scheduler.ts / gateway.ts) 查询时会 JOIN accounts 并过滤 deleted_at,
  // 所以运行期不受影响; 但后台分组页若直接 COUNT(account_groups) 就会把这些
  // "幽灵绑定"算进去, 表现为「账号数」比实际账号多。
  if (id !== null && parts[2] === 'accounts') {
    return await handleGroupAccounts(env, method, id, body, auth, req);
  }

  if (method === 'GET') {
    const rows = await env.DB.prepare(
      `SELECT g.*,
              (SELECT COUNT(*) FROM account_groups ag
                 JOIN accounts a ON a.id = ag.account_id
                WHERE ag.group_id=g.id AND a.deleted_at IS NULL) AS account_count,
              (SELECT COUNT(*) FROM account_groups ag
                 JOIN accounts a ON a.id = ag.account_id
                WHERE ag.group_id=g.id AND a.deleted_at IS NULL
                  AND a.status='active' AND a.schedulable=1) AS account_count_active,
              (SELECT COUNT(*) FROM account_groups ag
                 LEFT JOIN accounts a ON a.id = ag.account_id
                WHERE ag.group_id=g.id AND (a.id IS NULL OR a.deleted_at IS NOT NULL)) AS account_count_stale,
              (SELECT COUNT(*) FROM api_keys k WHERE k.group_id=g.id AND k.deleted_at IS NULL) AS key_count
       FROM groups g WHERE g.deleted_at IS NULL
       ORDER BY g.sort_order ASC, g.id ASC`,
    ).all<Record<string, unknown>>();

    return json({
      groups: (rows.results ?? []).map((g) => ({
        id: g.id,
        name: g.name,
        description: g.description,
        platform: g.platform,
        rate_multiplier: fromMicro(g.rate_multiplier),
        status: g.status,
        rpm_limit: g.rpm_limit,
        model_allowlist: parseJson(g.model_allowlist),
        default_mapped_model: g.default_mapped_model,
        model_routing_enabled: g.model_routing_enabled === 1,
        model_platform_routing: parseJson(g.model_platform_routing),
        // 只统计**存活**账号(GET /groups/:id/accounts 可看到明细); 失效绑定单独给一个数,
        // 让后台能提示"另有 N 条绑定指向已删除账号", 而不是把它静悄悄算进账号数。
        account_count: g.account_count ?? 0,
        account_count_active: g.account_count_active ?? 0,
        account_count_stale: g.account_count_stale ?? 0,
        key_count: g.key_count ?? 0,
        sort_order: g.sort_order,
        created_at: g.created_at,
      })),
    });
  }

  if (method === 'POST') {
    const name = String(body.name ?? '').trim();
    if (!name) return badRequest('name is required');

    const res = await env.DB.prepare(
      `INSERT INTO groups (name, description, platform, rate_multiplier, status, rpm_limit,
                           model_allowlist, default_mapped_model, model_routing_enabled,
                           model_platform_routing, sort_order)
       VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)`,
    )
      .bind(
        name,
        String(body.description ?? ''),
        String(body.platform ?? ''),
        toMicro(body.rate_multiplier ?? 1),
        String(body.status ?? 'active'),
        Number(body.rpm_limit ?? 0),
        body.model_allowlist ? JSON.stringify(body.model_allowlist) : null,
        body.default_mapped_model ? String(body.default_mapped_model) : null,
        body.model_routing_enabled ? 1 : 0,
        body.model_platform_routing ? JSON.stringify(body.model_platform_routing) : null,
        Number(body.sort_order ?? 0),
      )
      .run();

    const newId = res.meta?.last_row_id ?? 0;
    await auditLog(env, auth.admin, 'create', 'group', newId, `name=${name}`, req);
    return json({ ok: true, id: newId }, 201);
  }

  if (method === 'PUT' && id !== null) {
    const fields: string[] = [];
    const binds: unknown[] = [];

    const simple: Record<string, (v: unknown) => unknown> = {
      name: String,
      description: String,
      platform: String,
      status: String,
      rpm_limit: Number,
      sort_order: Number,
      rate_multiplier: (v) => toMicro(v),
      default_mapped_model: (v) => (v ? String(v) : null),
      model_routing_enabled: (v) => (v ? 1 : 0),
      model_platform_routing: (v) =>
        v === null || v === undefined || v === ''
          ? null
          : typeof v === 'object'
            ? JSON.stringify(v)
            : String(v),
      model_allowlist: (v) =>
        v === null || v === undefined ? null : Array.isArray(v) ? JSON.stringify(v) : String(v),
    };

    for (const [key, conv] of Object.entries(simple)) {
      if (body[key] !== undefined) {
        fields.push(`${key} = ?${binds.length + 1}`);
        binds.push(conv(body[key]));
      }
    }
    if (fields.length === 0) return badRequest('No updatable fields provided');

    fields.push(`updated_at = ?${binds.length + 1}`);
    binds.push(new Date().toISOString());
    binds.push(id);

    await env.DB.prepare(`UPDATE groups SET ${fields.join(', ')} WHERE id = ?${binds.length}`)
      .bind(...binds)
      .run();

    await auditLog(env, auth.admin, 'update', 'group', id, JSON.stringify(body).slice(0, 500), req);
    return json({ ok: true });
  }

  if (method === 'DELETE' && id !== null) {
    await env.DB.prepare(
      `UPDATE groups SET deleted_at = ?1, updated_at = ?1 WHERE id = ?2 AND deleted_at IS NULL`,
    )
      .bind(new Date().toISOString(), id)
      .run();
    await auditLog(env, auth.admin, 'delete', 'group', id, '', req);
    return json({ ok: true });
  }

  return badRequest('Unsupported method');
}

// ============================================================
// API Key 管理
// ============================================================

/**
 * 生成 API Key: `<prefix>` + 32 位 UUID(去掉连字符的 128bit 随机)。
 * 形如 `sk-3f2a1b0c9d8e7f6a5b4c3d2e1f0a9b8c` —— 32 个 hex 字符, 总长 35。
 *
 * 为什么用 randomUUID() 而不是 getRandomValues(): 前者本来就是 32 个 hex,
 * 比自己拼 32 字节(64 hex) 短一半, 肉眼可读性好, 而 128bit 熵对 API Key 依然绰绰有余。
 * 注意: 这里只发**客户端 Key**(api_keys 表), 不涉及上游账号凭据, 所以改格式没有兼容问题。
 */
function generateApiKey(prefix: string): string {
  return prefix + crypto.randomUUID().replace(/-/g, '');
}

async function handleApiKeys(
  env: Env,
  method: string,
  id: number | null,
  body: Record<string, unknown>,
  auth: AdminAuthResult,
  req: Request,
): Promise<Response> {
  if (method === 'GET') {
    // 可选按用户过滤: /api-keys?user_id=3 —— 用户页「Key」按钮用它列出单个用户名下的 Key
    const userFilter = Number(new URL(req.url).searchParams.get('user_id') ?? '');
    const filterByUser = Number.isInteger(userFilter) && userFilter > 0;

    const [rows, userRows] = await Promise.all([
      env.DB.prepare(
        `SELECT k.*, u.email AS user_email, g.name AS group_name
         FROM api_keys k
         LEFT JOIN users u ON u.id = k.user_id
         LEFT JOIN groups g ON g.id = k.group_id
         WHERE k.deleted_at IS NULL${filterByUser ? ' AND k.user_id = ?1' : ''}
         ORDER BY k.id DESC LIMIT 500`,
      ).bind(...(filterByUser ? [userFilter] : [])).all<Record<string, unknown>>(),

      // 前端「所属用户」下拉需要用户列表, 随 key 列表一起返回, 省一次请求
      env.DB.prepare(
        `SELECT id, email, username, balance, status
         FROM users
         WHERE deleted_at IS NULL
         ORDER BY id ASC LIMIT 1000`,
      ).all<Record<string, unknown>>(),
    ]);

    return json({
      api_keys: (rows.results ?? []).map(serializeApiKey),
      users: userRows.results ?? [],
    });
  }

  if (method === 'POST') {
    const userId = Number(body.user_id);
    if (!Number.isInteger(userId) || userId <= 0) return badRequest('user_id is required');

    // 允许自定义 key, 否则自动生成
    let key = String(body.key ?? '').trim();
    if (!key) {
      key = generateApiKey('sk-');
    } else {
      if (key.length < 16 || !/^[A-Za-z0-9_-]+$/.test(key)) {
        return badRequest('Custom key must be at least 16 chars and only contain [A-Za-z0-9_-]');
      }
    }

    // 唯一性检查
    const dup = await env.DB.prepare(
      `SELECT id FROM api_keys WHERE key = ?1 AND deleted_at IS NULL`,
    )
      .bind(key)
      .first<{ id: number }>();
    if (dup) return badRequest('This key already exists');

    const res = await env.DB.prepare(
      `INSERT INTO api_keys (user_id, key, name, group_id, status, quota, expires_at,
                             rate_limit_5h, rate_limit_1d, rate_limit_7d)
       VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)`,
    )
      .bind(
        userId,
        key,
        String(body.name ?? ''),
        body.group_id ? Number(body.group_id) : null,
        String(body.status ?? 'active'),
        toMicro(body.quota ?? 0),
        body.expires_at ? String(body.expires_at) : null,
        toMicro(body.rate_limit_5h ?? 0),
        toMicro(body.rate_limit_1d ?? 0),
        toMicro(body.rate_limit_7d ?? 0),
      )
      .run();

    const newId = res.meta?.last_row_id ?? 0;
    await auditLog(env, auth.admin, 'create', 'api_key', newId, `user=${userId}`, req);
    // 明文 key 只在创建时返回一次
    return json({ ok: true, id: newId, key }, 201);
  }

  if (method === 'PUT' && id !== null) {
    const fields: string[] = [];
    const binds: unknown[] = [];

    const map: Record<string, (v: unknown) => unknown> = {
      name: String,
      status: String,
      user_id: Number,
      group_id: (v) => (v === null || v === '' ? null : Number(v)),
      expires_at: (v) => (v ? String(v) : null),
      quota: (v) => toMicro(v),
      quota_used: (v) => toMicro(v),
      rate_limit_5h: (v) => toMicro(v),
      rate_limit_1d: (v) => toMicro(v),
      rate_limit_7d: (v) => toMicro(v),
      usage_5h: (v) => toMicro(v),
      usage_1d: (v) => toMicro(v),
      usage_7d: (v) => toMicro(v),
      ip_whitelist: (v) =>
        v === null || v === undefined || (Array.isArray(v) && v.length === 0)
          ? null
          : JSON.stringify(v),
    };

    for (const [key, conv] of Object.entries(map)) {
      if (body[key] !== undefined) {
        fields.push(`${key} = ?${binds.length + 1}`);
        binds.push(conv(body[key]));
      }
    }
    if (fields.length === 0) return badRequest('No updatable fields provided');

    fields.push(`updated_at = ?${binds.length + 1}`);
    binds.push(new Date().toISOString());
    binds.push(id);

    await env.DB.prepare(`UPDATE api_keys SET ${fields.join(', ')} WHERE id = ?${binds.length}`)
      .bind(...binds)
      .run();

    await auditLog(env, auth.admin, 'update', 'api_key', id, JSON.stringify(body).slice(0, 500), req);
    return json({ ok: true });
  }

  if (method === 'DELETE' && id !== null) {
    await env.DB.prepare(
      `UPDATE api_keys SET deleted_at = ?1, updated_at = ?1 WHERE id = ?2 AND deleted_at IS NULL`,
    )
      .bind(new Date().toISOString(), id)
      .run();
    await auditLog(env, auth.admin, 'delete', 'api_key', id, '', req);
    return json({ ok: true });
  }

  return badRequest('Unsupported method');
}

function serializeApiKey(row: Record<string, unknown>) {
  const key = String(row.key ?? '');
  return {
    id: row.id,
    key,
    // 列表里打码显示, 避免明文全量暴露
    key_masked: key.length > 12 ? `${key.slice(0, 8)}${'*'.repeat(12)}${key.slice(-4)}` : key,
    name: row.name,
    user_id: row.user_id,
    user_email: row.user_email,
    group_id: row.group_id,
    group_name: row.group_name,
    status: row.status,
    quota: fromMicro(row.quota),
    quota_used: fromMicro(row.quota_used),
    expires_at: row.expires_at,
    rate_limit_5h: fromMicro(row.rate_limit_5h),
    rate_limit_1d: fromMicro(row.rate_limit_1d),
    rate_limit_7d: fromMicro(row.rate_limit_7d),
    usage_5h: fromMicro(row.usage_5h),
    usage_1d: fromMicro(row.usage_1d),
    usage_7d: fromMicro(row.usage_7d),
    ip_whitelist: parseJson(row.ip_whitelist),
    last_used_at: row.last_used_at,
    created_at: row.created_at,
  };
}

// ============================================================
// 上游账号管理
// ============================================================

async function handleAccounts(
  env: Env,
  method: string,
  id: number | null,
  body: Record<string, unknown>,
  auth: AdminAuthResult,
  req: Request,
  parts: string[],
): Promise<Response> {
  // 连通性测试: POST /accounts/:id/test
  if (method === 'POST' && id !== null && parts[2] === 'test') {
    return await testAccount(env, id, auth, req);
  }

  // 模型获取: GET /accounts/:id/models —— 拉取该上游真实模型列表
  if (method === 'GET' && id !== null && parts[2] === 'models') {
    return await fetchAccountModels(env, id, auth, req);
  }

  if (method === 'GET') {
    const rows = await env.DB.prepare(
      `SELECT a.*,
              (SELECT GROUP_CONCAT(ag.group_id) FROM account_groups ag WHERE ag.account_id=a.id) AS group_ids
       FROM accounts a WHERE a.deleted_at IS NULL
       ORDER BY a.priority ASC, a.id ASC`,
    ).all<AccountRow & Record<string, unknown>>();

    return json({
      accounts: (rows.results ?? []).map(serializeAccount),
      platforms: BUILTIN_PLATFORMS,
      protocols: UPSTREAM_PROTOCOLS,
      default_base_urls: DEFAULT_BASE_URLS,
      protocol_base_url_hints: PROTOCOL_BASE_URL_HINTS,
      // 平台 -> 默认协议, 供前端选中平台时自动带出
      protocol_defaults: Object.fromEntries(
        BUILTIN_PLATFORMS.map((p) => [p, defaultProtocolFor(p)]),
      ),
    });
  }

  if (method === 'POST') {
    const name = String(body.name ?? '').trim();
    if (!name) return badRequest('name is required');

    // 平台: 内置官方平台 或 任意自定义名称(第三方中转/自建网关)
    const platform = normalizePlatformName(String(body.platform ?? ''));
    if (!platform) return badRequest('platform is required');
    if (!isValidPlatformName(platform)) {
      return badRequest(
        'platform must be 1-64 chars, lowercase letters/digits/underscore/hyphen, starting with a letter or digit',
      );
    }

    // 协议: 未指定时按平台推导
    const protocol = resolveProtocol(platform, body.protocol as string | undefined);

    const credential = String(body.api_key ?? '').trim();
    if (!credential) return badRequest('api_key is required');

    // 自定义平台没有内置默认域名, 必须显式填 base_url, 否则部署后必然 502
    const baseUrl = String(body.base_url ?? '').trim();
    if (!baseUrl && !isBuiltinPlatform(platform)) {
      return badRequest(
        `Platform "${platform}" is not a builtin platform, so base_url is required (e.g. https://your-relay.example.com).`,
      );
    }
    if (baseUrl && !/^https?:\/\//i.test(baseUrl)) {
      return badRequest('base_url must start with http:// or https://');
    }

    // 入口路径: 选填 —— 填了之后客户端就能用 /<entry>/v1/... 直接指定这条上游
    const entryPath = normalizeEntryPath(body['entry_path']);
    if (entryPath) {
      const bad = entryPathError(entryPath);
      if (bad) return badRequest(bad);
      const conflict = await findEntryPathConflict(env, entryPath, null);
      if (conflict !== null) {
        return badRequest(`entry_path "${entryPath}" is already used by account #${conflict}`);
      }
    }

    const res = await env.DB.prepare(
      `INSERT INTO accounts (name, notes, platform, protocol, type, credentials, extra, concurrency,
                             load_factor, priority, rate_multiplier, status, schedulable, base_url,
                             entry_path)
       VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15)`,
    )
      .bind(
        name,
        String(body.notes ?? ''),
        platform,
        protocol,
        String(body.type ?? 'apikey'),
        JSON.stringify({ api_key: credential }),
        JSON.stringify(buildAccountExtra(body['model_aliases'])),
        Number(body.concurrency ?? 3),
        body.load_factor ? Number(body.load_factor) : null,
        Number(body.priority ?? 10),
        toMicro(body.rate_multiplier ?? 1),
        String(body.status ?? 'active'),
        body.schedulable === false ? 0 : 1,
        baseUrl || null,
        entryPath || null,
      )
      .run();

    const newId = res.meta?.last_row_id ?? 0;

    // 绑定分组
    // 不传 group_ids 时默认进 default 分组, 否则账号建了但调度器 JOIN 不到 -> 永远选不中
    let groupIds = Array.isArray(body.group_ids) ? body.group_ids.map(Number) : [];
    if (groupIds.filter((g) => Number.isInteger(g) && g > 0).length === 0) {
      const def = await env.DB.prepare(
        `SELECT id FROM groups WHERE deleted_at IS NULL ORDER BY id ASC LIMIT 1`,
      ).first<{ id: number }>();
      if (def) groupIds = [def.id];
    }
    for (const gid of groupIds) {
      if (Number.isInteger(gid) && gid > 0) {
        await env.DB.prepare(
          `INSERT OR IGNORE INTO account_groups (account_id, group_id, priority) VALUES (?1,?2,?3)`,
        )
          .bind(newId, gid, Number(body.priority ?? 10))
          .run();
      }
    }

    await auditLog(env, auth.admin, 'create', 'account', newId, `name=${name} platform=${platform} protocol=${protocol}`, req);
    return json({ ok: true, id: newId }, 201);
  }

  if (method === 'PUT' && id !== null) {
    const fields: string[] = [];
    const binds: unknown[] = [];

    // 平台/协议变更需先校验, 单独处理
    if (body.platform !== undefined) {
      const p = normalizePlatformName(String(body.platform));
      if (!p) return badRequest('platform cannot be empty');
      if (!isValidPlatformName(p)) {
        return badRequest(
          'platform must be 1-64 chars, lowercase letters/digits/underscore/hyphen, starting with a letter or digit',
        );
      }
      body.platform = p;
    }
    if (body.protocol !== undefined) {
      const pr = String(body.protocol).trim().toLowerCase();
      if (pr && !(UPSTREAM_PROTOCOLS as readonly string[]).includes(pr)) {
        return badRequest(`protocol must be one of: ${UPSTREAM_PROTOCOLS.join(', ')}`);
      }
      body.protocol = pr;
    }
    if (body['entry_path'] !== undefined) {
      const ep = normalizeEntryPath(body['entry_path']);
      if (ep) {
        const bad = entryPathError(ep);
        if (bad) return badRequest(bad);
        const conflict = await findEntryPathConflict(env, ep, id);
        if (conflict !== null) {
          return badRequest(`entry_path "${ep}" is already used by account #${conflict}`);
        }
      }
      // 空串 -> null: 允许把入口路径清掉(退回模型名判定)
      body['entry_path'] = ep || null;
    }

    const map: Record<string, (v: unknown) => unknown> = {
      name: String,
      notes: String,
      platform: String,
      protocol: String,
      type: String,
      concurrency: Number,
      load_factor: (v) => (v ? Number(v) : null),
      priority: Number,
      rate_multiplier: (v) => toMicro(v),
      status: String,
      schedulable: (v) => (v ? 1 : 0),
      base_url: (v) => (v ? String(v) : null),
      entry_path: (v) => (v ? String(v) : null),
    };

    for (const [key, conv] of Object.entries(map)) {
      if (body[key] !== undefined) {
        fields.push(`${key} = ?${binds.length + 1}`);
        binds.push(conv(body[key]));
      }
    }

    // 凭证: 传了 api_key 才更新, 否则保留原值
    const newCred = String(body.api_key ?? '').trim();
    if (newCred) {
      fields.push(`credentials = ?${binds.length + 1}`);
      binds.push(JSON.stringify({ api_key: newCred }));
    }

    // 模型别名存在 extra 列(合并式更新, 不动 extra 里的其它键)
    if (body['model_aliases'] !== undefined) {
      const cur = await env.DB.prepare(`SELECT extra FROM accounts WHERE id = ?1`)
        .bind(id)
        .first<{ extra: string }>();
      let curExtra: Record<string, unknown> = {};
      try {
        const parsed = JSON.parse(String(cur?.extra ?? '{}')) as unknown;
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          curExtra = parsed as Record<string, unknown>;
        }
      } catch {
        curExtra = {};
      }
      // 别名清空(传 null / {} / 全是非法值)时必须把键**删掉**, 不能留着旧值 ——
      // 否则"删掉最后一条别名"会静默失效(见 mergeAccountAliases 的注释)。
      const merged = mergeAccountAliases(curExtra, body['model_aliases']);
      fields.push(`extra = ?${binds.length + 1}`);
      binds.push(JSON.stringify(merged));
    }

    // group_ids 是独立于字段列表的操作, 单传它也要允许(否则改绑定会被误判为"无可更新字段")
    const hasGroupChange = Array.isArray(body.group_ids);
    if (fields.length === 0 && !hasGroupChange) {
      return badRequest('No updatable fields provided');
    }

    // 校验 URL 格式
    if (body.base_url !== undefined && body.base_url) {
      if (!/^https?:\/\//i.test(String(body.base_url))) {
        return badRequest('base_url must start with http:// or https://');
      }
    }

    // 改了平台/base_url 后, 自定义平台不能出现"没有 base_url 也没有默认域名"的组合
    // (否则调度选中后会拼出坏 URL)
    if (body.platform !== undefined || body.base_url !== undefined) {
      const cur = await env.DB.prepare(
        `SELECT platform, base_url FROM accounts WHERE id = ?1`,
      )
        .bind(id)
        .first<{ platform: string; base_url: string | null }>();
      if (cur) {
        const nextPlatform =
          body.platform !== undefined ? String(body.platform) : cur.platform;
        const nextBase =
          body.base_url !== undefined
            ? String(body.base_url || '').trim()
            : (cur.base_url ?? '').trim();
        if (!nextBase && !isBuiltinPlatform(nextPlatform)) {
          return badRequest(
            `Platform "${nextPlatform}" is not a builtin platform, so base_url is required.`,
          );
        }
      }
    }

    // 只改分组绑定时不发 UPDATE (空 SET 会拼出非法 SQL)
    if (fields.length > 0) {
      fields.push(`updated_at = ?${binds.length + 1}`);
      binds.push(new Date().toISOString());
      binds.push(id);

      await env.DB.prepare(`UPDATE accounts SET ${fields.join(', ')} WHERE id = ?${binds.length}`)
        .bind(...binds)
        .run();
    }

    // 分组绑定: 传了 group_ids 就整体替换
    if (Array.isArray(body.group_ids)) {
      await env.DB.prepare(`DELETE FROM account_groups WHERE account_id = ?1`).bind(id).run();
      let gids = body.group_ids.map(Number).filter((g) => Number.isInteger(g) && g > 0);
      // 清空后若一个都不剩, 回落到 default 分组, 避免账号变成"孤儿"选不中
      if (gids.length === 0) {
        const def = await env.DB.prepare(
          `SELECT id FROM groups WHERE deleted_at IS NULL ORDER BY id ASC LIMIT 1`,
        ).first<{ id: number }>();
        if (def) gids = [def.id];
      }
      for (const gid of gids) {
        await env.DB.prepare(
          `INSERT OR IGNORE INTO account_groups (account_id, group_id, priority) VALUES (?1,?2,?3)`,
        )
          .bind(id, gid, Number(body.priority ?? 10))
          .run();
      }
    }

    await auditLog(env, auth.admin, 'update', 'account', id, JSON.stringify({ ...body, api_key: body.api_key ? '***' : undefined }).slice(0, 500), req);
    return json({ ok: true });
  }

  if (method === 'DELETE' && id !== null) {
    // 🚨 软删账号前, 先把它的**账号级定价**和**分组绑定**清掉:
    //   1. model_pricing WHERE account_id = id —— 「模型定价跟账号走」
    //      (v1.x 起定价表支持 (account_id, model) 复合主键, 账号删了它的专属价不该留着)
    //   2. account_groups WHERE account_id = id -> 删绑定(靠 FK ON DELETE CASCADE 也可以,
    //      但 D1 未保证开启 foreign_keys, 显式删最稳)
    //   3. 模型别名(model_aliases)存在 accounts.extra JSON 里, 随账号软删自然消失,
    //      无需单独处理; 模型索引(model_index)——真实列, 属于账号自身, 同样随账号走。
    //   usage_logs 保留(审计), 但为不破坏计费统计, 数据仍在。
    await env.DB.batch([
      env.DB.prepare(`DELETE FROM model_pricing WHERE account_id = ?1`).bind(id),
      env.DB.prepare(`DELETE FROM account_groups WHERE account_id = ?1`).bind(id),
    ]);
    await env.DB.prepare(
      `UPDATE accounts SET deleted_at = ?1, updated_at = ?1 WHERE id = ?2 AND deleted_at IS NULL`,
    )
      .bind(new Date().toISOString(), id)
      .run();
    await auditLog(env, auth.admin, 'delete', 'account', id, 'cascade: model_pricing + account_groups', req);
    return json({ ok: true });
  }

  return badRequest('Unsupported method');
}

/**
 * 把请求体里的 `model_aliases` 规整成要落进 `extra` 列的对象
 *
 * 形态: { 对外模型名: 该上游认识的名字 }。非法/空的键值直接丢弃 ——
 * 这里只做"入库前清洗", 真正的匹配在 gateway 侧 (见 applyAccountAlias)。
 * 传 null/undefined 表示清空(返回不带 model_aliases 键的对象)。
 */
function buildAccountExtra(raw: unknown): Record<string, unknown> {
  if (raw === null || raw === undefined) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) return {};
  const obj: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const name = String(k ?? '').trim();
    const target = String(v ?? '').trim();
    if (name && target) obj[name] = target;
  }
  return Object.keys(obj).length > 0 ? { model_aliases: obj } : {};
}

/**
 * 把新的 model_aliases 写进 extra 对象(整体替换别名表, 其它键原样保留)。
 *
 * 语义选择上踩过坑, 这里写清楚**为什么是"整体替换"而不是"按条目合并"**:
 *
 *   请求体里的 `model_aliases` 是**一张完整的表**, 不是增量补丁 —— 后台所有入口
 *   (账号编辑弹窗、模型获取页、别名管理页)都是"读出当前表 -> 改 -> 整表回写"。
 *   如果这里再按条目合并, 就永远删不掉东西: 发 `{}` 想清空, 合并后旧值还在,
 *   表现为"删了别名但旧规则继续生效"。
 *
 *   所以: model_aliases 一旦**出现在请求体里**, 就整体替换(空表 => 删除该键)。
 *   只有**不传**这个字段时, 才保留数据库里的原值。
 *
 * 其它 extra 键(foo 等)不受影响 —— 那些确实是合并语义。
 *
 * @param curExtra 数据库里现有的 extra(已解析)
 * @param rawAliases 请求体里的 model_aliases(未清洗)
 */
function mergeAccountAliases(
  curExtra: Record<string, unknown>,
  rawAliases: unknown,
): Record<string, unknown> {
  const cleaned = buildAccountExtra(rawAliases); // {} 或 { model_aliases: {...} }
  const merged = { ...curExtra };

  if (Object.keys(cleaned).length > 0) merged['model_aliases'] = cleaned['model_aliases'];
  else delete merged['model_aliases'];

  return merged;
}

function serializeAccount(row: AccountRow & Record<string, unknown>) {
  let credPreview = '';
  try {
    const creds = JSON.parse(String(row.credentials ?? '{}')) as Record<string, unknown>;
    const raw = extractCredential(creds) ?? '';
    credPreview = raw.length > 10 ? `${raw.slice(0, 6)}${'*'.repeat(8)}${raw.slice(-4)}` : raw ? '***' : '';
  } catch {
    credPreview = '';
  }

  // 账号级模型别名 —— 存在 extra.model_aliases, 回显给编辑弹窗
  let modelAliases: Record<string, string> | null = null;
  try {
    const extra = JSON.parse(String(row.extra ?? '{}')) as Record<string, unknown>;
    const raw = extra['model_aliases'];
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      const obj: Record<string, string> = {};
      for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
        const name = String(k ?? '').trim();
        const target = String(v ?? '').trim();
        if (name && target) obj[name] = target;
      }
      modelAliases = Object.keys(obj).length > 0 ? obj : null;
    }
  } catch {
    modelAliases = null;
  }

  // 模型索引 —— 后台「模型获取」落库的模型名列表, 驱动 gateway 的自动路由。
  // 这里原样解析成数组回显, 前端分组页的「一键填充」据此判断模型有没有归口。
  let modelIndex: string[] | null = null;
  try {
    const mi = row.model_index;
    const parsed = typeof mi === 'string' ? JSON.parse(mi || '[]') : mi;
    if (Array.isArray(parsed)) {
      const arr = parsed.map((m) => String(m ?? '').trim()).filter(Boolean);
      modelIndex = arr.length > 0 ? arr : null;
    }
  } catch {
    modelIndex = null;
  }

  return {
    id: row.id,
    name: row.name,
    notes: row.notes,
    platform: row.platform,
    is_custom_platform: !isBuiltinPlatform(String(row.platform ?? '')),
    // 显式协议; 老数据为空时显示按平台推导出的实际值, 让界面所见即所得
    protocol: resolveProtocol(String(row.platform ?? ''), row.protocol as string),
    protocol_explicit: String(row.protocol ?? '') !== '',
    type: row.type,
    credential_preview: credPreview,
    model_aliases: modelAliases,
    model_index: modelIndex,
    concurrency: row.concurrency,
    load_factor: row.load_factor,
    priority: row.priority,
    rate_multiplier: fromMicro(row.rate_multiplier),
    status: row.status,
    schedulable: row.schedulable === 1,
    base_url: row.base_url,
    entry_path: String(row.entry_path ?? '').trim() || null,
    // 实际生效的上游地址: 配了 base_url 就用它, 否则回落到官方默认域名。
    // 前端「模型获取」页要展示"请求到底打到哪", 光看 base_url 空值会让人以为没配置。
    effective_base_url:
      String(row.base_url ?? '').trim() || defaultBaseUrl(String(row.platform ?? '')) || '',
    group_ids: String(row.group_ids ?? '')
      .split(',')
      .filter(Boolean)
      .map(Number),
    last_used_at: row.last_used_at,
    rate_limited_at: row.rate_limited_at,
    overload_until: row.overload_until,
    last_test_status: row.last_test_status,
    last_test_at: row.last_test_at,
    last_test_message: row.last_test_message,
    created_at: row.created_at,
  };
}

/**
 * 解析账号的凭证 + base_url + 协议, 并给出"列模型"接口的 URL 与请求头。
 *
 * 为什么单独抽出来: 「连通性测试」和「模型获取」发的是同一个请求(GET 模型列表),
 * 只是对结果的解读不同 —— 测试看 HTTP 状态, 获取看返回体的 data[]。
 * 两处各写一遍必然漂移(改了一处忘了另一处), 所以统一走这里。
 *
 * 失败时返回 `{ error }`(已构造好的 Response), 调用方直接 return 即可。
 * 关键约束: base 的取值必须是 `account.base_url?.trim() || defaultBaseUrl(platform)` ——
 * 用户配了第三方中转就以用户配的为准, 官方默认域名只在没配时兜底。反过来会把请求打到
 * 官方域名, 表现为 404/401 甚至 503。
 */
async function resolveAccountEndpoint(
  account: AccountRow,
): Promise<
  | { error: Response }
  | { protocol: string; url: string; headers: Headers; credential: string }
> {
  let creds: Record<string, unknown> = {};
  try {
    creds = JSON.parse(account.credentials || '{}') as Record<string, unknown>;
  } catch {
    creds = {};
  }
  const credential = extractCredential(creds);
  if (!credential) {
    return { error: json({ ok: false, message: 'No credential configured for this account.' }) };
  }

  // 协议驱动: 自定义平台等价于"换个 base_url 的同协议上游"
  const protocol = resolveProtocol(String(account.platform), account.protocol as string);
  const base = account.base_url?.trim() || defaultBaseUrl(String(account.platform));
  if (!base) {
    return {
      error: json({
        ok: false,
        message: `Platform "${account.platform}" has no default domain — please set a base_url first.`,
      }),
    };
  }

  const { applyUpstreamAuth } = await import('./protocol');
  const headers = new Headers();
  let url = '';

  switch (protocol) {
    case 'anthropic':
      url = `${base.replace(/\/+$/, '')}/v1/messages`;
      applyUpstreamAuth(headers, protocol, account.type, credential);
      headers.set('content-type', 'application/json');
      break;
    case 'gemini':
      url = `${base.replace(/\/+$/, '')}/v1beta/models`;
      applyUpstreamAuth(headers, protocol, account.type, credential);
      break;
    default:
      url = `${base.replace(/\/+$/, '')}/v1/models`;
      applyUpstreamAuth(headers, protocol, account.type, credential);
  }

  return { protocol, url, headers, credential };
}

/** 账号连通性测试: 发一个最小请求看凭证是否有效 */
async function testAccount(
  env: Env,
  id: number,
  auth: AdminAuthResult,
  req: Request,
): Promise<Response> {
  const account = await env.DB.prepare(
    `SELECT * FROM accounts WHERE id = ?1 AND deleted_at IS NULL`,
  )
    .bind(id)
    .first<AccountRow>();
  if (!account) return notFound('Account not found');

  const ep = await resolveAccountEndpoint(account);
  if ('error' in ep) return ep.error;
  const { url, headers } = ep;

  const started = Date.now();
  try {
    const res = await fetch(url, { method: 'GET', headers });
    const latency = Date.now() - started;
    const body = (await res.text().catch(() => '')).replace(/\s+/g, ' ').trim().slice(0, 200);

    // 三态判定, 详见下方注释。
    let verdict: 'ok' | 'reachable' | 'failed';
    let msg: string;

    if (res.ok) {
      verdict = 'ok';
      msg = `OK (HTTP ${res.status}, ${latency}ms)` + (body ? ` ${body}` : '');
    } else if (res.status === 400 || res.status === 405) {
      // 400/405: 该上游没有实现 GET /v1/models, 但也没有明确拒绝鉴权。
      // 注意这**不能**证明凭证有效 —— 有些中转(如 chatapi.weixin.qq.com)
      // 无论带不带 key 都返回同一个 400 "missing required parameter: model",
      // 所以这里只能报"可达", 不能报 OK, 否则会给出虚假的安心感。
      verdict = 'reachable';
      msg =
        `Reachable (HTTP ${res.status}, ${latency}ms) — 该上游未实现 GET /v1/models, ` +
        `无法据此判断凭证是否有效, 请用对话接口验证。` +
        (body ? ` 上游响应: ${body}` : '');
    } else {
      verdict = 'failed';
      msg = `Failed (HTTP ${res.status}) ${body}`;
    }

    await env.DB.prepare(
      `UPDATE accounts SET last_test_status=?1, last_test_at=?2, last_test_message=?3 WHERE id=?4`,
    )
      .bind(verdict, new Date().toISOString(), msg.slice(0, 500), id)
      .run();

    await auditLog(env, auth.admin, 'test', 'account', id, msg.slice(0, 200), req);
    // ok 严格表示"2xx, 凭证确实可用"; 不可判定时给 verdict='reachable' 而不是含糊的 ok:true,
    // 避免出现 "ok:true + status:400" 这种自相矛盾的返回。
    return json({ ok: verdict === 'ok', verdict, status: res.status, latency_ms: latency, message: msg });
  } catch (e) {
    const msg = `Network error: ${(e as Error).message}`;
    await env.DB.prepare(
      `UPDATE accounts SET last_test_status='failed', last_test_at=?1, last_test_message=?2 WHERE id=?3`,
    )
      .bind(new Date().toISOString(), msg.slice(0, 500), id)
      .run();
    return json({ ok: false, verdict: 'failed', message: msg });
  }
}

// ============================================================
// 模型获取(拉取上游真实模型列表)
// ============================================================

/**
 * 从上游接口返回体里抽出模型 ID 列表。
 *
 * 上游的返回格式并不统一, 实际见过这几种:
 *   OpenAI    : { data: [{ id: "gpt-4o", ... }, ...] }
 *   Anthropic : { data: [{ id: "claude-...", ... }] }   (同 OpenAI)
 *   Gemini    : { models: [{ name: "models/gemini-2.0-flash", ... }] }
 *   部分中转   : { data: ["gpt-4o", "gpt-4o-mini"] } 或 { models: ["a","b"] }
 * 所以这里逐种格式试, 抽不到就返回空数组(由调用方给出"该上游未实现"的提示),
 * 而不是抛错 —— 拉不到模型列表不该让整个页面 500。
 */
function extractModelIds(payload: unknown): { id: string; raw?: string }[] {
  if (!payload || typeof payload !== 'object') return [];
  const obj = payload as Record<string, unknown>;

  // 取第一个是数组的候选字段
  const list = Array.isArray(obj.data)
    ? obj.data
    : Array.isArray(obj.models)
      ? obj.models
      : Array.isArray(payload)
        ? (payload as unknown[])
        : null;
  if (!list) return [];

  const out: { id: string; raw?: string }[] = [];
  const seen = new Set<string>();
  for (const item of list) {
    let id = '';
    if (typeof item === 'string') {
      id = item.trim();
    } else if (item && typeof item === 'object') {
      const o = item as Record<string, unknown>;
      // Gemini 的 name 形如 "models/gemini-2.0-flash", 去掉前缀才是模型 ID
      const cand = o.id ?? o.name ?? o.model ?? '';
      id = String(cand).trim().replace(/^models\//, '').replace(/^\/+/, '');
    }
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push({ id });
  }
  out.sort((a, b) => a.id.localeCompare(b.id));
  return out;
}

/**
 * 把「模型获取」的结果写进 `accounts.model_index`
 *
 * 为什么必须落库: 网关要靠它做**自动发现路由** —— 请求的模型名(如新版 glm-4.6)
 * 出现在这个列表里, 就会被自动派发到本账号所在平台, 用户无需为此改任何配置。
 *
 * 存空数组也是有效状态("该上游没有模型") —— 用来覆盖上一次的旧列表,
 * 避免账号换了上游之后旧模型名还残留在索引里误导路由。
 */
async function persistModelIndex(
  env: Env,
  accountId: number,
  models: string[],
): Promise<void> {
  try {
    const clean = [...new Set(models.map((m) => String(m ?? '').trim()).filter(Boolean))].sort();
    await env.DB.prepare(
      `UPDATE accounts SET model_index = ?1, updated_at = datetime('now') WHERE id = ?2`,
    )
      .bind(JSON.stringify(clean), accountId)
      .run();
  } catch {
    // 该列可能尚未迁移 —— 退化为"没有索引", 路由回落到路径推断, 不影响正常请求
  }
}

/**
 * GET /accounts/:id/models —— 拉取该上游账号真实提供的模型列表。
 *
 * 和「连通性测试」的区别: 测试只回答"通不通 / 凭证对不对", 这里回答"这个上游到底有哪些模型"。
 * 拿到之后前端可以按「平台名 + 模型 ID」生成别名建议, 用户确认后写回账号的 model_aliases。
 */
async function fetchAccountModels(
  env: Env,
  id: number,
  auth: AdminAuthResult,
  req: Request,
): Promise<Response> {
  const account = await env.DB.prepare(
    `SELECT * FROM accounts WHERE id = ?1 AND deleted_at IS NULL`,
  )
    .bind(id)
    .first<AccountRow>();
  if (!account) return notFound('Account not found');

  const ep = await resolveAccountEndpoint(account);
  if ('error' in ep) return ep.error;
  const { protocol, url, headers } = ep;

  const started = Date.now();
  try {
    const res = await fetch(url, { method: 'GET', headers });
    const latency = Date.now() - started;
    const text = await res.text().catch(() => '');

    if (!res.ok) {
      // 400/405 是"该上游没实现 GET /v1/models", 属于正常现象而非故障, 单独提示。
      const hint =
        res.status === 400 || res.status === 405
          ? '该上游未实现 GET /v1/models, 无法自动获取模型列表 —— 请按官方文档手工填写模型别名。'
          : `上游返回 HTTP ${res.status}。`;
      return json({
        ok: false,
        status: res.status,
        latency_ms: latency,
        models: [],
        message: hint + (text ? ` 上游响应: ${text.replace(/\s+/g, ' ').slice(0, 200)}` : ''),
      });
    }

    let payload: unknown = null;
    try {
      payload = JSON.parse(text);
    } catch {
      return json({
        ok: false,
        status: res.status,
        latency_ms: latency,
        models: [],
        message: '上游返回的不是 JSON, 无法解析模型列表。',
      });
    }

    const models = extractModelIds(payload);
    // 把结果落到 accounts.model_index —— 这是「新模型自动归到中转」的数据来源。
    // 失败不影响本次响应: 拿不到就下次再存, 不该因为写库失败而让用户看不到模型列表。
    const modelIds = models.map((m) => m.id);
    await persistModelIndex(env, id, modelIds);
    await auditLog(
      env,
      auth.admin,
      'list_models',
      'account',
      id,
      `platform=${account.platform} count=${models.length}`,
      req,
    );

    return json({
      ok: true,
      status: res.status,
      latency_ms: latency,
      protocol,
      platform: account.platform,
      base_url: account.base_url || defaultBaseUrl(String(account.platform)),
      models: modelIds,
      message: models.length
        ? `获取到 ${models.length} 个模型(已保存为自动路由索引)。`
        : '请求成功, 但返回体里没有可识别的模型列表。',
    });
  } catch (e) {
    return json({
      ok: false,
      status: 0,
      models: [],
      message: `Network error: ${(e as Error).message}`,
    });
  }
}

// ============================================================
// 用量日志
// ============================================================

/**
 * 失败日志的 model 前缀: error:<platform>:<status>:<message>
 * (见 billing-repo.ts logFailure) —— 成功日志的 model 是真实模型名。
 * 解析出来供前端展示状态与错误原因。
 */
function parseErrorModel(model: unknown): { platform: string; status: number; message: string } | null {
  const m = String(model ?? '');
  if (!m.startsWith('error:')) return null;
  const rest = m.slice(6);
  const i1 = rest.indexOf(':');
  const platform = i1 >= 0 ? rest.slice(0, i1) : rest;
  const rest2 = i1 >= 0 ? rest.slice(i1 + 1) : '';
  const i2 = rest2.indexOf(':');
  const statusStr = i2 >= 0 ? rest2.slice(0, i2) : rest2;
  const message = i2 >= 0 ? rest2.slice(i2 + 1) : '';
  return { platform, status: Number(statusStr) || 0, message };
}

/**
 * 请求日志(用量日志)
 * 对齐上游 admin UsageView: 顶部统计 + 多条件筛选 + 明细(含用户/Key/分组/账号/余额/额度)
 *
 * created_at 有两种写入格式:
 *   - 成功日志: JS toISOString() -> 2026-09-20T03:55:48.000Z
 *   - 失败日志: SQLite datetime('now') -> 2026-09-20 03:55:48
 * 二者字典序不可直接比较, 故按天筛选前先归一化。
 *
 * 两种格式存的都是 **UTC**; 前端展示与「按天筛选」统一按**北京时间 (UTC+8)** 切天,
 * 所以取日期前先 +8 小时 —— 否则北京 00:00~08:00 的日志会被算进前一天。
 */
/**
 * 从请求体里取出待删除的 id 列表。
 *
 * 只认正整数, 自动去重, 并**硬性截断在 500 条** —— 这些 id 会直接拼成
 * `IN (?,?,…)` 的占位符, 无上限的话一次请求就能拼出上万占位符,
 * 撞上 SQLite 的变量上限变成 500 错误, 而不是"删一部分"。
 */
function parseIds(raw: unknown): number[] {
  const arr = Array.isArray(raw) ? raw : [];
  const out: number[] = [];
  const seen = new Set<number>();
  for (const v of arr) {
    const n = Number(v);
    if (!Number.isInteger(n) || n <= 0 || seen.has(n)) continue;
    seen.add(n);
    out.push(n);
    if (out.length >= 500) break;
  }
  return out;
}

/**
 * 请求日志。
 *
 * GET    → 分页 + 筛选列表(非超管强制只看自己, 见下面的 selfScoped)
 * DELETE → **仅超级管理员**可批量删除, 请求体 { ids: number[] }(前端多选/全选来的)
 *
 * 为什么删除要卡 `is_admin`: 'usage' 菜单可以授予给自定义角色(比如"只看自己用量的
 * 代理商")。授权只是"看", 不能顺带把别人的调用记录删掉 —— 那既是越权也是毁证据。
 */
async function getUsage(
  env: Env,
  method: string,
  body: Record<string, unknown>,
  req: Request,
  auth: AdminAuthResult,
): Promise<Response> {
  // ---- 批量删除: 超级管理员专属 ----
  if (method !== 'GET') {
    if (method !== 'DELETE') return badRequest('Unsupported method');
    if (!auth.admin?.is_admin) return forbidden('usage');
    const ids = parseIds(body.ids);
    if (!ids.length) return badRequest('ids is required');

    const ph = ids.map((_, i) => `?${i + 1}`).join(',');
    const res = await env.DB.prepare(`DELETE FROM usage_logs WHERE id IN (${ph})`)
      .bind(...ids)
      .run();
    const deleted = Number((res.meta as { changes?: number } | undefined)?.changes ?? 0);
    // 删日志这个动作本身必须留痕, 否则"谁把记录清了"就无从查起
    await auditLog(
      env, auth.admin, 'delete', 'usage_logs',
      `${ids.length} ids`, JSON.stringify(ids).slice(0, 300), req,
    );
    return json({ ok: true, deleted });
  }

  const url = new URL(req.url);
  const limit = intParam(url, 'limit', 50, 1, 200);
  const offset = intParam(url, 'offset', 0, 0, Number.MAX_SAFE_INTEGER);
  const g = (k: string): string => (url.searchParams.get(k) ?? '').trim();

  const apiKeyId = g('api_key_id');
  const userId = g('user_id');
  const accountId = g('account_id');
  const groupId = g('group_id');
  const model = g('model');
  const status = g('status'); // success | error
  const start = g('start'); // YYYY-MM-DD
  const end = g('end'); // YYYY-MM-DD
  const keyword = g('keyword');

  const where: string[] = [];
  const binds: unknown[] = [];

  /**
   * 非超管**强制只看自己的调用记录**。
   *
   * 为什么必须在这里兜一层: 'usage' 菜单是可以被授予给自定义角色的(比如"只看自己
   * 用量的代理商")。如果此时仍然回全站日志, 那"给了 usage 菜单"就等于泄露了所有
   * 用户的请求明细 —— 前端筛选条件改一下就能看到别人。所以用户 id 直接由**会话**
   * 决定, 请求体里的 user_id 对非超管一律忽略。
   */
  const selfScoped = !auth.admin?.is_admin;
  const selfId = auth.admin?.id ?? 0;
  /**
   * 追加一个筛选条件。
   * SQL 里写裸 `?` 占位, 编号由本函数按"当前绑定数 + 序号"统一生成 ——
   * 若手写 `?${binds.length + 1}`, 一条 SQL 里出现多个占位符时会全部拿到
   * 同一个编号, 触发 D1 "Wrong number of parameter bindings"。
   */
  const cond = (sql: string, ...vals: unknown[]): void => {
    const parts = sql.split('?');
    if (parts.length - 1 !== vals.length) {
      throw new Error(
        `placeholder/binding mismatch (${parts.length - 1} vs ${vals.length}): ${sql}`,
      );
    }
    let expr = parts[0];
    for (let i = 0; i < vals.length; i++) {
      expr += `?${binds.length + 1 + i}${parts[i + 1] ?? ''}`;
    }
    where.push(expr);
    binds.push(...vals);
  };

  if (apiKeyId) cond('l.api_key_id = ?', Number(apiKeyId));
  if (selfScoped) cond('l.user_id = ?', selfId);
  else if (userId) cond('l.user_id = ?', Number(userId));
  if (accountId) cond('l.account_id = ?', Number(accountId));
  if (groupId) cond('l.group_id = ?', Number(groupId));
  if (model) cond('l.model = ?', model);
  if (status === 'error') where.push(`l.model LIKE 'error:%'`);
  else if (status === 'success') where.push(`l.model NOT LIKE 'error:%'`);

  // 归一化 created_at 后按天比较(两种格式统一成 YYYY-MM-DD HH:MM:SS),
  // 并整体 +8 小时 —— 让「天」的边界落在北京时间零点。
  const dayExpr = `date(replace(substr(l.created_at, 1, 19), 'T', ' '), '+8 hours')`;
  if (start) cond(`${dayExpr} >= ?`, start);
  if (end) cond(`${dayExpr} <= ?`, end);
  if (keyword) {
    const kw = `%${keyword}%`;
    cond(
      '(l.request_id LIKE ? OR u.email LIKE ? OR k.name LIKE ? OR l.model LIKE ?)',
      kw,
      kw,
      kw,
      kw,
    );
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const fromSql = `FROM usage_logs l
       LEFT JOIN users u ON u.id = l.user_id
       LEFT JOIN api_keys k ON k.id = l.api_key_id
       LEFT JOIN accounts a ON a.id = l.account_id
       LEFT JOIN groups g ON g.id = l.group_id`;

  // 主查询的 LIMIT/OFFSET 占位符接在 where 之后, 与 cond() 用同一套编号规则
  const limitPh = `?${binds.length + 1}`;
  const offsetPh = `?${binds.length + 2}`;

  const wantFacets = url.searchParams.get('facets') === '1';

  const baseQueries: PromiseLike<any>[] = [
    env.DB.prepare(
      `SELECT l.*,
              u.email AS user_email, u.username AS user_name,
              u.balance AS user_balance, u.status AS user_status,
              k.name AS key_name, k.quota AS key_quota, k.quota_used AS key_quota_used, k.status AS key_status,
              a.name AS account_name, a.platform AS account_platform,
              g.name AS group_name
       ${fromSql} ${whereSql}
       ORDER BY l.id DESC LIMIT ${limitPh} OFFSET ${offsetPh}`,
    )
      .bind(...binds, limit, offset)
      .all<Record<string, unknown>>(),

    env.DB.prepare(`SELECT COUNT(*) AS c ${fromSql} ${whereSql}`)
      .bind(...binds)
      .first<{ c: number }>(),

    env.DB.prepare(
      `SELECT
         COUNT(*) AS total,
         SUM(CASE WHEN l.model LIKE 'error:%' THEN 1 ELSE 0 END) AS errors,
         COALESCE(SUM(l.input_tokens), 0)  AS input_tokens,
         COALESCE(SUM(l.output_tokens), 0) AS output_tokens,
         COALESCE(SUM(l.cache_read_tokens), 0) AS cache_read_tokens,
         COALESCE(SUM(l.cache_creation_tokens), 0) AS cache_creation_tokens,
         COALESCE(SUM(l.total_cost), 0)  AS total_cost,
         COALESCE(SUM(l.actual_cost), 0) AS actual_cost,
         COALESCE(AVG(CASE WHEN l.model NOT LIKE 'error:%' THEN l.duration_ms END), 0) AS avg_duration_ms,
         COALESCE(AVG(CASE WHEN l.model NOT LIKE 'error:%' THEN l.first_token_ms END), 0) AS avg_first_token_ms,
         COALESCE(SUM(CASE WHEN l.stream = 1 THEN 1 ELSE 0 END), 0) AS stream_requests
       ${fromSql} ${whereSql}`,
    )
      .bind(...binds)
      .first<Record<string, number>>(),
  ];

  if (wantFacets) {
    // 过滤下拉的候选值(与筛选条件无关, 只在首次加载时取一次)
    baseQueries.push(
      env.DB.prepare(
        `SELECT model, COUNT(*) AS c FROM usage_logs
         WHERE model NOT LIKE 'error:%' AND model <> ''
         GROUP BY model ORDER BY c DESC LIMIT 200`,
      ).all<Record<string, unknown>>(),
      env.DB.prepare(
        `SELECT id, email, username, balance, status FROM users
         WHERE deleted_at IS NULL ORDER BY id ASC LIMIT 1000`,
      ).all<Record<string, unknown>>(),
      env.DB.prepare(
        `SELECT id, name, user_id FROM api_keys
         WHERE deleted_at IS NULL ORDER BY id DESC LIMIT 1000`,
      ).all<Record<string, unknown>>(),
      env.DB.prepare(
        `SELECT id, name, platform FROM groups
         WHERE deleted_at IS NULL ORDER BY sort_order ASC, id ASC LIMIT 500`,
      ).all<Record<string, unknown>>(),
      env.DB.prepare(
        `SELECT id, name, platform FROM accounts
         WHERE deleted_at IS NULL ORDER BY priority ASC, id ASC LIMIT 500`,
      ).all<Record<string, unknown>>(),
    );
  }

  const results = await Promise.all(baseQueries);
  const rows = results[0] as { results?: Record<string, unknown>[] };
  const totalRow = results[1] as { c?: number } | null;
  const statsRow = results[2] as Record<string, number> | null;

  const total = Number(totalRow?.c ?? 0);
  const errors = Number(statsRow?.errors ?? 0);
  const success = Math.max(total - errors, 0);

  const logs = (rows.results ?? []).map((r) => {
    const rawModel = String(r.model ?? '');
    const err = parseErrorModel(rawModel);
    return {
      id: r.id,
      request_id: r.request_id,
      // ---- 用户 ----
      user_id: r.user_id,
      user_email: r.user_email ?? null,
      user_name: r.user_name ?? null,
      user_balance: r.user_balance == null ? null : fromMicro(r.user_balance),
      user_status: r.user_status ?? null,
      // ---- API Key ----
      api_key_id: r.api_key_id,
      key_name: r.key_name ?? null,
      key_quota: r.key_quota == null ? null : fromMicro(r.key_quota),
      key_quota_used: r.key_quota_used == null ? null : fromMicro(r.key_quota_used),
      key_status: r.key_status ?? null,
      // ---- 账号 / 分组 ----
      account_id: r.account_id,
      account_name: r.account_name ?? null,
      account_platform: r.account_platform ?? null,
      group_id: r.group_id,
      group_name: r.group_name ?? null,
      // ---- 模型 ----
      model: err ? '' : rawModel,
      requested_model: r.requested_model,
      upstream_model: r.upstream_model,
      billing_mode: r.billing_mode,
      // ---- 状态 ----
      status: err ? 'error' : 'success',
      error: err,
      // ---- token / 费用 ----
      input_tokens: r.input_tokens,
      output_tokens: r.output_tokens,
      cache_read_tokens: r.cache_read_tokens,
      cache_creation_tokens: r.cache_creation_tokens,
      total_cost: fromMicro(r.total_cost),
      actual_cost: fromMicro(r.actual_cost),
      rate_multiplier: fromMicro(r.rate_multiplier),
      account_rate_multiplier: fromMicro(r.account_rate_multiplier),
      // ---- 其他 ----
      stream: r.stream === 1,
      duration_ms: r.duration_ms,
      first_token_ms: r.first_token_ms,
      user_agent: r.user_agent,
      ip_address: r.ip_address,
      created_at: r.created_at,
    };
  });

  const payload: Record<string, unknown> = {
    total,
    limit,
    offset,
    stats: {
      total,
      errors,
      success,
      success_rate: total > 0 ? success / total : 0,
      input_tokens: Number(statsRow?.input_tokens ?? 0),
      output_tokens: Number(statsRow?.output_tokens ?? 0),
      cache_read_tokens: Number(statsRow?.cache_read_tokens ?? 0),
      cache_creation_tokens: Number(statsRow?.cache_creation_tokens ?? 0),
      total_tokens:
        Number(statsRow?.input_tokens ?? 0) + Number(statsRow?.output_tokens ?? 0),
      total_cost: fromMicro(statsRow?.total_cost),
      actual_cost: fromMicro(statsRow?.actual_cost),
      avg_duration_ms: Math.round(Number(statsRow?.avg_duration_ms ?? 0)),
      avg_first_token_ms: Math.round(Number(statsRow?.avg_first_token_ms ?? 0)),
      stream_requests: Number(statsRow?.stream_requests ?? 0),
    },
    logs,
  };

  if (wantFacets) {
    const modelRows = results[3] as { results?: Record<string, unknown>[] };
    const userRows = results[4] as { results?: Record<string, unknown>[] };
    const keyRows = results[5] as { results?: Record<string, unknown>[] };
    const groupRows = results[6] as { results?: Record<string, unknown>[] };
    const accountRows = results[7] as { results?: Record<string, unknown>[] };
    payload.filters = {
      models: (modelRows.results ?? []).map((m) => m.model),
      users: (userRows.results ?? []).map((u) => ({
        id: u.id,
        email: u.email,
        username: u.username,
        balance: fromMicro(u.balance),
        status: u.status,
      })),
      keys: (keyRows.results ?? []).map((k) => ({ id: k.id, name: k.name, user_id: k.user_id })),
      groups: (groupRows.results ?? []).map((x) => ({ id: x.id, name: x.name, platform: x.platform })),
      accounts: (accountRows.results ?? []).map((x) => ({ id: x.id, name: x.name, platform: x.platform })),
    };
  }

  return json(payload);
}

// ============================================================
// 审计日志
// ============================================================

/**
 * 操作审计日志(分页)
 *
 * 与 /usage 同一套 limit/offset 约定, 并且**必须回传 total** ——
 * 前端要靠它算页数: 没有 total 就只能"下一頁永远可点", 一直点到空页。
 * 排序固定 id DESC(等价于时间倒序): id 是自增主键, 不受 created_at
 * 两种写入格式(带 Z / 不带后缀)的影响, 翻页时也不会因为时间相同的行而错位。
 */
// ============================================================
// 公告管理
// ============================================================
//
// 数据落在独立的 `announcements` 表(见 schema/schema-announcements.sql), **一条一行**。
// 老的 settings.announcement 单字符串只当"历史遗留"只读回落 —— 见 getLiveAnnouncements。
//
// 两条访问路径, 权限完全不同, 别混淆:
//   1. GET /api/admin/announcements        → 任何**登录用户**可读, 只回已发布内容
//      (在 handleAdminApi 的菜单闸门**之前**分发, 见那里的注释);
//   2. /api/admin/announcements[/<id>] 的其余方法 → 走「公告管理」菜单权限, 增删改。
//
// 用户侧的两个入口(登录后自动弹窗 / 顶栏「公告」按钮)都只读第 1 条, 拿到的是
// 已发布公告 + 一个 `revision` 版本号; 前端把它记进 localStorage, 于是
// "公告没改就不再打扰"这件事由前端判, 后端只负责给出诚实的版本号。

/** 公告状态取值。只认这两个 —— 别的值一律按 draft 处理(存不住、也看不见)。 */
const ANNOUNCE_STATUS = { published: 'published', draft: 'draft' } as const;

/** 单条公告的长度上限。挡的是"手抖粘贴一整个文件", 不是严谨的内容审核。 */
const ANNOUNCE_MAX_TITLE = 200;
const ANNOUNCE_MAX_CONTENT = 20000;

/** 老公告键 —— 只在 announcements 表一条已发布的都没有时才回落到它。 */
const LEGACY_ANNOUNCEMENT_KEY = 'announcement';

type AnnounceRow = {
  id: number;
  title: string;
  content: string;
  status: string;
  pinned: number;
  revision: number;
  created_at: string;
  updated_at: string;
};

/** 公告行的对外投影 —— 统一字段名与类型, 别把库里的 snake_case 直接漏出去 */
function announceOut(r: AnnounceRow) {
  return {
    id: Number(r.id),
    title: String(r.title ?? ''),
    content: String(r.content ?? ''),
    status: String(r.status ?? ANNOUNCE_STATUS.draft),
    pinned: Number(r.pinned ?? 0) ? 1 : 0,
    revision: Number(r.revision ?? 1),
    created_at: String(r.created_at ?? ''),
    updated_at: String(r.updated_at ?? ''),
  };
}

/**
 * 已发布公告 —— **用户侧唯一的数据来源**(登录弹窗 + 顶栏按钮)。
 *
 * 顺序: 表里有已发布的就用表里的; 一条都没有才回落到 settings.announcement,
 * 把它当成"只有正文、没有标题"的一条历史公告。回落**只是读**, 不写库、不迁移。
 *
 * `version` 是这批公告的**聚合版本号**: 取每条 content_revision 与 id 拼成的字符串
 * 的稳定签名。前端拿它当"已读标记", 于是:
 *   - 改标题/正文(revision+1) → version 变 → 重新弹一次;
 *   - 新增一条 → 多一段签名 → version 变 → 重新弹;
 *   - 只改状态/只排序 → version 不变 → 不打扰。
 */
async function getLiveAnnouncements(env: Env): Promise<Response> {
  const rows = await env.DB.prepare(
    `SELECT id, title, content, status, pinned, revision, created_at, updated_at
       FROM announcements
      WHERE deleted_at IS NULL AND status = 'published'
      ORDER BY pinned DESC, id DESC`,
  ).all<AnnounceRow>();

  let items = (rows.results ?? []).map(announceOut);

  // 表里没有任何已发布公告 → 回落到老键(纯读, 不写回库)
  if (items.length === 0) {
    const legacy = await env.DB.prepare(`SELECT value FROM settings WHERE key = ?1`)
      .bind(LEGACY_ANNOUNCEMENT_KEY)
      .first<{ value: string }>()
      .catch(() => null);
    const text = String(legacy?.value ?? '').trim();
    if (text) {
      // 用 id 0 + 固定 revision 1 代表这条虚拟公告 —— 老公告没有版本概念,
      // 把它当"永不改变的一条"即可(它确实也不会自己变)。
      items = [
        {
          id: 0,
          title: '',
          content: text,
          status: ANNOUNCE_STATUS.published,
          pinned: 0,
          revision: 1,
          created_at: '',
          updated_at: '',
        },
      ];
    }
  }

  // 聚合版本签名。用 id:revision 依次拼接 —— 任何一条内容变了签名就变。
  const version = items.length ? items.map((a) => a.id + ':' + a.revision).join(',') : '';

  return json({ announcements: items, total: items.length, version });
}

/**
 * 公告增删改 —— 挂「公告管理」菜单权限(见 MENUS_BY_RESOURCE.announcements)。
 *
 * 全部写操作都走这里, 所以三件事集中在一处保证:
 *   1. **改标题或正文才 revision += 1** —— 只切状态/只置顶不该触发用户的自动弹窗;
 *   2. **删除是软删**(deleted_at), 且按 id 精确删, changes===0 返回 404;
 *   3. **每次写都记审计**, 但详情里不塞全文(公告可能很长, 审计表不是内容仓库)。
 *
 * 路由(注意 `parts` 已经是去掉 /api/admin 前缀后的段数组):
 *   GET  /announcements/all   -> 管理列表(**含草稿**)。与用户侧那条 GET 区分开,
 *                                否则草稿会在管理页凭空消失(它们被 published 过滤掉了)。
 *   POST /announcements       -> 新建
 *   PUT  /announcements/<id>  -> 更新
 *   DEL  /announcements/<id>  -> 软删
 */
async function handleAnnouncements(
  env: Env,
  method: string,
  id: number | null,
  body: Record<string, unknown>,
  auth: AdminAuthResult,
  req: Request,
  parts: string[],
): Promise<Response> {
  // ---- 列表: 管理视角, **含草稿**(用户侧那条 GET 只回已发布) ----
  if (method === 'GET') {
    // 只认 /announcements/all —— 裸 /announcements 的 GET 已被上面的公开分支截走
    if (parts[1] !== 'all') return badRequest('用法: GET /announcements/all');
    const rows = await env.DB.prepare(
      `SELECT id, title, content, status, pinned, revision, created_at, updated_at
         FROM announcements
        WHERE deleted_at IS NULL
        ORDER BY pinned DESC, id DESC`,
    ).all<AnnounceRow>();
    return json({ announcements: (rows.results ?? []).map(announceOut) });
  }

  // ---- 创建 ----
  if (method === 'POST') {
    const title = String(body.title ?? '').trim();
    const content = String(body.content ?? '');
    if (!title) return badRequest('请填写公告标题。');
    if (title.length > ANNOUNCE_MAX_TITLE) {
      return badRequest(`标题最多 ${ANNOUNCE_MAX_TITLE} 个字符。`);
    }
    if (!content.trim()) return badRequest('请填写公告详情。');
    if (content.length > ANNOUNCE_MAX_CONTENT) {
      return badRequest(`公告详情最多 ${ANNOUNCE_MAX_CONTENT} 个字符。`);
    }
    // 状态白名单: 传别的值(或没传)一律当草稿 —— fail-safe, 宁可不发也不误发。
    const status = body.status === ANNOUNCE_STATUS.published
      ? ANNOUNCE_STATUS.published
      : ANNOUNCE_STATUS.draft;
    const pinned = body.pinned ? 1 : 0;
    const now = new Date().toISOString();

    const res = await env.DB.prepare(
      `INSERT INTO announcements (title, content, status, pinned, revision, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, 1, ?5, ?5)`,
    )
      .bind(title, content, status, pinned, now)
      .run();
    const newId = Number(res.meta?.last_row_id ?? 0);
    await auditLog(env, auth.admin, 'create', 'announcement', newId,
      `title=${title.slice(0, 80)} status=${status}`, req);
    return json({ ok: true, id: newId });
  }

  // 以下都是"针对某一条"的操作 —— 必须给合法 id
  if (id === null || !Number.isInteger(id) || id <= 0) {
    return badRequest('缺少公告 id。');
  }
  const existing = await env.DB.prepare(
    `SELECT id, title, content, status, pinned, revision FROM announcements
      WHERE id = ?1 AND deleted_at IS NULL`,
  )
    .bind(id)
    .first<AnnounceRow>();
  if (!existing) return notFound('公告不存在或已被删除。');

  // ---- 更新 ----
  if (method === 'PUT' || method === 'PATCH') {
    // 字段级合并: **没传的字段保持原值**。与 accounts 的 model_aliases"整表替换"
    // 语义相反 —— 公告表单是完整表单, 但接口仍按合并写, 免得将来做"只置顶"这类
    // 局部操作时又把标题清空一次。
    const hasTitle = body.title !== undefined;
    const hasContent = body.content !== undefined;
    const title = hasTitle ? String(body.title ?? '').trim() : existing.title;
    const content = hasContent ? String(body.content ?? '') : existing.content;
    if (hasTitle && !title) return badRequest('请填写公告标题。');
    if (title.length > ANNOUNCE_MAX_TITLE) {
      return badRequest(`标题最多 ${ANNOUNCE_MAX_TITLE} 个字符。`);
    }
    if (hasContent && !content.trim()) return badRequest('请填写公告详情。');
    if (content.length > ANNOUNCE_MAX_CONTENT) {
      return badRequest(`公告详情最多 ${ANNOUNCE_MAX_CONTENT} 个字符。`);
    }
    const status = body.status === ANNOUNCE_STATUS.published
      ? ANNOUNCE_STATUS.published
      : body.status === ANNOUNCE_STATUS.draft
        ? ANNOUNCE_STATUS.draft
        : existing.status;
    const pinned = body.pinned === undefined ? Number(existing.pinned ?? 0) ? 1 : 0 : (body.pinned ? 1 : 0);

    // 🚨 revision 只跟着**内容**走: 标题或正文真的变了才 +1。
    // 用 upsert 那套"每次都写"会误触发所有用户的自动弹窗(改个置顶就全员弹一次)。
    const contentChanged = (hasTitle && title !== existing.title) || (hasContent && content !== existing.content);
    const revision = Number(existing.revision ?? 1) + (contentChanged ? 1 : 0);
    const now = new Date().toISOString();

    await env.DB.prepare(
      `UPDATE announcements
          SET title = ?1, content = ?2, status = ?3, pinned = ?4, revision = ?5, updated_at = ?6
        WHERE id = ?7 AND deleted_at IS NULL`,
    )
      .bind(title, content, status, pinned, revision, now, id)
      .run();

    await auditLog(env, auth.admin, 'update', 'announcement', id,
      `title=${title.slice(0, 80)} status=${status} revision=${revision}` +
        (contentChanged ? ' content_changed=1' : ''), req);
    return json({ ok: true, revision });
  }

  // ---- 删除(软删) ----
  if (method === 'DELETE') {
    const res = await env.DB.prepare(
      `UPDATE announcements SET deleted_at = ?1 WHERE id = ?2 AND deleted_at IS NULL`,
    )
      .bind(new Date().toISOString(), id)
      .run();
    if (Number(res.meta?.changes ?? 0) === 0) return notFound('公告不存在或已被删除。');
    await auditLog(env, auth.admin, 'delete', 'announcement', id, `title=${String(existing.title).slice(0, 80)}`, req);
    return json({ ok: true });
  }

  return badRequest('Unsupported method');
}

/**
 * 操作审计。
 *
 * GET    → 分页列表(非超管只看自己做过的事, 见下面的 scoped)
 * DELETE → **仅超级管理员**可批量删除, 请求体 { ids: number[] }
 *
 * ⚠️ 审计日志被删本身就是一件该被记录的事, 所以删除动作会**再写一条审计**。
 * 也就是说: 删完不是"什么都没了", 至少留下"某超管在某个时刻删了 N 条"这条痕。
 */
async function getAudit(
  env: Env,
  method: string,
  body: Record<string, unknown>,
  req: Request,
  auth: AdminAuthResult,
): Promise<Response> {
  // ---- 批量删除: 超级管理员专属 ----
  if (method !== 'GET') {
    if (method !== 'DELETE') return badRequest('Unsupported method');
    if (!auth.admin?.is_admin) return forbidden('audit');
    const ids = parseIds(body.ids);
    if (!ids.length) return badRequest('ids is required');

    const ph = ids.map((_, i) => `?${i + 1}`).join(',');
    const res = await env.DB.prepare(`DELETE FROM admin_audit_logs WHERE id IN (${ph})`)
      .bind(...ids)
      .run();
    const deleted = Number((res.meta as { changes?: number } | undefined)?.changes ?? 0);
    await auditLog(
      env, auth.admin, 'delete', 'admin_audit_logs',
      `${ids.length} ids`, JSON.stringify(ids).slice(0, 300), req,
    );
    return json({ ok: true, deleted });
  }

  const url = new URL(req.url);
  const limit = intParam(url, 'limit', 50, 1, 200);
  const offset = intParam(url, 'offset', 0, 0, Number.MAX_SAFE_INTEGER);

  // 与 /usage 同理: 审计日志里带着「谁改了哪个用户 / 哪个账号」的完整操作细节,
  // 非超管只该看到自己做过的事。'audit' 菜单若被授予出去, 这里就是那道闸门。
  const scoped = !auth.admin?.is_admin;
  const whereSql = scoped ? 'WHERE admin_id = ?3' : '';
  const binds: unknown[] = scoped ? [limit, offset, auth.admin?.id ?? 0] : [limit, offset];
  const countBinds: unknown[] = scoped ? [auth.admin?.id ?? 0] : [];

  const [rows, totalRow] = await Promise.all([
    env.DB.prepare(
      `SELECT * FROM admin_audit_logs ${whereSql} ORDER BY id DESC LIMIT ?1 OFFSET ?2`,
    )
      .bind(...binds)
      .all<Record<string, unknown>>(),
    env.DB.prepare(
      `SELECT COUNT(*) AS c FROM admin_audit_logs ${scoped ? 'WHERE admin_id = ?1' : ''}`,
    )
      .bind(...countBinds)
      .first<{ c: number }>(),
  ]);

  return json({
    logs: rows.results ?? [],
    total: totalRow?.c ?? 0,
    limit,
    offset,
  });
}

// ============================================================
// 公开注册
// ============================================================
//
// 与登录一样是**公开**接口(不需要会话)。三条安全硬约束:
//   1. **特权字段一律服务端决定** —— 请求体只认 email / username / password。
//      role 硬编码 'user'、balance 0、platform_access 空。漏一处 ⇒ 传 role='admin'
//      就能注册出管理员, 而网关对 admin **跳过余额检查**(index.ts), 等于白送上游额度。
//   2. **开关在服务端** —— registration_enabled / registration_auto_approve 走 settings 表,
//      关掉后接口直接 403。前端把链接藏起来只是体验, 不算数。
//   3. **邮箱唯一** —— 先查一次给友好提示, 真正兜底的是 idx_users_email_live 部分唯一索引。

/** 邮箱校验。**不要求域名带点** —— 本项目存量账号就是 admin@local 这种内网写法 */
const REGISTER_EMAIL_RE = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)*$/;

/** 注册开关的设置键(后台「设置」页可改, 不用重新部署) */
export const REGISTRATION_SETTING = 'registration_enabled';
export const AUTO_APPROVE_SETTING = 'registration_auto_approve';

/**
 * 开关解析。**只有显式 'false' 才算关** —— 键不存在/空串一律按默认值走。
 * 与门户时期同一套语义: 部署新代码时老库里没有这个键, 不该因为"读到空"就把入口锁死。
 */
function settingOn(raw: string | null, def = true): boolean {
  if (raw === null || String(raw).trim() === '') return def;
  return String(raw).trim().toLowerCase() !== 'false';
}

/** 公开的注册配置 —— 注册页据此决定能不能注册、密码下限多少、要不要 Turnstile(前端不硬编码) */
export async function getRegisterConfig(env: Env): Promise<{
  enabled: boolean;
  auto_approve: boolean;
  min_password_length: number;
  turnstile_site_key: string;
  /** Turnstile 配置了才要求验证码(否则前端隐藏验证码区, 保持旧注册流程) */
  verification_required: boolean;
}> {
  const turnstileConfigured = isTurnstileConfigured(env);
  return {
    enabled: settingOn(await readSetting(env, REGISTRATION_SETTING)),
    auto_approve: settingOn(await readSetting(env, AUTO_APPROVE_SETTING)),
    min_password_length: MIN_PASSWORD_LENGTH,
    turnstile_site_key: turnstileConfigured
      ? String((env as unknown as Record<string, string>)['TURNSTILE_SITE_KEY'] ?? '').trim()
      : '',
    verification_required: turnstileConfigured,
  };
}

export async function handleRegister(
  env: Env,
  body: Record<string, unknown>,
  req: Request,
): Promise<Response> {
  if (!settingOn(await readSetting(env, REGISTRATION_SETTING))) {
    return json(
      { error: { message: '管理员已关闭注册, 请联系管理员开通账号。', type: 'forbidden' } },
      403,
    );
  }

  const email = String(body.email ?? '').trim().toLowerCase();
  const username = String(body.username ?? '').trim();
  const password = String(body.password ?? '');
  const verifyCodeInput = String(body.verify_code ?? '');
  const turnstileToken = String(body.turnstile_token ?? '');

  if (!email) return badRequest('请填写邮箱。');
  if (!REGISTER_EMAIL_RE.test(email)) return badRequest('邮箱格式不正确。');
  if (email.length > 190) return badRequest('邮箱过长。');
  if (username.length > 64) return badRequest('用户名最多 64 个字符。');
  if (password.length < MIN_PASSWORD_LENGTH) {
    return badRequest(`密码至少 ${MIN_PASSWORD_LENGTH} 位。`);
  }

  // ---- Turnstile 服务端校验(配置了才强制; Token B, action=register) ----
  // 与"发送验证码"的 Token A 必须不同 —— 一次 Turnstile Token 只能用一次,
  // 且 action 隔离, 防止用发码的 token 直接注册。
  const turnstileConfigured = isTurnstileConfigured(env);
  if (turnstileConfigured) {
    const v = await verifyTurnstile(env, turnstileToken, 'register', req);
    if (!v.passed) {
      return json(
        { error: { message: '人机验证未通过，请刷新后重试。', type: 'forbidden' } },
        403,
      );
    }

    // 配置了 Turnstile 必然要求验证码(Token B 校验通过只是人机, 邮箱归属还要验证码)
    if (!verifyCodeInput) {
      return badRequest('请填写邮箱验证码。');
    }
    const vc = await verifyCode(env, email, 'REGISTER', verifyCodeInput);
    if (!vc.ok) {
      return json({ error: { message: vc.message, type: 'invalid_request_error' } }, vc.status);
    }
  }

  const exists = await env.DB.prepare(
    `SELECT id FROM users WHERE deleted_at IS NULL AND email = ?1 COLLATE NOCASE LIMIT 1`,
  )
    .bind(email)
    .first<{ id: number }>();
  if (exists) {
    return json({ error: { message: '该邮箱已注册, 请直接登录。', type: 'conflict' } }, 409);
  }

  const autoApprove = settingOn(await readSetting(env, AUTO_APPROVE_SETTING));
  const hash = await hashPassword(password);

  // 注意 VALUES 里 role 是**字面量 'user'**, 不是绑定参数 —— 让"不可提权"这件事
  // 在 SQL 文本上就一眼可见, 将来谁想加个 role 参数也会先看到这行注释。
  const res = await env.DB.prepare(
    `INSERT INTO users (email, password_hash, role, balance, concurrency, rpm_limit, status, username, notes, platform_access)
     VALUES (?1, ?2, 'user', 0, 5, 0, ?3, ?4, '', '')`,
  )
    .bind(email, hash, autoApprove ? 'active' : 'disabled', username || email)
    .run();

  const newId = Number(res.meta?.last_row_id ?? 0);
  await auditLog(
    env,
    { id: newId, name: 'register:' + email },
    'create',
    'user',
    newId,
    autoApprove ? '自助注册(直接可用)' : '自助注册(待审核)',
    req,
  );

  return json({
    ok: true,
    id: newId,
    auto_approved: autoApprove,
    message: autoApprove
      ? '注册成功, 请登录。'
      : '注册成功, 请等管理员审核后再登录。',
  });
}

// ============================================================
// 系统设置 / 修改管理员密码
// ============================================================

async function handleSettings(
  env: Env,
  method: string,
  body: Record<string, unknown>,
  auth: AdminAuthResult,
  req: Request,
): Promise<Response> {
  if (method === 'GET') {
    const rows = await env.DB.prepare(`SELECT key, value FROM settings`).all<{
      key: string;
      value: string;
    }>();
    const settings: Record<string, string> = {};
    for (const r of rows.results ?? []) settings[r.key] = r.value;

    // 「当前账号」来自 users —— 统一登录之后后台没有第二张账号表了。
    // 只用会话里的 id 查, 不接受任何客户端传入的 id(否则就是一个"看别人资料"的接口)。
    const me = await env.DB.prepare(
      `SELECT id, username, email, role, status, last_login_at FROM users
        WHERE id = ?1 AND deleted_at IS NULL`,
    )
      .bind(auth.admin?.id ?? 0)
      .first<Record<string, unknown>>();

    return json({
      settings,
      admin: me
        ? {
            id: me.id,
            username: String(me.username || me.email || ''),
            email: me.email,
            role: auth.admin?.role ?? me.role,
            role_name: auth.admin?.role_name ?? '',
            last_login_at: me.last_login_at,
          }
        : null,
      // 只读运行时配置
      runtime: {
        api_key_prefix: (env as unknown as Record<string, string>)['API_KEY_PREFIX'] ?? 'sk-',
        cors_allowed_origins: (env as unknown as Record<string, string>)['CORS_ALLOWED_ORIGINS'] ?? '*',
        enforce_balance: (env as unknown as Record<string, string>)['ENFORCE_BALANCE'] ?? 'true',
      },
    });
  }

  if (method === 'PUT') {
    // 修改密码 —— 改的永远是**当前登录账号自己**那一行。
    // 注意这里没有"给谁改"的参数: 管理员要重置别人的密码请用「用户管理」页的编辑弹窗,
    // 那条路径会写审计日志且不区分角色。
    if (body.new_password) {
      const newPwd = String(body.new_password);
      if (newPwd.length < MIN_PASSWORD_LENGTH) {
        return badRequest(`Password must be at least ${MIN_PASSWORD_LENGTH} characters`);
      }
      const meId = auth.admin?.id ?? 0;
      const hash = await hashPassword(newPwd);
      await env.DB.prepare(
        `UPDATE users SET password_hash = ?1, updated_at = ?2 WHERE id = ?3 AND deleted_at IS NULL`,
      )
        .bind(hash, new Date().toISOString(), meId)
        .run();
      await auditLog(env, auth.admin, 'update', 'own_password', meId, '', req);
      return json({ ok: true, message: 'Password updated.' });
    }

    // 修改普通设置
    if (body.settings && typeof body.settings === 'object') {
      const entries = Object.entries(body.settings as Record<string, unknown>);
      for (const [k, v] of entries) {
        await env.DB.prepare(
          `INSERT INTO settings (key, value, updated_at) VALUES (?1, ?2, ?3)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
        )
          .bind(k, String(v), new Date().toISOString())
          .run();
      }
      await auditLog(env, auth.admin, 'update', 'settings', '', JSON.stringify(body.settings).slice(0, 300), req);
      return json({ ok: true });
    }

    return badRequest('Nothing to update');
  }

  return badRequest('Unsupported method');
}

// ============================================================
// 模型定价
// ============================================================

/** 非负数值, 非法一律 0 */
function nonNegNumber(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** 把请求里的一条定价规整成可写库的行; model 为空则丢弃; account_id 缺省为 0(全局) */
function normalizePricingRow(
  raw: unknown,
): { account_id: number; model: string; input_price: number; output_price: number; cache_read_price: number; cache_creation_price: number } | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const model = String(o.model ?? '').trim();
  if (!model) return null;
  const rawAcct = Number(o.account_id ?? 0);
  const account_id = Number.isInteger(rawAcct) && rawAcct > 0 ? rawAcct : 0;
  return {
    account_id,
    model,
    input_price: nonNegNumber(o.input_price),
    output_price: nonNegNumber(o.output_price),
    cache_read_price: nonNegNumber(o.cache_read_price),
    cache_creation_price: nonNegNumber(o.cache_creation_price),
  };
}

/**
 * 模型定价 —— **整个网关唯一的计费价格来源**。
 *
 * 用户要求「API 请求花费严格走这边的定价」，所以这里配的就是最终生效的价：
 *   GET    /api/admin/models   → 逐模型定价表 + 「默认单价」(没单独配价的模型走它)
 *   PUT    /api/admin/models   → 单条 { model, … } / 批量 { models: [ … ] } / 默认价 { default_price }
 *   DELETE /api/admin/models   → 单条 { model } / 批量 { models: [ … ] }
 *
 * 🚨 分组、账号对价格的影响**不在这张表里**，而是乘在最终金额上的倍率
 * （`groups.rate_multiplier` × `accounts.rate_multiplier`，见 billing.ts）。
 * 所以"某分组价格不一样"应该去改分组倍率，而不是在这里加一行。
 */
async function handleModelPricing(
  env: Env,
  method: string,
  body: Record<string, unknown>,
  auth: AdminAuthResult,
  req: Request,
): Promise<Response> {
  if (method === 'GET') {
    const [rows, rawDefault] = await Promise.all([
      env.DB.prepare(
        `SELECT p.account_id, p.model, p.input_price, p.output_price, p.cache_read_price, p.cache_creation_price, p.updated_at,
                a.name AS account_name, a.platform AS account_platform, a.deleted_at AS account_deleted_at
         FROM model_pricing p
         LEFT JOIN accounts a ON a.id = p.account_id AND p.account_id > 0
         ORDER BY p.account_id ASC, p.model ASC`,
      ).all<Record<string, unknown>>(),
      readSetting(env, DEFAULT_PRICE_SETTING),
    ]);
    // 账号已软删: 定价行标成"账号已删除"(仍在库里, 等物理清理; 前端给个醒目提示)
    return json({
      models: (rows.results ?? []).map((r) => {
        const accountId = Number(r.account_id);
        const accountDeleted = Number(r.account_id) > 0 && r.account_deleted_at !== null;
        return {
          model: r.model,
          account_id: accountId,
          input_price: Number(r.input_price),
          output_price: Number(r.output_price),
          cache_read_price: Number(r.cache_read_price),
          cache_creation_price: Number(r.cache_creation_price),
          // 换算成"美元 / 百万 token", 更符合直觉
          input_per_mtok: Number(r.input_price),
          output_per_mtok: Number(r.output_price),
          // 平台展示信息(全局价 account_id=0 显示"全局")
          account_name: r.account_name ?? null,
          account_platform: r.account_platform ?? null,
          account_deleted: accountDeleted,
          updated_at: r.updated_at,
        };
      }),
      default_price: parseDefaultPrice(rawDefault),
      // 出厂默认值 —— 页面上给一个「还原默认」用, 免得改坏了没法回头
      default_price_builtin: DEFAULT_PRICE,
    });
  }

  if (method === 'PUT') {
    // ---- 1) 「默认单价」: 没单独配价的模型走它 ----
    if (body.default_price && typeof body.default_price === 'object') {
      const o = body.default_price as Record<string, unknown>;
      const dp = {
        input_price: nonNegNumber(o.input_price),
        output_price: nonNegNumber(o.output_price),
        cache_read_price: nonNegNumber(o.cache_read_price),
        cache_creation_price: nonNegNumber(o.cache_creation_price),
      };
      await writeSetting(env, DEFAULT_PRICE_SETTING, JSON.stringify(dp));
      await auditLog(env, auth.admin, 'update', 'model_pricing_default', '', JSON.stringify(dp), req);
      return json({ ok: true, default_price: dp });
    }

    // ---- 2) 逐模型定价: 单条与批量走同一段代码 ----
    const items = Array.isArray(body.models) ? body.models : [body];
    const parsed = items
      .map(normalizePricingRow)
      .filter((x): x is NonNullable<typeof x> => x !== null);
    if (!parsed.length) return badRequest('model is required');

    const now = new Date().toISOString();
    // 批量用 DB.batch 一次提交, 免得 N 个模型 N 次往返
    await env.DB.batch(
      parsed.map((p) =>
        env.DB.prepare(
          `INSERT INTO model_pricing (account_id, model, input_price, output_price, cache_read_price, cache_creation_price, updated_at)
           VALUES (?1,?2,?3,?4,?5,?6,?7)
           ON CONFLICT(account_id, model) DO UPDATE SET
             input_price = excluded.input_price,
             output_price = excluded.output_price,
             cache_read_price = excluded.cache_read_price,
             cache_creation_price = excluded.cache_creation_price,
             updated_at = excluded.updated_at`,
        ).bind(p.account_id, p.model, p.input_price, p.output_price, p.cache_read_price, p.cache_creation_price, now),
      ),
    );

    await auditLog(
      env, auth.admin, 'update', 'model_pricing',
      parsed.length === 1 ? parsed[0].model : `${parsed.length} models`,
      parsed.length === 1 ? '' : JSON.stringify(parsed.map((p) => p.model)).slice(0, 300),
      req,
    );
    return json({ ok: true, saved: parsed.length });
  }

  if (method === 'DELETE') {
    // 精确删除粒度: 每项可带 { account_id, model } —— 只删该账号下的定价;
    // 缺省 account_id = 0(全局)。兼容旧调用: 单条 { model } / 批量 models 是字符串数组。
    const bodyItems = Array.isArray(body.models) ? body.models : [body];
    const targets: { account_id: number; model: string }[] = [];
    for (const it of bodyItems) {
      let model = '';
      let account_id = 0;
      if (typeof it === 'string') {
        model = it.trim();
      } else if (it && typeof it === 'object') {
        const o = it as Record<string, unknown>;
        model = String(o.model ?? '').trim();
        const rawAcct = Number(o.account_id ?? 0);
        account_id = Number.isInteger(rawAcct) && rawAcct > 0 ? rawAcct : 0;
      }
      if (model) targets.push({ account_id, model });
    }
    if (!targets.length) return badRequest('model is required');

    await env.DB.batch(
      targets.map((t) =>
        env.DB.prepare(`DELETE FROM model_pricing WHERE account_id = ?1 AND model = ?2`)
          .bind(t.account_id, t.model),
      ),
    );
    const auditSummary = targets.length === 1
      ? `${targets[0].account_id ? 'acct#' + targets[0].account_id + ' ' : ''}${targets[0].model}`
      : `${targets.length} models`;
    await auditLog(
      env, auth.admin, 'delete', 'model_pricing',
      auditSummary,
      targets.length === 1 ? '' : JSON.stringify(targets).slice(0, 300),
      req,
    );
    return json({ ok: true, deleted: targets.length });
  }

  return badRequest('Unsupported method');
}

// ============================================================
// 粘性会话管理
//   GET  /api/admin/sticky           列出所有账号的粘性会话命中数
//   POST /api/admin/sticky/clear     清空全部账号的粘性会话
//   POST /api/admin/sticky/clear/:id 清空指定账号的粘性会话
//
// 为什么需要: 粘性会话 TTL 1h, 管理员改完账号配置后旧会话仍钉在原账号,
// 表现为"后台改了不生效"。此接口用于主动失效。
// ============================================================

async function handleSticky(
  env: Env,
  method: string,
  parts: string[],
  auth: AdminAuthResult,
  req: Request,
): Promise<Response> {
  const action = parts[1] ?? '';
  const targetId = parts[2] ? Number(parts[2]) : null;

  if (method === 'GET') {
    const rows = await env.DB.prepare(
      `SELECT id, name, platform, status, schedulable FROM accounts
       WHERE deleted_at IS NULL ORDER BY id ASC`,
    ).all<Record<string, unknown>>();
    return json({
      accounts: (rows.results ?? []).map((a) => ({
        id: a.id,
        name: a.name,
        platform: a.platform,
        status: a.status,
        schedulable: a.schedulable,
      })),
      note: '粘性会话 TTL 1 小时; 改完账号配置可点"清空"立即生效',
    });
  }

  if (method === 'POST' && action === 'clear') {
    let ids: number[] = [];
    if (targetId && Number.isInteger(targetId) && targetId > 0) {
      ids = [targetId];
    } else {
      const rows = await env.DB.prepare(
        `SELECT id FROM accounts WHERE deleted_at IS NULL`,
      ).all<{ id: number }>();
      ids = (rows.results ?? []).map((r) => r.id);
    }

    let cleared = 0;
    for (const aid of ids) {
      try {
        const stub = env.ACCOUNT_COORDINATOR.get(
          env.ACCOUNT_COORDINATOR.idFromName(`account:${aid}`),
        );
        const res = await stub.fetch('https://do/sticky/clear', { method: 'POST' });
        const data = (await res.json()) as { cleared?: number };
        cleared += Number(data.cleared ?? 0);
      } catch {
        // 单个账号失败不影响整体
      }
    }

    await auditLog(
      env,
      auth.admin,
      'clear',
      'sticky_session',
      targetId ?? 'all',
      `accounts=${ids.length} sessions=${cleared}`,
      req,
    );
    return json({ ok: true, accounts: ids.length, cleared });
  }

  return badRequest('Unsupported sticky operation');
}

// ---------- 工具 ----------

function parseJson(v: unknown): unknown {
  if (typeof v !== 'string' || !v) return null;
  try {
    return JSON.parse(v);
  } catch {
    return null;
  }
}

export { generateApiKey, fromMicro, toMicro, errorResponse };
export type { AuthContext };
