/**
 * Phase 3+ module stubs — intentionally not wired into main.ts yet.
 *
 * Phase 2 promoted the original transit and camera stubs into real modules:
 *   - Live Tulsa Transit GTFS-RT buses → src/layers/transit.ts
 *   - ODOT / OKtraffic camera markers  → src/layers/cameras.ts
 *   - LLM city concierge panel (stub)  → src/ui/concierge.ts
 */

// TODO(phase3): 1921 Greenwood reconstruction.
// Source: NYT open GeoJSON — https://github.com/nytimes/tulsa-1921-data
// Plan: new Era{year: 1921} in layers/history.ts, extrude NYT footprints
// with a distinct sepia material when the scrubber reaches 1921.
export async function loadGreenwood1921(): Promise<void> {}

// TODO(phase3): Sanborn building footprints (Library of Congress) for
// pre-aerial eras; georeference sheets and vectorize footprints offline,
// ship as static GeoJSON like data/buildings.json.
export async function loadSanbornFootprints(): Promise<void> {}
