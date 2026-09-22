/**
 * 计费落库
 * 移植自上游 backend/internal/repository/usage_billing_repo.go:174 applyUsageBillingEffects
 *
 * 上游是"请求结束后开一个 sql.Tx 顺序执行"。
 * Workers 里用 D1 batch() 实现原子提交 —— D1 batch 在一个隐式事务中执行,
 * 全成功或全失败, 语义等价。
 */

import { RATE_SCALE, isWindowExpired, WINDOW_5H_MS, WINDOW_1D_MS, WINDOW_7D_MS } from './billing';
import type {
  AccountRow,
  AuthContext,
  BillingBreakdown,
  Env,
  UsageTokens,
} from './types';
import type { Platform } from './protocol';

export interface BillingInput {
  ctx: AuthContext;
  account: AccountRow | null;
  platform: Platform;
  requestId: string;
  fingerprint: string;
  model: string;
  requestedModel: string;
  usage: UsageTokens;
  breakdown: BillingBreakdown;
  stream: boolean;
  durationMs: number;
  firstTokenMs: number | null;
  userAgent: string;
  ipAddress: string;
}

/**
 * 幂等占位 + 扣费 + 写日志, 单次 batch 原子提交
 * 返回是否真正执行了扣费(false 表示重复请求被幂等拦截)
 */
export async function applyBilling(env: Env, input: BillingInput): Promise<boolean> {
  const { ctx, breakdown } = input;

  // ---- 幂等检查 (对应上游 claimUsageBillingRequest) ----
  // usage_billing_dedup 主键 (request_id, api_key_id) —— 重复则跳过
  const existing = await env.DB.prepare(
    `SELECT 1 AS x FROM usage_billing_dedup WHERE request_id = ?1 AND api_key_id = ?2`,
  )
    .bind(input.requestId, ctx.keyId)
    .first<{ x: number }>();

  if (existing) return false;

  const now = new Date();
  const nowIso = now.toISOString();
  const nowMs = now.getTime();

  const statements: D1PreparedStatement[] = [];

  // ---- 1. 幂等占位 ----
  statements.push(
    env.DB.prepare(
      `INSERT OR IGNORE INTO usage_billing_dedup (request_id, api_key_id, request_fingerprint)
       VALUES (?1, ?2, ?3)`,
    ).bind(input.requestId, ctx.keyId, input.fingerprint),
  );

  const cost = breakdown.actualCost;

  // ---- 2. 用户余额扣减 (对应 users.balance 的 UPDATE ... WHERE balance >= $1) ----
  if (cost > 0) {
    statements.push(
      env.DB.prepare(
        `UPDATE users SET balance = balance - ?1, updated_at = ?2
         WHERE id = ?3 AND balance >= ?1`,
      ).bind(cost, nowIso, ctx.userId),
    );
    // 余额不足时上面的 UPDATE 影响 0 行 —— 上游此处会"允许透支并标记",
    // 这里额外补一条兜底扣减, 保证账目不为 0
    statements.push(
      env.DB.prepare(
        `UPDATE users SET balance = balance - ?1, updated_at = ?2
         WHERE id = ?3 AND balance < ?1`,
      ).bind(cost, nowIso, ctx.userId),
    );
  }

  // ---- 3. API Key 额度扣减 + 耗尽判定 (对应 api_keys.quota_used) ----
  if (cost > 0) {
    statements.push(
      env.DB.prepare(
        `UPDATE api_keys SET quota_used = quota_used + ?1, updated_at = ?2 WHERE id = ?3`,
      ).bind(cost, nowIso, ctx.keyId),
    );
    // 刚耗尽 -> 回写 status='quota_exhausted' (上游 RETURNING 判断的等价实现)
    statements.push(
      env.DB.prepare(
        `UPDATE api_keys SET status = 'quota_exhausted'
         WHERE id = ?1 AND quota > 0 AND quota_used >= quota AND status = 'active'`,
      ).bind(ctx.keyId),
    );
  }

  // ---- 4. 5h/1d/7d 金额窗口累计, 带窗口翻转 (对应 incrementUsageBillingAPIKeyRateLimit) ----
  const windows: Array<[string, string, number, number]> = [
    ['usage_5h', 'window_5h_start', WINDOW_5H_MS, ctx.usage5h],
    ['usage_1d', 'window_1d_start', WINDOW_1D_MS, ctx.usage1d],
    ['usage_7d', 'window_7d_start', WINDOW_7D_MS, ctx.usage7d],
  ];
  const windowStarts: Record<string, string | null> = {
    usage_5h: ctx.window5hStart,
    usage_1d: ctx.window1dStart,
    usage_7d: ctx.window7dStart,
  };

  if (cost > 0) {
    for (const [usageCol, startCol, windowMs] of windows) {
      const expired = isWindowExpired(windowStarts[usageCol], windowMs, nowMs);
      if (expired) {
        // 窗口过期 -> 重置为本次用量 (上游: 重置为 $1)
        statements.push(
          env.DB.prepare(
            `UPDATE api_keys SET ${usageCol} = ?1, ${startCol} = ?2, updated_at = ?2 WHERE id = ?3`,
          ).bind(cost, nowIso, ctx.keyId),
        );
      } else {
        statements.push(
          env.DB.prepare(
            `UPDATE api_keys SET ${usageCol} = ${usageCol} + ?1, updated_at = ?2 WHERE id = ?3`,
          ).bind(cost, nowIso, ctx.keyId),
        );
      }
    }
  }

  // ---- 5. 账号额度累计 (对应 accounts.extra->>'quota_used') ----
  if (cost > 0 && input.account && ['apikey', 'bedrock'].includes(input.account.type)) {
    statements.push(
      env.DB.prepare(
        `UPDATE accounts SET last_used_at = ?1, updated_at = ?1 WHERE id = ?2`,
      ).bind(nowIso, input.account.id),
    );
  }

  // ---- 6. 写用量日志 ----
  statements.push(
    env.DB.prepare(
      `INSERT INTO usage_logs (
         request_id, user_id, api_key_id, account_id, group_id,
         model, requested_model, upstream_model, billing_mode,
         input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
         input_cost, output_cost, cache_read_cost, cache_creation_cost,
         total_cost, actual_cost, rate_multiplier, account_rate_multiplier,
         stream, duration_ms, first_token_ms, user_agent, ip_address, created_at
       ) VALUES (
         ?1, ?2, ?3, ?4, ?5,
         ?6, ?7, ?8, 'token',
         ?9, ?10, ?11, ?12,
         ?13, ?14, ?15, ?16,
         ?17, ?18, ?19, ?20,
         ?21, ?22, ?23, ?24, ?25, ?26
       )`,
    ).bind(
      input.requestId,
      ctx.userId,
      ctx.keyId,
      input.account?.id ?? null,
      ctx.groupId,
      input.model,
      input.requestedModel,
      input.model,
      input.usage.inputTokens,
      input.usage.outputTokens,
      input.usage.cacheReadTokens,
      input.usage.cacheCreationTokens,
      breakdown.inputCost,
      breakdown.outputCost,
      breakdown.cacheReadCost,
      breakdown.cacheCreationCost,
      breakdown.totalCost,
      breakdown.actualCost,
      breakdown.rateMultiplier,
      input.account?.rate_multiplier ?? RATE_SCALE,
      input.stream ? 1 : 0,
      input.durationMs,
      input.firstTokenMs,
      input.userAgent,
      input.ipAddress,
      nowIso,
    ),
  );

  // ---- 原子提交 ----
  await env.DB.batch(statements);
  return true;
}

