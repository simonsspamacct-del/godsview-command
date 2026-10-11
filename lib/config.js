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

export function readConfig(env = process.env) {
  const gevUrl = new URL(env.GEV_URL || 'http://localhost:4173');
  const [lat, lon] = String(env.MAP_CENTER || '30.2672,-97.7431')
    .split(',')
    .map((part) => Number.parseFloat(part));
  return {
    host: env.HOST || '127.0.0.1',
    port: Math.trunc(number(env.PORT, 5050)),
    gev: {
      url: gevUrl.origin,
      dir: env.GEV_DIR ? path.resolve(ROOT, env.GEV_DIR) : null,
      autostart: env.GEV_AUTOSTART !== '0',
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
    nws: {
      userAgent:
        env.NWS_USER_AGENT ||
        'GodsViewCommand/1.0 (set NWS_USER_AGENT to include your contact email)',
    },
    geocoder: {
      userAgent:
        env.NWS_USER_AGENT ||
        'GodsViewCommand/1.0 (set NWS_USER_AGENT to include your contact email)',
    },
    map: {
      center: [
        Number.isFinite(lat) ? lat : 30.2672,
        Number.isFinite(lon) ? lon : -97.7431,
      ],
      zoom: Math.trunc(number(env.MAP_ZOOM, 12)),
    },
  };
}
