/**
 * AccountCoordinator —— Durable Object
 *
 * 替代上游依赖 Redis 的三类原子操作:
 *   1. 粘性会话      sticky_session:{groupID}:{hash}   (gateway_scheduling.go:100)
 *   2. 并发槽位      concurrency:account:{id} ZSET     (concurrency_service.go)
 *   3. RPM 计数      rpm:{accountID}:{minute}          (rpm_cache.go)
 *
 * 为什么必须用 DO 而不是 KV:
 *   - KV 最终一致, 不支持原子 INCR / ZSET, 并发计数会算错
 *   - DO 天然单线程串行, 且 < 1s 的 await 不会被中断, 可安全做"检查-占用"逻辑
 */

import { WINDOW_5H_MS } from './billing';

interface SlotEntry {
  requestId: string;
  expiresAt: number;
}

interface StickyEntry {
  accountId: number;
  expiresAt: number;
}

/** 粘性会话 TTL —— 上游 stickySessionTTL = 1h */
const STICKY_TTL_MS = 60 * 60 * 1000;
/** 并发槽位 TTL —— 上游默认 15 分钟 */
const SLOT_TTL_MS = 15 * 60 * 1000;

export class AccountCoordinator implements DurableObject {
  private state: DurableObjectState;

  constructor(state: DurableObjectState) {
    this.state = state;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const op = url.pathname;

    try {
      switch (op) {
        case '/sticky/get':
          return await this.stickyGet(url);
        case '/sticky/set':
          return await this.stickySet(url, request);
        case '/slot/acquire':
          return await this.slotAcquire(url, request);
        case '/slot/release':
          return await this.slotRelease(request);
        case '/rpm/incr':
          return await this.rpmIncr(url);
        case '/sticky/clear':
          return await this.stickyClear();
        case '/stats':
          return await this.stats();
        default:
          return json({ error: 'unknown op' }, 404);
      }
    } catch (e) {
      return json({ error: (e as Error).message }, 500);
    }
  }

  /** 读粘性会话映射 */
  private async stickyGet(url: URL): Promise<Response> {
    const hash = url.searchParams.get('hash') ?? '';
    const entry = await this.state.storage.get<StickyEntry>(`sticky:${hash}`);
    if (!entry) return json({ accountId: null });
    if (entry.expiresAt < Date.now()) {
      await this.state.storage.delete(`sticky:${hash}`);
      return json({ accountId: null });
    }
    // 命中即刷新 TTL (上游行为)
    entry.expiresAt = Date.now() + STICKY_TTL_MS;
    await this.state.storage.put(`sticky:${hash}`, entry);
    return json({ accountId: entry.accountId });
  }

  /** 写粘性会话映射 */
  private async stickySet(url: URL, request: Request): Promise<Response> {
    const hash = url.searchParams.get('hash') ?? '';
    const accountId = Number(url.searchParams.get('accountId') ?? 0);
    await this.state.storage.put<StickyEntry>(`sticky:${hash}`, {
      accountId,
      expiresAt: Date.now() + STICKY_TTL_MS,
    });
    return json({ ok: true });
  }

  /**
   * 抢并发槽位
   * 对应上游 AcquireAccountSlot: 满则拒绝(调用方决定是否排队)
   */
  private async slotAcquire(url: URL, request: Request): Promise<Response> {
    const requestId = url.searchParams.get('requestId') ?? '';
    const max = Number(url.searchParams.get('max') ?? 0);

    const slots = (await this.state.storage.get<SlotEntry[]>('slots')) ?? [];
    const now = Date.now();
    // 清理过期槽位 —— 对应上游 CleanupExpiredAccountSlots
    const live = slots.filter((s) => s.expiresAt > now);

    if (max > 0 && live.length >= max) {
      // 顺手把清理结果写回, 避免无限增长
      if (live.length !== slots.length) {
        await this.state.storage.put('slots', live);
      }
      return json({ acquired: false, active: live.length, max });
    }

    live.push({ requestId, expiresAt: now + SLOT_TTL_MS });
    await this.state.storage.put('slots', live);

    // 设置 DO 级 alarm 兜底清理, 防止槽位泄漏
    await this.state.storage.setAlarm(now + SLOT_TTL_MS + 1000);

    return json({ acquired: true, active: live.length, max });
  }

  /** 释放并发槽位 */
  private async slotRelease(request: Request): Promise<Response> {
    const body = (await request.json().catch(() => ({}))) as { requestId?: string };
    const requestId = body.requestId ?? '';
    const slots = (await this.state.storage.get<SlotEntry[]>('slots')) ?? [];
    const live = slots.filter((s) => s.requestId !== requestId && s.expiresAt > Date.now());
    await this.state.storage.put('slots', live);
    return json({ ok: true, active: live.length });
  }

  /**
   * RPM 计数
   * 对应上游 rpm:{accountID}:{minute}, 固定分钟窗口
   */
  private async rpmIncr(url: URL): Promise<Response> {
    const limit = Number(url.searchParams.get('limit') ?? 0);
    const minuteKey = `rpm:${Math.floor(Date.now() / 60000)}`;
    const current = (await this.state.storage.get<number>(minuteKey)) ?? 0;

    if (limit > 0 && current >= limit) {
      return json({ allowed: false, count: current, limit });
    }
    await this.state.storage.put(minuteKey, current + 1);
    return json({ allowed: true, count: current + 1, limit });
  }

  /**
   * 清空本账号上的所有粘性会话
   * 场景: 管理员在后台改了账号配置(换 key / 停用 / 调优先级)后, 旧粘性会话
   * 仍会把这批请求钉在原账号上, 直到 1h TTL 过期。这里提供主动失效入口。
   */
  private async stickyClear(): Promise<Response> {
    const entries = await this.state.storage.list<StickyEntry>({ prefix: 'sticky:' });
    const keys = Array.from(entries.keys());
    if (keys.length > 0) await this.state.storage.delete(keys);
    return json({ ok: true, cleared: keys.length });
  }

  private async stats(): Promise<Response> {
    const slots = (await this.state.storage.get<SlotEntry[]>('slots')) ?? [];
    const now = Date.now();
    return json({
      activeSlots: slots.filter((s) => s.expiresAt > now).length,
      ttlConstants: { stickyTtlMs: STICKY_TTL_MS, slotTtlMs: SLOT_TTL_MS, window5hMs: WINDOW_5H_MS },
    });
  }

  /** alarm 兜底: 清理过期槽位 */
  async alarm(): Promise<void> {
    const slots = (await this.state.storage.get<SlotEntry[]>('slots')) ?? [];
    const now = Date.now();
    const live = slots.filter((s) => s.expiresAt > now);
    await this.state.storage.put('slots', live);
    if (live.length > 0) {
      await this.state.storage.setAlarm(now + SLOT_TTL_MS + 1000);
    }
  }
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
