/**
 * 「模型 → 平台 重定向」大小写不敏感回归
 *
 * 背景: 客户端对模型名的大小写处理不一致(有的原样透传、有的规范化)。
 * 用户不可能穷举 GLM-5.2 / Glm-5.2 / glm-5.2 —— 漏掉的那个写法会掉回
 * "按模型名推断"分支, glm-* 去找不存在的 zhipu 平台, 报
 * 503 no_upstream_account (措辞像"没配账号", 实为"配了但没命中")。
 *
 * 这个测试锁定 lookupModelRoute 的行为:
 *   1. 精确命中优先
 *   2. 精确查不到时退化为大小写不敏感
 *   3. 完全不匹配时返回 null(不能瞎猜)
 *   4. 平台名不被改动, 模型名改写照常生效
 *   5. 非法值安全降级
 *
 * 跑法: node tools/test-model-route.mjs
 *
 * 实现说明: 直接从 src/gateway.ts 抠出真实函数体, 用 TypeScript 的
 * transpileModule 擦掉类型后求值 —— 保证测的是**线上那份实现**而不是复制品。
 * (gateway.ts 依赖 Workers 运行时, 没法直接 import。)
 */

import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import ts from 'typescript';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, '..', 'src', 'gateway.ts'), 'utf8');

/** 从源文件里按花括号配对抠出一个函数声明 */
function extract(name) {
  // 必须匹配 "function <name>(" —— 且前面只允许 export/空白/换行。
  // 不能简单 indexOf(`function ${name}(`): 那会命中**调用点**
  // (`resolveModelPlatformRoute(ctx, model)` 里也含这个名字)。
  const re = new RegExp(`(?:^|\\n)(export\\s+)?function\\s+${name}\\s*\\(`, 'm');
  const m = re.exec(src);
  if (!m) throw new Error(`not found in gateway.ts: ${name}`);
  const start = m.index + (m[0].startsWith('\n') ? 1 : 0);

  // 先跳过形参列表 —— 从 "(" 开始配对小括号。
  // 不能直接找第一个 "{": 返回值类型 `): { platform: string }` 里就有 "{",
  // 会被误当成函数体起点(切出来的函数只有签名, 没有 body)。
  let i = src.indexOf('(', start);
  let paren = 0;
  for (; i < src.length; i++) {
    if (src[i] === '(') paren++;
    else if (src[i] === ')') {
      paren--;
      if (paren === 0) { i++; break; }
    }
  }

  // 形参之后还要跳过**返回值类型**。
  // 返回值可能是对象字面量类型 `): { platform: string; model?: string } {`,
  // 里面那个 "{" 会被误当成函数体起点 —— 直接找第一个 "{" 会切出"只有签名"的片段。
  //
  // 可靠做法: 函数体是**签名行最后一个 "{"**。签名行以 ")" 或类型结尾,
  // 之后换行的是函数体。所以取"从形参结束到第一个换行之间最后的 {"。
  const lineEnd = src.indexOf('\n', i);
  const sigLine = src.slice(i, lineEnd < 0 ? src.length : lineEnd);
  const lastBrace = sigLine.lastIndexOf('{');
  let bodyStart;
  if (lastBrace >= 0) {
    // 签名行里有 "{": 最后一个就是函数体起点
    bodyStart = i + lastBrace;
  } else {
    // 签名行没有 "{", 函数体在下一行
    bodyStart = src.indexOf('{', i);
  }
  let depth = 0;
  for (let j = bodyStart; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') {
      depth--;
      if (depth === 0) {
        return src.slice(start, j + 1).replace(/^export\s+/, '');
      }
    }
  }
  throw new Error(`unbalanced braces in ${name}`);
}

const tsSource = [
  extract('lookupModelRoute'),
  extract('resolveModelPlatformRoute'),
  extract('isModelAllowed'),
  extract('accountModelAliases'),
  extract('applyAccountAlias'),
  'export { lookupModelRoute, resolveModelPlatformRoute, isModelAllowed, accountModelAliases, applyAccountAlias };',
].join('\n');

// 用 TS 官方转译器擦类型 —— 比手写正则可靠得多
const js = ts.transpileModule(tsSource, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;

// 写进临时 .mjs 再 import (data: URL 对 import 解析支持不稳)
const dir = mkdtempSync(join(tmpdir(), 'model-route-'));
const file = join(dir, 'gateway-slice.mjs');
writeFileSync(file, js);
const mod = await import(pathToFileURL(file).href);

let pass = 0, fail = 0;
function check(name, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) { console.log(`  PASS  ${name}`); pass++; }
  else { console.log(`  FAIL  ${name}\n        实际=${a}\n        期望=${e}`); fail++; }
}

