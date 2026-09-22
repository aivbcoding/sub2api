/**
 * 协议转换 (request / response / SSE)
 *
 * 背景:
 *   网关原来把入站请求体**原样**转发给上游, 隐含假设「入站格式 == 上游协议」。
 *   一旦不匹配就会崩, 例如:
 *     Anthropic 客户端 (/v1/messages, body 里有 messages/system/tools[].input_schema)
 *     选中了一个 Gemini 模型 -> 请求被发到 generateContent
 *     -> Google 返回 400 Unknown name "messages": Cannot find field.
 *
 * 本模块用 **中枢式(hub-and-spoke)** 设计解决:
 *   任意格式 --toCanonical--> OpenAI Chat 规范形 --fromCanonical--> 目标格式
 * 这样 N 种格式只需 2N 个适配器, 而不是 N² 个直连转换。
 *
 * 支持 4 种线格式:
 *   anthropic         -> /v1/messages
 *   openai-chat       -> /v1/chat/completions
 *   openai-responses  -> /v1/responses
 *   gemini            -> /v1beta/models/{m}:generateContent
 */

// ============================================================
// 类型
// ============================================================

export type WireFormat = 'anthropic' | 'openai-chat' | 'openai-responses' | 'gemini';

/** 规范化后的工具定义 */
interface CanonTool {
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
}

/** 规范化后的消息 */
interface CanonMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  /** assistant 发起的工具调用 */
  tool_calls?: { id: string; name: string; arguments: string }[];
  /** role==='tool' 时对应的调用 id */
  tool_call_id?: string;
}

/** 规范化后的请求 (以 OpenAI Chat 为准) */
export interface CanonRequest {
  model: string;
  messages: CanonMessage[];
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  stop?: string[];
  stream?: boolean;
  tools?: CanonTool[];
  tool_choice?: unknown;
}

/** 规范化后的「增量事件」—— 流式转换的中枢 */
export interface CanonDelta {
  /** 文本增量 */
  text?: string;
  /** 结束原因 (已归一化) */
  finish?: 'stop' | 'length' | 'tool_calls' | 'content_filter' | null;
  /** usage (某些协议在流中间/末尾给) */
  usage?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheCreation?: number;
  };
  /** 工具调用增量 (一条 SSE 里可能带多个工具的分片) */
  toolCalls?: { index: number; id?: string; name?: string; argumentsDelta?: string }[];
  /** 是否流结束 */
  done?: boolean;
}

// ============================================================
// 入站格式识别
// ============================================================

/**
 * 按路径 + body 特征识别入站线格式
 *
 * 路径优先, 但两种「模糊路径」需要看 body:
 *   /v1/models 之类纯 GET 不进来; POST 到未知路径时按 body 形状猜。
 */
export function detectInboundFormat(pathname: string, body: unknown): WireFormat {
  if (pathname.startsWith('/v1beta/')) return 'gemini';
  if (pathname.includes('/messages')) return 'anthropic';
  if (pathname.startsWith('/v1/responses') || pathname.startsWith('/backend-api') || pathname.startsWith('/antigravity')) {
    return 'openai-responses';
  }
  if (pathname.includes('/chat/completions') || pathname.includes('/completions') || pathname.includes('/embeddings')) {
    return 'openai-chat';
  }

  // 兜底: 按 body 形状猜
  const o = (body ?? {}) as Record<string, unknown>;
  if (Array.isArray(o['contents']) || o['systemInstruction'] || o['generationConfig']) return 'gemini';
  if (Array.isArray(o['input']) || o['instructions']) return 'openai-responses';
  if (o['input_schema'] || o['max_tokens'] !== undefined) return 'anthropic';
  if (Array.isArray(o['messages'])) {
    // Anthropic 的 messages[].content 常是 block 数组
    const first = o['messages'][0] as Record<string, unknown> | undefined;
    if (first && Array.isArray(first['content'])) {
      const b = first['content'][0] as Record<string, unknown> | undefined;
      if (b && typeof b['type'] === 'string' && ['text', 'image', 'tool_use', 'tool_result'].includes(String(b['type']))) {
        return 'anthropic';
      }
    }
    if (typeof o['system'] === 'string') return 'anthropic';
  }
  return 'openai-chat';
}

/** 上游协议 -> 目标线格式 */
export function upstreamFormatFor(
  protocol: string,
  inbound: WireFormat,
): WireFormat {
  if (protocol === 'anthropic') return 'anthropic';
  if (protocol === 'gemini') return 'gemini';
  // openai 协议: 入站本来就是 responses 就保持, 其它一律走 chat
  // (chat/completions 是各类第三方中转站的事实标准, 兼容性最好)
  return inbound === 'openai-responses' ? 'openai-responses' : 'openai-chat';
}

/** 目标格式对应的上游端点路径 (不含 base_url) */
export function upstreamPathFor(format: WireFormat, model: string): string {
  switch (format) {
    case 'anthropic':
      return '/v1/messages';
    case 'gemini':
      return `/v1beta/models/${model}:generateContent`;
    case 'openai-responses':
      return '/v1/responses';
    case 'openai-chat':
    default:
      return '/v1/chat/completions';
  }
}

// ============================================================
// 工具函数
// ============================================================

const isObj = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

const num = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? v : undefined;

