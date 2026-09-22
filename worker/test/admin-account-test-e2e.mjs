/**
 * 管理后台「上游账号连通性测试」接口测试 —— POST /api/admin/accounts/:id/test
 *
 * 为什么单独一个文件:
 *   这个接口的返回值直接决定运维敢不敢把一个账号放上线, 但它**不经过网关**,
 *   e2e.mjs / translate-e2e.mjs 覆盖不到, 所以必须单独冒烟。
 *
 * 回归的 bug:
 *   老实现把 HTTP 400/405 一律当成"鉴权过了", 于是返回 `ok: true`。
 *   但有些第三方中转(如 chatapi.weixin.qq.com)的 GET /v1/models 是
 *   永远 400 "missing required parameter: model", 且与带不带 key 无关 ——
 *   这时候回 `ok: true` 会给出**虚假的安心感**。
 *   现在的语义是三态(响应里带 verdict 字段):
 *     - 2xx              -> ok=true,  verdict='ok'        last_test_status='ok'        (真的通)
 *     - 400 / 405        -> ok=false, verdict='reachable' last_test_status='reachable' (可达, 但无法据此判定凭证)
 *     - 其他 4xx/5xx     -> ok=false, verdict='failed'    last_test_status='failed'    (不通)
 *   ok 严格等于 "2xx 且凭证可用", 因此不会出现 "ok:true + status:400" 这种自相矛盾的返回。
 *
 * 前置:
 *   1. npx wrangler dev --port 8787
 *   2. node tools/mock-upstream.mjs 9099   (mock 上游, 提供 /openai/v1/models 的 400 行为)
 *   3. .dev.vars 里配了 ADMIN_JWT_SECRET, 本地已存在管理员账号
 *
 * 用法:
 *   ADMIN_PASS=<管理员密码> node test/admin-account-test-e2e.mjs
 *   (未提供 ADMIN_PASS, 或 mock 上游没起, 自动跳过, 退出码 0)
 */

