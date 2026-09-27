/*
 * PSICITS — importing and exporting data (browser side).
 *
 * Native readers handle the common formats; anything else is handed to GDAL
 * (WebAssembly, loaded on first use).
 */
(function (root) {
  'use strict';

  const M = root.PSICITS;
  const util = M.util;
  const F = M.formats;

  const io = (M.io = {});

  /* ------------------------------------------------------------- helpers */

  const loadedScripts = new Map();
  /** Load a classic script once (works from file:// too). */
  io.loadScript = function (src) {
    if (loadedScripts.has(src)) return loadedScripts.get(src);
    const p = new Promise(function (resolve, reject) {
      const s = document.createElement('script');
      s.src = src;
      s.async = true;
      s.onload = function () { resolve(); };
      s.onerror = function () { loadedScripts.delete(src); reject(new Error('Could not load ' + src)); };
      document.head.appendChild(s);
    });
    loadedScripts.set(src, p);
    return p;
  };

  let sqlPromise = null;
  /** sql.js (SQLite in WebAssembly) for GeoPackage, loaded on demand. */
  io.loadSqlJs = function () {
    if (!sqlPromise) {
      sqlPromise = (async function () {
        await io.loadScript('vendor/sqljs/sql-wasm.js');
        if (typeof root.initSqlJs !== 'function') throw new Error('sql.js failed to load');
        if (location.protocol === 'file:') {
          await io.loadScript('vendor/sqljs/sql-wasm-base64.js');
          const bin = root.atob(root.SQLJS_WASM_BASE64);
          const bytes = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
          return root.initSqlJs({ wasmBinary: bytes });
        }
        return root.initSqlJs({ locateFile: function (f) { return 'vendor/sqljs/' + f; } });
      })().catch(function (e) { sqlPromise = null; throw e; });
    }
    return sqlPromise;
  };

  function toBytes(x) {
    if (x instanceof Uint8Array) return x;
    if (x instanceof ArrayBuffer) return new Uint8Array(x);
    if (ArrayBuffer.isView(x)) return new Uint8Array(x.buffer, x.byteOffset, x.byteLength);
    throw new Error('Expected binary data');
  }
  function toArrayBuffer(bytes) {
    return bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength ? bytes.buffer : bytes.slice().buffer;
  }
  function text(bytes) {
    let s = new TextDecoder('utf-8').decode(bytes);
    if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);
    return s;
  }
  function baseName(name) { return String(name || 'layer').replace(/^.*[\\/]/, '').replace(/\.(geo)?json$|\.[^.]+$/i, '') || 'layer'; }
  function ext(name) { const m = /\.([^.\\/]+)$/.exec(String(name || '')); return m ? m[1].toLowerCase() : ''; }

  function parseXML(str) {
    const doc = new DOMParser().parseFromString(str, 'text/xml');
    const err = doc.getElementsByTagName('parsererror')[0];
    if (err) throw new Error('The file is not valid XML');
    return doc;
  }

  const GDAL_VECTOR_EXT = ['gml', 'dxf', 'dgn', 'tab', 'mif', 'mid', 'ods', 'sqlite', 'db', 'gdb', 'mbtiles', 'pmtiles', 'osm', 'pbf', 'jml', 'vdv', 'e00', 'gtfs', 'svg', 'shz', 'fgdb', 'kml2', 'georss', 'xls', 'geojsonl', 'geojsons', 'jsonl', 'ndjson'];
  const GDAL_RASTER_EXT = ['asc', 'img', 'hgt', 'dem', 'dt0', 'dt1', 'dt2', 'bil', 'bsq', 'bip', 'hdr', 'grd', 'nc', 'jp2', 'png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', 'vrt', 'ers', 'rst', 'sdat', 'xyz', 'ecw', 'sid', 'grib', 'grb', 'grb2', 'rsw', 'tiff', 'tif', 'ntf', 'sgrd', 'zarr', 'cog'];

  /* -------------------------------------------------------- vector results */

  function vectorResult(name, fc, extra) {
    return Object.assign({ type: 'vector', name: name, data: fc }, extra || {});
  }

  function fromGeoJSONObject(obj, name, warnings) {
    if (obj && obj.type === 'Topology' && root.topojson) {
      const out = [];
      Object.keys(obj.objects || {}).forEach(function (k) {
        const fc = util.toFeatureCollection(root.topojson.feature(obj, obj.objects[k]));
        out.push(vectorResult(Object.keys(obj.objects).length > 1 ? k : name, fc));
      });
      return out;
    }
    if (obj && Array.isArray(obj.features) && obj.features.length && obj.features[0].attributes !== undefined) {
      return [vectorResult(name, esriToGeoJSON(obj))];
    }
    if (!obj || !(obj.type === 'FeatureCollection' || obj.type === 'Feature' || obj.coordinates || obj.geometries || Array.isArray(obj))) {
      throw new Error('This JSON file is not GeoJSON');
    }
    let fc = util.toFeatureCollection(obj);
    // Legacy GeoJSON with a "crs" member in another system
    const crsName = obj.crs && obj.crs.properties && obj.crs.properties.name;
    if (crsName) {
      const code = M.crs.normalize(crsName);
      if (code && code !== 'EPSG:4326') {
        return M.crs.ensure(code).then(function (c) {
          return [vectorResult(name, M.crs.transformFC(fc, c, 'EPSG:4326'), { crs: c })];
        });
      }
    }
    const b = util.bbox(fc);
    if (b && !M.crs.looksGeographic(b)) warnings.push('Coordinates in "' + name + '" do not look like longitude/latitude. If the layer is misplaced, reload it with the right CRS.');
    return [vectorResult(name, fc)];
  }

  /** Esri JSON (ArcGIS REST f=json) → GeoJSON. */
  function esriToGeoJSON(obj) {
    const ringArea = function (r) { let a = 0; for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += (r[j][0] - r[i][0]) * (r[j][1] + r[i][1]); return a / 2; };
    const inRing = function (pt, ring) {
      let c = false;
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        if (((ring[i][1] > pt[1]) !== (ring[j][1] > pt[1])) && (pt[0] < (ring[j][0] - ring[i][0]) * (pt[1] - ring[i][1]) / (ring[j][1] - ring[i][1]) + ring[i][0])) c = !c;
      }
      return c;
    };
    const geom = function (g) {
      if (!g) return null;
      if (g.x !== undefined && g.y !== undefined) return isFinite(g.x) ? { type: 'Point', coordinates: [g.x, g.y] } : null;
      if (g.points) return { type: 'MultiPoint', coordinates: g.points };
      if (g.paths) return g.paths.length === 1 ? { type: 'LineString', coordinates: g.paths[0] } : { type: 'MultiLineString', coordinates: g.paths };
      if (g.rings) {
        const outers = [], holes = [];
        g.rings.forEach(function (r) { (ringArea(r) > 0 ? outers : holes).push(r); }); // Esri outer rings are clockwise
        if (!outers.length) { outers.push.apply(outers, holes.splice(0)); }
        const polys = outers.map(function (o) { return [o]; });
        holes.forEach(function (h) {
          const p = polys.find(function (poly) { return inRing(h[0], poly[0]); }) || polys[0];
          p.push(h);
        });
        return polys.length === 1 ? { type: 'Polygon', coordinates: polys[0] } : { type: 'MultiPolygon', coordinates: polys };
      }
      return null;
    };
    return {
      type: 'FeatureCollection',
      features: (obj.features || []).map(function (f) { return { type: 'Feature', properties: f.attributes || {}, geometry: geom(f.geometry) }; }),
    };
  }
  io.esriToGeoJSON = esriToGeoJSON;

  async function csvResult(name, rows, opts, warnings) {
    let r = F.csv.toFeatureCollection(rows, {});
    if (r.needsCrs) {
      const code = opts.askCrs ? await opts.askCrs({ name: name, bbox: r.rawBBox, xField: r.xField, yField: r.yField }) : null;
      if (!code) throw new Error('"' + name + '" has projected coordinates (' + r.xField + ', ' + r.yField + '). Load it again and choose its coordinate system (e.g. EPSG:3435).');
      const c = await M.crs.ensure(code);
      r = F.csv.toFeatureCollection(rows, { crs: c, x: r.xField, y: r.yField });
      if (!r.fc) throw new Error('Could not convert the coordinates with ' + c);
    }
    if (r.skipped) warnings.push(r.skipped + ' row(s) in "' + name + '" had no usable coordinates and were skipped.');
    if (r.mode === 'none') warnings.push('"' + name + '" has no coordinate columns — loaded as a table (use "join" to attach it to a layer).');
    return [vectorResult(name, r.fc, { meta: { csvMode: r.mode, xField: r.xField, yField: r.yField, wktField: r.wktField } })];
  }

  /* ----------------------------------------------------------- importing */

  /**
   * Import one file's bytes. Resolves to
   * { layers: [spec...], warnings: [], project?: object }.
   * opts.askCrs({ name, bbox }) -> Promise<code|null> for CSVs in projected units.
   */
  io.importBytes = async function (filename, input, opts) {
    opts = opts || {};
    const bytes = toBytes(input);
    const name = opts.name || baseName(filename);
    const warnings = [];
    const fmt = F.detect(filename, bytes.subarray(0, 512));
    let layers = [];
    const e = ext(filename);

    const gdalVector = async function (files) {
      const res = await M.gdal.readVector(files || [{ name: filename, bytes: bytes }]);
      return res.map(function (r) { return vectorResult(res.length > 1 ? r.name : name, r.fc, { meta: { via: 'GDAL' } }); });
    };
    const gdalRaster = async function (files) {
      const res = await M.gdal.readRaster(files || [{ name: filename, bytes: bytes }], { maxPixels: opts.maxPixels || 16e6 });
      return res.map(function (r, i) { return { type: 'raster', name: res.length > 1 ? name + '_' + (i + 1) : name, raster: r, meta: { via: 'GDAL' } }; });
    };

    switch (fmt) {
      case 'geojson': case 'json': case 'topojson': {
        let obj;
        try { obj = JSON.parse(text(bytes)); } catch (err) { throw new Error('"' + filename + '" is not valid JSON: ' + err.message); }
        if (obj && (obj.format === 'psicits-project' || obj.format === 'meridian-project')) return { layers: [], warnings: warnings, project: obj };
        try { layers = await fromGeoJSONObject(obj, name, warnings); }
        catch (err) { layers = await gdalVector(); }
        break;
      }
      case 'kml': layers = [vectorResult(name, util.toFeatureCollection(root.toGeoJSON.kml(parseXML(text(bytes)))))]; break;
      case 'gpx': layers = [vectorResult(name, util.toFeatureCollection(root.toGeoJSON.gpx(parseXML(text(bytes)))))]; break;
      case 'csv': case 'tsv': layers = await csvResult(name, F.csv.parse(bytes), opts, warnings); break;
      case 'xlsx': {
        const sheets = await F.xlsx.read(bytes);
        for (const sh of sheets) {
          if (!sh.rows.length) continue;
          const r = await csvResult(sheets.length > 1 ? name + '_' + sh.name : name, sh.rows, opts, warnings);
          layers = layers.concat(r);
        }
        if (!layers.length) throw new Error('The workbook has no data rows');
        break;
      }
      case 'gpkg': {
        const SQL = await io.loadSqlJs();
        const res = F.gpkg.read(bytes, SQL);
        res.forEach(function (r) {
          (r.warnings || []).forEach(function (w) { warnings.push(w); });
          layers.push(vectorResult(res.length > 1 ? r.name : name, r.fc, { crs: r.crs, meta: { table: r.name } }));
        });
        if (!layers.length) {
          // raster-only GeoPackage: let GDAL try
          layers = await gdalRaster();
        }
        break;
      }
      case 'fgb': {
        const feats = [];
        for await (const f of root.flatgeobuf.deserialize(bytes)) feats.push(f);
        layers = [vectorResult(name, util.toFeatureCollection(feats))];
        break;
      }
      case 'geotiff': {
        let r;
        try {
          r = await M.raster.fromGeoTIFF(toArrayBuffer(bytes), { maxPixels: opts.maxPixels || 16e6, name: name });
        } catch (err) {
          layers = await gdalRaster();
          break;
        }
        if (r.meta && r.meta.crsNeedsLookup && r.crs) { try { await M.crs.ensure(r.crs); } catch (err) { warnings.push(err.message); } }
        if (!r.crs) warnings.push('"' + name + '" has no recognised coordinate system; assuming it is in longitude/latitude.');
        (r.meta && r.meta.warnings || []).forEach(function (w) { warnings.push(w); });
        if (r.meta && r.meta.downsample > 1) warnings.push('"' + name + '" is large; loaded at 1/' + r.meta.downsample + ' resolution.');
        layers = [{ type: 'raster', name: name, raster: r }];
        break;
      }
      case 'zip': {
        const info = await F.inspectZip(bytes);
        if (info.kind === 'shapefile' || info.kind === 'mixed' && info.entries.some(function (x) { return /\.shp$/i.test(x.path); })) {
          const res = await F.readZipShapefiles(bytes);
          for (const r of res) {
            (r.warnings || []).forEach(function (w) { warnings.push(w); });
            if (r.needsCrs) warnings.push('Shapefile "' + r.name + '" has no .prj; assumed longitude/latitude.');
            layers.push(vectorResult(res.length > 1 ? r.name : name, r.fc, { crs: r.crs }));
          }
          if (info.kind === 'shapefile') break;
        }
        if (info.kind === 'kmz') {
          const zip = await root.JSZip.loadAsync(bytes);
          const kmlEntry = Object.keys(zip.files).find(function (p) { return /\.kml$/i.test(p); });
          if (!kmlEntry) throw new Error('No .kml document inside the KMZ');
          const kml = await zip.file(kmlEntry).async('string');
          layers = [vectorResult(name, util.toFeatureCollection(root.toGeoJSON.kml(parseXML(kml))))];
          break;
        }
        if (info.kind === 'xlsx') return io.importBytes(filename.replace(/\.zip$/i, '.xlsx'), bytes, opts);
        if (['geojson', 'gpkg', 'geotiff', 'mixed'].indexOf(info.kind) >= 0) {
          const zip = await root.JSZip.loadAsync(bytes);
          for (const p of Object.keys(zip.files)) {
            const entry = zip.files[p];
            if (entry.dir || /(^|\/)(__MACOSX|\.)/.test(p)) continue;
            if (!/\.(geo)?json$|\.gpkg$|\.tiff?$|\.kml$|\.gpx$|\.csv$|\.fgb$/i.test(p)) continue;
            const sub = await io.importBytes(p, await entry.async('uint8array'), Object.assign({}, opts, { name: undefined }));
            layers = layers.concat(sub.layers);
            sub.warnings.forEach(function (w) { warnings.push(w); });
          }
          if (layers.length) break;
        }
        // e.g. a zipped File Geodatabase — let GDAL open it
        layers = await gdalVector();
        break;
      }
      case 'wkt': {
        const feats = text(bytes).split(/\r?\n/).map(function (l) { return l.trim(); }).filter(Boolean).map(function (l) {
          return { type: 'Feature', properties: {}, geometry: F.wkt.parse(l) };
        });
        layers = [vectorResult(name, { type: 'FeatureCollection', features: feats })];
        break;
      }
      case 'shp': case 'dbf': case 'shx':
        throw new Error('Shapefiles come in several files. Select the .shp together with its .dbf, .shx and .prj (or drop a .zip).');
      default: {
        if (GDAL_RASTER_EXT.indexOf(e) >= 0) layers = await gdalRaster();
        else if (GDAL_VECTOR_EXT.indexOf(e) >= 0) layers = await gdalVector();
        else {
          try { layers = await gdalVector(); }
          catch (err1) {
            try { layers = await gdalRaster(); }
            catch (err2) { throw new Error('Could not read "' + filename + '": ' + err1.message); }
          }
        }
      }
    }
    layers.forEach(function (l) {
      l.source = Object.assign({ kind: 'file', name: filename }, l.source || {});
      if (l.type === 'vector' && !l.data.features.length) warnings.push('"' + l.name + '" contains no features.');
    });
    return { layers: layers, warnings: warnings };
  };

  /**
   * Import a set of Files (from a picker or drag-and-drop). Groups shapefile
   * and MapInfo sidecar files by base name.
   */
  io.importFiles = async function (files, opts) {
    const list = Array.from(files || []);
    const groups = new Map();
    const singles = [];
    list.forEach(function (f) {
      const e = ext(f.name);
      if (['shp', 'shx', 'dbf', 'prj', 'cpg', 'sbn', 'sbx', 'qix', 'qmd'].indexOf(e) >= 0 || ['tab', 'dat', 'map', 'id', 'ind'].indexOf(e) >= 0 || (e === 'xml' && /\.shp\.xml$/i.test(f.name))) {
        const key = f.name.replace(/\.shp\.xml$/i, '').replace(/\.[^.]+$/, '').toLowerCase();
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(f);
      } else singles.push(f);
    });
    const results = { layers: [], warnings: [], projects: [] };
    for (const [key, members] of groups) {
      const hasShp = members.some(function (f) { return /\.shp$/i.test(f.name); });
      const hasTab = members.some(function (f) { return /\.tab$/i.test(f.name); });
      if (hasShp) {
        const zip = new root.JSZip();
        for (const f of members) zip.file(f.name, await f.arrayBuffer());
        const bytes = await zip.generateAsync({ type: 'uint8array' });
        const r = await io.importBytes(key + '.zip', bytes, Object.assign({ name: baseName(members.find(function (f) { return /\.shp$/i.test(f.name); }).name) }, opts));
        results.layers = results.layers.concat(r.layers);
        results.warnings = results.warnings.concat(r.warnings);
      } else if (hasTab) {
        const files = [];
        for (const f of members) files.push({ name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) });
        const res = await M.gdal.readVector(files);
        res.forEach(function (r) { results.layers.push(vectorResult(r.name, r.fc, { source: { kind: 'file', name: key + '.tab' } })); });
      } else {
        results.warnings.push('Ignored ' + members.map(function (f) { return f.name; }).join(', ') + ' (missing the main .shp/.tab file).');
      }
    }
    for (const f of singles) {
      const r = await io.importBytes(f.name, new Uint8Array(await f.arrayBuffer()), opts);
      if (r.project) results.projects.push(r.project);
      results.layers = results.layers.concat(r.layers);
      results.warnings = results.warnings.concat(r.warnings);
    }
    return results;
  };

  /* ---------------------------------------------------------------- URLs */

  async function fetchOrExplain(url, init) {
    let r;
    try {
      r = await fetch(url, init);
    } catch (e) {
      throw new Error('Could not reach ' + shortUrl(url) + '. The server may not allow browser access (CORS), or you are offline. Download the file and drop it on the map instead.');
    }
    if (!r.ok) throw new Error('The server answered ' + r.status + ' ' + (r.statusText || '') + ' for ' + shortUrl(url));
    return r;
  }
  io.fetch = fetchOrExplain;
  function shortUrl(u) { const s = String(u); return s.length > 90 ? s.slice(0, 87) + '…' : s; }

  function nameFromUrl(url) {
    try {
      const u = new URL(url, location.href);
      const seg = decodeURIComponent(u.pathname.split('/').filter(Boolean).pop() || u.hostname);
      return seg;
    } catch (e) { return 'download'; }
  }

  /** ArcGIS Feature/Map Server layer → GeoJSON, following pagination. */
  io.arcgis = async function (url, opts) {
    opts = opts || {};
    const base = url.replace(/\/query\/?(\?.*)?$/i, '').replace(/\?.*$/, '').replace(/\/$/, '');
    const limit = opts.limit || 50000;
    let meta = null;
    try { meta = await (await fetchOrExplain(base + '?f=json')).json(); } catch (e) { /* optional */ }
    const page = Math.min((meta && meta.maxRecordCount) || 1000, 2000);
    const feats = [];
    let offset = 0;
    let useGeoJSON = true;
    for (let guard = 0; guard < 500 && feats.length < limit; guard++) {
      const q = new URLSearchParams({ where: opts.where || '1=1', outFields: '*', outSR: '4326', f: useGeoJSON ? 'geojson' : 'json', resultOffset: String(offset), resultRecordCount: String(page), returnGeometry: 'true' });
      const r = await fetchOrExplain(base + '/query?' + q.toString());
      const j = await r.json();
      if (j.error) {
        if (useGeoJSON && guard === 0) { useGeoJSON = false; guard--; continue; }
        throw new Error('ArcGIS error: ' + (j.error.message || JSON.stringify(j.error)));
      }
      const fc = useGeoJSON ? util.toFeatureCollection(j) : esriToGeoJSON(j);
      fc.features.forEach(function (f) { feats.push(f); });
      const more = j.exceededTransferLimit || (j.properties && j.properties.exceededTransferLimit);
      if (!more || !fc.features.length) break;
      offset += fc.features.length;
    }
    return { name: (meta && meta.name) || nameFromUrl(base), fc: { type: 'FeatureCollection', features: feats.slice(0, limit) }, truncated: feats.length >= limit };
  };

  /**
   * Import from a URL: data files, ArcGIS REST layers, WFS, XYZ/WMS tiles.
   * Resolves to { layers, warnings }.
   */
  io.importURL = async function (url, opts) {
    opts = opts || {};
    url = String(url).trim();
    const warnings = [];
    if (/\{z\}|\{x\}|\{y\}|\{quadkey\}/i.test(url)) {
      return { layers: [{ type: 'tiles', name: opts.name || tileName(url), url: url, tileSize: 256, attribution: opts.attribution || '', source: { kind: 'url', url: url } }], warnings: warnings };
    }
    if (/[?&]service=wms/i.test(url) || /\/wms\b/i.test(url) && !/service=wfs/i.test(url)) {
      const u = new URL(url, location.href);
      const layersParam = opts.layers || u.searchParams.get('layers') || u.searchParams.get('LAYERS');
      if (!layersParam) throw new Error('WMS needs a layer name: add layers=<name> (see the service GetCapabilities).');
      ['bbox', 'BBOX', 'width', 'WIDTH', 'height', 'HEIGHT', 'request', 'REQUEST', 'service', 'SERVICE', 'layers', 'LAYERS', 'srs', 'SRS', 'crs', 'CRS', 'format', 'FORMAT', 'transparent', 'TRANSPARENT', 'version', 'VERSION', 'styles', 'STYLES'].forEach(function (k) { u.searchParams.delete(k); });
      const tpl = u.origin + u.pathname + '?' + (u.searchParams.toString() ? u.searchParams.toString() + '&' : '') +
        'SERVICE=WMS&VERSION=1.1.1&REQUEST=GetMap&LAYERS=' + encodeURIComponent(layersParam) + '&STYLES=&FORMAT=image%2Fpng&TRANSPARENT=true&SRS=EPSG%3A3857&WIDTH=256&HEIGHT=256&BBOX={bbox-epsg-3857}';
      return { layers: [{ type: 'tiles', name: opts.name || layersParam, url: tpl, tileSize: 256, kind: 'wms', source: { kind: 'wms', url: url } }], warnings: warnings };
    }
    if (/\/(FeatureServer|MapServer)\/\d+\/?(query.*)?$/i.test(url.replace(/\?.*$/, '')) || /\/(FeatureServer|MapServer)\/\d+\/query/i.test(url)) {
      const r = await io.arcgis(url, opts);
      if (r.truncated) warnings.push('Only the first ' + r.fc.features.length + ' features were loaded.');
      return { layers: [vectorResult(opts.name || r.name, r.fc, { source: { kind: 'arcgis', url: url } })], warnings: warnings };
    }
    if (/[?&]service=wfs/i.test(url)) {
      const u = new URL(url, location.href);
      if (!/request=getfeature/i.test(url)) {
        u.searchParams.set('request', 'GetFeature');
        const tn = opts.typeName || u.searchParams.get('typeName') || u.searchParams.get('typeNames');
        if (!tn) throw new Error('WFS needs a typeName (layer name).');
        u.searchParams.set('typeNames', tn);
        u.searchParams.set('typeName', tn);
      }
      if (!u.searchParams.get('outputFormat')) u.searchParams.set('outputFormat', 'application/json');
      if (!u.searchParams.get('srsName')) u.searchParams.set('srsName', 'EPSG:4326');
      url = u.toString();
    }
    const r = await fetchOrExplain(url);
    const buf = new Uint8Array(await r.arrayBuffer());
    let filename = nameFromUrl(url);
    const cd = r.headers.get('content-disposition');
    const m = cd && /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(cd);
    if (m) filename = decodeURIComponent(m[1]);
    const ct = (r.headers.get('content-type') || '').toLowerCase();
    if (!/\.[a-z0-9]{2,8}$/i.test(filename)) {
      if (/json/.test(ct)) filename += '.geojson';
      else if (/csv/.test(ct)) filename += '.csv';
      else if (/kml/.test(ct)) filename += '.kml';
      else if (/gpx/.test(ct)) filename += '.gpx';
      else if (/zip/.test(ct)) filename += '.zip';
      else if (/tiff/.test(ct)) filename += '.tif';
      else if (/xml|gml/.test(ct)) filename += '.gml';
    }
    const res = await io.importBytes(filename, buf, Object.assign({}, opts, { name: opts.name || baseName(filename) }));
    res.layers.forEach(function (l) { l.source = { kind: 'url', url: url }; });
    res.warnings = warnings.concat(res.warnings);
    return res;
  };

  function tileName(url) {
    try { return new URL(url.replace(/\{[^}]+\}/g, '0'), location.href).hostname.replace(/^www\./, ''); } catch (e) { return 'tiles'; }
  }

  /* ----------------------------------------------------------- exporting */

  io.EXPORT_FORMATS = {
    geojson: { label: 'GeoJSON', ext: 'geojson', kinds: ['vector'] },
    csv: { label: 'CSV (x/y or WKT)', ext: 'csv', kinds: ['vector'] },
    kml: { label: 'KML (Google Earth)', ext: 'kml', kinds: ['vector'] },
    gpx: { label: 'GPX', ext: 'gpx', kinds: ['vector'] },
    shapefile: { label: 'Shapefile (.zip)', ext: 'zip', kinds: ['vector'] },
    gpkg: { label: 'GeoPackage', ext: 'gpkg', kinds: ['vector'] },
    fgb: { label: 'FlatGeobuf', ext: 'fgb', kinds: ['vector'] },
    wkt: { label: 'WKT (one geometry per line)', ext: 'wkt', kinds: ['vector'] },
    geotiff: { label: 'GeoTIFF', ext: 'tif', kinds: ['raster'] },
    png: { label: 'PNG image (as displayed)', ext: 'png', kinds: ['raster'] },
    // via GDAL
    dxf: { label: 'DXF (CAD) — GDAL', ext: 'dxf', kinds: ['vector'], gdal: 'DXF' },
    filegdb: { label: 'Esri File Geodatabase — GDAL', ext: 'gdb.zip', kinds: ['vector'], gdal: 'OpenFileGDB' },
    mapinfo: { label: 'MapInfo TAB — GDAL', ext: 'zip', kinds: ['vector'], gdal: 'MapInfo File' },
    gml: { label: 'GML — GDAL', ext: 'gml', kinds: ['vector'], gdal: 'GML' },
    xlsx: { label: 'Excel (.xlsx) — GDAL', ext: 'xlsx', kinds: ['vector'], gdal: 'XLSX' },
    ods: { label: 'OpenDocument spreadsheet — GDAL', ext: 'ods', kinds: ['vector'], gdal: 'ODS' },
    sqlite: { label: 'SQLite / SpatiaLite — GDAL', ext: 'sqlite', kinds: ['vector'], gdal: 'SQLite' },
    geojsonseq: { label: 'GeoJSON lines — GDAL', ext: 'geojsonl', kinds: ['vector'], gdal: 'GeoJSONSeq' },
    pmtiles: { label: 'PMTiles vector tiles — GDAL', ext: 'pmtiles', kinds: ['vector'], gdal: 'PMTiles' },
    cog: { label: 'Cloud-Optimized GeoTIFF — GDAL', ext: 'tif', kinds: ['raster'], gdal: 'COG' },
    asc: { label: 'ASCII grid — GDAL', ext: 'asc', kinds: ['raster'], gdal: 'AAIGrid' },
    jpeg: { label: 'JPEG — GDAL', ext: 'jpg', kinds: ['raster'], gdal: 'JPEG' },
  };
  const FORMAT_ALIASES = { json: 'geojson', shp: 'shapefile', 'esri shapefile': 'shapefile', zip: 'shapefile', geopackage: 'gpkg', tif: 'geotiff', tiff: 'geotiff', flatgeobuf: 'fgb', gdb: 'filegdb', 'file geodatabase': 'filegdb', tab: 'mapinfo', excel: 'xlsx', spatialite: 'sqlite', image: 'png', ascii: 'asc', aaigrid: 'asc', jpg: 'jpeg', kmz: 'kml' };
  io.normalizeFormat = function (f) {
    const k = String(f || '').toLowerCase().trim();
    if (io.EXPORT_FORMATS[k]) return k;
    if (FORMAT_ALIASES[k]) return FORMAT_ALIASES[k];
    return null;
  };

  function blobOf(data, type) { return new Blob([data], { type: type || 'application/octet-stream' }); }

  /**
   * Export a layer. opts: { format, crs, selectedOnly, filename }.
   * Returns { filename, blob, warnings }.
   */
  io.exportLayer = async function (layer, opts) {
    opts = opts || {};
    const warnings = [];
    let format = io.normalizeFormat(opts.format || (layer.type === 'raster' ? 'geotiff' : 'geojson'));
    let gdalDriver = null;
    if (!format) {
      // any GDAL driver name, e.g. "MapInfo File" or "GPX"
      gdalDriver = opts.format;
    }
    const spec = format ? io.EXPORT_FORMATS[format] : null;
    if (spec && spec.kinds.indexOf(layer.type) < 0) throw new Error(spec.label + ' is for ' + spec.kinds.join('/') + ' layers; "' + layer.name + '" is a ' + layer.type + ' layer.');
    const base = util.slug(opts.filename || layer.name) || 'layer';
    const crs = opts.crs ? M.crs.normalize(opts.crs) : 'EPSG:4326';
    if (crs !== 'EPSG:4326' && layer.type === 'vector') await M.crs.ensure(crs);

    if (layer.type === 'vector') {
      let fc = layer.data;
      if (opts.selectedOnly) {
        const feats = M.store.selectedFeatures(layer.id);
        if (!feats.length) throw new Error('Nothing is selected in "' + layer.name + '"');
        fc = { type: 'FeatureCollection', features: feats };
      }
      const clean = { type: 'FeatureCollection', features: fc.features.map(function (f) { return { type: 'Feature', properties: f.properties, geometry: f.geometry }; }) };
      if (spec && spec.gdal) gdalDriver = spec.gdal;
      if (!gdalDriver && crs !== 'EPSG:4326' && format !== 'csv' && format !== 'geojson' && format !== 'wkt') gdalDriver = { shapefile: 'ESRI Shapefile', gpkg: 'GPKG', kml: 'KML', gpx: 'GPX', fgb: 'FlatGeobuf' }[format];
      if (gdalDriver) {
        const out = await M.gdal.writeVector(clean, { format: gdalDriver, name: base, crs: crs !== 'EPSG:4326' ? crs : undefined });
        return { filename: out.filename, blob: blobOf(out.bytes), warnings: warnings };
      }
      const projected = crs !== 'EPSG:4326' ? M.crs.transformFC(clean, 'EPSG:4326', crs) : clean;
      switch (format) {
        case 'geojson': {
          const obj = crs !== 'EPSG:4326' ? Object.assign({ crs: { type: 'name', properties: { name: 'urn:ogc:def:crs:' + crs.replace(':', '::') } } }, projected) : clean;
          if (crs !== 'EPSG:4326') warnings.push('GeoJSON is normally lon/lat; this file uses ' + crs + ' with a legacy "crs" member.');
          return { filename: base + '.geojson', blob: blobOf(JSON.stringify(obj), 'application/geo+json'), warnings: warnings };
        }
        case 'csv': return { filename: base + '.csv', blob: blobOf(F.csv.write(projected, {}), 'text/csv'), warnings: warnings };
        case 'wkt': return { filename: base + '.wkt', blob: blobOf(projected.features.filter(function (f) { return f.geometry; }).map(function (f) { return F.wkt.stringify(f.geometry); }).join('\n'), 'text/plain'), warnings: warnings };
        case 'kml': {
          const s = layer.style || {};
          return { filename: base + '.kml', blob: blobOf(F.kml.write(clean, { name: layer.name, color: s.color, lineWidth: s.lineWidth, fillOpacity: s.fillOpacity }), 'application/vnd.google-earth.kml+xml'), warnings: warnings };
        }
        case 'gpx': return { filename: base + '.gpx', blob: blobOf(F.gpx.write(clean, { name: layer.name }), 'application/gpx+xml'), warnings: warnings };
        case 'shapefile': {
          const r = await F.shapefile.write(clean, { name: base });
          return { filename: base + '.zip', blob: blobOf(r.bytes, 'application/zip'), warnings: warnings.concat(r.warnings || []) };
        }
        case 'gpkg': {
          const SQL = await io.loadSqlJs();
          return { filename: base + '.gpkg', blob: blobOf(F.gpkg.write([{ name: base, fc: clean }], SQL), 'application/geopackage+sqlite3'), warnings: warnings };
        }
        case 'fgb': return { filename: base + '.fgb', blob: blobOf(root.flatgeobuf.serialize(clean)), warnings: warnings };
        default: throw new Error('Unsupported format ' + format);
      }
    }
    if (layer.type === 'raster') {
      if (spec && spec.gdal) gdalDriver = spec.gdal;
      if (gdalDriver || (crs !== 'EPSG:4326' && opts.crs)) {
        const out = await M.gdal.writeRaster(layer.raster, { format: gdalDriver || 'GTiff', name: base, crs: opts.crs ? crs : undefined });
        return { filename: out.filename, blob: blobOf(out.bytes), warnings: warnings };
      }
      if (format === 'png') {
        const res = M.raster.render(layer.raster, layer.style, { maxSize: 4096 });
        const c = document.createElement('canvas');
        c.width = res.width; c.height = res.height;
        c.getContext('2d').putImageData(new ImageData(res.data, res.width, res.height), 0, 0);
        const blob = await new Promise(function (r) { c.toBlob(r, 'image/png'); });
        warnings.push('PNG images are not georeferenced (Web Mercator display). Use GeoTIFF for GIS use.');
        return { filename: base + '.png', blob: blob, warnings: warnings };
      }
      return { filename: base + '.tif', blob: blobOf(F.geotiff.write(layer.raster), 'image/tiff'), warnings: warnings };
    }
    throw new Error('Tile layers cannot be exported (they are loaded from a web service).');
  };

  /** Save a Blob as a download. */
  io.download = function (blob, filename) {
    const a = document.createElement('a');
    const url = URL.createObjectURL(blob);
    a.href = url;
    a.download = filename;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 60000);
  };

  /** Ask the user for files. Resolves to a FileList (may be empty). */
  io.pickFiles = function (opts) {
    opts = opts || {};
    return new Promise(function (resolve) {
      const input = document.createElement('input');
      input.type = 'file';
      input.multiple = opts.multiple !== false;
      if (opts.accept) input.accept = opts.accept;
      input.style.display = 'none';
      input.addEventListener('change', function () { resolve(input.files); input.remove(); });
      document.body.appendChild(input);
      input.click();
    });
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
