/** Wires the console together: layers, refresh loop, feed, globe, panels, analyst. */

import {
  $,
  KINDS,
  SEVERITY_COLORS,
  WAZE_KINDS,
  describe,
  distanceKm,
  getJson,
  glyph,
  h,
  km,
  postJson,
  shortAgo,
  storage,
  store,
  untilShort,
} from './util.js';
import { createMap } from './map.js';
import { cameraForView, cameraLookingAt, createGlobe } from './globe.js';
import { createPanels } from './panels.js';
import { createAnalyst } from './analyst.js';

const LAYERS = [
  { key: 'police', label: 'Police reports', sub: 'Waze', color: 'var(--police)', source: 'waze', on: true },
  { key: 'waze', label: 'Accidents, hazards, closures', sub: 'Waze', color: 'var(--accident)', source: 'waze', on: true },
  { key: 'weather', label: 'Weather alerts', sub: 'NWS', color: 'var(--sev-severe)', source: 'weather', on: true },
  { key: 'radarUs', label: 'Radar · US', sub: 'NEXRAD', color: '#38bdf8', radar: 'us', on: true },
  { key: 'radarGlobal', label: 'Radar · global', sub: 'RainViewer', color: '#7dd3fc', radar: 'global', on: false },
  { key: 'cctv', label: 'CCTV cameras', sub: 'GodsView', color: 'var(--cctv)', source: 'cctv', on: true },
  { key: 'alpr', label: 'ALPR cameras', sub: 'GodsView · OSM', color: 'var(--alpr)', source: 'alpr', on: true },
  { key: 'cyclones', label: 'Tropical cyclones', sub: 'GodsView · NHC', color: 'var(--cyclone)', source: 'cyclones', on: false },
];

const SOURCES = {
  waze: { path: '/api/layers/waze', everyMs: 60_000, perView: true },
  weather: { path: '/api/layers/weather', everyMs: 120_000, perView: true },
  cctv: { path: '/api/layers/cctv', everyMs: 300_000, perView: true },
  alpr: { path: '/api/layers/alpr', everyMs: 900_000, perView: true },
  cyclones: { path: '/api/layers/cyclones', everyMs: 600_000, perView: false },
};

// Console layers the GodsView globe can show too, by GodsView layer id.
const GLOBE_LAYER_FOR = { cctv: 'cctv', alpr: 'alpr-cameras', radarUs: 'weather-radar', radarGlobal: 'weather-radar', cyclones: 'weather-cyclones' };
const GLOBE_EXTRAS = [
  ['flights', 'Flights'],
  ['traffic', 'Traffic'],
  ['earthquakes', 'Earthquakes'],
  ['fire-perimeters', 'Fire perimeters'],
  ['weather-lightning', 'Lightning'],
  ['satellites', 'Satellites'],
];
// Layer names the analyst's focus_map uses.
const ANALYST_LAYERS = { weather: 'weather', radar: 'radarUs', cctv: 'cctv', alpr: 'alpr', police: 'police', waze: 'waze', cyclones: 'cyclones' };
const NEXRAD = 'https://mesonet.agron.iastate.edu/cache/tile.py/1.0.0/nexrad-n0q-900913/{z}/{x}/{y}.png';

const state = {
  on: Object.fromEntries(LAYERS.map((layer) => [layer.key, storage(`gvc.layer.${layer.key}`, layer.on)])),
  data: Object.fromEntries(Object.keys(SOURCES).map((key) => [key, { items: [] }])),
  seq: {},
  status: null,
  follow: true,
  focus: null,
  extras: new Set(storage('gvc.globeExtras', ['flights'])),
  tab: 'all',
  seenPolice: null,
  radarFrames: null,
};

const status = await getJson('/api/status');
state.status = status;
const saved = storage('gvc.view', null);

const map = createMap($('#map'), {
  center: saved?.center ? [saved.center.lat, saved.center.lon] : status.map.center,
  zoom: saved?.zoom ?? status.map.zoom,
  onSelect: openItem,
});

