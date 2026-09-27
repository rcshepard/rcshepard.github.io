# Command reference

_Generated from the tool definitions by `node tools/gen-commands-doc.js` — 124 commands._

Type these in the console (right panel). Words can come in a natural order; the console shows how it understood you before you press Enter, and **Tab** completes layer names, fields and options. Every toolbox form and menu item prints the command it runs, so you can learn by clicking.

Conventions: `<layer>` is a layer name (quote names with spaces: `"city limits"`), distances take units (`500 m`, `2 km`, `1 mi`, `300 ft`), `as <name>` names the output layer, `selected` limits a tool to the selected features, and expressions use the [expression language](EXPRESSIONS.md).

## Basics

### `help`

List commands, or explain one  
Also: `?`, `commands`, `man`

```
help [<topic>]
```

| Parameter | Type | Notes |
|---|---|---|
| topic | text | A command name or: expressions, gdal, formats, keys, basemaps, ramps, units |

Examples:

```
help
help buffer
help expressions
help gdal
```

### `undo`

Undo the last change

```
undo
```

### `redo`

Redo what was undone

```
redo
```

### `clear`

Clear the console  
Also: `cls`, `clear console`

```
clear
```

### `zoom`

Zoom to a layer, the selection, a place, coordinates or a zoom level  
Also: `zoom to`, `go to`, `goto`, `fly to`, `center`, `show me`, `pan to`

```
zoom [<target>] [<what>] [<place>]
```

| Parameter | Type | Notes |
|---|---|---|
| target | layer | Layer to zoom to |
| what | enum | `selection`, `all`, `world`, `in`, `out` |
| place | place | A place name, "lat, lon", or a zoom level |

Examples:

```
zoom to counties
zoom to selection
zoom to Chicago
zoom to 41.79, -87.60
zoom 12
zoom all
```

### `basemap`

Change the background map  
Also: `background`, `base map`, `basemaps`

```
basemap [<name>]
```

| Parameter | Type | Notes |
|---|---|---|
| name | text | light, streets, bright, dark, fiord, satellite, topo, osm, none — or an XYZ URL |

Examples:

```
basemap satellite
basemap dark
basemap none
```

### `globe`

Switch between a globe and a flat (Web Mercator) map  
Also: `projection`

```
globe [<state>]
```

| Parameter | Type | Notes |
|---|---|---|
| state | enum | `on`, `off`, `toggle` (default `toggle`) |

### `tilt`

Tilt the map (0 = flat, 60 = steep 3D view)  
Also: `pitch`

```
tilt [degrees=<number>] [bearing <bearing>]
```

| Parameter | Type | Notes |
|---|---|---|
| degrees | number |  (default `50`) |
| bearing | number |  — introduced by `bearing` / `rotate` |

### `north`

Reset rotation and tilt  
Also: `reset view`, `flat`

```
north
```

### `theme`

Switch the interface between light and dark  
Also: `dark mode`, `light mode`

```
theme [<mode>]
```

| Parameter | Type | Notes |
|---|---|---|
| mode | enum | `dark`, `light`, `auto` |

## Layers

### `layers`

List the layers  
Also: `list`, `ls`, `list layers`

```
layers
```

### `info`

Details about a layer: fields, extent, CRS  
Also: `describe`, `about layer`, `properties`

```
info <layer>
```

| Parameter | Type | Notes |
|---|---|---|
| layer * | layer | Input layer |

Examples:

```
info counties
```

### `rename`

Rename a layer  
Also: `rename layer`

```
rename <layer> to <to>
```

| Parameter | Type | Notes |
|---|---|---|
| layer * | layer | Input layer |
| to * | name | New name — introduced by `to` / `as` |

Examples:

```
rename L1 to parcels
rename "city limits" to boundary
```

### `remove`

Remove a layer (undo brings it back)  
Also: `delete layer`, `remove layer`, `drop`, `rm`, `close layer`

```
remove [<layer>] [all]
```

| Parameter | Type | Notes |
|---|---|---|
| layer | layer | Input layer |
| all | flag | Remove every layer |

Examples:

```
remove roads
remove all
```

### `duplicate`

Copy a layer  
Also: `copy layer`, `clone`

```
duplicate <layer> [as <as>]
```

| Parameter | Type | Notes |
|---|---|---|
| layer * | layer | Input layer |
| as | name | Name for the new layer — introduced by `as` / `named` / `called` |

### `show`

Make a layer visible  
Also: `unhide`, `turn on`

```
show [<layer>] [all]
```

| Parameter | Type | Notes |
|---|---|---|
| layer | layer | Input layer |
| all | flag |  |

### `hide`

Hide a layer  
Also: `turn off`

```
hide [<layer>] [all]
```

| Parameter | Type | Notes |
|---|---|---|
| layer | layer | Input layer |
| all | flag |  |

### `solo`

Show only this layer  
Also: `only`, `isolate`

```
solo <layer>
```

| Parameter | Type | Notes |
|---|---|---|
| layer * | layer | Input layer |

### `opacity`

Set layer opacity (0–100%)  
Also: `transparency`, `alpha`

```
opacity <layer> value=<number>
```

| Parameter | Type | Notes |
|---|---|---|
| layer * | layer | Input layer |
| value * | number | e.g. 50% or 0.5 |

Examples:

```
opacity counties 60%
```

### `move`

Move a layer up/down in the drawing order  
Also: `reorder`, `order`

```
move <layer> <where>
```

| Parameter | Type | Notes |
|---|---|---|
| layer * | layer | Input layer |
| where * | enum | `top`, `bottom`, `up`, `down` |

Examples:

```
move roads to top
move parcels down
```

### `use`

Make a layer the current one (commands default to it)  
Also: `activate`, `focus`, `choose`, `pick`

```
use <layer>
```

| Parameter | Type | Notes |
|---|---|---|
| layer * | layer | Input layer |

### `table`

Open the attribute table  
Also: `attributes`, `open table`, `attribute table`, `show table`

```
table <layer>
```

| Parameter | Type | Notes |
|---|---|---|
| layer * | layer | Input layer |

## Data

### `new`

Start a new, empty project  
Also: `new project`, `reset`, `start over`

```
new
```

### `save`

Download the whole project (layers, styles, view) as one file  
Also: `save project`, `save as`

```
save [name=<name>]
```

| Parameter | Type | Notes |
|---|---|---|
| name | name | File name |

### `open`

Open files from your computer (or a URL)  
Also: `add data`, `import`, `upload`, `open file`, `add file`, `add`

```
open [<url>] [as <as>]
```

| Parameter | Type | Notes |
|---|---|---|
| url | url | Optional: a web address instead of a file |
| as | name | Name for the new layer — introduced by `as` / `named` / `called` |

