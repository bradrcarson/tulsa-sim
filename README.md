# Tulsa Sim — 3D Digital Twin

Interactive 3D digital twin of Tulsa, Oklahoma, inspired by [nycsim.com](https://nycsim.com). Procedural city built from real geospatial data: OSM building extrusions, INCOG assessor parcel intelligence, an aggregated crime heatmap, a historical time scrubber back to the 1943 aerial survey — and, since Phase 2, live Tulsa Transit buses, ODOT traffic cameras, a City Vitals dashboard, and a cinematic night mode.

![Night city with City Vitals dashboard](docs/screenshot-city.png)

![1943 aerial time scrub](docs/screenshot-1943.png)

## Quick start

```bash
npm install
npm run dev
```

Open http://localhost:5173. No API keys required — all data sources are public.

## Features

### Phase 1 (city base)

- **3D city base** — extruded OSM building footprints and the OSM street network, colored by height with a glowing street grid. Coordinates are normalized to a local origin at 4th & Boston to avoid float32 jitter.
- **Parcel intelligence** — click any building or the ground: a raycast finds the map point, and a live spatial-join query against the INCOG Tulsa County assessor FeatureServer returns owner, address, fair cash value, taxable value, land/improvement split, year built, and last sale. Results are cached in memory; the parcel boundary is highlighted in the scene.
- **Crime heatmap** — toggleable, warm-colored heat surface aggregated to ~160 m (block-scale) grid cells, with an optional category filter. Individual incidents are never shown at building precision.
- **Time machine** — scrub the timeline from 2026 back to 1943: modern buildings fade to ghosts and the 1943 black-and-white aerial survey (flown July–August 1943, ~20" resolution) drapes onto the ground via the INCOG ImageServer. The era model supports adding 1967/1921 keyframes later.
- **Navigation** — orbit/zoom/pan controls, plus a fly-to search with hardcoded landmarks (Cain's Ballroom, Greenwood, BOK Tower, Expo Square, …) and Nominatim geocoding fallback.

### Phase 2 (polish)

- **City Vitals dashboard** — right-side glass panel with a live Tulsa clock (America/Chicago), current weather from Open-Meteo (temperature, conditions, wind — no API key), metro population, active-layer count, transit and crime summaries, and all layer/display toggles.
- **Live Tulsa Transit buses** — real-time GTFS-Realtime vehicle positions polled every 15 s from the Tulsa Transit feed and decoded with a hand-rolled minimal protobuf reader (`src/data/gtfsrt.ts`, no heavy deps). Buses render as instanced bodies colored by GTFS route color, with heading arrows (feed bearing) and glow beacons. The vitals panel shows fleet count, seconds since last refresh, and a STALE flag past 60 s. If the feed fails, last-known positions are kept and the state is labeled honestly.
- **Traffic cameras** — ~219 ODOT/OKtraffic cameras in the Tulsa metro bbox, discovered via the `oktraffic.org` LoopBack API (`/api/MapCameras`). Markers are billboard CCTV icons on masts along I-44, I-244, US-75, and the Creek Turnpike; clicking one opens a detail card with a deep link to the live view on OKtraffic.org.
- **Night mode + cinematic look** — night is the default: moonlit hemisphere lighting, exponential fog, procedurally scattered lit windows (seeded per building, ~18k additive points), roof rim highlights, and a restrained bloom pass. An fps guard disables bloom before ever dropping buildings below 25 fps. Day mode is one toggle away.
- **Intro fly-through** — 3-second cinematic swoop from high altitude down to downtown on load; any click/key/scroll skips it.
- **Expanded coverage** — building/street extraction grew from the ~2 km² downtown core to the midtown bbox `36.10,-96.05 → 36.20,-95.88` (~26,500 buildings, ~25,000 street segments) with LOD rules: beyond 2 km from origin, small sheds are dropped and footprints are simplified harder. Re-bake with `node scripts/bake-data.mjs`.

## Data sources & attribution

| Layer | Source | Attribution |
|-------|--------|-------------|
| Building footprints, streets | [Overpass API](https://overpass-api.de) extract, pre-baked into `public/data/` | © [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors, ODbL |
| Parcels / assessor | [INCOG Parcels_TulsaCo FeatureServer](https://map11.incog.org/arcgis11wa/rest/services/Parcels_TulsaCo/FeatureServer/0) (live queries) | INCOG / Tulsa County Assessor |
| Crime | Live: CFS FeatureServer from spec; fallback: bundled snapshot of the public "Tulsa Crime" ArcGIS layer (TPD RMS extract, 2016–2019) | City of Tulsa / Tulsa Police Department |
| 1943 aerial | [INCOG Aerial_1943BW ImageServer](https://map11.incog.org/arcgis11wa/rest/services/Aerial_1943BW/ImageServer) (live `exportImage`) | Oklahoma Corporation Commission, via INCOG |
| Live bus positions | [Tulsa Transit GTFS-Realtime](https://tulsa.rideralerts.com/InfoPoint/GTFS-Realtime.ashx?Type=VehiclePosition) + [GTFS static](https://gtfs.tulsatransit.org/) route metadata baked to `public/data/transit-routes.json` | MetroLink Tulsa (Tulsa Transit) |
| Traffic cameras | [OKtraffic](https://oktraffic.org) `api/MapCameras`, snapshot baked to `public/data/cameras.json` (live-refreshed through a dev proxy) | Oklahoma DOT / OKtraffic |
| Weather | [Open-Meteo forecast API](https://open-meteo.com/) (no key) | Open-Meteo.com |

## Known limitations

- **Crime data**: calls-for-service / RMS extracts are *not* full police reports — they include unfounded calls and exclude some sensitive incident types. The CFS endpoint listed in the project spec currently serves data geocoded outside Tulsa (it is queried live first regardless); when it returns no Tulsa records the app falls back to a bundled 2016–2019 TPD incident snapshot and labels the source in the layer toggle ("TPD snapshot"). Swap in a current Tulsa CFS FeatureServer URL in `src/layers/crime.ts` when one is available.
- **1943 aerial**: bird's-eye photography, not street level; resolution ~20 inches. The drape covers ~8.4 km × 8.4 km around downtown.
- **Camera stills**: OKtraffic video streams are negotiated per session behind their backend (`startStream`), and no stable public still-image URL pattern exists, so camera cards deep-link to the official OKtraffic map instead of embedding frames. The camera *list* API also sends no CORS headers — the Vite dev server proxies it (`/oktraffic-api`); static hosting falls back to the baked snapshot.
- **Bus service hours**: outside Tulsa Transit service hours the GTFS-RT feed legitimately reports few or no vehicles; the vitals panel shows "no vehicles reporting" rather than hiding the layer.
- **Coverage**: midtown bbox (`36.10,-96.05,36.20,-95.88`) rather than the full metro — the full-metro extract (~73k buildings) is beyond the 30 fps target on SwiftShader/laptop GPUs. The bake script and projection accept the full metro bbox (`36.02,-96.15,36.25,-95.75`) when you want to try.
- **Heights**: most OSM footprints lack height tags; unknown buildings get a stable pseudo-random 4–10 m height. Towers with `height`/`building:levels` tags are accurate.
- **Assessor data**: INCOG parcel attributes are provided as-is; railroad/right-of-way parcels often carry no valuation.

## Verification

```bash
npm run dev               # in one terminal
node scripts/verify.mjs   # headless Phase 1 + Phase 2 checklist + 8 screenshots
```

## Data baking

```bash
node scripts/bake-data.mjs            # everything
node scripts/bake-data.mjs buildings  # Overpass buildings + streets (expanded bbox)
node scripts/bake-data.mjs transit    # GTFS static routes → transit-routes.json
node scripts/bake-data.mjs cameras    # OKtraffic snapshot → cameras.json
```

## Phase 3 hooks (stubs in `src/layers/phase2-stubs.ts`, `src/ui/concierge.ts`)

1921 Greenwood reconstruction (NYT open GeoJSON) · Sanborn footprints for pre-aerial eras · LLM city concierge.

## License notes

Code: MIT. Bundled OSM extracts remain under [ODbL](https://opendatacommons.org/licenses/odbl/). Assessor, crime, aerial, transit, and camera data remain subject to their providers' terms (INCOG, City of Tulsa, Oklahoma Corporation Commission, MetroLink Tulsa, ODOT).
