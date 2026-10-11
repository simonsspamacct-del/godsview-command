/**
 * Floating detail panels over the map. Each one shows one item live (a
 * camera's current view, an alert's full text, a report's age) and the live
 * data related to it: what is near a point, or inside a weather alert's area.
 */

import {
  KINDS,
  SEVERITY_COLORS,
  WAZE_KINDS,
  ago,
  compass,
  describe,
  getJson,
  glyph,
  h,
  km,
  until,
  uuid,
  when,
} from './util.js';

const MAX_PANELS = 6;
const FRAME_REFRESH_MS = 5000;

const facts = (rows) =>
  h(
    'dl',
    { class: 'facts' },
    rows.filter(([, value]) => value != null && value !== '').flatMap(([label, value]) => [h('dt', {}, label), h('dd', {}, value)]),
  );

/** Whether a point is inside a GeoJSON geometry (Polygon, MultiPolygon or a collection of them). */
export function contains(geometry, { lat, lon }) {
  if (!geometry) return false;
  const inRing = (ring) => {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i];
      const [xj, yj] = ring[j];
      if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  };
  const inPolygon = (rings) => inRing(rings[0]) && !rings.slice(1).some(inRing);
  switch (geometry.type) {
    case 'Polygon':
      return inPolygon(geometry.coordinates);
    case 'MultiPolygon':
      return geometry.coordinates.some(inPolygon);
    case 'GeometryCollection':
      return geometry.geometries.some((child) => contains(child, { lat, lon }));
    default:
      return false;
  }
}

