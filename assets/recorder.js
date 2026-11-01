/* recorder.js — CDP 注入式网页操作录制器 v2（无扩展 / 无 Node 依赖）
 * v1 底子来自 web-automation-sop（六级定位/去重/探针），v2 新增数据流抓取：
 *   - paste：贴进来的整块内容（含 \t \n 结构）+ 落点的表格上下文 → 供映射推断按"值"对齐
 *   - copy ：在页面里复制走了什么（平台页选中→复制→贴去在线表 这条链的关键一环）
 *   - download：点了指向表格/压缩包的链接 → 记 href + 猜文件名（真文件名由 CDP 下载事件给）
 * 用法：
 *   1) 把本文件全文作为表达式在页面执行一次
 *   2) __SOP_start()  开始录制（清空）
 *   3) 正常操作页面（click / 输入 / 下拉 / 勾选 / 粘贴 / 复制 / 下载 自动记录）
 *   4) __SOP_dump()   返回 actions JSON 字符串
 * 换页（含 SPA 路由跳转）会丢掉 window.__SOP，需在新页重新注入（record.mjs 会自动补）。
 */
(function () {
  if (window.__SOP) { return 'already-injected'; }

  var S = window.__SOP = {
    actions: [],
    on: false,
    t0: 0,
    lastUrl: location.href,
    navTimer: null
  };

  /* ---------- 6 级定位器 ---------- */
  function validId(id) {
    return id && /^[A-Za-z0-9_\-]+$/.test(id) && !/^[0-9]/.test(id);
  }

  function nthPath(el) {
    var parts = [];
    var cur = el;
    var guard = 0;
    while (cur && cur.nodeType === 1 && guard++ < 12) {
      if (validId(cur.id)) { parts.unshift('#' + cur.id); break; }
      var tag = cur.tagName.toLowerCase();
      var idx = 1;
      var sib = cur;
      while ((sib = sib.previousElementSibling)) {
        if (sib.tagName === cur.tagName) { idx++; }
      }
      parts.unshift(tag + ':nth-of-type(' + idx + ')');
      cur = cur.parentElement;
    }
    return parts.join(' > ');
  }

  function cssOf(el) {
    var tag = el.tagName.toLowerCase();
    var cls = (el.className && typeof el.className === 'string')
      ? el.className.trim().split(/\s+/).filter(function (c) { return c && c.length < 40; }).slice(0, 2)
      : [];
    var base = tag + (cls.length ? '.' + cls.join('.') : '');
    try {
      var n = document.querySelectorAll(base).length;
      return n > 1 ? base + ' [non-unique:' + n + ']' : base;
    } catch (e) { return base; }
  }

  function inferRole(el) {
    var tag = el.tagName.toLowerCase();
    var role = el.getAttribute('role');
    if (role) { return role; }
    if (tag === 'button') { return 'button'; }
    if (tag === 'a') { return 'link'; }
    if (tag === 'input') {
      var t = (el.type || '').toLowerCase();
      if (t === 'checkbox' || t === 'radio') { return t; }
      if (t === 'submit' || t === 'button') { return 'button'; }
    }
    return null;
  }

  function visibleText(el) {
    var t = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
    return t.length > 60 ? t.slice(0, 60) : t;
  }

  function collectLocators(el) {
    var r = { L1_id: null, L2_testid: null, L3_role: null, L4_text: null, L5_css: null, L6_nth_path: null, best: null };
    if (el.id && validId(el.id)) { r.L1_id = '#' + el.id; }
    var tids = ['data-testid', 'data-test', 'data-qa', 'data-cy'];
    for (var i = 0; i < tids.length; i++) {
      var v = el.getAttribute(tids[i]);
      if (v) { r.L2_testid = '[' + tids[i] + '="' + v + '"]'; break; }
    }
    var role = inferRole(el);
    var name = el.getAttribute('aria-label') || visibleText(el);
    if (role && name) { r.L3_role = role + '[name="' + name.slice(0, 40) + '"]'; }
    var tag = el.tagName.toLowerCase();
    if ((tag === 'button' || tag === 'a') && name) { r.L4_text = name; }
    r.L5_css = cssOf(el);
    r.L6_nth_path = nthPath(el);
    var best = r.L1_id || r.L2_testid || r.L3_role || r.L4_text;
    if (!best) { best = (r.L5_css || '').replace(/ \[non-unique:\d+\]/, ''); }
    r.best = best || r.L6_nth_path || tag;
    return r;
  }

  /* ---------- 上下文：字段名 / 区域 / 弹窗 ---------- */
  function fieldLabel(el) {
    var aria = el.getAttribute('aria-label');
    if (aria) { return aria.trim(); }
    var ph = el.getAttribute('placeholder');
    if (el.id) {
      var lab = document.querySelector('label[for="' + el.id + '"]');
      if (lab) { return visibleText(lab); }
    }
    var box = el.closest('.el-form-item, .ant-form-item, .form-item, .form-group, td, li');
    if (box) {
      var l = box.querySelector('label, .el-form-item__label, .ant-form-item-label, .form-label, .label');
      if (l) { var t = visibleText(l).replace(/[:：]\s*$/, ''); if (t) { return t; } }
    }
    return ph || '';
  }

  function sectionOf(el) {
    var tab = document.querySelector('.el-tabs__item.is-active, [aria-selected="true"], .tab-item.active, .nav-item.active');
    var tabText = tab ? visibleText(tab) : '';
    var holder = el.closest('.el-form, form, fieldset, section, .panel, .card');
    var title = '';
    if (holder) {
      var h = holder.querySelector('legend, .section-title, .panel-title, .card-title, h3, h4');
      if (h) { title = visibleText(h); }
    }
    return [tabText, title].filter(Boolean).join(' / ');
  }

  function popupOf(el) {
    var dlg = el.closest('[role="dialog"], .el-dialog, .el-drawer, .ant-modal, .ant-drawer, .modal, .drawer, .layui-layer');
    if (!dlg) { return ''; }
    var id = dlg.id ? '#' + dlg.id : '';
    var t = dlg.querySelector('.el-dialog__title, .ant-modal-title, .el-drawer__title, .modal-title, .layui-layer-title, h3, h4');
    var title = t ? visibleText(t) : '';
    return (title || '弹窗') + (id ? ' (' + id + ')' : '');
  }

  /* ---------- 记录 ---------- */
  function push(type, el, extra) {
    if (!S.on) { return; }
    var loc = collectLocators(el);
    // 去重：下拉/勾选/输入前那次点击是"打开控件"的噪声，同一元素 3 秒内直接吞掉
    if (type !== 'click' && S.actions.length) {
      var prev = S.actions[S.actions.length - 1];
      if (prev.type === 'click' && prev.locator && prev.locator.best && prev.locator.best === loc.best) {
        S.actions.pop();
      }
    }
    var a = {
      seq: S.actions.length + 1,
      type: type,
      at: new Date().toISOString().slice(11, 19),
      url: location.href,
      locator: loc,
      label: fieldLabel(el),
      section: sectionOf(el),
      popup: popupOf(el),
      inFrame: (window.top !== window.self)
    };
    if (extra) { for (var k in extra) { a[k] = extra[k]; } }
    S.actions.push(a);
  }

  function onClick(e) {
    var el = e.target;
    if (!el || el.nodeType !== 1) { return; }
    var dl = downloadInfo(el);
    if (dl) { push('download', el, dl); return; }
    if (el.tagName === 'INPUT' && /^(checkbox|radio)$/i.test(el.type)) {
      push('check', el, { value: el.checked ? '勾选' : '取消勾选', text: fieldLabel(el) });
      return;
    }
    push('click', el, { text: visibleText(el) });
  }

  /* ---------- v2：数据流抓取（下载 / 粘贴 / 复制） ---------- */

  // 链接指向表格/压缩包或带 download 属性 = 一次下载动作
  function downloadInfo(el) {
    if (!el.closest) { return null; }
    var a = el.closest('a[href]');
    if (!a) { return null; }
    var href = a.getAttribute('href') || '';
    var forced = a.hasAttribute('download');
    if (!forced && !/\.(xlsx?|csv|tsv|zip)([?#]|$)/i.test(href)) { return null; }
    var fname = a.getAttribute('download') || href.split('/').pop().split('?')[0] || '';
    return { href: href.slice(0, 300), filename: decodeURIComponent(fname).slice(0, 200), text: visibleText(a) };
  }

  // 粘贴落点的表格上下文：在线表格各家 DOM 都不一样，只抓通用的（行列属性/表头/位置），
  // 列对齐靠分析层按"值"匹配，不依赖这里猜准格子
  function gridContextOf(el) {
    var ctx = { host: location.host, docTitle: document.title, cell: null, header: '' };
    var sels = ['td', '[role="gridcell"]', '[data-row]', '[data-cell]', '[class*="cell"]'];
    var cell = null;
    for (var i = 0; i < sels.length; i++) {
      try { cell = el.closest(sels[i]); } catch (e2) { cell = null; }
      if (cell) { break; }
    }
    if (!cell) { cell = el; }
    var r = cell.getBoundingClientRect();
    ctx.cell = {
      rowAttr: cell.getAttribute('data-row') || cell.getAttribute('data-row-index') || cell.getAttribute('aria-rowindex') || '',
      colAttr: cell.getAttribute('data-col') || cell.getAttribute('data-col-index') || cell.getAttribute('aria-colindex') || '',
      cls: ((typeof cell.className === 'string') ? cell.className : '').slice(0, 120),
      rect: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)]
    };
    if (cell.tagName === 'TD' && cell.cellIndex >= 0) {
      var tr = cell.closest('tr');
      var head = tr ? tr.parentElement.querySelector('thead th:nth-child(' + (cell.cellIndex + 1) + ')') : null;
      if (head) { ctx.header = visibleText(head).slice(0, 40); }
    }
    return ctx;
  }

  function onPaste(e) {
    if (!S.on) { return; }
    var el = e.target;
    if (!el || el.nodeType !== 1) { return; }
    var text = e.clipboardData ? e.clipboardData.getData('text/plain') : '';
    if (!text) { return; }
    var lines = text.split(/\r?\n/);
    var cols = 0;
    for (var i = 0; i < lines.length; i++) {
      var c = lines[i].split('\t').length;
      if (c > cols) { cols = c; }
    }
    push('paste', el, {
      value: text.slice(0, 8000),
      rows: lines.length,
      cols: cols,
      grid: gridContextOf(el)
    });
  }

  function onCopy() {
    if (!S.on) { return; }
    var text = window.getSelection ? String(window.getSelection()) : '';
    text = text.replace(/\r/g, '');
    if (!text.trim()) { return; }
    var lines = text.split('\n');
    var cols = 1;
    for (var i = 0; i < lines.length; i++) {
      var c = lines[i].split('\t').length;
      if (c > cols) { cols = c; }
    }
    push('copy', document.activeElement || document.body, {
      value: text.slice(0, 8000),
      rows: lines.length,
      cols: cols
    });
  }

  function onChange(e) {
    var el = e.target;
    if (!el || el.nodeType !== 1) { return; }
    var tag = el.tagName.toLowerCase();
    if (tag === 'select') {
      var opt = el.options[el.selectedIndex];
      push('select', el, { value: opt ? visibleText(opt) : el.value });
      return;
    }
    if (tag === 'input' || tag === 'textarea') {
      if (/^(checkbox|radio)$/i.test(el.type)) { return; }
      if (el.type === 'file') { push('upload', el, { value: el.value || '(未取到路径)' }); return; }
      push('fill', el, { value: el.value });
    }
  }

  function pollNav() {
    if (!S.on) { return; }
    if (location.href !== S.lastUrl) {
      S.lastUrl = location.href;
      S.actions.push({
        seq: S.actions.length + 1,
        type: 'nav',
        at: new Date().toISOString().slice(11, 19),
        url: location.href,
        locator: { best: null },
        label: document.title,
        section: '',
        popup: '',
        inFrame: (window.top !== window.self)
      });
    }
  }

  function bind(on) {
    var m = on ? 'addEventListener' : 'removeEventListener';
    document[m]('click', onClick, true);
    document[m]('change', onChange, true);
    document[m]('paste', onPaste, true);
    document[m]('copy', onCopy, true);
    if (on) {
      S.navTimer = setInterval(pollNav, 800);
    } else if (S.navTimer) {
      clearInterval(S.navTimer);
      S.navTimer = null;
    }
  }

  /* ---------- 对外接口 ---------- */
  window.__SOP_start = function () {
    S.actions = [];
    S.on = true;
    S.t0 = Date.now();
    S.lastUrl = location.href;
    bind(true);
    return 'recording';
  };

  window.__SOP_stop = function () {
    S.on = false;
    bind(false);
    return S.actions.length;
  };

  window.__SOP_dump = function () {
    return JSON.stringify({
      url: location.href,
      title: document.title,
      injectedAt: new Date(S.t0).toISOString(),
      version: 2,
      count: S.actions.length,
      actions: S.actions
    }, null, 1);
  };

  /* 单点取证：对指定选择器取 6 级定位（不开录制也能用） */
  window.__SOP_pick = function (selector) {
    var el = document.querySelector(selector);
    if (!el) { return null; }
    return JSON.stringify({
      locator: collectLocators(el),
      label: fieldLabel(el),
      section: sectionOf(el),
      popup: popupOf(el),
      text: visibleText(el)
    }, null, 1);
  };

  /* 手册健康检查：传入 SOP 里的 best 列表，逐个判断当前页面还认不认
   * 返回 [{sel, ok, count, text}]，ok=false 即"网页改版了"。 */
  function resolve(sel) {
    if (!sel) { return []; }
    var m;
    if ((m = sel.match(/^getByRole\('([^']+)',\s*\{\s*name:\s*'([^']*)'/))) {
      var role = m[1], name = m[2];
      var map = { button: 'button,input[type=button],input[type=submit]', link: 'a', textbox: 'input,textarea', combobox: 'select', checkbox: 'input[type=checkbox]', radio: 'input[type=radio]' };
      var pool = document.querySelectorAll(map[role] || '*');
      var hits = [];
      for (var i = 0; i < pool.length; i++) {
        var t = (pool[i].getAttribute('aria-label') || visibleText(pool[i]) || '');
        if (t.indexOf(name) === 0 || t === name) { hits.push(pool[i]); }
      }
      return hits;
    }
    if ((m = sel.match(/^getByText\('([^']*)'/))) {
      var kw = m[1], all = document.querySelectorAll('body *'), out = [];
      for (var j = 0; j < all.length; j++) {
        if (all[j].children.length === 0 && visibleText(all[j]).indexOf(kw) >= 0) { out.push(all[j]); }
      }
      return out;
    }
    try { return Array.prototype.slice.call(document.querySelectorAll(sel.replace(/ \[non-unique:\d+\]/, ''))); }
    catch (e) { return []; }
  }

  window.__SOP_probe = function (list) {
    var res = [];
    for (var i = 0; i < list.length; i++) {
      var sel = list[i];
      var els = resolve(sel);
      res.push({ sel: sel, ok: els.length > 0, count: els.length, text: els.length ? visibleText(els[0]) : '' });
    }
    return JSON.stringify(res);
  };

  return 'ready';
})();
