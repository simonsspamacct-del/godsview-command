/**
 * The analyst: Claude with God's Eye View's MCP tools and this console's own
 * feeds as tools, and two tools that act on the console itself (open live
 * panels, move the map). Each answer streams to the browser as NDJSON events.
 */

import Anthropic from '@anthropic-ai/sdk';
import { bboxAround, bboxSpan, BadRequest } from './geo.js';

const MAX_MODEL_CALLS = 12;
const MAX_HISTORY_MESSAGES = 120;
const RESULT_CHARS = 24_000;
const SESSION_TTL_MS = 6 * 3600_000;

const SYSTEM = `You are the analyst inside GodsView Command, a live situational-awareness console. The console shows a live 2D map next to God's Eye View ("GodsView"), an open-source 3D globe of public data, and opens live detail panels for weather alerts, public CCTV cameras, mapped ALPR (license plate reader) camera locations and Waze user reports, including police reports.

How to work:
- Each user message starts with the console's current view (center, zoom, bounding box, layers on). "Here", "this area" and "nearby" mean that view unless the user names a place.
- Use the tools to answer from live data rather than from memory. Tools that take an area accept a bbox [west, south, east, north] or lat/lon with radius_km; most GodsView tools also accept a place name.
- When live data answers the question, show it: call open_panels with the most relevant items (for example the public camera nearest a reported incident, or the weather alert covering a point), and focus_map when the user should look somewhere else. Open at most 6 panels.
- Keep answers short and concrete: counts, names, distances, times. Say when a feed was unavailable, stale, or only partly loaded instead of implying there is nothing there.

What the data is and is not:
- Waze reports are unverified crowd reports; mention their age and confirmations.
- ALPR results are camera locations and tags mapped by volunteers in OpenStreetMap, not plate reads. Nothing here identifies or tracks people or vehicles; decline requests to do that.
- CCTV feeds are public traffic and city cameras; positions and headings are approximate.
- NWS alerts cover the US. For conditions elsewhere use GodsView's weather tools.
- Do not use this console for emergencies: tell people in danger to contact local emergency services.`;

const AREA_SCHEMA = {
  type: 'object',
  description: 'Either bbox [west, south, east, north] in degrees, or lat and lon with radius_km.',
  properties: {
    bbox: { type: 'array', items: { type: 'number' }, minItems: 4, maxItems: 4 },
    lat: { type: 'number', minimum: -90, maximum: 90 },
    lon: { type: 'number', minimum: -180, maximum: 180 },
    radius_km: { type: 'number', minimum: 0.1, maximum: 200 },
  },
  additionalProperties: false,
};

const PANEL_KINDS = ['cctv', 'alpr', 'weather', 'police', 'accident', 'hazard', 'closure', 'jam', 'cyclone'];
const MAP_LAYERS = ['weather', 'radar', 'cctv', 'alpr', 'police', 'waze', 'cyclones'];

