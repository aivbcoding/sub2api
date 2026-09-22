/**
 * 「入口路径」(用请求 URL 指定上游) 的前缀解析回归测试
 *
 * 背景 (用户诉求):
 *   「最好是通过 api 的请求 url 判断走的是什么平台, 而不是通过 model 名称判断。
 *    判断好之后, model 名称对应的 api 的 url 不认, 那就是 model 名字有问题。」
 *
 * 于是给每条上游账号配一个入口路径, 客户端请求
 *   /<entry>/v1/chat/completions  ->  直接打到那条上游的 base_url
 * 平台/账号的挑选完全不看模型名。
 *
 * 这个文件测的是**前缀该不该被当成入口路径** —— 判错有两种代价:
 *   - 该认的没认: 客户端带前缀请求 404, 入口路径形同虚设
 *   - 不该认的认了: /v1/chat/completions 被拆成 seg=v1 去查库, 每次请求白打一次 D1
 *
 * 跑法: node tools/test-entry-path.mjs
 *
 * 实现说明: 从 src/gateway.ts 抠出真实函数体, 用 ts.transpileModule 抹掉类型后
 * 求值 —— 保证测的是**线上那份实现**, 而不是复制品。
 */

import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import ts from 'typescript';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, '..', 'src', 'gateway.ts'), 'utf8');

function grab(re, label) {
  const m = re.exec(src);
  if (!m) throw new Error(`not found in gateway.ts: ${label}`);
  return m[0];
}

const tsSource = [
  grab(/^const GATEWAY_PATH_PREFIXES = \[[^\]]*\];/m, 'GATEWAY_PATH_PREFIXES'),
  grab(/^export function isGatewayPath[\s\S]*?\n}/m, 'isGatewayPath'),
  grab(/^export const ENTRY_SEGMENT_BLOCKLIST = new Set\(\[[\s\S]*?\]\);/m, 'ENTRY_SEGMENT_BLOCKLIST'),
  grab(/^export function splitEntryPrefix[\s\S]*?\n}/m, 'splitEntryPrefix'),
  'export { isGatewayPath, splitEntryPrefix, ENTRY_SEGMENT_BLOCKLIST };',
].join('\n');

const js = ts.transpileModule(tsSource, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;

const dir = mkdtempSync(join(tmpdir(), 'entry-path-'));
const file = join(dir, 'entry-path-slice.mjs');
writeFileSync(file, js);
const mod = await import(pathToFileURL(file).href);

let pass = 0;
let fail = 0;
function check(name, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    console.log(`  PASS  ${name}`);
    pass++;
  } else {
    console.log(`  FAIL  ${name}\n        实际=${a}\n        期望=${e}`);
    fail++;
  }
}

console.log('\n[1] 普通客户端路径 —— 不该被当成入口路径(否则每次请求白打一次 D1)');
check('/v1/chat/completions', mod.splitEntryPrefix('/v1/chat/completions'), null);
check('/v1/models', mod.splitEntryPrefix('/v1/models'), null);
check('/v1/messages', mod.splitEntryPrefix('/v1/messages'), null);
check('/v1beta/models/gemini-2.5-flash:generateContent',
  mod.splitEntryPrefix('/v1beta/models/gemini-2.5-flash:generateContent'), null);
check('/models (单段之后没有第二段)', mod.splitEntryPrefix('/models'), null);
check('/chat/completions', mod.splitEntryPrefix('/chat/completions'), null);

console.log('\n[2] 后台/运维路径 —— 绝不能被当成入口路径');
check('/admin/accounts', mod.splitEntryPrefix('/admin/accounts'), null);
check('/api/admin/accounts', mod.splitEntryPrefix('/api/admin/accounts'), null);
check('/health', mod.splitEntryPrefix('/health'), null);

console.log('\n[3] 入口路径命中 —— 拆出 seg + 剥离后的真实路径');
check('/sensenova/v1/chat/completions',
  mod.splitEntryPrefix('/sensenova/v1/chat/completions'),
  { seg: 'sensenova', rest: '/v1/chat/completions' });
check('/wx/v1/chat/completions',
  mod.splitEntryPrefix('/wx/v1/chat/completions'),
  { seg: 'wx', rest: '/v1/chat/completions' });
check('/sensenova/v1/models',
  mod.splitEntryPrefix('/sensenova/v1/models'),
  { seg: 'sensenova', rest: '/v1/models' });
check('/gemini/v1beta/models/gemini-2.5-flash:generateContent',
  mod.splitEntryPrefix('/gemini/v1beta/models/gemini-2.5-flash:generateContent'),
  { seg: 'gemini', rest: '/v1beta/models/gemini-2.5-flash:generateContent' });
check('入口路径名和某平台同名也没关系(它就是个 URL 段)',
  mod.splitEntryPrefix('/openai/v1/chat/completions'),
  { seg: 'openai', rest: '/v1/chat/completions' });

console.log('\n[4] 畸形/边界输入 —— 一律 null, 不能抛');
check('只有一段 /sensenova', mod.splitEntryPrefix('/sensenova'), null);
check('空路径', mod.splitEntryPrefix(''), null);
check('根路径', mod.splitEntryPrefix('/'), null);
check('双斜杠 //v1/chat/completions', mod.splitEntryPrefix('//v1/chat/completions'), null);
check('第二段不是网关路径 /sensenova/whatever',
  mod.splitEntryPrefix('/sensenova/whatever'), null);

console.log('\n[5] 保留段校验 (与后台表单 ENTRY_PATH_RESERVED 对应)');
for (const p of ['v1', 'v1beta', 'models', 'admin', 'api', 'health', 'chat']) {
  check(`保留段 ${p} 在 blocklist 里`, mod.ENTRY_SEGMENT_BLOCKLIST.has(p), true);
}
check('业务用的入口路径不在 blocklist 里', mod.ENTRY_SEGMENT_BLOCKLIST.has('sensenova'), false);

console.log('\n[6] 剥离后的路径必须是合法网关路径(下游按它推导端点)');
check('rest 确实是网关路径', mod.isGatewayPath('/v1/chat/completions'), true);
check('rest 确实是网关路径(gemini 原生)', mod.isGatewayPath('/v1beta/models/x:generateContent'), true);
check('随便一个段不是网关路径', mod.isGatewayPath('/whatever'), false);

console.log(`\n=== 结果: ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);
