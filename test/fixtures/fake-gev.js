/**
 * A stand-in for God's Eye View, for tests only. It speaks the same local
 * MCP endpoint (POST /mcp, stateless JSON-RPC), the same embed protocol on
 * its page (gev:ready, gev:view, gev:view-applied) and the CCTV frame route,
 * with fixed fixture data. Run it directly to try the console without
 * GodsView: `node test/fixtures/fake-gev.js 4173`.
 */

import { createServer } from 'node:http';

export const CCTV_ROWS = [
  { id: 'atx-congress-6th', name: 'Test camera A', city: 'Fixture city', provider: 'Test DOT', lat: 30.2685, lon: -97.7428, heading_deg: 180, feed_type: 'image', credit: 'test fixture' },
  { id: 'atx-i35-mlk', name: 'Test camera B', city: 'Fixture city', provider: 'Test DOT', lat: 30.2829, lon: -97.7334, heading_deg: 0, feed_type: 'image', credit: 'test fixture' },
  { id: 'atx-lamar-5th', name: 'Test camera C', city: 'Fixture city', provider: 'Test city', lat: 30.2694, lon: -97.7536, heading_deg: 90, feed_type: 'image', credit: 'test fixture' },
];

export const ALPR_ROWS = [
  { id: 'node/1001', lat: 30.2711, lon: -97.7404, operator: 'Example PD', manufacturer: 'Flock Safety', camera_type: 'fixed', zone: 'traffic', direction_deg: 270, last_verified: '2026-08-01' },
  { id: 'node/1002', lat: 30.2601, lon: -97.7502, operator: null, manufacturer: 'Motorola Solutions', camera_type: 'fixed', zone: null, direction_deg: null, last_verified: null },
];

const AREA = {
  type: 'object',
  properties: {
    place: { type: 'string' },
    bbox: { type: 'array', items: { type: 'number' }, minItems: 4, maxItems: 4 },
    lat: { type: 'number' },
    lon: { type: 'number' },
    radius_km: { type: 'number' },
  },
  additionalProperties: false,
};

const TOOLS = [
  { name: 'find_cctv_cameras', description: 'Public traffic and city cameras in an area.', inputSchema: { type: 'object', properties: { area: AREA, limit: { type: 'integer' } }, required: ['area'], additionalProperties: false } },
  { name: 'get_cctv_snapshot', description: 'The current image from one public camera.', inputSchema: { type: 'object', properties: { camera_id: { type: 'string' } }, required: ['camera_id'], additionalProperties: false } },
  { name: 'find_alpr_cameras', description: 'ALPR cameras mapped in OpenStreetMap.', inputSchema: { type: 'object', properties: { area: AREA, limit: { type: 'integer' } }, required: ['area'], additionalProperties: false } },
  { name: 'get_cyclones', description: 'Active tropical cyclones.', inputSchema: { type: 'object', properties: { area: AREA }, additionalProperties: false } },
  { name: 'situation_brief', description: 'One overview of an area.', inputSchema: { type: 'object', properties: { area: AREA }, required: ['area'], additionalProperties: false } },
  { name: 'show_in_gods_eye_view', description: "Shows a view in God's Eye View.", inputSchema: { type: 'object', properties: { camera: { type: 'object' }, layers: { type: 'array' }, area: AREA }, additionalProperties: false } },
];

// FAKE_GEV_CENTER=lat,lon moves the fixtures there from Austin, for demos.
const [shiftLat, shiftLon] = (process.env.FAKE_GEV_CENTER || '30.2672,-97.7431').split(',').map(Number);
for (const row of [...CCTV_ROWS, ...ALPR_ROWS]) {
  row.lat = Number((row.lat + shiftLat - 30.2672).toFixed(6));
  row.lon = Number((row.lon + shiftLon + 97.7431).toFixed(6));
}

const inBox = (bbox, row) => !bbox || (row.lon >= bbox[0] && row.lon <= bbox[2] && row.lat >= bbox[1] && row.lat <= bbox[3]);

// A 1x1 PNG, returned as a camera snapshot.
const PIXEL = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');

