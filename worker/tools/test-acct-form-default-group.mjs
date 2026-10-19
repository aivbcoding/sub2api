#!/usr/bin/env node
/**
 * 上游账号表单(acctForm) —— 「新建默认勾选 default 分组」逻辑单测(2026-10-14)。
 *
 * 背景: POST /accounts 在 group_ids 为空时会兜底绑 id 最小的分组
 * (ORDER BY id ASC LIMIT 1, 通常是 default)。以前新建弹窗一个分组都不勾,
 * 保存后后端静默落进默认分组, 界面所见非所得。现在新建时默认勾上
 * id 最小的分组, 用户可改; 编辑模式沿用账号现有绑定。
 *
 * 用法: node tools/test-acct-form-default-group.mjs  (或 npm run test:acctgrp)
 * 提取方式与 check-admin-ui.mjs / test-group-models-fetch.mjs 一致。
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
const fnStart = inline.indexOf('function acctForm');
const fnEnd = inline.indexOf('/** 改完账号配置后提示清理粘性会话 */');
if (fnStart === -1 || fnEnd === -1) {
  console.error('✗ 找不到 acctForm 函数体');
  process.exit(1);
}
const fnSrc = inline.slice(fnStart, fnEnd);

// ---- 迷你 DOM ----
class El {
  constructor(id) {
    this.id = id;
    this._html = '';
    this.value = '';
    this.textContent = '';
    this.disabled = false;
    this.dataset = {};
    this._ev = {};
    this.classList = { toggle() {}, add() {}, remove() {}, contains() { return false; } };
  }
  set innerHTML(v) { this._html = String(v); }
  get innerHTML() { return this._html; }
  addEventListener(type, fn) { (this._ev[type] = this._ev[type] || []).push(fn); }
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

function runAcctForm(a, groups) {
  const els = {};
  const getEl = (key) => (els[key] = els[key] || new El(key));
  const doc = {
    querySelector(sel) { return getEl(sel.startsWith('#') ? sel.slice(1) : sel); },
    querySelectorAll() { return []; },
  };
  const $ = (sel) => doc.querySelector(sel);
  const captured = { modalBody: '', toasts: [] };
  const openModal = (title, body) => { captured.title = title; captured.modalBody = body; };
  const esc = (s) => String(s);
  const toast = (msg) => captured.toasts.push(String(msg));
  const noop = () => {};

  const acctForm = new Function(
    'esc', 'openModal', 'closeModal', 'toast', '$', 'document', 'location',
    'ENTRY_PATH_RESERVED', 'api', 'PAGES', 'askClearSticky', 'CSS',
    fnSrc + '\nreturn acctForm;',
  )(esc, openModal, noop, toast, $, doc, { origin: 'http://test' },
    ['v1', 'models', 'admin', 'api'], noop, { accounts() {} }, noop, { escape: (s) => s });

  const d = {
    platforms: ['openai'],
    protocols: ['openai', 'anthropic'],
    accounts: [],
    protocol_base_url_hints: { openai: 'https://api.openai.com/v1' },
  };
  acctForm(a, d, { groups });
  return captured;
}

function main() {
  console.log('\n=== 上游账号表单 · 新建默认勾选 default 分组 ===\n');

  // 分组故意乱序放, 钉死"取 id 最小"而不是"取列表第一个"
  const groups = [
    { id: 5, name: 'vip' },
    { id: 2, name: 'std' },
    { id: 1, name: 'default' },
  ];

  console.log('[1] 新建模式: 默认勾选 id 最小的分组(default)');
  {
    const c = runAcctForm(null, groups);
    const body = c.modalBody;
    check('弹窗标题 = 添加上游账号', c.title === '添加上游账号', c.title);
    // 抠出绑定分组那一行, 精确断言哪个 value 带了 checked
    const grpRow = body.slice(body.indexOf('f-grp') - 60, body.indexOf('备注'));
    check('default(id=1) 默认勾选', /value="1"[^>]*checked/.test(grpRow), grpRow);
    check('std(id=2) 不勾', !/value="2"[^>]*checked/.test(grpRow), grpRow);
    check('vip(id=5) 不勾', !/value="5"[^>]*checked/.test(grpRow), grpRow);
    check('有兜底说明文案', body.includes('新账号默认进入 id 最小的分组'));
  }

  console.log('\n[2] 编辑模式: 沿用账号现有绑定, 不受默认逻辑影响');
  {
    const c = runAcctForm(
      {
        id: 9, name: 'acct-9', platform: 'openai', protocol: 'openai', type: 'apikey',
        group_ids: [2], priority: 10, concurrency: 3, rate_multiplier: 1,
        status: 'active', schedulable: true, base_url: null, entry_path: null,
        notes: '', credential_preview: 'sk-***',
      },
      groups,
    );
    const body = c.modalBody;
    check('弹窗标题 = 编辑上游账号', c.title === '编辑上游账号', c.title);
    const grpRow = body.slice(body.indexOf('f-grp') - 60, body.indexOf('备注'));
    check('std(id=2) 勾选(账号现有绑定)', /value="2"[^>]*checked/.test(grpRow), grpRow);
    check('default(id=1) 不勾(不被默认逻辑抢走)', !/value="1"[^>]*checked/.test(grpRow), grpRow);
    check('vip(id=5) 不勾', !/value="5"[^>]*checked/.test(grpRow), grpRow);
  }

  console.log('\n[3] 没有任何分组: 不勾也不报错');
  {
    const c = runAcctForm(null, []);
    check('显示"还没有分组"', c.modalBody.includes('还没有分组'), c.modalBody.slice(0, 400));
    check('没有默认勾选逻辑的空引用崩溃', !c.modalBody.includes('undefined'));
  }

  console.log(`\n=== 结果: ${pass} passed, ${fail} failed ===\n`);
  process.exit(fail > 0 ? 1 : 0);
}

main();
