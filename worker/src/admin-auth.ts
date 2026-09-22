/**
 * 鉴权: 控制台会话 (管理员 + 业务用户**同一个登录页、同一张 users 表**)
 * 密码用 PBKDF2-SHA256 (Web Crypto 原生支持), 会话用 HMAC 签名的 JWT。
 *
 * 存储格式: pbkdf2$<iterations>$<saltHex>$<hashHex>
 * Token 格式: base64url(header).base64url(payload).base64url(signature)
 *
 * ⚠️ "登录进来能看到什么" **不在 token 里**, 而是每次请求现查数据库:
 *   token 只承载 `sub`(users.id) 与展示名; 角色与菜单从 `users.role` + `roles.menus`
 *   现取。好处是管理员改了角色/停用了账号, 旧会话立刻失效 —— 而不是等 token 过期。
 *   代价是每个受保护请求多一次 D1 查询, 后台流量很小, 这个代价换得回。
 */

import type { Env } from './types';

const PBKDF2_ITERATIONS = 100_000;
const TOKEN_TTL_SECONDS = 12 * 60 * 60; // 12 小时

/** 角色查不到时的兜底 —— 与 schema-roles.sql 里的内置角色之一对应, fail-closed */
export const DEFAULT_ROLE_CODE = 'user';

// ---------- base64url ----------

function b64urlEncode(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(str: string): Uint8Array {
  const padded = str.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((str.length + 3) % 4);
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function hexEncode(bytes: Uint8Array): string {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
}

function hexDecode(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}

function textEncoder(): TextEncoder {
  return new TextEncoder();
}

// ---------- 密码哈希 ----------

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await pbkdf2(password, salt, PBKDF2_ITERATIONS);
  return `pbkdf2$${PBKDF2_ITERATIONS}$${hexEncode(salt)}$${hexEncode(hash)}`;
}

async function pbkdf2(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    'raw',
    textEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveBits'],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: salt as unknown as BufferSource, iterations, hash: 'SHA-256' },
    key,
    256,
  );
  return new Uint8Array(bits);
}

/** 恒定时间比较, 防时序攻击 */
function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 4 || parts[0] !== 'pbkdf2') return false;
  const iterations = Number(parts[1]);
  if (!Number.isInteger(iterations) || iterations <= 0) return false;
  const salt = hexDecode(parts[2]);
  const expected = hexDecode(parts[3]);
  const actual = await pbkdf2(password, salt, iterations);
  return timingSafeEqual(actual, expected);
}

// ---------- JWT ----------

interface TokenPayload {
  sub: number;
  name: string;
  iat: number;
  exp: number;
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    textEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}

export async function signToken(
  payload: Omit<TokenPayload, 'iat' | 'exp'>,
  secret: string,
  ttlSeconds: number = TOKEN_TTL_SECONDS,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const full: TokenPayload = { ...payload, iat: now, exp: now + ttlSeconds };

  const header = b64urlEncode(textEncoder().encode(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));
  const body = b64urlEncode(textEncoder().encode(JSON.stringify(full)));
  const data = `${header}.${body}`;

  const key = await hmacKey(secret);
  const sig = await crypto.subtle.sign('HMAC', key, textEncoder().encode(data));
  return `${data}.${b64urlEncode(new Uint8Array(sig))}`;
}

