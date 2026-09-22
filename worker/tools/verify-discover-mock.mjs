/**
 * 用 mock 上游验证「模型获取」能真的把模型 ID 抽出来。
 *
 * mock 上游(OpenAI 协议)的 GET /v1/models 返回 gpt-4o / gpt-4o-mini。
 * 我们的流程:
 *   1. 起 mock 上游(独立端口)
 *   2. 起 worker dev(独立端口)
 *   3. 登录后台, 建一个指向 mock 的上游账号
 *   4. GET /accounts/:id/models -> 断言拿到 gpt-4o / gpt-4o-mini
 *   5. 清理该测试账号
 *
 * 用法: node tools/verify-discover-mock.mjs
 */
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

const MOCK_PORT = 9199;
const DEV_PORT = 8899;
const ADMIN_PASS = process.env.ADMIN_PASS ?? 'admin12345';

// 避开代理, 否则 127.0.0.1 也会被代理吃掉
const env = { ...process.env };
for (const k of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'ALL_PROXY', 'all_proxy']) delete env[k];
env.NO_PROXY = '127.0.0.1,localhost';
env.no_proxy = '127.0.0.1,localhost';

const mock = spawn(process.execPath, [join(here, 'mock-upstream.mjs'), String(MOCK_PORT)], {
  cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
});
const dev = spawn(process.execPath, [join(root, 'node_modules/wrangler/bin/wrangler.js'), 'dev', '--port', String(DEV_PORT), '--local'], {
  cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
});

const devBase = `http://127.0.0.1:${DEV_PORT}`;

async function waitUrl(url, timeoutMs = 90000) {
  const dl = Date.now() + timeoutMs;
  while (Date.now() < dl) {
    try { const r = await fetch(url); if (r.ok || r.status < 500) return true; } catch { /* wait */ }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

function cleanup() {
  for (const p of [mock, dev]) { try { p.kill('SIGKILL'); } catch { /* ignore */ } }
}

let cookie = '';
async function api(path, opts = {}) {
  const r = await fetch(`${devBase}/api/admin${path}`, {
    ...opts,
    headers: { 'content-type': 'application/json', cookie, ...(opts.headers || {}) },
  });
  const txt = await r.text();
  let j = null; try { j = JSON.parse(txt); } catch { /* ignore */ }
  return { status: r.status, body: j, raw: txt };
}

let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) fail++; };

try {
  ok(await waitUrl(`http://127.0.0.1:${MOCK_PORT}/v1/models`), 'mock 上游就绪');
  ok(await waitUrl(`${devBase}/health`), 'worker dev 就绪');

  const lr = await fetch(`${devBase}/api/admin/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: ADMIN_PASS }),
  });
  cookie = (lr.headers.get('set-cookie') || '').split(';')[0];
  ok(!!cookie, '登录成功');

  // 建一个指向 mock 的账号(自定义平台 + base_url)
  const created = await api('/accounts', {
    method: 'POST',
    body: JSON.stringify({
      name: 'mock-discover-test',
      platform: 'mockrelay',
      protocol: 'openai',
      api_key: 'sk-mock-key',
      base_url: `http://127.0.0.1:${MOCK_PORT}`,
      group_ids: [1],
    }),
  });
  ok(created.status === 201, `创建测试账号 (HTTP ${created.status})`);
  const id = created.body?.id;
  console.log(`  -> 账号 id=${id}`);

  const r = await api(`/accounts/${id}/models`);
  console.log(`  GET /accounts/${id}/models -> HTTP ${r.status}`);
  console.log(`    ok=${r.body?.ok} models=${JSON.stringify(r.body?.models)}`);
  console.log(`    msg=${r.body?.message}`);
  console.log(`    base_url=${r.body?.base_url}`);

  ok(r.body?.ok === true, 'ok=true');
  ok(JSON.stringify(r.body?.models) === JSON.stringify(['gpt-4o', 'gpt-4o-mini']),
    '抽到 gpt-4o / gpt-4o-mini');
  ok(String(r.body?.base_url || '').includes(String(MOCK_PORT)),
    '请求打到了账号配置的 base_url(第三方中转), 不是官方域名');

  // 清理
  const del = await api(`/accounts/${id}`, { method: 'DELETE' });
  ok(del.status === 200, '测试账号已删除');
} catch (e) {
  console.error('✗ 异常:', e.message);
  fail++;
}

cleanup();
await new Promise((r) => setTimeout(r, 2000));
console.log(`\n=== ${fail === 0 ? '全部通过' : fail + ' 项失败'} ===`);
process.exit(fail ? 1 : 0);
