/**
 * openai-responses 上游的**工具调用**流式回归 —— 2026-11-24 的"读文件就断"根因锁定。
 *
 * 背景:
 *   账号 protocol=openai-responses 时, 客户端(Anthropic / Claude Code 系)发出的
 *   /v1/messages 会被转成 Responses 请求打到上游 /v1/responses。
 *   上游把工具调用发成独立事件:
 *     response.output_item.added / response.function_call_arguments.delta / ...done
 *   而早期 parseDelta 只认 response.output_text.delta + response.completed,
 *   于是**所有工具调用被静默丢弃** —— 客户端只收到
 *     message_start -> message_delta(end_turn) -> message_stop
 *   表现为: 简单问答正常, 一旦要读文件/用工具就"直接断掉"。
 *
 * 覆盖:
 *   [1] 上游流式 function_call -> 客户端拿到 tool_use 块 + stop_reason=tool_use
 *   [2] 多轮历史: assistant.tool_calls / tool_result -> function_call / function_call_output
 *   [3] 上游 EOF 不给 completed -> 仍然补发 message_stop (不再挂死)
 *   [4] 上游 response.incomplete -> stop_reason=max_tokens 而不是静默结束
 *
 * 用法:
 *   ADMIN_PASS=localtest123 node tools/run-e2e.mjs 8787 test/responses-tool-stream-e2e.mjs
 *   (未提供 ADMIN_PASS 自动跳过, 退出码 0)
 */
import { createServer } from 'node:http';

const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:8787';
const USER = process.env.ADMIN_USER ?? 'admin';
const PASS = process.env.ADMIN_PASS ?? '';
// 与 schema/seed.sql 的种子 Key 一致(本地 e2e 专用)
const KEY = 'sk-0000000000000000000000000000000000000000000000000000000000000001';

let pass = 0;
let fail = 0;
let skip = 0;

function check(name, cond, detail = '') {
  if (cond) {
    pass++;
    console.log(`  PASS  ${name}`);
  } else {
    fail++;
    console.log(`  FAIL  ${name}${detail ? ' -> ' + detail : ''}`);
  }
}

/** 展开 SSE 文本 -> 事件对象数组 */
function parseSse(text) {
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith('data:')) continue;
    const p = line.slice(5).trim();
    if (!p || p === '[DONE]') continue;
    try {
      out.push(JSON.parse(p));
    } catch {
      /* 忽略非 JSON */
    }
  }
  return out;
}

// ---- mock 上游: 按 mode 决定吐哪种 responses 流 ----
const hits = [];
let mode = 'tool';
const mock = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    hits.push({ method: req.method, url: req.url, body });

    if (!req.url.includes('/v1/responses')) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end('{"error":{"message":"not found"}}');
      return;
    }

    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    const ev = (o) => res.write(`event: ${o.type}\ndata: ${JSON.stringify(o)}\n\n`);

    ev({ type: 'response.created', response: { id: 'resp_e2e', model: 'e2e-tool-model', status: 'in_progress' } });

    if (mode === 'tool') {
      ev({
        type: 'response.output_item.added',
        output_index: 0,
        item: { id: 'fc_e2e', type: 'function_call', status: 'in_progress', call_id: 'call_e2e_1', name: 'read_file', arguments: '' },
      });
      // 参数分两片, 验证 input_json_delta 拼接
      ev({ type: 'response.function_call_arguments.delta', output_index: 0, item_id: 'fc_e2e', delta: '{"path":' });
      ev({ type: 'response.function_call_arguments.delta', output_index: 0, item_id: 'fc_e2e', delta: '"/etc/hostname"}' });
      ev({
        type: 'response.output_item.done',
        output_index: 0,
        item: { id: 'fc_e2e', type: 'function_call', status: 'completed', call_id: 'call_e2e_1', name: 'read_file', arguments: '{"path":"/etc/hostname"}' },
      });
      ev({
        type: 'response.completed',
        response: {
          id: 'resp_e2e',
          status: 'completed',
          output: [
            { type: 'function_call', id: 'fc_e2e', call_id: 'call_e2e_1', name: 'read_file', arguments: '{"path":"/etc/hostname"}' },
          ],
          usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 },
        },
      });
      res.end();
      return;
    }

    if (mode === 'eof') {
      // 只给一点文本就断流, 不给 completed —— 旧实现会让客户端永远等 message_stop
      ev({ type: 'response.output_text.delta', delta: 'hello' });
      res.end();
      return;
    }

    if (mode === 'incomplete') {
      ev({
        type: 'response.incomplete',
        response: {
          id: 'resp_e2e',
          status: 'incomplete',
          incomplete_details: { reason: 'max_output_tokens' },
          output: [],
          usage: { input_tokens: 50, output_tokens: 8, total_tokens: 58 },
        },
      });
      res.end();
      return;
    }
  });
});

