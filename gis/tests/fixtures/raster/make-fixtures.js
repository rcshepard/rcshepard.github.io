#!/usr/bin/env node
/*
 * Regenerates the GeoTIFF fixtures in this folder with the vendored gdal3.js,
 * so that the raster tests read files written by real GDAL (palettes, band
 * descriptions, user-defined projections, COG overviews, JPEG/YCbCr, ...).
 *
 *   node tests/fixtures/raster/make-fixtures.js
 *
 * The .tif files are committed; the tests never run this script. Pixel values
 * are described next to each fixture and asserted in tests/raster.test.js.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { initGdal } = require('../../harness');

const OUT = __dirname;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'psicits-raster-fx-'));

/** Write an Arc/Info ASCII grid (the pixel source for the VRTs below). */
function asc(name, w, h, fn) {
  const lines = ['ncols ' + w, 'nrows ' + h, 'xllcorner 0', 'yllcorner 0', 'cellsize 1'];
  for (let r = 0; r < h; r++) {
    const row = new Array(w);
    for (let c = 0; c < w; c++) row[c] = fn(c, r);
    lines.push(row.join(' '));
  }
  const file = path.join(TMP, name + '.asc');
  fs.writeFileSync(file, lines.join('\n') + '\n');
  return file;
}

function xmlEsc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Write a VRT that stacks ASCII-grid sources into typed, described bands. */
function vrt(name, o) {
  const x = ['<VRTDataset rasterXSize="' + o.w + '" rasterYSize="' + o.h + '">'];
  if (o.srs) x.push('  <SRS>' + xmlEsc(o.srs) + '</SRS>');
  if (o.gt) x.push('  <GeoTransform>' + o.gt.join(', ') + '</GeoTransform>');
  if (o.metadata) {
    x.push('  <Metadata>');
    for (const k of Object.keys(o.metadata)) x.push('    <MDI key="' + k + '">' + xmlEsc(o.metadata[k]) + '</MDI>');
    x.push('  </Metadata>');
  }
  o.bands.forEach(function (b, i) {
    x.push('  <VRTRasterBand dataType="' + b.type + '" band="' + (i + 1) + '">');
    if (b.desc) x.push('    <Description>' + xmlEsc(b.desc) + '</Description>');
    if (b.nodata !== undefined) x.push('    <NoDataValue>' + b.nodata + '</NoDataValue>');
    if (b.colorInterp) x.push('    <ColorInterp>' + b.colorInterp + '</ColorInterp>');
    if (b.offset !== undefined) x.push('    <Offset>' + b.offset + '</Offset>');
    if (b.scale !== undefined) x.push('    <Scale>' + b.scale + '</Scale>');
    if (b.colorTable) {
      x.push('    <ColorTable>');
      b.colorTable.forEach(function (c) {
        x.push('      <Entry c1="' + c[0] + '" c2="' + c[1] + '" c3="' + c[2] + '" c4="255"/>');
      });
      x.push('    </ColorTable>');
    }
    x.push('    <SimpleSource>');
    x.push('      <SourceFilename relativeToVRT="1">' + path.basename(b.file) + '</SourceFilename>');
    x.push('      <SourceBand>1</SourceBand>');
    x.push('    </SimpleSource>');
    x.push('  </VRTRasterBand>');
  });
  x.push('</VRTDataset>');
  const file = path.join(TMP, name + '.vrt');
  fs.writeFileSync(file, x.join('\n') + '\n');
  return file;
}

async function translate(gdal, name, vrtFile, sources, args) {
  const opened = await gdal.open([vrtFile].concat(sources));
  if (opened.errors && opened.errors.length) throw new Error(name + ': ' + JSON.stringify(opened.errors));
  const ds = opened.datasets[0];
  const out = await gdal.gdal_translate(ds, args, name);
  const bytes = await gdal.getFileBytes(out);
  fs.writeFileSync(path.join(OUT, name + '.tif'), bytes);
  opened.datasets.forEach(function (d) { try { gdal.close(d); } catch (e) { /* ignore */ } });
  console.log(name + '.tif', bytes.length, 'bytes');
}