const globe = createGlobe({
  frame: $('#globe-frame'),
  overlay: $('#globe-offline'),
  gevUrl: status.gev.publicUrl || status.gev.url,
  onStart: startGodsView,
  onOpenFull: openFullGodsView,
});

const panels = createPanels({
  container: $('#panels'),
  anchor: document.querySelector('.map-wrap'),
  onOpen: openItem,
  onLocate: (item) => {
    map.reveal(item);
    map.highlight(item);
  },
  onGlobe: lookOnGlobe,
});

createAnalyst({
  getView: () => ({ ...map.view(), layers: LAYERS.filter((layer) => state.on[layer.key]).map((layer) => layer.label) }),
  getBriefBbox: () => map.view().bbox,
  onAction: handleAction,
});

/* ---------- items ---------- */

function openItem(item) {
  panels.open(item);
  map.highlight(item);
  map.reveal(item);
  state.focus = item;
}

function lookOnGlobe(item) {
  setFollow(false);
  state.focus = item;
  let camera;
  if (item.kind === 'weather' && item.bbox)
    camera = cameraForView({ center: { lat: item.lat, lon: item.lon }, bbox: item.bbox });
  else if (item.kind === 'cyclone') camera = { lat: item.lat, lon: item.lon, altitude_m: 1_800_000, heading_deg: 0, pitch_deg: -90 };
  else
    camera = cameraLookingAt(item, {
      headingDeg: item.headingDeg ?? item.directionDeg ?? 0,
      pitchDeg: -30,
      rangeM: item.kind === 'cctv' || item.kind === 'alpr' ? 450 : 900,
    });
  if ($('#layout').dataset.view === 'map') setLayout('split');
  globe.show(globeView(camera));
}

function handleAction(action) {
  if (action.type === 'open') action.items.forEach(openItem);
  else if (action.type === 'focus') {
    for (const name of action.layers || []) {
      const key = ANALYST_LAYERS[name];
      if (key && !state.on[key]) toggleLayer(key, true);
    }
    map.map.flyTo([action.lat, action.lon], action.zoom ?? Math.max(map.map.getZoom(), 12), { duration: 1 });
  } else if (action.type === 'globe' && action.view) {
    setFollow(false);
    if ($('#layout').dataset.view === 'map') setLayout('split');
    globe.show(action.view);
  }
}

/* ---------- layers ---------- */

const bboxParam = () => map.view().bbox.map((value) => value.toFixed(4)).join(',');

async function load(sourceKey, { retry = 0 } = {}) {
  const needed = LAYERS.some((layer) => layer.source === sourceKey && state.on[layer.key]);
  if (!needed) {
    state.data[sourceKey] = { items: [], off: true };
    applySource(sourceKey);
    return;
  }
  const id = (state.seq[sourceKey] = (state.seq[sourceKey] || 0) + 1);
  state.data[sourceKey] = { ...state.data[sourceKey], loading: true };
  renderLayers();
  const source = SOURCES[sourceKey];
  const url = source.perView ? `${source.path}?bbox=${bboxParam()}` : source.path;
  const result = await getJson(url).catch((error) => ({ ok: false, items: [], error: error.message }));
  if (id !== state.seq[sourceKey]) return;
  state.data[sourceKey] = { ...result, items: result.items || [], loadedAt: Date.now() };
  if (sourceKey === 'waze') announceNewPolice(state.data.waze.items);
  applySource(sourceKey);
  // Weather zone shapes arrive over a few requests in a large view.
  if (sourceKey === 'weather' && result.ok && !result.complete && retry < 6)
    setTimeout(() => {
      if (id === state.seq.weather) load('weather', { retry: retry + 1 });
    }, 2500);
}

function applySource(sourceKey) {
  const items = state.data[sourceKey].items || [];
  if (sourceKey === 'waze') {
    map.setItems('police', items.filter((item) => item.kind === 'police'));
    map.setItems('waze', items.filter((item) => item.kind !== 'police'));
    syncGlobe();
  } else map.setItems(sourceKey, items);
  renderLayers();
  renderFeed();
  renderPills();
}

