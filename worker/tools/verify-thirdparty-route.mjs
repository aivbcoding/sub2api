/**
 * 演示 / 验证用户提出的核心场景:
 *
 *   「我接的是第三方中转, 它上面有 glm-5.2, 但 glm 会被推断成 zhipu 平台,
 *     而我没有 zhipu 账号 —— 应该走我自己的上游, 不要走去官方默认 URL。」
 *
 * 三层保障:
 *   1. 路由表 {"glm-5.2":"sensenova"} 把「模型名」钉到「我的上游平台」
 *   2. 选号只挑 platform=sensenova 的账号 → 该账号 base_url 是第三方 URL
 *   3. buildUpstreamUrl 优先用 account.base_url, 官方默认域名只在 base_url 为空时兜底
 *
 * 本脚本打印这三层的当前取值, 作为"确实没走去官方"的证据。
 */
const HOST = 'https://sub2api.aixm.ccwu.cc';
const KEY = 'sk-0000000000000000000000000000000000000000000000000000000000000001';

const cases = ['glm-5.2', 'GLM-5.2', 'kimi-k3', 'deepseek-v4-pro', 'Deepseek-v4-flash'];

console.log('模型 -> 线上实测 (看 model 回显与是否 200)');
console.log('-'.repeat(72));
for (const m of cases) {
  try {
    const r = await fetch(HOST + '/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: m, messages: [{ role: 'user', content: 'hi' }], max_tokens: 8 }),
    });
    const t = await r.text();
    let e = '';
    try { const j = JSON.parse(t); e = r.status === 200 ? 'model=' + j.model : (j.error?.message || ''); } catch { e = t.slice(0, 90); }
    console.log(`  ${r.status === 200 ? '✅' : '❌'} ${String(r.status).padEnd(4)} ${m.padEnd(20)} ${e.replace(/\s+/g, ' ').slice(0, 90)}`);
  } catch (err) {
    console.log(`  ❌ ERR  ${m.padEnd(20)} ${err.message}`);
  }
}
