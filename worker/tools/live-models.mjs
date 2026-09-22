/**
 * 线上模型列表探针 —— 看 /v1/models 到底对外暴露了哪些模型
 *
 * 为什么需要:
 *   /v1/models 是聚合上游真实模型列表得来的。如果某个上游**没实现** GET /v1/models
 *   (例如 chatapi.weixin.qq.com 恒返回 400 "missing required parameter: model"),
 *   那这个上游的模型就不会出现在列表里 —— 即使对话完全正常。
 *   凡是靠 /v1/models 填充模型下拉的客户端(Cline/Cursor/Cherry Studio/NextChat)
 *   就会看不到这些模型。这个脚本用来快速确认"哪些平台的模型没被列出来"。
 *
 * 用法:
 *   node tools/live-models.mjs [apiKey]
 *   或  API_KEY=sk-xxx node tools/live-models.mjs
 *
 * 没传 key 时回退到本仓库种子 key (线上若已改则返回 401, 不影响排查方向)。
 */

const BASE = process.env.BASE_URL ?? 'https://sub2api-worker.1003759845.workers.dev';
const KEY =
  process.argv[2] ||
  process.env.API_KEY ||
  'sk-0000000000000000000000000000000000000000000000000000000000000001';

const out = [];
const r = await fetch(`${BASE}/v1/models`, { headers: { authorization: `Bearer ${KEY}` } });
const text = await r.text();
out.push(`GET ${BASE}/v1/models  (key=${KEY.slice(0, 12)}...)`);
out.push(`status=${r.status}`);

if (r.status === 200) {
  let j = {};
  try {
    j = JSON.parse(text);
  } catch {
    /* ignore */
  }
  const ids = (j.data ?? []).map((m) => m.id || m.name);
  out.push(`total=${ids.length}`);
  out.push(
    `byPrefix=${JSON.stringify(
      ids.reduce((a, i) => {
        const p = String(i).split(/[-.]/)[0];
        a[p] = (a[p] || 0) + 1;
        return a;
      }, {}),
    )}`,
  );
  out.push(`ids=${ids.join(', ')}`);
} else {
  out.push(`body=${text.slice(0, 300)}`);
}

const line = out.join('\n') + '\n';
await (await import('node:fs/promises')).writeFile('live-models.txt', line, 'utf8');
console.log(line);
