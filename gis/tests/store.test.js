'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const M = require('./harness').load('core', 'crs', 'colors', 'classify', 'expr', 'raster', 'style', 'store');

const pt = (x, y, p) => ({ type: 'Feature', properties: p || {}, geometry: { type: 'Point', coordinates: [x, y] } });
const fc = (feats) => ({ type: 'FeatureCollection', features: feats });

test('add assigns ids, names and a schema', () => {
  const s = M.createStore();
  const l = s.add({ type: 'vector', name: 'pts', data: fc([pt(0, 0, { a: 1, b: 'x' }), pt(1, 1, { a: 2 })]) });
  assert.equal(l.id, 'L1');
  assert.equal(l.geometryType, 'Point');
  assert.equal(l.count, 2);
  assert.deepEqual(l.data.features.map((f) => f.id), [1, 2]);
  assert.deepEqual(l.fields.map((f) => f.name + ':' + f.type), ['a:number', 'b:string']);
  assert.deepEqual(l.bbox, [0, 0, 1, 1]);
  assert.equal(s.add({ type: 'vector', name: 'pts', data: fc([]) }).name, 'pts_2', 'names are unique');
  assert.equal(s.activeId, 'L2');
  assert.ok(l.style && l.style.kind === 'single');
});

test('lookup by id, name, case and loose name; helpful error when missing', () => {
  const s = M.createStore();
  s.add({ type: 'vector', name: 'City Limits', data: fc([]) });
  assert.ok(s.get('L1'));
  assert.ok(s.get('city limits'));
  assert.ok(s.get('city_limits'));
  assert.equal(s.get('nope'), null);
  assert.throws(() => s.require('nope'), /No layer named "nope". Layers: "City Limits"/);
});

test('update, undo and redo', () => {
  const s = M.createStore();
  const l = s.add({ type: 'vector', name: 'a', data: fc([pt(0, 0)]) });
  const before = l.data;
  s.update(l, { name: 'b' });
  s.appendFeatures(l, [pt(2, 2, { z: 1 })]);
  assert.equal(l.name, 'b');
  assert.equal(l.count, 2);
  assert.deepEqual(l.data.features.map((f) => f.id), [1, 2]);
  assert.equal(before.features.length, 1, 'old data objects are never mutated');
  assert.equal(s.undo(), 'Add features');
  assert.equal(l.count, 1);
  s.undo();
  assert.equal(l.name, 'a');
  s.redo();
  assert.equal(l.name, 'b');
  s.undo(); s.undo();
  assert.equal(s.layers.length, 0, 'undoing the add removes the layer');
  s.redo();
  assert.equal(s.layers.length, 1);
});

test('transactions group changes into one undo step', async () => {
  const s = M.createStore();
  s.add({ type: 'vector', name: 'a', data: fc([]) });
  s.add({ type: 'vector', name: 'b', data: fc([]) });
  await s.transaction('Remove all', () => { s.layers.slice().forEach((l) => s.remove(l.id)); });
  assert.equal(s.layers.length, 0);
  assert.equal(s.undo(), 'Remove all');
  assert.equal(s.layers.length, 2);
  assert.deepEqual(s.layers.map((l) => l.name), ['a', 'b'], 'order restored');
});

test('selection modes and cleanup when features disappear', () => {
  const s = M.createStore();
  const l = s.add({ type: 'vector', name: 'a', data: fc([pt(0, 0), pt(1, 1), pt(2, 2)]) });
  assert.equal(s.select(l, [1, 2]), 2);
  assert.equal(s.select(l, [3], 'add'), 3);
  assert.equal(s.select(l, [1], 'remove'), 2);
  assert.equal(s.select(l, [2, 9], 'intersect'), 1);
  assert.deepEqual(s.selectedIds(l), [2]);
  assert.equal(s.selectedFeatures(l)[0].geometry.coordinates[0], 1);
  s.deleteFeatures(l, [2]);
  assert.deepEqual(s.selectedIds(l), []);
  s.select(l, [1]);
  s.clearSelection();
  assert.equal(s.selection.size, 0);
});

test('editFeatures keeps ids and other features untouched', () => {
  const s = M.createStore();
  const l = s.add({ type: 'vector', name: 'a', data: fc([pt(0, 0, { v: 1 }), pt(1, 1, { v: 2 })]) });
  const second = l.data.features[1];
  s.editFeatures(l, new Map([[1, { properties: { v: 10 } }]]));
  assert.equal(l.data.features[0].properties.v, 10);
  assert.equal(l.data.features[1], second, 'unchanged features are shared, not copied');
  assert.equal(l.data.features[0].id, 1);
});

test('project round trip through JSON, including rasters', () => {
  const s = M.createStore();
  s.add({ type: 'vector', name: 'pts', data: fc([pt(5, 6, { a: 'x' })]) });
  const r = M.raster.create({ width: 3, height: 2, bands: [new Float32Array([1, 2, 3, 4, 5, 6])], bbox: [0, 0, 3, 2], crs: 'EPSG:4326' });
  s.add({ type: 'raster', name: 'dem', raster: r });
  s.add({ type: 'tiles', name: 'osm', url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png' });
  const json = JSON.parse(JSON.stringify(s.toJSON()));
  const t = M.createStore();
  t.fromJSON(json);
  assert.deepEqual(t.layers.map((l) => l.name + ':' + l.type), ['pts:vector', 'dem:raster', 'osm:tiles']);
  assert.deepEqual(Array.from(t.get('dem').raster.bands[0]), [1, 2, 3, 4, 5, 6]);
  assert.ok(t.get('dem').raster.bands[0] instanceof Float32Array);
  assert.equal(t.get('pts').data.features[0].properties.a, 'x');
  assert.throws(() => t.fromJSON({ foo: 1 }), /not a PSICITS project/);
});

test('move reorders and can be undone', () => {
  const s = M.createStore();
  ['a', 'b', 'c'].forEach((n) => s.add({ type: 'vector', name: n, data: fc([]) }));
  s.move('a', 2);
  assert.deepEqual(s.layers.map((l) => l.name), ['b', 'c', 'a']);
  assert.deepEqual(s.ordered().map((l) => l.name), ['a', 'c', 'b']);
  s.undo();
  assert.deepEqual(s.layers.map((l) => l.name), ['a', 'b', 'c']);
});

test('ctx() describes layers for the command parser (top first)', () => {
  const s = M.createStore();
  s.add({ type: 'vector', name: 'a', data: fc([pt(0, 0, { q: 1 })]) });
  s.add({ type: 'vector', name: 'b', data: fc([]) });
  const c = s.ctx();
  assert.equal(c.activeLayerId, 'L2');
  assert.deepEqual(c.layers.map((l) => l.name), ['b', 'a']);
  assert.deepEqual(c.layers[1].fields.map((f) => f.name), ['q']);
});
