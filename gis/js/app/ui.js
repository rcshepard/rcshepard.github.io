/*
 * PSICITS — small UI toolkit: element builder, icons, toasts, dialogs, menus.
 */
(function (root) {
  'use strict';

  const M = root.PSICITS;
  const util = M.util;
  const ui = (M.ui = {});

  /**
   * h('div.cls#id', { onclick, title, ... }, children...)
   * Children: strings (text), Nodes, arrays, null/false (skipped).
   */
  ui.h = function (sel, attrs) {
    const m = /^([a-z0-9-]+)?((?:[.#][\w-]+)*)$/i.exec(sel || 'div');
    const el = document.createElement((m && m[1]) || 'div');
    if (m && m[2]) {
      m[2].replace(/([.#])([\w-]+)/g, function (_, k, v) { if (k === '.') el.classList.add(v); else el.id = v; return ''; });
    }
    let kids = Array.prototype.slice.call(arguments, 2);
    if (attrs && (typeof attrs !== 'object' || attrs instanceof Node || Array.isArray(attrs))) { kids.unshift(attrs); attrs = null; }
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        const v = attrs[k];
        if (v === undefined || v === null || v === false) return;
        if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
        else if (k === 'class') String(v).split(/\s+/).filter(Boolean).forEach(function (c) { el.classList.add(c); });
        else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
        else if (k === 'html') el.innerHTML = v; // only for trusted, escaped strings
        else if (k === 'dataset') Object.assign(el.dataset, v);
        else if (k in el && typeof v !== 'string') el[k] = v;
        else el.setAttribute(k, v === true ? '' : v);
      });
    }
    const add = function (c) {
      if (c === null || c === undefined || c === false) return;
      if (Array.isArray(c)) { c.forEach(add); return; }
      el.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
    };
    kids.forEach(add);
    return el;
  };
  const h = ui.h;

  /* ---------------------------------------------------------------- icons */

  // 24x24 stroke icons (MIT-style, drawn for PSICITS).
  const P = {
    layers: '<path d="M12 3 2 8l10 5 10-5-10-5Z"/><path d="m2 13 10 5 10-5"/><path d="m2 18 10 5 10-5" opacity=".5"/>',
    eye: '<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/>',
    eyeoff: '<path d="M3 3l18 18"/><path d="M10.6 5.1A9.6 9.6 0 0 1 12 5c6.4 0 10 7 10 7a17 17 0 0 1-3 3.8M6.6 6.6A16.8 16.8 0 0 0 2 12s3.6 7 10 7a9.4 9.4 0 0 0 4.3-1"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/>',
    trash: '<path d="M4 7h16"/><path d="M10 11v6M14 11v6"/><path d="M6 7l1 13h10l1-13"/><path d="M9 7V4h6v3"/>',
    zoom: '<circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/><path d="M8 11h6M11 8v6"/>',
    table: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 10h18M3 15h18M9 4v16"/>',
    palette: '<path d="M12 3a9 9 0 1 0 0 18c1.1 0 2-.9 2-2 0-.5-.2-1-.5-1.3-.3-.4-.5-.8-.5-1.3 0-1.1.9-2 2-2h2.3A4.7 4.7 0 0 0 22 9.7C22 5.9 17.5 3 12 3Z"/><circle cx="7.5" cy="11" r="1.2"/><circle cx="10" cy="7" r="1.2"/><circle cx="14.5" cy="7" r="1.2"/>',
    more: '<circle cx="5" cy="12" r="1.3"/><circle cx="12" cy="12" r="1.3"/><circle cx="19" cy="12" r="1.3"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    close: '<path d="M6 6l12 12M18 6 6 18"/>',
    chevron: '<path d="m9 6 6 6-6 6"/>',
    chevdown: '<path d="m6 9 6 6 6-6"/>',
    grip: '<circle cx="9" cy="6" r="1"/><circle cx="15" cy="6" r="1"/><circle cx="9" cy="12" r="1"/><circle cx="15" cy="12" r="1"/><circle cx="9" cy="18" r="1"/><circle cx="15" cy="18" r="1"/>',
    upload: '<path d="M12 16V4"/><path d="m7 9 5-5 5 5"/><path d="M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3"/>',
    download: '<path d="M12 4v12"/><path d="m7 11 5 5 5-5"/><path d="M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3"/>',
    play: '<path d="M7 5v14l11-7L7 5Z"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/>',
    point: '<circle cx="12" cy="12" r="4"/>',
    line: '<path d="M4 18 10 8l4 6 6-9"/><circle cx="4" cy="18" r="1.5"/><circle cx="20" cy="5" r="1.5"/>',
    polygon: '<path d="M5 8 12 3l7 5-2 11H7L5 8Z"/>',
    rect: '<rect x="4" y="6" width="16" height="12" rx="1"/>',
    circle: '<circle cx="12" cy="12" r="8"/>',
    freehand: '<path d="M4 16c3-6 5 2 8-3s5-4 8-1"/>',
    raster: '<rect x="3" y="3" width="8" height="8"/><rect x="13" y="3" width="8" height="8" opacity=".55"/><rect x="3" y="13" width="8" height="8" opacity=".35"/><rect x="13" y="13" width="8" height="8" opacity=".75"/>',
    tiles: '<path d="M3 3h8v8H3zM13 3h8v8h-8zM3 13h8v8H3zM13 13h8v8h-8z"/>',
    table2: '<path d="M4 6h16M4 12h16M4 18h16"/>',
    pencil: '<path d="M4 20h4L19 9l-4-4L4 16v4Z"/><path d="m13 7 4 4"/>',
    undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h11a5 5 0 0 1 0 10h-3"/>',
    redo: '<path d="m15 14 5-5-5-5"/><path d="M20 9H9a5 5 0 0 0 0 10h3"/>',
    help: '<circle cx="12" cy="12" r="9"/><path d="M9.5 9a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6V14"/><circle cx="12" cy="17.3" r=".6"/>',
    terminal: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="m7 9 3 3-3 3M12 15h5"/>',
    toolbox: '<rect x="3" y="7" width="18" height="13" rx="2"/><path d="M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M3 12h18"/>',
    globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 2.5 3.8 5.5 3.8 9s-1.3 6.5-3.8 9c-2.5-2.5-3.8-5.5-3.8-9S9.5 5.5 12 3Z"/>',
    ruler: '<path d="M3 17 17 3l4 4L7 21l-4-4Z"/><path d="m7 13 2 2M10 10l2 2M13 7l2 2"/>',
    cursor: '<path d="m5 3 14 8-6 2-2 6L5 3Z"/>',
    moon: '<path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5Z"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
    map: '<path d="M9 4 3 6v14l6-2 6 2 6-2V4l-6 2-6-2Z"/><path d="M9 4v14M15 6v14"/>',
    folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z"/>',
    save: '<path d="M5 3h11l3 3v13a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z"/><path d="M7 3v5h8V3M7 21v-7h10v7"/>',
    filter: '<path d="M4 5h16l-6 8v5l-4 2v-7L4 5Z"/>',
    check: '<path d="m5 12 5 5 9-10"/>',
    warn: '<path d="M12 3 2 20h20L12 3Z"/><path d="M12 10v4"/><circle cx="12" cy="17" r=".6"/>',
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6"/><circle cx="12" cy="7.5" r=".6"/>',
    link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3A4 4 0 0 0 11 18.7l1-1"/>',
    stop: '<rect x="6" y="6" width="12" height="12" rx="1"/>',
    copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3"/>',
    sidebar: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/>',
    panelright: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M15 4v16"/>',
    panelbottom: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 14h18"/>',
    gdal: '<path d="M4 7h16M4 12h10M4 17h13"/><circle cx="19" cy="12" r="2"/>',
    code: '<path d="m8 8-4 4 4 4M16 8l4 4-4 4M13.5 5l-3 14"/>',
  };
  ui.icon = function (name, size) {
    const s = size || 16;
    const span = document.createElement('span');
    span.className = 'ps-icon';
    span.innerHTML = '<svg viewBox="0 0 24 24" width="' + s + '" height="' + s + '" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + (P[name] || P.info) + '</svg>';
    return span;
  };

  /** Icon button. */
  ui.iconButton = function (icon, title, onClick, cls) {
    return h('button.ps-iconbtn' + (cls ? '.' + cls : ''), { type: 'button', title: title, 'aria-label': title, onclick: onClick }, ui.icon(icon));
  };

  /* --------------------------------------------------------------- toasts */

  let toastHost = null;
  ui.toast = function (msg, kind, ms) {
    if (!toastHost) { toastHost = h('div.ps-toasts', { role: 'status', 'aria-live': 'polite' }); document.body.appendChild(toastHost); }
    const t = h('div.ps-toast.ps-' + (kind || 'info'), ui.icon(kind === 'error' ? 'warn' : kind === 'success' ? 'check' : 'info'), h('span', msg));
    toastHost.appendChild(t);
    setTimeout(function () { t.classList.add('ps-out'); setTimeout(function () { t.remove(); }, 300); }, ms || (kind === 'error' ? 6000 : 3200));
  };

  /* ---------------------------------------------------------------- modal */

  /**
   * ui.modal({ title, body: Node|string, actions: [{ label, primary, danger, value }], wide })
   * Resolves with the chosen action's value (undefined when dismissed).
   */
  ui.modal = function (opts) {
    return new Promise(function (resolve) {
      const prevFocus = document.activeElement;
      const close = function (v) {
        document.removeEventListener('keydown', onKey, true);
        overlay.remove();
        if (prevFocus && prevFocus.focus) prevFocus.focus();
        resolve(v);
      };
      const onKey = function (e) {
        if (e.key === 'Escape') { e.stopPropagation(); close(undefined); }
        if (e.key === 'Enter' && !e.shiftKey && e.target.tagName !== 'TEXTAREA' && e.target.tagName !== 'SELECT' && e.target.tagName !== 'BUTTON') {
          const prim = (opts.actions || []).find(function (a) { return a.primary; });
          if (prim) { e.preventDefault(); close(typeof prim.value === 'function' ? prim.value() : prim.value !== undefined ? prim.value : true); }
        }
      };
      const body = typeof opts.body === 'string' ? h('div.ps-modal-text', opts.body) : opts.body;
      const actions = (opts.actions || [{ label: 'OK', primary: true, value: true }]).map(function (a) {
        return h('button.ps-btn' + (a.primary ? '.ps-primary' : '') + (a.danger ? '.ps-danger' : ''), {
          type: 'button',
          onclick: function () { close(typeof a.value === 'function' ? a.value() : a.value !== undefined ? a.value : a.label); },
        }, a.label);
      });
      const dlg = h('div.ps-modal' + (opts.wide ? '.ps-wide' : ''), { role: 'dialog', 'aria-modal': 'true', 'aria-label': opts.title || 'Dialog' },
        h('div.ps-modal-head', h('h2', opts.title || ''), ui.iconButton('close', 'Close', function () { close(undefined); })),
        h('div.ps-modal-body', body),
        actions.length ? h('div.ps-modal-foot', actions) : null);
      const overlay = h('div.ps-overlay', { onmousedown: function (e) { if (e.target === overlay) close(undefined); } }, dlg);
      document.body.appendChild(overlay);
      document.addEventListener('keydown', onKey, true);
      const focusable = dlg.querySelector('input, select, textarea, .ps-primary');
      if (focusable) setTimeout(function () { focusable.focus(); if (focusable.select) focusable.select(); }, 30);
      if (opts.onOpen) opts.onOpen(dlg, close);
    });
  };

  ui.confirm = function (message, opts) {
    opts = opts || {};
    return ui.modal({ title: opts.title || 'Please confirm', body: message, actions: [{ label: 'Cancel', value: false }, { label: opts.ok || 'OK', primary: true, danger: !!opts.danger, value: true }] }).then(function (v) { return v === true; });
  };

  ui.prompt = function (message, value, opts) {
    opts = opts || {};
    const input = h('input.ps-input', { type: 'text', value: value || '', placeholder: opts.placeholder || '' });
    const body = h('div', h('label.ps-label', message), input, opts.help ? h('div.ps-help', opts.help) : null);
    return ui.modal({ title: opts.title || '', body: body, actions: [{ label: 'Cancel', value: null }, { label: opts.ok || 'OK', primary: true, value: function () { return input.value; } }] })
      .then(function (v) { return v === undefined ? null : v; });
  };

  /* ---------------------------------------------------------------- menus */

  let openMenu = null;
  /**
   * Dropdown/context menu. items: [{ label, icon, onClick, disabled, danger, checked, hint } | '-' | { heading }]
   * anchor: element or { x, y }.
   */
  ui.menu = function (anchor, items, opts) {
    ui.closeMenu();
    opts = opts || {};
    const menu = h('div.ps-menu', { role: 'menu' });
    items.forEach(function (it) {
      if (it === '-' ) { menu.appendChild(h('div.ps-menu-sep')); return; }
      if (it.heading) { menu.appendChild(h('div.ps-menu-heading', it.heading)); return; }
      const b = h('button.ps-menu-item' + (it.danger ? '.ps-danger' : ''), {
        type: 'button', role: 'menuitem', disabled: !!it.disabled,
        onclick: function (e) { e.stopPropagation(); ui.closeMenu(); if (it.onClick) it.onClick(); },
      }, it.checked !== undefined ? h('span.ps-check', it.checked ? '✓' : '') : (it.icon ? ui.icon(it.icon) : h('span.ps-check')), h('span.ps-menu-label', it.label), it.hint ? h('span.ps-menu-hint', it.hint) : null);
      menu.appendChild(b);
    });
    document.body.appendChild(menu);
    let x, y;
    if (anchor instanceof Element) {
      const r = anchor.getBoundingClientRect();
      x = opts.alignRight ? r.right - menu.offsetWidth : r.left;
      y = r.bottom + 4;
    } else { x = anchor.x; y = anchor.y; }
    const W = window.innerWidth, H = window.innerHeight;
    x = Math.max(4, Math.min(x, W - menu.offsetWidth - 4));
    if (y + menu.offsetHeight > H - 4) y = Math.max(4, (anchor instanceof Element ? anchor.getBoundingClientRect().top - menu.offsetHeight - 4 : H - menu.offsetHeight - 4));
    menu.style.left = x + 'px';
    menu.style.top = y + 'px';
    openMenu = menu;
    setTimeout(function () {
      document.addEventListener('mousedown', outside, true);
      document.addEventListener('keydown', esc, true);
    }, 0);
    function outside(e) { if (!menu.contains(e.target)) ui.closeMenu(); }
    function esc(e) { if (e.key === 'Escape') ui.closeMenu(); }
    menu._cleanup = function () { document.removeEventListener('mousedown', outside, true); document.removeEventListener('keydown', esc, true); };
    const first = menu.querySelector('.ps-menu-item:not([disabled])');
    if (first) first.focus();
    return menu;
  };
  ui.closeMenu = function () {
    if (openMenu) { openMenu._cleanup && openMenu._cleanup(); openMenu.remove(); openMenu = null; }
  };

  /* --------------------------------------------------------------- misc */

  /** Make a panel resizable by dragging `handle`. axis 'x' or 'y'; invert for right/bottom panels. */
  ui.resizable = function (handle, target, opts) {
    const axis = opts.axis || 'x';
    handle.addEventListener('pointerdown', function (e) {
      e.preventDefault();
      handle.setPointerCapture(e.pointerId);
      const start = axis === 'x' ? e.clientX : e.clientY;
      const size = axis === 'x' ? target.offsetWidth : target.offsetHeight;
      document.body.classList.add('ps-resizing');
      const move = function (ev) {
        const d = (axis === 'x' ? ev.clientX : ev.clientY) - start;
        let n = size + (opts.invert ? -d : d);
        n = Math.max(opts.min || 120, Math.min(opts.max || 900, n));
        target.style[axis === 'x' ? 'width' : 'height'] = n + 'px';
        if (opts.onResize) opts.onResize(n);
      };
      const up = function () {
        handle.removeEventListener('pointermove', move);
        handle.removeEventListener('pointerup', up);
        document.body.classList.remove('ps-resizing');
        if (opts.onEnd) opts.onEnd();
      };
      handle.addEventListener('pointermove', move);
      handle.addEventListener('pointerup', up);
    });
  };

  /** Copy text to the clipboard (with a fallback). */
  ui.copy = function (text) {
    if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(text).then(function () { ui.toast('Copied', 'success', 1200); });
    const ta = h('textarea', { style: { position: 'fixed', opacity: '0' } }, text);
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); ui.toast('Copied', 'success', 1200); } catch (e) { /* ignore */ }
    ta.remove();
    return Promise.resolve();
  };

  /** Swatch element for a layer (color or gradient). */
  ui.swatch = function (layer) {
    const sw = M.style.swatch(layer);
    const el = h('span.ps-swatch.ps-swatch-' + (layer.type === 'vector' ? (layer.geometryType || 'none').toLowerCase() : layer.type));
    if (sw.gradient) el.style.background = sw.gradient;
    else {
      el.style.background = sw.color;
      if (sw.stroke && layer.geometryType === 'Polygon') { el.style.borderColor = sw.stroke; if (sw.color === 'transparent') el.style.borderWidth = '2px'; }
    }
    return el;
  };

  ui.geomIcon = function (layer) {
    if (layer.type === 'raster') return 'raster';
    if (layer.type === 'tiles') return 'tiles';
    return { Point: 'point', LineString: 'line', Polygon: 'polygon', None: 'table2' }[layer.geometryType] || 'layers';
  };

  ui.escape = util.escapeHtml;
})(typeof globalThis !== 'undefined' ? globalThis : this);
