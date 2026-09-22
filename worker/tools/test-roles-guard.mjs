#!/usr/bin/env node
/**
 * 「统一登录 + 角色菜单权限」结构守卫 (静态检查, 不需要起服务)
 *
 * 这一层守的是**跨文件一致性**与**安全默认值** —— 这两类问题单看某一个文件都正常,
 * 只有把几个文件摆在一起比才发现, 而且运行时往往静默:
 *
 *   A. 菜单键三处必须一致: 侧栏 data-page / PAGE_TITLES / 后端 MENU_CATALOG。
 *      对不上时的表现是"角色里勾了却看不到"或"侧栏有按钮但一点就 403"。
 *   B. 每个 API 资源都必须登记菜单键(admin-api.ts::MENUS_BY_RESOURCE),
 *      否则新增接口会掉进 fail-closed 的 404 分支, 或者更糟 —— 忘了挂权限。
 *   C. 统一登录之后**不能再有第二张账号表**参与鉴权: 登录端点必须查 users,
 *      且 src 里不该再出现 admin_accounts 的读写(迁移工具不算, 它只在 tools/ 下)。
 *   D. 独立门户必须彻底消失: 源文件、路由、导航里的 portal 引用一个都不留,
 *      否则"两套登录入口"会同时存在, 权限模型又裂开了。
 *   E. 「我的」系列接口必须**只用会话里的 id** —— 一旦出现从请求里取 user_id,
 *      就是越权读别人数据的口子。
 *   F. 前端隐藏菜单只是体验; navigate() 必须对无权页面给出明确反馈,
 *      而不是静默跳回首页(静默会让人以为链接被篡改)。
 *
 * 用法: node tools/test-roles-guard.mjs   (退出码 0 = 通过)
 */
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const read = (rel) => readFileSync(join(root, rel), 'utf8');

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

const adminUi = read('src/admin-ui.ts');
const adminApi = read('src/admin-api.ts');
const adminAuth = read('src/admin-auth.ts');
const indexTs = read('src/index.ts');
const gatewayTs = read('src/gateway.ts');
const rolesSql = read('schema/schema-roles.sql');

/**
 * 去掉整行注释再断言。
 * 为什么需要: "不再查 admin_accounts" 这类检查会被**注释里的解释文字**误伤 ——
 * 我们恰恰希望代码里留着"已并入 users, admin_accounts 仅作回滚"的说明。
 * 只剥整行注释(trim 后以 // 或 * 开头), 不碰行内 //, 免得把 URL 里的 // 一起切掉。
 */
const stripLineComments = (src) =>
  src
    .split('\n')
    .filter((l) => {
      const t = l.trim();
      return !(t.startsWith('//') || t.startsWith('*') || t.startsWith('/*') || t.startsWith('*/'));
    })
    .join('\n');

// 取出浏览器实际收到的那段内联脚本(只有它才是真正在前端跑的代码)
const expr = adminUi.match(/const ADMIN_HTML\s*=\s*(`[\s\S]*?`);/);
if (!expr) { console.error('✗ 找不到 ADMIN_HTML 定义'); process.exit(1); }
const html = (0, eval)(expr[1]);
const open = html.indexOf('<script>');
const close = html.lastIndexOf('</script>');
const inline = html.slice(open + '<script>'.length, close);

console.log('\n=== 统一登录 / 角色菜单 守卫 ===\n');

// ---------- 0. 模板字面量两条老坑 ----------
console.log('[0] 模板字面量陷阱');
check('内联脚本内不含反引号', !inline.includes('`'));
check('源码里的正则反斜杠已转义', /\\\\d\{4\}/.test(adminUi));

// ---------- 1. 菜单键三处一致 ----------
console.log('\n[1] 菜单键一致性 (侧栏 / PAGE_TITLES / 后端 MENU_CATALOG)');
const navKeys = [...html.matchAll(/data-page="([a-z0-9_-]+)"/g)].map((m) => m[1]);
check('侧栏有导航项', navKeys.length >= 13, `count=${navKeys.length}`);
check('侧栏含 mykeys', navKeys.includes('mykeys'));
check('侧栏含 roles', navKeys.includes('roles'));
check('侧栏含 announce(公告管理)', navKeys.includes('announce'));

const catalogBlock = adminApi.match(/export const MENU_CATALOG[\s\S]*?\n\];/);
check('找到后端 MENU_CATALOG', !!catalogBlock);
const catalogKeys = catalogBlock
  ? [...catalogBlock[0].matchAll(/key:\s*'([a-z0-9_-]+)'/g)].map((m) => m[1])
  : [];
