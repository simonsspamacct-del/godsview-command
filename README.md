# GodsView Command

A live-map command center that runs **God's Eye View** ("GodsView",
[bilawalsidhu/gods-eye-view](https://github.com/bilawalsidhu/gods-eye-view))
alongside it, and opens live data as panels:

- **Weather events**: US National Weather Service warnings, watches and
  advisories, drawn as their real areas, plus US NEXRAD and global radar.
- **ALPR cameras**: license plate reader locations mapped in OpenStreetMap,
  read through GodsView's `find_alpr_cameras` tool.
- **CCTV**: GodsView's public traffic and city cameras, with the live still
  or video in a panel.
- **Police reported on Waze**, plus accidents, hazards and road closures.
- **Tropical cyclones** and a **situation brief** from GodsView.

Everything is connected. A police report's panel lists the nearest cameras,
ALPR readers and the weather alerts in force there. A flood warning's panel
lists the cameras and reports inside its area. Click any of them to open
it too.

Two kinds of AI run at the same time:

- **The analyst** in the console is Claude, using GodsView's own MCP tools
  plus the console's feeds. Ask "show me the camera closest to the newest
  police report" and it queries the data, opens the panels and moves the map.
- **GodsView's voice AI** runs in the full GodsView app. The **Full app +
  voice AI ↗** button opens it in its own window at the console's current
  view.

![The console over Asheville, NC](docs/screenshot.png)

<sub>Screenshot from a test run. The NWS flood alerts and radar are live. The
cameras, ALPR readers and globe pane come from the GodsView test stand-in in
`test/fixtures`. The Waze reports are sample data, because Waze blocks the
cloud machine the screenshot was taken on. The analyst's answer is from a
scripted test model.</sub>

## How it fits together

```
 Browser ─────────────────────────────────────────────────────────────┐
 │  Live map (Leaflet)  │  GodsView globe (iframe, ?embed=1)  │ Analyst │
 └──────────┬───────────────────────┬──────────────────────────┬──────┘
            │ /api/layers/*         │ postMessage gev:view     │ /api/ai/chat
            ▼                       ▼                          ▼
 GodsView Command server (Node, this repo) ──── Claude Messages API
   ├─ NWS alerts, RainViewer radar, Waze reports, Nominatim place search
   ├─ /api/cctv/* proxy ───────────┐
   └─ MCP client (POST /mcp) ──────┴──► God's Eye View dev server (:4173)
      started by this app from GEV_DIR, or one you run yourself
```

- The console starts GodsView (`npm run dev` in `GEV_DIR`) if nothing answers
  at `GEV_URL`, and stops it on exit.
- Its server calls GodsView's local MCP endpoint (`/mcp`) for cameras, ALPR,
  cyclones, briefs and share links.
- The globe pane uses GodsView's documented embed protocol: the console posts
  `gev:view` messages (camera, layers and pins for police reports), so the 3D
  globe follows the 2D map.

## Quick start

You need **Node.js 24.14 or later** (GodsView requires it; the console itself
runs on Node 20.12+).

```bash
# 1. GodsView, next to this folder
git clone https://github.com/bilawalsidhu/gods-eye-view.git
(cd gods-eye-view && npm ci)

# 2. This console
cd godsview-command
npm install
cp .env.example .env      # set NWS_USER_AGENT and ANTHROPIC_API_KEY
npm start
```

Open **http://localhost:5050**. The GodsView pill turns green once GodsView
is up; the first start takes up to a minute.

Prefer to run GodsView yourself? Set `GEV_AUTOSTART=0`, then add this line to
**gods-eye-view/.env** before starting it. Without it, GodsView refuses to be
embedded:

```
GEV_EMBED_FRAME_ANCESTORS=http://localhost:5050 http://127.0.0.1:5050
```

GodsView's own optional keys (Cesium ion, Google Maps, OpenAI for its voice
agent, AISStream...) are set in GodsView through its **POWER UP** panel,
not here.

## Using it

- **Layers** (left): toggle each source. Counts and status notes show what
  loaded, what needs you to zoom in, and what failed.
- **Live feed**: everything in view, newest police reports first. Click a
  row, or a marker, to open its panel.
- **Panels** float over the map. Drag them by the header. Each one updates
  live (camera stills every 5 s, report ages) and lists related data nearby.
  **Look on globe** points the GodsView camera at the item, from a camera's
  own heading.
- **Follow map** keeps the globe on the map's view. **Layers ▾** adds
  globe-only layers (flights, traffic, earthquakes, fire perimeters,
  lightning, satellites).