async function applyRadar() {
  map.setRadar('us', state.on.radarUs, `${NEXRAD}?_=${Math.floor(Date.now() / 300_000)}`);
  if (state.on.radarGlobal) {
    const frames = await getJson('/api/layers/radar');
    state.radarFrames = frames;
    const last = frames.frames?.at(-1);
    if (frames.ok && last) map.setRadar('global', true, `${frames.host}${last.path}/256/{z}/{x}/{y}/2/1_1.png`);
  } else map.setRadar('global', false);
  syncGlobe();
}

function toggleLayer(key, on) {
  state.on[key] = on;
  store(`gvc.layer.${key}`, on);
  const layer = LAYERS.find((entry) => entry.key === key);
  map.setVisible(key, on);
  if (layer.radar) applyRadar();
  else load(layer.source);
  syncGlobe();
}

function layerNote(layer) {
  if (layer.radar) {
    if (layer.radar === 'global' && state.on[layer.key] && state.radarFrames?.frames?.length)
      return { text: `frame ${new Date(state.radarFrames.frames.at(-1).time * 1000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}` };
    return null;
  }
  const data = state.data[layer.source];
  if (!state.on[layer.key]) return null;
  if (data.loading && !data.loadedAt) return { text: 'loading…' };
  if (data.gevOffline) return { text: 'GodsView offline', error: true };
  if (data.zoomIn) return { text: data.error || 'zoom in to load' };
  if (data.ok === false) return { text: data.error || 'unavailable', error: true };
  if (layer.source === 'weather' && data.ok && !data.complete) return { text: `resolving ${data.pendingZones} zone shapes…` };
  if (data.truncated) return { text: `showing ${data.items.length} of ${data.total}` };
  return null;
}

function layerCount(layer) {
  if (layer.radar || !state.on[layer.key]) return '';
  const items = state.data[layer.source].items || [];
  if (layer.key === 'police') return items.filter((item) => item.kind === 'police').length;
  if (layer.key === 'waze') return items.filter((item) => item.kind !== 'police').length;
  return state.data[layer.source].loadedAt ? items.length : '';
}

function renderLayers() {
  $('#layer-list').replaceChildren(
    ...LAYERS.map((layer) => {
      const note = layerNote(layer);
      const id = `layer-${layer.key}`;
      return h(
        'li',
        { class: 'layer' },
        h('input', { type: 'checkbox', id, checked: state.on[layer.key], onChange: (event) => toggleLayer(layer.key, event.target.checked) }),
        h('span', { class: 'swatch', style: { background: layer.color } }),
        h('label', { class: 'name', for: id, title: `${layer.label} · ${layer.sub}` }, layer.label, ' ', h('span', { class: 'muted' }, `· ${layer.sub}`)),
        h('span', { class: 'count' }, String(layerCount(layer))),
        note ? h('span', { class: `note${note.error ? ' error' : ''}`, title: note.text }, note.text) : null,
      );
    }),
  );
}

/* ---------- feed ---------- */

function feedItems() {
  const center = map.view().center;
  const waze = state.data.waze.items || [];
  const police = state.on.police ? waze.filter((item) => item.kind === 'police') : [];
  const other = state.on.waze ? waze.filter((item) => item.kind !== 'police' && item.kind !== 'jam') : [];
  const weather = state.on.weather ? state.data.weather.items || [] : [];
  const cyclones = state.on.cyclones ? state.data.cyclones.items || [] : [];
  const byDistance = (list) =>
    list
      .map((item) => ({ item, d: distanceKm(center, item) }))
      .sort((a, b) => a.d - b.d)
      .map(({ item, d }) => Object.assign(item, { _d: d }));
  const cctv = state.on.cctv ? byDistance([...(state.data.cctv.items || [])]) : [];
  const alpr = state.on.alpr ? byDistance([...(state.data.alpr.items || [])]) : [];
  switch (state.tab) {
    case 'police':
      return [...police, ...other].sort((a, b) => (b.reportedAt ?? 0) - (a.reportedAt ?? 0));
    case 'weather':
      return [...weather, ...cyclones];
    case 'cctv':
      return cctv.slice(0, 200);
    case 'alpr':
      return alpr.slice(0, 200);
    default:
      return [...police, ...weather, ...cyclones, ...other, ...cctv.slice(0, 15), ...alpr.slice(0, 15)];
  }
}

