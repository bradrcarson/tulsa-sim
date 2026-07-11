/**
 * Phase 3 bake pipeline — full Tulsa metro at real fidelity.
 *
 *   node scripts/bake-metro.mjs buildings   # MS ML footprints+heights, OSM overrides, landuse → binary tiles
 *   node scripts/bake-metro.mjs streets     # OSM metro highways → binary tiles + major-roads overlay
 *   node scripts/bake-metro.mjs terrain     # USGS 3DEP DEM → heightfield binary
 *   node scripts/bake-metro.mjs all
 *
 * Outputs (all committed, total ~12 MB):
 *   public/data/manifest.json      tile grid params + tile index
 *   public/data/tiles/b_X_Z.bin    buildings per 2 km tile (see FORMAT below)
 *   public/data/tiles/s_X_Z.bin    streets per tile
 *   public/data/streets-major.bin  metro-wide motorway/trunk/primary/secondary
 *   public/data/terrain.bin        Int16 decimeter heightfield
 *
 * FORMAT b_*.bin (little-endian):
 *   u32 count, then per building:
 *     u8 vertCount, u8 landuse(0..5), u16 height_dm,
 *     vertCount × (i16 dx_dm, i16 dz_dm)   — relative to tile min corner
 * FORMAT s_*.bin / streets-major.bin:
 *   u32 count, then per way: u8 class, u16 vertCount, verts as above
 *   (streets-major.bin verts are absolute local meters × 10 as i32)
 * FORMAT terrain.bin:
 *   f64 minX, f64 minZ, f64 dx, f64 dz, u32 w, u32 h, then w*h i16 (dm, NAVD88)
 */
import { createReadStream, writeFileSync, mkdirSync, existsSync, readFileSync, readdirSync, unlinkSync } from 'node:fs';
import { createGunzip } from 'node:zlib';
import { createInterface } from 'node:readline';
import { Readable } from 'node:stream';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = resolve(ROOT, 'public/data');
const TILES = resolve(OUT, 'tiles');
const CACHE = resolve(ROOT, '.bake-cache');
mkdirSync(TILES, { recursive: true });
mkdirSync(CACHE, { recursive: true });

// ── geo constants (must match src/geo/projection.ts) ─────────
const ORIGIN = { lat: 36.154, lon: -95.9928 };
const M_LAT = 111319.5;
const M_LON = 111319.5 * Math.cos((ORIGIN.lat * Math.PI) / 180);
const METRO = { w: -96.15, s: 36.02, e: -95.75, n: 36.25 }; // full metro bbox
const TILE = 2000; // meters

const llToLocal = (lon, lat) => [(lon - ORIGIN.lon) * M_LON, -(lat - ORIGIN.lat) * M_LAT];

async function fetchRetry(url, init, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, init);
      if (res.ok) return res;
      console.warn(`  attempt ${i + 1}: HTTP ${res.status}`);
    } catch (err) {
      console.warn(`  attempt ${i + 1}:`, err.message);
    }
    await new Promise((r) => setTimeout(r, 4000 * (i + 1)));
  }
  throw new Error(`fetch failed: ${url}`);
}

async function cachedFetch(url, name) {
  const path = resolve(CACHE, name);
  if (existsSync(path)) {
    console.log(`  cache hit: ${name}`);
    return path;
  }
  console.log(`  downloading ${name}…`);
  const res = await fetchRetry(url);
  const buf = Buffer.from(await res.arrayBuffer());
  writeFileSync(path, buf);
  return path;
}

// ── geometry helpers ─────────────────────────────────────────
function simplify(pts, tol) {
  if (pts.length <= 4) return pts;
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    let maxD = 0, idx = -1;
    const [ax, ay] = pts[a];
    const dx = pts[b][0] - ax, dy = pts[b][1] - ay;
    const len2 = dx * dx + dy * dy || 1e-9;
    for (let i = a + 1; i < b; i++) {
      const t = Math.max(0, Math.min(1, ((pts[i][0] - ax) * dx + (pts[i][1] - ay) * dy) / len2));
      const d = Math.hypot(pts[i][0] - (ax + t * dx), pts[i][1] - (ay + t * dy));
      if (d > maxD) { maxD = d; idx = i; }
    }
    if (maxD > tol) { keep[idx] = 1; stack.push([a, idx], [idx, b]); }
  }
  return pts.filter((_, i) => keep[i]);
}

