/*
 * Tests for js/lib/gdal.js (PSICITS.gdal) against the vendored gdal3.js Node build.
 *
 * Fixtures in tests/fixtures/gdal/ were produced by GDAL through PSICITS.gdal:
 *   parks.gpkg      layers "parks" (polygons, EPSG:4326) and "trees" (points, EPSG:3435)
 *   roads_3435.zip  zipped shapefile "roads_3435" (lines, EPSG:3435, UTF-8 names)
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const harness = require('./harness');

const M = harness.load('gdal');
const G = M.gdal;
G.configure({ init: () => harness.initGdal() });

/* ---------------------------------------------------------------- data */

const roads = {
  type: 'FeatureCollection',
  features: [
    { type: 'Feature', id: 'r1', properties: { name: 'Main St', lanes: 2 }, geometry: { type: 'LineString', coordinates: [[-87.63, 41.88], [-87.62, 41.885]] } },
    { type: 'Feature', id: 'r2', properties: { name: 'Lake Shore Dr', lanes: 8 }, geometry: { type: 'LineString', coordinates: [[-87.615, 41.86], [-87.617, 41.9]] } },
    { type: 'Feature', id: 'r3', properties: { name: 'Halsted St', lanes: 4 }, geometry: { type: 'LineString', coordinates: [[-87.647, 41.85], [-87.648, 41.9]] } },
  ],
};

const counties = {
  type: 'FeatureCollection',
  features: [
    { type: 'Feature', properties: { population: 10 }, geometry: { type: 'Polygon', coordinates: [[[-88, 41.9], [-87.95, 41.9], [-87.95, 41.95], [-88, 41.95], [-88, 41.9]]] } },
    { type: 'Feature', properties: { population: 25 }, geometry: { type: 'Polygon', coordinates: [[[-87.9, 41.9], [-87.85, 41.9], [-87.85, 41.95], [-87.9, 41.95], [-87.9, 41.9]]] } },
  ],
};

const stations = {
  type: 'FeatureCollection',
  features: [
    { type: 'Feature', properties: { station: 'A' }, geometry: { type: 'Point', coordinates: [-87.99, 41.92] } },
    { type: 'Feature', properties: { station: 'B' }, geometry: { type: 'Point', coordinates: [-87.7, 41.92] } },
  ],
};

// 40 x 30 float32 DEM in EPSG:4326, value = 100 + col + 2*row, nodata in the top-left pixel.
const W = 40;
const H = 30;
const demBand = new Float32Array(W * H);
for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) demBand[r * W + c] = 100 + c + 2 * r;
demBand[0] = -9999;
const dem = {
  width: W, height: H, bands: [demBand], bandNames: ['elevation'], noData: -9999, crs: 'EPSG:4326',
  transform: [-88, 0.01, 0, 42, 0, -0.01], bbox: [-88, 41.7, -87.6, 42], dataType: 'float32', stats: null, meta: {},
};

const LAYERS = {
  roads: { kind: 'vector', name: 'roads', fc: roads },
  'Major Roads 2020': { kind: 'vector', name: 'Major Roads 2020', fc: roads },
  counties: { kind: 'vector', name: 'counties', fc: counties },
  stations: { kind: 'vector', name: 'stations', fc: stations },
  dem: { kind: 'raster', name: 'dem', raster: dem },
};
const FILES = {};
const resolve = (name) => LAYERS[name] || (FILES[name] ? { kind: 'file', name, bytes: FILES[name] } : null);
const run = (cmd, extra) => G.execute(cmd, Object.assign({ resolve, names: Object.keys(LAYERS) }, extra));

const ascii = (bytes, n) => String.fromCharCode.apply(null, Array.from(bytes.slice(0, n)));
const near = (a, b, tol) => Math.abs(a - b) <= tol;

let runtime;
test.before(async () => {
  runtime = await G.load();
});

/* ------------------------------------------------------------ parsing */

