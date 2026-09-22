/**
 * 本地 mock 上游 —— 用于验证 /v1/models 与协议转换
 *
 * 模拟真实上游的行为:
 *   - OpenAI 兼容: GET /v1/models, POST /v1/chat/completions, POST /v1/responses
 *   - Gemini:      GET /v1beta/models, POST /v1beta/models/{m}:generateContent
 *   - Anthropic:   POST /v1/messages
 *
 * 关键: 收到**格式不对**的 body 时, 模仿真实上游返回 400
 * (复现 Gemini 的 "Unknown name messages" 那类报错)。
 *
 * 用法: node tools/mock-upstream.mjs [port]
 */
import { createServer } from 'node:http';

const port = Number(process.argv[2] ?? 9099);

const OPENAI_MODELS = {
  object: 'list',
  data: [
    { id: 'gpt-4o', object: 'model', created: 1700000000, owned_by: 'openai' },
    { id: 'gpt-4o-mini', object: 'model', created: 1700000000, owned_by: 'openai' },
  ],
};

const GEMINI_MODELS = {
  models: [{ name: 'models/gemini-2.0-flash' }, { name: 'models/gemini-1.5-pro' }],
};

/** 收集请求体 */
function readBody(req) {
  return new Promise((resolve) => {
    let s = '';
    req.on('data', (c) => (s += c));
    req.on('end', () => resolve(s));
  });
}

function send(res, status, obj) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(obj));
}

/** Gemini 的 Schema proto 不认这些 JSON Schema 关键字 */
const GEMINI_BAD_SCHEMA_KEYS = [
  '$schema',
  'additionalProperties',
  '$ref',
  '$defs',
  'definitions',
  'oneOf',
  'allOf',
  'not',
  'const',
  'examples',
  'multipleOf',
  'uniqueItems',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'patternProperties',
];

/** 递归扫描工具 schema 里的非法关键字(会被 Gemini 报 Unknown name) */
function scanSchema(schema, path, bad, depth = 0) {
  if (!schema || typeof schema !== 'object' || depth > 12) return;
  for (const k of Object.keys(schema)) {
    if (GEMINI_BAD_SCHEMA_KEYS.includes(k)) bad.push(`${k} at '${path}'`);
  }
  if (schema.properties && typeof schema.properties === 'object') {
    for (const [name, sub] of Object.entries(schema.properties)) {
      scanSchema(sub, `${path}.properties[${name}]`, bad, depth + 1);
    }
  }
  if (schema.items) scanSchema(schema.items, `${path}.items`, bad, depth + 1);
  if (Array.isArray(schema.anyOf)) {
    schema.anyOf.forEach((s, i) => scanSchema(s, `${path}.anyOf[${i}]`, bad, depth + 1));
  }
}

/**
 * 结构校验 —— 模仿 Gemini 的硬性要求:
 *   1) 每个 schema 节点都必须有 type
 *   2) type=array 必须有非空 items
 *   3) 不能出现空 schema {}
 * 违反时报 `* GenerateContentRequest.<path>: missing field.`
 * (路径写法与 Google 原文一致: properties 用 [name], items 用 .items)
 */
function scanStructure(schema, path, bad, depth = 0) {
  if (depth > 14) return;
  if (schema === null || typeof schema !== 'object' || Array.isArray(schema)) {
    bad.push(`${path}: missing field.`);
    return;
  }
  if (Object.keys(schema).length === 0) {
    bad.push(`${path}: missing field.`);
    return;
  }
  if (typeof schema.type !== 'string') {
    bad.push(`${path}: missing field.`);
    return; // 没有 type 就无从继续判断结构
  }
  if (schema.type === 'array') {
    const it = schema.items;
    if (!it || typeof it !== 'object' || Array.isArray(it) || Object.keys(it).length === 0) {
      bad.push(`${path}.items: missing field.`);
    } else {
      scanStructure(it, `${path}.items`, bad, depth + 1);
    }
  }
  if (schema.properties && typeof schema.properties === 'object') {
    for (const [name, sub] of Object.entries(schema.properties)) {
      scanStructure(sub, `${path}.properties[${name}]`, bad, depth + 1);
    }
  }
  if (Array.isArray(schema.anyOf)) {
    schema.anyOf.forEach((s, i) => scanStructure(s, `${path}.anyOf[${i}]`, bad, depth + 1));
  }
}

