/*
 * PSICITS — shared helpers for tool definitions.
 * Tool files must not touch the DOM at load time (they are also loaded in
 * Node to test command parsing).
 */
(function (root) {
  'use strict';

  const M = root.PSICITS;
  const util = M.util;

  const T = (M.toolkit = {});

  /** Parameter shorthands. */
  T.P = {
    layer: function (name, o) { return Object.assign({ name: name || 'layer', type: 'layer', required: true, description: 'Input layer' }, o || {}); },
    as: function () { return { name: 'as', type: 'name', keywords: ['as', 'named', 'called'], keys: ['name', 'output'], description: 'Name for the new layer' }; },
    distance: function (name, o) { return Object.assign({ name: name || 'distance', type: 'distance', required: true, description: 'Distance with units, e.g. 500 m, 2 km, 1 mi' }, o || {}); },
    where: function (o) { return Object.assign({ name: 'where', type: 'expression', keywords: ['where'], description: 'Expression, e.g. "population" > 1000' }, o || {}); },
    flag: function (name, words, description) { return { name: name, type: 'flag', words: words || [name], description: description || '' }; },
    choice: function (name, options, o) { return Object.assign({ name: name, type: 'enum', options: options }, o || {}); },
    number: function (name, o) { return Object.assign({ name: name, type: 'number' }, o || {}); },
    integer: function (name, o) { return Object.assign({ name: name, type: 'integer' }, o || {}); },
    field: function (name, o) { return Object.assign({ name: name || 'field', type: 'field', of: 'layer' }, o || {}); },
  };

  T.define = function (def) { return M.commands.define(def); };

  /** Default output name "<layer>_<suffix>". */
  T.outName = function (ctx, args, layer, suffix) {
    return ctx.name(args.as, (layer ? layer.name : 'result') + (suffix ? '_' + suffix : ''));
  };

  T.unitShort = function (u) {
    return { meters: 'm', kilometers: 'km', miles: 'mi', feet: 'ft', yards: 'yd', nauticalmiles: 'nmi', centimeters: 'cm', inches: 'in', usfeet: 'usft' }[u] || u;
  };
  T.distLabel = function (d) { return d ? (+d.value.toPrecision(6)) + T.unitShort(d.units) : ''; };

  T.plural = function (n, one, many) { return util.formatNumber(n, 0) + ' ' + (n === 1 ? one : (many || one + 's')); };

  /** Vector features to work on: the selection if requested/available, else all. */
  T.features = function (ctx, layer, selectedOnly) {
    if (selectedOnly) {
      const sel = ctx.store.selectedFeatures(layer.id);
      if (!sel.length) throw new Error('Nothing is selected in "' + layer.name + '"');
      return { type: 'FeatureCollection', features: sel };
    }
    return layer.data;
  };

  /** Throw a friendly error unless the layer has the given geometry families. */
  T.needGeom = function (layer, fams, what) {
    const g = layer.geometryType;
    if (g === 'Mixed') return;
    if (fams.indexOf(g) < 0) {
      const words = { Point: 'points', LineString: 'lines', Polygon: 'polygons', None: 'no geometry' };
      throw new Error('"' + layer.name + '" has ' + (words[g] || g) + '; ' + (what || 'this tool') + ' needs ' + fams.map(function (f) { return words[f]; }).join(' or ') + '.');
    }
  };

  /** Short layer description for listings. */
  T.describe = function (l) {
    if (l.type === 'raster') return 'raster ' + l.raster.width + '×' + l.raster.height + ', ' + l.raster.bands.length + ' band' + (l.raster.bands.length > 1 ? 's' : '');
    if (l.type === 'tiles') return 'tile layer';
    const g = { Point: 'points', LineString: 'lines', Polygon: 'polygons', Mixed: 'mixed geometry', None: 'table' }[l.geometryType] || l.geometryType;
    return g + ' · ' + T.plural(l.count, l.geometryType === 'None' ? 'row' : 'feature');
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
