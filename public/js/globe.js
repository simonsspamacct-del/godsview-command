/**
 * The God's Eye View pane. It loads GodsView with ?embed=1 and drives it
 * with the embed protocol GodsView documents in src/app/embed.js: post
 * { type: 'gev:view', id, view } and it answers 'gev:view-applied'; it says
 * 'gev:ready' once it takes views.
 *
 * GodsView refuses to be framed unless GEV_EMBED_FRAME_ANCESTORS names this
 * console's origin, and its full app (with the voice agent) can never be
 * framed, so the full app opens in its own window at a share link instead.
 */

import { h, postJson } from './util.js';

const EARTH_RADIUS_M = 6_371_000;
const READY_TIMEOUT_MS = 25_000;

/** The point `distanceM` from (lat, lon) along `bearingDeg`. */
function destination(lat, lon, bearingDeg, distanceM) {
  const rad = Math.PI / 180;
  const d = distanceM / EARTH_RADIUS_M;
  const b = bearingDeg * rad;
  const lat1 = lat * rad;
  const lon1 = lon * rad;
  const lat2 = Math.asin(Math.sin(lat1) * Math.cos(d) + Math.cos(lat1) * Math.sin(d) * Math.cos(b));
  const lon2 = lon1 + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(lat1), Math.cos(d) - Math.sin(lat1) * Math.sin(lat2));
  return { lat: lat2 / rad, lon: ((lon2 / rad + 540) % 360) - 180 };
}

/** A straight-down camera that frames a map view. */
export function cameraForView({ center, bbox }) {
  const [west, , east] = bbox;
  const widthM = Math.abs(east - west) * 111_320 * Math.cos((center.lat * Math.PI) / 180);
  return {
    lat: center.lat,
    lon: center.lon,
    altitude_m: Math.round(Math.min(20_000_000, Math.max(300, widthM * 0.9))),
    heading_deg: 0,
    pitch_deg: -90,
  };
}

/** An oblique camera looking at a point from `rangeM` away along `headingDeg`. */
export function cameraLookingAt({ lat, lon }, { headingDeg = 0, pitchDeg = -35, rangeM = 900 } = {}) {
  const pitch = (Math.abs(pitchDeg) * Math.PI) / 180;
  const back = destination(lat, lon, (headingDeg + 180) % 360, rangeM * Math.cos(pitch));
  return {
    ...back,
    altitude_m: Math.round(Math.max(60, rangeM * Math.sin(pitch))),
    heading_deg: Math.round(((headingDeg % 360) + 360) % 360),
    pitch_deg: Math.round(-Math.abs(pitchDeg)),
  };
}

export function createGlobe({ frame, overlay, gevUrl, onStart }) {
  const origin = new URL(gevUrl).origin;
  let ready = false;
  let loaded = false;
  let pending = null;
  let nextId = 1;
  let lastPosted = '';
  let online = false;
  let readyTimer = null;
  let lastStatus = { url: gevUrl };

  window.addEventListener('message', (event) => {
    if (event.origin !== origin || event.source !== frame.contentWindow) return;
    if (event.data?.type === 'gev:ready') {
      ready = true;
      clearTimeout(readyTimer);
      overlay.hidden = true;
      if (pending) post(pending);
    }
  });

  function post(view) {
    const key = JSON.stringify(view);
    if (key === lastPosted) return;
    lastPosted = key;
    frame.contentWindow?.postMessage({ type: 'gev:view', id: nextId++, view }, origin);
  }

  function load(view) {
    ready = false;
    loaded = true;
    lastPosted = '';
    const c = view.camera;
    frame.src = `${origin}/?embed=1#v=2&lat=${c.lat.toFixed(4)}&lon=${c.lon.toFixed(4)}&alt=${c.altitude_m}&heading=${c.heading_deg}&pitch=${c.pitch_deg}&roll=0`;
    clearTimeout(readyTimer);
    readyTimer = setTimeout(() => {
      if (!ready && online) renderBlocked();
    }, READY_TIMEOUT_MS);
  }

  /** Show a view: { camera, layers, annotations }. */
  function show(view) {
    pending = view;
    if (!online) return;
    if (!loaded) return load(view);
    if (ready) post(view);
  }

  async function shareUrl(view) {
    const result = await postJson('/api/gev/link', { view: { camera: view.camera, layers: view.layers } });
    if (!result.ok || !result.url) throw new Error(result.error || 'GodsView did not return a link');
    return result.url;
  }

  function card(...children) {
    overlay.replaceChildren(h('div', { class: 'card' }, ...children));
    overlay.hidden = false;
  }

  function renderBlocked() {
    card(
      h('h2', {}, 'GodsView is running but will not embed here'),
      h(
        'p',
        { class: 'muted' },
        'GodsView only lets pages it names frame its embed mode. Add this line to the .env in your gods-eye-view folder and restart it (this console adds it for you when it starts GodsView itself):',
      ),
      h('pre', {}, `GEV_EMBED_FRAME_ANCESTORS=${location.origin}`),
      h('div', {}, h('button', { class: 'primary', type: 'button', onClick: () => load(pending) }, 'Try again')),
    );
  }

  function renderOffline(status) {
    card(
      h('h2', {}, status.state === 'starting' ? 'Starting GodsView…' : 'GodsView is not running'),
      h(
        'p',
        { class: 'muted' },
        status.state === 'starting'
          ? `Waiting for God's Eye View at ${status.url}. The first start can take a minute.`
          : status.lastError || `Nothing answers at ${status.url}.`,
      ),
      status.canStart
        ? h('div', {}, h('button', { class: 'primary', type: 'button', onClick: onStart }, 'Start GodsView'))
        : status.state !== 'starting'
          ? h('p', { class: 'muted' }, 'Run ', h('code', {}, 'npm run dev'), ' in your gods-eye-view folder, or set ', h('code', {}, 'GEV_DIR'), ' in .env so this console starts it.')
          : null,
      status.log?.length ? h('pre', {}, status.log.slice(-12).join('\n')) : null,
    );
  }

  function setStatus(status) {
    lastStatus = status;
    const wasOnline = online;
    online = status.state === 'online';
    if (!online) {
      renderOffline(status);
      if (wasOnline) {
        loaded = false;
        ready = false;
        frame.removeAttribute('src');
      }
      return;
    }
    if (!wasOnline) {
      overlay.hidden = true;
      if (pending) load(pending);
    }
  }

  return { show, setStatus, shareUrl, status: () => lastStatus };
}
