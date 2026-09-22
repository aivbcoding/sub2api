/**
 * 管理后台「请求日志」接口测试 —— GET /api/admin/usage
 *
 * 为什么单独一个文件:
 *   e2e.mjs / translate-e2e.mjs 只用 API Key 打网关, 覆盖不到后台接口。
 *   这个接口的筛选条件是用 SQL 参数占位符拼出来的, 一旦某条 SQL 里
 *   多个 `?` 拿到同一个编号, D1 会直接抛
 *     "D1_ERROR: Wrong number of parameter bindings for SQL query."
 *   而这条路径**不经过网关**, 上面两套测试永远测不出来, 所以必须单独冒烟。
 *
 * 前置:
 *   1. npx wrangler dev --port 8787
 *   2. 本地已存在管理员账号, 且 .dev.vars 里配了 ADMIN_JWT_SECRET
 *
 * 用法:
 *   ADMIN_PASS=<管理员密码> node test/admin-usage-e2e.mjs
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
  console.log(`\n=== 后台请求日志接口 E2E @ ${BASE} ===\n`);

  if (!PASS) {
    console.log('  SKIP  未提供 ADMIN_PASS, 跳过 (用法: ADMIN_PASS=xxx node test/admin-usage-e2e.mjs)');
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
  const setCookie = loginRes.headers.get('set-cookie') ?? '';
  const cookie = setCookie.split(';')[0];
  check('登录返回 200', loginRes.status === 200, `status=${loginRes.status}`);
  check('拿到会话 Cookie', cookie.startsWith('s2a_admin_token='), cookie.slice(0, 40));
  if (loginRes.status !== 200) {
    console.log(`\n=== 结果: ${pass} passed, ${fail} failed ===\n`);
    process.exit(1);
  }

  const get = async (query) => {
    const r = await fetch(`${BASE}/api/admin/usage${query}`, { headers: { cookie } });
    const text = await r.text();
    let json = {};
    try {
      json = JSON.parse(text);
    } catch {
      /* 非 JSON */
    }
    return { status: r.status, text, json };
  };

  const isD1Error = (r) => /D1_ERROR|Wrong number of parameter bindings/i.test(r.text);

  // ---- 基础: 分页 + 统计 + facets ----
  console.log('\n[2] 基础查询 (facets=1)');
  {
    const r = await get('?facets=1&limit=3');
    check('返回 200', r.status === 200, r.text.slice(0, 200));
    check('没有 D1 绑定错误', !isD1Error(r), r.text.slice(0, 200));
    check('含 total / limit / offset', typeof r.json.total === 'number' && r.json.limit === 3);
    check('logs 是数组', Array.isArray(r.json.logs));
    check('logs 数量不超过 limit', (r.json.logs ?? []).length <= 3);
    const s = r.json.stats ?? {};
    check(
      'stats 字段齐全',
      ['total', 'errors', 'success', 'success_rate', 'input_tokens', 'output_tokens', 'total_cost', 'avg_duration_ms']
        .every((k) => k in s),
      JSON.stringify(s).slice(0, 200),
    );
    check('stats.total 与 total 一致', s.total === r.json.total, `${s.total} vs ${r.json.total}`);
    check('success + errors === total', s.success + s.errors === s.total, JSON.stringify({ s }));
    check(
      'facets 下拉齐全 (models/users/keys/groups/accounts)',
      ['models', 'users', 'keys', 'groups', 'accounts'].every((k) => Array.isArray(r.json.filters?.[k])),
      Object.keys(r.json.filters ?? {}).join(','),
    );
  }

  // ---- 行内 JOIN 字段 (用户 / 额度 / 配额) ----
  console.log('\n[3] 明细行 JOIN 字段');
  {
    const r = await get('?limit=50');
    const rows = r.json.logs ?? [];
    check('有日志行可用于校验', rows.length > 0, `rows=${rows.length}`);
    if (rows.length) {
      const keys = new Set(Object.keys(rows[0]));
      const want = [
        'user_email', 'user_balance', 'key_name', 'key_quota', 'key_quota_used',
        'account_name', 'group_name', 'status', 'created_at',
      ];
      check(
        '包含 用户邮箱/余额/Key名/额度/账号/分组/状态 字段',
        want.every((k) => keys.has(k)),
        want.filter((k) => !keys.has(k)).join(','),
      );
      check('status 取值合法', rows.every((l) => l.status === 'success' || l.status === 'error'));
      const err = rows.find((l) => l.status === 'error');
      if (err) {
        check('失败行带 error 详情', !!(err.error && 'platform' in err.error && 'status' in err.error));
      }
    }
  }

  // ---- 各筛选条件 (占位符绑定的回归点) ----
  console.log('\n[4] 筛选条件');
  const cases = [
    ['状态=失败', '?status=error&limit=2'],
    ['状态=成功', '?status=success&limit=2'],
    ['关键词(多占位符 OR)', '?keyword=admin&limit=2'],
    ['日期区间', '?start=2020-01-01&end=2020-01-02&limit=2'],
    ['模型 + 用户 + 状态', '?model=gpt-4o&user_id=1&status=success&limit=2'],
    ['key + 分组 + 账号', '?api_key_id=1&group_id=1&account_id=2&limit=2'],
    ['分页 offset', '?offset=1&limit=1'],
    ['全部条件叠加', '?keyword=o&status=success&model=gpt-4o&user_id=1&group_id=1&api_key_id=1&account_id=2&start=2000-01-01&end=2999-01-01&limit=2'],
  ];
  for (const [name, q] of cases) {
    const r = await get(q);
    check(`${name} -> 200`, r.status === 200, r.text.slice(0, 160));
    check(`${name} -> 无 D1 错误`, !isD1Error(r), r.text.slice(0, 160));
    check(`${name} -> 统计自洽`, (r.json.stats?.total ?? 0) === r.json.total, JSON.stringify(r.json.stats ?? {}).slice(0, 120));
  }

  // ---- 非法输入不应 500 ----
  console.log('\n[5] 边界输入');
  for (const [name, q] of [
    ['超限 limit=99999', '?limit=99999'],
    ['负 offset', '?offset=-5&limit=1'],
    ['非数字 user_id', '?user_id=abc&limit=1'],
    ['空关键词', '?keyword=&limit=1'],
  ]) {
    const r = await get(q);
    check(`${name} 不返回 5xx`, r.status < 500, `status=${r.status} ${r.text.slice(0, 120)}`);
  }

  console.log(`\n=== 结果: ${pass} passed, ${fail} failed ===\n`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error('后台日志接口 E2E 运行失败:', e.message);
  process.exit(1);
});
