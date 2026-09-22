#!/usr/bin/env node
/**
 * 「统一登录 + 角色菜单权限 + 自助 Key」端到端测试
 *
 * 覆盖的事(全部都要真的登录、真的发请求, 静态守卫管不到这些):
 *   [1] 统一登录: 管理员用 users 表的账号密码登录, 响应带回 role/menus
 *   [2] 未登录访问 / 与 /admin/* 会 302 到 /login; /login 自己不重定向(避免死循环)
 *   [3] 角色 CRUD: 新建自定义角色、内置角色不可改/不可删、被引用的角色不可删
 *   [4] 菜单权限就是接口权限: 业务用户拿不到菜单的接口一律 403, 不是"藏起来"
 *   [5] 自助 Key: 只能看/发/删自己的, 越权删除要 404 而不是"删成功"
 *   [6] 自助改密: 改的是自己那一行, 改完新密码能登、旧密码不能登
 *   [7] 停用即失活: 管理员一停用, 该用户**已有的会话**立刻用不了(不用等 token 过期)
 *   [8] 角色菜单改了立即生效: 不需要用户重新登录
 *   [9] /portal 与 /api/portal/* 必须彻底消失(不再有第二个登录入口)
 *
 * 用法:
 *   ADMIN_PASS=<管理员密码> node tools/run-e2e.mjs 8787 test/console-e2e.mjs
 *   未提供 ADMIN_PASS 时自动跳过(退出码 0), 便于无人值守跑全量。
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

/** 带 cookie 的请求助手 */
function makeCall(cookie) {
  return async (path, init = {}) => {
    const r = await fetch(`${BASE}${path}`, {
      ...init,
      headers: { cookie, 'content-type': 'application/json', ...(init.headers ?? {}) },
      redirect: init.redirect ?? 'manual',
    });
    const text = await r.text();
    let json = {};
    try { json = JSON.parse(text); } catch { /* 非 JSON(HTML/重定向) */ }
    return { status: r.status, text, json, headers: r.headers };
  };
}

