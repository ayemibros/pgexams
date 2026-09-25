/** Small shared helpers used across route modules. */
const { parse } = require('csv-parse/sync');
const { stringify } = require('csv-stringify/sync');

/** `%value%` for a LIKE ... ESCAPE '\\' clause — Django's __icontains (MySQL's *_ci collations are case-insensitive). */
function contains(value) {
  return `%${String(value).replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

/** Python's str.strip() + " ".join semantics are not needed; this is `.strip()` for possibly-missing values. */
const str = (v) => (v === undefined || v === null ? '' : String(v));
const strip = (v) => str(v).trim();

/** Python's str.splitlines() + strip + drop blanks. */
function lines(v) {
  return str(v).split(/\r\n|\r|\n/).map((l) => l.trim()).filter(Boolean);
}

/** A positive integer id from a form value, or null. */
function intOrNull(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  return Number.isInteger(n) ? n : null;
}

/** int() that raises like Python on junk (caller decides how to handle). */
function pyInt(v) {
  const s = strip(v);
  if (!/^[-+]?\d+$/.test(s)) throw new Error(`invalid literal for int() with base 10: '${s}'`);
  return parseInt(s, 10);
}

/** Decimal(v) for a form value; returns null when it isn't a valid number (InvalidOperation). */
function decimalOrNull(v) {
  const s = strip(v);
  if (s === '' || !/^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(s)) return null;
  return Number(s);
}

/** csv.DictReader over text (BOM tolerant, ragged rows allowed, blank lines skipped). */
function readCsvDicts(text) {
  return parse(text, {
    columns: true, bom: true, skip_empty_lines: true, relax_column_count: true, relax_quotes: true, trim: false,
  });
}

/** csv.writer output (CRLF line endings, like Python's csv module). */
function writeCsv(rows) {
  return stringify(rows, { record_delimiter: 'windows' });
}

function shuffle(arr) {
  const a = arr;
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** Round to 2 dp the way Python's round(x, 2) displays for scores. */
const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

/** Python type name of a JSON-ish value (for error messages that mirror Python's). */
function pyTypeName(v) {
  if (v === null || v === undefined) return 'NoneType';
  if (typeof v === 'boolean') return 'bool';
  if (typeof v === 'number') return Number.isInteger(v) ? 'int' : 'float';
  if (typeof v === 'string') return 'str';
  if (Array.isArray(v)) return 'list';
  return 'dict';
}

/** Python repr() of a JSON-ish value — e.g. an import row shown back to the user. */
function pyRepr(v) {
  if (v === null || v === undefined) return 'None';
  if (v === true) return 'True';
  if (v === false) return 'False';
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : String(v);
  if (typeof v === 'string') {
    const q = v.includes("'") && !v.includes('"') ? '"' : "'";
    const body = v.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t');
    return q + (q === "'" ? body.replace(/'/g, "\\'") : body) + q;
  }
  if (Array.isArray(v)) return `[${v.map(pyRepr).join(', ')}]`;
  return `{${Object.entries(v).map(([k, val]) => `${pyRepr(k)}: ${pyRepr(val)}`).join(', ')}}`;
}

/** value.strip() with Python's AttributeError when value isn't a string. */
function pyStrip(v) {
  if (typeof v !== 'string') throw new Error(`'${pyTypeName(v)}' object has no attribute 'strip'`);
  return v.trim();
}

/** Python's `a or b or c` (truthiness, returns the first truthy operand or the last). */
function pyOr(...vals) {
  for (const v of vals.slice(0, -1)) if (pyTruthyLite(v)) return v;
  return vals[vals.length - 1];
}
function pyTruthyLite(v) {
  if (v === null || v === undefined || v === false || v === 0 || v === '') return false;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === 'object') return Object.keys(v).length > 0;
  return true;
}

/** float(v) with Python's ValueError/TypeError messages. */
function pyFloat(v) {
  if (typeof v === 'number') return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v !== 'string') throw new Error(`float() argument must be a string or a real number, not '${pyTypeName(v)}'`);
  const s = v.trim();
  if (/^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(s)) return Number(s);
  if (/^[-+]?(inf|infinity)$/i.test(s)) return s.startsWith('-') ? -Infinity : Infinity;
  throw new Error(`could not convert string to float: ${pyRepr(v)}`);
}

/** int(v) with Python's ValueError/TypeError messages. */
function pyIntValue(v) {
  if (typeof v === 'number') return Math.trunc(v);
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v !== 'string') throw new Error(`int() argument must be a string, a bytes-like object or a real number, not '${pyTypeName(v)}'`);
  const s = v.trim().replace(/_/g, '');
  if (!/^[-+]?\d+$/.test(s)) throw new Error(`invalid literal for int() with base 10: ${pyRepr(v)}`);
  return parseInt(s, 10);
}

module.exports = {
  contains, str, strip, lines, intOrNull, pyInt, decimalOrNull, readCsvDicts, writeCsv, shuffle, round2,
  pyTypeName, pyRepr, pyStrip, pyOr, pyTruthyLite, pyFloat, pyIntValue,
};