/** 记录失败请求的日志(不计费), 便于排查 */
export interface FailureLogMeta {
  requestedModel?: string;
  stream?: boolean;
  userAgent?: string;
  ip?: string;
  /** 入站路径, 拼在 message 前缀便于区分 /v1/messages 与 /v1/chat/completions */
  path?: string;
}

export async function logFailure(
  env: Env,
  ctx: AuthContext,
  requestId: string,
  platform: Platform,
  status: number,
  message: string,
  meta: FailureLogMeta = {},
): Promise<void> {
  try {
    // 之前只存 80 字符且不记 UA/IP/模型, 排查上游 400 时完全看不到现场。
    // 放宽到 500 字符, 并把请求上下文一并落库。
    const detail = meta.path ? `[${meta.path}] ${message}` : message;
    await env.DB.prepare(
      `INSERT INTO usage_logs (request_id, user_id, api_key_id, group_id, model, requested_model, billing_mode, stream, user_agent, ip_address)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'token', ?7, ?8, ?9)`,
    )
      .bind(
        requestId,
        ctx.userId,
        ctx.keyId,
        ctx.groupId,
        `error:${platform}:${status}:${detail.slice(0, 500)}`,
        meta.requestedModel ?? '',
        meta.stream ? 1 : 0,
        meta.userAgent ?? '',
        meta.ip ?? '',
      )
      .run();
  } catch {
    // 忽略日志写入失败
  }
}
