#!/usr/bin/env node
/**
 * 使用日志: 日期筛选 + 管理员调整额度留痕 —— 2026-11-25 老板需求。
 *
 * 覆盖:
 *   [1] PUT /users/:id 把余额调高 -> balance_logs 落一条, /logs 里能看到
 *       credit_kind='admin'、credit=增量、balance_after=新余额、operator=管理员
 *   [2] 使用日志的日期筛选按**北京时间**切天(start/end 都是 YYYY-MM-DD)
 *   [3] 额度流水也受日期筛选约束
 *
 * 前置: 本地 dev server + 本地 D1 已跑 `npm run db:migrate-balance:local`
 * 用法: ADMIN_PASS=localtest123 node tools/run-e2e.mjs 8791 test/logs-date-balance-e2e.mjs
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFileSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const execFileP = promisify(execFile);
const BASE = process.env.BASE_URL || 'http://127.0.0.1:8791';
const pass = process.env.ADMIN_PASS || 'localtest123';

let fail = 0;
const check = (name, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  [' + extra + ']' : ''}`);
  if (!cond) fail++;
};

// ---------- D1 本地执行 ----------
const d1Dir = mkdtempSync(join(tmpdir(), 'd1log-'));
async function d1(sql) {
  const file = join(d1Dir, 'q.sql');
  writeFileSync(file, sql, 'utf8');
  try {
    const { stdout } = await execFileP(
      'npx.cmd',
      ['wrangler', 'd1', 'execute', 'sub2api', '--local', '--file=' + file, '--json'],
      {
        cwd: process.cwd(),
        maxBuffer: 64 * 1024 * 1024,
        shell: true,
        env: { ...process.env, NO_PROXY: '127.0.0.1,localhost', HTTP_PROXY: '', HTTPS_PROXY: '' },
      },
    );
    const text = String(stdout).replace(/\u001b\[[0-9;]*m/g, '');
    const start = text.indexOf('[');
    const end = text.lastIndexOf(']');
    if (start === -1 || end <= start) return [];
    for (const block of JSON.parse(text.slice(start, end + 1))) {
      if (block?.results?.length) return block.results;
    }
    return [];
  } catch (e) {
    console.error('[d1-error]', String(e.message).slice(0, 200));
    return [];
  }
}

/** 北京时间当天 YYYY-MM-DD(以及偏移 N 天) */
function bjDay(offset = 0) {
  const t = new Date(Date.now() + 8 * 3600 * 1000 + offset * 86400 * 1000);
  return t.toISOString().slice(0, 10);
}
/** 把某天的北京时间 12:00 换成 UTC ISO(存库用) */
function bjNoonIso(offset = 0) {
  const t = new Date(Date.now() + 8 * 3600 * 1000 + offset * 86400 * 1000);
  t.setUTCHours(4, 0, 0, 0); // 北京 12:00 == UTC 04:00
  return t.toISOString();
}

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

const meRes = await fetch(`${BASE}/api/admin/me`, { headers: H });
const meId = Number((await meRes.json())?.id ?? 0);
check('拿到当前管理员 id', meId > 0, 'id=' + meId);

const logs = async (qs) => {
  const r = await fetch(`${BASE}/api/admin/logs?limit=200&offset=0` + qs, { headers: H });
  const j = await r.json().catch(() => ({}));
  return { status: r.status, total: Number(j.total ?? 0), rows: j.logs || [] };
};

// ---------- [1] 管理员调高额度 -> 使用日志留痕 ----------
const email = `logbal-${Date.now()}@test.com`;
const mk = await fetch(`${BASE}/api/admin/users`, {
  method: 'POST', headers: H,
  body: JSON.stringify({ email, password: 'Test12345', balance: 0 }),
});
const uid = (await mk.json()).id;
check('创建用户', mk.status === 201 && uid > 0, 'uid=' + uid);

const put1 = await fetch(`${BASE}/api/admin/users/${uid}`, {
  method: 'PUT', headers: H, body: JSON.stringify({ balance: 12.5 }),
});
check('调高额度 12.5 -> 200', put1.status === 200, 'status=' + put1.status);

// 再调一次, 验证"每次变动都留一条"
const put2 = await fetch(`${BASE}/api/admin/users/${uid}`, {
  method: 'PUT', headers: H, body: JSON.stringify({ balance: 30 }),
});
check('再调到 30 -> 200', put2.status === 200, 'status=' + put2.status);

// 不改余额的普通更新不该产生记录
const put3 = await fetch(`${BASE}/api/admin/users/${uid}`, {
  method: 'PUT', headers: H, body: JSON.stringify({ notes: 'no balance change' }),
});
check('只改备注 -> 200', put3.status === 200, 'status=' + put3.status);

const rows = (await d1(
  `SELECT delta, balance_after, source, operator FROM balance_logs WHERE user_id=${uid} ORDER BY id;`,
));
check('balance_logs 落了 2 条(只改备注不记)', rows.length === 2, JSON.stringify(rows));
check('第一条 delta=12.5 / after=12.5',
  rows[0] && Number(rows[0].delta) === 1250000000 && Number(rows[0].balance_after) === 1250000000,
  JSON.stringify(rows[0]));
check('第二条 delta=17.5 / after=30',
  rows[1] && Number(rows[1].delta) === 1750000000 && Number(rows[1].balance_after) === 3000000000,
  JSON.stringify(rows[1]));
