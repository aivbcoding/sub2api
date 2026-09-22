#!/usr/bin/env node
/**
 * 查 D1 的小工具 —— 专门解决这台 Windows 上的两个坑:
 *
 *   1. PowerShell 工具的 stdout 经常被吞掉, 什么也看不到;
 *   2. 用 `wrangler ... --json > file` 重定向出来的是 **UTF-16LE**, 直接读是乱码,
 *      而且 wrangler 会把 `[WARNING] Proxy environment variables detected` 混进
 *      输出里, 直接 JSON.parse 会炸。
 *
 * 这个脚本自己 spawn wrangler 并接管 stdout/stderr: 剥掉 ANSI、按 BOM 判断编码、
 * 从噪声里挑出第一个能解析的顶层 JSON 数组, 最后把结果**转义成纯 ASCII** 写到
 * 一个 txt 文件里(避免中文列让读取工具判定成二进制)。
 *
 * 用法:
 *   node tools/d1-query.mjs "SELECT id, name FROM groups WHERE deleted_at IS NULL"
 *   D1LOCAL=1 node tools/d1-query.mjs "SELECT COUNT(*) AS c FROM accounts"   # 查本地 D1
 *   D1NAME=other node tools/d1-query.mjs "..."                               # 换库名(默认 sub2api)
 *
 * 结果写到 $TEMP/d1q.txt, 再用 Read 打开。
 *
 * 注意: `--file` 只会返回**最后一条**语句的结果集, 所以这里只接受单条语句;
 *       需要多条就多跑几次。
 */
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

const sql = process.argv[2];
if (!sql) {
  console.error('用法: node tools/d1-query.mjs "SELECT ..."');
  process.exit(2);
}

const dbName = process.env.D1NAME || 'sub2api';
const localFlag = process.env.D1LOCAL === '1' ? '--local' : '--remote';

/** 结果文件名, 便于一次跑多条时区分 */
const outFile = (process.env.D1OUT || process.env.TEMP + '/d1q.txt');

// shell:true 时 node 不会给参数加引号, 带空格的 SQL 会被拆开, 所以手动包一层双引号
const r = spawnSync(
  'npx.cmd',
  ['wrangler', 'd1', 'execute', dbName, localFlag, `"--command=${sql.replace(/"/g, '\\"')}"`, '--json'],
  { cwd: process.cwd(), encoding: 'buffer', shell: true, maxBuffer: 64 * 1024 * 1024 },
);

const buf = r.stdout ?? Buffer.alloc(0);
let text = buf[0] === 0xff && buf[1] === 0xfe ? buf.toString('utf16le') : buf.toString('utf8');
text = text.replace(/\u001b\[[0-9;]*m/g, '');

if (r.stderr && r.stderr.length) {
  const se = r.stderr.toString('utf8').replace(/\u001b\[[0-9;]*m/g, '');
  if (se.trim()) console.error('[stderr] ' + se.slice(0, 1500));
}

/** 在噪声里找第一个能解析的顶层 JSON 数组 */
function findArray(s) {
  for (let start = 0; start < s.length; start++) {
    if (s[start] !== '[') continue;
    for (let end = s.length - 1; end > start; end--) {
      if (s[end] !== ']') continue;
      try {
        const cand = JSON.parse(s.slice(start, end + 1));
        if (Array.isArray(cand)) return cand;
      } catch {
        /* 继续往左缩 */
      }
    }
  }
  return null;
}

const out = [];
const arr = findArray(text);
if (!arr) {
  out.push('NO JSON. raw output:\n' + text.slice(0, 4000));
} else {
  for (const block of arr) {
    if (block.results) for (const row of block.results) out.push(JSON.stringify(row));
    else out.push('BLOCK: ' + JSON.stringify(block).slice(0, 1500));
  }
  if (out.length === 0) out.push('(0 rows)');
}

// 转成纯 ASCII, 避免中文列让读取工具把文件当二进制
const safe = out.map((l) =>
  l.replace(/[^\x09\x0A\x0D\x20-\x7E]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0')),
);
fs.writeFileSync(outFile, safe.join('\n'), 'ascii');
console.log('DONE -> ' + outFile + ' (' + out.length + ' lines)');
