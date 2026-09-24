#!/usr/bin/env node
/**
 * 后台前端「导航串页」与「审计分页」结构守卫
 *
 * 背景(两个都踩过):
 *   1. 快速连点左侧菜单时, 先发起的页面请求**后**返回, 它那句
 *      $('#main').innerHTML = ... 会盖在新页面上 ——
 *      表现为「地址栏/高亮是操作审计, 内容却是上一个菜单」。
 *      修法是引入导航令牌: 每次 navigate() 自增 NAV_SEQ, 页面函数在
 *      await 之后、写 #main 之前用 gone(tok) 判断自己是否已被取代。
 *      **这个守卫必须每个页面函数都有** —— 漏一个就漏一条串页路径,
 *      而且运行时完全静默(只有网络慢的时候才偶发), 所以用静态检查卡住。
 *   2. 操作审计页要分页, 分页条必须真的挂在 auditGo 上。
 *
 * 做法: 把 admin-ui.ts 里 ADMIN_HTML 模板字面量求值, 抠出内联 <script>,
 * 再按「大括号配对」切出每个 PAGES.x 的函数体做检查。切的时候会跳过
 * 字符串/注释里的括号, 否则 CSS 选择器里的 {} 会让配对跑偏。
 *
 * 用法: node tools/test-nav-guard.mjs   (退出码 0 = 通过)
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const srcPath = resolve(here, '../src/admin-ui.ts');
const source = readFileSync(srcPath, 'utf8');

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

// ---------- 1. 取出浏览器实际收到的 HTML 与内联脚本 ----------
const expr = source.match(/const ADMIN_HTML\s*=\s*(`[\s\S]*?`);/);
if (!expr) {
  console.error('✗ 找不到 `const ADMIN_HTML = `...`;` 定义');
  process.exit(1);
}
let html;
try {
  html = (0, eval)(expr[1]);
} catch (e) {
  console.error('✗ 求值 ADMIN_HTML 模板字面量失败:', e.message);
  process.exit(1);
}
const open = html.indexOf('<script>');
const close = html.lastIndexOf('</script>');
if (open === -1 || close === -1 || close < open) {
  console.error('✗ 渲染结果里找不到成对的 <script>...</script>');
  process.exit(1);
}
const inline = html.slice(open + '<script>'.length, close);

// 🚨 反向断言(「某某写法不许再出现」)必须先去掉 CSS 注释再判 ——
//    注释里常常**引用反面样例**来解释"为什么不能这么写"(例如说明百分比高度为何失效),
//    直接对原文做正则会被自己的注释误伤, 报出一条假 FAIL(踩过)。
const htmlNoCss = html.replace(/\/\*[\s\S]*?\*\//g, '');

console.log('\n=== 后台导航/分页结构守卫 ===\n');

// 模板字面量陷阱: 内联脚本里出现反引号会把宿主模板提前闭合(tsc 报 TS1005)
check('内联脚本内不含反引号(模板字面量陷阱)', !inline.includes('`'));
// 模板字面量陷阱: 正则里的反斜杠会被吃掉, 源码必须写两个
check('源码里的正则反斜杠已转义(\\\\d 之类)', /\\d\{4\}/.test(source));

// ---------- 2. 从 startIdx 起用大括号配对切出函数体 ----------
/** 跳过字符串与注释的括号配对, 返回第一个 '{' 到其配对 '}' 之间的内容 */
function bodyFrom(src, startIdx) {
  const openIdx = src.indexOf('{', startIdx);
  if (openIdx === -1) return null;
  let depth = 0;
  let i = openIdx;
  while (i < src.length) {
    const ch = src[i];
    const next = src[i + 1];
    if (ch === '/' && next === '/') {
      const nl = src.indexOf('\n', i);
      i = nl === -1 ? src.length : nl;
      continue;
    }
    if (ch === '/' && next === '*') {
      const end = src.indexOf('*/', i + 2);
      i = end === -1 ? src.length : end + 2;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch;
      i++;
      while (i < src.length && src[i] !== quote) {
        if (src[i] === '\\') i++;
        i++;
      }
      i++;
      continue;
    }
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return src.slice(openIdx + 1, i);
    }
    i++;
  }
  return null;
}

// ---------- 3. 令牌机制本身 ----------
console.log('\n[1] 导航令牌机制');
check('定义 NAV_SEQ', /let\s+NAV_SEQ\s*=\s*0/.test(inline));
check('定义 navTok()', /const\s+navTok\s*=\s*\(\)\s*=>\s*NAV_SEQ/.test(inline));
check('定义 gone(t)', /const\s+gone\s*=\s*\(\w+\)\s*=>\s*\w+\s*!==\s*NAV_SEQ/.test(inline));

