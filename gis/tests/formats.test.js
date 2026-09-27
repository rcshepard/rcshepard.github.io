'use strict';
/*
 * Fast tests for js/lib/formats.js (no GDAL; see formats.gdal.test.js for that).
 */
const { describe, test, before } = require('node:test');
const assert = require('node:assert/strict');
const harness = require('./harness');

const M = harness.load('formats');
const F = M.formats;

let SQL;
before(async () => { SQL = await harness.initSqlJs(); });

/* ------------------------------------------------------------ helpers */

const fc = (features) => ({ type: 'FeatureCollection', features });
const feat = (geometry, properties) => ({ type: 'Feature', geometry, properties: properties || {} });
const pt = (x, y, z) => ({ type: 'Point', coordinates: z === undefined ? [x, y] : [x, y, z] });

function signedArea(ring) {
  let a = 0;
  for (let i = 0; i < ring.length - 1; i++) a += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
  return a / 2;
}

function close(a, b, eps) {
  return Math.abs(a - b) <= (eps || 1e-9);
}

function assertCoordsClose(actual, expected, eps, path) {
  path = path || 'coordinates';
  if (typeof expected === 'number') {
    assert.ok(close(actual, expected, eps), path + ': ' + actual + ' != ' + expected);
    return;
  }
  assert.equal(actual.length, expected.length, path + ' length');
  expected.forEach((e, i) => assertCoordsClose(actual[i], e, eps, path + '[' + i + ']'));
}

/** Geometry equality up to floating-point noise (shpjs sends coordinates through proj4). */
function assertGeomClose(actual, expected) {
  assert.ok(actual, 'geometry expected');
  assert.equal(actual.type, expected.type);
  assertCoordsClose(actual.coordinates, expected.coordinates, 1e-9);
}

