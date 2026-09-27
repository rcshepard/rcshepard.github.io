/*
 * PSICITS — GDAL command line (gdal3.js, WebAssembly, loaded on first use).
 */
(function (root) {
  'use strict';

  const M = root.PSICITS;
  const util = M.util;
  const T = M.toolkit;
  const def = T.define;

  // Files produced by earlier GDAL commands, so they can be used as inputs.
  const outputs = new Map();
  T.gdalOutputs = outputs;

  const SUMMARIES = {
    ogr2ogr: 'Convert / reproject / filter vector data (SQL with SpatiaLite via -dialect SQLite)',
    ogrinfo: 'Describe a vector dataset',
    gdal_translate: 'Convert raster formats, subset bands/windows, rescale',
    gdalwarp: 'Reproject, resample or clip rasters (-cutline <layer>)',
    gdal_rasterize: 'Burn vector features into a raster',
    gdalinfo: 'Describe a raster dataset',
    gdal_location_info: 'Raster values at a coordinate',
    gdaltransform: 'Transform coordinates between CRSs',
    gdaldem: 'Hillshade, slope, aspect, color-relief, TRI, TPI, roughness',
    gdalbuildvrt: 'Mosaic rasters into a virtual raster',
  };

  const EXAMPLES = {
    ogr2ogr: ['ogr2ogr -f GPKG roads.gpkg roads', 'ogr2ogr -t_srs EPSG:3435 -f "ESRI Shapefile" roads_il.shp roads', 'ogr2ogr -dialect SQLite -sql "SELECT ST_Buffer(geometry, 0.001) AS geometry, * FROM roads" roads_buf roads', 'ogr2ogr -where "population > 1000000" big_cities cities'],
    gdalwarp: ['gdalwarp -t_srs EPSG:3857 -r bilinear dem dem_3857.tif', 'gdalwarp -cutline city -crop_to_cutline dem dem_city.tif'],
    gdal_translate: ['gdal_translate -of PNG dem dem.png', 'gdal_translate -b 1 -b 2 -b 3 image rgb.tif'],
    gdal_rasterize: ['gdal_rasterize -a population -tr 0.01 0.01 counties pop.tif'],
    gdaldem: ['gdaldem hillshade dem shade.tif', 'gdaldem slope dem slope.tif'],
    gdalinfo: ['gdalinfo dem'],
    ogrinfo: ['ogrinfo -so roads'],
  };

  function resolver(ctx) {
    return function (name) {
      const l = ctx.store.get(name);
      if (l && l.type === 'vector') return { kind: 'vector', name: l.name, fc: l.data };
      if (l && l.type === 'raster') return { kind: 'raster', name: l.name, raster: l.raster };
      const f = outputs.get(String(name)) || outputs.get(String(name).toLowerCase());
      if (f) return { kind: 'file', name: f.filename, bytes: f.bytes };
      return null;
    };
  }

  async function runGdal(program, rest, ctx) {
    if (!M.gdal.isLoaded()) ctx.progress('Loading GDAL (about 40 MB, first time only)…');
    await M.gdal.load({ onStatus: function (s) { ctx.progress(typeof s === 'string' ? s : (s && s.message) || 'Loading GDAL…'); } });
    ctx.progress('Running ' + program + '…');
    const res = await M.gdal.execute(program + ' ' + rest, {
      resolve: resolver(ctx),
      names: ctx.store.layers.map(function (l) { return l.name; }).concat(Array.from(outputs.keys())),
      onLog: function (line) { if (line && /warning/i.test(line)) ctx.out.warn(line); },
    });
    (res.logs || []).forEach(function (l) { if (typeof l === 'string' && l.trim()) ctx.out.note(l.trim()); });
    if (res.text) ctx.out.code(res.text);
    const layerNames = new Set();
    (res.layers || []).forEach(function (L) {
      let layer;
      if (L.kind === 'raster') layer = ctx.add({ type: 'raster', name: ctx.name(L.name), raster: L.raster, source: { kind: 'gdal', command: program + ' ' + rest } }, { verb: 'Created' });
      else layer = ctx.result(L.fc, ctx.name(L.name));
      layerNames.add(util.slug(L.name));
    });
    const files = (res.outputs || []).filter(function (o) { return o.bytes; });
    files.forEach(function (o) {
      outputs.set(o.filename, o);
      outputs.set(o.filename.toLowerCase(), o);
      const asLayer = (res.layers || []).some(function (L) { return util.slug(L.name) === util.slug(o.filename.replace(/\.[^.]+$/, '')); });
      ctx.out.download(o.filename, o.bytes);
      if (!asLayer) M.io.download(new Blob([o.bytes]), o.filename);
    });
    if (!res.text && !(res.layers || []).length && !files.length) return program + ' finished';
  }

  M.gdal && (M.gdal.programs || []).forEach(function (program) {
    def({
      name: program, category: 'GDAL', raw: true, summary: SUMMARIES[program] || 'GDAL ' + program,
      params: [{ name: 'args', type: 'rest', required: false, description: 'Arguments as on the command line. Use layer names as datasets.' }],
      completions: ['-f', '-of', '-t_srs', '-s_srs', '-a_srs', '-sql', '-dialect SQLite', '-where', '-nln', '-clipsrc', '-cutline', '-crop_to_cutline', '-tr', '-te', '-r bilinear', '-co', '-lco', '-b', '-a', '-burn', '-json', '--map', '--download', '--help'],
      examples: EXAMPLES[program] || [],
      run: function (args, ctx) {
        if (!args.args || /^\s*(--help|-h|help)\s*$/.test(args.args)) { ctx.out.text(M.gdal.help(program)); return; }
        return runGdal(program, args.args, ctx);
      },
    });
  });

  def({
    name: 'gdal', aliases: ['gdal help'], category: 'GDAL', summary: 'GDAL status, formats and help (gdal formats · gdal load · gdal help)',
    params: [T.P.choice('what', ['help', 'formats', 'load', 'version', 'files'], { default: 'help', aliases: { drivers: 'formats', info: 'version', outputs: 'files' } })],
    noHistory: true,
    run: async function (args, ctx) {
      if (args.what === 'help') { ctx.out.text(M.gdal.help()); return; }
      if (args.what === 'files') {
        const seen = new Set();
        const rows = [];
        outputs.forEach(function (o) { if (seen.has(o.filename)) return; seen.add(o.filename); rows.push({ file: o.filename, size: util.formatBytes(o.bytes.length), kind: o.kind }); });
        if (!rows.length) return 'No GDAL output files yet';
        ctx.out.table(rows);
        return;
      }
      ctx.progress('Loading GDAL…');
      const info = await M.gdal.load({});
      if (args.what === 'load' || args.what === 'version') return 'GDAL ready (' + (info.mode || '') + ', ' + (info.source || '') + ')';
      const d = M.gdal.drivers();
      ctx.out.text('Vector drivers (' + d.vector.length + '):');
      ctx.out.table(d.vector.map(function (x) { return { name: x.name, description: x.longName, write: x.canWrite ? 'yes' : '' }; }));
      ctx.out.text('Raster drivers (' + d.raster.length + '):');
      ctx.out.table(d.raster.map(function (x) { return { name: x.name, description: x.longName, write: x.canWrite ? 'yes' : '' }; }));
    },
  });
})(typeof globalThis !== 'undefined' ? globalThis : this);