Examples:

```
open
open https://example.com/data.geojson
```

### `load`

Load data from a URL (GeoJSON, CSV, zip, ArcGIS REST, WFS, XYZ/WMS tiles…)  
Also: `fetch`, `add url`, `download from`, `open url`

```
load <url> [as <as>] [where <where>] [layers <layers>] [typename <typename>]
```

| Parameter | Type | Notes |
|---|---|---|
| url * | url | Web address |
| as | name | Name for the new layer — introduced by `as` / `named` / `called` |
| where | expression | ArcGIS REST filter, e.g. STATE_NAME = 'Illinois' — introduced by `where` |
| layers | text | WMS layer name(s) — introduced by `layers` |
| typename | text | WFS feature type — introduced by `typename` / `type` |

Examples:

```
load https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/2.5_week.geojson as quakes
```

### `sample`

Load a sample dataset from the web  
Also: `samples`, `demo`, `example data`

```
sample [<name>] [as <as>]
```

| Parameter | Type | Notes |
|---|---|---|
| name | enum | `countries`, `cities`, `rivers`, `lakes`, `us-states`, `earthquakes`, `chicago-neighborhoods` |
| as | name | Name for the new layer — introduced by `as` / `named` / `called` |

Examples:

```
sample countries
sample earthquakes
sample us-states
```

### `export`

Download a layer as GeoJSON, Shapefile, GeoPackage, KML, CSV, GeoTIFF, … (or any GDAL format)  
Also: `download`, `save layer`, `export layer`, `write`

```
export <layer> [<format>] [crs <crs>] [selected] [file <file>]
```

| Parameter | Type | Notes |
|---|---|---|
| layer * | layer | Input layer |
| format | enum | geojson, shapefile, gpkg, kml, csv, gpx, fgb, geotiff, png, dxf, filegdb, … — `geojson`, `csv`, `kml`, `gpx`, `shapefile`, `gpkg`, `fgb`, `wkt`, `geotiff`, `png`, `dxf`, `filegdb`, `mapinfo`, `gml`, `xlsx`, `ods`, `sqlite`, `geojsonseq`, `pmtiles`, `cog`, `asc`, `jpeg` |
| crs | crs | Reproject on export, e.g. EPSG:3435 — introduced by `crs` / `srs` / `projection` / `epsg` |
| selected | flag | Only the selected features |
| file | name | File name — introduced by `file` / `filename` |

Examples:

```
export roads as shapefile
export parcels to gpkg crs EPSG:3435
export dem as geotiff
export counties csv selected
```

### `screenshot`

Download the current map as a PNG image  
Also: `export map`, `save map`, `print`, `map image`, `snapshot`

```
screenshot [file=<name>]
```

| Parameter | Type | Notes |
|---|---|---|
| file | name |  |

## Web & OSM

### `find`

Find a place and fly there (OpenStreetMap Nominatim)  
Also: `search`, `where is`, `locate`, `look up`

```
find <place>
```

| Parameter | Type | Notes |
|---|---|---|
| place * | place | Address or place name |

Examples:

```
find University of Chicago
find 5801 S Ellis Ave, Chicago
```

### `geocode`

Turn an address or place name into a point layer  
Also: `address`, `place point`

```
geocode <place> [as <as>]
```

| Parameter | Type | Notes |
|---|---|---|
| place * | place | Address or place name |
| as | name | Name for the new layer — introduced by `as` / `named` / `called` |

Examples:

```
geocode Willis Tower, Chicago
geocode 5801 S Ellis Ave, Chicago, IL as campus
```

### `geocode table`

Geocode an address field of a table (up to 250 rows, OpenStreetMap Nominatim)  
Also: `geocode layer`, `batch geocode`, `geocode addresses`

```
geocode table <layer> <field> [as <as>]
```

| Parameter | Type | Notes |
|---|---|---|
| layer * | layer | Table or layer with addresses |
| field * | field | Address field |
| as | name | Name for the new layer — introduced by `as` / `named` / `called` |

Examples:

```
geocode table schools address
```

### `boundary`

Get the boundary polygon of a city, county, state, country, park…  
Also: `outline of`, `get boundary`, `boundaries`, `boundary of`

```
boundary <place> [as <as>]
```

| Parameter | Type | Notes |
|---|---|---|
| place * | place |  |
| as | name | Name for the new layer — introduced by `as` / `named` / `called` |

Examples:

```
boundary Cook County, Illinois
boundary Chicago
boundary Yellowstone National Park
```

### `osm`

Download OpenStreetMap features (hospitals, parks, bike lanes, amenity=library…) for the view, a layer, or a place  
Also: `openstreetmap`, `get osm`, `fetch osm`, `get`, `download osm`

```
osm <what> [in <within>] [shapes] [as <as>]
```

| Parameter | Type | Notes |
|---|---|---|
| what * | text | A preset (hospitals, schools, parks, roads, bike lanes, buildings…) or a tag like amenity=library |
| within | place | "view" (default), a layer name, or a place name — introduced by `in` / `within` / `inside` / `around` / `near` |
| shapes | flag | Keep building/area outlines instead of points for POIs |
| as | name | Name for the new layer — introduced by `as` / `named` / `called` |

Examples:

```
osm hospitals in Chicago
osm bike lanes in view
osm amenity=library in "Cook County, Illinois"
osm parks in neighborhoods
```

### `overpass`

Run a raw Overpass QL query ({{bbox}} = current view)

```
overpass <query>
```

Examples:

```
overpass node["amenity"="bench"]({{bbox}});out;
```

### `tiles`

Add an XYZ tile layer ({z}/{x}/{y} URL)  
Also: `xyz`, `add tiles`, `tile layer`

```
tiles <url> [as <as>] [attribution <attribution>]
```

| Parameter | Type | Notes |
|---|---|---|
| url * | url |  |
| as | name | Name for the new layer — introduced by `as` / `named` / `called` |
| attribution | text |  — introduced by `attribution` / `credit` |

Examples:

```
tiles https://tile.openstreetmap.org/{z}/{x}/{y}.png as osm
```

### `wms`

Add a WMS layer  
Also: `add wms`

```
wms <url> layers <layers> [as <as>]
```

| Parameter | Type | Notes |
|---|---|---|
| url * | url |  |
| layers * | text |  — introduced by `layers` / `layer` |
| as | name | Name for the new layer — introduced by `as` / `named` / `called` |

Examples:

```
wms https://ows.terrestris.de/osm/service layers OSM-WMS
```

## Select & query

### `select`

Select features by attributes (where …) or by location (within / intersecting / near another layer)  
Also: `query`, `pick features`, `highlight`

