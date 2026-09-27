/*
 * PSICITS — raster engine (DOM-free).
 *
 * Pure functions over the Raster model of docs/CONVENTIONS.md:
 *
 *   { width, height, bands: [TypedArray], bandNames, noData, crs,
 *     transform: [x0, dx, 0, y0, 0, dy], bbox, dataType, stats, meta }
 *
 *   create / fromGeoTIFF            build rasters (GeoTIFF + COG overviews via geotiff.js)
 *   stats / histogram / info        describe them
 *   defaultStyle / render           colourise + warp into an RGBA image for a MapLibre image source
 *   mapAlgebra / reclassify / resampleTo / clip / terrain / idw        raster -> raster
 *   zonalStats / sample / valueAt / contours / footprint / bboxWGS84   raster <-> vector
 *
 * Rules followed throughout:
 *  - inputs are never mutated (band arrays are shared by reference only by create());
 *  - NaN pixels always count as no-data, in addition to raster.noData;
 *  - vector input/output is GeoJSON in EPSG:4326; distances are meters;
 *  - Web Mercator math uses a sphere of radius 6378137 m;
 *  - per-pixel loops use typed arrays and lookup tables, no allocations.
 */
(function (root) {
  'use strict';

  const M = (root.PSICITS = root.PSICITS || {});

  /* ------------------------------------------------------------ constants */

  const R = 6378137;                          // Web Mercator sphere radius (m)
  const D2R = Math.PI / 180;
  const R2D = 180 / Math.PI;
  const MAX_LAT = 85.0511287798066;           // Web Mercator latitude limit
  const WGS84_A = 6378137;
  const WGS84_E2 = 0.0066943799901413165;     // first eccentricity squared

  const TYPED = {
    uint8: Uint8Array, int16: Int16Array, uint16: Uint16Array, int32: Int32Array,
    uint32: Uint32Array, float32: Float32Array, float64: Float64Array,
  };
  const INT_RANGE = {
    uint8: [0, 255], int16: [-32768, 32767], uint16: [0, 65535],
    int32: [-2147483648, 2147483647], uint32: [0, 4294967295],
  };
  const TYPE_ALIASES = {
    byte: 'uint8', uint8: 'uint8', u8: 'uint8', int16: 'int16', i16: 'int16', short: 'int16',
    uint16: 'uint16', u16: 'uint16', int32: 'int32', i32: 'int32', int: 'int32', integer: 'int32',
    uint32: 'uint32', u32: 'uint32', float32: 'float32', f32: 'float32', float: 'float32', real: 'float32',
    float64: 'float64', f64: 'float64', double: 'float64',
  };
  const STAT_NAMES = ['count', 'sum', 'mean', 'min', 'max', 'std', 'median', 'majority', 'minority', 'range', 'variety'];

  /* -------------------------------------------------------------- helpers */

  function isNum(v) { return typeof v === 'number' && isFinite(v); }
  /** Numeric strings ("12.5") -> numbers; anything else unchanged. */
  function numeric(v) { return typeof v === 'string' && v.trim() !== '' && isFinite(+v) ? +v : v; }
  function fmtInt(n) { return Number(n).toLocaleString('en-US'); }
  function errText(e) { return (e && e.message) || String(e); }

  function crsLib() {
    if (!M.crs) throw new Error('PSICITS.crs is not loaded');
    return M.crs;
  }
  function colorLib() {
    if (!M.colors) throw new Error('PSICITS.colors is not loaded');
    return M.colors;
  }

  function normalizeType(t) {
    if (t === null || t === undefined || t === '') return null;
    const k = TYPE_ALIASES[String(t).toLowerCase().replace(/[\s_-]/g, '')];
    if (!k) throw new Error('Unknown pixel type "' + t + '". Use uint8, int16, uint16, int32, uint32, float32 or float64');
    return k;
  }

  function typeOfArray(a) {
    if (a instanceof Uint8Array || a instanceof Uint8ClampedArray) return 'uint8';
    if (a instanceof Int16Array) return 'int16';
    if (a instanceof Uint16Array) return 'uint16';
    if (a instanceof Int32Array) return 'int32';
    if (a instanceof Uint32Array) return 'uint32';
    if (a instanceof Float32Array) return 'float32';
    if (a instanceof Float64Array) return 'float64';
    return null;
  }

  function isIntType(t) { return !!INT_RANGE[t]; }

  /** Can `v` be stored exactly in a band of type `t`? */
  function fitsType(v, t) {
    if (!isNum(v)) return false;
    const r = INT_RANGE[t];
    if (!r) return t !== 'float32' || Math.abs(v) <= 3.4028234663852886e38;
    return Number.isInteger(v) && v >= r[0] && v <= r[1];
  }

  function allocBand(t, n) { return new (TYPED[t] || Float32Array)(n); }

  /** Round + clamp a value into an integer type's range (floats pass through). */
  function storable(v, t) {
    const r = INT_RANGE[t];
    if (!r) return v;
    v = Math.round(v);
    return v < r[0] ? r[0] : v > r[1] ? r[1] : v;
  }

  function checkRaster(r) {
    if (!r || !Array.isArray(r.bands) || !r.bands.length || !(r.width > 0) || !(r.height > 0) ||
        !r.transform || r.transform.length < 6) {
      throw new Error('Expected a raster layer');
    }
  }

  /** The raster's no-data value as it compares against its pixels (null when unset or NaN). */
  function noDataOf(r) {
    const nd = r.noData;
    if (nd === null || nd === undefined || nd !== nd) return null;
    return r.dataType === 'float32' ? Math.fround(nd) : nd;
  }

  function bandList(raster) {
    const n = raster.bands.length;
    const names = [];
    for (let i = 0; i < Math.min(n, 8); i++) names.push(bandLabel(raster, i));
    return names.join(', ') + (n > 8 ? ', ...' : '');
  }

  function bandLabel(raster, i) {
    const nm = raster.bandNames && raster.bandNames[i];
    return nm && nm !== 'b' + (i + 1) ? 'b' + (i + 1) + ' "' + nm + '"' : 'b' + (i + 1);
  }

  /**
   * Resolve a band reference: a 0-based index, a band name ("nir", case
   * insensitive) or "b<n>" / "band <n>" (1-based). Throws a readable error.
   */
  function bandIndex(raster, band) {
    checkRaster(raster);
    const n = raster.bands.length;
    if (band === undefined || band === null || band === '') return 0;
    if (typeof band === 'number') {
      if (Number.isInteger(band) && band >= 0 && band < n) return band;
    } else {
      const s = String(band).trim();
      const lower = s.toLowerCase();
      const names = raster.bandNames || [];
      for (let i = 0; i < n; i++) if (names[i] !== undefined && String(names[i]).toLowerCase() === lower) return i;
      const m = /^b(?:and)?\s*(\d+)$/i.exec(s);
      if (m) {
        const i = +m[1] - 1;
        if (i >= 0 && i < n) return i;
      }
    }
    const label = typeof band === 'number' ? 'band ' + (Number.isInteger(band) ? 'b' + (band + 1) : band) : 'band "' + band + '"';
    throw new Error('This raster has ' + n + (n === 1 ? ' band' : ' bands') + ' (' + bandList(raster) + '); there is no ' + label);
  }

  function flipRows(arr, W, H) {
    const out = new arr.constructor(arr.length);
    for (let r = 0; r < H; r++) out.set(arr.subarray(r * W, (r + 1) * W), (H - 1 - r) * W);
    return out;
  }

  /* ------------------------------------------------------------------ CRS */

  function lngToX(lng) { return lng * D2R * R; }
  function latToY(lat) {
    const l = lat > MAX_LAT ? MAX_LAT : lat < -MAX_LAT ? -MAX_LAT : lat;
    return R * Math.log(Math.tan(Math.PI / 4 + (l * D2R) / 2));
  }
  function xToLng(x) { return (x / R) * R2D; }
  function yToLat(y) { return (2 * Math.atan(Math.exp(y / R)) - Math.PI / 2) * R2D; }

  function normCrs(c) {
    if (c === null || c === undefined || c === '') return null;
    return crsLib().normalize(c);
  }
  /** 'lonlat' (EPSG:4326), 'merc' (EPSG:3857) or 'other'. */
  function crsKind(c) {
    const n = normCrs(c);
    return n === 'EPSG:4326' ? 'lonlat' : n === 'EPSG:3857' ? 'merc' : 'other';
  }
  function sameCrs(a, b) { return normCrs(a) === normCrs(b); }

  function crsError(msg, code) {
    const e = new Error(msg);
    e.code = code;
    return e;
  }

  /** Throws a readable error (with e.code CRS_MISSING / CRS_UNKNOWN) if the raster can't be located. */
  function checkCrs(raster, action) {
    if (!raster.crs) {
      throw crsError('This raster has no coordinate reference system, so it can\'t be ' + action +
        '. Assign one first (for example EPSG:4326).', 'CRS_MISSING');
    }
    if (!crsLib().has(raster.crs)) {
      throw crsError('The coordinate system ' + raster.crs + ' isn\'t built in and hasn\'t been looked up yet, so this raster can\'t be ' +
        action + '. Connect to the internet so it can be looked up, or give its proj4 definition.', 'CRS_UNKNOWN');
    }
  }

  function identityTf(p) { return p; }
  const tfCache = new Map();

  /** Cached point transformer [x, y] -> [x, y] (closed form for 4326 <-> 3857). NaN on failure. */
  function transformer(from, to) {
    const f = normCrs(from) || 'EPSG:4326';
    const t = normCrs(to) || 'EPSG:4326';
    if (f === t) return identityTf;
    const key = f + '\u0001' + t;
    let fn = tfCache.get(key);
    if (fn) return fn;
    if (f === 'EPSG:4326' && t === 'EPSG:3857') {
      fn = function (p) { return [lngToX(p[0]), latToY(p[1])]; };
    } else if (f === 'EPSG:3857' && t === 'EPSG:4326') {
      fn = function (p) { return [xToLng(p[0]), yToLat(p[1])]; };
    } else {
      const conv = crsLib().transformer(f, t);
      fn = function (p) {
        try { return conv(p); } catch (e) { return [NaN, NaN]; }
      };
    }
    if (tfCache.size > 100) tfCache.clear();
    tfCache.set(key, fn);
    return fn;
  }

  function isGeographicCrs(c) {
    if (!c) return false;
    try { return crsLib().isGeographic(c); } catch (e) { return false; }
  }

  /** Ground meters per degree of longitude/latitude at a latitude (WGS 84 ellipsoid). */
  function metersPerDegree(lat) {
    const s = Math.sin(lat * D2R);
    const w = 1 - WGS84_E2 * s * s;
    const N = WGS84_A / Math.sqrt(w);
    const Mr = (WGS84_A * (1 - WGS84_E2)) / (w * Math.sqrt(w));
    return { x: N * Math.cos(lat * D2R) * D2R, y: Mr * D2R };
  }

  /* ---------------------------------------------------------------- stats */

  // Per-band statistics memoised by band array (inputs stay untouched).
  const statsCache = new WeakMap();

  function emptyStats() { return { min: null, max: null, mean: null, std: null, count: 0, p2: null, p98: null }; }

  function computeBandStats(arr, nd, intType) {
    const n = arr.length;
    let count = 0, min = Infinity, max = -Infinity, K = 0, s1 = 0, s2 = 0;
    let i = 0;
    for (; i < n; i++) {
      const v = arr[i];
      if (v === v && v !== nd && v !== Infinity && v !== -Infinity) { K = v; break; }
    }
    for (; i < n; i++) {
      const v = arr[i];
      if (v !== v || v === nd || v === Infinity || v === -Infinity) continue;
      count++;
      if (v < min) min = v;
      if (v > max) max = v;
      const d = v - K;          // shifted sums keep the variance accurate for large values
      s1 += d;
      s2 += d * d;
    }
    if (!count) return emptyStats();
    const m1 = s1 / count;
    let variance = s2 / count - m1 * m1;
    if (variance < 0) variance = 0;
    const pc = percentiles(arr, nd, min, max, count, intType, [0.02, 0.98]);
    return { min: min, max: max, mean: K + m1, std: Math.sqrt(variance), count: count, p2: pc[0], p98: pc[1] };
  }

  /**
   * Percentiles (linear interpolation between ranks, like numpy) from a
   * histogram: exact for integer data spanning < 65536 values, otherwise
   * 4096 bins with interpolation inside the bin.
   */
  function percentiles(arr, nd, min, max, count, intType, ps) {
    if (min === max) return ps.map(function () { return min; });
    const exact = intType && max - min < 65536;
    const bins = exact ? max - min + 1 : 4096;
    const width = exact ? 1 : (max - min) / bins;
    const counts = new Uint32Array(bins);
    const n = arr.length;
    if (exact) {
      for (let i = 0; i < n; i++) {
        const v = arr[i];
        if (v !== nd) counts[v - min]++;
      }
    } else {
      const scale = bins / (max - min);
      for (let i = 0; i < n; i++) {
        const v = arr[i];
        if (v !== v || v === nd || v === Infinity || v === -Infinity) continue;
        let k = ((v - min) * scale) | 0;
        if (k >= bins) k = bins - 1;
        counts[k]++;
      }
    }
    function valueAtRank(rank) {
      let cum = 0;
      for (let k = 0; k < bins; k++) {
        const c = counts[k];
        if (rank < cum + c) {
          if (exact) return min + k;
          const v = min + k * width + ((rank - cum + 0.5) / c) * width;
          return v < min ? min : v > max ? max : v;
        }
        cum += c;
      }
      return max;
    }
    return ps.map(function (p) {
      const pos = p * (count - 1);
      const r0 = Math.floor(pos);
      const f = pos - r0;
      const v0 = valueAtRank(r0);
      return f > 0 ? v0 + (valueAtRank(r0 + 1) - v0) * f : v0;
    });
  }

  function bandStats(raster, b, force) {
    const arr = raster.bands[b];
    const nd = noDataOf(raster);
    if (!force) {
      const own = raster.stats;
      if (Array.isArray(own) && own.length === raster.bands.length && own[b] && 'min' in own[b] && 'p2' in own[b]) return own[b];
      const c = statsCache.get(arr);
      if (c && c.noData === nd) return c.stats;
    }
    const s = computeBandStats(arr, nd, isIntType(typeOfArray(arr) || raster.dataType));
    statsCache.set(arr, { noData: nd, stats: s });
    return s;
  }

  /* ------------------------------------------------------------- extents */

  /**
   * Outline of the raster in lon/lat: { ring (closed, CCW), bbox, pole }.
   * Longitudes are unwrapped so rasters crossing the antimeridian stay
   * contiguous (values may exceed ±180, which MapLibre accepts).
   */
  function wgs84Outline(raster, steps) {
    checkCrs(raster, 'placed on the map');
    const t = raster.transform, W = raster.width, H = raster.height;
    const kind = crsKind(raster.crs);
    const x0 = t[0], x1 = t[0] + W * t[1], y0 = t[3] + H * t[5], y1 = t[3];
    if (kind === 'lonlat' || kind === 'merc') {
      const f = kind === 'merc' ? function (x, y) { return [xToLng(x), yToLat(y)]; } : function (x, y) { return [x, y]; };
      const a = f(x0, y0), b = f(x1, y1);
      const ring = [[a[0], a[1]], [b[0], a[1]], [b[0], b[1]], [a[0], b[1]], [a[0], a[1]]];
      return { ring: ring, bbox: [a[0], a[1], b[0], b[1]], pole: 0 };
    }
    const n = steps || 32;
    const tf = transformer(raster.crs, 'EPSG:4326');
    const pts = [];
    const add = function (col, row) {
      const q = tf([t[0] + col * t[1], t[3] + row * t[5]]);
      if (q && isFinite(q[0]) && isFinite(q[1])) pts.push([q[0], q[1]]);
    };
    for (let i = 0; i < n; i++) add((i / n) * W, H);          // bottom, west -> east
    for (let i = 0; i < n; i++) add(W, H - (i / n) * H);      // right, south -> north
    for (let i = 0; i < n; i++) add(W - (i / n) * W, 0);      // top, east -> west
    for (let i = 0; i < n; i++) add(0, (i / n) * H);          // left, north -> south
    if (pts.length < 3) throw new Error('This raster\'s extent can\'t be converted to longitude/latitude');
    for (let i = 1; i < pts.length; i++) {
      let d = pts[i][0] - pts[i - 1][0];
      while (d > 180) { pts[i][0] -= 360; d -= 360; }
      while (d < -180) { pts[i][0] += 360; d += 360; }
    }
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      if (p[0] < minX) minX = p[0];
      if (p[0] > maxX) maxX = p[0];
      if (p[1] < minY) minY = p[1];
      if (p[1] > maxY) maxY = p[1];
    }
    const mid = (minX + maxX) / 2;
    const shift = mid > 180 ? -360 : mid < -180 ? 360 : 0;
    if (shift) {
      for (let i = 0; i < pts.length; i++) pts[i][0] += shift;
      minX += shift; maxX += shift;
    }
    // A pole inside the raster (polar projections): the outline wraps the whole globe.
    let pole = 0;
    const inv = transformer('EPSG:4326', raster.crs);
    [90, -90].forEach(function (lat) {
      const q = inv([0, lat]);
      if (!q || !isFinite(q[0]) || !isFinite(q[1])) return;
      const c = (q[0] - t[0]) / t[1], r = (q[1] - t[3]) / t[5];
      if (c >= 0 && c <= W && r >= 0 && r <= H) pole = lat;
    });
    if (pole) {
      minX = -180; maxX = 180;
      if (pole > 0) maxY = 90; else minY = -90;
      const ring = [[-180, minY], [180, minY], [180, maxY], [-180, maxY], [-180, minY]];
      return { ring: ring, bbox: [minX, minY, maxX, maxY], pole: pole };
    }
    pts.push([pts[0][0], pts[0][1]]);
    return { ring: pts, bbox: [minX, minY, maxX, maxY], pole: 0 };
  }

  /* ----------------------------------------------------- pixel mapping */

  /**
   * Maps output-grid pixel centres to fractional source pixel coordinates,
   * one row at a time: fillRow(j, cols, rows) fills Float64Arrays of length
   * outW (NaN where unmappable).
   */
  function separableMapper(colOf, rowOf) {
    return {
      fillRow: function (j, cols, rows) {
        cols.set(colOf);
        rows.fill(rowOf[j]);
      },
    };
  }

  function controlPositions(n, step) {
    const out = [];
    for (let i = 0; i < n - 1; i += step) out.push(i);
    out.push(n - 1);
    return Int32Array.from(out);
  }

  /**
   * Control-grid mapper: exact(i, j) is evaluated every 16 pixels and
   * interpolated bilinearly in between. Each cell is verified at its centre
   * and at its edge midpoints (edges shared with neighbours): where the
   * interpolation is off by more than 0.125 pixel of the coarser grid
   * (GDAL's default approximation error) — strong curvature near a pole, or
   * a discontinuity such as the ±180° seam of a lon/lat source — or where
   * corners are partly unmappable, the cell is evaluated exactly per pixel.
   * Cells with no mappable corner are left empty.
   */
  function gridMapper(outW, outH, exact) {
    const step = 16, TOL = 0.125;
    const xs = controlPositions(outW, step), ys = controlPositions(outH, step);
    const nx = xs.length, ny = ys.length;
    const gc = new Float64Array(nx * ny), gr = new Float64Array(nx * ny);
    for (let b = 0; b < ny; b++) {
      for (let a = 0; a < nx; a++) {
        const p = exact(xs[a], ys[b]);
        gc[b * nx + a] = p ? p[0] : NaN;
        gr[b * nx + a] = p ? p[1] : NaN;
      }
    }
    // Per cell: 0 = interpolate, 1 = exact per pixel, 2 = unmappable; plus its tolerance in source pixels.
    const cx = Math.max(1, nx - 1), cy = Math.max(1, ny - 1);
    const mode = new Uint8Array(cx * cy);
    const tolOf = new Float64Array(cx * cy).fill(TOL);
    const off = function (p, ic, ir, tol) { return !p || !(Math.abs(p[0] - ic) <= tol && Math.abs(p[1] - ir) <= tol); };
    const mark = function (a, b) { if (a >= 0 && a < cx && b >= 0 && b < cy && mode[b * cx + a] === 0) mode[b * cx + a] = 1; };
    // Source pixels per output pixel along an edge (Infinity for a zero-length edge).
    const scale = function (k1, k2, span) { return span > 0 ? Math.hypot(gc[k2] - gc[k1], gr[k2] - gr[k1]) / span : Infinity; };
    for (let b = 0; b < cy; b++) {
      const b1 = ny > 1 ? b + 1 : b;
      for (let a = 0; a < cx; a++) {
        const a1 = nx > 1 ? a + 1 : a;
        const cell = b * cx + a;
        const k00 = b * nx + a, k10 = b * nx + a1, k01 = b1 * nx + a, k11 = b1 * nx + a1;
        const ok = (isFinite(gc[k00]) ? 1 : 0) + (isFinite(gc[k10]) ? 1 : 0) + (isFinite(gc[k01]) ? 1 : 0) + (isFinite(gc[k11]) ? 1 : 0);
        if (ok === 0) { mode[cell] = 2; continue; }
        if (ok < 4) { mode[cell] = 1; continue; }
        const i0 = xs[a], i1 = xs[a1], j0 = ys[b], j1 = ys[b1];
        if (i1 - i0 < 2 && j1 - j0 < 2) continue;
        // The smallest edge scale is immune to a seam crossing the cell (it can't cross all four edges).
        const s = Math.min(scale(k00, k10, i1 - i0), scale(k01, k11, i1 - i0), scale(k00, k01, j1 - j0), scale(k10, k11, j1 - j0));
        const tol = tolOf[cell] = s > 1 && isFinite(s) ? TOL * s : TOL;
        const i = (i0 + i1) >> 1, j = (j0 + j1) >> 1;
        const fx = i1 > i0 ? (i - i0) / (i1 - i0) : 0, fy = j1 > j0 ? (j - j0) / (j1 - j0) : 0;
        const ic = (gc[k00] * (1 - fx) + gc[k10] * fx) * (1 - fy) + (gc[k01] * (1 - fx) + gc[k11] * fx) * fy;
        const ir = (gr[k00] * (1 - fx) + gr[k10] * fx) * (1 - fy) + (gr[k01] * (1 - fx) + gr[k11] * fx) * fy;
        if (off(exact(i, j), ic, ir, tol)) mode[cell] = 1;
      }
    }
    // Edge midpoints catch what a centre test misses (e.g. harmonic functions like longitude near a pole).
    const interp = function (a, b) { return a >= 0 && a < cx && b >= 0 && b < cy && mode[b * cx + a] === 0; };
    const edgeTol = function (a1, b1, a2, b2) {
      return Math.min(interp(a1, b1) ? tolOf[b1 * cx + a1] : Infinity, interp(a2, b2) ? tolOf[b2 * cx + a2] : Infinity);
    };
    for (let b = 0; b < ny; b++) {                       // horizontal edges: cells above (b-1) and below (b)
      for (let a = 0; a < nx - 1; a++) {
        const i0 = xs[a], i1 = xs[a + 1], k0 = b * nx + a, k1 = k0 + 1;
        if (i1 - i0 < 2 || (!interp(a, b - 1) && !interp(a, b))) continue;
        const i = (i0 + i1) >> 1, f = (i - i0) / (i1 - i0);
        if (off(exact(i, ys[b]), gc[k0] + (gc[k1] - gc[k0]) * f, gr[k0] + (gr[k1] - gr[k0]) * f, edgeTol(a, b - 1, a, b))) { mark(a, b - 1); mark(a, b); }
      }
    }
    for (let b = 0; b < ny - 1; b++) {                   // vertical edges: cells left (a-1) and right (a)
      for (let a = 0; a < nx; a++) {
        const j0 = ys[b], j1 = ys[b + 1], k0 = b * nx + a, k1 = k0 + nx;
        if (j1 - j0 < 2 || (!interp(a - 1, b) && !interp(a, b))) continue;
        const j = (j0 + j1) >> 1, f = (j - j0) / (j1 - j0);
        if (off(exact(xs[a], j), gc[k0] + (gc[k1] - gc[k0]) * f, gr[k0] + (gr[k1] - gr[k0]) * f, edgeTol(a - 1, b, a, b))) { mark(a - 1, b); mark(a, b); }
      }
    }
    const vc = new Float64Array(nx), vr = new Float64Array(nx);
    return {
      fillRow: function (j, cols, rows) {
        let b = ny > 1 ? Math.min(Math.floor(j / step), ny - 2) : 0;
        while (b < ny - 2 && j > ys[b + 1]) b++;
        const fy = ny > 1 ? (j - ys[b]) / (ys[b + 1] - ys[b]) : 0;
        const top = b * nx, bot = ny > 1 ? top + nx : top;
        for (let a = 0; a < nx; a++) {
          vc[a] = gc[top + a] + (gc[bot + a] - gc[top + a]) * fy;
          vr[a] = gr[top + a] + (gr[bot + a] - gr[top + a]) * fy;
        }
        for (let a = 0; a < cx; a++) {
          const i0 = xs[a], i1 = nx > 1 ? xs[a + 1] : xs[a];
          const m = mode[b * cx + a];
          if (m === 0) {
            const span = i1 - i0 || 1;
            const c0 = vc[a], r0 = vr[a];
            const a1 = nx > 1 ? a + 1 : a;
            const dc = (vc[a1] - c0) / span, dr = (vr[a1] - r0) / span;
            for (let i = i0; i <= i1; i++) {
              const u = i - i0;
              cols[i] = c0 + dc * u;
              rows[i] = r0 + dr * u;
            }
          } else if (m === 2) {
            for (let i = i0; i <= i1; i++) { cols[i] = NaN; rows[i] = NaN; }
          } else {
            for (let i = i0; i <= i1; i++) {
              const p = exact(i, j);
              cols[i] = p ? p[0] : NaN;
              rows[i] = p ? p[1] : NaN;
            }
          }
        }
      },
    };
  }

  /**
   * Mapper from the pixel centres of `target` ({ width, height, transform, crs })
   * to fractional pixel coordinates of `src` (a raster).
   */
  function pixelMapper(target, src) {
    const tt = target.transform, st = src.transform;
    const W = target.width, H = target.height;
    const tk = crsKind(target.crs), sk = crsKind(src.crs);
    const sW = src.width;
    const wrapCols = sk === 'lonlat' ? 360 / st[1] : 0;
    const wrap = function (c) {
      if (!wrapCols || (c >= 0 && c < sW)) return c;
      const c2 = c < 0 ? c + wrapCols : c - wrapCols;
      return c2 >= 0 && c2 < sW ? c2 : c;
    };
    const colOf = new Float64Array(W), rowOf = new Float64Array(H);
    if (sameCrs(target.crs, src.crs)) {
      for (let i = 0; i < W; i++) colOf[i] = (tt[0] + (i + 0.5) * tt[1] - st[0]) / st[1];
      for (let j = 0; j < H; j++) rowOf[j] = (tt[3] + (j + 0.5) * tt[5] - st[3]) / st[5];
      return separableMapper(colOf, rowOf);
    }
    if (tk === 'merc' && sk === 'lonlat') {
      for (let i = 0; i < W; i++) colOf[i] = wrap((xToLng(tt[0] + (i + 0.5) * tt[1]) - st[0]) / st[1]);
      for (let j = 0; j < H; j++) rowOf[j] = (yToLat(tt[3] + (j + 0.5) * tt[5]) - st[3]) / st[5];
      return separableMapper(colOf, rowOf);
    }
    if (tk === 'lonlat' && sk === 'merc') {
      for (let i = 0; i < W; i++) colOf[i] = (lngToX(tt[0] + (i + 0.5) * tt[1]) - st[0]) / st[1];
      for (let j = 0; j < H; j++) rowOf[j] = (latToY(tt[3] + (j + 0.5) * tt[5]) - st[3]) / st[5];
      return separableMapper(colOf, rowOf);
    }
    const tf = transformer(target.crs, src.crs);
    return gridMapper(W, H, function (i, j) {
      const p = tf([tt[0] + (i + 0.5) * tt[1], tt[3] + (j + 0.5) * tt[5]]);
      if (!p || !isFinite(p[0]) || !isFinite(p[1])) return null;
      return [wrap((p[0] - st[0]) / st[1]), (p[1] - st[3]) / st[5]];
    });
  }

  /**
   * Fill idx (Int32Array) with nearest source pixel indices for one mapped
   * row (-1 outside); returns how many fall inside.
   */
  function nearestRow(cols, rows, n, sW, sH, idx) {
    let inside = 0;
    for (let i = 0; i < n; i++) {
      const c = cols[i], r = rows[i];
      if (c >= 0 && c < sW && r >= 0 && r < sH) {
        idx[i] = (r | 0) * sW + (c | 0);
        inside++;
      } else {
        idx[i] = -1;
      }
    }
    return inside;
  }

  /**
   * Bilinear value at fractional pixel position (c, r) (pixel centres at +0.5),
   * with edge clamping; no-data neighbours are left out and the weights
   * renormalised. NaN if nothing valid.
   */
  function bilinearAt(arr, W, H, nd, c, r) {
    const x = c - 0.5, y = r - 0.5;
    const xf = Math.floor(x), yf = Math.floor(y);
    const fx = x - xf, fy = y - yf;
    const xa = xf < 0 ? 0 : xf > W - 1 ? W - 1 : xf;
    const xb = xf + 1 < 0 ? 0 : xf + 1 > W - 1 ? W - 1 : xf + 1;
    const ya = yf < 0 ? 0 : yf > H - 1 ? H - 1 : yf;
    const yb = yf + 1 < 0 ? 0 : yf + 1 > H - 1 ? H - 1 : yf + 1;
    let sum = 0, ws = 0, v, w;
    v = arr[ya * W + xa]; w = (1 - fx) * (1 - fy);
    if (w > 0 && v === v && v !== nd) { sum += v * w; ws += w; }
    v = arr[ya * W + xb]; w = fx * (1 - fy);
    if (w > 0 && v === v && v !== nd) { sum += v * w; ws += w; }
    v = arr[yb * W + xa]; w = (1 - fx) * fy;
    if (w > 0 && v === v && v !== nd) { sum += v * w; ws += w; }
    v = arr[yb * W + xb]; w = fx * fy;
    if (w > 0 && v === v && v !== nd) { sum += v * w; ws += w; }
    return ws > 0 ? sum / ws : NaN;
  }

  /** Where a lon/lat falls in the raster, as fractional [col, row] (may be outside), or null. */
  function locate(raster, lng, lat) {
    const t = raster.transform;
    const kind = crsKind(raster.crs);
    let x, y;
    if (kind === 'lonlat') {
      x = lng; y = lat;
      const c = (x - t[0]) / t[1];
      if (c < 0 || c >= raster.width) {
        const alt = c < 0 ? c + 360 / t[1] : c - 360 / t[1];
        if (alt >= 0 && alt < raster.width) x += c < 0 ? 360 : -360;
      }
    } else if (kind === 'merc') {
      x = lngToX(lng); y = latToY(lat);
    } else {
      const q = transformer('EPSG:4326', raster.crs)([lng, lat]);
      if (!q || !isFinite(q[0]) || !isFinite(q[1])) return null;
      x = q[0]; y = q[1];
    }
    return [(x - t[0]) / t[1], (y - t[3]) / t[5]];
  }

  /** Normalise a grid spec { width, height, transform | bbox, crs }. */
  function gridSpec(g, fallbackCrs) {
    if (!g) throw new Error('No target grid given');
    const width = g.width, height = g.height;
    if (!Number.isInteger(width) || width < 1 || !Number.isInteger(height) || height < 1) {
      throw new Error('The target grid needs a positive whole-number width and height');
    }
    let t = g.transform;
    if (t) {
      if (t.length < 6 || !t.every(isNum)) throw new Error('The target grid transform must be 6 numbers');
      if (t[2] || t[4]) throw new Error('Rotated grids are not supported');
      t = t.slice(0, 6);
    } else if (g.bbox) {
      const b = g.bbox;
      if (!(b[2] > b[0]) || !(b[3] > b[1])) throw new Error('The target grid bbox is empty');
      t = [b[0], (b[2] - b[0]) / width, 0, b[3], 0, -(b[3] - b[1]) / height];
    } else {
      throw new Error('The target grid needs a transform or a bbox');
    }
    return { width: width, height: height, transform: t, crs: g.crs === undefined ? fallbackCrs : normCrs(g.crs) };
  }

  /* ------------------------------------------------------ polygon fill */

  /** Rings of a (Multi)Polygon / GeometryCollection, or null. */
  function polygonRings(geom, out) {
    out = out || [];
    if (!geom) return out;
    if (geom.type === 'Polygon') {
      for (let i = 0; i < geom.coordinates.length; i++) out.push(geom.coordinates[i]);
    } else if (geom.type === 'MultiPolygon') {
      for (let p = 0; p < geom.coordinates.length; p++) {
        for (let i = 0; i < geom.coordinates[p].length; i++) out.push(geom.coordinates[p][i]);
      }
    } else if (geom.type === 'GeometryCollection') {
      for (let g = 0; g < geom.geometries.length; g++) polygonRings(geom.geometries[g], out);
    }
    return out;
  }

  /** Lon/lat rings -> Float64Array rings in the raster's pixel space. */
  function ringsToPixels(rings, tf, t) {
    const out = [];
    for (let i = 0; i < rings.length; i++) {
      const ring = rings[i];
      if (!ring || ring.length < 3) continue;
      const a = new Float64Array(ring.length * 2);
      for (let k = 0; k < ring.length; k++) {
        const q = tf === identityTf ? ring[k] : tf(ring[k]);
        a[2 * k] = (q[0] - t[0]) / t[1];
        a[2 * k + 1] = (q[1] - t[3]) / t[5];
      }
      out.push(a);
    }
    return out;
  }

  /**
   * Scanline polygon filler on pixel centres (even-odd rule, so holes and
   * multipolygon parts just work). scan(rings) returns the number of spans
   * and leaves [row, c0, c1) triplets in .spans.
   */
  function createScanner(W, H) {
    let cap = 0, ex, ey0, ey1, sl, order, active, xs;
    const sc = { spans: new Int32Array(3 * 256) };
    const ensure = function (n) {
      if (n <= cap) return;
      cap = Math.max(n, cap * 2, 64);
      ex = new Float64Array(cap); ey0 = new Float64Array(cap); ey1 = new Float64Array(cap); sl = new Float64Array(cap);
      order = new Int32Array(cap); active = new Int32Array(cap); xs = new Float64Array(cap);
    };
    const cmp = function (a, b) { return ey0[a] - ey0[b]; };
    sc.scan = function (rings) {
      let total = 0;
      for (let i = 0; i < rings.length; i++) total += rings[i].length >> 1;
      ensure(total + 1);
      let ne = 0, minY = Infinity, maxY = -Infinity;
      for (let i = 0; i < rings.length; i++) {
        const ring = rings[i];
        const m = ring.length >> 1;
        if (m < 3) continue;
        for (let k = 0; k < m; k++) {
          const k2 = k + 1 === m ? 0 : k + 1;
          const x1 = ring[2 * k], y1 = ring[2 * k + 1], x2 = ring[2 * k2], y2 = ring[2 * k2 + 1];
          if (y1 === y2 || !(isFinite(x1) && isFinite(y1) && isFinite(x2) && isFinite(y2))) continue;
          if (y1 < y2) { ey0[ne] = y1; ey1[ne] = y2; ex[ne] = x1; } else { ey0[ne] = y2; ey1[ne] = y1; ex[ne] = x2; }
          sl[ne] = (x2 - x1) / (y2 - y1);
          if (ey0[ne] < minY) minY = ey0[ne];
          if (ey1[ne] > maxY) maxY = ey1[ne];
          ne++;
        }
      }
      if (!ne) return 0;
      const r0 = Math.max(0, Math.ceil(minY - 0.5)), r1 = Math.min(H - 1, Math.ceil(maxY - 0.5) - 1);
      if (r1 < r0) return 0;
      for (let e = 0; e < ne; e++) order[e] = e;
      const ord = order.subarray(0, ne);
      ord.sort(cmp);
      let ptr = 0, na = 0, ns = 0;
      let spans = sc.spans;
      for (let r = r0; r <= r1; r++) {
        const yc = r + 0.5;
        while (ptr < ne && ey0[ord[ptr]] <= yc) active[na++] = ord[ptr++];
        let m = 0, w = 0;
        for (let a = 0; a < na; a++) {
          const e = active[a];
          if (ey1[e] <= yc) continue;
          active[w++] = e;
          xs[m++] = ex[e] + (yc - ey0[e]) * sl[e];
        }
        na = w;
        if (m < 2) continue;
        if (m <= 24) {
          for (let a = 1; a < m; a++) {
            const v = xs[a];
            let b = a - 1;
            while (b >= 0 && xs[b] > v) { xs[b + 1] = xs[b]; b--; }
            xs[b + 1] = v;
          }
        } else {
          xs.subarray(0, m).sort();
        }
        for (let q = 0; q + 1 < m; q += 2) {
          let c0 = Math.ceil(xs[q] - 0.5), c1 = Math.ceil(xs[q + 1] - 0.5);
          if (c0 < 0) c0 = 0;
          if (c1 > W) c1 = W;
          if (c1 <= c0) continue;
          if (3 * ns + 3 > spans.length) {
            const grown = new Int32Array(spans.length * 2);
            grown.set(spans);
            spans = sc.spans = grown;
          }
          spans[3 * ns] = r; spans[3 * ns + 1] = c0; spans[3 * ns + 2] = c1;
          ns++;
        }
      }
      return ns;
    };
    return sc;
  }

  /** Point used to sample a geometry: the point itself, a line's first vertex, a polygon's centroid. */
  function representativePoint(g) {
    if (!g) return null;
    const c = g.coordinates;
    switch (g.type) {
      case 'Point': return c;
      case 'MultiPoint': case 'LineString': return c && c[0];
      case 'MultiLineString': return c && c[0] && c[0][0];
      case 'Polygon': return ringCentroid(c && c[0]);
      case 'MultiPolygon': {
        let best = null, bestA = -1;
        for (let i = 0; i < (c || []).length; i++) {
          const a = Math.abs(ringArea(c[i][0]));
          if (a > bestA) { bestA = a; best = c[i][0]; }
        }
        return ringCentroid(best);
      }
      case 'GeometryCollection': return g.geometries && g.geometries.length ? representativePoint(g.geometries[0]) : null;
      default: return null;
    }
  }
  function ringArea(ring) {
    let a = 0;
    if (!ring) return 0;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) a += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
    return a / 2;
  }
  function ringCentroid(ring) {
    if (!ring || !ring.length) return null;
    let a = 0, cx = 0, cy = 0;
    const x0 = ring[0][0], y0 = ring[0][1];
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const xi = ring[i][0] - x0, yi = ring[i][1] - y0, xj = ring[j][0] - x0, yj = ring[j][1] - y0;
      const f = xj * yi - xi * yj;
      a += f; cx += (xj + xi) * f; cy += (yj + yi) * f;
    }
    if (Math.abs(a) < 1e-18) {
      let sx = 0, sy = 0;
      for (let i = 0; i < ring.length; i++) { sx += ring[i][0]; sy += ring[i][1]; }
      return [sx / ring.length, sy / ring.length];
    }
    return [x0 + cx / (3 * a), y0 + cy / (3 * a)];
  }

  /* ============================================================ GeoTIFF */

  function tagValue(image, name) {
    const fd = image && image.fileDirectory;
    if (!fd) return undefined;
    if (typeof fd.getValue === 'function') {
      try { return fd.getValue(name); } catch (e) { return undefined; }
    }
    return fd[name];
  }

  async function loadTag(image, name) {
    const fd = image && image.fileDirectory;
    if (!fd) return undefined;
    if (typeof fd.loadValue === 'function') {
      try { return await fd.loadValue(name); } catch (e) { return undefined; }
    }
    return fd[name];
  }

  function toArrayBuffer(input) {
    if (input instanceof ArrayBuffer) return input;
    if (ArrayBuffer.isView(input)) return input.buffer.slice(input.byteOffset, input.byteOffset + input.byteLength);
    if (input && typeof SharedArrayBuffer !== 'undefined' && input instanceof SharedArrayBuffer) return input;
    throw new Error('Expected the GeoTIFF file contents as an ArrayBuffer');
  }

  // GeographicTypeGeoKey / GeogGeodeticDatumGeoKey codes -> proj4 datum/ellipsoid.
  const GRS80_0 = '+ellps=GRS80 +towgs84=0,0,0,0,0,0,0';
  const GEOG_DATUMS = {
    4326: '+datum=WGS84', 6326: '+datum=WGS84',
    4269: '+datum=NAD83', 6269: '+datum=NAD83',
    4267: '+datum=NAD27', 6267: '+datum=NAD27',
    4258: GRS80_0, 6258: GRS80_0, 4283: GRS80_0, 6283: GRS80_0, 7844: GRS80_0, 1168: GRS80_0,
    4617: GRS80_0, 6140: GRS80_0, 4152: GRS80_0, 6152: GRS80_0, 6318: GRS80_0, 1116: GRS80_0,
    4759: GRS80_0, 6759: GRS80_0, 4674: GRS80_0, 6674: GRS80_0, 4490: GRS80_0, 1043: GRS80_0,
    4612: GRS80_0, 6612: GRS80_0, 6668: GRS80_0, 1128: GRS80_0, 4167: GRS80_0, 6167: GRS80_0,
    4686: GRS80_0, 6686: GRS80_0,
    4148: '+ellps=WGS84 +towgs84=0,0,0,0,0,0,0', 6148: '+ellps=WGS84 +towgs84=0,0,0,0,0,0,0',
    4230: '+ellps=intl +towgs84=-87,-98,-121,0,0,0,0', 6230: '+ellps=intl +towgs84=-87,-98,-121,0,0,0,0',
    4277: '+ellps=airy +towgs84=446.448,-125.157,542.06,0.15,0.247,0.842,-20.489',
    6277: '+ellps=airy +towgs84=446.448,-125.157,542.06,0.15,0.247,0.842,-20.489',
    4322: '+ellps=WGS72 +towgs84=0,0,4.5,0,0,0.554,0.2263', 6322: '+ellps=WGS72 +towgs84=0,0,4.5,0,0,0.554,0.2263',
    4019: '+ellps=GRS80', 6019: '+ellps=GRS80', 4030: '+ellps=WGS84', 6030: '+ellps=WGS84',
    4035: '+R=6371000', 6035: '+R=6371000', 4047: '+R=6371007', 6047: '+R=6371007',
    4008: '+ellps=clrk66', 6008: '+ellps=clrk66', 4004: '+ellps=bessel', 6004: '+ellps=bessel',
    4022: '+ellps=intl', 6022: '+ellps=intl', 4001: '+ellps=airy', 6001: '+ellps=airy',
  };
  const ELLIPSOIDS = {
    7030: '+ellps=WGS84', 7019: '+ellps=GRS80', 7008: '+ellps=clrk66', 7012: '+ellps=clrk80',
    7004: '+ellps=bessel', 7022: '+ellps=intl', 7001: '+ellps=airy', 7043: '+ellps=WGS72',
    7024: '+ellps=krass', 7035: '+R=6371000', 7059: '+R=6378137',
  };
  const LINEAR_UNITS = { 9001: 1, 9002: 0.3048, 9003: 1200 / 3937, 9005: 0.3047972654, 9014: 1.8288, 9030: 1852, 9036: 1000, 9093: 1609.344, 9096: 0.9144 };
  const CT_NAMES = {
    1: 'Transverse Mercator', 3: 'Oblique Mercator', 7: 'Mercator', 8: 'Lambert Conformal Conic', 9: 'Lambert Conformal Conic',
    10: 'Lambert Azimuthal Equal Area', 11: 'Albers Equal Area', 12: 'Azimuthal Equidistant', 13: 'Equidistant Conic',
    14: 'Stereographic', 15: 'Polar Stereographic', 16: 'Oblique Stereographic', 17: 'Equirectangular', 18: 'Cassini-Soldner',
    19: 'Gnomonic', 20: 'Miller Cylindrical', 21: 'Orthographic', 22: 'Polyconic', 23: 'Robinson', 24: 'Sinusoidal',
    25: 'Van der Grinten', 26: 'New Zealand Map Grid', 28: 'Cylindrical Equal Area',
  };

  /** proj4 datum/ellipsoid part from geokeys, or null. */
  function geogPart(k) {
    const code = k.GeographicTypeGeoKey;
    if (code && GEOG_DATUMS[code]) return GEOG_DATUMS[code];
    const datum = k.GeogGeodeticDatumGeoKey;
    if (datum && GEOG_DATUMS[datum]) return GEOG_DATUMS[datum];
    const a = k.GeogSemiMajorAxisGeoKey;
    if (isNum(a) && a > 0) {
      const b = k.GeogSemiMinorAxisGeoKey, rf = k.GeogInvFlatteningGeoKey;
      if (isNum(rf) && rf > 0) return '+a=' + a + ' +rf=' + rf;
      if (isNum(b) && b > 0 && Math.abs(b - a) > 1e-9) return '+a=' + a + ' +b=' + b;
      return '+R=' + a;
    }
    const e = k.GeogEllipsoidGeoKey;
    if (e && ELLIPSOIDS[e]) return ELLIPSOIDS[e];
    return null;
  }

  function primeMeridian(k) {
    const pm = k.GeogPrimeMeridianLongGeoKey;
    return isNum(pm) && pm !== 0 ? ' +pm=' + pm : '';
  }

  function linearUnits(k) {
    const u = k.ProjLinearUnitsGeoKey;
    if (!u || u === 9001) return { part: '+units=m', toMeter: 1 };
    if (u === 9002) return { part: '+units=ft', toMeter: 0.3048 };
    if (u === 9003) return { part: '+units=us-ft', toMeter: 1200 / 3937 };
    const size = isNum(k.ProjLinearUnitSizeGeoKey) && k.ProjLinearUnitSizeGeoKey > 0 ? k.ProjLinearUnitSizeGeoKey : LINEAR_UNITS[u];
    return size ? { part: '+to_meter=' + size, toMeter: size } : { part: '+units=m', toMeter: 1 };
  }

  /** proj4 string for a user-defined projected CRS described by geokeys, or null. */
  function projectedProj4(k) {
    const geog = geogPart(k) || '+datum=WGS84';
    const u = linearUnits(k);
    const tail = ' ' + geog + primeMeridian(k) + ' ' + u.part + ' +no_defs';
    const pc = k.ProjectionGeoKey;
    if (pc >= 16001 && pc <= 16060) return '+proj=utm +zone=' + (pc - 16000) + tail;
    if (pc >= 16101 && pc <= 16160) return '+proj=utm +zone=' + (pc - 16100) + ' +south' + tail;
    const g = function () {
      for (let i = 0; i < arguments.length; i++) {
        const v = k[arguments[i] + 'GeoKey'];
        if (isNum(v)) return v;
      }
      return 0;
    };
    const has = function (name) { return isNum(k[name + 'GeoKey']); };
    const natLat = g('ProjNatOriginLat', 'ProjFalseOriginLat', 'ProjCenterLat');
    const natLon = g('ProjNatOriginLong', 'ProjFalseOriginLong', 'ProjCenterLong');
    const ctrLat = g('ProjCenterLat', 'ProjNatOriginLat', 'ProjFalseOriginLat');
    const ctrLon = g('ProjCenterLong', 'ProjNatOriginLong', 'ProjFalseOriginLong');
    const foLat = g('ProjFalseOriginLat', 'ProjNatOriginLat', 'ProjCenterLat');
    const foLon = g('ProjFalseOriginLong', 'ProjNatOriginLong', 'ProjCenterLong');
    const sp1 = g('ProjStdParallel1');
    const sp2 = has('ProjStdParallel2') ? g('ProjStdParallel2') : sp1;
    const k0 = has('ProjScaleAtNatOrigin') || has('ProjScaleAtCenter') ? g('ProjScaleAtNatOrigin', 'ProjScaleAtCenter') : 1;
    const fe = g('ProjFalseEasting', 'ProjFalseOriginEasting', 'ProjCenterEasting') * u.toMeter;
    const fn = g('ProjFalseNorthing', 'ProjFalseOriginNorthing', 'ProjCenterNorthing') * u.toMeter;
    let p;
    switch (k.ProjCoordTransGeoKey) {
      case 1: p = 'tmerc +lat_0=' + natLat + ' +lon_0=' + natLon + ' +k=' + k0; break;
      case 3: p = 'omerc +lat_0=' + ctrLat + ' +lonc=' + ctrLon + ' +alpha=' + g('ProjAzimuthAngle') +
        ' +gamma=' + g('ProjRectifiedGridAngle', 'ProjAzimuthAngle') + ' +k=' + k0 + ' +no_uoff'; break;
      case 7: p = 'merc +lon_0=' + natLon + (has('ProjStdParallel1') ? ' +lat_ts=' + sp1 : ' +k=' + k0); break;
      case 8: p = 'lcc +lat_1=' + sp1 + ' +lat_2=' + sp2 + ' +lat_0=' + foLat + ' +lon_0=' + foLon; break;
      case 9: p = 'lcc +lat_1=' + natLat + ' +lat_0=' + natLat + ' +lon_0=' + natLon + ' +k_0=' + k0; break;
      case 10: p = 'laea +lat_0=' + ctrLat + ' +lon_0=' + ctrLon; break;
      case 11: p = 'aea +lat_1=' + sp1 + ' +lat_2=' + sp2 + ' +lat_0=' + natLat + ' +lon_0=' + natLon; break;
      case 12: p = 'aeqd +lat_0=' + ctrLat + ' +lon_0=' + ctrLon; break;
      case 13: p = 'eqdc +lat_1=' + sp1 + ' +lat_2=' + sp2 + ' +lat_0=' + ctrLat + ' +lon_0=' + ctrLon; break;
      case 14: p = 'stere +lat_0=' + ctrLat + ' +lon_0=' + ctrLon + ' +k=' + k0; break;
      case 15: {
        const la = g('ProjNatOriginLat');
        const lon = g('ProjStraightVertPoleLong', 'ProjNatOriginLong', 'ProjCenterLong');
        p = 'stere +lat_0=' + (la < 0 ? -90 : 90) + (Math.abs(la) === 90 || !has('ProjNatOriginLat') ? ' +k_0=' + k0 : ' +lat_ts=' + la) + ' +lon_0=' + lon;
        break;
      }
      case 16: p = 'sterea +lat_0=' + natLat + ' +lon_0=' + natLon + ' +k=' + k0; break;
      case 17: p = 'eqc +lat_ts=' + sp1 + ' +lat_0=' + ctrLat + ' +lon_0=' + ctrLon; break;
      case 18: p = 'cass +lat_0=' + natLat + ' +lon_0=' + natLon; break;
      case 19: p = 'gnom +lat_0=' + ctrLat + ' +lon_0=' + ctrLon; break;
      case 20: p = 'mill +lat_0=' + ctrLat + ' +lon_0=' + ctrLon; break;
      case 21: p = 'ortho +lat_0=' + ctrLat + ' +lon_0=' + ctrLon; break;
      case 22: p = 'poly +lat_0=' + natLat + ' +lon_0=' + natLon; break;
      case 23: p = 'robin +lon_0=' + ctrLon; break;
      case 24: p = 'sinu +lon_0=' + ctrLon; break;
      case 25: p = 'vandg +lon_0=' + ctrLon; break;
      case 26: p = 'nzmg +lat_0=' + natLat + ' +lon_0=' + natLon; break;
      case 28: p = 'cea +lat_ts=' + sp1 + ' +lon_0=' + natLon; break;
      default: return null;
    }
    return '+proj=' + p + ' +x_0=' + fe + ' +y_0=' + fn + tail;
  }

  function wktFromCitations(k) {
    const keys = ['PCSCitationGeoKey', 'GTCitationGeoKey', 'GeogCitationGeoKey'];
    for (let i = 0; i < keys.length; i++) {
      const s = k[keys[i]];
      if (typeof s !== 'string') continue;
      const m = /ESRI PE String\s*=\s*((?:PROJCS|GEOGCS)\[[\s\S]*\])/i.exec(s);
      if (m) return m[1];
    }
    return null;
  }

  /**
   * CRS of a GeoTIFF from its geokeys:
   * { crs, name?, unknown?, needsLookup?, userDefined?, guessed? }.
   */
  function crsFromGeoKeys(k) {
    if (!k) return { crs: null, unknown: true };
    const C = crsLib();
    const pcs = k.ProjectedCSTypeGeoKey, gcs = k.GeographicTypeGeoKey, model = k.GTModelTypeGeoKey;
    const cit = [k.PCSCitationGeoKey, k.GTCitationGeoKey].filter(function (s) { return typeof s === 'string'; }).join(' | ');
    if (isNum(pcs) && pcs > 0 && pcs !== 32767) {
      const code = C.normalize('EPSG:' + pcs);
      return { crs: code, needsLookup: !C.has(code) };
    }
    if (/pseudo[\s_-]*mercator|web[\s_-]*mercator|auxiliary[\s_-]*sphere/i.test(cit)) return { crs: 'EPSG:3857' };
    const projected = model === 1 || pcs === 32767 || isNum(k.ProjCoordTransGeoKey) ||
      (isNum(k.ProjectionGeoKey) && k.ProjectionGeoKey !== 32767);
    if (projected) {
      const def = projectedProj4(k);
      if (def) {
        const pc = k.ProjectionGeoKey;
        const name = pc >= 16001 && pc <= 16160 ? 'UTM zone ' + (pc > 16100 ? pc - 16100 + 'S' : pc - 16000 + 'N') :
          (CT_NAMES[k.ProjCoordTransGeoKey] || 'Projected');
        return { crs: def, name: name + ' (user-defined)', userDefined: true };
      }
      const wkt = wktFromCitations(k);
      if (wkt) {
        try {
          const code = C.fromWKT(wkt);
          if (code) return { crs: code, userDefined: true };
        } catch (e) { /* fall through */ }
      }
      return { crs: null, unknown: true };
    }
    if (model === 3) return { crs: null, unknown: true };   // geocentric
    if (isNum(gcs) && gcs > 0 && gcs !== 32767) {
      const code = 'EPSG:' + gcs;
      if (C.has(code)) return { crs: C.normalize(code) };
      const part = geogPart(k);
      if (part) return { crs: '+proj=longlat ' + part + primeMeridian(k) + ' +no_defs', name: (k.GeogCitationGeoKey || code) + ' (lon/lat)', epsg: gcs };
      return { crs: code, needsLookup: true };
    }
    if (gcs === 32767) {
      const part = geogPart(k);
      const pm = primeMeridian(k);
      if (part === '+datum=WGS84' && !pm) return { crs: 'EPSG:4326' };
      if (part) return { crs: '+proj=longlat ' + part + pm + ' +no_defs', name: 'Geographic lon/lat (user-defined)', userDefined: true };
      return { crs: 'EPSG:4326', guessed: true };
    }
    if (model === 2) return { crs: 'EPSG:4326' };
    const wkt = wktFromCitations(k);
    if (wkt) {
      try {
        const code = C.fromWKT(wkt);
        if (code) return { crs: code, userDefined: true };
      } catch (e) { /* ignore */ }
    }
    return { crs: null, unknown: true };
  }

  /** Least-squares affine geotransform from ModelTiepoint GCPs (>= 3 points). */
  function fitGCPs(tp) {
    const n = Math.floor(tp.length / 6);
    if (n < 3) return null;
    // Normal equations for [1, i, j] -> x and -> y.
    const A = [[0, 0, 0], [0, 0, 0], [0, 0, 0]], bx = [0, 0, 0], by = [0, 0, 0];
    for (let g = 0; g < n; g++) {
      const v = [1, tp[6 * g], tp[6 * g + 1]], x = tp[6 * g + 3], y = tp[6 * g + 4];
      for (let r = 0; r < 3; r++) {
        for (let c = 0; c < 3; c++) A[r][c] += v[r] * v[c];
        bx[r] += v[r] * x;
        by[r] += v[r] * y;
      }
    }
    const solve = function (b) {
      const m = A.map(function (row, i) { return row.concat([b[i]]); });
      for (let c = 0; c < 3; c++) {
        let p = c;
        for (let r = c + 1; r < 3; r++) if (Math.abs(m[r][c]) > Math.abs(m[p][c])) p = r;
        if (Math.abs(m[p][c]) < 1e-12) return null;
        const t = m[c]; m[c] = m[p]; m[p] = t;
        for (let r = 0; r < 3; r++) {
          if (r === c) continue;
          const f = m[r][c] / m[c][c];
          for (let k = c; k < 4; k++) m[r][k] -= f * m[c][k];
        }
      }
      return [m[0][3] / m[0][0], m[1][3] / m[1][1], m[2][3] / m[2][2]];
    };
    const sx = solve(bx), sy = solve(by);
    if (!sx || !sy) return null;
    return [sx[0], sx[1], sx[2], sy[0], sy[1], sy[2]];
  }

  function geoTransformFromTags(image, keys, warnings) {
    const mt = tagValue(image, 'ModelTransformation');
    const tp = tagValue(image, 'ModelTiepoint');
    const ps = tagValue(image, 'ModelPixelScale');
    let gt = null;
    if (mt && mt.length >= 16) {
      gt = [mt[3], mt[0], mt[1], mt[7], mt[4], mt[5]];
    } else if (tp && tp.length >= 6 && ps && ps.length >= 2 && ps[0] && ps[1]) {
      gt = [tp[3] - tp[0] * ps[0], ps[0], 0, tp[4] + tp[1] * ps[1], 0, -ps[1]];
    } else if (tp && tp.length >= 18) {
      gt = fitGCPs(tp);
      if (gt) warnings.push('This raster is georeferenced with control points; PSICITS fitted a simple grid to them, so positions are approximate.');
    }
    if (!gt || !gt.every(isNum)) return null;
    if (keys && keys.GTRasterTypeGeoKey === 2) {       // PixelIsPoint: GDAL convention
      gt[0] -= 0.5 * (gt[1] + gt[2]);
      gt[3] -= 0.5 * (gt[4] + gt[5]);
    }
    return gt;
  }

  /** Nearest-neighbour decimation of an image to tw x th, reading it in row windows (bounded memory). */
  async function readDecimated(img, tw, th) {
    const sw = img.getWidth(), sh = img.getHeight();
    const blockH = Math.max(1, img.getTileHeight ? img.getTileHeight() : 1);
    const rowsPerChunk = Math.max(blockH, Math.floor(4e6 / sw / blockH) * blockH);
    const colMap = new Int32Array(tw), rowMap = new Int32Array(th);
    for (let i = 0; i < tw; i++) colMap[i] = Math.min(sw - 1, Math.floor(((i + 0.5) * sw) / tw));
    for (let j = 0; j < th; j++) rowMap[j] = Math.min(sh - 1, Math.floor(((j + 0.5) * sh) / th));
    let out = null, j = 0;
    for (let r0 = 0; r0 < sh && j < th; r0 += rowsPerChunk) {
      const r1 = Math.min(sh, r0 + rowsPerChunk);
      if (rowMap[j] >= r1) continue;
      const data = await img.readRasters({ window: [0, r0, sw, r1] });
      if (!out) out = Array.from(data, function (a) { return new a.constructor(tw * th); });
      while (j < th && rowMap[j] < r1) {
        const so = (rowMap[j] - r0) * sw, oo = j * tw;
        for (let b = 0; b < out.length; b++) {
          const s = data[b], o = out[b];
          for (let i = 0; i < tw; i++) o[oo + i] = s[so + colMap[i]];
        }
        j++;
      }
    }
    return out;
  }

  /**
   * Read pixels, using the best overview (COG) or windowed decimation above
   * maxPixels, plus the matching internal transparency mask if there is one:
   * { bands, width, height, level, mask (0 = masked out) | null }.
   */
  async function readPixels(tiff, image, maxPixels) {
    const W = image.getWidth(), H = image.getHeight(), spp = image.getSamplesPerPixel();
    let count = 1;
    try { count = await tiff.getImageCount(); } catch (e) { count = 1; }
    const pages = [];
    for (let i = 1; i < count; i++) {
      let im;
      try { im = await tiff.getImage(i); } catch (e) { break; }
      pages.push({ im: im, index: i, nst: tagValue(im, 'NewSubfileType') || 0, st: tagValue(im, 'SubfileType') });
    }
    let src = image, level = 0, tw = W, th = H;
    if (W * H > maxPixels) {
      const f = Math.sqrt(maxPixels / (W * H));
      tw = Math.max(1, Math.floor(W * f));
      th = Math.max(1, Math.floor(H * f));
      for (let k = 0; k < pages.length; k++) {
        const p = pages[k];
        if ((p.nst & 4) || !((p.nst & 1) || p.st === 2)) continue;     // skip masks and unrelated pages
        if (p.im.getSamplesPerPixel() !== spp) continue;
        const w = p.im.getWidth(), h = p.im.getHeight();
        if (w >= tw && h >= th && w < src.getWidth()) { src = p.im; level = p.index; }
      }
    }
    const sw = src.getWidth(), sh = src.getHeight();
    const direct = sw * sh <= maxPixels;
    const read = function (im) { return direct ? im.readRasters() : readDecimated(im, tw, th); };
    const bands = await read(src);
    let mask = null;
    for (let k = 0; k < pages.length; k++) {
      const p = pages[k];
      if ((p.nst & 4) && p.im.getWidth() === sw && p.im.getHeight() === sh && p.im.getSamplesPerPixel() === 1) {
        try { mask = (await read(p.im))[0]; } catch (e) { mask = null; }
        break;
      }
    }
    return { bands: bands, width: direct ? sw : tw, height: direct ? sh : th, level: level, mask: mask };
  }

  function cmykToRgb(C, Mg, Y, K) {
    const n = C.length;
    const r = new Uint8Array(n), g = new Uint8Array(n), b = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      const k = 255 - K[i];
      r[i] = Math.round(((255 - C[i]) * k) / 255);
      g[i] = Math.round(((255 - Mg[i]) * k) / 255);
      b[i] = Math.round(((255 - Y[i]) * k) / 255);
    }
    return [r, g, b];
  }

  function ycbcrToRgb(Y, Cb, Cr) {
    const n = Y.length;
    const r = new Uint8Array(n), g = new Uint8Array(n), b = new Uint8Array(n);
    const c8 = function (v) { return v < 0 ? 0 : v > 255 ? 255 : Math.round(v); };
    for (let i = 0; i < n; i++) {
      const y = Y[i], cb = Cb[i] - 128, cr = Cr[i] - 128;
      r[i] = c8(y + 1.402 * cr);
      g[i] = c8(y - 0.344136 * cb - 0.714136 * cr);
      b[i] = c8(y + 1.772 * cb);
    }
    return [r, g, b];
  }

  /** Resample a rotated/sheared/flipped grid into a north-up grid (nearest neighbour). */
  function unrotate(bands, W, H, gt, fill) {
    const cx = [0, W, 0, W], cy = [0, 0, H, H];
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let k = 0; k < 4; k++) {
      const x = gt[0] + cx[k] * gt[1] + cy[k] * gt[2], y = gt[3] + cx[k] * gt[4] + cy[k] * gt[5];
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
    const det = gt[1] * gt[5] - gt[2] * gt[4];
    if (!det || !isFinite(det)) throw new Error('This GeoTIFF\'s georeferencing is invalid (its pixels have no area)');
    const s = Math.sqrt(Math.abs(det));
    const ow = Math.max(1, Math.round((maxX - minX) / s)), oh = Math.max(1, Math.round((maxY - minY) / s));
    const sx = (maxX - minX) / ow, sy = (maxY - minY) / oh;
    const out = bands.map(function (b) { return new b.constructor(ow * oh); });
    for (let j = 0; j < oh; j++) {
      const y = maxY - (j + 0.5) * sy - gt[3];
      for (let i = 0; i < ow; i++) {
        const x = minX + (i + 0.5) * sx - gt[0];
        const c = Math.floor((gt[5] * x - gt[2] * y) / det), r = Math.floor((-gt[4] * x + gt[1] * y) / det);
        const o = j * ow + i;
        const inside = c >= 0 && c < W && r >= 0 && r < H;
        for (let b = 0; b < out.length; b++) out[b][o] = inside ? bands[b][r * W + c] : fill;
      }
    }
    return { bands: out, width: ow, height: oh, transform: [minX, sx, 0, maxY, 0, -sy] };
  }

  /**
   * Read a GeoTIFF (including Cloud-Optimized GeoTIFFs) into a Raster.
   *
   * - First image only. When width*height > maxPixels it is read at reduced
   *   size: the coarsest overview that is still at least the target size is
   *   used (COGs), and decimated in row windows if needed, so memory stays
   *   bounded. meta.downsample records the factor, meta.fullSize the original size.
   * - CRS from geokeys: EPSG codes as 'EPSG:n'; user-defined projections are
   *   turned into proj4 strings (stored as raster.crs); nothing usable ->
   *   crs null + meta.crsUnknown. meta.crsNeedsLookup is set when the EPSG
   *   code isn't built in (call `await PSICITS.crs.ensure(raster.crs)` before rendering).
   * - noData from GDAL_NODATA, band names from GDAL_METADATA descriptions
   *   (SCALE/OFFSET are recorded in meta.scale/meta.offset, not applied),
   *   palette images -> meta.colormap [[r,g,b], ...], alpha extra sample ->
   *   meta.alphaBand, internal GDAL masks -> no-data (or an alpha band named
   *   'mask' for integer data without a no-data value), YCbCr (JPEG) and CMYK
   *   -> RGB, rotated grids are resampled north-up (meta.warnings says so).
   *
   * @param {ArrayBuffer|Uint8Array} input file contents
   * @param {{maxPixels?: number, name?: string, meta?: object}} [opts] maxPixels defaults to 16e6
   * @returns {Promise<object>} Raster
   */
  async function fromGeoTIFF(input, opts) {
    const o = opts || {};
    const G = root.GeoTIFF;
    if (!G || typeof G.fromArrayBuffer !== 'function') throw new Error('GeoTIFF support is not loaded');
    const ab = toArrayBuffer(input);
    let tiff, image;
    try {
      tiff = await G.fromArrayBuffer(ab);
      image = await tiff.getImage(0);
    } catch (e) {
      throw new Error('This file could not be read as a GeoTIFF (' + errText(e) + ')');
    }
    const W = image.getWidth(), H = image.getHeight(), spp = image.getSamplesPerPixel();
    if (!(W > 0 && H > 0)) throw new Error('This GeoTIFF has no pixels');
    const warnings = [];
    let keys = null;
    try { keys = image.getGeoKeys(); } catch (e) { keys = null; }
    const gt0 = geoTransformFromTags(image, keys, warnings);
    const crsInfo = crsFromGeoKeys(keys);
    let noData = null;
    try { noData = image.getGDALNoData(); } catch (e) { noData = null; }
    if (noData !== null && !isNum(noData)) noData = null;   // "nan" -> NaN pixels count as no-data anyway
    const photometric = tagValue(image, 'PhotometricInterpretation');
    const maxPixels = isNum(o.maxPixels) && o.maxPixels > 0 ? o.maxPixels : 16e6;

    let read;
    try {
      read = await readPixels(tiff, image, maxPixels);
    } catch (e) {
      const msg = errText(e);
      if (/compression/i.test(msg)) throw new Error('This GeoTIFF uses a compression method PSICITS can\'t decode (' + msg + ')');
      if (/bitsPerSample|data format/i.test(msg)) throw new Error('This GeoTIFF stores a pixel type PSICITS can\'t read (' + msg + ')');
      throw new Error('Could not read the pixels of this GeoTIFF (' + msg + ')');
    }
    let bands = Array.from(read.bands);
    let width = read.width, height = read.height;

    const meta = Object.assign({}, o.meta || {});
    if (o.name) meta.name = o.name;
    meta.format = 'GeoTIFF';
    meta.compression = tagValue(image, 'Compression') || 1;
    if (photometric !== undefined) meta.photometric = photometric;
    // Stored sample type when it isn't one of the model's types (Int8, 1/4/12-bit, Float16 ...).
    const bps = tagValue(image, 'BitsPerSample'), sfmt = tagValue(image, 'SampleFormat');
    const bits = bps && bps[0], fmt = sfmt && sfmt[0] ? sfmt[0] : 1;
    const stored = (fmt === 3 ? 'float' : fmt === 2 ? 'int' : 'uint') + bits;
    if (bits && !TYPED[stored]) meta.sourceDataType = stored;
    if (width !== W || height !== H) {
      meta.downsample = Math.max(W / width, H / height);
      meta.fullSize = [W, H];
      if (read.level) meta.overviewLevel = read.level;
    }

    // Colour models (geotiff.js hands back the raw samples).
    let colorShift = 0;                 // bands removed by a colour conversion (CMYK -> RGB)
    if (photometric === 6 && bands.length >= 3) {
      bands = ycbcrToRgb(bands[0], bands[1], bands[2]).concat(bands.slice(3));
      meta.convertedFrom = 'YCbCr';
    } else if (photometric === 5 && bands.length >= 4 && typeOfArray(bands[0]) === 'uint8') {
      bands = cmykToRgb(bands[0], bands[1], bands[2], bands[3]).concat(bands.slice(4));
      meta.convertedFrom = 'CMYK';
      colorShift = 1;
    }
    bands = bands.map(function (b) { return b instanceof Int8Array ? Int16Array.from(b) : b; });

    let alphaBand = -1;
    const extra = tagValue(image, 'ExtraSamples');
    if (extra && extra.length) {
      for (let e = 0; e < extra.length; e++) {
        if (extra[e] === 1 || extra[e] === 2) { alphaBand = spp - extra.length + e - colorShift; break; }
      }
    }
    if (alphaBand >= bands.length) alphaBand = -1;

    // Internal transparency mask (GDAL): masked pixels become no-data, or an alpha band.
    let maskBand = -1;
    if (read.mask && alphaBand < 0) {
      const mk = read.mask, n = mk.length;
      const dt = typeOfArray(bands[0]);
      if ((noData !== null && fitsType(noData, dt)) || !isIntType(dt)) {
        const fill = noData !== null && fitsType(noData, dt) ? noData : NaN;
        for (let b = 0; b < bands.length; b++) {
          const arr = bands[b];
          for (let i = 0; i < n; i++) if (!mk[i]) arr[i] = fill;
        }
      } else {
        const a = new Uint8Array(n);
        for (let i = 0; i < n; i++) a[i] = mk[i] ? 255 : 0;
        bands.push(a);
        maskBand = alphaBand = bands.length - 1;
      }
      meta.mask = true;
    }
    if (alphaBand >= 0) meta.alphaBand = alphaBand;

    if (photometric === 3) {
      const cm = await loadTag(image, 'ColorMap');
      if (cm && cm.length >= 3) {
        const n = Math.floor(cm.length / 3);
        let mx = 0;
        for (let i = 0; i < cm.length; i++) if (cm[i] > mx) mx = cm[i];
        const shift = mx > 255 ? 8 : 0;     // 16-bit per the spec; some writers use 8-bit values
        const colormap = new Array(n);
        for (let i = 0; i < n; i++) colormap[i] = [cm[i] >> shift, cm[n + i] >> shift, cm[2 * n + i] >> shift];
        meta.colormap = colormap;
      }
    }

    // Band names, scale/offset and dataset metadata written by GDAL.
    const bandNames = [];
    const scale = [], offset = [];
    let scaled = false;
    for (let i = 0; i < bands.length; i++) {
      let md = null;
      if (i !== maskBand) {
        try { md = await image.getGDALMetadata(i + (colorShift && i >= 3 ? colorShift : 0)); } catch (e) { md = null; }
      }
      const d = md && (md.DESCRIPTION || md.description);
      bandNames.push(i === maskBand ? 'mask' : d ? String(d).trim() : i === alphaBand ? 'alpha' : 'b' + (i + 1));
      const sc = md && md.SCALE !== undefined ? Number(md.SCALE) : 1;
      const of = md && md.OFFSET !== undefined ? Number(md.OFFSET) : 0;
      scale.push(isNum(sc) ? sc : 1);
      offset.push(isNum(of) ? of : 0);
      if (scale[i] !== 1 || offset[i] !== 0) scaled = true;
    }
    if (scaled) { meta.scale = scale; meta.offset = offset; }
    try {
      const dsmd = await image.getGDALMetadata();
      if (dsmd && Object.keys(dsmd).length) meta.metadata = dsmd;
    } catch (e) { /* ignore */ }

    // Georeferencing.
    let crs = crsInfo.crs;
    if (crsInfo.name) meta.crsName = crsInfo.name;
    if (crsInfo.unknown) meta.crsUnknown = true;
    if (crsInfo.needsLookup) meta.crsNeedsLookup = true;
    if (crsInfo.userDefined) meta.crsUserDefined = true;
    if (crsInfo.epsg) meta.epsg = crsInfo.epsg;
    if (crsInfo.guessed) warnings.push('The GeoTIFF\'s geographic coordinate system is incomplete; assuming WGS 84.');
    let gt = gt0;
    if (!gt) {
      gt = [0, 1, 0, H, 0, -1];     // pixel space, y up
      crs = null;
      meta.crsUnknown = true;
      meta.georeferenced = false;
      warnings.push('This TIFF has no georeferencing, so it can\'t be placed on the map.');
    } else if (crs === null) {
      const b = [gt[0], gt[3] + H * gt[5], gt[0] + W * gt[1], gt[3]];
      if (crsLib().looksGeographic([Math.min(b[0], b[2]), Math.min(b[1], b[3]), Math.max(b[0], b[2]), Math.max(b[1], b[3])])) {
        meta.crsGuess = 'EPSG:4326';
      }
    }
    const fx = W / width, fy = H / height;
    gt = [gt[0], gt[1] * fx, gt[2] * fy, gt[3], gt[4] * fx, gt[5] * fy];
    if (gt[2] !== 0 || gt[4] !== 0 || gt[1] < 0) {
      const dt = typeOfArray(bands[0]);
      let fill = noData;
      if (fill === null || !fitsType(fill, dt)) {
        fill = isIntType(dt) ? 0 : NaN;
        if (isIntType(dt)) noData = 0;
      }
      const u = unrotate(bands, width, height, gt, fill);
      bands = u.bands; width = u.width; height = u.height; gt = u.transform;
      warnings.push('This raster is rotated; PSICITS resampled it to a north-up grid.');
    }
    if (warnings.length) meta.warnings = warnings;

    return create({
      width: width, height: height, bands: bands, transform: gt, crs: crs, noData: noData,
      bandNames: bandNames, meta: meta,
    });
  }

  /* ============================================================== create */

  /**
   * Build a Raster, validating its parts. Band arrays are used as given (not copied)
   * unless they need converting (plain arrays, Int8Array, a different dataType, or
   * a south-up grid, which is flipped to north-up).
   *
   * @param {object} o
   * @param {number} o.width
   * @param {number} o.height
   * @param {Array<TypedArray|number[]>|TypedArray} o.bands one array per band, row-major from the top-left
   * @param {number[]} [o.bbox] [minX, minY, maxX, maxY] in raster CRS (or give o.transform)
   * @param {number[]} [o.transform] GDAL geotransform [x0, dx, 0, y0, 0, dy]
   * @param {string|null} [o.crs='EPSG:4326']
   * @param {number|null} [o.noData=null] (NaN is stored as null: NaN pixels are always no-data)
   * @param {string[]} [o.bandNames] default b1..bn
   * @param {string} [o.dataType] inferred from the typed arrays when omitted
   * @param {object} [o.meta]
   * @returns {object} Raster
   */
  function create(o) {
    if (!o) throw new Error('No raster description given');
    const width = o.width, height = o.height;
    if (!Number.isInteger(width) || width < 1 || !Number.isInteger(height) || height < 1) {
      throw new Error('A raster needs a positive whole-number width and height');
    }
    let bands = o.bands;
    if (ArrayBuffer.isView(bands) || (Array.isArray(bands) && bands.length && typeof bands[0] === 'number')) bands = [bands];
    if (!Array.isArray(bands) || !bands.length) throw new Error('A raster needs at least one band of pixel values');
    let dataType = normalizeType(o.dataType);
    const n = width * height;
    bands = bands.map(function (b, i) {
      if (Array.isArray(b)) b = (TYPED[dataType || 'float64']).from(b, function (v) { return v === null || v === undefined ? NaN : +v; });
      else if (b instanceof Int8Array) b = Int16Array.from(b);
      else if (b instanceof Uint8ClampedArray) b = new Uint8Array(b.buffer, b.byteOffset, b.length);   // same memory
      else if (!ArrayBuffer.isView(b) || b instanceof DataView || !typeOfArray(b)) {
        throw new Error('Band ' + (i + 1) + ' is not an array of numbers');
      }
      if (b.length !== n) {
        throw new Error('Band ' + (i + 1) + ' has ' + fmtInt(b.length) + ' values, but a ' + width + ' × ' + height +
          ' raster needs ' + fmtInt(n));
      }
      if (dataType && typeOfArray(b) !== dataType) b = TYPED[dataType].from(b);
      return b;
    });
    if (!dataType) {
      dataType = typeOfArray(bands[0]);
      for (let i = 1; i < bands.length; i++) if (typeOfArray(bands[i]) !== dataType) { dataType = 'float64'; break; }
    }

    let t;
    if (o.transform) {
      t = Array.from(o.transform).slice(0, 6).map(Number);
      if (t.length < 6 || !t.every(isNum)) throw new Error('The raster geotransform must be 6 numbers');
      if (t[2] !== 0 || t[4] !== 0) throw new Error('Rotated rasters are not supported (the geotransform has rotation terms)');
      if (!(t[1] > 0)) throw new Error('The raster pixel width must be positive');
      if (t[5] === 0) throw new Error('The raster pixel height can\'t be zero');
      if (t[5] > 0) {                               // south-up: flip to north-up
        bands = bands.map(function (b) { return flipRows(b, width, height); });
        t = [t[0], t[1], 0, t[3] + height * t[5], 0, -t[5]];
      }
    } else if (o.bbox) {
      const b = Array.from(o.bbox).map(Number);
      if (b.length < 4 || !b.every(isNum)) throw new Error('The raster bbox must be 4 numbers [minX, minY, maxX, maxY]');
      if (!(b[2] > b[0]) || !(b[3] > b[1])) throw new Error('The raster bbox is empty (max must be greater than min)');
      t = [b[0], (b[2] - b[0]) / width, 0, b[3], 0, -(b[3] - b[1]) / height];
    } else {
      throw new Error('A raster needs a bbox or a geotransform to know where it is');
    }

    let noData = o.noData;
    if (noData === undefined || noData === null || noData === '' || Number.isNaN(Number(noData))) noData = null;
    else {
      noData = Number(noData);
      if (!isFinite(noData)) throw new Error('The no-data value must be a finite number');
      if (dataType === 'float32') noData = Math.fround(noData);
    }

    const names = [];
    for (let i = 0; i < bands.length; i++) {
      const nm = o.bandNames && o.bandNames[i];
      names.push(nm !== undefined && nm !== null && String(nm).trim() !== '' ? String(nm) : 'b' + (i + 1));
    }
    const crs = o.crs === undefined ? 'EPSG:4326' : o.crs === null ? null : (M.crs ? M.crs.normalize(o.crs) : o.crs);

    return {
      width: width,
      height: height,
      bands: bands,
      bandNames: names,
      noData: noData,
      crs: crs,
      transform: t,
      bbox: [t[0], t[3] + height * t[5], t[0] + width * t[1], t[3]],
      dataType: dataType,
      stats: Array.isArray(o.stats) ? o.stats : null,
      meta: Object.assign({}, o.meta || {}),
    };
  }

  /** New raster on another raster's grid (same transform/CRS). */
  function like(base, bands, extra) {
    return create(Object.assign({
      width: base.width, height: base.height, bands: bands, transform: base.transform.slice(), crs: base.crs,
    }, extra));
  }

  /**
   * The value to write for "no data" in a new band of type `dt`:
   * { fill, noData } where noData is what goes into raster.noData.
   * Floats without a usable value use NaN (and noData null). Integer types
   * that can't hold `wanted` fall back to: 'min' -> the type minimum;
   * otherwise -9999 for signed types and, for unsigned ones, 0 ('imagery',
   * the usual collar value) or the type maximum (default, for computed values).
   */
  function outputNoData(dt, wanted, explicit, intDefault) {
    if (!isIntType(dt)) {
      if (wanted === null || wanted === undefined || wanted !== wanted) return { fill: NaN, noData: null };
      if (!fitsType(wanted, dt)) throw new Error('The no-data value ' + wanted + ' can\'t be stored as ' + dt);
      return { fill: wanted, noData: wanted };
    }
    if (isNum(wanted) && fitsType(wanted, dt)) return { fill: wanted, noData: wanted };
    const r = INT_RANGE[dt];
    if (explicit && wanted !== null && wanted !== undefined) {
      throw new Error('The no-data value ' + wanted + ' can\'t be stored as ' + dt + '; choose a whole number between ' +
        fmtInt(r[0]) + ' and ' + fmtInt(r[1]));
    }
    let d;
    if (intDefault === 'min') d = r[0];
    else if (dt === 'int16' || dt === 'int32') d = -9999;
    else d = intDefault === 'imagery' ? 0 : r[1];
    return { fill: d, noData: d };
  }

  /* =============================================================== stats */

  /**
   * Per-band statistics ignoring no-data and NaN:
   * [{ min, max, mean, std, count, p2, p98 }] (std is the population standard
   * deviation; p2/p98 come from a histogram and are exact for integer bands).
   *
   * Never modifies the raster. Results are memoised per band array, so
   * repeated calls are cheap; callers may also store the result on
   * raster.stats themselves, which later calls then use. Pass
   * { force: true } after changing pixel values in place.
   *
   * @param {object} raster
   * @param {{force?: boolean}} [opts]
   * @returns {Array<{min:number,max:number,mean:number,std:number,count:number,p2:number,p98:number}>}
   */
  function stats(raster, opts) {
    checkRaster(raster);
    const force = !!(opts && opts.force);
    const out = [];
    for (let b = 0; b < raster.bands.length; b++) out.push(Object.assign({}, bandStats(raster, b, force)));
    return out;
  }

  /**
   * Histogram of one band: { edges (bins + 1 values), counts (bins values) }.
   * Values outside [min, max] are ignored; the last bin includes max.
   *
   * @param {object} raster
   * @param {number|string} [band=0]
   * @param {number} [bins=64]
   * @param {{min?: number, max?: number}} [opts] range (defaults to the band's min/max)
   */
  function histogram(raster, band, bins, opts) {
    const b = bandIndex(raster, band);
    const o = opts || {};
    const nb = Math.max(1, Math.min(1e6, Math.floor(isNum(bins) ? bins : 64)));
    let lo = o.min, hi = o.max;
    if (!isNum(lo) || !isNum(hi)) {
      const s = bandStats(raster, b);
      if (!isNum(lo)) lo = s.min;
      if (!isNum(hi)) hi = s.max;
    }
    if (!isNum(lo) || !isNum(hi)) return { edges: [], counts: [] };
    if (hi < lo) { const tmp = lo; lo = hi; hi = tmp; }
    const span = hi > lo ? hi - lo : 1;
    const counts = new Float64Array(nb);
    const arr = raster.bands[b], nd = noDataOf(raster), n = arr.length;
    const scale = nb / span;
    for (let i = 0; i < n; i++) {
      const v = arr[i];
      if (v !== v || v === nd || v < lo || v > hi) continue;
      let k = Math.floor((v - lo) * scale);
      if (k >= nb) k = nb - 1;
      counts[k]++;
    }
    const edges = new Array(nb + 1);
    for (let i = 0; i <= nb; i++) edges[i] = lo + (span * i) / nb;
    edges[nb] = hi > lo ? hi : lo + 1;
    return { edges: edges, counts: Array.from(counts) };
  }

  /* ============================================================== styling */

  const MODE_ALIASES = {
    singleband: 'singleband', single: 'singleband', pseudocolor: 'singleband', continuous: 'singleband', ramp: 'singleband', stretch: 'singleband',
    gray: 'gray', grey: 'gray', grayscale: 'gray', greyscale: 'gray',
    rgb: 'rgb', multiband: 'rgb', composite: 'rgb', truecolor: 'rgb', color: 'rgb',
    palette: 'palette', categorical: 'palette', classified: 'palette', unique: 'palette', categories: 'palette',
  };

  function textHints(raster) {
    const parts = (raster.bandNames || []).slice();
    const m = raster.meta || {};
    Object.keys(m).forEach(function (k) {
      if (typeof m[k] === 'string' && k !== 'format') parts.push(m[k]);
    });
    return parts.join(' ').toLowerCase();
  }

  /**
   * A sensible default style: RGB for 3+ bands (0-255 for uint8, else a 2-98 %
   * stretch), the palette for colour-mapped images, otherwise a single-band
   * ramp: 'elevation' when names/metadata hint at a DEM, 'gray' for
   * hillshades, 'ndvi' for NDVI, else 'viridis'.
   *
   * @param {object} raster
   * @returns {object} style for render()
   */
  function defaultStyle(raster) {
    checkRaster(raster);
    const n = raster.bands.length, meta = raster.meta || {};
    const alpha = isNum(meta.alphaBand) && meta.alphaBand < n ? meta.alphaBand : null;
    const colourBands = alpha === null ? n : n - 1;
    if (meta.colormap && colourBands <= 1) {
      const st = { mode: 'palette', band: 0 };
      if (alpha !== null) st.alpha = alpha;
      return st;
    }
    if (colourBands >= 3) {
      const names = (raster.bandNames || []).map(function (s) { return String(s).toLowerCase(); });
      const find = function (re) { for (let i = 0; i < names.length; i++) if (re.test(names[i])) return i; return -1; };
      const r = find(/^(red|r)$/), g = find(/^(green|g)$/), b = find(/^(blue|b)$/);
      const st = { mode: 'rgb', bands: r >= 0 && g >= 0 && b >= 0 ? [r, g, b] : [0, 1, 2] };
      if (alpha !== null) st.alpha = alpha;
      return st;
    }
    if (meta.photometric === 0) {                 // TIFF WhiteIsZero: 0 is white
      const st = { mode: 'gray', band: 0, invert: true, stretch: 'minmax' };
      if (alpha !== null) st.alpha = alpha;
      return st;
    }
    const hints = textHints(raster);
    let ramp = 'viridis';
    if (/hillshade|shaded ?relief|panchromatic|\bgr[ae]y(scale)?\b/.test(hints)) ramp = 'gray';
    else if (/ndvi|evi\b|vegetation index/.test(hints)) ramp = 'ndvi';
    else if (/\b(elev|elevation|dem|dtm|dsm|height|altitude|srtm|gmted|etopo|topo|terrain)\b/.test(hints)) ramp = 'elevation';
    const st = { mode: 'singleband', band: 0, ramp: ramp, stretch: 'percentile' };
    if (alpha !== null) st.alpha = alpha;
    return st;
  }

  function parseColor(c, what) {
    const rgba = colorLib().parse(c);
    if (!rgba) throw new Error('Unknown colour "' + c + '"' + (what ? ' for ' + what : ''));
    const a = rgba[3] === undefined ? 1 : rgba[3];
    return [Math.round(rgba[0]), Math.round(rgba[1]), Math.round(rgba[2]), Math.round(Math.max(0, Math.min(1, a)) * 255)];
  }

  function checkRamp(name) {
    const C = colorLib();
    if (!C.getRamp(name)) {
      throw new Error('Unknown colour ramp "' + name + '". Try one of: ' + C.rampNames().slice(0, 12).join(', ') + ', ...');
    }
  }

  function stretchRange(raster, b, stretch, sdevs) {
    const s = bandStats(raster, b);
    if (!s.count) return [0, 1];
    if (stretch === 'minmax') return [s.min, s.max];
    if (stretch === 'stddev') {
      const k = isNum(sdevs) && sdevs > 0 ? sdevs : 2;
      return [Math.max(s.min, s.mean - k * s.std), Math.min(s.max, s.mean + k * s.std)];
    }
    return [s.p2, s.p98];
  }

  function normStretch(v) {
    const s = String(v || 'percentile').toLowerCase().replace(/[\s_-]/g, '');
    if (s === 'minmax' || s === 'full' || s === 'none') return 'minmax';
    if (s === 'stddev' || s === 'std' || s === 'sd' || s === 'standarddeviation') return 'stddev';
    if (s === 'percentile' || s === 'percent' || s === 'cumulative' || s === 'p2p98' || s === 'clip') return 'percentile';
    throw new Error('Unknown stretch "' + v + '". Use percentile, minmax or stddev');
  }

  function alphaIndex(raster, st) {
    return st.alpha === undefined || st.alpha === null || st.alpha === false ? null : bandIndex(raster, st.alpha);
  }

  /** Validate + complete a style; returns { style (public, resolved), paint (row painter factory args) }. */
  function resolveStyle(raster, style) {
    let st = style || defaultStyle(raster);
    let mode = st.mode ? MODE_ALIASES[String(st.mode).toLowerCase().replace(/[\s_-]/g, '')] : null;
    if (st.mode && !mode) throw new Error('Unknown raster style "' + st.mode + '". Use singleband, gray, rgb or palette');
    if (!mode) {
      if (Array.isArray(st.bands)) mode = 'rgb';
      else if (st.categories) mode = 'palette';
      else if (st.ramp || st.classes || st.band !== undefined || st.min !== undefined || st.max !== undefined) mode = 'singleband';
      else {
        st = Object.assign({}, defaultStyle(raster), st);
        mode = st.mode;
      }
    }
    const resampling = String(st.resampling || 'nearest').toLowerCase() === 'bilinear' ? 'bilinear' : 'nearest';
    const alpha = alphaIndex(raster, st);

    if (mode === 'singleband' || mode === 'gray') {
      const b = bandIndex(raster, st.band);
      const ramp = mode === 'gray' ? (st.ramp || 'gray') : (st.ramp || 'viridis');
      checkRamp(ramp);
      const out = { mode: mode, band: b, ramp: ramp, resampling: resampling };
      if (Array.isArray(st.classes) && st.classes.length) {
        const cls = st.classes.map(function (c, i) {
          const max = c.max === null || c.max === undefined ? Infinity : Number(c.max);
          if (!(max === max)) throw new Error('Class ' + (i + 1) + ' needs a numeric max');
          return { max: max, rgba: parseColor(c.color, 'class ' + (i + 1)), color: c.color, label: c.label };
        }).sort(function (a, b2) { return a.max - b2.max; });
        out.classes = cls.map(function (c) {
          const r = { max: c.max === Infinity ? null : c.max, color: colorLib().toHex(c.rgba) };
          if (c.label !== undefined) r.label = c.label;
          return r;
        });
        out._cls = cls;
      } else {
        const stretch = normStretch(st.stretch);
        let lo = numeric(st.min), hi = numeric(st.max);
        if (!isNum(lo) || !isNum(hi)) {
          const r = stretchRange(raster, b, stretch, st.stddevs);
          if (!isNum(lo)) lo = r[0];
          if (!isNum(hi)) hi = r[1];
        }
        out.min = lo; out.max = hi; out.stretch = stretch; out.invert = !!st.invert;
      }
      if (alpha !== null) out.alpha = alpha;
      return out;
    }

    if (mode === 'rgb') {
      const n = raster.bands.length;
      const req = Array.isArray(st.bands) && st.bands.length ? st.bands : [0, 1, 2];
      if (req.length !== 3) throw new Error('RGB display needs exactly 3 bands (red, green, blue)');
      if (!Array.isArray(st.bands) && n < 3) throw new Error('RGB display needs 3 bands; this raster has ' + n);
      const idx = req.map(function (b) { return bandIndex(raster, b); });
      const stretch = normStretch(st.stretch);
      const isByte = raster.dataType === 'uint8' && !st.stretch;
      const pick = function (v, i) { return numeric(Array.isArray(v) ? v[i] : v); };
      const mins = [], maxs = [];
      for (let i = 0; i < 3; i++) {
        let lo = pick(st.min, i), hi = pick(st.max, i);
        if (!isNum(lo) || !isNum(hi)) {
          const r = isByte ? [0, 255] : stretchRange(raster, idx[i], stretch, st.stddevs);
          if (!isNum(lo)) lo = r[0];
          if (!isNum(hi)) hi = r[1];
        }
        mins.push(lo); maxs.push(hi);
      }
      const out = { mode: 'rgb', bands: idx, min: mins, max: maxs, stretch: isByte ? 'none' : stretch, resampling: resampling };
      if (alpha !== null) out.alpha = alpha;
      return out;
    }

    // palette
    const b = bandIndex(raster, st.band);
    const out = { mode: 'palette', band: b };
    const isF32 = raster.dataType === 'float32';
    let cats;
    if (Array.isArray(st.categories) && st.categories.length) {
      cats = st.categories.map(function (c, i) {
        if (!isNum(Number(c.value))) throw new Error('Category ' + (i + 1) + ' needs a numeric value');
        const v = isF32 ? Math.fround(Number(c.value)) : Number(c.value);
        return { value: v, rgba: parseColor(c.color, 'value ' + c.value), label: c.label };
      });
      out.categories = cats.map(function (c) {
        return { value: c.value, color: colorLib().toHex(c.rgba), label: c.label !== undefined ? c.label : String(c.value) };
      });
    } else if (raster.meta && Array.isArray(raster.meta.colormap)) {
      const cm = raster.meta.colormap;
      const present = presentValues(raster, b, 256);
      cats = null;
      out._colormap = cm;
      out.categories = present.filter(function (v) { return v >= 0 && v < cm.length && Number.isInteger(v); }).map(function (v) {
        return { value: v, color: colorLib().toHex(cm[v]), label: raster.meta.categoryNames && raster.meta.categoryNames[v] || String(v) };
      });
    } else {
      // No categories: one colour per distinct value.
      const present = presentValues(raster, b, 64);
      const pal = colorLib().categorical(present.length);
      cats = present.map(function (v, i) { return { value: v, rgba: parseColor(pal[i]), label: String(v) }; });
      out.categories = cats.map(function (c) { return { value: c.value, color: colorLib().toHex(c.rgba), label: c.label }; });
    }
    out._cats = cats;
    out._default = st.defaultColor ? parseColor(st.defaultColor, 'values without a category') : null;
    if (st.defaultColor) out.defaultColor = st.defaultColor;
    if (alpha !== null) out.alpha = alpha;
    return out;
  }

  const presentCache = new WeakMap();

  /** Sorted distinct values of a band (at most `limit`; memoised per band array). */
  function presentValues(raster, b, limit) {
    const arr = raster.bands[b], nd = noDataOf(raster);
    const c = presentCache.get(arr);
    if (c && c.noData === nd && c.limit === limit) return c.values;
    const values = distinctValues(arr, nd, typeOfArray(arr) || raster.dataType, limit);
    presentCache.set(arr, { noData: nd, limit: limit, values: values });
    return values;
  }

  function distinctValues(arr, nd, dt, limit) {
    const n = arr.length;
    if (dt === 'uint8' || dt === 'uint16' || dt === 'int16') {
      const off = dt === 'int16' ? 32768 : 0;
      const seen = new Uint8Array(dt === 'uint8' ? 256 : 65536);
      for (let i = 0; i < n; i++) { const v = arr[i]; if (v !== nd) seen[v + off] = 1; }
      const out = [];
      for (let v = 0; v < seen.length && out.length < limit; v++) if (seen[v]) out.push(v - off);
      return out;
    }
    const set = new Set();
    for (let i = 0; i < n && set.size <= limit * 4; i++) {
      const v = arr[i];
      if (v === v && v !== nd) set.add(v);
    }
    return Array.from(set).sort(function (a, c) { return a - c; }).slice(0, limit);
  }

  function publicStyle(rs) {
    const out = {};
    Object.keys(rs).forEach(function (k) { if (k[0] !== '_') out[k] = rs[k]; });
    return out;
  }

  /** Row painter for a resolved style: paint(idx, cols, rows, out, offset, n). */
  function makePainter(raster, rs) {
    const W = raster.width, H = raster.height, nd = noDataOf(raster);
    const alpha = rs.alpha !== undefined ? raster.bands[rs.alpha] : null;
    const bil = rs.resampling === 'bilinear';

    if (rs.mode === 'singleband' || rs.mode === 'gray') {
      const arr = raster.bands[rs.band];
      if (rs._cls) {
        const nc = rs._cls.length;
        const th = new Float64Array(nc), cr = new Uint8Array(nc * 4);
        rs._cls.forEach(function (c, i) { th[i] = c.max; cr.set(c.rgba, i * 4); });
        return function (idx, cols, rows, out, o, n) {
          for (let i = 0; i < n; i++, o += 4) {
            const k = idx[i];
            if (k < 0) continue;
            let v = arr[k];
            if (v !== v || v === nd) continue;
            if (bil) { v = bilinearAt(arr, W, H, nd, cols[i], rows[i]); if (v !== v) continue; }
            let a = 255;
            if (alpha) { a = alpha[k]; if (!(a > 0)) continue; if (a > 255) a = 255; }
            let lo = 0, hi = nc - 1;
            while (lo < hi) { const mid = (lo + hi) >> 1; if (v <= th[mid]) hi = mid; else lo = mid + 1; }
            const q = lo * 4;
            out[o] = cr[q]; out[o + 1] = cr[q + 1]; out[o + 2] = cr[q + 2];
            out[o + 3] = (cr[q + 3] * a) / 255;
          }
        };
      }
      let lut = colorLib().rampLUT(rs.ramp);
      if (rs.invert) {
        const inv = new Uint8Array(768);
        for (let i = 0; i < 256; i++) { inv[i * 3] = lut[(255 - i) * 3]; inv[i * 3 + 1] = lut[(255 - i) * 3 + 1]; inv[i * 3 + 2] = lut[(255 - i) * 3 + 2]; }
        lut = inv;
      }
      const lo = rs.min, span = rs.max - rs.min;
      const scale = span > 0 ? 255 / span : 0;
      return function (idx, cols, rows, out, o, n) {
        for (let i = 0; i < n; i++, o += 4) {
          const k = idx[i];
          if (k < 0) continue;
          let v = arr[k];
          if (v !== v || v === nd) continue;
          if (bil) { v = bilinearAt(arr, W, H, nd, cols[i], rows[i]); if (v !== v) continue; }
          let a = 255;
          if (alpha) { a = alpha[k]; if (!(a > 0)) continue; if (a > 255) a = 255; }
          let q;
          if (scale > 0) {
            const t = (v - lo) * scale;
            q = t <= 0 ? 0 : t >= 255 ? 255 : (t + 0.5) | 0;
          } else {
            q = 128;
          }
          q *= 3;
          out[o] = lut[q]; out[o + 1] = lut[q + 1]; out[o + 2] = lut[q + 2]; out[o + 3] = a;
        }
      };
    }

    if (rs.mode === 'rgb') {
      const A = raster.bands[rs.bands[0]], B = raster.bands[rs.bands[1]], C = raster.bands[rs.bands[2]];
      const l0 = rs.min[0], l1 = rs.min[1], l2 = rs.min[2];
      const s0 = rs.max[0] > l0 ? 255 / (rs.max[0] - l0) : 0;
      const s1 = rs.max[1] > l1 ? 255 / (rs.max[1] - l1) : 0;
      const s2 = rs.max[2] > l2 ? 255 / (rs.max[2] - l2) : 0;
      const ch = function (v, l, s) {
        if (s === 0) return v >= l ? 255 : 0;
        const t = (v - l) * s;
        return t <= 0 ? 0 : t >= 255 ? 255 : (t + 0.5) | 0;
      };
      return function (idx, cols, rows, out, o, n) {
        for (let i = 0; i < n; i++, o += 4) {
          const k = idx[i];
          if (k < 0) continue;
          let r = A[k], g = B[k], b = C[k];
          if (r !== r || g !== g || b !== b) continue;
          if (r === nd && g === nd && b === nd) continue;
          if (bil) {
            r = bilinearAt(A, W, H, nd, cols[i], rows[i]);
            g = bilinearAt(B, W, H, nd, cols[i], rows[i]);
            b = bilinearAt(C, W, H, nd, cols[i], rows[i]);
            if (r !== r) r = A[k];
            if (g !== g) g = B[k];
            if (b !== b) b = C[k];
          }
          let a = 255;
          if (alpha) { a = alpha[k]; if (!(a > 0)) continue; if (a > 255) a = 255; }
          out[o] = ch(r, l0, s0); out[o + 1] = ch(g, l1, s1); out[o + 2] = ch(b, l2, s2); out[o + 3] = a;
        }
      };
    }

    // palette (always nearest)
    const arr = raster.bands[rs.band];
    const def = rs._default;
    const dt = typeOfArray(arr) || raster.dataType;
    let lutOff = 0, lut = null, map = null;
    const small = dt === 'uint8' || dt === 'uint16' || dt === 'int16';
    if (small) {
      lutOff = dt === 'int16' ? 32768 : 0;
      const size = dt === 'uint8' ? 256 : 65536;
      lut = new Uint8Array(size * 4);
      if (def) for (let v = 0; v < size; v++) lut.set(def, v * 4);
      if (rs._colormap) {
        const cm = rs._colormap;
        for (let v = 0; v < Math.min(cm.length, size - lutOff); v++) {
          const q = (v + lutOff) * 4;
          lut[q] = cm[v][0]; lut[q + 1] = cm[v][1]; lut[q + 2] = cm[v][2]; lut[q + 3] = 255;
        }
      } else {
        rs._cats.forEach(function (c) {
          const v = c.value + lutOff;
          if (Number.isInteger(v) && v >= 0 && v < size) lut.set(c.rgba, v * 4);
        });
      }
    } else {
      map = new Map();
      if (rs._colormap) rs._colormap.forEach(function (c, v) { map.set(v, [c[0], c[1], c[2], 255]); });
      else rs._cats.forEach(function (c) { map.set(c.value, c.rgba); });
    }
    return function (idx, cols, rows, out, o, n) {
      for (let i = 0; i < n; i++, o += 4) {
        const k = idx[i];
        if (k < 0) continue;
        const v = arr[k];
        if (v !== v || v === nd) continue;
        let a = 255;
        if (alpha) { a = alpha[k]; if (!(a > 0)) continue; if (a > 255) a = 255; }
        let r, g, b, ca;
        if (lut) {
          const q = (v + lutOff) * 4;
          r = lut[q]; g = lut[q + 1]; b = lut[q + 2]; ca = lut[q + 3];
        } else {
          const c = map.get(v) || def;
          if (!c) continue;
          r = c[0]; g = c[1]; b = c[2]; ca = c[3];
        }
        if (!ca) continue;
        out[o] = r; out[o + 1] = g; out[o + 2] = b; out[o + 3] = (ca * a) / 255;
      }
    };
  }

  /**
   * Output pixel size [sx, sy] in Web Mercator meters so that no source pixel
   * is skipped: the finest source pixel sampled across the raster. Per axis
   * for EPSG:4326/3857 (their pixels stay axis-aligned), else the shortest
   * pixel side for both axes (the grid is rotated relative to Mercator).
   */
  function outputPixelSize(raster) {
    const t = raster.transform, W = raster.width, H = raster.height;
    const kind = crsKind(raster.crs);
    const tf = transformer(raster.crs, 'EPSG:3857');
    let sx = Infinity, sy = Infinity;
    const fr = [0, 0.25, 0.5, 0.75, 1];
    for (let a = 0; a < fr.length; a++) {
      for (let b = 0; b < fr.length; b++) {
        const c = Math.min(W - 1, Math.floor(fr[a] * (W - 1))) + 0.5;
        const r = Math.min(H - 1, Math.floor(fr[b] * (H - 1))) + 0.5;
        const p0 = tf([t[0] + c * t[1], t[3] + r * t[5]]);
        const pc = tf([t[0] + (c + 1) * t[1], t[3] + r * t[5]]);
        const pr = tf([t[0] + c * t[1], t[3] + (r + 1) * t[5]]);
        let d1, d2;
        if (kind === 'other') {
          d1 = d2 = Math.min(Math.hypot(pc[0] - p0[0], pc[1] - p0[1]), Math.hypot(pr[0] - p0[0], pr[1] - p0[1]));
        } else {
          d1 = Math.abs(pc[0] - p0[0]);
          d2 = Math.abs(pr[1] - p0[1]);
        }
        if (d1 > 0 && d1 < sx) sx = d1;
        if (d2 > 0 && d2 < sy) sy = d2;
      }
    }
    return [sx, sy];
  }

  /**
   * Render a raster to an RGBA image for a MapLibre image source.
   *
   * The image grid is axis-aligned in EPSG:3857 and covers the raster's
   * footprint (latitudes clamped to ±85.0511), at roughly the source
   * resolution (the finest source pixel sets the output pixel size), capped
   * at maxSize on the longest side; tiny rasters are upsampled by a whole
   * factor to at least minSize so pixels stay crisp. Each output pixel is
   * mapped back to the source (closed form for EPSG:4326 / 3857; otherwise a
   * 16 px control grid through PSICITS.crs, interpolated bilinearly and
   * verified per cell, with exact fallback) and sampled nearest-neighbour
   * (style.resampling = 'bilinear' for smooth). Outside / no-data / NaN
   * pixels are transparent.
   *
   * Styles:
   *  - { mode: 'singleband', band = 0, ramp = 'viridis', min, max,
   *      stretch: 'percentile' (p2-p98) | 'minmax' | 'stddev' (stddevs = 2), invert,
   *      classes: [{ max, color, label }] (discrete steps; values above the last max use the last class) }
   *  - { mode: 'gray' } — singleband with the 'gray' ramp
   *  - { mode: 'rgb', bands: [r, g, b], min: [..], max: [..] } (0-255 for uint8, else per-band p2/p98);
   *    a pixel is transparent when all three bands are no-data
   *  - { mode: 'palette', band = 0, categories: [{ value, color, label }], defaultColor }
   *    (meta.colormap is used when categories are absent)
   *  - any mode: alpha: <band> (0 = transparent), resampling: 'nearest' | 'bilinear'
   *
   * @param {object} raster
   * @param {object} [style] defaults to defaultStyle(raster)
   * @param {{maxSize?: number, minSize?: number}} [opts]
   * @returns {{width:number, height:number, data:Uint8ClampedArray, coordinates:number[][], bbox:number[], style:object}}
   *   coordinates = [[lng, lat] top-left, top-right, bottom-right, bottom-left]; style = the resolved style (for legends)
   */
  function render(raster, style, opts) {
    checkRaster(raster);
    checkCrs(raster, 'shown on the map');
    const o = opts || {};
    const maxSize = isNum(o.maxSize) && o.maxSize >= 1 ? Math.floor(o.maxSize) : 2048;
    const minSize = isNum(o.minSize) ? Math.max(0, Math.floor(o.minSize)) : 256;
    const rs = resolveStyle(raster, style);

    const bb = wgs84Outline(raster).bbox;
    const lng0 = bb[0], lng1 = bb[2];
    const lat0 = Math.max(bb[1], -MAX_LAT), lat1 = Math.min(bb[3], MAX_LAT);
    if (!(lng1 > lng0) || !(lat1 > lat0)) {
      throw new Error('This raster lies outside the area a web map can show (beyond ±85° latitude)');
    }
    const mx0 = lngToX(lng0), mx1 = lngToX(lng1), my0 = latToY(lat0), my1 = latToY(lat1);
    const ps = outputPixelSize(raster);
    const sx = ps[0] > 0 && isFinite(ps[0]) ? ps[0] : (mx1 - mx0) / raster.width;
    const sy = ps[1] > 0 && isFinite(ps[1]) ? ps[1] : (my1 - my0) / raster.height;
    // (1% slack so Mercator's convexity doesn't add a sliver row/column)
    let ow = Math.max(1, Math.ceil((mx1 - mx0) / sx - 0.01)), oh = Math.max(1, Math.ceil((my1 - my0) / sy - 0.01));
    const longest = Math.max(ow, oh);
    if (longest > maxSize) {
      const f = maxSize / longest;
      ow = Math.max(1, Math.min(maxSize, Math.round(ow * f)));
      oh = Math.max(1, Math.min(maxSize, Math.round(oh * f)));
    } else if (minSize && longest < minSize) {
      const f = Math.min(Math.floor(minSize / longest), Math.floor(maxSize / longest));
      if (f > 1) { ow *= f; oh *= f; }
    }
    const target = { width: ow, height: oh, crs: 'EPSG:3857', transform: [mx0, (mx1 - mx0) / ow, 0, my1, 0, -(my1 - my0) / oh] };
    const mapper = pixelMapper(target, raster);
    const paint = makePainter(raster, rs);
    const data = new Uint8ClampedArray(ow * oh * 4);
    const cols = new Float64Array(ow), rows = new Float64Array(ow), idx = new Int32Array(ow);
    for (let j = 0; j < oh; j++) {
      mapper.fillRow(j, cols, rows);
      nearestRow(cols, rows, ow, raster.width, raster.height, idx);
      paint(idx, cols, rows, data, j * ow * 4, ow);
    }
    const tl = [lng0, yToLat(my1)], br = [lng1, yToLat(my0)];
    return {
      width: ow,
      height: oh,
      data: data,
      coordinates: [[tl[0], tl[1]], [br[0], tl[1]], [br[0], br[1]], [tl[0], br[1]]],
      bbox: [tl[0], br[1], br[0], tl[1]],
      style: publicStyle(rs),
    };
  }

  /* ========================================================== map algebra */

  function sameGrid(a, b) {
    if (a.width !== b.width || a.height !== b.height || !sameCrs(a.crs, b.crs)) return false;
    const ta = a.transform, tb = b.transform;
    const tol = 1e-9 * Math.max(Math.abs(ta[1]), Math.abs(ta[5]));
    return Math.abs(ta[1] - tb[1]) <= tol && Math.abs(ta[5] - tb[5]) <= tol &&
      Math.abs(ta[0] - tb[0]) <= 1e-6 * Math.abs(ta[1]) && Math.abs(ta[3] - tb[3]) <= 1e-6 * Math.abs(ta[5]);
  }

  /**
   * Cell-by-cell calculation over one or more rasters.
   *
   * All inputs are resampled (nearest) onto the first input's grid when their
   * grids differ (reprojecting if needed). `fn` is called once per pixel with
   * one reused object holding each variable's value; if any input is no-data
   * or NaN the output is no-data, and so are non-finite results. Booleans
   * become 0/1; integer output types are rounded and clamped.
   *
   * @param {Object<string, {raster: object, band?: number|string}>} inputs e.g. { b4: { raster, band: 3 } }
   * @param {function(Object<string, number>): number} fn
   * @param {{noData?: number, dataType?: string, bandName?: string}} [opts]
   *   noData defaults to -9999 (255/65535/... for unsigned types that can't hold it); dataType to 'float32'
   * @returns {object} single-band Raster on the first input's grid
   */
  function mapAlgebra(inputs, fn, opts) {
    const o = opts || {};
    const names = Object.keys(inputs || {});
    if (!names.length) throw new Error('Map algebra needs at least one input raster');
    if (typeof fn !== 'function') throw new Error('Map algebra needs an expression to evaluate');
    const vars = names.map(function (name) {
      const v = inputs[name];
      const raster = v && Array.isArray(v.bands) ? v : v && v.raster;
      if (!raster || !Array.isArray(raster.bands)) throw new Error('"' + name + '" is not a raster');
      checkRaster(raster);
      const band = raster === v ? 0 : bandIndex(raster, v.band);
      return { name: name, raster: raster, arr: raster.bands[band], nd: noDataOf(raster), mapper: null, idx: null, inside: 0 };
    });
    const base = vars[0].raster;
    const W = base.width, H = base.height;
    vars.forEach(function (v, i) {
      if (i === 0 || sameGrid(v.raster, base)) return;
      if (!sameCrs(v.raster.crs, base.crs)) {
        checkCrs(base, 'combined with other rasters');
        checkCrs(v.raster, 'combined with other rasters');
      }
      v.mapper = pixelMapper(base, v.raster);
      v.idx = new Int32Array(W);
    });
    const dataType = normalizeType(o.dataType) || 'float32';
    const ndv = outputNoData(dataType, o.noData === undefined ? -9999 : o.noData, o.noData !== undefined);
    const fill = ndv.fill;
    const integer = isIntType(dataType);
    const out = allocBand(dataType, W * H);
    const obj = {};
    names.forEach(function (nm) { obj[nm] = 0; });
    const nv = vars.length;
    const cols = new Float64Array(W), rows = new Float64Array(W);
    for (let j = 0; j < H; j++) {
      for (let q = 0; q < nv; q++) {
        const v = vars[q];
        if (!v.mapper) continue;
        v.mapper.fillRow(j, cols, rows);
        v.inside += nearestRow(cols, rows, W, v.raster.width, v.raster.height, v.idx);
      }
      const rowOff = j * W;
      for (let i = 0; i < W; i++) {
        const p = rowOff + i;
        let ok = true;
        for (let q = 0; q < nv; q++) {
          const v = vars[q];
          let x;
          if (v.idx) {
            const s = v.idx[i];
            if (s < 0) { ok = false; break; }
            x = v.arr[s];
          } else {
            x = v.arr[p];
          }
          if (x !== x || x === v.nd) { ok = false; break; }
          obj[v.name] = x;
        }
        if (!ok) { out[p] = fill; continue; }
        const r = +fn(obj);
        out[p] = r === r && r !== Infinity && r !== -Infinity ? (integer ? storable(r, dataType) : r) : fill;
      }
    }
    for (let q = 1; q < nv; q++) {
      if (vars[q].idx && vars[q].inside === 0) throw new Error('"' + vars[q].name + '" doesn\'t overlap "' + vars[0].name + '"');
    }
    return like(base, [out], {
      noData: ndv.noData, dataType: dataType, bandNames: [o.bandName || o.name || 'b1'],
      meta: { source: 'map algebra' },
    });
  }

  /* ============================================================ resample */

  /**
   * Resample (and reproject) a raster onto another grid; all bands.
   *
   * @param {object} raster
   * @param {{width:number, height:number, transform?:number[], bbox?:number[], crs?:string}} grid (crs defaults to the raster's)
   * @param {{method?: 'nearest'|'bilinear', noData?: number}} [opts]
   * @returns {object} Raster with the same data type; cells outside the source are no-data
   *   (the source no-data value, else NaN for floats / 0 for unsigned / -9999 for signed ints)
   */
  function resampleTo(raster, grid, opts) {
    checkRaster(raster);
    const o = opts || {};
    const g = gridSpec(grid, raster.crs);
    if (!sameCrs(g.crs, raster.crs)) {
      checkCrs(raster, 'reprojected');
      checkCrs({ crs: g.crs }, 'used as a target grid');
    }
    const method = String(o.method || 'nearest').toLowerCase();
    if (method !== 'nearest' && method !== 'bilinear') throw new Error('Unknown resampling method "' + o.method + '". Use nearest or bilinear');
    const dt = raster.dataType || typeOfArray(raster.bands[0]);
    const nd = noDataOf(raster);
    const ndv = outputNoData(dt, o.noData !== undefined ? o.noData : nd, o.noData !== undefined, 'imagery');
    const fill = ndv.fill;
    const W = g.width, H = g.height, sW = raster.width, sH = raster.height;
    const mapper = pixelMapper(g, raster);
    const nb = raster.bands.length;
    const out = raster.bands.map(function () { return allocBand(dt, W * H); });
    const integer = isIntType(dt);
    const cols = new Float64Array(W), rows = new Float64Array(W), idx = new Int32Array(W);
    for (let j = 0; j < H; j++) {
      mapper.fillRow(j, cols, rows);
      nearestRow(cols, rows, W, sW, sH, idx);
      const rowOff = j * W;
      for (let b = 0; b < nb; b++) {
        const src = raster.bands[b], dst = out[b];
        for (let i = 0; i < W; i++) {
          const k = idx[i];
          if (k < 0) { dst[rowOff + i] = fill; continue; }
          let v = src[k];
          if (v !== v || v === nd) { dst[rowOff + i] = fill; continue; }
          if (method === 'bilinear') {
            v = bilinearAt(src, sW, sH, nd, cols[i], rows[i]);
            if (v !== v) v = src[k];
            if (integer) v = storable(v, dt);
          }
          dst[rowOff + i] = v;
        }
      }
    }
    const meta = Object.assign({}, raster.meta, { resampling: method });
    delete meta.downsample; delete meta.fullSize; delete meta.overviewLevel;
    return create({
      width: W, height: H, bands: out, transform: g.transform, crs: g.crs, noData: ndv.noData, dataType: dt,
      bandNames: raster.bandNames.slice(), meta: meta,
    });
  }

  /* ========================================================== reclassify */

  /**
   * Reclassify one band into a new single-band raster. Rules are tried in
   * order: { min, max, value } matches min <= v < max (either bound may be
   * omitted), { equals, value } matches exactly. A rule value of null means
   * no-data. Unmatched pixels get `otherwise` (default no-data); input
   * no-data stays no-data.
   *
   * @param {object} raster
   * @param {number|string} band
   * @param {Array<{min?:number, max?:number, value:number|null}|{equals:number, value:number|null}>} rules
   * @param {{otherwise?: number|null, noData?: number, dataType?: string}} [opts]
   *   dataType defaults to int16/int32 for whole-number classes, else float32
   * @returns {object} Raster
   */
  function reclassify(raster, band, rules, opts) {
    const b = bandIndex(raster, band);
    const o = opts || {};
    if (!Array.isArray(rules) || !rules.length) throw new Error('Reclassify needs at least one rule');
    const rs = rules.map(function (r, i) {
      if (!r || typeof r !== 'object') throw new Error('Rule ' + (i + 1) + ' is not valid');
      const value = r.value === null || r.value === undefined ? null : Number(r.value);
      if (value !== null && !isNum(value)) throw new Error('Rule ' + (i + 1) + ' needs a numeric value (or null for no-data)');
      if (r.equals !== undefined && r.equals !== null) {
        const eq = Number(r.equals);
        if (!isNum(eq)) throw new Error('Rule ' + (i + 1) + ' needs a numeric "equals"');
        return { eq: raster.dataType === 'float32' ? Math.fround(eq) : eq, value: value };
      }
      const min = r.min === undefined || r.min === null ? -Infinity : Number(r.min);
      const max = r.max === undefined || r.max === null ? Infinity : Number(r.max);
      if (min !== min || max !== max) throw new Error('Rule ' + (i + 1) + ' has a non-numeric min or max');
      return { min: min, max: max, value: value };
    });
    const otherwise = o.otherwise === undefined || o.otherwise === null ? null : Number(o.otherwise);
    if (otherwise !== null && !isNum(otherwise)) throw new Error('The "otherwise" value must be a number');
    const outputs = rs.map(function (r) { return r.value; }).concat([otherwise]).filter(function (v) { return v !== null; });
    let dataType = normalizeType(o.dataType);
    if (!dataType) {
      const ints = outputs.every(Number.isInteger);
      const lo = Math.min.apply(null, outputs.concat([0])), hi = Math.max.apply(null, outputs.concat([0]));
      dataType = ints && lo >= -32767 && hi <= 32767 ? 'int16' : ints && lo >= -2147483647 && hi <= 2147483647 ? 'int32' : 'float32';
    }
    let wanted = o.noData !== undefined ? o.noData : -9999;
    if (o.noData === undefined && outputs.indexOf(wanted) >= 0) wanted = isIntType(dataType) ? INT_RANGE[dataType][0] : NaN;
    const ndv = outputNoData(dataType, wanted, o.noData !== undefined, 'min');
    const fill = ndv.fill;
    const classify = function (v) {
      for (let i = 0; i < rs.length; i++) {
        const r = rs[i];
        if (r.eq !== undefined ? v === r.eq : v >= r.min && v < r.max) return r.value === null ? fill : r.value;
      }
      return otherwise === null ? fill : otherwise;
    };
    const arr = raster.bands[b], nd = noDataOf(raster), n = arr.length;
    const out = allocBand(dataType, n);
    const dt = typeOfArray(arr) || raster.dataType;
    if (dt === 'uint8' || dt === 'uint16' || dt === 'int16') {
      const off = dt === 'int16' ? 32768 : 0;
      const lut = new Float64Array(dt === 'uint8' ? 256 : 65536);
      for (let v = 0; v < lut.length; v++) lut[v] = v - off === nd ? fill : storable(classify(v - off), dataType);
      for (let i = 0; i < n; i++) out[i] = lut[arr[i] + off];
    } else {
      for (let i = 0; i < n; i++) {
        const v = arr[i];
        out[i] = v !== v || v === nd ? fill : storable(classify(v), dataType);
      }
    }
    return like(raster, [out], {
      noData: ndv.noData, dataType: dataType, bandNames: [o.bandName || 'class'],
      meta: { source: 'reclassify' },
    });
  }

  /* ========================================================= zonal stats */

  function statList(list) {
    const l = list === undefined || list === null ? ['count', 'sum', 'mean', 'min', 'max'] : Array.isArray(list) ? list : String(list).split(/[\s,]+/);
    return l.filter(Boolean).map(function (s) {
      let k = String(s).toLowerCase().trim();
      if (k === 'avg' || k === 'average') k = 'mean';
      if (k === 'stdev' || k === 'stddev' || k === 'sd') k = 'std';
      if (k === 'mode') k = 'majority';
      if (k === 'n') k = 'count';
      if (STAT_NAMES.indexOf(k) < 0) throw new Error('Unknown statistic "' + s + '". Use: ' + STAT_NAMES.join(', '));
      return k;
    });
  }

  /**
   * Statistics of one band inside each polygon. Polygons (EPSG:4326) are
   * projected to the raster CRS and rasterised on pixel centres (even-odd:
   * holes and MultiPolygon parts are honoured). No-data/NaN pixels are
   * ignored. Features without overlap get count 0 and null for everything
   * else; non-polygon features are treated as not overlapping.
   *
   * @param {object} raster
   * @param {number|string} band
   * @param {object} fc FeatureCollection of (Multi)Polygons in EPSG:4326
   * @param {{stats?: string[], prefix?: string}} [opts] stats from
   *   count, sum, mean, min, max, std (population), median, majority, minority, range, variety
   * @returns {object} new FeatureCollection (properties copied, stats added as <prefix><stat>)
   */
  function zonalStats(raster, band, fc, opts) {
    const b = bandIndex(raster, band);
    const o = opts || {};
    const list = statList(o.stats);
    const prefix = o.prefix === undefined || o.prefix === null ? '' : String(o.prefix);
    checkCrs(raster, 'used for zonal statistics');
    const t = raster.transform, W = raster.width, H = raster.height;
    const arr = raster.bands[b], nd = noDataOf(raster);
    const tf = transformer('EPSG:4326', raster.crs);
    const needValues = list.some(function (s) { return s === 'median' || s === 'majority' || s === 'minority' || s === 'variety'; });
    const scanner = createScanner(W, H);
    let vals = needValues ? new Float64Array(4096) : null;
    const feats = (fc && fc.features) || [];
    const out = new Array(feats.length);
    for (let fi = 0; fi < feats.length; fi++) {
      const f = feats[fi];
      const props = Object.assign({}, f && f.properties);
      let count = 0, sum = 0, min = Infinity, max = -Infinity, K = 0, s1 = 0, s2 = 0, nv = 0;
      const rings = f && f.geometry ? polygonRings(f.geometry) : null;
      if (rings && rings.length) {
        const ns = scanner.scan(ringsToPixels(rings, tf, t));
        const sp = scanner.spans;
        for (let s = 0; s < ns; s++) {
          const rowOff = sp[3 * s] * W;
          const end = rowOff + sp[3 * s + 2];
          for (let k = rowOff + sp[3 * s + 1]; k < end; k++) {
            const v = arr[k];
            if (v !== v || v === nd) continue;
            if (count === 0) K = v;
            count++;
            sum += v;
            if (v < min) min = v;
            if (v > max) max = v;
            const d = v - K;
            s1 += d; s2 += d * d;
            if (vals) {
              if (nv === vals.length) { const g = new Float64Array(nv * 2); g.set(vals); vals = g; }
              vals[nv++] = v;
            }
          }
        }
      }
      let sorted = null;
      if (vals && count) sorted = vals.subarray(0, nv).sort();
      let runs = null;
      const getRuns = function () {
        if (runs) return runs;
        let majV = sorted[0], majC = 0, minV = sorted[0], minC = Infinity, variety = 0;
        for (let i = 0; i < nv;) {
          let j = i + 1;
          while (j < nv && sorted[j] === sorted[i]) j++;
          const c = j - i;
          variety++;
          if (c > majC) { majC = c; majV = sorted[i]; }
          if (c < minC) { minC = c; minV = sorted[i]; }
          i = j;
        }
        runs = { majority: majV, minority: minV, variety: variety };
        return runs;
      };
      for (let si = 0; si < list.length; si++) {
        const name = list[si];
        let val = null;
        if (name === 'count') val = count;
        else if (count) {
          switch (name) {
            case 'sum': val = sum; break;
            case 'mean': val = sum / count; break;
            case 'min': val = min; break;
            case 'max': val = max; break;
            case 'range': val = max - min; break;
            case 'std': { const m1 = s1 / count; val = Math.sqrt(Math.max(0, s2 / count - m1 * m1)); break; }
            case 'median': val = nv % 2 ? sorted[(nv - 1) / 2] : (sorted[nv / 2 - 1] + sorted[nv / 2]) / 2; break;
            case 'majority': val = getRuns().majority; break;
            case 'minority': val = getRuns().minority; break;
            case 'variety': val = getRuns().variety; break;
            default: break;
          }
        }
        props[prefix + name] = val;
      }
      out[fi] = { type: 'Feature', geometry: f ? f.geometry : null, properties: props };
    }
    return { type: 'FeatureCollection', features: out };
  }

  /* ============================================================== sample */

  /**
   * Band values at each feature (points; lines use their first vertex,
   * polygons their centroid). Outside / no-data -> null.
   *
   * @param {object} raster
   * @param {object} fc FeatureCollection in EPSG:4326
   * @param {{bands?: 'all'|Array<number|string>, method?: 'nearest'|'bilinear', prefix?: string}} [opts]
   *   fields are named <prefix><band number> (b1, b2, ...), or by band name when prefix is ''
   * @returns {object} new FeatureCollection with the values added
   */
  function sample(raster, fc, opts) {
    checkRaster(raster);
    checkCrs(raster, 'sampled');
    const o = opts || {};
    const method = String(o.method || 'nearest').toLowerCase();
    if (method !== 'nearest' && method !== 'bilinear') throw new Error('Unknown sampling method "' + o.method + '". Use nearest or bilinear');
    const prefix = o.prefix === undefined || o.prefix === null ? 'b' : String(o.prefix);
    const idx = o.bands === undefined || o.bands === null || o.bands === 'all' ? raster.bands.map(function (_, i) { return i; }) :
      (Array.isArray(o.bands) ? o.bands : [o.bands]).map(function (bb) { return bandIndex(raster, bb); });
    const fields = idx.map(function (bi) {
      return prefix === '' ? (raster.bandNames[bi] || 'b' + (bi + 1)) : prefix + (bi + 1);
    });
    const W = raster.width, H = raster.height, nd = noDataOf(raster);
    const feats = (fc && fc.features) || [];
    return {
      type: 'FeatureCollection',
      features: feats.map(function (f) {
        const props = Object.assign({}, f && f.properties);
        const pt = f && representativePoint(f.geometry);
        const pos = pt && isNum(pt[0]) && isNum(pt[1]) ? locate(raster, pt[0], pt[1]) : null;
        const inside = pos && pos[0] >= 0 && pos[0] < W && pos[1] >= 0 && pos[1] < H;
        for (let q = 0; q < idx.length; q++) {
          let val = null;
          if (inside) {
            const arr = raster.bands[idx[q]];
            const v = arr[Math.floor(pos[1]) * W + Math.floor(pos[0])];
            if (v === v && v !== nd) {
              val = method === 'bilinear' ? bilinearAt(arr, W, H, nd, pos[0], pos[1]) : v;
              if (val !== val) val = v;
            }
          }
          props[fields[q]] = val;
        }
        return { type: 'Feature', geometry: f ? f.geometry : null, properties: props };
      }),
    };
  }

  /**
   * Values of every band at a lon/lat (for click-identify). Longitudes are
   * wrapped for EPSG:4326 rasters, so clicks on world copies work.
   *
   * @param {object} raster
   * @param {number} lng
   * @param {number} lat
   * @returns {Array<number|null>} one entry per band; null outside the raster or for no-data
   */
  function valueAt(raster, lng, lat) {
    checkRaster(raster);
    const out = new Array(raster.bands.length).fill(null);
    if (!isNum(lng) || !isNum(lat) || !raster.crs || !crsLib().has(raster.crs)) return out;
    const pos = locate(raster, lng, lat);
    if (!pos || !(pos[0] >= 0 && pos[0] < raster.width && pos[1] >= 0 && pos[1] < raster.height)) return out;
    const k = Math.floor(pos[1]) * raster.width + Math.floor(pos[0]);
    const nd = noDataOf(raster);
    for (let b = 0; b < raster.bands.length; b++) {
      const v = raster.bands[b][k];
      out[b] = v !== v || v === nd ? null : v;
    }
    return out;
  }

  /* ============================================================= terrain */

  /**
   * Hillshade, slope or aspect from an elevation band (Horn's 3x3 method,
   * edges replicated with one-sided differences, no-data neighbours replaced
   * by the centre cell). Cell sizes are in meters: per row from the latitude
   * for geographic rasters, × metersPerUnit for projected ones; elevations
   * are assumed to be meters (use zFactor otherwise, e.g. 0.3048 for feet).
   *
   * - hillshade: uint8, 1-255 (0 = no-data), light from azimuth/altitude
   * - slope: float32 degrees (or percent), no-data -9999
   * - aspect: float32 compass degrees of the downslope direction (0 = north,
   *   90 = east); flat cells are no-data (-9999)
   *
   * @param {object} raster
   * @param {number|string} band
   * @param {'hillshade'|'slope'|'aspect'} type
   * @param {{azimuth?:number, altitude?:number, zFactor?:number, slopeUnits?:'degrees'|'percent'}} [opts]
   * @returns {object} single-band Raster on the same grid
   */
  function terrain(raster, band, type, opts) {
    const b = bandIndex(raster, band);
    const o = opts || {};
    const kind = String(type || '').toLowerCase().replace(/[\s_-]/g, '');
    const mode = kind === 'hillshade' || kind === 'hs' || kind === 'shade' || kind === 'shadedrelief' ? 'hillshade' :
      kind === 'slope' ? 'slope' : kind === 'aspect' ? 'aspect' : null;
    if (!mode) throw new Error('Unknown terrain analysis "' + type + '". Use hillshade, slope or aspect');
    const W = raster.width, H = raster.height, t = raster.transform;
    const arr = raster.bands[b], nd = noDataOf(raster);
    const zf = isNum(o.zFactor) ? o.zFactor : 1;
    const percent = /^perc|^%|^pct/i.test(String(o.slopeUnits || ''));
    const az = (isNum(o.azimuth) ? o.azimuth : 315) * D2R, alt = (isNum(o.altitude) ? o.altitude : 45) * D2R;
    const sinAlt = Math.sin(alt), cosAlt = Math.cos(alt), sinAz = Math.sin(az), cosAz = Math.cos(az);

    let geographic = isGeographicCrs(raster.crs);
    if (!raster.crs) geographic = crsLib().looksGeographic(raster.bbox);
    let mpu = 1;
    if (!geographic && raster.crs) {
      try { mpu = crsLib().metersPerUnit(raster.crs) || 1; } catch (e) { mpu = 1; }
    }
    const cellXConst = Math.abs(t[1]) * mpu, cellYConst = Math.abs(t[5]) * mpu;

    const isHs = mode === 'hillshade';
    const out = isHs ? new Uint8Array(W * H) : new Float32Array(W * H);
    const fill = isHs ? 0 : -9999;
    for (let r = 0; r < H; r++) {
      let cx = cellXConst, cy = cellYConst;
      if (geographic) {
        const lat = Math.max(-89.9999, Math.min(89.9999, t[3] + (r + 0.5) * t[5]));
        const m = metersPerDegree(lat);
        cx = Math.abs(t[1]) * m.x;
        cy = Math.abs(t[5]) * m.y;
      }
      const rn = r > 0 ? r - 1 : 0, rs = r < H - 1 ? r + 1 : H - 1;
      const spanY = rs - rn;
      const on = rn * W, oc = r * W, os = rs * W;
      for (let c = 0; c < W; c++) {
        const e = arr[oc + c];
        if (e !== e || e === nd) { out[oc + c] = fill; continue; }
        const cw = c > 0 ? c - 1 : 0, ce = c < W - 1 ? c + 1 : W - 1;
        const spanX = ce - cw;
        let a = arr[on + cw], bN = arr[on + c], cNE = arr[on + ce];
        let d = arr[oc + cw], f = arr[oc + ce];
        let g = arr[os + cw], h = arr[os + c], i = arr[os + ce];
        if (a !== a || a === nd) a = e;
        if (bN !== bN || bN === nd) bN = e;
        if (cNE !== cNE || cNE === nd) cNE = e;
        if (d !== d || d === nd) d = e;
        if (f !== f || f === nd) f = e;
        if (g !== g || g === nd) g = e;
        if (h !== h || h === nd) h = e;
        if (i !== i || i === nd) i = e;
        // p = dz/dx (east), q = dz/dy (north); rows run southward.
        const p = spanX ? (zf * ((cNE + 2 * f + i) - (a + 2 * d + g))) / (4 * spanX * cx) : 0;
        const q = spanY ? (zf * ((a + 2 * bN + cNE) - (g + 2 * h + i))) / (4 * spanY * cy) : 0;
        if (mode === 'slope') {
          const s = Math.sqrt(p * p + q * q);
          out[oc + c] = percent ? s * 100 : Math.atan(s) * R2D;
        } else if (mode === 'aspect') {
          if (p === 0 && q === 0) { out[oc + c] = fill; continue; }
          let asp = Math.atan2(-p, -q) * R2D;
          if (asp < 0) asp += 360;
          out[oc + c] = asp >= 360 ? 0 : asp;
        } else {
          const cosI = (sinAlt - (p * sinAz + q * cosAz) * cosAlt) / Math.sqrt(1 + p * p + q * q);
          out[oc + c] = cosI <= 0 ? 1 : 1 + Math.round(254 * cosI);
        }
      }
    }
    const meta = { source: mode };
    if (mode === 'slope') meta.units = percent ? 'percent' : 'degrees';
    if (mode === 'aspect') meta.units = 'degrees';
    return like(raster, [out], { noData: fill, dataType: isHs ? 'uint8' : 'float32', bandNames: [mode], meta: meta });
  }

  /* ============================================================ contours */

  function niceStep(x) {
    if (!(x > 0)) return 1;
    const e = Math.pow(10, Math.floor(Math.log10(x)));
    const f = x / e;
    return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * e;
  }

  /**
   * Contour lines (own marching squares on pixel centres, segments joined
   * into polylines; no-data cells leave gaps). One feature per level with
   * property `value` (LineString or MultiLineString, EPSG:4326). Closed
   * contours are rings whose first and last positions are identical.
   *
   * @param {object} raster
   * @param {number|string} band
   * @param {{interval?: number, base?: number, levels?: number[], maxPixels?: number}} [opts]
   *   levels (explicit) or interval (from base; default: a round step giving ~10 levels);
   *   rasters bigger than maxPixels are block-averaged first
   * @returns {object} FeatureCollection
   */
  function contours(raster, band, opts) {
    const b = bandIndex(raster, band);
    const o = opts || {};
    checkCrs(raster, 'contoured');
    const src = raster.bands[b], nd = noDataOf(raster);
    const maxPixels = isNum(o.maxPixels) && o.maxPixels > 0 ? o.maxPixels : 4e6;
    let W = raster.width, H = raster.height;
    const t = raster.transform;
    let gt = t.slice();
    const wide = raster.dataType === 'float64' || raster.dataType === 'int32' || raster.dataType === 'uint32';
    let grid;
    if (W * H > maxPixels) {
      const s = Math.ceil(Math.sqrt((W * H) / maxPixels));
      const gw = Math.ceil(W / s), gh = Math.ceil(H / s);
      grid = wide ? new Float64Array(gw * gh) : new Float32Array(gw * gh);
      const sums = new Float64Array(gw), cnts = new Uint32Array(gw);
      for (let br = 0; br < gh; br++) {
        sums.fill(0); cnts.fill(0);
        for (let r = br * s; r < Math.min(H, (br + 1) * s); r++) {
          const off = r * W;
          for (let c = 0; c < W; c++) {
            const v = src[off + c];
            if (v !== v || v === nd) continue;
            const bc = (c / s) | 0;
            sums[bc] += v; cnts[bc]++;
          }
        }
        for (let bc = 0; bc < gw; bc++) grid[br * gw + bc] = cnts[bc] ? sums[bc] / cnts[bc] : NaN;
      }
      W = gw; H = gh;
      gt = [t[0], t[1] * s, 0, t[3], 0, t[5] * s];
    } else {
      grid = wide ? new Float64Array(W * H) : new Float32Array(W * H);
      for (let k = 0; k < W * H; k++) { const v = src[k]; grid[k] = v === nd ? NaN : v; }
    }

    // Levels.
    let levels;
    if (Array.isArray(o.levels) && o.levels.length) {
      levels = o.levels.map(Number).filter(isNum).sort(function (x, y) { return x - y; })
        .filter(function (v, i, a) { return i === 0 || v !== a[i - 1]; });
    } else {
      const st = bandStats(raster, b);
      if (!st.count) return { type: 'FeatureCollection', features: [] };
      let interval = o.interval;
      if (interval !== undefined && interval !== null && !(Number(interval) > 0)) throw new Error('The contour interval must be a positive number');
      interval = interval ? Number(interval) : niceStep((st.max - st.min) / 10);
      const base = isNum(o.base) ? o.base : 0;
      const k0 = Math.ceil((st.min - base) / interval - 1e-9), k1 = Math.floor((st.max - base) / interval + 1e-9);
      if (k1 - k0 + 1 > 1000) {
        throw new Error('That interval would create ' + fmtInt(k1 - k0 + 1) + ' contour levels; use an interval of at least ' +
          niceStep((st.max - st.min) / 1000));
      }
      levels = [];
      for (let k = k0; k <= k1; k++) levels.push(parseFloat((base + k * interval).toPrecision(12)));
    }
    const nl = levels.length;
    if (!nl) return { type: 'FeatureCollection', features: [] };

    // One pass over the cells for all levels.
    const WH = W * H;
    const segs = [], counts = new Int32Array(nl), partners = [], pending = [];
    for (let l = 0; l < nl; l++) { segs.push(new Int32Array(256)); partners.push(new Int32Array(256)); pending.push(new Map()); }
    const addSeg = function (l, e0, e1) {
      let s = segs[l], pt = partners[l];
      const n = counts[l];
      if (2 * n + 2 > s.length) {
        const s2 = new Int32Array(s.length * 2); s2.set(s); segs[l] = s = s2;
        const p2 = new Int32Array(pt.length * 2); p2.set(pt); partners[l] = pt = p2;
      }
      s[2 * n] = e0; s[2 * n + 1] = e1;
      pt[2 * n] = -1; pt[2 * n + 1] = -1;
      const pm = pending[l];
      for (let end = 0; end < 2; end++) {
        const e = end ? e1 : e0, slot = 2 * n + end;
        const other = pm.get(e);
        if (other === undefined) pm.set(e, slot);
        else { pt[slot] = other; pt[other] = slot; pm.delete(e); }
      }
      counts[l] = n + 1;
    };
    for (let r = 0; r < H - 1; r++) {
      for (let c = 0; c < W - 1; c++) {
        const k = r * W + c;
        const tl = grid[k], tr = grid[k + 1], bl = grid[k + W], br = grid[k + W + 1];
        if (tl !== tl || tr !== tr || bl !== bl || br !== br) continue;
        let mn = tl, mx = tl;
        if (tr < mn) mn = tr; if (tr > mx) mx = tr;
        if (bl < mn) mn = bl; if (bl > mx) mx = bl;
        if (br < mn) mn = br; if (br > mx) mx = br;
        if (mn === mx) continue;
        let lo = 0, hi = nl;
        while (lo < hi) { const mid = (lo + hi) >> 1; if (levels[mid] <= mn) lo = mid + 1; else hi = mid; }
        const eTop = k, eBot = k + W, eLeft = WH + k, eRight = WH + k + 1;
        for (let l = lo; l < nl && levels[l] <= mx; l++) {
          const L = levels[l];
          const cs = (tl >= L ? 8 : 0) | (tr >= L ? 4 : 0) | (br >= L ? 2 : 0) | (bl >= L ? 1 : 0);
          switch (cs) {
            case 1: case 14: addSeg(l, eLeft, eBot); break;
            case 2: case 13: addSeg(l, eBot, eRight); break;
            case 3: case 12: addSeg(l, eLeft, eRight); break;
            case 4: case 11: addSeg(l, eTop, eRight); break;
            case 6: case 9: addSeg(l, eTop, eBot); break;
            case 7: case 8: addSeg(l, eLeft, eTop); break;
            case 5: case 10: {
              const centreAbove = (tl + tr + bl + br) / 4 >= L;
              // 5 = tr & bl above, 10 = tl & br above
              if ((cs === 5) === centreAbove) { addSeg(l, eLeft, eTop); addSeg(l, eBot, eRight); }
              else { addSeg(l, eTop, eRight); addSeg(l, eLeft, eBot); }
              break;
            }
            default: break;
          }
        }
      }
    }

    // Join segments into polylines and convert to lon/lat.
    const kind = crsKind(raster.crs);
    const tf = kind === 'other' ? transformer(raster.crs, 'EPSG:4326') : null;
    const toLL = function (px, py) {
      const x = gt[0] + px * gt[1], y = gt[3] + py * gt[5];
      if (kind === 'lonlat') return [x, y];
      if (kind === 'merc') return [xToLng(x), yToLat(y)];
      const q = tf([x, y]);
      return q && isFinite(q[0]) && isFinite(q[1]) ? [q[0], q[1]] : null;
    };
    const features = [];
    for (let l = 0; l < nl; l++) {
      const n = counts[l];
      if (!n) continue;
      const L = levels[l], s = segs[l], pt = partners[l];
      const visited = new Uint8Array(n);
      const lines = [];
      const edgePoint = function (id) {
        let px, py, v0, v1;
        if (id < WH) {
          const r = (id / W) | 0, c = id - r * W;
          v0 = grid[id]; v1 = grid[id + 1];
          px = c + 0.5 + (L - v0) / (v1 - v0); py = r + 0.5;
        } else {
          const kk = id - WH, r = (kk / W) | 0, c = kk - r * W;
          v0 = grid[kk]; v1 = grid[kk + W];
          px = c + 0.5; py = r + 0.5 + (L - v0) / (v1 - v0);
        }
        return toLL(px, py);
      };
      const walk = function (slot) {
        const coords = [];
        const push = function (id) {
          const p = edgePoint(id);
          if (!p) return;
          const last = coords[coords.length - 1];
          if (!last || last[0] !== p[0] || last[1] !== p[1]) coords.push(p);
        };
        let sg = slot >> 1, end = slot & 1;
        push(s[slot]);
        for (;;) {
          visited[sg] = 1;
          const exit = 2 * sg + (1 - end);
          push(s[exit]);
          const nx = pt[exit];
          if (nx < 0) break;
          const ns = nx >> 1;
          if (visited[ns]) break;
          sg = ns; end = nx & 1;
        }
        if (coords.length >= 2) lines.push(coords);
      };
      for (let sg = 0; sg < n; sg++) {
        if (visited[sg]) continue;
        if (pt[2 * sg] < 0) walk(2 * sg);
        else if (pt[2 * sg + 1] < 0) walk(2 * sg + 1);
      }
      for (let sg = 0; sg < n; sg++) if (!visited[sg]) walk(2 * sg);
      if (!lines.length) continue;
      features.push({
        type: 'Feature',
        geometry: lines.length === 1 ? { type: 'LineString', coordinates: lines[0] } : { type: 'MultiLineString', coordinates: lines },
        properties: { value: L },
      });
    }
    return { type: 'FeatureCollection', features: features };
  }

  /* ================================================================= IDW */

  /** k-nearest-neighbour search over points with a uniform bucket grid. */
  function makeKnn(px, py, n) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let p = 0; p < n; p++) {
      if (px[p] < minX) minX = px[p]; if (px[p] > maxX) maxX = px[p];
      if (py[p] < minY) minY = py[p]; if (py[p] > maxY) maxY = py[p];
    }
    const w = maxX - minX || 1, h = maxY - minY || 1;
    const target = Math.max(1, n / 4);
    const gx = Math.max(1, Math.min(2048, Math.round(Math.sqrt((target * w) / h))));
    const gy = Math.max(1, Math.min(2048, Math.round(target / gx)));
    const bw = w / gx, bh = h / gy;
    const starts = new Int32Array(gx * gy + 1), cellOf = new Int32Array(n), items = new Int32Array(n);
    for (let p = 0; p < n; p++) {
      let bx = Math.floor((px[p] - minX) / bw), by = Math.floor((py[p] - minY) / bh);
      if (bx >= gx) bx = gx - 1; if (by >= gy) by = gy - 1;
      cellOf[p] = by * gx + bx;
      starts[cellOf[p] + 1]++;
    }
    for (let c = 0; c < gx * gy; c++) starts[c + 1] += starts[c];
    const pos = starts.slice(0, gx * gy);
    for (let p = 0; p < n; p++) items[pos[cellOf[p]]++] = p;

    return function query(x, y, k, r2max, outIdx, outD2) {
      let found = 0;
      const visit = function (cell) {
        for (let q = starts[cell]; q < starts[cell + 1]; q++) {
          const p = items[q];
          const dx = px[p] - x, dy = py[p] - y, d2 = dx * dx + dy * dy;
          if (d2 > r2max) continue;
          let at;
          if (found < k) at = found++;
          else if (d2 < outD2[k - 1]) at = k - 1;
          else continue;
          while (at > 0 && outD2[at - 1] > d2) { outD2[at] = outD2[at - 1]; outIdx[at] = outIdx[at - 1]; at--; }
          outD2[at] = d2; outIdx[at] = p;
        }
      };
      let bx0 = Math.floor((x - minX) / bw), by0 = Math.floor((y - minY) / bh);
      bx0 = bx0 < 0 ? 0 : bx0 >= gx ? gx - 1 : bx0;
      by0 = by0 < 0 ? 0 : by0 >= gy ? gy - 1 : by0;
      for (let ring = 0; ; ring++) {
        const xlo = bx0 - ring, xhi = bx0 + ring, ylo = by0 - ring, yhi = by0 + ring;
        for (let by = Math.max(0, ylo); by <= Math.min(gy - 1, yhi); by++) {
          if (by === ylo || by === yhi) {
            for (let bx = Math.max(0, xlo); bx <= Math.min(gx - 1, xhi); bx++) visit(by * gx + bx);
          } else {
            if (xlo >= 0) visit(by * gx + xlo);
            if (xhi <= gx - 1 && xhi !== xlo) visit(by * gx + xhi);
          }
        }
        const dL = xlo <= 0 ? Infinity : x - (minX + xlo * bw);
        const dR = xhi >= gx - 1 ? Infinity : minX + (xhi + 1) * bw - x;
        const dB = ylo <= 0 ? Infinity : y - (minY + ylo * bh);
        const dT = yhi >= gy - 1 ? Infinity : minY + (yhi + 1) * bh - y;
        const dmin = Math.min(dL, dR, dB, dT);
        if (dmin === Infinity) break;
        const d2min = dmin > 0 ? dmin * dmin : 0;
        if (found >= k && d2min >= outD2[k - 1]) break;
        if (d2min > r2max) break;
      }
      return found;
    };
  }

  /**
   * Inverse-distance-weighted interpolation of a numeric point attribute onto
   * a float32 grid in EPSG:3857 (no-data = -9999). The surface honours the
   * data: a cell containing sample points takes their mean value; other
   * cells use the k nearest points (optionally within `radius`) weighted by
   * 1 / distance^power.
   *
   * @param {object} pointsFc FeatureCollection of (Multi)Points in EPSG:4326
   * @param {string} field numeric property to interpolate
   * @param {{cellSize?: number, width?: number, power?: number, bbox?: number[], k?: number, radius?: number}} [opts]
   *   cellSize and radius are ground meters (at the grid's centre latitude); without cellSize the
   *   grid is `width` (default 256) pixels on its longest side; bbox [minLng, minLat, maxLng, maxLat]
   *   defaults to the points' extent; k defaults to 12; power to 2
   * @returns {object} Raster
   */
  function idw(pointsFc, field, opts) {
    const o = opts || {};
    if (!field) throw new Error('Say which numeric field to interpolate');
    const feats = (pointsFc && pointsFc.features) || [];
    const lng = [], lat = [], val = [];
    const addPt = function (c, v) {
      if (c && isNum(c[0]) && isNum(c[1]) && Math.abs(c[1]) <= 90) { lng.push(c[0]); lat.push(c[1]); val.push(v); }
    };
    for (let i = 0; i < feats.length; i++) {
      const f = feats[i];
      if (!f || !f.geometry || !f.properties) continue;
      const raw = f.properties[field];
      if (raw === null || raw === undefined || raw === '') continue;
      const v = typeof raw === 'number' ? raw : Number(raw);
      if (!isNum(v)) continue;
      const g = f.geometry;
      if (g.type === 'Point') addPt(g.coordinates, v);
      else if (g.type === 'MultiPoint') (g.coordinates || []).forEach(function (c) { addPt(c, v); });
    }
    const n = val.length;
    if (!n) throw new Error('No points with a numeric "' + field + '" value to interpolate');

    let bb = o.bbox;
    if (bb) {
      if (bb.length < 4 || !bb.every(isNum) || !(bb[2] > bb[0]) || !(bb[3] > bb[1])) {
        throw new Error('The interpolation bbox must be [minLng, minLat, maxLng, maxLat]');
      }
    } else {
      bb = [Infinity, Infinity, -Infinity, -Infinity];
      for (let p = 0; p < n; p++) {
        if (lng[p] < bb[0]) bb[0] = lng[p];
        if (lng[p] > bb[2]) bb[2] = lng[p];
        if (lat[p] < bb[1]) bb[1] = lat[p];
        if (lat[p] > bb[3]) bb[3] = lat[p];
      }
    }
    let mx0 = lngToX(bb[0]), mx1 = lngToX(bb[2]), my0 = latToY(bb[1]), my1 = latToY(bb[3]);
    const latC = yToLat((my0 + my1) / 2);
    const k2m = 1 / Math.cos(latC * D2R);             // ground meters -> mercator units
    if (mx1 - mx0 <= 0 || my1 - my0 <= 0) {
      const pad = Math.max(mx1 - mx0, my1 - my0) * 0.05 || 1000 * k2m;
      if (mx1 - mx0 <= 0) { mx0 -= pad; mx1 += pad; }
      if (my1 - my0 <= 0) { my0 -= pad; my1 += pad; }
    }
    // Without a bbox the grid extends half a cell beyond the outermost points,
    // so they sit at cell centres (and `width` is then the exact size).
    const padded = !o.bbox;
    let cell;
    if (isNum(o.cellSize) && o.cellSize > 0) cell = o.cellSize * k2m;
    else {
      const wpx = isNum(o.width) && o.width >= 1 ? Math.floor(o.width) : 256;
      cell = Math.max(mx1 - mx0, my1 - my0) / (padded && wpx > 1 ? wpx - 1 : wpx);
    }
    if (padded) { mx0 -= cell / 2; mx1 += cell / 2; my0 -= cell / 2; my1 += cell / 2; }
    const W = Math.max(1, Math.ceil((mx1 - mx0) / cell - 1e-9)), H = Math.max(1, Math.ceil((my1 - my0) / cell - 1e-9));
    if (W * H > 25e6) {
      throw new Error('That cell size would make a ' + fmtInt(W) + ' × ' + fmtInt(H) + ' grid; use a larger cell size');
    }
    const t = [mx0, cell, 0, my1, 0, -cell];
    const px = new Float64Array(n), py = new Float64Array(n);
    for (let p = 0; p < n; p++) { px[p] = lngToX(lng[p]); py[p] = latToY(lat[p]); }
    const power = isNum(o.power) && o.power > 0 ? o.power : 2;
    const k = Math.max(1, Math.min(n, isNum(o.k) && o.k >= 1 ? Math.floor(o.k) : 12));
    const r2max = isNum(o.radius) && o.radius > 0 ? Math.pow(o.radius * k2m, 2) : Infinity;
    const out = new Float32Array(W * H);
    const ND = -9999;

    // Cells containing sample points keep the points' mean.
    const exact = new Map();
    for (let p = 0; p < n; p++) {
      let c = Math.floor((px[p] - t[0]) / cell), r = Math.floor((t[3] - py[p]) / cell);
      if (c === W && px[p] <= mx1) c = W - 1;          // exactly on the bbox's east / south edge
      if (r === H && py[p] >= my0) r = H - 1;
      if (c < 0 || c >= W || r < 0 || r >= H) continue;
      const key = r * W + c;
      const e = exact.get(key);
      if (e) { e[0] += val[p]; e[1]++; } else exact.set(key, [val[p], 1]);
    }
    const query = n > 256 ? makeKnn(px, py, n) : null;
    const outIdx = new Int32Array(k), outD2 = new Float64Array(k);
    const halfP = power / 2;
    for (let r = 0; r < H; r++) {
      const y = t[3] - (r + 0.5) * cell;
      for (let c = 0; c < W; c++) {
        const key = r * W + c;
        const e = exact.size ? exact.get(key) : undefined;
        if (e) { out[key] = e[0] / e[1]; continue; }
        const x = t[0] + (c + 0.5) * cell;
        let found;
        if (query) found = query(x, y, k, r2max, outIdx, outD2);
        else {
          found = 0;
          for (let p = 0; p < n; p++) {
            const dx = px[p] - x, dy = py[p] - y, d2 = dx * dx + dy * dy;
            if (d2 > r2max) continue;
            let at;
            if (found < k) at = found++;
            else if (d2 < outD2[k - 1]) at = k - 1;
            else continue;
            while (at > 0 && outD2[at - 1] > d2) { outD2[at] = outD2[at - 1]; outIdx[at] = outIdx[at - 1]; at--; }
            outD2[at] = d2; outIdx[at] = p;
          }
        }
        if (!found) { out[key] = ND; continue; }
        if (outD2[0] === 0) { out[key] = val[outIdx[0]]; continue; }
        let ws = 0, vs = 0;
        for (let q = 0; q < found; q++) {
          const w = power === 2 ? 1 / outD2[q] : Math.pow(outD2[q], -halfP);
          ws += w; vs += w * val[outIdx[q]];
        }
        out[key] = vs / ws;
      }
    }
    return create({
      width: W, height: H, bands: [out], transform: t, crs: 'EPSG:3857', noData: ND, dataType: 'float32',
      bandNames: [String(field)], meta: { source: 'idw', field: field, power: power, k: k, points: n },
    });
  }

  /* ================================================================ clip */

  /**
   * Clip a raster to a bbox or to polygons (both EPSG:4326). With polygons,
   * pixels whose centres fall outside every polygon become no-data. A bbox on
   * an EPSG:4326/3857 raster is a plain crop (pixels whose centres fall
   * inside); on other CRSs it is treated as a polygon.
   *
   * @param {object} raster
   * @param {{bbox?: number[], fc?: object, geometry?: object}} region
   * @param {{crop?: boolean}} [opts] crop to the region's extent (default true)
   * @returns {object} Raster
   */
  function clip(raster, region, opts) {
    checkRaster(raster);
    checkCrs(raster, 'clipped');
    const o = opts || {};
    const crop = o.crop !== false;
    const W = raster.width, H = raster.height, t = raster.transform;
    const kind = crsKind(raster.crs);
    let rings = null, win = null, polys = null;
    if (region && region.bbox) {
      const b = region.bbox;
      if (b.length < 4 || !b.every(isNum) || !(b[2] > b[0]) || !(b[3] > b[1])) throw new Error('The clip bbox must be [minLng, minLat, maxLng, maxLat]');
      if (kind === 'lonlat' || kind === 'merc') {
        const f = kind === 'merc' ? function (x, y) { return [lngToX(x), latToY(y)]; } : function (x, y) { return [x, y]; };
        const p0 = f(b[0], b[1]), p1 = f(b[2], b[3]);
        let c0 = (p0[0] - t[0]) / t[1], c1 = (p1[0] - t[0]) / t[1];
        if (kind === 'lonlat' && c1 <= 0) { c0 += 360 / t[1]; c1 += 360 / t[1]; }
        if (kind === 'lonlat' && c0 >= W) { c0 -= 360 / t[1]; c1 -= 360 / t[1]; }
        const r0 = (p1[1] - t[3]) / t[5], r1 = (p0[1] - t[3]) / t[5];
        win = [Math.max(0, Math.ceil(c0 - 0.5)), Math.max(0, Math.ceil(r0 - 0.5)), Math.min(W, Math.ceil(c1 - 0.5)), Math.min(H, Math.ceil(r1 - 0.5))];
      } else {
        const ring = [];
        const n = 16;
        for (let i = 0; i < n; i++) ring.push([b[0] + ((b[2] - b[0]) * i) / n, b[1]]);
        for (let i = 0; i < n; i++) ring.push([b[2], b[1] + ((b[3] - b[1]) * i) / n]);
        for (let i = 0; i < n; i++) ring.push([b[2] - ((b[2] - b[0]) * i) / n, b[3]]);
        for (let i = 0; i < n; i++) ring.push([b[0], b[3] - ((b[3] - b[1]) * i) / n]);
        ring.push(ring[0]);
        polys = [[ring]];
      }
    } else if (region && (region.fc || region.geometry || region.type)) {
      const src = region.fc || region.geometry || region;
      const fc = M.util && M.util.toFeatureCollection ? M.util.toFeatureCollection(src) : src;
      polys = [];
      (fc.features || []).forEach(function (f) {
        const r = polygonRings(f.geometry);
        if (r.length) polys.push(r);
      });
      if (!polys.length) throw new Error('The clip layer has no polygons');
    } else {
      throw new Error('Clip needs a bbox or a polygon layer');
    }

    let mask = null;
    if (polys) {
      // Rasterise each feature separately (union across features, even-odd within one),
      // and crop to the pixels actually covered.
      const tf = transformer('EPSG:4326', raster.crs);
      rings = polys.map(function (p) { return ringsToPixels(p, tf, t); });
      mask = new Uint8Array(W * H);
      const scanner = createScanner(W, H);
      win = [W, H, 0, 0];
      rings.forEach(function (rs) {
        const ns = scanner.scan(rs);
        const sp = scanner.spans;
        for (let s = 0; s < ns; s++) {
          const r = sp[3 * s], c0 = sp[3 * s + 1], c1 = sp[3 * s + 2];
          mask.fill(1, r * W + c0, r * W + c1);
          if (c0 < win[0]) win[0] = c0;
          if (r < win[1]) win[1] = r;
          if (c1 > win[2]) win[2] = c1;
          if (r + 1 > win[3]) win[3] = r + 1;
        }
      });
    }
    if (!(win[2] > win[0]) || !(win[3] > win[1])) throw new Error('The clip area doesn\'t overlap this raster');
    if (!crop && !mask) {
      // A bbox without cropping: blank everything outside the window.
      mask = new Uint8Array(W * H);
      for (let r = win[1]; r < win[3]; r++) mask.fill(1, r * W + win[0], r * W + win[2]);
    }
    if (!crop) win = [0, 0, W, H];

    const dt = raster.dataType || typeOfArray(raster.bands[0]);
    const nd = noDataOf(raster);
    const ndv = outputNoData(dt, nd, false, 'imagery');
    const cw = win[2] - win[0], ch = win[3] - win[1];
    const bands = raster.bands.map(function (src) {
      const dst = allocBand(dt, cw * ch);
      for (let r = 0; r < ch; r++) {
        const so = (r + win[1]) * W + win[0], dO = r * cw;
        if (!mask) { dst.set(src.subarray(so, so + cw), dO); continue; }
        for (let c = 0; c < cw; c++) dst[dO + c] = mask[so + c] === 1 ? src[so + c] : ndv.fill;
      }
      return dst;
    });
    return create({
      width: cw, height: ch, bands: bands, transform: [t[0] + win[0] * t[1], t[1], 0, t[3] + win[1] * t[5], 0, t[5]],
      crs: raster.crs, noData: mask ? ndv.noData : raster.noData, dataType: dt, bandNames: raster.bandNames.slice(),
      meta: Object.assign({}, raster.meta, { clipped: true }),
    });
  }

  /* ============================================================ outlines */

  /**
   * The raster's outline as a GeoJSON Polygon in EPSG:4326 (edges densified
   * for projected CRSs; longitudes unwrapped across the antimeridian; a polar
   * cap becomes a lon/lat box).
   *
   * @param {object} raster
   * @returns {{type: 'Polygon', coordinates: number[][][]}}
   */
  function footprint(raster) {
    checkRaster(raster);
    return { type: 'Polygon', coordinates: [wgs84Outline(raster).ring] };
  }

  /**
   * The raster's extent in lon/lat: [minLng, minLat, maxLng, maxLat].
   * @param {object} raster
   * @returns {number[]}
   */
  function bboxWGS84(raster) {
    checkRaster(raster);
    return wgs84Outline(raster).bbox.slice();
  }

  /* ================================================================ info */

  /**
   * Plain summary for the console: size, bands, data type, CRS name, pixel
   * size + units (and approximate meters), extent (native + WGS 84), no-data,
   * memory and per-band statistics.
   *
   * @param {object} raster
   * @returns {object}
   */
  function info(raster) {
    checkRaster(raster);
    const C = crsLib();
    const t = raster.transform, meta = raster.meta || {};
    const known = !!raster.crs && C.has(raster.crs);
    const geographic = known && isGeographicCrs(raster.crs);
    let units = 'unknown', perUnit = null;
    if (known) {
      units = C.units(raster.crs);
      perUnit = geographic ? null : C.metersPerUnit(raster.crs) || 1;
    }
    let bbW = null;
    try { if (known) bbW = bboxWGS84(raster); } catch (e) { bbW = null; }
    let pxm = null;
    if (geographic) {
      const m = metersPerDegree(t[3] + (raster.height / 2) * t[5]);
      pxm = [Math.abs(t[1]) * m.x, Math.abs(t[5]) * m.y];
    } else if (perUnit) {
      pxm = [Math.abs(t[1]) * perUnit, Math.abs(t[5]) * perUnit];
    }
    let bytes = 0;
    raster.bands.forEach(function (b) { bytes += b.byteLength; });
    const st = stats(raster);
    const out = {
      width: raster.width,
      height: raster.height,
      bands: raster.bands.length,
      bandNames: raster.bandNames.slice(),
      dataType: raster.dataType,
      crs: raster.crs,
      crsName: meta.crsName || (raster.crs ? C.name(raster.crs) : 'unknown (not georeferenced)'),
      pixelSize: [Math.abs(t[1]), Math.abs(t[5])],
      pixelUnits: units,
      pixelSizeMeters: pxm,
      bbox: raster.bbox.slice(),
      bboxWGS84: bbW,
      noData: raster.noData,
      sizeBytes: bytes,
      stats: st.map(function (s, i) {
        return { band: raster.bandNames[i], min: s.min, max: s.max, mean: s.mean, std: s.std, count: s.count };
      }),
    };
    if (meta.name) out.name = meta.name;
    if (meta.downsample) { out.downsample = meta.downsample; out.fullSize = meta.fullSize; }
    if (meta.warnings && meta.warnings.length) out.warnings = meta.warnings.slice();
    if (meta.crsUnknown) out.crsUnknown = true;
    if (meta.crsNeedsLookup) out.crsNeedsLookup = true;
    return out;
  }

  /* ============================================================== export */

  M.raster = {
    create: create,
    fromGeoTIFF: fromGeoTIFF,
    stats: stats,
    histogram: histogram,
    defaultStyle: defaultStyle,
    render: render,
    mapAlgebra: mapAlgebra,
    resampleTo: resampleTo,
    reclassify: reclassify,
    zonalStats: zonalStats,
    sample: sample,
    valueAt: valueAt,
    terrain: terrain,
    contours: contours,
    idw: idw,
    clip: clip,
    footprint: footprint,
    bboxWGS84: bboxWGS84,
    info: info,
    /** Resolve a band reference (0-based index, band name, or "b<n>") to an index; throws a readable error. */
    bandIndex: bandIndex,
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
