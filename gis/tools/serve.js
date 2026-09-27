#!/usr/bin/env node
/*
 * Tiny zero-dependency static server for PSICITS (optional).
 *
 *   node tools/serve.js            → http://localhost:8000
 *   node tools/serve.js 3000
 *
 * Opening index.html directly also works; serving over http additionally lets
 * GDAL use its local WebAssembly copy in a background worker.
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.argv[2] || process.env.PORT || 8000);
const HOST = process.env.HOST || '127.0.0.1';

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.geojson': 'application/geo+json', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon', '.wasm': 'application/wasm', '.data': 'application/octet-stream',
  '.tif': 'image/tiff', '.tiff': 'image/tiff', '.zip': 'application/zip', '.csv': 'text/csv', '.kml': 'application/vnd.google-earth.kml+xml',
  '.gpx': 'application/gpx+xml', '.md': 'text/markdown; charset=utf-8', '.txt': 'text/plain; charset=utf-8', '.gpkg': 'application/geopackage+sqlite3',
};

const server = http.createServer(function (req, res) {
  let rel;
  try { rel = decodeURIComponent(new URL(req.url, 'http://x').pathname); } catch (e) { res.writeHead(400); res.end('Bad request'); return; }
  if (rel.indexOf('\0') >= 0) { res.writeHead(400); res.end('Bad request'); return; }
  if (rel.endsWith('/')) rel += 'index.html';
  const file = path.join(ROOT, path.normalize(rel));
  if (!file.startsWith(ROOT + path.sep) && file !== ROOT) { res.writeHead(403); res.end('Forbidden'); return; }
  if (/(^|[\\/])\.[^\\/]/.test(path.relative(ROOT, file))) { res.writeHead(404); res.end('Not found'); return; }
  fs.stat(file, function (err, st) {
    if (err || !st.isFile()) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Content-Length': st.size, 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' });
    if (req.method === 'HEAD') { res.end(); return; }
    fs.createReadStream(file).pipe(res);
  });
});

server.listen(PORT, HOST, function () {
  console.log('PSICITS is running at http://' + (HOST === '0.0.0.0' ? 'localhost' : HOST) + ':' + PORT + '/  (Ctrl+C to stop)');
});
