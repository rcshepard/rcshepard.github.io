/*
 * PSICITS — the layer store: the single source of truth for the project.
 *
 * Layers are kept in draw order (index 0 = bottom). Data objects are treated
 * as immutable: every change replaces `layer.data` (or `layer.raster`, …) with
 * a new object, which makes undo/redo cheap — history keeps references.
 *
 * DOM-free; the map and UI subscribe to events:
 *   layer:add {layer}  layer:remove {layer}  layer:update {layer, changes}
 *   layer:order        active {layer}        selection {layerId}
 *   history            project:load          project:clear
 */
(function (root) {
  'use strict';

  const M = (root.PSICITS = root.PSICITS || {});
  const util = M.util;

  const HISTORY_LIMIT = 40;

  function createStore() {
    const events = util.Emitter();
    const layers = [];
    const selection = new Map(); // layerId -> Set(fid)
    let activeId = null;
    let idSeq = 0;
    const undoStack = [];
    const redoStack = [];
    let txn = null; // open transaction: { label, steps: [] }
    const fidIndex = new WeakMap(); // FeatureCollection -> Map(fid -> feature)

    /* ------------------------------------------------------------- utils */

    function nextId() {
      let id;
      do { idSeq++; id = 'L' + idSeq; } while (layers.some(function (l) { return l.id === id; }));
      return id;
    }

    function prepareFC(input, keepIds) {
      const feats0 = input && input.type === 'FeatureCollection' && Array.isArray(input.features) ? input.features : null;
      let wellFormed = !!feats0;
      if (wellFormed) {
        for (let i = 0; i < feats0.length; i++) {
          const f = feats0[i];
          if (!f || f.type !== 'Feature' || !f.properties || typeof f.properties !== 'object' || f.geometry === undefined) { wellFormed = false; break; }
        }
      }
      const fc = wellFormed ? input : util.toFeatureCollection(input);
      const feats = fc.features;
      let ok = keepIds;
      if (ok) {
        const seen = new Set();
        for (let i = 0; i < feats.length; i++) {
          const id = feats[i].id;
          if (typeof id !== 'number' || !isFinite(id) || seen.has(id)) { ok = false; break; }
          seen.add(id);
        }
      }
      const out = new Array(feats.length);
      for (let i = 0; i < feats.length; i++) {
        const f = feats[i];
        // Features are immutable, so well-formed ones can be shared between versions.
        if (ok && wellFormed) out[i] = f;
        else out[i] = { type: 'Feature', id: ok ? f.id : i + 1, geometry: f.geometry || null, properties: f.properties || {} };
      }
      return { type: 'FeatureCollection', features: out };
    }

    function maxFid(fc) {
      let m = 0;
      for (let i = 0; i < fc.features.length; i++) if (fc.features[i].id > m) m = fc.features[i].id;
      return m;
    }

    function describeVector(layer) {
      layer.fields = util.inferFields(layer.data);
      layer.geometryType = util.layerGeometryType(layer.data);
      layer.bbox = util.bbox(layer.data);
      layer.count = layer.data.features.length;
      layer.nextFid = maxFid(layer.data) + 1;
    }

    function describeRaster(layer) {
      const r = layer.raster;
      layer.bandNames = (r.bandNames && r.bandNames.length ? r.bandNames : r.bands.map(function (_, i) { return 'b' + (i + 1); })).slice();
      try { layer.bbox = M.raster ? M.raster.bboxWGS84(r) : null; } catch (e) { layer.bbox = null; }
      layer.count = r.width * r.height;
      layer.geometryType = 'Raster';
      layer.fields = [];
    }

    function describe(layer) {
      if (layer.type === 'vector') describeVector(layer);
      else if (layer.type === 'raster') describeRaster(layer);
      else { layer.fields = []; layer.geometryType = 'Tiles'; layer.count = 0; layer.bbox = layer.bounds || null; }
    }

    function pushHistory(step) {
      if (txn) { txn.steps.push(step); return; }
      undoStack.push(step);
      if (undoStack.length > HISTORY_LIMIT) undoStack.shift();
      redoStack.length = 0;
      events.emit('history', { canUndo: true, canRedo: false, label: step.label });
    }

    /* ------------------------------------------------------------ lookup */

    function get(ref) {
      if (ref === null || ref === undefined) return null;
      if (typeof ref === 'object' && ref.id) ref = ref.id;
      const s = String(ref);
      let l = layers.find(function (x) { return x.id === s; });
      if (l) return l;
      l = layers.find(function (x) { return x.name === s; });
      if (l) return l;
      const lo = s.toLowerCase();
      l = layers.find(function (x) { return x.name.toLowerCase() === lo || x.id.toLowerCase() === lo; });
      if (l) return l;
      const nn = util.normName(s);
      l = layers.find(function (x) { return util.normName(x.name) === nn; });
      if (l) return l;
      l = layers.find(function (x) { return util.slug(x.name) === util.slug(s); });
      return l || null;
    }

    function require(ref, kind) {
      const l = get(ref);
      if (!l) {
        const names = layers.map(function (x) { return '"' + x.name + '"'; });
        throw new Error('No layer named "' + ref + '".' + (names.length ? ' Layers: ' + names.join(', ') : ' There are no layers yet — try "open" or "sample".'));
      }
      if (kind && l.type !== kind) throw new Error('"' + l.name + '" is a ' + l.type + ' layer; this needs a ' + kind + ' layer.');
      return l;
    }

    function uniqueName(base) {
      return util.uniqueName(String(base || 'layer').trim() || 'layer', layers.map(function (l) { return l.name; }));
    }

    /* -------------------------------------------------------------- add */

    /**
     * Add a layer.
     *   { type: 'vector', name, data, style, ... }
     *   { type: 'raster', name, raster, style, ... }
     *   { type: 'tiles', name, url, tileSize, attribution, ... }
     */
    function add(spec, opts) {
      opts = opts || {};
      const type = spec.type || (spec.raster ? 'raster' : spec.url && !spec.data ? 'tiles' : 'vector');
      const layer = {
        id: spec.id && !get(spec.id) ? spec.id : nextId(),
        name: uniqueName(spec.name || (type === 'raster' ? 'raster' : 'layer')),
        type: type,
        visible: spec.visible !== false,
        opacity: spec.opacity === undefined ? 1 : spec.opacity,
        style: spec.style ? util.clone(spec.style) : null,
        filter: spec.filter || null,
        source: spec.source || null,
        crs: spec.crs || (type === 'vector' ? 'EPSG:4326' : spec.raster ? spec.raster.crs : null),
        meta: spec.meta || {},
        created: Date.now(),
      };
      if (type === 'vector') layer.data = prepareFC(spec.data || { type: 'FeatureCollection', features: [] }, !!spec.keepIds);
      else if (type === 'raster') {
        if (!spec.raster) throw new Error('Raster layer needs raster data');
        layer.raster = spec.raster;
      } else {
        ['url', 'tileSize', 'attribution', 'minzoom', 'maxzoom', 'scheme', 'bounds', 'kind', 'wms'].forEach(function (k) { if (spec[k] !== undefined) layer[k] = spec[k]; });
      }
      if (/^L(\d+)$/.test(layer.id)) idSeq = Math.max(idSeq, +layer.id.slice(1));
      describe(layer);
      if (!layer.style && M.style) layer.style = M.style.defaultStyle(layer);
      const index = opts.index === undefined ? layers.length : Math.max(0, Math.min(layers.length, opts.index));
      layers.splice(index, 0, layer);
      if (opts.activate !== false) activeId = layer.id;
      events.emit('layer:add', { layer: layer, index: index });
      if (opts.activate !== false) events.emit('active', { layer: layer });
      if (opts.history !== false) {
        pushHistory({
          label: opts.label || 'Add ' + layer.name,
          undo: function () { removeInternal(layer.id); },
          redo: function () { insertInternal(layer, index); },
        });
      }
      return layer;
    }

    function insertInternal(layer, index) {
      layers.splice(Math.min(index, layers.length), 0, layer);
      events.emit('layer:add', { layer: layer, index: index });
      if (!activeId) { activeId = layer.id; events.emit('active', { layer: layer }); }
    }

    function removeInternal(id) {
      const i = layers.findIndex(function (l) { return l.id === id; });
      if (i < 0) return null;
      const layer = layers[i];
      layers.splice(i, 1);
      if (selection.has(id)) { selection.delete(id); events.emit('selection', { layerId: id }); }
      events.emit('layer:remove', { layer: layer, index: i });
      if (activeId === id) {
        const next = layers[Math.min(i, layers.length - 1)] || null;
        activeId = next ? next.id : null;
        events.emit('active', { layer: next });
      }
      return { layer: layer, index: i };
    }

    function remove(ref, opts) {
      opts = opts || {};
      const l = require(ref);
      const r = removeInternal(l.id);
      if (opts.history !== false) {
        pushHistory({
          label: 'Remove ' + l.name,
          undo: function () { insertInternal(r.layer, r.index); },
          redo: function () { removeInternal(r.layer.id); },
        });
      }
      return l;
    }

    /* ----------------------------------------------------------- update */

    const UPDATABLE = ['name', 'data', 'raster', 'style', 'visible', 'opacity', 'filter', 'source', 'meta', 'crs', 'url', 'attribution'];

    function applyPatch(layer, patch) {
      const changes = [];
      Object.keys(patch).forEach(function (k) {
        if (UPDATABLE.indexOf(k) < 0) return;
        layer[k] = patch[k];
        changes.push(k);
      });
      if (changes.indexOf('data') >= 0 || changes.indexOf('raster') >= 0) {
        describe(layer);
        // drop selected ids that no longer exist
        const sel = selection.get(layer.id);
        if (sel && layer.type === 'vector') {
          const idx = featureIndex(layer);
          let changed = false;
          sel.forEach(function (fid) { if (!idx.has(fid)) { sel.delete(fid); changed = true; } });
          if (changed) events.emit('selection', { layerId: layer.id });
        }
      }
      return changes;
    }

    /**
     * Update a layer. `patch.data` must be a *new* FeatureCollection object.
     * opts: { history = true, label, keepIds = true (for data) }
     */
    function update(ref, patch, opts) {
      opts = opts || {};
      const layer = require(ref);
      patch = Object.assign({}, patch);
      if (patch.name !== undefined) {
        const nm = String(patch.name).trim();
        if (!nm) throw new Error('Layer name cannot be empty');
        patch.name = nm.toLowerCase() === layer.name.toLowerCase() ? nm : uniqueName(nm);
      }
      if (patch.data !== undefined) patch.data = prepareFC(patch.data, opts.keepIds !== false);
      const before = {};
      Object.keys(patch).forEach(function (k) { before[k] = layer[k]; });
      const changes = applyPatch(layer, patch);
      if (!changes.length) return layer;
      events.emit('layer:update', { layer: layer, changes: changes });
      if (opts.history !== false) {
        const after = {};
        changes.forEach(function (k) { after[k] = layer[k]; });
        pushHistory({
          label: opts.label || 'Edit ' + layer.name,
          undo: function () { const c = applyPatch(layer, before); events.emit('layer:update', { layer: layer, changes: c }); },
          redo: function () { const c = applyPatch(layer, after); events.emit('layer:update', { layer: layer, changes: c }); },
        });
      }
      return layer;
    }

    /** Replace some features (by id) with edited copies: edits = Map|object fid -> feature. */
    function editFeatures(ref, edits, opts) {
      const layer = require(ref, 'vector');
      const map = edits instanceof Map ? edits : new Map(Object.keys(edits).map(function (k) { return [Number(k), edits[k]]; }));
      const feats = layer.data.features.map(function (f) {
        const e = map.get(f.id);
        if (!e) return f;
        return { type: 'Feature', id: f.id, geometry: e.geometry !== undefined ? e.geometry : f.geometry, properties: e.properties !== undefined ? e.properties : f.properties };
      });
      return update(layer, { data: { type: 'FeatureCollection', features: feats } }, Object.assign({ label: 'Edit features' }, opts));
    }

    /** Append features to a vector layer (ids assigned). */
    function appendFeatures(ref, features, opts) {
      const layer = require(ref, 'vector');
      let next = layer.nextFid || maxFid(layer.data) + 1;
      const added = features.map(function (f) {
        return { type: 'Feature', id: next++, geometry: f.geometry || null, properties: Object.assign({}, f.properties || {}) };
      });
      update(layer, { data: { type: 'FeatureCollection', features: layer.data.features.concat(added) } }, Object.assign({ label: 'Add features' }, opts));
      return added.map(function (f) { return f.id; });
    }

    /** Delete features by id. */
    function deleteFeatures(ref, fids, opts) {
      const layer = require(ref, 'vector');
      const kill = new Set(fids);
      const feats = layer.data.features.filter(function (f) { return !kill.has(f.id); });
      const n = layer.data.features.length - feats.length;
      if (n) update(layer, { data: { type: 'FeatureCollection', features: feats } }, Object.assign({ label: 'Delete ' + n + ' feature(s)' }, opts));
      return n;
    }

    /* ------------------------------------------------------------ order */

    function move(ref, toIndex, opts) {
      const layer = require(ref);
      const from = layers.indexOf(layer);
      const to = Math.max(0, Math.min(layers.length - 1, toIndex));
      if (from === to) return layer;
      layers.splice(from, 1);
      layers.splice(to, 0, layer);
      events.emit('layer:order', {});
      if (!opts || opts.history !== false) {
        pushHistory({
          label: 'Reorder layers',
          undo: function () { const i = layers.indexOf(layer); layers.splice(i, 1); layers.splice(from, 0, layer); events.emit('layer:order', {}); },
          redo: function () { const i = layers.indexOf(layer); layers.splice(i, 1); layers.splice(to, 0, layer); events.emit('layer:order', {}); },
        });
      }
      return layer;
    }

    /* ---------------------------------------------------------- active */

    function setActive(ref) {
      const l = ref ? get(ref) : null;
      const id = l ? l.id : null;
      if (id === activeId) return l;
      activeId = id;
      events.emit('active', { layer: l });
      return l;
    }

    /* -------------------------------------------------------- selection */

    function featureIndex(layer) {
      let idx = fidIndex.get(layer.data);
      if (!idx) {
        idx = new Map();
        const feats = layer.data.features;
        for (let i = 0; i < feats.length; i++) idx.set(feats[i].id, feats[i]);
        fidIndex.set(layer.data, idx);
      }
      return idx;
    }

    function featureById(ref, fid) {
      const l = get(ref);
      if (!l || l.type !== 'vector') return null;
      return featureIndex(l).get(fid) || null;
    }

    /** mode: 'new' | 'add' | 'remove' | 'toggle' | 'intersect' */
    function select(ref, fids, mode) {
      const layer = require(ref, 'vector');
      const cur = selection.get(layer.id) || new Set();
      let next;
      const incoming = new Set(fids);
      switch (mode || 'new') {
        case 'add': next = new Set(cur); incoming.forEach(function (f) { next.add(f); }); break;
        case 'remove': next = new Set(cur); incoming.forEach(function (f) { next.delete(f); }); break;
        case 'toggle': next = new Set(cur); incoming.forEach(function (f) { if (next.has(f)) next.delete(f); else next.add(f); }); break;
        case 'intersect': next = new Set(); incoming.forEach(function (f) { if (cur.has(f)) next.add(f); }); break;
        default: next = incoming;
      }
      if (next.size) selection.set(layer.id, next); else selection.delete(layer.id);
      events.emit('selection', { layerId: layer.id });
      return next.size;
    }

    function clearSelection(ref) {
      if (ref) {
        const l = get(ref);
        if (l && selection.delete(l.id)) events.emit('selection', { layerId: l.id });
        return;
      }
      const ids = Array.from(selection.keys());
      selection.clear();
      ids.forEach(function (id) { events.emit('selection', { layerId: id }); });
    }

    function selectedIds(ref) {
      const l = get(ref);
      return l && selection.has(l.id) ? Array.from(selection.get(l.id)) : [];
    }

    function selectedFeatures(ref) {
      const l = get(ref);
      if (!l || !selection.has(l.id)) return [];
      const idx = featureIndex(l);
      const out = [];
      selection.get(l.id).forEach(function (fid) { const f = idx.get(fid); if (f) out.push(f); });
      return out;
    }

    function isSelected(layerId, fid) {
      const s = selection.get(layerId);
      return !!(s && s.has(fid));
    }

    /* ---------------------------------------------------------- history */

    function undo() {
      const step = undoStack.pop();
      if (!step) return null;
      step.undo();
      redoStack.push(step);
      events.emit('history', { canUndo: undoStack.length > 0, canRedo: true, label: step.label });
      return step.label;
    }

    function redo() {
      const step = redoStack.pop();
      if (!step) return null;
      step.redo();
      undoStack.push(step);
      events.emit('history', { canUndo: true, canRedo: redoStack.length > 0, label: step.label });
      return step.label;
    }

    /** Group several changes into one undo step. fn may be async. */
    async function transaction(label, fn) {
      if (txn) return fn();
      txn = { label: label, steps: [] };
      const mine = txn;
      try {
        return await fn();
      } finally {
        txn = null;
        if (mine.steps.length) {
          const steps = mine.steps;
          pushHistory({
            label: label,
            undo: function () { for (let i = steps.length - 1; i >= 0; i--) steps[i].undo(); },
            redo: function () { for (let i = 0; i < steps.length; i++) steps[i].redo(); },
          });
        }
      }
    }

    /* ---------------------------------------------------------- project */

    function clear() {
      layers.slice().forEach(function (l) { removeInternal(l.id); });
      selection.clear();
      undoStack.length = 0;
      redoStack.length = 0;
      activeId = null;
      events.emit('project:clear', {});
      events.emit('history', { canUndo: false, canRedo: false });
    }

    const TYPED = { Float32Array: Float32Array, Float64Array: Float64Array, Int8Array: Int8Array, Uint8Array: Uint8Array, Uint8ClampedArray: Uint8ClampedArray, Int16Array: Int16Array, Uint16Array: Uint16Array, Int32Array: Int32Array, Uint32Array: Uint32Array };

    function b64encode(bytes) {
      if (typeof root.Buffer !== 'undefined') return root.Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64');
      let s = '';
      const chunk = 0x8000;
      for (let i = 0; i < bytes.length; i += chunk) s += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
      return root.btoa(s);
    }
    function b64decode(str) {
      if (typeof root.Buffer !== 'undefined') { const b = root.Buffer.from(str, 'base64'); return new Uint8Array(b.buffer, b.byteOffset, b.byteLength); }
      const s = root.atob(str);
      const out = new Uint8Array(s.length);
      for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
      return out;
    }

    function serializeRaster(r, binary) {
      const out = Object.assign({}, r);
      delete out.stats;
      out.bandTypes = r.bands.map(function (b) { return b.constructor.name; });
      out.bands = r.bands.map(function (b) {
        if (binary) return b;
        return b64encode(new Uint8Array(b.buffer, b.byteOffset, b.byteLength));
      });
      return out;
    }
    function deserializeRaster(o) {
      const r = Object.assign({}, o);
      r.bands = o.bands.map(function (b, i) {
        const T = TYPED[(o.bandTypes || [])[i]] || Float32Array;
        if (ArrayBuffer.isView(b)) return b;
        const bytes = b64decode(b);
        const copy = new Uint8Array(bytes.byteLength);
        copy.set(bytes);
        return new T(copy.buffer);
      });
      delete r.bandTypes;
      r.stats = null;
      return r;
    }

    /**
     * Plain-object snapshot of the project. With { binary: true } raster bands
     * stay typed arrays (for IndexedDB); otherwise they're base64 (for files).
     */
    function toJSON(opts) {
      opts = opts || {};
      return {
        format: 'psicits-project',
        version: 1,
        app: M.appName + ' ' + M.version,
        saved: new Date().toISOString(),
        active: activeId,
        layers: layers.map(function (l) {
          const o = { id: l.id, name: l.name, type: l.type, visible: l.visible, opacity: l.opacity, style: l.style, filter: l.filter, source: l.source, crs: l.crs, meta: l.meta };
          if (l.type === 'vector') o.data = l.data;
          else if (l.type === 'raster') o.raster = serializeRaster(l.raster, opts.binary);
          else ['url', 'tileSize', 'attribution', 'minzoom', 'maxzoom', 'scheme', 'bounds', 'kind', 'wms'].forEach(function (k) { if (l[k] !== undefined) o[k] = l[k]; });
          return o;
        }),
      };
    }

    function fromJSON(obj) {
      // ('meridian-project' was the format name of early test builds)
      if (!obj || (obj.format !== 'psicits-project' && obj.format !== 'meridian-project') || !Array.isArray(obj.layers)) throw new Error('This is not a PSICITS project file');
      clear();
      obj.layers.forEach(function (o) {
        const spec = Object.assign({}, o, { keepIds: true });
        if (o.type === 'raster') spec.raster = deserializeRaster(o.raster);
        add(spec, { history: false, activate: false });
      });
      activeId = obj.active && get(obj.active) ? obj.active : (layers.length ? layers[layers.length - 1].id : null);
      events.emit('active', { layer: get(activeId) });
      events.emit('project:load', { project: obj });
    }

    /** Lightweight description of layers for the command parser. */
    function ctx() {
      return {
        activeLayerId: activeId,
        layers: layers.slice().reverse().map(function (l) {
          return { id: l.id, name: l.name, type: l.type, geometryType: l.geometryType, fields: l.fields || [], count: l.count, bandNames: l.bandNames || [] };
        }),
      };
    }

    return {
      on: events.on.bind(events), off: events.off.bind(events), emit: events.emit,
      get layers() { return layers; },
      /** Layers top-first (as shown in the layer panel). */
      ordered: function () { return layers.slice().reverse(); },
      get: get, require: require, uniqueName: uniqueName,
      add: add, remove: remove, update: update, move: move,
      editFeatures: editFeatures, appendFeatures: appendFeatures, deleteFeatures: deleteFeatures,
      get activeId() { return activeId; },
      get active() { return get(activeId); },
      setActive: setActive,
      select: select, clearSelection: clearSelection, selectedIds: selectedIds, selectedFeatures: selectedFeatures,
      isSelected: isSelected, featureById: featureById, featureIndex: featureIndex,
      get selection() { return selection; },
      undo: undo, redo: redo, transaction: transaction,
      get canUndo() { return undoStack.length > 0; },
      get canRedo() { return redoStack.length > 0; },
      get undoLabel() { return undoStack.length ? undoStack[undoStack.length - 1].label : null; },
      get redoLabel() { return redoStack.length ? redoStack[redoStack.length - 1].label : null; },
      clear: clear, toJSON: toJSON, fromJSON: fromJSON, ctx: ctx,
      prepareFC: prepareFC,
    };
  }

  M.createStore = createStore;
  M.store = createStore();
})(typeof globalThis !== 'undefined' ? globalThis : this);
