'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const M = require('./harness').load('expr');
const E = M.expr;

const feat = (props, geometry) => ({ type: 'Feature', properties: props, geometry: geometry || null });
const ev = (src, props, opts) => E.evaluate(src, feat(props || {}), opts);

const fc = {
  type: 'FeatureCollection',
  features: [
    feat({ name: 'Chicago', state: 'IL', pop: 2700000, area_km: 606, founded: '1837-03-04', zip: '60601' }),
    feat({ name: 'Springfield', state: 'IL', pop: 114000, area_km: 155, founded: '1821-01-01', zip: '62701' }),
    feat({ name: 'Gary', state: 'IN', pop: 69000, area_km: 147, founded: '1906-01-01', zip: null }),
    feat({ name: 'Indianapolis', state: 'IN', pop: 880000, area_km: 953, founded: '1821-01-06', zip: '46201' }),
  ],
};

test('arithmetic and precedence', () => {
  assert.equal(ev('1 + 2 * 3'), 7);
  assert.equal(ev('(1 + 2) * 3'), 9);
  assert.equal(ev('2 ^ 3 ^ 2'), 512); // right associative
  assert.equal(ev('-2 ^ 2'), -4);
  assert.equal(ev('7 // 2'), 3);
  assert.equal(ev('7 % 4'), 3);
  assert.equal(ev('10 / 0'), null); // division by zero -> NULL
  assert.equal(ev('1.5e3 + .5'), 1500.5);
  assert.equal(ev('NULL + 1'), null);
});

test('text operations', () => {
  assert.equal(ev("'a' || 'b'"), 'ab');
  assert.equal(ev("'n=' + 5"), 'n=5');
  assert.equal(ev("upper(name) || '!'", { name: 'hi' }), 'HI!');
  assert.equal(ev("substr('Hyde Park', 2, 3)"), 'yde');
  assert.equal(ev("substr('Hyde Park', -3)"), 'ark');
  assert.equal(ev("replace('a-b-c', '-', '_')"), 'a_b_c');
  assert.equal(ev("title('the windy city')"), 'The Windy City');
  assert.equal(ev("length('héllo')"), 5);
  assert.equal(ev("concat('a', NULL, 'b')"), 'ab');
  assert.equal(ev("'it''s'"), "it's");
  assert.equal(ev("lpad('7', 3, '0')"), '007');
  assert.equal(ev("split_part('a,b,c', ',', 2)"), 'b');
  assert.equal(ev("regexp_replace('abc123', '[0-9]+', '#')"), 'abc#');
  assert.equal(ev("format_number(1234567.891, 1)"), '1,234,567.9');
});

test('comparisons are loosely numeric', () => {
  assert.equal(ev('zip = 60601', { zip: '60601' }), true);
  assert.equal(ev("zip = '60601'", { zip: '60601' }), true);
  assert.equal(ev('pop > 1000', { pop: '2000' }), true);
  assert.equal(ev("'b' > 'a'"), true);
  assert.equal(ev('1 <> 2'), true);
  assert.equal(ev('1 == 1'), true);
  assert.equal(ev("name ~ '^Chi'", { name: 'Chicago' }), true);
});

test('three-valued logic and NULL handling', () => {
  assert.equal(ev('NULL AND FALSE'), false);
  assert.equal(ev('NULL AND TRUE'), null);
  assert.equal(ev('NULL OR TRUE'), true);
  assert.equal(ev('NOT NULL'), null);
  assert.equal(ev('x IS NULL', { x: null }), true);
  assert.equal(ev('x IS NULL', {}), true);
  assert.equal(ev('x IS NOT NULL', { x: 0 }), true);
  assert.equal(ev('x = NULL', { x: null }), true); // friendly: = NULL means IS NULL
  assert.equal(ev('x != NULL', { x: 3 }), true);
  assert.equal(ev('x > 5', { x: null }), null);
  assert.equal(ev('coalesce(x, y, 3)', { x: null }), 3);
  assert.equal(ev('nullif(4, 4)'), null);
});

