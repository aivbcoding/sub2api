#!/usr/bin/env node
/**
 * 「计费只认控制台定价」+「日志/审计删除仅超管」静态守卫。
 *
 * 背景(用户原话, 2026-09-22):
 *   「模型定价菜单, 通过上游可以直接获取上游模型, 并一键设置定价…
 *     api 请求, 花费金额, 严格通过这边的定价进行操作。
 *     操作审计, 新增超级管理员删除功能。
 *     请求日志, 新增超级管理员, 可以删除的功能。」
 *
 * 拆成两条硬不变式:
 *   A. 计费价格来源**只有两处** —— `model_pricing` 表(逐模型) + 定价页的「默认单价」
 *      (存 `settings.model_pricing_default`)。代码里不能再有任何按模型名硬编码的价目表,
 *      也不能再让 `groups.model_pricing` 参与单价计算(分组对价格的影响**只走倍率**)。
 *      这两条很容易被"顺手加个兜底表"改回去, 而且改回去后计费静默偏差、用户看不出来 ——
 *      所以用静态断言钉死。
 *   B. 「请求日志」「操作审计」的批量删除**只有超级管理员**能做(后端硬卡 is_admin,
 *      前端只是藏按钮), 且删除动作本身必须再写一条审计(否则"谁把证据清了"无从查起)。
 *
 * 用法: node tools/test-billing-pricing.mjs   (退出码 0 = 通过)
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const billing = readFileSync(join(root, 'src', 'billing.ts'), 'utf8');
const gateway = readFileSync(join(root, 'src', 'gateway.ts'), 'utf8');
const adminApi = readFileSync(join(root, 'src', 'admin-api.ts'), 'utf8');
const adminUi = readFileSync(join(root, 'src', 'admin-ui.ts'), 'utf8');

let pass = 0;
let fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? ' -> ' + detail : ''}`); }
};

/** 取出某个顶层函数的函数体(按大括号配平, 跳过字符串/注释) */
function fnBody(src, name) {
  const at = src.indexOf(`function ${name}(`);
  if (at < 0) return '';
  const open = src.indexOf('{', at);
  if (open < 0) return '';
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    const n = src[i + 1];
    if (c === '/' && n === '/') { const nl = src.indexOf('\n', i); i = nl < 0 ? src.length : nl; continue; }
    if (c === '/' && n === '*') { const e = src.indexOf('*/', i + 2); i = e < 0 ? src.length : e + 2; continue; }
    if (c === "'" || c === '"' || c === '`') {
      const q = c; i++;
      while (i < src.length && src[i] !== q) { if (src[i] === '\\') i++; i++; }
      continue;
    }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return src.slice(open, i + 1); }
  }
  return '';
}

/** 去掉 // 与 /* *\/ 注释后的源码(反向断言必须先剥注释, 否则会被解释性注释误伤) */
const stripComments = (s) => s
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/[^\n]*$/gm, '');

console.log('\n=== 计费定价 / 超管删除 守卫 ===\n');

