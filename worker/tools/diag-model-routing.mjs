/**
 * 诊断: 某个模型名会被路由到哪个平台 / 落到哪个账号 / 打到哪个 URL。
 *
 * 目的: 用户说「发 glm 就跑到智谱、发 kimi 就跑到 kimi 那边」，要的是
 * **走我自己配的中转账号**。这个脚本把「模型名 → 平台 → 账号 → 最终 URL」
 * 的完整链路摊开。
 *
 * 2026-09 起路由规则改了, 本脚本同步为**当前真实优先级**:
 *   1. 分组「模型 → 平台」重定向表
 *   2. 分组 platform 配置
 *   3. 用户级平台白名单(单值)
 *   4. **自动发现**: 模型名出现在哪个账号的 model_index / 别名表里 -> 用那个平台
 *   5. 路径特征兜底
 *   —— 已**不再**按模型名推断平台(glm->zhipu 之类的魔法已移除)。
 *
 * 用法: node tools/diag-model-routing.mjs [模型名...]
 */
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const models = process.argv.slice(2).filter((a) => !a.startsWith('--'));
if (!models.length) models.push('glm-5.2', 'kimi-k3', 'deepseek-v4-pro', 'Deepseek-v4-flash', 'glm-4.6');

const wrangler = join(root, 'node_modules', 'wrangler', 'bin', 'wrangler.js');
const remote = !process.argv.includes('--local');

function d1(sql) {
  const args = [wrangler, 'd1', 'execute', 'sub2api', remote ? '--remote' : '--local', '--json', '--command', sql];
  if (remote) args.push('-y');
  const out = execFileSync(process.execPath, args, {
    cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, HTTP_PROXY: '', HTTPS_PROXY: '', http_proxy: '', https_proxy: '' },
  });
  // wrangler 前面可能有 banner, 从第一个 '[' 开始截
  const i = out.indexOf('[');
  return JSON.parse(i >= 0 ? out.slice(i) : out);
}

console.log(`=== ${remote ? '生产' : '本地'} 路由诊断 ===\n`);

// 1. 账号 (含 model_index —— 自动路由的事实依据)
let accts;
try {
  accts = d1(`SELECT id,name,platform,base_url,status,schedulable,extra,model_index FROM accounts WHERE deleted_at IS NULL ORDER BY id`)[0].results;
} catch (e) {
  if (!/model_index/.test(String(e.message))) throw e;
  console.log('⚠️  accounts.model_index 列还不存在, 请先执行迁移 (schema/migrations)。');
  accts = d1(`SELECT id,name,platform,base_url,status,schedulable,extra FROM accounts WHERE deleted_at IS NULL ORDER BY id`)[0].results;
  for (const a of accts) a.model_index = null;
}
console.log('账号清单:');
for (const a of accts) {
  const eff = (a.base_url || '').trim() || `(空 -> 官方默认域名)`;
  console.log(`  #${a.id} ${a.name}  平台=${a.platform}  状态=${a.status} schedulable=${a.schedulable}`);
  console.log(`       生效URL=${eff}`);
  let idx = [];
  try { idx = a.model_index ? JSON.parse(a.model_index) : []; } catch { idx = []; }
  if (!Array.isArray(idx)) idx = [];
  if (idx.length) {
    const preview = idx.slice(0, 8).join(', ');
    console.log(`       模型索引(${idx.length})=${preview}${idx.length > 8 ? ', …' : ''}`);
  } else {
    console.log(`       模型索引(0)=(空 —— 去后台「模型获取」跑一次, 新模型就能自动路由)`);
  }
}
console.log('');

/** 由账号表构建「模型名(小写) → 平台」索引, 与 gateway.buildAutoDiscoverIndex 同规则 */
function buildAutoDiscoverIndex(accounts) {
  const idx = new Map();
  const ordered = [...accounts].sort((a, b) => a.id - b.id);
  for (const acc of ordered) {
    const platform = String(acc.platform ?? '').trim();
    if (!platform) continue;
    let list = [];
    try { list = acc.model_index ? JSON.parse(acc.model_index) : []; } catch { list = []; }
    if (!Array.isArray(list)) list = [];
    const names = list.map((m) => String(m ?? '').trim()).filter(Boolean);
    // 别名表的键也算对外名
    try {
      const extra = acc.extra ? JSON.parse(acc.extra) : null;
      const al = extra?.model_aliases;
      if (al && typeof al === 'object' && !Array.isArray(al)) {
        for (const k of Object.keys(al)) { const n = String(k ?? '').trim(); if (n) names.push(n); }
      }
    } catch { /* ignore */ }
    for (const n of names) {
      const k = n.toLowerCase();
      if (!idx.has(k)) idx.set(k, platform);
    }
  }
  return idx;
}

