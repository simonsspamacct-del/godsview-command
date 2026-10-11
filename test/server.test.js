/**
 * The server end to end against the GodsView stand-in and a scripted fake of
 * the Anthropic Messages API, so no real model or GodsView install is needed.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';

import { createFakeGev } from './fixtures/fake-gev.js';
import { GodsView } from '../lib/gev.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/** A Messages API fake that answers each request with the next scripted turn. */
function fakeAnthropic(script) {
  const requests = [];
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const request = JSON.parse(body);
    requests.push({ url: req.url, headers: req.headers, body: request });
    const turn = script[Math.min(requests.length - 1, script.length - 1)](request);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        id: `msg_${requests.length}`,
        type: 'message',
        role: 'assistant',
        model: request.model,
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 10 },
        ...turn,
      }),
    );
  });
  return {
    requests,
    listen: () => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port))),
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

async function startApp(env) {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, ...env, HOST: '127.0.0.1', GEV_AUTOSTART: '0', GEV_DIR: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`server did not start:\n${output}`)), 10_000);
    child.stdout.on('data', (chunk) => {
      output += chunk;
      if (output.includes('GodsView Command on')) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.stderr.on('data', (chunk) => (output += chunk));
  });
  return child;
}

test('GodsView client lists and calls tools over MCP', async () => {
  const gev = createFakeGev();
  const port = await gev.listen();
  const client = new GodsView({ url: `http://localhost:${port}`, dir: null, autostart: false, log: () => {} });
  const tools = await client.listTools();
  assert.ok(tools.some((tool) => tool.name === 'find_cctv_cameras'));
  const result = await client.callTool('find_cctv_cameras', { area: { bbox: [-97.8, 30.2, -97.7, 30.3] } });
  assert.equal(result.data.rows.length, 3);
  const snapshot = await client.callTool('get_cctv_snapshot', { camera_id: 'atx-i35-mlk' });
  assert.equal(snapshot.images[0].mimeType, 'image/png');
  await assert.rejects(client.query('get_cctv_snapshot', { camera_id: 'nope' }), /No camera has id nope/);
  assert.equal(gev.calls.at(-1).method, 'tools/call');
  await gev.close();
});

test('layers, proxy and analyst work end to end', async (t) => {
  const gev = createFakeGev();
  const gevPort = await gev.listen();
  const anthropic = fakeAnthropic([
    () => ({
      stop_reason: 'tool_use',
      content: [
        { type: 'text', text: 'Checking cameras.' },
        { type: 'tool_use', id: 'toolu_1', name: 'find_cctv_cameras', input: { area: { bbox: [-97.8, 30.2, -97.7, 30.3] } } },
      ],
    }),
    () => ({
      stop_reason: 'tool_use',
      content: [{ type: 'tool_use', id: 'toolu_2', name: 'open_panels', input: { items: [{ kind: 'cctv', id: 'atx-congress-6th' }] } }],
    }),
    () => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'The closest camera is **Test camera A**.' }] }),
  ]);
  const anthropicPort = await anthropic.listen();
  const appPort = 5600 + Math.floor(Math.random() * 300);
  const app = await startApp({
    PORT: String(appPort),
    GEV_URL: `http://localhost:${gevPort}`,
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${anthropicPort}`,
    ANTHROPIC_API_KEY: 'test-key',
    ANTHROPIC_MODEL: 'claude-opus-5-5',
  });
  t.after(async () => {
    app.kill();
    await gev.close();
    await anthropic.close();
  });
  const base = `http://127.0.0.1:${appPort}`;

  // Wait for the health probe to see the stand-in.
  let status;
  for (let i = 0; i < 20; i += 1) {
    status = await (await fetch(`${base}/api/status`)).json();
    if (status.gev.state === 'online') break;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  assert.equal(status.gev.state, 'online');

  const cctv = await (await fetch(`${base}/api/layers/cctv?bbox=-97.8,30.2,-97.7,30.3`)).json();
  assert.equal(cctv.ok, true);
  assert.equal(cctv.items[0].kind, 'cctv');
  const alpr = await (await fetch(`${base}/api/layers/alpr?bbox=-97.8,30.2,-97.7,30.3`)).json();
  assert.equal(alpr.items[0].osmUrl, 'https://www.openstreetmap.org/node/1001');
  const tooBig = await (await fetch(`${base}/api/layers/alpr?bbox=-100,25,-90,35`)).json();
  assert.equal(tooBig.zoomIn, true);
  const bad = await fetch(`${base}/api/layers/cctv?bbox=nope`);
  assert.equal(bad.status, 400);

  const frame = await fetch(`${base}/api/cctv/frame/atx-i35-mlk`);
  assert.equal(frame.status, 200);
  assert.equal(frame.headers.get('content-type'), 'image/svg+xml');

  const link = await (await fetch(`${base}/api/gev/link`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ view: { camera: { lat: 30.27, lon: -97.74, altitude_m: 5000, heading_deg: 0, pitch_deg: -90 }, layers: ['cctv'] } }) })).json();
  assert.match(link.url, /#v=2&lat=30.27/);

  const response = await fetch(`${base}/api/ai/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: 's1', message: 'Nearest camera?', view: { center: { lat: 30.27, lon: -97.74 }, zoom: 13, bbox: [-97.8, 30.2, -97.7, 30.3], layers: ['CCTV cameras'] } }),
  });
  const events = (await response.text()).trim().split('\n').map((line) => JSON.parse(line));
  const types = events.map((event) => event.type);
  assert.deepEqual(types.filter((type) => type === 'done'), ['done']);
  const open = events.find((event) => event.type === 'action' && event.action.type === 'open');
  assert.equal(open.action.items[0].name, 'Test camera A');
  assert.ok(events.some((event) => event.type === 'text' && /Test camera A/.test(event.text)));
  assert.ok(events.some((event) => event.type === 'tool' && event.name === 'find_cctv_cameras' && event.state === 'done'));

  // Request shape: tools from both sides, fallbacks on, history replayed append-only.
  const first = anthropic.requests[0];
  assert.match(first.url, /^\/v1\/messages/);
  assert.equal(first.body.fallbacks, 'default');
  assert.match(String(first.headers['anthropic-beta']), /server-side-fallback-2026-07-01/);
  assert.equal(first.body.model, 'claude-opus-5-5');
  const names = first.body.tools.map((tool) => tool.name);
  for (const name of ['get_waze_reports', 'open_panels', 'focus_map', 'find_cctv_cameras', 'situation_brief']) assert.ok(names.includes(name), name);
  assert.match(first.body.messages[0].content[0].text, /Console view: center 30\.2700, -97\.7400/);
  const third = anthropic.requests[2].body.messages;
  assert.equal(third.length, 5);
  assert.equal(third[2].content[0].type, 'tool_result');
  assert.equal(third[4].content[0].tool_use_id, 'toolu_2');
});