```
select <layer> [where <where>] [<predicate>] [<other>] [distance <distance>] [<mode>] [all]
```

| Parameter | Type | Notes |
|---|---|---|
| layer * | layer | Input layer |
| where | expression | Expression, e.g. "population" > 1000 — introduced by `where` |
| predicate | enum | Spatial relation: intersects, within, contains, touches, crosses, near, disjoint — `intersects`, `within`, `contains`, `touches`, `crosses`, `overlaps`, `disjoint`, `near` |
| other | layer | The other layer (for spatial selection) |
| distance | distance | For "near": how close (default 500 m) — introduced by `distance` |
| mode | enum | `new`, `add`, `remove`, `subset` (default `new`) |
| all | flag | Select every feature |

Examples:

```
select counties where population > 100000
select parks within neighborhoods
select schools within 500 m of highways
select parcels intersecting floodzone add
select all roads
```

### `deselect`

Clear the selection  
Also: `clear selection`, `unselect`, `select none`, `deselect all`, `none`

```
deselect [<layer>]
```

| Parameter | Type | Notes |
|---|---|---|
| layer | layer | Input layer |

### `invert`

Invert the selection  
Also: `invert selection`, `switch selection`, `reverse selection`

```
invert <layer>
```

| Parameter | Type | Notes |
|---|---|---|
| layer * | layer | Input layer |

### `filter`

Only draw features matching an expression (data is kept)  
Also: `show only`, `definition query`, `display filter`, `only show`

```
filter <layer> [where <where>] [off]
```

| Parameter | Type | Notes |
|---|---|---|
| layer * | layer | Input layer |
| where | expression | Expression, e.g. "population" > 1000 — introduced by `where` / `to` |
| off | flag |  |

Examples:

```
filter quakes where mag >= 4
filter quakes off
```

### `unfilter`

Remove a display filter  
Also: `show all features`, `clear filter`, `remove filter`

```
unfilter <layer>
```

| Parameter | Type | Notes |
|---|---|---|
| layer * | layer | Input layer |

### `extract`

Copy selected (or matching) features into a new layer  
Also: `subset`, `save selection`, `export selection`, `copy selected`, `selection to layer`, `new layer from selection`

```
extract <layer> [where <where>] [as <as>]
```

| Parameter | Type | Notes |
|---|---|---|
| layer * | layer | Input layer |
| where | expression | Expression, e.g. "population" > 1000 — introduced by `where` |
| as | name | Name for the new layer — introduced by `as` / `named` / `called` |

Examples:

```
extract counties where state = 'IL' as illinois
extract parcels as selected_parcels
```

### `count`

Count features (optionally where …) — or count points inside each polygon  
Also: `how many`, `count points`, `points in polygons`, `count features`

```
count <points> [<polygons>] [where <where>] [weight <weight>] [as <as>]
```

| Parameter | Type | Notes |
|---|---|---|
| points * | layer | Input layer |
| polygons | layer | Input layer |
| where | expression | Expression, e.g. "population" > 1000 — introduced by `where` |
| weight | field |  — introduced by `weight` / `weighted` / `sum` |
| as | name | Name for the new layer — introduced by `as` / `named` / `called` |

Examples:

```
count quakes
count quakes where mag > 4
count crimes in neighborhoods
count trees per parks as tree_counts
```

### `stats`

Statistics of a field, optionally grouped by another field  
Also: `statistics`, `summary`, `summarize`, `describe field`, `field stats`, `group by`

```
stats <layer> [<field>] [by <by>] [selected]
```

| Parameter | Type | Notes |
|---|---|---|
| layer * | layer | Input layer |
| field | field | Numeric field (or any field for counts) |
| by | field | Group by this field — introduced by `by` / `per` / `grouped` |
| selected | flag |  |

Examples:

```
stats counties population
stats counties population by state
stats parcels by zoning
```

### `unique`

Distinct values of a field with counts  
Also: `values`, `distinct`, `frequency`, `categories`

```
unique <layer> <field>
```

| Parameter | Type | Notes |
|---|---|---|
| layer * | layer | Input layer |
| field * | field |  |

### `histogram`

Histogram of a numeric field (or raster band)  
Also: `hist`, `distribution`

```
histogram <layer> [<field>] [bins <bins>] [band <band>]
```

| Parameter | Type | Notes |
|---|---|---|
| layer * | layer | Input layer |
| field | field |  |
| bins | integer |  (default `20`) — introduced by `bins` |
| band | integer |  — introduced by `band` |

## Attributes

### `calc`

Create or update a field with an expression: calc <layer> <field> = <expression>  
Also: `calculate`, `compute`, `field calculator`, `set`, `update field`, `add field`, `new field`, `create field`

```
calc <layer> <field> = <expression> [where <condition>]
```

| Parameter | Type | Notes |
|---|---|---|
| layer * | layer | Input layer |
| field * | name | Field to create or update |
| expression | expression | Expression, e.g. population / area_km2 — introduced by `=` / `to` / `as` / `:=` |
| only | expression | Only update features matching this — introduced by `where` / `if` / `for` |
| type | enum | `number`, `integer`, `text`, `boolean` |

Examples:

```
calc counties density = population / (area / 1e6)
calc parcels area_ha = round($area / 10000, 2)
calc roads speed = 25 where type = 'residential'
calc cities label = upper(name)
add field parcels notes text
```

### `drop field`

Delete fields  
Also: `delete field`, `remove field`, `delete fields`, `drop fields`, `remove fields`

```
drop field <layer> fields=<fields>
```

| Parameter | Type | Notes |
|---|---|---|
| layer * | layer | Input layer |
| fields * | fields | Field(s) to delete |

Examples:

```
delete field counties shape_area
drop fields parcels a, b, c
```

### `rename field`

Rename a field  
Also: `rename column`

```
rename field <layer> <field> to <to>
```

| Parameter | Type | Notes |
|---|---|---|
| layer * | layer | Input layer |
| field * | field |  |
| to * | name |  — introduced by `to` / `as` |

Examples:

```
rename field counties NAME to county_name
```

### `join`

Attach attributes from a table (or layer) by matching a key field  
Also: `table join`, `attribute join`, `join table`, `merge attributes`

```
join <layer> <table> on <on> [fields <fields>] [as <as>]
```

| Parameter | Type | Notes |
|---|---|---|
| layer * | layer | Input layer |
| table * | layer | Table or layer to take attributes from |
| on * | text | Key field, or left = right when the names differ — introduced by `on` / `using` / `by` / `where` |
| fields | fields | Only copy these fields — introduced by `fields` / `columns` / `keep` |
| as | name | Name for the new layer — introduced by `as` / `named` / `called` |

Examples:

