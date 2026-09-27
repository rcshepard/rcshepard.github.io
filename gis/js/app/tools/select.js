/*
 * PSICITS — selection, filters, statistics and attribute editing.
 */
(function (root) {
  'use strict';

  const M = root.PSICITS;
  const util = M.util;
  const T = M.toolkit;
  const P = T.P;
  const def = T.define;

  const PREDICATES = ['intersects', 'within', 'contains', 'touches', 'crosses', 'overlaps', 'disjoint', 'near'];
  const PRED_ALIASES = {
    intersecting: 'intersects', intersect: 'intersects', overlapping: 'intersects', touching: 'touches', crossing: 'crosses', cross: 'crosses',
    in: 'within', inside: 'within', 'within the': 'within', containing: 'contains', contain: 'contains', 'that contain': 'contains', outside: 'disjoint', 'not in': 'disjoint',
    'away from': 'disjoint', 'not touching': 'disjoint', nearby: 'near', close: 'near', 'close to': 'near', 'within distance': 'near', 'near to': 'near',
  };
  T.PREDICATES = PREDICATES;

  function names(fc) { return M.expr.fieldsOf(fc); }

  def({
    name: 'select', aliases: ['query', 'pick features', 'highlight'], category: 'Select & query',
    summary: 'Select features by attributes (where …) or by location (within / intersecting / near another layer)',
    params: [
      P.layer('layer'),
      P.where(),
      P.choice('predicate', PREDICATES, { aliases: PRED_ALIASES, description: 'Spatial relation: intersects, within, contains, touches, crosses, near, disjoint' }),
      P.layer('other', { required: false, useActive: false, description: 'The other layer (for spatial selection)' }),
      P.distance('distance', { required: false, keywords: ['distance'], description: 'For "near": how close (default 500 m)' }),
      P.choice('mode', ['new', 'add', 'remove', 'subset'], { default: 'new', aliases: { also: 'add', plus: 'add', more: 'add', minus: 'remove', except: 'remove', refine: 'subset', 'from selection': 'subset', 'within selection': 'subset' } }),
      P.flag('all', ['all', 'everything'], 'Select every feature'),
    ],
    forms: ['{layer} {predicate} {other}', '{layer} within {distance} of {other}', '{layer} (near|around) {other} [within] [{distance}]'],
    examples: ["select counties where population > 100000", "select parks within neighborhoods", "select schools within 500 m of highways", "select parcels intersecting floodzone add", 'select all roads'],
    run: function (args, ctx) {
      const l = ctx.vector(args.layer);
      const feats = l.data.features;
      let idx;
      let how;
      if (args.all) { idx = feats.map(function (_, i) { return i; }); how = 'all'; }
      else if (args.where) {
        const warnings = [];
        idx = M.expr.filter(l.data, args.where, { warnings: warnings });
        warnings.forEach(function (w) { ctx.out.warn(w); });
        how = 'where ' + args.where;
      } else if (args.other || args.predicate) {
        if (!args.other) throw new Error('Select relative to which layer? e.g. select ' + l.name + ' within <layer>');
        const o = ctx.vector(args.other);
        let pred = args.predicate || 'intersects';
        const opts = {};
        if (pred === 'near' || (args.distance && pred === 'within')) {
          pred = 'within_distance';
          opts.distance = args.distance ? args.distance.value : 500;
          opts.units = args.distance ? args.distance.units : 'meters';
        }
        opts.predicate = pred;
        ctx.progress('Comparing with "' + o.name + '"…');
        idx = M.geoops.selectByLocation(l.data, o.data, opts);
        how = (pred === 'within_distance' ? 'within ' + opts.distance + ' ' + opts.units + ' of' : pred) + ' "' + o.name + '"';
      } else {
        throw new Error('Select how? Try: select ' + l.name + ' where <expression> — or: select ' + l.name + ' within <layer>');
      }
      const fids = idx.map(function (i) { return feats[i].id; });
      const mode = args.mode === 'subset' ? 'intersect' : args.mode;
      const n = ctx.store.select(l.id, fids, mode);
      ctx.store.setActive(l.id);
      ctx.app.emit('selection-made', { layerId: l.id });
      return 'Selected ' + util.formatNumber(n, 0) + ' of ' + util.formatNumber(feats.length, 0) + ' features in "' + l.name + '"' + (mode !== 'new' ? ' (' + args.mode + ')' : '') + (how && how !== 'all' ? ' — ' + how : '');
    },
  });

  def({
    name: 'deselect', aliases: ['clear selection', 'unselect', 'select none', 'deselect all', 'none'], category: 'Select & query', summary: 'Clear the selection',
    params: [P.layer('layer', { required: false, useActive: false })],
    run: function (args, ctx) {
      ctx.store.clearSelection(args.layer || undefined);
      ctx.map.closePopup();
    },
  });

  def({
    name: 'invert', aliases: ['invert selection', 'switch selection', 'reverse selection'], category: 'Select & query', summary: 'Invert the selection',
    params: [P.layer('layer')],
    run: function (args, ctx) {
      const l = ctx.vector(args.layer);
      const sel = new Set(ctx.store.selectedIds(l.id));
      const fids = l.data.features.filter(function (f) { return !sel.has(f.id); }).map(function (f) { return f.id; });
      const n = ctx.store.select(l.id, fids, 'new');
      return 'Selected ' + util.formatNumber(n, 0) + ' features';
    },
  });

  def({
    name: 'filter', aliases: ['show only', 'definition query', 'display filter', 'only show'], category: 'Select & query', summary: 'Only draw features matching an expression (data is kept)',
    params: [P.layer('layer'), P.where({ keywords: ['where', 'to'] }), P.flag('off', ['off', 'none', 'clear', 'remove', 'reset'])],
    examples: ["filter quakes where mag >= 4", 'filter quakes off'],
    run: function (args, ctx) {
      const l = ctx.vector(args.layer);
      if (args.off || !args.where) {
        ctx.store.update(l, { filter: null }, { label: 'Clear filter ' + l.name });
        return 'Showing all features of "' + l.name + '"';
      }
      const n = M.expr.filter(l.data, args.where).length;
      ctx.store.update(l, { filter: args.where }, { label: 'Filter ' + l.name });
      return 'Showing ' + util.formatNumber(n, 0) + ' of ' + util.formatNumber(l.count, 0) + ' features of "' + l.name + '"';
    },
  });
  def({
    name: 'unfilter', aliases: ['show all features', 'clear filter', 'remove filter'], category: 'Select & query', summary: 'Remove a display filter',
    params: [P.layer('layer')],
    run: function (args, ctx) { const l = ctx.vector(args.layer); ctx.store.update(l, { filter: null }, { label: 'Clear filter ' + l.name }); },
  });

  def({
    name: 'extract', aliases: ['subset', 'save selection', 'export selection', 'copy selected', 'selection to layer', 'new layer from selection'], category: 'Select & query',
    summary: 'Copy selected (or matching) features into a new layer',
    params: [P.layer('layer'), P.where(), P.as()],
    examples: ['extract counties where state = \'IL\' as illinois', 'extract parcels as selected_parcels'],
    run: function (args, ctx) {
      const l = ctx.vector(args.layer);
      let feats;
      if (args.where) feats = M.expr.filter(l.data, args.where).map(function (i) { return l.data.features[i]; });
      else {
        feats = ctx.store.selectedFeatures(l.id);
        if (!feats.length) throw new Error('Nothing is selected in "' + l.name + '". Select features first, or add: where <expression>');
      }
      ctx.result({ type: 'FeatureCollection', features: feats.map(function (f) { return { type: 'Feature', properties: Object.assign({}, f.properties), geometry: f.geometry }; }) }, T.outName(ctx, args, l, 'subset'));
    },
  });

  def({
    name: 'count', aliases: ['how many', 'count points', 'points in polygons', 'count features'], category: 'Select & query',
    summary: 'Count features (optionally where …) — or count points inside each polygon',
    params: [P.layer('points'), P.layer('polygons', { required: false, useActive: false, geom: ['Polygon'] }), P.where(), P.field('weight', { of: 'points', keywords: ['weight', 'weighted', 'sum'] }), P.as()],
    forms: ['{points} (in|within|per|by|inside|for each|for) {polygons}'],
    examples: ['count quakes', "count quakes where mag > 4", 'count crimes in neighborhoods', 'count trees per parks as tree_counts'],
    run: function (args, ctx) {
      const pts = ctx.vector(args.points);
      if (args.polygons) {
        const polys = ctx.vector(args.polygons);
        T.needGeom(polys, ['Polygon'], 'counting in areas');
        let src = pts.data;
        if (args.where) src = { type: 'FeatureCollection', features: M.expr.filter(pts.data, args.where).map(function (i) { return pts.data.features[i]; }) };
        ctx.progress('Counting…');
        const field = util.slug(pts.name, 24) + '_count';
        const fc = M.geoops.countPointsInPolygons(polys.data, src, { field: field, weightField: args.weight });
        const layer = ctx.result(fc, T.outName(ctx, args, polys, 'counts'));
        const tot = fc.features.reduce(function (s, f) { return s + (f.properties[field] || 0); }, 0);
        ctx.out.note('New field "' + field + '" · total ' + util.formatNumber(tot) + '. Color it: color ' + layer.name + ' by ' + field);
        return;
      }
      const n = args.where ? M.expr.filter(pts.data, args.where).length : pts.count;
      return '"' + pts.name + '": ' + util.formatNumber(n, 0) + (args.where ? ' of ' + util.formatNumber(pts.count, 0) : '') + ' features' + (args.where ? ' where ' + args.where : '');
    },
  });

  def({
    name: 'stats', aliases: ['statistics', 'summary', 'summarize', 'describe field', 'field stats', 'group by'], category: 'Select & query',
    summary: 'Statistics of a field, optionally grouped by another field',
    params: [
      P.layer('layer'),
      P.field('field', { positional: true, description: 'Numeric field (or any field for counts)' }),
      P.field('by', { keywords: ['by', 'per', 'grouped'], description: 'Group by this field' }),
      P.flag('selected', ['selected', 'selection']),
    ],
    examples: ['stats counties population', 'stats counties population by state', 'stats parcels by zoning'],
    run: function (args, ctx) {
      const l = ctx.vector(args.layer);
      const fc = T.features(ctx, l, args.selected);
      if (args.by) {
        const stats = args.field && M.style.isNumericField(l, args.field) ? ['sum', 'mean', 'min', 'max'].map(function (op) { return { field: args.field, op: op }; }) : [];
        const rows = M.geoops.summarize(fc, { groupBy: [args.by], stats: stats });
        rows.sort(function (a, b) { return b.count - a.count; });
        ctx.out.table(rows.map(function (r) { const o = {}; Object.keys(r).forEach(function (k) { o[k] = typeof r[k] === 'number' ? util.formatNumber(r[k]) : r[k]; }); return o; }));
        return;
      }
      if (!args.field) throw new Error('Which field? e.g. stats ' + l.name + ' <field>');
      const vals = util.values(fc, args.field);
      if (M.style.isNumericField(l, args.field)) {
        const s = util.stats(vals);
        ctx.out.kv({ field: args.field, count: s.count, nulls: s.nulls, min: util.formatNumber(s.min), max: util.formatNumber(s.max), sum: util.formatNumber(s.sum), mean: util.formatNumber(s.mean), median: util.formatNumber(s.median), 'std dev': util.formatNumber(s.std), 'q1 / q3': util.formatNumber(s.q1) + ' / ' + util.formatNumber(s.q3) });
        const nums = vals.map(Number).filter(function (v, i) { return vals[i] !== null && vals[i] !== '' && isFinite(v); });
        if (nums.length > 1) ctx.out.histogram(nums, { bins: 16, label: args.field });
      } else {
        const fr = util.frequencies(vals, 25);
        ctx.out.table(fr.map(function (x) { return { value: x.value === null ? '(null)' : x.value, count: x.count, share: (x.count / vals.length * 100).toFixed(1) + '%' }; }));
      }
    },
  });

  def({
    name: 'unique', aliases: ['values', 'distinct', 'frequency', 'categories'], category: 'Select & query', summary: 'Distinct values of a field with counts',
    params: [P.layer('layer'), P.field('field', { positional: true, required: true })],
    run: function (args, ctx) {
      const l = ctx.vector(args.layer);
      const vals = util.values(l.data, args.field);
      const fr = util.frequencies(vals);
      ctx.out.text(fr.length + ' distinct value(s) of ' + args.field);
      ctx.out.table(fr.slice(0, 200).map(function (x) { return { value: x.value === null ? '(null)' : x.value, count: x.count }; }));
    },
  });

  def({
    name: 'histogram', aliases: ['hist', 'distribution'], category: 'Select & query', summary: 'Histogram of a numeric field (or raster band)',
    params: [P.layer('layer', { kinds: ['vector', 'raster'] }), P.field('field', { positional: true }), P.integer('bins', { keywords: ['bins'], default: 20 }), P.integer('band', { keywords: ['band'] })],
    run: function (args, ctx) {
      const l = ctx.layer(args.layer);
      if (l.type === 'raster') {
        const b = args.band ? args.band - 1 : 0;
        const h = M.raster.histogram(l.raster, b, args.bins);
        ctx.out.histogramBins(h.edges, h.counts, { label: l.bandNames[b] || 'band ' + (b + 1) });
        return;
      }
      if (!args.field) throw new Error('Which field?');
      const vals = util.values(l.data, args.field).filter(function (v) { return v !== null && v !== '' && isFinite(Number(v)); }).map(Number);
      if (!vals.length) throw new Error('"' + args.field + '" has no numbers');
      ctx.out.histogram(vals, { bins: args.bins, label: args.field });
    },
  });

  /* ------------------------------------------------------ attributes */

  def({
    name: 'calc', aliases: ['calculate', 'compute', 'field calculator', 'set', 'update field', 'add field', 'new field', 'create field'], category: 'Attributes',
    summary: 'Create or update a field with an expression: calc <layer> <field> = <expression>',
    params: [
      P.layer('layer'),
      { name: 'field', type: 'name', required: true, positional: true, noNameKeyword: true, description: 'Field to create or update' },
      { name: 'expression', type: 'expression', keywords: ['=', 'to', 'as', ':='], description: 'Expression, e.g. population / area_km2' },
      { name: 'only', type: 'expression', keywords: ['where', 'if', 'for'], description: 'Only update features matching this' },
      P.choice('type', ['number', 'integer', 'text', 'boolean'], { keys: ['type'], aliases: { int: 'integer', real: 'number', float: 'number', double: 'number', string: 'text', str: 'text', bool: 'boolean' } }),
    ],
    kvFallback: function (tok, args) {
      if (args.field === undefined && args.expression === undefined) { args.field = tok.key; args.expression = tok.v; return true; }
      return false;
    },
    usage: 'calc <layer> <field> = <expression> [where <condition>]',
    examples: ['calc counties density = population / (area / 1e6)', 'calc parcels area_ha = round($area / 10000, 2)', "calc roads speed = 25 where type = 'residential'", 'calc cities label = upper(name)', 'add field parcels notes text'],
    run: function (args, ctx) {
      const l = ctx.vector(args.layer);
      const field = String(args.field).replace(/^"(.*)"$/, '$1').trim();
      if (!field) throw new Error('Name the field to calculate');
      const expr = args.expression === undefined || args.expression === '' ? 'NULL' : args.expression;
      const fields = names(l.data).concat([field]);
      const compiled = M.expr.compile(expr, { fields: fields, collection: l.data });
      compiled.warnings.forEach(function (w) { ctx.out.warn(w); });
      let mask = null;
      if (args.only) mask = new Set(M.expr.filter(l.data, args.only));
      const cast = { integer: function (v) { return v === null ? null : Math.round(Number(v)); }, number: function (v) { return v === null || v === '' ? null : Number(v); }, text: function (v) { return v === null ? null : String(v); }, boolean: function (v) { return v === null ? null : M.expr.toBool(v); } }[args.type] || function (v) { return v; };
      let errors = 0, set = 0;
      const feats = l.data.features.map(function (f, i) {
        if (mask && !mask.has(i)) {
          if (f.properties[field] === undefined) return { type: 'Feature', id: f.id, geometry: f.geometry, properties: Object.assign({}, f.properties, { [field]: null }) };
          return f;
        }
        let v;
        try { v = compiled.fn(f, i); } catch (e) { errors++; v = null; }
        if (typeof v === 'number' && !isFinite(v)) v = null;
        set++;
        return { type: 'Feature', id: f.id, geometry: f.geometry, properties: Object.assign({}, f.properties, { [field]: cast(v === undefined ? null : v) }) };
      });
      const existed = l.fields.some(function (f) { return f.name === field; });
      ctx.store.update(l, { data: { type: 'FeatureCollection', features: feats } }, { label: 'Calculate ' + field });
      if (errors) ctx.out.warn(errors + ' feature(s) could not be computed and were set to NULL.');
      const sample = feats.slice(0, 5).map(function (f) { return f.properties[field]; });
      return (existed ? 'Updated' : 'Added') + ' field "' + field + '" on ' + util.formatNumber(set, 0) + ' features · e.g. ' + sample.map(function (v) { return v === null ? 'null' : typeof v === 'number' ? util.formatNumber(v) : JSON.stringify(v); }).join(', ');
    },
  });

  def({
    name: 'drop field', aliases: ['delete field', 'remove field', 'delete fields', 'drop fields', 'remove fields'], category: 'Attributes', summary: 'Delete fields',
    params: [P.layer('layer'), { name: 'fields', type: 'fields', of: 'layer', required: true, positional: true, description: 'Field(s) to delete' }],
    examples: ['delete field counties shape_area', 'drop fields parcels a, b, c'],
    run: function (args, ctx) {
      const l = ctx.vector(args.layer);
      const kill = new Set(args.fields);
      const feats = l.data.features.map(function (f) {
        const p = {};
        Object.keys(f.properties).forEach(function (k) { if (!kill.has(k)) p[k] = f.properties[k]; });
        return { type: 'Feature', id: f.id, geometry: f.geometry, properties: p };
      });
      ctx.store.update(l, { data: { type: 'FeatureCollection', features: feats } }, { label: 'Delete fields' });
      return 'Deleted ' + args.fields.join(', ');
    },
  });

  def({
    name: 'rename field', aliases: ['rename column'], category: 'Attributes', summary: 'Rename a field',
    params: [P.layer('layer'), P.field('field', { positional: true, required: true }), { name: 'to', type: 'name', keywords: ['to', 'as'], required: true }],
    forms: ['{layer} {field} (to|as) {to}'],
    examples: ['rename field counties NAME to county_name'],
    run: function (args, ctx) {
      const l = ctx.vector(args.layer);
      if (l.fields.some(function (f) { return f.name === args.to; })) throw new Error('Field "' + args.to + '" already exists');
      const feats = l.data.features.map(function (f) {
        const p = {};
        Object.keys(f.properties).forEach(function (k) { p[k === args.field ? args.to : k] = f.properties[k]; });
        return { type: 'Feature', id: f.id, geometry: f.geometry, properties: p };
      });
      const s = l.style ? JSON.parse(JSON.stringify(l.style).split('"' + args.field + '"').join('"' + args.to + '"')) : l.style;
      ctx.store.update(l, { data: { type: 'FeatureCollection', features: feats }, style: s }, { label: 'Rename field' });
    },
  });

  def({
    name: 'join', aliases: ['table join', 'attribute join', 'join table', 'merge attributes'], category: 'Attributes',
    summary: 'Attach attributes from a table (or layer) by matching a key field',
    params: [
      P.layer('layer', { kinds: ['vector'] }),
      P.layer('table', { kinds: ['vector'], useActive: false, description: 'Table or layer to take attributes from' }),
      { name: 'on', type: 'text', keywords: ['on', 'using', 'by', 'where'], required: true, description: 'Key field, or left = right when the names differ' },
      { name: 'fields', type: 'fields', of: 'table', keywords: ['fields', 'columns', 'keep'], description: 'Only copy these fields' },
      P.as(),
    ],
    forms: ['{layer} (with|to|and|from) {table}', '{table} (to|into|onto) {layer}'],
    examples: ['join counties with census on GEOID', 'join tracts with acs on GEOID = geoid10 fields income, poverty'],
    run: function (args, ctx) {
      const l = ctx.vector(args.layer);
      const t = ctx.vector(args.table);
      const parts = String(args.on).split(/\s*=+\s*/);
      const lf = M.commands.findField(parts[0].replace(/^"|"$/g, ''), l.fields.map(function (f) { return f.name; }));
      const rf = M.commands.findField((parts[1] || parts[0]).replace(/^"|"$/g, ''), t.fields.map(function (f) { return f.name; }));
      if (lf === null) throw new Error('"' + l.name + '" has no field "' + parts[0] + '"');
      if (rf === null) throw new Error('"' + t.name + '" has no field "' + (parts[1] || parts[0]) + '"');
      const norm = function (v) { if (v === null || v === undefined) return null; const s = String(v).trim(); return /^-?\d+(\.0+)?$/.test(s) ? String(parseInt(s, 10)) : s.toLowerCase(); };
      const index = new Map();
      t.data.features.forEach(function (f) { const k = norm(f.properties[rf]); if (k !== null && !index.has(k)) index.set(k, f.properties); });
      const copy = args.fields && args.fields.length ? args.fields : t.fields.map(function (f) { return f.name; }).filter(function (n) { return n !== rf; });
      const existing = new Set(l.fields.map(function (f) { return f.name; }));
      const rename = {};
      copy.forEach(function (c) { rename[c] = existing.has(c) ? c + '_' + util.slug(t.name, 6) : c; });
      let matched = 0;
      const feats = l.data.features.map(function (f) {
        const hit = index.get(norm(f.properties[lf]));
        const p = Object.assign({}, f.properties);
        copy.forEach(function (c) { p[rename[c]] = hit && hit[c] !== undefined ? hit[c] : null; });
        if (hit) matched++;
        return { type: 'Feature', id: f.id, geometry: f.geometry, properties: p };
      });
      const fc = { type: 'FeatureCollection', features: feats };
      if (args.as) ctx.result(fc, ctx.name(args.as));
      else ctx.store.update(l, { data: fc }, { label: 'Join ' + t.name });
      const msg = 'Joined ' + copy.length + ' field(s) from "' + t.name + '": ' + util.formatNumber(matched, 0) + ' of ' + util.formatNumber(feats.length, 0) + ' features matched';
      if (!matched) ctx.out.warn('No keys matched. Check that ' + lf + ' and ' + rf + ' hold the same kind of codes (e.g. leading zeros).');
      return msg;
    },
  });

  def({
    name: 'delete', aliases: ['delete features', 'remove features', 'delete selected', 'erase features'], category: 'Draw & edit',
    summary: 'Delete the selected features (or those matching where …)',
    params: [P.layer('layer'), P.where(), P.flag('selected', ['selected', 'selection'])],
    examples: ['delete selected', 'delete parcels where area < 10'],
    run: async function (args, ctx) {
      const l = ctx.vector(args.layer);
      let fids;
      if (args.where) fids = M.expr.filter(l.data, args.where).map(function (i) { return l.data.features[i].id; });
      else fids = ctx.store.selectedIds(l.id);
      if (!fids.length) throw new Error(args.where ? 'No features match' : 'Nothing is selected in "' + l.name + '". (To delete the whole layer, use: remove ' + l.name + ')');
      if (fids.length > 50 && !(await ctx.confirm('Delete ' + fids.length + ' features from "' + l.name + '"? (Undo can restore them.)', { danger: true, ok: 'Delete' }))) return 'Cancelled';
      const n = ctx.store.deleteFeatures(l.id, fids);
      return 'Deleted ' + T.plural(n, 'feature') + ' (undo to restore)';
    },
  });
})(typeof globalThis !== 'undefined' ? globalThis : this);