async function login(who, pwd) {
  const r = await fetch(`${BASE}/api/admin/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: who, password: pwd }),
  });
  const text = await r.text();
  let json = {};
  try { json = JSON.parse(text); } catch { /* ignore */ }
  return {
    status: r.status,
    json,
    text,
    cookie: (r.headers.get('set-cookie') ?? '').split(';')[0],
  };
}

async function main() {
  console.log(`\n=== 统一登录 / 角色菜单 E2E @ ${BASE} ===\n`);

  if (!PASS) {
    console.log('  SKIP  未提供 ADMIN_PASS, 跳过 (用法: ADMIN_PASS=xxx node tools/run-e2e.mjs 8787 test/console-e2e.mjs)');
    console.log('\n=== 结果: 0 passed, 0 failed, 1 skipped ===\n');
    process.exit(0);
  }

  // ---- [0] 路由: 根目录即控制台, 未登录 302 到 /login ----
  console.log('\n[0] 根目录 / 未登录重定向 / 门户已消失');
  {
    const root = await fetch(`${BASE}/`, { redirect: 'manual' });
    check('未登录 GET / -> 302', root.status === 302, `status=${root.status}`);
    check('Location 指向 /login', (root.headers.get('location') ?? '') === '/login',
      `location=${root.headers.get('location')}`);
    check('重定向带 no-store(不被浏览器缓存)', (root.headers.get('cache-control') ?? '').includes('no-store'));

    // 2026-09-21: 菜单路径去掉 /admin 前缀, 直接挂根下 —— 深链接换成 /users
    const deep = await fetch(`${BASE}/users`, { redirect: 'manual' });
    check('未登录 GET /users -> 302', deep.status === 302, `status=${deep.status}`);
    check('深链接重定向带 next= 以便登录后回跳',
      (deep.headers.get('location') ?? '').includes('next='),
      `location=${deep.headers.get('location')}`);

    // 旧前缀必须彻底消失(用户选择"彻底删掉 /admin 路由")
    const oldAdmin = await fetch(`${BASE}/admin/users`, { redirect: 'manual' });
    check('旧路径 GET /admin/users 已 404(不再重定向)', oldAdmin.status === 404, `status=${oldAdmin.status}`);

    const lg = await fetch(`${BASE}/login`, { redirect: 'manual' });
    check('GET /login -> 200 页面(自身不再重定向, 否则死循环)', lg.status === 200, `status=${lg.status}`);
    const lgHtml = await lg.text();
    check('/login 返回 HTML 且含登录表单', lgHtml.includes('id="login-view"') && lgHtml.includes('id="login-btn"'));
    check('登录页文案不写死"管理员"(业务用户也要能进)', !lgHtml.includes('请输入管理员账号和密码'));

    const info = await fetch(`${BASE}/api/info`);
    const infoJson = await info.json().catch(() => ({}));
    check('GET /api/info -> 200(原根 JSON 信息搬到这里)', info.status === 200, `status=${info.status}`);
    check('/api/info 有 endpoints 列表', Array.isArray(infoJson.endpoints));
    check('/api/info 指向 console 与 login', infoJson.console === '/dashboard' && infoJson.login === '/login',
      JSON.stringify(infoJson).slice(0, 160));

    const portal = await fetch(`${BASE}/portal`, { redirect: 'manual' });
    check('GET /portal 已不存在(404)', portal.status === 404, `status=${portal.status}`);
    const papi = await fetch(`${BASE}/api/portal/config`, { redirect: 'manual' });
    check('GET /api/portal/config 已不存在(404)', papi.status === 404, `status=${papi.status}`);
  }

  // ---- [1] 统一登录 ----
  console.log('\n[1] 统一登录 (users 表)');
  const admin = await login(USER, PASS);
  check('管理员登录 200', admin.status === 200, admin.text.slice(0, 200));
  check('登录响应带回 role', admin.json.role === 'admin', JSON.stringify(admin.json).slice(0, 200));
  check('登录响应带回 menus 且含 *', Array.isArray(admin.json.menus) && admin.json.menus.includes('*'),
    JSON.stringify(admin.json.menus));
  check('登录响应 is_admin=true', admin.json.is_admin === true);
  if (admin.status !== 200) {
    console.log('\n=== 结果: 中止(管理员登录失败) ===\n');
    process.exit(1);
  }

  const call = makeCall(admin.cookie);

  {
    const me = await call('/api/admin/me');
    check('GET /me 200 且带 role/menus', me.status === 200 && me.json.role === 'admin' && Array.isArray(me.json.menus),
      me.text.slice(0, 200));
    const html = await call('/dashboard');
    check('已登录 GET /dashboard -> 200 HTML(不再重定向)', html.status === 200, `status=${html.status}`);
    const oldAdminPage = await call('/admin');
    check('旧路径 GET /admin 已 404', oldAdminPage.status === 404, `status=${oldAdminPage.status}`);
    const rootAuthed = await call('/');
    check('已登录 GET / -> 200(根目录就是控制台)', rootAuthed.status === 200, `status=${rootAuthed.status}`);
    const wrong = await login(USER, 'definitely-not-the-password');
    check('错误密码 -> 401', wrong.status === 401, `status=${wrong.status}`);
    const noSuch = await login(`nobody-${Date.now()}@local`, 'whatever123');
    check('不存在的账号 -> 401(与密码错同一文案, 不泄露账号是否存在)',
      noSuch.status === 401 && noSuch.json.error.message === wrong.json.error.message,
      `${noSuch.status}/${wrong.json.error.message} vs ${noSuch.json.error.message}`);

    // ---- 畸形/伪造 cookie 必须 401, 绝不能 500(攻击者可控输入) ----
    // 起因: 线上验收发现 `s2a_admin_token=forged.token.value` 返回 500 ——
    // 第三段 `value` 长度不是 4 的倍数, atob 抛 InvalidCharacterError 冒到顶层。
    const forged = await fetch(`${BASE}/api/admin/me`, {
      headers: { cookie: 's2a_admin_token=forged.token.value' },
    });
    check('伪造会话 cookie(3 段) -> 401 而非 500', forged.status === 401, `status=${forged.status}`);
    const twoPart = await fetch(`${BASE}/api/admin/me`, {
      headers: { cookie: 's2a_admin_token=only.two' },
    });
    check('两段式 token -> 401', twoPart.status === 401, `status=${twoPart.status}`);
    const malformedPct = await fetch(`${BASE}/api/admin/me`, {
      headers: { cookie: 's2a_admin_token=%zz%zz' },
    });
    check('畸形 % 转义 cookie -> 401', malformedPct.status === 401, `status=${malformedPct.status}`);
    const emptyPwd = await fetch(`${BASE}/api/admin/me`, {
      headers: { cookie: 's2a_admin_token=' },
    });
    check('空 token -> 401', emptyPwd.status === 401, `status=${emptyPwd.status}`);
  }

  const stamp = Date.now();
  const createdUsers = [];
  const createdRoles = [];

  try {
    // ---- [2] 角色 CRUD ----
    console.log('\n[2] 角色表 CRUD 与内置角色保护');
    const roles0 = await call('/api/admin/roles');
    check('GET /roles 200', roles0.status === 200, roles0.text.slice(0, 200));
    const builtin = roles0.json.roles ?? [];
    check('内置角色 admin 存在且 menus=[*]',
      builtin.some((r) => r.code === 'admin' && r.menus.includes('*') && r.builtin === true));
    // 2026-09-21: 内置业务角色 menus 扩为 概览/API秘钥/使用日志/个人资料
    // (数据看板 board 故意不给业务用户 —— 它默认只归管理员)
    check('内置角色 user 存在且菜单为 overview/mykeys/logs/profile',
      builtin.some((r) => r.code === 'user' &&
        JSON.stringify(r.menus) === JSON.stringify(['overview', 'mykeys', 'logs', 'profile'])),
      JSON.stringify(builtin.find((r) => r.code === 'user')?.menus));
    check('内置角色 user 不含数据看板 board(默认只归管理员)',
      !(builtin.find((r) => r.code === 'user')?.menus ?? []).includes('board'));
    check('回传 menu_catalog 供前端渲染勾选框', Array.isArray(roles0.json.menu_catalog) && roles0.json.menu_catalog.length >= 17,
      `len=${(roles0.json.menu_catalog ?? []).length}`);
    const menuKeys = (roles0.json.menu_catalog ?? []).map((m) => m.key);
    check('menu_catalog 含新增四个菜单(overview/board/logs/profile)',
      ['overview', 'board', 'logs', 'profile'].every((k) => menuKeys.includes(k)),
      JSON.stringify(menuKeys));

    const adminRole = builtin.find((r) => r.code === 'admin');
    const tryAdminEdit = await call(`/api/admin/roles/${adminRole.id}`, {
      method: 'PUT',
      body: JSON.stringify({ menus: ['mykeys'] }),
    });
    check('超级管理员角色的权限不可修改(400)', tryAdminEdit.status === 400, tryAdminEdit.text.slice(0, 200));
    const tryAdminDel = await call(`/api/admin/roles/${adminRole.id}`, { method: 'DELETE' });
    check('内置角色不可删除(400)', tryAdminDel.status === 400, tryAdminDel.text.slice(0, 200));

    const newRole = await call('/api/admin/roles', {
      method: 'POST',
      body: JSON.stringify({
        code: `e2e-biz-${stamp}`,
        name: 'E2E 业务用户',
        menus: ['mykeys', 'usage', 'settings', 'nonsense-key', 'overview'],
        description: 'e2e',
      }),
    });
    check('新建角色 201', newRole.status === 201, newRole.text.slice(0, 200));
    const roleId = newRole.json.id;
    createdRoles.push(roleId);

    const roles1 = await call('/api/admin/roles');
    const role = (roles1.json.roles ?? []).find((r) => r.id === roleId) ?? {};
    check('未知菜单键被过滤掉(只留下合法键)',
      JSON.stringify(role.menus) === JSON.stringify(['overview', 'mykeys', 'usage', 'settings']),
      JSON.stringify(role.menus));

    const dupRole = await call('/api/admin/roles', {
      method: 'POST',
      body: JSON.stringify({ code: `e2e-biz-${stamp}`, name: 'dup' }),
    });
    check('重复角色代码 -> 400', dupRole.status === 400, dupRole.text.slice(0, 160));
    const badCode = await call('/api/admin/roles', {
      method: 'POST',
      body: JSON.stringify({ code: 'BAD CODE!', name: 'bad' }),
    });
    check('非法角色代码 -> 400', badCode.status === 400, badCode.text.slice(0, 160));

    // ---- [3] 建一个业务用户, 用它的身份验证权限边界 ----
    console.log('\n[3] 业务用户登录 (邮箱登录) + 菜单权限就是接口权限');
    const bizEmail = `e2e-biz-${stamp}@local`;
    const BIZ_PWD = 'biz-password-1';
    const bu = await call('/api/admin/users', {
      method: 'POST',
      body: JSON.stringify({
        email: bizEmail,
        username: `e2e业务${stamp}`,
        password: BIZ_PWD,
        role: `e2e-biz-${stamp}`,
      }),
    });
    check('创建业务用户 201', bu.status === 201, bu.text.slice(0, 200));
    const bizId = bu.json.id;
    createdUsers.push(bizId);

    const bizLogin = await login(bizEmail, BIZ_PWD);
    check('业务用户可用**邮箱**登录(统一登录页)', bizLogin.status === 200, bizLogin.text.slice(0, 200));
    check('业务用户 menus 只有自己角色配的菜单',
      JSON.stringify(bizLogin.json.menus) === JSON.stringify(['overview', 'mykeys', 'usage', 'settings']),
      JSON.stringify(bizLogin.json.menus));
    check('业务用户 is_admin=false', bizLogin.json.is_admin === false);

    const biz = makeCall(bizLogin.cookie);

    const allowed = await biz('/api/admin/my/keys');
    check('有 mykeys 菜单 -> GET /my/keys 200', allowed.status === 200, allowed.text.slice(0, 200));

    // 有 overview 菜单 -> 概览页接口应放行, 且只回自己的数据
    const ov = await biz('/api/admin/overview');
    check('有 overview 菜单 -> /overview 200', ov.status === 200, ov.text.slice(0, 160));

    for (const [path, label] of [
      ['/api/admin/dashboard', '总览'],
      ['/api/admin/board', '数据看板'],
      ['/api/admin/logs', '使用日志'],
      ['/api/admin/profile', '个人资料'],
      ['/api/admin/users', '用户'],
      ['/api/admin/accounts', '上游账号'],
      ['/api/admin/api-keys', 'API Key'],
      ['/api/admin/groups', '分组'],
      ['/api/admin/roles', '角色权限'],
      ['/api/admin/audit', '操作审计'],
      ['/api/admin/models', '模型定价'],
    ]) {
      const r = await biz(path);
      check(`无「${label}」菜单 -> ${path} 403(前端藏起来不算, 接口也要拦)`, r.status === 403,
        `status=${r.status} ${r.text.slice(0, 120)}`);
    }
    const okUsage = await biz('/api/admin/usage?limit=5');
    check('有 usage 菜单 -> /usage 200', okUsage.status === 200, okUsage.text.slice(0, 160));
    // usage 对非超管强制只看自己: 随机挑 500 条也不可能全是同一人的日志, 这里只验证
    // "回传的 user_id 全部等于自己" —— 库里有别人的日志时这条才真正有鉴别力
    const logs = okUsage.json.logs ?? [];
    check('/usage 对非超管只返回自己的日志',
      logs.every((l) => Number(l.user_id) === Number(bizId)),
      `bizId=${bizId} ids=${[...new Set(logs.map((l) => l.user_id))].join(',')}`);
    const unknown = await biz('/api/admin/definitely-not-a-resource');
    check('未登记资源 -> 404', unknown.status === 404, `status=${unknown.status}`);

    // ---- [4] 自助 Key ----
    console.log('\n[4] 自助 API Key (只能碰自己的)');
    const mk = await biz('/api/admin/my/keys', {
      method: 'POST',
      body: JSON.stringify({ name: 'e2e-self', group_id: 1, quota: 999, status: 'disabled' }),
    });
    check('POST /my/keys 201', mk.status === 201, mk.text.slice(0, 200));
    check('回传明文 Key', typeof mk.json.key === 'string' && mk.json.key.startsWith('sk-'), JSON.stringify(mk.json).slice(0, 120));
    // 格式钉死: sk- + 32 位 UUID(去连字符) = 35 字符。改生成器时这里会立刻红。
    check('自助 Key 格式 = sk- + 32 位 UUID(总长 35)',
      /^sk-[0-9a-f]{32}$/.test(String(mk.json.key ?? '')),
      `key=${JSON.stringify(mk.json.key)} len=${String(mk.json.key ?? '').length}`);
    check('自助 Key 一定挂了真实分组(group_id 非空)', Number.isInteger(Number(mk.json.group_id)) && Number(mk.json.group_id) > 0,
      `group_id=${JSON.stringify(mk.json.group_id)}`);
    const myKeyId = mk.json.id;

    const myKeys = await biz('/api/admin/my/keys');
    const mine = (myKeys.json.api_keys ?? []).find((k) => k.id === myKeyId) ?? {};
    check('自己的 Key 出现在自己的列表里', !!mine.id);
    check('自助创建的 Key 忽略请求体里的 quota/status(不能自助提权)',
      Number(mine.quota) === 0 && mine.status === 'active',
      `quota=${mine.quota} status=${mine.status}`);

    // 管理员给自己发一把, 用来验证"删别人的 Key"删不掉
    const adminKey = await call('/api/admin/my/keys', {
      method: 'POST',
      body: JSON.stringify({ name: 'e2e-admin-key' }),
    });
    check('管理员也能用同一套自助接口', adminKey.status === 201, adminKey.text.slice(0, 160));
    const adminKeyId = adminKey.json.id;

    // 重新拉一次业务用户的列表(此时管理员那把已存在), 确认它看不到别人的
    const bizKeys2 = await biz('/api/admin/my/keys');
    const ids = (bizKeys2.json.api_keys ?? []).map((k) => k.id);
    check('业务用户列表里看不到别人的 Key', !ids.includes(adminKeyId), `ids=${ids.join(',')} adminKeyId=${adminKeyId}`);
    check('业务用户列表只含自己名下的 Key', (bizKeys2.json.api_keys ?? []).length === 1, `count=${ids.length}`);

    const crossDel = await biz(`/api/admin/my/keys/${adminKeyId}`, { method: 'DELETE' });
    check('越权删除别人的 Key -> 404(不是"删成功")', crossDel.status === 404, `status=${crossDel.status}`);
    const stillThere = await call('/api/admin/my/keys');
    check('管理员的 Key 仍然在(越权删除真的没生效)',
      (stillThere.json.api_keys ?? []).some((k) => k.id === adminKeyId));

    const delOwn = await biz(`/api/admin/my/keys/${myKeyId}`, { method: 'DELETE' });
    check('删除自己的 Key 200', delOwn.status === 200, delOwn.text.slice(0, 160));
    const delAgain = await biz(`/api/admin/my/keys/${myKeyId}`, { method: 'DELETE' });
    check('再删一次 -> 404(已软删除)', delAgain.status === 404, `status=${delAgain.status}`);
    await call(`/api/admin/my/keys/${adminKeyId}`, { method: 'DELETE' });

    const myUsage = await biz('/api/admin/my/usage?limit=5');
    check('GET /my/usage 200', myUsage.status === 200, myUsage.text.slice(0, 160));
    check('/my/usage 回传 logs 数组且不超过 limit', Array.isArray(myUsage.json.logs) && myUsage.json.logs.length <= 5,
      `len=${(myUsage.json.logs ?? []).length}`);

    // ---- [5] 改角色菜单立即生效(不需要重新登录) ----
    console.log('\n[5] 角色菜单改动立即生效');
    const upd = await call(`/api/admin/roles/${roleId}`, {
      method: 'PUT',
      body: JSON.stringify({ menus: ['mykeys'] }),
    });
    check('PUT /roles/:id 200', upd.status === 200, upd.text.slice(0, 160));
    const afterUpd = await biz('/api/admin/usage?limit=1');
    check('同一条会话立刻失去 usage 权限(403, 无需重新登录)', afterUpd.status === 403,
      `status=${afterUpd.status}`);
    const stillMine = await biz('/api/admin/my/keys');
    check('mykeys 菜单还在, 仍然可用', stillMine.status === 200);
    // 改回来(并且加上 users/settings), 顺便验证菜单能加
    await call(`/api/admin/roles/${roleId}`, {
      method: 'PUT',
      body: JSON.stringify({ menus: ['mykeys', 'users', 'settings'] }),
    });
    const nowUsers = await biz('/api/admin/users');
    check('加上 users 菜单后立刻可读用户列表', nowUsers.status === 200, nowUsers.text.slice(0, 160));

    // ---- [6] 非超管不能改角色(即使有 users 菜单) ----
    console.log('\n[6] 非超管越权提权的两条路都被堵住');
    const escPut = await biz(`/api/admin/users/${bizId}`, {
      method: 'PUT',
      body: JSON.stringify({ role: 'admin' }),
    });
    check('有 users 菜单但不是超管 -> 改角色被 403', escPut.status === 403, escPut.text.slice(0, 200));
    const escPost = await biz('/api/admin/users', {
      method: 'POST',
      body: JSON.stringify({ email: `e2e-esc-${stamp}@local`, role: 'admin' }),
    });
    check('非超管建号时也不能指定 admin 角色', escPost.status === 403, escPost.text.slice(0, 200));

    // ---- [7] 停用 -> 已有会话立即失活 ----
    console.log('\n[7] 停用即失活(不等 token 过期)');
    const disable = await call(`/api/admin/users/${bizId}`, {
      method: 'PUT',
      body: JSON.stringify({ status: 'disabled' }),
    });
    check('管理员停用该用户 200', disable.status === 200, disable.text.slice(0, 160));
    const afterDisable = await biz('/api/admin/my/keys');
    check('被停用后旧会话立刻 403', afterDisable.status === 403, `status=${afterDisable.status}`);
    const relogin = await login(bizEmail, BIZ_PWD);
    check('被停用的账号无法重新登录(403)', relogin.status === 403, `status=${relogin.status}`);
    await call(`/api/admin/users/${bizId}`, { method: 'PUT', body: JSON.stringify({ status: 'active' }) });

    // ---- [8] 自助改密 ----
    console.log('\n[8] 自助改密 (改的是自己那一行)');
    const relogin2 = await login(bizEmail, BIZ_PWD);
    check('重新启用后能登录', relogin2.status === 200, `status=${relogin2.status}`);
    const biz2 = makeCall(relogin2.cookie);
    const NEW_PWD = 'biz-password-2';
    const chg = await biz2('/api/admin/settings', {
      method: 'PUT',
      body: JSON.stringify({ new_password: NEW_PWD }),
    });
    check('PUT /settings new_password 200', chg.status === 200, chg.text.slice(0, 200));
    const oldPwdLogin = await login(bizEmail, BIZ_PWD);
    check('旧密码不能再登录', oldPwdLogin.status === 401, `status=${oldPwdLogin.status}`);
    const newPwdLogin = await login(bizEmail, NEW_PWD);
    check('新密码可以登录', newPwdLogin.status === 200, `status=${newPwdLogin.status}`);
    const biz3 = makeCall(newPwdLogin.cookie);
    const shortPwd = await biz3('/api/admin/settings', {
      method: 'PUT',
      body: JSON.stringify({ new_password: 'short' }),
    });
    check('过短的新密码被拒(400)', shortPwd.status === 400, shortPwd.text.slice(0, 160));

    // ---- [9] 用户管理: 创建时间 + 角色候选 ----
    console.log('\n[9] 用户管理 新增创建时间列 + 角色候选');
    const list = await call('/api/admin/users');
    check('GET /users 200', list.status === 200, list.text.slice(0, 160));
    const one = (list.json.users ?? []).find((u) => u.id === bizId) ?? {};
    check('用户对象带 created_at', typeof one.created_at === 'string' && one.created_at.length >= 10,
      JSON.stringify(one.created_at));
    check('用户对象带 role', one.role === `e2e-biz-${stamp}`, String(one.role));
    check('GET /users 一并回传 roles 候选(供角色下拉)', Array.isArray(list.json.roles) && list.json.roles.length >= 2,
      JSON.stringify(list.json.roles ?? []).slice(0, 160));
    check('roles 候选里含新建的自定义角色',
      (list.json.roles ?? []).some((r) => r.code === `e2e-biz-${stamp}`));

    // ---- [10] 被引用的角色不可删 ----
    console.log('\n[10] 角色被引用时不可删除');
    const delInUse = await call(`/api/admin/roles/${roleId}`, { method: 'DELETE' });
    check('仍有用户在用 -> 400', delInUse.status === 400, delInUse.text.slice(0, 200));

    const used = await call('/api/admin/roles');
    const r10 = (used.json.roles ?? []).find((r) => r.id === roleId) ?? {};
    check('角色列表回传 user_count', Number(r10.user_count) >= 1, `user_count=${r10.user_count}`);

    // ---- [11] 自助注册 (公开接口) ----
    // 注册是**唯一**没有会话也能写的入口, 所以重点验: 能注册、但夹带的特权字段一律无效。
    console.log('\n[11] 自助注册 (公开接口)');
    const regEmail = `e2e-reg-${stamp}@local`;
    const REG_PWD = 'register-pwd-1';
    const postRegister = (payload) =>
      fetch(`${BASE}/api/admin/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });

    const rcfgRes = await fetch(`${BASE}/api/admin/register`);
    check('GET /register 配置 200(公开, 无需会话)', rcfgRes.status === 200, `status=${rcfgRes.status}`);
    const rcfg = await rcfgRes.json().catch(() => ({}));
    check('配置含 enabled / auto_approve / min_password_length',
      typeof rcfg.enabled === 'boolean' && typeof rcfg.auto_approve === 'boolean' &&
        Number(rcfg.min_password_length) >= 8,
      JSON.stringify(rcfg));

    // 故意夹带 role=admin / balance / status —— 一个都不能生效
    const regRes = await postRegister({
      email: regEmail,
      username: `e2eReg${stamp}`,
      password: REG_PWD,
      role: 'admin',
      balance: 999999,
      status: 'active',
      platform_access: 'openai,gemini',
    });
    const regJson = await regRes.json().catch(() => ({}));
    check('未登录也能注册 200', regRes.status === 200,
      `${regRes.status} ${JSON.stringify(regJson).slice(0, 200)}`);
    check('注册默认直接可用(auto_approved=true)', regJson.auto_approved === true, JSON.stringify(regJson));
    const regId = regJson.id;
    if (regId) createdUsers.push(regId);

    const regLogin = await login(regEmail, REG_PWD);
    check('注册后可以立即登录', regLogin.status === 200, regLogin.text.slice(0, 200));
    check('注册账号 role=user(夹带的 role:admin 被忽略)', regLogin.json.role === 'user',
      String(regLogin.json.role));
    check('注册账号菜单 = 内置业务角色(overview/mykeys/logs/profile)',
      JSON.stringify(regLogin.json.menus) === JSON.stringify(['overview', 'mykeys', 'logs', 'profile']),
      JSON.stringify(regLogin.json.menus));
    check('注册账号 is_admin=false', regLogin.json.is_admin === false);

    const regCall = makeCall(regLogin.cookie);
    const regDenied = await regCall('/api/admin/users');
    check('注册账号访问用户管理 -> 403(无该菜单)', regDenied.status === 403, `status=${regDenied.status}`);
    const regBoard = await regCall('/api/admin/board');
    check('注册账号访问数据看板 -> 403(未授予该菜单)', regBoard.status === 403, `status=${regBoard.status}`);
    const regMine = await regCall('/api/admin/my/keys');
    check('注册账号可以看自己的 Key', regMine.status === 200, `status=${regMine.status}`);
    const regProfile = await regCall('/api/admin/profile');
    check('注册账号可以看自己的个人资料', regProfile.status === 200, `status=${regProfile.status}`);
    const regLogs = await regCall('/api/admin/logs?limit=5');
    check('注册账号可以看自己的使用日志(200)且只回自己的',
      regLogs.status === 200 && (regLogs.json.logs ?? []).every((l) => Number(l.user_id) === Number(regId)),
      `status=${regLogs.status}`);

    const regRow = ((await call('/api/admin/users')).json.users ?? []).find((u) => u.id === regId) ?? {};
    check('注册账号余额 0 / 平台白名单为空(夹带字段被忽略)',
      Number(regRow.balance) === 0 && String(regRow.platform_access ?? '') === '',
      JSON.stringify({ balance: regRow.balance, pa: regRow.platform_access }));

    const dupRes = await postRegister({ email: regEmail, password: REG_PWD });
    check('重复邮箱注册 -> 409', dupRes.status === 409, `status=${dupRes.status}`);
    const shortRes = await postRegister({ email: `e2e-short-${stamp}@local`, password: 'short' });
    check('过短密码 -> 400', shortRes.status === 400, `status=${shortRes.status}`);
    const badMail = await postRegister({ email: 'not-an-email', password: REG_PWD });
    check('非法邮箱 -> 400', badMail.status === 400, `status=${badMail.status}`);
    const spaced = await postRegister({ email: `  E2E-Case-${stamp}@Local  `, password: REG_PWD });
    check('邮箱大小写/空格归一化后仍可注册', spaced.status === 200, `status=${spaced.status}`);
    const spacedJson = await spaced.json().catch(() => ({}));
    if (spacedJson.id) createdUsers.push(spacedJson.id);
    const caseDup = await postRegister({ email: `e2e-case-${stamp}@local`, password: REG_PWD });
    check('归一化后同邮箱仍判重 -> 409', caseDup.status === 409, `status=${caseDup.status}`);

    // ---- [12] 关闭注册后接口一律 403 ----
    console.log('\n[12] 关闭注册');
    await call('/api/admin/settings', {
      method: 'PUT',
      body: JSON.stringify({ settings: { registration_enabled: 'false' } }),
    });
    try {
      const offCfg = await (await fetch(`${BASE}/api/admin/register`)).json().catch(() => ({}));
      check('关闭后配置 enabled=false', offCfg.enabled === false, JSON.stringify(offCfg));
      const offRes = await postRegister({ email: `e2e-off-${stamp}@local`, password: REG_PWD });
      check('关闭注册后 POST -> 403', offRes.status === 403, `status=${offRes.status}`);
    } finally {
      // 必须恢复, 否则本地库会一直关着注册, 后面的用例/人工验证都会被坑
      await call('/api/admin/settings', {
        method: 'PUT',
        body: JSON.stringify({ settings: { registration_enabled: 'true' } }),
      });
    }
    const backOn = await (await fetch(`${BASE}/api/admin/register`)).json().catch(() => ({}));
    check('恢复后注册重新可用', backOn.enabled === true, JSON.stringify(backOn));

    // ---- [13] 新增菜单: 概览 / 数据看板 / 使用日志 / 个人资料 ----
    console.log('\n[13] 新增菜单接口(概览/数据看板/使用日志/个人资料)');
    const ov2 = await call('/api/admin/overview');
    check('管理员 GET /overview 200', ov2.status === 200, ov2.text.slice(0, 200));
    check('/overview 含额度(me.balance)/用量概览(last24h)/历史(history)/公告/请求计数(counts)',
      ov2.json.me?.balance !== undefined && ov2.json.last24h !== undefined &&
        Array.isArray(ov2.json.history) && ov2.json.counts?.total_requests !== undefined &&
        typeof ov2.json.announcement === 'string',
      JSON.stringify(ov2.json).slice(0, 240));

    const board = await call('/api/admin/board');
    check('管理员 GET /board 200', board.status === 200, board.text.slice(0, 200));
    check('/board 含模型调用分析(by_model) + token 总数(totals.total_tokens) + 消耗分布(by_platform/by_key)',
      board.json.totals?.total_tokens !== undefined && Array.isArray(board.json.by_model) &&
        Array.isArray(board.json.by_platform) && Array.isArray(board.json.by_key),
      JSON.stringify(board.json).slice(0, 220));

    const selfLogs = await call('/api/admin/logs?limit=5');
    check('管理员 GET /logs 200', selfLogs.status === 200, selfLogs.text.slice(0, 200));
    check('/logs 回传 logs 数组 + total + summary',
      Array.isArray(selfLogs.json.logs) && typeof selfLogs.json.total === 'number' && typeof selfLogs.json.summary === 'object',
      JSON.stringify(selfLogs.json).slice(0, 200));
    check('/logs 里没有完整明文 Key(列表一律打码)',
      (selfLogs.json.logs ?? []).every((l) => !l.key_value || l.key_value.includes('*') || l.key_value === ''),
      JSON.stringify((selfLogs.json.logs ?? [])[0]?.key_value ?? ''));
    // 2026-09-22: 使用日志是**业务用户**的页面 —— 上游模型名 / 上游账号 / User-Agent 一律不下发
    const LEAK = ['upstream_model', 'user_agent', 'account_name', 'account_platform'];
    const leakKeys = LEAK.filter((k) => (selfLogs.json.logs ?? []).some((l) => k in l));
    check('🧨 /logs 不下发上游与 UA 字段(业务用户看不到上游)',
      leakKeys.length === 0, `泄漏字段=${leakKeys.join(',')}`);
    check('/logs 仍下发用户需要的字段(模型/令牌/费用)',
      (selfLogs.json.logs ?? []).every((l) => 'model' in l && 'key_name' in l && 'cost' in l),
      JSON.stringify((selfLogs.json.logs ?? [])[0] ?? {}).slice(0, 200));
    const fmLogs = await call('/api/admin/logs?limit=3&status=error');
    check('/logs 支持 status=error 过滤(200)', fmLogs.status === 200, fmLogs.text.slice(0, 160));

    const prof = await call('/api/admin/profile');
    check('管理员 GET /profile 200', prof.status === 200, prof.text.slice(0, 200));
    check('/profile 含 user/wallet/checkin 三块',
      prof.json.user !== undefined && prof.json.wallet !== undefined && prof.json.checkin !== undefined,
      JSON.stringify(prof.json).slice(0, 220));
    check('/profile.wallet 含 余额/总用量/总请求数',
      prof.json.wallet && prof.json.wallet.balance !== undefined &&
        prof.json.wallet.total_tokens !== undefined && prof.json.wallet.total_requests !== undefined,
      JSON.stringify(prof.json.wallet ?? {}));
    check('/profile.checkin.enabled 是布尔', typeof prof.json.checkin?.enabled === 'boolean',
      JSON.stringify(prof.json.checkin ?? {}));

    // ---- [14] 每日签到: 加余额 100~200, 当天重复 -> 409 ----
    console.log('\n[14] 每日签到(幂等 + 加余额 + 开关)');
    // 用一个干净的临时账号签到, 免得污染 admin 的余额(很难回滚)
    const ciEmail = `e2e-ci-${stamp}@local`;
    const CI_PWD = 'checkin-pwd-1';
    const ciUser = await call('/api/admin/users', {
      method: 'POST',
      body: JSON.stringify({ email: ciEmail, username: `e2e签到${stamp}`, password: CI_PWD, role: 'user' }),
    });
    check('创建签到测试用户 201', ciUser.status === 201, ciUser.text.slice(0, 200));
    const ciId = ciUser.json.id;
    createdUsers.push(ciId);

    const ciLogin = await login(ciEmail, CI_PWD);
    check('签到测试用户登录 200', ciLogin.status === 200, ciLogin.text.slice(0, 160));
    const ci = makeCall(ciLogin.cookie);

    const before = await ci('/api/admin/profile');
    const balBefore = Number(before.json.wallet?.balance ?? 0);
    check('未签到时 checked_today=false', before.json.checkin?.checked_today === false,
      JSON.stringify(before.json.checkin ?? {}));

    const ci1 = await ci('/api/admin/profile/checkin', { method: 'POST' });
    check('首次签到 200', ci1.status === 200, ci1.text.slice(0, 200));
    // 奖励对外是**美元**整数 100~200 (接口已按 fromMicro 换算过)。
    // 2026-09-21 修: 旧实现把 100~200 当微美元写入, 前端 toFixed(4) 显示 $0.0000,
    // 用户看到的就是"签到新增金额是 0"。这里钉住"回传的是美元, 不是微美元"。
    const amountUsd = Number(ci1.json.amount);
    check('签到金额是 100~200 美元整数(不是微美元)',
      Number.isInteger(amountUsd) && amountUsd >= 100 && amountUsd <= 200,
      `amount=${JSON.stringify(ci1.json.amount)}`);
    check('签到后余额 = 原余额 + 签到金额',
      Math.abs(Number(ci1.json.balance) - (balBefore + amountUsd)) < 1e-9,
      `before=${balBefore} amount=${amountUsd} after=${ci1.json.balance}`);
    check('签到金额不会显示成 $0(前端 fmtUsd 最小两位小数也非零)',
      amountUsd >= 0.01, `amount=${amountUsd}`);

    const ci2 = await ci('/api/admin/profile/checkin', { method: 'POST' });
    check('当天重复签到 -> 409(不是"再加一次")', ci2.status === 409, `status=${ci2.status} ${ci2.text.slice(0, 120)}`);
    const afterRepeat = await ci('/api/admin/profile');
    check('重复签到没有改余额',
      Math.abs(Number(afterRepeat.json.wallet?.balance ?? 0) - Number(ci1.json.balance)) < 1e-9,
      `bal=${afterRepeat.json.wallet?.balance} exp=${ci1.json.balance}`);
    check('签完后 checked_today=true', afterRepeat.json.checkin?.checked_today === true,
      JSON.stringify(afterRepeat.json.checkin ?? {}));

    // 关掉签到开关 -> 403; 必须恢复, 否则后面人工验证会被坑
    await call('/api/admin/settings', {
      method: 'PUT',
      body: JSON.stringify({ settings: { checkin_enabled: 'false' } }),
    });
    try {
      const ciOff = await ci('/api/admin/profile/checkin', { method: 'POST' });
      check('关闭签到后 -> 403', ciOff.status === 403, `status=${ciOff.status} ${ciOff.text.slice(0, 120)}`);
      const profOff = await ci('/api/admin/profile');
      check('关闭后 /profile.checkin.enabled=false', profOff.json.checkin?.enabled === false,
        JSON.stringify(profOff.json.checkin ?? {}));
    } finally {
      await call('/api/admin/settings', {
        method: 'PUT',
        body: JSON.stringify({ settings: { checkin_enabled: 'true' } }),
      });
    }
    const ciBack = await ci('/api/admin/profile');
    check('恢复后 checkin.enabled=true', ciBack.json.checkin?.enabled === true,
      JSON.stringify(ciBack.json.checkin ?? {}));

    // 非超管的资料接口不能借 id 参数的便车看别人
    const ciOther = await ci(`/api/admin/profile?user_id=${bizId}`);
    check('/profile 忽略 user_id 参数(永远只回自己)',
      ciOther.status === 200 && Number(ciOther.json.user?.id) === Number(ciId),
      `status=${ciOther.status} uid=${ciOther.json.user?.id} expect=${ciId}`);

    // ---- [15] 未登记资源 + 旧前缀彻底消失 ----
    console.log('\n[15] 旧 /admin 前缀彻底消失(接口侧)');
    const oldAdminApi = await call('/api/admin/admin/dashboard');
    check('旧前缀风格 /api/admin/admin/* -> 404', oldAdminApi.status === 404, `status=${oldAdminApi.status}`);
  } finally {
    // ---- 清理: 先删用户(软删), 再删角色(软删的用户不算"在用") ----
    for (const id of createdUsers) {
      await call(`/api/admin/users/${id}`, { method: 'DELETE' }).catch(() => {});
    }
    for (const id of createdRoles) {
      const r = await call(`/api/admin/roles/${id}`, { method: 'DELETE' }).catch(() => null);
      if (r && r.status !== 200) console.log(`  (清理: 角色 #${id} 未删除 -> ${r.status} ${r.text.slice(0, 80)})`);
    }
  }

  console.log(`\n=== 结果: ${pass} passed, ${fail} failed ===\n`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error('\n✗ 异常:', e.message, '\n', e.stack);
  process.exit(1);
});