test('IN, LIKE, BETWEEN, CASE and if()', () => {
  assert.equal(ev("state IN ('IL', 'IN')", { state: 'IN' }), true);
  assert.equal(ev("state NOT IN ('IL')", { state: 'IN' }), true);
  assert.equal(ev('n IN (1, 2, 3)', { n: '2' }), true);
  assert.equal(ev("name LIKE 'Chi%'", { name: 'Chicago' }), true);
  assert.equal(ev("name LIKE 'chi%'", { name: 'Chicago' }), false);
  assert.equal(ev("name ILIKE 'chi%'", { name: 'Chicago' }), true);
  assert.equal(ev("name LIKE 'G_ry'", { name: 'Gary' }), true);
  assert.equal(ev("name NOT LIKE '%x%'", { name: 'Gary' }), true);
  assert.equal(ev('v BETWEEN 1 AND 10', { v: 10 }), true);
  assert.equal(ev('v NOT BETWEEN 1 AND 10', { v: 11 }), true);
  assert.equal(ev("CASE WHEN v > 5 THEN 'big' WHEN v > 1 THEN 'mid' ELSE 'small' END", { v: 3 }), 'mid');
  assert.equal(ev("CASE s WHEN 'IL' THEN 1 WHEN 'IN' THEN 2 END", { s: 'IN' }), 2);
  assert.equal(ev("CASE WHEN FALSE THEN 1 END"), null);
  assert.equal(ev("if(v > 5, 'big', 'small')", { v: 9 }), 'big');
  assert.equal(ev('b IS TRUE', { b: true }), true);
});

test('math, dates and units', () => {
  assert.equal(ev('round(3.14159, 2)'), 3.14);
  assert.equal(ev('round(2.5)'), 3);
  assert.equal(ev('max(1, 7, 3)'), 7);
  assert.equal(ev('clamp(0, 12, 10)'), 10);
  assert.equal(ev('sqrt(-1)'), null);
  assert.equal(ev('log(10, 1000)'), 3);
  assert.equal(ev("scale_linear(5, 0, 10, 0, 100)"), 50);
  assert.equal(ev("year(founded)", { founded: '1837-03-04' }), 1837);
  assert.equal(ev("month('2020-11-05')"), 11);
  assert.equal(ev("format_date('2021-02-03T04:05:06Z', 'YYYY/MM/DD HH:mm')"), '2021/02/03 04:05');
  assert.equal(ev("day_diff('2020-01-11', '2020-01-01')"), 10);
  assert.ok(Math.abs(ev("convert(1, 'mi', 'km')") - 1.609344) < 1e-9);
  assert.ok(Math.abs(ev("convert(1, 'acres', 'sqm')") - 4046.8564224) < 1e-6);
  assert.throws(() => ev("convert(1, 'mi', 'acres')"), /mismatched units/);
});

test('field resolution: quoting, case-insensitivity, suggestions', () => {
  const fields = ['Population', 'Median Income', 'name'];
  assert.equal(ev('population * 2', { Population: 5 }, { fields }), 10);
  assert.equal(ev('"Median Income" / 1000', { 'Median Income': 52000 }, { fields }), 52);
  assert.equal(ev('median_income', { 'Median Income': 7 }, { fields }), 7);
  assert.throws(() => E.compile('populaton > 5', { fields }), /Did you mean "Population"/);
  const c = E.compile('name = "Chicago"', { fields });
  assert.equal(c.fn(feat({ name: 'Chicago' })), true);
  assert.equal(c.warnings.length, 1);
  assert.deepEqual(E.compile('"name" || Population', { fields }).fieldsUsed.sort(), ['Population', 'name']);
});

test('geometry variables', () => {
  const sq = { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]] };
  const area = E.evaluate('$area', feat({}, sq));
  assert.ok(Math.abs(area / 1e6 - 12308.8) / 12308.8 < 0.01, 'area ~ 12,309 km2 got ' + area / 1e6);
  const line = { type: 'LineString', coordinates: [[0, 0], [0, 1]] };
  const len = E.evaluate('$length', feat({}, line));
  assert.ok(Math.abs(len - 111195) < 200, 'length ~111 km got ' + len);
  assert.equal(E.evaluate('$x', feat({}, { type: 'Point', coordinates: [-87.6, 41.8] })), -87.6);
  assert.equal(E.evaluate('$geomtype', feat({}, sq)), 'Polygon');
  assert.equal(E.evaluate('$npoints', feat({}, sq)), 5);
  assert.ok(E.compile('$area > 0').usesGeometry);
  assert.throws(() => E.compile('$aera'), /Did you mean \$area/);
  const f = feat({}, sq); f.id = 42;
  assert.equal(E.evaluate('$id', f), 42);
});

