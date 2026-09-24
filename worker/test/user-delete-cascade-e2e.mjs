#!/usr/bin/env node
/**
 * 端到端验证: 删除用户 -> 级联清理 key / usage_logs / billing_dedup / checkins / 验证码
 *
 * 前置: 本地 dev server 在 8790 端口(wrangler dev --port 8790 --local)
 * 用法: node test/user-delete-cascade-e2e.mjs
 *
 * 说明: 直接往本地 D1 插关联数据(user_checkins/email_verify_codes 等管理 API
 *       没有写接口), 再调 DELETE /users/:id 触发级联, 最后从 D1 核对。
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFileSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const execFileP = promisify(execFile);

const BASE = 'http://127.0.0.1:8790';
const pass = process.env.ADMIN_PASS || 'localtest123';
let fail = 0;
const check = (name, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  [' + extra + ']' : ''}`);
  if (!cond) fail++;
};

// ---------- D1 本地执行(用 --file 避免命令行多行/引号拆分问题) ----------
const d1Dir = mkdtempSync(join(tmpdir(), 'd1test-'));
async function d1(sql) {
  const file = join(d1Dir, 'q.sql');
  writeFileSync(file, sql, 'utf8');
  try {
    const { stdout } = await execFileP(
      'npx.cmd',
      ['wrangler', 'd1', 'execute', 'sub2api', '--local', '--file=' + file, '--json'],
      { cwd: process.cwd(), maxBuffer: 64 * 1024 * 1024, shell: true, env: { ...process.env, NO_PROXY: '127.0.0.1,localhost', HTTP_PROXY: '', HTTPS_PROXY: '' } },
    );
    let text = String(stdout).replace(/\u001b\[[0-9;]*m/g, '');
    const start = text.indexOf('[');
    const end = text.lastIndexOf(']');
    if (start === -1 || end <= start) return [];
    const arr = JSON.parse(text.slice(start, end + 1));
    for (const block of arr) {
      if (block?.results?.length) return block.results;
    }
    return [];
  } catch (e) {
    console.error('[d1-error]', String(e.message).slice(0, 200));
    return [];
  }
}

// 1. 登录拿 cookie
const loginRes = await fetch(`${BASE}/api/admin/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ username: 'admin', password: pass }),
});
const cookie = (loginRes.headers.get('set-cookie') || '').split(';')[0];
check('管理员登录', loginRes.status === 200, 'cookie=' + (cookie || 'none').slice(0, 16));
if (!cookie) process.exit(1);
const H = { 'content-type': 'application/json', cookie };

// 2. 建测试用户
const email = `cascade-${Date.now()}@test.com`;
const mkUser = await fetch(`${BASE}/api/admin/users`, {
  method: 'POST', headers: H,
  body: JSON.stringify({ email, username: 'cascade', password: 'Test12345' }),
});
const uid = (await mkUser.json()).id;
check('创建用户', mkUser.status === 201 && uid, 'uid=' + uid);

// 3. 给用户建 2 个 key
const kid = [];
for (const name of ['k1', 'k2']) {
  const r = await fetch(`${BASE}/api/admin/api-keys`, {
    method: 'POST', headers: H,
    body: JSON.stringify({ user_id: uid, name }),
  });
  kid.push((await r.json()).id);
}
check('创建 2 个 Key', kid.length === 2 && kid.every(Boolean), 'k=' + kid.join(','));

// 4. 造关联数据
const fakeReq = 'req-' + Date.now();
await d1(`INSERT INTO usage_logs (request_id, user_id, api_key_id, model, input_tokens, output_tokens, total_cost, actual_cost, created_at) VALUES ('${fakeReq}', ${uid}, ${kid[0]}, 'gpt-4o', 10, 20, 100, 100, datetime('now'));`);
await d1(`INSERT INTO usage_logs (request_id, user_id, api_key_id, model, total_cost, actual_cost, created_at) VALUES ('${fakeReq}-2', ${uid}, ${kid[1]}, 'gpt-4o', 50, 50, datetime('now'));`);
await d1(`INSERT INTO usage_billing_dedup (request_id, api_key_id, request_fingerprint, created_at) VALUES ('${fakeReq}', ${kid[0]}, 'fp1', datetime('now'));`);
await d1(`INSERT INTO user_checkins (user_id, day, amount, created_at) VALUES (${uid}, '2026-09-23', 100, datetime('now'));`);
await d1(`INSERT INTO email_verify_codes (request_id, email, email_normalized, purpose, code_hash, status, expires_at) VALUES ('vc-${Date.now()}', '${email}', '${email.toLowerCase()}', 'REGISTER', 'abc', 'ACTIVE', datetime('now', '+1 day'));`);

// 5. 前置条件: 关联数据在
const cntBefore = (await d1(`SELECT
  (SELECT COUNT(*) FROM api_keys WHERE user_id=${uid}) AS keys,
  (SELECT COUNT(*) FROM usage_logs WHERE user_id=${uid}) AS logs,
  (SELECT COUNT(*) FROM usage_billing_dedup WHERE api_key_id IN (${kid.join(',')})) AS dedup,
  (SELECT COUNT(*) FROM user_checkins WHERE user_id=${uid}) AS checkins,
  (SELECT COUNT(*) FROM email_verify_codes WHERE email_normalized='${email.toLowerCase()}') AS vcodes;`))[0];
const c1 = cntBefore || {};
check('删除前有关联数据', Number(c1.keys) === 2 && Number(c1.logs) === 2 && Number(c1.dedup) === 1 && Number(c1.checkins) === 1 && Number(c1.vcodes) === 1,
  JSON.stringify(c1));

// 6. 删除用户
const delRes = await fetch(`${BASE}/api/admin/users/${uid}`, { method: 'DELETE', headers: H });
const delData = await delRes.json().catch(() => ({}));
check('删除用户', delRes.status === 200 && delData.ok, 'deleted_keys=' + delData.deleted_keys);

// 7. 验证级联
const cnt2 = (await d1(`SELECT
  (SELECT COUNT(*) FROM api_keys WHERE user_id=${uid}) AS keys,
  (SELECT COUNT(*) FROM usage_logs WHERE user_id=${uid}) AS logs,
  (SELECT COUNT(*) FROM usage_billing_dedup WHERE api_key_id IN (${kid.join(',')})) AS dedup,
  (SELECT COUNT(*) FROM user_checkins WHERE user_id=${uid}) AS checkins,
  (SELECT COUNT(*) FROM email_verify_codes WHERE email_normalized='${email.toLowerCase()}') AS vcodes,
  (SELECT COUNT(*) FROM users WHERE id=${uid}) AS users;`))[0];
const c2 = cnt2 || {};
check('用户本体已删', Number(c2.users) === 0, JSON.stringify(c2));
check('Key 已级联删', Number(c2.keys) === 0, 'keys=' + c2.keys);
check('使用日志已级联删', Number(c2.logs) === 0, 'logs=' + c2.logs);
check('计费幂等已级联删', Number(c2.dedup) === 0, 'dedup=' + c2.dedup);
check('签到已级联删', Number(c2.checkins) === 0, 'checkins=' + c2.checkins);
check('验证码已级联删', Number(c2.vcodes) === 0, 'vcodes=' + c2.vcodes);

rmSync(d1Dir, { recursive: true, force: true });
console.log(fail ? `\n结果: ${fail} 项失败` : '\n结果: 全部通过');
process.exit(fail ? 1 : 0);