/** Strict well-formedness check for the XML we generate (entities, quoting, balanced tags). */
function assertWellFormedXml(xml) {
  const body = xml.replace(/^<\?xml[^?]*\?>\s*/, '');
  const re = /<(\/?)([A-Za-z_][\w.:-]*)((?:\s+[A-Za-z_][\w.:-]*\s*=\s*"[^"<]*")*)\s*(\/?)>/g;
  const stack = [];
  let last = 0, m, roots = 0;
  const checkText = (t) => {
    assert.ok(!/[<>]/.test(t), 'raw < or > in text: ' + t.slice(0, 80));
    assert.ok(!/&(?!(amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/.test(t), 'bad entity in: ' + t.slice(0, 80));
  };
  while ((m = re.exec(body)) !== null) {
    checkText(body.slice(last, m.index));
    last = re.lastIndex;
    const attrs = m[3];
    (attrs.match(/"[^"]*"/g) || []).forEach((v) => checkText(v.slice(1, -1)));
    const names = (attrs.match(/[A-Za-z_][\w.:-]*(?=\s*=)/g) || []);
    assert.equal(new Set(names).size, names.length, 'duplicate attribute in <' + m[2] + '>');
    if (m[1]) {
      assert.equal(stack.pop(), m[2], 'mismatched closing tag </' + m[2] + '>');
    } else if (!m[4]) {
      if (!stack.length) roots++;
      stack.push(m[2]);
    } else if (!stack.length) roots++;
  }
  checkText(body.slice(last));
  assert.equal(stack.length, 0, 'unclosed tags: ' + stack.join(', '));
  assert.equal(roots, 1, 'exactly one root element');
}

/** Optional extra check with @xmldom/xmldom when it happens to be installed. */
function loadXmldom() {
  for (const p of ['@xmldom/xmldom', '/tmp/deps/node_modules/@xmldom/xmldom']) {
    try { return require(p).DOMParser; } catch (e) { /* not available */ }
  }
  return null;
}
const XmlDom = loadXmldom();
function xmldomParse(xml) {
  const problems = [];
  const handler = { warning: (m) => problems.push(m), error: (m) => problems.push(m), fatalError: (m) => problems.push(m) };
  const doc = new XmlDom({ errorHandler: handler }).parseFromString(xml, 'text/xml');
  assert.deepEqual(problems, []);
  return doc;
}

async function unzip(bytes) {
  const zip = await JSZip.loadAsync(bytes);
  const out = {};
  for (const name of Object.keys(zip.files)) {
    if (!zip.files[name].dir) out[name] = await zip.files[name].async('uint8array');
  }
  return out;
}

const WKT_32616 = 'PROJCS["WGS 84 / UTM zone 16N",GEOGCS["WGS 84",DATUM["WGS_1984",SPHEROID["WGS 84",6378137,298.257223563,' +
  'AUTHORITY["EPSG","7030"]],AUTHORITY["EPSG","6326"]],PRIMEM["Greenwich",0,AUTHORITY["EPSG","8901"]],UNIT["degree",' +
  '0.0174532925199433,AUTHORITY["EPSG","9122"]],AUTHORITY["EPSG","4326"]],PROJECTION["Transverse_Mercator"],' +
  'PARAMETER["latitude_of_origin",0],PARAMETER["central_meridian",-87],PARAMETER["scale_factor",0.9996],' +
  'PARAMETER["false_easting",500000],PARAMETER["false_northing",0],UNIT["metre",1,AUTHORITY["EPSG","9001"]],' +
  'AXIS["Easting",EAST],AXIS["Northing",NORTH],AUTHORITY["EPSG","32616"]]';

/* ================================================================ WKT */

describe('wkt', () => {
  const cases = [
    ['POINT (1 2)', pt(1, 2)],
    ['LINESTRING (0 0, 1 1, 2 0.5)', { type: 'LineString', coordinates: [[0, 0], [1, 1], [2, 0.5]] }],
    ['POLYGON ((0 0, 4 0, 4 4, 0 4, 0 0), (1 1, 1 2, 2 2, 1 1))',
      { type: 'Polygon', coordinates: [[[0, 0], [4, 0], [4, 4], [0, 4], [0, 0]], [[1, 1], [1, 2], [2, 2], [1, 1]]] }],
    ['MULTIPOINT ((1 2), (3 4))', { type: 'MultiPoint', coordinates: [[1, 2], [3, 4]] }],
    ['MULTILINESTRING ((0 0, 1 1), (2 2, 3 3))', { type: 'MultiLineString', coordinates: [[[0, 0], [1, 1]], [[2, 2], [3, 3]]] }],
    ['MULTIPOLYGON (((0 0, 1 0, 1 1, 0 0)), ((5 5, 6 5, 6 6, 5 5), (5.2 5.1, 5.8 5.1, 5.8 5.7, 5.2 5.1)))', {
      type: 'MultiPolygon',
      coordinates: [[[[0, 0], [1, 0], [1, 1], [0, 0]]], [[[5, 5], [6, 5], [6, 6], [5, 5]], [[5.2, 5.1], [5.8, 5.1], [5.8, 5.7], [5.2, 5.1]]]],
    }],
    ['GEOMETRYCOLLECTION (POINT (1 2), LINESTRING (0 0, 1 1), GEOMETRYCOLLECTION (POINT (5 6)))', {
      type: 'GeometryCollection',
      geometries: [pt(1, 2), { type: 'LineString', coordinates: [[0, 0], [1, 1]] }, { type: 'GeometryCollection', geometries: [pt(5, 6)] }],
    }],
    ['POINT Z (1 2 3)', pt(1, 2, 3)],
    ['LINESTRING Z (0 0 10, 1 1 20)', { type: 'LineString', coordinates: [[0, 0, 10], [1, 1, 20]] }],
    ['MULTIPOLYGON Z (((0 0 1, 1 0 1, 1 1 1, 0 0 1)))', { type: 'MultiPolygon', coordinates: [[[[0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 0, 1]]]] }],
    ['GEOMETRYCOLLECTION Z (POINT Z (1 2 3), LINESTRING Z (0 0 0, 1 1 1))', {
      type: 'GeometryCollection', geometries: [pt(1, 2, 3), { type: 'LineString', coordinates: [[0, 0, 0], [1, 1, 1]] }],
    }],
  ];

  test('parses and round-trips every geometry type', () => {
    for (const [text, geom] of cases) {
      assert.deepEqual(F.wkt.parse(text), geom, text);
      assert.equal(F.wkt.stringify(geom), text);
      assert.deepEqual(F.wkt.parse(F.wkt.stringify(geom)), geom);
    }
  });

  test('EMPTY geometries', () => {
    for (const type of ['Point', 'LineString', 'Polygon', 'MultiPoint', 'MultiLineString', 'MultiPolygon']) {
      const text = type.toUpperCase() + ' EMPTY';
      const g = F.wkt.parse(text);
      assert.deepEqual(g, { type, coordinates: [] });
      assert.equal(F.wkt.stringify(g), text);
    }
    assert.deepEqual(F.wkt.parse('GEOMETRYCOLLECTION EMPTY'), { type: 'GeometryCollection', geometries: [] });
    assert.equal(F.wkt.stringify({ type: 'GeometryCollection', geometries: [] }), 'GEOMETRYCOLLECTION EMPTY');
    assert.deepEqual(F.wkt.parse('POINT Z EMPTY'), { type: 'Point', coordinates: [] });
    // Empty members of multi-geometries are dropped; empty collection members are kept.
    assert.deepEqual(F.wkt.parse('MULTIPOINT (EMPTY, (1 2))'), { type: 'MultiPoint', coordinates: [[1, 2]] });
    assert.deepEqual(F.wkt.parse('MULTILINESTRING (EMPTY, (0 0, 1 1))'), { type: 'MultiLineString', coordinates: [[[0, 0], [1, 1]]] });
    const gc = F.wkt.parse('GEOMETRYCOLLECTION (POINT EMPTY, POINT (1 2))');
    assert.deepEqual(gc.geometries, [{ type: 'Point', coordinates: [] }, pt(1, 2)]);
    assert.equal(F.wkt.stringify(gc), 'GEOMETRYCOLLECTION (POINT EMPTY, POINT (1 2))');
  });

  test('MULTIPOINT without inner parentheses', () => {
    assert.deepEqual(F.wkt.parse('MULTIPOINT (1 2, 3 4)'), { type: 'MultiPoint', coordinates: [[1, 2], [3, 4]] });
    assert.deepEqual(F.wkt.parse('MULTIPOINT Z (1 2 3, 4 5 6)'), { type: 'MultiPoint', coordinates: [[1, 2, 3], [4, 5, 6]] });
  });

  test('Z, M and ZM: Z is kept, M is dropped', () => {
    assert.deepEqual(F.wkt.parse('POINT M (1 2 9)'), pt(1, 2));
    assert.deepEqual(F.wkt.parse('POINT ZM (1 2 3 9)'), pt(1, 2, 3));
    assert.deepEqual(F.wkt.parse('POINTZM (1 2 3 9)'), pt(1, 2, 3));
    assert.deepEqual(F.wkt.parse('POINTZ(1 2 3)'), pt(1, 2, 3));
    assert.deepEqual(F.wkt.parse('LINESTRINGM (0 0 5, 1 1 6)'), { type: 'LineString', coordinates: [[0, 0], [1, 1]] });
    assert.deepEqual(F.wkt.parse('LINESTRING ZM (0 0 1 5, 1 1 2 6)'), { type: 'LineString', coordinates: [[0, 0, 1], [1, 1, 2]] });
    // Undeclared dimensions: 3 numbers = XYZ, 4 numbers = XYZM
    assert.deepEqual(F.wkt.parse('POINT (1 2 3)'), pt(1, 2, 3));
    assert.deepEqual(F.wkt.parse('POINT (1 2 3 4)'), pt(1, 2, 3));
  });

  test('EWKT SRID prefix, case and whitespace tolerance', () => {
    assert.deepEqual(F.wkt.parse('SRID=4326;POINT(1 2)'), pt(1, 2));
    assert.deepEqual(F.wkt.parse('  srid = 3857 ;\n point ( -1.5e3\t2.5E-2 ) '), pt(-1500, 0.025));
    assert.deepEqual(F.wkt.parse('MultiPolygon(((0 0,1 0,1 1,0 0)))'), { type: 'MultiPolygon', coordinates: [[[[0, 0], [1, 0], [1, 1], [0, 0]]]] });
    assert.deepEqual(F.wkt.parse('linestring\n(\n0 0 ,\n+1 .5\n)'), { type: 'LineString', coordinates: [[0, 0], [1, 0.5]] });
  });

  test('precision option and number formatting', () => {
    assert.equal(F.wkt.stringify(pt(1.23456789, -0.000012345), { precision: 3 }), 'POINT (1.235 0)');
    assert.equal(F.wkt.stringify(pt(10, 20), { precision: 6 }), 'POINT (10 20)');
    assert.equal(F.wkt.stringify(pt(-0, 0.1 + 0.2)), 'POINT (0 0.30000000000000004)');
    // Z only when every position has one
    assert.equal(F.wkt.stringify({ type: 'LineString', coordinates: [[0, 0, 1], [1, 1]] }), 'LINESTRING (0 0, 1 1)');
    assert.equal(F.wkt.stringify({ type: 'Feature', geometry: pt(1, 2), properties: {} }), 'POINT (1 2)');
  });

  test('clear errors', () => {
    const bad = [
      ['', /empty/],
      ['POINT (1)', /Invalid WKT: expected a coordinate/],
      ['POINT (1 2', /expected "\)" but found the end of the text/],
      ['POINT 1 2', /expected "\("/],
      ['FOO (1 2)', /unknown geometry type "FOO"/],
      ['POINT (1 2) extra', /after the end of the geometry/],
      ['POINT (1 2 3 4 5)', /more than 4 numbers/],
      ['POLYGON ((0 0, 1 1)', /expected "\)"/],
      ['POINT (1 $)', /unexpected character "\$"/],
      ['CIRCULARSTRING (0 0, 1 1, 2 0)', /CIRCULARSTRING .*not supported/],
    ];
    for (const [text, re] of bad) assert.throws(() => F.wkt.parse(text), re, text);
    assert.throws(() => F.wkt.parse(42), /text/);
    assert.throws(() => F.wkt.stringify(null), /No geometry/);
    assert.throws(() => F.wkt.stringify({ type: 'Circle', coordinates: [0, 0] }), /Unsupported geometry type "Circle"/);
  });
});

/* ================================================================ WKB */

describe('wkb', () => {
  const geoms = [
    pt(1, 2),
    pt(-87.6, 41.8, 180),
    { type: 'LineString', coordinates: [[0, 0], [1, 1], [2, 0]] },
    { type: 'Polygon', coordinates: [[[0, 0], [4, 0], [4, 4], [0, 0]], [[1, 1], [2, 1], [2, 2], [1, 1]]] },
    { type: 'MultiPoint', coordinates: [[1, 2], [3, 4]] },
    { type: 'MultiLineString', coordinates: [[[0, 0], [1, 1]], [[2, 2], [3, 3], [4, 4]]] },
    { type: 'MultiPolygon', coordinates: [[[[0, 0], [1, 0], [1, 1], [0, 0]]], [[[5, 5], [6, 5], [6, 6], [5, 5]]]] },
    { type: 'MultiPolygon', coordinates: [[[[0, 0, 7], [1, 0, 7], [1, 1, 7], [0, 0, 7]]]] },
    { type: 'GeometryCollection', geometries: [pt(1, 2), { type: 'LineString', coordinates: [[0, 0], [1, 1]] }] },
  ];

  test('known hex vectors', () => {
    assert.equal(F.wkb.toHex(F.wkb.write(pt(1, 2))), '0101000000000000000000F03F0000000000000040');
    assert.equal(F.wkb.toHex(F.wkb.write(pt(1, 2), { littleEndian: false })), '00000000013FF00000000000004000000000000000');
    assert.equal(F.wkb.toHex(F.wkb.write({ type: 'MultiPoint', coordinates: [[1, 2], [3, 4]] })),
      '0104000000020000000101000000000000000000F03F0000000000000040010100000000000000000008400000000000001040');
    assert.equal(F.wkb.toHex(F.wkb.write(pt(1, 2, 3))), '01E9030000000000000000F03F00000000000000400000000000000840');
    const le = F.wkb.parse(F.wkb.fromHex('0101000000000000000000F03F0000000000000040'));
    assert.deepEqual(le, { geometry: pt(1, 2), bytesRead: 21 });
    const be = F.wkb.parse(F.wkb.fromHex('00000000013FF00000000000004000000000000000'));
    assert.deepEqual(be, { geometry: pt(1, 2), bytesRead: 21 });
  });

  test('round-trips every type in both byte orders', () => {
    for (const g of geoms) {
      for (const littleEndian of [true, false]) {
        const bytes = F.wkb.write(g, { littleEndian });
        assert.ok(bytes instanceof Uint8Array);
        const r = F.wkb.parse(bytes);
        assert.deepEqual(r.geometry, g, JSON.stringify(g));
        assert.equal(r.bytesRead, bytes.length);
      }
    }
  });

  test('EWKB with SRID and Z/M flags', () => {
    // PostGIS: SRID=4326;POINT(1 2)
    const a = F.wkb.parse(F.wkb.fromHex('0101000020E6100000000000000000F03F0000000000000040'));
    assert.deepEqual(a, { geometry: pt(1, 2), bytesRead: 25, srid: 4326 });
    // SRID=4326;POINT Z (1 2 3)
    const b = F.wkb.parse(F.wkb.fromHex('01010000A0E6100000000000000000F03F00000000000000400000000000000840'));
    assert.deepEqual(b.geometry, pt(1, 2, 3));
    assert.equal(b.srid, 4326);
    // EWKB M flag (0x40000001): measure dropped
    const c = F.wkb.parse(F.wkb.fromHex('0101000040000000000000F03F00000000000000400000000000002240'));
    assert.deepEqual(c.geometry, pt(1, 2));
    // Big-endian EWKB linestring with SRID 3857
    const d = F.wkb.parse(F.wkb.fromHex('0020000002000010110000000200000000000000000000000000000000' + '3FF00000000000003FF0000000000000'));
    assert.deepEqual(d.geometry, { type: 'LineString', coordinates: [[0, 0], [1, 1]] });
    assert.equal(d.srid, 4113);
  });

  test('ISO M and ZM codes', () => {
    const buf = new ArrayBuffer(5 + 32);
    const dv = new DataView(buf);
    dv.setUint8(0, 1);
    dv.setUint32(1, 3001, true); // POINT ZM
    [1, 2, 3, 4].forEach((v, i) => dv.setFloat64(5 + 8 * i, v, true));
    assert.deepEqual(F.wkb.parse(buf).geometry, pt(1, 2, 3));
    dv.setUint32(1, 2001, true); // POINT M (reads 3 ordinates)
    const r = F.wkb.parse(buf);
    assert.deepEqual(r.geometry, pt(1, 2));
    assert.equal(r.bytesRead, 29);
  });

  test('offset, ArrayBuffer input and concatenated geometries', () => {
    const a = F.wkb.write(pt(5, 6));
    const b = F.wkb.write({ type: 'LineString', coordinates: [[0, 0], [1, 1]] }, { littleEndian: false });
    const all = new Uint8Array(3 + a.length + b.length);
    all.set([9, 9, 9]);
    all.set(a, 3);
    all.set(b, 3 + a.length);
    const first = F.wkb.parse(all.buffer, 3);
    assert.deepEqual(first.geometry, pt(5, 6));
    const second = F.wkb.parse(all, 3 + first.bytesRead);
    assert.deepEqual(second.geometry, { type: 'LineString', coordinates: [[0, 0], [1, 1]] });
    assert.equal(3 + first.bytesRead + second.bytesRead, all.length);
  });

  test('Z is written only when every position has one', () => {
    const mixed = { type: 'LineString', coordinates: [[0, 0, 5], [1, 1]] };
    const bytes = F.wkb.write(mixed);
    assert.equal(new DataView(bytes.buffer).getUint32(1, true), 2);
    assert.deepEqual(F.wkb.parse(bytes).geometry, { type: 'LineString', coordinates: [[0, 0], [1, 1]] });
  });

  test('POINT EMPTY is NaN NaN', () => {
    const bytes = F.wkb.write({ type: 'Point', coordinates: [] });
    assert.equal(F.wkb.toHex(bytes), '0101000000000000000000F87F000000000000F87F');
    assert.deepEqual(F.wkb.parse(bytes).geometry, { type: 'Point', coordinates: [] });
  });

  test('errors', () => {
    assert.throws(() => F.wkb.parse(new Uint8Array([1, 1, 0, 0])), /ends unexpectedly/);
    assert.throws(() => F.wkb.parse(F.wkb.fromHex('0101000000000000000000F03F')), /ends unexpectedly/);
    assert.throws(() => F.wkb.parse(F.wkb.fromHex('0108000000')), /CircularString .*not supported/);
    assert.throws(() => F.wkb.parse(F.wkb.fromHex('0263000000')), /byte-order/);
    assert.throws(() => F.wkb.parse('0101'), /binary/);
    assert.throws(() => F.wkb.fromHex('0x12'), /hex/);
    assert.throws(() => F.wkb.write(null), /No geometry/);
  });
});

/* ========================================================= GeoPackage */

function gpBlob(geom, srsId, opts) {
  opts = opts || {};
  const le = opts.littleEndian !== false;
  const body = F.wkb.write(geom, { littleEndian: le });
  const envelope = opts.envelope !== false;
  const out = new Uint8Array(8 + (envelope ? 32 : 0) + body.length);
  const dv = new DataView(out.buffer);
  out.set([0x47, 0x50, 0, (opts.empty ? 0x10 : 0) | ((envelope ? 1 : 0) << 1) | (le ? 1 : 0)]);
  dv.setInt32(4, srsId, le);
  if (envelope) {
    const b = M.util.bbox(geom) || [NaN, NaN, NaN, NaN];
    [b[0], b[2], b[1], b[3]].forEach((v, i) => dv.setFloat64(8 + 8 * i, v, le));
  }
  out.set(body, 8 + (envelope ? 32 : 0));
  return out;
}

function sqlAll(db, sql, params) {
  const st = db.prepare(sql);
  if (params) st.bind(params);
  const rows = [];
  while (st.step()) rows.push(st.getAsObject());
  st.free();
  return rows;
}

describe('gpkg', () => {
  const points = fc([
    feat(pt(-87.6, 41.8), { name: 'Chicago ✓', pop: 2700000, ratio: 0.5, ok: true, day: '2020-01-02', ts: '2020-01-02T10:11:12Z', tags: { a: [1, 2] }, 'Weird Name!': 'x', geom: 'clash', FID: 9 }),
    feat(null, { name: null, pop: 3, ratio: null, ok: false, day: null, ts: null, tags: null }),
    feat(pt(-87.7, 41.9, 180), { name: 'Évanston 北', pop: null, ratio: 1.25, ok: null, day: '2021-05-06', ts: '2021-05-06T01:02:03', tags: ['x'] }),
  ]);
  const polys = fc([
    feat({ type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]] }, { id: 1 }),
    feat({ type: 'MultiPolygon', coordinates: [[[[2, 2], [3, 2], [3, 3], [2, 2]]], [[[4, 4], [5, 4], [5, 5], [4, 4]]]] }, { id: 2 }),
  ]);
  const mixed = fc([
    feat(pt(10, 10), { kind: 'p' }),
    feat({ type: 'LineString', coordinates: [[0, 0], [20, 5]] }, { kind: 'l' }),
    feat({ type: 'GeometryCollection', geometries: [pt(1, 1)] }, { kind: 'gc' }),
  ]);
  const table = fc([feat(null, { k: 'a', n: 1 }), feat(null, { k: 'b', n: 2 })]);

  test('write -> read round trip (types, nulls, unicode, booleans, dates, JSON)', () => {
    const bytes = F.gpkg.write([
      { name: 'My Points', fc: points },
      { name: 'my points', fc: polys },
      { name: 'mixed', fc: mixed },
      { name: 'table', fc: table },
    ], SQL);
    assert.ok(bytes instanceof Uint8Array);
    const layers = F.gpkg.read(bytes, SQL);
    assert.deepEqual(layers.map((l) => l.name), ['My_Points', 'my_points_2', 'mixed', 'table']);

    const [p, q, m, t] = layers;
    assert.equal(p.geometryType, 'POINT');
    assert.equal(p.srsId, 4326);
    assert.equal(p.crs, 'EPSG:4326');
    assert.deepEqual(p.warnings, []);
    assert.deepEqual(p.fields, [
      { name: 'name', type: 'string' }, { name: 'pop', type: 'number' }, { name: 'ratio', type: 'number' },
      { name: 'ok', type: 'boolean' }, { name: 'day', type: 'date' }, { name: 'ts', type: 'date' },
      { name: 'tags', type: 'object' }, { name: 'Weird_Name', type: 'string' }, { name: 'geom_2', type: 'string' },
      { name: 'FID_2', type: 'number' },
    ]);
    assert.deepEqual(p.fc.features.map((f) => f.geometry), [pt(-87.6, 41.8), null, pt(-87.7, 41.9, 180)]);
    assert.deepEqual(p.fc.features[0].properties, {
      name: 'Chicago ✓', pop: 2700000, ratio: 0.5, ok: true, day: '2020-01-02', ts: '2020-01-02T10:11:12.000Z',
      tags: { a: [1, 2] }, Weird_Name: 'x', geom_2: 'clash', FID_2: 9,
    });
    assert.deepEqual(p.fc.features[1].properties, {
      name: null, pop: 3, ratio: null, ok: false, day: null, ts: null, tags: null, Weird_Name: null, geom_2: null, FID_2: null,
    });
    assert.equal(p.fc.features[2].properties.name, 'Évanston 北');
    assert.equal(p.fc.features[2].properties.ok, null);
    assert.equal(p.fc.features[2].properties.ts, '2021-05-06T01:02:03');
    assert.deepEqual(p.fc.features[2].properties.tags, ['x']);
    assert.equal(p.fc.features[0].id, undefined);

    // Polygon + MultiPolygon -> MULTIPOLYGON (singles promoted)
    assert.equal(q.geometryType, 'MULTIPOLYGON');
    assert.deepEqual(q.fc.features[0].geometry, { type: 'MultiPolygon', coordinates: [polys.features[0].geometry.coordinates] });
    assert.deepEqual(q.fc.features[1].geometry, polys.features[1].geometry);

    assert.equal(m.geometryType, 'GEOMETRY');
    assert.deepEqual(m.fc.features.map((f) => f.geometry.type), ['Point', 'LineString', 'GeometryCollection']);

    // Geometry-less layers become attribute tables
    assert.equal(t.geometryType, null);
    assert.equal(t.crs, null);
    assert.equal(t.srsId, null);
    assert.deepEqual(t.fc.features.map((f) => [f.geometry, f.properties]), [[null, { k: 'a', n: 1 }], [null, { k: 'b', n: 2 }]]);
  });

  test('file structure follows GeoPackage 1.3', () => {
    const bytes = F.gpkg.write([{ name: 'pts', fc: points }, { name: 'gpkg_contents', fc: polys }, { name: 'table', fc: table }], SQL);
    assert.equal(new TextDecoder().decode(bytes.subarray(0, 16)), 'SQLite format 3\u0000');
    const db = new SQL.Database(bytes);
    try {
      assert.equal(db.exec('PRAGMA application_id')[0].values[0][0], 0x47504b47);
      assert.equal(db.exec('PRAGMA user_version')[0].values[0][0], 10300);
      assert.deepEqual(sqlAll(db, 'SELECT srs_id, organization, organization_coordsys_id FROM gpkg_spatial_ref_sys ORDER BY srs_id'), [
        { srs_id: -1, organization: 'NONE', organization_coordsys_id: -1 },
        { srs_id: 0, organization: 'NONE', organization_coordsys_id: 0 },
        { srs_id: 4326, organization: 'EPSG', organization_coordsys_id: 4326 },
      ]);
      const contents = sqlAll(db, 'SELECT * FROM gpkg_contents ORDER BY table_name');
      assert.deepEqual(contents.map((c) => [c.table_name, c.data_type, c.identifier, c.srs_id]), [
        ['layer_gpkg_contents', 'features', 'gpkg_contents', 4326],
        ['pts', 'features', 'pts', 4326],
        ['table', 'attributes', 'table', null],
      ]);
      const ptsRow = contents.find((c) => c.table_name === 'pts');
      assert.deepEqual([ptsRow.min_x, ptsRow.min_y, ptsRow.max_x, ptsRow.max_y], [-87.7, 41.8, -87.6, 41.9]);
      assert.match(ptsRow.last_change, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      assert.deepEqual(sqlAll(db, 'SELECT * FROM gpkg_geometry_columns ORDER BY table_name'), [
        { table_name: 'layer_gpkg_contents', column_name: 'geom', geometry_type_name: 'MULTIPOLYGON', srs_id: 4326, z: 0, m: 0 },
        { table_name: 'pts', column_name: 'geom', geometry_type_name: 'POINT', srs_id: 4326, z: 2, m: 0 },
      ]);
      const cols = sqlAll(db, 'PRAGMA table_info("pts")').map((c) => [c.name, c.type, c.pk]);
      assert.deepEqual(cols, [
        ['fid', 'INTEGER', 1], ['geom', 'POINT', 0], ['name', 'TEXT', 0], ['pop', 'INTEGER', 0], ['ratio', 'REAL', 0],
        ['ok', 'BOOLEAN', 0], ['day', 'DATE', 0], ['ts', 'DATETIME', 0], ['tags', 'TEXT', 0], ['Weird_Name', 'TEXT', 0],
        ['geom_2', 'TEXT', 0], ['FID_2', 'INTEGER', 0],
      ]);
      assert.match(sqlAll(db, "SELECT sql FROM sqlite_master WHERE name = 'pts'")[0].sql, /"fid" INTEGER PRIMARY KEY AUTOINCREMENT/);
      // JSON columns are registered through the schema extension
      assert.deepEqual(sqlAll(db, 'SELECT table_name, column_name, mime_type FROM gpkg_data_columns'), [
        { table_name: 'pts', column_name: 'tags', mime_type: 'application/json' },
      ]);
      assert.equal(sqlAll(db, "SELECT count(*) AS n FROM gpkg_extensions WHERE extension_name = 'gpkg_schema'")[0].n, 2);
      // Geometry blobs: "GP", version 0, little-endian with an XY envelope (XYZ for 3D)
      const blobs = sqlAll(db, 'SELECT geom FROM pts ORDER BY fid').map((r) => r.geom);
      assert.equal(blobs[1], null);
      const b0 = blobs[0];
      assert.deepEqual(Array.from(b0.subarray(0, 4)), [0x47, 0x50, 0, 0x03]);
      const dv0 = new DataView(b0.buffer, b0.byteOffset, b0.byteLength);
      assert.equal(dv0.getInt32(4, true), 4326);
      assert.deepEqual([0, 1, 2, 3].map((i) => dv0.getFloat64(8 + 8 * i, true)), [-87.6, -87.6, 41.8, 41.8]);
      assert.deepEqual(F.wkb.parse(b0, 40).geometry, pt(-87.6, 41.8));
      assert.equal(blobs[2][3], 0x05); // envelope code 2 (XYZ)
    } finally {
      db.close();
    }
  });

  test('reads a projected GeoPackage: reprojection, big-endian blobs, BLOB columns, tile tables', () => {
    const seed = F.gpkg.write([{ name: 'seed', fc: fc([feat(pt(0, 0), { a: 1 })]) }], SQL);
    const db = new SQL.Database(seed);
    const toUtm = M.crs.transformer('EPSG:4326', 'EPSG:32616');
    const lonlat = [[-87.6, 41.8], [-87.9, 42.1]];
    const utm = lonlat.map(toUtm);
    db.run('INSERT INTO gpkg_spatial_ref_sys VALUES (?, ?, ?, ?, ?, ?)', ['WGS 84 / UTM zone 16N', 32616, 'EPSG', 32616, WKT_32616, null]);
    db.run('CREATE TABLE "utm" ("fid" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL, "shape" LINESTRING, "label" TEXT, ' +
      '"photo" BLOB, "flag" BOOLEAN, "day" DATE, "stamp" DATETIME, "n" INTEGER, "x" MEDIUMINT, "anything")');
    db.run("INSERT INTO gpkg_contents (table_name, data_type, identifier, srs_id) VALUES ('utm', 'features', 'utm', 32616)");
    db.run("INSERT INTO gpkg_geometry_columns VALUES ('utm', 'shape', 'LINESTRING', 32616, 0, 0)");
    const line = { type: 'LineString', coordinates: utm };
    db.run('INSERT INTO utm (shape, label, photo, flag, day, stamp, n, x, anything) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [gpBlob(line, 32616, { littleEndian: false }), 'a', new Uint8Array([1, 2, 3]), 1, '2020-01-02', '2020-01-02 03:04:05', 7, 8, 'free']);
    db.run('INSERT INTO utm (shape, label, flag) VALUES (?, ?, ?)', [gpBlob({ type: 'LineString', coordinates: [] }, 32616, { empty: true, envelope: false }), 'empty', 0]);
    db.run('INSERT INTO utm (shape, label) VALUES (NULL, ?)', ['none']);
    db.run('INSERT INTO utm (shape, label) VALUES (?, ?)', [F.wkb.write(line), 'plain wkb']);
    db.run('INSERT INTO utm (shape, label) VALUES (?, ?)', [new Uint8Array([0x47, 0x50, 0, 1, 0, 0, 0, 0, 1, 8, 0, 0, 0]), 'curve']);
    db.run("INSERT INTO gpkg_contents (table_name, data_type, identifier) VALUES ('ortho', 'tiles', 'ortho')");
    const bytes = db.export();
    db.close();

    const layers = F.gpkg.read(bytes, SQL);
    assert.deepEqual(layers.map((l) => l.name), ['seed', 'utm']);
    assert.ok(layers[0].warnings.some((w) => /ortho/.test(w) && /tile/.test(w)), layers[0].warnings.join('\n'));
    const l = layers[1];
    assert.equal(l.crs, 'EPSG:32616');
    assert.equal(l.srsId, 32616);
    assert.equal(l.geometryType, 'LINESTRING');
    assert.deepEqual(l.fields, [
      { name: 'label', type: 'string' }, { name: 'flag', type: 'boolean' }, { name: 'day', type: 'date' },
      { name: 'stamp', type: 'date' }, { name: 'n', type: 'number' }, { name: 'x', type: 'number' }, { name: 'anything', type: 'string' },
    ]);
    assert.ok(l.warnings.some((w) => /photo/.test(w) && /binary/.test(w)), l.warnings.join('\n'));
    assert.ok(l.warnings.some((w) => /1 geometry .*could not be read/.test(w) && /CircularString/.test(w)), l.warnings.join('\n'));
    const feats = l.fc.features;
    assert.equal(feats.length, 5);
    assertCoordsClose(feats[0].geometry.coordinates, lonlat, 1e-7);
    assert.deepEqual(feats[0].properties, { label: 'a', flag: true, day: '2020-01-02', stamp: '2020-01-02T03:04:05', n: 7, x: 8, anything: 'free' });
    assert.equal(feats[1].geometry, null);
    assert.equal(feats[1].properties.flag, false);
    assert.equal(feats[2].geometry, null);
    assertCoordsClose(feats[3].geometry.coordinates, lonlat, 1e-7);
    assert.equal(feats[4].geometry, null);
  });

  test('clear errors for unusable files and coordinate systems', () => {
    assert.throws(() => F.gpkg.read(new Uint8Array(100), SQL), /not a GeoPackage/);
    assert.throws(() => F.gpkg.read(new Uint8Array(100)), /sql\.js/);
    const plain = new SQL.Database();
    plain.run('CREATE TABLE t (a)');
    const plainBytes = plain.export();
    plain.close();
    assert.throws(() => F.gpkg.read(plainBytes, SQL), /no gpkg_contents/);

    const db = new SQL.Database(F.gpkg.write([{ name: 'x', fc: fc([feat(pt(1, 1))]) }], SQL));
    db.run("INSERT INTO gpkg_spatial_ref_sys VALUES ('Mystery Grid', 999999, 'EPSG', 999999, 'undefined', NULL)");
    db.run("UPDATE gpkg_geometry_columns SET srs_id = 999999");
    const bad = db.export();
    db.close();
    assert.throws(() => F.gpkg.read(bad, SQL), /layer "x" uses the coordinate system "Mystery Grid" \(EPSG:999999\)/);

    const db2 = new SQL.Database(F.gpkg.write([{ name: 'x', fc: fc([feat(pt(1, 1))]) }], SQL));
    db2.run("UPDATE gpkg_geometry_columns SET srs_id = 12345");
    const missing = db2.export();
    db2.close();
    assert.throws(() => F.gpkg.read(missing, SQL), /coordinate system 12345, which is not defined/);

    const db3 = new SQL.Database(F.gpkg.write([{ name: 'x', fc: fc([feat(pt(1, 1))]) }], SQL));
    db3.run("DELETE FROM gpkg_contents");
    db3.run("INSERT INTO gpkg_contents (table_name, data_type, identifier) VALUES ('tiles1', 'tiles', 'tiles1')");
    const tilesOnly = db3.export();
    db3.close();
    assert.throws(() => F.gpkg.read(tilesOnly, SQL), /no vector layers .*tiles1/);

    assert.throws(() => F.gpkg.write([], SQL), /no layers/);
    assert.throws(() => F.gpkg.write([{ name: 'x', fc: null }], SQL), /Layer "x" has no features/);
  });

  test('layers that cannot be queried are skipped with a warning', () => {
    const db = new SQL.Database(F.gpkg.write([{ name: 'pts', fc: fc([feat(pt(1, 1), { a: 1 })]) }], SQL));
    // GDAL-style views may call SpatiaLite functions that sql.js does not provide.
    db.run('CREATE VIEW "v" AS SELECT fid, geom, ST_MinX(geom) AS mx FROM pts');
    db.run("INSERT INTO gpkg_contents (table_name, data_type, identifier, srs_id) VALUES ('v', 'features', 'v', 4326)");
    db.run("INSERT INTO gpkg_geometry_columns VALUES ('v', 'geom', 'POINT', 4326, 0, 0)");
    const bytes = db.export();
    db.close();
    const layers = F.gpkg.read(bytes, SQL);
    assert.deepEqual(layers.map((l) => l.name), ['pts']);
    assert.ok(layers[0].warnings.some((w) => /Could not read "v"/.test(w) && /ST_MinX/.test(w)), layers[0].warnings.join('\n'));
  });

  test('undefined SRS is assumed to be WGS 84 with a warning', () => {
    const db = new SQL.Database(F.gpkg.write([{ name: 'x', fc: fc([feat(pt(1000, 2000))]) }], SQL));
    db.run('UPDATE gpkg_geometry_columns SET srs_id = -1');
    const bytes = db.export();
    db.close();
    const [l] = F.gpkg.read(bytes, SQL);
    assert.equal(l.crs, 'EPSG:4326');
    assert.ok(l.warnings.some((w) => /undefined coordinate system/.test(w) && /do not look like longitude\/latitude/.test(w)));
  });
});

/* ========================================================== Shapefile */

describe('shapefile', () => {
  const people = fc([
    feat(pt(-87.6, 41.8), { name: 'Ada ✓', count: 3, share: 0.25, active: true, born: '1815-12-10', population_2020: 1, population_2010: 2 }),
    feat(null, { name: 'nobody', count: null, share: null, active: false, born: null, population_2020: null, population_2010: null }),
    feat(pt(-87.7, 41.9), { name: 'Émile', count: -12, share: 1234.5, active: null, born: '2001-02-03T04:05:06Z', population_2020: 3, population_2010: 4 }),
  ]);

  test('writes all five files with consistent headers', async () => {
    const { bytes, warnings } = await F.shapefile.write(people, { name: 'people' });
    const files = await unzip(bytes);
    assert.deepEqual(Object.keys(files).sort(), ['people.cpg', 'people.dbf', 'people.prj', 'people.shp', 'people.shx']);
    assert.equal(new TextDecoder().decode(files['people.cpg']), 'UTF-8');
    assert.equal(new TextDecoder().decode(files['people.prj']), M.crs.WKT_4326);

    const shpBytes = files['people.shp'];
    const shp = new DataView(shpBytes.buffer, shpBytes.byteOffset, shpBytes.byteLength);
    assert.equal(shp.getInt32(0, false), 9994);
    assert.equal(shp.getInt32(24, false) * 2, shpBytes.length);
    assert.equal(shp.getInt32(28, true), 1000);
    assert.equal(shp.getInt32(32, true), 1); // POINT
    assert.deepEqual([36, 44, 52, 60].map((o) => shp.getFloat64(o, true)), [-87.7, 41.8, -87.6, 41.9]);
    // Records: Point, Null, Point
    let off = 100;
    const types = [];
    for (let i = 0; i < 3; i++) {
      assert.equal(shp.getInt32(off, false), i + 1);
      const len = shp.getInt32(off + 4, false) * 2;
      types.push(shp.getInt32(off + 8, true));
      off += 8 + len;
    }
    assert.equal(off, shpBytes.length);
    assert.deepEqual(types, [1, 0, 1]);

    const shxBytes = files['people.shx'];
    const shx = new DataView(shxBytes.buffer, shxBytes.byteOffset, shxBytes.byteLength);
    assert.equal(shxBytes.length, 100 + 8 * 3);
    assert.equal(shx.getInt32(24, false) * 2, shxBytes.length);
    assert.deepEqual([0, 1, 2].map((i) => shx.getInt32(100 + 8 * i, false) * 2), [100, 128, 140]);
    assert.deepEqual([0, 1, 2].map((i) => shx.getInt32(104 + 8 * i, false)), [10, 2, 10]);

    const dbfBytes = files['people.dbf'];
    const dbf = new DataView(dbfBytes.buffer, dbfBytes.byteOffset, dbfBytes.byteLength);
    assert.equal(dbfBytes[0], 0x03);
    assert.equal(dbf.getUint32(4, true), 3);
    const nFields = 7;
    const headerLength = dbf.getUint16(8, true);
    const recordLength = dbf.getUint16(10, true);
    assert.equal(headerLength, 32 + 32 * nFields + 1);
    assert.equal(dbfBytes[headerLength - 1], 0x0d);
    assert.equal(dbfBytes.length, headerLength + 3 * recordLength + 1);
    assert.equal(dbfBytes[dbfBytes.length - 1], 0x1a);
    const fields = [];
    let sum = 1;
    for (let i = 0; i < nFields; i++) {
      const o = 32 + 32 * i;
      const name = new TextDecoder().decode(dbfBytes.subarray(o, o + 11)).replace(/\0+$/, '');
      fields.push([name, String.fromCharCode(dbfBytes[o + 11]), dbfBytes[o + 16], dbfBytes[o + 17]]);
      sum += dbfBytes[o + 16];
    }
    assert.equal(recordLength, sum);
    assert.deepEqual(fields, [
      ['name', 'C', 7, 0], // "Ada ✓" and "Émile" are 7 and 6 UTF-8 bytes
      ['count', 'N', 18, 0],
      ['share', 'N', 7, 2],
      ['active', 'L', 1, 0],
      ['born', 'D', 8, 0],
      ['population', 'N', 18, 0],
      ['populati_1', 'N', 18, 0],
    ]);
    assert.ok(warnings.some((w) => /"population_2020" → "population"/.test(w) && /"population_2010" → "populati_1"/.test(w)), warnings.join('\n'));
    assert.ok(warnings.some((w) => /"born".*times were dropped/.test(w)), warnings.join('\n'));
  });

  test('round-trips through shpjs', async () => {
    const { bytes } = await F.shapefile.write(people, { name: 'people' });
    const back = await shp(bytes);
    assert.equal(back.features.length, 3);
    assertGeomClose(back.features[0].geometry, pt(-87.6, 41.8));
    assert.equal(back.features[1].geometry, null);
    assertGeomClose(back.features[2].geometry, pt(-87.7, 41.9));
    const p0 = back.features[0].properties;
    assert.equal(p0.name, 'Ada ✓');
    assert.equal(p0.count, 3);
    assert.equal(p0.share, 0.25);
    assert.equal(p0.active, true);
    assert.equal(p0.population, 1);
    assert.equal(p0.populati_1, 2);
    assert.ok(p0.born instanceof Date);
    assert.deepEqual([p0.born.getFullYear(), p0.born.getMonth(), p0.born.getDate()], [1815, 11, 10]);
    const p1 = back.features[1].properties;
    assert.equal(p1.name, 'nobody');
    assert.ok(Number.isNaN(p1.count)); // blank numeric
    assert.equal(p1.active, false);
    const p2 = back.features[2].properties;
    assert.equal(p2.name, 'Émile');
    assert.equal(p2.count, -12);
    assert.equal(p2.share, 1234.5);
    assert.deepEqual([p2.born.getFullYear(), p2.born.getMonth(), p2.born.getDate()], [2001, 1, 3]);
  });

  test('polygon rings: outer clockwise, holes counter-clockwise, whatever the input winding', async () => {
    const ccwOuter = [[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]];
    const cwHole = [[2, 2], [2, 4], [4, 4], [4, 2], [2, 2]];
    const reversed = (r) => r.slice().reverse();
    const input = fc([
      feat({ type: 'Polygon', coordinates: [ccwOuter, cwHole] }, { id: 1 }), // RFC 7946 winding
      feat({ type: 'Polygon', coordinates: [reversed(ccwOuter), reversed(cwHole)] }, { id: 2 }), // opposite winding
      feat({ type: 'MultiPolygon', coordinates: [[[[20, 0], [30, 0], [30, 10], [20, 0]]], [[[40, 0], [50, 0], [50, 10], [40, 0]]]] }, { id: 3 }),
      feat({ type: 'Polygon', coordinates: [[[60, 0], [70, 0], [70, 10]]] }, { id: 4 }), // unclosed ring gets closed
    ]);
    const { bytes } = await F.shapefile.write(input, { name: 'rings' });
    const files = await unzip(bytes);
    const buf = files['rings.shp'];
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    assert.equal(dv.getInt32(32, true), 5); // POLYGON
    let off = 100;
    const recordRings = [];
    while (off < buf.length) {
      const len = dv.getInt32(off + 4, false) * 2;
      const c = off + 8;
      const nParts = dv.getInt32(c + 36, true), nPoints = dv.getInt32(c + 40, true);
      const starts = [];
      for (let i = 0; i < nParts; i++) starts.push(dv.getInt32(c + 44 + 4 * i, true));
      starts.push(nPoints);
      const ptsAt = c + 44 + 4 * nParts;
      const rings = [];
      for (let i = 0; i < nParts; i++) {
        const ring = [];
        for (let k = starts[i]; k < starts[i + 1]; k++) ring.push([dv.getFloat64(ptsAt + 16 * k, true), dv.getFloat64(ptsAt + 16 * k + 8, true)]);
        rings.push(ring);
      }
      recordRings.push(rings);
      off += 8 + len;
    }
    for (const rings of recordRings.slice(0, 2)) {
      assert.equal(rings.length, 2);
      assert.ok(signedArea(rings[0]) < 0, 'outer ring must be clockwise');
      assert.ok(signedArea(rings[1]) > 0, 'hole must be counter-clockwise');
    }
    assert.equal(recordRings[2].length, 2);
    recordRings[2].forEach((r) => assert.ok(signedArea(r) < 0));
    assert.deepEqual(recordRings[3][0][0], recordRings[3][0][3]);

    const back = await shp(bytes);
    assert.deepEqual(back.features.map((f) => f.geometry.type), ['Polygon', 'Polygon', 'MultiPolygon', 'Polygon']);
    assert.equal(back.features[0].geometry.coordinates.length, 2);
    assert.equal(back.features[2].geometry.coordinates.length, 2);
  });

  test('multipart lines and multipoints', async () => {
    const lines = fc([
      feat({ type: 'MultiLineString', coordinates: [[[0, 0], [1, 1]], [[2, 2], [3, 3], [4, 2]]] }, { k: 'a' }),
      feat({ type: 'LineString', coordinates: [[5, 5], [6, 6]] }, { k: 'b' }),
    ]);
    const lineZip = (await F.shapefile.write(lines, { name: 'lines' })).bytes;
    const back = await shp(lineZip);
    assertGeomClose(back.features[0].geometry, lines.features[0].geometry);
    assertGeomClose(back.features[1].geometry, lines.features[1].geometry);
    // readZipShapefiles skips the no-op WGS 84 reprojection, so coordinates come back exactly
    const [exact] = await F.readZipShapefiles(lineZip);
    assert.deepEqual(exact.fc.features.map((f) => f.geometry), lines.features.map((f) => f.geometry));

    const mp = fc([feat({ type: 'MultiPoint', coordinates: [[1, 2], [3, 4]] }, { k: 1 }), feat(pt(5, 6), { k: 2 })]);
    const res = await F.shapefile.write(mp, { name: 'mp' });
    const files = await unzip(res.bytes);
    assert.equal(new DataView(files['mp.shp'].buffer).getInt32(32, true), 8); // MULTIPOINT
    const back2 = await shp(res.bytes);
    assertGeomClose(back2.features[0].geometry, { type: 'MultiPoint', coordinates: [[1, 2], [3, 4]] });
    assertGeomClose(back2.features[1].geometry, pt(5, 6));
  });

  test('mixed geometry types become one shapefile per family', async () => {
    const mixed = fc([
      feat(pt(1, 1), { name: 'p' }),
      feat({ type: 'LineString', coordinates: [[0, 0], [1, 1]] }, { name: 'l' }),
      feat({ type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] }, { name: 'a' }),
      feat({ type: 'GeometryCollection', geometries: [pt(2, 2), { type: 'LineString', coordinates: [[3, 3], [4, 4]] }] }, { name: 'gc' }),
      feat(null, { name: 'none' }),
    ]);
    const { bytes, warnings } = await F.shapefile.write(mixed, { name: 'mix' });
    const files = await unzip(bytes);
    for (const base of ['mix_point', 'mix_line', 'mix_polygon']) {
      for (const ext of ['shp', 'shx', 'dbf', 'prj', 'cpg']) assert.ok(files[base + '.' + ext], base + '.' + ext);
    }
    assert.ok(warnings.some((w) => /3 shapefiles/.test(w)));
    assert.ok(warnings.some((w) => /geometry collection/.test(w)));
    const layers = await shp(bytes);
    const byName = Object.fromEntries(layers.map((l) => [l.fileName, l]));
    assert.deepEqual(byName.mix_point.features.map((f) => f.properties.name), ['p', 'gc', 'none']);
    assert.equal(byName.mix_point.features[2].geometry, null);
    assert.deepEqual(byName.mix_line.features.map((f) => f.properties.name), ['l', 'gc']);
    assert.deepEqual(byName.mix_polygon.features.map((f) => f.properties.name), ['a']);
  });

  test('3D coordinates, long text, objects and odd names do not break the files', async () => {
    const long = 'é'.repeat(200); // 400 UTF-8 bytes
    const data = fc([
      feat({ type: 'LineString', coordinates: [[0, 0, 10], [1, 1, 20]] }, { 'road name': long, meta: { a: 1 }, '1st': 1.5, 'NAME': 'x', name: 'y' }),
      feat({ type: 'LineString', coordinates: [[2, 2], [3, 3]] }, { 'road name': 'short', meta: null, '1st': 2, NAME: null, name: null }),
    ]);
    const { bytes, warnings } = await F.shapefile.write(data, { name: 'roads/2020:final' });
    const files = await unzip(bytes);
    assert.ok(files['roads_2020_final.shp']);
    assert.equal(new DataView(files['roads_2020_final.shp'].buffer).getInt32(32, true), 13); // POLYLINEZ
    assert.ok(warnings.some((w) => /longer than 254 bytes/.test(w)));
    const back = await shp(bytes);
    const p = back.features[0].properties;
    assert.equal(p.road_name, 'é'.repeat(127)); // cut at a character boundary (254 bytes)
    assert.equal(p.meta, '{"a":1}');
    assert.equal(p.F1st, 1.5);
    assert.equal(p.NAME, 'x');
    assert.equal(p.name_1, 'y');
    assertCoordsClose(back.features[0].geometry.coordinates, [[0, 0, 10], [1, 1, 20]], 1e-9);
    assertCoordsClose(back.features[1].geometry.coordinates, [[2, 2, 0], [3, 3, 0]], 1e-9); // missing Z written as 0
  });

  test('no attributes and no geometry', async () => {
    const res = await F.shapefile.write(fc([feat(pt(1, 2))]));
    const back = await shp(res.bytes);
    assert.equal(back.fileName, 'layer');
    assert.deepEqual(back.features[0].properties, { FID: 1 });
    const empty = await F.shapefile.write(fc([feat(null, { a: 'x' })]), { name: 'tbl' });
    assert.ok(empty.warnings.some((w) => /no geometries/.test(w)));
    const back2 = await shp(empty.bytes);
    assert.deepEqual(back2.features.map((f) => [f.geometry, f.properties.a]), [[null, 'x']]);
  });
});

/* ========================================================== KML / GPX */

describe('kml', () => {
  const data = fc([
    feat(pt(-87.6, 41.8, 180), { name: 'Tom & Jerry <3 "quoted" \'x\'', description: 'A <b>bold</b> place', n: 1, obj: { a: 1 }, 'we"ird': null, ctrl: 'a\u0001b' }),
    feat({ type: 'LineString', coordinates: [[0, 0], [1, 1e-7]] }, { name: 'line' }),
    feat({ type: 'Polygon', coordinates: [[[0, 0], [4, 0], [4, 4], [0, 0]], [[1, 1], [2, 1], [2, 2], [1, 1]], [[3, 0.5], [3.5, 0.5], [3.5, 1], [3, 0.5]]] }, { name: 'poly' }),
    feat({ type: 'MultiPolygon', coordinates: [[[[10, 10], [11, 10], [11, 11], [10, 10]]], [[[12, 12], [13, 12], [13, 13], [12, 12]]]] }, { name: 'mpoly' }),
    feat({ type: 'MultiPoint', coordinates: [[1, 2], [3, 4]] }, { title: 'no name field' }),
    feat(null, { name: 'nowhere' }),
  ]);

  test('writes a well-formed KML 2.2 document', () => {
    const kml = F.kml.write(data, { name: 'Export & co', color: '#ff8800', fillOpacity: 0.5, lineWidth: 3 });
    assertWellFormedXml(kml);
    assert.match(kml, /^<\?xml version="1.0" encoding="UTF-8"\?>\n<kml xmlns="http:\/\/www.opengis.net\/kml\/2.2">/);
    assert.match(kml, /<Document>\n {2}<name>Export &amp; co<\/name>/);
    assert.match(kml, /<LineStyle><color>ff0088ff<\/color><width>3<\/width><\/LineStyle>/);
    assert.match(kml, /<PolyStyle><color>800088ff<\/color>/);
    assert.equal((kml.match(/<Placemark>/g) || []).length, 6);
    assert.equal((kml.match(/<styleUrl>#psicits-style<\/styleUrl>/g) || []).length, 6);
    assert.match(kml, /<name>Tom &amp; Jerry &lt;3 &quot;quoted&quot; &apos;x&apos;<\/name>/);
    assert.match(kml, /<description>A &lt;b&gt;bold&lt;\/b&gt; place<\/description>/);
    assert.match(kml, /<Data name="n"><value>1<\/value><\/Data>/);
    assert.match(kml, /<Data name="obj"><value>\{&quot;a&quot;:1\}<\/value><\/Data>/);
    assert.match(kml, /<Data name="we&quot;ird"><value><\/value><\/Data>/);
    assert.match(kml, /<Data name="ctrl"><value>ab<\/value><\/Data>/); // invalid XML characters removed
    assert.match(kml, /<Point><coordinates>-87.6,41.8,180<\/coordinates><\/Point>/);
    assert.match(kml, /<LineString><tessellate>1<\/tessellate><coordinates>0,0 1,0.0000001<\/coordinates><\/LineString>/);
    assert.equal((kml.match(/<innerBoundaryIs>/g) || []).length, 2);
    assert.match(kml, /<outerBoundaryIs><LinearRing><coordinates>0,0 4,0 4,4 0,0<\/coordinates><\/LinearRing><\/outerBoundaryIs>/);
    assert.equal((kml.match(/<MultiGeometry>/g) || []).length, 2);
    assert.ok(!/<name>no name field<\/name>/.test(kml)); // "name" wins over "title" when present in the layer
    assert.ok(!/e[+-]\d/.test(kml.replace(/<Data[\s\S]*?<\/Data>/g, '')), 'no exponent notation in coordinates');
    if (XmlDom) {
      const doc = xmldomParse(kml);
      assert.equal(doc.getElementsByTagName('Placemark').length, 6);
      assert.equal(doc.getElementsByTagName('name')[1].textContent, 'Tom & Jerry <3 "quoted" \'x\'');
    }
  });

  test('name and description fields, colors', () => {
    const k = F.kml.write(data, { nameField: 'title', descriptionField: 'n' });
    assert.match(k, /<name>no name field<\/name>/);
    assert.match(k, /<description>1<\/description>/);
    assert.match(k, /<name>PSICITS export<\/name>/);
    assert.match(F.kml.write(data, { color: 'red' }), /<LineStyle><color>ff0000ff<\/color>/);
    assert.match(F.kml.write(data, { color: 'rgba(0, 128, 255, 0.5)' }), /<LineStyle><color>80ff8000<\/color>/);
    assert.throws(() => F.kml.write(data, { color: 'blurple' }), /Unknown color "blurple"/);
    M.util.inferFields(data); // inputs are not mutated
    assert.deepEqual(data.features[0].properties.obj, { a: 1 });
  });
});

describe('gpx', () => {
  const data = fc([
    feat(pt(-87.6, 41.8, 180.5), { name: 'Start & finish', desc: 'first <wpt>', time: '2024-05-06T07:08:09Z' }),
    feat({ type: 'MultiPoint', coordinates: [[1, 2], [3, 4]] }, { name: 'pair', elevation: 12 }),
    feat({ type: 'LineString', coordinates: [[0, 0, 1], [1e-7, 1]] }, { name: 'track 1' }),
    feat({ type: 'MultiLineString', coordinates: [[[0, 0], [1, 1]], [[2, 2], [3, 3]]] }, { name: 'two segments' }),
    feat({ type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]], [[0.2, 0.1], [0.4, 0.1], [0.4, 0.2], [0.2, 0.1]]] }, { name: 'area' }),
    feat(null, { name: 'skipped' }),
  ]);

  test('writes GPX 1.1 with waypoints before tracks', () => {
    const gpx = F.gpx.write(data, { name: 'Trip' });
    assertWellFormedXml(gpx);
    assert.match(gpx, /<gpx version="1.1" creator="PSICITS" xmlns="http:\/\/www.topografix.com\/GPX\/1\/1"/);
    assert.match(gpx, /<metadata><name>Trip<\/name><\/metadata>/);
    assert.match(gpx, /<wpt lat="41.8" lon="-87.6"><ele>180.5<\/ele><time>2024-05-06T07:08:09.000Z<\/time><name>Start &amp; finish<\/name><desc>first &lt;wpt&gt;<\/desc><\/wpt>/);
    assert.match(gpx, /<wpt lat="2" lon="1"><ele>12<\/ele><name>pair<\/name><\/wpt>/);
    assert.match(gpx, /<wpt lat="4" lon="3"><ele>12<\/ele><name>pair<\/name><\/wpt>/);
    assert.equal((gpx.match(/<wpt /g) || []).length, 3);
    assert.equal((gpx.match(/<trk>/g) || []).length, 3);
    assert.ok(gpx.lastIndexOf('<wpt ') < gpx.indexOf('<trk>'));
    assert.match(gpx, /<trkpt lat="1" lon="0.0000001"\/>/);
    assert.match(gpx, /<trkpt lat="0" lon="0"><ele>1<\/ele><\/trkpt>/);
    const two = gpx.slice(gpx.indexOf('<name>two segments</name>'));
    assert.equal((two.slice(0, two.indexOf('</trk>')).match(/<trkseg>/g) || []).length, 2);
    const area = gpx.slice(gpx.indexOf('<name>area</name>'));
    assert.equal((area.slice(0, area.indexOf('</trk>')).match(/<trkpt /g) || []).length, 4); // outer ring only
    assert.ok(!/skipped/.test(gpx));
    if (XmlDom) {
      const doc = xmldomParse(gpx);
      assert.equal(doc.getElementsByTagName('trkseg').length, 4);
    }
  });

  test('nameField option', () => {
    const gpx = F.gpx.write(fc([feat(pt(1, 2), { label: 'L', name: 'N' })]), { nameField: 'label' });
    assert.match(gpx, /<name>L<\/name>/);
    assert.ok(!/<metadata>/.test(gpx));
  });
});

/* ================================================================ CSV */

describe('csv.parse', () => {
  test('BOM, CRLF, quoting and type inference', () => {
    const text = '\uFEFFname,count,ratio,zip,flag,mixed,id,note\r\n' +
      '"Smith, John",3,0.5,00123,true,1,12345678901234567890,"said ""hi""\nthen left"\r\n' +
      'Ann,-4,1e3,60601,FALSE,x,2,\r\n' +
      ',,,,,,,\r\n' +
      'Bob,,-.5,,,3,3, spaced \r\n';
    const rows = F.csv.parse(text);
    assert.deepEqual(rows, [
      { name: 'Smith, John', count: 3, ratio: 0.5, zip: '00123', flag: true, mixed: '1', id: '12345678901234567890', note: 'said "hi"\nthen left' },
      { name: 'Ann', count: -4, ratio: 1000, zip: '60601', flag: false, mixed: 'x', id: '2', note: null },
      { name: 'Bob', count: null, ratio: -0.5, zip: null, flag: null, mixed: '3', id: '3', note: ' spaced ' },
    ]);
  });

  test('delimiter detection: tab, semicolon, pipe; explicit delimiters', () => {
    assert.deepEqual(F.csv.parse('a\tb\n1\t2,5\n'), [{ a: 1, b: '2,5' }]);
    assert.deepEqual(F.csv.parse('x;y;name\n1,5;2,5;a\n3,5;4;b\n'), [{ x: '1,5', y: '2,5', name: 'a' }, { x: '3,5', y: '4', name: 'b' }]);
    assert.deepEqual(F.csv.parse('a|b\n1|2\n'), [{ a: 1, b: 2 }]);
    assert.deepEqual(F.csv.parse('a;b\n1;2\n', { delimiter: ',' }), [{ 'a;b': '1;2' }]);
    assert.deepEqual(F.csv.parse('a b\n1 2\n', { delimiter: 'tab' }), [{ 'a b': '1 2' }]);
    assert.deepEqual(F.csv.parse('a\tb\n1\t2\n', { delimiter: 'tab' }), [{ a: 1, b: 2 }]);
  });

  test('duplicate, empty and extra headers', () => {
    const rows = F.csv.parse('name,,name, value \n1,2,3,4,5\n6,7\n');
    assert.deepEqual(rows, [
      { name: 1, field_2: 2, name_2: 3, value: 4, field_5: 5 },
      { name: 6, field_2: 7, name_2: null, value: null, field_5: null },
    ]);
    assert.deepEqual(F.csv.parse('only,header\n'), []);
    assert.deepEqual(F.csv.parse(''), []);
    const proto = F.csv.parse('__proto__,b\n1,2\n');
    assert.deepEqual(proto, [{ _proto_: 1, b: 2 }]);
    assert.equal(Object.getPrototypeOf(proto[0]), Object.prototype);
  });

  test('bytes input: UTF-8 with BOM, UTF-16 and Windows-1252 fallback', () => {
    const utf8 = new TextEncoder().encode('\uFEFFcity,n\nZürich,1\n');
    assert.deepEqual(F.csv.parse(utf8), [{ city: 'Zürich', n: 1 }]);
    const latin = new Uint8Array([0x63, 0x69, 0x74, 0x79, 0x0a, 0x43, 0x61, 0x66, 0xe9, 0x0a]); // "city\nCafé" in Windows-1252
    assert.deepEqual(F.csv.parse(latin.buffer), [{ city: 'Café' }]);
    const s = 'a,b\n1,ü\n';
    const u16 = new Uint8Array(2 + s.length * 2);
    u16.set([0xff, 0xfe]);
    for (let i = 0; i < s.length; i++) { u16[2 + 2 * i] = s.charCodeAt(i) & 0xff; u16[3 + 2 * i] = s.charCodeAt(i) >> 8; }
    assert.deepEqual(F.csv.parse(u16), [{ a: 1, b: 'ü' }]);
  });
});

describe('csv.toFeatureCollection', () => {
  test('detects latitude/longitude columns by name', () => {
    const variants = [['Latitude', 'Longitude'], ['lat', 'lng'], ['LAT_DD', 'LON_DD'], ['y', 'x'], ['POINT_Y', 'POINT_X'], ['Y Coord', 'X Coord'], ['lat', 'long']];
    for (const [yName, xName] of variants) {
      const rows = [{ id: 1, [yName]: 41.8, [xName]: -87.6 }, { id: 2, [yName]: '41.9', [xName]: '-87.7' }];
      const r = F.csv.toFeatureCollection(rows);
      assert.equal(r.mode, 'xy', yName);
      assert.equal(r.xField, xName);
      assert.equal(r.yField, yName);
      assert.equal(r.skipped, 0);
      assert.equal(r.needsCrs, false);
      assert.deepEqual(r.fc.features.map((f) => f.geometry.coordinates), [[-87.6, 41.8], [-87.7, 41.9]]);
      assert.deepEqual(r.fc.features[0].properties, rows[0]);
      assert.notEqual(r.fc.features[0].properties, rows[0]); // copied, not shared
      assert.deepEqual(r.rawBBox, [-87.7, 41.8, -87.6, 41.9]);
    }
  });

  test('prefers latitude/longitude over projected X/Y columns', () => {
    const rows = [{ 'X Coordinate': 1176000, 'Y Coordinate': 1900000, Latitude: 41.88, Longitude: -87.63, Location: '(41.88, -87.63)' }];
    const r = F.csv.toFeatureCollection(rows);
    assert.equal(r.mode, 'xy');
    assert.equal(r.xField, 'Longitude');
    assert.deepEqual(r.fc.features[0].geometry.coordinates, [-87.63, 41.88]);
  });

  test('WKT, hex WKB and GeoJSON geometry columns', () => {
    const rows = [
      { id: 1, WKT: 'POLYGON ((0 0, 1 0, 1 1, 0 0))' },
      { id: 2, WKT: 'SRID=4326;POINT (5 6)' },
      { id: 3, WKT: 'not a geometry' },
      { id: 4, WKT: null },
      { id: 5, WKT: 'POINT EMPTY' },
    ];
    const r = F.csv.toFeatureCollection(rows);
    assert.equal(r.mode, 'wkt');
    assert.equal(r.wktField, 'WKT');
    assert.equal(r.skipped, 3);
    assert.deepEqual(r.fc.features.map((f) => f.geometry.type), ['Polygon', 'Point']);
    assert.deepEqual(r.fc.features[0].properties, { id: 1 });

    const hex = F.csv.toFeatureCollection([{ geom: '0101000020E6100000000000000000F03F0000000000000040' }]);
    assert.equal(hex.mode, 'wkt');
    assert.deepEqual(hex.fc.features[0].geometry, pt(1, 2));
    const gj = F.csv.toFeatureCollection([{ the_geom: '{"type":"LineString","coordinates":[[0,0],[1,1]]}' }]);
    assert.deepEqual(gj.fc.features[0].geometry, { type: 'LineString', coordinates: [[0, 0], [1, 1]] });
    // Found by content even under an unusual column name
    const odd = F.csv.toFeatureCollection([{ a: 1, footprint: 'POINT (1 2)' }]);
    assert.equal(odd.wktField, 'footprint');
  });

  test('Socrata-style location strings', () => {
    const rows = [
      { id: 1, location: '(41.8781, -87.6298)' },
      { id: 2, location: '123 MAIN ST\nCHICAGO, IL\n(41.9, -87.7)' },
      { id: 3, location: '' },
      { id: 4, location: '(95, 10)' },
    ];
    const r = F.csv.toFeatureCollection(rows);
    assert.equal(r.mode, 'latlon-string');
    assert.equal(r.xField, 'location');
    assert.equal(r.skipped, 2);
    assert.deepEqual(r.fc.features.map((f) => f.geometry.coordinates), [[-87.6298, 41.8781], [-87.7, 41.9]]);
    const bare = F.csv.toFeatureCollection([{ LatLon: '41.8, -87.6' }]);
    assert.equal(bare.mode, 'latlon-string');
    assert.deepEqual(bare.fc.features[0].geometry.coordinates, [-87.6, 41.8]);
  });

  test('projected coordinates need a CRS; a given CRS reprojects', () => {
    const rows = [{ x: 1176000, y: 1900000, name: 'a' }, { x: 1180000, y: 1905000, name: 'b' }, { x: 'n/a', y: 5, name: 'c' }];
    const r = F.csv.toFeatureCollection(rows);
    assert.equal(r.mode, 'xy');
    assert.equal(r.fc, null);
    assert.equal(r.needsCrs, true);
    assert.deepEqual(r.rawBBox, [1176000, 1900000, 1180000, 1905000]);
    assert.equal(r.skipped, 1);
    const r2 = F.csv.toFeatureCollection(rows, { crs: 'EPSG:3435' });
    assert.equal(r2.needsCrs, false);
    const [lon, lat] = r2.fc.features[0].geometry.coordinates;
    assert.ok(lon > -87.8 && lon < -87.5 && lat > 41.7 && lat < 42.0, lon + ',' + lat);
    assert.deepEqual(r2.rawBBox, r.rawBBox);
    assert.throws(() => F.csv.toFeatureCollection(rows, { crs: 'EPSG:999999' }), /Unknown coordinate system "EPSG:999999"/);
  });

  test('explicit columns, unparseable rows and plain tables', () => {
    const rows = [{ E: '12,5', N: '45.25', v: 1 }, { E: '87.6 W', N: '41.8 N', v: 2 }, { E: '', N: '1', v: 3 }];
    const r = F.csv.toFeatureCollection(rows, { x: 'e', y: 'n' });
    assert.equal(r.mode, 'xy');
    assert.equal(r.skipped, 1);
    assert.deepEqual(r.fc.features.map((f) => f.geometry.coordinates), [[12.5, 45.25], [-87.6, 41.8]]);
    assert.throws(() => F.csv.toFeatureCollection(rows, { x: 'lon', y: 'N' }), /Column "lon" was not found\. Available columns: E, N, v/);
    assert.throws(() => F.csv.toFeatureCollection(rows, { x: 'E' }), /both/);
    const plain = F.csv.toFeatureCollection([{ county: 'Cook', pop: 5 }, { county: 'Lake', pop: 7 }]);
    assert.equal(plain.mode, 'none');
    assert.equal(plain.skipped, 0);
    assert.deepEqual(plain.fc.features.map((f) => [f.geometry, f.properties.county]), [[null, 'Cook'], [null, 'Lake']]);
  });
});

describe('csv.write', () => {
  test('points default to x/y columns, other geometry to WKT, RFC 4180 quoting', () => {
    const points = fc([
      feat(pt(-87.6, 41.8), { name: 'Smith, "J"', n: 1, ok: true, obj: { a: 1 }, multi: 'line1\nline2' }),
      feat(null, { name: 'none', n: null }),
    ]);
    const csv = F.csv.write(points);
    assert.equal(csv, 'longitude,latitude,name,n,ok,obj,multi\r\n' +
      '-87.6,41.8,"Smith, ""J""",1,true,"{""a"":1}","line1\nline2"\r\n' +
      ',,none,,,,\r\n');
    const back = F.csv.toFeatureCollection(F.csv.parse(csv));
    assert.equal(back.mode, 'xy');
    assert.equal(back.skipped, 1);
    assert.deepEqual(back.fc.features[0].geometry, pt(-87.6, 41.8));
    assert.equal(back.fc.features[0].properties.name, 'Smith, "J"');
    assert.equal(back.fc.features[0].properties.multi, 'line1\nline2');

    const shapes = fc([
      feat({ type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] }, { wkt: 'clash', id: 1 }),
      feat(pt(1.123456789, 2), { id: 2 }),
    ]);
    const w = F.csv.write(shapes, { delimiter: ';', precision: 3 });
    assert.equal(w, 'wkt_2;wkt;id\r\nPOLYGON ((0 0, 1 0, 1 1, 0 0));clash;1\r\nPOINT (1.123 2);;2\r\n');
  });

  test('geometry and fields options', () => {
    const data = fc([feat(pt(1, 2, 3), { a: 1, b: 2 })]);
    assert.equal(F.csv.write(data, { geometry: 'none' }), 'a,b\r\n1,2\r\n');
    assert.equal(F.csv.write(data, { fields: ['b'] }), 'longitude,latitude,z,b\r\n1,2,3,2\r\n');
    assert.equal(F.csv.write(data, { geometry: 'wkt', fields: [{ name: 'a' }] }), 'wkt,a\r\nPOINT Z (1 2 3),1\r\n');
    assert.equal(F.csv.write(fc([feat(null, { a: 1 })])), 'a\r\n1\r\n');
    assert.throws(() => F.csv.write(data, { geometry: 'geojson' }), /Unknown CSV geometry option/);
  });
});

/* =============================================================== XLSX */

async function buildXlsx(opts) {
  opts = opts || {};
  const MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
  const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
    '</Types>');
  zip.file('_rels/.rels', '<?xml version="1.0" encoding="UTF-8"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="' + REL + '/officeDocument" Target="xl/workbook.xml"/></Relationships>');
  zip.file('xl/workbook.xml', '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<x:workbook xmlns:x="' + MAIN + '" xmlns:r="' + REL + '">' +
    (opts.date1904 ? '<x:workbookPr date1904="1"/>' : '<x:workbookPr/>') +
    '<x:sheets><x:sheet name="Sites &amp; Things" sheetId="1" r:id="rId1"/><x:sheet name="Second" sheetId="2" r:id="rId2"/>' +
    '<x:sheet name="Chart" sheetId="3" r:id="rId5"/></x:sheets></x:workbook>');
  zip.file('xl/_rels/workbook.xml.rels', '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="' + REL + '/worksheet" Target="worksheets/sheet1.xml"/>' +
    '<Relationship Id="rId2" Type="' + REL + '/worksheet" Target="/xl/worksheets/sheet2.xml"/>' +
    '<Relationship Id="rId3" Type="' + REL + '/sharedStrings" Target="sharedStrings.xml"/>' +
    '<Relationship Id="rId4" Type="' + REL + '/styles" Target="styles.xml"/>' +
    '<Relationship Id="rId5" Type="' + REL + '/chartsheet" Target="chartsheets/sheet1.xml"/>' +
    '</Relationships>');
  const strings = ['name', 'value', 'when', null, null, 'value', '', 'code', '00123'];
  zip.file('xl/sharedStrings.xml', '<?xml version="1.0" encoding="UTF-8"?>\n<sst xmlns="' + MAIN + '" count="9" uniqueCount="9">' +
    strings.map((s, i) => {
      if (i === 3) return '<si><r><rPr><b/></rPr><t>Rich </t></r><r><t xml:space="preserve">text</t></r></si>';
      if (i === 4) return '<si><t>Tom &amp; Jerry &lt;3 &#233;&#x4E2D;</t><rPh sb="0" eb="1"><t>PHONETIC</t></rPh></si>';
      return s === '' ? '<si><t/></si>' : '<si><t>' + s + '</t></si>';
    }).join('') + '</sst>');
  zip.file('xl/styles.xml', '<?xml version="1.0" encoding="UTF-8"?>\n<styleSheet xmlns="' + MAIN + '">' +
    '<numFmts count="2"><numFmt numFmtId="164" formatCode="yyyy\\-mm\\-dd\\ hh:mm"/><numFmt numFmtId="165" formatCode="&quot;Qty &quot;0.00"/></numFmts>' +
    '<cellStyleXfs count="1"><xf numFmtId="14"/></cellStyleXfs>' +
    '<cellXfs count="5"><xf numFmtId="0"/><xf numFmtId="14" applyNumberFormat="1"/><xf numFmtId="164"/><xf numFmtId="165"/><xf numFmtId="20"/></cellXfs>' +
    '</styleSheet>');
  zip.file('xl/worksheets/sheet1.xml', '<?xml version="1.0" encoding="UTF-8"?>\n<worksheet xmlns="' + MAIN + '"><sheetData>' +
    '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="D1" t="s"><v>5</v></c><c r="E1" t="s"><v>2</v></c>' +
    '<c r="F1"><v>2020</v></c><c r="G1" t="s"><v>7</v></c></row>' +
    '<row r="2"><c r="A2" t="s"><v>3</v></c><c r="B2"><v>1.5</v></c><c r="C2" t="str"><f>CONCAT("a","b")</f><v>formula text</v></c>' +
    '<c r="D2" t="b"><v>1</v></c><c r="E2" s="1"><v>43831</v></c><c r="F2" t="inlineStr"><is><t>inline</t></is></c><c r="G2" t="s"><v>8</v></c></row>' +
    '<row r="3"><c r="A3" t="s"><v>4</v></c><c r="B3" t="e"><v>#DIV/0!</v></c><c r="C3" t="s"><v>6</v></c><c r="E3" s="2"><v>43831.5</v></c>' +
    '<c r="F3" t="d"><v>2021-03-04T05:06:07Z</v></c></row>' +
    '<row r="5"><c r="A5"><v>42</v></c><c r="B5" s="3"><v>7</v></c><c r="E5" s="4"><v>0.75</v></c></row>' +
    '<row r="6"/>' +
    '<row><c t="inlineStr"><is><r><t>no</t></r><r><t>-ref</t></r></is></c><c><v>3</v></c></row>' +
    '</sheetData></worksheet>');
  zip.file('xl/worksheets/sheet2.xml', '<?xml version="1.0" encoding="UTF-8"?>\n<x:worksheet xmlns:x="' + MAIN + '"><x:sheetData>' +
    '<x:row r="3"><x:c r="B3" t="s"><x:v>0</x:v></x:c></x:row>' +
    '<x:row r="4"><x:c r="B4"><x:v>10</x:v></x:c></x:row>' +
    '</x:sheetData></x:worksheet>');
  zip.file('xl/chartsheets/sheet1.xml', '<chartsheet/>');
  return zip.generateAsync({ type: 'uint8array' });
}

describe('xlsx', () => {
  test('reads sheets, shared/rich/inline strings, types, sparse cells and dates', async () => {
    const sheets = await F.xlsx.read(await buildXlsx());
    assert.deepEqual(sheets.map((s) => s.name), ['Sites & Things', 'Second']);
    const s1 = sheets[0];
    assert.deepEqual(s1.columns, ['name', 'value', 'field_3', 'value_2', 'when', '2020', 'code']);
    assert.deepEqual(s1.rows, [
      { name: 'Rich text', value: 1.5, field_3: 'formula text', value_2: true, when: '2020-01-01', 2020: 'inline', code: '00123' },
      { name: 'Tom & Jerry <3 é中', value: null, field_3: null, value_2: null, when: '2020-01-01T12:00:00', 2020: '2021-03-04T05:06:07Z', code: null },
      { name: 42, value: 7, field_3: null, value_2: null, when: '18:00:00', 2020: null, code: null },
      { name: 'no-ref', value: 3, field_3: null, value_2: null, when: null, 2020: null, code: null },
    ]);
    assert.deepEqual(sheets[1], { name: 'Second', rows: [{ name: 10 }], columns: ['name'] });
  });

  test('1904 date system, ArrayBuffer input and errors', async () => {
    const bytes = await buildXlsx({ date1904: true });
    const sheets = await F.xlsx.read(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    assert.equal(sheets[0].rows[0].when, '2024-01-02');
    await assert.rejects(F.xlsx.read(new Uint8Array([1, 2, 3, 4])), /not a valid Excel workbook/);
    await assert.rejects(F.xlsx.read(new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0, 0])), /\.xls\) files are not supported/);
    const notBook = new JSZip();
    notBook.file('hello.txt', 'hi');
    await assert.rejects(F.xlsx.read(await notBook.generateAsync({ type: 'uint8array' })), /workbook\.xml is missing/);
  });
});

