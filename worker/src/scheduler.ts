/**
 * 上游账号调度
 * 移植自上游:
 *   - gateway_scheduling.go:100       SelectAccountWithLoadAwareness
 *   - openai_account_scheduler.go:1023 候选打分公式
 *
 * 分层策略 (与上游一致):
 *   1. 粘性会话命中 -> 校验仍可用 -> 直接用
 *   2. 加权打分排序 -> topK -> 抢并发槽位
 *   3. 兜底: 按 priority 升序 -> LoadRate 升序 -> ID 升序
 */

import type { AccountRow, AuthContext, Env } from './types';
import type { Platform } from './protocol';
import { isFuture, parseDbTime } from './time';

export interface SelectedAccount {
  account: AccountRow;
  sticky: boolean;
}

/** 判断账号当前是否可调度 —— 对应上游 IsSchedulable + 各类冷却检查 */
function isSchedulable(a: AccountRow, now: number = Date.now()): boolean {
  if (a.status !== 'active') return false;
  if (a.schedulable !== 1) return false;

  // 429 冷却 (rate_limited_at / rate_limit_reset_at)
  if (isFuture(a.rate_limit_reset_at, now)) return false;
  // 529 过载冷却
  if (isFuture(a.overload_until, now)) return false;
  // 临时不可调度
  if (isFuture(a.temp_unschedulable_until, now)) return false;
  return true;
}

/** 有效并发上限 —— 上游 EffectiveLoadFactor() */
function effectiveLoadFactor(a: AccountRow): number {
  return a.load_factor && a.load_factor > 0 ? a.load_factor : a.concurrency;
}

