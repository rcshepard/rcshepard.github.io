/*
 * PSICITS — data in and out: files, URLs, samples, export, and web data
 * (geocoding, boundaries and OpenStreetMap via Overpass).
 */
(function (root) {
  'use strict';

  const M = root.PSICITS;
  const util = M.util;
  const T = M.toolkit;
  const P = T.P;
  const def = T.define;

  /* ------------------------------------------------------------ helpers */

  async function addImported(ctx, res, opts) {
    opts = opts || {};
    (res.warnings || []).forEach(function (w) { ctx.out.warn(w); });
    const added = [];
    for (const proj of res.projects || []) {
      await loadProject(ctx, proj);
    }
    res.layers.forEach(function (spec, i) {
      if (opts.name && res.layers.length === 1) spec.name = opts.name;
      added.push(ctx.add(spec, { verb: 'Loaded', zoom: i === res.layers.length - 1 && opts.zoom !== false }));
    });
    return added;
  }
  T.addImported = addImported;

  async function loadProject(ctx, proj) {
    if (ctx.store.layers.length && !(await ctx.confirm('Open this project? The current layers will be replaced.', { ok: 'Open project' }))) return;
    ctx.store.fromJSON(proj);
    if (proj.view) ctx.map.setView(proj.view);
    if (Array.isArray(proj.history)) ctx.app.history = proj.history.slice();
    ctx.out.success('Opened project with ' + T.plural(proj.layers.length, 'layer'));
  }
  T.loadProject = loadProject;

  function askCrs(info) {
    const b = info.bbox;
    return M.ui.prompt('The coordinates in "' + info.name + '" (' + (info.xField || 'x') + ', ' + (info.yField || 'y') + ') are not longitude/latitude' +
      (b ? ' — they range from ' + Math.round(b[0]) + ', ' + Math.round(b[1]) + ' to ' + Math.round(b[2]) + ', ' + Math.round(b[3]) : '') + '. Which coordinate system are they in?', 'EPSG:', {
      title: 'Coordinate system', placeholder: 'e.g. EPSG:3435 (Illinois East ftUS), EPSG:32616 (UTM 16N)',
      help: 'Enter an EPSG code or a proj4 string. Common: 3435/3436 Illinois State Plane (ft), 2263 NY Long Island (ft), 326xx UTM north, 27700 British National Grid, 3857 Web Mercator.',
    }).then(function (v) { return v && v.trim() !== 'EPSG:' ? v.trim() : null; });
  }
  T.askCrs = askCrs;

  /* --------------------------------------------------------------- open */

  def({
    name: 'open', aliases: ['add data', 'import', 'upload', 'open file', 'add file', 'add'], category: 'Data',
    summary: 'Open files from your computer (or a URL)', noHistory: true,
    params: [{ name: 'url', type: 'url', description: 'Optional: a web address instead of a file' }, P.as()],
    examples: ['open', 'open https://example.com/data.geojson'],
    run: async function (args, ctx) {
      if (args.url) return ctx.run('load ' + args.url + (args.as ? ' as ' + JSON.stringify(args.as) : ''));
      const files = await ctx.io.pickFiles({});
      if (!files || !files.length) return 'No file chosen';
      ctx.progress('Reading ' + T.plural(files.length, 'file') + '…');
      const res = await ctx.io.importFiles(files, { askCrs: askCrs });
      const added = await addImported(ctx, res, { name: args.as });
      if (!added.length && !(res.projects || []).length) throw new Error('Nothing could be loaded from the file(s).');
    },
  });

  def({
    name: 'load', aliases: ['fetch', 'add url', 'download from', 'open url'], category: 'Data',
    summary: 'Load data from a URL (GeoJSON, CSV, zip, ArcGIS REST, WFS, XYZ/WMS tiles…)',
    params: [
      { name: 'url', type: 'url', required: true, positional: true, description: 'Web address' },
      P.as(),
      P.where({ description: 'ArcGIS REST filter, e.g. STATE_NAME = \'Illinois\'' }),
      { name: 'layers', type: 'text', keywords: ['layers'], description: 'WMS layer name(s)' },
      { name: 'typename', type: 'text', keywords: ['typename', 'type'], description: 'WFS feature type' },
    ],
    examples: ['load https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/2.5_week.geojson as quakes'],
    run: async function (args, ctx) {
      ctx.progress('Downloading…');
      const res = await ctx.io.importURL(args.url, { name: args.as, where: args.where, layers: args.layers, typeName: args.typename, askCrs: askCrs });
      await addImported(ctx, res, { name: args.as });
    },
  });

  const SAMPLES = {
    countries: { label: 'World countries (Natural Earth 1:110m)', url: 'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_110m_admin_0_countries.geojson' },
    cities: { label: 'World populated places (Natural Earth)', url: 'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_110m_populated_places_simple.geojson' },
    rivers: { label: 'World rivers (Natural Earth)', url: 'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_110m_rivers_lake_centerlines.geojson' },
    lakes: { label: 'World lakes (Natural Earth)', url: 'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_110m_lakes.geojson' },
    'us-states': { label: 'US states with population density', url: 'https://raw.githubusercontent.com/PublicaMundi/MappingAPI/master/data/geojson/us-states.json' },
    earthquakes: { label: 'Earthquakes M2.5+ in the past week (USGS, live)', url: 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/2.5_week.geojson' },
    'chicago-neighborhoods': { label: 'Chicago neighborhoods (Zetashapes)', url: 'https://raw.githubusercontent.com/blackmad/neighborhoods/master/chicago.geojson' },
  };
  T.SAMPLES = SAMPLES;

  def({
    name: 'sample', aliases: ['samples', 'demo', 'example data'], category: 'Data', summary: 'Load a sample dataset from the web',
    params: [P.choice('name', Object.keys(SAMPLES), { aliases: { world: 'countries', country: 'countries', city: 'cities', states: 'us-states', usa: 'us-states', 'us states': 'us-states', quakes: 'earthquakes', earthquake: 'earthquakes', chicago: 'chicago-neighborhoods', neighborhoods: 'chicago-neighborhoods', river: 'rivers', lake: 'lakes' } }), P.as()],
    examples: ['sample countries', 'sample earthquakes', 'sample us-states'],
    run: async function (args, ctx) {
      if (!args.name) {
        ctx.out.text('Sample datasets (loaded from the web):');
        ctx.out.commandList('Samples', Object.keys(SAMPLES).map(function (k) { return { name: 'sample ' + k, summary: SAMPLES[k].label }; }));
        return;
      }
      const s = SAMPLES[args.name];
      ctx.progress('Downloading ' + s.label + '…');
      const res = await ctx.io.importURL(s.url, { name: args.as || args.name.replace(/-/g, '_') });
      await addImported(ctx, res, { name: args.as || args.name.replace(/-/g, '_') });
    },
  });

  /* ------------------------------------------------------------- export */

  def({
    name: 'export', aliases: ['download', 'save layer', 'export layer', 'write'], category: 'Data',
    summary: 'Download a layer as GeoJSON, Shapefile, GeoPackage, KML, CSV, GeoTIFF, … (or any GDAL format)',
    params: [
      P.layer('layer', { kinds: ['vector', 'raster'] }),
      { name: 'format', type: 'enum', options: Object.keys(M.io.EXPORT_FORMATS), aliases: { json: 'geojson', shp: 'shapefile', zip: 'shapefile', geopackage: 'gpkg', tif: 'geotiff', tiff: 'geotiff', flatgeobuf: 'fgb', gdb: 'filegdb', excel: 'xlsx', tab: 'mapinfo', image: 'png', jpg: 'jpeg', ascii: 'asc' }, keys: ['driver'], description: 'geojson, shapefile, gpkg, kml, csv, gpx, fgb, geotiff, png, dxf, filegdb, …' },
      { name: 'crs', type: 'crs', keywords: ['crs', 'srs', 'projection', 'epsg'], description: 'Reproject on export, e.g. EPSG:3435' },
      P.flag('selected', ['selected', 'selection', 'only-selected'], 'Only the selected features'),
      { name: 'file', type: 'name', keywords: ['file', 'filename'], description: 'File name' },
    ],
    forms: ['{layer} [as|to|in|into] {format}'],
    examples: ['export roads as shapefile', 'export parcels to gpkg crs EPSG:3435', 'export dem as geotiff', 'export counties csv selected'],
    run: async function (args, ctx) {
      const l = ctx.layer(args.layer);
      ctx.progress('Writing…');
      const r = await ctx.io.exportLayer(l, { format: args.format, crs: args.crs, selectedOnly: args.selected, filename: args.file || l.name });
      (r.warnings || []).forEach(function (w) { ctx.out.warn(w); });
      ctx.io.download(r.blob, r.filename);
      return 'Downloaded ' + r.filename + ' (' + util.formatBytes(r.blob.size) + ')';
    },
  });

  def({
    name: 'screenshot', aliases: ['export map', 'save map', 'print', 'map image', 'snapshot'], category: 'Data',
    summary: 'Download the current map as a PNG image', params: [{ name: 'file', type: 'name', positional: true }],
    run: async function (args, ctx) {
      const blob = await ctx.map.capture();
      const name = util.slug(args.file || 'map') + '.png';
      ctx.io.download(blob, name);
      return 'Downloaded ' + name;
    },
  });

  /* ------------------------------------------------------- geocoding */

  let lastNominatim = 0;
  async function nominatim(params) {
    const wait = 1100 - (Date.now() - lastNominatim);
    if (wait > 0) await new Promise(function (r) { setTimeout(r, wait); });
    lastNominatim = Date.now();
    const q = new URLSearchParams(Object.assign({ format: 'jsonv2', addressdetails: '0' }, params));
    const r = await M.io.fetch('https://nominatim.openstreetmap.org/search?' + q.toString(), { headers: { Accept: 'application/json' } });
    return r.json();
  }
  async function photon(q, limit) {
    const r = await M.io.fetch('https://photon.komoot.io/api/?q=' + encodeURIComponent(q) + '&limit=' + (limit || 5));
    const j = await r.json();
    return (j.features || []).map(function (f) {
      const p = f.properties || {};
      const ext = p.extent; // [minLon, maxLat, maxLon, minLat]
      return {
        lat: f.geometry.coordinates[1], lon: f.geometry.coordinates[0],
        display_name: [p.name, p.city, p.state, p.country].filter(Boolean).join(', '),
        boundingbox: ext ? [ext[3], ext[1], ext[0], ext[2]] : null, type: p.osm_value, category: p.osm_key, osm_type: p.osm_type, osm_id: p.osm_id,
      };
    });
  }
  /** Geocode a place name → [{ lat, lon, display_name, boundingbox:[s,n,w,e], geojson? }] */
  async function geocode(q, opts) {
    opts = opts || {};
    try {
      const res = await nominatim(Object.assign({ q: q, limit: String(opts.limit || 5) }, opts.polygon ? { polygon_geojson: '1', polygon_threshold: '0.0003' } : {}));
      if (res.length || opts.polygon) return res;
    } catch (e) {
      if (opts.polygon) throw e;
    }
    return photon(q, opts.limit);
  }
  T.geocode = geocode;

  function resultBBox(r) {
    const b = r.boundingbox;
    if (!b) return null;
    return [parseFloat(b[2]), parseFloat(b[0]), parseFloat(b[3]), parseFloat(b[1])];
  }

  def({
    name: 'find', aliases: ['search', 'where is', 'locate', 'look up'], category: 'Web & OSM', summary: 'Find a place and fly there (OpenStreetMap Nominatim)',
    params: [{ name: 'place', type: 'place', required: true, description: 'Address or place name' }],
    examples: ['find University of Chicago', 'find 5801 S Ellis Ave, Chicago'],
    run: async function (args, ctx) {
      ctx.progress('Searching…');
      const res = await geocode(args.place, { limit: 5 });
      if (!res.length) throw new Error('No place found for "' + args.place + '"');
      const top = res[0];
      const b = resultBBox(top);
      if (b && (b[2] - b[0]) > 1e-6) ctx.map.fitBounds(b, { maxZoom: 16 });
      else ctx.map.map.flyTo({ center: [+top.lon, +top.lat], zoom: 16 });
      ctx.map.highlight({ type: 'Point', coordinates: [+top.lon, +top.lat] });
      ctx.out.text('Found: ' + top.display_name);
      if (res.length > 1) {
        ctx.out.commandList('Other matches', res.slice(1).map(function (r) {
          return { name: 'zoom to ' + (+r.lat).toFixed(5) + ', ' + (+r.lon).toFixed(5), summary: r.display_name };
        }));
      }
      ctx.out.note('Add it as a layer: geocode ' + args.place);
    },
  });

  def({
    name: 'geocode', aliases: ['address', 'place point'], category: 'Web & OSM', summary: 'Turn an address or place name into a point layer',
    params: [{ name: 'place', type: 'place', required: true, description: 'Address or place name' }, P.as()],
    examples: ['geocode Willis Tower, Chicago', 'geocode 5801 S Ellis Ave, Chicago, IL as campus'],
    run: async function (args, ctx) {
      ctx.progress('Searching…');
      const res = await geocode(args.place, { limit: 1 });
      if (!res.length) throw new Error('No place found for "' + args.place + '"');
      const r = res[0];
      ctx.result({ type: 'FeatureCollection', features: [{ type: 'Feature', properties: { name: args.place, display_name: r.display_name, type: r.type || '', osm_id: r.osm_id || null }, geometry: { type: 'Point', coordinates: [+r.lon, +r.lat] } }] }, ctx.name(args.as, util.slug(args.place, 30)), { zoom: true });
    },
  });

  def({
    name: 'geocode table', aliases: ['geocode layer', 'batch geocode', 'geocode addresses'], category: 'Web & OSM', summary: 'Geocode an address field of a table (up to 250 rows, OpenStreetMap Nominatim)',
    params: [P.layer('layer', { description: 'Table or layer with addresses' }), P.field('field', { positional: true, required: true, description: 'Address field' }), P.as()],
    examples: ['geocode table schools address'],
    run: async function (args, ctx) {
      const l = ctx.vector(args.layer);
      const feats = l.data.features;
      const n = Math.min(feats.length, 250);
      if (feats.length > 250) ctx.out.warn('Only the first 250 rows are geocoded (the free OpenStreetMap service allows about one request per second).');
      const out = [];
      let fails = 0;
      for (let i = 0; i < n; i++) {
        const addr = feats[i].properties[args.field];
        ctx.progress('Geocoding ' + (i + 1) + ' / ' + n + ' …');
        let r = [];
        if (addr) { try { r = await nominatim({ q: String(addr), limit: '1' }); } catch (e) { r = []; } }
        if (!r.length) { fails++; out.push({ type: 'Feature', properties: Object.assign({}, feats[i].properties, { geocoded: false }), geometry: null }); continue; }
        out.push({ type: 'Feature', properties: Object.assign({}, feats[i].properties, { geocoded: true, matched_address: r[0].display_name }), geometry: { type: 'Point', coordinates: [+r[0].lon, +r[0].lat] } });
      }
      ctx.result({ type: 'FeatureCollection', features: out }, T.outName(ctx, args, l, 'geocoded'), { zoom: true });
      if (fails) ctx.out.warn(fails + ' address(es) could not be found (kept without geometry).');
    },
  });

  def({
    name: 'boundary', aliases: ['outline of', 'get boundary', 'boundaries', 'boundary of'], category: 'Web & OSM', summary: 'Get the boundary polygon of a city, county, state, country, park…',
    params: [{ name: 'place', type: 'place', required: true }, P.as()],
    forms: ['[of] {place}'],
    examples: ['boundary Cook County, Illinois', 'boundary Chicago', 'boundary Yellowstone National Park'],
    run: async function (args, ctx) {
      ctx.progress('Looking up the boundary…');
      const res = await geocode(args.place, { limit: 5, polygon: true });
      const hit = res.find(function (r) { return r.geojson && /Polygon/.test(r.geojson.type); });
      if (!hit) throw new Error('No boundary polygon found for "' + args.place + '". Try a more specific name, e.g. "Cook County, Illinois".');
      const fc = { type: 'FeatureCollection', features: [{ type: 'Feature', properties: { name: hit.name || args.place, display_name: hit.display_name, type: hit.type, osm_type: hit.osm_type, osm_id: hit.osm_id }, geometry: hit.geojson }] };
      ctx.result(fc, ctx.name(args.as, util.slug(hit.name || args.place, 40)), { zoom: true });
    },
  });

  /* ----------------------------------------------------- OpenStreetMap */

  const POI = true;
  const OSM_PRESETS = {
    hospitals: [['nwr["amenity"="hospital"]'], POI], clinics: [['nwr["amenity"~"^(clinic|doctors)$"]'], POI], pharmacies: [['nwr["amenity"="pharmacy"]'], POI],
    schools: [['nwr["amenity"="school"]'], POI], universities: [['nwr["amenity"~"^(university|college)$"]'], POI], libraries: [['nwr["amenity"="library"]'], POI],
    kindergartens: [['nwr["amenity"~"^(kindergarten|childcare)$"]'], POI],
    restaurants: [['nwr["amenity"="restaurant"]'], POI], cafes: [['nwr["amenity"="cafe"]'], POI], bars: [['nwr["amenity"~"^(bar|pub|biergarten)$"]'], POI],
    'fast food': [['nwr["amenity"="fast_food"]'], POI], supermarkets: [['nwr["shop"~"^(supermarket|grocery|greengrocer)$"]'], POI], shops: [['nwr["shop"]'], POI],
    banks: [['nwr["amenity"="bank"]'], POI], atms: [['nwr["amenity"="atm"]'], POI], 'post offices': [['nwr["amenity"="post_office"]'], POI],
    police: [['nwr["amenity"="police"]'], POI], 'fire stations': [['nwr["amenity"="fire_station"]'], POI],
    hotels: [['nwr["tourism"~"^(hotel|motel|hostel|guest_house)$"]'], POI], museums: [['nwr["tourism"="museum"]'], POI], attractions: [['nwr["tourism"~"^(attraction|viewpoint)$"]'], POI],
    'places of worship': [['nwr["amenity"="place_of_worship"]'], POI], parking: [['nwr["amenity"="parking"]'], POI], 'bike parking': [['nwr["amenity"="bicycle_parking"]'], POI],
    'charging stations': [['nwr["amenity"="charging_station"]'], POI], 'gas stations': [['nwr["amenity"="fuel"]'], POI], toilets: [['nwr["amenity"="toilets"]'], POI],
    'drinking water': [['nwr["amenity"="drinking_water"]'], POI], benches: [['node["amenity"="bench"]'], POI],
    'bus stops': [['node["highway"="bus_stop"]'], POI], 'train stations': [['nwr["railway"="station"]', 'nwr["public_transport"="station"]'], POI],
    'subway entrances': [['node["railway"="subway_entrance"]'], POI], airports: [['nwr["aeroway"="aerodrome"]'], POI], trees: [['node["natural"="tree"]'], POI],
    'bike share': [['nwr["amenity"="bicycle_rental"]'], POI],
    parks: [['nwr["leisure"="park"]']], playgrounds: [['nwr["leisure"="playground"]']], 'sports fields': [['nwr["leisure"="pitch"]']],
    cemeteries: [['nwr["landuse"="cemetery"]']], forests: [['nwr["landuse"="forest"]', 'nwr["natural"="wood"]']], water: [['nwr["natural"="water"]']],
    buildings: [['way["building"]']], roads: [['way["highway"~"^(motorway|trunk|primary|secondary|tertiary|unclassified|residential|living_street)$"]']],
    'major roads': [['way["highway"~"^(motorway|trunk|primary|secondary)(_link)?$"]']], highways: [['way["highway"~"^(motorway|trunk)(_link)?$"]']],
    sidewalks: [['way["footway"="sidewalk"]', 'way["highway"="footway"]']], 'bike lanes': [['way["highway"="cycleway"]', 'way["cycleway"~"^(lane|track)$"]', 'way["cycleway:both"~"^(lane|track)$"]', 'way["cycleway:right"~"^(lane|track)$"]', 'way["cycleway:left"~"^(lane|track)$"]']],
    railways: [['way["railway"~"^(rail|light_rail|subway|tram)$"]']], rivers: [['way["waterway"~"^(river|canal)$"]']], streams: [['way["waterway"="stream"]']],
    'power lines': [['way["power"="line"]']], 'land use': [['way["landuse"]']],
  };
  const OSM_ALIASES = {
    hospital: 'hospitals', clinic: 'clinics', doctors: 'clinics', pharmacy: 'pharmacies', school: 'schools', university: 'universities', college: 'universities',
    colleges: 'universities', library: 'libraries', daycare: 'kindergartens', restaurant: 'restaurants', food: 'restaurants', cafe: 'cafes', coffee: 'cafes', 'coffee shops': 'cafes',
    bar: 'bars', pubs: 'bars', pub: 'bars', supermarket: 'supermarkets', groceries: 'supermarkets', 'grocery stores': 'supermarkets', grocery: 'supermarkets',
    shop: 'shops', stores: 'shops', bank: 'banks', atm: 'atms', 'post office': 'post offices', 'police stations': 'police', 'fire station': 'fire stations',
    hotel: 'hotels', museum: 'museums', churches: 'places of worship', mosques: 'places of worship', temples: 'places of worship', 'places of worship': 'places of worship',
    'parking lots': 'parking', 'ev chargers': 'charging stations', 'ev charging': 'charging stations', 'gas': 'gas stations', 'petrol stations': 'gas stations', fuel: 'gas stations',
    'bus stop': 'bus stops', stations: 'train stations', 'train station': 'train stations', 'l stations': 'train stations', 'metro stations': 'train stations', airport: 'airports', tree: 'trees',
    divvy: 'bike share', 'bike rental': 'bike share', park: 'parks', playground: 'playgrounds', 'green space': 'parks', cemetery: 'cemeteries', woods: 'forests', forest: 'forests',
    lakes: 'water', ponds: 'water', building: 'buildings', streets: 'roads', road: 'roads', street: 'roads', 'main roads': 'major roads', freeways: 'highways', motorways: 'highways',
    cycleways: 'bike lanes', 'bike paths': 'bike lanes', bikeways: 'bike lanes', railroads: 'railways', rail: 'railways', river: 'rivers', creeks: 'streams', landuse: 'land use',
  };
  T.OSM_PRESETS = OSM_PRESETS;

  function osmFilters(what) {
    const w = String(what || '').trim();
    const lw = w.toLowerCase();
    const key = OSM_PRESETS[lw] ? lw : OSM_ALIASES[lw];
    if (key) return { filters: OSM_PRESETS[key][0], poi: !!OSM_PRESETS[key][1], label: key };
    // raw Overpass filter(s): ["shop"="bakery"] or node["amenity"="bench"]
    if (/^(node|way|relation|nwr|nw|nr|wr)?\s*\[/.test(w)) {
      const m = /^(node|way|relation|nwr|nw|nr|wr)?\s*(\[.*\])$/.exec(w);
      if (!m) throw new Error('Could not read the Overpass filter "' + w + '"');
      return { filters: [(m[1] || 'nwr') + m[2]], poi: /^node/.test(w), label: 'osm' };
    }
    // tag=value, tag=a|b, tag=*, tag
    const kv = /^([\w:]+)\s*(?:=\s*(.+))?$/.exec(w);
    if (kv) {
      const k = kv[1], v = (kv[2] || '*').trim();
      let f;
      if (v === '*') f = 'nwr["' + k + '"]';
      else if (/[|,]/.test(v)) f = 'nwr["' + k + '"~"^(' + v.split(/[|,]/).map(function (x) { return x.trim().replace(/[^\w:-]/g, ''); }).join('|') + ')$"]';
      else f = 'nwr["' + k + '"="' + v.replace(/"/g, '') + '"]';
      return { filters: [f], poi: false, label: k + (v === '*' ? '' : '_' + v.split(/[|,]/)[0]) };
    }
    const s = M.commands.closest(lw, Object.keys(OSM_PRESETS).concat(Object.keys(OSM_ALIASES)));
    throw new Error('Unknown OpenStreetMap feature "' + w + '".' + (s ? ' Did you mean "' + s + '"?' : '') + ' Use a preset (hospitals, parks, bike lanes, …) or a tag like amenity=library.');
  }

  const OVERPASS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter', 'https://maps.mail.ru/osm/tools/overpass/api/interpreter'];
  async function overpass(query) {
    let lastErr = null;
    for (const ep of OVERPASS) {
      try {
        const r = await fetch(ep, { method: 'POST', body: 'data=' + encodeURIComponent(query), headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
        if (r.status === 429 || r.status === 504) { lastErr = new Error('Overpass is busy (' + r.status + ')'); continue; }
        const txt = await r.text();
        if (!r.ok) {
          const m = /<p><strong[^>]*>Error<\/strong>:\s*([^<]+)/.exec(txt);
          throw new Error('Overpass error: ' + (m ? m[1] : r.status));
        }
        return JSON.parse(txt);
      } catch (e) { lastErr = e; if (/Overpass error/.test(e.message)) throw e; }
    }
    throw new Error('Could not reach the Overpass API: ' + (lastErr && lastErr.message));
  }

  function osmToFC(json, poi) {
    let fc = root.osmtogeojson(json, { flatProperties: true });
    fc = util.toFeatureCollection(fc);
    fc.features.forEach(function (f) {
      const p = f.properties || {};
      if (p.tags && typeof p.tags === 'object') { Object.assign(p, p.tags); delete p.tags; }
      if (p.id && !p.osm_id) { p.osm_id = p.id; delete p.id; }
      delete p.meta; delete p.relations;
    });
    if (poi) {
      fc.features = fc.features.map(function (f) {
        if (!f.geometry || f.geometry.type === 'Point') return f;
        try { return { type: 'Feature', properties: f.properties, geometry: root.turf.pointOnFeature(f).geometry }; } catch (e) { return f; }
      });
    }
    return fc;
  }

  def({
    name: 'osm', aliases: ['openstreetmap', 'get osm', 'fetch osm', 'get', 'download osm'], category: 'Web & OSM',
    summary: 'Download OpenStreetMap features (hospitals, parks, bike lanes, amenity=library…) for the view, a layer, or a place',
    params: [
      { name: 'what', type: 'text', required: true, description: 'A preset (hospitals, schools, parks, roads, bike lanes, buildings…) or a tag like amenity=library' },
      { name: 'within', type: 'place', keywords: ['in', 'within', 'inside', 'around', 'near'], description: '"view" (default), a layer name, or a place name' },
      P.flag('shapes', ['shapes', 'polygons', 'outlines', 'footprints'], 'Keep building/area outlines instead of points for POIs'),
      P.as(),
    ],
    examples: ['osm hospitals in Chicago', 'osm bike lanes in view', 'osm amenity=library in "Cook County, Illinois"', 'osm parks in neighborhoods'],
    run: async function (args, ctx) {
      const f = osmFilters(args.what);
      const where = (args.within || 'view').trim();
      let areaClause = null, bbox = null, areaName = where;
      const layer = where.toLowerCase() === 'view' || where.toLowerCase() === 'the view' ? null : ctx.store.get(where);
      if (where.toLowerCase() === 'view' || where.toLowerCase() === 'the view' || where.toLowerCase() === 'map') {
        bbox = ctx.map.viewBBox();
        areaName = 'the current view';
      } else if (layer) {
        if (!layer.bbox) throw new Error('"' + layer.name + '" has no extent');
        bbox = layer.bbox;
        areaName = layer.name;
      } else {
        ctx.progress('Finding "' + where + '"…');
        const res = await geocode(where, { limit: 3 });
        const hit = res.find(function (r) { return r.osm_type === 'relation' || r.osm_type === 'R'; }) || res[0];
        if (!hit) throw new Error('Could not find the place "' + where + '"');
        const t = String(hit.osm_type || '').toLowerCase();
        if ((t === 'relation' || t === 'r') && hit.osm_id) areaClause = 'area(id:' + (3600000000 + Number(hit.osm_id)) + ')->.a;';
        else if ((t === 'way' || t === 'w') && hit.osm_id) areaClause = 'area(id:' + (2400000000 + Number(hit.osm_id)) + ')->.a;';
        else bbox = resultBBox(hit);
        areaName = hit.display_name ? hit.display_name.split(',').slice(0, 2).join(',') : where;
      }
      if (bbox) {
        const km2 = Math.abs((bbox[2] - bbox[0]) * (bbox[3] - bbox[1])) * 111 * 111 * Math.cos((bbox[1] + bbox[3]) / 2 * Math.PI / 180);
        if (km2 > 250000 && !/^(airports|rivers|highways|railways)$/.test(f.label)) {
          throw new Error('That area is very large (' + Math.round(km2).toLocaleString() + ' km²). Zoom in, or name a smaller place ("in Chicago").');
        }
      }
      const loc = areaClause ? '(area.a)' : '(' + [bbox[1], bbox[0], bbox[3], bbox[2]].map(function (x) { return x.toFixed(6); }).join(',') + ')';
      const q = '[out:json][timeout:90];' + (areaClause || '') + '(' + f.filters.map(function (x) { return x + loc + ';'; }).join('') + ');out body;>;out skel qt;';
      ctx.progress('Querying OpenStreetMap for ' + f.label + ' in ' + areaName + '…');
      const json = await overpass(q);
      let fc = osmToFC(json, f.poi && !args.shapes);
      if (layer && layer.type === 'vector' && (layer.geometryType === 'Polygon' || layer.geometryType === 'Mixed') && fc.features.length) {
        // keep only what falls inside the layer's polygons (the query used its bounding box)
        const keep = M.geoops.selectByLocation(fc, layer.data, { predicate: 'intersects' });
        fc = { type: 'FeatureCollection', features: keep.map(function (i) { return fc.features[i]; }) };
      }
      if (!fc.features.length) { ctx.out.text('No ' + f.label + ' found in ' + areaName + '.'); return; }
      ctx.result(fc, ctx.name(args.as, util.slug(f.label, 30)));
      ctx.out.note('Data © OpenStreetMap contributors (ODbL)');
    },
  });
  T.osmFilters = osmFilters;

  def({
    name: 'overpass', category: 'Web & OSM', raw: true, summary: 'Run a raw Overpass QL query ({{bbox}} = current view)',
    params: [{ name: 'query', type: 'rest', required: true }],
    examples: ['overpass node["amenity"="bench"]({{bbox}});out;'],
    run: async function (args, ctx) {
      const b = ctx.map.viewBBox();
      let q = args.query.replace(/\{\{bbox\}\}/g, [b[1], b[0], b[3], b[2]].map(function (x) { return x.toFixed(6); }).join(','));
      if (!/\[out:json\]/.test(q)) q = '[out:json][timeout:90];' + q;
      if (!/out\b/.test(q.replace(/\[out:json\]/, ''))) q += 'out body;>;out skel qt;';
      ctx.progress('Querying Overpass…');
      const fc = osmToFC(await overpass(q), false);
      ctx.result(fc, ctx.name(null, 'overpass'));
    },
  });

  /* ------------------------------------------------------- tile layers */

  def({
    name: 'tiles', aliases: ['xyz', 'add tiles', 'tile layer'], category: 'Web & OSM', summary: 'Add an XYZ tile layer ({z}/{x}/{y} URL)',
    params: [{ name: 'url', type: 'url', required: true, positional: true }, P.as(), { name: 'attribution', type: 'text', keywords: ['attribution', 'credit'] }],
    examples: ['tiles https://tile.openstreetmap.org/{z}/{x}/{y}.png as osm'],
    run: async function (args, ctx) {
      if (!/\{z\}/i.test(args.url)) throw new Error('A tile URL needs {z}, {x} and {y} placeholders');
      const res = await ctx.io.importURL(args.url, { name: args.as, attribution: args.attribution });
      await addImported(ctx, res, { name: args.as, zoom: false });
    },
  });
  def({
    name: 'wms', aliases: ['add wms'], category: 'Web & OSM', summary: 'Add a WMS layer',
    params: [{ name: 'url', type: 'url', required: true, positional: true }, { name: 'layers', type: 'text', keywords: ['layers', 'layer'], required: true }, P.as()],
    examples: ['wms https://ows.terrestris.de/osm/service layers OSM-WMS'],
    run: async function (args, ctx) {
      const u = args.url + (args.url.indexOf('?') >= 0 ? '&' : '?') + 'service=WMS';
      const res = await ctx.io.importURL(u, { name: args.as || args.layers, layers: args.layers });
      await addImported(ctx, res, { name: args.as, zoom: false });
    },
  });
})(typeof globalThis !== 'undefined' ? globalThis : this);
