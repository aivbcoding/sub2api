#!/usr/bin/env node
/**
 * 后台「时间展示」回归测试 —— 全部时间必须以北京时间 (UTC+8) 呈现。
 *
 * 背景(踩过的坑):
 *   1. 库里存的是 UTC, 但 SQLite 的 `datetime('now')` 产出 "YYYY-MM-DD HH:MM:SS"
 *      **不带时区后缀**, 直接 new Date()/Date.parse 会被按浏览器本地时区解释。
 *   2. admin-ui.ts 里前端脚本是嵌在 **模板字面量** 里的, 反斜杠会被吃掉 ——
 *      `/^\d{4}/` 若不写成 `/^\\d{4}/`, 渲染到浏览器就变成 `/^d{4}/`, 静默失效。
 *      本测试直接求值模板字面量后再跑, 能把这类错误抓出来。
 *
 * 用法: node tools/test-time-format.mjs   (或 npm run test:time)
 * 退出码 0 = 通过, 1 = 有失败。
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(resolve(here, '../src/admin-ui.ts'), 'utf8');

// ---- 1. 求值 ADMIN_HTML 模板字面量(与 check-admin-ui.mjs 同一套提取方式) ----
const expr = src.match(/const ADMIN_HTML\s*=\s*(`[\s\S]*?`);/);
if (!expr) {
  console.error('✗ 找不到 `const ADMIN_HTML = `...`;` 定义');
  process.exit(1);
}
const html = (0, eval)(expr[1]);
const open = html.indexOf('<script>');
const close = html.lastIndexOf('</script>');
const inline = html.slice(open + '<script>'.length, close);

// ---- 2. 在带 DOM 桩的沙箱里跑一遍内联脚本, 取出纯函数 ----
const fake = new Proxy(function () {}, {
  get(_t, k) {
    if (k === Symbol.toPrimitive || k === 'toString' || k === 'valueOf') return () => '';
    if (k === 'then') return undefined; // 别让桩被当成 thenable
    return fake;
  },
  set: () => true,
  apply: () => fake,
  construct: () => fake,
  has: () => true,
});

function loadHelpers() {
  const ctx = vm.createContext({
    console: { log() {}, warn() {}, error() {} },
    Intl, Date, String, Number, Boolean, Array, Object, JSON, Math, Promise,
    Error, RegExp, Map, Set, Symbol, URLSearchParams, Proxy,
    encodeURIComponent, decodeURIComponent, parseInt, parseFloat, isNaN,
    setTimeout: () => 0, clearTimeout: () => {}, setInterval: () => 0,
    document: fake, window: fake, navigator: fake, localStorage: fake, location: fake,
    fetch: () => Promise.reject(new Error('test-stub: no network')),
  });
  vm.runInContext(
    inline + '\n;globalThis.__T = { fmtTime, fmtTimeBj, parseDbTime };',
    ctx,
    { filename: 'admin-ui-inline.js' },
  );
  return ctx.__T;
}

// ---- 3. 断言 ----
let pass = 0;
let fail = 0;
const failures = [];
/** 记录每一条断言的实际输出, 用于跨时区逐条比对 */
let trace = [];

function eq(label, actual, expected) {
  trace.push(label + ' => ' + String(actual));
  if (actual === expected) {
    pass++;
    console.log(`  ✓ ${label}`);
  } else {
    fail++;
    failures.push(`${label}\n      期望: ${expected}\n      实际: ${actual}`);
    console.log(`  ✗ ${label}\n      期望: ${expected}\n      实际: ${actual}`);
  }
}

