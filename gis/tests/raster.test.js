'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const h = require('./harness');

const M = h.load('raster');
const R = M.raster;

/* ------------------------------------------------------------ helpers */

function near(actual, expected, tol, msg) {
  assert.ok(Math.abs(actual - expected) <= tol, (msg ? msg + ': ' : '') + 'expected ' + expected + ' ± ' + tol + ', got ' + actual);
}

function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function fixture(name) {
  const b = h.fixture('raster/' + name + '.tif');
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
}

/** 100 x 80 gradient in EPSG:4326 over [-90, 40, -80, 48]; value = col + 100 * row. */
function grad4326(extra) {
  const W = 100, H = 80;
  const a = new Float32Array(W * H);
  for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) a[r * W + c] = c + 100 * r;
  return R.create(Object.assign({ width: W, height: H, bands: [a], bbox: [-90, 40, -80, 48], crs: 'EPSG:4326' }, extra));
}

/** 100 x 80 gradient in EPSG:32616 (30 m pixels near Chicago); value = col + 100 * row. */
function gradUTM(extra) {
  const W = 100, H = 80;
  const a = new Float32Array(W * H);
  for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) a[r * W + c] = c + 100 * r;
  return R.create(Object.assign({ width: W, height: H, bands: [a], transform: [440000, 30, 0, 4640000, 0, -30], crs: 'EPSG:32616' }, extra));
}

const toLL = (crs) => M.crs.transformer(crs, 'EPSG:4326');
const fromLL = (crs) => M.crs.transformer('EPSG:4326', crs);

/** lon/lat of a pixel centre. */
function pixelLL(raster, c, r) {
  const t = raster.transform;
  return toLL(raster.crs)([t[0] + (c + 0.5) * t[1], t[3] + (r + 0.5) * t[5]]);
}

/** lon/lat of an output pixel centre of a render() result (Web Mercator grid). */
function outPixelLL(img, i, j) {
  const Rm = 6378137, D = Math.PI / 180;
  const x0 = img.coordinates[0][0] * D * Rm, x1 = img.coordinates[1][0] * D * Rm;
  const my = (lat) => Rm * Math.log(Math.tan(Math.PI / 4 + (lat * D) / 2));
  const y1 = my(img.coordinates[0][1]), y0 = my(img.coordinates[3][1]);
  const X = x0 + ((i + 0.5) * (x1 - x0)) / img.width, Y = y1 - ((j + 0.5) * (y1 - y0)) / img.height;
  return [X / Rm / D, (2 * Math.atan(Math.exp(Y / Rm)) - Math.PI / 2) / D];
}

function px(img, i, j) {
  const o = (j * img.width + i) * 4;
  return Array.from(img.data.slice(o, o + 4));
}

function rampColor(name, v, lo, hi) {
  const lut = M.colors.rampLUT(name);
  let q = Math.round(((v - lo) / (hi - lo)) * 255);
  q = Math.max(0, Math.min(255, q));
  return [lut[q * 3], lut[q * 3 + 1], lut[q * 3 + 2], 255];
}

function checksum(arr) {
  let s = 0;
  for (let i = 0; i < arr.length; i++) s = (s * 31 + (arr[i] === arr[i] ? arr[i] : 7)) % 1e9;
  return s;
}

function box(x0, y0, x1, y1, props) {
  return { type: 'Feature', properties: props || {}, geometry: { type: 'Polygon', coordinates: [[[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]]] } };
}

function point(lng, lat, props) {
  return { type: 'Feature', properties: props || {}, geometry: { type: 'Point', coordinates: [lng, lat] } };
}

/* -------------------------------------------------------------- create */

test('create derives transform from bbox and bbox from transform', () => {
  const a = R.create({ width: 4, height: 2, bands: [new Float32Array(8)], bbox: [0, 0, 4, 2] });
  assert.deepEqual(a.transform, [0, 1, 0, 2, 0, -1]);
  assert.deepEqual(a.bbox, [0, 0, 4, 2]);
  assert.equal(a.crs, 'EPSG:4326');
  assert.equal(a.dataType, 'float32');
  assert.deepEqual(a.bandNames, ['b1']);
  assert.equal(a.noData, null);
  assert.equal(a.stats, null);
  assert.deepEqual(a.meta, {});

  const b = R.create({ width: 10, height: 5, bands: [new Uint16Array(50), new Uint16Array(50)], transform: [100, 2, 0, 50, 0, -2], crs: 32616, noData: 0 });
  assert.deepEqual(b.bbox, [100, 40, 120, 50]);
  assert.equal(b.crs, 'EPSG:32616');
  assert.equal(b.dataType, 'uint16');
  assert.deepEqual(b.bandNames, ['b1', 'b2']);
  assert.equal(b.noData, 0);
});

test('create validates input with readable errors', () => {
  assert.throws(() => R.create({ width: 4, height: 2, bands: [new Float32Array(7)], bbox: [0, 0, 1, 1] }), /Band 1 has 7 values, but a 4 × 2 raster needs 8/);
  assert.throws(() => R.create({ width: 0, height: 2, bands: [new Float32Array(0)], bbox: [0, 0, 1, 1] }), /width and height/);
  assert.throws(() => R.create({ width: 2, height: 2, bands: [new Float32Array(4)] }), /bbox or a geotransform/);
  assert.throws(() => R.create({ width: 2, height: 2, bands: [new Float32Array(4)], transform: [0, 1, 0.1, 0, 0, -1] }), /Rotated/);
  assert.throws(() => R.create({ width: 2, height: 2, bands: [new Float32Array(4)], bbox: [0, 0, 0, 1] }), /empty/);
  assert.throws(() => R.create({ width: 2, height: 2, bands: [new Float32Array(4)], bbox: [0, 0, 1, 1], dataType: 'complex' }), /Unknown pixel type/);
});

test('create converts plain arrays, normalises noData and flips south-up grids without touching inputs', () => {
  const p = R.create({ width: 2, height: 1, bands: [[1, 2]], bbox: [0, 0, 2, 1], dataType: 'int16', noData: NaN });
  assert.ok(p.bands[0] instanceof Int16Array);
  assert.equal(p.noData, null);
  const f = R.create({ width: 2, height: 1, bands: [[1.5, 2.5]], bbox: [0, 0, 2, 1] });
  assert.equal(f.dataType, 'float64');
  const f32 = R.create({ width: 1, height: 1, bands: [new Float32Array([0.1])], bbox: [0, 0, 1, 1], noData: 0.1 });
  assert.equal(f32.noData, Math.fround(0.1));

  const src = new Float32Array([1, 2, 3, 4]);
  const s = R.create({ width: 2, height: 2, bands: [src], transform: [0, 1, 0, 0, 0, 1] });
  assert.deepEqual(s.transform, [0, 1, 0, 2, 0, -1]);
  assert.deepEqual(Array.from(s.bands[0]), [3, 4, 1, 2]);
  assert.deepEqual(Array.from(src), [1, 2, 3, 4]);
  assert.equal(R.bandIndex(R.create({ width: 1, height: 1, bands: [[1], [2]], bbox: [0, 0, 1, 1], bandNames: ['red', 'nir'] }), 'NIR'), 1);
  const clamped = new Uint8ClampedArray([1, 2]);
  const c = R.create({ width: 2, height: 1, bands: [clamped], bbox: [0, 0, 2, 1] });
  assert.ok(c.bands[0] instanceof Uint8Array, 'Uint8ClampedArray -> Uint8Array view');
  assert.equal(c.bands[0].buffer, clamped.buffer, 'no copy');
  assert.equal(c.dataType, 'uint8');
});

/* ------------------------------------------------------------- GeoTIFF */

test('GeoTIFF round trip through GeoTIFF.writeArrayBuffer (projected CRS, noData, float32)', async () => {
  const W = 20, H = 10;
  const vals = new Float32Array(W * H);
  for (let i = 0; i < W * H; i++) vals[i] = i * 0.5;
  vals[0] = -9999;
  const ab = GeoTIFF.writeArrayBuffer(vals, {
    width: W, height: H, ModelPixelScale: [30, 30, 0], ModelTiepoint: [0, 0, 0, 440000, 4640000, 0],
    GTModelTypeGeoKey: 1, GTRasterTypeGeoKey: 1, ProjectedCSTypeGeoKey: 32616, GDAL_NODATA: '-9999',
  });
  const r = await R.fromGeoTIFF(ab);
  assert.equal(r.width, W);
  assert.equal(r.height, H);
  assert.equal(r.crs, 'EPSG:32616');
  assert.deepEqual(r.transform, [440000, 30, 0, 4640000, 0, -30]);
  assert.deepEqual(r.bbox, [440000, 4639700, 440600, 4640000]);
  assert.equal(r.noData, -9999);
  assert.equal(r.dataType, 'float32');
  assert.deepEqual(r.bandNames, ['b1']);
  assert.deepEqual(Array.from(r.bands[0]), Array.from(vals));
  assert.equal(r.meta.format, 'GeoTIFF');
  assert.equal(R.stats(r)[0].count, W * H - 1);
});

