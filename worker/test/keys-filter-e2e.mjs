#!/usr/bin/env node
/**
 * API Key 管理: 按用户筛选 / 按分组筛选 —— 2026-11-25 老板需求。
 *
 * 覆盖:
 *   [1] GET /api-keys?user_id=  只返回该用户的 Key
 *   [2] GET /api-keys?group_id= 只返回该分组的 Key(未分组的 Key 不混进来)
 *   [3] 两个条件可叠加(user_id + group_id)
 *   [4] 非法/空参数不当作筛选(返回全量) —— 防止 "0" / "abc" 把列表误清空
 *   [5] 筛选后仍返回**全量 users**(前端「所属用户」下拉不能自己缩水)
 *   [6] 用户页「Key」按钮的既有用法 ?user_id=N 仍然可用(兼容)
 *
 * 用法: ADMIN_PASS=localtest123 node tools/run-e2e.mjs 8792 test/keys-filter-e2e.mjs
 */
const BASE = process.env.BASE_URL || 'http://127.0.0.1:8792';
const pass = process.env.ADMIN_PASS || 'localtest123';

let fail = 0;
const check = (name, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  [' + extra + ']' : ''}`);
  if (!cond) fail++;
};

// ---------- 登录 ----------
const loginRes = await fetch(`${BASE}/api/admin/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ username: 'admin', password: pass }),
});
const cookie = (loginRes.headers.get('set-cookie') || '').split(';')[0];
check('管理员登录', loginRes.status === 200, 'status=' + loginRes.status);
if (!cookie) process.exit(1);
const H = { 'content-type': 'application/json', cookie };

const api = async (method, path, body) => {
  const r = await fetch(BASE + path, {
    method,
    headers: H,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let j = null;
  try { j = await r.json(); } catch { /* 无 body */ }
  return { status: r.status, j: j || {} };
};

const suffix = Date.now().toString(36);
const tag = 'kf' + suffix;

// ---------- 造数据: 2 分组 x 2 用户, 4 把 Key(含 1 把不分组) ----------
const gA = (await api('POST', '/api/admin/groups', { name: tag + '-grpA' })).j.id;
const gB = (await api('POST', '/api/admin/groups', { name: tag + '-grpB' })).j.id;
check('创建分组 A/B', gA > 0 && gB > 0, `gA=${gA} gB=${gB}`);

const mkUser = async (n) => {
  const r = await api('POST', '/api/admin/users', {
    email: `${tag}-${n}@test.com`, password: 'Test12345', balance: 0,
  });
  return r.j.id;
};
const u1 = await mkUser('u1');
const u2 = await mkUser('u2');
check('创建用户 u1/u2', u1 > 0 && u2 > 0, `u1=${u1} u2=${u2}`);

const mkKey = async (n, userId, groupId) => {
  const r = await api('POST', '/api/admin/api-keys', {
    user_id: userId, group_id: groupId, name: `${tag}-${n}`,
  });
  return r.j.id;
};
// k1: u1+gA   k2: u1+gB   k3: u2+gA   k4: u2+无分组
const k1 = await mkKey('k1', u1, gA);
const k2 = await mkKey('k2', u1, gB);
const k3 = await mkKey('k3', u2, gA);
const k4 = await mkKey('k4', u2, null);
check('创建 4 把 Key', [k1, k2, k3, k4].every((x) => x > 0), `${k1},${k2},${k3},${k4}`);

// ---------- 查询辅助: 只看本次造的 Key(库里可能有历史数据) ----------
const list = async (qs = '') => {
  const r = await api('GET', '/api/admin/api-keys' + qs);
  const keys = (r.j.api_keys || []).filter((k) => String(k.name || '').startsWith(tag + '-'));
  return { status: r.status, keys, users: r.j.users || [] };
};
const names = (keys) => keys.map((k) => String(k.name).replace(tag + '-', '')).sort().join(',');

// ---------- [1] 不带筛选 ----------
const all = await list('');
check('无筛选 -> 200 且返回 4 把', all.status === 200 && all.keys.length === 4, names(all.keys));

// ---------- [2] 按用户 ----------
const byU1 = await list(`?user_id=${u1}`);
check('按用户 u1 -> 只有 k1,k2', names(byU1.keys) === 'k1,k2', names(byU1.keys));
check('按用户 u1 -> 全部属于 u1', byU1.keys.every((k) => Number(k.user_id) === u1));

const byU2 = await list(`?user_id=${u2}`);
check('按用户 u2 -> 只有 k3,k4', names(byU2.keys) === 'k3,k4', names(byU2.keys));

// ---------- [3] 按分组 ----------
const byGA = await list(`?group_id=${gA}`);
check('按分组 A -> 只有 k1,k3', names(byGA.keys) === 'k1,k3', names(byGA.keys));
check('按分组 A -> 全部 group_id=A', byGA.keys.every((k) => Number(k.group_id) === gA));

const byGB = await list(`?group_id=${gB}`);
check('按分组 B -> 只有 k2', names(byGB.keys) === 'k2', names(byGB.keys));
check('按分组 B -> 未分组的 k4 不混进来', !byGB.keys.some((k) => k.name === tag + '-k4'));

// ---------- [4] 两个条件叠加 ----------
const andQ = await list(`?user_id=${u2}&group_id=${gA}`);
check('u2 + 分组 A -> 只有 k3', names(andQ.keys) === 'k3', names(andQ.keys));

const andEmpty = await list(`?user_id=${u1}&group_id=${gB}`);
check('u1 + 分组 B -> 只有 k2', names(andEmpty.keys) === 'k2', names(andEmpty.keys));

// ---------- [5] 非法 / 空参数不当作筛选 ----------
const uid0 = await list('?user_id=0');
check('user_id=0 视为"全部"(不筛)', uid0.keys.length === 4, names(uid0.keys));
const uidNaN = await list('?user_id=abc');
check('user_id=abc 视为"全部"', uidNaN.keys.length === 4, names(uidNaN.keys));
const gidEmpty = await list('?group_id=');
check('group_id 空串视为"全部"', gidEmpty.keys.length === 4, names(gidEmpty.keys));
const gidMiss = await list('?group_id=99999999');
check('不存在的分组 -> 0 条(不是 500)', gidMiss.status === 200 && gidMiss.keys.length === 0,
  'status=' + gidMiss.status);

// ---------- [6] 筛选后 users 仍是全量 ----------
const usersAfter = byGB.users;
check('筛选后仍下发 users(供下拉)', usersAfter.length >= 2, 'users=' + usersAfter.length);
check('users 里能查到 u1/u2(下拉不会缩水)',
  usersAfter.some((u) => Number(u.id) === u1) && usersAfter.some((u) => Number(u.id) === u2));

// ---------- 清理 ----------
for (const id of [k1, k2, k3, k4]) await api('DELETE', '/api/admin/api-keys/' + id);
await api('DELETE', '/api/admin/groups/' + gA);
await api('DELETE', '/api/admin/groups/' + gB);
await api('DELETE', '/api/admin/users', { ids: [u1, u2] });
const after = await list('');
check('清理后看不到本次的 Key', after.keys.length === 0, names(after.keys));

console.log(fail === 0 ? '=== 结果: 全部通过 ===' : `=== 结果: ${fail} 项失败 ===`);
process.exit(fail === 0 ? 0 : 1);