function feedMeta(item) {
  if (WAZE_KINDS.has(item.kind)) return shortAgo(item.reportedAt);
  if (item.kind === 'weather') return untilShort(item.ends || item.expires);
  if (item.kind === 'cyclone') return item.windKt != null ? `${item.windKt} kt` : '';
  return km(item._d);
}

function renderFeed() {
  const items = feedItems();
  $('#feed-count').textContent = items.length ? `· ${items.length}` : '';
  const list = $('#feed-list');
  if (!items.length) {
    list.replaceChildren(
      h('li', { class: 'feed-empty' }, state.tab === 'all' ? 'Nothing loaded in this view yet. Pan, zoom in, or turn on more layers.' : 'Nothing of this kind in view.'),
    );
    return;
  }
  list.replaceChildren(
    ...items.map((item) => {
      const { title, subtitle } = describe(item);
      return h(
        'li',
        { class: 'feed-item' },
        h(
          'button',
          { type: 'button', onClick: () => openItem(item), title: `${title}${subtitle ? ` — ${subtitle}` : ''}` },
          glyph(item, { fresh: item.kind === 'police' && Date.now() - (item.reportedAt ?? 0) < 15 * 60_000 }),
          h('span', {}, h('div', { class: 't' }, title), h('div', { class: 's' }, subtitle || ' ')),
          h('span', { class: 'm' }, feedMeta(item)),
        ),
      );
    }),
  );
}

$('#feed-tabs').addEventListener('click', (event) => {
  const button = event.target.closest('button[data-tab]');
  if (!button) return;
  state.tab = button.dataset.tab;
  for (const other of $('#feed-tabs').querySelectorAll('button')) other.setAttribute('aria-pressed', String(other === button));
  renderFeed();
});

/* ---------- toasts ---------- */

function announceNewPolice(items) {
  const police = items.filter((item) => item.kind === 'police');
  if (!state.seenPolice) {
    state.seenPolice = new Set(police.map((item) => item.id));
    return;
  }
  const fresh = police.filter((item) => !state.seenPolice.has(item.id));
  for (const item of police) state.seenPolice.add(item.id);
  if (!state.on.police) return;
  for (const item of fresh.slice(0, 3)) {
    const toast = h(
      'button',
      { class: 'toast', type: 'button', onClick: () => (openItem(item), toast.remove()) },
      glyph(item, { fresh: true }),
      h('span', {}, h('b', {}, `New police report${item.detail ? ` · ${item.detail}` : ''}`), h('div', { class: 'muted' }, [item.street, item.city].filter(Boolean).join(', ') || 'In view')),
    );
    $('#toasts').append(toast);
    setTimeout(() => toast.remove(), 12_000);
  }
}

/* ---------- globe ---------- */

function globeView(camera) {
  const layers = new Set(state.extras);
  for (const layer of LAYERS) if (state.on[layer.key] && GLOBE_LAYER_FOR[layer.key]) layers.add(GLOBE_LAYER_FOR[layer.key]);
  const annotations = [];
  if (state.focus && Number.isFinite(state.focus.lat))
    annotations.push({ type: 'highlight', latitude: state.focus.lat, longitude: state.focus.lon, label: describe(state.focus).title.slice(0, 100), color: 'cyan' });
  if (state.on.police)
    for (const item of (state.data.waze.items || []).filter((entry) => entry.kind === 'police').slice(0, 16))
      annotations.push({ type: 'pin', latitude: item.lat, longitude: item.lon, label: `Police${item.detail ? ` · ${item.detail}` : ''}`, color: 'red' });
  return { camera, layers: [...layers], annotations: annotations.slice(0, 24) };
}

function syncGlobe() {
  if (state.follow) globe.show(globeView(cameraForView(map.view())));
}

function setFollow(on) {
  state.follow = on;
  $('#globe-follow').checked = on;
  if (on) syncGlobe();
}

$('#globe-follow').addEventListener('change', (event) => setFollow(event.target.checked));

