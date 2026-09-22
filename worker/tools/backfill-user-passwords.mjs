#!/usr/bin/env node
/**
 * 给「没有密码」的存量 users 补上默认密码的哈希 —— 或者给指定账号**重置**密码。
 *
 * 为什么需要 CLI 版(而不是只靠后台那个按钮):
 *   - 后台按钮 `POST /api/admin/users/reset-missing-passwords` 需要管理员会话;
 *   - 部署刚上线、还没登录后台时想一次性把历史数据补齐, 用这个更直接;
 *   - 也能对**本地** D1 跑, 方便 e2e 之前把环境弄干净。
 *   - `--user` 模式是**救砖**用的: 统一登录到 users 表之后, 如果把自己的管理员密码
 *     忘了(或者临时库里的密码不是文档记的那个), 没有这条路径就只能在 D1 控制台里
 *     手搓一个 pbkdf2 哈希塞进去。
 *
 * 用法:
 *   node tools/backfill-user-passwords.mjs                 # 线上, 批量补空密码(默认 sub2api123)
 *   node tools/backfill-user-passwords.mjs "别的密码"       # 批量补, 指定密码
 *   node tools/backfill-user-passwords.mjs --user admin "新密码"     # 只重置这一个账号
 *   D1LOCAL=1 node tools/backfill-user-passwords.mjs --user admin "localtest123"
 *
 * 打印的哈希格式与 Worker 端 admin-auth.ts::hashPassword 一致
 * (PBKDF2-SHA256 / 100000 轮 / 32 字节 / pbkdf2$轮数$saltHex$hashHex)。
 */
import { spawnSync } from 'node:child_process';
import { pbkdf2Sync, randomBytes } from 'node:crypto';

const DEFAULT_PASSWORD = 'sub2api123';
const MIN_PASSWORD_LENGTH = 8;

const argv = process.argv.slice(2);
const userIdx = argv.indexOf('--user');
/** --user <账号> : 只重置这一个账号(用户名或邮箱), 不做批量补齐 */
const targetUser = userIdx >= 0 ? String(argv[userIdx + 1] ?? '').trim() : '';
const positional = argv.filter((a, i) => a !== '--user' && i !== userIdx + 1);
const password = positional[0] || DEFAULT_PASSWORD;

if (userIdx >= 0 && !targetUser) {
  console.error('[错误] --user 后面要跟用户名或邮箱。');
  process.exit(2);
}
if (password.length < MIN_PASSWORD_LENGTH) {
  console.error(`[错误] 密码至少 ${MIN_PASSWORD_LENGTH} 位, 当前 ${password.length} 位。`);
  process.exit(2);
}

const localFlag = process.env.D1LOCAL === '1' ? '--local' : '--remote';
const dbName = process.env.D1NAME || 'sub2api';

const ITERATIONS = 100_000;
const salt = randomBytes(16);
const hash = pbkdf2Sync(password, salt, ITERATIONS, 32, 'sha256').toString('hex');
const stored = `pbkdf2$${ITERATIONS}$${salt.toString('hex')}$${hash}`;

/**
 * 同一个默认密码复用同一个加盐哈希。
 * 逐行跑 PBKDF2 没必要(而且后台端点也是这么干的), 同密码同哈希不泄露额外信息。
 */
const esc = (s) => String(s).replace(/'/g, "''");
const sql = targetUser
  ? `UPDATE users SET password_hash = '${stored}', updated_at = datetime('now') ` +
    `WHERE deleted_at IS NULL AND (email = '${esc(targetUser)}' COLLATE NOCASE ` +
    `OR username = '${esc(targetUser)}' COLLATE NOCASE)`
  : `UPDATE users SET password_hash = '${stored}', updated_at = datetime('now') ` +
    `WHERE deleted_at IS NULL AND (password_hash IS NULL OR password_hash = '')`;

console.log(`\n=== ${targetUser ? '重置指定账号密码' : '补齐存量用户密码'} (${localFlag}) ===\n`);
console.log(`目标库: ${dbName}`);
console.log(`密码:   ${password}`);
if (targetUser) console.log(`账号:   ${targetUser}`);

const r = spawnSync(
  'npx.cmd',
  ['wrangler', 'd1', 'execute', dbName, localFlag, `"--command=${sql}"`, '-y'],
  { encoding: 'buffer', shell: true, maxBuffer: 64 * 1024 * 1024 },
);

const out = (r.stdout ?? Buffer.alloc(0)).toString('utf8').replace(/\u001b\[[0-9;]*m/g, '');
const err = (r.stderr ?? Buffer.alloc(0)).toString('utf8').replace(/\u001b\[[0-9;]*m/g, '');
// wrangler 的 "Proxy environment variables detected" 之类噪声不算错误
const realErr = err.split('\n').filter((l) => l.trim() && !/WARNING.*Proxy|Executing on|🌀|▲/i.test(l)).join('\n');

console.log(out.trim() || '(无输出)');
if (realErr.trim()) console.error('[stderr] ' + realErr.slice(0, 1200));

if (r.status !== 0) {
  console.error('\n✗ 执行失败。');
  process.exit(r.status ?? 1);
}

console.log('\n✓ 完成。复核:');
if (targetUser) {
  console.log(`  node tools/d1-query.mjs "SELECT id, username, email FROM users WHERE deleted_at IS NULL AND (email = '${esc(targetUser)}' OR username = '${esc(targetUser)}')"`);
  console.log(`  (应恰好 1 行; 若 0 行说明账号名写错了 —— 登录用的是用户名或邮箱)`);
} else {
  console.log('  node tools/d1-query.mjs "SELECT id, email FROM users WHERE deleted_at IS NULL AND (password_hash IS NULL OR password_hash = \'\')"');
  console.log('  (应看到 0 行)');
}
