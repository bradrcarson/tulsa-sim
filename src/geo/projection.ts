/**
 * Local tangent-plane projection: lat/lon (WGS84) → meters relative to a
 * fixed origin in downtown Tulsa. Equirectangular approximation is accurate
 * to well under a meter across the ~4 km downtown extent, and keeps Three.js
 * coordinates small to avoid float32 jitter.
 *
 * Three.js convention: +X = east, +Z = south (so north is -Z), +Y = up.
 */

export const ORIGIN = { lat: 36.1540, lon: -95.9928 }; // 4th & Boston, downtown Tulsa

const EARTH_RADIUS = 6378137;
const DEG = Math.PI / 180;
const M_PER_DEG_LAT = EARTH_RADIUS * DEG; // ~111319.5 m
const M_PER_DEG_LON = EARTH_RADIUS * DEG * Math.cos(ORIGIN.lat * DEG);

/** lat/lon → local meters [x, z] for Three.js (y-up scene). */
export function llToLocal(lon: number, lat: number): [number, number] {
  const x = (lon - ORIGIN.lon) * M_PER_DEG_LON;
  const z = -(lat - ORIGIN.lat) * M_PER_DEG_LAT;
  return [x, z];
}

/** local meters [x, z] → lon/lat. */
export function localToLL(x: number, z: number): [number, number] {
  const lon = ORIGIN.lon + x / M_PER_DEG_LON;
  const lat = ORIGIN.lat - z / M_PER_DEG_LAT;
  return [lon, lat];
}

/** Downtown coverage bbox (WGS84): [west, south, east, north]. */
export const DOWNTOWN_BBOX: [number, number, number, number] = [-96.010, 36.135, -95.955, 36.175];

/** Phase 2 baked coverage: midtown + Cherry Street + Expo Square (see scripts/bake-data.mjs). */
export const EXPANDED_BBOX: [number, number, number, number] = [-96.05, 36.10, -95.88, 36.20];

/** Full Tulsa-metro bbox for future expansion (Phase 3+). */
export const METRO_BBOX: [number, number, number, number] = [-96.15, 36.02, -95.75, 36.25];
