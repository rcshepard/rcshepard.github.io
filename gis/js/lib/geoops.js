/*
 * PSICITS — vector geoprocessing for GeoJSON FeatureCollections (EPSG:4326).
 *
 *   const out = PSICITS.geoops.buffer(fc, 500, { dissolve: true });
 *   if (out.warnings) console.warn(out.warnings);
 *
 * Conventions (see docs/CONVENTIONS.md):
 *  - Functions return a new FeatureCollection (unless documented otherwise)
 *    and never mutate their inputs. Output features get shallow-copied
 *    properties; geometries that pass through unchanged are shared with the
 *    input, so treat geometries as immutable. Input feature ids are not copied.
 *  - Non-fatal problems (features that could not be processed, skipped null
 *    geometries, fallbacks) are listed in an optional `warnings` array on the
 *    returned FeatureCollection.
 *  - Distances are meters unless a `units` option says otherwise. Lengths and
 *    distances are geodesic (haversine, mean Earth radius); areas use
 *    turf.area.
 *  - Two-layer operations index the second layer with RBush.
 *  - Polygon boolean operations (intersection/union/difference) use Turf 7
 *    (polyclip-ts) with retries on snapped coordinates; buffers use Turf/JSTS.
 *    Spatial predicates, line overlay, point-in-polygon, distances, clustering
 *    etc. are implemented here with a small planar tolerance (EPS degrees) so
 *    they behave consistently on messy real-world data.
 */
