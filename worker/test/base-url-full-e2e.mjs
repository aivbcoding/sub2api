/**
 * 「完整 URL」开关(accounts.extra.base_url_full)端到端 —— 新功能回归。
 *
 * 覆盖:
 *   1. 开关开启: 网关请求**原样**打到 base_url, 不再拼 /v1/chat/completions
 *   2. 开关关闭: 恢复正常拼接(base_url + /v1/chat/completions)
 *   3. PUT 合并语义: 改 base_url_full 不清 model_aliases, 反之亦然
 *   4. 连通性测试: 完整 URL 账号明确报"无法推导模型列表地址", 而不是打坏请求
 *   5. serializeAccount 回显 base_url_full
 *
 * 做法同 admin-account-test-e2e.mjs, 但 mock 上游直接内嵌在测试进程里
 * (createServer 录下每次请求的 path), 不依赖外部 mock-upstream。
 *
 * 前置:
 *   1. 本地 wrangler dev --port 8787 (由 tools/run-e2e.mjs 拉起)
 *   2. .dev.vars + 本地已初始化的管理员账号
 *
 * 用法:
 *   ADMIN_PASS=localtest123 node tools/run-e2e.mjs 8787 test/base-url-full-e2e.mjs
 *   (未提供 ADMIN_PASS 自动跳过, 退出码 0)
 */
import { createServer } from 'node:http';

const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:8787';
const USER = process.env.ADMIN_USER ?? 'admin';
const PASS = process.env.ADMIN_PASS ?? '';
// 与 schema/seed.sql 里的种子 Key 一致(本地 e2e 专用)
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

/** 录请求 path 的 mock 上游: 任何路径都回一个合法的 OpenAI chat completion */
const hits = [];
const mock = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    hits.push({ method: req.method, url: req.url });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      id: 'chatcmpl-e2e-full',
      object: 'chat.completion',
      model: 'e2e-full-model',
      choices: [{
        index: 0,
        message: { role: 'assistant', content: 'ok' },
        finish_reason: 'stop',
      }],
      usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
    }));
  });
});

