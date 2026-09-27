/*
 * PSICITS — expression language.
 *
 * A small, safe, QGIS-flavoured language used for selections, filters, the
 * field calculator, labels and raster band math:
 *
 *   "population" > 10000 AND "state" IN ('IL', 'IN')
 *   round($area / 10000, 1)                      -- hectares
 *   CASE WHEN "speed" >= 55 THEN 'fast' ELSE 'slow' END
 *   "pop" / sum("pop", "state") * 100            -- share of state total
 *   (b4 - b3) / (b4 + b3)                        -- raster band math (NDVI)
 *
 * Expressions are parsed into an AST and compiled to a JavaScript function.
 * The generated code only ever contains literals we produced ourselves
 * (numbers, JSON-encoded strings) and calls into a fixed runtime, so user text
 * is never executed as code.
 */
(function (root) {
  'use strict';

  const M = (root.PSICITS = root.PSICITS || {});
  const util = M.util;

  /* ============================================================ tokenizer */

  const OPS = ['**', '//', '||', '&&', '<=', '>=', '<>', '!=', '==', '+', '-', '*', '/', '%', '^', '=', '<', '>', '~', '!', '(', ')', ','];
  const KEYWORDS = new Set(['AND', 'OR', 'NOT', 'IN', 'LIKE', 'ILIKE', 'IS', 'NULL', 'TRUE', 'FALSE', 'BETWEEN', 'CASE', 'WHEN', 'THEN', 'ELSE', 'END']);

  function ExprError(message, pos, src) {
    const e = new Error(message + (src !== undefined && pos !== undefined ? '\n  ' + src + '\n  ' + ' '.repeat(Math.max(0, pos)) + '^' : ''));
    e.name = 'ExpressionError';
    e.pos = pos;
    e.shortMessage = message;
    return e;
  }

  function tokenize(src) {
    const toks = [];
    let i = 0;
    const n = src.length;
    const isIdStart = function (c) { return /[A-Za-z_À-\uffff]/.test(c); };
    const isId = function (c) { return /[A-Za-z0-9_À-\uffff]/.test(c); };
    while (i < n) {
      const c = src[i];
      if (/\s/.test(c)) { i++; continue; }
      const start = i;
      // numbers: 12, 1.5, .5, 1e-3
      if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1] || ''))) {
        const m = /^(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/.exec(src.slice(i));
        toks.push({ t: 'num', v: parseFloat(m[0]), pos: start, raw: m[0] });
        i += m[0].length;
        continue;
      }
      // 'strings' ('' or \' escapes)
      if (c === "'") {
        let s = '';
        i++;
        for (;;) {
          if (i >= n) throw ExprError('Unterminated text: missing closing \'', start, src);
          const ch = src[i];
          if (ch === '\\' && i + 1 < n) { s += src[i + 1]; i += 2; continue; }
          if (ch === "'") {
            if (src[i + 1] === "'") { s += "'"; i += 2; continue; }
            i++;
            break;
          }
          s += ch;
          i++;
        }
        toks.push({ t: 'str', v: s, pos: start });
        continue;
      }
      // "field names"
      if (c === '"') {
        let s = '';
        i++;
        for (;;) {
          if (i >= n) throw ExprError('Unterminated field name: missing closing "', start, src);
          const ch = src[i];
          if (ch === '\\' && i + 1 < n) { s += src[i + 1]; i += 2; continue; }
          if (ch === '"') {
            if (src[i + 1] === '"') { s += '"'; i += 2; continue; }
            i++;
            break;
          }
          s += ch;
          i++;
        }
        toks.push({ t: 'qid', v: s, pos: start });
        continue;
      }
      // $variables
      if (c === '$') {
        let j = i + 1;
        while (j < n && isId(src[j])) j++;
        if (j === i + 1) throw ExprError('Expected a name after $', start, src);
        toks.push({ t: 'var', v: src.slice(i + 1, j).toLowerCase(), pos: start });
        i = j;
        continue;
      }
      if (isIdStart(c)) {
        let j = i + 1;
        while (j < n && isId(src[j])) j++;
        const word = src.slice(i, j);
        const up = word.toUpperCase();
        toks.push(KEYWORDS.has(up) ? { t: 'kw', v: up, pos: start, raw: word } : { t: 'id', v: word, pos: start });
        i = j;
        continue;
      }
      let matched = null;
      for (let k = 0; k < OPS.length; k++) {
        if (src.startsWith(OPS[k], i)) { matched = OPS[k]; break; }
      }
      if (!matched) throw ExprError('Unexpected character "' + c + '"', start, src);
      toks.push({ t: 'op', v: matched, pos: start });
      i += matched.length;
    }
    toks.push({ t: 'eof', pos: n });
    return toks;
  }

  /* =============================================================== parser */

  function parse(src) {
    if (typeof src !== 'string') throw ExprError('Expression must be text');
    const toks = tokenize(src);
    let p = 0;
    const peek = function (k) { return toks[p + (k || 0)]; };
    const next = function () { return toks[p++]; };
    const isOp = function (v, k) { const t = peek(k); return t.t === 'op' && t.v === v; };
    const isKw = function (v, k) { const t = peek(k); return t.t === 'kw' && t.v === v; };
    const eatOp = function (v) { if (isOp(v)) { p++; return true; } return false; };
    const eatKw = function (v) { if (isKw(v)) { p++; return true; } return false; };
    const describe = function (t) {
      if (t.t === 'eof') return 'the end';
      if (t.t === 'str') return "'" + t.v + "'";
      if (t.t === 'qid') return '"' + t.v + '"';
      if (t.t === 'num') return t.raw;
      if (t.t === 'var') return '$' + t.v;
      return String(t.raw || t.v);
    };
    const expectOp = function (v) {
      if (!eatOp(v)) throw ExprError('Expected "' + v + '" but found ' + describe(peek()), peek().pos, src);
    };
    const expectKw = function (v) {
      if (!eatKw(v)) throw ExprError('Expected ' + v + ' but found ' + describe(peek()), peek().pos, src);
    };

    function parseOr() {
      let a = parseAnd();
      while (isKw('OR')) { const pos = next().pos; a = { type: 'or', a: a, b: parseAnd(), pos: pos }; }
      return a;
    }
    function parseAnd() {
      let a = parseNot();
      while (isKw('AND') || isOp('&&')) { const pos = next().pos; a = { type: 'and', a: a, b: parseNot(), pos: pos }; }
      return a;
    }
    function parseNot() {
      if (isKw('NOT') || isOp('!')) { const pos = next().pos; return { type: 'not', a: parseNot(), pos: pos }; }
      return parseComparison();
    }
    function parseComparison() {
      const a = parseConcat();
      const t = peek();
      if (t.t === 'op' && ['=', '==', '!=', '<>', '<', '<=', '>', '>=', '~'].indexOf(t.v) >= 0) {
        next();
        let op = t.v;
        if (op === '==') op = '=';
        if (op === '<>') op = '!=';
        return { type: 'cmp', op: op, a: a, b: parseConcat(), pos: t.pos };
      }
      if (isKw('IS')) {
        const pos = next().pos;
        const neg = eatKw('NOT');
        if (eatKw('NULL')) return { type: 'isnull', a: a, not: neg, pos: pos };
        if (eatKw('TRUE')) return { type: 'cmp', op: neg ? '!=' : '=', a: a, b: { type: 'bool', v: true }, pos: pos };
        if (eatKw('FALSE')) return { type: 'cmp', op: neg ? '!=' : '=', a: a, b: { type: 'bool', v: false }, pos: pos };
        throw ExprError('Expected NULL after IS', peek().pos, src);
      }
      let neg = false;
      if (isKw('NOT') && (isKw('IN', 1) || isKw('LIKE', 1) || isKw('ILIKE', 1) || isKw('BETWEEN', 1))) { next(); neg = true; }
      if (isKw('IN')) {
        const pos = next().pos;
        expectOp('(');
        const list = [];
        if (!isOp(')')) {
          do { list.push(parseOr()); } while (eatOp(','));
        }
        expectOp(')');
        return { type: 'in', a: a, list: list, not: neg, pos: pos };
      }
      if (isKw('LIKE') || isKw('ILIKE')) {
        const kw = next();
        return { type: 'like', a: a, b: parseConcat(), ci: kw.v === 'ILIKE', not: neg, pos: kw.pos };
      }
      if (isKw('BETWEEN')) {
        const pos = next().pos;
        const lo = parseConcat();
        expectKw('AND');
        const hi = parseConcat();
        return { type: 'between', a: a, lo: lo, hi: hi, not: neg, pos: pos };
      }
      return a;
    }
    function parseConcat() {
      let a = parseAdditive();
      while (isOp('||')) { const pos = next().pos; a = { type: 'concat', a: a, b: parseAdditive(), pos: pos }; }
      return a;
    }
    function parseAdditive() {
      let a = parseMul();
      while (isOp('+') || isOp('-')) { const t = next(); a = { type: 'bin', op: t.v, a: a, b: parseMul(), pos: t.pos }; }
      return a;
    }
    function parseMul() {
      let a = parseUnary();
      while (isOp('*') || isOp('/') || isOp('%') || isOp('//')) { const t = next(); a = { type: 'bin', op: t.v, a: a, b: parseUnary(), pos: t.pos }; }
      return a;
    }
    function parseUnary() {
      if (isOp('-')) { const pos = next().pos; return { type: 'neg', a: parseUnary(), pos: pos }; }
      if (isOp('+')) { next(); return parseUnary(); }
      return parsePower();
    }
    function parsePower() {
      const base = parsePrimary();
      if (isOp('^') || isOp('**')) { const pos = next().pos; return { type: 'bin', op: '^', a: base, b: parseUnary(), pos: pos }; }
      return base;
    }
    function parseCase(pos) {
      // CASE [subject] WHEN .. THEN .. [WHEN ..]* [ELSE ..] END
      let subject = null;
      if (!isKw('WHEN')) subject = parseOr();
      const whens = [];
      while (eatKw('WHEN')) {
        const cond = parseOr();
        expectKw('THEN');
        whens.push({ cond: cond, value: parseOr() });
      }
      if (!whens.length) throw ExprError('CASE needs at least one WHEN … THEN …', peek().pos, src);
      let otherwise = null;
      if (eatKw('ELSE')) otherwise = parseOr();
      expectKw('END');
      return { type: 'case', subject: subject, whens: whens, otherwise: otherwise, pos: pos };
    }
    function parsePrimary() {
      const t = next();
      switch (t.t) {
        case 'num': return { type: 'num', v: t.v, pos: t.pos };
        case 'str': return { type: 'str', v: t.v, pos: t.pos };
        case 'qid': return { type: 'field', name: t.v, quoted: true, pos: t.pos };
        case 'var': return { type: 'var', name: t.v, pos: t.pos };
        case 'kw':
          if (t.v === 'TRUE') return { type: 'bool', v: true, pos: t.pos };
          if (t.v === 'FALSE') return { type: 'bool', v: false, pos: t.pos };
          if (t.v === 'NULL') return { type: 'null', pos: t.pos };
          if (t.v === 'CASE') return parseCase(t.pos);
          throw ExprError('Unexpected ' + t.v, t.pos, src);
        case 'id':
          if (isOp('(')) {
            next();
            const args = [];
            if (!isOp(')')) {
              do { args.push(parseOr()); } while (eatOp(','));
            }
            expectOp(')');
            return { type: 'call', name: t.v, args: args, pos: t.pos };
          }
          return { type: 'field', name: t.v, quoted: false, pos: t.pos };
        case 'op':
          if (t.v === '(') {
            const e = parseOr();
            expectOp(')');
            return e;
          }
          throw ExprError('Unexpected "' + t.v + '"', t.pos, src);
        case 'eof':
          throw ExprError('Expression ends too early', t.pos, src);
        default:
          throw ExprError('Unexpected ' + describe(t), t.pos, src);
      }
    }

    const ast = parseOr();
    if (peek().t !== 'eof') {
      const t = peek();
      let hint = '';
      if (t.t === 'id' && /^(and|or|not)$/i.test(t.v)) hint = '';
      else if (t.t === 'op' && t.v === '=' ) hint = '';
      throw ExprError('Unexpected ' + describe(t) + ' — is an operator (AND, OR, +, =, …) missing?' + hint, t.pos, src);
    }
    return ast;
  }

  /* ============================================================== runtime */

  function isNull(x) { return x === null || x === undefined || (typeof x === 'number' && x !== x); }

  function toNum(x) {
    if (typeof x === 'number') return x;
    if (x === null || x === undefined) return null;
    if (typeof x === 'boolean') return x ? 1 : 0;
    if (typeof x === 'string') {
      const s = x.trim();
      if (s === '') return null;
      const n = Number(s);
      return isFinite(n) ? n : NaN;
    }
    return NaN;
  }

  function toBool(x) {
    if (isNull(x)) return null;
    if (typeof x === 'boolean') return x;
    if (typeof x === 'number') return x !== 0;
    if (typeof x === 'string') {
      const s = x.trim().toLowerCase();
      if (s === 'false' || s === '0' || s === 'no' || s === '') return false;
      return true;
    }
    return true;
  }

  function toStr(x) {
    if (isNull(x)) return null;
    if (typeof x === 'string') return x;
    if (typeof x === 'number') return String(+x.toPrecision(15));
    if (typeof x === 'object') return JSON.stringify(x);
    return String(x);
  }

  function numericLike(x) { return typeof x === 'number' || typeof x === 'boolean' || (typeof x === 'string' && x.trim() !== '' && isFinite(Number(x))); }

  /** Compare with loose numeric semantics; returns <0, 0, >0 or null. */
  function compare(a, b) {
    if (isNull(a) || isNull(b)) return null;
    if ((typeof a === 'number' || typeof b === 'number') && numericLike(a) && numericLike(b)) {
      const x = toNum(a), y = toNum(b);
      return x < y ? -1 : x > y ? 1 : 0;
    }
    if (typeof a === 'boolean' || typeof b === 'boolean') {
      const x = toBool(a), y = toBool(b);
      return x === y ? 0 : (x ? 1 : -1);
    }
    const s = toStr(a), t = toStr(b);
    return s < t ? -1 : s > t ? 1 : 0;
  }

  const regexCache = new Map();
  function cachedRegex(key, make) {
    let r = regexCache.get(key);
    if (!r) {
      r = make();
      if (regexCache.size > 500) regexCache.clear();
      regexCache.set(key, r);
    }
    return r;
  }
  function likeRegex(pattern, ci) {
    return cachedRegex('L' + (ci ? 'i' : '') + pattern, function () {
      let re = '';
      for (let i = 0; i < pattern.length; i++) {
        const c = pattern[i];
        if (c === '%') re += '[\\s\\S]*';
        else if (c === '_') re += '[\\s\\S]';
        else if (c === '\\' && i + 1 < pattern.length) { i++; re += pattern[i].replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
        else re += c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      }
      return new RegExp('^' + re + '$', ci ? 'i' : '');
    });
  }
  function userRegex(pattern, flags) {
    return cachedRegex('R' + (flags || '') + '/' + pattern, function () {
      try { return new RegExp(pattern, flags || ''); } catch (e) { throw new Error('Invalid regular expression: ' + e.message); }
    });
  }

  function numArgs(fn) {
    return function () {
      const args = new Array(arguments.length);
      for (let i = 0; i < arguments.length; i++) {
        const v = toNum(arguments[i]);
        if (v === null || v !== v) return null;
        args[i] = v;
      }
      const r = fn.apply(null, args);
      return typeof r === 'number' && !isFinite(r) ? null : r;
    };
  }
  function strArg(fn) {
    return function (s) {
      const v = toStr(s);
      if (v === null) return null;
      const rest = Array.prototype.slice.call(arguments, 1);
      return fn.apply(null, [v].concat(rest));
    };
  }

  function parseDate(x) {
    if (isNull(x)) return null;
    if (x instanceof Date) return isNaN(x) ? null : x;
    if (typeof x === 'number') return new Date(x);
    const s = String(x).trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return new Date(s + 'T00:00:00Z');
    if (/^\d{8}$/.test(s)) return new Date(s.slice(0, 4) + '-' + s.slice(4, 6) + '-' + s.slice(6, 8) + 'T00:00:00Z');
    const d = new Date(s);
    return isNaN(d) ? null : d;
  }
  function dateFn(fn) { return function (x) { const d = parseDate(x); return d ? fn(d) : null; }; }
  const pad2 = function (n) { return (n < 10 ? '0' : '') + n; };

  // Scalar functions available to expressions.
  // Each entry: [implementation, argument hint, description, group].
  const FN = {
    // math
    abs: [numArgs(Math.abs), 'x', 'Absolute value', 'Math'],
    sqrt: [numArgs(function (x) { return x < 0 ? null : Math.sqrt(x); }), 'x', 'Square root', 'Math'],
    pow: [numArgs(Math.pow), 'x, y', 'x to the power y', 'Math'],
    exp: [numArgs(Math.exp), 'x', 'e to the power x', 'Math'],
    ln: [numArgs(function (x) { return x > 0 ? Math.log(x) : null; }), 'x', 'Natural logarithm', 'Math'],
    log10: [numArgs(function (x) { return x > 0 ? Math.log10(x) : null; }), 'x', 'Base-10 logarithm', 'Math'],
    log: [numArgs(function (b, x) { if (x === undefined) return b > 0 ? Math.log(b) : null; if (!(x > 0 && b > 0 && b !== 1)) return null; return b === 10 ? Math.log10(x) : b === 2 ? Math.log2(x) : Math.log(x) / Math.log(b); }), 'base, x', 'Logarithm of x in the given base', 'Math'],
    round: [numArgs(function (x, n) { const f = Math.pow(10, n || 0); return Math.round(x * f) / f; }), 'x [, digits]', 'Round to the given number of decimals', 'Math'],
    floor: [numArgs(Math.floor), 'x', 'Round down', 'Math'],
    ceil: [numArgs(Math.ceil), 'x', 'Round up', 'Math'],
    trunc: [numArgs(Math.trunc), 'x', 'Drop the fractional part', 'Math'],
    sign: [numArgs(Math.sign), 'x', '-1, 0 or 1', 'Math'],
    min: [numArgs(function () { return Math.min.apply(null, arguments); }), 'a, b, …', 'Smallest of the arguments (see minimum() for a layer-wide aggregate)', 'Math'],
    max: [numArgs(function () { return Math.max.apply(null, arguments); }), 'a, b, …', 'Largest of the arguments (see maximum() for a layer-wide aggregate)', 'Math'],
    clamp: [numArgs(function (lo, x, hi) { return Math.min(hi, Math.max(lo, x)); }), 'min, x, max', 'Limit x to a range', 'Math'],
    sin: [numArgs(Math.sin), 'radians', 'Sine', 'Math'],
    cos: [numArgs(Math.cos), 'radians', 'Cosine', 'Math'],
    tan: [numArgs(Math.tan), 'radians', 'Tangent', 'Math'],
    asin: [numArgs(Math.asin), 'x', 'Arc sine (radians)', 'Math'],
    acos: [numArgs(Math.acos), 'x', 'Arc cosine (radians)', 'Math'],
    atan: [numArgs(Math.atan), 'x', 'Arc tangent (radians)', 'Math'],
    atan2: [numArgs(Math.atan2), 'y, x', 'Arc tangent of y/x (radians)', 'Math'],
    radians: [numArgs(function (d) { return d * Math.PI / 180; }), 'degrees', 'Degrees → radians', 'Math'],
    degrees: [numArgs(function (r) { return r * 180 / Math.PI; }), 'radians', 'Radians → degrees', 'Math'],
    pi: [function () { return Math.PI; }, '', 'π', 'Math'],
    rand: [function (a, b) { const lo = toNum(a), hi = toNum(b); if (lo === null || hi === null) return Math.random(); return Math.floor(lo + Math.random() * (hi - lo + 1)); }, '[min, max]', 'Random number (integer between min and max when given)', 'Math'],
    scale_linear: [numArgs(function (v, d0, d1, r0, r1) { if (d1 === d0) return r0; const t = Math.max(0, Math.min(1, (v - d0) / (d1 - d0))); return r0 + t * (r1 - r0); }), 'value, domain_min, domain_max, range_min, range_max', 'Rescale a value linearly (clamped)', 'Math'],
    convert: [function (v, from, to) {
      const x = toNum(v);
      if (x === null || x !== x) return null;
      const lf = util.normalizeUnit(from), lt = util.normalizeUnit(to);
      if (lf && lt) return util.fromMeters(util.toMeters(x, lf), lt);
      const af = util.normalizeAreaUnit(from), at = util.normalizeAreaUnit(to);
      if (af && at) return util.fromSqMeters(x / util.fromSqMeters(1, af), at);
      throw new Error('convert(): unknown or mismatched units "' + from + '" → "' + to + '"');
    }, "value, 'from', 'to'", "Convert units, e.g. convert($area, 'sqm', 'acres') or convert($length, 'm', 'mi')", 'Math'],

    // text
    upper: [strArg(function (s) { return s.toUpperCase(); }), 'text', 'UPPER CASE', 'Text'],
    lower: [strArg(function (s) { return s.toLowerCase(); }), 'text', 'lower case', 'Text'],
    title: [strArg(function (s) { return s.toLowerCase().replace(/(^|[\s\-'(])(\S)/g, function (m, a, b) { return a + b.toUpperCase(); }); }), 'text', 'Title Case', 'Text'],
    trim: [strArg(function (s) { return s.trim(); }), 'text', 'Remove surrounding spaces', 'Text'],
    ltrim: [strArg(function (s) { return s.replace(/^\s+/, ''); }), 'text', 'Remove leading spaces', 'Text'],
    rtrim: [strArg(function (s) { return s.replace(/\s+$/, ''); }), 'text', 'Remove trailing spaces', 'Text'],
    length: [strArg(function (s) { return Array.from(s).length; }), 'text', 'Number of characters (see $length for line length)', 'Text'],
    substr: [strArg(function (s, start, len) {
      const chars = Array.from(s);
      let st = toNum(start);
      if (st === null) return null;
      st = st > 0 ? st - 1 : st < 0 ? Math.max(0, chars.length + st) : 0;
      const l = toNum(len);
      return chars.slice(st, l === null || l === undefined ? undefined : st + Math.max(0, l)).join('');
    }), 'text, start [, length]', 'Part of the text (start is 1-based; negative counts from the end)', 'Text'],
    left: [strArg(function (s, n) { return Array.from(s).slice(0, Math.max(0, toNum(n) || 0)).join(''); }), 'text, n', 'First n characters', 'Text'],
    right: [strArg(function (s, n) { const c = Array.from(s); const k = Math.max(0, toNum(n) || 0); return k ? c.slice(-k).join('') : ''; }), 'text, n', 'Last n characters', 'Text'],
    replace: [strArg(function (s, a, b) { const x = toStr(a); if (x === null || x === '') return s; return s.split(x).join(toStr(b) === null ? '' : toStr(b)); }), 'text, find, replacement', 'Replace every occurrence', 'Text'],
    regexp_replace: [strArg(function (s, re, rep) { return s.replace(userRegex(toStr(re), 'g'), toStr(rep) === null ? '' : toStr(rep)); }), 'text, pattern, replacement', 'Regular-expression replace (all matches; $1 refers to groups)', 'Text'],
    regexp_match: [strArg(function (s, re, flags) { return userRegex(toStr(re), toStr(flags) || '').test(s); }), "text, pattern [, 'i']", 'Does the text match the regular expression?', 'Text'],
    regexp_substr: [strArg(function (s, re) { const m = userRegex(toStr(re), '').exec(s); return m ? (m.length > 1 && m[1] !== undefined ? m[1] : m[0]) : null; }), 'text, pattern', 'First match (or first group)', 'Text'],
    concat: [function () { let out = ''; for (let i = 0; i < arguments.length; i++) { const s = toStr(arguments[i]); if (s !== null) out += s; } return out; }, 'a, b, …', 'Join values as text (NULLs are skipped)', 'Text'],
    strpos: [strArg(function (s, sub) { const x = toStr(sub); return x === null ? null : s.indexOf(x) + 1; }), 'text, part', 'Position of part in text (1-based, 0 = not found)', 'Text'],
    starts_with: [strArg(function (s, p) { const x = toStr(p); return x === null ? null : s.startsWith(x); }), 'text, prefix', 'Does the text start with prefix?', 'Text'],
    ends_with: [strArg(function (s, p) { const x = toStr(p); return x === null ? null : s.endsWith(x); }), 'text, suffix', 'Does the text end with suffix?', 'Text'],
    contains: [strArg(function (s, p) { const x = toStr(p); return x === null ? null : s.toLowerCase().indexOf(x.toLowerCase()) >= 0; }), 'text, part', 'Does the text contain part? (case-insensitive)', 'Text'],
    lpad: [strArg(function (s, n, ch) { const w = toNum(n) || 0; const c = toStr(ch) || ' '; let out = s; while (Array.from(out).length < w) out = c + out; return out; }), 'text, width, char', 'Pad on the left', 'Text'],
    rpad: [strArg(function (s, n, ch) { const w = toNum(n) || 0; const c = toStr(ch) || ' '; let out = s; while (Array.from(out).length < w) out = out + c; return out; }), 'text, width, char', 'Pad on the right', 'Text'],
    split_part: [strArg(function (s, d, i) { const parts = s.split(toStr(d)); const k = toNum(i); if (k === null) return null; const idx = k > 0 ? k - 1 : parts.length + k; return idx >= 0 && idx < parts.length ? parts[idx] : null; }), 'text, delimiter, n', 'n-th piece after splitting (1-based)', 'Text'],
    format_number: [function (x, d) { const v = toNum(x); if (v === null || v !== v) return null; const dd = toNum(d); return v.toLocaleString('en-US', { minimumFractionDigits: dd || 0, maximumFractionDigits: dd === null || dd === undefined ? 2 : dd }); }, 'x [, decimals]', 'Number with thousands separators', 'Text'],

    // conversion & logic
    to_string: [function (x) { return toStr(x); }, 'x', 'Convert to text', 'Conversion'],
    to_int: [function (x) { const v = toNum(x); return v === null || v !== v ? null : Math.trunc(v); }, 'x', 'Convert to a whole number', 'Conversion'],
    to_real: [function (x) { const v = toNum(x); return v === null || v !== v ? null : v; }, 'x', 'Convert to a number', 'Conversion'],
    to_bool: [function (x) { return toBool(x); }, 'x', 'Convert to true/false', 'Conversion'],
    coalesce: [function () { for (let i = 0; i < arguments.length; i++) if (!isNull(arguments[i])) return arguments[i]; return null; }, 'a, b, …', 'First value that is not NULL', 'Conditionals'],
    nullif: [function (a, b) { return compare(a, b) === 0 ? null : a; }, 'a, b', 'NULL if a equals b, else a', 'Conditionals'],
    if: [null, 'condition, then, else', 'Choose a value', 'Conditionals'], // compiled inline (lazy)
    iif: [null, 'condition, then, else', 'Same as if()', 'Conditionals'],
    is_null: [function (x) { return isNull(x); }, 'x', 'Is the value NULL?', 'Conditionals'],

    // dates
    now: [function () { return new Date().toISOString(); }, '', 'Current date and time (ISO text)', 'Dates'],
    to_date: [dateFn(function (d) { return d.toISOString().slice(0, 10); }), 'text', "Parse a date → 'YYYY-MM-DD'", 'Dates'],
    year: [dateFn(function (d) { return d.getUTCFullYear(); }), 'date', 'Year', 'Dates'],
    month: [dateFn(function (d) { return d.getUTCMonth() + 1; }), 'date', 'Month (1-12)', 'Dates'],
    day: [dateFn(function (d) { return d.getUTCDate(); }), 'date', 'Day of month', 'Dates'],
    hour: [dateFn(function (d) { return d.getUTCHours(); }), 'date', 'Hour (UTC)', 'Dates'],
    minute: [dateFn(function (d) { return d.getUTCMinutes(); }), 'date', 'Minute (UTC)', 'Dates'],
    day_of_week: [dateFn(function (d) { return d.getUTCDay(); }), 'date', 'Day of week (0 = Sunday)', 'Dates'],
    epoch: [dateFn(function (d) { return d.getTime(); }), 'date', 'Milliseconds since 1970-01-01', 'Dates'],
    day_diff: [function (a, b) { const x = parseDate(a), y = parseDate(b); return x && y ? (x - y) / 86400000 : null; }, 'date_a, date_b', 'Days between two dates (a − b)', 'Dates'],
    format_date: [function (x, fmt) {
      const d = parseDate(x);
      if (!d) return null;
      const f = toStr(fmt) || 'YYYY-MM-DD';
      return f.replace(/YYYY|MM|DD|HH|mm|ss/g, function (t) {
        switch (t) {
          case 'YYYY': return String(d.getUTCFullYear());
          case 'MM': return pad2(d.getUTCMonth() + 1);
          case 'DD': return pad2(d.getUTCDate());
          case 'HH': return pad2(d.getUTCHours());
          case 'mm': return pad2(d.getUTCMinutes());
          default: return pad2(d.getUTCSeconds());
        }
      });
    }, "date, 'YYYY-MM-DD'", 'Format a date (YYYY MM DD HH mm ss)', 'Dates'],
  };

  // Layer-wide aggregates: name -> reducer over an array of non-null values.
  const AGG = {
    sum: [function (v) { let s = 0; for (let i = 0; i < v.length; i++) s += v[i]; return s; }, true, 'Sum over the layer'],
    mean: [function (v) { if (!v.length) return null; let s = 0; for (let i = 0; i < v.length; i++) s += v[i]; return s / v.length; }, true, 'Mean over the layer'],
    avg: [null, true, 'Same as mean()'],
    minimum: [function (v) { let m = null; for (let i = 0; i < v.length; i++) if (m === null || compare(v[i], m) < 0) m = v[i]; return m; }, false, 'Smallest value in the layer'],
    maximum: [function (v) { let m = null; for (let i = 0; i < v.length; i++) if (m === null || compare(v[i], m) > 0) m = v[i]; return m; }, false, 'Largest value in the layer'],
    median: [function (v) { if (!v.length) return null; const s = v.slice().sort(function (a, b) { return a - b; }); const h = s.length >> 1; return s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2; }, true, 'Median over the layer'],
    stdev: [function (v) { if (!v.length) return null; let s = 0; for (let i = 0; i < v.length; i++) s += v[i]; const m = s / v.length; let q = 0; for (let i = 0; i < v.length; i++) q += (v[i] - m) * (v[i] - m); return Math.sqrt(q / v.length); }, true, 'Standard deviation over the layer'],
    count: [function (v) { return v.length; }, false, 'Number of non-NULL values (count() = number of features)'],
    count_distinct: [function (v) { return new Set(v.map(function (x) { return typeof x === 'object' ? JSON.stringify(x) : x; })).size; }, false, 'Number of distinct values'],
  };
  AGG.avg[0] = AGG.mean[0];

  const GEOM_VARS = {
    area: 'Area in square meters (polygons)',
    length: 'Length in meters (lines; perimeter for polygons)',
    perimeter: 'Perimeter in meters (polygons)',
    x: 'X / longitude (point, or centroid)',
    y: 'Y / latitude (point, or centroid)',
    lon: 'Same as $x', lat: 'Same as $y',
    id: 'Feature id',
    geomtype: "Geometry type ('Point', 'LineString', 'Polygon', …)",
    npoints: 'Number of vertices',
    index: 'Position of the feature in the layer (0-based)',
  };

  function geomMeasure(f, kind) {
    const g = f && f.geometry;
    if (!g) return null;
    const T = root.turf;
    switch (kind) {
      case 'area': {
        const fam = util.geomFamily(g.type);
        if (fam !== 'Polygon' && g.type !== 'GeometryCollection') return 0;
        return T.area(f);
      }
      case 'length': case 'perimeter': {
        const fam = util.geomFamily(g.type);
        if (fam === 'Point') return 0;
        if (fam === 'Polygon') {
          if (kind === 'length' || kind === 'perimeter') {
            const lines = T.polygonToLine(f);
            return T.length(lines, { units: 'kilometers' }) * 1000;
          }
        }
        if (kind === 'perimeter') return 0;
        return T.length(f, { units: 'kilometers' }) * 1000;
      }
      case 'x': case 'y': {
        let c;
        if (g.type === 'Point') c = g.coordinates;
        else c = T.centroid(f).geometry.coordinates;
        return kind === 'x' ? c[0] : c[1];
      }
      case 'npoints': { let n = 0; util.coordEach(g, function () { n++; }); return n; }
      case 'geomtype': return g.type;
      default: return null;
    }
  }

  function Runtime() {
    this.aggCache = [];
  }
  Runtime.prototype = {
    v: function (x) { return x === undefined ? null : x; },
    add: function (a, b) {
      if (isNull(a) || isNull(b)) return null;
      if (typeof a === 'number' && typeof b === 'number') return a + b;
      if (typeof a === 'string' || typeof b === 'string') return toStr(a) + toStr(b);
      return toNum(a) + toNum(b);
    },
    sub: function (a, b) { const x = toNum(a), y = toNum(b); return x === null || y === null ? null : x - y; },
    mul: function (a, b) { const x = toNum(a), y = toNum(b); return x === null || y === null ? null : x * y; },
    div: function (a, b) { const x = toNum(a), y = toNum(b); return x === null || y === null || y === 0 ? null : x / y; },
    mod: function (a, b) { const x = toNum(a), y = toNum(b); return x === null || y === null || y === 0 ? null : x % y; },
    idiv: function (a, b) { const x = toNum(a), y = toNum(b); return x === null || y === null || y === 0 ? null : Math.floor(x / y); },
    pow: function (a, b) { const x = toNum(a), y = toNum(b); if (x === null || y === null) return null; const r = Math.pow(x, y); return isFinite(r) ? r : null; },
    neg: function (a) { const x = toNum(a); return x === null ? null : -x; },
    concat: function (a, b) { const x = toStr(a), y = toStr(b); return x === null || y === null ? null : x + y; },
    cmp: function (op, a, b) {
      if (op === '~') {
        const s = toStr(a), p = toStr(b);
        return s === null || p === null ? null : userRegex(p, '').test(s);
      }
      const c = compare(a, b);
      if (c === null) return null;
      switch (op) {
        case '=': return c === 0;
        case '!=': return c !== 0;
        case '<': return c < 0;
        case '<=': return c <= 0;
        case '>': return c > 0;
        default: return c >= 0;
      }
    },
    and: function (a, b) {
      const x = toBool(a), y = toBool(b);
      if (x === false || y === false) return false;
      if (x === null || y === null) return null;
      return true;
    },
    or: function (a, b) {
      const x = toBool(a), y = toBool(b);
      if (x === true || y === true) return true;
      if (x === null || y === null) return null;
      return false;
    },
    not: function (a) { const x = toBool(a); return x === null ? null : !x; },
    isnull: isNull,
    truthy: function (a) { return toBool(a) === true; },
    inList: function (a, list, neg) {
      if (isNull(a)) return null;
      let hit = false;
      for (let i = 0; i < list.length; i++) if (compare(a, list[i]) === 0) { hit = true; break; }
      return neg ? !hit : hit;
    },
    like: function (a, pat, ci, neg) {
      const s = toStr(a), p = toStr(pat);
      if (s === null || p === null) return null;
      const r = likeRegex(p, ci).test(s);
      return neg ? !r : r;
    },
    between: function (a, lo, hi, neg) {
      const c1 = compare(a, lo), c2 = compare(a, hi);
      if (c1 === null || c2 === null) return null;
      const r = c1 >= 0 && c2 <= 0;
      return neg ? !r : r;
    },
    eqCase: function (a, b) { return compare(a, b) === 0; },
    geom: function (f, kind) { return geomMeasure(f, kind); },
    fid: function (f) { return f && f.id !== undefined ? f.id : null; },
  };

  /* ============================================================ compiler */

  function suggest(name, candidates) {
    const n = String(name).toLowerCase();
    let best = null, bestD = Infinity;
    const max = n.length <= 3 ? 1 : n.length <= 7 ? 2 : 3;
    (candidates || []).forEach(function (c) {
      const d = util.editDistance(n, String(c).toLowerCase(), max);
      if (d < bestD) { bestD = d; best = c; }
    });
    return bestD <= max ? best : null;
  }

  /**
   * Compile an expression.
   *
   * opts.fields     – known field names; enables validation, case-insensitive
   *                   matching and "did you mean" hints.
   * opts.collection – FeatureCollection used for aggregates (sum(), mean(), …).
   * opts.variables  – extra bare names treated as variables (read from the
   *                   `vars` argument of the compiled function).
   *
   * Returns { fn(feature, index, vars) -> value, fieldsUsed, usesGeometry,
   *           usesAggregates, warnings, ast }.
   */
  function compile(src, opts) {
    opts = opts || {};
    const ast = typeof src === 'string' ? parse(src) : src;
    const text = typeof src === 'string' ? src : '';
    const fieldList = opts.fields ? Array.from(opts.fields) : null;
    const fieldExact = fieldList ? new Set(fieldList) : null;
    const fieldLower = new Map();
    (fieldList || []).forEach(function (f) { const k = String(f).toLowerCase(); if (!fieldLower.has(k)) fieldLower.set(k, f); });
    const varList = (opts.variables || []).map(String);
    const varLower = new Map(varList.map(function (v) { return [v.toLowerCase(), v]; }));
    const fieldsUsed = new Set();
    const warnings = [];
    let usesGeometry = false;
    const aggs = []; // { op, arg, group }
    let inAgg = false;

    function resolveField(node) {
      const name = node.name;
      if (varLower.has(name.toLowerCase()) && !(fieldExact && fieldExact.has(name))) {
        return { kind: 'var', name: varLower.get(name.toLowerCase()) };
      }
      if (!fieldExact) return { kind: 'field', name: name };
      if (fieldExact.has(name)) return { kind: 'field', name: name };
      const ci = fieldLower.get(name.toLowerCase());
      if (ci !== undefined) return { kind: 'field', name: ci };
      // A normalised match ("Pop Density" vs "pop_density")
      const nn = util.normName(name);
      for (let i = 0; i < fieldList.length; i++) if (util.normName(fieldList[i]) === nn) return { kind: 'field', name: fieldList[i] };
      if (node.quoted) {
        // Most likely text written with double quotes: "Chicago".
        warnings.push('Treated "' + name + '" as text because there is no field with that name. Use single quotes for text: \'' + name + '\'.');
        return { kind: 'text', value: name };
      }
      const s = suggest(name, fieldList.concat(varList));
      let msg = 'No field named "' + name + '".';
      if (s) msg += ' Did you mean "' + s + '"?';
      else if (fieldList.length) msg += ' Fields: ' + fieldList.slice(0, 12).join(', ') + (fieldList.length > 12 ? ', …' : '') + '.';
      if (/^[a-z]/i.test(name) && !s) msg += " (Use single quotes for text: '" + name + "'.)";
      throw ExprError(msg, node.pos, text || undefined);
    }

    function gen(node) {
      switch (node.type) {
        case 'num': return '(' + String(node.v) + ')';
        case 'str': return JSON.stringify(node.v);
        case 'bool': return node.v ? 'true' : 'false';
        case 'null': return 'null';
        case 'field': {
          const r = resolveField(node);
          if (r.kind === 'var') return 'R.v(V[' + JSON.stringify(r.name) + '])';
          if (r.kind === 'text') return JSON.stringify(r.value);
          fieldsUsed.add(r.name);
          return 'R.v(P[' + JSON.stringify(r.name) + '])';
        }
        case 'var': {
          const v = node.name;
          if (varLower.has('$' + v)) return 'R.v(V[' + JSON.stringify(varLower.get('$' + v)) + '])';
          if (v === 'id') return 'R.fid(F)';
          if (v === 'index') return 'I';
          if (v === 'lon') { usesGeometry = true; return 'R.geom(F,"x")'; }
          if (v === 'lat') { usesGeometry = true; return 'R.geom(F,"y")'; }
          if (['area', 'length', 'perimeter', 'x', 'y', 'geomtype', 'npoints'].indexOf(v) >= 0) {
            usesGeometry = true;
            return 'R.geom(F,' + JSON.stringify(v) + ')';
          }
          const s = suggest(v, Object.keys(GEOM_VARS));
          throw ExprError('Unknown variable $' + v + (s ? '. Did you mean $' + s + '?' : ''), node.pos, text || undefined);
        }
        case 'neg': return 'R.neg(' + gen(node.a) + ')';
        case 'bin': {
          const a = gen(node.a), b = gen(node.b);
          switch (node.op) {
            case '+': return 'R.add(' + a + ',' + b + ')';
            case '-': return 'R.sub(' + a + ',' + b + ')';
            case '*': return 'R.mul(' + a + ',' + b + ')';
            case '/': return 'R.div(' + a + ',' + b + ')';
            case '%': return 'R.mod(' + a + ',' + b + ')';
            case '//': return 'R.idiv(' + a + ',' + b + ')';
            default: return 'R.pow(' + a + ',' + b + ')';
          }
        }
        case 'concat': return 'R.concat(' + gen(node.a) + ',' + gen(node.b) + ')';
        case 'cmp': {
          // Friendly: `x = NULL` means IS NULL.
          if ((node.op === '=' || node.op === '!=') && (node.b.type === 'null' || node.a.type === 'null')) {
            const other = node.b.type === 'null' ? node.a : node.b;
            const g = 'R.isnull(' + gen(other) + ')';
            return node.op === '=' ? g : '(!' + g + ')';
          }
          return 'R.cmp(' + JSON.stringify(node.op) + ',' + gen(node.a) + ',' + gen(node.b) + ')';
        }
        case 'and': return 'R.and(' + gen(node.a) + ',' + gen(node.b) + ')';
        case 'or': return 'R.or(' + gen(node.a) + ',' + gen(node.b) + ')';
        case 'not': return 'R.not(' + gen(node.a) + ')';
        case 'isnull': return node.not ? '(!R.isnull(' + gen(node.a) + '))' : 'R.isnull(' + gen(node.a) + ')';
        case 'in': return 'R.inList(' + gen(node.a) + ',[' + node.list.map(gen).join(',') + '],' + (node.not ? 'true' : 'false') + ')';
        case 'like': return 'R.like(' + gen(node.a) + ',' + gen(node.b) + ',' + (node.ci ? 'true' : 'false') + ',' + (node.not ? 'true' : 'false') + ')';
        case 'between': return 'R.between(' + gen(node.a) + ',' + gen(node.lo) + ',' + gen(node.hi) + ',' + (node.not ? 'true' : 'false') + ')';
        case 'case': {
          let out = node.otherwise ? gen(node.otherwise) : 'null';
          for (let i = node.whens.length - 1; i >= 0; i--) {
            const w = node.whens[i];
            const cond = node.subject ? 'R.eqCase(' + gen(node.subject) + ',' + gen(w.cond) + ')' : 'R.truthy(' + gen(w.cond) + ')';
            out = '(' + cond + '?' + gen(w.value) + ':' + out + ')';
          }
          return out;
        }
        case 'call': return genCall(node);
        default: throw ExprError('Cannot compile ' + node.type);
      }
    }

    function genCall(node) {
      const name = node.name.toLowerCase();
      if (name === 'if' || name === 'iif') {
        if (node.args.length < 2 || node.args.length > 3) throw ExprError(name + '() takes (condition, then, else)', node.pos, text || undefined);
        return '(R.truthy(' + gen(node.args[0]) + ')?' + gen(node.args[1]) + ':' + (node.args[2] ? gen(node.args[2]) : 'null') + ')';
      }
      if (AGG[name] && !(name === 'count' && false)) {
        if (inAgg) throw ExprError('Aggregates cannot be nested', node.pos, text || undefined);
        if (name !== 'count' && node.args.length < 1) throw ExprError(name + '() needs a field or expression, e.g. ' + name + '("population")', node.pos, text || undefined);
        if (node.args.length > 2) throw ExprError(name + '() takes (expression [, group_by])', node.pos, text || undefined);
        inAgg = true;
        const argSrc = node.args[0] ? gen(node.args[0]) : 'true';
        const grpSrc = node.args[1] ? gen(node.args[1]) : null;
        inAgg = false;
        const k = aggs.length;
        aggs.push({ op: name, arg: argSrc, group: grpSrc });
        return 'A(' + k + ',F,I)';
      }
      const def = FN[name];
      if (!def || !def[0]) {
        const s = suggest(name, Object.keys(FN).concat(Object.keys(AGG)));
        throw ExprError('Unknown function ' + node.name + '()' + (s ? '. Did you mean ' + s + '()?' : ''), node.pos, text || undefined);
      }
      return 'FN[' + JSON.stringify(name) + '](' + node.args.map(gen).join(',') + ')';
    }

    const body = gen(ast);
    const R = new Runtime();
    const fns = {};
    Object.keys(FN).forEach(function (k) { if (FN[k][0]) fns[k] = FN[k][0]; });

    // eslint-disable-next-line no-new-func
    const make = new Function('R', 'FN', 'A', 'return function (F, I, V) { var P = (F && F.properties) || {}; V = V || {}; return ' + body + '; };');
    const aggFns = aggs.map(function (a) {
      // eslint-disable-next-line no-new-func
      const mk = new Function('R', 'FN', 'A', 'return [function (F, I, V) { var P = (F && F.properties) || {}; V = V || {}; return ' + a.arg + '; }, ' +
        (a.group ? 'function (F, I, V) { var P = (F && F.properties) || {}; V = V || {}; return ' + a.group + '; }' : 'null') + '];');
      return mk(R, fns, null);
    });

    let collection = opts.collection || null;
    const cache = [];
    function groupKey(v) { return v === null || v === undefined ? '\u0000null' : typeof v === 'object' ? JSON.stringify(v) : String(v); }
    function A(k, F, I) {
      if (!collection) throw new Error('Aggregates like ' + aggs[k].op + '() need a layer');
      let c = cache[k];
      if (!c) {
        const spec = aggs[k];
        const argFn = aggFns[k][0], grpFn = aggFns[k][1];
        const reducer = AGG[spec.op][0];
        const numeric = AGG[spec.op][1];
        const feats = collection.features;
        const buckets = new Map();
        for (let i = 0; i < feats.length; i++) {
          const key = grpFn ? groupKey(grpFn(feats[i], i)) : '';
          let arr = buckets.get(key);
          if (!arr) { arr = []; buckets.set(key, arr); }
          let v = argFn(feats[i], i);
          if (spec.op === 'count' && aggs[k].arg === 'true') v = 1;
          if (isNull(v)) continue;
          if (numeric) { v = toNum(v); if (v === null || v !== v) continue; }
          arr.push(v);
        }
        c = new Map();
        buckets.forEach(function (vals, key) { c.set(key, reducer(vals)); });
        c.grp = grpFn;
        cache[k] = c;
      }
      const key = c.grp ? groupKey(c.grp(F, I)) : '';
      const r = c.get(key);
      return r === undefined ? (aggs[k].op === 'count' ? 0 : null) : r;
    }

    const inner = make(R, fns, A);
    return {
      ast: ast,
      source: text,
      fn: inner,
      fieldsUsed: Array.from(fieldsUsed),
      usesGeometry: usesGeometry,
      usesAggregates: aggs.length > 0,
      warnings: warnings,
      /** Use a (different) layer for aggregates; clears cached totals. */
      setCollection: function (fc) { collection = fc; cache.length = 0; },
    };
  }

  /* ======================================================= raster compiler */

  /**
   * Compile a numeric band-math expression. Bare names resolve to band
   * variables (b1, b2, … and any band names). Returns
   * { fn(vars) -> number, variables: [used names] }.
   */
  function compileRaster(src, variables) {
    const ast = parse(src);
    const vars = (variables || []).map(String);
    const lower = new Map(vars.map(function (v) { return [v.toLowerCase(), v]; }));
    const used = new Set();
    const MATH = {
      abs: 'Math.abs', sqrt: 'Math.sqrt', exp: 'Math.exp', ln: 'Math.log', log10: 'Math.log10', floor: 'Math.floor', ceil: 'Math.ceil',
      trunc: 'Math.trunc', sign: 'Math.sign', sin: 'Math.sin', cos: 'Math.cos', tan: 'Math.tan', asin: 'Math.asin', acos: 'Math.acos',
      atan: 'Math.atan', atan2: 'Math.atan2', pow: 'Math.pow', min: 'Math.min', max: 'Math.max',
    };
    function g(n) {
      switch (n.type) {
        case 'num': return '(' + String(n.v) + ')';
        case 'bool': return n.v ? '1' : '0';
        case 'null': return 'NaN';
        case 'field': {
          const v = lower.get(n.name.toLowerCase());
          if (v === undefined) {
            const s = suggest(n.name, vars);
            throw ExprError('Unknown band "' + n.name + '".' + (s ? ' Did you mean ' + s + '?' : ' Bands: ' + vars.join(', ')), n.pos, src);
          }
          used.add(v);
          return 'V[' + JSON.stringify(v) + ']';
        }
        case 'str': throw ExprError('Text is not allowed in band math', n.pos, src);
        case 'var': throw ExprError('$' + n.name + ' is not available in band math', n.pos, src);
        case 'neg': return '(-' + g(n.a) + ')';
        case 'bin': {
          const a = g(n.a), b = g(n.b);
          if (n.op === '^') return 'Math.pow(' + a + ',' + b + ')';
          if (n.op === '//') return 'Math.floor(' + a + '/' + b + ')';
          return '(' + a + n.op + b + ')';
        }
        case 'cmp': {
          if (n.op === '~') throw ExprError('~ is not available in band math', n.pos, src);
          const op = n.op === '=' ? '===' : n.op === '!=' ? '!==' : n.op;
          return '((' + g(n.a) + op + g(n.b) + ')?1:0)';
        }
        case 'and': return '((' + g(n.a) + ')&&(' + g(n.b) + ')?1:0)';
        case 'or': return '((' + g(n.a) + ')||(' + g(n.b) + ')?1:0)';
        case 'not': return '((' + g(n.a) + ')?0:1)';
        case 'between': { const a = g(n.a); const r = '((' + a + '>=' + g(n.lo) + ')&&(' + a + '<=' + g(n.hi) + '))'; return '(' + (n.not ? '!' : '') + r + '?1:0)'; }
        case 'in': { const a = g(n.a); const r = '(' + n.list.map(function (x) { return a + '===' + g(x); }).join('||') + ')'; return '(' + (n.not ? '!' : '') + r + '?1:0)'; }
        case 'isnull': { const a = g(n.a); return '(' + (n.not ? '!' : '') + 'Number.isNaN(' + a + ')?1:0)'; }
        case 'case': {
          let out = n.otherwise ? g(n.otherwise) : 'NaN';
          for (let i = n.whens.length - 1; i >= 0; i--) {
            const w = n.whens[i];
            const cond = n.subject ? '(' + g(n.subject) + '===' + g(w.cond) + ')' : '(' + g(w.cond) + ')';
            out = '(' + cond + '?' + g(w.value) + ':' + out + ')';
          }
          return out;
        }
        case 'call': {
          const name = n.name.toLowerCase();
          const args = n.args.map(g);
          if (name === 'if' || name === 'iif') return '((' + args[0] + ')?' + args[1] + ':' + (args[2] || 'NaN') + ')';
          if (name === 'round') return args.length > 1 ? '(Math.round(' + args[0] + '*Math.pow(10,' + args[1] + '))/Math.pow(10,' + args[1] + '))' : 'Math.round(' + args[0] + ')';
          if (name === 'clamp') return 'Math.min(' + args[2] + ',Math.max(' + args[0] + ',' + args[1] + '))';
          if (name === 'log') return args.length > 1 ? '(Math.log(' + args[1] + ')/Math.log(' + args[0] + '))' : 'Math.log(' + args[0] + ')';
          if (name === 'pi') return 'Math.PI';
          if (name === 'radians') return '(' + args[0] + '*Math.PI/180)';
          if (name === 'degrees') return '(' + args[0] + '*180/Math.PI)';
          if (name === 'scale_linear') return '(' + args[3] + '+Math.max(0,Math.min(1,(' + args[0] + '-' + args[1] + ')/(' + args[2] + '-' + args[1] + ')))*(' + args[4] + '-' + args[3] + '))';
          if (MATH[name]) return MATH[name] + '(' + args.join(',') + ')';
          throw ExprError('Function ' + n.name + '() is not available in band math', n.pos, src);
        }
        default: throw ExprError('Cannot use ' + n.type + ' in band math', n.pos, src);
      }
    }
    const body = g(ast);
    // eslint-disable-next-line no-new-func
    const fn = new Function('V', 'return +(' + body + ');');
    return { fn: fn, variables: Array.from(used), ast: ast };
  }

  /* ================================================================= API */

  const expr = (M.expr = {});
  expr.parse = parse;
  expr.tokenize = tokenize;
  expr.compile = compile;
  expr.compileRaster = compileRaster;
  expr.toBool = toBool;
  expr.isNull = isNull;

  /** Evaluate once against a single feature. */
  expr.evaluate = function (src, feature, opts) {
    return compile(src, opts).fn(feature, 0);
  };

  function fieldsOf(fc) {
    const set = new Set();
    const feats = (fc && fc.features) || [];
    for (let i = 0; i < feats.length && i < 5000; i++) {
      const p = feats[i].properties;
      if (p) for (const k in p) set.add(k);
    }
    return Array.from(set);
  }
  expr.fieldsOf = fieldsOf;

  /** Indices of features for which the expression is true. Pass opts.warnings = [] to collect warnings. */
  expr.filter = function (fc, src, opts) {
    opts = opts || {};
    const c = compile(src, Object.assign({ fields: fieldsOf(fc), collection: fc }, opts));
    if (Array.isArray(opts.warnings)) Array.prototype.push.apply(opts.warnings, c.warnings);
    const out = [];
    const feats = fc.features;
    for (let i = 0; i < feats.length; i++) if (toBool(c.fn(feats[i], i)) === true) out.push(i);
    return out;
  };

  /** Evaluate for every feature; returns an array of values. */
  expr.calculate = function (fc, src, opts) {
    opts = opts || {};
    const c = compile(src, Object.assign({ fields: fieldsOf(fc), collection: fc }, opts));
    if (Array.isArray(opts.warnings)) Array.prototype.push.apply(opts.warnings, c.warnings);
    const feats = fc.features;
    const out = new Array(feats.length);
    for (let i = 0; i < feats.length; i++) out[i] = c.fn(feats[i], i);
    return out;
  };

  /** Check an expression without running it: { ok, error, warnings }. */
  expr.check = function (src, opts) {
    try {
      const c = compile(src, opts);
      return { ok: true, warnings: c.warnings, fieldsUsed: c.fieldsUsed };
    } catch (e) {
      return { ok: false, error: e.shortMessage || e.message, pos: e.pos };
    }
  };

  /** Quote a field name for use in an expression. */
  expr.quoteField = function (name) { return '"' + String(name).replace(/"/g, '""') + '"'; };
  /** Quote a value as an expression literal. */
  expr.literal = function (v) {
    if (v === null || v === undefined) return 'NULL';
    if (typeof v === 'number') return isFinite(v) ? String(v) : 'NULL';
    if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
    return "'" + String(v).replace(/'/g, "''") + "'";
  };

  /** Reference for help & autocomplete. */
  expr.reference = function () {
    const fns = Object.keys(FN).map(function (k) { return { name: k, args: FN[k][1], description: FN[k][2], group: FN[k][3] }; });
    const aggs = Object.keys(AGG).map(function (k) { return { name: k, args: k === 'count' ? '[expression] [, group_by]' : 'expression [, group_by]', description: AGG[k][2], group: 'Aggregates' }; });
    const vars = Object.keys(GEOM_VARS).map(function (k) { return { name: '$' + k, description: GEOM_VARS[k], group: 'Geometry' }; });
    return {
      functions: fns.concat(aggs),
      variables: vars,
      operators: ['+', '-', '*', '/', '%', '//', '^', '||', '=', '!=', '<', '<=', '>', '>=', '~', 'AND', 'OR', 'NOT', 'IN (…)', 'LIKE', 'ILIKE', 'BETWEEN … AND …', 'IS NULL', 'IS NOT NULL', 'CASE WHEN … THEN … ELSE … END'],
    };
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
