/**
 * Lidar bake — per-building heights from USGS 3DEP point clouds.
 *
 *   node scripts/bake-lidar.mjs
 *
 * Streams the USGS Entwine Point Tile (EPT) archive for the lidar
 * collection covering Tulsa (USGS_LPC_OK_Woodward_UTM15_B6_2016, QL2,
 * ~22B points, EPSG:3857 + NAVD88 z) and rasterizes two grids over the
 * inner city (±6 km of downtown, where the close-up LODs render):
 *
 *   DSM    — max z of non-ground returns per 2 m cell (roofs, trees)
 *   ground — min z of class-2 returns per 2 m cell
 *
 * Octree depth: 8 across the inset (~1.8 m point spacing cumulative),
 * 9 within ±2.2 km of downtown (~0.9 m) for the tower core.
 *
 * Output: .bake-cache/lidar-grid.bin (not committed — ~90 MB), consumed
 * by scripts/bake-metro.mjs which measures a robust per-footprint height
 * (median for houses, P90 for large/tall structures) and bakes it into
 * the building tiles as the top-priority height source.
 *
 * NOTE: this collection has no per-building classification (class 6),
 * so heights come from DSM−ground within each footprint. Vegetation
 * overhang is damped by using the median for small footprints.
 */
import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Las } from 'copc';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CACHE = resolve(ROOT, '.bake-cache');
const LAZ_CACHE = resolve(CACHE, 'lidar');
mkdirSync(LAZ_CACHE, { recursive: true });

const EPT_BASE =
  'https://s3-us-west-2.amazonaws.com/usgs-lidar-public/USGS_LPC_OK_Woodward_UTM15_B6_2016_LAS_2019';

// must match src/geo/projection.ts
const ORIGIN = { lat: 36.154, lon: -95.9928 };
const M_LAT = 111319.5;
const M_LON = 111319.5 * Math.cos((ORIGIN.lat * Math.PI) / 180);

// raster region (local meters) + resolution
const REGION = 6000; // ±6 km inset
const CORE = 2200; // ±2.2 km: walk one octree level deeper
const RES = 2; // m/cell
const W = (REGION * 2) / RES;

// web mercator helpers
const R_MERC = 20037508.342789244;
const llToMerc = (lon, lat) => [
  (lon * R_MERC) / 180,
  (Math.log(Math.tan(((90 + lat) * Math.PI) / 360)) / (Math.PI / 180)) * (R_MERC / 180),
];
const mercToLL = (mx, my) => [
  (mx / R_MERC) * 180,
  (Math.atan(Math.sinh((my / R_MERC) * Math.PI)) * 180) / Math.PI,
];
const llToLocal = (lon, lat) => [(lon - ORIGIN.lon) * M_LON, -(lat - ORIGIN.lat) * M_LAT];
const localToLL = (x, z) => [ORIGIN.lon + x / M_LON, ORIGIN.lat - z / M_LAT];

async function fetchRetry(url, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url);
      if (res.ok) return res;
      if (res.status === 404) return null; // sparse octree: missing node is fine
      console.warn(`  attempt ${i + 1}: HTTP ${res.status} ${url}`);
    } catch (err) {
      console.warn(`  attempt ${i + 1}: ${err.message}`);
    }
    await new Promise((r) => setTimeout(r, 3000 * (i + 1)));
  }
  throw new Error(`fetch failed: ${url}`);
}

