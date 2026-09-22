/**
 * 「编辑上游账号不会清空模型别名」回归测试
 *
 * 背景:
 *   模型别名存在 `accounts.extra.model_aliases`, 后端 `PUT /accounts/:id` 的语义是
 *   **「字段出现即整表替换」**(只有一个例外: 不传该字段 => 保留原值)。
 *   起因是「按条目合并」会导致永远删不掉别名(发 {} 想清空, 旧值还在)。
 *
 *   所以: 账号编辑弹窗**不能**再顺手提交 `model_aliases` —— 否则每编辑一次账号,
 *   该账号已有的别名就被清空一次, 而且**没有任何报错**(最阴的一类 bug)。
 *   2026-09-21 把别名编辑框从账号弹窗移到了「模型别名」页, 这个测试就是那道护栏。
 *
 * 覆盖:
 *   [1] 给账号写入两条别名
 *   [2] 不带 model_aliases 的 PUT(模拟账号弹窗保存) -> 别名必须原样保留
 *   [3] 其它字段确实被更新了(证明 PUT 真的生效, 不是被忽略)
 *   [4] 显式传 {model_aliases: null} -> 别名清空(清空能力没被误伤)
 *   [5] 清理: 删除测试账号
 *
 * 前置:
 *   本地 admin_accounts 有已知密码的管理员(本地约定 admin / localtest123)。
 *
 * 用法:
 *   ADMIN_PASS=localtest123 node tools/run-e2e.mjs 8787 test/admin-account-alias-e2e.mjs
 *   (未提供 ADMIN_PASS 自动跳过, 退出码 0)
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
  console.log(`\n=== 账号别名不被编辑清空 E2E @ ${BASE} ===\n`);

  if (!PASS) {
    console.log('  SKIP  未提供 ADMIN_PASS, 跳过 (用法: ADMIN_PASS=xxx node tools/run-e2e.mjs 8787 test/admin-account-alias-e2e.mjs)');
    skip++;
    console.log(`\n=== 结果: ${pass} passed, ${fail} failed, ${skip} skipped ===\n`);
    process.exit(0);
  }

  const lr = await fetch(`${BASE}/api/admin/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: USER, password: PASS }),
  });
  check('登录返回 200', lr.status === 200, `status=${lr.status}`);
  if (lr.status !== 200) {
    console.log(`\n=== 结果: ${pass} passed, ${fail} failed ===\n`);
    process.exit(1);
  }
  const cookie = (lr.headers.get('set-cookie') ?? '').split(';')[0];

  const call = async (method, path, body) => {
    const r = await fetch(`${BASE}/api/admin${path}`, {
      method,
      headers: { cookie, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await r.text();
    let json = {};
    try { json = JSON.parse(text); } catch { /* 非 JSON */ }
    return { status: r.status, text, json };
  };

  const findAcct = async (id) => {
    const r = await call('GET', '/accounts');
    return (r.json.accounts ?? []).find((x) => x.id === id) ?? null;
  };

  // ---- 建一个专用账号, 不碰现有 fixture ----
  const name = `e2e-alias-${Date.now()}`;
  const created = await call('POST', '/accounts', {
    name,
    platform: 'openai',
    protocol: 'openai',
    type: 'apikey',
    api_key: 'sk-e2e-not-a-real-key',
  });
  check('创建测试账号返回 201', created.status === 201, created.text.slice(0, 200));
  const id = created.json.id;
  if (!id) {
    console.log(`\n=== 结果: ${pass} passed, ${fail} failed ===\n`);
    process.exit(1);
  }

  try {
    // ---- [1] 写入两条别名 ----
    console.log('\n[1] 写入别名');
    const seed = { 'glm-5.2': 'my-glm-pro', 'kimi-k3': 'my-kimi' };
    const w = await call('PUT', `/accounts/${id}`, { model_aliases: seed });
    check('写入别名返回 200', w.status === 200, w.text.slice(0, 160));
    let a = await findAcct(id);
    check('别名已落库(2 条)', a && Object.keys(a.model_aliases ?? {}).length === 2, JSON.stringify(a?.model_aliases));

    // ---- [2] 不带 model_aliases 的 PUT —— 就是账号弹窗现在的行为 ----
    console.log('\n[2] PUT 不带 model_aliases (模拟「编辑上游账号」保存)');
    const edit = await call('PUT', `/accounts/${id}`, {
      name: name + '-edited',
      priority: 33,
      notes: 'e2e touched',
      // 注意: 这里**故意不发** model_aliases
    });
    check('编辑返回 200', edit.status === 200, edit.text.slice(0, 160));

    a = await findAcct(id);
    check('别名没有被清空(仍是 2 条)', a && Object.keys(a.model_aliases ?? {}).length === 2,
      JSON.stringify(a?.model_aliases));
    check('别名内容逐条不变',
      a && a.model_aliases && a.model_aliases['glm-5.2'] === 'my-glm-pro' && a.model_aliases['kimi-k3'] === 'my-kimi',
      JSON.stringify(a?.model_aliases));

    // ---- [3] 证明 PUT 真的生效(不是整个请求被忽略了) ----
    console.log('\n[3] 其它字段确实更新了');
    check('name 已更新', a && a.name === name + '-edited', `name=${a?.name}`);
    check('priority 已更新', a && Number(a.priority) === 33, `priority=${a?.priority}`);
    check('notes 已更新', a && a.notes === 'e2e touched', `notes=${a?.notes}`);

    // ---- [4] 清空能力没被误伤: 显式 null 仍能清 ----
    console.log('\n[4] 显式传 null 仍能清空别名');
    const clr = await call('PUT', `/accounts/${id}`, { model_aliases: null });
    check('清空返回 200', clr.status === 200, clr.text.slice(0, 160));
    a = await findAcct(id);
    check('别名已清空', a && (a.model_aliases === null || Object.keys(a.model_aliases ?? {}).length === 0),
      JSON.stringify(a?.model_aliases));
  } finally {
    // ---- [5] 清理 ----
    console.log('\n[5] 清理测试账号');
    const del = await call('DELETE', `/accounts/${id}`);
    check('删除测试账号返回 200', del.status === 200, del.text.slice(0, 160));
    const after = await findAcct(id);
    check('测试账号已从列表消失', after === null);
  }

  console.log(`\n=== 结果: ${pass} passed, ${fail} failed ===\n`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error('账号别名 E2E 运行失败:', e.message);
  process.exit(1);
});