const discover = buildAutoDiscoverIndex(accts);

// 2. 分组路由表
const groups = d1(`SELECT id,name,platform,model_platform_routing,model_allowlist,model_routing,model_routing_enabled FROM groups WHERE deleted_at IS NULL`)[0].results;
console.log('分组路由配置:');
for (const g of groups) {
  console.log(`  #${g.id} ${g.name}`);
  console.log(`      分组平台=${JSON.stringify(g.platform)}`);
  console.log(`      模型→平台重定向=${g.model_platform_routing || '(空)'}`);
  console.log(`      模型白名单=${g.model_allowlist || '(空=不限)'}`);
  console.log(`      全局改名表=${g.model_routing || '(空)'} enabled=${g.model_routing_enabled}`);
}
console.log('');

// 3. 官方默认域名表(用于判断"是不是跑官方去了")
const DEFAULT_BASE_URLS = {
  anthropic: 'https://api.anthropic.com',
  openai: 'https://api.openai.com',
  deepseek: 'https://api.deepseek.com',
  gemini: 'https://generativelanguage.googleapis.com',
  zhipu: 'https://open.bigmodel.cn/api/paas/v4',
  kimi: 'https://api.moonshot.cn',
  minimax: 'https://api.minimax.chat',
  grok: 'https://api.x.ai',
};

function inferPlatform(model) {
  const m = model.toLowerCase();
  if (m.startsWith('claude') || m.includes('anthropic')) return 'anthropic';
  if (m.startsWith('gemini') || m.startsWith('models/gemini')) return 'gemini';
  if (m.startsWith('grok')) return 'grok';
  if (m.startsWith('deepseek') || m.includes('deepseek')) return 'deepseek';
  if (m.startsWith('moonshot') || m.startsWith('kimi')) return 'kimi';
  if (m.startsWith('glm') || m.startsWith('zhipu')) return 'zhipu';
  if (m.startsWith('minimax') || m.startsWith('abab')) return 'minimax';
  if (/^(gpt-|gpt$|o[1-9](-|$)|chatgpt|davinci|text-|dall-e|whisper|tts-)/.test(m) || m.includes('openai')) return 'openai';
  return null;
}

console.log('模型 -> 平台(按当前规则) -> 可用账号 -> 最终URL:');
console.log('-'.repeat(96));
for (const model of models) {
  console.log(`\n模型: ${model}`);

  // 分组路由表里有没有显式配置 (优先级最高)
  let routed = null;
  for (const g of groups) {
    if (!g.model_platform_routing) continue;
    try {
      const t = JSON.parse(g.model_platform_routing);
      if (t[model] !== undefined) { routed = t[model]; break; }
      const lower = model.toLowerCase();
      for (const k of Object.keys(t)) if (k.toLowerCase() === lower) { routed = t[k]; break; }
    } catch { /* ignore */ }
  }
  console.log(`  ① 分组重定向表 = ${routed === null ? '无' : JSON.stringify(routed)}`);

  const groupPlat = (groups[0]?.platform ?? '').trim();
  console.log(`  ② 分组 platform = ${groupPlat || '(空)'}`);

  const discovered = discover.get(model.toLowerCase()) ?? null;
  console.log(`  ③ 自动发现(账号模型索引) = ${discovered ?? '(索引里没有)'}`);

  const target = routed
    ? (typeof routed === 'string' ? routed : String(routed.platform ?? ''))
    : groupPlat || discovered || 'openai (路径兜底)';
  console.log(`  → 最终选号平台 = ${target}`);

  const cand = accts.filter((a) => a.platform === target && a.status === 'active' && a.schedulable);
  if (cand.length) {
    for (const a of cand) {
      const url = (a.base_url || '').trim() || DEFAULT_BASE_URLS[a.platform] || '(无默认域名)';
      const isOfficial = !a.base_url || Object.values(DEFAULT_BASE_URLS).some((d) => url.startsWith(d));
      console.log(`     账号 #${a.id} ${a.name} -> ${url} ${isOfficial ? '⚠️ 官方域名' : '✅ 第三方中转'}`);
    }
  } else {
    console.log(`     ⚠️ 没有 ${target} 平台的可用账号 -> 503 no_upstream_account`);
    const anyAcct = accts.filter((a) => a.status === 'active' && a.schedulable);
    if (anyAcct.length) {
      console.log(`     现有可能对上的平台: ${[...new Set(anyAcct.map((a) => a.platform))].join(', ')}`);
      console.log(`     修法: 去对应账号跑一次「模型获取」(写入索引), 或在该分组的`);
      console.log(`           「模型 → 平台 重定向」里显式指定 "${model}" 的目标平台。`);
    }
  }
}
console.log('');