```
join counties with census on GEOID
join tracts with acs on GEOID = geoid10 fields income, poverty
```

## Style

### `legend`

Show or hide the map legend

```
legend [<state>]
```

| Parameter | Type | Notes |
|---|---|---|
| state | enum | `on`, `off`, `toggle` (default `toggle`) |

### `color`

Color a layer: one color, or by a field (graduated/categorized). Rasters: a color ramp.  
Also: `colour`, `style`, `symbolize`, `symbolise`, `paint`, `shade`, `choropleth`, `classify`, `recolor`

```
color <layer> [by <field>] [<color>] [<ramp>] [palette=<palette>] [<method>] [<values>] [<type>] [band <band>] [invert]
```

| Parameter | Type | Notes |
|---|---|---|
| layer * | layer | Input layer |
| field | field | Field to color by — introduced by `by` / `using` / `on` |
| color | color | A single color: red, #3366cc, … |
| ramp | ramp | Color ramp: viridis, blues, reds, ylorrd, rdylgn, spectral, terrain, … (add -r to reverse) |
| palette | palette | Categorical palette: tableau10, set1, set2, pastel, bold, dark2, paired |
| method | enum | Classification method — `quantile`, `equal`, `jenks`, `pretty`, `stddev` |
| values | numbers | Number of classes (vector) — or min max stretch (raster) |
| type | enum | `graduated`, `categorized`, `single` |
| band | integer | Raster band (1-based) — introduced by `band` |
| invert | flag |  |

Examples:

```
color roads red
color counties by population
color counties by population 7 jenks reds
color parcels by zoning categories
color dem terrain
color dem viridis 0 3000
```

### `rgb`

Show a multi-band raster as an RGB composite  
Also: `composite`, `false color`, `true color`

```
rgb <layer> <bands>
```

| Parameter | Type | Notes |
|---|---|---|
| layer * | layer | Input layer |
| bands * | numbers | Red, green, blue band numbers (1-based), e.g. 4 3 2 |

Examples:

```
rgb landsat 4 3 2
rgb image 5 4 3
```

### `size`

Symbol size: a fixed size, or proportional to a field  
Also: `proportional`, `bubbles`, `scale by`, `width`, `radius`, `thickness`

```
size <layer> [by <field>] [value=<number>] [min <min>] [max <max>]
```

| Parameter | Type | Notes |
|---|---|---|
| layer * | layer | Input layer |
| field | field |  — introduced by `by` / `using` |
| value | number | Fixed size in pixels |
| min | number |  — introduced by `min` / `from` |
| max | number |  — introduced by `max` / `to` |

Examples:

```
size cities by pop_max
size roads 4
size quakes by mag min 2 max 30
```

### `heatmap`

Show points as a heatmap  
Also: `heat`, `density`, `hotspots`

```
heatmap <layer> [by <weight>] [radius <radius>] [<ramp>] [off]
```

| Parameter | Type | Notes |
|---|---|---|
| layer * | layer | Input layer |
| weight | field | Optional numeric weight field — introduced by `by` / `weight` / `weighted` |
| radius | number | Radius in pixels (default 20) — introduced by `radius` |
| ramp | ramp |  |
| off | flag | Go back to points |

Examples:

```
heatmap crimes
heatmap quakes by mag radius 30 magma
```

### `label`

Label features with a field or an expression  
Also: `labels`, `annotate`, `label by`

```
label <layer> [<field>] [by <text>] [size <size>] [<color>] [halo <halo>] [off]
```

| Parameter | Type | Notes |
|---|---|---|
| layer * | layer | Input layer |
| field | field | Field to show |
| text | expression | Field or expression, e.g. name \|\| ' (' \|\| pop \|\| ')' — introduced by `by` / `with` / `using` / `text` / `expression` |
| size | number | Font size (px) — introduced by `size` |
| color | color |  |
| halo | color |  — introduced by `halo` / `outline` |
| off | flag |  |

Examples:

```
label cities name
label counties by name || ': ' || population
label roads by name size 11
label cities off
```

### `unlabel`

Remove labels  
Also: `no labels`, `remove labels`, `labels off`, `hide labels`

```
unlabel <layer>
```

| Parameter | Type | Notes |
|---|---|---|
| layer * | layer | Input layer |

### `outline`

Outline color and width (polygons, points)  
Also: `stroke`, `border`, `edges`

```
outline <layer> [<color>] [width=<number>] [none] [dashed]
```

| Parameter | Type | Notes |
|---|---|---|
| layer * | layer | Input layer |
| color | color |  |
| width | number |  |
| none | flag | No outline |
| dashed | flag |  |

Examples:

```
outline counties white 1.5
outline parcels none
outline boundary black 2 dashed
```

### `fill`

Polygon fill opacity (0–100%), or "none" for outlines only  
Also: `fill opacity`, `transparent fill`, `hollow`

```
fill <layer> [value=<number>] [none]
```

| Parameter | Type | Notes |
|---|---|---|
| layer * | layer | Input layer |
| value | number |  |
| none | flag |  |

Examples:

```
fill counties 30%
fill city none
```

### `extrude`

Show polygons in 3D, extruded by a field (meters)  
Also: `3d`, `height`, `extrusion`

```
extrude <layer> [by <field>] [scale <scale>] [height=<number>] [off]
```

| Parameter | Type | Notes |
|---|---|---|
| layer * | layer | Input layer |
| field | field | Height field — introduced by `by` / `using` |
| scale | number | Multiply the field by this (default 1) — introduced by `scale` / `times` / `x` |
| height | number | Fixed height in meters |
| off | flag |  |

Examples:

```
extrude buildings by height
extrude counties by population scale 0.01
extrude parcels off
```

### `restyle`

Reset a layer to a simple default style  
Also: `reset style`, `default style`, `plain`

```
restyle <layer>
```

| Parameter | Type | Notes |
|---|---|---|
| layer * | layer | Input layer |

## Vector

### `buffer`

Polygons at a distance around features  
Also: `buf`, `buffers`, `zone around`

```
buffer <layer> <distance> [dissolve] [selected] [as <as>]
```

| Parameter | Type | Notes |
|---|---|---|
| layer * | layer | Input layer |
| distance * | distance | Distance with units, e.g. 500 m, 2 km, 1 mi |
| dissolve | flag |  |
| selected | flag | Use only the selected features |
| as | name | Name for the new layer — introduced by `as` / `named` / `called` |

Examples:

```
buffer roads 50 m
buffer schools 1 mi dissolve as school_zones
buffer parks by 400 ft selected
```

### `rings`

Concentric distance bands (e.g. 1, 2, 5 km)  
Also: `multi ring buffer`, `multiring`, `distance bands`, `ring buffer`

