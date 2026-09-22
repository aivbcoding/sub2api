#!/usr/bin/env node
/**
 * 线上复核「每日签到金额」单位是否修好 —— **会写一次生产数据**, 用完自删。
 *
 * 做法:
 *   1. 管理员建一个一次性用户 (e2e-checkin-<ts>@local)
 *   2. 该用户登录 -> POST /profile/checkin
 *   3. 断言响应 amount 落在 [100,200](美元整数) 且不是 0
 *   4. 查 user_checkins 里那一行的原始 amount, 应约等于 amount*1e8(微美元)
 *   5. 删掉这个一次性用户 (软删除) + 它的签到行
 *
 * 用法: ADMIN_PASS=xxx node tools/verify-checkin-online.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const BASE = process.env.BASE_URL ?? 'https://sub2api.aixm.ccwu.cc';
const PASS = process.env.ADMIN_PASS;
if (!PASS) {
  console.error('需要 ADMIN_PASS。用法: ADMIN_PASS=xxx node tools/verify-checkin-online.mjs');
  process.exit(2);
}
for (const k of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'ALL_PROXY', 'all_proxy']) {
  delete process.env[k];
}

let pass = 0, fail = 0;
const check = (n, c, d = '') => {
  if (c) { pass++; console.log(`  PASS  ${n}`); }
  else { fail++; console.log(`  FAIL  ${n}${d ? ' -> ' + d : ''}`); }
};

const cookieOf = (h) => {
  const sc = h.getSetCookie?.() ?? [];
  return sc.map((c) => c.split(';')[0]).join('; ');
};

const stamp = Date.now();
const email = `e2e-checkin-${stamp}@local`;
const userPass = 'e2eCheckin123';

console.log(`\n=== 线上签到金额单位复核 @ ${BASE} ===\n`);

let adminCookie = '';
{
  const r = await fetch(`${BASE}/api/admin/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: PASS }),
  });
  adminCookie = cookieOf(r.headers);
  check('管理员登录 200', r.status === 200, `got ${r.status}`);
}

let userId = 0;
{
  const r = await fetch(`${BASE}/api/admin/users`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: adminCookie },
    body: JSON.stringify({ username: email, email, password: userPass }),
  });
  const j = await r.json().catch(() => null);
  userId = Number(j?.id ?? 0);
  check('创建一次性用户 201', r.status === 201 && userId > 0, `got ${r.status} ${JSON.stringify(j).slice(0, 140)}`);
}

let bizCookie = '';
if (userId > 0) {
  const r = await fetch(`${BASE}/api/admin/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: email, password: userPass }),
  });
  bizCookie = cookieOf(r.headers);
  check('该用户登录 200', r.status === 200, `got ${r.status}`);
}

let amount = null;
if (bizCookie) {
  const r = await fetch(`${BASE}/api/admin/profile/checkin`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: bizCookie },
    body: '{}',
  });
  const j = await r.json().catch(() => null);
  amount = j?.amount ?? null;
  check('签到 200', r.status === 200, `got ${r.status} ${JSON.stringify(j).slice(0, 140)}`);
  const n = Number(amount);
  check(`签到金额是 100~200 美元整数(实得 ${amount})`,
    Number.isFinite(n) && n >= 100 && n <= 200 && Math.abs(n - Math.round(n)) < 1e-6,
    `amount=${amount}`);
  check('签到金额不是 0(修好前是 $0.0000)', n > 0, `amount=${amount}`);
  check('响应里余额也按美元返回(不是微美元)',
    Number(j?.balance ?? 0) > 0 && Number(j?.balance ?? 0) < 1e7, `balance=${j?.balance}`);
}

// ---- DB 侧确认存储单位是微美元 ----
if (userId > 0) {
  const sql = `SELECT user_id, day, amount FROM user_checkins WHERE user_id = ${userId} ORDER BY created_at DESC LIMIT 1`;
  const r = spawnSync(process.execPath, [join(root, 'tools', 'd1-query.mjs'), sql], {
    cwd: root,
    encoding: 'utf8',
  });
  const raw = (r.stdout ?? '').trim();
  console.log('  (DB) ' + raw.split('\n').pop());
  const m = raw.match(/"amount":\s*(\d+)/);
  const stored = m ? Number(m[1]) : NaN;
  if (Number.isFinite(stored) && Number.isFinite(Number(amount))) {
    check(`落库存的是微美元(${stored} ≈ ${amount} * 1e8)`,
      Math.abs(stored - Number(amount) * 1e8) < 1e7, `stored=${stored}`);
  } else {
    check('能读到 user_checkins 的 amount', false, raw.slice(0, 140));
  }
}

// ---- 清理 ----
if (userId > 0) {
  const r = await fetch(`${BASE}/api/admin/users/${userId}`, {
    method: 'DELETE',
    headers: { cookie: adminCookie },
  });
  check('清理: 删除一次性用户 200/204', r.status === 200 || r.status === 204, `got ${r.status}`);
  const del = spawnSync(process.execPath, [
    join(root, 'tools', 'd1-query.mjs'),
    `DELETE FROM user_checkins WHERE user_id = ${userId}`,
  ], { cwd: root, encoding: 'utf8' });
  console.log('  (cleanup checkins) ' + ((del.stdout ?? '').trim().split('\n').pop() ?? ''));
}

console.log(`\n=== 结果: ${pass} passed, ${fail} failed ===\n`);
process.exit(fail ? 1 : 0);