const ringArea = (pts) => {
  let a = 0;
  for (let i = 0; i < pts.length - 1; i++) a += pts[i][0] * pts[i + 1][1] - pts[i + 1][0] * pts[i][1];
  return a / 2; // signed, in (x,z) space
};

function pointInRing(x, z, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, zi] = ring[i], [xj, zj] = ring[j];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

// ── quadkey math (Bing tile scheme, level 9) ─────────────────
function quadkey(lon, lat, z = 9) {
  const n = 2 ** z;
  const x = Math.floor(((lon + 180) / 360) * n);
  const rad = (lat * Math.PI) / 180;
  const y = Math.floor(((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * n);
  let key = '';
  for (let i = z - 1; i >= 0; i--) key += String(((y >> i) & 1) << 1 | ((x >> i) & 1));
  return key;
}

// ── Overpass ─────────────────────────────────────────────────
const OVERPASS_HEADERS = {
  'Content-Type': 'application/x-www-form-urlencoded',
  'User-Agent': 'tulsa-sim-bake/0.3 (educational digital twin)',
};
async function overpass(query, cacheName) {
  const path = resolve(CACHE, cacheName);
  if (existsSync(path)) {
    console.log(`  cache hit: ${cacheName}`);
    return JSON.parse(readFileSync(path, 'utf8'));
  }
  console.log(`  overpass: ${cacheName}…`);
  const res = await fetchRetry('https://overpass-api.de/api/interpreter', {
    method: 'POST',
    headers: OVERPASS_HEADERS,
    body: 'data=' + encodeURIComponent(query),
  });
  const data = await res.json();
  writeFileSync(path, JSON.stringify(data));
  return data;
}

// ── landuse grid (for building tint + roof style) ────────────
// codes: 0 unknown, 1 residential, 2 commercial/retail, 3 industrial, 4 green, 5 water
const LU_CELL = 100; // meters
async function buildLanduseGrid() {
  const { s, w, n, e } = METRO;
  const data = await overpass(
    `[out:json][timeout:300];(
      way["landuse"~"^(residential|commercial|retail|industrial|railway|grass|meadow|forest|cemetery|recreation_ground)$"](${s},${w},${n},${e});
      way["leisure"~"^(park|golf_course|pitch|garden|nature_reserve)$"](${s},${w},${n},${e});
      way["natural"="water"](${s},${w},${n},${e});
    );out geom;`,
    'landuse.json',
  );
  const CODE = (tags) => {
    if (tags.natural === 'water') return 5;
    if (tags.leisure || ['grass', 'meadow', 'forest', 'cemetery', 'recreation_ground'].includes(tags.landuse)) return 4;
    if (tags.landuse === 'residential') return 1;
    if (tags.landuse === 'commercial' || tags.landuse === 'retail') return 2;
    if (tags.landuse === 'industrial' || tags.landuse === 'railway') return 3;
    return 0;
  };
  // grid extent in local meters
  const [minX, maxZ] = llToLocal(METRO.w, METRO.s);
  const [maxX, minZ] = llToLocal(METRO.e, METRO.n);
  const W = Math.ceil((maxX - minX) / LU_CELL);
  const H = Math.ceil((maxZ - minZ) / LU_CELL);
  const grid = new Uint8Array(W * H);

  let polys = 0;
  for (const el of data.elements) {
    if (!el.geometry || el.geometry.length < 4) continue;
    const code = CODE(el.tags ?? {});
    if (!code) continue;
    const ring = el.geometry.map((g) => llToLocal(g.lon, g.lat));
    let rMinX = Infinity, rMaxX = -Infinity, rMinZ = Infinity, rMaxZ = -Infinity;
    for (const [x, z] of ring) {
      if (x < rMinX) rMinX = x;
      if (x > rMaxX) rMaxX = x;
      if (z < rMinZ) rMinZ = z;
      if (z > rMaxZ) rMaxZ = z;
    }
    const c0 = Math.max(0, Math.floor((rMinX - minX) / LU_CELL));
    const c1 = Math.min(W - 1, Math.floor((rMaxX - minX) / LU_CELL));
    const r0 = Math.max(0, Math.floor((rMinZ - minZ) / LU_CELL));
    const r1 = Math.min(H - 1, Math.floor((rMaxZ - minZ) / LU_CELL));
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        const cx = minX + (c + 0.5) * LU_CELL;
        const cz = minZ + (r + 0.5) * LU_CELL;
        if (pointInRing(cx, cz, ring)) grid[r * W + c] = code;
      }
    }
    polys++;
  }
  console.log(`  landuse: ${polys} polygons rasterized to ${W}×${H} grid`);
  return { grid, minX, minZ, W, H };
}

