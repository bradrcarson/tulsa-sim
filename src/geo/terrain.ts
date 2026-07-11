/**
 * Terrain heightfield sampled from the baked USGS 3DEP DEM (see
 * scripts/bake-metro.mjs → public/data/terrain.bin).
 *
 * Elevations are returned relative to the downtown origin (4th & Boston,
 * ~194 m NAVD88) so the existing y≈0 assumptions around downtown still hold:
 * the Arkansas River sits ~-20 m, Turkey Mountain ~+60 m.
 */
import { fetchWithRetry } from '../data/cache';

let minX = 0;
let minZ = 0;
let dx = 1;
let dz = 1;
let W = 0;
let H = 0;
let data: Int16Array | null = null;
let originElev = 0;

export async function loadTerrain(url = 'data/terrain.bin'): Promise<void> {
  const res = await fetchWithRetry(url);
  const buf = await res.arrayBuffer();
  const dv = new DataView(buf);
  minX = dv.getFloat64(0, true);
  minZ = dv.getFloat64(8, true);
  dx = dv.getFloat64(16, true);
  dz = dv.getFloat64(24, true);
  W = dv.getUint32(32, true);
  H = dv.getUint32(36, true);
  data = new Int16Array(buf, 40, W * H);
  originElev = sampleRaw(0, 0);
  console.info(`[terrain] ${W}×${H} heightfield, origin elevation ${originElev.toFixed(1)} m`);
}

export const terrainReady = () => data !== null;

/** Raw NAVD88 meters via bilinear interpolation. */
function sampleRaw(x: number, z: number): number {
  if (!data) return 0;
  const fc = (x - minX) / dx;
  const fr = (z - minZ) / dz;
  const c = Math.max(0, Math.min(W - 2, Math.floor(fc)));
  const r = Math.max(0, Math.min(H - 2, Math.floor(fr)));
  const tc = Math.max(0, Math.min(1, fc - c));
  const tr = Math.max(0, Math.min(1, fr - r));
  const v00 = data[r * W + c];
  const v01 = data[r * W + c + 1];
  const v10 = data[(r + 1) * W + c];
  const v11 = data[(r + 1) * W + c + 1];
  return ((v00 * (1 - tc) + v01 * tc) * (1 - tr) + (v10 * (1 - tc) + v11 * tc) * tr) / 10;
}

/** Elevation in scene meters (0 at downtown origin). */
export function elevation(x: number, z: number): number {
  if (!data) return 0;
  return sampleRaw(x, z) - originElev;
}

/** Heightfield extent in local meters. */
export function terrainExtent() {
  return { minX, minZ, maxX: minX + dx * (W - 1), maxZ: minZ + dz * (H - 1) };
}
