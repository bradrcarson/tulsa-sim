/**
 * Phase 2+ module stubs — intentionally not wired into main.ts yet.
 * See AGENTS.md "Phase 2+" section.
 */

// TODO(phase2): Live Tulsa Transit GTFS-RT bus positions.
// Source: MetroLink open data — https://www.metrolinkok.org/open-data/
// Plan: poll vehicle positions feed, render as instanced sprites moving
// along the street layer; reuse llToLocal from geo/projection.
export async function loadTransitPositions(): Promise<void> {}

// TODO(phase2): ODOT OKtraffic camera markers.
// Plan: fetch camera list, drop billboard markers, click → live still frame.
export async function loadTrafficCameras(): Promise<void> {}

// TODO(phase2): 1921 Greenwood reconstruction.
// Source: NYT open GeoJSON — https://github.com/nytimes/tulsa-1921-data
// Plan: new Era{year: 1921} in layers/history.ts, extrude NYT footprints
// with a distinct sepia material when the scrubber reaches 1921.
export async function loadGreenwood1921(): Promise<void> {}

// TODO(phase2): Sanborn building footprints (Library of Congress) for
// pre-aerial eras; georeference sheets and vectorize footprints offline,
// ship as static GeoJSON like data/buildings.json.
export async function loadSanbornFootprints(): Promise<void> {}

// TODO(phase2): LLM "city concierge" chat panel.
// Plan: side panel that answers questions about the visible area by
// composing parcel/crime/history layer queries. Needs an API key — out of
// scope while Phase 1 is keyless.
export function initConciergePanel(): void {}
