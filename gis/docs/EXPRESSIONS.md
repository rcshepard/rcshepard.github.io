# Expressions

Expressions are used by `select … where`, `filter`, `extract … where`, `count … where`, `calc`, `label … by`, `delete … where` and `bandmath`. The syntax is close to SQL and QGIS expressions.

```
"population" > 10000 AND "state" IN ('IL', 'IN')
name ILIKE '%park%'
round($area / 10000, 1)                  -- hectares
CASE WHEN speed >= 55 THEN 'fast' ELSE 'slow' END
"pop" / sum("pop", "state") * 100        -- share of the state total
(nir - red) / (nir + red)                -- raster band math
```

## Values

| Write | Meaning |
|---|---|
| `population`, `"Median Income"` | A field. Use double quotes for names with spaces or odd characters. Matching ignores case (`POP` finds `pop`). |
| `'Chicago'` | Text, in single quotes. Escape a quote by doubling it: `'O''Hare'`. |
| `42`, `3.14`, `1e6` | Numbers. |
| `TRUE`, `FALSE`, `NULL` | Constants. |
| `$area`, `$length`, `$perimeter` | Geodesic area in m², and length or perimeter in m. |
| `$x`, `$y` (`$lon`, `$lat`) | Coordinates of a point, or of the centroid for other shapes. |
| `$id`, `$index`, `$geomtype`, `$npoints` | Feature id, row position, geometry type and vertex count. |

If you write `"Chicago"` with double quotes and there is no field of that name, it is treated as text and you get a warning.

## Operators

| Operator | Notes |
|---|---|
| `+ - * / % //` | Arithmetic. `//` is integer division. Division by zero gives `NULL`. `+` joins text. |
| `^` or `**` | Power, right-associative. |
| `\|\|` | Concatenate text (SQL-style). Use `concat()` to skip NULLs. |
| `= == != <> < <= > >=` | Comparison. It is numeric when both sides look like numbers, so `zip = 60601` matches `'60601'`. |
| `~` | Regular-expression match: `name ~ '^Lake'`. |
| `AND OR NOT` (and `&&`) | Three-valued logic: `NULL AND FALSE` is `FALSE`. |
| `x IN (a, b)` / `NOT IN` | Membership. |
| `x LIKE 'A%'` / `ILIKE` / `NOT LIKE` | Wildcards: `%` matches any text and `_` matches one character. `ILIKE` ignores case. |
| `x BETWEEN a AND b` | Inclusive range. |
| `x IS NULL` / `IS NOT NULL` | `x = NULL` also works and means the same as `IS NULL`. |
| `CASE WHEN … THEN … ELSE … END` | Also `CASE x WHEN 1 THEN 'a' … END`. |

## Functions

**Math:** `abs, sqrt, pow, exp, ln, log10, log(base, x), round(x [, digits]), floor, ceil, trunc, sign, min(a, b, …), max(…), clamp(min, x, max), sin, cos, tan, asin, acos, atan, atan2, radians, degrees, pi(), rand([min, max]), scale_linear(v, d0, d1, r0, r1), convert(value, 'from', 'to')`

`convert` changes units: `convert($area, 'sqm', 'acres')` or `convert($length, 'm', 'mi')`.

**Text:** `upper, lower, title, trim, ltrim, rtrim, length, substr(s, start [, len]), left, right, replace(s, find, repl), regexp_replace, regexp_match(s, pattern [, 'i']), regexp_substr, concat(…), strpos, starts_with, ends_with, contains, lpad, rpad, split_part(s, delim, n), format_number(x, decimals)`

`substr` counts from 1, and a negative start counts from the end.

**Conversion and conditionals:** `to_string, to_int, to_real, to_bool, coalesce(a, b, …), nullif(a, b), if(cond, then, else), is_null(x)`

**Dates** (ISO text such as `2024-05-01`, or epoch milliseconds): `now(), to_date, year, month, day, hour, minute, day_of_week, epoch, day_diff(a, b), format_date(d, 'YYYY-MM-DD HH:mm')`

**Aggregates** cover the whole layer. You can pass an optional group as the second argument.

`sum, mean (avg), minimum, maximum, median, stdev, count, count_distinct`

```
"pop" / sum("pop") * 100              -- percent of the layer total
"pop" > mean("pop")                   -- above-average features
"pop" / sum("pop", "state")           -- share within each state
count()                               -- number of features
```

`min()` and `max()` compare their arguments. For layer-wide extremes, use `minimum()` and `maximum()`.

## Raster band math

In `bandmath <raster> = <expression>`, the names refer to bands:

- `b1`, `b2`, … are the bands of the main raster. Named bands (for example `nir`) work too.
- Another raster layer's name means its band 1. `<name>_b2` means its band 2.

Only numbers, operators, comparisons (which give 1 or 0), `CASE`, `if()` and math functions are allowed. Pixels where any input is no-data stay no-data.

```
bandmath landsat = (b5 - b4) / (b5 + b4) as ndvi
bandmath dem = if(b1 > 1000, 1, 0) as highland
bandmath dem2020 = dem2020 - dem2010 as change
```

## Safety

Expressions are parsed and then compiled to JavaScript from a fixed set of operations, so text in an expression (or in a data file) can never run as code.
