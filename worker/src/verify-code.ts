/**
 * 邮箱验证码模块 —— 注册 / 密码重置 / 邮箱绑定 的验证码全生命周期。
 *
 * 设计(对应方案 V1.1):
 *   - 验证码 6 位, crypto 随机生成(严禁 Math.random)
 *   - 只存 HMAC-SHA256(pepper) 哈希, 不存明文
 *   - 状态机: PENDING → ACTIVE → USED / FAILED / EXPIRED / INVALIDATED
 *   - 同一 email+purpose 同时只有一个 ACTIVE
 *   - 精确限流: 同邮箱 60s 一次 / 10min 5 次; 同 IP 10min 20 次
 *   - Turnstile 服务端校验(success + action + hostname)
 *   - 调独立邮件 Worker(Authorization Bearer Secret, request_id 幂等)
 *
 * 违规红线:
 *   - 验证码明文 / 完整邮箱 / 完整 IP 一律不进日志
 *   - Resend / Worker 密钥永远不进前端、不进代码
 *
 * 🚨 哈希一致性(改这里必同步改 verifyCode 与 sendVerifyCode):
 *   email_hash     = hmac(pepper, `${purpose}:${email}`)   —— 含 purpose, 天然区分场景
 *   client_ip_hash = hmac(pepper, clientIp)
 *   限流查询与 INSERT send_logs 必须用**同一** email_hash, 否则永远数不到自己。
 */

import type { Env } from './types';

// ============================================================
// 常量
// ============================================================

export type VerifyPurpose = 'REGISTER' | 'PASSWORD_RESET' | 'EMAIL_BIND';

export const VERIFY_PURPOSES: VerifyPurpose[] = ['REGISTER', 'PASSWORD_RESET', 'EMAIL_BIND'];

const CODE_LEN = 6;
/** 验证码(分钟) */
export const CODE_EXPIRE_MINUTES = 5;
/** 同一 email+purpose 60 秒可发一次 */
const EMAIL_COOLDOWN_SECONDS = 60;
/** 同一 email+purpose 10 分钟最多 5 次 */
const EMAIL_MAX_PER_10MIN = 5;
/** 同一 IP 10 分钟最多 20 次 */
const IP_MAX_PER_10MIN = 20;
/** 验证失败次数上限 */
export const MAX_ATTEMPTS = 5;

const TURNSTILE_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

// ============================================================
// 类型
// ============================================================

export type VerifyCodeStatus =
  | 'PENDING'
  | 'ACTIVE'
  | 'USED'
  | 'FAILED'
  | 'EXPIRED'
  | 'INVALIDATED';

export interface SendingResult {
  ok: boolean;
  status: number;
  message: string;
  /** 是否真的尝试发送(成功或进入发送流程); 前端据此起倒计时 */
  sent?: boolean;
  /** 仅 DEBUG_MAIL=1 时返回(测试环境), 生产永不含 */
  debug_code?: string;
}

export interface VerifyResult {
  ok: boolean;
  status: number;
  message: string;
  request_id?: string;
}

// ============================================================
// 基础工具
// ============================================================

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

/** 邮箱规范化: trim + 小写。不自行实现 gmail 点号/+tag 规则 */
export function normalizeEmail(email: string): string {
  return String(email ?? '').trim().toLowerCase();
}

const EMAIL_RE = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)*$/;
export function isValidEmail(email: string, maxLen = 190): boolean {
  if (!email || email.length > maxLen) return false;
  return EMAIL_RE.test(email);
}

export async function hmacHex(secret: string, data: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(data));
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/** 6 位数字验证码(crypto) */
export function genCode(): string {
  const buf = new Uint8Array(4);
  crypto.getRandomValues(buf);
  const n = ((buf[0] << 24) | (buf[1] << 16) | (buf[2] << 8) | buf[3]) >>> 0;
  return String(n % 1000000).padStart(CODE_LEN, '0');
}

/** 验证码哈希: HMAC(pepper, purpose:email:code:id) */
export async function codeHash(
  pepper: string,
  purpose: string,
  email: string,
  code: string,
  codeId: number,
): Promise<string> {
  return hmacHex(pepper, `${purpose}:${email}:${code}:${codeId}`);
}