/** Anthropic system 可能是 string 或 block 数组 */
function anthropicSystemToText(system: unknown): string {
  if (typeof system === 'string') return system;
  if (Array.isArray(system)) {
    return system
      .map((b) => (isObj(b) ? str(b['text']) : ''))
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

/** Anthropic content 转为纯文本 (非工具场景) */
function anthropicContentToText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => {
        if (!isObj(b)) return '';
        if (b['type'] === 'text') return str(b['text']);
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

/** Gemini parts 转为纯文本 */
function geminiPartsToText(parts: unknown): string {
  if (!Array.isArray(parts)) return '';
  return parts
    .map((p) => (isObj(p) ? str(p['text']) : ''))
    .filter(Boolean)
    .join('');
}

/** OpenAI content (string | array) 转纯文本 */
function openaiContentToText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((p) => {
        if (typeof p === 'string') return p;
        if (!isObj(p)) return '';
        return str(p['text']);
      })
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

/** 统一 stop / finish_reason */
function normFinish(v: unknown): CanonDelta['finish'] {
  const s = String(v ?? '').toLowerCase();
  if (!s) return null;
  if (['stop', 'end_turn', 'stop_sequence', 'end'].includes(s)) return 'stop';
  if (['length', 'max_tokens', 'max_output_tokens'].includes(s)) return 'length';
  if (['tool_calls', 'tool_use', 'function_call'].includes(s)) return 'tool_calls';
  if (['content_filter', 'safety', 'recitation', 'blocklist', 'prohibited_content'].includes(s)) {
    return 'content_filter';
  }
  return 'stop';
}

/** 目标格式的 finish_reason 表达 */
function finishFor(format: WireFormat, f: CanonDelta['finish']): string | undefined {
  if (!f) return undefined;
  switch (format) {
    case 'anthropic':
      return f === 'stop' ? 'end_turn' : f === 'length' ? 'max_tokens' : f === 'tool_calls' ? 'tool_use' : 'end_turn';
    case 'gemini':
      return f === 'stop' ? 'STOP' : f === 'length' ? 'MAX_TOKENS' : f === 'tool_calls' ? 'STOP' : 'SAFETY';
    default:
      return f;
  }
}

// ============================================================
// 各格式 -> 规范形
// ============================================================

/** OpenAI Chat -> 规范形 (基本恒等, 只做消息归一) */
function openaiChatToCanonical(body: Record<string, unknown>): CanonRequest {
  const messages: CanonMessage[] = [];
  const raw = Array.isArray(body['messages']) ? body['messages'] : [];
  for (const m of raw) {
    if (!isObj(m)) continue;
    const role = String(m['role'] ?? 'user');
    const c: CanonMessage = {
      role: (['system', 'user', 'assistant', 'tool'].includes(role) ? role : 'user') as CanonMessage['role'],
      content: openaiContentToText(m['content']),
    };
    if (Array.isArray(m['tool_calls'])) {
      c.tool_calls = (m['tool_calls'] as unknown[])
        .filter(isObj)
        .map((tc, i) => {
          const fn = isObj(tc['function']) ? (tc['function'] as Record<string, unknown>) : {};
          return {
            id: str(tc['id']) || `call_${i}`,
            name: str(fn['name']),
            arguments: typeof fn['arguments'] === 'string' ? fn['arguments'] : JSON.stringify(fn['arguments'] ?? {}),
          };
        });
    }
    if (m['tool_call_id']) c.tool_call_id = String(m['tool_call_id']);
    messages.push(c);
  }

  return {
    model: str(body['model']),
    messages,
    max_tokens: num(body['max_tokens']) ?? num(body['max_completion_tokens']),
    temperature: num(body['temperature']),
    top_p: num(body['top_p']),
    stop: normalizeStop(body['stop']),
    stream: body['stream'] === true,
    tools: normalizeOpenaiTools(body['tools']),
    tool_choice: body['tool_choice'],
  };
}

function normalizeStop(v: unknown): string[] | undefined {
  if (typeof v === 'string') return [v];
  if (Array.isArray(v)) return v.filter((x) => typeof x === 'string') as string[];
  return undefined;
}

function normalizeOpenaiTools(v: unknown): CanonTool[] | undefined {
  if (!Array.isArray(v) || v.length === 0) return undefined;
  const out: CanonTool[] = [];
  for (const t of v) {
    if (!isObj(t)) continue;
    const fn = isObj(t['function']) ? (t['function'] as Record<string, unknown>) : t;
    const name = str(fn['name']);
    if (!name) continue;
    out.push({
      name,
      description: str(fn['description']) || undefined,
      parameters: isObj(fn['parameters']) ? (fn['parameters'] as Record<string, unknown>) : undefined,
    });
  }
  return out.length ? out : undefined;
}

/** Anthropic -> 规范形 */
function anthropicToCanonical(body: Record<string, unknown>): CanonRequest {
  const messages: CanonMessage[] = [];

  const sys = anthropicSystemToText(body['system']);
  if (sys) messages.push({ role: 'system', content: sys });

  const raw = Array.isArray(body['messages']) ? body['messages'] : [];
  for (const m of raw) {
    if (!isObj(m)) continue;
    const role = m['role'] === 'assistant' ? 'assistant' : 'user';
    const content = m['content'];

    // 纯文本
    if (typeof content === 'string') {
      messages.push({ role, content });
      continue;
    }

    if (!Array.isArray(content)) {
      messages.push({ role, content: '' });
      continue;
    }

    // 块数组: 文本 / tool_use / tool_result 需要拆成多条
    const texts: string[] = [];
    const toolCalls: NonNullable<CanonMessage['tool_calls']> = [];

    for (const b of content) {
      if (!isObj(b)) continue;
      const t = String(b['type'] ?? '');
      if (t === 'text') {
        texts.push(str(b['text']));
      } else if (t === 'tool_use') {
        toolCalls.push({
          id: str(b['id']) || `call_${toolCalls.length}`,
          name: str(b['name']),
          arguments: JSON.stringify(b['input'] ?? {}),
        });
      } else if (t === 'tool_result') {
        // tool_result 是 user 侧消息 -> 规范形 role='tool'
        messages.push({
          role: 'tool',
          content:
            typeof b['content'] === 'string'
              ? String(b['content'])
              : anthropicContentToText(b['content']),
          tool_call_id: str(b['tool_use_id']) || undefined,
        });
      } else if (t === 'image') {
        texts.push('[image]');
      }
    }

    if (texts.length || toolCalls.length) {
      const msg: CanonMessage = { role, content: texts.join('\n') };
      if (toolCalls.length) msg.tool_calls = toolCalls;
      messages.push(msg);
    }
  }

  // tools: [{name,description,input_schema}] -> 规范形
  let tools: CanonTool[] | undefined;
  if (Array.isArray(body['tools']) && body['tools'].length) {
    tools = (body['tools'] as unknown[]).filter(isObj).map((t) => ({
      name: str((t as Record<string, unknown>)['name']),
      description: str((t as Record<string, unknown>)['description']) || undefined,
      parameters: isObj((t as Record<string, unknown>)['input_schema'])
        ? ((t as Record<string, unknown>)['input_schema'] as Record<string, unknown>)
        : undefined,
    })).filter((t) => t.name);
    if (!tools.length) tools = undefined;
  }

  return {
    model: str(body['model']),
    messages,
    max_tokens: num(body['max_tokens']),
    temperature: num(body['temperature']),
    top_p: num(body['top_p']),
    stop: normalizeStop(body['stop_sequences']),
    stream: body['stream'] === true,
    tools,
    tool_choice: body['tool_choice'],
  };
}

/** Gemini -> 规范形 */
function geminiToCanonical(body: Record<string, unknown>): CanonRequest {
  const messages: CanonMessage[] = [];

  const si = isObj(body['systemInstruction']) ? (body['systemInstruction'] as Record<string, unknown>) : null;
  const sysText = si ? geminiPartsToText(si['parts']) : '';
  if (sysText) messages.push({ role: 'system', content: sysText });

  const contents = Array.isArray(body['contents']) ? body['contents'] : [];
  for (const c of contents) {
    if (!isObj(c)) continue;
    const role = c['role'] === 'model' ? 'assistant' : 'user';
    const parts = Array.isArray(c['parts']) ? c['parts'] : [];

    const texts: string[] = [];
    const toolCalls: NonNullable<CanonMessage['tool_calls']> = [];

    for (const p of parts) {
      if (!isObj(p)) continue;
      if (typeof p['text'] === 'string') {
        texts.push(String(p['text']));
      } else if (isObj(p['functionCall'])) {
        const fc = p['functionCall'] as Record<string, unknown>;
        toolCalls.push({
          id: `call_${toolCalls.length}`,
          name: str(fc['name']),
          arguments: JSON.stringify(fc['args'] ?? {}),
        });
      } else if (isObj(p['functionResponse'])) {
        const fr = p['functionResponse'] as Record<string, unknown>;
        messages.push({
          role: 'tool',
          content: JSON.stringify(fr['response'] ?? {}),
          tool_call_id: `call_${messages.length}`,
        });
      }
    }

    if (texts.length || toolCalls.length) {
      const msg: CanonMessage = { role, content: texts.join('\n') };
      if (toolCalls.length) msg.tool_calls = toolCalls;
      messages.push(msg);
    }
  }

  const gc = isObj(body['generationConfig']) ? (body['generationConfig'] as Record<string, unknown>) : {};

  // tools: [{functionDeclarations:[{name,description,parameters}]}]
  let tools: CanonTool[] | undefined;
  if (Array.isArray(body['tools'])) {
    const collected: CanonTool[] = [];
    for (const t of body['tools']) {
      if (!isObj(t)) continue;
      const decls = Array.isArray(t['functionDeclarations']) ? t['functionDeclarations'] : [];
      for (const d of decls) {
        if (!isObj(d)) continue;
        collected.push({
          name: str(d['name']),
          description: str(d['description']) || undefined,
          parameters: isObj(d['parameters']) ? (d['parameters'] as Record<string, unknown>) : undefined,
        });
      }
    }
    tools = collected.filter((t) => t.name);
    if (!tools.length) tools = undefined;
  }

  return {
    model: str(body['model']),
    messages,
    max_tokens: num(gc['maxOutputTokens']),
    temperature: num(gc['temperature']),
    top_p: num(gc['topP']),
    stop: normalizeStop(gc['stopSequences']),
    stream: false,
    tools,
    tool_choice: undefined,
  };
}

/** OpenAI Responses -> 规范形 */
function openaiResponsesToCanonical(body: Record<string, unknown>): CanonRequest {
  const messages: CanonMessage[] = [];

  const instructions = body['instructions'];
  if (typeof instructions === 'string' && instructions) {
    messages.push({ role: 'system', content: instructions });
  }

  const input = body['input'];
  if (typeof input === 'string') {
    messages.push({ role: 'user', content: input });
  } else if (Array.isArray(input)) {
    for (const item of input) {
      if (typeof item === 'string') {
        messages.push({ role: 'user', content: item });
        continue;
      }
      if (!isObj(item)) continue;
      if (item['type'] === 'function_call_output') {
        messages.push({
          role: 'tool',
          content: typeof item['output'] === 'string' ? String(item['output']) : JSON.stringify(item['output'] ?? ''),
          tool_call_id: str(item['call_id']) || undefined,
        });
        continue;
      }
      const role = item['role'] === 'assistant' ? 'assistant' : 'user';
      messages.push({ role, content: openaiContentToText(item['content']) });
    }
  }

  return {
    model: str(body['model']),
    messages,
    max_tokens: num(body['max_output_tokens']),
    temperature: num(body['temperature']),
    top_p: num(body['top_p']),
    stream: body['stream'] === true,
    tools: normalizeOpenaiTools(body['tools']),
    tool_choice: body['tool_choice'],
  };
}

/** 任意格式 -> 规范形 */
export function toCanonical(from: WireFormat, body: Record<string, unknown>): CanonRequest {
  switch (from) {
    case 'anthropic':
      return anthropicToCanonical(body);
    case 'gemini':
      return geminiToCanonical(body);
    case 'openai-responses':
      return openaiResponsesToCanonical(body);
    case 'openai-chat':
    default:
      return openaiChatToCanonical(body);
  }
}

// ============================================================
// 规范形 -> 各格式
// ============================================================

function canonicalToOpenaiChat(c: CanonRequest): Record<string, unknown> {
  const out: Record<string, unknown> = {
    model: c.model,
    messages: c.messages.map((m) => {
      const base: Record<string, unknown> = { role: m.role, content: m.content };
      if (m.tool_calls) {
        base['tool_calls'] = m.tool_calls.map((tc) => ({
          id: tc.id,
          type: 'function',
          function: { name: tc.name, arguments: tc.arguments },
        }));
        if (!m.content) delete base['content'];
      }
      if (m.role === 'tool' && m.tool_call_id) base['tool_call_id'] = m.tool_call_id;
      return base;
    }),
  };
  if (c.max_tokens !== undefined) out['max_tokens'] = c.max_tokens;
  if (c.temperature !== undefined) out['temperature'] = c.temperature;
  if (c.top_p !== undefined) out['top_p'] = c.top_p;
  if (c.stop?.length) out['stop'] = c.stop;
  if (c.stream) {
    out['stream'] = true;
    out['stream_options'] = { include_usage: true };
  }
  if (c.tools?.length) {
    out['tools'] = c.tools.map((t) => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description ?? '',
        parameters: t.parameters ?? { type: 'object', properties: {} },
      },
    }));
    // tool_choice 归一化: Anthropic 客户端(Claude Code 等)发的是 {type:"auto"/"any"/"tool"}
    // 这种 Anthropic 形状, 直接透传给 OpenAI 上游属于非法值(会被忽略或 400)。
    out['tool_choice'] = normalizeToolChoiceForOpenai(c.tool_choice);
  }
  return out;
}

