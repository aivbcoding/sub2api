/**
 * 给现存账号补 `model_index` —— 走**真实上游**（等价于后台「模型获取」，只是批量执行）。
 *
 * 为什么需要: 2026-09 移除「按模型名猜平台」后, 之前靠名字推断才能选到账号的模型
 * (典型: `Deepseek-v4-flash` 靠 `deepseek*` 前缀命中 platform=deepseek 的账号)
 * 会因为索引为空而掉到路径兜底 -> 503。
 *
 * 做法: 直接向每个自定义上游发 `GET /v1/models`, 把真实返回的模型 ID 写进
 * `accounts.model_index` —— 与 `admin-api.ts::persistModelIndex()` 完全一致。
 *
 * 用法: node tools/seed-model-index.mjs [--dry]
 */
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const dry = process.argv.includes('--dry');
const wrangler = join(root, 'node_modules', 'wrangler', 'bin', 'wrangler.js');

const CLEAN_ENV = {
  ...process.env, HTTP_PROXY: '', HTTPS_PROXY: '', http_proxy: '', https_proxy: '',
};

function d1(sql) {
  const args = [wrangler, 'd1', 'execute', 'sub2api', '--remote', '--json', '--command', sql, '-y'];
  const out = execFileSync(process.execPath, args, {
    cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: CLEAN_ENV,
  });
  const i = out.indexOf('[');
  return JSON.parse(i >= 0 ? out.slice(i) : out);
}

function sqlEsc(s) {
  return String(s).replace(/'/g, "''");
}

/** 从各种上游返回体里抽模型 ID（与 admin-api.ts::extractModelIds 同规则） */
function extractModelIds(payload) {
  let list = null;
  if (Array.isArray(payload)) list = payload;
  else if (payload && typeof payload === 'object') {
    const o = payload;
    if (Array.isArray(o.data)) list = o.data;
    else if (Array.isArray(o.models)) list = o.models;
  }
  if (!list) return [];
  const out = [];
  const seen = new Set();
  for (const item of list) {
    let id = '';
    if (typeof item === 'string') id = item.trim();
    else if (item && typeof item === 'object') {
      const cand = item.id ?? item.name ?? item.model ?? '';
      id = String(cand).trim().replace(/^models\//, '').replace(/^\/+/, '');
    }
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out.sort((a, b) => a.localeCompare(b));
}

/** 上游 base_url 只到版本根, /v1/models 由这里补 */
function modelsUrl(baseUrl) {
  const b = String(baseUrl || '').trim().replace(/\/+$/, '');
  if (!b) return '';
  // 已有 /v1 结尾就不再叠加
  if (/\/v1$/i.test(b)) return `${b}/models`;
  return `${b}/v1/models`;
}

const rows = d1(
  `SELECT id,name,platform,base_url,credentials,deleted_at FROM accounts WHERE deleted_at IS NULL ORDER BY id`,
)[0].results;

console.log('账号模型索引补录 (走真实上游 GET /v1/models)\n');
console.log('id  platform      base_url                                结果');
console.log('-'.repeat(96));

const updates = [];
for (const a of rows) {
  const base = String(a.base_url || '').trim();
  if (!base) {
    console.log(`${String(a.id).padEnd(3)} ${String(a.platform).padEnd(13)} ${'(空=官方默认)'.padEnd(40)} SKIP 无自定义上游, 保持官方`);
    continue;
  }
  let cred = {};
  try { cred = JSON.parse(a.credentials || '{}'); } catch { cred = {}; }
  const key = cred.api_key || cred.apiKey || cred.key || '';

  const url = modelsUrl(base);
  let ids = [];
  let note = '';
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: key ? { Authorization: `Bearer ${key}` } : {},
      signal: AbortSignal.timeout(20000),
    });
    const text = await res.text().catch(() => '');
    if (!res.ok) {
      note = `HTTP ${res.status} (该上游未实现 GET /v1/models)`;
    } else {
      let payload = null;
      try { payload = JSON.parse(text); } catch { payload = null; }
      ids = extractModelIds(payload);
      note = ids.length ? `${ids.length} 个模型` : '返回体无可识别模型列表';
    }
  } catch (e) {
    note = `ERR ${e.message}`;
  }

  console.log(`${String(a.id).padEnd(3)} ${String(a.platform).padEnd(13)} ${base.slice(0, 40).padEnd(40)} ${note}`);
  if (ids.length) {
    console.log(`     -> ${ids.slice(0, 12).join(', ')}${ids.length > 12 ? `, …(+${ids.length - 12})` : ''}`);
    updates.push({ id: a.id, ids });
  }
}

if (dry) {
  console.log('\n--dry 模式, 未写入。');
  process.exit(0);
}

console.log('\n写入 model_index:');
for (const u of updates) {
  const json = JSON.stringify(u.ids);
  const r = d1(`UPDATE accounts SET model_index = '${sqlEsc(json)}' WHERE id = ${u.id}`);
  console.log(`  #${u.id} -> ${u.ids.length} 条  ${r[0]?.success ? 'OK' : 'FAIL'}`);
}
if (updates.length === 0) console.log('  (无可写入的账号 —— 上游均未提供模型列表)');
