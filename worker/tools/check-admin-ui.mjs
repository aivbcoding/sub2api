#!/usr/bin/env node
/**
 * 校验 admin-ui.ts 里内联在模板字符串中的 <script> 片段本身是合法 JS。
 *
 * 为什么需要它:
 *   ADMIN_HTML 是一个 TS 模板字面量,里面嵌了整段前端 JS。
 *   模板字面量会「吃掉」反斜杠转义 —— 源码写 `\/` 求值后变成 `/`,
 *   于是 `!/^https?:\/\//i` 在浏览器里退化成
 *   `!/^https?:/` + 行注释 `//i.test(...)`,整段脚本炸掉。
 *   这类错误 tsc 查不出来,只有把渲染结果交给 JS 解析器才会暴露。
 *
 * 用法: node tools/check-admin-ui.mjs   (或 npm run check:ui)
 * 退出码 0 = 通过, 1 = 有问题。
 */
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const srcPath = resolve(here, '../src/admin-ui.ts');
const source = readFileSync(srcPath, 'utf8');

// 1. 抠出 ADMIN_HTML 的模板字面量并真正求值,拿到浏览器实际收到的 HTML
const expr = source.match(/const ADMIN_HTML\s*=\s*(`[\s\S]*?`);/);
if (!expr) {
  console.error('✗ 找不到 `const ADMIN_HTML = `...`;` 定义');
  process.exit(1);
}
let html;
try {
  // 该字面量不含 ${} 插值,求值安全
  html = (0, eval)(expr[1]);
} catch (e) {
  console.error('✗ 求值 ADMIN_HTML 模板字面量失败:', e.message);
  process.exit(1);
}

// 2. 取出 <script> ... </script> 之间的内容
const open = html.indexOf('<script>');
const close = html.lastIndexOf('</script>');
if (open === -1 || close === -1 || close < open) {
  console.error('✗ 渲染结果里找不到成对的 <script>...</script>');
  process.exit(1);
}
const inline = html.slice(open + '<script>'.length, close);

// 3. 交给 JS 解析器做语法检查(用 node --check 走临时文件)
const dir = mkdtempSync(join(tmpdir(), 'adm-ui-'));
const tmp = join(dir, 'inline.js');
writeFileSync(tmp, inline, 'utf8');
try {
  execFileSync(process.execPath, ['--check', tmp], { stdio: 'pipe' });
} catch (e) {
  console.error('✗ 内联 <script> 不是合法 JS,浏览器会白屏/报 SyntaxError:');
  console.error((e.stderr || e.stdout || Buffer.from('')).toString().trim());
  rmSync(dir, { recursive: true, force: true });
  process.exit(1);
}
rmSync(dir, { recursive: true, force: true });

// 4. 额外护栏: 检测会被行注释吞掉的 `:///` / `//` 收尾正则这类高危字面量
const hazards = [];
for (const [i, line] of inline.split('\n').entries()) {
  // 正则里紧跟 `//` 再跟 flag,例如 /^https?:///i
  if (/\/(?:[^/\n\\]|\\\/)*\/\/[a-z]*\s*[.)]/.test(line) === false && /:\/\/\//.test(line)) {
    hazards.push(`  第 ${i + 1} 行: ${line.trim()}`);
  }
}
if (hazards.length) {
  console.error('✗ 检测到可疑的未转义正则字面量(可能被 // 变成行注释):');
  console.error(hazards.join('\n'));
  process.exit(1);
}

console.log(`✓ admin-ui 内联 <script> 语法正确 (${inline.length} 字符)`);
