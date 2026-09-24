/**
 * sub2api —— Cloudflare Workers 移植版入口
 *
 * 上游项目: https://github.com/Wei-Shaw/sub2api  (LGPL-3.0)
 * 本文件为方案 C (Workers 重写) 的 MVP 骨架。
 *
 * 与上游的映射关系:
 *   Go/Gin 路由          -> 本文件的路由分发
 *   api_key_auth.go      -> src/auth.ts
 *   PostgreSQL + Ent     -> D1 (schema/schema.sql)
 *   Redis (缓存)         -> KV
 *   Redis (原子/ZSET)    -> Durable Object (src/durable-object.ts)
 *   gateway_scheduling   -> src/scheduler.ts
 *   gateway_upstream_*   -> src/gateway.ts + src/protocol.ts
 *   billing_service      -> src/billing.ts + src/billing-repo.ts
 */

import { authenticate, touchApiKey } from './auth';
import { checkQuotaLimits } from './billing';
import {
  errorResponse,
  findAccountByEntryPath,
  handleGateway,
  isGatewayPath,
  splitEntryPrefix,
  type EntryRoute,
} from './gateway';
import { handleModelsList } from './models';
import type { Platform } from './protocol';
import { parseDbTime } from './time';
import {
  ALL_MENUS,
  auditLog,
  buildAuthCookie,
  buildLogoutCookie,
  parseMenus,
  requireAdmin,
  signToken,
  TOKEN_TTL,
  verifyPassword,
} from './admin-auth';
import { handleAdminApi, handleRegister, getRegisterConfig } from './admin-api';
import { sendVerifyCode } from './verify-code';
import { renderAdminPage } from './admin-ui';

export { AccountCoordinator } from './durable-object';

/** 带执行上下文的 Env */
interface EnvWithCtx {
  __ctx?: ExecutionContext;
}

/**
 * 控制台页面路径清单 —— **唯一权威来源**。
 *
 * 去掉 /admin 前缀之后, 菜单路径直接占根目录第一段, 于是这里必须是一张
 * **白名单**: 只有列在这里的段才会被当成"控制台页面"(命中就走登录校验+出页面),
 * 其余一律落到下面的入口路径 / 网关分支。反过来若用"黑名单(排除 v1/models 等)",
 * 一个拼错的 URL 就可能被当成页面而把网关请求截胡。
 *
 * ⚠️ 与 `admin-api.ts::MENU_CATALOG` 的 key 必须完全一致 ——
 * tools/test-roles-guard.mjs 会静态比对这两处。
 */
const CONSOLE_PAGES = new Set([
  'dashboard',
  'overview',
  'mykeys',
  'keys',
  'accounts',
  'groups',
  'users',
  'models',
  'board',
  'logs',
  'usage',
  'audit',
  'announce',
  'roles',
  'profile',
  'settings',
]);

