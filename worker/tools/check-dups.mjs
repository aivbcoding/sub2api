// 检查 /v1/models 里是否有大小写重复项
const HOST = 'https://sub2api.aixm.ccwu.cc';
const KEY = 'sk-0000000000000000000000000000000000000000000000000000000000000001';
const r = await fetch(HOST + '/v1/models', { headers: { Authorization: 'Bearer ' + KEY } });
const j = await r.json();
const ids = j.data.map((m) => m.id);
console.log('total=' + ids.length);
const byLower = new Map();
for (const id of ids) {
  const k = id.toLowerCase();
  if (!byLower.has(k)) byLower.set(k, []);
  byLower.get(k).push(id);
}
const dups = [...byLower.entries()].filter(([, v]) => v.length > 1);
if (dups.length === 0) console.log('无大小写重复 ✅');
else {
  console.log('大小写重复 ' + dups.length + ' 组:');
  for (const [k, v] of dups) console.log('  ' + k + ' -> ' + v.join(' | '));
}
console.log('\n全部模型:');
console.log(ids.join('\n'));
