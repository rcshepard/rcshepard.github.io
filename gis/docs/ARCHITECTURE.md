# Architecture

PSICITS is a static web app: `index.html` loads vendored libraries, then PSICITS's own code, all as classic `<script>` tags. There is no bundler and no framework, and it works from `file://`. Everything hangs off one global namespace, `PSICITS` (written `M` inside files).

```
┌──────────────── UI (js/app/ui/*) ─────────────────┐
│ console · layers panel · table · toolbox · dialogs │   every action → a text command
└───────────────┬───────────────────────────────────┘
                │ M.app.run("buffer roads 500 m")
┌───────────────▼─────────────┐    parse    ┌──────────────────────┐
│ js/app/app.js  (runtime)    │───────────▶│ js/lib/commands.js   │
│ queue · context · output    │◀───────────│ verbs → typed args   │
└───────────────┬─────────────┘  {tool,args}└──────────────────────┘
                │ tool.run(args, ctx)
┌───────────────▼────────────────────────────────────────────┐
│ js/app/tools/*.js — the tool catalogue (~125 commands)      │
└──┬───────────┬──────────────┬───────────────┬──────────────┘
   │           │              │               │
┌──▼───────┐ ┌─▼──────────┐ ┌─▼───────────┐ ┌─▼──────────────┐
│ geoops   │ │ raster     │ │ formats/io  │ │ gdal (wasm)    │   js/lib — DOM-free
│ (Turf +  │ │ (typed     │ │ (readers/   │ │ ogr2ogr, warp… │   (tested in Node)
│ overlay) │ │ arrays)    │ │ writers)    │ │                │
└──┬───────┘ └─┬──────────┘ └─┬───────────┘ └─┬──────────────┘
   └───────────┴──────┬───────┴───────────────┘
              ┌───────▼──────────────┐  events   ┌───────────────────────┐
              │ js/lib/store.js      │─────────▶│ js/app/mapview.js     │
              │ layers · selection · │          │ MapLibre sources/     │
              │ undo/redo · project  │          │ layers, identify, …   │
              └──────────────────────┘          └───────────────────────┘
```

## Folders

| Path | What |
|---|---|
| `js/lib/` | DOM-free libraries: `core` (utils, units, GeoJSON helpers), `crs` (proj4 wrapper), `colors`, `classify`, `expr` (expression language), `formats` (WKT/WKB, GeoPackage, Shapefile/KML/GPX/CSV writers, XLSX reader, GeoTIFF writer), `geoops` (vector geoprocessing), `raster` (raster engine), `gdal` (gdal3.js bridge), `style` (symbology → MapLibre), `store` (project state), `commands` (the parser). |
| `js/app/` | Browser code: `mapview`, `io` (import/export), `app` (command runtime), `draw` (Terra Draw), `ui` (DOM toolkit), `tools/*` (the commands), `ui/*` (panels), `main` (bootstrap). |
| `vendor/` | Third-party libraries, pinned (see `vendor/versions.json`). |
| `tests/` | `node --test`. The harness loads the same files the browser does. |

## The command language

`js/lib/commands.js` turns a line of text into `{ tool, args }` without AI:

1. **Tokenize**: words, quoted strings, numbers (`500m` becomes a number plus a unit), `key=value` pairs and commas.
2. **Verb**: the longest match among tool names and aliases (`add field` beats `add`). Polite openers like "please" are skipped. Typos get "did you mean" suggestions.
3. **`key=value`** pairs fill parameters directly. A parameter's own name also works as a keyword (`units mi`).
4. **Keyword sections**: `where …`, `as …`, `by …` and so on. Each parameter declares its keywords. Expressions take the raw text up to the next keyword.
5. **Forms**: optional per-tool word orders such as `{eraser} from {layer}` or `[{layer}] (to|by|with) {clip}`, matched with backtracking.
6. **Typed slot filling** for everything else. Layer names are matched first (multi-word and fuzzy), then flags, enum words, numbers (with units), colors, color ramps, field names (resolved against the right layer), statistics (`sum pop`) and free text.
7. **Defaults and validation**: the active layer is used when a layer is missing. Geometry types are checked ("buffer needs …"). Missing values produce a usage line.

