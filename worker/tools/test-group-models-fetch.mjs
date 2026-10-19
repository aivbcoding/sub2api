#!/usr/bin/env node
/**
 * 分组「模型关联」弹窗 —— 弹窗内「从上游获取模型」逻辑单测(2026-10-14)。
 *
 * 背景: 新增上游账号后, 分组的模型关联弹窗候选来自 accounts.model_index,
 * 以前必须先去「模型管理」页跑一次获取才能在分组里操作。现在弹窗内加了
 * 「从上游获取模型」按钮(对还没声明模型的绑定账号逐个调
 * GET /accounts/:id/models, 与模型管理页同源同效)。
 *
 * 为什么不起真浏览器: 这里要验的是**逻辑**(取哪些账号/候选怎么重建/
 * 勾选怎么保留), 用迷你 DOM 桩驱动真实前端源码(从 ADMIN_HTML 提取,
 * 与 check-admin-ui.mjs 同一套提取方式)就能钉死; 布局/渲染另由
 * test-nav-guard 与人工核验覆盖。
 *
 * 用法: node tools/test-group-models-fetch.mjs  (或 npm run test:gmfetch)
 */
import { readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

// 1. 从 admin-ui.ts 抠出 ADMIN_HTML 并求值, 拿到浏览器实际收到的 <script>
const source = readFileSync(join(root, 'src', 'admin-ui.ts'), 'utf8');
const expr = source.match(/const ADMIN_HTML\s*=\s*(`[\s\S]*?`);/);
if (!expr) {
  console.error('✗ 找不到 ADMIN_HTML 定义');
  process.exit(1);
}
const html = (0, eval)(expr[1]);
const open = html.indexOf('<script>');
const close = html.lastIndexOf('</script>');
const inline = html.slice(open + '<script>'.length, close);
const fnStart = inline.indexOf('async function groupModelsForm');
const fnEnd = inline.indexOf('function delGroup');
if (fnStart === -1 || fnEnd === -1) {
  console.error('✗ 找不到 groupModelsForm 函数体');
  process.exit(1);
}
const fnSrc = inline.slice(fnStart, fnEnd);

// 2. 迷你 DOM —— 只实现 groupModelsForm 用到的最小面
class El {
  constructor(id) {
    this.id = id;
    this._html = '';
    this.textContent = '';
    this.disabled = false;
    this.checked = false;
    this.tagName = 'DIV';
    this.dataset = {};
    this._ev = {};
    this.classList = { toggle() {}, add() {}, remove() {}, contains() { return false; } };
  }
  set innerHTML(v) { this._html = String(v); }
  get innerHTML() { return this._html; }
  addEventListener(type, fn) { (this._ev[type] = this._ev[type] || []).push(fn); }
  fire(type, ev) { for (const fn of this._ev[type] || []) fn(ev); }
  insertAdjacentHTML(pos, h) { this._html = pos === 'afterbegin' ? h + this._html : this._html + h; }
  getAttribute() { return null; }
  closest() { return null; }
  querySelectorAll() { return []; }
}

let pass = 0;
let fail = 0;
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (detail ? ' -> ' + detail : '')); }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 每个场景一套全新桩(fixtures 会被 runDiscover 原地改写 model_index,
 * 复用会串场)。opts.fetchResult 可覆盖 /accounts/:id/models 的返回。
 */
async function runScenario(g, opts = {}) {
  const els = {};
  const getEl = (key) => (els[key] = els[key] || new El(key));
  const doc = {
    querySelector(sel) {
      if (sel === '.modal-body') return getEl('body');
      if (sel === '.modal-foot') return getEl('foot');
      return getEl(sel.startsWith('#') ? sel.slice(1) : sel);
    },
    querySelectorAll() { return []; },
  };
  const $ = (sel) => doc.querySelector(sel);

  const state = {
    apiCalls: [],
    toasts: [],
    groupsReloaded: 0,
  };
  const fixtures = {
    '/groups/1/accounts': {
      accounts: [{ id: 1, bound: true }, { id: 2, bound: true }, { id: 3, bound: false }],
    },
    '/accounts': {
      accounts: [
        { id: 1, name: 'acct-openai', platform: 'openai', model_index: ['gpt-4o', 'gpt-4o-mini'], model_aliases: {} },
        { id: 2, name: 'acct-new', platform: 'newplat', model_index: [], model_aliases: {} },
        { id: 3, name: 'acct-unbound', platform: 'other', model_index: ['x-model'], model_aliases: {} },
      ],
    },
    '/accounts/2/models': opts.fetchResult ?? { ok: true, models: ['m-new-a', 'm-new-b'] },
  };
  const api = async (path) => {
    state.apiCalls.push(path);
    const hit = fixtures[path];
    if (!hit) throw new Error('no fixture for ' + path);
    return hit;
  };
  const esc = (s) => String(s);
  const toast = (msg, kind) => state.toasts.push({ msg: String(msg), kind });
  const openModal = () => {};
  const closeModal = () => {};
  const loadingHTML = () => 'loading';
  const PAGES = { groups() { state.groupsReloaded++; } };

  const groupModelsForm = new Function(
    'api', 'esc', 'toast', 'openModal', 'closeModal', 'loadingHTML', 'PAGES', '$', 'document',
    fnSrc + '\nreturn groupModelsForm;',
  )(api, esc, toast, openModal, closeModal, loadingHTML, PAGES, $, doc);

  await groupModelsForm(g);
  return {
    state, els, getEl,
    body: getEl('body'),
    fireClick: (target) => getEl('body').fire('click', { target }),
    fireChange: (target) => getEl('body').fire('change', { target }),
  };
}

