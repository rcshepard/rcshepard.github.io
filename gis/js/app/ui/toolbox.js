/*
 * PSICITS — toolbox: every command as a form, generated from its parameter
 * definitions. Running a form prints the equivalent text command.
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

  const box = (M.toolbox = {});
  let listEl, formEl, searchEl;
  let current = null; // { tool, controls }
  const HIDDEN_CATS = [];

  box.mount = function (host) {
    searchEl = h('input.ps-input', { type: 'search', placeholder: 'Search tools…', oninput: renderList });
    listEl = h('div.ps-toollist');
    formEl = h('div.ps-toolform', { hidden: true });
    host.appendChild(h('div.ps-panel-head', h('h3', 'Toolbox')));
    host.appendChild(h('div.ps-pad', searchEl));
    host.appendChild(listEl);
    host.appendChild(formEl);
    renderList();
    ['layer:add', 'layer:remove', 'layer:update'].forEach(function (e) { store.on(e, function () { if (current) refreshLayerSelects(); }); });
  };

  function renderList() {
    const term = (searchEl.value || '').trim().toLowerCase();
    listEl.innerHTML = '';
    const cats = {};
    C.all().forEach(function (t) {
      if (t.raw && t.category === 'GDAL' && !term) { /* still listed below */ }
      if (HIDDEN_CATS.indexOf(t.category) >= 0) return;
      const hay = (t.name + ' ' + t.aliases.join(' ') + ' ' + (t.summary || '') + ' ' + (t.category || '')).toLowerCase();
      if (term && hay.indexOf(term) < 0) return;
      (cats[t.category || 'Other'] = cats[t.category || 'Other'] || []).push(t);
    });
    const order = M.toolkit.CATEGORY_ORDER.concat(Object.keys(cats).filter(function (c) { return M.toolkit.CATEGORY_ORDER.indexOf(c) < 0; }));
    order.forEach(function (c) {
      if (!cats[c]) return;
      const det = h('details.ps-cat', { open: !!term || ['Vector', 'Select & query'].indexOf(c) >= 0 },
        h('summary', c, h('span.ps-dim', ' ' + cats[c].length)),
        cats[c].map(function (t) {
          return h('button.ps-toolbtn', { type: 'button', title: t.summary || '', onclick: function () { openForm(t); } }, h('span.ps-toolname', t.title || titleCase(t.name)), h('span.ps-toolsum', t.summary || ''));
        }));
      listEl.appendChild(det);
    });
  }

  function titleCase(s) { return String(s).replace(/\b\w/g, function (c) { return c.toUpperCase(); }); }

  box.open = function (name) {
    const t = C.get(name);
    if (t) openForm(t);
  };

  function openForm(tool) {
    const controls = {};
    formEl.innerHTML = '';
    formEl.hidden = false;
    listEl.hidden = true;
    searchEl.parentNode.hidden = true;
    const preview = h('code.ps-form-preview');
    const back = h('button.ps-btn.ps-small', { type: 'button', onclick: closeForm }, '← All tools');
    formEl.appendChild(h('div.ps-form-head', back, h('h4', tool.title || titleCase(tool.name))));
    if (tool.summary) formEl.appendChild(h('p.ps-dim', tool.summary));
    const fields = h('div.ps-form-fields');
    formEl.appendChild(fields);
    const params = tool.params.filter(function (p) { return !p.hidden; });
    current = { tool: tool, controls: controls, preview: preview };
    params.forEach(function (p) {
      const ctl = control(p, tool, controls);
      controls[p.name] = ctl;
      fields.appendChild(h('label.ps-field' + (p.type === 'flag' ? '.ps-field-flag' : ''),
        p.type === 'flag' ? [ctl.el, h('span', p.label || humanize(p.name), p.description ? h('span.ps-dim', ' — ' + p.description) : null)] :
          [h('span.ps-field-label', p.label || humanize(p.name), p.required ? h('span.ps-req', ' *') : null), ctl.el, p.description ? h('span.ps-field-help', p.description) : null]));
    });
    const runBtn = h('button.ps-btn.ps-primary', { type: 'button', onclick: function () { runForm(); } }, ui.icon('play', 14), ' Run');
    const copyBtn = h('button.ps-btn', { type: 'button', title: 'Put the command in the console', onclick: function () { const t = commandText(); if (t) M.console.insert(t); } }, ui.icon('terminal', 14), ' To console');
    formEl.appendChild(h('div.ps-form-preview-wrap', h('span.ps-dim', 'Command: '), preview));
    formEl.appendChild(h('div.ps-form-actions', runBtn, copyBtn));
    if (tool.examples && tool.examples.length) {
      formEl.appendChild(h('div.ps-form-examples', h('div.ps-dim', 'Examples'), tool.examples.map(function (ex) {
        return h('button.ps-cmdlink', { type: 'button', onclick: function () { M.console.insert(ex); } }, h('code', ex));
      })));
    }
    fields.addEventListener('input', updatePreview);
    fields.addEventListener('change', function () { refreshDependent(); updatePreview(); });
    refreshDependent();
    updatePreview();
  }

  function closeForm() {
    current = null;
    formEl.hidden = true;
    listEl.hidden = false;
    searchEl.parentNode.hidden = false;
  }

  function humanize(n) { return String(n).replace(/_/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, function (c) { return c.toUpperCase(); }); }

  function layerOptions(p) {
    const kinds = p.kinds || ['vector'];
    return store.ordered().filter(function (l) {
      if (kinds.indexOf('any') < 0 && kinds.indexOf(l.type) < 0) return false;
      if (p.geom && l.type === 'vector' && l.geometryType !== 'Mixed' && p.geom.indexOf(l.geometryType) < 0) return false;
      return true;
    });
  }

  function control(p, tool, controls) {
    const t = p.type;
    let el, get, set;
    if (t === 'layer') {
      el = h('select.ps-select', { dataset: { layer: '1' } });
      el._fill = function () {
        const v = el.value;
        el.innerHTML = '';
        if (!p.required) el.appendChild(h('option', { value: '' }, '— none —'));
        layerOptions(p).forEach(function (l) { el.appendChild(h('option', { value: l.id }, l.name)); });
        if (v && Array.from(el.options).some(function (o) { return o.value === v; })) el.value = v;
        else if (p.required && store.activeId && Array.from(el.options).some(function (o) { return o.value === store.activeId; }) && p.useActive !== false) el.value = store.activeId;
      };
      el._fill();
      get = function () { return el.value || undefined; };
    } else if (t === 'layers') {
      el = h('select.ps-select', { multiple: true, size: 4, dataset: { layer: '1' } });
      el._fill = function () { el.innerHTML = ''; layerOptions(Object.assign({}, p, { kinds: ['vector'] })).forEach(function (l) { el.appendChild(h('option', { value: l.id }, l.name)); }); };
      el._fill();
      get = function () { const v = Array.from(el.selectedOptions).map(function (o) { return o.value; }); return v.length ? v : undefined; };
    } else if (t === 'field' || t === 'fields') {
      el = h('select.ps-select', { multiple: t === 'fields', size: t === 'fields' ? 4 : undefined, dataset: { field: p.of || '' } });
      get = function () {
        if (t === 'fields') { const v = Array.from(el.selectedOptions).map(function (o) { return o.value; }); return v.length ? v : undefined; }
        return el.value || undefined;
      };
    } else if (t === 'distance') {
      const num = h('input.ps-input.ps-num-input', { type: 'number', step: 'any', placeholder: 'e.g. 500' });
      const unit = h('select.ps-select.ps-unit', ['meters', 'kilometers', 'miles', 'feet'].map(function (u) { return h('option', { value: u, selected: u === (p.defaultUnit || 'meters') }, M.toolkit.unitShort(u)); }));
      el = h('span.ps-inline', num, unit);
      get = function () { return num.value === '' ? undefined : { value: parseFloat(num.value), units: unit.value }; };
    } else if (t === 'numbers') {
      el = h('input.ps-input', { type: 'text', placeholder: p.unitless ? 'e.g. 5' : 'e.g. 100, 200, 500 m' });
      get = function () {
        if (!el.value.trim()) return undefined;
        return C.parse(tool.name + ' ' + p.name + '=' + JSON.stringify(el.value), store.ctx()).args[p.name];
      };
    } else if (t === 'number' || t === 'integer') {
      el = h('input.ps-input.ps-num-input', { type: 'number', step: t === 'integer' ? '1' : 'any', value: p.default !== undefined ? (p.percent ? p.default * 100 : p.default) : '' });
      get = function () {
        if (el.value === '') return undefined;
        let v = parseFloat(el.value);
        if (p.percent && v > 1) v /= 100;
        return t === 'integer' ? Math.round(v) : v;
      };
      if (p.percent) el.placeholder = '0–100 %';
    } else if (t === 'enum') {
      el = h('select.ps-select', (p.required || p.default !== undefined ? [] : [h('option', { value: '' }, '—')]).concat(p.options.map(function (o) { return h('option', { value: o, selected: o === p.default }, o); })));
      get = function () { return el.value || undefined; };
    } else if (t === 'flag' || t === 'boolean') {
      el = h('input', { type: 'checkbox', checked: p.default === true });
      get = function () { return el.checked ? true : undefined; };
    } else if (t === 'color') {
      const pick = h('input', { type: 'color', value: '#800000' });
      const use = h('input', { type: 'checkbox' });
      pick.addEventListener('input', function () { use.checked = true; });
      el = h('span.ps-inline', use, pick);
      get = function () { return use.checked ? pick.value : undefined; };
    } else if (t === 'ramp') {
      el = h('select.ps-select', [h('option', { value: '' }, '—')].concat(M.colors.rampNames().map(function (r) { return h('option', { value: r }, r); })));
      get = function () { return el.value || undefined; };
    } else if (t === 'palette') {
      el = h('select.ps-select', [h('option', { value: '' }, '—')].concat(M.colors.paletteNames().map(function (r) { return h('option', { value: r }, r); })));
      get = function () { return el.value || undefined; };
    } else if (t === 'expression' || t === 'rest') {
      el = h('textarea.ps-input.ps-expr', { rows: t === 'rest' ? 4 : 2, spellcheck: false, placeholder: t === 'rest' ? 'arguments…' : 'e.g. "population" > 10000' });
      get = function () { return el.value.trim() || undefined; };
    } else if (t === 'stats') {
      el = h('input.ps-input', { type: 'text', placeholder: 'e.g. sum population mean income' });
      get = function () {
        if (!el.value.trim()) return undefined;
        return C.parse(tool.name + ' ' + (controls.layer && controls.layer.get() ? JSON.stringify(store.get(controls.layer.get()).name) + ' ' : '') + el.value, store.ctx()).args[p.name];
      };
    } else {
      el = h('input.ps-input', { type: 'text', placeholder: p.type === 'crs' ? 'EPSG:4326' : p.type === 'url' ? 'https://…' : '' });
      get = function () { return el.value.trim() || undefined; };
    }
    return { el: el, get: get, param: p };
  }

  function refreshLayerSelects() {
    if (!current) return;
    Object.keys(current.controls).forEach(function (k) { const c = current.controls[k]; if (c.el._fill) c.el._fill(); });
    refreshDependent();
  }

  function refreshDependent() {
    if (!current) return;
    const ctl = current.controls;
    Object.keys(ctl).forEach(function (k) {
      const c = ctl[k];
      const p = c.param;
      if (p.type !== 'field' && p.type !== 'fields') return;
      const ofName = p.of || (current.tool.params.find(function (x) { return x.type === 'layer'; }) || {}).name;
      const lid = ofName && ctl[ofName] ? ctl[ofName].get() : null;
      const l = lid ? store.get(lid) : null;
      const v = c.el.value;
      c.el.innerHTML = '';
      if (p.type === 'field') c.el.appendChild(h('option', { value: '' }, '—'));
      (l ? l.fields : []).forEach(function (f) { c.el.appendChild(h('option', { value: f.name }, f.name + ' (' + f.type + ')')); });
      if (v) c.el.value = v;
    });
  }

  function collect() {
    const args = {};
    Object.keys(current.controls).forEach(function (k) {
      const v = current.controls[k].get();
      if (v !== undefined) args[k] = v;
    });
    return args;
  }

  function commandText() {
    if (!current) return '';
    try { return C.format(current.tool, collect(), store.ctx()); } catch (e) { return ''; }
  }

  function updatePreview() {
    if (!current) return;
    current.preview.textContent = commandText();
  }

  function runForm() {
    if (!current) return;
    const tool = current.tool;
    const args = collect();
    if (tool.raw) { app.run(tool.name + ' ' + (args[tool.params[0].name] || ''), { source: 'toolbox' }); return; }
    app.runTool(tool.name, args, { source: 'toolbox' });
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
