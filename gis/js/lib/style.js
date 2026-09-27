/*
 * PSICITS — symbology: style objects, MapLibre layer specs and legends.
 *
 * Vector style (layer.style):
 * {
 *   kind: 'single' | 'categorized' | 'graduated' | 'heatmap',
 *   color, fillOpacity, strokeColor, strokeWidth, lineWidth, radius, dash,
 *   field,                                    // categorized / graduated
 *   categories: [{ value, color, label }], otherColor, palette,
 *   method, classes, ramp, breaks: [edges], colors: [...], nullColor,
 *   size: { field, min, max } | null,         // proportional symbols / widths
 *   labels: { field | expression, size, color, halo } | null,
 *   heat: { radius, intensity, weightField, ramp },
 *   extrude: { field, height, scale } | null,
 * }
 * Raster styles are PSICITS.raster render styles (singleband / rgb / palette).
 */
(function (root) {
  'use strict';

  const M = (root.PSICITS = root.PSICITS || {});
  const util = M.util;
  const colors = M.colors;

  const FONT = ['Noto Sans Regular'];
  const NULL_COLOR = '#c8c8c8';

  const style = (M.style = {});
  style.FONT = FONT;

  /* ----------------------------------------------------------- defaults */

  style.defaultStyle = function (layer) {
    if (layer.type === 'raster') return M.raster ? M.raster.defaultStyle(layer.raster) : { mode: 'singleband', ramp: 'viridis' };
    if (layer.type !== 'vector') return {};
    const c = colors.nextLayerColor();
    const g = layer.geometryType;
    return {
      kind: 'single',
      color: c,
      fillOpacity: g === 'Polygon' ? 0.45 : 0.6,
      strokeColor: g === 'Point' ? '#ffffff' : colors.shade(c, -0.35),
      strokeWidth: g === 'Point' ? 1.2 : 1,
      lineWidth: 2.2,
      radius: layer.count > 20000 ? 2.5 : layer.count > 3000 ? 3.5 : 5,
      labels: null,
      size: null,
      extrude: null,
    };
  };

  function numericValues(layer, field) {
    const out = [];
    const feats = layer.data.features;
    for (let i = 0; i < feats.length; i++) {
      const v = feats[i].properties[field];
      if (v === null || v === undefined || v === '') continue;
      const n = typeof v === 'number' ? v : Number(v);
      if (isFinite(n)) out.push(n);
    }
    return out;
  }
  style.numericValues = numericValues;

  function fieldType(layer, field) {
    const f = (layer.fields || []).find(function (x) { return x.name === field; });
    return f ? f.type : null;
  }

  /** Is this field mostly numeric? (strings of digits count). */
  style.isNumericField = function (layer, field) {
    const t = fieldType(layer, field);
    if (t === 'number') return true;
    if (t && t !== 'string') return false;
    const feats = layer.data.features;
    let n = 0, num = 0;
    for (let i = 0; i < feats.length && n < 500; i++) {
      const v = feats[i].properties[field];
      if (v === null || v === undefined || v === '') continue;
      n++;
      if (typeof v === 'number' || (typeof v === 'string' && /^\s*-?\d+(\.\d+)?\s*$/.test(v) && !/^0\d/.test(v.trim()))) num++;
    }
    return n > 0 && num / n > 0.95;
  };

  /* ---------------------------------------------------- style builders */

  /** Categorized style from the field's unique values. */
  style.categorized = function (layer, field, opts) {
    opts = opts || {};
    const base = Object.assign({}, layer.style || style.defaultStyle(layer));
    const freq = util.frequencies(layer.data.features.map(function (f) { const v = f.properties[field]; return v === undefined ? null : v; }));
    const limit = opts.limit || 24;
    const top = freq.slice(0, limit);
    // sort naturally for the legend
    top.sort(function (a, b) {
      if (a.value === null) return 1;
      if (b.value === null) return -1;
      return typeof a.value === 'number' && typeof b.value === 'number' ? a.value - b.value : String(a.value).localeCompare(String(b.value), undefined, { numeric: true });
    });
    const palette = opts.palette || 'tableau10';
    let cols;
    if (opts.ramp) cols = colors.sampleRamp(opts.ramp, top.length);
    else cols = colors.categorical(top.length, palette);
    return Object.assign(base, {
      kind: 'categorized',
      field: field,
      palette: palette,
      ramp: opts.ramp || null,
      categories: top.map(function (t, i) {
        return { value: t.value, color: t.value === null ? NULL_COLOR : cols[i], label: t.value === null ? '(no value)' : String(t.value), count: t.count };
      }),
      otherColor: opts.otherColor || '#9ca3af',
      otherCount: freq.slice(limit).reduce(function (s, x) { return s + x.count; }, 0),
      fillOpacity: base.fillOpacity !== undefined ? Math.max(base.fillOpacity, 0.6) : 0.7,
    });
  };

  /** Graduated (choropleth) style. */
  style.graduated = function (layer, field, opts) {
    opts = opts || {};
    const base = Object.assign({}, layer.style || style.defaultStyle(layer));
    const vals = numericValues(layer, field);
    if (!vals.length) throw new Error('Field "' + field + '" has no numeric values to classify');
    const method = M.classify.normalizeMethod(opts.method) || 'quantile';
    const n = opts.classes || 5;
    const edges = opts.breaks && opts.breaks.length > 1 ? opts.breaks.slice().sort(function (a, b) { return a - b; }) : M.classify.breaks(vals, method, n);
    const k = Math.max(1, edges.length - 1);
    const ramp = opts.ramp || (layer.geometryType === 'Point' ? 'viridis' : 'maroon');
    const cols = colors.sampleRamp(ramp, k);
    const counts = new Array(k).fill(0);
    vals.forEach(function (v) { const c = M.classify.classOf(v, edges); if (c >= 0) counts[c]++; });
    return Object.assign(base, {
      kind: 'graduated',
      field: field,
      method: opts.breaks ? 'manual' : method,
      classes: k,
      ramp: ramp,
      breaks: edges,
      colors: cols,
      counts: counts,
      nullColor: NULL_COLOR,
      fillOpacity: base.fillOpacity !== undefined ? Math.max(base.fillOpacity, 0.7) : 0.75,
      strokeColor: layer.geometryType === 'Polygon' ? '#ffffff' : base.strokeColor,
      strokeWidth: layer.geometryType === 'Polygon' ? 0.6 : base.strokeWidth,
    });
  };

  /* ------------------------------------------------ MapLibre expressions */

  const GEOM_FILTER = {
    Polygon: ['match', ['geometry-type'], ['Polygon', 'MultiPolygon'], true, false],
    LineString: ['match', ['geometry-type'], ['LineString', 'MultiLineString'], true, false],
    Point: ['match', ['geometry-type'], ['Point', 'MultiPoint'], true, false],
  };
  style.GEOM_FILTER = GEOM_FILTER;

  function nextUp(e) { return e + Math.abs(e) * 1e-12 + 1e-12; }

  /** MapLibre color expression for a vector style. */
  function colorExpr(s) {
    if (s.kind === 'categorized' && s.field) {
      const expr = ['match', ['to-string', ['get', s.field]]];
      const seen = new Set();
      (s.categories || []).forEach(function (c) {
        const key = c.value === null || c.value === undefined ? '' : String(c.value);
        if (seen.has(key)) return;
        seen.add(key);
        expr.push(key, c.color);
      });
      if (expr.length === 2) return s.otherColor || NULL_COLOR;
      expr.push(s.otherColor || '#9ca3af');
      return expr;
    }
    if (s.kind === 'graduated' && s.field && s.breaks && s.breaks.length > 1) {
      const cols = s.colors;
      const step = ['step', ['to-number', ['get', s.field], -1e300], cols[0]];
      for (let i = 1; i < cols.length; i++) step.push(nextUp(s.breaks[i]), cols[i]);
      return ['case', ['==', ['get', s.field], null], s.nullColor || NULL_COLOR, ['==', ['get', s.field], ''], s.nullColor || NULL_COLOR, step];
    }
    return s.color || '#800000';
  }
  style.colorExpr = colorExpr;

  function sizeExpr(s, fallback, layer) {
    if (!s.size || !s.size.field || !layer) return fallback;
    const vals = numericValues(layer, s.size.field).filter(function (v) { return v >= 0; });
    if (!vals.length) return fallback;
    let max = 0;
    vals.forEach(function (v) { if (v > max) max = v; });
    const lo = s.size.min !== undefined ? s.size.min : 2;
    const hi = s.size.max !== undefined ? s.size.max : 24;
    if (max <= 0) return lo;
    return ['interpolate', ['linear'], ['sqrt', ['max', 0, ['to-number', ['get', s.size.field], 0]]], 0, lo, Math.sqrt(max), hi];
  }

  function widthExpr(s, fallback, layer) {
    if (!s.size || !s.size.field || !layer) return fallback;
    const vals = numericValues(layer, s.size.field);
    if (!vals.length) return fallback;
    const st = util.stats(vals);
    const lo = s.size.min !== undefined ? s.size.min : 0.5;
    const hi = s.size.max !== undefined ? s.size.max : 10;
    if (st.max === st.min) return (lo + hi) / 2;
    return ['interpolate', ['linear'], ['to-number', ['get', s.size.field], st.min], st.min, lo, st.max, hi];
  }

  function heatColor(rampName) {
    const stops = colors.sampleRamp(rampName || 'heat', 6);
    const expr = ['interpolate', ['linear'], ['heatmap-density'], 0, 'rgba(0,0,0,0)'];
    stops.forEach(function (c, i) {
      const rgb = colors.parse(c);
      const t = 0.1 + (0.9 * i) / (stops.length - 1);
      expr.push(t, 'rgba(' + rgb[0] + ',' + rgb[1] + ',' + rgb[2] + ',' + (i === 0 ? 0.6 : 1) + ')');
    });
    return expr;
  }

  /**
   * MapLibre style layers for a vector layer. Returns [{ id, type, source,
   * filter, paint, layout }] — the source is `src` (a GeoJSON source).
   */
  style.toMapLibre = function (layer, src) {
    const s = layer.style || {};
    const g = layer.geometryType;
    const op = layer.opacity === undefined ? 1 : layer.opacity;
    const out = [];
    const id = function (suffix) { return layer.id + '::' + suffix; };
    const has = function (fam) { return g === fam || g === 'Mixed'; };
    const color = colorExpr(s);
    const dash = s.dash && s.dash.length ? s.dash : null;

    if (s.kind === 'heatmap') {
      const h = s.heat || {};
      out.push({
        id: id('heat'), type: 'heatmap', source: src, filter: GEOM_FILTER.Point,
        paint: {
          'heatmap-radius': h.radius || 20,
          'heatmap-intensity': h.intensity || 1,
          'heatmap-weight': h.weightField ? ['interpolate', ['linear'], ['to-number', ['get', h.weightField], 0], 0, 0, Math.max(1e-9, h.weightMax || 1), 1] : 1,
          'heatmap-color': heatColor(h.ramp),
          'heatmap-opacity': 0.85 * op,
        },
      });
      // polygons/lines of a mixed layer still render plainly
      if (g === 'Mixed') {
        out.push({ id: id('line'), type: 'line', source: src, filter: GEOM_FILTER.LineString, paint: { 'line-color': s.color || '#888', 'line-width': s.lineWidth || 2, 'line-opacity': op } });
      }
      return out.concat(labelLayers(layer, src, s, op));
    }

    if (has('Polygon')) {
      if (s.extrude) {
        const ex = s.extrude;
        const height = ex.field ? ['*', ['to-number', ['get', ex.field], 0], ex.scale || 1] : (ex.height || 10);
        out.push({
          id: id('extrusion'), type: 'fill-extrusion', source: src, filter: GEOM_FILTER.Polygon,
          paint: { 'fill-extrusion-color': color, 'fill-extrusion-height': height, 'fill-extrusion-base': 0, 'fill-extrusion-opacity': Math.min(1, 0.9 * op) },
        });
      } else {
        out.push({
          id: id('fill'), type: 'fill', source: src, filter: GEOM_FILTER.Polygon,
          paint: { 'fill-color': color, 'fill-opacity': (s.fillOpacity === undefined ? 0.45 : s.fillOpacity) * op },
        });
        if ((s.strokeWidth || 0) > 0) {
          const paint = { 'line-color': s.strokeColor === 'match' ? color : (s.strokeColor || '#333'), 'line-width': s.strokeWidth, 'line-opacity': op };
          if (dash) paint['line-dasharray'] = dash;
          out.push({ id: id('outline'), type: 'line', source: src, filter: GEOM_FILTER.Polygon, paint: paint, layout: { 'line-join': 'round' } });
        }
      }
    }
    if (has('LineString')) {
      const paint = { 'line-color': color, 'line-width': widthExpr(s, s.lineWidth || 2, layer), 'line-opacity': op };
      if (dash) paint['line-dasharray'] = dash;
      out.push({ id: id('line'), type: 'line', source: src, filter: GEOM_FILTER.LineString, paint: paint, layout: { 'line-join': 'round', 'line-cap': 'round' } });
    }
    if (has('Point')) {
      out.push({
        id: id('circle'), type: 'circle', source: src, filter: GEOM_FILTER.Point,
        paint: {
          'circle-color': color,
          'circle-radius': sizeExpr(s, s.radius || 5, layer),
          'circle-stroke-color': s.strokeColor || '#ffffff',
          'circle-stroke-width': s.strokeWidth === undefined ? 1 : s.strokeWidth,
          'circle-opacity': (s.size && s.size.field ? 0.75 : 0.95) * op,
          'circle-stroke-opacity': op,
        },
      });
    }
    return out.concat(labelLayers(layer, src, s, op));
  };

  function labelLayers(layer, src, s, op) {
    const L = s.labels;
    if (!L || (!L.field && !L.expression)) return [];
    const g = layer.geometryType;
    const field = L.expression ? '__label' : L.field;
    const layout = {
      'text-field': ['to-string', ['coalesce', ['get', field], '']],
      'text-font': FONT,
      'text-size': L.size || 12,
      'text-max-width': 10,
      'text-allow-overlap': !!L.overlap,
      'text-optional': true,
    };
    if (g === 'LineString') {
      layout['symbol-placement'] = 'line';
      layout['text-rotation-alignment'] = 'map';
    } else if (g === 'Point') {
      layout['text-variable-anchor'] = ['top', 'bottom', 'left', 'right'];
      layout['text-radial-offset'] = 0.8;
      layout['text-justify'] = 'auto';
    }
    return [{
      id: layer.id + '::label', type: 'symbol', source: src, layout: layout,
      paint: { 'text-color': L.color || '#1f2937', 'text-halo-color': L.halo || 'rgba(255,255,255,0.9)', 'text-halo-width': L.haloWidth === undefined ? 1.4 : L.haloWidth, 'text-opacity': op },
    }];
  }

  /* -------------------------------------------------------------- legend */

  /**
   * Legend model for the UI:
   * { title, subtitle, items: [{ color, stroke, shape: 'fill'|'line'|'point', label }], gradient: { css, min, max } }
   */
  style.legend = function (layer) {
    const s = layer.style || {};
    const shape = layer.geometryType === 'Polygon' ? 'fill' : layer.geometryType === 'LineString' ? 'line' : 'point';
    const fmt = util.formatNumber;
    if (layer.type === 'raster') {
      const st = layer.renderedStyle || s;
      if (st.mode === 'rgb') return { title: layer.name, subtitle: 'RGB ' + (st.bands || [0, 1, 2]).map(function (b) { return typeof b === 'number' ? 'b' + (b + 1) : b; }).join('/'), items: [] };
      if (st.mode === 'palette' && st.categories) {
        return { title: layer.name, items: st.categories.slice(0, 20).map(function (c) { return { color: c.color, shape: 'fill', label: c.label !== undefined ? c.label : String(c.value) }; }) };
      }
      if (st.classes && st.classes.length) {
        return { title: layer.name, items: st.classes.map(function (c, i) { return { color: c.color, shape: 'fill', label: (c.label || ('≤ ' + fmt(c.max))) }; }) };
      }
      return { title: layer.name, subtitle: layer.bandNames && layer.bandNames[st.band || 0], gradient: { css: colors.gradientCSS(st.ramp || 'viridis'), min: st.min, max: st.max } };
    }
    if (layer.type !== 'vector') return { title: layer.name, items: [] };
    if (s.kind === 'heatmap') return { title: layer.name, subtitle: 'density' + (s.heat && s.heat.weightField ? ' of ' + s.heat.weightField : ''), gradient: { css: colors.gradientCSS(s.heat && s.heat.ramp || 'heat'), min: 'low', max: 'high' } };
    const stroke = s.strokeColor;
    if (s.kind === 'categorized') {
      const items = (s.categories || []).map(function (c) { return { color: c.color, stroke: stroke, shape: shape, label: c.label }; });
      if (s.otherCount) items.push({ color: s.otherColor, stroke: stroke, shape: shape, label: 'other (' + s.otherCount + ')' });
      return { title: layer.name, subtitle: s.field, items: items };
    }
    if (s.kind === 'graduated') {
      const items = [];
      for (let i = 0; i < s.colors.length; i++) items.push({ color: s.colors[i], stroke: stroke, shape: shape, label: fmt(s.breaks[i]) + ' – ' + fmt(s.breaks[i + 1]) });
      return { title: layer.name, subtitle: s.field + (s.method ? ' (' + s.method + ')' : ''), items: items };
    }
    const hollow = shape === 'fill' && s.fillOpacity === 0;
    return { title: layer.name, items: [{ color: hollow ? 'transparent' : s.color, stroke: stroke, shape: shape, label: '' }], single: true };
  };

  /** A representative swatch colour for the layer list. */
  style.swatch = function (layer) {
    const s = layer.style || {};
    if (layer.type === 'raster') return { gradient: colors.gradientCSS((layer.renderedStyle || s).ramp || 'viridis') };
    if (layer.type === 'tiles') return { color: '#94a3b8' };
    if (s.kind === 'categorized') return { gradient: 'linear-gradient(90deg,' + (s.categories || []).slice(0, 5).map(function (c) { return c.color; }).join(',') + ')' };
    if (s.kind === 'graduated') return { gradient: 'linear-gradient(90deg,' + (s.colors || []).join(',') + ')' };
    if (s.kind === 'heatmap') return { gradient: colors.gradientCSS(s.heat && s.heat.ramp || 'heat') };
    if (layer.geometryType === 'Polygon' && s.fillOpacity === 0) return { color: 'transparent', stroke: s.strokeColor || s.color };
    return { color: s.color || '#800000', stroke: s.strokeColor };
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