export default {
  async fetch(request: Request, env: never, executionCtx: ExecutionContext): Promise<Response> {
    // 把 executionCtx 挂到 env 上, 供 gateway 内后台结算使用
    (env as unknown as EnvWithCtx).__ctx = executionCtx;

    const url = new URL(request.url);
    const pathname = url.pathname;

    // ---- CORS 预检 ----
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(request, env) });
    }

    // ---- 健康检查 / 探针 ----
    if (pathname === '/health' || pathname === '/healthz') {
      return jsonResponse({ status: 'ok', service: 'sub2api-worker', time: new Date().toISOString() }, 200, corsHeaders(request, env));
    }

    // ---- 站点信息 (机器可读, 公开) ----
    // 原先挂在 `/`; 现在 `/` 是控制台首页(未登录会 302 到 /login), 所以搬到独立路径。
    if (pathname === '/api/info') {
      return jsonResponse(
        {
          service: 'sub2api-worker',
          upstream: 'https://github.com/Wei-Shaw/sub2api',
          version: '0.1.0-mvp',
          note: 'Go -> Workers 移植版 MVP 骨架, 仅含网关核心链路',
          endpoints: [
            'POST /v1/chat/completions',
            'POST /v1/responses',
            'POST /v1/messages',
            'POST /v1/embeddings',
            'GET  /v1/models',
            'POST /v1beta/models/{model}:generateContent',
          ],
          console: '/dashboard',
          login: '/login',
          register: '/register',
          // 菜单路径直接挂域名根下(无 /admin 前缀), 页面清单见 CONSOLE_PAGES
          pages: Array.from(CONSOLE_PAGES),
        },
        200,
        corsHeaders(request, env),
      );
    }

    // ---- 控制台 (页面) ----
    // 菜单路径直接挂在**域名根下**: /dashboard、/users、/profile ...
    // (2026-09-21 起去掉了 /admin 前缀 —— 用户要求"直接使用域名加菜单名")。
    // 未登录一律 302 去 /login; 带上 next 是为了从深链接被踢回后还能回到原处。
    //
    // 判断方式: 第一段是不是一个"已知控制台页面"。这样新增菜单时只改
    // CONSOLE_PAGES 一处, 不用再往这里堆 pathname === 判断。
    // 注意: /api/info 与 /health 必须在上面先返回, 否则会被这里当成页面请求。
    const firstSeg = pathname.split('/')[1] ?? '';
    if (
      pathname === '/' ||
      pathname === '/login' ||
      pathname === '/register' ||
      CONSOLE_PAGES.has(firstSeg)
    ) {
      // /login 与 /register 本身永远直接给页面(客户端自己决定显示哪个视图),
      // 否则未登录访问它们会被自己再重定向一次, 变成死循环。
      if (pathname !== '/login' && pathname !== '/register') {
        const me = await requireAdmin(request, env as unknown as import('./types').Env);
        if (!me.ok) {
          const next = pathname === '/' ? '' : pathname;
          return redirectTo(`/login${next ? `?next=${encodeURIComponent(next)}` : ''}`);
        }
      }
      return renderAdminPage();
    }

    // ---- 邮箱验证码 (公开, 不需要会话) ----
    // 必须在 /api/admin/* 之前: handleAdminRequest 只有在 /api/admin* 下才会被调用,
    // 而 send-verify-code 的路由在 handleAdminRequest 内部, 路径是 /api/auth/*,
    // 不提前转发就永远 404。
    if (pathname === '/api/auth/send-verify-code') {
      return handleAdminRequest(request, env, pathname);
    }

    // ---- 后台 API ----
    if (pathname === '/api/admin' || pathname.startsWith('/api/admin/')) {
      return handleAdminRequest(request, env, pathname);
    }

    // ---- 入口路径: /<entry>/v1/... ----
    // 第一段若命中某条上游账号的 entry_path, 就把前缀剥掉、把该账号钉死 ——
    // 之后 handleGateway 走 entry 分支, 完全不再用模型名判平台。
    // 命中不了就当普通路径处理, 行为与改动前**完全一致**。
    //
    // splitEntryPrefix 已经挡掉了协议路径(v1 / models ...): 普通的 /v1/chat/completions
    // 一次 DB 都不用打, 不拖慢现有流量。
    let entry: EntryRoute | null = null;
    const split = splitEntryPrefix(pathname);
    if (split) {
      const acct = await findAccountByEntryPath(env, split.seg);
      if (acct) {
        // 直接改写 url.pathname: 端点推导 / 协议识别 / 转发全部按剥掉前缀后的路径走
        url.pathname = split.rest;
        entry = { entryPath: split.seg, accountId: acct.id, platform: acct.platform as Platform };
      }
    }

    // ---- 网关路由 ----
    if (isGatewayPath(url.pathname)) {
      return handleApiRequest(request, env, executionCtx, url, entry);
    }

    return errorResponse(404, 'invalid_request_error', `Unknown path: ${pathname}`);
  },
} satisfies ExportedHandler<never>;

// ============================================================
// 后台请求入口
//   POST /api/admin/login    登录 (公开)
//   POST /api/admin/logout   登出 (公开, 清 Cookie)
//   GET  /api/admin/me       当前身份 (公开, 未登录返回 401)
//   *    /api/admin/*        其余全部需要会话 + 对应菜单权限
// ============================================================

