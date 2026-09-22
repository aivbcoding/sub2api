/**
 * 一条命令跑完「起本地 dev server -> 等就绪 -> 跑 e2e -> 关掉」。
 *
 * 为什么需要它:
 *   在这台 Windows 上, 单独用 Start-Process / detached spawn 拉起的 wrangler dev
 *   会在父 PowerShell 会话结束时被回收, 于是 e2e 一定连不上(表现为 "fetch failed")。
 *   把服务端和测试放进同一个 node 进程树里, 生命周期就绑定了: 跑完测试再杀掉, 不会残留。
 *
 * 用法: node tools/run-e2e.mjs [port] [testfile]
 *   node tools/run-e2e.mjs                       # 默认跑 test/e2e.mjs
 *   node tools/run-e2e.mjs 8787 test/admin-groups-e2e.mjs
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const port = String(process.argv[2] ?? 8787);
// 第二个参数是相对项目根目录的测试文件; 省略时跑主链路 e2e
const testRel = process.argv[3] ?? join('test', 'e2e.mjs');

const wrangler = join(root, 'node_modules', 'wrangler', 'bin', 'wrangler.js');

// 这些代理变量会让 node 的 fetch 也走代理, 打到 127.0.0.1 必然失败
const childEnv = { ...process.env };
for (const k of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'ALL_PROXY', 'all_proxy']) {
  delete childEnv[k];
}
childEnv.NO_PROXY = '127.0.0.1,localhost';
childEnv.no_proxy = '127.0.0.1,localhost';

const dev = spawn(process.execPath, [wrangler, 'dev', '--port', port, '--local'], {
  cwd: root,
  env: childEnv,
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
});

let devOut = '';
dev.stdout.on('data', (c) => { devOut += c.toString(); });
dev.stderr.on('data', (c) => { devOut += c.toString(); });

const base = `http://127.0.0.1:${port}`;

async function waitReady(timeoutMs = 90000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${base}/health`);
      if (r.ok) return true;
    } catch {
      /* 还没起来 */
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

function killDev() {
  try { dev.kill('SIGTERM'); } catch { /* ignore */ }
  // workerd 子进程会重新拉起, 所以要连进程组一起清
  setTimeout(() => { try { process.kill(dev.pid, 'SIGKILL'); } catch { /* ignore */ } }, 1500);
}

const ready = await waitReady();
if (!ready) {
  console.error('✗ dev server 未在超时内就绪。wrangler 输出:');
  console.error(devOut.slice(-3000));
  killDev();
  process.exit(1);
}
console.log(`✓ dev server 就绪 @ ${base}\n`);

const e2e = spawn(process.execPath, [join(root, testRel)], {
  cwd: root,
  env: { ...childEnv, BASE_URL: base },
  stdio: 'inherit',
});

const code = await new Promise((r) => e2e.on('exit', (c) => r(c ?? 1)));
killDev();
// 给 wrangler 一点时间收尾, 否则端口可能还在 TIME_WAIT 影响下一次运行
await new Promise((r) => setTimeout(r, 2500));
process.exit(code);