/* ============================================================ GeoTIFF */

describe('geotiff', () => {
  async function readBack(ab) {
    const tiff = await GeoTIFF.fromArrayBuffer(ab);
    const image = await tiff.getImage();
    return { image, rasters: await image.readRasters() };
  }

  test('float32, 1 band, EPSG:4326 with nodata', async () => {
    const w = 5, h = 4;
    const band = new Float32Array(w * h).map((_, i) => i * 1.25 - 3);
    band[7] = -9999;
    const ab = F.geotiff.write({
      width: w, height: h, bands: [band], bandNames: ['elevation'], noData: -9999, crs: 'EPSG:4326',
      transform: [-88, 0.25, 0, 42, 0, -0.25], bbox: [-88, 41, -86.75, 42], dataType: 'float32', stats: null, meta: {},
    });
    assert.ok(ab instanceof ArrayBuffer);
    assert.deepEqual(Array.from(new Uint8Array(ab, 0, 4)), [0x49, 0x49, 42, 0]); // little-endian "II*\0"
    const { image, rasters } = await readBack(ab);
    assert.equal(image.getWidth(), w);
    assert.equal(image.getHeight(), h);
    assert.equal(image.getSamplesPerPixel(), 1);
    assert.deepEqual(image.getBoundingBox(), [-88, 41, -86.75, 42]);
    assert.deepEqual(image.getOrigin(), [-88, 42, 0]);
    assert.deepEqual(image.getResolution(), [0.25, -0.25, 0]);
    const keys = image.getGeoKeys();
    assert.equal(keys.GTModelTypeGeoKey, 2);
    assert.equal(keys.GTRasterTypeGeoKey, 1);
    assert.equal(keys.GeographicTypeGeoKey, 4326);
    assert.equal(keys.ProjectedCSTypeGeoKey, undefined);
    assert.equal(keys.GTCitationGeoKey, 'WGS 84');
    assert.equal(image.getGDALNoData(), -9999);
    assert.ok(rasters[0] instanceof Float32Array);
    assert.deepEqual(Array.from(rasters[0]), Array.from(band));
    assert.match(image.fileDirectory.getValue('GDAL_METADATA'), /<Item name="DESCRIPTION" sample="0" role="description">elevation<\/Item>/);
  });

  test('uint8, 3 bands, EPSG:32616 (RGB)', async () => {
    const w = 3, h = 2;
    const bands = [0, 1, 2].map((b) => new Uint8Array(w * h).map((_, i) => (i * 40 + b * 7) % 256));
    const ab = F.geotiff.write({ width: w, height: h, bands, noData: null, crs: 'EPSG:32616', transform: [440000, 30, 0, 4640000, 0, -30], dataType: 'uint8' });
    const { image, rasters } = await readBack(ab);
    assert.equal(image.getSamplesPerPixel(), 3);
    assert.deepEqual(image.getBoundingBox(), [440000, 4639940, 440090, 4640000]);
    const keys = image.getGeoKeys();
    assert.equal(keys.GTModelTypeGeoKey, 1);
    assert.equal(keys.ProjectedCSTypeGeoKey, 32616);
    assert.equal(keys.GeographicTypeGeoKey, undefined);
    assert.equal(image.getGDALNoData(), null);
    assert.equal(image.fileDirectory.getValue('PhotometricInterpretation'), 2);
    assert.equal(rasters.length, 3);
    bands.forEach((b, i) => assert.deepEqual(Array.from(rasters[i]), Array.from(b)));
    const interleaved = await image.readRasters({ interleave: true });
    assert.deepEqual(Array.from(interleaved.slice(0, 3)), [bands[0][0], bands[1][0], bands[2][0]]);
  });

  test('every data type round-trips, with NaN nodata and several strips', async () => {
    const types = {
      int8: [Int8Array, [-128, 127]], uint16: [Uint16Array, [0, 65535]], int16: [Int16Array, [-32768, 32767]],
      uint32: [Uint32Array, [0, 4294967295]], int32: [Int32Array, [-2147483648, 2147483647]],
      float32: [Float32Array, [-3.5e38, 3.5e38]], float64: [Float64Array, [-1e300, 1e300]],
    };
    for (const [name, [Ctor, [lo, hi]]] of Object.entries(types)) {
      const w = 7, h = 3;
      const bands = [0, 1].map((b) => {
        const a = new Ctor(w * h);
        for (let i = 0; i < a.length; i++) a[i] = i === 0 ? lo : i === 1 ? hi : (i * 3 + b) * (Ctor === Float32Array || Ctor === Float64Array ? 0.5 : 1);
        return a;
      });
      const nd = name.startsWith('float') ? NaN : 0;
      const ab = F.geotiff.write({ width: w, height: h, bands, noData: nd, crs: 'EPSG:3857', transform: [0, 10, 0, 0, 0, -10], dataType: name });
      const { image, rasters } = await readBack(ab);
      assert.ok(rasters[0] instanceof Ctor, name);
      bands.forEach((b, i) => assert.deepEqual(Array.from(rasters[i]), Array.from(b), name + ' band ' + (i + 1)));
      if (Number.isNaN(nd)) assert.ok(Number.isNaN(image.getGDALNoData()), name);
      else assert.equal(image.getGDALNoData(), 0, name);
      assert.equal(image.getGeoKeys().ProjectedCSTypeGeoKey, 3857);
    }
    // Large enough for several strips
    const w = 700, h = 300;
    const big = new Float32Array(w * h).map((_, i) => (i % 997) - 400.5);
    const ab = F.geotiff.write({ width: w, height: h, bands: [big], noData: null, crs: 'EPSG:4326', bbox: [0, 0, 7, 3] });
    const { image, rasters } = await readBack(ab);
    assert.ok(image.fileDirectory.getValue('StripByteCounts').length > 1);
    assert.deepEqual(image.getBoundingBox(), [0, 0, 7, 3]);
    assert.ok(rasters[0].every((v, i) => v === big[i]));
  });

  test('clear errors for bad rasters', () => {
    assert.throws(() => F.geotiff.write(null), /No raster/);
    assert.throws(() => F.geotiff.write({ width: 0, height: 2, bands: [new Uint8Array(0)] }), /positive whole numbers/);
    assert.throws(() => F.geotiff.write({ width: 2, height: 2, bands: [] }), /no bands/);
    assert.throws(() => F.geotiff.write({ width: 2, height: 2, bands: [new Uint8Array(3)] }), /Band 1 has 3 values, but a 2 x 2 raster needs 4/);
    assert.throws(() => F.geotiff.write({ width: 1, height: 1, bands: [new Uint8Array(1)], dataType: 'complex64' }), /Unsupported raster data type/);
  });
});

