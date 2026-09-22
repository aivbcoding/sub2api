#!/usr/bin/env node
/**
 * 生成管理后台所需的「密码哈希」和「JWT 密钥」
 *
 * 用法:
 *   node tools/gen-admin-secret.mjs                     # 只生成 JWT 密钥
 *   node tools/gen-admin-secret.mjs "你的密码"           # 生成密钥 + 密码哈希 + 建号 SQL
 *
 * 说明:
 *   密码哈希格式 pbkdf2$<轮数>$<saltHex>$<hashHex>，与 Worker 端 admin-auth.ts 完全一致
 *   (PBKDF2-SHA256, 100000 轮, 32 字节输出)
 */

import { randomBytes, pbkdf2Sync } from 'node:crypto';

const ITERATIONS = 100_000;
const KEY_LEN = 32;
const DIGEST = 'sha256';

const password = process.argv[2] ?? '';
const username = process.argv[3] ?? 'admin';

console.log('\n=== JWT 签名密钥 (ADMIN_JWT_SECRET) ===\n');
const secret = randomBytes(48).toString('base64url');
console.log(secret);

console.log('\n写入命令 (Git Bash / WSL):');
console.log(`  echo "${secret}" | npx wrangler secret put ADMIN_JWT_SECRET`);
console.log('\n写入命令 (PowerShell):');
console.log(`  '${secret}' | npx wrangler secret put ADMIN_JWT_SECRET`);

if (!password) {
  console.log('\n(未提供密码，跳过哈希生成)');
  console.log('如需生成管理员密码哈希，请执行: node tools/gen-admin-secret.mjs "你的密码"\n');
  process.exit(0);
}

if (password.length < 8) {
  console.error(`\n[错误] 密码至少 8 位，当前 ${password.length} 位。\n`);
  process.exit(1);
}

const salt = randomBytes(16);
const hash = pbkdf2Sync(password, salt, ITERATIONS, KEY_LEN, DIGEST).toString('hex');
const stored = `pbkdf2$${ITERATIONS}$${salt.toString('hex')}$${hash}`;

console.log('\n\n=== 管理员密码哈希 ===\n');
console.log(stored);

// SQL 里 $ 无特殊含义，但 shell 里要转义，这里直接给转义好的命令
const escaped = stored.replace(/\$/g, '\\$');

/**
 * 注意: 控制台登录已经统一到 `users` 表(不再查 admin_accounts)。
 * 所以这里生成的是 **users 表的 UPSERT**, 而且用的是"先 UPDATE 再条件 INSERT"
 * 而不是 `ON CONFLICT(email)` —— email 上的唯一索引是**部分索引**
 * (WHERE deleted_at IS NULL), UPSERT 的冲突目标要跟它一字不差地匹配, 写错了会直接报错。
 * 两条语句顺序执行即可, 重复跑也是幂等。
 */
const email = `${username}@local`;
const sql = (h) =>
  `UPDATE users SET password_hash = '${h}', role = 'admin', status = 'active', deleted_at = NULL ` +
  `WHERE email = '${email}'; ` +
  `INSERT INTO users (email, username, role, status, password_hash) ` +
  `SELECT '${email}', '${username}', 'admin', 'active', '${h}' ` +
  `WHERE NOT EXISTS (SELECT 1 FROM users WHERE email = '${email}' AND deleted_at IS NULL);`;

console.log('\n\n=== 创建/重置管理员账号 (Git Bash) ===\n');
console.log(`npx wrangler d1 execute sub2api --remote -y --command "${sql(escaped)}"`);

console.log('\n\n=== 创建/重置管理员账号 (PowerShell, 无需转义 $) ===\n');
console.log(`npx wrangler d1 execute sub2api --remote -y --command "${sql(stored)}"`);

console.log('\n\n=== 本地 D1 (PowerShell 直接跑) ===\n');
console.log(`npx wrangler d1 execute sub2api --local -y --command "${sql(stored)}"`);

console.log(`\n\n用户名: ${username}`);
console.log(`密码:   ${password}`);
console.log(`邮箱:   ${email}`);
console.log(
  '\n提示: 控制台登录校验的是 users 表。用 build 期脚本建号前请先执行过\n' +
    '      schema/schema-roles.sql(roles 表), 否则该账号的菜单解析为空 —— \n' +
    '      role=admin 会走兜底拿到全部菜单, 自建角色则会"登录进去什么都看不到"。',
);
console.log('登录后建议立即在「设置」页修改密码。\n');
