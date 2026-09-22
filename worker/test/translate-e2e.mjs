/**
 * 协议转换端到端测试
 *
 * 前置:
 *   1. node tools/mock-upstream.mjs 9099      (模拟上游, 会校验请求形状)
 *   2. npx wrangler dev --port 8787 --local    (本地网关卡)
 *   3. 本地账号 base_url 指向 http://127.0.0.1:9099, 且凭证不是占位值
 *
 * 用法: node test/translate-e2e.mjs
 *
 * 覆盖: 4 种线格式两两之间的请求/响应转换 (含流式与工具定义)
 */

const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:8787';
const KEY = 'sk-0000000000000000000000000000000000000000000000000000000000000001';

let pass = 0;
let fail = 0;

function check(name, cond, detail = '') {
  if (cond) {
    pass++;
    console.log(`  PASS  ${name}`);
  } else {
    fail++;
    console.log(`  FAIL  ${name}${detail ? ' -> ' + detail : ''}`);
  }
}

async function post(path, body, headers = {}) {
  const r = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${KEY}`,
      'content-type': 'application/json',
      ...headers,
    },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  let json = {};
  try {
    json = JSON.parse(text);
  } catch {
    /* 非 JSON */
  }
  return { status: r.status, text, json };
}

/** 读 SSE 流, 返回所有 data 行解析后的对象 */
async function postStream(path, body, headers = {}) {
  const r = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${KEY}`,
      'content-type': 'application/json',
      ...headers,
    },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  const events = [];
  for (const line of text.split('\n')) {
    if (!line.startsWith('data:')) continue;
    const p = line.slice(5).trim();
    if (!p || p === '[DONE]') continue;
    try {
      events.push(JSON.parse(p));
    } catch {
      /* 跳过 */
    }
  }
  return { status: r.status, text, events };
}