/** tool_choice -> OpenAI 合法形状 (字符串 或 {type:'function',function:{name}}) */
function normalizeToolChoiceForOpenai(tc: unknown): string | Record<string, unknown> {
  if (tc === undefined || tc === null) return 'auto';
  if (typeof tc === 'string') {
    return tc === 'auto' || tc === 'none' || tc === 'required' ? tc : 'auto';
  }
  if (isObj(tc)) {
    const type = str(tc['type']);
    if (type === 'auto') return 'auto';
    if (type === 'any') return 'required'; // Anthropic any = 必须调用某个工具
    if (type === 'tool') {
      const name = str(tc['name']);
      return name ? { type: 'function', function: { name } } : 'required';
    }
    // 已是 OpenAI 形状 {type:'function', function:{name}} 则原样放行
    if (type === 'function' && isObj(tc['function'])) return tc;
  }
  return 'auto';
}

function canonicalToAnthropic(c: CanonRequest): Record<string, unknown> {
  const out: Record<string, unknown> = { model: c.model };

  // Anthropic 的 system 是顶层字段
  const sys = c.messages.filter((m) => m.role === 'system').map((m) => m.content).filter(Boolean);
  if (sys.length) out['system'] = sys.join('\n');

  // Anthropic 要求 max_tokens 必填, 缺省给一个安全值
  out['max_tokens'] = c.max_tokens ?? 4096;

  const msgs: Record<string, unknown>[] = [];
  for (const m of c.messages) {
    if (m.role === 'system') continue;

    if (m.role === 'tool') {
      msgs.push({
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: m.tool_call_id ?? '',
            content: m.content,
          },
        ],
      });
      continue;
    }

    if (m.role === 'assistant' && m.tool_calls?.length) {
      const blocks: Record<string, unknown>[] = [];
      if (m.content) blocks.push({ type: 'text', text: m.content });
      for (const tc of m.tool_calls) {
        let input: unknown = {};
        try {
          input = JSON.parse(tc.arguments || '{}');
        } catch {
          input = {};
        }
        blocks.push({ type: 'tool_use', id: tc.id, name: tc.name, input });
      }
      msgs.push({ role: 'assistant', content: blocks });
      continue;
    }

    msgs.push({ role: m.role, content: m.content });
  }
  out['messages'] = msgs;

  if (c.temperature !== undefined) out['temperature'] = c.temperature;
  if (c.top_p !== undefined) out['top_p'] = c.top_p;
  if (c.stop?.length) out['stop_sequences'] = c.stop;
  if (c.stream) out['stream'] = true;
  if (c.tools?.length) {
    out['tools'] = c.tools.map((t) => ({
      name: t.name,
      description: t.description ?? '',
      input_schema: t.parameters ?? { type: 'object', properties: {} },
    }));
  }
  return out;
}