```
rings <layer> <distances> [overlap] [as <as>]
```

| Parameter | Type | Notes |
|---|---|---|
| layer * | layer | Input layer |
| distances * | numbers | Distances, e.g. 500, 1000, 2000 m |
| overlap | flag | Full discs instead of rings |
| as | name | Name for the new layer — introduced by `as` / `named` / `called` |

Examples:

```
rings stations 400, 800, 1200 m
rings hospital 1 2 5 mi
```

### `clip`

Keep only the parts inside a polygon layer (vector or raster)  
Also: `cookie cut`, `cut`

```
clip <layer> <clip layer> [view] [selected] [as <as>]
```

| Parameter | Type | Notes |
|---|---|---|
| layer * | layer | Input layer |
| clip layer * | layer | Input layer |
| view | flag |  |
| selected | flag | Use only the selected features |
| as | name | Name for the new layer — introduced by `as` / `named` / `called` |

Examples:

```
clip roads to city
clip parcels by floodzone as flood_parcels
clip dem to county
```

### `erase`

Remove the parts that fall inside another polygon layer  
Also: `difference`, `subtract`, `cut out`, `remove area`

```
erase <layer> <erase layer> [selected] [as <as>]
```

| Parameter | Type | Notes |
|---|---|---|
| layer * | layer | Input layer |
| erase layer * | layer | Input layer |
| selected | flag | Use only the selected features |
| as | name | Name for the new layer — introduced by `as` / `named` / `called` |

Examples:

```
erase water from counties
erase parcels with floodzone
```

### `intersect`

Pieces where two layers overlap, with attributes from both  
Also: `intersection`, `overlay`, `overlap`

```
intersect <layer> <other> [selected] [as <as>]
```

| Parameter | Type | Notes |
|---|---|---|
| layer * | layer | Input layer |
| other * | layer | Input layer |
| selected | flag | Use only the selected features |
| as | name | Name for the new layer — introduced by `as` / `named` / `called` |

Examples:

```
intersect parcels with zoning
intersect roads and counties
```

### `union`

Polygon overlay union of two layers (all pieces, attributes from both)  
Also: `overlay union`, `combine areas`

```
union <layer> <other> [as <as>]
```

| Parameter | Type | Notes |
|---|---|---|
| layer * | layer | Input layer |
| other * | layer | Input layer |
| as | name | Name for the new layer — introduced by `as` / `named` / `called` |

### `symdiff`

Areas in either layer but not both  
Also: `symmetric difference`, `xor`

```
symdiff <layer> <other> [as <as>]
```

| Parameter | Type | Notes |
|---|---|---|
| layer * | layer | Input layer |
| other * | layer | Input layer |
| as | name | Name for the new layer — introduced by `as` / `named` / `called` |

### `dissolve`

Merge features that share a value (or all of them), with statistics  
Also: `aggregate`, `merge by`, `combine by`, `group`

```
dissolve <layer> [by <fields>] [stats=<stats>] [selected] [as <as>]
```

| Parameter | Type | Notes |
|---|---|---|
| layer * | layer | Input layer |
| fields | fields | Group by these fields (none = merge everything) — introduced by `by` / `on` / `per` |
| stats | stats | e.g. sum population mean income |
| selected | flag | Use only the selected features |
| as | name | Name for the new layer — introduced by `as` / `named` / `called` |

Examples:

```
dissolve counties by state
dissolve counties by state sum population
dissolve parcels
```

### `merge`

Put several layers into one  
Also: `append`, `combine`, `combine layers`, `merge layers`

```
merge <layers> [as <as>]
```

| Parameter | Type | Notes |
|---|---|---|
| layers * | layers | Two or more layers |
| as | name | Name for the new layer — introduced by `as` / `named` / `called` |

Examples:

```
merge north_parks, south_parks as parks
merge a and b and c
```

### `centroids`

A point for every feature  
Also: `centroid`, `center points`, `centers`, `points from polygons`, `to points`

```
centroids <layer> [<method>] [selected] [as <as>]
```

| Parameter | Type | Notes |
|---|---|---|
| layer * | layer | Input layer |
| method | enum | `centroid`, `center_of_mass`, `point_on_surface` (default `centroid`) |
| selected | flag | Use only the selected features |
| as | name | Name for the new layer — introduced by `as` / `named` / `called` |

Examples:

```
centroids counties
centroids parcels inside
```

### `hull`

Convex (or concave) hull around features  
Also: `convex hull`, `concave hull`, `envelope around`, `outline around`

```
hull <layer> [concave] [by <by>] [edge <maxEdge>] [selected] [as <as>]
```

| Parameter | Type | Notes |
|---|---|---|
| layer * | layer | Input layer |
| concave | flag |  |
| by | field |  — introduced by `by` / `per` / `for each` |
| maxEdge | distance | Concave hull max edge length — introduced by `edge` / `max` |
| selected | flag | Use only the selected features |
| as | name | Name for the new layer — introduced by `as` / `named` / `called` |

Examples:

```
hull stores
hull crimes by district
hull trees concave edge 200 m
```

### `bbox`

Bounding boxes (per feature, or one for the layer)  
Also: `envelope`, `bounding box`, `extent`, `envelopes`, `boxes`

```
bbox <layer> [whole] [as <as>]
```

| Parameter | Type | Notes |
|---|---|---|
| layer * | layer | Input layer |
| whole | flag | One box for the whole layer |
| as | name | Name for the new layer — introduced by `as` / `named` / `called` |

Examples:

```
bbox parcels
bbox counties whole
```

### `simplify`

Remove detail (Douglas-Peucker) to a tolerance  
Also: `generalize`, `generalise`, `smooth out`

```
simplify <layer> <tolerance> [hq] [selected] [as <as>]
```

| Parameter | Type | Notes |
|---|---|---|
| layer * | layer | Input layer |
| tolerance * | distance | Tolerance, e.g. 50 m |
| hq | flag |  |
| selected | flag | Use only the selected features |
| as | name | Name for the new layer — introduced by `as` / `named` / `called` |

Examples:

```
simplify coastline 200 m
simplify counties 1 km
```

### `smooth`

Smooth lines and polygons  
Also: `smoothen`, `chaikin`, `round corners`

```
smooth <layer> [iterations=<integer>] [selected] [as <as>]
```

| Parameter | Type | Notes |
|---|---|---|
| layer * | layer | Input layer |
| iterations | integer |  (default `3`) |
| selected | flag | Use only the selected features |
| as | name | Name for the new layer — introduced by `as` / `named` / `called` |

### `densify`

Add vertices so no segment is longer than an interval  
Also: `add vertices`

```
densify <layer> <interval> [as <as>]
```