- **Brief view** asks GodsView's `situation_brief` tool for the area. It needs
  no AI key.
- New police reports in view pop up as toasts.

## Data sources and their limits

| Layer | Source | Notes |
| --- | --- | --- |
| Weather alerts | [api.weather.gov](https://www.weather.gov/documentation/services-web-api) | US only. Most alerts name forecast zones instead of carrying a polygon. Zone shapes are fetched as needed, cached for a day, and fill in over a few refreshes in a large view. |
| Radar · US | Iowa Environmental Mesonet NEXRAD tiles | Refreshed every 5 minutes. |
| Radar · global | RainViewer | Native resolution up to zoom 7. |
| CCTV | GodsView camera catalog | Covers the regions GodsView ships camera packs for. Positions and headings are approximate. |
| ALPR | OpenStreetMap via GodsView | Camera locations and tags mapped by volunteers. City-sized areas only (zoom in). No plate data. |
| Waze | waze.com live map, or a Waze for Cities feed | The live-map endpoint is not a published API. Waze may refuse it, and it nearly always refuses cloud servers. A [Waze for Cities](https://www.waze.com/wazeforcities) partner feed (`WAZE_MODE=feed`) is the supported route. Reports are unverified. |
| Cyclones | NHC / CPHC via GodsView | |
| Place search | OpenStreetMap Nominatim | Only on search, as its usage policy asks. |

## The analyst

- **Model:** Claude Opus 5.5 (`claude-opus-5-5`) by default; set
  `ANTHROPIC_MODEL` and `AI_EFFORT` to change it.
- **Tools:** every tool GodsView's MCP server lists, plus five console tools:
  `get_waze_reports`, `get_weather_alerts`, `get_nearby`, `open_panels`, and
  `focus_map` to move your map.
- **Context:** each question carries your current view (center, zoom,
  bounding box, layers on). "Here" means what you are looking at.
- **Refusal fallback:** requests opt into the API's server-side refusal
  fallback (`fallbacks: "default"`), so a request a safety classifier
  declines is retried on Anthropic's recommended fallback model instead of
  failing.
- **Cost:** every question costs API tokens, usually a few model calls per
  question. The console works without a key; only the chat needs one.

## Privacy and safety

- The console and GodsView listen on localhost only. GodsView's MCP endpoint
  refuses anything that isn't this machine.
- The console shows where public cameras and ALPR readers are mounted, and
  crowd reports. It does not read plates, identify people or track vehicles,
  and the analyst is told to decline requests to.
- Data can be delayed, incomplete or wrong. Do not use it for navigation or
  emergencies; call local emergency services.

## Development

```bash
npm test                               # unit and end-to-end tests, no network needed
node test/fixtures/fake-gev.js 4173    # a GodsView stand-in with fixture cameras
```

The end-to-end test runs the server against the GodsView stand-in and a
scripted fake of the Messages API. It checks the layers, the camera proxy,
share links, and the analyst's tool loop.

| Path | What it is |
| --- | --- |
| `server.js` | HTTP server and routes |
| `lib/gev.js` | Starts and supervises GodsView; MCP client |
| `lib/feeds/` | NWS, Waze, radar and GodsView-backed layers |
| `lib/nearby.js` | Related live data around a point |
| `lib/ai.js` | The analyst's tool loop |
| `public/js/` | Map, globe pane, panels, feed, chat |

## Troubleshooting

- **http://localhost:5050 won't open.** The console runs on your own
  computer, and only while `npm start` is running in a terminal window.
  Check these in order:
  - The address has a colon: `http://localhost:5050`.
  - Open it on the same computer that runs `npm start`. A phone or another
    machine can't reach it.
  - The terminal shows `GodsView Command on http://localhost:5050` and is
    still open. If it shows an error instead, it says what to fix: run
    `npm install`, free the port, or update Node.
  - If `localhost` still fails, try `http://127.0.0.1:5050`.
- **The globe pane says GodsView will not embed here.** Add
  `GEV_EMBED_FRAME_ANCESTORS` (see Quick start) to GodsView's `.env` and
  restart it, or let the console start it.
- **The GodsView pill stays red.** Check `GEV_URL`. If the console starts
  GodsView, its last log lines appear in the globe pane. Run `npm ci` in
  `GEV_DIR` first, on Node 24.
- **Waze shows "refused (HTTP 403)".** Waze blocked the request. Try from a
  home connection, or use a Waze for Cities feed.
- **ALPR or Waze says to zoom in.** Both only load city-sized areas.
