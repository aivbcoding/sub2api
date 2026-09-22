#!/usr/bin/env node
/**
 * 把 `admin_accounts`(后台管理员) 并入 `users`(业务用户) —— 统一登录的最后一步。
 *
 * 为什么要做这件事:
 *   原先后台登录查 `admin_accounts`、业务用户只持有 API Key 没有登录入口, 是两套
 *   互不相干的体系。统一成「一个登录页 + 一张 users 表 + 角色决定菜单」之后,
 *   管理员必须也变成 users 里的一行, 否则他就没法用同一个登录入口进来。
 *
 * 匹配规则(按顺序, 第一个命中即采用):
 *   1. users.username = admin_accounts.username      (已经是同名账号)
 *   2. users.email    = admin_accounts.username      (账号名写成邮箱的情况)
 *   3. users.username = admin_accounts.display_name  (显示名对上了 —— 线上就是这条:
 *      admin_accounts 的 display_name「超级管理员」== users.username「超级管理员」)
 *   4. 库里**只有一个** role='admin' 的活用户 -> 直接认领(本地就是这条: users#1
 *      的 username 是空的, 但它是唯一的 admin)
 *   5. 都不中 -> 新建一行(邮箱用 `<username>@admin.local`)
 *
 * 写库策略(三个都必须记住的点):
 *   - **密码以 admin_accounts 为准**: 那才是操作员天天在用的那个密码。users 行里
 *     如果有别的密码(比如批量补的默认密码 sub2api123), 会被覆盖 —— 反之会把人锁在门外。
 *     想保留 users 侧原密码: 加 `--keep-existing-passwords`。
 *   - **密码哈希不走命令行**: 全程用 `password_hash = (SELECT password_hash FROM
 *     admin_accounts WHERE id = N)` 在库内搬运, 于是 `pbkdf2$100000$...` 里的 `$`
 *     不会被 shell 吃掉(在 Linux/macOS 上这就不是"可能出问题", 而是必然出问题)。
 *   - **幂等**: 可重复执行。第二次跑会发现 users 里已经有同名的 admin, 走规则 1, 结果不变。
 *
 * admin_accounts 表**保留不删** —— 回滚只需要把登录端点改回去。
 *
 * 用法:
 *   node tools/migrate-admin-accounts.mjs              # 线上, 只打印计划(默认 dry-run)
 *   node tools/migrate-admin-accounts.mjs --apply      # 线上, 真正执行
 *   D1LOCAL=1 node tools/migrate-admin-accounts.mjs --apply       # 本地 D1
 *   node tools/migrate-admin-accounts.mjs --apply --keep-existing-passwords
 */
import { spawnSync } from 'node:child_process';

const APPLY = process.argv.includes('--apply');
const KEEP_PWD = process.argv.includes('--keep-existing-passwords');
const localFlag = process.env.D1LOCAL === '1' ? '--local' : '--remote';
const dbName = process.env.D1NAME || 'sub2api';

/** 用户 ID 是自增主键, 只允许整数进 SQL 模板 */
const intOrNull = (v) => (Number.isInteger(Number(v)) && Number(v) > 0 ? Number(v) : null);
/** SQL 字符串字面量转义: 单引号翻倍 */
const quote = (s) => `'${String(s).replace(/'/g, "''")}'`;
const looksLikeEmail = (s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(s));