| Parameter | Type | Notes |
|---|---|---|
| layer * | layer | Input layer |
| interval * | distance | Distance with units, e.g. 500 m, 2 km, 1 mi |
| as | name | Name for the new layer — introduced by `as` / `named` / `called` |

### `voronoi`

Voronoi (Thiessen) polygons around points  
Also: `thiessen`, `thiessen polygons`, `service areas`, `proximity polygons`

```
voronoi <layer> [clip <clipTo>] [as <as>]
```

| Parameter | Type | Notes |
|---|---|---|
| layer * | layer | Input layer |
| clipTo | layer | Input layer — introduced by `clip` / `within` / `in` / `to` |
| as | name | Name for the new layer — introduced by `as` / `named` / `called` |

Examples:

```
voronoi hospitals
voronoi stations clip city
```

### `delaunay`

Delaunay triangles between points  
Also: `tin`, `triangulate`, `triangulation`

```
delaunay <layer> [as <as>]
```

| Parameter | Type | Notes |
|---|---|---|
| layer * | layer | Input layer |
| as | name | Name for the new layer — introduced by `as` / `named` / `called` |

### `explode`

Split multi-part features into single parts  
Also: `multipart to singlepart`, `split parts`, `singlepart`

```
explode <layer> [as <as>]
```

| Parameter | Type | Notes |
|---|---|---|
| layer * | layer | Input layer |
| as | name | Name for the new layer — introduced by `as` / `named` / `called` |

### `lines`

Polygon outlines as lines  
Also: `polygons to lines`, `boundaries of`, `to lines`, `outlines`

```
lines <layer> [as <as>]
```

| Parameter | Type | Notes |
|---|---|---|
| layer * | layer | Input layer |
| as | name | Name for the new layer — introduced by `as` / `named` / `called` |

### `polygons`

Close lines into polygons  
Also: `lines to polygons`, `to polygons`, `polygonize`

```
polygons <layer> [as <as>]
```

| Parameter | Type | Notes |
|---|---|---|
| layer * | layer | Input layer |
| as | name | Name for the new layer — introduced by `as` / `named` / `called` |

### `vertices`

Every vertex as a point  
Also: `extract vertices`, `nodes`, `points from lines`

```
vertices <layer> [as <as>]
```

| Parameter | Type | Notes |
|---|---|---|
| layer * | layer | Input layer |
| as | name | Name for the new layer — introduced by `as` / `named` / `called` |

### `points along`

Points at regular intervals along lines  
Also: `along`, `stations along`, `points every`, `interpolate points`

```
points along <layer> every <interval> [as <as>]
```

| Parameter | Type | Notes |
|---|---|---|
| layer * | layer | Input layer |
| interval * | distance | Distance with units, e.g. 500 m, 2 km, 1 mi — introduced by `every` / `each` |
| as | name | Name for the new layer — introduced by `as` / `named` / `called` |

Examples:

```
points along trail every 100 m
```

### `intersections`

Points where lines cross  
Also: `line intersections`, `crossings`, `junctions`

```
intersections <layer> [<other>] [as <as>]
```

| Parameter | Type | Notes |
|---|---|---|
| layer * | layer | Input layer |
| other | layer | Input layer |
| as | name | Name for the new layer — introduced by `as` / `named` / `called` |

Examples:

```
intersections streets
intersections roads with rivers
```

### `split`

Split lines where they cross another layer  
Also: `split lines`, `break lines`

```
split <layer> [<by>] [as <as>]
```

| Parameter | Type | Notes |
|---|---|---|
| layer * | layer | Input layer |
| by | layer | Input layer |
| as | name | Name for the new layer — introduced by `as` / `named` / `called` |

### `spatial join`

Attach attributes (or counts/stats) from another layer based on location  
Also: `spatialjoin`, `sjoin`, `join by location`, `location join`

```
spatial join <layer> <join> [<predicate>] [<mode>] [fields <fields>] [stats=<stats>] [distance <distance>] [as <as>]
```

| Parameter | Type | Notes |
|---|---|---|
| layer * | layer | Target layer (gets the new attributes) |
| join * | layer | Layer to take attributes from |
| predicate | enum | `intersects`, `within`, `contains`, `touches`, `crosses`, `near` (default `intersects`) |
| mode | enum | `first`, `summary`, `all` (default `first`) |
| fields | fields |  — introduced by `fields` / `keep` / `columns` |
| stats | stats |  |
| distance | distance | Distance with units, e.g. 500 m, 2 km, 1 mi — introduced by `distance` |
| as | name | Name for the new layer — introduced by `as` / `named` / `called` |

Examples:

```
spatial join schools with districts
spatial join tracts with crimes summary sum damage
spatial join stores with zones fields zone_id
```

### `nearest`

Distance to (and attributes of) the nearest feature in another layer  
Also: `closest`, `distance to nearest`, `nearest neighbor`, `near`, `proximity`

```
nearest <layer> <other layer> [fields <fields>] [max <max>] [<units>] [as <as>]
```

| Parameter | Type | Notes |
|---|---|---|
| layer * | layer | Input layer |
| other layer * | layer | Input layer |
| fields | fields |  — introduced by `fields` / `keep` |
| max | distance | Distance with units, e.g. 500 m, 2 km, 1 mi — introduced by `max` / `within` / `limit` |
| units | enum | `meters`, `kilometers`, `miles`, `feet` (default `meters`) |
| as | name | Name for the new layer — introduced by `as` / `named` / `called` |

Examples:

```
nearest schools to hospitals
nearest homes to stations fields name units mi
```

### `grid`

Make a hexagon/square/triangle/point grid over a layer or the view  
Also: `hexgrid`, `hex grid`, `hexbin`, `fishnet`, `square grid`, `tessellate`

```
grid [<type>] <size> [over <over>] [clip] [as <as>]
```

| Parameter | Type | Notes |
|---|---|---|
| type | enum | `hex`, `square`, `triangle`, `point` (default `hex`) |
| size * | distance | Cell size, e.g. 500 m |
| over | layer | Layer whose extent to cover (default: the view) — introduced by `over` / `on` / `in` / `within` / `covering` / `for` |
| clip | flag | Keep only cells touching the layer's polygons |
| as | name | Name for the new layer — introduced by `as` / `named` / `called` |

Examples:

```
grid hex 1 km over chicago
grid square 500 m
grid hex 2 mi over counties clip
```

### `random`

Random points in the view, a box, or inside polygons  
Also: `random points`, `sample points`, `scatter`

```
random count=<integer> [in <within>] [seed <seed>] [as <as>]
```

| Parameter | Type | Notes |
|---|---|---|
| count * | integer |  |
| within | layer | Input layer — introduced by `in` / `within` / `inside` / `over` |
| seed | number |  — introduced by `seed` |
| as | name | Name for the new layer — introduced by `as` / `named` / `called` |

