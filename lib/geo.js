/** Bounding boxes are [west, south, east, north] in degrees. */

export class BadRequest extends Error {}

/** Parse `w,s,e,n` from a query string, or throw BadRequest. */
export function parseBbox(text) {
  const parts = String(text || '')
    .split(',')
    .map((part) => Number.parseFloat(part));
  if (parts.length !== 4 || parts.some((value) => !Number.isFinite(value)))
    throw new BadRequest('bbox must be west,south,east,north');
  const [west, south, east, north] = parts;
  if (
    Math.abs(west) > 180 ||
    Math.abs(east) > 180 ||
    Math.abs(south) > 90 ||
    Math.abs(north) > 90 ||
    south >= north ||
    west >= east
  )
    throw new BadRequest('bbox is out of range');
  return parts;
}

export const bboxCenter = ([west, south, east, north]) => ({
  lat: (south + north) / 2,
  lon: (west + east) / 2,
});

export const bboxSpan = ([west, south, east, north]) =>
  Math.max(east - west, north - south);

export const bboxesOverlap = (a, b) =>
  a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];

export const bboxContains = ([west, south, east, north], { lat, lon }) =>
  lat >= south && lat <= north && lon >= west && lon <= east;

/** A box around a point, `radiusKm` from the center to each side. */
export function bboxAround({ lat, lon }, radiusKm) {
  const dLat = radiusKm / 111.32;
  const dLon = radiusKm / (111.32 * Math.max(0.05, Math.cos((lat * Math.PI) / 180)));
  return [
    Math.max(-180, lon - dLon),
    Math.max(-90, lat - dLat),
    Math.min(180, lon + dLon),
    Math.min(90, lat + dLat),
  ];
}

export function distanceKm(a, b) {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLon = (b.lon - a.lon) * rad;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** The bounding box of any GeoJSON geometry, or null when it has no points. */
export function geometryBbox(geometry) {
  let box = null;
  const visit = (coords) => {
    if (typeof coords[0] === 'number') {
      const [lon, lat] = coords;
      box = box
        ? [
            Math.min(box[0], lon),
            Math.min(box[1], lat),
            Math.max(box[2], lon),
            Math.max(box[3], lat),
          ]
        : [lon, lat, lon, lat];
      return;
    }
    for (const child of coords) visit(child);
  };
  if (geometry?.type === 'GeometryCollection')
    for (const child of geometry.geometries || []) {
      const childBox = geometryBbox(child);
      if (childBox) visit([[childBox[0], childBox[1]], [childBox[2], childBox[3]]]);
    }
  else if (geometry?.coordinates) visit(geometry.coordinates);
  return box;
}

/** Round a bbox outward to a grid so nearby requests share cache entries. */
export function snapBbox([west, south, east, north], step) {
  const down = (value) => Math.floor(value / step) * step;
  const up = (value) => Math.ceil(value / step) * step;
  return [down(west), down(south), up(east), up(north)].map((value) =>
    Number(value.toFixed(4)),
  );
}

/** Parse `lat`, `lon` and an optional `radius_km` from search params. */
export function parsePoint(params, { maxRadiusKm = 50, defaultRadiusKm = 3 } = {}) {
  const lat = Number.parseFloat(params.get('lat'));
  const lon = Number.parseFloat(params.get('lon'));
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180)
    throw new BadRequest('lat and lon are required');
  const radius = Number.parseFloat(params.get('radius_km'));
  return {
    lat,
    lon,
    radiusKm: Number.isFinite(radius)
      ? Math.min(maxRadiusKm, Math.max(0.1, radius))
      : defaultRadiusKm,
  };
}
