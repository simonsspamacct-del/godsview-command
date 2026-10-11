/**
 * Radar overlays. US NEXRAD tiles come from the Iowa Environmental Mesonet
 * and need nothing from the server; the global composite comes from
 * RainViewer, whose frame list changes every ten minutes.
 */

import { createCache } from '../cache.js';

const RAINVIEWER = 'https://api.rainviewer.com/public/weather-maps.json';

export function createRadarFeed({ fetchImpl = globalThis.fetch } = {}) {
  const cache = createCache({ ttlMs: 300_000, max: 1 });
  return {
    frames: () =>
      cache.get('frames', async () => {
        const response = await fetchImpl(RAINVIEWER, { signal: AbortSignal.timeout(15_000) });
        if (!response.ok) throw new Error(`RainViewer answered HTTP ${response.status}`);
        const body = await response.json();
        const past = body.radar?.past || [];
        return {
          ok: true,
          host: body.host,
          generated: body.generated,
          frames: past.map(({ time, path }) => ({ time, path })),
          nexrad:
            'https://mesonet.agron.iastate.edu/cache/tile.py/1.0.0/nexrad-n0q-900913/{z}/{x}/{y}.png',
        };
      }),
  };
}
