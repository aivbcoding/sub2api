/**
 * 线上 API Key 格式验收 —— 真建真删, 结束清理干净。
 *
 * 为什么需要单独一个线上脚本: key 的生成逻辑在 **Worker 服务端**, 不在
 * admin-ui 那份 HTML 里, 所以 `verify-online.mjs` 那种"抓 HTML 找字符串"
 * 的办法根本看不到它。唯一的证据就是真去线上建一把 key, 看它长什么样。
 *
 * 会**写生产** api_keys 表, 但只碰自己造的那把临时 key
 * (name 带 `online-key-<时间戳>` 前缀), 最后按 id 删掉并确认已消失。
 *
 * 用法:
 *   ADMIN_USER=admin ADMIN_PASS=xxx NO_PROXY='*' node tools/verify-apikey-format-online.mjs
 *   未给 ADMIN_PASS 直接跳过(退出码 0)。
 *
 * 期望格式: `sk-` + 32 位 UUID(去掉连字符) = **35 字符**。
 */
const BASE = process.env.BASE ?? 'https://sub2api.aixm.ccwu.cc';
const USER = process.env.ADMIN_USER ?? 'admin';
const PASS = process.env.ADMIN_PASS ?? '';

const KEY_RE = /^sk-[0-9a-f]{32}$/;

let pass = 0, fail = 0;
const check = (n, c, d = '') => {
  if (c) { pass++; console.log(`  PASS  ${n}`); }
  else { fail++; console.log(`  FAIL  ${n}${d ? ' -> ' + d : ''}`); }
};

async function main() {
  console.log(`\n=== 线上 API Key 格式验收 @ ${BASE} ===\n`);
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
  if (lr.status !== 200) {
    console.log(`\n=== ${pass} passed, ${fail} failed ===\n`);
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

  const tag = `online-key-${Date.now()}`;
  let createdId = null;
  try {
    // 挑一个真实用户 + 一个真实分组, 这样建出来的 key 也能顺带验一次鉴权链路
    console.log('[1] 取一个真实用户与分组');
    const ur = await call('GET', '/users');
    const users = ur.json.users ?? ur.json.rows ?? [];
    const uid = Number(users[0]?.id ?? 0);
    check('拿到一个用户 id', Number.isInteger(uid) && uid > 0, `uid=${uid}`);

    const gr = await call('GET', '/groups');
    const groups = gr.json.groups ?? [];
    const gid = Number(groups[0]?.id ?? 0) || undefined;

    if (!uid) throw new Error('没有可用用户, 无法继续');

    console.log('\n[2] 建一把临时 Key, 看格式');
    const mk = await call('POST', '/api-keys', {
      user_id: uid, group_id: gid, name: tag,
    });
    check('POST /api-keys -> 201', mk.status === 201, mk.text.slice(0, 200));
    const key = String(mk.json.key ?? '');
    createdId = mk.json.id ?? null;
    check('回传了明文 key', !!key, JSON.stringify(mk.json).slice(0, 160));
    console.log(`       样例: ${key}`);

    check('🧨 格式 = sk- + 32 位 UUID(35 字符)', KEY_RE.test(key),
      `key=${JSON.stringify(key)} len=${key.length}`);
    check('长度正好 35', key.length === 35, `len=${key.length}`);
    check('不再是旧的 64 hex(67 字符)', !/^sk-[0-9a-f]{64}$/.test(key));

    console.log('\n[3] 这把 key 能被鉴权链路接受(短了也没被误伤)');
    const models = await fetch(`${BASE}/v1/models`, { headers: { authorization: `Bearer ${key}` } });
    check('GET /v1/models 不返回 401/403', models.status !== 401 && models.status !== 403,
      `status=${models.status}`);
    check('列表响应带 no-store', (models.headers.get('cache-control') ?? '').includes('no-store'),
      models.headers.get('cache-control') ?? '(none)');

    console.log('\n[4] 列表里能以打码形式看到它');
    const ls = await call('GET', '/api-keys');
    const row = (ls.json.api_keys ?? []).find((k) => k.name === tag) ?? {};
    check('临时 Key 出现在列表', !!row.id, '未找到 ' + tag);
    check('列表不含完整明文(masked 中间带星)', String(row.key_masked ?? '').includes('*'),
      String(row.key_masked ?? ''));
  } finally {
    console.log('\n[5] 清理: 删掉临时 Key');
    if (createdId) {
      const del = await call('DELETE', `/api-keys/${createdId}`);
      check('DELETE /api-keys/:id -> 200', del.status === 200, del.text.slice(0, 160));
      const ls2 = await call('GET', '/api-keys');
      const still = (ls2.json.api_keys ?? []).some((k) => k.name === tag);
      check('临时 Key 已从列表消失', !still, '仍然存在: ' + tag);
    } else {
      check('清理(无 id 可删)', false, '创建失败, 请在后台手动检查 ' + tag);
    }
  }

  console.log(`\n=== ${pass} passed, ${fail} failed ===\n`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error('探针异常: ' + (e && e.stack ? e.stack : e)); process.exit(1); });
