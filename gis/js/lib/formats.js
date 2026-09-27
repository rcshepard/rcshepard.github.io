/*
 * PSICITS — file format readers and writers.
 *
 * DOM-free (runs in the browser, in Web Workers and in Node): XML is written
 * as strings and read with a small tokenizer, binary formats use DataView.
 * Vector data is GeoJSON in EPSG:4326 throughout.
 *
 *   wkt, wkb            geometry encodings
 *   gpkg                GeoPackage read / write (pass an initialised sql.js)
 *   shapefile           zipped Shapefile writer (JSZip)
 *   kml, gpx            writers
 *   csv                 parse (PapaParse + type inference), geometry detection, write
 *   xlsx                minimal Excel reader (JSZip)
 *   geotiff             GeoTIFF writer
 *   detect, inspectZip, readZipShapefiles
 */
(function (root) {
  'use strict';

  const M = (root.PSICITS = root.PSICITS || {});
  const util = M.util;

  /* ============================================================ helpers */

  function lib(name, label) {
    const l = root[name];
    if (!l) throw new Error((label || name) + ' is not loaded');
    return l;
  }

  function isArrayBuffer(x) {
    return !!x && (x instanceof ArrayBuffer || Object.prototype.toString.call(x) === '[object ArrayBuffer]');
  }

  /** Coerce ArrayBuffer / typed array / DataView / Buffer to a Uint8Array view. */
  function toBytes(data, what) {
    if (data instanceof Uint8Array) return data;
    if (isArrayBuffer(data)) return new Uint8Array(data);
    if (data && ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    throw new Error((what || 'The file') + ' must be binary data (an ArrayBuffer or Uint8Array)');
  }

  function startsWithAscii(u8, s) {
    if (!u8 || u8.length < s.length) return false;
    for (let i = 0; i < s.length; i++) if (u8[i] !== s.charCodeAt(i)) return false;
    return true;
  }

  let encoder = null;
  function utf8Encode(s) {
    if (!encoder) encoder = new TextEncoder();
    return encoder.encode(String(s));
  }

  /** UTF-8 byte length of a string, without allocating. */
  function utf8Length(s) {
    let n = 0;
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      if (c < 0x80) n += 1;
      else if (c < 0x800) n += 2;
      else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length && (s.charCodeAt(i + 1) & 0xfc00) === 0xdc00) { n += 4; i++; }
      else n += 3;
    }
    return n;
  }

  /** Decode text bytes: honours UTF-8/UTF-16 BOMs, falls back to Windows-1252 for legacy files. */
  function decodeText(bytes) {
    const u8 = toBytes(bytes);
    try {
      if (u8[0] === 0xff && u8[1] === 0xfe) return new TextDecoder('utf-16le').decode(u8.subarray(2));
      if (u8[0] === 0xfe && u8[1] === 0xff) return new TextDecoder('utf-16be').decode(u8.subarray(2));
    } catch (e) { /* decoder unavailable: fall through */ }
    const body = u8[0] === 0xef && u8[1] === 0xbb && u8[2] === 0xbf ? u8.subarray(3) : u8;
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(body);
    } catch (e) {
      try { return new TextDecoder('windows-1252').decode(body); } catch (e2) { return new TextDecoder('utf-8').decode(body); }
    }
  }

  /** Shortest round-trip number text ("-0" becomes "0"). */
  function numStr(n) { return n === 0 ? '0' : String(n); }

  /** Plain decimal text (never exponent notation), trailing zeros trimmed. */
  function decStr(n, maxDecimals) {
    if (!isFinite(n)) return String(n);
    if (Math.abs(n) >= 1e21) return String(n);
    let s = n.toFixed(maxDecimals);
    if (s.indexOf('.') >= 0) s = s.replace(/0+$/, '').replace(/\.$/, '');
    return s === '-0' ? '0' : s;
  }

  const XML_ENTITIES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' };
  // Characters that are not allowed in XML 1.0 documents (plus lone surrogates).
  // eslint-disable-next-line no-control-regex
  const XML_INVALID = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]|\p{Cs}/gu;

  function xmlEscape(v) {
    return String(v).replace(XML_INVALID, '').replace(/[&<>"']/g, function (c) { return XML_ENTITIES[c]; });
  }

  /** Text form of an attribute value for text formats (CSV, DBF, KML). */
  function valueToText(v) {
    if (v === null || v === undefined) return '';
    switch (typeof v) {
      case 'string': return v;
      case 'number': return isFinite(v) ? numStr(v) : '';
      case 'boolean': return v ? 'true' : 'false';
      case 'bigint': return String(v);
      default:
        if (v instanceof Date) return isNaN(v.getTime()) ? '' : v.toISOString();
        try { return JSON.stringify(v); } catch (e) { return String(v); }
    }
  }

  function isPos(p) {
    return Array.isArray(p) && typeof p[0] === 'number' && typeof p[1] === 'number' && isFinite(p[0]) && isFinite(p[1]);
  }

  /** True when a geometry has no usable position at all. */
  function isEmptyGeometry(g) {
    if (!g) return true;
    let any = false;
    util.coordEach(g, function (p) { if (!any && isPos(p)) any = true; });
    return !any;
  }

  /** True when every position of the geometry carries a finite Z value. */
  function geometryHasZ(g) {
    let n = 0, z = 0;
    util.coordEach(g, function (p) {
      n++;
      if (p && p.length > 2 && typeof p[2] === 'number' && isFinite(p[2])) z++;
    });
    return n > 0 && z === n;
  }

  function anyZ(g) {
    let found = false;
    util.coordEach(g, function (p) { if (!found && p && p.length > 2 && typeof p[2] === 'number' && isFinite(p[2])) found = true; });
    return found;
  }

  /** Find a field by (case-insensitive) name among candidates, in candidate order. */
  function pickField(fieldNames, candidates) {
    const lower = new Map();
    fieldNames.forEach(function (f) { const k = String(f).toLowerCase(); if (!lower.has(k)) lower.set(k, f); });
    for (let i = 0; i < candidates.length; i++) if (lower.has(candidates[i])) return lower.get(candidates[i]);
    return null;
  }

  function fieldNamesOf(fc) { return util.inferFields(fc).map(function (f) { return f.name; }); }

  /** Column names read from files become object keys: never let one be "__proto__". */
  function safeKey(name) { return name === '__proto__' ? '_proto_' : name; }

  function featuresOf(fc) {
    if (!fc) return [];
    if (Array.isArray(fc)) return fc;
    return Array.isArray(fc.features) ? fc.features : [];
  }

  const WKT_NAME = {
    Point: 'POINT', LineString: 'LINESTRING', Polygon: 'POLYGON', MultiPoint: 'MULTIPOINT',
    MultiLineString: 'MULTILINESTRING', MultiPolygon: 'MULTIPOLYGON', GeometryCollection: 'GEOMETRYCOLLECTION',
  };
  const FROM_WKT_NAME = {};
  Object.keys(WKT_NAME).forEach(function (k) { FROM_WKT_NAME[WKT_NAME[k]] = k; });
  const WKB_CODE = { Point: 1, LineString: 2, Polygon: 3, MultiPoint: 4, MultiLineString: 5, MultiPolygon: 6, GeometryCollection: 7 };
  const UNSUPPORTED_WKB = {
    8: 'CircularString', 9: 'CompoundCurve', 10: 'CurvePolygon', 11: 'MultiCurve', 12: 'MultiSurface',
    13: 'Curve', 14: 'Surface', 15: 'PolyhedralSurface', 16: 'TIN', 17: 'Triangle',
  };
  const UNSUPPORTED_WKT = /^(CIRCULARSTRING|COMPOUNDCURVE|CURVEPOLYGON|MULTICURVE|MULTISURFACE|CURVE|SURFACE|POLYHEDRALSURFACE|TIN|TRIANGLE)(Z|M|ZM)?$/;

  /* ================================================================ WKT */

  function wktTokens(text) {
    const re = /\s*(?:([A-Za-z_]+)|([-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)|([(),;=])|(\S))/y;
    const toks = [];
    let m;
    while (re.lastIndex < text.length && (m = re.exec(text)) !== null) {
      if (m[1] !== undefined) toks.push({ k: 'w', v: m[1].toUpperCase() });
      else if (m[2] !== undefined) toks.push({ k: 'n', v: m[2] });
      else if (m[3] !== undefined) toks.push({ k: 'p', v: m[3] });
      else if (m[4] !== undefined) throw new Error('Invalid WKT: unexpected character "' + m[4] + '"');
    }
    return toks;
  }

  function emptyOf(type) {
    return type === 'GeometryCollection' ? { type: type, geometries: [] } : { type: type, coordinates: [] };
  }

  function parseWkt(input) {
    if (typeof input !== 'string') throw new Error('WKT must be a text string');
    const text = input.trim();
    if (!text) throw new Error('Invalid WKT: the text is empty');
    const toks = wktTokens(text);
    let k = 0;

    const found = function () { return toks[k] ? '"' + toks[k].v + '"' : 'the end of the text'; };
    const fail = function (what) { throw new Error('Invalid WKT: expected ' + what + ' but found ' + found()); };
    const isP = function (v) { return toks[k] !== undefined && toks[k].k === 'p' && toks[k].v === v; };
    const isW = function (v) { return toks[k] !== undefined && toks[k].k === 'w' && toks[k].v === v; };
    const expectP = function (v) { if (!isP(v)) fail('"' + v + '"'); k++; };

    // EWKT: SRID=4326;POINT(...)
    if (isW('SRID')) {
      k++;
      expectP('=');
      if (!toks[k] || toks[k].k !== 'n') fail('an SRID number');
      k++;
      expectP(';');
    }

    function readPosition(dim) {
      const vals = [];
      while (toks[k] !== undefined && toks[k].k === 'n') { vals.push(+toks[k].v); k++; }
      if (vals.length < 2) fail('a coordinate (two or more numbers)');
      if (vals.length > 4) throw new Error('Invalid WKT: a coordinate has more than 4 numbers');
      // XYM: drop the measure. Z, ZM and undeclared 3D: keep Z, drop M.
      return dim === 'M' ? vals.slice(0, 2) : vals.slice(0, 3);
    }
    function readPositions(dim) {
      expectP('(');
      const out = [readPosition(dim)];
      while (isP(',')) { k++; out.push(readPosition(dim)); }
      expectP(')');
      return out;
    }
    function readRings(dim) {
      expectP('(');
      const out = [readPositions(dim)];
      while (isP(',')) { k++; out.push(readPositions(dim)); }
      expectP(')');
      return out;
    }
    function readParts(readOne) {
      expectP('(');
      const out = [];
      for (;;) {
        if (isW('EMPTY')) k++;
        else { const part = readOne(); if (part !== null) out.push(part); }
        if (!isP(',')) break;
        k++;
      }
      expectP(')');
      return out;
    }
    function readGeometry() {
      const t = toks[k];
      if (!t || t.k !== 'w') fail('a geometry type such as POINT, LINESTRING or POLYGON');
      k++;
      let type = FROM_WKT_NAME[t.v];
      let dim = '';
      if (!type) {
        const m = /^(.*?)(ZM|Z|M)$/.exec(t.v);
        if (m && FROM_WKT_NAME[m[1]]) { type = FROM_WKT_NAME[m[1]]; dim = m[2]; }
      }
      if (!type) {
        if (UNSUPPORTED_WKT.test(t.v)) throw new Error('WKT geometry type ' + t.v + ' (curves and surfaces) is not supported');
        throw new Error('Invalid WKT: unknown geometry type "' + t.v + '"');
      }
      if (!dim && (isW('Z') || isW('M') || isW('ZM'))) { dim = toks[k].v; k++; }
      if (isW('EMPTY')) { k++; return emptyOf(type); }
      switch (type) {
        case 'Point': {
          expectP('(');
          const p = readPosition(dim);
          expectP(')');
          return { type: type, coordinates: p };
        }
        case 'LineString': return { type: type, coordinates: readPositions(dim) };
        case 'Polygon': return { type: type, coordinates: readRings(dim) };
        case 'MultiPoint':
          // Both MULTIPOINT (1 2, 3 4) and MULTIPOINT ((1 2), (3 4)).
          return {
            type: type,
            coordinates: readParts(function () {
              if (!isP('(')) return readPosition(dim);
              k++;
              const p = readPosition(dim);
              expectP(')');
              return p;
            }),
          };
        case 'MultiLineString': return { type: type, coordinates: readParts(function () { return readPositions(dim); }) };
        case 'MultiPolygon': return { type: type, coordinates: readParts(function () { return readRings(dim); }) };
        default: return { type: type, geometries: readParts(readGeometry) };
      }
    }

    const g = readGeometry();
    if (k < toks.length) throw new Error('Invalid WKT: unexpected ' + found() + ' after the end of the geometry');
    return g;
  }

  function stringifyWkt(geom, opts) {
    if (geom && geom.type === 'Feature') geom = geom.geometry;
    if (!geom || typeof geom !== 'object' || !WKT_NAME[geom.type]) {
      throw new Error(geom && geom.type ? 'Unsupported geometry type "' + geom.type + '"' : 'No geometry to convert to WKT');
    }
    const precision = opts && opts.precision !== undefined && opts.precision !== null ? Math.max(0, Math.min(20, +opts.precision)) : null;
    const num = precision === null ? numStr : function (n) { return decStr(n, precision); };
    const z = geometryHasZ(geom);
    const tag = z ? ' Z ' : ' ';
    const pos = function (p) { return num(p[0]) + ' ' + num(p[1]) + (z ? ' ' + num(p[2]) : ''); };
    const list = function (ps) { return ps && ps.length ? '(' + ps.map(pos).join(', ') + ')' : 'EMPTY'; };
    const rings = function (rs) { return rs && rs.length ? '(' + rs.map(list).join(', ') + ')' : 'EMPTY'; };
    const wrap = function (arr, fn) { return arr && arr.length ? '(' + arr.map(fn).join(', ') + ')' : 'EMPTY'; };
    const one = function (g) {
      if (!g || !WKT_NAME[g.type]) throw new Error('Unsupported geometry type "' + (g && g.type) + '"');
      const c = g.coordinates;
      let body;
      switch (g.type) {
        case 'Point': body = isPos(c) ? '(' + pos(c) + ')' : 'EMPTY'; break;
        case 'LineString': body = list(c); break;
        case 'Polygon': body = rings(c); break;
        case 'MultiPoint': body = wrap(c, function (p) { return isPos(p) ? '(' + pos(p) + ')' : 'EMPTY'; }); break;
        case 'MultiLineString': body = wrap(c, list); break;
        case 'MultiPolygon': body = wrap(c, rings); break;
        default: body = wrap(g.geometries, one); break;
      }
      return WKT_NAME[g.type] + (body === 'EMPTY' ? ' EMPTY' : tag + body);
    };
    return one(geom);
  }

  /* ================================================================ WKB */

  function parseWkb(input, offset) {
    const u8 = toBytes(input, 'WKB');
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    const start = offset || 0;
    let pos = start;
    let srid;
    const need = function (n) {
      if (pos + n > dv.byteLength) throw new Error('Invalid WKB: the data ends unexpectedly');
    };

    function readGeom(depth) {
      if (depth > 32) throw new Error('Invalid WKB: geometry nesting is too deep');
      need(5);
      const order = dv.getUint8(pos);
      if (order > 1) throw new Error('Invalid WKB: bad byte-order marker (' + order + ')');
      const le = order === 1;
      let type = dv.getUint32(pos + 1, le);
      pos += 5;
      let hasZ = (type & 0x80000000) !== 0;
      let hasM = (type & 0x40000000) !== 0;
      const hasSrid = (type & 0x20000000) !== 0;
      type &= 0x0fffffff;
      if (type >= 3000 && type < 4000) { hasZ = true; hasM = true; type -= 3000; }
      else if (type >= 2000 && type < 3000) { hasM = true; type -= 2000; }
      else if (type >= 1000 && type < 2000) { hasZ = true; type -= 1000; }
      if (hasSrid) {
        need(4);
        const s = dv.getUint32(pos, le);
        pos += 4;
        if (depth === 0) srid = s;
      }
      const dims = 2 + (hasZ ? 1 : 0) + (hasM ? 1 : 0);
      const step = 8 * dims;
      const readPoint = function () {
        const x = dv.getFloat64(pos, le), y = dv.getFloat64(pos + 8, le);
        const p = hasZ ? [x, y, dv.getFloat64(pos + 16, le)] : [x, y];
        pos += step;
        return p;
      };
      const readCount = function (minBytesEach) {
        need(4);
        const n = dv.getUint32(pos, le);
        pos += 4;
        need(n * minBytesEach);
        return n;
      };
      const readPoints = function () {
        const n = readCount(step);
        const out = new Array(n);
        for (let i = 0; i < n; i++) out[i] = readPoint();
        return out;
      };
      switch (type) {
        case 1: {
          need(step);
          const p = readPoint();
          return isNaN(p[0]) && isNaN(p[1]) ? { type: 'Point', coordinates: [] } : { type: 'Point', coordinates: p };
        }
        case 2: return { type: 'LineString', coordinates: readPoints() };
        case 3: {
          const n = readCount(4);
          const rings = [];
          for (let i = 0; i < n; i++) rings.push(readPoints());
          return { type: 'Polygon', coordinates: rings };
        }
        case 4: case 5: case 6: {
          const want = ['Point', 'LineString', 'Polygon'][type - 4];
          const n = readCount(5);
          const parts = [];
          for (let i = 0; i < n; i++) {
            const g = readGeom(depth + 1);
            if (g.type !== want) throw new Error('Invalid WKB: a Multi' + want + ' contains a ' + g.type);
            if (g.coordinates.length) parts.push(g.coordinates);
          }
          return { type: 'Multi' + want, coordinates: parts };
        }
        case 7: {
          const n = readCount(5);
          const geoms = [];
          for (let i = 0; i < n; i++) geoms.push(readGeom(depth + 1));
          return { type: 'GeometryCollection', geometries: geoms };
        }
        default:
          if (UNSUPPORTED_WKB[type]) throw new Error(UNSUPPORTED_WKB[type] + ' geometries (curves and surfaces) are not supported');
          throw new Error('Invalid WKB: unknown geometry type code ' + type);
      }
    }

    const geometry = readGeom(0);
    const out = { geometry: geometry, bytesRead: pos - start };
    if (srid !== undefined) out.srid = srid;
    return out;
  }

  function writeWkb(geom, opts) {
    if (geom && geom.type === 'Feature') geom = geom.geometry;
    if (!geom || !WKB_CODE[geom.type]) {
      throw new Error(geom && geom.type ? 'Unsupported geometry type "' + geom.type + '"' : 'No geometry to convert to WKB');
    }
    const le = !(opts && opts.littleEndian === false);
    const z = geometryHasZ(geom);
    const ptBytes = z ? 24 : 16;
    const zAdd = z ? 1000 : 0;

    const size = function (g) {
      const c = g.coordinates;
      switch (g.type) {
        case 'Point': return 5 + ptBytes;
        case 'LineString': return 9 + (c ? c.length : 0) * ptBytes;
        case 'Polygon': return 9 + (c || []).reduce(function (s, r) { return s + 4 + r.length * ptBytes; }, 0);
        case 'MultiPoint': return 9 + (c ? c.length : 0) * (5 + ptBytes);
        case 'MultiLineString': return 9 + (c || []).reduce(function (s, l) { return s + 9 + l.length * ptBytes; }, 0);
        case 'MultiPolygon': return 9 + (c || []).reduce(function (s, p) { return s + size({ type: 'Polygon', coordinates: p }); }, 0);
        case 'GeometryCollection': return 9 + (g.geometries || []).reduce(function (s, m) { return s + size(m); }, 0);
        default: throw new Error('Unsupported geometry type "' + g.type + '"');
      }
    };

    const buf = new ArrayBuffer(size(geom));
    const dv = new DataView(buf);
    let pos = 0;
    const header = function (code) { dv.setUint8(pos, le ? 1 : 0); dv.setUint32(pos + 1, code + zAdd, le); pos += 5; };
    const u32 = function (n) { dv.setUint32(pos, n, le); pos += 4; };
    const point = function (p) {
      const ok = isPos(p);
      dv.setFloat64(pos, ok ? p[0] : NaN, le);
      dv.setFloat64(pos + 8, ok ? p[1] : NaN, le);
      if (z) dv.setFloat64(pos + 16, ok ? p[2] : NaN, le);
      pos += ptBytes;
    };
    const points = function (ps) { u32(ps.length); ps.forEach(point); };
    const polygon = function (rings) { header(3); u32(rings.length); rings.forEach(points); };
    const write = function (g) {
      const c = g.coordinates;
      switch (g.type) {
        case 'Point': header(1); point(c); break;
        case 'LineString': header(2); points(c || []); break;
        case 'Polygon': polygon(c || []); break;
        case 'MultiPoint': header(4); u32((c || []).length); (c || []).forEach(function (p) { header(1); point(p); }); break;
        case 'MultiLineString': header(5); u32((c || []).length); (c || []).forEach(function (l) { header(2); points(l); }); break;
        case 'MultiPolygon': header(6); u32((c || []).length); (c || []).forEach(polygon); break;
        default: header(7); u32((g.geometries || []).length); (g.geometries || []).forEach(write); break;
      }
    };
    write(geom);
    return new Uint8Array(buf);
  }

  function hexToBytes(hex) {
    const s = String(hex).trim().replace(/^\\x/i, '');
    if (!/^(?:[0-9a-fA-F]{2})+$/.test(s)) throw new Error('Invalid hex WKB: expected an even number of hexadecimal digits');
    const out = new Uint8Array(s.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(s.substr(i * 2, 2), 16);
    return out;
  }

  function bytesToHex(bytes) {
    const u8 = toBytes(bytes);
    let s = '';
    for (let i = 0; i < u8.length; i++) s += (u8[i] < 16 ? '0' : '') + u8[i].toString(16);
    return s.toUpperCase();
  }

  /* ========================================================= GeoPackage */

  const GPKG_APPLICATION_ID = 0x47504b47; // "GPKG"
  const GPKG_USER_VERSION = 10300; // 1.3.0
  const GPKG_WKT_4326 = 'GEOGCS["WGS 84",DATUM["WGS_1984",SPHEROID["WGS 84",6378137,298.257223563,AUTHORITY["EPSG","7030"]],' +
    'AUTHORITY["EPSG","6326"]],PRIMEM["Greenwich",0,AUTHORITY["EPSG","8901"]],UNIT["degree",0.0174532925199433,' +
    'AUTHORITY["EPSG","9122"]],AXIS["Latitude",NORTH],AXIS["Longitude",EAST],AUTHORITY["EPSG","4326"]]';
  const GPKG_GEOMETRY_TYPES = new Set(['GEOMETRY', 'POINT', 'LINESTRING', 'POLYGON', 'MULTIPOINT', 'MULTILINESTRING',
    'MULTIPOLYGON', 'GEOMETRYCOLLECTION', 'CIRCULARSTRING', 'COMPOUNDCURVE', 'CURVEPOLYGON', 'MULTICURVE',
    'MULTISURFACE', 'CURVE', 'SURFACE']);
  const GPKG_ENVELOPE_BYTES = [0, 32, 48, 48, 64];
  const GPKG_DDL = [
    'CREATE TABLE gpkg_spatial_ref_sys (srs_name TEXT NOT NULL, srs_id INTEGER NOT NULL PRIMARY KEY, ' +
      'organization TEXT NOT NULL, organization_coordsys_id INTEGER NOT NULL, definition TEXT NOT NULL, description TEXT)',
    'CREATE TABLE gpkg_contents (table_name TEXT NOT NULL PRIMARY KEY, data_type TEXT NOT NULL, identifier TEXT UNIQUE, ' +
      "description TEXT DEFAULT '', last_change DATETIME NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), " +
      'min_x DOUBLE, min_y DOUBLE, max_x DOUBLE, max_y DOUBLE, srs_id INTEGER, ' +
      'CONSTRAINT fk_gc_r_srs_id FOREIGN KEY (srs_id) REFERENCES gpkg_spatial_ref_sys(srs_id))',
    'CREATE TABLE gpkg_geometry_columns (table_name TEXT NOT NULL, column_name TEXT NOT NULL, ' +
      'geometry_type_name TEXT NOT NULL, srs_id INTEGER NOT NULL, z TINYINT NOT NULL, m TINYINT NOT NULL, ' +
      'CONSTRAINT pk_geom_cols PRIMARY KEY (table_name, column_name), CONSTRAINT uk_gc_table_name UNIQUE (table_name), ' +
      'CONSTRAINT fk_gc_tn FOREIGN KEY (table_name) REFERENCES gpkg_contents(table_name), ' +
      'CONSTRAINT fk_gc_srs FOREIGN KEY (srs_id) REFERENCES gpkg_spatial_ref_sys (srs_id))',
    'CREATE TABLE gpkg_extensions (table_name TEXT, column_name TEXT, extension_name TEXT NOT NULL, ' +
      'definition TEXT NOT NULL, scope TEXT NOT NULL, CONSTRAINT ge_tce UNIQUE (table_name, column_name, extension_name))',
  ];
  const GPKG_SCHEMA_DDL = [
    'CREATE TABLE gpkg_data_columns (table_name TEXT NOT NULL, column_name TEXT NOT NULL, name TEXT, title TEXT, ' +
      'description TEXT, mime_type TEXT, constraint_name TEXT, CONSTRAINT pk_gdc PRIMARY KEY (table_name, column_name), ' +
      'CONSTRAINT gdc_tn UNIQUE (table_name, name))',
    'CREATE TABLE gpkg_data_column_constraints (constraint_name TEXT NOT NULL, constraint_type TEXT NOT NULL, ' +
      'value TEXT, min NUMERIC, min_is_inclusive BOOLEAN, max NUMERIC, max_is_inclusive BOOLEAN, description TEXT, ' +
      'CONSTRAINT gdcc_ntv UNIQUE (constraint_name, constraint_type, value))',
  ];

  function quoteIdent(name) { return '"' + String(name).replace(/"/g, '""') + '"'; }

  function sqlRows(db, sql, params) {
    const st = db.prepare(sql);
    try {
      if (params) st.bind(params);
      const out = [];
      while (st.step()) out.push(st.getAsObject());
      return out;
    } finally {
      st.free();
    }
  }

  function requireSql(SQL) {
    if (!SQL || typeof SQL.Database !== 'function') {
      throw new Error('GeoPackage support needs sql.js: initialise it with initSqlJs() and pass it in');
    }
  }

  /** Declared SQLite column type -> PSICITS field kind ('auto' when undeclared). */
  function sqlTypeToKind(declared) {
    const t = String(declared || '').trim().toUpperCase();
    if (!t) return 'auto';
    if (GPKG_GEOMETRY_TYPES.has(t.replace(/\s*\(.*$/, ''))) return 'blob';
    if (t.indexOf('BOOL') >= 0) return 'boolean';
    if (t.indexOf('DATE') >= 0 || t.indexOf('TIME') >= 0) return 'date';
    if (t.indexOf('INT') >= 0 || /REAL|FLOA|DOUB|NUMERIC|DECIMAL/.test(t)) return 'number';
    if (t.indexOf('BLOB') >= 0) return 'blob';
    return 'string';
  }

  /** Parse a GeoPackage geometry blob ("GP" header + WKB). Returns a geometry or null (empty). */
  function parseGpkgGeometry(u8) {
    if (u8.length >= 8 && u8[0] === 0x47 && u8[1] === 0x50) {
      const flags = u8[3];
      if (flags & 0x20) throw new Error('extended GeoPackage geometry types are not supported');
      const envBytes = GPKG_ENVELOPE_BYTES[(flags >> 1) & 7];
      if (envBytes === undefined) throw new Error('invalid GeoPackage geometry header');
      const empty = (flags & 0x10) !== 0;
      const start = 8 + envBytes;
      if (start >= u8.length) {
        if (empty) return null;
        throw new Error('truncated GeoPackage geometry');
      }
      const g = parseWkb(u8, start).geometry;
      return empty || isEmptyGeometry(g) ? null : g;
    }
    if (u8.length >= 5 && (u8[0] === 0 || u8[0] === 1)) {
      if (u8[0] === 0 && u8.length > 43 && u8[38] === 0x7c && u8[u8.length - 1] === 0xfe) {
        throw new Error('SpatiaLite geometries are not supported');
      }
      const g = parseWkb(u8, 0).geometry; // plain WKB, written by some tools
      return isEmptyGeometry(g) ? null : g;
    }
    throw new Error('unrecognised geometry encoding');
  }

  /** Encode a geometry as a GeoPackage blob (little-endian header with envelope + ISO WKB). */
  function gpkgGeometryBlob(g, srsId) {
    const wkbBytes = writeWkb(g, { littleEndian: true });
    const z = geometryHasZ(g);
    const env = [Infinity, -Infinity, Infinity, -Infinity, Infinity, -Infinity];
    util.coordEach(g, function (p) {
      if (!isPos(p)) return;
      if (p[0] < env[0]) env[0] = p[0];
      if (p[0] > env[1]) env[1] = p[0];
      if (p[1] < env[2]) env[2] = p[1];
      if (p[1] > env[3]) env[3] = p[1];
      if (z) {
        if (p[2] < env[4]) env[4] = p[2];
        if (p[2] > env[5]) env[5] = p[2];
      }
    });
    const envBytes = z ? 48 : 32;
    const out = new Uint8Array(8 + envBytes + wkbBytes.length);
    const dv = new DataView(out.buffer);
    out[0] = 0x47; // 'G'
    out[1] = 0x50; // 'P'
    out[2] = 0; // version 1
    out[3] = ((z ? 2 : 1) << 1) | 1; // envelope code, little-endian
    dv.setInt32(4, srsId, true);
    for (let i = 0; i < envBytes / 8; i++) dv.setFloat64(8 + i * 8, env[i], true);
    out.set(wkbBytes, 8 + envBytes);
    return out;
  }

  /** Resolve a GeoPackage srs_id to a PSICITS CRS code, or throw a user-facing error. */
  function resolveGpkgSrs(srsId, srsById, layerName) {
    const C = M.crs;
    const row = srsById.get(srsId);
    const org = row ? String(row.organization || '').trim().toUpperCase() : '';
    const orgId = row ? Number(row.organization_coordsys_id) : NaN;
    if (srsId === 4326 || (org === 'EPSG' && orgId === 4326)) return { code: 'EPSG:4326' };
    if (srsId === null || srsId === undefined || isNaN(srsId) || srsId === 0 || srsId === -1 || org === 'NONE') {
      return { code: 'EPSG:4326', undefinedSrs: true };
    }
    if (!row) {
      const err = new Error('GeoPackage layer "' + layerName + '" uses coordinate system ' + srsId + ', which is not defined in the file');
      err.userFacing = true;
      throw err;
    }
    const label = '"' + (row.srs_name || 'SRS ' + srsId) + '"' + (org && isFinite(orgId) ? ' (' + org + ':' + orgId + ')' : '');
    const failure = function () {
      const err = new Error('GeoPackage layer "' + layerName + '" uses the coordinate system ' + label +
        ', which PSICITS cannot convert to longitude/latitude');
      err.userFacing = true;
      return err;
    };
    let code = null;
    if ((org === 'EPSG' || org === 'ESRI') && isFinite(orgId) && C.has(org + ':' + orgId)) code = org + ':' + orgId;
    if (!code) {
      const defs = [row.definition, row.definition_12_063].filter(function (d) { return typeof d === 'string' && C.isWKT(d); });
      for (let i = 0; i < defs.length && !code; i++) {
        try { code = C.fromWKT(defs[i]); } catch (e) { code = null; }
      }
    }
    if (!code) throw failure();
    let transform;
    try { transform = C.transformer(code, 'EPSG:4326'); } catch (e) { throw failure(); }
    return { code: code, transform: code === 'EPSG:4326' ? null : transform, label: label, failure: failure };
  }

  function convertGpkgValue(v, col, warnings) {
    if (v === null || v === undefined) return null;
    if (v instanceof Uint8Array) {
      if (!col.warned) {
        col.warned = true;
        warnings.push('Column "' + col.name + '" contains binary data, which was left out');
      }
      return null;
    }
    switch (col.kind) {
      case 'boolean':
        if (typeof v === 'number') return v !== 0;
        if (typeof v === 'string') return /^(1|true|t|yes|y)$/i.test(v.trim());
        return !!v;
      case 'date':
        return typeof v === 'string' ? v.replace(/^(\d{4}-\d{2}-\d{2}) (\d)/, '$1T$2') : v;
      case 'object':
        if (typeof v === 'string') {
          try { return JSON.parse(v); } catch (e) { return v; }
        }
        return v;
      default:
        return v;
    }
  }

  function readGpkgTable(db, contents, gc, srsById, jsonCols) {
    const name = String(contents.table_name);
    const warnings = [];
    const cols = sqlRows(db, 'PRAGMA table_info(' + quoteIdent(name) + ')');
    const lowerName = function (s) { return String(s).toLowerCase(); };
    let geomCol = gc ? String(gc.column_name) : null;
    let geometryType = gc ? String(gc.geometry_type_name || 'GEOMETRY').toUpperCase() : null;
    if (geomCol && !cols.some(function (c) { return lowerName(c.name) === lowerName(geomCol); })) {
      warnings.push('Geometry column "' + geomCol + '" of layer "' + name + '" is missing; the layer was read without geometry');
      geomCol = null;
      geometryType = null;
    }
    if (!gc && String(contents.data_type).toLowerCase() === 'features') {
      // No gpkg_geometry_columns row: fall back to a column declared with a geometry type.
      const guess = cols.find(function (c) { return GPKG_GEOMETRY_TYPES.has(String(c.type || '').trim().toUpperCase()); });
      if (guess) { geomCol = guess.name; geometryType = String(guess.type).trim().toUpperCase(); }
    }
    const pk = cols.filter(function (c) { return c.pk > 0; });
    const fidCol = pk.length === 1 && /^INTEGER$/i.test(String(pk[0].type).trim()) ? pk[0].name : null;

    const props = [];
    cols.forEach(function (c) {
      if (geomCol && lowerName(c.name) === lowerName(geomCol)) return;
      if (fidCol && c.name === fidCol) return;
      let kind = sqlTypeToKind(c.type);
      if (jsonCols.has(lowerName(name) + '\u0000' + lowerName(c.name))) kind = 'object';
      if (kind === 'blob') {
        warnings.push('Column "' + c.name + '" holds binary data (' + String(c.type || 'BLOB').toUpperCase() + ') and was not imported');
        return;
      }
      props.push({ name: safeKey(String(c.name)), column: String(c.name), kind: kind, warned: false });
    });

    let srs = { code: null };
    const srsId = geomCol ? Number(gc && gc.srs_id !== undefined ? gc.srs_id : contents.srs_id) : null;
    if (geomCol) srs = resolveGpkgSrs(srsId, srsById, name);

    const select = (geomCol ? [geomCol] : []).concat(props.map(function (p) { return p.column; }));
    const st = db.prepare('SELECT ' + (select.length ? select.map(quoteIdent).join(', ') : '1') + ' FROM ' + quoteIdent(name));
    const features = [];
    let bad = 0, firstError = null, checked = false;
    try {
      while (st.step()) {
        const row = st.get();
        let geometry = null;
        let i = 0;
        if (geomCol) {
          i = 1;
          const blob = row[0];
          if (blob instanceof Uint8Array && blob.length) {
            try {
              geometry = parseGpkgGeometry(blob);
            } catch (e) {
              bad++;
              if (!firstError) firstError = e.message;
            }
            if (geometry && srs.transform) {
              geometry = util.mapCoords(geometry, srs.transform);
              if (!checked) {
                checked = true;
                let ok = true;
                util.coordEach(geometry, function (p) { if (ok && !isPos(p)) ok = false; });
                if (!ok) throw srs.failure();
              }
            }
          } else if (blob !== null && blob !== undefined && !(blob instanceof Uint8Array)) {
            bad++;
            if (!firstError) firstError = 'the geometry column holds non-binary values';
          }
        }
        const properties = {};
        for (let j = 0; j < props.length; j++) properties[props[j].name] = convertGpkgValue(row[i + j], props[j], warnings);
        features.push({ type: 'Feature', geometry: geometry, properties: properties });
      }
    } finally {
      st.free();
    }
    if (bad) warnings.push(bad + ' geometr' + (bad === 1 ? 'y' : 'ies') + ' in layer "' + name + '" could not be read and were left empty (' + firstError + ')');

    const fc = { type: 'FeatureCollection', features: features };
    if (srs.undefinedSrs) {
      const bb = util.bbox(fc);
      warnings.push('Layer "' + name + '" has an undefined coordinate system; assumed longitude/latitude (WGS 84)' +
        (bb && !M.crs.looksGeographic(bb) ? ', but its coordinates do not look like longitude/latitude, so it may appear in the wrong place' : ''));
    }

    const fields = props.map(function (p) {
      let type = p.kind;
      if (type === 'auto') {
        type = 'string';
        for (let k = 0; k < features.length; k++) {
          const v = features[k].properties[p.name];
          if (v === null || v === undefined) continue;
          type = typeof v === 'number' ? 'number' : typeof v === 'boolean' ? 'boolean' : 'string';
          break;
        }
      }
      return { name: p.name, type: type };
    });

    return {
      name: name,
      fc: fc,
      srsId: geomCol ? srsId : null,
      crs: geomCol ? srs.code : null,
      geometryType: geomCol ? geometryType : null,
      fields: fields,
      warnings: warnings,
    };
  }

  function gpkgRead(bytes, SQL) {
    requireSql(SQL);
    const u8 = toBytes(bytes, 'The GeoPackage');
    if (!startsWithAscii(u8, 'SQLite format 3\u0000')) throw new Error('This file is not a GeoPackage (it is not an SQLite database)');
    let db;
    try {
      db = new SQL.Database(u8);
    } catch (e) {
      throw new Error('Could not open the GeoPackage: ' + (e && e.message ? e.message : e));
    }
    try {
      const tables = new Set(sqlRows(db, "SELECT name FROM sqlite_master WHERE type IN ('table', 'view')")
        .map(function (r) { return String(r.name).toLowerCase(); }));
      if (!tables.has('gpkg_contents')) throw new Error('This SQLite database is not a GeoPackage (it has no gpkg_contents table)');
      const srsById = new Map();
      if (tables.has('gpkg_spatial_ref_sys')) {
        sqlRows(db, 'SELECT * FROM gpkg_spatial_ref_sys').forEach(function (r) { srsById.set(Number(r.srs_id), r); });
      }
      const geomCols = new Map();
      if (tables.has('gpkg_geometry_columns')) {
        sqlRows(db, 'SELECT * FROM gpkg_geometry_columns').forEach(function (r) { geomCols.set(String(r.table_name).toLowerCase(), r); });
      }
      const jsonCols = new Set();
      if (tables.has('gpkg_data_columns')) {
        try {
          sqlRows(db, 'SELECT table_name, column_name, mime_type FROM gpkg_data_columns').forEach(function (r) {
            if (/json/i.test(String(r.mime_type || ''))) jsonCols.add((String(r.table_name) + '\u0000' + String(r.column_name)).toLowerCase());
          });
        } catch (e) { /* optional table with a non-standard layout */ }
      }

      const layers = [];
      const skipped = [];
      const missing = [];
      const failed = [];
      sqlRows(db, 'SELECT * FROM gpkg_contents').forEach(function (c) {
        const dataType = String(c.data_type || '').toLowerCase();
        const tname = String(c.table_name);
        if (dataType === 'features' || dataType === 'attributes' || dataType === 'aspatial') {
          if (!tables.has(tname.toLowerCase())) { missing.push(tname); return; }
          try {
            layers.push(readGpkgTable(db, c, dataType === 'features' ? geomCols.get(tname.toLowerCase()) : null, srsById, jsonCols));
          } catch (e) {
            if (e && e.userFacing) throw e;
            // e.g. a view that calls SQL functions sql.js does not have
            failed.push('"' + tname + '" (' + (e && e.message ? e.message : e) + ')');
          }
        } else {
          skipped.push(tname + (dataType ? ' (' + dataType + ')' : ''));
        }
      });
      const notes = [];
      if (skipped.length) {
        notes.push('Skipped ' + skipped.length + ' raster/tile table' + (skipped.length === 1 ? '' : 's') + ': ' +
          skipped.join(', ') + ' (only vector and attribute tables are read)');
      }
      if (missing.length) notes.push('Listed in gpkg_contents but missing from the file: ' + missing.join(', '));
      if (failed.length) notes.push('Could not read ' + failed.join(', '));
      if (!layers.length) {
        if (failed.length) throw new Error('Could not read the GeoPackage layers: ' + failed.join(', '));
        if (skipped.length) throw new Error('This GeoPackage has no vector layers — it only contains raster/tile tables (' + skipped.join(', ') + ')');
        throw new Error('This GeoPackage has no layers');
      }
      layers[0].warnings = notes.concat(layers[0].warnings);
      return layers;
    } finally {
      try { db.close(); } catch (e) { /* ignore */ }
    }
  }

  /** Sanitised identifier: runs of characters other than letters, digits and "_" become "_". */
  function sanitizeIdent(name, fallback) {
    const s = String(name === null || name === undefined ? '' : name).normalize('NFC').trim()
      .split(/[^\p{L}\p{N}_]+/u).filter(Boolean).join('_');
    return s || fallback;
  }

  function gpkgColumnType(fc, field) {
    const feats = featuresOf(fc);
    const key = field.name;
    switch (field.type) {
      case 'number': {
        for (let i = 0; i < feats.length; i++) {
          const v = feats[i] && feats[i].properties ? feats[i].properties[key] : null;
          if (typeof v === 'number' && isFinite(v) && !Number.isSafeInteger(v)) return 'REAL';
          if (typeof v === 'string' && v.trim() !== '' && isFinite(+v) && !Number.isSafeInteger(+v)) return 'REAL';
        }
        return 'INTEGER';
      }
      case 'boolean': return 'BOOLEAN';
      case 'date': {
        for (let i = 0; i < feats.length; i++) {
          const v = feats[i] && feats[i].properties ? feats[i].properties[key] : null;
          if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}[T ]\d/.test(v)) return 'DATETIME';
          if (v instanceof Date) return 'DATETIME';
        }
        return 'DATE';
      }
      default: return 'TEXT';
    }
  }

  function gpkgDateTime(v) {
    if (v instanceof Date) return isNaN(v.getTime()) ? null : v.toISOString();
    const s = String(v).trim();
    const m = /^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)(Z|[+-]\d{2}:?\d{2})?)?$/.exec(s);
    if (!m) return s || null;
    if (!m[2]) return m[1];
    if (m[3]) {
      const d = new Date(m[1] + 'T' + m[2] + (m[3].length === 5 ? m[3].slice(0, 3) + ':' + m[3].slice(3) : m[3]));
      if (!isNaN(d.getTime())) return d.toISOString();
    }
    return m[1] + 'T' + (m[2].length === 5 ? m[2] + ':00' : m[2]);
  }

  function toGpkgValue(v, col) {
    if (v === null || v === undefined) return null;
    switch (col.sqlType) {
      case 'INTEGER':
      case 'REAL': {
        const n = typeof v === 'number' ? v : typeof v === 'boolean' ? +v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
        return isFinite(n) ? n : null;
      }
      case 'BOOLEAN':
        if (typeof v === 'boolean') return v ? 1 : 0;
        if (typeof v === 'number') return v ? 1 : 0;
        if (typeof v === 'string') {
          if (/^(true|t|yes|y|1)$/i.test(v.trim())) return 1;
          if (/^(false|f|no|n|0)$/i.test(v.trim())) return 0;
        }
        return null;
      case 'DATE': {
        if (v instanceof Date) return isNaN(v.getTime()) ? null : v.toISOString().slice(0, 10);
        const m = /^(\d{4}-\d{2}-\d{2})/.exec(String(v).trim());
        return m ? m[1] : (String(v).trim() || null);
      }
      case 'DATETIME': return gpkgDateTime(v);
      default:
        if (col.json) {
          try { return JSON.stringify(v); } catch (e) { return String(v); }
        }
        return valueToText(v);
    }
  }

  /** Geometry type name for a layer: the single type, MULTI* when single/multi mix, else GEOMETRY. */
  function gpkgLayerGeometryType(feats) {
    const types = new Set();
    let count = 0, withZ = 0;
    feats.forEach(function (f) {
      const g = f && f.geometry;
      if (!g || !WKB_CODE[g.type] || isEmptyGeometry(g)) return;
      types.add(g.type);
      count++;
      if (geometryHasZ(g)) withZ++;
    });
    let name = null, promote = null;
    if (types.size === 1) name = WKT_NAME[Array.from(types)[0]];
    else if (types.size > 1) {
      const fams = new Set(Array.from(types, function (t) { return util.geomFamily(t); }));
      if (fams.size === 1 && !types.has('GeometryCollection')) {
        promote = 'Multi' + Array.from(fams)[0];
        name = WKT_NAME[promote];
      } else name = 'GEOMETRY';
    }
    return { name: name, promote: promote, count: count, z: withZ === 0 ? 0 : withZ === count ? 1 : 2 };
  }

  function promoteGeometry(g, promote) {
    if (!promote || g.type === promote) return g;
    if ('Multi' + g.type === promote) return { type: promote, coordinates: [g.coordinates] };
    return g;
  }

  function writeGpkgLayer(db, layer, index, names, jsonColumns) {
    const fc = layer && layer.fc ? layer.fc : layer;
    const label = layer && layer.name ? '"' + layer.name + '"' : String(index + 1);
    if (!fc || !Array.isArray(fc.features)) throw new Error('Layer ' + label + ' has no features to export');
    const feats = fc.features;
    const rawName = layer && layer.name !== undefined && layer.name !== null && String(layer.name).trim()
      ? String(layer.name).trim() : 'layer_' + (index + 1);
    let table = sanitizeIdent(rawName, 'layer_' + (index + 1));
    if (/^(gpkg|rtree|sqlite)_/i.test(table)) table = 'layer_' + table;
    table = util.uniqueName(table, names.tables);
    names.tables.push(table);
    const identifier = util.uniqueName(rawName, names.identifiers);
    names.identifiers.push(identifier);

    const geomInfo = gpkgLayerGeometryType(feats);
    // A layer whose features all lack geometry becomes an attribute table.
    const spatial = geomInfo.count > 0 || feats.length === 0;
    const geometryTypeName = geomInfo.name || 'GEOMETRY';

    const inferred = util.inferFields(fc);
    const inferredType = {};
    inferred.forEach(function (f) { inferredType[f.name] = f.type; });
    const given = layer && Array.isArray(layer.fields) && layer.fields.length ? layer.fields : inferred;
    const taken = spatial ? ['fid', 'geom'] : ['fid'];
    const cols = given.map(function (f) {
      const def = typeof f === 'string' ? { name: f } : f;
      const type = def.type || inferredType[def.name] || 'string';
      const colName = util.uniqueName(sanitizeIdent(def.name, 'field'), taken);
      taken.push(colName);
      const sqlType = gpkgColumnType(fc, { name: def.name, type: type });
      const col = { src: def.name, name: colName, sqlType: sqlType, json: type === 'object' };
      if (col.json) jsonColumns.push({ table: table, column: colName });
      return col;
    });

    const colDefs = ['"fid" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL'];
    if (spatial) colDefs.push('"geom" ' + geometryTypeName);
    cols.forEach(function (c) { colDefs.push(quoteIdent(c.name) + ' ' + c.sqlType); });
    db.run('CREATE TABLE ' + quoteIdent(table) + ' (' + colDefs.join(', ') + ')');

    const insertCols = (spatial ? ['geom'] : []).concat(cols.map(function (c) { return c.name; }));
    const ins = db.prepare(insertCols.length
      ? 'INSERT INTO ' + quoteIdent(table) + ' (' + insertCols.map(quoteIdent).join(', ') + ') VALUES (' + insertCols.map(function () { return '?'; }).join(', ') + ')'
      : 'INSERT INTO ' + quoteIdent(table) + ' DEFAULT VALUES');
    let bbox = null;
    try {
      feats.forEach(function (f) {
        const vals = [];
        if (spatial) {
          const g = f && f.geometry;
          if (g && WKB_CODE[g.type] && !isEmptyGeometry(g)) {
            const pg = promoteGeometry(g, geomInfo.promote);
            vals.push(gpkgGeometryBlob(pg, 4326));
            bbox = util.bboxUnion(bbox, util.bbox(pg));
          } else vals.push(null);
        }
        const p = (f && f.properties) || {};
        cols.forEach(function (c) { vals.push(toGpkgValue(p[c.src], c)); });
        if (vals.length) ins.run(vals);
        else { ins.step(); ins.reset(); }
      });
    } finally {
      ins.free();
    }

    db.run('INSERT INTO gpkg_contents (table_name, data_type, identifier, description, last_change, min_x, min_y, max_x, max_y, srs_id) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [
      table, spatial ? 'features' : 'attributes', identifier, '', new Date().toISOString(),
      bbox ? bbox[0] : null, bbox ? bbox[1] : null, bbox ? bbox[2] : null, bbox ? bbox[3] : null, spatial ? 4326 : null,
    ]);
    if (spatial) {
      db.run('INSERT INTO gpkg_geometry_columns (table_name, column_name, geometry_type_name, srs_id, z, m) VALUES (?, ?, ?, ?, ?, ?)',
        [table, 'geom', geometryTypeName, 4326, geomInfo.z, 0]);
    }
  }

  function gpkgWrite(layers, SQL) {
    requireSql(SQL);
    const list = (Array.isArray(layers) ? layers : [layers]).filter(Boolean);
    if (!list.length) throw new Error('Nothing to export: no layers were given');
    const db = new SQL.Database();
    try {
      db.run('PRAGMA application_id = ' + GPKG_APPLICATION_ID);
      db.run('PRAGMA user_version = ' + GPKG_USER_VERSION);
      db.run('BEGIN');
      GPKG_DDL.forEach(function (sql) { db.run(sql); });
      const insSrs = 'INSERT INTO gpkg_spatial_ref_sys (srs_name, srs_id, organization, organization_coordsys_id, definition, description) VALUES (?, ?, ?, ?, ?, ?)';
      db.run(insSrs, ['Undefined Cartesian SRS', -1, 'NONE', -1, 'undefined', 'undefined Cartesian coordinate reference system']);
      db.run(insSrs, ['Undefined geographic SRS', 0, 'NONE', 0, 'undefined', 'undefined geographic coordinate reference system']);
      db.run(insSrs, ['WGS 84 geodetic', 4326, 'EPSG', 4326, GPKG_WKT_4326, 'longitude/latitude coordinates in decimal degrees on the WGS 84 spheroid']);
      const names = { tables: [], identifiers: [] };
      const jsonColumns = [];
      list.forEach(function (layer, i) { writeGpkgLayer(db, layer, i, names, jsonColumns); });
      if (jsonColumns.length) {
        // Schema extension: mark JSON columns so objects round-trip (GDAL reads this too).
        GPKG_SCHEMA_DDL.forEach(function (sql) { db.run(sql); });
        const ext = 'INSERT INTO gpkg_extensions (table_name, column_name, extension_name, definition, scope) VALUES (?, NULL, ?, ?, ?)';
        db.run(ext, ['gpkg_data_columns', 'gpkg_schema', 'http://www.geopackage.org/spec/#extension_schema', 'read-write']);
        db.run(ext, ['gpkg_data_column_constraints', 'gpkg_schema', 'http://www.geopackage.org/spec/#extension_schema', 'read-write']);
        jsonColumns.forEach(function (c) {
          db.run('INSERT INTO gpkg_data_columns (table_name, column_name, name, mime_type) VALUES (?, ?, ?, ?)',
            [c.table, c.column, c.column, 'application/json']);
        });
      }
      db.run('COMMIT');
      return db.export();
    } finally {
      try { db.close(); } catch (e) { /* ignore */ }
    }
  }

  /* ========================================================== Shapefile */

  const SHP_FAMILY = { Point: 'point', MultiPoint: 'point', LineString: 'line', MultiLineString: 'line', Polygon: 'polygon', MultiPolygon: 'polygon' };

  function fileBaseName(name) {
    let s = String(name === null || name === undefined ? '' : name).trim().replace(/\.(zip|shp)$/i, '');
    s = s.replace(/[\u0000-\u001f\\/:*?"<>|]+/g, '_').replace(/^[.\s]+|[.\s]+$/g, '');
    return s || 'layer';
  }

  function ringSignedArea(r) {
    let a = 0;
    for (let i = 0, n = r.length; i < n - 1; i++) a += r[i][0] * r[i + 1][1] - r[i + 1][0] * r[i][1];
    return a / 2; // > 0: counter-clockwise
  }

  function closedRing(ring) {
    const r = (ring || []).filter(isPos);
    if (r.length && (r[0][0] !== r[r.length - 1][0] || r[0][1] !== r[r.length - 1][1])) r.push(r[0]);
    return r;
  }

  function mergeFamilyParts(parts) {
    if (parts.length === 1) return parts[0];
    const fam = SHP_FAMILY[parts[0].type];
    const coords = [];
    parts.forEach(function (g) {
      if (g.type.indexOf('Multi') === 0) g.coordinates.forEach(function (c) { coords.push(c); });
      else coords.push(g.coordinates);
    });
    return { type: fam === 'point' ? 'MultiPoint' : fam === 'line' ? 'MultiLineString' : 'MultiPolygon', coordinates: coords };
  }

  /** Split features into one group per geometry family (point / line / polygon). */
  function shapefileGroups(feats, base, warnings) {
    const present = { point: false, line: false, polygon: false };
    let collections = 0;
    const explode = function (g, out) {
      if (!g) return;
      if (g.type === 'GeometryCollection') (g.geometries || []).forEach(function (m) { explode(m, out); });
      else if (SHP_FAMILY[g.type] && !isEmptyGeometry(g)) out.push(g);
    };
    const items = feats.map(function (f) {
      const parts = [];
      const g = f && f.geometry;
      explode(g, parts);
      if (g && g.type === 'GeometryCollection') collections++;
      parts.forEach(function (p) { present[SHP_FAMILY[p.type]] = true; });
      return { parts: parts, properties: (f && f.properties) || {} };
    });
    const order = ['point', 'line', 'polygon'].filter(function (k) { return present[k]; });
    if (!order.length) {
      order.push('point');
      if (feats.length) warnings.push('The layer has no geometries; the shapefile holds attribute records with empty shapes');
    }
    const multi = order.length > 1;
    const groups = order.map(function (fam) { return { family: fam, name: multi ? base + '_' + fam : base, records: [] }; });
    const byFamily = {};
    groups.forEach(function (g) { byFamily[g.family] = g; });
    let nulls = 0;
    items.forEach(function (it) {
      if (!it.parts.length) {
        nulls++;
        groups[0].records.push({ geometry: null, properties: it.properties });
        return;
      }
      const perFamily = {};
      it.parts.forEach(function (p) { (perFamily[SHP_FAMILY[p.type]] = perFamily[SHP_FAMILY[p.type]] || []).push(p); });
      Object.keys(perFamily).forEach(function (fam) {
        byFamily[fam].records.push({ geometry: mergeFamilyParts(perFamily[fam]), properties: it.properties });
      });
    });
    if (multi) {
      warnings.push('The layer mixes geometry types, so it was written as ' + groups.length + ' shapefiles: ' +
        groups.map(function (g) { return g.name; }).join(', '));
      if (nulls && order.length) warnings.push(nulls + ' feature' + (nulls === 1 ? '' : 's') + ' without geometry went into ' + groups[0].name);
    }
    if (collections) warnings.push(collections + ' geometry collection' + (collections === 1 ? ' was' : 's were') + ' split by geometry type');
    return groups;
  }

  function nullShape() {
    return { bytes: new Uint8Array(4), bbox: null, zr: null }; // shape type 0
  }

  /** Encode one shape record's content (shape type + geometry). */
  function encodeShapeRecord(g, type) {
    if (!g) return nullShape();
    const hasZ = type > 10;
    const base = hasZ ? type - 10 : type;
    const zOf = function (p) { return p.length > 2 && typeof p[2] === 'number' && isFinite(p[2]) ? p[2] : 0; };
    let parts;
    if (base === 1) {
      const p = g.type === 'Point' ? g.coordinates : g.coordinates && g.coordinates[0];
      if (!isPos(p)) return nullShape();
      const dv = new DataView(new ArrayBuffer(hasZ ? 28 : 20));
      dv.setInt32(0, type, true);
      dv.setFloat64(4, p[0], true);
      dv.setFloat64(12, p[1], true);
      if (hasZ) dv.setFloat64(20, zOf(p), true);
      return { bytes: new Uint8Array(dv.buffer), bbox: [p[0], p[1], p[0], p[1]], zr: hasZ ? [zOf(p), zOf(p)] : null };
    }
    if (base === 8) {
      parts = [(g.type === 'Point' ? [g.coordinates] : g.coordinates || []).filter(isPos)];
      if (!parts[0].length) return nullShape();
    } else if (base === 3) {
      const lines = g.type === 'LineString' ? [g.coordinates || []] : g.coordinates || [];
      parts = lines.map(function (l) { return (l || []).filter(isPos); }).filter(function (l) { return l.length >= 2; });
    } else {
      const polys = g.type === 'Polygon' ? [g.coordinates || []] : g.coordinates || [];
      parts = [];
      polys.forEach(function (poly) {
        const rings = (poly || []).map(closedRing);
        if (!rings.length || rings[0].length < 4) return; // degenerate outer ring: skip the polygon
        rings.forEach(function (r, i) {
          if (r.length < 4) return;
          const area = ringSignedArea(r);
          // Shapefile rings: outer clockwise (area < 0), holes counter-clockwise (area > 0).
          const reverse = i === 0 ? area > 0 : area < 0;
          parts.push(reverse ? r.slice().reverse() : r);
        });
      });
    }
    if (!parts.length) return nullShape();

    let nPts = 0;
    const bb = [Infinity, Infinity, -Infinity, -Infinity];
    const zr = [Infinity, -Infinity];
    parts.forEach(function (part) {
      nPts += part.length;
      part.forEach(function (p) {
        if (p[0] < bb[0]) bb[0] = p[0];
        if (p[1] < bb[1]) bb[1] = p[1];
        if (p[0] > bb[2]) bb[2] = p[0];
        if (p[1] > bb[3]) bb[3] = p[1];
        const z = zOf(p);
        if (z < zr[0]) zr[0] = z;
        if (z > zr[1]) zr[1] = z;
      });
    });
    const multipoint = base === 8;
    const partsBytes = multipoint ? 0 : 4 + 4 * parts.length; // numParts + parts[] (multipoint has neither)
    const headBytes = 4 + 32 + partsBytes + 4; // type, box, [numParts, parts], numPoints
    const size = headBytes + 16 * nPts + (hasZ ? 16 + 8 * nPts : 0);
    const dv = new DataView(new ArrayBuffer(size));
    dv.setInt32(0, type, true);
    dv.setFloat64(4, bb[0], true);
    dv.setFloat64(12, bb[1], true);
    dv.setFloat64(20, bb[2], true);
    dv.setFloat64(28, bb[3], true);
    let o = 36;
    if (multipoint) {
      dv.setInt32(o, nPts, true);
      o += 4;
    } else {
      dv.setInt32(o, parts.length, true);
      dv.setInt32(o + 4, nPts, true);
      o += 8;
      let start = 0;
      parts.forEach(function (part) { dv.setInt32(o, start, true); o += 4; start += part.length; });
    }
    parts.forEach(function (part) {
      part.forEach(function (p) { dv.setFloat64(o, p[0], true); dv.setFloat64(o + 8, p[1], true); o += 16; });
    });
    if (hasZ) {
      dv.setFloat64(o, zr[0], true);
      dv.setFloat64(o + 8, zr[1], true);
      o += 16;
      parts.forEach(function (part) { part.forEach(function (p) { dv.setFloat64(o, zOf(p), true); o += 8; }); });
    }
    return { bytes: new Uint8Array(dv.buffer), bbox: bb, zr: hasZ ? zr : null };
  }

  function writeShpHeader(u8, byteLength, type, bb, zr) {
    const dv = new DataView(u8.buffer, u8.byteOffset, 100);
    dv.setInt32(0, 9994, false);
    dv.setInt32(24, byteLength / 2, false);
    dv.setInt32(28, 1000, true);
    dv.setInt32(32, type, true);
    dv.setFloat64(36, bb[0], true);
    dv.setFloat64(44, bb[1], true);
    dv.setFloat64(52, bb[2], true);
    dv.setFloat64(60, bb[3], true);
    dv.setFloat64(68, zr[0], true);
    dv.setFloat64(76, zr[1], true);
  }

  /** Build .shp and .shx bytes for a group of records. */
  function encodeShapes(group) {
    const recs = group.records;
    let type;
    if (group.family === 'point') type = recs.some(function (r) { return r.geometry && r.geometry.type === 'MultiPoint'; }) ? 8 : 1;
    else type = group.family === 'line' ? 3 : 5;
    if (recs.some(function (r) { return r.geometry && anyZ(r.geometry); })) type += 10;
    const encoded = recs.map(function (r) { return encodeShapeRecord(r.geometry, type); });
    let bb = null, zr = null;
    let shpLen = 100;
    encoded.forEach(function (e) {
      shpLen += 8 + e.bytes.length;
      if (e.bbox) bb = bb ? [Math.min(bb[0], e.bbox[0]), Math.min(bb[1], e.bbox[1]), Math.max(bb[2], e.bbox[2]), Math.max(bb[3], e.bbox[3])] : e.bbox.slice();
      if (e.zr) zr = zr ? [Math.min(zr[0], e.zr[0]), Math.max(zr[1], e.zr[1])] : e.zr.slice();
    });
    bb = bb || [0, 0, 0, 0];
    zr = zr || [0, 0];
    const shxLen = 100 + 8 * encoded.length;
    const shp = new Uint8Array(shpLen);
    const shx = new Uint8Array(shxLen);
    writeShpHeader(shp, shpLen, type, bb, zr);
    writeShpHeader(shx, shxLen, type, bb, zr);
    const sdv = new DataView(shp.buffer);
    const xdv = new DataView(shx.buffer);
    let off = 100;
    encoded.forEach(function (e, i) {
      sdv.setInt32(off, i + 1, false);
      sdv.setInt32(off + 4, e.bytes.length / 2, false);
      shp.set(e.bytes, off + 8);
      xdv.setInt32(100 + 8 * i, off / 2, false);
      xdv.setInt32(104 + 8 * i, e.bytes.length / 2, false);
      off += 8 + e.bytes.length;
    });
    return { shp: shp, shx: shx, type: type };
  }

  /** dBASE field name: <= 10 ASCII letters/digits/underscores, starting with a letter, unique. */
  function dbfFieldName(name, taken) {
    let s = String(name === null || name === undefined ? '' : name).normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
      .split(/[^A-Za-z0-9_]+/).filter(Boolean).join('_');
    if (!s) s = 'field';
    if (!/^[A-Za-z]/.test(s)) s = 'F' + s;
    const used = new Set(taken.map(function (t) { return t.toLowerCase(); }));
    let cand = s.slice(0, 10);
    for (let i = 1; used.has(cand.toLowerCase()); i++) {
      const suffix = '_' + i;
      cand = s.slice(0, 10 - suffix.length) + suffix;
    }
    return cand;
  }

  /** Digits before / after the decimal point in the shortest representation of |v|. */
  function numberShape(v) {
    const s = String(Math.abs(v));
    const e = s.indexOf('e');
    if (e < 0) {
      const dot = s.indexOf('.');
      return dot < 0 ? { int: s.length, dec: 0 } : { int: dot, dec: s.length - dot - 1 };
    }
    const mant = s.slice(0, e), exp = +s.slice(e + 1);
    const mdec = mant.indexOf('.') < 0 ? 0 : mant.length - mant.indexOf('.') - 1;
    return exp >= 0 ? { int: 1 + exp, dec: Math.max(0, mdec - exp) } : { int: 1, dec: mdec - exp };
  }

  /** Work out the dBASE schema for a FeatureCollection. */
  function dbfSchema(fc, warnings) {
    const feats = featuresOf(fc);
    const taken = [];
    const renames = [];
    const valuesOf = function (key, fn) {
      for (let i = 0; i < feats.length; i++) {
        const p = feats[i] && feats[i].properties;
        if (p) fn(p[key]);
      }
    };
    const fields = util.inferFields(fc).map(function (f) {
      const name = dbfFieldName(f.name, taken);
      taken.push(name);
      if (name !== f.name) renames.push('"' + f.name + '" → "' + name + '"');
      const def = { src: f.name, name: name, type: 'C', length: 1, decimals: 0 };
      if (f.type === 'number') {
        let allInt = true, maxInt = 1, maxDec = 0, neg = false;
        valuesOf(f.name, function (v) {
          if (typeof v !== 'number' || !isFinite(v)) return;
          if (v < 0) neg = true;
          if (!Number.isInteger(v)) allInt = false;
          const sh = numberShape(v);
          if (sh.int > maxInt) maxInt = sh.int;
          if (sh.dec > maxDec) maxDec = sh.dec;
        });
        const intWidth = maxInt + (neg ? 1 : 0);
        def.type = 'N';
        if (allInt && intWidth <= 18) {
          def.length = 18;
        } else {
          let dec = Math.min(15, maxDec);
          if (intWidth + (dec ? dec + 1 : 0) > 24) dec = Math.max(0, 24 - intWidth - 1);
          def.decimals = dec;
          def.length = Math.max(1, Math.min(24, intWidth + (dec ? dec + 1 : 0)));
        }
      } else if (f.type === 'boolean') {
        def.type = 'L';
        def.length = 1;
      } else if (f.type === 'date') {
        def.type = 'D';
        def.length = 8;
        let timed = false;
        valuesOf(f.name, function (v) { if (!timed && typeof v === 'string' && /^\d{4}-\d{2}-\d{2}[T ]\d/.test(v)) timed = true; });
        if (timed) warnings.push('Field "' + f.name + '": shapefile dates hold only the day, so times were dropped');
      } else {
        let max = 1, truncated = 0;
        valuesOf(f.name, function (v) {
          const len = utf8Length(valueToText(v));
          if (len > 254) truncated++;
          if (len > max) max = Math.min(254, len);
        });
        def.length = max;
        if (truncated) warnings.push(truncated + ' value' + (truncated === 1 ? '' : 's') + ' of "' + f.name + '" were longer than 254 bytes and were cut short');
      }
      return def;
    });
    if (renames.length) {
      warnings.push('Shapefile field names are limited to 10 letters, digits or underscores, so some were renamed: ' + renames.join(', '));
    }
    if (!fields.length) fields.push({ src: null, name: 'FID', type: 'N', length: 10, decimals: 0, autoId: true });
    const recordLength = 1 + fields.reduce(function (s, f) { return s + f.length; }, 0);
    if (recordLength > 65535) {
      throw new Error('This layer has too many or too wide attributes for a shapefile (' + recordLength +
        ' bytes per record; the limit is 65,535). Export it as a GeoPackage instead.');
    }
    if (fields.length > 255) warnings.push('Shapefiles with more than 255 attributes may not open in all programs');
    return fields;
  }

  function dbfNumber(v, f) {
    const n = typeof v === 'number' ? v : typeof v === 'boolean' ? +v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
    if (!isFinite(n)) return '';
    let s = f.decimals > 0 ? n.toFixed(f.decimals) : Number.isInteger(n) ? numStr(n) : n.toFixed(0);
    if (s.length > f.length) s = n.toExponential(Math.max(0, f.length - 8));
    if (s.length > f.length) s = '*'.repeat(f.length); // does not fit: stored as null
    return s;
  }

  // "00000000" is shapelib's null date; every GDAL version reads it as null (blanks are not always).
  const DBF_NULL_DATE = '00000000';

  function dbfDate(v) {
    if (v instanceof Date) {
      if (isNaN(v.getTime())) return DBF_NULL_DATE;
      return v.toISOString().slice(0, 10).replace(/-/g, '');
    }
    if (typeof v !== 'string') return DBF_NULL_DATE;
    const s = v.trim();
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
    if (m) return m[1] + m[2] + m[3];
    return /^\d{8}$/.test(s) ? s : DBF_NULL_DATE;
  }

  function utf8Truncate(str, maxBytes) {
    const b = utf8Encode(str);
    if (b.length <= maxBytes) return b;
    let end = maxBytes;
    while (end > 0 && (b[end] & 0xc0) === 0x80) end--; // do not cut a character in half
    return b.subarray(0, end);
  }

  /** Encode a dBASE III table (UTF-8 text, described by the .cpg file). */
  function encodeDbf(records, fields) {
    const n = records.length;
    const headerLength = 32 + 32 * fields.length + 1;
    const recordLength = 1 + fields.reduce(function (s, f) { return s + f.length; }, 0);
    const out = new Uint8Array(headerLength + recordLength * n + 1);
    const dv = new DataView(out.buffer);
    const now = new Date();
    out[0] = 0x03;
    out[1] = now.getUTCFullYear() - 1900;
    out[2] = now.getUTCMonth() + 1;
    out[3] = now.getUTCDate();
    dv.setUint32(4, n, true);
    dv.setUint16(8, headerLength, true);
    dv.setUint16(10, recordLength, true);
    fields.forEach(function (f, i) {
      const o = 32 + 32 * i;
      for (let k = 0; k < f.name.length && k < 10; k++) out[o + k] = f.name.charCodeAt(k);
      out[o + 11] = f.type.charCodeAt(0);
      out[o + 16] = f.length;
      out[o + 17] = f.decimals;
    });
    out[headerLength - 1] = 0x0d;
    out.fill(0x20, headerLength, headerLength + recordLength * n);
    let pos = headerLength;
    records.forEach(function (props, r) {
      let at = pos + 1; // byte 0 of each record is the deletion flag (space = active)
      fields.forEach(function (f) {
        const v = f.autoId ? r + 1 : props ? props[f.src] : null;
        if (f.type === 'N') {
          const s = dbfNumber(v, f);
          for (let k = 0; k < s.length; k++) out[at + f.length - s.length + k] = s.charCodeAt(k);
        } else if (f.type === 'L') {
          let c = 0x3f; // '?' = unknown
          if (v === true || (typeof v === 'string' && /^(true|t|yes|y)$/i.test(v)) || v === 1) c = 0x54;
          else if (v === false || (typeof v === 'string' && /^(false|f|no|n)$/i.test(v)) || v === 0) c = 0x46;
          out[at] = c;
        } else if (f.type === 'D') {
          const s = dbfDate(v);
          for (let k = 0; k < s.length; k++) out[at + k] = s.charCodeAt(k);
        } else {
          out.set(utf8Truncate(valueToText(v), f.length), at);
        }
        at += f.length;
      });
      pos += recordLength;
    });
    out[pos] = 0x1a;
    return out;
  }

  async function shapefileWrite(fc, opts) {
    opts = opts || {};
    const Zip = lib('JSZip', 'The zip library (JSZip)');
    const warnings = [];
    const feats = featuresOf(fc);
    const base = fileBaseName(opts.name || 'layer');
    const prj = opts.prjWKT || M.crs.WKT_4326;
    const fields = dbfSchema({ type: 'FeatureCollection', features: feats }, warnings);
    const groups = shapefileGroups(feats, base, warnings);
    const zip = new Zip();
    groups.forEach(function (g) {
      const enc = encodeShapes(g);
      zip.file(g.name + '.shp', enc.shp);
      zip.file(g.name + '.shx', enc.shx);
      zip.file(g.name + '.dbf', encodeDbf(g.records.map(function (r) { return r.properties; }), fields));
      zip.file(g.name + '.prj', prj);
      zip.file(g.name + '.cpg', 'UTF-8');
    });
    const bytes = await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE', compressionOptions: { level: 6 } });
    return { bytes: bytes, warnings: warnings };
  }

  /* ========================================================== KML / GPX */

  const NAME_FIELDS = ['name', 'title', 'label'];
  const DESC_FIELDS = ['description', 'desc', 'descr'];

  // Used when colors.js is not loaded (it knows every CSS name).
  const BASIC_COLORS = {
    black: '000000', white: 'ffffff', red: 'ff0000', green: '008000', blue: '0000ff', yellow: 'ffff00',
    orange: 'ffa500', purple: '800080', gray: '808080', grey: '808080', cyan: '00ffff', magenta: 'ff00ff',
    brown: 'a52a2a', pink: 'ffc0cb', lime: '00ff00', navy: '000080', teal: '008080', maroon: '800000',
    olive: '808000', silver: 'c0c0c0', aqua: '00ffff', fuchsia: 'ff00ff',
  };

  /** Colour -> [r, g, b, a] (0-255, alpha 0-1), or null. */
  function parseColor(c) {
    if (c === null || c === undefined || c === '') return null;
    if (M.colors && typeof M.colors.parse === 'function') {
      const r = M.colors.parse(c);
      if (r) return r;
    }
    const str = String(c).trim().toLowerCase();
    const rgb = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+))?\s*\)$/.exec(str);
    if (rgb) return [+rgb[1], +rgb[2], +rgb[3], rgb[4] === undefined ? 1 : +rgb[4]];
    const m = /^#?([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/.exec(BASIC_COLORS[str] || str);
    if (!m) return null;
    let h = m[1];
    if (h.length === 3) h = h.replace(/./g, '$&$&');
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16), h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1];
  }

  function hex2(n) {
    const v = Math.max(0, Math.min(255, Math.round(n)));
    return (v < 16 ? '0' : '') + v.toString(16);
  }

  /** KML colour: aabbggrr. */
  function kmlColor(rgba, alpha) { return hex2(alpha * 255) + hex2(rgba[2]) + hex2(rgba[1]) + hex2(rgba[0]); }

  function kmlCoords(ps) {
    return ps.filter(isPos).map(function (p) {
      return decStr(p[0], 9) + ',' + decStr(p[1], 9) + (p.length > 2 && typeof p[2] === 'number' && isFinite(p[2]) ? ',' + decStr(p[2], 3) : '');
    }).join(' ');
  }

  function kmlGeometry(g, ind) {
    if (!g) return '';
    const c = g.coordinates;
    const polygon = function (rings, pad) {
      const rs = (rings || []).map(closedRing).filter(function (r) { return r.length >= 4; });
      if (!rs.length) return '';
      let s = pad + '<Polygon><tessellate>1</tessellate><outerBoundaryIs><LinearRing><coordinates>' + kmlCoords(rs[0]) +
        '</coordinates></LinearRing></outerBoundaryIs>';
      for (let i = 1; i < rs.length; i++) {
        s += '<innerBoundaryIs><LinearRing><coordinates>' + kmlCoords(rs[i]) + '</coordinates></LinearRing></innerBoundaryIs>';
      }
      return s + '</Polygon>\n';
    };
    const multi = function (parts) {
      const inner = parts.join('');
      return inner ? ind + '<MultiGeometry>\n' + inner + ind + '</MultiGeometry>\n' : '';
    };
    switch (g.type) {
      case 'Point': return isPos(c) ? ind + '<Point><coordinates>' + kmlCoords([c]) + '</coordinates></Point>\n' : '';
      case 'LineString': {
        const s = kmlCoords(c || []);
        return s ? ind + '<LineString><tessellate>1</tessellate><coordinates>' + s + '</coordinates></LineString>\n' : '';
      }
      case 'Polygon': return polygon(c, ind);
      case 'MultiPoint': return multi((c || []).map(function (p) { return kmlGeometry({ type: 'Point', coordinates: p }, ind + '  '); }));
      case 'MultiLineString': return multi((c || []).map(function (l) { return kmlGeometry({ type: 'LineString', coordinates: l }, ind + '  '); }));
      case 'MultiPolygon': return multi((c || []).map(function (p) { return polygon(p, ind + '  '); }));
      case 'GeometryCollection': return multi((g.geometries || []).map(function (m) { return kmlGeometry(m, ind + '  '); }));
      default: return '';
    }
  }

  function kmlWrite(fc, opts) {
    opts = opts || {};
    const feats = featuresOf(fc);
    const names = fieldNamesOf({ features: feats });
    const nameField = opts.nameField !== undefined && opts.nameField !== null ? opts.nameField : pickField(names, NAME_FIELDS);
    const descField = opts.descriptionField !== undefined && opts.descriptionField !== null ? opts.descriptionField : pickField(names, DESC_FIELDS);
    let rgba = [51, 136, 255, 1];
    if (opts.color !== undefined && opts.color !== null && opts.color !== '') {
      rgba = parseColor(opts.color);
      if (!rgba) throw new Error('Unknown color "' + opts.color + '"');
    }
    const width = isFinite(opts.lineWidth) && opts.lineWidth !== null ? Math.max(0, +opts.lineWidth) : 2;
    const fillOpacity = isFinite(opts.fillOpacity) && opts.fillOpacity !== null ? Math.max(0, Math.min(1, +opts.fillOpacity)) : 0.4;
    const lineColor = kmlColor(rgba, rgba[3] === undefined ? 1 : rgba[3]);
    const out = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<kml xmlns="http://www.opengis.net/kml/2.2">',
      '<Document>',
      '  <name>' + xmlEscape(opts.name || 'PSICITS export') + '</name>',
      '  <Style id="psicits-style">',
      '    <IconStyle><color>' + lineColor + '</color><scale>1</scale></IconStyle>',
      '    <LineStyle><color>' + lineColor + '</color><width>' + decStr(width, 2) + '</width></LineStyle>',
      '    <PolyStyle><color>' + kmlColor(rgba, fillOpacity) + '</color><fill>1</fill><outline>1</outline></PolyStyle>',
      '  </Style>',
    ];
    feats.forEach(function (f) {
      const p = (f && f.properties) || {};
      const lines = ['  <Placemark>'];
      const nm = nameField ? p[nameField] : null;
      if (nm !== null && nm !== undefined && nm !== '') lines.push('    <name>' + xmlEscape(valueToText(nm)) + '</name>');
      const ds = descField ? p[descField] : null;
      if (ds !== null && ds !== undefined && ds !== '') lines.push('    <description>' + xmlEscape(valueToText(ds)) + '</description>');
      lines.push('    <styleUrl>#psicits-style</styleUrl>');
      const keys = Object.keys(p);
      if (keys.length) {
        lines.push('    <ExtendedData>');
        keys.forEach(function (k) {
          lines.push('      <Data name="' + xmlEscape(k) + '"><value>' + xmlEscape(valueToText(p[k])) + '</value></Data>');
        });
        lines.push('    </ExtendedData>');
      }
      const geom = kmlGeometry(f && f.geometry, '    ');
      if (geom) lines.push(geom.replace(/\n$/, ''));
      lines.push('  </Placemark>');
      out.push(lines.join('\n'));
    });
    out.push('</Document>', '</kml>');
    return out.join('\n') + '\n';
  }

  function gpxWrite(fc, opts) {
    opts = opts || {};
    const feats = featuresOf(fc);
    const names = fieldNamesOf({ features: feats });
    const nameField = opts.nameField !== undefined && opts.nameField !== null ? opts.nameField : pickField(names, NAME_FIELDS);
    const descField = pickField(names, DESC_FIELDS);
    const eleField = pickField(names, ['ele', 'elevation', 'alt', 'altitude']);
    const timeField = pickField(names, ['time', 'timestamp', 'datetime']);
    const wpts = [];
    const trks = [];
    const text = function (v) { return v === null || v === undefined || v === '' ? null : xmlEscape(valueToText(v)); };
    const latlon = function (p) { return 'lat="' + decStr(p[1], 9) + '" lon="' + decStr(p[0], 9) + '"'; };
    const zOf = function (p) { return p.length > 2 && typeof p[2] === 'number' && isFinite(p[2]) ? p[2] : null; };

    feats.forEach(function (f) {
      const p = (f && f.properties) || {};
      const name = nameField ? text(p[nameField]) : null;
      const desc = descField ? text(p[descField]) : null;
      const wpt = function (c) {
        if (!isPos(c)) return;
        let ele = zOf(c);
        if (ele === null && eleField && typeof p[eleField] === 'number' && isFinite(p[eleField])) ele = p[eleField];
        let s = '  <wpt ' + latlon(c) + '>';
        if (ele !== null) s += '<ele>' + decStr(ele, 3) + '</ele>';
        if (timeField && p[timeField]) {
          const d = new Date(p[timeField]);
          if (!isNaN(d.getTime()) && /^\d{4}-\d{2}-\d{2}/.test(String(p[timeField]))) s += '<time>' + d.toISOString() + '</time>';
        }
        if (name !== null) s += '<name>' + name + '</name>';
        if (desc !== null) s += '<desc>' + desc + '</desc>';
        wpts.push(s + '</wpt>');
      };
      const trk = function (segments) {
        const segs = segments.map(function (seg) { return (seg || []).filter(isPos); }).filter(function (s) { return s.length; });
        if (!segs.length) return;
        let s = '  <trk>';
        if (name !== null) s += '<name>' + name + '</name>';
        if (desc !== null) s += '<desc>' + desc + '</desc>';
        segs.forEach(function (seg) {
          s += '\n    <trkseg>';
          seg.forEach(function (c) {
            const z = zOf(c);
            s += '\n      <trkpt ' + latlon(c) + (z === null ? '/>' : '><ele>' + decStr(z, 3) + '</ele></trkpt>');
          });
          s += '\n    </trkseg>';
        });
        trks.push(s + '\n  </trk>');
      };
      const visit = function (g) {
        if (!g) return;
        const c = g.coordinates;
        switch (g.type) {
          case 'Point': wpt(c); break;
          case 'MultiPoint': (c || []).forEach(wpt); break;
          case 'LineString': trk([c]); break;
          case 'MultiLineString': trk(c || []); break;
          case 'Polygon': trk([(c || [])[0]]); break;
          case 'MultiPolygon': trk((c || []).map(function (poly) { return (poly || [])[0]; })); break;
          case 'GeometryCollection': (g.geometries || []).forEach(visit); break;
          default: break;
        }
      };
      visit(f && f.geometry);
    });

    const out = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<gpx version="1.1" creator="PSICITS" xmlns="http://www.topografix.com/GPX/1/1" ' +
        'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" ' +
        'xsi:schemaLocation="http://www.topografix.com/GPX/1/1 http://www.topografix.com/GPX/1/1/gpx.xsd">',
    ];
    if (opts.name) out.push('  <metadata><name>' + xmlEscape(opts.name) + '</name></metadata>');
    // GPX 1.1 requires every wpt before any trk.
    return out.concat(wpts, trks, ['</gpx>']).join('\n') + '\n';
  }

  /* ================================================================ CSV */

  const DELIMITER_ALIASES = { tab: '\t', '\\t': '\t', comma: ',', semicolon: ';', pipe: '|', space: ' ' };

  function normalizeDelimiter(d) {
    if (d === null || d === undefined || d === '') return '';
    const k = String(d).toLowerCase();
    return DELIMITER_ALIASES[k] !== undefined ? DELIMITER_ALIASES[k] : String(d);
  }

  const NUMERIC_TEXT = /^[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?$/;

  /** Is this text a number we can safely convert (not a code such as "00123" or a 20-digit id)? */
  function isSafeNumericText(t) {
    if (!NUMERIC_TEXT.test(t)) return false;
    if (/^[-+]?0\d/.test(t)) return false; // leading-zero code (ZIP, FIPS, ...)
    const digits = t.replace(/^[-+]/, '').replace(/[eE].*$/, '');
    if (digits.indexOf('.') < 0 && digits.replace(/^0+/, '').length > 15) return false; // would lose precision
    return true;
  }

  function csvParse(input, opts) {
    opts = opts || {};
    const Papa = lib('Papa', 'The CSV library (PapaParse)');
    let text = typeof input === 'string' ? input : decodeText(toBytes(input, 'The CSV file'));
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    const res = Papa.parse(text, {
      header: false,
      skipEmptyLines: 'greedy',
      dynamicTyping: false,
      delimiter: normalizeDelimiter(opts.delimiter),
      delimitersToGuess: [',', '\t', ';', '|'],
    });
    const data = res.data || [];
    if (!data.length) return [];
    const header = data[0].map(function (h) { return String(h === null || h === undefined ? '' : h).trim(); });
    let width = header.length;
    for (let r = 1; r < data.length; r++) {
      const row = data[r];
      for (let c = row.length - 1; c >= width; c--) {
        if (String(row[c]).trim() !== '') { width = c + 1; break; }
      }
    }
    const names = [];
    for (let c = 0; c < width; c++) {
      const h = c < header.length && header[c] ? safeKey(header[c]) : 'field_' + (c + 1);
      const n = util.uniqueName(h, names);
      names.push(n);
    }
    const rows = [];
    for (let r = 1; r < data.length; r++) {
      const row = data[r];
      const o = {};
      for (let c = 0; c < width; c++) {
        const v = row[c];
        o[names[c]] = v === undefined || v === null || String(v).trim() === '' ? null : v;
      }
      rows.push(o);
    }
    // Per-column type inference.
    names.forEach(function (name) {
      let numeric = true, bool = true, any = false;
      for (let r = 0; r < rows.length && (numeric || bool); r++) {
        const v = rows[r][name];
        if (v === null) continue;
        const t = v.trim();
        any = true;
        if (numeric && !isSafeNumericText(t)) numeric = false;
        if (bool && !/^(true|false)$/i.test(t)) bool = false;
      }
      if (!any || (!numeric && !bool)) return;
      rows.forEach(function (row) {
        const v = row[name];
        if (v === null) return;
        row[name] = numeric ? Number(v.trim()) : /^true$/i.test(v.trim());
      });
    });
    return rows;
  }

  const LAT_GEO = ['latitude', 'lat', 'lat_dd', 'latitude_dd', 'lat_deg', 'y_lat'];
  const LON_GEO = ['longitude', 'lon', 'lng', 'long', 'lon_dd', 'long_dd', 'longitude_dd', 'lng_dd', 'lon_deg', 'x_lon'];
  const LAT_GENERIC = ['y', 'point_y', 'ycoord', 'y_coord', 'y_coordinate', 'coord_y', 'northing'];
  const LON_GENERIC = ['x', 'point_x', 'xcoord', 'x_coord', 'x_coordinate', 'coord_x', 'easting'];
  const WKT_FIELDS = ['wkt', 'geometry', 'geom', 'the_geom', 'shape', 'location', 'wkt_geom', 'geometry_wkt', 'geom_wkt', 'st_astext'];
  const LOCATION_FIELDS = ['location', 'latlon', 'lat_lon', 'lat_long', 'latlng', 'lat_lng', 'coordinates', 'coords', 'point',
    'geolocation', 'geo_location', 'position'];
  const WKT_START = /^\s*(?:SRID=\d+\s*;\s*)?(?:POINT|LINESTRING|POLYGON|MULTIPOINT|MULTILINESTRING|MULTIPOLYGON|GEOMETRYCOLLECTION)(?:\s*Z|\s*M|\s*ZM)?\s*(?:\(|EMPTY)/i;
  const HEX_WKB = /^(?:00|01)[0-9a-fA-F]{8,}$/;
  const LATLON_PAREN = /\(\s*([-+]?\d+(?:\.\d+)?)\s*,\s*([-+]?\d+(?:\.\d+)?)\s*\)\s*$/;
  const LATLON_BARE = /^\s*([-+]?\d+(?:\.\d+)?)\s*[,;]\s*([-+]?\d+(?:\.\d+)?)\s*$/;

  function normField(name) { return String(name).trim().toLowerCase().replace(/[\s\-.]+/g, '_'); }

  function findByNames(fields, candidates) {
    const map = new Map();
    fields.forEach(function (f) { const k = normField(f); if (!map.has(k)) map.set(k, f); });
    for (let i = 0; i < candidates.length; i++) if (map.has(candidates[i])) return map.get(candidates[i]);
    return null;
  }

  function findField(fields, name) {
    if (name === null || name === undefined) return null;
    const exact = fields.find(function (f) { return f === name; });
    if (exact !== undefined) return exact;
    const lower = String(name).toLowerCase();
    const ci = fields.find(function (f) { return String(f).toLowerCase() === lower; });
    return ci !== undefined ? ci : null;
  }

  /** Parse a coordinate value: number, "41.8", "41,8" (decimal comma) or "87.6 W". */
  function coordNumber(v) {
    if (typeof v === 'number') return isFinite(v) ? v : NaN;
    if (v === null || v === undefined) return NaN;
    let s = String(v).trim();
    if (!s) return NaN;
    if (/^[-+]?\d+,\d+$/.test(s)) s = s.replace(',', '.');
    const hemi = /^([-+]?\d+(?:\.\d+)?)\s*\u00b0?\s*([NSEW])$/i.exec(s);
    if (hemi) return /[SW]/i.test(hemi[2]) ? -Math.abs(+hemi[1]) : +hemi[1];
    if (!NUMERIC_TEXT.test(s)) return NaN;
    return +s;
  }

  /** Parse a geometry cell: WKT/EWKT, hex (E)WKB or a GeoJSON geometry object. */
  function parseGeometryText(v) {
    if (v === null || v === undefined) return null;
    if (typeof v === 'object' && v.type && (v.coordinates || v.geometries)) return v;
    const s = String(v).trim();
    if (!s) return null;
    if (HEX_WKB.test(s) && s.length % 2 === 0) return parseWkb(hexToBytes(s)).geometry;
    if (s[0] === '{') {
      const g = JSON.parse(s);
      if (g && g.type === 'Feature') return g.geometry;
      if (g && typeof g.type === 'string' && (g.coordinates || g.geometries)) return g;
      throw new Error('not a GeoJSON geometry');
    }
    return parseWkt(s);
  }

  function looksLikeGeometryText(v) {
    if (v === null || v === undefined) return false;
    const s = String(v).trim();
    return WKT_START.test(s) || (HEX_WKB.test(s) && s.length % 2 === 0) ||
      (s[0] === '{' && /"type"\s*:/.test(s) && /"coordinates"|"geometries"/.test(s));
  }

  function sampleValues(rows, field, max) {
    const out = [];
    for (let i = 0; i < rows.length && out.length < max; i++) {
      const v = rows[i][field];
      if (v !== null && v !== undefined && String(v).trim() !== '') out.push(v);
    }
    return out;
  }

  function mostly(values, test) {
    if (!values.length) return false;
    let ok = 0;
    values.forEach(function (v) { if (test(v)) ok++; });
    return ok >= Math.max(1, Math.ceil(values.length * 0.6));
  }

  function latLonFromString(v, loose) {
    if (v === null || v === undefined) return null;
    const s = String(v);
    const m = LATLON_PAREN.exec(s) || (loose ? LATLON_BARE.exec(s) : null);
    if (!m) return null;
    const lat = +m[1], lon = +m[2];
    if (!(Math.abs(lat) <= 90 && Math.abs(lon) <= 180)) return null;
    return [lon, lat];
  }

  function csvToFeatureCollection(rows, opts) {
    opts = opts || {};
    rows = Array.isArray(rows) ? rows : [];
    const fields = [];
    const seen = new Set();
    rows.slice(0, 50).forEach(function (r) {
      Object.keys(r || {}).forEach(function (k) { if (!seen.has(k)) { seen.add(k); fields.push(k); } });
    });
    const available = function () { return fields.length ? ' Available columns: ' + fields.join(', ') : ''; };
    let mode = 'none', xField = null, yField = null, wktField = null, loose = false;

    if (opts.wkt) {
      wktField = findField(fields, opts.wkt);
      if (!wktField) throw new Error('Column "' + opts.wkt + '" was not found.' + available());
      mode = 'wkt';
    } else if (opts.x || opts.y) {
      if (!opts.x || !opts.y) throw new Error('Give both an x (longitude) and a y (latitude) column');
      xField = findField(fields, opts.x);
      yField = findField(fields, opts.y);
      if (!xField) throw new Error('Column "' + opts.x + '" was not found.' + available());
      if (!yField) throw new Error('Column "' + opts.y + '" was not found.' + available());
      mode = 'xy';
    } else {
      const numericPair = function (xf, yf) {
        if (!xf || !yf || xf === yf) return false;
        for (let i = 0; i < rows.length && i < 2000; i++) {
          if (isFinite(coordNumber(rows[i][xf])) && isFinite(coordNumber(rows[i][yf]))) return true;
        }
        return false;
      };
      const wktNamed = WKT_FIELDS.map(function (n) { return findByNames(fields, [n]); }).filter(Boolean);
      const wktHit = wktNamed.find(function (f) { return mostly(sampleValues(rows, f, 5), looksLikeGeometryText); });
      const geoX = findByNames(fields, LON_GEO), geoY = findByNames(fields, LAT_GEO);
      const genX = findByNames(fields, LON_GENERIC), genY = findByNames(fields, LAT_GENERIC);
      const locNamed = LOCATION_FIELDS.map(function (n) { return findByNames(fields, [n]); }).filter(Boolean);
      if (wktHit) { mode = 'wkt'; wktField = wktHit; }
      else if (numericPair(geoX, geoY)) { mode = 'xy'; xField = geoX; yField = geoY; }
      else {
        let loc = locNamed.find(function (f) { return mostly(sampleValues(rows, f, 5), function (v) { return !!latLonFromString(v, true); }); });
        if (loc) loose = true;
        else {
          loc = fields.find(function (f) { return mostly(sampleValues(rows, f, 5), function (v) { return !!latLonFromString(v, false); }); });
        }
        if (loc) { mode = 'latlon-string'; xField = loc; yField = loc; }
        else if (numericPair(genX, genY)) { mode = 'xy'; xField = genX; yField = genY; }
        else {
          const anyWkt = fields.find(function (f) { return mostly(sampleValues(rows, f, 5), looksLikeGeometryText); });
          if (anyWkt) { mode = 'wkt'; wktField = anyWkt; }
        }
      }
    }

    const result = { fc: null, mode: mode, xField: xField, yField: yField, wktField: wktField, skipped: 0, needsCrs: false, rawBBox: null };
    const features = [];
    if (mode === 'none') {
      rows.forEach(function (r) { features.push({ type: 'Feature', geometry: null, properties: Object.assign({}, r) }); });
      result.fc = { type: 'FeatureCollection', features: features };
      return result;
    }

    let skipped = 0;
    rows.forEach(function (r) {
      if (!r) return;
      let geometry = null;
      if (mode === 'xy') {
        const x = coordNumber(r[xField]), y = coordNumber(r[yField]);
        if (isFinite(x) && isFinite(y)) geometry = { type: 'Point', coordinates: [x, y] };
      } else if (mode === 'latlon-string') {
        const p = latLonFromString(r[xField], loose);
        if (p) geometry = { type: 'Point', coordinates: p };
      } else {
        try { geometry = parseGeometryText(r[wktField]); } catch (e) { geometry = null; }
        if (geometry && isEmptyGeometry(geometry)) geometry = null;
      }
      if (!geometry) { skipped++; return; }
      const properties = Object.assign({}, r);
      if (mode === 'wkt') delete properties[wktField];
      features.push({ type: 'Feature', geometry: geometry, properties: properties });
    });
    result.skipped = skipped;
    const fc = { type: 'FeatureCollection', features: features };
    result.rawBBox = util.bbox(fc);

    const C = M.crs;
    const from = opts.crs ? C.normalize(opts.crs) : null;
    if (from && from !== 'EPSG:4326') {
      let t;
      try { t = C.transformer(from, 'EPSG:4326'); } catch (e) { throw new Error('Unknown coordinate system "' + opts.crs + '"'); }
      result.fc = {
        type: 'FeatureCollection',
        features: features.map(function (f) { return { type: 'Feature', geometry: util.mapCoords(f.geometry, t), properties: f.properties }; }),
      };
      result.crs = from;
      return result;
    }
    if (!from && result.rawBBox && !C.looksGeographic(result.rawBBox)) {
      result.needsCrs = true;
      return result;
    }
    result.fc = fc;
    return result;
  }

  function csvCell(s, delim) {
    if (s === '') return '';
    if (s.indexOf('"') >= 0 || s.indexOf(delim) >= 0 || /[\r\n]/.test(s) || /^\s|\s$/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
    return s;
  }

  function csvWrite(fc, opts) {
    opts = opts || {};
    const feats = featuresOf(fc);
    const delim = normalizeDelimiter(opts.delimiter) || ',';
    let mode = opts.geometry;
    if (!mode) {
      let any = false, allPoints = true;
      for (let i = 0; i < feats.length; i++) {
        const g = feats[i] && feats[i].geometry;
        if (!g) continue;
        any = true;
        if (g.type !== 'Point') { allPoints = false; break; }
      }
      mode = !any ? 'none' : allPoints ? 'xy' : 'wkt';
    }
    if (mode !== 'wkt' && mode !== 'xy' && mode !== 'none') throw new Error('Unknown CSV geometry option "' + mode + '" (use wkt, xy or none)');
    const fields = opts.fields
      ? opts.fields.map(function (f) { return typeof f === 'string' ? f : f.name; })
      : fieldNamesOf({ features: feats });
    const geomCols = [];
    let withZ = false;
    if (mode === 'wkt') geomCols.push(util.uniqueName('wkt', fields));
    else if (mode === 'xy') {
      feats.forEach(function (f) { if (!withZ && f && f.geometry && f.geometry.type === 'Point' && geometryHasZ(f.geometry)) withZ = true; });
      ['longitude', 'latitude'].concat(withZ ? ['z'] : []).forEach(function (n) { geomCols.push(util.uniqueName(n, fields.concat(geomCols))); });
    }
    const lines = [geomCols.concat(fields).map(function (h) { return csvCell(String(h), delim); }).join(delim)];
    feats.forEach(function (f) {
      const cells = [];
      const g = f && f.geometry;
      if (mode === 'wkt') cells.push(g && !isEmptyGeometry(g) ? stringifyWkt(g, { precision: opts.precision }) : '');
      else if (mode === 'xy') {
        let p = null;
        if (g && !isEmptyGeometry(g)) {
          if (g.type === 'Point') p = g.coordinates;
          else if (g.type === 'MultiPoint') p = g.coordinates.find(isPos);
          else { const b = util.bbox(g); p = [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2]; }
        }
        cells.push(p ? numStr(p[0]) : '', p ? numStr(p[1]) : '');
        if (withZ) cells.push(p && p.length > 2 && isFinite(p[2]) ? numStr(p[2]) : '');
      }
      const props = (f && f.properties) || {};
      fields.forEach(function (k) { cells.push(valueToText(props[k])); });
      lines.push(cells.map(function (c) { return csvCell(c, delim); }).join(delim));
    });
    return lines.join('\r\n') + '\r\n';
  }

  /* =============================================================== XLSX */

  const XML_NAMED_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

  function decodeEntities(s) {
    if (s.indexOf('&') < 0) return s;
    return s.replace(/&(#[xX][0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, function (m, e) {
      if (e[0] !== '#') return XML_NAMED_ENTITIES[e];
      const cp = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return cp >= 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : m;
    });
  }

  function localName(q) {
    const i = q.indexOf(':');
    return i >= 0 ? q.slice(i + 1) : q;
  }

  const ATTR_RE = /([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  const NO_ATTRS = Object.freeze({});

  function parseAttrs(s) {
    const out = {};
    ATTR_RE.lastIndex = 0;
    let m;
    while ((m = ATTR_RE.exec(s)) !== null) {
      const v = decodeEntities(m[2] !== undefined ? m[2] : m[3]);
      const ln = localName(m[1]);
      if (!(ln in out)) out[ln] = v;
      out[m[1]] = v;
    }
    return out;
  }

  /**
   * Tolerant streaming XML tokenizer. Calls h.open(localName, attrs, selfClosing),
   * h.close(localName) and h.text(decodedText) (only while h.wantText is true).
   * Namespace prefixes are stripped from element names ("x:row" -> "row").
   */
  function xmlScan(xml, h) {
    const n = xml.length;
    let i = 0;
    while (i < n) {
      const lt = xml.indexOf('<', i);
      if (lt < 0) {
        if (h.wantText && h.text) h.text(decodeEntities(xml.slice(i)));
        break;
      }
      if (lt > i && h.wantText && h.text) h.text(decodeEntities(xml.slice(i, lt)));
      const c1 = xml.charCodeAt(lt + 1);
      if (c1 === 33) { // '!'
        if (xml.startsWith('<!--', lt)) {
          const e = xml.indexOf('-->', lt + 4);
          i = e < 0 ? n : e + 3;
        } else if (xml.startsWith('<![CDATA[', lt)) {
          const e = xml.indexOf(']]>', lt + 9);
          if (h.wantText && h.text) h.text(xml.slice(lt + 9, e < 0 ? n : e));
          i = e < 0 ? n : e + 3;
        } else {
          const e = xml.indexOf('>', lt + 2);
          i = e < 0 ? n : e + 1;
        }
        continue;
      }
      if (c1 === 63) { // '?'
        const e = xml.indexOf('?>', lt + 2);
        i = e < 0 ? n : e + 2;
        continue;
      }
      let j = lt + 1, quote = 0;
      for (; j < n; j++) {
        const c = xml.charCodeAt(j);
        if (quote) { if (c === quote) quote = 0; }
        else if (c === 34 || c === 39) quote = c;
        else if (c === 62) break;
      }
      const body = xml.slice(lt + 1, j);
      i = j + 1;
      if (body.charCodeAt(0) === 47) { // '/'
        if (h.close) h.close(localName(body.slice(1).trim()));
        continue;
      }
      const selfClosing = body.charCodeAt(body.length - 1) === 47;
      const inner = selfClosing ? body.slice(0, -1) : body;
      let k = 0;
      while (k < inner.length) {
        const c = inner.charCodeAt(k);
        if (c === 32 || c === 9 || c === 10 || c === 13) break;
        k++;
      }
      const name = localName(inner.slice(0, k));
      if (!name) continue;
      if (h.open) h.open(name, k < inner.length ? parseAttrs(inner.slice(k)) : NO_ATTRS, selfClosing);
      if (selfClosing && h.close) h.close(name);
    }
  }

  function parseRels(xml) {
    const rels = {};
    if (!xml) return rels;
    xmlScan(xml, {
      open: function (name, a) {
        if (name === 'Relationship' && a.Id) rels[a.Id] = { target: a.Target || '', type: a.Type || '' };
      },
    });
    return rels;
  }

  function relOfType(rels, suffix) {
    const id = Object.keys(rels).find(function (k) { return rels[k].type.slice(-suffix.length) === suffix; });
    return id ? rels[id] : null;
  }

  function resolveZipPath(baseDir, target) {
    if (!target) return null;
    const t = String(target).replace(/\\/g, '/');
    if (t[0] === '/') return t.slice(1);
    const parts = baseDir.split('/').filter(Boolean).concat(t.split('/'));
    const out = [];
    parts.forEach(function (p) {
      if (p === '..') out.pop();
      else if (p && p !== '.') out.push(p);
    });
    return out.join('/');
  }

  function zipEntry(zip, path) {
    if (!path) return null;
    const direct = zip.file(path);
    if (direct) return direct;
    const lower = path.toLowerCase();
    let found = null;
    zip.forEach(function (p, f) { if (!found && !f.dir && p.toLowerCase() === lower) found = f; });
    return found;
  }

  async function zipText(zip, path) {
    const f = zipEntry(zip, path);
    return f ? f.async('string') : null;
  }

  function parseSharedStrings(xml) {
    const out = [];
    if (!xml) return out;
    let cur = null, phonetic = 0;
    const h = {
      wantText: false,
      open: function (name) {
        if (name === 'si') cur = '';
        else if (name === 'rPh') phonetic++;
        else if (name === 't' && cur !== null && !phonetic) h.wantText = true;
      },
      close: function (name) {
        if (name === 'si') { out.push(cur === null ? '' : cur); cur = null; }
        else if (name === 'rPh') phonetic--;
        else if (name === 't') h.wantText = false;
      },
      text: function (s) { cur += s; },
    };
    xmlScan(xml, h);
    return out;
  }

  /** 0 = not a date, 1 = date / date-time, 2 = time of day. */
  function classifyNumFmt(id, code) {
    if ((id >= 18 && id <= 21) || (id >= 45 && id <= 47)) return 2;
    if ((id >= 14 && id <= 17) || id === 22) return 1;
    if (code === undefined || code === null) return 0;
    const s = String(code).split(';')[0]
      .replace(/"[^"]*"/g, '')
      .replace(/\\./g, '')
      .replace(/[_*]./g, '')
      .replace(/\[(h+|m+|s+)\]/gi, '$1')
      .replace(/\[[^\]]*\]/g, '');
    const hasDate = /[dy]/i.test(s);
    const hasTime = /[hs]/i.test(s);
    if (!hasDate && !hasTime && !/m/i.test(s)) return 0;
    return !hasDate && hasTime ? 2 : 1;
  }

  function parseStyles(xml) {
    const custom = {};
    const xfFormats = [];
    if (xml) {
      let inCellXfs = false;
      xmlScan(xml, {
        open: function (name, a) {
          if (name === 'numFmt') custom[+a.numFmtId] = a.formatCode;
          else if (name === 'cellXfs') inCellXfs = true;
          else if (name === 'xf' && inCellXfs) xfFormats.push(a.numFmtId !== undefined ? +a.numFmtId : 0);
        },
        close: function (name) { if (name === 'cellXfs') inCellXfs = false; },
      });
    }
    return xfFormats.map(function (id) { return classifyNumFmt(id, custom[id]); });
  }

  function colIndex(letters) {
    let n = 0;
    for (let i = 0; i < letters.length; i++) n = n * 26 + (letters.charCodeAt(i) & 0x1f);
    return n - 1;
  }

  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  /** Excel serial date -> ISO string ("YYYY-MM-DD", "YYYY-MM-DDTHH:MM:SS" or "HH:MM:SS"). */
  function excelDate(serial, date1904, kind) {
    let days = Math.floor(serial);
    let ms = Math.round((serial - days) * 86400000);
    if (ms >= 86400000) { days += 1; ms -= 86400000; }
    if (kind === 2 && days === 0) {
      const secs = Math.round(ms / 1000);
      return pad2(Math.floor(secs / 3600)) + ':' + pad2(Math.floor(secs / 60) % 60) + ':' + pad2(secs % 60);
    }
    let base;
    if (date1904) base = Date.UTC(1904, 0, 1);
    else {
      if (days >= 60) days -= 1; // Excel's phantom 1900-02-29
      base = Date.UTC(1899, 11, 31);
    }
    const iso = new Date(base + days * 86400000 + ms).toISOString();
    if (ms === 0) return iso.slice(0, 10);
    return ms % 1000 ? iso.slice(0, 23) : iso.slice(0, 19);
  }

  function parseSheetGrid(xml, shared, dateStyles, date1904) {
    const grid = [];
    let rowIdx = -1, colIdx = -1, rowExplicit = false, rowStarted = false;
    let cell = null;
    let target = null; // 'v' | 'is'
    let phonetic = 0, inIs = false;
    const finish = function () {
      const c = cell;
      cell = null;
      let v;
      switch (c.t) {
        case 's': {
          const idx = parseInt(c.v, 10);
          v = isFinite(idx) && idx >= 0 && idx < shared.length ? shared[idx] : null;
          break;
        }
        case 'str': v = c.v; break;
        case 'inlineStr': v = c.is !== null ? c.is : c.v; break;
        case 'b': v = c.v === null ? null : c.v.trim() === '1' || /^true$/i.test(c.v.trim()); break;
        case 'e': v = null; break;
        case 'd': v = c.v === null ? null : c.v.trim(); break;
        default: {
          if (c.v === null || c.v.trim() === '') { v = null; break; }
          const num = Number(c.v);
          if (!isFinite(num)) { v = c.v; break; }
          const kind = dateStyles[c.s] || 0;
          v = kind ? excelDate(num, date1904, kind) : num;
        }
      }
      if (v === null || v === undefined || v === '') return;
      (grid[rowIdx] = grid[rowIdx] || [])[colIdx] = v;
    };
    const h = {
      wantText: false,
      open: function (name, a) {
        switch (name) {
          case 'row':
            rowExplicit = !!a.r && isFinite(parseInt(a.r, 10));
            rowIdx = rowExplicit ? parseInt(a.r, 10) - 1 : rowIdx + 1;
            rowStarted = true;
            colIdx = -1;
            break;
          case 'c': {
            const ref = a.r ? /^\$?([A-Za-z]+)\$?(\d+)?$/.exec(a.r) : null;
            if (ref) {
              colIdx = colIndex(ref[1].toUpperCase());
              // Rows without an r attribute: trust the cell reference's row number.
              if (ref[2] && !rowExplicit) { rowIdx = parseInt(ref[2], 10) - 1; rowExplicit = true; }
            } else colIdx += 1;
            if (!rowStarted && rowIdx < 0) rowIdx = 0;
            cell = { t: a.t || 'n', s: a.s ? parseInt(a.s, 10) : 0, v: null, is: null };
            break;
          }
          case 'v':
            if (cell) { cell.v = ''; target = 'v'; h.wantText = true; }
            break;
          case 'is':
            if (cell) { cell.is = ''; inIs = true; }
            break;
          case 'rPh':
            phonetic++;
            h.wantText = false;
            break;
          case 't':
            if (cell && inIs && !phonetic) { target = 'is'; h.wantText = true; }
            break;
          default: break;
        }
      },
      close: function (name) {
        switch (name) {
          case 'v': case 't': h.wantText = false; target = null; break;
          case 'is': inIs = false; break;
          case 'rPh': phonetic--; break;
          case 'c': if (cell) finish(); break;
          default: break;
        }
      },
      text: function (s) {
        if (!cell) return;
        if (target === 'v') cell.v += s;
        else if (target === 'is') cell.is += s;
      },
    };
    xmlScan(xml, h);
    return grid;
  }

  function gridToRows(grid) {
    const blank = function (v) { return v === undefined || v === null || v === ''; };
    let headerIdx = -1;
    for (let r = 0; r < grid.length; r++) {
      if (grid[r] && grid[r].some(function (v) { return !blank(v); })) { headerIdx = r; break; }
    }
    if (headerIdx < 0) return { columns: [], rows: [] };
    let maxCol = 0;
    for (let r = headerIdx; r < grid.length; r++) if (grid[r] && grid[r].length > maxCol) maxCol = grid[r].length;
    const used = new Array(maxCol).fill(false);
    for (let r = headerIdx; r < grid.length; r++) {
      const row = grid[r];
      if (!row) continue;
      for (let c = 0; c < row.length; c++) if (!blank(row[c])) used[c] = true;
    }
    const header = grid[headerIdx];
    const cols = [];
    const names = [];
    for (let c = 0; c < maxCol; c++) {
      if (!used[c]) continue;
      let h = header[c];
      h = blank(h) ? '' : safeKey(String(h).trim());
      const name = util.uniqueName(h || 'field_' + (c + 1), names);
      names.push(name);
      cols.push({ c: c, name: name });
    }
    const rows = [];
    for (let r = headerIdx + 1; r < grid.length; r++) {
      const row = grid[r];
      if (!row) continue;
      const o = {};
      let any = false;
      cols.forEach(function (col) {
        const v = row[col.c];
        const val = blank(v) ? null : v;
        if (val !== null) any = true;
        o[col.name] = val;
      });
      if (any) rows.push(o);
    }
    return { columns: names, rows: rows };
  }

  async function xlsxRead(bytes) {
    const Zip = lib('JSZip', 'The zip library (JSZip)');
    const u8 = toBytes(bytes, 'The spreadsheet');
    if (u8[0] === 0xd0 && u8[1] === 0xcf && u8[2] === 0x11 && u8[3] === 0xe0) {
      throw new Error('Old Excel (.xls) files are not supported. Save the sheet as .xlsx or CSV and try again.');
    }
    let zip;
    try { zip = await Zip.loadAsync(u8); } catch (e) { throw new Error('This file is not a valid Excel workbook (.xlsx)'); }
    let wbPath = 'xl/workbook.xml';
    const rootRels = parseRels(await zipText(zip, '_rels/.rels'));
    const office = relOfType(rootRels, '/officeDocument');
    if (office) wbPath = resolveZipPath('', office.target) || wbPath;
    const wbXml = await zipText(zip, wbPath);
    if (!wbXml) throw new Error('This file does not look like an Excel workbook (workbook.xml is missing)');
    const slash = wbPath.lastIndexOf('/');
    const wbDir = slash >= 0 ? wbPath.slice(0, slash + 1) : '';
    const rels = parseRels(await zipText(zip, wbDir + '_rels/' + wbPath.slice(slash + 1) + '.rels'));

    const sheets = [];
    let date1904 = false;
    xmlScan(wbXml, {
      open: function (name, a) {
        if (name === 'sheet') sheets.push({ name: a.name || 'Sheet' + (sheets.length + 1), rid: a['r:id'] || a.id });
        else if (name === 'workbookPr') date1904 = a.date1904 === '1' || /^true$/i.test(a.date1904 || '');
      },
    });
    const ssRel = relOfType(rels, '/sharedStrings');
    const stRel = relOfType(rels, '/styles');
    const shared = parseSharedStrings(await zipText(zip, ssRel ? resolveZipPath(wbDir, ssRel.target) : wbDir + 'sharedStrings.xml'));
    const dateStyles = parseStyles(await zipText(zip, stRel ? resolveZipPath(wbDir, stRel.target) : wbDir + 'styles.xml'));

    const out = [];
    for (let i = 0; i < sheets.length; i++) {
      const s = sheets[i];
      const rel = s.rid ? rels[s.rid] : null;
      if (rel && /\/(chartsheet|dialogsheet|macrosheet)$/.test(rel.type)) continue;
      const path = rel ? resolveZipPath(wbDir, rel.target) : wbDir + 'worksheets/sheet' + (i + 1) + '.xml';
      const xml = await zipText(zip, path);
      if (xml === null) continue;
      const table = gridToRows(parseSheetGrid(xml, shared, dateStyles, date1904));
      out.push({ name: s.name, rows: table.rows, columns: table.columns });
    }
    return out;
  }

  /* ============================================================ GeoTIFF */

  const TIFF_TYPES = {
    uint8: { bits: 8, format: 1, bytes: 1, Ctor: Uint8Array, set: 'setUint8' },
    int8: { bits: 8, format: 2, bytes: 1, Ctor: Int8Array, set: 'setInt8' },
    uint16: { bits: 16, format: 1, bytes: 2, Ctor: Uint16Array, set: 'setUint16' },
    int16: { bits: 16, format: 2, bytes: 2, Ctor: Int16Array, set: 'setInt16' },
    uint32: { bits: 32, format: 1, bytes: 4, Ctor: Uint32Array, set: 'setUint32' },
    int32: { bits: 32, format: 2, bytes: 4, Ctor: Int32Array, set: 'setInt32' },
    float32: { bits: 32, format: 3, bytes: 4, Ctor: Float32Array, set: 'setFloat32' },
    float64: { bits: 64, format: 3, bytes: 8, Ctor: Float64Array, set: 'setFloat64' },
  };
  const TIFF_TYPE_ALIASES = { byte: 'uint8', float: 'float32', double: 'float64', short: 'int16', ushort: 'uint16', int: 'int32', uint: 'uint32' };
  const TIFF_SHORT = 3, TIFF_LONG = 4, TIFF_ASCII = 2, TIFF_DOUBLE = 12;
  const TIFF_TYPE_SIZE = { 2: 1, 3: 2, 4: 4, 12: 8 };
  const STRIP_BYTES = 256 * 1024;
  const HOST_LITTLE_ENDIAN = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

  function rasterDataType(r) {
    let t = r.dataType ? String(r.dataType).toLowerCase() : '';
    if (TIFF_TYPE_ALIASES[t]) t = TIFF_TYPE_ALIASES[t];
    if (TIFF_TYPES[t]) return t;
    if (t) throw new Error('Unsupported raster data type "' + r.dataType + '"');
    const b = r.bands[0];
    if (b instanceof Uint8Array || b instanceof Uint8ClampedArray) return 'uint8';
    if (b instanceof Int8Array) return 'int8';
    if (b instanceof Uint16Array) return 'uint16';
    if (b instanceof Int16Array) return 'int16';
    if (b instanceof Uint32Array) return 'uint32';
    if (b instanceof Int32Array) return 'int32';
    if (b instanceof Float64Array) return 'float64';
    return 'float32';
  }

  function epsgNumberOf(code) {
    const C = M.crs;
    const c = C.normalize(code);
    if (!c) return null;
    const m = /^EPSG:(\d+)$/.exec(c);
    if (m) return +m[1];
    if (C.isWKT(c)) {
      const a = /AUTHORITY\s*\[\s*"EPSG"\s*,\s*"?(\d+)"?\s*\]\s*\]\s*$/i.exec(c) || /ID\s*\[\s*"EPSG"\s*,\s*(\d+)\s*\]\s*\]\s*$/i.exec(c);
      if (a) return +a[1];
    }
    return null;
  }

  /** GeoKey directory (+ ASCII params) describing a CRS; null when there is nothing to say. */
  function geoKeysFor(code) {
    if (!code) return null;
    const C = M.crs;
    const keys = [[1025, 0, 1, 1]]; // GTRasterTypeGeoKey = RasterPixelIsArea
    let ascii = '';
    const addAscii = function (id, s) {
      // GeoKey offsets count characters, so keep the parameter string plain ASCII.
      const str = String(s).replace(/\|/g, '/').replace(/[^\x20-\x7e]/g, '?') + '|';
      keys.push([id, 34737, str.length, ascii.length]);
      ascii += str;
    };
    const epsg = epsgNumberOf(code);
    if (epsg && epsg < 65535) {
      const known = C.has('EPSG:' + epsg);
      const geographic = known ? C.isGeographic('EPSG:' + epsg) : epsg >= 4000 && epsg < 5000;
      keys.push([1024, 0, 1, geographic ? 2 : 1]); // GTModelTypeGeoKey
      const name = String(C.name('EPSG:' + epsg) || '').replace(/\s*\((lon\/lat|web map)\)$/, '');
      if (name && name !== 'EPSG:' + epsg) addAscii(1026, name); // GTCitationGeoKey
      if (geographic) {
        keys.push([2048, 0, 1, epsg]); // GeographicTypeGeoKey
        keys.push([2054, 0, 1, 9102]); // GeogAngularUnitsGeoKey = degree
      } else {
        keys.push([3072, 0, 1, epsg]); // ProjectedCSTypeGeoKey
      }
    } else {
      // No EPSG code. The ArcGIS convention, which GDAL reads: a user-defined model type
      // with the WKT in PCSCitationGeoKey as "ESRI PE String = ..." (GDAL reads up to 2400
      // characters). Without a usable WKT, write no CRS rather than a wrong one.
      const c = C.normalize(code);
      const wkt = C.isWKT(c) ? c.replace(/\s*\n\s*/g, '').replace(/[^\x20-\x7e]/g, '?') : null;
      // (A GeoKey directory without a model type makes GDAL invent an engineering CRS.)
      if (!wkt || wkt.length > 2300) return null;
      keys.push([1024, 0, 1, 32767]);
      addAscii(3073, 'ESRI PE String = ' + wkt);
    }
    keys.sort(function (a, b) { return a[0] - b[0]; });
    let dir = [1, 1, 0, keys.length];
    keys.forEach(function (k) { dir = dir.concat(k); });
    return { directory: dir, ascii: ascii };
  }

  function rasterTransform(r) {
    const t = r.transform;
    if (Array.isArray(t) && t.length >= 6 && t.every(function (v) { return typeof v === 'number' && isFinite(v); })) return t;
    const b = r.bbox;
    if (Array.isArray(b) && b.length >= 4) return [b[0], (b[2] - b[0]) / r.width, 0, b[3], 0, -(b[3] - b[1]) / r.height];
    return null;
  }

  function noDataText(v) {
    if (Number.isNaN(v)) return 'nan';
    if (v === Infinity) return 'inf';
    if (v === -Infinity) return '-inf';
    return numStr(+v);
  }

  function geotiffWrite(raster) {
    if (!raster || typeof raster !== 'object') throw new Error('No raster to write');
    const width = raster.width, height = raster.height;
    if (!Number.isInteger(width) || width <= 0 || !Number.isInteger(height) || height <= 0) {
      throw new Error('Raster size must be positive whole numbers (got ' + width + ' x ' + height + ')');
    }
    const bands = raster.bands;
    if (!Array.isArray(bands) || !bands.length) throw new Error('The raster has no bands to write');
    if (bands.length > 65535) throw new Error('Too many bands for a GeoTIFF');
    const npx = width * height;
    bands.forEach(function (b, i) {
      if (!b || b.length !== npx) {
        throw new Error('Band ' + (i + 1) + ' has ' + (b ? b.length : 0) + ' values, but a ' + width + ' x ' + height + ' raster needs ' + npx);
      }
    });
    const dt = TIFF_TYPES[rasterDataType(raster)];
    const spp = bands.length;
    const rowBytes = width * spp * dt.bytes;
    const rowsPerStrip = Math.max(1, Math.min(height, Math.floor(STRIP_BYTES / rowBytes)));
    const nStrips = Math.ceil(height / rowsPerStrip);
    const photometric = dt.Ctor === Uint8Array && (spp === 3 || spp === 4) ? 2 : 1; // RGB or BlackIsZero
    const extraSamples = spp - (photometric === 2 ? 3 : 1);
    const repeat = function (v, n) { return new Array(n).fill(v); };
    const byteCounts = [];
    for (let s = 0; s < nStrips; s++) byteCounts.push(Math.min(rowsPerStrip, height - s * rowsPerStrip) * rowBytes);

    const tags = [];
    const add = function (tag, type, values) { tags.push({ tag: tag, type: type, values: values }); };
    add(256, TIFF_LONG, [width]);
    add(257, TIFF_LONG, [height]);
    add(258, TIFF_SHORT, repeat(dt.bits, spp));
    add(259, TIFF_SHORT, [1]); // no compression
    add(262, TIFF_SHORT, [photometric]);
    const stripOffsets = { tag: 273, type: TIFF_LONG, values: repeat(0, nStrips) };
    tags.push(stripOffsets);
    add(277, TIFF_SHORT, [spp]);
    add(278, TIFF_LONG, [rowsPerStrip]);
    add(279, TIFF_LONG, byteCounts);
    add(284, TIFF_SHORT, [1]); // chunky (pixel-interleaved)
    if (extraSamples > 0) add(338, TIFF_SHORT, repeat(0, extraSamples)); // unspecified extra samples
    add(339, TIFF_SHORT, repeat(dt.format, spp));

    const tr = rasterTransform(raster);
    if (tr) {
      if (tr[2] === 0 && tr[4] === 0) {
        add(33550, TIFF_DOUBLE, [tr[1], -tr[5], 0]); // ModelPixelScaleTag
        add(33922, TIFF_DOUBLE, [0, 0, 0, tr[0], tr[3], 0]); // ModelTiepointTag
      } else {
        add(34264, TIFF_DOUBLE, [tr[1], tr[2], 0, tr[0], tr[4], tr[5], 0, tr[3], 0, 0, 0, 0, 0, 0, 0, 1]); // ModelTransformationTag
      }
    }
    const gk = tr ? geoKeysFor(raster.crs) : null;
    if (gk) {
      add(34735, TIFF_SHORT, gk.directory);
      if (gk.ascii) add(34737, TIFF_ASCII, gk.ascii);
    }
    const names = Array.isArray(raster.bandNames) ? raster.bandNames : [];
    if (names.some(function (n, i) { return n !== null && n !== undefined && String(n) !== '' && String(n) !== 'b' + (i + 1); })) {
      let md = '<GDALMetadata>\n';
      names.forEach(function (n, i) {
        if (i < spp && n !== null && n !== undefined && String(n) !== '') {
          md += '  <Item name="DESCRIPTION" sample="' + i + '" role="description">' + xmlEscape(n) + '</Item>\n';
        }
      });
      add(42112, TIFF_ASCII, md + '</GDALMetadata>');
    }
    if (raster.noData !== null && raster.noData !== undefined && raster.noData !== '') add(42113, TIFF_ASCII, noDataText(raster.noData));
    tags.sort(function (a, b) { return a.tag - b.tag; });

    // Layout: header (8) | IFD | out-of-line tag values | pixel data (8-byte aligned).
    tags.forEach(function (t) {
      if (t.type === TIFF_ASCII) { t.bytes = utf8Encode(t.values); t.count = t.bytes.length + 1; }
      else t.count = t.values.length;
      t.size = t.count * TIFF_TYPE_SIZE[t.type];
    });
    const ifdSize = 2 + 12 * tags.length + 4;
    let extra = 8 + ifdSize;
    // Small values first, so readers find the georeferencing within the first kilobyte;
    // the strip arrays (which can be long) go last.
    const isStripArray = function (t) { return t.tag === 273 || t.tag === 279; };
    tags.filter(function (t) { return !isStripArray(t); }).concat(tags.filter(isStripArray)).forEach(function (t) {
      if (t.size > 4) { t.offset = extra; extra += t.size + (t.size & 1); }
    });
    const dataOffset = Math.ceil(extra / 8) * 8;
    for (let s = 0; s < nStrips; s++) stripOffsets.values[s] = dataOffset + s * rowsPerStrip * rowBytes;
    const total = dataOffset + rowBytes * height;
    if (total > 0xffffffff) throw new Error('This raster is too large to save as a GeoTIFF here (over 4 GB)');

    const buf = new ArrayBuffer(total);
    const dv = new DataView(buf);
    const u8 = new Uint8Array(buf);
    u8[0] = 0x49; // "II": little-endian
    u8[1] = 0x49;
    dv.setUint16(2, 42, true);
    dv.setUint32(4, 8, true);
    dv.setUint16(8, tags.length, true);
    const writeValues = function (t, at) {
      if (t.type === TIFF_ASCII) { u8.set(t.bytes, at); u8[at + t.bytes.length] = 0; return; }
      for (let i = 0; i < t.values.length; i++) {
        const v = t.values[i];
        if (t.type === TIFF_SHORT) dv.setUint16(at + 2 * i, v, true);
        else if (t.type === TIFF_LONG) dv.setUint32(at + 4 * i, v, true);
        else dv.setFloat64(at + 8 * i, v, true);
      }
    };
    let p = 10;
    tags.forEach(function (t) {
      dv.setUint16(p, t.tag, true);
      dv.setUint16(p + 2, t.type, true);
      dv.setUint32(p + 4, t.count, true);
      if (t.size > 4) {
        dv.setUint32(p + 8, t.offset, true);
        writeValues(t, t.offset);
      } else writeValues(t, p + 8);
      p += 12;
    });
    dv.setUint32(p, 0, true); // no further IFDs

    if (HOST_LITTLE_ENDIAN) {
      const view = new dt.Ctor(buf, dataOffset, npx * spp);
      if (spp === 1) view.set(bands[0]);
      else {
        for (let b = 0; b < spp; b++) {
          const src = bands[b];
          for (let i = 0, j = b; i < npx; i++, j += spp) view[j] = src[i];
        }
      }
    } else {
      let o = dataOffset;
      for (let i = 0; i < npx; i++) {
        for (let b = 0; b < spp; b++) { dv[dt.set](o, bands[b][i], true); o += dt.bytes; }
      }
    }
    return buf;
  }

  /* ========================================== detection and zip archives */

  const EXT_KIND = {
    geojson: 'geojson', topojson: 'topojson', shp: 'shp', dbf: 'dbf', shx: 'shx', prj: 'prj', cpg: 'cpg',
    kml: 'kml', kmz: 'kmz', gpx: 'gpx', csv: 'csv', tsv: 'tsv', xlsx: 'xlsx', xlsm: 'xlsx', gpkg: 'gpkg',
    fgb: 'fgb', tif: 'geotiff', tiff: 'geotiff', gtiff: 'geotiff', geotiff: 'geotiff', zip: 'zip', wkt: 'wkt', json: 'json',
  };
  const SNIFF_EXTENSIONS = new Set(['json', 'geojson', 'topojson', 'txt', 'text', 'dat', '']);

  function xmlRootName(t) {
    let i = 0;
    for (;;) {
      i = t.indexOf('<', i);
      if (i < 0) return null;
      if (t.startsWith('<?', i)) { i = t.indexOf('?>', i); if (i < 0) return null; i += 2; continue; }
      if (t.startsWith('<!--', i)) { i = t.indexOf('-->', i); if (i < 0) return null; i += 3; continue; }
      if (t.startsWith('<!', i)) { i = t.indexOf('>', i); if (i < 0) return null; i += 1; continue; }
      const m = /^<(?:[A-Za-z_][\w.-]*:)?([A-Za-z_][\w.-]*)/.exec(t.slice(i, i + 256));
      return m ? m[1].toLowerCase() : null;
    }
  }

  function sniffJson(t) {
    if (/"type"\s*:\s*"Topology"/.test(t)) return 'topojson';
    if (/"type"\s*:\s*"(FeatureCollection|Feature|Point|MultiPoint|LineString|MultiLineString|Polygon|MultiPolygon|GeometryCollection)"/.test(t)) return 'geojson';
    return null;
  }

  function detect(filename, headBytes) {
    const name = String(filename || '').trim().toLowerCase();
    const m = /\.([a-z0-9]+)$/.exec(name);
    const ext = m ? m[1] : '';
    let u8 = null, text = null;
    if (typeof headBytes === 'string') text = headBytes;
    else if (headBytes) { try { u8 = toBytes(headBytes); } catch (e) { u8 = null; } }

    if (u8 && u8.length >= 4) {
      if (u8[0] === 0x50 && u8[1] === 0x4b && (u8[2] === 3 || u8[2] === 5 || u8[2] === 7)) {
        if (ext === 'kmz' || ext === 'kml') return 'kmz';
        if (ext === 'xlsx' || ext === 'xlsm') return 'xlsx';
        return 'zip';
      }
      if (startsWithAscii(u8, 'SQLite format 3\u0000')) return 'gpkg';
      if ((u8[0] === 0x49 && u8[1] === 0x49 && (u8[2] === 42 || u8[2] === 43) && u8[3] === 0) ||
        (u8[0] === 0x4d && u8[1] === 0x4d && u8[2] === 0 && (u8[3] === 42 || u8[3] === 43))) return 'geotiff';
      if (u8.length >= 7 && u8[0] === 0x66 && u8[1] === 0x67 && u8[2] === 0x62 && u8[4] === 0x66 && u8[5] === 0x67 && u8[6] === 0x62) return 'fgb';
      if (u8[0] === 0 && u8[1] === 0 && u8[2] === 0x27 && u8[3] === 0x0a) return ext === 'shx' ? 'shx' : 'shp';
    }
    if (ext && EXT_KIND[ext] && !SNIFF_EXTENSIONS.has(ext)) return EXT_KIND[ext];

    let s = text !== null ? text : u8 ? new TextDecoder('utf-8').decode(u8.subarray(0, Math.min(u8.length, 65536))) : '';
    s = s.replace(/^\uFEFF/, '').replace(/^\s+/, '');
    if (!s) return ext && EXT_KIND[ext] ? EXT_KIND[ext] : 'unknown';
    if (s[0] === '<') {
      const r = xmlRootName(s);
      if (r === 'kml') return 'kml';
      if (r === 'gpx') return 'gpx';
      return 'unknown';
    }
    if (s[0] === '{' || s[0] === '[') {
      const k = sniffJson(s);
      if (k) return k;
      if (ext === 'geojson' || ext === 'topojson') return ext;
      return 'json';
    }
    if (WKT_START.test(s)) return 'wkt';
    if (/^(PROJCS|GEOGCS|PROJCRS|GEOGCRS|GEODCRS|COMPD_CS|COMPOUNDCRS)\s*\[/i.test(s)) return 'prj';
    if (ext === 'json' || ext === 'geojson' || ext === 'topojson') return EXT_KIND[ext];
    const first = s.split(/\r\n|\n|\r/, 1)[0];
    const multiline = /\r|\n/.test(s);
    if (first.indexOf('\t') >= 0 && multiline) return 'tsv';
    if (/[,;|]/.test(first) && multiline) return 'csv';
    return 'unknown';
  }

  async function loadZip(bytes) {
    const Zip = lib('JSZip', 'The zip library (JSZip)');
    try {
      return await Zip.loadAsync(toBytes(bytes, 'The zip file'));
    } catch (e) {
      throw new Error('This file is not a valid zip archive' + (e && e.message ? ' (' + e.message + ')' : ''));
    }
  }

  function isJunkZipPath(p) {
    return /(^|\/)__MACOSX\//.test(p) || /(^|\/)\.DS_Store$/.test(p) || /(^|\/)\._[^/]*$/.test(p) || /(^|\/)Thumbs\.db$/i.test(p);
  }

  async function inspectZip(bytes) {
    const zip = await loadZip(bytes);
    const entries = [];
    const files = [];
    zip.forEach(function (path, f) {
      if (f.dir || isJunkZipPath(path)) return;
      const size = f._data && typeof f._data.uncompressedSize === 'number' ? f._data.uncompressedSize : null;
      entries.push({ path: path, size: size });
      files.push(f);
    });
    for (let i = 0; i < entries.length; i++) {
      if (entries[i].size === null) entries[i].size = (await files[i].async('uint8array')).length;
    }
    const lower = entries.map(function (e) { return e.path.toLowerCase(); });
    if (lower.indexOf('[content_types].xml') >= 0 && lower.some(function (p) { return /(^|\/)workbook\.xml$/.test(p) && p.indexOf('xl/') === 0; })) {
      return { kind: 'xlsx', entries: entries };
    }
    const kinds = new Set();
    lower.forEach(function (p) {
      if (/\.shp$/.test(p)) kinds.add('shapefile');
      else if (/\.kml$/.test(p)) kinds.add('kmz');
      else if (/\.(geo)?json$/.test(p)) kinds.add('geojson');
      else if (/\.gpkg$/.test(p)) kinds.add('gpkg');
      else if (/\.tiff?$/.test(p)) kinds.add('geotiff');
    });
    const kind = kinds.size === 1 ? Array.from(kinds)[0] : kinds.size > 1 ? 'mixed' : 'unknown';
    return { kind: kind, entries: entries };
  }

  function cleanShpValue(v) {
    if (typeof v === 'number') return isFinite(v) ? v : null;
    if (v instanceof Date) {
      if (isNaN(v.getTime())) return null;
      // shpjs turns the null date "00000000" into new Date(0, -1, 0) = 1899-11-30.
      if (v.getFullYear() === 1899 && v.getMonth() === 10 && v.getDate() === 30) return null;
      return v.getFullYear() + '-' + pad2(v.getMonth() + 1) + '-' + pad2(v.getDate());
    }
    if (typeof v === 'string') return v === '' ? null : v;
    return v === undefined ? null : v;
  }

  async function readZipShapefiles(bytes) {
    const shp = lib('shp', 'The shapefile library (shpjs)');
    const u8 = toBytes(bytes, 'The zip file');
    const zip = await loadZip(u8);
    const files = {};
    zip.forEach(function (path, f) { if (!f.dir && !isJunkZipPath(path)) files[path.toLowerCase()] = f; });
    const bases = Object.keys(files).filter(function (p) { return /\.shp$/.test(p); }).map(function (p) { return p.slice(0, -4); });
    if (!bases.length) throw new Error('No shapefile (.shp) was found in this zip file');

    const prjText = {};
    const codes = {};
    for (let i = 0; i < bases.length; i++) {
      const f = files[bases[i] + '.prj'];
      prjText[bases[i]] = f ? (await f.async('string')).trim() : null;
      codes[bases[i]] = null;
      if (prjText[bases[i]]) {
        try { codes[bases[i]] = M.crs.fromWKT(prjText[bases[i]]); } catch (e) { codes[bases[i]] = null; }
      }
    }
    const readRaw = async function (base) {
      const dbfFile = files[base + '.dbf'];
      const cpgFile = files[base + '.cpg'];
      const geoms = shp.parseShp(await files[base + '.shp'].async('arraybuffer'));
      const props = dbfFile ? shp.parseDbf(await dbfFile.async('arraybuffer'), cpgFile ? await cpgFile.async('string') : undefined) : [];
      return shp.combine([geoms, props]);
    };

    // shpjs reprojects layers whose .prj is not WGS 84; the rest are read as they are, so
    // their coordinates stay bit-for-bit identical (no degree/radian round trip).
    let parsed = null;
    let shpError = null;
    const byBase = {};
    if (bases.some(function (b) { return prjText[b] && codes[b] !== 'EPSG:4326'; })) {
      try {
        parsed = await shp(u8);
      } catch (e) {
        shpError = e && e.message ? e.message : String(e);
      }
      if (parsed) {
        (Array.isArray(parsed) ? parsed : [parsed]).forEach(function (layer) {
          if (layer && Array.isArray(layer.features) && layer.fileName) byBase[String(layer.fileName).toLowerCase()] = layer;
        });
      }
    }

    const out = [];
    const failures = [];
    for (let i = 0; i < bases.length; i++) {
      const base = bases[i];
      const warnings = [];
      const reproject = !!prjText[base] && codes[base] !== 'EPSG:4326';
      let projected = !!prjText[base];
      let layer = reproject ? byBase[base] : null;
      try {
        if (!layer) {
          layer = await readRaw(base);
          if (reproject) {
            // shpjs could not use the .prj: keep the coordinates unchanged.
            projected = false;
            warnings.push('Could not use the projection file of "' + basenameOf(base, files[base + '.shp'].name) + '"' +
              (shpError ? ' (' + shpError + ')' : '') + '; coordinates were left unchanged');
          }
        }
      } catch (e) {
        failures.push('"' + basenameOf(base, files[base + '.shp'].name) + '": ' + (e && e.message ? e.message : e));
        continue;
      }
      const code = codes[base];
      const fc = {
        type: 'FeatureCollection',
        features: layer.features.map(function (f) {
          const props = {};
          Object.keys(f.properties || {}).forEach(function (k) { props[safeKey(k)] = cleanShpValue(f.properties[k]); });
          // Drop shpjs's per-shape bbox: after reprojection it is only the transformed corners.
          const g = f.geometry ? { type: f.geometry.type, coordinates: f.geometry.coordinates } : null;
          return { type: 'Feature', geometry: g, properties: props };
        }),
      };
      const entry = { name: basenameOf(base, files[base + '.shp'].name), fc: fc, crs: code, warnings: warnings };
      const bb = util.bbox(fc);
      if ((!prjText[base] || !projected) && bb && !M.crs.looksGeographic(bb)) {
        entry.needsCrs = true;
        entry.rawBBox = bb;
        warnings.push('"' + entry.name + '" has no usable projection (.prj) and its coordinates are not longitude/latitude; tell PSICITS which coordinate system it uses');
      } else if (!prjText[base]) {
        warnings.push('"' + entry.name + '" has no projection (.prj) file; assumed longitude/latitude (WGS 84)');
      }
      out.push(entry);
    }
    if (!out.length) throw new Error('Could not read the shapefile ' + failures.join('; '));
    if (failures.length) out[0].warnings.unshift('Skipped unreadable shapefiles: ' + failures.join('; '));
    return out;
  }

  function basenameOf(lowerBase, originalPath) {
    const src = originalPath ? String(originalPath).replace(/\.shp$/i, '') : lowerBase;
    const i = src.lastIndexOf('/');
    return i >= 0 ? src.slice(i + 1) : src;
  }

  /* ========================================================= public API */

  M.formats = {
    wkt: {
      /**
       * Parse WKT / EWKT into a GeoJSON geometry. Supports all seven OGC types,
       * EMPTY, Z / M / ZM (Z kept, M dropped) and an optional "SRID=n;" prefix.
       * @param {string} text
       * @returns {object} GeoJSON geometry
       */
      parse: parseWkt,
      /**
       * GeoJSON geometry -> WKT. Z is written when every position has three values.
       * @param {object} geometry
       * @param {{precision?: number}} [opts] decimal places (default: full precision)
       * @returns {string}
       */
      stringify: stringifyWkt,
    },
    wkb: {
      /**
       * Parse (E)WKB. Little/big endian, ISO Z/M/ZM codes and EWKB flags.
       * @param {Uint8Array|ArrayBuffer} bytes
       * @param {number} [offset=0]
       * @returns {{geometry: object, bytesRead: number, srid?: number}}
       */
      parse: parseWkb,
      /**
       * GeoJSON geometry -> ISO WKB (Z codes when every position has three values).
       * @param {object} geometry
       * @param {{littleEndian?: boolean}} [opts]
       * @returns {Uint8Array}
       */
      write: writeWkb,
      /** Hex string (e.g. from PostGIS) -> bytes. */
      fromHex: hexToBytes,
      /** Bytes -> upper-case hex string. */
      toHex: bytesToHex,
    },
    gpkg: {
      /**
       * Read every vector and attribute table of a GeoPackage, reprojected to EPSG:4326.
       * @param {Uint8Array|ArrayBuffer} bytes
       * @param {object} SQL initialised sql.js namespace
       * @returns {Array<{name, fc, srsId, crs, geometryType, fields, warnings}>}
       */
      read: gpkgRead,
      /**
       * Write layers (EPSG:4326 GeoJSON) to a GeoPackage 1.3 file.
       * @param {Array<{name: string, fc: object, fields?: Array<{name, type}>}>} layers
       * @param {object} SQL initialised sql.js namespace
       * @returns {Uint8Array}
       */
      write: gpkgWrite,
    },
    shapefile: {
      /**
       * Write a zipped shapefile (.shp .shx .dbf .prj .cpg). Mixed geometry types
       * produce one shapefile per family (<name>_point, <name>_line, <name>_polygon).
       * @param {object} fc FeatureCollection
       * @param {{name?: string, prjWKT?: string}} [opts]
       * @returns {Promise<{bytes: Uint8Array, warnings: string[]}>}
       */
      write: shapefileWrite,
    },
    kml: {
      /**
       * FeatureCollection -> KML 2.2 document.
       * @param {object} fc
       * @param {{name?, nameField?, descriptionField?, color?, lineWidth?, fillOpacity?}} [opts]
       * @returns {string}
       */
      write: kmlWrite,
    },
    gpx: {
      /**
       * FeatureCollection -> GPX 1.1 (points as waypoints, lines and polygon outlines as tracks).
       * @param {object} fc
       * @param {{name?, nameField?}} [opts]
       * @returns {string}
       */
      write: gpxWrite,
    },
    csv: {
      /**
       * Parse delimited text (auto-detects , ; tab |) into row objects with typed columns.
       * @param {string|Uint8Array|ArrayBuffer} text
       * @param {{delimiter?: string}} [opts]
       * @returns {Array<object>}
       */
      parse: csvParse,
      /**
       * Turn rows into a FeatureCollection, auto-detecting coordinate or geometry columns.
       * @param {Array<object>} rows
       * @param {{x?: string, y?: string, wkt?: string, crs?: string}} [opts]
       * @returns {{fc, mode, xField, yField, wktField, skipped, needsCrs, rawBBox}}
       */
      toFeatureCollection: csvToFeatureCollection,
      /**
       * FeatureCollection -> RFC 4180 CSV text.
       * @param {object} fc
       * @param {{geometry?: 'wkt'|'xy'|'none', delimiter?: string, fields?: string[], precision?: number}} [opts]
       * @returns {string}
       */
      write: csvWrite,
    },
    xlsx: {
      /**
       * Read the sheets of an .xlsx workbook; the first non-empty row is the header.
       * @param {Uint8Array|ArrayBuffer} bytes
       * @returns {Promise<Array<{name: string, rows: Array<object>, columns: string[]}>>}
       */
      read: xlsxRead,
    },
    geotiff: {
      /**
       * Raster -> uncompressed little-endian GeoTIFF.
       * @param {object} raster see the Raster model in docs/CONVENTIONS.md
       * @returns {ArrayBuffer}
       */
      write: geotiffWrite,
    },
    /**
     * Guess a file's format from its name and first bytes.
     * @param {string} filename
     * @param {Uint8Array|ArrayBuffer|string} [headBytes]
     * @returns {string} e.g. 'geojson', 'shp', 'kml', 'gpkg', 'geotiff', 'zip', 'unknown'
     */
    detect: detect,
    /**
     * List a zip's entries and classify its contents.
     * @param {Uint8Array|ArrayBuffer} bytes
     * @returns {Promise<{kind: string, entries: Array<{path: string, size: number}>}>}
     */
    inspectZip: inspectZip,
    /**
     * Read every shapefile in a zip (reprojected to EPSG:4326 when a .prj is present).
     * @param {Uint8Array|ArrayBuffer} bytes
     * @returns {Promise<Array<{name: string, fc: object, crs: string|null, warnings: string[]}>>}
     */
    readZipShapefiles: readZipShapefiles,
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
