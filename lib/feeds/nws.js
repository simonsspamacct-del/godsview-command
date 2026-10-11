/**
 * Active weather alerts from the US National Weather Service.
 *
 * The national feed is about 500 alerts, and most carry no polygon: they
 * name forecast or county zones instead. Alerts are matched to the view by
 * polygon when they have one; otherwise by the states their zones belong to,
 * then by each zone's own shape, fetched once and cached for a day. A large
 * view fills in over a few refreshes rather than fetching hundreds of zones
 * at once.
 */

import { createCache } from '../cache.js';
import { bboxesOverlap, geometryBbox } from '../geo.js';

const API = 'https://api.weather.gov';
const ZONE_FETCHES_PER_REQUEST = 80;
const ZONE_CONCURRENCY = 8;

// Approximate [west, south, east, north] of each zone prefix: states,
// territories and the main marine areas.
const PREFIX_BOUNDS = {
  AL: [-88.5, 30.1, -84.9, 35.0], AK: [-179.2, 51.2, -129.9, 71.4],
  AZ: [-114.9, 31.3, -109.0, 37.0], AR: [-94.7, 33.0, -89.6, 36.5],
  CA: [-124.5, 32.5, -114.1, 42.0], CO: [-109.1, 37.0, -102.0, 41.0],
  CT: [-73.8, 41.0, -71.8, 42.1], DE: [-75.8, 38.4, -75.0, 39.9],
  DC: [-77.2, 38.8, -76.9, 39.0], FL: [-87.7, 24.5, -80.0, 31.0],
  GA: [-85.7, 30.3, -80.8, 35.0], HI: [-160.3, 18.9, -154.8, 22.3],
  ID: [-117.3, 42.0, -111.0, 49.0], IL: [-91.6, 36.9, -87.5, 42.5],
  IN: [-88.1, 37.7, -84.8, 41.8], IA: [-96.7, 40.4, -90.1, 43.5],
  KS: [-102.1, 37.0, -94.6, 40.0], KY: [-89.6, 36.5, -81.9, 39.2],
  LA: [-94.1, 28.9, -88.8, 33.0], ME: [-71.1, 43.0, -66.9, 47.5],
  MD: [-79.5, 37.9, -75.0, 39.7], MA: [-73.5, 41.2, -69.9, 42.9],
  MI: [-90.5, 41.7, -82.4, 48.3], MN: [-97.3, 43.5, -89.5, 49.4],
  MS: [-91.7, 30.1, -88.1, 35.0], MO: [-95.8, 36.0, -89.1, 40.6],
  MT: [-116.1, 44.4, -104.0, 49.0], NE: [-104.1, 40.0, -95.3, 43.0],
  NV: [-120.0, 35.0, -114.0, 42.0], NH: [-72.6, 42.7, -70.6, 45.3],
  NJ: [-75.6, 38.9, -73.9, 41.4], NM: [-109.1, 31.3, -103.0, 37.0],
  NY: [-79.8, 40.5, -71.8, 45.0], NC: [-84.4, 33.8, -75.4, 36.6],
  ND: [-104.1, 45.9, -96.5, 49.0], OH: [-84.9, 38.4, -80.5, 42.0],
  OK: [-103.0, 33.6, -94.4, 37.0], OR: [-124.6, 42.0, -116.4, 46.3],
  PA: [-80.6, 39.7, -74.7, 42.3], RI: [-71.9, 41.1, -71.1, 42.1],
  SC: [-83.4, 32.0, -78.5, 35.2], SD: [-104.1, 42.5, -96.4, 46.0],
  TN: [-90.4, 35.0, -81.6, 36.7], TX: [-106.7, 25.8, -93.5, 36.5],
  UT: [-114.1, 37.0, -109.0, 42.0], VT: [-73.5, 42.7, -71.4, 45.0],
  VA: [-83.7, 36.5, -75.2, 39.5], WA: [-124.9, 45.5, -116.9, 49.0],
  WV: [-82.7, 37.2, -77.7, 40.7], WI: [-92.9, 42.5, -86.2, 47.3],
  WY: [-111.1, 41.0, -104.0, 45.0], PR: [-68.0, 17.8, -65.2, 18.6],
  VI: [-65.1, 17.6, -64.5, 18.5], GU: [144.6, 13.2, 145.1, 13.7],
  AS: [-171.1, -14.6, -168.1, -11.0], MP: [144.8, 14.1, 146.1, 20.6],
  // Marine areas
  AN: [-77.0, 34.5, -66.5, 45.0], AM: [-82.5, 17.0, -64.0, 33.5],
  GM: [-98.0, 23.5, -80.5, 31.0], PZ: [-130.0, 31.0, -117.0, 49.0],
  PK: [-179.2, 51.0, -129.9, 72.0], PH: [-161.0, 18.0, -154.0, 23.0],
  LS: [-92.3, 46.4, -84.3, 49.1], LM: [-88.1, 41.6, -84.7, 46.1],
  LH: [-84.8, 43.0, -79.6, 46.4], LE: [-83.5, 41.3, -78.8, 43.0],
  LO: [-79.9, 43.1, -75.8, 44.3], LC: [-82.6, 42.2, -82.3, 42.7],
  SL: [-76.0, 44.0, -74.6, 45.1],
};

