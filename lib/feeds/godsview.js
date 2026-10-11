/**
 * Layers read from God's Eye View through its MCP tools: public CCTV
 * cameras, ALPR camera locations mapped in OpenStreetMap, tropical cyclones
 * and situation briefs. Results are cached briefly so panning back and forth
 * does not repeat the same tool calls.
 */

import { createCache } from '../cache.js';
import { bboxSpan, snapBbox } from '../geo.js';

// find_alpr_cameras accepts at most 3° per side; GodsView asks for a
// city-sized area when an area is too dense.
export const ALPR_MAX_SPAN = 1.5;
export const CCTV_MAX_SPAN = 12;

const rowsOf = (result) => result.data?.rows || [];

export function normalizeCctv(row) {
  return {
    id: row.id,
    kind: 'cctv',
    title: row.name || 'Public camera',
    name: row.name || null,
    city: row.city || null,
    provider: row.provider || null,
    credit: row.credit || null,
    lat: row.lat,
    lon: row.lon,
    headingDeg: row.heading_deg ?? null,
    feedType: row.feed_type || 'image',
    distanceKm: row.distance_km ?? null,
  };
}

export function normalizeAlpr(row) {
  return {
    id: row.id,
    kind: 'alpr',
    title: 'License plate reader',
    operator: row.operator || null,
    manufacturer: row.manufacturer || null,
    cameraType: row.camera_type || null,
    zone: row.zone || null,
    directionDeg: row.direction_deg ?? null,
    lastVerified: row.last_verified || null,
    lat: row.lat,
    lon: row.lon,
    distanceKm: row.distance_km ?? null,
    osmUrl: /^(node|way)\/\d+$/.test(String(row.id))
      ? `https://www.openstreetmap.org/${row.id}`
      : null,
  };
}

export function normalizeCyclone(row) {
  return {
    id: row.id || row.name,
    kind: 'cyclone',
    title: row.name || 'Tropical cyclone',
    classification: row.classification || null,
    basin: row.basin || null,
    lat: row.lat,
    lon: row.lon,
    windKt: row.wind_kt ?? null,
    pressureHpa: row.pressure_hpa ?? null,
    movement: row.movement || null,
    advisory: row.advisory ?? null,
    issuedAt: row.issued_at || null,
    advisoryUrl: row.advisory_url || null,
  };
}

export function createGodsViewLayers({ gev, publicUrl = gev.url, geocoderUserAgent, fetchImpl = globalThis.fetch }) {
  const cache = createCache({ ttlMs: 60_000, max: 400 });
  const longCache = createCache({ ttlMs: 600_000, max: 400 });

  async function cctv(bbox, { limit = 200 } = {}) {
    if (bboxSpan(bbox) > CCTV_MAX_SPAN)
      return { ok: true, zoomIn: true, items: [], error: 'Zoom in to load cameras' };
    const box = snapBbox(bbox, 0.05);
    const result = await cache.get(`cctv:${box}:${limit}`, () =>
      gev.query('find_cctv_cameras', { area: { bbox: box }, limit }),
    );
    return {
      ok: true,
      source: "God's Eye View CCTV catalog",
      summary: result.summary,
      total: result.data?.total ?? null,
      truncated: result.data?.truncated === true,
      items: rowsOf(result).map(normalizeCctv),
    };
  }

  async function alpr(bbox, { limit = 200 } = {}) {
    if (bboxSpan(bbox) > ALPR_MAX_SPAN)
      return { ok: true, zoomIn: true, items: [], error: 'Zoom in to a city to load ALPR cameras' };
    const box = snapBbox(bbox, 0.02);
    const result = await longCache.get(`alpr:${box}:${limit}`, () =>
      gev.query('find_alpr_cameras', { area: { bbox: box }, limit }),
    );
    return {
      ok: true,
      source: result.data?.source || 'OpenStreetMap via GodsView',
      attribution: result.data?.attribution || null,
      summary: result.summary,
      total: result.data?.total ?? null,
      truncated: result.data?.truncated === true,
      stale: result.data?.stale === true,
      items: rowsOf(result).map(normalizeAlpr),
    };
  }

  async function cyclones() {
    const result = await longCache.get('cyclones', () => gev.query('get_cyclones', {}));
    return {
      ok: true,
      source: 'NHC / CPHC via GodsView',
      summary: result.summary,
      items: (result.data?.storms || []).map(normalizeCyclone),
    };
  }

  async function brief(bbox) {
    const result = await cache.get(`brief:${snapBbox(bbox, 0.05)}`, () =>
      gev.query('situation_brief', { area: { bbox } }),
    );
    return { ok: true, summary: result.summary, data: result.data };
  }

  /**
   * A share link that opens the full GodsView app at a view. GodsView builds
   * it for the address this server reaches it at; browsers may need another
   * (a codespace's forwarded address), so the link keeps only its path and
   * view.
   */
  async function shareLink(view) {
    const result = await gev.query('show_in_gods_eye_view', view);
    let url = result.data?.url || null;
    if (url) {
      const link = new URL(url);
      url = `${publicUrl}${link.pathname}${link.search}${link.hash}`;
    }
    return { ok: true, url, view: result.data?.view };
  }

  /** Place search with OpenStreetMap Nominatim. Call on user action only. */
  async function geocode(query) {
    return longCache.get(`geocode:${query.toLowerCase()}`, async () => {
      const url = new URL('https://nominatim.openstreetmap.org/search');
      url.search = new URLSearchParams({ q: query, format: 'jsonv2', limit: '6' });
      const response = await fetchImpl(url, {
        headers: { 'User-Agent': geocoderUserAgent, Accept: 'application/json' },
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) throw new Error(`Place search answered HTTP ${response.status}`);
      const rows = await response.json();
      return rows.map((row) => ({
        name: row.display_name,
        lat: Number(row.lat),
        lon: Number(row.lon),
        bbox: row.boundingbox
          ? [Number(row.boundingbox[2]), Number(row.boundingbox[0]), Number(row.boundingbox[3]), Number(row.boundingbox[1])]
          : null,
      }));
    });
  }

  return { cctv, alpr, cyclones, brief, shareLink, geocode };
}
