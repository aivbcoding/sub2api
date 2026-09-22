#!/usr/bin/env node
/**
 * 「/v1/models 必须跟着上游账号绑定走」静态守卫。
 *
 * 用户报告(2026-09-21):
 *   Key 用默认组 default, 上游账号变了之后, /v1/models 还是旧数据。
 *
 * 根因是三条**绕过分组约束**的补模型路径:
 *   A. buildLocalModelsForPlatforms 只按 platform 全库捞账号, 不看 account_groups
 *      ⇒ 从 default 组解绑的账号, 它的 model_index 照样进来。
 *   B. buildLocalModels 无条件并入全局 model_pricing
 *      ⇒ 账号全挂时列表退化成"定价表里配过的所有模型"。
 *   C. jsonModels 发 `public, max-age=60`
 *      ⇒ 改完绑定还要等一分钟才变, 看起来就没实时更新。
 *
 * 第二轮报告(2026-09-21, 同一天):
 *   "上游账号新增之后, 设置分组, key在所属分组, 就应该能获取到当前分组下,
 *    所有上游账号的所有 model 集合"
 * 又挖出三个让"绑了却看不到"的缺陷:
 *   D. 主循环用 loadCandidateAccounts(带 isSchedulable) ⇒ 刚被 429 冷却的账号
 *      被整个剔掉, 它声明的模型凭空消失。冷却只代表"暂时不接流量", 不代表
 *      "不声明模型"。
 *   E. 主循环只读 `model_index`, 不看 `extra.model_aliases` 的键 ⇒ 线上账号
 *      普遍只有别名表、没有索引列, 于是绑定改了列表纹丝不动。
 *   F. 跳过上游的判断用 `collected.size`(全局累计), 前面平台拿到过模型就会
 *      让后面还没收集到的平台也跳过实拉 ⇒ 漏平台。
 *
 * 本守卫逐条钉住这六处, 防止哪天又被"修回去"。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const src = readFileSync(join(root, 'src', 'models.ts'), 'utf8');

let pass = 0;
let fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? ' -> ' + detail : ''}`); }
};

/** 取出某个顶层函数的函数体(按大括号配平, 够用) */
function fnBody(name) {
  const start = src.indexOf(`function ${name}(`);
  if (start < 0) return '';
  const braceAt = src.indexOf('{', start);
  if (braceAt < 0) return '';
  let depth = 0;
  for (let i = braceAt; i < src.length; i++) {
    const c = src[i];
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return src.slice(braceAt, i + 1);
    }
  }
  return '';
}

console.log('\n=== /v1/models 分组一致性 守卫 ===\n');

// ---- [1] 三条补模型路径都必须看分组 ----
console.log('[1] 绕过分组的补模型路径已封堵');
{
  const b = fnBody('buildLocalModelsForPlatforms');
  check('找到 buildLocalModelsForPlatforms', b.length > 0);
  check('它收了 groupId 参数', /groupId\s*:\s*number\s*\|\s*null/.test(src.slice(src.indexOf('async function buildLocalModelsForPlatforms'), src.indexOf('async function buildLocalModelsForPlatforms') + 400)));
  check('兜底查询 JOIN account_groups(不再全库按 platform 捞)', /JOIN\s+account_groups/i.test(b));
  check('兜底按 ag.group_id 绑定过滤', /ag\.group_id\s*=\s*\?1/i.test(b));
  check('兜底仍过滤软删除账号', /a\.deleted_at\s+IS\s+NULL/i.test(b));
  check('兜底仍只取 active 账号', /a\.status\s*=\s*'active'/i.test(b));
  check('groupId 为 null 时直接返回空(没挂分组就不给账号维度兜底)', /if\s*\(\s*groupId\s*===\s*null\s*\)\s*return\s*\[\]/.test(b));
}

// ---- [2] 全局定价表不再无条件并入 ----
console.log('\n[2] 全局定价表只在没有分组信号时兜底');
{
  const b = fnBody('buildLocalModels');
  check('找到 buildLocalModels', b.length > 0);
  check('有分组信号时才跳过全局定价表', /hasGroupSignal/.test(b));
  check('通过 allowlist + groupModelPricing 判定分组信号',
    /allowlist\.length\s*>\s*0/.test(b) && /groupModelPricing/.test(b));
  check('全局 model_pricing 查询被条件包裹',
    /if\s*\(\s*!hasGroupSignal\s*\)/.test(b) && /SELECT model FROM model_pricing/.test(b));
}

