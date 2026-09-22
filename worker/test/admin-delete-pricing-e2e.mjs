/**
 * 「定价批量设置」+「超管批量删除日志/审计」E2E
 *
 * 对应需求(2026-09-22):
 *   「模型定价菜单, 通过上游可以直接获取上游模型, 并一键设置定价。也可以单独设置定价,
 *     获取不到上游模型的情况, 可以手动新增定价。api 请求, 花费金额, 严格通过这边的定价进行操作。
 *     操作审计, 新增超级管理员删除功能。请求日志, 新增超级管理员, 可以删除的功能。
 *     删除可以多选, 全选。删除之后, 弹窗确认。」
 *
 * 这里验的是**服务端**这一半(前端的多选/全选/确认弹窗由 test-nav-guard.mjs 静态钉住):
 *   [2] 定价 GET 形状: 逐模型 + 默认单价 + 出厂默认值
 *   [3] 默认单价可改可还原(计费的唯一兜底来源)
 *   [4] 一键设置定价 = 批量 PUT; 单独设置 = 单条 PUT(兼容旧前端)
 *   [5] 定价删除(单条 + 批量)
 *   [6] 操作审计: 取 id → 批量 DELETE → 真的没了 → **删除动作自己留了一条审计**
 *   [7] 请求日志: 非法 ids 被拒(400), 不存在的 id 删 0 条(200)
 *   [8] 权限: 非超管即使有 usage/audit 菜单, DELETE 也必须 403
 *   [9] 未登录 401
 *
 * 用法:
 *   ADMIN_PASS=<密码> node tools/run-e2e.mjs 8787 test/admin-delete-pricing-e2e.mjs
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
  console.log(`\n=== 定价批量设置 / 超管删除 E2E @ ${BASE} ===\n`);

  if (!PASS) {
    console.log('  SKIP  未提供 ADMIN_PASS, 跳过 (用法: ADMIN_PASS=xxx node tools/run-e2e.mjs 8787 test/admin-delete-pricing-e2e.mjs)');
    skip++;
    console.log(`\n=== 结果: ${pass} passed, ${fail} failed, ${skip} skipped ===\n`);
    process.exit(0);
  }

  const makeCall = (cookie) => async (path, init = {}) => {
    const r = await fetch(`${BASE}${path}`, {
      ...init,
      headers: { cookie, 'content-type': 'application/json', ...(init.headers ?? {}) },
    });
    const text = await r.text();
    let json = {};
    try { json = JSON.parse(text); } catch { /* 非 JSON */ }
    return { status: r.status, text, json };
  };

  const login = async (username, password) => {
    const r = await fetch(`${BASE}/api/admin/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    const text = await r.text();
    let json = {};
    try { json = JSON.parse(text); } catch { /* 非 JSON */ }
    return { status: r.status, text, json, cookie: (r.headers.get('set-cookie') ?? '').split(';')[0] };
  };

  // ---- [1] 超管登录 ----
  console.log('[1] 超级管理员登录');
  const root = await login(USER, PASS);
  check('登录返回 200', root.status === 200, `status=${root.status}`);
  check('超管 is_admin=true', root.json.is_admin === true, JSON.stringify(root.json.is_admin));
  if (root.status !== 200 || root.json.is_admin !== true) {
    console.log(`\n=== 结果: ${pass} passed, ${fail} failed ===\n`);
    process.exit(1);
  }
  const call = makeCall(root.cookie);

  const stamp = Date.now();
  const TEST_MODEL = `e2e-price-${stamp}`;
  const TEST_MODEL2 = `e2e-price-b-${stamp}`;
  let origDefault = null;

  // ---- [2] 定价 GET 形状 ----
  console.log('\n[2] GET /api/admin/models —— 形状');
  const base = await call('/api/admin/models');
  check('返回 200', base.status === 200, base.text.slice(0, 160));
  check('含 models / default_price / default_price_builtin',
    Array.isArray(base.json.models) && base.json.default_price && base.json.default_price_builtin,
    Object.keys(base.json).join(','));
  check('默认单价四个字段齐全(入/出/缓存读/缓存写)',
    ['input_price', 'output_price', 'cache_read_price', 'cache_creation_price']
      .every((k) => typeof base.json.default_price[k] === 'number'),
    JSON.stringify(base.json.default_price));
  check('出厂默认值也齐全且是有限数字',
    ['input_price', 'output_price'].every((k) => Number.isFinite(Number(base.json.default_price_builtin[k]))),
    JSON.stringify(base.json.default_price_builtin));
  origDefault = base.json.default_price;

  // ---- [3] 默认单价可改可还原 ----
  console.log('\n[3] PUT /api/admin/models { default_price }');
  const newDef = { input_price: 1.5, output_price: 7.5, cache_read_price: 0.2, cache_creation_price: 0.3 };
  const putDef = await call('/api/admin/models', { method: 'PUT', body: JSON.stringify({ default_price: newDef }) });
  check('改默认单价 200', putDef.status === 200, putDef.text.slice(0, 160));
  const afterDef = await call('/api/admin/models');
  check('默认单价已持久化(再查是刚写的值)',
    ['input_price', 'output_price', 'cache_read_price', 'cache_creation_price']
      .every((k) => Number(afterDef.json.default_price[k]) === newDef[k]),
    JSON.stringify(afterDef.json.default_price));
  check('出厂默认值不跟着变(还原时才有参照)',
    Number(afterDef.json.default_price_builtin.input_price) === Number(base.json.default_price_builtin.input_price),
    JSON.stringify(afterDef.json.default_price_builtin));

  // ---- [4] 一键设置定价(批量) + 单独设置(单条) ----
  console.log('\n[4] PUT { models: [...] } 批量 / { model, ... } 单条');
  const batch = [
    { model: TEST_MODEL, input_price: 2, output_price: 10, cache_read_price: 0.5, cache_creation_price: 0.6 },
    { model: TEST_MODEL2, input_price: 3, output_price: 12, cache_read_price: 0, cache_creation_price: 0 },
  ];
  const putBatch = await call('/api/admin/models', { method: 'PUT', body: JSON.stringify({ models: batch }) });
  check('批量设置定价 200 且回报 saved=2', putBatch.status === 200 && putBatch.json.saved === 2,
    `${putBatch.status} ${putBatch.text.slice(0, 160)}`);

  const listRows = (await call('/api/admin/models')).json.models ?? [];
  const r1 = listRows.find((m) => m.model === TEST_MODEL);
  const r2 = listRows.find((m) => m.model === TEST_MODEL2);
  check('批量写入的模型都在列表里', !!r1 && !!r2);
  check('单价落库正确(含缓存价)',
    r1 && Number(r1.input_per_mtok) === 2 && Number(r1.output_per_mtok) === 10 &&
    Number(r1.cache_read_price) === 0.5 && Number(r1.cache_creation_price) === 0.6,
    JSON.stringify(r1));

  // 单独设置 = 同一路径的"单条"形态(旧前端 modelForm 就是这么发的)
  const putOne = await call('/api/admin/models', {
    method: 'PUT',
    body: JSON.stringify({ model: TEST_MODEL, input_price: 2.5, output_price: 11, cache_read_price: 0.5, cache_creation_price: 0.6 }),
  });
  check('单条设置定价 200(saved=1)', putOne.status === 200 && putOne.json.saved === 1,
    `${putOne.status} ${putOne.text.slice(0, 160)}`);
  const r1b = ((await call('/api/admin/models')).json.models ?? []).find((m) => m.model === TEST_MODEL);
  check('upsert 生效(不是插出第二行)',
    r1b && Number(r1b.input_per_mtok) === 2.5 &&
    listRows.filter((m) => m.model === TEST_MODEL).length === 1,
    JSON.stringify(r1b));

  // 负数/字符串被收敛成非负数字, 不能把库里的价写成负数
  const putNeg = await call('/api/admin/models', {
    method: 'PUT',
    body: JSON.stringify({ model: TEST_MODEL2, input_price: -5, output_price: 'abc' }),
  });
  const r2b = ((await call('/api/admin/models')).json.models ?? []).find((m) => m.model === TEST_MODEL2);
  check('负数/非数字单价被收敛成非负数字(不会写进负数价)',
    putNeg.status === 200 && r2b && Number(r2b.input_per_mtok) >= 0 && Number(r2b.output_per_mtok) >= 0,
    JSON.stringify(r2b));

  // 空请求体 -> 400(model is required)
  const putEmpty = await call('/api/admin/models', { method: 'PUT', body: JSON.stringify({ models: [] }) });
  check('空 models 数组 -> 400', putEmpty.status === 400, `status=${putEmpty.status} ${putEmpty.text.slice(0, 120)}`);

  // ---- [5] 删除定价 ----
  console.log('\n[5] DELETE /api/admin/models —— 单条 / 批量');
  const delOne = await call('/api/admin/models', { method: 'DELETE', body: JSON.stringify({ model: TEST_MODEL }) });
  check('删单条定价 200 且 deleted>=1', delOne.status === 200 && Number(delOne.json.deleted) >= 1,
    `${delOne.status} ${delOne.text.slice(0, 120)}`);
  const delBatch = await call('/api/admin/models', { method: 'DELETE', body: JSON.stringify({ models: [TEST_MODEL2] }) });
  check('批量删定价 200 且 deleted>=1', delBatch.status === 200 && Number(delBatch.json.deleted) >= 1,
    `${delBatch.status} ${delBatch.text.slice(0, 120)}`);
  const left = (await call('/api/admin/models')).json.models ?? [];
  check('两个测试模型都已从定价表消失',
    !left.some((m) => m.model === TEST_MODEL || m.model === TEST_MODEL2),
    left.map((m) => m.model).filter((m) => m.startsWith('e2e-price')).join(','));

  // ---- [6] 操作审计: 超管批量删除 ----
  console.log('\n[6] DELETE /api/admin/audit —— 批量删审计 + 删除动作自身留痕');
  // 先造几条审计(建用户 + 删用户 各留一条), 保证有可删的记录
  const madeUsers = [];
  for (let i = 0; i < 3; i++) {
    const r = await call('/api/admin/users', {
      method: 'POST',
      body: JSON.stringify({
        email: `e2e-del-${stamp}-${i}@local`,
        username: `e2e删除${i}`,
        role: 'user',
        status: 'active',
        balance: 0,
        concurrency: 1,
      }),
    });
    if (r.status === 201 && r.json.id) madeUsers.push(r.json.id);
  }
  for (const id of madeUsers) await call(`/api/admin/users/${id}`, { method: 'DELETE' });
  check('造出若干审计记录', madeUsers.length === 3, `created=${madeUsers.length}`);

  const before = await call('/api/admin/audit?limit=5');
  const victimIds = (before.json.logs ?? []).slice(0, 2).map((l) => l.id);
  check('取到要删的审计 id', victimIds.length === 2, JSON.stringify(victimIds));

  const delAudit = await call('/api/admin/audit', { method: 'DELETE', body: JSON.stringify({ ids: victimIds }) });
  check('批量删审计 200 且 deleted=2', delAudit.status === 200 && Number(delAudit.json.deleted) === 2,
    `${delAudit.status} ${delAudit.text.slice(0, 160)}`);

  const after = await call('/api/admin/audit?limit=50');
  const stillThere = (after.json.logs ?? []).filter((l) => victimIds.includes(l.id));
  check('被删的审计记录真的没了', stillThere.length === 0, JSON.stringify(stillThere.map((l) => l.id)));
  const delAuditLog = (after.json.logs ?? []).find((l) => l.action === 'delete' && l.resource === 'admin_audit_logs');
  check('删除动作自己写了一条审计(链式留痕: 谁清了证据)',
    !!delAuditLog, JSON.stringify((after.json.logs ?? []).slice(0, 3).map((l) => `${l.action}/${l.resource}`)));

  // ---- [7] 请求日志: 非法 ids 被拒 ----
  console.log('\n[7] DELETE /api/admin/usage —— ids 校验');
  const noIds = await call('/api/admin/usage', { method: 'DELETE', body: JSON.stringify({ ids: [] }) });
  check('ids 为空数组 -> 400', noIds.status === 400, `status=${noIds.status} ${noIds.text.slice(0, 120)}`);
  const badIds = await call('/api/admin/usage', { method: 'DELETE', body: JSON.stringify({ ids: ['abc', -1, 0, null] }) });
  check('ids 全是非法值 -> 400(过滤后为空)', badIds.status === 400,
    `status=${badIds.status} ${badIds.text.slice(0, 120)}`);
  const ghost = await call('/api/admin/usage', { method: 'DELETE', body: JSON.stringify({ ids: [999999999] }) });
  check('不存在的 id -> 200 但 deleted=0(不报错)', ghost.status === 200 && Number(ghost.json.deleted) === 0,
    `${ghost.status} ${ghost.text.slice(0, 120)}`);

  // ---- [8] 权限: 非超管即使有 usage / audit 菜单也不能删 ----
  console.log('\n[8] 非超管(有 usage/audit 菜单) —— 删除必须 403');
  const roleCode = `e2e-del-${stamp}`;
  const newRole = await call('/api/admin/roles', {
    method: 'POST',
    body: JSON.stringify({ code: roleCode, name: 'E2E 删除越权测试', menus: ['mykeys', 'usage', 'audit'] }),
  });
  check('建测试角色 201', newRole.status === 201, newRole.text.slice(0, 200));
  const roleId = newRole.json.id;

  const bizPwd = 'e2e-del-pwd-1';
  const bizEmail = `e2e-del-biz-${stamp}@local`;
  const bu = await call('/api/admin/users', {
    method: 'POST',
    body: JSON.stringify({ email: bizEmail, username: `e2e越权${stamp}`, password: bizPwd, role: roleCode }),
  });
  check('建测试用户 201', bu.status === 201, bu.text.slice(0, 200));
  const bizId = bu.json.id;

  const bizLogin = await login(bizEmail, bizPwd);
  check('非超管可登录且 is_admin=false', bizLogin.status === 200 && bizLogin.json.is_admin === false,
    `${bizLogin.status} is_admin=${JSON.stringify(bizLogin.json.is_admin)}`);
  const biz = makeCall(bizLogin.cookie);

  const bizSee = await biz('/api/admin/audit?limit=1');
  check('非超管有 audit 菜单 -> GET 200(能看)', bizSee.status === 200, `status=${bizSee.status}`);

  const bizDelAudit = await biz('/api/admin/audit', { method: 'DELETE', body: JSON.stringify({ ids: [1] }) });
  check('🧨 非超管删审计 -> 403(菜单权限 ≠ 删除权限)', bizDelAudit.status === 403,
    `status=${bizDelAudit.status} ${bizDelAudit.text.slice(0, 160)}`);

  const bizDelUsage = await biz('/api/admin/usage', { method: 'DELETE', body: JSON.stringify({ ids: [1] }) });
  check('🧨 非超管删请求日志 -> 403', bizDelUsage.status === 403,
    `status=${bizDelUsage.status} ${bizDelUsage.text.slice(0, 160)}`);

  // ---- 清理 + [9] 未登录 ----
  console.log('\n[9] 清理现场 / 未登录');
  if (origDefault) {
    await call('/api/admin/models', { method: 'PUT', body: JSON.stringify({ default_price: origDefault }) });
  }
  const restored = (await call('/api/admin/models')).json.default_price;
  check('默认单价已还原成测试前的值',
    Number(restored.input_price) === Number(origDefault.input_price) &&
    Number(restored.output_price) === Number(origDefault.output_price),
    JSON.stringify(restored));

  await call(`/api/admin/users/${bizId}`, { method: 'DELETE' });
  const delRole = await call(`/api/admin/roles/${roleId}`, { method: 'DELETE' });
  check('测试角色已清理', delRole.status === 200, `status=${delRole.status} ${delRole.text.slice(0, 120)}`);

  const anonDel = await fetch(`${BASE}/api/admin/usage`, {
    method: 'DELETE',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ids: [1] }),
  });
  check('未登录删请求日志 -> 401', anonDel.status === 401, `status=${anonDel.status}`);

  console.log(`\n=== 结果: ${pass} passed, ${fail} failed ===\n`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error('定价/删除 E2E 运行失败:', e.message);
  process.exit(1);
});