async function handleAdminRequest(request: Request, env: never, pathname: string): Promise<Response> {
  const method = request.method.toUpperCase();
  const e = env as unknown as import('./types').Env;

  // ---- 登录 ----
  // **统一登录入口**: 管理员与业务用户走同一个页面、同一张 users 表,
  // 登录后能干什么由 users.role -> roles.menus 决定(见 admin-api.ts 的菜单闸门)。
  // admin_accounts 表已并入 users, 不再参与鉴权(保留仅为回滚便利)。
  if (pathname === '/api/admin/login' && method === 'POST') {
    let body: { username?: string; password?: string };
    try {
      body = (await request.json()) as { username?: string; password?: string };
    } catch {
      return adminJson({ error: { message: 'Invalid JSON body.' } }, 400);
    }

    const ident = String(body.username ?? '').trim();
    const password = String(body.password ?? '');
    if (!ident || !password) {
      return adminJson({ error: { message: '用户名和密码不能为空。' } }, 400);
    }

    const secret = String((env as unknown as Record<string, string>)['ADMIN_JWT_SECRET'] ?? '');
    if (!secret) {
      return adminJson(
        {
          error: {
            message:
              '服务端未配置 ADMIN_JWT_SECRET。请执行 `wrangler secret put ADMIN_JWT_SECRET` 后重试。',
          },
        },
        500,
      );
    }

    interface LoginRow {
      id: number;
      username: string;
      email: string;
      role: string;
      status: string;
      password_hash: string;
      role_name: string;
      menus: string;
    }

    // 用户名或邮箱都能登, 大小写不敏感(COLLATE NOCASE 只对 ASCII 生效, 够用)。
    // 同一个标识命中多行时取 id 最小的那条 —— email 有唯一索引, username 没有,
    // 所以理论上可能出现重名, 排序保证结果稳定而不是随机的。
    const row = await (e.DB as D1Database)
      .prepare(
        `SELECT u.id, u.username, u.email, u.role, u.status, u.password_hash,
                COALESCE(r.name, '')    AS role_name,
                COALESCE(r.menus, '[]') AS menus
           FROM users u
           LEFT JOIN roles r ON r.code = u.role
          WHERE u.deleted_at IS NULL
            AND (u.email = ?1 COLLATE NOCASE OR u.username = ?1 COLLATE NOCASE)
          ORDER BY u.id ASC LIMIT 1`,
      )
      .bind(ident)
      .first<LoginRow>();

    // 统一错误文案, 避免暴露账号是否存在
    const invalid = () => adminJson({ error: { message: '用户名或密码错误。' } }, 401);
    if (!row) return invalid();

    const ok = await verifyPassword(password, String(row.password_hash ?? ''));
    if (!ok) return invalid();

    // 停用检查放在密码校验**之后** —— 否则拿任意密码探一下就能问出
    // "这个账号存在但被停用了", 等于给了一个账号枚举的口子。
    if (String(row.status) !== 'active') {
      return adminJson({ error: { message: '账号已被停用, 请联系管理员。' } }, 403);
    }

    const id = Number(row.id);
    const display = String(row.username || row.email || `#${id}`);
    const menus = resolveMenus(row.role, row.menus);

    const token = await signToken({ sub: id, name: display }, secret);

    await (e.DB as D1Database)
      .prepare(`UPDATE users SET last_login_at = ?1, updated_at = ?1 WHERE id = ?2`)
      .bind(new Date().toISOString(), id)
      .run();
    await auditLog(e, { id, name: display }, 'login', 'admin_session', id, '', request);

    return adminJson(
      {
        ok: true,
        username: display,
        role: row.role,
        role_name: row.role_name || row.role,
        menus,
        is_admin: menus.includes(ALL_MENUS),
      },
      200,
      { 'set-cookie': buildAuthCookie(token, TOKEN_TTL) },
    );
  }

  // ---- 登出 ----
  if (pathname === '/api/admin/logout' && method === 'POST') {
    return adminJson({ ok: true }, 200, { 'set-cookie': buildLogoutCookie() });
  }

  // ---- 当前身份 ----
  if (pathname === '/api/admin/me' && method === 'GET') {
    const auth = await requireAdmin(request, e);
    if (!auth.ok || !auth.admin) {
      return adminJson({ error: { message: auth.message ?? 'Unauthorized' } }, auth.status);
    }
    const a = auth.admin;
    return adminJson({
      id: a.id,
      username: a.name,
      email: a.email,
      role: a.role,
      role_name: a.role_name,
      menus: a.menus,
      is_admin: a.is_admin,
    });
  }

  // ---- 注册 (公开, 不需要会话) ----
  // 与登录对称: GET 拿"能不能注册/密码下限", POST 真正建号。
  // 开关、邮箱唯一性、特权字段全部在 admin-api.ts::handleRegister 里由服务端把关。
  if (pathname === '/api/admin/register') {
    if (method === 'GET') {
      return adminJson(await getRegisterConfig(e));
    }
    if (method === 'POST') {
      let body: Record<string, unknown>;
      try {
        body = (await request.json()) as Record<string, unknown>;
      } catch {
        return adminJson({ error: { message: 'Invalid JSON body.' } }, 400);
      }
      return handleRegister(e, body, request);
    }
    return adminJson({ error: { message: 'Method not allowed.' } }, 405);
  }

  // ---- 发送邮箱验证码 (公开, 不需要会话) ----
  // 前置验证码能力(邮箱注册/密码重置/邮箱绑定共用)。
  // 校验 + 限流 + 状态机都在 verify-code.ts, 这里只是路由。
  if (pathname === '/api/auth/send-verify-code') {
    if (method !== 'POST') {
      return adminJson({ error: { message: 'Method not allowed.' } }, 405);
    }
    let body: { email?: string; purpose?: string; turnstile_token?: string };
    try {
      body = (await request.json()) as { email?: string; purpose?: string; turnstile_token?: string };
    } catch {
      return adminJson({ error: { message: 'Invalid JSON body.' } }, 400);
    }
    const result = await sendVerifyCode(
      e,
      String(body.email ?? ''),
      String(body.purpose ?? ''),
      body.turnstile_token,
      request,
    );
    return adminJson(
      result.ok ? { ok: true, message: result.message, ...(result.debug_code ? { debug_code: result.debug_code } : {}) } : { error: { message: result.message } },
      result.status,
    );
  }

  // ---- 其余: 需会话 + 菜单权限(权限在 handleAdminApi 里逐资源判定) ----
  const auth = await requireAdmin(request, e);
  if (!auth.ok) {
    return adminJson({ error: { message: auth.message ?? 'Unauthorized' } }, auth.status);
  }

  return handleAdminApi(request, e, pathname, auth);
}

