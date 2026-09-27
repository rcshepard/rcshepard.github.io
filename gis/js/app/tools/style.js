/*
 * PSICITS — styling commands.
 */
(function (root) {
  'use strict';

  const M = root.PSICITS;
  const util = M.util;
  const T = M.toolkit;
  const P = T.P;
  const def = T.define;

  function keepExtras(oldStyle, next) {
    const o = oldStyle || {};
    ['labels', 'size', 'extrude', 'dash', 'radius', 'lineWidth'].forEach(function (k) { if (o[k] !== undefined && next[k] === undefined) next[k] = o[k]; });
    return next;
  }

  function oneBased(n, count, what) {
    const i = Math.round(n) - 1;
    if (i < 0 || i >= count) throw new Error((what || 'Band') + ' ' + n + ' does not exist (there ' + (count === 1 ? 'is 1 band' : 'are ' + count + ' bands') + ')');
    return i;
  }

  function styleRaster(l, args, ctx) {
    const r = l.raster;
    const nb = r.bands.length;
    const prev = l.style || {};
    const vals = args.values ? args.values.values : [];
    const band = args.band !== undefined ? oneBased(args.band, nb) : (prev.mode === 'singleband' || prev.mode === 'gray' ? prev.band || 0 : 0);
    if (args.type === 'categorized') {
      const vs = new Map();
      const b = r.bands[band];
      for (let i = 0; i < b.length && vs.size <= 64; i++) { const v = b[i]; if (v !== r.noData && v === v) vs.set(v, (vs.get(v) || 0) + 1); }
      if (vs.size > 64) throw new Error('This band has too many distinct values for categories; use a color ramp instead.');
      const keys = Array.from(vs.keys()).sort(function (a, b) { return a - b; });
      const cols = M.colors.categorical(keys.length, args.palette || 'tableau10');
      return { mode: 'palette', band: band, categories: keys.map(function (k, i) { return { value: k, color: cols[i], label: String(k) }; }) };
    }
    const ramp = args.ramp || (args.color ? null : prev.ramp) || 'viridis';
    const st = { mode: 'singleband', band: band, ramp: ramp };
    if (vals.length >= 2) { st.min = Math.min(vals[0], vals[1]); st.max = Math.max(vals[0], vals[1]); st.stretch = 'minmax'; }
    else if (args.stretch) st.stretch = args.stretch;
    else if (prev.min !== undefined && prev.mode === 'singleband' && !args.ramp) { st.min = prev.min; st.max = prev.max; }
    if (args.invert) st.invert = true;
    if (args.method && args.classes) {
      // discrete classes for a raster band
      const sample = [];
      const b = r.bands[band];
      const step = Math.max(1, Math.floor(b.length / 20000));
      for (let i = 0; i < b.length; i += step) if (b[i] !== r.noData && b[i] === b[i]) sample.push(b[i]);
      const edges = M.classify.breaks(sample, args.method, args.classes);
      const cols = M.colors.sampleRamp(ramp, edges.length - 1);
      st.classes = edges.slice(1).map(function (e, i) { return { max: e, color: cols[i], label: util.formatNumber(edges[i]) + ' – ' + util.formatNumber(e) }; });
    }
    return st;
  }

  def({
    name: 'color', aliases: ['colour', 'style', 'symbolize', 'symbolise', 'paint', 'shade', 'choropleth', 'classify', 'recolor'], category: 'Style',
    summary: 'Color a layer: one color, or by a field (graduated/categorized). Rasters: a color ramp.',
    params: [
      P.layer('layer', { kinds: ['vector', 'raster'] }),
      P.field('field', { keywords: ['by', 'using', 'on'], description: 'Field to color by' }),
      { name: 'color', type: 'color', description: 'A single color: red, #3366cc, …' },
      { name: 'ramp', type: 'ramp', description: 'Color ramp: viridis, blues, reds, ylorrd, rdylgn, spectral, terrain, … (add -r to reverse)' },
      { name: 'palette', type: 'palette', description: 'Categorical palette: tableau10, set1, set2, pastel, bold, dark2, paired' },
      P.choice('method', ['quantile', 'equal', 'jenks', 'pretty', 'stddev'], { aliases: { quantiles: 'quantile', quintiles: 'quantile', 'equal interval': 'equal', 'natural breaks': 'jenks', natural: 'jenks', ckmeans: 'jenks', nice: 'pretty', 'standard deviation': 'stddev' }, description: 'Classification method' }),
      { name: 'values', type: 'numbers', unitless: true, keys: ['classes', 'n'], description: 'Number of classes (vector) — or min max stretch (raster)' },
      P.choice('type', ['graduated', 'categorized', 'single'], { aliases: { categories: 'categorized', category: 'categorized', unique: 'categorized', 'unique values': 'categorized', classes: 'graduated', graduated: 'graduated', continuous: 'graduated' } }),
      P.integer('band', { keywords: ['band'], description: 'Raster band (1-based)' }),
      P.choice('stretch', ['percentile', 'minmax', 'stddev'], { keys: ['stretch'], hidden: true }),
      P.flag('invert', ['invert', 'inverted', 'reverse', 'reversed']),
    ],
    examples: ['color roads red', 'color counties by population', 'color counties by population 7 jenks reds', 'color parcels by zoning categories', 'color dem terrain', 'color dem viridis 0 3000'],
    run: function (args, ctx) {
      const l = ctx.layer(args.layer);
      let style;
      if (l.type === 'raster') {
        style = styleRaster(l, args, ctx);
      } else {
        const vals = args.values ? args.values.values : [];
        const classes = vals.length ? Math.max(1, Math.min(12, Math.round(vals[0]))) : undefined;
        let ramp = args.ramp;
        let color = args.color;
        if (!args.field && ramp && M.colors.isColor(ramp) && !(l.style && l.style.kind === 'graduated')) { color = M.colors.normalize(ramp); ramp = null; }
        if (args.field) {
          const numeric = M.style.isNumericField(l, args.field);
          const type = args.type || (numeric ? 'graduated' : 'categorized');
          if (type === 'graduated') {
            if (!numeric) throw new Error('"' + args.field + '" is not numeric; use: color ' + l.name + ' by ' + args.field + ' categories');
            style = M.style.graduated(l, args.field, { method: args.method, classes: classes || 5, ramp: args.invert && ramp ? ramp + '-r' : ramp });
          } else {
            style = M.style.categorized(l, args.field, { palette: args.palette, ramp: ramp });
          }
          keepExtras(l.style, style);
        } else if (color) {
          style = Object.assign({}, l.style, { kind: 'single', color: color });
          if (l.geometryType !== 'Point') style.strokeColor = M.colors.shade(color, -0.35);
        } else if ((ramp || args.method || classes || args.invert) && l.style && l.style.kind === 'graduated') {
          style = M.style.graduated(l, l.style.field, { method: args.method || l.style.method, classes: classes || l.style.classes, ramp: (ramp || l.style.ramp) + (args.invert ? '-r' : '') });
          keepExtras(l.style, style);
        } else if ((args.palette || ramp) && l.style && l.style.kind === 'categorized') {
          style = M.style.categorized(l, l.style.field, { palette: args.palette, ramp: ramp });
          keepExtras(l.style, style);
        } else {
          throw new Error('Give a color (color ' + l.name + ' red) or a field (color ' + l.name + ' by <field>).');
        }
      }
      ctx.store.update(l, { style: style }, { label: 'Style ' + l.name });
      if (style.kind === 'graduated') return 'Colored "' + l.name + '" by ' + style.field + ': ' + style.classes + ' ' + style.method + ' classes (' + style.ramp + ')';
      if (style.kind === 'categorized') return 'Colored "' + l.name + '" by ' + style.field + ': ' + style.categories.length + ' categories' + (style.otherCount ? ' + other' : '');
      if (l.type === 'raster') return 'Raster "' + l.name + '": ' + (style.mode === 'palette' ? style.categories.length + ' categories' : (style.ramp + (style.min !== undefined ? ' ' + style.min + '–' + style.max : '')));
    },
  });

  def({
    name: 'rgb', aliases: ['composite', 'false color', 'true color'], category: 'Style', summary: 'Show a multi-band raster as an RGB composite',
    params: [P.layer('layer', { kinds: ['raster'] }), { name: 'bands', type: 'numbers', unitless: true, required: true, description: 'Red, green, blue band numbers (1-based), e.g. 4 3 2' }],
    examples: ['rgb landsat 4 3 2', 'rgb image 5 4 3'],
    run: function (args, ctx) {
      const l = ctx.raster(args.layer);
      const b = args.bands.values;
      if (b.length !== 3) throw new Error('Give three band numbers: red green blue');
      const nb = l.raster.bands.length;
      ctx.store.update(l, { style: { mode: 'rgb', bands: b.map(function (x) { return oneBased(x, nb); }) } }, { label: 'RGB ' + l.name });
    },
  });

  def({
    name: 'size', aliases: ['proportional', 'bubbles', 'scale by', 'width', 'radius', 'thickness'], category: 'Style',
    summary: 'Symbol size: a fixed size, or proportional to a field',
    params: [
      P.layer('layer'),
      P.field('field', { keywords: ['by', 'using'] }),
      P.number('value', { positional: true, description: 'Fixed size in pixels' }),
      P.number('min', { keywords: ['min', 'from'] }),
      P.number('max', { keywords: ['max', 'to'] }),
    ],
    examples: ['size cities by pop_max', 'size roads 4', 'size quakes by mag min 2 max 30'],
    run: function (args, ctx) {
      const l = ctx.vector(args.layer);
      const s = Object.assign({}, l.style);
      if (args.field) {
        if (!M.style.isNumericField(l, args.field)) throw new Error('"' + args.field + '" is not numeric');
        const pts = l.geometryType !== 'LineString';
        s.size = { field: args.field, min: args.min !== undefined ? args.min : (pts ? 3 : 0.5), max: args.max !== undefined ? args.max : (pts ? 26 : 9) };
      } else if (args.value !== undefined) {
        s.size = null;
        if (l.geometryType === 'Point') s.radius = args.value;
        else if (l.geometryType === 'LineString') s.lineWidth = args.value;
        else { s.strokeWidth = args.value; s.lineWidth = args.value; s.radius = args.value; }
      } else throw new Error('Give a size in pixels (size roads 3) or a field (size cities by population)');
      ctx.store.update(l, { style: s }, { label: 'Size ' + l.name });
    },
  });

  def({
    name: 'heatmap', aliases: ['heat', 'density', 'hotspots'], category: 'Style', summary: 'Show points as a heatmap',
    params: [
      P.layer('layer', { geom: ['Point'] }),
      P.field('weight', { keywords: ['by', 'weight', 'weighted'], description: 'Optional numeric weight field' }),
      P.number('radius', { keywords: ['radius'], positional: true, description: 'Radius in pixels (default 20)' }),
      { name: 'ramp', type: 'ramp' },
      P.flag('off', ['off', 'none', 'stop'], 'Go back to points'),
    ],
    examples: ['heatmap crimes', 'heatmap quakes by mag radius 30 magma'],
    run: function (args, ctx) {
      const l = ctx.vector(args.layer);
      if (args.off) {
        const s = Object.assign({}, l.style, { kind: 'single' });
        ctx.store.update(l, { style: s }, { label: 'Points ' + l.name });
        return;
      }
      T.needGeom(l, ['Point'], 'a heatmap');
      let wmax = 1;
      if (args.weight) {
        const vals = M.style.numericValues(l, args.weight);
        if (!vals.length) throw new Error('"' + args.weight + '" has no numbers');
        wmax = Math.max.apply(null, vals);
      }
      const s = Object.assign({}, l.style, { kind: 'heatmap', heat: { radius: args.radius || 20, intensity: 1, weightField: args.weight || null, weightMax: wmax, ramp: args.ramp || 'heat' } });
      ctx.store.update(l, { style: s }, { label: 'Heatmap ' + l.name });
    },
  });

  def({
    name: 'label', aliases: ['labels', 'annotate', 'label by'], category: 'Style', summary: 'Label features with a field or an expression',
    params: [
      P.layer('layer'),
      P.field('field', { positional: true, description: 'Field to show' }),
      { name: 'text', type: 'expression', keywords: ['by', 'with', 'using', 'text', 'expression'], description: 'Field or expression, e.g. name || \' (\' || pop || \')\'' },
      P.number('size', { keywords: ['size'], description: 'Font size (px)' }),
      { name: 'color', type: 'color' },
      { name: 'halo', type: 'color', keywords: ['halo', 'outline'] },
      P.flag('off', ['off', 'none', 'remove', 'clear']),
    ],
    examples: ['label cities name', 'label counties by name || \': \' || population', 'label roads by name size 11', 'label cities off'],
    run: function (args, ctx) {
      const l = ctx.vector(args.layer);
      const s = Object.assign({}, l.style);
      if (args.off) { s.labels = null; ctx.store.update(l, { style: s }, { label: 'Unlabel ' + l.name }); return; }
      let field = args.field, expression = null;
      if (!field && args.text) {
        const f = M.commands.findField(args.text.replace(/^"(.*)"$/, '$1'), l.fields.map(function (x) { return x.name; }));
        if (f !== null) field = f;
        else {
          const chk = M.expr.check(args.text, { fields: l.fields.map(function (x) { return x.name; }) });
          if (!chk.ok) throw new Error('Label expression: ' + chk.error);
          expression = args.text;
        }
      }
      if (!field && !expression) {
        const guess = l.fields.find(function (f) { return /^(name|title|label|nom|nombre)$/i.test(f.name); }) || l.fields.find(function (f) { return f.type === 'string'; });
        if (!guess) throw new Error('Which field? e.g. label ' + l.name + ' <field>');
        field = guess.name;
      }
      s.labels = { field: field || null, expression: expression, size: args.size || (s.labels && s.labels.size) || 12, color: args.color || (s.labels && s.labels.color) || null, halo: args.halo || (s.labels && s.labels.halo) || null };
      ctx.store.update(l, { style: s }, { label: 'Label ' + l.name });
      return 'Labeling "' + l.name + '" with ' + (field || expression);
    },
  });

  def({
    name: 'unlabel', aliases: ['no labels', 'remove labels', 'labels off', 'hide labels'], category: 'Style', summary: 'Remove labels',
    params: [P.layer('layer')],
    run: function (args, ctx) {
      const l = ctx.vector(args.layer);
      ctx.store.update(l, { style: Object.assign({}, l.style, { labels: null }) }, { label: 'Unlabel ' + l.name });
    },
  });

  def({
    name: 'outline', aliases: ['stroke', 'border', 'edges'], category: 'Style', summary: 'Outline color and width (polygons, points)',
    params: [P.layer('layer'), { name: 'color', type: 'color' }, P.number('width', { positional: true }), P.flag('none', ['none', 'off', 'no'], 'No outline'), P.flag('dashed', ['dashed', 'dash', 'dotted'])],
    examples: ['outline counties white 1.5', 'outline parcels none', 'outline boundary black 2 dashed'],
    run: function (args, ctx) {
      const l = ctx.vector(args.layer);
      const s = Object.assign({}, l.style);
      if (args.none) s.strokeWidth = 0;
      else {
        if (args.color) s.strokeColor = args.color;
        if (args.width !== undefined) s.strokeWidth = args.width;
        if (!s.strokeWidth) s.strokeWidth = 1;
      }
      s.dash = args.dashed ? [2, 2] : null;
      if (l.geometryType === 'LineString') {
        if (args.color) s.color = args.color;
        if (args.width !== undefined) s.lineWidth = args.width;
        if (s.kind !== 'single' && args.color) s.kind = 'single';
      }
      ctx.store.update(l, { style: s }, { label: 'Outline ' + l.name });
    },
  });

  def({
    name: 'fill', aliases: ['fill opacity', 'transparent fill', 'hollow'], category: 'Style', summary: 'Polygon fill opacity (0–100%), or "none" for outlines only',
    params: [P.layer('layer', { geom: ['Polygon'] }), P.number('value', { percent: true, positional: true }), P.flag('none', ['none', 'off', 'hollow', 'empty'])],
    examples: ['fill counties 30%', 'fill city none'],
    run: function (args, ctx) {
      const l = ctx.vector(args.layer);
      let v = args.none ? 0 : args.value;
      if (v === undefined) throw new Error('Give an opacity like 40% or "none"');
      if (v > 1) v /= 100;
      const s = Object.assign({}, l.style, { fillOpacity: Math.max(0, Math.min(1, v)) });
      if (args.none && !s.strokeWidth) s.strokeWidth = 1.5;
      ctx.store.update(l, { style: s }, { label: 'Fill ' + l.name });
    },
  });

  def({
    name: 'extrude', aliases: ['3d', 'height', 'extrusion'], category: 'Style', summary: 'Show polygons in 3D, extruded by a field (meters)',
    params: [
      P.layer('layer', { geom: ['Polygon'] }),
      P.field('field', { keywords: ['by', 'using'], description: 'Height field' }),
      P.number('scale', { keywords: ['scale', 'times', 'x'], description: 'Multiply the field by this (default 1)' }),
      P.number('height', { positional: true, description: 'Fixed height in meters' }),
      P.flag('off', ['off', 'flat', 'none']),
    ],
    examples: ['extrude buildings by height', 'extrude counties by population scale 0.01', 'extrude parcels off'],
    run: function (args, ctx) {
      const l = ctx.vector(args.layer);
      const s = Object.assign({}, l.style);
      if (args.off) { s.extrude = null; ctx.store.update(l, { style: s }, { label: 'Flatten ' + l.name }); return; }
      if (!args.field && args.height === undefined) throw new Error('Extrude by a field (extrude buildings by height) or a fixed height in meters');
      let scale = args.scale;
      if (args.field && scale === undefined) {
        const vals = M.style.numericValues(l, args.field);
        const mx = vals.length ? Math.max.apply(null, vals) : 0;
        // keep towers readable: scale big values down to ~3000 m tall
        scale = mx > 5000 ? +(3000 / mx).toPrecision(2) : 1;
        if (scale !== 1) ctx.out.note('Scaled heights by ' + scale + ' (use "scale" to change)');
      }
      s.extrude = { field: args.field || null, height: args.height, scale: scale || 1 };
      ctx.store.update(l, { style: s }, { label: 'Extrude ' + l.name });
      if (ctx.map.map.getPitch() < 30) ctx.map.map.easeTo({ pitch: 55 });
    },
  });

  def({
    name: 'restyle', aliases: ['reset style', 'default style', 'plain'], category: 'Style', summary: 'Reset a layer to a simple default style',
    params: [P.layer('layer', { kinds: ['vector', 'raster'] })],
    run: function (args, ctx) {
      const l = ctx.layer(args.layer);
      ctx.store.update(l, { style: M.style.defaultStyle(l) }, { label: 'Reset style ' + l.name });
    },
  });
})(typeof globalThis !== 'undefined' ? globalThis : this);