/**
 * Gemini `Schema` proto 只认一部分 JSON Schema 关键字。
 * 多出来的($schema / additionalProperties / $ref / oneOf / default / examples ...)
 * 会被上游以 400 `Invalid JSON payload received. Unknown name "X": Cannot find field.` 拒收。
 *
 * 这里用**白名单**递归清洗: 不在名单里的一律丢弃 —— 宁可有损也绝不 400。
 * 同时做一些归一化: type 数组 -> 单 type + nullable; $ref 就地展开。
 */
const GEMINI_SCHEMA_KEYS = new Set([
  'type',
  'format',
  'title',
  'description',
  'nullable',
  'default',
  'items',
  'enum',
  'properties',
  'required',
  'minItems',
  'maxItems',
  'minProperties',
  'maxProperties',
  'minLength',
  'maxLength',
  'pattern',
  'example',
  'anyOf',
  'propertyOrdering',
  'minimum',
  'maximum',
]);

/** JSON Schema 的 type 允许是数组(如 ["string","null"]), Gemini 只认单个 type */
function normalizeGeminiType(v: unknown): { type?: string; nullable?: boolean } {
  if (typeof v === 'string') return { type: v };
  if (Array.isArray(v)) {
    const types = v.filter((x): x is string => typeof x === 'string');
    const nullable = types.includes('null');
    const single = types.find((t) => t !== 'null');
    return { type: single, nullable: nullable || undefined };
  }
  return {};
}

function toGeminiSchema(
  schema: unknown,
  rootDefs?: Record<string, unknown>,
  depth = 0,
): Record<string, unknown> {
  // 空/非对象/超深: Gemini 不接受空 Schema, 给个宽松标量兜底
  if (!isObj(schema) || depth > 14) return { type: 'string' };
  const s = schema as Record<string, unknown>;

  // $ref 就地展开(仅支持本地引用), 否则丢掉后会变成空 schema
  const ref = s['$ref'];
  if (typeof ref === 'string' && ref.startsWith('#')) {
    const defs = rootDefs ?? {};
    const name = ref.replace(/^#\/(\$defs|definitions)\//, '');
    const target = (defs[name] ?? defs[ref.slice(1)]) as unknown;
    if (target) return toGeminiSchema(target, defs, depth + 1);
    return { type: 'string' };
  }

  const out: Record<string, unknown> = {};
  const { type: rawType, nullable } = normalizeGeminiType(s['type']);

  // ---- 逐键白名单拷贝 ----
  for (const key of GEMINI_SCHEMA_KEYS) {
    if (key === 'type' || key === 'nullable') continue;
    const v = s[key];
    if (v === undefined) continue;

    if (key === 'properties' && isObj(v)) {
      const props: Record<string, unknown> = {};
      for (const [k, sub] of Object.entries(v as Record<string, unknown>)) {
        props[k] = toGeminiSchema(sub, rootDefs, depth + 1);
      }
      out['properties'] = props;
    } else if (key === 'items') {
      // JSON Schema 允许 items 是数组(元组写法), Gemini 只认单个 schema
      const first = Array.isArray(v) ? v[0] : v;
      out['items'] = toGeminiSchema(first, rootDefs, depth + 1);
    } else if (key === 'anyOf' && Array.isArray(v)) {
      const branches = v
        .map((x) => toGeminiSchema(x, rootDefs, depth + 1))
        .filter((x) => Object.keys(x).length > 0);
      if (branches.length) out['anyOf'] = branches;
    } else if (key === 'enum' && Array.isArray(v)) {
      // Gemini 的 enum 只接受字符串; 数字/布尔枚举一律丢掉, 避免再次 400
      if (v.length > 0 && v.every((x) => typeof x === 'string')) out['enum'] = v;
    } else if (key === 'required' || key === 'propertyOrdering') {
      if (Array.isArray(v) && v.length && v.every((x) => typeof x === 'string')) out[key] = v;
    } else if (key === 'default' || key === 'example') {
      // 只保留标量默认值/示例
      if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') out[key] = v;
    } else if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
      out[key] = v;
    }
  }

  // ---- 推断并修正 type ----
  // Gemini 要求**每个** schema 节点都带 type, 但客户端几乎都不写, 必须靠结构反推。
  // 缺 type 的节点会让 Gemini 报莫名的 `...items: missing field.`
  let type = rawType;
  if (!type) {
    if (isObj(out['properties'])) type = 'object';
    else if (isObj(out['items'])) type = 'array';
    else if (out['enum'] || out['pattern']) type = 'string';
    else if (Array.isArray(out['anyOf'])) {
      const types = new Set(
        (out['anyOf'] as Record<string, unknown>[])
          .map((x) => x['type'])
          .filter((t): t is string => typeof t === 'string'),
      );
      if (types.size === 1) type = [...types][0];
    }
  }

  // 结构与 type 冲突时**以结构为准** —— 结构信息比声明的 type 可信
  if (isObj(out['properties'])) type = 'object';
  else if (isObj(out['items']) && type !== 'array') type = 'array';

  // array 必须有非空 items; 缺了就补, 否则 Gemini 报 `...items: missing field.`
  if (type === 'array' && !isObj(out['items'])) {
    out['items'] = { type: 'string' };
  }
  // object 补一个空的 properties(Gemini 接受)
  if (type === 'object' && !isObj(out['properties'])) {
    out['properties'] = {};
  }

  // 兜底: 仍然没有可判定的 type(例如只有 description), 视为 string
  if (!type) type = 'string';
  out['type'] = type;
  if (nullable) out['nullable'] = true;

  return out;
}

/** 从工具的 JSON Schema 里取 $defs/definitions 供 $ref 展开 */
function collectSchemaDefs(schema: unknown): Record<string, unknown> | undefined {
  if (!isObj(schema)) return undefined;
  const s = schema as Record<string, unknown>;
  const defs = s['$defs'] ?? s['definitions'];
  return isObj(defs) ? (defs as Record<string, unknown>) : undefined;
}

/** 对外: 把任意 JSON Schema 转成 Gemini 可接受的形式 */
function geminiToolParameters(schema: unknown): Record<string, unknown> {
  const out = toGeminiSchema(schema, collectSchemaDefs(schema));
  // 函数参数在 Gemini 里必须是 object
  if (out['type'] === 'object') {
    if (!isObj(out['properties'])) out['properties'] = {};
    return out;
  }
  return { type: 'object', properties: {} };
}