// ── OSM buildings metro-wide (fetched in quadrants; cached) ──
async function fetchOsmBuildings() {
  const midLat = (METRO.s + METRO.n) / 2;
  const midLon = (METRO.w + METRO.e) / 2;
  const quads = [
    [METRO.s, METRO.w, midLat, midLon],
    [METRO.s, midLon, midLat, METRO.e],
    [midLat, METRO.w, METRO.n, midLon],
    [midLat, midLon, METRO.n, METRO.e],
  ];
  const elements = [];
  for (let i = 0; i < quads.length; i++) {
    const [s, w, n, e] = quads[i];
    const data = await overpass(
      `[out:json][timeout:600];(way["building"](${s},${w},${n},${e}););out geom;`,
      `osm-buildings-q${i}.json`,
    );
    elements.push(...data.elements);
  }
  // de-dupe ways that straddle quadrant seams
  const seen = new Set();
  return elements.filter((el) => (seen.has(el.id) ? false : (seen.add(el.id), true)));
}

function parseOsmHeight(tags = {}) {
  if (tags.height) {
    const h = parseFloat(String(tags.height).replace(/m$/i, ''));
    if (h > 0 && h < 340) return h;
  }
  if (tags['building:levels']) {
    const lv = parseFloat(tags['building:levels']);
    if (lv > 0 && lv < 110) return lv * 3.2;
  }
  return -1;
}

// ── lidar heights (optional; produced by scripts/bake-lidar.mjs) ──
// DSM/ground rasters over the ±6 km inner city. Heights measured from
// lidar beat every other source where enough returns hit the footprint.
function loadLidarGrid() {
  const path = resolve(CACHE, 'lidar-grid.bin');
  if (!existsSync(path)) {
    console.log('  (no lidar-grid.bin — run scripts/bake-lidar.mjs for measured heights)');
    return null;
  }
  const buf = readFileSync(path);
  const minX = buf.readFloatLE(0);
  const minZ = buf.readFloatLE(4);
  const res = buf.readFloatLE(8);
  const w = buf.readUInt32LE(12);
  const h = buf.readUInt32LE(16);
  const dsm = new Float32Array(buf.buffer, buf.byteOffset + 24, w * h);
  console.log(`  lidar grid: ${w}×${h} @ ${res} m`);
  return { minX, minZ, res, w, h, dsm };
}

function loadTerrainGrid() {
  const path = resolve(OUT, 'terrain.bin');
  if (!existsSync(path)) return null;
  const buf = readFileSync(path);
  const minX = buf.readDoubleLE(0);
  const minZ = buf.readDoubleLE(8);
  const dx = buf.readDoubleLE(16);
  const dz = buf.readDoubleLE(24);
  const w = buf.readUInt32LE(32);
  const h = buf.readUInt32LE(36);
  const data = new Int16Array(buf.buffer, buf.byteOffset + 40, w * h);
  return {
    at(x, z) {
      const c = Math.max(0, Math.min(w - 1, Math.round((x - minX) / dx)));
      const r = Math.max(0, Math.min(h - 1, Math.round((z - minZ) / dz)));
      return data[r * w + c] / 10;
    },
  };
}

/**
 * Measured height for one footprint: percentile of DSM cells inside the
 * ring minus the DEM base (same terrain surface the runtime stands
 * buildings on). Median for small footprints damps tree overhang; P90
 * for big/complex structures catches the tower core instead of podium
 * edges. Returns -1 when the footprint has too few lidar returns.
 */