/* ===================================================== detect and zips */

describe('detect', () => {
  const enc = (s) => new TextEncoder().encode(s);
  const bytes = (...b) => new Uint8Array(b);
  test('by extension and magic bytes', () => {
    const cases = [
      ['roads.geojson', enc('{"type":"FeatureCollection","features":[]}'), 'geojson'],
      ['roads.json', enc('{"type":"FeatureCollection"}'), 'geojson'],
      ['world.json', enc('{"type":"Topology","objects":{}}'), 'topojson'],
      ['world.topojson', null, 'topojson'],
      ['config.json', enc('{"foo":1}'), 'json'],
      ['x.geojson', enc('\uFEFF  {"type":"Topology"}'), 'topojson'],
      ['roads.shp', bytes(0, 0, 0x27, 0x0a, 0, 0), 'shp'],
      ['roads.shx', bytes(0, 0, 0x27, 0x0a, 0, 0), 'shx'],
      ['ROADS.DBF', bytes(3, 124, 1, 1), 'dbf'],
      ['roads.prj', enc('GEOGCS["WGS 84"]'), 'prj'],
      ['roads.cpg', enc('UTF-8'), 'cpg'],
      ['doc.kml', enc('<?xml version="1.0"?><kml xmlns="http://www.opengis.net/kml/2.2">'), 'kml'],
      ['doc.kmz', bytes(0x50, 0x4b, 3, 4, 20, 0), 'kmz'],
      ['doc.kml', bytes(0x50, 0x4b, 3, 4, 20, 0), 'kmz'],
      ['track.gpx', null, 'gpx'],
      ['track.xml', enc('<?xml version="1.0"?>\n<!-- c --><gpx version="1.1">'), 'gpx'],
      ['doc.xml', enc('<kml:kml xmlns:kml="http://www.opengis.net/kml/2.2">'), 'kml'],
      ['data.csv', enc('a,b\n1,2'), 'csv'],
      ['data.tsv', enc('a\tb\n1\t2'), 'tsv'],
      ['data.txt', enc('a\tb\n1\t2'), 'tsv'],
      ['data.txt', enc('a;b\n1;2'), 'csv'],
      ['book.xlsx', bytes(0x50, 0x4b, 3, 4), 'xlsx'],
      ['book.xlsx', null, 'xlsx'],
      ['places.gpkg', null, 'gpkg'],
      ['download', enc('SQLite format 3\u0000....'), 'gpkg'],
      ['dem.tif', bytes(0x49, 0x49, 42, 0, 8, 0, 0, 0), 'geotiff'],
      ['dem.TIFF', null, 'geotiff'],
      ['dem', bytes(0x4d, 0x4d, 0, 42), 'geotiff'],
      ['big.tif', bytes(0x49, 0x49, 43, 0), 'geotiff'],
      ['data.fgb', bytes(0x66, 0x67, 0x62, 3, 0x66, 0x67, 0x62, 0), 'fgb'],
      ['unnamed', bytes(0x66, 0x67, 0x62, 3, 0x66, 0x67, 0x62, 0), 'fgb'],
      ['archive.zip', bytes(0x50, 0x4b, 3, 4), 'zip'],
      ['report.docx', bytes(0x50, 0x4b, 3, 4), 'zip'],
      ['empty.zip', bytes(0x50, 0x4b, 5, 6), 'zip'],
      ['shape.wkt', enc('POINT (1 2)'), 'wkt'],
      ['clipboard', enc('  MULTIPOLYGON (((0 0, 1 0, 1 1, 0 0)))'), 'wkt'],
      ['clipboard', 'SRID=4326;POINT(1 2)', 'wkt'],
      ['clipboard', '{"type":"Point","coordinates":[1,2]}', 'geojson'],
      ['blob.bin', bytes(1, 2, 3, 4, 5), 'unknown'],
      ['notes.txt', enc('hello world'), 'unknown'],
      ['', null, 'unknown'],
      [undefined, undefined, 'unknown'],
    ];
    for (const [name, head, expected] of cases) assert.equal(F.detect(name, head), expected, name + ' ' + (head ? String(head).slice(0, 20) : ''));
    assert.equal(F.detect('x.bin', enc('SQLite format 3\u0000').buffer), 'gpkg');
  });
});

