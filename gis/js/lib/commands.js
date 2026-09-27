/*
 * PSICITS — the text command language.
 *
 * Turns plain text like
 *
 *     buffer roads 500 m dissolve as road_zone
 *     clip parcels to "city limits"
 *     color counties by population 7 jenks reds
 *     select schools where enrollment > 500
 *     count crimes in neighborhoods
 *
 * into a tool call { tool, args } without any AI: a verb picks the tool, then
 * the rest of the sentence is matched against the tool's typed parameters
 * (layer names, field names, numbers with units, enum words, colors, …),
 * using optional per-tool "forms" for word orders that need them.
 *
 * DOM-free. Tools register metadata here (and a `run` function the app calls).
 */
(function (root) {
  'use strict';

  const M = (root.PSICITS = root.PSICITS || {});
  const util = M.util;

  /* ============================================================ registry */

  const tools = [];
  const byName = new Map();

  // Words that carry no meaning on their own. Tools can opt specific ones
  // back in through forms or keywords.
  const STOPWORDS = new Set(('a an the by to with of from into onto for using use on at in within around near ' +
    'and then please layer layers me my our it its all please now just called named').split(' '));
  // Polite or conversational openers skipped before the verb.
  const OPENERS = [['please'], ['can', 'you'], ['could', 'you'], ['now'], ['then'], ['ok'], ['okay'], ['i', 'want', 'to'], ['lets'], ["let's"], ['go', 'ahead', 'and']];

  /**
   * Register a tool. Metadata:
   *   name, aliases[], title, category, summary, params[], forms[], examples[],
   *   raw (bool: pass the rest of the line unparsed to the single 'rest' param),
   *   run(args, ctx) — used by the app.
   */
  function define(tool) {
    if (!tool || !tool.name) throw new Error('Tool needs a name');
    tool.params = tool.params || [];
    tool.aliases = tool.aliases || [];
    tool.forms = (tool.forms || []).map(function (f) { return typeof f === 'string' ? { src: f, elements: parseForm(f) } : f; });
    tool.examples = tool.examples || [];
    tool.params.forEach(function (p) {
      p.keywords = (p.keywords || []).map(function (k) { return k.toLowerCase(); });
      // A parameter's own name works as a keyword too ("units mi", "classes 7"),
      // except for free-form and positional-first types.
      if (p.type !== 'flag' && p.type !== 'layer' && p.type !== 'layers' && p.type !== 'rest' && p.name.length > 2 && !p.noNameKeyword) {
        [p.name].concat(p.keys || []).forEach(function (k) {
          const lk = String(k).toLowerCase();
          if (/^[a-z_]+$/.test(lk) && p.keywords.indexOf(lk) < 0) (p.implicit = p.implicit || []).push(lk);
        });
      }
      p.words = (p.words || (p.type === 'flag' ? [p.name] : [])).map(function (k) { return k.toLowerCase(); });
      p.keys = [p.name.toLowerCase()].concat((p.keys || []).map(function (k) { return k.toLowerCase(); }));
    });
    if (byName.has(tool.name)) {
      const i = tools.indexOf(byName.get(tool.name));
      tools.splice(i, 1);
    }
    tools.push(tool);
    byName.set(tool.name, tool);
    verbIndex = null;
    return tool;
  }

  function get(name) { return byName.get(name) || null; }

  let verbIndex = null; // [{ words: [..], tool }]
  function verbs() {
    if (verbIndex) return verbIndex;
    verbIndex = [];
    tools.forEach(function (t) {
      [t.name].concat(t.aliases).forEach(function (v) {
        verbIndex.push({ words: String(v).toLowerCase().split(/[\s_]+/), text: String(v).toLowerCase(), tool: t, primary: v === t.name });
      });
    });
    // Longest phrases first so "add field" wins over "add".
    verbIndex.sort(function (a, b) { return b.words.length - a.words.length; });
    return verbIndex;
  }

  /* =========================================================== tokenizer */

  const UNIT_RE = /^(m|meters?|metres?|km|kms|kilometers?|kilometres?|mi|miles?|ft|feet|foot|yd|yds|yards?|nm|nmi|nauticalmiles?|cm|centimeters?|in|inch|inches|usft|us-ft|deg|degrees?|px|pixels?|%|x)$/i;

  function normalizeQuotes(s) {
    return String(s).replace(/[‘’‚′]/g, "'").replace(/[“”„″]/g, '"');
  }

  /**
   * Split a command line into tokens:
   *   { t: 'word' | 'quoted' | 'number' | 'comma' | 'kv', v, raw, start, end, key?, unit? }
   * "500m" becomes a number token followed by a unit word (flagged `attached`).
   */
  function tokenize(text) {
    const s = normalizeQuotes(text);
    const out = [];
    let i = 0;
    const n = s.length;
    while (i < n) {
      const c = s[i];
      if (/\s/.test(c)) { i++; continue; }
      const start = i;
      if (c === ',' || c === ';') { out.push({ t: 'comma', v: c, raw: c, start: start, end: i + 1 }); i++; continue; }
      if (c === '"' || c === "'") {
        let j = i + 1, val = '';
        while (j < n && s[j] !== c) {
          if (s[j] === '\\' && j + 1 < n && (s[j + 1] === c || s[j + 1] === '\\')) { val += s[j + 1]; j += 2; continue; }
          val += s[j];
          j++;
        }
        out.push({ t: 'quoted', v: val, raw: s.slice(start, Math.min(n, j + 1)), start: start, end: Math.min(n, j + 1), q: c, open: j >= n });
        i = j + 1;
        continue;
      }
      // a run of non-space characters (quotes inside, e.g. where="a b", are respected)
      let j = i;
      while (j < n && !/[\s,;]/.test(s[j])) {
        if ((s[j] === '"' || s[j] === "'") && j > i && s[j - 1] === '=') {
          const q = s[j];
          j++;
          while (j < n && s[j] !== q) j++;
          j = Math.min(n, j + 1);
          continue;
        }
        j++;
      }
      const raw = s.slice(i, j);
      i = j;
      // key=value (only word-ish keys)
      const kv = /^([A-Za-z_][\w-]*)=(.*)$/.exec(raw);
      if (kv) {
        let val = kv[2];
        let quoted = false;
        if (val.length >= 2 && (val[0] === '"' || val[0] === "'") && val[val.length - 1] === val[0]) { val = val.slice(1, -1); quoted = true; }
        out.push({ t: 'kv', key: kv[1].toLowerCase(), v: val, quoted: quoted, raw: raw, start: start, end: j });
        continue;
      }
      // number with attached unit: 500m, 2.5km, -3, 1e3, 50%
      const num = /^([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)([a-z%]+(?:-[a-z]+)?)?$/i.exec(raw);
      if (num && (!num[2] || UNIT_RE.test(num[2]))) {
        const numEnd = start + num[1].length;
        out.push({ t: 'number', v: parseFloat(num[1]), raw: num[1], start: start, end: numEnd });
        if (num[2]) out.push({ t: 'word', v: num[2], raw: num[2], start: numEnd, end: j, attached: true });
        continue;
      }
      out.push({ t: 'word', v: raw, raw: raw, start: start, end: j });
    }
    return out;
  }

  const low = function (tok) { return tok && (tok.t === 'word' || tok.t === 'quoted') ? String(tok.v).toLowerCase() : null; };

  /* ================================================================ forms */

  // "{layer} (to|by|with) {clip} [as {as}]" -> elements
  function parseForm(src) {
    src = String(src).replace(/\[([^\[\]{}()]*\|[^\[\]{}()]*)\]/g, '[($1)]');
    const toks = src.match(/\{[^}]+\}|\(|\)|\[|\]|\||[^\s()[\]{}|]+/g) || [];
    let p = 0;
    function seq(until) {
      const els = [];
      while (p < toks.length && toks[p] !== until) {
        const t = toks[p];
        if (t === '[') { p++; els.push({ opt: seq(']') }); p++; }
        else if (t === '(') {
          p++;
          const alts = [];
          let cur = [];
          while (p < toks.length && toks[p] !== ')') {
            if (toks[p] === '|') { alts.push(cur.join(' ')); cur = []; }
            else cur.push(toks[p]);
            p++;
          }
          alts.push(cur.join(' '));
          p++;
          els.push({ lit: alts.map(function (a) { return a.toLowerCase().split(' '); }) });
        } else if (t[0] === '{') { els.push({ slot: t.slice(1, -1) }); p++; }
        else { els.push({ lit: [[t.toLowerCase()]] }); p++; }
      }
      return els;
    }
    return seq(null);
  }

  /* ======================================================== name matching */

  function layerNames(layer) {
    const names = [layer.name, layer.id];
    return names.filter(Boolean);
  }

  /**
   * Find the layer referred to by tokens starting at index i (longest match
   * first, up to 8 words). Returns { layer, len, exact } or null.
   */
  function matchLayerAt(tokens, i, ctx, filter) {
    const layers = (ctx && ctx.layers) || [];
    if (!layers.length) return null;
    const maxLen = Math.min(8, tokens.length - i);
    for (let len = maxLen; len >= 1; len--) {
      const slice = tokens.slice(i, i + len);
      if (slice.some(function (t) { return t.t !== 'word' && t.t !== 'quoted' && t.t !== 'number'; })) continue;
      if (len > 1 && slice.some(function (t) { return t.t === 'quoted'; })) continue;
      const phrase = slice.map(function (t) { return String(t.t === 'number' ? t.raw : t.v); }).join(' ');
      const hit = findLayer(phrase, ctx, filter);
      if (hit) return { layer: hit.layer, len: len, exact: hit.exact };
    }
    return null;
  }

  /** Resolve a layer reference (id, exact name, case-insensitive, normalised). */
  function findLayer(ref, ctx, filter) {
    const layers = ((ctx && ctx.layers) || []).filter(function (l) { return !filter || filter(l); });
    if (ref === null || ref === undefined) return null;
    const s = String(ref);
    let l = layers.find(function (x) { return x.id === s; });
    if (l) return { layer: l, exact: true };
    l = layers.find(function (x) { return x.name === s; });
    if (l) return { layer: l, exact: true };
    const lo = s.toLowerCase();
    l = layers.find(function (x) { return String(x.name).toLowerCase() === lo || String(x.id).toLowerCase() === lo; });
    if (l) return { layer: l, exact: true };
    const nn = util.normName(s);
    if (!nn) return null;
    l = layers.find(function (x) { return util.normName(x.name) === nn; });
    if (l) return { layer: l, exact: false };
    // simple plural/singular tolerance: "park" -> "parks", "counties" -> "county"
    const variants = [nn + 's', nn + 'es', nn.replace(/ies$/, 'y'), nn.replace(/s$/, ''), nn.replace(/es$/, '')];
    l = layers.find(function (x) { const k = util.normName(x.name); return variants.indexOf(k) >= 0; });
    if (l) return { layer: l, exact: false };
    return null;
  }

  function suggestLayer(ref, ctx) {
    const names = ((ctx && ctx.layers) || []).map(function (l) { return l.name; });
    return closest(ref, names);
  }

  function closest(word, candidates, maxDist) {
    const w = util.normName(word);
    if (!w) return null;
    let best = null, bestD = Infinity;
    const max = maxDist !== undefined ? maxDist : (w.length <= 3 ? 1 : w.length <= 7 ? 2 : 3);
    (candidates || []).forEach(function (c) {
      const cn = util.normName(c);
      let d = util.editDistance(w, cn, max);
      if (d > max && cn.startsWith(w) && w.length >= 3) d = max; // prefix
      if (d < bestD) { bestD = d; best = c; }
    });
    return bestD <= max ? best : null;
  }

  function fieldsOfParamLayer(param, args, tool, ctx) {
    let layerParam = param.of;
    if (!layerParam) {
      const lp = tool.params.find(function (p) { return p.type === 'layer'; });
      layerParam = lp && lp.name;
    }
    const id = layerParam ? args[layerParam] : null;
    const layer = id ? ((ctx.layers || []).find(function (l) { return l.id === id; })) : null;
    return layer ? { layer: layer, fields: (layer.fields || []).map(function (f) { return typeof f === 'string' ? f : f.name; }), bands: layer.bandNames || [] } : null;
  }

  function allFieldNames(ctx) {
    const set = new Set();
    ((ctx && ctx.layers) || []).forEach(function (l) {
      (l.fields || []).forEach(function (f) { set.add(typeof f === 'string' ? f : f.name); });
      (l.bandNames || []).forEach(function (b) { set.add(b); });
    });
    return Array.from(set);
  }

  function findField(ref, fields) {
    if (!fields) return null;
    const s = String(ref);
    if (fields.indexOf(s) >= 0) return s;
    const lo = s.toLowerCase();
    let f = fields.find(function (x) { return x.toLowerCase() === lo; });
    if (f !== undefined) return f;
    const nn = util.normName(s);
    f = fields.find(function (x) { return util.normName(x) === nn; });
    return f === undefined ? null : f;
  }

  function matchFieldAt(tokens, i, fields) {
    if (!fields || !fields.length) return null;
    const maxLen = Math.min(6, tokens.length - i);
    for (let len = maxLen; len >= 1; len--) {
      const slice = tokens.slice(i, i + len);
      if (slice.some(function (t) { return t.t !== 'word' && t.t !== 'quoted' && t.t !== 'number'; })) continue;
      if (len > 1 && slice.some(function (t) { return t.t === 'quoted'; })) continue;
      const phrase = slice.map(function (t) { return String(t.t === 'number' ? t.raw : t.v); }).join(' ');
      const f = findField(phrase, fields);
      if (f !== null) return { field: f, len: len };
    }
    return null;
  }

  /* ========================================================= value types */

  function enumMatch(param, word) {
    if (word === null || word === undefined) return null;
    const w = String(word).toLowerCase().trim();
    const opts = param.options || [];
    for (let i = 0; i < opts.length; i++) if (String(opts[i]).toLowerCase() === w) return opts[i];
    const al = param.aliases || {};
    for (const k in al) if (k.toLowerCase() === w) return al[k];
    const nw = util.normName(w).replace(/ /g, '');
    for (let i = 0; i < opts.length; i++) if (util.normName(opts[i]).replace(/ /g, '') === nw) return opts[i];
    return null;
  }

  function parseBool(v) {
    const s = String(v).toLowerCase().trim();
    if (['true', 'yes', 'on', '1', 'y'].indexOf(s) >= 0) return true;
    if (['false', 'no', 'off', '0', 'n'].indexOf(s) >= 0) return false;
    return null;
  }

  function isColorWord(w) {
    return !!(M.colors && M.colors.parse(w) && !/^\d+$/.test(String(w)));
  }
  function isRampWord(w) { return !!(M.colors && M.colors.getRamp(w)); }
  function isPaletteWord(w) { return !!(M.colors && M.colors.PALETTES[String(w).toLowerCase()]); }

  function unitOf(word, param) {
    if (word === null || word === undefined) return null;
    const w = String(word).toLowerCase();
    if (param && param.unitKind === 'area') return util.normalizeAreaUnit(w);
    return util.normalizeUnit(w);
  }

  /** Parse a textual value for a param (from key=value or a keyword section). */
  function parseValue(param, text, ctx, errors) {
    const t = String(text).trim();
    switch (param.type) {
      case 'number': case 'integer': {
        const m = /^([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)\s*(%)?$/i.exec(t);
        if (!m) { errors.push(param.name + ' should be a number, not "' + t + '"'); return undefined; }
        let v = parseFloat(m[1]);
        if (m[2] && param.percent) v = v / 100;
        if (param.type === 'integer') v = Math.round(v);
        return v;
      }
      case 'distance': {
        const m = /^([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)\s*([a-z-]*)$/i.exec(t);
        if (!m) { errors.push(param.name + ' should be a distance like 500m or 2 km, not "' + t + '"'); return undefined; }
        const u = m[2] ? unitOf(m[2], param) : null;
        if (m[2] && !u) { errors.push('Unknown unit "' + m[2] + '"'); return undefined; }
        return { value: parseFloat(m[1]), units: u || param.defaultUnit || 'meters' };
      }
      case 'numbers': {
        const parts = t.split(/[\s,;]+/).filter(Boolean);
        let units = null;
        const vals = [];
        parts.forEach(function (p) {
          const m = /^([+-]?(?:\d+\.?\d*|\.\d+))([a-z-]*)$/i.exec(p);
          if (m) { vals.push(parseFloat(m[1])); if (m[2]) units = unitOf(m[2], param) || units; }
          else if (unitOf(p, param)) units = unitOf(p, param);
          else errors.push('"' + p + '" is not a number');
        });
        return { values: vals, units: units || param.defaultUnit || 'meters' };
      }
      case 'unit': {
        const u = unitOf(t, param);
        if (!u) errors.push('Unknown unit "' + t + '"');
        return u || undefined;
      }
      case 'enum': {
        const e = enumMatch(param, t);
        if (e === null) {
          const s = closest(t, param.options || []);
          errors.push('"' + t + '" is not a valid ' + param.name + '. Options: ' + (param.options || []).join(', ') + (s ? ' (did you mean ' + s + '?)' : ''));
          return undefined;
        }
        return e;
      }
      case 'flag': case 'boolean': {
        const b = parseBool(t);
        if (b === null) { errors.push(param.name + ' should be yes/no'); return undefined; }
        return b;
      }
      case 'color': {
        const c = M.colors && M.colors.normalize(t);
        if (!c) { errors.push('"' + t + '" is not a color'); return undefined; }
        return c;
      }
      case 'ramp':
        if (!isRampWord(t)) { errors.push('Unknown color ramp "' + t + '". Try: ' + (M.colors ? M.colors.rampNames().slice(0, 12).join(', ') : '')); return undefined; }
        return t.toLowerCase();
      case 'palette':
        if (!isPaletteWord(t)) { errors.push('Unknown palette "' + t + '"'); return undefined; }
        return t.toLowerCase();
      case 'layer': {
        const hit = findLayer(t, ctx);
        if (!hit) {
          const s = suggestLayer(t, ctx);
          errors.push('No layer named "' + t + '"' + (s ? '. Did you mean "' + s + '"?' : ''));
          return undefined;
        }
        return hit.layer.id;
      }
      case 'layers': {
        const ids = [];
        t.split(/\s*(?:,|\band\b|\+)\s*/i).filter(Boolean).forEach(function (part) {
          const p = part.replace(/^["']|["']$/g, '');
          const hit = findLayer(p, ctx);
          if (hit) ids.push(hit.layer.id);
          else errors.push('No layer named "' + p + '"');
        });
        return ids;
      }
      case 'field': case 'fields': case 'stats':
        return { __late: t }; // resolved once layers are known
      case 'json':
        try { return JSON.parse(t); } catch (e) { errors.push(param.name + ' is not valid JSON'); return undefined; }
      default:
        return t; // text, name, expression, place, url, crs, rest
    }
  }

  const STAT_OPS = {
    sum: 'sum', total: 'sum', mean: 'mean', avg: 'mean', average: 'mean', min: 'min', minimum: 'min', max: 'max', maximum: 'max',
    count: 'count', first: 'first', last: 'last', concat: 'concat', list: 'concat', unique: 'unique_count', median: 'median', std: 'std', stddev: 'std',
  };

  /* =============================================================== parse */

  function matchVerb(tokens) {
    let start = 0;
    // skip polite openers
    for (let changed = true; changed;) {
      changed = false;
      for (let k = 0; k < OPENERS.length; k++) {
        const o = OPENERS[k];
        if (o.every(function (w, j) { return low(tokens[start + j]) === w; })) { start += o.length; changed = true; break; }
      }
    }
    const vs = verbs();
    for (let k = 0; k < vs.length; k++) {
      const v = vs[k];
      let ok = true;
      for (let j = 0; j < v.words.length; j++) {
        const tk = tokens[start + j];
        if (!tk || tk.t !== 'word' || tk.v.toLowerCase() !== v.words[j]) { ok = false; break; }
      }
      if (ok) return { tool: v.tool, verb: v.text, start: start, len: v.words.length };
    }
    return { tool: null, start: start };
  }

  function verbSuggestions(word) {
    const w = String(word || '').toLowerCase();
    if (!w) return [];
    const cands = [];
    verbs().forEach(function (v) {
      const d = util.editDistance(w, v.text, 2);
      if (d <= 2 && v.text.length > 2) cands.push({ text: v.text, d: d, tool: v.tool });
    });
    cands.sort(function (a, b) { return a.d - b.d || a.text.length - b.text.length; });
    const seen = new Set();
    return cands.filter(function (c) { if (seen.has(c.tool.name)) return false; seen.add(c.tool.name); return true; }).slice(0, 3).map(function (c) { return c.text; });
  }

  function layerAccepts(param, layer) {
    if (!layer) return false;
    const kinds = param.kinds || ['vector'];
    if (kinds.indexOf('any') < 0 && kinds.indexOf(layer.type) < 0) return false;
    if (param.geom && layer.type === 'vector') {
      const g = layer.geometryType;
      if (g && g !== 'Mixed' && g !== 'None' && param.geom.indexOf(g) < 0) return false;
      if (g === 'None' && param.geom.length) return false;
    }
    return true;
  }

  function describeLayerNeed(param) {
    const kinds = param.kinds || ['vector'];
    if (kinds.indexOf('raster') >= 0 && kinds.length === 1) return 'a raster layer';
    if (param.geom) return 'a ' + param.geom.map(function (g) { return g === 'LineString' ? 'line' : g.toLowerCase(); }).join('/') + ' layer';
    return 'a layer';
  }

  /**
   * Parse a command line.
   *
   * ctx = { layers: [{ id, name, type, geometryType, fields: [{name, type}], bandNames }], activeLayerId }
   *
   * Returns { ok, empty, tool, verb, args, errors, warnings, missing, unknown,
   *           suggestions, canonical, usedActive }.
   */
  function parse(text, ctx) {
    ctx = ctx || {};
    const res = { ok: false, tool: null, verb: null, args: {}, errors: [], warnings: [], missing: [], unknown: [], suggestions: [], canonical: '' };
    const src = normalizeQuotes(String(text || '')).trim();
    if (!src || src[0] === '#') { res.empty = true; return res; }
    const tokens = tokenize(src);
    const vm = matchVerb(tokens);
    if (!vm.tool) {
      const first = tokens[vm.start];
      const w = first ? String(first.v) : '';
      res.suggestions = verbSuggestions(w);
      res.errors.push('Unknown command "' + w + '".' + (res.suggestions.length ? ' Did you mean ' + res.suggestions.map(function (s) { return '"' + s + '"'; }).join(' or ') + '?' : ' Type "help" to see all commands.'));
      return res;
    }
    const tool = vm.tool;
    res.tool = tool;
    res.verb = vm.verb;
    const rest = tokens.slice(vm.start + vm.len);
    const restText = rest.length ? src.slice(rest[0].start) : '';

    if (tool.raw) {
      const p = tool.params[0];
      if (p) res.args[p.name] = restText;
      if (p && p.required && !restText) res.missing.push(p.name);
      return finish(res, ctx);
    }

    const args = res.args;
    const consumed = new Array(rest.length).fill(false);
    const params = tool.params;
    const byKey = new Map();
    params.forEach(function (p) { p.keys.forEach(function (k) { byKey.set(k, p); }); });

    // 1. key=value
    rest.forEach(function (tok, i) {
      if (tok.t !== 'kv') return;
      const p = byKey.get(tok.key);
      if (!p) {
        if (tool.kvFallback && tool.kvFallback(tok, args, res)) consumed[i] = true;
        return;
      }
      const v = parseValue(p, tok.v, ctx, res.errors);
      if (v !== undefined) args[p.name] = v;
      consumed[i] = true;
    });

    // 2. keyword sections: "where …", "as …", "by …"
    const kwParams = params.filter(function (p) { return p.keywords.length; });
    const implicitParams = params.filter(function (p) { return p.implicit && p.implicit.length; });
    const isKeywordAt = function (i) {
      const tok = rest[i];
      if (!tok || tok.t !== 'word' || consumed[i]) return null;
      const w = tok.v.toLowerCase();
      for (let k = 0; k < kwParams.length; k++) if (kwParams[k].keywords.indexOf(w) >= 0 && args[kwParams[k].name] === undefined) return kwParams[k];
      // implicit "name value" only when a value follows and the word isn't a layer/field/option
      const nxt = rest[i + 1];
      if (!nxt || nxt.t === 'comma') return null;
      for (let k = 0; k < implicitParams.length; k++) {
        const p = implicitParams[k];
        if (p.implicit.indexOf(w) < 0 || args[p.name] !== undefined) continue;
        if (findLayer(tok.v, ctx) || wordIsOption(w, tool)) return null;
        if (allFieldNames(ctx).some(function (f) { return String(f).toLowerCase() === w; })) return null;
        return p;
      }
      return null;
    };
    const hasStats = params.some(function (p) { return p.type === 'stats'; });
    // Words that start some other parameter (end a list-like section).
    const isBoundaryWord = function (tok) {
      if (!tok || tok.t !== 'word') return false;
      const w = tok.v.toLowerCase();
      if (hasStats && STAT_OPS[w]) return true;
      return wordIsOption(w, tool);
    };
    for (let i = 0; i < rest.length; i++) {
      const p = isKeywordAt(i);
      if (!p) continue;
      // section end: next keyword for another unfilled param, or end
      let j = i + 1;
      const freeText = p.type === 'expression' || p.type === 'text' || p.type === 'place';
      const listy = p.type === 'stats' || p.type === 'fields' || p.type === 'layers' || p.type === 'numbers';
      if (freeText || listy) {
        while (j < rest.length) {
          const q = isKeywordAt(j);
          if (q && q !== p) break;
          if (rest[j].t === 'kv' && byKey.has(rest[j].key)) break;
          if (listy && p.type !== 'stats' && j > i + 1 && isBoundaryWord(rest[j])) break;
          j++;
        }
      } else {
        // single value (a layer/field may span several words)
        if (p.type === 'layer') {
          const m = matchLayerAt(rest, i + 1, ctx);
          j = i + 1 + (m ? m.len : 1);
        } else if (p.type === 'field') {
          const fl = fieldsOfParamLayer(p, args, tool, ctx);
          // The layer may not be known yet; match against every layer's fields
          // for the phrase length and bind to the right layer later.
          const pool = fl ? fl.fields : allFieldNames(ctx);
          const m = matchFieldAt(rest, i + 1, pool);
          j = i + 1 + (m ? m.len : 1);
        } else if (p.type === 'distance') {
          j = i + 2;
          if (rest[i + 2] && rest[i + 2].t === 'word' && unitOf(rest[i + 2].v, p)) j = i + 3;
        } else j = i + 2;
        j = Math.min(j, rest.length);
      }
      if (j === i + 1) { res.errors.push('Expected a value after "' + rest[i].v + '"'); consumed[i] = true; continue; }
      const sec = rest.slice(i + 1, j);
      let value;
      if (p.type === 'expression' || p.type === 'text' || p.type === 'place') {
        value = src.slice(sec[0].start, sec[sec.length - 1].end).trim();
        if (p.type !== 'expression' && sec.length === 1 && sec[0].t === 'quoted') value = sec[0].v;
      } else if (p.type === 'stats') {
        value = { __late: sec.map(function (t) { return t.t === 'number' ? t.raw : t.v; }).join(' ') };
      } else if (p.type === 'fields' || p.type === 'layers' || p.type === 'numbers') {
        value = parseValue(p, sec.map(function (t) { return t.t === 'comma' ? ',' : t.t === 'quoted' ? '"' + t.v + '"' : (t.t === 'number' ? t.raw : t.v); }).join(' ').replace(/ , /g, ', '), ctx, res.errors);
      } else if (p.type === 'field') {
        value = { __late: sec.map(function (t) { return t.t === 'number' ? t.raw : t.v; }).join(' ') };
      } else {
        value = parseValue(p, sec.map(function (t) { return t.t === 'number' ? t.raw : t.v; }).join(p.type === 'distance' ? '' : ' '), ctx, res.errors);
      }
      if (value !== undefined) args[p.name] = value;
      for (let k = i; k < j; k++) consumed[k] = true;
      i = j - 1;
    }

    // Remaining tokens (in order) for forms and generic slot filling.
    const remIdx = [];
    rest.forEach(function (t, i) { if (!consumed[i]) remIdx.push(i); });
    const rem = remIdx.map(function (i) { return rest[i]; });

    // 3. forms
    let formUsed = 0;
    if (tool.forms.length && rem.length) {
      let best = null;
      tool.forms.forEach(function (form) {
        const r = matchForm(form.elements, rem, tool, ctx, args);
        if (r && (!best || r.consumed > best.consumed)) best = r;
      });
      if (best) {
        Object.keys(best.assign).forEach(function (k) { if (args[k] === undefined) args[k] = best.assign[k]; });
        formUsed = best.consumed;
      }
    }

    // 4. generic slot filling
    const pending = rem.slice(formUsed);
    fillGeneric(pending, tool, ctx, args, res);

    // 5. late-bound fields & stats, defaults, validation
    resolveLate(tool, ctx, args, res);
    return finish(res, ctx);
  }

  function slotLen(param, tokens, i, tool, ctx, args) {
    const tok = tokens[i];
    if (!tok) return null;
    switch (param.type) {
      case 'layer': {
        const m = matchLayerAt(tokens, i, ctx);
        if (!m) return null;
        return { len: m.len, value: m.layer.id };
      }
      case 'field': {
        const fl = fieldsOfParamLayer(param, args, tool, ctx);
        if (!fl) {
          if (tok.t === 'word' || tok.t === 'quoted') return { len: 1, value: { __late: tok.v } };
          return null;
        }
        const m = matchFieldAt(tokens, i, fl.fields);
        return m ? { len: m.len, value: m.field } : null;
      }
      case 'distance':
        if (tok.t !== 'number') return null;
        if (tokens[i + 1] && tokens[i + 1].t === 'word' && unitOf(tokens[i + 1].v, param)) return { len: 2, value: { value: tok.v, units: unitOf(tokens[i + 1].v, param) } };
        return { len: 1, value: { value: tok.v, units: param.defaultUnit || 'meters' } };
      case 'number': case 'integer':
        if (tok.t !== 'number') return null;
        if (tokens[i + 1] && tokens[i + 1].t === 'word' && tokens[i + 1].v === '%' && param.percent) return { len: 2, value: tok.v / 100 };
        return { len: 1, value: param.type === 'integer' ? Math.round(tok.v) : tok.v };
      case 'name': case 'text': case 'url': case 'crs':
        if (tok.t === 'word' || tok.t === 'quoted' || tok.t === 'number') return { len: 1, value: tok.t === 'number' ? tok.raw : tok.v };
        return null;
      case 'place': {
        // everything up to a following keyword-ish filler is handled by forms; take the rest
        const parts = [];
        let j = i;
        while (j < tokens.length && (tokens[j].t === 'word' || tokens[j].t === 'quoted' || tokens[j].t === 'number' || tokens[j].t === 'comma')) { parts.push(tokens[j].t === 'number' ? tokens[j].raw : tokens[j].v); j++; }
        return parts.length ? { len: j - i, value: parts.join(' ').replace(/ ,/g, ',') } : null;
      }
      case 'enum': {
        const e = enumMatch(param, tok.v);
        return e === null ? null : { len: 1, value: e };
      }
      default:
        return null;
    }
  }

  function matchForm(elements, tokens, tool, ctx, argsIn) {
    const paramByName = new Map(tool.params.map(function (p) { return [p.name, p]; }));
    let best = null;
    function rec(els, ei, ti, assign, stack) {
      if (ei >= els.length) {
        if (stack.length) { const top = stack[stack.length - 1]; return rec(top.els, top.ei, ti, assign, stack.slice(0, -1)); }
        if (!best || ti > best.consumed) best = { consumed: ti, assign: Object.assign({}, assign) };
        return;
      }
      const el = els[ei];
      if (el.opt) {
        // try with the optional group, then without
        rec(el.opt, 0, ti, assign, stack.concat([{ els: els, ei: ei + 1 }]));
        rec(els, ei + 1, ti, assign, stack);
        return;
      }
      if (el.lit) {
        for (let a = 0; a < el.lit.length; a++) {
          const words = el.lit[a];
          let ok = true;
          for (let k = 0; k < words.length; k++) { if (low(tokens[ti + k]) !== words[k] || (tokens[ti + k] && tokens[ti + k].t !== 'word')) { ok = false; break; } }
          if (ok) rec(els, ei + 1, ti + words.length, assign, stack);
        }
        return;
      }
      if (el.slot) {
        const p = paramByName.get(el.slot);
        if (!p) return;
        if (argsIn[p.name] !== undefined || assign[p.name] !== undefined) { rec(els, ei + 1, ti, assign, stack); return; }
        const tmpArgs = Object.assign({}, argsIn, assign);
        const m = slotLen(p, tokens, ti, tool, ctx, tmpArgs);
        if (!m) return;
        // layer slots may also match shorter names; try the matched length only (longest-first)
        const next = Object.assign({}, assign);
        next[p.name] = m.value;
        rec(els, ei + 1, ti + m.len, next, stack);
      }
    }
    rec(elements, 0, 0, {}, []);
    return best && best.consumed > 0 ? best : null;
  }

  function fillGeneric(tokens, tool, ctx, args, res) {
    const params = tool.params;
    const unfilled = function (p) { return args[p.name] === undefined; };
    const leftovers = [];

    // Pass 1: layers
    const layerParams = params.filter(function (p) { return p.type === 'layer' || p.type === 'layers'; });
    const used = new Array(tokens.length).fill(false);
    if (layerParams.length) {
      for (let i = 0; i < tokens.length; i++) {
        if (used[i]) continue;
        const tok = tokens[i];
        if (tok.t === 'kv' || tok.t === 'comma') continue;
        const open = layerParams.filter(function (p) { return p.type === 'layers' || unfilled(p); });
        if (!open.length) break;
        const m = matchLayerAt(tokens, i, ctx);
        if (!m) continue;
        // don't let a stopword-only phrase ("in") match a layer called "in"
        if (m.len === 1 && tok.t === 'word' && STOPWORDS.has(tok.v.toLowerCase()) && !m.exact) continue;
        // a word that is also a flag/enum of this tool is not a layer reference
        if (m.len === 1 && tok.t === 'word' && wordIsOption(tok.v, tool) && !m.exact) continue;
        let target = open.find(function (p) { return p.type === 'layer' && layerAccepts(p, m.layer); }) ||
          open.find(function (p) { return p.type === 'layers'; }) || open.find(function (p) { return p.type === 'layer'; });
        if (!target) continue;
        if (target.type === 'layers') {
          args[target.name] = (Array.isArray(args[target.name]) ? args[target.name] : []).concat([m.layer.id]);
        } else args[target.name] = m.layer.id;
        for (let k = i; k < i + m.len; k++) used[k] = true;
        i += m.len - 1;
      }
    }

    // Pass 2: everything else
    for (let i = 0; i < tokens.length; i++) {
      if (used[i]) continue;
      const tok = tokens[i];
      const w = low(tok);
      if (tok.t === 'comma') continue;
      if (tok.t === 'kv') {
        const txtKv = params.find(function (p) { return (p.type === 'text' || p.type === 'place' || p.type === 'expression') && unfilled(p) && !p.keywords.length; });
        if (txtKv) { takeText(txtKv, tokens, i, args, used); i = tokens.length; continue; }
        leftovers.push(tok);
        continue;
      }

      // flags
      if (tok.t === 'word') {
        const fp = params.find(function (p) { return (p.type === 'flag') && unfilled(p) && p.words.indexOf(w) >= 0; });
        if (fp) { args[fp.name] = true; continue; }
      }
      // numbers
      if (tok.t === 'number') {
        const next = tokens[i + 1];
        const nextUnit = next && next.t === 'word' && !used[i + 1] ? next.v : null;
        const numsP = params.find(function (p) { return p.type === 'numbers' && unfilled(p); });
        if (numsP) {
          const vals = [tok.v];
          let j = i + 1;
          while (j < tokens.length && (tokens[j].t === 'number' || tokens[j].t === 'comma' || (tokens[j].t === 'word' && tokens[j].v.toLowerCase() === 'and'))) {
            if (tokens[j].t === 'number') vals.push(tokens[j].v);
            j++;
          }
          let units = numsP.defaultUnit || 'meters';
          if (tokens[j] && tokens[j].t === 'word' && unitOf(tokens[j].v, numsP)) { units = unitOf(tokens[j].v, numsP); j++; }
          args[numsP.name] = { values: vals, units: units };
          i = j - 1;
          continue;
        }
        const distP = params.find(function (p) { return p.type === 'distance' && unfilled(p); });
        const pctNumP = params.find(function (p) { return (p.type === 'number' || p.type === 'integer') && unfilled(p) && p.percent; });
        if (nextUnit === '%' && pctNumP) { args[pctNumP.name] = tok.v / 100; i++; continue; }
        if (distP && (nextUnit && unitOf(nextUnit, distP) || !params.some(function (p) { return (p.type === 'number' || p.type === 'integer') && unfilled(p) && p.preferNumber; }))) {
          const u = nextUnit && unitOf(nextUnit, distP);
          args[distP.name] = { value: tok.v, units: u || distP.defaultUnit || 'meters', unitGiven: !!u };
          if (u) i++;
          continue;
        }
        const numP = params.find(function (p) { return (p.type === 'number' || p.type === 'integer') && unfilled(p); });
        if (numP) {
          args[numP.name] = numP.type === 'integer' ? Math.round(tok.v) : tok.v;
          if (nextUnit && (nextUnit === '%' || /^(px|pixels?|x|deg|degrees?)$/i.test(nextUnit))) {
            if (nextUnit === '%' && numP.percent) args[numP.name] = tok.v / 100;
            i++;
          }
          continue;
        }
        // a free text param can take numbers too (e.g. coordinates)
        const txt = params.find(function (p) { return (p.type === 'text' || p.type === 'place' || p.type === 'name' || p.type === 'crs') && unfilled(p); });
        if (txt) { takeText(txt, tokens, i, args, used); i = tokens.length; continue; }
        leftovers.push(tok);
        continue;
      }
      // unit word following a distance given elsewhere
      if (tok.t === 'word') {
        const unitP = params.find(function (p) { return p.type === 'unit' && unfilled(p); });
        if (unitP && unitOf(w, unitP)) { args[unitP.name] = unitOf(w, unitP); continue; }
        const dist = params.find(function (p) { return p.type === 'distance' && args[p.name] && !args[p.name].unitGiven; });
        if (dist && unitOf(w, dist)) { args[dist.name].units = unitOf(w, dist); args[dist.name].unitGiven = true; continue; }
      }
      // enums (single words, or two-word phrases like "natural breaks")
      if (tok.t === 'word' || tok.t === 'quoted') {
        let matched = false;
        for (const p of params) {
          if (p.type !== 'enum' || !unfilled(p)) continue;
          const two = tokens[i + 1] && (tokens[i + 1].t === 'word') ? w + ' ' + tokens[i + 1].v.toLowerCase() : null;
          const e2 = two ? enumMatch(p, two) : null;
          if (e2 !== null) { args[p.name] = e2; i++; matched = true; break; }
          const e = enumMatch(p, w);
          if (e !== null) { args[p.name] = e; matched = true; break; }
        }
        if (matched) continue;
      }
      // colors, ramps & palettes ("red" is a color; "reds"/"viridis" are ramps)
      if (tok.t === 'word' || tok.t === 'quoted') {
        const colP = params.find(function (p) { return p.type === 'color' && unfilled(p); });
        const rampP = params.find(function (p) { return p.type === 'ramp' && unfilled(p); });
        const exactRamp = M.colors && M.colors.RAMPS[w.replace(/[-_ ]?(r|rev|reverse|reversed)$/, '')];
        if (colP && isColorWord(tok.v) && !(rampP && exactRamp)) { args[colP.name] = M.colors.normalize(tok.v); continue; }
        if (rampP && isRampWord(w)) { args[rampP.name] = w; continue; }
        const palP = params.find(function (p) { return p.type === 'palette' && unfilled(p); });
        if (palP && isPaletteWord(w)) { args[palP.name] = w; continue; }
      }
      // fields
      const fieldP = params.find(function (p) { return (p.type === 'field' || p.type === 'fields') && (unfilled(p) || p.type === 'fields'); });
      if (fieldP && (tok.t === 'word' || tok.t === 'quoted')) {
        const fl = fieldsOfParamLayer(fieldP, args, tool, ctx);
        const m = fl ? matchFieldAt(tokens, i, fl.fields) : null;
        if (m) {
          if (fieldP.type === 'fields') args[fieldP.name] = (Array.isArray(args[fieldP.name]) ? args[fieldP.name] : []).concat([m.field]);
          else args[fieldP.name] = m.field;
          i += m.len - 1;
          continue;
        }
      }
      // stats: "sum pop mean income"
      const statsP = params.find(function (p) { return p.type === 'stats'; });
      if (statsP && tok.t === 'word' && STAT_OPS[w]) {
        const nxt = tokens[i + 1];
        if (nxt && (nxt.t === 'word' || nxt.t === 'quoted')) {
          const prev = args[statsP.name] && args[statsP.name].__late !== undefined ? args[statsP.name].__late + ' ' : '';
          args[statsP.name] = { __late: prev + w + ' ' + (nxt.t === 'quoted' ? '"' + nxt.v + '"' : nxt.v) };
          i++;
          continue;
        }
      }
      // crs / url
      if (tok.t === 'word') {
        const crsP = params.find(function (p) { return p.type === 'crs' && unfilled(p); });
        if (crsP && /^(epsg|esri):?\d{4,6}$/i.test(tok.v)) { args[crsP.name] = tok.v.toUpperCase().replace(/^(EPSG|ESRI):?/, '$1:'); continue; }
        const urlP = params.find(function (p) { return p.type === 'url' && unfilled(p); });
        if (urlP && /^(https?:)?\/\//i.test(tok.v)) { args[urlP.name] = tok.v; continue; }
      }
      // skip fillers
      if (tok.t === 'word' && STOPWORDS.has(w)) continue;
      // free text / place / name: take the rest
      const txtP = params.find(function (p) { return (p.type === 'text' || p.type === 'place') && unfilled(p); }) ||
        params.find(function (p) { return (p.type === 'name' || p.type === 'crs' || p.type === 'url') && unfilled(p) && p.positional; });
      if (txtP) {
        if (txtP.type === 'name' || txtP.type === 'crs' || txtP.type === 'url') { args[txtP.name] = tok.t === 'number' ? tok.raw : tok.v; continue; }
        takeText(txtP, tokens, i, args, used); i = tokens.length; continue;
      }
      leftovers.push(tok);
    }

    leftovers.forEach(function (tok) {
      const shown = tok.t === 'kv' ? tok.raw : tok.t === 'number' ? tok.raw : tok.v;
      res.unknown.push(shown);
    });
  }

  function wordIsOption(word, tool) {
    const w = String(word).toLowerCase();
    return tool.params.some(function (p) {
      if (p.type === 'flag' && p.words.indexOf(w) >= 0) return true;
      if (p.type === 'enum' && enumMatch(p, w) !== null) return true;
      return false;
    });
  }

  function takeText(param, tokens, i, args, used) {
    const parts = [];
    for (let j = i; j < tokens.length; j++) {
      if (used[j]) continue;
      const t = tokens[j];
      if (t.t === 'kv') parts.push(t.raw);
      else parts.push(t.t === 'number' ? t.raw : t.t === 'comma' ? ',' : t.t === 'quoted' && param.type === 'expression' ? t.raw : t.v);
      used[j] = true;
    }
    let v = parts.join(' ').replace(/ ,/g, ',');
    if (param.type === 'name') v = v.trim();
    args[param.name] = v;
  }

  function resolveLate(tool, ctx, args, res) {
    tool.params.forEach(function (p) {
      const v = args[p.name];
      if (v === undefined) return;
      if (p.type === 'field' && v && v.__late !== undefined) {
        const fl = fieldsOfParamLayer(p, args, tool, ctx);
        const raw = String(v.__late).replace(/^["']|["']$/g, '');
        if (!fl) { args[p.name] = raw; return; }
        const f = findField(raw, fl.fields);
        if (f !== null) args[p.name] = f;
        else {
          const s = closest(raw, fl.fields);
          res.errors.push('Layer "' + fl.layer.name + '" has no field "' + raw + '".' + (s ? ' Did you mean "' + s + '"?' : ' Fields: ' + fl.fields.slice(0, 15).join(', ')));
          delete args[p.name];
        }
      } else if (p.type === 'fields' && v && v.__late !== undefined) {
        const fl = fieldsOfParamLayer(p, args, tool, ctx);
        const parts = String(v.__late).split(/\s*(?:,|\band\b)\s*/i).map(function (x) { return x.trim().replace(/^["']|["']$/g, ''); }).filter(Boolean);
        const out = [];
        parts.forEach(function (raw) {
          if (!fl) { out.push(raw); return; }
          const f = findField(raw, fl.fields);
          if (f !== null) out.push(f);
          else {
            // maybe space separated field names
            const sub = raw.split(/\s+/);
            let all = true;
            const tmp = [];
            sub.forEach(function (x) { const g = findField(x, fl.fields); if (g !== null) tmp.push(g); else all = false; });
            if (all && sub.length > 1) Array.prototype.push.apply(out, tmp);
            else {
              const s = closest(raw, fl.fields);
              res.errors.push('Layer "' + fl.layer.name + '" has no field "' + raw + '".' + (s ? ' Did you mean "' + s + '"?' : ''));
            }
          }
        });
        args[p.name] = out;
      } else if (p.type === 'stats' && v && v.__late !== undefined) {
        const fl = fieldsOfParamLayer(p, args, tool, ctx);
        const toks = tokenize(String(v.__late));
        const out = [];
        for (let i = 0; i < toks.length; i++) {
          const w = low(toks[i]);
          const op = STAT_OPS[w];
          if (!op) { if (toks[i].t !== 'comma' && w !== 'and' && w !== 'of') res.errors.push('Expected a statistic (sum, mean, min, max, count, …) but found "' + toks[i].v + '"'); continue; }
          const nxt = toks[i + 1];
          if (!nxt || (nxt.t !== 'word' && nxt.t !== 'quoted')) { if (op === 'count') { out.push({ op: 'count', field: null }); continue; } res.errors.push(w + ' needs a field'); continue; }
          let f = fl ? findField(nxt.v, fl.fields) : nxt.v;
          if (f === null) {
            const s = fl ? closest(nxt.v, fl.fields) : null;
            res.errors.push('No field "' + nxt.v + '"' + (s ? ' (did you mean "' + s + '"?)' : ''));
          } else out.push({ op: op, field: f });
          i++;
        }
        args[p.name] = out;
      }
    });
  }

  function finish(res, ctx) {
    const tool = res.tool;
    const args = res.args;
    if (!tool) return res;
    // active layer fallback for the first layer param
    const firstLayer = tool.params.find(function (p) { return p.type === 'layer'; });
    tool.params.forEach(function (p) {
      if (args[p.name] !== undefined) return;
      if (p.type === 'layer' && p === firstLayer && p.useActive !== false && ctx.activeLayerId) {
        const act = (ctx.layers || []).find(function (l) { return l.id === ctx.activeLayerId; });
        if (act && layerAccepts(p, act) && (p.required || p.useActive)) {
          // only when every other layer param is already filled or optional
          args[p.name] = act.id;
          res.usedActive = act.name;
          return;
        }
      }
      if (p.default !== undefined) {
        args[p.name] = typeof p.default === 'object' && p.default !== null ? JSON.parse(JSON.stringify(p.default)) : p.default;
      }
    });
    // clean internal markers
    tool.params.forEach(function (p) {
      const v = args[p.name];
      if (v && typeof v === 'object' && v.unitGiven !== undefined) delete v.unitGiven;
    });
    // validate layers
    tool.params.forEach(function (p) {
      if (p.type !== 'layer' || args[p.name] === undefined) return;
      const layer = (ctx.layers || []).find(function (l) { return l.id === args[p.name]; });
      if (layer && !layerAccepts(p, layer)) {
        res.errors.push('"' + layer.name + '" is ' + (layer.type === 'vector' ? (layer.geometryType === 'None' ? 'a table without geometry' : 'a ' + geomWord(layer.geometryType) + ' layer') : 'a ' + layer.type + ' layer') + '; ' + (p.label || p.name) + ' needs ' + describeLayerNeed(p) + '.');
      }
    });
    tool.params.forEach(function (p) {
      if (p.required && (args[p.name] === undefined || args[p.name] === '' || (Array.isArray(args[p.name]) && !args[p.name].length && p.type !== 'stats'))) res.missing.push(p.name);
    });
    if (tool.validate) {
      try {
        const extra = tool.validate(args, ctx);
        if (extra) (Array.isArray(extra) ? extra : [extra]).forEach(function (e) { res.errors.push(e); });
      } catch (e) { res.errors.push(e.message); }
    }
    const missingLayer = res.missing.length && tool.params.some(function (p) { return p.type === 'layer' && res.missing.indexOf(p.name) >= 0; });
    if (res.unknown.length && missingLayer) {
      const phrase = res.unknown.join(' ');
      const s = suggestLayer(phrase, ctx);
      const names = (ctx.layers || []).map(function (l) { return '"' + l.name + '"'; });
      res.errors.push('No layer named "' + phrase + '".' + (s ? ' Did you mean "' + s + '"?' : names.length ? ' Layers: ' + names.slice(0, 10).join(', ') + (names.length > 10 ? ', …' : '') : ''));
      res.ok = false;
      res.canonical = format(tool, args, ctx);
      return res;
    }
    if (res.unknown.length) {
      const whole = res.unknown.length > 1 ? suggestLayer(res.unknown.join(' '), ctx) : null;
      if (whole) res.errors.push('No layer named "' + res.unknown.join(' ') + '". Did you mean "' + whole + '"?');
      else {
        const hints = res.unknown.map(function (u) {
          const s = suggestLayer(u, ctx);
          return s ? '"' + u + '" (a layer called "' + s + '"?)' : '"' + u + '"';
        });
        res.errors.push("Didn't understand " + hints.join(', ') + ' — see: help ' + tool.name);
      }
    }
    if (res.missing.length) {
      res.errors.push('Missing ' + res.missing.map(function (m) {
        const p = tool.params.find(function (x) { return x.name === m; });
        return p && p.type === 'layer' ? describeLayerNeed(p) + ' (' + m + ')' : m;
      }).join(', ') + '. Usage: ' + usage(tool));
    }
    res.ok = res.errors.length === 0;
    res.canonical = format(tool, args, ctx);
    return res;
  }

  function geomWord(g) { return g === 'LineString' ? 'line' : g === 'Mixed' ? 'mixed-geometry' : String(g || '').toLowerCase(); }

  /* ============================================================== format */

  function quoteIfNeeded(s) {
    s = String(s);
    if (/^[\w.\-:/@]+$/.test(s) && !/^\d/.test(s)) return s;
    if (s.indexOf('"') < 0) return '"' + s + '"';
    return "'" + s.replace(/'/g, "\\'") + "'";
  }
  const UNIT_SHORT = { meters: 'm', kilometers: 'km', miles: 'mi', feet: 'ft', yards: 'yd', nauticalmiles: 'nmi', centimeters: 'cm', inches: 'in', usfeet: 'usft' };

  function formatValue(p, v, ctx) {
    switch (p.type) {
      case 'layer': { const l = (ctx.layers || []).find(function (x) { return x.id === v; }); return quoteIfNeeded(l ? l.name : v); }
      case 'layers': return (v || []).map(function (id) { const l = (ctx.layers || []).find(function (x) { return x.id === id; }); return quoteIfNeeded(l ? l.name : id); }).join(', ');
      case 'field': return quoteIfNeeded(v);
      case 'fields': return (v || []).map(quoteIfNeeded).join(', ');
      case 'distance': return v.value + ' ' + (UNIT_SHORT[v.units] || v.units);
      case 'numbers': return v.values.join(', ') + (p.unitless ? '' : ' ' + (UNIT_SHORT[v.units] || v.units));
      case 'stats': return (v || []).map(function (s) { return s.op + (s.field ? ' ' + quoteIfNeeded(s.field) : ''); }).join(' ');
      case 'expression': return v;
      case 'number': case 'integer': return p.percent ? Math.round(v * 100) + '%' : String(v);
      case 'json': return JSON.stringify(v);
      default: return quoteIfNeeded(v);
    }
  }

  /** Canonical, re-parseable text for a tool call (echoed in the console). */
  function format(tool, args, ctx) {
    ctx = ctx || {};
    if (typeof tool === 'string') tool = get(tool);
    if (!tool) return '';
    if (tool.format) {
      try { const f = tool.format(args, ctx, { formatValue: function (p, v) { return formatValue(p, v, ctx); }, quote: quoteIfNeeded }); if (f) return f; } catch (e) { /* fall back */ }
    }
    if (tool.raw) return (tool.name + ' ' + (args[tool.params[0].name] || '')).trim();
    const parts = [tool.formatVerb || tool.name];
    const done = new Set();
    // Use the tool's first form for natural word order ("erase water from parcels").
    if (tool.forms.length) {
      const paramByName = new Map(tool.params.map(function (p) { return [p.name, p]; }));
      const fmtForm = function (els, localDone) {
        const out = [];
        let slots = 0;
        for (let k = 0; k < els.length; k++) {
          const el = els[k];
          if (el.lit) out.push(el.lit[0].join(' '));
          else if (el.slot) {
            const p = paramByName.get(el.slot);
            const v = p ? args[p.name] : undefined;
            if (!p || v === undefined || v === null || v === '') return null;
            out.push(formatValue(p, v, ctx));
            localDone.add(p.name);
            slots++;
          } else if (el.opt) {
            const sub = new Set();
            const r = fmtForm(el.opt, sub);
            if (r && r.slots) { out.push(r.text); sub.forEach(function (x) { localDone.add(x); }); slots += r.slots; }
          }
        }
        return { text: out.join(' '), slots: slots };
      };
      for (let fi = 0; fi < tool.forms.length; fi++) {
        const localDone = new Set();
        const r = fmtForm(tool.forms[fi].elements, localDone);
        if (r && r.slots) { parts.push(r.text); localDone.forEach(function (x) { done.add(x); }); break; }
      }
    }
    tool.params.forEach(function (p) {
      const v = args[p.name];
      if (done.has(p.name)) return;
      if (v === undefined || v === null || v === '' || p.hidden) return;
      if (p.default !== undefined && JSON.stringify(v) === JSON.stringify(p.default) && !p.required) return;
      if (Array.isArray(v) && !v.length) return;
      if (p.type === 'flag') { if (v) parts.push(p.words[0] || p.name); return; }
      if (p.type === 'boolean') { parts.push(p.name + '=' + (v ? 'yes' : 'no')); return; }
      const text = formatValue(p, v, ctx);
      if (p.keywords.length) parts.push(p.keywords[0] + ' ' + text);
      else if (p.positional !== false && (p.type === 'layer' || p.type === 'layers' || p.type === 'distance' || p.type === 'numbers' || p.type === 'enum' || p.type === 'color' || p.type === 'ramp' || p.type === 'palette' || p.type === 'place' || p.type === 'text' || p.type === 'url' || p.type === 'stats' || ((p.type === 'field' || p.type === 'fields' || p.type === 'number' || p.type === 'integer' || p.type === 'crs' || p.type === 'name') && p.positional))) parts.push(text);
      else parts.push(p.name + '=' + text);
    });
    return parts.join(' ');
  }

  /** One-line usage: "buffer <layer> <distance> [dissolve] [as <name>]" */
  function usage(tool) {
    if (typeof tool === 'string') tool = get(tool);
    if (!tool) return '';
    if (tool.usage) return tool.usage;
    const parts = [tool.name];
    tool.params.forEach(function (p) {
      if (p.hidden) return;
      let s;
      if (p.type === 'flag') s = p.words[0] || p.name;
      else if (p.keywords.length) s = p.keywords[0] + ' <' + (p.label || p.name) + '>';
      else if (['layer', 'layers', 'distance', 'numbers', 'enum', 'color', 'ramp', 'place', 'text', 'url', 'rest'].indexOf(p.type) >= 0 || (p.type === 'field' && p.positional)) s = '<' + (p.label || p.name) + '>';
      else s = p.name + '=<' + (p.label || p.type) + '>';
      parts.push(p.required ? s : '[' + s + ']');
    });
    return parts.join(' ');
  }

  /* ============================================================ suggest */

  /**
   * Autocomplete. Returns
   * { items: [{ label, insert, detail, kind }], from, to, hint, parse }
   * where [from, to) is the range of `text` to replace with `insert`.
   */
  function suggest(text, cursor, ctx) {
    ctx = ctx || {};
    text = normalizeQuotes(String(text || ''));
    if (cursor === undefined || cursor === null) cursor = text.length;
    const before = text.slice(0, cursor);
    // current word
    const m = /(?:^|[\s,(=])(["']?[^\s,(="']*)$/.exec(before);
    const word = m ? m[1] : '';
    const from = cursor - word.length;
    const prefix = word.replace(/^["']/, '').toLowerCase();
    const out = { items: [], from: from, to: cursor, hint: '', parse: null };
    const headToks = tokenize(before.slice(0, from));
    const vm = headToks.length ? matchVerb(headToks) : { tool: null };

    if (!vm.tool) {
      // suggest verbs (only if we're still on the first word or two)
      const typed = before.trim().toLowerCase();
      const seen = new Set();
      const items = [];
      verbs().slice().sort(function (a, b) { return (b.primary - a.primary) || a.text.localeCompare(b.text); }).forEach(function (v) {
        if (!v.text.startsWith(typed)) return;
        const key = v.tool.name + '|' + v.text;
        if (seen.has(key)) return;
        seen.add(key);
        items.push({ label: v.text, insert: v.text + ' ', detail: v.tool.summary || v.tool.title || '', kind: 'command', from: before.length - before.trimStart().length });
      });
      out.items = items.slice(0, 40);
      out.from = before.length - before.trimStart().length;
      out.items.forEach(function (it) { delete it.from; });
      return out;
    }

    const tool = vm.tool;
    out.hint = usage(tool);
    out.tool = tool.name;
    const partial = parse(before.slice(0, from), ctx);
    out.parse = parse(text, ctx);
    const args = partial.args || {};
    const items = [];
    const add = function (label, insert, detail, kind) {
      if (prefix && !String(label).toLowerCase().startsWith(prefix) && !util.normName(label).startsWith(util.normName(prefix))) return;
      items.push({ label: label, insert: insert, detail: detail || '', kind: kind });
    };

    if (tool.raw) {
      (ctx.layers || []).forEach(function (l) { add(l.name, quoteIfNeeded(l.name) + ' ', l.type === 'raster' ? 'raster' : geomWord(l.geometryType), 'layer'); });
      (tool.completions || []).forEach(function (c) { add(c, c + ' ', '', 'option'); });
      out.items = items.slice(0, 50);
      return out;
    }

    // inside an expression section?
    const restToks = headToks.slice(vm.start + vm.len);
    let exprParam = null;
    for (let i = restToks.length - 1; i >= 0; i--) {
      const t = restToks[i];
      if (t.t !== 'word') continue;
      const p = tool.params.find(function (q) { return q.keywords.indexOf(t.v.toLowerCase()) >= 0; });
      if (p) { if (p.type === 'expression') exprParam = p; break; }
    }
    if (exprParam) {
      const fl = fieldsOfParamLayer(exprParam, args, tool, ctx);
      if (fl) fl.fields.forEach(function (f) { add(f, /^[A-Za-z_]\w*$/.test(f) ? f + ' ' : '"' + f + '" ', 'field', 'field'); });
      if (M.expr) M.expr.reference().functions.forEach(function (f) { add(f.name, f.name + '(', f.description, 'function'); });
      ['AND', 'OR', 'NOT', 'IN', 'LIKE', 'ILIKE', 'IS NULL', 'IS NOT NULL', 'BETWEEN'].forEach(function (k) { add(k, k + ' ', 'operator', 'keyword'); });
      out.items = items.slice(0, 60);
      out.hint = exprParam.description || 'Expression, e.g. "population" > 1000 AND "state" = \'IL\'';
      return out;
    }

    // Right after a keyword ("by", "as", …) only that parameter's values make sense.
    const prevTok = restToks[restToks.length - 1];
    const kwParam = prevTok && prevTok.t === 'word' ? tool.params.find(function (q) { return q.keywords.indexOf(prevTok.v.toLowerCase()) >= 0; }) : null;
    const focus = kwParam ? [kwParam] : tool.params;
    if (kwParam && kwParam.type === 'name') { out.items = []; out.hint = kwParam.description || 'Name for the new layer'; return out; }

    focus.forEach(function (p) {
      const filled = !kwParam && args[p.name] !== undefined && !(partial.usedActive && p.type === 'layer' && args[p.name] === ctx.activeLayerId && !restToks.length);
      if (p.type === 'layer' || p.type === 'layers') {
        if (filled && p.type === 'layer') return;
        (ctx.layers || []).forEach(function (l) {
          if (!layerAccepts(p, l)) return;
          add(l.name, quoteIfNeeded(l.name) + ' ', (l.type === 'raster' ? 'raster' : geomWord(l.geometryType)) + (l.count !== undefined ? ' · ' + l.count : ''), 'layer');
        });
      } else if (p.type === 'field' || p.type === 'fields' || p.type === 'stats') {
        if (filled && p.type === 'field') return;
        if (p.type === 'stats') {
          const last = restToks[restToks.length - 1];
          if (!(last && last.t === 'word' && STAT_OPS[last.v.toLowerCase()])) {
            ['sum', 'mean', 'min', 'max', 'count'].forEach(function (s) { add(s, s + ' ', 'statistic', 'keyword'); });
            return;
          }
        }
        const fl = fieldsOfParamLayer(p, args, tool, ctx);
        if (fl) (ctx.layers.find(function (l) { return l.id === fl.layer.id; }).fields || []).forEach(function (f) {
          const name = typeof f === 'string' ? f : f.name;
          add(name, quoteIfNeeded(name) + ' ', (f.type || 'field'), 'field');
        });
      } else if (p.type === 'enum' && !filled) {
        (p.options || []).forEach(function (o) { add(String(o), o + ' ', p.name, 'option'); });
      } else if (p.type === 'flag' && !filled) {
        add(p.words[0] || p.name, (p.words[0] || p.name) + ' ', p.description || 'option', 'flag');
      } else if (p.type === 'ramp' && !filled && M.colors) {
        M.colors.rampNames().forEach(function (r) { add(r, r + ' ', 'color ramp', 'ramp'); });
      } else if (p.type === 'color' && !filled) {
        ['red', 'orange', 'gold', 'green', 'teal', 'blue', 'purple', 'magenta', 'brown', 'black', 'gray', 'white'].forEach(function (c) { add(c, c + ' ', 'color', 'color'); });
      } else if (p.type === 'distance' && filled && !prefix) {
        // offer units right after a number
      }
      if (!filled && !kwParam && p.keywords.length) add(p.keywords[0], p.keywords[0] + ' ', p.description || p.name, 'keyword');
    });
    // units after a bare number
    const lastTok = restToks[restToks.length - 1];
    if (lastTok && lastTok.t === 'number' && tool.params.some(function (p) { return p.type === 'distance' || p.type === 'numbers'; })) {
      ['m', 'km', 'mi', 'ft'].forEach(function (u) { add(u, u + ' ', 'unit', 'unit'); });
    }
    out.items = items.slice(0, 60);
    return out;
  }

  /* ================================================================ API */

  M.commands = {
    define: define,
    get: get,
    all: function () { return tools.slice(); },
    categories: function () {
      const cats = [];
      tools.forEach(function (t) { const c = t.category || 'Other'; if (cats.indexOf(c) < 0) cats.push(c); });
      return cats;
    },
    tokenize: tokenize,
    parse: parse,
    suggest: suggest,
    format: format,
    usage: usage,
    findLayer: function (ref, ctx) { const h = findLayer(ref, ctx); return h ? h.layer : null; },
    findField: findField,
    closest: closest,
    STAT_OPS: STAT_OPS,
    /** Split a script into command lines (handles comments and "\" continuations). */
    splitScript: function (text) {
      const lines = String(text || '').replace(/\r\n?/g, '\n').split('\n');
      const out = [];
      let buf = '';
      lines.forEach(function (ln, i) {
        let t = ln.replace(/\s+$/, '');
        if (buf) t = t.replace(/^\s+/, '');
        if (t.endsWith('\\')) { buf += t.slice(0, -1).replace(/\s+$/, '') + ' '; return; }
        buf += t;
        const s = buf.trim();
        buf = '';
        if (s && !s.startsWith('#') && !s.startsWith('//')) out.push({ line: i + 1, text: s });
      });
      if (buf.trim()) out.push({ line: lines.length, text: buf.trim() });
      return out;
    },
    _reset: function () { tools.length = 0; byName.clear(); verbIndex = null; },
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