function canonicalToGemini(c: CanonRequest): Record<string, unknown> {
  const contents: Record<string, unknown>[] = [];

  for (const m of c.messages) {
    if (m.role === 'system') continue;

    if (m.role === 'tool') {
      contents.push({
        role: 'user',
        parts: [
          {
            functionResponse: {
              name: m.tool_call_id ?? 'tool',
              response: { content: m.content },
            },
          },
        ],
      });
      continue;
    }

    const parts: Record<string, unknown>[] = [];
    if (m.tool_calls?.length) {
      for (const tc of m.tool_calls) {
        let args: unknown = {};
        try {
          args = JSON.parse(tc.arguments || '{}');
        } catch {
          args = {};
        }
        parts.push({ functionCall: { name: tc.name, args } });
      }
    }
    if (m.content) parts.push({ text: m.content });
    if (!parts.length) parts.push({ text: '' });

    contents.push({ role: m.role === 'assistant' ? 'model' : 'user', parts });
  }

  const out: Record<string, unknown> = { contents };

  const sys = c.messages.filter((m) => m.role === 'system').map((m) => m.content).filter(Boolean);
  if (sys.length) {
    out['systemInstruction'] = { parts: [{ text: sys.join('\n') }] };
  }

  const gc: Record<string, unknown> = {};
  if (c.max_tokens !== undefined) gc['maxOutputTokens'] = c.max_tokens;
  if (c.temperature !== undefined) gc['temperature'] = c.temperature;
  if (c.top_p !== undefined) gc['topP'] = c.top_p;
  if (c.stop?.length) gc['stopSequences'] = c.stop;
  if (Object.keys(gc).length) out['generationConfig'] = gc;

  if (c.tools?.length) {
    out['tools'] = [
      {
        functionDeclarations: c.tools.map((t) => ({
          name: t.name,
          description: t.description ?? '',
          parameters: geminiToolParameters(
            t.parameters ?? { type: 'object', properties: {} },
          ),
        })),
      },
    ];
  }
  return out;
}

function canonicalToOpenaiResponses(c: CanonRequest): Record<string, unknown> {
  const instructions = c.messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n');
  const input = c.messages
    .filter((m) => m.role !== 'system')
    .map((m) => ({ role: m.role === 'tool' ? 'user' : m.role, content: m.content }));

  const out: Record<string, unknown> = { model: c.model, input };
  if (instructions) out['instructions'] = instructions;
  if (c.max_tokens !== undefined) out['max_output_tokens'] = c.max_tokens;
  if (c.temperature !== undefined) out['temperature'] = c.temperature;
  if (c.top_p !== undefined) out['top_p'] = c.top_p;
  if (c.stream) out['stream'] = true;
  if (c.tools?.length) {
    out['tools'] = c.tools.map((t) => ({
      type: 'function',
      name: t.name,
      description: t.description ?? '',
      parameters: t.parameters ?? { type: 'object', properties: {} },
    }));
  }
  return out;
}

/** 规范形 -> 任意格式 */
export function fromCanonical(to: WireFormat, c: CanonRequest): Record<string, unknown> {
  switch (to) {
    case 'anthropic':
      return canonicalToAnthropic(c);
    case 'gemini':
      return canonicalToGemini(c);
    case 'openai-responses':
      return canonicalToOpenaiResponses(c);
    case 'openai-chat':
    default:
      return canonicalToOpenaiChat(c);
  }
}

/**
 * 请求体转换主入口
 * from === to 时返回 null, 表示无需转换 (调用方保持原样透传)
 */
export function translateRequest(
  from: WireFormat,
  to: WireFormat,
  body: Record<string, unknown>,
  model: string,
): Record<string, unknown> | null {
  if (from === to) return null;
  const c = toCanonical(from, body);
  if (model) c.model = model;
  return fromCanonical(to, c);
}

// ============================================================
// 非流式响应转换
// ============================================================

/**
 * 把「上游格式」的响应 JSON 转成「客户端格式」
 * from === to 时返回 null (调用方原样透传)
 */
export function translateResponse(
  from: WireFormat,
  to: WireFormat,
  body: unknown,
  model = '',
): Record<string, unknown> | null {
  if (from === to) return null;
  if (!isObj(body)) return null;

  // 上游报错时原样透传, 避免把错误信息也改写掉
  if (isObj(body['error']) || body['type'] === 'error') return null;

  const text = extractResponseText(from, body);
  const finish = extractFinish(from, body) ?? 'stop';
  const usage = extractUsage(from, body);
  const toolCalls = extractToolCalls(from, body);

  return buildResponse(to, { model, text, finish, usage, toolCalls });
}

interface RespParts {
  model: string;
  text: string;
  finish: CanonDelta['finish'];
  usage: { input?: number; output?: number; cacheRead?: number; cacheCreation?: number };
  toolCalls?: { id: string; name: string; arguments: string }[];
}

/** 从上游响应中取文本 */
function extractResponseText(format: WireFormat, b: Record<string, unknown>): string {
  if (format === 'anthropic') {
    const content = Array.isArray(b['content']) ? b['content'] : [];
    return content
      .map((c) => (isObj(c) && c['type'] === 'text' ? str(c['text']) : ''))
      .filter(Boolean)
      .join('');
  }
  if (format === 'gemini') {
    const cands = Array.isArray(b['candidates']) ? b['candidates'] : [];
    const first = isObj(cands[0]) ? (cands[0] as Record<string, unknown>) : null;
    const content = first && isObj(first['content']) ? (first['content'] as Record<string, unknown>) : null;
    return content ? geminiPartsToText(content['parts']) : '';
  }
  if (format === 'openai-responses') {
    const output = Array.isArray(b['output']) ? b['output'] : [];
    return output
      .map((o) => {
        if (!isObj(o)) return '';
        const cs = Array.isArray(o['content']) ? o['content'] : [];
        return cs
          .map((c) => (isObj(c) && (c['type'] === 'output_text' || c['type'] === 'text') ? str(c['text']) : ''))
          .filter(Boolean)
          .join('');
      })
      .join('');
  }
  // openai-chat
  const choices = Array.isArray(b['choices']) ? b['choices'] : [];
  const first = isObj(choices[0]) ? (choices[0] as Record<string, unknown>) : null;
  if (!first) return '';
  const msg = isObj(first['message']) ? (first['message'] as Record<string, unknown>) : null;
  return msg ? openaiContentToText(msg['content']) : str(first['text']);
}

function extractFinish(format: WireFormat, b: Record<string, unknown>): CanonDelta['finish'] {
  if (format === 'anthropic') return normFinish(b['stop_reason']);
  if (format === 'gemini') {
    const cands = Array.isArray(b['candidates']) ? b['candidates'] : [];
    const first = isObj(cands[0]) ? (cands[0] as Record<string, unknown>) : null;
    return normFinish(first ? first['finishReason'] : '');
  }
  if (format === 'openai-responses') return normFinish(b['status']);
  const choices = Array.isArray(b['choices']) ? b['choices'] : [];
  const first = isObj(choices[0]) ? (choices[0] as Record<string, unknown>) : null;
  return normFinish(first ? first['finish_reason'] : '');
}

