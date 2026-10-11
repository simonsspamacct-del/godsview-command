/** Small DOM, formatting and fetch helpers shared by the console's modules. */

export const $ = (selector, root = document) => root.querySelector(selector);

/** Build an element: h('div', { class: 'x', onClick }, child, 'text'). */
export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props || {})) {
    if (value == null || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key === 'html') el.innerHTML = value;
    else if (key.startsWith('on') && typeof value === 'function')
      el.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key === 'style' && typeof value === 'object') Object.assign(el.style, value);
    else if (key === 'dataset') Object.assign(el.dataset, value);
    else el.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat(Infinity)) {
    if (child == null || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

export const esc = (value) =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );

export function ago(ms) {
  if (!Number.isFinite(ms)) return '';
  const minutes = Math.max(0, Math.round((Date.now() - ms) / 60_000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ${minutes % 60} min ago`;
  return `${Math.floor(hours / 24)} d ago`;
}

export function shortAgo(ms) {
  if (!Number.isFinite(ms)) return '';
  const minutes = Math.max(0, Math.round((Date.now() - ms) / 60_000));
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)}h`;
  return `${Math.floor(minutes / 1440)}d`;
}

export function when(iso) {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

export function until(iso) {
  if (!iso) return '';
  const minutes = Math.round((new Date(iso).getTime() - Date.now()) / 60_000);
  if (!Number.isFinite(minutes)) return '';
  if (minutes <= 0) return 'expired';
  if (minutes < 60) return `${minutes} min left`;
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min left`;
}

/** Time left, compact: "45m", "5h27m", "2d". */
export function untilShort(iso) {
  if (!iso) return '';
  const minutes = Math.round((new Date(iso).getTime() - Date.now()) / 60_000);
  if (!Number.isFinite(minutes)) return '';
  if (minutes <= 0) return 'ended';
  if (minutes < 60) return `${minutes}m left`;
  if (minutes < 2880) return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, '0')}m left`;
  return `${Math.floor(minutes / 1440)}d left`;
}

export const km = (value) =>
  Number.isFinite(value) ? (value < 1 ? `${Math.round(value * 1000)} m` : `${value.toFixed(1)} km`) : '';

export function distanceKm(a, b) {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLon = (b.lon - a.lon) * rad;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(x)));
}

export const compass = (deg) =>
  Number.isFinite(deg) ? `${Math.round(deg)}° ${['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round(deg / 45) % 8]}` : '—';

export const SEVERITY_COLORS = {
  Extreme: '#d946ef',
  Severe: '#ef4444',
  Moderate: '#f59e0b',
  Minor: '#eab308',
  Unknown: '#94a3b8',
};

const CAMERA_SVG =
  '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M4 7h11a2 2 0 0 1 2 2v1.5l4-2.5v8l-4-2.5V15a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2z"/></svg>';
const WEATHER_SVG =
  '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2 1 21h22L12 2zm1 15h-2v2h2v-2zm0-7h-2v5h2v-5z"/></svg>';
const CYCLONE_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" aria-hidden="true"><path d="M12 12m-3 0a3 3 0 1 0 6 0a3 3 0 1 0 -6 0M15 7c-3-3-9-2-11 3M9 17c3 3 9 2 11-3"/></svg>';

export const KINDS = {
  police: { label: 'Police', color: '#3b82f6', glyph: 'P', tab: 'police' },
  accident: { label: 'Accident', color: '#f97316', glyph: '!', tab: 'police' },
  hazard: { label: 'Hazard', color: '#facc15', glyph: '▲', tab: 'police' },
  closure: { label: 'Road closed', color: '#a3a3a3', glyph: '×', tab: 'police' },
  jam: { label: 'Traffic jam', color: '#fb923c', glyph: '≡', tab: 'police' },
  weather: { label: 'Weather alert', color: '#f59e0b', html: WEATHER_SVG, tab: 'weather' },
  cyclone: { label: 'Tropical cyclone', color: '#a78bfa', html: CYCLONE_SVG, tab: 'weather' },
  cctv: { label: 'Public camera', color: '#22d3ee', html: CAMERA_SVG, tab: 'cctv' },
  alpr: { label: 'ALPR camera', color: '#f472b6', glyph: 'LPR', tab: 'alpr' },
};

export const WAZE_KINDS = new Set(['police', 'accident', 'hazard', 'closure', 'jam']);

/** The round badge for an item, as an HTML string. */
export function glyphHtml(item, { fresh = false } = {}) {
  const meta = KINDS[item.kind] || KINDS.hazard;
  const style =
    item.kind === 'weather' ? ` style="background:${SEVERITY_COLORS[item.severity] || SEVERITY_COLORS.Unknown}"` : '';
  return `<span class="glyph ${item.kind}${fresh ? ' fresh' : ''}"${style}>${meta.html || esc(meta.glyph)}</span>`;
}

export const glyph = (item, options) => h('span', { html: glyphHtml(item, options), style: { display: 'contents' } });

/** One-line title and subtitle for any item. */
export function describe(item) {
  switch (item.kind) {
    case 'weather':
      return { title: item.event, subtitle: item.areaDesc };
    case 'cyclone':
      return { title: item.title, subtitle: [item.classification, item.windKt != null ? `${item.windKt} kt` : null].filter(Boolean).join(' · ') };
    case 'cctv':
      return { title: item.name || 'Public camera', subtitle: [item.city, item.provider].filter(Boolean).join(' · ') };
    case 'alpr':
      return { title: item.operator ? `ALPR · ${item.operator}` : 'ALPR camera', subtitle: [item.manufacturer, item.cameraType].filter(Boolean).join(' · ') || 'Mapped in OpenStreetMap' };
    default:
      return {
        title: [item.title, item.detail].filter(Boolean).join(' · '),
        subtitle: [item.street, item.city].filter(Boolean).join(', ') || 'Location reported on Waze',
      };
  }
}

export async function getJson(url, options = {}) {
  const response = await fetch(url, options);
  const body = await response.json().catch(() => ({}));
  if (!response.ok && body.ok === undefined) body.ok = false;
  if (!response.ok && !body.error) body.error = `HTTP ${response.status}`;
  return body;
}

export const postJson = (url, body) =>
  getJson(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

export function uuid() {
  if (globalThis.crypto?.randomUUID) return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

export function storage(key, fallback) {
  try {
    const value = localStorage.getItem(key);
    return value == null ? fallback : JSON.parse(value);
  } catch {
    return fallback;
  }
}

export function store(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage may be unavailable */
  }
}

/** A tiny, safe Markdown subset: paragraphs, lists, bold, italics, code, links. */
export function markdown(text) {
  const inline = (line) =>
    esc(line)
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
      .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<i>$2</i>')
      .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  const out = [];
  let list = null;
  for (const raw of String(text).split('\n')) {
    const line = raw.trimEnd();
    const bullet = /^\s*[-*•]\s+(.*)$/.exec(line);
    const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (bullet || numbered) {
      const type = bullet ? 'ul' : 'ol';
      if (list !== type) {
        if (list) out.push(`</${list}>`);
        out.push(`<${type}>`);
        list = type;
      }
      out.push(`<li>${inline((bullet || numbered)[1])}</li>`);
      continue;
    }
    if (list) {
      out.push(`</${list}>`);
      list = null;
    }
    if (!line.trim()) continue;
    const heading = /^#{1,4}\s+(.*)$/.exec(line);
    out.push(heading ? `<p><b>${inline(heading[1])}</b></p>` : `<p>${inline(line)}</p>`);
  }
  if (list) out.push(`</${list}>`);
  return out.join('');
}
