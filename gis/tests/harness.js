/*
 * Test harness: loads the vendored browser libraries and PSICITS's DOM-free
 * js/lib/*.js files into Node's global scope, the same way <script> tags do in
 * the browser.
 *
 *   const { load } = require('./harness');
 *   const M = load('core', 'crs', 'geoops');   // dependencies are pulled in automatically
 *
 * Run all tests from the repo root with:  node --test
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const VENDOR = path.join(ROOT, 'vendor');

// Some browser bundles reference `self`.
if (typeof globalThis.self === 'undefined') globalThis.self = globalThis;

// Vendored UMD bundles -> the globals they define in a browser.
const VENDOR_GLOBALS = {
  turf: 'turf/turf.min.js',
  proj4: 'proj4/proj4.js',
  RBush: 'rbush/rbush.min.js',
  JSZip: 'jszip/jszip.min.js',
  GeoTIFF: 'geotiff/geotiff.js',
  shp: 'shpjs/shp.min.js',
  Papa: 'papaparse/papaparse.min.js',
  topojson: 'topojson/topojson-client.min.js',
  osmtogeojson: 'osmtogeojson/osmtogeojson.js',
  flatgeobuf: 'flatgeobuf/flatgeobuf-geojson.min.js',
};

for (const [name, rel] of Object.entries(VENDOR_GLOBALS)) {
  if (globalThis[name]) continue;
  Object.defineProperty(globalThis, name, {
    configurable: true,
    enumerable: false,
    get() {
      // Lazy: only pay for what a test uses.
      const mod = require(path.join(VENDOR, rel));
      Object.defineProperty(globalThis, name, { value: mod, configurable: true, writable: true });
      return mod;
    },
  });
}

// Dependency graph of js/lib files (keep in sync with index.html script order).
const LIB_DEPS = {
  core: [],
  crs: ['core'],
  colors: ['core'],
  classify: ['core'],
  expr: ['core'],
  formats: ['core', 'crs', 'colors'],
  geoops: ['core'],
  raster: ['core', 'crs', 'colors'],
  gdal: ['core', 'crs'],
  commands: ['core', 'expr', 'colors', 'classify'],
};

const loaded = new Set();

function loadScript(rel) {
  const file = path.join(ROOT, rel);
  const code = fs.readFileSync(file, 'utf8');
  vm.runInThisContext(code, { filename: file });
}

/** Load js/lib/<name>.js (plus its dependencies) and return the PSICITS namespace. */
function load(...names) {
  for (const name of names) {
    if (loaded.has(name)) continue;
    for (const dep of LIB_DEPS[name] || ['core']) load(dep);
    const rel = path.join('js', 'lib', name + '.js');
    if (!fs.existsSync(path.join(ROOT, rel))) throw new Error('Missing library file ' + rel);
    loadScript(rel);
    loaded.add(name);
  }
  return globalThis.PSICITS;
}

/** Initialise sql.js from the vendored WebAssembly binary (for GeoPackage tests). */
async function initSqlJs() {
  const init = require(path.join(VENDOR, 'sqljs', 'sql-wasm.js'));
  const wasmBinary = fs.readFileSync(path.join(VENDOR, 'sqljs', 'sql-wasm.wasm'));
  return init({ wasmBinary });
}

/** Initialise gdal3.js (Node build) from vendor/gdal3. Slow (~1-2 s); cache the result. */
let gdalPromise = null;
function initGdal() {
  if (!gdalPromise) {
    const init = require(path.join(VENDOR, 'gdal3', 'gdal3.node.js'));
    // gdal3.js resolves `path` relative to the working directory.
    const rel = path.relative(process.cwd(), path.join(VENDOR, 'gdal3')) || '.';
    gdalPromise = init({ path: rel.split(path.sep).join('/') });
  }
  return gdalPromise;
}

/** Read a fixture from tests/fixtures. */
function fixture(name, encoding) {
  return fs.readFileSync(path.join(__dirname, 'fixtures', name), encoding);
}

module.exports = { ROOT, VENDOR, load, loadScript, initSqlJs, initGdal, fixture };