async function main() {
  console.log(`\n=== 协议转换 E2E @ ${BASE} ===\n`);

  // ---------- 1. Anthropic 客户端 -> Gemini 上游 ----------
  console.log('[1] Anthropic 客户端 (/v1/messages) -> Gemini 上游');
  {
    const r = await post('/v1/messages', {
      model: 'gemini-2.0-flash',
      max_tokens: 64,
      system: 'be nice',
      messages: [{ role: 'user', content: 'translate-me' }],
    });
    check('非流式 200 (原来 400 Unknown name messages)', r.status === 200, `status=${r.status} ${r.text.slice(0, 160)}`);
    check('响应是 Anthropic message 形状', r.json['type'] === 'message' && r.json['role'] === 'assistant', r.text.slice(0, 120));
    const content = Array.isArray(r.json['content']) ? r.json['content'] : [];
    check('content[0].type === "text"', content[0]?.['type'] === 'text', JSON.stringify(content[0]));
    check('stop_reason 已归一化', r.json['stop_reason'] === 'end_turn', String(r.json['stop_reason']));
    check(
      'usage 是 Anthropic 字段名',
      typeof r.json['usage']?.['input_tokens'] === 'number',
      JSON.stringify(r.json['usage']),
    );
    check('上游确实收到 message 内容', String(content[0]?.['text'] ?? '').includes('translate-me'), String(content[0]?.['text']));
  }

  // ---------- 2. Anthropic 客户端 -> Gemini 上游 (流式) ----------
  console.log('\n[2] Anthropic 客户端 -> Gemini 上游 (流式)');
  {
    const r = await postStream('/v1/messages', {
      model: 'gemini-2.0-flash',
      max_tokens: 64,
      stream: true,
      messages: [{ role: 'user', content: 'stream-me' }],
    });
    check('流式 200', r.status === 200, `status=${r.status}`);
    const types = r.events.map((e) => String(e['type'] ?? ''));
    check('含 message_start', types.includes('message_start'), types.join(','));
    check('含 content_block_delta (text_delta)', r.text.includes('text_delta'), types.join(','));
    check('含 message_stop', types.includes('message_stop'), types.join(','));
    check('发过 message_delta (带 stop_reason)', r.text.includes('"stop_reason":"end_turn"'), r.text.slice(-200));
  }

  // ---------- 3. Anthropic 客户端 -> OpenAI 上游 ----------
  console.log('\n[3] Anthropic 客户端 -> OpenAI 上游 (model=gpt-4o)');
  {
    const r = await post('/v1/messages', {
      model: 'gpt-4o',
      max_tokens: 64,
      messages: [{ role: 'user', content: 'openai-target' }],
    });
    check('200', r.status === 200, `status=${r.status} ${r.text.slice(0, 160)}`);
    check('响应仍是 Anthropic 形状', r.json['type'] === 'message', r.text.slice(0, 120));
    check('文本正确回带', r.text.includes('openai-target'), r.text.slice(0, 200));
  }

  // ---------- 4. OpenAI 客户端 -> Anthropic 上游 ----------
  console.log('\n[4] OpenAI 客户端 (/v1/chat/completions) -> Anthropic 上游');
  {
    const r = await post('/v1/chat/completions', {
      model: 'claude-sonnet-4-20250514',
      max_tokens: 64,
      messages: [
        { role: 'system', content: 'be nice' },
        { role: 'user', content: 'anthropic-target' },
      ],
    });
    check('200', r.status === 200, `status=${r.status} ${r.text.slice(0, 160)}`);
    check('object === "chat.completion"', r.json['object'] === 'chat.completion', String(r.json['object']));
    const choices = Array.isArray(r.json['choices']) ? r.json['choices'] : [];
    const msg = choices[0]?.['message'] ;
    check('choices[0].message.content 存在', typeof msg?.['content'] === 'string', JSON.stringify(msg));
    check('usage 是 OpenAI 字段名', typeof r.json['usage']?.['prompt_tokens'] === 'number', JSON.stringify(r.json['usage']));
    check('文本正确回带', r.text.includes('anthropic-target'), r.text.slice(0, 200));
  }

  // ---------- 5. OpenAI 客户端 -> Anthropic 上游 (流式) ----------
  console.log('\n[5] OpenAI 客户端 -> Anthropic 上游 (流式)');
  {
    const r = await postStream('/v1/chat/completions', {
      model: 'claude-sonnet-4-20250514',
      max_tokens: 64,
      stream: true,
      messages: [{ role: 'user', content: 'stream-anth' }],
    });
    check('流式 200', r.status === 200, `status=${r.status}`);
    check('含 chat.completion.chunk', r.text.includes('chat.completion.chunk'), r.text.slice(0, 200));
    check('含 delta.content 文本', r.text.includes('stream-anth'), r.text.slice(0, 300));
    check('含 finish_reason', r.text.includes('finish_reason'), r.text.slice(-200));
  }

  // ---------- 6. OpenAI 客户端 -> Gemini 上游 ----------
  console.log('\n[6] OpenAI 客户端 -> Gemini 上游');
  {
    const r = await post('/v1/chat/completions', {
      model: 'gemini-2.0-flash',
      messages: [{ role: 'user', content: 'gemini-target' }],
    });
    check('200', r.status === 200, `status=${r.status} ${r.text.slice(0, 160)}`);
    check('object === "chat.completion"', r.json['object'] === 'chat.completion', String(r.json['object']));
    check('文本正确回带', r.text.includes('gemini-target'), r.text.slice(0, 200));
  }

  // ---------- 7. 工具定义转换 ----------
  console.log('\n[7] 工具定义 (tools) 跨协议转换');
  {
    // Anthropic tools (input_schema) -> Gemini functionDeclarations
    const g = await post('/v1/messages', {
      model: 'gemini-2.0-flash',
      max_tokens: 64,
      messages: [{ role: 'user', content: 'weather?' }],
      tools: [
        {
          name: 'get_weather',
          description: 'get weather',
          input_schema: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
        },
      ],
    });
    check('Anthropic tools -> Gemini 200 (原来 400 Unknown name input_schema)', g.status === 200, `status=${g.status} ${g.text.slice(0, 160)}`);

    // Anthropic tools -> OpenAI function 形状
    const o = await post('/v1/messages', {
      model: 'gpt-4o',
      max_tokens: 64,
      messages: [{ role: 'user', content: 'weather?' }],
      tools: [{ name: 'get_weather', description: 'd', input_schema: { type: 'object', properties: {} } }],
    });
    check('Anthropic tools -> OpenAI 200', o.status === 200, `status=${o.status} ${o.text.slice(0, 160)}`);
  }

  // ---------- 8. 同协议不应被改写 ----------
  console.log('\n[8] 同协议直通 (不应触发转换)');
  {
    const r = await post('/v1/messages', {
      model: 'claude-sonnet-4-20250514',
      max_tokens: 64,
      messages: [{ role: 'user', content: 'passthrough' }],
    });
    check('Anthropic -> Anthropic 200', r.status === 200, `status=${r.status}`);
  }

  // 回归: OpenAI 客户端 -> OpenAI 协议上游 (同协议直通, 不触发转换)
  // 背景: explicitPath 以前只在 needTranslate 时才赋值, 于是同协议的
  //       /v1/chat/completions 会落到 deriveUpstreamEndpoint() 的
  //       /v1/responses 分支, 而第三方"OpenAI 兼容"中转没有该端点 -> 400
  //       (真实报错: missing required field "input")。
  {
    const r = await post('/v1/chat/completions', {
      model: 'gpt-4o',
      max_tokens: 64,
      messages: [{ role: 'user', content: 'openai passthrough' }],
    });
    check('OpenAI -> OpenAI 同协议直通 200', r.status === 200, `status=${r.status} ${r.text.slice(0, 160)}`);
    check(
      '  -> 仍是 chat.completion 形状',
      r.json.object === 'chat.completion',
      JSON.stringify(r.json).slice(0, 160),
    );
  }

  // ---------- 9. 占位凭证守卫 ----------
  console.log('\n[9] 占位凭证守卫');
  {
    // 本地已改成非占位 key, 这里只验证 502 分支的 code 出现在正常路径之外
    // (若本地仍是 REPLACE_ME, 上面所有用例都会 502 并带 placeholder_credential)
    console.log('  SKIP  需人工把账号凭证改回 REPLACE_ME 才能验证此分支');
  }

  // ---------- 10. Gemini 工具 schema 清洗 ----------
  // 背景: Gemini 的 Schema proto 只认部分 JSON Schema 关键字, 多出来的会 400
  //       `Invalid JSON payload received. Unknown name "$schema": Cannot find field.`
  //       mock 上游已按同样规则校验, 因此这些用例能真正拦住回归。
  console.log('\n[10] Gemini 工具 schema 清洗');
  {
    const r1 = await post('/v1/chat/completions', {
      model: 'gemini-1.5-pro',
      max_tokens: 64,
      messages: [{ role: 'user', content: 'weather?' }],
      tools: [
        {
          type: 'function',
          function: {
            name: 'get_weather',
            description: 'get weather',
            parameters: {
              $schema: 'http://json-schema.org/draft-07/schema#',
              type: 'object',
              additionalProperties: false,
              properties: { city: { type: 'string', description: 'city' } },
              required: ['city'],
            },
          },
        },
      ],
    });
    check(
      'OpenAI tools 含 $schema/additionalProperties -> Gemini 200',
      r1.status === 200,
      `status=${r1.status} ${r1.text.slice(0, 200)}`,
    );

    const r2 = await post('/v1/chat/completions', {
      model: 'gemini-1.5-pro',
      max_tokens: 64,
      messages: [{ role: 'user', content: 'x' }],
      tools: [
        {
          type: 'function',
          function: {
            name: 'f',
            parameters: {
              type: 'object',
              properties: {
                v: { oneOf: [{ type: 'string' }, { type: 'number' }], const: 'a', examples: ['a'] },
                n: { type: ['integer', 'null'] },
              },
              patternProperties: { '^x': { type: 'string' } },
            },
          },
        },
      ],
    });
    check(
      'OpenAI tools 含 oneOf/const/examples/type数组 -> Gemini 200',
      r2.status === 200,
      `status=${r2.status} ${r2.text.slice(0, 200)}`,
    );

    const r3 = await post(
      '/v1/messages',
      {
        model: 'gemini-1.5-pro',
        max_tokens: 64,
        messages: [{ role: 'user', content: 'weather?' }],
        tools: [
          {
            name: 'get_weather',
            description: 'd',
            input_schema: {
              $schema: 'https://json-schema.org/draft/2020-12/schema',
              type: 'object',
              additionalProperties: false,
              properties: { city: { type: 'string' } },
            },
          },
        ],
      },
      { 'anthropic-version': '2023-06-01' },
    );
    check(
      'Anthropic tools(input_schema) 含非法关键字 -> Gemini 200',
      r3.status === 200,
      `status=${r3.status} ${r3.text.slice(0, 200)}`,
    );

    const r4 = await post('/v1/chat/completions', {
      model: 'gemini-1.5-pro',
      max_tokens: 64,
      messages: [{ role: 'user', content: 'x' }],
      tools: [
        {
          type: 'function',
          function: {
            name: 'deep',
            parameters: {
              type: 'object',
              properties: {
                outer: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    inner: { type: 'object', $schema: 'x', additionalProperties: true, properties: {} },
                  },
                },
              },
            },
          },
        },
      ],
    });
    check(
      '嵌套 schema 内的非法关键字也被清除 -> Gemini 200',
      r4.status === 200,
      `status=${r4.status} ${r4.text.slice(0, 200)}`,
    );

    // --- 结构完整性: Gemini 要求每个节点都有 type, 且 array 必须带 items ---
    // 复现真实报错: tools[0].function_declarations[1].parameters
    //               .properties[query].properties[where].items.items: missing field.
    const r5 = await post('/v1/chat/completions', {
      model: 'gemini-1.5-pro',
      max_tokens: 64,
      messages: [{ role: 'user', content: 'query' }],
      tools: [
        { type: 'function', function: { name: 'noop', description: 'x', parameters: { type: 'object', properties: {} } } },
        {
          type: 'function',
          function: {
            name: 'query_db',
            description: 'query a database',
            parameters: {
              type: 'object',
              properties: {
                query: {
                  type: 'object',
                  properties: {
                    // 内层 array 没有 items -> 原样转发必然报 items.items: missing field.
                    where: { type: 'array', items: { type: 'array' } },
                  },
                },
              },
            },
          },
        },
      ],
    });
    check(
      '数组套数组缺 items -> Gemini 200 (原 items.items: missing field.)',
      r5.status === 200,
      `status=${r5.status} ${r5.text.slice(0, 240)}`,
    );

    const r6 = await post('/v1/chat/completions', {
      model: 'gemini-1.5-pro',
      max_tokens: 64,
      messages: [{ role: 'user', content: 'x' }],
      tools: [
        {
          type: 'function',
          function: {
            name: 'messy',
            description: 'd',
            parameters: {
              type: 'object',
              properties: {
                noType: { properties: { name: { type: 'string' } } }, // 缺 type 的对象
                noTypeArr: { items: { type: 'string' } }, // 缺 type 的数组
                emptyNode: {}, // 空 schema
                orphanDesc: { description: '只有描述' },
                tupleItems: { type: 'array', items: [{ type: 'string' }, { type: 'number' }] },
                arrayNoItems: { type: 'array' },
              },
            },
          },
        },
      ],
    });
    check(
      '缺 type / 空节点 / 无 items 数组 全部被补齐 -> Gemini 200',
      r6.status === 200,
      `status=${r6.status} ${r6.text.slice(0, 240)}`,
    );

    const r7 = await post('/v1/chat/completions', {
      model: 'gemini-1.5-pro',
      max_tokens: 64,
      messages: [{ role: 'user', content: 'x' }],
      tools: [
        { type: 'function', function: { name: 'emptyParams', parameters: {} } },
        { type: 'function', function: { name: 'noParams' } },
      ],
    });
    check(
      '空/缺失的 parameters 兜底成 object -> Gemini 200',
      r7.status === 200,
      `status=${r7.status} ${r7.text.slice(0, 240)}`,
    );
  }

  // ---------- 11. Gemini 原生路径的模型名提取 ----------
  // 背景: /v1beta/models/{model}:generateContent 的模型名在 URL 上而非 body,
  //       之前 extractModel 只读 body.model -> 拿到 'unknown' -> 上游 404
  console.log('\n[11] Gemini 原生路径模型名提取');
  {
    const r = await post('/v1beta/models/gemini-1.5-pro:generateContent', {
      contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
    });
    check(
      '/v1beta/models/{model}:generateContent 不再 404 unknown',
      r.status === 200,
      `status=${r.status} ${r.text.slice(0, 200)}`,
    );
  }

  console.log(`\n=== 结果: ${pass} passed, ${fail} failed ===\n`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error('转换 E2E 运行失败:', e.message);
  process.exit(1);
});
