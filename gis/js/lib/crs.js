/*
 * PSICITS — coordinate reference systems (thin layer over proj4js).
 *
 * All vector data inside PSICITS is stored in EPSG:4326 (lon/lat, WGS84).
 * Rasters keep their native CRS and are warped for display.
 */
(function (root) {
  'use strict';

  const M = (root.PSICITS = root.PSICITS || {});
  const util = M.util;

  const proj4 = function () {
    const p = root.proj4;
    if (!p) throw new Error('proj4 is not loaded');
    return p;
  };

  // Frequently used definitions, so common data works offline without a lookup.
  const KNOWN = {
    'EPSG:4326': ['WGS 84 (lon/lat)', '+proj=longlat +datum=WGS84 +no_defs'],
    'EPSG:4269': ['NAD83 (lon/lat)', '+proj=longlat +datum=NAD83 +no_defs'],
    'EPSG:4267': ['NAD27 (lon/lat)', '+proj=longlat +datum=NAD27 +no_defs'],
    'EPSG:4258': ['ETRS89 (lon/lat)', '+proj=longlat +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +no_defs'],
    'EPSG:3857': ['WGS 84 / Pseudo-Mercator (web map)', '+proj=merc +a=6378137 +b=6378137 +lat_ts=0 +lon_0=0 +x_0=0 +y_0=0 +k=1 +units=m +nadgrids=@null +wktext +no_defs'],
    'EPSG:3395': ['WGS 84 / World Mercator', '+proj=merc +lon_0=0 +k=1 +x_0=0 +y_0=0 +datum=WGS84 +units=m +no_defs'],
    'EPSG:3435': ['NAD83 / Illinois East (ftUS)', '+proj=tmerc +lat_0=36.6666666666667 +lon_0=-88.3333333333333 +k=0.999975 +x_0=300000.0000000001 +y_0=0 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=us-ft +no_defs'],
    'EPSG:3436': ['NAD83 / Illinois West (ftUS)', '+proj=tmerc +lat_0=36.6666666666667 +lon_0=-90.1666666666667 +k=0.999941177 +x_0=699999.999898499 +y_0=0 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=us-ft +no_defs'],
    'EPSG:2263': ['NAD83 / New York Long Island (ftUS)', '+proj=lcc +lat_0=40.1666666666667 +lon_0=-74 +lat_1=41.0333333333333 +lat_2=40.6666666666667 +x_0=300000.0000000001 +y_0=0 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=us-ft +no_defs'],
    'EPSG:2229': ['NAD83 / California zone 5 (ftUS)', '+proj=lcc +lat_0=33.5 +lon_0=-118 +lat_1=35.4666666666667 +lat_2=34.0333333333333 +x_0=2000000.0001016 +y_0=500000.0001016 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=us-ft +no_defs'],
    'EPSG:5070': ['NAD83 / Conus Albers', '+proj=aea +lat_0=23 +lon_0=-96 +lat_1=29.5 +lat_2=45.5 +x_0=0 +y_0=0 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs'],
    'EPSG:3310': ['NAD83 / California Albers', '+proj=aea +lat_0=0 +lon_0=-120 +lat_1=34 +lat_2=40.5 +x_0=0 +y_0=-4000000 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs'],
    'EPSG:27700': ['OSGB36 / British National Grid', '+proj=tmerc +lat_0=49 +lon_0=-2 +k=0.9996012717 +x_0=400000 +y_0=-100000 +ellps=airy +towgs84=446.448,-125.157,542.06,0.15,0.247,0.842,-20.489 +units=m +no_defs'],
    'EPSG:2154': ['RGF93 / Lambert-93 (France)', '+proj=lcc +lat_0=46.5 +lon_0=3 +lat_1=49 +lat_2=44 +x_0=700000 +y_0=6600000 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs'],
    'EPSG:3035': ['ETRS89 / LAEA Europe', '+proj=laea +lat_0=52 +lon_0=10 +x_0=4321000 +y_0=3210000 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs'],
    'EPSG:28992': ['Amersfoort / RD New (Netherlands)', '+proj=sterea +lat_0=52.1561605555556 +lon_0=5.38763888888889 +k=0.9999079 +x_0=155000 +y_0=463000 +ellps=bessel +towgs84=565.4171,50.3319,465.5524,1.9342,-1.6677,9.1019,4.0725 +units=m +no_defs'],
    'EPSG:2056': ['CH1903+ / LV95 (Switzerland)', '+proj=somerc +lat_0=46.9524055555556 +lon_0=7.43958333333333 +k_0=1 +x_0=2600000 +y_0=1200000 +ellps=bessel +towgs84=674.374,15.056,405.346,0,0,0,0 +units=m +no_defs'],
    'EPSG:2193': ['NZGD2000 / New Zealand TM', '+proj=tmerc +lat_0=0 +lon_0=173 +k=0.9996 +x_0=1600000 +y_0=10000000 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs'],
    'EPSG:3577': ['GDA94 / Australian Albers', '+proj=aea +lat_0=0 +lon_0=132 +lat_1=-18 +lat_2=-36 +x_0=0 +y_0=0 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs'],
    'EPSG:3413': ['WGS 84 / NSIDC Sea Ice Polar Stereographic North', '+proj=stere +lat_0=90 +lat_ts=70 +lon_0=-45 +k=1 +x_0=0 +y_0=0 +datum=WGS84 +units=m +no_defs'],
    'EPSG:3031': ['WGS 84 / Antarctic Polar Stereographic', '+proj=stere +lat_0=-90 +lat_ts=-71 +lon_0=0 +k=1 +x_0=0 +y_0=0 +datum=WGS84 +units=m +no_defs'],
    'EPSG:6933': ['WGS 84 / NSIDC EASE-Grid 2.0 Global (equal area)', '+proj=cea +lat_ts=30 +lon_0=0 +x_0=0 +y_0=0 +datum=WGS84 +units=m +no_defs'],
    'ESRI:54009': ['World Mollweide', '+proj=moll +lon_0=0 +x_0=0 +y_0=0 +datum=WGS84 +units=m +no_defs'],
  };

  // UTM families are generated rather than listed.
  function utmDef(code) {
    const m = /^EPSG:(\d+)$/.exec(code);
    if (!m) return null;
    const n = +m[1];
    let zone, south = false, datum;
    if (n >= 32601 && n <= 32660) { zone = n - 32600; datum = '+datum=WGS84'; }
    else if (n >= 32701 && n <= 32760) { zone = n - 32700; south = true; datum = '+datum=WGS84'; }
    else if (n >= 26901 && n <= 26923) { zone = n - 26900; datum = '+datum=NAD83'; }
    else if (n >= 26701 && n <= 26722) { zone = n - 26700; datum = '+datum=NAD27'; }
    else if (n >= 25828 && n <= 25838) { zone = n - 25800; datum = '+ellps=GRS80 +towgs84=0,0,0,0,0,0,0'; }
    else if (n === 3067) { zone = 35; datum = '+ellps=GRS80 +towgs84=0,0,0,0,0,0,0'; }
    else return null;
    const label = (datum.indexOf('WGS84') >= 0 ? 'WGS 84' : datum.indexOf('NAD83') >= 0 ? 'NAD83' : datum.indexOf('NAD27') >= 0 ? 'NAD27' : 'ETRS89') +
      ' / UTM zone ' + zone + (south ? 'S' : 'N');
    return [label, '+proj=utm +zone=' + zone + (south ? ' +south' : '') + ' ' + datum + ' +units=m +no_defs'];
  }

  const names = Object.create(null);
  const sources = Object.create(null); // code -> original definition text
  let initialised = false;
  function init() {
    if (initialised) return;
    const p = proj4();
    Object.keys(KNOWN).forEach(function (code) {
      names[code] = KNOWN[code][0];
      sources[code] = KNOWN[code][1];
      try { p.defs(code, KNOWN[code][1]); } catch (e) { /* ignore */ }
    });
    initialised = true;
  }

  const crs = (M.crs = {});

  /**
   * Normalise the many ways people write a CRS to a proj4 key.
   * "4326", "epsg:4326", "EPSG::4326", "urn:ogc:def:crs:EPSG::4326",
   * "http://www.opengis.net/def/crs/EPSG/0/4326", "CRS84", "WGS84" → "EPSG:4326".
   * Proj4 strings and WKT pass through unchanged.
   */
  crs.normalize = function (code) {
    if (code === null || code === undefined || code === '') return null;
    if (typeof code === 'number') return 'EPSG:' + code;
    let s = String(code).trim();
    if (/^\d{4,6}$/.test(s)) return 'EPSG:' + s;
    if (/^(urn:ogc:def:crs:OGC:(1\.3:)?CRS84|CRS:?84|OGC:CRS84|WGS ?84|EPSG:4326)$/i.test(s)) return 'EPSG:4326';
    let m = /^(EPSG|ESRI)\s*:+\s*(\d+)$/i.exec(s);
    if (m) return m[1].toUpperCase() + ':' + m[2];
    m = /urn:ogc:def:crs:(EPSG|ESRI)::?(?:[\d.]*:)?(\d+)$/i.exec(s);
    if (m) return m[1].toUpperCase() + ':' + m[2];
    m = /opengis\.net\/def\/crs\/(EPSG|ESRI)\/[\d.]+\/(\d+)$/i.exec(s);
    if (m) return m[1].toUpperCase() + ':' + m[2];
    if (/^(GOOGLE|EPSG:900913|EPSG:3785|EPSG:102100|EPSG:102113|ESRI:102100)$/i.test(s)) return 'EPSG:3857';
    return s; // proj4 string or WKT
  };

  crs.isProj4String = function (s) { return typeof s === 'string' && /^\s*\+proj=/.test(s); };
  crs.isWKT = function (s) { return typeof s === 'string' && /^\s*(PROJCS|GEOGCS|PROJCRS|GEOGCRS|GEODCRS|COMPD_CS|COMPOUNDCRS|BOUNDCRS)\s*\[/i.test(s); };

  /** Is this CRS usable right now (without a network lookup)? */
  crs.has = function (code) {
    init();
    const c = crs.normalize(code);
    if (!c) return false;
    if (crs.isProj4String(c) || crs.isWKT(c)) return true;
    if (proj4().defs(c)) return true;
    const u = utmDef(c);
    if (u) { crs.register(c, u[1], u[0]); return true; }
    return false;
  };

  /** Register a definition (proj4 string or WKT) under a code. */
  crs.register = function (code, def, name) {
    init();
    proj4().defs(code, def);
    if (typeof def === 'string') sources[code] = def;
    if (name) names[code] = name;
    return code;
  };

  /**
   * The original definition text (proj4 string or WKT) for a code, when
   * known. proj4js itself only keeps the parsed form.
   */
  crs.definition = function (code) {
    init();
    const c = crs.normalize(code);
    if (!c) return null;
    if (crs.isProj4String(c) || crs.isWKT(c)) return c;
    if (!sources[c]) {
      const u = utmDef(c); // UTM families are generated, not listed
      if (u) sources[c] = u[1];
    }
    return sources[c] || null;
  };

  /** Human-readable name if we know one. */
  crs.name = function (code) {
    init();
    const c = crs.normalize(code);
    if (!c) return '';
    if (names[c]) return names[c];
    const u = utmDef(c);
    if (u) return u[0];
    if (crs.isProj4String(c)) return 'Custom (proj4)';
    if (crs.isWKT(c)) {
      const m = /^\s*\w+\s*\[\s*"([^"]+)"/.exec(c);
      return m ? m[1] : 'Custom (WKT)';
    }
    return c;
  };

  /** Known CRS list for dropdowns: [{ code, name }]. */
  crs.list = function () {
    init();
    const out = Object.keys(KNOWN).map(function (c) { return { code: c, name: KNOWN[c][0] }; });
    Object.keys(names).forEach(function (c) { if (!KNOWN[c]) out.push({ code: c, name: names[c] }); });
    return out;
  };

  const lookupCache = Object.create(null);

  /**
   * Make sure a CRS definition is available, fetching it from epsg.io /
   * spatialreference.org if necessary. Resolves to the normalised code.
   */
  crs.ensure = async function (code) {
    const c = crs.normalize(code);
    if (!c) throw new Error('No CRS given');
    if (crs.has(c)) return c;
    const m = /^(EPSG|ESRI):(\d+)$/.exec(c);
    if (!m) throw new Error('Unrecognised CRS "' + code + '"');
    if (lookupCache[c]) return lookupCache[c];
    const fetchFn = root.fetch;
    if (!fetchFn) throw new Error('CRS ' + c + ' is not built in and no network is available to look it up');
    lookupCache[c] = (async function () {
      const auth = m[1].toLowerCase();
      const urls = [
        'https://epsg.io/' + (auth === 'esri' ? 'ESRI:' : '') + m[2] + '.proj4',
        'https://spatialreference.org/ref/' + auth + '/' + m[2] + '/proj4.txt',
      ];
      let lastErr = null;
      for (let i = 0; i < urls.length; i++) {
        try {
          const r = await fetchFn(urls[i]);
          if (!r.ok) throw new Error('HTTP ' + r.status);
          const txt = (await r.text()).trim();
          if (!/^\+proj=/.test(txt)) throw new Error('unexpected response');
          crs.register(c, txt);
          return c;
        } catch (e) { lastErr = e; }
      }
      delete lookupCache[c];
      throw new Error('Could not look up ' + c + ' (' + (lastErr && lastErr.message) + '). Give a proj4 string instead.');
    })();
    return lookupCache[c];
  };

  /**
   * Register a WKT (e.g. the contents of a .prj file). Returns a code: the
   * EPSG code if the WKT carries a top-level authority, else a synthetic key.
   */
  crs.fromWKT = function (wkt) {
    init();
    if (!wkt) return null;
    const s = String(wkt).trim();
    // Top-level AUTHORITY is the last one in WKT1; ID["EPSG",n] in WKT2.
    const auth = /AUTHORITY\s*\[\s*"(EPSG|ESRI)"\s*,\s*"?(\d+)"?\s*\]\s*\]\s*$/i.exec(s) ||
      /ID\s*\[\s*"(EPSG|ESRI)"\s*,\s*(\d+)\s*\]\s*\]\s*$/i.exec(s);
    if (auth) {
      const code = auth[1].toUpperCase() + ':' + auth[2];
      if (!crs.has(code)) { try { crs.register(code, s); } catch (e) { /* fall through */ } }
      if (crs.has(code)) return code;
    }
    if (/^GEOGCS\s*\[\s*"(GCS_WGS_1984|WGS 84|WGS84)"/i.test(s)) return 'EPSG:4326';
    if (/^PROJCS\s*\[\s*"(WGS_1984_Web_Mercator_Auxiliary_Sphere|WGS 84 \/ Pseudo-Mercator)"/i.test(s)) return 'EPSG:3857';
    let h = 0;
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
    const key = 'WKT:' + (h >>> 0).toString(16);
    try {
      crs.register(key, s, crs.name(s));
    } catch (e) {
      throw new Error('Could not understand this projection definition');
    }
    return key;
  };

  function defOf(code) {
    init();
    const c = crs.normalize(code);
    if (!c) return null;
    if (crs.isProj4String(c) || crs.isWKT(c)) return c;
    if (!crs.has(c)) return null;
    return proj4().defs(c);
  }

  /** True for lon/lat systems. Unknown codes return false. */
  crs.isGeographic = function (code) {
    const c = crs.normalize(code);
    if (c === 'EPSG:4326' || c === 'EPSG:4269' || c === 'EPSG:4267' || c === 'EPSG:4258') return true;
    const d = defOf(c);
    if (!d) return false;
    if (typeof d === 'string') return /\+proj=(longlat|latlong|lonlat|latlon)/.test(d) || /^\s*(GEOGCS|GEOGCRS)/i.test(d);
    return d.projName === 'longlat';
  };

  // Meters per unit for a definition (string or parsed proj4 object); null = degrees.
  function unitFactor(code) {
    if (crs.isGeographic(code)) return null;
    const d = defOf(code);
    if (!d) return 1;
    if (typeof d === 'string') {
      if (crs.isProj4String(d)) {
        const tm = /\+to_meter=([\d.eE+-]+)/.exec(d);
        if (tm) return parseFloat(tm[1]);
        const um = /\+units=([\w-]+)/.exec(d);
        if (um) return um[1] === 'us-ft' ? 1200 / 3937 : um[1] === 'ft' ? 0.3048 : um[1] === 'km' ? 1000 : 1;
        return 1;
      }
      // WKT: the last top-level UNIT[...] of a projected CRS is its linear unit.
      const re = /(?:UNIT|LENGTHUNIT)\s*\[\s*"[^"]*"\s*,\s*([\d.eE+-]+)/gi;
      let m, last = null;
      while ((m = re.exec(d))) last = parseFloat(m[1]);
      return last && isFinite(last) ? last : 1;
    }
    if (d.to_meter) return d.to_meter;
    if (d.units === 'us-ft' || d.units === 'us survey foot') return 1200 / 3937;
    if (d.units === 'ft' || d.units === 'foot') return 0.3048;
    return 1;
  }

  /** Linear units name of a CRS: 'm' | 'ft' | 'us-ft' | 'degrees' (or 'custom'). */
  crs.units = function (code) {
    const f = unitFactor(code);
    if (f === null) return 'degrees';
    if (Math.abs(f - 1) < 1e-12) return 'm';
    if (Math.abs(f - 1200 / 3937) < 1e-9) return 'us-ft';
    if (Math.abs(f - 0.3048) < 1e-9) return 'ft';
    if (Math.abs(f - 1000) < 1e-9) return 'km';
    return 'custom';
  };

  /** Meters per CRS unit (null for geographic). */
  crs.metersPerUnit = function (code) {
    return unitFactor(code);
  };

  function same(a, b) { return crs.normalize(a) === crs.normalize(b); }

  /** Returns fn([x, y]) -> [x, y]. Identity when the systems are equal. */
  crs.transformer = function (from, to) {
    init();
    from = crs.normalize(from) || 'EPSG:4326';
    to = crs.normalize(to) || 'EPSG:4326';
    if (same(from, to)) return function (p) { return p; };
    if (!crs.has(from)) throw new Error('Unknown CRS ' + from + ' (call PSICITS.crs.ensure first)');
    if (!crs.has(to)) throw new Error('Unknown CRS ' + to + ' (call PSICITS.crs.ensure first)');
    const conv = proj4()(defOf(from), defOf(to));
    return function (p) {
      const r = conv.forward([p[0], p[1]]);
      return p.length > 2 ? [r[0], r[1]].concat(p.slice(2)) : [r[0], r[1]];
    };
  };

  crs.transformGeometry = function (geom, from, to) {
    const t = crs.transformer(from, to);
    return util.mapCoords(geom, t);
  };

  crs.transformFC = function (fc, from, to) {
    const t = crs.transformer(from, to);
    return {
      type: 'FeatureCollection',
      features: fc.features.map(function (f) {
        const out = { type: 'Feature', properties: f.properties, geometry: f.geometry ? util.mapCoords(f.geometry, t) : null };
        if (f.id !== undefined) out.id = f.id;
        return out;
      }),
    };
  };

  /** Transform a bbox, densifying the edges so curved projections are covered. */
  crs.transformBBox = function (b, from, to, steps) {
    const t = crs.transformer(from, to);
    steps = steps || 20;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let i = 0; i <= steps; i++) {
      const fx = b[0] + (b[2] - b[0]) * (i / steps);
      const fy = b[1] + (b[3] - b[1]) * (i / steps);
      [[fx, b[1]], [fx, b[3]], [b[0], fy], [b[2], fy]].forEach(function (p) {
        const q = t(p);
        if (!isFinite(q[0]) || !isFinite(q[1])) return;
        if (q[0] < minX) minX = q[0]; if (q[0] > maxX) maxX = q[0];
        if (q[1] < minY) minY = q[1]; if (q[1] > maxY) maxY = q[1];
      });
    }
    return [minX, minY, maxX, maxY];
  };

  /** WGS 84 UTM zone code for a lon/lat (useful for metric work). */
  crs.utmFor = function (lon, lat) {
    let zone = Math.floor((lon + 180) / 6) + 1;
    zone = Math.max(1, Math.min(60, zone));
    return 'EPSG:' + (lat >= 0 ? 32600 : 32700) + zone;
  };

  /** Do these coordinates look like lon/lat degrees? */
  crs.looksGeographic = function (bbox) {
    return !!bbox && bbox[0] >= -180.0001 && bbox[2] <= 180.0001 && bbox[1] >= -90.0001 && bbox[3] <= 90.0001;
  };

  // Well-known WKT for .prj files we write.
  crs.WKT_4326 = 'GEOGCS["GCS_WGS_1984",DATUM["D_WGS_1984",SPHEROID["WGS_1984",6378137,298.257223563]],PRIMEM["Greenwich",0],UNIT["Degree",0.017453292519943295]]';
  crs.WKT_3857 = 'PROJCS["WGS_1984_Web_Mercator_Auxiliary_Sphere",GEOGCS["GCS_WGS_1984",DATUM["D_WGS_1984",SPHEROID["WGS_1984",6378137.0,298.257223563]],PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]],PROJECTION["Mercator_Auxiliary_Sphere"],PARAMETER["False_Easting",0.0],PARAMETER["False_Northing",0.0],PARAMETER["Central_Meridian",0.0],PARAMETER["Standard_Parallel_1",0.0],PARAMETER["Auxiliary_Sphere_Type",0.0],UNIT["Meter",1.0]]';

  /** ESRI-flavoured WKT for a code (for .prj files). Fetches if needed. */
  crs.esriWKT = async function (code) {
    const c = crs.normalize(code);
    if (c === 'EPSG:4326') return crs.WKT_4326;
    if (c === 'EPSG:3857') return crs.WKT_3857;
    if (crs.isWKT(c)) return c;
    const m = /^EPSG:(\d+)$/.exec(c || '');
    if (!m || !root.fetch) return null;
    try {
      const r = await root.fetch('https://epsg.io/' + m[1] + '.esriwkt');
      if (!r.ok) return null;
      const t = (await r.text()).trim();
      return crs.isWKT(t) ? t : null;
    } catch (e) {
      return null;
    }
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