test('aggregates over a layer, with and without grouping', () => {
  const total = 2700000 + 114000 + 69000 + 880000;
  assert.deepEqual(E.calculate(fc, 'sum(pop)'), [total, total, total, total]);
  const share = E.calculate(fc, 'round(pop / sum(pop, state) * 100, 1)');
  assert.equal(share[0], 95.9);
  assert.equal(share[3], 92.7);
  assert.deepEqual(E.calculate(fc, 'count()'), [4, 4, 4, 4]);
  assert.deepEqual(E.calculate(fc, 'count(zip)'), [3, 3, 3, 3]);
  assert.deepEqual(E.calculate(fc, 'maximum(name)'), ['Springfield', 'Springfield', 'Springfield', 'Springfield']);
  assert.equal(E.calculate(fc, 'mean(area_km, state)')[2], 550);
  assert.equal(E.calculate(fc, 'median(pop)')[0], (114000 + 880000) / 2);
  assert.throws(() => E.compile('sum(sum(pop))'), /nested/);
  assert.throws(() => E.compile('sum(pop)').fn(fc.features[0], 0), /need a layer/);
});

test('filter returns matching indices', () => {
  assert.deepEqual(E.filter(fc, "state = 'IL' AND pop > 200000"), [0]);
  assert.deepEqual(E.filter(fc, 'zip IS NULL'), [2]);
  assert.deepEqual(E.filter(fc, 'pop > mean(pop)'), [0]);
  assert.deepEqual(E.filter(fc, 'pop > median(pop)'), [0, 3]);
  assert.deepEqual(E.filter(fc, "name ILIKE '%in%'"), [1, 3]);
});

test('helpful syntax errors', () => {
  assert.throws(() => E.parse('pop > '), /ends too early/);
  assert.throws(() => E.parse("name = 'abc"), /Unterminated text/);
  assert.throws(() => E.parse('(1 + 2'), /Expected "\)"/);
  assert.throws(() => E.parse('pop 5'), /operator .* missing/);
  assert.throws(() => E.compile('uppr(name)'), /Did you mean upper\(\)/);
  const r = E.check('a >', {});
  assert.equal(r.ok, false);
  assert.ok(r.error);
  assert.equal(E.check('a > 1').ok, true);
});

test('user text is never executed as code', () => {
  assert.throws(() => E.parse("constructor.constructor('return process')()"), /Unexpected character/);
  assert.equal(ev("'\"); throw 1; //'"), '"); throw 1; //');
  assert.equal(ev('"x\\"y" IS NULL', {}), true);
  assert.equal(ev('__proto__ IS NULL', {}), false); // resolves to a property lookup, nothing more
  assert.throws(() => E.compile('process()'), /Unknown function/);
});

test('raster band math compiles to fast numeric code', () => {
  const ndvi = E.compileRaster('(nir - red) / (nir + red)', ['b1', 'b2', 'red', 'nir']);
  assert.ok(Math.abs(ndvi.fn({ red: 0.1, nir: 0.5 }) - 0.6666667) < 1e-6);
  assert.deepEqual(ndvi.variables.sort(), ['nir', 'red']);
  const cls = E.compileRaster("if(b1 > 100, 1, 0) + (b1 BETWEEN 0 AND 50)", ['b1']);
  assert.equal(cls.fn({ b1: 150 }), 1);
  assert.equal(cls.fn({ b1: 20 }), 1);
  assert.equal(cls.fn({ b1: 70 }), 0);
  assert.equal(E.compileRaster('round(b1 / 3, 1)', ['b1']).fn({ b1: 10 }), 3.3);
  assert.equal(E.compileRaster('CASE WHEN B1 < 0 THEN 0 ELSE sqrt(b1) END', ['b1']).fn({ b1: 16 }), 4);
  assert.throws(() => E.compileRaster('b9 * 2', ['b1', 'b2']), /Unknown band "b9"/);
  assert.throws(() => E.compileRaster("b1 || 'x'", ['b1']), /Text is not allowed|Cannot use/);
});

test('literal and quoteField helpers', () => {
  assert.equal(E.literal("O'Hare"), "'O''Hare'");
  assert.equal(E.literal(3), '3');
  assert.equal(E.literal(null), 'NULL');
  assert.equal(E.quoteField('my "field"'), '"my ""field"""');
  assert.equal(ev(E.quoteField('my "field"') + ' + 1', { 'my "field"': 1 }), 2);
  const ref = E.reference();
  assert.ok(ref.functions.find((f) => f.name === 'upper'));
  assert.ok(ref.variables.find((v) => v.name === '$area'));
});
