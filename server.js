/**
 * GodsView Command: serves the console, starts or attaches to God's Eye
 * View, and exposes the live layers, the CCTV media proxy and the analyst.
 */

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { ROOT, loadDotEnv, readConfig } from './lib/config.js';
import { BadRequest, parseBbox, parsePoint } from './lib/geo.js';
import { GevError, GodsView } from './lib/gev.js';
import { createNwsFeed } from './lib/feeds/nws.js';
import { createWazeFeed } from './lib/feeds/waze.js';
import { createRadarFeed } from './lib/feeds/radar.js';
import { createGodsViewLayers, normalizeAlpr, normalizeCctv } from './lib/feeds/godsview.js';
import { createRegistry } from './lib/registry.js';
import { createNearby } from './lib/nearby.js';
import { createAnalyst } from './lib/ai.js';
import { openBrowser } from './lib/open.js';

if (typeof process.loadEnvFile !== 'function') {
  console.error(`GodsView Command needs Node.js 20.12 or later; this is ${process.version}. Install Node 24 (GodsView needs it too) and try again.`);
  process.exit(1);
}
loadDotEnv();
const config = readConfig();

const gev = new GodsView(config.gev);
const registry = createRegistry();
const nws = createNwsFeed(config.nws);
const waze = createWazeFeed(config.waze);
const radar = createRadarFeed();
const gevLayers = createGodsViewLayers({
  gev,
  publicUrl: config.gev.publicUrl,
  geocoderUserAgent: config.geocoder.userAgent,
});
const nearby = createNearby({ gevLayers, waze, nws, registry });
const analyst = createAnalyst({
  config,
  gev,
  registry,
  feeds: { waze, nws, nearby, normalizeCctv, normalizeAlpr },
});

const PUBLIC = path.join(ROOT, 'public');
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
};

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function readJson(req, limit = 64 * 1024) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new BadRequest('Request body too large');
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  } catch {
    throw new BadRequest('Body must be JSON');
  }
}

/** Run a layer loader and answer with its result, or with the reason it failed. */
async function layer(res, load) {
  try {
    const result = await load();
    registry.addAll(result.items);
    sendJson(res, 200, result);
  } catch (error) {
    if (error instanceof BadRequest) return sendJson(res, 400, { ok: false, error: error.message });
    sendJson(res, 200, {
      ok: false,
      items: [],
      error: error.message,
      ...(error instanceof GevError && gev.state !== 'online' ? { gevOffline: true } : {}),
    });
  }
}

/** Pass /api/cctv/* through to GodsView: frames, stream info and HLS media. */
async function proxyCctv(req, res, url) {
  if (!['GET', 'HEAD', 'DELETE'].includes(req.method)) {
    res.writeHead(405);
    return res.end();
  }
  const controller = new AbortController();
  res.on('close', () => controller.abort());
  try {
    const upstream = await fetch(`${gev.url}${url.pathname}${url.search}`, {
      method: req.method,
      headers: req.headers.range ? { Range: req.headers.range } : {},
      signal: controller.signal,
    });
    const headers = {};
    for (const name of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'x-cctv-source', 'x-cctv-session', 'retry-after'])
      if (upstream.headers.has(name)) headers[name] = upstream.headers.get(name);
    headers['cache-control'] = 'no-store';
    res.writeHead(upstream.status, headers);
    if (!upstream.body || req.method === 'HEAD') return res.end();
    await pipeline(Readable.fromWeb(upstream.body), res);
  } catch (error) {
    if (controller.signal.aborted) return;
    if (!res.headersSent) sendJson(res, 502, { error: `GodsView camera proxy: ${error.message}` });
    else res.destroy();
  }
}