/**
 * 角色菜单的兜底解析。
 *
 * 为什么要"roles 表查不到时把 admin 当超管": 代码上线与 schema 迁移是两步,
 * 中间必然有一段"新代码 + 旧库(还没有 roles 表)"的窗口。若此时 admin 的菜单
 * 解析成空数组, 管理员一登录就会看到一个空后台、什么都点不动 —— 把自己锁在门外。
 * 所以 role='admin' 且菜单为空时按全部菜单处理。
 *
 * 反过来, 非 admin 角色查不到就是**空菜单**(fail-closed): 宁可什么都不给,
 * 也不能因为数据缺失凭空发权限。
 */
function resolveMenus(role: unknown, rawMenus: unknown): string[] {
  const code = String(role ?? '');
  const menus = parseMenus(rawMenus);
  if (menus.length === 0 && code === 'admin') return [ALL_MENUS];
  return menus;
}

/** 302 跳转(禁用缓存, 免得浏览器把"未登录"的重定向缓存住) */
function redirectTo(location: string): Response {
  return new Response(null, {
    status: 302,
    headers: { location, 'cache-control': 'no-store' },
  });
}

function adminJson(
  data: unknown,
  status = 200,
  extra?: Record<string, string>,
): Response {
  const headers = new Headers({
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  if (extra) for (const [k, v] of Object.entries(extra)) headers.set(k, v);
  return new Response(JSON.stringify(data), { status, headers });
}

async function handleApiRequest(
  request: Request,
  env: never,
  executionCtx: ExecutionContext,
  url: URL,
  /** 入口路径命中结果; 非空 = 由 URL 指定上游 */
  entry: EntryRoute | null = null,
): Promise<Response> {
  const cors = corsHeaders(request, env);

  // ---- 鉴权 (对应上游 apiKeyAuth 中间件) ----
  const authResult = await authenticate(request, env);

  if (!authResult.ok || !authResult.ctx) {
    return withCors(
      errorResponse(authResult.status, authResult.code ?? 'authentication_error', authResult.message ?? 'Unauthorized'),
      cors,
    );
  }

  const ctx = authResult.ctx;

  // ---- Key 过期检查 (上游延后到计费阶段) ----
  if (ctx.keyExpiresAt) {
    const exp = parseDbTime(ctx.keyExpiresAt);
    if (exp !== null && Date.now() > exp) {
      return withCors(
        errorResponse(403, 'permission_error', 'API key has expired.', 'expired'),
        cors,
      );
    }
  }
  if (ctx.keyStatus === 'quota_exhausted') {
    return withCors(
      errorResponse(429, 'rate_limit_error', 'API key quota exhausted.', 'quota_exhausted'),
      cors,
    );
  }

  // ---- 额度窗口校验 (5h/1d/7d + quota) ----
  const limitError = checkQuotaLimits(ctx);
  if (limitError) {
    return withCors(
      errorResponse(429, 'rate_limit_error', limitError, 'rate_limit_exceeded'),
      cors,
    );
  }

  // ---- 余额检查 (对应上游 INSUFFICIENT_BALANCE) ----
  const enforceBalance = String(env['ENFORCE_BALANCE'] ?? 'true') === 'true';
  if (enforceBalance && ctx.userRole !== 'admin' && ctx.userBalance <= 0) {
    return withCors(
      errorResponse(
        403,
        'permission_error',
        'Insufficient balance. Please top up your account.',
        'INSUFFICIENT_BALANCE',
      ),
      cors,
    );
  }

  // ---- /v1/sub2api/billing : Key 计费信息 (上游同路径) ----
  if (url.pathname === '/v1/sub2api/billing') {
    return withCors(
      jsonResponse(
        {
          key_id: ctx.keyId,
          user_id: ctx.userId,
          balance: ctx.userBalance / 1e8,
          quota: ctx.keyQuota / 1e8,
          quota_used: ctx.keyQuotaUsed / 1e8,
          usage_5h: ctx.usage5h / 1e8,
          usage_1d: ctx.usage1d / 1e8,
          usage_7d: ctx.usage7d / 1e8,
          rate_limit_5h: ctx.rateLimit5h / 1e8,
          rate_limit_1d: ctx.rateLimit1d / 1e8,
          rate_limit_7d: ctx.rateLimit7d / 1e8,
        },
        200,
      ),
      cors,
    );
  }

  // ---- /v1/models : 模型列表中转 (不走通用转发, 需聚合+统一格式) ----
  if (url.pathname === '/v1/models' && (request.method === 'GET' || request.method === 'HEAD')) {
    return withCors(await handleModelsList(env, ctx, request), cors);
  }

  const requestId = request.headers.get('x-request-id') ?? crypto.randomUUID();
  executionCtx.waitUntil(touchApiKey(env, ctx.keyId));

  const res = await handleGateway(request, env, ctx, requestId, entry);
  return withCors(res, cors);
}

/** CORS 头 */
function corsHeaders(request: Request, env: never): Headers {
  const headers = new Headers();
  const allowed = String(env['CORS_ALLOWED_ORIGINS'] ?? '*');
  const origin = request.headers.get('origin') ?? '';

  if (allowed === '*') {
    headers.set('access-control-allow-origin', '*');
  } else if (origin && allowed.split(',').map((s) => s.trim()).includes(origin)) {
    headers.set('access-control-allow-origin', origin);
    headers.set('vary', 'Origin');
  }

  headers.set('access-control-allow-methods', 'GET, POST, PUT, DELETE, OPTIONS');
  headers.set(
    'access-control-allow-headers',
    'authorization, content-type, x-api-key, x-goog-api-key, anthropic-version, x-request-id',
  );
  headers.set('access-control-max-age', '86400');
  return headers;
}

function withCors(res: Response, cors: Headers): Response {
  const out = new Headers(res.headers);
  for (const [k, v] of cors.entries()) out.set(k, v);
  return new Response(res.body, { status: res.status, headers: out });
}

function jsonResponse(data: unknown, status: number, cors?: Headers): Response {
  const headers = new Headers(cors ?? {});
  headers.set('content-type', 'application/json');
  return new Response(JSON.stringify(data), { status, headers });
}