test('splitArgs: POSIX-like quoting', () => {
  const s = G.splitArgs;
  assert.deepEqual(s('ogr2ogr -f GPKG out.gpkg roads'), ['ogr2ogr', '-f', 'GPKG', 'out.gpkg', 'roads']);
  assert.deepEqual(s('  a \t b\n c  '), ['a', 'b', 'c']);
  assert.deepEqual(s('-sql "SELECT * FROM roads"'), ['-sql', 'SELECT * FROM roads']);
  assert.deepEqual(s('-where "name = \'Main St\'"'), ['-where', "name = 'Main St'"]);
  assert.deepEqual(s('"say \\"hi\\"" "a\\\\b" "c\\nd"'), ['say "hi"', 'a\\b', 'c\\nd']);
  assert.deepEqual(s("'a \"b\" \\c' 'it''s'"), ['a "b" \\c', 'its']);
  assert.deepEqual(s('--name="My layer" x'), ['--name=My layer', 'x']);
  assert.deepEqual(s('a "" b \'\''), ['a', '', 'b', '']);
  assert.deepEqual(s('a\\ b c\\"d'), ['a b', 'c"d']);
  assert.deepEqual(s('-f "ESRI Shapefile" out.shp *.geojson'), ['-f', 'ESRI Shapefile', 'out.shp', '*.geojson']);
  assert.deepEqual(s(''), []);
  assert.throws(() => s('ogr2ogr -sql "SELECT'), /Unterminated double quote/);
  assert.throws(() => s("-where 'x"), /Unterminated single quote/);
});

test('parse: option values are not mistaken for datasets', () => {
  let p = G.parse('ogr2ogr -spat -88 41 -87 42 -f GPKG out.gpkg roads parks_layer');
  assert.deepEqual(p.positionals, ['out.gpkg', 'roads', 'parks_layer']);
  assert.deepEqual(p.options[0].values, ['-88', '41', '-87', '42']);
  p = G.parse('ogr2ogr -clipsrc -88 41 -87 42 out roads');
  assert.deepEqual(p.positionals, ['out', 'roads']);
  p = G.parse('ogr2ogr -clipsrc parks out roads');
  assert.deepEqual(p.positionals, ['out', 'roads']);
  assert.deepEqual(G.parse('gdal_translate -scale dem out.png').positionals, ['dem', 'out.png']);
  assert.deepEqual(G.parse('gdal_translate -scale 0 100 dem out.png').positionals, ['dem', 'out.png']);
  assert.deepEqual(G.parse('gdal_translate -scale_1 0 100 0 255 -b 1 dem out.png').positionals, ['dem', 'out.png']);
  assert.deepEqual(G.parse('gdalwarp -tr square -r near a b out.tif').positionals, ['a', 'b', 'out.tif']);
  assert.deepEqual(G.parse('gdalwarp -tr 10 10 -te 0 0 10 10 --config GDAL_CACHEMAX 64 a out.tif').positionals, ['a', 'out.tif']);
  assert.deepEqual(G.parse('gdaltransform -s_srs EPSG:4326 -t_srs EPSG:3857 -87.6 41.8').positionals, ['-87.6', '41.8']);
  assert.equal(G.parse('gdallocationinfo -wgs84 dem 1 2').program, 'gdal_location_info');
  p = G.parse('ogr2ogr --map --name "Big roads" -where "lanes > 2" big roads --download');
  assert.deepEqual(p.meta, { map: true, download: true, name: 'Big roads' });
  assert.deepEqual(p.positionals, ['big', 'roads']);
  assert.throws(() => G.parse('gdal_contour dem out.shp'), /Unknown GDAL program "gdal_contour". Supported: ogr2ogr/);
  assert.throws(() => G.parse('ogr2ogr -spat 1 2'), /-spat needs 4 values/);
});

test('programs, load() and drivers()', () => {
  for (const p of ['ogr2ogr', 'ogrinfo', 'gdal_translate', 'gdalwarp', 'gdal_rasterize', 'gdalinfo', 'gdal_location_info', 'gdaltransform']) {
    assert.ok(G.programs.includes(p), p);
  }
  assert.equal(G.isLoaded(), true);
  assert.equal(runtime.mode, 'node');
  assert.equal(runtime.source, 'injected');
  const d = G.drivers();
  const gpkg = d.vector.find((x) => x.name === 'GPKG');
  assert.ok(gpkg && gpkg.canWrite && gpkg.extensions.includes('gpkg'));
  assert.ok(d.vector.find((x) => x.name === 'ESRI Shapefile').canWrite);
  assert.ok(d.raster.find((x) => x.name === 'GTiff').extensions.includes('tif'));
  assert.equal(d.raster.find((x) => x.name === 'COG').canRead, false);
});

/* ------------------------------------------------------------ ogr2ogr */