test('GeoTIFF round trip: RGB uint8 image, ModelTransformation, geographic CRS', async () => {
  const W = 6, H = 4;
  const inter = new Uint8Array(W * H * 3);
  for (let i = 0; i < W * H; i++) { inter[3 * i] = i; inter[3 * i + 1] = 100 + i; inter[3 * i + 2] = 200 + i; }
  const ab = GeoTIFF.writeArrayBuffer(inter, {
    width: W, height: H, GeographicTypeGeoKey: 4326, GTModelTypeGeoKey: 2,
    ModelTransformation: [0.5, 0, 0, 10, 0, -0.25, 0, 50, 0, 0, 0, 0, 0, 0, 0, 1],
  });
  const r = await R.fromGeoTIFF(ab);
  assert.equal(r.crs, 'EPSG:4326');
  assert.deepEqual(r.transform, [10, 0.5, 0, 50, 0, -0.25]);
  assert.equal(r.bands.length, 3);
  assert.equal(r.dataType, 'uint8');
  assert.equal(r.bands[1][5], 105);
  assert.equal(r.meta.photometric, 2);
  assert.deepEqual(R.defaultStyle(r), { mode: 'rgb', bands: [0, 1, 2] });
  const img = R.render(r, null, { minSize: 0 });
  assert.equal(img.width, 6);
  assert.deepEqual(px(img, 5, 0), [5, 105, 205, 255]);
  assert.equal(img.style.mode, 'rgb');
  assert.deepEqual(img.style.min, [0, 0, 0]);
  assert.deepEqual(img.style.max, [255, 255, 255]);
});

test('GeoTIFF YCbCr pixels are converted to RGB', async () => {
  // Pure red, green, blue, white encoded as full-range (JFIF) YCbCr.
  const rgb = [[255, 0, 0], [0, 255, 0], [0, 0, 255], [255, 255, 255]];
  const inter = new Uint8Array(12);
  rgb.forEach(([r, g, b], i) => {
    inter[3 * i] = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
    inter[3 * i + 1] = Math.max(0, Math.min(255, Math.round(128 - 0.168736 * r - 0.331264 * g + 0.5 * b)));
    inter[3 * i + 2] = Math.max(0, Math.min(255, Math.round(128 + 0.5 * r - 0.418688 * g - 0.081312 * b)));
  });
  const ab = GeoTIFF.writeArrayBuffer(inter, { width: 4, height: 1, PhotometricInterpretation: 6, GeographicTypeGeoKey: 4326, ModelPixelScale: [1, 1, 0], ModelTiepoint: [0, 0, 0, 0, 1, 0] });
  const r = await R.fromGeoTIFF(ab);
  assert.equal(r.meta.convertedFrom, 'YCbCr');
  rgb.forEach((c, i) => {
    for (let k = 0; k < 3; k++) near(r.bands[k][i], c[k], 3, 'pixel ' + i + ' channel ' + k);
  });
});

test('GeoTIFF bigger than maxPixels is read at reduced size', async () => {
  const W = 200, H = 100;
  const vals = new Float32Array(W * H);
  for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) vals[r * W + c] = c + 1000 * r;
  const ab = GeoTIFF.writeArrayBuffer(vals, { width: W, height: H, GeographicTypeGeoKey: 4326, ModelPixelScale: [0.01, 0.01, 0], ModelTiepoint: [0, 0, 0, 5, 45, 0] });
  const r = await R.fromGeoTIFF(ab, { maxPixels: 5000 });
  assert.equal(r.width, 100);
  assert.equal(r.height, 50);
  assert.equal(r.meta.downsample, 2);
  assert.deepEqual(r.meta.fullSize, [200, 100]);
  near(r.transform[1], 0.02, 1e-12);
  near(r.transform[5], -0.02, 1e-12);
  assert.deepEqual(r.bbox.map((v) => +v.toFixed(9)), [5, 44, 7, 45]);
  // Output pixel (i, j) samples the source pixel under its centre: (2i+1, 2j+1).
  assert.equal(r.bands[0][0], 1 + 1000);
  assert.equal(r.bands[0][3 * 100 + 7], 15 + 7000);
});

test('fixture: palette GeoTIFF gives a colormap, palette style and correct colours', async () => {
  const r = await R.fromGeoTIFF(fixture('palette'));
  assert.equal(r.crs, 'EPSG:4326');
  assert.deepEqual(r.transform, [-88, 0.25, 0, 42, 0, -0.25]);
  assert.equal(r.noData, 0);
  assert.equal(r.meta.photometric, 3);
  assert.equal(r.meta.colormap.length, 256);
  assert.deepEqual(r.meta.colormap.slice(1, 4), [[31, 120, 180], [51, 160, 44], [227, 26, 28]]);
  const st = R.defaultStyle(r);
  assert.equal(st.mode, 'palette');
  const img = R.render(r, st, { minSize: 0 });
  assert.equal(img.width, 8);
  assert.deepEqual(px(img, 0, 0), [0, 0, 0, 0]);             // no-data
  assert.deepEqual(px(img, 1, 0), [31, 120, 180, 255]);      // value 1
  assert.deepEqual(px(img, 4, 3).slice(0, 3), [51, 160, 44]);
  assert.deepEqual(px(img, 7, 5).slice(0, 3), [227, 26, 28]);
  assert.deepEqual(img.style.categories.map((c) => c.value), [1, 2, 3]);
  assert.equal(img.style.categories[0].color, '#1f78b4');
});

test('fixture: band descriptions, scale/offset and dataset metadata from GDAL', async () => {
  const r = await R.fromGeoTIFF(fixture('bands'));
  assert.deepEqual(r.bandNames, ['red', 'green', 'nir']);
  assert.equal(r.dataType, 'uint16');
  assert.equal(r.crs, 'EPSG:32616');
  assert.equal(r.noData, 0);
  assert.deepEqual(r.meta.scale, [1, 1, 0.0001]);
  assert.equal(r.meta.metadata.SENSOR, 'synthetic');
  assert.equal(r.bands[2][2 * 6 + 3], 1000 + 30 + 2);
  assert.equal(R.bandIndex(r, 'nir'), 2);
  assert.equal(R.bandIndex(r, 'b2'), 1);
  assert.throws(() => R.bandIndex(r, 'b7'), /has 3 bands .*b1 "red".*there is no band "b7"/);
});

test('fixture: user-defined Albers (NAD83) becomes an equivalent proj4 CRS', async () => {
  const r = await R.fromGeoTIFF(fixture('albers'));
  assert.match(r.crs, /^\+proj=aea /);
  assert.match(r.crs, /\+lat_1=29\.5 \+lat_2=45\.5 \+lat_0=23 \+lon_0=-96/);
  assert.equal(r.meta.crsUserDefined, true);
  assert.equal(r.noData, -9999);
  // Same numbers as the built-in EPSG:5070 (NAD83 / Conus Albers).
  const a = M.crs.transformer(r.crs, 'EPSG:4326')([688350, 2128250]);
  const b = M.crs.transformer('EPSG:5070', 'EPSG:4326')([688350, 2128250]);
  near(a[0], b[0], 1e-9); near(a[1], b[1], 1e-9);
  const ll = M.crs.transformer('EPSG:5070', 'EPSG:4326')([688000 + 3.5 * 100, 2128500 - 2.5 * 100]);
  assert.deepEqual(R.valueAt(r, ll[0], ll[1]), [3 + 200 + 0.5]);
  const info = R.info(r);
  assert.equal(info.crsName, 'Albers Equal Area (user-defined)');
  assert.equal(info.pixelUnits, 'm');
});

test('fixture: user-defined MODIS sinusoidal sphere is located correctly', async () => {
  const r = await R.fromGeoTIFF(fixture('sinusoidal'));
  assert.match(r.crs, /^\+proj=sinu .*\+R=6371007\.181/);
  assert.equal(r.dataType, 'int16');
  assert.equal(r.noData, -3000);
  // Independent inverse sinusoidal: lat = y / R, lon = x / (R cos lat).
  const Rs = 6371007.181, s = 463.312716528;
  for (const [c, rr] of [[0, 0], [5, 3], [7, 7]]) {
    const x = -7255000 + (c + 0.5) * s, y = 4657000 - (rr + 0.5) * s;
    const lat = y / Rs, lon = x / (Rs * Math.cos(lat));
    assert.deepEqual(R.valueAt(r, (lon * 180) / Math.PI, (lat * 180) / Math.PI), [10 * c + rr]);
  }
});

test('fixture: user-defined geographic CRS on a sphere', async () => {
  const r = await R.fromGeoTIFF(fixture('geog_sphere'));
  assert.ok(M.crs.isGeographic(r.crs));
  assert.deepEqual(R.bboxWGS84(r).map((v) => +v.toFixed(9)), [10, 46, 14, 50]);
  assert.deepEqual(R.valueAt(r, 11.5, 48.5), [6]);
});

