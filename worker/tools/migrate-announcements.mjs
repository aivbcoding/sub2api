#!/usr/bin/env node
/**
 * 建 `announcements` 表(公告管理) —— 「公告管理」菜单上线前的 schema 迁移。
 *
 * 为什么需要一张新表而不是继续用 settings.announcement:
 *   老的公告是 settings 表里的**一个字符串**, 只有正文、没有标题, 也没法发多条、
 *   没法撤回、没法看历史。管理员要的东西(标题 + 详情 + 增删改)必须落成真表。
 *   完整设计说明见 schema/schema-announcements.sql 顶部注释。
 *
 * 迁移内容(**全部 IF NOT EXISTS, 可重复执行**):
 *   1. CREATE TABLE IF NOT EXISTS announcements (...)
 *   2. CREATE INDEX  IF NOT EXISTS idx_announcements_list (...)
 *
 * 🚨 老数据兼容: 迁移**不碰** settings.announcement。后端读公告时的顺序是
 *    「announcements 表有已发布的就用表里的, 表里一条都没有才回落到 settings.announcement」。
 *    所以迁移本身是纯增量, 对现网零风险 —— 跑完不部署新代码, 老后台照常工作。
 *    管理员在「公告管理」页发出第一条公告后, 旧键自动被遮蔽(不改也不删, 想回滚好办)。
 *
 * 用法:
 *   node tools/migrate-announcements.mjs            # 线上, 只检查(默认 dry-run)
 *   node tools/migrate-announcements.mjs --apply    # 线上, 真正建表
 *   D1LOCAL=1 node tools/migrate-announcements.mjs --apply     # 本地 D1
 */
import { spawnSync } from 'node:child_process';

const APPLY = process.argv.includes('--apply');
const localFlag = process.env.D1LOCAL === '1' ? '--local' : '--remote';
const dbName = process.env.D1NAME || 'sub2api';

function runWrangler(sqlText) {
  // 换行必须压平: shell:true 下 `--command="..."` 里的裸换行会截断参数,
  // wrangler 收到半条 SQL 报 "incomplete input: SQLITE_ERROR"。
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

/** 表是否存在 —— sqlite_master 是唯一可信来源(不能靠 --file 的"执行成功") */
function tableExists(name) {
  const blocks = runWrangler(
    `SELECT name FROM sqlite_master WHERE type='table' AND name='${name}'`,
  );
  for (const b of blocks) if (b && b.results) return b.results.length > 0;
  return false;
}

function exec(sql) {
  const blocks = runWrangler(sql);
  for (const b of blocks) if (b && b.meta) return b.meta;
  return null;
}

const DDL_TABLE = `CREATE TABLE IF NOT EXISTS announcements (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  title      TEXT    NOT NULL DEFAULT '',
  content    TEXT    NOT NULL DEFAULT '',
  status     TEXT    NOT NULL DEFAULT 'published',
  pinned     INTEGER NOT NULL DEFAULT 0,
  revision   INTEGER NOT NULL DEFAULT 1,
  created_at TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT    NOT NULL DEFAULT (datetime('now')),
  deleted_at TEXT
)`;

const DDL_INDEX = `CREATE INDEX IF NOT EXISTS idx_announcements_list
  ON announcements(deleted_at, pinned DESC, id DESC)`;

/** 标记 <<OK>> / <<MISS>> 便于脚本判断, 同时避开 Windows 控制台中文乱码 */
const mark = (ok) => (ok ? '<<OK>>' : '<<MISS>>');

console.log(`\n=== migrate announcements (${localFlag}${APPLY ? '' : ' / DRY-RUN'}) ===`);
console.log(`db: ${dbName}\n`);

const before = tableExists('announcements');
console.log(`table announcements: ${before ? 'EXISTS' : 'ABSENT'} ${mark(before)}`);

// 老公告键的现状(只读, 不回填、不删除) —— 让操作员知道发第一条新公告后旧内容会被遮蔽
try {
  const blocks = runWrangler(
    `SELECT key, length(value) AS len FROM settings WHERE key = 'announcement'`,
  );
  let found = null;
  for (const b of blocks) if (b && b.results && b.results.length) found = b.results[0];
  console.log(
    found
      ? `legacy settings.announcement: present, length=${found.len} (kept as-is; hidden once the table has a published row)`
      : 'legacy settings.announcement: absent (nothing to keep compatible)',
  );
} catch (e) {
  console.log('(query legacy key failed, does not affect DDL): ' + e.message.slice(0, 200));
}

if (!APPLY) {
  console.log('\nDRY-RUN: no writes performed. Re-run with --apply.\n');
  process.exit(0);
}

console.log('\nRunning DDL ...');
exec(DDL_TABLE);
exec(DDL_INDEX);

const after = tableExists('announcements');
console.log(`table announcements: ${after ? 'READY' : 'STILL-MISSING'} ${mark(after)}`);

if (after) {
  const blocks = runWrangler(`SELECT COUNT(*) AS n FROM announcements`);
  let n = 0;
  for (const b of blocks) if (b && b.results && b.results.length) n = b.results[0].n;
  console.log(`rows: ${n}`);
}

console.log('\nNext: deploy new code, then admin -> sidebar "announce" -> publish the first announcement.\n');
if (!after) process.exit(1);