/** 脱敏邮箱: 只留 @ 前首字符 + 域名 */
export function maskEmail(email: string): string {
  const at = email.indexOf('@');
  if (at <= 1) return '***';
  const name = email.slice(0, at);
  const dom = email.slice(at + 1);
  return `${name[0]}${'*'.repeat(Math.max(1, name.length - 1))}@${dom}`;
}

/** 客户端真实 IP: 只信 Cloudflare 给的 CF-Connecting-IP */
export function clientIp(req: Request): string {
  const cf = req.headers.get('CF-Connecting-IP');
  if (cf) return cf;
  const xff = req.headers.get('X-Forwarded-For');
  if (xff) return xff.split(',')[0].trim();
  return 'unknown';
}

export function genRequestId(): string {
  return crypto.randomUUID();
}

// ============================================================
// Turnstile 服务端校验
// ============================================================

export interface TurnstileOk {
  passed: boolean;
  message: string;
}

export function isTurnstileConfigured(env: Env): boolean {
  const secret = String((env as unknown as Record<string, string>)['TURNSTILE_SECRET_KEY'] ?? '').trim();
  const site = String((env as unknown as Record<string, string>)['TURNSTILE_SITE_KEY'] ?? '').trim();
  return !!(secret && site);
}

/**
 * 服务端校验: success + action + hostname 三者齐判。
 * 未配置 Secret → passed=false(表示"未启用", 调用方自行决定降级策略)。
 */
export async function verifyTurnstile(
  env: Env,
  token: string | undefined,
  expectedAction: string,
  req: Request,
): Promise<TurnstileOk> {
  const secret = String((env as unknown as Record<string, string>)['TURNSTILE_SECRET_KEY'] ?? '').trim();
  if (!secret) return { passed: false, message: 'TURNSTILE_NOT_CONFIGURED' };
  if (!token) return { passed: false, message: 'MISSING_TOKEN' };

  const body = new URLSearchParams({
    secret,
    response: token,
    remoteip: clientIp(req),
  });

  let result: Record<string, unknown>;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 10000);
    const resp = await fetch(TURNSTILE_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    result = (await resp.json()) as Record<string, unknown>;
  } catch {
    return { passed: false, message: 'VERIFY_SERVICE_DOWN' };
  }

  if (result.success !== true) return { passed: false, message: 'VERIFY_FAILED' };
  if (result.action !== expectedAction) return { passed: false, message: 'ACTION_MISMATCH' };

  const allowedRaw = String((env as unknown as Record<string, string>)['TURNSTILE_HOSTNAMES'] ?? '').trim();
  if (allowedRaw) {
    const allowed = allowedRaw.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
    const hn = String(result.hostname ?? '').toLowerCase();
    if (allowed.length > 0 && !allowed.includes(hn)) {
      return { passed: false, message: 'HOSTNAME_MISMATCH' };
    }
  }
  return { passed: true, message: 'ok' };
}

// ============================================================
// 限流(查 send_logs 表)
// ============================================================

async function rateLimitPass(
  env: Env,
  emailHash: string,
  ipHash: string,
): Promise<string | null> {
  const db = env.DB;
  const cooldownAt = new Date(Date.now() - EMAIL_COOLDOWN_SECONDS * 1000).toISOString();
  const windowAt = new Date(Date.now() - 10 * 60 * 1000).toISOString();

  const cooldown = await db
    .prepare(
      `SELECT 1 FROM email_verify_send_logs
        WHERE email_hash = ?1 AND created_at >= ?2 LIMIT 1`,
    )
    .bind(emailHash, cooldownAt)
    .first<{ 1: number }>();
  if (cooldown) return '验证码发送过于频繁，请稍后再试';

  const emailCnt = await db
    .prepare(
      `SELECT COUNT(*) AS c FROM email_verify_send_logs
        WHERE email_hash = ?1 AND created_at >= ?2`,
    )
    .bind(emailHash, windowAt)
    .first<{ c: number }>();
  if ((emailCnt?.c ?? 0) >= EMAIL_MAX_PER_10MIN) return '验证码发送过于频繁，请稍后再试';

  const ipCnt = await db
    .prepare(
      `SELECT COUNT(*) AS c FROM email_verify_send_logs
        WHERE client_ip_hash = ?1 AND created_at >= ?2`,
    )
    .bind(ipHash, windowAt)
    .first<{ c: number }>();
  if ((ipCnt?.c ?? 0) >= IP_MAX_PER_10MIN) return '验证码发送过于频繁，请稍后再试';

  return null;
}

