/**
 * 分组 ↔ 账号 绑定管理 + 用户管理 接口 E2E
 *
 * 覆盖本次修复:
 *   1. GET /api/admin/groups 的「账号数」只数**存活**账号, 失效绑定单独计数
 *      (起因: default 组显示「账号数 6」, 实际只有 3 个活账号 ——
 *       account_groups 关联行不随账号软删除一起清掉)
 *   2. GET /api/admin/groups/:id/accounts  → 存活账号清单 + 失效绑定清单
 *   3. PUT /api/admin/groups/:id/accounts  → 整体替换绑定, 顺带清理失效绑定
 *   4. GET /api/admin/api-keys?user_id=N   → 按用户过滤
 *   5. POST/PUT/DELETE /api/admin/users    → rpm_limit / platform_access 落库
 *
 * 前置:
 *   本地 admin_accounts 里有一条已知密码的管理员账号 (可用
 *   `node tools/gen-admin-secret.mjs "密码"` 生成哈希后写入本地 D1)。
 *
 * 用法:
 *   ADMIN_PASS=<密码> node tools/run-e2e.mjs 8787 test/admin-groups-e2e.mjs
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
  console.log(`\n=== 分组绑定 / 用户管理 接口 E2E @ ${BASE} ===\n`);

  if (!PASS) {
    console.log('  SKIP  未提供 ADMIN_PASS, 跳过 (用法: ADMIN_PASS=xxx node tools/run-e2e.mjs 8787 test/admin-groups-e2e.mjs)');
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
  check('拿到会话 Cookie', cookie.startsWith('s2a_admin_token='), cookie.slice(0, 40));
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

  // ---- [2] 分组列表: 账号数只数存活账号 ----
  console.log('\n[2] GET /groups —— 账号数与失效绑定分开计数');
  const gl = await call('/api/admin/groups');
  check('返回 200', gl.status === 200, gl.text.slice(0, 200));
  const groups = gl.json.groups ?? [];
  check('groups 是数组且非空', Array.isArray(groups) && groups.length > 0, `len=${groups.length}`);
  check(
    '每个分组都带 account_count / account_count_active / account_count_stale',
    groups.every((g) =>
      typeof g.account_count === 'number' &&
      typeof g.account_count_active === 'number' &&
      typeof g.account_count_stale === 'number'),
    JSON.stringify(groups[0] ?? {}).slice(0, 200),
  );
  check(
    '可调度数不会超过存活绑定数',
    groups.every((g) => g.account_count_active <= g.account_count),
    JSON.stringify(groups.map((g) => [g.id, g.account_count, g.account_count_active])),
  );

  const g0 = groups[0];

  // ---- [3] 绑定明细与分组计数的自洽性 ----
  console.log('\n[3] GET /groups/:id/accounts —— 明细与计数自洽');
  let detail = await call(`/api/admin/groups/${g0.id}/accounts`);
  check('返回 200', detail.status === 200, detail.text.slice(0, 200));
  check('含 accounts 与 stale 两个数组',
    Array.isArray(detail.json.accounts) && Array.isArray(detail.json.stale),
    Object.keys(detail.json).join(','));
  const boundLive = (detail.json.accounts ?? []).filter((a) => a.bound);
  check(
    'account_count === 存活且已绑定的账号数',
    boundLive.length === g0.account_count,
    `bound=${boundLive.length} vs count=${g0.account_count}`,
  );
  check(
    'account_count_stale === stale 条数',
    (detail.json.stale ?? []).length === g0.account_count_stale,
    `stale=${(detail.json.stale ?? []).length} vs count=${g0.account_count_stale}`,
  );
  check(
    'accounts 每条都带 bound/priority/platform',
    (detail.json.accounts ?? []).every((a) => 'bound' in a && 'priority' in a && 'platform' in a),
  );

  // 不存在的分组 -> 404
  const nf = await call('/api/admin/groups/999999/accounts');
  check('不存在的分组 -> 404', nf.status === 404, `status=${nf.status}`);

  // ---- [4] 缺少参数不写库 ----
  console.log('\n[4] PUT /groups/:id/accounts —— 入参校验');
  const bad = await call(`/api/admin/groups/${g0.id}/accounts`, {
    method: 'PUT',
    body: JSON.stringify({}),
  });
  check('既无 account_ids 也无 purge_stale -> 400', bad.status === 400, `status=${bad.status} ${bad.text.slice(0, 160)}`);

  // ---- [5] 整体替换 + 清理失效绑定 ----
  console.log('\n[5] PUT /groups/:id/accounts —— 整体替换并清理失效绑定');
  const keepIds = boundLive.map((a) => a.id);
  const save = await call(`/api/admin/groups/${g0.id}/accounts`, {
    method: 'PUT',
    body: JSON.stringify({ account_ids: keepIds }),
  });
  check('保存返回 200', save.status === 200, save.text.slice(0, 200));
  check('返回 bound / removed 计数', typeof save.json.bound === 'number' && typeof save.json.removed === 'number',
    JSON.stringify(save.json));

  const after = await call(`/api/admin/groups/${g0.id}/accounts`);
  check('失效绑定已被清空', (after.json.stale ?? []).length === 0,
    `stale=${(after.json.stale ?? []).length}`);
  const afterGroups = await call('/api/admin/groups');
  const g0b = (afterGroups.json.groups ?? []).find((x) => x.id === g0.id) ?? {};
  check('分组计数不再含失效绑定 (account_count_stale === 0)', g0b.account_count_stale === 0, JSON.stringify(g0b).slice(0, 160));
  check('存活绑定数保持不变', g0b.account_count === g0.account_count, `${g0b.account_count} vs ${g0.account_count}`);

  // ---- [6] 已删除/不存在的账号 id 不能被绑定 ----
  console.log('\n[6] PUT /groups/:id/accounts —— 过滤非法账号 id');
  const bogus = await call(`/api/admin/groups/${g0.id}/accounts`, {
    method: 'PUT',
    body: JSON.stringify({ account_ids: [999999, -1, 'abc', null] }),
  });
  check('非法 id 全部被丢弃 -> bound=0', bogus.status === 200 && bogus.json.bound === 0, JSON.stringify(bogus.json));

  // 还原本地绑定
  const restore = await call(`/api/admin/groups/${g0.id}/accounts`, {
    method: 'PUT',
    body: JSON.stringify({ account_ids: keepIds }),
  });
  check('绑定已还原', restore.status === 200 && restore.json.bound === keepIds.length, JSON.stringify(restore.json));

  // ---- [7] 只清理失效绑定 ----
  console.log('\n[7] PUT /groups/:id/accounts —— 仅清理模式');
  const purge = await call(`/api/admin/groups/${g0.id}/accounts`, {
    method: 'PUT',
    body: JSON.stringify({ purge_stale: true }),
  });
  check('purge_stale 模式返回 200', purge.status === 200, purge.text.slice(0, 160));
  check('返回 removed 计数', typeof purge.json.removed === 'number', JSON.stringify(purge.json));

  // ---- [8] API Key 按用户过滤 ----
  console.log('\n[8] GET /api-keys?user_id=N');
  const ul = await call('/api/admin/users');
  const someUser = (ul.json.users ?? [])[0];
  if (someUser) {
    const kf = await call(`/api/admin/api-keys?user_id=${someUser.id}`);
    check('按用户过滤返回 200', kf.status === 200, kf.text.slice(0, 160));
    check(
      '返回的 Key 全部属于该用户',
      (kf.json.api_keys ?? []).every((k) => k.user_id === someUser.id),
      JSON.stringify((kf.json.api_keys ?? []).map((k) => [k.id, k.user_id])),
    );
  } else {
    check('本地存在至少一个用户用于过滤测试', false, 'users 为空');
  }
  const nokeys = await call('/api/admin/api-keys?user_id=999999');
  check('不存在的用户 -> 空列表', nokeys.status === 200 && (nokeys.json.api_keys ?? []).length === 0,
    JSON.stringify(nokeys.json).slice(0, 160));

  // ---- [9] 用户 CRUD: rpm_limit / platform_access ----
  console.log('\n[9] 用户增改删 (rpm_limit / platform_access)');
  const email = `e2e-groups-${Date.now()}@local`;
  const created = await call('/api/admin/users', {
    method: 'POST',
    body: JSON.stringify({
      email,
      username: 'e2e绑定测试',
      role: 'user',
      status: 'active',
      balance: 1.5,
      concurrency: 4,
      rpm_limit: 7,
      platform_access: 'openai,sensenova',
      notes: '由 admin-groups-e2e 自动创建',
    }),
  });
  check('新建用户返回 201', created.status === 201, created.text.slice(0, 160));
  const uid = created.json.id;

  const list2 = await call('/api/admin/users');
  const u2 = (list2.json.users ?? []).find((u) => u.id === uid) ?? {};
  check('新用户出现在列表中', !!u2.id, email);
  check('rpm_limit 落库', u2.rpm_limit === 7, `rpm_limit=${u2.rpm_limit}`);
  check('platform_access 落库', u2.platform_access === 'openai,sensenova', `platform_access=${u2.platform_access}`);
  check('余额换算正确', Math.abs(Number(u2.balance) - 1.5) < 1e-6, `balance=${u2.balance}`);
  check('key_count 初始为 0', u2.key_count === 0, `key_count=${u2.key_count}`);

  const upd = await call(`/api/admin/users/${uid}`, {
    method: 'PUT',
    body: JSON.stringify({ rpm_limit: 0, status: 'disabled', platform_access: 'gemini' }),
  });
  check('更新用户返回 200', upd.status === 200, upd.text.slice(0, 160));
  const list3 = await call('/api/admin/users');
  const u3 = (list3.json.users ?? []).find((u) => u.id === uid) ?? {};
  check('rpm_limit 已更新为 0', u3.rpm_limit === 0, `rpm_limit=${u3.rpm_limit}`);
  check('status 已更新为 disabled', u3.status === 'disabled', `status=${u3.status}`);
  check('platform_access 已更新', u3.platform_access === 'gemini', `platform_access=${u3.platform_access}`);

  const del = await call(`/api/admin/users/${uid}`, { method: 'DELETE' });
  check('删除用户返回 200', del.status === 200, del.text.slice(0, 160));
  const list4 = await call('/api/admin/users');
  check('删除后不再出现在列表(软删除)', !(list4.json.users ?? []).some((u) => u.id === uid));

  console.log(`\n=== 结果: ${pass} passed, ${fail} failed ===\n`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error('分组绑定/用户 E2E 运行失败:', e.message);
  process.exit(1);
});
