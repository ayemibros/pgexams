/**
 * Small server-rendered inline-SVG chart helper for the student dashboard
 * (port of examhub/charts.py) — no JS charting library, nothing to load.
 */
const ACCENT = '#5b5ef4';
const MUTED = '#d1d5db';

/**
 * A 'stat tile' trend sparkline: prior points in a muted hue, the final
 * segment and end-dot in the accent color. Returns an <svg> string, or null
 * if there isn't enough data to draw a line.
 */
function sparklineSvg(values, width = 220, height = 48, pad = 6) {
  const vals = values.map(Number);
  if (vals.length < 2) return null;

  const lo = Math.min(...vals);
  const hi = Math.max(...vals);
  const span = (hi - lo) || 1;
  const n = vals.length;
  const step = (width - 2 * pad) / (n - 1);
  const pts = vals.map((v, i) => [pad + i * step, height - pad - ((v - lo) / span) * (height - 2 * pad)]);
  const f = (x) => x.toFixed(1);

  const mutedPath = pts.slice(0, -1).map(([x, y]) => `${f(x)},${f(y)}`).join(' ');
  const [px, py] = pts[pts.length - 2];
  const [lastX, lastY] = pts[pts.length - 1];
  const accentPath = `${f(px)},${f(py)} ${f(lastX)},${f(lastY)}`;

  const parts = [`<svg viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="Recent score trend">`];
  if (pts.length > 2) {
    parts.push(`<polyline points="${mutedPath}" fill="none" stroke="${MUTED}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`);
  }
  parts.push(`<polyline points="${accentPath}" fill="none" stroke="${ACCENT}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`);
  parts.push(`<circle cx="${f(lastX)}" cy="${f(lastY)}" r="4" fill="${ACCENT}" stroke="#fff" stroke-width="2"/>`);
  parts.push('</svg>');
  return parts.join('');
}

module.exports = { sparklineSvg };
