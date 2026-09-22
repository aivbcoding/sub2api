// 线上验证: 1) /health  2) /admin 页面是否含新特性  3) Deepseek-v4-flash 是否稳定 200
const HOST = 'https://sub2api.aixm.ccwu.cc';
const KEY = 'sk-0000000000000000000000000000000000000000000000000000000000000001';

// 1) health
try {
  const r = await fetch(HOST + '/health');
  console.log('GET /health -> ' + r.status + ' ' + (await r.text()).slice(0, 160));
} catch (e) { console.log('GET /health -> ERR ' + e.message); }

// 2) admin 页面关键标记
try {
  const r = await fetch(HOST + '/admin');
  const html = await r.text();
  const marks = {
    "'reachable' 分支": html.includes("'reachable'"),
    '.toast.warn 样式': html.includes('.toast.warn'),
    '待验证 文案': html.includes('待验证'),
    '自定义平台 选项': html.includes('__custom__'),
    'platList 逻辑': html.includes('platList'),
    'verdict 字段': html.includes('verdict'),
  };
  console.log('\nGET /admin -> ' + r.status + '  (bundle ' + html.length + ' bytes)');
  for (const [k, v] of Object.entries(marks)) console.log('  ' + (v ? '✅' : '❌') + ' ' + k);
} catch (e) { console.log('GET /admin -> ERR ' + e.message); }

// 3) 模型列表里有没有 Deepseek-v4-flash
try {
  const r = await fetch(HOST + '/v1/models', { headers: { Authorization: 'Bearer ' + KEY } });
  const j = await r.json().catch(() => null);
  const ids = (j?.data || j?.models || []).map((m) => m.id || m.name);
  console.log('\nGET /v1/models -> ' + r.status + '  total=' + ids.length);
  console.log('  Deepseek-v4-flash 在列: ' + (ids.some((i) => /^deepseek-v4-flash$/i.test(i)) ? '✅' : '❌'));
  console.log('  含 deepseek 的: ' + (ids.filter((i) => /deepseek/i.test(i)).join(', ') || '(无)'));
} catch (e) { console.log('GET /v1/models -> ERR ' + e.message); }