export function createPanels({ container, anchor, onOpen, onLocate, onGlobe }) {
  const open = new Map();
  let z = 10;
  let cascade = 0;

  const keyOf = (item) => `${item.kind}:${item.id}`;

  function focus(entry) {
    for (const other of open.values()) other.el.classList.remove('focused');
    entry.el.classList.add('focused');
    entry.el.style.zIndex = String(++z);
  }

  function close(key) {
    const entry = open.get(key);
    if (!entry) return;
    for (const cleanup of entry.cleanups) cleanup();
    entry.el.remove();
    open.delete(key);
  }

  function makeDraggable(el, handle) {
    handle.addEventListener('pointerdown', (event) => {
      if (event.target.closest('button, a')) return;
      const start = { x: event.clientX, y: event.clientY, left: el.offsetLeft, top: el.offsetTop };
      handle.setPointerCapture(event.pointerId);
      const move = (e) => {
        const maxLeft = container.clientWidth - 60;
        const maxTop = container.clientHeight - 40;
        el.style.left = `${Math.min(maxLeft, Math.max(-el.offsetWidth + 60, start.left + e.clientX - start.x))}px`;
        el.style.top = `${Math.min(maxTop, Math.max(0, start.top + e.clientY - start.y))}px`;
      };
      const up = () => {
        handle.removeEventListener('pointermove', move);
        handle.removeEventListener('pointerup', up);
      };
      handle.addEventListener('pointermove', move);
      handle.addEventListener('pointerup', up);
    });
  }

  function relatedRow(item, distance) {
    const { title, subtitle } = describe(item);
    return h(
      'li',
      {},
      h(
        'button',
        { type: 'button', onClick: () => onOpen(item), title: subtitle || title },
        glyph(item),
        h('span', { class: 't' }, title),
        h('span', { class: 'd' }, distance ?? (Number.isFinite(item.reportedAt) ? ago(item.reportedAt) : '')),
      ),
    );
  }

  function relatedGroup(label, items, { distance = true, empty } = {}) {
    if (!items.length && !empty) return null;
    return [
      h('h3', {}, `${label}${items.length ? ` · ${items.length}` : ''}`),
      items.length
        ? h('ul', {}, items.map((item) => relatedRow(item, distance ? km(item.distanceKm) : undefined)))
        : h('p', { class: 'muted', style: { margin: '0 0 8px' } }, empty),
    ];
  }

  /** "Nearby live data" for a point item. */
  function nearbySection(item, signal) {
    const section = h('section', { class: 'related' }, h('h3', {}, 'Nearby live data · loading…'));
    const radius = item.kind === 'cyclone' ? 25 : 2;
    getJson(`/api/nearby?lat=${item.lat}&lon=${item.lon}&radius_km=${radius}`, { signal })
      .then((data) => {
        if (signal.aborted) return;
        const self = keyOf(item);
        const not = (other) => keyOf(other) !== self;
        const errors = ['cctv', 'alpr', 'waze', 'weather']
          .map((key) => (data[key]?.error && !data[key]?.zoomIn ? `${key.toUpperCase()}: ${data[key].error}` : null))
          .filter(Boolean);
        section.replaceChildren(
          ...[
            relatedGroup(`Cameras within ${radius} km`, data.cctv.items.filter(not).slice(0, 4), { empty: 'No public cameras in the GodsView catalog here.' }),
            relatedGroup('Waze reports nearby', data.waze.items.filter(not).slice(0, 5)),
            relatedGroup('ALPR cameras nearby', data.alpr.items.filter(not).slice(0, 3)),
            relatedGroup('Weather alerts in force here', data.weather.items.filter(not), { distance: false }),
          ].flat().filter(Boolean),
          errors.length ? h('p', { class: 'note-box' }, errors.join(' · ')) : null,
        );
        if (!section.children.length) section.append(h('p', { class: 'muted' }, 'Nothing else live within range.'));
      })
      .catch(() => {
        if (!signal.aborted) section.replaceChildren(h('p', { class: 'muted' }, 'Nearby data is unavailable.'));
      });
    return section;
  }

  /** Cameras and Waze reports inside a weather alert's area. */
  function alertAreaSection(item, signal) {
    const section = h('section', { class: 'related' });
    if (!item.bbox || !item.geometry) return section;
    const [w, s, e, n] = item.bbox;
    const span = Math.max(e - w, n - s);
    section.append(h('h3', {}, 'Inside this alert area · loading…'));
    const bbox = item.bbox.map((value) => value.toFixed(4)).join(',');
    Promise.all([
      span <= 12 ? getJson(`/api/layers/cctv?bbox=${bbox}`, { signal }) : Promise.resolve({ items: [], error: 'Area too large for a camera search' }),
      span <= 2 ? getJson(`/api/layers/waze?bbox=${bbox}`, { signal }) : Promise.resolve({ items: [] }),
    ])
      .then(([cctv, waze]) => {
        if (signal.aborted) return;
        const center = { lat: item.lat, lon: item.lon };
        const inside = (list) => (list.items || []).filter((other) => contains(item.geometry, other));
        const withDistance = (list) =>
          list
            .map((other) => ({ ...other, distanceKm: Math.hypot((other.lat - center.lat) * 111, (other.lon - center.lon) * 111 * Math.cos((center.lat * Math.PI) / 180)) }))
            .sort((a, b) => a.distanceKm - b.distanceKm);
        const cams = withDistance(inside(cctv));
        const reports = inside(waze).filter((report) => report.kind !== 'jam');
        section.replaceChildren(
          ...[
            relatedGroup('Public cameras inside the area', cams.slice(0, 6), {
              distance: false,
              empty: cctv.error ? `Cameras: ${cctv.error}` : 'No cameras from the GodsView catalog inside this area.',
            }),
            relatedGroup('Waze reports inside the area', reports.slice(0, 6), { distance: false }),
          ].flat().filter(Boolean),
        );
      })
      .catch(() => {
        if (!signal.aborted) section.replaceChildren(h('p', { class: 'muted' }, 'Could not load data for this area.'));
      });
    return section;
  }

  function cctvMedia(item, cleanups) {
    const media = h('div', { class: 'media' });
    const stamp = h('span', { class: 'stamp' }, '');
    const id = encodeURIComponent(item.id);
    const showError = (text) => media.replaceChildren(h('div', { class: 'media-error' }, text));

    const frames = () => {
      const img = h('img', { alt: `Current view from ${item.name || 'camera'}` });
      media.replaceChildren(img, h('span', { class: 'live' }, 'LIVE'), stamp);
      let failures = 0;
      const load = () => {
        const next = new Image();
        next.onload = () => {
          failures = 0;
          img.src = next.src;
          stamp.textContent = new Date().toLocaleTimeString();
        };
        next.onerror = () => {
          failures += 1;
          if (failures >= 3) showError('This camera has no image right now.');
        };
        next.src = `/api/cctv/frame/${id}?t=${Date.now()}`;
      };
      load();
      const timer = setInterval(load, FRAME_REFRESH_MS);
      cleanups.push(() => clearInterval(timer));
    };

    const type = item.feedType || 'image';
    if (type === 'hls') {
      const video = h('video', { muted: true, autoplay: true, playsinline: true, controls: true });
      video.muted = true;
      const lease = uuid();
      const src = `/api/cctv/media/${id}?lease=${lease}`;
      media.replaceChildren(video, h('span', { class: 'live' }, 'LIVE'));
      cleanups.push(() => fetch(src, { method: 'DELETE' }).catch(() => {}));
      if (window.Hls?.isSupported()) {
        const hls = new window.Hls({ liveDurationInfinity: true, manifestLoadingMaxRetry: 6 });
        hls.on(window.Hls.Events.ERROR, (_event, data) => {
          if (data.fatal) {
            hls.destroy();
            frames();
          }
        });
        hls.loadSource(src);
        hls.attachMedia(video);
        cleanups.push(() => hls.destroy());
      } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
        video.src = src;
        video.onerror = frames;
      } else frames();
    } else if (type === 'mp4' || type === 'webm') {
      const video = h('video', { src: `/api/cctv/media/${id}`, muted: true, autoplay: true, loop: true, playsinline: true });
      video.muted = true;
      video.onerror = frames;
      media.replaceChildren(video, h('span', { class: 'live' }, 'LIVE'));
      cleanups.push(() => video.removeAttribute('src'));
    } else if (type === 'mjpeg') {
      const img = h('img', { src: `/api/cctv/media/${id}`, alt: 'Live camera stream' });
      img.onerror = frames;
      media.replaceChildren(img, h('span', { class: 'live' }, 'LIVE'));
      cleanups.push(() => img.removeAttribute('src'));
    } else frames();
    return media;
  }

  function actions(item, extra = []) {
    return h(
      'div',
      { class: 'row-actions' },
      h('button', { class: 'ghost', type: 'button', onClick: () => onLocate(item) }, 'Locate on map'),
      Number.isFinite(item.lat) ? h('button', { class: 'ghost', type: 'button', onClick: () => onGlobe(item) }, 'Look on globe') : null,
      ...extra,
    );
  }

  function body(item, cleanups, signal) {
    const coords = Number.isFinite(item.lat) ? `${item.lat.toFixed(5)}, ${item.lon.toFixed(5)}` : null;
    if (item.kind === 'cctv')
      return [
        cctvMedia(item, cleanups),
        facts([
          ['City', item.city],
          ['Provider', item.provider],
          ['Feed', item.feedType],
          ['Facing', Number.isFinite(item.headingDeg) ? `${compass(item.headingDeg)} (approx.)` : null],
          ['Credit', item.credit],
          ['Location', coords],
        ]),
        actions(item),
        nearbySection(item, signal),
      ];
    if (item.kind === 'alpr')
      return [
        facts([
          ['Operator', item.operator || 'not tagged'],
          ['Maker', item.manufacturer],
          ['Type', item.cameraType],
          ['Facing', Number.isFinite(item.directionDeg) ? compass(item.directionDeg) : null],
          ['Zone', item.zone],
          ['Verified', item.lastVerified],
          ['Location', coords],
        ]),
        h('p', { class: 'note-box' }, 'Camera location and tags mapped by OpenStreetMap contributors. This is where a reader is mounted, not plate data.'),
        actions(item, [item.osmUrl ? h('a', { class: 'ghost', href: item.osmUrl, target: '_blank', rel: 'noopener', style: { textDecoration: 'none' } }, 'OSM ↗') : null]),
        nearbySection(item, signal),
      ];
    if (item.kind === 'weather') {
      const color = SEVERITY_COLORS[item.severity] || SEVERITY_COLORS.Unknown;
      const expires = h('dd', {}, `${when(item.ends || item.expires)} · ${until(item.ends || item.expires)}`);
      const timer = setInterval(() => (expires.textContent = `${when(item.ends || item.expires)} · ${until(item.ends || item.expires)}`), 30_000);
      cleanups.push(() => clearInterval(timer));
      return [
        h('div', {}, h('span', { class: 'sev', style: { background: color } }, item.severity), ' ', h('span', { class: 'muted' }, [item.urgency, item.certainty].filter(Boolean).join(' · '))),
        item.headline ? h('b', {}, item.headline) : null,
        h('dl', { class: 'facts' }, h('dt', {}, 'Issued'), h('dd', {}, when(item.sent)), h('dt', {}, 'Until'), expires, h('dt', {}, 'From'), h('dd', {}, item.sender || 'NWS'), h('dt', {}, 'Area'), h('dd', {}, item.areaDesc)),
        item.description ? h('pre', { class: 'alert-text' }, item.description) : null,
        item.instruction ? h('pre', { class: 'alert-text', style: { borderLeft: `3px solid ${color}` } }, item.instruction) : null,
        actions(item, [item.url ? h('a', { class: 'ghost', href: item.url, target: '_blank', rel: 'noopener', style: { textDecoration: 'none' } }, 'NWS ↗') : null]),
        item.geometry ? alertAreaSection(item, signal) : Number.isFinite(item.lat) ? nearbySection(item, signal) : null,
      ];
    }
    if (item.kind === 'cyclone')
      return [
        facts([
          ['Class', item.classification],
          ['Basin', item.basin],
          ['Wind', item.windKt != null ? `${item.windKt} kt` : null],
          ['Pressure', item.pressureHpa != null ? `${item.pressureHpa} hPa` : null],
          ['Movement', typeof item.movement === 'string' ? item.movement : item.movement ? JSON.stringify(item.movement) : null],
          ['Advisory', item.advisory],
          ['Issued', when(item.issuedAt)],
          ['Position', coords],
        ]),
        actions(item, [item.advisoryUrl ? h('a', { class: 'ghost', href: item.advisoryUrl, target: '_blank', rel: 'noopener', style: { textDecoration: 'none' } }, 'Advisory ↗') : null]),
      ];
    // Waze reports
    const reported = h('dd', {}, Number.isFinite(item.reportedAt) ? `${ago(item.reportedAt)} (${new Date(item.reportedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })})` : '—');
    const timer = setInterval(() => {
      if (Number.isFinite(item.reportedAt)) reported.firstChild.textContent = `${ago(item.reportedAt)} (${new Date(item.reportedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })})`;
    }, 30_000);
    cleanups.push(() => clearInterval(timer));
    return [
      h(
        'dl',
        { class: 'facts' },
        h('dt', {}, 'Report'),
        h('dd', {}, [item.title, item.detail].filter(Boolean).join(' · ')),
        h('dt', {}, 'Reported'),
        reported,
        ...[
          ['Street', item.street],
          ['City', item.city],
          ['Thumbs up', item.thumbsUp],
          ['Reliability', item.reliability != null ? `${item.reliability} / 10` : null],
          ['Confidence', item.confidence != null ? `${item.confidence} / 5` : null],
          ['Location', coords],
        ]
          .filter(([, value]) => value != null && value !== '')
          .flatMap(([label, value]) => [h('dt', {}, label), h('dd', {}, String(value))]),
      ),
      item.description ? h('p', {}, `“${item.description}”`) : null,
      h('p', { class: 'note-box' }, 'Unverified crowd report from Waze users.'),
      actions(item),
      nearbySection(item, signal),
    ];
  }

  function openPanel(item) {
    const key = keyOf(item);
    if (open.has(key)) {
      focus(open.get(key));
      return;
    }
    if (open.size >= MAX_PANELS) close(open.keys().next().value);

    const meta = KINDS[item.kind] || {};
    const { title } = describe(item);
    const controller = new AbortController();
    const cleanups = [() => controller.abort()];
    const head = h(
      'header',
      { class: 'panel-head' },
      glyph(item),
      h('div', { class: 'panel-title' }, h('span', {}, WAZE_KINDS.has(item.kind) ? `Waze · ${meta.label}` : meta.label), h('b', { title }, title)),
      h('button', { type: 'button', title: 'Locate on map', 'aria-label': 'Locate on map', onClick: () => onLocate(item) }, '⌖'),
      h('button', { type: 'button', title: 'Close', 'aria-label': 'Close panel', onClick: () => close(key) }, '✕'),
    );
    const el = h(
      'section',
      { class: 'panel', style: { '--kind': item.kind === 'weather' ? SEVERITY_COLORS[item.severity] || meta.color : meta.color } },
      head,
      h('div', { class: 'panel-body' }, body(item, cleanups, controller.signal)),
    );
    // Float over the right edge of the map, or of the globe when the map is hidden.
    const stage = container.getBoundingClientRect();
    const mapArea = anchor?.getBoundingClientRect();
    const right = mapArea && mapArea.width > 380 ? mapArea.right - stage.left : container.clientWidth;
    const width = Math.min(340, container.clientWidth - 24);
    el.style.width = `${width}px`;
    const top = 12 + cascade * 30;
    el.style.left = `${Math.max(12, right - width - 14 - cascade * 24)}px`;
    el.style.top = `${top}px`;
    el.style.maxHeight = `calc(100% - ${top + 12}px)`;
    cascade = (cascade + 1) % 5;
    el.addEventListener('pointerdown', () => focus(entry));
    makeDraggable(el, head);
    container.append(el);
    const entry = { el, cleanups };
    open.set(key, entry);
    focus(entry);
  }

  // Keep panels on screen when the window or layout changes size.
  new ResizeObserver(() => {
    for (const { el } of open.values()) {
      const width = Math.min(340, container.clientWidth - 24);
      el.style.width = `${width}px`;
      const maxLeft = container.clientWidth - width - 8;
      if (el.offsetLeft > maxLeft) el.style.left = `${Math.max(8, maxLeft)}px`;
    }
  }).observe(container);

  return {
    open: openPanel,
    close,
    closeAll: () => [...open.keys()].forEach(close),
    isOpen: (item) => open.has(keyOf(item)),
  };
}