const navIdx = inline.search(/function\s+navigate\s*\(/);
check('存在 navigate()', navIdx !== -1);
if (navIdx !== -1) {
  const navBody = bodyFrom(inline, navIdx) ?? '';
  const bump = navBody.search(/NAV_SEQ\s*(\+=|=\s*NAV_SEQ\s*\+|\+\+)/);
  const callIdx = navBody.search(/fn\s*\(\)/);
  check('navigate 里自增 NAV_SEQ', bump !== -1, `bump=${bump}`);
  check('自增发生在调用页面函数之前', bump !== -1 && callIdx !== -1 && bump < callIdx,
    `bump=${bump} call=${callIdx}`);
  check('切页时关闭弹窗(避免上一页弹窗飘在新页面上)', /closeModal\s*\(\)/.test(navBody));
}

// ---------- 4. 每个 PAGES 页面函数都必须有守卫 ----------
console.log('\n[2] 每个 PAGES 页面函数的过期守卫');
const pageRe = /PAGES\.([A-Za-z_$][\w$]*)\s*=\s*async/g;
const pages = [];
for (let m = pageRe.exec(inline); m; m = pageRe.exec(inline)) {
  pages.push({ name: m[1], at: m.index });
}
check('找到页面函数', pages.length >= 11, `count=${pages.length}`);
check('页面清单包含审计页', pages.some((p) => p.name === 'audit'), pages.map((p) => p.name).join(','));

for (const p of pages) {
  const body = bodyFrom(inline, p.at);
  if (body === null) {
    check(`PAGES.${p.name} 函数体可解析`, false, '括号配对失败');
    continue;
  }
  // 括号配对跑偏的兜底: 切出来的体里不该再出现"另一个页面函数的开头"
  check(`PAGES.${p.name} 函数体切分正确`, !/PAGES\.\w+\s*=\s*async/.test(body));
  const hasTok = body.includes('navTok()');
  const goneIdx = body.search(/gone\(\s*\w+\s*\)/);
  const awaitIdx = body.search(/\bawait\b/);
  const ok = hasTok && goneIdx !== -1 && awaitIdx !== -1 && goneIdx > awaitIdx;
  check(
    `PAGES.${p.name}: await 之后有 gone() 守卫`,
    ok,
    `navTok=${hasTok} awaitIdx=${awaitIdx} goneIdx=${goneIdx}`,
  );
}

// ---------- 5. 审计分页结构 ----------
console.log('\n[3] 操作审计分页');
const auditPage = pages.find((p) => p.name === 'audit');
const auditBody = auditPage ? (bodyFrom(inline, auditPage.at) ?? '') : '';
// 表格与分页条的 DOM 在 auditRender() 里, 不在 PAGES.audit 里
const renderIdx = inline.search(/function\s+auditRender\s*\(/);
const renderBody = renderIdx === -1 ? '' : (bodyFrom(inline, renderIdx) ?? '');
check('存在 auditRender()', renderIdx !== -1);
check('有分页状态 auditState', /const\s+auditState\s*=\s*\{[^}]*page[^}]*pageSize/.test(inline));
check('有每页条数候选表 AUDIT_PAGE_SIZES', /const\s+AUDIT_PAGE_SIZES\s*=\s*\[/.test(inline));
check('请求带 limit/offset', /'\/audit\?limit='\s*\+\s*auditState\.pageSize\s*\+\s*'&offset='\s*\+/.test(inline));
check('审计页走 auditFetch()', /auditFetch\(\)/.test(auditBody), auditBody.slice(0, 80));

for (const id of ['btn-refresh', 'a-prev', 'a-next', 'a-size']) {
  const tag = `id="${id}"`;
  const has = inline.includes(tag) && new RegExp(`\\$\\('#${id}'\\)`).test(inline);
  check(`分页条含 ${tag} 且已绑定事件`, has);
}
check('分页条由 auditGo 驱动', /auditGo\(\{/.test(inline));
check('展示了总条数', /共 '\s*\+\s*fmtNum\(total\)/.test(renderBody), renderBody.slice(0, 60));
check('展示了当前页 / 总页数', /'\s\/\s'\s*\+\s*pageCount/.test(renderBody));
check('越界页会退回最后一页(不留空白页)', /auditState\.page\s*>\s*pageCount/.test(inline));
check('翻页时先禁用按钮(避免连点重复请求)',
  /if\s*\(pv\)\s*pv\.disabled\s*=\s*true/.test(inline) && /if\s*\(nx\)\s*nx\.disabled\s*=\s*true/.test(inline));
check('审计表格套了 table-wrap(横向滚动)', /class="table-wrap"/.test(renderBody));
check('空态文案区分「本页无记录」与「还没有记录」',
  /本页没有记录/.test(renderBody) && /还没有操作记录/.test(renderBody));

// ---------- 6. 「模型获取 + 模型定价」合并页 ----------
// 2026-09-22: 原「模型获取」页(discover)合并进「模型定价」页, 用标签页切换「别名 / 定价」。
// 正文渲染函数从 PAGES.discover 改名为 modelsAliasView()(不再是页面函数, 由 PAGES.models 调用),
// 所以这里不再按 PAGES.x 找, 而是按函数名切片。
console.log('\n[4] 模型获取与定价 合并页');
check('旧的 discover 页面已彻底摘除(侧栏/PAGE_TITLES/PAGES 函数)',
  !/data-page="discover"/.test(html) && !/\bdiscover:\s*'/.test(inline) && !/PAGES\.discover\s*=/.test(inline));

const aliasStart = inline.indexOf('function modelsAliasView');
const aliasEnd = inline.indexOf('// ===================== 别名设置');
const aliasBody = aliasStart === -1 || aliasEnd === -1 ? '' : inline.slice(aliasStart, aliasEnd);
check('存在 modelsAliasView()', aliasBody.length > 300, 'len=' + aliasBody.length);
check('别名视图渲染到 #models-body(不是整个 #main)', aliasBody.includes("$('#models-body').innerHTML"));
check('面板正文套了 .panel-body', aliasBody.includes('<div class="panel-body">'));
// 2026-09-25: 「别名列表」独立标签页 —— 只有扁平表(新增/编辑/删除),
// 「从上游获取」已拆到「别名设置」标签(modelsAliasFetchView)
check('别名列表只有扁平表 + 新增按钮', aliasBody.includes('btn-new-alias') && aliasBody.includes('别名列表'));
check('别名列表不再包含「从上游获取」面板', !aliasBody.includes('从上游获取并批量新增') && !aliasBody.includes('id="d-acct"'));

// 别名设置(从上游获取)标签页
const fetchStart = inline.indexOf('function modelsAliasFetchView');
const fetchEnd = inline.indexOf('// ======================= 模型别名 =======================');
const fetchBody = fetchStart === -1 || fetchEnd === -1 ? '' : inline.slice(fetchStart, fetchEnd);
check('存在 modelsAliasFetchView()', fetchBody.length > 400, 'len=' + fetchBody.length);
check('命名获取面板有标题与表单', fetchBody.includes('从上游获取并批量新增') && fetchBody.includes('id="d-acct"'));
check('结果区用 .result-body', fetchBody.includes('class="result-body"'));
check('按钮组用 .panel-actions', fetchBody.includes('class="panel-actions"'));

// 标签页本身: 用 data-mtab(不是 data-page —— 那会被角色守卫当成侧栏菜单项)
check('有标签页容器 .page-tabs', /class="page-tabs[^"]*"/.test(inline));
check('四个标签项走 data-mtab(别名列表 / 别名设置 / 模型定价 / 默认单价)',
  /data-mtab="alist"/.test(inline) && /data-mtab="aset"/.test(inline) &&
  /data-mtab="price"/.test(inline) && /data-mtab="default"/.test(inline));
check('🧨 标签项不用 data-page(否则被算成侧栏菜单项)',
  !/class="page-tab[^"]*"[^>]*data-page=/.test(inline));
check('标签页互斥高亮(classList.toggle active)',
  /classList\.toggle\('active',\s*el\.dataset\.mtab === which\)/.test(inline));
// 保存定价 / 保存别名后重新渲染时, 不能把用户从「定价」弹回「别名」
check('跨标签页记忆当前页签 MODELS_TAB(默认别名列表)', /let\s+MODELS_TAB\s*=\s*'alist'/.test(inline));
check('PAGES.models 渲染时按 MODELS_TAB 恢复页签', /includes\(MODELS_TAB\)/.test(inline));
check('保存定价后记住页签(不弹回别名)',
  (inline.match(/MODELS_TAB = 'price';\s*PAGES\.models\(\);/g) || []).length >= 3,
  'count=' + (inline.match(/MODELS_TAB = 'price';\s*PAGES\.models\(\);/g) || []).length);
check('保存别名后导览到别名列表页签',
  (inline.match(/MODELS_TAB = 'alist';\s*PAGES\.models\(\);/g) || []).length >= 2,
  'count=' + (inline.match(/MODELS_TAB = 'alist';\s*PAGES\.models\(\);/g) || []).length);
check('保存默认单价后记住默认单价页签',
  (inline.match(/MODELS_TAB = 'default';\s*PAGES\.models\(\);/g) || []).length >= 1,
  'count=' + (inline.match(/MODELS_TAB = 'default';\s*PAGES\.models\(\);/g) || []).length);

// 定价视图两块内容 —— 对应需求: 上游拉模型一键定价 / 单独定价 / 手动新增
const priceStart = inline.indexOf('function modelsPricingView');
const priceEnd = inline.indexOf('function modelsDefaultPriceView');
const priceBody = priceStart === -1 || priceEnd === -1 ? '' : inline.slice(priceStart, priceEnd);
check('存在 modelsPricingView()', priceBody.length > 800, 'len=' + priceBody.length);
check('① 模型定价标签不再含「默认单价」区块(独立成标签)',
  !priceBody.includes('id="pd-save"') && !priceBody.includes('default_price_builtin'));
check('② 有「从上游获取模型」入口', priceBody.includes("id=\"m-fetch\""));
check('② 有「一键设置定价」整批写入', priceBody.includes("id=\"m-apply\"") && /body:\s*JSON\.stringify\(\{\s*models:/.test(priceBody));
check('② 有逐行「保存」(单独设置定价)', priceBody.includes('data-save-one'));
check('③ 有「手动新增定价」(拉不到上游时的入口)',
  priceBody.includes("id=\"p-new\"") && priceBody.includes('modelForm(null'));
check('定价行展示「已定价 / 未定价」状态', priceBody.includes('已定价') && priceBody.includes('未定价'));
check('缓存价藏进 data-cr / data-cw(逐行保存不会冲掉已配的缓存价)',
  priceBody.includes('data-cr="') && priceBody.includes('data-cw="'));

// 默认单价独立标签页
const defStart = inline.indexOf('function modelsDefaultPriceView');
const defEnd = inline.indexOf('function modelForm');
const defBody = defStart === -1 || defEnd === -1 ? '' : inline.slice(defStart, defEnd);
check('存在 modelsDefaultPriceView()', defBody.length > 400, 'len=' + defBody.length);
check('默认单价页有表单 + 保存按钮',
  defBody.includes('id="pd-save"') && defBody.includes('default_price:'));
check('默认单价可还原出厂默认(读到 default_price_builtin)',
  defBody.includes('default_price_builtin') && defBody.includes("id=\"pd-reset\""));

// 带吸顶 tab 的页面, 标题栏必须摘掉 sticky(.page-head 也是 sticky top:0,
// 两个吸顶元素同位重叠, 标题下半截会从 tab 底下露出来 —— 2026-09-24 踩过)
check('模型管理页标题栏挂 .no-stick(不与吸顶 tab 同位重叠)',
  /page-head no-stick"><h2>模型管理</.test(inline));
check('CSS 有 .page-head.no-stick 摘 sticky 规则',
  /\.page-head\.no-stick\s*\{[^}]*position:\s*static/.test(htmlNoCss));

// ---------- 6b. 分组「模型关联」弹窗(groupModelsForm) ----------
// 用户需求: 分组操作列新增「模型关联」, 弹窗按上游平台分档多选/全选,
// 保存到 groups.model_allowlist; /v1/models 据此过滤(src/models.ts 既有行为)。
const gmfStart = inline.indexOf('function groupModelsForm');
const gmfEnd = inline.indexOf('function delGroup');
const gmfBody = gmfStart === -1 || gmfEnd === -1 ? '' : inline.slice(gmfStart, gmfEnd);
check('存在 groupModelsForm()', gmfBody.length > 1500, 'len=' + gmfBody.length);
check('分组操作列有「模型关联」按钮(data-models-grp)', /data-models-grp="/.test(inline));
check('已关联数量徽标(读 model_allowlist 长度)', /model_allowlist \|\| \[\]\)\.length/.test(inline));
check('弹窗数据源: 分组绑定账号 + 全量账号(取 model_index/别名)',
  gmfBody.includes("api('/groups/' + g.id + '/accounts')") && gmfBody.includes("api('/accounts')"));
check('模型候选 = model_index + 账号级别名键', gmfBody.includes('model_index') && gmfBody.includes('model_aliases'));
check('按平台分档(data-gmtab 切换)', gmfBody.includes('data-gmtab'));
check('每档有「全选/取消全选」(id="gm-all")', gmfBody.includes('id="gm-all"'));
check('唯一 id = 平台::模型(候选行 value 带平台前缀, data-kind 区分候选/其他)',
  gmfBody.includes('data-kind=') && gmfBody.includes("kind === 'cand'") &&
  gmfBody.includes("'::' + n"));
check('勾选状态存 cur/orphanSel(切档重渲染不丢勾选)',
  gmfBody.includes('cur.set(') && gmfBody.includes('orphanSel'));
check('候选严格区分大小写(不再按小写合并)', !gmfBody.includes('name.toLowerCase()'));
check('保存走 PUT /groups/:id 且写 model_allowlist',
  /api\('\/groups\/' \+ g\.id,\s*\{\s*method:\s*'PUT'/.test(gmfBody) &&
  gmfBody.includes('model_allowlist:'));
check('全部不选 = 写 null 清空(不过滤)', gmfBody.includes('model_allowlist: arr.length ? arr : null'));
check('已选但候选消失的模型进「其他」档(不静默丢弃)', gmfBody.includes('__orphan'));

// ---------- 6c. 别名可改名(aliasForm) ----------
// 2026-09-24: 编辑别名时「对外别名」不再是 readonly; 改名=删旧键+写新键+撞名检测
const afStart = inline.indexOf('function aliasForm');
const afEnd = inline.indexOf('// ==================== 模型获取与定价');
const afBody = afStart === -1 || afEnd === -1 ? '' : inline.slice(afStart, afEnd);
check('存在 aliasForm()', afBody.length > 800, 'len=' + afBody.length);
check('🧨 对外别名输入框编辑时不再 readonly', !/al-alias[^>]*readonly/.test(afBody));
check('改名 = 删旧键(delete merged[alias])', afBody.includes('delete merged[alias]'));
check('改名撞名检测(大小写不敏感, 不覆盖另一个别名)',
  afBody.includes("k.toLowerCase() === newAlias.toLowerCase() && k !== alias"));

// ---------- 6d. 别名列表批量删除 ----------
// 2026-09-24: 扁平表加勾选列 + 全选 + 批量删除(model_aliases 整表替换, 按账号分组 PUT)
const avStart = inline.indexOf('function modelsAliasView');
const avEnd = inline.indexOf('function modelsAliasFetchView');
const avBody = avStart === -1 || avEnd === -1 ? '' : inline.slice(avStart, avEnd);
check('别名列表有勾选列(.al-chk) + 表头全选(#al-all)',
  avBody.includes('class="al-chk"') && avBody.includes('id="al-all"'));
check('有「批量删除」按钮(btn-batch-del-alias, 默认禁用)',
  avBody.includes('id="btn-batch-del-alias"') && avBody.includes('btn-batch-del-alias" disabled'));
check('批量删除按账号分组(整表替换, 不逐行)',
  avBody.includes('byAcct') && (avBody.match(/model_aliases: merged/g) || []).length >= 1);
check('批量删除有确认弹窗', avBody.includes('确认批量删除'));

// ---------- 7. CSS ----------
console.log('\n[5] 相关 CSS');
// 只断言"有内边距", 不锁死具体像素 —— 布局微调(16→17px)不该让守卫变红
check('.panel-body 有内边距', /\.panel-body\s*\{[^}]*padding:\s*1[0-9]px/.test(html));
check('.hint 有字号与行高', /\.hint\s*\{[^}]*font-size:\s*12px[^}]*line-height:\s*1\.9/.test(html));
check('.form-row .hint 覆盖了段间距(不串到弹窗里)',
  /\.form-row\s+\.hint\s*\{[^}]*margin:\s*4px\s+0\s+0/.test(html));
check('.hint:last-child 去掉多余留白', /\.hint:last-child\s*\{[^}]*margin-bottom:\s*0/.test(html));
check('.result-body 仅在非空时留白', /\.result-body:not\(:empty\)\s*\{/.test(html));
check('.panel-actions 为横向按钮条', /\.panel-actions\s*\{[^}]*display:\s*flex/.test(html));
// 标签页(2026-09-22 新增): 一页多视图 —— 当前项靠下边框高亮
// toast 位置(2026-09-22 用户要求: 「登录成功，欢迎回来，帮我放在顶部正中间」)
// 以前钉在右上角, 恰好压住顶栏右侧的「退出登录」, 看起来像按钮坏了。
check('#toast 顶部水平居中(left:50% + translateX 回拽一半)',
  /#toast\s*\{[^}]*left:\s*50%[^}]*transform:\s*translateX\(-50%\)/.test(html));
// 反向断言必须用去注释版: 上面那段解释里原文引用了旧写法 right:18px
check('🧨 #toast 不再钉在右上角(right:18px)',
  !/#toast\s*\{[^}]*right:\s*18px/.test(htmlNoCss));
check('toast 不吃点击(pointer-events:none, 不挡住顶部标题区)',
  /#toast\s*\{[^}]*pointer-events:\s*none/.test(html));
check('toast 入场动画改为纵向(居中后不再从右侧滑入)',
  /@keyframes slide\s*\{\s*from\s*\{\s*transform:\s*translateY\(-1?[0-9]px\)/.test(html));
check('.page-tabs 是横向条并带下分隔线',
  /\.page-tabs\s*\{[^}]*display:\s*flex[^}]*border-bottom:\s*1px solid var\(--border\)/.test(html));
check('.page-tab 是"透明按钮 + 底部指示条"(不用默认按钮样式)',
  /\.page-tab\s*\{[^}]*background:\s*transparent[^}]*border-bottom:\s*2px solid transparent/.test(html));
check('.page-tab.active 用品牌色高亮', /\.page-tab\.active\s*\{[^}]*color:\s*var\(--accent\)/.test(html));

// ---------- 8. 加载框上下居中 + 顶栏精简(2026-09-21) ----------
console.log('\n[6] 加载框垂直居中 / 顶栏布局');
// 居中靠三层配合, 缺一不可:
//   ① .main 必须是纵向 flex 容器(否则 .loading 只是普通块, 只能水平居中)
//   ② .loading 要 flex:1 撑满剩余高度(否则贴顶)
//   ③ 不能再有固定 padding 把它顶在顶部
check('.main 是纵向 flex 容器',
  /\.main\s*\{[^}]*display:\s*flex[^}]*flex-direction:\s*column/.test(html));
check('.main 直接子元素占满宽度',
  /\.main\s*>\s*\*\s*\{[^}]*width:\s*100%/.test(html));
check('.main > .loading 撑满剩余高度',
  /\.main\s*>\s*\.loading\s*\{[^}]*flex:\s*1/.test(html));
check('加载态有 min-height 兜底(弹窗 body 里也像样)',
  /\.loading\s*\{[^}]*min-height:\s*220px/.test(html));
check('加载态不再用固定 60px padding',
  !/\.loading\s*\{[^}]*padding:\s*60px/.test(html));

// 顶栏**不再重复显示菜单名** —— 各页 .page-head 已有大标题。
check('顶栏没有菜单名占位(#topbar-crumb 已移除)', html.indexOf('topbar-crumb') === -1);
check('navigate() 里也不再写面包屑', !/topbar-crumb/.test(inline));
check('顶栏账号信息为胶囊结构(.who)',
  /<span class="who" id="topbar-user"[^>]*>/.test(html));
check('顶栏品牌带 logo 徽标', /class="topbar"[\s\S]{0,400}class="logo"/.test(html));
check('有 setTopbarUser() 统一写账号信息', /function\s+setTopbarUser\s*\(/.test(inline));
// setTopbarUser 必须操作子 span, 不能整体 textContent(会把圆点冲掉)
const stuIdx = inline.indexOf('function setTopbarUser');
const stuBody = stuIdx === -1 ? '' : (bodyFrom(inline, stuIdx) ?? '');
check('setTopbarUser 走子节点 .nm 而不是整体 textContent',
  /querySelector\('\.nm'\)/.test(stuBody) && !/\$\('#topbar-user'\)\.textContent/.test(stuBody));
check('三处调用点都改用 setTopbarUser',
  (inline.match(/setTopbarUser\(/g) || []).length >= 4,
  `count=${(inline.match(/setTopbarUser\(/g) || []).length}`);

// ---------- 9. 侧栏(分组标题加粗 + 菜单图标)+ 右侧内容区(2026-09-21) ----------
console.log('\n[7] 侧栏分组标题 / 菜单图标 / 右侧内容区');

// 分组标题: 用户明确要求"加大加黑加粗"
const ngIdx = html.indexOf('.nav-group {');
const ngCss = ngIdx === -1 ? '' : html.slice(ngIdx, ngIdx + 400);
check('分组标题字号加大(≥14px)', /font-size:\s*1[4-9]px/.test(ngCss), ngCss.slice(0, 120));
check('分组标题加粗(font-weight ≥ 700)', /font-weight:\s*(?:7|8|9)00/.test(ngCss), ngCss.slice(0, 120));
check('分组标题颜色加深(不是 muted 灰)', /color:\s*#111827/.test(ngCss), ngCss.slice(0, 120));
check('分组标题不再全大写/不缩字距',
  !/text-transform:\s*uppercase/.test(ngCss) && /text-transform:\s*none/.test(ngCss));
check('分组标题有装饰竖条(::before)', /\.nav-group::before\s*\{/.test(html));

// 菜单图标: 必须走 CSS ::before, 不能写进 HTML
// 原因: 守卫断言侧栏标签紧跟 data-page(如 data-page="mykeys">API秘钥<),
// 在标签前后插 <i>/<svg> 会破坏该断言。
check('菜单图标走 CSS ::before(不写进 HTML)',
  /\.nav-item::before\s*\{/.test(html) && !/data-page="\w+"[^>]*>\s*<(?:i|svg|span)/.test(html));
const navKeys = [...html.matchAll(/data-page="([a-z0-9_-]+)"/g)].map((m) => m[1]);
const iconRules = [...html.matchAll(/\.nav-item\[data-page="([a-z0-9_-]+)"\]::before\s*\{/g)].map((m) => m[1]);
check('每个侧栏菜单项都配了图标', navKeys.every((k) => iconRules.includes(k)),
  'missing=' + navKeys.filter((k) => !iconRules.includes(k)).join(','));

// 右侧内容区
check('.main 有更宽松的留白(padding 32px)',
  /\.main\s*\{[^}]*padding:\s*0\s+32px\s+32px/.test(html));
check('.main 有细滚动条样式', /\.main::-webkit-scrollbar\s*\{/.test(html));
check('.page-head 标题左有强调竖条', /\.page-head h2::before\s*\{/.test(html));
check('.panel-title 有强调竖条', /\.panel-title::before\s*\{/.test(html));
check('.panel 有浅阴影', /\.panel\s*\{[^}]*box-shadow:/.test(html));
check('表头不再 sticky(表格随页面整体滚动)', !/th\s*\{[^}]*position:\s*sticky/.test(html));
check('.card 有 hover 反馈', /\.card:hover\s*\{/.test(html));
check('按钮统一 inline-flex(图标+文字对齐)', /\.btn\s*\{[^}]*display:\s*inline-flex/.test(html));

// 窄屏侧栏: 菜单项从"左边框"改成"胶囊", 断言旧的 border-left 断言没有残留冲突
const mqIdx = html.indexOf('@media (max-width: 720px)');
const mqCss = mqIdx === -1 ? '' : html.slice(mqIdx, mqIdx + 1400);
check('窄屏侧栏菜单项是胶囊(border-radius 999px)', /border-radius:\s*999px/.test(mqCss));
check('窄屏侧栏不再用 border-left 高亮',
  !/\.nav-item\.active\s*\{[^}]*border-left-color/.test(mqCss));

// ---------- 10. 顶栏入口按钮 / 操作说明文档 / 公告弹窗(2026-09-21) ----------
console.log('\n[8] 顶栏按钮 / 操作说明文档 / 公告弹窗');

// 顶栏两个入口按钮: 必须是纯前端入口, **不能**带 data-page
// (test-roles-guard.mjs 会把所有 data-page 当侧栏菜单项, 断言它们都在 MENU_CATALOG 里)
const topBtns = [...html.matchAll(/<button[^>]*id="btn-(?:docs|announce)"[^>]*>/g)].map((m) => m[0]);
check('顶栏有「操作说明」与「公告」两个入口按钮', topBtns.length === 2, 'count=' + topBtns.length);
check('顶栏按钮不带 data-page(否则会被算成侧栏菜单项)',
  topBtns.every((t) => t.indexOf('data-page') === -1), topBtns.join(' | '));
check('顶栏按钮图标走 CSS ::before',
  /#btn-docs::before\s*\{/.test(html) && /#btn-announce::before\s*\{/.test(html));
check('顶栏两个按钮都绑定了点击处理',
  /#btn-docs'\)/.test(inline) && /#btn-announce'\)/.test(inline));

// 🚨 hover 可见性: 这条是"用户反馈 hover 后字看不见"的回归守卫。
// 顶栏底色是白的(--panel), 所以 ghost 按钮悬浮**不能**用白色文字 —— 那是白底白字。
check('.btn.ghost:hover 不用白色文字(白底白字=看不见)',
  !/\.btn\.ghost:hover\s*\{[^}]*color:\s*#fff\b/i.test(html));
check('.btn.ghost:hover 有明确的深色/品牌色文字',
  /\.btn\.ghost:hover\s*\{[^}]*color:\s*var\(--accent\)/.test(html));
check('.btn.ghost:hover 有可见底色(不是近白高亮)',
  /\.btn\.ghost:hover\s*\{[^}]*background:\s*#(?:eef2f7|e3e9f2|eff6ff)/.test(html));
check('公告红点有脉冲动画(有未读时更显眼)', /@keyframes badgePulse/.test(html));

// 操作说明文档
check('存在 openDocs()', /function openDocs\(\)/.test(inline));
check('存在文档数据 DOC_SECTIONS', /const DOC_SECTIONS = \[/.test(inline));
const docSecCount = (inline.match(/id:\s*'[a-z]+',\s*n:\s*'\d+'/g) || []).length;
check('文档章节数 ≥ 6(快速开始/鉴权/示例/流式/模型/错误码/FAQ)', docSecCount >= 6, 'count=' + docSecCount);
check('文档弹窗走宽版 .modal.wide', /\.modal\.wide\s*\{/.test(html));
check('openModal 支持 wide 选项', /o\.wide\s*\?\s*'modal wide'\s*:\s*'modal'/.test(inline));
check('openModal 每次重设 className(不然宽版会污染后续弹窗)',
  /\$\('#modal'\)\.className\s*=/.test(inline));
check('文档左侧目录可点击滚动(doc-link + scrollIntoView)',
  /class="doc-link/.test(inline) && /scrollIntoView\(/.test(inline));
check('代码块带一键复制按钮', /class="cp" type="button"/.test(inline));
check('文档覆盖三种协议端点',
  inline.includes('/v1/chat/completions') && inline.includes('/v1/messages') &&
  inline.includes('/v1beta/models/'));

// 🚨 左右两列**各自独立滚动**(用户反馈: 目录和正文不要一起滚)。
// 做法: 宽版下外层 .modal-body 不滚(overflow:hidden), 高度靠 flex 下传, 两列各带自己的 overflow-y:auto。
check('宽版 modal-body 不滚(把滚动让给左右两列)',
  /\.modal\.wide\s+\.modal-body\s*\{[^}]*overflow:\s*hidden/.test(html));
check('宽版 modal-body 是 flex 列容器(高度靠 flex 下传, 不靠百分比)',
  /\.modal\.wide\s+\.modal-body\s*\{[^}]*display:\s*flex[^}]*flex-direction:\s*column/.test(html));
check('.doc-layout 用 flex:1 撑满高度(高度链才能传到两列)',
  /\.doc-layout\s*\{[^}]*flex:\s*1\s+1\s+auto/.test(html) &&
  /\.doc-layout\s*\{[^}]*min-height:\s*0/.test(html));
// 🚨 反向断言: 不能再退回 height:100% —— .modal 只有 max-height 没有定高,
//    百分比解析不出来会退化成 auto, 两列永远滚不动, 而外层 overflow:hidden 会把长文档裁掉。
//    注意用 htmlNoCss(去注释版), 否则会被上面那段"解释为什么不能用"的注释误伤。
check('🧨 .doc-layout 不再用 height:100%(在只有 max-height 的祖先上解析不出来)',
  !/\.doc-layout\s*\{[^}]*height:\s*100%/.test(htmlNoCss));
check('目录列自己滚(.doc-side overflow-y auto)',
  /\.doc-side\s*\{[^}]*overflow-y:\s*auto/.test(html));
check('正文列自己滚(.doc-main overflow-y auto)',
  /\.doc-main\s*\{[^}]*overflow-y:\s*auto/.test(html));
check('目录不再用 sticky(那是"跟着正文一起滚"的旧做法)',
  !/\.doc-side\s*\{[^}]*position:\s*sticky/.test(html));
check('两列各有细滚动条样式', /\.doc-side::-webkit-scrollbar/.test(html) && /\.doc-main::-webkit-scrollbar/.test(html));
check('窄屏把滚动交回外层(竖屏不再劈两个滚动区)',
  /@media \(max-width: 720px\)[\s\S]*?\.modal\.wide\s+\.modal-body\s*\{\s*overflow-y:\s*auto/.test(html));
check('窄屏收回 flex:1(否则纵排内容被压进外层高度、下半截看不见)',
  /@media \(max-width: 720px\)[\s\S]*?\.doc-layout\s*\{[^}]*flex:\s*0\s+0\s+auto/.test(html));
check('正文滚动时目录高亮跟随(docSyncNav)', /function docSyncNav\(/.test(inline) &&
  /main\.addEventListener\('scroll'/.test(inline));

// 公告弹窗: 🚨 **先弹窗, 再请求**(用户反馈"点按钮几秒没反应")。
// 这条顺序很容易在后续重构里被改回去, 所以静态钉死: openModal 必须出现在 await 取数之前。
const annStart = inline.indexOf('async function openAnnouncements');
const annEnd = inline.indexOf('async function maybeAnnounce');
const annSrc = annStart === -1 || annEnd === -1 ? '' : inline.slice(annStart, annEnd);
check('抠到 openAnnouncements 函数体', annSrc.length > 500, 'len=' + annSrc.length);
const annOpenAt = annSrc.indexOf('openModal(');
const annAwaitAt = annSrc.indexOf('await fetchLiveAnnouncements');
check('公告: 先弹窗再请求(openModal 在 await 取数之前)',
  annOpenAt >= 0 && annAwaitAt > annOpenAt, 'openModal@' + annOpenAt + ' await@' + annAwaitAt);
check('公告: 弹窗先摆等待态(loadingHTML)', /loadingHTML\(/.test(annSrc));
check('公告: 请求回来原地刷新内容(写 .modal-body, 不关掉重开)',
  /\$\('#modal \.modal-body'\)/.test(annSrc) && /innerHTML = annBodyHTML/.test(annSrc));
check('公告: 加载失败给「重试」按钮', /id="ann-retry"/.test(annSrc));
check('公告: 失败不记已读(只有拿到 version 才写)', /if \(version\)/.test(annSrc));
check('公告: 弹窗已被关掉就不再写 DOM',
  /classList\.contains\('hidden'\)/.test(annSrc));
check('公告: 登录自动弹窗复用已拉到的数据(不重复请求)', /preload: data/.test(inline));
check('公告: 全局监听统一收口(连点不会累积)',
  /let annOffPrev/.test(inline) && /annOffPrev\(\)/.test(inline));
check('公告: 失败态与"暂无公告"区分开(带 error 字段)',
  /error: \(e && e\.message\)/.test(inline) && /data\.error/.test(annSrc));

// 🚨 文档代码示例的转义护栏 —— 这是本功能最容易踩的坑:
// 本文件是模板字面量, 求值时**先吃掉一层反斜杠**。
// 所以代码示例里**绝不能出现反斜杠字面量**(想输出一个反斜杠得写四个),
// 也**绝不能写转义单引号**(\' 会退化成转义引号, 把字符串拆坏)。
// 约定: 双引号用 @Q@ 占位、反斜杠用 @B@ 占位, 渲染时 docExpandCode() 再换回来。
const docStart = inline.indexOf('const DOC_SECTIONS');
const docEnd = inline.indexOf('function docBlockHTML');
const docSrc = docStart === -1 || docEnd === -1 ? '' : inline.slice(docStart, docEnd);
check('抠到文档数据段', docSrc.length > 200, 'len=' + docSrc.length);
check('文档示例不含反斜杠字面量(会被模板字面量吃掉)',
  docSrc.indexOf('\\') === -1,
  'first-backslash-at=' + docSrc.indexOf('\\'));
check('文档示例不含转义单引号(会把字符串拆坏)',
  docSrc.indexOf("\\'") === -1);
check('文档示例用 @Q@ 占位双引号', docSrc.indexOf('@Q@') >= 0);
check('存在 docExpandCode() 做占位符还原', /function docExpandCode\(/.test(inline));

// 公告弹窗(用户侧)美化
check('公告条目有图标(ann-head .ico)', /ann-head"><span class="ico">/.test(inline));
check('置顶公告用图钉图标区分', /📌/.test(inline) && /class="ann-item' \+ \(pinned \? ' pin'/.test(inline));
check('公告空态有图标(不是干巴巴一行字)', /class="ann-empty"><span class="ico">/.test(inline));
check('公告正文保留换行(pre-wrap)', /\.ann-body\s*\{[^}]*white-space:\s*pre-wrap/.test(html));

// [9] 右侧内容区改白 + 面板阴影(用户要求: 背景白色 / 布局外边框加阴影)
// 🚨 这套是"白底之后靠阴影分层"的整体方案: 内容区一白, "白卡压灰底"的天然对比就没了,
//    卡片和面板必须各自带阴影, 否则整页糊成一片白。下面每条都是方案的一部分, 别单独删。
check('定义了内容区底色变量 --content 且为白色',
  /--content:\s*#ffffff/i.test(html) || /--content:\s*#fff\b/i.test(html));
check('.main 用 --content 做背景(右侧内容区是白的)',
  /\.main\s*\{[^}]*background:\s*var\(--content\)/.test(html));
check('#app-view 也是白底(宽屏才不会在内容区两侧露出灰边)',
  /#app-view\s*\{[^}]*background:\s*var\(--content\)/.test(html));
check('定义了三档阴影变量', /--shadow-1:/.test(html) && /--shadow-2:/.test(html) && /--shadow-3:/.test(html));
check('.panel 用增强阴影(不是原来那条几乎看不见的 .03)',
  /\.panel\s*\{[^}]*box-shadow:\s*var\(--shadow-2\)/.test(html));
check('.card 也有阴影(白底白卡不分层就会糊)',
  /\.card\s*\{[^}]*box-shadow:\s*var\(--shadow-1\)/.test(html));
check('.card 悬浮有反馈(阴影加深 + 轻微上浮)',
  /\.card:hover\s*\{[^}]*box-shadow:\s*var\(--shadow-3\)/.test(html));
check('面板/卡片用更大圆角 --radius-lg',
  /--radius-lg:/.test(html) && /\.panel\s*\{[^}]*border-radius:\s*var\(--radius-lg\)/.test(html));
// 🚨 反向断言: sticky 标题栏的渐变两档颜色必须跟着内容区走。
//    以前硬编码灰(246,247,249), 内容区改白后标题栏底部会拖出一条灰尾巴。
// ⚠️ 用 htmlNoCss 判: 上面那段注释里原文引用了"以前硬编码的灰(246,247,249)",
//    直接对 html 正则会被自己的注释误伤(这条真的报过一次假 FAIL)。
check('🧨 .page-head 渐变不再硬编码灰色(246,247,249)',
  !/\.page-head\s*\{[^}]*246,\s*247,\s*249/.test(htmlNoCss));
check('.page-head 渐变是白色的', /\.page-head\s*\{[^}]*linear-gradient\([^)]*255,\s*255,\s*255/.test(htmlNoCss));
// 滚动条是"压在内容上"的, thumb 边框色必须跟内容区一致, 否则边上拖一圈灰框
check('滚动条 thumb 边框跟着 --content(不是 --bg)',
  /\.main::-webkit-scrollbar-thumb\s*\{[^}]*border:\s*2px solid var\(--content\)/.test(html));

// [10] 刷新时先显示「会话验证中」的启动引导, 而不是闪一下登录页
// 用户要求: 登录后刷新不要直接显示登录页, 先给等待框(请求/验证中), 会话有效就回到当前 URL 页面,
//          失效才跳登录页。整套做法就是「三个互斥视图 + 默认显示引导」, 顺序反了就退化回老毛病。
check('HTML 有启动引导视图 #boot-view', /<div id="boot-view">/.test(html));
check('引导里有转圈 + "加载"文案', /id="boot-view"[\s\S]{0,300}?class="spinner"[\s\S]{0,300}?正在加载/.test(html));
check('#boot-view 默认可见(display flex)', /#boot-view\s*\{[^}]*display:\s*flex/.test(htmlNoCss));
// 🚨 核心: 登录页默认必须隐藏 —— 它默认 flex 的话首帧就是登录页(本次要修的老毛病)
check('#login-view 默认隐藏(否则刷新会先闪登录页)', /#login-view\s*\{[^}]*display:\s*none/.test(htmlNoCss));
check('🧨 #login-view 不再默认 display:flex',
  !/#login-view\s*\{[^}]*display:\s*flex/.test(htmlNoCss));
check('#register-view 默认隐藏', /#register-view\s*\{[^}]*display:\s*none/.test(htmlNoCss));
check('引导视图有延迟淡入(认证很快时不该闪出一个等待框)',
  /#boot-view\s*\{[^}]*animation:\s*bootFade[\s\S]{0,40}?\.12s/.test(htmlNoCss));
// 三个视图切换函数都要收掉引导屏, 漏一个就会叠着显示 / 一直挡着后面
check('存在 hideBoot()', /function hideBoot\(\)/.test(inline));
check('showApp 会收掉启动引导', /function showApp\(\)\s*\{[\s\S]{0,140}?hideBoot\(\)/.test(inline));
check('showLogin 会收掉启动引导', /function showLogin\(\)\s*\{[\s\S]{0,140}?hideBoot\(\)/.test(inline));
check('showRegister 会收掉启动引导', /function showRegister\([\s\S]{0,160}?hideBoot\(\)/.test(inline));
check('hideBoot 调用点齐全(定义 1 处 + 三个 show* 各 1 次)',
  (inline.match(/hideBoot\(\)/g) || []).length >= 4);
// 会话失效带 ?next= 时要给解释; 而且必须在 showLogin() 之前读 search(之后 URL 可能被改写)
check('登录页会解释"登录状态可能已失效"', /loginBanner\('登录状态可能已失效/.test(inline));
check('init 里先读 ?next= 再 showLogin(顺序反了 next 会被 URL 改写吃掉)', (() => {
  const i = inline.indexOf('(async function init()');
  if (i < 0) return false;
  const seg = inline.slice(i);
  const readNext = seg.indexOf("get('next')");
  const callLogin = seg.indexOf('showLogin();');
  return readNext >= 0 && callLogin > readNext;
})());

// ---------- 11. 批量删除(请求日志 / 操作审计, 2026-09-22) ----------
// 用户要求: 「请求日志 / 操作审计 新增超级管理员可以删除的功能; 删除可以多选、全选;
//            删除之后, 弹窗确认。」
// 三件事都在静态层面钉住: ① 只有超管(IS_ADMIN)才渲染删除控件;
//   ② 表头全选 ↔ 行复选框联动; ③ **先弹确认框再发 DELETE**(顺序反了就等于无确认直接删)。
console.log('\n[9] 批量删除: 多选 / 全选 / 确认弹窗');
check('存在共用的 bindBatchDelete()', /function\s+bindBatchDelete\s*\(/.test(inline));
const bdIdx = inline.indexOf('function bindBatchDelete');
const bdBody = bdIdx === -1 ? '' : (bodyFrom(inline, bdIdx) ?? '');
check('抠到 bindBatchDelete 函数体', bdBody.length > 500, 'len=' + bdBody.length);
check('表头全选会联动所有行复选框',
  /box\.addEventListener\('change'[\s\S]{0,200}?el\.checked = box\.checked/.test(bdBody));
check('半选态用 indeterminate(既不是全选也不是没选)',
  /\.indeterminate\s*=/.test(bdBody));
check('删除按钮回显已选条数', /删除选中 \(' \+ sel\.length/.test(bdBody));
// 🚨 「删除之后弹窗确认」= 必须是"先弹窗, 再删"; 顺序反了就是无确认直接删
const bdModalAt = bdBody.indexOf('openModal(');
const bdDelAt = bdBody.indexOf("method: 'DELETE'");
check('点删除先弹确认框(不是直接删)',
  bdModalAt >= 0 && bdDelAt > bdModalAt, 'openModal@' + bdModalAt + ' delete@' + bdDelAt);
check('确认框显示条数 + 提示不可恢复',
  /条记录吗/.test(bdBody) && /不可恢复/.test(bdBody));
check('确认框有取消 / 确认两个按钮',
  bdBody.includes('id="m-cancel"') && bdBody.includes('id="m-del"'));
check('删除中禁用按钮(防连点重复删)', /b\.disabled = true; b\.textContent = '删除中…'/.test(bdBody));
check('删除成功后刷新列表', /o\.reload\(\)/.test(bdBody));

// 前端得先知道自己是不是超管 —— /me 与 /login 两条路径都要同步 IS_ADMIN,
// 否则"刷新页面后按钮消失 / 登录后按钮消失"这类半死不活的状态
check('IS_ADMIN 声明为模块级状态', /let\s+IS_ADMIN\s*=\s*false/.test(inline));
check('IS_ADMIN 由 /me 与 /login 两处同步',
  (inline.match(/IS_ADMIN = !!me\.is_admin;/g) || []).length >= 2 &&
  /IS_ADMIN = !!data\.is_admin;/.test(inline));

// 请求日志页
const usageRenderIdx = inline.indexOf('function usageRender');
const urBody = usageRenderIdx === -1 ? '' : (bodyFrom(inline, usageRenderIdx) ?? '');
check('请求日志: 抠到 usageRender()', urBody.length > 800, 'len=' + urBody.length);
check('请求日志: 删除控件只在超管时渲染', /const\s+canDel\s*=\s*IS_ADMIN;/.test(urBody));
check('请求日志: 行复选框 + 表头全选框',
  /class="u-row"/.test(urBody) && /id="u-all"/.test(urBody));
check('请求日志: 接了 bindBatchDelete(endpoint=/usage)',
  /rowSel:\s*'\.u-row'/.test(urBody) && /endpoint:\s*'\/usage'/.test(urBody));
check('请求日志: 空态 colspan 把多选列算进去',
  /cols\.length \+ 1 \+ \(canDel \? 1 : 0\)/.test(urBody));

// 操作审计页
const auditRenderIdx = inline.indexOf('function auditRender');
const arBody = auditRenderIdx === -1 ? '' : (bodyFrom(inline, auditRenderIdx) ?? '');
check('操作审计: 抠到 auditRender()', arBody.length > 600, 'len=' + arBody.length);
check('操作审计: 删除控件只在超管时渲染', /const\s+canDel\s*=\s*IS_ADMIN;/.test(arBody));
check('操作审计: 行复选框 + 表头全选框',
  /class="a-row"/.test(arBody) && /id="a-all"/.test(arBody));
check('操作审计: 接了 bindBatchDelete(endpoint=/audit)',
  /rowSel:\s*'\.a-row'/.test(arBody) && /endpoint:\s*'\/audit'/.test(arBody));
check('操作审计: 空态 colspan 含多选列',
  /colspan="' \+ \(6 \+ \(canDel \? 1 : 0\)\)/.test(arBody));

check('CSS: 多选列窄且有勾选框样式',
  /th\.col-sel,\s*td\.col-sel\s*\{[^}]*width:\s*38px/.test(html) &&
  /td\.col-sel input\s*\{[^}]*width:\s*auto/.test(html));

// [11] 使用日志(业务用户视角)脱敏: 详情里不露上游、不露 User-Agent
// 用户要的是「点开详情只看见跟我有关的东西」—— 上游模型名 / 上游账号 / UA 都是网关内部信息,
// 而且后端 /api/admin/logs 现在压根不下发, 前端就算想显示也拿不到(双保险)。
const apiSrc = readFileSync(resolve(here, '../src/admin-api.ts'), 'utf8');
const logDetailIdx = inline.indexOf('function showLogDetail');
const ldBody = logDetailIdx === -1 ? '' : (bodyFrom(inline, logDetailIdx) ?? '');
check('抠到 showLogDetail()', ldBody.length > 500, 'len=' + ldBody.length);
check('🧨 详情里不再显示「上游模型」', ldBody.indexOf("row2('上游模型'") === -1);
check('🧨 详情里不再显示「上游账号」', ldBody.indexOf("row2('上游账号'") === -1);
check('🧨 详情里不再显示「User-Agent」', ldBody.indexOf("row2('User-Agent'") === -1);
check('详情页不读取 l.upstream_model / l.user_agent / l.account_name',
  !/l\.upstream_model/.test(ldBody) && !/l\.user_agent/.test(ldBody) && !/l\.account_(name|platform)/.test(ldBody));
check('详情保留用户关心的字段(时间/结果/模型/令牌/费用)',
  ["row2('时间'", "row2('结果'", "row2('请求模型'", "row2('令牌'", "row2('费用'"].every((s) => ldBody.includes(s)));
check('详情的请求模型回落到 l.model(requested_model 为空时不留白)',
  /l\.requested_model \|\| l\.model \|\| '-'/.test(ldBody));

const logsRenderIdx2 = inline.indexOf('function logsRender');
const lrBody = logsRenderIdx2 === -1 ? '' : (bodyFrom(inline, logsRenderIdx2) ?? '');
check('🧨 列表「模型」列不再优先显示 upstream_model', !/l\.upstream_model \|\| l\.requested_model/.test(lrBody));
check('列表「模型」列显示用户自己发的名字(requested_model → model)',
  /l\.requested_model \|\| l\.model \|\| '-'/.test(lrBody));

// 后端 /logs(业务用户)不下发上游字段
const getLogsIdx = apiSrc.indexOf('async function getSelfLogs');
const glBody = getLogsIdx === -1 ? '' : apiSrc.slice(getLogsIdx, getLogsIdx + 4200);
check('抠到 getLogs()', glBody.length > 2000, 'len=' + glBody.length);
check('🧨 /logs 不再 SELECT l.user_agent', !/l\.user_agent/.test(glBody));
check('🧨 /logs 不再 SELECT l.upstream_model', !/l\.upstream_model/.test(glBody));
check('🧨 /logs 不再 JOIN accounts(上游账号不再出现在响应里)', !/LEFT JOIN accounts a/.test(glBody));
check('🧨 /logs 响应体不含 user_agent / account_name / account_platform / upstream_model',
  !/user_agent:/.test(glBody) && !/account_name/.test(glBody) && !/upstream_model:/.test(glBody));
check('/logs 仍下发用户需要的字段(模型/令牌/费用/IP)',
  ['requested_model:', 'key_name:', 'cost:', 'ip_address:'].every((s) => glBody.includes(s)));
// 管理员侧的「请求日志」(getUsage)必须保留上游字段 —— 排查就靠它
check('管理员侧 getUsage(请求日志)仍保留 user_agent / 上游账号(不能误删)',
  /user_agent:\s*r\.user_agent/.test(apiSrc) && /a\.name AS account_name/.test(apiSrc));

console.log(`\n=== 结果: ${pass} passed, ${fail} failed ===\n`);
process.exit(fail ? 1 : 0);
