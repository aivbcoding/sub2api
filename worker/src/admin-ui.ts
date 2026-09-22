/**
 * 管理后台前端 —— 单文件内嵌 HTML (无构建步骤)
 * 由 Worker 在 /admin 路径直接返回
 *
 * 设计: 原生 JS + CSS, 无外部依赖(不引 CDN, 避免网络问题)
 * 主题: 亮色, 与 IDE 主题一致
 */

export function renderAdminPage(): Response {
  return new Response(ADMIN_HTML, {
    status: 200,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      // 后台页面禁止被 iframe 嵌套, 降低点击劫持风险
      'x-frame-options': 'DENY',
      'content-security-policy':
        "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; form-action 'none'",
    },
  });
}

const ADMIN_HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>sub2api 管理后台</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  :root {
    --bg: #f5f7fa;
    --panel: #ffffff;
    /* 右侧内容区底色。**单独一个变量, 别直接改 --bg**: 登录页/注册页的 body 底色
       还是浅灰, 只有主界面的内容区按用户要求改成纯白。 */
    --content: #ffffff;
    --border: #e4e8ee;
    --text: #1f2328;
    --muted: #6b7280;
    --accent: #2563eb;
    --accent-hover: #1d4ed8;
    --danger: #dc2626;
    --ok: #059669;
    --warn: #d97706;
    --radius: 10px;
    /* 面板/卡片用更大的圆角 —— 块越大越需要"松"一点的圆角, 10px 在大面板上显紧 */
    --radius-lg: 14px;
    /* 阴影三档: 1=轻投影(卡片常态) / 2=面板浮起 / 3=悬浮态。
       🚨 内容区改成纯白之后, "白卡压在灰底上"这层天然对比就没了 ——
       卡片和面板再不靠阴影区分, 整页会糊成一片白。这套阴影是必需的, 不是装饰。 */
    --shadow-1: 0 1px 2px rgba(16,24,40,.05);
    --shadow-2: 0 1px 3px rgba(16,24,40,.06), 0 8px 22px -10px rgba(16,24,40,.13);
    --shadow-3: 0 2px 6px rgba(16,24,40,.08), 0 14px 30px -12px rgba(16,24,40,.18);
  }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
    background: var(--bg); color: var(--text); font-size: 14px; line-height: 1.5;
  }
  button { font-family: inherit; font-size: 13px; cursor: pointer; }
  input, select, textarea {
    font-family: inherit; font-size: 13px; padding: 7px 10px;
    border: 1px solid var(--border); border-radius: 6px; background: #fff; color: var(--text); width: 100%;
  }
  input:focus, select:focus, textarea:focus {
    outline: 2px solid #bfdbfe; border-color: var(--accent);
    /* 再加一圈柔光, 焦点在白底上更"跳"一点 */
    box-shadow: 0 0 0 3px rgba(37,99,235,.10);
  }
  a { color: var(--accent); }

  /* 登录页 / 注册页 —— 两个独立视图, 同一套卡片皮肤。
     #login-view 默认显示, #register-view 默认隐藏, 由 showLogin()/showRegister() 切换。
     刻意做成两个视图而不是一个卡片里换 tab: 地址栏 /login 与 /register 各自可收藏、可分享。 */
  /* 三个互斥视图: 启动引导 / 登录 / 注册。
     🚨 #boot-view 默认**显示**、#login-view 默认**隐藏** —— 这两行顺序是本次改动的核心:
        反过来(登录页默认 flex)时, 刷新页面会先闪一下登录页, 等 /api/admin/me 回来才切走,
        看起来就像"掉登录了"。启动引导顶在前面, 才有机会先显示"正在验证登录状态…"。 */
  #boot-view, #login-view, #register-view {
    align-items: center; justify-content: center;
    min-height: 100vh; padding: 20px;
  }
  #boot-view { display: flex; opacity: 0; animation: bootFade .2s ease .12s forwards; }
  #login-view { display: none; }
  #register-view { display: none; }
  /* 🚨 别把上面那条改成直接 opacity:1 —— 认证很快时(本地通常 <200ms)会"闪出一个等待框",
     比不显示更扎眼。先透明、延后 120ms 再淡入: 快就用不上它, 慢才会出现。 */
  @keyframes bootFade { to { opacity: 1; } }
  .boot-card { text-align: center; padding: 34px 28px; max-width: 330px; }
  .boot-card .spinner { margin: 0 auto 16px; }
  .boot-t { font-size: 14px; font-weight: 600; color: var(--text); }
  .boot-s { margin-top: 7px; font-size: 12px; color: var(--muted); line-height: 1.6; }
  .login-card {
    background: var(--panel); border: 1px solid var(--border); border-radius: 12px;
    padding: 32px; width: 100%; max-width: 380px; box-shadow: 0 4px 24px rgba(0,0,0,.06);
  }
  #register-view .login-card { max-width: 400px; }
  .login-card h1 { font-size: 19px; margin-bottom: 6px; }
  .login-card p.sub { color: var(--muted); font-size: 13px; margin-bottom: 22px; }
  .login-card label { display: block; margin-bottom: 6px; font-size: 13px; font-weight: 500; }
  .login-card .field { margin-bottom: 16px; }
  /* 卡片底部的「去注册 / 去登录」切换条 */
  .auth-switch {
    margin-top: 18px; padding-top: 14px; border-top: 1px solid var(--border);
    text-align: center; font-size: 13px; color: var(--muted);
  }
  .auth-switch a { cursor: pointer; font-weight: 600; margin-left: 4px; text-decoration: none; }
  .auth-switch a:hover { text-decoration: underline; }
  /* 表单上方的结果横幅(注册成功后跳回登录页时用来提示) */
  .banner { border-radius: 6px; padding: 9px 12px; font-size: 12px; line-height: 1.6; margin-bottom: 16px; }
  .banner.ok { background: #d1fae5; color: #065f46; }
  .banner.err { background: #fee2e2; color: #991b1b; }

  /* 主布局 —— 整屏不滚动: 顶栏固定, 左导航与右内容各自独立滚动 */
  /* 主界面整体白底(登录/注册页仍用 --bg 浅灰, 衬白色登录卡)。
     🚨 内容区改白之后这里必须跟着白 —— 否则宽屏上 .main 触到 max-width 之后,
        两侧会露出 body 的灰边, 白底就"只白了一半"。 */
  #app-view { display: none; flex-direction: column; height: 100vh; background: var(--content); }
  /* 顶栏 —— 品牌 + 账号信息 + 退出。
     刻意**不放当前菜单名**: 每个页面自己的 .page-head 已经有大标题了,
     顶栏再重复一遍属于冗余噪音(用户明确要求去掉)。 */
  .topbar {
    flex: 0 0 auto; height: 56px;
    display: flex; align-items: center; justify-content: space-between; gap: 16px;
    padding: 0 22px; background: var(--panel); border-bottom: 1px solid var(--border);
    box-shadow: 0 1px 2px rgba(16, 24, 40, .04);
    position: relative; z-index: 10;
  }
  /* 品牌左侧的品牌色竖条装饰, 让顶栏不至于一片惨白 */
  .topbar::before {
    content: ''; position: absolute; left: 0; top: 0; bottom: 0; width: 3px;
    background: linear-gradient(180deg, var(--accent), #22d3ee);
  }
  .topbar .brand {
    display: flex; align-items: baseline; gap: 9px;
    padding: 0; border-bottom: none; margin-bottom: 0;
    font-size: 16px; font-weight: 700; letter-spacing: .2px;
  }
  .topbar .brand .logo {
    align-self: center; width: 22px; height: 22px; flex: 0 0 auto;
    display: flex; align-items: center; justify-content: center;
    border-radius: 6px; font-size: 12px; font-weight: 700; color: #fff;
    background: linear-gradient(135deg, var(--accent), #22d3ee);
  }
  .topbar .brand small {
    display: inline; margin: 0; font-weight: 400; color: var(--muted); font-size: 11px;
    padding-left: 9px; border-left: 1px solid var(--border);
  }
  .topbar .right { display: flex; align-items: center; gap: 10px; }
  /* 账号信息做成胶囊, 与按钮拉开层次 */
  .topbar .who {
    display: flex; align-items: center; gap: 7px;
    padding: 5px 11px; border-radius: 999px;
    background: #f3f4f6; border: 1px solid var(--border);
    font-size: 12px; color: var(--text); max-width: 260px;
  }
  .topbar .who .dot {
    width: 6px; height: 6px; border-radius: 50%; background: var(--ok); flex: 0 0 auto;
  }
  .topbar .who .nm {
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .topbar .who .rl { color: var(--muted); flex: 0 0 auto; }
  .layout { display: flex; flex: 1 1 auto; min-height: 0; }
  .sidebar {
    width: 216px; background: var(--panel); border-right: 1px solid var(--border);
    padding: 10px 0 24px; flex-shrink: 0; height: 100%; overflow-y: auto;
  }
  /* 细滚动条: 默认那条灰粗条在浅色侧栏上很突兀 */
  .sidebar::-webkit-scrollbar { width: 8px; }
  .sidebar::-webkit-scrollbar-thumb { background: #e5e7eb; border-radius: 4px; }
  .sidebar::-webkit-scrollbar-thumb:hover { background: #d1d5db; }
  .sidebar::-webkit-scrollbar-track { background: transparent; }
  .brand { padding: 0 18px 18px; font-weight: 600; font-size: 15px; border-bottom: 1px solid var(--border); margin-bottom: 12px; }
  .brand small { display: block; font-weight: 400; color: var(--muted); font-size: 11px; margin-top: 2px; }

  /* ---- 导航项 ---- */
  /* 图标用 CSS ::before 的 emoji, **不写进 HTML**。
     原因: 静态守卫断言侧栏标签紧跟 data-page(如 data-page="mykeys">API秘钥<),
     一旦在标签前后插 <i>/<svg> 就会破坏该断言。用伪元素插图标则两边都满足。 */
  .nav-item {
    display: flex; align-items: center; gap: 9px;
    width: calc(100% - 16px); margin: 1px 8px; text-align: left;
    padding: 9px 12px; border-radius: 7px;
    background: none; border: none; border-left: none;
    color: #4b5563; font-size: 13px; line-height: 1.4;
    transition: background .14s, color .14s;
  }
  .nav-item::before {
    flex: 0 0 auto; width: 17px; text-align: center;
    font-size: 14px; line-height: 1; opacity: .9;
  }
  .nav-item:hover { background: #f3f4f6; color: var(--text); }
  .nav-item.active {
    background: #eff6ff; color: var(--accent); font-weight: 600;
    box-shadow: inset 0 0 0 1px #dbeafe;
  }
  .nav-item.active::before { opacity: 1; }
  /* 各菜单的图标(按 data-page 匹配, 与 label 解耦)。
     图标码位写成两个 Unicode 转义(代理对)而不是码点形式:
     模板字面量里码点转义和"数字开头"的转义都会触发 tsc 的 TS1487,
     而普通 Unicode 转义求值成真字符后, 正好就是浏览器 CSS content 想要的东西。
     ⚠️ 连**注释里**也不能出现反斜杠-u / 反斜杠-数字 这类转义写法 —— 同样会被求值。 */
  .nav-item[data-page="overview"]::before  { content: '\uD83C\uDFE0'; }
  .nav-item[data-page="mykeys"]::before    { content: '\uD83D\uDD11'; }
  .nav-item[data-page="logs"]::before      { content: '\uD83D\uDCC4'; }
  .nav-item[data-page="profile"]::before   { content: '\uD83D\uDC64'; }
  .nav-item[data-page="dashboard"]::before { content: '\uD83D\uDCCA'; }
  .nav-item[data-page="board"]::before     { content: '\uD83D\uDCC8'; }
  .nav-item[data-page="keys"]::before      { content: '\uD83D\uDD10'; }
  .nav-item[data-page="accounts"]::before  { content: '\u2601\uFE0F'; }
  .nav-item[data-page="aliases"]::before   { content: '\uD83C\uDFF7\uFE0F'; }
  .nav-item[data-page="groups"]::before    { content: '\uD83D\uDCC1'; }
  .nav-item[data-page="users"]::before     { content: '\uD83D\uDC65'; }
  .nav-item[data-page="models"]::before    { content: '\uD83D\uDCB0'; }
  .nav-item[data-page="usage"]::before     { content: '\uD83D\uDCDD'; }
  .nav-item[data-page="audit"]::before     { content: '\uD83E\uDDFE'; }
  .nav-item[data-page="announce"]::before  { content: '\uD83D\uDCE2'; }
  .nav-item[data-page="roles"]::before     { content: '\uD83D\uDEE1\uFE0F'; }
  .nav-item[data-page="settings"]::before  { content: '\u2699\uFE0F'; }

  /* ---- 侧栏分组标题(「我的」/「管理」)----
     用户要求: 加大、加黑、加粗。整组都没权限时由 applyMenus 把它一起藏掉。 */
  .nav-group {
    display: flex; align-items: center; gap: 8px;
    padding: 16px 16px 7px; margin-top: 4px;
    font-size: 14px; font-weight: 800; letter-spacing: .02em;
    color: #111827; text-transform: none;
  }
  /* 标题前的小色块 —— 比纯文字更"有分量", 也顺手拉开了与菜单项的距离 */
  .nav-group::before {
    content: ''; flex: 0 0 auto;
    width: 3px; height: 13px; border-radius: 2px;
    background: linear-gradient(180deg, var(--accent), #22d3ee);
  }
  .nav-group:first-child { padding-top: 6px; margin-top: 0; }

  /* 右侧内容区自己滚 —— 页面再长也不会把顶栏和导航带跑。
     display:flex + flex-direction:column 是为了让「加载中」那一屏能撑满高度,
     从而在垂直方向真正居中(否则 .loading 只是个普通块, 只能水平居中)。 */
  .main {
    flex: 1; height: 100%; overflow-y: auto; overflow-x: auto;
    padding: 0 32px 32px; max-width: 1400px;
    margin: 0 auto;
    background: var(--content);
    display: flex; flex-direction: column;
    scroll-behavior: smooth;
  }
  .main::-webkit-scrollbar { width: 10px; height: 10px; }
  /* 🚨 thumb 的 border 色必须跟内容区底色一致 —— 滚动条是"压在内容上"的,
     内容区换白而这里还写 --bg(浅灰), 滚动条两侧就会拖出一圈灰框。改底色必改这里。 */
  .main::-webkit-scrollbar-thumb { background: #d8dce1; border-radius: 5px; border: 2px solid var(--content); }
  .main::-webkit-scrollbar-thumb:hover { background: #c2c8cf; }
  /* 页面正常内容(表格/面板)都是块级, 在 flex 列容器里要显式占满宽度 */
  .main > * { flex: 0 0 auto; width: 100%; }
  /* 加载态要吃掉剩余空间并居中, 所以单独放宽它的伸缩 */
  .main > .loading { flex: 1 1 auto; }

  /* 每个页面自己的标题栏: 内容滚动时它留在顶部。
     底部加一条渐隐分隔线, 内容是"滚到标题下面"的观感, 比硬切一条实线自然。 */
  .page-head {
    position: sticky; top: 0; z-index: 5;
    display: flex; align-items: center; justify-content: space-between;
    padding: 22px 0 14px; margin-bottom: 12px; gap: 12px; flex-wrap: wrap;
    /* 🚨 两档颜色都要跟着内容区底色走: 第一档挡住滚上来的内容, 第二档是同色的全透明版
       (渐隐用)。以前这里硬编码灰(246,247,249), 内容区改白后标题栏底部会拖一条灰尾巴。 */
    background: linear-gradient(180deg, #fff 76%, rgba(255,255,255,0));
  }
  .page-head h2 {
    font-size: 19px; font-weight: 700; letter-spacing: -.01em;
    display: flex; align-items: center; gap: 9px;
  }
  /* 标题左侧的强调竖条, 和侧栏分组标题同一套视觉语言 */
  .page-head h2::before {
    content: ''; flex: 0 0 auto;
    width: 3px; height: 17px; border-radius: 2px;
    background: linear-gradient(180deg, var(--accent), #22d3ee);
  }
  .page-head .actions { display: flex; gap: 8px; }

  /* 卡片 / 统计 */
  .cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(168px, 1fr)); gap: 14px; margin-bottom: 24px; }
  .card {
    background: var(--panel); border: 1px solid var(--border); border-radius: var(--radius-lg);
    padding: 16px 17px; box-shadow: var(--shadow-1);
    transition: border-color .16s, box-shadow .16s, transform .16s;
  }
  .card:hover { border-color: #d3dae2; box-shadow: var(--shadow-3); transform: translateY(-1px); }
  .card .k { color: var(--muted); font-size: 12px; margin-bottom: 7px; }
  .card .v { font-size: 23px; font-weight: 700; letter-spacing: -.015em; }
  .card .v small { font-size: 12px; font-weight: 400; color: var(--muted); }

  /* 表格 / 详情面板 */
  .panel {
    background: var(--panel); border: 1px solid var(--border); border-radius: var(--radius-lg);
    overflow: hidden; box-shadow: var(--shadow-2);
  }
  .panel + .panel { margin-top: 22px; }
  .panel-title {
    padding: 13px 17px; border-bottom: 1px solid var(--border);
    font-weight: 600; font-size: 13.5px;
    /* 内容区是纯白的, 标题栏要有一点自己的色阶, 否则整块面板会"糊"在一起 */
    background: linear-gradient(180deg, #fdfdfe, #f8fafc);
    display: flex; align-items: center; gap: 8px;
  }
  .panel-title::before {
    content: ''; flex: 0 0 auto;
    width: 3px; height: 13px; border-radius: 2px; background: var(--accent); opacity: .75;
  }
  /* 面板正文内边距。.panel 自身没有 padding, 只给标题/表格留白 ——
     往面板里直接塞 <p>、表单、按钮时会把内容顶到边框上, 所以正文一律套这层。 */
  .panel-body { padding: 17px; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th, td { padding: 11px 14px; text-align: left; border-bottom: 1px solid var(--border); white-space: nowrap; }
  th {
    background: #f8fafc; color: #64748b; font-weight: 600; font-size: 11.5px;
    letter-spacing: .03em; position: sticky; top: 0; z-index: 1;
  }
  tbody tr { transition: background .12s; }
  tbody tr:last-child td { border-bottom: none; }
  tbody tr:hover { background: #f8fafc; }
  td.wrap { white-space: normal; max-width: 320px; word-break: break-all; }

  /* 批量选择列 —— 表格首列的复选框(超管删日志/审计用)。
     列宽压到最窄, 表头那个是「全选本页」。 */
  th.col-sel, td.col-sel { width: 38px; padding-left: 16px; padding-right: 4px; }
  th.col-sel input, td.col-sel input { width: auto; margin: 0; vertical-align: middle; cursor: pointer; }
  .empty { padding: 32px; text-align: center; color: var(--muted); font-size: 13px; }

  /* ---- 图表 (纯 CSS, 不引外部库) ----
     柱状图: .bars 是 flex 容器, 每根 .bar 里 <i> 的高度 = 占比百分比。
     固定高度容器 + overflow:hidden, 免得 100% 高度把卡片顶破。 */
  .bars { display: flex; align-items: flex-end; gap: 4px; height: 160px; padding-top: 8px; }
  .bar { flex: 1 1 0; min-width: 6px; height: 100%; display: flex; flex-direction: column;
         justify-content: flex-end; align-items: center; gap: 4px; }
  .bar i { display: block; width: 100%; border-radius: 3px 3px 0 0;
           background: linear-gradient(180deg, #3b82f6, #93c5fd); transition: filter .15s; }
  .bar:hover i { filter: brightness(.88); }
  .bar span { font-size: 10px; color: var(--muted); white-space: nowrap;
              transform: rotate(-45deg); transform-origin: center; }
  /* 横向占比条(表格里用) */
  .minibar { height: 8px; background: #f1f5f9; border-radius: 4px; overflow: hidden; }
  .minibar i { display: block; height: 100%; border-radius: 4px;
               background: linear-gradient(90deg, #2563eb, #22d3ee); }
  /* 筛选行: 自动换行, 窄屏时每项占满一行 */
  .filters { display: flex; flex-wrap: wrap; gap: 12px; align-items: flex-end; }
  .filters .form-row { margin: 0; min-width: 180px; flex: 0 1 auto; }
  .filters select { min-width: 180px; }
  /* 分页条 */
  .pager {
    display: flex; align-items: center; gap: 10px;
    padding: 12px 17px; border-top: 1px solid var(--border);
    /* 与 .panel-title 同一套渐变, 让面板"头尾有色阶、中间是白的" */
    background: linear-gradient(180deg, #fcfdfe, #f9fafc);
  }
  .pager .muted { margin-right: auto; }
  /* 公告正文: 预留换行的纯文本块 */
  .announce { white-space: pre-wrap; line-height: 1.8; font-size: 13px; }

  /* ---- 加载态 ----
     顶部进度条是 position:fixed 的, 所以切菜单时它出现在视口最上方(不占布局、不引起跳动);
     内容区再放一个转圈 + 文案, 让人知道"是在等数据"而不是"页面坏了"。 */
  #progress {
    position: fixed; top: 0; left: 0; right: 0; height: 3px; z-index: 400;
    opacity: 0; transition: opacity .2s ease; pointer-events: none;
  }
  #progress.on { opacity: 1; }
  #progress i {
    display: block; height: 100%; width: 35%; border-radius: 0 3px 3px 0;
    background: linear-gradient(90deg, #2563eb 0%, #3b82f6 40%, #22d3ee 100%);
    box-shadow: 0 0 10px rgba(37, 99, 235, .55);
    animation: indeterminate 1.15s cubic-bezier(.45, .05, .55, .95) infinite;
  }
  @keyframes indeterminate {
    0%   { transform: translateX(-110%) scaleX(.5); }
    55%  { transform: translateX(90%)  scaleX(1); }
    100% { transform: translateX(280%) scaleX(.4); }
  }
  /* 加载态: 上下居中(靠 .main 的 flex + .loading 的 flex:1 撑满高度实现)。
     刻意**不用固定 padding** —— 固定 padding 只会把它顶在顶部, 屏幕再高也不居中。
     同时给一个 min-height, 保证在弹窗 body(不是 flex 容器)里也有像样的高度。 */
  .loading {
    display: flex; flex-direction: column; align-items: center; justify-content: center;
    gap: 14px; min-height: 220px; padding: 24px 20px; color: var(--muted);
    text-align: center;
  }
  .spinner {
    width: 30px; height: 30px; border-radius: 50%;
    border: 3px solid #e5e7eb; border-top-color: var(--accent);
    animation: spin .75s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
  .loading-txt { font-size: 13px; color: var(--muted); letter-spacing: .3px; }

  /* 按钮 */
  .btn {
    display: inline-flex; align-items: center; justify-content: center; gap: 6px;
    padding: 7px 14px; border-radius: 7px; border: 1px solid var(--border);
    background: #fff; color: var(--text); font-weight: 500;
    box-shadow: 0 1px 1.5px rgba(16,24,40,.04);
    transition: background .14s, border-color .14s, box-shadow .14s, color .14s;
  }
  .btn:hover { background: #f8fafc; border-color: #d3dae2; }
  .btn:active { transform: translateY(.5px); }
  .btn.primary {
    background: var(--accent); border-color: var(--accent); color: #fff;
    box-shadow: 0 1px 2px rgba(37,99,235,.28);
  }
  .btn.primary:hover { background: var(--accent-hover); border-color: var(--accent-hover); }
  .btn.danger { color: var(--danger); border-color: #fecaca; }
  .btn.danger:hover { background: #fef2f2; border-color: #fca5a5; }
  .btn.warn { color: #92400e; border-color: #fde68a; }
  .btn.warn:hover { background: #fffbeb; border-color: #fcd34d; }
  .btn.sm { padding: 4px 10px; font-size: 12px; border-radius: 6px; }
  .btn:disabled { opacity: .5; cursor: not-allowed; box-shadow: none; }
  .btn:disabled:active { transform: none; }
  /* 顶栏「操作说明 / 公告」按钮: 比普通按钮更轻, 带一个小红点提示"有未读公告"。
     ⚠️ 这里原来是 background:rgba(255,255,255,.16) + color:#fff —— 那是**深色顶栏**的写法,
     而顶栏底色其实是白的(--panel), 于是悬浮 = 白底白字 + 背景几乎无变化,
     看起来就是"hover 之后字没了"(用户反馈)。现在改成浅色底 + 品牌色文字。 */
  .btn.ghost { background: transparent; border-color: transparent; box-shadow: none; color: #4b5563; }
  .btn.ghost:hover { background: #eef2f7; border-color: transparent; color: var(--accent); }
  .btn.ghost:active { background: #e3e9f2; }
  .topbar .btn.ghost { position: relative; }
  /* 顶栏两个按钮的图标 —— 与侧栏同款做法: 走 CSS ::before, **不写进 HTML**
     (HTML 里保持纯文字, 免得动到任何"标签紧跟 >"式的静态断言)。 */
  #btn-docs::before     { content: '\uD83D\uDCD8'; font-size: 13px; line-height: 1; }
  #btn-announce::before { content: '\uD83D\uDCE2'; font-size: 13px; line-height: 1; }
  .badge {
    display: inline-block; min-width: 7px; height: 7px; border-radius: 50%;
    background: #ef4444; margin-left: 2px; vertical-align: middle;
    box-shadow: 0 0 0 2px var(--panel);
    animation: badgePulse 2.2s ease-in-out infinite;
  }
  .badge.hidden { display: none; }
  @keyframes badgePulse {
    0%, 100% { transform: scale(1); opacity: 1; }
    50%      { transform: scale(1.28); opacity: .78; }
  }

  /* 徽标 */
  .tag { display: inline-block; padding: 2px 8px; border-radius: 10px; font-size: 11px; font-weight: 500; }
  .tag.ok { background: #d1fae5; color: #065f46; }
  .tag.off { background: #f3f4f6; color: #4b5563; }
  .tag.warn { background: #fef3c7; color: #92400e; }
  .tag.err { background: #fee2e2; color: #991b1b; }

  /* 筛选条 */
  .filter-bar {
    display: flex; flex-wrap: wrap; gap: 10px 12px; align-items: flex-end;
    background: var(--panel); border: 1px solid var(--border); border-radius: var(--radius);
    padding: 14px 16px; margin-bottom: 16px;
  }
  .filter-item { display: flex; flex-direction: column; gap: 4px; }
  .filter-item > label { font-size: 11px; color: var(--muted); font-weight: 500; }
  .filter-item select, .filter-item input { width: auto; min-width: 130px; padding: 6px 9px; font-size: 12px; }
  .filter-item.wide input { min-width: 190px; }
  .filter-item.date input { min-width: 140px; }
  .filter-actions { display: flex; gap: 8px; margin-left: auto; align-items: flex-end; }

  /* 表格容器(横向滚动) */
  .table-wrap { overflow-x: auto; }

  /* 标签页 —— 一页多视图时用(如「模型获取与定价」的 别名 / 定价)。
     用下边框指示当前项, 视觉语言与 .panel / .page-head 保持一致。
     ⚠️ 标签项**不要**写成 data-page —— 那是侧栏菜单键, 会被角色守卫
     当成"侧栏多了一个菜单项"而报错。这里统一用 data-mtab。 */
  .page-tabs {
    display: flex; align-items: center; gap: 2px;
    border-bottom: 1px solid var(--border); margin-bottom: 16px;
  }
  .page-tab {
    appearance: none; background: transparent; border: 0;
    border-bottom: 2px solid transparent; margin-bottom: -1px;
    padding: 9px 15px; font-size: 13px; font-weight: 500; color: var(--muted);
    cursor: pointer; transition: color .14s, border-color .14s;
  }
  .page-tab:hover { color: var(--text); }
  .page-tab.active { color: var(--accent); border-bottom-color: var(--accent); }

  /* 分页 */
  .pager {
    display: flex; align-items: center; gap: 10px; justify-content: flex-end;
    padding: 12px 16px; border-top: 1px solid var(--border);
    font-size: 12px; color: var(--muted); flex-wrap: wrap;
  }
  .pager select { width: auto; padding: 4px 8px; font-size: 12px; }

  /* 详情键值表 */
  .kv { display: grid; grid-template-columns: 132px 1fr; gap: 8px 14px; font-size: 13px; }
  .kv .kk { color: var(--muted); }
  .kv .vv { word-break: break-all; }
  .kv-title { font-weight: 600; font-size: 12px; color: var(--muted); margin: 16px 0 8px; }
  .kv-title:first-child { margin-top: 0; }

  /* 列设置勾选 */
  .cols-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px 16px; font-size: 13px; }
  .cols-grid label { display: flex; align-items: center; gap: 8px; font-weight: 400; }
  .cols-grid input { width: auto; }

  /* 弹窗 */
  .overlay {
    position: fixed; inset: 0; background: rgba(0,0,0,.35);
    display: flex; align-items: center; justify-content: center; padding: 20px; z-index: 100;
  }
  .overlay.hidden { display: none; }
  /* 弹窗 = 「固定标题 + 可滚动内容 + 固定按钮」的纵向 flex。
     以前是整块 .modal 加 overflow-y:auto, 长表单(上游账号)一滚标题和按钮就跟着跑,
     改完配置想点「保存」得先滚到最底下。现在只有 .modal-body 滚 ——
     min-height:0 是关键, 否则 flex 子项不肯收缩, 内容会把弹窗顶破。 */
  .modal {
    background: var(--panel); border-radius: 10px; width: 100%; max-width: 560px;
    max-height: 88vh; display: flex; flex-direction: column; overflow: hidden;
    box-shadow: 0 10px 40px rgba(0,0,0,.18);
  }
  .modal-head {
    padding: 16px 20px; border-bottom: 1px solid var(--border); font-weight: 600;
    flex: 0 0 auto; background: var(--panel);
    border-radius: 10px 10px 0 0;
  }
  .modal-body { padding: 18px 20px; flex: 1 1 auto; min-height: 0; overflow-y: auto; }
  .modal-foot {
    padding: 14px 20px; border-top: 1px solid var(--border);
    display: flex; justify-content: flex-end; gap: 8px;
    flex: 0 0 auto; background: var(--panel);
    border-radius: 0 0 10px 10px;
  }
  /* ---- 操作说明文档弹窗 ----
     文档是"横向阅读"型内容, 560px 太窄(代码示例会折行折到没法看), 单独放宽。 */
  .modal.wide { max-width: 1000px; max-height: 90vh; }
  /* 宽版里**外层不滚**, 滚动交给下面的左右两列各自负责 ——
     否则目录和正文会共用一个滚动条、一起滚(用户反馈"不要两个一起")。
     🚨 这里必须用 **flex 撑高**, 不能用 .doc-layout{height:100%}: .modal 只有
        max-height 没有定高, 百分比高度在它身上**解析不出来** → height:100% 退化成 auto,
        两列变成内容高度, overflow-y:auto 永远不触发, 而外层又是 overflow:hidden
        → 长文档下半截直接被裁掉、滚都滚不动(踩过, 无头探针实测 .doc-layout=3452px)。
        改成 body 做 flex 列、layout 做 flex:1 撑满, 与"加载框居中三层 CSS"同一套思路。 */
  .modal.wide .modal-body {
    padding: 0; overflow: hidden; display: flex; flex-direction: column;
  }
  .modal.wide .modal-head {
    display: flex; align-items: center; gap: 9px;
    background: linear-gradient(180deg, #fbfdff, #f5f8fc);
  }
  .modal.wide .modal-head::before { content: '\uD83D\uDCD8'; font-size: 15px; line-height: 1; }
  .modal.wide .modal-head small {
    margin-left: auto; font-weight: 400; color: var(--muted); font-size: 11.5px;
  }
  /* 左右两列**各自独立滚动**: 滚正文时目录纹丝不动(反过来也一样)。
     高度链: .modal-body(flex 列容器) → .doc-layout(flex:1 撑满) → 两列 stretch 撑满。
     🚨 别把这里的 flex:1 改回 height:100% —— 理由见上面 .modal.wide .modal-body 那段。 */
  .doc-layout { display: flex; align-items: stretch; flex: 1 1 auto; min-height: 0; }
  .doc-side {
    flex: 0 0 186px; padding: 16px 10px;
    border-right: 1px solid var(--border); background: #fcfdfe;
    overflow-y: auto;
  }
  .doc-side .doc-side-t {
    font-size: 10.5px; font-weight: 700; letter-spacing: .8px; color: #9aa4b2;
    text-transform: uppercase; padding: 0 8px 8px;
  }
  .doc-link {
    display: block; width: 100%; text-align: left; background: none; border: none;
    padding: 6px 9px; border-radius: 6px; font-size: 12.5px; color: #4b5563;
    line-height: 1.5; transition: background .13s, color .13s;
  }
  .doc-link:hover { background: #eef2f7; color: var(--text); }
  .doc-link.on { background: #eff6ff; color: var(--accent); font-weight: 600; }
  .doc-main { flex: 1 1 auto; min-width: 0; padding: 20px 24px 26px; overflow-y: auto; }
  /* 两列各自的细滚动条: 默认那条灰粗条在浅色面板上很突兀 */
  .doc-side::-webkit-scrollbar, .doc-main::-webkit-scrollbar { width: 8px; }
  .doc-side::-webkit-scrollbar-thumb, .doc-main::-webkit-scrollbar-thumb {
    background: #e5e7eb; border-radius: 4px;
  }
  .doc-side::-webkit-scrollbar-thumb:hover, .doc-main::-webkit-scrollbar-thumb:hover {
    background: #d1d5db;
  }
  .doc-side::-webkit-scrollbar-track, .doc-main::-webkit-scrollbar-track { background: transparent; }
  /* 顶部导语条 */
  .doc-hero {
    border-radius: 10px; padding: 16px 18px; margin-bottom: 22px;
    background: linear-gradient(135deg, #2563eb, #3b82f6 55%, #22d3ee);
    color: #fff; box-shadow: 0 4px 16px rgba(37,99,235,.22);
  }
  .doc-hero h3 { font-size: 16px; margin-bottom: 6px; }
  .doc-hero p { font-size: 12.5px; line-height: 1.75; opacity: .95; }
  .doc-sec { margin-bottom: 26px; scroll-margin-top: 12px; }
  .doc-sec h4 {
    display: flex; align-items: center; gap: 8px;
    font-size: 14px; margin-bottom: 10px; padding-bottom: 8px;
    border-bottom: 1px solid var(--border);
  }
  .doc-sec h4 .n {
    flex: 0 0 auto; width: 20px; height: 20px; border-radius: 6px;
    display: flex; align-items: center; justify-content: center;
    background: #eff6ff; color: var(--accent); font-size: 11px; font-weight: 700;
  }
  .doc-p { font-size: 13px; line-height: 1.85; color: #374151; margin-bottom: 10px; }
  .doc-p:last-child { margin-bottom: 0; }
  /* 章节内的小标题(如「OpenAI 协议 · curl」) */
  .doc-h5 {
    font-size: 12.5px; font-weight: 600; color: #111827;
    margin: 16px 0 8px; padding-left: 9px; position: relative;
  }
  .doc-h5::before {
    content: ''; position: absolute; left: 0; top: 2px; bottom: 2px; width: 3px;
    border-radius: 2px; background: linear-gradient(180deg, var(--accent), #22d3ee);
  }
  .doc-h5:first-child { margin-top: 0; }
  .doc-list { margin: 0 0 12px 0; padding-left: 0; list-style: none; }
  .doc-list li {
    font-size: 13px; line-height: 1.85; color: #374151;
    padding-left: 22px; position: relative; margin-bottom: 5px;
  }
  .doc-list li::before {
    content: ''; position: absolute; left: 7px; top: 9px;
    width: 5px; height: 5px; border-radius: 50%; background: var(--accent); opacity: .55;
  }
  /* 行内代码 / 占位符 */
  .doc-kbd {
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 12px; background: #f1f5f9; border: 1px solid var(--border);
    border-radius: 4px; padding: 1px 5px; color: #0f172a; word-break: break-all;
  }
  /* 代码块: 深色底 + 悬浮出现的复制按钮 */
  .doc-code { position: relative; margin: 0 0 12px; }
  .doc-code pre {
    background: #0f172a; color: #e2e8f0; border-radius: 8px;
    padding: 13px 15px; overflow-x: auto; font-size: 12px; line-height: 1.75;
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  }
  .doc-code .cp {
    position: absolute; top: 8px; right: 8px;
    padding: 3px 9px; font-size: 11px; border-radius: 5px;
    background: rgba(255,255,255,.1); border: 1px solid rgba(255,255,255,.18);
    color: #cbd5e1; opacity: 0; transition: opacity .15s, background .15s;
  }
  .doc-code:hover .cp { opacity: 1; }
  .doc-code .cp:hover { background: rgba(255,255,255,.2); color: #fff; }
  /* 提示框: 三种语气 */
  .doc-tip {
    border-radius: 8px; padding: 11px 13px; font-size: 12.5px; line-height: 1.8;
    margin-bottom: 12px; border-left: 3px solid;
  }
  .doc-tip b { display: block; margin-bottom: 2px; font-size: 12.5px; }
  .doc-tip.info { background: #eff6ff; border-color: #3b82f6; color: #1e40af; }
  .doc-tip.ok   { background: #ecfdf5; border-color: #10b981; color: #065f46; }
  .doc-tip.warn { background: #fffbeb; border-color: #f59e0b; color: #92400e; }
  /* 小表格(错误码) */
  .doc-table { width: 100%; border-collapse: collapse; margin-bottom: 12px; font-size: 12.5px; }
  .doc-table th, .doc-table td {
    border: 1px solid var(--border); padding: 7px 10px; text-align: left; vertical-align: top;
  }
  .doc-table th { background: #f8fafc; font-weight: 600; color: #374151; }
  .doc-table td { color: #4b5563; line-height: 1.7; }
  .doc-foot {
    margin-top: 22px; padding-top: 14px; border-top: 1px solid var(--border);
    font-size: 12px; color: var(--muted); line-height: 1.8;
  }
  /* ---- 公告弹窗(用户侧) ---- */
  .ann-list { display: flex; flex-direction: column; gap: 12px; }
  .ann-item {
    border: 1px solid var(--border); border-radius: 10px; overflow: hidden; background: #fff;
    box-shadow: 0 1px 2px rgba(16,24,40,.03);
  }
  .ann-item.pin { border-color: #fde68a; box-shadow: 0 1px 2px rgba(217,119,6,.08); }
  .ann-head {
    display: flex; align-items: center; gap: 8px;
    padding: 11px 14px; background: #fcfdfe; border-bottom: 1px solid var(--border);
    font-size: 13.5px; font-weight: 600;
  }
  .ann-head .ico { flex: 0 0 auto; font-size: 15px; line-height: 1; }
  .ann-head .t { flex: 1 1 auto; min-width: 0; word-break: break-word; }
  .ann-body {
    padding: 13px 15px; white-space: pre-wrap; line-height: 1.85;
    font-size: 13px; color: #374151; word-break: break-word;
  }
  .ann-empty {
    display: flex; flex-direction: column; align-items: center; gap: 8px;
    padding: 34px 0; color: var(--muted); font-size: 13px;
  }
  .ann-empty .ico { font-size: 30px; line-height: 1; opacity: .5; }
  .form-row { margin-bottom: 14px; }
  .form-row label { display: block; margin-bottom: 5px; font-size: 12px; font-weight: 500; color: #374151; }
  /* 表单内的说明紧贴输入框, 所以这里要显式覆盖全局 .hint 的段间距 */
  .form-row .hint { font-size: 11px; color: var(--muted); margin: 4px 0 0; }
  .grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }

  /* ---- 弹窗里的表单分区 ----
     长表单(角色权限)平铺一堆 .form-row 很难读, 用分段标题 + 分隔线切成几块。 */
  .form-section + .form-section { margin-top: 22px; padding-top: 18px; border-top: 1px solid var(--border); }
  .form-section-title {
    display: flex; align-items: baseline; justify-content: space-between; gap: 10px;
    font-size: 12px; font-weight: 600; color: #374151; margin-bottom: 12px;
  }
  .form-section-title .count { font-weight: 400; color: var(--muted); font-size: 11px; }

  /* ---- 菜单权限选择: 可点击的卡片网格 ----
     比一列 checkbox 好点: 每项有独立边界、hover/选中都有反馈, 11 个菜单排两列也不会很长的滚动。 */
  .perm-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
  .perm {
    display: flex; align-items: center; gap: 9px; cursor: pointer;
    padding: 9px 11px; border: 1px solid var(--border); border-radius: 8px; background: #fff;
    font-size: 13px; transition: border-color .15s, background .15s, box-shadow .15s;
  }
  .perm:hover { border-color: #c7d2fe; background: #f8faff; }
  .perm input { width: auto; margin: 0; accent-color: var(--accent); }
  .perm .perm-txt { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
  .perm .perm-key { color: var(--muted); font-size: 11px; font-family: ui-monospace, "SF Mono", Consolas, monospace; }
  .perm.on { border-color: #93c5fd; background: #eff6ff; box-shadow: inset 0 0 0 1px #bfdbfe; }
  .perm.on .perm-key { color: #3b82f6; }
  .perm.dis { opacity: .45; cursor: not-allowed; background: #fafbfc; }
  .perm.dis:hover { border-color: var(--border); }
  /* 「全部菜单」通配行 —— 单独一行, 强调它是"越过下面所有勾选"的总开关 */
  .perm-all {
    display: flex; align-items: flex-start; gap: 9px; cursor: pointer;
    padding: 11px 12px; border: 1px solid #fde68a; border-radius: 8px; background: #fffbeb;
  }
  .perm-all input { width: auto; margin: 2px 0 0; accent-color: var(--warn); }
  .perm-all-txt { font-size: 13px; }
  .perm-all-txt b { display: block; color: #92400e; }
  .perm-all-txt span { color: var(--muted); font-size: 11px; }

  @media (max-width: 560px) {
    .grid2, .perm-grid { grid-template-columns: 1fr; }
  }

  /* 说明性文字(页面提示/表单解释)。以前只有 .form-row .hint 有样式,
     面板里的 <p class="hint"> 完全没定义 —— 字号继承默认 16px、行距极挤。
     这里统一成小字 + 宽松行高, 长句才读得下去。 */
  .hint { font-size: 12px; line-height: 1.9; color: var(--muted); margin: 0 0 18px; }
  .hint:last-child { margin-bottom: 0; }
  .hint code {
    font-family: ui-monospace, "SF Mono", Consolas, monospace; font-size: 12px;
    background: #f3f4f6; border: 1px solid var(--border); border-radius: 4px; padding: 1px 5px;
  }
  /* 面板内的一组按钮 */
  .panel-actions { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
  /* 异步结果区: 有内容时才显示内边距和上分隔线, 空的时候不留空白 */
  .result-body:not(:empty) { padding: 16px; border-top: 1px solid var(--border); }

  /* 提示条 —— 用户要求放在「顶部正中间」(2026-09-22)。
     以前钉在右上角(right:18px), 与顶栏右侧的账号胶囊/退出按钮挤在同一块,
     登录后的「欢迎回来」正好压住退出按钮, 看起来像按钮坏了。
     现在水平居中: 容器左移 50% 再往回拽自身一半宽度, 多条提示时纵向堆叠居中。
     ⚠️ 容器带 transform: 子元素 .toast 的动画也要跟着改成纵向(否则会二次偏移)。 */
  #toast {
    position: fixed; top: 18px; left: 50%; transform: translateX(-50%);
    z-index: 200;
    display: flex; flex-direction: column; align-items: center; gap: 8px;
    /* 宽度跟着文字走, 但长提示(如"登录状态已失效…")不能顶到屏幕外 */
    width: max-content; max-width: min(92vw, 560px);
    /* 悬浮在内容之上, 但**不吃点击** —— 否则会挡住顶部标题区的按钮 */
    pointer-events: none;
  }
  .toast {
    padding: 10px 16px; border-radius: 6px; font-size: 13px; color: #fff;
    text-align: center; max-width: 100%; word-break: break-word;
    box-shadow: 0 4px 14px rgba(0,0,0,.16); animation: slide .2s ease;
  }
  .toast.ok { background: var(--ok); }
  .toast.err { background: var(--danger); }
  .toast.warn { background: #d97706; }
  /* 从上往下落(原来是 translateX(20px) 从右侧滑入, 与居中后的位置对不上) */
  @keyframes slide { from { transform: translateY(-12px); opacity: 0; } to { transform: none; opacity: 1; } }

  .mono { font-family: ui-monospace, "SF Mono", Consolas, monospace; font-size: 12px; }
  .muted { color: var(--muted); }
  .row-flex { display: flex; gap: 8px; align-items: center; }

  /* 新建 Key 后的一次性展示框 */
  .key-box {
    display: flex; gap: 8px; align-items: stretch;
    background: #f3f4f6; border: 1px solid var(--border, #e5e7eb);
    border-radius: 6px; padding: 6px 6px 6px 12px; margin-bottom: 12px;
  }
  .key-box code {
    flex: 1; align-self: center; word-break: break-all; line-height: 1.5;
    font-family: ui-monospace, "SF Mono", Consolas, monospace; font-size: 12px;
    user-select: all;
  }
  .key-box .btn { flex: 0 0 auto; align-self: center; }
  @media (max-width: 720px) {
    .topbar { height: auto; min-height: 52px; padding: 9px 14px; gap: 10px; }
    .topbar .brand { font-size: 15px; }
    .topbar .brand small { display: none; }
    /* 窄屏: 账号胶囊只留圆点+用户名, 角色名藏掉, 免得把退出按钮挤出去 */
    .topbar .who { padding: 5px 9px; max-width: 130px; }
    .topbar .who .rl { display: none; }
    .layout { flex-direction: column; }
    .sidebar {
      width: 100%; height: auto; flex: 0 0 auto; border-right: none;
      border-bottom: 1px solid var(--border); display: flex; align-items: center;
      overflow-x: auto; overflow-y: hidden; padding: 8px 8px 10px;
    }
    /* 窄屏下侧栏横向排列: 分组标题变成竖排小标签, 菜单项退化成胶囊 */
    .nav-group {
      flex: 0 0 auto; padding: 0 10px 0 6px; margin: 0;
      font-size: 12px; border-right: 1px solid var(--border);
      height: 26px; align-self: center;
    }
    .nav-group::before { height: 11px; }
    .nav-item {
      flex: 0 0 auto; width: auto; margin: 0 2px;
      padding: 7px 11px; border-radius: 999px; white-space: nowrap;
    }
    .nav-item.active { box-shadow: none; }
    .main { padding: 0 16px 16px; }
    /* 窄屏: 文档弹窗占满, 左侧目录改成顶部横向滚动的胶囊条 */
    /* 窄屏: 目录变成顶部横向胶囊条, 滚动交回外层 —— 竖屏空间本来就紧,
       再劈成两个独立滚动区只会两头都看不全。 */
    .modal.wide { max-width: 100%; max-height: 94vh; }
    .modal.wide .modal-head small { display: none; }
    .modal.wide .modal-body { overflow-y: auto; }
    /* 🚨 窄屏必须把 flex:1 收回去(改回 flex:0 0 auto), 否则纵排的内容会被压进
       外层高度里, 而下面两列都设了 overflow:visible → 下半截直接看不见。 */
    .doc-layout { flex-direction: column; flex: 0 0 auto; height: auto; }
    .doc-side {
      flex: 0 0 auto; width: 100%; height: auto; overflow-x: auto; overflow-y: hidden;
      border-right: none; border-bottom: 1px solid var(--border);
      display: flex; gap: 5px; padding: 9px 10px;
    }
    .doc-side .doc-side-t { display: none; }
    .doc-link { flex: 0 0 auto; width: auto; white-space: nowrap; }
    .doc-main { height: auto; overflow: visible; padding: 16px 15px 20px; }
  }
</style>
</head>
<body>

<!-- 顶部加载进度条: 切菜单/翻页/提交时出现, 内容写回 #main 后自动收起 -->
<div id="progress"><i></i></div>

<!-- ============ 启动引导(会话验证) ============ -->
<!-- 刷新页面时先显示它, 而不是直接闪一下登录页: 会话还有效就直接回到刚才那一页,
     失效才落到登录页。文案强调"在验证", 让用户明白不是掉线了。
     默认可见(见 CSS), 三个 show* 函数接管视图时会把它藏掉。 -->
<div id="boot-view">
  <div class="login-card boot-card">
    <div class="spinner"></div>
    <p class="boot-t">正在验证登录状态…</p>
    <p class="boot-s">验证通过会直接回到你刚才的页面</p>
  </div>
</div>

<!-- ============ 登录页 ============ -->
<!-- 管理员与业务用户**共用这一个登录页**, 登录后能看到哪些菜单由账号角色决定。
     所以这里刻意不写「管理员登录」之类字样 —— 写死了会让人以为业务用户没入口。 -->
<div id="login-view">
  <div class="login-card">
    <h1>sub2api 控制台</h1>
    <p class="sub">使用你的账号登录(用户名或邮箱)</p>
    <div id="login-banner" class="banner ok" style="display:none"></div>
    <div class="field">
      <label for="login-user">用户名 / 邮箱</label>
      <input id="login-user" autocomplete="username" placeholder="admin 或 you@example.com">
    </div>
    <div class="field">
      <label for="login-pass">密码</label>
      <input id="login-pass" type="password" autocomplete="current-password" placeholder="••••••••">
    </div>
    <button class="btn primary" id="login-btn" style="width:100%">登录</button>
    <p id="login-err" style="color:var(--danger);font-size:12px;margin-top:12px;min-height:16px"></p>
    <div class="auth-switch" id="login-switch">还没有账号?<a id="go-register">立即注册</a></div>
  </div>
</div>

<!-- ============ 注册页 ============ -->
<!-- 与登录页**分离**的独立视图(独立地址 /register)。注册成功后会切回登录页并把
     邮箱填进登录框 —— 用户注册完的下一步必然是登录, 不该让他再手输一遍。 -->
<div id="register-view">
  <div class="login-card">
    <h1>创建账号</h1>
    <p class="sub">注册后即可登录, 自助创建属于你的 API Key</p>
    <div class="field">
      <label for="reg-email">邮箱</label>
      <input id="reg-email" type="email" autocomplete="email" placeholder="you@example.com">
    </div>
    <div class="field">
      <label for="reg-user">用户名 <span class="muted" style="font-weight:400">(可选)</span></label>
      <input id="reg-user" autocomplete="username" placeholder="留空则用邮箱作为用户名">
    </div>
    <div class="field">
      <label for="reg-pass">密码</label>
      <input id="reg-pass" type="password" autocomplete="new-password" placeholder="至少 8 位">
    </div>
    <div class="field">
      <label for="reg-pass2">确认密码</label>
      <input id="reg-pass2" type="password" autocomplete="new-password" placeholder="再输一次">
    </div>
    <button class="btn primary" id="reg-btn" style="width:100%">注册</button>
    <p id="reg-err" style="color:var(--danger);font-size:12px;margin-top:12px;min-height:16px"></p>
    <div class="auth-switch">已有账号?<a id="go-login">去登录</a></div>
  </div>
</div>

<!-- ============ 主界面 ============ -->
<div id="app-view">
  <header class="topbar">
    <div class="brand">
      <span class="logo">S</span>
      <span>sub2api</span>
      <small>Workers 版控制台</small>
    </div>
    <div class="right">
      <!-- 这里**不再显示当前菜单名**: 各页 .page-head 已有大标题, 重复一遍是噪音 -->
      <!-- 注意: 这两个顶栏按钮**不能带 data-page 属性** —— test-roles-guard.mjs 会把
           所有 data-page 当成"侧栏菜单项", 并断言它们都在 MENU_CATALOG 里。
           它们是纯前端的查看入口, 不该进菜单权限体系, 所以只用 id 标识。 -->
      <button class="btn sm ghost" id="btn-docs" title="操作说明 / API 请求文档">操作说明</button>
      <button class="btn sm ghost" id="btn-announce" title="查看公告">公告<span class="badge hidden" id="ann-badge"></span></button>
      <span class="who" id="topbar-user" title="当前账号 / 角色">
        <i class="dot"></i><span class="nm"></span>
      </span>
      <button class="btn sm" id="btn-logout">退出登录</button>
    </div>
  </header>
  <div class="layout">
    <aside class="sidebar">
      <div class="nav-group">我的</div>
      <button class="nav-item active" data-page="overview">概览</button>
      <button class="nav-item" data-page="mykeys">API秘钥</button>
      <button class="nav-item" data-page="logs">使用日志</button>
      <button class="nav-item" data-page="profile">个人资料</button>
      <div class="nav-group">管理</div>
      <button class="nav-item" data-page="dashboard">总览</button>
      <button class="nav-item" data-page="board">数据看板</button>
      <button class="nav-item" data-page="keys">API Key</button>
      <button class="nav-item" data-page="accounts">上游账号</button>
      <button class="nav-item" data-page="aliases">模型别名</button>
      <button class="nav-item" data-page="groups">分组</button>
      <button class="nav-item" data-page="users">用户</button>
      <button class="nav-item" data-page="models">模型定价</button>
      <button class="nav-item" data-page="usage">请求日志</button>
      <button class="nav-item" data-page="audit">操作审计</button>
      <button class="nav-item" data-page="announce">公告管理</button>
      <button class="nav-item" data-page="roles">角色权限</button>
      <button class="nav-item" data-page="settings">设置</button>
    </aside>
    <main class="main" id="main"></main>
  </div>
</div>

<div id="toast"></div>
<div class="overlay hidden" id="overlay"><div class="modal" id="modal"></div></div>

<script>
'use strict';

// ======================= 基础设施 =======================
const api = async (path, opts = {}) => {
  const res = await fetch('/api/admin' + path, {
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    ...opts,
  });
  if (res.status === 401) { showLogin(); throw new Error('登录已过期'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data.error && data.error.message) || ('HTTP ' + res.status));
  return data;
};

const $ = (sel) => document.querySelector(sel);
// 密码长度下限。必须与后端 admin-api.ts::MIN_PASSWORD_LENGTH 一致 ——
// 前端拦一道只是为了少一次往返, 后端那道才是准的。
const MIN_PASSWORD_LEN = 8;
const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

function toast(msg, type = 'ok') {
  const el = document.createElement('div');
  el.className = 'toast ' + type;
  el.textContent = msg;
  $('#toast').appendChild(el);
  setTimeout(() => el.remove(), 3200);
}

// ---- 加载态 ----
// loadingHTML() 返回**字符串**, 所以既能用在内页(#main)也能用在弹窗 body 里。
function loadingHTML(msg) {
  return '<div class="loading"><div class="spinner"></div>' +
    '<div class="loading-txt">' + esc(msg || '加载中…') + '</div></div>';
}

// 顶部进度条。用一个计数器而不是布尔值: 同一时刻可能有两个请求在飞
// (例如页面里 Promise.all 两个接口), 先回来的那个不该把进度条收掉。
let PROGRESS_N = 0;
function startProgress() {
  PROGRESS_N += 1;
  const el = $('#progress');
  if (el) el.classList.add('on');
}
function stopProgress() {
  PROGRESS_N = Math.max(0, PROGRESS_N - 1);
  if (PROGRESS_N === 0) {
    const el = $('#progress');
    if (el) el.classList.remove('on');
  }
}
function resetProgress() {
  PROGRESS_N = 0;
  const el = $('#progress');
  if (el) el.classList.remove('on');
}

// 内容区被替换成「非加载态」时自动收起进度条 —— 这样页面函数不用各自记得收尾。
// 页面函数写 #main 之后, 这里发现里面已经没有 .loading 了, 就认为渲染完成。
(function watchMain() {
  const mainEl = $('#main');
  if (!mainEl || typeof MutationObserver === 'undefined') return;
  new MutationObserver(() => {
    if (!mainEl.querySelector('.loading')) resetProgress();
  }).observe(mainEl, { childList: true, subtree: true });
})();

const fmtMoney = (v) => '$' + Number(v || 0).toFixed(4);
const fmtMoney2 = (v) => '$' + Number(v || 0).toFixed(2);
// 整美元金额(签到奖励这种) —— 避免 $191.0000 这种尾巴;
// 小于 1 美元时退回两位小数, 免得显示成 $0。
const fmtUsd = (v) => {
  const n = Number(v || 0);
  return '$' + (Math.abs(n) >= 1 ? String(Math.round(n)) : n.toFixed(2));
};
const fmtNum = (v) => Number(v || 0).toLocaleString('en-US');

// 入口路径的保留字 —— 必须与后端 gateway.ts 的 ENTRY_SEGMENT_BLOCKLIST 一致。
// 这些是协议/内建路径; 被拿去当入口路径会让客户端那类请求整段失效。
const ENTRY_PATH_RESERVED = ['v1','v1beta','backend-api','antigravity','responses','chat','completions',
  'embeddings','models','images','videos','admin','api','health','healthz','favicon.ico'];

// ======================= 时间展示 (统一北京时间 UTC+8) =======================
// 库里存的都是 UTC, 两种写法:
//   - JS  toISOString()      -> "2026-09-20T14:30:00.000Z"  (带 Z, 无歧义)
//   - SQLite datetime('now') -> "2026-09-20 14:30:00"       (无时区后缀)
// 第二种直接 Date.parse / new Date() 会被浏览器按**本地时区**解释 —— 于是非东八区
// 的浏览器会再偏一次。这里显式补 Z 当作 UTC, 再用 Intl 转成 Asia/Shanghai 输出,
// 展示结果与浏览器所在时区无关, 恒为北京时间。
const BJ_ZONE = 'Asia/Shanghai';
const bjTimeFmt = new Intl.DateTimeFormat('en-GB', {
  timeZone: BJ_ZONE, hourCycle: 'h23',
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit',
});

/** 解析 DB 时间为毫秒时间戳; 无时区后缀的一律按 UTC; 解析不了返回 null */
function parseDbTime(s) {
  const str = String(s == null ? '' : s).trim();
  if (!str) return null;
  // "YYYY-MM-DD HH:MM[:SS[.sss]]" (无时区后缀) -> 补 T/Z 变成 ISO UTC
  const m = /^(\\d{4}-\\d{2}-\\d{2})[ T](\\d{1,2}:\\d{2}(?::\\d{2}(?:\\.\\d+)?)?)$/.exec(str);
  let iso = str;
  if (m) {
    const hms = m[2].length <= 5 ? m[2] + ':00' : m[2];
    iso = m[1] + 'T' + hms + 'Z';
  }
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
}

/** 格式化为北京时间 "YYYY-MM-DD HH:MM:SS" */
function fmtTime(s) {
  if (s === null || s === undefined || s === '') return '-';
  const t = parseDbTime(s);
  if (t === null) return String(s).replace('T', ' ').slice(0, 19); // 实在解析不了就原样兜底
  const p = {};
  for (const part of bjTimeFmt.formatToParts(t)) if (part.type !== 'literal') p[part.type] = part.value;
  return p.year + '-' + p.month + '-' + p.day + ' ' + p.hour + ':' + p.minute + ':' + p.second;
}

/** 北京时间 + 时区标注, 用于 title 悬浮提示 */
function fmtTimeBj(s) {
  const v = fmtTime(s);
  return v === '-' ? '-' : v + ' (UTC+8)';
}

// 复制到剪贴板。优先用 Clipboard API, 非 HTTPS / 老浏览器回退到 execCommand
async function copyText(text, okMsg = '已复制到剪贴板') {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      toast(okMsg);
      return true;
    }
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    toast(ok ? okMsg : '复制失败, 请手动选中复制', ok ? 'ok' : 'err');
    return ok;
  } catch (e) {
    toast('复制失败: ' + e.message, 'err');
    return false;
  }
}

function closeModal() { $('#overlay').classList.add('hidden'); $('#modal').className = 'modal'; $('#modal').innerHTML = ''; }
$('#overlay').addEventListener('click', (e) => { if (e.target.id === 'overlay') closeModal(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });

/**
 * 打开弹窗。
 * opts.wide = true 时用宽版皮(操作说明文档那种横向阅读的内容, 560px 会把代码折烂);
 * opts.sub        = 标题右侧的小字(版本/说明), 只有宽版会显示。
 * 注意 className 每次都要**重设**而不是追加 —— 否则开过一次宽版之后, 后面所有普通弹窗都会跟着变宽。
 */
function openModal(title, bodyHtml, footHtml, opts) {
  const o = opts || {};
  $('#modal').className = o.wide ? 'modal wide' : 'modal';
  $('#modal').innerHTML =
    '<div class="modal-head">' + esc(title) +
      (o.sub ? '<small>' + esc(o.sub) + '</small>' : '') + '</div>' +
    '<div class="modal-body">' + bodyHtml + '</div>' +
    '<div class="modal-foot">' + footHtml + '</div>';
  $('#overlay').classList.remove('hidden');
}

// ======================= 登录 / 注册 =======================
// 两个**独立视图**: #login-view 和 #register-view, 各自对应一个地址(/login 与 /register)。
// 不用 tab 切换是为了地址栏可收藏、可直接分享注册链接。
/**
 * 顶栏右上角「我是谁 · 什么角色」。
 * 传空/不传 = 清空(退出登录时用)。DOM 是 <span class="who"><i.dot><span.nm><span.rl>,
 * 所以不能直接往容器写 textContent —— 那样会把圆点和两个子 span 一起冲掉。
 */
function setTopbarUser(name, role) {
  const box = $('#topbar-user');
  if (!box) return;
  const nm = box.querySelector('.nm');
  const rl = box.querySelector('.rl');
  if (!name) {
    if (nm) nm.textContent = '';
    if (rl) rl.remove();
    box.style.display = 'none';
    return;
  }
  box.style.display = '';
  if (nm) nm.textContent = name;
  if (role) {
    if (rl) { rl.textContent = '· ' + role; }
    else {
      const s = document.createElement('span');
      s.className = 'rl';
      s.textContent = '· ' + role;
      box.appendChild(s);
    }
  } else if (rl) {
    rl.remove();
  }
}

/**
 * 藏掉启动引导视图(会话验证中那一屏)。
 * 🚨 三个 show*(login/register/app) 都必须调它 —— 漏掉任何一个就会出现
 *    "引导和登录页叠在一起"或"引导一直挡着后面"的怪象。
 */
function hideBoot() {
  const b = $('#boot-view');
  if (b) b.style.display = 'none';
}

function showLogin() {
  hideBoot();
  // 未登录 = 什么都看不到; null 表示"还没拿到菜单", 此时不隐藏任何菜单(先去登录)
  ALLOWED_MENUS = null;
  setTopbarUser('');
  // 地址栏也切到 /login —— 未登录时停在 /profile 这种地址上,
  // 刷新一次就会被服务端再重定向一次, 地址栏闪来闪去很困惑。
  if (location.pathname !== '/login') {
    try { history.replaceState({}, '', '/login'); } catch (e) { /* ignore */ }
  }
  // 恢复全部菜单显示, 免得下一个登录的人看到上一个角色的残留(过一会儿 applyMenus 会再收一次)
  document.querySelectorAll('.nav-item').forEach((el) => { el.style.display = ''; });
  document.querySelectorAll('.nav-group').forEach((el) => { el.style.display = ''; });
  resetProgress();
  $('#register-view').style.display = 'none';
  $('#app-view').style.display = 'none';
  $('#login-view').style.display = 'flex';
}

/** 切到注册视图。pushState 让 /register 成为可收藏/可分享的地址 */
function showRegister(push) {
  hideBoot();
  ALLOWED_MENUS = null;
  resetProgress();
  if (push !== false && location.pathname !== '/register') {
    try { history.pushState({}, '', '/register'); } catch (e) { /* ignore */ }
  }
  $('#login-view').style.display = 'none';
  $('#app-view').style.display = 'none';
  $('#register-view').style.display = 'flex';
  const el = $('#reg-email');
  if (el) el.focus();
}

function showApp() {
  hideBoot();
  $('#login-view').style.display = 'none';
  $('#register-view').style.display = 'none';
  // flex —— #app-view 是「顶栏 + 下方左右两栏」的纵向布局, 用 block 会塌掉高度
  $('#app-view').style.display = 'flex';
}

/** 登录页顶部的提示横幅(注册成功跳回来时用它说明"下一步做什么") */
function loginBanner(msg, type) {
  const el = $('#login-banner');
  if (!el) return;
  if (!msg) { el.style.display = 'none'; el.textContent = ''; return; }
  el.className = 'banner ' + (type || 'ok');
  el.textContent = msg;
  el.style.display = 'block';
}

// ======================= 菜单权限 =======================
// 菜单可见性由后端 /api/admin/me 下发的 menus 决定(角色 -> roles.menus)。
// ⚠️ 这里只是"看不看得见" —— 真正的边界在后端(admin-api.ts 的菜单闸门)。
// 把所有菜单藏起来并不阻止手敲 fetch, 所以两边都要有, 这里负责体验, 那里负责安全。
let ALLOWED_MENUS = null;

/**
 * 当前用户是不是**超级管理员**(后端 /me、/login 都会下发 is_admin)。
 *
 * 只有超管才显示「删除」这类破坏性操作。注意这只是"显不显示按钮" ——
 * 真正的闸门在后端(admin-api.ts 里删日志/审计都硬卡 auth.admin.is_admin),
 * 前端藏起来只是避免"点了才知道没权限"。登录前后各同步一次(见 doLogin / init)。
 */
let IS_ADMIN = false;

/** 当前角色能否访问某菜单页。menus 含 '*' 即全部 */
function canSee(page) {
  if (!ALLOWED_MENUS) return true;
  if (ALLOWED_MENUS.indexOf('*') >= 0) return true;
  return ALLOWED_MENUS.indexOf(page) >= 0;
}

function applyMenus(menus) {
  ALLOWED_MENUS = Array.isArray(menus) ? menus.slice() : [];
  document.querySelectorAll('.nav-item').forEach((el) => {
    el.style.display = canSee(el.dataset.page) ? '' : 'none';
  });
  // 整组都没权限时把分组标题(「我的」/「管理」)一起藏掉 ——
  // 否则业务用户会看到孤零零一个「管理」小标题、下面空无一物。
  document.querySelectorAll('.nav-group').forEach((g) => {
    let visible = false;
    let sib = g.nextElementSibling;
    while (sib && sib.classList.contains('nav-item')) {
      if (sib.style.display !== 'none') { visible = true; break; }
      sib = sib.nextElementSibling;
    }
    g.style.display = visible ? '' : 'none';
  });
}

/** 当前角色能看到的第一个菜单页 —— 没有指定页码时落到这里 */
function defaultPage() {
  const els = document.querySelectorAll('.nav-item');
  for (const el of els) {
    if (canSee(el.dataset.page) && PAGES[el.dataset.page]) return el.dataset.page;
  }
  return 'dashboard';
}

/** 无权访问时的兜底页 —— 明确告诉用户"不是坏了, 是没权限" */
function renderDenied(page) {
  $('#main').innerHTML =
    '<div class="page-head"><h2>无权访问</h2></div>' +
    '<div class="panel"><div class="panel-body">' +
      '<p>当前角色的菜单权限里没有「' + esc(PAGE_TITLES[page] || page) + '」。</p>' +
      '<p class="hint">需要开通请联系超级管理员, 在「角色权限」页勾选对应菜单后立即生效(无需重新登录)。</p>' +
    '</div></div>';
}

$('#btn-logout').addEventListener('click', async () => {
  try { await fetch('/api/admin/logout', { method: 'POST', credentials: 'same-origin' }); } catch (e) { /* ignore */ }
  showLogin();
});

$('#login-btn').addEventListener('click', doLogin);
$('#login-pass').addEventListener('keydown', (e) => { if (e.key === 'Enter') doLogin(); });
$('#login-user').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#login-pass').focus(); });

// ---- 登录 / 注册 互跳 ----
// 注册入口**可用性由服务端决定**: 管理员关掉注册后, 这里把链接藏掉(后端还会再拦一道 403)。
const registrationState = { enabled: true, auto_approve: true, loaded: false };
async function loadRegisterConfig() {
  try {
    const res = await fetch('/api/admin/register', { credentials: 'same-origin' });
    if (!res.ok) return;
    const d = await res.json();
    registrationState.enabled = d.enabled !== false;
    registrationState.auto_approve = d.auto_approve !== false;
    registrationState.loaded = true;
  } catch (e) { /* 拿不到就按"可用"显示, 真提交时后端还会再判 */ }
  const sw = $('#login-switch');
  if (sw) sw.style.display = registrationState.enabled ? '' : 'none';
}
$('#go-register').addEventListener('click', () => { loginBanner(''); showRegister(); });
$('#go-login').addEventListener('click', () => { showLogin(); });
$('#reg-pass2').addEventListener('keydown', (e) => { if (e.key === 'Enter') doRegister(); });

async function doRegister() {
  const btn = $('#reg-btn');
  const email = $('#reg-email').value.trim();
  const username = $('#reg-user').value.trim();
  const p1 = $('#reg-pass').value;
  const p2 = $('#reg-pass2').value;
  const err = $('#reg-err');
  err.textContent = '';

  if (!email) { err.textContent = '请填写邮箱'; return; }
  if (p1.length < MIN_PASSWORD_LEN) { err.textContent = '密码至少 ' + MIN_PASSWORD_LEN + ' 位'; return; }
  if (p1 !== p2) { err.textContent = '两次输入的密码不一致'; return; }

  btn.disabled = true; btn.textContent = '注册中…';
  startProgress();
  try {
    const res = await fetch('/api/admin/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, username, password: p1 }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error((data.error && data.error.message) || '注册失败');

    // 注册成功 -> 自动跳回登录页, 并把邮箱填进登录框(App 里"下一步必然是登录")
    const name = username || email;
    loginBanner(
      data.auto_approved === false
        ? '注册成功! 账号需要管理员审核后才能登录。'
        : '注册成功! 请用刚设置的密码登录。',
      'ok',
    );
    showLogin();
    $('#login-user').value = name;
    $('#login-pass').value = '';
    $('#login-pass').focus();
    toast('注册成功');
  } catch (e) {
    err.textContent = e.message;
  } finally {
    stopProgress();
    btn.disabled = false; btn.textContent = '注册';
  }
}

async function doLogin() {
  const btn = $('#login-btn');
  const username = $('#login-user').value.trim();
  const password = $('#login-pass').value;
  const err = $('#login-err');
  err.textContent = '';
  if (!username || !password) { err.textContent = '请输入用户名和密码'; return; }

  btn.disabled = true; btn.textContent = '登录中…';
  startProgress();
  try {
    const res = await fetch('/api/admin/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error((data.error && data.error.message) || '登录失败');
    // 菜单权限随登录响应一起回来, 立刻按角色收侧栏; 顶栏显示"我是谁 + 什么角色"
    applyMenus(data.menus);
    IS_ADMIN = !!data.is_admin;
    loginBanner('');
    showApp();
    setTopbarUser(data.username || '', data.role_name || data.role || '');
    // 被服务端从某个深链接踢到 /login?next=/profile 时, 登录后回到原来那一页
    const nextPath = new URLSearchParams(location.search).get('next') || '';
    navigate(pageFromPath(nextPath));
    toast('登录成功');
    // 有未读公告才弹 —— 放在 toast 之后, 两者不会互相盖住。
    // **不 await**: 公告拉取失败/慢不该拖住登录流程(它自己内部已吞异常)。
    maybeAnnounce();
  } catch (e) {
    err.textContent = e.message;
  } finally {
    stopProgress();
    btn.disabled = false; btn.textContent = '登录';
  }
}

// ======================= 导航 / 路由 =======================
// **仍然是单页应用**: 不切多页面、不整页刷新, 只是把当前页写进地址栏 ——
// 于是每个菜单都有自己的路径(/accounts、/groups ...), 刷新、收藏、
// 前进/后退都能回到同一页, 但页面本体从头到尾只有一份。
//
// 2026-09-21: **去掉了 /admin 前缀** —— 菜单直接挂域名根下(即 /<page>)。
const PAGES = {};
const ADMIN_BASE = '';
const PAGE_TITLES = {
  overview: '概览', dashboard: '总览', board: '数据看板', mykeys: 'API秘钥',
  keys: 'API Key', accounts: '上游账号',
  aliases: '模型别名', groups: '分组', users: '用户',
  models: '模型定价', logs: '使用日志', usage: '请求日志', audit: '操作审计',
  announce: '公告管理',
  roles: '角色权限', profile: '个人资料', settings: '设置',
};

// ---- 导航令牌: 防「快速连点菜单」串页 ----
// 每个页面函数都是 async: 先点 A 再点 B, 如果 A 的请求**后**返回, A 里那句
// $('#main').innerHTML = ... 就会盖在 B 已经渲染好的内容上 ——
// 表现为「地址栏/左侧高亮是 B, 内容是 A」(缓存/网络抖动时最容易复现)。
// 所以每次导航领一个自增令牌, 页面函数在 await 之后、写 #main 之前先自问
// 「我还是当前那一页吗」, 不是就直接放弃这次渲染, 让位给更新的一次导航。
// 注意: 本文件是模板字面量, 注释里也**不能出现反引号**(会提前闭合字符串)。
let NAV_SEQ = 0;
/** 取当前导航令牌。页面函数第一行调用 */
const navTok = () => NAV_SEQ;
/**
 * 本次渲染是否已被后一次导航取代。
 * 只该在 await 之后、写 #main 之前调用; 返回 true 就直接 return, 不要再动 DOM。
 */
const gone = (t) => t !== NAV_SEQ;

document.querySelectorAll('.nav-item').forEach((el) => {
  el.addEventListener('click', () => navigate(el.dataset.page));
});

/**
 * 从一个路径名解析页码: 认 /<page>(域名根下的第一段); 不认返回空串(交给 navigate 决定默认页)。
 * 注意: 本文件是模板字面量, 正则里的反斜杠要写成两个, 否则会被吃掉。
 * 只取第一段, 所以 /dashboard 与 /dashboard/xxx 都归到 dashboard;
 * /login /register /health 这些不是 PAGES 的键, 自然解析成空串。
 */
function pageFromPath(pathname) {
  const m = /^\\/([a-z0-9_-]+)/i.exec(pathname || '');
  return m && PAGES[m[1].toLowerCase()] ? m[1].toLowerCase() : '';
}

/** 从地址栏解析当前页: 认 /<page>, 兼容 #/<page>; 都不认返回空串 */
function pageFromLocation() {
  const p = pageFromPath(location.pathname);
  if (p) return p;
  const h = /^#\\/([a-z0-9_-]+)/i.exec(location.hash || '');
  if (h && PAGES[h[1].toLowerCase()]) return h[1].toLowerCase();
  return '';
}

function navigate(page, opts) {
  const o = opts || {};
  // 页码缺失/不认识 -> 落到本角色第一个可见菜单(业务用户就不会一进来撞上"无权访问")
  if (!page || !PAGES[page]) page = defaultPage();
  // 已知但不允许: 照常更新地址栏与高亮, 但内容换成「无权访问」——
  // 比静默跳回首页清楚得多(用户会以为自己的链接被篡改了)
  const allowed = canSee(page);
  // 切页时把弹窗一并关掉: 弹窗属于上一页的表单, 让它飘在新页面上同样是"页面混乱"
  closeModal();
  document.querySelectorAll('.nav-item').forEach((el) => {
    el.classList.toggle('active', el.dataset.page === page);
  });
  // silent: 前进/后退时地址栏已经是对的, 别再 push 一次(否则后退键会"走两步")
  const want = ADMIN_BASE + '/' + page;
  if (!o.silent && location.pathname !== want) {
    history.pushState({ page: page }, '', want);
  }
  // 顶栏**不再显示**当前菜单名 —— 各页 .page-head 已有大标题, 不再重复(用户明确要求)。
  // 领新令牌: 从这里往后的 DOM 写入才算数, 之前那次导航的异步回填会被 gone() 挡掉
  NAV_SEQ += 1;
  const myTok = NAV_SEQ;
  if (!allowed) { resetProgress(); renderDenied(page); return; }
  const fn = PAGES[page];
  if (fn) {
    startProgress();
    // fn() 仍然当场执行(令牌已经领好), 只是把它的 Promise 单独挂上错误处理 ——
    // 页面函数自己不捕获异常时在这里兜底: 否则会永远停在「加载中…」转圈,
    // 用户完全不知道发生了什么。显式给出错误 + 重试提示。
    Promise.resolve(fn())
      .catch((e) => {
        if (gone(myTok)) return;
        $('#main').innerHTML =
          '<div class="page-head"><h2>' + esc(PAGE_TITLES[page] || page) + '</h2></div>' +
          '<div class="panel"><div class="panel-body">' +
            '<p style="color:var(--danger)">加载失败: ' + esc(e && e.message ? e.message : String(e)) + '</p>' +
            '<p class="hint">多半是登录已过期或接口报错。点左侧菜单可重试。</p>' +
          '</div></div>';
      })
      .finally(() => { if (!gone(myTok)) resetProgress(); });
  }
}

// 浏览器前进/后退: /register 与 /login 也要跟着走, 否则退到 /register 却显示登录页
window.addEventListener('popstate', () => {
  if (location.pathname === '/register') { showRegister(false); return; }
  if (location.pathname === '/login') { showLogin(); return; }
  navigate(pageFromLocation(), { silent: true });
});

// ======================= 总览 =======================
PAGES.dashboard = async () => {
  const tok = navTok();
  $('#main').innerHTML = loadingHTML();
  const d = await api('/dashboard');
  if (gone(tok)) return;
  const c = d.counts, t = d.today;

  const modelRows = d.models.length
    ? d.models.map((m) => '<tr><td class="mono">' + esc(m.model) + '</td><td>' + fmtNum(m.requests) +
        '</td><td>' + fmtNum(m.input_tokens) + '</td><td>' + fmtNum(m.output_tokens) +
        '</td><td>' + fmtMoney(m.cost) + '</td></tr>').join('')
    : '<tr><td colspan="5" class="empty">暂无数据</td></tr>';

  const platRows = d.accounts_by_platform.length
    ? d.accounts_by_platform.map((p) => '<tr><td>' + esc(p.platform) + '</td><td>' + p.available +
        ' / ' + p.total + '</td></tr>').join('')
    : '<tr><td colspan="2" class="empty">暂无账号</td></tr>';

  $('#main').innerHTML =
    '<div class="page-head"><h2>总览</h2><div class="actions">' +
      '<button class="btn" id="btn-refresh">刷新</button></div></div>' +

    '<div class="cards">' +
      card('用户数', fmtNum(c.users)) +
      card('API Key', fmtNum(c.api_keys_active) + ' <small>/ ' + fmtNum(c.api_keys) + ' 启用</small>') +
      card('上游账号', fmtNum(c.accounts_active) + ' <small>/ ' + fmtNum(c.accounts) + ' 可用</small>') +
      card('分组', fmtNum(c.groups)) +
      card('用户总余额', fmtMoney2(c.total_balance)) +
      card('近 24h 请求', fmtNum(t.requests) + ' <small>流式 ' + fmtNum(t.stream_requests) + '</small>') +
      card('近 24h Token', fmtNum(t.input_tokens + t.output_tokens)) +
      card('近 24h 花费', fmtMoney(t.cost)) +
    '</div>' +

    '<div class="panel"><div class="panel-title">近 7 天模型用量 Top 15</div>' +
      '<table><thead><tr><th>模型</th><th>请求</th><th>输入 Token</th><th>输出 Token</th><th>花费</th></tr></thead>' +
      '<tbody>' + modelRows + '</tbody></table></div>' +

    '<div class="panel"><div class="panel-title">各平台账号可用情况</div>' +
      '<table><thead><tr><th>平台</th><th>可用 / 总数</th></tr></thead><tbody>' + platRows + '</tbody></table></div>';

  $('#btn-refresh').addEventListener('click', () => PAGES.dashboard());
};

const card = (k, v) => '<div class="card"><div class="k">' + esc(k) + '</div><div class="v">' + v + '</div></div>';

// ======================= API Key =======================
PAGES.keys = async () => {
  const tok = navTok();
  $('#main').innerHTML = loadingHTML();
  const [d, g] = await Promise.all([api('/api-keys'), api('/groups')]);
  if (gone(tok)) return;

  const rows = d.api_keys.length ? d.api_keys.map((k) => {
    const st = k.status === 'active' ? '<span class="tag ok">启用</span>'
      : k.status === 'quota_exhausted' ? '<span class="tag warn">额度耗尽</span>'
      : k.status === 'expired' ? '<span class="tag warn">已过期</span>'
      : '<span class="tag off">' + esc(k.status) + '</span>';
    const quota = k.quota > 0 ? fmtMoney(k.quota_used) + ' / ' + fmtMoney(k.quota) : '不限';
    return '<tr>' +
      '<td class="mono">' + esc(k.key_masked) +
        ' <button class="btn sm" data-copy-key="' + k.id + '" title="复制完整 Key">复制</button></td>' +
      '<td>' + esc(k.name || '-') + '</td>' +
      '<td>' + esc(k.user_email || k.user_id) + '</td>' +
      '<td>' + esc(k.group_name || '-') + '</td>' +
      '<td>' + st + '</td>' +
      '<td>' + quota + '</td>' +
      '<td class="muted">' + fmtTime(k.last_used_at) + '</td>' +
      '<td><button class="btn sm" data-edit-key="' + k.id + '">编辑</button> ' +
          '<button class="btn sm danger" data-del-key="' + k.id + '">删除</button></td>' +
    '</tr>';
  }).join('') : '<tr><td colspan="8" class="empty">还没有 API Key, 点右上角新建</td></tr>';

  $('#main').innerHTML =
    '<div class="page-head"><h2>API Key 管理</h2><div class="actions">' +
      '<button class="btn primary" id="btn-new-key">新建 Key</button></div></div>' +
    '<div class="panel"><table><thead><tr>' +
      '<th>Key</th><th>名称</th><th>所属用户</th><th>分组</th><th>状态</th><th>额度(已用/上限)</th><th>最近使用 (UTC+8)</th><th>操作</th>' +
    '</tr></thead><tbody>' + rows + '</tbody></table></div>';

  $('#btn-new-key').addEventListener('click', () => keyForm(null, d, g));
  document.querySelectorAll('[data-edit-key]').forEach((el) => {
    el.addEventListener('click', () => {
      const k = d.api_keys.find((x) => x.id === Number(el.dataset.editKey));
      keyForm(k, d, g);
    });
  });
  document.querySelectorAll('[data-del-key]').forEach((el) => {
    el.addEventListener('click', () => delKey(Number(el.dataset.delKey)));
  });
  document.querySelectorAll('[data-copy-key]').forEach((el) => {
    el.addEventListener('click', () => {
      const k = d.api_keys.find((x) => x.id === Number(el.dataset.copyKey));
      if (k && k.key) copyText(k.key, 'Key 已复制');
    });
  });
};

function keyForm(k, d, g) {
  const isEdit = !!k;
  const users = d.users || [];
  const userOpts = users.length
    ? users.map((u) =>
        '<option value="' + u.id + '"' + (isEdit && u.id === k.user_id ? ' selected' : '') + '>' +
        esc(u.email || u.username || ('用户 #' + u.id)) + ' (#' + u.id + ')</option>').join('')
    : '<option value="">(暂无用户, 请先到「用户」页新建)</option>';
  const groupOpts = '<option value="">(不指定)</option>' + g.groups.map((gr) =>
    '<option value="' + gr.id + '"' + (isEdit && gr.id === k.group_id ? ' selected' : '') + '>' +
    esc(gr.name) + '</option>').join('');

  openModal(isEdit ? '编辑 API Key' : '新建 API Key',
    '<div class="form-row"><label>所属用户</label><select id="f-user"' +
      (users.length ? '' : ' disabled') + '>' + userOpts + '</select></div>' +
    '<div class="form-row"><label>名称</label><input id="f-name" value="' + esc(isEdit ? k.name : '') + '" placeholder="例如: 我的测试 Key"></div>' +
    (isEdit ? '' : '<div class="form-row"><label>自定义 Key(留空则自动生成)</label><input id="f-key" class="mono" placeholder="留空自动生成 sk-xxxx"></div>') +
    '<div class="form-row"><label>分组</label><select id="f-group">' + groupOpts + '</select></div>' +
    '<div class="form-row"><label>额度上限 (USD, 0 表示不限)</label><input id="f-quota" type="number" step="0.01" value="' + (isEdit ? k.quota : 0) + '"></div>' +
    '<div class="grid2">' +
      '<div class="form-row"><label>5h 限额 (USD)</label><input id="f-r5" type="number" step="0.01" value="' + (isEdit ? k.rate_limit_5h : 0) + '"></div>' +
      '<div class="form-row"><label>1d 限额 (USD)</label><input id="f-r1" type="number" step="0.01" value="' + (isEdit ? k.rate_limit_1d : 0) + '"></div>' +
    '</div>' +
    '<div class="form-row"><label>7d 限额 (USD)</label><input id="f-r7" type="number" step="0.01" value="' + (isEdit ? k.rate_limit_7d : 0) + '"></div>' +
    '<div class="form-row"><label>过期时间(留空=永不过期)</label><input id="f-exp" type="datetime-local" value="' + (isEdit && k.expires_at ? String(k.expires_at).slice(0, 16) : '') + '"></div>' +
    '<div class="form-row"><label>状态</label><select id="f-status">' +
      ['active', 'disabled'].map((s) => '<option value="' + s + '"' + (isEdit && k.status === s ? ' selected' : '') + '>' + s + '</option>').join('') +
    '</select></div>',
    '<button class="btn" id="m-cancel">取消</button><button class="btn primary" id="m-save">保存</button>');

  $('#m-cancel').addEventListener('click', closeModal);
  $('#m-save').addEventListener('click', async () => {
    const payload = {
      user_id: Number($('#f-user').value),
      name: $('#f-name').value.trim(),
      group_id: $('#f-group').value ? Number($('#f-group').value) : null,
      quota: Number($('#f-quota').value || 0),
      rate_limit_5h: Number($('#f-r5').value || 0),
      rate_limit_1d: Number($('#f-r1').value || 0),
      rate_limit_7d: Number($('#f-r7').value || 0),
      expires_at: $('#f-exp').value || null,
      status: $('#f-status').value,
    };
    if (!isEdit) payload.key = $('#f-key').value.trim();

    try {
      const res = await api(isEdit ? '/api-keys/' + k.id : '/api-keys', {
        method: isEdit ? 'PUT' : 'POST',
        body: JSON.stringify(payload),
      });
      closeModal();
      if (!isEdit && res.key) {
        // 明文 key 只显示这一次
        openModal('API Key 已创建',
          '<p style="margin-bottom:12px">请立即复制保存, 关闭后无法再次查看完整 Key:</p>' +
          '<div class="key-box"><code id="new-key-val">' + esc(res.key) + '</code>' +
          '<button class="btn primary sm" id="btn-copy-key">复制</button></div>' +
          '<p class="muted" style="font-size:12px">点击「复制」或直接选中上面的 Key 手动复制。</p>',
          '<button class="btn primary" id="m-done">我已复制</button>');
        $('#btn-copy-key').addEventListener('click', async () => {
          const ok = await copyText(res.key);
          if (ok) {
            const b = $('#btn-copy-key');
            b.textContent = '✓ 已复制';
            setTimeout(() => { if ($('#btn-copy-key')) $('#btn-copy-key').textContent = '复制'; }, 1800);
          }
        });
        $('#m-done').addEventListener('click', () => { closeModal(); PAGES.keys(); });
      } else {
        toast('保存成功');
        PAGES.keys();
      }
    } catch (e) { toast(e.message, 'err'); }
  });
}

function delKey(id) {
  openModal('确认删除',
    '<p>确定要删除这个 API Key 吗?删除后使用该 Key 的请求会立即失败。</p>',
    '<button class="btn" id="m-cancel">取消</button><button class="btn danger" id="m-del">确认删除</button>');
  $('#m-cancel').addEventListener('click', closeModal);
  $('#m-del').addEventListener('click', async () => {
    try {
      await api('/api-keys/' + id, { method: 'DELETE' });
      closeModal(); toast('已删除'); PAGES.keys();
    } catch (e) { toast(e.message, 'err'); }
  });
}

// ======================= 上游账号 =======================
PAGES.accounts = async () => {
  const tok = navTok();
  $('#main').innerHTML = loadingHTML();
  const [d, g] = await Promise.all([api('/accounts'), api('/groups')]);
  if (gone(tok)) return;

  // 缓存已知平台(内置 + 已在用的自定义), 供分组表单的 datalist 复用
  const used = d.accounts.map((a) => a.platform);
  PAGES._platformCache = Array.from(new Set([...(d.platforms || []), ...used]));

  const rows = d.accounts.length ? d.accounts.map((a) => {
    const st = a.status === 'active' ? '<span class="tag ok">启用</span>' : '<span class="tag off">' + esc(a.status) + '</span>';
    const sched = a.schedulable ? '<span class="tag ok">可调度</span>' : '<span class="tag warn">已停用</span>';
    // 三态: ok=通 / reachable=可达但无法据此判定凭证(上游未实现 GET /v1/models) / failed=不通
    let test = '<span class="muted">未测试</span>';
    if (a.last_test_status === 'ok') test = '<span class="tag ok" title="' + esc(a.last_test_message) + '">通</span>';
    else if (a.last_test_status === 'reachable') test = '<span class="tag warn" title="' + esc(a.last_test_message) + '">待验证</span>';
    else if (a.last_test_status === 'failed') test = '<span class="tag err" title="' + esc(a.last_test_message) + '">不通</span>';
    return '<tr>' +
      '<td>' + esc(a.name) + '</td>' +
      '<td><span class="tag off">' + esc(a.platform) + '</span>' +
        (a.is_custom_platform ? ' <span class="tag warn" title="自定义第三方平台">自定义</span>' : '') + '</td>' +
      // 入口路径: 客户端拿它拼 URL 就能直接打到这条上游, 点一下复制完整地址
      '<td class="mono">' + (a.entry_path
        ? '<button class="btn sm" data-copy-entry="' + esc(a.entry_path) + '" ' +
          'title="点击复制: ' + esc(location.origin + '/' + a.entry_path + '/v1/chat/completions') + '">/' + esc(a.entry_path) + '</button>'
        : '<span class="muted">-</span>') + '</td>' +
      '<td class="mono muted">' + esc(a.protocol || '-') + '</td>' +
      '<td class="mono muted">' + esc(a.credential_preview || '-') + '</td>' +
      '<td>' + a.priority + '</td>' +
      '<td>' + a.concurrency + '</td>' +
      '<td>' + st + ' ' + sched + '</td>' +
      '<td>' + test + '</td>' +
      '<td><button class="btn sm" data-test="' + a.id + '">测试</button> ' +
          '<button class="btn sm" data-edit-acct="' + a.id + '">编辑</button> ' +
          '<button class="btn sm danger" data-del-acct="' + a.id + '">删除</button></td>' +
    '</tr>';
  }).join('') : '<tr><td colspan="10" class="empty">还没有上游账号, 点右上角新建</td></tr>';

  $('#main').innerHTML =
    '<div class="page-head"><h2>上游账号管理</h2><div class="actions">' +
      '<button class="btn" id="btn-clear-sticky" title="账号改了配置但请求还走旧账号? 点这里立即失效(粘性会话默认缓存1小时)">清空粘性会话</button>' +
      '<button class="btn primary" id="btn-new-acct">添加上游账号</button></div></div>' +
    '<div class="panel"><table><thead><tr>' +
      '<th>名称</th><th>平台</th><th>入口路径</th><th>协议</th><th>凭证</th><th>优先级</th><th>并发</th><th>状态</th><th>连通性</th><th>操作</th>' +
    '</tr></thead><tbody>' + rows + '</tbody></table></div>';

  $('#btn-clear-sticky').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true; btn.textContent = '清理中…';
    try {
      const r = await api('/sticky/clear', { method: 'POST' });
      toast('已清空 ' + r.accounts + ' 个账号上的 ' + r.cleared + ' 条粘性会话');
    } catch (err) {
      toast(err.message, 'err');
    } finally {
      btn.disabled = false; btn.textContent = '清空粘性会话';
    }
  });

  $('#btn-new-acct').addEventListener('click', () => acctForm(null, d, g));
  document.querySelectorAll('[data-edit-acct]').forEach((el) => {
    el.addEventListener('click', () => {
      const a = d.accounts.find((x) => x.id === Number(el.dataset.editAcct));
      acctForm(a, d, g);
    });
  });
  document.querySelectorAll('[data-del-acct]').forEach((el) => {
    el.addEventListener('click', () => delAcct(Number(el.dataset.delAcct)));
  });
  document.querySelectorAll('[data-copy-entry]').forEach((el) => {
    el.addEventListener('click', () => {
      copyText(location.origin + '/' + el.dataset.copyEntry + '/v1/chat/completions', '已复制入口地址');
    });
  });
  document.querySelectorAll('[data-test]').forEach((el) => {
    el.addEventListener('click', async () => {
      const id = Number(el.dataset.test);
      el.disabled = true; el.textContent = '测试中…';
      try {
        const r = await api('/accounts/' + id + '/test', { method: 'POST' });
        // 三态提示: verdict=ok 通 / reachable 可达但无法判定凭证 / failed 不通
        const v = r.verdict || (r.ok ? 'ok' : 'failed');
        toast(r.message, v === 'ok' ? 'ok' : v === 'reachable' ? 'warn' : 'err');
        PAGES.accounts();
      } catch (e) {
        toast(e.message, 'err');
        el.disabled = false; el.textContent = '测试';
      }
    });
  });
};

function acctForm(a, d, g) {
  const isEdit = !!a;
  const builtins = d.platforms || [];
  const protocols = d.protocols || ['openai', 'anthropic', 'gemini'];
  const PROTO_HINT = {
    openai: 'OpenAI 兼容 · Authorization: Bearer · /v1/chat/completions',
    anthropic: 'Anthropic 原生 · x-api-key · /v1/messages',
    gemini: 'Google AI Studio · x-goog-api-key · /v1beta/models/xxx:generateContent',
  };

  const curPlatform = isEdit ? a.platform : (builtins[0] || 'openai');
  const curProtocol = isEdit
    ? (a.protocol || 'openai')
    : 'openai';

  // 「平台」是一个**可输入的组合框**(<input list> + <datalist>):
  // 既可以从下拉里点选, 也能直接敲一个全新的第三方平台名。
  // 之前是「下拉 + 选『＋ 自定义』才出现文本框」两步式, 第三方中转/自建网关的
  // 平台名五花八门(oneapi / newapi / 自家域名), 逼用户先选"自定义"再在另一个
  // 框里重打一遍, 很容易漏; 而且"当前平台"必须出现在候选项里, 否则一个自定义
  // 平台的账号在编辑框里选不到自己的值, 保存时旧值被原样写回,
  // 表现为"改了没用 / 平台总是自己变回去"。
  const platList = Array.from(new Set(
    [...builtins, ...(d.accounts || []).map((x) => x.platform), curPlatform]
      .map((p) => String(p || '').trim())
      .filter(Boolean),
  ));
  const platDl = platList.map((p) => '<option value="' + esc(p) + '"></option>').join('');

  const protoOpts = protocols.map((p) =>
    '<option value="' + p + '"' + (curProtocol === p ? ' selected' : '') + '>' + p + '</option>').join('');

  const groupChecks = g.groups.map((gr) =>
    '<label style="display:inline-flex;align-items:center;gap:5px;margin-right:14px;font-weight:400">' +
    '<input type="checkbox" class="f-grp" value="' + gr.id + '" style="width:auto"' +
    (isEdit && a.group_ids.includes(gr.id) ? ' checked' : '') + '> ' + esc(gr.name) + '</label>').join('');

  const defaultHint = d.protocol_base_url_hints || {};

  openModal(isEdit ? '编辑上游账号' : '添加上游账号',
    '<div class="form-row"><label>名称</label><input id="a-name" value="' + esc(isEdit ? a.name : '') + '" placeholder="例如: openai-主账号"></div>' +
    '<div class="grid2">' +
      '<div class="form-row"><label>平台 <span class="muted">(可下拉选, 也可直接输入)</span></label>' +
        '<input id="a-platform" class="mono" list="acct-platform-list" autocomplete="off" ' +
          'value="' + esc(curPlatform) + '" placeholder="选一个内置平台, 或直接输入第三方平台名">' +
        '<datalist id="acct-platform-list">' + platDl + '</datalist>' +
        '<div class="hint" id="plat-hint" style="margin-top:6px;color:var(--muted);font-size:12px"></div></div>' +
      '<div class="form-row"><label>认证方式</label><select id="a-type">' +
        ['apikey', 'oauth', 'setup-token'].map((t) => '<option value="' + t + '"' + (isEdit && a.type === t ? ' selected' : '') + '>' + t + '</option>').join('') +
      '</select></div>' +
    '</div>' +
    '<div class="form-row"><label>通信协议 <span class="muted">—— 决定请求路径与认证头</span></label>' +
      '<select id="a-protocol">' + protoOpts + '</select>' +
      '<div class="hint" id="proto-hint" style="margin-top:6px;color:var(--muted);font-size:12px"></div></div>' +
    '<div class="form-row"><label>API Key / 凭证' + (isEdit ? '(留空表示不修改)' : '') + '</label>' +
      '<input id="a-key" class="mono" placeholder="' + (isEdit ? esc(a.credential_preview || '留空不修改') : 'sk-...') + '"></div>' +
    '<div class="form-row"><label>Base URL <span id="base-req" class="muted"></span></label>' +
      '<input id="a-base" class="mono" value="' + esc(isEdit && a.base_url ? a.base_url : '') + '" placeholder="' + esc(defaultHint[curProtocol] || 'https://...') + '">' +
      '<div class="hint" id="base-hint" style="margin-top:6px;color:var(--muted);font-size:12px"></div>' +
      '<div class="muted" style="font-size:12px;margin-top:4px">' +
        '填第三方中转的地址时, <b>只写到版本根</b>(不要带 /v1/chat/completions)。' +
        '例: <code>https://你的中转.com/v1</code> 或 <code>https://你的中转.com/openai</code>。' +
        '留空才会用官方默认域名。' +
      '</div></div>' +
    '<div class="form-row"><label>入口路径 <span class="muted">(选填 —— 用请求 URL 直接指定这条上游)</span></label>' +
      '<input id="a-entry" class="mono" autocomplete="off" value="' + esc(isEdit && a.entry_path ? a.entry_path : '') + '" placeholder="例如: sensenova">' +
      '<div class="muted" style="font-size:12px;margin-top:4px">' +
        '填了之后, 客户端请求 <code>' + esc(location.origin) + '/&lt;入口路径&gt;/v1/chat/completions</code> ' +
        '就会<b>直接打到这条上游</b> —— 不再看模型名判平台, 走的一定是本条的 Base URL, ' +
        '本条的模型别名也照样生效。<br>' +
        '例: 填 <code>sensenova</code> → 请求 <code>' + esc(location.origin) + '/sensenova/v1/chat/completions</code>。<br>' +
        '模型名对不对由这条上游自己判定 —— 它不认就是名字有问题, 网关原样透传它的报错。' +
        '小写字母/数字/下划线/连字符, 不能是 <code>v1</code> / <code>models</code> 这类保留路径。<br>' +
        '留空 = 仍按模型名(账号模型索引 / 分组重定向)自动判定。' +
      '</div></div>' +
    // 模型别名输入框已移除(2026-09-21): 账号级别名统一到「模型别名」菜单页管理。
    // 这里**不能**再往 payload 里塞 model_aliases —— 后端的语义是"字段出现即整表替换",
    // 一旦提交(哪怕是 null)就会把该账号已有的别名全清掉, 表现为"编辑一次账号, 别名全没了"。
    '<div class="form-row"><label>模型别名</label>' +
      '<div class="muted" style="font-size:12px">' +
        '本账号的别名请在 <b>「模型别名」</b> 页统一管理(那里能按账号增删改, 还能看到对端模型名)。' +
        '此处不再编辑, 以免"保存账号"时误清已有别名。' +
      '</div></div>' +
    '<div class="grid2">' +
      '<div class="form-row"><label>优先级(越小越优先)</label><input id="a-prio" type="number" value="' + (isEdit ? a.priority : 10) + '"></div>' +
      '<div class="form-row"><label>并发上限</label><input id="a-conc" type="number" value="' + (isEdit ? a.concurrency : 3) + '"></div>' +
    '</div>' +
    '<div class="grid2">' +
      '<div class="form-row"><label>计费倍率</label><input id="a-rate" type="number" step="0.01" value="' + (isEdit ? a.rate_multiplier : 1) + '"></div>' +
      '<div class="form-row"><label>状态</label><select id="a-status">' +
        ['active', 'disabled', 'error'].map((s) => '<option value="' + s + '"' + (isEdit && a.status === s ? ' selected' : '') + '>' + s + '</option>').join('') +
      '</select></div>' +
    '</div>' +
    '<div class="form-row"><label>可调度</label><select id="a-sched">' +
      '<option value="1"' + (isEdit && a.schedulable ? ' selected' : '') + '>是</option>' +
      '<option value="0"' + (isEdit && !a.schedulable ? ' selected' : '') + '>否</option></select></div>' +
    '<div class="form-row"><label>绑定分组</label><div>' + (groupChecks || '<span class="muted">还没有分组</span>') + '</div></div>' +
    '<div class="form-row"><label>备注</label><input id="a-notes" value="' + esc(isEdit ? a.notes : '') + '"></div>',
    '<button class="btn" id="m-cancel">取消</button><button class="btn primary" id="m-save">保存</button>');

  /** 按"是否内置平台 + 协议"刷新提示与必填状态 */
  function syncPlatformFields(autoProto) {
    // 平台名统一按小写归一(与后端 normalizePlatformName 一致), 免得填了
    // "My-Relay" 保存后变成 "my-relay", 用户以为平台名被改了。
    // 注意: 本文件是模板字面量里的前端脚本, 注释里**不能出现反引号** —— 会把宿主字面量提前闭合。
    const sel = String($('#a-platform').value || '').trim().toLowerCase();
    const custom = !!sel && !builtins.includes(sel);

    // 内置平台时, 自动带出该平台的默认协议(用户仍可手动改)
    if (autoProto && !custom) {
      const guess = (d.protocol_defaults || {})[sel];
      if (guess) $('#a-protocol').value = guess;
    }

    const proto = $('#a-protocol').value;
    $('#proto-hint').textContent = PROTO_HINT[proto] || '';

    const baseVal = $('#a-base').value.trim();
    $('#base-req').textContent = custom ? '(自定义平台必填)' : '(留空用官方默认域名)';
    $('#base-hint').textContent = baseVal
      ? ''
      : (custom
          ? '自定义平台没有内置默认域名, 不填会导致请求失败。'
          : ('留空将使用默认域名: ' + (defaultHint[proto] || '-')));
    $('#a-base').placeholder = defaultHint[proto] || 'https://...';

    $('#plat-hint').textContent = custom
      ? '自定义平台 "' + sel + '": 保存时会按小写存, 且必须填 Base URL。'
      : '';
  }

  $('#a-platform').addEventListener('input', () => syncPlatformFields(true));
  $('#a-platform').addEventListener('change', () => syncPlatformFields(true));
  $('#a-protocol').addEventListener('change', () => syncPlatformFields(false));
  $('#a-base').addEventListener('input', () => syncPlatformFields(false));
  syncPlatformFields(false);

  $('#m-cancel').addEventListener('click', closeModal);
  $('#m-save').addEventListener('click', async () => {
    const groupIds = Array.from(document.querySelectorAll('.f-grp:checked')).map((c) => Number(c.value));

    // 平台直接取输入框内容(既可下拉点选, 也可手打第三方平台名), 统一转小写
    const platform = String($('#a-platform').value || '').trim().toLowerCase();
    const baseUrl = $('#a-base').value.trim();
    const entryPath = String($('#a-entry').value || '').trim().toLowerCase();

    if (!platform) { toast('请填写平台', 'err'); return; }
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(platform)) {
      toast('平台只能用小写字母/数字/下划线/连字符, 且以字母或数字开头', 'err');
      return;
    }
    if (!builtins.includes(platform) && !baseUrl) {
      toast('自定义平台必须填写 Base URL', 'err');
      return;
    }
    if (baseUrl && !/^https?:\\/\\//i.test(baseUrl)) {
      toast('Base URL 必须以 http:// 或 https:// 开头', 'err');
      return;
    }
    // 入口路径: 与后端 ENTRY_PATH_RE / ENTRY_SEGMENT_BLOCKLIST 保持一致
    if (entryPath) {
      if (!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(entryPath)) {
        toast('入口路径只能用小写字母/数字/下划线/连字符, 以字母或数字开头, 最长 32 字符', 'err');
        return;
      }
      if (ENTRY_PATH_RESERVED.indexOf(entryPath) >= 0) {
        toast('入口路径不能是保留路径: ' + entryPath, 'err');
        return;
      }
    }

    // 模型别名不从这里提交 —— 见表单里的说明。账号别名请走「模型别名」页
    // (那边会 PUT {model_aliases: 整表}), 避免这里提交空值把别名整表清掉。
    const payload = {
      name: $('#a-name').value.trim(),
      platform: platform,
      protocol: $('#a-protocol').value,
      type: $('#a-type').value,
      base_url: baseUrl || null,
      priority: Number($('#a-prio').value || 10),
      concurrency: Number($('#a-conc').value || 3),
      rate_multiplier: Number($('#a-rate').value || 1),
      status: $('#a-status').value,
      schedulable: $('#a-sched').value === '1',
      notes: $('#a-notes').value.trim(),
      entry_path: entryPath || null,
      group_ids: groupIds,
    };
    const key = $('#a-key').value.trim();
    if (key) payload.api_key = key;

    try {
      await api(isEdit ? '/accounts/' + a.id : '/accounts', {
        method: isEdit ? 'PUT' : 'POST',
        body: JSON.stringify(payload),
      });
      closeModal(); toast('保存成功'); PAGES.accounts();
      // 改了 key/状态/平台后在旧粘性会话失效前, 老会话仍会走这个账号
      if (isEdit && (payload.api_key || payload.status || payload.platform || payload.protocol || payload.base_url)) {
        setTimeout(askClearSticky, 400);
      }
    } catch (e) { toast(e.message, 'err'); }
  });
}

/** 改完账号配置后提示清理粘性会话 */
function askClearSticky() {
  openModal('需要清空粘性会话吗?',
    '<p>该账号的键值或状态已变更。<strong>粘性会话会缓存 1 小时</strong>, 在此期间这些会话的请求仍会被路由到修改前的账号。</p>' +
    '<p class="muted">测试时可点「清空」立即生效; 生产环境想平稳过渡可忽略本提示。</p>',
    '<button class="btn" id="s-skip">稍后</button><button class="btn primary" id="s-clear">清空并立即生效</button>');
  $('#s-skip').addEventListener('click', closeModal);
  $('#s-clear').addEventListener('click', async () => {
    try {
      const r = await api('/sticky/clear', { method: 'POST' });
      closeModal();
      toast('已清空 ' + r.cleared + ' 条粘性会话');
    } catch (e) { toast(e.message, 'err'); }
  });
}

function delAcct(id) {
  openModal('确认删除',
    '<p>确定要删除这个上游账号吗?如果它是某个分组唯一的账号, 该分组的请求会失败。</p>',
    '<button class="btn" id="m-cancel">取消</button><button class="btn danger" id="m-del">确认删除</button>');
  $('#m-cancel').addEventListener('click', closeModal);
  $('#m-del').addEventListener('click', async () => {
    try {
      await api('/accounts/' + id, { method: 'DELETE' });
      closeModal(); toast('已删除'); PAGES.accounts();
    } catch (e) { toast(e.message, 'err'); }
  });
}

// ======================= 分组 =======================
PAGES.groups = async () => {
  const tok = navTok();
  $('#main').innerHTML = loadingHTML();
  const d = await api('/groups');
  if (gone(tok)) return;

  // 分组表单的「一键填充」要知道"哪些平台真的有账号", 否则指过去还是 503。
  // 顺手把模型列表也缓存一份(来自定价表), 用于生成候选模型名。
  // 还要一份「模型名 -> 平台」索引: 网关的自动路由正是靠它判断"该模型归哪个平台"。
  try {
    const [acct, mp] = await Promise.all([api('/accounts'), api('/models')]);
    PAGES._acctPlatforms = Array.from(new Set(
      (acct.accounts || [])
        .filter((a) => a.status === 'active' && a.schedulable)
        .map((a) => a.platform),
    ));
    PAGES._modelCache = (mp.models || []).map((m) => m.model).filter(Boolean);
    // 账号自带 model_index (后台「模型获取」写入) + 别名表的键, 合并成小写索引
    const idx = {};
    for (const a of (acct.accounts || [])) {
      if (a.status !== 'active' || !a.schedulable) continue;
      let list = a.model_index;
      if (typeof list === 'string') { try { list = JSON.parse(list); } catch (e) { list = []; } }
      if (Array.isArray(list)) {
        for (const m of list) { const k = String(m || '').toLowerCase(); if (k) idx[k] = a.platform; }
      }
      const al = a.model_aliases;
      if (al && typeof al === 'object') {
        for (const k of Object.keys(al)) { const kk = String(k || '').toLowerCase(); if (kk) idx[kk] = a.platform; }
      }
    }
    PAGES._platModelIndex = idx;
  } catch (e) {
    PAGES._acctPlatforms = [];
    PAGES._modelCache = [];
    PAGES._platModelIndex = {};
  }
  if (gone(tok)) return;

  const rows = d.groups.length ? d.groups.map((g) => {
    const st = g.status === 'active' ? '<span class="tag ok">启用</span>' : '<span class="tag off">' + esc(g.status) + '</span>';
    // 「上游账号数」只数**存活**的上游账号(与调度器一致)。失效绑定(指向已删除账号的关联行)
    // 单独提示 —— 它们既不能被调度, 又会把原始关联行计数撑大, 必须能一眼看出来。
    const acctCell = g.account_count +
      (g.account_count_active !== g.account_count
        ? ' <span class="tag warn" title="其中 ' + g.account_count_active + ' 个当前可调度">可用 ' + g.account_count_active + '</span>' : '') +
      (g.account_count_stale > 0
        ? ' <span class="tag err" title="这些绑定指向已删除的账号, 点「上游账号」清理">+' + g.account_count_stale + ' 失效</span>' : '');
    return '<tr>' +
      '<td>' + esc(g.name) + '</td>' +
      '<td class="muted">' + esc(g.description || '-') + '</td>' +
      '<td>' + esc(g.platform || '混合') + '</td>' +
      '<td>×' + g.rate_multiplier + '</td>' +
      '<td>' + acctCell + '</td>' +
      '<td>' + g.key_count + '</td>' +
      '<td>' + st + '</td>' +
      '<td><button class="btn sm" data-bind-grp="' + g.id + '" title="管理该分组绑定的上游账号">上游账号</button> ' +
          '<button class="btn sm" data-edit-grp="' + g.id + '">编辑</button> ' +
          '<button class="btn sm danger" data-del-grp="' + g.id + '">删除</button></td>' +
    '</tr>';
  }).join('') : '<tr><td colspan="8" class="empty">还没有分组</td></tr>';

  $('#main').innerHTML =
    '<div class="page-head"><h2>分组管理</h2><div class="actions">' +
      '<button class="btn primary" id="btn-new-grp">新建分组</button></div></div>' +
    '<div class="panel"><table><thead><tr>' +
      '<th>名称</th><th>描述</th><th>平台</th><th>倍率</th><th>上游账号数</th><th>Key 数</th><th>状态</th><th>操作</th>' +
    '</tr></thead><tbody>' + rows + '</tbody></table></div>';

  $('#btn-new-grp').addEventListener('click', () => groupForm(null, d));
  document.querySelectorAll('[data-bind-grp]').forEach((el) => {
    el.addEventListener('click', () => {
      const g = d.groups.find((x) => x.id === Number(el.dataset.bindGrp));
      groupAccountsForm(g);
    });
  });
  document.querySelectorAll('[data-edit-grp]').forEach((el) => {
    el.addEventListener('click', () => {
      const g = d.groups.find((x) => x.id === Number(el.dataset.editGrp));
      groupForm(g, d);
    });
  });
  document.querySelectorAll('[data-del-grp]').forEach((el) => {
    el.addEventListener('click', () => delGroup(Number(el.dataset.delGrp)));
  });
};

function groupForm(g, d) {
  const isEdit = !!g;
  // 分组平台: 支持内置平台 + 任意自定义平台(逗号分隔多个表示混合分组)
  const knownPlatforms = (PAGES._platformCache || []);

  openModal(isEdit ? '编辑分组' : '新建分组',
    '<div class="form-row"><label>名称</label><input id="g-name" value="' + esc(isEdit ? g.name : '') + '" placeholder="例如: default"></div>' +
    '<div class="form-row"><label>描述</label><input id="g-desc" value="' + esc(isEdit ? g.description : '') + '"></div>' +
    '<div class="form-row"><label>平台 <span class="muted">(留空=混合; 多个用逗号分隔; 支持自定义平台名)</span></label>' +
      '<input id="g-platform" class="mono" list="platform-list" value="' + esc(isEdit ? (g.platform || '') : '') + '" placeholder="留空=混合">' +
      '<datalist id="platform-list">' +
        knownPlatforms.map((p) => '<option value="' + esc(p) + '"></option>').join('') +
      '</datalist></div>' +
    '<div class="grid2">' +
      '<div class="form-row"><label>计费倍率</label><input id="g-rate" type="number" step="0.01" value="' + (isEdit ? g.rate_multiplier : 1) + '"></div>' +
      '<div class="form-row"><label>RPM 限制(0=不限)</label><input id="g-rpm" type="number" value="' + (isEdit ? g.rpm_limit : 0) + '"></div>' +
    '</div>' +
    // 模型白名单已移除(2026-09-21): 配了上游就能用, 模型名对不对由上游自己判定。
    // 之前每次接新上游/新模型都要回头补名单, 漏补就是 403 not allowed for this group。
    '<div class="form-row"><label>默认映射模型(留空=不改写)</label>' +
      '<input id="g-map" class="mono" value="' + esc(isEdit && g.default_mapped_model ? g.default_mapped_model : '') + '" placeholder="把所有请求的 model 改写成这个"></div>' +
    '<div class="form-row"><label>模型 → 平台 重定向 <span class="muted">(JSON; 指定某模型去哪个平台选号)</span></label>' +
      '<textarea id="g-plat-route" class="mono" rows="3" placeholder="" spellcheck="false">' +
        esc(isEdit && g.model_platform_routing ? JSON.stringify(g.model_platform_routing, null, 0) : '') +
      '</textarea>' +
      '<div class="muted" style="font-size:12px;margin-top:4px">' +
        '当同一个模型名需要精确派发到某个平台时用。例: <code>deepseek-v4-pro</code> 只有 sensenova 提供, ' +
        '而 <code>Deepseek-v4-flash</code> 只有 chatapi 提供 —— 两者模型名都含 deepseek, ' +
        '光靠名字区分不了, 就在这里指定。<br>' +
        '两种写法: <code>{"模型名":"平台名"}</code> 只派发; ' +
        '<code>{"模型名":{"platform":"平台名","model":"对端要求的模型名"}}</code> 还能顺带改写模型名 ' +
        '(不同上游对大小写要求相反时很有用, 如 sensenova 只认全小写)。<br>' +
        '<b>留空 = 自动路由</b>: 网关会看哪个账号的「模型获取」结果里列出了这个模型名, ' +
        '自动把请求发到那个账号的平台 —— 新模型无需在这里配置即可归到中转。<br>' +
        '只有当某个模型名被多个平台同时提供、需要强制指定时才需要填这里。' +
      '</div>' +
      '<div style="margin-top:6px"><button class="btn sm" id="g-plat-route-fill">按当前账号平台一键填充</button>' +
        '<span class="muted" style="font-size:12px;margin-left:8px">' +
        '把当前模型清单里还没有账号归口的模型, 全部指到一个已有账号的平台(兜底用)。</span></div>' +
      '</div>' +
    '<div class="form-row"><label>状态</label><select id="g-status">' +
      ['active', 'disabled'].map((s) => '<option value="' + s + '"' + (isEdit && g.status === s ? ' selected' : '') + '>' + s + '</option>').join('') +
    '</select></div>',
    '<button class="btn" id="m-cancel">取消</button><button class="btn primary" id="m-save">保存</button>');

  $('#m-cancel').addEventListener('click', closeModal);

  // 「按当前账号平台一键填充」: 把在当前账号平台里选不中的模型指到一个已有账号的平台。
  // 用法: 页面加载时会拉一次账号列表缓存到 PAGES._acctPlatforms。
  const btnFill = $('#g-plat-route-fill');
  if (btnFill) {
    btnFill.addEventListener('click', () => {
      const acctPlats = PAGES._acctPlatforms || [];
      if (acctPlats.length === 0) { toast('没有已启用的上游账号, 先在上游账号页添加', 'err'); return; }
      // 默认建议平台: 优先取非内置平台里账号最多的一个(通常是自定义中转),
      // 其次用内置里有账号的第一个。
      const pick = acctPlats[0];
      const NL = String.fromCharCode(10);
      const input = prompt(
        '把这些模型指到哪个平台?' + NL + NL +
        '可用平台: ' + acctPlats.join(', ') + NL + NL +
        '(填平台名后, 下方会自动生成 JSON)',
        pick,
      );
      if (!input) return;
      const target = input.trim();
      if (!acctPlats.includes(target)) {
        toast('平台 "' + target + '" 下没有已启用账号, 指过去仍会 503', 'err');
        return;
      }
      // 把当前模型清单里"自动路由兜不住"的模型全部指到 target 平台。
      // 2026-09 起不再按名字推断平台; 只要模型不在 target 平台账号的
      // 「模型获取」索引里, 就算兜不住, 需要显式指过去或去跑一次模型获取。
      const models = (PAGES._modelCache || []).filter((m) => {
        return !(PAGES._platModelIndex || {})[String(m).toLowerCase()];
      });
      if (models.length === 0) { toast('当前没有需要兜底的模型', 'err'); return; }
      const el = $('#g-plat-route');
      let cur = {};
      try { cur = el.value.trim() ? JSON.parse(el.value) : {}; } catch (e) { cur = {}; }
      for (const m of models) cur[m] = target;
      el.value = JSON.stringify(cur, null, 2);
      toast('已把 ' + models.length + ' 个模型指向 ' + target + ', 请复核后保存');
    });
  }

  $('#m-save').addEventListener('click', async () => {
    const routeRaw = $('#g-plat-route').value.trim();
    let platRoute = null;
    if (routeRaw) {
      try {
        const parsed = JSON.parse(routeRaw);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          toast('模型→平台 重定向必须是 JSON 对象', 'err');
          return;
        }
        for (const k of Object.keys(parsed)) {
          const v = parsed[k];
          if (typeof v === 'string') {
            if (!v.trim()) { toast('模型→平台 重定向的平台名不能为空', 'err'); return; }
          } else if (v && typeof v === 'object' && !Array.isArray(v)) {
            if (!String(v.platform || '').trim()) {
              toast('条目 ' + k + ' 缺少 platform 字段', 'err');
              return;
            }
          } else {
            toast('条目 ' + k + ' 的值必须是平台名字符串, 或 {platform, model} 对象', 'err');
            return;
          }
        }
        platRoute = parsed;
      } catch (e) {
        toast('模型→平台 重定向不是合法 JSON: ' + e.message, 'err');
        return;
      }
    }
    const payload = {
      name: $('#g-name').value.trim(),
      description: $('#g-desc').value.trim(),
      platform: $('#g-platform').value,
      rate_multiplier: Number($('#g-rate').value || 1),
      rpm_limit: Number($('#g-rpm').value || 0),
      // 不再提交 model_allowlist: 白名单已停用, 提交反而会把库里的旧值清掉
      default_mapped_model: $('#g-map').value.trim() || null,
      model_platform_routing: platRoute,
      status: $('#g-status').value,
    };
    try {
      await api(isEdit ? '/groups/' + g.id : '/groups', {
        method: isEdit ? 'PUT' : 'POST',
        body: JSON.stringify(payload),
      });
      closeModal(); toast('保存成功'); PAGES.groups();
    } catch (e) { toast(e.message, 'err'); }
  });
}

/**
 * 分组 ↔ 上游账号 绑定管理弹窗。
 *
 * 账号是软删除, account_groups 的关联行不会跟着走, 所以「上游账号数」很容易虚高。
 * 这里把**存活账号**(带勾选框)和**失效绑定**分开列出来: 保存时会按勾选结果
 * 整体重建该分组的绑定, 失效绑定顺带被清掉。
 */
async function groupAccountsForm(g) {
  openModal('管理分组的上游账号 · ' + g.name, loadingHTML(),
    '<button class="btn" id="m-cancel">取消</button><button class="btn primary" id="m-save">保存绑定</button>');
  // 先挂上取消 —— 加载期间也要能关掉弹窗
  $('#m-cancel').addEventListener('click', closeModal);

  let d;
  try {
    d = await api('/groups/' + g.id + '/accounts');
  } catch (e) {
    const bodyEl = document.querySelector('.modal-body');
    if (bodyEl) bodyEl.innerHTML = '<div class="empty">加载失败: ' + esc(e.message) + '</div>';
    return;
  }

  const accts = d.accounts || [];
  const stale = d.stale || [];
  const bodyEl = document.querySelector('.modal-body');
  if (!bodyEl) return;

  const items = accts.length
    ? accts.map((a) => {
        const okSched = a.status === 'active' && a.schedulable;
        return '<label style="display:flex;align-items:center;gap:8px;padding:6px 4px;border-bottom:1px solid var(--border);font-weight:400">' +
          '<input type="checkbox" class="g-acct" value="' + a.id + '" style="width:auto"' + (a.bound ? ' checked' : '') + '>' +
          '<span style="min-width:140px">' + esc(a.name) + '</span>' +
          '<span class="tag off">' + esc(a.platform) + '</span>' +
          (okSched
            ? ''
            : ' <span class="tag warn" title="账号已停用或不可调度, 绑定了也不会被选中">不可调度</span>') +
          '</label>';
      }).join('')
    : '<div class="muted">还没有上游账号, 先到「上游账号」页添加。</div>';

  const staleHtml = stale.length
    ? '<div style="font-size:12px;margin-top:10px;color:var(--danger)">' +
      '另有 ' + stale.length + ' 条失效绑定(账号已删除): ' +
      esc(stale.map((s) => (s.name || ('#' + s.account_id))).join('、')) +
      ' —— 点「保存绑定」即会清理。</div>'
    : '';

  bodyEl.innerHTML =
    '<div class="muted" style="font-size:12px;margin-bottom:8px">' +
      '勾选要纳入本分组的上游账号。只有绑定了分组的账号才会被该分组的请求选中。' +
    '</div>' +
    (accts.length ? '<div>' + items + '</div>' : items) +
    staleHtml;

  $('#m-save').addEventListener('click', async () => {
    const ids = Array.from(document.querySelectorAll('.g-acct'))
      .filter((el) => el.checked)
      .map((el) => Number(el.value));
    try {
      const r = await api('/groups/' + g.id + '/accounts', {
        method: 'PUT',
        body: JSON.stringify({ account_ids: ids }),
      });
      closeModal();
      toast('已保存: 绑定 ' + r.bound + ' 个账号' + (r.removed ? ', 清理 ' + r.removed + ' 条' : ''));
      PAGES.groups();
    } catch (e) { toast(e.message, 'err'); }
  });
}

function delGroup(id) {
  openModal('确认删除',
    '<p>确定要删除这个分组吗?使用该分组的 API Key 会失去上游账号。</p>',
    '<button class="btn" id="m-cancel">取消</button><button class="btn danger" id="m-del">确认删除</button>');
  $('#m-cancel').addEventListener('click', closeModal);
  $('#m-del').addEventListener('click', async () => {
    try {
      await api('/groups/' + id, { method: 'DELETE' });
      closeModal(); toast('已删除'); PAGES.groups();
    } catch (e) { toast(e.message, 'err'); }
  });
}

// ======================= 用户 =======================
PAGES.users = async () => {
  const tok = navTok();
  $('#main').innerHTML = loadingHTML();
  const d = await api('/users');
  if (gone(tok)) return;

  // 没有密码的用户数(历史数据)。>0 时右上角出现「补齐默认密码」按钮
  const noPwd = (d.users || []).filter((u) => !u.has_password).length;

    const rows = d.users.length ? d.users.map((u) => {
      const st = u.status === 'active' ? '<span class="tag ok">正常</span>' : '<span class="tag off">' + esc(u.status) + '</span>';
      // 角色名优先用 roles 表里的显示名(自定义角色也能显示人话), 取不到就退回 code
      const roleName = (PAGES._roleNames && PAGES._roleNames[u.role]) || u.role;
      const role = u.role === 'admin'
        ? '<span class="tag warn" title="' + esc(u.role) + '">' + esc(roleName) + '</span>'
        : '<span class="tag off" title="' + esc(u.role) + '">' + esc(roleName) + '</span>';
      // 密码只判断"有没有" —— 哈希不回传(见 serializeUser)。新建的用户会自动带上默认密码,
      // 这里出现「未设置」的基本都是历史数据, 点右上角「补齐默认密码」一键处理。
      const pw = u.has_password
        ? '<span class="tag ok" title="已设置密码(哈希存储)">已设置</span>'
        : '<span class="tag err" title="该用户没有密码, 点右上角「补齐默认密码」">未设置</span>';

      // 平台白名单: 空 = 不限制(网关按 users.platform_access 判, 只在①②③级都落空时兜底)
      const plats = String(u.platform_access || '').split(',').map((s) => s.trim()).filter(Boolean);
      const access = plats.length
        ? plats.map((p) => '<span class="tag off">' + esc(p) + '</span>').join(' ')
        : '<span class="muted">不限</span>';
      return '<tr>' +
        '<td>' + u.id + '</td>' +
        '<td>' + esc(u.email) + '</td>' +
        '<td>' + esc(u.username || '-') + '</td>' +
        '<td>' + role + '</td>' +
        '<td>' + pw + '</td>' +
        '<td>' + fmtMoney(u.balance) + '</td>' +
        '<td>' + u.concurrency + '</td>' +
        '<td><button class="btn sm" data-user-keys="' + u.id + '" title="查看该用户下的 API Key">' + u.key_count + '</button></td>' +
        '<td>' + access + '</td>' +
        '<td class="muted" title="' + esc(fmtTimeBj(u.created_at)) + '">' + fmtTime(u.created_at) + '</td>' +
        '<td class="muted">' + fmtTime(u.last_login_at) + '</td>' +
        '<td>' + st + '</td>' +
        '<td><button class="btn sm" data-edit-user="' + u.id + '">编辑</button> ' +
            '<button class="btn sm" data-toggle-user="' + u.id + '">' + (u.status === 'active' ? '停用' : '启用') + '</button> ' +
            '<button class="btn sm danger" data-del-user="' + u.id + '">删除</button></td>' +
      '</tr>';
    }).join('') : '<tr><td colspan="13" class="empty">还没有用户, 点右上角新建</td></tr>';

  PAGES._defaultPwd = d.default_password || '';
  PAGES._roles = d.roles || [];
  PAGES._roleNames = {};
  PAGES._roles.forEach((r) => { PAGES._roleNames[r.code] = r.name; });

  $('#main').innerHTML =
    '<div class="page-head"><h2>用户管理</h2><div class="actions">' +
      (noPwd
        ? '<button class="btn warn" id="btn-fix-pwd" title="给这些用户写入默认密码的哈希, 明文不落库">补齐默认密码 (' + noPwd + ')</button>'
        : '') +
      '<button class="btn primary" id="btn-new-user">新建用户</button></div></div>' +
    '<div class="panel"><table><thead><tr>' +
      '<th>ID</th><th>邮箱</th><th>用户名</th><th>角色</th><th>密码</th><th>余额</th><th>并发</th><th>Key</th>' +
      '<th>平台白名单</th><th>创建时间 (UTC+8)</th><th>最近登录 (UTC+8)</th><th>状态</th><th>操作</th>' +
    '</tr></thead><tbody>' + rows + '</tbody></table></div>' +
    (noPwd
      ? '<p class="hint">有 ' + noPwd + ' 个用户还没有密码(历史数据)。点「补齐默认密码」会写入默认密码 ' +
        '<code>' + esc(PAGES._defaultPwd || '') + '</code> 的 PBKDF2 哈希 —— 数据库里存的只有哈希, 明文不落库。</p>'
      : '') +
    '<p class="hint">新建用户默认使用密码 <code>' + esc(PAGES._defaultPwd || '') + '</code>, ' +
      '弹窗里可以改成别的; 编辑时留空表示不修改。</p>';

  $('#btn-new-user').addEventListener('click', () => userForm(null, d));
  if (noPwd) {
    $('#btn-fix-pwd').addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      btn.disabled = true; btn.textContent = '处理中…';
      try {
        const r = await api('/users/reset-missing-passwords', { method: 'POST' });
        toast('已为 ' + (r.updated || 0) + ' 个用户设置默认密码');
        PAGES.users();
      } catch (err) {
        toast(err.message, 'err');
        btn.disabled = false; btn.textContent = '补齐默认密码 (' + noPwd + ')';
      }
    });
  }
  document.querySelectorAll('[data-edit-user]').forEach((el) => {
    el.addEventListener('click', () => {
      const u = d.users.find((x) => x.id === Number(el.dataset.editUser));
      userForm(u, d);
    });
  });
  document.querySelectorAll('[data-toggle-user]').forEach((el) => {
    el.addEventListener('click', async () => {
      const u = d.users.find((x) => x.id === Number(el.dataset.toggleUser));
      if (!u) return;
      const next = u.status === 'active' ? 'disabled' : 'active';
      try {
        await api('/users/' + u.id, { method: 'PUT', body: JSON.stringify({ status: next }) });
        toast(next === 'active' ? '已启用' : '已停用');
        PAGES.users();
      } catch (e) { toast(e.message, 'err'); }
    });
  });
  document.querySelectorAll('[data-user-keys]').forEach((el) => {
    el.addEventListener('click', () => {
      const u = d.users.find((x) => x.id === Number(el.dataset.userKeys));
      if (u) userKeysModal(u);
    });
  });
  document.querySelectorAll('[data-del-user]').forEach((el) => {
    el.addEventListener('click', () => delUser(Number(el.dataset.delUser)));
  });
};

/** 查看某个用户名下的 API Key, 并提供「新建 Key」快捷入口 */
async function userKeysModal(u) {
  openModal('用户 API Key · ' + (u.email || ('#' + u.id)), loadingHTML(),
    '<button class="btn" id="m-cancel">关闭</button><button class="btn primary" id="m-new-key">为该用户新建 Key</button>');
  $('#m-cancel').addEventListener('click', closeModal);

  let ks = [];
  try {
    const r = await api('/api-keys?user_id=' + u.id);
    ks = r.api_keys || [];
  } catch (e) {
    const el = document.querySelector('.modal-body');
    if (el) el.innerHTML = '<div class="empty">加载失败: ' + esc(e.message) + '</div>';
    return;
  }

  const bodyEl = document.querySelector('.modal-body');
  if (!bodyEl) return;
  bodyEl.innerHTML = ks.length
    ? '<table><thead><tr><th>Key</th><th>名称</th><th>分组</th><th>状态</th><th>最近使用</th></tr></thead><tbody>' +
      ks.map((k) =>
        '<tr><td class="mono">' + esc(k.key_masked) + '</td>' +
        '<td>' + esc(k.name || '-') + '</td>' +
        '<td>' + esc(k.group_name || '-') + '</td>' +
        '<td>' + esc(k.status) + '</td>' +
        '<td class="muted">' + fmtTime(k.last_used_at) + '</td></tr>').join('') +
      '</tbody></table>'
    : '<div class="muted">该用户还没有 API Key。</div>';

  $('#m-new-key').addEventListener('click', () => {
    closeModal();
    navigate('keys');
    toast('已切到 API Key 页, 新建时选「' + (u.email || ('#' + u.id)) + '」');
  });
}

function userForm(u, d) {
  const isEdit = !!u;
  // 默认密码来自后端(GET /users 的 default_password), 前端不硬编码 ——
  // 两处各写一份, 改了后端忘了前端就会出现"提示的密码登录不上"
  const defaultPwd = PAGES._defaultPwd || '';
  // 角色候选来自 roles 表(随 GET /users 一起下发)。不再写死 user/admin ——
  // 自定义角色新建后必须立刻能在这里选到, 否则那个角色等于白建。
  const roles = (PAGES._roles && PAGES._roles.length) ? PAGES._roles : [{ code: 'user', name: 'user' }];
  const curRole = isEdit ? String(u.role || 'user') : 'user';
  // 当前值不在候选里(角色被删/数据杂)时补一项, 否则下拉会显示成第一项, 一保存就把角色改了
  const roleOpts = roles.slice();
  if (!roleOpts.some((r) => r.code === curRole)) roleOpts.unshift({ code: curRole, name: curRole + ' (已失效)' });

  openModal(isEdit ? '编辑用户' : '新建用户',
    '<div class="form-row"><label>邮箱</label><input id="u-email" value="' + esc(isEdit ? u.email : '') + '" placeholder="user@example.com"></div>' +
    '<div class="form-row"><label>用户名</label><input id="u-name" value="' + esc(isEdit ? u.username : '') + '">' +
      '<div class="hint">用户名与邮箱都能用来登录控制台(大小写不敏感)。</div></div>' +
    '<div class="grid2">' +
      '<div class="form-row"><label>角色</label><select id="u-role">' +
        roleOpts.map((r) => '<option value="' + esc(r.code) + '"' + (r.code === curRole ? ' selected' : '') + '>' + esc(r.name) + ' (' + esc(r.code) + ')</option>').join('') +
      '</select>' +
      '<div class="hint">决定这个账号登录后能看到哪些菜单。菜单明细在「角色权限」页配置。</div></div>' +
      '<div class="form-row"><label>状态</label><select id="u-status">' +
        ['active', 'disabled'].map((s) => '<option value="' + s + '"' + (isEdit && u.status === s ? ' selected' : '') + '>' + s + '</option>').join('') +
      '</select>' +
      '<div class="hint">disabled = 不能登录, 而且已有的登录会话会立刻失效。</div></div>' +
    '</div>' +
    // 密码: 新建留空 = 默认密码; 编辑留空 = 不修改(不是清空)
    '<div class="form-row"><label>密码 <span class="muted">(' +
      (isEdit ? '留空 = 不修改' : '留空 = 用默认密码') + ')</span></label>' +
      '<div class="row-flex">' +
        '<input id="u-pwd" type="password" autocomplete="new-password" style="flex:1" ' +
          'placeholder="' + (isEdit ? '不想改就留空' : (defaultPwd ? '默认 ' + esc(defaultPwd) : '留空用默认密码')) + '">' +
        '<button class="btn sm" id="u-pwd-default" title="把默认密码填进输入框">用默认密码</button>' +
      '</div>' +
      '<div class="hint">' +
        (defaultPwd ? '默认密码 <code>' + esc(defaultPwd) + '</code>, ' : '') +
        '最少 ' + MIN_PASSWORD_LEN + ' 位。密码以 PBKDF2 加盐哈希存储, 明文不入库、也不回显; ' +
        '编辑时留空表示不改。' +
      '</div>' +
    '</div>' +
    '<div class="grid2">' +
      '<div class="form-row"><label>余额 (USD)</label><input id="u-bal" type="number" step="0.01" value="' + (isEdit ? u.balance : 0) + '"></div>' +
      '<div class="form-row"><label>并发上限</label><input id="u-conc" type="number" value="' + (isEdit ? u.concurrency : 5) + '"></div>' +
    '</div>' +
    '<div class="form-row"><label>RPM 限制 <span class="muted">(0 = 不限)</span></label>' +
      '<input id="u-rpm" type="number" value="' + (isEdit ? (u.rpm_limit || 0) : 0) + '"></div>' +
    '<div class="form-row"><label>平台白名单 <span class="muted">(逗号分隔; 留空 = 不限制)</span></label>' +
      '<input id="u-access" class="mono" value="' + esc(isEdit ? (u.platform_access || '') : '') + '" placeholder="例如: openai,sensenova">' +
      '<div class="muted" style="font-size:12px;margin-top:4px">' +
        '限制该用户的请求只能落到这些平台。它只在「入口路径 / 分组重定向 / 分组平台」都没命中时才生效, ' +
        '而且**不能**用来绕过它们 —— 想固定走某条上游, 请用账号的「入口路径」。' +
      '</div></div>' +
    '<div class="form-row"><label>备注</label><input id="u-notes" value="' + esc(isEdit ? u.notes : '') + '"></div>',
    '<button class="btn" id="m-cancel">取消</button><button class="btn primary" id="m-save">保存</button>');

  $('#m-cancel').addEventListener('click', closeModal);
  // 一键填默认密码: 只是填进输入框, 仍然要按「保存」才生效 —— 不搞"看不见的魔法"
  $('#u-pwd-default').addEventListener('click', () => {
    if (!defaultPwd) { toast('后端未返回默认密码, 请到「设置」查看', 'err'); return; }
    const el = $('#u-pwd');
    el.value = defaultPwd;
    el.focus();
  });
  $('#m-save').addEventListener('click', async () => {
    const pwd = $('#u-pwd').value;
    // 编辑时留空 = 不改密码; 新建时留空 = 用默认密码。两种情况都不该在这里报错
    if (pwd && pwd.length < MIN_PASSWORD_LEN) {
      toast('密码至少 ' + MIN_PASSWORD_LEN + ' 位', 'err');
      return;
    }
    const payload = {
      email: $('#u-email').value.trim(),
      username: $('#u-name').value.trim(),
      role: $('#u-role').value,
      status: $('#u-status').value,
      balance: Number($('#u-bal').value || 0),
      concurrency: Number($('#u-conc').value || 5),
      rpm_limit: Number($('#u-rpm').value || 0),
      platform_access: $('#u-access').value.trim(),
      notes: $('#u-notes').value.trim(),
      password: pwd,
    };
    try {
      const r = await api(isEdit ? '/users/' + u.id : '/users', {
        method: isEdit ? 'PUT' : 'POST',
        body: JSON.stringify(payload),
      });
      closeModal();
      // 新建时告诉管理员"这个用户现在用什么密码", 否则还得自己猜是默认的还是填的
      if (!isEdit && r && r.used_default_password) {
        toast('已创建, 密码为默认密码 ' + (defaultPwd || ''), 'warn');
      } else if (pwd) {
        toast('保存成功, 密码已更新');
      } else {
        toast('保存成功');
      }
      PAGES.users();
    } catch (e) { toast(e.message, 'err'); }
  });
}

function delUser(id) {
  openModal('确认删除',
    '<p>确定要删除这个用户吗?其名下的 API Key 也会一并失效。</p>',
    '<button class="btn" id="m-cancel">取消</button><button class="btn danger" id="m-del">确认删除</button>');
  $('#m-cancel').addEventListener('click', closeModal);
  $('#m-del').addEventListener('click', async () => {
    try {
      await api('/users/' + id, { method: 'DELETE' });
      closeModal(); toast('已删除'); PAGES.users();
    } catch (e) { toast(e.message, 'err'); }
  });
}

// ======================= 角色权限 =======================
/**
 * 角色 -> 菜单的配置页。
 *
 * 这一页是"权限"的唯一入口, 但要记住它只是**配置**:
 *   - 后端 admin-api.ts 的 MENUS_BY_RESOURCE 才是边界(每个接口都贴着菜单键);
 *   - 前端这里只决定侧栏显示什么。
 * 改完立刻生效 —— 因为身份与菜单是每次请求现查的(admin-auth.ts::requireAdmin),
 * 不藏在 token 里, 所以不需要让用户重新登录。
 */
PAGES.roles = async () => {
  const tok = navTok();
  $('#main').innerHTML = loadingHTML();
  const d = await api('/roles');
  if (gone(tok)) return;
  rolesRender(d);
};

/** 重新拉当前身份并刷新侧栏 —— 改完角色权限后必须调用, 否则侧栏和实际权限会不一致 */
async function refreshMe() {
  try {
    const res = await fetch('/api/admin/me', { credentials: 'same-origin' });
    if (!res.ok) return;
    const me = await res.json();
    applyMenus(me.menus);
    IS_ADMIN = !!me.is_admin;
    setTopbarUser(me.username || '', me.role_name || me.role || '');
  } catch (e) { /* 刷新失败不影响已保存的动作 */ }
}

function rolesRender(d) {
  const catalog = d.menu_catalog || [];
  const labelOf = {};
  catalog.forEach((m) => { labelOf[m.key] = m.label; });

  const rows = (d.roles || []).map((r) => {
    const all = r.menus.indexOf('*') >= 0;
    const chips = all
      ? '<span class="tag warn">全部菜单 (*)</span>'
      : (r.menus.length
          ? r.menus.map((k) => '<span class="tag off">' + esc(labelOf[k] || k) + '</span>').join(' ')
          : '<span class="tag err">未配置(登录后什么都看不到)</span>');
    const lockMenus = r.code === 'admin';
    return '<tr>' +
      '<td class="mono">' + esc(r.code) + '</td>' +
      '<td>' + esc(r.name) + (r.builtin ? ' <span class="tag off">内置</span>' : '') + '</td>' +
      '<td>' + chips + '</td>' +
      '<td>' + r.user_count + '</td>' +
      '<td class="muted">' + esc(r.description || '-') + '</td>' +
      '<td><button class="btn sm" data-edit-role="' + r.id + '"' +
          (lockMenus ? ' disabled title="超级管理员的权限不可修改"' : '') + '>编辑</button> ' +
        '<button class="btn sm danger" data-del-role="' + r.id + '"' +
          (r.builtin ? ' disabled title="内置角色不可删除"' : '') + '>删除</button></td>' +
    '</tr>';
  }).join('');

  $('#main').innerHTML =
    '<div class="page-head"><h2>角色权限</h2><div class="actions">' +
      '<button class="btn primary" id="btn-new-role">新建角色</button></div></div>' +
    '<div class="panel"><table><thead><tr>' +
      '<th>角色代码</th><th>显示名</th><th>可见菜单</th><th>用户数</th><th>说明</th><th>操作</th>' +
    '</tr></thead><tbody>' + (rows || '<tr><td colspan="6" class="empty">还没有角色</td></tr>') +
    '</tbody></table></div>' +
    '<p class="hint">「可见菜单」既决定账号登录后侧栏显示哪些页面, <strong>也</strong>是后端接口的权限边界 —— ' +
      '菜单藏起来只是看不见, 直接调接口同样会被 403 拦住。修改后立即生效, 用户不需要重新登录。</p>' +
    '<p class="hint">业务用户给「概览 / API秘钥 / 使用日志 / 个人资料」这几个菜单就够了: 它们只能看到自己的额度、Key 与调用记录, ' +
      '看不到别的用户。数据看板与总览是运营视角的聚合数据, 默认只给管理员。</p>';

  $('#btn-new-role').addEventListener('click', () => roleForm(null, d));
  document.querySelectorAll('[data-edit-role]').forEach((el) => {
    if (el.disabled) return;
    el.addEventListener('click', () => {
      const r = (d.roles || []).find((x) => x.id === Number(el.dataset.editRole));
      if (r) roleForm(r, d);
    });
  });
  document.querySelectorAll('[data-del-role]').forEach((el) => {
    if (el.disabled) return;
    el.addEventListener('click', () => delRole(Number(el.dataset.delRole)));
  });
}

function roleForm(r, d) {
  const isEdit = !!r;
  const catalog = d.menu_catalog || [];
  const cur = isEdit ? (r.menus || []) : ['mykeys'];
  const all = cur.indexOf('*') >= 0;

  // 每个菜单一个可点击的小卡片: 比一列裸 checkbox 更好点也更好看 ——
  // 11 个菜单排两列, 每一项都有独立边框, 选中/hover 都有颜色反馈。
  const perms = catalog.map((m) =>
    '<label class="perm" data-k="' + esc(m.key) + '">' +
      '<input type="checkbox" class="r-menu" value="' + esc(m.key) + '"' +
        (!all && cur.indexOf(m.key) >= 0 ? ' checked' : '') + (all ? ' disabled' : '') + '>' +
      '<span class="perm-txt"><span>' + esc(m.label) + '</span>' +
      '<span class="perm-key">' + esc(m.key) + '</span></span>' +
    '</label>').join('');

  openModal(isEdit ? '编辑角色' : '新建角色',
    // ---- 第一段: 基本信息 ----
    '<div class="form-section">' +
      '<div class="form-section-title">基本信息</div>' +
      (isEdit
        ? '<div class="form-row"><label>角色代码</label><input value="' + esc(r.code) + '" readonly class="mono">' +
          '<div class="hint">代码创建后不可修改 —— 用户的 role 字段存的就是它, 改代码等于悄悄改变所有存量用户的权限。</div></div>'
        : '<div class="form-row"><label>角色代码</label><input id="r-code" class="mono" placeholder="例如: viewer">' +
          '<div class="hint">小写字母/数字/下划线/连字符, 1-32 位。它同时是接口层使用的角色标识, 建好后不可改。</div></div>') +
      '<div class="grid2">' +
        '<div class="form-row"><label>显示名</label><input id="r-name" value="' + esc(isEdit ? r.name : '') + '" placeholder="例如: 只读运营"></div>' +
        '<div class="form-row"><label>说明</label><input id="r-desc" value="' + esc(isEdit ? (r.description || '') : '') + '" placeholder="这个角色给谁用"></div>' +
      '</div>' +
    '</div>' +

    // ---- 第二段: 菜单权限 ----
    '<div class="form-section">' +
      '<div class="form-section-title"><span>菜单权限</span><span class="count" id="r-count"></span></div>' +
      '<label class="perm-all">' +
        '<input type="checkbox" id="r-all"' + (all ? ' checked' : '') + '>' +
        '<span class="perm-all-txt"><b>全部菜单(通配 *)</b>' +
        '<span>授予所有菜单与接口权限; 勾上后下面的单项选择会被忽略</span></span>' +
      '</label>' +
      '<div class="perm-grid" id="r-menus" style="margin-top:10px">' + perms + '</div>' +
      '<p class="hint" style="margin-top:12px">勾选 = 「侧栏可见」<strong>且</strong>「接口可调」。' +
        '它同时是后端接口的权限边界 —— 菜单藏起来只是看不见, 直接调接口一样会被 403 拦住。</p>' +
    '</div>',
    '<button class="btn" id="m-cancel">取消</button><button class="btn primary" id="m-save">保存</button>');

  const allBox = $('#r-all');

  // 勾选状态的两处反馈: 卡片高亮 + 顶部已选计数。用一个函数统一刷新,
  // 免得三处(通配开关 / 单项勾选 / 初始化)各写一套、迟早不一致。
  function refreshPermUI() {
    const wildcard = allBox.checked;
    let n = 0;
    document.querySelectorAll('.perm').forEach((el) => {
      const cb = el.querySelector('.r-menu');
      const checked = !!cb.checked;
      cb.disabled = wildcard;
      el.classList.toggle('dis', wildcard);
      el.classList.toggle('on', checked && !wildcard);
      if (checked) n += 1;
    });
    const cnt = $('#r-count');
    if (cnt) {
      cnt.textContent = wildcard ? '已选: 全部菜单' : (n ? '已选: ' + n + ' 项' : '未选择任何菜单');
      cnt.style.color = !wildcard && n === 0 ? 'var(--danger)' : '';
    }
  }

  document.querySelectorAll('.r-menu').forEach((el) => {
    el.addEventListener('change', refreshPermUI);
  });
  allBox.addEventListener('change', () => {
    // 打开通配 = 放弃下面的单项勾选, 否则关掉通配时会把"已经不算数"的旧勾选放出来
    if (allBox.checked) {
      document.querySelectorAll('.r-menu').forEach((el) => { el.checked = false; });
    }
    refreshPermUI();
  });
  refreshPermUI();

  $('#m-cancel').addEventListener('click', closeModal);

  $('#m-save').addEventListener('click', async () => {
    const picked = allBox.checked
      ? ['*']
      : Array.prototype.slice.call(document.querySelectorAll('.r-menu'))
          .filter((el) => el.checked)
          .map((el) => el.value);
    const payload = {
      name: $('#r-name').value.trim(),
      description: $('#r-desc').value.trim(),
      menus: picked,
    };
    try {
      if (isEdit) {
        await api('/roles/' + r.id, { method: 'PUT', body: JSON.stringify(payload) });
      } else {
        payload.code = $('#r-code').value.trim().toLowerCase();
        await api('/roles', { method: 'POST', body: JSON.stringify(payload) });
      }
      closeModal();
      toast('已保存');
      // 改的可能正是自己所属角色的菜单 —— 立刻重取身份, 免得侧栏与实际权限不一致
      await refreshMe();
      PAGES.roles();
    } catch (e) { toast(e.message, 'err'); }
  });
}

function delRole(id) {
  openModal('确认删除角色',
    '<p>确定要删除这个角色吗?只有没有任何用户在使用它时才能删掉。</p>',
    '<button class="btn" id="m-cancel">取消</button><button class="btn danger" id="m-del">确认删除</button>');
  $('#m-cancel').addEventListener('click', closeModal);
  $('#m-del').addEventListener('click', async () => {
    try {
      await api('/roles/' + id, { method: 'DELETE' });
      closeModal(); toast('已删除'); PAGES.roles();
    } catch (e) { toast(e.message, 'err'); }
  });
}

// ======================= 概览 =======================
// 面向**所有登录用户**的首页: 额度 / 公告 / 近 24h 消耗 / 历史使用 / 请求计数。
// 管理员看到的是全站数据, 业务用户看到的是自己那份 —— 由后端按会话裁定。
PAGES.overview = async () => {
  const tok = navTok();
  $('#main').innerHTML = loadingHTML();
  const d = await api('/overview');
  if (gone(tok)) return;
  overviewRender(d);
};

function overviewRender(d) {
  const me = d.me || {}, c = d.counts || {}, h = d.last24h || {}, hist = d.history || [];
  const scopeTip = d.scope === 'all' ? '全站数据' : '你个人的数据';

  const cards =
    '<div class="cards">' +
      statCard('余额', fmtMoney(me.balance), me.frozen_balance > 0 ? '冻结 ' + fmtMoney(me.frozen_balance) : '') +
      statCard('近 24h 消耗', fmtMoney(h.cost), fmtNum(h.requests) + ' 次请求') +
      statCard('累计消耗', fmtMoney(c.total_cost), fmtNum(c.total_requests) + ' 次请求') +
      statCard('累计 Tokens', fmtNum(c.total_tokens), '输入+输出') +
    '</div>';

  // 公告: 没有就整块不渲染(空面板比没有更碍眼)
  const ann = String(d.announcement || '').trim();
  const annPanel = ann
    ? '<div class="panel"><div class="panel-title">公告信息</div>' +
        '<div class="panel-body"><div class="announce">' + esc(ann) + '</div></div></div>'
    : '';

  // 近 24h 明细
  const h24 =
    '<div class="panel"><div class="panel-title">用量概览 · 近 24 小时</div>' +
      '<div class="table-wrap"><table><tbody>' +
        row2('请求数', fmtNum(h.requests) + (h.errors ? ' <span class="tag err">失败 ' + fmtNum(h.errors) + '</span>' : '')) +
        row2('流式请求', fmtNum(h.stream_requests)) +
        row2('输入 Tokens', fmtNum(h.input_tokens)) +
        row2('输出 Tokens', fmtNum(h.output_tokens)) +
        row2('消耗金额', fmtMoney(h.cost)) +
      '</tbody></table></div>' +
    '</div>';

  // 历史使用: 用纯 CSS 柱状图(不引外部库) —— 高度按最大值等比缩放
  const maxCost = Math.max.apply(null, [0.000001].concat(hist.map((x) => Number(x.cost) || 0)));
  const bars = hist.length
    ? hist.map((x) => {
        const pct = Math.max(2, Math.round((Number(x.cost) || 0) / maxCost * 100));
        return '<div class="bar" title="' + esc(x.day) + ' · ' + fmtMoney(x.cost) +
          ' · ' + fmtNum(x.requests) + ' 次">' +
          '<i style="height:' + pct + '%"></i><span>' + esc(String(x.day || '').slice(5)) + '</span></div>';
      }).join('')
    : '<div class="empty" style="padding:20px">最近 30 天没有调用记录</div>';

  const historyPanel =
    '<div class="panel"><div class="panel-title">历史使用情况 · 近 30 天</div>' +
      '<div class="panel-body"><div class="bars">' + bars + '</div>' +
      '<p class="hint">柱子高度 = 当天消耗金额, 悬停可看日期与请求数。' +
        '按北京时间切天。</p></div>' +
    '</div>';

  $('#main').innerHTML =
    '<div class="page-head"><h2>概览</h2><div class="actions">' +
      '<span class="muted" style="align-self:center">' + esc(scopeTip) + '</span>' +
      '<button class="btn" id="btn-refresh">刷新</button></div></div>' +
    cards + annPanel + h24 + historyPanel;

  $('#btn-refresh').addEventListener('click', () => PAGES.overview());
}

// ======================= 数据看板 =======================
// 模型调用分析 / token 总数 / 消耗分布(模型·平台·按天·Key)。
// ⚠️ 权限: 该菜单**默认只给 admin**; 即便被授予自定义角色, 后端也会强制
// 只看该用户自己的数据(scope='self'), 不会泄露全站。
PAGES.board = async () => {
  const tok = navTok();
  $('#main').innerHTML = loadingHTML();
  const d = await api('/board');
  if (gone(tok)) return;
  boardRender(d);
};

function boardRender(d) {
  const t = d.totals || {};
  const scopeTip = d.scope === 'all' ? '全站数据' : '你个人的数据';

  const cards =
    '<div class="cards">' +
      statCard('请求总数', fmtNum(t.requests), t.errors ? '失败 ' + fmtNum(t.errors) : '无失败请求') +
      statCard('Token 总数', fmtNum(t.total_tokens),
        '输入 ' + fmtNum(t.input_tokens) + ' / 输出 ' + fmtNum(t.output_tokens)) +
      statCard('总消耗', fmtMoney(t.cost), '平均耗时 ' + fmtNum(t.avg_duration_ms) + ' ms') +
      statCard('缓存读取 Tokens', fmtNum(t.cache_read_tokens), '') +
    '</div>';

  // ---- 消耗分布: 按天 ----
  const byDay = d.by_day || [];
  const maxDay = Math.max.apply(null, [0.000001].concat(byDay.map((x) => Number(x.cost) || 0)));
  const dayBars = byDay.length
    ? byDay.map((x) => {
        const pct = Math.max(2, Math.round((Number(x.cost) || 0) / maxDay * 100));
        return '<div class="bar" title="' + esc(x.day) + ' · ' + fmtMoney(x.cost) +
          ' · ' + fmtNum(x.requests) + ' 次">' +
          '<i style="height:' + pct + '%"></i><span>' + esc(String(x.day || '').slice(5)) + '</span></div>';
      }).join('')
    : '<div class="empty" style="padding:20px">最近 14 天没有调用记录</div>';

  // ---- 消耗分布: 按平台 / 按 Key (横向占比条) ----
  const platforms = d.by_platform || [];
  const maxPlat = Math.max.apply(null, [0.000001].concat(platforms.map((x) => Number(x.cost) || 0)));
  const platRows = platforms.length
    ? platforms.map((p) =>
        '<tr><td>' + esc(p.platform) + '</td>' +
        '<td class="muted">' + fmtNum(p.requests) + '</td>' +
        '<td class="muted">' + fmtMoney(p.cost) + '</td>' +
        '<td style="width:42%">' + miniBar((Number(p.cost) || 0) / maxPlat) + '</td></tr>').join('')
    : '<tr><td colspan="4" class="empty">暂无数据</td></tr>';

  const keys = d.by_key || [];
  const maxKey = Math.max.apply(null, [0.000001].concat(keys.map((x) => Number(x.cost) || 0)));
  const keyRows = keys.length
    ? keys.map((k) =>
        '<tr><td>' + esc(k.key_name) + ' <span class="muted mono">#' + esc(k.key_id) + '</span></td>' +
        '<td class="muted">' + fmtNum(k.requests) + '</td>' +
        '<td class="muted">' + fmtMoney(k.cost) + '</td>' +
        '<td style="width:42%">' + miniBar((Number(k.cost) || 0) / maxKey) + '</td></tr>').join('')
    : '<tr><td colspan="4" class="empty">暂无数据</td></tr>';

  // ---- 模型调用分析 ----
  const models = d.by_model || [];
  const maxModel = Math.max.apply(null, [0.000001].concat(models.map((x) => Number(x.requests) || 0)));
  const modelRows = models.length
    ? models.map((m) =>
        '<tr><td class="mono">' + esc(m.model) + '</td>' +
        '<td>' + fmtNum(m.requests) + '</td>' +
        '<td class="muted">' + fmtNum(m.input_tokens) + ' / ' + fmtNum(m.output_tokens) + '</td>' +
        '<td class="muted">' + fmtMoney(m.cost) + '</td>' +
        '<td style="width:26%">' + miniBar((Number(m.requests) || 0) / maxModel) + '</td></tr>').join('')
    : '<tr><td colspan="5" class="empty">还没有模型调用记录</td></tr>';

  $('#main').innerHTML =
    '<div class="page-head"><h2>数据看板</h2><div class="actions">' +
      '<span class="muted" style="align-self:center">' + esc(scopeTip) + '</span>' +
      '<button class="btn" id="btn-refresh">刷新</button></div></div>' +
    cards +

    '<div class="panel"><div class="panel-title">消耗分布 · 近 14 天</div>' +
      '<div class="panel-body"><div class="bars">' + dayBars + '</div></div></div>' +

    '<div class="panel"><div class="panel-title">模型调用分析 · Top 20</div>' +
      '<div class="table-wrap"><table><thead><tr>' +
        '<th>模型</th><th>请求数</th><th>输入/输出 Tokens</th><th>消耗</th><th>占比</th>' +
      '</tr></thead><tbody>' + modelRows + '</tbody></table></div></div>' +

    '<div class="panel"><div class="panel-title">消耗分布 · 按上游平台</div>' +
      '<div class="table-wrap"><table><thead><tr>' +
        '<th>平台</th><th>请求数</th><th>消耗</th><th>占比</th>' +
      '</tr></thead><tbody>' + platRows + '</tbody></table></div></div>' +

    '<div class="panel"><div class="panel-title">消耗分布 · 按 API Key</div>' +
      '<div class="table-wrap"><table><thead><tr>' +
        '<th>Key</th><th>请求数</th><th>消耗</th><th>占比</th>' +
      '</tr></thead><tbody>' + keyRows + '</tbody></table></div></div>';

  $('#btn-refresh').addEventListener('click', () => PAGES.board());
}

/** 统计卡片 / 两列表格行 / 横向占比条 —— 几个页面共用的小拼装件。
 *  ⚠️ 卡片本身复用全局的 card(k, v)(定义在上面), 这里只包一层"带副标题"的版本 ——
 *  别再造一个同名函数, 内联脚本是一整个作用域, 重名会直接 SyntaxError 白屏。 */
function statCard(k, v, sub) {
  return card(k, v + (sub ? ' <small>' + esc(sub) + '</small>' : ''));
}
function row2(k, v) {
  return '<tr><td class="muted" style="width:160px">' + esc(k) + '</td><td>' + v + '</td></tr>';
}
function miniBar(ratio) {
  const pct = Math.max(2, Math.min(100, Math.round((Number(ratio) || 0) * 100)));
  return '<div class="minibar"><i style="width:' + pct + '%"></i></div>';
}

// ======================= 使用日志 =======================
// 面向业务用户: **固定只看自己的调用记录**(后端按会话过滤, 没有"选用户"的入口)。
// 列: 时间 / 令牌 / 模型 / 流 / Tokens / 费用 / 耗时 / 详情
const logsState = { page: 1, pageSize: 50, total: 0, model: '', status: '' };
PAGES.logs = async () => {
  const tok = navTok();
  $('#main').innerHTML = loadingHTML();
  const d = await logsFetch();
  // 守卫必须在**本函数内**、await 之后: 翻页时快速连点会让旧响应后到,
  // 不加这道就会把新页的内容盖掉(串页 bug 的老毛病)。
  if (gone(tok)) return;
  logsState.total = d.total || 0;
  logsRender(d);
};

/** 按当前筛选/分页取数 —— 只负责请求, 渲染交给调用方(它才持有导航令牌) */
async function logsFetch() {
  const qs = '?limit=' + logsState.pageSize + '&offset=' + ((logsState.page - 1) * logsState.pageSize) +
    (logsState.model ? '&model=' + encodeURIComponent(logsState.model) : '') +
    (logsState.status ? '&status=' + logsState.status : '');
  return api('/logs' + qs);
}

function logsRender(d) {
  const logs = d.logs || [];
  const s = d.summary || {};
  const pageSize = logsState.pageSize;
  const pageCount = Math.max(1, Math.ceil((d.total || 0) / pageSize));
  // 越界回退: 删到最后一页只剩 0 条时, page 会比 pageCount 大
  if (logsState.page > pageCount) { logsState.page = pageCount; }

  const modelOpts = ['<option value="">全部模型</option>'].concat(
    (d.models || []).map((m) => '<option value="' + esc(m.model) + '"' +
      (logsState.model === m.model ? ' selected' : '') + '>' + esc(m.model) +
      ' (' + fmtNum(m.count) + ')</option>')).join('');

  const rows = logs.length ? logs.map((l) =>
    '<tr>' +
      '<td class="muted">' + fmtTime(l.created_at) + '</td>' +
      '<td class="mono">' + esc(l.key_name || '-') +
        (l.key_value ? '<br><span class="muted" style="font-size:11px">' + esc(l.key_value) + '</span>' : '') + '</td>' +
      // 模型列只显示**用户自己发的那个名字**(后端已不再下发 upstream_model, 这里留
      // 兼容: 万一拿到老缓存数据也不会把上游名字露出来)。
      '<td class="mono">' + esc(l.requested_model || l.model || '-') + '</td>' +
      '<td>' + (l.stream ? '<span class="tag ok">流式</span>' : '<span class="tag">普通</span>') + '</td>' +
      '<td class="muted">' + fmtNum(l.input_tokens) + ' / ' + fmtNum(l.output_tokens) + '</td>' +
      '<td class="muted">' + fmtMoney(l.cost) + '</td>' +
      '<td class="muted">' + fmtNum(l.duration_ms) + ' ms</td>' +
      '<td><button class="btn sm" data-log-detail="' + l.id + '">详情</button></td>' +
    '</tr>').join('')
    : '<tr><td colspan="8" class="empty">' +
      (d.total ? '本页没有记录' : '还没有调用记录') + '</td></tr>';

  // 详情需要完整行 —— 存一份索引, 点"详情"时直接取, 不再打一次接口
  PAGES._logsCache = {};
  logs.forEach((l) => { PAGES._logsCache[l.id] = l; });

  $('#main').innerHTML =
    '<div class="page-head"><h2>使用日志</h2><div class="actions">' +
      '<button class="btn" id="btn-refresh">刷新</button></div></div>' +

    '<div class="cards">' +
      statCard('请求数', fmtNum(s.requests), s.errors ? '失败 ' + fmtNum(s.errors) : '无失败') +
      statCard('Tokens', fmtNum(s.tokens), '输入+输出') +
      statCard('消耗', fmtMoney(s.cost), '') +
    '</div>' +

    '<div class="panel"><div class="panel-title">筛选</div>' +
      '<div class="panel-body"><div class="filters">' +
        '<div class="form-row"><label>模型</label><select id="lg-model">' + modelOpts + '</select></div>' +
        '<div class="form-row"><label>结果</label><select id="lg-status">' +
          '<option value=""' + (logsState.status === '' ? ' selected' : '') + '>全部</option>' +
          '<option value="success"' + (logsState.status === 'success' ? ' selected' : '') + '>成功</option>' +
          '<option value="error"' + (logsState.status === 'error' ? ' selected' : '') + '>失败</option>' +
        '</select></div>' +
        '<div class="form-row"><label>每页</label><select id="lg-size">' +
          [20, 50, 100].map((n) => '<option value="' + n + '"' +
            (pageSize === n ? ' selected' : '') + '>' + n + ' 条</option>').join('') +
        '</select></div>' +
      '</div></div></div>' +

    '<div class="panel"><div class="panel-title">调用记录 (共 ' + fmtNum(d.total || 0) + ' 条)</div>' +
      '<div class="table-wrap"><table><thead><tr>' +
        '<th>时间 (UTC+8)</th><th>令牌</th><th>模型</th><th>流</th>' +
        '<th>Tokens (入/出)</th><th>费用</th><th>耗时</th><th>详情</th>' +
      '</tr></thead><tbody>' + rows + '</tbody></table></div>' +
      '<div class="panel-body"><div class="pager">' +
        '<span class="muted">第 ' + logsState.page + ' / ' + pageCount + ' 页</span>' +
        '<button class="btn sm" id="lg-prev"' + (logsState.page <= 1 ? ' disabled' : '') + '>上一页</button>' +
        '<button class="btn sm" id="lg-next"' + (logsState.page >= pageCount ? ' disabled' : '') + '>下一页</button>' +
      '</div></div>' +
    '</div>';

  $('#btn-refresh').addEventListener('click', () => PAGES.logs());
  $('#lg-model').addEventListener('change', (e) => {
    logsState.model = e.target.value; logsState.page = 1; PAGES.logs();
  });
  $('#lg-status').addEventListener('change', (e) => {
    logsState.status = e.target.value; logsState.page = 1; PAGES.logs();
  });
  $('#lg-size').addEventListener('change', (e) => {
    logsState.pageSize = Number(e.target.value) || 50; logsState.page = 1; PAGES.logs();
  });
  $('#lg-prev').addEventListener('click', () => {
    if (logsState.page > 1) { logsState.page -= 1; PAGES.logs(); }
  });
  $('#lg-next').addEventListener('click', () => {
    if (logsState.page < pageCount) { logsState.page += 1; PAGES.logs(); }
  });
  document.querySelectorAll('[data-log-detail]').forEach((el) => {
    el.addEventListener('click', () => showLogDetail(Number(el.dataset.logDetail)));
  });
}

/** 单条调用记录的详情弹窗 */
function showLogDetail(id) {
  const l = (PAGES._logsCache || {})[id];
  if (!l) return;
  const statusHtml = l.error
    ? '<span class="tag err">失败</span>'
    : '<span class="tag ok">成功</span>';
  // 🚨 面向业务用户: 详情里**不露上游** —— 上游模型名 / 上游账号 / User-Agent 都属于
  // 网关内部信息, 用户看到了只会困惑(而且后端 /logs 也压根不下发这些字段, 见 getLogs)。
  openModal('调用详情 #' + l.id,
    '<table><tbody>' +
      row2('时间', fmtTime(l.created_at)) +
      row2('结果', statusHtml) +
      row2('请求模型', '<span class="mono">' + esc(l.requested_model || l.model || '-') + '</span>') +
      row2('计费模型', '<span class="mono">' + esc(l.model || '-') + '</span>') +
      row2('Request ID', '<span class="mono">' + esc(l.request_id || '-') + '</span>') +
      row2('令牌', esc(l.key_name || '-') + (l.key_value ? ' <span class="muted mono">' + esc(l.key_value) + '</span>' : '')) +
      row2('流式', l.stream ? '是' : '否') +
      row2('输入 Tokens', fmtNum(l.input_tokens)) +
      row2('输出 Tokens', fmtNum(l.output_tokens)) +
      row2('缓存读 Tokens', fmtNum(l.cache_read_tokens)) +
      row2('缓存写 Tokens', fmtNum(l.cache_creation_tokens)) +
      row2('费用', fmtMoney(l.cost)) +
      row2('耗时', fmtNum(l.duration_ms) + ' ms') +
      row2('首 Token 耗时', l.first_token_ms == null ? '-' : fmtNum(l.first_token_ms) + ' ms') +
      row2('IP', esc(l.ip_address || '-')) +
    '</tbody></table>',
    '<button class="btn primary" id="m-close">关闭</button>');
  $('#m-close').addEventListener('click', closeModal);
}

// ======================= 个人资料 =======================
// 资料 + 分组 + 钱包(余额/总用量/总请求数) + 每日签到。
// 所有数据硬绑会话用户 —— 后端不接受任何 id 参数。
PAGES.profile = async () => {
  const tok = navTok();
  $('#main').innerHTML = loadingHTML();
  const d = await api('/profile');
  if (gone(tok)) return;
  profileRender(d);
};

function profileRender(d) {
  const u = d.user || {}, w = d.wallet || {}, ck = d.checkin || {};
  const groups = d.groups || [];

  const groupHtml = groups.length
    ? groups.map((g) => '<span class="tag">' + esc(g.name) + '</span>').join(' ')
    : '<span class="muted">未加入任何分组</span>';

  const recent = (ck.recent || []).length
    ? (ck.recent || []).map((r) => '<span class="tag">' + esc(r.day) + ' · +' + fmtUsd(r.amount) + '</span>').join(' ')
    : '<span class="muted">还没有签到记录</span>';

  // 签到按钮三态: 功能关闭 / 今天已签 / 可签到
  let ckBtn;
  if (!ck.enabled) {
    ckBtn = '<button class="btn" disabled>签到功能已关闭</button>';
  } else if (ck.checked_today) {
    ckBtn = '<button class="btn" disabled>今天已签到 · 连续 ' + fmtNum(ck.streak) + ' 天</button>';
  } else {
    ckBtn = '<button class="btn primary" id="btn-checkin">立即签到 (随机 +100~200)</button>';
  }

  $('#main').innerHTML =
    '<div class="page-head"><h2>个人资料</h2><div class="actions">' +
      '<button class="btn" id="btn-refresh">刷新</button></div></div>' +

    '<div class="cards">' +
      statCard('余额', fmtMoney(w.balance), w.frozen_balance > 0 ? '冻结 ' + fmtMoney(w.frozen_balance) : '') +
      statCard('总用量', fmtMoney(w.total_cost), fmtNum(w.total_tokens) + ' tokens') +
      statCard('总请求数', fmtNum(w.total_requests), '') +
      statCard('连续签到', fmtNum(ck.streak) + ' 天', ck.checked_today ? '今天已签' : '今天还没签') +
    '</div>' +

    '<div class="panel"><div class="panel-title">每日签到</div>' +
      '<div class="panel-body">' +
        '<p class="hint">每天可签到一次, 随机增加 <strong>100 ~ 200</strong> 余额。' +
          '按北京时间零点重置 —— 当天已签过再点会提示。</p>' +
        '<div class="panel-actions">' + ckBtn + '</div>' +
        '<p class="hint" style="margin-top:14px">最近签到: ' + recent + '</p>' +
      '</div></div>' +

    '<div class="panel"><div class="panel-title">个人信息</div>' +
      '<div class="table-wrap"><table><tbody>' +
        row2('用户名称', esc(u.username || u.email || '-')) +
        row2('邮箱', esc(u.email || '-')) +
        row2('角色', esc(u.role_name || u.role || '-')) +
        row2('状态', String(u.status) === 'active'
          ? '<span class="tag ok">正常</span>' : '<span class="tag err">' + esc(u.status) + '</span>') +
        row2('所属分组', groupHtml) +
        row2('并发限制', u.concurrency ? fmtNum(u.concurrency) : '不限') +
        row2('RPM 限制', u.rpm_limit ? fmtNum(u.rpm_limit) : '不限') +
        row2('注册时间', fmtTime(u.created_at)) +
        row2('最近登录', fmtTime(u.last_login_at)) +
        (u.notes ? row2('备注', esc(u.notes)) : '') +
      '</tbody></table></div>' +
    '</div>' +

    '<div class="panel"><div class="panel-title">钱包</div>' +
      '<div class="table-wrap"><table><tbody>' +
        row2('当前余额', '<strong>' + fmtMoney(w.balance) + '</strong>') +
        (w.frozen_balance > 0 ? row2('冻结余额', fmtMoney(w.frozen_balance)) : '') +
        row2('总用量 (金额)', fmtMoney(w.total_cost)) +
        row2('总用量 (tokens)', fmtNum(w.total_tokens)) +
        row2('总请求数', fmtNum(w.total_requests)) +
      '</tbody></table></div>' +
      '<div class="panel-body"><p class="hint">余额不足时接口返回 <code>INSUFFICIENT_BALANCE</code>。</p></div>' +
    '</div>';

  $('#btn-refresh').addEventListener('click', () => PAGES.profile());
  const btn = $('#btn-checkin');
  if (btn) btn.addEventListener('click', doCheckin);
}

async function doCheckin() {
  const btn = $('#btn-checkin');
  if (btn) { btn.disabled = true; btn.textContent = '签到中…'; }
  startProgress();
  try {
    const r = await api('/profile/checkin', { method: 'POST' });
    toast('签到成功, 获得 ' + fmtUsd(r.amount) + ' 余额', 'ok');
    PAGES.profile();
  } catch (e) {
    // 409 = 今天已签(可能是另一个标签页先点了) —— 刷新一次让按钮变成"已签到"
    toast(e.message, 'err');
    if (/已经签到/.test(e.message || '')) PAGES.profile();
    else if (btn) { btn.disabled = false; btn.textContent = '立即签到 (随机 +100~200)'; }
  } finally {
    stopProgress();
  }
}

// ======================= API秘钥 =======================
// 业务用户的自助页。所有数据都由后端按**会话里的 user id**过滤,
// 这里没有"选用户"的入口 —— 也就不存在越权看别人的可能。
PAGES.mykeys = async () => {
  const tok = navTok();
  $('#main').innerHTML = loadingHTML();
  const d = await api('/my/keys');
  if (gone(tok)) return;
  myKeysRender(d);
};

/**
 * 「API秘钥」页 —— **只放 Key 数据**。
 *
 * 2026-09-21 精简: 原先这个页面还背着「我的账号(余额/角色)」「最近调用」两块,
 * 现在它们各自有了归宿 —— 账号/钱包信息去「个人资料」, 调用记录去「使用日志」。
 * 只留下「怎么调用」这段接入说明: 没有它用户拿到 Key 也不知道往哪填,
 * 它是这个页面的必要上下文, 不是"额外信息"。
 */
function myKeysRender(d) {
  const g = d.default_group;
  const maxKeys = d.max_keys || 20;
  const ks = d.api_keys || [];

  const keyRows = ks.length ? ks.map((k) =>
    '<tr>' +
      '<td class="mono" style="max-width:320px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + esc(k.key) +
        ' <button class="btn sm" data-copy-key="' + esc(k.key) + '">复制</button></td>' +
      '<td>' + esc(k.name || '-') + '</td>' +
      '<td>' + esc(k.group_name || (k.group_id == null ? '<未分组>' : '#' + k.group_id)) + '</td>' +
      '<td>' + esc(k.status) + '</td>' +
      '<td class="muted">' + fmtMoney(k.quota_used) + ' / ' + (k.quota > 0 ? fmtMoney(k.quota) : '不限') + '</td>' +
      '<td class="muted">' + fmtTime(k.last_used_at) + '</td>' +
      '<td><button class="btn sm danger" data-del-mykey="' + k.id + '">删除</button></td>' +
    '</tr>').join('') : '<tr><td colspan="7" class="empty">还没有 Key, 点右上角「新建 Key」</td></tr>';

  $('#main').innerHTML =
    '<div class="page-head"><h2>API秘钥</h2><div class="actions">' +
      '<button class="btn" id="btn-refresh">刷新</button>' +
      '<button class="btn primary" id="btn-new-mykey">新建 Key</button></div></div>' +

    '<div class="panel"><div class="panel-title">我的 Key (' + ks.length + ' / ' + maxKeys + ')</div>' +
      '<div class="table-wrap"><table><thead><tr>' +
        '<th>Key</th><th>名称</th><th>分组</th><th>状态</th><th>已用额度</th>' +
        '<th>最近使用 (UTC+8)</th><th>操作</th>' +
      '</tr></thead><tbody>' + keyRows + '</tbody></table></div>' +
      '<div class="panel-body"><p class="hint">新建的 Key 会挂到默认分组 <strong>' +
        (g ? esc(g.name) : '<span style="color:var(--danger)">(没有可用分组, 请联系管理员)</span>') +
        '</strong>, 并立刻继承该分组的路由配置。明文只在创建时显示一次, 请立刻保存。</p></div>' +
    '</div>' +

    '<div class="panel"><div class="panel-title">怎么调用</div>' +
      '<div class="panel-body">' +
        '<div class="form-row"><label>接口地址</label><input id="my-base" readonly class="mono" value="' +
          esc(location.origin) + '"></div>' +
        '<div class="panel-actions">' +
          '<button class="btn" id="btn-copy-base">复制接口地址</button>' +
          '<button class="btn" id="btn-copy-sample">复制 curl 示例</button>' +
        '</div>' +
        '<p class="hint">把接口地址填进任意 OpenAI 兼容客户端, API Key 用刚创建的那把 —— ' +
          '明文只在创建时显示一次, 请立刻保存。余额不足时接口返回 <code>INSUFFICIENT_BALANCE</code>。' +
          '调用明细可在「使用日志」查看, 余额与签到在「个人资料」。</p>' +
      '</div></div>';

  $('#btn-refresh').addEventListener('click', () => PAGES.mykeys());
  $('#btn-new-mykey').addEventListener('click', newMyKey);
  document.querySelectorAll('[data-copy-key]').forEach((el) => {
    el.addEventListener('click', () => copyText(el.dataset.copyKey, 'Key 已复制'));
  });
  document.querySelectorAll('[data-del-mykey]').forEach((el) => {
    el.addEventListener('click', () => delMyKey(Number(el.dataset.delMykey)));
  });
  $('#btn-copy-base').addEventListener('click', () => copyText(location.origin, '接口地址已复制'));
  $('#btn-copy-sample').addEventListener('click', () => {
    const sample = 'curl ' + location.origin + '/v1/chat/completions' +
      ' -H "Authorization: Bearer <你的KEY>" -H "Content-Type: application/json"' +
      ' -d "{\\"model\\":\\"<模型名>\\",\\"messages\\":[{\\"role\\":\\"user\\",\\"content\\":\\"hi\\"}]}"';
    copyText(sample, 'curl 示例已复制');
  });
}

function newMyKey() {
  openModal('新建 API Key',
    '<div class="form-row"><label>名称</label><input id="mk-name" placeholder="例如: 我的脚本"></div>' +
    '<p class="hint">新建的 Key 会挂到默认分组, 并立刻继承该分组的路由配置(平台重定向 / 白名单 / 分组平台)。</p>',
    '<button class="btn" id="m-cancel">取消</button><button class="btn primary" id="m-save">创建</button>');
  $('#m-cancel').addEventListener('click', closeModal);
  $('#m-save').addEventListener('click', async () => {
    try {
      const r = await api('/my/keys', {
        method: 'POST',
        body: JSON.stringify({ name: $('#mk-name').value.trim() }),
      });
      // 明文只有这一次机会 —— 用一个必须手动关闭的弹窗挡住, 不要用 3 秒就消失的 toast
      showNewKey(r.key);
      PAGES.mykeys();
    } catch (e) { toast(e.message, 'err'); }
  });
}

function showNewKey(key) {
  openModal('Key 创建成功',
    '<p>请立刻复制保存 —— 明文只显示这一次, 之后只能看到打码后的值。</p>' +
    '<div class="form-row"><label>API Key</label>' +
      '<input readonly class="mono" value="' + esc(key) + '"></div>',
    '<button class="btn primary" id="m-copy">复制并关闭</button>');
  $('#m-copy').addEventListener('click', () => { copyText(key, 'Key 已复制'); closeModal(); });
}

function delMyKey(id) {
  openModal('确认删除',
    '<p>删除后这把 Key 立刻失效, 正在使用它的程序会开始报 401。</p>',
    '<button class="btn" id="m-cancel">取消</button><button class="btn danger" id="m-del">确认删除</button>');
  $('#m-cancel').addEventListener('click', closeModal);
  $('#m-del').addEventListener('click', async () => {
    try {
      await api('/my/keys/' + id, { method: 'DELETE' });
      closeModal(); toast('已删除'); PAGES.mykeys();
    } catch (e) { toast(e.message, 'err'); }
  });
}

// ======================= 模型获取 =======================
/**
 * 别名规范: 「平台名 + 平台获取的模型 ID」拼成对外别名。
 *
 * 为什么是这个方向: 上游平台内部各自的模型叫法经常撞车(两家都叫 glm-5.2, 但一家是满血一家是
 * 阉割版)。把「平台」写进别名里, 对外就是一个不会撞的名字, 转发时再由账号级 model_aliases
 * 映射回该上游真正认识的那个 ID。
 *
 * 拼接规则: 平台名 + '-' + 模型 ID, 全部小写, 非法字符统一压成 '-'。
 * 例: 平台 sensenova + 模型 GLM-5.2  ->  sensenova-glm-5.2
 */
function suggestAlias(platform, modelId) {
  const p = String(platform || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const m = String(modelId || '').trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  if (!p) return m;
  if (!m) return p;
  return p + '-' + m;
}

/**
 * 「别名」标签页的正文 —— 内容与合并前的「模型获取」页一致,
 * 只是渲染到 #models-body(标签页容器) 而不是整个 #main。
 * ⚠️ 这段注释在 ADMIN_HTML 模板字面量里, 一个反引号就会把宿主模板提前闭合(TS1005),
 * 所以上面两个选择器都不能写成反引号形式。
 *
 * accts 由调用方(PAGES.models)取好传进来 —— 两个标签页共用同一份上游账号列表,
 * 切标签页时不必再请求一次。
 */
function modelsAliasView(accts) {
  if (!accts.length) {
    $('#models-body').innerHTML =
      '<div class="panel"><div class="empty">还没有上游账号, 请先到「上游账号」添加。</div></div>';
    return;
  }

  const opts = accts.map((a) =>
    '<option value="' + a.id + '">' + esc(a.name) + ' · ' + esc(a.platform) + '</option>').join('');

  $('#models-body').innerHTML =
    '<div class="panel">' +
      '<div class="panel-title">从上游拉取真实模型列表</div>' +
      // 正文必须套 .panel-body: .panel 自己不带内边距, 直接塞文字会贴着边框
      '<div class="panel-body">' +
        '<p class="hint">' +
          '对着某个上游账号发一次 <code>GET 模型列表</code>, 把对方<b>实际提供</b>的模型 ID 抓回来。' +
          '拿到之后可按「平台名 + 模型 ID」一键生成别名, 写回该账号。' +
          '请求地址取该账号配置的 <b>Base URL</b>(第三方中转); 只有没配 Base URL 时才用官方默认域名。' +
        '</p>' +
        '<div class="form-row" style="max-width:560px">' +
          '<label>选择上游账号</label>' +
          '<select id="d-acct" class="mono">' + opts + '</select>' +
        '</div>' +
        '<div class="panel-actions">' +
          '<button class="btn primary" id="d-go">获取模型列表</button>' +
          '<button class="btn" id="d-save" style="display:none">保存别名到该账号</button>' +
        '</div>' +
      '</div>' +
      '<div id="d-body" class="result-body"></div>' +
    '</div>';

  let fetched = null; // { accountId, platform, models:[] }

  $('#d-go').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    const id = Number($('#d-acct').value);
    const acct = accts.find((a) => a.id === id);
    btn.disabled = true; btn.textContent = '获取中…';
    $('#d-save').style.display = 'none';
    $('#d-body').innerHTML = '<div class="empty">请求上游中…</div>';
    try {
      const r = await api('/accounts/' + id + '/models');
      const head =
        '<div class="muted" style="font-size:12px;line-height:1.9;margin-bottom:14px">' +
          '账号 <b>' + esc(acct.name) + '</b> · 平台 <span class="tag off">' + esc(acct.platform) + '</span>' +
          ' · 请求地址 <code>' + esc(r.base_url || acct.effective_base_url || '-') + '</code>' +
          (r.latency_ms ? ' · 耗时 ' + r.latency_ms + 'ms' : '') +
        '</div>';

      if (!r.ok || !(r.models || []).length) {
        $('#d-body').innerHTML = head +
          '<div class="panel" style="border:1px solid var(--danger)">' +
            '<div style="padding:14px 16px;color:var(--danger);font-size:13px;line-height:1.8">' +
              esc(r.message || '获取失败') +
            '</div>' +
          '</div>' +
          '<p class="hint" style="margin:14px 0 0">' +
            '拉不到不代表账号不可用 —— 有些上游压根没实现列模型接口。' +
            '这时请到「模型别名」页手动为该账号新增别名。' +
          '</p>';
        return;
      }

      fetched = { accountId: id, platform: acct.platform, models: r.models };
      const existing = acct.model_aliases || {};

      const rows = r.models.map((mid) => {
        const alias = suggestAlias(acct.platform, mid);
        // 已经配过的先回填, 免得用户白填一遍
        const pre = existing[alias] || '';
        return '<tr>' +
          '<td class="mono">' + esc(mid) + '</td>' +
          '<td class="mono">' + esc(acct.platform) + '</td>' +
          '<td><input class="d-alias mono" data-mid="' + esc(mid) + '" value="' + esc(alias) + '" style="width:100%"></td>' +
          '<td><input class="d-target mono" data-mid="' + esc(mid) + '" value="' + esc(pre || mid) + '" style="width:100%"></td>' +
        '</tr>';
      }).join('');

      $('#d-body').innerHTML = head +
        '<div class="panel"><div class="panel-title">共 ' + r.models.length + ' 个模型 · 可编辑别名后保存</div>' +
        '<div class="table-wrap"><table><thead><tr><th>上游模型 ID</th><th>平台</th><th>对外别名(可改)</th><th>转发给上游的名字</th></tr></thead>' +
        '<tbody>' + rows + '</tbody></table></div></div>' +
        '<p class="hint" style="margin:14px 0 0">' +
          '「转发给上游的名字」默认等于上游模型 ID, 只有该上游内部叫法不同时才需要改。' +
        '</p>';
      $('#d-save').style.display = 'inline-block';
    } catch (err) {
      $('#d-body').innerHTML = '<div class="empty" style="color:var(--danger)">' + esc(err.message) + '</div>';
    } finally {
      btn.disabled = false; btn.textContent = '获取模型列表';
    }
  });

  $('#d-save').addEventListener('click', async () => {
    if (!fetched) return;
    const aliases = {};
    document.querySelectorAll('.d-alias').forEach((el) => {
      const mid = el.dataset.mid;
      const alias = el.value.trim();
      const targetEl = document.querySelector('.d-target[data-mid="' + CSS.escape(mid) + '"]');
      const target = targetEl ? targetEl.value.trim() : mid;
      if (alias && target) aliases[alias] = target;
    });
    // 合并已有别名: 本次没涉及到的条目原样保留, 否则保存一次会清掉手填的规则
    const acct = accts.find((a) => a.id === fetched.accountId);
    const merged = Object.assign({}, acct.model_aliases || {}, aliases);

    const btn = $('#d-save');
    btn.disabled = true; btn.textContent = '保存中…';
    try {
      await api('/accounts/' + fetched.accountId, {
        method: 'PUT',
        body: JSON.stringify({ model_aliases: merged }),
      });
      toast('已保存 ' + Object.keys(aliases).length + ' 条别名');
      PAGES.models();
    } catch (e) {
      toast(e.message, 'err');
      btn.disabled = false; btn.textContent = '保存别名到该账号';
    }
  });
}

// ======================= 模型别名 =======================
/** 把账号的别名表拍平成一行行, 便于统一查看/编辑 */
function flattenAliases(accounts) {
  const out = [];
  for (const a of accounts) {
    const al = a.model_aliases || {};
    for (const [alias, target] of Object.entries(al)) {
      out.push({ accountId: a.id, accountName: a.name, platform: a.platform, alias, target });
    }
  }
  out.sort((x, y) =>
    x.platform.localeCompare(y.platform) ||
    x.accountName.localeCompare(y.accountName) ||
    x.alias.localeCompare(y.alias));
  return out;
}

PAGES.aliases = async () => {
  const tok = navTok();
  $('#main').innerHTML = loadingHTML();
  const d = await api('/accounts');
  if (gone(tok)) return;
  const accounts = d.accounts || [];
  const flat = flattenAliases(accounts);
  PAGES._aliasAccounts = accounts;

  const rows = flat.length
    ? flat.map((r) =>
        '<tr>' +
          '<td><span class="tag off">' + esc(r.platform) + '</span>' +
            (r.alias.toLowerCase().startsWith(String(r.platform).toLowerCase() + '-')
              ? ' <span class="tag ok" title="符合「平台名 + 模型 ID」规范">规范</span>' : '') + '</td>' +
          '<td>' + esc(r.accountName) + '</td>' +
          '<td class="mono">' + esc(r.alias) + '</td>' +
          '<td class="mono">' + esc(r.target) + '</td>' +
          '<td><button class="btn sm" data-edit-alias="' + r.accountId + '" data-alias="' + esc(r.alias) + '">编辑</button> ' +
              '<button class="btn sm danger" data-del-alias="' + r.accountId + '" data-alias="' + esc(r.alias) + '">删除</button></td>' +
        '</tr>').join('')
    : '<tr><td colspan="5" class="empty">还没有配置别名。到「模型获取」拉一次上游模型, 或点右上角「新增别名」手填。</td></tr>';

  $('#main').innerHTML =
    '<div class="page-head"><h2>获取平台模型别名</h2><div class="actions">' +
      '<button class="btn primary" id="btn-new-alias">新增别名</button></div></div>' +
    '<div class="panel"><div class="panel-title">' +
      '共 ' + flat.length + ' 条 · 别名规范 <code>平台名-模型ID</code>(如 <code>sensenova-glm-5.2</code>)' +
    '</div>' +
    '<table><thead><tr><th>平台</th><th>上游账号</th><th>对外别名</th><th>转发给上游的名字</th><th>操作</th></tr></thead>' +
    '<tbody>' + rows + '</tbody></table></div>' +
    '<p class="hint muted" style="margin-top:10px">' +
      '别名的作用: 客户端发「对外别名」, 网关路由到该账号后自动换成「转发给上游的名字」。' +
      '同一个模型名在多个上游各有各的写法时, 在这里逐个上游声明即可, 不会互相打架。<br>' +
      '<b>别名同时兼作路由依据</b>: 客户端发<b>对外别名</b>时, 会<b>优先选中声明它的这个账号</b> ' +
      '(因此走的也是该账号的 Base URL) —— 同一个平台名下挂了多条中转时, 就靠它区分"这个模型该去哪一条"。' +
      '所以别名不是单纯的改名, 别忘了它会参与选号。' +
      '读起来顺一下: 这里的每一行, 左边决定"请求怎么打进来", 右边决定"转发给上游时叫什么"。' +
    '</p>';

  $('#btn-new-alias').addEventListener('click', () => aliasForm(null, null, null));

  document.querySelectorAll('[data-edit-alias]').forEach((el) => {
    el.addEventListener('click', () => {
      const a = accounts.find((x) => x.id === Number(el.dataset.editAlias));
      const alias = el.dataset.alias;
      aliasForm(a, alias, (a.model_aliases || {})[alias] || '');
    });
  });

  document.querySelectorAll('[data-del-alias]').forEach((el) => {
    el.addEventListener('click', () => {
      const a = accounts.find((x) => x.id === Number(el.dataset.delAlias));
      const alias = el.dataset.alias;
      delAlias(a, alias);
    });
  });
};

/** 新增 / 编辑单条别名。alias 为 null 表示新增 */
function aliasForm(acct, alias, target) {
  const accounts = PAGES._aliasAccounts || [];
  const isEdit = !!alias;

  const acctOpts = accounts.map((a) =>
    '<option value="' + a.id + '"' + (acct && acct.id === a.id ? ' selected' : '') + '>' +
      esc(a.name) + ' · ' + esc(a.platform) + '</option>').join('');

  openModal(isEdit ? '编辑模型别名' : '新增模型别名',
    (isEdit || acct
      ? '<div class="form-row"><label>上游账号</label><select id="al-acct" class="mono"' +
          (isEdit ? ' disabled' : '') + '>' + acctOpts + '</select></div>'
      : '<div class="form-row"><label>上游账号</label><select id="al-acct" class="mono">' + acctOpts + '</select></div>') +
    '<div class="form-row"><label>对外别名 <span class="muted">(客户端发这个名字)</span></label>' +
      '<input id="al-alias" class="mono" value="' + esc(alias || '') + '"' + (isEdit ? ' readonly' : '') +
        ' placeholder="sensenova-glm-5.2"></div>' +
    '<div class="form-row"><label>转发给上游的名字 <span class="muted">(该上游内部叫法)</span></label>' +
      '<input id="al-target" class="mono" value="' + esc(target || '') + '" placeholder="glm-5.2"></div>' +
    '<p class="hint muted">' +
      '推荐命名: <b>平台名 + 模型 ID</b>。例: 平台 <code>sensenova</code> 的模型 <code>glm-5.2</code> ' +
      '→ 别名 <code>sensenova-glm-5.2</code>, 转发时换成上游认识的 <code>glm-5.2</code>。' +
    '</p>',
    '<button class="btn" id="m-cancel">取消</button><button class="btn primary" id="m-save">保存</button>');

  // 自动补全: 选好账号 + 填模型 ID 时, 一键给出规范别名 —— 平台名从所选账号带出
  $('#al-alias').addEventListener('focus', () => {
    if (isEdit || $('#al-alias').value.trim()) return;
    const sel = $('#al-acct');
    if (!sel) return;
    const a = accounts.find((x) => x.id === Number(sel.value));
    const t = $('#al-target').value.trim();
    if (a && t) $('#al-alias').value = suggestAlias(a.platform, t);
  });
  $('#al-target').addEventListener('input', () => {
    if (isEdit) return;
    const sel = $('#al-acct');
    if (!sel) return;
    const a = accounts.find((x) => x.id === Number(sel.value));
    const t = $('#al-target').value.trim();
    if (a && t) $('#al-alias').value = suggestAlias(a.platform, t);
  });

  $('#m-cancel').addEventListener('click', closeModal);
  $('#m-save').addEventListener('click', async () => {
    const sel = $('#al-acct');
    const accountId = sel ? Number(sel.value) : (acct ? acct.id : 0);
    const a = accounts.find((x) => x.id === accountId);
    if (!a) { toast('请选择上游账号', 'err'); return; }

    const newAlias = $('#al-alias').value.trim();
    const newTarget = $('#al-target').value.trim();
    if (!newAlias) { toast('请填写对外别名', 'err'); return; }
    if (!newTarget) { toast('请填写转发给上游的名字', 'err'); return; }

    const merged = Object.assign({}, a.model_aliases || {});
    // 编辑时别名不可改, 直接覆盖; 新增时写新键
    merged[newAlias] = newTarget;

    try {
      await api('/accounts/' + a.id, {
        method: 'PUT',
        body: JSON.stringify({ model_aliases: merged }),
      });
      closeModal(); toast('保存成功'); PAGES.aliases();
    } catch (e) { toast(e.message, 'err'); }
  });
}

function delAlias(acct, alias) {
  openModal('确认删除',
    '<p>确定删除别名 <code>' + esc(alias) + '</code> 吗?删除后客户端再发这个名字将<b>原样转发</b>给该上游。</p>',
    '<button class="btn" id="m-cancel">取消</button><button class="btn danger" id="m-del">确认删除</button>');
  $('#m-cancel').addEventListener('click', closeModal);
  $('#m-del').addEventListener('click', async () => {
    const merged = Object.assign({}, acct.model_aliases || {});
    delete merged[alias];
    try {
      await api('/accounts/' + acct.id, {
        method: 'PUT',
        body: JSON.stringify({ model_aliases: Object.keys(merged).length ? merged : null }),
      });
      closeModal(); toast('已删除'); PAGES.aliases();
    } catch (e) { toast(e.message, 'err'); }
  });
}

// ==================== 模型获取与定价 (一页两个标签) ====================
/**
 * 记住用户停在哪个标签页。
 * 保存别名 / 定价后会调 PAGES.models() 重新渲染整页, 若不记住就会把用户
 * 从「定价」弹回「别名」—— 连续改价时非常烦, 所以用模块级变量存一下。
 */
let MODELS_TAB = 'alias';

PAGES.models = async () => {
  const tok = navTok();
  $('#main').innerHTML = loadingHTML();
  // 两个标签页共用同一份数据: 别名页要 accounts, 定价页要 models。
  // 一次并行取回来, 切标签页就不再发请求了。
  const [da, dm] = await Promise.all([api('/accounts'), api('/models')]);
  if (gone(tok)) return;

  const accts = (da.accounts || []).filter((a) => a.platform);
  const tab = MODELS_TAB === 'price' ? 'price' : 'alias';

  $('#main').innerHTML =
    '<div class="page-head"><h2>模型获取与定价</h2></div>' +
    '<div class="page-tabs">' +
      '<button class="page-tab' + (tab === 'alias' ? ' active' : '') + '" data-mtab="alias">别名</button>' +
      '<button class="page-tab' + (tab === 'price' ? ' active' : '') + '" data-mtab="price">定价</button>' +
    '</div>' +
    '<div id="models-body"></div>';

  // 切标签页只重渲染正文, 不重新取数(account/model 列表已经在手上)
  const paint = (which) => {
    MODELS_TAB = which;
    document.querySelectorAll('[data-mtab]').forEach((el) => {
      el.classList.toggle('active', el.dataset.mtab === which);
    });
    if (which === 'price') modelsPricingView(accts, dm);
    else modelsAliasView(accts);
  };

  document.querySelectorAll('[data-mtab]').forEach((el) => {
    el.addEventListener('click', () => paint(el.dataset.mtab));
  });

  paint(tab);
};

/**
 * 「定价」标签页的正文。
 *
 * 用户需求(原话): 「通过上游可以直接获取上游模型, 并一键设置定价; 也可以单独设置定价;
 * 获取不到上游模型的情况, 可以手动新增定价。api 请求花费金额, 严格通过这边的定价操作」。
 * 于是这一页分三块:
 *   ① 默认单价  —— 定价表里没有单独配价的模型按它计费(可配置兜底;
 *                  代码里写死的那套内置价目表已删除, 不再参与计费)
 *   ② 从上游拉模型 + 一键定价 —— 拉回来每行预填单价, 可整批保存也可单行保存
 *   ③ 已单独定价的模型清单 —— 手动新增 / 编辑 / 删除(拉不到上游时的唯一入口)
 *
 * accts / dm 由 PAGES.models 一次性取好传进来, 切标签页不再发请求。
 */
function modelsPricingView(accts, dm) {
  const dp = dm.default_price || {};
  const bi = dm.default_price_builtin || {};
  const priced = new Map((dm.models || []).map((m) => [m.model, m]));
  const opts = accts.length
    ? accts.map((a) =>
        '<option value="' + a.id + '">' + esc(a.name) + ' · ' + esc(a.platform) + '</option>').join('')
    : '<option value="">(没有可用的上游账号)</option>';

  const listRows = priced.size
    ? (dm.models || []).map((m) =>
        '<tr>' +
          '<td class="mono">' + esc(m.model) + '</td>' +
          '<td>$' + m.input_per_mtok + '</td>' +
          '<td>$' + m.output_per_mtok + '</td>' +
          '<td><button class="btn sm" data-edit-model="' + esc(m.model) + '">编辑</button> ' +
              '<button class="btn sm danger" data-del-model="' + esc(m.model) + '">删除</button></td>' +
        '</tr>').join('')
    : '<tr><td colspan="4" class="empty">还没有单独定价的模型 —— 未配价的一律走上面的「默认单价」。</td></tr>';

  $('#models-body').innerHTML =
    // ---- ① 默认单价 ----
    '<div class="panel">' +
      '<div class="panel-title">默认单价 <span class="tag warn">未配价模型走这里</span></div>' +
      '<div class="panel-body">' +
        '<p class="hint">' +
          '下面的<b>模型定价表</b>里没有单独配价的模型, 一律按这里的单价计费 —— ' +
          '这是<b>唯一</b>的兜底口径(以前那套写死在代码里的内置价目表已不再参与计费)。' +
          '改完立即生效, 不影响已单独定价的模型。' +
        '</p>' +
        '<div class="grid2">' +
          '<div class="form-row"><label>输入价 (USD / 百万 token)</label>' +
            '<input id="pd-in" type="number" step="0.01" min="0" value="' + Number(dp.input_price || 0) + '"></div>' +
          '<div class="form-row"><label>输出价 (USD / 百万 token)</label>' +
            '<input id="pd-out" type="number" step="0.01" min="0" value="' + Number(dp.output_price || 0) + '"></div>' +
          '<div class="form-row"><label>缓存读价 (USD / 百万 token)</label>' +
            '<input id="pd-cr" type="number" step="0.01" min="0" value="' + Number(dp.cache_read_price || 0) + '"></div>' +
          '<div class="form-row"><label>缓存写价 (USD / 百万 token)</label>' +
            '<input id="pd-cw" type="number" step="0.01" min="0" value="' + Number(dp.cache_creation_price || 0) + '"></div>' +
        '</div>' +
        '<div class="panel-actions">' +
          '<button class="btn primary" id="pd-save">保存默认单价</button>' +
          '<button class="btn" id="pd-reset">还原出厂默认 (' +
            Number(bi.input_price || 0) + ' / ' + Number(bi.output_price || 0) + ')</button>' +
        '</div>' +
      '</div>' +
    '</div>' +
    // ---- ② 从上游拉模型 + 一键定价 ----
    '<div class="panel">' +
      '<div class="panel-title">从上游获取模型 · 一键设置定价</div>' +
      '<div class="panel-body">' +
        '<p class="hint">' +
          '选一个上游账号, 拉取它<b>实际提供</b>的模型列表。拉回来后每个模型都预填好单价 ' +
          '(已配价的用现价, 没配的用上面的默认单价) —— 点「一键设置定价」整批写入; ' +
          '也可以只改其中几行, 逐行点「保存」。' +
          '请求地址取该账号配置的 <b>Base URL</b>(第三方中转); 只有没配 Base URL 时才用官方默认域名。' +
        '</p>' +
        '<div class="form-row" style="max-width:560px">' +
          '<label>选择上游账号</label>' +
          '<select id="m-acct" class="mono">' + opts + '</select>' +
        '</div>' +
        '<div class="panel-actions">' +
          '<button class="btn primary" id="m-fetch">获取上游模型</button>' +
          '<button class="btn" id="m-apply" style="display:none">一键设置定价(全部)</button>' +
          '<button class="btn" id="m-fill" style="display:none">全部套用默认单价</button>' +
        '</div>' +
      '</div>' +
      '<div id="m-body" class="result-body"></div>' +
    '</div>' +
    // ---- ③ 已定价模型(手动新增/编辑/删除) ----
    '<div class="panel">' +
      '<div class="panel-title">已单独定价的模型 (共 ' + priced.size + ' 个)' +
        '<button class="btn sm primary" id="p-new" style="margin-left:auto">手动新增定价</button>' +
      '</div>' +
      '<div class="table-wrap"><table>' +
        '<thead><tr><th>模型</th><th>输入价</th><th>输出价</th><th>操作</th></tr></thead>' +
        '<tbody>' + listRows + '</tbody>' +
      '</table></div>' +
    '</div>';

  const defVal = (k) => Number(dp[k] || 0);

  // ===== ① 默认单价 =====
  $('#pd-save').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true; btn.textContent = '保存中…';
    try {
      await api('/models', {
        method: 'PUT',
        body: JSON.stringify({
          default_price: {
            input_price: Number($('#pd-in').value || 0),
            output_price: Number($('#pd-out').value || 0),
            cache_read_price: Number($('#pd-cr').value || 0),
            cache_creation_price: Number($('#pd-cw').value || 0),
          },
        }),
      });
      toast('默认单价已保存');
      MODELS_TAB = 'price'; PAGES.models();
    } catch (err) {
      toast(err.message, 'err');
      btn.disabled = false; btn.textContent = '保存默认单价';
    }
  });

  $('#pd-reset').addEventListener('click', () => {
    $('#pd-in').value = Number(bi.input_price || 0);
    $('#pd-out').value = Number(bi.output_price || 0);
    $('#pd-cr').value = Number(bi.cache_read_price || 0);
    $('#pd-cw').value = Number(bi.cache_creation_price || 0);
    toast('已填入出厂默认值, 记得点「保存默认单价」');
  });

  // ===== ② 从上游拉模型 =====
  // 每行的缓存读写价藏在 data-cr / data-cw 上(不占表格列宽), 回写时原样带回,
  // 避免"批量套用默认价"把某模型已单独配过的缓存价冲掉。
  const collectRows = () => {
    const out = [];
    document.querySelectorAll('.m-in').forEach((el) => {
      const model = el.dataset.mid;
      if (!model) return;
      const outEl = document.querySelector('.m-out[data-mid="' + CSS.escape(model) + '"]');
      out.push({
        model,
        input_price: Number(el.value || 0),
        output_price: Number(outEl ? outEl.value : 0),
        cache_read_price: Number(el.dataset.cr || 0),
        cache_creation_price: Number(el.dataset.cw || 0),
      });
    });
    return out;
  };

  const saveBatch = async (items, btn, label) => {
    if (!items.length) { toast('没有可保存的行', 'err'); return; }
    btn.disabled = true; const old = btn.textContent; btn.textContent = '保存中…';
    try {
      await api('/models', { method: 'PUT', body: JSON.stringify({ models: items }) });
      toast('已保存 ' + items.length + ' 个模型的定价');
      MODELS_TAB = 'price'; PAGES.models();
    } catch (err) {
      toast(err.message, 'err');
      btn.disabled = false; btn.textContent = old || label;
    }
  };

  $('#m-fetch').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    const id = Number($('#m-acct').value);
    const acct = accts.find((a) => a.id === id);
    $('#m-apply').style.display = 'none';
    $('#m-fill').style.display = 'none';
    if (!acct) { toast('请先选择一个上游账号', 'err'); return; }
    btn.disabled = true; btn.textContent = '获取中…';
    $('#m-body').innerHTML = '<div class="empty">请求上游中…</div>';
    try {
      const r = await api('/accounts/' + id + '/models');
      const head =
        '<div class="muted" style="font-size:12px;line-height:1.9;margin-bottom:14px">' +
          '账号 <b>' + esc(acct.name) + '</b> · 平台 <span class="tag off">' + esc(acct.platform) + '</span>' +
          ' · 请求地址 <code>' + esc(r.base_url || acct.effective_base_url || '-') + '</code>' +
          (r.latency_ms ? ' · 耗时 ' + r.latency_ms + 'ms' : '') +
        '</div>';

      if (!r.ok || !(r.models || []).length) {
        $('#m-body').innerHTML = head +
          '<div class="panel" style="border:1px solid var(--danger)">' +
            '<div style="padding:14px 16px;color:var(--danger);font-size:13px;line-height:1.8">' +
              esc(r.message || '获取失败') +
            '</div>' +
          '</div>' +
          '<p class="hint" style="margin:14px 0 0">' +
            '拉不到不代表账号不可用 —— 有些上游压根没实现列模型接口。' +
            '这时请用上方「手动新增定价」逐个模型补价。' +
          '</p>';
        return;
      }

      const rows = r.models.map((mid) => {
        const cur = priced.get(mid);
        const inP = cur ? Number(cur.input_per_mtok) : defVal('input_price');
        const outP = cur ? Number(cur.output_per_mtok) : defVal('output_price');
        const cr = cur ? Number(cur.cache_read_price || 0) : defVal('cache_read_price');
        const cw = cur ? Number(cur.cache_creation_price || 0) : defVal('cache_creation_price');
        const st = cur
          ? '<span class="tag ok">已定价</span>'
          : '<span class="tag warn">未定价 · 预填默认价</span>';
        return '<tr>' +
          '<td class="mono">' + esc(mid) + '</td>' +
          '<td>' + st + '</td>' +
          '<td><input class="m-in" data-mid="' + esc(mid) + '" data-cr="' + cr + '" data-cw="' + cw + '"' +
            ' type="number" step="0.01" min="0" value="' + inP + '" style="width:110px"></td>' +
          '<td><input class="m-out" data-mid="' + esc(mid) + '"' +
            ' type="number" step="0.01" min="0" value="' + outP + '" style="width:110px"></td>' +
          '<td><button class="btn sm" data-save-one="' + esc(mid) + '">保存</button></td>' +
        '</tr>';
      }).join('');

      $('#m-body').innerHTML = head +
        '<div class="panel"><div class="panel-title">共 ' + r.models.length + ' 个模型 · 单价单位 USD / 百万 token</div>' +
        '<div class="table-wrap"><table><thead><tr>' +
          '<th>模型</th><th>当前状态</th><th>输入价</th><th>输出价</th><th>操作</th>' +
        '</tr></thead><tbody>' + rows + '</tbody></table></div></div>';

      $('#m-apply').style.display = 'inline-block';
      $('#m-fill').style.display = 'inline-block';

      // 逐行保存 = 「单独设置定价」
      document.querySelectorAll('[data-save-one]').forEach((el) => {
        el.addEventListener('click', () => {
          const one = collectRows().filter((x) => x.model === el.dataset.saveOne);
          saveBatch(one, el, '保存');
        });
      });
    } catch (err) {
      $('#m-body').innerHTML = '<div class="empty" style="color:var(--danger)">' + esc(err.message) + '</div>';
    } finally {
      btn.disabled = false; btn.textContent = '获取上游模型';
    }
  });

  $('#m-apply').addEventListener('click', (e) => saveBatch(collectRows(), e.currentTarget, '一键设置定价(全部)'));

  $('#m-fill').addEventListener('click', () => {
    document.querySelectorAll('.m-in').forEach((el) => { el.value = defVal('input_price'); });
    document.querySelectorAll('.m-out').forEach((el) => { el.value = defVal('output_price'); });
    toast('已把全部输入框填成默认单价, 点「一键设置定价」写入');
  });

  // ===== ③ 手动新增 / 编辑 / 删除 =====
  $('#p-new').addEventListener('click', () => modelForm(null));
  document.querySelectorAll('[data-edit-model]').forEach((el) => {
    el.addEventListener('click', () => {
      const m = (dm.models || []).find((x) => x.model === el.dataset.editModel);
      modelForm(m);
    });
  });
  document.querySelectorAll('[data-del-model]').forEach((el) => {
    el.addEventListener('click', () => {
      const model = el.dataset.delModel;
      openModal('确认删除定价',
        '<p>确定删除模型 <code>' + esc(model) + '</code> 的定价吗?删除后它会回落到<b>默认单价</b>计费。</p>',
        '<button class="btn" id="m-cancel">取消</button><button class="btn danger" id="m-del">确认删除</button>');
      $('#m-cancel').addEventListener('click', closeModal);
      $('#m-del').addEventListener('click', async () => {
        try {
          await api('/models', { method: 'DELETE', body: JSON.stringify({ model }) });
          closeModal(); toast('已删除');
          MODELS_TAB = 'price'; PAGES.models();
        } catch (err) { toast(err.message, 'err'); }
      });
    });
  });
}

function modelForm(m) {
  const isEdit = !!m;
  openModal(isEdit ? '编辑模型定价' : '新增模型定价',
    '<div class="form-row"><label>模型名</label><input id="p-model" class="mono" value="' + esc(isEdit ? m.model : '') + '"' +
      (isEdit ? ' readonly' : '') + ' placeholder="gpt-4o"></div>' +
    '<div class="grid2">' +
      '<div class="form-row"><label>输入价 (USD/百万 token)</label><input id="p-in" type="number" step="0.01" min="0" value="' + (isEdit ? m.input_per_mtok : 0) + '"></div>' +
      '<div class="form-row"><label>输出价 (USD/百万 token)</label><input id="p-out" type="number" step="0.01" min="0" value="' + (isEdit ? m.output_per_mtok : 0) + '"></div>' +
      '<div class="form-row"><label>缓存读价 (USD/百万 token)</label><input id="p-cr" type="number" step="0.01" min="0" value="' + (isEdit ? Number(m.cache_read_price || 0) : 0) + '"></div>' +
      '<div class="form-row"><label>缓存写价 (USD/百万 token)</label><input id="p-cw" type="number" step="0.01" min="0" value="' + (isEdit ? Number(m.cache_creation_price || 0) : 0) + '"></div>' +
    '</div>' +
    '<p class="hint muted">换算关系: 数据库按"微美元/token"存储, 这里输入的是最常见的"美元/百万 token", 两者数值相同。留空的模型按「默认单价」计费。</p>',
    '<button class="btn" id="m-cancel">取消</button><button class="btn primary" id="m-save">保存</button>');

  $('#m-cancel').addEventListener('click', closeModal);
  $('#m-save').addEventListener('click', async () => {
    try {
      await api('/models', {
        method: 'PUT',
        body: JSON.stringify({
          model: $('#p-model').value.trim(),
          input_price: Number($('#p-in').value || 0),
          output_price: Number($('#p-out').value || 0),
          cache_read_price: Number($('#p-cr').value || 0),
          cache_creation_price: Number($('#p-cw').value || 0),
        }),
      });
      closeModal(); toast('保存成功');
      MODELS_TAB = 'price'; PAGES.models();
    } catch (e) { toast(e.message, 'err'); }
  });
}

// ======================= 请求日志 =======================
const fmtPct = (v) => (Number(v || 0) * 100).toFixed(2) + '%';

// 可选列(fixed=常显不可隐藏)
const USAGE_COLS = [
  { key: 'time',     label: '时间 (UTC+8)', fixed: true },
  { key: 'status',   label: '状态' },
  { key: 'model',    label: '模型' },
  { key: 'user',     label: '用户' },
  { key: 'balance',  label: '额度剩余' },
  { key: 'key',      label: 'API Key' },
  { key: 'keyQuota', label: 'Key 额度' },
  { key: 'group',    label: '分组' },
  { key: 'account',  label: '上游账号' },
  { key: 'input',    label: '输入' },
  { key: 'output',   label: '输出' },
  { key: 'cache',    label: '缓存读/写' },
  { key: 'cost',     label: '花费' },
  { key: 'rate',     label: '倍率' },
  { key: 'stream',   label: '类型' },
  { key: 'duration', label: '耗时' },
  { key: 'firstTok', label: '首字' },
  { key: 'ip',       label: 'IP' },
];
// 默认隐藏的次要列
const USAGE_HIDDEN = { cache: 1, rate: 1, firstTok: 1, ip: 1 };

const usageState = {
  page: 1,
  pageSize: 50,
  filters: {
    user_id: '', api_key_id: '', group_id: '', account_id: '',
    model: '', status: '', start: '', end: '', keyword: '',
  },
  facets: null,
  data: null,
  cols: {},
};
USAGE_COLS.forEach((c) => { usageState.cols[c.key] = !USAGE_HIDDEN[c.key]; });

function usageQuery() {
  const f = usageState.filters;
  const p = new URLSearchParams();
  p.set('limit', String(usageState.pageSize));
  p.set('offset', String((usageState.page - 1) * usageState.pageSize));
  ['user_id', 'api_key_id', 'group_id', 'account_id', 'model', 'status', 'start', 'end', 'keyword']
    .forEach((k) => { if (f[k]) p.set(k, f[k]); });
  // 下拉候选值只在首次加载时取一次, 之后复用缓存
  if (!usageState.facets) p.set('facets', '1');
  return '/usage?' + p.toString();
}

async function usageLoad() {
  const tok = navTok();
  const d = await api(usageQuery());
  // 等待期间用户可能已经点了别的菜单 —— 这时再调 usageRender() 会把旧页面
  // 画到新页面上(地址栏是新的、内容是旧的), 所以直接放弃这次渲染。
  if (gone(tok)) return;
  usageState.data = d;
  if (d.filters) usageState.facets = d.filters;
  usageRender();
}

function usageCell(col, l) {
  switch (col) {
    case 'time':
      return '<td class="muted" title="' + esc(l.created_at) + '">' + fmtTime(l.created_at) + '</td>';
    case 'status':
      return l.status === 'error'
        ? '<td><span class="tag err">失败</span>' +
            (l.error && l.error.status ? ' <span class="mono muted">' + l.error.status + '</span>' : '') + '</td>'
        : '<td><span class="tag ok">成功</span></td>';
    case 'model':
      return '<td class="mono">' + esc(l.model || l.requested_model || '-') + '</td>';
    case 'user':
      return '<td>' + (l.user_email ? esc(l.user_email) : '<span class="muted">#' + l.user_id + '</span>') + '</td>';
    case 'balance':
      return '<td>' + (l.user_balance == null ? '<span class="muted">-</span>' : fmtMoney2(l.user_balance)) + '</td>';
    case 'key':
      return '<td>' + (l.key_name ? esc(l.key_name) : '<span class="muted">#' + l.api_key_id + '</span>') + '</td>';
    case 'keyQuota':
      return '<td>' + (l.key_quota > 0
        ? fmtMoney2(l.key_quota_used) + ' / ' + fmtMoney2(l.key_quota)
        : '<span class="muted">不限</span>') + '</td>';
    case 'group':
      return '<td>' + (l.group_name ? esc(l.group_name) : '<span class="muted">-</span>') + '</td>';
    case 'account':
      return '<td>' + (l.account_name ? esc(l.account_name) : '<span class="muted">-</span>') + '</td>';
    case 'input':
      return '<td>' + fmtNum(l.input_tokens) + '</td>';
    case 'output':
      return '<td>' + fmtNum(l.output_tokens) + '</td>';
    case 'cache':
      return '<td>' + fmtNum(l.cache_read_tokens) + ' / ' + fmtNum(l.cache_creation_tokens) + '</td>';
    case 'cost':
      return '<td>' + (l.status === 'error' ? '<span class="muted">-</span>' : fmtMoney(l.actual_cost)) + '</td>';
    case 'rate':
      return '<td>' + Number(l.rate_multiplier || 0).toFixed(2) + 'x</td>';
    case 'stream':
      return '<td>' + (l.stream ? '<span class="tag off">流式</span>' : '<span class="tag off">非流式</span>') + '</td>';
    case 'duration':
      return '<td class="muted">' + (l.duration_ms ? l.duration_ms + 'ms' : '-') + '</td>';
    case 'firstTok':
      return '<td class="muted">' + (l.first_token_ms ? l.first_token_ms + 'ms' : '-') + '</td>';
    case 'ip':
      return '<td class="muted mono">' + esc(l.ip_address || '-') + '</td>';
    default:
      return '<td></td>';
  }
}

function usageDetail(l) {
  const kv = (k, v) => '<div class="kk">' + esc(k) + '</div><div class="vv">' + v + '</div>';
  const body =
    '<div class="kv-title">基本信息</div><div class="kv">' +
      kv('请求 ID', '<span class="mono">' + esc(l.request_id) + '</span>') +
      kv('时间', fmtTime(l.created_at)) +
      kv('状态', l.status === 'error' ? '<span class="tag err">失败</span>' : '<span class="tag ok">成功</span>') +
      kv('模型', '<span class="mono">' + esc(l.model || '-') + '</span>') +
      kv('请求模型', '<span class="mono">' + esc(l.requested_model || '-') + '</span>') +
      kv('上游模型', '<span class="mono">' + esc(l.upstream_model || '-') + '</span>') +
      kv('类型', l.stream ? '流式' : '非流式') +
      kv('耗时', l.duration_ms ? l.duration_ms + ' ms' : '-') +
      kv('首字延迟', l.first_token_ms ? l.first_token_ms + ' ms' : '-') +
      kv('IP', esc(l.ip_address || '-')) +
      kv('User-Agent', '<span class="mono">' + esc(l.user_agent || '-') + '</span>') +
    '</div>' +
    '<div class="kv-title">用户 / 配额</div><div class="kv">' +
      kv('用户', esc(l.user_email || ('#' + l.user_id)) + (l.user_name ? ' (' + esc(l.user_name) + ')' : '')) +
      kv('余额剩余', l.user_balance == null ? '-' : fmtMoney2(l.user_balance)) +
      kv('用户状态', esc(l.user_status || '-')) +
      kv('API Key', esc(l.key_name || ('#' + l.api_key_id))) +
      kv('Key 额度', l.key_quota > 0 ? fmtMoney2(l.key_quota_used) + ' / ' + fmtMoney2(l.key_quota) : '不限') +
      kv('分组', esc(l.group_name || '-')) +
      kv('上游账号', esc(l.account_name || '-') + (l.account_platform ? ' (' + esc(l.account_platform) + ')' : '')) +
    '</div>' +
    '<div class="kv-title">用量 / 计费</div><div class="kv">' +
      kv('输入 Token', fmtNum(l.input_tokens)) +
      kv('输出 Token', fmtNum(l.output_tokens)) +
      kv('缓存读 Token', fmtNum(l.cache_read_tokens)) +
      kv('缓存写 Token', fmtNum(l.cache_creation_tokens)) +
      kv('计费模式', esc(l.billing_mode || '-')) +
      kv('原价', fmtMoney(l.total_cost)) +
      kv('实际花费', fmtMoney(l.actual_cost)) +
      kv('倍率', Number(l.rate_multiplier || 0).toFixed(2) + 'x') +
    '</div>' +
    (l.error
      ? '<div class="kv-title">错误</div><div class="kv">' +
          kv('上游平台', esc(l.error.platform || '-')) +
          kv('状态码', String(l.error.status || '-')) +
          kv('原因', '<span class="wrap">' + esc(l.error.message || '-') + '</span>') +
        '</div>'
      : '');

  openModal('请求详情', body, '<button class="btn" id="d-close">关闭</button>');
  $('#d-close').addEventListener('click', closeModal);
}

function usageColsModal() {
  const items = USAGE_COLS.map((c) =>
    '<label><input type="checkbox" data-col="' + c.key + '"' +
      (usageState.cols[c.key] ? ' checked' : '') + (c.fixed ? ' disabled' : '') + '> ' + esc(c.label) + '</label>'
  ).join('');
  openModal('列设置', '<div class="cols-grid">' + items + '</div>',
    '<button class="btn" id="c-close">取消</button><button class="btn primary" id="c-save">应用</button>');
  $('#c-close').addEventListener('click', closeModal);
  $('#c-save').addEventListener('click', () => {
    document.querySelectorAll('#modal input[data-col]').forEach((el) => {
      usageState.cols[el.dataset.col] = el.checked;
    });
    closeModal();
    usageRender();
  });
}

/**
 * 批量删除的共用逻辑 —— 「请求日志」和「操作审计」两个页面都用它。
 *
 * 由调用方在**表格渲染完成之后**调用(它要查询 DOM 里的复选框), 负责:
 *   ① 表头「全选本页」↔ 行复选框 双向联动(全选态/半选态)
 *   ② 顶部删除按钮的可用状态 + 已选条数回显
 *   ③ 点删除 → **先弹窗确认**(用户明确要求) → DELETE → 刷新
 *
 * 为什么删除一定要弹窗 + 为什么只有超管看得到按钮:
 *   日志是"事后追责"的唯一依据, 删掉不可逆。按钮在超管之外不渲染(IS_ADMIN),
 *   后端也会再卡一次 auth.admin.is_admin —— 前端只是省掉"点了才知道没权限"。
 *
 * @param o.rowSel  行复选框选择器, 如 '.u-row'
 * @param o.allSel  表头全选选择器
 * @param o.btnSel  删除按钮选择器
 * @param o.endpoint '/usage' | '/audit'
 * @param o.reload   删除成功后的刷新函数
 */
function bindBatchDelete(o) {
  const all = () => Array.prototype.slice.call(document.querySelectorAll(o.rowSel));
  const picked = () => all().filter((el) => el.checked).map((el) => Number(el.dataset.id));

  const sync = () => {
    const els = all();
    const sel = picked();
    const box = $(o.allSel);
    const btn = $(o.btnSel);
    if (box) {
      box.checked = els.length > 0 && sel.length === els.length;
      box.indeterminate = sel.length > 0 && sel.length < els.length;
    }
    if (btn) {
      btn.disabled = sel.length === 0;
      btn.textContent = sel.length ? '删除选中 (' + sel.length + ')' : '删除选中';
    }
  };

  const box = $(o.allSel);
  if (box) {
    box.addEventListener('change', () => {
      all().forEach((el) => { el.checked = box.checked; });
      sync();
    });
  }
  all().forEach((el) => el.addEventListener('change', sync));

  const btn = $(o.btnSel);
  if (btn) {
    btn.addEventListener('click', () => {
      const ids = picked();
      if (!ids.length) return;
      // 🚨 用户明确要求: 点删除之后必须弹窗确认, 不能直接删
      openModal('确认删除',
        '<p>确定删除选中的 <b>' + ids.length + '</b> 条记录吗?</p>' +
        '<p class="hint muted" style="margin:8px 0 0">删除后不可恢复, 且删除动作本身会记入操作审计。</p>',
        '<button class="btn" id="m-cancel">取消</button><button class="btn danger" id="m-del">确认删除</button>');
      $('#m-cancel').addEventListener('click', closeModal);
      $('#m-del').addEventListener('click', async () => {
        const b = $('#m-del');
        b.disabled = true; b.textContent = '删除中…';
        try {
          const r = await api(o.endpoint, { method: 'DELETE', body: JSON.stringify({ ids }) });
          closeModal();
          toast('已删除 ' + (r && r.deleted != null ? r.deleted : ids.length) + ' 条记录');
          o.reload();
        } catch (e) {
          toast(e.message, 'err');
          b.disabled = false; b.textContent = '确认删除';
        }
      });
    });
  }

  sync();
}

function usageRender() {
  const d = usageState.data;
  if (!d) return;
  const s = d.stats || {};
  const f = usageState.facets || {};
  const filters = usageState.filters;
  // 删除是超管专属(后端也卡了 is_admin, 这里只是"看不见按钮")
  const canDel = IS_ADMIN;

  // ---- 顶部统计 ----
  const cards =
    '<div class="cards">' +
      card('请求总数', fmtNum(s.total) + ' <small>失败 ' + fmtNum(s.errors) + '</small>') +
      card('成功率', fmtPct(s.success_rate)) +
      card('输入 Token', fmtNum(s.input_tokens)) +
      card('输出 Token', fmtNum(s.output_tokens)) +
      card('缓存读 / 写', fmtNum(s.cache_read_tokens) + ' <small>/ ' + fmtNum(s.cache_creation_tokens) + '</small>') +
      card('花费(实际)', fmtMoney(s.actual_cost) + ' <small>原价 ' + fmtMoney(s.total_cost) + '</small>') +
      card('平均耗时', fmtNum(s.avg_duration_ms) + ' <small>ms</small>') +
      card('流式请求', fmtNum(s.stream_requests)) +
    '</div>';

  // ---- 筛选条 ----
  const o = (v, label, cur) =>
    '<option value="' + esc(v) + '"' + (String(cur) === String(v) ? ' selected' : '') + '>' + esc(label) + '</option>';
  let userOpts = o('', '全部用户', filters.user_id);
  (f.users || []).forEach((u) => {
    userOpts += o(u.id, (u.email || ('#' + u.id)) + ' (' + fmtMoney2(u.balance) + ')', filters.user_id);
  });
  let keyOpts = o('', '全部 Key', filters.api_key_id);
  (f.keys || []).forEach((k) => { keyOpts += o(k.id, k.name || ('Key #' + k.id), filters.api_key_id); });
  let groupOpts = o('', '全部分组', filters.group_id);
  (f.groups || []).forEach((x) => { groupOpts += o(x.id, x.name || ('#' + x.id), filters.group_id); });
  let acctOpts = o('', '全部账号', filters.account_id);
  (f.accounts || []).forEach((x) => {
    acctOpts += o(x.id, (x.name || ('#' + x.id)) + (x.platform ? ' · ' + x.platform : ''), filters.account_id);
  });
  let modelOpts = o('', '全部模型', filters.model);
  (f.models || []).forEach((m) => { modelOpts += o(m, m, filters.model); });
  const statusOpts = o('', '全部状态', filters.status) + o('success', '成功', filters.status) + o('error', '失败', filters.status);

  const filterBar =
    '<div class="filter-bar">' +
      '<div class="filter-item"><label>用户</label><select id="f-user">' + userOpts + '</select></div>' +
      '<div class="filter-item"><label>API Key</label><select id="f-key">' + keyOpts + '</select></div>' +
      '<div class="filter-item"><label>分组</label><select id="f-group">' + groupOpts + '</select></div>' +
      '<div class="filter-item"><label>上游账号</label><select id="f-account">' + acctOpts + '</select></div>' +
      '<div class="filter-item"><label>模型</label><select id="f-model">' + modelOpts + '</select></div>' +
      '<div class="filter-item"><label>状态</label><select id="f-status">' + statusOpts + '</select></div>' +
      '<div class="filter-item date"><label>开始日期</label><input id="f-start" type="date" value="' + esc(filters.start) + '"></div>' +
      '<div class="filter-item date"><label>结束日期</label><input id="f-end" type="date" value="' + esc(filters.end) + '"></div>' +
      '<div class="filter-item wide"><label>关键词</label><input id="f-keyword" placeholder="请求 ID / 邮箱 / Key 名" value="' + esc(filters.keyword) + '"></div>' +
      '<div class="filter-actions">' +
        '<button class="btn primary" id="f-apply">查询</button>' +
        '<button class="btn" id="f-reset">重置</button>' +
      '</div>' +
    '</div>';

  // ---- 表格 ----
  const cols = USAGE_COLS.filter((c) => c.fixed || usageState.cols[c.key]);
  const delTh = canDel ? '<th class="col-sel"><input type="checkbox" id="u-all" title="全选本页"></th>' : '';
  const head = delTh + cols.map((c) => '<th>' + esc(c.label) + '</th>').join('') + '<th>操作</th>';
  const logs = d.logs || [];
  const tbody = logs.length
    ? logs.map((l, i) =>
        '<tr>' + (canDel
          ? '<td class="col-sel"><input type="checkbox" class="u-row" data-id="' + esc(l.id) + '"></td>'
          : '') +
        cols.map((c) => usageCell(c.key, l)).join('') +
          '<td><button class="btn sm" data-detail="' + i + '">详情</button></td></tr>'
      ).join('')
    : '<tr><td colspan="' + (cols.length + 1 + (canDel ? 1 : 0)) + '" class="empty">没有符合条件的请求记录</td></tr>';

  const pageCount = Math.max(Math.ceil(d.total / usageState.pageSize), 1);
  const pager =
    '<div class="pager">' +
      '<span>共 ' + fmtNum(d.total) + ' 条</span>' +
      '<span>第 ' + usageState.page + ' / ' + pageCount + ' 页</span>' +
      '<select id="p-size">' +
        [20, 50, 100, 200].map((n) =>
          '<option value="' + n + '"' + (usageState.pageSize === n ? ' selected' : '') + '>' + n + ' 条/页</option>'
        ).join('') +
      '</select>' +
      '<button class="btn sm" id="p-prev"' + (usageState.page <= 1 ? ' disabled' : '') + '>上一页</button>' +
      '<button class="btn sm" id="p-next"' + (usageState.page >= pageCount ? ' disabled' : '') + '>下一页</button>' +
    '</div>';

  $('#main').innerHTML =
    '<div class="page-head"><h2>请求日志</h2><div class="actions">' +
      (canDel ? '<button class="btn danger" id="btn-del" disabled>删除选中</button>' : '') +
      '<button class="btn" id="btn-cols">列设置</button>' +
      '<button class="btn" id="btn-refresh">刷新</button>' +
    '</div></div>' +
    cards + filterBar +
    '<div class="panel"><div class="table-wrap"><table><thead><tr>' + head + '</tr></thead>' +
      '<tbody>' + tbody + '</tbody></table></div>' + pager + '</div>';

  // ---- 事件绑定 ----
  const reload = (fn) => { fn(); usageLoad().catch((e) => toast(e.message, 'err')); };
  const readFilters = () => {
    filters.user_id = $('#f-user').value;
    filters.api_key_id = $('#f-key').value;
    filters.group_id = $('#f-group').value;
    filters.account_id = $('#f-account').value;
    filters.model = $('#f-model').value;
    filters.status = $('#f-status').value;
    filters.start = $('#f-start').value;
    filters.end = $('#f-end').value;
    filters.keyword = $('#f-keyword').value.trim();
  };

  $('#f-apply').addEventListener('click', () => reload(() => { readFilters(); usageState.page = 1; }));
  $('#f-reset').addEventListener('click', () => {
    Object.keys(filters).forEach((k) => { filters[k] = ''; });
    reload(() => { usageState.page = 1; });
  });
  $('#f-keyword').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#f-apply').click(); });
  $('#btn-refresh').addEventListener('click', () => reload(() => {}));
  $('#btn-cols').addEventListener('click', usageColsModal);
  $('#p-prev').addEventListener('click', () => reload(() => { usageState.page = Math.max(usageState.page - 1, 1); }));
  $('#p-next').addEventListener('click', () => reload(() => { usageState.page += 1; }));
  $('#p-size').addEventListener('change', () => reload(() => {
    usageState.pageSize = Number($('#p-size').value) || 50;
    usageState.page = 1;
  }));

  const tb = $('#main tbody');
  if (tb) {
    tb.addEventListener('click', (e) => {
      const b = e.target.closest('button[data-detail]');
      if (!b) return;
      const l = (usageState.data.logs || [])[Number(b.dataset.detail)];
      if (l) usageDetail(l);
    });
  }

  // 多选 / 全选 / 确认弹窗删除 —— 只有超管才有这些控件
  if (canDel) {
    bindBatchDelete({
      rowSel: '.u-row', allSel: '#u-all', btnSel: '#btn-del',
      endpoint: '/usage',
      // 删完重取当前页(删空了服务端会退页, 这里直接重渲染一次即可)
      reload: () => { usageLoad().catch((e) => toast(e.message, 'err')); },
    });
  }
}

PAGES.usage = async () => {
  const tok = navTok();
  $('#main').innerHTML = loadingHTML();
  try {
    await usageLoad();
  } catch (e) {
    if (gone(tok)) return;
    $('#main').innerHTML = '<div class="empty">加载失败: ' + esc(e.message) + '</div>';
  }
};

// ======================= 审计 =======================
// 分页状态: 和「请求日志」页同一套路 —— 只重渲染内容区, 不整页重来。
// 页码放这里而不是函数局部变量, 是为了「刷新」和翻页后保持在同一页。
const AUDIT_PAGE_SIZES = [20, 50, 100, 200];
const auditState = { page: 1, pageSize: 50, data: null };

async function auditLoad() {
  const offset = (auditState.page - 1) * auditState.pageSize;
  auditState.data = await api('/audit?limit=' + auditState.pageSize + '&offset=' + offset);
}

/**
 * 拉一页审计日志, 并保证不会停在空页上。
 * 记录被清理后 total 会变小, 上一页可能是最后一页之后的空白页 ——
 * 这是最容易让人觉得"页面坏了"的情形, 所以退到最后一页重取一次(只退一次)。
 */
async function auditFetch() {
  await auditLoad();
  const total = Number(auditState.data && auditState.data.total) || 0;
  const pageCount = Math.max(Math.ceil(total / auditState.pageSize), 1);
  if (auditState.page > pageCount) {
    auditState.page = pageCount;
    await auditLoad();
  }
}

/** 翻页 / 改每页条数 / 刷新 —— 统一入口, 每次都重新问服务端要(审计表可能很大, 不能全拉下来本地切片) */
async function auditGo(patch) {
  const tok = navTok();
  Object.assign(auditState, patch);
  const pv = $('#a-prev'), nx = $('#a-next');
  if (pv) pv.disabled = true;
  if (nx) nx.disabled = true;
  try {
    await auditFetch();
  } catch (e) {
    if (!gone(tok)) toast(e.message, 'err');
    return;
  }
  if (gone(tok)) return;
  auditRender();
}

function auditRender() {
  const d = auditState.data || {};
  const logs = d.logs || [];
  const total = Number(d.total) || 0;
  const pageCount = Math.max(Math.ceil(total / auditState.pageSize), 1);
  // 删除是超管专属(后端 getAudit 的 DELETE 分支也卡了 is_admin)
  const canDel = IS_ADMIN;

  const rows = logs.length ? logs.map((l) =>
    '<tr>' +
      (canDel ? '<td class="col-sel"><input type="checkbox" class="a-row" data-id="' + esc(l.id) + '"></td>' : '') +
      '<td class="muted">' + fmtTime(l.created_at) + '</td>' +
      '<td>' + esc(l.admin_name) + '</td>' +
      '<td><span class="tag off">' + esc(l.action) + '</span></td>' +
      '<td>' + esc(l.resource) + ' #' + esc(l.resource_id) + '</td>' +
      '<td class="wrap muted">' + esc(l.detail || '-') + '</td>' +
      '<td class="muted">' + esc(l.ip || '-') + '</td>' +
    '</tr>'
  ).join('') : '<tr><td colspan="' + (6 + (canDel ? 1 : 0)) + '" class="empty">' +
      (total ? '本页没有记录' : '还没有操作记录') + '</td></tr>';

  const pager =
    '<div class="pager">' +
      '<span>共 ' + fmtNum(total) + ' 条</span>' +
      '<span>第 ' + auditState.page + ' / ' + pageCount + ' 页</span>' +
      '<select id="a-size">' +
        AUDIT_PAGE_SIZES.map((n) =>
          '<option value="' + n + '"' + (auditState.pageSize === n ? ' selected' : '') + '>' + n + ' 条/页</option>'
        ).join('') +
      '</select>' +
      '<button class="btn sm" id="a-prev"' + (auditState.page <= 1 ? ' disabled' : '') + '>上一页</button>' +
      '<button class="btn sm" id="a-next"' + (auditState.page >= pageCount ? ' disabled' : '') + '>下一页</button>' +
    '</div>';

  $('#main').innerHTML =
    '<div class="page-head"><h2>操作审计</h2><div class="actions">' +
      (canDel ? '<button class="btn danger" id="btn-del" disabled>删除选中</button>' : '') +
      '<button class="btn" id="btn-refresh">刷新</button></div></div>' +
    '<div class="panel"><div class="table-wrap"><table><thead><tr>' +
      (canDel ? '<th class="col-sel"><input type="checkbox" id="a-all" title="全选本页"></th>' : '') +
      '<th>时间 (UTC+8)</th><th>操作人</th><th>动作</th><th>对象</th><th>详情</th><th>IP</th>' +
    '</tr></thead><tbody>' + rows + '</tbody></table></div>' + pager + '</div>';

  $('#btn-refresh').addEventListener('click', () => auditGo({}));
  $('#a-prev').addEventListener('click', () => auditGo({ page: Math.max(auditState.page - 1, 1) }));
  $('#a-next').addEventListener('click', () => auditGo({ page: auditState.page + 1 }));
  $('#a-size').addEventListener('change', () => auditGo({
    pageSize: Number($('#a-size').value) || 50,
    // 每页条数一变, 原来的第 N 页就没意义了, 统一回到第一页
    page: 1,
  }));

  // 多选 / 全选 / 确认弹窗删除 —— 只有超管才有这些控件
  if (canDel) {
    bindBatchDelete({
      rowSel: '.a-row', allSel: '#a-all', btnSel: '#btn-del',
      endpoint: '/audit',
      // 删完可能落在空页上, 走 auditGo({}) 会重新算页数并退到最后一页
      reload: () => { auditGo({}); },
    });
  }
}

PAGES.audit = async () => {
  const tok = navTok();
  $('#main').innerHTML = loadingHTML();
  try {
    await auditFetch();
  } catch (e) {
    if (gone(tok)) return;
    $('#main').innerHTML = '<div class="empty">加载失败: ' + esc(e.message) + '</div>';
    return;
  }
  if (gone(tok)) return;
  auditRender();
};

// ======================= 设置 =======================
// ======================= 公告 =======================
// 两条路径, 权限不同, 别混:
//   1. 用户侧(登录弹窗 + 顶栏按钮): 读 GET /api/admin/announcements —— **任何登录用户可用**,
//      只回已发布公告 + 一个聚合版本号 version;
//   2. 管理侧(PAGES.announce): /api/admin/announcements 的增删改, 走后端「公告管理」菜单权限。
//
// 「已读」怎么记: 把 version 存进 localStorage。于是
//   - 公告没动 → version 不变 → 登录后不再打扰;
//   - 改了标题/正文(revision+1) 或新增一条 → version 变 → 重新弹一次。
// 这是纯前端记忆, 换浏览器/清缓存会再弹一次 —— 可接受(公告本就是"看到就好")。

/** localStorage 键名。带前缀免得和同域下别的应用(key 前缀一致)撞车 */
const ANN_READ_KEY = 'sub2api_announce_read_version';

function annReadVersion() {
  try { return localStorage.getItem(ANN_READ_KEY) || ''; } catch (e) { return ''; }
}
function annSetReadVersion(v) {
  try { localStorage.setItem(ANN_READ_KEY, String(v || '')); } catch (e) { /* 隐私模式忽略 */ }
}

/**
 * 取已发布公告(用户侧)。任何登录用户都能调, 服务端没有菜单闸门。
 * 失败时**不抛异常**(公告拉不到不该影响任何主流程: 登录、切页都不该被它拖住),
 * 但也**不能静默成空数组** —— 那样界面会把网络错误显示成「暂无公告」, 用户以为真没公告。
 * 所以把原因放进 error, 由调用方决定怎么显示。
 */
async function fetchLiveAnnouncements() {
  try {
    const d = await api('/announcements');
    return { items: d.announcements || [], version: String(d.version || ''), error: '' };
  } catch (e) {
    return { items: [], version: '', error: (e && e.message) ? e.message : '网络异常' };
  }
}

/** 渲染一批公告的正文区(弹窗与顶栏查看共用) */
function annBodyHTML(items) {
  if (!items || !items.length) {
    return '<div class="ann-empty"><span class="ico">🔔</span>暂无公告</div>';
  }
  return '<div class="ann-list">' + items.map((a) => {
    const title = String(a.title || '').trim();
    const pinned = !!a.pinned;
    // 置顶的用图钉图标 + 暖色描边, 一眼能和一众普通公告区分开
    const head = title
      ? '<div class="ann-head"><span class="ico">' + (pinned ? '📌' : '📢') + '</span>' +
        '<span class="t">' + esc(title) + '</span>' +
        (pinned ? '<span class="tag warn">置顶</span>' : '') + '</div>'
      : '';
    return '<div class="ann-item' + (pinned ? ' pin' : '') + '">' + head +
      '<div class="ann-body">' + esc(a.content) + '</div>' +
    '</div>';
  }).join('') + '</div>';
}

/** 顶栏红点: 有未读公告时亮起 */
function annUpdateBadge(version) {
  const el = $('#ann-badge');
  if (!el) return;
  const unread = !!version && version !== annReadVersion();
  el.classList.toggle('hidden', !unread);
}

/**
 * 弹窗处于「等待中 / 已失败」时, 底部那个按钮只负责关窗 ——
 * 请求还没回来时给个禁用按钮, 只会让人以为界面卡死了。
 */
const ANN_FOOT_CLOSE = '<button class="btn" id="ann-ok">关闭</button>';

/**
 * 上一次公告弹窗留下的监听清理器。
 * 弹窗是挂在 document / #overlay 上的全局监听, 任何关闭路径都必须摘干净;
 * 「先弹窗再请求」之后这个按钮会被点得更勤, 不摘就会一次一次累积。
 */
let annOffPrev = null;

/**
 * 打开「公告」查看弹窗(顶栏按钮与登录自动弹窗都走这里)。
 *
 * 🚨 顺序是刻意反过来的: **先把窗口弹出来, 再去请求**。
 * 以前是先 await 拿数据、再 openModal —— 网络一慢, 用户点了按钮之后界面
 * 整整几秒没有任何变化, 会以为按钮坏了。现在点下去立刻出窗口 + 等待框,
 * 数据回来后**原地刷新**内容(不关掉重开, 免得闪一下)。
 *
 * 关掉时记下已读版本(「我知道了」/ 点遮罩 / 按 Esc 都算);
 * 只有加载失败时**不记已读** —— 没看到内容不该被当成已读。
 */
async function openAnnouncements(opts) {
  const o = opts || {};
  let version = '';   // 只有真的拿到内容才写已读

  // 上一个弹窗要是还开着(连点两次), 先把它那对全局监听摘掉
  if (annOffPrev) { annOffPrev(); annOffPrev = null; }

  openModal('公告', loadingHTML('正在获取公告…'), ANN_FOOT_CLOSE);

  const overlay = $('#overlay');
  // 各关闭路径统一收口: 记已读(有版本才记) + 摘掉全局监听
  const markRead = () => {
    if (version) { annSetReadVersion(version); annUpdateBadge(version); }
  };
  const off = () => {
    annOffPrev = null;
    overlay.removeEventListener('click', onOv);
    document.removeEventListener('keydown', onKey);
  };
  const onOv = (e) => { if (e.target.id === 'overlay') { markRead(); off(); } };
  const onKey = (e) => { if (e.key === 'Escape') { markRead(); off(); } };
  overlay.addEventListener('click', onOv);
  document.addEventListener('keydown', onKey);
  annOffPrev = off;

  /** 给当前底部的 #ann-ok 绑上「只关窗」 */
  const bindClose = () => {
    const b = $('#ann-ok');
    if (b) b.addEventListener('click', () => { off(); closeModal(); });
  };

  /** 把结果画进当前弹窗(等待态由调用方先摆好) */
  const paint = (data) => {
    const body = $('#modal .modal-body');
    const foot = $('#modal .modal-foot');
    if (!body || !foot) return;
    if (data.error) {
      // 失败就明说失败 + 给重试, 不要伪装成「暂无公告」
      body.innerHTML = '<div class="ann-empty"><span class="ico">⚠️</span>' +
        '公告加载失败: ' + esc(data.error) + '</div>';
      foot.innerHTML = '<button class="btn" id="ann-retry">重试</button>' +
        '<button class="btn primary" id="ann-ok">关闭</button>';
      $('#ann-retry').addEventListener('click', () => {
        body.innerHTML = loadingHTML('正在获取公告…');
        foot.innerHTML = ANN_FOOT_CLOSE;
        bindClose();
        load();
      });
      bindClose();
      return;
    }
    version = data.version;
    annUpdateBadge(data.version);
    body.innerHTML = annBodyHTML(data.items);
    foot.innerHTML = '<button class="btn primary" id="ann-ok">我知道了</button>';
    $('#ann-ok').addEventListener('click', () => { markRead(); off(); closeModal(); });
  };

  /** 取数 + 原地刷新。preload 有值就直接用(登录自动弹窗那条路已经拉过一次, 别重复请求) */
  const load = async (preload) => {
    const data = preload || await fetchLiveAnnouncements();
    // 请求期间用户可能已经把窗口关了、或者切到别的页(切页会 closeModal) → 不能再写 DOM
    if ($('#overlay').classList.contains('hidden')) return data;
    paint(data);
    return data;
  };

  bindClose();
  await load(o.preload);
}

/**
 * 登录成功后调用: 只有**确实有未读公告**才弹。
 * 这里仍然先静默拉一次做判断 —— 否则"没有未读"时也会弹一下再关, 反而更烦。
 * 判断通过后把**已有数据**交给 openAnnouncements(preload), 所以弹窗是立刻出内容的。
 */
async function maybeAnnounce() {
  const data = await fetchLiveAnnouncements();
  if (data.error || !data.items.length) { annUpdateBadge(''); return; }
  annUpdateBadge(data.version);
  if (data.version && data.version === annReadVersion()) return; // 已读过这个版本
  openAnnouncements({ preload: data });
}

/**
 * 只点亮/熄灭顶栏红点, **不弹窗**。
 * 会话已存在(刷新页面、从收藏直接进)时用它 —— 那种情况下不该反复弹公告。
 */
async function checkAnnounceBadge() {
  const data = await fetchLiveAnnouncements();
  if (data.error) return;   // 拉不到就别动红点, 免得把"有未读"误熄灭
  annUpdateBadge(data.version);
}

// 顶栏「公告」按钮 —— 随时可点, 不管有没有红点
document.addEventListener('DOMContentLoaded', () => {
  const b = $('#btn-announce');
  if (b) b.addEventListener('click', () => openAnnouncements({}));
});

// ======================= 操作说明文档 =======================
// 顶栏右上角「操作说明」按钮打开的一份 API 使用文档(给终端用户看的)。
//
// 🚨 为什么代码示例里写的是 **占位符**(@Q@ 双引号 / @B@ 反斜杠)而不是真字符 ——
//    这是模板字面量的头号陷阱: 本文件是模板字面量, 求值时会**先吃掉一层反斜杠**。
//    想在浏览器拿到的 JS 字符串里带一个反斜杠, 源码得双写甚至四写(见 fmtTime 那段的日期正则先例),
//    而"反斜杠 + 单引号"这种组合更会直接变成转义引号, 把字符串拆坏。为了不跟转义层数搏斗,
//    这里统一用占位符: 渲染时再一次性替换成真字符, 全程零字面转义。
//    同理多行代码用 lines 数组 + join, 而不是在字符串里写换行转义。
const DOC_NL = String.fromCharCode(10);
const DOC_DQ = String.fromCharCode(34);   // 双引号
const DOC_BS = String.fromCharCode(92);   // 反斜杠

/** 把占位符换成真字符(只作用于代码块内容) */
function docExpandCode(s) {
  const origin = (typeof location !== 'undefined' && location.origin) ? location.origin : '';
  return s.split('@Q@').join(DOC_DQ).split('@B@').join(DOC_BS).split('__ORIGIN__').join(origin);
}

/** 文档章节。block 类型: h 小标题 / p 段落 / ol 有序 / ul 无序 / code 代码块 / tip 提示 / table 表格 */
const DOC_SECTIONS = [
  {
    id: 'start', n: '1', nav: '快速开始',
    blocks: [
      { t: 'p', x: '跟着下面三步走, 几分钟就能发出第一个请求。' },
      { t: 'ol', items: [
        '到 <b>个人资料</b> 页点一次「签到」领取当日额度 —— 余额为 0 时接口会直接拒绝(管理员账号不受此限)。',
        '到 <b>API秘钥</b> 页点「新建 Key」。明文密钥<b>只显示这一次</b>, 请立刻复制保存。',
        '用下面的示例发出第一次请求, 能正常返回内容就说明通了。',
      ] },
      { t: 'code', lines: [
        'curl __ORIGIN__/v1/chat/completions @B@',
        '  -H @Q@Authorization: Bearer sk-你的KEY@Q@ @B@',
        '  -H @Q@Content-Type: application/json@Q@ @B@',
        "  -d '{@Q@model@Q@:@Q@模型名@Q@,@Q@messages@Q@:[{@Q@role@Q@:@Q@user@Q@,@Q@content@Q@:@Q@你好@Q@}]}'",
      ] },
      { t: 'tip', k: 'ok', b: '密钥只显示一次', x: '关掉弹窗后就只剩打码值了。如果没存下来, 直接删掉重建一把即可。' },
    ],
  },
  {
    id: 'auth', n: '2', nav: '接口地址与鉴权',
    blocks: [
      { t: 'p', x: '接口地址就是本站的根地址, 后面拼协议路径。比如 OpenAI 协议的完整地址是:' },
      { t: 'code', lines: ['__ORIGIN__/v1/chat/completions'] },
      { t: 'p', x: '密钥有三种传法, 用哪种取决于你在调哪套协议:' },
      { t: 'table',
        head: ['协议', '请求头', '典型路径'],
        rows: [
          ['OpenAI 兼容', '<span class="doc-kbd">Authorization: Bearer &lt;KEY&gt;</span>', '<span class="doc-kbd">/v1/chat/completions</span>'],
          ['Anthropic 原生', '<span class="doc-kbd">x-api-key: &lt;KEY&gt;</span>', '<span class="doc-kbd">/v1/messages</span>'],
          ['Google AI Studio', '<span class="doc-kbd">x-goog-api-key: &lt;KEY&gt;</span>', '<span class="doc-kbd">/v1beta/models/&lt;模型&gt;:generateContent</span>'],
        ] },
      { t: 'tip', k: 'warn', b: '密钥不能放在 URL 里', x: '查询参数传密钥(如 <span class="doc-kbd">?key=...</span>)会被直接拒绝。请一律放到请求头, 免得密钥被日志和代理记下。' },
    ],
  },
  {
    id: 'examples', n: '3', nav: '请求示例',
    blocks: [
      { t: 'h', x: 'OpenAI 协议 · curl' },
      { t: 'code', lines: [
        'curl __ORIGIN__/v1/chat/completions @B@',
        '  -H @Q@Authorization: Bearer sk-你的KEY@Q@ @B@',
        '  -H @Q@Content-Type: application/json@Q@ @B@',
        "  -d '{@Q@model@Q@:@Q@模型名@Q@,@Q@messages@Q@:[{@Q@role@Q@:@Q@user@Q@,@Q@content@Q@:@Q@你好@Q@}]}'",
      ] },
      { t: 'h', x: 'OpenAI 协议 · Python(openai SDK)' },
      { t: 'code', lines: [
        'from openai import OpenAI',
        '',
        'client = OpenAI(',
        '    base_url=@Q@__ORIGIN__/v1@Q@,',
        '    api_key=@Q@sk-你的KEY@Q@,',
        ')',
        'resp = client.chat.completions.create(',
        '    model=@Q@模型名@Q@,',
        '    messages=[{@Q@role@Q@: @Q@user@Q@, @Q@content@Q@: @Q@你好@Q@}],',
        ')',
        'print(resp.choices[0].message.content)',
      ] },
      { t: 'h', x: 'OpenAI 协议 · Node(fetch)' },
      { t: 'code', lines: [
        'const r = await fetch(@Q@__ORIGIN__/v1/chat/completions@Q@, {',
        '  method: @Q@POST@Q@,',
        '  headers: {',
        '    @Q@Authorization@Q@: @Q@Bearer sk-你的KEY@Q@,',
        '    @Q@Content-Type@Q@: @Q@application/json@Q@,',
        '  },',
        '  body: JSON.stringify({',
        '    model: @Q@模型名@Q@,',
        '    messages: [{ role: @Q@user@Q@, content: @Q@你好@Q@ }],',
        '  }),',
        '});',
        'console.log(await r.json());',
      ] },
      { t: 'h', x: 'Anthropic 原生协议' },
      { t: 'p', x: '换请求头即可, 路径与请求体沿用 Anthropic 原生的写法:' },
      { t: 'code', lines: [
        'curl __ORIGIN__/v1/messages @B@',
        '  -H @Q@x-api-key: sk-你的KEY@Q@ @B@',
        '  -H @Q@anthropic-version: 2023-06-01@Q@ @B@',
        '  -H @Q@Content-Type: application/json@Q@ @B@',
        "  -d '{@Q@model@Q@:@Q@模型名@Q@,@Q@max_tokens@Q@:256,@Q@messages@Q@:[{@Q@role@Q@:@Q@user@Q@,@Q@content@Q@:@Q@你好@Q@}]}'",
      ] },
      { t: 'h', x: 'Gemini 原生协议' },
      { t: 'code', lines: [
        'curl @Q@__ORIGIN__/v1beta/models/模型名:generateContent@Q@ @B@',
        '  -H @Q@x-goog-api-key: sk-你的KEY@Q@ @B@',
        '  -H @Q@Content-Type: application/json@Q@ @B@',
        "  -d '{@Q@contents@Q@:[{@Q@parts@Q@:[{@Q@text@Q@:@Q@你好@Q@}]}]}'",
      ] },
    ],
  },
  {
    id: 'stream', n: '4', nav: '流式输出',
    blocks: [
      { t: 'p', x: '请求体里加上 <span class="doc-kbd">"stream": true</span> 就返回 SSE 流, 逐块吐出内容:' },
      { t: 'code', lines: [
        'curl -N __ORIGIN__/v1/chat/completions @B@',
        '  -H @Q@Authorization: Bearer sk-你的KEY@Q@ @B@',
        '  -H @Q@Content-Type: application/json@Q@ @B@',
        "  -d '{@Q@model@Q@:@Q@模型名@Q@,@Q@stream@Q@:true,@Q@messages@Q@:[{@Q@role@Q@:@Q@user@Q@,@Q@content@Q@:@Q@你好@Q@}]}'",
      ] },
      { t: 'p', x: '用 SDK 的话把 <span class="doc-kbd">stream</span> 打开就行, 流的解析由客户端负责 —— 网关只做原样透传。' },
    ],
  },
  {
    id: 'models', n: '5', nav: '查询可用模型',
    blocks: [
      { t: 'p', x: '拿不准模型名怎么写, 先问网关要一份当前可用的清单:' },
      { t: 'code', lines: [
        'curl __ORIGIN__/v1/models @B@',
        '  -H @Q@Authorization: Bearer sk-你的KEY@Q@',
      ] },
      { t: 'p', x: '返回体里每一项的 <span class="doc-kbd">id</span> 就是可以直接填进请求的模型名。清单是实时聚合的(不缓存), 管理员调整绑定后立刻生效。' },
      { t: 'tip', k: 'info', b: '清单跟着分组走', x: '不同分组绑定的上游不一样, 看到的模型清单也可能不同。如果某个模型列表里没有, 多半是它不在你这把 Key 所属分组的范围内。' },
    ],
  },
  {
    id: 'errors', n: '6', nav: '错误码',
    blocks: [
      { t: 'p', x: '所有错误都返回统一结构:' },
      { t: 'code', lines: [
        '{',
        '  @Q@error@Q@: {',
        '    @Q@message@Q@: @Q@Insufficient balance. Please top up your account.@Q@,',
        '    @Q@type@Q@: @Q@permission_error@Q@,',
        '    @Q@code@Q@: @Q@INSUFFICIENT_BALANCE@Q@',
        '  }',
        '}',
      ] },
      { t: 'table',
        head: ['状态码', 'code', '什么意思', '怎么处理'],
        rows: [
          ['401', '<span class="doc-kbd">missing_api_key</span>', '没带密钥, 或者密钥格式不对', '检查请求头里的 Key'],
          ['403', '<span class="doc-kbd">INSUFFICIENT_BALANCE</span>', '余额为 0', '去「个人资料」签到或联系管理员充值'],
          ['403', '<span class="doc-kbd">permission_error</span>', '这个模型不在你分组的可用范围里', '换模型, 或让管理员把模型加进分组'],
          ['404', '—', '上游不认这个模型名', '用 /v1/models 里的准确 id 重试'],
          ['429', '<span class="doc-kbd">upstream_rate_limited</span>', '上游把账号限流了(暂时性)', '按响应头 <span class="doc-kbd">Retry-After</span> 秒数重试'],
          ['503', '<span class="doc-kbd">no_upstream_account</span>', '该平台没有可用的上游账号', '联系管理员在「上游账号」里补一个'],
        ] },
    ],
  },
  {
    id: 'faq', n: '7', nav: '常见问题',
    blocks: [
      { t: 'ul', items: [
        '<b>客户端里该填什么?</b> 接口地址填本站根地址(OpenAI 兼容类客户端通常要求填到 <span class="doc-kbd">/v1</span> 为止), 密钥填 <span class="doc-kbd">sk-</span> 开头那一把。',
        '<b>报 404 说找不到模型?</b> 这是上游不认这个模型名, 不是网关的问题。先用 <span class="doc-kbd">/v1/models</span> 查准确 id。',
        '<b>余额里明明有钱却报 403?</b> 那种情况多半不是余额, 而是模型不在你这个分组的可用范围里。',
        '<b>想换成别的上游?</b> 在「分组」里配路由就行, 客户端完全不用改。',
        '<b>去哪看调用明细?</b> 「使用日志」看用量汇总, 「请求日志」看逐条请求与落点账号。',
      ] },
    ],
  },
];

/** 单个 block 渲染 */
function docBlockHTML(b) {
  if (b.t === 'h') return '<h5 class="doc-h5">' + b.x + '</h5>';
  if (b.t === 'p') return '<p class="doc-p">' + b.x + '</p>';
  if (b.t === 'ol') return '<ol class="doc-list">' + b.items.map((s) => '<li>' + s + '</li>').join('') + '</ol>';
  if (b.t === 'ul') return '<ul class="doc-list">' + b.items.map((s) => '<li>' + s + '</li>').join('') + '</ul>';
  if (b.t === 'code') {
    return '<div class="doc-code"><button class="cp" type="button">复制</button>' +
      '<pre>' + esc(docExpandCode(b.lines.join(DOC_NL))) + '</pre></div>';
  }
  if (b.t === 'tip') {
    return '<div class="doc-tip ' + b.k + '"><b>' + b.b + '</b>' + b.x + '</div>';
  }
  if (b.t === 'table') {
    return '<table class="doc-table"><thead><tr>' +
      b.head.map((h) => '<th>' + h + '</th>').join('') + '</tr></thead><tbody>' +
      b.rows.map((r) => '<tr>' + r.map((c) => '<td>' + c + '</td>').join('') + '</tr>').join('') +
      '</tbody></table>';
  }
  return '';
}

/** 组装整份文档(左侧目录 + 右侧正文) */
function docHTML() {
  const nav = DOC_SECTIONS.map((s, i) =>
    '<button class="doc-link' + (i === 0 ? ' on' : '') + '" data-doc="' + s.id + '">' +
      s.n + '. ' + s.nav + '</button>').join('');
  const body = DOC_SECTIONS.map((s) =>
    '<section class="doc-sec" id="doc-' + s.id + '">' +
      '<h4><span class="n">' + s.n + '</span>' + s.nav + '</h4>' +
      s.blocks.map(docBlockHTML).join('') +
    '</section>').join('');
  return '<div class="doc-layout">' +
    '<nav class="doc-side"><div class="doc-side-t">目录</div>' + nav + '</nav>' +
    '<div class="doc-main">' +
      '<div class="doc-hero"><h3>5 分钟接入 sub2api</h3>' +
        '<p>sub2api 是 OpenAI / Anthropic / Gemini 三协议兼容的 AI API 网关 —— ' +
        '一把密钥、一个地址, 就能把主流客户端接进来。</p></div>' +
      body +
      '<div class="doc-foot">还有问题? 在「公告管理」里发一条公告提问, 或直接联系管理员。</div>' +
    '</div></div>';
}

/**
 * 右侧正文滚到哪一节, 左侧目录就高亮哪一项。
 * 这是"两列各自独立滚动"的配套联动 —— 目录本身不滚了, 靠这个告诉读者看到哪儿了。
 */
function docSyncNav(main, side) {
  const secs = main.querySelectorAll('.doc-sec');
  if (!secs.length) return;
  const base = main.getBoundingClientRect().top;
  let curId = secs[0].id;
  for (let i = 0; i < secs.length; i += 1) {
    // 章节顶端越过正文容器顶部(留 20px 余量) 就算"当前章节"
    if (secs[i].getBoundingClientRect().top - base <= 20) curId = secs[i].id;
    else break;
  }
  // 滚到底时最后一节可能始终越不过那条线(它太短), 补一个底部特判
  if (main.scrollTop + main.clientHeight >= main.scrollHeight - 4) {
    curId = secs[secs.length - 1].id;
  }
  const cur = curId.replace('doc-', '');
  const links = side.querySelectorAll('.doc-link');
  for (let i = 0; i < links.length; i += 1) {
    links[i].classList.toggle('on', links[i].dataset.doc === cur);
  }
}

/**
 * 打开「操作说明」文档。
 * 目录点击 = 平滑滚到对应章节; 正文滚动 = 目录高亮跟随(两列独立滚动, 互不干扰)。
 */
function openDocs() {
  openModal('操作说明', docHTML(), '<button class="btn primary" id="doc-ok">知道了</button>',
    { wide: true, sub: 'API 请求文档 · v1' });
  $('#doc-ok').addEventListener('click', closeModal);
  const side = $('.doc-side');
  const main = $('.doc-main');
  if (side) {
    side.addEventListener('click', (e) => {
      const btn = e.target.closest ? e.target.closest('.doc-link') : null;
      if (!btn) return;
      const sec = document.getElementById('doc-' + btn.dataset.doc);
      // 只会滚 .doc-main 这一个容器: 外层 .modal-body 在宽版下不滚(overflow:hidden)
      if (sec) sec.scrollIntoView({ behavior: 'smooth', block: 'start' });
      side.querySelectorAll('.doc-link').forEach((el) => el.classList.toggle('on', el === btn));
    });
  }
  if (main && side) {
    // scroll 事件很密, 用 rAF 节流 —— 每个事件都算一遍 rect 会拖慢滚动
    let ticking = false;
    main.addEventListener('scroll', () => {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(() => { ticking = false; docSyncNav(main, side); });
    });
  }
  // 代码块「复制」: 取同级 pre 的纯文本(里面没有高亮标签, 复制出来就是干净代码)
  document.querySelectorAll('.doc-code').forEach((box) => {
    const btn = box.querySelector('.cp');
    const pre = box.querySelector('pre');
    if (btn && pre) btn.addEventListener('click', () => copyText(pre.textContent, '已复制'));
  });
}

document.addEventListener('DOMContentLoaded', () => {
  const b = $('#btn-docs');
  if (b) b.addEventListener('click', openDocs);
});


/** 公告管理列表状态 */
let annState = { items: [] };

function annStatusTag(s) {
  return String(s) === 'published'
    ? '<span class="tag ok">已发布</span>'
    : '<span class="tag off">草稿</span>';
}

function annRender() {
  const items = annState.items || [];
  const rows = items.length
    ? items.map((a) => {
        const title = String(a.title || '').trim() || '(无标题)';
        return '<tr>' +
          '<td>' + (a.pinned ? '<span class="tag warn">置顶</span> ' : '') + esc(title) + '</td>' +
          '<td>' + annStatusTag(a.status) + '</td>' +
          '<td class="muted">v' + Number(a.revision || 1) + '</td>' +
          '<td class="muted">' + fmtTime(a.updated_at) + '</td>' +
          '<td><div class="actions">' +
            '<button class="btn sm" data-act="edit" data-id="' + a.id + '">编辑</button>' +
            '<button class="btn sm danger" data-act="del" data-id="' + a.id + '">删除</button>' +
          '</div></td>' +
        '</tr>';
      }).join('')
    : '<tr><td colspan="5" class="empty">还没有公告, 点右上角「新建公告」发第一条</td></tr>';

  $('#main').innerHTML =
    '<div class="page-head"><h2>公告管理</h2><div class="actions">' +
      '<button class="btn" id="btn-ann-refresh">刷新</button>' +
      '<button class="btn primary" id="btn-ann-new">新建公告</button></div></div>' +
    '<div class="panel"><div class="table-wrap"><table><thead><tr>' +
      '<th>标题</th><th>状态</th><th>版本</th><th>更新时间 (UTC+8)</th><th>操作</th>' +
    '</tr></thead><tbody>' + rows + '</tbody></table></div></div>' +
    '<div class="panel"><div class="panel-body">' +
      '<p class="hint">「已发布」的公告会出现在所有用户的顶栏「公告」按钮里, 并且用户登录后自动弹窗一次。' +
        '「草稿」只有你能看到。</p>' +
      '<p class="hint"><strong>改动标题或正文</strong>会把版本号 +1, 于是所有用户下次登录会重新看到一次公告 —— ' +
        '只切状态或只置顶不会打扰任何人。</p>' +
      '<p class="hint">删除是软删除, 历史记录仍在库中(可在「操作审计」页看到删除动作)。</p>' +
    '</div></div>';

  $('#btn-ann-refresh').addEventListener('click', () => annLoad({}));
  $('#btn-ann-new').addEventListener('click', () => annForm(null));
  $('#main').querySelectorAll('[data-act]').forEach((b) => {
    b.addEventListener('click', () => {
      const id = Number(b.dataset.id);
      const a = (annState.items || []).find((x) => Number(x.id) === id);
      if (b.dataset.act === 'edit') annForm(a);
      else annDelete(id, a ? a.title : '');
    });
  });
}

async function annFetch() {
  // 🚨 管理列表走 /announcements/all(含草稿)。裸 /announcements 是**用户侧**那条,
  //    只回已发布 —— 用它做管理列表会让草稿在页面上凭空消失(踩过)。
  const d = await api('/announcements/all');
  annState.items = d.announcements || [];
}

async function annLoad() {
  const tok = navTok();
  $('#main').innerHTML = loadingHTML();
  await annFetch();
  if (gone(tok)) return;
  annRender();
}

/** 新建/编辑弹窗。a 为空 = 新建 */
function annForm(a) {
  const isEdit = !!a;
  const cur = a || { title: '', content: '', status: 'published', pinned: 0 };
  openModal(isEdit ? '编辑公告' : '新建公告',
    '<div class="form-section">' +
      '<div class="form-row"><label>标题</label>' +
        '<input id="an-title" value="' + esc(cur.title) + '" placeholder="例如: 系统维护通知" maxlength="200"></div>' +
      '<div class="form-row"><label>详情</label>' +
        '<textarea id="an-content" rows="9" placeholder="公告正文, 支持换行">' + esc(cur.content) + '</textarea></div>' +
      '<div class="form-row"><label>状态</label><select id="an-status">' +
        '<option value="published"' + (cur.status === 'published' ? ' selected' : '') + '>已发布 —— 所有用户可见</option>' +
        '<option value="draft"' + (cur.status !== 'published' ? ' selected' : '') + '>草稿 —— 只有我能看到</option>' +
      '</select></div>' +
      '<div class="form-row"><label>置顶</label><select id="an-pinned">' +
        '<option value="0"' + (Number(cur.pinned) ? '' : ' selected') + '>否</option>' +
        '<option value="1"' + (Number(cur.pinned) ? ' selected' : '') + '>是 —— 排在公告列表最前</option>' +
      '</select></div>' +
    '</div>',
    '<button class="btn" id="an-cancel">取消</button>' +
    '<button class="btn primary" id="an-save">保存</button>');

  $('#an-cancel').addEventListener('click', closeModal);
  $('#an-save').addEventListener('click', async () => {
    const btn = $('#an-save');
    const title = $('#an-title').value.trim();
    const content = $('#an-content').value;
    if (!title) { toast('请填写标题', 'err'); return; }
    if (!content.trim()) { toast('请填写详情', 'err'); return; }
    const payload = {
      title: title,
      content: content,
      status: $('#an-status').value,
      pinned: $('#an-pinned').value === '1' ? 1 : 0,
    };
    btn.disabled = true; btn.textContent = '保存中…';
    try {
      if (isEdit) await api('/announcements/' + a.id, { method: 'PUT', body: JSON.stringify(payload) });
      else await api('/announcements', { method: 'POST', body: JSON.stringify(payload) });
      closeModal();
      toast('已保存');
      await annLoad();
    } catch (e) {
      toast(e.message, 'err');
    } finally {
      btn.disabled = false; btn.textContent = '保存';
    }
  });
}

function annDelete(id, title) {
  openModal('删除公告',
    '<p>确定要删除公告 <strong>' + esc(title || ('#' + id)) + '</strong> 吗？</p>' +
    '<p class="hint">删除后用户侧立刻看不到它(软删除, 审计记录保留)。</p>',
    '<button class="btn" id="an-del-cancel">取消</button>' +
    '<button class="btn danger" id="an-del-ok">删除</button>');
  $('#an-del-cancel').addEventListener('click', closeModal);
  $('#an-del-ok').addEventListener('click', async () => {
    const btn = $('#an-del-ok');
    btn.disabled = true; btn.textContent = '删除中…';
    try {
      await api('/announcements/' + id, { method: 'DELETE' });
      closeModal();
      toast('已删除');
      await annLoad();
    } catch (e) {
      toast(e.message, 'err');
      btn.disabled = false; btn.textContent = '删除';
    }
  });
}

PAGES.announce = async () => {
  const tok = navTok();
  $('#main').innerHTML = loadingHTML();
  await annFetch();
  if (gone(tok)) return;
  annRender();
};

PAGES.settings = async () => {
  const tok = navTok();
  $('#main').innerHTML = loadingHTML();
  const d = await api('/settings');
  // 「自助 Key 默认分组」要用分组下拉 —— 顺手一起取。
  // 取不到也不该让整个设置页挂掉, 所以单独 try/catch: 下拉退化成只有「自动」一项。
  let groups = [];
  try {
    const g = await api('/groups');
    groups = g.groups || [];
  } catch (e) { /* 忽略 */ }
  if (gone(tok)) return;

  // 设置项存在 settings 表里(键值对), 所以后台不用改接口就能加配置项。
  // 键名必须与后端一致: 自助分组 = self_service_group_id(admin-api.ts::SELF_GROUP_SETTING)。
  // 老库里可能还留着门户时期的 portal_default_group_id, 后端会兜底读它, 这里不做迁移。
  const PS = d.settings || {};
  const optGroup = (cur) => [['', '自动(选第一个分组)']].concat(
    groups.map((g) => [String(g.id), g.name + ' (#' + g.id + ')'])
  ).map((p) => '<option value="' + p[0] + '"' + (String(cur || '') === p[0] ? ' selected' : '') + '>' + esc(p[1]) + '</option>').join('');

  $('#main').innerHTML =
    '<div class="page-head"><h2>设置</h2></div>' +

    '<div class="panel"><div class="panel-title">当前账号</div>' +
      '<div style="padding:16px">' +
        '<div class="form-row"><label>用户名</label><input value="' + esc(d.admin ? d.admin.username : '-') + '" readonly></div>' +
        '<div class="form-row"><label>邮箱</label><input value="' + esc(d.admin ? d.admin.email : '-') + '" readonly></div>' +
        '<div class="form-row"><label>角色</label><input value="' +
          esc(d.admin ? ((d.admin.role_name || d.admin.role) + ' (' + d.admin.role + ')') : '-') + '" readonly></div>' +
        '<div class="form-row"><label>最近登录 (UTC+8)</label><input value="' + fmtTime(d.admin ? d.admin.last_login_at : '') + '" readonly></div>' +
      '</div></div>' +

    '<div class="panel"><div class="panel-title">修改密码</div>' +
      '<div style="padding:16px">' +
        '<p class="hint">修改的是<strong>当前登录账号自己</strong>的密码。要重置别人的密码, 请到「用户管理」页点该用户的「编辑」。</p>' +
        '<div class="form-row"><label>新密码(至少 ' + MIN_PASSWORD_LEN + ' 位)</label><input id="s-pwd" type="password" placeholder="••••••••"></div>' +
        '<div class="form-row"><label>确认新密码</label><input id="s-pwd2" type="password" placeholder="••••••••"></div>' +
        '<button class="btn primary" id="btn-pwd">修改密码</button>' +
      '</div></div>' +

    '<div class="panel"><div class="panel-title">运行时配置(只读, 需改 wrangler.toml 后重新部署)</div>' +
      '<table><tbody>' +
        '<tr><td class="muted">API Key 前缀</td><td class="mono">' + esc(d.runtime.api_key_prefix) + '</td></tr>' +
        '<tr><td class="muted">CORS 允许来源</td><td class="mono">' + esc(d.runtime.cors_allowed_origins) + '</td></tr>' +
        '<tr><td class="muted">强制余额检查</td><td class="mono">' + esc(d.runtime.enforce_balance) + '</td></tr>' +
      '</tbody></table></div>' +

    '<div class="panel"><div class="panel-title">自助 Key 设置</div>' +
      '<div class="panel-body">' +
        '<div class="form-row"><label>自助 Key 默认分组</label><select id="ss-group">' +
          optGroup(PS.self_service_group_id || PS.portal_default_group_id) + '</select>' +
          '<p class="hint">业务用户在「API秘钥」页自己创建 Key 时会挂到这个分组。<strong>必须挂一个真实分组</strong> —— ' +
            '路由配置(平台重定向表 / 白名单 / 分组平台)全挂在分组上, 不挂分组的 Key 什么都继承不到, 表现就是"能建不能用"。</p>' +
          '<p class="hint">留「自动」时按分组排序取第一个; 系统里一个分组都没有的话, 自助发 Key 会直接报错让人来找你。</p></div>' +
        '<div class="panel-actions"><button class="btn primary" id="btn-ss-save">保存</button></div>' +
      '</div></div>' +

    // 注册开关。语义与后端 settingOn() 一致: 只有显式 'false' 才算关,
    // 键不存在(老库)按"开"处理 —— 所以这里用 !== 'false' 而不是 === 'true'。
    '<div class="panel"><div class="panel-title">注册设置</div>' +
      '<div class="panel-body">' +
        '<div class="form-row"><label>开放注册</label><select id="reg-enabled">' +
          '<option value="true"' + (PS.registration_enabled !== 'false' ? ' selected' : '') + '>开放 —— 登录页显示「立即注册」</option>' +
          '<option value="false"' + (PS.registration_enabled === 'false' ? ' selected' : '') + '>关闭 —— 注册接口一律 403</option>' +
        '</select></div>' +
        '<div class="form-row"><label>新账号状态</label><select id="reg-approve">' +
          '<option value="true"' + (PS.registration_auto_approve !== 'false' ? ' selected' : '') + '>直接可用 —— 注册完即可登录</option>' +
          '<option value="false"' + (PS.registration_auto_approve === 'false' ? ' selected' : '') + '>待审核 —— 管理员在「用户」页启用后才能登录</option>' +
        '</select>' +
        '<p class="hint">注册页在 <code>/register</code>(登录页底部有入口)。注册出来的账号固定 <strong>role=user</strong>、余额 0, ' +
          '只能看自己的 Key 与调用记录; 想要更多权限请在「用户」页改角色。</p>' +
        '<p class="hint">选「待审核」时, 新账号落库为 <code>disabled</code>, 注册成功后会提示"等管理员审核"。' +
          '关闭注册只影响新注册, 已有账号不受影响。</p></div>' +
        '<div class="panel-actions"><button class="btn primary" id="btn-reg-save">保存</button></div>' +
      '</div></div>' +

    '<div class="panel"><div class="panel-title">退出登录</div>' +
      '<div style="padding:16px"><button class="btn danger" id="btn-logout">退出登录</button></div></div>';

  $('#btn-pwd').addEventListener('click', async () => {
    const p1 = $('#s-pwd').value, p2 = $('#s-pwd2').value;
    if (!p1 || p1.length < MIN_PASSWORD_LEN) { toast('密码至少 ' + MIN_PASSWORD_LEN + ' 位', 'err'); return; }
    if (p1 !== p2) { toast('两次输入的密码不一致', 'err'); return; }
    try {
      await api('/settings', { method: 'PUT', body: JSON.stringify({ new_password: p1 }) });
      toast('密码已修改, 请重新登录');
      setTimeout(() => { fetch('/api/admin/logout', { method: 'POST' }).finally(showLogin); }, 1200);
    } catch (e) { toast(e.message, 'err'); }
  });

  $('#btn-ss-save').addEventListener('click', async () => {
    const btn = $('#btn-ss-save');
    btn.disabled = true; btn.textContent = '保存中…';
    try {
      await api('/settings', {
        method: 'PUT',
        body: JSON.stringify({ settings: { self_service_group_id: $('#ss-group').value } }),
      });
      toast('已保存');
    } catch (e) {
      toast(e.message, 'err');
    } finally {
      btn.disabled = false; btn.textContent = '保存';
    }
  });

  $('#btn-reg-save').addEventListener('click', async () => {
    const btn = $('#btn-reg-save');
    btn.disabled = true; btn.textContent = '保存中…';
    try {
      await api('/settings', {
        method: 'PUT',
        body: JSON.stringify({
          settings: {
            registration_enabled: $('#reg-enabled').value,
            registration_auto_approve: $('#reg-approve').value,
          },
        }),
      });
      toast('已保存');
    } catch (e) {
      toast(e.message, 'err');
    } finally {
      btn.disabled = false; btn.textContent = '保存';
    }
  });

  $('#btn-logout').addEventListener('click', async () => {
    await fetch('/api/admin/logout', { method: 'POST' });
    showLogin();
  });
};

// ======================= 启动 =======================
(async function init() {
  // 注册开关是公开信息, 先并行取回来 —— 关掉注册时登录页那个「立即注册」链接就不该出现。
  const cfgPromise = loadRegisterConfig();
  try {
    const res = await fetch('/api/admin/me', { credentials: 'same-origin' });
    if (res.ok) {
      const me = await res.json();
      // 先按角色收侧栏再导航 —— 顺序反了会先渲染出"无权访问"再跳走, 闪一下很难看
      applyMenus(me.menus);
      IS_ADMIN = !!me.is_admin;
      showApp();
      setTopbarUser(me.username || '', me.role_name || me.role || '');
      // 直接落在地址栏指定的那一页 —— 刷新/收藏后回到原处, 不会被拽回总览
      navigate(pageFromLocation());
      toast('欢迎回来, ' + me.username);
      // 会话还在(刷新页面/收藏进入)时不弹窗, 只把顶栏红点点亮 ——
      // "每次登录弹一次"指的是真的走登录表单那一次, 刷新不该反复弹。
      checkAnnounceBadge();
      return;
    }
  } catch (e) { /* 忽略, 走登录页 */ }

  // 未登录: 地址栏是 /register 就直接进注册视图(刷新/分享注册链接都能正确落位)
  await cfgPromise;
  if (location.pathname === '/register') {
    showRegister(false);
    return;
  }
  // 服务端把深链接踢到 /login?next=/xxx 时会带 next 参数 —— 说明用户"本来要去某一页",
  // 这里给一句解释, 否则他只会看到登录页, 以为页面坏了。首次访问(落在 / 或 /login)静默,
  // 免得"第一次来就被提示状态失效"。
  // 注意要在 showLogin() **之前**读 search: 之后 URL 可能已被它改写(它只在非 /login 时才动)。
  const nextPath = new URLSearchParams(location.search).get('next') || '';
  showLogin();
  if (nextPath) {
    loginBanner('登录状态可能已失效, 请重新登录 —— 登录后会自动回到「' +
      (PAGE_TITLES[pageFromPath(nextPath)] || '刚才那一页') + '」', 'err');
  }
  $('#login-user').focus();
})();
</script>
</body>
</html>
`;
