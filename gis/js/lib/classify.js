/*
 * PSICITS — data classification for choropleths and graduated symbols.
 * breaks(values, method, n) returns n+1 ascending class edges [min, ..., max].
 */
(function (root) {
  'use strict';

  const M = (root.PSICITS = root.PSICITS || {});

  function numeric(values) {
    const out = [];
    for (let i = 0; i < values.length; i++) {
      const v = values[i];
      if (v === null || v === undefined || v === '') continue;
      const n = typeof v === 'number' ? v : Number(v);
      if (isFinite(n)) out.push(n);
    }
    out.sort(function (a, b) { return a - b; });
    return out;
  }

  function dedupe(edges) {
    const out = [];
    for (let i = 0; i < edges.length; i++) {
      if (!out.length || edges[i] > out[out.length - 1]) out.push(edges[i]);
    }
    if (out.length === 1) out.push(out[0]);
    return out;
  }

  function equal(sorted, n) {
    const min = sorted[0], max = sorted[sorted.length - 1];
    const out = [];
    for (let i = 0; i <= n; i++) out.push(min + ((max - min) * i) / n);
    out[n] = max;
    return out;
  }

  function quantile(sorted, n) {
    const out = [sorted[0]];
    for (let i = 1; i < n; i++) {
      const idx = (sorted.length - 1) * (i / n);
      const lo = Math.floor(idx), hi = Math.ceil(idx);
      out.push(sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo));
    }
    out.push(sorted[sorted.length - 1]);
    return out;
  }

  // Fisher-Jenks natural breaks (classic matrix algorithm) on up to ~1500
  // values; larger inputs are sampled evenly across the sorted array.
  function jenks(sortedAll, n) {
    let data = sortedAll;
    const MAXN = 1500;
    if (data.length > MAXN) {
      const sample = [];
      for (let i = 0; i < MAXN; i++) sample.push(data[Math.round((i * (data.length - 1)) / (MAXN - 1))]);
      data = sample;
    }
    const len = data.length;
    if (n >= len) return dedupe(data.slice());
    const lower = [], variance = [];
    for (let i = 0; i <= len; i++) {
      lower.push(new Array(n + 1).fill(0));
      variance.push(new Array(n + 1).fill(0));
    }
    for (let j = 1; j <= n; j++) {
      lower[1][j] = 1;
      variance[1][j] = 0;
      for (let i = 2; i <= len; i++) variance[i][j] = Infinity;
    }
    for (let l = 2; l <= len; l++) {
      let sum = 0, sumSq = 0, w = 0, v = 0;
      for (let m = 1; m <= l; m++) {
        const lcl = l - m + 1;
        const val = data[lcl - 1];
        w++;
        sum += val;
        sumSq += val * val;
        v = sumSq - (sum * sum) / w;
        const i4 = lcl - 1;
        if (i4 !== 0) {
          for (let j = 2; j <= n; j++) {
            if (variance[l][j] >= v + variance[i4][j - 1]) {
              lower[l][j] = lcl;
              variance[l][j] = v + variance[i4][j - 1];
            }
          }
        }
      }
      lower[l][1] = 1;
      variance[l][1] = v;
    }
    const breaks = new Array(n + 1);
    breaks[n] = data[len - 1];
    breaks[0] = data[0];
    let k = len;
    for (let j = n; j >= 2; j--) {
      const id = lower[k][j] - 2;
      breaks[j - 1] = data[id];
      k = lower[k][j] - 1;
    }
    breaks[0] = sortedAll[0];
    breaks[n] = sortedAll[sortedAll.length - 1];
    return breaks;
  }

  // "Pretty" round-number breaks, similar to R's pretty().
  function prettyStep(range, n) {
    const raw = range / Math.max(1, n);
    const mag = Math.pow(10, Math.floor(Math.log10(raw)));
    const norm = raw / mag;
    let step;
    if (norm < 1.5) step = 1; else if (norm < 3) step = 2; else if (norm < 7) step = 5; else step = 10;
    return step * mag;
  }
  function pretty(sorted, n) {
    const min = sorted[0], max = sorted[sorted.length - 1];
    if (min === max) return [min, max];
    const step = prettyStep(max - min, n);
    const start = Math.floor(min / step) * step;
    const out = [];
    for (let v = start; v < max + step * 0.5; v += step) out.push(+v.toPrecision(12));
    if (out[out.length - 1] < max) out.push(+(out[out.length - 1] + step).toPrecision(12));
    return out;
  }

  // Standard deviation classes centred on the mean.
  function stddev(sorted, n) {
    const len = sorted.length;
    let sum = 0;
    for (let i = 0; i < len; i++) sum += sorted[i];
    const mean = sum / len;
    let sq = 0;
    for (let i = 0; i < len; i++) sq += (sorted[i] - mean) * (sorted[i] - mean);
    const sd = Math.sqrt(sq / len) || 1;
    const half = n / 2;
    const out = [sorted[0]];
    for (let i = 1; i < n; i++) {
      const e = mean + (i - half) * sd;
      if (e > sorted[0] && e < sorted[len - 1]) out.push(e);
    }
    out.push(sorted[len - 1]);
    return out;
  }

  const METHODS = { equal: equal, quantile: quantile, jenks: jenks, pretty: pretty, stddev: stddev };
  const ALIASES = {
    'equal-interval': 'equal', equalinterval: 'equal', interval: 'equal', equal_interval: 'equal', linear: 'equal',
    quantiles: 'quantile', quartile: 'quantile', quintile: 'quantile', percentile: 'quantile', 'equal-count': 'quantile',
    natural: 'jenks', 'natural-breaks': 'jenks', naturalbreaks: 'jenks', natural_breaks: 'jenks', ckmeans: 'jenks', 'fisher-jenks': 'jenks',
    nice: 'pretty', round: 'pretty', 'standard-deviation': 'stddev', std: 'stddev', sd: 'stddev', 'std-dev': 'stddev',
  };

  const classify = (M.classify = {});
  classify.METHODS = Object.keys(METHODS);

  classify.normalizeMethod = function (m) {
    if (!m) return null;
    const k = String(m).toLowerCase().trim().replace(/\s+/g, '-');
    if (METHODS[k]) return k;
    return ALIASES[k] || ALIASES[k.replace(/-/g, '')] || null;
  };

  /**
   * Class edges for `values` using `method` with `n` classes.
   * Returns ascending unique edges; the number of classes may shrink when the
   * data have fewer distinct values than requested.
   */
  classify.breaks = function (values, method, n) {
    const sorted = numeric(values);
    if (!sorted.length) return [];
    n = Math.max(1, Math.min(20, Math.round(n || 5)));
    const mth = classify.normalizeMethod(method) || 'quantile';
    if (sorted[0] === sorted[sorted.length - 1]) return [sorted[0], sorted[0]];
    return dedupe(METHODS[mth](sorted, n));
  };

  /** Index of the class a value falls in (0-based), or -1. */
  classify.classOf = function (v, edges) {
    if (v === null || v === undefined || !isFinite(v) || !edges.length) return -1;
    if (v < edges[0] || v > edges[edges.length - 1]) return -1;
    for (let i = 1; i < edges.length; i++) if (v <= edges[i]) return i - 1;
    return edges.length - 2;
  };

  /** Short legend label for a class range. */
  classify.label = function (a, b, fmt) {
    const f = fmt || (M.util && M.util.formatNumber) || String;
    return f(a) + ' – ' + f(b);
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
