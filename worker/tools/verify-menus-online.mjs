/**
 * 线上验收(需要管理员密码): 新增菜单 + 去 /admin 前缀 + 每日签到。
 *
 * 与 verify-online.mjs 的分工:
 *   - verify-online.mjs 是**匿名**验收(只证明接口挂了且受保护);
 *   - 本脚本登录后验收**行为**(新页面能取数、签到真的加余额、业务用户拿不到该拿不到的)。
 *
 * 用法:
 *   ADMIN_PASS=<管理员密码> node tools/verify-menus-online.mjs
 *   未提供 ADMIN_PASS 时跳过(退出码 0)。
 */
const BASE = process.env.BASE_URL ?? 'https://sub2api.aixm.ccwu.cc';
const USER = process.env.ADMIN_USER ?? 'admin';
const PASS = process.env.ADMIN_PASS ?? '';

let pass = 0;
let fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`  PASS  ${m}`); } else { fail++; console.log(`  FAIL  ${m}`); } };

async function main() {
  if (!PASS) {
    console.log('  SKIP  未提供 ADMIN_PASS, 跳过');
    console.log('\n=== 结果: 0 passed, 0 failed, 1 skipped ===\n');
    process.exit(0);
  }

  console.log(`\n=== 新增菜单 / 去前缀 / 签到 线上验收 @ ${BASE} ===\n`);

  const lr = await fetch(`${BASE}/api/admin/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: USER, password: PASS }),
  });
  const lj = await lr.json().catch(() => ({}));
  if (lr.status !== 200) {
    console.log(`  FAIL  管理员登录失败 ${lr.status} ${JSON.stringify(lj).slice(0, 160)}`);
    console.log('\n=== 结果: 中止 ===\n');
    process.exit(1);
  }
  const cookie = (lr.headers.get('set-cookie') ?? '').split(';')[0];
  const call = async (p, init = {}) => {
    const r = await fetch(`${BASE}${p}`, {
      ...init,
      headers: { cookie, 'content-type': 'application/json', ...(init.headers ?? {}) },
      redirect: 'manual',
    });
    const text = await r.text();
    let json = {};
    try { json = JSON.parse(text); } catch { /* html/redirect */ }
    return { status: r.status, text, json };
  };

  // ---- 管理员登录响应: 菜单目录含新菜单 ----
  ok(Array.isArray(lj.menus) && lj.menus.includes('*'), '管理员 menus 含 *');

  // ---- 去前缀: 页面走 /<page>, 旧 /admin/* 404 ----
  for (const p of ['/dashboard', '/overview', '/mykeys', '/board', '/logs', '/profile']) {
    const r = await call(p);
    ok(r.status === 200, `已登录 GET ${p} -> 200 HTML(实际 ${r.status})`);
  }
  for (const p of ['/admin', '/admin/dashboard', '/admin/users']) {
    const r = await call(p);
    ok(r.status === 404, `旧路径 GET ${p} -> 404(实际 ${r.status})`);
  }

  // ---- 新页面取数 ----
  const ov = await call('/api/admin/overview');
  ok(ov.status === 200 && ov.json.counts && ov.json.last24h, 'GET /overview 有 counts + last24h');

  const bd = await call('/api/admin/board');
  ok(bd.status === 200 && bd.json.totals && Array.isArray(bd.json.by_model), 'GET /board 有 totals + by_model');
  ok(Number(bd.json.totals?.total_tokens) >= 0, '看板 total_tokens 是数字');

  const lg = await call('/api/admin/logs?limit=5');
  ok(lg.status === 200 && Array.isArray(lg.json.logs) && typeof lg.json.total === 'number',
    'GET /logs 有 logs + total');

  const pf = await call('/api/admin/profile');
  ok(pf.status === 200 && pf.json.user && pf.json.wallet && pf.json.checkin,
    'GET /profile 有 user + wallet + checkin');
  const balBefore = Number(pf.json.wallet?.balance ?? 0);

  // ---- 签到: 幂等 ----
  const ci1 = await call('/api/admin/profile/checkin', { method: 'POST' });
  if (ci1.status === 200) {
    const micro = Math.round(Number(ci1.json.amount) * 1e8);
    ok(micro >= 100 && micro <= 200, `签到金额 100~200 微美元(实际 ${micro})`);
    ok(Math.abs(Number(ci1.json.balance) - (balBefore + Number(ci1.json.amount))) < 1e-9,
      '签到后余额 = 原余额 + 金额');
    const ci2 = await call('/api/admin/profile/checkin', { method: 'POST' });
    ok(ci2.status === 409, `当天重复签到 -> 409(实际 ${ci2.status})`);
    const pf2 = await call('/api/admin/profile');
    ok(pf2.json.checkin?.checked_today === true, '签到后 checked_today=true');
    console.log('  (提示: 签到已写进生产库, 管理员今天的那次已用掉)');
  } else if (ci1.status === 409) {
    // 今天已经签过(可能是人工点过) —— 也是正确行为
    ok(true, '管理员今天已签到 -> 409(幂等正确)');
  } else {
    ok(false, `签到首次返回 200 或 409(实际 ${ci1.status} ${ci1.text.slice(0, 140)})`);
  }

  // ---- 角色权限页能列出内置 user 的新菜单 ----
  const roles = await call('/api/admin/roles');
  const bu = (roles.json.roles ?? []).find((r) => r.code === 'user');
  ok(JSON.stringify(bu?.menus) === JSON.stringify(['overview', 'mykeys', 'logs', 'profile']),
    `内置 user 角色菜单 = 概览/API秘钥/使用日志/个人资料(实际 ${JSON.stringify(bu?.menus)})`);

  console.log(`\n=== 结果: ${pass} passed, ${fail} failed ===\n`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error('✗ 异常:', e.message); process.exit(1); });
