/**
 * 操作审计日志分页 E2E
 *
 * 覆盖 GET /api/admin/audit 的 limit / offset / total:
 *   1. 默认值与返回形状 (logs / total / limit / offset)
 *   2. 分页正确性: 页与页之间不重叠, id 严格倒序
 *   3. 越界页返回空数组而不是报错
 *   4. 参数夹取: 超大 limit / 0 / 负数 / 非数字(以前会算出 NaN 直接 500)
 *   5. total 与数据量自洽
 *
 * 用法:
 *   ADMIN_PASS=<密码> node tools/run-e2e.mjs 8787 test/admin-audit-e2e.mjs
 *   (未提供 ADMIN_PASS 时自动跳过, 退出码 0 —— 便于无人值守跑全量)
 */

const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:8787';
const USER = process.env.ADMIN_USER ?? 'admin';
const PASS = process.env.ADMIN_PASS ?? '';

let pass = 0;
let fail = 0;
let skip = 0;

function check(name, cond, detail = '') {
  if (cond) {
    pass++;
    console.log(`  PASS  ${name}`);
  } else {
    fail++;
    console.log(`  FAIL  ${name}${detail ? ' -> ' + detail : ''}`);
  }
}

async function main() {
  console.log(`\n=== 操作审计分页 E2E @ ${BASE} ===\n`);

  if (!PASS) {
    console.log('  SKIP  未提供 ADMIN_PASS, 跳过 (用法: ADMIN_PASS=xxx node tools/run-e2e.mjs 8787 test/admin-audit-e2e.mjs)');
    skip++;
    console.log(`\n=== 结果: ${pass} passed, ${fail} failed, ${skip} skipped ===\n`);
    process.exit(0);
  }

  // ---- 登录 ----
  console.log('[1] 管理员登录');
  const loginRes = await fetch(`${BASE}/api/admin/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: USER, password: PASS }),
  });
  const cookie = (loginRes.headers.get('set-cookie') ?? '').split(';')[0];
  check('登录返回 200', loginRes.status === 200, `status=${loginRes.status}`);
  if (loginRes.status !== 200) {
    console.log(`\n=== 结果: ${pass} passed, ${fail} failed ===\n`);
    process.exit(1);
  }

  const call = async (path, init = {}) => {
    const r = await fetch(`${BASE}${path}`, {
      ...init,
      headers: { cookie, 'content-type': 'application/json', ...(init.headers ?? {}) },
    });
    const text = await r.text();
    let json = {};
    try { json = JSON.parse(text); } catch { /* 非 JSON */ }
    return { status: r.status, text, json };
  };

  // ---- [2] 先造几条审计记录, 保证有东西可分页 ----
  console.log('\n[2] 造审计记录 (增删临时用户, 每次写入都会留痕)');
  const stamp = Date.now();
  const madeIds = [];
  for (let i = 0; i < 3; i++) {
    const r = await call('/api/admin/users', {
      method: 'POST',
      body: JSON.stringify({
        email: `e2e-audit-${stamp}-${i}@local`,
        username: 'e2e审计测试',
        role: 'user',
        status: 'active',
        balance: 0,
        concurrency: 1,
      }),
    });
    if (r.status === 201 && r.json.id) madeIds.push(r.json.id);
  }
  for (const id of madeIds) await call(`/api/admin/users/${id}`, { method: 'DELETE' });
  check('成功写入若干审计记录', madeIds.length === 3, `created=${madeIds.length}`);

  // ---- [3] 默认请求: 形状与默认值 ----
  console.log('\n[3] GET /audit —— 默认分页参数');
  const def = await call('/api/admin/audit');
  check('返回 200', def.status === 200, def.text.slice(0, 200));
  check('含 logs / total / limit / offset',
    Array.isArray(def.json.logs) && typeof def.json.total === 'number' &&
    typeof def.json.limit === 'number' && typeof def.json.offset === 'number',
    Object.keys(def.json).join(','));
  check('默认 limit=50', def.json.limit === 50, `limit=${def.json.limit}`);
  check('默认 offset=0', def.json.offset === 0, `offset=${def.json.offset}`);
  check('total 不少于本次写入的记录数', def.json.total >= 6, `total=${def.json.total}`);
  check('返回条数不超过 limit', def.json.logs.length <= def.json.limit,
    `logs=${def.json.logs.length} limit=${def.json.limit}`);
  check('日志字段齐全 (时间/操作人/动作/对象)',
    def.json.logs.every((l) => 'created_at' in l && 'admin_name' in l && 'action' in l &&
      'resource' in l && 'resource_id' in l),
    JSON.stringify(def.json.logs[0] ?? {}).slice(0, 200));

  const total = def.json.total;
  check('分页的数据源不是被 limit 截断的', total >= def.json.logs.length,
    `total=${total} logs=${def.json.logs.length}`);

  // ---- [4] 分页正确性: 两页不重叠, id 倒序 ----
  console.log('\n[4] GET /audit?limit=2&offset=N —— 页间不重叠');
  if (total >= 4) {
    const p1 = await call('/api/admin/audit?limit=2&offset=0');
    const p2 = await call('/api/admin/audit?limit=2&offset=2');
    check('第 1 页返回 2 条', p1.status === 200 && p1.json.logs.length === 2,
      `status=${p1.status} len=${p1.json.logs.length}`);
    check('第 2 页返回 2 条', p2.status === 200 && p2.json.logs.length === 2,
      `status=${p2.status} len=${p2.json.logs.length}`);
    check('两页 total 一致', p1.json.total === p2.json.total,
      `${p1.json.total} vs ${p2.json.total}`);

    const ids1 = p1.json.logs.map((l) => l.id);
    const ids2 = p2.json.logs.map((l) => l.id);
    check('页内 id 严格倒序 (新 -> 旧)',
      ids1[0] > ids1[1] && ids2[0] > ids2[1], JSON.stringify([ids1, ids2]));
    check('第 1 页整体比第 2 页新', ids1[1] > ids2[0], `p1=${JSON.stringify(ids1)} p2=${JSON.stringify(ids2)}`);
    check('两页没有重复记录', ids1.every((id) => !ids2.includes(id)), JSON.stringify([ids1, ids2]));

    // 逐页拼起来应等于一次性取回的前 4 条
    const all4 = await call('/api/admin/audit?limit=4&offset=0');
    check('逐页取 = 一次性取 (顺序一致)',
      JSON.stringify(all4.json.logs.map((l) => l.id)) === JSON.stringify([...ids1, ...ids2]),
      JSON.stringify(all4.json.logs.map((l) => l.id)));
  } else {
    check('记录足够用于分页测试 (>=4 条)', false, `total=${total}`);
  }

  // ---- [5] 越界 offset ----
  console.log('\n[5] GET /audit?offset=total —— 越界页');
  const beyond = await call(`/api/admin/audit?limit=10&offset=${total + 100}`);
  check('越界页返回 200', beyond.status === 200, `status=${beyond.status}`);
  check('越界页 logs 为空数组', Array.isArray(beyond.json.logs) && beyond.json.logs.length === 0,
    JSON.stringify(beyond.json.logs).slice(0, 120));
  check('越界页 total 不变', beyond.json.total === total, `${beyond.json.total} vs ${total}`);

  // ---- [6] 参数夹取 (以前 'limit=abc' 会算出 NaN 直接 500) ----
  console.log('\n[6] 参数夹取 / 非法值');
  const big = await call('/api/admin/audit?limit=9999');
  check('超大 limit 夹到 200', big.status === 200 && big.json.limit === 200,
    `status=${big.status} limit=${big.json.limit}`);

  const zero = await call('/api/admin/audit?limit=0');
  check('limit=0 夹到 1', zero.status === 200 && zero.json.limit === 1,
    `status=${zero.status} limit=${zero.json.limit}`);

  const neg = await call('/api/admin/audit?limit=-5');
  check('负 limit 夹到 1', neg.status === 200 && neg.json.limit === 1,
    `status=${neg.status} limit=${neg.json.limit}`);

  const nan = await call('/api/admin/audit?limit=abc&offset=xyz');
  check('非数字参数不报错 (退回默认值)', nan.status === 200,
    `status=${nan.status} ${nan.text.slice(0, 160)}`);
  check('非数字 limit -> 默认 50', nan.json.limit === 50, `limit=${nan.json.limit}`);
  check('非数字 offset -> 默认 0', nan.json.offset === 0, `offset=${nan.json.offset}`);

  const negOff = await call('/api/admin/audit?offset=-10');
  check('负 offset 夹到 0', negOff.status === 200 && negOff.json.offset === 0,
    `status=${negOff.status} offset=${negOff.json.offset}`);

  const float = await call('/api/admin/audit?limit=2.7');
  check('小数 limit 取整不报错', float.status === 200 && float.json.limit === 2,
    `status=${float.status} limit=${float.json.limit}`);

  // ---- [7] 未登录 ----
  console.log('\n[7] 未登录访问');
  const anon = await fetch(`${BASE}/api/admin/audit`);
  check('未登录 -> 401', anon.status === 401, `status=${anon.status}`);

  console.log(`\n=== 结果: ${pass} passed, ${fail} failed ===\n`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error('审计分页 E2E 运行失败:', e.message);
  process.exit(1);
});