async function serveStatic(res, pathname) {
  const relative = pathname === '/' ? 'index.html' : pathname.slice(1);
  const file = path.normalize(path.join(PUBLIC, relative));
  if (!file.startsWith(PUBLIC + path.sep)) {
    res.writeHead(403);
    return res.end();
  }
  try {
    const body = await readFile(file);
    res.writeHead(200, {
      'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(body);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
  }
}

async function chat(req, res) {
  const body = await readJson(req);
  const text = String(body.message || '').trim().slice(0, 4000);
  const sessionId = String(body.sessionId || '').slice(0, 64);
  if (!text || !sessionId) throw new BadRequest('message and sessionId are required');
  const controller = new AbortController();
  res.on('close', () => {
    if (!res.writableFinished) controller.abort();
  });
  res.writeHead(200, { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-store' });
  for await (const event of analyst.chat({ sessionId, text, view: body.view, signal: controller.signal })) {
    if (controller.signal.aborted) break;
    res.write(`${JSON.stringify(event)}\n`);
  }
  res.end(`${JSON.stringify({ type: 'done' })}\n`);
}

const routes = {
  'GET /api/status': (req, res) =>
    sendJson(res, 200, {
      gev: gev.status(),
      ai: { model: config.ai.model, keyDetected: config.ai.keyDetected },
      waze: { mode: waze.mode },
      map: config.map,
    }),
  'POST /api/gev/start': async (req, res) => {
    try {
      sendJson(res, 200, { ok: true, gev: await gev.start() });
    } catch (error) {
      sendJson(res, 200, { ok: false, error: error.message, gev: gev.status() });
    }
  },
  'POST /api/gev/link': async (req, res) => {
    const body = await readJson(req);
    await layer(res, () => gevLayers.shareLink(body.view || {}));
  },
  'GET /api/layers/weather': (req, res, url) => layer(res, () => nws.alertsInBbox(parseBbox(url.searchParams.get('bbox')))),
  'GET /api/layers/waze': (req, res, url) => layer(res, () => waze.reports(parseBbox(url.searchParams.get('bbox')))),
  'GET /api/layers/cctv': (req, res, url) => layer(res, () => gevLayers.cctv(parseBbox(url.searchParams.get('bbox')))),
  'GET /api/layers/alpr': (req, res, url) => layer(res, () => gevLayers.alpr(parseBbox(url.searchParams.get('bbox')))),
  'GET /api/layers/cyclones': (req, res) => layer(res, () => gevLayers.cyclones()),
  'GET /api/layers/radar': (req, res) => layer(res, () => radar.frames()),
  'GET /api/brief': (req, res, url) => layer(res, () => gevLayers.brief(parseBbox(url.searchParams.get('bbox')))),
  'GET /api/nearby': async (req, res, url) => {
    const point = parsePoint(url.searchParams, { maxRadiusKm: 25 });
    sendJson(res, 200, await nearby(point));
  },
  'GET /api/geocode': async (req, res, url) => {
    const query = String(url.searchParams.get('q') || '').trim().slice(0, 200);
    if (!query) throw new BadRequest('q is required');
    try {
      sendJson(res, 200, { ok: true, results: await gevLayers.geocode(query) });
    } catch (error) {
      sendJson(res, 200, { ok: false, results: [], error: error.message });
    }
  },
  'POST /api/ai/chat': chat,
  'POST /api/ai/reset': async (req, res) => {
    const body = await readJson(req);
    analyst.reset(String(body.sessionId || ''));
    sendJson(res, 200, { ok: true });
  },
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname.startsWith('/api/cctv/')) return await proxyCctv(req, res, url);
    const route = routes[`${req.method} ${url.pathname}`];
    if (route) return await route(req, res, url);
    if (url.pathname.startsWith('/api/')) return sendJson(res, 404, { error: 'Unknown endpoint' });
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405);
      return res.end();
    }
    return await serveStatic(res, url.pathname);
  } catch (error) {
    if (res.headersSent) return res.end();
    if (error instanceof BadRequest) return sendJson(res, 400, { error: error.message });
    console.error(error);
    sendJson(res, 500, { error: 'Internal error' });
  }
});

server.on('error', (error) => {
  if (error.code === 'EADDRINUSE')
    console.error(`Port ${config.port} is already in use. Another copy of GodsView Command may be running; stop it, or set PORT=${config.port + 1} in .env and open that port instead.`);
  else if (error.code === 'EACCES') console.error(`Not allowed to listen on port ${config.port}. Set PORT in .env to a number above 1024.`);
  else console.error(`Could not start the server: ${error.message}`);
  process.exit(1);
});

server.listen(config.port, config.host, () => {
  const shown = ['127.0.0.1', '0.0.0.0', '::', 'localhost'].includes(config.host) ? 'localhost' : config.host;
  const local = `http://${shown}:${config.port}`;
  console.log(`GodsView Command on ${local}`);
  if (config.publicUrl) console.log(`Open ${config.publicUrl} in your browser (this server's public address).`);
  else if (config.openBrowser && process.stdout.isTTY && openBrowser(local))
    console.log(`Opening ${local} in your browser. If it does not open, paste that address into a browser on this computer.`);
  else console.log(`Open ${local} in a browser on this computer.`);
  console.log('Keep this window open while you use it; close it or press Ctrl+C to stop.');
  console.log(`GodsView (God's Eye View) expected at ${config.gev.url}${config.gev.dir ? ` (from ${config.gev.dir})` : ''}`);
  if (!config.ai.keyDetected) console.log('ANTHROPIC_API_KEY is not set; the analyst will try an `ant auth login` profile.');
  gev.init();
});

function shutdown() {
  gev.stop();
  server.close();
  setTimeout(() => process.exit(0), 500).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
