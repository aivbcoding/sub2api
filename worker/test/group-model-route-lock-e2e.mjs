#!/usr/bin/env node
/**
 * 分组「模型关联」→ 路由钉死平台 的本地断言。
 *
 * 背景: 后台模型关联按 `平台::模型` 保存(如 arityflow::glm-5.2), 它既影响
 * /v1/models 列表, **也参与请求路由**(2026-09-24) —— 客户端发这个模型,
 * 必须走声明它的那个平台的 API, 而不是让自动发现把同名模型送去先声明到的平台。
 *
 * 场景:
 *   - 账号 A: platform=arityflow, base → 内嵌 mock(可达), 声明(别名) e2e-glm-case
 *   - 账号 B: platform=sensenova, base → 埋掉端口(不可达), 声明(别名) e2e-glm-case
 *   - 分组关联 ["arityflow::e2e-glm-case"] → 发请求必须 200(走了 A 的可答上游)
 *   - 分组关联 ["sensenova::e2e-glm-case"] → 发请求必须失败(走 B 的不可达上游,
 *     绝不悄悄落回 A —— 这才证明「关联谁就走谁」)
 *   - 大小写: 关联里存 e2e-Glm-Case(大写变体)时, 发 e2e-glm-case 也要被钉到该平台
 *
 * mock 内嵌在测试进程里(与 wrangler dev 同机, 127.0.0.1 可达), 不依赖外部起服务。
 *
 * 用法: ADMIN_PASS=localtest123 node tools/run-e2e.mjs 8787 test/group-model-route-lock-e2e.mjs
 */
const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:8787';
const PASS = process.env.ADMIN_PASS ?? 'localtest123';
const MOCK_PORT = 9123;

let pass = 0, fail = 0;
const check = (n, c, d = '') => {
  if (c) { pass++; console.log(`  PASS  ${n}`); }
  else { fail++; console.log(`  FAIL  ${n}${d ? ' -> ' + d : ''}`); }
};

let cookie = '';
async function api(path, init = {}) {
  const r = await fetch(BASE + path, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(cookie ? { cookie } : {}),
      ...(init.headers ?? {}),
    },
  });
  const sc = r.headers.getSetCookie?.() ?? [];
  if (sc.length) cookie = sc.map((c) => c.split(';')[0]).join('; ');
  const text = await r.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { status: r.status, body, headers: r.headers };
}

console.log(`\n=== 分组模型关联 → 路由钉平台 E2E @ ${BASE} ===\n`);

// ============================================================
// ① 内嵌 mock 上游: 记住收到的请求(路径 + 模型名), 原样回一个合法 chat 响应
// ============================================================
const seen = [];
const mock = (await import('node:http')).createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    let body = {};
    try { body = raw ? JSON.parse(raw) : {}; } catch {}
    seen.push({ method: req.method, path: req.url, model: body.model ?? '' });
    // 只要进了这个 mock 就说明请求被送到了「可达账号」的那条上游
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      id: 'chatcmpl-e2e', object: 'chat.completion', created: 1700000000,
      model: body.model ?? 'x', choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 6, completion_tokens: 2, total_tokens: 8 },
    }));
  });
});
await new Promise((r) => mock.listen(MOCK_PORT, '127.0.0.1', r));
console.log(`(内嵌 mock 上行 @ 127.0.0.1:${MOCK_PORT})`);

// ============================================================
// ② 管理员登录 + 造账号 + 绑定到 id=1 分组
// ============================================================
{
  const r = await api('/api/admin/login', {
    method: 'POST',
    body: JSON.stringify({ username: 'admin', password: PASS }),
  });
  check('管理员登录 200', r.status === 200, `got ${r.status}`);
}

const mkAccount = async (label, platform, baseUrl) => {
  const r = await api('/api/admin/accounts', {
    method: 'POST',
    body: JSON.stringify({ name: label, platform, base_url: baseUrl, api_key: 'sk-e2e-x', status: 'active' }),
  });
  const id = Number(r.body?.id ?? 0);
  if (id > 0) {
    await api(`/api/admin/accounts/${id}`, {
      method: 'PUT',
      body: JSON.stringify({ model_aliases: { 'e2e-glm-case': 'e2e-glm-case' } }),
    });
  }
  return id;
};

// A: arityflow → mock(可达, 请求进来就会 200)
const accA = await mkAccount('e2e-arityflow', 'arityflow', `http://127.0.0.1:${MOCK_PORT}`);
check('建 arityflow 账号 A(可达)', accA > 0, `id=${accA}`);
// B: sensenova → 不可达端口(连不上; 若请求被送去 B, 必然 502)
const accB = await mkAccount('e2e-sensenova', 'sensenova', 'http://127.0.0.1:9457');
check('建 sensenova 账号 B(9457 不可达)', accB > 0, `id=${accB}`);

// 把新账号绑到 id=1 分组（default 分组）
// 注意：users 表没有 group_id 列，/my/keys 自助建 key 时 resolveSelfGroupId 回退到 id 最小的分组
// 所以必须用 id=1 分组，否则 key 会挂到别的分组（绑的是旧账号）
const groupId = 1;
{
  const b = await api(`/api/admin/groups/${groupId}/accounts`, {
    method: 'PUT',
    body: JSON.stringify({ account_ids: [accA, accB].filter(Boolean) }),
  });
  check('两账号都绑进 id=1 分组', b.status === 200, `got ${b.status}`);
}