/** 模仿 Google 的两类校验报错: 未知字段名 + 结构缺字段 */
function geminiValidationErrors(body) {
  const unknown = ['messages', 'system', 'max_tokens', 'anthropic_version'].filter((k) => k in body);
  const structural = [];

  if (Array.isArray(body.tools)) {
    if (body.tools[0] && 'input_schema' in body.tools[0]) unknown.push('tools[].input_schema');
    const decls = body.tools[0]?.functionDeclarations;
    if (Array.isArray(decls)) {
      decls.forEach((d, i) => {
        const p = `tools[0].function_declarations[${i}].parameters`;
        scanSchema(d.parameters, p, unknown);
        scanStructure(d.parameters, `GenerateContentRequest.${p}`, structural);
      });
    }
  }

  const lines = [];
  if (unknown.length) {
    lines.push(
      'Invalid JSON payload received. ' +
        unknown.map((n) => `Unknown name "${n}": Cannot find field.`).join('\n'),
    );
  }
  for (const s of structural) lines.push(`* ${s}`);
  return lines.join('\n');
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${port}`);
  const raw = await readBody(req);
  let body = {};
  try {
    body = raw ? JSON.parse(raw) : {};
  } catch {
    body = { __parse_error: true };
  }
  const keys = Object.keys(body);
  console.log(
    `[mock] ${req.method} ${url.pathname}  keys=[${keys.join(',')}]  auth=${String(
      req.headers['authorization'] ?? req.headers['x-api-key'] ?? '(none)',
    ).slice(0, 28)}`,
  );

  // ---- 模型列表 ----
  if (req.method === 'GET' && url.pathname === '/v1/models') return send(res, 200, OPENAI_MODELS);
  if (req.method === 'GET' && url.pathname === '/v1beta/models') return send(res, 200, GEMINI_MODELS);

  // ---- 模仿 chatapi.weixin.qq.com ----
  // 它的 GET /v1/models 永远返回 400 "missing required parameter: model",
  // 且**与鉴权无关**(带不带 key 都一样)。用于回归:
  //   "后台测试连通性把 HTTP 400 当成 ok:true 上报" 这个 bug。
  if (req.method === 'GET' && url.pathname === '/openai/v1/models') {
    return send(res, 400, { error: { message: 'missing required parameter: model' } });
  }

  // ---- Gemini generateContent ----
  if (/^\/v1beta\/models\/[^:]+:(generateContent|streamGenerateContent)$/.test(url.pathname)) {
    const msg = geminiValidationErrors(body);
    if (msg) {
      return send(res, 400, {
        error: { code: 400, message: msg, status: 'INVALID_ARGUMENT' },
      });
    }
    if (!Array.isArray(body.contents)) {
      return send(res, 400, {
        error: { code: 400, message: 'contents is required', status: 'INVALID_ARGUMENT' },
      });
    }
    const model = url.pathname.split('/')[3].split(':')[0];
    // 模型名没从 URL 里解析出来时, 真实 API 会报 unknown
    if (!model || model === 'unknown') {
      return send(res, 404, {
        error: {
          code: 404,
          message: `models/${model || 'unknown'} is not found for API version v1beta`,
          status: 'NOT_FOUND',
        },
      });
    }
    const text = 'gemini-ok:' + JSON.stringify(body.contents[0]?.parts?.[0]?.text ?? '');
    if (url.pathname.includes('streamGenerateContent')) {
      res.statusCode = 200;
      res.setHeader('content-type', 'text/event-stream');
      for (const chunk of [
        { candidates: [{ content: { parts: [{ text }], role: 'model' } }] },
        { candidates: [{ content: { parts: [{ text: '' }], role: 'model' }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 2, totalTokenCount: 5 } },
      ]) {
        res.write(`data: ${JSON.stringify(chunk)}\n\n`);
      }
      res.end();
      return;
    }
    return send(res, 200, {
      candidates: [{ content: { parts: [{ text }], role: 'model' }, finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 2, totalTokenCount: 5 },
      modelVersion: model,
    });
  }

  // ---- Anthropic messages ----
  if (url.pathname === '/v1/messages') {
    if (!Array.isArray(body.messages)) {
      return send(res, 400, { type: 'error', error: { type: 'invalid_request_error', message: 'messages: field required' } });
    }
    const text = 'anthropic-ok:' + JSON.stringify(body.messages[0]?.content ?? '');
    if (body.stream) {
      res.statusCode = 200;
      res.setHeader('content-type', 'text/event-stream');
      res.write(`event: message_start\ndata: ${JSON.stringify({ type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', content: [], model: body.model, usage: { input_tokens: 3, output_tokens: 0 } } })}\n\n`);
      res.write(`event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })}\n\n`);
      res.write(`event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } })}\n\n`);
      res.write(`event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: 0 })}\n\n`);
      res.write(`event: message_delta\ndata: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } })}\n\n`);
      res.write(`event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`);
      res.end();
      return;
    }
    return send(res, 200, {
      id: 'msg_1', type: 'message', role: 'assistant', model: body.model,
      content: [{ type: 'text', text }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 3, output_tokens: 2 },
    });
  }

  // ---- OpenAI chat/completions ----
  if (url.pathname === '/v1/chat/completions') {
    if (!Array.isArray(body.messages)) {
      return send(res, 400, { error: { message: 'messages is required', type: 'invalid_request_error' } });
    }
    // 带 tools 的请求 -> 返回(并行两个)工具调用, 用于验证流式协议转换的 tool_calls 链路
    if (Array.isArray(body.tools) && body.tools.length) {
      const tc = (i, fn) => JSON.stringify({
        id: 'c1', object: 'chat.completion.chunk', model: body.model,
        choices: [{ index: 0, delta: { tool_calls: [fn] } }],
      });
      if (body.stream) {
        res.statusCode = 200;
        res.setHeader('content-type', 'text/event-stream');
        // 并行两个工具: read_file(0) + list_dir(1), arguments 分片发出
        res.write(tc(0, { id: 'call_a', index: 0, type: 'function', function: { name: 'read_file', arguments: '' } }) + '\n\n');
        res.write(tc(1, { id: null, index: 0, type: 'function', function: { name: null, arguments: '{"ta' } }) + '\n\n');
        res.write(tc(2, { id: null, index: 0, type: 'function', function: { name: null, arguments: 'rget_file": "a.vue"}' } }) + '\n\n');
        res.write(tc(3, { id: 'call_b', index: 1, type: 'function', function: { name: 'list_dir', arguments: '' } }) + '\n\n');
        res.write(tc(4, { id: null, index: 1, type: 'function', function: { name: null, arguments: '{"path": "src"}' } }) + '\n\n');
        res.write(`data: ${JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 3, completion_tokens: 9, total_tokens: 12 } })}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }
      return send(res, 200, {
        id: 'c1', object: 'chat.completion', model: body.model,
        choices: [{
          index: 0,
          message: {
            role: 'assistant', content: '',
            tool_calls: [
              { id: 'call_a', index: 0, type: 'function', function: { name: 'read_file', arguments: '{"target_file": "a.vue"}' } },
              { id: 'call_b', index: 1, type: 'function', function: { name: 'list_dir', arguments: '{"path": "src"}' } },
            ],
          },
          finish_reason: 'tool_calls',
        }],
        usage: { prompt_tokens: 3, completion_tokens: 9, total_tokens: 12 },
      });
    }
    const text = 'openai-ok:' + JSON.stringify(body.messages.at(-1)?.content ?? '');
    if (body.stream) {
      res.statusCode = 200;
      res.setHeader('content-type', 'text/event-stream');
      res.write(`data: ${JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta: { role: 'assistant', content: text } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }
    return send(res, 200, {
      id: 'c1', object: 'chat.completion', model: body.model,
      choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
    });
  }

  // ---- OpenAI responses ----
  // 严格只认 input: 真实的 Responses API(以及第三方中转)都不接受 chat 形状的
  // messages。之前这里放宽到 `|| body.messages`, 于是"chat 请求被错误路由到
  // /v1/responses"这种回归在本地测不出来 —— 必须保持严格。
  if (url.pathname === '/v1/responses') {
    if (!Array.isArray(body.input) && typeof body.input !== 'string') {
      return send(res, 400, {
        error: { message: 'missing required field: input', type: 'invalid_request_error' },
      });
    }
    return send(res, 200, {
      id: 'r1', object: 'response', status: 'completed', model: body.model,
      output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'responses-ok' }] }],
      usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 },
    });
  }

  send(res, 404, { error: { message: `not found: ${url.pathname}` } });
});

server.listen(port, '127.0.0.1', () => {
  console.log(`mock upstream listening on http://127.0.0.1:${port}`);
});