function lidarHeightFor(lidar, dem, ring, bbox, area, holes) {
  if (!lidar || !dem) return -1;
  const [minX, minZ, maxX, maxZ] = bbox;
  if (minX < lidar.minX || minZ < lidar.minZ) return -1;
  if (maxX > lidar.minX + lidar.w * lidar.res || maxZ > lidar.minZ + lidar.h * lidar.res) return -1;
  const samples = [];
  const step = area > 20000 ? lidar.res * 2 : lidar.res;
  outer: for (let z = minZ; z <= maxZ; z += step) {
    for (let x = minX; x <= maxX; x += step) {
      if (!pointInRing(x, z, ring)) continue;
      // skip cells belonging to a separate building nested inside this
      // footprint (block-wide podium polygons must not inherit the height
      // of the tower that stands on them)
      if (holes) {
        let masked = false;
        for (const h2 of holes) {
          if (pointInRing(x, z, h2)) { masked = true; break; }
        }
        if (masked) continue;
      }
      const c = Math.floor((x - lidar.minX) / lidar.res);
      const r = Math.floor((z - lidar.minZ) / lidar.res);
      const v = lidar.dsm[r * lidar.w + c];
      if (v > -9999) samples.push(v);
      if (samples.length > 60000) break outer; // plenty for percentiles
    }
  }
  if (samples.length < 5) return -1;
  samples.sort((a, b) => a - b);
  const base = dem.at((minX + maxX) / 2, (minZ + maxZ) / 2);
  const n = samples.length;
  const p50 = samples[Math.floor(n * 0.5)] - base;
  if (area <= 700) {
    // houses / small commercial: median damps tree overhang + noise.
    // Small footprints reading very tall are masts/chimneys/water towers,
    // not buildings — reject and let other sources decide.
    if (p50 > 60) return -1;
    return p50 >= 2.2 && p50 < 340 ? p50 : -1;
  }
  // large footprints (often a whole block containing a tower + podium):
  // take the highest *flat plateau* — a 4 m height band holding enough
  // cells to be a real roof (~100 m²). Masts, antennas, and lidar noise
  // clouds (e.g. power-plant plumes flagged class 18) are vertically
  // spread and never form a tight band with that much support.
  const minSupport = Math.max(25, Math.floor(n * 0.03));
  const BAND = 4; // meters
  const bins = new Map();
  for (const s of samples) {
    const b2 = Math.floor((s - base) / BAND);
    bins.set(b2, (bins.get(b2) ?? 0) + 1);
  }
  let h = p50;
  for (const [bin, count] of bins) {
    const bandH = (bin + 0.5) * BAND;
    if (bandH > h && count >= minSupport) h = bandH;
  }
  return h >= 2.2 && h < 340 ? h : -1;
}

