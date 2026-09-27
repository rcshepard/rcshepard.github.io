/*
 * PSICITS — raster commands (wrapping PSICITS.raster).
 */
(function (root) {
  'use strict';

  const M = root.PSICITS;
  const util = M.util;
  const T = M.toolkit;
  const P = T.P;
  const def = T.define;
  const R = function () { return M.raster; };

  function band(l, n) {
    if (n === undefined || n === null) return 0;
    const i = Math.round(n) - 1;
    if (i < 0 || i >= l.raster.bands.length) throw new Error('"' + l.name + '" has ' + l.raster.bands.length + ' band(s); there is no band ' + n);
    return i;
  }
  const BAND = P.integer('band', { keywords: ['band'], description: 'Band number (1-based, default 1)' });

  function addRaster(ctx, raster, name, style) {
    return ctx.add({ type: 'raster', name: name, raster: raster, style: style || undefined, source: { kind: 'derived', command: ctx.parsed ? ctx.parsed.canonical : '' } }, { verb: 'Created' });
  }

  /** Make sure the raster's CRS definition is available (fetching it if needed), then run fn. */
  async function withCrs(fn, raster) {
    if (raster && raster.crs && !M.crs.has(raster.crs)) {
      try { await M.crs.ensure(raster.crs); } catch (e) { /* the raster function reports a clear error */ }
    }
    return fn();
  }

  def({
    name: 'hillshade', aliases: ['shaded relief', 'relief'], category: 'Raster', summary: 'Shaded relief from an elevation raster',
    params: [P.layer('layer', { kinds: ['raster'] }), BAND, P.number('azimuth', { keywords: ['azimuth', 'sun'], default: 315 }), P.number('altitude', { keywords: ['altitude', 'elevation', 'angle'], default: 45 }), P.number('z', { keywords: ['z', 'exaggeration', 'zfactor'], default: 1 }), P.as()],
    examples: ['hillshade dem', 'hillshade dem azimuth 270 z 2'],
    run: async function (args, ctx) {
      const l = ctx.raster(args.layer);
      const r = await withCrs(function () { return R().terrain(l.raster, band(l, args.band), 'hillshade', { azimuth: args.azimuth, altitude: args.altitude, zFactor: args.z }); }, l.raster);
      addRaster(ctx, r, T.outName(ctx, args, l, 'hillshade'), { mode: 'singleband', ramp: 'gray', band: 0 });
    },
  });
  def({
    name: 'slope', category: 'Raster', summary: 'Slope from an elevation raster (degrees or percent)',
    params: [P.layer('layer', { kinds: ['raster'] }), BAND, P.choice('units', ['degrees', 'percent'], { default: 'degrees', aliases: { deg: 'degrees', '%': 'percent', pct: 'percent' } }), P.as()],
    run: async function (args, ctx) {
      const l = ctx.raster(args.layer);
      const r = await withCrs(function () { return R().terrain(l.raster, band(l, args.band), 'slope', { slopeUnits: args.units }); }, l.raster);
      addRaster(ctx, r, T.outName(ctx, args, l, 'slope'), { mode: 'singleband', ramp: 'ylorrd', band: 0 });
    },
  });
  def({
    name: 'aspect', category: 'Raster', summary: 'Aspect (direction a slope faces) from an elevation raster',
    params: [P.layer('layer', { kinds: ['raster'] }), BAND, P.as()],
    run: async function (args, ctx) {
      const l = ctx.raster(args.layer);
      const r = await withCrs(function () { return R().terrain(l.raster, band(l, args.band), 'aspect', {}); }, l.raster);
      addRaster(ctx, r, T.outName(ctx, args, l, 'aspect'), { mode: 'singleband', ramp: 'turbo', band: 0, min: 0, max: 360, stretch: 'minmax' });
    },
  });

  def({
    name: 'contours', aliases: ['contour', 'contour lines', 'isolines'], category: 'Raster', summary: 'Contour lines from a raster (e.g. every 10 m)',
    params: [P.layer('layer', { kinds: ['raster'] }), P.number('interval', { required: true, positional: true, description: 'Contour interval in raster units' }), P.number('base', { keywords: ['base', 'from'] }), BAND, P.as()],
    examples: ['contours dem 25', 'contours temperature 2 band 1'],
    run: async function (args, ctx) {
      const l = ctx.raster(args.layer);
      ctx.progress('Tracing contours…');
      const fc = await withCrs(function () { return R().contours(l.raster, band(l, args.band), { interval: args.interval, base: args.base || 0 }); }, l.raster);
      const layer = ctx.result(fc, T.outName(ctx, args, l, 'contours_' + args.interval));
      if (layer.count) ctx.run('label ' + JSON.stringify(layer.name) + ' value size 10');
    },
  });

  function rasterVars(ctx, primary) {
    // b1..bn and band names of the primary raster; other rasters by name (band 1) or name_bN
    const vars = {};
    const add = function (name, raster, b) { vars[name] = { raster: raster, band: b }; };
    if (primary) {
      primary.raster.bands.forEach(function (_, i) { add('b' + (i + 1), primary.raster, i); });
      (primary.bandNames || []).forEach(function (n, i) { if (n && !/^b\d+$/i.test(n)) add(util.slug(n), primary.raster, i); });
    }
    ctx.store.layers.forEach(function (l) {
      if (l.type !== 'raster') return;
      const s = util.slug(l.name);
      add(s, l.raster, 0);
      l.raster.bands.forEach(function (_, i) { add(s + '_b' + (i + 1), l.raster, i); });
    });
    return vars;
  }

  def({
    name: 'bandmath', aliases: ['raster calculator', 'map algebra', 'raster calc', 'calc raster', 'band math'], category: 'Raster',
    summary: 'Compute a new raster from an expression over bands (b1, b2, … or other rasters by name)',
    params: [P.layer('layer', { kinds: ['raster'], description: 'Main raster (its bands are b1, b2, …)' }), { name: 'expression', type: 'expression', keywords: ['=', 'expression', 'expr', 'formula', ':'], required: true }, P.as()],
    kvFallback: function (tok, args) { if (!args.expression) { args.as = args.as || tok.key; args.expression = tok.v; return true; } return false; },
    usage: 'bandmath <raster> = <expression> [as <name>]',
    examples: ['bandmath landsat = (b5 - b4) / (b5 + b4) as ndvi', 'bandmath dem = if(b1 > 1000, 1, 0) as highlands', 'bandmath dem2020 = dem2020 - dem2010 as change'],
    run: function (args, ctx) {
      const l = ctx.raster(args.layer);
      const vars = rasterVars(ctx, l);
      const compiled = M.expr.compileRaster(args.expression, Object.keys(vars));
      if (!compiled.variables.length) throw new Error('The expression uses no bands. Bands of "' + l.name + '": ' + l.raster.bands.map(function (_, i) { return 'b' + (i + 1); }).join(', '));
      const inputs = {};
      compiled.variables.forEach(function (v) { inputs[v] = vars[v]; });
      // make sure the main raster defines the output grid
      const ordered = {};
      const first = compiled.variables.find(function (v) { return vars[v].raster === l.raster; }) || compiled.variables[0];
      ordered[first] = inputs[first];
      compiled.variables.forEach(function (v) { if (v !== first) ordered[v] = inputs[v]; });
      ctx.progress('Calculating ' + util.formatNumber(l.raster.width * l.raster.height, 0) + ' pixels…');
      const r = R().mapAlgebra(ordered, compiled.fn, { noData: -9999, dataType: 'float32', bandName: util.slug(args.as || 'result') });
      addRaster(ctx, r, T.outName(ctx, args, l, 'calc'), { mode: 'singleband', ramp: /ndvi/i.test(args.as || args.expression) ? 'ndvi' : 'viridis', band: 0 });
    },
  });

  def({
    name: 'ndvi', aliases: ['vegetation index'], category: 'Raster', summary: 'NDVI = (NIR − red) / (NIR + red) from a multispectral raster',
    params: [P.layer('layer', { kinds: ['raster'] }), P.integer('red', { keywords: ['red', 'r'] }), P.integer('nir', { keywords: ['nir', 'infrared', 'ir'] }), P.as()],
    examples: ['ndvi naip', 'ndvi landsat red 4 nir 5', 'ndvi sentinel red 4 nir 8'],
    run: function (args, ctx) {
      const l = ctx.raster(args.layer);
      const names = (l.bandNames || []).map(function (n) { return String(n).toLowerCase(); });
      let red = args.red, nir = args.nir;
      if (!red) { const i = names.findIndex(function (n) { return /^(red|r|b4_red)$/.test(n); }); if (i >= 0) red = i + 1; }
      if (!nir) { const i = names.findIndex(function (n) { return /^(nir|near.?infrared|nir08)$/.test(n); }); if (i >= 0) nir = i + 1; }
      if (!red || !nir) {
        if (l.raster.bands.length === 4) { red = red || 1; nir = nir || 4; ctx.out.note('Assuming band 1 = red and band 4 = NIR (NAIP/4-band order). Override with: ndvi ' + l.name + ' red <n> nir <n>'); }
        else throw new Error('Which bands are red and near-infrared? e.g. ndvi ' + l.name + ' red 4 nir 5 (Landsat 8/9) or red 4 nir 8 (Sentinel-2)');
      }
      const rb = band(l, red), nb = band(l, nir);
      const r = R().mapAlgebra({ red: { raster: l.raster, band: rb }, nir: { raster: l.raster, band: nb } }, function (v) { const s = v.nir + v.red; return s === 0 ? NaN : (v.nir - v.red) / s; }, { noData: -9999, bandName: 'ndvi' });
      addRaster(ctx, r, T.outName(ctx, args, l, 'ndvi'), { mode: 'singleband', ramp: 'ndvi', band: 0, min: -0.2, max: 0.9, stretch: 'minmax' });
    },
  });

  function parseRules(text) {
    // "0-100:1, 100-200:2, >200:3, 5=9"
    const rules = [];
    String(text).split(/[,;]+/).map(function (s) { return s.trim(); }).filter(Boolean).forEach(function (part) {
      let m = /^(-?[\d.]+|-?inf|min)?\s*(?:-|to|\.\.)\s*(-?[\d.]+|inf|max)?\s*[:=]\s*(-?[\d.]+|nodata|null)$/i.exec(part);
      if (m && (m[1] || m[2])) {
        const lo = !m[1] || /inf|min/i.test(m[1]) ? undefined : parseFloat(m[1]);
        const hi = !m[2] || /inf|max/i.test(m[2]) ? undefined : parseFloat(m[2]);
        rules.push({ min: lo, max: hi, value: /nodata|null/i.test(m[3]) ? null : parseFloat(m[3]) });
        return;
      }
      m = /^(<=|>=|<|>)\s*(-?[\d.]+)\s*[:=]\s*(-?[\d.]+|nodata|null)$/i.exec(part);
      if (m) {
        const v = parseFloat(m[2]);
        const val = /nodata|null/i.test(m[3]) ? null : parseFloat(m[3]);
        rules.push(m[1][0] === '<' ? { max: m[1] === '<=' ? v + 1e-9 : v, value: val } : { min: m[1] === '>=' ? v : v + 1e-9, value: val });
        return;
      }
      m = /^(-?[\d.]+)\s*(?:=|:)\s*(-?[\d.]+|nodata|null)$/i.exec(part);
      if (m) { rules.push({ equals: parseFloat(m[1]), value: /nodata|null/i.test(m[2]) ? null : parseFloat(m[2]) }); return; }
      throw new Error('Could not read the rule "' + part + '". Use forms like 0-100:1, >200:3, 5=9');
    });
    return rules;
  }
  T.parseRules = parseRules;

  def({
    name: 'reclassify', aliases: ['reclass', 'classify raster', 'recode'], category: 'Raster', summary: 'Map value ranges to new values (0-100:1, 100-500:2, >500:3)',
    params: [P.layer('layer', { kinds: ['raster'] }), { name: 'rules', type: 'text', required: true, description: 'e.g. 0-100:1, 100-500:2, >500:3' }, BAND, P.as()],
    examples: ['reclassify dem 0-200:1, 200-500:2, >500:3 as elevation_zones'],
    run: function (args, ctx) {
      const l = ctx.raster(args.layer);
      const rules = parseRules(args.rules);
      const r = R().reclassify(l.raster, band(l, args.band), rules, {});
      const vals = Array.from(new Set(rules.map(function (x) { return x.value; }).filter(function (v) { return v !== null; }))).sort(function (a, b) { return a - b; });
      const cols = M.colors.categorical(vals.length);
      addRaster(ctx, r, T.outName(ctx, args, l, 'reclass'), { mode: 'palette', band: 0, categories: vals.map(function (v, i) { return { value: v, color: cols[i], label: String(v) }; }) });
    },
  });

  def({
    name: 'zonal', aliases: ['zonal stats', 'zonal statistics', 'summarize raster'], category: 'Raster', summary: 'Raster statistics inside each polygon (mean, sum, min, max, …)',
    params: [P.layer('layer', { kinds: ['raster'] }), P.layer('zones', { useActive: false, geom: ['Polygon'] }), { name: 'stats', type: 'text', keywords: ['stats', 'statistics'], description: 'e.g. mean max (default: count mean min max sum)' }, BAND, P.as()],
    forms: ['{layer} (in|by|within|for|over|per) {zones}', '{zones} (with|from) {layer}'],
    examples: ['zonal dem by counties', 'zonal ndvi in parks stats mean max'],
    run: async function (args, ctx) {
      const l = ctx.raster(args.layer);
      const z = ctx.vector(args.zones);
      const stats = args.stats ? args.stats.split(/[\s,]+/).map(function (s) { return M.commands.STAT_OPS[s.toLowerCase()] || s.toLowerCase(); }).filter(Boolean) : ['count', 'mean', 'min', 'max', 'sum'];
      ctx.progress('Summarizing pixels in ' + T.plural(z.count, 'zone') + '…');
      const prefix = util.slug(l.name, 8) + '_';
      const fc = await withCrs(function () { return R().zonalStats(l.raster, band(l, args.band), z.data, { stats: stats, prefix: prefix }); }, l.raster);
      const layer = ctx.result(fc, T.outName(ctx, args, z, 'zonal'));
      ctx.out.note('Fields: ' + stats.map(function (s) { return prefix + s; }).join(', ') + ' — try: color ' + layer.name + ' by ' + prefix + (stats.indexOf('mean') >= 0 ? 'mean' : stats[0]));
    },
  });

  def({
    name: 'sample raster', aliases: ['extract values', 'values to points', 'sample values', 'extract raster values'], category: 'Raster', summary: 'Read raster values at point locations into a field',
    params: [P.layer('layer', { kinds: ['raster'] }), P.layer('points', { useActive: false }), P.choice('method', ['nearest', 'bilinear'], { default: 'nearest', aliases: { interpolate: 'bilinear', smooth: 'bilinear' } }), P.as()],
    forms: ['{layer} (at|to|for|onto) {points}', '{points} (from|with|on) {layer}'],
    examples: ['sample raster dem at wells', 'sample raster ndvi at plots bilinear'],
    run: async function (args, ctx) {
      const l = ctx.raster(args.layer);
      const p = ctx.vector(args.points);
      const fc = await withCrs(function () { return R().sample(l.raster, p.data, { method: args.method, prefix: util.slug(l.name, 10) + '_b' }); }, l.raster);
      ctx.result(fc, T.outName(ctx, args, p, util.slug(l.name, 10)));
    },
  });

  def({
    name: 'idw', aliases: ['interpolate', 'interpolation', 'surface from points', 'inverse distance'], category: 'Raster', summary: 'Interpolate a surface (raster) from point values (inverse distance weighting)',
    params: [P.layer('layer', { geom: ['Point'] }), P.field('field', { positional: true, required: true }), P.distance('cell', { required: false, keywords: ['cell', 'resolution', 'cellsize', 'pixel'], description: 'Cell size, e.g. 100 m (default: ~256 cells across)' }), P.number('power', { keywords: ['power', 'p'], default: 2 }), P.as()],
    examples: ['idw stations temperature', 'idw wells depth cell 50 m power 3'],
    run: function (args, ctx) {
      const l = ctx.vector(args.layer);
      T.needGeom(l, ['Point'], 'interpolation');
      const opts = { power: args.power };
      if (args.cell) opts.cellSize = util.toMeters(args.cell.value, args.cell.units);
      ctx.progress('Interpolating…');
      const r = R().idw(l.data, args.field, opts);
      addRaster(ctx, r, T.outName(ctx, args, l, 'idw_' + util.slug(args.field, 12)), { mode: 'singleband', ramp: 'spectral-r', band: 0 });
    },
  });

  def({
    name: 'raster info', aliases: ['bands'], category: 'Raster', summary: 'Size, bands, CRS and statistics of a raster', noHistory: true,
    params: [P.layer('layer', { kinds: ['raster'] })],
    run: function (args, ctx) { return ctx.run('info ' + JSON.stringify(ctx.raster(args.layer).name)); },
  });
})(typeof globalThis !== 'undefined' ? globalThis : this);