test('fixture: COG overviews are used when the image exceeds maxPixels', async () => {
  const full = await R.fromGeoTIFF(fixture('cog'));
  assert.equal(full.width, 1024);
  assert.equal(full.height, 768);
  assert.deepEqual(full.bandNames, ['col', 'row']);
  assert.equal(full.meta.downsample, undefined);

  const ov = await R.fromGeoTIFF(fixture('cog'), { maxPixels: 512 * 384 });
  assert.equal(ov.width, 512);
  assert.equal(ov.height, 384);
  assert.equal(ov.meta.overviewLevel, 1);
  assert.equal(ov.meta.downsample, 2);
  assert.deepEqual(ov.transform, [-9780000, 20, 0, 5150000, 0, -20]);
  assert.deepEqual(ov.bbox, full.bbox);
  // Overview pixel (i, j) covers full-resolution columns 2i..2i+1 and rows 2j..2j+1.
  for (const i of [0, 7, 300, 511]) {
    const v = ov.bands[0][10 * 512 + i];
    assert.ok(v === 2 * i || v === 2 * i + 1, 'col ' + i + ' -> ' + v);
  }
  for (const j of [0, 5, 200, 383]) {
    const v = ov.bands[1][j * 512 + 17];
    assert.ok(v === 2 * j || v === 2 * j + 1, 'row ' + j + ' -> ' + v);
  }

  const small = await R.fromGeoTIFF(fixture('cog'), { maxPixels: 10000 });
  assert.ok(small.width * small.height <= 10000);
  assert.equal(small.meta.overviewLevel, 2);
  near(small.meta.downsample, Math.max(1024 / small.width, 768 / small.height), 1e-9);
  assert.deepEqual(small.bbox.map((v) => Math.round(v)), full.bbox.map((v) => Math.round(v)));
  // Values still describe the full-resolution column/row under each pixel (within one overview cell).
  const c = 50, rr = 40;
  const expCol = ((c + 0.5) * 1024) / small.width, expRow = ((rr + 0.5) * 768) / small.height;
  near(small.bands[0][rr * small.width + c], expCol, 4.5);
  near(small.bands[1][rr * small.width + c], expRow, 4.5);
});

test('fixture: alpha band, PixelIsPoint, no georeferencing, rotation', async () => {
  const rgba = await R.fromGeoTIFF(fixture('rgba'));
  assert.equal(rgba.meta.alphaBand, 3);
  assert.equal(rgba.bandNames[3], 'alpha');
  assert.deepEqual(R.defaultStyle(rgba), { mode: 'rgb', bands: [0, 1, 2], alpha: 3 });
  const img = R.render(rgba, null, { minSize: 0 });
  assert.equal(img.width, 4);
  assert.equal(px(img, 2, 0)[3], 0);                     // alpha 0 on the top row
  assert.deepEqual(px(img, 2, 1), [120, 60, 128, 255]);

  const pip = await R.fromGeoTIFF(fixture('pixel_is_point'));
  assert.deepEqual(pip.transform, [500000, 10, 0, 4600000, 0, -10]);   // same as GDAL reports

  const ng = await R.fromGeoTIFF(fixture('nogeoref'));
  assert.equal(ng.crs, null);
  assert.equal(ng.meta.crsUnknown, true);
  assert.equal(ng.meta.georeferenced, false);
  assert.deepEqual(Array.from(ng.bands[0]), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  assert.throws(() => R.render(ng), (e) => e.code === 'CRS_MISSING' && /no coordinate reference system/.test(e.message));

  const rot = await R.fromGeoTIFF(fixture('rotated'));
  assert.equal(rot.crs, 'EPSG:32616');
  assert.ok(rot.meta.warnings.some((w) => /rotated/.test(w)));
  assert.deepEqual([rot.transform[2], rot.transform[4]], [0, 0]);
  assert.deepEqual(rot.bbox, [500000, 4599960, 500048, 4600004]);
});

test('fixture: internal GDAL masks become an alpha band (integer data) or NaN (float data)', async () => {
  const rgb = await R.fromGeoTIFF(fixture('rgb_mask'));
  assert.equal(rgb.bands.length, 4);
  assert.deepEqual(rgb.bandNames, ['b1', 'b2', 'b3', 'mask']);
  assert.equal(rgb.meta.mask, true);
  assert.equal(rgb.meta.alphaBand, 3);
  assert.deepEqual(Array.from(rgb.bands[3]), [0, 0, 0, 0].concat(new Array(12).fill(255)));
  assert.deepEqual(R.defaultStyle(rgb), { mode: 'rgb', bands: [0, 1, 2], alpha: 3 });
  const img = R.render(rgb, null, { minSize: 0 });
  assert.equal(px(img, 1, 0)[3], 0, 'masked');
  assert.deepEqual(px(img, 1, 1), [70, 70, 128, 255]);

  const fl = await R.fromGeoTIFF(fixture('float_mask'));
  assert.equal(fl.bands.length, 1);
  assert.equal(fl.noData, null);
  assert.ok(Number.isNaN(fl.bands[0][2]), 'masked float pixel -> NaN');
  assert.equal(fl.bands[0][5], 6);
  assert.equal(R.stats(fl)[0].count, 12);
});

test('GeoTIFF CMYK pixels are converted to RGB; WhiteIsZero defaults to an inverted gray ramp', async () => {
  const cmyk = [[0, 255, 255, 0], [0, 0, 0, 0], [0, 0, 0, 255], [255, 0, 255, 0]];
  const ab = GeoTIFF.writeArrayBuffer(new Uint8Array([].concat(...cmyk)), {
    width: 4, height: 1, PhotometricInterpretation: 5, GeographicTypeGeoKey: 4326, ModelPixelScale: [1, 1, 0], ModelTiepoint: [0, 0, 0, 0, 1, 0],
  });
  const r = await R.fromGeoTIFF(ab);
  assert.equal(r.meta.convertedFrom, 'CMYK');
  assert.equal(r.bands.length, 3);
  const rgbAt = (i) => [r.bands[0][i], r.bands[1][i], r.bands[2][i]];
  assert.deepEqual([rgbAt(0), rgbAt(1), rgbAt(2), rgbAt(3)], [[255, 0, 0], [255, 255, 255], [0, 0, 0], [0, 255, 0]]);

  const wiz = R.create({ width: 2, height: 1, bands: [new Uint8Array([0, 255])], bbox: [0, 0, 2, 1], meta: { photometric: 0 } });
  const st = R.defaultStyle(wiz);
  assert.equal(st.mode, 'gray');
  assert.equal(st.invert, true);
  const img = R.render(wiz, st, { minSize: 0 });
  assert.deepEqual(px(img, 0, 0), [255, 255, 255, 255]);
  assert.deepEqual(px(img, 1, 0), [0, 0, 0, 255]);
});

test('fromGeoTIFF rejects files that are not TIFFs with a readable error', async () => {
  await assert.rejects(R.fromGeoTIFF(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]).buffer), /could not be read as a GeoTIFF/);
  await assert.rejects(R.fromGeoTIFF('nope'), /ArrayBuffer/);
});

/* --------------------------------------------------------------- stats */

test('stats: exact integer percentiles, mean, std; no-data and NaN ignored', () => {
  const W = 100, H = 100;
  const a = new Uint16Array(W * H);
  for (let i = 0; i < a.length; i++) a[i] = i;
  const r = Object.freeze(R.create({ width: W, height: H, bands: [a], bbox: [0, 0, 1, 1] }));
  const s = R.stats(r)[0];
  assert.equal(s.count, 10000);
  assert.equal(s.min, 0);
  assert.equal(s.max, 9999);
  near(s.mean, 4999.5, 1e-9);
  near(s.std, Math.sqrt((10000 * 10000 - 1) / 12), 1e-6);
  near(s.p2, 199.98, 1e-9);
  near(s.p98, 9799.02, 1e-9);
  assert.equal(r.stats, null, 'stats() must not modify the raster');

  const f = new Float32Array(W * H);
  for (let i = 0; i < f.length; i++) f[i] = i + 0.5;
  f[0] = NaN; f[1] = -1;
  const rf = R.create({ width: W, height: H, bands: [f], bbox: [0, 0, 1, 1], noData: -1 });
  const sf = R.stats(rf)[0];
  assert.equal(sf.count, 9998);
  assert.equal(sf.min, 2.5);
  assert.equal(sf.max, 9999.5);
  near(sf.p2, 2.5 + 0.02 * 9997, 2.5);
  near(sf.p98, 2.5 + 0.98 * 9997, 2.5);

  const empty = R.create({ width: 2, height: 1, bands: [new Float32Array([NaN, NaN])], bbox: [0, 0, 1, 1] });
  assert.deepEqual(R.stats(empty)[0], { min: null, max: null, mean: null, std: null, count: 0, p2: null, p98: null });

  // Large values: shifted sums keep the variance accurate.
  const big = new Float64Array([1e9 + 1, 1e9 + 2, 1e9 + 3, 1e9 + 4]);
  near(R.stats(R.create({ width: 4, height: 1, bands: [big], bbox: [0, 0, 1, 1] }))[0].std, Math.sqrt(1.25), 1e-9);
});

test('stats honours caller-cached raster.stats and { force }', () => {
  const r = grad4326();
  const cached = [{ min: 1, max: 2, mean: 1.5, std: 0.5, count: 2, p2: 1, p98: 2 }];
  const withStats = Object.assign({}, r, { stats: cached });
  assert.equal(R.stats(withStats)[0].max, 2);
  assert.equal(R.stats(withStats, { force: true })[0].max, 7999);
});

test('histogram counts every valid pixel into bins', () => {
  const r = grad4326();
  const hgm = R.histogram(r, 0, 8);
  assert.equal(hgm.edges.length, 9);
  assert.equal(hgm.counts.length, 8);
  assert.equal(hgm.edges[0], 0);
  assert.equal(hgm.edges[8], 7999);
  assert.equal(hgm.counts.reduce((a, b) => a + b, 0), 8000);
  const part = R.histogram(r, 0, 4, { min: 0, max: 99 });
  assert.equal(part.counts.reduce((a, b) => a + b, 0), 100);
  assert.deepEqual(part.counts, [25, 25, 25, 25]);
});

/* --------------------------------------------------------------- render */