check('MENU_CATALOG 非空', catalogKeys.length >= 13, `count=${catalogKeys.length}`);

const missingInCatalog = navKeys.filter((k) => !catalogKeys.includes(k));
const missingInNav = catalogKeys.filter((k) => !navKeys.includes(k));
check('侧栏每个 data-page 都在 MENU_CATALOG 里', missingInCatalog.length === 0, missingInCatalog.join(','));
check('MENU_CATALOG 每项都有对应侧栏按钮', missingInNav.length === 0, missingInNav.join(','));

const titleBlock = inline.match(/const PAGE_TITLES = \{[\s\S]*?\n\};/);
check('找到前端 PAGE_TITLES', !!titleBlock);
const titleKeys = titleBlock
  ? [...titleBlock[0].matchAll(/([a-z0-9_]+):\s*'/g)].map((m) => m[1])
  : [];
const noTitle = navKeys.filter((k) => !titleKeys.includes(k));
check('每个侧栏项都有 PAGE_TITLES 标题', noTitle.length === 0, noTitle.join(','));

// ---------- 2. 每个 API 资源都挂了菜单键 ----------
console.log('\n[2] 后端资源 -> 菜单 映射 (fail-closed)');
const mapBlock = adminApi.match(/export const MENUS_BY_RESOURCE[\s\S]*?\n\};/);
check('找到 MENUS_BY_RESOURCE', !!mapBlock);
// 键可能是裸的(dashboard: 'x')也可能带引号('api-keys': 'x'), 两种都要认
const mapPairs = mapBlock
  ? [...mapBlock[0].matchAll(/'?([a-z][a-z-]*)'?:\s*'([a-z-]+)'/g)].map((m) => [m[1], m[2]])
  : [];
const mapped = mapPairs.map((p) => p[0]);
check('映射表非空', mapped.length >= 10, 'count=' + mapped.length);

// switch 里的 case 必须都有映射(否则接口掉进 404, 或者根本没被权限拦住)
const switchBody = adminApi.match(/switch \(resource\) \{[\s\S]*?\n    \}/);
check('找到资源 switch', !!switchBody);
const cases = switchBody ? [...switchBody[0].matchAll(/case '([a-z-]+)':/g)].map((m) => m[1]) : [];
const unmapped = cases.filter((c) => !mapped.includes(c));
check('每个 case 资源都在 MENUS_BY_RESOURCE 里', unmapped.length === 0, unmapped.join(','));
const noCase = mapped.filter((k) => !cases.includes(k));
check('映射的键都存在对应 case', noCase.length === 0, noCase.join(','));
check('闸门在 switch 之前(canAccessMenu + 403)',
  /!canAccessMenu\(auth, needMenu\)\) return forbidden\(needMenu\)/.test(adminApi));
