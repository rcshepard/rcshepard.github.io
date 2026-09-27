/*
 * PSICITS — core namespace and shared utilities.
 *
 * Everything in js/lib/ is DOM-free so it can run in the browser, in a Web
 * Worker, or in Node (see tests/harness.js). Each file attaches its API to the
 * global `PSICITS` namespace object.
 */
(function (root) {
  'use strict';

  const M = (root.PSICITS = root.PSICITS || {});
  M.version = '0.1.0';
  M.appName = 'PSICITS';
  M.appTagline = "Professor Shepard, I Couldn't Install The Software";

  const util = (M.util = M.util || {});

  /* ------------------------------------------------------------------ ids */

  let seq = 0;
  /** Short unique id, e.g. uid('L') -> "L1k3f". Unique within a session. */
  util.uid = function (prefix) {
    seq += 1;
    return (prefix || 'id') + seq.toString(36) + Math.random().toString(36).slice(2, 5);
  };

  /* -------------------------------------------------------------- objects */

  util.clone = function (o) {
    if (o === undefined) return undefined;
    if (typeof root.structuredClone === 'function') return root.structuredClone(o);
    return JSON.parse(JSON.stringify(o));
  };

  util.isPlainObject = function (o) {
    return o !== null && typeof o === 'object' && Object.getPrototypeOf(o) === Object.prototype;
  };

  util.debounce = function (fn, ms) {
    let t = null;
    return function () {
      const args = arguments;
      const self = this;
      clearTimeout(t);
      t = setTimeout(function () { fn.apply(self, args); }, ms);
    };
  };

  /* -------------------------------------------------------------- strings */

  const HTML_ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  util.escapeHtml = function (s) {
    return String(s === null || s === undefined ? '' : s).replace(/[&<>"']/g, function (c) { return HTML_ESC[c]; });
  };

  /** Normalise a name for loose matching: lowercase, collapse separators. */
  util.normName = function (s) {
    return String(s || '')
      .toLowerCase()
      .normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[\s_\-.]+/g, ' ')
      .trim();
  };

  /** Safe identifier-ish name for files/fields: "Roads (2020)" -> "roads_2020". */
  util.slug = function (s, maxLen) {
    let out = util.normName(s).replace(/[^a-z0-9 ]+/g, '').trim().replace(/ +/g, '_');
    if (!out) out = 'layer';
    return maxLen ? out.slice(0, maxLen) : out;
  };

  /** Returns base, or base_2, base_3 … so it doesn't clash with `existing`. */
  util.uniqueName = function (base, existing) {
    const taken = new Set(Array.from(existing || [], function (n) { return String(n).toLowerCase(); }));
    if (!taken.has(String(base).toLowerCase())) return base;
    for (let i = 2; i < 100000; i++) {
      const cand = base + '_' + i;
      if (!taken.has(cand.toLowerCase())) return cand;
    }
    return base + '_' + Date.now();
  };

  /** Levenshtein distance with early exit when it exceeds `max`. */
  util.editDistance = function (a, b, max) {
    a = String(a); b = String(b);
    if (max === undefined) max = Infinity;
    if (Math.abs(a.length - b.length) > max) return max + 1;
    let prev = new Array(b.length + 1);
    let cur = new Array(b.length + 1);
    for (let j = 0; j <= b.length; j++) prev[j] = j;
    for (let i = 1; i <= a.length; i++) {
      cur[0] = i;
      let rowMin = cur[0];
      for (let j = 1; j <= b.length; j++) {
        const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
        if (cur[j] < rowMin) rowMin = cur[j];
      }
      if (rowMin > max) return max + 1;
      const t = prev; prev = cur; cur = t;
    }
    return prev[b.length];
  };

  /* -------------------------------------------------------------- numbers */

  util.isNum = function (v) { return typeof v === 'number' && isFinite(v); };

  /** Human-friendly number formatting: 1234567.8 -> "1,234,568", 0.000123 -> "0.000123". */
  util.formatNumber = function (n, digits) {
    if (n === null || n === undefined || n === '') return '';
    if (typeof n !== 'number') return String(n);
    if (!isFinite(n)) return String(n);
    const abs = Math.abs(n);
    if (digits === undefined) {
      if (abs === 0) return '0';
      if (abs >= 1000) digits = 0;
      else if (abs >= 10) digits = 2;
      else if (abs >= 0.01) digits = 3;
      else return n.toPrecision(3);
    }
    return n.toLocaleString('en-US', { maximumFractionDigits: digits, minimumFractionDigits: 0 });
  };

  /** Human-friendly byte sizes. */
  util.formatBytes = function (b) {
    if (!util.isNum(b)) return '';
    const u = ['B', 'KB', 'MB', 'GB'];
    let i = 0;
    while (b >= 1024 && i < u.length - 1) { b /= 1024; i++; }
    return (i === 0 ? b : b.toFixed(1)) + ' ' + u[i];
  };

  /* ---------------------------------------------------------------- units */

  // Linear units, expressed in meters.
  const LINEAR = {
    meters: 1, kilometers: 1000, miles: 1609.344, feet: 0.3048, yards: 0.9144,
    nauticalmiles: 1852, centimeters: 0.01, inches: 0.0254, usfeet: 1200 / 3937,
  };
  const LINEAR_ALIASES = {
    m: 'meters', meter: 'meters', meters: 'meters', metre: 'meters', metres: 'meters',
    km: 'kilometers', kms: 'kilometers', kilometer: 'kilometers', kilometers: 'kilometers', kilometre: 'kilometers', kilometres: 'kilometers',
    mi: 'miles', mile: 'miles', miles: 'miles',
    ft: 'feet', foot: 'feet', feet: 'feet', "'": 'feet',
    yd: 'yards', yds: 'yards', yard: 'yards', yards: 'yards',
    nm: 'nauticalmiles', nmi: 'nauticalmiles', nauticalmile: 'nauticalmiles', nauticalmiles: 'nauticalmiles',
    cm: 'centimeters', centimeter: 'centimeters', centimeters: 'centimeters', centimetre: 'centimeters', centimetres: 'centimeters',
    in: 'inches', inch: 'inches', inches: 'inches',
    usft: 'usfeet', 'us-ft': 'usfeet', usfeet: 'usfeet', usfoot: 'usfeet',
  };
  // Area units, expressed in square meters.
  const AREA = {
    sqmeters: 1, sqkilometers: 1e6, hectares: 1e4, acres: 4046.8564224,
    sqmiles: 2589988.110336, sqfeet: 0.09290304, sqyards: 0.83612736,
  };
  const AREA_ALIASES = {
    m2: 'sqmeters', sqm: 'sqmeters', 'sq m': 'sqmeters', sqmeters: 'sqmeters', 'square meters': 'sqmeters', 'square metres': 'sqmeters',
    km2: 'sqkilometers', sqkm: 'sqkilometers', 'sq km': 'sqkilometers', sqkilometers: 'sqkilometers', 'square kilometers': 'sqkilometers', 'square kilometres': 'sqkilometers',
    ha: 'hectares', hectare: 'hectares', hectares: 'hectares',
    ac: 'acres', acre: 'acres', acres: 'acres',
    mi2: 'sqmiles', sqmi: 'sqmiles', 'sq mi': 'sqmiles', sqmiles: 'sqmiles', 'square miles': 'sqmiles',
    ft2: 'sqfeet', sqft: 'sqfeet', 'sq ft': 'sqfeet', sqfeet: 'sqfeet', 'square feet': 'sqfeet',
    yd2: 'sqyards', sqyd: 'sqyards', sqyards: 'sqyards', 'square yards': 'sqyards',
  };

  util.LINEAR_UNITS = Object.keys(LINEAR);
  util.AREA_UNITS = Object.keys(AREA);

  /** Canonical linear unit name for a word ("km" -> "kilometers"), or null. */
  util.normalizeUnit = function (word) {
    if (!word) return null;
    const w = String(word).toLowerCase().trim().replace(/\.$/, '');
    return LINEAR_ALIASES[w] || null;
  };
  /** Canonical area unit name for a word ("ha" -> "hectares"), or null. */
  util.normalizeAreaUnit = function (word) {
    if (!word) return null;
    const w = String(word).toLowerCase().trim().replace(/\.$/, '');
    return AREA_ALIASES[w] || null;
  };
  util.toMeters = function (value, unit) {
    const u = util.normalizeUnit(unit) || 'meters';
    return value * LINEAR[u];
  };
  util.fromMeters = function (value, unit) {
    const u = util.normalizeUnit(unit) || 'meters';
    return value / LINEAR[u];
  };
  util.fromSqMeters = function (value, unit) {
    const u = util.normalizeAreaUnit(unit) || 'sqmeters';
    return value / AREA[u];
  };
  /** Convert to a unit name Turf understands (it lacks usfeet). */
  util.turfUnits = function (unit) {
    const u = util.normalizeUnit(unit) || 'meters';
    return u === 'usfeet' ? 'feet' : u;
  };

  /* -------------------------------------------------------------- GeoJSON */

  /** 'MultiPolygon' -> 'Polygon', etc. Returns null for null/unknown. */
  util.geomFamily = function (type) {
    switch (type) {
      case 'Point': case 'MultiPoint': return 'Point';
      case 'LineString': case 'MultiLineString': return 'LineString';
      case 'Polygon': case 'MultiPolygon': return 'Polygon';
      case 'GeometryCollection': return 'GeometryCollection';
      default: return null;
    }
  };

  /**
   * Summarise the geometry of a FeatureCollection:
   * 'Point' | 'LineString' | 'Polygon' | 'Mixed' | 'None' (no geometries at all).
   */
  util.layerGeometryType = function (fc) {
    let fam = null;
    const feats = (fc && fc.features) || [];
    for (let i = 0; i < feats.length; i++) {
      const g = feats[i] && feats[i].geometry;
      if (!g) continue;
      const f = util.geomFamily(g.type);
      if (!f) continue;
      if (f === 'GeometryCollection') return 'Mixed';
      if (fam === null) fam = f;
      else if (fam !== f) return 'Mixed';
    }
    return fam || 'None';
  };

  /** Iterate every [x, y, ...] position of a geometry. */
  util.coordEach = function (geom, fn) {
    if (!geom) return;
    const c = geom.coordinates;
    switch (geom.type) {
      case 'Point': fn(c); break;
      case 'MultiPoint': case 'LineString': for (let i = 0; i < c.length; i++) fn(c[i]); break;
      case 'MultiLineString': case 'Polygon':
        for (let i = 0; i < c.length; i++) for (let j = 0; j < c[i].length; j++) fn(c[i][j]);
        break;
      case 'MultiPolygon':
        for (let i = 0; i < c.length; i++) for (let j = 0; j < c[i].length; j++) for (let k = 0; k < c[i][j].length; k++) fn(c[i][j][k]);
        break;
      case 'GeometryCollection':
        for (let i = 0; i < geom.geometries.length; i++) util.coordEach(geom.geometries[i], fn);
        break;
      default: break;
    }
  };

  /** Deep-map every position of a geometry (returns a new geometry). */
  util.mapCoords = function (geom, fn) {
    if (!geom) return geom;
    const mapArr = function (a, depth) {
      if (depth === 0) return fn(a);
      const out = new Array(a.length);
      for (let i = 0; i < a.length; i++) out[i] = mapArr(a[i], depth - 1);
      return out;
    };
    switch (geom.type) {
      case 'Point': return { type: 'Point', coordinates: fn(geom.coordinates) };
      case 'MultiPoint': case 'LineString': return { type: geom.type, coordinates: mapArr(geom.coordinates, 1) };
      case 'MultiLineString': case 'Polygon': return { type: geom.type, coordinates: mapArr(geom.coordinates, 2) };
      case 'MultiPolygon': return { type: geom.type, coordinates: mapArr(geom.coordinates, 3) };
      case 'GeometryCollection': return { type: 'GeometryCollection', geometries: geom.geometries.map(function (g) { return util.mapCoords(g, fn); }) };
      default: return geom;
    }
  };

  /** [minX, minY, maxX, maxY] of a geometry, feature, or FeatureCollection; null if empty. */
  util.bbox = function (obj) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    const visit = function (p) {
      const x = p[0], y = p[1];
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    };
    if (!obj) return null;
    if (obj.type === 'FeatureCollection') {
      for (let i = 0; i < obj.features.length; i++) util.coordEach(obj.features[i] && obj.features[i].geometry, visit);
    } else if (obj.type === 'Feature') {
      util.coordEach(obj.geometry, visit);
    } else {
      util.coordEach(obj, visit);
    }
    if (minX === Infinity) return null;
    return [minX, minY, maxX, maxY];
  };

  util.bboxUnion = function (a, b) {
    if (!a) return b ? b.slice() : null;
    if (!b) return a.slice();
    return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])];
  };

  util.countVertices = function (fc) {
    let n = 0;
    const feats = (fc && fc.features) || [];
    for (let i = 0; i < feats.length; i++) util.coordEach(feats[i].geometry, function () { n++; });
    return n;
  };

  /**
   * Coerce assorted GeoJSON-ish input into a FeatureCollection with a
   * `properties` object on every feature. Accepts FeatureCollection, Feature,
   * bare Geometry, or an array of Features/Geometries.
   */
  util.toFeatureCollection = function (input) {
    const asFeature = function (x) {
      if (!x) return null;
      if (x.type === 'Feature') {
        return { type: 'Feature', id: x.id, geometry: x.geometry || null, properties: x.properties && typeof x.properties === 'object' ? x.properties : {} };
      }
      if (typeof x.type === 'string' && (x.coordinates || x.geometries)) {
        return { type: 'Feature', geometry: x, properties: {} };
      }
      return null;
    };
    let feats = [];
    if (Array.isArray(input)) feats = input.map(asFeature);
    else if (input && input.type === 'FeatureCollection') feats = (input.features || []).map(asFeature);
    else if (input) feats = [asFeature(input)];
    feats = feats.filter(Boolean);
    feats.forEach(function (f) { if (f.id === undefined) delete f.id; });
    return { type: 'FeatureCollection', features: feats };
  };

  /**
   * Infer an attribute schema from a FeatureCollection.
   * Returns [{ name, type }] with type in: number | string | boolean | date | object.
   * Field order follows first appearance. Looks at up to `sample` features.
   */
  util.inferFields = function (fc, sample) {
    const feats = (fc && fc.features) || [];
    const limit = Math.min(feats.length, sample || 2000);
    const order = [];
    const types = Object.create(null);
    const isoDate = /^\d{4}-\d{2}-\d{2}([T ][\d:.]+(Z|[+-]\d{2}:?\d{2})?)?$/;
    for (let i = 0; i < limit; i++) {
      const p = feats[i] && feats[i].properties;
      if (!p) continue;
      for (const k in p) {
        if (!(k in types)) { types[k] = null; order.push(k); }
        const v = p[k];
        if (v === null || v === undefined || v === '') continue;
        let t;
        if (typeof v === 'number') t = 'number';
        else if (typeof v === 'boolean') t = 'boolean';
        else if (typeof v === 'string') t = isoDate.test(v) ? 'date' : 'string';
        else t = 'object';
        const prev = types[k];
        if (prev === null) types[k] = t;
        else if (prev !== t) {
          // numbers + dates or strings mixed -> string; anything with object -> object
          types[k] = (prev === 'object' || t === 'object') ? 'object' : 'string';
        }
      }
    }
    // Fields that only ever appear after the sample window
    if (feats.length > limit) {
      for (let i = limit; i < feats.length; i++) {
        const p = feats[i] && feats[i].properties;
        if (!p) continue;
        for (const k in p) if (!(k in types)) { types[k] = null; order.push(k); }
      }
    }
    return order.map(function (k) { return { name: k, type: types[k] || 'string' }; });
  };

  /** Collect values of a property across a FeatureCollection. */
  util.values = function (fc, field) {
    const out = [];
    const feats = (fc && fc.features) || [];
    for (let i = 0; i < feats.length; i++) {
      const p = feats[i].properties;
      out.push(p ? p[field] : undefined);
    }
    return out;
  };

  /** Basic descriptive statistics for an array of values (non-numbers ignored). */
  util.stats = function (values) {
    const nums = [];
    let nulls = 0;
    for (let i = 0; i < values.length; i++) {
      const v = values[i];
      if (v === null || v === undefined || v === '') { nulls++; continue; }
      const n = typeof v === 'number' ? v : Number(v);
      if (isFinite(n)) nums.push(n);
    }
    const count = nums.length;
    if (!count) return { count: 0, nulls: nulls, min: null, max: null, sum: 0, mean: null, median: null, std: null };
    nums.sort(function (a, b) { return a - b; });
    let sum = 0;
    for (let i = 0; i < count; i++) sum += nums[i];
    const mean = sum / count;
    let sq = 0;
    for (let i = 0; i < count; i++) sq += (nums[i] - mean) * (nums[i] - mean);
    const q = function (p) {
      const idx = (count - 1) * p;
      const lo = Math.floor(idx), hi = Math.ceil(idx);
      return nums[lo] + (nums[hi] - nums[lo]) * (idx - lo);
    };
    return {
      count: count, nulls: nulls, min: nums[0], max: nums[count - 1], sum: sum, mean: mean,
      median: q(0.5), q1: q(0.25), q3: q(0.75), std: Math.sqrt(sq / count),
    };
  };

  /** Frequency table: [{ value, count }] sorted by count desc. */
  util.frequencies = function (values, limit) {
    const m = new Map();
    for (let i = 0; i < values.length; i++) {
      const v = values[i] === undefined ? null : values[i];
      const key = (v !== null && typeof v === 'object') ? JSON.stringify(v) : v;
      m.set(key, (m.get(key) || 0) + 1);
    }
    const arr = Array.from(m, function (e) { return { value: e[0], count: e[1] }; });
    arr.sort(function (a, b) { return b.count - a.count; });
    return limit ? arr.slice(0, limit) : arr;
  };

  /* --------------------------------------------------------------- events */

  /** Tiny event emitter mixin. */
  util.Emitter = function () {
    const handlers = Object.create(null);
    return {
      on: function (evt, fn) { (handlers[evt] = handlers[evt] || []).push(fn); return function () { this.off(evt, fn); }.bind(this); },
      off: function (evt, fn) { const h = handlers[evt]; if (h) { const i = h.indexOf(fn); if (i >= 0) h.splice(i, 1); } },
      emit: function (evt, payload) {
        const h = handlers[evt];
        if (!h) return;
        h.slice().forEach(function (fn) {
          try { fn(payload); } catch (e) { if (root.console) root.console.error('[PSICITS] handler for "' + evt + '" failed', e); }
        });
      },
    };
  };

  /** Yield to the event loop (lets the UI repaint during long jobs). */
  util.tick = function () { return new Promise(function (r) { setTimeout(r, 0); }); };
})(typeof globalThis !== 'undefined' ? globalThis : this);