// ---- [3] 候选账号只认本分组(但不看冷却) ----
console.log('\n[3] 候选账号来自本分组, 且不受 429 冷却影响');
{
  // loadGroupAccounts 自己就是分组 JOIN, 不带 isSchedulable
  const b = fnBody('loadGroupAccounts');
  check('找到 loadGroupAccounts', b.length > 0);
  check('它 JOIN account_groups', /JOIN\s+account_groups/i.test(b));
  check('它按 ag.group_id 过滤', /ag\.group_id\s*=\s*\?1/i.test(b));
  check('它过滤软删除账号', /a\.deleted_at\s+IS\s+NULL/i.test(b));
  check('它只取 active 账号', /a\.status\s*=\s*'active'/i.test(b));
  check('它**不**做 isSchedulable 过滤(429 冷却账号也要贡献模型)',
    !/isSchedulable/.test(b));

  // scheduler 侧的 loadCandidateAccounts 仍带 isSchedulable(转发路径要它)
  const sched = readFileSync(join(root, 'src', 'scheduler.ts'), 'utf8');
  check('loadCandidateAccounts(转发路径)仍走 isSchedulable',
    /export async function loadCandidateAccounts[\s\S]{0,300}isSchedulable/.test(sched));

  // models.ts 主循环换用 loadGroupAccounts
  const loop = src.slice(src.indexOf('for (const platform of platforms)'), src.indexOf('upstream 模式: 有原生响应就直接透传'));
  check('主循环用 loadGroupAccounts(分组 + 不看冷却)', /loadGroupAccounts\(env,\s*ctx\.groupId,\s*platform\)/.test(loop));
  // 只看"调用", 不看注释里提到旧函数名
  check('主循环不再调用 loadCandidateAccounts', !/\bloadCandidateAccounts\s*\(/.test(loop.replace(/\/\/[^\n]*/g, '')));
  check('主循环不再有"全库按 platform 查账号"的兜底', !/SELECT\s+platform,\s*model_index[\s\S]{0,200}WHERE\s+deleted_at\s+IS\s+NULL\s+AND\s+status/i.test(loop));
}

// ---- [3b] 模型名口径 = model_index ∪ 别名表键 ----
console.log('\n[3b] 账号声明的模型 = model_index + 别名表键');
{
  const b = fnBody('accountDeclaredModels');
  check('找到 accountDeclaredModels', b.length > 0);
  check('它读 model_index', /readModelIndex\(account\)/.test(b));
  check('它也读别名表键', /readAliasKeys\(account\)/.test(b));

  const a = fnBody('readAliasKeys');
  check('找到 readAliasKeys', a.length > 0);
  check('它只取 model_aliases 的键(值不算对外名)',
    /model_aliases/.test(a) && /Object\.keys\(/.test(a));
  check('它容错 JSON 字符串 extra', /JSON\.parse\(/.test(a));
  check('它容错坏 extra 不抛', /catch/.test(a));

  const loop = src.slice(src.indexOf('for (const platform of platforms)'), src.indexOf('upstream 模式: 有原生响应就直接透传'));
  check('主循环用 accountDeclaredModels 收集(不是只读 readModelIndex)',
    /accountDeclaredModels\(account\)/.test(loop));
  check('主循环按 indexHit 判定是否实拉上游(不是 collected.size)',
    /indexHit/.test(loop));
}

// ---- [4] 不再发 60 秒缓存 ----
console.log('\n[4] 列表不再被 HTTP 缓存钉住');
{
  const b = fnBody('jsonModels');
  check('找到 jsonModels', b.length > 0);
  check("发 no-store(改完绑定立即生效)", /cache-control'\s*:\s*'no-store'/.test(b));
  check('不再出现 max-age 缓存', !/max-age/.test(b));
  check('CACHE_TTL_MS 常量已移除', !/CACHE_TTL_MS/.test(src));
}

// ---- [5] 索引命中就不打扰上游(但索引为空要实拉) ----
console.log('\n[5] 索引优先 + 空索引实拉上游');
{
  const loop = src.slice(src.indexOf('for (const platform of platforms)'), src.indexOf('upstream 模式: 有原生响应就直接透传'));
  check('用 accountDeclaredModels 收集该平台声明的模型', /accountDeclaredModels\(account\)/.test(loop));
  check('索引非空且非 upstream 模式时 continue(不打扰上游)',
    /if\s*\(\s*mode\s*!==\s*'upstream'\s*&&\s*indexHit\s*>\s*0\s*\)\s*\{?\s*continue/.test(loop));
  check('空索引时仍实拉上游(避免索引没建就空列表)', /fetchUpstreamModels\(/.test(loop));
}

// ---- [6] 文档说明了这条不变式 ----
console.log('\n[6] 顶部注释写明核心不变式');
{
  check('注明"列表 = 本分组当前绑定账号声明的模型集"',
    /列表\s*=\s*本分组当前绑定的全部账号声明的模型集/.test(src));
  check('注明绕过分组就是 bug', /绕过分组/.test(src) || /不看\s*account_groups/.test(src));
}

console.log(`\n=== 结果: ${pass} passed, ${fail} failed ===\n`);
process.exit(fail ? 1 : 0);
