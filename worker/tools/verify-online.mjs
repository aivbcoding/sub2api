/**
 * 线上验收: 确认新功能真的部署上去了。
 *   1. /dashboard 页面里出现合并后的「模型获取与定价」(标签页 别名 / 定价)与「模型别名」入口
 *      —— 旧的独立「模型获取」(discover) 菜单已摘除
 *   2. /dashboard 里出现 suggestAlias / d-alias / al-alias 等新前端代码
 *   3. 未登录访问 /api/admin/accounts/1/models -> 401(新路由已挂上, 且受鉴权保护)
 *   4. 「按模型名猜平台」已移除、自动发现提示已上线
 *   5. 统一登录: 域名根目录 = 控制台首页, 未登录 302 到 /login; /login 自身 200
 *   6. 角色菜单: 侧栏含「API秘钥」「角色权限」, 用户管理有创建时间列
 *   7. 独立门户已彻底下线: /portal 与 /api/portal/* 都是 404
 *   8. 菜单路径不再带 /admin 前缀: /dashboard /users ... 直接挂根下, 旧 /admin/* 一律 404
 *   9. 定价页三块(默认单价 / 从上游获取并一键定价 / 手动新增) + 计费无硬编码价目表
 *  10. 请求日志/操作审计的批量删除(多选 + 全选 + 确认弹窗, 仅超管)已上线且未登录 401
 *
 * 用法: node tools/verify-online.mjs
 */
const BASE = process.env.BASE_URL ?? 'https://sub2api.aixm.ccwu.cc';

let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) fail++; };

