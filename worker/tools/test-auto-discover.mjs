/**
 * 「新模型自动归到中转」+「按模型名猜平台已彻底关闭」+「别名能精确锁定账号」回归测试
 *
 * 背景 (用户诉求):
 *   我们用**中转上游**(第三方兼容网关)。请求里的 `glm-*` / `kimi-*` 由哪个
 *   平台服务, 取决于账号自己的声明, 不是名字能猜的 —— 旧实现按名字推断
 *   (glm->zhipu, kimi->kimi), 猜出来的平台常常没账号, 结果是
 *   503 no_upstream_account, 报错还误导用户"没配账号"。
 *
 * 现在的规则:
 *   1. 分组「模型 → 平台」重定向表    最高优先
 *   2. 分组 platform 配置
 *   3. 用户级平台白名单(恰好一个)
 *   4. **自动发现** —— 哪个账号的 model_index / 别名表里列了这个模型名,
 *      就路由到那个账号所在的平台 (这样新模型无需任何配置),
 *      并**记住是哪个账号**, 选号时优先落在它上面
 *   5. 路径特征兜底 (/v1beta/ -> gemini, /messages -> anthropic)
 *   6. 兜底默认 openai
 *   —— 全程**不再**看模型名猜平台。
 *
 * 跑法: node tools/test-auto-discover.mjs
 *
 * 实现说明: 从 src/gateway.ts 抠出真实函数体, 用 ts.transpileModule 抹掉类型
 * 后求值 —— 保证测的是**线上那份实现**, 而不是复制品。
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
  const re = new RegExp(`(?:^|\\n)(export\\s+)?function\\s+${name}\\s*\\(`, 'm');
  const m = re.exec(src);
  if (!m) throw new Error(`not found in gateway.ts: ${name}`);
  const start = m.index + (m[0].startsWith('\n') ? 1 : 0);

  let i = src.indexOf('(', start);
  let paren = 0;
  for (; i < src.length; i++) {
    if (src[i] === '(') paren++;
    else if (src[i] === ')') {
      paren--;
      if (paren === 0) { i++; break; }
    }
  }

  const lineEnd = src.indexOf('\n', i);
  const sigLine = src.slice(i, lineEnd < 0 ? src.length : lineEnd);
  const lastBrace = sigLine.lastIndexOf('{');
  const bodyStart = lastBrace >= 0 ? i + lastBrace : src.indexOf('{', i);

  let depth = 0;
  for (let j = bodyStart; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') {
      depth--;
      if (depth === 0) return src.slice(start, j + 1).replace(/^export\s+/, '');
    }
  }
  throw new Error(`unbalanced braces in ${name}`);
}

/** 从源文件里抠出一条模块级常量声明(函数之外还有常量要搬进沙箱) */
function extractConst(name) {
  const re = new RegExp(`^const ${name}\\s*=\\s*[^;]+;`, 'm');
  const m = re.exec(src);
  if (!m) throw new Error(`const not found in gateway.ts: ${name}`);
  return m[0];
}

const tsSource = [
  // 白名单开关: isModelAllowedWithAlias 依赖它, 切片里没有 import 就得原样搬过来
  extractConst('GROUP_ALLOWLIST_ENABLED'),
  extract('lookupModelRoute'),
  extract('resolveModelPlatformRoute'),
  extract('toModelList'),
  extract('accountModelAliases'),
  extract('accountKnownModels'),
  extract('accountServesModel'),
  extract('buildAutoDiscoverIndex'),
  extract('applyAccountAlias'),
  extract('isModelAllowed'),
  extract('isModelAllowedWithAlias'),
  extract('inferPlatform'),
  'export { lookupModelRoute, resolveModelPlatformRoute, toModelList, accountModelAliases, accountKnownModels, accountServesModel, buildAutoDiscoverIndex, applyAccountAlias, isModelAllowed, isModelAllowedWithAlias, inferPlatform };',
].join('\n');

