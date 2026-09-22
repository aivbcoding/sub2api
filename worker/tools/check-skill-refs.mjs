/**
 * 引用完整性校验 —— 防止「文档/配置指向了已删除或不存在的脚本」。
 *
 * 查两处:
 *   1. 排查手册 SKILL.md 里出现的 `tools/xxx.mjs|sql|ps1`
 *   2. package.json 的 scripts 里出现的 `tools/xxx.*` 与 `test/xxx.*`
 *
 * 为什么要它: 删脚本时最怕漏改引用。历史上 SKILL.md 写过一个
 * `tools/check-platform-select.mjs` 的"回归命令", 但仓库里根本没这个文件 ——
 * 后来人照抄会直接扑空。这类坑只有交叉校验能发现。
 *
 * 用法: node tools/check-skill-refs.mjs   (或 npm run check:refs)
 * 退出码 0 = 通过, 1 = 有缺失引用。
 */
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const skillPath = 'C:/Users/admin/.workbuddy/skills/sub2api-worker-relay-triage/SKILL.md';

/**
 * 文档里会写「`tools/xxx.mjs`」这类**占位符**来说明"这里填你的脚本名"，
 * 它们不是真实引用，不该算缺失。判定: 文件名里含 xxx / foo / bar / <...>。
 */
const isPlaceholder = (name) => /xxx|foo|bar|^<|>$/i.test(name);

const targets = [];

// ---- 1. SKILL.md ----
if (existsSync(skillPath)) {
  const skill = readFileSync(skillPath, 'utf8');
  for (const m of skill.matchAll(/tools[\\/]([\w.\-<>]+\.(?:mjs|sql|ps1))/g)) {
    targets.push({ from: 'SKILL.md', rel: `tools/${m[1]}` });
  }
} else {
  console.log(`! 跳过 SKILL.md (不存在: ${skillPath})`);
}

// ---- 2. package.json scripts ----
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
for (const [name, cmd] of Object.entries(pkg.scripts ?? {})) {
  for (const m of String(cmd).matchAll(/((?:tools|test)[\\/][\w.\-]+\.(?:mjs|sql|js))/g)) {
    targets.push({ from: `package.json:${name}`, rel: m[1] });
  }
}

// ---- 3. 去重 + 判定 ----
const seen = new Set();
let bad = 0;
let skipped = 0;
for (const t of targets) {
  const base = t.rel.split(/[\\/]/).pop();
  if (isPlaceholder(base)) {
    skipped++;
    continue;
  }
  const key = t.rel;
  if (seen.has(key)) continue;
  seen.add(key);

  const ok = existsSync(join(root, t.rel));
  if (!ok) bad++;
  console.log(`${ok ? 'OK  ' : 'MISS'} ${t.rel.padEnd(38)} <- ${t.from}`);
}

console.log(
  `\n共 ${seen.size} 个真实引用 (跳过 ${skipped} 个占位符), 缺失 ${bad} 个`,
);
process.exit(bad ? 1 : 0);
