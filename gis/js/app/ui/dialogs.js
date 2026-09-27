/*
 * PSICITS — legend overlay, style editor and script editor.
 * The style editor writes text commands and runs them, so every styling
 * choice is visible (and repeatable) in the console.
 */
(function (root) {
  'use strict';

  const M = root.PSICITS;
  const util = M.util;
  const ui = M.ui;
  const h = ui.h;
  const store = M.store;
  const app = M.app;
  const q = function (n) { return M.layersPanel.q(n); };

  /* =============================================================== legend */

  const legend = (M.legend = { visible: true });
  let legendEl, legendBody;

  legend.mount = function (mapHost) {
    legendBody = h('div.ps-legend-body');
    legendEl = h('div.ps-legend', h('div.ps-legend-head', h('span', 'Legend'), ui.iconButton('close', 'Hide legend', function () { legend.set(false); }, 'ps-mini')), legendBody);
    mapHost.appendChild(legendEl);
    try { legend.visible = localStorage.getItem('psicits.legend') !== 'off'; } catch (e) { /* ignore */ }
    ['layer:add', 'layer:remove', 'layer:update', 'layer:order', 'project:load'].forEach(function (e) { store.on(e, util.debounce(render, 50)); });
    M.mapview.on('raster-rendered', util.debounce(render, 50));
    app.on('legend', function (state) { legend.set(state === 'toggle' ? !legend.visible : state !== 'off'); });
    render();
  };

  legend.set = function (v) {
    legend.visible = !!v;
    try { localStorage.setItem('psicits.legend', v ? 'on' : 'off'); } catch (e) { /* ignore */ }
    render();
  };

  function render() {
    if (!legendEl) return;
    const layers = store.ordered().filter(function (l) { return l.visible && l.type !== 'tiles'; });
    legendEl.hidden = !legend.visible || !layers.length;
    legendBody.innerHTML = '';
    layers.forEach(function (l) {
      const lg = M.style.legend(l);
      const block = h('div.ps-legend-layer', h('div.ps-legend-title', lg.single ? M.layersPanel.swatchFor(lg.items[0]) : null, h('span', lg.title), lg.subtitle ? h('span.ps-dim', ' · ' + lg.subtitle) : null));
      if (lg.gradient) {
        block.appendChild(h('div.ps-gradient-row', h('span.ps-gradient', { style: { background: lg.gradient.css } })));
        block.appendChild(h('div.ps-gradient-labels', h('span', fmt(lg.gradient.min)), h('span', fmt(lg.gradient.max))));
      }
      if (!lg.single) (lg.items || []).slice(0, 16).forEach(function (it) { block.appendChild(h('div.ps-legend-item', M.layersPanel.swatchFor(it), h('span', it.label))); });
      if (!lg.single && (lg.items || []).length > 16) block.appendChild(h('div.ps-dim', '… ' + (lg.items.length - 16) + ' more'));
      legendBody.appendChild(block);
    });
  }
  function fmt(v) { return typeof v === 'number' ? util.formatNumber(v) : v === undefined || v === null ? '' : String(v); }

  /* ========================================================= style editor */

  function field(label, control, help) { return h('label.ps-field', h('span.ps-field-label', label), control, help ? h('span.ps-field-help', help) : null); }
  function select(options, value) {
    return h('select.ps-select', options.map(function (o) { const v = typeof o === 'object' ? o.value : o; return h('option', { value: v, selected: String(v) === String(value) }, typeof o === 'object' ? o.label : o); }));
  }

  async function styleEditor(layerId) {
    const l = store.get(layerId);
    if (!l) return;
    if (l.type === 'tiles') { ui.toast('Tile layers only have opacity: opacity ' + l.name + ' 50%'); return; }
    const n = q(l.name);
    const s = l.style || {};
    const body = h('div.ps-style-editor');
    const preview = h('pre.ps-code.ps-small');
    let build;

    if (l.type === 'raster') {
      const nb = l.raster.bands.length;
      const st = l.renderedStyle || s;
      const mode = select([{ value: 'single', label: 'Single band (color ramp)' }, { value: 'rgb', label: 'RGB composite' }, { value: 'categories', label: 'Categories (unique values)' }], st.mode === 'rgb' ? 'rgb' : st.mode === 'palette' ? 'categories' : 'single');
      const bandOpts = l.raster.bands.map(function (_, i) { return { value: i + 1, label: (i + 1) + (l.bandNames[i] && !/^b\d+$/.test(l.bandNames[i]) ? ' · ' + l.bandNames[i] : '') }; });
      const band = select(bandOpts, (st.band || 0) + 1);
      const ramp = select(M.colors.rampNames(), st.ramp || 'viridis');
      const mn = h('input.ps-input.ps-num-input', { type: 'number', step: 'any', value: st.min !== undefined ? +(+st.min).toPrecision(6) : '' });
      const mx = h('input.ps-input.ps-num-input', { type: 'number', step: 'any', value: st.max !== undefined ? +(+st.max).toPrecision(6) : '' });
      const rb = [0, 1, 2].map(function (i) { return select(bandOpts, (st.bands && st.bands[i] !== undefined ? st.bands[i] : Math.min(i, nb - 1)) + 1); });
      const grad = h('div.ps-gradient.ps-wide');
      const single = h('div', field('Band', band), field('Color ramp', h('div', ramp, grad)), field('Stretch (min / max)', h('span.ps-inline', mn, mx), 'Leave empty for automatic (2–98 %)'));
      const rgb = h('div', field('Red band', rb[0]), field('Green band', rb[1]), field('Blue band', rb[2]));
      const cats = h('div', field('Band', select(bandOpts, (st.band || 0) + 1)));
      body.appendChild(field('Display', mode));
      body.appendChild(single); body.appendChild(rgb); body.appendChild(cats);
      const opacity = h('input', { type: 'range', min: 0, max: 100, value: Math.round((l.opacity === undefined ? 1 : l.opacity) * 100) });
      body.appendChild(field('Opacity', opacity));
      build = function () {
        single.hidden = mode.value !== 'single'; rgb.hidden = mode.value !== 'rgb'; cats.hidden = mode.value !== 'categories';
        grad.style.background = M.colors.gradientCSS(ramp.value);
        const cmds = [];
        if (mode.value === 'single') cmds.push('color ' + n + ' ' + ramp.value + (mn.value !== '' && mx.value !== '' ? ' ' + mn.value + ' ' + mx.value : '') + (nb > 1 ? ' band ' + band.value : ''));
        else if (mode.value === 'rgb') cmds.push('rgb ' + n + ' ' + rb.map(function (x) { return x.value; }).join(' '));
        else cmds.push('color ' + n + ' categories' + (nb > 1 ? ' band ' + cats.querySelector('select').value : ''));
        const op = Math.round((l.opacity === undefined ? 1 : l.opacity) * 100);
        if (+opacity.value !== op) cmds.push('opacity ' + n + ' ' + opacity.value + '%');
        return cmds;
      };
    } else {
      const g = l.geometryType;
      const fields = l.fields.map(function (f) { return f.name; });
      const numeric = l.fields.filter(function (f) { return M.style.isNumericField(l, f.name); }).map(function (f) { return f.name; });
      const kinds = [{ value: 'single', label: 'Single color' }, { value: 'categorized', label: 'Categories (by a field)' }, { value: 'graduated', label: 'Graduated / choropleth (numeric field)' }];
      if (g === 'Point' || g === 'Mixed') kinds.push({ value: 'heatmap', label: 'Heatmap' });
      const kind = select(kinds, s.kind || 'single');
      const color = h('input', { type: 'color', value: M.colors.normalize(s.color) || '#800000' });
      const catField = select(fields.length ? fields : ['(no fields)'], s.kind === 'categorized' ? s.field : fields[0]);
      const palette = select(M.colors.paletteNames(), s.palette || 'tableau10');
      const gradField = select(numeric.length ? numeric : ['(no numeric fields)'], s.kind === 'graduated' ? s.field : numeric[0]);
      const method = select(M.classify.METHODS, s.method && s.method !== 'manual' ? s.method : 'quantile');
      const classes = select([3, 4, 5, 6, 7, 8, 9], s.classes || 5);
      const ramp = select(M.colors.rampNames(), s.ramp || 'ylorrd');
      const grad = h('div.ps-gradient.ps-wide');
      const heatField = select(['(none)'].concat(numeric), (s.heat && s.heat.weightField) || '(none)');
      const heatRadius = h('input.ps-input.ps-num-input', { type: 'number', value: (s.heat && s.heat.radius) || 20 });
      const secSingle = h('div', field('Color', color));
      const secCat = h('div', field('Field', catField), field('Palette', palette));
      const secGrad = h('div', field('Field', gradField), field('Method', method), field('Classes', classes), field('Color ramp', h('div', ramp, grad)));
      const secHeat = h('div', field('Weight field', heatField), field('Radius (px)', heatRadius));
      body.appendChild(field('Style', kind));
      [secSingle, secCat, secGrad, secHeat].forEach(function (x) { body.appendChild(x); });
      const opacity = h('input', { type: 'range', min: 0, max: 100, value: Math.round((l.opacity === undefined ? 1 : l.opacity) * 100) });
      const fillOp = h('input', { type: 'range', min: 0, max: 100, value: Math.round((s.fillOpacity === undefined ? 0.5 : s.fillOpacity) * 100) });
      const stroke = h('input', { type: 'color', value: M.colors.normalize(s.strokeColor) || '#333333' });
      const strokeW = h('input.ps-input.ps-num-input', { type: 'number', step: '0.5', min: 0, value: s.strokeWidth === undefined ? 1 : s.strokeWidth });
      const size = h('input.ps-input.ps-num-input', { type: 'number', step: '0.5', min: 0, value: g === 'Point' ? (s.radius || 5) : (s.lineWidth || 2) });
      const labelField = select(['(none)'].concat(fields), s.labels && s.labels.field ? s.labels.field : '(none)');
      const labelSize = h('input.ps-input.ps-num-input', { type: 'number', min: 6, max: 40, value: (s.labels && s.labels.size) || 12 });
      body.appendChild(h('div.ps-grid2',
        field('Layer opacity', opacity),
        g === 'Polygon' || g === 'Mixed' ? field('Fill opacity', fillOp) : h('span'),
        g !== 'LineString' ? field('Outline', h('span.ps-inline', stroke, strokeW)) : h('span'),
        g === 'Point' || g === 'LineString' ? field(g === 'Point' ? 'Point size (px)' : 'Line width (px)', size) : h('span'),
        field('Labels', labelField), field('Label size', labelSize)));
      const orig = { opacity: opacity.value, fillOp: fillOp.value, stroke: stroke.value, strokeW: strokeW.value, size: size.value, label: labelField.value, labelSize: labelSize.value };
      build = function () {
        secSingle.hidden = kind.value !== 'single'; secCat.hidden = kind.value !== 'categorized'; secGrad.hidden = kind.value !== 'graduated'; secHeat.hidden = kind.value !== 'heatmap';
        grad.style.background = M.colors.gradientCSS(ramp.value);
        const cmds = [];
        const fq = function (x) { return q(x); };
        if (kind.value === 'single') cmds.push('color ' + n + ' ' + color.value);
        else if (kind.value === 'categorized' && fields.length) cmds.push('color ' + n + ' by ' + fq(catField.value) + ' categories ' + palette.value);
        else if (kind.value === 'graduated' && numeric.length) cmds.push('color ' + n + ' by ' + fq(gradField.value) + ' ' + classes.value + ' ' + method.value + ' ' + ramp.value);
        else if (kind.value === 'heatmap') cmds.push('heatmap ' + n + (heatField.value !== '(none)' ? ' by ' + fq(heatField.value) : '') + ' radius ' + heatRadius.value);
        if (s.kind === 'heatmap' && kind.value !== 'heatmap') cmds.unshift('heatmap ' + n + ' off');
        if (opacity.value !== orig.opacity) cmds.push('opacity ' + n + ' ' + opacity.value + '%');
        if (fillOp.value !== orig.fillOp) cmds.push('fill ' + n + ' ' + fillOp.value + '%');
        if (stroke.value !== orig.stroke || strokeW.value !== orig.strokeW) cmds.push('outline ' + n + ' ' + stroke.value + ' ' + strokeW.value);
        if (size.value !== orig.size) cmds.push('size ' + n + ' ' + size.value);
        if (labelField.value !== orig.label || labelSize.value !== orig.labelSize) cmds.push(labelField.value === '(none)' ? 'unlabel ' + n : 'label ' + n + ' ' + fq(labelField.value) + ' size ' + labelSize.value);
        return cmds;
      };
    }
    body.appendChild(h('div.ps-dim', 'Commands that will run:'));
    body.appendChild(preview);
    const refresh = function () { preview.textContent = build().join('\n') || '(no changes)'; };
    body.addEventListener('input', refresh);
    body.addEventListener('change', refresh);
    refresh();
    const ok = await ui.modal({ title: 'Style · ' + l.name, body: body, wide: true, actions: [{ label: 'Cancel', value: false }, { label: 'Apply', primary: true, value: true }] });
    if (!ok) return;
    const cmds = build();
    for (const c of cmds) await app.run(c, { source: 'ui' });
  }
  M.styleEditor = styleEditor;

  /* ========================================================= script editor */

  const SCRIPT_KEY = 'psicits.script';
  async function scriptEditor() {
    let saved = '';
    try { saved = localStorage.getItem(SCRIPT_KEY) || ''; } catch (e) { /* ignore */ }
    const ta = h('textarea.ps-input.ps-script', { spellcheck: false, rows: 16, placeholder: '# One command per line. Lines starting with # are comments.\nsample us-states\ncolor us_states by density 7 jenks ylorrd\nlabel us_states name size 10' }, saved);
    const keepGoing = h('input', { type: 'checkbox' });
    const body = h('div',
      h('p.ps-dim', 'Write one command per line (Ctrl+Enter runs). Scripts are plain text — share them, or save the ones you use often.'),
      ta,
      h('div.ps-inline',
        h('label.ps-check-label', keepGoing, ' keep going after errors'),
        h('span.ps-spacer'),
        h('button.ps-btn.ps-small', { type: 'button', onclick: function () { ta.value = (ta.value ? ta.value.replace(/\s*$/, '\n') : '') + app.history.join('\n'); } }, 'Insert history'),
        h('button.ps-btn.ps-small', { type: 'button', onclick: async function () {
          const f = await M.io.pickFiles({ multiple: false, accept: '.txt,.psicits,.cmd,text/plain' });
          if (f && f[0]) ta.value = await f[0].text();
        } }, 'Load…'),
        h('button.ps-btn.ps-small', { type: 'button', onclick: function () { M.io.download(new Blob([ta.value], { type: 'text/plain' }), 'script.txt'); } }, 'Save…')));
    ta.addEventListener('keydown', function (e) { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); document.querySelector('.ps-modal .ps-primary').click(); } e.stopPropagation(); });
    const res = await ui.modal({ title: 'Script', body: body, wide: true, actions: [{ label: 'Close', value: false }, { label: 'Run script', primary: true, value: true }] });
    try { localStorage.setItem(SCRIPT_KEY, ta.value); } catch (e) { /* ignore */ }
    if (res) {
      const r = await app.runScript(ta.value, { keepGoing: keepGoing.checked });
      if (!r.ok) ui.toast('Script stopped at line ' + r.failedLine + ': ' + r.error, 'error');
      else ui.toast('Ran ' + r.ran + ' command(s)', 'success');
    }
  }
  M.scriptEditor = scriptEditor;

  app.on('style-editor', function (e) { styleEditor(e.layerId); });
  app.on('script-editor', scriptEditor);
})(typeof globalThis !== 'undefined' ? globalThis : this);