const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:8787';
const MOCK = process.env.MOCK_URL ?? 'http://127.0.0.1:9099';
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
  console.log(`\n=== 后台账号连通性测试 E2E @ ${BASE} ===\n`);

  if (!PASS) {
    console.log('  SKIP  未提供 ADMIN_PASS, 跳过 (用法: ADMIN_PASS=xxx node test/admin-account-test-e2e.mjs)');
    skip++;
    console.log(`\n=== 结果: ${pass} passed, ${fail} failed, ${skip} skipped ===\n`);
    process.exit(0);
  }

  // mock 上游没起就没法测, 直接跳过 (避免误报红)
  try {
    const probe = await fetch(`${MOCK}/v1/models`);
    if (probe.status !== 200) throw new Error(`status=${probe.status}`);
  } catch (e) {
    console.log(`  SKIP  mock 上游不可达 (${MOCK}): ${e.message}`);
    console.log('        先跑: node tools/mock-upstream.mjs 9099');
    skip++;
    console.log(`\n=== 结果: ${pass} passed, ${fail} failed, ${skip} skipped ===\n`);
    process.exit(0);
  }

  // ---- 登录拿会话 Cookie ----
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

  const req = async (method, path, body) => {
    const r = await fetch(`${BASE}/api/admin${path}`, {
      method,
      headers: { cookie, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await r.text();
    let json = {};
    try {
      json = JSON.parse(text);
    } catch {
      /* 非 JSON */
    }
    return { status: r.status, text, json };
  };

  const created = [];
  const makeAccount = async (name, baseUrl) => {
    const r = await req('POST', '/accounts', {
      name,
      platform: 'deepseek', // 内置平台 + 显式 protocol, 与生产里那个账号同形
      protocol: 'openai',
      type: 'apikey',
      api_key: 'sk-local-test-not-a-real-key',
      base_url: baseUrl,
    });
    check(`创建测试账号 ${name} 返回 201`, r.status === 201, r.text.slice(0, 200));
    if (r.status === 201 && r.json.id) {
      created.push(r.json.id);
      return r.json.id;
    }
    return null;
  };

  const cleanup = async () => {
    for (const id of created) {
      await req('DELETE', `/accounts/${id}`).catch(() => {});
    }
  };

  try {
    // ---- [2] 核心回归: 上游 GET /v1/models 恒 400, 不能报 ok ----
    console.log('\n[2] 上游 GET /v1/models 恒 400 (chatapi.weixin.qq.com 行为)');
    {
      const id = await makeAccount('e2e-test-400', `${MOCK}/openai`);
      if (id) {
        const r = await req('POST', `/accounts/${id}/test`);
        const msg = String(r.json.message ?? '');
        check('接口返回 200', r.status === 200, r.text.slice(0, 200));
        check('ok 为 false (不能把 400 当成功)', r.json.ok === false, JSON.stringify(r.json));
        check("verdict 为 'reachable'", r.json.verdict === 'reachable', JSON.stringify(r.json));
        check('透传上游状态 400', r.json.status === 400, `status=${r.json.status}`);
        check('message 用 Reachable 措辞', msg.includes('Reachable'), msg.slice(0, 160));
        check('message 不再以 OK ( 开头', !/^OK \(/.test(msg), msg.slice(0, 160));
        check('message 提示需用对话接口验证', msg.includes('对话接口'), msg.slice(0, 160));
        check('message 带上游原始响应', msg.includes('missing required parameter'), msg.slice(0, 200));
        check('有 latency_ms', typeof r.json.latency_ms === 'number', JSON.stringify(r.json));

        const list = await req('GET', '/accounts');
        const row = (list.json.accounts ?? []).find((a) => a.id === id);
        check('账号列表能查到该账号', !!row);
        check("last_test_status 落库为 'reachable'", row?.last_test_status === 'reachable', row?.last_test_status);
        check('last_test_message 已落库', !!row?.last_test_message, String(row?.last_test_message).slice(0, 120));
      }
    }

    // ---- [3] 上游 GET /v1/models 正常 200 -> 必须报 ok ----
    console.log('\n[3] 上游 GET /v1/models 正常返回 200');
    {
      const id = await makeAccount('e2e-test-200', MOCK);
      if (id) {
        const r = await req('POST', `/accounts/${id}/test`);
        const msg = String(r.json.message ?? '');
        check('ok 为 true', r.json.ok === true, JSON.stringify(r.json));
        check("verdict 为 'ok'", r.json.verdict === 'ok', JSON.stringify(r.json));
        check('状态 200', r.json.status === 200, `status=${r.json.status}`);
        check('message 以 OK (HTTP 200 开头', /^OK \(HTTP 200/.test(msg), msg.slice(0, 160));

        const list = await req('GET', '/accounts');
        const row = (list.json.accounts ?? []).find((a) => a.id === id);
        check("last_test_status 落库为 'ok'", row?.last_test_status === 'ok', row?.last_test_status);
      }
    }

    // ---- [4] 上游连不上 -> failed ----
    console.log('\n[4] 上游连不上 (connection refused)');
    {
      const id = await makeAccount('e2e-test-down', 'http://127.0.0.1:1');
      if (id) {
        const r = await req('POST', `/accounts/${id}/test`);
        const msg = String(r.json.message ?? '');
        check('ok 为 false', r.json.ok === false, JSON.stringify(r.json));
        check("verdict 为 'failed'", r.json.verdict === 'failed', JSON.stringify(r.json));
        check('message 标明网络错误', /Network error/i.test(msg), msg.slice(0, 160));

        const list = await req('GET', '/accounts');
        const row = (list.json.accounts ?? []).find((a) => a.id === id);
        check("last_test_status 落库为 'failed'", row?.last_test_status === 'failed', row?.last_test_status);
      }
    }
  } finally {
    await cleanup();
  }

  console.log(`\n=== 结果: ${pass} passed, ${fail} failed, ${skip} skipped ===\n`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error('测试崩溃:', e);
  process.exit(1);
});
