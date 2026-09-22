/**
 * 上游协议常量与 URL 推导
 * 严格移植自上游 Go 源码:
 *   - backend/internal/handler/endpoint.go:17-36   (端点常量)
 *   - backend/internal/handler/endpoint.go:198-239 (DeriveUpstreamEndpoint)
 *   - backend/internal/service/domain_constants.go (各平台 Base URL)
 *   - backend/internal/pkg/geminicli/constants.go:7-8
 *   - backend/internal/pkg/xai/oauth.go:29-30
 */

/** 内置官方平台标识 —— 对应上游 internal/domain/constants.go:20-35 */
export const BUILTIN_PLATFORMS = [
  'anthropic',
  'openai',
  'gemini',
  'antigravity',
  'grok',
  'kimi',
  'zhipu',
  'deepseek',
  'minimax',
  'opencode_go',
] as const;

/** 兼容旧名 */
export const PLATFORMS = BUILTIN_PLATFORMS;

export type BuiltinPlatform = (typeof BUILTIN_PLATFORMS)[number];

/**
 * 平台标识 —— 内置官方平台 或 任意自定义平台名
 *
 * 上游 Go 版把平台写死成枚举; 这里放开为 string, 以支持"第三方中转站 /
 * 自建网关 / 私有部署"等非官方上游。自定义平台名只作为**分组与选号的标签**,
 * 真正的协议行为由 account.protocol 决定(见 UpstreamProtocol)。
 */
export type Platform = BuiltinPlatform | (string & {});

/** 判断是否内置平台 */
export function isBuiltinPlatform(p: string): p is BuiltinPlatform {
  return (BUILTIN_PLATFORMS as readonly string[]).includes(p);
}

/** 平台名校验: 小写字母/数字/下划线/连字符, 1~64 字符 */
export function isValidPlatformName(p: string): boolean {
  return /^[a-z0-9][a-z0-9_-]{0,63}$/.test(p);
}

/** 平台名归一化: 去空格 + 转小写 */
export function normalizePlatformName(p: string): string {
  return String(p ?? '').trim().toLowerCase().replace(/\s+/g, '_');
}

/**
 * 通信协议 —— 决定请求怎么发、认证头怎么加
 *
 * 自定义平台必须显式选一个, 因为仅凭平台名无法判断对端说哪种协议。
 * 前三者覆盖了市面上绝大多数第三方中转:
 *   - openai     : OpenAI 兼容 (/v1/chat/completions, Authorization: Bearer)
 *   - anthropic  : Anthropic 原生 (/v1/messages, x-api-key)
 *   - gemini     : Google AI Studio (/v1beta/models/xxx:generateContent, x-goog-api-key)
 */
export const UPSTREAM_PROTOCOLS = ['openai', 'anthropic', 'gemini'] as const;
export type UpstreamProtocol = (typeof UPSTREAM_PROTOCOLS)[number];

/** 各协议的默认 Base URL 提示(仅用于界面占位, 不做兜底) */
export const PROTOCOL_BASE_URL_HINTS: Record<UpstreamProtocol, string> = {
  openai: 'https://api.openai.com',
  anthropic: 'https://api.anthropic.com',
  gemini: 'https://generativelanguage.googleapis.com',
};

/**
 * 平台 -> 默认协议
 * 内置平台按其原生协议; 自定义平台默认 openai 兼容(最常见)
 */
export function defaultProtocolFor(platform: string): UpstreamProtocol {
  switch (platform) {
    case 'anthropic':
    case 'kimi':
    case 'zhipu':
    case 'minimax':
      return 'anthropic';
    case 'gemini':
    case 'antigravity':
      return 'gemini';
    case 'openai':
    case 'grok':
    case 'deepseek':
    case 'opencode_go':
      return 'openai';
    default:
      return 'openai';
  }
}

/**
 * 把账号上存的 platform + protocol 解析成"协议行为"
 *
 * 兼容策略: 老数据只有 platform 没有 protocol 时, 回落到该平台的默认协议,
 * 保证升级后行为与升级前一致。
 */
export function resolveProtocol(platform: string, protocol?: string | null): UpstreamProtocol {
  const p = String(protocol ?? '').trim().toLowerCase();
  if ((UPSTREAM_PROTOCOLS as readonly string[]).includes(p)) return p as UpstreamProtocol;
  return defaultProtocolFor(platform);
}