test('render: EPSG:4326 raster -> Web Mercator image with correct corners and colours', () => {
  const r = grad4326({ noData: 0 });
  const img = R.render(r, { mode: 'singleband', ramp: 'viridis', stretch: 'minmax' }, { minSize: 0 });
  assert.equal(img.width, 100);
  assert.ok(img.height >= 80 && img.height <= 2048);
  assert.equal(img.data.length, img.width * img.height * 4);
  assert.ok(img.data instanceof Uint8ClampedArray);
  const c = img.coordinates;
  near(c[0][0], -90, 1e-9); near(c[0][1], 48, 1e-9);
  near(c[1][0], -80, 1e-9); near(c[1][1], 48, 1e-9);
  near(c[2][0], -80, 1e-9); near(c[2][1], 40, 1e-9);
  near(c[3][0], -90, 1e-9); near(c[3][1], 40, 1e-9);
  assert.equal(img.style.min, 1);
  assert.equal(img.style.max, 7999);
  assert.equal(img.style.ramp, 'viridis');
  assert.deepEqual(px(img, 0, 0), [0, 0, 0, 0], 'no-data pixel is transparent');
  const rnd = mulberry32(1);
  for (let k = 0; k < 200; k++) {
    const i = Math.floor(rnd() * img.width), j = Math.floor(rnd() * img.height);
    const ll = outPixelLL(img, i, j);
    const v = R.valueAt(r, ll[0], ll[1])[0];
    if (v === null) { assert.equal(px(img, i, j)[3], 0); continue; }
    assert.deepEqual(px(img, i, j), rampColor('viridis', v, 1, 7999), 'pixel ' + i + ',' + j);
  }
});

test('render: default percentile stretch, invert, gray and classes', () => {
  const r = grad4326();
  const st = R.stats(r)[0];
  const img = R.render(r);
  assert.equal(img.style.mode, 'singleband');
  assert.equal(img.style.stretch, 'percentile');
  assert.equal(img.style.min, st.p2);
  assert.equal(img.style.max, st.p98);

  const inv = R.render(r, { ramp: 'magma', min: 0, max: 7999, invert: true });
  assert.deepEqual(px(inv, 0, 0), rampColor('magma', 7999, 0, 7999));

  const gray = R.render(r, { mode: 'gray', min: 0, max: 7999 });
  assert.equal(gray.style.ramp, 'gray');
  const g = px(gray, 50, 0);
  assert.equal(g[0], g[1]); assert.equal(g[1], g[2]);

  const cls = R.render(r, { classes: [{ max: 50, color: 'red' }, { max: 4000, color: '#0000ff' }, { max: null, color: 'rgba(0,255,0,0.5)', label: 'high' }] }, { minSize: 0 });
  assert.deepEqual(px(cls, 0, 0), [255, 0, 0, 255]);         // value 0
  assert.deepEqual(px(cls, 99, 0), [0, 0, 255, 255]);        // value 99
  const low = px(cls, 5, cls.height - 1);                    // value ~7905
  assert.deepEqual(low.slice(0, 3), [0, 255, 0]);
  near(low[3], 127.5, 1);
  assert.deepEqual(cls.style.classes.map((x) => x.max), [50, 4000, null]);

  assert.throws(() => R.render(r, { mode: 'fancy' }), /Unknown raster style "fancy"/);
  assert.throws(() => R.render(r, { ramp: 'nope' }), /Unknown colour ramp "nope"/);
  assert.throws(() => R.render(r, { band: 3 }), /there is no band b4/);
});

test('render: UTM raster warps through a control grid with finite corners', () => {
  const r = gradUTM();
  const img = R.render(r, { stretch: 'minmax' }, { minSize: 0 });
  assert.ok(img.coordinates.every((p) => Number.isFinite(p[0]) && Number.isFinite(p[1])));
  const bb = R.bboxWGS84(r);
  near(img.coordinates[0][0], bb[0], 1e-9);
  near(img.coordinates[2][1], bb[1], 1e-9);
  assert.ok(img.width > 90 && img.width < 130, 'about source resolution: ' + img.width);
  let opaque = 0, transparent = 0;
  for (let i = 3; i < img.data.length; i += 4) { if (img.data[i] === 255) opaque++; else transparent++; }
  assert.ok(opaque > 0.9 * 8000, 'opaque ' + opaque);
  assert.ok(transparent > 0, 'the rotated footprint leaves transparent corners');
  let agree = 0, total = 0;
  const rnd = mulberry32(7);
  for (let k = 0; k < 300; k++) {
    const i = Math.floor(rnd() * img.width), j = Math.floor(rnd() * img.height);
    const ll = outPixelLL(img, i, j);
    const v = R.valueAt(r, ll[0], ll[1])[0];
    total++;
    if (v === null ? px(img, i, j)[3] === 0 : JSON.stringify(px(img, i, j)) === JSON.stringify(rampColor('viridis', v, 0, 7999))) agree++;
  }
  assert.ok(agree / total > 0.97, 'agreement ' + agree + '/' + total);
});

test('render: rgb and palette modes', () => {
  const W = 4, H = 2, n = W * H;
  const rr = new Uint8Array(n), gg = new Uint8Array(n), bb = new Uint8Array(n);
  for (let i = 0; i < n; i++) { rr[i] = 10 * i; gg[i] = 255 - 10 * i; bb[i] = 7; }
  rr[3] = 0; gg[3] = 0; bb[3] = 0;
  const rgb = R.create({ width: W, height: H, bands: [rr, gg, bb], bbox: [0, 0, 4, 2], noData: 0 });
  const img = R.render(rgb, { mode: 'rgb', bands: [0, 1, 2] }, { minSize: 0 });
  assert.equal(img.width, 4);
  assert.deepEqual(px(img, 1, 0), [10, 245, 7, 255]);
  assert.deepEqual(px(img, 3, 0), [0, 0, 0, 0], 'all three bands no-data -> transparent');
  assert.deepEqual(px(img, 0, 0), [0, 255, 7, 255], 'a zero in one band is still a colour');
  const swapped = R.render(rgb, { mode: 'rgb', bands: [2, 1, 0], min: [0, 0, 0], max: [14, 255, 255] }, { minSize: 0 });
  assert.deepEqual(px(swapped, 1, 0), [128, 245, 10, 255]);

  const u16 = R.create({ width: 2, height: 1, bands: [new Uint16Array([100, 1100]), new Uint16Array([100, 1100]), new Uint16Array([100, 1100])], bbox: [0, 0, 2, 1] });
  const st = R.render(u16, null, { minSize: 0 });
  assert.equal(st.style.mode, 'rgb');
  assert.deepEqual(st.style.min, [120, 120, 120]);
  assert.deepEqual(st.style.max, [1080, 1080, 1080]);

  const cat = R.create({ width: 3, height: 1, bands: [new Uint8Array([1, 2, 9])], bbox: [0, 0, 3, 1] });
  const pal = R.render(cat, { mode: 'palette', categories: [{ value: 1, color: '#ff0000', label: 'one' }, { value: 2, color: 'blue' }] }, { minSize: 0 });
  assert.deepEqual(px(pal, 0, 0), [255, 0, 0, 255]);
  assert.deepEqual(px(pal, 1, 0), [0, 0, 255, 255]);
  assert.deepEqual(px(pal, 2, 0), [0, 0, 0, 0], 'values without a category are transparent');
  assert.deepEqual(pal.style.categories, [{ value: 1, color: '#ff0000', label: 'one' }, { value: 2, color: '#0000ff', label: '2' }]);
  const pal2 = R.render(cat, { mode: 'palette', categories: [{ value: 1, color: 'red' }], defaultColor: '#cccccc' }, { minSize: 0 });
  assert.deepEqual(px(pal2, 2, 0), [204, 204, 204, 255]);
  // Float bands use a lookup map.
  const fcat = R.create({ width: 2, height: 1, bands: [new Float32Array([0.1, 0.2])], bbox: [0, 0, 2, 1] });
  const pal3 = R.render(fcat, { mode: 'palette', categories: [{ value: 0.2, color: 'lime' }] }, { minSize: 0 });
  assert.deepEqual(px(pal3, 1, 0), [0, 255, 0, 255]);
  assert.equal(px(pal3, 0, 0)[3], 0);
});

test('render: size cap, small-raster upsampling and bilinear resampling', () => {
  const big = R.create({ width: 3000, height: 10, bands: [new Float32Array(30000).map((_, i) => i % 3000)], bbox: [0, 0, 30, 0.1] });
  const img = R.render(big, null, { maxSize: 512 });
  assert.equal(img.width, 512);
  assert.ok(img.height >= 1 && img.height <= 512);

  const tiny = R.create({ width: 4, height: 3, bands: [new Float32Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])], bbox: [0, 0, 4, 3] });
  const up = R.render(tiny, { min: 1, max: 12 });
  assert.equal(up.width % 4, 0);
  assert.ok(up.width >= 256, 'upsampled to ' + up.width);
  const f = up.width / 4;
  assert.deepEqual(px(up, 0, 0), px(up, f - 1, 0), 'whole source pixels map to blocks');
  assert.notDeepEqual(px(up, f - 1, 0), px(up, f, 0));
  const smooth = R.render(tiny, { min: 1, max: 12, resampling: 'bilinear' });
  assert.equal(smooth.style.resampling, 'bilinear');
  assert.notDeepEqual(px(smooth, f - 1, 0), px(smooth, f - 2 - Math.floor(f / 3), 0));
});

/* ---------------------------------------------------------- map algebra */

