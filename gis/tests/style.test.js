'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const M = require('./harness').load('core', 'crs', 'colors', 'classify', 'expr', 'raster', 'style', 'store');

const poly = (x, p) => ({ type: 'Feature', properties: p, geometry: { type: 'Polygon', coordinates: [[[x, 0], [x + 1, 0], [x + 1, 1], [x, 1], [x, 0]]] } });

function layer(props, geom) {
  const s = M.createStore();
  return s.add({ type: 'vector', name: 't', data: { type: 'FeatureCollection', features: props.map((p, i) => geom ? geom(i, p) : poly(i, p)) } });
}

test('graduated styles classify numbers and build a step expression', () => {
  const l = layer([{ v: 1 }, { v: 2 }, { v: 3 }, { v: 4 }, { v: 10 }, { v: null }]);
  const st = M.style.graduated(l, 'v', { method: 'equal', classes: 3, ramp: 'blues' });
  assert.equal(st.kind, 'graduated');
  assert.deepEqual(st.breaks, [1, 4, 7, 10]);
  assert.equal(st.colors.length, 3);
  assert.deepEqual(st.counts, [4, 0, 1]);
  const expr = M.style.colorExpr(st);
  assert.equal(expr[0], 'case');
  const step = expr[expr.length - 1];
  assert.equal(step[0], 'step');
  assert.ok(step[3] > 4 && step[3] < 4.0001, 'breaks are upper-inclusive like the legend');
  const lg = M.style.legend(Object.assign({}, l, { style: st }));
  assert.equal(lg.items.length, 3);
  assert.match(lg.items[0].label, /1 – 4/);
});

test('categorized styles map values (including null) to colors', () => {
  const l = layer([{ c: 'a' }, { c: 'b' }, { c: 'a' }, { c: null }]);
  const st = M.style.categorized(l, 'c', {});
  assert.deepEqual(st.categories.map((x) => x.label), ['a', 'b', '(no value)']);
  const expr = M.style.colorExpr(st);
  assert.equal(expr[0], 'match');
  assert.deepEqual(expr[1], ['to-string', ['get', 'c']]);
  assert.ok(expr.indexOf('') > 0, 'null values match the empty string');
});

test('toMapLibre emits the right layer types per geometry and options', () => {
  const l = layer([{ v: 1, name: 'x' }]);
  let specs = M.style.toMapLibre(l, 'src');
  assert.deepEqual(specs.map((s) => s.type), ['fill', 'line']);
  l.style = Object.assign({}, l.style, { labels: { field: 'name', size: 11 } });
  specs = M.style.toMapLibre(l, 'src');
  assert.equal(specs[specs.length - 1].type, 'symbol');
  l.style = Object.assign({}, l.style, { extrude: { field: 'v', scale: 2 } });
  specs = M.style.toMapLibre(l, 'src');
  assert.equal(specs[0].type, 'fill-extrusion');
  const pts = layer([{ w: 1 }, { w: 5 }], (i, p) => ({ type: 'Feature', properties: p, geometry: { type: 'Point', coordinates: [i, i] } }));
  pts.style = Object.assign({}, pts.style, { kind: 'heatmap', heat: { radius: 30, weightField: 'w', weightMax: 5 } });
  specs = M.style.toMapLibre(pts, 'src');
  assert.equal(specs[0].type, 'heatmap');
  assert.equal(specs[0].paint['heatmap-radius'], 30);
  pts.style = Object.assign({}, pts.style, { kind: 'single', size: { field: 'w', min: 2, max: 20 } });
  specs = M.style.toMapLibre(pts, 'src');
  assert.equal(specs[0].type, 'circle');
  assert.equal(specs[0].paint['circle-radius'][0], 'interpolate');
});

test('numeric field detection ignores zero-padded codes', () => {
  const l = layer([{ zip: '00501', n: '12' }, { zip: '02134', n: '7' }]);
  assert.equal(M.style.isNumericField(l, 'n'), true);
  assert.equal(M.style.isNumericField(l, 'zip'), false);
});