/** 上游端点常量 —— endpoint.go:17-36 */
export const ENDPOINTS = {
  MODELS: '/v1/models',
  MESSAGES: '/v1/messages',
  MESSAGES_COUNT_TOKENS: '/v1/messages/count_tokens',
  CHAT_COMPLETIONS: '/v1/chat/completions',
  RESPONSES: '/v1/responses',
  RESPONSES_COMPACT: '/v1/responses/compact',
  RESPONSES_INPUT_TOKENS: '/v1/responses/input_tokens',
  EMBEDDINGS: '/v1/embeddings',
  GEMINI_MODELS: '/v1beta/models',
  ANTIGRAVITY_GENERATE_CONTENT: '/v1internal:streamGenerateContent',
} as const;

/** 各平台默认 Base URL —— 均取自上游源码常量 */
export const DEFAULT_BASE_URLS: Record<BuiltinPlatform, string> = {
  // service/account.go:983
  anthropic: 'https://api.anthropic.com',
  // openai_gateway_service.go:33
  openai: 'https://api.openai.com',
  // pkg/geminicli/constants.go:7  (AI Studio)
  gemini: 'https://generativelanguage.googleapis.com',
  // pkg/geminicli/constants.go:8  (Code Assist / Antigravity)
  antigravity: 'https://cloudcode-pa.googleapis.com',
  // pkg/xai/oauth.go:29  (官方 API)
  grok: 'https://api.x.ai',
  // domain_constants.go:77-78
  kimi: 'https://api.moonshot.cn',
  // domain_constants.go:79-80
  zhipu: 'https://open.bigmodel.cn/api/paas/v4',
  // domain_constants.go:81
  deepseek: 'https://api.deepseek.com',
  // domain_constants.go:83
  minimax: 'https://api.minimaxi.com',
  // domain_constants.go:85-87
  opencode_go: 'https://opencode.ai/zen/go',
};

/**
 * 取平台默认 Base URL
 *
 * 自定义平台没有默认值, 返回空串 —— 上层必须让用户显式填 Base URL,
 * 否则会拼出 `undefined/v1/...` 这种请求。调用方需自行校验非空。
 */
export function defaultBaseUrl(platform: string): string {
  return isBuiltinPlatform(platform) ? DEFAULT_BASE_URLS[platform] : '';
}

/** Anthropic 默认 API 版本头 —— gateway_upstream_request.go:165-167 */
export const ANTHROPIC_VERSION = '2023-06-01';

/**
 * 协议 -> 标准端点路径映射
 * 移植自 DeriveUpstreamEndpoint (endpoint.go:198-239)
 *
 * 关键行为: 只有入站请求**本身就是 responses 形状**时, 才转发到 /v1/responses。
 *   (官方 OpenAI 账号的 responses 请求仍走该分支, 行为不变)
 *
 * 这里不能像上游 Go 版那样把 chat/completions 也"收敛"到 /v1/responses ——
 * 对端若是第三方"OpenAI 兼容"中转(本协议最主要的目标场景), 它只实现
 * /v1/chat/completions, 收敛过去会直接 400 (例如 missing field "input")。
 * 因此 chat 请求保持 chat 端点, 与 upstreamPathFor('openai-chat') 一致。
 *
 * 改造点: 原本按 platform 分支, 现在按 protocol 分支。
 * 这样自定义平台只要选对协议, 就能复用同一套端点推导;
 * 内置平台通过 resolveProtocol() 映射到各自协议, 行为与改造前一致。
 */
export function deriveUpstreamEndpoint(
  protocol: UpstreamProtocol,
  inboundPath: string,
): string {
  switch (protocol) {
    case 'anthropic':
      // 提供 Anthropic 协议兼容端点的平台(anthropic/kimi/zhipu/minimax/任意中转)
      if (inboundPath.includes('/count_tokens')) return ENDPOINTS.MESSAGES_COUNT_TOKENS;
      return ENDPOINTS.MESSAGES;

    case 'openai':
      // Responses API 家族 —— 仅入站本身是 responses 路径时命中
      if (inboundPath.includes('/compact')) return ENDPOINTS.RESPONSES_COMPACT;
      if (inboundPath.includes('/input_tokens')) return ENDPOINTS.RESPONSES_INPUT_TOKENS;
      if (inboundPath.includes('/responses')) return ENDPOINTS.RESPONSES;
      if (inboundPath.includes('/embeddings')) return ENDPOINTS.EMBEDDINGS;
      if (inboundPath.includes('/models')) return ENDPOINTS.MODELS;
      // chat/completions(以及未知路径)按 chat 走 —— 第三方中转的事实标准
      return ENDPOINTS.CHAT_COMPLETIONS;

    case 'gemini':
      // Gemini 由 buildGeminiUrl 单独拼装
      return ENDPOINTS.GEMINI_MODELS;

    default:
      return inboundPath;
  }
}

