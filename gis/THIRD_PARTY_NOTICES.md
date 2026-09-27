# Third-party notices

PSICITS bundles the following open-source libraries and fonts in `vendor/` (and `css/fonts.css`). Each folder contains the library's own license file. The versions are also listed in `vendor/versions.json`.

| Library | Version | License | Used for |
|---|---|---|---|
| [MapLibre GL JS](https://github.com/maplibre/maplibre-gl-js) | 5.24.0 | BSD-3-Clause | Map rendering |
| [Turf](https://github.com/Turfjs/turf) | 7.4.0 | MIT | Geospatial analysis |
| [Terra Draw](https://github.com/JamesLMilner/terra-draw) + MapLibre adapter | 1.35.0 / 1.4.1 | MIT | Drawing and editing |
| [gdal3.js](https://github.com/bugra9/gdal3.js) | 2.8.1 | **LGPL-2.1-or-later** | GDAL/OGR utilities in WebAssembly (bundles GDAL — MIT, PROJ — MIT, GEOS — LGPL-2.1, SpatiaLite — MPL/GPL/LGPL tri-license, SQLite — public domain, and others) |
| [geotiff.js](https://github.com/geotiffjs/geotiff.js) | 3.0.5 | MIT | GeoTIFF reading |
| [proj4js](https://github.com/proj4js/proj4js) | 2.22.0 | MIT | Coordinate transformations |
| [sql.js](https://github.com/sql-js/sql.js) | 1.14.2 | MIT | SQLite (GeoPackage) in WebAssembly |
| [shpjs](https://github.com/calvinmetcalf/shapefile-js) | 6.2.0 | MIT | Shapefile reading |
| [@tmcw/togeojson](https://github.com/placemark/togeojson) | 7.1.2 | BSD-2-Clause | KML/GPX reading |
| [JSZip](https://github.com/Stuk/jszip) | 3.10.2 | MIT (dual MIT/GPL-3.0; used under MIT) | Zip files |
| [PapaParse](https://github.com/mholt/PapaParse) | 5.7.0 | MIT | CSV parsing |
| [topojson-client](https://github.com/topojson/topojson-client) | 3.1.0 | ISC | TopoJSON |
| [osmtogeojson](https://github.com/tyrasd/osmtogeojson) | 3.0.0-beta.5 | MIT | OpenStreetMap / Overpass data |
| [FlatGeobuf](https://github.com/flatgeobuf/flatgeobuf) | 4.5.0 | BSD-3-Clause | FlatGeobuf read/write |
| [RBush](https://github.com/mourner/rbush) | 4.0.1 | MIT | Spatial index |
| [EB Garamond](https://github.com/octaviopardo/EBGaramond12) (via @fontsource/eb-garamond) | 5.3.0 | SIL OFL 1.1 | Display type (embedded in `css/fonts.css`; license in `vendor/fonts/eb-garamond/OFL.txt`) |

## About the LGPL component (gdal3.js)

PSICITS itself is MIT-licensed. gdal3.js is licensed under the GNU Lesser General Public License, version 2.1 or later. It ships unmodified as separate files in `vendor/gdal3/` (`gdal3.js`, `gdal3WebAssembly.wasm` and `gdal3WebAssembly.data`), and PSICITS loads it at run time only when a GDAL command is used. You can replace those files with any compatible build of gdal3.js, for example one you compile yourself from the [gdal3.js sources](https://github.com/bugra9/gdal3.js). If they are removed, PSICITS falls back to the copy on jsDelivr. The full license text is in `vendor/gdal3/LICENSE`.

## Data and services

These are not bundled. They are accessed at run time, and their own terms apply:

- **Basemaps:**
  - [OpenFreeMap](https://openfreemap.org) (© OpenMapTiles, © OpenStreetMap contributors)
  - [Esri World Imagery](https://www.arcgis.com/home/item.html?id=10df2279f9684e4a9f6a7f08febac2a9)
  - [OpenTopoMap](https://opentopomap.org) (CC-BY-SA)
  - [OpenStreetMap](https://www.openstreetmap.org/copyright) tiles
- **Geocoding:** [Nominatim](https://operations.osmfoundation.org/policies/nominatim/) (please keep to about one request per second), with [Photon](https://photon.komoot.io) as a fallback.
- **OpenStreetMap data:** the [Overpass API](https://wiki.openstreetmap.org/wiki/Overpass_API). The data is ODbL-licensed, © OpenStreetMap contributors.
- **Sample data:** [Natural Earth](https://www.naturalearthdata.com) (public domain), [USGS earthquake feeds](https://earthquake.usgs.gov/earthquakes/feed/) (public domain), and the PublicaMundi US states and Zetashapes neighborhood datasets (see their repositories).
- **Color ramps:** [ColorBrewer](https://colorbrewer2.org) by Cynthia Brewer (Apache-2.0 style license), and matplotlib's perceptually uniform colormaps (CC0).
