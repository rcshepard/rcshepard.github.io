/*
 * PSICITS — layers panel. Every action runs a text command (so it shows up
 * in the console and in history).
 */
(function (root) {
  'use strict';

  const M = root.PSICITS;
  const util = M.util;
  const ui = M.ui;
  const h = ui.h;
  const store = M.store;
  const app = M.app;

  const panel = (M.layersPanel = {});
  let listEl, emptyEl, countEl;
  const q = function (name) {
    const s = String(name);
    const plain = /^[A-Za-z_][\w.\-]*$/.test(s) && !/^(in|to|by|as|with|of|from|on|at|and|all|view|selection|selected|where|the|a|an|into|near|within)$/i.test(s);
    return plain ? s : JSON.stringify(s);
  };
  const run = function (cmd) { return app.run(cmd, { source: 'ui' }); };
  panel.q = q;

  panel.mount = function (host) {
    const addBtn = h('button.ps-btn.ps-small', { type: 'button', onclick: function (e) { panel.addMenu(e.currentTarget); } }, ui.icon('plus', 14), ' Add');
    countEl = h('h3', 'Layers');
    host.appendChild(h('div.ps-panel-head', countEl, addBtn));
    listEl = h('div.ps-layerlist', { role: 'list' });
    emptyEl = h('div.ps-empty',
      h('p', 'No layers yet.'),
      h('p.ps-dim', 'Drop files on the map, or:'),
      h('div.ps-empty-actions',
        h('button.ps-btn', { type: 'button', onclick: function () { run('open'); } }, ui.icon('folder', 14), ' Open files'),
        h('button.ps-btn', { type: 'button', onclick: function () { run('sample'); } }, ui.icon('layers', 14), ' Sample data')));
    host.appendChild(emptyEl);
    host.appendChild(listEl);
    ['layer:add', 'layer:remove', 'layer:update', 'layer:order', 'active', 'selection', 'project:load', 'project:clear'].forEach(function (evt) {
      store.on(evt, schedule);
    });
    M.mapview.on('raster-rendered', schedule);
    render();
  };

  let pending = false;
  function schedule() {
    if (pending) return;
    pending = true;
    root.requestAnimationFrame(function () { pending = false; render(); });
  }

  panel.addMenu = function (anchor) {
    const samples = M.toolkit.SAMPLES;
    ui.menu(anchor, [
      { label: 'Open files…', icon: 'folder', hint: 'open', onClick: function () { run('open'); } },
      { label: 'From a URL…', icon: 'link', onClick: async function () {
        const u = await ui.prompt('Web address of a data file, ArcGIS REST layer, WFS or XYZ tiles:', '', { title: 'Load from URL', placeholder: 'https://…' });
        if (u) run('load ' + u.trim());
      } },
      { heading: 'Sample data' },
    ].concat(Object.keys(samples).map(function (k) { return { label: samples[k].label, onClick: function () { run('sample ' + k); } }; })).concat([
      '-',
      { label: 'OpenStreetMap features…', icon: 'globe', onClick: async function () {
        const w = await ui.prompt('What to download from OpenStreetMap (in the current view)?', 'parks', { title: 'OpenStreetMap', help: 'Presets: hospitals, schools, parks, restaurants, cafes, bike lanes, roads, buildings, bus stops… or a tag like amenity=library' });
        if (w) run('osm ' + w.trim() + ' in view');
      } },
      { label: 'Boundary of a place…', icon: 'polygon', onClick: async function () {
        const w = await ui.prompt('Place name (city, county, state, country, park…):', '', { title: 'Boundary', placeholder: 'e.g. Cook County, Illinois' });
        if (w) run('boundary ' + w.trim());
      } },
      { label: 'Tile layer (XYZ)…', icon: 'tiles', onClick: async function () {
        const w = await ui.prompt('XYZ tile URL with {z}/{x}/{y}:', 'https://', { title: 'Tile layer' });
        if (w) run('tiles ' + w.trim());
      } },
      { label: 'Draw a new sketch', icon: 'pencil', onClick: function () { run('draw polygon'); } },
    ]));
  };

  function layerMenu(anchor, l) {
    const n = q(l.name);
    const vec = l.type === 'vector';
    const items = [
      { label: 'Zoom to layer', icon: 'zoom', onClick: function () { run('zoom to ' + n); } },
      vec ? { label: 'Open attribute table', icon: 'table', onClick: function () { run('table ' + n); } } : null,
      { label: 'Style…', icon: 'palette', onClick: function () { app.emit('style-editor', { layerId: l.id }); } },
      vec ? { label: 'Labels…', icon: 'info', onClick: async function () {
        const f = await ui.prompt('Label with which field (or an expression)?', (l.fields.find(function (x) { return /name/i.test(x.name); }) || l.fields[0] || { name: '' }).name, { title: 'Labels', help: 'Fields: ' + l.fields.map(function (x) { return x.name; }).join(', ') });
        if (f) run('label ' + n + ' by ' + f);
      } } : null,
      vec ? { label: 'Filter…', icon: 'filter', onClick: async function () {
        const w = await ui.prompt('Only show features where…', l.filter || '', { title: 'Filter ' + l.name, placeholder: '"population" > 10000', help: 'Leave empty to show everything.' });
        if (w === null) return;
        run(w.trim() ? 'filter ' + n + ' where ' + w : 'filter ' + n + ' off');
      } } : null,
      { label: 'Info', icon: 'info', onClick: function () { run('info ' + n); } },
      '-',
      { label: 'Rename…', icon: 'pencil', onClick: async function () {
        const w = await ui.prompt('New name for "' + l.name + '":', l.name, { title: 'Rename layer' });
        if (w && w.trim() && w.trim() !== l.name) run('rename ' + n + ' to ' + q(w.trim()));
      } },
      { label: 'Duplicate', icon: 'copy', onClick: function () { run('duplicate ' + n); } },
      { label: 'Move to top', onClick: function () { run('move ' + n + ' to top'); } },
      { label: 'Move to bottom', onClick: function () { run('move ' + n + ' to bottom'); } },
      '-',
      { heading: 'Export' },
    ].filter(Boolean);
    const fmts = M.io.EXPORT_FORMATS;
    Object.keys(fmts).forEach(function (k) {
      if (fmts[k].kinds.indexOf(l.type) < 0) return;
      items.push({ label: fmts[k].label, icon: 'download', onClick: function () { run('export ' + n + ' as ' + k); } });
    });
    items.push('-', { label: 'Remove layer', icon: 'trash', danger: true, onClick: function () { run('remove ' + n); } });
    ui.menu(anchor, items);
  }

  let dragId = null;

  function render() {
    const layers = store.ordered();
    emptyEl.hidden = layers.length > 0;
    listEl.hidden = !layers.length;
    countEl.textContent = layers.length ? layers.length + (layers.length === 1 ? ' layer' : ' layers') : 'Layers';
    listEl.innerHTML = '';
    layers.forEach(function (l) {
      const selCount = l.type === 'vector' ? store.selectedIds(l.id).length : 0;
      const eye = ui.iconButton(l.visible ? 'eye' : 'eyeoff', l.visible ? 'Hide' : 'Show', function (e) { e.stopPropagation(); run((l.visible ? 'hide ' : 'show ') + q(l.name)); }, 'ps-eye' + (l.visible ? '' : '.ps-off'));
      const more = ui.iconButton('more', 'Layer menu', function (e) { e.stopPropagation(); layerMenu(e.currentTarget, l); }, 'ps-more');
      const nameEl = h('span.ps-layer-name', { title: l.name + ' (' + l.id + ') — double-click to rename' }, l.name);
      nameEl.addEventListener('dblclick', async function (e) {
        e.stopPropagation();
        const w = await ui.prompt('New name for "' + l.name + '":', l.name, { title: 'Rename layer' });
        if (w && w.trim() && w.trim() !== l.name) run('rename ' + q(l.name) + ' to ' + q(w.trim()));
      });
      const meta = h('span.ps-layer-meta', M.toolkit.describe(l) + (l.filter ? ' · filtered' : ''));
      const row = h('div.ps-layer' + (l.id === store.activeId ? '.ps-active' : '') + (l.visible ? '' : '.ps-hidden'), {
        role: 'listitem', draggable: true, tabindex: 0, dataset: { id: l.id },
        onclick: function () { store.setActive(l.id); },
        onkeydown: function (e) { if (e.key === 'Delete') run('remove ' + q(l.name)); },
        ondragstart: function (e) { dragId = l.id; e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', l.id); row.classList.add('ps-dragging'); },
        ondragend: function () { dragId = null; row.classList.remove('ps-dragging'); },
        ondragover: function (e) { if (!dragId || dragId === l.id) return; e.preventDefault(); row.classList.add('ps-dropover'); },
        ondragleave: function () { row.classList.remove('ps-dropover'); },
        ondrop: function (e) {
          e.preventDefault();
          row.classList.remove('ps-dropover');
          const moving = store.get(dragId);
          if (!moving || moving.id === l.id) return;
          const targetIdx = store.layers.indexOf(l);
          store.move(moving, targetIdx);
        },
      },
      h('span.ps-grip', ui.icon('grip', 14)), eye, ui.swatch(l),
      h('span.ps-layer-text', nameEl, meta),
      selCount ? h('span.ps-badge', { title: selCount + ' selected' }, util.formatNumber(selCount, 0)) : null,
      more);
      listEl.appendChild(row);
      // mini legend for classified styles
      const lg = M.style.legend(l);
      if (l.visible && lg && ((lg.items && lg.items.length > 1) || lg.gradient)) {
        const mini = h('div.ps-minilegend');
        if (lg.gradient) mini.appendChild(h('div.ps-gradient-row', h('span.ps-gradient', { style: { background: lg.gradient.css } }), h('span.ps-dim', fmt(lg.gradient.min) + ' – ' + fmt(lg.gradient.max))));
        (lg.items || []).slice(0, 12).forEach(function (it) { mini.appendChild(h('div.ps-legend-item', swatchFor(it), h('span', it.label))); });
        if ((lg.items || []).length > 12) mini.appendChild(h('div.ps-dim', '… ' + (lg.items.length - 12) + ' more'));
        listEl.appendChild(mini);
      }
    });
  }

  function fmt(v) { return typeof v === 'number' ? util.formatNumber(v) : (v === undefined ? '' : String(v)); }

  function swatchFor(it) {
    const s = h('span.ps-swatch.ps-swatch-' + (it.shape === 'line' ? 'linestring' : it.shape === 'point' ? 'point' : 'polygon'));
    s.style.background = it.color;
    if (it.stroke && it.shape === 'fill') { s.style.borderColor = it.stroke; if (it.color === 'transparent') s.style.borderWidth = '2px'; }
    return s;
  }
  panel.swatchFor = swatchFor;
})(typeof globalThis !== 'undefined' ? globalThis : this);
