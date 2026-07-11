# Tulsa Sim — Agent Instructions

Interactive 3D digital twin of Tulsa, Oklahoma. Inspired by [nycsim.com](https://nycsim.com): procedural city from real geospatial data, live data layers, parcel intelligence, and historical time travel.

**Work autonomously.** Do not ask the user for confirmation. Make reasonable defaults, document assumptions in code comments or README, and ship working software.

---

## Cursor Cloud specific instructions

- This is a greenfield project. Scaffold everything from scratch.
- Run `npm install` (or equivalent) and verify the dev server starts before marking Phase 1 complete.
- All Tulsa data sources below are **public** — no API keys required for Phase 1.
- Network access to ArcGIS REST endpoints, Overpass API, and GitHub raw URLs is required.
- Commit incrementally with clear messages. Open a **PR** when Phase 1 is complete and verified.
- Attach screenshots or a short screen recording in the PR description showing: 3D view, parcel click popup, crime heatmap toggle, 1943 aerial time scrubber.
- If a data fetch fails, retry once, then fall back to a smaller bounding box (downtown Tulsa only) rather than blocking.

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

## Phase 2+ (do NOT block Phase 1; stub hooks only)

Leave TODO comments or empty module stubs for:
- Live Tulsa Transit GTFS-RT bus positions ([MetroLink open data](https://www.metrolinkok.org/open-data/))
- ODOT OKtraffic camera markers
- 1921 Greenwood reconstruction ([NYT open GeoJSON](https://github.com/nytimes/tulsa-1921-data))
- Sanborn building footprints (Library of Congress) for pre-aerial eras
- LLM "city concierge" chat panel

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

## Verification checklist (must pass before PR)

- [ ] `npm run dev` starts without errors
- [ ] 3D buildings and streets visible for downtown Tulsa
- [ ] Click a building/parcel → popup shows owner + valuation from INCOG
- [ ] Crime heatmap toggle shows aggregated data (no raw incident pins required for v1)
- [ ] Timeline scrub to 1943 shows historical aerial basemap
- [ ] README with setup, data attribution, and license notes
- [ ] No secrets or API keys committed

---

## README requirements

Include:
- Project description and screenshot
- `npm install && npm run dev`
- Data attribution (INCOG, City of Tulsa, OpenStreetMap, Oklahoma Corporation Commission for 1943 aerial)
- Known limitations (CFS ≠ full police reports; aerial = bird's eye not street level)

---

## Git workflow

- Branch: `feat/phase-1-mvp`
- Commit often with conventional messages (`feat:`, `fix:`, `docs:`)
- Open PR to `main` when verification checklist passes
- PR title: `Phase 1: Tulsa 3D city MVP — parcels, crime, 1943 aerial`

---

## Out of scope for Phase 1

- Authentication, backend server, database
- Full metro building load (OK if perf requires downtown subset)
- Individual crime incident popups
- Mobile-native app
- Production deployment (local dev + PR is enough; optional Netlify/Vercel preview is bonus)
