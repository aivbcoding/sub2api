#!/usr/bin/env node
/**
 * 使用日志页 —— 「签到记录」(2026-10-16 老板需求)两个可见面的单测:
 *   1) 列表: 签到行 = 模型/令牌/Tokens/耗时全空 + 蓝色「+额度」; 表头「使用记录」
 *   2) 详情: 「每日签到成功, 增加额度 +$25.0000」+ 签到时间/签到日/记录 ID
 * 做法同 test-group-models-fetch.mjs: 从 ADMIN_HTML 提取**真实前端源码**,
 * 用迷你 DOM 驱动, 不启浏览器。
 *
 * 用法: node tools/test-logs-checkin-row.mjs  (或 npm run test:logsck)
 */
import { readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

const source = readFileSync(join(root, 'src', 'admin-ui.ts'), 'utf8');
const expr = source.match(/const ADMIN_HTML\s*=\s*(`[\s\S]*?`);/);
if (!expr) {
  console.error('✗ 找不到 ADMIN_HTML 定义');
  process.exit(1);
}
const html = (0, eval)(expr[1]);
const inline = html.slice(html.indexOf('<script>') + '<script>'.length, html.lastIndexOf('</script>'));

function slice(from, to) {
  const i = inline.indexOf(from);
  const j = inline.indexOf(to, i);
  if (i === -1 || j === -1) {
    console.error('✗ 切片失败: ' + from + ' -> ' + to);
    process.exit(1);
  }
  return inline.slice(i, j);
}
// 注意切到 **function logsRender** 为止(不能切到 'function logsFetch'):
// 中间还夹着 `PAGES.logs = async () => {...}` 一整段, 从 'async' 后截断会留下
// 半个表达式("async is not defined")。PAGES.logs 引用的 navTok/gone/loadingHTML
// 都不在测试里执行, 只要语句完整就不会炸。
const src =
  slice('const logsState =', 'function logsRender') +
  '\n' + slice('function logsRender', '/** 单条使用记录的详情弹窗 */') +
  '\n' + slice('/** 单条使用记录的详情弹窗 */', '// ======================= 个人资料');

// ---- 迷你 DOM ----
class El {
  constructor(id) {
    this.id = id;
    this._html = '';
    this.textContent = '';
    this.value = '';
    this.disabled = false;
    this._ev = {};
  }
  set innerHTML(v) { this._html = String(v); }
  get innerHTML() { return this._html; }
  addEventListener(t, fn) { (this._ev[t] = this._ev[t] || []).push(fn); }
  insertAdjacentHTML(p, h) { this._html = p === 'afterbegin' ? h + this._html : this._html + h; }
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

function build() {
  const els = {};
  const getEl = (k) => (els[k] = els[k] || new El(k));
  const doc = {
    querySelector(sel) { return getEl(sel.startsWith('#') ? sel.slice(1) : sel); },
    querySelectorAll() { return []; },
  };
  const $ = (sel) => doc.querySelector(sel);
  const captured = { modalTitle: '', modalBody: '' };
  const PAGES = {};
  const stubs = {
    esc: (s) => String(s == null ? '' : s),
    fmtTime: () => '2026-10-16 15:30:00',
    fmtNum: (v) => String(Number(v || 0)),
    fmtMoney: (v) => '$' + Number(v || 0).toFixed(4),
    statCard: (t, v) => '<div class="card">' + t + ':' + v + '</div>',
    row2: (k, v) => '<tr><td>' + k + '</td><td>' + v + '</td></tr>',
    openModal: (title, body) => { captured.modalTitle = title; captured.modalBody = body; },
    closeModal: () => {},
    $,
    document: doc,
    PAGES,
  };
  const api = new Function(
    'esc', 'fmtTime', 'fmtNum', 'fmtMoney', 'statCard', 'row2', 'openModal', 'closeModal', '$', 'document', 'PAGES',
    src + '\nreturn { logsRender, showLogDetail, logsState };',
  )(stubs.esc, stubs.fmtTime, stubs.fmtNum, stubs.fmtMoney, stubs.statCard, stubs.row2,
    stubs.openModal, stubs.closeModal, $, doc, PAGES);
  return { api, getEl, captured, PAGES };
}

const checkinRow = {
  id: -1,
  request_id: 'checkin:2026-10-16',
  created_at: '2026-10-16T07:30:00.000Z',
  requested_model: '',
  model: '',
  billing_mode: 'checkin',
  checkin: true,
  credit: 25.5,
  input_tokens: 0,
  output_tokens: 0,
  cache_read_tokens: 0,
  cache_creation_tokens: 0,
  cost: 0,
  duration_ms: 0,
  first_token_ms: null,
  stream: false,
  ip_address: '',
  key_id: null,
  key_name: '',
  key_value: '',
  error: false,
};

const callRow = {
  id: 77,
  request_id: 'req-abc',
  created_at: '2026-10-16T07:20:00.000Z',
  requested_model: 'gpt-4o',
  model: 'gpt-4o',
  billing_mode: 'token',
  checkin: false,
  credit: 0,
  input_tokens: 120,
  output_tokens: 30,
  cache_read_tokens: 0,
  cache_creation_tokens: 0,
  cost: 0.0123,
  duration_ms: 1200,
  first_token_ms: 200,
  stream: true,
  ip_address: '1.2.3.4',
  key_id: 5,
  key_name: '我的Key',
  key_value: 'sk-abcd***',
  error: false,
};

function main() {
  console.log('\n=== 使用日志页 · 签到记录渲染 ===\n');

  console.log('[1] 列表: 表头改名 + 双行共存');
  {
    const { api, getEl } = build();
    api.logsRender({
      logs: [callRow, checkinRow],
      summary: { requests: 1, errors: 0, tokens: 150, cost: 0.0123 },
      models: [],
      total: 2,
      limit: 50,
      offset: 0,
    });
    const h = getEl('main').innerHTML;
    check('表头文案 = 使用记录(不再是「调用记录」)', h.includes('使用记录 (共') && !h.includes('调用记录'),
      h.slice(h.indexOf('使用记录') - 40, h.indexOf('使用记录') + 40));
    check('签到行: 显示「每日签到」标签', h.includes('每日签到'));
    check('签到行: 费用列 = 蓝色 +$25.5000', h.includes('+$25.5000') && h.includes('color:#2563eb'));
    check('普通行: 模型名照常显示', h.includes('gpt-4o') && h.includes('我的Key'));
    check('签到行不出现令牌名(空字段)', !h.includes('每日签到</span></td>\n<td class="mono">我的Key'));
  }

  console.log('\n[2] 空态文案');
  {
    const { api, getEl } = build();
    api.logsRender({ logs: [], summary: {}, models: [], total: 0, limit: 50, offset: 0 });
    const h = getEl('main').innerHTML;
    check('无记录时 = 「还没有使用记录」', h.includes('还没有使用记录') && !h.includes('还没有调用记录'));
  }

  console.log('\n[3] 详情弹窗(签到行)');
  {
    const { api, captured } = build();
    api.logsRender({ logs: [checkinRow], summary: {}, models: [], total: 1, limit: 50, offset: 0 });
    api.showLogDetail(-1);
    check('标题 = 使用详情 #-1', captured.modalTitle === '使用详情 #-1', captured.modalTitle);
    const b = captured.modalBody;
    check('正文含「每日签到成功」', b.includes('每日签到成功'), b.slice(0, 200));
    check('正文含「增加额度 +$25.5000」', b.includes('增加额度') && b.includes('+$25.5000'), b.slice(0, 300));
    check('含「签到时间」行', b.includes('签到时间'));
    check('含「签到日 (北京时间) 2026-10-16」', b.includes('签到日 (北京时间)') && b.includes('2026-10-16'));
    check('含记录 ID 与规则说明', b.includes('checkin:2026-10-16') && b.includes('随机 +50 ~ 100'));
  }

  console.log('\n[4] 详情弹窗(普通调用行)不受影响');
  {
    const { api, captured } = build();
    api.logsRender({ logs: [callRow], summary: {}, models: [], total: 1, limit: 50, offset: 0 });
    api.showLogDetail(77);
    check('标题 = 使用详情 #77', captured.modalTitle === '使用详情 #77', captured.modalTitle);
    check('正文含普通字段(请求模型/费用/耗时)',
      captured.modalBody.includes('gpt-4o') && captured.modalBody.includes('费用') && captured.modalBody.includes('耗时'));
    check('普通详情不含签到文案', !captured.modalBody.includes('每日签到成功'));
  }

  console.log(`\n=== 结果: ${pass} passed, ${fail} failed ===\n`);
  process.exit(fail > 0 ? 1 : 0);
}

main();