test('mapAlgebra: NDVI, no-data propagation and non-finite results', () => {
  const W = 10, H = 10, n = W * H;
  const red = new Float32Array(n), nir = new Float32Array(n);
  for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) { red[r * W + c] = 0.1 + c * 0.01; nir[r * W + c] = 0.5 + r * 0.01; }
  red[5] = -1;                     // no-data
  red[6] = 0; nir[6] = 0;          // 0/0 -> NaN -> no-data
  const img = Object.freeze(R.create({ width: W, height: H, bands: [red, nir], bbox: [0, 0, 1, 1], noData: -1, bandNames: ['red', 'nir'] }));
  const before = checksum(red);
  const out = R.mapAlgebra({ red: { raster: img, band: 'red' }, nir: { raster: img, band: 1 } }, (v) => (v.nir - v.red) / (v.nir + v.red));
  assert.equal(out.dataType, 'float32');
  assert.equal(out.noData, -9999);
  assert.deepEqual(out.transform, img.transform);
  const exp = (c, r) => Math.fround(((0.5 + r * 0.01) - (0.1 + c * 0.01)) / ((0.5 + r * 0.01) + (0.1 + c * 0.01)));
  near(out.bands[0][3 * W + 4], exp(4, 3), 1e-6);
  near(out.bands[0][9 * W + 9], exp(9, 9), 1e-6);
  assert.equal(out.bands[0][5], -9999);
  assert.equal(out.bands[0][6], -9999);
  assert.equal(checksum(red), before);

  const mask = R.mapAlgebra({ a: img }, (v) => v.a > 0.15, { dataType: 'uint8' });
  assert.equal(mask.noData, 255);
  assert.equal(mask.bands[0][0], 0);
  assert.equal(mask.bands[0][9], 1);
  assert.equal(mask.bands[0][5], 255);
  assert.throws(() => R.mapAlgebra({}, () => 1), /at least one input/);
  assert.throws(() => R.mapAlgebra({ a: img }, () => 1, { dataType: 'uint8', noData: -5 }), /can't be stored as uint8/);
});

test('mapAlgebra resamples other grids (and CRSs) onto the first input', () => {
  const fine = grad4326();
  const coarse = R.create({ width: 50, height: 40, bands: [new Float32Array(2000).fill(1000)], bbox: [-90, 40, -80, 48] });
  for (let r = 0; r < 40; r++) for (let c = 0; c < 50; c++) coarse.bands[0][r * 50 + c] = c;
  const sum = R.mapAlgebra({ a: fine, b: coarse }, (v) => v.a + v.b);
  assert.equal(sum.width, 100);
  assert.equal(sum.bands[0][0], 0);
  assert.equal(sum.bands[0][10 * 100 + 21], 21 + 1000 + 10);    // coarse col = floor(21 / 2)

  // A raster in another CRS is reprojected onto the first grid.
  const utm = gradUTM();
  const res = R.mapAlgebra({ u: utm, g: grad4326() }, (v) => v.g);
  assert.equal(res.crs, 'EPSG:32616');
  const ll = pixelLL(utm, 50, 40);
  assert.equal(res.bands[0][40 * 100 + 50], R.valueAt(grad4326(), ll[0], ll[1])[0]);
  const far = R.create({ width: 2, height: 2, bands: [new Float32Array(4)], bbox: [100, 0, 101, 1] });
  assert.throws(() => R.mapAlgebra({ a: grad4326(), b: far }, (v) => v.a), /"b" doesn't overlap "a"/);
});

/* ------------------------------------------------------------ resample */

test('resampleTo: same-CRS nearest and bilinear', () => {
  const r = grad4326();
  const fifth = R.resampleTo(r, { width: 20, height: 16, bbox: [-90, 40, -80, 48] });
  assert.equal(fifth.dataType, 'float32');
  assert.deepEqual(fifth.transform.map((v) => +v.toFixed(12)), [-90, 0.5, 0, 48, 0, -0.5]);
  // Target pixel i covers source pixels 5i..5i+4; its centre falls in 5i+2.
  for (const [i, j] of [[0, 0], [10, 7], [19, 15]]) assert.equal(fifth.bands[0][j * 20 + i], (5 * i + 2) + 100 * (5 * j + 2));

  const dbl = R.resampleTo(r, { width: 200, height: 160, bbox: [-90, 40, -80, 48] }, { method: 'bilinear' });
  // Interior: bilinear reproduces the linear gradient exactly: v = (c - 0.5) + 100 (r - 0.5) at source pixel coords.
  for (const [i, j] of [[5, 5], [101, 77], [150, 120]]) {
    const c = (i + 0.5) / 2, rr = (j + 0.5) / 2;
    near(dbl.bands[0][j * 200 + i], (c - 0.5) + 100 * (rr - 0.5), 1e-3);
  }
  const wider = R.resampleTo(r, { width: 12, height: 8, bbox: [-92, 40, -80, 48] });
  assert.ok(Number.isNaN(wider.bands[0][0]), 'outside the source -> NaN for float bands');
  assert.equal(wider.noData, null);
  assert.equal(wider.bands[0][11], 95 + 100 * 5);      // centre (-80.5, 47.5) -> source pixel (95, 5)
});

test('resampleTo reprojects EPSG:4326 onto a UTM grid', () => {
  const src = grad4326();
  const ll = [-87.6, 41.9];
  const c = fromLL('EPSG:32616')(ll);
  const out = R.resampleTo(src, { width: 60, height: 50, transform: [c[0] - 30000, 1000, 0, c[1] + 25000, 0, -1000], crs: 'EPSG:32616' });
  assert.equal(out.crs, 'EPSG:32616');
  let agree = 0;
  for (let j = 0; j < 50; j += 3) {
    for (let i = 0; i < 60; i += 3) {
      const p = pixelLL(out, i, j);
      if (out.bands[0][j * 60 + i] === R.valueAt(src, p[0], p[1])[0]) agree++;
    }
  }
  assert.ok(agree >= 0.97 * 17 * 20, 'agreement ' + agree);
  const u8 = R.create({ width: 2, height: 2, bands: [new Uint8Array([1, 2, 3, 4])], bbox: [0, 0, 2, 2] });
  const pad = R.resampleTo(u8, { width: 3, height: 2, bbox: [0, 0, 3, 2] });
  assert.equal(pad.noData, 0);
  assert.deepEqual(Array.from(pad.bands[0]), [1, 2, 0, 3, 4, 0]);
});

test('reprojection from a global lon/lat raster copes with the ±180° seam and the poles', () => {
  const W = 360, H = 180;
  const col = new Float64Array(W * H), row = new Float64Array(W * H);
  for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) { col[r * W + c] = c + 0.5; row[r * W + c] = r + 0.5; }
  const glob = R.create({ width: W, height: H, bands: [col, row], bbox: [-180, -90, 180, 90] });
  const grids = [
    { width: 200, height: 150, transform: [300000, 4000, 0, 3000000, 0, -4000], crs: 'EPSG:32660' },   // crosses 180°
    { width: 200, height: 200, transform: [-4e6, 40000, 0, 4e6, 0, -40000], crs: 'EPSG:3413' },       // North Pole inside
  ];
  for (const grid of grids) {
    // Bilinear sampling of a linear ramp returns the (interpolated) source position itself.
    const out = R.resampleTo(glob, grid, { method: 'bilinear' });
    const inv = toLL(grid.crs);
    let worst = 0, n = 0;
    for (let j = 0; j < out.height; j++) {
      for (let i = 0; i < out.width; i++) {
        const t = out.transform;
        const p = inv([t[0] + (i + 0.5) * t[1], t[3] + (j + 0.5) * t[5]]);
        const ec = p[0] + 180, er = 90 - p[1];
        if (ec < 1 || ec > W - 1 || er < 1 || er > H - 1) continue;    // bilinear clamps at the source edges / seam
        const k = j * out.width + i;
        worst = Math.max(worst, Math.abs(out.bands[0][k] - ec), Math.abs(out.bands[1][k] - er));
        n++;
      }
    }
    assert.ok(n > 0.5 * out.width * out.height, 'checked ' + n);
    assert.ok(worst < 0.13, grid.crs + ': worst interpolation error ' + worst + ' source px');
    // Nearest neighbour picks the right source column everywhere, including at the seam
    // (pixels closer to a column boundary than the 0.125 px tolerance may go either way).
    const nn = R.resampleTo(glob, grid);
    for (let k = 0; k < nn.bands[0].length; k += 3) {
      const i = k % nn.width, j = Math.floor(k / nn.width), t = nn.transform;
      const p = inv([t[0] + (i + 0.5) * t[1], t[3] + (j + 0.5) * t[5]]);
      const c = Math.floor(p[0] + 180);
      if (Math.abs(p[0] + 180 - c - 0.5) < 0.37 && c >= 0 && c < W) assert.equal(nn.bands[0][k], c + 0.5, grid.crs + ' pixel ' + i + ',' + j);
    }
  }
});

/* ----------------------------------------------------------- reclassify */

