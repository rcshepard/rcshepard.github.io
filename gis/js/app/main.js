/*
 * PSICITS — application bootstrap: layout, menus, shortcuts, drag & drop,
 * autosave, status bar.
 */
(function (root) {
  'use strict';

  const M = root.PSICITS;
  const util = M.util;
  const ui = M.ui;
  const h = ui.h;
  const store = M.store;
  const app = M.app;
  const run = function (cmd) { return app.run(cmd, { source: 'ui' }); };
  const q = function (n) { return M.layersPanel.q(n); };

  const $ = function (id) { return document.getElementById(id); };

  /* --------------------------------------------------------------- theme */

  function applyTheme(mode) {
    let m = mode;
    if (m === 'toggle') m = document.documentElement.classList.contains('dark') ? 'light' : 'dark';
    if (!m || m === 'auto') m = root.matchMedia && root.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    document.documentElement.classList.toggle('dark', m === 'dark');
    try { localStorage.setItem('psicits.theme', mode === 'auto' ? 'auto' : m); } catch (e) { /* ignore */ }
  }

  /* -------------------------------------------------------------- menus */

  function fileMenu(anchor) {
    const active = store.active;
    ui.menu(anchor, [
      { label: 'New project', icon: 'plus', onClick: function () { run('new'); } },
      { label: 'Open files…', icon: 'folder', hint: 'Ctrl+O', onClick: function () { run('open'); } },
      { label: 'Save project', icon: 'save', hint: 'Ctrl+S', onClick: function () { run('save'); } },
      '-',
      { label: 'Export current layer…', icon: 'download', disabled: !active || active.type === 'tiles', onClick: function () { exportDialog(active); } },
      { label: 'Export map image (PNG)', icon: 'map', onClick: function () { run('screenshot'); } },
      '-',
      { label: 'Script editor…', icon: 'code', onClick: function () { run('script'); } },
      { label: 'Save command history as script', icon: 'save', onClick: function () { run('history save'); } },
    ]);
  }

  async function exportDialog(layer) {
    if (!layer) return;
    const fmts = M.io.EXPORT_FORMATS;
    const sel = h('select.ps-select', Object.keys(fmts).filter(function (k) { return fmts[k].kinds.indexOf(layer.type) >= 0; }).map(function (k) { return h('option', { value: k }, fmts[k].label); }));
    const crs = h('input.ps-input', { type: 'text', placeholder: 'EPSG:4326 (default)' });
    const onlySel = h('input', { type: 'checkbox', disabled: !store.selectedIds(layer.id).length });
    const body = h('div',
      h('label.ps-field', h('span.ps-field-label', 'Format'), sel),
      h('label.ps-field', h('span.ps-field-label', 'Coordinate system'), crs, h('span.ps-field-help', 'Optional, e.g. EPSG:3435 or EPSG:32616. Reprojection uses GDAL for most formats.')),
      layer.type === 'vector' ? h('label.ps-field.ps-field-flag', onlySel, h('span', 'Selected features only')) : null);
    const ok = await ui.modal({ title: 'Export · ' + layer.name, body: body, actions: [{ label: 'Cancel', value: false }, { label: 'Export', primary: true, value: true }] });
    if (!ok) return;
    run('export ' + q(layer.name) + ' as ' + sel.value + (crs.value.trim() ? ' crs ' + crs.value.trim() : '') + (onlySel.checked ? ' selected' : ''));
  }

  function toolsMenu(anchor) {
    const pick = function (name) { return function () { showLeft('toolbox'); M.toolbox.open(name); }; };
    ui.menu(anchor, [
      { label: 'Open the toolbox', icon: 'toolbox', onClick: function () { showLeft('toolbox'); } },
      '-',
      { heading: 'Common' },
      { label: 'Buffer', onClick: pick('buffer') },
      { label: 'Clip', onClick: pick('clip') },
      { label: 'Dissolve', onClick: pick('dissolve') },
      { label: 'Intersect', onClick: pick('intersect') },
      { label: 'Count points in polygons', onClick: pick('count') },
      { label: 'Spatial join', onClick: pick('spatial join') },
      { label: 'Nearest', onClick: pick('nearest') },
      { label: 'Select by attributes / location', onClick: pick('select') },
      { label: 'Field calculator', onClick: pick('calc') },
      { label: 'Hex grid', onClick: pick('grid') },
      '-',
      { heading: 'Raster' },
      { label: 'Hillshade', onClick: pick('hillshade') },
      { label: 'Contours', onClick: pick('contours') },
      { label: 'Band math', onClick: pick('bandmath') },
      { label: 'Zonal statistics', onClick: pick('zonal') },
      '-',
      { label: 'GDAL command line help', icon: 'gdal', onClick: function () { run('help gdal'); } },
    ]);
  }

  function viewMenu(anchor) {
    const B = M.mapview.BASEMAPS;
    ui.menu(anchor, [{ heading: 'Basemap' }].concat(Object.keys(B).map(function (k) {
      return { label: B[k].label, checked: M.mapview.basemap === k, onClick: function () { run('basemap ' + k); } };
    })).concat([
      '-',
      { label: 'Legend', checked: M.legend.visible, onClick: function () { run('legend toggle'); } },
      { label: 'Globe view', checked: !!(M.mapview.map.getProjection && M.mapview.map.getProjection() && M.mapview.map.getProjection().type === 'globe'), onClick: function () { run('globe toggle'); } },
      { label: 'Reset rotation & tilt', onClick: function () { run('north'); } },
      { label: 'Zoom to all layers', onClick: function () { run('zoom all'); } },
      '-',
      { label: 'Dark interface', checked: document.documentElement.classList.contains('dark'), onClick: function () { applyTheme('toggle'); } },
      { label: 'Layers panel', checked: !$('ps-left').hidden, onClick: function () { togglePanel('left'); } },
      { label: 'Console', checked: !$('ps-right').hidden, onClick: function () { togglePanel('right'); } },
      { label: 'Attribute table', checked: !$('ps-bottom').hidden, onClick: function () { togglePanel('bottom'); } },
    ]));
  }

  function helpMenu(anchor) {
    ui.menu(anchor, [
      { label: 'All commands', icon: 'help', onClick: function () { run('help'); } },
      { label: 'Expressions', onClick: function () { run('help expressions'); } },
      { label: 'GDAL command line', onClick: function () { run('help gdal'); } },
      { label: 'File formats', onClick: function () { run('help formats'); } },
      { label: 'Color ramps', onClick: function () { run('help ramps'); } },
      { label: 'Keyboard shortcuts', onClick: function () { run('help keys'); } },
      '-',
      { label: 'About ' + M.appName, icon: 'info', onClick: about },
    ]);
  }

  function about() {
    ui.modal({
      title: 'About',
      body: h('div',
        h('div.ps-about-mark', h('b', M.appName), h('i', M.appTagline)),
        h('p', 'A GIS that runs entirely in the web browser, made for GIS courses at the University of Chicago so that nobody falls behind in week one because desktop software won\'t install (usually for lack of admin rights on a laptop). There is nothing to install, and your data never leaves your computer — only basemap tiles, place search and OpenStreetMap downloads use the internet.'),
        h('p', 'Version ' + M.version + '. Open source (MIT). Built with MapLibre GL JS, Turf, Terra Draw, gdal3.js (GDAL/PROJ/GEOS/SpatiaLite in WebAssembly), proj4js, geotiff.js, sql.js, shpjs, togeojson, PapaParse, JSZip, FlatGeobuf and osmtogeojson — see THIRD_PARTY_NOTICES.md.'),
        h('p.ps-dim', 'Basemaps © OpenStreetMap contributors, OpenFreeMap, Esri, OpenTopoMap.'),
        h('p.ps-fineprint', 'Colors and type are inspired by the University of Chicago\'s visual identity (Phoenix Maroon, EB Garamond). ' + M.appName + ' is an independent teaching tool, not an official University of Chicago product.')),
      actions: [{ label: 'Close', primary: true }],
    });
  }

  /* ------------------------------------------------------------- panels */

  function showLeft(tab) {
    $('ps-left').hidden = false;
    document.querySelectorAll('.ps-tab').forEach(function (t) { t.classList.toggle('ps-active', t.dataset.tab === tab); });
    $('ps-layers-pane').hidden = tab !== 'layers';
    $('ps-toolbox-pane').hidden = tab !== 'toolbox';
    resizeMap();
  }

  function togglePanel(which, force) {
    const el = $('ps-' + which);
    const show = force !== undefined ? force : el.hidden;
    el.hidden = !show;
    const handle = $('ps-' + which + '-resize');
    if (handle) handle.hidden = !show;
    try { localStorage.setItem('psicits.panel.' + which, show ? '1' : '0'); } catch (e) { /* ignore */ }
    resizeMap();
  }

  function resizeMap() { if (M.mapview.map) setTimeout(function () { M.mapview.map.resize(); }, 0); }

  /* -------------------------------------------------------- draw toolbar */

  function drawToolbar(mapHost) {
    const btn = function (icon, title, cmd, id) {
      return h('button.ps-toolbtn-map', { type: 'button', title: title, 'aria-label': title, dataset: { id: id || '' }, onclick: function () { typeof cmd === 'function' ? cmd() : run(cmd); } }, ui.icon(icon, 18));
    };
    const bar = h('div.ps-drawbar',
      btn('cursor', 'Select / identify (Esc)', function () { run('done'); }, 'identify'),
      h('div.ps-drawbar-sep'),
      btn('point', 'Draw points', 'draw point', 'point'),
      btn('line', 'Draw lines', 'draw line', 'linestring'),
      btn('polygon', 'Draw polygons', 'draw polygon', 'polygon'),
      btn('rect', 'Draw rectangles', 'draw rectangle', 'rectangle'),
      btn('circle', 'Draw circles', 'draw circle', 'circle'),
      btn('freehand', 'Freehand polygons', 'draw freehand', 'freehand'),
      h('div.ps-drawbar-sep'),
      btn('pencil', 'Edit vertices of the selected layer', function () {
        const l = store.active;
        if (!l || l.type !== 'vector') { ui.toast('Select a vector layer in the Layers panel first'); return; }
        run('edit ' + q(l.name));
      }, 'edit'),
      btn('ruler', 'Measure distance', 'measure distance', 'measure-linestring'),
      btn('polygon', 'Measure area', 'measure area', 'measure-polygon'));
    const confirm = h('div.ps-drawbar-confirm', { hidden: true },
      h('button.ps-btn.ps-primary.ps-small', { type: 'button', onclick: function () { run('done'); } }, ui.icon('check', 14), ' Done'),
      h('button.ps-btn.ps-small', { type: 'button', onclick: function () { run('cancel'); } }, 'Cancel'));
    mapHost.appendChild(bar);
    mapHost.appendChild(confirm);
    app.on('draw-mode', function (e) {
      bar.querySelectorAll('button').forEach(function (b) {
        const id = b.dataset.id;
        const on = e.kind === 'draw' ? id === e.mode : e.kind === 'measure' ? id === 'measure-' + e.mode : e.kind === 'edit' ? id === 'edit' : id === 'identify';
        b.classList.toggle('ps-on', on);
      });
      confirm.hidden = !e.kind || e.kind === 'measure' && false;
    });
    bar.querySelector('[data-id="identify"]').classList.add('ps-on');
  }

  /* ---------------------------------------------------------- status bar */

  function statusBar() {
    const coords = $('ps-coords'), zoom = $('ps-zoom'), selEl = $('ps-selcount'), busy = $('ps-busy');
    M.mapview.on('pointer', function (p) { coords.textContent = p.lat.toFixed(5) + ', ' + p.lng.toFixed(5); });
    M.mapview.on('zoom', function (z) { zoom.textContent = 'z ' + z.toFixed(1); });
    M.mapview.map.on('load', function () { zoom.textContent = 'z ' + M.mapview.map.getZoom().toFixed(1); });
    store.on('selection', function () {
      let n = 0;
      store.selection.forEach(function (s) { n += s.size; });
      selEl.textContent = n ? util.formatNumber(n, 0) + ' selected' : '';
    });
    app.on('busy', function (b) { busy.hidden = !b; });
    const undoBtn = $('ps-undo'), redoBtn = $('ps-redo');
    const upd = function () {
      undoBtn.disabled = !store.canUndo; redoBtn.disabled = !store.canRedo;
      undoBtn.title = store.undoLabel ? 'Undo: ' + store.undoLabel + ' (Ctrl+Z)' : 'Undo (Ctrl+Z)';
      redoBtn.title = store.redoLabel ? 'Redo: ' + store.redoLabel + ' (Ctrl+Y)' : 'Redo (Ctrl+Y)';
    };
    store.on('history', upd);
    upd();
  }

  /* ---------------------------------------------------------- drag & drop */

  function dragAndDrop() {
    const overlay = $('ps-drop');
    let depth = 0;
    const hasFiles = function (e) { return e.dataTransfer && Array.prototype.indexOf.call(e.dataTransfer.types || [], 'Files') >= 0; };
    document.addEventListener('dragenter', function (e) { if (!hasFiles(e)) return; depth++; overlay.hidden = false; e.preventDefault(); });
    document.addEventListener('dragleave', function (e) { if (!hasFiles(e)) return; depth = Math.max(0, depth - 1); if (!depth) overlay.hidden = true; });
    document.addEventListener('dragover', function (e) { if (hasFiles(e)) e.preventDefault(); });
    document.addEventListener('drop', function (e) {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth = 0;
      overlay.hidden = true;
      importFiles(e.dataTransfer.files);
    });
    // paste GeoJSON / WKT / CSV text straight onto the map
    document.addEventListener('paste', function (e) {
      const t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      const files = e.clipboardData && e.clipboardData.files;
      if (files && files.length) { e.preventDefault(); importFiles(files); return; }
      const text = e.clipboardData && e.clipboardData.getData('text');
      if (!text || text.length < 10) return;
      const trimmed = text.trim();
      let name = 'pasted';
      if (/^[[{]/.test(trimmed)) name += '.geojson';
      else if (/^(POINT|LINESTRING|POLYGON|MULTI|GEOMETRYCOLLECTION)/i.test(trimmed)) name += '.wkt';
      else if (/^[^\n]*[,\t][^\n]*\n/.test(trimmed)) name += '.csv';
      else return;
      e.preventDefault();
      importBlob(name, new TextEncoder().encode(trimmed));
    });
  }

  async function importFiles(files) {
    const list = Array.from(files || []);
    if (!list.length) return;
    // scripts: .txt files full of commands
    if (list.length === 1 && /\.(txt|psicits|cmd)$/i.test(list[0].name)) {
      const text = await list[0].text();
      const lines = M.commands.splitScript(text);
      if (lines.length && M.commands.parse(lines[0].text, store.ctx()).tool && await ui.confirm('Run the ' + lines.length + ' command(s) in "' + list[0].name + '"?', { ok: 'Run script' })) {
        app.runScript(text);
        return;
      }
    }
    const out = app.output('open ' + list.map(function (f) { return f.name; }).join(', '));
    try {
      out.progress('Reading ' + list.length + ' file(s)…');
      const res = await M.io.importFiles(list, { askCrs: M.toolkit.askCrs });
      await addResults(res, out);
      out.done('ok');
    } catch (e) {
      console.error(e);
      out.error(e.message || String(e));
      out.done('error');
    }
  }

  async function importBlob(name, bytes) {
    const out = app.output('open ' + name);
    try {
      const res = await M.io.importBytes(name, bytes, { askCrs: M.toolkit.askCrs });
      await addResults(res, out);
      out.done('ok');
    } catch (e) { out.error(e.message); out.done('error'); }
  }

  async function addResults(res, out) {
    (res.warnings || []).forEach(function (w) { out.warn(w); });
    for (const proj of (res.projects || []).concat(res.project ? [res.project] : [])) {
      if (store.layers.length && !(await ui.confirm('Open this project? The current layers will be replaced.', { ok: 'Open project' }))) continue;
      store.fromJSON(proj);
      if (proj.view) M.mapview.setView(proj.view);
      if (Array.isArray(proj.history)) app.history = proj.history.slice();
      out.success('Opened project (' + proj.layers.length + ' layers)');
    }
    const first = store.layers.length === 0;
    res.layers.forEach(function (spec, i) {
      const layer = store.add(spec);
      out.layer(layer, 'Loaded');
      if ((first || i === res.layers.length - 1) && layer.bbox) M.mapview.zoomToLayer(layer);
    });
  }
  M.importFiles = importFiles;

  /* ------------------------------------------------------------- autosave */

  const DB_NAME = 'psicits', DB_STORE = 'kv';
  function idb() {
    return new Promise(function (resolve, reject) {
      if (!root.indexedDB) { reject(new Error('no IndexedDB')); return; }
      const r = root.indexedDB.open(DB_NAME, 1);
      r.onupgradeneeded = function () { r.result.createObjectStore(DB_STORE); };
      r.onsuccess = function () { resolve(r.result); };
      r.onerror = function () { reject(r.error); };
    });
  }
  function idbOp(mode, fn) {
    return idb().then(function (db) {
      return new Promise(function (resolve, reject) {
        const tx = db.transaction(DB_STORE, mode);
        const req = fn(tx.objectStore(DB_STORE));
        tx.oncomplete = function () { resolve(req && req.result); };
        tx.onerror = function () { reject(tx.error); };
      });
    });
  }
  let autosaveWarned = false;
  const autosave = util.debounce(function () {
    let features = 0, pixels = 0;
    store.layers.forEach(function (l) { if (l.type === 'vector') features += l.count; else if (l.type === 'raster') pixels += l.raster.width * l.raster.height * l.raster.bands.length; });
    if (features > 400000 || pixels > 60e6) {
      if (!autosaveWarned) { autosaveWarned = true; app.output('autosave').note('This project is large, so it is not autosaved in the browser. Use "save" to keep a copy.'); }
      return;
    }
    const snapshot = { project: store.toJSON({ binary: true }), view: M.mapview.getView(), history: app.history.slice(-300), saved: Date.now() };
    idbOp('readwrite', function (s) { return s.put(snapshot, 'autosave'); }).catch(function () { /* storage unavailable */ });
  }, 1500);

  async function restore() {
    let snap = null;
    try { snap = await idbOp('readonly', function (s) { return s.get('autosave'); }); } catch (e) { return false; }
    if (!snap || !snap.project || !snap.project.layers || !snap.project.layers.length) return false;
    try {
      store.fromJSON(snap.project);
      if (snap.view) M.mapview.setView(snap.view);
      if (Array.isArray(snap.history)) app.history = snap.history;
      const out = app.output('Restored your last session');
      out.text(snap.project.layers.length + ' layer(s) from ' + new Date(snap.saved).toLocaleString() + '. Type "new" to start over.');
      out.done('ok');
      return true;
    } catch (e) {
      console.warn('[PSICITS] could not restore autosave', e);
      return false;
    }
  }

  /* ------------------------------------------------------------ shortcuts */

  function shortcuts() {
    document.addEventListener('keydown', function (e) {
      const t = e.target;
      const typing = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === 'k') { e.preventDefault(); togglePanel('right', true); M.console.focus(); return; }
      if (!typing && e.key === '/') { e.preventDefault(); togglePanel('right', true); M.console.focus(); return; }
      if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); run('save'); return; }
      if (mod && e.key.toLowerCase() === 'o') { e.preventDefault(); run('open'); return; }
      if (typing) return;
      if (mod && !e.shiftKey && e.key.toLowerCase() === 'z') { e.preventDefault(); run('undo'); return; }
      if (mod && (e.key.toLowerCase() === 'y' || (e.shiftKey && e.key.toLowerCase() === 'z'))) { e.preventDefault(); run('redo'); return; }
      if (e.key === 'Escape') {
        if (M.draw.session()) { const s = M.draw.session(); run(s.kind === 'edit' ? 'cancel' : 'done'); return; }
        M.mapview.closePopup();
        return;
      }
      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (M.draw.session() && M.draw.deleteSelected()) { e.preventDefault(); return; }
        const l = store.active;
        if (l && l.type === 'vector' && store.selectedIds(l.id).length) { e.preventDefault(); run('delete ' + q(l.name) + ' selected'); }
      }
    });
  }

  /* ------------------------------------------------------------ URL runs */

  async function runFromUrl() {
    const params = new URLSearchParams(location.search);
    const hash = location.hash.replace(/^#/, '');
    const hp = new URLSearchParams(hash);
    const cmds = [];
    if (params.get('load')) cmds.push('load ' + params.get('load'));
    const script = hp.get('run') || params.get('run');
    if (script) script.split(/\n|;;/).forEach(function (c) { if (c.trim()) cmds.push(c.trim()); });
    if (!cmds.length) return false;
    const unsafe = cmds.some(function (c) { const p = M.commands.parse(c, store.ctx()); return p.tool && (p.tool.name === 'js'); });
    const ok = await ui.confirm(h('div', h('p', 'This link wants to run ' + cmds.length + ' command(s):'), h('pre.ps-code', cmds.join('\n')), unsafe ? h('p.ps-warn', 'It includes JavaScript — only run it if you trust whoever sent the link.') : null), { title: 'Run commands from link?', ok: 'Run' });
    if (!ok) return false;
    for (const c of cmds) { const r = await app.run(c, { source: 'url' }); if (!r.ok) break; }
    return true;
  }

  /** A shareable link that replays the session's commands. */
  M.shareLink = function () {
    return location.href.replace(/#.*$/, '') + '#run=' + encodeURIComponent(app.history.join('\n'));
  };

  /* ---------------------------------------------------------------- boot */

  async function boot() {
    let theme = 'auto';
    try { theme = localStorage.getItem('psicits.theme') || 'auto'; } catch (e) { /* ignore */ }
    applyTheme(theme);
    app.on('theme', applyTheme);

    // brand (index.html has a static fallback; the name lives in js/lib/core.js)
    const wm = document.querySelector('.ps-wordmark'), tg = document.querySelector('.ps-tagline');
    if (wm) wm.textContent = M.appName;
    if (tg) tg.textContent = M.appTagline;
    document.title = M.appName + ' — ' + M.appTagline;

    // top bar
    const menuBtn = function (label, fn) { return h('button.ps-menubtn', { type: 'button', onclick: function (e) { fn(e.currentTarget); } }, label); };
    $('ps-menubar').append(menuBtn('File', fileMenu), menuBtn('Add data', function (a) { M.layersPanel.addMenu(a); }), menuBtn('Tools', toolsMenu), menuBtn('View', viewMenu), menuBtn('Help', helpMenu));
    $('ps-undo').addEventListener('click', function () { run('undo'); });
    $('ps-redo').addEventListener('click', function () { run('redo'); });
    $('ps-theme').addEventListener('click', function () { applyTheme('toggle'); });
    $('ps-toggle-left').addEventListener('click', function () { togglePanel('left'); });
    $('ps-toggle-right').addEventListener('click', function () { togglePanel('right'); });
    $('ps-toggle-bottom').addEventListener('click', function () { togglePanel('bottom'); });
    document.querySelectorAll('.ps-tab').forEach(function (t) { t.addEventListener('click', function () { showLeft(t.dataset.tab); }); });

    // map
    const mapHost = $('ps-map');
    M.mapview.init(mapHost, {});
    M.mapview.on('notice', function (msg) { ui.toast(msg); });
    M.mapview.on('open-table', function (e) { app.emit('open-table', e); });

    // panels
    M.layersPanel.mount($('ps-layers-pane'));
    M.toolbox.mount($('ps-toolbox-pane'));
    M.console.mount($('ps-console'));
    M.table.mount($('ps-bottom'), { onClose: function () { togglePanel('bottom', false); } });
    M.legend.mount(mapHost);
    drawToolbar(mapHost);
    statusBar();
    dragAndDrop();
    shortcuts();

    app.on('open-table', function (e) {
      togglePanel('bottom', true);
      M.table.open(e.layerId || store.activeId, e.fid);
    });

    // resizable panels
    ui.resizable($('ps-left-resize'), $('ps-left'), { axis: 'x', min: 200, max: 520, onEnd: resizeMap });
    ui.resizable($('ps-right-resize'), $('ps-right'), { axis: 'x', min: 280, max: 720, invert: true, onEnd: resizeMap });
    ui.resizable($('ps-bottom-resize'), $('ps-bottom'), { axis: 'y', min: 120, max: 700, invert: true, onEnd: resizeMap });
    ['left', 'right'].forEach(function (w) {
      let v = null;
      try { v = localStorage.getItem('psicits.panel.' + w); } catch (e) { /* ignore */ }
      if (v === '0' || (w === 'left' && root.innerWidth < 720)) togglePanel(w, false);
    });
    if (root.innerWidth < 900) togglePanel('right', false);

    // autosave & restore
    ['layer:add', 'layer:remove', 'layer:update', 'layer:order', 'project:clear'].forEach(function (evt) { store.on(evt, autosave); });
    const restored = await restore();
    const ranUrl = await runFromUrl();
    if (!restored && !ranUrl) M.console.welcome();
    if (root.innerWidth >= 900) M.console.focus();
    document.documentElement.classList.add('ps-ready');
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})(typeof globalThis !== 'undefined' ? globalThis : this);
