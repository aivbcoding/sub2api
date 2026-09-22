import type { Platform } from './protocol';

/** Worker 环境绑定 —— 对应 wrangler.toml */
export interface Env {
  DB: D1Database;
  KV: KVNamespace;
  ACCOUNT_COORDINATOR: DurableObjectNamespace;
  API_KEY_PREFIX: string;
  CORS_ALLOWED_ORIGINS: string;
  ENFORCE_BALANCE: string;
  ALLOW_INSECURE_HTTP: string;
  /** /v1/models 列表模式: auto(默认) | local | upstream */
  MODELS_LIST_MODE?: string;
  ADMIN_JWT_SECRET?: string;
  [key: string]: unknown;
}

/** 鉴权后的上下文 —— 对应上游 gin.Context 里注入的 APIKey/User/Group */
export interface AuthContext {
  keyId: number;
  key: string;
  keyStatus: string;
  keyQuota: number;
  keyQuotaUsed: number;
  keyExpiresAt: string | null;
  ipWhitelist: string[] | null;
  ipBlacklist: string[] | null;
  rateLimit5h: number;
  rateLimit1d: number;
  rateLimit7d: number;
  usage5h: number;
  usage1d: number;
  usage7d: number;
  window5hStart: string | null;
  window1dStart: string | null;
  window7dStart: string | null;
  userId: number;
  userEmail: string;
  userRole: string;
  userBalance: number;
  userStatus: string;
  userConcurrency: number;
  /** 允许访问的上游平台, 逗号分隔; 空字符串 = 不限制 */
  userPlatformAccess: string;
  groupId: number | null;
  groupName: string | null;
  groupPlatform: string | null;
  groupRateMultiplier: number;
  groupRpmLimit: number;
  groupModelAllowlist: string[] | null;
  groupModelPricing: Record<string, ModelPrice> | null;
  /** 模型名 → 模型名 的重写 (如 claude-3-5-sonnet → claude-sonnet-4) */
  groupModelRouting: Record<string, string> | null;
  groupModelRoutingEnabled: boolean;
  groupDefaultMappedModel: string | null;
  /**
   * 模型名 → 平台 的重定向
   *
   * 与 groupModelRouting 的区别: 后者只改**模型名**, 平台仍由模型名推断;
   * 本字段直接**指定去哪个平台选号**, 用于同一个模型名可能落在多个平台、
   * 需要精确指定上游的场景 (例: deepseek-v4-pro 只该去 sensenova)。
   *
   * 值有两种写法:
   *   "sensenova"                                        —— 只指定平台
   *   { platform: "sensenova", model: "deepseek-v4-pro" } —— 顺带改写对端要求的模型名
   */
  groupModelPlatformRouting: Record<string, string | { platform: string; model?: string }> | null;
}

/** 账号行 */
export interface AccountRow {
  id: number;
  name: string;
  /** 内置官方平台名, 或任意自定义平台名(第三方中转/自建网关) */
  platform: Platform;
  /** 通信协议 openai|anthropic|gemini; 空 = 按 platform 推导 */
  protocol: string;
  type: string;
  credentials: string;
  extra: string;
  /**
   * 该账号已知能提供的模型名(对外名) —— JSON 字符串数组, 或已解析的数组。
   *
   * 由后台「模型获取」写入, 是「新模型自动归到中转」的事实依据:
   * 请求的模型名出现在哪个账号的索引里, 就路由到那个账号所在的平台。
   */
  model_index?: string | string[] | null;
  concurrency: number;
  load_factor: number | null;
  priority: number;
  rate_multiplier: number;
  status: string;
  schedulable: number;
  base_url: string | null;
  /**
   * 入口路径 —— 客户端请求 `/<entry_path>/v1/chat/completions` 即直接锁定本账号。
   *
   * 这是「按 URL 判定上游」的关键: 平台/账号的挑选不再依赖模型名, 因此同一模型名
   * 在多家中转上重复、或上游压根不暴露模型列表时, 依然能精确指定走哪一条。
   * 为空表示不参与入口路由(仍走模型名判定)。
   */
  entry_path?: string | null;
  rate_limited_at: string | null;
  rate_limit_reset_at: string | null;
  overload_until: string | null;
  temp_unschedulable_until: string | null;
}

/** 模型单价, 单位: 微美元 / token */
export interface ModelPrice {
  input_price: number;
  output_price: number;
  cache_read_price: number;
  cache_creation_price: number;
}

/** 从上游响应中解析出的 token 用量 */
export interface UsageTokens {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

export const EMPTY_USAGE: UsageTokens = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
};

/** 计费明细 */
export interface BillingBreakdown {
  inputCost: number;
  outputCost: number;
  cacheReadCost: number;
  cacheCreationCost: number;
  totalCost: number;
  actualCost: number;
  rateMultiplier: number;
}
