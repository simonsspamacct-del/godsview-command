/**
 * Waze user reports: police, accidents, hazards, closures and jams.
 *
 * Two sources, chosen with WAZE_MODE:
 *  - `livemap`: the JSON endpoint behind waze.com/live-map. It is not a
 *    published API; Waze may refuse requests (it often refuses cloud and
 *    datacenter addresses) or change it without notice.
 *  - `feed`: a Waze for Cities (Connected Citizens Program) partner feed,
 *    the supported way to get these reports. Set WAZE_FEED_URL to the JSON
 *    feed URL from the Waze for Cities partner hub.
 */

import { createCache } from '../cache.js';
import { bboxContains, bboxSpan, snapBbox } from '../geo.js';

const LIVE_MAP_URL = 'https://www.waze.com/live-map/api/georss';
export const MAX_SPAN_DEGREES = 2;

const KINDS = {
  POLICE: 'police',
  ACCIDENT: 'accident',
  HAZARD: 'hazard',
  WEATHERHAZARD: 'hazard',
  ROAD_CLOSED: 'closure',
  JAM: 'jam',
};

const TITLES = {
  police: 'Police reported',
  accident: 'Accident',
  hazard: 'Hazard',
  closure: 'Road closed',
  jam: 'Traffic jam',
};

const SUBTYPE_LABELS = {
  POLICE_VISIBLE: 'Visible',
  POLICE_HIDING: 'Hiding',
  POLICE_WITH_MOBILE_CAMERA: 'Mobile camera',
  ACCIDENT_MINOR: 'Minor',
  ACCIDENT_MAJOR: 'Major',
  JAM_MODERATE_TRAFFIC: 'Moderate traffic',
  JAM_HEAVY_TRAFFIC: 'Heavy traffic',
  JAM_STAND_STILL_TRAFFIC: 'Standstill traffic',
};

/** "HAZARD_ON_ROAD_POT_HOLE" -> "Pot hole" */
function humanize(subtype, type) {
  if (!subtype) return null;
  if (SUBTYPE_LABELS[subtype]) return SUBTYPE_LABELS[subtype];
  const words = subtype
    .replace(new RegExp(`^${type}_`), '')
    .replace(/^HAZARD_(ON_ROAD|ON_SHOULDER|WEATHER)_/, '')
    .replace(/^(ON_ROAD|ON_SHOULDER|WEATHER)_/, '')
    .toLowerCase()
    .replace(/_/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** One Waze alert in this app's shape, or null for kinds it does not show. */
export function normalizeWazeAlert(alert) {
  const kind = KINDS[alert?.type];
  const lat = alert?.location?.y;
  const lon = alert?.location?.x;
  if (!kind || !Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  return {
    id: String(alert.uuid || alert.id || `${alert.type}:${lat},${lon}:${alert.pubMillis}`),
    kind,
    title: TITLES[kind],
    type: alert.type,
    subtype: alert.subtype || null,
    detail: humanize(alert.subtype, alert.type),
    lat,
    lon,
    street: alert.street || null,
    city: alert.city || null,
    country: alert.country || null,
    reportedAt: Number.isFinite(alert.pubMillis) ? alert.pubMillis : null,
    thumbsUp: alert.nThumbsUp ?? 0,
    reliability: alert.reliability ?? null,
    confidence: alert.confidence ?? null,
    rating: alert.reportRating ?? null,
    description: alert.reportDescription || null,
    headingDeg: Number.isFinite(alert.magvar) ? alert.magvar : null,
    byMunicipality: alert.reportByMunicipalityUser === 'true' || alert.reportByMunicipalityUser === true,
  };
}

/** Normalize a georss or partner-feed body, keeping reports inside `bbox`. */
export function parseWazeBody(body, bbox) {
  return (body?.alerts || [])
    .map(normalizeWazeAlert)
    .filter((item) => item && (!bbox || bboxContains(bbox, item)))
    .sort((a, b) => (b.reportedAt ?? 0) - (a.reportedAt ?? 0));
}

export function createWazeFeed({ mode, feedUrl, region, userAgent, fetchImpl = globalThis.fetch }) {
  const cache = createCache({ ttlMs: 45_000, max: 300 });

  async function fetchJson(url, headers) {
    const response = await fetchImpl(url, {
      headers: { Accept: 'application/json', 'User-Agent': userAgent, ...headers },
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) {
      const error = new Error(
        response.status === 403 || response.status === 429
          ? `Waze refused the request (HTTP ${response.status}). The live-map endpoint often blocks cloud and datacenter addresses and heavy use; a Waze for Cities feed (WAZE_FEED_URL) is the reliable option.`
          : `Waze answered HTTP ${response.status}`,
      );
      error.status = response.status;
      throw error;
    }
    return response.json();
  }

  async function reports(bbox) {
    if (mode === 'off') return { ok: false, disabled: true, items: [], error: 'Waze is turned off (WAZE_MODE=off)' };
    if (mode === 'feed') {
      if (!feedUrl) return { ok: false, items: [], error: 'WAZE_MODE=feed needs WAZE_FEED_URL' };
      const body = await cache.get('feed', () => fetchJson(feedUrl));
      return { ok: true, source: 'Waze for Cities feed', items: parseWazeBody(body, bbox) };
    }
    if (bboxSpan(bbox) > MAX_SPAN_DEGREES)
      return { ok: true, zoomIn: true, items: [], source: 'Waze live map', error: 'Zoom in to load Waze reports' };
    const [left, bottom, right, top] = snapBbox(bbox, 0.02);
    const url = new URL(LIVE_MAP_URL);
    url.search = new URLSearchParams({
      top: String(top),
      bottom: String(bottom),
      left: String(left),
      right: String(right),
      env: region,
      types: 'alerts',
    });
    const body = await cache.get(url.href, () =>
      fetchJson(url.href, { Referer: 'https://www.waze.com/live-map/' }),
    );
    return { ok: true, source: 'Waze live map', items: parseWazeBody(body, bbox) };
  }

  return { reports, mode };
}