describe('zip archives', () => {
  const pts = fc([feat(pt(-87.6, 41.8), { name: 'a', when: null }), feat(pt(-87.7, 41.9), { name: null, when: '2020-02-03' })]);

  test('inspectZip classifies contents and lists entry sizes', async () => {
    const shpZip = (await F.shapefile.write(pts, { name: 'pts' })).bytes;
    const info = await F.inspectZip(shpZip);
    assert.equal(info.kind, 'shapefile');
    const files = await unzip(shpZip);
    assert.deepEqual(info.entries.map((e) => [e.path, e.size]).sort(), Object.keys(files).map((k) => [k, files[k].length]).sort());

    const make = async (entries) => {
      const z = new JSZip();
      for (const [p, content] of entries) z.file(p, content);
      return z.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
    };
    assert.equal((await F.inspectZip(await make([['doc.kml', '<kml/>'], ['files/icon.png', 'png']]))).kind, 'kmz');
    assert.equal((await F.inspectZip(await buildXlsx())).kind, 'xlsx');
    assert.equal((await F.inspectZip(await make([['a/roads.shp', 'x'], ['a/roads.dbf', 'x'], ['b/parks.geojson', '{}']]))).kind, 'mixed');
    assert.equal((await F.inspectZip(await make([['data.gpkg', 'x'], ['__MACOSX/._data.gpkg', 'junk'], ['.DS_Store', 'junk']]))).kind, 'gpkg');
    assert.equal((await F.inspectZip(await make([['dem.tif', 'x'], ['dem.tfw', 'x']]))).kind, 'geotiff');
    assert.equal((await F.inspectZip(await make([['x.json', '{}']]))).kind, 'geojson');
    const junk = await F.inspectZip(await make([['readme.txt', 'hello'], ['__MACOSX/._readme.txt', 'x']]));
    assert.deepEqual(junk, { kind: 'unknown', entries: [{ path: 'readme.txt', size: 5 }] });
    await assert.rejects(F.inspectZip(new Uint8Array([1, 2, 3])), /not a valid zip/);
  });

  test('readZipShapefiles: every layer, cleaned attributes, projections', async () => {
    const mixed = fc(pts.features.concat([feat({ type: 'LineString', coordinates: [[0, 0], [1, 1]] }, { name: 'l', when: null })]));
    const layers = await F.readZipShapefiles((await F.shapefile.write(mixed, { name: 'mix' })).bytes);
    assert.deepEqual(layers.map((l) => [l.name, l.crs, l.fc.features.length]), [['mix_point', 'EPSG:4326', 2], ['mix_line', 'EPSG:4326', 1]]);
    assert.deepEqual(layers[0].fc.features.map((f) => f.properties), [{ name: 'a', when: null }, { name: null, when: '2020-02-03' }]);
    assert.deepEqual(layers[0].fc.features[0].geometry, pt(-87.6, 41.8));
    assert.deepEqual(layers[0].warnings, []);

    // Projected shapefile inside a folder: reprojected to lon/lat by shpjs
    const toUtm = M.crs.transformer('EPSG:4326', 'EPSG:32616');
    const utm = fc(pts.features.map((f) => feat({ type: 'Point', coordinates: toUtm(f.geometry.coordinates) }, f.properties)));
    const shpZip = (await F.shapefile.write(utm, { name: 'Wells', prjWKT: WKT_32616 })).bytes;
    const z = await JSZip.loadAsync(shpZip);
    const nested = new JSZip();
    for (const name of Object.keys(z.files)) nested.file('data/' + name, await z.files[name].async('uint8array'));
    const [wells] = await F.readZipShapefiles(await nested.generateAsync({ type: 'uint8array' }));
    assert.equal(wells.name, 'Wells');
    assert.equal(wells.crs, 'EPSG:32616');
    assertCoordsClose(wells.fc.features[0].geometry.coordinates, [-87.6, 41.8], 1e-7);
    assertCoordsClose(wells.fc.features[1].geometry.coordinates, [-87.7, 41.9], 1e-7);

    // Missing .prj: kept as is, with a warning (and a CRS request for projected numbers)
    const noPrj = new JSZip();
    for (const name of Object.keys(z.files)) if (!/\.prj$/.test(name)) noPrj.file(name, await z.files[name].async('uint8array'));
    const [raw] = await F.readZipShapefiles(await noPrj.generateAsync({ type: 'uint8array' }));
    assert.equal(raw.crs, null);
    assert.equal(raw.needsCrs, true);
    assert.ok(raw.rawBBox[0] > 1000);
    assert.ok(raw.warnings.some((w) => /no usable projection/.test(w)));

    await assert.rejects(F.readZipShapefiles(await new JSZip().file('a.txt', 'x').generateAsync({ type: 'uint8array' })), /No shapefile/);
  });
});