(function (root) {
  'use strict';

  const M = (root.PSICITS = root.PSICITS || {});
  const util = M.util;

  /* ================================================================ constants */

  const EPS = 1e-10;                  // planar tolerance in degrees (~0.01 mm)
  const R_EARTH = 6371008.8;          // mean Earth radius in meters (same as Turf)
  const RAD = Math.PI / 180;
  const M_PER_DEG = R_EARTH * RAD;    // meters per degree of latitude
  const MAX_GRID_CELLS = 200000;
  const MAX_OUTPUT_VERTICES = 5000000;
  const SEG_INDEX_MIN = 48;           // segments before a geometry gets an RBush segment index
  const PIP_INDEX_MIN = 256;          // ring vertices before point-in-polygon uses that index
  const LOCALIZE_MIN = 400;           // vertices before a polygon is pre-clipped to the area of interest
  const QT_LEAF = 256;                // max vertices per leaf of that pre-clip quadtree
  const UNION_BATCH = 32;             // polygons per batch when unioning many polygons

  const PREDICATES = ['intersects', 'within', 'contains', 'disjoint', 'touches', 'crosses', 'overlaps', 'within_distance'];
  const PREDICATE_ALIASES = {
    intersect: 'intersects', intersecting: 'intersects', inside: 'within', in: 'within',
    contain: 'contains', containing: 'contains', touch: 'touches', touching: 'touches',
    cross: 'crosses', crossing: 'crosses', overlap: 'overlaps', overlapping: 'overlaps',
    outside: 'disjoint', not_intersects: 'disjoint', within_distance_of: 'within_distance',
    withindistance: 'within_distance', dwithin: 'within_distance', near: 'within_distance', distance: 'within_distance',
  };
  const STAT_OPS = ['sum', 'mean', 'min', 'max', 'count', 'first', 'last', 'concat', 'unique_count', 'median', 'std'];
  const STAT_ALIASES = {
    avg: 'mean', average: 'mean', total: 'sum', n: 'count', minimum: 'min', maximum: 'max',
    distinct: 'unique_count', unique: 'unique_count', nunique: 'unique_count', count_distinct: 'unique_count',
    list: 'concat', join: 'concat', concatenate: 'concat', stdev: 'std', stddev: 'std', sd: 'std', med: 'median',
  };
  const CENTROID_METHODS = ['centroid', 'center_of_mass', 'point_on_surface'];
  const GRID_TYPES = ['square', 'hex', 'triangle', 'point'];
  const GRID_TYPE_ALIASES = {
    squares: 'square', fishnet: 'square', rectangle: 'square', rectangles: 'square', hexes: 'hex', hexagon: 'hex',
    hexagons: 'hex', hexagonal: 'hex', triangles: 'triangle', tri: 'triangle', points: 'point', pts: 'point',
  };

  /* ================================================================ libraries */

  function T() {
    const t = root.turf;
    if (!t) throw new Error('The Turf geometry library is not loaded');
    return t;
  }
  function newTree() {
    const R = root.RBush;
    if (!R) throw new Error('The RBush spatial index library is not loaded');
    return new R();
  }

  /* ================================================================== helpers */

  function isNum(v) { return typeof v === 'number' && isFinite(v); }
  function clamp01(t) { return t < 0 ? 0 : t > 1 ? 1 : t; }
  function numAsc(a, b) { return a - b; }
  function plural(n, one, many) { return n === 1 ? one : many; }
  function toArr(x) { return x === undefined || x === null || x === '' ? [] : Array.isArray(x) ? x : [x]; }

  function copyProps(f) {
    const p = f && f.properties;
    return p && typeof p === 'object' ? Object.assign({}, p) : {};
  }
  function feature(geometry, properties) {
    return { type: 'Feature', geometry: geometry || null, properties: properties || {} };
  }

  /** Accept a FeatureCollection (or Feature / geometry / array of them). */
  function asFC(x, label) {
    if (x && x.type === 'FeatureCollection' && Array.isArray(x.features)) return x;
    if (Array.isArray(x) || (x && typeof x.type === 'string' && (x.type === 'Feature' || x.coordinates || x.geometries))) {
      return util.toFeatureCollection(x);
    }
    throw new Error((label || 'Layer') + ' is not a valid feature collection');
  }

  /** Collects non-fatal problems, counted per kind. */
  function Warnings() { this.map = new Map(); }
  Warnings.prototype.add = function (key, fmt, detail) {
    let e = this.map.get(key);
    if (!e) { e = { n: 0, fmt: fmt, detail: null }; this.map.set(key, e); }
    e.n++;
    if (detail && !e.detail) e.detail = String(detail);
  };
  Warnings.prototype.note = function (msg) { this.add('note:' + msg, function () { return msg; }); };
  Warnings.prototype.skipNull = function () {
    this.add('null', function (n) { return n + plural(n, ' feature without geometry was', ' features without geometry were') + ' skipped'; });
  };
  Warnings.prototype.fail = function (what, err) {
    this.add('fail:' + what, function (n) { return n + plural(n, ' feature', ' features') + ' could not be ' + what; }, err && (err.message || err));
  };
  Warnings.prototype.count = function (key, one, many) {
    this.add(key, function (n) { return n + ' ' + (n === 1 ? one : many); });
  };
  Warnings.prototype.list = function () {
    return Array.from(this.map.values(), function (e) { return e.fmt(e.n) + (e.detail ? ' (' + e.detail + ')' : ''); });
  };

  function result(features, W) {
    const fc = { type: 'FeatureCollection', features: features };
    if (W) {
      const l = W.list();
      if (l.length) fc.warnings = l;
    }
    return fc;
  }

  /* -------------------------------------------------------------------- units */

  function linUnit(u) {
    if (u === undefined || u === null || u === '') return 'meters';
    const n = util.normalizeUnit(u);
    if (!n) throw new Error('Unknown distance unit "' + u + '" (use meters, kilometers, miles, feet, …)');
    return n;
  }
  function areaUnit(u) {
    if (u === undefined || u === null || u === '') return 'sqmeters';
    const n = util.normalizeAreaUnit(u);
    if (!n) throw new Error('Unknown area unit "' + u + '" (use sqmeters, sqkilometers, hectares, acres, sqmiles, …)');
    return n;
  }
  function toM(v, u) { return util.toMeters(v, linUnit(u)); }
  function requirePositive(v, what) {
    if (!isNum(v) || v <= 0) throw new Error(what + ' must be a number greater than 0');
    return v;
  }

  /* ------------------------------------------------------------ bbox helpers */

  function boxesIntersect(a, b) { return a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1]; }
  function boxContains(outer, inner) { return inner[0] >= outer[0] && inner[2] <= outer[2] && inner[1] >= outer[1] && inner[3] <= outer[3]; }
  function padBox(b, d) { return [b[0] - d, b[1] - d, b[2] + d, b[3] + d]; }
  function ringBBox(r) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let i = 0; i < r.length; i++) {
      const x = r[i][0], y = r[i][1];
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
    return [minX, minY, maxX, maxY];
  }
  function polysBBox(polys) {
    let b = null;
    for (let i = 0; i < polys.length; i++) b = util.bboxUnion(b, ringBBox(polys[i][0]));
    return b;
  }
  function geomBBox(g) {
    try { return util.bbox(g); } catch (e) { return null; }
  }
  /** Box around the area of interest with a margin so clipping artefacts stay outside it. */
  function marginBox(b) {
    const m = Math.max(1e-7, 0.01 * Math.max(b[2] - b[0], b[3] - b[1]));
    return padBox(b, m);
  }
  function rbox(b) { return { minX: b[0], minY: b[1], maxX: b[2], maxY: b[3] }; }

  /* ================================================================= geodesy */

  function hav(x1, y1, x2, y2) {
    const dLat = (y2 - y1) * RAD, dLon = (x2 - x1) * RAD;
    const s1 = Math.sin(dLat / 2), s2 = Math.sin(dLon / 2);
    const a = s1 * s1 + Math.cos(y1 * RAD) * Math.cos(y2 * RAD) * s2 * s2;
    return 2 * R_EARTH * Math.atan2(Math.sqrt(a), Math.sqrt(Math.max(0, 1 - a)));
  }
  /** Geodesic distance (m) from point (px,py) to segment ab (closest point found in a local plane). */
  function pointSegMeters(px, py, ax, ay, bx, by) {
    const kx = Math.cos(py * RAD);
    const ux = (ax - px) * kx, uy = ay - py;
    const dx = (bx - ax) * kx, dy = by - ay;
    const dd = dx * dx + dy * dy;
    const t = dd > 0 ? clamp01(-(ux * dx + uy * dy) / dd) : 0;
    return hav(px, py, ax + t * (bx - ax), ay + t * (by - ay));
  }
  /** Expand a lon/lat box by `m` meters in every direction (conservative). */
  function expandBox(b, m) {
    if (!(m > 0)) return b.slice();
    const dLat = (m / M_PER_DEG) * 1.001 + 1e-12;
    const lat = Math.max(Math.abs(b[1]), Math.abs(b[3])) + dLat;
    if (lat >= 89.9) return [Math.min(b[0], -180), b[1] - dLat, Math.max(b[2], 180), b[3] + dLat];
    const dLon = (m / (M_PER_DEG * Math.cos(lat * RAD))) * 1.001 + 1e-12;
    if (dLon >= 180) return [Math.min(b[0], -180), b[1] - dLat, Math.max(b[2], 180), b[3] + dLat];
    return [b[0] - dLon, b[1] - dLat, b[2] + dLon, b[3] + dLat];
  }
  function destination(lon, lat, meters, bearingDeg) {
    const d = meters / R_EARTH, th = bearingDeg * RAD, p1 = lat * RAD, l1 = lon * RAD;
    const p2 = Math.asin(Math.sin(p1) * Math.cos(d) + Math.cos(p1) * Math.sin(d) * Math.cos(th));
    const l2 = l1 + Math.atan2(Math.sin(th) * Math.sin(d) * Math.cos(p1), Math.cos(d) - Math.sin(p1) * Math.sin(p2));
    return [l2 / RAD, p2 / RAD];
  }
  function pathLengthM(c) {
    let s = 0;
    for (let i = 0; i < c.length - 1; i++) s += hav(c[i][0], c[i][1], c[i + 1][0], c[i + 1][1]);
    return s;
  }
  function geodesicArea(polys) {
    if (!polys.length) return 0;
    return T().area({ type: 'MultiPolygon', coordinates: polys });
  }

  /* ======================================================= geometry cleaning */

  function isPos(p) { return Array.isArray(p) && p.length >= 2 && isNum(p[0]) && isNum(p[1]); }
  function samePos(a, b) { return a[0] === b[0] && a[1] === b[1]; }
  function lerpPos(a, b, t) {
    const p = [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])];
    if (a.length > 2 && b.length > 2 && isNum(a[2]) && isNum(b[2])) p.push(a[2] + t * (b[2] - a[2]));
    return p;
  }

  /** Valid positions without consecutive duplicates. */
  function cleanPath(coords) {
    const out = [];
    if (!Array.isArray(coords)) return out;
    for (let i = 0; i < coords.length; i++) {
      const p = coords[i];
      if (!isPos(p)) continue;
      if (out.length && samePos(out[out.length - 1], p)) continue;
      out.push(p);
    }
    return out;
  }
  function cleanLine(coords) {
    const c = cleanPath(coords);
    return c.length >= 2 ? c : null;
  }
  /** Closed ring with >= 4 positions whose vertices are not all collinear, or null. */
  function cleanRing(coords) {
    const c = cleanPath(coords);
    if (c.length && !samePos(c[0], c[c.length - 1])) c.push(c[0].slice());
    if (c.length < 4) return null;
    if (ringCollinear(c)) return null;
    return c;
  }
  /** True when a ring has no area because all its vertices lie on one line (a figure-8 is not collinear). */
  function ringCollinear(c) {
    if (Math.abs(ringArea(c)) > 1e-20) return false;
    const a = c[0];
    let far = null, fd = 0;
    for (let i = 1; i < c.length; i++) {
      const dx = c[i][0] - a[0], dy = c[i][1] - a[1];
      const d = dx * dx + dy * dy;
      if (d > fd) { fd = d; far = c[i]; }
    }
    if (!far) return true;
    const L = Math.sqrt(fd);
    for (let i = 1; i < c.length; i++) {
      const cr = Math.abs((far[0] - a[0]) * (c[i][1] - a[1]) - (far[1] - a[1]) * (c[i][0] - a[0])) / L;
      if (cr > EPS) return false;
    }
    return true;
  }
  function cleanPolygon(rings) {
    if (!Array.isArray(rings) || !rings.length) return null;
    const outer = cleanRing(rings[0]);
    if (!outer) return null;
    const out = [outer];
    for (let i = 1; i < rings.length; i++) {
      const h = cleanRing(rings[i]);
      if (h) out.push(h);
    }
    return out;
  }
  function cleanPolys(polys) {
    const out = [];
    for (let i = 0; i < polys.length; i++) {
      const p = cleanPolygon(polys[i]);
      if (p) out.push(p);
    }
    return out;
  }
  /** a→b→c turns back on itself along one line (a zero-width spike at b). */
  function isSpike(a, b, c) {
    const abx = b[0] - a[0], aby = b[1] - a[1], bcx = c[0] - b[0], bcy = c[1] - b[1];
    const lab = Math.sqrt(abx * abx + aby * aby), lbc = Math.sqrt(bcx * bcx + bcy * bcy);
    if (lab === 0 || lbc === 0) return true;
    return abx * bcx + aby * bcy < 0 && Math.abs(abx * bcy - aby * bcx) <= EPS * Math.max(lab, lbc);
  }
  /** Remove zero-width spikes from a closed ring (area unchanged); null if nothing is left. */
  function despikeRing(ring) {
    let pts = ring.slice(0, ring.length - 1);
    for (let pass = 0; pass < 50 && pts.length >= 3; pass++) {
      const out = [];
      let removed = false;
      for (let i = 0; i < pts.length; i++) {
        const a = out.length ? out[out.length - 1] : pts[pts.length - 1];
        const b = pts[i], c = pts[(i + 1) % pts.length];
        if (isSpike(a, b, c)) { removed = true; continue; }
        out.push(b);
      }
      pts = out;
      if (!removed) break;
    }
    if (pts.length < 3) return null;
    pts.push(pts[0].slice());
    return cleanRing(pts);
  }
  /** Clean + despike polygons (used on polyclip output and by makeValid). */
  function tidyPolys(polys) {
    const out = [];
    for (let i = 0; i < polys.length; i++) {
      const rings = polys[i];
      const outer = rings && rings.length ? cleanRing(rings[0]) : null;
      const o = outer && despikeRing(outer);
      if (!o) continue;
      const p = [o];
      for (let r = 1; r < rings.length; r++) {
        const h = cleanRing(rings[r]);
        const hh = h && despikeRing(h);
        if (hh) p.push(hh);
      }
      out.push(p);
    }
    return out;
  }

  /** Split a geometry into cleaned points / lines / polygons (GeometryCollections flattened). */
  function components(geom, acc) {
    acc = acc || { points: [], lines: [], polys: [] };
    if (!geom || typeof geom !== 'object') return acc;
    const c = geom.coordinates;
    switch (geom.type) {
      case 'Point': if (isPos(c)) acc.points.push(c); break;
      case 'MultiPoint': if (Array.isArray(c)) for (let i = 0; i < c.length; i++) if (isPos(c[i])) acc.points.push(c[i]); break;
      case 'LineString': { const l = cleanLine(c); if (l) acc.lines.push(l); break; }
      case 'MultiLineString':
        if (Array.isArray(c)) for (let i = 0; i < c.length; i++) { const l = cleanLine(c[i]); if (l) acc.lines.push(l); }
        break;
      case 'Polygon': { const p = cleanPolygon(c); if (p) acc.polys.push(p); break; }
      case 'MultiPolygon':
        if (Array.isArray(c)) for (let i = 0; i < c.length; i++) { const p = cleanPolygon(c[i]); if (p) acc.polys.push(p); }
        break;
      case 'GeometryCollection':
        if (Array.isArray(geom.geometries)) for (let i = 0; i < geom.geometries.length; i++) components(geom.geometries[i], acc);
        break;
      default: break;
    }
    return acc;
  }

  function pointsGeom(pts) {
    if (!pts.length) return null;
    return pts.length === 1 ? { type: 'Point', coordinates: pts[0] } : { type: 'MultiPoint', coordinates: pts };
  }
  function linesGeom(lines) {
    if (!lines.length) return null;
    return lines.length === 1 ? { type: 'LineString', coordinates: lines[0] } : { type: 'MultiLineString', coordinates: lines };
  }
  function polysGeom(polys) {
    if (!polys.length) return null;
    return polys.length === 1 ? { type: 'Polygon', coordinates: polys[0] } : { type: 'MultiPolygon', coordinates: polys };
  }
  /** Simplest geometry for the given parts (GeometryCollection if mixed), or null. */
  function geomFrom(points, lines, polys) {
    const parts = [polysGeom(polys || []), linesGeom(lines || []), pointsGeom(points || [])].filter(Boolean);
    if (!parts.length) return null;
    return parts.length === 1 ? parts[0] : { type: 'GeometryCollection', geometries: parts };
  }
  function polysOf(g) {
    if (!g) return [];
    if (g.type === 'Polygon') return [g.coordinates];
    if (g.type === 'MultiPolygon') return g.coordinates;
    return [];
  }

  /**
   * Rebuild a geometry of the same type with each line part / ring mapped.
   * onLine(coords) and onRing(ring, isOuter) return new coordinates or null
   * (dropped). Returns null when nothing is left.
   */
  function mapParts(g, onLine, onRing) {
    if (!g) return null;
    const c = g.coordinates;
    switch (g.type) {
      case 'Point': return isPos(c) ? g : null;
      case 'MultiPoint': {
        const pts = Array.isArray(c) ? c.filter(isPos) : [];
        return pts.length ? { type: 'MultiPoint', coordinates: pts } : null;
      }
      case 'LineString': {
        const l = cleanLine(c);
        const m = l && onLine(l);
        return m ? { type: 'LineString', coordinates: m } : null;
      }
      case 'MultiLineString': {
        const parts = [];
        if (Array.isArray(c)) for (let i = 0; i < c.length; i++) { const l = cleanLine(c[i]); const m = l && onLine(l); if (m) parts.push(m); }
        return parts.length ? { type: 'MultiLineString', coordinates: parts } : null;
      }
      case 'Polygon': {
        const p = mapPolygon(c, onRing);
        return p ? { type: 'Polygon', coordinates: p } : null;
      }
      case 'MultiPolygon': {
        const parts = [];
        if (Array.isArray(c)) for (let i = 0; i < c.length; i++) { const p = mapPolygon(c[i], onRing); if (p) parts.push(p); }
        return parts.length ? { type: 'MultiPolygon', coordinates: parts } : null;
      }
      case 'GeometryCollection': {
        const gs = (Array.isArray(g.geometries) ? g.geometries : []).map(function (x) { return mapParts(x, onLine, onRing); }).filter(Boolean);
        return gs.length ? { type: 'GeometryCollection', geometries: gs } : null;
      }
      default: return null;
    }
  }
  function mapPolygon(rings, onRing) {
    if (!Array.isArray(rings) || !rings.length) return null;
    const outer = cleanRing(rings[0]);
    const o = outer && onRing(outer, true);
    if (!o) return null;
    const out = [o];
    for (let i = 1; i < rings.length; i++) {
      const h = cleanRing(rings[i]);
      const m = h && onRing(h, false);
      if (m) out.push(m);
    }
    return out;
  }

  /* ====================================================== planar primitives */

  /** Signed planar area of a closed ring (positive = counter-clockwise). */
  function ringArea(r) {
    const x0 = r[0][0], y0 = r[0][1];
    let s = 0;
    for (let i = 1, n = r.length - 1; i < n; i++) {
      s += (r[i][0] - x0) * (r[i + 1][1] - y0) - (r[i + 1][0] - x0) * (r[i][1] - y0);
    }
    return s / 2;
  }
  function polysArea(polys) {
    let a = 0;
    for (let i = 0; i < polys.length; i++) {
      const rings = polys[i];
      a += Math.abs(ringArea(rings[0]));
      for (let j = 1; j < rings.length; j++) a -= Math.abs(ringArea(rings[j]));
    }
    return a;
  }
  function tiny(a, ref) { return a <= ref * 1e-9 + 1e-20; }

  function distSeg(x, y, ax, ay, bx, by) {
    const dx = bx - ax, dy = by - ay;
    const dd = dx * dx + dy * dy;
    const t = dd > 0 ? clamp01(((x - ax) * dx + (y - ay) * dy) / dd) : 0;
    const ex = ax + t * dx - x, ey = ay + t * dy - y;
    return Math.sqrt(ex * ex + ey * ey);
  }

  /**
   * Intersection of segments ab and cd (planar, tolerance EPS). Returns
   * 0 (none), 1 (one point: out.t0 along ab, out.u0 along cd) or 2 (collinear
   * overlap from out.t0 to out.t1 along ab; out.u0 / out.u1 along cd).
   */
  function segSeg(ax, ay, bx, by, cx, cy, dx, dy, out) {
    const rx = bx - ax, ry = by - ay, sx = dx - cx, sy = dy - cy;
    const lr = Math.sqrt(rx * rx + ry * ry), ls = Math.sqrt(sx * sx + sy * sy);
    if (lr === 0 || ls === 0) return 0;
    const dc = (rx * (cy - ay) - ry * (cx - ax)) / lr;
    const dd = (rx * (dy - ay) - ry * (dx - ax)) / lr;
    const da = (sx * (ay - cy) - sy * (ax - cx)) / ls;
    const db = (sx * (by - cy) - sy * (bx - cx)) / ls;
    const zc = Math.abs(dc) <= EPS, zd = Math.abs(dd) <= EPS;
    const za = Math.abs(da) <= EPS, zb = Math.abs(db) <= EPS;
    if ((zc && zd) || (za && zb)) {
      const rr = lr * lr, ss = ls * ls;
      const tc = ((cx - ax) * rx + (cy - ay) * ry) / rr;
      const td = ((dx - ax) * rx + (dy - ay) * ry) / rr;
      const tol = EPS / lr;
      const lo = Math.max(0, Math.min(tc, td)), hi = Math.min(1, Math.max(tc, td));
      if (lo > hi + tol) return 0;
      const uOf = function (t) { return clamp01(((ax + t * rx - cx) * sx + (ay + t * ry - cy) * sy) / ss); };
      if (hi - lo <= tol) { out.t0 = clamp01(lo); out.u0 = uOf(out.t0); return 1; }
      out.t0 = lo; out.t1 = hi; out.u0 = uOf(lo); out.u1 = uOf(hi);
      return 2;
    }
    if ((dc > EPS && dd > EPS) || (dc < -EPS && dd < -EPS)) return 0;
    if ((da > EPS && db > EPS) || (da < -EPS && db < -EPS)) return 0;
    let t, u;
    if (za) t = 0; else if (zb) t = 1; else t = da / (da - db);
    if (zc) u = 0; else if (zd) u = 1; else u = dc / (dc - dd);
    out.t0 = clamp01(t); out.u0 = clamp01(u);
    return 1;
  }

  /** Point in closed ring: 1 inside, 0 on the boundary, -1 outside. */
  function pipRing(x, y, ring) {
    let inside = false;
    for (let i = 0, n = ring.length - 1; i < n; i++) {
      const a = ring[i], b = ring[i + 1];
      const ax = a[0], ay = a[1], bx = b[0], by = b[1];
      if (x >= (ax < bx ? ax : bx) - EPS && x <= (ax > bx ? ax : bx) + EPS &&
          y >= (ay < by ? ay : by) - EPS && y <= (ay > by ? ay : by) + EPS &&
          distSeg(x, y, ax, ay, bx, by) <= EPS) return 0;
      if ((ay > y) !== (by > y) && x < ax + ((y - ay) * (bx - ax)) / (by - ay)) inside = !inside;
    }
    return inside ? 1 : -1;
  }
  /** Point in polygon (rings, holes after the outer ring): 1 / 0 / -1. */
  function pipPolygon(x, y, rings) {
    const o = pipRing(x, y, rings[0]);
    if (o !== 1) return o;
    for (let i = 1; i < rings.length; i++) {
      const h = pipRing(x, y, rings[i]);
      if (h === 1) return -1;
      if (h === 0) return 0;
    }
    return 1;
  }
  function pipPolys(x, y, polys) {
    let r = -1;
    for (let i = 0; i < polys.length; i++) {
      const v = pipPolygon(x, y, polys[i]);
      if (v === 1) return 1;
      if (v === 0) r = 0;
    }
    return r;
  }

  /* ==================================================== prepared geometries */

  /**
   * A cleaned geometry with cached bbox, lazily built segment index and fast
   * point-in-polygon. Used by all predicates and overlays.
   */
  function Prep(geom) {
    const c = components(geom);
    this.points = c.points;
    this.lines = c.lines;
    this.polys = c.polys;
    this.dim = c.polys.length ? 2 : c.lines.length ? 1 : c.points.length ? 0 : -1;
    let b = null;
    if (c.points.length) b = ringBBox(c.points);
    for (let i = 0; i < c.lines.length; i++) b = util.bboxUnion(b, ringBBox(c.lines[i]));
    this.polyBoxes = c.polys.map(function (p) { return ringBBox(p[0]); });
    for (let i = 0; i < this.polyBoxes.length; i++) b = util.bboxUnion(b, this.polyBoxes[i]);
    this.bbox = b;
    let nv = 0, nr = 0;
    this.ringBase = [];
    for (let i = 0; i < c.polys.length; i++) {
      this.ringBase.push(nr);
      nr += c.polys[i].length;
      for (let j = 0; j < c.polys[i].length; j++) nv += c.polys[i][j].length - 1;
    }
    this.nRingVerts = nv;
    this.nRings = nr;
    this._segs = null;
    this._tree = null;
    this._area = null;
    this._lb = null;
  }
  Prep.prototype.isEmpty = function () { return this.dim < 0; };
  Prep.prototype.isSinglePoint = function () { return this.dim === 0 && this.points.length === 1; };
  Prep.prototype.segItems = function () {
    if (this._segs) return this._segs;
    const items = [];
    const add = function (c, k, p, r) {
      for (let i = 0; i < c.length - 1; i++) {
        const a = c[i], b = c[i + 1];
        items.push({
          minX: a[0] < b[0] ? a[0] : b[0], minY: a[1] < b[1] ? a[1] : b[1],
          maxX: a[0] > b[0] ? a[0] : b[0], maxY: a[1] > b[1] ? a[1] : b[1],
          c: c, i: i, k: k, p: p, r: r,
        });
      }
    };
    for (let li = 0; li < this.lines.length; li++) add(this.lines[li], 0, li, 0);
    for (let pi = 0; pi < this.polys.length; pi++) {
      for (let ri = 0; ri < this.polys[pi].length; ri++) add(this.polys[pi][ri], 1, pi, ri);
    }
    this._segs = items;
    return items;
  };
  Prep.prototype.segCount = function () { return this.segItems().length; };
  /** RBush over the segments (null for small geometries, which are scanned linearly). */
  Prep.prototype.segTree = function () {
    const items = this.segItems();
    if (items.length <= SEG_INDEX_MIN) return null;
    if (!this._tree) { this._tree = newTree(); this._tree.load(items); }
    return this._tree;
  };
  /** Call fn(item) for segments whose bbox meets `box` (kind 0 = lines, 1 = rings). fn may return false to stop. */
  Prep.prototype.forSegs = function (box, fn, kind) {
    const items = this.segItems();
    const tree = this.segTree();
    if (tree) {
      const found = tree.search(rbox(box));
      for (let i = 0; i < found.length; i++) {
        const it = found[i];
        if (kind !== undefined && it.k !== kind) continue;
        if (fn(it) === false) return false;
      }
      return true;
    }
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (kind !== undefined && it.k !== kind) continue;
      if (it.maxX < box[0] || it.minX > box[2] || it.maxY < box[1] || it.minY > box[3]) continue;
      if (fn(it) === false) return false;
    }
    return true;
  };
  /** Point in the polygonal part: 1 inside, 0 boundary, -1 outside. */
  Prep.prototype.pip = function (x, y) {
    if (!this.polys.length) return -1;
    const b = this.bbox;
    if (x < b[0] - EPS || x > b[2] + EPS || y < b[1] - EPS || y > b[3] + EPS) return -1;
    if (this.nRingVerts > PIP_INDEX_MIN) return this._pipIndexed(x, y);
    let r = -1;
    for (let p = 0; p < this.polys.length; p++) {
      const pb = this.polyBoxes[p];
      if (x < pb[0] - EPS || x > pb[2] + EPS || y < pb[1] - EPS || y > pb[3] + EPS) continue;
      const v = pipPolygon(x, y, this.polys[p]);
      if (v === 1) return 1;
      if (v === 0) r = 0;
    }
    return r;
  };
  Prep.prototype._pipIndexed = function (x, y) {
    const parity = new Uint8Array(this.nRings);
    const base = this.ringBase;
    let onB = false;
    this.forSegs([x - EPS, y - EPS, this.bbox[2] + 1, y + EPS], function (it) {
      const a = it.c[it.i], b = it.c[it.i + 1];
      if (distSeg(x, y, a[0], a[1], b[0], b[1]) <= EPS) { onB = true; return false; }
      if ((a[1] > y) !== (b[1] > y) && x < a[0] + ((y - a[1]) * (b[0] - a[0])) / (b[1] - a[1])) parity[base[it.p] + it.r] ^= 1;
      return true;
    }, 1);
    if (onB) return 0;
    for (let p = 0; p < this.polys.length; p++) {
      if (!parity[base[p]]) continue;
      let inHole = false;
      for (let r = 1; r < this.polys[p].length; r++) if (parity[base[p] + r]) { inHole = true; break; }
      if (!inHole) return 1;
    }
    return -1;
  };
  Prep.prototype.onLines = function (x, y) {
    if (!this.lines.length) return false;
    let on = false;
    this.forSegs([x - EPS, y - EPS, x + EPS, y + EPS], function (it) {
      const a = it.c[it.i], b = it.c[it.i + 1];
      if (distSeg(x, y, a[0], a[1], b[0], b[1]) <= EPS) { on = true; return false; }
      return true;
    }, 0);
    return on;
  };
  /** Line boundary = endpoints of open parts (mod-2 rule). */
  Prep.prototype.isLineBoundary = function (x, y) {
    if (!this._lb) {
      const counts = new Map();
      for (let i = 0; i < this.lines.length; i++) {
        const l = this.lines[i], a = l[0], b = l[l.length - 1];
        if (samePos(a, b)) continue;
        [a, b].forEach(function (p) {
          const k = p[0] + ',' + p[1];
          const e = counts.get(k);
          if (e) e.n++; else counts.set(k, { p: p, n: 1 });
        });
      }
      this._lb = Array.from(counts.values()).filter(function (e) { return e.n % 2 === 1; }).map(function (e) { return e.p; });
    }
    for (let i = 0; i < this._lb.length; i++) {
      const p = this._lb[i];
      if (Math.abs(p[0] - x) <= EPS && Math.abs(p[1] - y) <= EPS) return true;
    }
    return false;
  };
  Prep.prototype.hasPoint = function (x, y) {
    for (let i = 0; i < this.points.length; i++) {
      const p = this.points[i];
      if (Math.abs(p[0] - x) <= EPS && Math.abs(p[1] - y) <= EPS) return true;
    }
    return false;
  };
  /** Location of a point relative to the highest-dimension part: 'i' interior, 'b' boundary, 'e' exterior. */
  Prep.prototype.locate = function (x, y) {
    if (this.dim === 2) { const r = this.pip(x, y); return r === 1 ? 'i' : r === 0 ? 'b' : 'e'; }
    if (this.dim === 1) { if (!this.onLines(x, y)) return 'e'; return this.isLineBoundary(x, y) ? 'b' : 'i'; }
    if (this.dim === 0) return this.hasPoint(x, y) ? 'i' : 'e';
    return 'e';
  };
  /** Point touches any part (points, lines, polygon closure). */
  Prep.prototype.touchesPoint = function (x, y) {
    const b = this.bbox;
    if (!b || x < b[0] - EPS || x > b[2] + EPS || y < b[1] - EPS || y > b[3] + EPS) return false;
    if (this.polys.length && this.pip(x, y) >= 0) return true;
    if (this.lines.length && this.onLines(x, y)) return true;
    return this.points.length ? this.hasPoint(x, y) : false;
  };
  Prep.prototype.area = function () {
    if (this._area === null) this._area = polysArea(this.polys);
    return this._area;
  };
  /** 'inside' | 'outside' | 'boundary' — how `box` relates to the polygonal part. */
  Prep.prototype.boxRelation = function (box) {
    if (!this.polys.length || !boxesIntersect(this.bbox, box)) return 'outside';
    let hit = false;
    this.forSegs(box, function () { hit = true; return false; }, 1);
    if (hit) return 'boundary';
    const r = this.pip((box[0] + box[2]) / 2, (box[1] + box[3]) / 2);
    return r === 1 ? 'inside' : r === -1 ? 'outside' : 'boundary';
  };
  /** Visit every vertex (ring closing positions skipped); fn may return false to stop. */
  Prep.prototype.eachVertex = function (fn) {
    for (let i = 0; i < this.points.length; i++) if (fn(this.points[i][0], this.points[i][1]) === false) return false;
    for (let i = 0; i < this.lines.length; i++) {
      const l = this.lines[i];
      for (let j = 0; j < l.length; j++) if (fn(l[j][0], l[j][1]) === false) return false;
    }
    for (let i = 0; i < this.polys.length; i++) {
      for (let r = 0; r < this.polys[i].length; r++) {
        const ring = this.polys[i][r];
        for (let j = 0; j < ring.length - 1; j++) if (fn(ring[j][0], ring[j][1]) === false) return false;
      }
    }
    return true;
  };

  /** Union of several prepared polygon geometries, for point-in-polygon and line overlay. */
  function AreaSet(preps) { this.preps = preps; }
  AreaSet.prototype.pip = function (x, y) {
    let r = -1;
    for (let i = 0; i < this.preps.length; i++) {
      const v = this.preps[i].pip(x, y);
      if (v === 1) return 1;
      if (v > r) r = v;
    }
    return r;
  };
  AreaSet.prototype.forSegs = function (box, fn, kind) {
    for (let i = 0; i < this.preps.length; i++) {
      const P = this.preps[i];
      if (boxesIntersect(P.bbox, box) && P.forSegs(box, fn, kind) === false) return false;
    }
    return true;
  };

  /** Lazily prepared geometries of a feature collection, with an RBush over their bboxes. */
  function Layer(fc, filter) {
    this.fc = fc;
    this.preps = new Array(fc.features.length);
    this.items = [];
    for (let i = 0; i < fc.features.length; i++) {
      const f = fc.features[i];
      const g = f && f.geometry;
      if (!g) continue;
      if (filter && !filter(g)) continue;
      const b = geomBBox(g);
      if (!b || !isNum(b[0]) || !isNum(b[1]) || !isNum(b[2]) || !isNum(b[3])) continue;
      this.items.push({ minX: b[0], minY: b[1], maxX: b[2], maxY: b[3], i: i });
    }
    this.tree = newTree();
    this.tree.load(this.items);
  }
  Layer.prototype.prep = function (i) {
    let p = this.preps[i];
    if (p === undefined) {
      p = new Prep(this.fc.features[i].geometry);
      if (p.isEmpty()) p = null;
      this.preps[i] = p;
    }
    return p;
  };
  /** Sorted feature indices whose bbox meets `box`. */
  Layer.prototype.search = function (box) {
    const found = this.tree.search(rbox(box));
    const out = new Array(found.length);
    for (let i = 0; i < found.length; i++) out[i] = found[i].i;
    return out.sort(numAsc);
  };
  Layer.prototype.size = function () { return this.items.length; };

  function isPolygonal(g) {
    if (!g) return false;
    if (g.type === 'Polygon' || g.type === 'MultiPolygon') return true;
    return g.type === 'GeometryCollection' && Array.isArray(g.geometries) && g.geometries.some(isPolygonal);
  }
  function polygonLayer(fc, message) {
    const L = new Layer(fc, isPolygonal);
    const keep = [];
    for (let k = 0; k < L.items.length; k++) {
      const P = L.prep(L.items[k].i);
      if (P && P.polys.length) keep.push(L.items[k]);
    }
    if (!keep.length) throw new Error(message);
    if (keep.length !== L.items.length) { L.items = keep; L.tree = newTree(); L.tree.load(keep); }
    return L;
  }

  /* ============================================== polygon boolean operations */

  function mpFeature(polys) { return { type: 'Feature', properties: {}, geometry: { type: 'MultiPolygon', coordinates: polys } }; }
  function runClip(op, list) {
    const t = T();
    const fc = { type: 'FeatureCollection', features: list.map(mpFeature) };
    const res = op === 'union' ? t.union(fc) : op === 'intersect' ? t.intersect(fc) : t.difference(fc);
    return res && res.geometry ? tidyPolys(polysOf(res.geometry)) : [];
  }
  function snapPolys(polys, grid) {
    const snap = function (p) { return [Math.round(p[0] * grid) / grid, Math.round(p[1] * grid) / grid]; };
    return cleanPolys(polys.map(function (rings) { return rings.map(function (r) { return r.map(snap); }); }));
  }
  /**
   * Polygon boolean op on arrays of polygons (MultiPolygon coordinates):
   * 'union' (all), 'intersect' (all), 'difference' (first minus the rest).
   * Retries on snapped coordinates when polyclip fails; throws if all fail.
   */
  function clipOp(op, list) {
    if (op === 'union') {
      list = list.filter(function (p) { return p && p.length; });
      if (!list.length) return [];
      if (list.length === 1) list = [list[0], list[0]];
    } else if (op === 'intersect') {
      if (list.some(function (p) { return !p || !p.length; })) return [];
    } else {
      if (!list[0] || !list[0].length) return [];
      list = [list[0]].concat(list.slice(1).filter(function (p) { return p && p.length; }));
      if (list.length === 1) return list[0];
    }
    try {
      return runClip(op, list);
    } catch (err) {
      const grids = [1e9, 1e7];
      for (let i = 0; i < grids.length; i++) {
        try { return runClip(op, list.map(function (p) { return snapPolys(p, grids[i]); })); } catch (e) { /* try coarser */ }
      }
      throw err;
    }
  }

  function part1By1(n) {
    n &= 0xffff;
    n = (n | (n << 8)) & 0x00ff00ff;
    n = (n | (n << 4)) & 0x0f0f0f0f;
    n = (n | (n << 2)) & 0x33333333;
    n = (n | (n << 1)) & 0x55555555;
    return n >>> 0;
  }
  /** Order items (with bbox `b`) along a Morton curve so batches are spatially compact. */
  function mortonOrder(boxes) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    const cs = boxes.map(function (b) {
      const x = (b[0] + b[2]) / 2, y = (b[1] + b[3]) / 2;
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
      return [x, y];
    });
    const sx = maxX > minX ? 65535 / (maxX - minX) : 0, sy = maxY > minY ? 65535 / (maxY - minY) : 0;
    const keys = cs.map(function (c, i) {
      return { i: i, k: (part1By1(Math.round((c[0] - minX) * sx)) | (part1By1(Math.round((c[1] - minY) * sy)) << 1)) >>> 0 };
    });
    keys.sort(function (a, b) { return a.k - b.k || a.i - b.i; });
    return keys.map(function (e) { return e.i; });
  }
  /**
   * Union many polygon sets quickly and robustly. Inputs are split into
   * connected groups of overlapping bboxes (isolated pieces skip polyclip,
   * separate groups are simply concatenated); each group is unioned in
   * spatially sorted batches with a tree reduction.
   */
  function unionMany(list, W) {
    const items = list.filter(function (p) { return p && p.length; });
    if (items.length <= 1) return items[0] || [];
    const boxes = items.map(polysBBox);
    const parent = new Int32Array(items.length);
    for (let i = 0; i < parent.length; i++) parent[i] = i;
    const find = function (i) { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
    const tree = newTree();
    tree.load(boxes.map(function (b, i) { return { minX: b[0], minY: b[1], maxX: b[2], maxY: b[3], i: i }; }));
    for (let i = 0; i < boxes.length; i++) {
      const found = tree.search(rbox(boxes[i]));
      for (let k = 0; k < found.length; k++) {
        const a = find(i), c = find(found[k].i);
        if (a !== c) parent[a] = c;
      }
    }
    const groups = new Map();
    for (let i = 0; i < items.length; i++) {
      const r = find(i);
      let g = groups.get(r);
      if (!g) { g = []; groups.set(r, g); }
      g.push(i);
    }
    const out = [];
    groups.forEach(function (idxs) {
      const res = idxs.length === 1 ? items[idxs[0]] : unionTree(idxs.map(function (i) { return items[i]; }), idxs.map(function (i) { return boxes[i]; }), W);
      for (let k = 0; k < res.length; k++) out.push(res[k]);
    });
    return out;
  }
  function unionTree(items, boxes, W) {
    const order = mortonOrder(boxes);
    items = order.map(function (i) { return items[i]; });
    while (items.length > 1) {
      const next = [];
      for (let i = 0; i < items.length; i += UNION_BATCH) next.push(unionBatch(items.slice(i, i + UNION_BATCH), W));
      items = next;
    }
    return items[0];
  }
  function unionBatch(batch, W) {
    if (batch.length === 1) return batch[0];
    try {
      return clipOp('union', batch);
    } catch (err) {
      if (batch.length === 2) {
        if (W) W.add('union', function (n) { return n + plural(n, ' pair', ' pairs') + ' of polygons could not be merged exactly; overlapping parts were kept'; }, err.message);
        return batch[0].concat(batch[1]);
      }
      const mid = batch.length >> 1;
      return unionBatch([unionBatch(batch.slice(0, mid), W), unionBatch(batch.slice(mid), W)], W);
    }
  }

  /** Sutherland–Hodgman clip of a closed ring to a box; area-exact, may leave zero-width edges on the box border. */
  function clipRingToBox(ring, b) {
    let pts = ring.slice(0, ring.length - 1);
    for (let edge = 0; edge < 4 && pts.length; edge++) {
      const out = [];
      const inside = function (p) {
        return edge === 0 ? p[0] >= b[0] : edge === 1 ? p[0] <= b[2] : edge === 2 ? p[1] >= b[1] : p[1] <= b[3];
      };
      const cut = function (p, q) {
        if (edge < 2) {
          const x = edge === 0 ? b[0] : b[2];
          const t = (x - p[0]) / (q[0] - p[0]);
          return [x, p[1] + t * (q[1] - p[1])];
        }
        const y = edge === 2 ? b[1] : b[3];
        const t = (y - p[1]) / (q[1] - p[1]);
        return [p[0] + t * (q[0] - p[0]), y];
      };
      for (let i = 0; i < pts.length; i++) {
        const cur = pts[i], prev = pts[(i + pts.length - 1) % pts.length];
        const ci = inside(cur), pi = inside(prev);
        if (ci) {
          if (!pi) out.push(cut(prev, cur));
          out.push(cur);
        } else if (pi) {
          out.push(cut(prev, cur));
        }
      }
      pts = out;
    }
    if (pts.length < 3) return null;
    pts.push(pts[0]);
    return cleanRing(pts);
  }
  /** Restrict polygons to `box` (area-equivalent inside the box). */
  function clipPolysToBox(polys, box) {
    const out = [];
    for (let i = 0; i < polys.length; i++) {
      const rings = polys[i];
      const ob = ringBBox(rings[0]);
      if (!boxesIntersect(ob, box)) continue;
      if (boxContains(box, ob)) { out.push(rings); continue; }
      const outer = clipRingToBox(rings[0], box);
      if (!outer) continue;
      const nr = [outer];
      for (let r = 1; r < rings.length; r++) {
        const hb = ringBBox(rings[r]);
        if (!boxesIntersect(hb, box)) continue;
        if (boxContains(box, hb)) { nr.push(rings[r]); continue; }
        const h = clipRingToBox(rings[r], box);
        if (h) nr.push(h);
      }
      out.push(nr);
    }
    return out;
  }
  function polysVertexCount(polys) {
    let n = 0;
    for (let i = 0; i < polys.length; i++) for (let j = 0; j < polys[i].length; j++) n += polys[i][j].length;
    return n;
  }
  /**
   * P's polygons restricted to `box` (area-equivalent inside it) when P is
   * large: pieces come from a lazily subdivided quadtree of pre-clipped tiles
   * (like PostGIS ST_Subdivide), so each call only touches nearby vertices.
   * The result may consist of several edge-adjacent parts; polyclip treats a
   * MultiPolygon operand as the union of its parts.
   */
  function localPolys(P, box) {
    if (!P.polys.length || !boxesIntersect(box, P.bbox)) return [];
    if (P.nRingVerts < LOCALIZE_MIN || boxContains(box, P.bbox)) return P.polys;
    if (!P._qt) P._qt = { box: padBox(P.bbox, 1e-9), polys: P.polys, n: P.nRingVerts, kids: null, depth: 0 };
    const out = [];
    qtCollect(P._qt, box, out);
    return out;
  }
  function qtCollect(node, box, out) {
    if (!boxesIntersect(node.box, box)) return;
    if (node.kids) { for (let k = 0; k < 4; k++) qtCollect(node.kids[k], box, out); return; }
    if (!node.polys.length) return;
    if (boxContains(box, node.box)) { for (let i = 0; i < node.polys.length; i++) out.push(node.polys[i]); return; }
    if (node.n > QT_LEAF && node.depth < 16) {
      const b = node.box, mx = (b[0] + b[2]) / 2, my = (b[1] + b[3]) / 2;
      node.kids = [[b[0], b[1], mx, my], [mx, b[1], b[2], my], [b[0], my, mx, b[3]], [mx, my, b[2], b[3]]].map(function (kb) {
        const polys = clipPolysToBox(node.polys, kb);
        return { box: kb, polys: polys, n: polysVertexCount(polys), kids: null, depth: node.depth + 1 };
      });
      node.polys = null;
      for (let k = 0; k < 4; k++) qtCollect(node.kids[k], box, out);
      return;
    }
    const c = clipPolysToBox(node.polys, box);
    for (let i = 0; i < c.length; i++) out.push(c[i]);
  }
  function interBox(a, b) { return [Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.min(a[2], b[2]), Math.min(a[3], b[3])]; }

  /* ============================================================ line overlay */

  /**
   * Walk a line against a polygonal area, calling onSub(p0, p1, cls) for each
   * sub-segment between boundary contacts; cls: 1 inside, 0 on boundary,
   * -1 outside. Returns true if the line touches the boundary anywhere.
   */
  function walkLineArea(line, area, onSub) {
    const ss = {};
    const ts = [];
    let prevCls = null, contact = false, hitPrevEnd = false;
    for (let i = 0; i < line.length - 1; i++) {
      const a = line[i], b = line[i + 1];
      const ax = a[0], ay = a[1], bx = b[0], by = b[1];
      ts.length = 0;
      area.forSegs([Math.min(ax, bx) - EPS, Math.min(ay, by) - EPS, Math.max(ax, bx) + EPS, Math.max(ay, by) + EPS], function (it) {
        const c = it.c[it.i], d = it.c[it.i + 1];
        const n = segSeg(ax, ay, bx, by, c[0], c[1], d[0], d[1], ss);
        if (n >= 1) ts.push(ss.t0);
        if (n === 2) ts.push(ss.t1);
        return true;
      }, 1);
      const len = Math.sqrt((bx - ax) * (bx - ax) + (by - ay) * (by - ay));
      const tol = len > 0 ? EPS / len : 1;
      let hitStart = false, hitEnd = false;
      const params = [0];
      if (ts.length) {
        contact = true;
        ts.sort(numAsc);
        for (let k = 0; k < ts.length; k++) {
          const t = ts[k];
          if (t <= tol) { hitStart = true; continue; }
          if (t >= 1 - tol) { hitEnd = true; continue; }
          if (t - params[params.length - 1] > tol) params.push(t);
        }
      }
      params.push(1);
      for (let k = 0; k < params.length - 1; k++) {
        const t0 = params[k], t1 = params[k + 1];
        let cls;
        if (k === 0 && !hitStart && !hitPrevEnd && prevCls !== null) {
          cls = prevCls;
        } else {
          const tm = (t0 + t1) / 2;
          cls = area.pip(ax + tm * (bx - ax), ay + tm * (by - ay));
        }
        onSub(k === 0 ? a : lerpPos(a, b, t0), k === params.length - 2 ? b : lerpPos(a, b, t1), cls);
        prevCls = cls;
      }
      hitPrevEnd = hitEnd;
    }
    return contact;
  }
  /** Pieces of `lines` whose class passes keep(cls), merged into maximal polylines. */
  function clipLinesToArea(lines, area, keep) {
    const pieces = [];
    for (let l = 0; l < lines.length; l++) {
      let cur = null;
      walkLineArea(lines[l], area, function (p0, p1, cls) {
        if (keep(cls)) {
          if (!cur) cur = [p0];
          else if (!samePos(cur[cur.length - 1], p0)) cur.push(p0);
          cur.push(p1);
        } else if (cur) {
          pieces.push(cur);
          cur = null;
        }
      });
      if (cur) pieces.push(cur);
    }
    const out = [];
    for (let i = 0; i < pieces.length; i++) { const c = cleanLine(pieces[i]); if (c) out.push(c); }
    return out;
  }
  /** Summary of where lines lie relative to an area: { in, on, out, contact }. */
  function classifyLines(lines, area) {
    const r = { in: false, on: false, out: false, contact: false };
    for (let l = 0; l < lines.length; l++) {
      const contact = walkLineArea(lines[l], area, function (p0, p1, cls) {
        if (cls === 1) r.in = true; else if (cls === 0) r.on = true; else r.out = true;
      });
      if (contact) r.contact = true;
    }
    return r;
  }
  /**
   * Split lines at intersections with P's line segments and report coverage:
   * { covered: every piece lies on P, some: at least one piece lies on P }.
   */
  function linesCoveredBy(lines, P) {
    const ss = {};
    let covered = true, some = false;
    for (let l = 0; l < lines.length; l++) {
      const line = lines[l];
      for (let i = 0; i < line.length - 1; i++) {
        const a = line[i], b = line[i + 1];
        const ts = [0, 1];
        P.forSegs([Math.min(a[0], b[0]) - EPS, Math.min(a[1], b[1]) - EPS, Math.max(a[0], b[0]) + EPS, Math.max(a[1], b[1]) + EPS], function (it) {
          const c = it.c[it.i], d = it.c[it.i + 1];
          const n = segSeg(a[0], a[1], b[0], b[1], c[0], c[1], d[0], d[1], ss);
          if (n >= 1) ts.push(ss.t0);
          if (n === 2) ts.push(ss.t1);
          return true;
        }, 0);
        ts.sort(numAsc);
        for (let k = 0; k < ts.length - 1; k++) {
          if (ts[k + 1] - ts[k] <= 1e-12) continue;
          const tm = (ts[k] + ts[k + 1]) / 2;
          if (P.onLines(a[0] + tm * (b[0] - a[0]), a[1] + tm * (b[1] - a[1]))) some = true;
          else covered = false;
        }
      }
    }
    return { covered: covered && some, some: some };
  }
  /** How lines of A meet lines of B: { any, overlap, interior (an intersection interior to both) }. */
  function lineLineInfo(A, B) {
    const info = { any: false, overlap: false, interior: false };
    const ss = {};
    const items = A.segItems();
    for (let s = 0; s < items.length; s++) {
      const it = items[s];
      if (it.k !== 0) continue;
      const a = it.c[it.i], b = it.c[it.i + 1];
      B.forSegs([Math.min(a[0], b[0]) - EPS, Math.min(a[1], b[1]) - EPS, Math.max(a[0], b[0]) + EPS, Math.max(a[1], b[1]) + EPS], function (jt) {
        const c = jt.c[jt.i], d = jt.c[jt.i + 1];
        const n = segSeg(a[0], a[1], b[0], b[1], c[0], c[1], d[0], d[1], ss);
        if (!n) return true;
        info.any = true;
        if (n === 2) { info.overlap = true; info.interior = true; return true; }
        const x = a[0] + ss.t0 * (b[0] - a[0]), y = a[1] + ss.t0 * (b[1] - a[1]);
        if (!A.isLineBoundary(x, y) && !B.isLineBoundary(x, y)) info.interior = true;
        return true;
      }, 0);
    }
    return info;
  }

  /* =========================================================== predicates */

  function segsIntersect(A, B) {
    const small = A.segCount() <= B.segCount() ? A : B;
    const big = small === A ? B : A;
    if (!big.segCount()) return false;
    const ss = {};
    const items = small.segItems();
    for (let s = 0; s < items.length; s++) {
      const it = items[s];
      const a = it.c[it.i], b = it.c[it.i + 1];
      let hit = false;
      big.forSegs([Math.min(a[0], b[0]) - EPS, Math.min(a[1], b[1]) - EPS, Math.max(a[0], b[0]) + EPS, Math.max(a[1], b[1]) + EPS], function (jt) {
        const c = jt.c[jt.i], d = jt.c[jt.i + 1];
        if (segSeg(a[0], a[1], b[0], b[1], c[0], c[1], d[0], d[1], ss)) { hit = true; return false; }
        return true;
      });
      if (hit) return true;
    }
    return false;
  }

  function intersects(A, B) {
    if (!boxesIntersect(padBox(A.bbox, EPS), B.bbox)) return false;
    for (let i = 0; i < A.points.length; i++) if (B.touchesPoint(A.points[i][0], A.points[i][1])) return true;
    for (let i = 0; i < B.points.length; i++) if (A.touchesPoint(B.points[i][0], B.points[i][1])) return true;
    if (A.segCount() && B.segCount() && segsIntersect(A, B)) return true;
    if (B.polys.length) {
      for (let i = 0; i < A.lines.length; i++) if (B.pip(A.lines[i][0][0], A.lines[i][0][1]) >= 0) return true;
      for (let i = 0; i < A.polys.length; i++) if (B.pip(A.polys[i][0][0][0], A.polys[i][0][0][1]) >= 0) return true;
    }
    if (A.polys.length) {
      for (let i = 0; i < B.lines.length; i++) if (A.pip(B.lines[i][0][0], B.lines[i][0][1]) >= 0) return true;
      for (let i = 0; i < B.polys.length; i++) if (A.pip(B.polys[i][0][0][0], B.polys[i][0][0][1]) >= 0) return true;
    }
    return false;
  }

  /** Planar area of A ∩ B (degrees², for comparisons only). */
  function interArea(A, B) {
    if (!boxesIntersect(A.bbox, B.bbox)) return 0;
    // 'outside': no boundary of one crosses the other's bbox and that bbox is not inside it.
    const ra = B.boxRelation(A.bbox);
    if (ra === 'inside') return A.area();
    if (ra === 'outside') return 0;
    const rb = A.boxRelation(B.bbox);
    if (rb === 'inside') return B.area();
    if (rb === 'outside') return 0;
    const box = marginBox(interBox(A.bbox, B.bbox));
    return polysArea(clipOp('intersect', [localPolys(A, box), localPolys(B, box)]));
  }
  /** Planar area of A − B. */
  function diffArea(A, B) {
    if (!boxesIntersect(A.bbox, B.bbox)) return A.area();
    const ra = B.boxRelation(A.bbox);
    if (ra === 'inside') return 0;
    if (ra === 'outside' || A.boxRelation(B.bbox) === 'outside') return A.area();
    return polysArea(clipOp('difference', [A.polys, localPolys(B, marginBox(A.bbox))]));
  }

  function interiorsIntersect(A, B) {
    if (A.dim > B.dim) return interiorsIntersect(B, A);
    if (A.dim === 0) {
      for (let i = 0; i < A.points.length; i++) if (B.locate(A.points[i][0], A.points[i][1]) === 'i') return true;
      return false;
    }
    if (A.dim === 1 && B.dim === 1) return lineLineInfo(A, B).interior;
    if (A.dim === 1) return classifyLines(A.lines, B).in;
    return !tiny(interArea(A, B), Math.min(A.area(), B.area()));
  }

  function within(A, B) {
    if (A.dim > B.dim) return false;
    if (!boxContains(padBox(B.bbox, EPS), A.bbox)) return false;
    if (A.dim === 0) {
      let interior = false;
      for (let i = 0; i < A.points.length; i++) {
        const loc = B.locate(A.points[i][0], A.points[i][1]);
        if (loc === 'e') return false;
        if (loc === 'i') interior = true;
      }
      return interior;
    }
    if (A.dim === 1) {
      if (B.dim === 1) return linesCoveredBy(A.lines, B).covered;
      const c = classifyLines(A.lines, B);
      return !c.out && c.in;
    }
    return tiny(diffArea(A, B), A.area());
  }

  function touches(A, B) {
    if (A.dim === 0 && B.dim === 0) return false;
    return intersects(A, B) && !interiorsIntersect(A, B);
  }

  function crosses(A, B) {
    let X = A, Y = B;
    if (X.dim > Y.dim) { X = B; Y = A; }
    if (X.dim === Y.dim && X.dim !== 1) return false;
    if (!boxesIntersect(padBox(A.bbox, EPS), B.bbox)) return false;
    if (X.dim === 0) {
      let inside = false, outside = false;
      for (let i = 0; i < X.points.length; i++) {
        const l = Y.locate(X.points[i][0], X.points[i][1]);
        if (l === 'i') inside = true; else if (l === 'e') outside = true;
        if (inside && outside) return true;
      }
      return false;
    }
    if (Y.dim === 1) {
      const info = lineLineInfo(X, Y);
      return info.interior && !info.overlap;
    }
    const c = classifyLines(X.lines, Y);
    return c.in && c.out;
  }

  function overlaps(A, B) {
    if (A.dim !== B.dim || !boxesIntersect(padBox(A.bbox, EPS), B.bbox)) return false;
    if (A.dim === 0) {
      let shared = false, aOnly = false, bOnly = false;
      for (let i = 0; i < A.points.length; i++) { if (B.hasPoint(A.points[i][0], A.points[i][1])) shared = true; else aOnly = true; }
      for (let i = 0; i < B.points.length; i++) if (!A.hasPoint(B.points[i][0], B.points[i][1])) { bOnly = true; break; }
      return shared && aOnly && bOnly;
    }
    if (A.dim === 1) {
      const ab = linesCoveredBy(A.lines, B);
      if (!ab.some || ab.covered) return false;
      return !linesCoveredBy(B.lines, A).covered;
    }
    const inter = interArea(A, B);
    if (tiny(inter, Math.min(A.area(), B.area()))) return false;
    return !tiny(diffArea(A, B), A.area()) && !tiny(diffArea(B, A), B.area());
  }

  /**
   * Lower bound (m) of the geodesic distance from (x, y) to a lon/lat box
   * {minX, minY, maxX, maxY}: the larger of the distances to its latitude band
   * and to its longitude band (cross-track distance to the nearest meridian).
   */
  function boxLowerBound(x, y, b) {
    const dPhi = y < b.minY ? b.minY - y : y > b.maxY ? y - b.maxY : 0;
    const dLam = x < b.minX ? b.minX - x : x > b.maxX ? x - b.maxX : 0;
    if (dPhi === 0 && dLam === 0) return 0;
    let lb = dPhi * RAD;
    if (dLam > 0 && dLam < 90) {
      const ct = Math.asin(Math.min(1, Math.sin(dLam * RAD) * Math.cos(y * RAD)));
      if (ct > lb) lb = ct;
    }
    return lb * R_EARTH * (1 - 1e-9);
  }
  /** Tiny binary min-heap keyed by number. */
  function MinHeap() { this.k = []; this.v = []; }
  MinHeap.prototype.push = function (key, val) {
    const k = this.k, v = this.v;
    let i = k.length;
    k.push(key); v.push(val);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (k[p] <= key) break;
      k[i] = k[p]; v[i] = v[p]; i = p;
    }
    k[i] = key; v[i] = val;
  };
  MinHeap.prototype.pop = function () {
    const k = this.k, v = this.v;
    const topK = k[0], topV = v[0];
    const lastK = k.pop(), lastV = v.pop();
    const n = k.length;
    if (n) {
      let i = 0;
      for (;;) {
        let c = 2 * i + 1;
        if (c >= n) break;
        if (c + 1 < n && k[c + 1] < k[c]) c++;
        if (k[c] >= lastK) break;
        k[i] = k[c]; v[i] = v[c]; i = c;
      }
      k[i] = lastK; v[i] = lastV;
    }
    return { k: topK, v: topV };
  };
  /**
   * Best-first nearest search over an RBush tree. itemDist(item, bound) returns
   * the exact distance to an item (it may return anything > bound when the item
   * is farther than bound). Items whose box is farther than the best distance so
   * far are skipped. Returns the smallest distance found (Infinity if none <= bound).
   */
  function treeNearest(tree, x, y, itemDist, bound) {
    let best = bound === undefined ? Infinity : bound, found = Infinity;
    const heap = new MinHeap();
    let node = tree.data;
    while (node) {
      const ch = node.children;
      for (let i = 0; i < ch.length; i++) {
        const c = ch[i];
        const lb = boxLowerBound(x, y, c);
        if (lb > best) continue;
        if (node.leaf) {
          const d = itemDist(c, best);
          if (d < found) found = d;
          if (d < best) best = d;
        } else {
          heap.push(lb, c);
        }
      }
      node = null;
      if (heap.k.length) {
        const top = heap.pop();
        if (top.k <= best) node = top.v;
      }
    }
    return found;
  }

  /**
   * Geodesic distance (m) from (x, y) to P (0 inside its polygons). With a
   * finite `cap`, parts farther than cap are skipped and a value > cap
   * (possibly Infinity) is returned when nothing is that close.
   */
  function distToPrep(x, y, P, cap) {
    if (P.polys.length && P.pip(x, y) >= 0) return 0;
    const limit = cap === undefined ? Infinity : cap;
    let best = Infinity;
    for (let i = 0; i < P.points.length; i++) {
      const d = hav(x, y, P.points[i][0], P.points[i][1]);
      if (d < best) best = d;
    }
    const tree = P.segTree();
    const segDist = function (it) {
      const a = it.c[it.i], b = it.c[it.i + 1];
      return pointSegMeters(x, y, a[0], a[1], b[0], b[1]);
    };
    if (tree) return Math.min(best, treeNearest(tree, x, y, segDist, Math.min(best, limit)));
    const items = P.segItems();
    for (let i = 0; i < items.length; i++) {
      const d = segDist(items[i]);
      if (d < best) best = d;
    }
    return best;
  }

  function withinDistance(A, B, d) {
    if (!boxesIntersect(expandBox(A.bbox, d), B.bbox)) return false;
    if (A.isSinglePoint() && B.isSinglePoint()) {
      return hav(A.points[0][0], A.points[0][1], B.points[0][0], B.points[0][1]) <= d;
    }
    if (intersects(A, B)) return true;
    // Disjoint geometries are closest at a vertex of one of them: A's vertices
    // against B, then (only if A has segments) B's vertices against A.
    return verticesWithin(A, B, d) || (A.segCount() > 0 && verticesWithin(B, A, d));
  }
  /** Is any vertex of X (only those near Y are examined) within d meters of Y? */
  function verticesWithin(X, Y, d) {
    const box = expandBox(Y.bbox, d);
    const test = function (x, y) { return x >= box[0] && x <= box[2] && y >= box[1] && y <= box[3] && distToPrep(x, y, Y, d) <= d; };
    for (let i = 0; i < X.points.length; i++) if (test(X.points[i][0], X.points[i][1])) return true;
    let hit = false;
    if (X.segCount()) {
      X.forSegs(box, function (it) {
        const a = it.c[it.i], b = it.c[it.i + 1];
        if (test(a[0], a[1]) || test(b[0], b[1])) { hit = true; return false; }
        return true;
      });
    }
    return hit;
  }

  /** Evaluate "A PREDICATE B" for prepared geometries. */
  function relate(A, B, pred, meters) {
    switch (pred) {
      case 'intersects': return intersects(A, B);
      case 'disjoint': return !intersects(A, B);
      case 'within': return within(A, B);
      case 'contains': return within(B, A);
      case 'touches': return touches(A, B);
      case 'crosses': return crosses(A, B);
      case 'overlaps': return overlaps(A, B);
      case 'within_distance': return withinDistance(A, B, meters);
      default: throw new Error('Unknown spatial predicate "' + pred + '"');
    }
  }
  function normPredicate(p) {
    const raw = p === undefined || p === null || p === '' ? 'intersects' : String(p);
    const k = raw.toLowerCase().trim().replace(/[\s-]+/g, '_');
    if (PREDICATES.indexOf(k) >= 0) return k;
    const a = PREDICATE_ALIASES[k] || PREDICATE_ALIASES[k.replace(/_/g, '')];
    if (a) return a;
    throw new Error('Unknown spatial predicate "' + raw + '" (use ' + PREDICATES.join(', ') + ')');
  }
  /** Bbox to search the other layer with for a predicate. */
  function searchBox(P, pred, meters) {
    return pred === 'within_distance' ? expandBox(P.bbox, meters) : padBox(P.bbox, EPS);
  }
  function predicateDistance(pred, opts) {
    if (pred !== 'within_distance') return 0;
    if (!isNum(opts.distance) || opts.distance < 0) throw new Error('Predicate within_distance needs a distance (0 or more)');
    return toM(opts.distance, opts.units);
  }

  /* ================================================================== stats */

  function toNumber(v) {
    if (typeof v === 'number') return isFinite(v) ? v : NaN;
    if (typeof v === 'string' && v.trim() !== '') return Number(v);
    return NaN;
  }
  function isBlank(v) { return v === null || v === undefined || v === ''; }

  function normalizeStats(stats) {
    const specs = [];
    toArr(stats).forEach(function (s) {
      if (!s || typeof s !== 'object') throw new Error('Each statistic needs a field and an op, e.g. { field: "pop", op: "sum" }');
      const opRaw = String(s.op || s.stat || '').toLowerCase().trim().replace(/[\s-]+/g, '_');
      const op = STAT_OPS.indexOf(opRaw) >= 0 ? opRaw : STAT_ALIASES[opRaw];
      if (!op) throw new Error('Unknown statistic "' + (s.op || '') + '" (use ' + STAT_OPS.join(', ') + ')');
      if (s.field === undefined || s.field === null || s.field === '') throw new Error('Statistic "' + op + '" needs a field');
      const field = String(s.field);
      specs.push({ field: field, op: op, name: s.as ? String(s.as) : op + '_' + field });
    });
    return specs;
  }
  /** Streaming aggregator for a list of stat specs. */
  function Aggregator(specs) { this.specs = specs; }
  Aggregator.prototype.create = function () {
    return this.specs.map(function (s) {
      switch (s.op) {
        case 'sum': case 'mean': return { s: 0, n: 0 };
        case 'min': case 'max': return { num: null, str: null };
        case 'count': return { n: 0 };
        case 'first': return { set: false, v: null };
        case 'last': return { v: null };
        case 'concat': return { list: [] };
        case 'unique_count': return { set: new Set() };
        default: return { vals: [] };
      }
    });
  };
  Aggregator.prototype.add = function (states, props) {
    const p = props || {};
    for (let i = 0; i < this.specs.length; i++) {
      const s = this.specs[i], st = states[i];
      const v = p[s.field];
      switch (s.op) {
        case 'sum': case 'mean': { const n = toNumber(v); if (isFinite(n)) { st.s += n; st.n++; } break; }
        case 'min': case 'max': {
          if (isBlank(v)) break;
          const n = toNumber(v);
          if (isFinite(n)) {
            if (st.num === null || (s.op === 'min' ? n < st.num : n > st.num)) st.num = n;
          } else if (typeof v === 'string') {
            if (st.str === null || (s.op === 'min' ? v < st.str : v > st.str)) st.str = v;
          }
          break;
        }
        case 'count': if (!isBlank(v)) st.n++; break;
        case 'first': if (!st.set) { st.set = true; st.v = v === undefined ? null : v; } break;
        case 'last': st.v = v === undefined ? null : v; break;
        case 'concat': if (!isBlank(v)) st.list.push(typeof v === 'object' ? JSON.stringify(v) : String(v)); break;
        case 'unique_count': if (!isBlank(v)) st.set.add(typeof v === 'object' ? 'o:' + JSON.stringify(v) : typeof v + ':' + v); break;
        default: { const n = toNumber(v); if (isFinite(n)) st.vals.push(n); break; }
      }
    }
  };
  Aggregator.prototype.finish = function (states, prefix) {
    const out = {};
    const pre = prefix || '';
    for (let i = 0; i < this.specs.length; i++) {
      const s = this.specs[i], st = states[i];
      let v;
      switch (s.op) {
        case 'sum': v = st.s; break;
        case 'mean': v = st.n ? st.s / st.n : null; break;
        case 'min': case 'max': v = st.num !== null ? st.num : st.str; break;
        case 'count': v = st.n; break;
        case 'first': case 'last': v = st.v; break;
        case 'concat': v = st.list.length ? st.list.join(', ') : null; break;
        case 'unique_count': v = st.set.size; break;
        case 'median': case 'std': {
          if (!st.vals.length) { v = null; break; }
          const stt = util.stats(st.vals);
          v = s.op === 'median' ? stt.median : stt.std;
          break;
        }
        default: v = null;
      }
      out[pre + s.name] = v;
    }
    return out;
  };

  function groupKey(props, fields) {
    if (!fields.length) return { key: '', values: {} };
    const values = {};
    const arr = new Array(fields.length);
    for (let i = 0; i < fields.length; i++) {
      let v = props ? props[fields[i]] : undefined;
      if (v === undefined) v = null;
      values[fields[i]] = v;
      arr[i] = v;
    }
    return { key: JSON.stringify(arr), values: values };
  }

  /* ========================================================= field mapping */

  function layerKeys(fc) {
    const seen = new Set();
    const feats = fc.features;
    for (let i = 0; i < feats.length; i++) {
      const p = feats[i] && feats[i].properties;
      if (p && typeof p === 'object') { const ks = Object.keys(p); for (let k = 0; k < ks.length; k++) seen.add(ks[k]); }
    }
    return Array.from(seen);
  }
  /** Output names for `keys` that don't clash with `taken` (prefix, then suffix on clashes). */
  function fieldMap(taken, keys, prefix, suffix) {
    const used = new Set(taken);
    const map = [];
    for (let i = 0; i < keys.length; i++) {
      let name = (prefix || '') + keys[i];
      while (used.has(name)) name += suffix || '_2';
      used.add(name);
      map.push([keys[i], name]);
    }
    return map;
  }
  function applyMap(out, props, map) {
    for (let i = 0; i < map.length; i++) {
      const v = props ? props[map[i][0]] : undefined;
      out[map[i][1]] = v === undefined ? null : v;
    }
    return out;
  }

  /* ======================================================= representative points */

  function vertexMean(c) {
    let sx = 0, sy = 0, n = 0;
    const add = function (p) { sx += p[0]; sy += p[1]; n++; };
    c.points.forEach(add);
    c.lines.forEach(function (l) { l.forEach(add); });
    c.polys.forEach(function (rings) { rings.forEach(function (r) { for (let i = 0; i < r.length - 1; i++) add(r[i]); }); });
    return n ? [sx / n, sy / n] : null;
  }
  /** Area-weighted centroid (polygons), length-weighted (lines) or mean (points). */
  function centerOfMass(c) {
    if (c.polys.length) {
      const x0 = c.polys[0][0][0][0], y0 = c.polys[0][0][0][1];
      let A = 0, mx = 0, my = 0;
      for (let p = 0; p < c.polys.length; p++) {
        for (let r = 0; r < c.polys[p].length; r++) {
          const ring = c.polys[p][r];
          let a = 0, rx = 0, ry = 0;
          for (let i = 0; i < ring.length - 1; i++) {
            const xi = ring[i][0] - x0, yi = ring[i][1] - y0, xj = ring[i + 1][0] - x0, yj = ring[i + 1][1] - y0;
            const cr = xi * yj - xj * yi;
            a += cr; rx += (xi + xj) * cr; ry += (yi + yj) * cr;
          }
          const sign = (r === 0) === (a > 0) ? 1 : -1;
          A += sign * a; mx += sign * rx; my += sign * ry;
        }
      }
      if (Math.abs(A) > 1e-24) return [x0 + mx / (3 * A), y0 + my / (3 * A)];
    }
    const paths = c.lines.length ? c.lines : c.polys.length ? c.polys.map(function (p) { return p[0]; }) : [];
    if (paths.length) {
      let L = 0, sx = 0, sy = 0;
      paths.forEach(function (l) {
        for (let i = 0; i < l.length - 1; i++) {
          const w = hav(l[i][0], l[i][1], l[i + 1][0], l[i + 1][1]);
          L += w; sx += w * (l[i][0] + l[i + 1][0]) / 2; sy += w * (l[i][1] + l[i + 1][1]) / 2;
        }
      });
      if (L > 0) return [sx / L, sy / L];
    }
    return vertexMean(c);
  }
  /** A point strictly inside the polygons (scan-line through the widest interior span). */
  function interiorPoint(polys) {
    let best = null, bestW = -1;
    for (let p = 0; p < polys.length; p++) {
      const rings = polys[p];
      const ob = ringBBox(rings[0]);
      const cy = (ob[1] + ob[3]) / 2;
      let hi = ob[3], lo = ob[1];
      for (let r = 0; r < rings.length; r++) {
        for (let i = 0; i < rings[r].length; i++) {
          const y = rings[r][i][1];
          if (y > cy && y < hi) hi = y;
          if (y <= cy && y > lo) lo = y;
        }
      }
      const sy = (hi + lo) / 2;
      const xs = [];
      for (let r = 0; r < rings.length; r++) {
        const ring = rings[r];
        for (let i = 0; i < ring.length - 1; i++) {
          const a = ring[i], b = ring[i + 1];
          if ((a[1] > sy) !== (b[1] > sy)) xs.push(a[0] + ((sy - a[1]) * (b[0] - a[0])) / (b[1] - a[1]));
        }
      }
      xs.sort(numAsc);
      for (let i = 0; i + 1 < xs.length; i += 2) {
        const w = xs[i + 1] - xs[i];
        if (w > bestW) { bestW = w; best = [(xs[i] + xs[i + 1]) / 2, sy]; }
      }
    }
    return best;
  }
  function alongPath(line, dist) {
    let acc = 0;
    for (let i = 0; i < line.length - 1; i++) {
      const a = line[i], b = line[i + 1];
      const d = hav(a[0], a[1], b[0], b[1]);
      if (acc + d >= dist && d > 0) return lerpPos(a, b, (dist - acc) / d);
      acc += d;
    }
    return line[line.length - 1];
  }
  /** Point guaranteed to lie on the geometry (inside polygons, on lines). */
  function pointOnSurface(c) {
    if (c.polys.length) {
      const cm = centerOfMass(c);
      if (cm && pipPolys(cm[0], cm[1], c.polys) === 1) return cm;
      return interiorPoint(c.polys) || c.polys[0][0][0];
    }
    if (c.lines.length) {
      let best = null, bestL = -1;
      c.lines.forEach(function (l) { const L = pathLengthM(l); if (L > bestL) { bestL = L; best = l; } });
      return alongPath(best, bestL / 2);
    }
    if (c.points.length) {
      if (c.points.length === 1) return c.points[0];
      const m = vertexMean(c);
      let best = c.points[0], bd = Infinity;
      c.points.forEach(function (p) { const d = (p[0] - m[0]) * (p[0] - m[0]) + (p[1] - m[1]) * (p[1] - m[1]); if (d < bd) { bd = d; best = p; } });
      return best;
    }
    return null;
  }

  /* =============================================================== buffers */

  function circlePolygon(center, meters, segments) {
    const ring = [];
    for (let i = 0; i < segments; i++) ring.push(destination(center[0], center[1], meters, -360 * i / segments));
    ring.push(ring[0].slice());
    return [ring];
  }
  function jstsBuffer(geom, meters, steps) {
    const run = function (g) {
      const res = T().buffer({ type: 'Feature', properties: {}, geometry: g }, meters, { units: 'meters', steps: steps });
      return res && res.geometry ? cleanPolys(polysOf(res.geometry)) : [];
    };
    try {
      return run(geom);
    } catch (err) {
      const snap = function (p) { return [Math.round(p[0] * 1e9) / 1e9, Math.round(p[1] * 1e9) / 1e9]; };
      const snapped = util.mapCoords(geom, snap);
      const fixed = mapParts(snapped, cleanLine, cleanRing);
      if (fixed) { try { return run(fixed); } catch (e) { /* fall through */ } }
      throw err;
    }
  }
  /** Buffer one geometry; returns polygons (MultiPolygon coordinates). */
  function bufferGeometry(g, meters, steps, W) {
    const c = components(g);
    const pieces = [];
    if (meters > 0) c.points.forEach(function (p) { pieces.push([circlePolygon(p, meters, steps * 4)]); });
    if (c.lines.length) {
      const r = jstsBuffer(linesGeom(c.lines), meters, steps);
      if (r.length) pieces.push(r);
    }
    if (c.polys.length) {
      const r = jstsBuffer(polysGeom(c.polys), meters, steps);
      if (r.length) pieces.push(r);
    }
    if (pieces.length <= 1) return pieces[0] || [];
    return unionMany(pieces, W);
  }
  function bufferSteps(steps) {
    if (steps === undefined || steps === null) return 8;
    const s = Math.round(Number(steps));
    if (!(s >= 1 && s <= 256)) throw new Error('Buffer steps must be a whole number between 1 and 256');
    return s;
  }

  /* ============================================================ hulls */

  /** Convex hull (monotone chain) of positions; closed CCW ring or null when degenerate. */
  function hullRing(points) {
    const pts = points.map(function (p) { return [p[0], p[1]]; }).sort(function (a, b) { return a[0] - b[0] || a[1] - b[1]; });
    const uniq = [];
    for (let i = 0; i < pts.length; i++) if (!uniq.length || !samePos(uniq[uniq.length - 1], pts[i])) uniq.push(pts[i]);
    if (uniq.length < 3) return null;
    const cross = function (o, a, b) { return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]); };
    const lower = [], upper = [];
    for (let i = 0; i < uniq.length; i++) {
      while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], uniq[i]) <= 0) lower.pop();
      lower.push(uniq[i]);
    }
    for (let i = uniq.length - 1; i >= 0; i--) {
      while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], uniq[i]) <= 0) upper.pop();
      upper.push(uniq[i]);
    }
    const ring = lower.slice(0, -1).concat(upper.slice(0, -1));
    if (ring.length < 3) return null;
    ring.push(ring[0].slice());
    return Math.abs(ringArea(ring)) > 1e-20 ? ring : null;
  }
  function allPositions(g) {
    const c = components(g);
    const out = c.points.slice();
    c.lines.forEach(function (l) { for (let i = 0; i < l.length; i++) out.push(l[i]); });
    c.polys.forEach(function (rings) { const r = rings[0]; for (let i = 0; i < r.length - 1; i++) out.push(r[i]); });
    return out;
  }
  /** Group features by the values of `fields`; returns [{ values, indices, positions }]. */
  function groupPositions(fc, fields, W) {
    const groups = new Map();
    fc.features.forEach(function (f, i) {
      if (!f || !f.geometry) { W.skipNull(); return; }
      const gk = groupKey(f.properties, fields);
      let g = groups.get(gk.key);
      if (!g) { g = { values: gk.values, count: 0, positions: [] }; groups.set(gk.key, g); }
      g.count++;
      const pos = allPositions(f.geometry);
      for (let k = 0; k < pos.length; k++) g.positions.push(pos[k]);
    });
    return Array.from(groups.values());
  }
  /**
   * Smallest edge length that keeps every point on a kept triangle and all kept
   * triangles edge-connected (so the default concave hull is one polygon that
   * includes every point). Triangles carry vertex indices in properties a/b/c.
   */
  function defaultMaxEdge(tris, lens, nPoints) {
    const T = tris.length;
    if (!T) return Infinity;
    const maxLen = lens.map(function (l) { return Math.max(l[0], l[1], l[2]); });
    const vs = tris.map(function (t) { return [t.properties.a, t.properties.b, t.properties.c]; });
    // Triangles sharing each edge.
    const edgeTris = new Map();
    vs.forEach(function (v, ti) {
      for (let k = 0; k < 3; k++) {
        const a = v[k], b = v[(k + 1) % 3];
        const key = a < b ? a + ':' + b : b + ':' + a;
        const e = edgeTris.get(key);
        if (e) e.push(ti); else edgeTris.set(key, [ti]);
      }
    });
    const ok = function (limit) {
      const parent = new Int32Array(T);
      for (let i = 0; i < T; i++) parent[i] = i;
      const find = function (i) { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
      const covered = new Uint8Array(nPoints);
      let kept = 0, nCovered = 0;
      for (let ti = 0; ti < T; ti++) {
        if (maxLen[ti] > limit) continue;
        kept++;
        for (let k = 0; k < 3; k++) if (!covered[vs[ti][k]]) { covered[vs[ti][k]] = 1; nCovered++; }
      }
      if (!kept || nCovered < nPoints) return false;
      let comps = kept;
      edgeTris.forEach(function (list) {
        if (list.length < 2 || maxLen[list[0]] > limit || maxLen[list[1]] > limit) return;
        const a = find(list[0]), b = find(list[1]);
        if (a !== b) { parent[a] = b; comps--; }
      });
      return comps === 1;
    };
    const sorted = Array.from(new Set(maxLen)).sort(numAsc);
    let lo = 0, hi = sorted.length - 1;
    if (!ok(sorted[hi])) return Infinity;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (ok(sorted[mid])) hi = mid; else lo = mid + 1;
    }
    return sorted[lo] * (1 + 1e-9);
  }

  /* ========================================================= simplification */

  /** Douglas–Peucker (optionally after a radial-distance pass) with tolerance in meters. */
  function simplifyPath(pts, tolM, highQuality) {
    const n = pts.length;
    if (n <= 2) return pts.slice();
    const tol2 = tolM * tolM;
    const kx = new Float64Array(n);
    for (let i = 0; i < n; i++) kx[i] = Math.cos(pts[i][1] * RAD) * M_PER_DEG;
    let src = pts, kxs = kx;
    if (!highQuality) {
      const keep = [0];
      let last = 0;
      for (let i = 1; i < n - 1; i++) {
        const dx = (pts[i][0] - pts[last][0]) * kx[i], dy = (pts[i][1] - pts[last][1]) * M_PER_DEG;
        if (dx * dx + dy * dy > tol2) { keep.push(i); last = i; }
      }
      keep.push(n - 1);
      src = keep.map(function (i) { return pts[i]; });
      kxs = keep.map(function (i) { return kx[i]; });
    }
    const m = src.length;
    if (m <= 2) return src.slice();
    const mark = new Uint8Array(m);
    mark[0] = mark[m - 1] = 1;
    const stack = [0, m - 1];
    while (stack.length) {
      const last = stack.pop(), first = stack.pop();
      let maxD = 0, idx = -1;
      for (let i = first + 1; i < last; i++) {
        const k = kxs[i];
        const px = src[i][0] * k, py = src[i][1] * M_PER_DEG;
        const ax = src[first][0] * k, ay = src[first][1] * M_PER_DEG;
        const bx = src[last][0] * k, by = src[last][1] * M_PER_DEG;
        let dx = bx - ax, dy = by - ay;
        let x = ax, y = ay;
        if (dx !== 0 || dy !== 0) {
          const t = clamp01(((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy));
          x = ax + dx * t; y = ay + dy * t;
        }
        dx = px - x; dy = py - y;
        const d = dx * dx + dy * dy;
        if (d > maxD) { maxD = d; idx = i; }
      }
      if (idx >= 0 && maxD > tol2) {
        mark[idx] = 1;
        stack.push(first, idx, idx, last);
      }
    }
    const out = [];
    for (let i = 0; i < m; i++) if (mark[i]) out.push(src[i]);
    return out;
  }
  function simplifyRing(ring, tolM, hq) {
    // Split at the vertex farthest from the first so both halves have fixed ends.
    const n = ring.length;
    let far = 1, fd = -1;
    const k = Math.cos(ring[0][1] * RAD);
    for (let i = 1; i < n - 1; i++) {
      const dx = (ring[i][0] - ring[0][0]) * k, dy = ring[i][1] - ring[0][1];
      const d = dx * dx + dy * dy;
      if (d > fd) { fd = d; far = i; }
    }
    const a = simplifyPath(ring.slice(0, far + 1), tolM, hq);
    const b = simplifyPath(ring.slice(far), tolM, hq);
    const out = a.concat(b.slice(1));
    return cleanRing(out);
  }

  function chaikin(pts, iterations, closed) {
    let cur = pts;
    for (let it = 0; it < iterations; it++) {
      const out = [];
      if (closed) {
        for (let i = 0; i < cur.length - 1; i++) out.push(lerpPos(cur[i], cur[i + 1], 0.25), lerpPos(cur[i], cur[i + 1], 0.75));
        out.push(out[0].slice());
      } else {
        out.push(cur[0]);
        for (let i = 0; i < cur.length - 1; i++) out.push(lerpPos(cur[i], cur[i + 1], 0.25), lerpPos(cur[i], cur[i + 1], 0.75));
        out.push(cur[cur.length - 1]);
      }
      cur = out;
    }
    return cur;
  }

  function slerp(a, b, t) {
    const p1 = a[1] * RAD, l1 = a[0] * RAD, p2 = b[1] * RAD, l2 = b[0] * RAD;
    const v1 = [Math.cos(p1) * Math.cos(l1), Math.cos(p1) * Math.sin(l1), Math.sin(p1)];
    const v2 = [Math.cos(p2) * Math.cos(l2), Math.cos(p2) * Math.sin(l2), Math.sin(p2)];
    const dot = Math.max(-1, Math.min(1, v1[0] * v2[0] + v1[1] * v2[1] + v1[2] * v2[2]));
    const om = Math.acos(dot);
    if (om < 1e-12) return lerpPos(a, b, t);
    const s = Math.sin(om), k1 = Math.sin((1 - t) * om) / s, k2 = Math.sin(t * om) / s;
    const x = k1 * v1[0] + k2 * v2[0], y = k1 * v1[1] + k2 * v2[1], z = k1 * v1[2] + k2 * v2[2];
    const p = [Math.atan2(y, x) / RAD, Math.atan2(z, Math.sqrt(x * x + y * y)) / RAD];
    if (a.length > 2 && b.length > 2 && isNum(a[2]) && isNum(b[2])) p.push(a[2] + t * (b[2] - a[2]));
    return p;
  }
  function densifyPath(pts, intervalM, geodesic, counter) {
    const out = [pts[0]];
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i], b = pts[i + 1];
      const d = hav(a[0], a[1], b[0], b[1]);
      const n = Math.ceil(d / intervalM - 1e-9);
      counter.n += n;
      if (counter.n > MAX_OUTPUT_VERTICES) throw new Error('Densify would create more than ' + MAX_OUTPUT_VERTICES.toLocaleString('en-US') + ' vertices; use a larger interval');
      for (let k = 1; k < n; k++) out.push(geodesic ? slerp(a, b, k / n) : lerpPos(a, b, k / n));
      out.push(b);
    }
    return out;
  }

  /* ========================================================== validation */

  /** Problems of a cleaned polygon set: self-intersections, overlapping parts, holes outside shells. */
  function polygonProblems(polys) {
    const problems = new Set();
    const items = [];
    for (let p = 0; p < polys.length; p++) {
      for (let r = 0; r < polys[p].length; r++) {
        const ring = polys[p][r], n = ring.length - 1;
        for (let i = 0; i < n; i++) {
          const a = ring[i], b = ring[i + 1];
          items.push({ minX: Math.min(a[0], b[0]), minY: Math.min(a[1], b[1]), maxX: Math.max(a[0], b[0]), maxY: Math.max(a[1], b[1]), a: a, b: b, p: p, r: r, i: i, n: n, id: items.length });
        }
      }
    }
    let tree = null;
    if (items.length > 64) { tree = newTree(); tree.load(items); }
    const ss = {};
    for (let s = 0; s < items.length && !problems.has('self-intersection'); s++) {
      const it = items[s];
      const cands = tree ? tree.search({ minX: it.minX - EPS, minY: it.minY - EPS, maxX: it.maxX + EPS, maxY: it.maxY + EPS }) : items;
      for (let k = 0; k < cands.length; k++) {
        const o = cands[k];
        if (o.id <= it.id) continue;
        if (!tree && (o.maxX < it.minX - EPS || o.minX > it.maxX + EPS || o.maxY < it.minY - EPS || o.minY > it.maxY + EPS)) continue;
        const n = segSeg(it.a[0], it.a[1], it.b[0], it.b[1], o.a[0], o.a[1], o.b[0], o.b[1], ss);
        if (!n) continue;
        if (it.p === o.p && it.r === o.r) {
          const adj = o.i - it.i === 1 || (it.i === 0 && o.i === it.n - 1);
          if (adj && n === 1) continue;
          problems.add('self-intersection');
          break;
        }
        if (n === 2) { problems.add('self-intersection'); break; }
        const lt = EPS / Math.max(1e-300, Math.hypot(it.b[0] - it.a[0], it.b[1] - it.a[1]));
        const lu = EPS / Math.max(1e-300, Math.hypot(o.b[0] - o.a[0], o.b[1] - o.a[1]));
        if (ss.t0 > lt && ss.t0 < 1 - lt && ss.u0 > lu && ss.u0 < 1 - lu) { problems.add('self-intersection'); break; }
      }
    }
    const probe = function (ring, container) {
      // First vertex of `ring` not on the boundary of `container` -> its location.
      for (let i = 0; i < ring.length - 1; i++) {
        const v = typeof container[0][0] === 'number' ? pipRing(ring[i][0], ring[i][1], container) : pipPolygon(ring[i][0], ring[i][1], container);
        if (v !== 0) return v;
      }
      return 0;
    };
    for (let p = 0; p < polys.length; p++) {
      for (let r = 1; r < polys[p].length; r++) if (probe(polys[p][r], polys[p][0]) === -1) problems.add('hole outside shell');
    }
    if (polys.length > 1) {
      const boxes = polys.map(function (pp) { return ringBBox(pp[0]); });
      for (let i = 0; i < polys.length; i++) {
        for (let j = 0; j < polys.length; j++) {
          if (i === j || !boxesIntersect(boxes[i], boxes[j])) continue;
          if (probe(polys[j][0], polys[i]) === 1) problems.add('overlapping parts');
        }
      }
    }
    return Array.from(problems);
  }

  function validateGeometry(g) {
    if (!g) return ['null geometry'];
    const reasons = new Set();
    const checkPos = function (p) {
      if (!Array.isArray(p) || p.length < 2) { reasons.add('invalid position'); return false; }
      if (!isNum(p[0]) || !isNum(p[1])) { reasons.add('NaN coordinates'); return false; }
      if (Math.abs(p[0]) > 180 || Math.abs(p[1]) > 90) reasons.add('coordinates outside lon/lat range');
      return true;
    };
    const checkArr = function (a) {
      if (!Array.isArray(a)) { reasons.add('invalid coordinates'); return false; }
      return true;
    };
    const checkLine = function (c) {
      if (!checkArr(c)) return;
      let finite = true;
      c.forEach(function (p) { if (!checkPos(p)) finite = false; });
      if (finite && cleanPath(c).length < 2) reasons.add('too few positions');
    };
    const checkPolygon = function (rings) {
      if (!checkArr(rings)) return null;
      if (!rings.length) { reasons.add('empty geometry'); return null; }
      let ok = true;
      rings.forEach(function (ring) {
        if (!checkArr(ring)) { ok = false; return; }
        let finite = true;
        ring.forEach(function (p) { if (!checkPos(p)) finite = false; });
        if (!finite) { ok = false; return; }
        if (ring.length < 4 || cleanPath(ring).length < 3) { reasons.add('too few positions'); ok = false; return; }
        if (!samePos(ring[0], ring[ring.length - 1])) reasons.add('unclosed ring');
        const closed = cleanPath(ring);
        if (!samePos(closed[0], closed[closed.length - 1])) closed.push(closed[0]);
        if (closed.length < 4) { reasons.add('too few positions'); ok = false; return; }
        if (ringCollinear(closed)) { reasons.add('degenerate ring (zero area)'); ok = false; }
      });
      return ok ? cleanPolygon(rings) : null;
    };
    switch (g.type) {
      case 'Point': checkPos(g.coordinates); break;
      case 'MultiPoint': if (checkArr(g.coordinates)) g.coordinates.forEach(checkPos); break;
      case 'LineString': checkLine(g.coordinates); break;
      case 'MultiLineString':
        if (checkArr(g.coordinates)) { if (!g.coordinates.length) reasons.add('empty geometry'); g.coordinates.forEach(checkLine); }
        break;
      case 'Polygon': {
        const p = checkPolygon(g.coordinates);
        if (p) polygonProblems([p]).forEach(function (r) { reasons.add(r); });
        break;
      }
      case 'MultiPolygon': {
        if (!checkArr(g.coordinates)) break;
        if (!g.coordinates.length) reasons.add('empty geometry');
        const ps = [];
        let allOk = true;
        g.coordinates.forEach(function (rings) { const p = checkPolygon(rings); if (p) ps.push(p); else allOk = false; });
        if (ps.length && allOk) polygonProblems(ps).forEach(function (r) { reasons.add(r); });
        break;
      }
      case 'GeometryCollection':
        if (!Array.isArray(g.geometries)) reasons.add('invalid coordinates');
        else g.geometries.forEach(function (x) { validateGeometry(x).forEach(function (r) { if (r !== 'null geometry') reasons.add(r); else reasons.add('invalid member geometry'); }); });
        break;
      default: reasons.add('unknown geometry type "' + g.type + '"');
    }
    return Array.from(reasons);
  }

  /** Insert vertices that touch a non-adjacent edge of the same ring into that edge. */
  function nodeRing(ring) {
    const n = ring.length - 1;
    const segs = [];
    for (let i = 0; i < n; i++) {
      const a = ring[i], b = ring[i + 1];
      segs.push({ minX: Math.min(a[0], b[0]) - EPS, minY: Math.min(a[1], b[1]) - EPS, maxX: Math.max(a[0], b[0]) + EPS, maxY: Math.max(a[1], b[1]) + EPS, i: i });
    }
    let tree = null;
    if (n > 64) { tree = newTree(); tree.load(segs); }
    const inserts = new Map();
    for (let v = 0; v < n; v++) {
      const p = ring[v];
      const cands = tree ? tree.search({ minX: p[0], minY: p[1], maxX: p[0], maxY: p[1] }) : segs;
      for (let k = 0; k < cands.length; k++) {
        const s = cands[k], i = s.i;
        if (p[0] < s.minX || p[0] > s.maxX || p[1] < s.minY || p[1] > s.maxY) continue;
        if (i === v || (i + 1) % n === v) continue;
        const a = ring[i], b = ring[i + 1];
        if (samePos(a, p) || samePos(b, p) || distSeg(p[0], p[1], a[0], a[1], b[0], b[1]) > EPS) continue;
        const dx = b[0] - a[0], dy = b[1] - a[1];
        const t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy);
        if (t <= 0 || t >= 1) continue;
        let list = inserts.get(i);
        if (!list) { list = []; inserts.set(i, list); }
        list.push({ t: t, p: p });
      }
    }
    if (!inserts.size) return ring;
    const out = [];
    for (let i = 0; i < n; i++) {
      out.push(ring[i]);
      const list = inserts.get(i);
      if (list) { list.sort(function (x, y) { return x.t - y.t; }); list.forEach(function (e) { out.push(e.p); }); }
    }
    out.push(ring[0]);
    return out;
  }
  /** Split a closed ring at repeated vertices into simple closed loops. */
  function splitRingLoops(ring) {
    const out = [];
    const stack = [ring.slice(0, ring.length - 1)];
    while (stack.length) {
      const pts = stack.pop();
      const seen = new Map();
      let split = false;
      for (let i = 0; i < pts.length; i++) {
        const k = pts[i][0] + ',' + pts[i][1];
        if (seen.has(k)) {
          const j = seen.get(k);
          const loop = pts.slice(j, i), rest = pts.slice(0, j).concat(pts.slice(i));
          if (loop.length >= 3) stack.push(loop);
          if (rest.length >= 3) stack.push(rest);
          split = true;
          break;
        }
        seen.set(k, i);
      }
      if (!split) {
        const c = cleanRing(pts.concat([pts[0].slice()]));
        if (c) out.push(c);
      }
    }
    return out;
  }
  /**
   * Rings that touch themselves (pinch points, "inverted holes") are split into
   * simple loops and reassembled: loops wound like their shell become shells,
   * the others holes of the smallest shell containing them.
   */
  function splitSelfTouching(polys) {
    let changed = false;
    const shells = [], holes = [];
    for (let p = 0; p < polys.length; p++) {
      const rings = polys[p];
      const loops = splitRingLoops(nodeRing(rings[0]));
      if (loops.length !== 1) changed = true;
      const sign = ringArea(rings[0]) >= 0 ? 1 : -1;
      loops.forEach(function (l) { if ((ringArea(l) >= 0 ? 1 : -1) === sign) shells.push(l); else holes.push(l); });
      for (let r = 1; r < rings.length; r++) {
        const hl = splitRingLoops(nodeRing(rings[r]));
        if (hl.length !== 1) changed = true;
        hl.forEach(function (h) { holes.push(h); });
      }
    }
    if (!changed) return polys;
    const S = shells.map(function (s) { return { ring: s, area: Math.abs(ringArea(s)), holes: [] }; }).sort(function (a, b) { return a.area - b.area; });
    holes.forEach(function (h) {
      for (let s = 0; s < S.length; s++) {
        let v = 0;
        for (let k = 0; k < h.length - 1 && v === 0; k++) v = pipRing(h[k][0], h[k][1], S[s].ring);
        if (v === 1) { S[s].holes.push(h); return; }
      }
    });
    return S.reverse().map(function (s) { return [s.ring].concat(s.holes); });
  }

  /** RFC 7946 winding: outer rings counter-clockwise, holes clockwise. */
  function rewindPolys(polys) {
    return polys.map(function (rings) {
      return rings.map(function (r, i) {
        const ccw = ringArea(r) > 0;
        return (i === 0) === ccw ? r : r.slice().reverse();
      });
    });
  }

  function repairGeometry(g, W) {
    if (!g) return null;
    switch (g.type) {
      case 'Point': return isPos(g.coordinates) ? g : null;
      case 'MultiPoint': {
        const pts = Array.isArray(g.coordinates) ? g.coordinates.filter(isPos) : [];
        return pts.length ? { type: 'MultiPoint', coordinates: pts } : null;
      }
      case 'LineString': case 'MultiLineString': return mapParts(g, function (l) { return l; }, function (r) { return r; });
      case 'Polygon': case 'MultiPolygon': {
        let polys = tidyPolys(components(g).polys);
        if (!polys.length) return null;
        if (polygonProblems(polys).length) {
          // Self-union rebuilds a valid polygon (splits bow-ties, merges overlapping parts,
          // drops holes outside shells); an empty result means the polygon has no area.
          let fixed = null;
          try { fixed = clipOp('union', [polys]); } catch (e) {
            try { fixed = jstsBuffer(polysGeom(polys), 0, 8); } catch (e2) { fixed = null; }
          }
          if (fixed && !fixed.length) return null;
          if (fixed) polys = splitSelfTouching(fixed);
          else if (W) W.count('unrepaired', 'feature could not be fully repaired', 'features could not be fully repaired');
        }
        polys = rewindPolys(polys);
        if (g.type === 'MultiPolygon') return { type: 'MultiPolygon', coordinates: polys };
        return polysGeom(polys);
      }
      case 'GeometryCollection': {
        const gs = (Array.isArray(g.geometries) ? g.geometries : []).map(function (x) { return repairGeometry(x, W); }).filter(Boolean);
        return gs.length ? { type: 'GeometryCollection', geometries: gs } : null;
      }
      default: return null;
    }
  }

  /* ================================================================ random */

  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function seedOf(seed) {
    if (seed === undefined || seed === null || seed === '') return (Math.random() * 4294967296) >>> 0;
    if (isNum(seed)) return seed >>> 0;
    let h = 2166136261;
    const s = String(seed);
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
  }
  /** Area-uniform random position in a lon/lat box. */
  function randomInBox(rand, b) {
    const s0 = Math.sin(b[1] * RAD), s1 = Math.sin(b[3] * RAD);
    const lat = Math.asin(s0 + rand() * (s1 - s0)) / RAD;
    return [b[0] + rand() * (b[2] - b[0]), lat];
  }

  /* ======================================== overlay of one feature with polygons */

  const UNCHANGED = {};

  /**
   * Clip ('clip': keep inside) or erase ('erase': keep outside) prepared
   * geometry F against candidate polygon preps. Returns a geometry, null, or
   * UNCHANGED when the input geometry can be reused as is.
   */
  function overlay(F, cands, mode) {
    const keepIn = mode === 'clip';
    let rel = cands.filter(function (C) { return boxesIntersect(padBox(C.bbox, EPS), F.bbox); });
    if (!rel.length) return keepIn ? null : UNCHANGED;
    let allOutside = true;
    for (let i = 0; i < rel.length; i++) {
      const r = rel[i].boxRelation(padBox(F.bbox, EPS));
      if (r === 'inside') return keepIn ? UNCHANGED : null;
      if (r !== 'outside') allOutside = false;
    }
    if (allOutside) return keepIn ? null : UNCHANGED;
    // Drop candidates that only overlap by bbox (cheap exact test; saves polyclip calls).
    rel = rel.filter(function (C) { return intersects(F, C); });
    if (!rel.length) return keepIn ? null : UNCHANGED;
    const area = rel.length === 1 ? rel[0] : new AreaSet(rel);
    const points = F.points.filter(function (p) { const v = area.pip(p[0], p[1]); return keepIn ? v >= 0 : v < 0; });
    const lines = F.lines.length ? clipLinesToArea(F.lines, area, keepIn ? function (c) { return c >= 0; } : function (c) { return c < 0; }) : [];
    let polys = [];
    if (F.polys.length) {
      // Candidates (pre-clipped near F) form one MultiPolygon operand: polyclip
      // treats it as the union of its parts, so no separate union is needed.
      const box = marginBox(F.bbox);
      const others = [];
      rel.forEach(function (C) { const lp = localPolys(C, box); for (let i = 0; i < lp.length; i++) others.push(lp[i]); });
      if (keepIn) {
        if (others.length) {
          let clipBox = null;
          rel.forEach(function (C) { clipBox = util.bboxUnion(clipBox, C.bbox); });
          polys = clipOp('intersect', [localPolys(F, marginBox(interBox(F.bbox, clipBox))), others]);
        }
      } else {
        polys = clipOp('difference', [F.polys, others]);
      }
    }
    return geomFrom(points, lines, polys);
  }

  /* ======================================================= line intersections */

  /** RBush over every segment (lines and polygon rings) of a layer; items carry the feature index `f`. */
  function segmentLayer(fc) {
    const items = [];
    fc.features.forEach(function (f, fi) {
      if (!f || !f.geometry) return;
      featurePaths(f.geometry).forEach(function (path) {
        for (let i = 0; i < path.length - 1; i++) {
          const a = path[i], b = path[i + 1];
          items.push({ minX: Math.min(a[0], b[0]), minY: Math.min(a[1], b[1]), maxX: Math.max(a[0], b[0]), maxY: Math.max(a[1], b[1]), a: a, b: b, f: fi });
        }
      });
    });
    const tree = newTree();
    tree.load(items);
    return tree;
  }
  function featurePaths(g) {
    const c = components(g);
    const paths = c.lines.slice();
    c.polys.forEach(function (rings) { rings.forEach(function (r) { paths.push(r); }); });
    return paths;
  }

  /* ===================================================================== API */

  const geoops = (M.geoops = {
    PREDICATES: PREDICATES.slice(),
    STAT_OPS: STAT_OPS.slice(),
    CENTROID_METHODS: CENTROID_METHODS.slice(),
    GRID_TYPES: GRID_TYPES.slice(),
    MAX_GRID_CELLS: MAX_GRID_CELLS,

    /**
     * Bounding-box spatial index over a FeatureCollection.
     * @param {object} fc FeatureCollection
     * @returns {{ search(bbox: number[]): number[], size: number }} search returns
     *   the (ascending) indices into fc.features whose bbox intersects `bbox`.
     */
    index(fc) {
      fc = asFC(fc);
      const L = new Layer(fc);
      return {
        size: L.size(),
        search(bbox) {
          if (!Array.isArray(bbox) || bbox.length < 4 || !bbox.slice(0, 4).every(isNum)) throw new Error('search() needs a bbox [minX, minY, maxX, maxY]');
          return L.search([Math.min(bbox[0], bbox[2]), Math.min(bbox[1], bbox[3]), Math.max(bbox[0], bbox[2]), Math.max(bbox[1], bbox[3])]);
        },
      };
    },

    /**
     * Buffer every feature by `distance` (negative insets polygons; empty results are dropped).
     * @param {object} fc
     * @param {number} distance in `units` (default meters)
     * @param {{units?: string, steps?: number, dissolve?: boolean}} [opts] steps = segments per quarter circle
     * @returns {object} polygons with the input properties (dissolve → one feature `{ distance }`)
     */
    buffer(fc, distance, opts) {
      opts = opts || {};
      fc = asFC(fc);
      if (!isNum(distance)) throw new Error('Buffer distance must be a number');
      const meters = toM(distance, opts.units);
      const steps = bufferSteps(opts.steps);
      const W = new Warnings();
      const out = [];
      fc.features.forEach(function (f) {
        if (!f || !f.geometry) { W.skipNull(); return; }
        let polys;
        try { polys = bufferGeometry(f.geometry, meters, steps, W); } catch (e) { W.fail('buffered', e); return; }
        if (!polys.length) { W.count('empty', 'feature had an empty buffer and was dropped', 'features had an empty buffer and were dropped'); return; }
        out.push(feature(polysGeom(polys), copyProps(f)));
      });
      if (opts.dissolve) {
        const u = unionMany(out.map(function (f) { return polysOf(f.geometry); }), W);
        return result(u.length ? [feature(polysGeom(u), { distance: distance })] : [], W);
      }
      return result(out, W);
    },

    /**
     * Concentric buffers at several distances.
     * @param {object} fc
     * @param {number[]} distances positive, in `units` (default meters)
     * @param {{units?: string, dissolve?: boolean, rings?: boolean, steps?: number}} [opts]
     *   dissolve (default true) merges all features per distance; rings (default true) makes
     *   donuts that exclude the next smaller buffer.
     * @returns {object} polygons with a `distance` property (plus input properties when not dissolved)
     */
    multiRingBuffer(fc, distances, opts) {
      opts = opts || {};
      fc = asFC(fc);
      const ds = Array.from(new Set(toArr(distances).map(Number).filter(isNum))).sort(numAsc);
      if (!ds.length) throw new Error('Multi-ring buffer needs at least one distance');
      if (ds[0] <= 0) throw new Error('Ring distances must be greater than 0');
      const units = linUnit(opts.units);
      const steps = bufferSteps(opts.steps);
      const dissolve = opts.dissolve !== false, rings = opts.rings !== false;
      const W = new Warnings();
      const feats = [];
      fc.features.forEach(function (f) { if (!f || !f.geometry) W.skipNull(); else feats.push(f); });
      const failed = new Set();
      const buf = function (f, fi, d) {
        if (failed.has(fi)) return [];
        try { return bufferGeometry(f.geometry, util.toMeters(d, units), steps, W); } catch (e) { failed.add(fi); W.fail('buffered', e); return []; }
      };
      const out = [];
      if (dissolve) {
        let prev = null;
        ds.forEach(function (d) {
          const disk = unionMany(feats.map(function (f, fi) { return buf(f, fi, d); }), W);
          let polys = disk;
          if (rings && prev && prev.length) {
            try { polys = clipOp('difference', [disk, prev]); } catch (e) { W.fail('turned into rings', e); }
          }
          if (polys.length) out.push(feature(polysGeom(polys), { distance: d }));
          prev = disk;
        });
      } else {
        feats.forEach(function (f, fi) {
          let prev = null;
          ds.forEach(function (d) {
            const disk = buf(f, fi, d);
            let polys = disk;
            if (rings && prev && prev.length) {
              try { polys = clipOp('difference', [disk, prev]); } catch (e) { W.fail('turned into rings', e); }
            }
            if (polys.length) { const p = copyProps(f); p.distance = d; out.push(feature(polysGeom(polys), p)); }
            prev = disk;
          });
        });
      }
      return result(out, W);
    },

    /**
     * Clip features to the union of clipFc's polygons: points inside are kept, lines are cut at
     * polygon boundaries (inside pieces kept), polygons are intersected. One output per input.
     * @param {object} fc
     * @param {object} clipFc polygon layer
     * @returns {object}
     */
    clip(fc, clipFc) {
      fc = asFC(fc, 'Input layer');
      clipFc = asFC(clipFc, 'Clip layer');
      const L = polygonLayer(clipFc, 'Clip layer has no polygons');
      return overlayLayer(fc, L, 'clip', 'clipped');
    },

    /**
     * Remove the parts of features that fall inside eraseFc's polygons (points outside kept,
     * line parts outside kept, polygon difference).
     * @param {object} fc
     * @param {object} eraseFc polygon layer
     * @returns {object}
     */
    erase(fc, eraseFc) {
      fc = asFC(fc, 'Input layer');
      eraseFc = asFC(eraseFc, 'Erase layer');
      const L = polygonLayer(eraseFc, 'Erase layer has no polygons');
      return overlayLayer(fc, L, 'erase', 'erased');
    },

    /**
     * Overlay intersection: one output per intersecting (A feature, B polygon) pair with the
     * geometry of their intersection and the properties of both (B's clashing names get `suffix`).
     * @param {object} fcA points, lines or polygons
     * @param {object} fcB polygons
     * @param {{suffix?: string}} [opts] default '_2'
     * @returns {object}
     */
    intersect(fcA, fcB, opts) {
      opts = opts || {};
      fcA = asFC(fcA, 'First layer');
      fcB = asFC(fcB, 'Second layer');
      const L = polygonLayer(fcB, 'Intersect layer has no polygons');
      const map = fieldMap(layerKeys(fcA), layerKeys(fcB), '', opts.suffix || '_2');
      const W = new Warnings();
      const out = [];
      fcA.features.forEach(function (f) {
        if (!f || !f.geometry) { W.skipNull(); return; }
        const F = new Prep(f.geometry);
        if (F.isEmpty()) { W.count('empty', 'feature with empty geometry was skipped', 'features with empty geometry were skipped'); return; }
        const cands = L.search(padBox(F.bbox, EPS));
        for (let k = 0; k < cands.length; k++) {
          const j = cands[k];
          const C = L.prep(j);
          if (!C) continue;
          let g;
          try { g = overlay(F, [C], 'clip'); } catch (e) { W.fail('intersected', e); continue; }
          if (!g) continue;
          if (g === UNCHANGED) g = f.geometry;
          out.push(feature(g, applyMap(copyProps(f), fcB.features[j].properties, map)));
        }
      });
      return result(out, W);
    },

    /**
     * Polygon overlay union: A∩B pieces with both attribute sets, A−B pieces (B fields null)
     * and B−A pieces (A fields null).
     * @param {object} fcA polygons
     * @param {object} fcB polygons
     * @param {{suffix?: string}} [opts]
     * @returns {object}
     */
    union(fcA, fcB, opts) {
      return polygonOverlay(fcA, fcB, opts || {}, true);
    },

    /**
     * Symmetric difference: parts of A not in B and parts of B not in A, with nulls for the
     * other layer's fields.
     * @param {object} fcA polygons
     * @param {object} fcB polygons
     * @param {{suffix?: string}} [opts]
     * @returns {object}
     */
    symDifference(fcA, fcB, opts) {
      return polygonOverlay(fcA, fcB, opts || {}, false);
    },

    /**
     * Merge features that share the values of `fields` (all features when empty).
     * Polygons are unioned, lines collected into a MultiLineString, points into a MultiPoint
     * (mixed layers give one output per group and geometry family).
     * @param {object} fc
     * @param {{fields?: string|string[], stats?: {field: string, op: string, as?: string}[]}} [opts]
     *   op: sum | mean | min | max | count | first | last | concat | unique_count | median | std
     * @returns {object} features with the group fields, `count` and `<op>_<field>`
     */
    dissolve(fc, opts) {
      opts = opts || {};
      fc = asFC(fc);
      const fields = toArr(opts.fields).map(String);
      const agg = new Aggregator(normalizeStats(opts.stats));
      const W = new Warnings();
      const groups = new Map();
      fc.features.forEach(function (f) {
        if (!f || !f.geometry) { W.skipNull(); return; }
        const c = components(f.geometry);
        const fam = c.polys.length ? 'Polygon' : c.lines.length ? 'LineString' : c.points.length ? 'Point' : null;
        if (!fam) { W.count('empty', 'feature with empty geometry was skipped', 'features with empty geometry were skipped'); return; }
        const gk = groupKey(f.properties, fields);
        const key = gk.key + '|' + fam;
        let g = groups.get(key);
        if (!g) { g = { values: gk.values, fam: fam, count: 0, parts: [], state: agg.create() }; groups.set(key, g); }
        g.count++;
        agg.add(g.state, f.properties);
        if (fam === 'Polygon') g.parts.push(c.polys);
        else if (fam === 'LineString') c.lines.forEach(function (l) { g.parts.push(l); });
        else c.points.forEach(function (p) { g.parts.push(p); });
      });
      const out = [];
      groups.forEach(function (g) {
        let geom;
        if (g.fam === 'Polygon') {
          let polys;
          if (g.parts.length === 1) polys = g.parts[0];
          else {
            try { polys = unionMany(g.parts, W); } catch (e) { W.fail('dissolved', e); polys = [].concat.apply([], g.parts); }
          }
          geom = polysGeom(polys);
        } else if (g.fam === 'LineString') {
          geom = linesGeom(g.parts);
        } else {
          geom = pointsGeom(g.parts);
        }
        if (!geom) return;
        const props = Object.assign({}, g.values, { count: g.count }, agg.finish(g.state));
        out.push(feature(geom, props));
      });
      return result(out, W);
    },

    /**
     * Append the features of several layers.
     * @param {object[]} fcs FeatureCollections
     * @param {{names?: string[], sourceField?: string}} [opts] with `names`, each feature gets
     *   `sourceField` (default 'source_layer') set to its layer's name
     * @returns {object}
     */
    merge(fcs, opts) {
      opts = opts || {};
      if (!Array.isArray(fcs)) throw new Error('Merge needs a list of layers');
      const names = Array.isArray(opts.names) ? opts.names : null;
      const sourceField = opts.sourceField || 'source_layer';
      const out = [];
      fcs.forEach(function (fc, i) {
        fc = asFC(fc, 'Layer ' + (i + 1));
        fc.features.forEach(function (f) {
          if (!f) return;
          const p = copyProps(f);
          if (names) p[sourceField] = names[i] === undefined ? null : names[i];
          out.push(feature(f.geometry || null, p));
        });
      });
      return result(out);
    },

    /**
     * One point per feature.
     * @param {object} fc
     * @param {{method?: 'centroid'|'center_of_mass'|'point_on_surface'}} [opts]
     *   centroid (default): mean of the vertices (as turf.centroid); center_of_mass:
     *   area-weighted centroid (length-weighted for lines); point_on_surface: a point
     *   guaranteed to lie inside polygons / on lines.
     * @returns {object} points with the input properties
     */
    centroids(fc, opts) {
      opts = opts || {};
      fc = asFC(fc);
      const method = String(opts.method || 'centroid').toLowerCase().replace(/[\s-]+/g, '_');
      const fn = { centroid: vertexMean, mean: vertexMean, center_of_mass: centerOfMass, centerofmass: centerOfMass, center: centerOfMass, point_on_surface: pointOnSurface, pointonsurface: pointOnSurface, inside: pointOnSurface, interior: pointOnSurface }[method];
      if (!fn) throw new Error('Unknown centroid method "' + opts.method + '" (use ' + CENTROID_METHODS.join(', ') + ')');
      const W = new Warnings();
      const out = [];
      fc.features.forEach(function (f) {
        if (!f || !f.geometry) { W.skipNull(); return; }
        const c = components(f.geometry);
        const p = fn(c);
        if (!p || !isNum(p[0]) || !isNum(p[1])) { W.count('empty', 'feature with empty geometry was skipped', 'features with empty geometry were skipped'); return; }
        out.push(feature({ type: 'Point', coordinates: [p[0], p[1]] }, copyProps(f)));
      });
      return result(out, W);
    },

    /**
     * Convex hull of all features, or one per group.
     * @param {object} fc
     * @param {{groupBy?: string|string[]}} [opts]
     * @returns {object} polygons with the group values and `count`
     */
    convexHull(fc, opts) {
      opts = opts || {};
      fc = asFC(fc);
      const W = new Warnings();
      const out = [];
      groupPositions(fc, toArr(opts.groupBy).map(String), W).forEach(function (g) {
        const ring = hullRing(g.positions);
        if (!ring) { W.add('hull', function (n) { return n + plural(n, ' group has', ' groups have') + ' fewer than 3 distinct, non-collinear points; no hull was made'; }); return; }
        out.push(feature({ type: 'Polygon', coordinates: [ring] }, Object.assign({}, g.values, { count: g.count })));
      });
      return result(out, W);
    },

    /**
     * Concave hull (Delaunay triangles with all edges ≤ maxEdge, merged). Falls back to the
     * convex hull, with a warning, when nothing is left.
     * @param {object} fc
     * @param {{maxEdge?: number, units?: string, groupBy?: string|string[]}} [opts] maxEdge in
     *   `units` (default meters); defaults to 3 × the median triangle edge length
     * @returns {object} polygons with the group values and `count`
     */
    concaveHull(fc, opts) {
      opts = opts || {};
      fc = asFC(fc);
      let maxEdgeM = null;
      if (opts.maxEdge !== undefined && opts.maxEdge !== null) maxEdgeM = toM(requirePositive(opts.maxEdge, 'maxEdge'), opts.units);
      const W = new Warnings();
      const out = [];
      groupPositions(fc, toArr(opts.groupBy).map(String), W).forEach(function (g) {
        const props = Object.assign({}, g.values, { count: g.count });
        const seen = new Set();
        const pts = [];
        g.positions.forEach(function (p) {
          const k = p[0] + ',' + p[1];
          if (!seen.has(k)) { seen.add(k); pts.push({ type: 'Feature', properties: { __i: pts.length }, geometry: { type: 'Point', coordinates: [p[0], p[1]] } }); }
        });
        const convex = function (why) {
          const ring = hullRing(g.positions);
          if (!ring) { W.add('hull', function (n) { return n + plural(n, ' group has', ' groups have') + ' fewer than 3 distinct, non-collinear points; no hull was made'; }); return; }
          W.add('concave-fallback', function (n) { return 'Concave hull failed for ' + n + plural(n, ' group', ' groups') + '; used the convex hull instead'; }, why);
          out.push(feature({ type: 'Polygon', coordinates: [ring] }, props));
        };
        if (pts.length < 3) { convex(); return; }
        let tris;
        try { tris = T().tin({ type: 'FeatureCollection', features: pts }, '__i').features; } catch (e) { convex(e.message); return; }
        const edgeLen = function (tri) {
          const r = tri.geometry.coordinates[0];
          return [hav(r[0][0], r[0][1], r[1][0], r[1][1]), hav(r[1][0], r[1][1], r[2][0], r[2][1]), hav(r[2][0], r[2][1], r[0][0], r[0][1])];
        };
        const lens = tris.map(edgeLen);
        const limit = maxEdgeM !== null ? maxEdgeM : defaultMaxEdge(tris, lens, pts.length);
        const keep = [];
        tris.forEach(function (tri, i) {
          const l = lens[i];
          if (l[0] <= limit && l[1] <= limit && l[2] <= limit) {
            const ring = cleanRing(tri.geometry.coordinates[0]);
            if (ring) keep.push([[ring]]);
          }
        });
        if (!keep.length) { convex('no triangles are shorter than maxEdge'); return; }
        let polys;
        try { polys = unionMany(keep, W); } catch (e) { convex(e.message); return; }
        if (!polys.length) { convex(); return; }
        out.push(feature(polysGeom(polys), props));
      });
      return result(out, W);
    },

    /**
     * Bounding boxes as polygons.
     * @param {object} fc
     * @param {{perFeature?: boolean}} [opts] perFeature (default true): one box per feature with
     *   its properties; false: one box for the whole layer with `count`
     * @returns {object}
     */
    envelope(fc, opts) {
      opts = opts || {};
      fc = asFC(fc);
      const W = new Warnings();
      const boxPoly = function (b) { return { type: 'Polygon', coordinates: [[[b[0], b[1]], [b[2], b[1]], [b[2], b[3]], [b[0], b[3]], [b[0], b[1]]]] }; };
      if (opts.perFeature === false) {
        let b = null, n = 0;
        fc.features.forEach(function (f) {
          if (!f || !f.geometry) { W.skipNull(); return; }
          const fb = new Prep(f.geometry).bbox;
          if (fb) { b = util.bboxUnion(b, fb); n++; }
        });
        if (!b) return result([], W);
        if (b[2] <= b[0] || b[3] <= b[1]) { W.note('The layer extent has no area; no envelope was made'); return result([], W); }
        return result([feature(boxPoly(b), { count: n })], W);
      }
      const out = [];
      fc.features.forEach(function (f) {
        if (!f || !f.geometry) { W.skipNull(); return; }
        const b = new Prep(f.geometry).bbox;
        if (!b || b[2] <= b[0] || b[3] <= b[1]) { W.count('flat', 'feature has a zero-area extent and was skipped', 'features have a zero-area extent and were skipped'); return; }
        out.push(feature(boxPoly(b), copyProps(f)));
      });
      return result(out, W);
    },

    /**
     * Simplify lines and polygons (Douglas–Peucker, tolerance in meters). Rings that collapse
     * (< 4 positions or no area) are dropped; features that vanish are removed with a warning.
     * @param {object} fc
     * @param {{tolerance: number, units?: string, highQuality?: boolean}} opts
     * @returns {object}
     */
    simplify(fc, opts) {
      opts = opts || {};
      fc = asFC(fc);
      const tol = toM(requirePositive(opts.tolerance, 'Simplify tolerance'), opts.units);
      const hq = !!opts.highQuality;
      const W = new Warnings();
      const out = [];
      fc.features.forEach(function (f) {
        if (!f || !f.geometry) { W.skipNull(); return; }
        const g = mapParts(f.geometry, function (l) {
          const s = simplifyPath(l, tol, hq);
          return s.length >= 2 && !(s.length === 2 && samePos(s[0], s[1])) ? s : null;
        }, function (r) { return simplifyRing(r, tol, hq); });
        if (!g) { W.count('collapsed', 'feature collapsed and was removed', 'features collapsed and were removed'); return; }
        out.push(feature(g, copyProps(f)));
      });
      return result(out, W);
    },

    /**
     * Smooth lines and polygon rings with Chaikin's corner cutting (line ends are kept).
     * @param {object} fc
     * @param {{iterations?: number}} [opts] 1–10, default 3
     * @returns {object}
     */
    smooth(fc, opts) {
      opts = opts || {};
      fc = asFC(fc);
      const it = opts.iterations === undefined ? 3 : Math.round(Number(opts.iterations));
      if (!(it >= 1 && it <= 10)) throw new Error('Smooth iterations must be between 1 and 10');
      const growth = Math.pow(2, it);
      if (util.countVertices(fc) * growth > MAX_OUTPUT_VERTICES) throw new Error('Smoothing would create too many vertices; use fewer iterations or simplify first');
      const W = new Warnings();
      const out = [];
      fc.features.forEach(function (f) {
        if (!f || !f.geometry) { W.skipNull(); return; }
        const g = mapParts(f.geometry, function (l) { return chaikin(l, it, samePos(l[0], l[l.length - 1])); }, function (r) { return cleanRing(chaikin(r, it, true)); });
        if (g) out.push(feature(g, copyProps(f)));
        else W.count('empty', 'feature with empty geometry was skipped', 'features with empty geometry were skipped');
      });
      return result(out, W);
    },

    /**
     * Add vertices so that no segment is longer than `interval`.
     * @param {object} fc
     * @param {{interval: number, units?: string, geodesic?: boolean}} opts geodesic: new vertices
     *   follow great circles instead of straight lon/lat segments
     * @returns {object}
     */
    densify(fc, opts) {
      opts = opts || {};
      fc = asFC(fc);
      const iv = toM(requirePositive(opts.interval, 'Densify interval'), opts.units);
      const geo = !!opts.geodesic;
      const counter = { n: 0 };
      const W = new Warnings();
      const out = [];
      fc.features.forEach(function (f) {
        if (!f || !f.geometry) { W.skipNull(); return; }
        const g = mapParts(f.geometry, function (l) { return densifyPath(l, iv, geo, counter); }, function (r) { return densifyPath(r, iv, geo, counter); });
        if (g) out.push(feature(g, copyProps(f)));
        else W.count('empty', 'feature with empty geometry was skipped', 'features with empty geometry were skipped');
      });
      return result(out, W);
    },

    /**
     * Voronoi (Thiessen) polygons for points, with the generating point's properties.
     * @param {object} pointsFc points (MultiPoints contribute each position)
     * @param {{bbox?: number[], clipTo?: object}} [opts] bbox defaults to the points' extent + 10%;
     *   clipTo: polygon layer to clip the cells to
     * @returns {object}
     */
    voronoi(pointsFc, opts) {
      opts = opts || {};
      pointsFc = asFC(pointsFc);
      const W = new Warnings();
      const seen = new Map();
      const pts = [];
      pointsFc.features.forEach(function (f) {
        if (!f || !f.geometry) { W.skipNull(); return; }
        const c = components(f.geometry);
        if (!c.points.length) { W.count('notpoint', 'non-point feature was skipped', 'non-point features were skipped'); return; }
        c.points.forEach(function (p) {
          const k = Math.round(p[0] / 1e-6) + ',' + Math.round(p[1] / 1e-6);
          if (seen.has(k)) { W.count('dup', 'duplicate point was skipped', 'duplicate points were skipped'); return; }
          seen.set(k, true);
          pts.push({ type: 'Feature', properties: f.properties || {}, geometry: { type: 'Point', coordinates: [p[0], p[1]] }, src: f });
        });
      });
      if (!pts.length) return result([], W);
      let bbox = opts.bbox;
      if (bbox) {
        if (!Array.isArray(bbox) || bbox.length < 4 || !bbox.slice(0, 4).every(isNum) || bbox[2] <= bbox[0] || bbox[3] <= bbox[1]) throw new Error('Voronoi bbox must be [minX, minY, maxX, maxY]');
      } else {
        let b = ringBBox(pts.map(function (p) { return p.geometry.coordinates; }));
        if (opts.clipTo) b = util.bboxUnion(b, util.bbox(asFC(opts.clipTo, 'Clip layer')));
        const pad = Math.max(0.1 * Math.max(b[2] - b[0], b[3] - b[1]), 0.001);
        bbox = padBox(b, pad);
      }
      const input = { type: 'FeatureCollection', features: pts.map(function (p) { return { type: 'Feature', properties: {}, geometry: p.geometry }; }) };
      const cells = T().voronoi(input, { bbox: bbox.slice(0, 4) });
      const out = [];
      for (let i = 0; i < pts.length; i++) {
        const cell = cells.features[i];
        const ring = cell && cell.geometry ? cleanRing(cell.geometry.coordinates[0]) : null;
        if (!ring) { W.count('nocell', 'point got no Voronoi cell (outside the bbox?)', 'points got no Voronoi cell (outside the bbox?)'); continue; }
        out.push(feature({ type: 'Polygon', coordinates: rewindPolys([[ring]])[0] }, copyProps(pts[i].src)));
      }
      let res = result(out, W);
      if (opts.clipTo) {
        const clipped = geoops.clip(res, opts.clipTo);
        const warnings = (res.warnings || []).concat(clipped.warnings || []);
        res = { type: 'FeatureCollection', features: clipped.features };
        if (warnings.length) res.warnings = warnings;
      }
      return res;
    },

    /**
     * Delaunay triangulation of points.
     * @param {object} pointsFc
     * @returns {object} triangles with `a`, `b`, `c` = indices of their vertices in pointsFc.features
     */
    delaunay(pointsFc) {
      pointsFc = asFC(pointsFc);
      const W = new Warnings();
      const seen = new Map();
      const pts = [];
      pointsFc.features.forEach(function (f, i) {
        if (!f || !f.geometry) { W.skipNull(); return; }
        const c = components(f.geometry);
        if (!c.points.length) { W.count('notpoint', 'non-point feature was skipped', 'non-point features were skipped'); return; }
        c.points.forEach(function (p) {
          const k = p[0] + ',' + p[1];
          if (seen.has(k)) { W.count('dup', 'duplicate point was skipped', 'duplicate points were skipped'); return; }
          seen.set(k, i);
          pts.push({ type: 'Feature', properties: { __i: i }, geometry: { type: 'Point', coordinates: [p[0], p[1]] } });
        });
      });
      if (pts.length < 3) { if (pointsFc.features.length) W.note('Delaunay triangulation needs at least 3 distinct points'); return result([], W); }
      const tris = T().tin({ type: 'FeatureCollection', features: pts }, '__i');
      const out = [];
      tris.features.forEach(function (t) {
        const ring = cleanRing(t.geometry.coordinates[0]);
        if (!ring) return;
        out.push(feature({ type: 'Polygon', coordinates: rewindPolys([[ring]])[0] }, { a: t.properties.a, b: t.properties.b, c: t.properties.c }));
      });
      return result(out, W);
    },

    /**
     * Split multipart features into single parts; adds `part` (0-based).
     * @param {object} fc
     * @returns {object}
     */
    explode(fc) {
      fc = asFC(fc);
      const W = new Warnings();
      const out = [];
      const partsOf = function (g, acc) {
        const c = g && g.coordinates;
        switch (g && g.type) {
          case 'Point': if (isPos(c)) acc.push({ type: 'Point', coordinates: c }); break;
          case 'MultiPoint': (c || []).forEach(function (p) { if (isPos(p)) acc.push({ type: 'Point', coordinates: p }); }); break;
          case 'LineString': { const l = cleanLine(c); if (l) acc.push({ type: 'LineString', coordinates: l }); break; }
          case 'MultiLineString': (c || []).forEach(function (x) { const l = cleanLine(x); if (l) acc.push({ type: 'LineString', coordinates: l }); }); break;
          case 'Polygon': { const p = cleanPolygon(c); if (p) acc.push({ type: 'Polygon', coordinates: p }); break; }
          case 'MultiPolygon': (c || []).forEach(function (x) { const p = cleanPolygon(x); if (p) acc.push({ type: 'Polygon', coordinates: p }); }); break;
          case 'GeometryCollection': (g.geometries || []).forEach(function (x) { partsOf(x, acc); }); break;
          default: break;
        }
        return acc;
      };
      fc.features.forEach(function (f) {
        if (!f || !f.geometry) { W.skipNull(); return; }
        const parts = partsOf(f.geometry, []);
        if (!parts.length) { W.count('empty', 'feature with empty geometry was skipped', 'features with empty geometry were skipped'); return; }
        parts.forEach(function (g, i) { const p = copyProps(f); p.part = i; out.push(feature(g, p)); });
      });
      return result(out, W);
    },

    /**
     * Polygon rings as lines (LineString for a single ring, MultiLineString otherwise).
     * @param {object} fc
     * @returns {object}
     */
    polygonsToLines(fc) {
      fc = asFC(fc);
      const W = new Warnings();
      const out = [];
      fc.features.forEach(function (f) {
        if (!f || !f.geometry) { W.skipNull(); return; }
        const c = components(f.geometry);
        if (!c.polys.length) { W.count('notpoly', 'non-polygon feature was skipped', 'non-polygon features were skipped'); return; }
        const lines = [];
        c.polys.forEach(function (rings) { rings.forEach(function (r) { lines.push(r); }); });
        out.push(feature(linesGeom(lines), copyProps(f)));
      });
      return result(out, W);
    },

    /**
     * Close lines into polygons. Parts of a MultiLineString nested inside other parts become holes.
     * @param {object} fc
     * @returns {object}
     */
    linesToPolygons(fc) {
      fc = asFC(fc);
      const W = new Warnings();
      const out = [];
      fc.features.forEach(function (f) {
        if (!f || !f.geometry) { W.skipNull(); return; }
        const c = components(f.geometry);
        if (!c.lines.length) { W.count('notline', 'non-line feature was skipped', 'non-line features were skipped'); return; }
        const rings = c.lines.map(cleanRing).filter(Boolean);
        if (!rings.length) { W.count('short', 'line was too short to make a polygon', 'lines were too short to make polygons'); return; }
        const ordered = rings.map(function (r) { return { r: r, a: Math.abs(ringArea(r)), depth: 0, owner: -1 }; }).sort(function (x, y) { return y.a - x.a; });
        const polys = [];
        ordered.forEach(function (e, i) {
          let container = -1;
          for (let j = i - 1; j >= 0; j--) {
            const o = ordered[j];
            let v = 0;
            for (let k = 0; k < e.r.length - 1 && v === 0; k++) v = pipRing(e.r[k][0], e.r[k][1], o.r);
            if (v === 1) { container = j; break; }
          }
          if (container >= 0 && ordered[container].depth % 2 === 0) {
            e.depth = ordered[container].depth + 1;
            polys[ordered[container].owner].push(e.r);
          } else {
            e.depth = container >= 0 ? ordered[container].depth + 1 : 0;
            e.owner = polys.length;
            polys.push([e.r]);
          }
        });
        out.push(feature(polysGeom(rewindPolys(polys)), copyProps(f)));
      });
      return result(out, W);
    },

    /**
     * Every vertex as a point, with `vertex_index` (within the feature), `part` and, for
     * polygons, `ring`. Ring closing positions are not repeated.
     * @param {object} fc
     * @returns {object}
     */
    extractVertices(fc) {
      fc = asFC(fc);
      const W = new Warnings();
      const out = [];
      fc.features.forEach(function (f) {
        if (!f || !f.geometry) { W.skipNull(); return; }
        const c = components(f.geometry);
        let vi = 0;
        const emit = function (pos, part, ring) {
          const p = copyProps(f);
          p.vertex_index = vi++;
          p.part = part;
          if (ring !== undefined) p.ring = ring;
          out.push(feature({ type: 'Point', coordinates: pos }, p));
        };
        c.points.forEach(function (pos, i) { emit(pos, i); });
        c.lines.forEach(function (l, i) { l.forEach(function (pos) { emit(pos, i); }); });
        c.polys.forEach(function (rings, i) { rings.forEach(function (r, ri) { for (let k = 0; k < r.length - 1; k++) emit(r[k], i, ri); }); });
        if (!vi) W.count('empty', 'feature with empty geometry was skipped', 'features with empty geometry were skipped');
      });
      return result(out, W);
    },

    /**
     * Points every `interval` along lines (and polygon boundaries); adds `distance` along the
     * part (in `units`) and `part`.
     * @param {object} fc
     * @param {{interval: number, units?: string, includeEnds?: boolean}} opts
     * @returns {object}
     */
    pointsAlongLines(fc, opts) {
      opts = opts || {};
      fc = asFC(fc);
      const units = linUnit(opts.units);
      const iv = util.toMeters(requirePositive(opts.interval, 'Interval'), units);
      const ends = opts.includeEnds !== false;
      const W = new Warnings();
      const out = [];
      let total = 0;
      fc.features.forEach(function (f) {
        if (!f || !f.geometry) { W.skipNull(); return; }
        const paths = featurePaths(f.geometry);
        if (!paths.length) { W.count('notline', 'feature without lines was skipped', 'features without lines were skipped'); return; }
        paths.forEach(function (path, part) {
          const segs = [];
          let L = 0;
          for (let i = 0; i < path.length - 1; i++) { const d = hav(path[i][0], path[i][1], path[i + 1][0], path[i + 1][1]); segs.push(d); L += d; }
          const ds = [];
          if (ends) ds.push(0);
          for (let k = 1; k * iv < L - 1e-9; k++) ds.push(k * iv);
          if (ends && L > 0 && !samePos(path[0], path[path.length - 1])) ds.push(L); // closed rings: the end is the start
          total += ds.length;
          if (total > MAX_OUTPUT_VERTICES) throw new Error('That would create more than ' + MAX_OUTPUT_VERTICES.toLocaleString('en-US') + ' points; use a larger interval');
          let si = 0, acc = 0;
          ds.forEach(function (d) {
            while (si < segs.length - 1 && acc + segs[si] < d) { acc += segs[si]; si++; }
            const t = segs[si] > 0 ? clamp01((d - acc) / segs[si]) : 0;
            const pos = t === 0 ? path[si] : t === 1 ? path[si + 1] : lerpPos(path[si], path[si + 1], t);
            const p = copyProps(f);
            p.distance = util.fromMeters(d, units);
            p.part = part;
            out.push(feature({ type: 'Point', coordinates: pos }, p));
          });
        });
      });
      return result(out, W);
    },

    /**
     * Points where lines (or polygon boundaries) of A cross or touch lines of B — or of other
     * features of A when fcB is omitted. Points carry the properties of both features.
     * @param {object} fcA
     * @param {object} [fcB]
     * @param {{suffix?: string}} [opts]
     * @returns {object}
     */
    lineIntersections(fcA, fcB, opts) {
      if (fcB && fcB.type !== 'FeatureCollection' && !Array.isArray(fcB) && fcB.type === undefined) { opts = fcB; fcB = null; }
      opts = opts || {};
      fcA = asFC(fcA, 'First layer');
      const self = !fcB || fcB === fcA;
      fcB = self ? fcA : asFC(fcB, 'Second layer');
      const map = fieldMap(layerKeys(fcA), layerKeys(fcB), '', opts.suffix || '_2');
      const tree = segmentLayer(fcB);
      const W = new Warnings();
      const out = [];
      const ss = {};
      fcA.features.forEach(function (f, i) {
        if (!f || !f.geometry) { W.skipNull(); return; }
        const seen = new Set();
        featurePaths(f.geometry).forEach(function (path) {
          for (let s = 0; s < path.length - 1; s++) {
            const a = path[s], b = path[s + 1];
            const found = tree.search({ minX: Math.min(a[0], b[0]) - EPS, minY: Math.min(a[1], b[1]) - EPS, maxX: Math.max(a[0], b[0]) + EPS, maxY: Math.max(a[1], b[1]) + EPS });
            found.sort(function (x, y) { return x.f - y.f; });
            found.forEach(function (it) {
              if (self && it.f <= i) return;
              const n = segSeg(a[0], a[1], b[0], b[1], it.a[0], it.a[1], it.b[0], it.b[1], ss);
              if (!n) return;
              const ts = n === 2 ? [ss.t0, ss.t1] : [ss.t0];
              ts.forEach(function (t) {
                const pos = t === 0 ? a : t === 1 ? b : lerpPos(a, b, t);
                const key = it.f + ':' + Math.round(pos[0] * 1e9) + ',' + Math.round(pos[1] * 1e9);
                if (seen.has(key)) return;
                seen.add(key);
                out.push(feature({ type: 'Point', coordinates: [pos[0], pos[1]] }, applyMap(copyProps(f), fcB.features[it.f].properties, map)));
              });
            });
          }
        });
      });
      return result(out, W);
    },

    /**
     * Split lines where they meet splitter lines, polygon boundaries or points. Each piece becomes
     * a LineString feature with the line's properties. Without splitterFc, lines are split where
     * they meet each other.
     * @param {object} linesFc
     * @param {object} [splitterFc]
     * @returns {object}
     */
    splitLines(linesFc, splitterFc) {
      linesFc = asFC(linesFc, 'Line layer');
      const self = !splitterFc || splitterFc === linesFc;
      splitterFc = self ? linesFc : asFC(splitterFc, 'Splitter layer');
      const tree = segmentLayer(splitterFc);
      const ptItems = [];
      splitterFc.features.forEach(function (f, fi) {
        if (!f || !f.geometry) return;
        components(f.geometry).points.forEach(function (p) { ptItems.push({ minX: p[0], minY: p[1], maxX: p[0], maxY: p[1], p: p, f: fi }); });
      });
      const ptTree = newTree();
      ptTree.load(ptItems);
      const W = new Warnings();
      const out = [];
      const ss = {};
      linesFc.features.forEach(function (f, i) {
        if (!f || !f.geometry) { W.skipNull(); return; }
        const c = components(f.geometry);
        if (!c.lines.length) { W.count('notline', 'non-line feature was skipped', 'non-line features were skipped'); return; }
        c.lines.forEach(function (line) {
          let cur = [line[0]];
          const flush = function () {
            const l = cleanLine(cur);
            if (l && pathLengthM(l) > 0) out.push(feature({ type: 'LineString', coordinates: l }, copyProps(f)));
          };
          for (let s = 0; s < line.length - 1; s++) {
            const a = line[s], b = line[s + 1];
            const box = { minX: Math.min(a[0], b[0]) - EPS, minY: Math.min(a[1], b[1]) - EPS, maxX: Math.max(a[0], b[0]) + EPS, maxY: Math.max(a[1], b[1]) + EPS };
            const ts = [];
            tree.search(box).forEach(function (it) {
              if (self && it.f === i) return;
              const n = segSeg(a[0], a[1], b[0], b[1], it.a[0], it.a[1], it.b[0], it.b[1], ss);
              if (n >= 1) ts.push(ss.t0);
              if (n === 2) ts.push(ss.t1);
            });
            ptTree.search(box).forEach(function (it) {
              if (self && it.f === i) return;
              if (distSeg(it.p[0], it.p[1], a[0], a[1], b[0], b[1]) <= 1e-9) {
                const dx = b[0] - a[0], dy = b[1] - a[1];
                ts.push(clamp01(((it.p[0] - a[0]) * dx + (it.p[1] - a[1]) * dy) / (dx * dx + dy * dy)));
              }
            });
            ts.sort(numAsc);
            let last = 0;
            ts.forEach(function (t) {
              if (t - last <= 1e-12) return;
              if (t >= 1 - 1e-12) { last = 1; cur.push(b); flush(); cur = [b]; return; }
              const pos = lerpPos(a, b, t);
              cur.push(pos);
              flush();
              cur = [pos];
              last = t;
            });
            if (last < 1) cur.push(b);
          }
          flush();
        });
      });
      return result(out, W);
    },

    /**
     * Attach attributes of joinFc to targetFc by location ("target PREDICATE join").
     * @param {object} targetFc
     * @param {object} joinFc
     * @param {object} [opts]
     * @param {string} [opts.predicate] intersects (default) | within | contains | touches | crosses | overlaps | within_distance
     * @param {number} [opts.distance] for within_distance, in `units` (default meters)
     * @param {string} [opts.mode] summary (default): one row per target with `countField` and stats;
     *   first: one row per target with the first match's fields (null if none);
     *   all: one row per (target, match) pair, unmatched targets kept with nulls
     * @param {string[]} [opts.fields] join fields to copy (first/all; default all)
     * @param {{field: string, op: string}[]} [opts.stats] summary statistics
     * @param {string} [opts.countField] default 'count'
     * @param {string} [opts.prefix] prefix for joined fields and stats (default '')
     * @returns {object}
     */
    spatialJoin(targetFc, joinFc, opts) {
      opts = opts || {};
      targetFc = asFC(targetFc, 'Target layer');
      joinFc = asFC(joinFc, 'Join layer');
      const pred = normPredicate(opts.predicate);
      if (pred === 'disjoint') throw new Error('Spatial join does not support "disjoint"; use selectByLocation instead');
      const meters = predicateDistance(pred, opts);
      const mode = String(opts.mode || 'summary').toLowerCase();
      if (['summary', 'first', 'all'].indexOf(mode) < 0) throw new Error('Spatial join mode must be summary, first or all');
      const prefix = opts.prefix || '';
      const countField = opts.countField || 'count';
      const agg = new Aggregator(normalizeStats(opts.stats));
      const joinKeys = opts.fields ? toArr(opts.fields).map(String) : layerKeys(joinFc);
      const map = fieldMap(layerKeys(targetFc), joinKeys, prefix, '_2');
      const L = new Layer(joinFc);
      const W = new Warnings();
      const out = [];
      targetFc.features.forEach(function (f) {
        if (!f) return;
        const matches = [];
        const T0 = f.geometry ? new Prep(f.geometry) : null;
        if (T0 && !T0.isEmpty()) {
          const cands = L.search(searchBox(T0, pred, meters));
          for (let k = 0; k < cands.length; k++) {
            const J = L.prep(cands[k]);
            if (!J) continue;
            let ok = false;
            try { ok = relate(T0, J, pred, meters); } catch (e) { W.fail('compared', e); }
            if (ok) {
              matches.push(cands[k]);
              if (mode === 'first') break;
            }
          }
        }
        if (mode === 'summary') {
          const st = agg.create();
          matches.forEach(function (j) { agg.add(st, joinFc.features[j].properties); });
          const p = copyProps(f);
          p[countField] = matches.length;
          Object.assign(p, agg.finish(st, prefix));
          out.push(feature(f.geometry || null, p));
        } else if (mode === 'first') {
          out.push(feature(f.geometry || null, applyMap(copyProps(f), matches.length ? joinFc.features[matches[0]].properties : null, map)));
        } else if (!matches.length) {
          out.push(feature(f.geometry || null, applyMap(copyProps(f), null, map)));
        } else {
          matches.forEach(function (j) { out.push(feature(f.geometry || null, applyMap(copyProps(f), joinFc.features[j].properties, map))); });
        }
      });
      return result(out, W);
    },

    /**
     * Count points (features) inside each polygon, boundary included.
     * @param {object} polygonsFc
     * @param {object} pointsFc
     * @param {{field?: string, weightField?: string}} [opts] with weightField the count field
     *   holds the sum of that field over the points instead
     * @returns {object} polygons with `field` (default 'count'); non-polygons get null
     */
    countPointsInPolygons(polygonsFc, pointsFc, opts) {
      opts = opts || {};
      polygonsFc = asFC(polygonsFc, 'Polygon layer');
      pointsFc = asFC(pointsFc, 'Point layer');
      const field = opts.field || 'count';
      const wf = opts.weightField;
      const items = [];
      pointsFc.features.forEach(function (f, i) {
        if (!f || !f.geometry) return;
        components(f.geometry).points.forEach(function (p) { items.push({ minX: p[0], minY: p[1], maxX: p[0], maxY: p[1], p: p, i: i }); });
      });
      const tree = newTree();
      tree.load(items);
      const W = new Warnings();
      const out = [];
      polygonsFc.features.forEach(function (f) {
        if (!f) return;
        const p = copyProps(f);
        const P = f.geometry ? new Prep(f.geometry) : null;
        if (!P || !P.polys.length) {
          p[field] = null;
          if (f.geometry) W.count('notpoly', 'non-polygon feature got no count', 'non-polygon features got no count');
          out.push(feature(f.geometry || null, p));
          return;
        }
        const hits = new Set();
        tree.search(rbox(padBox(P.bbox, EPS))).forEach(function (it) {
          if (!hits.has(it.i) && P.pip(it.p[0], it.p[1]) >= 0) hits.add(it.i);
        });
        if (wf) {
          let s = 0;
          hits.forEach(function (i) { const v = toNumber((pointsFc.features[i].properties || {})[wf]); if (isFinite(v)) s += v; });
          p[field] = s;
        } else {
          p[field] = hits.size;
        }
        out.push(feature(f.geometry, p));
      });
      return result(out, W);
    },

    /**
     * Nearest feature of fcB for every feature of fcA (lines/polygons of A use a representative
     * point; distance to B lines/polygons is to their boundary, 0 inside a polygon). When fcA
     * and fcB are the same object a feature never matches itself.
     * @param {object} fcA
     * @param {object} fcB
     * @param {{fields?: string[], prefix?: string, units?: string, maxDistance?: number}} [opts]
     *   fields: B fields to copy (default all); adds `<prefix>distance` (in units) and `<prefix>index`
     * @returns {object}
     */
    nearest(fcA, fcB, opts) {
      opts = opts || {};
      fcA = asFC(fcA, 'First layer');
      const self = fcB === fcA;
      fcB = self ? fcA : asFC(fcB, 'Nearest layer');
      const prefix = opts.prefix === undefined || opts.prefix === null ? 'nearest_' : String(opts.prefix);
      const units = linUnit(opts.units);
      let limit = Infinity;
      if (opts.maxDistance !== undefined && opts.maxDistance !== null) {
        if (!isNum(opts.maxDistance) || opts.maxDistance < 0) throw new Error('maxDistance must be a number (0 or more)');
        limit = util.toMeters(opts.maxDistance, units);
      }
      const L = new Layer(fcB);
      if (!L.size()) throw new Error('Nearest layer has no features with geometry');
      const fields = opts.fields ? toArr(opts.fields).map(String) : layerKeys(fcB);
      const map = fields.map(function (k) { return [k, prefix + k]; });
      const distF = prefix + 'distance', idxF = prefix + 'index';
      // Best-first search over the bbox index of B (exact; ties go to the lowest index).
      const search = function (x, y, selfIdx, best) {
        treeNearest(L.tree, x, y, function (item, bound) {
          const j = item.i;
          if (j === selfIdx) return Infinity;
          const P = L.prep(j);
          if (!P) return Infinity;
          const d = distToPrep(x, y, P, bound);
          if (d < best.d || (d === best.d && j < best.j)) { best.d = d; best.j = j; }
          return d;
        }, Math.min(best.d, limit));
      };
      const W = new Warnings();
      const out = [];
      fcA.features.forEach(function (f, i) {
        if (!f) return;
        const p = copyProps(f);
        const best = { d: Infinity, j: -1 };
        if (f.geometry) {
          const c = components(f.geometry);
          const pts = c.polys.length || c.lines.length ? [pointOnSurface(c)].filter(Boolean) : c.points;
          pts.forEach(function (pt) { search(pt[0], pt[1], self ? i : -1, best); });
        }
        if (best.j >= 0 && best.d <= limit) {
          p[distF] = util.fromMeters(best.d, units);
          p[idxF] = best.j;
          applyMap(p, fcB.features[best.j].properties, map);
        } else {
          p[distF] = null;
          p[idxF] = null;
          applyMap(p, null, map);
        }
        out.push(feature(f.geometry || null, p));
      });
      return result(out, W);
    },

    /**
     * Indices of fc.features that satisfy "feature PREDICATE any feature of otherFc"
     * (for disjoint: that intersect none of them).
     * @param {object} fc
     * @param {object} otherFc
     * @param {{predicate?: string, distance?: number, units?: string}} [opts]
     * @returns {number[]} ascending indices
     */
    selectByLocation(fc, otherFc, opts) {
      opts = opts || {};
      fc = asFC(fc);
      otherFc = asFC(otherFc, 'Selecting layer');
      const pred = normPredicate(opts.predicate);
      const meters = predicateDistance(pred, opts);
      const L = new Layer(otherFc);
      const test = pred === 'disjoint' ? 'intersects' : pred;
      const out = [];
      fc.features.forEach(function (f, i) {
        if (!f || !f.geometry) return;
        const P = new Prep(f.geometry);
        if (P.isEmpty()) return;
        const cands = L.search(searchBox(P, test, meters));
        let hit = false;
        for (let k = 0; k < cands.length && !hit; k++) {
          const O = L.prep(cands[k]);
          if (O && relate(P, O, test, meters)) hit = true;
        }
        if (hit !== (pred === 'disjoint')) out.push(i);
      });
      return out;
    },

    /**
     * Regular grid covering a bbox.
     * @param {number[]|object} bbox [minX, minY, maxX, maxY] or a layer/feature whose extent to use
     * @param {number} cellSize cell width (square/triangle/point) or hexagon side, in `units`
     * @param {{type?: 'square'|'hex'|'triangle'|'point', units?: string, mask?: object}} [opts]
     *   mask: polygon layer; only cells that intersect it are kept
     * @returns {object} cells with `row` and `col`
     */
    grid(bbox, cellSize, opts) {
      opts = opts || {};
      const rawType = String(opts.type || 'square').toLowerCase().trim();
      const type = GRID_TYPE_ALIASES[rawType] || rawType;
      if (GRID_TYPES.indexOf(type) < 0) throw new Error('Unknown grid type "' + opts.type + '" (use ' + GRID_TYPES.join(', ') + ')');
      let mask = null;
      if (opts.mask) mask = polygonLayer(asFC(opts.mask, 'Mask layer'), 'Mask layer has no polygons');
      let b = bbox;
      if (b && !Array.isArray(b)) b = util.bbox(b);
      if (!b && mask) b = util.bbox(mask.fc);
      if (!Array.isArray(b) || b.length < 4 || !b.slice(0, 4).every(isNum)) throw new Error('Grid needs an extent [minX, minY, maxX, maxY]');
      b = [Math.min(b[0], b[2]), Math.min(b[1], b[3]), Math.max(b[0], b[2]), Math.max(b[1], b[3])];
      if (b[2] - b[0] <= 0 || b[3] - b[1] <= 0) throw new Error('Grid extent has no area');
      const size = toM(requirePositive(cellSize, 'Cell size'), opts.units);
      const midLat = (b[1] + b[3]) / 2;
      const mLon = M_PER_DEG * Math.max(Math.cos(midLat * RAD), 1e-6);
      let est, nx, ny, dx, dy, sx, sy, hh;
      if (type === 'hex') {
        sx = size / mLon; sy = size / M_PER_DEG; hh = Math.sqrt(3) * sy;
        nx = Math.ceil((b[2] - b[0]) / (1.5 * sx)) + 2;
        ny = Math.ceil((b[3] - b[1]) / hh) + 2;
        est = nx * ny;
      } else {
        dx = size / mLon; dy = size / M_PER_DEG;
        nx = Math.max(1, Math.ceil((b[2] - b[0]) / dx - 1e-9));
        ny = Math.max(1, Math.ceil((b[3] - b[1]) / dy - 1e-9));
        est = nx * ny * (type === 'triangle' ? 2 : 1);
      }
      if (!isFinite(est) || est > MAX_GRID_CELLS) {
        throw new Error('That grid would have about ' + (isFinite(est) ? Math.round(est).toLocaleString('en-US') : 'infinitely many') + ' cells (the limit is ' + MAX_GRID_CELLS.toLocaleString('en-US') + '); use a larger cell size or a smaller area');
      }
      const keepCell = function (geom) {
        if (!mask) return true;
        const P = new Prep(geom);
        const cands = mask.search(padBox(P.bbox, EPS));
        for (let k = 0; k < cands.length; k++) { const C = mask.prep(cands[k]); if (C && intersects(P, C)) return true; }
        return false;
      };
      const out = [];
      const push = function (geom, row, col) { if (keepCell(geom)) out.push(feature(geom, { row: row, col: col })); };
      if (type === 'hex') {
        const ang = [0, 60, 120, 180, 240, 300].map(function (a) { return [Math.cos(a * RAD), Math.sin(a * RAD)]; });
        for (let c = -1; c < nx; c++) {
          const cx = b[0] + c * 1.5 * sx;
          if (cx - sx > b[2] || cx + sx < b[0]) continue;
          for (let r = -1; r < ny; r++) {
            const cy = b[3] - r * hh - (((c % 2) + 2) % 2 === 1 ? hh / 2 : 0);
            if (cy - hh / 2 > b[3] || cy + hh / 2 < b[1]) continue;
            const ring = ang.map(function (a) { return [cx + sx * a[0], cy + sy * a[1]]; });
            ring.push(ring[0].slice());
            push({ type: 'Polygon', coordinates: [ring] }, r + 1, c + 1);
          }
        }
      } else {
        for (let r = 0; r < ny; r++) {
          const y1 = b[3] - r * dy, y0 = b[3] - (r + 1) * dy;
          for (let c = 0; c < nx; c++) {
            const x0 = b[0] + c * dx, x1 = b[0] + (c + 1) * dx;
            if (type === 'point') {
              push({ type: 'Point', coordinates: [(x0 + x1) / 2, (y0 + y1) / 2] }, r, c);
            } else if (type === 'square') {
              push({ type: 'Polygon', coordinates: [[[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]]] }, r, c);
            } else if ((r + c) % 2 === 0) {
              push({ type: 'Polygon', coordinates: [[[x0, y0], [x1, y0], [x0, y1], [x0, y0]]] }, r, 2 * c);
              push({ type: 'Polygon', coordinates: [[[x1, y0], [x1, y1], [x0, y1], [x1, y0]]] }, r, 2 * c + 1);
            } else {
              push({ type: 'Polygon', coordinates: [[[x0, y0], [x1, y0], [x1, y1], [x0, y0]]] }, r, 2 * c);
              push({ type: 'Polygon', coordinates: [[[x0, y0], [x1, y1], [x0, y1], [x0, y0]]] }, r, 2 * c + 1);
            }
          }
        }
      }
      return result(out);
    },

    /**
     * Random points (area-uniform) in a bbox or inside polygons.
     * @param {number} count
     * @param {{bbox?: number[], within?: object, seed?: number|string}} [opts] with `within`
     *   points are placed inside its polygons (rejection sampling); seed makes it repeatable
     * @returns {object} points with an empty properties object
     */
    randomPoints(count, opts) {
      opts = opts || {};
      const n = Number(count);
      if (!isNum(n) || n < 0 || Math.floor(n) !== n) throw new Error('Point count must be a whole number (0 or more)');
      if (n > 1000000) throw new Error('At most 1,000,000 random points can be made at once');
      const rand = mulberry32(seedOf(opts.seed));
      const W = new Warnings();
      const out = [];
      let box = null;
      if (opts.bbox) {
        const bb = opts.bbox;
        if (!Array.isArray(bb) || bb.length < 4 || !bb.slice(0, 4).every(isNum) || bb[2] < bb[0] || bb[3] < bb[1]) throw new Error('Random points bbox must be [minX, minY, maxX, maxY]');
        box = bb.slice(0, 4);
      }
      if (opts.within) {
        const L = polygonLayer(asFC(opts.within, 'Polygon layer'), 'Layer to place random points in has no polygons');
        const parts = [];
        L.items.forEach(function (it) {
          L.prep(it.i).polys.forEach(function (rings) {
            let pb = ringBBox(rings[0]);
            if (box) { if (!boxesIntersect(pb, box)) return; pb = interBox(pb, box); }
            const a = geodesicArea([rings]);
            if (a > 0) parts.push({ rings: rings, box: pb, a: a, prep: null });
          });
        });
        if (!parts.length) throw new Error('No polygon area to place random points in');
        const cum = [];
        let tot = 0;
        parts.forEach(function (p) { tot += p.a; cum.push(tot); });
        let failed = 0;
        for (let k = 0; k < n; k++) {
          const u = rand() * tot;
          let lo = 0, hi = cum.length - 1;
          while (lo < hi) { const mid = (lo + hi) >> 1; if (cum[mid] < u) lo = mid + 1; else hi = mid; }
          const part = parts[lo];
          if (!part.prep) part.prep = new Prep({ type: 'Polygon', coordinates: part.rings });
          let pos = null;
          for (let t = 0; t < 1000 && !pos; t++) {
            const c = randomInBox(rand, part.box);
            if (part.prep.pip(c[0], c[1]) === 1) pos = c;
          }
          if (pos) out.push(feature({ type: 'Point', coordinates: pos }, {}));
          else failed++;
        }
        if (failed) W.note(failed + plural(failed, ' point', ' points') + ' could not be placed inside the polygons');
      } else if (box) {
        for (let k = 0; k < n; k++) out.push(feature({ type: 'Point', coordinates: randomInBox(rand, box) }, {}));
      } else {
        throw new Error('Random points need a bbox or a polygon layer to place them in');
      }
      return result(out, W);
    },

    /**
     * K-means clustering of point locations (k-means++ start, seeded).
     * @param {object} pointsFc (other geometries use a representative point)
     * @param {{k?: number, field?: string, seed?: number|string}} [opts] k default 5
     * @returns {object} features with `field` (default 'cluster', 0-based; null without geometry)
     */
    kmeans(pointsFc, opts) {
      opts = opts || {};
      pointsFc = asFC(pointsFc);
      let k = opts.k === undefined ? 5 : Number(opts.k);
      if (!isNum(k) || k < 1 || Math.floor(k) !== k) throw new Error('k must be a whole number of at least 1');
      const field = opts.field || 'cluster';
      const rand = mulberry32(seedOf(opts.seed === undefined ? 1 : opts.seed));
      const W = new Warnings();
      const pos = pointsFc.features.map(function (f) {
        if (!f || !f.geometry) return null;
        const c = components(f.geometry);
        return c.points.length === 1 && !c.lines.length && !c.polys.length ? c.points[0] : (c.points.length && !c.lines.length && !c.polys.length ? vertexMean(c) : pointOnSurface(c));
      });
      const idx = [];
      pos.forEach(function (p, i) { if (p) idx.push(i); });
      const labels = new Array(pos.length).fill(null);
      if (idx.length) {
        let sumLat = 0;
        idx.forEach(function (i) { sumLat += pos[i][1]; });
        const kx = Math.cos((sumLat / idx.length) * RAD);
        const xs = idx.map(function (i) { return pos[i][0] * kx; }), ys = idx.map(function (i) { return pos[i][1]; });
        const distinct = new Set(idx.map(function (i) { return pos[i][0] + ',' + pos[i][1]; })).size;
        if (k > distinct) { W.note('Only ' + distinct + plural(distinct, ' distinct location', ' distinct locations') + '; k was reduced to ' + distinct); k = distinct; }
        // Several k-means++ starts; keep the lowest within-cluster sum of squares.
        const starts = Math.max(1, Math.min(10, Math.floor(2e6 / (idx.length * k))));
        let lab = null, bestSse = Infinity;
        for (let s = 0; s < starts; s++) {
          const r = kmeansCore(xs, ys, k, rand);
          if (r.sse < bestSse - 1e-15) { bestSse = r.sse; lab = r.labels; }
        }
        const remap = new Map();
        for (let t = 0; t < idx.length; t++) {
          if (!remap.has(lab[t])) remap.set(lab[t], remap.size);
          labels[idx[t]] = remap.get(lab[t]);
        }
      }
      const out = [];
      pointsFc.features.forEach(function (f, i) {
        if (!f) return;
        const p = copyProps(f);
        p[field] = labels[i];
        out.push(feature(f.geometry || null, p));
      });
      return result(out, W);
    },

    /**
     * DBSCAN density clustering.
     * @param {object} pointsFc
     * @param {{distance: number, units?: string, minPoints?: number, field?: string}} opts
     *   minPoints (default 3) counts the point itself
     * @returns {object} features with `field` (cluster id, null for noise) and
     *   `dbscan` ('core' | 'edge' | 'noise')
     */
    dbscan(pointsFc, opts) {
      opts = opts || {};
      pointsFc = asFC(pointsFc);
      const eps = toM(requirePositive(opts.distance, 'DBSCAN distance'), opts.units);
      const minPts = opts.minPoints === undefined ? 3 : Number(opts.minPoints);
      if (!isNum(minPts) || minPts < 1) throw new Error('minPoints must be at least 1');
      const field = opts.field || 'cluster';
      const n = pointsFc.features.length;
      const pos = pointsFc.features.map(function (f) {
        if (!f || !f.geometry) return null;
        const c = components(f.geometry);
        return c.points.length && !c.lines.length && !c.polys.length ? (c.points.length === 1 ? c.points[0] : vertexMean(c)) : pointOnSurface(c);
      });
      const items = [];
      pos.forEach(function (p, i) { if (p) items.push({ minX: p[0], minY: p[1], maxX: p[0], maxY: p[1], i: i }); });
      const tree = newTree();
      tree.load(items);
      const neighbors = function (i) {
        const p = pos[i];
        return tree.search(rbox(expandBox([p[0], p[1], p[0], p[1]], eps))).filter(function (it) {
          return hav(p[0], p[1], pos[it.i][0], pos[it.i][1]) <= eps;
        }).map(function (it) { return it.i; });
      };
      const label = new Int32Array(n).fill(-2); // -2 unvisited, -1 noise
      const kind = new Array(n).fill(null);
      let cluster = 0;
      for (let i = 0; i < n; i++) {
        if (!pos[i] || label[i] !== -2) continue;
        const nb = neighbors(i);
        if (nb.length < minPts) { label[i] = -1; kind[i] = 'noise'; continue; }
        const cid = cluster++;
        label[i] = cid; kind[i] = 'core';
        const queue = nb.filter(function (j) { return j !== i; });
        const queued = new Set(queue);
        for (let q = 0; q < queue.length; q++) {
          const j = queue[q];
          if (label[j] === -1) { label[j] = cid; kind[j] = 'edge'; }
          if (label[j] !== -2) continue;
          label[j] = cid;
          const nj = neighbors(j);
          if (nj.length >= minPts) {
            kind[j] = 'core';
            nj.forEach(function (m) { if (!queued.has(m) && m !== i) { queued.add(m); queue.push(m); } });
          } else {
            kind[j] = 'edge';
          }
        }
      }
      const out = [];
      pointsFc.features.forEach(function (f, i) {
        if (!f) return;
        const p = copyProps(f);
        p[field] = pos[i] && label[i] >= 0 ? label[i] : null;
        p.dbscan = pos[i] ? kind[i] : null;
        out.push(feature(f.geometry || null, p));
      });
      return result(out);
    },

    /**
     * Geodesic measurements: `area` and `perimeter` (polygons), `length` (lines), `lon`/`lat`
     * (points; the mean position for MultiPoints). Features without geometry get nulls.
     * @param {object} fc
     * @param {{areaUnits?: string, lengthUnits?: string, fields?: object|string[]}} [opts]
     *   fields: rename map ({ area: 'area_ha' }) or a list of measures to add
     * @returns {object}
     */
    measure(fc, opts) {
      opts = opts || {};
      fc = asFC(fc);
      const au = areaUnit(opts.areaUnits), lu = linUnit(opts.lengthUnits);
      const names = { area: 'area', perimeter: 'perimeter', length: 'length', lon: 'lon', lat: 'lat' };
      let only = null;
      if (Array.isArray(opts.fields)) only = new Set(opts.fields.map(String));
      else if (opts.fields && typeof opts.fields === 'object') Object.keys(opts.fields).forEach(function (k) { if (names[k]) names[k] = String(opts.fields[k]); });
      const want = function (k) { return !only || only.has(k); };
      const fams = new Set();
      fc.features.forEach(function (f) { const t = f && f.geometry && util.geomFamily(f.geometry.type); if (t) fams.add(t); });
      const W = new Warnings();
      const out = [];
      fc.features.forEach(function (f) {
        if (!f) return;
        const p = copyProps(f);
        const set = function (k, v) { if (want(k)) p[names[k]] = v === null || isNum(v) ? v : null; };
        if (!f.geometry) {
          if (fams.has('Polygon') || fams.has('GeometryCollection')) { set('area', null); set('perimeter', null); }
          if (fams.has('LineString')) set('length', null);
          if (fams.has('Point')) { set('lon', null); set('lat', null); }
          out.push(feature(null, p));
          return;
        }
        const c = components(f.geometry);
        if (c.polys.length) {
          let perim = 0;
          c.polys.forEach(function (rings) { rings.forEach(function (r) { perim += pathLengthM(r); }); });
          let a = null;
          try { a = util.fromSqMeters(geodesicArea(c.polys), au); } catch (e) { W.fail('measured', e); }
          set('area', a);
          set('perimeter', util.fromMeters(perim, lu));
        }
        if (c.lines.length) {
          let len = 0;
          c.lines.forEach(function (l) { len += pathLengthM(l); });
          set('length', util.fromMeters(len, lu));
        }
        if (c.points.length) {
          const m = c.points.length === 1 ? c.points[0] : vertexMean({ points: c.points, lines: [], polys: [] });
          set('lon', m[0]);
          set('lat', m[1]);
        }
        if (!c.polys.length && !c.lines.length && !c.points.length) {
          const t = util.geomFamily(f.geometry.type);
          if (t === 'Polygon') { set('area', null); set('perimeter', null); } else if (t === 'LineString') set('length', null); else if (t === 'Point') { set('lon', null); set('lat', null); }
        }
        out.push(feature(f.geometry, p));
      });
      return result(out, W);
    },

    /**
     * Attribute summary table (features without geometry included).
     * @param {object} fc
     * @param {{groupBy?: string|string[], stats?: {field: string, op: string, as?: string}[]}} [opts]
     * @returns {object[]} rows `{ ...groupValues, count, <op>_<field> }` (not a FeatureCollection)
     */
    summarize(fc, opts) {
      opts = opts || {};
      fc = asFC(fc);
      const fields = toArr(opts.groupBy).map(String);
      const agg = new Aggregator(normalizeStats(opts.stats));
      const groups = new Map();
      fc.features.forEach(function (f) {
        if (!f) return;
        const gk = groupKey(f.properties, fields);
        let g = groups.get(gk.key);
        if (!g) { g = { values: gk.values, count: 0, state: agg.create() }; groups.set(gk.key, g); }
        g.count++;
        agg.add(g.state, f.properties);
      });
      if (!fields.length && !groups.size) groups.set('', { values: {}, count: 0, state: agg.create() });
      return Array.from(groups.values(), function (g) {
        return Object.assign({}, g.values, { count: g.count }, agg.finish(g.state));
      });
    },

    /**
     * Check geometries: null geometry, unknown type, NaN / out-of-range coordinates, too few
     * positions, unclosed or zero-area rings, self-intersections, holes outside shells and
     * overlapping MultiPolygon parts.
     * @param {object} fc
     * @returns {{valid: boolean, invalid: {index: number, reason: string}[]}}
     */
    validate(fc) {
      fc = asFC(fc);
      const invalid = [];
      fc.features.forEach(function (f, i) {
        let reasons;
        try { reasons = validateGeometry(f && f.geometry); } catch (e) { reasons = ['could not be checked: ' + e.message]; }
        if (reasons.length) invalid.push({ index: i, reason: reasons.join('; ') });
      });
      return { valid: invalid.length === 0, invalid: invalid };
    },

    /**
     * Repaired copy: drops NaN positions and duplicate vertices, closes rings, drops degenerate
     * rings/parts, fixes self-intersecting or overlapping polygons (self-union) and applies
     * RFC 7946 winding. Features whose geometry cannot be kept get a null geometry.
     * @param {object} fc
     * @returns {object}
     */
    makeValid(fc) {
      fc = asFC(fc);
      const W = new Warnings();
      const out = [];
      fc.features.forEach(function (f) {
        if (!f) return;
        if (!f.geometry) { out.push(feature(null, copyProps(f))); return; }
        let g = null;
        try { g = repairGeometry(f.geometry, W); } catch (e) { W.fail('repaired', e); g = null; }
        if (!g) W.count('emptied', 'feature had no usable geometry left and now has none', 'features had no usable geometry left and now have none');
        out.push(feature(g, copyProps(f)));
      });
      return result(out, W);
    },
  });

  /* ============================================================ API helpers */

  function overlayLayer(fc, L, mode, verb) {
    const W = new Warnings();
    const out = [];
    fc.features.forEach(function (f) {
      if (!f || !f.geometry) { W.skipNull(); return; }
      const F = new Prep(f.geometry);
      if (F.isEmpty()) { W.count('empty', 'feature with empty geometry was skipped', 'features with empty geometry were skipped'); return; }
      const cands = L.search(padBox(F.bbox, EPS)).map(function (j) { return L.prep(j); }).filter(Boolean);
      let g;
      try { g = overlay(F, cands, mode); } catch (e) { W.fail(verb, e); return; }
      if (!g) return;
      out.push(feature(g === UNCHANGED ? f.geometry : g, copyProps(f)));
    });
    return result(out, W);
  }

  function polygonOverlay(fcA, fcB, opts, withIntersection) {
    fcA = asFC(fcA, 'First layer');
    fcB = asFC(fcB, 'Second layer');
    const W = new Warnings();
    const LA = new Layer(fcA, isPolygonal), LB = new Layer(fcB, isPolygonal);
    const skipped = function (fc, L) {
      const n = fc.features.filter(function (f) { return f && f.geometry; }).length - L.size();
      for (let i = 0; i < n; i++) W.count('notpoly', 'non-polygon feature was ignored', 'non-polygon features were ignored');
    };
    skipped(fcA, LA); skipped(fcB, LB);
    if (!LA.size() && !LB.size()) throw new Error(withIntersection ? 'Union needs polygon layers' : 'Symmetrical difference needs polygon layers');
    const keysA = layerKeys(fcA);
    const map = fieldMap(keysA, layerKeys(fcB), '', opts.suffix || '_2');
    const nullA = {};
    keysA.forEach(function (k) { nullA[k] = null; });
    const out = [];
    const pieces = function (L, other, fc, props, polysOnly) {
      L.items.forEach(function (it) {
        const F = L.prep(it.i);
        if (!F) return;
        const f = fc.features[it.i];
        const cands = other.search(padBox(F.bbox, EPS)).map(function (j) { return other.prep(j); }).filter(Boolean);
        let g;
        try { g = overlay(F, cands, 'erase'); } catch (e) { W.fail('overlaid', e); return; }
        if (!g) return;
        if (g === UNCHANGED) g = polysGeom(F.polys);
        const polys = polysOnly ? components(g).polys : null;
        if (polys && !polys.length) return;
        out.push(feature(polys ? polysGeom(polys) : g, props(f)));
      });
    };
    if (withIntersection) {
      LA.items.forEach(function (it) {
        const F = LA.prep(it.i);
        if (!F) return;
        const fa = fcA.features[it.i];
        LB.search(padBox(F.bbox, EPS)).forEach(function (j) {
          const C = LB.prep(j);
          if (!C) return;
          let g;
          try { g = overlay(F, [C], 'clip'); } catch (e) { W.fail('overlaid', e); return; }
          if (!g) return;
          const polys = g === UNCHANGED ? F.polys : components(g).polys;
          if (!polys.length) return;
          out.push(feature(polysGeom(polys), applyMap(copyProps(fa), fcB.features[j].properties, map)));
        });
      });
    }
    pieces(LA, LB, fcA, function (f) { return applyMap(copyProps(f), null, map); }, true);
    pieces(LB, LA, fcB, function (f) { return applyMap(Object.assign({}, nullA), f.properties, map); }, true);
    return result(out, W);
  }

  function kmeansCore(xs, ys, k, rand) {
    const n = xs.length;
    const cx = new Float64Array(k), cy = new Float64Array(k);
    const d2 = new Float64Array(n).fill(Infinity);
    let first = Math.floor(rand() * n);
    cx[0] = xs[first]; cy[0] = ys[first];
    for (let c = 1; c < k; c++) {
      let sum = 0;
      for (let i = 0; i < n; i++) {
        const dx = xs[i] - cx[c - 1], dy = ys[i] - cy[c - 1];
        const d = dx * dx + dy * dy;
        if (d < d2[i]) d2[i] = d;
        sum += d2[i];
      }
      let pick = n - 1;
      if (sum > 0) {
        let u = rand() * sum;
        for (let i = 0; i < n; i++) { u -= d2[i]; if (u <= 0) { pick = i; break; } }
      } else {
        pick = Math.floor(rand() * n);
      }
      cx[c] = xs[pick]; cy[c] = ys[pick];
    }
    const lab = new Int32Array(n).fill(-1);
    for (let iter = 0; iter < 100; iter++) {
      let changed = false;
      for (let i = 0; i < n; i++) {
        let best = 0, bd = Infinity;
        for (let c = 0; c < k; c++) {
          const dx = xs[i] - cx[c], dy = ys[i] - cy[c];
          const d = dx * dx + dy * dy;
          if (d < bd) { bd = d; best = c; }
        }
        if (lab[i] !== best) { lab[i] = best; changed = true; }
      }
      if (!changed) break;
      const sx = new Float64Array(k), sy = new Float64Array(k), cnt = new Int32Array(k);
      for (let i = 0; i < n; i++) { sx[lab[i]] += xs[i]; sy[lab[i]] += ys[i]; cnt[lab[i]]++; }
      for (let c = 0; c < k; c++) {
        if (cnt[c]) { cx[c] = sx[c] / cnt[c]; cy[c] = sy[c] / cnt[c]; continue; }
        // Empty cluster: move it to the point farthest from its current center.
        let far = 0, fd = -1;
        for (let i = 0; i < n; i++) {
          const dx = xs[i] - cx[lab[i]], dy = ys[i] - cy[lab[i]];
          const d = dx * dx + dy * dy;
          if (d > fd) { fd = d; far = i; }
        }
        cx[c] = xs[far]; cy[c] = ys[far];
      }
    }
    let sse = 0;
    for (let i = 0; i < n; i++) {
      const dx = xs[i] - cx[lab[i]], dy = ys[i] - cy[lab[i]];
      sse += dx * dx + dy * dy;
    }
    return { labels: lab, sse: sse };
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
