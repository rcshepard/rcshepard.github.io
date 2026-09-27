'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { load, fixture } = require('./harness');

const M = load('geoops');
const G = M.geoops;
const turf = globalThis.turf; // vendored Turf, used here as an independent reference

/* ------------------------------------------------------------------ helpers */

function deepFreeze(o) {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const k of Object.keys(o)) deepFreeze(o[k]);
  }
  return o;
}
const fc = (features) => ({ type: 'FeatureCollection', features });
const feat = (geometry, properties) => ({ type: 'Feature', properties: properties || {}, geometry });
const pt = (x, y, props) => feat({ type: 'Point', coordinates: [x, y] }, props);
const line = (coords, props) => feat({ type: 'LineString', coordinates: coords }, props);
const poly = (rings, props) => feat({ type: 'Polygon', coordinates: rings }, props);
const rect = (x0, y0, x1, y1, props) => poly([[[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]]], props);

function approx(actual, expected, rel, msg) {
  assert.ok(Number.isFinite(actual), `${msg || 'value'}: not a finite number (${actual})`);
  const tol = Math.abs(expected) * rel + 1e-9;
  assert.ok(Math.abs(actual - expected) <= tol, `${msg || 'value'}: ${actual} is not within ${rel * 100}% of ${expected}`);
}
const area = (x) => turf.area(x);
const length = (x) => turf.length(x, { units: 'meters' });
function noIds(out) {
  for (const f of out.features) assert.equal(Object.prototype.hasOwnProperty.call(f, 'id'), false, 'output features must not copy input ids');
}
function isFC(out) {
  assert.equal(out.type, 'FeatureCollection');
  assert.ok(Array.isArray(out.features));
}
function ringsOf(g) {
  if (!g) return [];
  if (g.type === 'Polygon') return g.coordinates;
  if (g.type === 'MultiPolygon') return [].concat(...g.coordinates);
  return [];
}
function assertValidRings(out) {
  for (const f of out.features) {
    for (const r of ringsOf(f.geometry)) {
      assert.ok(r.length >= 4, 'ring has at least 4 positions');
      assert.deepEqual(r[0].slice(0, 2), r[r.length - 1].slice(0, 2), 'ring is closed');
    }
  }
}
function rnd(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function randomPointsFc(n, seed, box) {
  const r = rnd(seed);
  const b = box || [-88, 41.6, -87.2, 42.1];
  const out = [];
  for (let i = 0; i < n; i++) out.push(pt(b[0] + r() * (b[2] - b[0]), b[1] + r() * (b[3] - b[1]), { i, v: Math.floor(r() * 100) }));
  return fc(out);
}
function randomPolygonsFc(n, seed) {
  const r = rnd(seed);
  const out = [];
  for (let i = 0; i < n; i++) {
    const cx = -88 + r() * 0.8, cy = 41.6 + r() * 0.5, rad = 0.005 + r() * 0.02;
    const ring = [];
    for (let k = 0; k < 20; k++) {
      const a = (2 * Math.PI * k) / 20, rr = rad * (0.7 + 0.3 * r());
      ring.push([cx + rr * Math.cos(a) * 1.34, cy + rr * Math.sin(a)]);
    }
    ring.push(ring[0].slice());
    out.push(poly([ring], { pid: i }));
  }
  return fc(out);
}
/** Adjacent squares on an exact shared grid (nx * ny cells of `size` degrees). */
function squareGrid(nx, ny, size, x0, y0) {
  const xs = [], ys = [];
  for (let i = 0; i <= nx; i++) xs.push(+(x0 + i * size).toFixed(9));
  for (let j = 0; j <= ny; j++) ys.push(+(y0 + j * size).toFixed(9));
  const out = [];
  for (let i = 0; i < nx; i++) {
    for (let j = 0; j < ny; j++) out.push(rect(xs[i], ys[j], xs[i + 1], ys[j + 1], { i, j, half: i < nx / 2 ? 'W' : 'E', v: 1 }));
  }
  return fc(out);
}

// Hand-built Chicago fixtures (frozen: any mutation by the library throws).
const DATA = deepFreeze(JSON.parse(fixture('geoops/chicago.json', 'utf8')));
const AREAS = DATA.areas, ROADS = DATA.roads, PLACES = DATA.places;
const SNAPSHOT = JSON.stringify(DATA);
const EMPTY = deepFreeze(fc([]));
const byName = (out, name) => out.features.filter((f) => f.properties.name === name);

// Local grid near Chicago for predicate tests: P(x, y) in units of 0.01 degree.
const U = 0.01, X0 = -87.7, Y0 = 41.8;
const P = (x, y) => [+(X0 + x * U).toFixed(10), +(Y0 + y * U).toFixed(10)];
const uRect = (x0, y0, x1, y1, props) => rect(...P(x0, y0), ...P(x1, y1), props);
const uLine = (...pts) => line(pts.map((p) => P(p[0], p[1])));
const uPt = (x, y, props) => pt(...P(x, y), props);

/* -------------------------------------------------------------------- index */

test('index: bbox search returns sorted feature indices', () => {
  const idx = G.index(AREAS);
  assert.equal(idx.size, 4);
  assert.deepEqual(idx.search([-87.63, 41.885, -87.625, 41.895]), [0, 1]);
  assert.deepEqual(idx.search([-87.61, 41.87, -87.609, 41.871]), [2]);
  assert.deepEqual(idx.search([0, 0, 1, 1]), []);
  const p = G.index(PLACES);
  assert.equal(p.size, 7, 'features without geometry are not indexed');
  assert.equal(G.index(EMPTY).size, 0);
  assert.throws(() => idx.search('x'), /bbox/);
});

/* ------------------------------------------------------------------- buffer */

test('buffer: points become geodesic circles; properties kept, ids dropped', () => {
  const out = G.buffer(PLACES, 100);
  isFC(out);
  noIds(out);
  assert.equal(out.features.length, 7);
  assert.match(out.warnings.join(' '), /1 feature without geometry was skipped/);
  assert.equal(out.features[0].properties.name, 'Willis Tower');
  for (const f of out.features) {
    assert.equal(f.geometry.type, 'Polygon');
    assert.equal(f.geometry.coordinates[0].length, 33, '8 steps per quarter = 32 segments');
    approx(area(f), Math.PI * 100 * 100, 0.01, 'circle area');
    assert.ok(turf.booleanPointInPolygon(PLACES.features.find((p) => p.properties.name === f.properties.name).geometry.coordinates, f));
  }
  const km = G.buffer(PLACES, 0.1, { units: 'km' });
  approx(area(km.features[0]), area(out.features[0]), 1e-9, 'units');
  const coarse = G.buffer(PLACES, 100, { steps: 2 });
  assert.equal(coarse.features[0].geometry.coordinates[0].length, 9);
});

test('buffer: lines, polygons, holes and multipolygons', () => {
  const roads = G.buffer(ROADS, 50);
  assert.equal(roads.features.length, 4);
  const lake = byName(roads, 'Lake St')[0];
  approx(area(lake), length(ROADS.features[0]) * 100 + Math.PI * 2500, 0.01, 'line buffer area');
  const areas = G.buffer(AREAS, 100);
  assert.equal(areas.features.length, 4);
  assert.ok(area(areas.features[0]) > area(AREAS.features[0]));
  const park = byName(areas, 'Museum Campus')[0];
  assert.equal(park.geometry.type, 'Polygon');
  assert.equal(park.geometry.coordinates.length, 2, 'hole survives a small buffer');
  const isl = byName(areas, 'Islands')[0];
  assert.equal(isl.geometry.type, 'MultiPolygon');
  const big = G.buffer(fc([AREAS.features[3]]), 600);
  assert.equal(big.features[0].geometry.type, 'Polygon', 'buffers of nearby parts merge');
  assertValidRings(areas);
});

test('buffer: negative distances inset polygons and drop empty results', () => {
  const loop = AREAS.features[0];
  const inset = G.buffer(fc([loop]), -200);
  assert.equal(inset.features.length, 1);
  // Loop is ~1656 m x 1668 m; inset by 200 m on every side.
  const w = length(line([[-87.64, 41.8825], [-87.62, 41.8825]])), h = length(line([[-87.63, 41.875], [-87.63, 41.89]]));
  approx(area(inset.features[0]), (w - 400) * (h - 400), 0.01, 'inset area');
  const gone = G.buffer(AREAS, -2000);
  assert.equal(gone.features.length, 0);
  assert.match(gone.warnings.join(' '), /4 features had an empty buffer and were dropped/);
  const pts = G.buffer(PLACES, -10);
  assert.equal(pts.features.length, 0);
});

test('buffer: dissolve merges everything into one feature', () => {
  const two = fc([pt(-87.63, 41.88, { a: 1 }), pt(-87.629, 41.88, { a: 2 })]); // ~83 m apart
  const sep = G.buffer(two, 100);
  const one = G.buffer(two, 100, { dissolve: true });
  assert.equal(one.features.length, 1);
  assert.deepEqual(one.features[0].properties, { distance: 100 });
  assert.equal(one.features[0].geometry.type, 'Polygon');
  assert.ok(area(one) < area(sep.features[0]) + area(sep.features[1]));
  assert.ok(area(one) > area(sep.features[0]));
});

test('buffer: messy geometry is repaired before buffering; bad arguments throw', () => {
  const messy = fc([
    poly([[[-87.64, 41.875], [-87.62, 41.875], [-87.62, 41.875], [-87.62, 41.89], [-87.64, 41.89]]]), // unclosed + duplicate
    poly([[[-87.6, 41.8], [-87.59, 41.8], [-87.6, 41.8]]]), // too few positions
    line([[-87.6, 41.8], [NaN, 41.81], [-87.59, 41.81]]),
    feat({ type: 'Polygon', coordinates: [] }),
  ]);
  const out = G.buffer(messy, 10);
  assert.equal(out.features.length, 2);
  assert.ok(out.warnings.length >= 1);
  assert.throws(() => G.buffer(PLACES, 'far'), /distance must be a number/);
  assert.throws(() => G.buffer(PLACES, 10, { units: 'parsecs' }), /Unknown distance unit/);
  assert.throws(() => G.buffer(PLACES, 10, { steps: 0 }), /steps/);
  assert.equal(G.buffer(EMPTY, 10).features.length, 0);
});

test('multiRingBuffer: rings, disks and per-feature output', () => {
  const one = fc([PLACES.features[0]]);
  const rings = G.multiRingBuffer(one, [300, 100, 200]);
  assert.deepEqual(rings.features.map((f) => f.properties.distance), [100, 200, 300]);
  approx(area(rings.features[0]), Math.PI * 100 ** 2, 0.01, 'inner disk');
  approx(area(rings.features[1]), Math.PI * (200 ** 2 - 100 ** 2), 0.01, 'first ring');
  approx(area(rings.features[2]), Math.PI * (300 ** 2 - 200 ** 2), 0.01, 'second ring');
  assert.equal(rings.features[1].geometry.coordinates.length, 2, 'ring has a hole');
  const disks = G.multiRingBuffer(one, [100, 200], { rings: false });
  approx(area(disks.features[1]), Math.PI * 200 ** 2, 0.01, 'disk');
  const per = G.multiRingBuffer(fc(PLACES.features.slice(0, 3)), [50, 100], { dissolve: false });
  assert.equal(per.features.length, 6);
  assert.equal(per.features[0].properties.name, 'Willis Tower');
  assert.equal(per.features[1].properties.distance, 100);
  const km = G.multiRingBuffer(one, [0.1], { units: 'km' });
  approx(area(km.features[0]), Math.PI * 100 ** 2, 0.01, 'km');
  assert.throws(() => G.multiRingBuffer(one, []), /at least one distance/);
  assert.throws(() => G.multiRingBuffer(one, [-5, 10]), /greater than 0/);
});

/* -------------------------------------------------------------- clip, erase */

test('clip: points inside (boundary included) are kept; holes excluded', () => {
  const out = G.clip(PLACES, AREAS);
  isFC(out);
  noIds(out);
  assert.deepEqual(out.features.map((f) => f.properties.name).sort(), ['Boundary Marker', 'Field Museum', 'Island Beacon', 'Water Tower', 'Willis Tower']);
  assert.match(out.warnings.join(' '), /without geometry/);
  const mp = fc([feat({ type: 'MultiPoint', coordinates: [[-87.63, 41.88], [-87.61, 41.87], [-87.617, 41.8663]] }, { n: 1 })]);
  const c = G.clip(mp, AREAS);
  assert.equal(c.features[0].geometry.type, 'MultiPoint');
  assert.equal(c.features[0].geometry.coordinates.length, 2);
});

test('clip: lines are cut at boundaries; pieces across adjacent polygons merge', () => {
  const out = G.clip(ROADS, AREAS);
  const lake = byName(out, 'Lake St')[0];
  assert.equal(lake.geometry.type, 'LineString');
  approx(length(lake), length(line([[-87.64, 41.885], [-87.62, 41.885]])), 1e-6, 'Lake St inside the Loop');
  const state = byName(out, 'State St')[0];
  assert.equal(state.geometry.type, 'LineString', 'continuous across the shared Loop / Near North boundary');
  approx(length(state), length(line([[-87.628, 41.875], [-87.628, 41.91]])), 1e-6, 'State St length');
  const trail = byName(out, 'Lakefront Trail')[0];
  assert.equal(trail.geometry.type, 'MultiLineString', 'trail crosses the pond (hole) -> two pieces');
  assert.equal(trail.geometry.coordinates.length, 2);
  approx(length(trail), 2 * length(line([[-87.62, 41.87], [-87.615, 41.87]])), 1e-6, 'trail pieces');
  const roosevelt = byName(out, 'Roosevelt Rd')[0];
  assert.ok(roosevelt, 'a line along the boundary is part of the (closed) polygon');
  approx(length(roosevelt), length(ROADS.features[3]), 1e-9, 'Roosevelt Rd');
});

test('clip: polygons are intersected with the union of clip polygons', () => {
  const window = fc([rect(-87.63, 41.87, -87.61, 41.9, { w: 1 })]);
  const out = G.clip(AREAS, window);
  assert.equal(out.features.length, 3, 'Islands are outside the window');
  const loop = byName(out, 'Loop')[0];
  approx(area(loop), area(rect(-87.63, 41.875, -87.62, 41.89)), 1e-6, 'Loop part');
  const park = byName(out, 'Museum Campus')[0];
  approx(area(park), area(rect(-87.62, 41.87, -87.61, 41.88)) - area(rect(-87.615, 41.87, -87.61, 41.875)), 1e-6, 'park part minus pond');
  assert.deepEqual(loop.properties, { name: 'Loop', pop: 42000, zone: 'C' });
  // Clipping by two adjacent polygons equals clipping by their union.
  const halves = fc([rect(-87.65, 41.88, -87.63, 41.9), rect(-87.63, 41.88, -87.61, 41.9)]);
  const nn = G.clip(fc([AREAS.features[0]]), halves);
  approx(area(nn), area(rect(-87.64, 41.88, -87.62, 41.89)), 1e-6, 'union of clip polygons');
  assert.equal(nn.features[0].geometry.type, 'Polygon');
  assertValidRings(out);
});

test('clip: errors and empty inputs', () => {
  assert.throws(() => G.clip(PLACES, ROADS), /Clip layer has no polygons/);
  assert.throws(() => G.clip(PLACES, EMPTY), /Clip layer has no polygons/);
  assert.throws(() => G.clip(null, AREAS), /not a valid feature collection/);
  assert.equal(G.clip(EMPTY, AREAS).features.length, 0);
});

test('erase: keeps what lies outside the erase polygons', () => {
  const pts = G.erase(PLACES, AREAS);
  assert.deepEqual(pts.features.map((f) => f.properties.name).sort(), ['Navy Pier', 'Pond']);
  const roads = G.erase(ROADS, AREAS);
  const lake = byName(roads, 'Lake St')[0];
  assert.equal(lake.geometry.type, 'MultiLineString');
  approx(length(lake), length(ROADS.features[0]) - length(line([[-87.64, 41.885], [-87.62, 41.885]])), 1e-6, 'Lake St outside');
  assert.equal(byName(roads, 'Roosevelt Rd').length, 0, 'line on the boundary is erased');
  const trail = byName(roads, 'Lakefront Trail')[0];
  approx(length(trail), length(ROADS.features[2]) - 2 * length(line([[-87.62, 41.87], [-87.615, 41.87]])), 1e-6, 'trail outside');
  const loop = G.erase(fc([AREAS.features[0]]), fc([rect(-87.63, 41.88, -87.61, 41.9)]));
  approx(area(loop), area(AREAS.features[0]) - area(rect(-87.63, 41.88, -87.62, 41.89)), 1e-6, 'polygon difference');
  const untouched = G.erase(fc([AREAS.features[3]]), fc([rect(-87.7, 41.7, -87.69, 41.71)]));
  assert.equal(untouched.features[0].geometry, AREAS.features[3].geometry, 'unaffected geometry passes through');
  assert.throws(() => G.erase(PLACES, PLACES), /Erase layer has no polygons/);
});

/* ------------------------------------------------------------------ overlay */

test('intersect: one output per intersecting pair with merged properties', () => {
  const pts = G.intersect(PLACES, AREAS);
  noIds(pts);
  assert.equal(pts.features.length, 6, 'the boundary marker intersects two areas');
  const marker = byName(pts, 'Boundary Marker');
  assert.deepEqual(marker.map((f) => f.properties.name_2).sort(), ['Loop', 'Near North']);
  assert.deepEqual(Object.keys(pts.features[0].properties), ['name', 'visitors', 'name_2', 'pop', 'zone']);
  const custom = G.intersect(PLACES, AREAS, { suffix: '_area' });
  assert.ok('name_area' in custom.features[0].properties);
  const roads = G.intersect(ROADS, AREAS);
  assert.equal(roads.features.length, 5);
  const state = roads.features.filter((f) => f.properties.name === 'State St');
  assert.deepEqual(state.map((f) => f.properties.name_2), ['Loop', 'Near North']);
  approx(length(state[0]), length(line([[-87.628, 41.875], [-87.628, 41.89]])), 1e-6, 'State St in Loop');
  const other = fc([rect(-87.63, 41.88, -87.61, 41.895, { name: 'District', code: 7 })]);
  const polys = G.intersect(AREAS, other);
  assert.deepEqual(polys.features.map((f) => f.properties.name), ['Loop', 'Near North'], 'the park only touches the district along an edge');
  approx(area(polys.features[0]), area(rect(-87.63, 41.88, -87.62, 41.89)), 1e-6, 'Loop x District');
  assert.equal(polys.features[0].properties.code, 7);
  assert.equal(polys.features[0].properties.name_2, 'District');
  assert.throws(() => G.intersect(PLACES, ROADS), /no polygons/);
  assert.equal(G.intersect(EMPTY, AREAS).features.length, 0);
});

test('union: A∩B, A−B and B−A pieces cover A ∪ B', () => {
  const A = fc([AREAS.features[0]]);
  const B = fc([rect(-87.63, 41.88, -87.61, 41.895, { name: 'District', code: 7 })]);
  const out = G.union(A, B);
  assert.equal(out.features.length, 3);
  const [ab, aOnly, bOnly] = out.features;
  assert.deepEqual(ab.properties, { name: 'Loop', pop: 42000, zone: 'C', name_2: 'District', code: 7 });
  assert.deepEqual(aOnly.properties, { name: 'Loop', pop: 42000, zone: 'C', name_2: null, code: null });
  assert.deepEqual(bOnly.properties, { name: null, pop: null, zone: null, name_2: 'District', code: 7 });
  const inter = area(rect(-87.63, 41.88, -87.62, 41.89));
  approx(area(ab), inter, 1e-6, 'intersection');
  approx(area(aOnly), area(A.features[0]) - inter, 1e-6, 'A only');
  approx(area(bOnly), area(B.features[0]) - inter, 1e-6, 'B only');
  noIds(out);
  const sd = G.symDifference(A, B);
  assert.equal(sd.features.length, 2);
  approx(area(sd), area(A.features[0]) + area(B.features[0]) - 2 * inter, 1e-6, 'symmetric difference');
  assert.equal(sd.features[1].properties.code, 7);
  const disjoint = G.union(fc([AREAS.features[3]]), B);
  assert.equal(disjoint.features.length, 2);
  assert.throws(() => G.union(PLACES, ROADS), /Union needs polygon layers/);
  const mixed = G.union(fc([...A.features, PLACES.features[0]]), B);
  assert.match(mixed.warnings.join(' '), /non-polygon feature was ignored/);
});

/* ----------------------------------------------------------------- dissolve */

test('dissolve: groups, statistics, holes and multipolygons', () => {
  const out = G.dissolve(AREAS, {
    fields: ['zone'],
    stats: [
      { field: 'pop', op: 'sum' }, { field: 'pop', op: 'mean' }, { field: 'pop', op: 'min' }, { field: 'pop', op: 'max' },
      { field: 'name', op: 'first' }, { field: 'name', op: 'last' }, { field: 'name', op: 'concat' },
      { field: 'zone', op: 'unique_count' }, { field: 'pop', op: 'count' }, { field: 'name', op: 'min' },
    ],
  });
  noIds(out);
  assert.equal(out.features.length, 2);
  const [c, p] = out.features;
  assert.deepEqual(c.properties, {
    zone: 'C', count: 2, sum_pop: 122000, mean_pop: 61000, min_pop: 42000, max_pop: 80000,
    first_name: 'Loop', last_name: 'Near North', concat_name: 'Loop, Near North', unique_count_zone: 1, count_pop: 2, min_name: 'Loop',
  });
  assert.equal(c.geometry.type, 'Polygon', 'adjacent polygons merge');
  approx(area(c), area(rect(-87.64, 41.875, -87.62, 41.91)), 1e-6, 'merged area');
  assert.equal(p.geometry.type, 'MultiPolygon');
  assert.equal(p.geometry.coordinates.length, 3);
  assert.ok(p.geometry.coordinates.some((rings) => rings.length === 2), 'the pond hole survives');
  approx(area(p), area(AREAS.features[2]) + area(AREAS.features[3]), 1e-6, 'P area');
  const all = G.dissolve(AREAS);
  assert.equal(all.features.length, 1);
  assert.deepEqual(all.features[0].properties, { count: 4 });
  assert.equal(all.features[0].geometry.coordinates.length, 3, 'Loop, Near North and the park touch -> one polygon + 2 islands');
  assert.throws(() => G.dissolve(AREAS, { stats: [{ field: 'pop', op: 'median_absolute' }] }), /Unknown statistic/);
  assert.equal(G.dissolve(EMPTY).features.length, 0);
});

test('dissolve: lines and points, mixed layers and null geometry', () => {
  const lines = G.dissolve(ROADS, { stats: [{ field: 'lanes', op: 'sum' }] });
  assert.equal(lines.features.length, 1);
  assert.equal(lines.features[0].geometry.type, 'MultiLineString');
  assert.equal(lines.features[0].geometry.coordinates.length, 5);
  assert.equal(lines.features[0].properties.sum_lanes, 15);
  const pts = G.dissolve(PLACES);
  assert.equal(pts.features[0].geometry.type, 'MultiPoint');
  assert.equal(pts.features[0].properties.count, 7);
  assert.match(pts.warnings.join(' '), /without geometry/);
  const mixed = G.dissolve(fc([...AREAS.features, ...ROADS.features]));
  assert.deepEqual(mixed.features.map((f) => f.geometry.type), ['MultiPolygon', 'MultiLineString']);
});

test('dissolve: slivers and near-coincident edges do not break the union', () => {
  const a = rect(-87.7, 41.8, -87.69, 41.81, { g: 1 });
  const b = poly([[[-87.69 + 1e-13, 41.8], [-87.68, 41.8], [-87.68, 41.81], [-87.69 - 1e-13, 41.81], [-87.69 + 1e-13, 41.8]]], { g: 1 });
  const spike = poly([[[-87.68, 41.8], [-87.67, 41.8], [-87.67, 41.81], [-87.67, 41.82], [-87.67, 41.81], [-87.68, 41.81], [-87.68, 41.8]]], { g: 1 });
  const out = G.dissolve(fc([a, b, spike]));
  assert.equal(out.features.length, 1);
  approx(area(out), area(rect(-87.7, 41.8, -87.67, 41.81)), 1e-6, 'area preserved');
});

/* ----------------------------------------------------------- merge & points */

test('merge: appends layers and records the source layer', () => {
  const out = G.merge([AREAS, PLACES], { names: ['areas', 'places'] });
  assert.equal(out.features.length, 12);
  assert.equal(out.features[0].properties.source_layer, 'areas');
  assert.equal(out.features[11].properties.source_layer, 'places');
  assert.equal(out.features[11].geometry, null, 'attribute-only rows are kept');
  noIds(out);
  const custom = G.merge([AREAS, ROADS], { names: ['a', 'r'], sourceField: 'src' });
  assert.equal(custom.features[5].properties.src, 'r');
  assert.equal('source_layer' in G.merge([AREAS]).features[0].properties, false);
  assert.throws(() => G.merge(AREAS), /list of layers/);
});

test('centroids: centroid, center of mass and point on surface', () => {
  const c = G.centroids(AREAS);
  assert.equal(c.features.length, 4);
  assert.deepEqual(c.features[0].geometry.coordinates.map((v) => +v.toFixed(9)), [-87.63, 41.8825]);
  assert.equal(c.features[0].properties.name, 'Loop');
  noIds(c);
  // An L-shaped polygon: the vertex mean and the center of mass differ; point_on_surface is inside.
  const L = poly([[P(0, 0), P(4, 0), P(4, 1), P(1, 1), P(1, 4), P(0, 4), P(0, 0)]], { id: 'L' });
  const [vm] = G.centroids(fc([L])).features;
  const [cm] = G.centroids(fc([L]), { method: 'center_of_mass' }).features;
  const [ps] = G.centroids(fc([L]), { method: 'point_on_surface' }).features;
  const tc = turf.centerOfMass(L).geometry.coordinates;
  approx(cm.geometry.coordinates[0], tc[0], 1e-9, 'center of mass x');
  approx(cm.geometry.coordinates[1], tc[1], 1e-9, 'center of mass y');
  assert.ok(!turf.booleanPointInPolygon(cm.geometry.coordinates, L), 'center of an L lies outside it');
  assert.ok(turf.booleanPointInPolygon(ps.geometry.coordinates, L, { ignoreBoundary: true }), 'point on surface is inside');
  assert.notDeepEqual(vm.geometry.coordinates, cm.geometry.coordinates);
  // The park's center of mass is in the pond; point_on_surface avoids the hole.
  const park = fc([AREAS.features[2]]);
  const pc = G.centroids(park, { method: 'point_on_surface' }).features[0].geometry.coordinates;
  assert.ok(turf.booleanPointInPolygon(pc, AREAS.features[2], { ignoreBoundary: true }));
  const onLine = G.centroids(ROADS, { method: 'point_on_surface' });
  assert.ok(turf.booleanPointOnLine(onLine.features[0].geometry.coordinates, ROADS.features[0]));
  assert.deepEqual(G.centroids(PLACES).features[0].geometry.coordinates, [-87.6359, 41.8789]);
  assert.throws(() => G.centroids(AREAS, { method: 'middle' }), /Unknown centroid method/);
});

/* -------------------------------------------------------------------- hulls */

test('convexHull and concaveHull', () => {
  const hull = G.convexHull(PLACES);
  assert.equal(hull.features.length, 1);
  assert.equal(hull.features[0].properties.count, 7);
  for (const p of PLACES.features) if (p.geometry) assert.ok(turf.booleanPointInPolygon(p.geometry, hull.features[0]));
  const grouped = G.convexHull(AREAS, { groupBy: 'zone' });
  assert.deepEqual(grouped.features.map((f) => f.properties), [{ zone: 'C', count: 2 }, { zone: 'P', count: 2 }]);
  const collinear = G.convexHull(fc([pt(0, 0), pt(1, 1), pt(2, 2)]));
  assert.equal(collinear.features.length, 0);
  assert.match(collinear.warnings.join(' '), /non-collinear/);

  // L-shaped cloud of points on a 0.01 degree lattice.
  const pts = [];
  for (let x = 0; x <= 10; x++) for (let y = 0; y <= 10; y++) if (x <= 3 || y <= 3) pts.push(uPt(x, y, { k: 1 }));
  const cloud = fc(pts);
  const convex = G.convexHull(cloud).features[0];
  const concave = G.concaveHull(cloud, { maxEdge: 1.5, units: 'km' });
  assert.equal(concave.features.length, 1);
  assert.ok(!concave.warnings);
  approx(area(concave), area(poly([[P(0, 0), P(10, 0), P(10, 3), P(3, 3), P(3, 10), P(0, 10), P(0, 0)]])), 0.01, 'concave hull follows the L');
  assert.ok(area(concave) < 0.7 * area(convex));
  const dflt = G.concaveHull(cloud);
  assert.ok(area(dflt) < 0.7 * area(convex), 'default maxEdge is data driven');
  const fallback = G.concaveHull(cloud, { maxEdge: 1 });
  assert.equal(fallback.features.length, 1);
  assert.match(fallback.warnings.join(' '), /used the convex hull/);
  approx(area(fallback), area(convex), 1e-9, 'fallback is the convex hull');
});

test('envelope: per feature or for the whole layer', () => {
  const env = G.envelope(ROADS);
  assert.equal(env.features.length, 1, 'horizontal and vertical lines have no area');
  assert.match(env.warnings.join(' '), /3 features have a zero-area extent/);
  const trail = byName(env, 'Lakefront Trail')[0];
  assert.deepEqual(turf.bbox(trail), [-87.625, 41.85, -87.59, 41.87]);
  const whole = G.envelope(AREAS, { perFeature: false });
  assert.equal(whole.features.length, 1);
  assert.deepEqual(whole.features[0].properties, { count: 4 });
  assert.deepEqual(turf.bbox(whole.features[0]), [-87.64, 41.86, -87.585, 41.91]);
  assert.equal(G.envelope(EMPTY, { perFeature: false }).features.length, 0);
});

/* --------------------------------------------------- generalisation / edits */

test('simplify: tolerance in meters; rings never degenerate', () => {
  // Zig-zag line with 5 m wiggles.
  const coords = [];
  for (let i = 0; i <= 100; i++) coords.push([-87.7 + i * 0.001, 41.8 + (i % 2 ? 0.00004 : 0)]);
  const zig = fc([line(coords, { n: 1 })]);
  const s = G.simplify(zig, { tolerance: 10 });
  assert.deepEqual(s.features[0].geometry.coordinates, [coords[0], coords[100]]);
  assert.equal(s.features[0].properties.n, 1);
  assert.equal(G.simplify(zig, { tolerance: 1 }).features[0].geometry.coordinates.length, 101);
  assert.equal(G.simplify(zig, { tolerance: 0.01, units: 'km', highQuality: true }).features[0].geometry.coordinates.length, 2);
  // A circle simplified hard keeps a valid ring; tiny islands vanish.
  const circle = G.buffer(fc([pt(-87.63, 41.88)]), 1000, { steps: 16 });
  const sc = G.simplify(circle, { tolerance: 300 });
  assertValidRings(sc);
  assert.ok(sc.features[0].geometry.coordinates[0].length < 20);
  const islands = G.simplify(AREAS, { tolerance: 800 });
  assertValidRings(islands);
  assert.equal(byName(islands, 'Islands').length, 0);
  assert.match(islands.warnings.join(' '), /collapsed/);
  const pond = byName(G.simplify(AREAS, { tolerance: 50 }), 'Museum Campus')[0];
  assert.equal(pond.geometry.coordinates.length, 2, 'rectangles survive a small tolerance');
  assert.throws(() => G.simplify(AREAS, {}), /tolerance must be a number/);
});

test('smooth: Chaikin corner cutting keeps line ends and closes rings', () => {
  const out = G.smooth(ROADS, { iterations: 2 });
  const lake = byName(out, 'Lake St')[0].geometry.coordinates;
  assert.equal(lake.length, 8, '2 -> 4 -> 8 positions (ends kept, 2 new points per segment)');
  assert.deepEqual(lake[0], ROADS.features[0].geometry.coordinates[0]);
  assert.deepEqual(lake[lake.length - 1], ROADS.features[0].geometry.coordinates[1]);
  const sq = G.smooth(fc([AREAS.features[0]]), { iterations: 3 });
  const ring = sq.features[0].geometry.coordinates[0];
  assert.equal(ring.length, 4 * 8 + 1);
  assert.deepEqual(ring[0], ring[ring.length - 1]);
  assert.ok(area(sq) < area(AREAS.features[0]) && area(sq) > 0.7 * area(AREAS.features[0]));
  assert.deepEqual(G.smooth(PLACES).features[0].geometry, PLACES.features[0].geometry);
  assert.throws(() => G.smooth(ROADS, { iterations: 50 }), /iterations/);
});

test('densify: no segment longer than the interval', () => {
  const out = G.densify(ROADS, { interval: 250 });
  for (const f of out.features) {
    const parts = f.geometry.type === 'LineString' ? [f.geometry.coordinates] : f.geometry.coordinates;
    for (const c of parts) {
      for (let i = 0; i < c.length - 1; i++) assert.ok(length(line([c[i], c[i + 1]])) <= 250 + 1e-6);
    }
  }
  // Vertices are added along the straight lon/lat segment (sub-segment great circles are ~equal).
  approx(length(byName(out, 'Lake St')[0]), length(ROADS.features[0]), 1e-6, 'shape preserved');
  assert.ok(byName(out, 'Lake St')[0].geometry.coordinates.every((c) => c[1] === 41.885));
  const poly1 = G.densify(fc([AREAS.features[0]]), { interval: 0.5, units: 'km' });
  assert.ok(poly1.features[0].geometry.coordinates[0].length > 10);
  approx(area(poly1), area(AREAS.features[0]), 1e-9, 'area preserved');
  const geo = G.densify(fc([line([[-120, 45], [-70, 45]])]), { interval: 500, units: 'km', geodesic: true });
  const mid = geo.features[0].geometry.coordinates[Math.floor(geo.features[0].geometry.coordinates.length / 2)];
  assert.ok(mid[1] > 46, 'great-circle vertices bulge toward the pole');
  assert.throws(() => G.densify(ROADS, { interval: 0 }), /interval/);
});

/* --------------------------------------------------------- voronoi/delaunay */

test('voronoi: one cell per point, containing it, with its properties', () => {
  const pts = fc(PLACES.features.slice(0, 7));
  const out = G.voronoi(pts);
  assert.equal(out.features.length, 7);
  noIds(out);
  out.features.forEach((cell, i) => {
    assert.equal(cell.properties.name, pts.features[i].properties.name);
    assert.ok(turf.booleanPointInPolygon(pts.features[i].geometry, cell));
  });
  approx(area(out), area(turf.bboxPolygon(turf.bbox(out))), 1e-6, 'cells tile the bbox');
  const clipped = G.voronoi(pts, { clipTo: AREAS });
  approx(area(clipped), area(AREAS), 1e-6, 'cells clipped to the areas tile the areas');
  assert.ok(clipped.features.every((f) => f.properties.name));
  const inBox = G.voronoi(pts, { bbox: [-87.64, 41.86, -87.58, 41.91] });
  approx(area(inBox), area(turf.bboxPolygon([-87.64, 41.86, -87.58, 41.91])), 1e-6, 'explicit bbox');
  const dup = G.voronoi(fc([pt(-87.6, 41.8, { a: 1 }), pt(-87.6, 41.8, { a: 2 }), pt(-87.61, 41.81, { a: 3 })]), { bbox: [-87.7, 41.7, -87.5, 41.9] });
  assert.equal(dup.features.length, 2);
  assert.match(dup.warnings.join(' '), /duplicate point/);
  assert.equal(G.voronoi(EMPTY).features.length, 0);
});

test('delaunay: triangles reference their vertices', () => {
  const pts = fc([uPt(0, 0), uPt(1, 0), uPt(0, 1), uPt(1, 1), uPt(0.5, 0.5)]);
  const out = G.delaunay(pts);
  assert.equal(out.features.length, 4);
  for (const t of out.features) {
    const { a, b, c } = t.properties;
    assert.ok([a, b, c].every((i) => Number.isInteger(i) && i >= 0 && i < 5));
    assert.ok([a, b, c].includes(4), 'every triangle uses the center point');
  }
  approx(area(out), area(uRect(0, 0, 1, 1)), 1e-9, 'triangles cover the hull');
  const few = G.delaunay(fc([uPt(0, 0), uPt(1, 1)]));
  assert.equal(few.features.length, 0);
  assert.ok(few.warnings);
});

/* --------------------------------------------------------- part conversions */

test('explode, polygonsToLines, linesToPolygons, extractVertices', () => {
  const ex = G.explode(AREAS);
  assert.equal(ex.features.length, 5);
  assert.deepEqual(ex.features.map((f) => f.properties.part), [0, 0, 0, 0, 1]);
  assert.ok(ex.features.every((f) => f.geometry.type === 'Polygon'));
  noIds(ex);
  const exr = G.explode(ROADS);
  assert.equal(byName(exr, 'Lakefront Trail').length, 2);

  const lines = G.polygonsToLines(AREAS);
  assert.deepEqual(lines.features.map((f) => f.geometry.type), ['LineString', 'LineString', 'MultiLineString', 'MultiLineString']);
  assert.equal(lines.features[2].geometry.coordinates.length, 2, 'outer ring + pond');
  approx(length(lines.features[0]), 2 * (length(line([[-87.64, 41.875], [-87.62, 41.875]])) + length(line([[-87.64, 41.875], [-87.64, 41.89]]))) + (length(line([[-87.64, 41.89], [-87.62, 41.89]])) - length(line([[-87.64, 41.875], [-87.62, 41.875]]))), 1e-6, 'perimeter');
  assert.match(G.polygonsToLines(PLACES).warnings.join(' '), /non-polygon/);

  const back = G.linesToPolygons(lines);
  approx(area(back), area(AREAS), 1e-9, 'rings nested inside rings become holes');
  assert.equal(back.features[2].geometry.coordinates.length, 2);
  const open = G.linesToPolygons(fc([line([[-87.6, 41.8], [-87.59, 41.8], [-87.59, 41.81]], { k: 1 })]));
  assert.equal(open.features[0].geometry.coordinates[0].length, 4, 'open lines are closed');
  assert.equal(G.linesToPolygons(fc([line([[-87.6, 41.8], [-87.59, 41.8]])])).features.length, 0);

  const v = G.extractVertices(AREAS);
  assert.equal(v.features.length, 4 + 4 + 8 + 8, 'closing positions are not repeated');
  const pond = v.features.filter((f) => f.properties.name === 'Museum Campus');
  assert.deepEqual(pond.map((f) => f.properties.vertex_index), [0, 1, 2, 3, 4, 5, 6, 7]);
  assert.deepEqual(pond.map((f) => f.properties.ring), [0, 0, 0, 0, 1, 1, 1, 1]);
  const isl = v.features.filter((f) => f.properties.name === 'Islands');
  assert.deepEqual(isl.map((f) => f.properties.part), [0, 0, 0, 0, 1, 1, 1, 1]);
  assert.equal(G.extractVertices(ROADS).features.length, 2 + 2 + 4 + 2);
});

test('pointsAlongLines: regular spacing with distances', () => {
  const lake = fc([ROADS.features[0]]);
  const L = length(ROADS.features[0]);
  const out = G.pointsAlongLines(lake, { interval: 1000 });
  const ds = out.features.map((f) => f.properties.distance);
  assert.equal(ds[0], 0);
  approx(ds[ds.length - 1], L, 1e-9, 'end point');
  assert.equal(ds.length, Math.ceil(L / 1000) + 1);
  assert.equal(ds[3], 3000);
  approx(length(line([out.features[0].geometry.coordinates, out.features[3].geometry.coordinates])), 3000, 1e-6, 'spacing');
  assert.equal(out.features[1].properties.name, 'Lake St');
  const noEnds = G.pointsAlongLines(lake, { interval: 1, units: 'km', includeEnds: false });
  assert.equal(noEnds.features.length, Math.ceil(L / 1000) - 1);
  assert.equal(noEnds.features[0].properties.distance, 1);
  const trail = G.pointsAlongLines(fc([ROADS.features[2]]), { interval: 500 });
  assert.deepEqual([...new Set(trail.features.map((f) => f.properties.part))], [0, 1]);
  const ring = G.pointsAlongLines(fc([AREAS.features[0]]), { interval: 500 });
  assert.ok(ring.features.length > 10);
  assert.throws(() => G.pointsAlongLines(lake, {}), /Interval/);
});

test('lineIntersections: crossings with attributes of both lines', () => {
  const out = G.lineIntersections(ROADS);
  // Lake x State, Lake x Roosevelt? (no: parallel), State x Roosevelt, State x Trail? (no: trail starts at x=-87.625)
  const pairs = out.features.map((f) => `${f.properties.name}/${f.properties.name_2}`).sort();
  assert.deepEqual(pairs, ['Lake St/State St', 'State St/Roosevelt Rd']);
  const lakeState = out.features.find((f) => f.properties.name === 'Lake St');
  assert.deepEqual(lakeState.geometry.coordinates.map((v) => +v.toFixed(9)), [-87.628, 41.885]);
  assert.equal(lakeState.properties.lanes, 4);
  assert.equal(lakeState.properties.lanes_2, 4);
  const withAreas = G.lineIntersections(ROADS, AREAS);
  const lake = withAreas.features.filter((f) => f.properties.name === 'Lake St');
  assert.equal(lake.length, 2, 'Lake St crosses the Loop boundary twice');
  assert.equal(lake[0].properties.name_2, 'Loop');
  const overlap = G.lineIntersections(fc([line([[0, 0], [2, 0]])]), fc([line([[1, 0], [3, 0]])]));
  assert.equal(overlap.features.length, 2, 'collinear overlap -> its end points');
  assert.equal(G.lineIntersections(EMPTY).features.length, 0);
});

test('splitLines: at crossings, boundaries and points', () => {
  const out = G.splitLines(fc([ROADS.features[0]]), AREAS);
  assert.equal(out.features.length, 3);
  assert.ok(out.features.every((f) => f.properties.name === 'Lake St' && f.geometry.type === 'LineString'));
  approx(length(out), length(ROADS.features[0]), 1e-6, 'total length');
  approx(length(out.features[1]), length(line([[-87.64, 41.885], [-87.62, 41.885]])), 1e-6, 'middle piece');
  const self = G.splitLines(ROADS);
  assert.equal(byName(self, 'State St').length, 3, 'State St is split by Lake St and Roosevelt Rd');
  assert.equal(byName(self, 'Lake St').length, 2);
  const byPoint = G.splitLines(fc([line([[0, 0], [2, 0]], { a: 1 })]), fc([pt(1, 0), pt(5, 5)]));
  assert.deepEqual(byPoint.features.map((f) => f.geometry.coordinates), [[[0, 0], [1, 0]], [[1, 0], [2, 0]]]);
  noIds(out);
});

/* ------------------------------------------------------------- predicates */

test('predicates follow OGC semantics (selectByLocation truth table)', () => {
  const SQ = uRect(0, 0, 2, 2);
  const HOLE = poly([[P(0, 0), P(4, 0), P(4, 4), P(0, 4), P(0, 0)], [P(1, 1), P(1, 3), P(3, 3), P(3, 1), P(1, 1)]]);
  const L1 = uLine([0, 0], [2, 2]);
  const cases = [
    // [name, A, B, true predicates]
    ['point inside', uPt(1, 1), SQ, ['intersects', 'within']],
    ['point on boundary', uPt(2, 1), SQ, ['intersects', 'touches']],
    ['point outside', uPt(3, 3), SQ, ['disjoint']],
    ['point in hole', uPt(2, 2), HOLE, ['disjoint']],
    ['polygon contains point', SQ, uPt(1, 1), ['intersects', 'contains']],
    ['polygon vs boundary point', SQ, uPt(2, 1), ['intersects', 'touches']],
    ['line inside', uLine([0.5, 0.5], [1.5, 1.5]), SQ, ['intersects', 'within']],
    ['line crossing', uLine([1, 1], [3, 1]), SQ, ['intersects', 'crosses']],
    ['line along edge', uLine([0, 0], [2, 0]), SQ, ['intersects', 'touches']],
    ['line touching from outside', uLine([2, 1], [3, 1]), SQ, ['intersects', 'touches']],
    ['line outside', uLine([3, 0], [4, 0]), SQ, ['disjoint']],
    ['line across hole', uLine([0.5, 2], [3.5, 2]), HOLE, ['intersects', 'crosses']],
    ['line in hole', uLine([1.5, 1.5], [2.5, 2.5]), HOLE, ['disjoint']],
    ['polygon contains line', SQ, uLine([0.5, 0.5], [1.5, 1.5]), ['intersects', 'contains']],
    ['polygon crossed by line', SQ, uLine([1, 1], [3, 1]), ['intersects', 'crosses']],
    ['overlapping polygons', uRect(1, 1, 3, 3), SQ, ['intersects', 'overlaps']],
    ['edge-touching polygons', uRect(2, 0, 3, 2), SQ, ['intersects', 'touches']],
    ['corner-touching polygons', uRect(2, 2, 3, 3), SQ, ['intersects', 'touches']],
    ['polygon within polygon', uRect(0.5, 0.5, 1.5, 1.5), SQ, ['intersects', 'within']],
    ['polygon contains polygon', SQ, uRect(0.5, 0.5, 1.5, 1.5), ['intersects', 'contains']],
    ['equal polygons', uRect(0, 0, 2, 2), SQ, ['intersects', 'within', 'contains']],
    ['disjoint polygons', uRect(5, 5, 6, 6), SQ, ['disjoint']],
    ['polygon in hole', uRect(1.5, 1.5, 2.5, 2.5), HOLE, ['disjoint']],
    ['polygon covering hole', uRect(0.5, 0.5, 3.5, 3.5), HOLE, ['intersects', 'overlaps']],
    ['crossing lines', uLine([0, 2], [2, 0]), L1, ['intersects', 'crosses']],
    ['lines touching at ends', uLine([2, 2], [3, 3]), L1, ['intersects', 'touches']],
    ['T junction', uLine([1, 1], [0, 2]), L1, ['intersects', 'touches']],
    ['collinear overlap', uLine([1, 1], [3, 3]), L1, ['intersects', 'overlaps']],
    ['line within line', uLine([0.5, 0.5], [1.5, 1.5]), L1, ['intersects', 'within']],
    ['line contains line', L1, uLine([0.5, 0.5], [1.5, 1.5]), ['intersects', 'contains']],
    ['point on line', uPt(1, 1), L1, ['intersects', 'within']],
    ['point at line end', uPt(0, 0), L1, ['intersects', 'touches']],
    ['point off line', uPt(1, 0), L1, ['disjoint']],
    ['equal points', uPt(1, 1), uPt(1, 1), ['intersects', 'within', 'contains']],
    ['multipoint half inside', feat({ type: 'MultiPoint', coordinates: [P(1, 1), P(3, 3)] }), SQ, ['intersects', 'crosses']],
    ['multipoints overlapping', feat({ type: 'MultiPoint', coordinates: [P(1, 1), P(3, 3)] }), feat({ type: 'MultiPoint', coordinates: [P(1, 1), P(5, 5)] }), ['intersects', 'overlaps']],
    ['multipolygon vs line', feat({ type: 'MultiPolygon', coordinates: [SQ.geometry.coordinates, uRect(3, 0, 4, 1).geometry.coordinates] }), uLine([0.5, 0.5], [3.5, 0.5]), ['intersects', 'crosses']],
  ];
  const preds = ['intersects', 'within', 'contains', 'disjoint', 'touches', 'crosses', 'overlaps'];
  for (const [name, A, B, yes] of cases) {
    for (const pred of preds) {
      const got = G.selectByLocation(fc([A]), fc([B]), { predicate: pred }).length === 1;
      assert.equal(got, yes.includes(pred), `${name}: ${pred} should be ${yes.includes(pred)}`);
    }
  }
  // within_distance: (3,1) is one unit (~829 m) east of SQ.
  const east = fc([uPt(3, 1)]);
  assert.deepEqual(G.selectByLocation(east, fc([SQ]), { predicate: 'within_distance', distance: 900 }), [0]);
  assert.deepEqual(G.selectByLocation(east, fc([SQ]), { predicate: 'within_distance', distance: 700 }), []);
  assert.deepEqual(G.selectByLocation(east, fc([SQ]), { predicate: 'within distance', distance: 0.9, units: 'km' }), [0]);
  assert.deepEqual(G.selectByLocation(fc([uLine([3, 0], [3, 2])]), fc([uLine([4.05, 0], [4.05, 2])]), { predicate: 'within_distance', distance: 900 }), [0]);
  assert.throws(() => G.selectByLocation(east, fc([SQ]), { predicate: 'near-ish' }), /Unknown spatial predicate/);
  assert.throws(() => G.selectByLocation(east, fc([SQ]), { predicate: 'within_distance' }), /needs a distance/);
});

test('selectByLocation on the Chicago layers', () => {
  const names = (idx) => idx.map((i) => PLACES.features[i].properties.name);
  assert.deepEqual(names(G.selectByLocation(PLACES, AREAS)), ['Willis Tower', 'Water Tower', 'Field Museum', 'Boundary Marker', 'Island Beacon']);
  assert.deepEqual(names(G.selectByLocation(PLACES, AREAS, { predicate: 'within' })), ['Willis Tower', 'Water Tower', 'Field Museum', 'Island Beacon']);
  assert.deepEqual(names(G.selectByLocation(PLACES, AREAS, { predicate: 'disjoint' })), ['Pond', 'Navy Pier']);
  assert.deepEqual(names(G.selectByLocation(PLACES, AREAS, { predicate: 'touches' })), ['Boundary Marker']);
  assert.deepEqual(names(G.selectByLocation(PLACES, AREAS, { predicate: 'within_distance', distance: 300 })), names(G.selectByLocation(PLACES, AREAS)));
  assert.deepEqual(names(G.selectByLocation(PLACES, AREAS, { predicate: 'within_distance', distance: 418 })).length, 6, 'the pond is ~414 m from the shore');
  assert.deepEqual(names(G.selectByLocation(PLACES, AREAS, { predicate: 'within_distance', distance: 450 })).length, 7);
  assert.deepEqual(G.selectByLocation(AREAS, AREAS, { predicate: 'touches' }), [0, 1, 2]);
  assert.deepEqual(G.selectByLocation(ROADS, AREAS, { predicate: 'crosses' }), [0, 1, 2]);
  assert.deepEqual(G.selectByLocation(AREAS, PLACES, { predicate: 'contains' }), [0, 1, 2, 3]);
  assert.deepEqual(G.selectByLocation(EMPTY, AREAS), []);
  assert.deepEqual(G.selectByLocation(PLACES, EMPTY, { predicate: 'disjoint' }), [0, 1, 2, 3, 4, 5, 6]);
});

/* ----------------------------------------------------------- spatial join */

test('spatialJoin: summary mode with counts and statistics', () => {
  const out = G.spatialJoin(AREAS, PLACES, { stats: [{ field: 'visitors', op: 'sum' }, { field: 'name', op: 'concat' }] });
  noIds(out);
  assert.deepEqual(out.features.map((f) => f.properties.count), [2, 2, 1, 1]);
  assert.equal(out.features[0].properties.sum_visitors, 1700005);
  assert.equal(out.features[0].properties.concat_name, 'Willis Tower, Boundary Marker');
  assert.equal(out.features[0].geometry, AREAS.features[0].geometry, 'target geometry is kept');
  const contains = G.spatialJoin(AREAS, PLACES, { predicate: 'contains', countField: 'n', prefix: 'p_', stats: [{ field: 'visitors', op: 'max' }] });
  assert.deepEqual(contains.features.map((f) => f.properties.n), [1, 1, 1, 1]);
  assert.equal(contains.features[0].properties.p_max_visitors, 1700000);
  const none = G.spatialJoin(AREAS, EMPTY, { stats: [{ field: 'x', op: 'mean' }] });
  assert.deepEqual(none.features[0].properties, { name: 'Loop', pop: 42000, zone: 'C', count: 0, mean_x: null });
});

test('spatialJoin: first and all modes (left join)', () => {
  const first = G.spatialJoin(PLACES, AREAS, { mode: 'first', fields: ['name', 'zone'] });
  assert.equal(first.features.length, 8, 'every target is kept, including attribute-only rows');
  assert.deepEqual(first.features[0].properties, { name: 'Willis Tower', visitors: 1700000, name_2: 'Loop', zone: 'C' });
  assert.equal(first.features[3].properties.name_2, null, 'the pond is in a hole');
  assert.equal(first.features[5].properties.name_2, 'Loop', 'first match wins');
  assert.equal(first.features[7].properties.name_2, null);
  const all = G.spatialJoin(PLACES, AREAS, { mode: 'all', prefix: 'area_' });
  assert.equal(all.features.length, 9);
  const marker = all.features.filter((f) => f.properties.name === 'Boundary Marker');
  assert.deepEqual(marker.map((f) => f.properties.area_name), ['Loop', 'Near North']);
  assert.equal(all.features.find((f) => f.properties.name === 'Navy Pier').properties.area_pop, null);
  const near = G.spatialJoin(PLACES, AREAS, { mode: 'first', predicate: 'within_distance', distance: 0.5, units: 'km', fields: ['name'] });
  assert.equal(near.features[4].properties.name_2, 'Islands');
  const roads = G.spatialJoin(ROADS, AREAS, { predicate: 'crosses', mode: 'all', fields: ['name'] });
  assert.deepEqual(roads.features.map((f) => f.properties.name_2), ['Loop', 'Loop', 'Near North', 'Museum Campus', null]);
  assert.throws(() => G.spatialJoin(PLACES, AREAS, { mode: 'some' }), /mode/);
  assert.throws(() => G.spatialJoin(PLACES, AREAS, { predicate: 'disjoint' }), /selectByLocation/);
});

test('countPointsInPolygons: counts and weights', () => {
  const out = G.countPointsInPolygons(AREAS, PLACES);
  assert.deepEqual(out.features.map((f) => f.properties.count), [2, 2, 1, 1]);
  const w = G.countPointsInPolygons(AREAS, PLACES, { field: 'visits', weightField: 'visitors' });
  assert.deepEqual(w.features.map((f) => f.properties.visits), [1700005, 300005, 1300000, 50]);
  const mixed = G.countPointsInPolygons(fc([...AREAS.features, ROADS.features[0]]), PLACES);
  assert.equal(mixed.features[4].properties.count, null);
  const mp = G.countPointsInPolygons(AREAS, fc([feat({ type: 'MultiPoint', coordinates: [[-87.63, 41.88], [-87.631, 41.881]] })]));
  assert.equal(mp.features[0].properties.count, 1, 'a MultiPoint feature counts once');
  noIds(out);
});

/* ------------------------------------------------------------------ nearest */

test('nearest: distances to points, lines and polygon boundaries', () => {
  const toRoads = G.nearest(PLACES, ROADS, { fields: ['name'] });
  noIds(toRoads);
  PLACES.features.forEach((p, i) => {
    const out = toRoads.features[i].properties;
    if (!p.geometry) { assert.equal(out.nearest_distance, null); assert.equal(out.nearest_index, null); return; }
    let best = Infinity, bi = -1;
    ROADS.features.forEach((r, j) => {
      const parts = r.geometry.type === 'LineString' ? [r.geometry.coordinates] : r.geometry.coordinates;
      for (const c of parts) {
        const d = turf.pointToLineDistance(p.geometry, turf.lineString(c), { units: 'meters' });
        if (d < best) { best = d; bi = j; }
      }
    });
    assert.equal(out.nearest_index, bi, `${p.properties.name} nearest road`);
    // Turf's pointToLineDistance is itself approximate (~0.1 m for a point on a line).
    assert.ok(Math.abs(out.nearest_distance - best) <= Math.max(0.005 * best, 0.5), `${p.properties.name} distance ${out.nearest_distance} vs ${best}`);
    assert.equal(out.nearest_name, ROADS.features[bi].properties.name);
  });
  const toAreas = G.nearest(PLACES, AREAS, { fields: [], units: 'km' });
  assert.equal(toAreas.features[0].properties.nearest_distance, 0, 'inside a polygon');
  approx(toAreas.features[3].properties.nearest_distance, 0.414, 0.01, 'pond to the shore of its hole');
  assert.equal(toAreas.features[3].properties.nearest_index, 2);
  assert.equal('nearest_name' in toAreas.features[0].properties, false);
  const capped = G.nearest(PLACES, AREAS, { maxDistance: 100, prefix: 'n_' });
  assert.equal(capped.features[4].properties.n_distance, null, 'Navy Pier is > 100 m from any area');
  assert.equal(capped.features[4].properties.n_name, null);
  const self = G.nearest(PLACES, PLACES, { fields: ['name'] });
  assert.equal(self.features[0].properties.nearest_name, 'Boundary Marker', 'a feature never matches itself');
  // Polygons use a point inside them: the park's center of mass is in the pond, so its
  // representative point lies west of the pond, closest to the Field Museum.
  const fromPolys = G.nearest(AREAS, PLACES, { fields: ['name'] });
  assert.equal(fromPolys.features[2].properties.nearest_name, 'Field Museum');
  assert.ok(fromPolys.features[2].properties.nearest_distance > 0);
  assert.equal(fromPolys.features[0].properties.nearest_name, 'Willis Tower');
  assert.throws(() => G.nearest(PLACES, EMPTY), /no features with geometry/);
});

/* -------------------------------------------------------------------- grids */

test('grid: square, hex, triangle and point grids', () => {
  const box = [-87.64, 41.87, -87.6, 41.91];
  const sq = G.grid(box, 1000);
  const w = length(line([[-87.64, 41.89], [-87.6, 41.89]])), h = length(line([[-87.62, 41.87], [-87.62, 41.91]]));
  assert.equal(sq.features.length, Math.ceil(w / 1000) * Math.ceil(h / 1000));
  approx(area(sq.features[0]), 1e6, 0.01, 'cell area');
  assert.deepEqual(sq.features[0].properties, { row: 0, col: 0 });
  assert.ok(area(sq) >= area(turf.bboxPolygon(box)), 'cells cover the extent');
  const hex = G.grid(box, 500, { type: 'hex' });
  approx(area(hex.features[5]), (3 * Math.sqrt(3) / 2) * 500 * 500, 0.02, 'hexagon area');
  const inside = turf.pointGrid(box, 0.3, { units: 'kilometers' });
  for (const p of inside.features) assert.ok(hex.features.some((f) => turf.booleanPointInPolygon(p, f)), 'hexes cover the extent');
  const tri = G.grid(box, 1, { type: 'triangles', units: 'km' });
  assert.equal(tri.features.length, 2 * sq.features.length);
  approx(area(tri.features[0]), 0.5e6, 0.01, 'triangle area');
  const pts = G.grid(box, 1000, { type: 'point' });
  assert.equal(pts.features.length, sq.features.length);
  assert.ok(turf.booleanPointInPolygon(pts.features[0], sq.features[0]));
  const masked = G.grid(null, 250, { mask: fc([AREAS.features[0]]) });
  assert.ok(masked.features.length > 0 && masked.features.every((f) => turf.booleanIntersects(f, AREAS.features[0])));
  const maskedPts = G.grid(box, 250, { type: 'point', mask: AREAS });
  assert.ok(maskedPts.features.every((f) => AREAS.features.some((a) => turf.booleanPointInPolygon(f, a))));
  const fromLayer = G.grid(PLACES, 2, { units: 'km' });
  assert.ok(fromLayer.features.length > 0);
  assert.throws(() => G.grid([-90, 40, -80, 45], 100), /cells \(the limit is 200,000\)/);
  assert.throws(() => G.grid(box, 100, { type: 'octagon' }), /Unknown grid type/);
  assert.throws(() => G.grid([1, 1, 1, 2], 100), /no area/);
});

test('randomPoints: seeded, inside a bbox or polygons', () => {
  const box = [-87.7, 41.8, -87.6, 41.9];
  const a = G.randomPoints(50, { bbox: box, seed: 7 });
  const b = G.randomPoints(50, { bbox: box, seed: 7 });
  const c = G.randomPoints(50, { bbox: box, seed: 8 });
  assert.deepEqual(a, b);
  assert.notDeepEqual(a, c);
  assert.ok(a.features.every((f) => turf.booleanPointInPolygon(f, turf.bboxPolygon(box))));
  const within = G.randomPoints(300, { within: AREAS, seed: 'chicago' });
  assert.equal(within.features.length, 300);
  const inPond = within.features.filter((f) => turf.booleanPointInPolygon(f, rect(-87.615, 41.865, -87.605, 41.875)));
  assert.equal(inPond.length, 0, 'never inside holes');
  assert.ok(within.features.every((f) => AREAS.features.some((ar) => turf.booleanPointInPolygon(f, ar))));
  // Roughly proportional to area: the islands are ~4.8% of the total area (~14 of 300 points).
  const onIslands = within.features.filter((f) => turf.booleanPointInPolygon(f, AREAS.features[3])).length;
  assert.ok(onIslands >= 3 && onIslands <= 30, `${onIslands} points on the islands`);
  assert.equal(G.randomPoints(0, { bbox: box }).features.length, 0);
  assert.throws(() => G.randomPoints(5), /bbox or a polygon layer/);
  assert.throws(() => G.randomPoints(-1, { bbox: box }), /whole number/);
  assert.throws(() => G.randomPoints(5, { within: ROADS }), /no polygons/);
});

/* --------------------------------------------------------------- clustering */

test('kmeans: separates obvious clusters deterministically', () => {
  const r = rnd(3);
  const pts = [];
  for (let i = 0; i < 60; i++) {
    const c = i % 3;
    const cx = [-87.7, -87.5, -87.6][c], cy = [41.8, 41.8, 41.95][c];
    pts.push(pt(cx + (r() - 0.5) * 0.01, cy + (r() - 0.5) * 0.01, { truth: c }));
  }
  pts.push(feat(null, { truth: null }));
  const out = G.kmeans(fc(pts), { k: 3, seed: 42 });
  const byTruth = new Map();
  out.features.slice(0, 60).forEach((f) => {
    const t = f.properties.truth;
    if (!byTruth.has(t)) byTruth.set(t, new Set());
    byTruth.get(t).add(f.properties.cluster);
  });
  assert.ok([...byTruth.values()].every((s) => s.size === 1), 'each true cluster maps to one label');
  assert.equal(new Set(out.features.slice(0, 60).map((f) => f.properties.cluster)).size, 3);
  assert.equal(out.features[0].properties.cluster, 0, 'labels in order of first appearance');
  assert.equal(out.features[60].properties.cluster, null);
  assert.deepEqual(G.kmeans(fc(pts), { k: 3, seed: 42 }), out, 'deterministic');
  const named = G.kmeans(fc(pts), { k: 2, field: 'grp' });
  assert.ok('grp' in named.features[0].properties);
  const few = G.kmeans(fc([pt(0, 0), pt(0, 0), pt(1, 1)]), { k: 5 });
  assert.match(few.warnings.join(' '), /k was reduced to 2/);
  assert.throws(() => G.kmeans(fc(pts), { k: 0 }), /k must be/);
});

test('dbscan: core, edge and noise points', () => {
  // A plus-shaped cluster (arms 41 m E-W, 56 m N-S; diagonals 69 m), one edge point, one outlier.
  const base = [-87.63, 41.88];
  const d = 0.0005; // ~41 m in longitude, ~56 m in latitude
  const pts = [
    pt(base[0], base[1], { n: 0 }), pt(base[0] + d, base[1], { n: 1 }), pt(base[0], base[1] + d, { n: 2 }),
    pt(base[0] - d, base[1], { n: 3 }), pt(base[0], base[1] - d, { n: 4 }),
    pt(base[0] + 2.2 * d, base[1], { n: 5 }), // edge: within 75 m of n=1 only
    pt(base[0] + 0.05, base[1], { n: 6 }), // noise
  ];
  const out = G.dbscan(fc(pts), { distance: 75, minPoints: 3 });
  const kinds = out.features.map((f) => f.properties.dbscan);
  assert.deepEqual(kinds, ['core', 'core', 'core', 'core', 'core', 'edge', 'noise']);
  assert.deepEqual(out.features.map((f) => f.properties.cluster), [0, 0, 0, 0, 0, 0, null]);
  // With 60 m the diagonals (69 m) are too long: only the center and the east arm stay core.
  const tight = G.dbscan(fc(pts), { distance: 60, minPoints: 3 });
  assert.deepEqual(tight.features.map((f) => f.properties.dbscan), ['core', 'core', 'edge', 'edge', 'edge', 'edge', 'noise']);
  const two = G.dbscan(fc([...pts, pt(base[0] + 0.05 + d, base[1]), pt(base[0] + 0.05 - d, base[1])]), { distance: 0.075, units: 'km', minPoints: 3, field: 'grp' });
  assert.deepEqual(two.features.map((f) => f.properties.grp), [0, 0, 0, 0, 0, 0, 1, 1, 1]);
  assert.throws(() => G.dbscan(fc(pts), {}), /distance must be/);
});

/* --------------------------------------------------------- measure / tables */

test('measure: geodesic area, perimeter, length and coordinates', () => {
  const all = fc([...AREAS.features, ...ROADS.features, ...PLACES.features]);
  const out = G.measure(all, { areaUnits: 'hectares', lengthUnits: 'km' });
  noIds(out);
  const loop = out.features[0].properties;
  approx(loop.area, area(AREAS.features[0]) / 1e4, 1e-9, 'area in ha');
  approx(loop.perimeter, length(G.polygonsToLines(fc([AREAS.features[0]]))) / 1000, 1e-9, 'perimeter');
  const park = out.features[2].properties;
  approx(park.area, (area(rect(-87.62, 41.86, -87.6, 41.88)) - area(rect(-87.615, 41.865, -87.605, 41.875))) / 1e4, 1e-6, 'hole subtracted');
  approx(out.features[4].properties.length, length(ROADS.features[0]) / 1000, 1e-9, 'length in km');
  assert.equal(out.features[8].properties.lon, -87.6359);
  assert.equal(out.features[8].properties.lat, 41.8789);
  assert.equal(out.features[15].geometry, null);
  assert.deepEqual(Object.keys(out.features[15].properties).sort(), ['area', 'lat', 'length', 'lon', 'name', 'perimeter', 'visitors']);
  assert.equal(out.features[15].properties.area, null);
  const renamed = G.measure(AREAS, { fields: { area: 'area_m2' } });
  assert.ok('area_m2' in renamed.features[0].properties && 'perimeter' in renamed.features[0].properties);
  const only = G.measure(AREAS, { fields: ['area'], areaUnits: 'km2' });
  assert.deepEqual(Object.keys(only.features[0].properties), ['name', 'pop', 'zone', 'area']);
  approx(only.features[0].properties.area, area(AREAS.features[0]) / 1e6, 1e-9, 'km2');
  assert.throws(() => G.measure(AREAS, { areaUnits: 'furlongs' }), /Unknown area unit/);
});

test('summarize: attribute table rows (not a FeatureCollection)', () => {
  const rows = G.summarize(AREAS, { groupBy: 'zone', stats: [{ field: 'pop', op: 'sum' }, { field: 'pop', op: 'median' }, { field: 'name', op: 'unique_count' }] });
  assert.ok(Array.isArray(rows));
  assert.deepEqual(rows, [
    { zone: 'C', count: 2, sum_pop: 122000, median_pop: 61000, unique_count_name: 2 },
    { zone: 'P', count: 2, sum_pop: 10, median_pop: 5, unique_count_name: 2 },
  ]);
  const places = G.summarize(PLACES, { stats: [{ field: 'visitors', op: 'avg' }, { field: 'visitors', op: 'count' }, { field: 'visitors', op: 'std', as: 'sd' }] });
  assert.equal(places.length, 1);
  assert.equal(places[0].count, 8, 'attribute-only rows are counted');
  assert.equal(places[0].count_visitors, 7);
  approx(places[0].mean_visitors, 12300055 / 7, 1e-12, 'mean ignores nulls');
  assert.ok(places[0].sd > 0);
  assert.deepEqual(G.summarize(EMPTY), [{ count: 0 }]);
  assert.deepEqual(G.summarize(EMPTY, { groupBy: ['x'] }), []);
  const strings = G.summarize(fc([feat(null, { v: '5' }), feat(null, { v: '7' }), feat(null, { v: 'n/a' })]), { stats: [{ field: 'v', op: 'sum' }, { field: 'v', op: 'max' }] });
  assert.deepEqual(strings[0], { count: 3, sum_v: 12, max_v: 7 });
});

/* ------------------------------------------------------------- validation */

const BAD = deepFreeze(fc([
  AREAS.features[0],
  feat(null),
  poly([[[0, 0], [1, 0], [1, 1], [0, 1]]]),
  poly([[[0, 0], [1, 0], [0, 0]]]),
  line([[0, 0], [NaN, 1]]),
  poly([[[0, 0], [2, 2], [2, 0], [0, 2], [0, 0]]]),
  poly([[[0, 0], [1, 0], [1, 1], [1, 3], [1, 1], [0, 1], [0, 0]]]),
  poly([[[0, 0], [4, 0], [4, 4], [0, 4], [0, 0]], [[5, 5], [6, 5], [6, 6], [5, 5]]]),
  feat({ type: 'MultiPolygon', coordinates: [[[[0, 0], [4, 0], [4, 4], [0, 4], [0, 0]]], [[[1, 1], [2, 1], [2, 2], [1, 1]]]] }),
  pt(200, 100),
  feat({ type: 'Circle', coordinates: [0, 0] }),
  poly([[[0, 0], [1, 0], [2, 0], [0, 0]]]),
  poly([[[0, 0], [1, 0], [1, 0], [1, 1], [0, 1], [0, 0]]]),
]));

test('validate: reports each kind of problem', () => {
  const v = G.validate(BAD);
  assert.equal(v.valid, false);
  const reasons = Object.fromEntries(v.invalid.map((e) => [e.index, e.reason]));
  assert.equal(reasons[0], undefined, 'a clean polygon is valid');
  assert.equal(reasons[1], 'null geometry');
  assert.equal(reasons[2], 'unclosed ring');
  assert.equal(reasons[3], 'too few positions');
  assert.equal(reasons[4], 'NaN coordinates');
  assert.equal(reasons[5], 'self-intersection');
  assert.equal(reasons[6], 'self-intersection', 'spike');
  assert.equal(reasons[7], 'hole outside shell');
  assert.equal(reasons[8], 'overlapping parts');
  assert.equal(reasons[9], 'coordinates outside lon/lat range');
  assert.match(reasons[10], /unknown geometry type "Circle"/);
  assert.equal(reasons[11], 'degenerate ring (zero area)');
  assert.equal(reasons[12], undefined, 'duplicate consecutive vertices are allowed');
  assert.deepEqual(G.validate(AREAS), { valid: true, invalid: [] });
  assert.deepEqual(G.validate(EMPTY), { valid: true, invalid: [] });
  // Large rings use the indexed self-intersection check.
  const circle = G.buffer(fc([pt(-87.63, 41.88)]), 1000, { steps: 200 }).features[0];
  assert.equal(G.validate(fc([circle])).valid, true);
  const ring = circle.geometry.coordinates[0].slice();
  [ring[10], ring[400]] = [ring[400], ring[10]];
  assert.equal(G.validate(fc([poly([ring])])).invalid[0].reason, 'self-intersection');
});

test('makeValid: repaired geometries pass validation', () => {
  const out = G.makeValid(BAD);
  assert.equal(out.features.length, BAD.features.length, 'one output per input');
  noIds(out);
  const v = G.validate(fc(out.features.filter((f) => f.geometry && f.geometry.type !== 'Point')));
  assert.deepEqual(v.invalid, []);
  assert.equal(out.features[1].geometry, null);
  assert.equal(out.features[2].geometry.coordinates[0].length, 5, 'ring closed');
  assert.equal(out.features[3].geometry, null, 'collapsed ring');
  assert.equal(out.features[5].geometry.type, 'MultiPolygon', 'bow-tie split into two triangles');
  approx(area(out.features[5]), area(poly([[[0, 0], [1, 1], [0, 2], [0, 0]]])) * 2, 1e-6, 'bow-tie area');
  approx(area(out.features[6]), area(poly([[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]])), 1e-6, 'spike removed');
  assert.equal(out.features[7].geometry.coordinates.length, 1, 'hole outside the shell dropped');
  assert.equal(out.features[8].geometry.type, 'MultiPolygon', 'geometry type is preserved');
  assert.equal(out.features[8].geometry.coordinates.length, 1, 'overlapping parts merged');
  approx(area(out.features[8]), area(poly([[[0, 0], [4, 0], [4, 4], [0, 4], [0, 0]]])), 1e-9, 'merged area');
  assert.equal(out.features[10].geometry, null, 'unknown geometry types are dropped');
  assert.equal(out.features[11].geometry, null);
  assert.equal(out.features[12].geometry.coordinates[0].length, 5, 'duplicates removed');
  assert.ok(out.warnings.join(' ').includes('no usable geometry'));
  // RFC 7946 winding: outer ring counter-clockwise.
  const cw = G.makeValid(fc([poly([[[0, 0], [0, 1], [1, 1], [1, 0], [0, 0]]])]));
  assert.equal(turf.booleanClockwise(cw.features[0].geometry.coordinates[0]), false);
});

/* ------------------------------------------------ cross-cutting behaviour */

test('inputs are never mutated and outputs never carry input ids', () => {
  const calls = [
    () => G.buffer(AREAS, 100), () => G.buffer(PLACES, 50, { dissolve: true }), () => G.multiRingBuffer(PLACES, [10, 20]),
    () => G.clip(ROADS, AREAS), () => G.erase(AREAS, fc([rect(-87.63, 41.88, -87.61, 41.9)])), () => G.intersect(ROADS, AREAS),
    () => G.union(AREAS, AREAS), () => G.symDifference(AREAS, AREAS), () => G.dissolve(AREAS, { fields: 'zone' }),
    () => G.merge([AREAS, ROADS]), () => G.centroids(AREAS, { method: 'point_on_surface' }), () => G.convexHull(AREAS),
    () => G.concaveHull(PLACES), () => G.envelope(AREAS), () => G.simplify(AREAS, { tolerance: 50 }), () => G.smooth(AREAS),
    () => G.densify(ROADS, { interval: 300 }), () => G.voronoi(PLACES, { clipTo: AREAS }), () => G.delaunay(PLACES),
    () => G.explode(AREAS), () => G.polygonsToLines(AREAS), () => G.linesToPolygons(ROADS), () => G.extractVertices(ROADS),
    () => G.pointsAlongLines(ROADS, { interval: 500 }), () => G.lineIntersections(ROADS, AREAS), () => G.splitLines(ROADS, AREAS),
    () => G.spatialJoin(AREAS, PLACES, { mode: 'all' }), () => G.countPointsInPolygons(AREAS, PLACES), () => G.nearest(PLACES, ROADS),
    () => G.grid(AREAS, 500, { mask: AREAS }), () => G.randomPoints(10, { within: AREAS, seed: 1 }), () => G.kmeans(PLACES, { k: 2 }),
    () => G.dbscan(PLACES, { distance: 500 }), () => G.measure(AREAS), () => G.makeValid(AREAS),
  ];
  for (const call of calls) {
    const out = call();
    isFC(out);
    noIds(out);
    for (const f of out.features) assert.ok(f.properties && typeof f.properties === 'object');
  }
  G.summarize(AREAS, { groupBy: 'zone' });
  G.validate(AREAS);
  G.selectByLocation(PLACES, AREAS);
  G.index(AREAS).search([-88, 41, -87, 42]);
  assert.equal(JSON.stringify(DATA), SNAPSHOT);
});

test('empty inputs give empty outputs', () => {
  const fns = [
    () => G.buffer(EMPTY, 10), () => G.multiRingBuffer(EMPTY, [10]), () => G.erase(EMPTY, AREAS), () => G.union(EMPTY, AREAS),
    () => G.symDifference(AREAS, EMPTY), () => G.dissolve(EMPTY), () => G.merge([]), () => G.centroids(EMPTY), () => G.convexHull(EMPTY),
    () => G.concaveHull(EMPTY), () => G.envelope(EMPTY), () => G.simplify(EMPTY, { tolerance: 1 }), () => G.smooth(EMPTY),
    () => G.densify(EMPTY, { interval: 1 }), () => G.delaunay(EMPTY), () => G.explode(EMPTY), () => G.polygonsToLines(EMPTY),
    () => G.linesToPolygons(EMPTY), () => G.extractVertices(EMPTY), () => G.pointsAlongLines(EMPTY, { interval: 1 }),
    () => G.lineIntersections(EMPTY, ROADS), () => G.splitLines(EMPTY, ROADS), () => G.spatialJoin(EMPTY, AREAS),
    () => G.countPointsInPolygons(EMPTY, PLACES), () => G.nearest(EMPTY, PLACES), () => G.kmeans(EMPTY), () => G.dbscan(EMPTY, { distance: 1 }),
    () => G.measure(EMPTY), () => G.makeValid(EMPTY),
  ];
  for (const fn of fns) {
    const out = fn();
    const n = fn === fns[3] ? AREAS.features.length : fn === fns[4] ? AREAS.features.length : 0;
    assert.equal(out.features.length, n);
  }
});

test('mixed geometry layers and GeometryCollections', () => {
  const mixed = fc([AREAS.features[0], ROADS.features[0], PLACES.features[0], feat({ type: 'GeometryCollection', geometries: [PLACES.features[1].geometry, ROADS.features[1].geometry] }, { gc: true })]);
  const clipped = G.clip(mixed, fc([rect(-87.64, 41.87, -87.625, 41.9)]));
  assert.deepEqual(clipped.features.map((f) => f.geometry.type), ['Polygon', 'LineString', 'Point', 'LineString'], 'the GC keeps only its State St part');
  const gcKeep = G.clip(fc([mixed.features[3]]), fc([rect(-87.64, 41.87, -87.62, 41.9)]));
  assert.equal(gcKeep.features[0].geometry.type, 'GeometryCollection');
  const buf = G.buffer(mixed, 20);
  assert.equal(buf.features.length, 4);
  assert.equal(buf.features[3].geometry.type, 'MultiPolygon');
  const m = G.measure(mixed);
  assert.ok(m.features[0].properties.area > 0 && m.features[1].properties.length > 0 && m.features[2].properties.lon < 0);
  assert.ok(m.features[3].properties.length > 0 && m.features[3].properties.lon < 0);
  const ex = G.explode(mixed);
  assert.equal(ex.features.length, 5);
  assert.deepEqual(G.selectByLocation(mixed, fc([rect(-87.63, 41.895, -87.62, 41.9)])), [3]);
});

test('warnings are reported for features that fail and processing continues', () => {
  const junk = fc([AREAS.features[0], feat({ type: 'Polygon', coordinates: [[[0, 0], ['a', 1], [2, 2]]] }), feat({ type: 'LineString', coordinates: 'oops' })]);
  const out = G.buffer(junk, 10);
  assert.equal(out.features.length, 1);
  assert.ok(Array.isArray(out.warnings) && out.warnings.every((w) => typeof w === 'string'));
  const clean = G.buffer(fc([AREAS.features[0]]), 10);
  assert.equal(clean.warnings, undefined, 'no warnings property when all went well');
  const c = G.clip(junk, AREAS);
  assert.equal(c.features.length, 1);
});

/* ------------------------------------------------------ property checks */

function starPolygon(r, cx, cy, rad, n, jag) {
  const ring = [];
  for (let k = 0; k < n; k++) {
    const a = (2 * Math.PI * k) / n, rr = rad * (1 - jag * r());
    ring.push([cx + rr * Math.cos(a) * 1.34, cy + rr * Math.sin(a)]);
  }
  ring.push(ring[0].slice());
  return ring;
}
function planarArea(g) {
  const ringA = (c) => { let s = 0; for (let i = 0; i < c.length - 1; i++) s += c[i][0] * c[i + 1][1] - c[i + 1][0] * c[i][1]; return Math.abs(s / 2); };
  let a = 0;
  for (const rings of g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : []) {
    a += ringA(rings[0]);
    for (let i = 1; i < rings.length; i++) a -= ringA(rings[i]);
  }
  return a;
}

test('property: clip + erase conserve area and match turf.intersect (incl. large pre-clipped operands)', () => {
  const r = rnd(11);
  for (let it = 0; it < 18; it++) {
    const a = poly([starPolygon(r, -87.6 + r() * 0.05, 41.9 + r() * 0.05, 0.02 + r() * 0.02, 5 + Math.floor(r() * 30), 0.6)]);
    const big = it % 3 === 0;
    const bRings = [starPolygon(r, -87.6 + r() * 0.05, 41.9 + r() * 0.05, 0.02 + r() * 0.03, big ? 900 : 5 + Math.floor(r() * 30), 0.3)];
    if (it % 4 === 1) {
      const c = bRings[0].slice(0, -1).reduce((s, p) => [s[0] + p[0], s[1] + p[1]], [0, 0]).map((v) => v / (bRings[0].length - 1));
      bRings.push(starPolygon(r, c[0], c[1], 0.004, 10, 0.2).reverse());
    }
    const b = poly(bRings);
    const c = G.clip(fc([a]), fc([b])), e = G.erase(fc([a]), fc([b]));
    assert.equal(c.warnings, undefined);
    assert.equal(e.warnings, undefined);
    const ca = c.features.reduce((s, f) => s + planarArea(f.geometry), 0);
    const ea = e.features.reduce((s, f) => s + planarArea(f.geometry), 0);
    const total = planarArea(a.geometry);
    assert.ok(Math.abs(ca + ea - total) <= 1e-8 * total, `iteration ${it}: ${ca} + ${ea} != ${total}`);
    const ref = turf.intersect(turf.featureCollection([a, b]));
    assert.ok(Math.abs((ref ? planarArea(ref.geometry) : 0) - ca) <= 1e-8 * total, `iteration ${it}: differs from turf.intersect`);
  }
});

test('property: makeValid output always passes validate', () => {
  const r = rnd(5);
  const feats = [];
  for (let it = 0; it < 150; it++) {
    const n = 4 + Math.floor(r() * 10);
    const ring = [];
    for (let k = 0; k < n; k++) ring.push([+(-87.7 + r() * 0.1).toFixed(r() < 0.5 ? 2 : 4), +(41.8 + r() * 0.1).toFixed(r() < 0.5 ? 2 : 4)]);
    ring.push(ring[0].slice());
    const rings = [ring];
    if (r() < 0.3) rings.push(starPolygon(r, -87.65, 41.85, 0.02, 5, 0.5));
    feats.push(feat(r() < 0.3 ? { type: 'MultiPolygon', coordinates: [rings, [ring.map((p) => [p[0] + r() * 0.03, p[1]])]] } : { type: 'Polygon', coordinates: rings }, { it }));
  }
  const out = G.makeValid(fc(feats));
  assert.equal(out.features.length, feats.length);
  const kept = out.features.filter((f) => f.geometry);
  assert.ok(kept.length > 130);
  assert.deepEqual(G.validate(fc(kept)).invalid, []);
  assert.ok(G.validate(fc(feats)).invalid.length > 40, 'the random input really was invalid');
});

test('property: nearest matches brute force for polygon targets; spatial join agrees with selectByLocation', () => {
  const r = rnd(21);
  const polys = fc(Array.from({ length: 40 }, (_, i) => poly([starPolygon(r, -87.8 + r() * 0.4, 41.7 + r() * 0.3, 0.003 + r() * 0.01, 6 + Math.floor(r() * 60), 0.5)], { pid: i })));
  const pts = randomPointsFc(120, 22, [-87.85, 41.65, -87.35, 42.05]);
  const out = G.nearest(pts, polys, { fields: ['pid'] });
  pts.features.forEach((p, i) => {
    let best = Infinity, bj = -1;
    polys.features.forEach((f, j) => {
      const d = turf.booleanPointInPolygon(p, f) ? 0 : turf.pointToLineDistance(p, turf.lineString(f.geometry.coordinates[0]), { units: 'meters' });
      if (d < best) { best = d; bj = j; }
    });
    const got = out.features[i].properties;
    assert.ok(Math.abs(got.nearest_distance - best) <= Math.max(0.005 * best, 0.5), `point ${i}: ${got.nearest_distance} vs ${best}`);
    if (Math.abs(got.nearest_distance - best) > 1) assert.equal(got.nearest_index, bj);
  });
  for (const predicate of ['intersects', 'within', 'touches', 'within_distance']) {
    const opts = { predicate, distance: 300 };
    const sel = new Set(G.selectByLocation(pts, polys, opts));
    const joined = G.spatialJoin(pts, polys, opts);
    joined.features.forEach((f, i) => assert.equal(f.properties.count > 0, sel.has(i), `${predicate} #${i}`));
  }
});

test('grid type aliases and closed rings in pointsAlongLines', () => {
  const box = [-87.64, 41.87, -87.6, 41.91];
  assert.equal(G.grid(box, 500, { type: 'hexagons' }).features.length, G.grid(box, 500, { type: 'hex' }).features.length);
  assert.equal(G.grid(box, 500, { type: 'Points' }).features.length, G.grid(box, 500, { type: 'point' }).features.length);
  const ring = G.pointsAlongLines(fc([AREAS.features[0]]), { interval: 100000 });
  assert.equal(ring.features.length, 1, 'the end of a closed ring is its start');
});

/* ------------------------------------------------------------- performance */

test('performance: spatial join 5k points x 500 polygons < 3 s', () => {
  const pts = randomPointsFc(5000, 1, [-88, 41.6, -87.2, 42.1]);
  const polys = randomPolygonsFc(500, 2);
  const t0 = Date.now();
  const out = G.spatialJoin(polys, pts, { stats: [{ field: 'v', op: 'sum' }] });
  const first = G.spatialJoin(pts, polys, { mode: 'first' });
  const ms = Date.now() - t0;
  assert.ok(ms < 3000, `took ${ms} ms`);
  const total = out.features.reduce((s, f) => s + f.properties.count, 0);
  // Cross-check a sample against Turf.
  for (let i = 0; i < 20; i++) {
    const f = polys.features[i];
    const n = pts.features.filter((p) => turf.booleanPointInPolygon(p, f)).length;
    assert.equal(out.features[i].properties.count, n);
  }
  assert.ok(total > 0 && first.features.length === 5000);
});

test('performance: nearest 5k x 5k points < 3 s (exact)', () => {
  const a = randomPointsFc(5000, 3), b = randomPointsFc(5000, 4);
  const t0 = Date.now();
  const out = G.nearest(a, b, { fields: ['i'] });
  const ms = Date.now() - t0;
  assert.ok(ms < 3000, `took ${ms} ms`);
  for (let i = 0; i < 50; i++) {
    const p = a.features[i].geometry.coordinates;
    let best = Infinity, bj = -1;
    b.features.forEach((f, j) => { const d = turf.distance(p, f.geometry.coordinates, { units: 'meters' }); if (d < best) { best = d; bj = j; } });
    assert.equal(out.features[i].properties.nearest_index, bj);
    approx(out.features[i].properties.nearest_distance, best, 1e-9, 'distance');
  }
});

test('performance: dissolve 2k adjacent squares < 3 s', () => {
  const grid = squareGrid(50, 40, 0.01, -87.9, 41.6);
  const t0 = Date.now();
  const all = G.dissolve(grid);
  const halves = G.dissolve(grid, { fields: ['half'], stats: [{ field: 'v', op: 'sum' }] });
  const ms = Date.now() - t0;
  assert.ok(ms < 3000, `took ${ms} ms`);
  assert.equal(all.features.length, 1);
  assert.equal(all.features[0].geometry.type, 'Polygon');
  assert.equal(all.features[0].geometry.coordinates[0].length, 5, 'collinear vertices are merged away');
  assert.equal(all.features[0].properties.count, 2000);
  approx(area(all), area(rect(-87.9, 41.6, -87.4, 42.0)), 1e-6, 'area');
  assert.deepEqual(halves.features.map((f) => f.properties), [{ half: 'W', count: 1000, sum_v: 1000 }, { half: 'E', count: 1000, sum_v: 1000 }]);
});

test('performance: buffer + dissolve of 3k points stays fast', () => {
  const pts = randomPointsFc(3000, 5);
  const t0 = Date.now();
  const out = G.buffer(pts, 100, { dissolve: true });
  const ms = Date.now() - t0;
  assert.ok(ms < 3000, `took ${ms} ms`);
  assert.equal(out.features.length, 1);
  assert.equal(out.features[0].geometry.type, 'MultiPolygon');
});
