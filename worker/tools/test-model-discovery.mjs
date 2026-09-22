/**
 * 「模型获取」解析逻辑测试
 *
 * 覆盖 admin-api.ts 里抽出上游模型列表的纯函数:
 *   extractModelIds()   —— 各种上游返回体 -> 模型 ID 数组
 *
 * 为什么要单独测: 上游的返回格式五花八门(OpenAI / Anthropic / Gemini / 部分中转的裸数组),
 * 一旦某家格式变化或返回异常, 这段代码会静默返回空数组 —— 用户看到的是"获取不到模型",
 * 却不知道该怪上游还是怪我们。所以把每种见过的格式都钉成用例。
 *
 * 另有 admin-ui.ts 里生成建议别名的 suggestAlias() —— 「平台名 + 模型 ID」规范,
 * 一并抽出来测, 避免规范在两处实现走样。
 *
 * 跑法: node tools/test-model-discovery.mjs
 */
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import ts from 'typescript';

const here = dirname(fileURLToPath(import.meta.url));

/** 从 TS 源码里抠出指定函数的完整定义(含函数体) */
function extractFn(src, name) {
  const re = new RegExp(`(?:^|\\n)(export\\s+)?function\\s+${name}\\s*\\(`, 'm');
  const m = re.exec(src);
  if (!m) throw new Error(`not found: ${name}`);
  const start = m.index + (m[0].startsWith('\n') ? 1 : 0);
  let i = src.indexOf('(', start);
  let paren = 0;
  for (; i < src.length; i++) {
    if (src[i] === '(') paren++;
    else if (src[i] === ')') { paren--; if (paren === 0) { i++; break; } }
  }
  const lineEnd = src.indexOf('\n', i);
  const sigLine = src.slice(i, lineEnd < 0 ? src.length : lineEnd);
  const lastBrace = sigLine.lastIndexOf('{');
  const bodyStart = lastBrace >= 0 ? i + lastBrace : src.indexOf('{', i);
  let depth = 0;
  for (let j = bodyStart; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') { depth--; if (depth === 0) return src.slice(start, j + 1).replace(/^export\s+/, ''); }
  }
  throw new Error('unbalanced: ' + name);
}

const adminApi = readFileSync(join(here, '..', 'src', 'admin-api.ts'), 'utf8');
const adminUi = readFileSync(join(here, '..', 'src', 'admin-ui.ts'), 'utf8');

const js = ts.transpileModule(
  extractFn(adminApi, 'extractModelIds') + '\n' +
  extractFn(adminUi, 'suggestAlias') + '\n' +
  'export { extractModelIds, suggestAlias };',
  { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } },
).outputText;

const dir = mkdtempSync(join(tmpdir(), 'model-disc-'));
const file = join(dir, 'slice.mjs');
writeFileSync(file, js);
const mod = await import(pathToFileURL(file).href);

let pass = 0, fail = 0;
function check(name, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { console.log(`  PASS  ${name}`); pass++; }
  else { console.log(`  FAIL  ${name}\n        实际=${a}\n        期望=${e}`); fail++; }
}

const E = mod.extractModelIds;
const S = mod.suggestAlias;

// ---------------------------------------------------------------- extractModelIds
console.log('\n[1] OpenAI / Anthropic 格式: { data: [{ id }] }');
check('取 id 并排序', E({ data: [{ id: 'gpt-4o' }, { id: 'gpt-4o-mini' }] }), [
  { id: 'gpt-4o' }, { id: 'gpt-4o-mini' },
]);
check('真实上游还会带一堆字段', E({ object: 'list', data: [
  { id: 'glm-5.2', object: 'model', owned_by: 'zhipu' },
  { id: 'glm-4.6', object: 'model', owned_by: 'zhipu' },
]}), [{ id: 'glm-4.6' }, { id: 'glm-5.2' }]);
check('去重', E({ data: [{ id: 'a' }, { id: 'a' }, { id: 'b' }] }), [{ id: 'a' }, { id: 'b' }]);

console.log('\n[2] Gemini 格式: { models: [{ name: "models/xxx" }] }');
check('剥掉 models/ 前缀', E({ models: [
  { name: 'models/gemini-2.0-flash' },
  { name: 'models/gemini-1.5-pro' },
]}), [{ id: 'gemini-1.5-pro' }, { id: 'gemini-2.0-flash' }]);
check('没有前缀也不出错', E({ models: [{ name: 'gemini-2.0-flash' }] }), [{ id: 'gemini-2.0-flash' }]);

console.log('\n[3] 部分中转: 裸字符串数组');
check('data 是字符串数组', E({ data: ['gpt-4o', 'gpt-3.5'] }), [{ id: 'gpt-3.5' }, { id: 'gpt-4o' }]);
check('models 是字符串数组', E({ models: ['claude-3'] }), [{ id: 'claude-3' }]);
check('顶层就是数组', E([{ id: 'x' }]), [{ id: 'x' }]);

console.log('\n[4] 异常/空值不能抛错, 一律返回空数组');
check('null', E(null), []);
check('undefined', E(undefined), []);
check('字符串', E('nope'), []);
check('数字', E(123), []);
check('空对象', E({}), []);
check('没有 data/models 字段', E({ foo: 1 }), []);
check('data 是对象不是数组', E({ data: { id: 'x' } }), []);
check('条目缺 id', E({ data: [{ object: 'model' }, {}] }), []);
check('条目 id 是空串', E({ data: [{ id: '   ' }] }), []);
check('条目是 null', E({ data: [null, { id: 'ok' }] }), [{ id: 'ok' }]);
check('id 是数字也能用', E({ data: [{ id: 42 }] }), [{ id: '42' }]);
check('前后空白被 trim', E({ data: [{ id: '  spaced  ' }] }), [{ id: 'spaced' }]);
check('model 字段兜底', E({ data: [{ model: 'from-model-field' }] }), [{ id: 'from-model-field' }]);

// ---------------------------------------------------------------- suggestAlias
console.log('\n[5] 别名规范: 平台名 + 模型 ID');
check('常规拼接', S('sensenova', 'glm-5.2'), 'sensenova-glm-5.2');
check('统一小写', S('SenseNova', 'GLM-5.2'), 'sensenova-glm-5.2');
check('平台名带点/斜杠 -> 压成连字符', S('my.relay/v2', 'gpt-4o'), 'my-relay-v2-gpt-4o');
check('模型名里的点保留', S('zhipu', 'glm-4.6'), 'zhipu-glm-4.6');
check('模型名里的斜杠压成连字符', S('openai', 'ft:gpt-4o:acme'), 'openai-ft-gpt-4o-acme');
check('平台名前后分隔符被去掉', S('-relay-', 'gpt-4o'), 'relay-gpt-4o');
check('平台名为空 -> 只有模型名', S('', 'glm-5.2'), 'glm-5.2');
check('模型 ID 为空 -> 只有平台名', S('relay', ''), 'relay');
check('两者都空 -> 空串', S('', ''), '');
check('null 入参不抛错', S(null, null), '');

console.log(`\n=== 结果: ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
