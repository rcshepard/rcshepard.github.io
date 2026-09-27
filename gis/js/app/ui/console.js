/*
 * PSICITS — the command console: input with autocomplete + live preview,
 * and a log of commands and their results.
 */
(function (root) {
  'use strict';

  const M = root.PSICITS;
  const util = M.util;
  const ui = M.ui;
  const h = ui.h;
  const store = M.store;
  const app = M.app;
  const C = M.commands;

  const HISTORY_KEY = 'psicits.history';
  const cons = (M.console = {});

  let logEl, inputEl, popupEl, hintEl, previewEl;
  let items = [], sel = -1, userNavigated = false, replaceFrom = 0, replaceTo = 0;
  let hist = [], histPos = -1, draft = '';

  function loadHistory() {
    try { hist = JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]'); } catch (e) { hist = []; }
  }
  function saveHistory() {
    try { localStorage.setItem(HISTORY_KEY, JSON.stringify(hist.slice(-300))); } catch (e) { /* private mode */ }
  }

  /* ------------------------------------------------------------ build */

  cons.mount = function (host) {
    loadHistory();
    logEl = h('div.ps-log', { role: 'log', 'aria-live': 'polite' });
    popupEl = h('div.ps-ac', { role: 'listbox', hidden: true });
    inputEl = h('textarea.ps-cmd', {
      rows: 1, spellcheck: false, autocomplete: 'off', autocapitalize: 'off',
      placeholder: 'Type a command… e.g. buffer roads 500 m   (Tab completes, ↑ history)',
      'aria-label': 'Command', oninput: onInput, onkeydown: onKey, onclick: onInput, onblur: function () { setTimeout(closePopup, 150); },
    });
    hintEl = h('div.ps-hint');
    previewEl = h('div.ps-preview');
    const runBtn = ui.iconButton('play', 'Run (Enter)', function () { submit(); }, 'ps-run');
    const bar = h('div.ps-cmdbar', popupEl, h('div.ps-cmdrow', h('span.ps-prompt', '›'), inputEl, runBtn), hintEl, previewEl);
    host.appendChild(logEl);
    host.appendChild(bar);
    app.output = makeEntry;
    app.on('console:clear', function () { logEl.innerHTML = ''; });
    app.on('busy', function (b) { host.classList.toggle('ps-busy', b); });
    return { log: logEl, input: inputEl };
  };

  cons.focus = function () { if (inputEl) { inputEl.focus(); inputEl.setSelectionRange(inputEl.value.length, inputEl.value.length); } };

  /** Put text into the command box (optionally run it). */
  cons.insert = function (text, run) {
    inputEl.value = text;
    autosize();
    cons.focus();
    onInput();
    if (run) submit();
  };

  /* ---------------------------------------------------------- entries */

  function scrollDown() { logEl.scrollTop = logEl.scrollHeight; }

  function makeEntry(title, opts) {
    opts = opts || {};
    const status = h('span.ps-status', h('span.ps-spin'));
    const head = h('div.ps-entry-head',
      h('span.ps-entry-cmd', { title: 'Click to put this command in the input', onclick: function () { cons.insert(title); } }, title),
      h('span.ps-entry-actions',
        ui.iconButton('copy', 'Copy command', function () { ui.copy(title); }, 'ps-mini'),
        ui.iconButton('play', 'Run again', function () { app.run(title); }, 'ps-mini')),
      status);
    const body = h('div.ps-entry-body');
    const entry = h('div.ps-entry' + (opts.nested ? '.ps-nested' : ''), head, body);
    if (title === 'measure') { head.remove(); }
    logEl.appendChild(entry);
    while (logEl.children.length > 400) logEl.removeChild(logEl.firstChild);
    scrollDown();
    let progressEl = null;
    const line = function (cls, content, icon) {
      const el = h('div.ps-line.' + cls, icon ? ui.icon(icon, 14) : null, typeof content === 'string' ? h('span', content) : content);
      body.appendChild(el);
      scrollDown();
      return el;
    };
    const out = {
      text: function (s) { return line('ps-text', String(s)); },
      note: function (s) { return line('ps-note', String(s)); },
      success: function (s) { return line('ps-ok', String(s), 'check'); },
      warn: function (s) { return line('ps-warn', String(s), 'warn'); },
      error: function (s) {
        entry.classList.add('ps-failed');
        return line('ps-err', String(s), 'warn');
      },
      code: function (s) { const pre = h('pre.ps-code', String(s)); body.appendChild(pre); scrollDown(); return pre; },
      html: function (node) { body.appendChild(node); scrollDown(); },
      kv: function (obj) {
        const t = h('table.ps-kvtable');
        Object.keys(obj).forEach(function (k) {
          const v = obj[k];
          t.appendChild(h('tr', h('th', k), h('td', v === null || v === undefined ? '' : String(v))));
        });
        body.appendChild(t);
        scrollDown();
      },
      table: function (rows, cols) {
        if (!rows || !rows.length) { line('ps-note', '(no rows)'); return; }
        cols = cols || Object.keys(rows.reduce(function (a, r) { return Object.assign(a, r); }, {}));
        cols = cols.filter(function (c) { return rows.some(function (r) { return r[c] !== undefined && r[c] !== ''; }); });
        const t = h('table.ps-datatable', h('thead', h('tr', cols.map(function (c) { return h('th', c); }))));
        const tb = h('tbody');
        rows.slice(0, 500).forEach(function (r) {
          tb.appendChild(h('tr', cols.map(function (c) {
            const v = r[c];
            return h('td' + (typeof v === 'number' ? '.ps-num' : ''), v === null || v === undefined ? '' : (typeof v === 'number' ? util.formatNumber(v) : String(v)));
          })));
        });
        t.appendChild(tb);
        body.appendChild(h('div.ps-tablewrap', t));
        if (rows.length > 500) line('ps-note', '… ' + (rows.length - 500) + ' more rows');
        scrollDown();
      },
      list: function (arr) { const ul = h('ul.ps-list', arr.map(function (x) { return h('li', String(x)); })); body.appendChild(ul); scrollDown(); },
      layer: function (layer, verb) {
        const chips = h('span.ps-chips',
          chip('Zoom', function () { M.mapview.zoomToLayer(store.get(layer.id)); }),
          layer.type === 'vector' ? chip('Table', function () { app.emit('open-table', { layerId: layer.id }); }) : null,
          chip('Style', function () { app.emit('style-editor', { layerId: layer.id }); }));
        line('ps-ok', h('span', (verb || 'Added') + ' layer ', h('b', layer.name), h('span.ps-dim', ' · ' + M.toolkit.describe(layer)), chips), 'check');
      },
      download: function (filename, bytes) {
        const b = h('button.ps-chip', { type: 'button', onclick: function () { M.io.download(new Blob([bytes]), filename); } }, ui.icon('download', 13), ' ' + filename + ' (' + util.formatBytes(bytes.length) + ')');
        line('ps-text', b);
      },
      commandList: function (title, cmds) {
        const wrap = h('div.ps-cmdlist', title ? h('div.ps-cmdlist-title', title) : null, cmds.map(function (c) {
          return h('button.ps-cmdlink', { type: 'button', title: 'Click to insert, double-click to run', onclick: function () { cons.insert(c.name + (M.commands.get(c.name) && M.commands.get(c.name).params.length ? ' ' : '')); }, ondblclick: function () { cons.insert(c.name, true); } },
            h('code', c.name), c.summary ? h('span.ps-dim', ' — ' + c.summary) : null);
        }));
        body.appendChild(wrap);
        scrollDown();
      },
      suggest: function (cmds) {
        line('ps-note', h('span', 'Did you mean ', cmds.map(function (c, i) { return [i ? ' or ' : '', h('button.ps-cmdlink.ps-inline', { type: 'button', onclick: function () { cons.insert(c); } }, h('code', c))]; }), '?'));
      },
      toolHelp: function (tool) { body.appendChild(toolHelpNode(tool)); scrollDown(); },
      histogram: function (values, o) {
        o = o || {};
        const n = Math.max(2, Math.min(60, o.bins || 20));
        let lo = Infinity, hi = -Infinity;
        values.forEach(function (v) { if (v < lo) lo = v; if (v > hi) hi = v; });
        if (lo === hi) hi = lo + 1;
        const edges = [], counts = new Array(n).fill(0);
        for (let i = 0; i <= n; i++) edges.push(lo + (hi - lo) * i / n);
        values.forEach(function (v) { counts[Math.min(n - 1, Math.floor((v - lo) / (hi - lo) * n))]++; });
        out.histogramBins(edges, counts, o);
      },
      histogramBins: function (edges, counts, o) {
        o = o || {};
        const max = Math.max.apply(null, counts) || 1;
        const chart = h('div.ps-hist', counts.map(function (c, i) {
          return h('div.ps-bar', { title: util.formatNumber(edges[i]) + ' – ' + util.formatNumber(edges[i + 1]) + ': ' + c, style: { height: Math.max(1, Math.round(c / max * 100)) + '%' } });
        }));
        body.appendChild(h('div.ps-histwrap', o.label ? h('div.ps-dim', o.label) : null, chart, h('div.ps-hist-axis', h('span', util.formatNumber(edges[0])), h('span', util.formatNumber(edges[edges.length - 1])))));
        scrollDown();
      },
      progress: function (msg) {
        if (!progressEl) progressEl = line('ps-progress', '');
        progressEl.lastChild.textContent = msg;
      },
      done: function (st, ms) {
        if (progressEl) { progressEl.remove(); progressEl = null; }
        status.innerHTML = '';
        if (st === 'ok') { status.appendChild(ui.icon('check', 14)); status.classList.add('ps-st-ok'); if (ms > 400) status.appendChild(h('span.ps-dim', (ms / 1000).toFixed(1) + 's')); }
        else { status.appendChild(ui.icon('warn', 14)); status.classList.add('ps-st-err'); }
        if (!body.childNodes.length && st === 'ok') entry.classList.add('ps-quiet');
        scrollDown();
      },
    };
    out.el = entry;
    return out;
  }

  function chip(label, fn) { return h('button.ps-chip', { type: 'button', onclick: fn }, label); }

  function toolHelpNode(tool) {
    const params = tool.params.filter(function (p) { return !p.hidden; });
    return h('div.ps-help',
      h('div.ps-help-title', h('code', C.usage(tool))),
      tool.summary ? h('p', tool.summary) : null,
      tool.aliases.length ? h('p.ps-dim', 'Also: ' + tool.aliases.join(', ')) : null,
      params.length ? h('table.ps-kvtable', params.map(function (p) {
        let d = p.description || '';
        if (p.type === 'enum') d += (d ? ' — ' : '') + p.options.join(' | ');
        if (p.default !== undefined) d += ' (default ' + (typeof p.default === 'object' ? JSON.stringify(p.default) : p.default) + ')';
        const how = p.keywords.length ? p.keywords[0] + ' …' : p.type === 'flag' ? p.words[0] : '';
        return h('tr', h('th', p.label || p.name), h('td', h('span.ps-dim', p.type + (how ? ' · ' + how : '') + (p.required ? ' · required' : '')), d ? h('div', d) : null));
      })) : null,
      tool.examples.length ? h('div', h('div.ps-dim', 'Examples (click to try):'), tool.examples.map(function (ex) {
        return h('button.ps-cmdlink', { type: 'button', onclick: function () { cons.insert(ex); } }, h('code', ex));
      })) : null);
  }
  cons.toolHelpNode = toolHelpNode;

  /* ------------------------------------------------------ input logic */

  function autosize() {
    inputEl.style.height = 'auto';
    inputEl.style.height = Math.min(160, inputEl.scrollHeight) + 'px';
  }

  let inputTimer = null;
  function onInput() {
    autosize();
    clearTimeout(inputTimer);
    inputTimer = setTimeout(update, 25);
  }

  function update() {
    const text = inputEl.value;
    const cursor = inputEl.selectionStart;
    if (text.indexOf('\n') >= 0) {
      closePopup();
      hintEl.textContent = 'Multi-line script: Enter runs every line (Shift+Enter adds a line)';
      previewEl.textContent = '';
      previewEl.className = 'ps-preview';
      return;
    }
    let s;
    try { s = C.suggest(text, cursor, store.ctx()); } catch (e) { s = { items: [], hint: '' }; }
    items = s.items || [];
    replaceFrom = s.from;
    replaceTo = s.to;
    hintEl.textContent = s.hint ? s.hint : (text.trim() ? '' : 'Try: help · sample countries · find Chicago · osm parks in view');
    // preview of how the whole line is understood
    const p = s.parse || (text.trim() ? C.parse(text, store.ctx()) : null);
    if (p && p.tool && text.trim()) {
      previewEl.className = 'ps-preview ' + (p.ok ? 'ps-ok' : 'ps-err');
      previewEl.textContent = p.ok ? '✓ ' + p.canonical + (p.usedActive ? '   (layer: ' + p.usedActive + ')' : '') : (p.missing.length ? '… needs ' + p.missing.join(', ') : '✗ ' + (p.errors[0] || ''));
    } else if (p && !p.tool && text.trim() && text.trim().indexOf(' ') > 0) {
      previewEl.className = 'ps-preview ps-err';
      previewEl.textContent = '✗ ' + (p.errors[0] || '');
    } else { previewEl.textContent = ''; previewEl.className = 'ps-preview'; }
    renderPopup();
  }

  function renderPopup() {
    const word = inputEl.value.slice(replaceFrom, replaceTo);
    const visible = items.filter(function (it) { return it.insert.trim() !== word.trim() || items.length > 1; });
    if (!visible.length || document.activeElement !== inputEl) { closePopup(); return; }
    items = visible;
    if (sel >= items.length) sel = items.length - 1;
    if (sel < 0) sel = 0;
    popupEl.innerHTML = '';
    items.slice(0, 60).forEach(function (it, i) {
      const row = h('div.ps-ac-item' + (i === sel ? '.ps-active' : ''), { role: 'option', onmousedown: function (e) { e.preventDefault(); sel = i; accept(); } },
        h('span.ps-ac-kind.ps-k-' + (it.kind || 'x'), (it.kind || '').slice(0, 1).toUpperCase()), h('span.ps-ac-label', it.label), it.detail ? h('span.ps-ac-detail', it.detail) : null);
      popupEl.appendChild(row);
    });
    popupEl.hidden = false;
    const act = popupEl.children[sel];
    if (act && act.scrollIntoView) act.scrollIntoView({ block: 'nearest' });
  }

  function closePopup() { if (popupEl) popupEl.hidden = true; userNavigated = false; }

  function accept() {
    const it = items[sel];
    if (!it) return;
    const v = inputEl.value;
    const before = v.slice(0, replaceFrom);
    const after = v.slice(replaceTo).replace(/^\S*/, '');
    inputEl.value = before + it.insert + after.replace(/^\s+/, '');
    const pos = (before + it.insert).length;
    inputEl.setSelectionRange(pos, pos);
    userNavigated = false;
    sel = 0;
    onInput();
  }

  function onKey(e) {
    const open = !popupEl.hidden && items.length;
    if (e.key === 'Tab') {
      if (open) { e.preventDefault(); accept(); }
      return;
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      const multiline = inputEl.value.indexOf('\n') >= 0;
      if (open && (userNavigated || e.key === 'ArrowDown') && !(e.key === 'ArrowUp' && !userNavigated)) {
        e.preventDefault();
        userNavigated = true;
        sel = (sel + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
        renderPopup();
        return;
      }
      if (multiline) return;
      e.preventDefault();
      if (!hist.length) return;
      if (histPos === -1) { draft = inputEl.value; histPos = hist.length; }
      histPos += e.key === 'ArrowUp' ? -1 : 1;
      if (histPos < 0) histPos = 0;
      if (histPos >= hist.length) { histPos = -1; inputEl.value = draft; }
      else inputEl.value = hist[histPos];
      autosize();
      closePopup();
      update();
      closePopup();
      return;
    }
    if (e.key === 'Escape') {
      if (open) { e.preventDefault(); closePopup(); return; }
      if (inputEl.value) { e.preventDefault(); inputEl.value = ''; onInput(); }
      return;
    }
    if (e.key === 'ArrowRight' && open && inputEl.selectionStart === inputEl.value.length && userNavigated) { e.preventDefault(); accept(); return; }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (open && userNavigated) { accept(); return; }
      submit();
    }
  }

  function submit() {
    const text = inputEl.value.trim();
    if (!text) return;
    closePopup();
    inputEl.value = '';
    autosize();
    previewEl.textContent = '';
    hintEl.textContent = '';
    histPos = -1;
    const lines = C.splitScript(text);
    lines.forEach(function (ln) { if (hist[hist.length - 1] !== ln.text) hist.push(ln.text); });
    saveHistory();
    if (lines.length > 1) app.runScript(text); else app.run(text, { source: 'console' });
  }
  cons.submit = submit;

  /** Show the welcome message with starter commands. */
  cons.welcome = function () {
    const out = makeEntry('Welcome to ' + M.appName);
    out.el.classList.add('ps-welcome');
    out.html(h('p.ps-welcome-sub', M.appTagline + '.'));
    out.text('A complete GIS that runs in your web browser — nothing to install, no admin rights needed, and your files never leave your computer. Type a command below (or use the menus; they show you the command they ran).');
    out.commandList('Try one (click to insert, double-click to run):', [
      { name: 'find University of Chicago', summary: 'fly to campus' },
      { name: 'boundary Chicago', summary: 'the city boundary from OpenStreetMap' },
      { name: 'osm libraries in chicago', summary: 'download OpenStreetMap features' },
      { name: 'sample us-states', summary: 'US states with population density' },
      { name: 'color us_states by density 7 jenks maroon', summary: 'a choropleth map' },
      { name: 'help', summary: 'every command, with examples' },
    ]);
    out.note('Drop files anywhere on the map: Shapefile (.zip), GeoJSON, KML, CSV, Excel, GeoPackage, GeoTIFF — plus ~80 more formats through GDAL.');
    out.done('ok');
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
