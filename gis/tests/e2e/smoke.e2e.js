#!/usr/bin/env node
/*
 * Browser smoke test (optional; needs Playwright):
 *
 *   npm i -D playwright && npx playwright install chromium
 *   node tests/e2e/smoke.e2e.js            # add --headed to watch
 *
 * Starts tools/serve.js, runs a tour of commands that need no internet, and
 * fails on any failed command or page error.
 */
'use strict';
const path = require('path');
const { spawn } = require('child_process');

let chromium;
try { chromium = require('playwright').chromium; } catch (e) {
  console.error('Playwright is not installed. Run: npm i -D playwright && npx playwright install chromium');
  process.exit(2);
}

const ROOT = path.resolve(__dirname, '..', '..');
const PORT = 8123;

const COMMANDS = [
  'zoom to 41.8, -87.65', 'zoom 10',
  'random 300 points seed 7 as pts',
  'calc pts val = rand(1, 100)',
  "calc pts cls = CASE WHEN val > 50 THEN 'high' ELSE 'low' END",
  'grid hex 3 km over pts as hexes',
  'count pts in hexes as counts',
  'color counts by pts_count 5 quantile ylorrd',
  'label counts pts_count size 10',
  'color pts by cls categories',
  'select pts where val > 90',
  'buffer pts 1 km selected dissolve as hot',
  'dissolve counts by pts_count',
  'centroids counts',
  'nearest pts to counts_centroids',
  'spatial join pts with counts fields pts_count',
  'voronoi pts clip hexes',
  'stats pts val by cls',
  'undo', 'redo',
  "js const w=120,h=100,b=new Float32Array(w*h); for(let y=0;y<h;y++)for(let x=0;x<w;x++){const dx=(x-60)/25,dy=(y-50)/20; b[y*w+x]=300*Math.exp(-(dx*dx+dy*dy));} add(M.raster.create({width:w,height:h,bands:[b],bbox:[-87.8,41.7,-87.5,41.9],crs:'EPSG:4326'}),'dem')",
  'color dem terrain', 'hillshade dem', 'contours dem 50', 'zonal dem by hexes stats mean max',
  'bandmath dem = b1 * 3.28084 as dem_ft', 'reclassify dem 0-100:1, 100-200:2, >200:3 as zones',
  'ogrinfo -so pts',
  'ogr2ogr pts_buf pts -dialect SQLite -sql "SELECT ST_Buffer(geometry, 0.003) AS geometry, val FROM pts"',
  'gdalwarp -t_srs EPSG:3857 dem dem_3857.tif',
  'export pts as shapefile', 'export pts as gpkg', 'export dem as geotiff',
  'basemap none-dark', 'basemap none',
  'layers',
];

(async function main() {
  const server = spawn(process.execPath, [path.join(ROOT, 'tools', 'serve.js'), String(PORT)], { stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise(function (r) { server.stdout.once('data', r); });
  const browser = await chromium.launch({ headless: process.argv.indexOf('--headed') < 0 });
  const page = await (await browser.newContext({ viewport: { width: 1400, height: 900 }, acceptDownloads: true })).newPage();
  const problems = [];
  page.on('pageerror', function (e) { problems.push('page error: ' + e.message); });
  try {
    await page.goto('http://127.0.0.1:' + PORT + '/index.html');
    await page.waitForFunction(function () { return document.documentElement.classList.contains('ps-ready'); }, null, { timeout: 30000 });
    for (const cmd of COMMANDS) {
      const r = await page.evaluate(async function (c) { const r = await PSICITS.app.run(c); return { ok: r.ok, error: r.error || null }; }, cmd);
      console.log((r.ok ? '  ok   ' : '  FAIL ') + cmd + (r.error ? '  → ' + r.error : ''));
      if (!r.ok) problems.push(cmd + ': ' + r.error);
    }
    // wait for the basemap switch to finish
    for (let i = 0; i < 60; i++) {
      const ready = await page.evaluate(function () { return !!(PSICITS.mapview.ready && PSICITS.mapview.map.getStyle()); });
      if (ready) break;
      await page.waitForTimeout(500);
    }
    const n = await page.evaluate(function () { return PSICITS.mapview.map.getStyle().layers.filter(function (l) { return l.id.indexOf('::') > 0 && l.id.indexOf('__') !== 0; }).length; });
    if (n < 10) problems.push('expected map layers after the basemap switch, found ' + n);
  } finally {
    await browser.close();
    server.kill();
  }
  if (problems.length) { console.error('\n' + problems.length + ' problem(s):\n' + problems.join('\n')); process.exit(1); }
  console.log('\nAll ' + COMMANDS.length + ' commands passed.');
})().catch(function (e) { console.error(e); process.exit(1); });
