/** The live 2D map: basemaps, radar overlays and one marker group per layer. */

import { KINDS, SEVERITY_COLORS, describe, glyphHtml, esc } from './util.js';

const FRESH_MS = 15 * 60_000;

export function createMap(element, { center, zoom, onSelect }) {
  const map = L.map(element, { zoomControl: false, worldCopyJump: true, minZoom: 3 }).setView(center, zoom);
  L.control.zoom({ position: 'bottomright' }).addTo(map);
  L.control.scale({ position: 'bottomleft' }).addTo(map);

  map.createPane('labels').style.zIndex = 360;
  map.getPane('labels').style.pointerEvents = 'none';
  const esri = 'https://server.arcgisonline.com/ArcGIS/rest/services';
  const bases = {
    Dark: L.layerGroup([
      L.tileLayer(`${esri}/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}`, {
        maxZoom: 20,
        maxNativeZoom: 16,
        attribution: 'Basemap &copy; Esri, HERE, Garmin, &copy; OpenStreetMap contributors',
      }),
      L.tileLayer(`${esri}/Canvas/World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}`, {
        pane: 'labels',
        maxZoom: 20,
        maxNativeZoom: 16,
      }),
    ]),
    Streets: L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; OpenStreetMap contributors',
    }),
    Satellite: L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
      maxZoom: 19,
      attribution: 'Imagery &copy; Esri',
    }),
  };
  bases.Dark.addTo(map);
  L.control.layers(bases, null, { position: 'bottomright' }).addTo(map);

  map.createPane('radar').style.zIndex = 350;
  map.createPane('alerts').style.zIndex = 380;

  const groups = {};
  for (const key of ['weather', 'cyclones', 'cctv', 'alpr', 'waze', 'police'])
    groups[key] = L.layerGroup().addTo(map);

  const radar = {
    us: L.tileLayer('', { pane: 'radar', opacity: 0.6, maxZoom: 20, maxNativeZoom: 12, attribution: 'NEXRAD &copy; Iowa Environmental Mesonet' }),
    global: L.tileLayer('', { pane: 'radar', opacity: 0.55, maxZoom: 20, maxNativeZoom: 7, attribution: 'Radar &copy; RainViewer' }),
  };

  function markerFor(item) {
    const fresh = item.kind === 'police' && Number.isFinite(item.reportedAt) && Date.now() - item.reportedAt < FRESH_MS;
    const cone =
      item.kind === 'cctv' && Number.isFinite(item.headingDeg)
        ? `<span class="cone" style="transform:rotate(${item.headingDeg}deg)"></span>`
        : item.kind === 'alpr' && Number.isFinite(item.directionDeg)
          ? `<span class="cone" style="transform:rotate(${item.directionDeg}deg);border-bottom-color:rgb(244 114 182 / .35)"></span>`
          : '';
    const icon = L.divIcon({
      className: 'mk',
      html: `${cone}${glyphHtml(item, { fresh })}`,
      iconSize: [22, 22],
      iconAnchor: [11, 11],
    });
    const { title, subtitle } = describe(item);
    return L.marker([item.lat, item.lon], { icon, keyboard: false, riseOnHover: true })
      .bindTooltip(`<b>${esc(title)}</b>${subtitle ? `<br><span style="color:#8193a5">${esc(subtitle)}</span>` : ''}`, {
        direction: 'top',
        offset: [0, -12],
      })
      .on('click', () => onSelect(item));
  }

  function alertShape(item) {
    const color = SEVERITY_COLORS[item.severity] || SEVERITY_COLORS.Unknown;
    return L.geoJSON(item.geometry, {
      pane: 'alerts',
      style: { color, weight: 1.5, fillColor: color, fillOpacity: 0.12, opacity: 0.85 },
    })
      .bindTooltip(`<b>${esc(item.event)}</b><br><span style="color:#8193a5">${esc(item.areaDesc.slice(0, 120))}</span>`, { sticky: true })
      .on('click', () => onSelect(item));
  }

  /** Replace a group's contents. */
  function setItems(key, items) {
    const group = groups[key];
    group.clearLayers();
    for (const item of items) {
      if (item.kind === 'weather') {
        if (item.geometry) group.addLayer(alertShape(item));
      } else if (Number.isFinite(item.lat) && Number.isFinite(item.lon)) group.addLayer(markerFor(item));
    }
  }

  function setVisible(key, on) {
    const layer = groups[key];
    if (!layer) return;
    if (on && !map.hasLayer(layer)) layer.addTo(map);
    if (!on && map.hasLayer(layer)) map.removeLayer(layer);
  }

  function setRadar(which, on, url) {
    const layer = radar[which];
    if (url && layer._url !== url) layer.setUrl(url);
    if (on && url && !map.hasLayer(layer)) layer.addTo(map);
    if (!on && map.hasLayer(layer)) map.removeLayer(layer);
  }

  let highlightLayer = null;
  function highlight(item) {
    if (highlightLayer) map.removeLayer(highlightLayer);
    if (!Number.isFinite(item.lat) || !Number.isFinite(item.lon)) return;
    highlightLayer = L.marker([item.lat, item.lon], {
      icon: L.divIcon({ className: 'mk', html: '<div class="mk-highlight" style="width:40px;height:40px"></div>', iconSize: [40, 40], iconAnchor: [20, 20] }),
      interactive: false,
      zIndexOffset: -100,
    }).addTo(map);
    setTimeout(() => {
      if (highlightLayer) map.removeLayer(highlightLayer);
      highlightLayer = null;
    }, 4000);
  }

  /** Pan to an item when it is off screen, or fit an alert's area. */
  function reveal(item) {
    if (item.kind === 'weather' && item.bbox) {
      const [w, s, e, n] = item.bbox;
      const bounds = L.latLngBounds([s, w], [n, e]);
      if (!map.getBounds().contains(bounds)) map.flyToBounds(bounds, { padding: [30, 30], maxZoom: 11, duration: 0.8 });
      return;
    }
    if (!Number.isFinite(item.lat)) return;
    const point = L.latLng(item.lat, item.lon);
    if (!map.getBounds().pad(-0.1).contains(point)) map.flyTo(point, Math.max(map.getZoom(), 13), { duration: 0.8 });
  }

  function view() {
    const bounds = map.getBounds();
    const clampLon = (value) => Math.max(-180, Math.min(180, value));
    const clampLat = (value) => Math.max(-85, Math.min(85, value));
    const center = map.getCenter().wrap();
    return {
      center: { lat: center.lat, lon: center.lng },
      zoom: map.getZoom(),
      bbox: [clampLon(bounds.getWest()), clampLat(bounds.getSouth()), clampLon(bounds.getEast()), clampLat(bounds.getNorth())],
    };
  }

  return { map, setItems, setVisible, setRadar, highlight, reveal, view, kinds: KINDS };
}
