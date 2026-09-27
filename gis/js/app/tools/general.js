/*
 * PSICITS — general commands: help, history, layers, view, project.
 */
(function (root) {
  'use strict';

  const M = root.PSICITS;
  const util = M.util;
  const T = M.toolkit;
  const P = T.P;
  const def = T.define;

  const CATEGORY_ORDER = ['Basics', 'Layers', 'Data', 'Web & OSM', 'Select & query', 'Attributes', 'Style', 'Vector', 'Raster', 'Draw & edit', 'GDAL', 'Scripting'];
  T.CATEGORY_ORDER = CATEGORY_ORDER;

  const HELP_TOPICS = {
    expressions: function (out) {
      out.text('Expressions are used by select … where, filter, calc, label … and bandmath. They look like SQL/QGIS:');
      out.code('"population" > 10000 AND "state" IN (\'IL\', \'IN\')\nname ILIKE \'%park%\'\nround($area / 10000, 1)          -- hectares\nCASE WHEN speed >= 55 THEN \'fast\' ELSE \'slow\' END\n"pop" / sum("pop", "state") * 100 -- share of the state total\n(nir - red) / (nir + red)         -- raster band math');
      out.text('Field names: bare (population) or "double quoted" (for spaces). Text: \'single quotes\'.');
      const ref = M.expr.reference();
      const groups = {};
      ref.functions.forEach(function (f) { (groups[f.group] = groups[f.group] || []).push(f.name + '(' + (f.args || '') + ')'); });
      Object.keys(groups).forEach(function (g) { out.kv({ [g]: groups[g].join('  ') }); });
      out.kv({ Geometry: ref.variables.map(function (v) { return v.name; }).join('  '), Operators: ref.operators.join('  ') });
    },
    gdal: function (out) {
      out.text(M.gdal.help());
    },
    formats: function (out) {
      out.text('Open (drag & drop or "open"): GeoJSON, TopoJSON, Shapefile (.zip or .shp+.dbf+.prj), KML/KMZ, GPX, CSV/TSV (lat/lon or WKT), Excel .xlsx, GeoPackage, FlatGeobuf, GeoTIFF/COG, WKT — plus ~80 more through GDAL (File Geodatabase .gdb.zip, DXF, MapInfo, GML, ODS, SQLite, ASCII grid, JPEG2000 excluded).');
      out.text('Export: ' + Object.keys(M.io.EXPORT_FORMATS).join(', ') + ' — or any GDAL driver name, e.g. export roads "MapInfo File".');
    },
    keys: function (out) {
      out.kv({
        'Enter': 'run the command', 'Tab / →': 'accept suggestion', '↑ / ↓': 'command history (or move in suggestions)', 'Shift+Enter': 'new line (multi-line script)',
        'Ctrl+K or /': 'focus the command bar', 'Esc': 'stop drawing / close popups', 'Ctrl+Z / Ctrl+Y': 'undo / redo', 'Shift+drag on map': 'box select', 'Shift+click': 'add to selection',
      });
    },
    basemaps: function (out) {
      const b = M.mapview.BASEMAPS;
      out.kv(Object.keys(b).reduce(function (o, k) { o[k] = b[k].label; return o; }, {}));
    },
    ramps: function (out) {
      out.text('Color ramps: ' + M.colors.rampNames().join(', ') + '. Add -r to reverse (e.g. viridis-r).');
      out.text('Palettes (categories): ' + M.colors.paletteNames().join(', ') + '.');
    },
    units: function (out) {
      out.text('Distances: m, km, mi, ft, yd, nmi (e.g. 500m, 2.5 km, 1 mi). Areas: sqm, sqkm, ha, acres, sqmi, sqft.');
    },
  };
  T.HELP_TOPICS = HELP_TOPICS;

  def({
    name: 'help', aliases: ['?', 'commands', 'man'], category: 'Basics', noHistory: true,
    summary: 'List commands, or explain one',
    params: [{ name: 'topic', type: 'text', description: 'A command name or: expressions, gdal, formats, keys, basemaps, ramps, units' }],
    examples: ['help', 'help buffer', 'help expressions', 'help gdal'],
    run: function (args, ctx) {
      const out = ctx.out;
      const topic = (args.topic || '').trim().toLowerCase();
      if (!topic) {
        out.text('Type a command and press Enter. Suggestions appear as you type (Tab accepts). Every menu and toolbox action also prints the command it ran, so you can learn by clicking.');
        const cats = {};
        M.commands.all().forEach(function (t) { (cats[t.category || 'Other'] = cats[t.category || 'Other'] || []).push(t); });
        CATEGORY_ORDER.concat(Object.keys(cats).filter(function (c) { return CATEGORY_ORDER.indexOf(c) < 0; })).forEach(function (c) {
          if (!cats[c]) return;
          out.commandList(c, cats[c].map(function (t) { return { name: t.name, summary: t.summary || '' }; }));
        });
        out.text('More: help expressions · help gdal · help formats · help keys · help ramps');
        return;
      }
      if (HELP_TOPICS[topic]) { HELP_TOPICS[topic](out); return; }
      const tool = M.commands.get(topic) || (M.commands.parse(topic, ctx.store.ctx()).tool);
      if (!tool) {
        const s = M.commands.closest(topic, M.commands.all().map(function (t) { return t.name; }));
        throw new Error('No command or help topic "' + topic + '".' + (s ? ' Did you mean "' + s + '"?' : ''));
      }
      out.toolHelp(tool);
    },
  });

  def({
    name: 'undo', category: 'Basics', summary: 'Undo the last change', noHistory: true, params: [],
    run: function (args, ctx) {
      const label = ctx.store.undo();
      if (!label) throw new Error('Nothing to undo');
      return 'Undid: ' + label;
    },
  });
  def({
    name: 'redo', category: 'Basics', summary: 'Redo what was undone', noHistory: true, params: [],
    run: function (args, ctx) {
      const label = ctx.store.redo();
      if (!label) throw new Error('Nothing to redo');
      return 'Redid: ' + label;
    },
  });

  def({
    name: 'clear', aliases: ['cls', 'clear console'], category: 'Basics', summary: 'Clear the console', noHistory: true, params: [],
    run: function (args, ctx) { ctx.app.emit('console:clear'); },
  });

  def({
    name: 'history', category: 'Scripting', summary: 'Show (or save) the commands you ran', noHistory: true,
    params: [P.flag('save', ['save', 'download', 'export'], 'Download them as a script')],
    run: function (args, ctx) {
      const h = ctx.app.history;
      if (!h.length) return 'No commands yet.';
      if (args.save) {
        ctx.io.download(new Blob([ctx.app.historyScript()], { type: 'text/plain' }), 'psicits-script.txt');
        return 'Saved ' + T.plural(h.length, 'command') + ' to psicits-script.txt';
      }
      ctx.out.code(h.join('\n'));
      ctx.out.text('Run them again with "script", or save them with "history save".');
    },
  });

  def({
    name: 'layers', aliases: ['list', 'ls', 'list layers'], category: 'Layers', summary: 'List the layers', noHistory: true, params: [],
    run: function (args, ctx) {
      const ls = ctx.store.ordered();
      if (!ls.length) return 'No layers yet — try "open", "sample countries", or drag a file onto the map.';
      ctx.out.table(ls.map(function (l) {
        return { id: l.id, name: l.name, type: T.describe(l), visible: l.visible ? 'yes' : 'no', selected: ctx.store.selectedIds(l.id).length || '' };
      }), ['id', 'name', 'type', 'visible', 'selected']);
    },
  });

  def({
    name: 'info', aliases: ['describe', 'about layer', 'properties'], category: 'Layers', summary: 'Details about a layer: fields, extent, CRS',
    params: [P.layer('layer', { kinds: ['any'] })],
    examples: ['info counties'],
    run: function (args, ctx) {
      const l = ctx.layer(args.layer);
      const out = ctx.out;
      if (l.type === 'raster') {
        const inf = M.raster.info(l.raster);
        const stats = inf.stats;
        delete inf.stats;
        out.kv(Object.assign({ name: l.name }, flatten(inf)));
        if (Array.isArray(stats) && stats.length) {
          out.table(stats.map(function (s, i) {
            return { band: s.band || l.bandNames[i] || 'b' + (i + 1), min: util.formatNumber(s.min), max: util.formatNumber(s.max), mean: util.formatNumber(s.mean), std: util.formatNumber(s.std), pixels: util.formatNumber(s.count, 0) };
          }));
        }
        return;
      }
      if (l.type === 'tiles') { out.kv({ name: l.name, type: 'tiles', url: l.url, attribution: l.attribution || '' }); return; }
      const b = l.bbox;
      out.kv({
        name: l.name, id: l.id, geometry: l.geometryType, features: util.formatNumber(l.count, 0),
        selected: ctx.store.selectedIds(l.id).length, 'source CRS': l.crs ? M.crs.name(l.crs) + ' (' + l.crs + ')' : 'EPSG:4326',
        extent: b ? b.map(function (x) { return x.toFixed(5); }).join(', ') : 'none',
        source: l.source ? (l.source.name || l.source.url || l.source.command || l.source.kind) : '', filter: l.filter || '',
      });
      const rows = l.fields.map(function (f) {
        const vals = util.values(l.data, f.name);
        const row = { field: f.name, type: f.type };
        if (f.type === 'number') {
          const s = util.stats(vals);
          row.min = util.formatNumber(s.min); row.max = util.formatNumber(s.max); row.mean = util.formatNumber(s.mean); row.nulls = s.nulls;
        } else {
          const fr = util.frequencies(vals, 3);
          row.distinct = new Set(vals.map(function (v) { return typeof v === 'object' ? JSON.stringify(v) : v; })).size;
          row.examples = fr.filter(function (x) { return x.value !== null; }).map(function (x) { return String(x.value).slice(0, 24); }).join(', ');
        }
        return row;
      });
      if (rows.length) out.table(rows, ['field', 'type', 'min', 'max', 'mean', 'distinct', 'examples', 'nulls']);
      else out.text('This layer has no attributes.');
    },
  });
  function flatten(o, prefix, acc) {
    acc = acc || {};
    Object.keys(o || {}).forEach(function (k) {
      const v = o[k];
      const key = prefix ? prefix + '.' + k : k;
      if (v && typeof v === 'object' && !Array.isArray(v)) flatten(v, key, acc);
      else if (Array.isArray(v)) acc[key] = v.map(function (x) { return typeof x === 'object' ? JSON.stringify(x) : (typeof x === 'number' ? util.formatNumber(x) : x); }).join(', ');
      else acc[key] = typeof v === 'number' ? util.formatNumber(v) : v;
    });
    return acc;
  }

  def({
    name: 'rename', aliases: ['rename layer'], category: 'Layers', summary: 'Rename a layer',
    params: [P.layer('layer', { kinds: ['any'] }), { name: 'to', type: 'name', keywords: ['to', 'as'], required: true, positional: true, description: 'New name' }],
    forms: ['{layer} (to|as) {to}'],
    examples: ['rename L1 to parcels', 'rename "city limits" to boundary'],
    run: function (args, ctx) {
      const l = ctx.layer(args.layer);
      const old = l.name;
      ctx.store.update(l, { name: args.to }, { label: 'Rename ' + old });
      return 'Renamed "' + old + '" to "' + l.name + '"';
    },
  });

  def({
    name: 'remove', aliases: ['delete layer', 'remove layer', 'drop', 'rm', 'close layer'], category: 'Layers', summary: 'Remove a layer (undo brings it back)',
    params: [P.layer('layer', { kinds: ['any'], useActive: false, required: false }), P.flag('all', ['all', 'everything'], 'Remove every layer')],
    examples: ['remove roads', 'remove all'],
    run: async function (args, ctx) {
      if (args.all) {
        const n = ctx.store.layers.length;
        if (!n) return 'There are no layers.';
        if (!(await ctx.confirm('Remove all ' + n + ' layers? (Undo can bring them back.)', { danger: true, ok: 'Remove all' }))) return 'Cancelled';
        await ctx.store.transaction('Remove all layers', function () { ctx.store.layers.slice().forEach(function (l) { ctx.store.remove(l.id); }); });
        return 'Removed ' + T.plural(n, 'layer');
      }
      if (!args.layer) throw new Error('Which layer? e.g. remove roads');
      const l = ctx.store.remove(args.layer);
      return 'Removed "' + l.name + '" (undo to restore)';
    },
  });

  def({
    name: 'duplicate', aliases: ['copy layer', 'clone'], category: 'Layers', summary: 'Copy a layer',
    params: [P.layer('layer', { kinds: ['any'] }), P.as()],
    run: function (args, ctx) {
      const l = ctx.layer(args.layer);
      const spec = { type: l.type, name: T.outName(ctx, args, l, 'copy'), style: l.style, opacity: l.opacity, visible: l.visible, source: l.source, crs: l.crs };
      if (l.type === 'vector') spec.data = l.data;
      else if (l.type === 'raster') spec.raster = l.raster;
      else Object.assign(spec, { url: l.url, tileSize: l.tileSize, attribution: l.attribution });
      ctx.add(spec, { verb: 'Copied to' });
    },
  });

  def({
    name: 'show', aliases: ['unhide', 'turn on'], category: 'Layers', summary: 'Make a layer visible',
    params: [P.layer('layer', { kinds: ['any'], useActive: false, required: false }), P.flag('all', ['all', 'everything'])],
    run: function (args, ctx) {
      const ls = args.all ? ctx.store.layers : [ctx.layer(args.layer || ctx.store.activeId)];
      ls.forEach(function (l) { if (!l.visible) ctx.store.update(l, { visible: true }, { label: 'Show ' + l.name }); });
    },
  });
  def({
    name: 'hide', aliases: ['turn off'], category: 'Layers', summary: 'Hide a layer',
    params: [P.layer('layer', { kinds: ['any'], useActive: false, required: false }), P.flag('all', ['all', 'everything'])],
    run: function (args, ctx) {
      const ls = args.all ? ctx.store.layers : [ctx.layer(args.layer || ctx.store.activeId)];
      ls.forEach(function (l) { if (l.visible) ctx.store.update(l, { visible: false }, { label: 'Hide ' + l.name }); });
    },
  });
  def({
    name: 'solo', aliases: ['only', 'isolate'], category: 'Layers', summary: 'Show only this layer',
    params: [P.layer('layer', { kinds: ['any'] })],
    run: async function (args, ctx) {
      const target = ctx.layer(args.layer);
      await ctx.store.transaction('Solo ' + target.name, function () {
        ctx.store.layers.forEach(function (l) { const v = l.id === target.id; if (l.visible !== v) ctx.store.update(l, { visible: v }); });
      });
    },
  });

  def({
    name: 'opacity', aliases: ['transparency', 'alpha'], category: 'Layers', summary: 'Set layer opacity (0–100%)',
    params: [P.layer('layer', { kinds: ['any'] }), P.number('value', { required: true, percent: true, positional: true, description: 'e.g. 50% or 0.5' })],
    examples: ['opacity counties 60%'],
    run: function (args, ctx) {
      const l = ctx.layer(args.layer);
      let v = args.value;
      if (v > 1) v = v / 100;
      v = Math.max(0, Math.min(1, v));
      ctx.store.update(l, { opacity: v }, { label: 'Opacity ' + l.name });
      return '"' + l.name + '" opacity ' + Math.round(v * 100) + '%';
    },
  });

  def({
    name: 'move', aliases: ['reorder', 'order'], category: 'Layers', summary: 'Move a layer up/down in the drawing order',
    params: [P.layer('layer', { kinds: ['any'] }), P.choice('where', ['top', 'bottom', 'up', 'down'], { required: true, aliases: { front: 'top', back: 'bottom', raise: 'up', lower: 'down', above: 'up', below: 'down' } })],
    forms: ['{layer} [to] [the] {where}'],
    examples: ['move roads to top', 'move parcels down'],
    run: function (args, ctx) {
      const l = ctx.layer(args.layer);
      const i = ctx.store.layers.indexOf(l);
      const n = ctx.store.layers.length;
      const to = { top: n - 1, bottom: 0, up: i + 1, down: i - 1 }[args.where];
      ctx.store.move(l, to);
    },
  });

  def({
    name: 'use', aliases: ['activate', 'focus', 'choose', 'pick'], category: 'Layers', summary: 'Make a layer the current one (commands default to it)',
    params: [P.layer('layer', { kinds: ['any'], useActive: false })],
    run: function (args, ctx) {
      const l = ctx.store.setActive(args.layer);
      return 'Now working with "' + l.name + '"';
    },
  });

  def({
    name: 'table', aliases: ['attributes', 'open table', 'attribute table', 'show table'], category: 'Layers', summary: 'Open the attribute table',
    params: [P.layer('layer', { kinds: ['vector'] })],
    noHistory: true,
    run: function (args, ctx) { ctx.app.emit('open-table', { layerId: args.layer }); },
  });

  /* --------------------------------------------------------------- view */

  def({
    name: 'zoom', aliases: ['zoom to', 'go to', 'goto', 'fly to', 'center', 'show me', 'pan to'], formatVerb: 'zoom to', category: 'Basics',
    format: function (args, ctx, f) {
      if (args.target) { const l = (ctx.layers || []).find(function (x) { return x.id === args.target; }); return 'zoom to ' + f.quote(l ? l.name : args.target); }
      if (args.what) return args.what === 'in' || args.what === 'out' ? 'zoom ' + args.what : 'zoom to ' + args.what;
      if (args.place && /^\d{1,2}(\.\d+)?$/.test(args.place.trim())) return 'zoom ' + args.place.trim();
      if (args.place) return 'zoom to ' + args.place;
      return 'zoom';
    },
    summary: 'Zoom to a layer, the selection, a place, coordinates or a zoom level',
    params: [
      P.layer('target', { kinds: ['any'], required: false, useActive: false, description: 'Layer to zoom to' }),
      P.choice('what', ['selection', 'all', 'world', 'in', 'out'], { aliases: { selected: 'selection', everything: 'all', layers: 'all', 'full extent': 'all', earth: 'world', globe: 'world', closer: 'in', back: 'out' } }),
      { name: 'place', type: 'place', description: 'A place name, "lat, lon", or a zoom level' },
    ],
    examples: ['zoom to counties', 'zoom to selection', 'zoom to Chicago', 'zoom to 41.79, -87.60', 'zoom 12', 'zoom all'],
    run: async function (args, ctx) {
      const map = ctx.map;
      if (args.target) { map.zoomToLayer(ctx.layer(args.target)); return; }
      switch (args.what) {
        case 'selection': {
          let b = null;
          ctx.store.selection.forEach(function (set, lid) { ctx.store.selectedFeatures(lid).forEach(function (f) { b = util.bboxUnion(b, util.bbox(f)); }); });
          if (!b) throw new Error('Nothing is selected');
          map.fitBounds(b);
          return;
        }
        case 'all': {
          let b = null;
          ctx.store.layers.forEach(function (l) { if (l.visible && l.bbox) b = util.bboxUnion(b, l.bbox); });
          if (!b) throw new Error('No layers with an extent');
          map.fitBounds(b);
          return;
        }
        case 'world': map.map.flyTo({ center: [0, 20], zoom: 1.3 }); return;
        case 'in': map.map.zoomIn(); return;
        case 'out': map.map.zoomOut(); return;
        default: break;
      }
      const place = (args.place || '').trim();
      if (!place) {
        const act = ctx.store.active;
        if (act) { map.zoomToLayer(act); return; }
        throw new Error('Zoom to what? A layer, "selection", a place, or a number.');
      }
      const nums = place.match(/-?\d+(\.\d+)?/g);
      if (/^\d{1,2}(\.\d+)?$/.test(place)) { map.map.easeTo({ zoom: Math.max(0, Math.min(22, parseFloat(place))) }); return; }
      if (nums && nums.length === 2 && /^[\s\d.,+\-°NSEWnsew]+$/.test(place)) {
        let a = parseFloat(nums[0]), b = parseFloat(nums[1]);
        // "lat, lon" is the common way to write coordinates; swap when that's the only valid reading
        let lon = b, lat = a;
        if (Math.abs(a) > 90 && Math.abs(b) <= 90) { lon = a; lat = b; }
        if (/[EW]/i.test(place.split(',')[0] || '')) { lon = a; lat = b; }
        map.map.flyTo({ center: [lon, lat], zoom: Math.max(map.map.getZoom(), 13) });
        map.highlight({ type: 'Point', coordinates: [lon, lat] });
        return 'Centered on ' + lat.toFixed(5) + ', ' + lon.toFixed(5);
      }
      return ctx.run('find ' + place);
    },
  });

  def({
    name: 'basemap', aliases: ['background', 'base map', 'basemaps'], category: 'Basics', summary: 'Change the background map',
    params: [{ name: 'name', type: 'text', description: 'light, streets, bright, dark, fiord, satellite, topo, osm, none — or an XYZ URL' }],
    examples: ['basemap satellite', 'basemap dark', 'basemap none'],
    run: function (args, ctx) {
      if (!args.name) { M.toolkit.HELP_TOPICS.basemaps(ctx.out); return; }
      const n = ctx.map.setBasemap(args.name.trim());
      return 'Basemap: ' + (ctx.map.BASEMAPS[n] ? ctx.map.BASEMAPS[n].label : n);
    },
  });

  def({
    name: 'legend', category: 'Style', summary: 'Show or hide the map legend',
    params: [P.choice('state', ['on', 'off', 'toggle'], { default: 'toggle', aliases: { show: 'on', hide: 'off', yes: 'on', no: 'off' } })],
    noHistory: true,
    run: function (args, ctx) { ctx.app.emit('legend', args.state); },
  });

  def({
    name: 'globe', aliases: ['projection'], category: 'Basics', summary: 'Switch between a globe and a flat (Web Mercator) map',
    params: [P.choice('state', ['on', 'off', 'toggle'], { default: 'toggle', aliases: { globe: 'on', flat: 'off', mercator: 'off' } })],
    run: function (args, ctx) {
      const cur = ctx.map.map.getProjection && ctx.map.map.getProjection();
      const isGlobe = cur && cur.type === 'globe';
      const on = args.state === 'toggle' ? !isGlobe : args.state === 'on';
      ctx.map.setProjection(on ? 'globe' : 'mercator');
      if (on && ctx.map.map.getZoom() > 5) ctx.map.map.easeTo({ zoom: 2.2 });
      return on ? 'Globe view' : 'Flat map';
    },
  });

  def({
    name: 'tilt', aliases: ['pitch'], category: 'Basics', summary: 'Tilt the map (0 = flat, 60 = steep 3D view)',
    params: [P.number('degrees', { default: 50, positional: true }), P.number('bearing', { keywords: ['bearing', 'rotate'] })],
    run: function (args, ctx) {
      const o = { pitch: Math.max(0, Math.min(75, args.degrees)) };
      if (args.bearing !== undefined) o.bearing = args.bearing;
      ctx.map.map.easeTo(o);
    },
  });
  def({
    name: 'north', aliases: ['reset view', 'flat'], category: 'Basics', summary: 'Reset rotation and tilt', params: [],
    run: function (args, ctx) { ctx.map.map.easeTo({ bearing: 0, pitch: 0 }); },
  });

  def({
    name: 'theme', aliases: ['dark mode', 'light mode'], category: 'Basics', summary: 'Switch the interface between light and dark',
    params: [P.choice('mode', ['dark', 'light', 'auto'], { aliases: { night: 'dark', day: 'light', system: 'auto' } })],
    noHistory: true,
    run: function (args, ctx) { ctx.app.emit('theme', args.mode || 'toggle'); },
  });

  /* ------------------------------------------------------------- project */

  def({
    name: 'new', aliases: ['new project', 'reset', 'start over'], category: 'Data', summary: 'Start a new, empty project', params: [], noHistory: true,
    run: async function (args, ctx) {
      if (ctx.store.layers.length && !(await ctx.confirm('Start a new project? Unsaved layers will be removed.', { danger: true, ok: 'New project' }))) return 'Cancelled';
      ctx.store.clear();
      ctx.app.history.length = 0;
      return 'New project';
    },
  });

  def({
    name: 'save', aliases: ['save project', 'save as'], category: 'Data', summary: 'Download the whole project (layers, styles, view) as one file',
    params: [{ name: 'name', type: 'name', positional: true, description: 'File name' }],
    run: function (args, ctx) {
      const proj = ctx.store.toJSON();
      proj.view = ctx.map.getView();
      proj.history = ctx.app.history.slice(-200);
      const fname = util.slug(args.name || 'project') + '.psicits.json';
      const blob = new Blob([JSON.stringify(proj)], { type: 'application/json' });
      ctx.io.download(blob, fname);
      return 'Saved ' + fname + ' (' + util.formatBytes(blob.size) + '). Open it later with "open" or drag it onto the map.';
    },
  });

  /* ---------------------------------------------------------- scripting */

  def({
    name: 'script', aliases: ['run script', 'macro', 'editor', 'batch'], category: 'Scripting', summary: 'Open the script editor to run many commands at once',
    params: [], noHistory: true,
    run: function (args, ctx) { ctx.app.emit('script-editor'); },
  });

  def({
    name: 'js', aliases: ['javascript', 'eval'], category: 'Scripting', raw: true, noHistory: false,
    summary: 'Run JavaScript with the PSICITS API (layers, turf, run(), add())',
    params: [{ name: 'code', type: 'rest', required: true, description: 'JavaScript code' }],
    examples: ['js return layers.roads.features.length', 'js add(turf.randomPoint(100, {bbox: view()}), "random")', "js await run('buffer roads 100 m')"],
    run: async function (args, ctx) {
      return runJS(args.code, ctx);
    },
  });

  async function runJS(code, ctx) {
    const store = ctx.store;
    const layers = new Proxy({}, {
      get: function (_, key) {
        const l = store.get(String(key));
        if (!l) return undefined;
        return l.type === 'vector' ? l.data : l.type === 'raster' ? l.raster : l;
      },
      ownKeys: function () { return store.layers.map(function (l) { return l.name; }); },
      getOwnPropertyDescriptor: function () { return { enumerable: true, configurable: true }; },
    });
    const api = {
      M: M, turf: root.turf, map: ctx.map.map, layers: layers, store: store,
      log: function () { ctx.out.text(Array.prototype.map.call(arguments, function (a) { return typeof a === 'string' ? a : safeJSON(a); }).join(' ')); },
      add: function (data, name) {
        if (data && data.width && data.bands) return ctx.add({ type: 'raster', name: name || 'script_raster', raster: data });
        return ctx.add({ type: 'vector', name: name || 'script_result', data: data });
      },
      run: function (cmd) { return ctx.run(cmd); },
      view: function () { return ctx.map.viewBBox(); },
      selected: function (name) { return { type: 'FeatureCollection', features: store.selectedFeatures(name || store.activeId) }; },
      table: function (rows, cols) { ctx.out.table(rows, cols); },
    };
    const names = Object.keys(api);
    // eslint-disable-next-line no-new-func
    const fn = new Function(names.join(','), '"use strict"; return (async () => {\n' + code + '\n})();');
    const value = await fn.apply(null, names.map(function (n) { return api[n]; }));
    if (value !== undefined) {
      if (value && value.type === 'FeatureCollection') { api.add(value, 'script_result'); return; }
      ctx.out.code(typeof value === 'string' ? value : safeJSON(value));
    }
  }
  function safeJSON(v) {
    try {
      const s = JSON.stringify(v, function (k, x) { return ArrayBuffer.isView(x) ? '[' + x.constructor.name + ' ×' + x.length + ']' : x; }, 2);
      return s && s.length > 20000 ? s.slice(0, 20000) + '\n…' : s;
    } catch (e) { return String(v); }
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