// ── buildings ────────────────────────────────────────────────
async function bakeBuildings() {
  console.log('Buildings: hybrid OSM footprints + Microsoft ML gap fill');

  // 1. covering quadkeys (metro fits one L9 tile but handle the general case)
  const keys = new Set();
  for (const lon of [METRO.w, METRO.e])
    for (const lat of [METRO.s, METRO.n]) keys.add(quadkey(lon, lat));
  console.log('  quadkeys:', [...keys].join(', '));

  const linksPath = await cachedFetch(
    'https://minedbuildings.z5.web.core.windows.net/global-buildings/dataset-links.csv',
    'dataset-links.csv',
  );
  const links = readFileSync(linksPath, 'utf8').split('\n');
  const urls = [];
  for (const key of keys) {
    const row = links.find((l) => l.startsWith(`UnitedStates,${key},`));
    if (row) urls.push(row.split(',')[2]);
    else console.warn(`  WARNING: no MS data for quadkey ${key}`);
  }

  // 2. stream-parse MS GeoJSONL, filter to metro bbox
  const withMeta = (b) => {
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const [x, z] of b.ring) {
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (z < minZ) minZ = z;
      if (z > maxZ) maxZ = z;
    }
    b.bbox = [minX, minZ, maxX, maxZ];
    b.cx = (minX + maxX) / 2;
    b.cz = (minZ + maxZ) / 2;
    return b;
  };

  const msList = [];
  for (const url of urls) {
    const gzPath = await cachedFetch(url, 'ms-' + url.split('quadkey=')[1].split('/')[0] + '.csv.gz');
    const rl = createInterface({ input: createReadStream(gzPath).pipe(createGunzip()), crlfDelay: Infinity });
    let kept = 0, total = 0;
    for await (const line of rl) {
      if (!line.trim()) continue;
      total++;
      let feat;
      try { feat = JSON.parse(line); } catch { continue; }
      const coords = feat.geometry?.coordinates?.[0];
      if (!coords || coords.length < 4) continue;
      const [lon0, lat0] = coords[0];
      if (lon0 < METRO.w || lon0 > METRO.e || lat0 < METRO.s || lat0 > METRO.n) continue;
      const ring = coords.map(([lon, lat]) => llToLocal(lon, lat));
      let h = feat.properties?.height ?? -1;
      if (!(h > 0)) h = -1;
      msList.push(withMeta({ ring, h: h > 0 ? Math.min(h, 330) : -1 }));
      kept++;
    }
    console.log(`  MS: ${kept} / ${total} footprints inside metro bbox`);
  }

  // 3. OSM footprints are the primary source (architectural outlines beat
  //    ML blobs, esp. downtown); MS supplies ML heights + gap fill
  const osmEls = await fetchOsmBuildings();
  const osmList = [];
  for (const el of osmEls) {
    if (!el.geometry || el.geometry.length < 4) continue;
    const ring = el.geometry.map((g) => llToLocal(g.lon, g.lat));
    osmList.push(withMeta({ ring, h: parseOsmHeight(el.tags), tagged: parseOsmHeight(el.tags) > 0 }));
  }
  console.log(`  OSM: ${osmList.length} footprints (${osmList.filter((b) => b.tagged).length} height-tagged)`);

  // spatial hash of OSM bboxes (100 m cells)
  const CELL = 100;
  const oHash = new Map();
  for (const b of osmList) {
    for (let cx = Math.floor(b.bbox[0] / CELL); cx <= Math.floor(b.bbox[2] / CELL); cx++) {
      for (let cz = Math.floor(b.bbox[1] / CELL); cz <= Math.floor(b.bbox[3] / CELL); cz++) {
        const key = cx + ':' + cz;
        (oHash.get(key) ?? oHash.set(key, []).get(key)).push(b);
      }
    }
  }

  const bboxIoU = (a, b) => {
    const ix = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0]));
    const iz = Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
    const inter = ix * iz;
    const areaA = (a[2] - a[0]) * (a[3] - a[1]);
    const areaB = (b[2] - b[0]) * (b[3] - b[1]);
    return inter / (areaA + areaB - inter || 1);
  };

  // classify each MS footprint: duplicate of OSM (transfer height) or gap fill
  const gapFill = [];
  let transferred = 0;
  for (const ms of msList) {
    const key = Math.floor(ms.cx / CELL) + ':' + Math.floor(ms.cz / CELL);
    let match = null;
    for (const osm of oHash.get(key) ?? []) {
      if (
        pointInRing(ms.cx, ms.cz, osm.ring) ||
        pointInRing(osm.cx, osm.cz, ms.ring) ||
        bboxIoU(ms.bbox, osm.bbox) > 0.35
      ) {
        match = osm;
        break;
      }
    }
    if (match) {
      // ML height estimate for an untagged OSM footprint
      if (!match.tagged && ms.h > 0 && ms.h > (match.msH ?? -1)) {
        match.msH = ms.h;
        transferred++;
      }
    } else {
      gapFill.push(ms);
    }
  }
  for (const b of osmList) {
    if (!b.tagged && b.msH > 0) b.h = b.msH;
  }
  console.log(`  ${transferred} OSM footprints got ML heights; ${gapFill.length} MS gap-fill buildings`);
  const buildings = [...osmList, ...gapFill];

  // 4. landuse code per building (centroid lookup)
  const lu = await buildLanduseGrid();
  for (const b of buildings) {
    const cx = (b.bbox[0] + b.bbox[2]) / 2;
    const cz = (b.bbox[1] + b.bbox[3]) / 2;
    const c = Math.floor((cx - lu.minX) / LU_CELL);
    const r = Math.floor((cz - lu.minZ) / LU_CELL);
    b.lu = c >= 0 && c < lu.W && r >= 0 && r < lu.H ? lu.grid[r * lu.W + c] : 0;
  }

  // 5a. lidar-measured heights (top priority where the rasters cover)
  const lidar = loadLidarGrid();
  const dem = loadTerrainGrid();
  if (lidar && dem) {
    // spatial hash of centroids so big block polygons can mask out nested
    // buildings (a plaza polygon must not inherit its tower's height)
    const cHash = new Map();
    for (const b of buildings) {
      const key = Math.floor(b.cx / CELL) + ':' + Math.floor(b.cz / CELL);
      (cHash.get(key) ?? cHash.set(key, []).get(key)).push(b);
    }
    const holesFor = (b, area) => {
      if (area < 2500) return null;
      const holes = [];
      for (let cx = Math.floor(b.bbox[0] / CELL); cx <= Math.floor(b.bbox[2] / CELL); cx++) {
        for (let cz = Math.floor(b.bbox[1] / CELL); cz <= Math.floor(b.bbox[3] / CELL); cz++) {
          for (const o of cHash.get(cx + ':' + cz) ?? []) {
            if (o !== b && pointInRing(o.cx, o.cz, b.ring)) holes.push(o.ring);
          }
        }
      }
      return holes.length ? holes : null;
    };
    let measured = 0, keptTag = 0;
    for (const b of buildings) {
      const area = Math.abs(ringArea([...b.ring, b.ring[0]]));
      const lh = lidarHeightFor(lidar, dem, b.ring, b.bbox, area, holesFor(b, area));
      if (lh < 0) continue;
      // surveyed OSM tags are never lowered by lidar (sparse returns can
      // miss a roof); lidar wins only when it measures clearly taller
      // (stale tags / level-count guesses)
      if (b.tagged && b.h > 0 && lh < b.h * 1.25) {
        keptTag++;
        continue;
      }
      b.h = lh;
      b.lidar = true;
      measured++;
    }
    console.log(`  lidar heights: ${measured} measured, ${keptTag} agreeing OSM tags kept`);
  }

  // 5b. resolve unknown heights: seeded 3.5–8 m (residential scale)
  const hash01 = (x, y) => {
    const s2 = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
    return s2 - Math.floor(s2);
  };
  for (const b of buildings) {
    if (b.h < 0) b.h = 3.5 + hash01(b.ring[0][0], b.ring[0][1]) * 4.5;
  }

  // 6. simplify + quantize + write tiles
  for (const f of readdirSync(TILES)) if (f.startsWith('b_')) unlinkSync(resolve(TILES, f));
  const tiles = new Map();
  let written = 0, dropped = 0;
  for (const b of buildings) {
    let ring = simplify(b.ring, 0.9);
    // drop closing dup for storage
    const [fx, fz] = ring[0];
    const [lx, lz] = ring[ring.length - 1];
    if (fx === lx && fz === lz) ring = ring.slice(0, -1);
    if (ring.length < 3 || ring.length > 255) { dropped++; continue; }
    const area = Math.abs(ringArea([...ring, ring[0]]));
    if (area < 12) { dropped++; continue; }
    // enforce consistent winding: signed area in (x,z) negative (CCW seen from +Y)
    if (ringArea([...ring, ring[0]]) > 0) ring.reverse();

    const cx = (b.bbox[0] + b.bbox[2]) / 2;
    const cz = (b.bbox[1] + b.bbox[3]) / 2;
    const tx = Math.floor(cx / TILE);
    const tz = Math.floor(cz / TILE);
    const key = tx + '_' + tz;
    let tile = tiles.get(key);
    if (!tile) { tile = { tx, tz, recs: [] }; tiles.set(key, tile); }
    tile.recs.push({ ring, h: b.h, lu: b.lu ?? 0, area });
    written++;
  }

  const index = [];
  for (const tile of tiles.values()) {
    let bytes = 4;
    for (const r of tile.recs) bytes += 4 + r.ring.length * 4;
    const buf = Buffer.alloc(bytes);
    let off = buf.writeUInt32LE(tile.recs.length, 0);
    const ox = tile.tx * TILE, oz = tile.tz * TILE;
    for (const r of tile.recs) {
      off = buf.writeUInt8(r.ring.length, off);
      off = buf.writeUInt8(r.lu, off);
      off = buf.writeUInt16LE(Math.min(65535, Math.round(r.h * 10)), off);
      for (const [x, z] of r.ring) {
        off = buf.writeInt16LE(clampI16(Math.round((x - ox) * 10)), off);
        off = buf.writeInt16LE(clampI16(Math.round((z - oz) * 10)), off);
      }
    }
    writeFileSync(resolve(TILES, `b_${tile.tx}_${tile.tz}.bin`), buf);
    index.push({ k: `${tile.tx}_${tile.tz}`, n: tile.recs.length });
  }
  console.log(`  wrote ${written} buildings (${dropped} dropped) across ${tiles.size} tiles`);
  updateManifest({ buildingTiles: index });
}