test('ogr2ogr -> GPKG is a file output', async () => {
  const r = await run('ogr2ogr -f GPKG roads.gpkg roads');
  assert.equal(r.program, 'ogr2ogr');
  assert.equal(r.layers.length, 0);
  assert.equal(r.outputs.length, 1);
  const o = r.outputs[0];
  assert.equal(o.filename, 'roads.gpkg');
  assert.equal(o.kind, 'vector');
  assert.equal(o.driver, 'GPKG');
  assert.equal(ascii(o.bytes, 15), 'SQLite format 3');
  assert.match(r.text, /Wrote roads\.gpkg/);
  assert.deepEqual(r.datasets, [{ name: 'roads', kind: 'vector', layer: 'roads', file: 'roads.geojson' }]);
});

test('ogr2ogr -> GeoJSON (or no extension) becomes a layer', async () => {
  const r = await run('ogr2ogr -select name roads_copy.geojson roads');
  assert.equal(r.outputs.length, 0);
  assert.equal(r.layers.length, 1);
  const l = r.layers[0];
  assert.equal(l.kind, 'vector');
  assert.equal(l.name, 'roads_copy');
  assert.equal(l.fc.features.length, 3);
  assert.deepEqual(l.fc.features[0].properties, { name: 'Main St' });
  assert.deepEqual(l.fc.features[0].geometry, roads.features[0].geometry);
  assert.equal(l.fc.features[0].id, undefined, 'input ids are not copied');
  const r2 = await run('ogr2ogr just_roads roads');
  assert.equal(r2.layers[0].name, 'just_roads');
  assert.equal(r2.layers[0].fc.features.length, 3);
});

test('ogr2ogr -where filters features', async () => {
  const r = await run('ogr2ogr -where "lanes >= 4" highways roads');
  assert.deepEqual(r.layers[0].fc.features.map((f) => f.properties.name), ['Lake Shore Dr', 'Halsted St']);
});

test('ogr2ogr with SpatiaLite SQL (ST_Buffer)', async () => {
  const r = await run('ogr2ogr -dialect SQLite -sql "SELECT ST_Buffer(geometry, 0.001) AS geometry, name, lanes FROM roads" roads_buf roads');
  const fc = r.layers[0].fc;
  assert.equal(r.layers[0].name, 'roads_buf');
  assert.equal(fc.features.length, 3);
  assert.ok(fc.features.every((f) => f.geometry.type === 'Polygon'));
  assert.deepEqual(fc.features[1].properties, { name: 'Lake Shore Dr', lanes: 8 });
  const bb = M.util.bbox(fc);
  assert.ok(near(bb[0], -87.648 - 0.001, 1e-6) && near(bb[3], 41.9 + 0.001, 1e-6));
});

test('ogr2ogr -sql can join layers by name; display names map to slugs', async () => {
  const r = await run('ogr2ogr -dialect SQLite -sql "SELECT s.station, c.population, s.geometry FROM stations s, counties c ' +
    'WHERE ST_Intersects(s.geometry, c.geometry)" joined stations');
  assert.deepEqual(r.layers[0].fc.features.map((f) => f.properties), [{ station: 'A', population: 10 }]);
  const r2 = await run('ogr2ogr -sql "SELECT name FROM \\"Major Roads 2020\\" WHERE lanes = 8" lsd "Major Roads 2020"');
  assert.deepEqual(r2.layers[0].fc.features.map((f) => f.properties.name), ['Lake Shore Dr']);
  assert.equal(r2.datasets[0].layer, 'major_roads_2020');
  assert.ok(r2.logs.some((l) => /major_roads_2020/.test(l)));
});

test('ogr2ogr -t_srs EPSG:3435: the layer comes back in EPSG:4326, the file keeps 3435', async () => {
  const r = await run('ogr2ogr -t_srs EPSG:3435 roads_il.geojson roads');
  const c = r.layers[0].fc.features[0].geometry.coordinates[0];
  assert.ok(near(c[0], -87.63, 1e-7) && near(c[1], 41.88, 1e-7), 'lon/lat restored: ' + c);
  const d = await run('ogr2ogr --download -t_srs EPSG:3435 roads_il.geojson roads');
  assert.equal(d.layers.length, 0);
  const gj = JSON.parse(new TextDecoder().decode(d.outputs[0].bytes));
  assert.match(gj.crs.properties.name, /3435/);
  const x = gj.features[0].geometry.coordinates[0][0];
  assert.ok(x > 1e6 && x < 1.3e6, 'Illinois East feet: ' + x);
  assert.ok(M.crs.transformer('EPSG:3435', 'EPSG:4326')(gj.features[0].geometry.coordinates[0])[0] - -87.63 < 1e-6);
});