const TABLE = {
  'deepseek-v4-pro': { platform: 'sensenova', model: 'deepseek-v4-pro' },
  'glm-5.2': 'sensenova',
  'kimi-k3': 'sensenova',
};

const ctx = { groupModelPlatformRouting: TABLE };
const empty = { groupModelPlatformRouting: null };

console.log('=== 模型 → 平台 重定向: 大小写匹配回归 ===\n');

console.log('[1] 精确命中(小写原样)');
check('glm-5.2', mod.resolveModelPlatformRoute(ctx, 'glm-5.2'), { platform: 'sensenova', key: 'glm-5.2' });
check('kimi-k3', mod.resolveModelPlatformRoute(ctx, 'kimi-k3'), { platform: 'sensenova', key: 'kimi-k3' });
check('deepseek-v4-pro 带 model 改写',
  mod.resolveModelPlatformRoute(ctx, 'deepseek-v4-pro'),
  { platform: 'sensenova', model: 'deepseek-v4-pro', key: 'deepseek-v4-pro' });

console.log('\n[2] 大小写变体必须命中同一目标(这就是报 503 的那个场景)');
check('GLM-5.2', mod.resolveModelPlatformRoute(ctx, 'GLM-5.2'), { platform: 'sensenova', key: 'glm-5.2' });
check('Glm-5.2', mod.resolveModelPlatformRoute(ctx, 'Glm-5.2'), { platform: 'sensenova', key: 'glm-5.2' });
check('gLM-5.2', mod.resolveModelPlatformRoute(ctx, 'gLM-5.2'), { platform: 'sensenova', key: 'glm-5.2' });
check('KIMI-K3', mod.resolveModelPlatformRoute(ctx, 'KIMI-K3'), { platform: 'sensenova', key: 'kimi-k3' });
check('DeepSeek-v4-pro 仍带 model 改写',
  mod.resolveModelPlatformRoute(ctx, 'DeepSeek-v4-pro'),
  { platform: 'sensenova', model: 'deepseek-v4-pro', key: 'deepseek-v4-pro' });
check('DEEPSEEK-V4-PRO',
  mod.resolveModelPlatformRoute(ctx, 'DEEPSEEK-V4-PRO'),
  { platform: 'sensenova', model: 'deepseek-v4-pro', key: 'deepseek-v4-pro' });

console.log('\n[3] 完全不匹配时不能瞎猜');
check('glm-4.6(表里没有)', mod.resolveModelPlatformRoute(ctx, 'glm-4.6'), null);
check('空模型名', mod.resolveModelPlatformRoute(ctx, ''), null);
check('没配重定向表', mod.resolveModelPlatformRoute(empty, 'glm-5.2'), null);

console.log('\n[4] 空值/非法值的安全处理');
check('平台名是空串 -> null',
  mod.resolveModelPlatformRoute({ groupModelPlatformRouting: { x: '   ' } }, 'x'), null);
check('对象缺 platform -> null',
  mod.resolveModelPlatformRoute({ groupModelPlatformRouting: { x: { model: 'y' } } }, 'x'), null);
check('对象带 platform 无 model -> 只给平台',
  mod.resolveModelPlatformRoute({ groupModelPlatformRouting: { x: { platform: 'p' } } }, 'x'),
  { platform: 'p', key: 'x' });
check('值类型非法 -> null',
  mod.resolveModelPlatformRoute({ groupModelPlatformRouting: { x: 123 } }, 'x'), null);

console.log('\n[5] 精确优先于模糊(同名不同大小写可区分)');
const both = { groupModelPlatformRouting: { 'glm-5.2': 'a', 'GLM-5.2': 'b' } };
check('glm-5.2 -> a(精确)', mod.resolveModelPlatformRoute(both, 'glm-5.2'), { platform: 'a', key: 'glm-5.2' });
check('GLM-5.2 -> b(精确)', mod.resolveModelPlatformRoute(both, 'GLM-5.2'), { platform: 'b', key: 'GLM-5.2' });

console.log('\n[6] lookupModelRoute 直接行为(返回命中的 key, 供归一化大小写)');
check('精确优先',
  mod.lookupModelRoute(both, 'GLM-5.2'), { key: 'GLM-5.2', value: 'b' });
check('模糊兜底 命中表里的 key',
  mod.lookupModelRoute({ groupModelPlatformRouting: { 'glm-5.2': 'a' } }, 'GLM-5.2'),
  { key: 'glm-5.2', value: 'a' });
check('无表', mod.lookupModelRoute(empty, 'glm-5.2'), null);

