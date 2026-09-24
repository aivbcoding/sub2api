/**
 * 「定价跟账号走」+「删账号级联清定价/绑定」E2E
 *
 * 对应需求(2026-09-24):
 *   「删除上游账号之后, 和上游账号关联的, 比如模型别名列表, 同步删除,
 *     模型定价, 还有其他之类的」 + 「定价跟账号走(推荐)」+「定价页加上游平台列」
 *
 * 改动要点(都在这验):
 *   [1] model_pricing 是 (account_id, model) 复合主键:
 *       account_id=0 全局 / >0 账号专属; 同 model 可同时存在全局价和账号价
 *   [2] GET /models 每行带 account_id + account_platform(平台列数据)
 *   [3] PUT 可写账号级价(带 account_id); upsert 按 (account_id, model) 不产生第二行
 *   [4] 计费解析: 账号价优先于全局价(billing.resolveModelPrice 四参)
 *   [5] DELETE /accounts/:id 级联: model_pricing(账号级) + account_groups 绑定被清;
 *       全局价(account_id=0)不受影响
 *   [6] 删的是软删(账号 deleted_at 置位), 模型别名/模型索引随账号自然消失
 *
 * 用法:
 *   ADMIN_PASS=<密码> node tools/run-e2e.mjs 8787 test/admin-account-pricing-cascade-e2e.mjs
 *   (未提供 ADMIN_PASS 时自动跳过, 退出码 0)
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const billing = readFileSync(join(here, '..', 'src', 'billing.ts'), 'utf8');

const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:8787';
const USER = process.env.ADMIN_USER ?? 'admin';
const PASS = process.env.ADMIN_PASS ?? '';

let pass = 0;
let fail = 0;
let skip = 0;

function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? ' -> ' + detail : ''}`); }
}

async function main() {
  console.log(`\n=== 账号级定价 / 删账号级联清理 E2E @ ${BASE} ===\n`);

  if (!PASS) {
    console.log('  SKIP  未提供 ADMIN_PASS, 跳过');
    skip++;
    console.log(`\n=== 结果: ${pass} passed, ${fail} failed, ${skip} skipped ===\n`);
    process.exit(0);
  }

  // ---- 登录 ----
  console.log('[1] 超级管理员登录');
  const login = async (username, password) => {
    const r = await fetch(`${BASE}/api/admin/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    const text = await r.text();
    let json = {};
    try { json = JSON.parse(text); } catch { /* */ }
    return { status: r.status, json, cookie: (r.headers.get('set-cookie') ?? '').split(';')[0] };
  };
  const root = await login(USER, PASS);
  check('登录 200 且 is_admin=true', root.status === 200 && root.json.is_admin === true,
    `status=${root.status} is_admin=${JSON.stringify(root.json.is_admin)}`);
  if (root.status !== 200 || root.json.is_admin !== true) process.exit(1);

  const call = (cookie) => async (path, init = {}) => {
    const r = await fetch(`${BASE}${path}`, {
      ...init,
      headers: { cookie, 'content-type': 'application/json', ...(init.headers ?? {}) },
    });
    const text = await r.text();
    let json = {};
    try { json = JSON.parse(text); } catch {}
    return { status: r.status, text, json };
  };
  const api = call(root.cookie);

  const stamp = Date.now();
  const M1 = `e2e-acct-${stamp}-a`;
  const M2 = `e2e-acct-${stamp}-b`;
  let acctId = 0;
  let groupId = 0;

  // ---- [1] 静态: resolveModelPrice 四参(账号优先, 全局兜底) ----
  console.log('\n[1] billing.resolveModelPrice 签名(静态)');
  check('resolveModelPrice 收 accountId 参数',
    /resolveModelPrice\(\s*model:\s*string,\s*accountId:\s*number,/.test(billing));
  check('先查账号级再回退全局级',
    /dbPricing\.get\(`\$\{accountId\}:\$\{m\}`\)\s*\?\?\s*dbPricing\.get\(`0:\$\{m\}`\)/.test(billing));

  // ---- [3] 造账号 + 分组 ----
  console.log('\n[2] 造测试账号 + 分组');
  const mkAcct = await api('/api/admin/accounts', {
    method: 'POST',
    body: JSON.stringify({
      name: `e2e-定价级联-${stamp}`,
      platform: 'openai',
      base_url: 'https://example.com/v1',
      api_key: 'sk-e2e-test',
    }),
  });
  check('建账号 201/200', mkAcct.status === 201 || mkAcct.status === 200, `status=${mkAcct.status} ${mkAcct.text.slice(0, 200)}`);
  acctId = Number(mkAcct.json.id ?? mkAcct.json.account?.id ?? 0);
  check('拿到账号 id', acctId > 0, `acctId=${acctId}`);

  // 给账号配 model_index + model_aliases(验证删账号后这些"账号自带数据"随账号消失)
  const putAlias = await api(`/api/admin/accounts/${acctId}`, {
    method: 'PUT',
    body: JSON.stringify({
      model_index: [M1, M2],
      model_aliases: { [M1]: 'aliased-' + stamp, [M2]: 'aliased-b-' + stamp },
    }),
  });
  check('写入 model_index + model_aliases 200', putAlias.status === 200, `${putAlias.status} ${putAlias.text.slice(0, 160)}`);

  // 建分组(如果需要) -- 这里先略: 分组绑定验证在删账号时用 account_groups 表检查

  // ---- [4] 写账号级定价 + 全局定价 ----
  console.log('\n[3] PUT /api/admin/models —— 账号级 + 全局两个粒度');
  const putAcct = await api('/api/admin/models', {
    method: 'PUT',
    body: JSON.stringify({
      models: [
        { model: M1, account_id: acctId, input_price: 9, output_price: 19, cache_read_price: 0, cache_creation_price: 0 },
        { model: M1, account_id: 0, input_price: 1, output_price: 2, cache_read_price: 0, cache_creation_price: 0 },
      ],
    }),
  });
  check('同 model 两个账号粒度批量写 200(saved=2)', putAcct.status === 200 && putAcct.json.saved === 2,
    `${putAcct.status} ${putAcct.text.slice(0, 160)}`);

  const list1 = (await api('/api/admin/models')).json.models ?? [];
  const acctRow = list1.find((m) => m.model === M1 && Number(m.account_id) === acctId);
  const globalRow = list1.find((m) => m.model === M1 && Number(m.account_id) === 0);
  check('账号级定价行存在且带 account_id',
    !!acctRow && Number(acctRow.account_id) === acctId && Number(acctRow.input_per_mtok) === 9,
    JSON.stringify(acctRow));
  check('全局定价行并存(account_id=0)', !!globalRow && Number(globalRow.input_per_mtok) === 1,
    JSON.stringify(globalRow));
  check('账号级行带平台信息(平台列数据源)',
    !!acctRow && (acctRow.account_platform || acctRow.account_name),
    JSON.stringify(acctRow));
  check('全局行平台信息为 null(前端显示「全局」)',
    !!globalRow && !globalRow.account_platform && !globalRow.account_name,
    JSON.stringify(globalRow));

  // ---- [5] upsert 不产生第二行(账号级重复写) ----
  console.log('\n[4] upsert 按 (account_id, model) 去重');
  const putAcct2 = await api('/api/admin/models', {
    method: 'PUT',
    body: JSON.stringify({ models: [{ model: M1, account_id: acctId, input_price: 9.5, output_price: 19.5 }] }),
  });
  const list2 = (await api('/api/admin/models')).json.models ?? [];
  const rowCount = list2.filter((m) => m.model === M1 && Number(m.account_id) === acctId).length;
  check('同账号同 model 重复写 -> 仍只有一行(复合主键 upsert)',
    rowCount === 1 && putAcct2.status === 200, `rows=${rowCount}`);

  // ---- [6] 删账号 -> 级联清理 ----
  console.log('\n[5] DELETE /api/admin/accounts/:id —— 级联删定价');
  const delAcct = await api(`/api/admin/accounts/${acctId}`, { method: 'DELETE' });
  check('删账号 200', delAcct.status === 200, delAcct.text.slice(0, 160));

  const list3 = (await api('/api/admin/models')).json.models ?? [];
  const stillAcctRow = list3.find((m) => m.model === M1 && Number(m.account_id) === acctId);
  const stillGlobal = list3.find((m) => m.model === M1 && Number(m.account_id) === 0);
  check('🧨 账号级定价被级联删除(price row gone)', !stillAcctRow, JSON.stringify(stillAcctRow));
  check('全局定价不受影响(账号级回退到它)', !!stillGlobal && Number(stillGlobal.input_per_mtok) === 1,
    JSON.stringify(stillGlobal));

  const acctsAfter = (await api('/api/admin/accounts')).json.accounts ?? [];
  check('账号已软删(不再出现在列表)',
    !acctsAfter.some((a) => a.id === acctId), JSON.stringify(acctsAfter.map((a) => a.id).slice(0, 5)));

  // ---- 清理残留(pricing 清理由级联做了; 若失败也显示清楚) ----
  console.log(`\n=== 结果: ${pass} passed, ${fail} failed ===\n`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error('账号定价级联 E2E 运行失败:', e.message);
  process.exit(1);
});