check('operator 记了管理员名', !!(rows[0] && rows[0].operator), JSON.stringify(rows[0] && rows[0].operator));

// ---------- [2] /logs 里能看到额度变动行 ----------
// /logs 只看会话用户自己的记录 -> 把这两条流水的 user_id 临时改成管理员自己,
// 才能从同一接口验证展示形状(否则得登录这个新用户, 而他没有密码以外的会话)。
await d1(`UPDATE balance_logs SET user_id=${meId} WHERE user_id=${uid};`);
const day0 = bjDay(0);
const all = await logs(`&start=${day0}&end=${day0}`);
const credits = all.rows.filter((r) => r.credit_kind === 'admin');
check('日志接口返回额度变动行', credits.length === 2, 'credits=' + credits.length);
check('额度行 credit 是**增量**(12.5 / 17.5), 不是余额',
  credits.some((r) => Math.abs(Number(r.credit) - 12.5) < 1e-9) &&
  credits.some((r) => Math.abs(Number(r.credit) - 17.5) < 1e-9),
  JSON.stringify(credits.map((r) => r.credit)));
check('额度行带 balance_after(供详情写"增加到 X 额度")',
  credits.every((r) => r.balance_after != null), JSON.stringify(credits.map((r) => r.balance_after)));
check('额度行 request_id 形如 credit:*',
  credits.every((r) => String(r.request_id).indexOf('credit:') === 0), JSON.stringify(credits.map((r) => r.request_id)));
check('额度行不是签到行', credits.every((r) => r.checkin === false));

// ---------- [3] 日期筛选(北京时间) ----------
// 造两条调用日志: 今天 / 3 天前, 模型名唯一, 便于隔离
const MK = 'e2edate-' + Date.now().toString(36);
await d1(`INSERT INTO usage_logs (request_id, user_id, api_key_id, model, requested_model, input_tokens, output_tokens, total_cost, actual_cost, created_at)
          VALUES ('e2e-today-${MK}', ${meId}, 1, '${MK}', '${MK}', 10, 5, 100, 100, '${bjNoonIso(0)}');`);
await d1(`INSERT INTO usage_logs (request_id, user_id, api_key_id, model, requested_model, input_tokens, output_tokens, total_cost, actual_cost, created_at)
          VALUES ('e2e-old-${MK}', ${meId}, 1, '${MK}', '${MK}', 10, 5, 100, 100, '${bjNoonIso(-3)}');`);

const todayOnly = await logs(`&model=${encodeURIComponent(MK)}&start=${day0}&end=${day0}`);
check('今天筛选: 只出今天那条', todayOnly.total === 1, 'total=' + todayOnly.total);

const oldOnly = await logs(`&model=${encodeURIComponent(MK)}&start=${bjDay(-3)}&end=${bjDay(-3)}`);
check('3 天前筛选: 只出那天那条', oldOnly.total === 1, 'total=' + oldOnly.total);

const sinceToday = await logs(`&model=${encodeURIComponent(MK)}&start=${day0}`);
check('只给 start(今天起): 今天那条在, 3 天前的不在', sinceToday.total === 1, 'total=' + sinceToday.total);

const untilOld = await logs(`&model=${encodeURIComponent(MK)}&end=${bjDay(-3)}`);
check('只给 end(到 3 天前): 只剩 3 天前那条', untilOld.total === 1, 'total=' + untilOld.total);

const range = await logs(`&model=${encodeURIComponent(MK)}&start=${bjDay(-3)}&end=${day0}`);
check('区间筛选: 两条都在', range.total === 2, 'total=' + range.total);

const tomorrow = await logs(`&start=${bjDay(1)}`);
check('从明天开始: 一条都没有(额度行也被日期挡住)', tomorrow.total === 0, 'total=' + tomorrow.total);

const future = await logs(`&start=2030-01-01`);
check('未来日期: 0 条', future.total === 0, 'total=' + future.total);

// 边界: 今天 23:30 北京时间 == UTC 15:30, 必须算在今天而不是明天
const lateIso = (() => {
  const t = new Date(Date.now() + 8 * 3600 * 1000);
  t.setUTCHours(15, 30, 0, 0); // 北京 23:30
  return t.toISOString();
})();
const MK2 = MK + '-late';
await d1(`INSERT INTO usage_logs (request_id, user_id, api_key_id, model, requested_model, total_cost, actual_cost, created_at)
          VALUES ('e2e-late-${MK2}', ${meId}, 1, '${MK2}', '${MK2}', 1, 1, '${lateIso}');`);
const lateToday = await logs(`&model=${encodeURIComponent(MK2)}&start=${day0}&end=${day0}`);
check('北京时间 23:30 算今天(不是明天)', lateToday.total === 1, 'total=' + lateToday.total);

// ---------- 清理 ----------
await d1(`DELETE FROM usage_logs WHERE request_id LIKE 'e2e-%${MK}%';`);
await d1(`DELETE FROM balance_logs WHERE user_id IN (${uid}, ${meId});`);
await fetch(`${BASE}/api/admin/users/${uid}`, { method: 'DELETE', headers: H });

rmSync(d1Dir, { recursive: true, force: true });
console.log(fail ? `\n结果: ${fail} 项失败` : '\n结果: 全部通过');
process.exit(fail ? 1 : 0);
