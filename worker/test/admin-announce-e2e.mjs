/**
 * 公告管理 E2E —— 增删改 + 用户侧可见性 + revision 语义
 *
 * 背景:
 *   「公告管理」是管理员菜单(announce), 但公告的**读**是任何登录用户的基本权利 ——
 *   业务用户(角色 user 没有 announce 菜单)在顶栏点「公告」按钮不该 403,
 *   "登录后自动弹公告"这件事本身也对所有人成立。
 *   所以后端把 GET /api/admin/announcements 放在菜单闸门**之前**分发,
 *   其它方法才走「公告管理」菜单权限。
 *
 * 这个测试要挡住的四类回归:
 *   1. 读公告被挂上菜单闸门 -> 业务用户拿不到公告;
 *   2. **只改状态/只置顶也把 revision +1** -> 全体用户下次登录被无谓弹一次窗;
 *   3. 草稿泄漏给普通用户(读接口必须只回 status='published');
 *   4. 删除变成硬删(既要软删, 又要删完立刻从用户侧消失)。
 *
 * 前置:
 *   本地库有已知密码的管理员(本地约定 admin / localtest123),
 *   且已建 announcements 表(node tools/migrate-announcements.mjs --apply)。
 *
 * 用法:
 *   ADMIN_PASS=localtest123 node tools/run-e2e.mjs 8787 test/admin-announce-e2e.mjs
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
  console.log(`\n=== 公告管理 E2E @ ${BASE} ===\n`);

  if (!PASS) {
    console.log('  SKIP  未提供 ADMIN_PASS, 跳过 (用法: ADMIN_PASS=xxx node tools/run-e2e.mjs 8787 test/admin-announce-e2e.mjs)');
    skip++;
    console.log(`\n=== 结果: ${pass} passed, ${fail} failed, ${skip} skipped ===\n`);
    process.exit(0);
  }

  const lr = await fetch(`${BASE}/api/admin/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: USER, password: PASS }),
  });
  check('管理员登录返回 200', lr.status === 200, `status=${lr.status}`);
  if (lr.status !== 200) {
    console.log(`\n=== 结果: ${pass} passed, ${fail} failed ===\n`);
    process.exit(1);
  }
  const adminCookie = (lr.headers.get('set-cookie') ?? '').split(';')[0];

  const call = async (method, path, body, cookie = adminCookie) => {
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

  // 唯一的标记, 用来在列表里精确找到本次测试造的数据
  const tag = `e2e-ann-${Date.now()}`;
  const createdIds = [];

  try {
    // ---- [1] 建表就绪 ----
    console.log('\n[1] 列表可读(表已建)');
    // 🚨 管理列表走 /announcements/all。裸 /announcements 是**用户侧**那条(只回已发布),
    //    拿它当管理列表会看不到草稿 —— 这正是本测试要区分的两条路径。
    const list0 = await call('GET', '/announcements/all');
    check('GET /announcements/all 返回 200', list0.status === 200, list0.text.slice(0, 200));
    check('响应含 announcements 数组', Array.isArray(list0.json.announcements));
    check('管理列表不是 fail-closed 的 404', list0.status !== 404, `status=${list0.status}`);

    // ---- [2] 创建: 已发布 ----
    console.log('\n[2] 创建已发布公告');
    const c1 = await call('POST', '/announcements', {
      title: tag + '-已发布',
      content: '第一行\n第二行',
      status: 'published',
      pinned: 1,
    });
    check('创建返回 200', c1.status === 200, c1.text.slice(0, 200));
    const id1 = c1.json.id;
    if (id1) createdIds.push(id1);
    check('返回新公告 id', Number.isInteger(id1) && id1 > 0, `id=${id1}`);

    // ---- [3] 创建: 草稿(不该出现在用户侧) ----
    console.log('\n[3] 创建草稿 -- 用户侧不可见');
    const c2 = await call('POST', '/announcements', {
      title: tag + '-草稿',
      content: '这不应该被普通用户看到',
      status: 'draft',
    });
    check('创建草稿返回 200', c2.status === 200, c2.text.slice(0, 200));
    const id2 = c2.json.id;
    if (id2) createdIds.push(id2);

    // ---- [4] 用户侧读取: 只回已发布 ----
    // 注意: 这里**故意不加 announce 菜单的限制复现** —— 管理员本身有全部菜单,
    // 所以真正要验的是"接口确实过滤了 status"。业务用户的 403 场景由守卫测试覆盖。
    console.log('\n[4] 用户侧读接口只回已发布');
    const live = await call('GET', '/announcements');
    check('读接口返回 200', live.status === 200, live.text.slice(0, 200));
    const liveItems = live.json.announcements ?? [];
    const hasPub = liveItems.some((a) => a.id === id1);
    const hasDraft = liveItems.some((a) => a.id === id2);
    check('已发布公告出现在用户侧', hasPub);
    check('草稿**没有**出现在用户侧', !hasDraft);
    check('每条都不含非 published 状态', liveItems.every((a) => a.status === 'published'));
    check('响应带 version 版本号', typeof live.json.version === 'string' && live.json.version.length > 0,
      `version=${live.json.version}`);
    const v1 = live.json.version;

    // 两条路径必须真的不同: 管理列表(/all)看得到草稿, 用户侧看不到
    const adminList4 = await call('GET', '/announcements/all');
    check('管理列表(/all)能看到草稿', (adminList4.json.announcements ?? []).some((a) => a.id === id2));

    // ---- [5] 只切状态/置顶 -> revision 不变 ----
    console.log('\n[5] 只改状态/置顶不动 revision');
    const up1 = await call('PUT', `/announcements/${id1}`, { pinned: 0, status: 'published' });
    check('更新(仅置顶变化)返回 200', up1.status === 200, up1.text.slice(0, 200));
    check('revision 保持 1', Number(up1.json.revision) === 1, `revision=${up1.json.revision}`);

    const live2 = await call('GET', '/announcements');
    check('仅置顶变化时 version 不变(不会打扰用户)', live2.json.version === v1,
      `before=${v1} after=${live2.json.version}`);

    // ---- [6] 改正文 -> revision +1, version 变 ----
    console.log('\n[6] 改正文 -> revision +1');
    const up2 = await call('PUT', `/announcements/${id1}`, { content: '改过的正文\n换行了' });
    check('更新(改正文)返回 200', up2.status === 200, up2.text.slice(0, 200));
    check('revision 变成 2', Number(up2.json.revision) === 2, `revision=${up2.json.revision}`);

    const live3 = await call('GET', '/announcements');
    check('内容变化后 version 也变了(会重新弹窗)', live3.json.version !== v1,
      `before=${v1} after=${live3.json.version}`);

    // ---- [7] 改标题也算内容变化 ----
    console.log('\n[7] 改标题 -> revision +1');
    const up3 = await call('PUT', `/announcements/${id1}`, { title: tag + '-改过标题' });
    check('revision 变成 3', Number(up3.json.revision) === 3, `revision=${up3.json.revision}`);

    // ---- [8] 校验: 空标题 / 空正文 ----
    console.log('\n[8] 参数校验');
    const bad1 = await call('POST', '/announcements', { title: '', content: 'x', status: 'published' });
    check('空标题返回 400', bad1.status === 400, `status=${bad1.status}`);
    const bad2 = await call('POST', '/announcements', { title: 'x', content: '   ', status: 'published' });
    check('空正文返回 400', bad2.status === 400, `status=${bad2.status}`);
    const bad3 = await call('POST', '/announcements', { title: 'x'.repeat(300), content: 'x' });
    check('超长标题返回 400', bad3.status === 400, `status=${bad3.status}`);

    // ---- [9] 状态白名单: 乱传状态一律落成草稿 ----
    console.log('\n[9] 状态白名单 fail-safe');
    const weird = await call('POST', '/announcements', { title: tag + '-乱状态', content: 'x', status: 'HACK' });
    check('乱状态创建返回 200', weird.status === 200, weird.text.slice(0, 200));
    if (weird.json.id) createdIds.push(weird.json.id);
    // 🚨 必须在**管理列表**里看状态: 用户侧列表只回 published, 草稿在那儿天然看不见,
    //    拿用户侧去断言会永远失败(哪怕降级逻辑完全正确)。已踩 1 次。
    const adminList = await call('GET', '/announcements/all');
    const wr = (adminList.json.announcements ?? []).find((a) => a.id === weird.json.id);
    check('乱状态被降级为 draft', wr && wr.status === 'draft', `status=${wr && wr.status}`);
    // 反过来也确认它确实没进用户侧(降级是真降级, 不是"其实发出去了")
    const userList = await call('GET', '/announcements');
    check('降级后的公告对用户不可见', !(userList.json.announcements ?? []).some((a) => a.id === weird.json.id));

    // ---- [10] 软删除 + 立刻从用户侧消失 ----
    console.log('\n[10] 删除是软删, 且用户侧立刻消失');
    const del = await call('DELETE', `/announcements/${id1}`);
    check('删除返回 200', del.status === 200, del.text.slice(0, 200));

    const adminAfter = await call('GET', '/announcements/all');
    check('管理列表不再有它', !(adminAfter.json.announcements ?? []).some((a) => a.id === id1));
    const liveAfter = await call('GET', '/announcements');
    check('用户侧也不再返回它', !(liveAfter.json.announcements ?? []).some((a) => a.id === id1));

    const delAgain = await call('DELETE', `/announcements/${id1}`);
    check('重复删除返回 404', delAgain.status === 404, `status=${delAgain.status}`);

    // ---- [11] 更新不存在的公告 ----
    console.log('\n[11] 不存在的公告');
    const upMissing = await call('PUT', '/announcements/99999999', { content: 'x' });
    check('更新不存在的公告返回 404', upMissing.status === 404, `status=${upMissing.status}`);
    const badId = await call('PUT', '/announcements/abc', { content: 'x' });
    check('非法 id 返回 400/404', badId.status === 400 || badId.status === 404, `status=${badId.status}`);
  } finally {
    // ---- [12] 清理 ----
    console.log('\n[12] 清理测试数据');
    for (const id of createdIds) {
      const r = await call('DELETE', `/announcements/${id}`);
      // 已删过的会 404, 不算失败
      check(`清理 #${id}`, r.status === 200 || r.status === 404, `status=${r.status}`);
    }
    const finalList = await call('GET', '/announcements/all');
    const leftover = (finalList.json.announcements ?? []).filter((a) => String(a.title).startsWith(tag));
    check('测试公告已全部清空(软删的不会回到列表)', leftover.length === 0,
      JSON.stringify(leftover.map((a) => a.title)));
  }

  console.log(`\n=== 结果: ${pass} passed, ${fail} failed, ${skip} skipped ===\n`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error('公告 E2E 运行失败:', e.message);
  process.exit(1);
});