async function main() {
  console.log('Lidar bake: USGS 3DEP EPT → DSM/ground rasters');
  const ept = await (await fetchRetry(`${EPT_BASE}/ept.json`)).json();
  const B = ept.bounds; // cube, EPSG:3857
  const cube = B[3] - B[0];

  // region of interest in mercator
  const [wLL, sLL] = localToLL(-REGION, REGION);
  const [eLL, nLL] = localToLL(REGION, -REGION);
  const [minMX, minMY] = llToMerc(wLL, sLL);
  const [maxMX, maxMY] = llToMerc(eLL, nLL);
  const [cMinMX, cMinMY] = llToMerc(...localToLL(-CORE, CORE));
  const [cMaxMX, cMaxMY] = llToMerc(...localToLL(CORE, -CORE));

  const nodeBox = (d, x, y) => {
    const s = cube / 2 ** d;
    return [B[0] + x * s, B[1] + y * s, B[0] + (x + 1) * s, B[1] + (y + 1) * s];
  };
  const intersects = (a, b) => a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1];

  // ── walk hierarchy, collecting node keys to depth 8 (9 in core) ──
  const wanted = [];
  const hierCache = new Map();
  async function hierarchy(key) {
    if (hierCache.has(key)) return hierCache.get(key);
    const path = resolve(LAZ_CACHE, `h-${key}.json`);
    let data;
    if (existsSync(path)) data = JSON.parse(readFileSync(path, 'utf8'));
    else {
      const res = await fetchRetry(`${EPT_BASE}/ept-hierarchy/${key}.json`);
      data = res ? await res.json() : {};
      writeFileSync(path, JSON.stringify(data));
    }
    hierCache.set(key, data);
    return data;
  }

  async function walk(key, table) {
    const count = table[key];
    if (count === undefined || count === 0) return;
    const [d, x, y] = key.split('-').map(Number);
    const box = nodeBox(d, x, y);
    const roi = [minMX, minMY, maxMX, maxMY];
    if (!intersects(box, roi)) return;
    const inCore = intersects(box, [cMinMX, cMinMY, cMaxMX, cMaxMY]);
    const maxDepth = inCore ? 9 : 8;
    if (d > maxDepth) return;
    if (count === -1) {
      const sub = await hierarchy(key);
      return walk(key, sub);
    }
    wanted.push(key);
    if (d === maxDepth) return;
    // children: 2x2x2
    for (let dx = 0; dx <= 1; dx++)
      for (let dy = 0; dy <= 1; dy++)
        for (let dz = 0; dz <= 1; dz++) {
          const [, , , z] = key.split('-').map(Number);
          const child = `${d + 1}-${x * 2 + dx}-${y * 2 + dy}-${z * 2 + dz}`;
          await walk(child, table);
        }
  }

  const root = await hierarchy('0-0-0-0');
  await walk('0-0-0-0', root);
  console.log(`  ${wanted.length} EPT nodes intersect the ±${REGION / 1000} km region`);

  // ── rasters ──
  const dsm = new Float32Array(W * W).fill(-9999);
  const gnd = new Float32Array(W * W).fill(9999);
  let totalPts = 0, usedPts = 0;

  async function processNode(key) {
    const path = resolve(LAZ_CACHE, `${key}.laz`);
    let buf;
    if (existsSync(path)) buf = new Uint8Array(readFileSync(path));
    else {
      const res = await fetchRetry(`${EPT_BASE}/ept-data/${key}.laz`);
      if (!res) return;
      buf = new Uint8Array(await res.arrayBuffer());
      writeFileSync(path, buf);
    }
    let view;
    try {
      const header = Las.Header.parse(buf);
      const pointData = await Las.PointData.decompressFile(buf);
      view = Las.View.create(pointData, header);
    } catch (err) {
      console.warn(`  decode failed ${key}: ${err.message}`);
      return;
    }
    const gX = view.getter('X'), gY = view.getter('Y'), gZ = view.getter('Z');
    const gC = view.getter('Classification');
    for (let i = 0; i < view.pointCount; i++) {
      totalPts++;
      const cls = gC(i);
      // keep class 18 ("high noise"): this collection flags tall-building
      // roof returns as high noise (BOK Tower's crown lives there); real
      // atmospheric noise is damped later by per-footprint percentiles
      if (cls === 7) continue; // low noise
      const [lon, lat] = mercToLL(gX(i), gY(i));
      const [x, z] = llToLocal(lon, lat);
      const c = Math.floor((x + REGION) / RES);
      const r = Math.floor((z + REGION) / RES);
      if (c < 0 || c >= W || r < 0 || r >= W) continue;
      const zi = gZ(i);
      if (zi < 100 || zi > 600) continue; // NAVD88 sanity for Tulsa
      const idx = r * W + c;
      usedPts++;
      if (cls === 2) {
        if (zi < gnd[idx]) gnd[idx] = zi;
      } else if (zi > dsm[idx]) {
        dsm[idx] = zi;
      }
    }
  }

  // modest parallelism — S3 is happy with this, decode is the bottleneck
  const CONC = 8;
  let done = 0;
  const queue = [...wanted];
  await Promise.all(
    Array.from({ length: CONC }, async () => {
      while (queue.length) {
        const key = queue.pop();
        await processNode(key);
        done++;
        if (done % 100 === 0) console.log(`  ${done}/${wanted.length} nodes (${(usedPts / 1e6).toFixed(1)}M pts in region)`);
      }
    }),
  );
  console.log(`  points: ${(totalPts / 1e6).toFixed(1)}M read, ${(usedPts / 1e6).toFixed(1)}M in region`);

  // ── write: header + two Float32 rasters ──
  const header = Buffer.alloc(24);
  header.writeFloatLE(-REGION, 0); // minX
  header.writeFloatLE(-REGION, 4); // minZ
  header.writeFloatLE(RES, 8);
  header.writeUInt32LE(W, 12);
  header.writeUInt32LE(W, 16);
  header.writeUInt32LE(0, 20); // reserved
  writeFileSync(
    resolve(CACHE, 'lidar-grid.bin'),
    Buffer.concat([header, Buffer.from(dsm.buffer), Buffer.from(gnd.buffer)]),
  );
  const covered = dsm.reduce((n, v) => n + (v > -9999 ? 1 : 0), 0);
  console.log(
    `  wrote lidar-grid.bin — ${W}×${W} @ ${RES} m, DSM coverage ${((covered / (W * W)) * 100).toFixed(1)}%`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
