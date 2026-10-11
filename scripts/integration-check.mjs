/**
 * Checks a running console and the God's Eye View it started, end to end:
 * the page, GodsView coming online, its MCP tools, its embed framing
 * permission, share links, and the live feeds. GitHub Actions runs this
 * against real GodsView; you can too, while the console runs:
 *
 *   node scripts/integration-check.mjs [http://127.0.0.1:5050] [--wait 300]
 *
 * Exits non-zero when a required check fails. Feeds that depend on outside
 * services (NWS, Waze, camera catalogs) are reported but never fail the run.
 */

const args = process.argv.slice(2);
const base = (args.find((arg) => /^https?:\/\//.test(arg)) || 'http://127.0.0.1:5050').replace(/\/$/, '');
const waitIndex = args.indexOf('--wait');
const waitSeconds = waitIndex >= 0 ? Number(args[waitIndex + 1]) : 300;
const AUSTIN = '-97.80,30.22,-97.68,30.32';

const results = [];
function record(name, ok, detail, required = true) {
  results.push({ name, ok, detail, required });
  console.log(`${ok ? 'PASS' : required ? 'FAIL' : 'WARN'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

async function json(path, init) {
  const response = await fetch(`${base}${path}`, { ...init, signal: AbortSignal.timeout(90_000) });
  return { status: response.status, body: await response.json().catch(() => null) };
}

const page = await fetch(`${base}/`).catch((error) => ({ ok: false, status: error.message }));
record('Console page loads', page.ok, `HTTP ${page.status}`);

let status = null;
const deadline = Date.now() + waitSeconds * 1000;
while (Date.now() < deadline) {
  status = (await json('/api/status').catch(() => ({ body: null }))).body;
  // GodsView can take minutes to start; the console re-checks it every 10 s.
  if (status?.gev?.state === 'online') break;
  await new Promise((resolve) => setTimeout(resolve, 3000));
}
const gev = status?.gev;
record('GodsView is online', gev?.state === 'online', gev ? `${gev.state}${gev.lastError ? `: ${gev.lastError}` : ''}` : 'no status');
if (gev?.state !== 'online' && gev?.log?.length) console.log(`GodsView log tail:\n  ${gev.log.slice(-25).join('\n  ')}`);

if (gev?.state === 'online') {
  const cctv = await json(`/api/layers/cctv?bbox=${AUSTIN}`);
  record('GodsView MCP answers (find_cctv_cameras)', cctv.body?.ok === true, cctv.body?.ok ? `${cctv.body.items.length} cameras around Austin` : cctv.body?.error);

  const link = await json('/api/gev/link', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ view: { camera: { lat: 30.27, lon: -97.74, altitude_m: 8000, heading_deg: 0, pitch_deg: -90 }, layers: ['cctv'] } }),
  });
  record('Share link to the full app', typeof link.body?.url === 'string' && link.body.url.includes('#'), link.body?.url || link.body?.error);

  const embed = await fetch(`${gev.url}/?embed=1`, { signal: AbortSignal.timeout(30_000) }).catch((error) => ({ ok: false, status: error.message, headers: new Headers() }));
  const xfo = embed.headers.get('x-frame-options');
  const csp = embed.headers.get('content-security-policy') || '';
  const ancestors = /frame-ancestors([^;]*)/.exec(csp)?.[1]?.trim() ?? '(none)';
  const consoleOrigin = new URL(base).origin.replace('127.0.0.1', 'localhost');
  record(
    'GodsView lets this console embed its globe',
    embed.ok && !xfo && (ancestors === '(none)' || ancestors.includes(consoleOrigin) || ancestors.includes('*')),
    `HTTP ${embed.status}; X-Frame-Options ${xfo || 'absent'}; frame-ancestors ${ancestors}`,
  );

  const alpr = await json(`/api/layers/alpr?bbox=${AUSTIN}`);
  record('ALPR via GodsView (OpenStreetMap)', alpr.body?.ok === true, alpr.body?.ok ? `${alpr.body.items.length} cameras` : alpr.body?.error, false);
}

const weather = await json(`/api/layers/weather?bbox=${AUSTIN}`).catch((error) => ({ body: { error: error.message } }));
record('NWS weather alerts', weather.body?.ok === true, weather.body?.ok ? `${weather.body.items.length} alerts around Austin` : weather.body?.error, false);
const waze = await json(`/api/layers/waze?bbox=${AUSTIN}`).catch((error) => ({ body: { error: error.message } }));
record('Waze reports', waze.body?.ok === true, waze.body?.ok ? `${waze.body.items.length} reports` : `${waze.body?.error} (expected on cloud machines)`, false);

const failed = results.filter((result) => result.required && !result.ok);
const warned = results.filter((result) => !result.required && !result.ok);
console.log(
  `\n${results.filter((result) => result.ok).length}/${results.length} checks passed` +
    (warned.length ? `, ${warned.length} warning${warned.length === 1 ? '' : 's'}` : '') +
    (failed.length ? `; failed: ${failed.map((result) => result.name).join(', ')}` : '') +
    '.',
);
process.exitCode = failed.length ? 1 : 0;