export async function verifyToken(token: string, secret: string): Promise<TokenPayload | null> {
  // 🚨 整个函数体都在 try 里 —— **任何**畸形 token 都必须变成 null(→401),
  // 绝不能把异常抛出去变成 500。攻击者随手发一个 `s2a_admin_token=forged.token.value`
  // 就能命中: 第三段 `value` 长度不是 4 的倍数, `atob` 直接抛 InvalidCharacterError。
  // 这种"攻击者可控输入引发 500"不是安全问题, 但会污染错误监控、也把 401 语义搞错。
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;

    const data = `${parts[0]}.${parts[1]}`;
    const key = await hmacKey(secret);
    const expected = new Uint8Array(
      await crypto.subtle.sign('HMAC', key, textEncoder().encode(data)),
    );
    const actual = b64urlDecode(parts[2]);

    if (!timingSafeEqual(expected, actual)) return null;

    const payload = JSON.parse(new TextDecoder().decode(b64urlDecode(parts[1]))) as TokenPayload;
    if (!payload || typeof payload.exp !== 'number') return null;
    if (payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}

// ---------- 中间件 ----------

/** `['*']` —— 拥有全部菜单的通配符 */
export const ALL_MENUS = '*';

/**
 * 菜单权限的解析: roles.menus 是一个 JSON 数组。
 *
 * 解析失败一律当**空数组**(= 什么都看不到)而不是"全部" —— fail-closed。
 * 数据库里手改坏一个字符就让所有人变成超管, 那是灾难性的默认值。
 */
export function parseMenus(raw: unknown): string[] {
  try {
    const arr = JSON.parse(String(raw ?? '[]'));
    if (!Array.isArray(arr)) return [];
    return arr.map((v) => String(v)).filter(Boolean);
  } catch {
    return [];
  }
}

export function menusInclude(menus: string[], key: string): boolean {
  return menus.includes(ALL_MENUS) || menus.includes(key);
}

/** 当前请求的身份 —— 角色与菜单是**查库现取**的, 不是 token 里带来的 */
export interface AdminIdentity {
  id: number;
  /** 展示名 = users.username || users.email */
  name: string;
  email: string;
  /** 角色 code, 对应 roles.code */
  role: string;
  /** 角色显示名 */
  role_name: string;
  /** 可见菜单键; 含 '*' 即全部 */
  menus: string[];
  /** menus 含 '*' = 超管(网关侧也按 users.role='admin' 跳过余额检查) */
  is_admin: boolean;
}

export interface AdminAuthResult {
  ok: boolean;
  status: number;
  message?: string;
  admin?: AdminIdentity;
}

/** 从请求里取会话 token (优先 Cookie, 退回 Authorization 头) */
function readSessionToken(req: Request): string {
  const cookie = req.headers.get('cookie') ?? '';
  const m = /(?:^|;\s*)s2a_admin_token=([^;]+)/.exec(cookie);
  if (m) {
    // decodeURIComponent 对畸形转义(`%zz`)会抛 → 同样必须退化, 不能 500
    try {
      return decodeURIComponent(m[1]);
    } catch {
      return m[1];
    }
  }

  const auth = req.headers.get('authorization') ?? '';
  const bm = /^Bearer\s+(.+)$/i.exec(auth.trim());
  return bm ? bm[1].trim() : '';
}

/**
 * 校验会话并把身份补全成"带角色与菜单"的完整身份。
 *
 * 为什么要查库而不是信任 token 里的 role:
 *   1. 管理员把某人从 admin 改成 user 之后, 那个人的旧 token 不该继续当管理员 ——
 *      角色写死在 token 里就要等到 12 小时后才生效, 这是提权窗口;
 *   2. 账号被停用(users.status='disabled')时也必须立刻失去会话;
 *   3. 角色菜单改了(roles.menus)同理应当立即生效。
 * 三条都要求"每次请求都以库为准"。token 只证明"你是谁", 不证明"你能干什么"。
 */
export async function requireAdmin(req: Request, env: Env): Promise<AdminAuthResult> {
  const secret = (env as unknown as Record<string, string>)['ADMIN_JWT_SECRET'];
  if (!secret) {
    return {
      ok: false,
      status: 500,
      message: 'Server misconfigured: ADMIN_JWT_SECRET is not set. Run `wrangler secret put ADMIN_JWT_SECRET`.',
    };
  }

  const token = readSessionToken(req);
  if (!token) return { ok: false, status: 401, message: 'Not authenticated.' };

  const payload = await verifyToken(token, secret);
  if (!payload) return { ok: false, status: 401, message: 'Session expired or invalid.' };

  // 角色 + 菜单一次查出来(LEFT JOIN: 角色被删了也还能登录, 只是没有任何菜单)
  const row = await env.DB.prepare(
    `SELECT u.id, u.username, u.email, u.role, u.status,
            COALESCE(r.menus, '[]') AS menus,
            COALESCE(r.name, '')    AS role_name
       FROM users u
       LEFT JOIN roles r ON r.code = u.role
      WHERE u.id = ?1 AND u.deleted_at IS NULL`,
  )
    .bind(payload.sub)
    .first<{
      id: number;
      username: string;
      email: string;
      role: string;
      status: string;
      menus: string;
      role_name: string;
    }>();

  if (!row) return { ok: false, status: 401, message: '账号不存在或已被删除。' };
  if (String(row.status) !== 'active') {
    return { ok: false, status: 403, message: '账号已被停用, 请联系管理员。' };
  }

  const menus = parseMenus(row.menus);
  const role = String(row.role || DEFAULT_ROLE_CODE);
  const name = String(row.username || row.email || `#${row.id}`);

  // 兜底: roles 表还没建/还没种数据时, role='admin' 仍按超管处理 ——
  // 否则"新代码 + 旧库"的部署窗口里, 管理员一登录就是个空后台(自己把自己锁在门外)。
  // 非 admin 角色查不到就是空菜单(fail-closed), 不会因为数据缺失凭空发权限。
  const effective = menus.length === 0 && role === 'admin' ? [ALL_MENUS] : menus;

  return {
    ok: true,
    status: 200,
    admin: {
      id: Number(row.id),
      name,
      email: String(row.email ?? ''),
      role,
      role_name: String(row.role_name || role),
      menus: effective,
      is_admin: effective.includes(ALL_MENUS),
    },
  };
}

/** 写审计日志 */
export async function auditLog(
  env: Env,
  admin: { id: number; name: string } | undefined,
  action: string,
  resource: string,
  resourceId: string | number,
  detail: string,
  req: Request,
): Promise<void> {
  try {
    await env.DB.prepare(
      `INSERT INTO admin_audit_logs (admin_id, admin_name, action, resource, resource_id, detail, ip)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
    )
      .bind(
        admin?.id ?? null,
        admin?.name ?? 'system',
        action,
        resource,
        String(resourceId),
        detail,
        req.headers.get('cf-connecting-ip') ?? '',
      )
      .run();
  } catch {
    // 审计失败不影响主流程
  }
}

/** 构造登录 Cookie */
export function buildAuthCookie(token: string, maxAge: number): string {
  return [
    `s2a_admin_token=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'Secure',
    'SameSite=Strict',
    `Max-Age=${maxAge}`,
  ].join('; ');
}

export function buildLogoutCookie(): string {
  return 's2a_admin_token=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0';
}

export const TOKEN_TTL = TOKEN_TTL_SECONDS;
