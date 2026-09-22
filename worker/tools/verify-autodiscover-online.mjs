/**
 * 线上验证「自动发现」真的生效: 请求一个**只在 model_index 里、不在重定向表里**的模型。
 *
 * `sensenova-u1-fast` 满足条件: 它在 #10 的 model_index 里(真实拉到), 但重定向表里
 * **没有**它的短写条目 —— 若自动发现生效, 请求应到达 sensenova(返回其原生错误/成功),
 * 而不是网关的 503。
 *
 * 注意: 该模型此前实测在 sensenova 直连也 404(其自身问题), 所以这里**不期望 200**,
 * 期望的是「**响应出自 sensenova**」—— 即不是网关的 503 no_upstream_account。
 *
 * 用法: node tools/verify-autodiscover-online.mjs
 */
const HOST = 'https://sub2api.aixm.ccwu.cc';
const KEY = 'sk-0000000000000000000000000000000000000000000000000000000000000001';

let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) fail++; };

async function probe(model, opts = {}) {
  const r = await fetch(HOST + '/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: 'hi' }], max_tokens: 8 }),
  });
  const text = await r.text();
  let body = null;
  try { body = JSON.parse(text); } catch { /* non-json */ }
  return { status: r.status, body, text };
}

console.log('=== 线上验证: 自动发现路由 ===\n');

// 1) 索引内的模型(不在重定向表) -> 必须出网关 503, 说明被路由到了 sensenova
const a = await probe('sensenova-u1-fast');
const gwNoAccount = a.status === 503 && /no_upstream_account/.test(a.text);
ok(!gwNoAccount, `sensenova-u1-fast 未被网关判定为"无账号"(status=${a.status})`);
ok(
  a.status === 200 || /sensenova|not_found_error|"code"\s*:\s*"?5"?/i.test(a.text) || a.status === 404,
  `sensenova-u1-fast 响应出自 sensenova 侧(status=${a.status})`,
);

// 2) 已在重定向表的模型 -> 必须 200
for (const m of ['glm-5.2', 'kimi-k3', 'deepseek-v4-pro', 'Deepseek-v4-flash']) {
  const r = await probe(m);
  ok(r.status === 200, `${m} -> 200 (实际 ${r.status})`);
}

console.log(`\n=== ${fail === 0 ? '自动发现线上验证通过' : fail + ' 项失败'} ===`);
process.exit(fail ? 1 : 0);