// ============================================================
// 调邮件 Worker(可插拔: 未配 MAIL_WORKER_URL 且 DEBUG_MAIL=1 时假发)
// ============================================================

async function callMailWorker(
  env: Env,
  requestId: string,
  purpose: string,
  to: string,
  code: string,
): Promise<boolean> {
  const url = String((env as unknown as Record<string, string>)['MAIL_WORKER_URL'] ?? '').trim();
  const secret = String((env as unknown as Record<string, string>)['MAIL_WORKER_SECRET'] ?? '').trim();
  const debug = (env as unknown as Record<string, string>)['DEBUG_MAIL'] === '1';

  if (!url || !secret) {
    // 无邮件网关: 仅 DEBUG_MAIL=1 时"假装成功"(验证码会走 debug_code 回显), 否则失败
    return debug;
  }

  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${secret}`,
      },
      body: JSON.stringify({
        request_id: requestId,
        to,
        code,
        purpose,
        expire_minutes: CODE_EXPIRE_MINUTES,
      }),
    });
    if (!resp.ok) return false;
    const data = (await resp.json()) as { success?: boolean };
    return data.success === true;
  } catch {
    return false;
  }
}

// ============================================================
// 对外主入口: 发送验证码
// ============================================================

export async function sendVerifyCode(
  env: Env,
  emailRaw: string,
  purposeRaw: string,
  turnstileToken: string | undefined,
  req: Request,
): Promise<SendingResult> {
  const purpose = (purposeRaw || '').toUpperCase();
  if (!(VERIFY_PURPOSES as string[]).includes(purpose)) {
    return { ok: false, status: 400, message: '无效的验证码场景' };
  }
  const email = normalizeEmail(emailRaw);
  if (!isValidEmail(email)) return { ok: false, status: 400, message: '邮箱格式不正确' };

  // Turnstile(配置了才强制)
  if (isTurnstileConfigured(env)) {
    const v = await verifyTurnstile(env, turnstileToken, 'send_verify_code', req);
    if (!v.passed) {
      return {
        ok: false,
        status: 403,
        message: v.message === 'TURNSTILE_NOT_CONFIGURED' ? '请先完成安全验证' : '人机验证未通过',
      };
    }
  }

  const pepper = String((env as unknown as Record<string, string>)['VERIFY_CODE_PEPPER'] ?? '');
  const pepperKey = pepper || 'pepper-unset';

  // 同一份 hash, 全流程一致(含 purpose → 天然按场景限流)
  const emailHash = await hmacHex(pepperKey, `${purpose}:${email}`);
  const ipHash = await hmacHex(pepperKey, clientIp(req));

  // 限流
  const rateErr = await rateLimitPass(env, emailHash, ipHash);
  if (rateErr) return { ok: false, status: 429, message: rateErr };

  const requestId = genRequestId();
  const code = genCode();

  // 1. 先插 PENDING, 拿 id
  const expiresAt = new Date(Date.now() + CODE_EXPIRE_MINUTES * 60 * 1000).toISOString();
  const ins = await env.DB.prepare(
    `INSERT INTO email_verify_codes
       (request_id, email, email_normalized, purpose, code_hash, status, expires_at)
     VALUES (?1, ?2, ?3, ?4, '', 'PENDING', ?5)`,
  )
    .bind(requestId, email, email, purpose, expiresAt)
    .run();
  const codeId = Number(ins.meta?.last_row_id ?? 0);
  if (!codeId) return { ok: false, status: 500, message: '验证码创建失败，请稍后重试' };

  // 2. 补哈希
  const codeH = await codeHash(pepperKey, purpose, email, code, codeId);
  await env.DB.prepare(`UPDATE email_verify_codes SET code_hash = ?1 WHERE id = ?2`)
    .bind(codeH, codeId)
    .run();

  // 3. 发邮件
  const mailOk = await callMailWorker(env, requestId, purpose, email, code);

  if (!mailOk) {
    await env.DB.prepare(
      `UPDATE email_verify_codes SET status = 'FAILED', used_at = datetime('now') WHERE id = ?1`,
    ).bind(codeId).run();
    await env.DB.prepare(
      `INSERT INTO email_verify_send_logs (request_id, purpose, email_hash, client_ip_hash, status)
       VALUES (?1, ?2, ?3, ?4, 'FAILED')`,
    ).bind(requestId, purpose, emailHash, ipHash).run();
    return { ok: false, status: 500, message: '邮件发送失败，请稍后重试' };
  }

  // 4. 旧 ACTIVE 全部 INVALIDATED, 新码 ACTIVE
  await env.DB.prepare(
    `UPDATE email_verify_codes SET status = 'INVALIDATED', used_at = datetime('now')
      WHERE email_normalized = ?1 AND purpose = ?2 AND status = 'ACTIVE'`,
  )
    .bind(email, purpose)
    .run();
  await env.DB.prepare(
    `UPDATE email_verify_codes SET status = 'ACTIVE', activated_at = datetime('now') WHERE id = ?1`,
  ).bind(codeId).run();

  // 5. 发送日志
  await env.DB.prepare(
    `INSERT INTO email_verify_send_logs (request_id, purpose, email_hash, client_ip_hash, status)
     VALUES (?1, ?2, ?3, ?4, 'SENT')`,
  ).bind(requestId, purpose, emailHash, ipHash).run();

  const debugMail = (env as unknown as Record<string, string>)['DEBUG_MAIL'] === '1';
  return {
    ok: true,
    status: 200,
    sent: true,
    message: '验证码已发送',
    ...(debugMail ? { debug_code: code } : {}),
  };
}

// ============================================================
// 对外主流程: 验证码校验(注册等场景调用)
// ============================================================

export async function verifyCode(
  env: Env,
  emailRaw: string,
  purposeRaw: string,
  codeRaw: string,
): Promise<VerifyResult> {
  const purpose = (purposeRaw || '').toUpperCase();
  if (!(VERIFY_PURPOSES as string[]).includes(purpose)) {
    return { ok: false, status: 400, message: '无效的验证码场景' };
  }
  const email = normalizeEmail(emailRaw);
  if (!isValidEmail(email)) return { ok: false, status: 400, message: '邮箱格式不正确' };

  const row = await env.DB.prepare(
    `SELECT id, code_hash, status, attempts, expires_at, request_id
       FROM email_verify_codes
      WHERE email_normalized = ?1 AND purpose = ?2
      ORDER BY id DESC LIMIT 1`,
  )
    .bind(email, purpose)
    .first<{
      id: number;
      code_hash: string;
      status: string;
      attempts: number;
      expires_at: string;
      request_id: string;
    }>();

  if (!row) return { ok: false, status: 400, message: '验证码错误，请重新输入' };

  const nowIso = new Date().toISOString();
  const expired = !row.expires_at || row.expires_at <= nowIso;
  if (row.status === 'ACTIVE' && expired) {
    await env.DB.prepare(`UPDATE email_verify_codes SET status = 'EXPIRED' WHERE id = ?1`).bind(row.id).run();
    return { ok: false, status: 409, message: '验证码已过期，请重新获取' };
  }
  if (row.status === 'USED') return { ok: false, status: 409, message: '验证码已被使用' };
  if (row.status !== 'ACTIVE') return { ok: false, status: 409, message: '验证码无效，请重新获取' };

  const attempt = Number(row.attempts ?? 0);
  const submit = String(codeRaw ?? '').trim();
  if (!/^\d{6}$/.test(submit)) {
    return { ok: false, status: 400, message: '验证码格式不正确' };
  }

  const pepper = String((env as unknown as Record<string, string>)['VERIFY_CODE_PEPPER'] ?? '');
  const pepperKey = pepper || 'pepper-unset';
  const expected = await codeHash(pepperKey, purpose, email, submit, Number(row.id));
  if (expected !== row.code_hash) {
    const next = attempt + 1;
    if (next >= MAX_ATTEMPTS) {
      await env.DB.prepare(
        `UPDATE email_verify_codes SET attempts = ?1, status = 'FAILED' WHERE id = ?2`,
      ).bind(next, row.id).run();
      return { ok: false, status: 429, message: '验证码已失效，请重新获取' };
    }
    await env.DB.prepare(`UPDATE email_verify_codes SET attempts = ?1 WHERE id = ?2`).bind(next, row.id).run();
    return { ok: false, status: 400, message: '验证码错误，请重新输入' };
  }

  await env.DB.prepare(
    `UPDATE email_verify_codes SET status = 'USED', used_at = datetime('now') WHERE id = ?1`,
  ).bind(row.id).run();

  return { ok: true, status: 200, message: 'ok', request_id: row.request_id };
}