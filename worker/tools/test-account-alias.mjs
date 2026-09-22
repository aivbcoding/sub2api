/**
 * 账号级模型别名 (extra.model_aliases) 的「入库清洗 + 回显」往返测试
 *
 * 覆盖 admin-api.ts 里两个纯函数:
 *   buildAccountExtra()   —— 请求体 -> extra 列
 *   serializeAccount().model_aliases —— extra 列 -> 回显给编辑弹窗
 *
 * 这样即使没有 ADMIN_PASS(后台 e2e 会自动跳过), 也能证明这条链路没写坏。
 * 跑法: node tools/test-account-alias.mjs
 */
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import ts from 'typescript';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, '..', 'src', 'admin-api.ts'), 'utf8');

function extract(name) {
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

const js = ts.transpileModule(
  extract('buildAccountExtra') + '\n' + extract('mergeAccountAliases') + '\n' +
  'export { buildAccountExtra, mergeAccountAliases };',
  { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } },
).outputText;

const dir = mkdtempSync(join(tmpdir(), 'acct-alias-'));
const file = join(dir, 'slice.mjs');
writeFileSync(file, js);
const mod = await import(pathToFileURL(file).href);

let pass = 0, fail = 0;
function check(name, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { console.log(`  PASS  ${name}`); pass++; }
  else { console.log(`  FAIL  ${name}\n        实际=${a}\n        期望=${e}`); fail++; }
}

const B = mod.buildAccountExtra;
console.log('=== extra.model_aliases 入库清洗 ===\n');

check('正常对象', B({ 'glm-5.2': 'my-glm-pro' }), { model_aliases: { 'glm-5.2': 'my-glm-pro' } });
check('多条', B({ a: 'x', b: 'y' }), { model_aliases: { a: 'x', b: 'y' } });
check('null -> 清空', B(null), {});
check('undefined -> 清空', B(undefined), {});
check('空对象 -> 清空', B({}), {});
check('数组 -> 清空(不是对象)', B(['a']), {});
check('字符串 -> 清空', B('nope'), {});
check('数字 -> 清空', B(42), {});
check('值是空串被丢弃', B({ a: '  ' }), {});
check('键是空串被丢弃', B({ '  ': 'x' }), {});
check('全非法 -> 清空', B({ a: '', ' ': 'x' }), {});
check('混合: 只留合法的', B({ ok: 'v', bad: '', '  ': 'y' }), { model_aliases: { ok: 'v' } });
check('值 trim 后使用', B({ a: '  target  ' }), { model_aliases: { a: 'target' } });
check('键 trim 后使用', B({ '  a  ': 'v' }), { model_aliases: { a: 'v' } });
check('非字符串值被 String() 化', B({ a: 123 }), { model_aliases: { a: '123' } });

// ---------------------------------------------------------------- 合并进 extra
const M = mod.mergeAccountAliases;
console.log('\n=== mergeAccountAliases: 写入 extra(别名表整体替换) ===\n');

check('空 extra + 新别名', M({}, { a: 'x' }), { model_aliases: { a: 'x' } });

// 语义是"整体替换": 请求体里的表就是最终的表。
// 之所以不做按条目合并, 是因为 UI 各入口都是"整表回写", 再合并就永远删不掉东西。
check('传新表 -> 整体替换(旧条目不再保留)', M({ model_aliases: { a: 'x' } }, { b: 'y' }),
  { model_aliases: { b: 'y' } });

check('同名键被新值覆盖', M({ model_aliases: { a: 'old' } }, { a: 'new' }),
  { model_aliases: { a: 'new' } });

// ★ 回归用例: 这条曾经是 bug —— `{...cur, ...{}}` 会保留旧的 model_aliases,
//   导致"删掉最后一条别名"静默失效(库里的旧规则继续生效)。
check('清空别名(null) -> 键被删除', M({ model_aliases: { a: 'x' } }, null), {});
check('清空别名({}) -> 键被删除', M({ model_aliases: { a: 'x' } }, {}), {});
check('清空别名(全非法) -> 键被删除', M({ model_aliases: { a: 'x' } }, { b: '' }), {});

check('清空后不再残留键', Object.prototype.hasOwnProperty.call(M({ model_aliases: { a: 'x' } }, null), 'model_aliases'), false);

check('extra 里的其它键不受影响', M({ foo: 1, model_aliases: { a: 'x' } }, null), { foo: 1 });
check('extra 里的其它键不受影响(有别名时)', M({ foo: 1 }, { a: 'x' }),
  { foo: 1, model_aliases: { a: 'x' } });

check('null extra 入参不抛错', M(null, { a: 'x' }), { model_aliases: { a: 'x' } });
check('undefined extra 入参不抛错', M(undefined, null), {});
check('旧 extra 是数组(脏数据)不把别名弄丢', M(['junk'], { a: 'x' }), { 0: 'junk', model_aliases: { a: 'x' } });

// 多条目表的整体往返 —— 模拟"模型获取"页一次保存 N 条
check('整表回写 N 条', M({ model_aliases: { old: 'v' } }, { a: '1', b: '2', c: '3' }),
  { model_aliases: { a: '1', b: '2', c: '3' } });

console.log(`\n=== 结果: ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);