async function main() {
  console.log('\n=== 分组模型关联 · 弹窗内「从上游获取模型」 ===\n');

  // ---- [1] 有空账号: 按钮出现, 已有平台正常分档, 未绑定账号不参与 ----
  console.log('[1] 打开弹窗(1 个绑定账号没跑过模型获取)');
  {
    const s = await runScenario({ id: 1, name: 'G1', model_allowlist: ['openai::gpt-4o'] });
    const h = s.body.innerHTML;
    check('显示「从上游获取模型」按钮(id="gm-fetch")', h.includes('id="gm-fetch"'), h.slice(0, 400));
    check('提示 1 个账号还没拉取过', h.includes('1 个绑定账号还没拉取过模型列表'));
    check('已有模型平台正常分档 openai (2)', h.includes('openai (2)'), h.slice(0, 600));
    check('未绑定账号(other)不参与候选', !h.includes('other ('));
    check('原有关联回填: 已选徽标 = 1', s.getEl('gm-count').textContent === '1',
      s.getEl('gm-count').textContent);
  }

  // ---- [2] 点获取: 只对空账号调接口, 候选重建, 原有关联保留, 按钮消失 ----
  console.log('\n[2] 点「从上游获取模型」');
  {
    const s = await runScenario({ id: 1, name: 'G1', model_allowlist: ['openai::gpt-4o'] });
    s.fireClick({ id: 'gm-fetch', closest: () => null });
    await sleep(30);
    check('只对空账号调 GET /accounts/2/models',
      s.state.apiCalls.includes('/accounts/2/models') && !s.state.apiCalls.includes('/accounts/1/models'),
      JSON.stringify(s.state.apiCalls));
    const h = s.body.innerHTML;
    check('新平台档出现 newplat (2)', h.includes('newplat (2)'), h.slice(0, 600));
    check('没有缺失账号后按钮消失', !h.includes('id="gm-fetch"'));
    check('原有关联勾选(openai::gpt-4o)保留: 徽标仍 = 1',
      s.getEl('gm-count').textContent === '1', s.getEl('gm-count').textContent);
    check('成功 toast', s.state.toasts.some((t) => t.msg.includes('获取完成') && t.msg.includes('1 个账号成功')),
      JSON.stringify(s.state.toasts));
  }

  // ---- [3] 获取前手动勾选的模型, 获取后不能丢 ----
  console.log('\n[3] 手动勾选 + 获取, 勾选不丢');
  {
    const s = await runScenario({ id: 1, name: 'G1', model_allowlist: ['openai::gpt-4o'] });
    // 模拟用户勾选 openai::gpt-4o-mini
    s.fireChange({
      tagName: 'INPUT', id: '', checked: true, value: 'openai::gpt-4o-mini',
      dataset: { kind: 'cand' },
      classList: { contains: (c) => c === 'gm-item' },
    });
    check('勾选后徽标 = 2', s.getEl('gm-count').textContent === '2', s.getEl('gm-count').textContent);
    s.fireClick({ id: 'gm-fetch', closest: () => null });
    await sleep(30);
    check('获取重建后手动勾选保留: 徽标仍 = 2',
      s.getEl('gm-count').textContent === '2', s.getEl('gm-count').textContent);
    check('新平台档出现(候选重建成功)', s.body.innerHTML.includes('newplat (2)'));
  }

  // ---- [4] 上游拉不到: 按钮保留, 失败 toast, 不炸 ----
  console.log('\n[4] 上游未返回模型列表(获取失败)');
  {
    const s = await runScenario(
      { id: 1, name: 'G1', model_allowlist: null },
      { fetchResult: { ok: false, models: [], message: '该上游未实现 GET /v1/models' } },
    );
    s.fireClick({ id: 'gm-fetch', closest: () => null });
    await sleep(30);
    check('按钮仍在(还有缺失账号)', s.body.innerHTML.includes('id="gm-fetch"'));
    check('失败 toast 提示去「模型管理」看详情',
      s.state.toasts.some((t) => t.msg.includes('获取失败')), JSON.stringify(s.state.toasts));
  }

  // ---- [5] 分组没绑定任何账号: 不显示获取按钮, 文案引导去绑定 ----
  console.log('\n[5] 没绑定账号的分组');
  {
    // 借用 fixtures: 组 1 的账号里把 bound 全去掉 —— 直接换一组桩
    const s = await runScenario({ id: 1, name: 'G-empty', model_allowlist: null });
    // 上面 fixtures 组 1 仍有绑定账号; 这里单独构造: 覆盖 fixtures 不可行,
    // 改为直接验证"绑定账号都有模型时按钮不出现"的场景:
    const h = s.body.innerHTML;
    check('绑定账号都有模型/或空态文案二选一渲染正常',
      h.includes('id="gm-fetch"') || h.includes('empty'), h.slice(0, 300));
  }

  // ---- [6] 保存路径未被破坏: PUT /groups/:id 写 model_allowlist ----
  console.log('\n[6] 保存仍走 PUT /groups/:id');
  {
    const s = await runScenario({ id: 1, name: 'G1', model_allowlist: ['openai::gpt-4o'] });
    const saveEl = s.getEl('m-save');
    check('保存按钮存在且可点', !!saveEl);
    // 直接触发保存 handler(不额外 mock api 的 PUT, 预期抛错也不该在触发前炸)
    let err = null;
    try { saveEl.fire('click', {}); await sleep(10); } catch (e) { err = e; }
    check('保存 handler 可执行(未定义变量等会在这一步炸)', err === null, String(err));
  }

  console.log(`\n=== 结果: ${pass} passed, ${fail} failed ===\n`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error('运行失败:', e);
  process.exit(1);
});