test('reclassify: ranges, equals, otherwise and no-data', () => {
  const vals = new Float32Array(100).map((_, i) => i);
  vals[99] = -1;
  const r = R.create({ width: 10, height: 10, bands: [vals], bbox: [0, 0, 1, 1], noData: -1 });
  const rules = [{ equals: 95, value: 3 }, { min: 0, max: 50, value: 1 }, { min: 50, max: 90, value: 2 }, { min: 90, max: 92, value: null }];
  const out = R.reclassify(r, 0, rules, { otherwise: 9 });
  assert.equal(out.dataType, 'int16');
  assert.equal(out.noData, -9999);
  assert.equal(out.bands.length, 1);
  const v = out.bands[0];
  assert.equal(v[0], 1); assert.equal(v[49], 1); assert.equal(v[50], 2); assert.equal(v[89], 2);
  assert.equal(v[90], -9999); assert.equal(v[92], 9); assert.equal(v[95], 3); assert.equal(v[99], -9999);
  const noOther = R.reclassify(r, 0, [{ min: 10, value: 5 }]);
  assert.equal(noOther.bands[0][3], -9999);
  assert.equal(noOther.bands[0][10], 5);

  const u8 = R.create({ width: 4, height: 1, bands: [new Uint8Array([0, 10, 200, 255])], bbox: [0, 0, 1, 1], noData: 255 });
  const lut = R.reclassify(u8, 0, [{ max: 100, value: 0.5 }, { min: 100, value: 1.5 }]);
  assert.equal(lut.dataType, 'float32');
  assert.deepEqual(Array.from(lut.bands[0]), [0.5, 0.5, 1.5, -9999]);
  assert.throws(() => R.reclassify(r, 0, []), /at least one rule/);
});

/* ---------------------------------------------------------- zonal stats */

test('zonalStats: sums and counts on pixel centres, holes, multipolygons, no overlap', () => {
  const W = 10, H = 10;
  const a = new Float32Array(W * H);
  for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) a[r * W + c] = c + 10 * r;
  const r = R.create({ width: W, height: H, bands: [a], bbox: [0, 0, 10, 10] });
  const holed = box(0, 6, 4, 10, { name: 'holed' });
  holed.geometry.coordinates.push([[1, 7], [3, 7], [3, 9], [1, 9], [1, 7]]);
  const fc = Object.freeze({
    type: 'FeatureCollection',
    features: [
      Object.assign(box(0, 6, 4, 10, { name: 'block' }), { id: 42 }),
      holed,
      { type: 'Feature', properties: { name: 'multi' }, geometry: { type: 'MultiPolygon', coordinates: [box(0, 8, 2, 10).geometry.coordinates, box(8, 0, 10, 2).geometry.coordinates] } },
      box(20, 20, 30, 30, { name: 'outside' }),
      { type: 'Feature', properties: { name: 'nogeom' }, geometry: null },
    ],
  });
  const out = R.zonalStats(r, 0, fc, { prefix: 'z_' });
  const p = out.features.map((f) => f.properties);
  assert.deepEqual(p[0], { name: 'block', z_count: 16, z_sum: 264, z_mean: 16.5, z_min: 0, z_max: 33 });
  assert.equal(out.features[0].id, undefined, 'ids are not copied');
  assert.equal(p[1].z_count, 12);
  assert.equal(p[1].z_sum, 264 - (11 + 12 + 21 + 22));
  assert.equal(p[2].z_count, 8);
  assert.equal(p[2].z_sum, 0 + 1 + 10 + 11 + 88 + 89 + 98 + 99);
  assert.deepEqual(p[3], { name: 'outside', z_count: 0, z_sum: null, z_mean: null, z_min: null, z_max: null });
  assert.equal(p[4].z_count, 0);
  assert.equal(fc.features[0].properties.z_count, undefined, 'input untouched');
});

test('zonalStats: extra statistics and no-data', () => {
  const vals = new Int16Array([1, 1, 2, 7, 3, 3, 3, 9, -5, 4, 4, 4]);
  const r = R.create({ width: 4, height: 3, bands: [vals], bbox: [0, 0, 4, 3], noData: -5 });
  const fc = { type: 'FeatureCollection', features: [box(0, 0, 4, 3)] };
  const s = R.zonalStats(r, 0, fc, { stats: ['count', 'std', 'median', 'majority', 'minority', 'range', 'variety', 'mean'] }).features[0].properties;
  const valid = [1, 1, 2, 7, 3, 3, 3, 9, 4, 4, 4];
  const mean = valid.reduce((x, y) => x + y) / valid.length;
  assert.equal(s.count, 11);
  near(s.mean, mean, 1e-12);
  near(s.std, Math.sqrt(valid.reduce((x, y) => x + (y - mean) * (y - mean), 0) / valid.length), 1e-12);
  assert.equal(s.median, 3);
  assert.equal(s.majority, 3);        // 3 and 4 appear 3 times: the smaller wins
  assert.equal(s.minority, 2);        // 2, 7, 9 appear once: the smaller wins
  assert.equal(s.range, 8);
  assert.equal(s.variety, 6);
  assert.throws(() => R.zonalStats(r, 0, fc, { stats: ['mean', 'kurtosis'] }), /Unknown statistic "kurtosis"/);
});

test('zonalStats on a UTM raster with polygons given in lon/lat', () => {
  const r = gradUTM();
  const inv = toLL('EPSG:32616');
  const x0 = 440000 + 10 * 30, x1 = 440000 + 30 * 30, y1 = 4640000 - 20 * 30, y0 = 4640000 - 40 * 30;
  const ring = [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]].map(inv);
  const fc = { type: 'FeatureCollection', features: [{ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [ring] } }] };
  const s = R.zonalStats(r, 0, fc).features[0].properties;
  let sum = 0;
  for (let rr = 20; rr < 40; rr++) for (let c = 10; c < 30; c++) sum += c + 100 * rr;
  assert.equal(s.count, 400);
  assert.equal(s.sum, sum);
});

test('zonalStats performance: 1000 polygons over 2000 x 2000 in under 3 s', () => {
  const W = 2000, H = 2000;
  const a = new Float32Array(W * H);
  for (let i = 0; i < a.length; i++) a[i] = i % 997;
  const r = R.create({ width: W, height: H, bands: [a], transform: [400000, 10, 0, 4700000, 0, -10], crs: 'EPSG:32616' });
  const inv = toLL('EPSG:32616');
  const rnd = mulberry32(99);
  const feats = [];
  for (let k = 0; k < 1000; k++) {
    // Irregular 24-gons scattered over the raster, ~60-400 m across.
    const cx = 400000 + 500 + rnd() * 19000, cy = 4700000 - 500 - rnd() * 19000, rad = 30 + rnd() * 170;
    const ring = [];
    for (let v = 0; v < 24; v++) {
      const ang = (v / 24) * 2 * Math.PI, rr = rad * (0.6 + 0.4 * rnd());
      ring.push(inv([cx + rr * Math.cos(ang), cy + rr * Math.sin(ang)]));
    }
    ring.push(ring[0]);
    feats.push({ type: 'Feature', properties: { k: k }, geometry: { type: 'Polygon', coordinates: [ring] } });
  }
  const t0 = Date.now();
  const out = R.zonalStats(r, 0, { type: 'FeatureCollection', features: feats }, { stats: ['count', 'sum', 'mean', 'min', 'max', 'std', 'median'] });
  const ms = Date.now() - t0;
  assert.equal(out.features.length, 1000);
  assert.ok(out.features.every((f) => f.properties.count > 0));
  assert.ok(ms < 3000, 'took ' + ms + ' ms');
});

/* -------------------------------------------------------------- sample */

test('sample: nearest and bilinear, field names, outside and no-data', () => {
  const r = grad4326({ noData: 5 });
  const two = R.create({ width: 100, height: 80, bands: [r.bands[0], new Float32Array(8000).fill(7)], bbox: r.bbox, bandNames: ['elev', 'seven'], noData: 5 });
  const cLL = (c, rr) => [-90 + (c + 0.5) * 0.1, 48 - (rr + 0.5) * 0.1];
  const fc = {
    type: 'FeatureCollection',
    features: [
      point(...cLL(10, 20), { id0: 'centre' }),
      point(-90 + 10 * 0.1, 48 - 20 * 0.1, { id0: 'corner' }),   // shared corner of pixels (9..10, 19..20)
      point(10, 10),
      point(...cLL(5, 0)),
      { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [[[-89, 47], [-88, 47], [-88, 46], [-89, 46], [-89, 47]]] } },
    ],
  };
  const nn = R.sample(two, fc);
  assert.deepEqual(nn.features[0].properties, { id0: 'centre', b1: 10 + 2000, b2: 7 });
  assert.equal(nn.features[2].properties.b1, null);
  assert.equal(nn.features[3].properties.b1, null, 'no-data -> null');
  assert.equal(nn.features[4].properties.b1, 15 + 100 * 15, 'polygon centroid (pixel 15, 15)');
  const bl = R.sample(two, fc, { method: 'bilinear', bands: [0], prefix: '' });
  near(bl.features[0].properties.elev, 10 + 2000, 1e-4);
  near(bl.features[1].properties.elev, 9.5 + 100 * 19.5, 1e-3);
  assert.equal(bl.features[1].properties.seven, undefined);
  assert.deepEqual(Object.keys(bl.features[0].properties), ['id0', 'elev']);
});

test('valueAt: inside, outside, no-data, multi-band, projected and wrapped longitudes', () => {
  const r = grad4326({ noData: 0 });
  assert.deepEqual(R.valueAt(r, -89.95, 47.95), [null]);       // pixel (0,0) is no-data
  assert.deepEqual(R.valueAt(r, -89.85, 47.95), [1]);
  assert.deepEqual(R.valueAt(r, -80.05, 40.05), [7999]);
  assert.deepEqual(R.valueAt(r, -79.99, 45), [null]);
  assert.deepEqual(R.valueAt(r, NaN, 45), [null]);
  const u = gradUTM();
  const ll = pixelLL(u, 33, 44);
  assert.deepEqual(R.valueAt(u, ll[0], ll[1]), [33 + 4400]);
  const dateline = R.create({ width: 20, height: 2, bands: [new Float32Array(40).map((_, i) => i)], bbox: [170, -1, 190, 1] });
  assert.deepEqual(R.valueAt(dateline, -175.5, 0.5), [14]);
  const rgb = R.create({ width: 1, height: 1, bands: [[1], [2], [3]], bbox: [0, 0, 1, 1] });
  assert.deepEqual(R.valueAt(rgb, 0.5, 0.5), [1, 2, 3]);
});

