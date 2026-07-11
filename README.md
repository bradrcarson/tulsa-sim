# Tulsa Sim

Interactive 3D digital twin of Tulsa, Oklahoma — procedural city from real geospatial
data (buildings, parcels, crime, historical aerials). See `AGENTS.md` for the full
Phase 1 scope and data sources.

## Stack

Vite + TypeScript + Three.js.

## Getting started

```bash
npm install
npm run dev      # Vite dev server → http://localhost:5173/
```

Other scripts:

```bash
npm run build    # tsc typecheck + production build to dist/
npm run preview  # serve the production build locally
```

## Status

A minimal Three.js scaffold (`src/main.ts`) renders a placeholder 3D scene to verify the
toolchain. The Tulsa data layers described in `AGENTS.md` build on top of this entry point.

## Data attribution

- Parcels / assessor & 1943 aerial: INCOG
- Crime calls for service: City of Tulsa
- Building footprints & streets: OpenStreetMap contributors
- 1943 aerial imagery: Oklahoma Corporation Commission

## Known limitations

- Crime CFS data reflects calls for service, not full police reports.
- Historical aerials are bird's-eye imagery, not street-level.