function call(name, args, origin) {
  const bbox = args.area?.bbox;
  if (name === 'find_cctv_cameras') {
    const rows = CCTV_ROWS.filter((row) => inBox(bbox, row));
    return { summary: `${rows.length} public cameras`, data: { total: rows.length, returned: rows.length, truncated: false, rows } };
  }
  if (name === 'find_alpr_cameras') {
    const rows = ALPR_ROWS.filter((row) => inBox(bbox, row));
    return { summary: `${rows.length} license plate reader cameras`, data: { total: rows.length, returned: rows.length, truncated: false, rows, source: 'OpenStreetMap (fixture)' } };
  }
  if (name === 'get_cctv_snapshot') {
    const row = CCTV_ROWS.find((camera) => camera.id === args.camera_id);
    if (!row) return { error: `No camera has id ${args.camera_id}` };
    return { summary: `Current view from ${row.name}.`, data: { id: row.id, name: row.name }, images: [{ mimeType: 'image/png', data: PIXEL.toString('base64') }] };
  }
  if (name === 'get_cyclones')
    return { summary: '1 active tropical cyclone', data: { storms: [{ id: 'al142026', name: 'Fixture', classification: 'Hurricane', basin: 'AL', lat: 25.1, lon: -80.2, wind_kt: 85, pressure_hpa: 970, advisory: '12', issued_at: '2026-10-11T09:00:00Z', advisory_url: 'https://www.nhc.noaa.gov/' }] } };
  if (name === 'situation_brief')
    return { summary: 'Situation in the area: calm.', data: { area: 'Fixture area', sections: { weather: { summary: 'Clear, 24 °C.' }, earthquakes: { summary: 'No recent earthquakes.' }, ships: { unavailable: true, reason: 'Needs an AISStream key' } } } };
  if (name === 'show_in_gods_eye_view') {
    const camera = args.camera || { lat: 30.27, lon: -97.74, altitude_m: 8000, heading_deg: 0, pitch_deg: -90 };
    const view = { camera, layers: args.layers || [], style: null, map: null, follow: null, annotations: [] };
    return { summary: 'Open in God\'s Eye View', data: { url: `${origin}/#v=2&lat=${camera.lat}&lon=${camera.lon}&alt=${camera.altitude_m}`, view } };
  }
  return { error: `Unknown tool: ${name}` };
}

const PAGE = `<!doctype html><meta charset="utf-8"><title>Fake GodsView</title>
<body style="margin:0;background:#020b12;color:#7fe3d8;font:13px monospace;display:grid;place-items:center;height:100vh">
<div><b>FAKE GODSVIEW (test stand-in)</b><pre id="log">waiting for views…</pre></div>
<script>
  window.views = [];
  addEventListener('message', (e) => {
    if (e.data && e.data.type === 'gev:view') {
      window.views.push(e.data.view);
      document.getElementById('log').textContent = JSON.stringify(e.data.view, null, 1).slice(0, 1200);
      parent.postMessage({ type: 'gev:view-applied', id: e.data.id, ok: true, steps: [] }, e.origin || '*');
    }
  });
  if (new URLSearchParams(location.search).get('embed') === '1') parent.postMessage({ type: 'gev:ready' }, '*');
</script>`;

export function createFakeGev() {
  const calls = [];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (req.method === 'POST' && url.pathname === '/mcp') {
      let body = '';
      for await (const chunk of req) body += chunk;
      const message = JSON.parse(body);
      calls.push(message);
      const reply = (result) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
      };
      if (message.method === 'tools/list') return reply({ tools: TOOLS });
      if (message.method === 'tools/call') {
        const origin = `http://${req.headers.host}`;
        const out = call(message.params.name, message.params.arguments || {}, origin);
        if (out.error) return reply({ content: [{ type: 'text', text: out.error }], structuredContent: { error: 'invalid_arguments' }, isError: true });
        return reply({
          content: [
            { type: 'text', text: out.summary },
            { type: 'text', text: JSON.stringify(out.data) },
            ...(out.images || []).map((image) => ({ type: 'image', data: image.data, mimeType: image.mimeType })),
          ],
          structuredContent: out.data,
          isError: false,
        });
      }
      return reply({});
    }
    if (url.pathname.startsWith('/api/cctv/frame/')) {
      const id = decodeURIComponent(url.pathname.split('/').pop()).replace(/[^\w.-]/g, '');
      const time = new Date().toISOString().slice(11, 19);
      res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'no-store' });
      return res.end(
        `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360" viewBox="0 0 640 360">` +
          `<defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#1d3b4f"/><stop offset="1" stop-color="#0b1720"/></linearGradient></defs>` +
          `<rect width="640" height="360" fill="url(#g)"/><path d="M0 260 L640 230 L640 360 L0 360Z" fill="#26323b"/>` +
          `<path d="M300 360 L330 232 L344 232 L380 360Z" fill="#3a4650"/>` +
          `<text x="320" y="150" fill="#7fe3d8" font-family="monospace" font-size="22" text-anchor="middle">TEST STAND-IN FRAME</text>` +
          `<text x="320" y="182" fill="#7fe3d8" font-family="monospace" font-size="14" text-anchor="middle">${id} · ${time}Z</text></svg>`,
      );
    }
    if (url.pathname === '/' || url.pathname === '/index.html') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      return res.end(PAGE);
    }
    res.writeHead(404);
    res.end();
  });
  return {
    server,
    calls,
    listen: (port = 0) => new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server.address().port))),
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const port = Number(process.argv[2] || 4173);
  createFakeGev()
    .listen(port)
    .then((actual) => console.log(`Fake GodsView (test stand-in) on http://localhost:${actual}`));
}
