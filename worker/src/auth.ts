/**
 * API Key 鉴权
 * 移植自上游 backend/internal/server/middleware/api_key_auth.go:34 apiKeyAuthWithSubscription
 *        与 backend/internal/service/api_key_service.go:704 GetByKey
 *
 * 流程:
 *   1. 提取 key (Authorization: Bearer / x-api-key / x-goog-api-key)
 *      —— 查询参数 key / api_key 一律 400 拒绝 (上游行为)
 *   2. 查库 (对应上游 L1/L2 缓存未命中的 lookupAPIKeyForAuth)
 *   3. 基础校验: key 状态 / IP 白黑名单 / 用户状态 / 分组可用
 *   4. 计费前置校验 (与上游一致, 此处延后到调用方 decide)
 */

import type { AuthContext, Env } from './types';

export interface AuthResult {
  ok: boolean;
  status: number;
  code?: string;
  message?: string;
  ctx?: AuthContext;
}

/** 从请求中提取 API Key —— 上游 api_key_auth.go 的提取顺序 */
function extractApiKey(req: Request): { key: string | null; rejectedByQuery: boolean } {
  const url = new URL(req.url);

  // 上游明确: query 里的 key / api_key 一律 400
  if (url.searchParams.has('key') || url.searchParams.has('api_key')) {
    return { key: null, rejectedByQuery: true };
  }

  const auth = req.headers.get('authorization');
  if (auth) {
    const m = /^Bearer\s+(.+)$/i.exec(auth.trim());
    if (m) return { key: m[1].trim(), rejectedByQuery: false };
  }

  const xApiKey = req.headers.get('x-api-key');
  if (xApiKey) return { key: xApiKey.trim(), rejectedByQuery: false };

  const xGoog = req.headers.get('x-goog-api-key');
  if (xGoog) return { key: xGoog.trim(), rejectedByQuery: false };

  return { key: null, rejectedByQuery: false };
}

/** IP 白/黑名单匹配, 支持单个 IP 与 CIDR —— 对应上游 CompiledIPWhitelist */
function ipMatches(ip: string, patterns: string[] | null): boolean {
  if (!patterns || patterns.length === 0) return false;
  for (const p of patterns) {
    if (p === ip) return true;
    if (p.includes('/')) {
      if (cidrContains(p, ip)) return true;
    }
  }
  return false;
}

/** 简易 CIDR 判定 (仅支持 IPv4) */
function cidrContains(cidr: string, ip: string): boolean {
  const [net, bitsStr] = cidr.split('/');
  const bits = Number(bitsStr);
  if (!Number.isInteger(bits) || bits < 0 || bits > 32) return false;
  const toInt = (s: string): number | null => {
    const parts = s.split('.');
    if (parts.length !== 4) return null;
    let n = 0;
    for (const p of parts) {
      const v = Number(p);
      if (!Number.isInteger(v) || v < 0 || v > 255) return null;
      n = (n << 8) | v;
    }
    return n >>> 0;
  };
  const a = toInt(net);
  const b = toInt(ip);
  if (a === null || b === null) return false;
  if (bits === 0) return true;
  const mask = (0xffffffff << (32 - bits)) >>> 0;
  return (a & mask) === (b & mask);
}

function parseJsonArray(raw: unknown): string[] | null {
  if (typeof raw !== 'string' || raw.length === 0) return null;
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.map(String) : null;
  } catch {
    return null;
  }
}

function parseJsonObject<T>(raw: unknown): T | null {
  if (typeof raw !== 'string' || raw.length === 0) return null;
  try {
    const v = JSON.parse(raw);
    return v && typeof v === 'object' ? (v as T) : null;
  } catch {
    return null;
  }
}