$('#globe-extras').append(
  ...GLOBE_EXTRAS.map(([id, label]) =>
    h(
      'label',
      { class: 'toggle' },
      h('input', {
        type: 'checkbox',
        checked: state.extras.has(id),
        onChange: (event) => {
          if (event.target.checked) state.extras.add(id);
          else state.extras.delete(id);
          store('gvc.globeExtras', [...state.extras]);
          syncGlobe();
        },
      }),
      label,
    ),
  ),
);

// GodsView's full app, voice agent included, cannot be framed; open it in
// its own window at this view so it runs side by side with the console.
async function openFullGodsView() {
  const win = window.open('about:blank', 'godsview-full');
  try {
    const url = await globe.shareUrl(globeView(cameraForView(map.view())));
    if (win) win.location = url;
  } catch {
    if (win) win.location = status.gev.publicUrl || status.gev.url;
  }
}

$('#globe-open').addEventListener('click', openFullGodsView);

/* ---------- status ---------- */

function setPill(id, state_, title) {
  const pill = $(id);
  pill.dataset.state = state_;
  if (title) pill.title = title;
}

function sourcePill(data, label) {
  if (data.off) return ['unknown', `${label}: layer off`];
  if (data.ok === false) return ['error', `${label}: ${data.error || 'unavailable'}`];
  if (data.zoomIn) return ['warn', `${label}: ${data.error || 'zoom in'}`];
  if (data.ok) return ['ok', `${label}: ${data.items.length} items · ${data.source || ''}`];
  return ['unknown', label];
}

function renderPills() {
  setPill('#pill-weather', ...sourcePill(state.data.weather, 'NWS alerts'));
  setPill('#pill-waze', ...sourcePill(state.data.waze, 'Waze'));
}

async function pollStatus() {
  const next = await getJson('/api/status').catch(() => null);
  if (next) {
    const wasOnline = state.status?.gev?.state === 'online';
    state.status = next;
    const gev = next.gev;
    setPill(
      '#pill-gev',
      gev.state === 'online' ? 'ok' : gev.state === 'starting' ? 'starting' : 'error',
      gev.state === 'online' ? `God's Eye View online at ${gev.url}${gev.managed ? ' (started by this app)' : ''}` : gev.lastError || `GodsView ${gev.state}`,
    );
    setPill('#pill-ai', next.ai.keyDetected ? 'ok' : 'warn', next.ai.keyDetected ? `Analyst ready · ${next.ai.model}` : 'No ANTHROPIC_API_KEY found; the analyst will try an `ant auth login` profile.');
    $('#analyst-model').textContent = `${next.ai.model} · GodsView tools${gev.toolCount ? ` (${gev.toolCount})` : ''} + live feeds`;
    globe.setStatus(gev);
    if (gev.state === 'online' && !wasOnline) {
      for (const key of ['cctv', 'alpr', 'cyclones']) load(key);
      syncGlobe();
    }
  }
  setTimeout(pollStatus, next?.gev?.state === 'online' ? 15_000 : 4000);
}

async function startGodsView() {
  setPill('#pill-gev', 'starting', 'Starting GodsView…');
  globe.setStatus({ ...state.status.gev, state: 'starting' });
  const result = await postJson('/api/gev/start', {});
  if (result.gev) globe.setStatus(result.gev);
}

$('#pill-gev').addEventListener('click', () => {
  const gev = state.status?.gev;
  if (gev?.state !== 'online' && gev?.canStart) startGodsView();
  else if ($('#layout').dataset.view === 'map') setLayout('split');
});

/* ---------- layout, search, clock ---------- */

function setLayout(view) {
  $('#layout').dataset.view = view;
  for (const button of document.querySelectorAll('.view-switch button')) button.setAttribute('aria-pressed', String(button.dataset.view === view));
  store('gvc.layout', view);
  setTimeout(() => map.map.invalidateSize(), 60);
}

document.querySelector('.view-switch').addEventListener('click', (event) => {
  const button = event.target.closest('button[data-view]');
  if (button) setLayout(button.dataset.view);
});

