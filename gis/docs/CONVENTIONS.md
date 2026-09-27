# PSICITS code conventions

PSICITS is a browser GIS with **no build step**: plain `<script>` tags, no
bundler, no ES modules, no npm install needed to run it. It must work when
`index.html` is opened straight from disk (`file://`) as well as from any static
web server (GitHub Pages, `python -m http.server`, …).

## Layout

```
index.html            loads vendor libs, then js/lib/*, then js/app/*
css/                  styles
js/lib/               DOM-free libraries (run in browser, workers and Node)
js/app/               browser application (DOM, MapLibre, UI)
vendor/               third-party libraries, pinned, with their licenses
tests/                node:test unit tests (zero dependencies)
docs/                 documentation
```

## Module pattern

Every file is an IIFE that attaches to the global `PSICITS` namespace:

```js
(function (root) {
  'use strict';
  const M = (root.PSICITS = root.PSICITS || {});
  const util = M.util;               // from core.js

  function somethingPrivate() {}

  M.mything = {
    /** JSDoc for public functions. */
    doStuff(fc, opts) { /* ... */ },
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
```

* `js/lib/` files **must not touch the DOM** (`document`, `window`-only APIs,
  `DOMParser`, canvas). They may use `globalThis.fetch` only inside async
  functions and only where documented. This keeps them testable in Node and
  usable inside Web Workers.
* Refer to vendored libraries through their globals at call time (e.g.
  `turf.buffer(...)`, `proj4(...)`, `new RBush()`), not at file load time.
* ES2020 syntax is fine (const/let, arrow functions, classes, async/await,
  optional chaining). No `import`/`export`.
* 2-space indent, single quotes, semicolons.
* Never mutate inputs. Return new objects; shallow-copy `properties` before
  changing them.
* Throw `Error`s with messages written for end users — they are shown verbatim
  in the command console (e.g. `Layer "roads" has no polygons to clip with`).

## Vendored globals

| Global | Library | Notes |
|---|---|---|
| `maplibregl` | MapLibre GL JS 5.24 | app only |
| `turf` | Turf 7.4 | v7 API: `turf.intersect(featureCollection([a, b]))`, `turf.union(fc)`, `turf.difference(fc)` |
| `RBush` | rbush 4 | spatial index |
| `proj4` | proj4js 2.22 | use `PSICITS.crs` rather than calling directly |
| `JSZip` | JSZip 3.10 | |
| `GeoTIFF` | geotiff.js 3.0.5 | `GeoTIFF.fromArrayBuffer`, `GeoTIFF.writeArrayBuffer` |
| `shp` | shpjs 6.2 | shapefile reader |
| `toGeoJSON` | @tmcw/togeojson 7 | KML/GPX reader (needs DOMParser → app only) |
| `Papa` | PapaParse 5.7 | CSV |
| `initSqlJs` | sql.js 1.14 | GeoPackage; wasm in `vendor/sqljs` |
| `topojson` | topojson-client 3 | |
| `osmtogeojson` | osmtogeojson 3 | Overpass → GeoJSON |
| `flatgeobuf` | flatgeobuf 4.5 | |
| `terraDraw`, `terraDrawMaplibreGlAdapter` | Terra Draw 1.35 | app only |
| `initGdalJs` | gdal3.js 2.8.1 (LGPL) | lazy-loaded, see `js/lib/gdal.js` |

## Data model

### Vector data

* GeoJSON `FeatureCollection`, coordinates in **EPSG:4326** (lon, lat).
* A feature's `geometry` may be `null` (attribute-only rows, e.g. a CSV without
  coordinates that will be joined to polygons).
* `properties` is always a plain object.
* Feature `id`s are assigned by the app's layer store. Library functions must
  not depend on ids and should not copy input ids to outputs.

### Raster data

```js
Raster = {
  width, height,                 // pixels
  bands: [TypedArray, ...],      // one per band, length width*height, row-major from the top-left
  bandNames: ['b1', ...],
  noData: number | null,
  crs: 'EPSG:32616',             // any code PSICITS.crs understands (or a WKT/proj4 key)
  transform: [x0, dx, 0, y0, 0, dy], // GDAL-style geotransform in CRS units, north-up (dy < 0)
  bbox: [minX, minY, maxX, maxY],    // in raster CRS
  dataType: 'uint8' | 'int16' | 'uint16' | 'int32' | 'uint32' | 'float32' | 'float64',
  stats: null | [{ min, max, mean, std, count, p2, p98 }],  // per band, see PSICITS.raster.stats
  meta: {},                      // free-form: source name, downsample factor, ...
}
```

Pixel (col, row) covers `x ∈ [x0 + col*dx, x0 + (col+1)*dx]`,
`y ∈ [y0 + (row+1)*dy, y0 + row*dy]` (for dy < 0).

### Units

Distances are meters unless a `units` option says otherwise. Use
`PSICITS.util.toMeters / fromMeters / normalizeUnit / turfUnits`.

## Tests

* `tests/<area>.test.js`, using `node:test` and `node:assert/strict`.
* Load code through the harness: `const M = require('./harness').load('geoops');`
* Keep tests fast (< 5 s per file) and deterministic (seed any randomness).
* Run everything from the repo root with `node --test` (or `npm test`).