async function main() {
  console.log(`\n=== responses 工具调用流式 E2E @ ${BASE} ===\n`);

  if (!PASS) {
    console.log('  SKIP  未提供 ADMIN_PASS, 跳过 (用法: ADMIN_PASS=xxx node tools/run-e2e.mjs 8787 test/responses-tool-stream-e2e.mjs)');
    skip++;
    console.log(`\n=== 结果: ${pass} passed, ${fail} failed, ${skip} skipped ===\n`);
    process.exit(0);
  }

  await new Promise((r) => mock.listen(0, '127.0.0.1', r));
  const mockPort = mock.address().port;
  const RESP_URL = `http://127.0.0.1:${mockPort}/v1/responses`;
  const RUN = Date.now().toString(36).slice(-5);
  const ENTRY = 'e2etool' + RUN;
  const GW = `/${ENTRY}/v1/messages`;

  // ---- 登录 ----
  const loginRes = await fetch(`${BASE}/api/admin/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: USER, password: PASS }),
  });
  const cookie = (loginRes.headers.get('set-cookie') ?? '').split(';')[0];
  check('管理员登录 200', loginRes.status === 200, `status=${loginRes.status}`);
  if (loginRes.status !== 200) {
    mock.close();
    process.exit(1);
  }

  const req = async (method, path, body) => {
    const r = await fetch(`${BASE}/api/admin${path}`, {
      method,
      headers: { cookie, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await r.text();
    let json = {};
    try { json = JSON.parse(text); } catch { /* 非 JSON */ }
    return { status: r.status, text, json };
  };

  // ---- 建一个 responses 专用账号 ----
  console.log('\n[0] 创建 openai-responses 账号');
  const createRes = await req('POST', '/accounts', {
    name: 'e2e-responses-tool-' + RUN,
    platform: 'e2eresptool',
    protocol: 'openai-responses',
    type: 'apikey',
    api_key: 'sk-e2e-responses-credential',
    base_url: RESP_URL,
    base_url_full: true,
    entry_path: ENTRY,
    group_ids: [],
  });
  check('创建账号 201', createRes.status === 201, createRes.text.slice(0, 200));
  const id = createRes.json?.id;
  if (!id) {
    mock.close();
    process.exit(1);
  }

  const gateway = async (body) => {
    const r = await fetch(`${BASE}${GW}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
      body: JSON.stringify(body),
    });
    const text = await r.text();
    return { status: r.status, text, events: parseSse(text) };
  };

  // ---- [1] 上游 function_call -> 客户端 tool_use ----
  console.log('\n[1] 上游流式 function_call 必须转成 tool_use 块');
  mode = 'tool';
  hits.length = 0;
  const r1 = await gateway({
    model: 'e2e-tool-model',
    max_tokens: 512,
    stream: true,
    messages: [{ role: 'user', content: 'read /etc/hostname' }],
    tools: [{
      name: 'read_file',
      description: 'read a file',
      input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    }],
  });

  check('网关返回 200', r1.status === 200, `status=${r1.status} ${r1.text.slice(0, 160)}`);

  const blocks = r1.events.filter((e) => e.type === 'content_block_start');
  const toolBlock = blocks.find((b) => b.content_block?.type === 'tool_use');
  check('客户端收到 tool_use 内容块', !!toolBlock, `blocks=${JSON.stringify(blocks).slice(0, 240)}`);
  check('tool_use 名称 = read_file', toolBlock?.content_block?.name === 'read_file',
    `name=${JSON.stringify(toolBlock?.content_block?.name)}`);

  const argDeltas = r1.events
    .filter((e) => e.type === 'content_block_delta' && e.delta?.type === 'input_json_delta')
    .map((e) => e.delta.partial_json)
    .join('');
  let parsedArgs = null;
  try { parsedArgs = JSON.parse(argDeltas); } catch { /* 非法 JSON */ }
  check('工具参数分片拼接后是合法 JSON 且 path 正确',
    parsedArgs?.path === '/etc/hostname', `joined=${JSON.stringify(argDeltas)}`);

  const md1 = r1.events.find((e) => e.type === 'message_delta');
  check('stop_reason = tool_use (客户端据此执行工具)', md1?.delta?.stop_reason === 'tool_use',
    `stop_reason=${JSON.stringify(md1?.delta?.stop_reason)}`);
  check('收到 message_stop', r1.events.some((e) => e.type === 'message_stop'));
  check('工具块被正确关闭',
    r1.events.filter((e) => e.type === 'content_block_stop').length >= 1);

  // ---- [2] 请求方向: 多轮工具历史要转成 function_call / function_call_output ----
  console.log('\n[2] 多轮历史(assistant tool_use + user tool_result)转 responses 条目');
  mode = 'tool';
  hits.length = 0;
  await gateway({
    model: 'e2e-tool-model',
    max_tokens: 512,
    stream: true,
    messages: [
      { role: 'user', content: 'read /etc/hostname' },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'sure' },
          { type: 'tool_use', id: 'call_prev_1', name: 'read_file', input: { path: '/etc/hostname' } },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'call_prev_1', content: 'my-host' },
        ],
      },
    ],
    tools: [{
      name: 'read_file',
      description: 'read a file',
      input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    }],
  });

  const sent = hits.length ? JSON.parse(hits[0].body) : {};
  const inputItems = Array.isArray(sent.input) ? sent.input : [];
  const fcItem = inputItems.find((it) => it.type === 'function_call');
  const fcoItem = inputItems.find((it) => it.type === 'function_call_output');
  check('历史里的 tool_use 变成 function_call 条目', !!fcItem, `input=${JSON.stringify(inputItems).slice(0, 300)}`);
  check('function_call 带 call_id 与 name',
    fcItem?.call_id === 'call_prev_1' && fcItem?.name === 'read_file',
    JSON.stringify(fcItem));
  check('工具结果变成 function_call_output 并带上同一个 call_id',
    fcoItem?.call_id === 'call_prev_1' && String(fcoItem?.output ?? '').includes('my-host'),
    JSON.stringify(fcoItem));
  check('没有把工具结果降级成 role:user 的纯文本',
    !inputItems.some((it) => it.role === 'user' && String(it.content ?? '') === 'my-host'),
    JSON.stringify(inputItems).slice(0, 300));

  // ---- [3] 上游 EOF 不给 completed -> 仍要收尾 ----
  console.log('\n[3] 上游断流(无 completed)也必须补发 message_stop');
  mode = 'eof';
  hits.length = 0;
  const r3 = await gateway({
    model: 'e2e-tool-model',
    max_tokens: 512,
    stream: true,
    messages: [{ role: 'user', content: 'hi' }],
  });
  check('仍然返回 200', r3.status === 200, `status=${r3.status}`);
  check('收到文本增量 hello',
    r3.events.some((e) => e.type === 'content_block_delta' && e.delta?.text === 'hello'),
    JSON.stringify(r3.events.map((e) => e.type)));
  check('EOF 兜底补发了 message_stop (不再挂死)',
    r3.events.some((e) => e.type === 'message_stop'),
    `events=${JSON.stringify(r3.events.map((e) => e.type))}`);

  // ---- [4] incomplete -> max_tokens ----
  console.log('\n[4] 上游 response.incomplete 要报 max_tokens');
  mode = 'incomplete';
  hits.length = 0;
  const r4 = await gateway({
    model: 'e2e-tool-model',
    max_tokens: 512,
    stream: true,
    messages: [{ role: 'user', content: 'hi' }],
  });
  const md4 = r4.events.find((e) => e.type === 'message_delta');
  check('stop_reason = max_tokens',
    md4?.delta?.stop_reason === 'max_tokens',
    `stop_reason=${JSON.stringify(md4?.delta?.stop_reason)} events=${JSON.stringify(r4.events.map((e) => e.type))}`);
  check('仍然有 message_stop', r4.events.some((e) => e.type === 'message_stop'));

  // ---- 清理 ----
  await req('DELETE', `/accounts/${id}`);

  console.log(`\n=== 结果: ${pass} passed, ${fail} failed, ${skip} skipped ===\n`);
  mock.close();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('E2E 异常:', e);
  mock.close();
  process.exit(1);
});
