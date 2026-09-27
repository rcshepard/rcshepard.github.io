/*
 * PSICITS — vector geoprocessing commands (wrapping PSICITS.geoops).
 * Each tool works on the whole layer, or only the selection with "selected".
 */
(function (root) {
  'use strict';

  const M = root.PSICITS;
  const util = M.util;
  const T = M.toolkit;
  const P = T.P;
  const def = T.define;
  const G = function () { return M.geoops; };

  const SEL = P.flag('selected', ['selected', 'selection', 'only-selected'], 'Use only the selected features');
  function input(ctx, layer, args) { return T.features(ctx, layer, args.selected); }
  function statOf(stats) { return (stats || []).map(function (s) { return { field: s.field, op: s.op }; }); }

  def({
    name: 'buffer', aliases: ['buf', 'buffers', 'zone around'], category: 'Vector', summary: 'Polygons at a distance around features',
    params: [P.layer('layer'), P.distance(), P.flag('dissolve', ['dissolve', 'dissolved', 'merge', 'merged', 'union']), SEL, P.as()],
    forms: ['{layer} [by] {distance}', '{distance} (around|of|from) {layer}'],
    examples: ['buffer roads 50 m', 'buffer schools 1 mi dissolve as school_zones', 'buffer parks by 400 ft selected'],
    run: function (args, ctx) {
      const l = ctx.vector(args.layer);
      ctx.progress('Buffering ' + T.plural(l.count, 'feature') + '…');
      const fc = G().buffer(input(ctx, l, args), args.distance.value, { units: args.distance.units, dissolve: args.dissolve });
      ctx.result(fc, T.outName(ctx, args, l, 'buffer_' + T.distLabel(args.distance)));
    },
  });

  def({
    name: 'rings', aliases: ['multi ring buffer', 'multiring', 'distance bands', 'ring buffer'], category: 'Vector', summary: 'Concentric distance bands (e.g. 1, 2, 5 km)',
    params: [P.layer('layer'), { name: 'distances', type: 'numbers', required: true, description: 'Distances, e.g. 500, 1000, 2000 m' }, P.flag('overlap', ['overlap', 'overlapping', 'full'], 'Full discs instead of rings'), P.as()],
    examples: ['rings stations 400, 800, 1200 m', 'rings hospital 1 2 5 mi'],
    run: function (args, ctx) {
      const l = ctx.vector(args.layer);
      const d = args.distances;
      const fc = G().multiRingBuffer(l.data, d.values, { units: d.units, dissolve: true, rings: !args.overlap });
      ctx.result(fc, T.outName(ctx, args, l, 'rings'));
    },
  });

  def({
    name: 'clip', aliases: ['cookie cut', 'cut'], category: 'Vector', summary: 'Keep only the parts inside a polygon layer (vector or raster)',
    params: [P.layer('layer', { kinds: ['vector', 'raster'] }), P.layer('clip', { useActive: false, kinds: ['vector'], geom: ['Polygon'], label: 'clip layer' }), P.flag('view', ['view', 'screen', 'extent']), SEL, P.as()],
    forms: ['[{layer}] (to|by|with|using|within|inside) {clip}', '{layer} (to|by) [the] {view}'],
    examples: ['clip roads to city', 'clip parcels by floodzone as flood_parcels', 'clip dem to county'],
    run: function (args, ctx) {
      const l = ctx.layer(args.layer);
      if (l.type === 'raster') {
        let region;
        if (args.clip) region = { fc: ctx.vector(args.clip).data };
        else if (args.view) region = { bbox: ctx.map.viewBBox() };
        else throw new Error('Clip to which polygon layer? (or "clip ' + l.name + ' to view")');
        ctx.progress('Clipping raster…');
        const r = M.raster.clip(l.raster, region, { crop: true });
        ctx.add({ type: 'raster', name: T.outName(ctx, args, l, 'clip'), raster: r, style: l.style }, { verb: 'Created' });
        return;
      }
      let clipFc;
      if (args.clip) clipFc = ctx.vector(args.clip).data;
      else if (args.view) clipFc = { type: 'FeatureCollection', features: [root.turf.bboxPolygon(ctx.map.viewBBox())] };
      else throw new Error('Clip to which polygon layer? e.g. clip ' + l.name + ' to <layer>');
      ctx.progress('Clipping…');
      const fc = G().clip(input(ctx, l, args), clipFc);
      ctx.result(fc, T.outName(ctx, args, l, 'clip'));
    },
  });

  def({
    name: 'erase', aliases: ['difference', 'subtract', 'cut out', 'remove area'], category: 'Vector', summary: 'Remove the parts that fall inside another polygon layer',
    params: [P.layer('layer'), P.layer('eraser', { useActive: false, geom: ['Polygon'], label: 'erase layer' }), SEL, P.as()],
    forms: ['{eraser} from {layer}', '{layer} (with|using|by|minus|except) {eraser}'],
    examples: ['erase water from counties', 'erase parcels with floodzone'],
    run: function (args, ctx) {
      const l = ctx.vector(args.layer);
      const e = ctx.vector(args.eraser);
      ctx.progress('Erasing…');
      ctx.result(G().erase(input(ctx, l, args), e.data), T.outName(ctx, args, l, 'erase'));
    },
  });

  def({
    name: 'intersect', aliases: ['intersection', 'overlay', 'overlap'], category: 'Vector', summary: 'Pieces where two layers overlap, with attributes from both',
    params: [P.layer('layer'), P.layer('other', { useActive: false, geom: ['Polygon'] }), SEL, P.as()],
    forms: ['{layer} (with|and|by) {other}'],
    examples: ['intersect parcels with zoning', 'intersect roads and counties'],
    run: function (args, ctx) {
      const a = ctx.vector(args.layer), b = ctx.vector(args.other);
      ctx.progress('Intersecting…');
      ctx.result(G().intersect(input(ctx, a, args), b.data, { suffix: '_' + util.slug(b.name, 6) }), T.outName(ctx, args, a, 'x_' + util.slug(b.name, 12)));
    },
  });

  def({
    name: 'union', aliases: ['overlay union', 'combine areas'], category: 'Vector', summary: 'Polygon overlay union of two layers (all pieces, attributes from both)',
    params: [P.layer('layer', { geom: ['Polygon'] }), P.layer('other', { useActive: false, geom: ['Polygon'] }), P.as()],
    forms: ['{layer} (with|and) {other}'],
    run: function (args, ctx) {
      const a = ctx.vector(args.layer), b = ctx.vector(args.other);
      ctx.progress('Computing union…');
      ctx.result(G().union(a.data, b.data, { suffix: '_' + util.slug(b.name, 6) }), T.outName(ctx, args, a, 'union'));
    },
  });

  def({
    name: 'symdiff', aliases: ['symmetric difference', 'xor'], category: 'Vector', summary: 'Areas in either layer but not both',
    params: [P.layer('layer', { geom: ['Polygon'] }), P.layer('other', { useActive: false, geom: ['Polygon'] }), P.as()],
    forms: ['{layer} (with|and) {other}'],
    run: function (args, ctx) {
      const a = ctx.vector(args.layer), b = ctx.vector(args.other);
      ctx.result(G().symDifference(a.data, b.data), T.outName(ctx, args, a, 'symdiff'));
    },
  });

  def({
    name: 'dissolve', aliases: ['aggregate', 'merge by', 'combine by', 'group'], category: 'Vector', summary: 'Merge features that share a value (or all of them), with statistics',
    params: [P.layer('layer'), { name: 'fields', type: 'fields', of: 'layer', keywords: ['by', 'on', 'per'], description: 'Group by these fields (none = merge everything)' }, { name: 'stats', type: 'stats', of: 'layer', description: 'e.g. sum population mean income' }, SEL, P.as()],
    examples: ['dissolve counties by state', 'dissolve counties by state sum population', 'dissolve parcels'],
    run: function (args, ctx) {
      const l = ctx.vector(args.layer);
      ctx.progress('Dissolving…');
      const fc = G().dissolve(input(ctx, l, args), { fields: args.fields || [], stats: statOf(args.stats) });
      ctx.result(fc, T.outName(ctx, args, l, 'dissolve' + (args.fields && args.fields.length ? '_' + args.fields.join('_') : '')));
    },
  });

  def({
    name: 'merge', aliases: ['append', 'combine', 'combine layers', 'merge layers'], category: 'Vector', summary: 'Put several layers into one',
    params: [{ name: 'layers', type: 'layers', required: true, description: 'Two or more layers' }, P.as()],
    examples: ['merge north_parks, south_parks as parks', 'merge a and b and c'],
    run: function (args, ctx) {
      if (!args.layers || args.layers.length < 2) throw new Error('Name at least two layers to merge');
      const ls = args.layers.map(function (id) { return ctx.vector(id); });
      const fc = G().merge(ls.map(function (l) { return l.data; }), { names: ls.map(function (l) { return l.name; }), sourceField: 'source_layer' });
      ctx.result(fc, ctx.name(args.as, 'merged'));
    },
  });

  def({
    name: 'centroids', aliases: ['centroid', 'center points', 'centers', 'points from polygons', 'to points'], category: 'Vector', summary: 'A point for every feature',
    params: [P.layer('layer'), P.choice('method', ['centroid', 'center_of_mass', 'point_on_surface'], { default: 'centroid', aliases: { inside: 'point_on_surface', 'point on surface': 'point_on_surface', interior: 'point_on_surface', mass: 'center_of_mass', 'center of mass': 'center_of_mass', geometric: 'centroid' } }), SEL, P.as()],
    examples: ['centroids counties', 'centroids parcels inside'],
    run: function (args, ctx) {
      const l = ctx.vector(args.layer);
      ctx.result(G().centroids(input(ctx, l, args), { method: args.method }), T.outName(ctx, args, l, 'centroids'));
    },
  });

  def({
    name: 'hull', aliases: ['convex hull', 'concave hull', 'envelope around', 'outline around'], category: 'Vector', summary: 'Convex (or concave) hull around features',
    params: [P.layer('layer'), P.flag('concave', ['concave', 'tight']), P.field('by', { keywords: ['by', 'per', 'for each'] }), P.distance('maxEdge', { required: false, keywords: ['edge', 'max'], description: 'Concave hull max edge length' }), SEL, P.as()],
    examples: ['hull stores', 'hull crimes by district', 'hull trees concave edge 200 m'],
    run: function (args, ctx) {
      const l = ctx.vector(args.layer);
      const src = input(ctx, l, args);
      let fc;
      if (args.concave || args.maxEdge) fc = G().concaveHull(src, { maxEdge: args.maxEdge ? args.maxEdge.value : undefined, units: args.maxEdge ? args.maxEdge.units : 'kilometers', groupBy: args.by });
      else fc = G().convexHull(src, { groupBy: args.by });
      ctx.result(fc, T.outName(ctx, args, l, args.concave ? 'concave' : 'hull'));
    },
  });

  def({
    name: 'bbox', aliases: ['envelope', 'bounding box', 'extent', 'envelopes', 'boxes'], category: 'Vector', summary: 'Bounding boxes (per feature, or one for the layer)',
    params: [P.layer('layer', { kinds: ['vector', 'raster'] }), P.flag('whole', ['whole', 'layer', 'all', 'single', 'one', 'total'], 'One box for the whole layer'), P.as()],
    examples: ['bbox parcels', 'bbox counties whole'],
    run: function (args, ctx) {
      const l = ctx.layer(args.layer);
      let fc;
      if (l.type === 'raster') fc = { type: 'FeatureCollection', features: [{ type: 'Feature', properties: { name: l.name }, geometry: M.raster.footprint(l.raster) }] };
      else fc = G().envelope(l.data, { perFeature: !args.whole });
      ctx.result(fc, T.outName(ctx, args, l, 'bbox'));
    },
  });

  def({
    name: 'simplify', aliases: ['generalize', 'generalise', 'smooth out'], category: 'Vector', summary: 'Remove detail (Douglas-Peucker) to a tolerance',
    params: [P.layer('layer', { geom: ['LineString', 'Polygon'] }), P.distance('tolerance', { description: 'Tolerance, e.g. 50 m' }), P.flag('hq', ['hq', 'precise', 'high-quality']), SEL, P.as()],
    examples: ['simplify coastline 200 m', 'simplify counties 1 km'],
    run: function (args, ctx) {
      const l = ctx.vector(args.layer);
      const before = util.countVertices(l.data);
      const fc = G().simplify(input(ctx, l, args), { tolerance: args.tolerance.value, units: args.tolerance.units, highQuality: args.hq });
      const layer = ctx.result(fc, T.outName(ctx, args, l, 'simple'));
      ctx.out.note('Vertices: ' + util.formatNumber(before, 0) + ' → ' + util.formatNumber(util.countVertices(layer.data), 0));
    },
  });

  def({
    name: 'smooth', aliases: ['smoothen', 'chaikin', 'round corners'], category: 'Vector', summary: 'Smooth lines and polygons',
    params: [P.layer('layer', { geom: ['LineString', 'Polygon'] }), P.integer('iterations', { default: 3, positional: true }), SEL, P.as()],
    run: function (args, ctx) {
      const l = ctx.vector(args.layer);
      ctx.result(G().smooth(input(ctx, l, args), { iterations: args.iterations }), T.outName(ctx, args, l, 'smooth'));
    },
  });

  def({
    name: 'densify', aliases: ['add vertices'], category: 'Vector', summary: 'Add vertices so no segment is longer than an interval',
    params: [P.layer('layer', { geom: ['LineString', 'Polygon'] }), P.distance('interval'), P.as()],
    run: function (args, ctx) {
      const l = ctx.vector(args.layer);
      ctx.result(G().densify(l.data, { interval: args.interval.value, units: args.interval.units }), T.outName(ctx, args, l, 'dense'));
    },
  });

  def({
    name: 'voronoi', aliases: ['thiessen', 'thiessen polygons', 'service areas', 'proximity polygons'], category: 'Vector', summary: 'Voronoi (Thiessen) polygons around points',
    params: [P.layer('layer', { geom: ['Point'] }), P.layer('clipTo', { required: false, useActive: false, geom: ['Polygon'], keywords: ['clip', 'within', 'in', 'to'] }), P.as()],
    examples: ['voronoi hospitals', 'voronoi stations clip city'],
    run: function (args, ctx) {
      const l = ctx.vector(args.layer);
      T.needGeom(l, ['Point'], 'Voronoi polygons');
      const opts = {};
      if (args.clipTo) opts.clipTo = ctx.vector(args.clipTo).data;
      ctx.result(G().voronoi(l.data, opts), T.outName(ctx, args, l, 'voronoi'));
    },
  });

  def({
    name: 'delaunay', aliases: ['tin', 'triangulate', 'triangulation'], category: 'Vector', summary: 'Delaunay triangles between points',
    params: [P.layer('layer', { geom: ['Point'] }), P.as()],
    run: function (args, ctx) {
      const l = ctx.vector(args.layer);
      ctx.result(G().delaunay(l.data), T.outName(ctx, args, l, 'tin'));
    },
  });

  def({
    name: 'explode', aliases: ['multipart to singlepart', 'split parts', 'singlepart'], category: 'Vector', summary: 'Split multi-part features into single parts',
    params: [P.layer('layer'), P.as()],
    run: function (args, ctx) { const l = ctx.vector(args.layer); ctx.result(G().explode(l.data), T.outName(ctx, args, l, 'parts')); },
  });

  def({
    name: 'lines', aliases: ['polygons to lines', 'boundaries of', 'to lines', 'outlines'], category: 'Vector', summary: 'Polygon outlines as lines',
    params: [P.layer('layer', { geom: ['Polygon'] }), P.as()],
    run: function (args, ctx) { const l = ctx.vector(args.layer); ctx.result(G().polygonsToLines(l.data), T.outName(ctx, args, l, 'lines')); },
  });
  def({
    name: 'polygons', aliases: ['lines to polygons', 'to polygons', 'polygonize'], category: 'Vector', summary: 'Close lines into polygons',
    params: [P.layer('layer', { geom: ['LineString'] }), P.as()],
    run: function (args, ctx) { const l = ctx.vector(args.layer); ctx.result(G().linesToPolygons(l.data), T.outName(ctx, args, l, 'polygons')); },
  });
  def({
    name: 'vertices', aliases: ['extract vertices', 'nodes', 'points from lines'], category: 'Vector', summary: 'Every vertex as a point',
    params: [P.layer('layer'), P.as()],
    run: function (args, ctx) { const l = ctx.vector(args.layer); ctx.result(G().extractVertices(l.data), T.outName(ctx, args, l, 'vertices')); },
  });

  def({
    name: 'points along', aliases: ['along', 'stations along', 'points every', 'interpolate points'], category: 'Vector', summary: 'Points at regular intervals along lines',
    params: [P.layer('layer', { geom: ['LineString', 'Polygon'] }), P.distance('interval', { keywords: ['every', 'each'] }), P.as()],
    forms: ['{layer} [every] {interval}'],
    examples: ['points along trail every 100 m'],
    run: function (args, ctx) {
      const l = ctx.vector(args.layer);
      ctx.result(G().pointsAlongLines(l.data, { interval: args.interval.value, units: args.interval.units, includeEnds: true }), T.outName(ctx, args, l, 'points'));
    },
  });

  def({
    name: 'intersections', aliases: ['line intersections', 'crossings', 'junctions'], category: 'Vector', summary: 'Points where lines cross',
    params: [P.layer('layer', { geom: ['LineString', 'Polygon'] }), P.layer('other', { required: false, useActive: false }), P.as()],
    forms: ['{layer} (with|and|by) {other}'],
    examples: ['intersections streets', 'intersections roads with rivers'],
    run: function (args, ctx) {
      const a = ctx.vector(args.layer);
      const b = args.other ? ctx.vector(args.other) : null;
      ctx.progress('Finding crossings…');
      ctx.result(G().lineIntersections(a.data, b ? b.data : undefined), T.outName(ctx, args, a, 'crossings'));
    },
  });

  def({
    name: 'split', aliases: ['split lines', 'break lines'], category: 'Vector', summary: 'Split lines where they cross another layer',
    params: [P.layer('layer', { geom: ['LineString'] }), P.layer('by', { required: false, useActive: false }), P.as()],
    forms: ['{layer} (by|with|at) {by}'],
    run: function (args, ctx) {
      const l = ctx.vector(args.layer);
      ctx.result(G().splitLines(l.data, args.by ? ctx.vector(args.by).data : undefined), T.outName(ctx, args, l, 'split'));
    },
  });

  def({
    name: 'spatial join', aliases: ['spatialjoin', 'sjoin', 'join by location', 'location join'], category: 'Vector',
    summary: 'Attach attributes (or counts/stats) from another layer based on location',
    params: [
      P.layer('layer', { description: 'Target layer (gets the new attributes)' }),
      P.layer('join', { useActive: false, description: 'Layer to take attributes from' }),
      P.choice('predicate', ['intersects', 'within', 'contains', 'touches', 'crosses', 'near'], { default: 'intersects', aliases: { in: 'within', inside: 'within', containing: 'contains', intersecting: 'intersects', nearby: 'near' } }),
      P.choice('mode', ['first', 'summary', 'all'], { default: 'first', aliases: { one: 'first', attributes: 'first', count: 'summary', counts: 'summary', stats: 'summary', statistics: 'summary', many: 'all', 'one to many': 'all', every: 'all' } }),
      { name: 'fields', type: 'fields', of: 'join', keywords: ['fields', 'keep', 'columns'] },
      { name: 'stats', type: 'stats', of: 'join' },
      P.distance('distance', { required: false, keywords: ['distance'] }),
      P.as(),
    ],
    forms: ['{layer} (with|to|and|from) {join}', '{join} (to|onto|into) {layer}'],
    examples: ['spatial join schools with districts', 'spatial join tracts with crimes summary sum damage', 'spatial join stores with zones fields zone_id'],
    run: function (args, ctx) {
      const t = ctx.vector(args.layer), j = ctx.vector(args.join);
      let pred = args.predicate;
      const opts = { mode: args.mode, fields: args.fields && args.fields.length ? args.fields : undefined, stats: statOf(args.stats), prefix: '' };
      if (args.stats && args.stats.length && opts.mode === 'first') opts.mode = 'summary';
      if (pred === 'near') { pred = 'within_distance'; opts.distance = args.distance ? args.distance.value : 500; opts.units = args.distance ? args.distance.units : 'meters'; }
      opts.predicate = pred;
      ctx.progress('Joining by location…');
      ctx.result(G().spatialJoin(t.data, j.data, opts), T.outName(ctx, args, t, 'join_' + util.slug(j.name, 12)));
    },
  });

  def({
    name: 'nearest', aliases: ['closest', 'distance to nearest', 'nearest neighbor', 'near', 'proximity'], category: 'Vector', summary: 'Distance to (and attributes of) the nearest feature in another layer',
    params: [P.layer('layer'), P.layer('to', { useActive: false, label: 'other layer' }), { name: 'fields', type: 'fields', of: 'to', keywords: ['fields', 'keep'] }, P.distance('max', { required: false, keywords: ['max', 'within', 'limit'] }), P.choice('units', ['meters', 'kilometers', 'miles', 'feet'], { default: 'meters', aliases: { m: 'meters', km: 'kilometers', mi: 'miles', ft: 'feet' } }), P.as()],
    forms: ['{layer} (to|from) {to}'],
    examples: ['nearest schools to hospitals', 'nearest homes to stations fields name units mi'],
    run: function (args, ctx) {
      const a = ctx.vector(args.layer), b = ctx.vector(args.to);
      ctx.progress('Finding nearest features…');
      const opts = { units: args.units, fields: args.fields && args.fields.length ? args.fields : undefined, prefix: 'nearest_' };
      if (args.max) opts.maxDistance = util.fromMeters(util.toMeters(args.max.value, args.max.units), args.units);
      ctx.result(G().nearest(a.data, b.data, opts), T.outName(ctx, args, a, 'nearest_' + util.slug(b.name, 12)));
    },
  });

  def({
    name: 'grid', aliases: ['hexgrid', 'hex grid', 'hexbin', 'fishnet', 'square grid', 'tessellate'], category: 'Vector', summary: 'Make a hexagon/square/triangle/point grid over a layer or the view',
    params: [
      P.choice('type', ['hex', 'square', 'triangle', 'point'], { default: 'hex', aliases: { hexagon: 'hex', hexagons: 'hex', hexes: 'hex', squares: 'square', fishnet: 'square', triangles: 'triangle', points: 'point', dots: 'point' } }),
      P.distance('size', { description: 'Cell size, e.g. 500 m' }),
      P.layer('over', { required: false, useActive: false, kinds: ['vector', 'raster'], keywords: ['over', 'on', 'in', 'within', 'covering', 'for'], description: 'Layer whose extent to cover (default: the view)' }),
      P.flag('clip', ['clip', 'clipped', 'mask', 'inside'], 'Keep only cells touching the layer\'s polygons'),
      P.as(),
    ],
    examples: ['grid hex 1 km over chicago', 'grid square 500 m', 'grid hex 2 mi over counties clip'],
    run: function (args, ctx) {
      let bbox = ctx.map.viewBBox(), mask;
      let base = 'view';
      if (args.over) {
        const l = ctx.layer(args.over);
        bbox = l.bbox;
        base = l.name;
        if (args.clip && l.type === 'vector') {
          if (l.geometryType === 'Polygon' || l.geometryType === 'Mixed') mask = l.data;
          else ctx.out.note('"clip" needs a polygon layer; covering the extent of "' + l.name + '" instead.');
        }
      }
      ctx.progress('Building grid…');
      const fc = G().grid(bbox, args.size.value, { type: args.type, units: args.size.units, mask: mask });
      ctx.result(fc, ctx.name(args.as, args.type + '_grid_' + T.distLabel(args.size)));
      if (base !== 'view') ctx.out.note('Count points per cell next: count <points> in ' + ctx.store.active.name);
    },
  });

  def({
    name: 'random', aliases: ['random points', 'sample points', 'scatter'], category: 'Vector', summary: 'Random points in the view, a box, or inside polygons',
    params: [P.integer('count', { required: true, positional: true }), P.layer('within', { required: false, useActive: false, keywords: ['in', 'within', 'inside', 'over'] }), P.number('seed', { keywords: ['seed'] }), P.as()],
    forms: ['{count} [points] [(in|within|inside) {within}]'],
    examples: ['random 500 points in neighborhoods', 'random 100'],
    run: function (args, ctx) {
      const opts = { seed: args.seed };
      if (args.within) {
        const l = ctx.vector(args.within);
        if (l.geometryType === 'Polygon' || l.geometryType === 'Mixed') opts.within = l.data; else opts.bbox = l.bbox;
      } else opts.bbox = ctx.map.viewBBox();
      if (args.count > 200000) throw new Error('That is a lot of points; try 200,000 or fewer');
      ctx.result(G().randomPoints(args.count, opts), ctx.name(args.as, 'random_points'));
    },
  });

  def({
    name: 'cluster', aliases: ['clusters', 'kmeans', 'dbscan', 'group points'], category: 'Vector', summary: 'Cluster points (k-means or DBSCAN) — adds a "cluster" field',
    params: [P.layer('layer', { geom: ['Point'] }), P.choice('method', ['kmeans', 'dbscan'], { default: 'kmeans', aliases: { 'k-means': 'kmeans', density: 'dbscan' } }), P.integer('k', { positional: true, preferNumber: true, description: 'Number of clusters (k-means)' }), P.distance('distance', { required: false, description: 'Neighbourhood distance (DBSCAN)' }), P.integer('min', { keywords: ['min', 'minpoints', 'min-points'], description: 'Min points per cluster (DBSCAN)' }), P.as()],
    examples: ['cluster stores kmeans 8', 'cluster crimes dbscan 200 m min 5'],
    run: function (args, ctx) {
      const l = ctx.vector(args.layer);
      T.needGeom(l, ['Point'], 'clustering');
      let fc;
      if (args.method === 'dbscan' || (args.distance && !args.k)) {
        if (!args.distance) throw new Error('DBSCAN needs a distance, e.g. cluster ' + l.name + ' dbscan 200 m');
        fc = G().dbscan(l.data, { distance: args.distance.value, units: args.distance.units, minPoints: args.min || 3 });
      } else fc = G().kmeans(l.data, { k: args.k || 5 });
      const layer = ctx.result(fc, T.outName(ctx, args, l, 'clusters'));
      ctx.run('color ' + JSON.stringify(layer.name) + ' by cluster categories');
    },
  });

  def({
    name: 'measure', aliases: ['calculate geometry', 'add area', 'add length', 'geometry attributes', 'area', 'length'], category: 'Vector',
    summary: 'Add area / length / perimeter fields — or measure on the map (measure distance | measure area)',
    params: [P.layer('layer', { required: false, useActive: false }), P.choice('mode', ['distance', 'area'], { aliases: { line: 'distance', length: 'distance', ruler: 'distance', polygon: 'area' } }), P.choice('units', ['meters', 'kilometers', 'miles', 'feet', 'hectares', 'acres', 'sqkm', 'sqmi', 'sqm', 'sqft'], { aliases: { m: 'meters', km: 'kilometers', mi: 'miles', ft: 'feet', ha: 'hectares', ac: 'acres', km2: 'sqkm', mi2: 'sqmi', m2: 'sqm', ft2: 'sqft' } }), P.as()],
    examples: ['measure parcels acres', 'measure roads miles', 'measure distance', 'measure area'],
    run: function (args, ctx) {
      if (!args.layer) {
        ctx.app.emit('measure', args.mode || 'distance');
        return 'Click on the map to measure; double-click to finish, Esc to stop.';
      }
      const l = ctx.vector(args.layer);
      const u = args.units;
      const areaU = { hectares: 'hectares', acres: 'acres', sqkm: 'sqkilometers', sqmi: 'sqmiles', sqm: 'sqmeters', sqft: 'sqfeet', kilometers: 'sqkilometers', miles: 'sqmiles', feet: 'sqfeet', meters: 'sqmeters' }[u] || 'sqmeters';
      const lenU = { kilometers: 'kilometers', miles: 'miles', feet: 'feet', meters: 'meters', sqkm: 'kilometers', sqmi: 'miles', sqft: 'feet', hectares: 'meters', acres: 'feet' }[u] || 'meters';
      const short = { sqmeters: 'm2', sqkilometers: 'km2', hectares: 'ha', acres: 'acres', sqmiles: 'mi2', sqfeet: 'ft2', meters: 'm', kilometers: 'km', miles: 'mi', feet: 'ft' };
      const fields = { area: 'area_' + short[areaU], length: 'length_' + short[lenU], perimeter: 'perim_' + short[lenU] };
      const fc = G().measure(l.data, { areaUnits: areaU, lengthUnits: lenU, fields: fields });
      if (args.as) ctx.result(fc, ctx.name(args.as));
      else ctx.store.update(l, { data: fc }, { label: 'Measure ' + l.name });
      return 'Added ' + (l.geometryType === 'Polygon' ? fields.area + ', ' + fields.perimeter : l.geometryType === 'LineString' ? fields.length : 'coordinate fields') + ' to "' + l.name + '"';
    },
  });

  def({
    name: 'validate', aliases: ['check geometry', 'check geometries', 'validity'], category: 'Vector', summary: 'Find invalid geometries (self-intersections, open rings…)',
    params: [P.layer('layer')],
    run: function (args, ctx) {
      const l = ctx.vector(args.layer);
      const r = G().validate(l.data);
      if (!r.invalid.length) return 'All ' + util.formatNumber(r.valid, 0) + ' geometries look valid';
      ctx.out.table(r.invalid.slice(0, 100).map(function (x) { return { feature: l.data.features[x.index].id, problem: x.reason }; }));
      ctx.store.select(l.id, r.invalid.map(function (x) { return l.data.features[x.index].id; }), 'new');
      return r.invalid.length + ' invalid geometr' + (r.invalid.length === 1 ? 'y' : 'ies') + ' (now selected). Fix them with: fix ' + l.name;
    },
  });
  def({
    name: 'fix', aliases: ['make valid', 'repair', 'fix geometry', 'fix geometries'], category: 'Vector', summary: 'Repair invalid geometries',
    params: [P.layer('layer'), P.as()],
    run: function (args, ctx) {
      const l = ctx.vector(args.layer);
      const fc = G().makeValid(l.data);
      if (args.as) ctx.result(fc, ctx.name(args.as));
      else ctx.store.update(l, { data: fc }, { label: 'Repair ' + l.name });
      return 'Repaired geometries in "' + l.name + '"';
    },
  });
})(typeof globalThis !== 'undefined' ? globalThis : this);
