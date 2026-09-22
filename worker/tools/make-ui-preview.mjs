#!/usr/bin/env node
/**
 * 生成后台 UI 的**离线预览**: 把真 ADMIN_HTML 抠出来, 注入一段桩脚本
 * (伪造 /api/admin/me 等响应, 让页面直接进到已登录状态), 写成一个独立 html 供肉眼核验。
 *
 * 为什么需要它:
 *   本机没有 Playwright/Chromium, 没法截图。但改布局(顶栏/加载框/flex)这类改动的
 *   风险恰恰在"看起来对不对", 静态断言只能验 CSS 文本, 验不了实际渲染。
 *   把真 HTML 落成文件, 用系统浏览器打开就能看见。
 *
 * 用法: node tools/make-ui-preview.mjs [输出路径]
 * 默认输出: <repo>/ui-preview.html  —— **临时产物, 核验后请删除, 不要进仓库/部署**
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const srcPath = resolve(here, '../src/admin-ui.ts');
const outPath = process.argv[2] ? resolve(process.argv[2]) : resolve(here, '../ui-preview.html');

const source = readFileSync(srcPath, 'utf8');
const expr = source.match(/const ADMIN_HTML\s*=\s*(`[\s\S]*?`);/);
if (!expr) {
  console.error('✗ 找不到 ADMIN_HTML 定义');
  process.exit(1);
}
let html = (0, eval)(expr[1]);

// 桩: 在真脚本**之前**注入, 把 fetch 换成固定响应, 于是页面自动进入"已登录 + 有首页数据"。
const stub = `<script>
(function () {
  const J = (o) => Promise.resolve(new Response(JSON.stringify(o), {
    status: 200, headers: { 'content-type': 'application/json' },
  }));
  const me = { id: 1, username: 'admin', email: 'admin@local',
               role: 'admin', role_name: '超级管理员', menus: ['*'], is_admin: true };
  // 公告的桩数据: 用来核验「公告管理」页与顶栏弹窗的实际排版
  const annItems = [
    { id: 2, title: '系统维护通知', content: '本周六 02:00-04:00 进行数据库维护,\\n期间网关可能短暂 502, 请提前重试。',
      status: 'published', pinned: 1, revision: 2, created_at: '2026-09-21 09:00:00', updated_at: '2026-09-21 15:20:00' },
    { id: 1, title: '新模型上线: glm-5.2', content: '已接入 sensenova 上游, 客户端直接用 glm-5.2 即可。',
      status: 'draft', pinned: 0, revision: 1, created_at: '2026-09-20 11:00:00', updated_at: '2026-09-20 11:00:00' },
  ];
  window.fetch = function (url, opts) {
    const u = String(url);
    if (u.indexOf('/api/admin/me') >= 0) return J(me);
    if (u.indexOf('/api/admin/announcements/all') >= 0) return J({ announcements: annItems });
    if (u.indexOf('/api/admin/announcements') >= 0) return J({
      announcements: annItems.filter((a) => a.status === 'published'), total: 1, version: '2:2',
    });
    if (u.indexOf('/api/admin/overview') >= 0) return J({
      counts: { users: 2, keys: 3, accounts: 4, groups: 2 },
      today: { requests: 128, tokens: 45600, cost: 1.23 },
      checkin: { done: false, amount: 0 },
    });
    if (u.indexOf('/api/admin/dashboard') >= 0) return J({
      counts: { users: 2, keys: 3, accounts: 4, groups: 2 },
      today: { requests: 128, tokens: 45600, cost: 1.23 },
    });
    return J({});
  };
})();
</script>`;

// 桩必须在真脚本前执行, 插在 <script> 之前
html = html.replace('<script>\n', stub + '\n<script>\n');
// 预览不需要 CSP
html = html.replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/, '');

writeFileSync(outPath, html, 'utf8');
console.log('✓ 预览已生成: ' + outPath);
console.log('  打开后应看到: 顶栏(logo+sub2api 品牌 / 右侧账号胶囊+退出) —— 顶栏**没有**菜单名;');
console.log('  再点左侧任意菜单, 加载中的转圈会出现在内容区**垂直居中**位置。');