let apiKey = '';
{
  const email = `e2e-route-${Date.now()}@example.com`;
  const u = await api('/api/admin/users', {
    method: 'POST',
    body: JSON.stringify({ username: email, email, password: 'e2eRoutePass123' }),
  });
  const uid = Number(u.body?.id ?? 0);
  check('建业务用户', u.status === 201 && uid > 0, `got ${u.status}`);
  if (uid > 0) await api(`/api/admin/users/${uid}`, { method: 'PUT', body: JSON.stringify({ balance: 100 }) });

  const login = await fetch(BASE + '/api/admin/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: email, password: 'e2eRoutePass123' }),
  });
  const sc = login.headers.getSetCookie?.() ?? [];
  const bizCookie = sc.map((c) => c.split(';')[0]).join('; ');
  const mk = await fetch(BASE + '/api/admin/my/keys', {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: bizCookie },
    body: JSON.stringify({ name: 'e2e-route-key' }),
  });
  apiKey = String((await mk.json().catch(() => null))?.key ?? '');
  check('自助建 Key(挂 id=1 分组)', apiKey.startsWith('sk-'), apiKey.slice(0, 8));
}

const chat = (model) =>
  fetch(BASE + '/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: 'hi' }], max_tokens: 8 }),
  });

const setAllow = (entries) =>
  api(`/api/admin/groups/${groupId}`, { method: 'PUT', body: JSON.stringify({ model_allowlist: entries }) });

// ============================================================
// ③ 场景 1: 关联 arityflow::e2e-glm-case → 请求成功(进 mock, 收到原始模型名)
// ============================================================
{
  const w = await setAllow(['arityflow::e2e-glm-case']);
  check('写入关联 [arityflow::e2e-glm-case]', w.status === 200, `got ${w.status}`);

  const before = seen.length;
  const r = await chat('e2e-glm-case');
  const t = await r.text();
  check('发 e2e-glm-case 请求 200(走了 arityflow 上游)', r.status === 200, `got ${r.status} ${t.slice(0, 140)}`);
  check('mock 收到该请求(路径 /v1/chat/completions)',
    seen.length > before && seen[seen.length - 1].path === '/v1/chat/completions',
    JSON.stringify(seen.slice(-2)));
  check('mock 收到的模型名原样区分大小写(e2e-glm-case)',
    seen.length > before && seen[seen.length - 1].model === 'e2e-glm-case',
    String(seen[seen.length - 1]?.model));
}

// ============================================================
// ④ 场景 2: 关联改成 sensenova::e2e-glm-case → 请求必须失败(绝不落回 arityflow)
// ============================================================
{
  const w = await setAllow(['sensenova::e2e-glm-case']);
  check('关联改为 [sensenova::e2e-glm-case]', w.status === 200, `got ${w.status}`);

  const before = seen.length;
  const r = await chat('e2e-glm-case');
  const t = await r.text();
  // 若钉平台没生效/钉错: 请求会回落 A(可达 mock) → 200 → 测试失败
  check('请求失败(送去了 sensenova 的不可达上游)', r.status >= 500 || r.status === 502,
    `got ${r.status} ${t.slice(0, 120)}`);
  check('mock 没收到任何请求(没落回 arityflow)', seen.length === before,
    `mock got +${seen.length - before}`);
}

// ============================================================
// ⑤ 场景 3: 大小写变体 —— 关联里存 e2e-Glm-Case(大写), 发小写也能钉到对应平台
// ============================================================
{
  const w = await setAllow(['arityflow::e2e-Glm-Case']);
  check('关联存大写变体 [arityflow::e2e-Glm-Case]', w.status === 200, `got ${w.status}`);

  const before = seen.length;
  const r = await chat('e2e-glm-case');   // 客户端发小写
  const t = await r.text();
  check('发小写 e2e-glm-case 仍被钉到 arityflow(大小写不敏感兜底)', r.status === 200,
    `got ${r.status} ${t.slice(0, 120)}`);
  check('mock 收到请求', seen.length > before, `+${seen.length - before}`);
}

// ============================================================
// ⑥ 场景 4: 同名模型跨平台都关联(歧义) → 不锁平台, 交给原有链路(此时仍是
//    自动发现先声明者 A=arityflow, 且 A 可达 → 200)。只断言不会 5xx。
// ============================================================
{
  const w = await setAllow(['arityflow::e2e-glm-case', 'sensenova::e2e-glm-case']);
  check('同名跨平台都关联(歧义态)', w.status === 200, `got ${w.status}`);
  const r = await chat('e2e-glm-case');
  const t = await r.text();
  check('歧义时请求仍可服务(自动发现兜底)', r.status === 200, `got ${r.status} ${t.slice(0, 120)}`);
}

// ============================================================
// ⑦ 清理 + 收尾
// ============================================================
mock.close();
console.log(`\n=== 结果: ${pass} passed, ${fail} failed ===\n`);
process.exit(fail ? 1 : 0);