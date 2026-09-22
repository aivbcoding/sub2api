/**
 * 线上公告功能验收 —— 真读写(建 -> 读 -> 改 -> 删), 结束时清理干净。
 *
 * 会**写生产** announcements 表, 但只碰自己造的临时公告(
 * 标题带 `online-ann-<时间戳>` 前缀, 最后一条条删掉)。
 *
 * 用法:
 *   ADMIN_USER=admin ADMIN_PASS=xxx NO_PROXY='*' node tools/verify-announce-online.mjs
 *   未给 ADMIN_PASS 直接跳过(退出码 0)。
 */
const BASE = process.env.BASE ?? 'https://sub2api.aixm.ccwu.cc';
const USER = process.env.ADMIN_USER ?? 'admin';
const PASS = process.env.ADMIN_PASS ?? '';

let pass = 0, fail = 0;
const check = (n, c, d = '') => {
  if (c) { pass++; console.log(`  PASS  ${n}`); }
  else { fail++; console.log(`  FAIL  ${n}${d ? ' -> ' + d : ''}`); }
};

async function main() {
  console.log(`\n=== 线上公告验收 @ ${BASE} ===\n`);
  if (!PASS) {
    console.log('  SKIP  未提供 ADMIN_PASS, 跳过\n');
    process.exit(0);
  }

  const lr = await fetch(`${BASE}/api/admin/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: USER, password: PASS }),
  });
  check('线上管理员登录 200', lr.status === 200, `status=${lr.status}`);
  if (lr.status !== 200) { console.log(`\n=== ${pass} passed, ${fail} failed ===\n`); process.exit(1); }
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

  const tag = `online-ann-${Date.now()}`;
  const ids = [];
  try {
    console.log('[1] 管理列表(含草稿)可达');
    const l = await call('GET', '/announcements/all');
    check('GET /announcements/all -> 200', l.status === 200, l.text.slice(0, 160));
    check('响应含 announcements 数组', Array.isArray(l.json.announcements));

    console.log('\n[2] 用户侧读取可达(已发布)');
    const u = await call('GET', '/announcements');
    check('GET /announcements -> 200', u.status === 200, u.text.slice(0, 160));
    check('响应含 version 字段', typeof u.json.version === 'string');

    console.log('\n[3] 发一条已发布公告');
    const c = await call('POST', '/announcements', {
      title: tag + '-线上验收',
      content: '这是一条线上验收用的临时公告, 验收结束会自动删除。',
      status: 'published',
      pinned: 1,
    });
    check('创建 -> 200', c.status === 200, c.text.slice(0, 200));
    if (c.json.id) ids.push(c.json.id);

    console.log('\n[4] 用户侧能看到它 + 带置顶');
    const u2 = await call('GET', '/announcements');
    const mine = (u2.json.announcements ?? []).find((a) => a.id === c.json.id);
    check('用户侧可见', !!mine);
    check('置顶生效', mine && Number(mine.pinned) === 1, `pinned=${mine && mine.pinned}`);

    console.log('\n[5] 改正文 -> revision 变化');
    const up = await call('PUT', `/announcements/${c.json.id}`, { content: '改过的正文' });
    check('更新 -> 200', up.status === 200, up.text.slice(0, 160));
    check('revision 变为 2', Number(up.json.revision) === 2, `revision=${up.json.revision}`);

    console.log('\n[6] 删除后用户侧立刻消失');
    const d = await call('DELETE', `/announcements/${c.json.id}`);
    check('删除 -> 200', d.status === 200, d.text.slice(0, 160));
    const u3 = await call('GET', '/announcements');
    check('用户侧不再返回它', !(u3.json.announcements ?? []).some((a) => a.id === c.json.id));
    ids.pop(); // 已删, 清理列表里去掉
  } finally {
    console.log('\n[7] 清理');
    for (const id of ids) {
      const r = await call('DELETE', `/announcements/${id}`);
      check(`清理 #${id}`, r.status === 200 || r.status === 404, `status=${r.status}`);
    }
    const fin = await call('GET', '/announcements/all');
    const left = (fin.json.announcements ?? []).filter((a) => String(a.title).startsWith(tag));
    check('临时公告已清空', left.length === 0, JSON.stringify(left.map((a) => a.title)));
  }

  console.log(`\n=== 线上公告验收: ${pass} passed, ${fail} failed ===\n`);
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error('线上公告验收失败:', e.message); process.exit(1); });
