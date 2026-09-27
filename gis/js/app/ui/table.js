/*
 * PSICITS — attribute table (virtualised). Edits run as commands:
 *   calc "layer" field = 'value' where $id = 12
 */
(function (root) {
  'use strict';

  const M = root.PSICITS;
  const util = M.util;
  const ui = M.ui;
  const h = ui.h;
  const store = M.store;
  const app = M.app;

  const ROW_H = 26;
  const table = (M.table = {});
  let host, headEl, bodyEl, spacer, rowsEl, layerSel, infoEl, onlySelBox, searchInput;
  let layerId = null;
  let rows = []; // array of features in display order
  let sortField = null, sortDir = 1;
  let lastClicked = -1;
  let searchText = '';
  const q = function (n) { return M.layersPanel.q(n); };

  table.mount = function (el, opts) {
    host = el;
    layerSel = h('select.ps-select', { onchange: function () { table.open(layerSel.value); } });
    onlySelBox = h('input', { type: 'checkbox', onchange: refresh });
    searchInput = h('input.ps-input.ps-small', { type: 'search', placeholder: 'Search values…', oninput: util.debounce(function () { searchText = searchInput.value.trim().toLowerCase(); refresh(); }, 200) });
    infoEl = h('span.ps-dim.ps-table-info');
    const bar = h('div.ps-table-bar',
      layerSel,
      h('label.ps-check-label', onlySelBox, ' selected only'),
      searchInput,
      infoEl,
      h('span.ps-spacer'),
      ui.iconButton('zoom', 'Zoom to selection', function () { app.run('zoom to selection', { source: 'ui' }); }),
      ui.iconButton('filter', 'Select by expression…', async function () {
        const l = store.get(layerId);
        if (!l) return;
        const w = await ui.prompt('Select features where…', '', { title: 'Select by attributes', placeholder: '"population" > 10000', help: 'Fields: ' + l.fields.map(function (f) { return f.name; }).join(', ') });
        if (w) app.run('select ' + q(l.name) + ' where ' + w, { source: 'ui' });
      }),
      ui.iconButton('close', 'Clear selection', function () { const l = store.get(layerId); if (l) app.run('deselect ' + q(l.name), { source: 'ui' }); }),
      ui.iconButton('plus', 'Add a field…', async function () {
        const l = store.get(layerId);
        if (!l) return;
        const w = await ui.prompt('New field: name = expression', 'new_field = ', { title: 'Field calculator', help: 'e.g. density = population / ($area / 1e6)   ·   label = upper(name)   ·   notes = NULL' });
        if (w && /=/.test(w)) app.run('calc ' + q(l.name) + ' ' + w, { source: 'ui' });
      }),
      ui.iconButton('trash', 'Delete selected features', function () { const l = store.get(layerId); if (l) app.run('delete ' + q(l.name) + ' selected', { source: 'ui' }); }),
      ui.iconButton('download', 'Export as CSV', function () { const l = store.get(layerId); if (l) app.run('export ' + q(l.name) + ' as csv' + (onlySelBox.checked ? ' selected' : ''), { source: 'ui' }); }),
      opts && opts.onClose ? ui.iconButton('close', 'Close table', opts.onClose) : null);
    headEl = h('div.ps-thead');
    spacer = h('div.ps-tspacer');
    rowsEl = h('div.ps-trows');
    bodyEl = h('div.ps-tbody', { onscroll: paint }, spacer, rowsEl);
    host.appendChild(bar);
    host.appendChild(h('div.ps-tablegrid', headEl, bodyEl));
    store.on('layer:update', function (e) { if (e.layer.id === layerId && (e.changes.indexOf('data') >= 0 || e.changes.indexOf('name') >= 0)) refresh(); });
    store.on('layer:remove', function (e) { if (e.layer.id === layerId) table.open(null); fillSelect(); });
    store.on('layer:add', fillSelect);
    store.on('layer:update', function (e) { if (e.changes.indexOf('name') >= 0) fillSelect(); });
    store.on('selection', function (e) { if (e.layerId === layerId) { if (onlySelBox.checked) refresh(); else paint(); } });
    store.on('project:load', fillSelect);
    fillSelect();
  };

  function fillSelect() {
    if (!layerSel) return;
    layerSel.innerHTML = '';
    const vec = store.ordered().filter(function (l) { return l.type === 'vector'; });
    vec.forEach(function (l) { layerSel.appendChild(h('option', { value: l.id, selected: l.id === layerId }, l.name + ' (' + util.formatNumber(l.count, 0) + ')')); });
    if (!vec.length) layerSel.appendChild(h('option', { value: '' }, 'No vector layers'));
  }

  table.open = function (id, fid) {
    const l = id ? store.get(id) : null;
    layerId = l && l.type === 'vector' ? l.id : null;
    sortField = null;
    fillSelect();
    refresh();
    if (fid !== undefined) table.scrollTo(fid);
  };
  table.current = function () { return layerId; };

  table.scrollTo = function (fid) {
    const i = rows.findIndex(function (f) { return f.id === fid; });
    if (i >= 0) bodyEl.scrollTop = Math.max(0, i * ROW_H - bodyEl.clientHeight / 2);
    paint();
  };

  let columns = [];

  function refresh() {
    const l = layerId ? store.get(layerId) : null;
    if (!l) { rows = []; columns = []; headEl.innerHTML = ''; spacer.style.height = '0px'; rowsEl.innerHTML = ''; infoEl.textContent = ''; return; }
    columns = [{ name: '#', fid: true }].concat(l.fields.map(function (f) { return { name: f.name, type: f.type }; }));
    let feats = l.data.features;
    if (onlySelBox.checked) {
      const sel = new Set(store.selectedIds(l.id));
      feats = feats.filter(function (f) { return sel.has(f.id); });
    }
    if (searchText) {
      feats = feats.filter(function (f) {
        const p = f.properties;
        for (const k in p) { const v = p[k]; if (v !== null && v !== undefined && String(v).toLowerCase().indexOf(searchText) >= 0) return true; }
        return false;
      });
    }
    if (sortField) {
      const sf = sortField, dir = sortDir;
      feats = feats.slice().sort(function (a, b) {
        const x = sf === '#' ? a.id : a.properties[sf], y = sf === '#' ? b.id : b.properties[sf];
        if (x === y) return 0;
        if (x === null || x === undefined) return 1;
        if (y === null || y === undefined) return -1;
        if (typeof x === 'number' && typeof y === 'number') return (x - y) * dir;
        return String(x).localeCompare(String(y), undefined, { numeric: true }) * dir;
      });
    }
    rows = feats;
    infoEl.textContent = util.formatNumber(rows.length, 0) + (rows.length !== l.count ? ' of ' + util.formatNumber(l.count, 0) : '') + ' rows · ' + store.selectedIds(l.id).length + ' selected';
    renderHead(l);
    spacer.style.height = (rows.length * ROW_H) + 'px';
    paint();
  }

  function colWidth(c) {
    if (c.fid) return 64;
    return Math.max(90, Math.min(260, 24 + c.name.length * 8));
  }

  function renderHead(l) {
    headEl.innerHTML = '';
    const tr = h('div.ps-tr.ps-thr');
    columns.forEach(function (c) {
      const th = h('div.ps-th' + (c.type === 'number' ? '.ps-num' : ''), { style: { width: colWidth(c) + 'px' }, title: c.fid ? 'Feature id' : c.name + ' (' + c.type + ') — click to sort, right-click for options',
        onclick: function () { if (sortField === c.name) sortDir = -sortDir; else { sortField = c.name; sortDir = 1; } refresh(); },
        oncontextmenu: function (e) { e.preventDefault(); if (!c.fid) fieldMenu({ x: e.clientX, y: e.clientY }, l, c.name); },
      }, c.name, sortField === c.name ? (sortDir > 0 ? ' ▲' : ' ▼') : '');
      tr.appendChild(th);
    });
    headEl.appendChild(tr);
    headEl.style.width = tr.style.width = columns.reduce(function (s, c) { return s + colWidth(c); }, 0) + 'px';
  }

  function fieldMenu(pos, l, field) {
    const n = q(l.name), f = q(field);
    ui.menu(pos, [
      { heading: field },
      { label: 'Statistics', onClick: function () { app.run('stats ' + n + ' ' + f, { source: 'ui' }); } },
      { label: 'Unique values', onClick: function () { app.run('unique ' + n + ' ' + f, { source: 'ui' }); } },
      { label: 'Color map by this field', onClick: function () { app.run('color ' + n + ' by ' + f, { source: 'ui' }); } },
      { label: 'Label by this field', onClick: function () { app.run('label ' + n + ' ' + f, { source: 'ui' }); } },
      '-',
      { label: 'Calculate…', onClick: async function () {
        const w = await ui.prompt(field + ' =', '', { title: 'Field calculator', placeholder: 'expression, e.g. round(' + field + ', 1)' });
        if (w) app.run('calc ' + n + ' ' + f + ' = ' + w, { source: 'ui' });
      } },
      { label: 'Rename field…', onClick: async function () {
        const w = await ui.prompt('New name for field "' + field + '":', field, { title: 'Rename field' });
        if (w && w !== field) app.run('rename field ' + n + ' ' + f + ' to ' + q(w), { source: 'ui' });
      } },
      { label: 'Delete field', danger: true, onClick: function () { app.run('drop field ' + n + ' ' + f, { source: 'ui' }); } },
    ]);
  }

  function fmtCell(v) {
    if (v === null || v === undefined) return '';
    if (typeof v === 'number') return util.formatNumber(v, Math.abs(v) < 1e6 && !Number.isInteger(v) ? 4 : 0);
    if (typeof v === 'object') return JSON.stringify(v);
    return String(v);
  }

  function paint() {
    const l = layerId ? store.get(layerId) : null;
    if (!l) return;
    const top = bodyEl.scrollTop;
    const first = Math.max(0, Math.floor(top / ROW_H) - 5);
    const last = Math.min(rows.length, Math.ceil((top + bodyEl.clientHeight) / ROW_H) + 5);
    rowsEl.innerHTML = '';
    rowsEl.style.transform = 'translateY(' + (first * ROW_H) + 'px)';
    const width = columns.reduce(function (s, c) { return s + colWidth(c); }, 0);
    rowsEl.style.width = width + 'px';
    spacer.style.width = width + 'px';
    const sel = store.selection.get(l.id);
    for (let i = first; i < last; i++) {
      const f = rows[i];
      const tr = h('div.ps-tr' + (sel && sel.has(f.id) ? '.ps-selected' : '') + (f.geometry ? '' : '.ps-nogeom'), { dataset: { i: String(i) } });
      columns.forEach(function (c) {
        const v = c.fid ? f.id : f.properties[c.name];
        const td = h('div.ps-td' + (typeof v === 'number' ? '.ps-num' : '') + (v === null || v === undefined ? '.ps-nullcell' : ''), { style: { width: colWidth(c) + 'px' }, title: v === null || v === undefined ? 'null' : fmtCell(v) }, c.fid ? String(f.id) : fmtCell(v));
        if (!c.fid) td.addEventListener('dblclick', function (e) { e.stopPropagation(); editCell(td, l, f, c.name); });
        tr.appendChild(td);
      });
      tr.addEventListener('click', function (e) { onRowClick(e, i); });
      rowsEl.appendChild(tr);
    }
  }

  function onRowClick(e, i) {
    const l = store.get(layerId);
    if (!l) return;
    const f = rows[i];
    if (e.shiftKey && lastClicked >= 0) {
      const a = Math.min(lastClicked, i), b = Math.max(lastClicked, i);
      store.select(l.id, rows.slice(a, b + 1).map(function (x) { return x.id; }), 'add');
    } else if (e.ctrlKey || e.metaKey) {
      store.select(l.id, [f.id], 'toggle');
    } else {
      store.select(l.id, [f.id], 'new');
      if (f.geometry) {
        const b = util.bbox(f);
        const m = M.mapview.map;
        if (b) {
          const bounds = m.getBounds();
          const inView = b[0] >= bounds.getWest() && b[2] <= bounds.getEast() && b[1] >= bounds.getSouth() && b[3] <= bounds.getNorth();
          if (!inView) M.mapview.fitBounds(b, { maxZoom: Math.max(m.getZoom(), 12) });
        }
      }
    }
    lastClicked = i;
  }

  function editCell(td, l, f, field) {
    const old = f.properties[field];
    const type = (l.fields.find(function (x) { return x.name === field; }) || {}).type;
    const input = h('input.ps-cell-input', { value: old === null || old === undefined ? '' : (typeof old === 'object' ? JSON.stringify(old) : String(old)) });
    td.innerHTML = '';
    td.appendChild(input);
    input.focus();
    input.select();
    let done = false;
    const commit = function (save) {
      if (done) return;
      done = true;
      if (!save) { paint(); return; }
      const raw = input.value;
      let lit;
      if (raw === '' ) lit = 'NULL';
      else if (type === 'number' && isFinite(Number(raw))) lit = String(Number(raw));
      else if (type === 'boolean' && /^(true|false)$/i.test(raw)) lit = raw.toUpperCase();
      else lit = M.expr.literal(raw);
      if (String(old === null || old === undefined ? '' : old) === raw) { paint(); return; }
      app.run('calc ' + q(l.name) + ' ' + q(field) + ' = ' + lit + ' where $id = ' + f.id, { source: 'ui' });
    };
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); commit(true); }
      else if (e.key === 'Escape') { e.preventDefault(); commit(false); }
      e.stopPropagation();
    });
    input.addEventListener('blur', function () { commit(true); });
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