check('未登记资源返回 404(而不是放行)',
  /if \(!needMenu\) return notFound\(/.test(adminApi));
// 映射的值必须是真实存在的菜单键 —— 写错一个字母就等于那个菜单永远拿不到权限
const badMenu = mapPairs.map((p) => p[1]).filter((k) => !catalogKeys.includes(k));
check('映射指向的菜单键都在 MENU_CATALOG 里', badMenu.length === 0, badMenu.join(','));

// ---------- 3. 登录只认 users, 不再有第二张账号表 ----------
console.log('\n[3] 统一登录 = 只查 users');
const loginBlock = indexTs.match(/if \(pathname === '\/api\/admin\/login'[\s\S]*?\n  \}/);
check('找到登录分支', !!loginBlock);
const loginSrc = loginBlock ? loginBlock[0] : '';
check('登录查 users 表', /FROM users/u.test(loginSrc));
check('登录不再查 admin_accounts', !/admin_accounts/.test(loginSrc));
check('用户名或邮箱都能登', /u\.email = \?1 COLLATE NOCASE OR u\.username = \?1 COLLATE NOCASE/.test(loginSrc));
check('登录响应带回 menus/role', /menus,\s*\n?\s*is_admin/.test(loginSrc) || /menus,/.test(loginSrc));
check('停用检查在密码校验之后(不泄露账号状态)',
  loginSrc.indexOf('verifyPassword') < loginSrc.indexOf("!== 'active'"));
for (const f of ['src/index.ts', 'src/admin-api.ts', 'src/admin-auth.ts']) {
  const src = stripLineComments(read(f));
  check(`${f} 里已无 admin_accounts 读写`, !/admin_accounts/.test(src));
}

// ---------- 4. 独立门户必须彻底消失 ----------
console.log('\n[4] 独立门户已移除');
check('src/portal-api.ts 不存在', !existsSync(join(root, 'src/portal-api.ts')));
check('src/portal-ui.ts 不存在', !existsSync(join(root, 'src/portal-ui.ts')));
check('index.ts 不再挂 /portal', !/['"]\/portal['"]/.test(indexTs));
check('index.ts 不再挂 /api/portal', !/\/api\/portal/.test(indexTs));
check('前端不再引用 /portal', !/\/portal/.test(html));
check('前端不再有门户设置项',
  !/portal_enabled|portal_registration|portal_auto_approve|id="p-enabled"/.test(html));
check('保留自助分组的兼容读取(老键名)', /portal_default_group_id/.test(adminApi));
check('admin-auth 里不再有门户会话域分隔', !/PORTAL_SECRET_SUFFIX/.test(adminAuth));

// ---------- 5. 「我的」接口只能碰自己 ----------
console.log('\n[5] 自助接口的自限性');
check('存在 handleMy', /async function handleMy\(/.test(adminApi));
check('my 资源在菜单闸门之前直接分发(任何登录用户可用)',
  adminApi.indexOf("if (resource === 'my')") < adminApi.indexOf('const needMenu = MENUS_BY_RESOURCE'));
check('我的 Key 列表按会话 id 过滤', /WHERE k\.user_id = \?1 AND k\.deleted_at IS NULL/.test(adminApi));
check('删除我的 Key 把 user_id 写进 WHERE(猜 id 也删不掉别人的)',
  /WHERE id = \?2 AND user_id = \?3 AND deleted_at IS NULL/.test(adminApi));
check('我的用量按会话 id 过滤', /WHERE l\.user_id = \?1/.test(adminApi));
// 自助发 Key 的 INSERT 必须硬编码权限相关列, 不能吃请求体。
// 断言范围**限定在 handleMy 函数体内** —— 否则正则会长距离"串"到 handleApiKeys
// 的 INSERT 上(那里本来就是要收 body.group_id 的管理员入口), 变成假警报。
const myFn = adminApi.match(/async function handleMy\([\s\S]*?\n\/\/ =====/);
const mySrc = myFn ? myFn[0] : '';
check('切出 handleMy 函数体', mySrc.length > 800, `len=${mySrc.length}`);
const myInsert = mySrc.match(/INSERT INTO api_keys \(user_id, key, name, group_id, status\)/);
check('自助发 Key 的 INSERT 只写死列名(不含请求体字段)', !!myInsert);
check('自助发 Key 不接收请求体里的 group_id / quota / status / user_id',
  !/body\.(group_id|quota|status|rate_limit|user_id)/.test(mySrc),
  (mySrc.match(/body\.\w+/g) || []).join(','));
check('自助发 Key 必须有真实分组(不许 group_id 为 NULL)',
  /if \(groupId === null\)/.test(mySrc));
check('自助 Key 有数量上限', /MAX_KEYS_PER_SELF = 20/.test(adminApi));

// API Key 生成格式: <prefix> + 32 位 UUID(去掉连字符的 128bit 随机), 如 sk-3f2a...9b8c, 总长 35。
// 反向断言走 stripLineComments —— 函数上方的说明注释里会提到"不再用 getRandomValues/64 hex",
// 直接对原文正则就是自己误伤自己(报假 FAIL)。
const genFn = adminApi.match(/function generateApiKey\([\s\S]*?\n\}/);
const genSrc = genFn ? genFn[0] : '';
check('切出 generateApiKey 函数体', genSrc.length > 40, `len=${genSrc.length}`);
check('generateApiKey 用 randomUUID 且去掉连字符(得 32 位)',
  /crypto\.randomUUID\(\)/.test(genSrc) && /replace\(\/-\/g,\s*''\)/.test(genSrc));
check('🧨 generateApiKey 不再自己拼 64 位 hex',
  !/getRandomValues|Uint8Array/.test(stripLineComments(genSrc)));
check('自助发 Key 走 generateApiKey(前缀取自 env)',
  /generateApiKey\(prefix\)/.test(mySrc));
check('管理端建 Key 也用同一生成器', /key = generateApiKey\('sk-'\)/.test(adminApi));

// 非超管的活动范围收窄
check('/usage 对非超管强制只看自己', /if \(selfScoped\) cond\('l\.user_id = \?', selfId\)/.test(adminApi));
check('/audit 对非超管强制只看自己', /WHERE admin_id = \?3/.test(adminApi));
check('非超管不能改用户角色(PUT)', /只有超级管理员可以修改用户角色/.test(adminApi));
check('非超管不能指定用户角色(POST)', /只有超级管理员可以指定用户角色/.test(adminApi));

// ---------- 6. 角色表与内置角色 ----------
console.log('\n[6] roles 表');
check('schema 里有 roles 表', /CREATE TABLE IF NOT EXISTS roles/.test(rolesSql));
check('roles 有唯一 code 索引', /CREATE UNIQUE INDEX IF NOT EXISTS idx_roles_code/.test(rolesSql));
check('内置 admin 角色 = 全部菜单', /\('admin',[^)]*'\["\*"\]'[^)]*1,/.test(rolesSql));
check('内置 user 角色给四个「我的」页面',
  /\('user',[\s\S]{0,80}?"overview","mykeys","logs","profile"/.test(rolesSql));
// 数据看板是运营视角的聚合页, 刻意不给业务用户 —— 这条是"权限控制"要求的护栏
check('内置 user 角色不给 board/dashboard',
  !/\('user',[\s\S]{0,200}?["']board["']/.test(rolesSql) &&
  !/\('user',[\s\S]{0,200}?["']dashboard["']/.test(rolesSql));
check('menus 解析失败 -> 空数组(fail-closed)',
  /export function parseMenus[\s\S]*?catch \{[\s\S]*?return \[\];/.test(adminAuth));
check('角色查不到时不给任何菜单(除 admin 兜底)',
  /menus\.length === 0 && role === 'admin' \? \[ALL_MENUS\] : menus/.test(adminAuth));
check('admin 角色不可改权限', /code === 'admin'[\s\S]{0,200}不可修改/.test(adminApi));
check('内置角色不可删除', /内置角色不可删除/.test(adminApi));
check('有用户在用则不可删除角色', /还有 \$\{usedCount\} 个用户在使用该角色/.test(adminApi));
check('角色权限每次请求现查(不写进 token)', /FROM users u[\s\S]{0,200}LEFT JOIN roles r ON r\.code = u\.role/.test(adminAuth));

// ---------- 7. 前端权限表现 ----------
console.log('\n[7] 前端权限表现');
check('有 ALLOWED_MENUS', /let ALLOWED_MENUS = null/.test(inline));
check('有 canSee()', /function canSee\(page\)/.test(inline));
check('有 applyMenus()', /function applyMenus\(menus\)/.test(inline));
check('有 defaultPage()', /function defaultPage\(\)/.test(inline));
check('有无权访问兜底页', /function renderDenied\(page\)/.test(inline));
check('navigate 对无权页面明确提示(而不是静默跳首页)',
  /const allowed = canSee\(page\)/.test(inline) && /if \(!allowed\) \{[\s\S]{0,80}renderDenied\(page\); return; \}/.test(inline));
check('navigate 未指定页码时落到本角色第一页',
  /if \(!page \|\| !PAGES\[page\]\) page = defaultPage\(\)/.test(inline));
check('登录后按角色收侧栏', /applyMenus\(data\.menus\)/.test(inline));
check('启动时按角色收侧栏', /applyMenus\(me\.menus\)/.test(inline));
check('登出/过期时清空菜单缓存(不留上一个角色的侧栏)',
  /function showLogin\(\)[\s\S]*?ALLOWED_MENUS = null/.test(inline));
check('登出时地址栏切回 /login', /location\.pathname !== '\/login'/.test(inline));
check('登录支持 ?next= 回跳', /new URLSearchParams\(location\.search\)\.get\('next'\)/.test(inline));
check('用户表单的角色下拉来自后端 roles', /PAGES\._roles/.test(inline));
check('角色下拉会补上"已失效"的当前值', /已失效/.test(inline));

// ---------- 8. 用户管理: 创建时间列 ----------
console.log('\n[8] 用户管理 新增创建时间列');
check('表头有创建时间', /<th>创建时间 \(UTC\+8\)<\/th>/.test(inline));
check('单元格渲染 created_at', /fmtTime\(u\.created_at\)/.test(inline));
check('空态 colspan 同步为 13', /colspan="13" class="empty">还没有用户/.test(inline));

// ---------- 9. 控制台路径 = 域名根下(无 /admin 前缀) + 未登录重定向 ----------
console.log('\n[9] 控制台路径挂在域名根下');
check('/ 与 /login 都返回控制台页面',
  /pathname === '\/' \|\|[\s\S]{0,160}pathname === '\/login'/.test(indexTs));
check('控制台页面清单 CONSOLE_PAGES 存在', /const CONSOLE_PAGES = new Set\(\[/.test(indexTs));
check('页面判定走 CONSOLE_PAGES(第一段白名单)',
  /CONSOLE_PAGES\.has\(firstSeg\)/.test(indexTs));
check('🗑️ 不再有 /admin/<page> 页面路由',
  !/pathname === '\/admin'/.test(indexTs) && !/pathname\.startsWith\('\/admin\/'\)/.test(indexTs));
check('未登录 302 到 /login', /return redirectTo\(`\/login/.test(indexTs));
check('重定向带 no-store(不被浏览器缓存)', /'cache-control': 'no-store'/.test(indexTs));
check('/login 与 /register 自身不再重定向(避免死循环)',
  /if \(pathname !== '\/login' && pathname !== '\/register'\)/.test(indexTs));
check('/register 也返回控制台页面', /pathname === '\/register'/.test(indexTs));
check('原根 JSON 信息搬到 /api/info', /pathname === '\/api\/info'/.test(indexTs));
check('/api/info 的 console 指向 /dashboard', /console: '\/dashboard'/.test(indexTs));
check('前端路由基址为空(菜单直接挂根下)', /const ADMIN_BASE = ''/.test(inline));
check('前端不再拼 /admin/<page>',
  !/pageFromPath[\s\S]{0,200}\\\/admin/.test(inline));
check('菜单路径进入入口路径保留段黑名单',
  /'dashboard', 'overview', 'mykeys'/.test(adminApi) || /'dashboard', 'overview', 'mykeys'/.test(gatewayTs));
check('保留段判定函数 isReservedEntrySegment 存在', /export function isReservedEntrySegment/.test(gatewayTs));
check('登录页文案不再写死"管理员"', !/请输入管理员账号和密码/.test(html));
check('登录页支持用户名或邮箱', /用户名或邮箱/.test(html));

// ---------- 10. 注册: 独立页面 + 公开接口 ----------
// 注册是**公开**接口, 所以"特权字段不可提权"必须静态锁死: 一旦有人给 INSERT 加上
// role/balance 之类的绑定参数, 这里立刻红。
console.log('\n[10] 注册页与注册接口');
const apiTs = adminApi;
check('注册页是独立视图(#register-view)', /<div id="register-view">/.test(html));
check('登录页有注册入口链接', /id="go-register"/.test(html));
check('注册页有回登录的链接', /id="go-login"/.test(html));
check('注册成功后跳回登录页并预填账号', /showLogin\(\);[\s\S]{0,120}\$\('#login-user'\)\.value = name/.test(inline));
check('注册成功提示用登录页横幅', /loginBanner\(/.test(inline));
check('注册表单有确认密码', /id="reg-pass2"/.test(html));
check('注册前端也校验两次密码一致', /两次输入的密码不一致/.test(inline));
check('公开注册接口 GET/POST 都挂在 /api/admin/register', /pathname === '\/api\/admin\/register'/.test(indexTs));
check('注册接口在鉴权闸门之前(公开)',
  indexTs.indexOf("'/api/admin/register'") <
    indexTs.lastIndexOf('const auth = await requireAdmin(request, e);'));
check('后端有 handleRegister', /export async function handleRegister\(/.test(apiTs));
check('注册 INSERT 里 role 是字面量 user(不接受请求体)',
  /INSERT INTO users[\s\S]{0,200}VALUES \(\?1, \?2, 'user'/.test(apiTs));
// 特权字段检查必须**只看 handleRegister 的函数体** —— admin-api.ts 里合法的
// 「管理员建用户」接口本来就会绑定 body.role, 全文扫描会把那条正常路径误判成漏洞。
const regBlock = apiTs.match(/export async function handleRegister[\s\S]*?\n\}\n/);
check('切出 handleRegister 函数体', !!regBlock);
const regBody = regBlock ? regBlock[0] : '';
check('注册不绑定角色/余额等特权字段',
  !/body\.(role|balance|frozen_balance|concurrency|status|platform_access)/.test(regBody));
check('注册开关走 settings(registration_enabled)', /REGISTRATION_SETTING = 'registration_enabled'/.test(apiTs));
check('注册默认状态走 settings(registration_auto_approve)', /AUTO_APPROVE_SETTING = 'registration_auto_approve'/.test(apiTs));
check('只有显式 false 才算关(与门户时期语义一致)', /toLowerCase\(\) !== 'false'/.test(apiTs));
check('关掉注册时接口返回 403', /管理员已关闭注册/.test(apiTs));
check('邮箱已注册返回 409', /该邮箱已注册[\s\S]{0,140}409\)/.test(apiTs));
check('邮箱正则不要求域名带点(兼容 admin@local)', /REGISTER_EMAIL_RE = \/\^\[\^\\s@\]\+@\[\^\\s@\.\]\+/.test(apiTs));
check('注册进审计日志', /'register:' \+ email/.test(apiTs));
check('设置页有注册开关', /id="reg-enabled"/.test(html) && /id="reg-approve"/.test(html));
check('设置页写入 registration_enabled', /registration_enabled: \$\('#reg-enabled'\)\.value/.test(inline));

// ---------- 11. 加载态: 进度条 + 转圈 ----------
console.log('\n[11] 加载态');
check('顶部进度条元素存在', /<div id="progress"><i><\/i><\/div>/.test(html));
check('进度条是渐变配色', /#progress i \{[\s\S]{0,400}linear-gradient/.test(html));
check('进度条动画是不确定式(不确定进度)', /@keyframes indeterminate/.test(html));
check('有转圈样式 .spinner', /\.spinner \{[\s\S]{0,300}animation: spin/.test(html));
check('有统一的 loadingHTML()', /function loadingHTML\(msg\)/.test(inline));
check('loadingHTML 返回字符串(内页与弹窗都能用)',
  /return '<div class="loading">/.test(inline));
check('进度条用计数而非布尔(并发请求不会提前收)', /PROGRESS_N \+= 1/.test(inline) && /PROGRESS_N = Math\.max\(0, PROGRESS_N - 1\)/.test(inline));
check('navigate 里会启动进度条', /startProgress\(\);/.test(inline));
check('内容写回 #main 后自动收起进度条', /MutationObserver/.test(inline));
check('页面报错不再卡在「加载中」', /加载失败: /.test(inline));
check('已无裸的「加载中…」占位', !/'<div class="empty">加载中…<\/div>'/.test(inline));

// ---------- 12. 角色权限弹窗布局 ----------
console.log('\n[12] 角色权限弹窗布局');
check('弹窗分段(form-section)', /class="form-section"/.test(inline));
check('权限用卡片网格(perm-grid)', /class="perm-grid"/.test(inline));
check('每个菜单是可点击的 .perm 卡片', /class="perm" data-k="/.test(inline));
check('通配「全部菜单」是独立强调行', /class="perm-all"/.test(inline));
check('有已选计数反馈', /id="r-count"/.test(inline) && /refreshPermUI/.test(inline));
check('未选任何菜单会红色提示', /cnt\.style\.color = !wildcard && n === 0/.test(inline));
check('基础信息用两列网格', /class="grid2"/.test(inline));

// ---------- 13. 新增四个「我的」页面 + 数据看板 + 签到 ----------
console.log('\n[13] 新菜单: 概览 / 数据看板 / 使用日志 / 个人资料');
for (const k of ['overview', 'board', 'logs', 'profile']) {
  check(`侧栏含 ${k}`, new RegExp(`data-page="${k}"`).test(html));
  check(`PAGE_TITLES 含 ${k}`, new RegExp(`\\b${k}: '`).test(inline));
  check(`后端 MENUS_BY_RESOURCE 登记 ${k}`, new RegExp(`^\\s*${k}: '${k}',`, 'm').test(apiTs));
  check(`CONSOLE_PAGES 含 ${k}`, indexTs.includes(`'${k}'`) || indexTs.includes(`  ${k},`));
}
// 侧栏要有分组标题, 且「管理」组下的菜单对业务用户自动隐藏
check('侧栏有分组标题(.nav-group)', /class="nav-group"/.test(html));
check('applyMenus 会隐藏空分组标题', /querySelectorAll\('\.nav-group'\)/.test(inline));
check('「我的 API Key」已改名 API秘钥', /data-page="mykeys">API秘钥</.test(html));
check('旧名「我的 API Key」已不在侧栏', !/data-page="mykeys">我的 API Key</.test(html));

// 概览页: 四块内容
check('概览页含额度信息(余额卡片)', /statCard\('余额'/.test(inline));
check('概览页含公告信息块', /公告信息/.test(inline));
check('概览页含近 24h 消耗', /近 24 小时/.test(inline) && /last24h/.test(apiTs));
check('概览页含历史使用情况', /历史使用情况/.test(inline));
check('概览页含请求计数', /请求数/.test(inline));

// 数据看板
check('看板有模型调用分析', /模型调用分析/.test(inline) && /by_model/.test(apiTs));
check('看板有 token 总数', /Token 总数/.test(inline) && /total_tokens/.test(apiTs));
check('看板有消耗分布(按天/平台/Key)', /by_platform/.test(apiTs) && /by_key/.test(apiTs) && /by_day/.test(apiTs));
check('看板非管理员强制只看自己', /const selfScoped = !me\.is_admin;/.test(apiTs));

// 使用日志: 八列
console.log('\n[14] 使用日志列');
for (const col of ['时间 (UTC+8)', '令牌', '模型', '>流<', 'Tokens (入/出)', '费用', '耗时', '详情']) {
  check(`表头含「${col}」`, inline.includes(col));
}
check('use日志按会话用户过滤', /GET \/api\/admin\/logs[\s\S]{0,900}l\.user_id = \?1/.test(apiTs));
check('日志里的 Key 明文被打码', /function maskKey\(/.test(apiTs) && /maskKey\(String\(r\.key_value/.test(apiTs));
check('日志有详情弹窗', /function showLogDetail\(id\)/.test(inline));
check('日志有分页', /logsState/.test(inline) && /lg-next/.test(inline));

// 个人资料 + 签到
console.log('\n[15] 个人资料与每日签到');
check('资料页显示用户名称', /row2\('用户名称'/.test(inline));
check('资料页显示邮箱', /row2\('邮箱'/.test(inline));
check('资料页显示分组', /row2\('所属分组'/.test(inline));
check('资料页有钱包(余额/总用量/总请求数)', /钱包/.test(inline) && /total_requests/.test(apiTs));
check('签到按钮存在', /id="btn-checkin"/.test(inline));
check('签到接口 POST /profile/checkin', /rest === 'checkin'/.test(apiTs) && /doCheckin/.test(apiTs));
check('签到金额 100~200 随机', /CHECKIN_MIN = 100/.test(apiTs) && /CHECKIN_MAX = 200/.test(apiTs));
check('签到判重靠主键冲突(不是先查后写)',
  /ON CONFLICT\(user_id, day\) DO NOTHING/.test(apiTs) && /user_checkins/.test(apiTs));
check('重复签到返回 409', /今天已经签到过了[\s\S]{0,80}409/.test(apiTs));
check('签到按北京时间切天(不用 UTC)', /function bjDayString/.test(apiTs) && /8 \* 3600 \* 1000/.test(apiTs));
check('签到加余额写 users.balance', /UPDATE users SET balance = balance \+ \?1/.test(apiTs));
check('签到写审计日志', /'checkin', 'user'/.test(apiTs));
check('签到开关可关(checkin_enabled), 关了返回 403', /checkin_enabled/.test(apiTs) && /签到功能已关闭/.test(apiTs));
check('签到表进 schema.sql(新环境自动建)', /CREATE TABLE IF NOT EXISTS user_checkins/.test(read('schema/schema.sql')));
check('签到表有独立迁移文件', existsSync(join(root, 'schema/schema-user-checkins.sql')));

// ---------- 16. 公告管理 ----------
// 公告有两条权限完全不同的路径, 这里把关键约束静态钉死:
//   读(已发布) = 任何登录用户; 写 = 「公告管理」菜单。
// 最怕的两件事: ① 读公告也挂上菜单闸门(业务用户顶栏点公告就 403);
//              ② 只改状态/置顶也把 revision +1(全员无谓弹窗)。
console.log('\n[16] 公告管理');
const annSql = read('schema/schema-announcements.sql');
check('存在 announcements 迁移文件', existsSync(join(root, 'schema/schema-announcements.sql')));
check('建表 SQL 有 announcements 表', /CREATE TABLE IF NOT EXISTS announcements/.test(annSql));
check('表有软删列 deleted_at', /deleted_at\s+TEXT/.test(annSql));
check('表有内容版本列 revision', /revision\s+INTEGER NOT NULL DEFAULT 1/.test(annSql));
check('表有置顶列 pinned', /pinned\s+INTEGER NOT NULL DEFAULT 0/.test(annSql));
check('列表索引含 deleted_at', /idx_announcements_list[\s\S]{0,120}deleted_at/.test(annSql));
check('迁移脚本存在且登记', existsSync(join(root, 'tools/migrate-announcements.mjs')));
check('存在后端 handleAnnouncements', /async function handleAnnouncements\(/.test(apiTs));
check('存在已发布公告读取 getLiveAnnouncements', /async function getLiveAnnouncements\(/.test(apiTs));
check('MENUS_BY_RESOURCE 登记 announcements -> announce',
  /announcements: 'announce'/.test(apiTs));
check('MENU_CATALOG 含 announce', /key: 'announce'/.test(apiTs));
check('CONSOLE_PAGES 含 announce', indexTs.includes("'announce'"));
check('入口路径保留段黑名单含 announce', /'audit', 'announce'/.test(gatewayTs));
// 读公告必须在菜单闸门之前分发 —— 否则业务用户拿不到公告。
// 🚨 但**只能拦 GET + 恰好一段路径**: 写成"只要一段就只放 GET"会把
//    POST /announcements(新建公告)一起 405 掉, 公告就永远发不出来(已踩 1 次)。
check('已发布公告读取在菜单闸门之前(任何登录用户可读)',
  apiTs.indexOf("if (resource === 'announcements' && parts.length === 1 && method === 'GET')") <
    apiTs.indexOf('const needMenu = MENUS_BY_RESOURCE'));
check('读公告的放行分支限定 GET(否则 POST 新建会被拦)',
  /resource === 'announcements' && parts\.length === 1 && method === 'GET'/.test(apiTs));
// 管理列表必须与用户侧那条 GET 分开: 否则草稿会在管理页凭空消失(已踩 1 次)
check('管理列表走 /announcements/all(与用户侧区分)',
  /parts\[1\] !== 'all'/.test(apiTs) && /api\('\/announcements\/all'\)/.test(inline));
// 读接口只回已发布内容
check('读取只取 status=published',
  /status = 'published'[\s\S]{0,200}ORDER BY pinned DESC, id DESC/.test(apiTs));
check('读取排除软删行', /WHERE deleted_at IS NULL AND status = 'published'/.test(apiTs));
// 兼容老键(纯读回落)
check('回落读 settings.announcement(老公告不丢)',
  /LEGACY_ANNOUNCEMENT_KEY = 'announcement'/.test(apiTs));
// revision 只跟内容走
check('revision 仅在标题/正文变化时 +1',
  /const contentChanged = \(hasTitle && title !== existing\.title\) \|\| \(hasContent && content !== existing\.content\)/.test(apiTs));
check('revision 自增基于旧值', /Number\(existing\.revision \?\? 1\) \+ \(contentChanged \? 1 : 0\)/.test(apiTs));
// 删除是软删 + changes 判定
check('删除是软删(UPDATE deleted_at)',
  /UPDATE announcements SET deleted_at = \?1 WHERE id = \?2 AND deleted_at IS NULL/.test(apiTs));
check('删除按 changes 判定 404', /Number\(res\.meta\?\.changes \?\? 0\) === 0\) return notFound/.test(apiTs));
// 状态白名单 fail-safe: 非 published 一律 draft
check('创建时状态白名单(fail-safe 到 draft)',
  /body\.status === ANNOUNCE_STATUS\.published[\s\S]{0,80}ANNOUNCE_STATUS\.published[\s\S]{0,80}ANNOUNCE_STATUS\.draft/.test(apiTs));
check('标题/正文长度上限存在', /ANNOUNCE_MAX_TITLE = 200/.test(apiTs) && /ANNOUNCE_MAX_CONTENT = 20000/.test(apiTs));
check('公告写操作进审计日志', /'create', 'announcement'/.test(apiTs) && /'update', 'announcement'/.test(apiTs) && /'delete', 'announcement'/.test(apiTs));
// 前端: 侧栏 / 标题 / 顶栏按钮 / 登录弹窗 / 已读记忆
check('前端侧栏有公告管理项', /data-page="announce">公告管理</.test(html));
check('PAGE_TITLES 含 announce', /\bannounce: '/.test(inline));
check('存在 PAGES.announce 页面函数', /PAGES\.announce = async/.test(inline));
check('公告页有新建按钮', /id="btn-ann-new"/.test(inline));
check('顶栏有公告按钮', /id="btn-announce"/.test(html));
check('顶栏公告按钮在 .right 内(用户右侧)', /class="right"[\s\S]{0,400}id="btn-announce"/.test(html));
check('登录成功后调用公告弹窗', /maybeAnnounce\(\)/.test(inline) && /doLogin[\s\S]{0,1400}maybeAnnounce\(\)/.test(inline));
check('已读版本记进 localStorage', /localStorage/.test(inline) && /announce_read_version/.test(inline));
check('版本一致时不再打扰(比对已读版本)', /data\.version === annReadVersion\(\)/.test(inline));
check('公告页有分页/列表渲染', /annRender|annList/.test(inline));
check('公告编辑弹窗有标题与详情字段', /id="an-title"/.test(inline) && /id="an-content"/.test(inline));

console.log(`\n=== 结果: ${pass} passed, ${fail} failed ===\n`);
process.exit(fail ? 1 : 0);