Examples:

```
random 500 points in neighborhoods
random 100
```

### `cluster`

Cluster points (k-means or DBSCAN) — adds a "cluster" field  
Also: `clusters`, `kmeans`, `dbscan`, `group points`

```
cluster <layer> [<method>] [k=<integer>] [<distance>] [min <min>] [as <as>]
```

| Parameter | Type | Notes |
|---|---|---|
| layer * | layer | Input layer |
| method | enum | `kmeans`, `dbscan` (default `kmeans`) |
| k | integer | Number of clusters (k-means) |
| distance | distance | Neighbourhood distance (DBSCAN) |
| min | integer | Min points per cluster (DBSCAN) — introduced by `min` / `minpoints` / `min-points` |
| as | name | Name for the new layer — introduced by `as` / `named` / `called` |

Examples:

```
cluster stores kmeans 8
cluster crimes dbscan 200 m min 5
```

### `measure`

Add area / length / perimeter fields — or measure on the map (measure distance | measure area)  
Also: `calculate geometry`, `add area`, `add length`, `geometry attributes`, `area`, `length`

```
measure [<layer>] [<mode>] [<units>] [as <as>]
```

| Parameter | Type | Notes |
|---|---|---|
| layer | layer | Input layer |
| mode | enum | `distance`, `area` |
| units | enum | `meters`, `kilometers`, `miles`, `feet`, `hectares`, `acres`, `sqkm`, `sqmi`, `sqm`, `sqft` |
| as | name | Name for the new layer — introduced by `as` / `named` / `called` |

Examples:

```
measure parcels acres
measure roads miles
measure distance
measure area
```

### `validate`

Find invalid geometries (self-intersections, open rings…)  
Also: `check geometry`, `check geometries`, `validity`

```
validate <layer>
```

| Parameter | Type | Notes |
|---|---|---|
| layer * | layer | Input layer |

### `fix`

Repair invalid geometries  
Also: `make valid`, `repair`, `fix geometry`, `fix geometries`

```
fix <layer> [as <as>]
```

| Parameter | Type | Notes |
|---|---|---|
| layer * | layer | Input layer |
| as | name | Name for the new layer — introduced by `as` / `named` / `called` |

## Raster

### `hillshade`

Shaded relief from an elevation raster  
Also: `shaded relief`, `relief`

```
hillshade <layer> [band <band>] [azimuth <azimuth>] [altitude <altitude>] [z <z>] [as <as>]
```

| Parameter | Type | Notes |
|---|---|---|
| layer * | layer | Input layer |
| band | integer | Band number (1-based, default 1) — introduced by `band` |
| azimuth | number |  (default `315`) — introduced by `azimuth` / `sun` |
| altitude | number |  (default `45`) — introduced by `altitude` / `elevation` / `angle` |
| z | number |  (default `1`) — introduced by `z` / `exaggeration` / `zfactor` |
| as | name | Name for the new layer — introduced by `as` / `named` / `called` |

Examples:

```
hillshade dem
hillshade dem azimuth 270 z 2
```

### `slope`

Slope from an elevation raster (degrees or percent)

```
slope <layer> [band <band>] [<units>] [as <as>]
```

| Parameter | Type | Notes |
|---|---|---|
| layer * | layer | Input layer |
| band | integer | Band number (1-based, default 1) — introduced by `band` |
| units | enum | `degrees`, `percent` (default `degrees`) |
| as | name | Name for the new layer — introduced by `as` / `named` / `called` |

### `aspect`

Aspect (direction a slope faces) from an elevation raster

```
aspect <layer> [band <band>] [as <as>]
```

| Parameter | Type | Notes |
|---|---|---|
| layer * | layer | Input layer |
| band | integer | Band number (1-based, default 1) — introduced by `band` |
| as | name | Name for the new layer — introduced by `as` / `named` / `called` |

### `contours`

Contour lines from a raster (e.g. every 10 m)  
Also: `contour`, `contour lines`, `isolines`

```
contours <layer> interval=<number> [base <base>] [band <band>] [as <as>]
```

| Parameter | Type | Notes |
|---|---|---|
| layer * | layer | Input layer |
| interval * | number | Contour interval in raster units |
| base | number |  — introduced by `base` / `from` |
| band | integer | Band number (1-based, default 1) — introduced by `band` |
| as | name | Name for the new layer — introduced by `as` / `named` / `called` |

Examples:

```
contours dem 25
contours temperature 2 band 1
```

### `bandmath`

Compute a new raster from an expression over bands (b1, b2, … or other rasters by name)  
Also: `raster calculator`, `map algebra`, `raster calc`, `calc raster`, `band math`

```
bandmath <raster> = <expression> [as <name>]
```

| Parameter | Type | Notes |
|---|---|---|
| layer * | layer | Main raster (its bands are b1, b2, …) |
| expression * | expression |  — introduced by `=` / `expression` / `expr` / `formula` / `:` |
| as | name | Name for the new layer — introduced by `as` / `named` / `called` |

Examples:

```
bandmath landsat = (b5 - b4) / (b5 + b4) as ndvi
bandmath dem = if(b1 > 1000, 1, 0) as highlands
bandmath dem2020 = dem2020 - dem2010 as change
```

### `ndvi`

NDVI = (NIR − red) / (NIR + red) from a multispectral raster  
Also: `vegetation index`

```
ndvi <layer> [red <red>] [nir <nir>] [as <as>]
```

| Parameter | Type | Notes |
|---|---|---|
| layer * | layer | Input layer |
| red | integer |  — introduced by `red` / `r` |
| nir | integer |  — introduced by `nir` / `infrared` / `ir` |
| as | name | Name for the new layer — introduced by `as` / `named` / `called` |

Examples:

```
ndvi naip
ndvi landsat red 4 nir 5
ndvi sentinel red 4 nir 8
```

### `reclassify`

Map value ranges to new values (0-100:1, 100-500:2, >500:3)  
Also: `reclass`, `classify raster`, `recode`

```
reclassify <layer> <rules> [band <band>] [as <as>]
```

| Parameter | Type | Notes |
|---|---|---|
| layer * | layer | Input layer |
| rules * | text | e.g. 0-100:1, 100-500:2, >500:3 |
| band | integer | Band number (1-based, default 1) — introduced by `band` |
| as | name | Name for the new layer — introduced by `as` / `named` / `called` |

Examples:

```
reclassify dem 0-200:1, 200-500:2, >500:3 as elevation_zones
```

### `zonal`

Raster statistics inside each polygon (mean, sum, min, max, …)  
Also: `zonal stats`, `zonal statistics`, `summarize raster`