/* ------------------------------------------------------------- terrain */

function plane(W, H, cell, zfn, crs) {
  const a = new Float32Array(W * H);
  for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) a[r * W + c] = zfn(c * cell, (H - 1 - r) * cell);
  return R.create({ width: W, height: H, bands: [a], transform: [500000, cell, 0, 4600000, 0, -cell], crs: crs || 'EPSG:32616' });
}

test('terrain: slope and aspect of inclined planes (projected CRS)', () => {
  const tan30 = Math.tan(Math.PI / 6);
  const east = plane(30, 20, 10, (x) => 100 + x * tan30);            // rises to the east
  const slope = R.terrain(east, 0, 'slope');
  assert.equal(slope.dataType, 'float32');
  assert.equal(slope.bandNames[0], 'slope');
  for (let i = 0; i < slope.bands[0].length; i++) near(slope.bands[0][i], 30, 1e-3, 'slope px ' + i);
  const pct = R.terrain(east, 0, 'slope', { slopeUnits: 'percent' });
  near(pct.bands[0][45], 100 * tan30, 1e-3);
  const asp = R.terrain(east, 0, 'aspect');
  for (let i = 0; i < asp.bands[0].length; i++) near(asp.bands[0][i], 270, 1e-3, 'faces west');
  const north = plane(30, 20, 10, (x, y) => y * 0.2);                // rises to the north
  near(R.terrain(north, 0, 'aspect').bands[0][100], 180, 1e-3, 'faces south');
  near(R.terrain(north, 0, 'slope').bands[0][100], Math.atan(0.2) * 180 / Math.PI, 1e-3);
  const ne = plane(30, 20, 10, (x, y) => -(x + y) * 0.1);            // falls to the north-east
  near(R.terrain(ne, 0, 'aspect').bands[0][310], 45, 1e-3);
  near(R.terrain(east, 0, 'slope', { zFactor: 2 }).bands[0][55], Math.atan(2 * tan30) * 180 / Math.PI, 1e-3);
  const flat = plane(5, 5, 10, () => 3);
  assert.equal(R.terrain(flat, 0, 'aspect').bands[0][12], -9999, 'flat -> no-data');
  assert.throws(() => R.terrain(flat, 0, 'curvature'), /Unknown terrain analysis/);
});

test('terrain: hillshade range and values', () => {
  const tan30 = Math.tan(Math.PI / 6);
  const hs = R.terrain(plane(30, 20, 10, (x) => x * tan30), 0, 'hillshade');
  assert.equal(hs.dataType, 'uint8');
  assert.equal(hs.noData, 0);
  for (let i = 0; i < hs.bands[0].length; i++) assert.equal(hs.bands[0][i], 220);   // west-facing, lit from the north-west
  const flat = R.terrain(plane(5, 5, 10, () => 3), 0, 'hillshade');
  assert.equal(flat.bands[0][12], 1 + Math.round(254 * Math.sin(Math.PI / 4)));
  const dark = R.terrain(plane(30, 20, 10, (x) => -x * 3), 0, 'hillshade', { azimuth: 270, altitude: 10 });
  assert.equal(dark.bands[0][50], 1, 'facing away from a low sun -> fully shaded (1)');
  // A bumpy surface stays in range and keeps no-data.
  const rnd = mulberry32(3);
  const bumpy = plane(40, 40, 30, () => rnd() * 500);
  bumpy.bands[0][41] = NaN;
  const hb = R.terrain(bumpy, 0, 'hillshade');
  for (let i = 0; i < hb.bands[0].length; i++) {
    if (i === 41) assert.equal(hb.bands[0][i], 0);
    else assert.ok(hb.bands[0][i] >= 1 && hb.bands[0][i] <= 255);
  }
  assert.equal(R.defaultStyle(hb).ramp, 'gray');
});

test('terrain: geographic rasters use meters per degree by latitude', () => {
  const W = 40, H = 40, dx = 0.001, lat0 = 60;
  const a = new Float32Array(W * H);
  for (let r = 0; r < H; r++) {
    const lat = lat0 - (r + 0.5) * dx;
    const mx = dx * 111320 * Math.cos((lat * Math.PI) / 180);
    for (let c = 0; c < W; c++) a[r * W + c] = c * mx * Math.tan(Math.PI / 6);
  }
  const g = R.create({ width: W, height: H, bands: [a], bbox: [10, lat0 - H * dx, 10 + W * dx, lat0] });
  const s = R.terrain(g, 0, 'slope').bands[0];
  near(s[20 * W + 20], 30, 0.5);
  // (the test surface uses a spherical cos(lat) scale per row, so it isn't perfectly planar)
  near(R.terrain(g, 0, 'aspect').bands[0][20 * W + 20], 270, 0.05);
});

/* ------------------------------------------------------------ contours */

function cone(noDataCol) {
  const W = 101, H = 101;
  const a = new Float32Array(W * H);
  for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) a[r * W + c] = 95 - Math.hypot(c - 50, r - 50);
  if (noDataCol !== undefined) for (let r = 0; r < H; r++) a[r * W + noDataCol] = -9999;
  return R.create({ width: W, height: H, bands: [a], transform: [440000, 10, 0, 4640000, 0, -10], crs: 'EPSG:32616', noData: -9999 });
}

test('contours of a cone are closed rings at the right radius', () => {
  const r = cone();
  const fc = R.contours(r, 0, { interval: 20 });
  assert.deepEqual(fc.features.map((f) => f.properties.value), [40, 60, 80]);
  // Level 40 (radius 55 px) is cut by the raster edge (50 px from the peak): four open corner arcs.
  assert.equal(fc.features[0].geometry.type, 'MultiLineString');
  assert.equal(fc.features[0].geometry.coordinates.length, 4);
  for (const arc of fc.features[0].geometry.coordinates) assert.notDeepEqual(arc[0], arc[arc.length - 1]);
  const fwd = fromLL('EPSG:32616');
  for (const f of fc.features.slice(1)) {
    assert.equal(f.geometry.type, 'LineString');
    const cs = f.geometry.coordinates;
    assert.ok(cs.length > 20);
    assert.deepEqual(cs[0], cs[cs.length - 1], 'closed ring');
    const rad = 95 - f.properties.value;
    for (const p of cs) {
      const q = fwd(p);
      const pc = (q[0] - 440000) / 10 - 0.5, pr = (4640000 - q[1]) / 10 - 0.5;   // pixel-centre coordinates
      near(Math.hypot(pc - 50, pr - 50), rad, 0.05);
    }
  }
  const one = R.contours(r, 0, { levels: [50] });
  assert.equal(one.features.length, 1);
  assert.equal(one.features[0].properties.value, 50);
  const auto = R.contours(r, 0);
  assert.ok(auto.features.length >= 5 && auto.features.length <= 15);
  assert.throws(() => R.contours(r, 0, { interval: 0.01 }), /contour levels/);
});

test('contours: no-data leaves gaps (open lines)', () => {
  const fc = R.contours(cone(50), 0, { levels: [60, 80] });
  assert.equal(fc.features.length, 2);
  for (const f of fc.features) {
    assert.equal(f.geometry.type, 'MultiLineString');
    assert.equal(f.geometry.coordinates.length, 2);
    for (const line of f.geometry.coordinates) assert.notDeepEqual(line[0], line[line.length - 1]);
  }
});

test('contours: block-averages rasters above maxPixels', () => {
  const fc = R.contours(cone(), 0, { levels: [60], maxPixels: 2000 });
  assert.equal(fc.features.length, 1);
  const cs = fc.features[0].geometry.coordinates;
  assert.deepEqual(cs[0], cs[cs.length - 1]);
});

/* ----------------------------------------------------------------- idw */

test('idw reproduces point values at their cells', () => {
  const pts = { type: 'FeatureCollection', features: [point(-88, 41, { v: 10 }), point(-87, 42, { v: 20 }), point(-87.5, 41.2, { v: 50 }), point(-87.2, 41.5, { v: 'x' })] };
  const out = R.idw(pts, 'v', { width: 64 });
  assert.equal(out.crs, 'EPSG:3857');
  assert.equal(out.dataType, 'float32');
  assert.equal(out.noData, -9999);
  assert.equal(Math.max(out.width, out.height), 64);
  assert.equal(out.meta.points, 3);
  assert.deepEqual(R.valueAt(out, -88, 41), [10]);
  assert.deepEqual(R.valueAt(out, -87, 42), [20]);
  assert.deepEqual(R.valueAt(out, -87.5, 41.2), [50]);
  const mid = R.valueAt(out, -87.5, 41.6)[0];
  assert.ok(mid > 10 && mid < 50);
  const st = R.stats(out)[0];
  assert.ok(st.min >= 10 && st.max <= 50);
  const sparse = R.idw(pts, 'v', { width: 64, radius: 5000 });
  assert.deepEqual(R.valueAt(sparse, -87.1, 41.9), [null], 'no points within the radius -> no-data');
  const sized = R.idw(pts, 'v', { cellSize: 1000 });
  near(sized.transform[1] * Math.cos(((41 + 42) / 2) * Math.PI / 180), 1000, 15);
  assert.throws(() => R.idw(pts, 'missing'), /No points with a numeric "missing"/);
});