// ============================================================
// A. 计费价格来源只有两处
// ============================================================
console.log('[1] 价格来源 = model_pricing 表 → 默认单价(没有第三条)');
check('billing.ts 不再有硬编码价目表 BUILTIN_PRICING', !/BUILTIN_PRICING/.test(billing));
check('billing.ts 不再有 FALLBACK_PRICE 兜底常量', !/FALLBACK_PRICE/.test(billing));
check('有可配置的出厂默认值 DEFAULT_PRICE',
  /export const DEFAULT_PRICE: ModelPrice = \{/.test(billing));
check('默认单价落在 settings 表(键 model_pricing_default)',
  /export const DEFAULT_PRICE_SETTING = 'model_pricing_default'/.test(billing));

const resolveBody = fnBody(billing, 'resolveModelPrice');
check('抠到 resolveModelPrice()', resolveBody.length > 0);
check('resolveModelPrice 只收 (model, dbPricing, defaultPrice) 三个参数',
  /resolveModelPrice\(\s*model:\s*string,\s*dbPricing:\s*Map<string,\s*ModelPrice>,\s*defaultPrice:\s*ModelPrice,?\s*\)/.test(billing));
check('不再收分组价目表参数(groupPricing 已下线)', !/groupPricing/.test(resolveBody));
check('只从 dbPricing 表取值', /dbPricing\.get\(/.test(resolveBody));
check('取不到就返回 defaultPrice(不再有第三级兜底)',
  /return defaultPrice;/.test(resolveBody));
check('去日期后缀再查一次(保留原有兼容行为)', /-\\d\{8\}\$/.test(resolveBody));

const parseBody = fnBody(billing, 'parseDefaultPrice');
check('抠到 parseDefaultPrice()', parseBody.length > 0);
check('坏 JSON 回出厂值(不抛异常)', /catch\s*\{[\s\S]{0,80}?return DEFAULT_PRICE/.test(parseBody));
check('字段级回退(只坏一个字段不整体丢弃)',
  /input_price: num\(o\.input_price, DEFAULT_PRICE\.input_price\)/.test(parseBody));
check('注释写明只有两处来源', /只有这两级/.test(billing) || /两处/.test(billing));
// 控制台前端也不能留这两个已删符号 —— 线上验收(verify-online.mjs)就是拿
// "服务端返回的 HTML 里没有它们"当作"前端已切到可配置定价"的证据(踩过一次假 FAIL)
check('admin-ui.ts 不再引用 BUILTIN_PRICING / FALLBACK_PRICE',
  !/BUILTIN_PRICING/.test(adminUi) && !/FALLBACK_PRICE/.test(adminUi));

// ============================================================
// B. gateway 计费链路接上了默认单价(且不再读分组价目表)
// ============================================================
console.log('\n[2] gateway 计费链路');
const loadDefBody = fnBody(gateway, 'loadDefaultPrice');
check('有 loadDefaultPrice(env)', loadDefBody.length > 0);
check('它从 settings 表读默认单价',
  /FROM settings WHERE key = \?1/.test(loadDefBody) && /DEFAULT_PRICE_SETTING/.test(loadDefBody));
check('读设置失败不抛(计费链路不能被它搞挂)',
  /catch\s*\{\s*return DEFAULT_PRICE;\s*\}/.test(loadDefBody));
check('并行取 dbPricing + defaultPrice',
  /Promise\.all\(\[\s*loadDbPricing\(env\),\s*loadDefaultPrice\(env\),?\s*\]\)/.test(gateway));
check('resolveModelPrice 按三参调用(无分组价目表)',
  /const price = resolveModelPrice\(model, dbPricing, defaultPrice\)/.test(gateway));
check('🧨 不再有 ctx.groupModelPricing 参与单价', !/groupModelPricing/.test(stripComments(gateway)));
check('分组对价格只走倍率(combineRateMultiplier)',
  /combineRateMultiplier\(\s*ctx\.groupRateMultiplier,\s*account\.rate_multiplier,?\s*\)/.test(gateway));
check('金额仍然按 computeTokenBreakdown 算',
  /computeTokenBreakdown\(usage, price, rateMultiplier\)/.test(gateway));

// ============================================================
// C. 定价接口: 默认单价 + 逐模型 + 批量
// ============================================================
console.log('\n[3] /api/admin/models 定价接口');
const pricingBody = fnBody(adminApi, 'handleModelPricing');
check('抠到 handleModelPricing()', pricingBody.length > 1000, 'len=' + pricingBody.length);
check('GET 回 models + default_price + 出厂默认值',
  /default_price: parseDefaultPrice\(rawDefault\)/.test(pricingBody) &&
  /default_price_builtin: DEFAULT_PRICE/.test(pricingBody));
check('PUT 支持 { default_price } 写设置',
  /body\.default_price/.test(pricingBody) && /writeSetting\(env, DEFAULT_PRICE_SETTING/.test(pricingBody));
check('改默认单价会记审计(model_pricing_default)',
  /'update', 'model_pricing_default'/.test(pricingBody));
check('PUT 支持批量 { models: [...] }(一键设置定价)',
  /Array\.isArray\(body\.models\) \? body\.models : \[body\]/.test(pricingBody));
check('批量用 DB.batch 一次提交(不是 N 次往返)', /env\.DB\.batch\(/.test(pricingBody));
check('写入是 upsert(ON CONFLICT(model) DO UPDATE)',
  /ON CONFLICT\(model\) DO UPDATE SET/.test(pricingBody));
check('PUT 用 normalizePricingRow 收敛字段', /\.map\(normalizePricingRow\)/.test(pricingBody));
check('DELETE 支持批量 { models: [...] }', /Array\.isArray\(body\.models\)/.test(pricingBody));
check('改/删定价都记审计(model_pricing)',
  (pricingBody.match(/'model_pricing'/g) || []).length >= 2);
check('单价一律非负(nonNegNumber 收敛)',
  /function normalizePricingRow[\s\S]{0,400}?nonNegNumber\(/.test(adminApi) ||
  /const normalizePricingRow[\s\S]{0,400}?nonNegNumber\(/.test(adminApi));

// ============================================================
// D. 删除日志 / 审计: 超管专属 + 删除动作留痕
// ============================================================
console.log('\n[4] 请求日志 / 操作审计 的删除权限');
// 🚨 批量删除把 id 放在**请求体**里(一次最多 500 条, 查询串装不下)。
//    admin-api 的入口只给 POST/PUT/PATCH 解析 body 时, 这里会静默拿到空对象,
//    表现是"删除永远报 ids is required" —— 所以把 DELETE 也在解析范围里钉住。
check('入口对 DELETE 也解析请求体(否则批量删除永远报 ids is required)',
  /method === 'POST' \|\| method === 'PUT' \|\| method === 'PATCH' \|\| method === 'DELETE'/.test(adminApi));

const usageBody = fnBody(adminApi, 'getUsage');
const auditBody = fnBody(adminApi, 'getAudit');
check('抠到 getUsage() / getAudit()', usageBody.length > 500 && auditBody.length > 500);
check('请求日志删除硬卡 is_admin(403)',
  /if \(!auth\.admin\?\.is_admin\) return forbidden\('usage'\);/.test(usageBody));
check('操作审计删除硬卡 is_admin(403)',
  /if \(!auth\.admin\?\.is_admin\) return forbidden\('audit'\);/.test(auditBody));
check('请求日志走 DELETE FROM usage_logs',
  /DELETE FROM usage_logs WHERE id IN \(/.test(usageBody));
check('操作审计走 DELETE FROM admin_audit_logs',
  /DELETE FROM admin_audit_logs WHERE id IN \(/.test(auditBody));
check('删日志**本身**也写审计(谁把记录清了必须留痕)',
  /auditLog\(\s*env,\s*auth\.admin,\s*'delete',\s*'usage_logs'/.test(usageBody));
check('删审计本身也写审计(链式留痕)',
  /auditLog\(\s*env,\s*auth\.admin,\s*'delete',\s*'admin_audit_logs'/.test(auditBody));
check('两条删除都用占位符拼接(不是字符串拼 SQL)', /ids\.map\(\(_, i\) =>/.test(usageBody) && /ids\.map\(\(_, i\) =>/.test(auditBody));

const parseIdsAt = adminApi.indexOf('function parseIds');
const parseIdsBody = parseIdsAt < 0 ? '' : fnBody(adminApi, 'parseIds');
check('有 parseIds() 收敛请求体里的 id 数组', parseIdsBody.length > 0);
check('parseIds 只收正整数', /Number\.isInteger\(n\)/.test(parseIdsBody) && /n <= 0/.test(parseIdsBody));
check('parseIds 去重(同一个 id 提交两次不会让 meta.changes 虚高)',
  /seen\.has\(n\)/.test(parseIdsBody) && /seen\.add\(n\)/.test(parseIdsBody));
check('parseIds 有硬上限(防一次删太多/构造超大 IN)', /500/.test(parseIdsBody));
check('返回删除条数(前端要回显)', /meta as \{ changes\?: number \}/.test(usageBody));
check('请求日志保留非超管只看自己(selfScoped)', /const selfScoped = !auth\.admin\?\.is_admin;/.test(usageBody));
check('操作审计保留非超管只看自己(scoped)', /const scoped = !auth\.admin\?\.is_admin;/.test(auditBody));

console.log(`\n=== 结果: ${pass} passed, ${fail} failed ===\n`);
process.exit(fail ? 1 : 0);
