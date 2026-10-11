import test from 'node:test';
import assert from 'node:assert/strict';

import { createWazeFeed, normalizeWazeAlert, parseWazeBody } from '../lib/feeds/waze.js';
import { createNwsFeed } from '../lib/feeds/nws.js';
import { geometryBbox, parseBbox } from '../lib/geo.js';

const now = Date.now();
const WAZE_BODY = {
  alerts: [
    { uuid: 'p1', type: 'POLICE', subtype: 'POLICE_VISIBLE', location: { x: -97.74, y: 30.27 }, street: 'Congress Ave', city: 'Austin, TX', pubMillis: now - 5 * 60_000, nThumbsUp: 3, reliability: 8, confidence: 2 },
    { uuid: 'p2', type: 'POLICE', subtype: 'POLICE_HIDING', location: { x: -97.75, y: 30.26 }, pubMillis: now - 30 * 60_000 },
    { uuid: 'a1', type: 'ACCIDENT', subtype: 'ACCIDENT_MAJOR', location: { x: -97.73, y: 30.28 }, pubMillis: now - 10 * 60_000 },
    { uuid: 'h1', type: 'HAZARD', subtype: 'HAZARD_ON_ROAD_POT_HOLE', location: { x: -97.735, y: 30.275 }, pubMillis: now },
    { uuid: 'c1', type: 'CHIT_CHAT', location: { x: -97.74, y: 30.27 } },
    { uuid: 'far', type: 'POLICE', location: { x: -96.0, y: 32.0 }, pubMillis: now },
  ],
};

test('Waze alerts normalize to console items', () => {
  const item = normalizeWazeAlert(WAZE_BODY.alerts[0]);
  assert.equal(item.kind, 'police');
  assert.equal(item.detail, 'Visible');
  assert.equal(item.lat, 30.27);
  assert.equal(item.lon, -97.74);
  assert.equal(item.thumbsUp, 3);
  assert.equal(normalizeWazeAlert(WAZE_BODY.alerts[3]).detail, 'Pot hole');
  assert.equal(normalizeWazeAlert(WAZE_BODY.alerts[4]), null, 'chit-chat is not shown');
});

test('Waze bodies are filtered to the box and sorted newest first', () => {
  const items = parseWazeBody(WAZE_BODY, [-97.8, 30.2, -97.7, 30.3]);
  assert.deepEqual(items.map((item) => item.id), ['h1', 'p1', 'a1', 'p2']);
});

test('Waze live map refusals become readable errors', async () => {
  const feed = createWazeFeed({
    mode: 'livemap',
    region: 'na',
    userAgent: 'test',
    fetchImpl: async () => new Response('<title>403</title>', { status: 403 }),
  });
  await assert.rejects(feed.reports([-97.8, 30.2, -97.7, 30.3]), /Waze refused the request \(HTTP 403\)/);
});

test('Waze asks to zoom in for very large views and reads partner feeds', async () => {
  const live = createWazeFeed({ mode: 'livemap', region: 'na', userAgent: 'test', fetchImpl: async () => assert.fail('no fetch') });
  assert.equal((await live.reports([-100, 25, -90, 35])).zoomIn, true);
  const seen = [];
  const partner = createWazeFeed({
    mode: 'feed',
    feedUrl: 'https://example.test/feed',
    region: 'na',
    userAgent: 'test',
    fetchImpl: async (url) => (seen.push(String(url)), Response.json(WAZE_BODY)),
  });
  const result = await partner.reports([-97.8, 30.2, -97.7, 30.3]);
  assert.equal(result.items.length, 4);
  assert.deepEqual(seen, ['https://example.test/feed']);
});

test('NWS alerts match the view by polygon or by zone shape', async () => {
  const square = (w, s, e, n) => ({ type: 'Polygon', coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]] });
  const zone = 'https://api.weather.gov/zones/county/TXC453';
  const fetched = [];
  const fetchImpl = async (url) => {
    fetched.push(String(url));
    if (String(url).includes('/alerts/active'))
      return Response.json({
        updated: '2026-10-11T09:00:00Z',
        features: [
          { id: 'poly', geometry: square(-97.8, 30.2, -97.7, 30.3), properties: { id: 'poly', event: 'Flash Flood Warning', severity: 'Severe', affectedZones: [] } },
          { id: 'zoned', geometry: null, properties: { id: 'zoned', event: 'Heat Advisory', severity: 'Moderate', affectedZones: [zone] } },
          { id: 'elsewhere', geometry: null, properties: { id: 'elsewhere', event: 'Winter Storm Warning', severity: 'Severe', affectedZones: ['https://api.weather.gov/zones/forecast/MNZ060'] } },
          { id: 'cancel', geometry: square(-97.8, 30.2, -97.7, 30.3), properties: { id: 'cancel', event: 'Test', messageType: 'Cancel', affectedZones: [] } },
        ],
      });
    if (String(url) === zone) return Response.json({ geometry: square(-98.0, 30.0, -97.4, 30.6) });
    return new Response('not found', { status: 404 });
  };
  const nws = createNwsFeed({ userAgent: 'test', fetchImpl });
  const result = await nws.alertsInBbox([-97.8, 30.2, -97.7, 30.3]);
  assert.deepEqual(result.items.map((item) => item.id), ['poly', 'zoned']);
  assert.equal(result.complete, true);
  assert.equal(result.items[1].geometry.type, 'GeometryCollection');
  assert.ok(!fetched.some((url) => url.includes('MNZ060')), 'zones in states outside the view are not fetched');
});

test('bbox parsing rejects bad input', () => {
  assert.deepEqual(parseBbox('-97.8,30.2,-97.7,30.3'), [-97.8, 30.2, -97.7, 30.3]);
  assert.throws(() => parseBbox('1,2,3'), /west,south,east,north/);
  assert.throws(() => parseBbox('-97.7,30.2,-97.8,30.3'), /out of range/);
  assert.deepEqual(geometryBbox({ type: 'Point', coordinates: [1, 2] }), [1, 2, 1, 2]);
});

test('GodsView is started with its own port, no console secrets, and framing allowed', async () => {
  const { GodsView } = await import('../lib/gev.js');
  const saved = { ...process.env };
  Object.assign(process.env, { PORT: '5050', HOST: '127.0.0.1', ANTHROPIC_API_KEY: 'secret', WAZE_FEED_URL: 'https://x', GEV_EMBED_FRAME_ANCESTORS: 'https://mine.example' });
  try {
    const gev = new GodsView({ url: 'http://localhost:4173', dir: null, autostart: false, frameAncestors: ['http://localhost:5050'], log: () => {} });
    const env = gev.childEnv('4173');
    assert.equal(env.PORT, '4173');
    assert.equal(env.HOST, undefined);
    assert.equal(env.ANTHROPIC_API_KEY, undefined);
    assert.equal(env.WAZE_FEED_URL, undefined);
    assert.equal(env.GEV_EMBED_FRAME_ANCESTORS, 'https://mine.example http://localhost:5050');
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  }
});
