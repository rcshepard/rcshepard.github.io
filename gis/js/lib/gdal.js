/*
 * PSICITS — GDAL in the browser (gdal3.js 2.8.1 = GDAL 3.8.4 compiled to
 * WebAssembly, LGPL-2.1-or-later).
 *
 * Lets users type real GDAL commands (`ogr2ogr …`, `gdalwarp …`) against the
 * layers loaded in the app, and gives the app import/export fallbacks for
 * formats it cannot read or write natively.
 *
 *   await PSICITS.gdal.load();
 *   const res = await PSICITS.gdal.execute('ogr2ogr -f GPKG roads.gpkg roads', { resolve });
 *
 * How it runs (findings from testing gdal3.js 2.8.1 in Node and Chromium)
 * -----------------------------------------------------------------------
 * gdal3.js has its own "worker mode" (initGdalJs({ path })), but its proxy
 * only forwards the high-level JS functions: Module.FS is not reachable from
 * the page, so inputs can only be mounted with Gdal.open(File[]) (which
 * re-mounts /input on every call) and files written to /output can never be
 * deleted (worker memory only grows). It also cannot take log handlers
 * (functions can't be posted: DataCloneError, and the failed init promise is
 * cached forever), its wrappers report the wrong error text ("Pointer 'hDS'
 * is NULL in 'GDALGetFileList'"), an unknown option silently runs the
 * conversion with default options, output names are forced to
 * /output/<name>.<driver ext> and gdalwarp takes a single source.
 *
 * PSICITS therefore runs gdal3.js in its *non-worker* mode inside a worker
 * of its own: a small blob: worker `importScripts()` gdal3.js and hosts the
 * self-contained engine below (createEngine is serialised with
 * Function#toString). The engine talks to GDAL's C API through Module.ccall
 * (GDALVectorTranslate, GDALTranslate, GDALWarp, GDALRasterize, GDALInfo,
 * GDALVectorInfo, GDALDEMProcessing, GDALBuildVRT… are all exported by the
 * wasm build) and to Emscripten's in-memory FS directly. Every command gets
 * its own /psicits/<job>/{in,out} directories which are removed
 * afterwards, stderr ("ERROR 1: …", "Warning 1: …") is captured per command,
 * and the UI stays responsive. The very same engine runs in-process on the
 * main thread (fallback when workers are unavailable) and in Node (tests).
 *
 * Loading order in the browser: local files over http(s) in a worker →
 * jsDelivr CDN in a worker (also works from file:// pages, jsDelivr sends
 * CORS headers) → main-thread fallbacks (script tag, useWorker: false; the
 * CDN script tag carries the gdal3.js SRI hash). Fetching local wasm from a
 * file:// page is impossible, so file:// goes straight to the CDN. The only
 * network calls made from this file are that loading (plus one HEAD fetch()
 * to check that <localPath>/gdal3.js exists); commands never touch the network.
 * In the main-thread fallback GDAL blocks the page while a command runs.
 *
 * Getting data in: vector layers are written as GeoJSON (`<slug>.geojson`,
 * layer name = slug), rasters as a VRT that points at raw little-endian band
 * files (lossless, any data type, CRS passed as EPSG code / WKT / proj4 text
 * that GDAL parses itself, no network lookups) and loaded files as their
 * bytes (zips/tars/gzips are opened through /vsizip/, /vsitar/, /vsigzip/).
 * Rasters are read back through `gdal_translate -of ENVI` (raw BSQ) plus
 * gdalinfo JSON for CRS / geotransform / nodata.
 */
