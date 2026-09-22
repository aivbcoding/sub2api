/**
 * 流式(SSE)响应处理与 usage 提取
 * 移植自上游:
 *   - gateway_upstream_response.go:702  handleStreamingResponse
 *   - gateway_upstream_response.go:1158 parseSSEUsage        (Anthropic)
 *   - openai_gateway_response_handling.go:1196               (OpenAI)
 *
 * 上游行为: 不是纯字节透传, 而是逐行解析 SSE 以提取 usage + 首 token 时延,
 * 同时把响应流原样转发给客户端。
 *
 * 这里用 TransformStream 实现等价效果: 边透传边嗅探。
 */

import type { Platform } from './protocol';
import { EMPTY_USAGE, type UsageTokens } from './types';

export interface StreamResult {
  stream: ReadableStream<Uint8Array>;
  usage: Promise<UsageTokens>;
  firstTokenMs: Promise<number | null>;
}

/**
 * 包装上游 SSE 流: 原样透传 + 旁路解析 usage
 */
export function wrapStreamingResponse(
  upstreamBody: ReadableStream<Uint8Array>,
  platform: Platform,
  startedAt: number,
): StreamResult {
  let resolveUsage!: (u: UsageTokens) => void;
  let resolveFirst!: (ms: number | null) => void;
  const usagePromise = new Promise<UsageTokens>((r) => (resolveUsage = r));
  const firstPromise = new Promise<number | null>((r) => (resolveFirst = r));

  const usage: UsageTokens = { ...EMPTY_USAGE };
  let firstTokenSeen = false;
  let firstTokenMs: number | null = null;
  let buffer = '';
  let settled = false;

  const settle = () => {
    if (settled) return;
    settled = true;
    resolveUsage({ ...usage });
    // 从未见到任何 data 事件 -> 首 token 时延为 null
    resolveFirst(firstTokenSeen ? (firstTokenMs ?? null) : null);
  };

  const decoder = new TextDecoder();

  const transform = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      // 1) 原样透传 —— 客户端拿到零改动的字节流
      controller.enqueue(chunk);

      // 2) 旁路解析: 按行切分累积缓冲
      buffer += decoder.decode(chunk, { stream: true });

      let idx: number;
      while ((idx = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, idx).replace(/\r$/, '');
        buffer = buffer.slice(idx + 1);
        if (line.length === 0) continue;

        // 首个有内容的事件 -> 记录首 token 时延
        if (!firstTokenSeen && line.startsWith('data:')) {
          const payload = line.slice(5).trim();
          if (payload && payload !== '[DONE]') {
            firstTokenSeen = true;
            firstTokenMs = Date.now() - startedAt;
          }
        }

        parseSseLine(line, platform, usage);
      }
      return undefined;
    },
    flush() {
      // 处理残余缓冲
      if (buffer.length > 0) {
        parseSseLine(buffer, platform, usage);
        buffer = '';
      }
      settle();
      return undefined;
    },
  });

  const stream = upstreamBody.pipeThrough(transform);

  // 注意: 不能对 stream 再 pipeTo, 否则会与客户端读取争夺同一流。
  // settle 由 transform 的 flush 负责; 这里额外用 firstTokenMs 的 null 兜底即可。

  return { stream, usage: usagePromise, firstTokenMs: firstPromise };
}

/**
 * 解析单行 SSE 中的 usage
 * Anthropic 事件形如: event: message_delta / data: {"usage":{"output_tokens":15}}
 * OpenAI 事件形如:   data: {"usage":{"prompt_tokens":10,"completion_tokens":5}}
 */
function parseSseLine(line: string, platform: Platform, usage: UsageTokens): void {
  if (!line.startsWith('data:')) return;
  const payload = line.slice(5).trim();
  if (!payload || payload === '[DONE]') return;

  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(payload);
  } catch {
    return;
  }

  // usage 可能在顶层, 也可能嵌在 message / response 里
  const usageObj = findUsageObject(obj);
  if (usageObj) mergeUsage(usageObj, platform, usage);
}

/**
 * 流式 + 协议转换
 *
 * 与 wrapStreamingResponse 的区别: 不是字节透传, 而是逐行解析上游 SSE,
 * 用 translator 转成客户端要的格式再写出。
 * usage 仍然按**上游格式 + 上游平台**解析 (计费口径不变)。
 */
