/**
 * Nunjucks environment configured to behave like Django's template engine:
 * autoescaping on, plus Django-compatible filters (default with Python
 * truthiness, date with Django format characters in TIME_ZONE, floatformat,
 * pluralize, yesno, truncatechars, stringformat, slice, linebreaks,
 * json_script, …) and globals for url() / widthratio().
 */
const nunjucks = require('nunjucks');
const config = require('./config');
const { reverse } = require('./urls');

// ───────────────────────────────────────────── Python truthiness ──
// Django templates treat empty lists/dicts as false ({% if attempts %}…);
// JavaScript treats [] and {} as true. Patch the Nunjucks compiler so `if`,
// `not`, `and`, `or` and inline-if all use Python truthiness instead — the
// ported templates then behave exactly like the Django originals.
{
  const { runtime } = nunjucks;
  const { Compiler } = require('nunjucks/src/compiler');
  runtime.pyTruthy = (v) => pyTruthy(v);
  runtime.pyOr = (a, b) => (pyTruthy(a) ? a : b);
  runtime.pyAnd = (a, b) => (pyTruthy(a) ? b : a);
  const proto = Compiler.prototype;

  proto.compileIf = function compileIf(node, frame, async) {
    this._emit('if(runtime.pyTruthy(');
    this._compileExpression(node.cond, frame);
    this._emitLine(')) {');
    this._withScopedSyntax(() => {
      this.compile(node.body, frame);
      if (async) this._emit('cb()');
    });
    if (node.else_) {
      this._emitLine('}\nelse {');
      this._withScopedSyntax(() => {
        this.compile(node.else_, frame);
        if (async) this._emit('cb()');
      });
    } else if (async) {
      this._emitLine('}\nelse {');
      this._emit('cb()');
    }
    this._emitLine('}');
  };
  proto.compileInlineIf = function compileInlineIf(node, frame) {
    this._emit('(runtime.pyTruthy(');
    this.compile(node.cond, frame);
    this._emit(')?');
    this.compile(node.body, frame);
    this._emit(':');
    if (node.else_ !== null) this.compile(node.else_, frame);
    else this._emit('""');
    this._emit(')');
  };
  proto.compileNot = function compileNot(node, frame) {
    this._emit('!runtime.pyTruthy(');
    this.compile(node.target, frame);
    this._emit(')');
  };
  // Short-circuiting like Python: the right operand is only evaluated when needed.
  proto.compileOr = function compileOr(node, frame) {
    this._emit('((_pyL) => runtime.pyTruthy(_pyL) ? _pyL : (');
    this.compile(node.right, frame);
    this._emit('))(');
    this.compile(node.left, frame);
    this._emit(')');
  };
  proto.compileAnd = function compileAnd(node, frame) {
    this._emit('((_pyL) => runtime.pyTruthy(_pyL) ? (');
    this.compile(node.right, frame);
    this._emit(') : _pyL)(');
    this.compile(node.left, frame);
    this._emit(')');
  };

  // Django's `in` evaluates to False (rather than raising) when the right side isn't a container.
  const originalIn = runtime.inOperator;
  runtime.inOperator = (key, val) => {
    if (val === null || val === undefined) return false;
    try { return originalIn(key, val); } catch (_) { return false; }
  };
}

const env = new nunjucks.Environment(
  new nunjucks.FileSystemLoader(config.TEMPLATES_DIR, { noCache: config.DEBUG }),
  { autoescape: true, throwOnUndefined: false, trimBlocks: false, lstripBlocks: false },
);

const safe = (s) => new nunjucks.runtime.SafeString(s);
const escapeHtml = (s) => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#x27;');

/** Python truthiness (None/False/0/''/[]/{} are falsy). */
function pyTruthy(v) {
  if (v === null || v === undefined || v === false || v === 0 || v === '') return false;
  if (Number.isNaN(v)) return false;
  if (Array.isArray(v)) return v.length > 0;
  if (v instanceof Map || v instanceof Set) return v.size > 0;
  if (v instanceof nunjucks.runtime.SafeString) return String(v).length > 0;
  if (typeof v === 'object' && !(v instanceof Date) && Object.getPrototypeOf(v) === Object.prototype) return Object.keys(v).length > 0;
  return true;
}

