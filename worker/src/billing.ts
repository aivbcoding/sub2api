/**
 * 计费模块
 * 移植自上游:
 *   - billing_service.go:1451 calculateTokenCost
 *   - billing_service.go:1507 computeTokenBreakdown
 *   - usage_billing_repo.go:174  applyUsageBillingEffects  (扣费事务)
 *   - api_key.go:26 IsWindowExpired                          (窗口翻转)
 *
 * 金额单位统一为"微美元"(micro-USD), 1 USD = 1e8。
 * 上游用 NUMERIC(20,8) 并存 8 位小数; 这里用整数微美元避免浮点误差。
 */

import type { AuthContext, BillingBreakdown, ModelPrice, UsageTokens } from './types';
import { parseDbTime } from './time';

/** 倍率定点基数, 1.0 = 1e8 */
export const RATE_SCALE = 100_000_000;

/** 模型单价定点基数: 微美元 / token */
export const PRICE_SCALE = 1;

/** 5h/1d/7d 窗口 —— 上游 api_key.go 常量 */
export const WINDOW_5H_MS = 5 * 60 * 60 * 1000;
export const WINDOW_1D_MS = 24 * 60 * 60 * 1000;
export const WINDOW_7D_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * 计算 token 成本
 * 移植自 billing_service.go:1451
 *
 *   InputCost         = text_input_tokens  x input_price
 *   OutputCost        = text_output_tokens x output_price
 *   CacheReadCost     = cache_read_tokens  x cache_read_price
 *   CacheCreationCost = cache_creation_tokens x cache_creation_price
 *   TotalCost  = 四者之和
 *   ActualCost = TotalCost x rateMultiplier
 *
 * @param price 微美元/token 单价
 * @param rateMultiplier 定点倍率 (1e8 = 1.0)
 */
export function computeTokenBreakdown(
  usage: UsageTokens,
  price: ModelPrice,
  rateMultiplier: number,
): BillingBreakdown {
  const inputCost = usage.inputTokens * price.input_price * PRICE_SCALE;
  const outputCost = usage.outputTokens * price.output_price * PRICE_SCALE;
  const cacheReadCost = usage.cacheReadTokens * price.cache_read_price * PRICE_SCALE;
  const cacheCreationCost =
    usage.cacheCreationTokens * price.cache_creation_price * PRICE_SCALE;

  const totalCost = inputCost + outputCost + cacheReadCost + cacheCreationCost;

  // 倍率是定点整数, 乘法后再除回
  const actualCost = Math.round((totalCost * rateMultiplier) / RATE_SCALE);

  return {
    inputCost,
    outputCost,
    cacheReadCost,
    cacheCreationCost,
    totalCost,
    actualCost,
    rateMultiplier,
  };
}

/**
 * 「默认单价」的**出厂值**。
 *
 * ⚠️ 这不是"藏在代码里的定价"：它只给可配置的默认单价兜一个初始值，
 * 控制台「模型定价」页会把它显示出来、并可随时改（存 `settings.model_pricing_default`）。
 *
 * 用户的要求是「API 请求花费严格走控制台的定价」，所以价格来源**只有两处**：
 *   1. `model_pricing` 表里逐模型配的价（定价页那张表）
 *   2. 定价页上的「默认单价」（没单独配价的模型走它）
 * 代码里**不再有**按模型名硬编码的价格表，也没有 3/15 那种隐性兜底。
 */
export const DEFAULT_PRICE: ModelPrice = {
  input_price: 3,
  output_price: 15,
  cache_read_price: 0,
  cache_creation_price: 0,
};

/** 默认单价在 `settings` 表里的键 */
export const DEFAULT_PRICE_SETTING = 'model_pricing_default';

/**
 * 解析模型单价。
 *
 * 优先级（**只有这两级**）：
 *   1. `model_pricing` 表 —— 控制台「模型定价」页逐模型配的价
 *   2. `defaultPrice` —— 定价页上的「默认单价」
 *
 * 🚨 分组对价格的影响**不再是一张独立的价目表**（`groups.model_pricing` 已停用），
 * 而是乘在最终金额上的**倍率**：`combineRateMultiplier(groupRate, accountRate)`。
 * 换句话说：先按本表算出基础金额，再乘分组倍率 × 账号倍率。
 */