test('ogr2ogr to Shapefile zips the parts; --map also loads the layer', async () => {
  const r = await run('ogr2ogr --map -f "ESRI Shapefile" roads_shp.shp roads');
  assert.equal(r.outputs[0].filename, 'roads_shp.zip');
  const zip = await JSZip.loadAsync(r.outputs[0].bytes);
  assert.deepEqual(Object.keys(zip.files).map((n) => path.extname(n)).sort(), ['.cpg', '.dbf', '.prj', '.shp', '.shx']);
  assert.equal(await zip.files['roads_shp.cpg'].async('string'), 'UTF-8');
  assert.equal(r.layers.length, 1);
  assert.equal(r.layers[0].name, 'roads_shp');
  assert.equal(r.layers[0].fc.features.length, 3);
});

test('meta flags: --name, --download, and outputs for GeoJSON', async () => {
  const r = await run('ogr2ogr --name "Wide roads" -where "lanes > 2" wide roads');
  assert.equal(r.layers[0].name, 'Wide roads');
  const d = await run('ogr2ogr --download wide.geojson roads');
  assert.equal(d.layers.length, 0);
  assert.equal(d.outputs[0].filename, 'wide.geojson');
  const both = await run('ogr2ogr --download --map wide.geojson roads');
  assert.equal(both.layers.length, 1);
  assert.equal(both.outputs.length, 1);
  const h = await run('ogr2ogr --help');
  assert.match(h.text, /Usage: ogr2ogr/);
  assert.match(h.text, /ST_Buffer/);
});

