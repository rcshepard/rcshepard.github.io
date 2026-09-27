# Contributing to PSICITS

Thanks for helping! PSICITS aims to stay **simple to run and simple to hack on**:

- No build step. The files in the repository are the files the browser loads.
- No runtime dependencies to install. Libraries are vendored in `vendor/`.
- Everything the user can do is a text command, so it can be typed, repeated, scripted and tested.

## Getting started

```bash
git clone <your fork>
cd psicits
node tools/serve.js        # http://localhost:8000  (or: python -m http.server 8000)
node --test                # unit tests, Node 18+
```

Opening `index.html` directly from disk also works. It's a good way to check that nothing depends on a server.

## Code layout and conventions

Read [docs/CONVENTIONS.md](docs/CONVENTIONS.md) (module pattern, data model, units) and [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) (how the pieces fit). The short version:

- `js/lib/` is **DOM-free** and unit-tested in Node. Put algorithms here.
- `js/app/tools/` defines commands. Tool files must not touch the DOM when they load; the tests load them in Node to check parsing.
- `js/app/ui/` holds the panels. UI actions should run text commands (`M.app.run('…')`) rather than call internals, so they show up in the console and history.
- Errors are messages for people: `"parcels" has points; clip needs polygons.` They are not stack traces.
- Style: 2-space indent, single quotes, semicolons, ES2020, no `import`/`export`.

## Adding a command

1. Add a `T.define({...})` block to a file in `js/app/tools/`. See the example in ARCHITECTURE.md.
2. Give it a `category`, a one-line `summary`, typed `params`, and 1–3 `examples`. Add `forms` if the natural word order differs from the parameter order.
3. If it is a new file, add it to `index.html` and to the list at the top of `tests/commands.test.js`.
4. Run `node --test`. The catalogue tests check that your examples parse to your tool, that no verb collides with another tool, and that the canonical text round-trips.
5. Run `node tools/gen-commands-doc.js` to refresh `docs/COMMANDS.md`.

## Adding a file format

Native readers and writers live in `js/lib/formats.js` (pure functions) and are wired up in `js/app/io.js` (`importBytes`, `exportLayer`). Anything GDAL supports already works through the fallback in `io.importBytes`. A native reader is only worth adding for common formats, or when you want to avoid loading the 40 MB GDAL download.

## Browser tests

Unit tests cover the libraries and the parser. Map rendering, drawing, the GDAL worker and `file://` mode need a real browser. If you have Playwright:

```bash
npm i -D playwright && npx playwright install chromium
node tests/e2e/smoke.e2e.js
```

The smoke test starts the local server, runs a series of commands (grids, spatial joins, styling, rasters, GDAL, exports, drawing), and fails on any page error.

## Updating vendored libraries

Versions are recorded in `vendor/versions.json`. To update one, download the package from npm, copy its browser build and license into the matching `vendor/` folder, update `versions.json` and `THIRD_PARTY_NOTICES.md`, and run the unit and browser tests.

## Reporting bugs

Please include the command you typed (the console's copy button helps) and, if you can, a small file that reproduces the problem. `history save` downloads your session as a script.