async function main() {
  const gdal = await initGdal();
  const GTIFF = ['-of', 'GTiff'];

  // palette.tif: 8x6 Byte, EPSG:4326, noData 0, 4-entry colour table.
  // value = 1 for col < 3, 2 for col < 6, else 3; pixel (0,0) = 0 (noData).
  {
    const f = asc('palette', 8, 6, function (c, r) { return c === 0 && r === 0 ? 0 : c < 3 ? 1 : c < 6 ? 2 : 3; });
    const v = vrt('palette', {
      w: 8, h: 6, srs: 'EPSG:4326', gt: [-88, 0.25, 0, 42, 0, -0.25],
      bands: [{ type: 'Byte', file: f, nodata: 0, colorInterp: 'Palette',
        colorTable: [[0, 0, 0], [31, 120, 180], [51, 160, 44], [227, 26, 28]] }],
    });
    await translate(gdal, 'palette', v, [f], GTIFF);
  }

  // bands.tif: 6x4 UInt16 x 3 in EPSG:32616, noData 0, DEFLATE, band descriptions.
  // red = 100 + col, green = 200 + row, nir = 1000 + 10*col + row (scale 0.0001).
  {
    const fr = asc('red', 6, 4, function (c) { return 100 + c; });
    const fg = asc('green', 6, 4, function (c, r) { return 200 + r; });
    const fn = asc('nir', 6, 4, function (c, r) { return 1000 + 10 * c + r; });
    const v = vrt('bands', {
      w: 6, h: 4, srs: 'EPSG:32616', gt: [440000, 30, 0, 4640000, 0, -30], metadata: { SENSOR: 'synthetic' },
      bands: [
        { type: 'UInt16', file: fr, nodata: 0, desc: 'red' },
        { type: 'UInt16', file: fg, nodata: 0, desc: 'green' },
        { type: 'UInt16', file: fn, nodata: 0, desc: 'nir', scale: 0.0001, offset: 0 },
      ],
    });
    await translate(gdal, 'bands', v, [fr, fg, fn], GTIFF.concat(['-co', 'COMPRESS=DEFLATE']));
  }

  // albers.tif: 10x8 Float32, user-defined Albers (NAD83), noData -9999.
  // value = col + 100*row + 0.5, pixel (0,0) = -9999.
  {
    const f = asc('albers', 10, 8, function (c, r) { return c === 0 && r === 0 ? -9999 : c + 100 * r + 0.5; });
    const v = vrt('albers', {
      w: 10, h: 8, gt: [688000, 100, 0, 2128500, 0, -100],
      srs: '+proj=aea +lat_0=23 +lon_0=-96 +lat_1=29.5 +lat_2=45.5 +x_0=0 +y_0=0 +datum=NAD83 +units=m +no_defs',
      bands: [{ type: 'Float32', file: f, nodata: -9999 }],
    });
    await translate(gdal, 'albers', v, [f], GTIFF);
  }

  // sinusoidal.tif: 8x8 Int16, MODIS sinusoidal on a sphere, noData -3000. value = 10*col + row.
  {
    const f = asc('sinu', 8, 8, function (c, r) { return 10 * c + r; });
    const v = vrt('sinusoidal', {
      w: 8, h: 8, gt: [-7255000, 463.312716528, 0, 4657000, 0, -463.312716528],
      srs: '+proj=sinu +lon_0=0 +x_0=0 +y_0=0 +R=6371007.181 +units=m +no_defs',
      bands: [{ type: 'Int16', file: f, nodata: -3000 }],
    });
    await translate(gdal, 'sinusoidal', v, [f], GTIFF);
  }

  // geog_sphere.tif: 4x4 Byte, lon/lat on a sphere (user-defined geographic CRS). value = 1 + col + 4*row.
  {
    const f = asc('sphere', 4, 4, function (c, r) { return 1 + c + 4 * r; });
    const v = vrt('geog_sphere', {
      w: 4, h: 4, gt: [10, 1, 0, 50, 0, -1], srs: '+proj=longlat +R=6370997 +no_defs',
      bands: [{ type: 'Byte', file: f }],
    });
    await translate(gdal, 'geog_sphere', v, [f], GTIFF);
  }

  // cog.tif: 1024x768 UInt16 x 2 COG in EPSG:3857 (256px tiles, DEFLATE, nearest overviews 512x384 and 256x192).
  // band 1 = col, band 2 = row.
  {
    const fc = asc('cogc', 1024, 768, function (c) { return c; });
    const fr = asc('cogr', 1024, 768, function (c, r) { return r; });
    const v = vrt('cog', {
      w: 1024, h: 768, srs: 'EPSG:3857', gt: [-9780000, 10, 0, 5150000, 0, -10],
      bands: [{ type: 'UInt16', file: fc, desc: 'col' }, { type: 'UInt16', file: fr, desc: 'row' }],
    });
    await translate(gdal, 'cog', v, [fc, fr], ['-of', 'COG', '-co', 'BLOCKSIZE=256', '-co', 'COMPRESS=DEFLATE',
      '-co', 'PREDICTOR=YES', '-co', 'OVERVIEWS=AUTO', '-co', 'RESAMPLING=NEAREST']);
  }

  // (gdal3.js is built without a JPEG codec, so JPEG/YCbCr is covered by a
  // synthetic writeArrayBuffer file in the tests instead.)

  // rgba.tif: 4x4 Byte x 4 (RGB + alpha), EPSG:4326. Alpha is 0 on the top row, 255 elsewhere.
  {
    const f1 = asc('ar', 4, 4, function (c) { return 60 * c; });
    const f2 = asc('ag', 4, 4, function (c, r) { return 60 * r; });
    const f3 = asc('ab', 4, 4, function () { return 128; });
    const f4 = asc('aa', 4, 4, function (c, r) { return r === 0 ? 0 : 255; });
    const v = vrt('rgba', {
      w: 4, h: 4, srs: 'EPSG:4326', gt: [0, 1, 0, 4, 0, -1],
      bands: [{ type: 'Byte', file: f1, colorInterp: 'Red' }, { type: 'Byte', file: f2, colorInterp: 'Green' },
        { type: 'Byte', file: f3, colorInterp: 'Blue' }, { type: 'Byte', file: f4, colorInterp: 'Alpha' }],
    });
    await translate(gdal, 'rgba', v, [f1, f2, f3, f4], GTIFF.concat(['-co', 'PHOTOMETRIC=RGB', '-co', 'ALPHA=YES']));
  }

  // rgb_mask.tif: 4x4 RGB Byte with an internal (1-bit) transparency mask, no noData, EPSG:4326.
  // red = 10 + 60*col, green = 10 + 60*row, blue = 128; the top row is masked out.
  // float_mask.tif: 4x4 Float32 (value = 1 + col + 4*row) with the same internal mask.
  {
    const f1 = asc('mr', 4, 4, function (c) { return 10 + 60 * c; });
    const f2 = asc('mg', 4, 4, function (c, r) { return 10 + 60 * r; });
    const f3 = asc('mb', 4, 4, function () { return 128; });
    const f4 = asc('mm', 4, 4, function (c, r) { return r === 0 ? 0 : 255; });
    const f5 = asc('mf', 4, 4, function (c, r) { return 1 + c + 4 * r; });
    const common = { w: 4, h: 4, srs: 'EPSG:4326', gt: [0, 1, 0, 4, 0, -1] };
    const mask = ['-mask', '4', '-co', 'TILED=YES', '-co', 'BLOCKXSIZE=16', '-co', 'BLOCKYSIZE=16', '--config', 'GDAL_TIFF_INTERNAL_MASK', 'YES'];
    const v1 = vrt('rgb_mask', Object.assign({
      bands: [{ type: 'Byte', file: f1, colorInterp: 'Red' }, { type: 'Byte', file: f2, colorInterp: 'Green' },
        { type: 'Byte', file: f3, colorInterp: 'Blue' }, { type: 'Byte', file: f4, colorInterp: 'Alpha' }],
    }, common));
    await translate(gdal, 'rgb_mask', v1, [f1, f2, f3, f4], GTIFF.concat(['-b', '1', '-b', '2', '-b', '3'], mask));
    const v2 = vrt('float_mask', Object.assign({
      bands: [{ type: 'Float32', file: f5 }, { type: 'Float32', file: f4 }, { type: 'Float32', file: f4 }, { type: 'Float32', file: f4 }],
    }, common));
    await translate(gdal, 'float_mask', v2, [f5, f4], GTIFF.concat(['-b', '1'], mask));
  }

  // pixel_is_point.tif: 4x3 Float32 in EPSG:32616 written with AREA_OR_POINT=Point.
  // GDAL's (pixel-is-area) geotransform is [500000, 10, 0, 4600000, 0, -10]. value = 1 + col + 4*row.
  {
    const f = asc('pip', 4, 3, function (c, r) { return 1 + c + 4 * r; });
    const v = vrt('pixel_is_point', {
      w: 4, h: 3, srs: 'EPSG:32616', gt: [500000, 10, 0, 4600000, 0, -10], metadata: { AREA_OR_POINT: 'Point' },
      bands: [{ type: 'Float32', file: f }],
    });
    await translate(gdal, 'pixel_is_point', v, [f], GTIFF.concat(['-mo', 'AREA_OR_POINT=Point']));
  }

  // nogeoref.tif: 4x3 Byte baseline TIFF without any georeferencing. value = 1 + col + 4*row.
  {
    const f = asc('ng', 4, 3, function (c, r) { return 1 + c + 4 * r; });
    const v = vrt('nogeoref', { w: 4, h: 3, bands: [{ type: 'Byte', file: f }] });
    await translate(gdal, 'nogeoref', v, [f], GTIFF.concat(['-co', 'PROFILE=BASELINE']));
  }

  // rotated.tif: 4x4 Byte with a rotated geotransform (written as ModelTransformation), EPSG:32616.
  {
    const f = asc('rot', 4, 4, function (c, r) { return 1 + c + 4 * r; });
    const v = vrt('rotated', {
      w: 4, h: 4, srs: 'EPSG:32616', gt: [500000, 10, 2, 4600000, 1, -10],
      bands: [{ type: 'Byte', file: f }],
    });
    await translate(gdal, 'rotated', v, [f], GTIFF);
  }

  fs.rmSync(TMP, { recursive: true, force: true });
}

main().catch(function (e) { console.error(e); process.exit(1); });