function extractUsage(
  format: WireFormat,
  b: Record<string, unknown>,
): RespParts['usage'] {
  const u = isObj(b['usage']) ? (b['usage'] as Record<string, unknown>) : null;
  if (!u) {
    // Gemini 用 usageMetadata
    const um = isObj(b['usageMetadata']) ? (b['usageMetadata'] as Record<string, unknown>) : null;
    if (um) {
      return { input: num(um['promptTokenCount']), output: num(um['candidatesTokenCount']) };
    }
    return {};
  }
  if (format === 'anthropic') {
    return {
      input: num(u['input_tokens']),
      output: num(u['output_tokens']),
      cacheRead: num(u['cache_read_input_tokens']),
      cacheCreation: num(u['cache_creation_input_tokens']),
    };
  }
  if (format === 'openai-responses') {
    return { input: num(u['input_tokens']), output: num(u['output_tokens']) };
  }
  return {
    input: num(u['prompt_tokens']) ?? num(u['input_tokens']),
    output: num(u['completion_tokens']) ?? num(u['output_tokens']),
    cacheRead: num(u['cache_read_input_tokens']),
  };
}

function extractToolCalls(
  format: WireFormat,
  b: Record<string, unknown>,
): RespParts['toolCalls'] {
  const out: NonNullable<RespParts['toolCalls']> = [];

  if (format === 'anthropic') {
    const content = Array.isArray(b['content']) ? b['content'] : [];
    for (const c of content) {
      if (isObj(c) && c['type'] === 'tool_use') {
        out.push({
          id: str(c['id']) || `call_${out.length}`,
          name: str(c['name']),
          arguments: JSON.stringify(c['input'] ?? {}),
        });
      }
    }
    return out.length ? out : undefined;
  }

  if (format === 'gemini') {
    const cands = Array.isArray(b['candidates']) ? b['candidates'] : [];
    const first = isObj(cands[0]) ? (cands[0] as Record<string, unknown>) : null;
    const content = first && isObj(first['content']) ? (first['content'] as Record<string, unknown>) : null;
    const parts = content && Array.isArray(content['parts']) ? (content['parts'] as unknown[]) : [];
    for (const p of parts) {
      if (isObj(p) && isObj(p['functionCall'])) {
        const fc = p['functionCall'] as Record<string, unknown>;
        out.push({
          id: `call_${out.length}`,
          name: str(fc['name']),
          arguments: JSON.stringify(fc['args'] ?? {}),
        });
      }
    }
    return out.length ? out : undefined;
  }

  if (format === 'openai-responses') {
    const output = Array.isArray(b['output']) ? b['output'] : [];
    for (const o of output) {
      if (isObj(o) && o['type'] === 'function_call') {
        out.push({
          id: str(o['call_id']) || str(o['id']) || `call_${out.length}`,
          name: str(o['name']),
          arguments: str(o['arguments']) || '{}',
        });
      }
    }
    return out.length ? out : undefined;
  }

  const choices = Array.isArray(b['choices']) ? b['choices'] : [];
  const first = isObj(choices[0]) ? (choices[0] as Record<string, unknown>) : null;
  const msg = first && isObj(first['message']) ? (first['message'] as Record<string, unknown>) : null;
  const tcs = msg && Array.isArray(msg['tool_calls']) ? (msg['tool_calls'] as unknown[]) : [];
  for (const tc of tcs) {
    if (!isObj(tc)) continue;
    const fn = isObj(tc['function']) ? (tc['function'] as Record<string, unknown>) : {};
    out.push({
      id: str(tc['id']) || `call_${out.length}`,
      name: str(fn['name']),
      arguments: typeof fn['arguments'] === 'string' ? fn['arguments'] : JSON.stringify(fn['arguments'] ?? {}),
    });
  }
  return out.length ? out : undefined;
}

/** 按目标格式拼装响应 */
function buildResponse(to: WireFormat, p: RespParts): Record<string, unknown> {
  if (to === 'anthropic') {
    const content: Record<string, unknown>[] = [];
    if (p.text) content.push({ type: 'text', text: p.text });
    for (const tc of p.toolCalls ?? []) {
      let input: unknown = {};
      try {
        input = JSON.parse(tc.arguments || '{}');
      } catch {
        input = {};
      }
      content.push({ type: 'tool_use', id: tc.id, name: tc.name, input });
    }
    if (!content.length) content.push({ type: 'text', text: '' });

    return {
      id: 'msg_' + Date.now().toString(36),
      type: 'message',
      role: 'assistant',
      model: p.model,
      content,
      stop_reason: finishFor('anthropic', p.finish),
      stop_sequence: null,
      usage: {
        input_tokens: p.usage.input ?? 0,
        output_tokens: p.usage.output ?? 0,
        ...(p.usage.cacheRead ? { cache_read_input_tokens: p.usage.cacheRead } : {}),
        ...(p.usage.cacheCreation ? { cache_creation_input_tokens: p.usage.cacheCreation } : {}),
      },
    };
  }

  if (to === 'gemini') {
    const parts: Record<string, unknown>[] = [];
    if (p.text) parts.push({ text: p.text });
    for (const tc of p.toolCalls ?? []) {
      let args: unknown = {};
      try {
        args = JSON.parse(tc.arguments || '{}');
      } catch {
        args = {};
      }
      parts.push({ functionCall: { name: tc.name, args } });
    }
    if (!parts.length) parts.push({ text: '' });

    return {
      candidates: [
        {
          content: { parts, role: 'model' },
          finishReason: finishFor('gemini', p.finish),
          index: 0,
        },
      ],
      usageMetadata: {
        promptTokenCount: p.usage.input ?? 0,
        candidatesTokenCount: p.usage.output ?? 0,
        totalTokenCount: (p.usage.input ?? 0) + (p.usage.output ?? 0),
      },
      modelVersion: p.model,
    };
  }

  if (to === 'openai-responses') {
    const output: Record<string, unknown>[] = [];
    if (p.text) {
      output.push({
        type: 'message',
        role: 'assistant',
        id: 'msg_' + Date.now().toString(36),
        content: [{ type: 'output_text', text: p.text }],
      });
    }
    for (const tc of p.toolCalls ?? []) {
      output.push({
        type: 'function_call',
        call_id: tc.id,
        name: tc.name,
        arguments: tc.arguments,
      });
    }
    return {
      id: 'resp_' + Date.now().toString(36),
      object: 'response',
      status: 'completed',
      model: p.model,
      output,
      usage: {
        input_tokens: p.usage.input ?? 0,
        output_tokens: p.usage.output ?? 0,
        total_tokens: (p.usage.input ?? 0) + (p.usage.output ?? 0),
      },
    };
  }

  // openai-chat
  const message: Record<string, unknown> = { role: 'assistant', content: p.text || null };
  if (p.toolCalls?.length) {
    message['tool_calls'] = p.toolCalls.map((tc) => ({
      id: tc.id,
      type: 'function',
      function: { name: tc.name, arguments: tc.arguments },
    }));
  }
  return {
    id: 'chatcmpl-' + Date.now().toString(36),
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: p.model,
    choices: [
      {
        index: 0,
        message,
        finish_reason: p.toolCalls?.length ? 'tool_calls' : (finishFor('openai-chat', p.finish) ?? 'stop'),
      },
    ],
    usage: {
      prompt_tokens: p.usage.input ?? 0,
      completion_tokens: p.usage.output ?? 0,
      total_tokens: (p.usage.input ?? 0) + (p.usage.output ?? 0),
    },
  };
}

