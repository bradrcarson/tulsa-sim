import * as THREE from 'three';
import { localToLL } from '../geo/projection';
import { terrainExtent } from '../geo/terrain';

/**
 * Tiered USGS aerial imagery (public-domain NAIP composite), shared by the
 * terrain drape and the building-roof orthotexture:
 *
 *   core  — ±2.2 km around downtown @ 4096 px  (~1.1 m/px)
 *   inset — ±6 km               @ 4096 px  (~2.9 m/px)
 *   metro — full heightfield extent @ 4096 px (~9 m/px)
 *
 * Each tier also keeps a small sampling canvas so layers can read the
 * *actual color* of a building's roof from the photo (walls get tinted with
 * it — brick reads brick, white stone reads white).
 */
const IMG_SERVICE =
  'https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer/export';

export interface ImageryTier {
  name: string;
  minX: number;
  minZ: number;
  maxX: number;
  maxZ: number;
  tex: THREE.Texture | null;
  ctx: CanvasRenderingContext2D | null;
  sampleSize: number;
}

const tiers: ImageryTier[] = [];
let loadPromise: Promise<void> | null = null;

function makeTier(name: string, minX: number, minZ: number, maxX: number, maxZ: number): ImageryTier {
  return { name, minX, minZ, maxX, maxZ, tex: null, ctx: null, sampleSize: 1024 };
}

async function loadTier(tier: ImageryTier, w: number, h: number): Promise<void> {
  const [west, south] = localToLL(tier.minX, tier.maxZ);
  const [east, north] = localToLL(tier.maxX, tier.minZ);
  const url =
    `${IMG_SERVICE}?bbox=${west},${south},${east},${north}&bboxSR=4326&imageSR=4326` +
    `&size=${w},${h}&format=jpg&f=image`;
  try {
    const tex = await new THREE.TextureLoader().loadAsync(url);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 8;
    tier.tex = tex;
    // small canvas copy for pixel sampling (CORS-clean: USGS sends ACAO *)
    try {
      const cv = document.createElement('canvas');
      cv.width = cv.height = tier.sampleSize;
      const ctx = cv.getContext('2d', { willReadFrequently: true })!;
      ctx.drawImage(tex.image as CanvasImageSource, 0, 0, tier.sampleSize, tier.sampleSize);
      tier.ctx = ctx;
    } catch (err) {
      console.warn(`[imagery] ${tier.name}: sampling canvas unavailable`, err);
    }
  } catch (err) {
    console.warn(`[imagery] ${tier.name} fetch failed`, err);
  }
}

/** Kick off all tier fetches (idempotent). Resolves when all settled. */
export function loadImagery(): Promise<void> {
  if (loadPromise) return loadPromise;
  const ext = terrainExtent();
  tiers.push(
    makeTier('core', -2200, -2200, 2200, 2200),
    makeTier('inset', -6000, -6000, 6000, 6000),
    makeTier('metro', ext.minX, ext.minZ, ext.maxX, ext.maxZ),
  );
  const metroAspect = (ext.maxZ - ext.minZ) / (ext.maxX - ext.minX);
  loadPromise = Promise.allSettled([
    loadTier(tiers[0], 4096, 4096),
    loadTier(tiers[1], 4096, 4096),
    loadTier(tiers[2], 4096, Math.round(4096 * metroAspect)),
  ]).then(() => {
    console.info('[imagery]', tiers.filter((t) => t.tex).map((t) => t.name).join(', '), 'loaded');
  });
  return loadPromise;
}

export const imageryTiers = () => tiers;

/** Smallest ready tier fully containing the given bbox. */
export function tierForBbox(minX: number, minZ: number, maxX: number, maxZ: number): ImageryTier | null {
  for (const t of tiers) {
    if (t.tex && minX >= t.minX && maxX <= t.maxX && minZ >= t.minZ && maxZ <= t.maxZ) return t;
  }
  return null;
}

/** UV within a tier for a local-meter point (row 0 of the export = north = minZ). */
export function tierUV(t: ImageryTier, x: number, z: number): [number, number] {
  return [(x - t.minX) / (t.maxX - t.minX), 1 - (z - t.minZ) / (t.maxZ - t.minZ)];
}

const px = { data: null as Uint8ClampedArray | null };

/** Average photo color around a local-meter point (best tier), or null. */
export function sampleColor(x: number, z: number): THREE.Color | null {
  for (const t of tiers) {
    if (!t.ctx || x < t.minX || x > t.maxX || z < t.minZ || z > t.maxZ) continue;
    const u = ((x - t.minX) / (t.maxX - t.minX)) * t.sampleSize;
    const v = ((z - t.minZ) / (t.maxZ - t.minZ)) * t.sampleSize;
    try {
      const img = t.ctx.getImageData(Math.max(0, Math.min(t.sampleSize - 2, u - 1)), Math.max(0, Math.min(t.sampleSize - 2, v - 1)), 2, 2);
      px.data = img.data;
    } catch {
      return null;
    }
    const d = px.data;
    let r = 0, g = 0, b = 0;
    for (let i = 0; i < 4; i++) {
      r += d[i * 4];
      g += d[i * 4 + 1];
      b += d[i * 4 + 2];
    }
    return new THREE.Color(r / 1020, g / 1020, b / 1020);
  }
  return null;
}