const SEVERITY_RANK = { Extreme: 4, Severe: 3, Moderate: 2, Minor: 1, Unknown: 0 };

const zoneId = (url) => String(url).split('/').pop();
const zonePrefix = (url) => zoneId(url).slice(0, 2).toUpperCase();

export function normalizeAlert(feature, geometry = feature.geometry) {
  const p = feature.properties || {};
  const box = geometry ? geometryBbox(geometry) : null;
  return {
    id: p.id || feature.id,
    kind: 'weather',
    event: p.event || 'Weather alert',
    headline: p.headline || p.event || '',
    severity: p.severity || 'Unknown',
    severityRank: SEVERITY_RANK[p.severity] ?? 0,
    urgency: p.urgency || null,
    certainty: p.certainty || null,
    areaDesc: p.areaDesc || '',
    sent: p.sent || null,
    effective: p.effective || null,
    onset: p.onset || null,
    expires: p.expires || null,
    ends: p.ends || null,
    sender: p.senderName || null,
    description: p.description || '',
    instruction: p.instruction || '',
    response: p.response || null,
    messageType: p.messageType || null,
    geometry: geometry || null,
    bbox: box,
    lat: box ? (box[1] + box[3]) / 2 : null,
    lon: box ? (box[0] + box[2]) / 2 : null,
    zones: (p.affectedZones || []).map(zoneId),
    url: p['@id'] || feature.id || null,
  };
}

/** Run `work` over `items` with at most `limit` running at once. */
async function eachLimited(items, limit, work) {
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) await work(items[next++]);
  });
  await Promise.all(runners);
}

export function createNwsFeed({ userAgent, fetchImpl = globalThis.fetch }) {
  const national = createCache({ ttlMs: 120_000, max: 1 });
  const zones = createCache({ ttlMs: 24 * 3600_000, max: 4000 });
  const points = createCache({ ttlMs: 60_000, max: 500 });
  const failedZones = new Map();

  async function getJson(url, { signal } = {}) {
    const response = await fetchImpl(url, {
      headers: { 'User-Agent': userAgent, Accept: 'application/geo+json' },
      signal: signal ?? AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`NWS answered HTTP ${response.status} for ${url}`);
    return response.json();
  }

  const loadNational = () =>
    national.get('active', async () => {
      const body = await getJson(`${API}/alerts/active?status=actual`);
      return {
        updated: body.updated || new Date().toISOString(),
        features: (body.features || []).filter(
          (feature) => feature.properties?.messageType !== 'Cancel',
        ),
      };
    });

  /** A zone's geometry, or null while it is unknown or failed recently. */
  async function zoneGeometry(url) {
    const failedAt = failedZones.get(url);
    if (failedAt && Date.now() - failedAt < 600_000) return null;
    try {
      return await zones.get(url, async () => (await getJson(url)).geometry || null);
    } catch {
      failedZones.set(url, Date.now());
      return null;
    }
  }

  /** Alerts whose area overlaps `bbox`, most severe first. */
  async function alertsInBbox(bbox) {
    const { updated, features } = await loadNational();
    const matched = [];
    const candidates = [];
    for (const feature of features) {
      if (feature.geometry) {
        const box = geometryBbox(feature.geometry);
        if (box && bboxesOverlap(box, bbox)) matched.push(normalizeAlert(feature));
        continue;
      }
      const zoneUrls = (feature.properties?.affectedZones || []).filter((url) => {
        const bounds = PREFIX_BOUNDS[zonePrefix(url)];
        return bounds && bboxesOverlap(bounds, bbox);
      });
      if (zoneUrls.length) candidates.push({ feature, zoneUrls });
    }

    // Fetch the zone shapes these alerts need, a bounded number per request.
    const missing = [
      ...new Set(candidates.flatMap(({ zoneUrls }) => zoneUrls)),
    ].filter((url) => zones.peek(url) === undefined && !failedZones.has(url));
    await eachLimited(missing.slice(0, ZONE_FETCHES_PER_REQUEST), ZONE_CONCURRENCY, zoneGeometry);

    let pendingZones = 0;
    for (const { feature, zoneUrls } of candidates) {
      const shapes = [];
      for (const url of zoneUrls) {
        const geometry = zones.peek(url);
        if (geometry === undefined) {
          if (!failedZones.has(url)) pendingZones += 1;
          continue;
        }
        if (geometry && bboxesOverlap(geometryBbox(geometry) || [0, 0, 0, 0], bbox)) shapes.push(geometry);
      }
      if (shapes.length)
        matched.push(
          normalizeAlert(feature, { type: 'GeometryCollection', geometries: shapes }),
        );
    }

    matched.sort(
      (a, b) =>
        b.severityRank - a.severityRank ||
        String(b.sent).localeCompare(String(a.sent)),
    );
    return {
      ok: true,
      source: 'NWS api.weather.gov',
      updated,
      items: matched,
      complete: pendingZones === 0,
      pendingZones,
    };
  }

  /** Alerts in force at one point, straight from the point query. */
  async function alertsAtPoint({ lat, lon }) {
    const point = `${lat.toFixed(3)},${lon.toFixed(3)}`;
    return points.get(point, async () => {
      const body = await getJson(`${API}/alerts/active?status=actual&point=${point}`);
      return (body.features || []).map((feature) => normalizeAlert(feature));
    });
  }

  return { alertsInBbox, alertsAtPoint };
}