const js = ts.transpileModule(tsSource, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;

const dir = mkdtempSync(join(tmpdir(), 'auto-discover-'));
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

/** 造一个账号行 */
function acct(id, platform, modelIndex, aliases) {
  const extra = aliases ? JSON.stringify({ model_aliases: aliases }) : '{}';
  return {
    id,
    platform,
    model_index: modelIndex === null ? null : JSON.stringify(modelIndex),
    extra,
  };
}

/** 索引里取平台(测试里主要关心平台, 账号 id 单独断言) */
const platOf = (idx, m) => (idx.get(m) ? idx.get(m).platform : undefined);
const acctOf = (idx, m) => (idx.get(m) ? idx.get(m).accountId : undefined);

/** 造一个自动发现索引(Map<model, {platform, accountId}>) */
const D = (...pairs) => new Map(pairs.map(([m, p, id]) => [m, { platform: p, accountId: id }]));

const noCtx = {};

console.log('=== 自动发现索引构建 ===\n');

console.log('[1] model_index 参与索引(新模型自动归到中转的核心)');
{
  const idx = mod.buildAutoDiscoverIndex([
    acct(10, 'sensenova', ['glm-5.2', 'glm-4.6', 'deepseek-v4-pro'], null),
    acct(11, 'chatapi', ['Deepseek-v4-flash'], null),
  ]);
  check('glm-4.6 -> sensenova(无需任何配置)', platOf(idx, 'glm-4.6'), 'sensenova');
  check('glm-5.2 -> sensenova', platOf(idx, 'glm-5.2'), 'sensenova');
  check('Deepseek-v4-flash 小写索引入 key', platOf(idx, 'deepseek-v4-flash'), 'chatapi');
  check('索引里没有的模型', platOf(idx, 'glm-9.9'), undefined);
  check('命中带上声明它的账号 id', acctOf(idx, 'glm-4.6'), 10);
  check('另一条走另一个账号', acctOf(idx, 'deepseek-v4-flash'), 11);
}

console.log('\n[2] 别名表的**键**也算对外名(值不算)');
{
  const idx = mod.buildAutoDiscoverIndex([
    acct(11, 'chatapi', [], { 'my-glm-pro': 'glm-4.6-internal' }),
  ]);
  check('别名键 -> 平台', platOf(idx, 'my-glm-pro'), 'chatapi');
  check('别名的值是对端认识的名字, 不能当对外名参与匹配',
    platOf(idx, 'glm-4.6-internal'), undefined);
  check('别名键命中时能定位到声明它的账号', acctOf(idx, 'my-glm-pro'), 11);
}

console.log('\n[3] 同一模型被多平台声明 -> 命中账号 id 最小的(结果稳定)');
{
  const idx = mod.buildAutoDiscoverIndex([
    acct(20, 'platB', ['shared-model'], null),
    acct(9, 'platA', ['shared-model'], null),
  ]);
  check('取 id 小者', platOf(idx, 'shared-model'), 'platA');
  check('账号 id 也是 id 小者', acctOf(idx, 'shared-model'), 9);
}

console.log('\n[4] 坏数据不能让索引构建炸掉');
{
  const bad = [
    { id: 1, platform: 'p1', model_index: 'not-json{{{', extra: '{}' },
    { id: 2, platform: 'p2', model_index: null, extra: 'not-json' },
    { id: 3, platform: '', model_index: JSON.stringify(['x']), extra: '{}' },
    { id: 4, platform: 'p4', model_index: JSON.stringify(['ok']), extra: '{}' },
  ];
  const idx = mod.buildAutoDiscoverIndex(bad);
  check('坏 model_index 忽略', platOf(idx, 'not-json{{{'), undefined);
  check('空 platform 不建索引', [...idx.values()].some((v) => v.platform === ''), false);
  check('正常账号仍生效', platOf(idx, 'ok'), 'p4');
  check('索引条数', idx.size, 1);
}

console.log('\n=== inferPlatform: 按名字猜平台已关闭 ===\n');

console.log('[5] 没有索引 / 没有配置时, glm-* 不再自动去 zhipu(旧行为已废除)');
{
  // 旧实现: glm-5.2 -> zhipu; 现在应退到路径兜底
  check('glm-5.2 空上下文 -> openai 兜底(绝非 zhipu)',
    mod.inferPlatform(noCtx, '/v1/chat/completions', 'glm-5.2'), 'openai');
  check('kimi-k3 -> openai 兜底(绝非 kimi)',
    mod.inferPlatform(noCtx, '/v1/chat/completions', 'kimi-k3'), 'openai');
  check('claude-x -> 不再按名字推断 anthropic',
    mod.inferPlatform(noCtx, '/v1/chat/completions', 'claude-sonnet-4'), 'openai');
  check('路径是 /messages 时才走 anthropic(路径特征, 与名字无关)',
    mod.inferPlatform(noCtx, '/v1/messages', 'glm-5.2'), 'anthropic');
  check('路径是 /v1beta/ 时才走 gemini',
    mod.inferPlatform(noCtx, '/v1beta/models/gemini-2.0-flash:generateContent', 'gemini-2.0-flash'), 'gemini');
}

console.log('\n[6] 自动发现: 索引命中就路由到该平台(取代按名字猜)');
{
  const d = D(['glm-4.6', 'sensenova', 10], ['kimi-k3', 'chatapi', 11]);
  check('glm-4.6 -> sensenova(事实驱动)',
    mod.inferPlatform(noCtx, '/v1/chat/completions', 'glm-4.6', d), 'sensenova');
  check('大小写不敏感 GLM-4.6',
    mod.inferPlatform(noCtx, '/v1/chat/completions', 'GLM-4.6', d), 'sensenova');
  check('kimi-k3 -> chatapi(哪怕名字像 kimi 官方)',
    mod.inferPlatform(noCtx, '/v1/chat/completions', 'kimi-k3', d), 'chatapi');
  check('索引未命中 -> 路径兜底',
    mod.inferPlatform(noCtx, '/v1/chat/completions', 'unknown-x', d), 'openai');
  check('空索引 -> 路径兜底',
    mod.inferPlatform(noCtx, '/v1/chat/completions', 'glm-4.6', new Map()), 'openai');
}

console.log('\n[7] 优先级: 重定向表 > 分组 > 白名单 > 自动发现 > 路径');
{
  const d = D(['glm-5.2', 'autoPlat', 7]);
  const routed = { groupModelPlatformRouting: { 'glm-5.2': 'routePlat' } };
  check('重定向表压过自动发现',
    mod.inferPlatform(routed, '/v1/chat/completions', 'glm-5.2', d), 'routePlat');

  const grouped = { groupPlatform: 'groupPlat' };
  check('分组平台压过自动发现',
    mod.inferPlatform(grouped, '/v1/chat/completions', 'glm-5.2', d), 'groupPlat');

  const whitelist = { userPlatformAccess: 'onlyPlat' };
  check('单值白名单压过自动发现',
    mod.inferPlatform(whitelist, '/v1/chat/completions', 'glm-5.2', d), 'onlyPlat');

  const d2 = D(['glm-5.2', 'autoPlat', 7]);
  check('无更高优先级时自动发现生效',
    mod.inferPlatform(noCtx, '/v1/chat/completions', 'glm-5.2', d2), 'autoPlat');

  check('路径兜底最后(无索引)',
    mod.inferPlatform(noCtx, '/v1/messages', 'glm-5.2'), 'anthropic');
}

console.log('\n[8] 白名单不能越界: 自动发现也要受用户级白名单约束');
{
  const d = D(['glm-5.2', 'sensenova', 10]);
  const wl = { userPlatformAccess: 'openai,anthropic' };
  check('发现目标不在白名单 -> 退回白名单首个',
    mod.inferPlatform(wl, '/v1/chat/completions', 'glm-5.2', d), 'openai');
  const wl2 = { userPlatformAccess: 'sensenova,openai' };
  check('发现目标在白名单里 -> 用发现结果',
    mod.inferPlatform(wl2, '/v1/chat/completions', 'glm-5.2', d), 'sensenova');
}

console.log('\n[9] 用户换上游后, 空索引是有效状态(清掉旧模型名)');
{
  const idx = mod.buildAutoDiscoverIndex([acct(1, 'p', [], null)]);
  check('空数组不产生条目', idx.size, 0);
  check('索引为空时路径兜底, 不会残留旧模型名指向',
    mod.inferPlatform(noCtx, '/v1/chat/completions', 'glm-5.2', idx), 'openai');
}

console.log('\n=== 别名 → 精确落到声明它的那个账号(本次新增) ===\n');

console.log('[10] 同一平台下挂了多条中转时, 靠别名区分该去哪一条');
{
  // 两个账号平台名相同(常见: 都填 deepseek), 只有 #12 声明了 my-glm-pro
  const accounts = [
    acct(9, 'deepseek', ['Deepseek-v4-flash'], null),
    acct(12, 'deepseek', [], { 'my-glm-pro': 'glm-4.6-internal' }),
  ];
  const idx = mod.buildAutoDiscoverIndex(accounts);

  check('别名键命中的平台', platOf(idx, 'my-glm-pro'), 'deepseek');
  check('★ 别名键能定位到声明它的账号(不是同平台里 id 更小的那个)',
    acctOf(idx, 'my-glm-pro'), 12);
  check('另一个模型仍走另一个账号', acctOf(idx, 'deepseek-v4-flash'), 9);

  // 落到该账号后, 转发时按别名改写成"这个上游认识的名字"
  const pinned = accounts.find((a) => a.id === acctOf(idx, 'my-glm-pro'));
  check('★ 落在声明它的账号上 -> 改写成对端名字',
    mod.applyAccountAlias(pinned, 'my-glm-pro'), 'glm-4.6-internal');

  const other = accounts.find((a) => a.id === 9);
  check('若挑错账号(没有这条别名) -> 不改名, 原样转发',
    mod.applyAccountAlias(other, 'my-glm-pro'), 'my-glm-pro');
}

console.log('\n[11] 别名与 model_index 混用时, 都能带出账号 id');
{
  const accounts = [
    acct(10, 'sensenova', ['glm-5.2'], { 'alias-a': 'real-a' }),
    acct(11, 'chatapi', ['Deepseek-v4-flash'], { 'alias-b': 'real-b' }),
  ];
  const idx = mod.buildAutoDiscoverIndex(accounts);
  check('来自 model_index 的条目带账号', acctOf(idx, 'glm-5.2'), 10);
  check('来自别名的条目带账号', acctOf(idx, 'alias-b'), 11);
  // 索引的 key 是**小写**存的, 大小写不敏感发生在查表那一刻(调用方先 toLowerCase)。
  // 所以"大小写不敏感"要走 inferPlatform 这条真实路径来验证, 不能直接查大写 key。
  check('索引 key 已小写归一', idx.has('ALIAS-B'), false);
  check('大小写不敏感定位(走 inferPlatform 真实路径)',
    mod.inferPlatform(noCtx, '/v1/chat/completions', 'ALIAS-B', idx), 'chatapi');
  check('大小写不敏感定位 -> 仍是同一个账号',
    acctOf(idx, 'ALIAS-B'.toLowerCase()), 11);
  check('accountServesModel: 别名键算"该账号支持"',
    mod.accountServesModel(accounts[1], 'alias-b'), true);
  check('accountServesModel: 别名的值不算',
    mod.accountServesModel(accounts[1], 'real-b'), false);
}

console.log('\n[12] 选号锁账号只对"自动发现决定的平台"生效(显式配置优先)');
{
  // 用户显式配了重定向表 -> 平台被定死, 此时不该用自动发现的账号 id 去锁号
  const d = D(['glm-5.2', 'sensenova', 10]);
  const routed = { groupModelPlatformRouting: { 'glm-5.2': { platform: 'chatapi', model: 'glm-5.2' } } };
  const p = mod.inferPlatform(routed, '/v1/chat/completions', 'glm-5.2', d);
  check('重定向表定死平台', p, 'chatapi');
  // 调用方(gateway)用 hit.platform === platform 才锁账号, 这里两个不等 -> 不锁
  check('hit.platform 与最终平台不一致 -> 调用方不会锁账号',
    d.get('glm-5.2').platform === p, false);
}

console.log('\n[13] 分组白名单已停用: 一律放行(模型能不能用由上游自己判定)');
{
  const wl = ['Deepseek-v4-flash', 'deepseek-v4-pro', 'glm-5.2', 'kimi-k3'];

  // 2026-09-21 起 GROUP_ALLOWLIST_ENABLED = false —— 配了上游就能用。
  // 这一组同时覆盖了曾经的"别名配了却 403"那类坑: 闸门整个没了,
  // 别名 / 大小写变体 / 新模型都不会再被网关拦在门外。
  check('白名单开关已关闭 -> 名单外的模型也放行',
    mod.isModelAllowedWithAlias(wl, 'some-random-model', null), true);
  check('★ 发别名 sensenova-glm-5.2 -> 放行(不再需要归一化比对)',
    mod.isModelAllowedWithAlias(wl, 'sensenova-glm-5.2', 'glm-5.2'), true);
  check('别名值不在白名单 -> 也放行(闸门整个关掉了)',
    mod.isModelAllowedWithAlias(wl, 'sensenova-glm-5.2', 'not-in-list'), true);
  check('非别名命中(outbound=null) -> 放行',
    mod.isModelAllowedWithAlias(wl, 'sensenova-glm-5.2', null), true);
  check('任意大小写变体 -> 放行',
    mod.isModelAllowedWithAlias(wl, 'GLM-5.2', null), true);
  check('空白名单 -> 放行',
    mod.isModelAllowedWithAlias([], 'anything', null), true);

  // 底层 isModelAllowed 的语义仍要保住 —— 哪天把开关改回 true, 行为不能变
  check('(底层) isModelAllowed 精确命中', mod.isModelAllowed(wl, 'glm-5.2'), true);
  check('(底层) isModelAllowed 大小写不敏感', mod.isModelAllowed(wl, 'GLM-5.2'), true);
  check('(底层) isModelAllowed 不在名单 -> false', mod.isModelAllowed(wl, 'nope'), false);

  // outbound 必须来自"声明它的那个账号"的别名表
  const accounts = [
    acct(9, 'deepseek', [], { 'wx-flash': 'Deepseek-v4-flash' }),
    acct(10, 'sensenova', [], { 'sensenova-glm-5.2': 'glm-5.2' }),
  ];
  const idx = mod.buildAutoDiscoverIndex(accounts);
  check('★ 别名条目带出"对端名字"(供白名单归一化)',
    idx.get('sensenova-glm-5.2').outbound, 'glm-5.2');
  check('另一条别名带出它自己的对端名字',
    idx.get('wx-flash').outbound, 'Deepseek-v4-flash');
  check('来自 model_index 的条目没有 outbound',
    mod.buildAutoDiscoverIndex([acct(10, 'sensenova', ['glm-5.2'], null)])
      .get('glm-5.2').outbound, null);
  check('端到端: 发别名 -> 白名单放行 -> 落到 #10 -> 改写成 glm-5.2',
    mod.applyAccountAlias(accounts[1], 'sensenova-glm-5.2'), 'glm-5.2');
}

console.log(`\n=== 结果: ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);