/**
 * 协议 -> 「拉取模型列表」端点路径
 *
 * 与 deriveUpstreamEndpoint 分开: 后者会把 /v1/chat/completions 收敛成 /v1/responses,
 * 但模型列表必须老老实实走各自的原生端点, 不能被改写。
 *
 *   openai     -> GET /v1/models                 (OpenAI 兼容, 含绝大多数中转站)
 *   anthropic  -> GET /v1/models                 (Anthropic 已支持该端点)
 *   gemini     -> GET /v1beta/models             (Google AI Studio 原生)
 */
export function deriveModelsEndpoint(protocol: UpstreamProtocol): string {
  if (protocol === 'gemini') return ENDPOINTS.GEMINI_MODELS;
  return ENDPOINTS.MODELS;
}

/**
 * Gemini 模型动作 URL 拼装
 * 移植自 buildGeminiAIStudioModelActionURL (gemini_upstream_url.go:23-45)
 *
 * 形如: {base}/v1beta/models/{model}:{action}
 * 流式追加 ?alt=sse
 */
export function buildGeminiUrl(
  baseUrl: string,
  model: string,
  action: 'generateContent' | 'streamGenerateContent' | 'countTokens',
  stream: boolean,
): string {
  const base = baseUrl.replace(/\/+$/, '');
  const url = `${base}${ENDPOINTS.GEMINI_MODELS}/${model}:${action}`;
  return stream && action === 'streamGenerateContent' ? `${url}?alt=sse` : url;
}

/** Antigravity / Code Assist 动作 URL —— pkg/antigravity/client.go:36-40 */
export function buildAntigravityUrl(
  baseUrl: string,
  action: 'generateContent' | 'streamGenerateContent',
): string {
  const base = baseUrl.replace(/\/+$/, '');
  return `${base}/v1internal:${action}`;
}

/**
 * 认证头注入
 * 移植自:
 *   - anthropic_apikey_auth.go:51-61  (Anthropic)
 *   - openai_agent_identity.go:391    (OpenAI)
 *   - gemini_messages_compat_service.go:681 (Gemini)
 *   - pkg/antigravity/client.go:49    (Antigravity / Grok)
 */
export function applyUpstreamAuth(
  headers: Headers,
  protocol: UpstreamProtocol,
  accountType: string,
  credential: string,
): void {
  const isOAuth = accountType === 'oauth' || accountType === 'setup-token';

  switch (protocol) {
    case 'anthropic':
      if (isOAuth) {
        // OAuth 走 Bearer —— gateway_upstream_request.go:131-132
        headers.set('authorization', `Bearer ${credential}`);
      } else {
        // 默认 x-api-key —— anthropic_apikey_auth.go:60
        headers.set('x-api-key', credential);
      }
      if (!headers.has('anthropic-version')) {
        headers.set('anthropic-version', ANTHROPIC_VERSION);
      }
      break;

    case 'openai':
      // openai_agent_identity.go:391
      headers.set('authorization', `Bearer ${credential}`);
      break;

    case 'gemini':
      if (isOAuth) {
        headers.set('authorization', `Bearer ${credential}`);
      } else {
        // 上游明确用 header 而非 ?key= 查询参数, 避免 key 泄漏进日志
        // gemini_messages_compat_service.go:681
        headers.set('x-goog-api-key', credential);
      }
      break;

    default:
      headers.set('authorization', `Bearer ${credential}`);
  }
}

/** 从账号 credentials JSON 中解析出凭证字符串 */
export function extractCredential(
  credentials: Record<string, unknown>,
): string | null {
  const keys = ['api_key', 'apiKey', 'access_token', 'accessToken', 'token', 'key'];
  for (const k of keys) {
    const v = credentials[k];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return null;
}

/** 禁止客户端覆写的头 —— account_header_override.go:29 */
const FORBIDDEN_CLIENT_HEADERS = new Set([
  'authorization',
  'x-api-key',
  'x-goog-api-key',
  'api-key',
  'host',
  'content-length',
]);

/**
 * 构造转发到上游的请求头: 保留客户端头但剔除认证/连接类头, 再注入上游账号凭证
 */
export function buildUpstreamHeaders(
  inbound: Headers,
  protocol: UpstreamProtocol,
  accountType: string,
  credential: string,
): Headers {
  const out = new Headers();
  for (const [k, v] of inbound.entries()) {
    const lk = k.toLowerCase();
    if (FORBIDDEN_CLIENT_HEADERS.has(lk)) continue;
    // 剔除 hop-by-hop 头
    if (lk === 'connection' || lk === 'keep-alive' || lk === 'transfer-encoding') continue;
    out.set(k, v);
  }
  applyUpstreamAuth(out, protocol, accountType, credential);
  return out;
}