export function translateStreamingResponse(
  upstreamBody: ReadableStream<Uint8Array>,
  platform: Platform,
  startedAt: number,
  translator: { line(line: string): string },
): StreamResult {
  let resolveUsage!: (u: UsageTokens) => void;
  let resolveFirst!: (ms: number | null) => void;
  const usagePromise = new Promise<UsageTokens>((r) => (resolveUsage = r));
  const firstPromise = new Promise<number | null>((r) => (resolveFirst = r));

  const usage: UsageTokens = { ...EMPTY_USAGE };
  let firstTokenSeen = false;
  let firstTokenMs: number | null = null;
  let buffer = '';
  let settled = false;

  const settle = () => {
    if (settled) return;
    settled = true;
    resolveUsage({ ...usage });
    resolveFirst(firstTokenSeen ? (firstTokenMs ?? null) : null);
  };

  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  const handleLine = (line: string): string => {
    const trimmed = line.replace(/\r$/, '');
    if (!trimmed) return '';

    // 旁路计费: usage 按上游原始事件解析
    if (trimmed.startsWith('data:')) {
      const payload = trimmed.slice(5).trim();
      if (!firstTokenSeen && payload && payload !== '[DONE]') {
        firstTokenSeen = true;
        firstTokenMs = Date.now() - startedAt;
      }
      parseSseLine(trimmed, platform, usage);
    }

    return translator.line(trimmed);
  };

  const transform = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true });

      let idx: number;
      let out = '';
      while ((idx = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        out += handleLine(line);
      }
      if (out) controller.enqueue(encoder.encode(out));
      return undefined;
    },
    flush(controller) {
      let out = '';
      if (buffer.length > 0) out += handleLine(buffer);
      buffer = '';
      if (out) controller.enqueue(encoder.encode(out));
      settle();
      return undefined;
    },
  });

  const stream = upstreamBody.pipeThrough(transform);
  return { stream, usage: usagePromise, firstTokenMs: firstPromise };
}

function findUsageObject(obj: Record<string, unknown>): Record<string, unknown> | null {
  const direct = obj['usage'];
  if (direct && typeof direct === 'object') return direct as Record<string, unknown>;

  for (const k of ['message', 'response', 'delta']) {
    const nested = obj[k];
    if (nested && typeof nested === 'object') {
      const u = (nested as Record<string, unknown>)['usage'];
      if (u && typeof u === 'object') return u as Record<string, unknown>;
    }
  }
  return null;
}

/**
 * 合并 usage 到累计值
 * 注意: Anthropic 的 message_delta 里 output_tokens 是**累计值**(非增量), 直接覆盖;
 *       OpenAI 的 usage 只在末尾出现一次。
 */
function mergeUsage(
  u: Record<string, unknown>,
  platform: Platform,
  usage: UsageTokens,
): void {
  const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

  if (platform === 'anthropic' || platform === 'kimi' || platform === 'zhipu' || platform === 'minimax') {
    const input = num(u['input_tokens']);
    const output = num(u['output_tokens']);
    const cacheRead = num(u['cache_read_input_tokens']);
    const cacheCreation = num(u['cache_creation_input_tokens']);

    // 累计语义: 非 0 才覆盖, 避免后续 delta 把 input 冲成 0
    if (input > 0) usage.inputTokens = input;
    if (output > 0) usage.outputTokens = output;
    if (cacheRead > 0) usage.cacheReadTokens = cacheRead;
    if (cacheCreation > 0) usage.cacheCreationTokens = cacheCreation;
    return;
  }

  // OpenAI / Gemini 风格: prompt_tokens / completion_tokens
  const prompt = num(u['prompt_tokens'] ?? u['input_tokens']);
  const completion = num(u['completion_tokens'] ?? u['output_tokens']);
  const cached = num(u['cached_tokens'] ?? u['cache_read_input_tokens']);

  if (prompt > 0) usage.inputTokens = prompt;
  if (completion > 0) usage.outputTokens = completion;
  if (cached > 0) usage.cacheReadTokens = cached;

  // OpenAI 细节: prompt_tokens 含 cached_tokens, 上游会扣掉避免重复计费
  const details = u['prompt_tokens_details'];
  if (details && typeof details === 'object') {
    const cachedDetail = num((details as Record<string, unknown>)['cached_tokens']);
    if (cachedDetail > 0) {
      usage.cacheReadTokens = cachedDetail;
      usage.inputTokens = Math.max(0, usage.inputTokens - cachedDetail);
    }
  }
}

/**
 * 从非流式响应体里解析 usage
 */
export function parseUsageFromJson(
  body: unknown,
  platform: Platform,
): UsageTokens {
  const usage: UsageTokens = { ...EMPTY_USAGE };
  if (!body || typeof body !== 'object') return usage;

  const obj = body as Record<string, unknown>;
  const usageObj = findUsageObject(obj);
  if (usageObj) mergeUsage(usageObj, platform, usage);
  return usage;
}