console.log('\n[7] 简写形式必须把模型名归一化成表里的 key(否则上游 404)');
// GLM-5.2 是客户端发来的, 表里只有 glm-5.2; 必须改写成 glm-5.2 再转发
// (sensenova 只认小写)。
const shortCtx = { groupModelPlatformRouting: { 'glm-5.2': 'sensenova' } };
check('GLM-5.2 -> key=glm-5.2', mod.resolveModelPlatformRoute(shortCtx, 'GLM-5.2'),
  { platform: 'sensenova', key: 'glm-5.2' });
check('glm-5.2 -> key=glm-5.2', mod.resolveModelPlatformRoute(shortCtx, 'glm-5.2'),
  { platform: 'sensenova', key: 'glm-5.2' });
// 显式给了 model 时以 model 为准(不被 key 覆盖)
const objCtx = { groupModelPlatformRouting: { 'Deepseek-v4-pro': { platform: 'sensenova', model: 'deepseek-v4-pro' } } };
check('显式 model 优先于 key',
  mod.resolveModelPlatformRoute(objCtx, 'Deepseek-v4-pro'),
  { platform: 'sensenova', model: 'deepseek-v4-pro', key: 'Deepseek-v4-pro' });

console.log('\n[8] 白名单大小写不敏感(否则重定向认了、白名单却拦掉)');
const AL = ['Deepseek-v4-flash', 'deepseek-v4-pro', 'glm-5.2', 'kimi-k3'];
check('精确', mod.isModelAllowed(AL, 'glm-5.2'), true);
check('大写', mod.isModelAllowed(AL, 'GLM-5.2'), true);
check('混合大小写', mod.isModelAllowed(AL, 'Glm-5.2'), true);
check('Deepseek 小写写法', mod.isModelAllowed(AL, 'deepseek-v4-flash'), true);
check('Deepseek 大写写法', mod.isModelAllowed(AL, 'Deepseek-v4-pro'), true);
check('不在名单里', mod.isModelAllowed(AL, 'glm-4.6'), false);
check('空名单 = 不限制由调用方处理', mod.isModelAllowed([], 'anything'), false);

console.log('\n[9] 账号级模型别名 extra.model_aliases(解决模型 ID 冲突)');
// 场景: 客户端发 glm-5.2, 但这条中转内部叫 my-glm-pro
const acct = { extra: JSON.stringify({ model_aliases: { 'glm-5.2': 'my-glm-pro' } }) };
check('命中别名 -> 换成上游认识的名字', mod.applyAccountAlias(acct, 'glm-5.2'), 'my-glm-pro');
check('大小写不敏感 GLM-5.2', mod.applyAccountAlias(acct, 'GLM-5.2'), 'my-glm-pro');
check('大小写不敏感 Glm-5.2', mod.applyAccountAlias(acct, 'Glm-5.2'), 'my-glm-pro');
check('没配过的模型原样返回', mod.applyAccountAlias(acct, 'kimi-k3'), 'kimi-k3');
check('空模型名原样返回', mod.applyAccountAlias(acct, ''), '');
check('无 extra 原样返回',
  mod.applyAccountAlias({ extra: '' }, 'glm-5.2'), 'glm-5.2');
check('extra 非法 JSON 不炸',
  mod.applyAccountAlias({ extra: '{oops' }, 'glm-5.2'), 'glm-5.2');
check('model_aliases 不是对象不炸',
  mod.applyAccountAlias({ extra: JSON.stringify({ model_aliases: [1, 2] }) }, 'glm-5.2'), 'glm-5.2');
check('别名值是空串被忽略',
  mod.applyAccountAlias({ extra: JSON.stringify({ model_aliases: { 'glm-5.2': '  ' } }) }, 'glm-5.2'),
  'glm-5.2');
check('多条别名同时生效',
  mod.applyAccountAlias(
    { extra: JSON.stringify({ model_aliases: { 'glm-5.2': 'my-glm', 'kimi-k3': 'my-kimi' } }) },
    'KIMI-K3'),
  'my-kimi');
check('accountModelAliases 解析结果',
  mod.accountModelAliases(acct), { 'glm-5.2': 'my-glm-pro' });
check('accountModelAliases 空 extra -> {}',
  mod.accountModelAliases({ extra: '' }), {});
// 别名表精确优先, 不与大小写模糊互相污染
check('精确优先于模糊',
  mod.applyAccountAlias(
    { extra: JSON.stringify({ model_aliases: { 'glm-5.2': 'a', 'GLM-5.2': 'b' } }) },
    'GLM-5.2'),
  'b');

console.log(`\n=== 结果: ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);