// ============================================================
// 流式 (SSE) 转换
// ============================================================

/**
 * 流式转换器: 逐"事件"把上游格式转成客户端格式
 *
 * 状态机是必要的 —— Anthropic 需要先发 message_start / content_block_start,
 * 再发 delta, 最后 message_delta / message_stop; 而 OpenAI 只要 delta。
 */
export function createSseTranslator(from: WireFormat, to: WireFormat, model: string) {
  if (from === to) return null;

  let started = false;
  let finishSent = false;
  let usage: RespParts['usage'] = {};
  const id = 'msg_' + Date.now().toString(36);
  const created = Math.floor(Date.now() / 1000);

  // ---- 内容块状态 (anthropic 目标需要严格的开/关块协议) ----
  let nextIndex = 0;                                  // 下一个分配的内容块索引
  let textBlock: number | null = null;                // 当前打开的 text 块索引
  const toolBlocks = new Map<number, number>();       // 工具序号 -> 块索引
  // ---- 累积式目标的工具收集 (gemini / openai-responses 没有增量工具协议) ----
  const accTools = new Map<number, { id: string; name: string; args: string }>();

  const sse = (obj: unknown, event?: string): string =>
    (event ? `event: ${event}\n` : '') + `data: ${JSON.stringify(obj)}\n\n`;

  /** 收集工具增量到累积表 (gemini / openai-responses 目标用) */
  const accumulate = (tcs: NonNullable<CanonDelta['toolCalls']>) => {
    for (const tc of tcs) {
      const cur = accTools.get(tc.index) ?? { id: '', name: '', args: '' };
      if (tc.id) cur.id = tc.id;
      if (tc.name) cur.name = tc.name;
      if (tc.argumentsDelta) cur.args += tc.argumentsDelta;
      accTools.set(tc.index, cur);
    }
  };

  return {
    /** 处理上游一行 SSE; 返回要写给客户端的字节 (可能为空串) */
    line(line: string): string {
      if (!line.startsWith('data:')) return '';
      const payload = line.slice(5).trim();
      if (!payload) return '';
      if (payload === '[DONE]') {
        return to === 'openai-chat' ? 'data: [DONE]\n\n' : '';
      }

      let obj: Record<string, unknown>;
      try {
        obj = JSON.parse(payload) as Record<string, unknown>;
      } catch {
        return '';
      }

      // 上游错误 -> 原样透传给客户端
      if (isObj(obj['error'])) {
        return sse(obj);
      }

      const delta = parseDelta(from, obj);
      if (delta.usage) usage = { ...usage, ...delta.usage };
      if (!delta.text && !delta.finish && !delta.toolCalls?.length && !delta.usage && !delta.done) return '';

      let out = '';

      if (to === 'anthropic') {
        if (!started) {
          started = true;
          out += sse(
            {
              type: 'message_start',
              message: {
                id,
                type: 'message',
                role: 'assistant',
                model,
                content: [],
                stop_reason: null,
                stop_sequence: null,
                usage: { input_tokens: usage.input ?? 0, output_tokens: 0 },
              },
            },
            'message_start',
          );
        }
        if (delta.text) {
          if (textBlock === null) {
            textBlock = nextIndex++;
            out += sse(
              { type: 'content_block_start', index: textBlock, content_block: { type: 'text', text: '' } },
              'content_block_start',
            );
          }
          out += sse(
            { type: 'content_block_delta', index: textBlock, delta: { type: 'text_delta', text: delta.text } },
            'content_block_delta',
          );
        }
        // 工具调用: 首个分片(带 id/name)开新块, 后续分片只发 input_json_delta
        if (delta.toolCalls?.length) {
          for (const tc of delta.toolCalls) {
            if (!toolBlocks.has(tc.index)) {
              // 内容块串行: 开工具块前先关掉正打开的 text 块
              if (textBlock !== null) {
                out += sse({ type: 'content_block_stop', index: textBlock }, 'content_block_stop');
                textBlock = null;
              }
              const bi = nextIndex++;
              toolBlocks.set(tc.index, bi);
              out += sse(
                {
                  type: 'content_block_start',
                  index: bi,
                  content_block: { type: 'tool_use', id: tc.id || `call_${bi}`, name: tc.name || '', input: {} },
                },
                'content_block_start',
              );
            }
            if (tc.argumentsDelta) {
              out += sse(
                {
                  type: 'content_block_delta',
                  index: toolBlocks.get(tc.index) ?? 0,
                  delta: { type: 'input_json_delta', partial_json: tc.argumentsDelta },
                },
                'content_block_delta',
              );
            }
          }
        }
        if (delta.finish && !finishSent) {
          finishSent = true;
          if (textBlock !== null) {
            out += sse({ type: 'content_block_stop', index: textBlock }, 'content_block_stop');
            textBlock = null;
          }
          for (const bi of toolBlocks.values()) {
            out += sse({ type: 'content_block_stop', index: bi }, 'content_block_stop');
          }
          toolBlocks.clear();
          out += sse(
            {
              type: 'message_delta',
              delta: { stop_reason: finishFor('anthropic', delta.finish), stop_sequence: null },
              usage: { output_tokens: usage.output ?? 0 },
            },
            'message_delta',
          );
          out += sse({ type: 'message_stop' }, 'message_stop');
        }
        return out;
      }

      if (to === 'gemini') {
        if (delta.toolCalls?.length) accumulate(delta.toolCalls);
        if (delta.finish && !finishSent) {
          finishSent = true;
          // Gemini 没有增量工具协议: 累积完后在收尾一次性吐 functionCall parts
          const parts: Record<string, unknown>[] = [];
          for (const t of accTools.values()) {
            let args: unknown = {};
            try {
              args = JSON.parse(t.args || '{}');
            } catch {
              args = {};
            }
            parts.push({ functionCall: { name: t.name, args } });
          }
          return sse({
            candidates: [
              {
                content: { parts: parts.length ? parts : [{ text: '' }], role: 'model' },
                finishReason: finishFor('gemini', delta.finish),
                index: 0,
              },
            ],
            ...(usage.input || usage.output
              ? {
                  usageMetadata: {
                    promptTokenCount: usage.input ?? 0,
                    candidatesTokenCount: usage.output ?? 0,
                    totalTokenCount: (usage.input ?? 0) + (usage.output ?? 0),
                  },
                }
              : {}),
          });
        }
        if (!delta.text) return '';
        return sse({
          candidates: [{ content: { parts: [{ text: delta.text }], role: 'model' }, index: 0 }],
        });
      }

      if (to === 'openai-responses') {
        if (delta.toolCalls?.length) accumulate(delta.toolCalls);
        if (!started) {
          started = true;
          out += sse({ type: 'response.created', response: { id, model, status: 'in_progress' } });
        }
        if (delta.text) {
          out += sse({ type: 'response.output_text.delta', delta: delta.text });
        }
        if (delta.finish && !finishSent) {
          finishSent = true;
          // openai-responses 的工具以完整 output_item 形式在收尾时吐出
          let oi = 0;
          for (const t of accTools.values()) {
            out += sse({
              type: 'response.output_item.done',
              output_index: oi++,
              item: {
                type: 'function_call',
                id: t.id || `fc_${oi}`,
                call_id: t.id || `call_${oi}`,
                name: t.name,
                arguments: t.args || '{}',
                status: 'completed',
              },
            });
          }
          out += sse({ type: 'response.completed', response: { id, model, status: 'completed' } });
        }
        return out;
      }

      // openai-chat
      if (delta.text) {
        out += sse({
          id: 'chatcmpl-' + id,
          object: 'chat.completion.chunk',
          created,
          model,
          choices: [{ index: 0, delta: { content: delta.text } }],
        });
      }
      if (delta.toolCalls?.length) {
        out += sse({
          id: 'chatcmpl-' + id,
          object: 'chat.completion.chunk',
          created,
          model,
          choices: [{
            index: 0,
            delta: {
              tool_calls: delta.toolCalls.map((tc) => {
                const fn: Record<string, unknown> = {};
                if (tc.name) fn['name'] = tc.name;
                if (tc.argumentsDelta !== undefined) fn['arguments'] = tc.argumentsDelta;
                const entry: Record<string, unknown> = { index: tc.index, type: 'function', function: fn };
                if (tc.id) entry['id'] = tc.id;
                return entry;
              }),
            },
          }],
        });
      }
      if (delta.finish && !finishSent) {
        finishSent = true;
        out += sse({
          id: 'chatcmpl-' + id,
          object: 'chat.completion.chunk',
          created,
          model,
          choices: [{ index: 0, delta: {}, finish_reason: finishFor('openai-chat', delta.finish) ?? 'stop' }],
        });
        if (usage.input || usage.output) {
          out += sse({
            id: 'chatcmpl-' + id,
            object: 'chat.completion.chunk',
            created,
            model,
            choices: [],
            usage: {
              prompt_tokens: usage.input ?? 0,
              completion_tokens: usage.output ?? 0,
              total_tokens: (usage.input ?? 0) + (usage.output ?? 0),
            },
          });
        }
      }
      return out;
    },
  };
}