const clampI16 = (v) => Math.max(-32768, Math.min(32767, v));

// ── streets ──────────────────────────────────────────────────
const CLASS_ID = {
  motorway: 0, motorway_link: 1, trunk: 2, trunk_link: 3, primary: 4, primary_link: 5,
  secondary: 6, secondary_link: 7, tertiary: 8, tertiary_link: 8, residential: 9,
  unclassified: 10, service: 11,
};
async function bakeStreets() {
  console.log('Streets: OSM metro highway network');
  const { s, w, n, e } = METRO;
  const data = await overpass(
    `[out:json][timeout:400];(
      way["highway"~"^(motorway|motorway_link|trunk|trunk_link|primary|primary_link|secondary|secondary_link|tertiary|tertiary_link|residential|unclassified)$"](${s},${w},${n},${e});
    );out geom;`,
    'osm-metro-streets.json',
  );
  console.log(`  ${data.elements.length} ways`);

  for (const f of readdirSync(TILES)) if (f.startsWith('s_')) unlinkSync(resolve(TILES, f));
  const tiles = new Map();
  const major = []; // separate metro-wide overlay for far LOD
  let pieces = 0;

  for (const el of data.elements) {
    const cls = CLASS_ID[el.tags?.highway];
    if (cls === undefined || !el.geometry || el.geometry.length < 2) continue;
    let line = el.geometry.map((g) => llToLocal(g.lon, g.lat));
    line = simplify(line, 2.0);
    if (line.length < 2) continue;
    if (cls <= 6) major.push({ cls, line });

    // split polyline at tile boundaries so every piece stays i16-quantizable
    let piece = [line[0]];
    let curTx = Math.floor(line[0][0] / TILE), curTz = Math.floor(line[0][1] / TILE);
    const flush = () => {
      if (piece.length < 2) return;
      const key = curTx + '_' + curTz;
      let tile = tiles.get(key);
      if (!tile) { tile = { tx: curTx, tz: curTz, ways: [] }; tiles.set(key, tile); }
      tile.ways.push({ cls, line: piece });
      pieces++;
    };
    for (let i = 1; i < line.length; i++) {
      const [x, z] = line[i];
      const tx = Math.floor(x / TILE), tz = Math.floor(z / TILE);
      if (tx === curTx && tz === curTz) {
        piece.push(line[i]);
      } else {
        piece.push(line[i]); // small overhang into neighbor tile is fine (±1.2 km margin in i16 dm)
        flush();
        piece = [line[i - 1], line[i]];
        curTx = tx; curTz = tz;
        // consume the rest in the new tile
      }
    }
    flush();
  }

  const index = [];
  for (const tile of tiles.values()) {
    let bytes = 4;
    for (const wy of tile.ways) bytes += 3 + wy.line.length * 4;
    const buf = Buffer.alloc(bytes);
    let off = buf.writeUInt32LE(tile.ways.length, 0);
    const ox = tile.tx * TILE, oz = tile.tz * TILE;
    for (const wy of tile.ways) {
      off = buf.writeUInt8(wy.cls, off);
      off = buf.writeUInt16LE(wy.line.length, off);
      for (const [x, z] of wy.line) {
        off = buf.writeInt16LE(clampI16(Math.round((x - ox) * 10)), off);
        off = buf.writeInt16LE(clampI16(Math.round((z - oz) * 10)), off);
      }
    }
    writeFileSync(resolve(TILES, `s_${tile.tx}_${tile.tz}.bin`), buf);
    index.push({ k: `${tile.tx}_${tile.tz}`, n: tile.ways.length });
  }

  // major overlay: absolute i32 dm coords, decimated harder
  let mBytes = 4;
  const majorSimple = major.map((m) => ({ cls: m.cls, line: simplify(m.line, 6) })).filter((m) => m.line.length >= 2);
  for (const m of majorSimple) mBytes += 3 + m.line.length * 8;
  const mbuf = Buffer.alloc(mBytes);
  let mOff = mbuf.writeUInt32LE(majorSimple.length, 0);
  for (const m of majorSimple) {
    mOff = mbuf.writeUInt8(m.cls, mOff);
    mOff = mbuf.writeUInt16LE(m.line.length, mOff);
    for (const [x, z] of m.line) {
      mOff = mbuf.writeInt32LE(Math.round(x * 10), mOff);
      mOff = mbuf.writeInt32LE(Math.round(z * 10), mOff);
    }
  }
  writeFileSync(resolve(OUT, 'streets-major.bin'), mbuf);
  console.log(`  wrote ${pieces} way pieces across ${tiles.size} tiles + ${majorSimple.length} major ways`);
  updateManifest({ streetTiles: index });
}

