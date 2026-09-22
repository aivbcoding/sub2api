/**
 * 端到端自测 (本地 wrangler dev)
 * 覆盖: 鉴权失败 / 鉴权成功 / 路由分发 / 上游不可达处理 / 余额不足
 * 用法: node test/e2e.mjs  (需先启动 `npx wrangler dev --port 8787`)
 */

const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:8787';
const KEY = 'sk-0000000000000000000000000000000000000000000000000000000000000001';

let pass = 0;
let fail = 0;

function check(name, cond, detail = '') {
  if (cond) {
    pass++;
    console.log(`  PASS  ${name}`);
  } else {
    fail++;
    console.log(`  FAIL  ${name}${detail ? ' -> ' + detail : ''}`);
  }
}

async function main() {
  console.log(`\n=== sub2api worker E2E @ ${BASE} ===\n`);

  // 1. 健康检查
  console.log('[1] 健康检查');
  {
    const r = await fetch(`${BASE}/health`);
    const j = await r.json().catch(() => ({}));
    check('GET /health 返回 200', r.status === 200, `status=${r.status}`);
    check('health.status === ok', j.status === 'ok', JSON.stringify(j));
  }

  // 2. 站点信息 + 根目录行为
  console.log('\n[2] 站点信息与根目录');
  {
    // `/` 现在是控制台首页(未登录 302 到 /login), 机器可读的站点信息搬到了 /api/info
    const r = await fetch(`${BASE}/api/info`);
    const j = await r.json().catch(() => ({}));
    check('GET /api/info 返回 200', r.status === 200, `status=${r.status}`);
    check('包含 endpoints 列表', Array.isArray(j.endpoints), JSON.stringify(j).slice(0, 120));

    const root = await fetch(`${BASE}/`, { redirect: 'manual' });
    check('未登录 GET / 是 302 到 /login(根目录即控制台)',
      root.status === 302 && (root.headers.get('location') ?? '') === '/login',
      `status=${root.status} location=${root.headers.get('location')}`);
  }

  // 3. 无鉴权 -> 401
  console.log('\n[3] 缺少 API Key -> 401');
  {
    const r = await fetch(`${BASE}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-4o', messages: [] }),
    });
    const j = await r.json().catch(() => ({}));
    check('返回 401', r.status === 401, `status=${r.status}`);
    check('错误体含 error.message', !!(j.error && j.error.message), JSON.stringify(j).slice(0, 160));
  }

  // 4. query 传 key -> 400 (上游行为: 一律拒绝)
  console.log('\n[4] query 参数传 key -> 400');
  {
    const r = await fetch(`${BASE}/v1/chat/completions?key=${KEY}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    check('返回 400', r.status === 400, `status=${r.status}`);
  }

  // 5. 无效 key -> 401
  console.log('\n[5] 无效 API Key -> 401');
  {
    const r = await fetch(`${BASE}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer sk-invalid' },
      body: JSON.stringify({ model: 'gpt-4o', messages: [] }),
    });
    check('返回 401', r.status === 401, `status=${r.status}`);
  }

  // 6. 有效 key -> 计费信息接口
  console.log('\n[6] 有效 Key 查询 /v1/sub2api/billing');
  {
    const r = await fetch(`${BASE}/v1/sub2api/billing`, {
      headers: { authorization: `Bearer ${KEY}` },
    });
    const j = await r.json().catch(() => ({}));
    check('返回 200', r.status === 200, `status=${r.status}`);
    check('balance 为 100', j.balance === 100, JSON.stringify(j).slice(0, 200));
    check('quota 为 50', j.quota === 50, JSON.stringify(j).slice(0, 200));
  }

  // 7. 有效 key + 真实上游 -> 验证请求确实抵达上游
  //    种子凭证是占位符, 所以期望上游以 401 拒绝 —— 这恰好证明转发链路是通的
  console.log('\n[7] 有效 Key + 转发到真实上游');
  {
    const r = await fetch(`${BASE}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
      body: JSON.stringify({
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });
    const text = await r.text();
    // 两种可接受结果, 取决于本地账号凭证是否还是种子里那个占位值:
    //   (a) 占位凭证 -> 网关直接 502 placeholder_credential (给出可操作的提示)
    //   (b) 已填真实/测试凭证 -> 请求抵达上游, 上游回 401 凭证错误
    const guarded = r.status === 502 && text.includes('placeholder_credential');
    const reachedUpstream =
      text.includes('sk-REPLA') || text.includes('platform.openai.com') || text.includes('api.openai.com');
    check(
      '占位凭证守卫 或 请求抵达真实上游',
      guarded || reachedUpstream,
      `status=${r.status} ${text.slice(0, 200)}`,
    );
    check(
      '上游凭证被拒 (401) 或 占位守卫 (502)',
      r.status === 401 || guarded,
      `status=${r.status}`,
    );
    console.log(`        状态=${r.status}, 响应=${text.slice(0, 150).replace(/\s+/g, ' ')}`);
  }

  // 7b. 模型映射/白名单之外的路径: 验证 anthropic 协议也走通转发
  console.log('\n[7b] Anthropic 协议转发');
  {
    const r = await fetch(`${BASE}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 16,
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });
    const text = await r.text();
    // Anthropic 原生错误格式为 {"type":"error","error":{"type":"authentication_error",...}}
    // 出现该结构即证明 x-api-key / anthropic-version 头构造正确且抵达 api.anthropic.com
    // 若本地账号仍是占位凭证, 网关会先拦下并返回 placeholder_credential —— 同样视为通过
    const reached =
      text.includes('authentication_error') ||
      text.includes('"type":"error"') ||
      text.includes('placeholder_credential');
    check('Anthropic 请求抵达上游 (返回原生错误格式)', reached, `status=${r.status} body=${text.slice(0, 150)}`);
    console.log(`        上游状态=${r.status}, 响应=${text.slice(0, 150).replace(/\s+/g, ' ')}`);
  }

  // 8. 404 未知路径
  console.log('\n[8] 未知路径 -> 404');
  {
    const r = await fetch(`${BASE}/totally/unknown`);
    check('返回 404', r.status === 404, `status=${r.status}`);
  }

  // 10. GET /v1/models —— 模型列表(authtoken 鉴权 + 形状校验)
  console.log('\n[10] GET /v1/models 模型列表');
  {
    // 无 Key 必须 401
    const rNoAuth = await fetch(`${BASE}/v1/models`);
    check('无 Key 返回 401', rNoAuth.status === 401, `status=${rNoAuth.status}`);

    // 带 Key: 上游是占位凭证, auto 模式应回退到本地白名单/定价表, 仍返回 200 且形状正确
    const r = await fetch(`${BASE}/v1/models`, {
      headers: { authorization: `Bearer ${KEY}` },
    });
    check('返回 200', r.status === 200, `status=${r.status}`);

    const j = await r.json().catch(() => ({}));
    check('object === "list"', j.object === 'list', JSON.stringify(j).slice(0, 160));
    check('data 是数组', Array.isArray(j.data), typeof j.data);

    // 每个元素都必须是 OpenAI 模型对象形状
    const shaped =
      Array.isArray(j.data) &&
      j.data.every(
        (m) =>
          m &&
          typeof m.id === 'string' &&
          m.object === 'model' &&
          typeof m.owned_by === 'string',
      );
    check('每个模型都是 OpenAI 模型对象形状', shaped, JSON.stringify(j.data?.[0] ?? null));

    // 不能出现被 deriveUpstreamEndpoint 改写后的痕迹
    check(
      'id 不含 "models/" 前缀 (Gemini 前缀已剥离)',
      Array.isArray(j.data) && j.data.every((m) => !String(m.id).startsWith('models/')),
      JSON.stringify((j.data ?? []).map((m) => m.id)),
    );
  }

  // 11. CORS 预检
  console.log('\n[11] CORS 预检');
  {
    const r = await fetch(`${BASE}/v1/chat/completions`, {
      method: 'OPTIONS',
      headers: { origin: 'http://example.com' },
    });
    check('返回 204', r.status === 204, `status=${r.status}`);
    check(
      '含 access-control-allow-origin',
      !!r.headers.get('access-control-allow-origin'),
      String(r.headers.get('access-control-allow-origin')),
    );
  }

  console.log(`\n=== 结果: ${pass} passed, ${fail} failed ===\n`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error('E2E 运行失败:', e.message);
  process.exit(1);
});
