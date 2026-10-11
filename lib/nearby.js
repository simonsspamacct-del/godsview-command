/**
 * Everything near one point, from every source at once: the related live
 * data a detail panel offers next to the item it shows.
 */

import { bboxAround, distanceKm } from './geo.js';
import { ALPR_MAX_SPAN } from './feeds/godsview.js';

const settle = async (promise) => {
  try {
    return await promise;
  } catch (error) {
    return { ok: false, items: [], error: error.message };
  }
};

function nearest(result, point, radiusKm) {
  const items = (result.items || [])
    .map((item) => ({ ...item, distanceKm: Number(distanceKm(point, item).toFixed(2)) }))
    .filter((item) => item.distanceKm <= radiusKm)
    .sort((a, b) => a.distanceKm - b.distanceKm);
  return { ...result, items };
}

export function createNearby({ gevLayers, waze, nws, registry }) {
  return async function nearby({ lat, lon, radiusKm }) {
    const point = { lat, lon };
    const box = bboxAround(point, radiusKm);
    // ALPR areas must stay city-sized.
    const alprBox = bboxAround(point, Math.min(radiusKm, (ALPR_MAX_SPAN * 111) / 2.5));
    const [cctv, alpr, wazeResult, weather] = await Promise.all([
      settle(gevLayers.cctv(box, { limit: 60 })),
      settle(gevLayers.alpr(alprBox, { limit: 60 })),
      settle(waze.reports(box)),
      settle(nws.alertsAtPoint(point).then((items) => ({ ok: true, items }))),
    ]);
    const result = {
      point,
      radiusKm,
      cctv: nearest(cctv, point, radiusKm),
      alpr: nearest(alpr, point, radiusKm),
      waze: nearest(wazeResult, point, radiusKm),
      weather,
    };
    for (const key of ['cctv', 'alpr', 'waze', 'weather']) registry.addAll(result[key].items);
    return result;
  };
}
