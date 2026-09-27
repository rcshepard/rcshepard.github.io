#!/usr/bin/env node
/*
 * Regenerates docs/COMMANDS.md from the tool definitions, so the reference
 * never drifts from the code:   node tools/gen-commands-doc.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const h = require('../tests/harness');

const M = h.load('core', 'crs', 'colors', 'classify', 'expr', 'commands', 'store', 'style', 'formats', 'geoops', 'raster', 'gdal');
['js/app/app.js', 'js/app/io.js', 'js/app/tools/common.js', 'js/app/tools/general.js', 'js/app/tools/data.js', 'js/app/tools/select.js',
  'js/app/tools/style.js', 'js/app/tools/vector.js', 'js/app/tools/raster.js', 'js/app/tools/gdal.js', 'js/app/draw.js'].forEach(function (f) { h.loadScript(f); });
const C = M.commands;
const order = M.toolkit.CATEGORY_ORDER;
const cats = {};
C.all().forEach(function (t) { (cats[t.category || 'Other'] = cats[t.category || 'Other'] || []).push(t); });

const lines = [];
lines.push('# Command reference', '');
lines.push('_Generated from the tool definitions by `node tools/gen-commands-doc.js` — ' + C.all().length + ' commands._', '');
lines.push('Type these in the console (right panel). Words can come in a natural order; the console shows how it understood you before you press Enter, and **Tab** completes layer names, fields and options. Every toolbox form and menu item prints the command it runs, so you can learn by clicking.', '');
lines.push('Conventions: `<layer>` is a layer name (quote names with spaces: `"city limits"`), distances take units (`500 m`, `2 km`, `1 mi`, `300 ft`), `as <name>` names the output layer, `selected` limits a tool to the selected features, and expressions use the [expression language](EXPRESSIONS.md).', '');
order.concat(Object.keys(cats).filter(function (c) { return order.indexOf(c) < 0; })).forEach(function (c) {
  if (!cats[c]) return;
  lines.push('## ' + c, '');
  cats[c].forEach(function (t) {
    lines.push('### `' + t.name + '`', '');
    lines.push(t.summary + (t.aliases.length ? '  ' : ''));
    if (t.aliases.length) lines.push('Also: ' + t.aliases.map(function (a) { return '`' + a + '`'; }).join(', '));
    lines.push('');
    lines.push('```', C.usage(t), '```', '');
    const ps = t.params.filter(function (p) { return !p.hidden && p.type !== 'rest'; });
    if (ps.length) {
      lines.push('| Parameter | Type | Notes |', '|---|---|---|');
      ps.forEach(function (p) {
        let notes = p.description || '';
        if (p.type === 'enum') notes += (notes ? ' — ' : '') + p.options.map(function (o) { return '`' + o + '`'; }).join(', ');
        if (p.default !== undefined) notes += ' (default `' + (typeof p.default === 'object' ? JSON.stringify(p.default) : p.default) + '`)';
        if (p.keywords.length) notes += ' — introduced by ' + p.keywords.map(function (k) { return '`' + k + '`'; }).join(' / ');
        lines.push('| ' + (p.label || p.name) + (p.required ? ' *' : '') + ' | ' + p.type + ' | ' + notes.replace(/\|/g, '\\|') + ' |');
      });
      lines.push('');
    }
    if (t.examples.length) {
      lines.push('Examples:', '', '```');
      t.examples.forEach(function (e) { lines.push(e); });
      lines.push('```', '');
    }
  });
});
fs.writeFileSync(path.join(__dirname, '..', 'docs', 'COMMANDS.md'), lines.join('\n'));
console.log('Wrote docs/COMMANDS.md (' + C.all().length + ' commands)');
