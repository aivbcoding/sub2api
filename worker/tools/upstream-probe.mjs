// 直连上游探测：确认 Deepseek-v4-flash 到底由哪个上游提供
// 用法: node tools/upstream-probe.mjs
const targets = [
  {
    name: '账号9 微信chatapi',
    base: 'https://chatapi.weixin.qq.com/openai',
    key: 'Rbe12ggBEAEaIAgBEhwxNzg3MDQxMTU5MjAxODkzMDUyNEtyMFVWakwvIhgIAxIUCAMSEOm+SBHvpQLb7LklUTQiZ6A=',
  },
  {
    name: '账号10 日日新sensenova',
    base: 'https://token.sensenova.cn',
    key: 'sk-xbubSsElzwnaUMYPF9tabhRdT9fgHvbm',
  },
];

const model = 'Deepseek-v4-flash';

for (const t of targets) {
  console.log('\n=== ' + t.name + '  ' + t.base + ' ===');
  // 1) /v1/models
  try {
    const r = await fetch(t.base + '/v1/models', {
      headers: { Authorization: 'Bearer ' + t.key },
    });
    const txt = await r.text();
    let ids = [];
    try {
      const j = JSON.parse(txt);
      ids = (j.data || j.models || []).map((m) => m.id || m.name).filter(Boolean);
    } catch {}
    console.log(`  GET /v1/models -> ${r.status}  ${ids.length ? ids.length + ' models' : txt.slice(0, 200)}`);
    if (ids.length) {
      const hit = ids.filter((i) => /deepseek|flash/i.test(i));
      console.log('    deepseek/flash 相关: ' + (hit.length ? hit.join(', ') : '(无)'));
      console.log('    精确匹配 ' + model + ': ' + (ids.includes(model) ? '✅ 有' : '❌ 无'));
    }
  } catch (e) {
    console.log('  GET /v1/models -> 网络错误: ' + e.message);
  }

  // 2) 真实对话请求
  try {
    const r = await fetch(t.base + '/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + t.key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: 'hi' }], max_tokens: 5 }),
    });
    const txt = await r.text();
    console.log(`  POST /v1/chat/completions [${model}] -> ${r.status}`);
    console.log('    ' + txt.slice(0, 300).replace(/\n/g, ' '));
  } catch (e) {
    console.log('  POST /v1/chat/completions -> 网络错误: ' + e.message);
  }
}
console.log('\n完成。');
