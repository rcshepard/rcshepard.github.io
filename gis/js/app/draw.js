/*
 * PSICITS — drawing, vertex editing and measuring (Terra Draw).
 * Commands: draw, edit, done, cancel, measure (interactive).
 */
(function (root) {
  'use strict';

  const M = root.PSICITS;
  const util = M.util;
  const T = M.toolkit;
  const P = T.P;
  const def = T.define;

  const draw = (M.draw = { kind: null });
  let td = null; // TerraDraw instance
  let session = null; // { kind, mode, target, fidOf: Map(tdId -> fid), layerId }
  let measureBox = null;
  let idSeq = 0;

  const MODES = { point: 'point', line: 'linestring', linestring: 'linestring', polygon: 'polygon', rectangle: 'rectangle', circle: 'circle', freehand: 'freehand', 'freehand line': 'freehand-linestring' };
  const FAMILY = { point: 'Point', linestring: 'LineString', polygon: 'Polygon', rectangle: 'Polygon', circle: 'Polygon', freehand: 'Polygon', 'freehand-linestring': 'LineString' };

  function ensure() {
    if (td) return td;
    const TD = root.terraDraw;
    const AD = root.terraDrawMaplibreGlAdapter;
    if (!TD || !AD) throw new Error('Drawing tools failed to load');
    const map = M.mapview.map;
    const accent = '#800000'; // UChicago maroon
    const editFlags = { feature: { draggable: true, coordinates: { midpoints: true, draggable: true, deletable: true } } };
    td = new TD.TerraDraw({
      adapter: new AD.TerraDrawMapLibreGLAdapter({ map: map, coordinatePrecision: 9 }),
      idStrategy: { isValidId: function (id) { return typeof id === 'string' && id.length > 0; }, getId: function () { idSeq++; return 'td' + idSeq; } },
      modes: [
        new TD.TerraDrawPointMode({ styles: { pointColor: accent, pointWidth: 6, pointOutlineColor: '#ffffff', pointOutlineWidth: 2 } }),
        new TD.TerraDrawLineStringMode({ styles: { lineStringColor: accent, lineStringWidth: 3, closingPointColor: '#ffffff' } }),
        new TD.TerraDrawPolygonMode({ styles: { fillColor: accent, fillOpacity: 0.2, outlineColor: accent, outlineWidth: 2 } }),
        new TD.TerraDrawRectangleMode({ styles: { fillColor: accent, fillOpacity: 0.2, outlineColor: accent, outlineWidth: 2 } }),
        new TD.TerraDrawCircleMode({ styles: { fillColor: accent, fillOpacity: 0.2, outlineColor: accent, outlineWidth: 2 } }),
        new TD.TerraDrawFreehandMode({ styles: { fillColor: accent, fillOpacity: 0.2, outlineColor: accent, outlineWidth: 2 } }),
        new TD.TerraDrawFreehandLineStringMode({ modeName: 'freehand-linestring', styles: { lineStringColor: accent, lineStringWidth: 3 } }),
        new TD.TerraDrawSelectMode({
          flags: { point: editFlags, linestring: editFlags, polygon: editFlags, rectangle: editFlags, circle: editFlags, freehand: editFlags },
          styles: { selectedPolygonColor: '#eaaa00', selectedPolygonFillOpacity: 0.25, selectedPolygonOutlineColor: '#eaaa00', selectedLineStringColor: '#eaaa00', selectedPointColor: '#eaaa00', selectionPointColor: '#ffffff', selectionPointOutlineColor: '#eaaa00', midPointColor: '#eaaa00' },
        }),
      ],
    });
    td.start();
    td.on('finish', onFinish);
    td.on('change', onChange);
    // Terra Draw re-adds its layers after a basemap change
    M.mapview.on('style', function () {
      if (!td) return;
      const snap = td.getSnapshot();
      const mode = td.getMode();
      try { td.stop(); } catch (e) { /* ignore */ }
      td.start();
      if (snap.length) td.addFeatures(snap);
      if (mode && mode !== 'static') td.setMode(mode);
    });
    return td;
  }

  function sketchLayer(family) {
    const name = { Point: 'sketch_points', LineString: 'sketch_lines', Polygon: 'sketch_polygons' }[family];
    const existing = M.store.get(name);
    if (existing && existing.type === 'vector') return existing;
    return M.store.add({ type: 'vector', name: name, data: { type: 'FeatureCollection', features: [] }, source: { kind: 'draw' } }, { activate: false, label: 'New sketch layer' });
  }

  function onFinish(id, context) {
    if (!session) return;
    const f = td.getSnapshotFeature(id);
    if (!f) return;
    if (session.kind === 'measure') { reportMeasure(f, true); return; }
    if (session.kind !== 'draw') return;
    if (context && context.action && context.action !== 'draw') return;
    const family = FAMILY[session.mode];
    let target = session.target ? M.store.get(session.target) : null;
    if (!target) { target = sketchLayer(family); session.target = target.id; }
    const props = {};
    (target.fields || []).forEach(function (fl) { props[fl.name] = null; });
    if (session.mode === 'circle') {
      try { props.radius_m = Math.round(root.turf.length(root.turf.lineString([f.geometry.coordinates[0][0], root.turf.centroid(f).geometry.coordinates]), { units: 'kilometers' }) * 1000); } catch (e) { /* ignore */ }
    }
    const fids = M.store.appendFeatures(target.id, [{ type: 'Feature', geometry: f.geometry, properties: props }], { label: 'Draw ' + session.mode });
    td.removeFeatures([id]);
    M.store.select(target.id, fids, 'new');
    session.count = (session.count || 0) + 1;
    M.app.emit('drawn', { layerId: target.id, fid: fids[0] });
  }

  function onChange(ids, type) {
    if (!session || session.kind !== 'measure' || !ids || !ids.length) return;
    const f = td.getSnapshotFeature(ids[ids.length - 1]);
    if (f) reportMeasure(f, false);
  }

  function fmtLen(m) { return m >= 1000 ? (m / 1000).toFixed(m >= 10000 ? 1 : 2) + ' km  ·  ' + (m / 1609.344).toFixed(2) + ' mi' : Math.round(m) + ' m  ·  ' + Math.round(m / 0.3048) + ' ft'; }
  function fmtArea(a) { return a >= 1e6 ? (a / 1e6).toFixed(2) + ' km²  ·  ' + (a / 2589988.11).toFixed(2) + ' mi²' : Math.round(a) + ' m²  ·  ' + (a / 4046.856).toFixed(2) + ' acres'; }

  function reportMeasure(f, final) {
    const g = f.geometry;
    let text = '';
    try {
      if (g.type === 'LineString' && g.coordinates.length > 1) text = fmtLen(root.turf.length(f, { units: 'kilometers' }) * 1000);
      else if (g.type === 'Polygon' && g.coordinates[0].length > 3) text = fmtArea(root.turf.area(f)) + '   (perimeter ' + fmtLen(root.turf.length(root.turf.polygonToLine(f), { units: 'kilometers' }) * 1000).split('  ·')[0] + ')';
    } catch (e) { text = ''; }
    if (measureBox) measureBox.textContent = text ? (final ? '✓ ' : '') + text : 'Click to add points, double-click to finish';
    if (final && text) M.app.output('measure').success((g.type === 'Polygon' ? 'Area: ' : 'Distance: ') + text);
  }

  function showMeasureBox(show) {
    const host = document.getElementById('ps-map');
    if (show) {
      if (!measureBox) { measureBox = document.createElement('div'); measureBox.className = 'ps-measure-box'; host.appendChild(measureBox); }
      measureBox.textContent = 'Click to add points, double-click to finish';
    } else if (measureBox) { measureBox.remove(); measureBox = null; }
  }

  /** Start drawing: mode = point | line | polygon | rectangle | circle | freehand */
  draw.start = function (mode, targetId) {
    ensure();
    draw.stop(true);
    const m = MODES[mode] || mode;
    session = { kind: 'draw', mode: m, target: targetId || null, count: 0 };
    td.setMode(m);
    M.mapview.setMode('draw');
    draw.kind = 'draw';
    M.app.emit('draw-mode', { kind: 'draw', mode: m });
  };

  draw.measure = function (kind) {
    ensure();
    draw.stop(true);
    const m = kind === 'area' ? 'polygon' : 'linestring';
    session = { kind: 'measure', mode: m };
    td.clear();
    td.setMode(m);
    M.mapview.setMode('measure');
    draw.kind = 'measure';
    showMeasureBox(true);
    M.app.emit('draw-mode', { kind: 'measure', mode: m });
  };

  /** Edit geometries of a layer (selected features, or all when small). */
  draw.edit = function (layerId) {
    ensure();
    draw.stop(true);
    const layer = M.store.require(layerId, 'vector');
    let feats = M.store.selectedFeatures(layer.id);
    if (!feats.length) {
      if (layer.count > 3000) throw new Error('"' + layer.name + '" has ' + layer.count + ' features — select the ones to edit first (click or Shift+drag), then run edit again.');
      feats = layer.data.features;
    }
    const fidOf = new Map();
    const tdFeats = [];
    let skipped = 0;
    feats.forEach(function (f) {
      if (!f.geometry) return;
      const t = f.geometry.type;
      const mode = t === 'Point' ? 'point' : t === 'LineString' ? 'linestring' : t === 'Polygon' ? 'polygon' : null;
      if (!mode) { skipped++; return; }
      const tid = 'f' + f.id;
      fidOf.set(tid, f.id);
      tdFeats.push({ type: 'Feature', id: tid, geometry: JSON.parse(JSON.stringify(f.geometry)), properties: { mode: mode } });
    });
    if (!tdFeats.length) throw new Error('No editable features (multi-part features must be exploded first: explode ' + layer.name + ')');
    td.clear();
    const res = td.addFeatures(tdFeats);
    const bad = (res || []).filter(function (r) { return r && r.valid === false; }).length;
    session = { kind: 'edit', layerId: layer.id, fidOf: fidOf, originals: new Map(feats.map(function (f) { return [f.id, f]; })) };
    M.mapview.setHidden(layer.id, new Set(fidOf.values()));
    td.setMode('select');
    M.mapview.setMode('draw');
    draw.kind = 'edit';
    M.app.emit('draw-mode', { kind: 'edit', layerId: layer.id });
    return { count: tdFeats.length - bad, skipped: skipped + bad };
  };

  /** Finish the current session. Returns a summary. */
  draw.finish = function (save) {
    if (!session) return null;
    const s = session;
    let summary = null;
    if (s.kind === 'edit' && save !== false) {
      const snap = td.getSnapshot();
      const edits = new Map();
      const seen = new Set();
      snap.forEach(function (f) {
        const fid = s.fidOf.get(f.id);
        if (fid === undefined) return;
        seen.add(fid);
        const orig = s.originals.get(fid);
        if (JSON.stringify(orig.geometry.coordinates) !== JSON.stringify(f.geometry.coordinates)) edits.set(fid, { geometry: f.geometry });
      });
      const deleted = Array.from(s.fidOf.values()).filter(function (fid) { return !seen.has(fid); });
      M.store.transaction('Edit geometries', function () {
        if (edits.size) M.store.editFeatures(s.layerId, edits, { label: 'Edit geometries' });
        if (deleted.length) M.store.deleteFeatures(s.layerId, deleted, { label: 'Delete features' });
      });
      summary = { edited: edits.size, deleted: deleted.length };
    }
    draw.stop(true);
    return summary;
  };

  draw.stop = function (quiet) {
    if (!td) return;
    const had = session;
    session = null;
    try { td.setMode('static'); } catch (e) { /* ignore */ }
    try { td.clear(); } catch (e) { /* ignore */ }
    if (had && had.kind === 'edit') M.mapview.setHidden(had.layerId, null);
    showMeasureBox(false);
    M.mapview.setMode('identify');
    draw.kind = null;
    if (had) M.app.emit('draw-mode', { kind: null });
    return had;
  };

  draw.deleteSelected = function () {
    if (!td || !session || session.kind !== 'edit') return false;
    const snap = td.getSnapshot().filter(function (f) { return f.properties && f.properties.selected; });
    if (!snap.length) return false;
    td.removeFeatures(snap.map(function (f) { return f.id; }));
    return true;
  };

  draw.session = function () { return session; };

  /* -------------------------------------------------------------- tools */

  def({
    name: 'draw', aliases: ['sketch', 'digitize', 'add feature', 'new feature'], category: 'Draw & edit', summary: 'Draw new features on the map (Esc or "done" to stop)',
    params: [
      P.choice('shape', ['point', 'line', 'polygon', 'rectangle', 'circle', 'freehand'], { required: true, aliases: { points: 'point', marker: 'point', lines: 'line', linestring: 'line', path: 'line', polygons: 'polygon', area: 'polygon', shape: 'polygon', box: 'rectangle', square: 'rectangle', rect: 'rectangle', lasso: 'freehand' } }),
      P.layer('into', { required: false, useActive: false, keywords: ['into', 'in', 'on', 'to'], description: 'Layer to add to (default: a sketch layer)' }),
    ],
    examples: ['draw polygon', 'draw point into schools', 'draw line'],
    run: function (args, ctx) {
      if (args.into) {
        const l = ctx.vector(args.into);
        const fam = FAMILY[MODES[args.shape]];
        if (l.geometryType !== 'None' && l.geometryType !== 'Mixed' && l.count && l.geometryType !== fam) throw new Error('"' + l.name + '" holds ' + l.geometryType + ' features; you are drawing a ' + args.shape + '.');
      }
      draw.start(args.shape, args.into || null);
      return 'Drawing ' + args.shape + 's' + (args.into ? ' into "' + ctx.store.get(args.into).name + '"' : '') + ' — ' + ({ point: 'click to place', line: 'click to add vertices, double-click to finish', polygon: 'click vertices, double-click (or click the first point) to close', rectangle: 'click two corners', circle: 'click the center, then the edge', freehand: 'press and drag' }[args.shape]) + '. Esc or "done" to stop.';
    },
  });

  def({
    name: 'edit', aliases: ['edit geometry', 'reshape', 'modify', 'edit vertices', 'move vertices'], category: 'Draw & edit',
    summary: 'Drag vertices of the selected features (or a small layer); "done" saves, "cancel" discards',
    params: [P.layer('layer')],
    examples: ['edit parcels'],
    run: function (args, ctx) {
      const r = draw.edit(args.layer);
      if (r.skipped) ctx.out.warn(r.skipped + ' multi-part feature(s) are not editable here (explode them first).');
      return 'Editing ' + T.plural(r.count, 'feature') + ': click one, then drag its vertices (drag a midpoint to add one, right-click a vertex to delete it). Type "done" to save or "cancel".';
    },
  });

  def({
    name: 'done', aliases: ['finish', 'save edits', 'stop', 'stop drawing', 'ok'], category: 'Draw & edit', summary: 'Finish drawing / save edits', params: [], noHistory: true,
    run: function (args, ctx) {
      const s = draw.session();
      if (!s) return 'Nothing to finish';
      const kind = s.kind;
      const r = draw.finish(true);
      if (kind === 'edit' && r) return 'Saved: ' + r.edited + ' edited, ' + r.deleted + ' deleted';
      if (kind === 'draw') return 'Stopped drawing (' + (s.count || 0) + ' added)';
      return 'Done';
    },
  });

  def({
    name: 'cancel', aliases: ['discard', 'discard edits', 'abort'], category: 'Draw & edit', summary: 'Stop drawing or editing without saving', params: [], noHistory: true,
    run: function (args, ctx) { draw.finish(false); return 'Cancelled'; },
  });

  M.app && M.app.on && M.app.on('measure', function (kind) { draw.measure(kind); });
})(typeof globalThis !== 'undefined' ? globalThis : this);