test('unknown layers and other errors are readable', async () => {
  await assert.rejects(run('ogr2ogr out.gpkg nosuch'), (e) => {
    assert.equal(e.message, 'No layer or file named "nosuch". Available: roads, Major Roads 2020, counties, stations, dem');
    return true;
  });
  await assert.rejects(run('ogr2ogr -sql "SELECT nope FROM roads" out roads'), /Unrecognized field name nope[\s\S]*Fields of roads: name, lanes/);
  await assert.rejects(run('ogr2ogr -foo out roads'), /Unknown option name '-foo'/);
  await assert.rejects(run('ogr2ogr out.gpkg roads missing_layer'), /Couldn't fetch requested layer/);
  await assert.rejects(run('gdal_translate roads out.tif'), /"roads" is a vector layer, but gdal_translate needs raster data/);
  await assert.rejects(run('gdalwarp -t_srs EPSG:999999 dem out.tif'), /crs not found/);
  await assert.rejects(run('gdal_translate dem out.nc'), /cannot write "\.nc" files/);
  await assert.rejects(run('ogr2ogr roads'), /Usage: ogr2ogr/);
  await assert.rejects(run('gdal_rasterize -a population counties x.tif'), /-tr[\s\S]*-ts/);
});

/* ------------------------------------------------------------- rasters */

test('gdalwarp -t_srs EPSG:3857 returns a raster layer and keeps the .tif', async () => {
  const r = await run('gdalwarp -t_srs EPSG:3857 -r bilinear dem dem_3857.tif');
  assert.equal(r.outputs.length, 1);
  assert.equal(r.outputs[0].filename, 'dem_3857.tif');
  assert.equal(ascii(r.outputs[0].bytes, 2), 'II');
  assert.equal(r.layers.length, 1);
  const R = r.layers[0].raster;
  assert.equal(r.layers[0].name, 'dem_3857');
  assert.equal(R.crs, 'EPSG:3857');
  assert.ok(R.width > 25 && R.width < 50 && R.height > 25 && R.height < 50, R.width + 'x' + R.height);
  assert.equal(R.bands.length, 1);
  assert.equal(R.bands[0].length, R.width * R.height);
  assert.equal(R.dataType, 'float32');
  assert.equal(R.noData, -9999);
  assert.deepEqual(R.bandNames, ['elevation']);
  const [x0, dx, , y0, , dy] = R.transform;
  assert.ok(dx > 0 && dy < 0);
  assert.ok(near(x0, -9796115, 5) && near(y0, 5160979, 5), 'origin ' + x0 + ',' + y0);
  assert.deepEqual(R.bbox, [x0, y0 + R.height * dy, x0 + R.width * dx, y0]);
  const valid = Array.from(R.bands[0]).filter((v) => v !== -9999);
  assert.ok(valid.length > R.width * R.height * 0.8);
  assert.ok(Math.min(...valid) >= 100 && Math.max(...valid) <= 100 + 39 + 58, 'values in input range');
});

test('gdal_translate -of PNG is a file output; --map reads it back', async () => {
  const r = await run('gdal_translate -of PNG -ot Byte -scale dem dem.png');
  assert.equal(r.layers.length, 0);
  assert.equal(r.outputs.length, 1);
  assert.equal(r.outputs[0].filename, 'dem.png');
  assert.equal(r.outputs[0].kind, 'raster');
  assert.equal(r.outputs[0].driver, 'PNG');
  assert.equal(ascii(r.outputs[0].bytes.slice(1), 3), 'PNG');
  const m = await run('gdal_translate --map -of PNG -ot Byte -scale dem dem.png');
  assert.equal(m.layers[0].raster.dataType, 'uint8');
  assert.equal(m.layers[0].raster.crs, 'EPSG:4326');
});

test('gdal_rasterize polygons -> raster layer', async () => {
  const r = await run('gdal_rasterize -a population -tr 0.01 0.01 -a_nodata 0 counties pop.tif');
  const R = r.layers[0].raster;
  assert.equal(r.layers[0].name, 'pop');
  assert.equal(R.crs, 'EPSG:4326');
  assert.equal(R.noData, 0);
  assert.ok(near(R.transform[1], 0.01, 1e-12));
  assert.deepEqual([...new Set(R.bands[0])].sort((a, b) => a - b), [0, 10, 25]);
  // Burning into a copy of an existing raster layer
  const b = await run('gdal_rasterize -burn 5000 counties dem');
  const burnt = Array.from(b.layers[0].raster.bands[0]).filter((v) => v === 5000).length;
  assert.equal(burnt, 50); // two 5 x 5 pixel polygons
  assert.equal(b.layers[0].raster.width, W);
  // A projected grid: the lon/lat layer is reprojected for -a_srs (GDAL alone would only relabel it)
  const u = await run('gdal_rasterize -burn 1 -a_nodata 0 -tr 100 100 -a_srs EPSG:32616 counties pop_utm.tif');
  const U = u.layers[0].raster;
  assert.equal(U.crs, 'EPSG:32616');
  assert.ok(U.transform[0] > 400000 && U.transform[0] < 500000, 'UTM easting ' + U.transform[0]);
  // Both counties span 0.15 deg of longitude (~12.4 km) and 0.05 deg of latitude (~5.6 km) -> ~126 x 58 px at 100 m
  assert.ok(U.width > 115 && U.width < 135 && U.height > 50 && U.height < 65, U.width + 'x' + U.height);
  assert.ok(Array.from(U.bands[0]).filter((v) => v === 1).length > 2 * 1500, 'both ~4.1 x 5.6 km polygons burnt');
  assert.ok(u.logs.some((l) => /reprojected from EPSG:4326 to EPSG:32616/.test(l)));
});

test('gdalwarp -cutline <layer> and multiple inputs', async () => {
  const r = await run('gdalwarp -cutline counties -crop_to_cutline dem dem_cut.tif');
  const R = r.layers[0].raster;
  assert.ok(R.width < W && R.height < H);
  assert.ok(R.bbox[0] >= -88 - 1e-9 && R.bbox[2] <= -87.85 + 1e-9);
  const m = await run('gdalwarp -te -88 41.7 -87.2 42 dem dem mosaic.tif');
  assert.equal(m.layers[0].raster.width, 80);
});

test('gdalinfo / ogrinfo give text and json', async () => {
  const gi = await run('gdalinfo dem');
  assert.match(gi.text, /Size is 40, 30/);
  assert.match(gi.text, /NoData Value=-9999/);
  assert.doesNotMatch(gi.text, /\/input\//, 'internal paths are hidden');
  assert.deepEqual(gi.json.size, [40, 30]);
  assert.equal(gi.json.bands[0].description, 'elevation');
  const gs = await run('gdalinfo -stats -json dem');
  assert.equal(gs.json.bands[0].minimum, 101);
  const oi = await run('ogrinfo roads');
  assert.match(oi.text, /INFO: Open of `roads'/);
  assert.match(oi.text, /Feature Count: 3/);
  assert.match(oi.text, /lanes: Integer/);
  assert.equal(oi.json.layers[0].featureCount, 3);
  const q = await run('ogrinfo -sql "SELECT COUNT(*) AS n FROM roads WHERE lanes > 2" roads');
  assert.match(q.text, /n \(Integer\) = 2/);
});

test('gdal_location_info and gdaltransform', async () => {
  const r = await run('gdal_location_info -wgs84 dem -87.955 41.955');
  assert.equal(r.json[0].pixel, 4);
  assert.equal(r.json[0].line, 4);
  assert.deepEqual(r.json[0].values, [112]);
  assert.match(r.text, /Location: \(4P,4L\)[\s\S]*Value: 112/);
  const v = await run('gdal_location_info -valonly dem 10 3 200 200');
  assert.equal(v.text, '116\n');
  const t = await run('gdaltransform -s_srs EPSG:4326 -t_srs EPSG:3857 -output_xy 27.143757 38.4247972');
  assert.ok(near(t.json[0][0], 3021629.2074563554, 1e-4) && near(t.json[0][1], 4639610.441991095, 1e-4));
  assert.match(t.text, /^3021629\.2074\d* 4639610\.44199\d*$/);
});

test('gdaldem hillshade and gdalbuildvrt', async () => {
  const h = await run('gdaldem hillshade -s 111120 dem hs.tif');
  assert.equal(h.layers[0].raster.dataType, 'uint8');
  const v = await run('gdalbuildvrt -separate stack.vrt dem dem');
  assert.equal(v.outputs.length, 0);
  assert.equal(v.layers[0].raster.bands.length, 2);
});

/* ---------------------------------------------------- import / export */

test('readVector: GPKG with two layers (one in EPSG:3435)', async () => {
  const bytes = harness.fixture('gdal/parks.gpkg');
  const layers = await G.readVector({ name: 'parks.gpkg', bytes });
  assert.deepEqual(layers.map((l) => [l.name, l.fc.features.length]), [['parks', 2], ['trees', 3]]);
  const tree = layers[1].fc.features[0];
  assert.equal(tree.properties.species, 'Quercus alba');
  assert.ok(near(tree.geometry.coordinates[0], -87.62, 1e-7) && near(tree.geometry.coordinates[1], 41.878, 1e-7));
  const only = await G.readVector({ name: 'parks.gpkg', bytes }, { layers: 'trees' });
  assert.deepEqual(only.map((l) => l.name), ['trees']);
  await assert.rejects(G.readVector({ name: 'parks.gpkg', bytes }, { layers: ['lakes'] }), /No layer named "lakes"/);
});

test('readVector: zipped shapefile (and the same files passed one by one)', async () => {
  const bytes = harness.fixture('gdal/roads_3435.zip');
  const layers = await G.readVector({ name: 'roads_3435.zip', bytes });
  assert.equal(layers.length, 1);
  assert.equal(layers[0].name, 'roads_3435');
  const f = layers[0].fc.features;
  assert.deepEqual(f.map((x) => x.properties.name), ['Lake Shore Drive', 'Straße Müller']);
  assert.ok(near(f[1].geometry.coordinates[0][0], -87.65, 1e-7) && near(f[1].geometry.coordinates[0][1], 41.88, 1e-7));
  const zip = await JSZip.loadAsync(bytes);
  const parts = [];
  for (const n of Object.keys(zip.files)) parts.push({ name: n, bytes: await zip.files[n].async('uint8array') });
  const again = await G.readVector(parts);
  assert.equal(again[0].fc.features.length, 2);
  // Browser-style File objects (which also have a Blob#bytes() method in current runtimes)
  const asFile = await G.readVector(new File([bytes], 'roads_3435.zip'));
  assert.equal(asFile[0].name, 'roads_3435');
});

test('writeVector: ESRI Shapefile -> zip with .shp/.shx/.dbf/.prj, reprojected', async () => {
  const out = await G.writeVector(counties, { format: 'ESRI Shapefile', name: 'counties', crs: 'EPSG:3435' });
  assert.equal(out.filename, 'counties.zip');
  const zip = await JSZip.loadAsync(out.bytes);
  const names = Object.keys(zip.files);
  for (const ext of ['.shp', '.shx', '.dbf', '.prj']) assert.ok(names.includes('counties' + ext), names.join(','));
  assert.match(await zip.files['counties.prj'].async('string'), /Illinois_East/);
  const back = await G.readVector({ name: out.filename, bytes: out.bytes });
  const c = back[0].fc.features[0].geometry.coordinates[0][0];
  assert.ok(near(c[0], -88, 1e-7) && near(c[1], 41.9, 1e-7));
  assert.deepEqual(back[0].fc.features.map((x) => x.properties.population), [10, 25]);
});

test('writeVector other drivers and writeRaster / readRaster round trips', async () => {
  for (const [format, file] of [['GPKG', 'counties.gpkg'], ['FlatGeobuf', 'counties.fgb'], ['KML', 'counties.kml'], ['CSV', 'counties.csv'], ['MapInfo File', 'counties.zip']]) {
    const out = await G.writeVector(counties, { format, name: 'counties' });
    assert.equal(out.filename, file, format);
    const back = await G.readVector({ name: out.filename, bytes: out.bytes });
    assert.equal(back[0].fc.features.length, 2, format);
  }
  const tif = await G.writeRaster(dem, { format: 'GTiff', name: 'dem', options: ['-co', 'COMPRESS=DEFLATE'] });
  assert.equal(tif.filename, 'dem.tif');
  const [R] = await G.readRaster({ name: tif.filename, bytes: tif.bytes });
  assert.equal(R.width, W);
  assert.equal(R.crs, 'EPSG:4326');
  assert.equal(R.noData, -9999);
  assert.deepEqual(Array.from(R.bands[0]), Array.from(demBand));
  assert.deepEqual(R.transform, dem.transform);
  const [small] = await G.readRaster({ name: 'dem.tif', bytes: tif.bytes }, { maxPixels: 300 });
  assert.deepEqual([small.width, small.height, small.meta.downsample], [20, 15, 2]);
  assert.deepEqual(small.transform, [-88, 0.02, 0, 42, 0, -0.02]);
  const asc = await G.writeRaster(dem, { format: 'AAIGrid', name: 'dem', crs: 'EPSG:32616' });
  assert.equal(asc.filename, 'dem.zip'); // .asc + .prj
});

test('info() and loaded files as command inputs', async () => {
  const vi = await G.info(LAYERS.counties);
  assert.equal(vi.kind, 'vector');
  assert.equal(vi.layers[0].featureCount, 2);
  FILES['parks.gpkg'] = harness.fixture('gdal/parks.gpkg');
  FILES['roads_3435.zip'] = harness.fixture('gdal/roads_3435.zip');
  const fi = await G.info({ name: 'parks.gpkg', bytes: FILES['parks.gpkg'] });
  assert.deepEqual(fi.layers.map((l) => l.name), ['parks', 'trees']);
  const r = await run('ogr2ogr -where "height_m > 15" tall parks.gpkg trees');
  assert.deepEqual(r.layers[0].fc.features.map((f) => f.properties.species), ['Quercus alba', 'Ulmus americana']);
  const z = await run('ogrinfo -so roads_3435.zip roads_3435');
  assert.match(z.text, /Feature Count: 2/);
});

test('every job cleans up the in-memory file system', () => {
  const FS = runtime.gdal.Module.FS;
  const entries = (dir) => (FS.analyzePath(dir).exists ? FS.readdir(dir).filter((n) => n[0] !== '.') : []);
  assert.deepEqual(entries('/psicits'), []);
  assert.deepEqual(entries('/input'), [], 'gdal3.js mount points are left alone');
  assert.deepEqual(entries('/output'), []);
});

test('coexists with direct gdal3.js use of the same instance (Gdal.open mounts /input)', async () => {
  const Gdal = await harness.initGdal();
  const opened = await Gdal.open(path.join(harness.ROOT, 'tests', 'fixtures', 'gdal', 'parks.gpkg'));
  try {
    assert.equal(opened.datasets.length, 1);
    const r = await run('ogr2ogr -where "lanes = 2" narrow roads');
    assert.equal(r.layers[0].fc.features.length, 1);
  } finally {
    opened.datasets.forEach((d) => Gdal.close(d));
  }
});

test('help() lists programs with layer-name examples', () => {
  const h = G.help();
  for (const p of G.programs) assert.ok(h.includes(p), p);
  assert.match(h, /-dialect SQLite/);
  assert.match(G.help('gdalwarp'), /gdalwarp -t_srs EPSG:3857 -r bilinear dem dem_3857\.tif/);
  assert.match(G.help('gdal_rasterize'), /gdal_rasterize -a population -tr 0\.01 0\.01 counties pop\.tif/);
});