const LOCAL_TOOLS = [
  {
    name: 'get_waze_reports',
    description:
      'Live Waze user reports in an area (at most about 2° across): police, accidents, hazards, road closures and jams, newest first, with street, age in minutes and confirmations.',
    input_schema: {
      type: 'object',
      properties: {
        area: AREA_SCHEMA,
        kinds: {
          type: 'array',
          items: { type: 'string', enum: ['police', 'accident', 'hazard', 'closure', 'jam'] },
          description: 'Only these kinds. Default: all.',
        },
        limit: { type: 'integer', minimum: 1, maximum: 100 },
      },
      required: ['area'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_weather_alerts',
    description:
      'US National Weather Service alerts in force in an area (warnings, watches, advisories), most severe first.',
    input_schema: {
      type: 'object',
      properties: { area: AREA_SCHEMA, limit: { type: 'integer', minimum: 1, maximum: 50 } },
      required: ['area'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_nearby',
    description:
      'Everything the console has near one point: the nearest public cameras, ALPR camera locations and Waze reports within radius_km, and NWS alerts in force at the point.',
    input_schema: {
      type: 'object',
      properties: {
        lat: { type: 'number', minimum: -90, maximum: 90 },
        lon: { type: 'number', minimum: -180, maximum: 180 },
        radius_km: { type: 'number', minimum: 0.2, maximum: 25 },
      },
      required: ['lat', 'lon'],
      additionalProperties: false,
    },
  },
  {
    name: 'open_panels',
    description:
      "Open live detail panels in the user's console for items an earlier tool call returned: a camera's live image, an ALPR camera's tags, a weather alert's full text, a Waze report. Give each item's kind and id exactly as returned.",
    input_schema: {
      type: 'object',
      properties: {
        items: {
          type: 'array',
          minItems: 1,
          maxItems: 6,
          items: {
            type: 'object',
            properties: {
              kind: { type: 'string', enum: PANEL_KINDS },
              id: { type: 'string' },
            },
            required: ['kind', 'id'],
            additionalProperties: false,
          },
        },
      },
      required: ['items'],
      additionalProperties: false,
    },
  },
  {
    name: 'focus_map',
    description:
      "Move the user's live map to a point and optionally turn layers on. The GodsView globe follows the map.",
    input_schema: {
      type: 'object',
      properties: {
        lat: { type: 'number', minimum: -90, maximum: 90 },
        lon: { type: 'number', minimum: -180, maximum: 180 },
        zoom: { type: 'integer', minimum: 3, maximum: 18, description: '10 is a metro area, 14 a neighborhood, 17 a street.' },
        layers: { type: 'array', items: { type: 'string', enum: MAP_LAYERS } },
      },
      required: ['lat', 'lon'],
      additionalProperties: false,
    },
  },
];

const LOCAL_NAMES = new Set(LOCAL_TOOLS.map((tool) => tool.name));

/** An area argument as a bbox, or BadRequest. */
function areaToBbox(area) {
  if (Array.isArray(area?.bbox) && area.bbox.length === 4) {
    const [west, south, east, north] = area.bbox.map(Number);
    if ([west, south, east, north].every(Number.isFinite) && west < east && south < north)
      return [west, south, east, north];
  }
  if (Number.isFinite(area?.lat) && Number.isFinite(area?.lon))
    return bboxAround({ lat: area.lat, lon: area.lon }, area.radius_km ?? 5);
  throw new BadRequest('area needs a bbox or lat/lon with radius_km');
}

const minutesAgo = (ms) => (Number.isFinite(ms) ? Math.round((Date.now() - ms) / 60_000) : null);

const compactWaze = (item) => ({
  kind: item.kind,
  id: item.id,
  detail: item.detail,
  street: item.street,
  city: item.city,
  lat: item.lat,
  lon: item.lon,
  minutes_ago: minutesAgo(item.reportedAt),
  thumbs_up: item.thumbsUp,
  reliability: item.reliability,
});

const compactAlert = (item) => ({
  kind: 'weather',
  id: item.id,
  event: item.event,
  severity: item.severity,
  urgency: item.urgency,
  headline: item.headline,
  area: item.areaDesc,
  expires: item.expires,
  instruction: item.instruction ? item.instruction.slice(0, 400) : null,
});

const clip = (text) =>
  text.length > RESULT_CHARS ? `${text.slice(0, RESULT_CHARS)}\n[truncated]` : text;

export function createAnalyst({ config, gev, feeds, registry, log = console.log }) {
  let client = null;
  const sessions = new Map();

  const getClient = () => (client ??= new Anthropic());

  function session(id) {
    const now = Date.now();
    for (const [key, value] of sessions)
      if (now - value.touched > SESSION_TTL_MS) sessions.delete(key);
    let entry = sessions.get(id);
    if (!entry || entry.messages.length > MAX_HISTORY_MESSAGES) {
      entry = { messages: [], busy: false, touched: now };
      sessions.set(id, entry);
    }
    entry.touched = now;
    return entry;
  }

  async function toolList() {
    let gevTools = [];
    try {
      gevTools = (await gev.listTools())
        .filter((tool) => !LOCAL_NAMES.has(tool.name))
        .map((tool) => ({
          name: tool.name,
          description: `[GodsView] ${tool.description || tool.title || tool.name}`,
          input_schema: tool.inputSchema || { type: 'object', properties: {} },
        }));
    } catch (error) {
      log(`[ai] GodsView tools unavailable: ${error.message}`);
    }
    return { tools: [...LOCAL_TOOLS, ...gevTools], gevOnline: gevTools.length > 0 };
  }

  /** Run one tool. Resolves to `{ content, summary, isError, actions }`. */
  async function runTool(name, input) {
    const actions = [];
    const json = (value) => [{ type: 'text', text: clip(JSON.stringify(value)) }];

    if (name === 'get_waze_reports') {
      const bbox = areaToBbox(input.area);
      const result = await feeds.waze.reports(bbox);
      if (!result.ok || result.zoomIn)
        return { content: json({ error: result.error || 'Waze is unavailable' }), summary: result.error, isError: true, actions };
      const kinds = input.kinds?.length ? new Set(input.kinds) : null;
      const items = result.items.filter((item) => !kinds || kinds.has(item.kind));
      registry.addAll(items);
      const limit = input.limit ?? 40;
      return {
        content: json({ source: result.source, total: items.length, reports: items.slice(0, limit).map(compactWaze) }),
        summary: `${items.length} Waze reports`,
        actions,
      };
    }

    if (name === 'get_weather_alerts') {
      const bbox = areaToBbox(input.area);
      const result = await feeds.nws.alertsInBbox(bbox);
      registry.addAll(result.items);
      const limit = input.limit ?? 15;
      return {
        content: json({
          source: result.source,
          updated: result.updated,
          complete: result.complete,
          total: result.items.length,
          alerts: result.items.slice(0, limit).map(compactAlert),
        }),
        summary: `${result.items.length} weather alerts`,
        actions,
      };
    }

    if (name === 'get_nearby') {
      const result = await feeds.nearby({ lat: input.lat, lon: input.lon, radiusKm: input.radius_km ?? 3 });
      const compact = {
        point: { lat: input.lat, lon: input.lon },
        radius_km: result.radiusKm,
        cctv: result.cctv.items.slice(0, 8).map(({ kind, id, name, city, distanceKm, feedType }) => ({ kind, id, name, city, distance_km: distanceKm, feed_type: feedType })),
        cctv_error: result.cctv.error ?? null,
        alpr: result.alpr.items.slice(0, 8).map(({ kind, id, operator, manufacturer, distanceKm, directionDeg }) => ({ kind, id, operator, manufacturer, distance_km: distanceKm, direction_deg: directionDeg })),
        alpr_error: result.alpr.error ?? null,
        waze: result.waze.items.slice(0, 15).map((item) => ({ ...compactWaze(item), distance_km: item.distanceKm })),
        waze_error: result.waze.error ?? null,
        weather_alerts: result.weather.items.map(compactAlert),
        weather_error: result.weather.error ?? null,
      };
      return { content: json(compact), summary: 'nearby live data', actions };
    }

    if (name === 'open_panels') {
      const found = [];
      const missing = [];
      for (const { kind, id } of input.items || []) {
        const item = registry.get(kind, id);
        if (item) found.push(item);
        else missing.push(`${kind}:${id}`);
      }
      if (found.length) actions.push({ type: 'open', items: found });
      return {
        content: json({ opened: found.length, not_found: missing }),
        summary: `opened ${found.length} panel${found.length === 1 ? '' : 's'}`,
        isError: found.length === 0,
        actions,
      };
    }

    if (name === 'focus_map') {
      actions.push({ type: 'focus', lat: input.lat, lon: input.lon, zoom: input.zoom ?? null, layers: input.layers ?? [] });
      return { content: json({ ok: true }), summary: 'moved the map', actions };
    }

    // A GodsView tool.
    const result = await gev.callTool(name, input);
    if (name === 'find_cctv_cameras') registry.addAll((result.data?.rows || []).map(feeds.normalizeCctv));
    if (name === 'find_alpr_cameras') registry.addAll((result.data?.rows || []).map(feeds.normalizeAlpr));
    if (name === 'show_in_gods_eye_view' && result.data?.view)
      actions.push({ type: 'globe', view: result.data.view, url: result.data.url });
    if (name === 'get_cctv_snapshot' && result.data?.id) {
      const item = registry.get('cctv', result.data.id);
      if (item) actions.push({ type: 'open', items: [item] });
    }
    const content = [
      { type: 'text', text: clip(result.summary) },
      ...(result.data && !result.isError ? [{ type: 'text', text: clip(JSON.stringify(result.data)) }] : []),
      ...result.images.map((image) => ({
        type: 'image',
        source: { type: 'base64', media_type: image.mimeType, data: image.data },
      })),
    ];
    return { content, summary: result.summary.slice(0, 160), isError: result.isError, actions };
  }

  function viewPreamble(view) {
    if (!view?.center) return 'Console view: unknown.';
    const bbox = Array.isArray(view.bbox) ? view.bbox.map((value) => Number(value).toFixed(4)).join(', ') : 'unknown';
    const span = Array.isArray(view.bbox) ? bboxSpan(view.bbox).toFixed(2) : '?';
    return [
      `Console view: center ${Number(view.center.lat).toFixed(4)}, ${Number(view.center.lon).toFixed(4)}; zoom ${view.zoom}; bbox [${bbox}] (${span}° across).`,
      `Layers on: ${(view.layers || []).join(', ') || 'none'}.`,
      `User's local time: ${view.localTime || new Date().toISOString()}.`,
    ].join('\n');
  }

  /** Answer one message. Yields events for the browser. */
  async function* chat({ sessionId, text, view, signal }) {
    const entry = session(sessionId);
    if (entry.busy) {
      yield { type: 'error', message: 'Still working on the previous question.' };
      return;
    }
    entry.busy = true;
    try {
      const { tools, gevOnline } = await toolList();
      if (!gevOnline) yield { type: 'status', text: 'GodsView is offline, so only the console feeds are available.' };
      entry.messages.push({
        role: 'user',
        content: [
          { type: 'text', text: viewPreamble(view) },
          { type: 'text', text },
        ],
      });

      for (let call = 0; call < MAX_MODEL_CALLS; call += 1) {
        if (signal?.aborted) return;
        const response = await getClient().beta.messages.create(
          {
            model: config.ai.model,
            max_tokens: 16000,
            betas: ['server-side-fallback-2026-07-01'],
            fallbacks: 'default',
            output_config: { effort: config.ai.effort },
            cache_control: { type: 'ephemeral' },
            system: SYSTEM,
            tools,
            messages: entry.messages,
          },
          { signal },
        );

        if (response.stop_reason === 'refusal') {
          yield { type: 'error', message: 'The model declined this request.' };
          return;
        }
        entry.messages.push({ role: 'assistant', content: response.content });
        for (const block of response.content)
          if (block.type === 'text' && block.text.trim()) yield { type: 'text', text: block.text };

        if (response.stop_reason === 'pause_turn') continue;
        if (response.stop_reason === 'max_tokens') {
          yield { type: 'status', text: 'The answer hit its length limit.' };
          return;
        }
        const calls = response.content.filter((block) => block.type === 'tool_use');
        if (response.stop_reason !== 'tool_use' || !calls.length) return;

        for (const block of calls) yield { type: 'tool', id: block.id, name: block.name, input: block.input, state: 'start' };
        const outcomes = await Promise.all(
          calls.map(async (block) => {
            try {
              return { block, ...(await runTool(block.name, block.input || {})) };
            } catch (error) {
              const message = error instanceof BadRequest || error.code ? error.message : `Tool failed: ${error.message}`;
              return { block, content: [{ type: 'text', text: message }], summary: message, isError: true, actions: [] };
            }
          }),
        );
        for (const outcome of outcomes) {
          yield {
            type: 'tool',
            id: outcome.block.id,
            name: outcome.block.name,
            state: outcome.isError ? 'error' : 'done',
            summary: outcome.summary,
          };
          for (const action of outcome.actions) yield { type: 'action', action };
        }
        // All results go back in one user message.
        entry.messages.push({
          role: 'user',
          content: outcomes.map((outcome) => ({
            type: 'tool_result',
            tool_use_id: outcome.block.id,
            content: outcome.content,
            ...(outcome.isError ? { is_error: true } : {}),
          })),
        });
      }
      yield { type: 'status', text: 'Stopped after many steps; ask a narrower question.' };
    } catch (error) {
      yield { type: 'error', message: describeError(error) };
    } finally {
      entry.busy = false;
    }
  }

  return {
    chat,
    reset: (sessionId) => sessions.delete(sessionId),
  };
}

function describeError(error) {
  if (error instanceof Anthropic.AuthenticationError)
    return 'No valid Anthropic credentials. Set ANTHROPIC_API_KEY in .env (or run `ant auth login`) and restart.';
  if (error instanceof Anthropic.PermissionDeniedError)
    return `This API key cannot use the configured model: ${error.message}`;
  if (error instanceof Anthropic.RateLimitError) return 'Rate limited by the Anthropic API. Try again in a moment.';
  if (error instanceof Anthropic.BadRequestError) return `The Anthropic API rejected the request: ${error.message}`;
  if (error instanceof Anthropic.APIError) return `Anthropic API error ${error.status ?? ''}: ${error.message}`;
  if (error?.name === 'AbortError' || error instanceof Anthropic.APIUserAbortError) return 'Cancelled.';
  if (error instanceof Anthropic.AnthropicError && /credentials|api key|apiKey/i.test(error.message))
    return 'No Anthropic credentials found. Set ANTHROPIC_API_KEY in .env (or run `ant auth login`) and restart.';
  return error?.message || String(error);
}