async function main() {
  console.log(`\n=== 完整 URL 开关 E2E @ ${BASE} ===\n`);

  if (!PASS) {
    console.log('  SKIP  未提供 ADMIN_PASS, 跳过 (用法: ADMIN_PASS=xxx node tools/run-e2e.mjs 8787 test/base-url-full-e2e.mjs)');
    skip++;
    console.log(`\n=== 结果: ${pass} passed, ${fail} failed, ${skip} skipped ===\n`);
    process.exit(0);
  }

  await new Promise((r) => mock.listen(0, '127.0.0.1', r));
  const mockPort = mock.address().port;
  // 一个"藏得很深"的完整端点地址 —— 如果网关还想拼 /v1/chat/completions, path 就会变长
  const FULL_URL = `http://127.0.0.1:${mockPort}/custom/endpoint/chat/completions`;
  // 入口路径每次运行唯一: 本地 D1 里可能有历史软删残留, 撞唯一索引没有意义
  const RUN = Date.now().toString(36).slice(-5);
  const ENTRY = 'e2efull' + RUN;
  const GW_PATH = `/${ENTRY}/v1/chat/completions`;

  // ---- 登录拿会话 Cookie ----
  console.log('[1] 管理员登录');
  const loginRes = await fetch(`${BASE}/api/admin/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: USER, password: PASS }),
  });
  const cookie = (loginRes.headers.get('set-cookie') ?? '').split(';')[0];
  check('登录返回 200', loginRes.status === 200, `status=${loginRes.status}`);
  if (loginRes.status !== 200) {
    console.log(`\n=== 结果: ${pass} passed, ${fail} failed ===\n`);
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

  // ---- 创建完整 URL 账号 ----
  console.log('\n[2] 创建开启完整 URL 的账号');
  const createRes = await req('POST', '/accounts', {
    name: 'e2e-full-url-account-' + RUN,
    platform: 'e2efullurl',           // 自定义平台 -> base_url 必填
    protocol: 'openai',
    type: 'apikey',
    api_key: 'sk-e2e-full-url-credential',
    base_url: FULL_URL,
    base_url_full: true,
    entry_path: ENTRY,                // 入口路径锁死本账号, 不受分组路由影响
    group_ids: [],
  });
  check('创建账号返回 201', createRes.status === 201, createRes.text.slice(0, 200));
  const id = createRes.json?.id;
  if (!id) {
    console.log(`\n=== 结果: ${pass} passed, ${fail} failed ===\n`);
    mock.close();
    process.exit(1);
  }

  // 没有单查接口(GET /accounts 只有列表), 从列表里找本账号
  const getAcct = async () => {
    const r = await req('GET', '/accounts');
    return (r.json?.accounts || []).find((a) => a.id === id) || {};
  };

  const a0 = await getAcct();
  check('回显 base_url_full === true', a0.base_url_full === true, JSON.stringify({ base_url_full: a0.base_url_full }));

  // ---- 完整凭证: 按需单条读, 列表不吐明文 ----
  console.log('\n[2b] 还原显示完整凭证');
  const credRes = await req('GET', `/accounts/${id}/credential`);
  check('GET /accounts/:id/credential 返回完整明文',
    credRes.json?.ok === true && credRes.json?.credential === 'sk-e2e-full-url-credential',
    credRes.text.slice(0, 200));
  const listRes = await req('GET', '/accounts');
  check('列表接口不泄露完整凭证',
    !listRes.text.includes('sk-e2e-full-url-credential'),
    listRes.text.slice(0, 200));
  const noAuth = await fetch(`${BASE}/api/admin/accounts/${id}/credential`);
  check('未登录读完整凭证 -> 401', noAuth.status === 401, `status=${noAuth.status}`);

  // ---- 网关转发: 开关开启 -> 原样打到完整地址 ----
  console.log('\n[3] 网关转发(开关开启)');
  const gw1 = await fetch(`${BASE}${GW_PATH}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
    body: JSON.stringify({ model: 'e2e-full-model', messages: [{ role: 'user', content: 'hi' }] }),
  });
  const gw1Text = await gw1.text();
  check('网关返回 200', gw1.status === 200, `status=${gw1.status} ${gw1Text.slice(0, 200)}`);
  check('上游收到的 path 就是完整地址的 path, 没拼任何后缀',
    hits.length === 1 && hits[0].url === '/custom/endpoint/chat/completions',
    `hits=${JSON.stringify(hits)}`);

  // ---- 关掉开关 -> 恢复拼接 ----
  console.log('\n[4] 关闭开关 -> 恢复正常拼接');
  const offRes = await req('PUT', `/accounts/${id}`, { base_url_full: false });
  check('PUT base_url_full:false 返回 200', offRes.status === 200, offRes.text.slice(0, 200));
  const a1 = await getAcct();
  check('回显 base_url_full === false', a1.base_url_full === false, JSON.stringify({ base_url_full: a1.base_url_full }));

  const gw2 = await fetch(`${BASE}${GW_PATH}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
    body: JSON.stringify({ model: 'e2e-full-model', messages: [{ role: 'user', content: 'hi' }] }),
  });
  await gw2.text();
  check('上游收到的 path 带上了拼接的 /v1/chat/completions',
    hits.length === 2 && hits[1].url === '/custom/endpoint/chat/completions/v1/chat/completions',
    `hits=${JSON.stringify(hits)}`);

  // ---- PUT 合并语义: 一起提交 base_url_full + model_aliases, 互不清掉 ----
  console.log('\n[5] extra 合并语义(开关与别名互不干扰)');
  const bothRes = await req('PUT', `/accounts/${id}`, {
    base_url_full: true,
    model_aliases: { 'demo-model': 'upstream-demo' },
  });
  check('PUT(开关+别名) 返回 200', bothRes.status === 200, bothRes.text.slice(0, 200));
  const a2 = await getAcct();
  check('回显 base_url_full === true 且别名表还在',
    a2.base_url_full === true && a2.model_aliases && a2.model_aliases['demo-model'] === 'upstream-demo',
    JSON.stringify({ base_url_full: a2.base_url_full, model_aliases: a2.model_aliases }));

  // 再单独关开关, 别名也不能丢
  await req('PUT', `/accounts/${id}`, { base_url_full: false });
  const a3 = await getAcct();
  check('单独关开关后别名仍在',
    a3.base_url_full === false && a3.model_aliases && a3.model_aliases['demo-model'] === 'upstream-demo',
    JSON.stringify({ base_url_full: a3.base_url_full, model_aliases: a3.model_aliases }));

  // ---- 连通性测试: 完整 URL 模式明确报错 ----
  console.log('\n[6] 连通性测试(完整 URL 模式)');
  await req('PUT', `/accounts/${id}`, { base_url_full: true });
  const testRes = await req('POST', `/accounts/${id}/test`);
  check('测试接口明确说明"无法推导模型列表地址"',
    testRes.json?.ok === false && /完整 URL/.test(String(testRes.json?.message ?? '')),
    testRes.text.slice(0, 300));
  check('测试期间没往 mock 发过 GET(没有打坏请求)', hits.every((h) => h.method === 'POST'),
    `hits=${JSON.stringify(hits)}`);

  // ---- 清理 ----
  const delRes = await req('DELETE', `/accounts/${id}`);
  check('删除测试账号返回 200', delRes.status === 200, delRes.text.slice(0, 200));
  const goneRes = await req('GET', `/accounts/${id}/credential`);
  check('账号删除后凭证接口 -> 404', goneRes.status === 404, `status=${goneRes.status}`);

  mock.close();
  console.log(`\n=== 结果: ${pass} passed, ${fail} failed, ${skip} skipped ===\n`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error('E2E 崩溃:', e);
  mock.close();
  process.exit(1);
});
