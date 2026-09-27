/*
 * PSICITS — map view: MapLibre GL, basemaps, rendering of store layers,
 * selection highlight, identify/select interactions.
 */
(function (root) {
  'use strict';

  const M = root.PSICITS;
  const util = M.util;
  const store = M.store;

  const GLYPHS = 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf';
  const OSM_ATTR = '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors';

  const BASEMAPS = {
    light: { label: 'Light (Positron)', style: 'https://tiles.openfreemap.org/styles/positron', dark: false },
    streets: { label: 'Streets (Liberty)', style: 'https://tiles.openfreemap.org/styles/liberty', dark: false },
    bright: { label: 'Bright', style: 'https://tiles.openfreemap.org/styles/bright', dark: false },
    dark: { label: 'Dark', style: 'https://tiles.openfreemap.org/styles/dark', dark: true },
    fiord: { label: 'Fiord (dark blue)', style: 'https://tiles.openfreemap.org/styles/fiord', dark: true },
    satellite: {
      label: 'Satellite (Esri)', dark: true,
      raster: { tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'], maxzoom: 19, attribution: 'Imagery © Esri, Maxar, Earthstar Geographics, and the GIS User Community' },
    },
    topo: {
      label: 'Topographic (OpenTopoMap)', dark: false,
      raster: { tiles: ['https://a.tile.opentopomap.org/{z}/{x}/{y}.png', 'https://b.tile.opentopomap.org/{z}/{x}/{y}.png', 'https://c.tile.opentopomap.org/{z}/{x}/{y}.png'], maxzoom: 17, attribution: OSM_ATTR + ', SRTM | style © <a href="https://opentopomap.org" target="_blank" rel="noopener">OpenTopoMap</a> (CC-BY-SA)' },
    },
    osm: {
      label: 'OpenStreetMap', dark: false,
      raster: { tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'], maxzoom: 19, attribution: OSM_ATTR },
    },
    none: { label: 'None (blank)', dark: false, blank: '#eef0f3' },
    'none-dark': { label: 'None (dark)', dark: true, blank: '#16181d' },
  };
  const BASEMAP_ALIASES = { positron: 'light', grey: 'light', gray: 'light', liberty: 'streets', street: 'streets', default: 'light', imagery: 'satellite', aerial: 'satellite', esri: 'satellite', terrain: 'topo', topographic: 'topo', opentopomap: 'topo', openstreetmap: 'osm', blank: 'none', off: 'none', black: 'none-dark' };

  const view = (M.mapview = {
    BASEMAPS: BASEMAPS,
    map: null,
    basemap: 'light',
    mode: 'identify',
    ready: false,
  });

  let map = null;
  let popup = null;
  const rasterCanvases = new Map(); // layerId -> canvas
  let pendingSync = new Set();
  let syncScheduled = false;

  /* -------------------------------------------------------------- init */

  view.init = function (container, opts) {
    opts = opts || {};
    if (!root.maplibregl) throw new Error('MapLibre GL failed to load');
    // Start over Chicago (University of Chicago classes); the first layer loaded re-centres the map.
    const start = opts.view || { center: [-87.66, 41.84], zoom: 9.6 };
    view.basemap = normalizeBasemap(opts.basemap) || 'light';
    map = new root.maplibregl.Map({
      container: container,
      style: basemapStyle(view.basemap),
      center: start.center,
      zoom: start.zoom,
      bearing: start.bearing || 0,
      pitch: start.pitch || 0,
      attributionControl: false,
      boxZoom: false,
      maxPitch: 75,
      hash: false,
      canvasContextAttributes: { preserveDrawingBuffer: false },
    });
    view.map = map;
    map.addControl(new root.maplibregl.AttributionControl({ compact: true, customAttribution: '<a href="https://maplibre.org" target="_blank" rel="noopener">MapLibre</a>' }), 'bottom-right');
    map.addControl(new root.maplibregl.NavigationControl({ visualizePitch: true }), 'top-right');
    try { map.addControl(new root.maplibregl.GeolocateControl({ positionOptions: { enableHighAccuracy: true }, trackUserLocation: false }), 'top-right'); } catch (e) { /* not available */ }
    view.scale = new root.maplibregl.ScaleControl({ maxWidth: 120, unit: 'metric' });
    map.addControl(view.scale, 'bottom-left');

    map.on('style.load', function () {
      view.ready = true;
      rebuild();
      view.emit('style');
    });
    map.on('error', function (e) {
      const msg = (e && e.error && e.error.message) || '';
      if (!view.ready && /style|fetch|Failed|NetworkError|load/i.test(msg)) {
        // Basemap unreachable (offline or file://) — fall back to a blank map.
        if (view.basemap !== 'none') {
          view.basemap = 'none';
          map.setStyle(basemapStyle('none'));
          view.emit('notice', 'Basemap could not be loaded (offline?). Using a blank background.');
        }
      }
    });
    wireInteractions();
    subscribe();
    return map;
  };

  // minimal event bus for UI
  const bus = util.Emitter();
  view.on = bus.on.bind(bus);
  view.emit = bus.emit;

  function normalizeBasemap(name) {
    if (!name) return null;
    const n = String(name).toLowerCase().trim();
    if (BASEMAPS[n]) return n;
    if (BASEMAP_ALIASES[n]) return BASEMAP_ALIASES[n];
    return null;
  }
  view.normalizeBasemap = normalizeBasemap;

  function basemapStyle(name) {
    const b = BASEMAPS[name] || BASEMAPS.light;
    if (b.style) return b.style;
    if (b.raster) {
      return {
        version: 8, glyphs: GLYPHS,
        sources: { basemap: { type: 'raster', tiles: b.raster.tiles, tileSize: 256, maxzoom: b.raster.maxzoom || 19, attribution: b.raster.attribution } },
        layers: [{ id: 'basemap', type: 'raster', source: 'basemap' }],
      };
    }
    return { version: 8, glyphs: GLYPHS, sources: {}, layers: [{ id: 'background', type: 'background', paint: { 'background-color': b.blank || '#eef0f3' } }] };
  }

  /** Switch basemap by name, or use a custom XYZ template URL. */
  view.setBasemap = function (name) {
    let style;
    const n = normalizeBasemap(name);
    if (n) { view.basemap = n; style = basemapStyle(n); }
    else if (/\{z\}/.test(String(name))) {
      view.basemap = 'custom';
      style = { version: 8, glyphs: GLYPHS, sources: { basemap: { type: 'raster', tiles: [String(name)], tileSize: 256 } }, layers: [{ id: 'basemap', type: 'raster', source: 'basemap' }] };
    } else throw new Error('Unknown basemap "' + name + '". Options: ' + Object.keys(BASEMAPS).join(', ') + ' — or an XYZ URL with {z}/{x}/{y}.');
    view.ready = false;
    map.setStyle(style, { diff: false });
    document.documentElement.classList.toggle('dark-basemap', !!(BASEMAPS[view.basemap] && BASEMAPS[view.basemap].dark));
    view.emit('basemap', view.basemap);
    return view.basemap;
  };

  /* ------------------------------------------------------ layer syncing */

  function srcId(layer) { return 'src::' + layer.id; }
  function mlLayersOf(layerId) {
    const st = map.getStyle();
    if (!st) return [];
    return st.layers.filter(function (l) { return l.id.startsWith(layerId + '::'); }).map(function (l) { return l.id; });
  }
  view.mlLayersOf = mlLayersOf;

  const hidden = new Map(); // layerId -> Set(fid) temporarily not drawn (being edited)
  view.setHidden = function (layerId, set) {
    if (set && set.size) hidden.set(layerId, set); else hidden.delete(layerId);
    const l = store.get(layerId);
    if (l) scheduleSync(l);
  };

  function vectorSourceData(layer) {
    let feats = layer.data.features;
    const hide = hidden.get(layer.id);
    if (hide) feats = feats.filter(function (f) { return !hide.has(f.id); });
    if (layer.filter) {
      try {
        const idx = M.expr.filter(layer.data, layer.filter);
        feats = idx.map(function (i) { return feats[i]; });
      } catch (e) { /* invalid filter: show everything */ }
    }
    const L = layer.style && layer.style.labels;
    let labelFn = null;
    if (L && L.expression) {
      try {
        const c = M.expr.compile(L.expression, { fields: M.expr.fieldsOf(layer.data), collection: layer.data });
        labelFn = c.fn;
      } catch (e) { labelFn = null; }
    }
    const out = [];
    for (let i = 0; i < feats.length; i++) {
      const f = feats[i];
      if (!f.geometry) continue;
      if (labelFn) {
        const p = Object.assign({}, f.properties);
        let v = null;
        try { v = labelFn(f, i); } catch (e) { v = null; }
        p.__label = v === null || v === undefined ? '' : (typeof v === 'number' ? util.formatNumber(v) : String(v));
        out.push({ type: 'Feature', id: f.id, geometry: f.geometry, properties: p });
      } else out.push(f);
    }
    return { type: 'FeatureCollection', features: out };
  }

  function beforeOverlay() {
    return map.getLayer('__sel::fill') ? '__sel::fill' : undefined;
  }

  function removeMl(layerId) {
    mlLayersOf(layerId).forEach(function (id) { if (map.getLayer(id)) map.removeLayer(id); });
    const sid = 'src::' + layerId;
    if (map.getSource(sid)) map.removeSource(sid);
  }

  function addVector(layer) {
    const sid = srcId(layer);
    const data = vectorSourceData(layer);
    if (map.getSource(sid)) map.getSource(sid).setData(data);
    else map.addSource(sid, { type: 'geojson', data: data, tolerance: 0.3 });
    // replace style layers
    mlLayersOf(layer.id).forEach(function (id) { map.removeLayer(id); });
    const specs = M.style.toMapLibre(layer, sid);
    const before = beforeOverlay();
    specs.forEach(function (spec) {
      spec.layout = Object.assign({}, spec.layout || {}, { visibility: layer.visible ? 'visible' : 'none' });
      try { map.addLayer(spec, before); } catch (e) { console.warn('[PSICITS] layer', spec.id, e); }
    });
  }

  function addRaster(layer) {
    const sid = srcId(layer);
    let res;
    try {
      res = M.raster.render(layer.raster, layer.style, { maxSize: 2048 });
    } catch (e) {
      view.emit('notice', 'Could not draw raster "' + layer.name + '": ' + e.message);
      return;
    }
    layer.renderedStyle = res.style;
    let canvas = rasterCanvases.get(layer.id);
    if (!canvas) { canvas = document.createElement('canvas'); rasterCanvases.set(layer.id, canvas); }
    canvas.width = res.width;
    canvas.height = res.height;
    const ctx2d = canvas.getContext('2d');
    ctx2d.putImageData(new ImageData(res.data, res.width, res.height), 0, 0);
    mlLayersOf(layer.id).forEach(function (id) { map.removeLayer(id); });
    if (map.getSource(sid)) map.removeSource(sid);
    map.addSource(sid, { type: 'image', url: canvas.toDataURL('image/png'), coordinates: res.coordinates });
    map.addLayer({
      id: layer.id + '::raster', type: 'raster', source: sid,
      layout: { visibility: layer.visible ? 'visible' : 'none' },
      paint: { 'raster-opacity': layer.opacity === undefined ? 1 : layer.opacity, 'raster-resampling': 'nearest', 'raster-fade-duration': 0 },
    }, beforeOverlay());
    bus.emit('raster-rendered', layer);
  }

  function addTiles(layer) {
    const sid = srcId(layer);
    mlLayersOf(layer.id).forEach(function (id) { map.removeLayer(id); });
    if (map.getSource(sid)) map.removeSource(sid);
    const src = { type: 'raster', tiles: [layer.url], tileSize: layer.tileSize || 256, attribution: layer.attribution || '' };
    if (layer.minzoom !== undefined) src.minzoom = layer.minzoom;
    if (layer.maxzoom !== undefined) src.maxzoom = layer.maxzoom;
    if (layer.scheme) src.scheme = layer.scheme;
    if (layer.bounds) src.bounds = layer.bounds;
    map.addSource(sid, src);
    map.addLayer({
      id: layer.id + '::tiles', type: 'raster', source: sid,
      layout: { visibility: layer.visible ? 'visible' : 'none' },
      paint: { 'raster-opacity': layer.opacity === undefined ? 1 : layer.opacity },
    }, beforeOverlay());
  }

  function syncLayerNow(layer) {
    if (!map || !view.ready) return;
    if (!store.get(layer.id)) { removeMl(layer.id); return; }
    if (layer.type === 'vector') addVector(layer);
    else if (layer.type === 'raster') addRaster(layer);
    else addTiles(layer);
  }

  function scheduleSync(layer) {
    pendingSync.add(layer.id);
    if (syncScheduled) return;
    syncScheduled = true;
    root.requestAnimationFrame(function () {
      syncScheduled = false;
      const ids = Array.from(pendingSync);
      pendingSync = new Set();
      ids.forEach(function (id) {
        const l = store.get(id);
        if (l) syncLayerNow(l); else removeMl(id);
      });
      restack();
      updateSelection();
    });
  }
  view.refresh = function (layer) { scheduleSync(layer); };

  /** Re-stack MapLibre layers to match the store order. */
  function restack() {
    if (!map || !map.getStyle()) return;
    const before = beforeOverlay();
    store.layers.forEach(function (layer) {
      mlLayersOf(layer.id).forEach(function (id) {
        // keep label layers above their own geometry
        try { map.moveLayer(id, before); } catch (e) { /* ignore */ }
      });
    });
    // labels of all layers on top of all geometry
    store.layers.forEach(function (layer) {
      const lid = layer.id + '::label';
      if (map.getLayer(lid)) { try { map.moveLayer(lid, before); } catch (e) { /* ignore */ } }
    });
  }

  function ensureOverlay() {
    if (!map.getSource('__sel')) map.addSource('__sel', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    const F = M.style.GEOM_FILTER;
    if (!map.getLayer('__sel::fill')) map.addLayer({ id: '__sel::fill', type: 'fill', source: '__sel', filter: F.Polygon, paint: { 'fill-color': '#eaaa00', 'fill-opacity': 0.3 } });
    if (!map.getLayer('__sel::line')) map.addLayer({ id: '__sel::line', type: 'line', source: '__sel', filter: ['!', F.Point], paint: { 'line-color': '#eaaa00', 'line-width': 3 }, layout: { 'line-join': 'round', 'line-cap': 'round' } });
    if (!map.getLayer('__sel::circle')) map.addLayer({ id: '__sel::circle', type: 'circle', source: '__sel', filter: F.Point, paint: { 'circle-radius': 8, 'circle-color': 'rgba(234,170,0,0.28)', 'circle-stroke-color': '#eaaa00', 'circle-stroke-width': 3 } });
    if (!map.getSource('__hl')) map.addSource('__hl', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    if (!map.getLayer('__hl::line')) map.addLayer({ id: '__hl::line', type: 'line', source: '__hl', filter: ['!', F.Point], paint: { 'line-color': '#800000', 'line-width': 3, 'line-dasharray': [2, 1] } });
    if (!map.getLayer('__hl::circle')) map.addLayer({ id: '__hl::circle', type: 'circle', source: '__hl', filter: F.Point, paint: { 'circle-radius': 7, 'circle-color': '#800000', 'circle-stroke-color': '#fff', 'circle-stroke-width': 2.5 } });
  }

  function rebuild() {
    ensureOverlay();
    store.layers.forEach(function (l) { syncLayerNow(l); });
    restack();
    updateSelection();
  }
  view.rebuild = rebuild;

  function updateSelection() {
    if (!map || !map.getSource('__sel')) return;
    const feats = [];
    store.selection.forEach(function (set, layerId) {
      const layer = store.get(layerId);
      if (!layer || !layer.visible || layer.type !== 'vector') return;
      const idx = store.featureIndex(layer);
      set.forEach(function (fid) { const f = idx.get(fid); if (f && f.geometry) feats.push(f); });
    });
    map.getSource('__sel').setData({ type: 'FeatureCollection', features: feats });
  }
  view.updateSelection = updateSelection;

  /** Temporarily highlight a geometry/FeatureCollection (e.g. a geocode result). */
  let hlTimer = null;
  view.highlight = function (geojson, ms) {
    if (!map || !map.getSource('__hl')) return;
    clearTimeout(hlTimer);
    map.getSource('__hl').setData(geojson ? util.toFeatureCollection(geojson) : { type: 'FeatureCollection', features: [] });
    if (geojson) hlTimer = setTimeout(function () { view.highlight(null); }, ms || 8000);
  };

  function subscribe() {
    store.on('layer:add', function (e) { scheduleSync(e.layer); });
    store.on('layer:remove', function (e) {
      if (map && map.getStyle()) removeMl(e.layer.id);
      rasterCanvases.delete(e.layer.id);
      updateSelection();
    });
    store.on('layer:update', function (e) {
      const c = e.changes;
      if (c.length === 1 && c[0] === 'visible') {
        mlLayersOf(e.layer.id).forEach(function (id) { map.setLayoutProperty(id, 'visibility', e.layer.visible ? 'visible' : 'none'); });
        updateSelection();
        return;
      }
      if (c.length === 1 && c[0] === 'name') return;
      if (c.length === 1 && c[0] === 'opacity' && e.layer.type !== 'vector') {
        mlLayersOf(e.layer.id).forEach(function (id) { map.setPaintProperty(id, 'raster-opacity', e.layer.opacity); });
        return;
      }
      scheduleSync(e.layer);
    });
    store.on('layer:order', restack);
    store.on('selection', updateSelection);
    store.on('project:clear', function () { if (map && map.getStyle()) rebuild(); });
  }

  /* ------------------------------------------------------------- views */

  view.fitBounds = function (bbox, opts) {
    if (!bbox || !isFinite(bbox[0])) return;
    let b = bbox.slice();
    if (b[0] === b[2] && b[1] === b[3]) {
      map.flyTo({ center: [b[0], b[1]], zoom: Math.max(map.getZoom(), (opts && opts.pointZoom) || 15), duration: opts && opts.duration !== undefined ? opts.duration : 800 });
      return;
    }
    b = [Math.max(-180, b[0]), Math.max(-85, b[1]), Math.min(180, b[2]), Math.min(85, b[3])];
    map.fitBounds([[b[0], b[1]], [b[2], b[3]]], Object.assign({ padding: 40, maxZoom: 17, duration: 800 }, opts || {}));
  };

  view.zoomToLayer = function (layer) {
    if (!layer) return;
    const b = layer.bbox || (layer.type === 'vector' ? util.bbox(layer.data) : null);
    if (!b) throw new Error('Layer "' + layer.name + '" has no extent to zoom to');
    view.fitBounds(b);
  };

  view.viewBBox = function () {
    const b = map.getBounds();
    return [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()];
  };

  view.getView = function () {
    const c = map.getCenter();
    return { center: [c.lng, c.lat], zoom: map.getZoom(), bearing: map.getBearing(), pitch: map.getPitch(), basemap: view.basemap };
  };

  view.setView = function (v) {
    if (!v) return;
    map.jumpTo({ center: v.center, zoom: v.zoom, bearing: v.bearing || 0, pitch: v.pitch || 0 });
    if (v.basemap && v.basemap !== view.basemap && (BASEMAPS[v.basemap])) view.setBasemap(v.basemap);
  };

  view.setProjection = function (type) {
    if (typeof map.setProjection !== 'function') throw new Error('This MapLibre version cannot change projection');
    map.setProjection({ type: type === 'globe' ? 'globe' : 'mercator' });
  };

  /** Capture the current map as a PNG Blob. */
  view.capture = function () {
    return new Promise(function (resolve, reject) {
      map.once('render', function () {
        try {
          const url = map.getCanvas().toDataURL('image/png');
          fetch(url).then(function (r) { return r.blob(); }).then(resolve, reject);
        } catch (e) { reject(new Error('The map image could not be captured (a basemap or layer may not allow it): ' + e.message)); }
      });
      map.triggerRepaint();
    });
  };

  /* -------------------------------------------------------- interaction */

  function userLayerIds() {
    const out = [];
    store.layers.forEach(function (l) {
      if (!l.visible || l.type !== 'vector') return;
      mlLayersOf(l.id).forEach(function (id) { if (!id.endsWith('::label')) out.push(id); });
    });
    return out;
  }

  function featuresAt(point, tol) {
    tol = tol === undefined ? 4 : tol;
    const ids = userLayerIds();
    if (!ids.length) return [];
    const box = [[point.x - tol, point.y - tol], [point.x + tol, point.y + tol]];
    const hits = map.queryRenderedFeatures(box, { layers: ids });
    const out = [];
    const seen = new Set();
    hits.forEach(function (h) {
      const layerId = h.layer.id.split('::')[0];
      const key = layerId + ':' + h.id;
      if (seen.has(key)) return;
      seen.add(key);
      const f = store.featureById(layerId, h.id);
      if (f) out.push({ layerId: layerId, feature: f });
    });
    return out;
  }
  view.featuresAt = featuresAt;

  function rasterValuesAt(lngLat) {
    const out = [];
    store.ordered().forEach(function (l) {
      if (l.type !== 'raster' || !l.visible) return;
      try {
        const v = M.raster.valueAt(l.raster, lngLat.lng, lngLat.lat);
        if (v && v.some(function (x) { return x !== null; })) out.push({ layer: l, values: v });
      } catch (e) { /* ignore */ }
    });
    return out;
  }

  function wireInteractions() {
    // coordinates readout
    map.on('mousemove', throttle(function (e) {
      bus.emit('pointer', { lng: e.lngLat.lng, lat: e.lngLat.lat, zoom: map.getZoom() });
      if (view.mode === 'identify' || view.mode === 'select') {
        const hits = featuresAt(e.point, 3);
        map.getCanvas().style.cursor = hits.length ? 'pointer' : '';
      }
    }, 60));
    map.on('zoomend', function () { bus.emit('zoom', map.getZoom()); });

    map.on('click', function (e) {
      if (view.mode !== 'identify' && view.mode !== 'select') return;
      const hits = featuresAt(e.point);
      const additive = e.originalEvent && (e.originalEvent.shiftKey || e.originalEvent.metaKey || e.originalEvent.ctrlKey);
      if (hits.length) {
        const top = hits[0];
        store.select(top.layerId, [top.feature.id], additive ? 'toggle' : 'new');
        if (!additive) {
          store.selection.forEach(function (_, lid) { if (lid !== top.layerId) store.clearSelection(lid); });
        }
        bus.emit('feature-click', { layerId: top.layerId, feature: top.feature, lngLat: e.lngLat, all: hits });
        if (view.mode === 'identify') showPopup(e.lngLat, hits, rasterValuesAt(e.lngLat));
      } else {
        if (!additive) store.clearSelection();
        view.highlight(null);
        const rv = rasterValuesAt(e.lngLat);
        if (rv.length && view.mode === 'identify') showPopup(e.lngLat, [], rv);
        else if (popup) { popup.remove(); popup = null; }
      }
    });

    // Shift + drag = box select
    const canvas = map.getCanvasContainer();
    let boxStart = null, boxEl = null;
    canvas.addEventListener('mousedown', function (ev) {
      if (!ev.shiftKey || ev.button !== 0 || (view.mode !== 'identify' && view.mode !== 'select')) return;
      map.dragPan.disable();
      boxStart = mousePos(ev);
      ev.preventDefault();
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    }, true);
    function mousePos(ev) {
      const r = canvas.getBoundingClientRect();
      return { x: ev.clientX - r.left - canvas.clientLeft, y: ev.clientY - r.top - canvas.clientTop };
    }
    function onMove(ev) {
      const cur = mousePos(ev);
      if (!boxEl) { boxEl = document.createElement('div'); boxEl.className = 'ps-boxselect'; canvas.appendChild(boxEl); }
      const x0 = Math.min(boxStart.x, cur.x), y0 = Math.min(boxStart.y, cur.y);
      boxEl.style.transform = 'translate(' + x0 + 'px,' + y0 + 'px)';
      boxEl.style.width = Math.abs(cur.x - boxStart.x) + 'px';
      boxEl.style.height = Math.abs(cur.y - boxStart.y) + 'px';
    }
    function onUp(ev) {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      map.dragPan.enable();
      const end = mousePos(ev);
      if (boxEl) { boxEl.remove(); boxEl = null; }
      if (Math.abs(end.x - boxStart.x) < 3 && Math.abs(end.y - boxStart.y) < 3) { boxStart = null; return; }
      const ids = userLayerIds();
      const hits = ids.length ? map.queryRenderedFeatures([[Math.min(boxStart.x, end.x), Math.min(boxStart.y, end.y)], [Math.max(boxStart.x, end.x), Math.max(boxStart.y, end.y)]], { layers: ids }) : [];
      const byLayer = new Map();
      hits.forEach(function (h) {
        const lid = h.layer.id.split('::')[0];
        if (!byLayer.has(lid)) byLayer.set(lid, new Set());
        byLayer.get(lid).add(h.id);
      });
      const active = store.activeId;
      // Prefer the active layer; otherwise select in every layer hit.
      if (byLayer.has(active)) store.select(active, Array.from(byLayer.get(active)), 'add');
      else byLayer.forEach(function (set, lid) { store.select(lid, Array.from(set), 'add'); });
      boxStart = null;
      bus.emit('box-select', { count: hits.length });
    }
  }

  function throttle(fn, ms) {
    let last = 0, timer = null, lastArgs = null;
    return function () {
      lastArgs = arguments;
      const now = Date.now();
      if (now - last >= ms) { last = now; fn.apply(null, lastArgs); }
      else if (!timer) timer = setTimeout(function () { timer = null; last = Date.now(); fn.apply(null, lastArgs); }, ms - (now - last));
    };
  }

  function fmtVal(v) {
    if (v === null || v === undefined) return '<span class="ps-null">null</span>';
    if (typeof v === 'number') return util.escapeHtml(util.formatNumber(v, Math.abs(v) < 1000 ? 6 : 2));
    if (typeof v === 'object') return util.escapeHtml(JSON.stringify(v));
    const s = String(v);
    if (/^https?:\/\//.test(s)) return '<a href="' + util.escapeHtml(s) + '" target="_blank" rel="noopener noreferrer">' + util.escapeHtml(s.length > 40 ? s.slice(0, 40) + '…' : s) + '</a>';
    return util.escapeHtml(s.length > 200 ? s.slice(0, 200) + '…' : s);
  }

  function showPopup(lngLat, hits, rasters) {
    if (popup) popup.remove();
    const wrap = document.createElement('div');
    wrap.className = 'ps-popup';
    let html = '';
    const first = hits[0];
    if (first) {
      const layer = store.get(first.layerId);
      const props = first.feature.properties || {};
      const keys = Object.keys(props);
      html += '<div class="ps-popup-title">' + util.escapeHtml(layer.name) + ' <span class="ps-dim">#' + first.feature.id + '</span>' + (hits.length > 1 ? ' <span class="ps-dim">(+' + (hits.length - 1) + ' more)</span>' : '') + '</div>';
      html += '<table class="ps-kv">';
      keys.slice(0, 40).forEach(function (k) { html += '<tr><th>' + util.escapeHtml(k) + '</th><td>' + fmtVal(props[k]) + '</td></tr>'; });
      if (keys.length > 40) html += '<tr><td colspan="2" class="ps-dim">… ' + (keys.length - 40) + ' more fields (open the table)</td></tr>';
      if (!keys.length) html += '<tr><td class="ps-dim">No attributes</td></tr>';
      html += '</table>';
      html += '<div class="ps-popup-actions"><button data-act="zoom">Zoom</button><button data-act="table">Table</button></div>';
    }
    rasters.forEach(function (r) {
      html += '<div class="ps-popup-title">' + util.escapeHtml(r.layer.name) + '</div><table class="ps-kv">';
      r.values.forEach(function (v, i) { html += '<tr><th>' + util.escapeHtml(r.layer.bandNames[i] || 'b' + (i + 1)) + '</th><td>' + fmtVal(v) + '</td></tr>'; });
      html += '</table>';
    });
    html += '<div class="ps-popup-coords">' + lngLat.lat.toFixed(5) + ', ' + lngLat.lng.toFixed(5) + '</div>';
    wrap.innerHTML = html;
    wrap.addEventListener('click', function (ev) {
      const act = ev.target && ev.target.getAttribute && ev.target.getAttribute('data-act');
      if (!act || !first) return;
      if (act === 'zoom') view.fitBounds(util.bbox(first.feature), { maxZoom: 16 });
      if (act === 'table') bus.emit('open-table', { layerId: first.layerId, fid: first.feature.id });
    });
    popup = new root.maplibregl.Popup({ maxWidth: '360px', closeButton: true, className: 'ps-popup-wrap' }).setLngLat(lngLat).setDOMContent(wrap).addTo(map);
  }

  /** Resolves once the map has stopped moving (or after `ms`). */
  view.settle = function (ms) {
    if (!map || !map.isMoving()) return Promise.resolve();
    return new Promise(function (resolve) {
      const t = setTimeout(done, ms || 4000);
      function done() { clearTimeout(t); map.off('moveend', done); resolve(); }
      map.on('moveend', done);
    });
  };

  view.closePopup = function () { if (popup) { popup.remove(); popup = null; } };

  view.setMode = function (mode) {
    view.mode = mode;
    map.getCanvas().style.cursor = mode === 'draw' || mode === 'measure' ? 'crosshair' : '';
    bus.emit('mode', mode);
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