/** 把上游一个 SSE data 对象解析成规范增量 */
function parseDelta(from: WireFormat, o: Record<string, unknown>): CanonDelta {
  const d: CanonDelta = {};

  if (from === 'anthropic') {
    const t = String(o['type'] ?? '');
    if (t === 'content_block_start') {
      const block = isObj(o['content_block']) ? (o['content_block'] as Record<string, unknown>) : {};
      if (block['type'] === 'tool_use') {
        d.toolCalls = [{
          index: num(o['index']) ?? 0,
          id: str(block['id']) || undefined,
          name: str(block['name']) || undefined,
        }];
      }
    } else if (t === 'content_block_delta') {
      const delta = isObj(o['delta']) ? (o['delta'] as Record<string, unknown>) : {};
      if (delta['type'] === 'text_delta') d.text = str(delta['text']);
      else if (delta['type'] === 'input_json_delta') {
        d.toolCalls = [{ index: num(o['index']) ?? 0, argumentsDelta: str(delta['partial_json']) }];
      }
    } else if (t === 'message_delta') {
      const delta = isObj(o['delta']) ? (o['delta'] as Record<string, unknown>) : {};
      d.finish = normFinish(delta['stop_reason']);
      const u = isObj(o['usage']) ? (o['usage'] as Record<string, unknown>) : null;
      if (u) {
        d.usage = {
          input: num(u['input_tokens']),
          output: num(u['output_tokens']),
          cacheRead: num(u['cache_read_input_tokens']),
          cacheCreation: num(u['cache_creation_input_tokens']),
        };
      }
    } else if (t === 'message_start') {
      const msg = isObj(o['message']) ? (o['message'] as Record<string, unknown>) : {};
      const u = isObj(msg['usage']) ? (msg['usage'] as Record<string, unknown>) : null;
      if (u) d.usage = { input: num(u['input_tokens']), output: num(u['output_tokens']) };
    } else if (t === 'message_stop') {
      d.done = true;
      d.finish = d.finish ?? 'stop';
    }
    return d;
  }

  if (from === 'gemini') {
    const cands = Array.isArray(o['candidates']) ? o['candidates'] : [];
    const first = isObj(cands[0]) ? (cands[0] as Record<string, unknown>) : null;
    if (first) {
      const content = isObj(first['content']) ? (first['content'] as Record<string, unknown>) : null;
      const text = content ? geminiPartsToText(content['parts']) : '';
      if (text) d.text = text;
      if (first['finishReason']) d.finish = normFinish(first['finishReason']);
    }
    const um = isObj(o['usageMetadata']) ? (o['usageMetadata'] as Record<string, unknown>) : null;
    if (um) d.usage = { input: num(um['promptTokenCount']), output: num(um['candidatesTokenCount']) };
    return d;
  }

  if (from === 'openai-responses') {
    const t = String(o['type'] ?? '');
    if (t === 'response.output_text.delta') d.text = str(o['delta']);
    else if (t === 'response.completed') {
      d.finish = 'stop';
      const r = isObj(o['response']) ? (o['response'] as Record<string, unknown>) : {};
      const u = isObj(r['usage']) ? (r['usage'] as Record<string, unknown>) : null;
      if (u) d.usage = { input: num(u['input_tokens']), output: num(u['output_tokens']) };
    }
    return d;
  }

  // openai-chat
  const choices = Array.isArray(o['choices']) ? o['choices'] : [];
  const first = isObj(choices[0]) ? (choices[0] as Record<string, unknown>) : null;
  if (first) {
    const delta = isObj(first['delta']) ? (first['delta'] as Record<string, unknown>) : {};
    if (typeof delta['content'] === 'string' && delta['content']) d.text = delta['content'];
    if (first['finish_reason']) d.finish = normFinish(first['finish_reason']);
    if (Array.isArray(delta['tool_calls'])) {
      // 一条 chunk 里可能带多个工具的增量(并行调用), 必须全量收集;
      // 之前只取 [0] 会把并行工具调用的后续分片整包丢掉。
      const tcs: NonNullable<CanonDelta['toolCalls']> = [];
      for (const raw of delta['tool_calls'] as unknown[]) {
        if (!isObj(raw)) continue;
        const fn = isObj(raw['function']) ? (raw['function'] as Record<string, unknown>) : {};
        tcs.push({
          index: num(raw['index']) ?? 0,
          id: str(raw['id']) || undefined,
          name: str(fn['name']) || undefined,
          argumentsDelta: str(fn['arguments']) || undefined,
        });
      }
      if (tcs.length) d.toolCalls = tcs;
    }
  }
  const u = isObj(o['usage']) ? (o['usage'] as Record<string, unknown>) : null;
  if (u) {
    d.usage = {
      input: num(u['prompt_tokens']) ?? num(u['input_tokens']),
      output: num(u['completion_tokens']) ?? num(u['output_tokens']),
      cacheRead: num(u['cache_read_input_tokens']),
    };
  }
  return d;
}