function runWrangler(sqlText) {
  // ⚠️ 必须先把换行压成空格: shell:true 下 `--command="..."` 里的裸换行会把参数截断,
  // wrangler 收到的就是半条 SQL, 报 "incomplete input: SQLITE_ERROR"(排查成本很高)。
  const sql = String(sqlText).replace(/[\r\n\t]+/g, ' ').trim();
  const r = spawnSync(
    'npx.cmd',
    ['wrangler', 'd1', 'execute', dbName, localFlag, `"--command=${sql.replace(/"/g, '\\"')}"`, '--json'],
    { encoding: 'buffer', shell: true, maxBuffer: 64 * 1024 * 1024 },
  );
  const out = (r.stdout ?? Buffer.alloc(0)).toString('utf8').replace(/\u001b\[[0-9;]*m/g, '');
  const err = (r.stderr ?? Buffer.alloc(0)).toString('utf8').replace(/\u001b\[[0-9;]*m/g, '');
  if (r.status !== 0) {
    throw new Error(`wrangler 退出码 ${r.status}\n${out.slice(0, 800)}\n${err.slice(0, 800)}`);
  }
  // 从噪声里抠出第一个能解析的顶层 JSON 数组
  for (let i = 0; i < out.length; i++) {
    if (out[i] !== '[') continue;
    for (let j = out.length - 1; j > i; j--) {
      if (out[j] !== ']') continue;
      try {
        const arr = JSON.parse(out.slice(i, j + 1));
        if (Array.isArray(arr)) return arr;
      } catch { /* 继续往左缩 */ }
    }
  }
  return [];
}

/** 查一堆行, 返回对象数组 */
function query(sql) {
  const blocks = runWrangler(sql);
  const rows = [];
  for (const b of blocks) if (b && b.results) rows.push(...b.results);
  return rows;
}

/** 执行写语句, 返回第一个结果块的 meta */
function exec(sql) {
  const blocks = runWrangler(sql);
  for (const b of blocks) if (b && b.meta) return b.meta;
  return null;
}

console.log(`\n=== 合并 admin_accounts -> users (${localFlag}${APPLY ? '' : ' / DRY-RUN'}) ===`);
console.log(`目标库: ${dbName}${KEEP_PWD ? '  [保留 users 侧已有密码]' : ''}\n`);

const admins = query(
  `SELECT id, username, display_name,
          CASE WHEN password_hash IS NULL OR password_hash = '' THEN 0 ELSE 1 END AS has_pwd
     FROM admin_accounts ORDER BY id`,
);
const users = query(
  `SELECT id, email, username, role,
          CASE WHEN password_hash IS NULL OR password_hash = '' THEN 0 ELSE 1 END AS has_pwd
     FROM users WHERE deleted_at IS NULL ORDER BY id`,
);

if (admins.length === 0) {
  console.log('admin_accounts 里没有账号 —— 无需迁移。');
  console.log('(全新部署直接用「用户管理」建一个 role=admin 的账号即可)\n');
  process.exit(0);
}

const lower = (s) => String(s ?? '').trim().toLowerCase();
const liveAdmins = users.filter((u) => String(u.role) === 'admin');

/** 按上面的规则挑目标用户 */
function pickTarget(a) {
  const byLower = (fn) => users.find((u) => fn(u) && lower(u.username) === lower(a.username));
  const t1 = byLower(() => true);
  if (t1) return { user: t1, why: '用户名相同' };
  const t2 = users.find((u) => lower(u.email) === lower(a.username));
  if (t2) return { user: t2, why: '邮箱等于该账号名' };
  if (lower(a.display_name)) {
    const t3 = users.find((u) => lower(u.username) === lower(a.display_name));
    if (t3) return { user: t3, why: `显示名「${a.display_name}」等于用户名` };
  }
  if (liveAdmins.length === 1) return { user: liveAdmins[0], why: '库里唯一的 admin 用户' };
  return { user: null, why: '没有候选, 将新建' };
}

const statements = [];
const plan = [];

for (const a of admins) {
  const { user: t, why } = pickTarget(a);
  const uname = String(a.username ?? '').trim();
  const pwdSql =
    Number(a.has_pwd) === 1 && !(KEEP_PWD && t && Number(t.has_pwd) === 1)
      ? `password_hash = (SELECT password_hash FROM admin_accounts WHERE id = ${a.id}), `
      : '';

  if (t) {
    // 改用户名之前先挡掉重名: username 没有唯一索引, 重名会让登录"取 id 最小的那条",
    // 于是被顶掉的那个人以为密码错了 —— 这种问题极难排查, 所以宁可不动。
    const collide = users.some(
      (u) => u.id !== t.id && lower(u.username) && lower(u.username) === lower(uname),
    );
    const sameName = lower(t.username) === lower(uname);
    const wantRename = uname && !sameName && !collide;

    const sets = [`role = 'admin'`, `updated_at = datetime('now')`];
    if (pwdSql) sets.push(pwdSql.replace(/, $/, ''));
    if (wantRename) sets.push(`username = ${quote(uname)}`);
    if (!sets.length) continue;

    statements.push(`UPDATE users SET ${sets.join(', ')} WHERE id = ${Number(t.id)};`);
    plan.push({
      admin: `#${a.id} ${uname || '(无名)'}`,
      action: `更新 users#${t.id}`,
      detail: [
        `匹配=${why}`,
        wantRename ? `用户名「${t.username || '(空)'}」->「${uname}」` : '用户名不变',
        collide ? `⚠ 用户名「${uname}」已被别的用户占用, 未改名` : '',
        pwdSql ? '密码取其 admin_accounts 的哈希' : (KEEP_PWD ? '保留原密码' : '原密码为空, 未改动'),
      ].filter(Boolean).join(' | '),
    });
  } else {
    const email = looksLikeEmail(uname) ? uname : `${uname || `admin${a.id}`}@admin.local`;
    statements.push(
      `INSERT INTO users (email, username, role, status, password_hash) ` +
        `SELECT ${quote(email)}, ${quote(uname)}, 'admin', 'active', password_hash ` +
        `FROM admin_accounts WHERE id = ${a.id};`,
    );
    plan.push({
      admin: `#${a.id} ${uname || '(无名)'}`,
      action: `新建 users (${email})`,
      detail: `匹配=${why} | role=admin | 密码取其 admin_accounts 的哈希`,
    });
  }
}

console.log(`admin_accounts ${admins.length} 行, users 活账号 ${users.length} 行\n`);
for (const p of plan) {
  console.log(`  ${p.admin}\n    -> ${p.action}\n       ${p.detail}`);
}
if (plan.length === 0) {
  console.log('  没有需要处理的账号。\n');
  process.exit(0);
}

if (!APPLY) {
  console.log('\n以上是计划 (dry-run)。确认无误后加 --apply 真正执行。\n');
  process.exit(0);
}

console.log('\n--- 执行 ---');
for (const sql of statements) {
  const meta = exec(sql);
  console.log(`  ok  changes=${meta?.changes ?? '?'}  ${sql.slice(0, 90)}…`);
}

// 复核: 迁移后必须**至少有一个** role='admin' 的活账号, 否则没人能再进后台
const after = query(
  `SELECT u.id, u.username, u.email, u.role, u.status,
          CASE WHEN u.password_hash IS NULL OR u.password_hash = '' THEN 0 ELSE 1 END AS has_pwd
     FROM users u WHERE u.deleted_at IS NULL AND u.role = 'admin' ORDER BY u.id`,
);
console.log(`\n迁移后 role='admin' 的活账号 ${after.length} 个:`);
for (const r of after) {
  console.log(`  #${r.id}  ${r.username || '(空)'}  <${r.email}>  密码=${Number(r.has_pwd) ? '已设置' : '空!'}`);
}
console.log(
  after.length > 0
    ? '\n✓ 可以用这些账号登录控制台了(用户名或邮箱均可, 密码沿用原管理员密码)。'
    : '\n✗ 没有任何 admin 账号, 请手工补一个再上线!',
);
console.log('  登录端点已改为校验 users 表; admin_accounts 保留作回滚用。\n');
