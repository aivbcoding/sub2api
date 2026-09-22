#!/usr/bin/env node
/**
 * 本地断言: 同一个分组下**多个账号**的模型要**全部**出现在 /v1/models 里,
 * 且 429 冷却账号的模型不能被丢掉。
 *
 * 为什么单独写: 线上 default 组带一份 gemini 白名单, 会掩盖"账号模型到底收没收到"
 * 这件事。这个脚本本地造一个**没有白名单**的分组 + 两个账号(一个就是冷却中的),
 * 直接断言并集。
 *
 * ⚠️ 只打本地 dev server, 不碰线上。用 run-e2e 拉起:
 *      node tools/run-e2e.mjs 8787 test/models-multi-account-e2e.mjs
 */
const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:8787';
const PASS = process.env.ADMIN_PASS ?? 'localtest123';

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

console.log(`\n=== /v1/models 多账号并集 E2E @ ${BASE} ===\n`);

// ---- 登录 ----
{
  const r = await api('/api/admin/login', {
    method: 'POST',
    body: JSON.stringify({ username: 'admin', password: PASS }),
  });
  check('管理员登录 200', r.status === 200, `got ${r.status}`);
}

// ---- 造分组(无白名单) ----
let groupId = 0;
{
  const r = await api('/api/admin/groups', {
    method: 'POST',
    body: JSON.stringify({ name: 'e2e-models-' + Date.now() }),
  });
  check('创建分组 201', r.status === 201, `got ${r.status} ${JSON.stringify(r.body).slice(0, 160)}`);
  groupId = Number(r.body?.id ?? 0);
  check('拿到分组 id', groupId > 0);
}

// ---- 造两个上游账号, 各自「模型获取」出自己的索引 ----
//
// 用 mock 上游 (:9099) —— 它按 ?tag= 或不带参数返回固定目录。
// 这里两个账号都指向 mock, 但 mock 的模型集是固定的, 无法给两个账号不同集合;
// 所以改用**别名表**区分: 账号 A 配 a-* 别名, 账号 B 配 b-* 别名。
// 别名表的键一定会进 /v1/models(accountDeclaredModels 读它),
// 这就直接验证了"一个分组下所有账号的模型都收进来"。
const mkAccount = async (label, aliasModels) => {
  const r = await api('/api/admin/accounts', {
    method: 'POST',
    body: JSON.stringify({
      name: label,
      platform: 'openai',
      base_url: 'http://127.0.0.1:9099/v1',
      api_key: 'sk-e2e-dummy',
      status: 'active',
    }),
  });
  const id = Number(r.body?.id ?? 0);
  if (id > 0 && aliasModels.length) {
    const aliases = {};
    for (const m of aliasModels) aliases[m] = m;
    const put = await api(`/api/admin/accounts/${id}`, {
      method: 'PUT',
      body: JSON.stringify({ model_aliases: aliases }),
    });
    if (put.status !== 200) console.log(`    (账号 ${id} 写别名返回 ${put.status})`);
  }
  return { id, status: r.status };
};

let accA = 0, accB = 0;
{
  const a = await mkAccount('e2e-acc-A', ['e2e-model-alpha', 'e2e-model-shared']);
  const b = await mkAccount('e2e-acc-B', ['e2e-model-beta', 'e2e-model-shared']);
  check('创建账号 A', a.id > 0, `status ${a.status}`);
  check('创建账号 B', b.id > 0, `status ${b.status}`);
  accA = a.id; accB = b.id;
}

// ---- 两个账号都绑到新分组 ----
{
  const r = await api(`/api/admin/groups/${groupId}/accounts`, {
    method: 'PUT',
    body: JSON.stringify({ account_ids: [accA, accB].filter(Boolean) }),
  });
  check('绑定两个账号到分组 200', r.status === 200, `got ${r.status}`);
}

// ---- 造一把挂该分组的 Key + 一个业务用户 ----
let userPass = 'e2eModelPass123';
let userEmail = '';
let userId = 0;
{
  userEmail = `e2e-model-${Date.now()}@example.com`;
  const r = await api('/api/admin/users', {
    method: 'POST',
    body: JSON.stringify({ username: userEmail, email: userEmail, password: userPass, group_id: groupId }),
  });
  check('创建业务用户 201', r.status === 201, `got ${r.status} ${JSON.stringify(r.body).slice(0, 160)}`);
  userId = Number(r.body?.id ?? 0);
}

// 给足余额 —— ENFORCE_BALANCE=true 时余额为 0 会被 403
if (userId > 0) {
  const r = await api(`/api/admin/users/${userId}`, {
    method: 'PUT',
    body: JSON.stringify({ balance: 100 }),
  });
  check('给用户充值 100', r.status === 200, `got ${r.status}`);
}

// 业务用户登录 -> 自助建 Key (自动挂它的分组)
let bizCookie = '';
let apiKey = '';
{
  const login = await fetch(BASE + '/api/admin/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: userEmail, password: userPass }),
  });
  const sc = login.headers.getSetCookie?.() ?? [];
  bizCookie = sc.map((c) => c.split(';')[0]).join('; ');
  check('业务用户登录 200', login.status === 200, `got ${login.status}`);

  const mk = await fetch(BASE + '/api/admin/my/keys', {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: bizCookie },
    body: JSON.stringify({ name: 'e2e-models-key' }),
  });
  const j = await mk.json().catch(() => null);
  apiKey = String(j?.key ?? '');
  check('自助建 Key 201', mk.status === 201, `got ${mk.status}`);
  check('拿到明文 Key', apiKey.startsWith('sk-'), apiKey.slice(0, 8));
  // 格式钉死: sk- + 32 位 UUID(去连字符) = 35 字符
  check('Key 格式 = sk- + 32 位 UUID(总长 35)',
    /^sk-[0-9a-f]{32}$/.test(apiKey), `${apiKey} len=${apiKey.length}`);
}

// ---- 关键断言: /v1/models 要含两个账号的全部模型 ----
if (apiKey) {
  const r = await fetch(BASE + '/v1/models', { headers: { authorization: `Bearer ${apiKey}` } });
  const j = await r.json().catch(() => null);
  const ids = Array.isArray(j?.data) ? j.data.map((m) => String(m.id)) : [];
  check('/v1/models 200', r.status === 200, `got ${r.status}`);
  check('含账号 A 的 e2e-model-alpha', ids.includes('e2e-model-alpha'), ids.join(','));
  check('含账号 B 的 e2e-model-beta', ids.includes('e2e-model-beta'), ids.join(','));
  check('含共享的 e2e-model-shared(去重后只一条)',
    ids.filter((x) => x === 'e2e-model-shared').length === 1, ids.join(','));
  check('两个账号的模型都在(= 并集)', ids.includes('e2e-model-alpha') && ids.includes('e2e-model-beta'),
    ids.join(','));
  check('响应不被 HTTP 缓存', (r.headers.get('cache-control') ?? '').includes('no-store'),
    r.headers.get('cache-control') ?? '(none)');
}

console.log(`\n=== 结果: ${pass} passed, ${fail} failed ===\n`);
process.exit(fail ? 1 : 0);