function runSuite(title, { fmtTime, fmtTimeBj, parseDbTime }) {
  console.log(`\n== ${title} ==`);

  // 1) ISO 带 Z 的 UTC -> 北京 +8
  eq('ISO UTC 14:30 -> 北京 22:30',
    fmtTime('2026-09-20T14:30:00.000Z'), '2026-09-20 22:30:00');

  // 2) SQLite 无后缀(UTC), 必须同样按 UTC 解释 -> 北京 +8
  eq('SQLite 无后缀 14:30 -> 北京 22:30',
    fmtTime('2026-09-20 14:30:00'), '2026-09-20 22:30:00');

  // 3) 两种写法结果必须一致(这是本次改动的核心诉求)
  eq('两种写入格式结果一致',
    fmtTime('2026-09-20T14:30:00.000Z'), fmtTime('2026-09-20 14:30:00'));

  // 4) 跨天: UTC 16:00 = 北京次日 00:00
  eq('UTC 16:00 -> 北京次日 00:00',
    fmtTime('2026-09-20T16:00:00.000Z'), '2026-09-21 00:00:00');

  // 5) 跨天反向: UTC 前一天 23:00 = 北京当天 07:00
  eq('UTC 前一日 23:00 -> 北京 07:00',
    fmtTime('2026-09-19 23:00:00'), '2026-09-20 07:00:00');

  // 6) 无秒数的 datetime-local 写法
  eq('无秒 "YYYY-MM-DDTHH:MM" -> 北京 +8',
    fmtTime('2026-09-20T14:30'), '2026-09-20 22:30:00');

  // 7) 空值
  eq('空字符串 -> "-"', fmtTime(''), '-');
  eq('null -> "-"', fmtTime(null), '-');
  eq('undefined -> "-"', fmtTime(undefined), '-');

  // 8) 解析不了的值原样兜底, 不崩
  eq('非法值原样兜底', fmtTime('not-a-time'), 'not-a-time');

  // 9) 悬浮提示带时区标注
  eq('tooltip 带 (UTC+8)',
    fmtTimeBj('2026-09-20T14:30:00.000Z'), '2026-09-20 22:30:00 (UTC+8)');
  eq('tooltip 空值 -> "-"', fmtTimeBj(null), '-');

  // 10) parseDbTime 两种写法得到同一时间戳
  eq('parseDbTime 两种写法同值',
    parseDbTime('2026-09-20T14:30:00.000Z'), parseDbTime('2026-09-20 14:30:00'));

  // 11) 关键: 反斜杠没被模板字面量吃掉 —— 正则能正确识别无后缀格式。
  //     若源码漏写双反斜杠, parseDbTime 会走 Date.parse 分支并被本地时区污染,
  //     在非 UTC 环境下这里就会不等。
  eq('无后缀解析未被本地时区污染',
    parseDbTime('2026-09-20 14:30:00'), Date.parse('2026-09-20T14:30:00Z'));
}

// 同一套断言跑两个时区, 结果必须逐条一致 = 展示与浏览器时区无关
process.env.TZ = 'Asia/Shanghai';
trace = [];
runSuite('TZ=Asia/Shanghai (东八区浏览器)', loadHelpers());
const traceA = trace.slice();

process.env.TZ = 'America/New_York';
trace = [];
runSuite('TZ=America/New_York (西五区浏览器)', loadHelpers());
const traceB = trace.slice();

console.log('\n== 时区无关性 ==');
eq('两种浏览器时区下逐条输出一致', JSON.stringify(traceB), JSON.stringify(traceA));

// ---- 4. 源码级护栏: 后端「按天筛选」也必须按北京时间切天 ----
// 这段 SQL 不在返回给浏览器的 HTML 里, 线上验收看不到, 只能查源码。
console.log('\n== 后端按天筛选 (admin-api.ts) ==');
{
  const api = readFileSync(resolve(here, '../src/admin-api.ts'), 'utf8');
  const m = /const dayExpr = `([^`]+)`/.exec(api);
  const expr = m ? m[1] : '';
  eq('dayExpr 存在', Boolean(m), true);
  eq('dayExpr 已按 +8 小时切天', /date\([\s\S]*\+\s*8\s*hours/i.test(expr), true);
}

// ---- 5. 护栏: 前端脚本里不允许出现会被模板字面量吃掉的反斜杠写法 ----
// 例如源码写 `/^\d{4}/`, 渲染到浏览器会变成 `/^d{4}/` —— 必须写成 `/^\\d{4}/`。
// 这里直接查**渲染后**的脚本, 而不是源码, 才能抓到这一类错误。
console.log('\n== 模板字面量反斜杠护栏 ==');
{
  eq('渲染后的脚本里日期正则保留了 \\d', inline.includes('(\\d{4}-'), true);
  eq('渲染后的脚本里没有退化成 (d{4}-', inline.includes('(d{4}-'), false);
}

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
if (fail) {
  console.error('\n失败详情:\n' + failures.map((f) => '  - ' + f).join('\n'));
  process.exit(1);
}
console.log('✓ 时间展示全部为北京时间 (UTC+8), 且与浏览器时区无关');
