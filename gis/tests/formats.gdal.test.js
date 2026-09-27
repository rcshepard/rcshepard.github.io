'use strict';
/*
 * Interoperability tests: files written by js/lib/formats.js must open in GDAL
 * (gdal3.js, WebAssembly) with the right driver, size / feature count, CRS and
 * fields — and files written by GDAL must read back through PSICITS.
 *
 * Run from the repository root (the harness resolves the GDAL path from cwd).
 */
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const harness = require('./harness');

const M = harness.load('formats');
const F = M.formats;

let Gdal, SQL, dir;
let seq = 0;

before(async () => {
  [Gdal, SQL] = await Promise.all([harness.initGdal(), harness.initSqlJs()]);
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'psicits-formats-'));
});
after(() => {
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

const fc = (features) => ({ type: 'FeatureCollection', features });
const feat = (geometry, properties) => ({ type: 'Feature', geometry, properties: properties || {} });
const pt = (x, y) => ({ type: 'Point', coordinates: [x, y] });

/** Write bytes to a fresh sub-directory (gdal3.js mounts the file's directory). */
function writeTemp(name, data) {
  const sub = path.join(dir, String(++seq));
  fs.mkdirSync(sub);
  const file = path.join(sub, name);
  fs.writeFileSync(file, typeof data === 'string' ? data : Buffer.from(data instanceof ArrayBuffer ? new Uint8Array(data) : data));
  return file;
}

async function open(file, vsi) {
  const r = await Gdal.open(file, [], vsi ? [vsi] : []);
  assert.deepEqual(r.errors, [], 'GDAL errors opening ' + path.basename(file));
  assert.ok(r.datasets.length >= 1, 'GDAL could not open ' + path.basename(file));
  return r.datasets;
}

async function rasterInfo(file) {
  const [ds] = await open(file);
  try {
    const info = await Gdal.gdalinfo(ds, ['-json']);
    return typeof info === 'string' ? JSON.parse(info) : info;
  } finally {
    Gdal.close(ds);
  }
}

async function vectorInfo(file, vsi) {
  const datasets = await open(file, vsi);
  try {
    const out = [];
    for (const ds of datasets) {
      const info = await Gdal.ogrinfo(ds, ['-json', '-features']);
      out.push(typeof info === 'string' ? JSON.parse(info) : info);
    }
    return out;
  } finally {
    datasets.forEach((ds) => Gdal.close(ds));
  }
}

/** Pixel values of one band as GDAL reads them (via an ASCII grid). */
async function gdalBandValues(file, band) {
  const [ds] = await open(file);
  try {
    const out = await Gdal.gdal_translate(ds, ['-of', 'AAIGrid', '-b', String(band)], 'band' + (++seq));
    const text = new TextDecoder().decode(await Gdal.getFileBytes(out));
    return text.split('\n').filter((l) => /^\s*-?[\d.]/.test(l)).join(' ').trim().split(/\s+/).map(Number);
  } finally {
    Gdal.close(ds);
  }
}

/** "EPSG:n" for a GDAL JSON coordinateSystem (PROJJSON id, else the WKT's top-level ID). */
const crsCode = (coordinateSystem) => {
  if (!coordinateSystem) return null;
  const pj = coordinateSystem.projjson;
  if (pj && pj.id) return pj.id.authority + ':' + pj.id.code;
  const m = /ID\["EPSG",(\d+)\]\s*\]\s*$/.exec(coordinateSystem.wkt || '');
  return m ? 'EPSG:' + m[1] : null;
};

/* ============================================================ GeoTIFF */

describe('GeoTIFF written by PSICITS, read by GDAL', () => {
  test('float32, 1 band, EPSG:4326 with nodata', async () => {
    const w = 4, h = 3;
    const band = new Float32Array(w * h).map((_, i) => i * 1.5 - 2);
    band[5] = -9999;
    const file = writeTemp('elev.tif', F.geotiff.write({
      width: w, height: h, bands: [band], bandNames: ['elevation'], noData: -9999, crs: 'EPSG:4326',
      transform: [-88, 0.25, 0, 42, 0, -0.25], dataType: 'float32',
    }));
    const info = await rasterInfo(file);
    assert.equal(info.driverShortName, 'GTiff');
    assert.deepEqual(info.size, [w, h]);
    assert.deepEqual(info.geoTransform, [-88, 0.25, 0, 42, 0, -0.25]);
    assert.equal(crsCode(info.coordinateSystem), 'EPSG:4326');
    assert.equal(info.bands.length, 1);
    assert.equal(info.bands[0].type, 'Float32');
    assert.equal(info.bands[0].noDataValue, -9999);
    assert.equal(info.bands[0].description, 'elevation');
    assert.equal(info.metadata[''].AREA_OR_POINT, 'Area');
    assert.deepEqual(await gdalBandValues(file, 1), Array.from(band));
  });

  test('uint8, 3 bands, EPSG:32616 (RGB)', async () => {
    const w = 5, h = 2;
    const bands = [0, 1, 2].map((b) => new Uint8Array(w * h).map((_, i) => (i * 25 + b * 60) % 256));
    const file = writeTemp('rgb.tif', F.geotiff.write({ width: w, height: h, bands, noData: null, crs: 'EPSG:32616', transform: [440000, 30, 0, 4640000, 0, -30], dataType: 'uint8' }));
    const info = await rasterInfo(file);
    assert.deepEqual(info.size, [w, h]);
    assert.equal(crsCode(info.coordinateSystem), 'EPSG:32616');
    assert.match(info.coordinateSystem.wkt, /UTM zone 16N/);
    assert.deepEqual(info.bands.map((b) => [b.type, b.colorInterpretation, b.noDataValue]), [
      ['Byte', 'Red', undefined], ['Byte', 'Green', undefined], ['Byte', 'Blue', undefined],
    ]);
    for (let b = 0; b < 3; b++) assert.deepEqual(await gdalBandValues(file, b + 1), Array.from(bands[b]));
  });

  test('integer and float64 types, several strips, custom WKT CRS', async () => {
    const wkt = 'PROJCS["Custom LAEA",GEOGCS["WGS 84",DATUM["WGS_1984",SPHEROID["WGS 84",6378137,298.257223563]],' +
      'PRIMEM["Greenwich",0],UNIT["degree",0.0174532925199433]],PROJECTION["Lambert_Azimuthal_Equal_Area"],' +
      'PARAMETER["latitude_of_center",45],PARAMETER["longitude_of_center",-100],PARAMETER["false_easting",0],' +
      'PARAMETER["false_northing",0],UNIT["metre",1]]';
    const types = { int16: ['Int16', Int16Array], uint16: ['UInt16', Uint16Array], int32: ['Int32', Int32Array], uint32: ['UInt32', Uint32Array], float64: ['Float64', Float64Array] };
    for (const [name, [gdalType, Ctor]] of Object.entries(types)) {
      const w = 300, h = 250; // several strips
      const band = new Ctor(w * h).map((_, i) => (i % 1000) - (name.startsWith('u') ? 0 : 500));
      const file = writeTemp(name + '.tif', F.geotiff.write({
        width: w, height: h, bands: [band, band.map((v) => v + 1)], noData: 7, crs: name === 'float64' ? wkt : 'EPSG:3857',
        transform: [1000, 10, 0, 2000, 0, -10], dataType: name,
      }));
      const info = await rasterInfo(file);
      assert.deepEqual(info.size, [w, h], name);
      assert.deepEqual(info.bands.map((b) => [b.type, b.noDataValue]), [[gdalType, 7], [gdalType, 7]], name);
      if (name === 'float64') assert.match(info.coordinateSystem.wkt, /^PROJCRS\["Custom LAEA"/);
      else assert.equal(crsCode(info.coordinateSystem), 'EPSG:3857');
      const values = await gdalBandValues(file, 2);
      assert.equal(values.length, w * h, name);
      assert.ok(values.every((v, i) => v === band[i] + 1), name + ' pixel values');
    }
  });
});

/* ========================================================= GeoPackage */

describe('GeoPackage', () => {
  test('PSICITS GeoPackage opens in GDAL with layers, counts, fields, CRS and values', async () => {
    const people = fc([
      feat(pt(-87.6, 41.8), { name: 'Chicago ✓', pop: 2700000, ratio: 0.5, ok: true, day: '2020-01-02', ts: '2020-01-02T10:11:12Z', tags: { a: 1 }, 'Weird Name!': 'x' }),
      feat(null, { name: null, pop: 3, ratio: null, ok: false, day: null, ts: null, tags: null }),
      feat(pt(-87.7, 41.9), { name: 'Évanston', pop: null, ratio: 1.25, ok: null, day: '2021-05-06', ts: null, tags: [1, 2] }),
    ]);
    const polys = fc([
      feat({ type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]], [[0.2, 0.2], [0.2, 0.4], [0.4, 0.4], [0.2, 0.2]]] }, { id: 1 }),
      feat({ type: 'MultiPolygon', coordinates: [[[[2, 2], [3, 2], [3, 3], [2, 2]]], [[[4, 4], [5, 4], [5, 5], [4, 4]]]] }, { id: 2 }),
    ]);
    const mixed = fc([feat(pt(1, 1), { k: 'p' }), feat({ type: 'LineString', coordinates: [[0, 0], [1, 1]] }, { k: 'l' })]);
    const table = fc([feat(null, { k: 'a' }), feat(null, { k: 'b' })]);
    const file = writeTemp('export.gpkg', F.gpkg.write([
      { name: 'People', fc: people }, { name: 'polys', fc: polys }, { name: 'mixed', fc: mixed }, { name: 'plain table', fc: table },
    ], SQL));
    const [info] = await vectorInfo(file);
    assert.equal(info.driverShortName, 'GPKG');
    const layers = Object.fromEntries(info.layers.map((l) => [l.name, l]));
    assert.deepEqual(Object.keys(layers).sort(), ['People', 'mixed', 'plain_table', 'polys']);

    const p = layers.People;
    assert.equal(p.featureCount, 3);
    assert.equal(p.geometryFields[0].type, 'Point');
    assert.equal(crsCode(p.geometryFields[0].coordinateSystem), 'EPSG:4326');
    assert.deepEqual(p.fields.map((f) => [f.name, f.type, f.subType || null]), [
      ['name', 'String', null], ['pop', 'Integer64', null], ['ratio', 'Real', null], ['ok', 'Integer', 'Boolean'],
      ['day', 'Date', null], ['ts', 'DateTime', null], ['tags', 'String', 'JSON'], ['Weird_Name', 'String', null],
    ]);
    assert.deepEqual(p.features[0].geometry, pt(-87.6, 41.8));
    assert.equal(p.features[1].geometry, null);
    assert.deepEqual(p.features[0].properties, {
      name: 'Chicago ✓', pop: 2700000, ratio: 0.5, ok: true, day: '2020/01/02', ts: '2020/01/02 10:11:12+00', tags: { a: 1 }, Weird_Name: 'x',
    });
    assert.deepEqual(p.features[1].properties, { name: null, pop: 3, ratio: null, ok: false, day: null, ts: null, tags: null, Weird_Name: null });
    assert.equal(p.features[2].properties.name, 'Évanston');

    assert.equal(layers.polys.featureCount, 2);
    assert.equal(layers.polys.geometryFields[0].type, 'MultiPolygon');
    assert.equal(layers.polys.features[0].geometry.coordinates[0].length, 2); // outer ring + hole
    assert.deepEqual(layers.polys.geometryFields[0].extent, [0, 0, 5, 5]);
    assert.equal(layers.mixed.geometryFields[0].type, 'Geometry');
    assert.deepEqual(layers.mixed.features.map((f) => f.geometry.type), ['Point', 'LineString']);
    assert.equal(layers.plain_table.featureCount, 2);
    assert.deepEqual(layers.plain_table.geometryFields, []);
    assert.deepEqual(layers.plain_table.features.map((f) => f.properties.k), ['a', 'b']);
  });

  test('GeoPackage written by GDAL in EPSG:32616 reads back in lon/lat', async () => {
    const src = writeTemp('src.geojson', JSON.stringify(fc([
      feat(pt(-87.6, 41.8), { name: 'a & b', n: 1, f: 1.5, b: true, d: '2020-01-02', dt: '2020-01-02T03:04:05Z' }),
      feat({ type: 'Polygon', coordinates: [[[-87.7, 41.9], [-87.6, 41.9], [-87.6, 42], [-87.7, 41.9]]] }, { name: 'ü', n: 2, f: null, b: false, d: null, dt: null }),
    ])));
    const [ds] = await open(src);
    let bytes;
    try {
      const out = await Gdal.ogr2ogr(ds, ['-f', 'GPKG', '-t_srs', 'EPSG:32616', '-nln', 'sites', '-nlt', 'GEOMETRY'], 'fromgdal');
      bytes = await Gdal.getFileBytes(out);
    } finally {
      Gdal.close(ds);
    }
    const layers = F.gpkg.read(bytes, SQL);
    assert.equal(layers.length, 1);
    const l = layers[0];
    assert.equal(l.name, 'sites');
    assert.equal(l.crs, 'EPSG:32616');
    assert.equal(l.srsId, 32616);
    assert.equal(l.geometryType, 'GEOMETRY');
    assert.deepEqual(l.fields, [
      { name: 'name', type: 'string' }, { name: 'n', type: 'number' }, { name: 'f', type: 'number' },
      { name: 'b', type: 'boolean' }, { name: 'd', type: 'date' }, { name: 'dt', type: 'date' },
    ]);
    const [a, b] = l.fc.features;
    assert.ok(Math.abs(a.geometry.coordinates[0] + 87.6) < 1e-7 && Math.abs(a.geometry.coordinates[1] - 41.8) < 1e-7, JSON.stringify(a.geometry));
    assert.deepEqual(a.properties, { name: 'a & b', n: 1, f: 1.5, b: true, d: '2020-01-02', dt: '2020-01-02T03:04:05.000Z' });
    assert.equal(b.geometry.type, 'Polygon');
    b.geometry.coordinates[0].forEach((p, i) => {
      const e = [[-87.7, 41.9], [-87.6, 41.9], [-87.6, 42], [-87.7, 41.9]][i];
      assert.ok(Math.abs(p[0] - e[0]) < 1e-7 && Math.abs(p[1] - e[1]) < 1e-7);
    });
    assert.deepEqual(b.properties, { name: 'ü', n: 2, f: null, b: false, d: null, dt: null });
  });
});

