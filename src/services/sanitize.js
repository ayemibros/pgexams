/**
 * Sanitizes rich content (question stems, explanations, model answers, lesson
 * bodies) that teachers author with the rich editor — the port of
 * examhub/sanitize.py. Allows the formatting/embedding tags the editor
 * produces while stripping anything that could execute script or load code.
 */
const sanitizeHtml = require('sanitize-html');

// Tags whose *content* must be discarded outright, not just unwrapped.
const STRIP_WITH_CONTENT_RE = /<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;

const ALLOWED_TAGS = [
  'p', 'br', 'b', 'strong', 'i', 'em', 'u', 'sub', 'sup', 'span',
  'img', 'ul', 'ol', 'li', 'table', 'thead', 'tbody', 'tr', 'td', 'th',
];

const ALLOWED_ATTRIBUTES = {
  img: ['src', 'alt', 'style', 'width', 'height'],
  span: ['style'],
  td: ['style'],
  th: ['style'],
};

const ANY_VALUE = [/^[\s\S]*$/];
const ALLOWED_STYLES = {
  '*': {
    width: ANY_VALUE,
    height: ANY_VALUE,
    'max-width': ANY_VALUE,
    color: ANY_VALUE,
    'font-weight': ANY_VALUE,
    'text-align': ANY_VALUE,
  },
};

function sanitizeRichHtml(value) {
  if (!value) return value;
  const stripped = String(value).replace(STRIP_WITH_CONTENT_RE, '');
  return sanitizeHtml(stripped, {
    allowedTags: ALLOWED_TAGS,
    allowedAttributes: ALLOWED_ATTRIBUTES,
    allowedStyles: ALLOWED_STYLES,
    allowedSchemes: ['http', 'https', 'data'],
    allowedSchemesAppliedToAttributes: ['src', 'href'],
    allowProtocolRelative: false,
    disallowedTagsMode: 'discard',
    // Keep literal "<", ">" and "&" readable in LaTeX (e.g. $a<b$) — bleach
    // re-escaped them as entities, which the browser renders back identically.
    parser: { decodeEntities: true },
  });
}

module.exports = { sanitizeRichHtml };
