# Tulsa Sim — Agent Instructions

Interactive 3D digital twin of Tulsa, Oklahoma. Inspired by [nycsim.com](https://nycsim.com): procedural city from real geospatial data, live data layers, parcel intelligence, and historical time travel.

**Work autonomously.** Do not ask the user for confirmation. Make reasonable defaults, document assumptions in code comments or README, and ship working software.

---

## Cursor Cloud specific instructions

**Read this section first.** Determine which phase you are running from the kickoff prompt or branch name.

### Phase 1 (greenfield — already shipped on `feat/phase-1-mvp`)
- Scaffold everything from scratch.
- Run `npm install` and verify the dev server starts before marking Phase 1 complete.
- All Tulsa data sources below are **public** — no API keys required for Phase 1.
- Network access to ArcGIS REST endpoints, Overpass API, and GitHub raw URLs is required.
- Commit incrementally with clear messages. Open a **PR** when Phase 1 is complete and verified.
- Attach screenshots or a short screen recording in the PR description showing: 3D view, parcel click popup, crime heatmap toggle, 1943 aerial time scrubber.
- If a data fetch fails, retry once, then fall back to a smaller bounding box (downtown Tulsa only) rather than blocking.

### Phase 2 (polish — build on Phase 1 codebase)
- **Start from `feat/phase-1-mvp`** (or `main` if Phase 1 PR is merged). Do **not** rebuild from scratch.
- **First task:** run `git rm -r --cached node_modules` if `node_modules` is tracked, commit, and ensure `.gitignore` covers `node_modules/`, `dist/`, `.vite/`.
- Run `npm install`, `npm run dev`, and `node scripts/verify.mjs` to confirm Phase 1 still works before changing UI.
- Work autonomously through the Phase 2 checklist below. Do not ask the user for confirmation.
- Branch: `feat/phase-2-polish`. Open PR to `main` when the Phase 2 verification checklist passes.
- Attach **6+ screenshots** in the PR: City Vitals panel, night mode, live buses, camera popup, expanded coverage, cinematic fly-through frame.
- Extend `scripts/verify.mjs` with Phase 2 checks (buses toggle, cameras toggle, vitals panel visible).
- If a live feed fails after one retry, ship a graceful fallback (last-known positions, static camera list, or "unavailable" label) — do not block the PR.

---

## Phase 1 scope (this run)

Deliver a working web app with these features:

### 1. 3D city base
- **Stack:** Vite + TypeScript + Three.js (r160+). No React required unless it helps — keep it simple.
- **Coverage:** Tulsa metro bounding box approximately `36.02,-96.15,36.25,-95.75` (WGS84). Start with **downtown core** (~2 km²) if full metro is too heavy, but architecture must support expansion.
- **Buildings:** Extrude OSM building footprints. Source via Overpass API or pre-download GeoJSON for the bbox (~73k buildings metro-wide; subset for v1 is fine).
- **Streets:** OSM highway network as flat ribbons or lines on the ground plane.
- **Coordinates:** Normalize lat/lon to a local origin (0,0,0) before creating Three.js geometry to avoid floating-point jitter.

### 2. Parcel click — assessor intelligence
- Spatial join: click raycast on building/ground → find parcel polygon underneath.
- **Source:** [INCOG Parcels_TulsaCo FeatureServer](https://map11.incog.org/arcgis11wa/rest/services/Parcels_TulsaCo/FeatureServer/0)
- Query example: `.../0/query?geometry={lon},{lat}&geometryType=esriGeometryPoint&inSR=4326&spatialRel=esriSpatialRelIntersects&outFields=Owner,PropertyAddress,TotalAcctValue,TaxableValue,TotalLandValue,TotalImpValue,YearBuilt,SalePrice,SaleDate,PropertyType,ACCT_NUM&f=json`
- **UI popup:** owner name, address, fair cash value (`TotalAcctValue`), taxable value, year built, last sale if present.
- Cache parcel attributes client-side or in-memory after first fetch for the visible area.

### 3. Crime layer (aggregated, not pinpoint)
- **Source:** [Tulsa Crime CFS FeatureServer](https://services2.arcgis.com/kXGqZY4GIOcEYxoF/ArcGIS/rest/services/Crime_Data_vw_crimes_public_cfs/FeatureServer/0)
- Fields: `Problem`, `Response_Date`, `Call_Disposition`, `District`, `Beat`, `Address`, lat/lon.
- **UX:** Toggle "Crime heatmap" — aggregate points into a grid or heat surface. Default: last 90 days.
- **Do NOT** show individual incident narratives at building precision. Block-level / neighborhood summary only.
- Optional: filter by `Problem` category.

### 4. Historical time scrubber (stub → working)
- **1943 aerial:** [INCOG Aerial_1943BW ImageServer](https://map11.incog.org/arcgis11wa/rest/services/Aerial_1943BW/ImageServer)
- Drape as ground texture or swap basemap when user scrubs timeline to 1943.
- Timeline UI: slider with keyframes at minimum **1943** and **2026 (Today)**. Architecture should allow adding 1967, 1921 later.
- When year = 1943, fade modern extruded buildings to semi-transparent; show aerial photo ground.

### 5. Camera & navigation
- Orbit controls (rotate, zoom, pan). Double-click or "fly to" lat/lon from search box.
- Simple search: geocode via Nominatim or hardcoded downtown landmarks (Centennial Green, Cain's Ballroom, Greenwood).

---

## Phase 2 scope (this run — polish toward nycsim.com)

**Goal:** Transform the working Phase 1 alpha into a cinematic, nycsim-inspired experience. Keep all Phase 1 features working. Add live layers, richer UI, visual polish, and modest geographic expansion.

**Reference:** Study [nycsim.com](https://nycsim.com) for density of UI chrome, dark dashboard feel, layer toggles, and "city vitals" sidebar — match the *vibe*, not a pixel clone.

### 0. Repo hygiene (mandatory first step)
- Remove `node_modules` from git history on this branch (`git rm -r --cached node_modules`).
- Never commit `node_modules`, `dist`, or `.vite` cache.
- Keep bundled data in `public/data/` only (GeoJSON, GTFS zip if needed).

### 1. City Vitals dashboard (nycsim-style UI)
Replace/extend the minimal toolbar with a **right-side "City Vitals" panel** (collapsible on mobile):

| Widget | Behavior |
|--------|----------|
| **Live clock** | Tulsa local time (America/Chicago), updates every second |
| **Weather** | Fetch current conditions for Tulsa from [Open-Meteo](https://open-meteo.com/en/docs) (no API key): `https://api.open-meteo.com/v1/forecast?latitude=36.154&longitude=-95.992&current=temperature_2m,weather_code,wind_speed_10m&timezone=America/Chicago` |
| **Population / area** | Static label: "Tulsa metro ~1M" (hardcoded is fine) |
| **Active layers count** | "N layers live" based on toggled layers |
| **Transit summary** | When buses on: "X buses tracked" from GTFS-RT feed |
| **Crime summary** | Reuse existing crime subtitle / cell count |

**Visual spec:**
- Dark glass panel (`backdrop-filter: blur`), monospace labels, cyan accent (`#46b4ff`), warm accent for alerts (`#ff9c46`).
- Thin animated border glow on panel edges (CSS, not heavy shaders).
- Bottom-left status chip stays; move layer toggles into a unified **Layers** section in the vitals panel OR keep left toolbar but style both consistently.

### 2. Live Tulsa Transit buses (replace `phase2-stubs.ts`)
Wire real-time bus positions into the scene.

**Feeds (no API key):**
- **GTFS-RT vehicle positions (protobuf):** `https://tulsa.rideralerts.com/InfoPoint/GTFS-Realtime.ashx?Type=VehiclePosition`
- **GTFS static (for route colors / stop names):** download from [gtfs.tulsatransit.org](https://gtfs.tulsatransit.org/) — cache `routes.txt` / `trips.txt` or ship a trimmed JSON in `public/data/transit-routes.json`
- **Fallback if protobuf parsing is heavy:** add `gtfs-realtime-bindings` or `@bufbuild/protobuf` + decode `FeedMessage` manually; or poll every 15s and diff positions

**Rendering:**
- Instanced mesh or sprite markers at lat/lon → `llToLocal` from `geo/projection.ts`
- Color by route ID (hash route to hue)
- Subtle vertical offset (2–4 m) so buses sit on streets
- Heading arrow if `bearing` present in feed
- Toggle: "Live buses" in Layers panel; subtitle shows count + last refresh time
- Poll interval: 15 seconds; show stale indicator if >60s without update

**Module structure:** Replace stubs in `src/layers/phase2-stubs.ts` → split into `src/layers/transit.ts` and `src/layers/cameras.ts`. Wire from `main.ts`.

### 3. ODOT / OKtraffic camera markers
Show highway traffic cameras in the Tulsa metro bbox.

**Discovery strategy (agent must execute):**
1. Load [oktraffic.org](https://oktraffic.org) and inspect network requests for camera list / image URL patterns.
2. Search ODOT ArcGIS REST directories: `https://services6.arcgis.com/RBtoEUQ2lmN0K3GY/arcgis/rest/services` and `https://gisdata.odot.ok.gov/arcgis/rest/services` for camera/CCTV/RWIS layers.
3. Filter results to bbox `36.02,-96.15,36.25,-95.75` (Tulsa metro).

**UX:**
- Camera icon billboards along I-44, I-244, US-75, Creek Turnpike near Tulsa
- Click camera → side popup or modal with **live still image** (if URL pattern found) or link to OKtraffic
- Toggle: "Traffic cameras" in Layers panel
- If no stable public API: ship **≥5 hardcoded Tulsa-area camera locations** with links to `https://oktraffic.org/#/map?lat=…&lon=…` and document the limitation in README

### 4. Visual polish (3D scene + atmosphere)
Make the city feel cinematic, not "debug extrusions":

- **Night mode toggle** (default ON for demo screenshots): dark sky, emissive window scatter on buildings (procedural — random lit windows by building seed), street grid glow intensified
- **Improved lighting:** hemisphere + directional moonlight; subtle fog (`FogExp2`, dark blue-gray)
- **Building materials:** slight emissive rim on roof edges; taller buildings brighter; optional land-use tint when parcel `PropertyType` was fetched nearby
- **Post-processing (optional):** `@react-three/postprocessing` NOT needed — use Three.js `EffectComposer` + `UnrealBloomPass` sparingly on street grid only, or skip if perf drops
- **Intro fly-through:** on load, 3-second cinematic camera path from high angle down to downtown (Cain's / BOK Tower); user can skip with any click
- **Performance guard:** stay ≥25 fps downtown; reduce bloom quality before dropping building count

### 5. Geographic expansion (moderate)
Expand beyond downtown core without freezing the browser:

- **Target bbox:** `36.10,-96.05,36.20,-95.88` (~midtown + Cherry Street + Expo Square + parts of Broken Arrow edge) OR full metro `36.02,-96.15,36.25,-95.75` if perf allows
- Pre-bake new building/street GeoJSON into `public/data/` (do not commit raw Overpass responses >5 MB uncompressed — simplify geometries)
- LOD: buildings beyond 2 km from origin get simpler extrusion (fixed height, no per-building detail)
- Update brand subtitle: "3D digital twin · Tulsa metro" when expanded

### 6. Keep Phase 1 features intact
Do not regress:
- Parcel click → INCOG assessor popup
- Crime heatmap toggle + category filter
- 1943 aerial time scrubber
- Search / fly-to landmarks
- `node scripts/verify.mjs` Phase 1 checks still pass

### 7. Phase 2+ stubs (optional bonus — do NOT block PR)
If time remains after checklist passes:
- Timeline keyframe **1921** with NYT Greenwood GeoJSON ([github.com/nytimes/tulsa-1921-data](https://github.com/nytimes/tulsa-1921-data)) — sepia footprints, no modern buildings
- Empty `src/ui/concierge.ts` stub with "Coming soon" panel (no API keys)

---

## Phase 2 data source reference

| Layer | URL | Notes |
|-------|-----|-------|
| GTFS-RT positions | `https://tulsa.rideralerts.com/InfoPoint/GTFS-Realtime.ashx?Type=VehiclePosition` | `application/octet-stream` protobuf; poll 15s |
| GTFS-RT trips | `https://tulsa.rideralerts.com/InfoPoint/GTFS-Realtime.ashx?Type=TripUpdate` | Optional ETA in vitals |
| GTFS static | `https://gtfs.tulsatransit.org/` (download zip) | Route colors, stop names |
| Weather | `https://api.open-meteo.com/v1/forecast?latitude=36.154&longitude=-95.992&current=temperature_2m,weather_code,wind_speed_10m&timezone=America/Chicago` | No key |
| OKtraffic cameras | Discover via oktraffic.org / ODOT ArcGIS | See §3 above |
| 1921 Greenwood | `https://github.com/nytimes/tulsa-1921-data` | Bonus only |

### GTFS-RT decoding tips
- Response is Google `FeedMessage` protobuf (see [GTFS Realtime reference](https://gtfs.org/documentation/realtime/reference/)).
- Each `VehiclePosition` has `position.latitude`, `position.longitude`, optional `position.bearing`, `trip.route_id`, `vehicle.id`.
- Use `gtfs-realtime-bindings` npm package if available, or minimal hand-rolled protobuf decode for `VehiclePosition` only.
- Filter positions to Tulsa bbox before rendering.

---

## Data source reference

| Layer | URL | Notes |
|-------|-----|-------|
| Parcels / assessor | `https://map11.incog.org/arcgis11wa/rest/services/Parcels_TulsaCo/FeatureServer/0` | Owner, valuation, year built |
| Crime CFS | `https://services2.arcgis.com/kXGqZY4GIOcEYxoF/ArcGIS/rest/services/Crime_Data_vw_crimes_public_cfs/FeatureServer/0` | Geocoded calls for service |
| 1943 aerial | `https://map11.incog.org/arcgis11wa/rest/services/Aerial_1943BW/ImageServer` | Tulsa County, ~20" resolution |
| OSM buildings | Overpass: `way["building"](36.02,-96.15,36.25,-95.75)` | Or Microsoft OK footprints filtered to bbox |
| Zoning | `https://map11.incog.org/arcgis11wa/rest/services/Zoning_TulsaCo/FeatureServer` | Phase 2 |

### ArcGIS query tips
- Max record count is often 2000 — paginate with `resultOffset` / `resultRecordCount`.
- Prefer `f=geojson` where supported.
- INCOG uses Oklahoma State Plane (EPSG:2267) for some layers; convert to WGS84 for Three.js.

### Overpass tips
- Use `https://overpass-api.de/api/interpreter` with reasonable timeout.
- For v1, query downtown bbox only: `36.12,-95.99,36.16,-95.95`.

---

## Architecture

```
src/
  main.ts              # entry, render loop
  scene/               # Three.js scene, lights, camera
  layers/
    buildings.ts       # OSM footprint extrusion
    streets.ts         # road network
    parcels.ts         # ArcGIS parcel fetch + spatial index
    crime.ts           # CFS fetch + heatmap
    history.ts         # aerial ImageServer tile drape + timeline
  ui/
    popup.ts           # parcel info panel
    timeline.ts        # year scrubber
    toolbar.ts         # layer toggles
  geo/
    projection.ts      # lat/lon → local meters
    spatial.ts         # point-in-polygon, r-tree or simple grid
  data/
    cache.ts           # in-memory + optional IndexedDB for tiles
```

Use a lightweight spatial index (rbush or flatbush) for parcel picking if loading many polygons.

---

## Visual design

- Dark UI chrome (think nycsim / sci-fi dashboard), not generic Bootstrap.
- Glowing street grid optional but nice.
- Building colors by height or land use when assessor data available.
- Crime heatmap: warm colors (orange/red), semi-transparent overlay.
- Performance target: 30+ fps on modern laptop for downtown subset.

---

## Verification checklist — Phase 1 (must pass before Phase 1 PR)

- [ ] `npm run dev` starts without errors
- [ ] 3D buildings and streets visible for downtown Tulsa
- [ ] Click a building/parcel → popup shows owner + valuation from INCOG
- [ ] Crime heatmap toggle shows aggregated data (no raw incident pins required for v1)
- [ ] Timeline scrub to 1943 shows historical aerial basemap
- [ ] README with setup, data attribution, and license notes
- [ ] No secrets or API keys committed

## Verification checklist — Phase 2 (must pass before Phase 2 PR)

- [ ] `node_modules` is **not** tracked in git
- [ ] `npm run dev` starts; `node scripts/verify.mjs` passes (Phase 1 + new Phase 2 steps)
- [ ] City Vitals panel visible with live clock + weather
- [ ] Night mode / cinematic lighting noticeably improved vs Phase 1 screenshots
- [ ] "Live buses" toggle shows ≥1 bus marker when service is running (or honest "no vehicles" state)
- [ ] "Traffic cameras" toggle shows camera markers; click opens image or OKtraffic link
- [ ] Parcel click, crime heatmap, 1943 scrubber still work
- [ ] Building coverage expanded beyond Phase 1 downtown bbox OR README explains perf-limited scope
- [ ] README updated with Phase 2 features, new data sources, screenshots
- [ ] PR includes 6+ screenshots; no secrets committed

---

## README requirements

Include:
- Project description and screenshot
- `npm install && npm run dev`
- Data attribution (INCOG, City of Tulsa, OpenStreetMap, Oklahoma Corporation Commission for 1943 aerial)
- Known limitations (CFS ≠ full police reports; aerial = bird's eye not street level)

---

## Git workflow

### Phase 1 (complete)
- Branch: `feat/phase-1-mvp`
- PR title: `Phase 1: Tulsa 3D city MVP — parcels, crime, 1943 aerial`

### Phase 2 (this run)
- Branch from: `feat/phase-1-mvp`
- Work branch: `feat/phase-2-polish`
- Commit often with conventional messages (`feat:`, `fix:`, `docs:`, `chore:`)
- Open PR to `main` when Phase 2 verification checklist passes
- PR title: `Phase 2: Tulsa Sim polish — City Vitals, live buses, cameras, night mode`

---

## Out of scope for Phase 1

- Authentication, backend server, database
- Full metro building load (OK if perf requires downtown subset)
- Individual crime incident popups
- Mobile-native app
- Production deployment (local dev + PR is enough; optional Netlify/Vercel preview is bonus)
