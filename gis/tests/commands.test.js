'use strict';
/*
 * The text command language, tested against the real tool catalogue.
 * (Tool files are loadable in Node because they only touch the DOM when run.)
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const h = require('./harness');

const M = h.load('core', 'crs', 'colors', 'classify', 'expr', 'commands', 'store', 'style', 'formats', 'geoops', 'raster', 'gdal');
['js/app/app.js', 'js/app/io.js', 'js/app/tools/common.js', 'js/app/tools/general.js', 'js/app/tools/data.js', 'js/app/tools/select.js',
  'js/app/tools/style.js', 'js/app/tools/vector.js', 'js/app/tools/raster.js', 'js/app/tools/gdal.js', 'js/app/draw.js'].forEach(function (f) { h.loadScript(f); });
const C = M.commands;

const ctx = {
  activeLayerId: 'L1',
  layers: [
    { id: 'L1', name: 'roads', type: 'vector', geometryType: 'LineString', fields: [{ name: 'name' }, { name: 'speed', type: 'number' }] },
    { id: 'L2', name: 'city limits', type: 'vector', geometryType: 'Polygon', fields: [{ name: 'NAME' }] },
    { id: 'L3', name: 'counties', type: 'vector', geometryType: 'Polygon', fields: [{ name: 'population', type: 'number' }, { name: 'state' }, { name: 'Median Income', type: 'number' }, { name: 'GEOID' }] },
    { id: 'L4', name: 'crimes', type: 'vector', geometryType: 'Point', fields: [{ name: 'type' }, { name: 'damage', type: 'number' }] },
    { id: 'L5', name: 'water', type: 'vector', geometryType: 'Polygon', fields: [] },
    { id: 'L6', name: 'dem', type: 'raster', bandNames: ['b1'] },
    { id: 'L7', name: 'census', type: 'vector', geometryType: 'None', fields: [{ name: 'geoid10' }, { name: 'income' }] },
    { id: 'L8', name: 'landsat', type: 'raster', bandNames: ['b1', 'b2', 'b3', 'b4', 'b5'] },
  ],
};

function parse(text) { return C.parse(text, ctx); }
function sortKeys(o) { return JSON.stringify(Object.keys(o).sort().map(function (k) { return [k, o[k]]; })); }

// [command, tool, expected subset of args]
const CASES = [
  ['buffer roads 500 m', 'buffer', { layer: 'L1', distance: { value: 500, units: 'meters' } }],
  ['buffer 2 km around crimes dissolve', 'buffer', { layer: 'L4', dissolve: true }],
  ['please buffer the roads by 5 km', 'buffer', { layer: 'L1', distance: { value: 5, units: 'kilometers' } }],
  ['buf 1.5 mi', 'buffer', { layer: 'L1' }],
  ['clip roads to city limits', 'clip', { layer: 'L1', clip: 'L2' }],
  ['clip to "city limits"', 'clip', { layer: 'L1', clip: 'L2' }],
  ['clip dem to counties', 'clip', { layer: 'L6', clip: 'L3' }],
  ['erase water from counties', 'erase', { layer: 'L3', eraser: 'L5' }],
  ['erase counties using water', 'erase', { layer: 'L3', eraser: 'L5' }],
  ['intersect crimes with counties', 'intersect', { layer: 'L4', other: 'L3' }],
  ['dissolve counties by state sum population', 'dissolve', { layer: 'L3', fields: ['state'], stats: [{ op: 'sum', field: 'population' }] }],
  ['dissolve counties by state sum population mean "Median Income"', 'dissolve', { stats: [{ op: 'sum', field: 'population' }, { op: 'mean', field: 'Median Income' }] }],
  ['merge roads, water as stuff', 'merge', { layers: ['L1', 'L5'], as: 'stuff' }],
  ['centroids counties inside', 'centroids', { method: 'point_on_surface' }],
  ['spatial join counties with crimes summary sum damage', 'spatial join', { layer: 'L3', join: 'L4', mode: 'summary', stats: [{ op: 'sum', field: 'damage' }] }],
  ['nearest crimes to roads fields name units mi', 'nearest', { layer: 'L4', to: 'L1', fields: ['name'], units: 'miles' }],
  ['grid hex 1 km over counties clip', 'grid', { type: 'hex', over: 'L3', clip: true, size: { value: 1, units: 'kilometers' } }],
  ['random 500 points in counties', 'random', { count: 500, within: 'L3' }],
  ['cluster crimes kmeans 8', 'cluster', { method: 'kmeans', k: 8 }],
  ['cluster crimes dbscan 200 m min 5', 'cluster', { method: 'dbscan', min: 5, distance: { value: 200, units: 'meters' } }],
  ['count crimes in counties', 'count', { points: 'L4', polygons: 'L3' }],
  ["count crimes where type = 'theft'", 'count', { points: 'L4', where: "type = 'theft'" }],
  ['select counties where population > 100000', 'select', { layer: 'L3', where: 'population > 100000' }],
  ['select crimes within counties', 'select', { layer: 'L4', predicate: 'within', other: 'L3' }],
  ['select crimes within 500 m of roads', 'select', { layer: 'L4', other: 'L1', distance: { value: 500, units: 'meters' } }],
  ['select crimes near roads', 'select', { predicate: 'near', other: 'L1' }],
  ['filter crimes where damage > 1000', 'filter', { where: 'damage > 1000' }],
  ["extract counties where state = 'IL' as illinois", 'extract', { as: 'illinois' }],
  ['stats counties population by state', 'stats', { field: 'population', by: 'state' }],
  ['calc counties density = population / ($area / 1e6)', 'calc', { field: 'density', expression: 'population / ($area / 1e6)' }],
  ['calc counties density=population/2', 'calc', { field: 'density', expression: 'population/2' }],
  ["calc roads speed = 25 where name = 'Main St'", 'calc', { field: 'speed', expression: '25', only: "name = 'Main St'" }],
  ['add field counties notes text', 'calc', { field: 'notes', type: 'text' }],
  ['drop field counties GEOID', 'drop field', { fields: ['GEOID'] }],
  ['join counties with census on GEOID = geoid10 fields income', 'join', { layer: 'L3', table: 'L7', on: 'GEOID = geoid10', fields: ['income'] }],
  ['color counties by population 7 jenks reds', 'color', { field: 'population', method: 'jenks', ramp: 'reds' }],
  ['color counties by Median Income natural breaks', 'color', { field: 'Median Income', method: 'jenks' }],
  ['colour roads red', 'color', { color: '#ff0000' }],
  ['color counties by state categories pastel', 'color', { type: 'categorized', palette: 'pastel' }],
  ['color dem viridis 0 3000', 'color', { layer: 'L6', ramp: 'viridis' }],
  ['rgb landsat 4 3 2', 'rgb', { layer: 'L8' }],
  ['size crimes by damage', 'size', { field: 'damage' }],
  ['heatmap crimes by damage radius 30 magma', 'heatmap', { weight: 'damage', radius: 30, ramp: 'magma' }],
  ["label counties by NAME || ' ' || population", 'label', { text: "NAME || ' ' || population" }],
  ['outline counties white 1.5', 'outline', { color: '#ffffff', width: 1.5 }],
  ['fill counties 30%', 'fill', { value: 0.3 }],
  ['opacity counties 60%', 'opacity', { value: 0.6 }],
  ['hillshade dem', 'hillshade', { layer: 'L6' }],
  ['contours dem 25', 'contours', { interval: 25 }],
  ['bandmath landsat = (b5 - b4) / (b5 + b4) as ndvi', 'bandmath', { expression: '(b5 - b4) / (b5 + b4)', as: 'ndvi' }],
  ['ndvi landsat red 4 nir 5', 'ndvi', { red: 4, nir: 5 }],
  ['reclassify dem 0-200:1, 200-500:2, >500:3 as zones', 'reclassify', { rules: '0-200:1, 200-500:2, >500:3', as: 'zones' }],
  ['zonal dem by counties', 'zonal', { layer: 'L6', zones: 'L3' }],
  ['sample raster dem at crimes', 'sample raster', { layer: 'L6', points: 'L4' }],
  ['export roads as shapefile', 'export', { format: 'shapefile' }],
  ['export counties to gpkg crs EPSG:3435', 'export', { format: 'gpkg', crs: 'EPSG:3435' }],
  ['find University of Chicago', 'find', { place: 'University of Chicago' }],
  ['zoom to counties', 'zoom', { target: 'L3' }],
  ['zoom to selection', 'zoom', { what: 'selection' }],
  ['zoom 12', 'zoom', { place: '12' }],
  ['osm hospitals in Chicago', 'osm', { what: 'hospitals', within: 'Chicago' }],
  ['osm amenity=library in view', 'osm', { what: 'amenity=library', within: 'view' }],
  ['osm bike lanes in counties', 'osm', { what: 'bike lanes', within: 'counties' }],
  ['boundary Cook County, Illinois', 'boundary', { place: 'Cook County, Illinois' }],
  ['draw point into crimes', 'draw', { shape: 'point', into: 'L4' }],
  ['ogr2ogr -f GPKG out.gpkg roads', 'ogr2ogr', { args: '-f GPKG out.gpkg roads' }],
  ['rename roads to streets', 'rename', { layer: 'L1', to: 'streets' }],
  ['move roads to top', 'move', { where: 'top' }],
  ['show all', 'show', { all: true }],
  ['js return 1+1', 'js', { code: 'return 1+1' }],
];

test('every catalogue case parses to the expected tool and arguments', () => {
  for (const [text, tool, subset] of CASES) {
    const r = parse(text);
    assert.equal(r.ok, true, text + ' → ' + r.errors.join(' | '));
    assert.equal(r.tool.name, tool, text);
    for (const k of Object.keys(subset)) assert.deepEqual(r.args[k], subset[k], text + ' [' + k + '] got ' + JSON.stringify(r.args[k]));
  }
});

test('canonical text re-parses to the same arguments', () => {
  for (const [text] of CASES) {
    const r = parse(text);
    const r2 = parse(r.canonical);
    assert.equal(r2.ok, true, r.canonical + ' ← ' + text + ': ' + r2.errors.join(' | '));
    assert.equal(sortKeys(r2.args), sortKeys(r.args), text + ' → ' + r.canonical);
  }
});

test('no two tools claim the same verb', () => {
  const seen = new Map();
  for (const t of C.all()) {
    for (const v of [t.name].concat(t.aliases)) {
      const k = v.toLowerCase();
      assert.ok(!seen.has(k) || seen.get(k) === t.name, 'verb "' + k + '" used by ' + seen.get(k) + ' and ' + t.name);
      seen.set(k, t.name);
    }
  }
});

test('every tool has a category, a summary and valid parameter definitions', () => {
  const TYPES = ['layer', 'layers', 'field', 'fields', 'number', 'integer', 'distance', 'numbers', 'unit', 'enum', 'flag', 'boolean', 'color', 'ramp', 'palette', 'expression', 'text', 'name', 'crs', 'url', 'place', 'stats', 'rest', 'json'];
  for (const t of C.all()) {
    assert.ok(t.category, t.name + ' has no category');
    assert.ok(t.summary, t.name + ' has no summary');
    assert.equal(typeof t.run, 'function', t.name + ' has no run()');
    for (const p of t.params) {
      assert.ok(TYPES.indexOf(p.type) >= 0, t.name + '.' + p.name + ' has unknown type ' + p.type);
      if (p.type === 'enum') assert.ok(Array.isArray(p.options) && p.options.length, t.name + '.' + p.name + ' needs options');
    }
    for (const ex of t.examples) {
      if (t.raw) continue;
      const r = C.parse(ex, ctx);
      assert.equal(r.tool && r.tool.name, t.name, 'example "' + ex + '" of ' + t.name + ' parses as ' + (r.tool && r.tool.name));
    }
  }
});

test('helpful errors: typos, unknown layers, missing values', () => {
  let r = parse('bufer roads 5 km');
  assert.equal(r.ok, false);
  assert.deepEqual(r.suggestions, ['buffer']);
  r = parse('buffer roads');
  assert.equal(r.ok, false);
  assert.deepEqual(r.missing, ['distance']);
  r = parse('clip roads to cty limits');
  assert.equal(r.ok, false);
  assert.match(r.errors.join(' '), /city limits/);
  r = parse('color counties by populaton');
  assert.equal(r.ok, false);
  assert.match(r.errors.join(' '), /Did you mean "population"/);
  r = parse('buffer crimes 500 m as');
  assert.equal(r.ok, false);
  r = parse('hillshade roads');
  assert.equal(r.ok, false);
  assert.match(r.errors.join(' '), /raster/);
});

test('the active layer is used when no layer is named', () => {
  const r = parse('buffer 100 m');
  assert.equal(r.ok, true);
  assert.equal(r.args.layer, 'L1');
  assert.equal(r.usedActive, 'roads');
});

test('autocomplete offers verbs, layers, fields and expression help', () => {
  const labels = (s) => s.items.map((i) => i.label);
  assert.ok(labels(C.suggest('buf', 3, ctx)).indexOf('buffer') >= 0);
  assert.deepEqual(labels(C.suggest('buffer ro', 9, ctx)), ['roads']);
  const byField = labels(C.suggest('color counties by ', 18, ctx));
  assert.deepEqual(byField.slice(0, 3), ['population', 'state', 'Median Income']);
  const expr = labels(C.suggest('select counties where pop', 25, ctx));
  assert.equal(expr[0], 'population');
  const s = C.suggest('clip roads to ', 14, ctx);
  assert.ok(labels(s).indexOf('city limits') >= 0);
  assert.ok(labels(s).indexOf('crimes') < 0, 'points cannot be a clip layer');
});

test('scripts split into lines with comments and continuations', () => {
  const lines = C.splitScript('# comment\nsample countries\n\nbuffer roads \\\n  500 m\n// also a comment\nlayers');
  assert.deepEqual(lines.map((l) => l.text), ['sample countries', 'buffer roads 500 m', 'layers']);
});

test('usage strings describe the syntax', () => {
  assert.equal(C.usage('buffer'), 'buffer <layer> <distance> [dissolve] [selected] [as <as>]');
  assert.match(C.usage('calc'), /calc <layer> <field> = <expression>/);
});