export function resolveModelPrice(
  model: string,
  dbPricing: Map<string, ModelPrice>,
  defaultPrice: ModelPrice,
): ModelPrice {
  const candidates = [model];
  // 去掉日期后缀再试一次, 如 claude-sonnet-4-20250514 -> claude-sonnet-4
  const stripped = model.replace(/-\d{8}$/, '');
  if (stripped !== model) candidates.push(stripped);

  for (const m of candidates) {
    const db = dbPricing.get(m);
    if (db) return db;
  }
  return defaultPrice;
}

/**
 * 解析 `settings.model_pricing_default` 里存的默认单价 JSON。
 * 缺失 / 坏数据 / 某个字段非数字 —— 一律**逐字段**回退到出厂值，
 * 不要整体丢弃（部分写入时只坏一个字段的概率更高）。
 */
export function parseDefaultPrice(raw: string | null | undefined): ModelPrice {
  if (raw === null || raw === undefined || String(raw).trim() === '') return DEFAULT_PRICE;
  try {
    const o = JSON.parse(String(raw)) as Record<string, unknown>;
    const num = (v: unknown, fallback: number): number => {
      const n = Number(v);
      return Number.isFinite(n) ? n : fallback;
    };
    return {
      input_price: num(o.input_price, DEFAULT_PRICE.input_price),
      output_price: num(o.output_price, DEFAULT_PRICE.output_price),
      cache_read_price: num(o.cache_read_price, DEFAULT_PRICE.cache_read_price),
      cache_creation_price: num(o.cache_creation_price, DEFAULT_PRICE.cache_creation_price),
    };
  } catch {
    return DEFAULT_PRICE;
  }
}

/** 总倍率 = 分组倍率 x 账号倍率, 均为定点 */
export function combineRateMultiplier(
  groupRate: number,
  accountRate: number,
): number {
  return Math.round((groupRate * accountRate) / RATE_SCALE);
}

/** 窗口是否已过期 —— 上游 api_key.go:26 IsWindowExpired */
export function isWindowExpired(
  windowStart: string | null,
  windowMs: number,
  nowMs: number = Date.now(),
): boolean {
  if (!windowStart) return true;
  const start = parseDbTime(windowStart);
  if (start === null) return true;
  return nowMs - start >= windowMs;
}

/** 读取有效用量(窗口过期则记 0) —— 上游读取 usage_* 列时同此逻辑 */
export function effectiveUsage(
  usage: number,
  windowStart: string | null,
  windowMs: number,
  nowMs: number = Date.now(),
): number {
  return isWindowExpired(windowStart, windowMs, nowMs) ? 0 : usage;
}

/**
 * 校验 5h/1d/7d 金额限额 + quota
 * 对照上游 middleware/api_key_auth.go:34 的计费前置检查
 * 返回 null 表示通过, 否则返回错误信息
 */
export function checkQuotaLimits(ctx: AuthContext): string | null {
  const now = Date.now();

  const u5h = effectiveUsage(ctx.usage5h, ctx.window5hStart, WINDOW_5H_MS, now);
  const u1d = effectiveUsage(ctx.usage1d, ctx.window1dStart, WINDOW_1D_MS, now);
  const u7d = effectiveUsage(ctx.usage7d, ctx.window7dStart, WINDOW_7D_MS, now);

  if (ctx.rateLimit5h > 0 && u5h >= ctx.rateLimit5h) {
    return '5h rate limit exceeded';
  }
  if (ctx.rateLimit1d > 0 && u1d >= ctx.rateLimit1d) {
    return '1d rate limit exceeded';
  }
  if (ctx.rateLimit7d > 0 && u7d >= ctx.rateLimit7d) {
    return '7d rate limit exceeded';
  }
  // key 额度 (quota=0 表示无限)
  if (ctx.keyQuota > 0 && ctx.keyQuotaUsed >= ctx.keyQuota) {
    return 'api key quota exhausted';
  }
  return null;
}

/** 简单的请求指纹, 对应上游 request_fingerprint */
export function fingerprintRequest(parts: (string | number | undefined)[]): string {
  const raw = parts.filter((p) => p !== undefined).join('|');
  // 轻量 hash (FNV-1a 32bit), 上游用 sha256, 这里够幂等去重即可
  let h = 0x811c9dc5;
  for (let i = 0; i < raw.length; i++) {
    h ^= raw.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}
