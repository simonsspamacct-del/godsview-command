/** Settings from the environment, with `.env` in the project root loaded first. */

import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

/** Load `.env` into process.env. Variables already set in the shell win. */
export function loadDotEnv(file = path.join(ROOT, '.env')) {
  if (existsSync(file)) process.loadEnvFile(file);
}

const number = (value, fallback) => {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

/**
 * The public https address GitHub Codespaces forwards `port` to, or null
 * outside a codespace. Browsers reach the codespace's servers only there,
 * never at localhost.
 */
export function codespaceUrl(port, env = process.env) {
  if (env.CODESPACES !== 'true' || !env.CODESPACE_NAME || !env.GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN) return null;
  return `https://${env.CODESPACE_NAME}-${port}.${env.GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN}`;
}

/**
 * The User-Agent the weather service and place search ask for: the app plus
 * a way to reach whoever runs it. In a codespace, the GitHub profile stands
 * in until NWS_USER_AGENT is set.
 */
function contactAgent(env) {
  if (env.NWS_USER_AGENT && !/you@example\.com/.test(env.NWS_USER_AGENT)) return env.NWS_USER_AGENT;
  if (env.GITHUB_USER) return `GodsViewCommand/1.0 (https://github.com/${env.GITHUB_USER})`;
  return 'GodsViewCommand/1.0 (set NWS_USER_AGENT to include your contact email)';
}

export function readConfig(env = process.env) {
  const gevUrl = new URL(env.GEV_URL || 'http://localhost:4173');
  const port = Math.trunc(number(env.PORT, 5050));
  const gevPort = gevUrl.port || (gevUrl.protocol === 'https:' ? '443' : '80');
  const consolePublic = env.PUBLIC_URL ? new URL(env.PUBLIC_URL).origin : codespaceUrl(port, env);
  // The GodsView address browsers use; the server itself always talks to GEV_URL.
  const gevPublic = env.GEV_PUBLIC_URL ? new URL(env.GEV_PUBLIC_URL).origin : codespaceUrl(gevPort, env) || gevUrl.origin;
  const [lat, lon] = String(env.MAP_CENTER || '30.2672,-97.7431')
    .split(',')
    .map((part) => Number.parseFloat(part));
  return {
    host: env.HOST || '127.0.0.1',
    port,
    publicUrl: consolePublic,
    // Open the console in the default browser once it is listening, unless
    // turned off, in CI, or in a codespace (which opens it itself).
    openBrowser: env.OPEN_BROWSER !== '0' && !env.CI && env.CODESPACES !== 'true',
    gev: {
      url: gevUrl.origin,
      publicUrl: gevPublic,
      dir: env.GEV_DIR ? path.resolve(ROOT, env.GEV_DIR) : null,
      autostart: env.GEV_AUTOSTART !== '0',
      // Pages allowed to frame GodsView's embed mode: this console, wherever
      // the browser reaches it.
      frameAncestors: [`http://localhost:${port}`, `http://127.0.0.1:${port}`, consolePublic].filter(Boolean),
      // Host names GodsView must answer besides localhost (its Host check
      // takes exact names only).
      allowedHosts: gevPublic !== gevUrl.origin ? [new URL(gevPublic).hostname] : [],
    },
    ai: {
      model: env.ANTHROPIC_MODEL || 'claude-opus-5-5',
      effort: env.AI_EFFORT || 'medium',
      // The SDK also finds `ant auth login` profiles, so this is a hint for
      // the UI, not a gate.
      keyDetected: Boolean(env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN),
    },
    waze: {
      mode: env.WAZE_MODE || (env.WAZE_FEED_URL ? 'feed' : 'livemap'),
      feedUrl: env.WAZE_FEED_URL || null,
      region: env.WAZE_ENV || 'na',
      userAgent:
        env.WAZE_USER_AGENT || 'Mozilla/5.0 (compatible; GodsViewCommand/1.0)',
    },
    nws: { userAgent: contactAgent(env) },
    geocoder: { userAgent: contactAgent(env) },
    map: {
      center: [
        Number.isFinite(lat) ? lat : 30.2672,
        Number.isFinite(lon) ? lon : -97.7431,
      ],
      zoom: Math.trunc(number(env.MAP_ZOOM, 12)),
    },
  };
}