The same metadata drives autocomplete (`suggest()`), the canonical echo (`format()`, which re-parses to the same arguments), the toolbox forms, `help`, and `docs/COMMANDS.md`.

## Adding a command

Create or extend a file in `js/app/tools/`:

```js
(function (root) {
  const M = root.PSICITS, T = M.toolkit, P = T.P;
  T.define({
    name: 'square buffer', aliases: ['box buffer'], category: 'Vector',
    summary: 'Square buffers around points',
    params: [P.layer('layer', { geom: ['Point'] }), P.distance(), P.as()],
    forms: ['{layer} [by] {distance}'],
    examples: ['square buffer wells 100 m'],
    run: function (args, ctx) {
      const l = ctx.vector(args.layer);
      const d = ctx.meters(args.distance);
      const fc = { type: 'FeatureCollection', features: l.data.features.map(function (f) {
        const c = f.geometry.coordinates, dx = d / (111320 * Math.cos(c[1] * Math.PI / 180)), dy = d / 110540;
        return root.turf.bboxPolygon([c[0] - dx, c[1] - dy, c[0] + dx, c[1] + dy], { properties: f.properties });
      }) };
      ctx.result(fc, T.outName(ctx, args, l, 'squares'));
    },
  });
})(globalThis);
```

Add the script to `index.html` and to the file list in `tests/commands.test.js`, then run `node --test` and `node tools/gen-commands-doc.js`. The tests check every tool's examples, look for verb collisions, and confirm that canonical text round-trips.

Useful `ctx` members: `ctx.vector(id)`, `ctx.raster(id)`, `ctx.layer(id)`, `ctx.result(fc, name)` (adds a layer and reports it), `ctx.add(spec)`, `ctx.out.text/note/warn/table/kv/code`, `ctx.progress(msg)`, `ctx.confirm(msg)`, `ctx.run('other command')`, `ctx.store`, `ctx.map`, `ctx.io`.

## Data model

- **Vector layers** hold a GeoJSON FeatureCollection in EPSG:4326. The store assigns numeric feature ids. Data is treated as immutable: every change replaces `layer.data`, and unchanged feature objects are shared. That makes undo cheap, because history just keeps references.
- **Raster layers** use the Raster object described in [CONVENTIONS.md](CONVENTIONS.md): typed-array bands, a GDAL-style geotransform, and a native CRS. For display, `PSICITS.raster.render` warps to an axis-aligned Web Mercator image, which MapLibre draws as an image source.
- **Tile layers** are XYZ or WMS URL templates.

## Map rendering

`mapview.js` listens to store events and keeps MapLibre in sync. Each layer has one source (`src::L3`) and up to five style layers (`L3::fill`, `L3::outline`, `L3::line`, `L3::circle`, `L3::label`, or `L3::heat` / `L3::extrusion`), all generated by `PSICITS.style.toMapLibre`. The selection is drawn by a separate overlay source. Switching basemaps rebuilds every layer from the store.

## GDAL

`js/lib/gdal.js` runs gdal3.js inside its own Web Worker. It uses gdal3.js's non-worker build plus a small engine that calls GDAL's C API and the in-memory file system. Layers are materialised on demand: vectors become GeoJSON, and rasters become a lossless VRT over raw bands. Command-line arguments are parsed with per-program option tables so layer names can be used as datasets. Outputs become layers (GeoJSON, GeoTIFF) or downloads (other formats; multi-file formats are zipped).

## Testing

```
node --test                         # everything (~20 s)
node --test tests/commands.test.js  # just the parser and catalogue
```

The browser-level behaviour (map, drawing, GDAL worker, file:// mode) was checked with headless Chromium. See `CONTRIBUTING.md` for how to run that locally.