// ── terrain ──────────────────────────────────────────────────
async function bakeTerrain() {
  console.log('Terrain: USGS 3DEP DEM heightfield');
  const W = 720, H = 512;
  const url =
    'https://elevation.nationalmap.gov/arcgis/rest/services/3DEPElevation/ImageServer/exportImage' +
    `?bbox=${METRO.w},${METRO.s},${METRO.e},${METRO.n}&bboxSR=4326&imageSR=4326` +
    `&size=${W},${H}&format=tiff&pixelType=F32&noData=0&f=image`;
  const tifPath = await cachedFetch(url, 'dem-metro.tif');
  const { fromArrayBuffer } = await import('geotiff');
  const tiff = await fromArrayBuffer(readFileSync(tifPath).buffer.slice(0));
  const image = await tiff.getImage();
  const [raster] = await image.readRasters();
  console.log(`  raster ${image.getWidth()}×${image.getHeight()}`);

  // local-meter extent (x: west→east, z: north→south; row 0 = north)
  const [minX] = llToLocal(METRO.w, METRO.s);
  const [maxX] = llToLocal(METRO.e, METRO.s);
  const [, minZ] = llToLocal(METRO.w, METRO.n);
  const [, maxZ] = llToLocal(METRO.w, METRO.s);
  const dx = (maxX - minX) / (W - 1);
  const dz = (maxZ - minZ) / (H - 1);

  const buf = Buffer.alloc(8 * 4 + 4 * 2 + W * H * 2);
  let off = 0;
  off = buf.writeDoubleLE(minX, off);
  off = buf.writeDoubleLE(minZ, off);
  off = buf.writeDoubleLE(dx, off);
  off = buf.writeDoubleLE(dz, off);
  off = buf.writeUInt32LE(W, off);
  off = buf.writeUInt32LE(H, off);
  let min = Infinity, max = -Infinity;
  for (let i = 0; i < W * H; i++) {
    const v = raster[i];
    const m = Number.isFinite(v) && v > -100 ? v : 190; // fill nodata with river-level default
    if (m < min) min = m;
    if (m > max) max = m;
    off = buf.writeInt16LE(clampI16(Math.round(m * 10)), off);
  }
  writeFileSync(resolve(OUT, 'terrain.bin'), buf);
  console.log(`  wrote ${W}×${H} heightfield, elevation ${min.toFixed(0)}–${max.toFixed(0)} m`);
  updateManifest({ terrain: { w: W, h: H } });
}

// ── manifest ─────────────────────────────────────────────────
function updateManifest(patch) {
  const path = resolve(OUT, 'manifest.json');
  const cur = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {};
  const next = {
    tileSize: TILE,
    metroBbox: METRO,
    ...cur,
    ...patch,
    bakedAt: new Date().toISOString(),
  };
  writeFileSync(path, JSON.stringify(next));
}

// ── main ─────────────────────────────────────────────────────
const mode = process.argv[2] ?? 'all';
if (mode === 'terrain' || mode === 'all') await bakeTerrain();
if (mode === 'streets' || mode === 'all') await bakeStreets();
if (mode === 'buildings' || mode === 'all') await bakeBuildings();
console.log('done.');