/* ========================================================== Shapefile */

describe('Shapefile', () => {
  test('PSICITS shapefile zip opens in GDAL (via /vsizip/)', async () => {
    const data = fc([
      feat(pt(-87.6, 41.8), { name: 'Ada ✓', count: 3, share: 0.25, active: true, born: '1815-12-10', population_2020: 1, population_2010: 2 }),
      feat(null, { name: 'nobody', count: null, share: null, active: false, born: null, population_2020: null, population_2010: null }),
      feat(pt(-87.7, 41.9), { name: 'Émile', count: -12, share: 1234.5, active: null, born: '2001-02-03', population_2020: 3, population_2010: 4 }),
    ]);
    const { bytes } = await F.shapefile.write(data, { name: 'people' });
    const [info] = await vectorInfo(writeTemp('people.zip', bytes), 'vsizip');
    assert.equal(info.driverShortName, 'ESRI Shapefile');
    assert.equal(info.layers.length, 1);
    const l = info.layers[0];
    assert.equal(l.name, 'people');
    assert.equal(l.featureCount, 3);
    assert.equal(l.geometryFields[0].type, 'Point');
    assert.equal(crsCode(l.geometryFields[0].coordinateSystem), 'EPSG:4326');
    assert.deepEqual(l.fields.map((f) => f.name), ['name', 'count', 'share', 'active', 'born', 'population', 'populati_1']);
    assert.deepEqual(l.fields.map((f) => f.type), ['String', 'Integer64', 'Real', l.fields[3].type, 'Date', 'Integer64', 'Integer64']);
    assert.deepEqual(l.features.map((f) => f.geometry), [pt(-87.6, 41.8), null, pt(-87.7, 41.9)]);
    const [p0, p1, p2] = l.features.map((f) => f.properties);
    assert.deepEqual([p0.name, p0.count, p0.share, p0.born, p0.population, p0.populati_1], ['Ada ✓', 3, 0.25, '1815/12/10', 1, 2]);
    assert.deepEqual([p1.name, p1.count, p1.share, p1.born, p1.population], ['nobody', null, null, null, null]);
    assert.deepEqual([p2.name, p2.count, p2.share, p2.born], ['Émile', -12, 1234.5, '2001/02/03']);
    assert.ok([true, 'T', 1].includes(p0.active) && [false, 'F', 0].includes(p1.active));
  });

  test('polygons, multipart lines and mixed geometry types', async () => {
    const data = fc([
      feat({ type: 'Polygon', coordinates: [[[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]], [[2, 2], [2, 4], [4, 4], [4, 2], [2, 2]]] }, { kind: 'poly' }),
      feat({ type: 'MultiPolygon', coordinates: [[[[20, 0], [30, 0], [30, 10], [20, 0]]], [[[40, 0], [50, 0], [50, 10], [40, 0]]]] }, { kind: 'multi' }),
      feat({ type: 'MultiLineString', coordinates: [[[0, 0], [1, 1]], [[2, 2], [3, 3]]] }, { kind: 'lines' }),
      feat({ type: 'LineString', coordinates: [[0, 0, 5], [1, 1, 6]] }, { kind: '3d' }),
      feat(pt(7, 7), { kind: 'point' }),
    ]);
    const { bytes } = await F.shapefile.write(data, { name: 'mix' });
    const infos = await vectorInfo(writeTemp('mix.zip', bytes), 'vsizip');
    const layers = Object.fromEntries(infos.flatMap((i) => i.layers).map((l) => [l.name, l]));
    assert.deepEqual(Object.keys(layers).sort(), ['mix_line', 'mix_point', 'mix_polygon']);
    assert.equal(layers.mix_point.featureCount, 1);
    assert.equal(layers.mix_line.featureCount, 2);
    assert.match(layers.mix_line.geometryFields[0].type, /LineString ?Z|3D/);
    assert.equal(layers.mix_polygon.featureCount, 2);
    const [poly, multi] = layers.mix_polygon.features;
    assert.equal(poly.geometry.type, 'Polygon');
    assert.equal(poly.geometry.coordinates.length, 2); // GDAL found the hole
    assert.equal(multi.geometry.type, 'MultiPolygon');
    assert.equal(multi.geometry.coordinates.length, 2);
    assert.equal(layers.mix_line.features[0].geometry.type, 'MultiLineString');
    assert.deepEqual(layers.mix_line.features[1].geometry.coordinates, [[0, 0, 5], [1, 1, 6]]);
  });

  test('shapefile written by GDAL (ESRI .prj, UTM) reads with readZipShapefiles', async () => {
    const src = writeTemp('src.geojson', JSON.stringify(fc([
      feat({ type: 'Polygon', coordinates: [[[-87.6, 41.8], [-87.5, 41.8], [-87.5, 41.9], [-87.6, 41.8]]] }, { name: 'ä', n: 1, d: '2020-01-02' }),
      feat(null, { name: null, n: null, d: null }),
    ])));
    const [ds] = await open(src);
    const zip = new JSZip();
    try {
      const out = await Gdal.ogr2ogr(ds, ['-f', 'ESRI Shapefile', '-t_srs', 'EPSG:26916', '-lco', 'ENCODING=UTF-8', '-nln', 'parcels'], 'parcels');
      for (const f of out.all) zip.file('gdal/' + path.basename(f.real), await Gdal.getFileBytes(f.real));
    } finally {
      Gdal.close(ds);
    }
    const [layer] = await F.readZipShapefiles(await zip.generateAsync({ type: 'uint8array' }));
    assert.equal(layer.name, 'parcels');
    assert.ok(layer.crs, 'a CRS code for the .prj');
    assert.equal(M.crs.name(layer.crs), 'NAD_1983_UTM_Zone_16N');
    const ring = layer.fc.features[0].geometry.coordinates[0];
    const expected = [[-87.6, 41.8], [-87.5, 41.9], [-87.5, 41.8], [-87.6, 41.8]]; // shapefile winding (clockwise)
    ring.forEach((p, i) => assert.ok(Math.abs(p[0] - expected[i][0]) < 1e-6 && Math.abs(p[1] - expected[i][1]) < 1e-6, JSON.stringify(ring)));
    assert.deepEqual(layer.fc.features[0].properties, { name: 'ä', n: 1, d: '2020-01-02' });
    assert.equal(layer.fc.features[1].geometry, null);
    assert.deepEqual(layer.fc.features[1].properties, { name: null, n: null, d: null });
  });
});