(function (root) {
  'use strict';

  const M = (root.PSICITS = root.PSICITS || {});

  /* =====================================================================
   * Engine — runs next to gdal3.js: inside the PSICITS worker, on the main
   * thread, or in Node. It is serialised into the worker with
   * Function#toString, so it must stay completely self-contained: it may only
   * use its arguments and standard globals.
   *
   *   const engine = createEngine(Gdal, sink);   // sink.lines receives stdout/stderr
   *   engine.call('run', { program: 'ogr2ogr', src: [...], dst, args });
   * ===================================================================== */
  function createEngine(Gdal, sink) {
    const Mod = Gdal.Module;
    const FS = Mod.FS;
    const OF_UPDATE = 0x01;
    const OF_RASTER = 0x02;
    const OF_VECTOR = 0x04;
    const OF_VERBOSE_ERROR = 0x40;
    const CE_FAILURE = 3;

    function cc(name, ret, types, args) { return Mod.ccall(name, ret, types, args); }

    /** Null-terminated char** built from a JS string list. */
    function cStrings(list) {
      const ptrs = [];
      (list || []).forEach(function (item) {
        const s = String(item);
        const n = Mod.lengthBytesUTF8(s) + 1;
        const p = Mod._malloc(n);
        Mod.stringToUTF8(s, p, n);
        ptrs.push(p);
      });
      ptrs.push(0);
      const base = Mod._malloc(ptrs.length * 4);
      for (let i = 0; i < ptrs.length; i++) Mod.HEAPU32[(base >> 2) + i] = ptrs[i];
      return {
        ptr: base,
        free: function () { ptrs.forEach(function (p) { if (p) Mod._free(p); }); Mod._free(base); },
      };
    }

    /** Array of pointers (e.g. GDALDatasetH*). */
    function cPointers(list) {
      const base = Mod._malloc(Math.max(1, list.length) * 4);
      for (let i = 0; i < list.length; i++) Mod.HEAPU32[(base >> 2) + i] = list[i];
      return base;
    }

    function takeCString(ptr) {
      if (!ptr) return null;
      const s = Mod.UTF8ToString(ptr);
      Mod._free(ptr); // CPLFree == free() in this build
      return s;
    }

    /* ------------------------------------------------------------ errors */

    function resetErrors() {
      cc('CPLErrorReset', null, [], []);
      sink.lines.length = 0;
    }

    /** "ERROR n: …" messages from stderr (continuation lines are appended to their error). */
    function errorLines() {
      const out = [];
      let inError = false;
      sink.lines.forEach(function (l) {
        if (l.type !== 'stderr') return;
        const text = String(l.text);
        const m = /^ERROR \d+:\s*([\s\S]*)$/.exec(text);
        if (m) {
          const msg = m[1].trim();
          inError = !!msg;
          if (msg && out.indexOf(msg) < 0) out.push(msg);
          else if (msg) inError = false; // duplicate: ignore its continuation too
        } else if (/^Warning \d+:/.test(text)) {
          inError = false;
        } else if (inError && text.trim() && out.length) {
          out[out.length - 1] += ' ' + text.trim();
        }
      });
      return out;
    }

    function fail(fallback) {
      const lines = errorLines();
      let msg = lines.join('\n');
      if (!msg && cc('CPLGetLastErrorType', 'number', [], []) >= CE_FAILURE) {
        msg = String(cc('CPLGetLastErrorMsg', 'string', [], []) || '').trim();
      }
      const e = new Error(msg || fallback);
      e.gdal = true;
      throw e;
    }

    function takeLogs() {
      const out = [];
      sink.lines.forEach(function (l) { if (l.text && String(l.text).trim()) out.push(String(l.text)); });
      sink.lines.length = 0;
      return out;
    }

    /**
     * gdal3.js prints to console.error('gdal stderr: …') / console.debug
     * ('gdal stdout: …') when it was initialised without log handlers (e.g. an
     * injected instance). Capture those lines too while an operation runs.
     */
    function withConsoleCapture(fn) {
      const con = typeof console !== 'undefined' ? console : null;
      if (!con) return fn();
      const origErr = con.error;
      const origDebug = con.debug;
      const grab = function (orig, prefix, type) {
        return function () {
          const s = arguments[0];
          if (arguments.length === 1 && typeof s === 'string' && s.indexOf(prefix) === 0) {
            sink.lines.push({ type: type, text: s.slice(prefix.length) });
            return undefined;
          }
          return orig.apply(con, arguments);
        };
      };
      con.error = grab(origErr, 'gdal stderr: ', 'stderr');
      con.debug = grab(origDebug, 'gdal stdout: ', 'stdout');
      try { return fn(); } finally { con.error = origErr; con.debug = origDebug; }
    }

    /** Apply --config options for one call; returns a function restoring the engine defaults. */
    function setConfig(cfg) {
      const keys = Object.keys(cfg || {});
      keys.forEach(function (k) { cc('CPLSetConfigOption', null, ['string', 'string'], [k, String(cfg[k])]); });
      return function () {
        keys.forEach(function (k) {
          const def = Object.prototype.hasOwnProperty.call(ENGINE_CONFIG, k) ? ENGINE_CONFIG[k] : null;
          cc('CPLSetConfigOption', null, ['string', 'string'], [k, def]);
        });
      };
    }

    /* ------------------------------------------------------------ files */

    function exists(p) { try { return FS.analyzePath(p).exists; } catch (e) { return false; } }
    function isDir(p) { try { return FS.isDir(FS.stat(p).mode); } catch (e) { return false; } }
    function parentOf(p) { const i = p.lastIndexOf('/'); return i > 0 ? p.slice(0, i) : '/'; }
    function mkdirp(dir) { if (!exists(dir)) FS.mkdirTree(dir); }

    function walk(dir, out) {
      FS.readdir(dir).forEach(function (n) {
        if (n === '.' || n === '..') return;
        const p = dir + '/' + n;
        const st = FS.stat(p);
        if (FS.isDir(st.mode)) { out.push({ path: p, dir: true, size: 0 }); walk(p, out); }
        else out.push({ path: p, dir: false, size: st.size });
      });
      return out;
    }

    function rmrf(p) {
      if (!exists(p)) return;
      if (isDir(p)) {
        FS.readdir(p).forEach(function (n) { if (n !== '.' && n !== '..') rmrf(p + '/' + n); });
        FS.rmdir(p);
      } else {
        FS.unlink(p);
      }
    }

    /* ---------------------------------------------------------- datasets */

    function openDataset(src, flags) {
      const s = typeof src === 'string' ? { path: src } : src;
      const oo = cStrings(s.openOptions || []);
      const drv = s.drivers && s.drivers.length ? cStrings(s.drivers) : null;
      let h = 0;
      try {
        h = cc('GDALOpenEx', 'number', ['string', 'number', 'number', 'number', 'number'],
          [s.path, flags | OF_VERBOSE_ERROR, drv ? drv.ptr : 0, oo.ptr, 0]);
      } finally {
        oo.free();
        if (drv) drv.free();
      }
      if (!h) fail('Could not open ' + s.path);
      return h;
    }

    function closeDataset(h) { if (h) cc('GDALClose', null, ['number'], [h]); }

    function driverName(h) {
      const d = cc('GDALGetDatasetDriver', 'number', ['number'], [h]);
      return d ? cc('GDALGetDriverShortName', 'string', ['number'], [d]) : '';
    }

    const APPS = {
      ogr2ogr: ['GDALVectorTranslateOptionsNew', 'GDALVectorTranslateOptionsFree', OF_VECTOR],
      gdal_translate: ['GDALTranslateOptionsNew', 'GDALTranslateOptionsFree', OF_RASTER],
      gdalwarp: ['GDALWarpAppOptionsNew', 'GDALWarpAppOptionsFree', OF_RASTER],
      gdal_rasterize: ['GDALRasterizeOptionsNew', 'GDALRasterizeOptionsFree', OF_VECTOR],
      gdaldem: ['GDALDEMProcessingOptionsNew', 'GDALDEMProcessingOptionsFree', OF_RASTER],
      gdalbuildvrt: ['GDALBuildVRTOptionsNew', 'GDALBuildVRTOptionsFree', OF_RASTER],
      gdalinfo: ['GDALInfoOptionsNew', 'GDALInfoOptionsFree', OF_RASTER],
      ogrinfo: ['GDALVectorInfoOptionsNew', 'GDALVectorInfoOptionsFree', OF_VECTOR],
    };

    /**
     * Run a GDAL utility.
     * req = { program, args: [...options], src: [path | { path, openOptions, drivers }],
     *         dst, update (gdal_rasterize into an existing dst), mode / colorFile (gdaldem),
     *         config: { KEY: VALUE } }
     * Returns { ok: true, text } (text for gdalinfo / ogrinfo).
     */
    function run(req) {
      const app = APPS[req.program];
      if (!app) throw new Error('Unsupported program ' + req.program);
      const restoreConfig = setConfig(req.config);
      const opened = [];
      let optsPtr = 0;
      let argList = null;
      let out = 0;
      let dstH = 0;
      const usage = Mod._malloc(4);
      Mod.HEAP32[usage >> 2] = 0;
      try {
        if (req.dst) mkdirp(parentOf(req.dst));
        (req.src || []).forEach(function (s) { opened.push(openDataset(s, app[2])); });
        argList = cStrings(req.args || []);
        optsPtr = cc(app[0], 'number', ['number', 'number'], [argList.ptr, 0]);
        if (!optsPtr) fail('Invalid options for ' + req.program);
        const p = req.program;
        if (p === 'gdalinfo' || p === 'ogrinfo') {
          const fn = p === 'gdalinfo' ? 'GDALInfo' : 'GDALVectorInfo';
          const text = takeCString(cc(fn, 'number', ['number', 'number'], [opened[0], optsPtr]));
          if (text === null) fail(p + ' failed');
          return { ok: true, text: text };
        }
        const list = cPointers(opened);
        try {
          if (p === 'ogr2ogr') {
            out = cc('GDALVectorTranslate', 'number', ['string', 'number', 'number', 'number', 'number', 'number'],
              [req.dst, 0, opened.length, list, optsPtr, usage]);
          } else if (p === 'gdal_translate') {
            out = cc('GDALTranslate', 'number', ['string', 'number', 'number', 'number'], [req.dst, opened[0], optsPtr, usage]);
          } else if (p === 'gdalwarp') {
            out = cc('GDALWarp', 'number', ['string', 'number', 'number', 'number', 'number', 'number'],
              [req.dst, 0, opened.length, list, optsPtr, usage]);
          } else if (p === 'gdal_rasterize') {
            if (req.update) {
              // Burn into an existing raster: GDALRasterize returns the same handle (closed in finally).
              dstH = openDataset({ path: req.dst }, OF_RASTER | OF_UPDATE);
              const res = cc('GDALRasterize', 'number', ['string', 'number', 'number', 'number', 'number'], [null, dstH, opened[0], optsPtr, usage]);
              if (!res) fail('gdal_rasterize failed');
              if (res !== dstH) out = res;
              return { ok: true };
            }
            out = cc('GDALRasterize', 'number', ['string', 'number', 'number', 'number', 'number'], [req.dst, 0, opened[0], optsPtr, usage]);
          } else if (p === 'gdaldem') {
            out = cc('GDALDEMProcessing', 'number', ['string', 'number', 'string', 'string', 'number', 'number'],
              [req.dst, opened[0], req.mode, req.colorFile || null, optsPtr, usage]);
          } else if (p === 'gdalbuildvrt') {
            out = cc('GDALBuildVRT', 'number', ['string', 'number', 'number', 'number', 'number', 'number'],
              [req.dst, opened.length, list, 0, optsPtr, usage]);
          }
        } finally {
          Mod._free(list);
        }
        if (!out) fail(Mod.HEAP32[usage >> 2] ? 'Invalid arguments for ' + p : p + ' failed');
        return { ok: true };
      } finally {
        if (out) closeDataset(out);
        if (dstH) closeDataset(dstH);
        if (optsPtr) cc(app[1], null, ['number'], [optsPtr]);
        if (argList) argList.free();
        opened.forEach(closeDataset);
        Mod._free(usage);
        restoreConfig();
      }
    }

    /** Open a dataset and report what it contains. */
    function probe(req) {
      const h = openDataset(req.src, OF_RASTER | OF_VECTOR);
      try {
        return {
          driver: driverName(h),
          bands: cc('GDALGetRasterCount', 'number', ['number'], [h]),
          layers: cc('GDALDatasetGetLayerCount', 'number', ['number'], [h]),
          width: cc('GDALGetRasterXSize', 'number', ['number'], [h]),
          height: cc('GDALGetRasterYSize', 'number', ['number'], [h]),
        };
      } finally {
        closeDataset(h);
      }
    }

    /** gdaltransform: req = { coords: [[x, y, z?]], options: ['SRC_SRS=…', …], inverse } */
    function transform(req) {
      const coords = req.coords || [];
      const opts = cStrings(req.options || []);
      const tr = cc('GDALCreateGenImgProjTransformer2', 'number', ['number', 'number', 'number'], [0, 0, opts.ptr]);
      opts.free();
      if (!tr) fail('Could not set up the coordinate transformation');
      const n = coords.length;
      const xs = Mod._malloc(8 * Math.max(1, n));
      const ys = Mod._malloc(8 * Math.max(1, n));
      const zs = Mod._malloc(8 * Math.max(1, n));
      const ok = Mod._malloc(4 * Math.max(1, n));
      try {
        for (let i = 0; i < n; i++) {
          Mod.HEAPF64[(xs >> 3) + i] = +coords[i][0];
          Mod.HEAPF64[(ys >> 3) + i] = +coords[i][1];
          Mod.HEAPF64[(zs >> 3) + i] = +(coords[i][2] || 0);
          Mod.HEAP32[(ok >> 2) + i] = 0;
        }
        cc('GDALGenImgProjTransform', 'number', ['number', 'number', 'number', 'number', 'number', 'number', 'number'],
          [tr, req.inverse ? 1 : 0, n, xs, ys, zs, ok]);
        const result = [];
        const success = [];
        for (let i = 0; i < n; i++) {
          result.push([Mod.HEAPF64[(xs >> 3) + i], Mod.HEAPF64[(ys >> 3) + i], Mod.HEAPF64[(zs >> 3) + i]]);
          success.push(Mod.HEAP32[(ok >> 2) + i] !== 0);
        }
        return { coords: result, success: success };
      } finally {
        cc('GDALDestroyGenImgProjTransformer', null, ['number'], [tr]);
        Mod._free(xs); Mod._free(ys); Mod._free(zs); Mod._free(ok);
      }
    }

    /** Validate a CRS definition with GDAL/PROJ; returns its WKT. */
    function srs(req) {
      const h = cc('OSRNewSpatialReference', 'number', ['string'], ['']);
      try {
        const err = cc('OSRSetFromUserInput', 'number', ['number', 'string'], [h, String(req.input)]);
        if (err !== 0) return { ok: false, error: errorLines()[0] || 'Unrecognised CRS ' + req.input };
        const pp = Mod._malloc(4);
        Mod.HEAPU32[pp >> 2] = 0;
        cc('OSRExportToWkt', 'number', ['number', 'number'], [h, pp]);
        const wkt = takeCString(Mod.HEAPU32[pp >> 2]);
        Mod._free(pp);
        return { ok: true, wkt: wkt };
      } finally {
        cc('OSRDestroySpatialReference', 'number', ['number'], [h]);
      }
    }

    function drivers() {
      const out = { vector: [], raster: [] };
      ['vector', 'raster'].forEach(function (kind) {
        const d = (Gdal.drivers && Gdal.drivers[kind]) || {};
        Object.keys(d).forEach(function (k) {
          const x = d[k];
          out[kind].push({
            name: x.shortName,
            longName: x.longName,
            extensions: String(x.extensions || '').split(/\s+/).filter(Boolean),
            canRead: !!x.isReadable,
            canWrite: !!x.isWritable,
          });
        });
      });
      return { drivers: out };
    }

    const OPS = {
      write: function (req) {
        (req.files || []).forEach(function (f) {
          mkdirp(parentOf(f.path));
          FS.writeFile(f.path, f.bytes);
        });
        return {};
      },
      read: function (req) {
        return { files: (req.paths || []).map(function (p) { return { path: p, bytes: FS.readFile(p) }; }) };
      },
      list: function (req) { return { entries: exists(req.dir) ? walk(req.dir, []) : [] }; },
      remove: function (req) { (req.paths || []).forEach(rmrf); return {}; },
      run: run,
      probe: probe,
      transform: transform,
      srs: srs,
      drivers: drivers,
    };

    const ENGINE_CONFIG = {
      // Keep SQLite-based drivers (GPKG, SQLite, SQL dialect) from leaving journal
      // files next to outputs, and make them faster on MEMFS.
      OGR_SQLITE_JOURNAL: 'MEMORY',
      OGR_SQLITE_SYNCHRONOUS: 'OFF',
      // This wasm build has no threads. GDAL 3.8's ogr2ogr reads GPKG through the
      // Arrow stream API, which starts a prefetch thread ("Cannot start worker thread").
      OGR2OGR_USE_ARROW_API: 'NO',
      OGR_GPKG_STREAM_BASE_IMPL: 'YES',
      OGR_GPKG_NUM_THREADS: '1',
    };
    Object.keys(ENGINE_CONFIG).forEach(function (k) {
      cc('CPLSetConfigOption', null, ['string', 'string'], [k, ENGINE_CONFIG[k]]);
    });

    return {
      call: function (op, args) {
        const fn = OPS[op];
        if (!fn) throw new Error('Unknown GDAL engine operation "' + op + '"');
        return withConsoleCapture(function () {
          resetErrors();
          try {
            const r = fn(args || {}) || {};
            r.logs = takeLogs();
            return r;
          } catch (e) {
            const err = e instanceof Error ? e : new Error(String(e));
            err.logs = takeLogs();
            if (typeof WebAssembly !== 'undefined' && e instanceof WebAssembly.RuntimeError) err.fatal = true;
            if (/^(Aborted|RuntimeError)/.test(String(err.message))) err.fatal = true;
            throw err;
          }
        });
      },
    };
  }

  /* =====================================================================
   * Worker bootstrap — also serialised with Function#toString.
   * Receives { op: 'init', args: { script, path } } first, then engine calls.
   * ===================================================================== */
  function workerMain(makeEngine) {
    const sink = { lines: [] };
    let engine = null;
    function errorPayload(e) {
      return {
        message: String((e && e.message) || e || 'GDAL error'),
        logs: (e && e.logs) || [],
        fatal: !!(e && (e.fatal || (typeof WebAssembly !== 'undefined' && e instanceof WebAssembly.RuntimeError))),
      };
    }
    function handler(ev) {
      const m = ev.data || {};
      if (m.op === 'init') {
        try {
          importScripts(m.args.script);
        } catch (e) {
          self.onmessage = handler;
          self.postMessage({ id: m.id, ok: false, error: errorPayload(new Error('Could not load ' + m.args.script)) });
          return;
        }
        // gdal3.js installs its own worker message handler when it detects importScripts.
        self.onmessage = handler;
        if (typeof self.initGdalJs !== 'function') {
          self.postMessage({ id: m.id, ok: false, error: errorPayload(new Error('gdal3.js did not load')) });
          return;
        }
        self.initGdalJs({
          path: m.args.path,
          useWorker: false,
          logHandler: function (t) { sink.lines.push({ type: 'stdout', text: String(t) }); },
          errorHandler: function (t) { sink.lines.push({ type: 'stderr', text: String(t) }); },
        }).then(function (Gdal) {
          engine = makeEngine(Gdal, sink);
          self.postMessage({ id: m.id, ok: true, result: engine.call('drivers', {}) });
        }, function (e) {
          self.postMessage({ id: m.id, ok: false, error: errorPayload(e) });
        });
        return;
      }
      if (!engine) {
        self.postMessage({ id: m.id, ok: false, error: { message: 'GDAL is not ready yet' } });
        return;
      }
      try {
        const r = engine.call(m.op, m.args);
        const transfer = [];
        (r.files || []).forEach(function (f) {
          if (f.bytes && f.bytes.buffer && transfer.indexOf(f.bytes.buffer) < 0) transfer.push(f.bytes.buffer);
        });
        self.postMessage({ id: m.id, ok: true, result: r }, transfer);
      } catch (e) {
        self.postMessage({ id: m.id, ok: false, error: errorPayload(e) });
      }
    }
    self.onmessage = handler;
  }

  /* =====================================================================
   * Page side
   * ===================================================================== */

  const util = M.util;
  const GDAL_VERSION = '3.8.4';
  const GDAL3JS_VERSION = '2.8.1';
  const DEFAULT_CDN = 'https://cdn.jsdelivr.net/npm/gdal3.js@2.8.1/dist/package';
  // Subresource integrity of dist/package/gdal3.js 2.8.1 (from the gdal3.js README; matches vendor/gdal3/gdal3.js).
  const CDN_SRI = 'sha384-yW4c2Jx7lsREjJg58+ZI5U6gAso2bRAPw3LdzPWm7z8+rMJ24R7AS+EFyXDPxgYM';
  const INIT_TIMEOUT_MS = 5 * 60 * 1000;
  const LITTLE_ENDIAN = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;
  const FS_ROOT = '/psicits'; // per-command scratch space in GDAL's in-memory file system

  const DEFAULT_CONFIG = { localPath: 'vendor/gdal3', cdnPath: DEFAULT_CDN, init: null, worker: true };
  let config = Object.assign({}, DEFAULT_CONFIG);
  let runtime = null; // { backend, info }
  let loading = null;
  let jobSeq = 0;
  let queue = Promise.resolve();

  function enqueue(fn) {
    const p = queue.then(fn);
    queue = p.catch(function () {});
    return p;
  }

  function tick() { return new Promise(function (r) { setTimeout(r, 0); }); }
  function isNodeEnv() {
    return typeof process !== 'undefined' && !!(process.versions && process.versions.node) && typeof document === 'undefined';
  }
  function errMsg(e) { return String((e && e.message) || e); }

  /* ------------------------------------------------------------ backends */

  function toError(e) {
    const err = new Error(errMsg(e));
    err.logs = (e && e.logs) || [];
    err.fatal = !!(e && e.fatal);
    return err;
  }

  function directBackend(engine, yieldFirst) {
    return {
      call: async function (op, args) {
        if (yieldFirst) await tick(); // let the page repaint between steps on the main thread
        try { return engine.call(op, args); } catch (e) { throw toError(e); }
      },
      dispose: function () {},
    };
  }

  function makeRuntimeInfo(mode, source, path, drivers, raw) {
    return {
      mode: mode, source: source, path: path || null,
      gdalVersion: GDAL_VERSION, gdal3jsVersion: GDAL3JS_VERSION,
      drivers: drivers, programs: PROGRAMS.slice(), gdal: raw || null,
    };
  }

  function directRuntime(Gdal, sink, mode, source, path) {
    if (!Gdal || !Gdal.Module || !Gdal.Module.FS || typeof Gdal.Module.ccall !== 'function') {
      throw new Error('PSICITS needs gdal3.js initialised with useWorker: false (direct access to Module)');
    }
    const engine = createEngine(Gdal, sink || { lines: [] });
    const drivers = engine.call('drivers', {}).drivers;
    return { backend: directBackend(engine, mode === 'main-thread'), info: makeRuntimeInfo(mode, source, path, drivers, Gdal) };
  }

  function workerRuntime(base, source) {
    return new Promise(function (resolve, reject) {
      const src = '"use strict";\nvar createEngine = ' + createEngine.toString() + ';\n(' + workerMain.toString() + ')(createEngine);\n';
      const url = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
      let worker;
      try {
        worker = new Worker(url);
      } catch (e) {
        URL.revokeObjectURL(url);
        reject(e);
        return;
      }
      const pending = new Map();
      let seq = 0;
      let dead = null;
      const killAll = function (err) {
        dead = err;
        pending.forEach(function (p) { p.reject(err); });
        pending.clear();
      };
      worker.onmessage = function (ev) {
        const m = ev.data || {};
        const p = pending.get(m.id);
        if (!p) return;
        pending.delete(m.id);
        if (m.ok) p.resolve(m.result);
        else p.reject(toError(m.error || {}));
      };
      worker.onerror = function (ev) {
        if (ev && ev.preventDefault) ev.preventDefault();
        const err = new Error('GDAL worker failed: ' + ((ev && ev.message) || 'unknown error'));
        err.fatal = true; // the next command reloads GDAL
        killAll(err);
      };
      const post = function (op, args, transfer) {
        if (dead) return Promise.reject(dead);
        return new Promise(function (res, rej) {
          const id = ++seq;
          pending.set(id, { resolve: res, reject: rej });
          try { worker.postMessage({ id: id, op: op, args: args }, transfer || []); } catch (e) { pending.delete(id); rej(e); }
        });
      };
      const backend = {
        call: function (op, args) { return post(op, args, transferList(args)); },
        dispose: function () { killAll(new Error('GDAL was unloaded')); worker.terminate(); },
      };
      const timer = setTimeout(function () { killAll(new Error('timed out')); worker.terminate(); }, INIT_TIMEOUT_MS);
      post('init', { script: base + 'gdal3.js', path: base }).then(function (r) {
        clearTimeout(timer);
        URL.revokeObjectURL(url);
        resolve({ backend: backend, info: makeRuntimeInfo('worker', source, base, r.drivers) });
      }, function (e) {
        clearTimeout(timer);
        URL.revokeObjectURL(url);
        worker.terminate();
        reject(e);
      });
    });
  }

  /** Buffers we own (freshly encoded) can be transferred to the worker instead of copied. */
  function transferList(args) {
    const out = [];
    ((args && args.files) || []).forEach(function (f) {
      if (f.transfer && f.bytes && f.bytes.buffer && f.bytes.byteOffset === 0 &&
          f.bytes.byteLength === f.bytes.buffer.byteLength && out.indexOf(f.bytes.buffer) < 0) out.push(f.bytes.buffer);
    });
    return out;
  }

  /* -------------------------------------------------------------- loader */

  function absoluteBase(path) {
    let p = String(path || '');
    if (!/\/$/.test(p)) p += '/';
    const baseURI = (typeof document !== 'undefined' && document.baseURI) || (root.location && root.location.href);
    return baseURI ? new URL(p, baseURI).href : p;
  }

  function loadScriptTag(url, integrity) {
    return new Promise(function (resolve, reject) {
      const s = document.createElement('script');
      s.src = url;
      s.async = true;
      if (integrity) { s.integrity = integrity; s.crossOrigin = 'anonymous'; }
      s.onload = function () { resolve(); };
      s.onerror = function () { reject(new Error('could not load ' + url)); };
      (document.head || document.documentElement).appendChild(s);
    });
  }

  async function mainThreadRuntime(base, source) {
    // Each script evaluation creates a fresh gdal3.js instance (its init promise is cached per instance).
    await loadScriptTag(base + 'gdal3.js', source === 'cdn' && config.cdnPath === DEFAULT_CDN ? CDN_SRI : null);
    if (typeof root.initGdalJs !== 'function') throw new Error('gdal3.js did not define initGdalJs');
    const sink = { lines: [] };
    const Gdal = await root.initGdalJs({
      path: base,
      useWorker: false,
      logHandler: function (t) { sink.lines.push({ type: 'stdout', text: String(t) }); },
      errorHandler: function (t) { sink.lines.push({ type: 'stderr', text: String(t) }); },
    });
    return directRuntime(Gdal, sink, 'main-thread', source, base);
  }

  async function localFilesPresent(base) {
    if (typeof fetch !== 'function') return true;
    try {
      const r = await fetch(base + 'gdal3.js', { method: 'HEAD', cache: 'no-cache' });
      return r.ok || r.status === 405 || r.status === 501; // some static servers don't implement HEAD
    } catch (e) {
      return false;
    }
  }

  async function loadBrowser(status) {
    const loc = root.location || {};
    const httpPage = loc.protocol === 'http:' || loc.protocol === 'https:';
    const errors = [];
    const candidates = [];
    if (httpPage && config.localPath) {
      const base = absoluteBase(config.localPath);
      if (await localFilesPresent(base)) candidates.push(['local', base]);
      else errors.push('local files not found at ' + base);
    }
    if (config.cdnPath) candidates.push(['cdn', absoluteBase(config.cdnPath)]);
    const canWorker = config.worker !== false && typeof Worker === 'function' && typeof Blob === 'function' &&
      typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function';
    for (const pass of canWorker ? ['worker', 'main-thread'] : ['main-thread']) {
      for (const [source, base] of candidates) {
        status((source === 'cdn' ? 'Downloading GDAL from the CDN (~40 MB, first time only)…' : 'Loading GDAL…') +
          (pass === 'worker' ? '' : ' (main thread)'));
        try {
          return pass === 'worker' ? await workerRuntime(base, source) : await mainThreadRuntime(base, source);
        } catch (e) {
          errors.push(source + ' ' + pass + ': ' + errMsg(e));
        }
      }
    }
    const why = errors.length ? ' (' + errors.join('; ') + ')' : '';
    if (!httpPage) throw new Error('GDAL needs an internet connection or the app served over http' + why);
    throw new Error('Could not load GDAL: the files in ' + config.localPath + ' are missing and the CDN is unreachable' + why);
  }

  function nodeRequire() {
    if (typeof require === 'function') return require; // eslint-disable-line no-undef
    if (typeof process !== 'undefined' && typeof process.getBuiltinModule === 'function') {
      return process.getBuiltinModule('module').createRequire(process.cwd() + '/');
    }
    if (typeof process !== 'undefined' && process.mainModule) return process.mainModule.require.bind(process.mainModule);
    throw new Error('Cannot load GDAL: require() is not available');
  }

  async function loadNode(status) {
    const req = nodeRequire();
    const path = req('path');
    const fs = req('fs');
    const candidates = [path.resolve(config.localPath || 'vendor/gdal3')];
    // Also look next to this file (js/lib/gdal.js -> ../../vendor/gdal3) using the stack trace.
    const m = /\(?((?:\/|[A-Za-z]:\\)[^():]*gdal\.js):\d+:\d+/.exec(String(new Error().stack));
    if (m) candidates.push(path.resolve(path.dirname(m[1]), '..', '..', 'vendor', 'gdal3'));
    const dir = candidates.find(function (d) { return fs.existsSync(path.join(d, 'gdal3.node.js')); });
    if (!dir) throw new Error('Could not find gdal3.node.js (looked in ' + candidates.join(', ') + ')');
    status('Loading GDAL…');
    const init = req(path.join(dir, 'gdal3.node.js'));
    // gdal3.js resolves `path` relative to the working directory in Node.
    const rel = path.relative(process.cwd(), dir).split(path.sep).join('/') || '.';
    const sink = { lines: [] };
    const Gdal = await init({
      path: rel,
      logHandler: function (t) { sink.lines.push({ type: 'stdout', text: String(t) }); },
      errorHandler: function (t) { sink.lines.push({ type: 'stderr', text: String(t) }); },
    });
    return directRuntime(Gdal, sink, 'node', 'local', dir);
  }

  async function loadInWorkerScope(status) {
    // PSICITS's own code running inside a Web Worker: load gdal3.js right here.
    status('Loading GDAL…');
    const base = absoluteBase(config.localPath);
    const prev = root.onmessage;
    importScripts(base + 'gdal3.js'); // eslint-disable-line no-undef
    root.onmessage = prev; // gdal3.js replaces onmessage when it detects importScripts
    const sink = { lines: [] };
    const Gdal = await root.initGdalJs({
      path: base, useWorker: false,
      logHandler: function (t) { sink.lines.push({ type: 'stdout', text: String(t) }); },
      errorHandler: function (t) { sink.lines.push({ type: 'stderr', text: String(t) }); },
    });
    return directRuntime(Gdal, sink, 'worker', 'local', base);
  }

  async function doLoad(status) {
    if (typeof config.init === 'function') {
      status('Loading GDAL…');
      const Gdal = await config.init();
      return directRuntime(Gdal, { lines: [] }, isNodeEnv() ? 'node' : 'main-thread', 'injected', null);
    }
    if (isNodeEnv()) return loadNode(status);
    if (typeof document !== 'undefined') return loadBrowser(status);
    if (typeof importScripts === 'function') return loadInWorkerScope(status);
    throw new Error('GDAL cannot be loaded in this environment');
  }

  function disposeRuntime() {
    if (runtime) { try { runtime.backend.dispose(); } catch (e) { /* ignore */ } }
    runtime = null;
    loading = null;
  }

  function ensureRuntime(opts) {
    if (runtime) return Promise.resolve(runtime);
    const onStatus = opts && opts.onStatus;
    const status = function (s) { if (typeof onStatus === 'function') { try { onStatus(s); } catch (e) { /* ignore */ } } };
    if (!loading) {
      loading = doLoad(status).then(function (rt) {
        runtime = rt;
        status('GDAL ready');
        return rt;
      }, function (e) {
        loading = null;
        throw e;
      });
    }
    return loading;
  }

  /* ------------------------------------------------------------- drivers */

  const FORMAT_ALIASES = {
    shp: 'ESRI Shapefile', shape: 'ESRI Shapefile', shapefile: 'ESRI Shapefile', 'esri shapefile': 'ESRI Shapefile',
    geopackage: 'GPKG', gpkg: 'GPKG', json: 'GeoJSON', geojson: 'GeoJSON', geojsonl: 'GeoJSONSeq', geojsonseq: 'GeoJSONSeq', ndjson: 'GeoJSONSeq',
    fgb: 'FlatGeobuf', flatgeobuf: 'FlatGeobuf', gdb: 'OpenFileGDB', filegdb: 'OpenFileGDB', fgdb: 'OpenFileGDB',
    tab: 'MapInfo File', mapinfo: 'MapInfo File', mif: 'MapInfo File', kml: 'KML', gml: 'GML', gpx: 'GPX', dxf: 'DXF',
    csv: 'CSV', xlsx: 'XLSX', excel: 'XLSX', ods: 'ODS', sqlite: 'SQLite', spatialite: 'SQLite', pmtiles: 'PMTiles', mvt: 'MVT',
    tif: 'GTiff', tiff: 'GTiff', geotiff: 'GTiff', gtiff: 'GTiff', cog: 'COG', png: 'PNG', jpg: 'JPEG', jpeg: 'JPEG', gif: 'GIF',
    webp: 'WEBP', bmp: 'BMP', asc: 'AAIGrid', aaigrid: 'AAIGrid', img: 'HFA', erdas: 'HFA', vrt: 'VRT', envi: 'ENVI', ehdr: 'EHdr',
    bil: 'EHdr', xyz: 'XYZ', mbtiles: 'MBTiles', pdf: 'PDF', netcdf: null, nc: null,
  };
  const PREFERRED_BY_EXT = {
    vector: { json: 'GeoJSON', geojson: 'GeoJSON', geojsonl: 'GeoJSONSeq', geojsons: 'GeoJSONSeq', gml: 'GML', xml: 'GML', db: 'SQLite', sqlite: 'SQLite', gpkg: 'GPKG', kml: 'KML', shp: 'ESRI Shapefile', tab: 'MapInfo File', mif: 'MapInfo File', map: 'WAsP', txt: 'VDV', pbf: 'MVT', mvt: 'MVT' },
    raster: { tif: 'GTiff', tiff: 'GTiff', img: 'HFA', grd: 'GSBG', ter: 'Terragen', map: 'PCRaster', kml: 'KMLSUPEROVERLAY', kmz: 'KMLSUPEROVERLAY', gpkg: 'GPKG', sqlite: 'Rasterlite', xml: 'PDS4', gif: 'GIF', hdr: 'MFF' },
  };
  // Vector drivers that write a directory when the output name has no extension (GDAL semantics).
  const DIRECTORY_DRIVERS = ['ESRI Shapefile', 'MapInfo File'];

  function driverList(kind) {
    return (runtime && runtime.info.drivers && runtime.info.drivers[kind]) || [];
  }

  /** Canonical driver short name for a user-supplied name or alias; null if unknown. */
  function canonicalDriver(name, kind) {
    if (!name) return null;
    const n = String(name).trim();
    const lower = n.toLowerCase();
    const kinds = kind ? [kind] : ['vector', 'raster'];
    for (const k of kinds) {
      const hit = driverList(k).find(function (d) { return d.name.toLowerCase() === lower; });
      if (hit) return hit.name;
    }
    if (Object.prototype.hasOwnProperty.call(FORMAT_ALIASES, lower)) {
      const a = FORMAT_ALIASES[lower];
      if (a === null) return null;
      for (const k of kinds) if (driverList(k).some(function (d) { return d.name === a; })) return a;
    }
    return null;
  }

  function findDriver(name, kind) {
    return driverList(kind).find(function (d) { return d.name === name; }) || null;
  }

  function driverForExtension(ext, kind) {
    ext = String(ext || '').toLowerCase();
    if (!ext) return null;
    const pref = PREFERRED_BY_EXT[kind][ext];
    if (pref && findDriver(pref, kind)) return pref;
    const hit = driverList(kind).find(function (d) { return d.canWrite && d.extensions.indexOf(ext) >= 0; });
    return hit ? hit.name : null;
  }

  function primaryExtension(driver, kind) {
    if (driver === 'GeoJSON') return 'geojson';
    const d = findDriver(driver, kind);
    return d && d.extensions.length ? d.extensions[0] : '';
  }

  /* ------------------------------------------------------------ splitArgs */

  /**
   * Split a command line into argv, POSIX-shell style: whitespace separates
   * words, "double quotes" allow backslash escapes (\" \\ \$ \`), 'single
   * quotes' are literal, a backslash outside quotes escapes the next
   * character, adjacent quoted/unquoted pieces join. No globbing or
   * variable expansion.
   * @param {string} cmdline
   * @returns {string[]}
   */
  function splitArgs(cmdline) {
    const s = String(cmdline === null || cmdline === undefined ? '' : cmdline);
    const out = [];
    let cur = '';
    let inWord = false;
    let i = 0;
    while (i < s.length) {
      const c = s[i];
      if (c === '\\') {
        if (i + 1 < s.length) {
          if (s[i + 1] === '\n') { i += 2; continue; } // line continuation
          cur += s[i + 1];
          i += 2;
        } else {
          cur += c;
          i++;
        }
        inWord = true;
      } else if (c === "'") {
        const end = s.indexOf("'", i + 1);
        if (end < 0) throw new Error('Unterminated single quote in command');
        cur += s.slice(i + 1, end);
        i = end + 1;
        inWord = true;
      } else if (c === '"') {
        i++;
        let closed = false;
        while (i < s.length) {
          const d = s[i];
          if (d === '\\' && i + 1 < s.length && '"\\$`\n'.indexOf(s[i + 1]) >= 0) {
            if (s[i + 1] !== '\n') cur += s[i + 1];
            i += 2;
          } else if (d === '"') {
            closed = true;
            i++;
            break;
          } else {
            cur += d;
            i++;
          }
        }
        if (!closed) throw new Error('Unterminated double quote in command');
        inWord = true;
      } else if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
        if (inWord) { out.push(cur); cur = ''; inWord = false; }
        i++;
      } else {
        cur += c;
        inWord = true;
        i++;
      }
    }
    if (inWord) out.push(cur);
    return out;
  }

  /* -------------------------------------------------------- option tables */

  const PROGRAMS = ['ogr2ogr', 'ogrinfo', 'gdal_translate', 'gdalwarp', 'gdal_rasterize', 'gdalinfo',
    'gdal_location_info', 'gdaltransform', 'gdaldem', 'gdalbuildvrt'];
  const PROGRAM_ALIASES = { gdallocationinfo: 'gdal_location_info' };

  function table(spec) {
    const t = Object.create(null);
    spec.trim().split(/\s+/).forEach(function (tok) {
      const i = tok.indexOf(':');
      const name = (i < 0 ? tok : tok.slice(0, i)).toLowerCase();
      const n = i < 0 ? 0 : tok.slice(i + 1);
      t[name] = /^\d+$/.test(String(n)) ? +n : n;
    });
    return t;
  }

  const NUM_RE = /^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?%?$/;
  function isNumTok(t) { return typeof t === 'string' && NUM_RE.test(t); }

  const ARITY = {
    clip: function (a, i) { return [1, 2, 3, 4].every(function (k) { return isNumTok(a[i + k]); }) ? 4 : 1; },
    gcp: function (a, i) { return isNumTok(a[i + 5]) ? 5 : 4; },
    scale: function (a, i) { let n = 0; while (n < 4 && isNumTok(a[i + 1 + n])) n++; return n >= 4 ? 4 : n >= 2 ? 2 : 0; },
    tr: function (a, i) { return String(a[i + 1] || '').toLowerCase() === 'square' ? 1 : 2; },
    refine: function (a, i) { return isNumTok(a[i + 2]) ? 2 : 1; },
  };

  const COMMON_OPTS = table('--config:2 --debug:1 --quiet -q -quiet --help --help-general --long-usage --usage --version --formats --format:1 --optfile:1 --pause');

  const OPTIONS = {
    ogr2ogr: table('-f:1 -of:1 -append -upsert -overwrite -update -dsco:1 -lco:1 -oo:1 -doo:1 -sql:1 -dialect:1 -where:1 ' +
      '-select:1 -nln:1 -nlt:1 -dim:1 -a_srs:1 -t_srs:1 -s_srs:1 -ct:1 -spat:4 -spat_srs:1 -geomfield:1 -clipsrc:clip ' +
      '-clipsrcsql:1 -clipsrclayer:1 -clipsrcwhere:1 -clipdst:clip -clipdstsql:1 -clipdstlayer:1 -clipdstwhere:1 ' +
      '-segmentize:1 -simplify:1 -wrapdateline -datelineoffset:1 -explodecollections -zfield:1 -gcp:gcp -order:1 -tps ' +
      '-fieldmap:1 -mapfieldtype:1 -fieldtypetostring:1 -unsetfieldwidth -splitlistfields -maxsubfields:1 ' +
      '-relaxedfieldnamematch -forcenullable -unsetdefault -unsetfid -preserve_fid -fid:1 -limit:1 -gt:1 ' +
      '-ds_transaction -skipfailures -progress -emptystrasnull -resolvedomains -addfields -makevalid -skipinvalid ' +
      '-nomd -mo:1 -nonativedata -a_coord_epoch:1 -s_coord_epoch:1 -t_coord_epoch:1 -xyres:1 -zres:1 -mres:1 ' +
      '-unsetcoordprecision -if:1'),
    ogrinfo: table('-if:1 -json -ro -where:1 -spat:4 -geomfield:1 -fid:1 -sql:1 -dialect:1 -al -rl -so -summary ' +
      '-features -limit:1 -oo:1 -nomd -listmdd -mdd:1 -nocount -nogeomtype -noextent -extent3d -wkt_format:1 -fielddomain:1'),
    gdal_translate: table('-ot:1 -strict -if:1 -of:1 -b:1 -mask:1 -expand:1 -outsize:2 -tr:2 -ovr:1 -r:1 -unscale ' +
      '-scale:scale -exponent:1 -srcwin:4 -epo -eco -projwin:4 -projwin_srs:1 -a_srs:1 -a_coord_epoch:1 -a_ullr:4 ' +
      '-a_nodata:1 -a_gt:6 -a_scale:1 -a_offset:1 -nogcp -gcp:gcp -colorinterp:1 -mo:1 -dmo:1 -sds -co:1 -stats ' +
      '-approx_stats -norat -noxmp -oo:1'),
    gdalwarp: table('-overwrite -of:1 -co:1 -s_srs:1 -t_srs:1 -srcalpha -nosrcalpha -dstalpha -tr:tr -ts:2 -te:4 ' +
      '-te_srs:1 -r:1 -ot:1 -wt:1 -tap -order:1 -tps -rpc -geoloc -et:1 -refine_gcps:refine -to:1 -vshift -novshift ' +
      '-s_coord_epoch:1 -t_coord_epoch:1 -ct:1 -wo:1 -srcnodata:1 -dstnodata:1 -srcband:1 -dstband:1 -wm:1 -multi ' +
      '-cutline:1 -cutline_srs:1 -cl:1 -cwhere:1 -csql:1 -cblend:1 -crop_to_cutline -nomd -cvmd:1 -setci -oo:1 -doo:1 ' +
      '-if:1 -ovr:1'),
    gdal_rasterize: table('-b:1 -i -at -oo:1 -burn:1 -a:1 -3d -add -l:1 -where:1 -sql:1 -dialect:1 -of:1 -a_srs:1 ' +
      '-to:1 -co:1 -a_nodata:1 -init:1 -te:4 -tr:2 -tap -ts:2 -ot:1 -optim:1'),
    gdalinfo: table('-json -mm -stats -approx_stats -hist -nogcp -nomd -norat -noct -nofl -checksum -listmdd -mdd:1 ' +
      '-proj4 -wkt_format:1 -sd:1 -oo:1 -if:1 -nonodata -nomask'),
    gdal_location_info: table('-xml -lifonly -valonly -e -field_sep:1 -ignore_extra_input -b:1 -overview:1 -l_srs:1 ' +
      '-geoloc -wgs84 -oo:1 -r:1'),
    gdaltransform: table('-i -s_srs:1 -t_srs:1 -to:1 -s_coord_epoch:1 -t_coord_epoch:1 -ct:1 -order:1 -tps -rpc ' +
      '-geoloc -gcp:gcp -output_xy -e -field_sep:1 -ignore_extra_input'),
    gdaldem: table('-of:1 -co:1 -b:1 -compute_edges -alg:1 -z:1 -s:1 -az:1 -alt:1 -combined -multidirectional -igor ' +
      '-p -trigonometric -zero_for_flat -alpha -exact_color_entry -nearest_color_entry'),
    gdalbuildvrt: table('-tileindex:1 -resolution:1 -te:4 -tr:2 -tap -separate -b:1 -sd:1 -allow_projection_difference ' +
      '-addalpha -hidenodata -srcnodata:1 -vrtnodata:1 -ignore_srcmaskband -a_srs:1 -r:1 -oo:1 -input_file_list:1 ' +
      '-overwrite -strict -non_strict -nodata_max_mask_threshold:1'),
  };
  const OPTION_PATTERNS = {
    gdal_translate: [[/^-scale_\d+$/, 'scale'], [/^-exponent_\d+$/, 1], [/^-colorinterp_\d+$/, 1]],
    ogrinfo: [[/^-(fields|geom)=/, 0]],
  };

  function optionArity(program, tok, argv, i) {
    const lower = tok.toLowerCase();
    let a = OPTIONS[program][lower];
    if (a === undefined) a = COMMON_OPTS[lower];
    if (a === undefined) {
      const pat = (OPTION_PATTERNS[program] || []).find(function (p) { return p[0].test(lower); });
      if (pat) a = pat[1];
    }
    if (a === undefined) return -1;
    return typeof a === 'number' ? a : ARITY[a](argv, i);
  }

  /**
   * Parse a GDAL command line.
   * @param {string|string[]} cmdline
   * @returns {{ program, argv, options: Array<{name, values}>, positionals: string[],
   *            meta: { map, download, name }, unknown: string[] }}
   */
  function parse(cmdline) {
    const argv = Array.isArray(cmdline) ? cmdline.map(String) : splitArgs(cmdline);
    if (!argv.length) throw new Error('Type a GDAL command, e.g. ogr2ogr -f GPKG roads.gpkg roads');
    let prog = argv[0].replace(/^.*[\\/]/, '').replace(/\.(exe|py)$/i, '').toLowerCase();
    prog = PROGRAM_ALIASES[prog] || prog;
    if (PROGRAMS.indexOf(prog) < 0) {
      throw new Error('Unknown GDAL program "' + argv[0] + '". Supported: ' + PROGRAMS.join(', '));
    }
    const meta = { map: false, download: false, name: null };
    const options = [];
    const positionals = [];
    const unknown = [];
    for (let i = 1; i < argv.length; i++) {
      const tok = argv[i];
      const lower = tok.toLowerCase();
      if (lower === '--map') { meta.map = true; continue; }
      if (lower === '--download') { meta.download = true; continue; }
      if (lower === '--name' || lower.indexOf('--name=') === 0) {
        if (lower === '--name') {
          if (i + 1 >= argv.length) throw new Error('--name needs a layer name');
          meta.name = argv[++i];
        } else {
          meta.name = tok.slice(7);
        }
        continue;
      }
      if (tok.length > 1 && tok[0] === '-' && !isNumTok(tok)) {
        let n = optionArity(prog, tok, argv, i);
        if (n < 0) {
          // Unknown to PSICITS: pass through as a flag and let GDAL judge it.
          n = 0;
          unknown.push(tok);
        }
        if (i + n >= argv.length) throw new Error(tok + ' needs ' + n + ' value' + (n === 1 ? '' : 's'));
        options.push({ name: tok, key: lower, values: argv.slice(i + 1, i + 1 + n) });
        i += n;
      } else {
        positionals.push(tok);
      }
    }
    return { program: prog, argv: argv, options: options, positionals: positionals, meta: meta, unknown: unknown };
  }

  /** Helpers over parsed options. */
  function optValue(P, key) {
    const k = key.toLowerCase();
    for (let i = P.options.length - 1; i >= 0; i--) if (P.options[i].key === k) return P.options[i].values[0];
    return null;
  }
  function optValues(P, key) {
    const k = key.toLowerCase();
    return P.options.filter(function (o) { return o.key === k; }).map(function (o) { return o.values[0]; });
  }
  function hasOpt(P, key) { const k = key.toLowerCase(); return P.options.some(function (o) { return o.key === k; }); }

  // Options PSICITS handles itself instead of passing them to the GDAL library.
  const HOST_OPTIONS = ['--config', '--debug', '-oo', '-if', '--help', '--help-general', '--long-usage', '--usage',
    '--version', '--formats', '--format', '--optfile', '--pause', '--quiet'];

  /** Flatten options (minus host-level ones) back to an argv list for the GDAL library. */
  function libArgs(P, drop) {
    const skip = HOST_OPTIONS.concat((drop || []).map(function (d) { return d.toLowerCase(); }));
    const out = [];
    P.options.forEach(function (o) {
      if (skip.indexOf(o.key) >= 0) return;
      out.push(o.name);
      o.values.forEach(function (v) { out.push(v); });
    });
    return out;
  }

  function configOf(P) {
    const cfg = {};
    P.options.forEach(function (o) {
      if (o.key === '--config') cfg[o.values[0]] = o.values[1];
      if (o.key === '--debug') cfg.CPL_DEBUG = /^(on|yes|true|1)$/i.test(o.values[0]) ? 'ON' : o.values[0];
    });
    return cfg;
  }

  /* ------------------------------------------------------ small helpers */

  function textBytes(s) { return new TextEncoder().encode(s); }
  function bytesText(b) { return new TextDecoder('utf-8').decode(b); }
  function xmlEscape(s) {
    return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]; });
  }
  function baseName(p) { return String(p).replace(/\/+$/, '').replace(/^.*[\\/]/, ''); }
  function extOf(name) {
    const b = baseName(name);
    const i = b.lastIndexOf('.');
    return i > 0 ? b.slice(i + 1).toLowerCase() : '';
  }
  function stripExt(name) {
    const b = baseName(name);
    const i = b.lastIndexOf('.');
    return i > 0 ? b.slice(0, i) : b;
  }
  function safeFileName(name, fallback) {
    let b = baseName(String(name || '')).replace(/[\u0000-\u001f<>:"|?*]+/g, '_').replace(/^\.+/, '').trim();
    if (!b) b = fallback || 'output';
    return b.slice(0, 180);
  }
  function slugOf(name) { return util.slug(name, 60); }
  function fmt(n) { return util.formatNumber ? util.formatNumber(n) : String(n); }

  function cleanLog(line) {
    return String(line).replace(/^(ERROR|Warning) \d+:\s*/, function (m, kind) { return kind === 'ERROR' ? 'Error: ' : 'Warning: '; });
  }
  function isErrorLine(line) { return /^ERROR \d+:/.test(String(line)); }

  /** GDAL data type names for typed arrays. */
  function gdalTypeOf(arr) {
    if (arr instanceof Uint8Array || arr instanceof Uint8ClampedArray) return 'Byte';
    if (arr instanceof Int8Array) return 'Int8';
    if (arr instanceof Int16Array) return 'Int16';
    if (arr instanceof Uint16Array) return 'UInt16';
    if (arr instanceof Int32Array) return 'Int32';
    if (arr instanceof Uint32Array) return 'UInt32';
    if (arr instanceof Float32Array) return 'Float32';
    if (arr instanceof Float64Array) return 'Float64';
    return null;
  }
  const MODEL_TYPE = { Byte: 'uint8', Int16: 'int16', UInt16: 'uint16', Int32: 'int32', UInt32: 'uint32', Float32: 'float32', Float64: 'float64' };
  const ARRAY_OF = { Byte: Uint8Array, Int16: Int16Array, UInt16: Uint16Array, Int32: Int32Array, UInt32: Uint32Array, Float32: Float32Array, Float64: Float64Array };
  const TYPED_FOR_MODEL = { uint8: Uint8Array, int8: Int8Array, int16: Int16Array, uint16: Uint16Array, int32: Int32Array, uint32: Uint32Array, float32: Float32Array, float64: Float64Array };
  // GDAL types outside PSICITS's Raster model are widened when reading back.
  const WIDEN = { Int8: 'Int16', Int64: 'Float64', UInt64: 'Float64', CInt16: 'Float32', CInt32: 'Float64', CFloat32: 'Float32', CFloat64: 'Float64' };

  function parseNoData(v) {
    if (v === undefined || v === null || v === '') return null;
    if (typeof v === 'number') return v;
    const s = String(v).toLowerCase();
    if (s === 'nan') return NaN;
    if (s === 'inf' || s === '+inf' || s === 'infinity') return Infinity;
    if (s === '-inf' || s === '-infinity') return -Infinity;
    const n = Number(v);
    return isFinite(n) ? n : null;
  }

  /* ------------------------------------------------------------- CRS glue */

  /** Rebuild a proj4 string from a proj4js definition object (last-resort fallback). */
  function proj4DefToString(d) {
    if (!d || !d.projName) return null;
    const R2D = 180 / Math.PI;
    const parts = ['+proj=' + d.projName];
    const add = function (k, v, deg) { if (typeof v === 'number' && isFinite(v)) parts.push('+' + k + '=' + (deg ? v * R2D : v)); };
    if (d.projName === 'utm' && d.zone) { parts.push('+zone=' + d.zone); if (d.utmSouth) parts.push('+south'); }
    add('lat_0', d.lat0, true); add('lat_1', d.lat1, true); add('lat_2', d.lat2, true); add('lat_ts', d.lat_ts, true);
    add('lon_0', d.long0, true); add('lonc', d.longc, true); add('alpha', d.alpha, true);
    add('k_0', d.k0); add('x_0', d.x0); add('y_0', d.y0);
    if (d.datumCode && /^(WGS84|NAD83|NAD27)$/i.test(d.datumCode)) {
      parts.push('+datum=' + d.datumCode.toUpperCase());
    } else {
      if (d.ellps) parts.push('+ellps=' + d.ellps);
      else if (d.a) { add('a', d.a); if (d.rf) add('rf', d.rf); else add('b', d.b); }
      if (Array.isArray(d.datum_params) && d.datum_params.some(function (v) { return v; })) parts.push('+towgs84=' + d.datum_params.join(','));
    }
    if (d.from_greenwich) add('pm', d.from_greenwich, true);
    if (d.to_meter && d.to_meter !== 1 && d.projName !== 'longlat') add('to_meter', d.to_meter);
    parts.push('+no_defs');
    return parts.join(' ');
  }

  /** A CRS string GDAL understands for a PSICITS CRS code (EPSG/ESRI code, WKT, proj4 string, or a registered key). */
  function srsForGdal(code) {
    if (code === null || code === undefined || code === '') return null;
    const C = M.crs;
    const c = C ? C.normalize(code) : String(code);
    if (!c) return null;
    if (/^(EPSG|ESRI|IAU_2015|IGNF|OGC):/i.test(c)) return c;
    if (/^\s*\{/.test(c)) return c; // PROJJSON
    if (C && (C.isProj4String(c) || C.isWKT(c))) return c;
    if (C && typeof C.definition === 'function') {
      try { const d = C.definition(c); if (d) return d; } catch (e) { /* ignore */ }
    }
    const p4 = root.proj4;
    if (p4 && typeof p4.defs === 'function') {
      try {
        const d = p4.defs(c);
        if (d && d.projStr) return d.projStr;
        const s = proj4DefToString(d);
        if (s) return s;
      } catch (e) { /* ignore */ }
    }
    return c;
  }

  /** PSICITS CRS code for a gdalinfo -json report (registers unknown definitions with PSICITS.crs). */
  function crsFromInfo(info) {
    const cs = info && info.coordinateSystem;
    const wkt = cs && cs.wkt;
    const p4 = cs && cs.proj4;
    const epsg = info && info.stac && info.stac['proj:epsg'];
    if (!wkt && !epsg) return null;
    const C = M.crs;
    if (epsg) {
      const code = 'EPSG:' + epsg;
      if (C) { try { if (!C.has(code) && (p4 || wkt)) C.register(code, p4 || wkt); } catch (e) { /* keep the code anyway */ } }
      return code;
    }
    if (C) {
      try { return C.fromWKT(wkt); } catch (e) { /* fall through */ }
      if (p4) { try { return C.register('WKT:' + util.uid('gdal'), p4); } catch (e) { /* ignore */ } }
    }
    return p4 || wkt;
  }

  /* ------------------------------------------------ materialising inputs */

  function encodeFeatureCollection(fc, layerName) {
    const feats = (fc && fc.features) || [];
    const parts = ['{"type":"FeatureCollection","name":', JSON.stringify(layerName), ',"features":['];
    for (let i = 0; i < feats.length; i++) {
      const f = feats[i] || {};
      if (i) parts.push(',');
      parts.push('{"type":"Feature","properties":', JSON.stringify(f.properties && typeof f.properties === 'object' ? f.properties : {}),
        ',"geometry":', JSON.stringify(f.geometry || null), '}');
    }
    parts.push(']}');
    return textBytes(parts.join(''));
  }

  /** Raster model -> VRT (+ one raw little-endian file per band). */
  function rasterToVrt(r, dir, slug, srs) {
    const W = r && r.width;
    const H = r && r.height;
    if (!(W > 0 && H > 0) || !Array.isArray(r.bands) || !r.bands.length) throw new Error('Raster "' + slug + '" has no pixel data');
    const files = [];
    const bandXml = [];
    r.bands.forEach(function (band, i) {
      let arr = band;
      if (!ArrayBuffer.isView(arr)) {
        const T = TYPED_FOR_MODEL[r.dataType] || Float64Array;
        arr = T.from(arr || []);
      }
      if (arr.length !== W * H) throw new Error('Raster "' + slug + '" band ' + (i + 1) + ' has ' + arr.length + ' values, expected ' + W * H);
      let type = gdalTypeOf(arr);
      if (!type) { arr = Float64Array.from(arr); type = 'Float64'; }
      const bpp = arr.BYTES_PER_ELEMENT;
      const raw = slug + '_b' + (i + 1) + '.raw';
      files.push({ path: dir + '/' + raw, bytes: new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength) });
      const name = r.bandNames && r.bandNames[i];
      bandXml.push('<VRTRasterBand dataType="' + type + '" band="' + (i + 1) + '" subClass="VRTRawRasterBand">' +
        (name ? '<Description>' + xmlEscape(name) + '</Description>' : '') +
        (r.noData !== null && r.noData !== undefined && r.noData !== '' ? '<NoDataValue>' + (Number.isNaN(+r.noData) ? 'nan' : +r.noData) + '</NoDataValue>' : '') +
        '<SourceFilename relativeToVRT="1">' + xmlEscape(raw) + '</SourceFilename><ImageOffset>0</ImageOffset>' +
        '<PixelOffset>' + bpp + '</PixelOffset><LineOffset>' + bpp * W + '</LineOffset>' +
        '<ByteOrder>' + (LITTLE_ENDIAN ? 'LSB' : 'MSB') + '</ByteOrder></VRTRasterBand>');
    });
    let gt = Array.isArray(r.transform) && r.transform.length === 6 ? r.transform : null;
    if (!gt && Array.isArray(r.bbox) && r.bbox.length === 4) {
      gt = [r.bbox[0], (r.bbox[2] - r.bbox[0]) / W, 0, r.bbox[3], 0, -(r.bbox[3] - r.bbox[1]) / H];
    }
    const xml = '<VRTDataset rasterXSize="' + W + '" rasterYSize="' + H + '">' +
      (srs ? '<SRS>' + xmlEscape(srs) + '</SRS>' : '') +
      (gt ? '<GeoTransform>' + gt.map(Number).join(', ') + '</GeoTransform>' : '') +
      bandXml.join('') + '</VRTDataset>';
    const path = dir + '/' + slug + '.vrt';
    files.push({ path: path, bytes: textBytes(xml), transfer: true });
    return { path: path, files: files };
  }

  /* ------------------------------------------- choosing files in datasets */

  const VECTOR_MAIN = ['gdb', 'shp', 'gpkg', 'geojson', 'json', 'fgb', 'kml', 'gml', 'gpx', 'tab', 'mif', 'dxf', 'dgn',
    'csv', 'tsv', 'sqlite', 'db', 'ods', 'xlsx', 'xlsm', 'osm', 'pbf', 'topojson', 'geojsonl', 'geojsons', 'jml', 'svg',
    'vrt', 'e00', 'mvt', 'pmtiles', 'mbtiles', 'dwg', 'gmt', 'gxt', 'thf', 'vct', 'ntf', '000', 'dbf', 'xml'];
  const RASTER_MAIN = ['tif', 'tiff', 'vrt', 'img', 'asc', 'bil', 'bip', 'bsq', 'flt', 'dem', 'hgt', 'dt0', 'dt1', 'dt2',
    'png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', 'grd', 'sdat', 'rst', 'ers', 'gpkg', 'mbtiles', 'kap', 'ntf', 'xyz',
    'rsw', 'mpr', 'pix', 'lcp', 'ter', 'bt', 'hf2', 'grb', 'grb2', 'grib2', 'gsb', 'gtx', 'byn', 'rda', 'sigdem', 'kro',
    'gen', 'cub', 'lbl', 'hdf', 'nc', 'map', 'dat'];

  /**
   * Pick the "main" dataset paths among a set of file paths (e.g. roads.shp
   * among roads.shp/.shx/.dbf/.prj). Directories ending in .gdb count as one
   * dataset; several shapefiles in one folder are returned as that folder.
   */
  function pickMainFiles(paths, kind) {
    const exts = kind === 'raster' ? RASTER_MAIN : kind === 'vector' ? VECTOR_MAIN : VECTOR_MAIN.concat(RASTER_MAIN);
    const all = paths.map(String);
    const gdbs = [];
    all.forEach(function (p) {
      const m = /^(.*?\.gdb)(\/|$)/i.exec(p);
      if (m && gdbs.indexOf(m[1]) < 0) gdbs.push(m[1]);
    });
    const files = all.filter(function (p) { return !/\.gdb(\/|$)/i.test(p) && !/\/$/.test(p) && !/(^|\/)(__MACOSX|\.)/.test(p); });
    const lowerSet = new Set(files.map(function (p) { return p.toLowerCase(); }));
    const sibling = function (p, ext) { return lowerSet.has((p.replace(/\.[^./]+$/, '') + '.' + ext).toLowerCase()); };
    const cand = [];
    files.forEach(function (p) {
      const ext = extOf(p);
      if (/\.aux\.xml$/i.test(p) || /\.(shp|tif|tiff)\.xml$/i.test(p)) return;
      if (exts.indexOf(ext) < 0) {
        // ENVI data file without an extension next to its .hdr
        if (!ext && kind !== 'vector' && sibling(p, 'hdr')) cand.push({ p: p, rank: 30 });
        return;
      }
      if (ext === 'dbf' && sibling(p, 'shp')) return;
      if ((ext === 'dat' || ext === 'map') && sibling(p, 'tab')) return; // MapInfo parts
      if (ext === 'dat' && !sibling(p, 'hdr')) return; // .dat is only a raster next to an ENVI .hdr
      if (ext === 'xml' && files.length > 1) return;
      cand.push({ p: p, rank: exts.indexOf(ext) });
    });
    // Several shapefiles in the same folder -> open the folder (one layer each).
    const byDir = {};
    cand.forEach(function (c) {
      if (extOf(c.p) !== 'shp') return;
      const d = c.p.indexOf('/') >= 0 ? c.p.slice(0, c.p.lastIndexOf('/')) : '';
      (byDir[d] = byDir[d] || []).push(c);
    });
    let result = [];
    Object.keys(byDir).forEach(function (d) {
      if (byDir[d].length > 1 && kind !== 'raster') {
        result.push({ p: d, rank: VECTOR_MAIN.indexOf('shp'), dir: true });
        byDir[d].forEach(function (c) { c.drop = true; });
      }
    });
    result = result.concat(cand.filter(function (c) { return !c.drop; }));
    if (kind !== 'raster') gdbs.forEach(function (g) { result.push({ p: g, rank: -1, dir: true }); });
    result.sort(function (a, b) { return a.rank - b.rank; });
    return result.map(function (c) { return c.p; });
  }

  async function zipEntries(bytes) {
    const Z = root.JSZip;
    if (!Z) return null;
    try {
      const z = await Z.loadAsync(bytes);
      return Object.keys(z.files).filter(function (n) { return !z.files[n].dir; });
    } catch (e) {
      return null;
    }
  }

  /** GDAL paths of the dataset(s) inside a loaded file (zip/tar/gz aware). */
  async function containerPaths(path, name, bytes, kind) {
    const lower = name.toLowerCase();
    if (/\.(zip|kmz)$/.test(lower)) {
      const vsi = '/vsizip/' + path;
      const entries = await zipEntries(bytes);
      if (!entries) return [vsi];
      const mains = pickMainFiles(entries, kind);
      return mains.length ? mains.map(function (m) { return m ? vsi + '/' + m : vsi; }) : [vsi];
    }
    if (/\.(tar|tgz|tar\.gz)$/.test(lower)) return ['/vsitar/' + path];
    if (/\.gz$/.test(lower)) return ['/vsigzip/' + path];
    return [path];
  }

  /* ------------------------------------------------------ SQL layer refs */

  const SQL_WORDS = new Set(('SELECT FROM WHERE JOIN LEFT RIGHT INNER OUTER CROSS NATURAL ON AS AND OR NOT NULL IS IN ' +
    'LIKE ILIKE BETWEEN GROUP BY ORDER HAVING LIMIT OFFSET UNION ALL DISTINCT CASE WHEN THEN ELSE END ASC DESC CAST ' +
    'EXISTS WITH VALUES INSERT UPDATE DELETE SET INTO CREATE TABLE DROP ALTER INDEX PRAGMA TRUE FALSE GEOMETRY').split(' '));

  /** Identifier tokens in SQL, skipping 'string literals'. */
  function sqlIdentifiers(sql) {
    const out = [];
    const s = String(sql);
    let i = 0;
    while (i < s.length) {
      const c = s[i];
      if (c === "'") {
        i++;
        while (i < s.length) { if (s[i] === "'") { if (s[i + 1] === "'") { i += 2; continue; } break; } i++; }
        i++;
      } else if (c === '"') {
        let j = i + 1;
        let text = '';
        while (j < s.length) { if (s[j] === '"') { if (s[j + 1] === '"') { text += '"'; j += 2; continue; } break; } text += s[j]; j++; }
        out.push({ text: text, quoted: true, start: i, end: j + 1 });
        i = j + 1;
      } else if (/[A-Za-z_\u00c0-\uffff]/.test(c)) {
        let j = i;
        while (j < s.length && /[A-Za-z0-9_\u00c0-\uffff]/.test(s[j])) j++;
        const prev = s[i - 1];
        if (prev !== '.' && !/[0-9]/.test(prev || '')) out.push({ text: s.slice(i, j), quoted: false, start: i, end: j });
        i = j;
      } else {
        i++;
      }
    }
    return out;
  }

  /* ---------------------------------------------------------------- Jobs */

  /** One command's worth of GDAL work: its own /input and /output directories, name mapping and logs. */
  class Job {
    constructor(rt, opts, result) {
      this.rt = rt;
      this.opts = opts || {};
      this.result = result;
      this.id = 'j' + (++jobSeq);
      // A private root, so gdal3.js's own /input mounts (Gdal.open on host paths) can never hide our files.
      this.root = FS_ROOT + '/' + this.id;
      this.inDir = this.root + '/in';
      this.outDir = this.root + '/out';
      this.rbDir = this.inDir + '/_rb';
      this.inputs = new Map();
      this.slugs = new Set();
      this.names = []; // [internalPath, displayName]
      this.k = 0;
      this.rb = 0;
    }

    log(line) {
      const s = this.unmap(String(line));
      this.result.logs.push(s);
      if (typeof this.opts.onLog === 'function') { try { this.opts.onLog(s); } catch (e) { /* ignore */ } }
    }

    async call(op, args) {
      try {
        const r = await this.rt.backend.call(op, args);
        (r.logs || []).forEach((l) => this.log(cleanLog(l)));
        return r;
      } catch (e) {
        (e.logs || []).forEach((l) => { if (!isErrorLine(l)) this.log(cleanLog(l)); });
        if (e.fatal) disposeRuntime();
        const err = new Error(e.message);
        err.fatal = e.fatal;
        throw err;
      }
    }

    /** Replace internal paths in GDAL messages with the names the user typed. */
    unmap(s) {
      let out = String(s);
      const pairs = this.names.slice().sort(function (a, b) { return b[0].length - a[0].length; });
      pairs.forEach(function (p) { out = out.split(p[0]).join(p[1]); });
      out = out.split('/vsizip/' + this.inDir + '/').join('/vsizip/');
      out = out.replace(new RegExp(this.rbDir.replace(/[/]/g, '\\/') + '\\/', 'g'), '');
      out = out.replace(new RegExp(this.inDir.replace(/[/]/g, '\\/') + '\\/\\d+\\/', 'g'), '');
      out = out.split(this.outDir + '/').join('');
      return out;
    }

    unmapJson(v) {
      if (typeof v === 'string') return this.unmap(v);
      if (Array.isArray(v)) return v.map((x) => this.unmapJson(x));
      if (v && typeof v === 'object') {
        const o = {};
        Object.keys(v).forEach((k) => { o[k] = this.unmapJson(v[k]); });
        return o;
      }
      return v;
    }

    async lookup(name) {
      const r = this.opts.resolve;
      if (typeof r !== 'function' || name === null || name === undefined) return null;
      let v = await r(name);
      if (!v && /\.[A-Za-z0-9]{2,8}$/.test(name) && !/[\\/]/.test(name)) {
        const alt = await r(name.replace(/\.[^.]+$/, ''));
        if (alt && alt.kind !== 'file') v = alt;
      }
      return v && typeof v === 'object' && v.kind ? v : null;
    }

    async availableNames() {
      let names = this.opts.names;
      if (typeof names === 'function') { try { names = await names(); } catch (e) { names = null; } }
      if (!Array.isArray(names) && this.opts.resolve && Array.isArray(this.opts.resolve.names)) names = this.opts.resolve.names;
      return Array.isArray(names) ? names : null;
    }

    async notFound(name) {
      const names = await this.availableNames();
      let msg = 'No layer or file named "' + name + '".';
      if (names) msg += names.length ? ' Available: ' + names.join(', ') : ' No layers are loaded.';
      return new Error(msg);
    }

    uniqueSlug(name) {
      let s = slugOf(name);
      if (this.slugs.has(s)) { let i = 2; while (this.slugs.has(s + '_' + i)) i++; s = s + '_' + i; }
      this.slugs.add(s);
      return s;
    }

    /**
     * Write an input where GDAL can read it; returns { kind, name, path, layer, src }.
     * `want` ('vector' | 'raster') picks the right dataset inside zip files.
     */
    async materialise(input, want) {
      const key = input.kind + '\u0000' + input.name + (input.kind === 'file' ? '\u0000' + (want || '') : '');
      if (this.inputs.has(key)) return this.inputs.get(key);
      const dir = this.inDir + '/' + (++this.k);
      let m;
      if (input.kind === 'vector') {
        const slug = this.uniqueSlug(input.name);
        const path = dir + '/' + slug + '.geojson';
        await this.call('write', { files: [{ path: path, bytes: encodeFeatureCollection(input.fc, slug), transfer: true }] });
        m = { kind: 'vector', name: input.name, layer: slug, path: path, file: slug + '.geojson' };
        this.names.push([path, input.name]);
        if (slug !== input.name && this.result.program) {
          this.log('Layer "' + input.name + '" is called ' + slug + ' inside GDAL (use that name in -sql).');
        }
      } else if (input.kind === 'raster') {
        const slug = this.uniqueSlug(input.name);
        const srs = srsForGdal(input.raster && input.raster.crs);
        let srsOk = srs;
        if (srs) {
          const v = await this.call('srs', { input: srs });
          if (!v.ok) { this.log('Warning: GDAL does not understand the CRS of "' + input.name + '" (' + input.raster.crs + '); it is treated as unreferenced.'); srsOk = null; }
        }
        const vrt = rasterToVrt(input.raster, dir, slug, srsOk);
        await this.call('write', { files: vrt.files });
        m = { kind: 'raster', name: input.name, layer: slug, path: vrt.path, file: slug + '.vrt' };
        this.names.push([vrt.path, input.name]);
      } else if (input.kind === 'file') {
        const fname = safeFileName(input.name, 'data');
        const path = dir + '/' + fname;
        const files = [{ path: path, bytes: await asBytes(input.bytes) }];
        for (const f of input.files || []) files.push({ path: dir + '/' + safeRelPath(f.name, 'part'), bytes: await asBytes(f.bytes) });
        await this.call('write', { files: files });
        const paths = await containerPaths(path, fname, files[0].bytes, want || null);
        m = { kind: 'file', name: input.name, path: paths[0], file: fname };
        this.names.push(['/vsizip/' + path, input.name]);
        this.names.push([path, input.name]);
      } else {
        throw new Error('Unsupported input kind "' + input.kind + '" for "' + input.name + '"');
      }
      m.src = { path: m.path };
      m.input = input;
      this.inputs.set(key, m);
      return m;
    }

    /** Resolve and materialise a dataset argument; `want` = 'vector' | 'raster'. */
    async source(name, want, program) {
      const input = await this.lookup(name);
      if (!input) throw await this.notFound(name);
      if (input.kind !== 'file' && input.kind !== want) {
        const alt = want === 'vector' ? 'gdal_translate / gdalwarp / gdalinfo' : 'ogr2ogr / ogrinfo / gdal_rasterize';
        throw new Error('"' + name + '" is a ' + input.kind + ' layer, but ' + program + ' needs ' + want + ' data (try ' + alt + ').');
      }
      return this.materialise(input, want);
    }

    /** Apply -oo / -if to file sources. */
    withOpenOptions(m, P) {
      const oo = optValues(P, '-oo');
      const drv = optValues(P, '-if');
      if (!oo.length && !drv.length) return m.src;
      return { path: m.src.path, openOptions: oo, drivers: drv };
    }

    /** Replace layer names used as datasource-valued options (-cutline, -clipsrc, -clipdst) by their paths. */
    async substituteDatasources(args, optionNames) {
      const out = args.slice();
      for (let i = 0; i < out.length; i++) {
        const k = String(out[i]).toLowerCase();
        if (optionNames.indexOf(k) < 0) continue;
        const v = out[i + 1];
        if (v === undefined || isNumTok(v) || /^spat_extent$/i.test(v) || /^\s*(MULTI)?(POLYGON|LINESTRING|POINT)\b/i.test(v)) continue;
        const input = await this.lookup(v);
        if (!input) continue;
        if (input.kind === 'raster') throw new Error(out[i] + ' needs vector data, but "' + v + '" is a raster layer.');
        const m = await this.materialise(input);
        out[i + 1] = m.path;
        // -cl / -clipsrclayer / -clipdstlayer may use the display name
        const layerOpt = { '-cutline': '-cl', '-clipsrc': '-clipsrclayer', '-clipdst': '-clipdstlayer' }[k];
        for (let j = 0; j < out.length; j++) {
          if (String(out[j]).toLowerCase() === layerOpt && out[j + 1] === input.name && m.layer) out[j + 1] = m.layer;
        }
      }
      return out;
    }

    /**
     * -sql support: "Display Name" identifiers are rewritten to the GDAL layer
     * name, and other map layers referenced in the statement are exposed in
     * the same (OGR VRT) datasource so joins work.
     */
    async prepareSql(args, src) {
      const idx = args.findIndex(function (a) { return String(a).toLowerCase() === '-sql'; });
      if (idx < 0 || typeof args[idx + 1] !== 'string' || args[idx + 1][0] === '@') return src;
      const sql = args[idx + 1];
      const toks = sqlIdentifiers(sql);
      const extra = [];
      const edits = [];
      const seen = new Map();
      // Rewrite a reference to a layer's display name when it differs from its GDAL name
      // (SQL identifiers are case-insensitive, so case-only differences are left alone).
      const rename = function (t, layer) {
        if (t.text !== layer && (t.quoted || t.text.toLowerCase() !== layer.toLowerCase())) edits.push([t.start, t.end, layer]);
      };
      for (const t of toks) {
        if (!t.quoted && SQL_WORDS.has(t.text.toUpperCase())) continue;
        if (src.kind === 'vector' && (t.text === src.layer || t.text === src.name)) {
          rename(t, src.layer);
          continue;
        }
        let m = seen.get(t.text);
        if (m === undefined) {
          const input = await this.lookup(t.text);
          m = input && input.kind === 'vector' ? await this.materialise(input) : null;
          seen.set(t.text, m);
          if (m && extra.indexOf(m) < 0 && m !== src) extra.push(m);
        }
        if (m) rename(t, m.layer);
      }
      if (edits.length) {
        let s = sql;
        edits.sort(function (a, b) { return b[0] - a[0]; }).forEach(function (e) { s = s.slice(0, e[0]) + e[2] + s.slice(e[1]); });
        args[idx + 1] = s;
      }
      if (!extra.length || src.kind !== 'vector') return src;
      const layers = [src].concat(extra);
      const xml = '<OGRVRTDataSource>' + layers.map(function (l) {
        return '<OGRVRTLayer name="' + xmlEscape(l.layer) + '"><SrcDataSource>' + xmlEscape(l.path) +
          '</SrcDataSource><SrcLayer>' + xmlEscape(l.layer) + '</SrcLayer></OGRVRTLayer>';
      }).join('') + '</OGRVRTDataSource>';
      const path = this.inDir + '/' + (++this.k) + '/' + src.layer + '_sql.vrt';
      await this.call('write', { files: [{ path: path, bytes: textBytes(xml), transfer: true }] });
      this.names.push([path, src.name]);
      this.log('SQL can use layers: ' + layers.map(function (l) { return l.layer; }).join(', '));
      return Object.assign({}, src, { path: path, src: { path: path } });
    }

    /** Decide the internal output path and driver for a user-supplied output name. */
    planOutput(userName, kind, explicitFormat) {
      if (!userName) throw new Error('Missing output name');
      const file0 = safeFileName(userName, kind === 'vector' ? 'output.geojson' : 'output.tif');
      const ext0 = extOf(file0);
      let driver = null;
      if (explicitFormat) {
        driver = canonicalDriver(explicitFormat, kind);
        if (driver && driver.toLowerCase() !== String(explicitFormat).toLowerCase()) {
          this.log('Using GDAL driver "' + driver + '" for "' + explicitFormat + '".');
        }
        if (!driver) driver = explicitFormat; // let GDAL report unknown drivers
      } else if (ext0) {
        driver = driverForExtension(ext0, kind);
        if (!driver) {
          throw new Error('GDAL cannot write ".' + ext0 + '" files here. Choose a format with ' + (kind === 'vector' ? '-f' : '-of') +
            ' (e.g. ' + (kind === 'vector' ? '-f GPKG' : '-of GTiff') + ').');
        }
      } else {
        driver = kind === 'vector' ? 'GeoJSON' : 'GTiff';
      }
      let file = file0;
      if (!ext0 && !(kind === 'vector' && DIRECTORY_DRIVERS.indexOf(driver) >= 0)) {
        const e = primaryExtension(driver, kind);
        if (e) file = file0 + '.' + e;
      }
      return { kind: kind, driver: driver, file: file, ext: extOf(file), base: stripExt(file), path: this.outDir + '/' + file, userName: userName, explicit: !!explicitFormat };
    }

    /** Collect the files GDAL wrote and turn them into outputs and/or layers following the output policy. */
    async finishOutput(out, meta, extra) {
      extra = extra || {};
      const layerDefault = out.kind === 'vector'
        ? out.driver === 'GeoJSON' && (out.ext === 'geojson' || out.ext === 'json' || !extOf(out.userName))
        : (out.ext === 'tif' || out.ext === 'tiff') && (out.driver === 'GTiff' || out.driver === 'COG');
      const defaultLayer = extra.defaultLayer !== undefined ? extra.defaultLayer : layerDefault;
      const wantLayers = meta.map || (defaultLayer && !meta.download);
      const wantFile = meta.download || !(defaultLayer && (out.kind === 'vector' || extra.noFileByDefault));
      const entries = (await this.call('list', { dir: this.outDir })).entries;
      if (!entries.some(function (e) { return !e.dir; })) throw new Error(this.result.program + ' finished but wrote no output');
      if (wantFile) {
        const packed = await this.packOutput(out, entries);
        packed.forEach((o) => this.result.outputs.push(o));
      }
      if (wantLayers) {
        if (out.kind === 'vector') {
          const layers = await this.readVectorLayers({ path: out.path });
          if (!layers.length) this.log('Warning: the output has no vector layers to load.');
          layers.forEach((l) => {
            const name = layers.length === 1 ? (meta.name || extra.nln || out.base) : (meta.name || out.base) + '_' + l.layer;
            this.result.layers.push({ kind: 'vector', name: name, fc: l.fc });
          });
        } else {
          const raster = await this.readRasterDataset({ path: out.path }, { name: meta.name || out.base, maxPixels: extra.maxPixels });
          this.result.layers.push({ kind: 'raster', name: meta.name || out.base, raster: raster });
        }
      }
    }

    /** Output files -> one { filename, bytes } (single file) or a zip of everything. */
    async packOutput(out, entries) {
      const files = entries.filter(function (e) { return !e.dir; });
      const main = files.find(function (f) { return f.path === out.path; });
      const others = files.filter(function (f) { return f !== main && !/\.aux\.xml$/i.test(f.path); });
      if (main && !others.length) {
        const r = await this.call('read', { paths: [main.path] });
        return [{ filename: out.file, bytes: r.files[0].bytes, kind: out.kind, driver: out.driver }];
      }
      const r = await this.call('read', { paths: files.map(function (f) { return f.path; }) });
      const rel = (p) => p.slice(this.outDir.length + 1);
      const Z = root.JSZip;
      if (!Z) {
        this.log('Warning: JSZip is not loaded, so the ' + files.length + ' output files are returned separately.');
        return r.files.map(function (f) { return { filename: rel(f.path), bytes: f.bytes, kind: out.kind, driver: out.driver }; });
      }
      const zip = new Z();
      r.files.forEach(function (f) { zip.file(rel(f.path), f.bytes); });
      const bytes = await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
      const isDirOut = entries.some(function (e) { return e.dir && e.path === out.path; });
      const filename = (isDirOut ? out.file : out.base) + '.zip';
      return [{ filename: filename, bytes: bytes, kind: out.kind, driver: out.driver }];
    }

    /** Every (or the chosen) layer of a vector dataset as EPSG:4326 FeatureCollections. */
    async readVectorLayers(src, only) {
      const res = await this.call('run', { program: 'ogrinfo', src: [src], args: ['-json'] });
      const info = JSON.parse(res.text);
      let layers = info.layers || [];
      if (only && only.length) {
        const want = only.map(function (n) { return String(n).toLowerCase(); });
        const missing = only.filter(function (n) { return !layers.some(function (l) { return l.name.toLowerCase() === String(n).toLowerCase(); }); });
        if (missing.length) throw new Error('No layer named ' + missing.map(function (n) { return '"' + n + '"'; }).join(', ') + '. Layers: ' + layers.map(function (l) { return l.name; }).join(', '));
        layers = layers.filter(function (l) { return want.indexOf(l.name.toLowerCase()) >= 0; });
      }
      const out = [];
      // Fast path: a single-layer GeoJSON file already in EPSG:4326 is parsed as it is.
      if (layers.length === 1 && (info.layers || []).length === 1 && info.driverShortName === 'GeoJSON' &&
          src.path.indexOf(FS_ROOT + '/') === 0 && isWGS84(layers[0])) {
        const r = await this.call('read', { paths: [src.path] });
        const gf = (layers[0].geometryFields || [])[0];
        out.push({ layer: layers[0].name, fc: parseFeatureCollection(r.files[0].bytes), geometryType: gf ? gf.type : 'None' });
        return out;
      }
      for (const l of layers) {
        const gf = (l.geometryFields || [])[0];
        const hasSrs = !!(gf && gf.coordinateSystem && (gf.coordinateSystem.wkt || gf.coordinateSystem.projjson));
        const dst = this.rbDir + '/v' + (++this.rb) + '.geojson';
        const args = ['-f', 'GeoJSON'].concat(hasSrs ? ['-t_srs', 'EPSG:4326'] : [], [l.name]);
        await this.call('run', { program: 'ogr2ogr', src: [src], dst: dst, args: args });
        const r = await this.call('read', { paths: [dst] });
        await this.call('remove', { paths: [dst] });
        const fc = parseFeatureCollection(r.files[0].bytes);
        if (!hasSrs && gf) {
          const bb = util.bbox(fc);
          if (bb && M.crs && !M.crs.looksGeographic(bb)) {
            this.log('Warning: layer "' + l.name + '" has no CRS and does not look like longitude/latitude; loaded as-is.');
          }
        }
        out.push({ layer: l.name, fc: fc, geometryType: gf ? gf.type : 'None' });
      }
      return out;
    }

    /** Read a raster dataset back into PSICITS's Raster model (downsampling above maxPixels). */
    async readRasterDataset(src, opts) {
      opts = opts || {};
      const maxPixels = opts.maxPixels > 0 ? opts.maxPixels : 16e6;
      const infoRes = await this.call('run', { program: 'gdalinfo', src: [src], args: ['-json', '-proj4', '-wkt_format', 'WKT1'] });
      const info = JSON.parse(infoRes.text);
      const bands = info.bands || [];
      if (!bands.length || !info.size) throw new Error('"' + (opts.name || 'raster') + '" has no raster bands');
      const W0 = info.size[0];
      const H0 = info.size[1];
      const gt0 = info.geoTransform;
      const gcps = info.gcps && info.gcps.gcpList && info.gcps.gcpList.length >= 3;
      const needsWarp = (gt0 && (gt0[2] !== 0 || gt0[4] !== 0 || gt0[5] > 0)) || (!gt0 && gcps);
      const types = bands.map(function (b) { return WIDEN[b.type] || b.type; });
      const allSame = types.every(function (t) { return t === types[0]; });
      const outType = allSame && ARRAY_OF[types[0]] ? types[0] : 'Float64';
      let args = ['-of', 'ENVI', '-co', 'INTERLEAVE=BSQ'];
      if (outType !== bands[0].type || !allSame) args = args.concat(['-ot', outType]);
      let factor = 1;
      if (W0 * H0 > maxPixels) {
        factor = Math.sqrt((W0 * H0) / maxPixels);
        const w = Math.max(1, Math.floor(W0 / factor));
        const h = Math.max(1, Math.floor(H0 / factor));
        args = args.concat(needsWarp ? ['-ts', String(w), String(h)] : ['-outsize', String(w), String(h)], ['-r', opts.resampling || 'nearest']);
      }
      const dst = this.rbDir + '/r' + (++this.rb) + '.dat';
      await this.call('run', { program: needsWarp ? 'gdalwarp' : 'gdal_translate', src: [src], dst: dst, args: args });
      const envi = JSON.parse((await this.call('run', { program: 'gdalinfo', src: [{ path: dst }], args: ['-json', '-nomd', '-proj4', '-wkt_format', 'WKT1'] })).text);
      const raw = (await this.call('read', { paths: [dst] })).files[0].bytes;
      await this.call('remove', { paths: [dst, dst.replace(/\.dat$/, '.hdr'), dst + '.aux.xml'] });
      const W = envi.size[0];
      const H = envi.size[1];
      const T = ARRAY_OF[outType];
      const n = W * H;
      const bpp = T.BYTES_PER_ELEMENT;
      const aligned = raw.byteOffset % bpp === 0;
      const outBands = bands.map(function (b, i) {
        const off = raw.byteOffset + i * n * bpp;
        return aligned ? new T(raw.buffer, off, n) : new T(raw.buffer.slice(off, off + n * bpp));
      });
      const georef = !!(envi.geoTransform || gt0);
      let transform = envi.geoTransform ? envi.geoTransform.map(function (v) { return v === 0 ? 0 : v; }) : null; // no -0
      if (!transform) transform = [0, 1, 0, H, 0, -1]; // unreferenced: pixel space, north-up
      const bbox = [transform[0], transform[3] + H * transform[5], transform[0] + W * transform[1], transform[3]];
      const meta = { source: opts.name || null, driver: info.driverShortName || null, georeferenced: georef };
      if (factor > 1) { meta.downsample = W0 / W; meta.originalSize = [W0, H0]; }
      if (needsWarp) meta.warpedToNorthUp = true;
      const colorTables = bands.map(function (b) { return b.colorTable ? b.colorTable.entries : null; });
      if (colorTables.some(Boolean)) meta.colorTables = colorTables;
      return {
        width: W,
        height: H,
        bands: outBands,
        bandNames: bands.map(function (b, i) { return b.description || 'b' + (i + 1); }),
        noData: parseNoData(bands[0].noDataValue),
        // GCP-only sources carry their CRS on the GCPs; the warped copy has it as a regular CRS.
        crs: georef ? crsFromInfo(info.coordinateSystem ? info : envi) : null,
        transform: transform,
        bbox: bbox,
        dataType: MODEL_TYPE[outType],
        stats: null,
        meta: meta,
      };
    }

    async cleanup() {
      try { await this.rt.backend.call('remove', { paths: [this.root] }); } catch (e) { /* ignore */ }
    }
  }

  function toBytes(b) {
    if (b instanceof Uint8Array) return b;
    if (b instanceof ArrayBuffer) return new Uint8Array(b);
    if (ArrayBuffer.isView(b)) return new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
    if (typeof b === 'string') return textBytes(b);
    throw new Error('File contents must be bytes (Uint8Array, ArrayBuffer or Blob)');
  }

  async function asBytes(b) {
    if (b && typeof b.arrayBuffer === 'function' && !ArrayBuffer.isView(b)) return new Uint8Array(await b.arrayBuffer());
    return toBytes(b);
  }

  /** Sanitise a relative path ("data/roads.shp"), keeping its folders. */
  function safeRelPath(name, fallback) {
    const parts = String(name || '').split(/[\\/]+/).filter(function (p) { return p && p !== '.' && p !== '..'; });
    const clean = parts.map(function (p) { return safeFileName(p, fallback); });
    return clean.length ? clean.join('/') : (fallback || 'data');
  }

  /** Is an ogrinfo -json layer in WGS 84 lon/lat (EPSG:4326 / OGC:CRS84)? */
  function isWGS84(layer) {
    const gf = (layer.geometryFields || [])[0];
    const pj = gf && gf.coordinateSystem && gf.coordinateSystem.projjson;
    const id = pj && pj.id;
    return !!id && ((id.authority === 'EPSG' && +id.code === 4326) || (id.authority === 'OGC' && id.code === 'CRS84'));
  }

  function parseFeatureCollection(bytes) {
    const gj = JSON.parse(bytesText(bytes));
    const feats = (gj && gj.features) || [];
    return {
      type: 'FeatureCollection',
      features: feats.map(function (f) {
        return { type: 'Feature', properties: f.properties && typeof f.properties === 'object' ? f.properties : {}, geometry: f.geometry || null };
      }),
    };
  }

  /* -------------------------------------------------------- program runs */

  function usage(program, extra) {
    const e = new Error((extra ? extra + '\n' : '') + 'Usage: ' + USAGE[program] + '\nType "' + program + ' --help" for examples.');
    e.usage = true;
    return e;
  }

  const RUNNERS = {
    async ogr2ogr(job, P) {
      const pos = P.positionals;
      if (pos.length < 2) throw usage('ogr2ogr', 'ogr2ogr needs an output name and an input layer.');
      const dstName = pos[0];
      const srcName = pos[1];
      let src = await job.source(srcName, 'vector', 'ogr2ogr');
      let args = libArgs(P, ['-f', '-of']);
      args = await job.substituteDatasources(args, ['-clipsrc', '-clipdst']);
      src = await job.prepareSql(args, src);
      const layers = pos.slice(2).map(function (l) { return src.kind === 'vector' && l === src.name ? src.layer : l; });
      const out = job.planOutput(dstName, 'vector', optValue(P, '-f') || optValue(P, '-of'));
      if (out.driver === 'ESRI Shapefile' && !optValues(P, '-lco').some(function (v) { return /^ENCODING=/i.test(v); })) {
        // GDAL 3.8 writes new shapefiles as ISO-8859-1, which mangles most non-Latin text.
        args.push('-lco', 'ENCODING=UTF-8');
        job.log('Note: writing the shapefile as UTF-8 (-lco ENCODING=UTF-8).');
      }
      if (['-update', '-append', '-overwrite', '-upsert'].some(function (o) { return hasOpt(P, o); })) {
        const existing = await job.lookup(dstName);
        // Update / append into an existing loaded file or layer: start from a copy of it.
        if (existing && existing.kind === 'file') {
          await job.call('write', { files: [{ path: out.path, bytes: await asBytes(existing.bytes) }] });
        } else if (existing && existing.kind === 'vector') {
          await job.call('write', { files: [{ path: out.path, bytes: encodeFeatureCollection(existing.fc, out.base), transfer: true }] });
        }
      }
      await job.call('run', {
        program: 'ogr2ogr', src: [job.withOpenOptions(src, P)], dst: out.path,
        args: ['-f', out.driver].concat(args, layers), config: configOf(P),
      });
      await job.finishOutput(out, P.meta, { nln: optValue(P, '-nln') });
    },

    async ogrinfo(job, P) {
      const pos = P.positionals;
      if (pos.length < 1) throw usage('ogrinfo', 'ogrinfo needs an input layer or file.');
      let src = await job.source(pos[0], 'vector', 'ogrinfo');
      let args = libArgs(P);
      src = await job.prepareSql(args, src);
      const layers = pos.slice(1).map(function (l) { return src.kind === 'vector' && l === src.name ? src.layer : l; });
      const has = function (o) { return args.some(function (a) { return String(a).toLowerCase() === o; }); };
      if (!layers.length && !has('-al') && !has('-sql')) {
        args.push('-al');
        if (!['-where', '-fid', '-spat', '-features', '-q', '-json'].some(has)) args.push('-so');
      }
      const srcSpec = job.withOpenOptions(src, P);
      const res = await job.call('run', { program: 'ogrinfo', src: [srcSpec], args: args.concat([src.path], layers), config: configOf(P) });
      if (has('-json')) {
        job.result.json = job.unmapJson(JSON.parse(res.text));
        job.result.text = JSON.stringify(job.result.json, null, 2);
      } else {
        job.result.text = job.unmap(res.text).replace(/\s+$/, '');
        const jsonArgs = ['-json'].concat(args.filter(function (a) { return ['-so', '-summary', '-al', '-q', '-rl'].indexOf(String(a).toLowerCase()) < 0 && !/^-(geom|fields)=/i.test(a); }));
        try {
          const jr = await job.call('run', { program: 'ogrinfo', src: [srcSpec], args: jsonArgs.concat([src.path], layers), config: configOf(P) });
          job.result.json = job.unmapJson(JSON.parse(jr.text));
        } catch (e) { /* text report is enough */ }
      }
    },

    async gdalinfo(job, P) {
      if (P.positionals.length !== 1) throw usage('gdalinfo', 'gdalinfo needs exactly one raster.');
      const src = await job.source(P.positionals[0], 'raster', 'gdalinfo');
      const args = libArgs(P, ['-q', '-quiet']); // the gdalinfo library rejects -q
      const srcSpec = job.withOpenOptions(src, P);
      const res = await job.call('run', { program: 'gdalinfo', src: [srcSpec], args: args, config: configOf(P) });
      if (args.indexOf('-json') >= 0) {
        job.result.json = job.unmapJson(JSON.parse(res.text));
        job.result.text = JSON.stringify(job.result.json, null, 2);
      } else {
        job.result.text = job.unmap(res.text).replace(/\s+$/, '');
        const jr = await job.call('run', { program: 'gdalinfo', src: [srcSpec], args: ['-json'].concat(args), config: configOf(P) });
        job.result.json = job.unmapJson(JSON.parse(jr.text));
      }
    },

    async gdal_translate(job, P) {
      if (P.positionals.length !== 2) throw usage('gdal_translate', 'gdal_translate needs an input raster and an output name.');
      const src = await job.source(P.positionals[0], 'raster', 'gdal_translate');
      const out = job.planOutput(P.positionals[1], 'raster', optValue(P, '-of'));
      await job.call('run', {
        program: 'gdal_translate', src: [job.withOpenOptions(src, P)], dst: out.path,
        args: ['-of', out.driver].concat(libArgs(P, ['-of'])), config: configOf(P),
      });
      await job.finishOutput(out, P.meta);
    },

    async gdalwarp(job, P) {
      const pos = P.positionals;
      if (pos.length < 2) throw usage('gdalwarp', 'gdalwarp needs at least one input raster and an output name.');
      const srcs = [];
      for (const n of pos.slice(0, -1)) srcs.push(job.withOpenOptions(await job.source(n, 'raster', 'gdalwarp'), P));
      let args = libArgs(P, ['-of', '-overwrite', '-multi']);
      if (hasOpt(P, '-multi')) job.log('Note: -multi is ignored (this GDAL build has no threads).');
      args = await job.substituteDatasources(args, ['-cutline']);
      const out = job.planOutput(pos[pos.length - 1], 'raster', optValue(P, '-of'));
      await job.call('run', { program: 'gdalwarp', src: srcs, dst: out.path, args: ['-of', out.driver].concat(args), config: configOf(P) });
      await job.finishOutput(out, P.meta);
    },

    async gdal_rasterize(job, P) {
      const pos = P.positionals;
      if (pos.length !== 2) throw usage('gdal_rasterize', 'gdal_rasterize needs a vector input and an output name.');
      let src = await job.source(pos[0], 'vector', 'gdal_rasterize');
      let args = libArgs(P, ['-of']);
      const layerSrc = src;
      src = await job.prepareSql(args, src);
      for (let i = 0; i < args.length; i++) {
        if (String(args[i]).toLowerCase() === '-l' && args[i + 1] === src.name && src.layer) args[i + 1] = src.layer;
      }
      // GDAL's -a_srs only labels the output and never reprojects features. PSICITS layers are always
      // lon/lat, so "-a_srs EPSG:26916 -tr 30 30" would be meaningless: reproject the layer first.
      const aSrs = optValue(P, '-a_srs');
      if (aSrs && src.kind === 'vector' && src === layerSrc && M.crs && M.crs.normalize(aSrs) !== 'EPSG:4326') {
        const dst = job.rbDir + '/' + src.layer + '_' + (++job.rb) + '.geojson';
        await job.call('run', { program: 'ogr2ogr', src: [src.src], dst: dst, args: ['-f', 'GeoJSON', '-t_srs', srsForGdal(aSrs), '-nln', src.layer] });
        src = Object.assign({}, src, { path: dst, src: { path: dst } });
        job.names.push([dst, src.name]);
        job.log('Note: "' + src.name + '" was reprojected from EPSG:4326 to ' + aSrs + ' for -a_srs (PSICITS layers are stored in lon/lat).');
      }
      const creating = ['-of', '-a_nodata', '-init', '-te', '-tr', '-tap', '-ts', '-ot', '-co', '-a_srs'].some(function (o) { return hasOpt(P, o); });
      const existing = creating ? null : await job.lookup(pos[1]);
      let out;
      if (existing && existing.kind === 'raster') {
        // Burn into a copy of an existing raster layer.
        const m = await job.materialise(existing);
        out = job.planOutput(stripExt(pos[1]) + '.tif', 'raster', 'GTiff');
        await job.call('run', { program: 'gdal_translate', src: [m.src], dst: out.path, args: ['-of', 'GTiff'] });
        await job.call('run', { program: 'gdal_rasterize', src: [job.withOpenOptions(src, P)], dst: out.path, update: true, args: args, config: configOf(P) });
      } else {
        out = job.planOutput(pos[1], 'raster', optValue(P, '-of'));
        try {
          await job.call('run', { program: 'gdal_rasterize', src: [job.withOpenOptions(src, P)], dst: out.path, args: ['-of', out.driver].concat(args), config: configOf(P) });
        } catch (e) {
          if (/size and resolutions are missing|'-tr xres yres' or '-ts xsize ysize' is required/i.test(e.message)) {
            e.message += '. Add -tr <xres> <yres> or -ts <width> <height> (or name an existing raster layer as the output to burn into it).';
          }
          throw e;
        }
      }
      await job.finishOutput(out, P.meta);
    },

    async gdaldem(job, P) {
      const pos = P.positionals;
      const modes = ['hillshade', 'slope', 'aspect', 'color-relief', 'tri', 'tpi', 'roughness'];
      const mode = pos[0] && pos[0].toLowerCase();
      if (!mode || modes.indexOf(mode) < 0) throw usage('gdaldem', 'gdaldem needs a mode: ' + modes.join(', ') + '.');
      const relief = mode === 'color-relief';
      if (pos.length !== (relief ? 4 : 3)) throw usage('gdaldem');
      const src = await job.source(pos[1], 'raster', 'gdaldem');
      let colorFile = null;
      if (relief) {
        const c = await job.lookup(pos[2]);
        if (!c) throw await job.notFound(pos[2]);
        if (c.kind !== 'file') throw new Error('The color table "' + pos[2] + '" must be a loaded text file (value R G B lines).');
        colorFile = (await job.materialise(c)).path;
      }
      const out = job.planOutput(pos[relief ? 3 : 2], 'raster', optValue(P, '-of'));
      await job.call('run', {
        program: 'gdaldem', mode: mode === 'tri' ? 'TRI' : mode === 'tpi' ? 'TPI' : mode, colorFile: colorFile,
        src: [job.withOpenOptions(src, P)], dst: out.path, args: ['-of', out.driver].concat(libArgs(P, ['-of'])), config: configOf(P),
      });
      await job.finishOutput(out, P.meta);
    },

    async gdalbuildvrt(job, P) {
      const pos = P.positionals;
      if (pos.length < 2) throw usage('gdalbuildvrt', 'gdalbuildvrt needs an output name and at least one input raster.');
      const srcs = [];
      for (const n of pos.slice(1)) srcs.push(job.withOpenOptions(await job.source(n, 'raster', 'gdalbuildvrt'), P));
      const out = job.planOutput(/\.vrt$/i.test(pos[0]) ? pos[0] : stripExt(pos[0]) + '.vrt', 'raster', 'VRT');
      await job.call('run', { program: 'gdalbuildvrt', src: srcs, dst: out.path, args: libArgs(P, ['-overwrite']), config: configOf(P) });
      // The .vrt only points at this command's temporary inputs: load it as a layer by default.
      if (P.meta.download) job.log('Warning: the .vrt refers to files that exist only while the command runs; use gdal_translate to make a standalone raster.');
      await job.finishOutput(out, P.meta, { defaultLayer: true, noFileByDefault: true });
    },

    async gdal_location_info(job, P) {
      const pos = P.positionals;
      if (pos.length < 3) throw usage('gdal_location_info', 'gdal_location_info needs a raster and x y coordinates.');
      const input = await job.lookup(pos[0]);
      if (!input) throw await job.notFound(pos[0]);
      const src = await job.source(pos[0], 'raster', 'gdal_location_info');
      const coords = parseCoordinates(pos.slice(1), 'gdal_location_info');
      const srcSpec = job.withOpenOptions(src, P);
      const info = JSON.parse((await job.call('run', { program: 'gdalinfo', src: [srcSpec], args: ['-json'] })).text);
      const W = info.size[0];
      const H = info.size[1];
      const gt = info.geoTransform || [0, 1, 0, 0, 0, 1];
      const lsrs = optValue(P, '-l_srs') || (hasOpt(P, '-wgs84') ? 'EPSG:4326' : null);
      let pts = coords.map(function (c) { return [c[0], c[1]]; });
      if (lsrs) {
        const wkt = info.coordinateSystem && info.coordinateSystem.wkt;
        if (!wkt) throw new Error('"' + pos[0] + '" has no coordinate system, so -wgs84 / -l_srs cannot be used; give pixel/line or -geoloc coordinates.');
        const tr = await job.call('transform', { coords: pts, options: ['SRC_SRS=' + srsForGdal(lsrs), 'DST_SRS=' + wkt] });
        pts = tr.coords.map(function (c) { return [c[0], c[1]]; });
      }
      const georef = !!lsrs || hasOpt(P, '-geoloc');
      const inv = invertGeoTransform(gt);
      const bandsWanted = optValues(P, '-b').map(Number);
      const bandIdx = bandsWanted.length ? bandsWanted : info.bands.map(function (b, i) { return i + 1; });
      const valonly = hasOpt(P, '-valonly');
      const lines = [];
      const report = [];
      for (let i = 0; i < pts.length; i++) {
        const p = georef ? applyGeoTransform(inv, pts[i][0], pts[i][1]) : pts[i];
        const px = Math.floor(p[0]);
        const ln = Math.floor(p[1]);
        const rec = { x: coords[i][0], y: coords[i][1], pixel: px, line: ln, values: null };
        report.push(rec);
        if (px < 0 || ln < 0 || px >= W || ln >= H) {
          if (!valonly) lines.push('Location is off this file! No further details to report.');
          else lines.push('');
          continue;
        }
        let values;
        if (input.kind === 'raster') {
          values = bandIdx.map(function (b) { const band = input.raster.bands[b - 1]; return band ? Number(band[ln * W + px]) : null; });
        } else {
          const dst = job.rbDir + '/px' + (++job.rb) + '.dat';
          const bargs = [];
          bandIdx.forEach(function (b) { bargs.push('-b', String(b)); });
          await job.call('run', { program: 'gdal_translate', src: [srcSpec], dst: dst, args: ['-of', 'ENVI', '-ot', 'Float64', '-srcwin', String(px), String(ln), '1', '1'].concat(bargs) });
          const raw = (await job.call('read', { paths: [dst] })).files[0].bytes;
          const f = new Float64Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength));
          values = Array.from(f);
        }
        rec.values = values;
        if (valonly) {
          values.forEach(function (v) { lines.push(String(v)); });
        } else {
          lines.push('Report:', '  Location: (' + px + 'P,' + ln + 'L)');
          values.forEach(function (v, k) { lines.push('  Band ' + bandIdx[k] + ':', '    Value: ' + v); });
        }
      }
      job.result.text = lines.join('\n');
      job.result.json = report;
    },

    async gdaltransform(job, P) {
      if (hasOpt(P, '-gcp')) throw new Error('gdaltransform -gcp is not supported here.');
      const coords = parseCoordinates(P.positionals, 'gdaltransform');
      const map = { '-s_srs': 'SRC_SRS', '-t_srs': 'DST_SRS', '-ct': 'COORDINATE_OPERATION', '-order': 'MAX_GCP_ORDER', '-s_coord_epoch': 'SRC_COORDINATE_EPOCH', '-t_coord_epoch': 'DST_COORDINATE_EPOCH' };
      const options = [];
      P.options.forEach(function (o) {
        if (map[o.key]) options.push(map[o.key] + '=' + (o.key.slice(-4) === '_srs' ? srsForGdal(o.values[0]) : o.values[0]));
        else if (o.key === '-to') options.push(o.values[0]);
        else if (o.key === '-tps') options.push('METHOD=GCP_TPS');
        else if (o.key === '-rpc') options.push('METHOD=RPC');
        else if (o.key === '-geoloc') options.push('METHOD=GEOLOC_ARRAY');
      });
      if (!hasOpt(P, '-s_srs') && !hasOpt(P, '-t_srs')) throw usage('gdaltransform', 'gdaltransform needs -s_srs and/or -t_srs.');
      const r = await job.call('transform', { coords: coords, options: options, inverse: hasOpt(P, '-i') });
      const xy = hasOpt(P, '-output_xy');
      const outCoords = r.coords.map(function (c) { return xy ? [c[0], c[1]] : c; });
      job.result.json = outCoords;
      job.result.text = outCoords.map(function (c, i) {
        return r.success[i] ? c.map(function (v) { return String(+v.toPrecision(15)); }).join(' ') : 'transformation failed';
      }).join('\n');
    },
  };

  function parseCoordinates(tokens, program) {
    const nums = [];
    const tuples = [];
    tokens.forEach(function (t) {
      const parts = String(t).split(/[\s,;]+/).filter(Boolean);
      if (parts.length > 1) {
        if (!parts.every(isNumTok)) throw new Error('Not a coordinate: "' + t + '"');
        tuples.push(parts.map(Number));
      } else if (isNumTok(parts[0])) {
        nums.push(Number(parts[0]));
      } else {
        throw new Error(program + ': expected numbers, got "' + t + '"');
      }
    });
    if (nums.length % 2) throw new Error(program + ': coordinates must come in x y pairs');
    for (let i = 0; i < nums.length; i += 2) tuples.push([nums[i], nums[i + 1]]);
    if (!tuples.length) throw usage(program, program + ' needs coordinates.');
    return tuples;
  }

  function invertGeoTransform(g) {
    const det = g[1] * g[5] - g[2] * g[4];
    if (!det) throw new Error('The raster geotransform cannot be inverted');
    const i1 = g[5] / det;
    const i2 = -g[2] / det;
    const i4 = -g[4] / det;
    const i5 = g[1] / det;
    return [-g[0] * i1 - g[3] * i2, i1, i2, -g[0] * i4 - g[3] * i5, i4, i5];
  }
  function applyGeoTransform(g, x, y) { return [g[0] + g[1] * x + g[2] * y, g[3] + g[4] * x + g[5] * y]; }

  function summarise(result) {
    const lines = [];
    result.outputs.forEach(function (o) {
      lines.push('Wrote ' + o.filename + ' (' + (util.formatBytes ? util.formatBytes(o.bytes.length) : o.bytes.length + ' B') + ', ' + o.driver + ')');
    });
    result.layers.forEach(function (l) {
      if (l.kind === 'vector') lines.push('Layer "' + l.name + '": ' + fmt(l.fc.features.length) + ' feature' + (l.fc.features.length === 1 ? '' : 's'));
      else lines.push('Raster "' + l.name + '": ' + l.raster.width + ' x ' + l.raster.height + ', ' + l.raster.bands.length + ' band' + (l.raster.bands.length === 1 ? '' : 's') + ', ' + (l.raster.crs || 'no CRS'));
    });
    return lines.join('\n');
  }

  function driversText(kind) {
    const rows = [];
    ['vector', 'raster'].forEach(function (k) {
      if (kind && kind !== k) return;
      rows.push((k === 'vector' ? 'Vector' : 'Raster') + ' formats (r = read, w = write):');
      driverList(k).slice().sort(function (a, b) { return a.name.localeCompare(b.name); }).forEach(function (d) {
        rows.push('  ' + d.name + ' (' + (d.canRead ? 'r' : '') + (d.canWrite ? 'w' : '') + '): ' + d.longName +
          (d.extensions.length ? ' [.' + d.extensions.join(', .') + ']' : ''));
      });
    });
    return rows.join('\n');
  }

  function decorateError(job, P, e) {
    let msg = job.unmap(e.message || String(e));
    const vectors = [];
    job.inputs.forEach(function (m) { if (m.kind === 'vector') vectors.push(m); });
    if (/Unknown option name/i.test(msg)) msg += '\nType "' + P.program + ' --help" for usage and examples.';
    if (/(no such table|Couldn't fetch requested layer|layer .*not found|Unable to find layer)/i.test(msg) && vectors.length) {
      msg += '\nLayer names inside GDAL: ' + vectors.map(function (m) { return m.layer + (m.layer !== m.name ? ' (= "' + m.name + '")' : ''); }).join(', ');
    }
    if (/(Unrecognized field name|no such column|Unknown field|field .*not found)/i.test(msg)) {
      vectors.forEach(function (m) {
        const fields = util.inferFields(m.input.fc, 500).map(function (f) { return f.name; });
        msg += '\nFields of ' + m.layer + ': ' + (fields.length ? fields.slice(0, 40).join(', ') + (fields.length > 40 ? ', …' : '') : '(none)') +
          ' (geometry column: geometry)';
      });
    }
    if (/not recognized as (a )?supported file format/i.test(msg)) {
      const want = /^ogr|gdal_rasterize/.test(P.program) ? 'vector' : 'raster';
      msg += '\n' + P.program + ' needs ' + want + ' data' + (want === 'vector' ? ' (for rasters use gdalinfo / gdal_translate)' : ' (for vector data use ogrinfo / ogr2ogr)') + '.';
    }
    const err = new Error(msg);
    if (e.usage) err.usage = true;
    if (e.fatal) err.fatal = true;
    err.logs = job.result.logs.slice();
    return err;
  }

  /* ---------------------------------------------------------------- help */

  const USAGE = {
    ogr2ogr: 'ogr2ogr [options] <output> <input layer or file> [source layer…]',
    ogrinfo: 'ogrinfo [options] <input layer or file> [layer…]',
    gdal_translate: 'gdal_translate [options] <input raster> <output>',
    gdalwarp: 'gdalwarp [options] <input raster>… <output>',
    gdal_rasterize: 'gdal_rasterize [options] <input vector layer> <output>',
    gdalinfo: 'gdalinfo [options] <input raster>',
    gdal_location_info: 'gdal_location_info [-wgs84 | -geoloc | -l_srs <crs>] [-b <band>] [-valonly] <raster> <x> <y> [<x> <y>…]',
    gdaltransform: 'gdaltransform -s_srs <crs> -t_srs <crs> [-output_xy] <x> <y> [<x> <y>…]',
    gdaldem: 'gdaldem <hillshade|slope|aspect|color-relief|TRI|TPI|roughness> [options] <dem> [<color file>] <output>',
    gdalbuildvrt: 'gdalbuildvrt [options] <output.vrt> <input raster>…',
  };

  const HELP = {
    ogr2ogr: ['Convert, filter, reproject and transform vector data. Common options: -f <format>, -t_srs <crs>, -s_srs <crs>, ' +
      '-where <expression>, -select <fields>, -sql <query> [-dialect SQLite], -nln <layer name>, -nlt <geometry type>, ' +
      '-clipsrc <layer | xmin ymin xmax ymax>, -simplify <tolerance>, -segmentize <distance>, -explodecollections, ' +
      '-makevalid, -lco NAME=VALUE, -dsco NAME=VALUE. With -dialect SQLite the SpatiaLite functions are available ' +
      '(ST_Buffer, ST_Intersection, ST_Union, ST_Area, ST_Transform, ST_Centroid, …); -sql may reference other layers by name.',
    ['ogr2ogr -f GPKG roads.gpkg roads',
      'ogr2ogr -where "lanes >= 4" highways roads',
      'ogr2ogr -dialect SQLite -sql "SELECT ST_Buffer(geometry, 0.001) AS geometry, * FROM roads" roads_buf roads',
      'ogr2ogr -t_srs EPSG:3435 -f "ESRI Shapefile" roads_il.shp roads']],
    ogrinfo: ['Describe vector data: layers, geometry type, feature count, extent, CRS and fields. With only a layer name it ' +
      'prints a summary (like -al -so); -where, -fid or -sql print matching features; -json returns JSON.',
    ['ogrinfo roads',
      'ogrinfo -sql "SELECT highway, COUNT(*) AS n FROM roads GROUP BY highway" roads',
      'ogrinfo -where "name LIKE \'Main%\'" -geom=NO roads']],
    gdal_translate: ['Convert rasters between formats and subset, resample or rescale them. Options: -of <format>, ' +
      '-ot <type>, -b <band>, -outsize <width> <height>, -tr <xres> <yres>, -r <method>, -projwin <ulx> <uly> <lrx> <lry>, ' +
      '-srcwin <x> <y> <w> <h>, -scale [<min> <max> [<dstmin> <dstmax>]], -a_srs <crs>, -a_nodata <value>, -co NAME=VALUE.',
    ['gdal_translate -of PNG -ot Byte -scale dem dem.png',
      'gdal_translate -projwin -88 42.1 -87.5 41.6 dem dem_clip.tif',
      'gdal_translate -of COG -co COMPRESS=DEFLATE dem dem_cog.tif']],
    gdalwarp: ['Reproject, resample, mosaic and clip rasters. Options: -t_srs <crs>, -s_srs <crs>, -tr <xres> <yres>, ' +
      '-ts <width> <height>, -te <xmin> <ymin> <xmax> <ymax>, -r near|bilinear|cubic|average|mode|…, -cutline <layer> ' +
      '[-crop_to_cutline], -srcnodata / -dstnodata <value>, -of <format>. Several inputs are mosaicked.',
    ['gdalwarp -t_srs EPSG:3857 -r bilinear dem dem_3857.tif',
      'gdalwarp -cutline city -crop_to_cutline dem dem_city.tif',
      'gdalwarp tile_a tile_b mosaic.tif']],
    gdal_rasterize: ['Burn vector geometries into a raster. Options: -a <field> or -burn <value>, -tr <xres> <yres> or ' +
      '-ts <width> <height>, -te <xmin> <ymin> <xmax> <ymax>, -a_nodata <value>, -init <value>, -ot <type>, -at (all touched), ' +
      '-where, -sql. If the output is an existing raster layer and no size options are given, the vectors are burnt into a copy of it.',
    ['gdal_rasterize -a population -tr 0.01 0.01 counties pop.tif',
      'gdal_rasterize -burn 1 -ts 1000 1000 -ot Byte parks parks_mask.tif',
      'gdal_rasterize -burn 0 lakes dem']],
    gdalinfo: ['Describe a raster: size, CRS, geotransform, bands, data type, nodata and metadata. Options: -stats, -mm, -hist, -json, -proj4, -nomd.',
      ['gdalinfo dem', 'gdalinfo -stats dem', 'gdalinfo -json dem']],
    gdal_location_info: ['Read raster values at locations. By default x y are pixel/line; with -wgs84 they are ' +
      'longitude/latitude, with -geoloc coordinates in the raster CRS and with -l_srs <crs> coordinates in any CRS. ' +
      'Options: -b <band>, -valonly. Also available as gdallocationinfo.',
    ['gdal_location_info -wgs84 dem -87.63 41.88', 'gdal_location_info -valonly dem 120 45']],
    gdaltransform: ['Transform coordinates between coordinate systems. Give x y pairs (or x,y,z triplets); -output_xy drops Z.',
      ['gdaltransform -s_srs EPSG:4326 -t_srs EPSG:3857 -87.63 41.88',
        'gdaltransform -s_srs EPSG:3435 -t_srs EPSG:4326 -output_xy 1176000,1900000']],
    gdaldem: ['Terrain analysis from an elevation raster: hillshade, slope, aspect, color-relief, TRI, TPI, roughness. ' +
      'Options: -z <factor>, -s <scale> (111120 for DEMs in degrees with elevations in meters), -az <deg>, -alt <deg>, ' +
      '-multidirectional, -combined, -p (slope in percent), -compute_edges. color-relief needs a loaded color table text file.',
    ['gdaldem hillshade -z 2 dem hillshade.tif', 'gdaldem slope -p dem slope.tif', 'gdaldem color-relief dem colors.txt relief.tif']],
    gdalbuildvrt: ['Build a virtual mosaic or band stack from rasters; it is loaded as a raster layer. Options: -separate ' +
      '(one band per input), -resolution highest|lowest|average, -te, -tr, -srcnodata, -vrtnodata.',
    ['gdalbuildvrt -separate stack.vrt red green blue', 'gdalbuildvrt mosaic.vrt tile_a tile_b']],
  };

  /**
   * Console help: an overview, or usage + examples for one program.
   * @param {string} [program]
   * @returns {string}
   */
  function help(program) {
    const p = program && (PROGRAM_ALIASES[String(program).toLowerCase()] || String(program).toLowerCase());
    if (p && HELP[p]) {
      return ['Usage: ' + USAGE[p], '', HELP[p][0], '', 'Examples:'].concat(HELP[p][1].map(function (x) { return '  ' + x; }),
        ['', 'PSICITS flags: --map (also load outputs as layers), --download (file only), --name <layer name>.']).join('\n');
    }
    return [
      'GDAL ' + GDAL_VERSION + ' (gdal3.js ' + GDAL3JS_VERSION + ') runs in your browser. Programs:',
      PROGRAMS.map(function (x) { return '  ' + USAGE[x]; }).join('\n'),
      '',
      'Use layer names wherever GDAL expects a dataset. Vector layers reach GDAL as GeoJSON files whose layer name is a ' +
      'slug of the layer name ("Roads 2020" -> roads_2020); use that name in -sql. Loaded files (a .gpkg, a zipped ' +
      'shapefile, …) are used by their file name.',
      '',
      'Outputs: vector results written as .geojson (or without extension) become map layers; other vector formats ' +
      '(.gpkg, .shp, .kml, …) become downloads. Raster results written as .tif become a raster layer and a download; ' +
      'other raster formats become downloads. Multi-file outputs are zipped.',
      '  --map          also load the output as layer(s)',
      '  --download     only produce the file',
      '  --name <name>  name for the new layer',
      '',
      'SQL: -sql uses OGR SQL; add -dialect SQLite for SpatiaLite functions (ST_Buffer, ST_Intersection, ST_Area, ' +
      'ST_Transform, …). A query may reference several layers by name.',
      '',
      'Examples:',
      '  ogr2ogr -f GPKG roads.gpkg roads',
      '  ogr2ogr -dialect SQLite -sql "SELECT ST_Buffer(geometry, 0.001) AS geometry, * FROM roads" roads_buf roads',
      '  gdalwarp -t_srs EPSG:3857 -r bilinear dem dem_3857.tif',
      '  gdal_rasterize -a population -tr 0.01 0.01 counties pop.tif',
      '  gdal_translate -of PNG dem dem.png',
      '',
      'Type "<program> --help" for details. Not available in this build: gdal_contour, gdal_polygonize, gdal_grid, ' +
      'gdal_calc, ogrmerge, gdaladdo.',
    ].join('\n');
  }

  /* ------------------------------------------------------- public helpers */

  function emptyResult(P) {
    return { program: P.program, argv: P.argv, text: '', json: null, outputs: [], layers: [], logs: [], datasets: [] };
  }

  /** Run fn(job, result) in the GDAL queue with a fresh job (used by the import/export helpers). */
  async function withJob(fn, opts) {
    await ensureRuntime(opts);
    return enqueue(async function () {
      const rt = await ensureRuntime(opts); // may have been reloaded after a crash
      const result = { logs: [], outputs: [], layers: [] };
      const job = new Job(rt, opts || {}, result);
      try {
        return await fn(job, result);
      } catch (e) {
        const err = new Error(job.unmap(e.message || String(e)));
        if (e.fatal) err.fatal = true;
        throw err;
      } finally {
        await job.cleanup();
      }
    });
  }

  /** Normalise readVector/readRaster/info input to [{ name, bytes }]. */
  async function normaliseFiles(filesOrBytes) {
    let list = filesOrBytes;
    if (!Array.isArray(list)) list = [list];
    const out = [];
    for (let i = 0; i < list.length; i++) {
      const f = list[i];
      if (!f) continue;
      if (f instanceof Uint8Array || f instanceof ArrayBuffer) { out.push({ name: 'data' + (i || ''), bytes: toBytes(f) }); continue; }
      // File / Blob (note: newer browsers also have Blob#bytes(), a method)
      if (typeof f.arrayBuffer === 'function' && (f.bytes === undefined || typeof f.bytes === 'function')) {
        out.push({ name: f.webkitRelativePath || f.name || 'data' + i, bytes: new Uint8Array(await f.arrayBuffer()) });
        continue;
      }
      out.push({ name: f.name || 'data' + i, bytes: await asBytes(f.bytes) });
    }
    if (!out.length) throw new Error('No files given');
    return out;
  }

  const CONTAINER_RE = /\.(zip|kmz|tar|tgz|gz)$/i;

  /** Write the files of one or more datasets side by side and return the GDAL paths of the datasets. */
  async function datasetPathsIn(job, files, kind) {
    const dir = job.inDir + '/' + (++job.k);
    const written = files.map(function (f) { return { path: dir + '/' + safeRelPath(f.name, 'data'), bytes: f.bytes, name: f.name }; });
    await job.call('write', { files: written.map(function (f) { return { path: f.path, bytes: f.bytes }; }) });
    written.forEach(function (f) { job.names.push(['/vsizip/' + f.path, f.name]); job.names.push([f.path, f.name]); });
    const plain = written.filter(function (f) { return !CONTAINER_RE.test(f.name); });
    const out = [];
    pickMainFiles(plain.map(function (f) { return f.path.slice(dir.length + 1); }), kind).forEach(function (m) {
      const f = plain.find(function (x) { return x.path === dir + '/' + m; });
      out.push({ path: m ? dir + '/' + m : dir, name: f ? f.name : (m || (files[0] && files[0].name) || 'data') });
    });
    for (const c of written.filter(function (f) { return CONTAINER_RE.test(f.name); })) {
      (await containerPaths(c.path, c.name, c.bytes, kind)).forEach(function (p) { out.push({ path: p, name: c.name }); });
    }
    if (!out.length) plain.forEach(function (f) { out.push({ path: f.path, name: f.name }); }); // let GDAL try
    return out;
  }

  const GENERIC_LAYER = /^(OGRGeoJSON|Layer #?\d+|SELECT|entities|features|sql_statement|layer\d*|untitled)$/i;

  /* ------------------------------------------------------------ the API */

  M.gdal = {
    /** Program names PSICITS can run (gdal3.js JS API + the GDALDEMProcessing / GDALBuildVRT exports). */
    programs: PROGRAMS.slice(),

    /**
     * Configure loading. Call before load(); changing the config later unloads the current instance.
     * @param {{ localPath?: string, cdnPath?: string, init?: function(): Promise<object>, worker?: boolean }} opts
     *   init: async function returning an initialised gdal3.js object with Module access (used by tests).
     *   worker: false forces the main-thread mode in browsers.
     */
    configure(opts) {
      const next = Object.assign({}, config, opts || {});
      const changed = ['localPath', 'cdnPath', 'init', 'worker'].some(function (k) { return next[k] !== config[k]; });
      config = next;
      if (changed && (runtime || loading)) disposeRuntime();
      return Object.assign({}, config);
    },

    /** True once load() has finished. */
    isLoaded() { return !!runtime; },

    /**
     * Load gdal3.js (cached). Browser: worker with local files over http(s), then the CDN; main-thread fallback.
     * Node: the vendored gdal3.node.js.
     * @param {{ onStatus?: function(string) }} [opts]
     * @returns {Promise<{ mode: 'worker'|'main-thread'|'node', source: 'local'|'cdn'|'injected', path, gdalVersion,
     *   gdal3jsVersion, drivers, programs, gdal }>} `gdal` is the raw gdal3.js object when it lives in this thread.
     */
    async load(opts) {
      const rt = await ensureRuntime(opts);
      return rt.info;
    },

    /**
     * Available GDAL drivers (after load()).
     * @returns {{ vector: Array<{name, longName, extensions, canRead, canWrite}>, raster: Array<object> }}
     */
    drivers() {
      if (!runtime) throw new Error('GDAL is not loaded yet; call PSICITS.gdal.load() first');
      return { vector: driverList('vector').map(function (d) { return Object.assign({}, d); }), raster: driverList('raster').map(function (d) { return Object.assign({}, d); }) };
    },

    splitArgs: splitArgs,
    parse: parse,
    help: help,

    /** The layer name a PSICITS layer gets inside GDAL (e.g. for -sql). */
    slug: function (name) { return slugOf(name); },

    /**
     * Run a GDAL command line against PSICITS layers and files.
     * @param {string} cmdline e.g. 'ogr2ogr -f GPKG roads.gpkg roads'
     * @param {{ resolve: function(string): (Input|null|Promise<Input|null>), names?: string[]|function(): string[],
     *           onLog?: function(string), onStatus?: function(string) }} opts
     *   Input = { kind: 'vector', name, fc } | { kind: 'raster', name, raster } | { kind: 'file', name, bytes, files? }
     * @returns {Promise<{ program, argv, text, json, outputs: Array<{filename, bytes, kind, driver}>,
     *   layers: Array<{kind: 'vector', name, fc} | {kind: 'raster', name, raster}>, logs: string[],
     *   datasets: Array<{name, kind, layer, file}> }>}
     */
    async execute(cmdline, opts) {
      opts = opts || {};
      const P = parse(cmdline);
      const result = emptyResult(P);
      const flags = P.options.map(function (o) { return o.key; });
      if (flags.some(function (k) { return ['--help', '--help-general', '--long-usage', '--usage'].indexOf(k) >= 0; })) {
        result.text = help(P.program);
        return result;
      }
      const rt = await ensureRuntime(opts);
      if (flags.indexOf('--version') >= 0) {
        result.text = 'GDAL ' + GDAL_VERSION + ' (gdal3.js ' + GDAL3JS_VERSION + ', ' + rt.info.mode + ')';
        return result;
      }
      if (flags.indexOf('--formats') >= 0) {
        result.text = driversText(/^ogr/.test(P.program) ? 'vector' : P.program === 'gdal_rasterize' ? null : 'raster');
        return result;
      }
      return enqueue(async function () {
        const job = new Job(await ensureRuntime(opts), opts, result); // may have been reloaded after a crash
        if (P.unknown.length) {
          // GDAL rejects unknown options itself; say so early in case a value was taken as a dataset name.
          job.log('Note: PSICITS does not know ' + P.unknown.join(', ') + '; passing it to GDAL as a flag.');
        }
        try {
          await RUNNERS[P.program](job, P);
          job.inputs.forEach(function (m) { result.datasets.push({ name: m.name, kind: m.kind, layer: m.layer || null, file: m.file }); });
          if (!result.text) result.text = summarise(result);
          return result;
        } catch (e) {
          throw decorateError(job, P, e);
        } finally {
          await job.cleanup();
        }
      });
    },

    /**
     * Read any OGR-readable vector dataset (zipped FileGDB, DXF, MapInfo .tab + siblings, GML, ODS, …).
     * @param {{name, bytes}|Array<{name, bytes}>|File|File[]} filesOrBytes all files of the dataset
     * @param {{ layers?: string|string[] }} [opts] only these layers
     * @returns {Promise<Array<{ name, fc, layer, source }>>} FeatureCollections in EPSG:4326
     */
    async readVector(filesOrBytes, opts) {
      opts = opts || {};
      const files = await normaliseFiles(filesOrBytes);
      const only = opts.layers ? [].concat(opts.layers) : null;
      return withJob(async function (job) {
        const paths = await datasetPathsIn(job, files, 'vector');
        const out = [];
        const errors = [];
        for (const p of paths) {
          let layers;
          try {
            layers = await job.readVectorLayers({ path: p.path, openOptions: csvOpenOptions(p.path) }, only);
          } catch (e) {
            errors.push(job.unmap(e.message));
            continue;
          }
          const base = stripExt(p.path.replace(/\/+$/, '').replace(/\.(zip|gz)$/i, ''));
          layers.forEach(function (l) {
            const name = layers.length === 1 && GENERIC_LAYER.test(l.layer) ? base : l.layer;
            out.push({ name: name, fc: l.fc, layer: l.layer, source: p.name });
          });
        }
        if (!out.length) {
          throw new Error(errors.length ? errors[0] : 'No vector layers found in ' + files.map(function (f) { return f.name; }).join(', '));
        }
        return out;
      }, opts);
    },

    /**
     * Read any GDAL raster (downsampled with -outsize above maxPixels; meta.downsample records the factor).
     * Rotated / GCP-only rasters are warped to north-up first. The bands of one raster are views on a
     * single ArrayBuffer.
     * @param {{name, bytes}|Array<{name, bytes}>|File|File[]} filesOrBytes all files of the dataset(s)
     * @param {{ maxPixels?: number, resampling?: string }} [opts] resampling for downsampling (default 'nearest')
     * @returns {Promise<Array<Raster>>}
     */
    async readRaster(filesOrBytes, opts) {
      opts = opts || {};
      const files = await normaliseFiles(filesOrBytes);
      return withJob(async function (job) {
        const paths = await datasetPathsIn(job, files, 'raster');
        const out = [];
        const errors = [];
        for (const p of paths) {
          try {
            const r = await job.readRasterDataset({ path: p.path }, { name: stripExt(p.name), maxPixels: opts.maxPixels || 16e6, resampling: opts.resampling });
            out.push(r);
          } catch (e) {
            errors.push(job.unmap(e.message));
          }
        }
        if (!out.length) throw new Error(errors.length ? errors[0] : 'No raster found in ' + files.map(function (f) { return f.name; }).join(', '));
        return out;
      }, opts);
    },

    /**
     * Write a FeatureCollection with any writable OGR driver.
     * @param {object} fc FeatureCollection in EPSG:4326
     * @param {{ format: string, name?: string, crs?: string, options?: string|string[] }} opts
     *   format: driver name or alias (GPKG, 'ESRI Shapefile'/shp, FlatGeobuf, KML, DXF, 'MapInfo File', OpenFileGDB,
     *   CSV, GML, XLSX, GeoJSONSeq, …); crs reprojects (-t_srs); options = extra ogr2ogr arguments.
     * @returns {Promise<{ filename, bytes, driver, logs }>} multi-file formats come back as one .zip
     */
    async writeVector(fc, opts) {
      opts = opts || {};
      return withJob(async function (job, result) {
        const format = canonicalDriver(opts.format || 'GeoJSON', 'vector');
        if (!format) throw new Error('Unknown vector format "' + opts.format + '"');
        const d = findDriver(format, 'vector');
        if (d && !d.canWrite) throw new Error('GDAL can read ' + format + ' but not write it');
        const name = opts.name || 'layer';
        const m = await job.materialise({ kind: 'vector', name: name, fc: fc });
        const ext = primaryExtension(format, 'vector');
        const file = safeFileName(stripExt(name) || 'layer') + (ext ? '.' + ext : '');
        const out = { kind: 'vector', driver: format, file: file, ext: ext, base: stripExt(file), path: job.outDir + '/' + file };
        let extra = typeof opts.options === 'string' ? splitArgs(opts.options) : (opts.options || []).slice();
        if (format === 'CSV' && !extra.some(function (a) { return /^GEOMETRY=/i.test(a); })) {
          extra = extra.concat(['-lco', util.layerGeometryType(fc) === 'Point' ? 'GEOMETRY=AS_XY' : 'GEOMETRY=AS_WKT']);
        }
        if (format === 'ESRI Shapefile' && !extra.some(function (a) { return /^ENCODING=/i.test(a); })) {
          extra = extra.concat(['-lco', 'ENCODING=UTF-8']); // GDAL's default (LDID/87) would drop non-Latin text
        }
        const args = ['-f', format];
        if (opts.crs) args.push('-t_srs', srsForGdal(opts.crs));
        if (!extra.some(function (a) { return String(a).toLowerCase() === '-nln'; }) && format !== 'ESRI Shapefile') args.push('-nln', stripExt(name));
        await job.call('run', { program: 'ogr2ogr', src: [m.src], dst: out.path, args: args.concat(extra) });
        const entries = (await job.call('list', { dir: job.outDir })).entries;
        const packed = await job.packOutput(out, entries);
        return { filename: packed[0].filename, bytes: packed[0].bytes, driver: format, logs: result.logs.slice() };
      }, opts);
    },

    /**
     * Write a Raster with any writable GDAL raster driver (GTiff, COG, PNG, JPEG, AAIGrid, …).
     * @param {Raster} raster
     * @param {{ format: string, name?: string, crs?: string, options?: string|string[] }} opts
     *   crs warps to that CRS first; options = extra gdal_translate (or gdalwarp when crs is set) arguments.
     * @returns {Promise<{ filename, bytes, driver, logs }>}
     */
    async writeRaster(raster, opts) {
      opts = opts || {};
      return withJob(async function (job, result) {
        const format = canonicalDriver(opts.format || 'GTiff', 'raster');
        if (!format) throw new Error('Unknown raster format "' + opts.format + '"');
        const d = findDriver(format, 'raster');
        if (d && !d.canWrite) throw new Error('GDAL can read ' + format + ' but not write it');
        const name = opts.name || 'raster';
        const m = await job.materialise({ kind: 'raster', name: name, raster: raster });
        const ext = primaryExtension(format, 'raster');
        const file = safeFileName(stripExt(name) || 'raster') + (ext ? '.' + ext : '');
        const out = { kind: 'raster', driver: format, file: file, ext: ext, base: stripExt(file), path: job.outDir + '/' + file };
        const extra = typeof opts.options === 'string' ? splitArgs(opts.options) : (opts.options || []).slice();
        if (opts.crs) {
          await job.call('run', { program: 'gdalwarp', src: [m.src], dst: out.path, args: ['-of', format, '-t_srs', srsForGdal(opts.crs)].concat(extra) });
        } else {
          await job.call('run', { program: 'gdal_translate', src: [m.src], dst: out.path, args: ['-of', format].concat(extra) });
        }
        const entries = (await job.call('list', { dir: job.outDir })).entries;
        const packed = await job.packOutput(out, entries);
        return { filename: packed[0].filename, bytes: packed[0].bytes, driver: format, logs: result.logs.slice() };
      }, opts);
    },

    /**
     * gdalinfo / ogrinfo JSON for an Input ({kind, name, fc|raster|bytes}) or file(s) ({name, bytes} / array).
     * @returns {Promise<object>} the GDAL JSON report plus `kind: 'vector'|'raster'`
     */
    async info(input, opts) {
      return withJob(async function (job) {
        let src;
        if (input && input.kind && (input.fc || input.raster || input.bytes)) {
          src = (await job.materialise(input)).src;
        } else {
          const files = await normaliseFiles(input);
          const paths = await datasetPathsIn(job, files, null);
          src = { path: paths[0].path };
        }
        const pr = await job.call('probe', { src: src });
        const vector = pr.layers > 0 && !(pr.bands > 0 && input && input.kind === 'raster');
        const res = await job.call('run', { program: vector ? 'ogrinfo' : 'gdalinfo', src: [src], args: ['-json'] });
        const json = job.unmapJson(JSON.parse(res.text));
        json.kind = vector ? 'vector' : 'raster';
        return json;
      }, opts);
    },
  };

  function csvOpenOptions(path) {
    if (!/\.(csv|tsv)$/i.test(path)) return [];
    return ['X_POSSIBLE_NAMES=lon*,long*,x,easting', 'Y_POSSIBLE_NAMES=lat*,y,northing', 'GEOM_POSSIBLE_NAMES=geom*,wkt,the_geom',
      'KEEP_GEOM_COLUMNS=NO', 'AUTODETECT_TYPE=YES'];
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
