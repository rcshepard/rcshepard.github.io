/*
 * PSICITS — colors, color ramps and categorical palettes (DOM-free).
 * Ramps are ColorBrewer (Cynthia Brewer, Apache-2.0 style license) and
 * matplotlib perceptual colormaps (CC0), sampled to hex stops.
 */
(function (root) {
  'use strict';

  const M = (root.PSICITS = root.PSICITS || {});

  const s = function (str) { return str.trim().split(/\s+/); };

  // Continuous ramps: array of evenly spaced stops, or [[pos, color], ...].
  const RAMPS = {
    // Sequential ramp built on UChicago Phoenix Maroon (#800000)
    maroon: s('#fbf4f4 #efd6d6 #deaeae #c97f7f #b04f4f #962020 #800000 #5c0000 #3d0000'),
    viridis: s('#440154 #482878 #3e4989 #31688e #26828e #1f9e89 #35b779 #6ece58 #b5de2b #fde725'),
    magma: s('#000004 #180f3d #440f76 #721f81 #9e2f7f #cd4071 #f1605d #fd9668 #feca8d #fcfdbf'),
    inferno: s('#000004 #1b0c41 #4a0c6b #781c6d #a52c60 #cf4446 #ed6925 #fb9b06 #f7d13d #fcffa4'),
    plasma: s('#0d0887 #46039f #7201a8 #9c179e #bd3786 #d8576b #ed7953 #fb9f3a #fdca26 #f0f921'),
    cividis: s('#00224e #123570 #3b496c #575d6d #707173 #8a8779 #a69d75 #c4b56c #e4cf5b #fee838'),
    turbo: s('#30123b #4145ab #4675ed #39a2fc #1bcfd4 #24eca6 #61fc6c #a4fc3b #d1e834 #f3c63a #fe9b2d #f36315 #d93806 #b11901 #7a0402'),
    blues: s('#f7fbff #deebf7 #c6dbef #9ecae1 #6baed6 #4292c6 #2171b5 #08519c #08306b'),
    greens: s('#f7fcf5 #e5f5e0 #c7e9c0 #a1d99b #74c476 #41ab5d #238b45 #006d2c #00441b'),
    reds: s('#fff5f0 #fee0d2 #fcbba1 #fc9272 #fb6a4a #ef3b2c #cb181d #a50f15 #67000d'),
    oranges: s('#fff5eb #fee6ce #fdd0a2 #fdae6b #fd8d3c #f16913 #d94801 #a63603 #7f2704'),
    purples: s('#fcfbfd #efedf5 #dadaeb #bcbddc #9e9ac8 #807dba #6a51a3 #54278f #3f007d'),
    greys: s('#ffffff #f0f0f0 #d9d9d9 #bdbdbd #969696 #737373 #525252 #252525 #000000'),
    ylorrd: s('#ffffcc #ffeda0 #fed976 #feb24c #fd8d3c #fc4e2a #e31a1c #bd0026 #800026'),
    ylorbr: s('#ffffe5 #fff7bc #fee391 #fec44f #fe9929 #ec7014 #cc4c02 #993404 #662506'),
    ylgnbu: s('#ffffd9 #edf8b1 #c7e9b4 #7fcdbb #41b6c4 #1d91c0 #225ea8 #253494 #081d58'),
    ylgn: s('#ffffe5 #f7fcb9 #d9f0a3 #addd8e #78c679 #41ab5d #238443 #006837 #004529'),
    orrd: s('#fff7ec #fee8c8 #fdd49e #fdbb84 #fc8d59 #ef6548 #d7301f #b30000 #7f0000'),
    bupu: s('#f7fcfd #e0ecf4 #bfd3e6 #9ebcda #8c96c6 #8c6bb1 #88419d #810f7c #4d004b'),
    rdpu: s('#fff7f3 #fde0dd #fcc5c0 #fa9fb5 #f768a1 #dd3497 #ae017e #7a0177 #49006a'),
    pubugn: s('#fff7fb #ece2f0 #d0d1e6 #a6bddb #67a9cf #3690c0 #02818a #016c59 #014636'),
    rdylgn: s('#a50026 #d73027 #f46d43 #fdae61 #fee08b #ffffbf #d9ef8b #a6d96a #66bd63 #1a9850 #006837'),
    rdylbu: s('#a50026 #d73027 #f46d43 #fdae61 #fee090 #ffffbf #e0f3f8 #abd9e9 #74add1 #4575b4 #313695'),
    rdbu: s('#67001f #b2182b #d6604d #f4a582 #fddbc7 #f7f7f7 #d1e5f0 #92c5de #4393c3 #2166ac #053061'),
    spectral: s('#9e0142 #d53e4f #f46d43 #fdae61 #fee08b #ffffbf #e6f598 #abdda4 #66c2a5 #3288bd #5e4fa2'),
    piyg: s('#8e0152 #c51b7d #de77ae #f1b6da #fde0ef #f7f7f7 #e6f5d0 #b8e186 #7fbc41 #4d9221 #276419'),
    brbg: s('#543005 #8c510a #bf812d #dfc27d #f6e8c3 #f5f5f5 #c7eae5 #80cdc1 #35978f #01665e #003c30'),
    puor: s('#7f3b08 #b35806 #e08214 #fdb863 #fee0b6 #f7f7f7 #d8daeb #b2abd2 #8073ac #542788 #2d004b'),
    prgn: s('#40004b #762a83 #9970ab #c2a5cf #e7d4e8 #f7f7f7 #d9f0d3 #a6dba0 #5aae61 #1b7837 #00441b'),
    terrain: [[0, '#333399'], [0.15, '#0099ff'], [0.25, '#00cc66'], [0.5, '#ffff99'], [0.75, '#805c54'], [1, '#ffffff']],
    elevation: s('#1a9850 #91cf60 #d9ef8b #fee08b #fdae61 #a0522d #8c6d62 #ffffff'),
    ndvi: s('#a50026 #d73027 #f46d43 #fdae61 #ffffbf #d9ef8b #a6d96a #66bd63 #1a9850 #006837'),
    bathymetry: s('#08306b #08519c #2171b5 #4292c6 #6baed6 #9ecae1 #c6dbef'),
    hot: s('#000000 #7a0000 #e60000 #ff6a00 #ffd200 #ffff80 #ffffff'),
    heat: s('#2c7bb6 #abd9e9 #ffffbf #fdae61 #d7191c'),
    ice: s('#040613 #292851 #3f4b96 #427bb7 #61a8c7 #9cd4da #eafdfd'),
    gray: s('#000000 #ffffff'),
  };

  const RAMP_ALIASES = {
    maroons: 'maroon', uchicago: 'maroon', phoenix: 'maroon',
    grey: 'greys', grays: 'greys', grayscale: 'gray', greyscale: 'gray', bw: 'gray',
    blue: 'blues', green: 'greens', red: 'reds', orange: 'oranges', purple: 'purples',
    'yl-or-rd': 'ylorrd', 'yellow-red': 'ylorrd', 'yl-gn-bu': 'ylgnbu', 'rd-yl-gn': 'rdylgn', 'red-green': 'rdylgn',
    'rd-yl-bu': 'rdylbu', 'red-blue': 'rdbu', 'rd-bu': 'rdbu', dem: 'elevation', hypsometric: 'elevation', topo: 'terrain',
    rainbow: 'turbo', jet: 'turbo', thermal: 'inferno', fire: 'hot', water: 'bathymetry', depth: 'bathymetry',
  };

  // Categorical palettes.
  const PALETTES = {
    tableau10: s('#4e79a7 #f28e2b #e15759 #76b7b2 #59a14f #edc948 #b07aa1 #ff9da7 #9c755f #bab0ac'),
    // UChicago-inspired: Phoenix Maroon, Goldenrod, Ivy, Dark Greystone + complementary hues
    uchicago: s('#800000 #eaaa00 #789d4a #155f83 #c16622 #59315f #737373 #3e7c8f #a8826d #350e20'),
    bold: s('#7f3c8d #11a579 #3969ac #f2b701 #e73f74 #80ba5a #e68310 #008695 #cf1c90 #f97b72 #4b4b8f #a5aa99'),
    set1: s('#e41a1c #377eb8 #4daf4a #984ea3 #ff7f00 #ffff33 #a65628 #f781bf #999999'),
    set2: s('#66c2a5 #fc8d62 #8da0cb #e78ac3 #a6d854 #ffd92f #e5c494 #b3b3b3'),
    set3: s('#8dd3c7 #ffffb3 #bebada #fb8072 #80b1d3 #fdb462 #b3de69 #fccde5 #d9d9d9 #bc80bd #ccebc5 #ffed6f'),
    dark2: s('#1b9e77 #d95f02 #7570b3 #e7298a #66a61e #e6ab02 #a6761d #666666'),
    paired: s('#a6cee3 #1f78b4 #b2df8a #33a02c #fb9a99 #e31a1c #fdbf6f #ff7f00 #cab2d6 #6a3d9a #ffff99 #b15928'),
    pastel: s('#fbb4ae #b3cde3 #ccebc5 #decbe4 #fed9a6 #ffffcc #e5d8bd #fddaec #f2f2f2'),
  };

  // Colours handed to new layers (UChicago-inspired: maroon first).
  const LAYER_COLORS = s('#800000 #155f83 #eaaa00 #789d4a #c16622 #59315f #737373 #3e7c8f #a4343a #58593f');

  const NAMED = (function () {
    const list = ('aliceblue f0f8ff antiquewhite faebd7 aqua 00ffff aquamarine 7fffd4 azure f0ffff beige f5f5dc bisque ffe4c4 black 000000 ' +
      'blanchedalmond ffebcd blue 0000ff blueviolet 8a2be2 brown a52a2a burlywood deb887 cadetblue 5f9ea0 chartreuse 7fff00 chocolate d2691e ' +
      'coral ff7f50 cornflowerblue 6495ed cornsilk fff8dc crimson dc143c cyan 00ffff darkblue 00008b darkcyan 008b8b darkgoldenrod b8860b ' +
      'darkgray a9a9a9 darkgreen 006400 darkgrey a9a9a9 darkkhaki bdb76b darkmagenta 8b008b darkolivegreen 556b2f darkorange ff8c00 ' +
      'darkorchid 9932cc darkred 8b0000 darksalmon e9967a darkseagreen 8fbc8f darkslateblue 483d8b darkslategray 2f4f4f darkslategrey 2f4f4f ' +
      'darkturquoise 00ced1 darkviolet 9400d3 deeppink ff1493 deepskyblue 00bfff dimgray 696969 dimgrey 696969 dodgerblue 1e90ff ' +
      'firebrick b22222 floralwhite fffaf0 forestgreen 228b22 fuchsia ff00ff gainsboro dcdcdc ghostwhite f8f8ff gold ffd700 goldenrod daa520 ' +
      'gray 808080 green 008000 greenyellow adff2f grey 808080 honeydew f0fff0 hotpink ff69b4 indianred cd5c5c indigo 4b0082 ivory fffff0 ' +
      'khaki f0e68c lavender e6e6fa lavenderblush fff0f5 lawngreen 7cfc00 lemonchiffon fffacd lightblue add8e6 lightcoral f08080 ' +
      'lightcyan e0ffff lightgoldenrodyellow fafad2 lightgray d3d3d3 lightgreen 90ee90 lightgrey d3d3d3 lightpink ffb6c1 lightsalmon ffa07a ' +
      'lightseagreen 20b2aa lightskyblue 87cefa lightslategray 778899 lightslategrey 778899 lightsteelblue b0c4de lightyellow ffffe0 ' +
      'lime 00ff00 limegreen 32cd32 linen faf0e6 magenta ff00ff maroon 800000 mediumaquamarine 66cdaa mediumblue 0000cd mediumorchid ba55d3 ' +
      'mediumpurple 9370db mediumseagreen 3cb371 mediumslateblue 7b68ee mediumspringgreen 00fa9a mediumturquoise 48d1cc ' +
      'mediumvioletred c71585 midnightblue 191970 mintcream f5fffa mistyrose ffe4e1 moccasin ffe4b5 navajowhite ffdead navy 000080 ' +
      'oldlace fdf5e6 olive 808000 olivedrab 6b8e23 orange ffa500 orangered ff4500 orchid da70d6 palegoldenrod eee8aa palegreen 98fb98 ' +
      'paleturquoise afeeee palevioletred db7093 papayawhip ffefd5 peachpuff ffdab9 peru cd853f pink ffc0cb plum dda0dd powderblue b0e0e6 ' +
      'purple 800080 rebeccapurple 663399 red ff0000 rosybrown bc8f8f royalblue 4169e1 saddlebrown 8b4513 salmon fa8072 sandybrown f4a460 ' +
      'seagreen 2e8b57 seashell fff5ee sienna a0522d silver c0c0c0 skyblue 87ceeb slateblue 6a5acd slategray 708090 slategrey 708090 ' +
      'snow fffafa springgreen 00ff7f steelblue 4682b4 tan d2b48c teal 008080 thistle d8bfd8 tomato ff6347 turquoise 40e0d0 violet ee82ee ' +
      'wheat f5deb3 white ffffff whitesmoke f5f5f5 yellow ffff00 yellowgreen 9acd32').split(' ');
    const m = Object.create(null);
    for (let i = 0; i < list.length; i += 2) m[list[i]] = '#' + list[i + 1];
    return m;
  })();

  const colors = (M.colors = {});
  colors.RAMPS = RAMPS;
  colors.PALETTES = PALETTES;
  colors.NAMED = NAMED;
  colors.rampNames = function () { return Object.keys(RAMPS); };
  colors.paletteNames = function () { return Object.keys(PALETTES); };

  /** Resolve a ramp name (with aliases, optional "-r"/"reverse" suffix). Returns stops or null. */
  colors.getRamp = function (name) {
    if (Array.isArray(name)) return name;
    if (!name) return null;
    let n = String(name).toLowerCase().trim().replace(/\s+/g, '-');
    let reverse = false;
    const rm = /^(.*?)(?:[-_ ]?(?:r|rev|reverse|reversed|inverted))$/.exec(n);
    if (rm && (RAMPS[rm[1]] || RAMP_ALIASES[rm[1]])) { n = rm[1]; reverse = true; }
    if (RAMP_ALIASES[n]) n = RAMP_ALIASES[n];
    const r = RAMPS[n];
    if (!r) return null;
    if (!reverse) return r;
    if (Array.isArray(r[0])) return r.map(function (st) { return [1 - st[0], st[1]]; }).reverse();
    return r.slice().reverse();
  };
  colors.isRamp = function (name) { return !!colors.getRamp(name); };

  /** Parse a CSS-ish color to [r, g, b, a] (0-255, a 0-1). Returns null if invalid. */
  colors.parse = function (c) {
    if (c === null || c === undefined) return null;
    if (Array.isArray(c)) return [c[0], c[1], c[2], c.length > 3 ? c[3] : 1];
    let str = String(c).trim().toLowerCase();
    if (NAMED[str]) str = NAMED[str];
    if (str === 'transparent') return [0, 0, 0, 0];
    let m = /^#?([0-9a-f]{3,8})$/.exec(str);
    if (m && (str[0] === '#' || /^[0-9a-f]{6}$/.test(m[1]))) {
      let h = m[1];
      if (h.length === 3 || h.length === 4) h = h.split('').map(function (x) { return x + x; }).join('');
      if (h.length !== 6 && h.length !== 8) return null;
      const n = parseInt(h.slice(0, 6), 16);
      const a = h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1;
      return [(n >> 16) & 255, (n >> 8) & 255, n & 255, a];
    }
    m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+%?))?\s*\)$/.exec(str);
    if (m) {
      let a = m[4] === undefined ? 1 : m[4].endsWith('%') ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
      return [+m[1], +m[2], +m[3], a];
    }
    m = /^hsla?\(\s*([\d.]+)(?:deg)?[\s,]+([\d.]+)%[\s,]+([\d.]+)%(?:[\s,/]+([\d.]+%?))?\s*\)$/.exec(str);
    if (m) {
      const rgb = hslToRgb(+m[1] / 360, +m[2] / 100, +m[3] / 100);
      let a = m[4] === undefined ? 1 : m[4].endsWith('%') ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
      return [rgb[0], rgb[1], rgb[2], a];
    }
    return null;
  };

  colors.isColor = function (c) { return colors.parse(c) !== null; };

  function hex2(n) { const h = Math.max(0, Math.min(255, Math.round(n))).toString(16); return h.length === 1 ? '0' + h : h; }

  /** [r, g, b] -> "#rrggbb" */
  colors.toHex = function (rgb) {
    const c = Array.isArray(rgb) ? rgb : colors.parse(rgb);
    if (!c) return null;
    return '#' + hex2(c[0]) + hex2(c[1]) + hex2(c[2]);
  };

  /** Normalise any color to "#rrggbb" (alpha dropped); null if invalid. */
  colors.normalize = function (c) { return colors.toHex(colors.parse(c)); };

  function hslToRgb(h, s2, l) {
    if (s2 === 0) return [l * 255, l * 255, l * 255];
    const q = l < 0.5 ? l * (1 + s2) : l + s2 - l * s2;
    const p = 2 * l - q;
    const f = function (t) {
      if (t < 0) t += 1; if (t > 1) t -= 1;
      if (t < 1 / 6) return p + (q - p) * 6 * t;
      if (t < 1 / 2) return q;
      if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
      return p;
    };
    return [f(h + 1 / 3) * 255, f(h) * 255, f(h - 1 / 3) * 255];
  }
  colors.hsl = function (h, s2, l) { return colors.toHex(hslToRgb(h, s2, l)); };

  function stopsOf(ramp) {
    const r = colors.getRamp(ramp) || RAMPS.viridis;
    if (Array.isArray(r[0])) return r.map(function (st) { return [st[0], colors.parse(st[1])]; });
    return r.map(function (c, i) { return [r.length === 1 ? 0 : i / (r.length - 1), colors.parse(c)]; });
  }

  /** Interpolated [r,g,b] at t in [0,1] along a ramp. */
  colors.rampRGB = function (ramp, t) {
    const st = Array.isArray(ramp) && Array.isArray(ramp[0]) && Array.isArray(ramp[0][1]) ? ramp : stopsOf(ramp);
    if (!(t >= 0)) t = 0; // NaN-safe
    if (t > 1) t = 1;
    for (let i = 1; i < st.length; i++) {
      if (t <= st[i][0]) {
        const a = st[i - 1], b = st[i];
        const u = b[0] === a[0] ? 0 : (t - a[0]) / (b[0] - a[0]);
        return [a[1][0] + (b[1][0] - a[1][0]) * u, a[1][1] + (b[1][1] - a[1][1]) * u, a[1][2] + (b[1][2] - a[1][2]) * u];
      }
    }
    const last = st[st.length - 1][1];
    return [last[0], last[1], last[2]];
  };

  /** Hex color at t in [0,1]. */
  colors.rampColor = function (ramp, t) { return colors.toHex(colors.rampRGB(ramp, t)); };

  /**
   * Pre-computed 256-entry RGB lookup table (Uint8Array of length 768),
   * handy for fast raster rendering.
   */
  colors.rampLUT = function (ramp) {
    const st = stopsOf(ramp);
    const lut = new Uint8Array(256 * 3);
    for (let i = 0; i < 256; i++) {
      const c = colors.rampRGB(st, i / 255);
      lut[i * 3] = Math.round(c[0]); lut[i * 3 + 1] = Math.round(c[1]); lut[i * 3 + 2] = Math.round(c[2]);
    }
    return lut;
  };

  /** n evenly spaced colors from a ramp (hex). */
  colors.sampleRamp = function (ramp, n) {
    const out = [];
    if (n <= 1) return [colors.rampColor(ramp, 0.5)];
    for (let i = 0; i < n; i++) out.push(colors.rampColor(ramp, i / (n - 1)));
    return out;
  };

  /** n distinct categorical colors; extends past the palette with golden-angle hues. */
  colors.categorical = function (n, palette) {
    const p = PALETTES[String(palette || 'tableau10').toLowerCase()] || PALETTES.tableau10;
    const out = [];
    for (let i = 0; i < n; i++) {
      if (i < p.length) out.push(p[i]);
      else out.push(colors.hsl(((i * 137.508) % 360) / 360, 0.55, i % 2 ? 0.45 : 0.6));
    }
    return out;
  };

  let layerColorIdx = 0;
  /** Next default colour for a new layer. */
  colors.nextLayerColor = function () {
    const c = LAYER_COLORS[layerColorIdx % LAYER_COLORS.length];
    layerColorIdx++;
    return c;
  };

  /** Lighter/darker variant: amount in [-1, 1]. */
  colors.shade = function (c, amount) {
    const rgb = colors.parse(c);
    if (!rgb) return c;
    const t = amount < 0 ? 0 : 255;
    const p = Math.abs(amount);
    return colors.toHex([rgb[0] + (t - rgb[0]) * p, rgb[1] + (t - rgb[1]) * p, rgb[2] + (t - rgb[2]) * p]);
  };

  /** CSS linear-gradient() string for a ramp preview. */
  colors.gradientCSS = function (ramp, dir) {
    const st = stopsOf(ramp);
    return 'linear-gradient(' + (dir || 'to right') + ', ' + st.map(function (x) {
      return colors.toHex(x[1]) + ' ' + Math.round(x[0] * 100) + '%';
    }).join(', ') + ')';
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