export async function authenticate(
  req: Request,
  env: Env,
): Promise<AuthResult> {
  const { key, rejectedByQuery } = extractApiKey(req);

  if (rejectedByQuery) {
    return {
      ok: false,
      status: 400,
      code: 'invalid_request_error',
      message: 'API key must not be passed via query parameter; use the Authorization header.',
    };
  }

  if (!key) {
    return {
      ok: false,
      status: 401,
      code: 'authentication_error',
      message: 'Missing API key. Provide it via `Authorization: Bearer <key>` or `x-api-key`.',
    };
  }

  // 对应上游 GetByKey -> lookupAPIKeyForAuth
  const row = await env.DB.prepare(
    `SELECT * FROM v_api_key_auth WHERE key = ?1 LIMIT 1`,
  )
    .bind(key)
    .first<Record<string, unknown>>();

  if (!row) {
    return {
      ok: false,
      status: 401,
      code: 'authentication_error',
      message: 'Invalid API key.',
    };
  }

  // ---- 基础校验 (上游 IsActive + User 校验) ----
  const keyStatus = String(row.key_status ?? 'active');
  if (keyStatus === 'disabled') {
    return { ok: false, status: 403, code: 'permission_error', message: 'API key is disabled.' };
  }

  const userStatus = String(row.user_status ?? 'active');
  if (userStatus !== 'active') {
    return { ok: false, status: 403, code: 'permission_error', message: 'User account is not active.' };
  }

  // 过期检查 —— 上游把 expired/quota_exhausted 延后到计费阶段, 这里保持一致
  // IP 白/黑名单
  const clientIp = req.headers.get('cf-connecting-ip') ?? '';
  const whitelist = parseJsonArray(row.ip_whitelist);
  const blacklist = parseJsonArray(row.ip_blacklist);

  if (blacklist && clientIp && ipMatches(clientIp, blacklist)) {
    return { ok: false, status: 403, code: 'permission_error', message: 'IP address is blacklisted.' };
  }
  if (whitelist && whitelist.length > 0 && clientIp && !ipMatches(clientIp, whitelist)) {
    return { ok: false, status: 403, code: 'permission_error', message: 'IP address is not whitelisted.' };
  }

  const ctx: AuthContext = {
    keyId: Number(row.key_id),
    key: String(row.key),
    keyStatus,
    keyQuota: Number(row.key_quota ?? 0),
    keyQuotaUsed: Number(row.key_quota_used ?? 0),
    keyExpiresAt: (row.key_expires_at as string | null) ?? null,
    ipWhitelist: whitelist,
    ipBlacklist: blacklist,
    rateLimit5h: Number(row.rate_limit_5h ?? 0),
    rateLimit1d: Number(row.rate_limit_1d ?? 0),
    rateLimit7d: Number(row.rate_limit_7d ?? 0),
    usage5h: Number(row.usage_5h ?? 0),
    usage1d: Number(row.usage_1d ?? 0),
    usage7d: Number(row.usage_7d ?? 0),
    window5hStart: (row.window_5h_start as string | null) ?? null,
    window1dStart: (row.window_1d_start as string | null) ?? null,
    window7dStart: (row.window_7d_start as string | null) ?? null,
    userId: Number(row.user_id),
    userEmail: String(row.user_email ?? ''),
    userRole: String(row.user_role ?? 'user'),
    userBalance: Number(row.user_balance ?? 0),
    userStatus,
    userConcurrency: Number(row.user_concurrency ?? 5),
    userPlatformAccess: String(row.user_platform_access ?? ''),
    groupId: row.group_effective_id === null || row.group_effective_id === undefined
      ? null
      : Number(row.group_effective_id),
    groupName: (row.group_name as string | null) ?? null,
    groupPlatform: (row.group_platform as string | null) ?? null,
    groupRateMultiplier: Number(row.group_rate_multiplier ?? 100_000_000),
    groupRpmLimit: Number(row.group_rpm_limit ?? 0),
    groupModelAllowlist: parseJsonArray(row.group_model_allowlist),
    groupModelPricing: parseJsonObject(row.group_model_pricing),
    groupModelRouting: parseJsonObject(row.group_model_routing),
    groupModelRoutingEnabled: Number(row.group_model_routing_enabled ?? 0) === 1,
    groupDefaultMappedModel: (row.group_default_mapped_model as string | null) ?? null,
    groupModelPlatformRouting: parseJsonObject(row.group_model_platform_routing) as
      | Record<string, string | { platform: string; model?: string }>
      | null,
  };

  return { ok: true, status: 200, ctx };
}

/** 异步刷新 last_used_at (对应上游 30s 防抖 TouchLastUsed) */
export async function touchApiKey(env: Env, keyId: number): Promise<void> {
  try {
    await env.DB.prepare(
      `UPDATE api_keys SET last_used_at = datetime('now') WHERE id = ?1`,
    )
      .bind(keyId)
      .run();
  } catch {
    // 静默失败, 不影响主流程
  }
}