// ───────────────────────────────────────────── date formatting ──

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const MONTHS_AP = ['Jan.', 'Feb.', 'March', 'April', 'May', 'June', 'July', 'Aug.', 'Sept.', 'Oct.', 'Nov.', 'Dec.'];
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** Wall-clock parts of `date` in the configured TIME_ZONE. */
function zonedParts(date, timeZone = config.TIME_ZONE) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric',
    hour: 'numeric', minute: 'numeric', second: 'numeric', weekday: 'short',
  });
  const p = {};
  for (const { type, value } of fmt.formatToParts(date)) p[type] = value;
  const wd = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday);
  return {
    year: +p.year, month: +p.month, day: +p.day, hour: +p.hour % 24, minute: +p.minute, second: +p.second, weekday: wd,
  };
}

const pad = (n, w = 2) => String(n).padStart(w, '0');

function ordinalSuffix(day) {
  if (day % 100 >= 11 && day % 100 <= 13) return 'th';
  return { 1: 'st', 2: 'nd', 3: 'rd' }[day % 10] || 'th';
}

function toDate(value) {
  if (value === null || value === undefined || value === '') return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Django's |date filter (format characters, backslash escapes), rendered in TIME_ZONE. */
function formatDate(value, format = 'N j, Y') {
  const date = toDate(value);
  if (!date) return '';
  // A DATE-only column (e.g. date_of_birth) has no time zone — format as-is in UTC.
  const isDateOnly = typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
  const p = zonedParts(date, isDateOnly ? 'UTC' : config.TIME_ZONE);
  let out = '';
  for (let i = 0; i < format.length; i++) {
    const c = format[i];
    if (c === '\\') { out += format[i + 1] || ''; i++; continue; }
    const h12 = p.hour % 12 === 0 ? 12 : p.hour % 12;
    switch (c) {
      case 'd': out += pad(p.day); break;
      case 'j': out += p.day; break;
      case 'D': out += DAYS[p.weekday].slice(0, 3); break;
      case 'l': out += DAYS[p.weekday]; break;
      case 'S': out += ordinalSuffix(p.day); break;
      case 'w': out += p.weekday; break;
      case 'm': out += pad(p.month); break;
      case 'n': out += p.month; break;
      case 'M': out += MONTHS[p.month - 1].slice(0, 3); break;
      case 'b': out += MONTHS[p.month - 1].slice(0, 3).toLowerCase(); break;
      case 'F': out += MONTHS[p.month - 1]; break;
      case 'N': out += MONTHS_AP[p.month - 1]; break;
      case 'Y': out += p.year; break;
      case 'y': out += pad(p.year % 100); break;
      case 'H': out += pad(p.hour); break;
      case 'G': out += p.hour; break;
      case 'h': out += pad(h12); break;
      case 'g': out += h12; break;
      case 'i': out += pad(p.minute); break;
      case 's': out += pad(p.second); break;
      case 'A': out += p.hour < 12 ? 'AM' : 'PM'; break;
      case 'a': out += p.hour < 12 ? 'a.m.' : 'p.m.'; break;
      case 'P':
        if (p.minute === 0 && p.hour === 0) out += 'midnight';
        else if (p.minute === 0 && p.hour === 12) out += 'noon';
        else out += `${h12}${p.minute ? `:${pad(p.minute)}` : ''} ${p.hour < 12 ? 'a.m.' : 'p.m.'}`;
        break;
      default: out += c;
    }
  }
  return out;
}

/**
 * Interprets a naive "YYYY-MM-DDTHH:MM" (a datetime-local input) as wall-clock
 * time in TIME_ZONE and returns the matching UTC Date — what Django's
 * parse_datetime + USE_TZ does with a naive value.
 */
function parseLocalDateTime(str) {
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?/.exec(String(str || '').trim());
  if (!m) return null;
  const [y, mo, d, h, mi, s] = [+m[1], +m[2], +m[3], +m[4], +m[5], +(m[6] || 0)];
  let guess = Date.UTC(y, mo - 1, d, h, mi, s);
  // Two passes handle the zone offset (and DST transitions, where they exist).
  for (let i = 0; i < 2; i++) {
    const p = zonedParts(new Date(guess));
    const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
    guess -= asUtc - Date.UTC(y, mo - 1, d, h, mi, s);
  }
  return new Date(guess);
}

// ───────────────────────────────────────────── number formatting ──

/** Django's |floatformat. */
function floatformat(value, arg = -1) {
  if (value === null || value === undefined || value === '') return '';
  const n = Number(value);
  if (Number.isNaN(n)) return '';
  let places = parseInt(arg, 10);
  if (Number.isNaN(places)) places = -1;
  // Like Django: a negative arg shows a bare integer only when the original
  // value has no fractional part at all (34.001 -> "34.0" with the default).
  if (places < 0 && Number.isInteger(n)) return String(n);
  return roundHalfUp(n, Math.abs(places));
}

function roundHalfUp(n, places) {
  const factor = 10 ** places;
  const r = Math.round((Math.abs(n) * factor) + 1e-9) / factor;
  const s = r.toFixed(places);
  return n < 0 && Number(s) !== 0 ? `-${s}` : s;
}

/** Minimal Python %-formatting for |stringformat ("s", "d", ".1f", "02d", …). */
function stringformat(value, spec) {
  const m = /^(0)?(\d+)?(?:\.(\d+))?([sdfie%])$/.exec(String(spec));
  if (!m) return String(value ?? '');
  const [, zero, width, precision, type] = m;
  let out;
  if (type === 's') out = value === null || value === undefined ? 'None' : String(value);
  else if (type === 'd' || type === 'i') out = String(Math.trunc(Number(value)));
  else if (type === 'f') out = Number(value).toFixed(precision !== undefined ? +precision : 6);
  else if (type === 'e') out = Number(value).toExponential(precision !== undefined ? +precision : 6);
  else out = String(value);
  if (width) out = out.padStart(+width, zero ? '0' : ' ');
  return out;
}

// ───────────────────────────────────────────── filters ──

env.addFilter('default', (value, arg) => (pyTruthy(value) ? value : arg));
env.addFilter('default_if_none', (value, arg) => (value === null || value === undefined ? arg : value));
env.addFilter('date', (value, fmt) => formatDate(value, fmt));
env.addFilter('floatformat', floatformat);
env.addFilter('stringformat', stringformat);

env.addFilter('pluralize', (value, arg = 's') => {
  let singular = '';
  let plural = arg;
  if (String(arg).includes(',')) [singular, plural] = String(arg).split(',');
  let n = value;
  if (Array.isArray(value)) n = value.length;
  n = Number(n);
  return n === 1 ? singular : plural;
});

env.addFilter('yesno', (value, arg = 'yes,no,maybe') => {
  const bits = String(arg).split(',');
  if (bits.length < 2) return value;
  const [yes, no, maybe = no] = bits;
  if (value === null || value === undefined) return maybe;
  return pyTruthy(value) ? yes : no;
});

env.addFilter('truncatechars', (value, n) => {
  const s = String(value ?? '');
  const len = parseInt(n, 10);
  if (Number.isNaN(len) || [...s].length <= len) return s;
  return `${[...s].slice(0, Math.max(0, len - 1)).join('')}…`;
});

/** Django-style slice with a "start:end" string argument. */
env.addFilter('slice', (value, arg) => {
  if (value === null || value === undefined) return value;
  const [a, b] = String(arg).split(':');
  const start = a === '' || a === undefined ? undefined : parseInt(a, 10);
  const end = b === '' || b === undefined ? undefined : parseInt(b, 10);
  if (!String(arg).includes(':')) {
    const i = parseInt(arg, 10);
    return Array.isArray(value) ? value.slice(i, i + 1) : String(value).slice(i, i + 1);
  }
  if (Array.isArray(value)) return value.slice(start, end);
  return [...String(value)].slice(start, end).join('');
});

env.addFilter('striptags', (value) => {
  const s = value instanceof nunjucks.runtime.SafeString ? String(value) : String(value ?? '');
  return s.replace(/<[^>]*>/g, '');
});

env.addFilter('linebreaks', (value) => {
  const s = String(value ?? '').replace(/\r\n|\r/g, '\n');
  const escaped = value instanceof nunjucks.runtime.SafeString ? s : escapeHtml(s);
  const paras = escaped.split(/\n{2,}/).map((p) => `<p>${p.replace(/\n/g, '<br>')}</p>`);
  return safe(paras.join('\n\n'));
});

env.addFilter('linebreaksbr', (value) => {
  const s = String(value ?? '');
  const escaped = value instanceof nunjucks.runtime.SafeString ? s : escapeHtml(s);
  return safe(escaped.replace(/\r\n|\r|\n/g, '<br>'));
});

env.addFilter('join', (value, sep = '') => {
  if (!Array.isArray(value)) return value;
  return safe(value.map((v) => (v instanceof nunjucks.runtime.SafeString ? String(v) : escapeHtml(v))).join(escapeHtml(sep)));
});

env.addFilter('jsonify', (value) => (value === null || value === undefined || value === '' ? '' : JSON.stringify(value)));

/** Django's |json_script:"element-id" — safe to embed, parse with JSON.parse(el.textContent). */
env.addFilter('json_script', (value, elementId) => {
  const json = JSON.stringify(value ?? null)
    .replace(/</g, '\\u003C').replace(/>/g, '\\u003E').replace(/&/g, '\\u0026');
  const idAttr = elementId ? ` id="${escapeHtml(elementId)}"` : '';
  return safe(`<script${idAttr} type="application/json">${json}</script>`);
});

const TYPE_ICONS = {
  mcq_single: 'circle-dot', mcq_multi: 'square-check', true_false: 'check-circle', fill_blank: 'text-cursor', numeric: 'hash',
  theory: 'pen', match: 'link', order: 'arrow-up-down', category: 'folder',
};
// renderIcon is a hoisted function declared with the icon set below.
env.addFilter('type_icon', (value) => renderIcon(TYPE_ICONS[value] || 'help-circle', 18, 'ico'));

env.addFilter('upper', (value) => String(value ?? '').toUpperCase());
env.addFilter('title', (value) => String(value ?? '').toLowerCase().replace(/(^|[^\p{L}\p{N}'])(\p{L})/gu, (_, a, b) => a + b.toUpperCase()));

// ───────────────────────────────────────────── globals ──

env.addGlobal('url', (name, ...args) => reverse(name, ...args));
/** {% widthratio value max_value max_width %} */
env.addGlobal('widthratio', (value, maxValue, maxWidth) => {
  const v = Number(value);
  const m = Number(maxValue);
  const w = Number(maxWidth);
  if (!m || Number.isNaN(v) || Number.isNaN(w)) return '0';
  return String(Math.round((v / m) * w));
});

/** {% now "Y" %} */
env.addGlobal('now', (fmt = 'N j, Y') => formatDate(new Date(), fmt));

/** Community group links: {{ community.telegram }}, {{ community.whatsapp }}. */
env.addGlobal('community', {
  telegram: config.TELEGRAM_URL,
  whatsapp: config.WHATSAPP_GROUP_URL,
});

/** django.contrib.humanize's |intcomma — "5000" -> "5,000" (keeps any decimal part). */
env.addFilter('intcomma', (value) => {
  if (value === null || value === undefined || value === '') return value;
  const s = String(value);
  const m = /^(-?)(\d+)(\.\d+)?$/.exec(s);
  if (!m) return s;
  return m[1] + m[2].replace(/\B(?=(\d{3})+(?!\d))/g, ',') + (m[3] || '');
});

/** Django's |escapejs — safe inside a JS string literal. */
// Characters Django escapes: \ ' " < > & = - ; ` control chars and the U+2028/U+2029 line separators.
const ESCAPEJS_CHARS = new Set(['\\', "'", '"', '<', '>', '&', '=', '-', ';', '`', String.fromCharCode(0x2028), String.fromCharCode(0x2029)]);
const ESCAPEJS_RE = { [Symbol.replace]: (s, fn) => [...s].map((c) => (ESCAPEJS_CHARS.has(c) || c.charCodeAt(0) < 0x20 ? fn(c) : c)).join('') };
env.addFilter('escapejs', (value) => safe(String(value ?? '').replace(ESCAPEJS_RE,
  (c) => `\\u${c.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}`)));

// Outline icons (Lucide-style) used across the public pages and the portal.
const ICONS = {
  'academic-cap': '<path d="M12 3 2 8l10 5 10-5-10-5Z"/><path d="M6 10.5V15c0 1.5 2.7 3 6 3s6-1.5 6-3v-4.5"/><path d="M22 8v6"/>',
  document: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><polyline points="14 2 14 8 20 8"/><line x1="9" y1="13" x2="15" y2="13"/><line x1="9" y1="17" x2="15" y2="17"/>',
  building: '<rect x="4" y="2" width="16" height="20" rx="1"/><line x1="8" y1="6" x2="8" y2="6.01"/><line x1="12" y1="6" x2="12" y2="6.01"/><line x1="16" y1="6" x2="16" y2="6.01"/><line x1="8" y1="10" x2="8" y2="10.01"/><line x1="12" y1="10" x2="12" y2="10.01"/><line x1="16" y1="10" x2="16" y2="10.01"/><line x1="8" y1="14" x2="8" y2="14.01"/><line x1="12" y1="14" x2="12" y2="14.01"/><line x1="16" y1="14" x2="16" y2="14.01"/><line x1="10" y1="22" x2="10" y2="18"/><line x1="14" y1="22" x2="14" y2="18"/>',
  bolt: '<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>',
  'shield-check': '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z"/><polyline points="9 12 11 14 15 10"/>',
  calendar: '<rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>',
  headset: '<path d="M3 18v-6a9 9 0 0 1 18 0v6"/><path d="M21 19a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3Z"/><path d="M3 19a2 2 0 0 0 2 2h1a2 2 0 0 0 2-2v-3a2 2 0 0 0-2-2H3Z"/>',
  clipboard: '<rect x="8" y="2" width="8" height="4" rx="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><line x1="8" y1="11" x2="16" y2="11"/><line x1="8" y1="15" x2="13" y2="15"/>',
  lock: '<rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21v-1a8 8 0 0 1 16 0v1"/>',
  mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><polyline points="3 7 12 13 21 7"/>',
  phone: '<path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6A19.79 19.79 0 0 1 2.12 4.18 2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.9.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.91.34 1.85.57 2.81.7A2 2 0 0 1 22 16.92Z"/>',
  eye: '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8Z"/><circle cx="12" cy="12" r="3"/>',
  'eye-off': '<path d="M17.94 17.94A10.94 10.94 0 0 1 12 20c-7 0-11-8-11-8a18.5 18.5 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/><path d="M14.12 14.12a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/>',
  'check-circle': '<path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/>',
  'arrow-right': '<line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/>',
  'credit-card': '<rect x="1" y="4" width="22" height="16" rx="2"/><line x1="1" y1="10" x2="23" y2="10"/>',
  target: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1"/>',
  users: '<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
  'book-open': '<path d="M2 4h6a4 4 0 0 1 4 4v13a3 3 0 0 0-3-3H2Z"/><path d="M22 4h-6a4 4 0 0 0-4 4v13a3 3 0 0 1 3-3h7Z"/>',
  smartphone: '<rect x="6" y="2" width="12" height="20" rx="2"/><line x1="12" y1="18" x2="12" y2="18.01"/>',
  search: '<circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>',
  'message-circle': '<path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/>',
  clock: '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>',
  'bar-chart': '<line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/>',
  home: '<path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/>',
  dashboard: '<rect width="7" height="9" x="3" y="3" rx="1.5"/><rect width="7" height="5" x="14" y="3" rx="1.5"/><rect width="7" height="9" x="14" y="12" rx="1.5"/><rect width="7" height="5" x="3" y="16" rx="1.5"/>',
  library: '<path d="m16 6 4 14"/><path d="M12 6v14"/><path d="M8 8v12"/><path d="M4 4v16"/>',
  upload: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>',
  'file-text': '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M10 9H8"/><path d="M16 13H8"/><path d="M16 17H8"/>',
  settings: '<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/>',
  bell: '<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/>',
  'log-out': '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/>',
  tag: '<path d="M12 2H2v10l9.29 9.29c.94.94 2.48.94 3.42 0l6.58-6.58c.94-.94.94-2.48 0-3.42L12 2Z"/><path d="M7 7h.01"/>',
  landmark: '<line x1="3" y1="22" x2="21" y2="22"/><line x1="6" y1="18" x2="6" y2="11"/><line x1="10" y1="18" x2="10" y2="11"/><line x1="14" y1="18" x2="14" y2="11"/><line x1="18" y1="18" x2="18" y2="11"/><polygon points="12 2 20 7 4 7"/>',
  wallet: '<path d="M21 12V7H5a2 2 0 0 1 0-4h14v4"/><path d="M3 5v14a2 2 0 0 0 2 2h16v-5"/><path d="M18 12a2 2 0 0 0 0 4h4v-4Z"/>',
  banknote: '<rect width="20" height="12" x="2" y="6" rx="2"/><circle cx="12" cy="12" r="2"/><path d="M6 12h.01M18 12h.01"/>',
  'help-circle': '<circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><path d="M12 17h.01"/>',
  image: '<rect width="18" height="18" x="3" y="3" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.09-3.09a2 2 0 0 0-2.82 0L6 21"/>',
  folder: '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>',
  pen: '<path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/>',
  wrench: '<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>',
  inbox: '<polyline points="22 12 16 12 14 15 10 15 8 12 2 12"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>',
  flask: '<path d="M9 3h6"/><path d="M10 9V3"/><path d="M14 9V3"/><path d="M10 9 4.5 19a2 2 0 0 0 1.75 3h11.5a2 2 0 0 0 1.75-3L14 9"/><path d="M7 16h10"/>',
  flame: '<path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.07-2.14-.22-4.05 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.15.43-2.29 1-3a2.5 2.5 0 0 0 2.5 2.5z"/>',
  trophy: '<path d="M6 9H4.5a2.5 2.5 0 0 1 0-5H6"/><path d="M18 9h1.5a2.5 2.5 0 0 0 0-5H18"/><path d="M4 22h16"/><path d="M10 14.66V17c0 .55-.47.98-.97 1.21C7.85 18.75 7 20.24 7 22"/><path d="M14 14.66V17c0 .55.47.98.97 1.21C16.15 18.75 17 20.24 17 22"/><path d="M18 2H6v7a6 6 0 0 0 12 0V2Z"/>',
  'thumbs-up': '<path d="M7 10v12"/><path d="M15 5.88 14 10h5.83a2 2 0 0 1 1.92 2.56l-2.33 8A2 2 0 0 1 17.5 22H4a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h2.76a2 2 0 0 0 1.79-1.11L12 2a3.13 3.13 0 0 1 3 3.88Z"/>',
  'trending-up': '<polyline points="22 7 13.5 15.5 8.5 10.5 2 17"/><polyline points="16 7 22 7 22 13"/>',
  palette: '<circle cx="13.5" cy="6.5" r="1" fill="currentColor"/><circle cx="17.5" cy="10.5" r="1" fill="currentColor"/><circle cx="8.5" cy="7.5" r="1" fill="currentColor"/><circle cx="6.5" cy="12.5" r="1" fill="currentColor"/><path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.93 0 1.65-.75 1.65-1.69 0-.44-.18-.84-.44-1.13-.29-.29-.44-.65-.44-1.13a1.64 1.64 0 0 1 1.67-1.67h2c3.05 0 5.55-2.5 5.55-5.55C21.97 6.01 17.46 2 12 2z"/>',
  telegram: '<path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/>',
  whatsapp: '<path d="M3 21l1.65-3.8a9 9 0 1 1 3.4 2.9L3 21"/><path d="M9 10a.5.5 0 0 0 1 0V9a.5.5 0 0 0-1 0v1a5 5 0 0 0 5 5h1a.5.5 0 0 0 0-1h-1a.5.5 0 0 0 0 1"/>',
  menu: '<line x1="4" y1="6" x2="20" y2="6"/><line x1="4" y1="12" x2="20" y2="12"/><line x1="4" y1="18" x2="20" y2="18"/>',
  x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  check: '<polyline points="20 6 9 17 4 12"/>',
  'alert-triangle': '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
  key: '<circle cx="7.5" cy="15.5" r="5.5"/><path d="m21 2-9.6 9.6"/><path d="m15.5 7.5 3 3L22 7l-3-3"/>',
  plus: '<path d="M5 12h14"/><path d="M12 5v14"/>',
  layers: '<polygon points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 17 12 22 22 17"/><polyline points="2 12 12 17 22 12"/>',
  'circle-dot': '<circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="3"/>',
  'square-check': '<rect width="18" height="18" x="3" y="3" rx="2"/><path d="m9 12 2 2 4-4"/>',
  hash: '<line x1="4" y1="9" x2="20" y2="9"/><line x1="4" y1="15" x2="20" y2="15"/><line x1="10" y1="3" x2="8" y2="21"/><line x1="16" y1="3" x2="14" y2="21"/>',
  link: '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
  'arrow-up-down': '<path d="m21 16-4 4-4-4"/><path d="M17 20V4"/><path d="m3 8 4-4 4 4"/><path d="M7 4v16"/>',
  'text-cursor': '<path d="M17 22h-1a4 4 0 0 1-4-4V6a4 4 0 0 1 4-4h1"/><path d="M7 22h1a4 4 0 0 0 4-4v-1"/><path d="M7 2h1a4 4 0 0 1 4 4v1"/>',
  'chevron-down': '<polyline points="6 9 12 15 18 9"/>',
  'chevron-right': '<polyline points="9 18 15 12 9 6"/>',
  sparkles: '<path d="M9.94 14.06 8 20l-1.94-5.94L0 12l6.06-1.94L8 4l1.94 6.06L16 12Z" transform="translate(2 -1) scale(.9)"/><path d="M19 3v4M17 5h4"/>',
  grid: '<rect width="7" height="7" x="3" y="3" rx="1"/><rect width="7" height="7" x="14" y="3" rx="1"/><rect width="7" height="7" x="14" y="14" rx="1"/><rect width="7" height="7" x="3" y="14" rx="1"/>',
  briefcase: '<rect x="2" y="7" width="20" height="14" rx="2"/><path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"/>',
};

/** {% icon "name" size=20 css_class="x" %} -> icon("name", size=20, css_class="x") */
env.addGlobal('icon', (...args) => {
  let kw = {};
  if (args.length && args[args.length - 1] && typeof args[args.length - 1] === 'object' && args[args.length - 1].__keywords) kw = args.pop();
  const [name, sizeArg = 20, cls = ''] = args;
  return renderIcon(name, kw.size ?? sizeArg, kw.css_class ?? cls);
});

function renderIcon(name, size = 20, cssClass = '') {
  return safe(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${escapeHtml(size)}" height="${escapeHtml(size)}" `
    + 'viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" '
    + `stroke-linecap="round" stroke-linejoin="round" class="${escapeHtml(cssClass)}" aria-hidden="true">${ICONS[name] || ''}</svg>`,
  );
}

module.exports = { env, safe, escapeHtml, pyTruthy, formatDate, parseLocalDateTime, floatformat, zonedParts };
