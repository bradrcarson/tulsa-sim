# Tulsa Sim — 3D Digital Twin

Interactive 3D digital twin of downtown Tulsa, Oklahoma, inspired by [nycsim.com](https://nycsim.com). Procedural city built from real geospatial data: OSM building extrusions, INCOG assessor parcel intelligence, an aggregated crime heatmap, and a historical time scrubber back to the 1943 aerial survey.

![Downtown Tulsa 3D view](docs/screenshot-city.png)

![1943 aerial time scrub](docs/screenshot-1943.png)

## Quick start

```bash
npm install
npm run dev
```

Open http://localhost:5173. No API keys required — all data sources are public.

## Features (Phase 1)

- **3D city base** — ~9,500 extruded OSM building footprints and the OSM street network for the downtown core (bbox `36.135,-96.010,36.175,-95.955`), colored by height with a glowing street grid. Coordinates are normalized to a local origin at 4th & Boston to avoid float32 jitter. Architecture supports expanding to the full metro bbox.
- **Parcel intelligence** — click any building or the ground: a raycast finds the map point, and a live spatial-join query against the INCOG Tulsa County assessor FeatureServer returns owner, address, fair cash value, taxable value, land/improvement split, year built, and last sale. Results are cached in memory; the parcel boundary is highlighted in the scene.
- **Crime heatmap** — toggleable, warm-colored heat surface aggregated to ~160 m (block-scale) grid cells, with an optional category filter. Individual incidents are never shown at building precision.
- **Time machine** — scrub the timeline from 2026 back to 1943: modern buildings fade to ghosts and the 1943 black-and-white aerial survey (flown July–August 1943, ~20" resolution) drapes onto the ground via the INCOG ImageServer. The era model supports adding 1967/1921 keyframes later.
- **Navigation** — orbit/zoom/pan controls, plus a fly-to search with hardcoded downtown landmarks (Cain's Ballroom, Greenwood, BOK Tower, …) and Nominatim geocoding fallback.

## Data sources & attribution

| Layer | Source | Attribution |
|-------|--------|-------------|
| Building footprints, streets | [Overpass API](https://overpass-api.de) extract, pre-baked into `public/data/` | © [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors, ODbL |
| Parcels / assessor | [INCOG Parcels_TulsaCo FeatureServer](https://map11.incog.org/arcgis11wa/rest/services/Parcels_TulsaCo/FeatureServer/0) (live queries) | INCOG / Tulsa County Assessor |
| Crime | Live: CFS FeatureServer from spec; fallback: bundled snapshot of the public "Tulsa Crime" ArcGIS layer (TPD RMS extract, 2016–2019) | City of Tulsa / Tulsa Police Department |
| 1943 aerial | [INCOG Aerial_1943BW ImageServer](https://map11.incog.org/arcgis11wa/rest/services/Aerial_1943BW/ImageServer) (live `exportImage`) | Oklahoma Corporation Commission, via INCOG |

## Known limitations

- **Crime data**: calls-for-service / RMS extracts are *not* full police reports — they include unfounded calls and exclude some sensitive incident types. The CFS endpoint listed in the project spec currently serves data geocoded outside Tulsa (it is queried live first regardless); when it returns no Tulsa records the app falls back to a bundled 2016–2019 TPD incident snapshot and labels the source in the layer toggle ("TPD snapshot"). Swap in a current Tulsa CFS FeatureServer URL in `src/layers/crime.ts` when one is available.
- **1943 aerial**: bird's-eye photography, not street level; resolution ~20 inches. The drape covers ~8.4 km × 8.4 km around downtown.
- **Coverage**: downtown core only for v1 (performance); the projection and loaders accept the full metro bbox (`36.02,-96.15,36.25,-95.75`).
- **Heights**: most OSM footprints lack height tags; unknown buildings get a stable pseudo-random 4–10 m height. Towers with `height`/`building:levels` tags are accurate.
- **Assessor data**: INCOG parcel attributes are provided as-is; railroad/right-of-way parcels often carry no valuation.

## Verification

```bash
npm run dev          # in one terminal
node scripts/verify.mjs   # headless checklist run + screenshots
```

## Phase 2 hooks (stubs in `src/layers/phase2-stubs.ts`)

Tulsa Transit GTFS-RT bus positions · ODOT OKtraffic cameras · 1921 Greenwood reconstruction (NYT open GeoJSON) · Sanborn footprints for pre-aerial eras · LLM city concierge.

## License notes

Code: MIT. Bundled OSM extracts remain under [ODbL](https://opendatacommons.org/licenses/odbl/). Assessor, crime, and aerial data remain subject to their providers' terms (INCOG, City of Tulsa, Oklahoma Corporation Commission).