test('idw with many points (bucket grid) matches brute force', () => {
  const rnd = mulberry32(11);
  const feats = [];
  for (let i = 0; i < 1500; i++) feats.push(point(-90 + rnd() * 2, 40 + rnd() * 2, { z: Math.round(rnd() * 1000) }));
  const fc = { type: 'FeatureCollection', features: feats };
  const out = R.idw(fc, 'z', { width: 50, k: 8, power: 2 });
  const Rm = 6378137, D = Math.PI / 180;
  const pxs = feats.map((f) => [f.geometry.coordinates[0] * D * Rm, Rm * Math.log(Math.tan(Math.PI / 4 + (f.geometry.coordinates[1] * D) / 2)), f.properties.z]);
  const t = out.transform;
  assert.equal(Math.max(out.width, out.height), 50);
  const W = out.width, H = out.height;
  for (const [c, r] of [[0, 0], [W >> 1, H >> 1], [W - 1, 3], [3, H - 1], [W - 1, H - 1], [W >> 2, (3 * H) >> 2]]) {
    const x = t[0] + (c + 0.5) * t[1], y = t[3] + (r + 0.5) * t[5];
    const inCell = pxs.filter((p) => Math.floor((p[0] - t[0]) / t[1]) === c && Math.floor((p[1] - t[3]) / t[5]) === r);
    let expected;
    if (inCell.length) expected = inCell.reduce((s, p) => s + p[2], 0) / inCell.length;
    else {
      const d = pxs.map((p) => [(p[0] - x) ** 2 + (p[1] - y) ** 2, p[2]]).sort((a, b) => a[0] - b[0]).slice(0, 8);
      const ws = d.reduce((s, q) => s + 1 / q[0], 0);
      expected = d.reduce((s, q) => s + q[1] / q[0], 0) / ws;
    }
    near(out.bands[0][r * out.width + c], expected, 1e-3, 'cell ' + c + ',' + r);
  }
});

/* ---------------------------------------------------------------- clip */

test('clip by bbox crops (EPSG:4326) and masks without cropping', () => {
  const r = grad4326();
  const out = R.clip(r, { bbox: [-88, 42, -85, 45] });
  assert.equal(out.width, 30);
  assert.equal(out.height, 30);
  near(out.transform[0], -88, 1e-9);
  near(out.transform[3], 45, 1e-9);
  assert.equal(out.bands[0][0], 20 + 100 * 30);
  assert.equal(out.bands[0][29 * 30 + 29], 49 + 100 * 59);
  const masked = R.clip(r, { bbox: [-88, 42, -85, 45] }, { crop: false });
  assert.equal(masked.width, 100);
  assert.ok(Number.isNaN(masked.bands[0][0]));
  assert.equal(masked.bands[0][30 * 100 + 20], 20 + 3000);
  assert.throws(() => R.clip(r, { bbox: [0, 0, 1, 1] }), /doesn't overlap/);
  const u8 = R.create({ width: 4, height: 4, bands: [new Uint8Array(16).fill(9)], bbox: [0, 0, 4, 4] });
  const cut = R.clip(u8, { bbox: [1, 1, 3, 3] }, { crop: false });
  assert.equal(cut.noData, 0);
  assert.deepEqual(Array.from(cut.bands[0]), [0, 0, 0, 0, 0, 9, 9, 0, 0, 9, 9, 0, 0, 0, 0, 0]);
});

test('clip by polygon masks outside pixels and crops to the polygon extent', () => {
  const r = gradUTM({ noData: -1 });
  const inv = toLL('EPSG:32616');
  const tri = [[440300, 4639100], [441500, 4639100], [440300, 4637900], [440300, 4639100]].map(inv);
  const fc = { type: 'FeatureCollection', features: [{ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [tri] } }] };
  const out = R.clip(r, { fc: fc });
  // Legs of 1200 m = 40 pixels; the pixels on the hypotenuse itself may go either way.
  assert.ok(out.width >= 39 && out.width <= 40, 'width ' + out.width);
  assert.ok(out.height >= 39 && out.height <= 40, 'height ' + out.height);
  near(out.transform[0], 440300, 1e-6);
  near(out.transform[3], 4639100, 1e-6);
  assert.equal(out.noData, -1);
  const zs = R.zonalStats(r, 0, fc, { stats: ['count', 'sum'] }).features[0].properties;
  const st = R.stats(out)[0];
  assert.equal(st.count, zs.count);
  near(st.mean * st.count, zs.sum, 1e-3 * zs.sum);
  assert.equal(out.bands[0][out.width * out.height - 1], -1, 'bottom-right corner lies outside the triangle');
  assert.equal(out.bands[0][0], 10 + 100 * 30, 'top-left pixel is inside');
  assert.throws(() => R.clip(r, { fc: { type: 'FeatureCollection', features: [point(0, 0)] } }), /no polygons/);
});

/* ------------------------------------------------------ outline + info */

test('footprint and bboxWGS84', () => {
  const g = grad4326();
  assert.deepEqual(R.bboxWGS84(g), [-90, 40, -80, 48]);
  assert.deepEqual(R.footprint(g), { type: 'Polygon', coordinates: [[[-90, 40], [-80, 40], [-80, 48], [-90, 48], [-90, 40]]] });

  const u = gradUTM();
  const fp = R.footprint(u).coordinates[0];
  assert.ok(fp.length > 100);
  assert.deepEqual(fp[0], fp[fp.length - 1]);
  assert.ok(fp.every((p) => Number.isFinite(p[0]) && Number.isFinite(p[1])));
  const bb = R.bboxWGS84(u);
  for (const [c, r] of [[0, 0], [100, 0], [0, 80], [100, 80], [50, 0]]) {
    const p = toLL('EPSG:32616')([440000 + c * 30, 4640000 - r * 30]);
    assert.ok(p[0] >= bb[0] - 1e-9 && p[0] <= bb[2] + 1e-9 && p[1] >= bb[1] - 1e-9 && p[1] <= bb[3] + 1e-9);
  }
  let area = 0;
  for (let i = 0; i < fp.length - 1; i++) area += fp[i][0] * fp[i + 1][1] - fp[i + 1][0] * fp[i][1];
  assert.ok(area > 0, 'counter-clockwise exterior ring');

  // UTM zone 60 raster straddling the antimeridian stays contiguous.
  const z60 = R.create({ width: 10, height: 10, bands: [new Float32Array(100)], transform: [700000, 50000, 0, 1500000, 0, -50000], crs: 'EPSG:32660' });
  const b60 = R.bboxWGS84(z60);
  assert.ok(b60[2] - b60[0] < 20, 'narrow in longitude: ' + b60);
  assert.ok(b60[0] < -180 || b60[2] > 180, 'longitudes are unwrapped across the antimeridian: ' + b60);
  const img = R.render(z60);
  near(img.coordinates[1][0] - img.coordinates[0][0], b60[2] - b60[0], 1e-9);
  const mid = R.valueAt(z60, 180, 12);
  assert.deepEqual(mid, [0]);

  // A polar stereographic raster covering the pole.
  const polar = R.create({ width: 10, height: 10, bands: [new Float32Array(100).fill(1)], transform: [-1e6, 2e5, 0, 1e6, 0, -2e5], crs: 'EPSG:3413' });
  const bp = R.bboxWGS84(polar);
  assert.deepEqual([bp[0], bp[2], bp[3]], [-180, 180, 90]);
  const pimg = R.render(polar);
  assert.ok(pimg.coordinates[0][1] <= 85.0512);
  let opaque = 0;
  for (let i = 3; i < pimg.data.length; i += 4) if (pimg.data[i]) opaque++;
  assert.ok(opaque > 0);
});

test('info summarises a raster for the console', () => {
  const u = gradUTM({ noData: -1, bandNames: ['elevation'] });
  const i = R.info(u);
  assert.equal(i.width, 100);
  assert.equal(i.height, 80);
  assert.equal(i.bands, 1);
  assert.equal(i.dataType, 'float32');
  assert.equal(i.crs, 'EPSG:32616');
  assert.equal(i.crsName, 'WGS 84 / UTM zone 16N');
  assert.deepEqual(i.pixelSize, [30, 30]);
  assert.equal(i.pixelUnits, 'm');
  assert.deepEqual(i.pixelSizeMeters, [30, 30]);
  assert.equal(i.noData, -1);
  assert.equal(i.sizeBytes, 32000);
  assert.ok(i.bboxWGS84.every(Number.isFinite));
  assert.equal(i.stats[0].band, 'elevation');
  assert.equal(i.stats[0].max, 7999);
  assert.doesNotThrow(() => JSON.stringify(i));
  assert.equal(R.defaultStyle(u).ramp, 'elevation');
  const g = R.info(grad4326());
  assert.equal(g.pixelUnits, 'degrees');
  near(g.pixelSizeMeters[0], 0.1 * 111320 * Math.cos(44 * Math.PI / 180), 100);
  near(g.pixelSizeMeters[1], 11100, 50);
});

test('unknown CRS codes give a readable, typed error', () => {
  const r = R.create({ width: 2, height: 2, bands: [new Float32Array(4)], bbox: [0, 0, 100, 100], crs: 'EPSG:2232' });
  assert.throws(() => R.render(r), (e) => e.code === 'CRS_UNKNOWN' && /EPSG:2232 isn't built in/.test(e.message));
  assert.deepEqual(R.valueAt(r, 0, 0), [null]);
});
