/**
 * 用户密码 E2E
 *
 * 覆盖:
 *   1. 新建用户**必定有密码** —— 不传 password 就用后端默认密码(不再出现"没有密码的用户")
 *   2. `GET /users` 回传 default_password 与 has_password, 但**绝不下发 password_hash**
 *   3. 编辑时留空 = 不改密码(与"账号别名被误清空"是同一类坑, 必须有回归)
 *   4. 密码长度下限, 前端拦一道、后端也要拦
 *   5. **客户端不能直接写 password_hash**(那样等于允许塞任意哈希)
 *   6. 审计日志里**不能出现明文密码**
 *   7. /users/reset-missing-passwords 给历史遗留的空密码用户补默认密码
 *
 * 用法:
 *   ADMIN_PASS=<密码> node tools/run-e2e.mjs 8787 test/admin-user-password-e2e.mjs
 *   (未提供 ADMIN_PASS 时自动跳过, 退出码 0)
 */

const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:8787';
const USER = process.env.ADMIN_USER ?? 'admin';
const PASS = process.env.ADMIN_PASS ?? '';

let pass = 0;
let fail = 0;

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
  console.log(`\n=== 用户密码 E2E @ ${BASE} ===\n`);

  if (!PASS) {
    console.log('  SKIP  未提供 ADMIN_PASS, 跳过 (用法: ADMIN_PASS=xxx node tools/run-e2e.mjs 8787 test/admin-user-password-e2e.mjs)');
    console.log('\n=== 结果: 0 passed, 0 failed, 1 skipped ===\n');
    process.exit(0);
  }

  const login = await fetch(`${BASE}/api/admin/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: USER, password: PASS }),
  });
  const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0];
  check('登录返回 200', login.status === 200, `status=${login.status}`);
  if (login.status !== 200) {
    console.log('\n=== 结果: 1 passed, 1 failed ===\n');
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

  const stamp = Date.now();
  const created = [];

  // ---- [1] 列表接口的形状与"不泄露哈希" ----
  console.log('\n[1] GET /users —— default_password / has_password, 不泄露哈希');
  const list0 = await call('/api/admin/users');
  check('返回 200', list0.status === 200, list0.text.slice(0, 200));
  check('回传 default_password 供前端显示', typeof list0.json.default_password === 'string' && list0.json.default_password.length > 0,
    `default_password=${JSON.stringify(list0.json.default_password)}`);
  check('每个用户都带 has_password 布尔', (list0.json.users ?? []).every((u) => typeof u.has_password === 'boolean'),
    JSON.stringify((list0.json.users ?? [])[0] ?? {}).slice(0, 200));
  const leaked = (list0.json.users ?? []).some((u) => 'password_hash' in u);
  check('响应里没有 password_hash 字段', !leaked);
  check('响应文本里不含 pbkdf2 哈希', !/pbkdf2\$/.test(list0.text));

  const defaultPwd = list0.json.default_password;

  // ---- [2] 不传密码 -> 用默认密码 ----
  console.log('\n[2] POST /users (不传密码) -> 默认密码');
  const emailA = `e2e-pwd-a-${stamp}@local`;
  const a = await call('/api/admin/users', {
    method: 'POST',
    body: JSON.stringify({ email: emailA, username: 'e2e默认密码' }),
  });
  check('创建返回 201', a.status === 201, a.text.slice(0, 200));
  check('回传 used_default_password=true', a.json.used_default_password === true, JSON.stringify(a.json));
  created.push(a.json.id);

  const listA = await call('/api/admin/users');
  const ua = (listA.json.users ?? []).find((u) => u.id === a.json.id) ?? {};
  check('新用户 has_password=true(不再有"没密码的用户")', ua.has_password === true, `has_password=${ua.has_password}`);

  // ---- [3] 指定密码 ----
  console.log('\n[3] POST /users (自带密码)');
  const emailB = `e2e-pwd-b-${stamp}@local`;
  const b = await call('/api/admin/users', {
    method: 'POST',
    body: JSON.stringify({ email: emailB, username: 'e2e自定义密码', password: 'custompass123' }),
  });
  check('创建返回 201', b.status === 201, b.text.slice(0, 200));
  check('回传 used_default_password=false', b.json.used_default_password === false, JSON.stringify(b.json));
  created.push(b.json.id);

  // ---- [4] 长度下限 ----
  console.log('\n[4] 密码长度下限');
  const short = await call('/api/admin/users', {
    method: 'POST',
    body: JSON.stringify({ email: `e2e-pwd-short-${stamp}@local`, password: '123' }),
  });
  check('新建时密码过短 -> 400', short.status === 400, `status=${short.status} ${short.text.slice(0, 160)}`);

  // ---- [5] 编辑: 留空不改密码(关键回归) ----
  console.log('\n[5] PUT /users/:id (password 留空 = 不修改)');
  const emptyPass = await call(`/api/admin/users/${a.json.id}`, {
    method: 'PUT',
    // 模拟"编辑弹窗保存": 其他字段都提交, 密码框留空 => 密码字段是空串
    body: JSON.stringify({ username: 'e2e改过名', password: '' }),
  });
  check('保存返回 200', emptyPass.status === 200, emptyPass.text.slice(0, 200));
  check('回传 password_changed=false', emptyPass.json.password_changed === false, JSON.stringify(emptyPass.json));
  const afterEmpty = await call('/api/admin/users');
  const ua2 = (afterEmpty.json.users ?? []).find((u) => u.id === a.json.id) ?? {};
  check('密码没有被清空 (has_password 仍为 true)', ua2.has_password === true, `has_password=${ua2.has_password}`);
  check('其它字段确实更新了 (username)', ua2.username === 'e2e改过名', `username=${ua2.username}`);

  const omitPass = await call(`/api/admin/users/${b.json.id}`, {
    method: 'PUT',
    body: JSON.stringify({ username: 'e2e-b-改名' }),
  });
  check('完全不传 password 字段也能保存', omitPass.status === 200, omitPass.text.slice(0, 200));
  const afterOmit = await call('/api/admin/users');
  const ub2 = (afterOmit.json.users ?? []).find((u) => u.id === b.json.id) ?? {};
  check('不传 password 时密码保持不变', ub2.has_password === true, `has_password=${ub2.has_password}`);

  // ---- [6] 修改密码 ----
  console.log('\n[6] PUT /users/:id (设置新密码)');
  const setPwd = await call(`/api/admin/users/${b.json.id}`, {
    method: 'PUT',
    body: JSON.stringify({ password: 'brandnewpass456' }),
  });
  check('改密码返回 200', setPwd.status === 200, setPwd.text.slice(0, 200));
  check('回传 password_changed=true', setPwd.json.password_changed === true, JSON.stringify(setPwd.json));

  const tooShort = await call(`/api/admin/users/${b.json.id}`, {
    method: 'PUT',
    body: JSON.stringify({ password: '1234567' }),
  });
  check('改密码时过短 -> 400', tooShort.status === 400, `status=${tooShort.status}`);

  // ---- [7] 客户端不能直接写哈希 ----
  console.log('\n[7] 不接受客户端提交 password_hash');
  const inject = await call(`/api/admin/users/${a.json.id}`, {
    method: 'PUT',
    body: JSON.stringify({ password_hash: 'pbkdf2$1$aa$bb' }),
  });
  check('只传 password_hash -> 400(视为无可更新字段)', inject.status === 400,
    `status=${inject.status} ${inject.text.slice(0, 160)}`);

  const inject2 = await call(`/api/admin/users/${a.json.id}`, {
    method: 'PUT',
    body: JSON.stringify({ username: 'e2e-仍可改名', password_hash: 'pbkdf2$1$aa$bb' }),
  });
  check('混在其它字段里的 password_hash 被忽略 (仍 200)', inject2.status === 200, `status=${inject2.status}`);
  const afterInject = await call('/api/admin/users');
  const ua3 = (afterInject.json.users ?? []).find((u) => u.id === a.json.id) ?? {};
  check('哈希没有被注入改写 (has_password 仍为 true)', ua3.has_password === true);

  // ---- [8] 审计日志不含明文密码 ----
  console.log('\n[8] 审计日志不记录明文密码');
  const audit = await call('/api/admin/audit?limit=50&offset=0');
  check('审计接口返回 200', audit.status === 200, `status=${audit.status}`);
  const auditText = JSON.stringify(audit.json.logs ?? []);
  check('审计里没有明文密码 custompass123', !auditText.includes('custompass123'));
  check('审计里没有明文密码 brandnewpass456', !auditText.includes('brandnewpass456'));
  check('审计里也没有默认密码明文', !auditText.includes(defaultPwd));
  const createLog = (audit.json.logs ?? []).find((l) => l.resource === 'user' && l.action === 'create' && String(l.detail || '').includes(emailA));
  check('创建日志用 default/custom 标记代替密码',
    !!createLog && /password=(default|custom)/.test(String(createLog.detail)),
    JSON.stringify(createLog ?? {}).slice(0, 200));

  // ---- [9] 补齐历史遗留的空密码 ----
  console.log('\n[9] POST /users/reset-missing-passwords');
  const backfill = await call('/api/admin/users/reset-missing-passwords', { method: 'POST' });
  check('补齐接口返回 200', backfill.status === 200, backfill.text.slice(0, 200));
  check('回传 updated 计数', typeof backfill.json.updated === 'number', JSON.stringify(backfill.json));
  const listEnd = await call('/api/admin/users');
  const missing = (listEnd.json.users ?? []).filter((u) => !u.has_password);
  check('执行后没有任何用户处于"未设置密码"状态', missing.length === 0,
    JSON.stringify(missing.map((u) => u.id)));

  const backfill2 = await call('/api/admin/users/reset-missing-passwords', { method: 'POST' });
  check('重复执行是幂等的 (updated=0)', backfill2.json.updated === 0, JSON.stringify(backfill2.json));

  // ---- [10] 清理 ----
  console.log('\n[10] 清理测试用户');
  for (const id of created) {
    const d = await call(`/api/admin/users/${id}`, { method: 'DELETE' });
    check(`删除测试用户 #${id}`, d.status === 200, `status=${d.status}`);
  }
  const listFinal = await call('/api/admin/users');
  check('测试用户已消失', !(listFinal.json.users ?? []).some((u) => created.includes(u.id)));

  console.log(`\n=== 结果: ${pass} passed, ${fail} failed ===\n`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error('用户密码 E2E 运行失败:', e.message);
  process.exit(1);
});