/** 请求粘性哈希 —— 上游用会话特征(如首条 user 消息)算 hash */
export async function computeSessionHash(body: string, userId: number): Promise<string> {
  const data = new TextEncoder().encode(`${userId}:${body}`);
  const digest = await crypto.subtle.digest('SHA-256', data);
  const bytes = new Uint8Array(digest).slice(0, 8);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/** 账号何时恢复可调度: 取所有冷却时间里的最晚一个, 没有则 null */
function nextSchedulableAt(a: AccountRow, now: number): number | null {
  let latest: number | null = null;
  for (const s of [a.rate_limit_reset_at, a.overload_until, a.temp_unschedulable_until]) {
    const t = parseDbTime(s);
    if (t === null || t <= now) continue;
    if (latest === null || t > latest) latest = t;
  }
  return latest;
}

/** 按分组+平台查账号(不做可调度过滤) */
async function queryAccounts(
  env: Env,
  groupId: number | null,
  platform: Platform,
): Promise<AccountRow[]> {
  let rows: AccountRow[];

  if (groupId !== null) {
    const res = await env.DB.prepare(
      `SELECT a.* FROM accounts a
       JOIN account_groups ag ON ag.account_id = a.id
       WHERE ag.group_id = ?1
         AND a.platform = ?2
         AND a.deleted_at IS NULL
       ORDER BY ag.priority ASC, a.priority ASC`,
    )
      .bind(groupId, platform)
      .all<AccountRow>();
    rows = res.results ?? [];
  } else {
    const res = await env.DB.prepare(
      `SELECT * FROM accounts
       WHERE platform = ?1 AND deleted_at IS NULL
       ORDER BY priority ASC, id ASC`,
    )
      .bind(platform)
      .all<AccountRow>();
    rows = res.results ?? [];
  }

  return rows;
}

/** 读取候选账号 */
export async function loadCandidateAccounts(
  env: Env,
  groupId: number | null,
  platform: Platform,
): Promise<AccountRow[]> {
  const rows = await queryAccounts(env, groupId, platform);
  return rows.filter((a) => isSchedulable(a));
}

export interface UnavailableDiagnosis {
  /** 该平台下共有多少账号(含冷却中/停用的) */
  totalAccounts: number;
  /** 全部账号都是"冷却中"时, 最早恢复可用的毫秒数; 其它情况为 null */
  retryAfterMs: number | null;
}

/**
 * 诊断「没有可用账号」的真实原因。
 *
 * 之前所有情况统一返回 503 no_available_account,
 * 导致「配额用尽正在冷却」和「压根没配账号」这两种完全不同的故障长得一模一样,
 * 使用者无从判断是该等一会儿还是该去后台加账号。
 */
export async function diagnoseUnavailable(
  env: Env,
  groupId: number | null,
  platform: Platform,
): Promise<UnavailableDiagnosis> {
  const rows = await queryAccounts(env, groupId, platform);
  if (rows.length === 0) return { totalAccounts: 0, retryAfterMs: null };

  const now = Date.now();
  const active = rows.filter((a) => a.status === 'active' && a.schedulable === 1);
  if (active.length === 0) return { totalAccounts: rows.length, retryAfterMs: null };

  // 全是冷却中 -> 给出最早恢复时间
  const recoveries: number[] = [];
  for (const a of active) {
    const t = nextSchedulableAt(a, now);
    if (t === null) return { totalAccounts: rows.length, retryAfterMs: null }; // 有账号不是冷却, 原因在别处
    recoveries.push(t);
  }
  if (recoveries.length === 0) return { totalAccounts: rows.length, retryAfterMs: null };
  return { totalAccounts: rows.length, retryAfterMs: Math.min(...recoveries) - now };
}

/** DO stub 辅助 */
function coordinatorStub(env: Env, accountId: number): DurableObjectStub {
  return env.ACCOUNT_COORDINATOR.get(env.ACCOUNT_COORDINATOR.idFromName(`account:${accountId}`));
}

/**
 * 选号主流程
 * 移植自 SelectAccountWithLoadAwareness
 */
export async function selectAccount(
  env: Env,
  ctx: AuthContext,
  platform: Platform,
  sessionHash: string,
  requestId: string,
  /**
   * 优先选这个账号 —— 来自"自动发现"命中的账号(该账号的模型索引/别名表里
   * 明确声明了这次请求的模型名)。
   *
   * 为什么需要它: 平台下可能有多个账号(例如两个中转都填了同一个平台名),
   * 但只有其中一个声明了当前模型。不锁账号就会按负载/优先级随便挑,
   * 挑到没声明的那个 -> 模型别名不生效 + base_url 也不是用户配的那个, 上游 404。
   */
  preferAccountId: number | null = null,
  /**
   * **硬锁**这个账号 —— 来自「入口路径」(请求 URL 第一段直接指定上游)。
   *
   * 与 preferAccountId 的区别: 后者只是"优先", 抢不到槽位就退化成普通调度;
   * 这里必须**非它不可** —— URL 已经明说了走这条上游, 悄悄换一条等于把请求
   * 发到用户根本没指定的 base_url 上(别名也不会生效), 比报错更糟。
   *
   * 抢不到槽位/不在分组内/已停用 一律返回 null, 由调用方给出明确报错。
   */
  lockedAccountId: number | null = null,
): Promise<SelectedAccount | null> {
  const candidates = await loadCandidateAccounts(env, ctx.groupId, platform);
  if (candidates.length === 0) return null;

  const groupKey = ctx.groupId ?? 0;

  // ---- -1. 入口路径硬锁 (优先级高于一切) ----
  if (lockedAccountId !== null) {
    const locked = candidates.find((a) => a.id === lockedAccountId);
    if (!locked) return null;
    const acquired = await tryAcquire(env, locked, requestId);
    return acquired ? { account: locked, sticky: false } : null;
  }

  // ---- 0. 声明了该模型的账号优先 ----
  // 放在粘性之前: 粘性 hash 含请求体(含模型名), 同一模型本来就会一直粘住,
  // 而"只有这个账号声明了它"是更强的事实, 不该被上一次的粘性覆盖。
  // 抢不到槽位时**不硬失败**, 继续走粘性/打分 —— 满负荷时退化成普通调度即可。
  if (preferAccountId !== null) {
    const pinned = candidates.find((a) => a.id === preferAccountId);
    if (pinned) {
      const acquired = await tryAcquire(env, pinned, requestId);
      if (acquired) {
        const stub = coordinatorStub(env, pinned.id);
        await stub.fetch(
          `https://do/sticky/set?hash=${encodeURIComponent(`${groupKey}:${sessionHash}`)}&accountId=${pinned.id}`,
        );
        return { account: pinned, sticky: false };
      }
    }
  }

  // ---- 1. 粘性会话 ----
  for (const cand of candidates) {
    const stub = coordinatorStub(env, cand.id);
    const res = await stub.fetch(
      `https://do/sticky/get?hash=${encodeURIComponent(`${groupKey}:${sessionHash}`)}`,
    );
    const data = (await res.json()) as { accountId: number | null };
    if (data.accountId !== null && data.accountId === cand.id) {
      const acquired = await tryAcquire(env, cand, requestId);
      if (acquired) return { account: cand, sticky: true };
    }
  }

  // ---- 2. 加权打分排序 ----
  // 对应 openai_account_scheduler.go:1023
  //   score = w.Priority*priorityFactor + w.Load*loadFactor + w.Queue*queueFactor
  // 这里简化为 priority(越小越优) + 当前负载率(越小越优)
  const scored = await Promise.all(
    candidates.map(async (a) => {
      const stub = coordinatorStub(env, a.id);
      const res = await stub.fetch(`https://do/stats`);
      const stats = (await res.json()) as { activeSlots: number };
      const max = effectiveLoadFactor(a);
      const loadRate = max > 0 ? stats.activeSlots / max : 0;
      return { account: a, loadRate };
    }),
  );

  scored.sort((x, y) => {
    if (x.loadRate !== y.loadRate) return x.loadRate - y.loadRate;
    if (x.account.priority !== y.account.priority) {
      return x.account.priority - y.account.priority;
    }
    return x.account.id - y.account.id;
  });

  // ---- 3. 依次抢槽位, 首个成功者胜出 ----
  for (const s of scored) {
    const acquired = await tryAcquire(env, s.account, requestId);
    if (acquired) {
      const stub = coordinatorStub(env, s.account.id);
      await stub.fetch(
        `https://do/sticky/set?hash=${encodeURIComponent(`${groupKey}:${sessionHash}`)}&accountId=${s.account.id}`,
      );
      return { account: s.account, sticky: false };
    }
  }

  return null;
}

/** 尝试占用账号并发槽位 */
async function tryAcquire(env: Env, account: AccountRow, requestId: string): Promise<boolean> {
  const max = effectiveLoadFactor(account);
  const stub = coordinatorStub(env, account.id);
  const res = await stub.fetch(
    `https://do/slot/acquire?requestId=${encodeURIComponent(requestId)}&max=${max}`,
  );
  const data = (await res.json()) as { acquired: boolean };
  return data.acquired === true;
}

/** 释放账号并发槽位 */
export async function releaseAccount(env: Env, accountId: number, requestId: string): Promise<void> {
  try {
    const stub = coordinatorStub(env, accountId);
    await stub.fetch('https://do/slot/release', {
      method: 'POST',
      body: JSON.stringify({ requestId }),
    });
  } catch {
    // 静默: 槽位 TTL 会自动回收
  }
}

/** 账号级 RPM 检查 —— 上游 rpm_cache.go */
export async function checkAccountRpm(
  env: Env,
  accountId: number,
  limit: number,
): Promise<boolean> {
  if (limit <= 0) return true;
  const stub = coordinatorStub(env, accountId);
  const res = await stub.fetch(`https://do/rpm/incr?limit=${limit}`);
  const data = (await res.json()) as { allowed: boolean };
  return data.allowed === true;
}