try {
  // 2026-09-21: 控制台路径去掉 /admin 前缀, 菜单直接挂根下(/dashboard, /users, ...)。
  // 未登录访问这些路径会 302 到 /login —— fetch 默认跟随重定向, 拿到的是同一份 SPA
  // HTML, 所以下面这些内容断言依然有效(它们验的是"页面里有没有这段代码")。
  const r = await fetch(`${BASE}/dashboard`);
  const html = await r.text();
  ok(r.status === 200, `/dashboard -> HTTP ${r.status}(未登录会跟随 302 到 /login)`);
  ok(html.includes('id="login-view"'), '/dashboard(或 /login)返回的是控制台 SPA');
  // 2026-09-22: 「模型获取」页并入「模型定价」页(标签页 别名 / 定价), discover 菜单已摘除
  ok(!html.includes('data-page="discover"'), '导航已无 data-page="discover"(模型获取页已合并)');
  ok(/PAGES\.discover\s*=/.test(html) === false, 'PAGES.discover 页面函数已移除');
  // 2026-09-24: 独立「模型别名」菜单也并入「模型定价」页的「别名」标签
  ok(!html.includes('data-page="aliases"'), '导航已无独立 data-page="aliases"(别名菜单已并入模型定价)');
  ok(html.includes('模型管理'), '页面含合并后的「模型管理」标题');
  ok(html.includes('自行新增别名') && html.includes('从上游获取并批量新增'),
    '「模型别名」标签含 ①自行新增 ②从上游获取 两块');
  ok(!/PAGES\.aliases\s*=/.test(html), 'PAGES.aliases 独立页面函数已移除');
  ok(html.includes('function suggestAlias'), '含 suggestAlias(平台名+模型ID 规范)');
  ok(html.includes('d-alias'), '含模型获取表格的别名输入框');
  ok(html.includes('al-alias'), '含别名编辑弹窗的输入框');

  // ---- 合并页: 标签页切换「别名 / 定价」 ----
  ok(html.includes('class="page-tabs sticky"'), '有标签页容器 .page-tabs(吸顶)');
  ok(html.includes('data-mtab="alias"') && html.includes('data-mtab="price"'),
    '标签项是 别名 / 定价 两个(data-mtab)');
  ok(html.includes('function modelsAliasView'), '别名视图渲染函数 modelsAliasView 已上线');
  ok(html.includes('function modelsPricingView'), '定价视图渲染函数 modelsPricingView 已上线');

  // ---- 定价页: 默认单价 / 一键设置定价 / 手动新增 ----
  ok(html.includes('默认单价'), '定价页有「默认单价」兜底可配置');
  ok(html.includes('id="pd-save"') && html.includes('id="pd-reset"'),
    '默认单价可保存 + 可还原出厂默认');
  ok(html.includes('id="m-fetch"'), '定价页可从上游获取模型');
  ok(html.includes('id="m-apply"'), '定价页有「一键设置定价」(整批写入)');
  ok(html.includes('data-save-one'), '定价页支持逐行保存(单独设置定价)');
  ok(html.includes('id="p-new"'), '定价页可手动新增定价(拉不到上游时的入口)');
  // 计费不再有代码里写死的价目表
  ok(!html.includes('BUILTIN_PRICING') && !html.includes('FALLBACK_PRICE'),
    '计费已无硬编码价目表(价格只来自定价页)');

  // ---- 批量删除: 多选 + 全选 + 确认弹窗(仅超管) ----
  ok(html.includes('function bindBatchDelete'), '有批量删除的共用逻辑 bindBatchDelete');
  ok(html.includes('id="u-all"') && html.includes('class="u-row"'), '请求日志有多选/全选复选框');
  ok(html.includes('id="a-all"') && html.includes('class="a-row"'), '操作审计有多选/全选复选框');
  ok(html.includes('th.col-sel'), '多选列有独立窄列样式(.col-sel)');
  ok(html.includes('let IS_ADMIN = false'), '前端持有 IS_ADMIN(超管才渲染删除控件)');
  ok(/条记录吗/.test(html), '删除前弹窗确认(显示条数)');

  // ---- 使用日志(业务用户)脱敏: 详情不露上游 / 不露 UA ----
  // 线上 SPA 里的 showLogDetail 不能再出现这几行(row2 的标签就是给用户看的)。
  ok(html.indexOf("row2('上游模型'") === -1, '🧨 线上使用日志详情不再显示「上游模型」');
  ok(html.indexOf("row2('上游账号'") === -1, '🧨 线上使用日志详情不再显示「上游账号」');
  ok(html.indexOf("row2('User-Agent'") === -1, '🧨 线上使用日志详情不再显示「User-Agent」');
  ok(html.includes("l.requested_model || l.model || '-'"), '线上模型列/请求模型回落到用户自己发的名字');

  // ---- 账号级别的别名编辑已收敛到「模型别名」页 ----
  // 账号编辑窗口里再放一份 textarea, 保存时提交 model_aliases 会被后端当作
  // "整表替换", 一不小心就把该账号已有别名清空。所以只保留菜单页一个入口。
  ok(html.indexOf('a-aliases') === -1, '账号表单已移除「模型别名」编辑框(改由「模型定价→别名」标签统一管理)');

  // ---- 弹窗: 标题与按钮固定, 只有内容区滚动 ----
  ok(
    /\.modal\s*\{[^}]*flex-direction:\s*column/.test(html),
    '弹窗是纵向 flex(标题/内容/按钮三段)',
  );
  ok(/\.modal-body\s*\{[^}]*overflow-y:\s*auto/.test(html), '只有内容区自身滚动');
  ok(/\.modal-body\s*\{[^}]*min-height:\s*0/.test(html), '内容区 min-height:0(flex 子项才能收缩)');

  // ---- Request E: 名字推断已移除, 改为事实驱动的自动路由 ----
  ok(!html.includes('function inferPlatformInUi'), '按模型名推断平台的前端函数已移除');
  ok(html.indexOf('_platModelIndex') >= 0, '分组页已加载「模型名→平台」索引用于兜底判断');
  ok(html.indexOf('自动路由') >= 0, '分组页文案已说明自动路由(新模型无需配置)');

  // ---- 日志/时间统一按北京时间 (UTC+8) 展示 ----
  ok(html.indexOf('Asia/Shanghai') >= 0, '时间格式器已固定为 Asia/Shanghai');
  ok(html.indexOf('时间 (UTC+8)') >= 0, '请求日志/操作审计的时间列已标注 UTC+8');

  // ---- 账号表单「平台」= 可下拉也可直接输入的组合框 ----
  ok(html.indexOf('acct-platform-list') >= 0, '账号表单的平台字段挂了 datalist 候选');
  ok(html.indexOf('list="acct-platform-list"') >= 0, '平台输入框是可输入组合框');
  ok(html.indexOf('__custom__') === -1, '旧的「＋ 自定义平台」两步式已移除');
  // 别名会参与选号这件事, 随编辑框一起搬到了「模型别名」页
  ok(html.includes('别名同时兼作路由依据'), '「模型别名」页已说明别名会参与选号(不是单纯改名)');
  // 账号弹窗里不能再出现"到账号编辑手填别名"这种指向已删功能的老文案
  ok(html.indexOf('账号编辑里手填') === -1, '已清除"到账号编辑里手填别名"的老文案');
  ok(html.indexOf('上游账号 → 编辑」手动填写模型别名') === -1, '已清除"到上游账号编辑填别名"的老文案');

  // ---- 入口路径: 由请求 URL 指定上游, 不再靠模型名判平台 ----
  ok(html.indexOf('id="a-entry"') >= 0, '账号表单有「入口路径」输入框');
  ok(html.indexOf('入口路径') >= 0, '页面含「入口路径」文案');
  ok(html.indexOf('ENTRY_PATH_RESERVED') >= 0, '前端有入口路径保留字校验(不能撞 v1/models 等)');
  ok(html.indexOf('data-copy-entry') >= 0, '账号列表的入口路径可一键复制完整地址');

  // ---- 分组白名单已停用 ----
  ok(html.indexOf('g-allow') === -1, '分组表单已移除「模型白名单」输入框');

  // ---- 分组「账号数」不再把已删除账号算进去 (幽灵绑定) ----
  // 起因: default 组显示「账号数 6」, 实际只有 3 个活账号 ——
  // account_groups 关联行不会随账号软删除一起清掉。
  ok(html.indexOf('account_count_stale') >= 0, '分组页会提示「失效绑定」数量(不再虚报账号数)');
  ok(html.indexOf('data-bind-grp') >= 0, '分组行有「上游账号」按钮(打开绑定管理)');
  ok(html.indexOf('function groupAccountsForm') >= 0, '含分组↔账号绑定管理弹窗');
  ok(html.indexOf('g-acct') >= 0, '绑定弹窗有账号勾选框');

  // ---- 用户管理: 平台白名单 / RPM / 名下 Key ----
  ok(html.indexOf('id="u-access"') >= 0, '用户表单有「平台白名单」输入框');
  ok(html.indexOf('id="u-rpm"') >= 0, '用户表单有「RPM 限制」输入框');
  ok(html.indexOf('data-user-keys') >= 0, '用户列表的 Key 数可点开查看名下 Key');
  ok(html.indexOf('data-toggle-user') >= 0, '用户列表支持一键启用/停用');

  // ---- 分组列表列名: 账号数 -> 上游账号数 ----
  ok(html.indexOf('<th>上游账号数</th>') >= 0, '分组列表列名已改为「上游账号数」');
  ok(html.indexOf('<th>账号数</th>') === -1, '旧的「账号数」列名已不存在(避免与用户混淆)');

  // ---- 用户密码: 新建即有默认密码, 可修改 ----
  ok(html.indexOf('id="u-pwd"') >= 0, '用户表单有「密码」输入框');
  ok(html.indexOf('id="u-pwd-default"') >= 0, '有「用默认密码」按钮');
  ok(html.indexOf('default_password') >= 0, '默认密码由后端下发(前端不硬编码)');
  ok(html.indexOf('has_password') >= 0, '用户列表明示密码是否已设置');
  ok(html.indexOf('reset-missing-passwords') >= 0, '有「补齐默认密码」的历史数据修复入口');

  // ---- 后台布局: 顶栏固定 + 左右各自滚动 + 每个菜单独立路径 ----
  ok(html.indexOf('class="topbar"') >= 0, '有固定顶栏(不随内容滚动)');
  ok(html.indexOf('flex-direction: column') >= 0, '主布局是纵向 flex(顶栏 + 下方左右两栏)');
  ok(html.indexOf('overflow-y: auto') >= 0, '侧栏与内容区各自独立滚动');
  // 2026-09-21: 菜单路径去掉 /admin 前缀, ADMIN_BASE 清空, 直接挂域名根下
  ok(html.indexOf("ADMIN_BASE = ''") >= 0, '每个菜单走独立路径 /<page>(已去掉 /admin 前缀)');
  ok(html.indexOf("ADMIN_BASE = '/admin'") === -1, '前端已不再引用 /admin 前缀');
  ok(html.indexOf('history.pushState') >= 0, '切页用 pushState —— 仍是单页应用, 不整页刷新');

  // ---- 操作审计: 分页请求展示 ----
  ok(html.indexOf('const auditState') >= 0, '审计页有分页状态(auditState)');
  ok(html.indexOf('AUDIT_PAGE_SIZES') >= 0, '审计页有每页条数候选');
  ok(html.indexOf("'/audit?limit='") >= 0, '审计页按 limit/offset 分页请求');
  ok(html.indexOf('auditFetch') >= 0, '审计页有取数入口 auditFetch()');
  ok(html.indexOf('id="a-prev"') >= 0 && html.indexOf('id="a-next"') >= 0, '审计页有上一页/下一页按钮');
  ok(html.indexOf('id="a-size"') >= 0, '审计页可选每页条数');
  ok(html.indexOf('本页没有记录') >= 0, '审计页区分「本页无记录」与「还没有记录」');

  // ---- 快速切菜单不再串页: 导航令牌 ----
  // 症状: 地址栏/高亮是操作审计, 内容还是上一个菜单 —— 先发起的请求后返回, 盖掉了新页面。
  ok(html.indexOf('let NAV_SEQ = 0') >= 0, '有导航令牌 NAV_SEQ');
  ok(html.indexOf('const navTok = ()') >= 0, '有取令牌函数 navTok()');
  ok(html.indexOf('const gone = (t)') >= 0, '有过期判定 gone(t)');
  ok((html.match(/gone\(tok\)/g) || []).length >= 11, '每个页面函数都挂了过期守卫(≥11 处)');
  ok(/NAV_SEQ\s*\+=\s*1/.test(html), 'navigate() 里自增令牌');

  // ---- 模型获取页正文留白 ----
  // 只验"有内边距", 不锁死具体像素 —— 布局微调(16→17px)不该让线上验收变红
  ok(/\.panel-body\s*\{[^}]*padding:\s*1[0-9]px/.test(html), '面板正文有内边距(.panel-body)');
  ok(/\.hint\s*\{[^}]*line-height:\s*1\.9/.test(html), '说明文字统一了行高(.hint)');
  ok(html.indexOf('class="panel-body"') >= 0, '模型获取页正文套了 .panel-body');
  ok(html.indexOf('class="result-body"') >= 0, '模型获取页结果区有独立留白');

  // ---- 统一登录 / 角色菜单 ----
  ok(html.indexOf('data-page="mykeys"') >= 0, '侧栏含「API秘钥」(业务用户自助页)');
  ok(html.indexOf('data-page="roles"') >= 0, '侧栏含「角色权限」');
  ok(html.indexOf('API秘钥') >= 0, '页面含「API秘钥」文案(已由「我的APIkey」改名)');
  ok(html.indexOf('我的 API Key') === -1, '旧名「我的 API Key」已不在侧栏/标题');
  // ---- 2026-09-21 新增四个菜单 ----
  ok(html.indexOf('data-page="overview"') >= 0, '侧栏含「概览」');
  ok(html.indexOf('data-page="board"') >= 0, '侧栏含「数据看板」');
  ok(html.indexOf('data-page="logs"') >= 0, '侧栏含「使用日志」');
  ok(html.indexOf('data-page="profile"') >= 0, '侧栏含「个人资料」');
  ok(html.indexOf('class="nav-group"') >= 0, '侧栏有分组标题(我的 / 管理)');
  ok(html.indexOf('function overviewRender') >= 0, '概览页已上线');
  ok(html.indexOf('function boardRender') >= 0, '数据看板页已上线');
  ok(html.indexOf('function logsRender') >= 0, '使用日志页已上线');
  ok(html.indexOf('function profileRender') >= 0, '个人资料页已上线');
  ok(html.indexOf('function doCheckin') >= 0, '每日签到已上线');
  ok(html.indexOf('/profile/checkin') >= 0, '签到接口 POST /profile/checkin');
  ok(html.indexOf('余额') >= 0 && html.indexOf('总请求数') >= 0, '个人资料页有钱包(余额/总请求数)');
  ok(html.indexOf('function applyMenus') >= 0, '前端会按角色隐藏侧栏菜单(applyMenus)');
  ok(html.indexOf('function renderDenied') >= 0, '无权限页面有明确兜底提示(不是静默跳首页)');
  ok(html.indexOf('ALLOWED_MENUS') >= 0, '菜单权限来自登录身份(ALLOWED_MENUS)');
  ok(html.indexOf('function rolesRender') >= 0, '角色权限页已上线');
  ok(html.indexOf('btn-new-role') >= 0, '角色权限页可新建角色');
  ok(html.indexOf('r-menu') >= 0, '角色弹窗有菜单勾选框');
  ok(html.indexOf('btn-new-mykey') >= 0, '「API秘钥」页可自助新建 Key');
  ok(html.indexOf('<th>创建时间 (UTC+8)</th>') >= 0, '用户管理已新增「创建时间」列');
  ok(html.indexOf('用户名或邮箱') >= 0, '登录页支持用户名或邮箱(统一登录页)');
  ok(html.indexOf('请输入管理员账号和密码') === -1, '登录页文案不再写死"管理员"');
  ok(html.indexOf('id="ss-group"') >= 0, '设置页有「自助 Key 默认分组」');
  ok(html.indexOf('self_service_group_id') >= 0, '设置项键名与后端一致(self_service_group_id)');

  // ---- 独立门户必须彻底下线 ----
  ok(html.indexOf('id="p-enabled"') === -1, '设置页已移除门户开关(门户已废弃)');
  ok(html.indexOf('portal_auto_approve') === -1, '设置页已移除门户注册相关配置');
  ok(html.indexOf('/portal') === -1, '前端已无 /portal 引用');

  const pr = await fetch(`${BASE}/portal`, { redirect: 'manual' });
  ok(pr.status === 404, `GET /portal -> 404(门户已下线, 实际 ${pr.status})`);
  const pc = await fetch(`${BASE}/api/portal/config`, { redirect: 'manual' });
  ok(pc.status === 404, `GET /api/portal/config -> 404(实际 ${pc.status})`);

  // ---- 根目录即控制台 + 未登录重定向 ----
  const root = await fetch(`${BASE}/`, { redirect: 'manual' });
  ok(root.status === 302, `未登录 GET / -> 302(实际 ${root.status})`);
  ok((root.headers.get('location') ?? '') === '/login', `Location: /login(实际 ${root.headers.get('location')})`);
  ok((root.headers.get('cache-control') ?? '').includes('no-store'), '根重定向带 no-store(不被浏览器缓存)');

  // 2026-09-21: 深链接改成 /users(菜单去掉 /admin 前缀后直接挂根下)
  const deep = await fetch(`${BASE}/users`, { redirect: 'manual' });
  ok(deep.status === 302, `未登录 GET /users -> 302(实际 ${deep.status})`);
  ok((deep.headers.get('location') ?? '').includes('next='), '深链接重定向带 next=(登录后可回跳)');

  // 旧前缀必须**彻底消失**(用户选择"彻底删掉 /admin 路由", 不是重定向)
  const oldAdminPage = await fetch(`${BASE}/admin/users`, { redirect: 'manual' });
  ok(oldAdminPage.status === 404, `旧路径 GET /admin/users -> 404(实际 ${oldAdminPage.status})`);
  const oldAdminRoot = await fetch(`${BASE}/admin`, { redirect: 'manual' });
  ok(oldAdminRoot.status === 404, `旧路径 GET /admin -> 404(实际 ${oldAdminRoot.status})`);

  const lg = await fetch(`${BASE}/login`, { redirect: 'manual' });
  const lgHtml = await lg.text();
  ok(lg.status === 200, `GET /login -> 200(自身不再重定向, 实际 ${lg.status})`);
  ok(lgHtml.includes('id="login-btn"'), '/login 返回带登录表单的页面');

  // 站点机器可读信息(原先挂在 /, 现在搬到 /api/info)
  const infoRes = await fetch(`${BASE}/api/info`);
  const rootJson = await infoRes.json().catch(() => ({}));
  ok(infoRes.status === 200, `GET /api/info -> ${infoRes.status}`);
  ok(rootJson.console === '/dashboard', `站点信息含 console: /dashboard(实际 ${JSON.stringify(rootJson.console)})`);
  ok(Array.isArray(rootJson.endpoints), '站点信息含 endpoints 列表');
  ok(Array.isArray(rootJson.pages) && rootJson.pages.includes('dashboard') && rootJson.pages.includes('overview'),
    `站点信息含 pages 白名单(实际 ${JSON.stringify(rootJson.pages ?? [])})`);
  ok(rootJson.register === '/register', `站点信息含 register: /register(实际 ${JSON.stringify(rootJson.register)})`);

  // ---- 注册页与登录页分离 ----
  ok(html.indexOf('id="register-view"') >= 0, '有独立注册视图 #register-view');
  ok(html.indexOf('id="go-register"') >= 0, '登录页有「立即注册」入口');
  ok(html.indexOf('id="go-login"') >= 0, '注册页有「去登录」入口');
  ok(html.indexOf('id="reg-pass2"') >= 0, '注册表单有确认密码');
  ok(html.indexOf('id="login-banner"') >= 0, '登录页有注册成功后的提示横幅');

  const rg = await fetch(`${BASE}/register`, { redirect: 'manual' });
  ok(rg.status === 200, `GET /register -> 200(注册页自身不重定向, 实际 ${rg.status})`);

  const rcfgRes = await fetch(`${BASE}/api/admin/register`);
  const rcfg = await rcfgRes.json().catch(() => ({}));
  ok(rcfgRes.status === 200, `GET /api/admin/register -> ${rcfgRes.status}(公开配置)`);
  ok(typeof rcfg.enabled === 'boolean', '注册配置含 enabled');
  ok(Number(rcfg.min_password_length) >= 8, '注册配置含密码下限');

  // 故意发一个非法邮箱: 既能证明接口活着, 又**不会在生产库里留下任何账号**
  const badReg = await fetch(`${BASE}/api/admin/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'verify-online-not-an-email', password: 'verify-online-pwd' }),
  });
  ok(badReg.status === 400, `POST /register 非法邮箱 -> 400(实际 ${badReg.status})`);

  // ---- 加载态: 进度条 + 转圈 ----
  ok(html.indexOf('<div id="progress"><i></i></div>') >= 0, '有顶部加载进度条');
  ok(/@keyframes indeterminate/.test(html), '进度条是不确定进度动画');
  ok(/\.spinner\s*\{[^}]*animation:\s*spin/.test(html), '有转圈加载指示器(.spinner)');
  ok(html.indexOf('function loadingHTML') >= 0, '有统一的 loadingHTML()');
  ok(html.indexOf('MutationObserver') >= 0, '内容渲染完成后会自动收起进度条');
  // 2026-09-21: 加载框要「上下居中」——
  // .main 必须是纵向 flex, .loading 要 flex:1 撑满高度, 且不能再用固定 padding 顶在顶部。
  ok(/\.main\s*\{[^}]*display:\s*flex[^}]*flex-direction:\s*column/.test(html),
    '内容区是纵向 flex(加载框才能垂直居中)');
  ok(/\.main\s*>\s*\.loading\s*\{[^}]*flex:\s*1/.test(html),
    '加载态吃掉剩余空间(.main > .loading { flex:1 })');
  ok(!/\.loading\s*\{[^}]*padding:\s*60px/.test(html),
    '加载态不再用固定 60px padding 顶在顶部');

  // ---- 顶栏: 不再重复显示当前菜单名 ----
  ok(html.indexOf('id="topbar-crumb"') === -1,
    '顶栏已移除当前菜单名(各页 .page-head 已有标题, 不再重复)');
  ok(html.indexOf('class="who" id="topbar-user"') >= 0,
    '顶栏账号信息是胶囊结构(.who)');
  ok(html.indexOf('function setTopbarUser') >= 0,
    '有 setTopbarUser() 统一写顶栏账号信息');
  ok(html.indexOf('.topbar .brand .logo') >= 0,
    '顶栏品牌有 logo 徽标');

  // ---- 侧栏: 分组标题加大加粗 + 菜单小图标(2026-09-21) ----
  ok(/\.nav-group\s*\{[^}]*font-size:\s*1[4-9]px/.test(html),
    '侧栏分组标题(我的/管理)字号加大');
  ok(/\.nav-group\s*\{[^}]*font-weight:\s*(?:7|8|9)00/.test(html),
    '侧栏分组标题加粗');
  ok(/\.nav-group\s*\{[^}]*color:\s*#111827/.test(html),
    '侧栏分组标题颜色加深');
  ok(/\.nav-group::before\s*\{/.test(html), '侧栏分组标题有装饰竖条');
  // 图标必须走 CSS ::before(写进 HTML 会破坏 data-page>标签 的守卫断言)
  ok(/\.nav-item::before\s*\{/.test(html), '菜单图标走 CSS ::before(不写进 HTML)');
  // 2026-09-24: aliases 菜单并入模型定价, 图标规则从 17 -> 16
  ok((html.match(/\.nav-item\[data-page="[a-z0-9_-]+"\]::before/g) || []).length >= 16,
    '每个侧栏菜单项都配了图标');

  // ---- 右侧内容区美化(2026-09-21) ----
  ok(/\.main\s*\{[^}]*padding:\s*0\s+32px\s+32px/.test(html),
    '右侧内容区留白加大(padding 32px)');
  ok(/\.main::-webkit-scrollbar\s*\{/.test(html), '右侧内容区有细滚动条样式');
  ok(/\.page-head h2::before\s*\{/.test(html), '页面标题左有强调竖条');
  ok(/\.panel-title::before\s*\{/.test(html), '面板标题有强调竖条');
  ok(/th\s*\{[^}]*position:\s*sticky/.test(html), '表头 sticky(长表格有上下文)');
  ok(/\.btn\s*\{[^}]*display:\s*inline-flex/.test(html), '按钮统一 inline-flex');

  // ---- 角色权限弹窗新布局 ----
  ok(html.indexOf('class="form-section"') >= 0, '角色弹窗分段(form-section)');
  ok(html.indexOf('class="perm-grid"') >= 0, '菜单权限用卡片网格(perm-grid)');
  ok(html.indexOf('class="perm-all"') >= 0, '「全部菜单」是独立强调行');
  ok(html.indexOf('id="r-count"') >= 0, '权限弹窗有已选数量反馈');

  // ---- 新增接口已挂上且受鉴权保护 ----
  const rl = await fetch(`${BASE}/api/admin/roles`);
  ok(rl.status === 401, `未登录 GET /roles -> 401(实际 ${rl.status})`);
  const rlc = await fetch(`${BASE}/api/admin/roles`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: 'verify-online', name: 'x' }),
  });
  ok(rlc.status === 401, `未登录 POST /roles -> 401(实际 ${rlc.status})`);

  const mk = await fetch(`${BASE}/api/admin/my/keys`);
  ok(mk.status === 401, `未登录 GET /my/keys -> 401(实际 ${mk.status})`);
  const mkp = await fetch(`${BASE}/api/admin/my/keys`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'verify-online-should-fail' }),
  });
  ok(mkp.status === 401, `未登录 POST /my/keys -> 401(实际 ${mkp.status})`);
  const mkd = await fetch(`${BASE}/api/admin/my/keys/1`, { method: 'DELETE' });
  ok(mkd.status === 401, `未登录 DELETE /my/keys/1 -> 401(实际 ${mkd.status})`);
  const mu = await fetch(`${BASE}/api/admin/my/usage`);
  ok(mu.status === 401, `未登录 GET /my/usage -> 401(实际 ${mu.status})`);

  // 2026-09-21 新增的四个菜单接口同样必须受鉴权保护
  for (const res of ['overview', 'board', 'logs', 'profile']) {
    const rn = await fetch(`${BASE}/api/admin/${res}`);
    ok(rn.status === 401, `未登录 GET /${res} -> 401(实际 ${rn.status})`);
  }
  // 签到是**写**接口, 匿名必须被挡下(否则就是"谁都能加余额")
  const ciAnon = await fetch(`${BASE}/api/admin/profile/checkin`, { method: 'POST' });
  ok(ciAnon.status === 401, `未登录 POST /profile/checkin -> 401(实际 ${ciAnon.status})`);

  // 伪造的会话 cookie 必须被签名校验挡下
  const forged = await fetch(`${BASE}/api/admin/me`, {
    headers: { cookie: 's2a_admin_token=forged.token.value' },
  });
  ok(forged.status === 401, `伪造会话 cookie 调 /api/admin/me -> 401(实际 ${forged.status})`);
  // 旧的"门户 cookie"名已经彻底不认了
  const forgedUser = await fetch(`${BASE}/api/admin/me`, {
    headers: { cookie: 's2a_user_token=forged.token.value' },
  });
  ok(forgedUser.status === 401, `旧门户 cookie 名不再被接受 -> 401(实际 ${forgedUser.status})`);

  // 新路由存在且受保护
  const m = await fetch(`${BASE}/api/admin/accounts/1/models`);
  ok(m.status === 401, `未登录 GET /accounts/1/models -> 401(实际 ${m.status})`);

  // 审计分页接口已挂上且受鉴权保护
  const au = await fetch(`${BASE}/api/admin/audit?limit=5&offset=0`);
  ok(au.status === 401, `未登录 GET /audit?limit=5 -> 401(实际 ${au.status})`);

  // 补齐默认密码接口同样受保护
  const rp = await fetch(`${BASE}/api/admin/users/reset-missing-passwords`, { method: 'POST' });
  ok(rp.status === 401, `未登录 POST /users/reset-missing-passwords -> 401(实际 ${rp.status})`);

  // 分组↔账号 绑定管理接口已挂上且受鉴权保护
  const ga = await fetch(`${BASE}/api/admin/groups/1/accounts`);
  ok(ga.status === 401, `未登录 GET /groups/1/accounts -> 401(实际 ${ga.status})`);
  const gp = await fetch(`${BASE}/api/admin/groups/1/accounts`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ account_ids: [] }),
  });
  ok(gp.status === 401, `未登录 PUT /groups/1/accounts -> 401(实际 ${gp.status})`);

  // ---- 批量删除接口已挂上且受鉴权保护(2026-09-22) ----
  // 注意它们都是 DELETE **带 JSON 请求体**(id 数组装在体里, 查询串装不下 500 条),
  // 所以这里必须真的带体发一次 —— 入口漏解析 DELETE body 时, 未登录仍是 401,
  // 但登录后会变成 "ids is required", 那种回归只有本地 e2e 抓得到(见 test/admin-delete-pricing-e2e.mjs)。
  for (const path of ['/api/admin/usage', '/api/admin/audit', '/api/admin/models']) {
    const dr = await fetch(`${BASE}${path}`, {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ids: [1], models: ['nonexistent-model'] }),
    });
    ok(dr.status === 401, `未登录 DELETE ${path} -> 401(实际 ${dr.status})`);
  }

  // 老的账号接口没被弄坏
  const a = await fetch(`${BASE}/api/admin/accounts`);
  ok(a.status === 401, `未登录 GET /accounts -> 401(实际 ${a.status})`);

  // 中继主链路仍然正常
  const h = await fetch(`${BASE}/health`);
  ok(h.status === 200, '/health 200');
  const j = await h.json().catch(() => ({}));
  ok(j.status === 'ok', "health.status === 'ok'");
} catch (e) {
  console.error('✗ 异常:', e.message);
  fail++;
}

console.log(`\n=== ${fail === 0 ? '线上验收全部通过' : fail + ' 项失败'} ===`);
process.exit(fail ? 1 : 0);
