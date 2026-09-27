/*
 * PSICITS — command runtime: parses text, runs tools, reports results.
 * Every action in the UI goes through here, so it can be echoed as text,
 * repeated, and saved as a script.
 */
(function (root) {
  'use strict';

  const M = root.PSICITS;
  const util = M.util;
  const store = M.store;
  const C = M.commands;

  const app = (M.app = {
    history: [],          // commands run this session (canonical text)
    busy: false,
  });

  const bus = util.Emitter();
  app.on = bus.on.bind(bus);
  app.emit = bus.emit;

  /* ------------------------------------------------------------ output */

  // The console panel replaces this; the default logs to the devtools console.
  app.output = function (title) {
    const log = function (kind) { return function () { console.log('[' + kind + ']', title || '', Array.prototype.slice.call(arguments)); }; };
    return {
      text: log('text'), success: log('ok'), warn: log('warn'), error: log('error'), note: log('note'),
      table: log('table'), kv: log('kv'), list: log('list'), code: log('code'), layer: log('layer'), chart: log('chart'),
      link: log('link'), html: log('html'), progress: function () {}, done: function () {},
    };
  };

  /* ----------------------------------------------------------- context */

  function makeCtx(out, parsed) {
    const ctx = {
      out: out,
      store: store,
      map: M.mapview,
      io: M.io,
      ui: M.ui,
      app: app,
      parsed: parsed,
      layer: function (id) { return store.require(id); },
      vector: function (id) { return store.require(id, 'vector'); },
      raster: function (id) { return store.require(id, 'raster'); },
      meters: function (d) { return d ? util.toMeters(d.value, d.units) : 0; },
      /** Unique output name: args.as or `${base}` */
      name: function (wanted, fallback) { return store.uniqueName(wanted || fallback || 'result'); },
      progress: function (msg) { out.progress(msg); },
      confirm: function (msg, opts) { return M.ui.confirm(msg, opts); },
      tick: util.tick,
      /** Add a layer and report it. */
      add: function (spec, opts) {
        opts = opts || {};
        const first = store.layers.length === 0;
        const layer = store.add(spec, { label: opts.label });
        out.layer(layer, opts.verb || 'Added');
        if (spec.data && spec.data.warnings) spec.data.warnings.forEach(function (w) { out.warn(w); });
        if ((first || opts.zoom) && layer.bbox && M.mapview.map) M.mapview.zoomToLayer(layer);
        return layer;
      },
      /** Add a vector result of a geoprocessing tool. */
      result: function (fc, name, opts) {
        opts = opts || {};
        const warnings = fc && fc.warnings;
        const layer = ctx.add({ type: 'vector', name: name, data: fc, source: { kind: 'derived', command: parsed ? parsed.canonical : '' } }, Object.assign({ verb: 'Created' }, opts));
        if (warnings && warnings.length) warnings.forEach(function (w) { out.warn(w); });
        if (!layer.count) out.warn('The result is empty.');
        return layer;
      },
      run: function (text) { return app.run(text, { nested: true }); },
    };
    return ctx;
  }

  /* --------------------------------------------------------------- run */

  let queue = Promise.resolve();

  /**
   * Run a command line. opts: { echo (text shown), silent, nested, source: 'console'|'toolbox'|'ui'|'script' }
   * Resolves to { ok, value, error, parsed }.
   */
  app.run = function (text, opts) {
    opts = opts || {};
    if (opts.nested) return runNow(text, opts);
    const p = queue.then(function () { return runNow(text, opts); });
    queue = p.catch(function () {});
    return p;
  };

  async function runNow(text, opts) {
    const src = String(text || '').trim();
    if (!src || src.startsWith('#')) return { ok: true };
    const parsed = C.parse(src, store.ctx());
    const out = app.output(opts.echo || src, { source: opts.source, nested: opts.nested });
    if (!parsed.ok) {
      parsed.errors.forEach(function (e) { out.error(e); });
      if (parsed.suggestions && parsed.suggestions.length) out.suggest(parsed.suggestions.map(function (s) { return src.replace(/^\s*\S+/, s); }));
      out.done('error');
      return { ok: false, error: parsed.errors.join('\n'), parsed: parsed };
    }
    return execute(parsed, src, out, opts);
  }

  /** Run a tool with already-typed arguments (toolbox, UI buttons). */
  app.runTool = function (name, args, opts) {
    opts = opts || {};
    const tool = C.get(name);
    if (!tool) return Promise.reject(new Error('Unknown tool ' + name));
    const p = queue.then(function () {
      const ctxInfo = store.ctx();
      const parsed = { ok: true, tool: tool, args: Object.assign({}, args), errors: [], warnings: [], missing: [] };
      // defaults
      tool.params.forEach(function (prm) { if (parsed.args[prm.name] === undefined && prm.default !== undefined) parsed.args[prm.name] = prm.default; });
      parsed.canonical = C.format(tool, parsed.args, ctxInfo);
      const missing = tool.params.filter(function (prm) { return prm.required && (parsed.args[prm.name] === undefined || parsed.args[prm.name] === ''); });
      const out = app.output(parsed.canonical, { source: opts.source || 'toolbox' });
      if (missing.length) {
        out.error('Missing ' + missing.map(function (m) { return m.label || m.name; }).join(', '));
        out.done('error');
        return { ok: false, error: 'missing' };
      }
      return execute(parsed, parsed.canonical, out, opts);
    });
    queue = p.catch(function () {});
    return p;
  };

  async function execute(parsed, src, out, opts) {
    const tool = parsed.tool;
    const t0 = (root.performance || Date).now();
    if (parsed.usedActive && !opts.silent) out.note('using the selected layer "' + parsed.usedActive + '"');
    if (parsed.canonical && norm(parsed.canonical) !== norm(src) && !opts.silent && opts.source !== 'toolbox') out.note('→ ' + parsed.canonical);
    app.busy = true;
    bus.emit('busy', true);
    try {
      const ctx = makeCtx(out, parsed);
      const value = await tool.run(parsed.args, ctx);
      // Let camera moves finish so the next command sees the final view
      // (e.g. "zoom to Chicago" followed by "osm parks in view").
      if (M.mapview && M.mapview.settle) await M.mapview.settle();
      if (value && typeof value === 'object' && value.message) out.success(value.message);
      else if (typeof value === 'string') out.success(value);
      const ms = (root.performance || Date).now() - t0;
      out.done('ok', ms);
      if (!tool.noHistory && !opts.nested) {
        app.history.push(parsed.canonical || src);
        if (app.history.length > 500) app.history.shift();
      }
      bus.emit('ran', { tool: tool.name, args: parsed.args, text: parsed.canonical || src });
      return { ok: true, value: value, parsed: parsed };
    } catch (e) {
      if (root.console) console.error(e);
      out.error(e && e.message ? e.message : String(e));
      out.done('error');
      return { ok: false, error: e && e.message, parsed: parsed };
    } finally {
      app.busy = false;
      bus.emit('busy', false);
    }
  }

  function norm(s) { return String(s).toLowerCase().replace(/["']/g, '').replace(/\s+/g, ' ').trim(); }

  /** Run a multi-line script of commands. Stops at the first error unless opts.keepGoing. */
  app.runScript = async function (text, opts) {
    opts = opts || {};
    const lines = C.splitScript(text);
    let ok = 0;
    for (const ln of lines) {
      const r = await app.run(ln.text, { source: 'script' });
      if (!r.ok) {
        if (!opts.keepGoing) return { ok: false, ran: ok, failedLine: ln.line, error: r.error };
      } else ok++;
    }
    return { ok: true, ran: ok };
  };

  /** Text of the session so far, as a runnable script. */
  app.historyScript = function () {
    return '# PSICITS script — ' + new Date().toISOString().slice(0, 16).replace('T', ' ') + '\n' +
      '# Run it again with: run script (or drop this file on the map)\n\n' + app.history.join('\n') + '\n';
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
