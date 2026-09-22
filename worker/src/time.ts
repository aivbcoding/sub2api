/**
 * 时间戳解析 —— 统一处理 D1/SQLite 与 JS 两种写法
 *
 * 背景(踩过的坑):
 *   SQLite 的 `datetime('now')` 产出 `YYYY-MM-DD HH:MM:SS`, **是 UTC 但没有时区后缀**。
 *   而 JS 的 `Date.parse('2026-09-20 05:38:33')` 会按**本地时区**解释它。
 *   一旦运行环境不是 UTC(本地 wrangler dev 在 UTC+8 就会), 时间就整体偏移,
 *   最直接的后果是**账号限流冷却形同虚设**(429 后本该冷却 60s, 实际算出"早就过期了")。
 *
 *   生产环境 Cloudflare workerd 的 TZ=UTC 侥幸不出问题, 属于隐性依赖运行环境,
 *   这里显式补上 `T`/`Z` 后缀, 让行为与运行环境无关。
 */

/** 解析为毫秒时间戳; 无法解析返回 null */
export function parseDbTime(value: string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  if (!s) return null;

  // `2026-09-20 05:38:33` / `2026-09-20 05:38:33.123` -> ISO UTC
  const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2}(?:\.\d+)?)$/.exec(s);
  const normalized = m ? `${m[1]}T${m[2]}Z` : s;

  const t = Date.parse(normalized);
  return Number.isNaN(t) ? null : t;
}

/** 该时间戳是否仍在未来(即还没到期) */
export function isFuture(value: string | null | undefined, now: number = Date.now()): boolean {
  const t = parseDbTime(value);
  return t !== null && now < t;
}

/** 该时间戳是否已经过去(含无法解析的情况 —— 无法解析视为已过期更安全) */
export function isPast(value: string | null | undefined, now: number = Date.now()): boolean {
  const t = parseDbTime(value);
  return t === null || now >= t;
}