{
  const splitter = $('#splitter');
  const stage = $('#stage');
  const saved = storage('gvc.split', null);
  if (saved) stage.style.setProperty('--split', `${saved}%`);
  splitter.addEventListener('pointerdown', (event) => {
    splitter.setPointerCapture(event.pointerId);
    $('#globe-frame').style.pointerEvents = 'none';
    const rect = stage.getBoundingClientRect();
    const move = (e) => {
      const percent = Math.min(80, Math.max(20, ((e.clientX - rect.left) / rect.width) * 100));
      stage.style.setProperty('--split', `${percent.toFixed(1)}%`);
      map.map.invalidateSize({ pan: false });
    };
    const up = () => {
      $('#globe-frame').style.pointerEvents = '';
      splitter.removeEventListener('pointermove', move);
      splitter.removeEventListener('pointerup', up);
      store('gvc.split', Number.parseFloat(stage.style.getPropertyValue('--split')));
    };
    splitter.addEventListener('pointermove', move);
    splitter.addEventListener('pointerup', up);
  });
}

{
  const form = $('#search');
  const input = $('#search-input');
  const results = $('#search-results');
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const query = input.value.trim();
    if (!query) return;
    const coords = /^\s*(-?\d+(?:\.\d+)?)\s*[, ]\s*(-?\d+(?:\.\d+)?)\s*$/.exec(query);
    if (coords) {
      map.map.flyTo([Number(coords[1]), Number(coords[2])], 14);
      results.hidden = true;
      return;
    }
    results.hidden = false;
    results.replaceChildren(h('li', { class: 'muted', style: { padding: '6px 8px' } }, 'Searching…'));
    const found = await getJson(`/api/geocode?q=${encodeURIComponent(query)}`);
    if (!found.results?.length) {
      results.replaceChildren(h('li', { class: 'muted', style: { padding: '6px 8px' } }, found.error || 'No places found.'));
      return;
    }
    results.replaceChildren(
      ...found.results.map((place) =>
        h(
          'li',
          {},
          h(
            'button',
            {
              type: 'button',
              onClick: () => {
                results.hidden = true;
                input.value = place.name.split(',')[0];
                if (place.bbox) map.map.flyToBounds([[place.bbox[1], place.bbox[0]], [place.bbox[3], place.bbox[2]]], { maxZoom: 14, duration: 1 });
                else map.map.flyTo([place.lat, place.lon], 13);
              },
            },
            place.name,
          ),
        ),
      ),
    );
  });
  document.addEventListener('click', (event) => {
    if (!form.contains(event.target)) results.hidden = true;
  });
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') results.hidden = true;
  });
}

function tick() {
  const now = new Date();
  $('#clock').innerHTML = `<b>${now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</b> · ${now.toISOString().slice(11, 16)}Z`;
}
tick();
setInterval(tick, 1000);

/* ---------- start ---------- */

let moveTimer = null;
map.map.on('moveend', () => {
  clearTimeout(moveTimer);
  moveTimer = setTimeout(() => {
    const view = map.view();
    store('gvc.view', { center: view.center, zoom: view.zoom });
    for (const [key, source] of Object.entries(SOURCES)) if (source.perView) load(key);
    syncGlobe();
    renderFeed();
  }, 600);
});

for (const layer of LAYERS) if (!layer.radar) map.setVisible(layer.key, state.on[layer.key]);
setLayout(storage('gvc.layout', 'split'));
renderLayers();
applyRadar();
for (const key of Object.keys(SOURCES)) load(key);
for (const [key, source] of Object.entries(SOURCES)) setInterval(() => load(key), source.everyMs);
setInterval(() => map.setRadar('us', state.on.radarUs, `${NEXRAD}?_=${Math.floor(Date.now() / 300_000)}`), 300_000);
setInterval(() => state.on.radarGlobal && applyRadar(), 600_000);
setInterval(renderFeed, 30_000);
globe.show(globeView(cameraForView(map.view())));
pollStatus();

// For debugging from the browser console.
window.gvc = { state, map, globe, panels, openItem, KINDS, SEVERITY_COLORS };