```
zonal <layer> <zones> [stats <stats>] [band <band>] [as <as>]
```

| Parameter | Type | Notes |
|---|---|---|
| layer * | layer | Input layer |
| zones * | layer | Input layer |
| stats | text | e.g. mean max (default: count mean min max sum) — introduced by `stats` / `statistics` |
| band | integer | Band number (1-based, default 1) — introduced by `band` |
| as | name | Name for the new layer — introduced by `as` / `named` / `called` |

Examples:

```
zonal dem by counties
zonal ndvi in parks stats mean max
```

### `sample raster`

Read raster values at point locations into a field  
Also: `extract values`, `values to points`, `sample values`, `extract raster values`

```
sample raster <layer> <points> [<method>] [as <as>]
```

| Parameter | Type | Notes |
|---|---|---|
| layer * | layer | Input layer |
| points * | layer | Input layer |
| method | enum | `nearest`, `bilinear` (default `nearest`) |
| as | name | Name for the new layer — introduced by `as` / `named` / `called` |

Examples:

```
sample raster dem at wells
sample raster ndvi at plots bilinear
```

### `idw`

Interpolate a surface (raster) from point values (inverse distance weighting)  
Also: `interpolate`, `interpolation`, `surface from points`, `inverse distance`

```
idw <layer> <field> [cell <cell>] [power <power>] [as <as>]
```

| Parameter | Type | Notes |
|---|---|---|
| layer * | layer | Input layer |
| field * | field |  |
| cell | distance | Cell size, e.g. 100 m (default: ~256 cells across) — introduced by `cell` / `resolution` / `cellsize` / `pixel` |
| power | number |  (default `2`) — introduced by `power` / `p` |
| as | name | Name for the new layer — introduced by `as` / `named` / `called` |

Examples:

```
idw stations temperature
idw wells depth cell 50 m power 3
```

### `raster info`

Size, bands, CRS and statistics of a raster  
Also: `bands`

```
raster info <layer>
```

| Parameter | Type | Notes |
|---|---|---|
| layer * | layer | Input layer |

## Draw & edit

### `delete`

Delete the selected features (or those matching where …)  
Also: `delete features`, `remove features`, `delete selected`, `erase features`

```
delete <layer> [where <where>] [selected]
```

| Parameter | Type | Notes |
|---|---|---|
| layer * | layer | Input layer |
| where | expression | Expression, e.g. "population" > 1000 — introduced by `where` |
| selected | flag |  |

Examples:

```
delete selected
delete parcels where area < 10
```

### `draw`

Draw new features on the map (Esc or "done" to stop)  
Also: `sketch`, `digitize`, `add feature`, `new feature`

```
draw <shape> [into <into>]
```

| Parameter | Type | Notes |
|---|---|---|
| shape * | enum | `point`, `line`, `polygon`, `rectangle`, `circle`, `freehand` |
| into | layer | Layer to add to (default: a sketch layer) — introduced by `into` / `in` / `on` / `to` |

Examples:

```
draw polygon
draw point into schools
draw line
```

### `edit`

Drag vertices of the selected features (or a small layer); "done" saves, "cancel" discards  
Also: `edit geometry`, `reshape`, `modify`, `edit vertices`, `move vertices`

```
edit <layer>
```

| Parameter | Type | Notes |
|---|---|---|
| layer * | layer | Input layer |

Examples:

```
edit parcels
```

### `done`

Finish drawing / save edits  
Also: `finish`, `save edits`, `stop`, `stop drawing`, `ok`

```
done
```

### `cancel`

Stop drawing or editing without saving  
Also: `discard`, `discard edits`, `abort`

```
cancel
```

## GDAL

### `ogr2ogr`

Convert / reproject / filter vector data (SQL with SpatiaLite via -dialect SQLite)

```
ogr2ogr [<args>]
```

Examples:

```
ogr2ogr -f GPKG roads.gpkg roads
ogr2ogr -t_srs EPSG:3435 -f "ESRI Shapefile" roads_il.shp roads
ogr2ogr -dialect SQLite -sql "SELECT ST_Buffer(geometry, 0.001) AS geometry, * FROM roads" roads_buf roads
ogr2ogr -where "population > 1000000" big_cities cities
```

### `ogrinfo`

Describe a vector dataset

```
ogrinfo [<args>]
```

Examples:

```
ogrinfo -so roads
```

### `gdal_translate`

Convert raster formats, subset bands/windows, rescale

```
gdal_translate [<args>]
```

Examples:

```
gdal_translate -of PNG dem dem.png
gdal_translate -b 1 -b 2 -b 3 image rgb.tif
```

### `gdalwarp`

Reproject, resample or clip rasters (-cutline <layer>)

```
gdalwarp [<args>]
```

Examples:

```
gdalwarp -t_srs EPSG:3857 -r bilinear dem dem_3857.tif
gdalwarp -cutline city -crop_to_cutline dem dem_city.tif
```

### `gdal_rasterize`

Burn vector features into a raster

```
gdal_rasterize [<args>]
```

Examples:

```
gdal_rasterize -a population -tr 0.01 0.01 counties pop.tif
```

### `gdalinfo`

Describe a raster dataset

```
gdalinfo [<args>]
```

Examples:

```
gdalinfo dem
```

### `gdal_location_info`

Raster values at a coordinate

```
gdal_location_info [<args>]
```

### `gdaltransform`

Transform coordinates between CRSs

```
gdaltransform [<args>]
```

### `gdaldem`

Hillshade, slope, aspect, color-relief, TRI, TPI, roughness

```
gdaldem [<args>]
```

Examples:

```
gdaldem hillshade dem shade.tif
gdaldem slope dem slope.tif
```

### `gdalbuildvrt`

Mosaic rasters into a virtual raster

```
gdalbuildvrt [<args>]
```

### `gdal`

GDAL status, formats and help (gdal formats · gdal load · gdal help)  
Also: `gdal help`

```
gdal [<what>]
```

| Parameter | Type | Notes |
|---|---|---|
| what | enum | `help`, `formats`, `load`, `version`, `files` (default `help`) |

## Scripting

### `history`

Show (or save) the commands you ran

```
history [save]
```

| Parameter | Type | Notes |
|---|---|---|
| save | flag | Download them as a script |

### `script`

Open the script editor to run many commands at once  
Also: `run script`, `macro`, `editor`, `batch`

```
script
```

### `js`

Run JavaScript with the PSICITS API (layers, turf, run(), add())  
Also: `javascript`, `eval`

```
js <code>
```

Examples:

```
js return layers.roads.features.length
js add(turf.randomPoint(100, {bbox: view()}), "random")
js await run('buffer roads 100 m')
```