/* ================================================= KML, GPX, CSV, XLSX */

describe('KML, GPX, CSV and XLSX interoperability', () => {
  const data = fc([
    feat(pt(-87.6, 41.8), { name: 'Start & end', desc: 'x < y', n: 1 }),
    feat({ type: 'LineString', coordinates: [[0, 0], [1, 1], [2, 0]] }, { name: 'route' }),
    feat({ type: 'Polygon', coordinates: [[[0, 0], [4, 0], [4, 4], [0, 0]], [[1, 1], [2, 1], [2, 2], [1, 1]]] }, { name: 'area' }),
    feat({ type: 'MultiLineString', coordinates: [[[5, 5], [6, 6]], [[7, 7], [8, 8]]] }, { name: 'multi' }),
  ]);

  test('KML opens in GDAL', async () => {
    const [info] = await vectorInfo(writeTemp('export.kml', F.kml.write(data, { name: 'Export' })));
    assert.equal(info.driverShortName, 'KML');
    const features = info.layers.flatMap((l) => l.features);
    assert.equal(features.length, 4);
    assert.deepEqual(features.map((f) => f.properties.Name), ['Start & end', 'route', 'area', 'multi']);
    assert.deepEqual(features.map((f) => f.geometry.type), ['Point', 'LineString', 'Polygon', 'MultiLineString']);
    assert.equal(features[2].geometry.coordinates.length, 2);
  });

  test('GPX opens in GDAL', async () => {
    const [info] = await vectorInfo(writeTemp('export.gpx', F.gpx.write(data, { name: 'Trip' })));
    assert.equal(info.driverShortName, 'GPX');
    const layers = Object.fromEntries(info.layers.map((l) => [l.name, l]));
    assert.equal(layers.waypoints.featureCount, 1);
    assert.equal(layers.waypoints.features[0].properties.name, 'Start & end');
    assert.equal(layers.waypoints.features[0].properties.desc, 'x < y');
    assert.equal(layers.tracks.featureCount, 3);
    assert.deepEqual(layers.tracks.features.map((f) => f.geometry.coordinates.length), [1, 1, 2]);
  });

  test('CSV with a WKT column opens in GDAL', async () => {
    const [info] = await vectorInfo(writeTemp('export.csv', F.csv.write(data)));
    assert.equal(info.driverShortName, 'CSV');
    const l = info.layers[0];
    assert.equal(l.featureCount, 4);
    assert.deepEqual(l.features.map((f) => f.geometry.type), ['Point', 'LineString', 'Polygon', 'MultiLineString']);
    assert.deepEqual(l.features.map((f) => f.properties.name), ['Start & end', 'route', 'area', 'multi']);
  });

  test('XLSX written by GDAL reads with xlsx.read', async () => {
    const src = writeTemp('src.geojson', JSON.stringify(fc([
      feat(pt(1, 2), { name: 'a & b', n: 1, f: 1.5, d: '2020-01-02', dt: '2020-01-02T03:04:05', b: true }),
      feat(pt(3, 4), { name: 'ü', n: 2, f: null, d: null, dt: null, b: false }),
    ])));
    const [ds] = await open(src);
    let bytes;
    try {
      bytes = await Gdal.getFileBytes(await Gdal.ogr2ogr(ds, ['-f', 'XLSX', '-nln', 'Sheet A'], 'book'));
    } finally {
      Gdal.close(ds);
    }
    const sheets = await F.xlsx.read(bytes);
    assert.equal(sheets.length, 1);
    assert.equal(sheets[0].name, 'Sheet A');
    assert.deepEqual(sheets[0].rows, [
      { name: 'a & b', n: 1, f: 1.5, d: '2020-01-02', dt: '2020-01-02T03:04:05', b: true },
      { name: 'ü', n: 2, f: null, d: null, dt: null, b: false },
    ]);
  });
});
