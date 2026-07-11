/**
 * Bake static data files into public/data/ for the expanded Phase 2 coverage.
 *
 *   node scripts/bake-data.mjs buildings   # Overpass buildings+streets → buildings.json / streets.json
 *   node scripts/bake-data.mjs transit     # GTFS static routes.txt → transit-routes.json
 *   node scripts/bake-data.mjs cameras     # OKtraffic camera snapshot → cameras.json
 *   node scripts/bake-data.mjs all
 *
 * Raw Overpass responses are NOT committed — geometries are simplified
 * (Douglas–Peucker) and quantized before writing (see AGENTS.md Phase 2 §5).
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = resolve(ROOT, 'public/data');
mkdirSync(OUT, { recursive: true });

// Phase 2 expanded bbox (south, west, north, east) — midtown + Cherry Street +
// Expo Square + edge of the metro, per AGENTS.md §5.
const BBOX = [36.1, -96.05, 36.2, -95.88];
// Tulsa metro bbox for camera filtering
const METRO = [36.02, -96.15, 36.25, -95.75];
const ORIGIN = { lat: 36.154, lon: -95.9928 };
const M_LAT = 111319.5;
const M_LON = 111319.5 * Math.cos((ORIGIN.lat * Math.PI) / 180);

const distFromOrigin = (lon, lat) =>
  Math.hypot((lon - ORIGIN.lon) * M_LON, (lat - ORIGIN.lat) * M_LAT);

async function fetchRetry(url, init, tries = 2) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, init);
      if (res.ok) return res;
      console.warn(`  attempt ${i + 1}: HTTP ${res.status}`);
    } catch (err) {
      console.warn(`  attempt ${i + 1}:`, err.message);
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  throw new Error(`fetch failed after ${tries} tries: ${url}`);
}

// ── geometry helpers ─────────────────────────────────────────
/** Douglas–Peucker simplification in local meters; tol in meters. */
function simplify(ring, tol) {
  if (ring.length <= 4) return ring;
  const pts = ring.map(([lon, lat]) => [
    (lon - ORIGIN.lon) * M_LON,
    (lat - ORIGIN.lat) * M_LAT,
  ]);
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    let maxD = 0;
    let idx = -1;
    const [ax, ay] = pts[a];
    const [bx, by] = pts[b];
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy || 1e-9;
    for (let i = a + 1; i < b; i++) {
      const t = Math.max(0, Math.min(1, ((pts[i][0] - ax) * dx + (pts[i][1] - ay) * dy) / len2));
      const d = Math.hypot(pts[i][0] - (ax + t * dx), pts[i][1] - (ay + t * dy));
      if (d > maxD) {
        maxD = d;
        idx = i;
      }
    }
    if (maxD > tol) {
      keep[idx] = 1;
      stack.push([a, idx], [idx, b]);
    }
  }
  return ring.filter((_, i) => keep[i]);
}

function ringAreaM2(ring) {
  let area = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    const x1 = (ring[i][0] - ORIGIN.lon) * M_LON;
    const y1 = (ring[i][1] - ORIGIN.lat) * M_LAT;
    const x2 = (ring[i + 1][0] - ORIGIN.lon) * M_LON;
    const y2 = (ring[i + 1][1] - ORIGIN.lat) * M_LAT;
    area += x1 * y2 - x2 * y1;
  }
  return Math.abs(area / 2);
}

const q5 = (v) => Math.round(v * 1e5) / 1e5; // ~1.1 m — fine for extrusions

function parseHeight(tags) {
  if (tags.height) {
    const h = parseFloat(String(tags.height).replace(/m$/i, ''));
    if (Number.isFinite(h) && h > 0) return Math.round(h * 10) / 10;
  }
  if (tags['building:levels']) {
    const lv = parseFloat(tags['building:levels']);
    if (Number.isFinite(lv) && lv > 0) return Math.round(lv * 3.2 * 10) / 10;
  }
  return undefined;
}

const OVERPASS_HEADERS = {
  'Content-Type': 'application/x-www-form-urlencoded',
  'User-Agent': 'tulsa-sim-bake/0.2 (github tulsa-sim; educational digital twin)',
};

// ── buildings + streets from Overpass ────────────────────────
async function bakeBuildings() {
  const [s, w, n, e] = BBOX;
  const query = `[out:json][timeout:300];(way["building"](${s},${w},${n},${e}););out geom;`;
  console.log('Overpass: fetching buildings for bbox', BBOX, '…');
  const res = await fetchRetry('https://overpass-api.de/api/interpreter', {
    method: 'POST',
    headers: OVERPASS_HEADERS,
    body: 'data=' + encodeURIComponent(query),
  });
  const data = await res.json();
  console.log('  raw ways:', data.elements.length);

  const out = [];
  let dropped = 0;
  for (const el of data.elements) {
    if (!el.geometry || el.geometry.length < 4) continue;
    let ring = el.geometry.map((g) => [g.lon, g.lat]);
    // ensure closed
    const first = ring[0];
    const last = ring[ring.length - 1];
    if (first[0] !== last[0] || first[1] !== last[1]) ring.push([...first]);

    const far = distFromOrigin(ring[0][0], ring[0][1]) > 2000;
    const area = ringAreaM2(ring);
    // LOD: beyond 2 km drop sheds/garages and simplify harder
    if (area < (far ? 55 : 15)) {
      dropped++;
      continue;
    }
    ring = simplify(ring, far ? 2.5 : 1.2);
    if (ring.length < 4) {
      dropped++;
      continue;
    }
    const rec = { c: ring.map(([lon, lat]) => [q5(lon), q5(lat)]) };
    const h = parseHeight(el.tags ?? {});
    if (h !== undefined) rec.h = h;
    if (el.tags?.name && !far) rec.n = el.tags.name;
    out.push(rec);
  }
  const path = resolve(OUT, 'buildings.json');
  writeFileSync(path, JSON.stringify(out));
  console.log(`  wrote ${out.length} buildings (${dropped} dropped) → ${path}`);
}

const HIGHWAY_KEEP = new Set([
  'motorway', 'motorway_link', 'trunk', 'trunk_link', 'primary', 'primary_link',
  'secondary', 'secondary_link', 'tertiary', 'tertiary_link', 'residential',
  'unclassified', 'service',
]);

async function bakeStreets() {
  const [s, w, n, e] = BBOX;
  const query = `[out:json][timeout:300];(way["highway"](${s},${w},${n},${e}););out geom;`;
  console.log('Overpass: fetching streets…');
  const res = await fetchRetry('https://overpass-api.de/api/interpreter', {
    method: 'POST',
    headers: OVERPASS_HEADERS,
    body: 'data=' + encodeURIComponent(query),
  });
  const data = await res.json();
  console.log('  raw ways:', data.elements.length);

  const out = [];
  for (const el of data.elements) {
    const t = el.tags?.highway;
    if (!t || !HIGHWAY_KEEP.has(t) || !el.geometry || el.geometry.length < 2) continue;
    let line = el.geometry.map((g) => [g.lon, g.lat]);
    line = simplify(line, 1.5);
    if (line.length < 2) continue;
    out.push({ c: line.map(([lon, lat]) => [q5(lon), q5(lat)]), t: t.replace('tertiary_link', 'tertiary') });
  }
  const path = resolve(OUT, 'streets.json');
  writeFileSync(path, JSON.stringify(out));
  console.log(`  wrote ${out.length} street segments → ${path}`);
}

// ── GTFS static: route id → short name / long name / color ──
async function bakeTransit() {
  console.log('GTFS static: downloading zip…');
  const res = await fetchRetry('https://tulsa.rideralerts.com/InfoPoint/GTFS-Zip.ashx');
  const buf = Buffer.from(await res.arrayBuffer());
  // minimal zip reader for the stored/deflated routes.txt entry
  const { inflateRawSync } = await import('node:zlib');
  const routesTxt = readZipEntry(buf, 'routes.txt', inflateRawSync);
  if (!routesTxt) throw new Error('routes.txt not found in GTFS zip');

  const lines = routesTxt.split(/\r?\n/).filter(Boolean);
  const header = splitCsv(lines[0]);
  const col = (name) => header.indexOf(name);
  const iId = col('route_id');
  const iShort = col('route_short_name');
  const iLong = col('route_long_name');
  const iColor = col('route_color');
  const routes = {};
  for (const line of lines.slice(1)) {
    const f = splitCsv(line);
    routes[f[iId]] = {
      short: f[iShort] || f[iId],
      long: f[iLong] || '',
      color: f[iColor] || '46b4ff',
    };
  }
  const path = resolve(OUT, 'transit-routes.json');
  writeFileSync(path, JSON.stringify(routes, null, 1));
  console.log(`  wrote ${Object.keys(routes).length} routes → ${path}`);
}

function splitCsv(line) {
  const out = [];
  let cur = '';
  let inQ = false;
  for (const ch of line) {
    if (ch === '"') inQ = !inQ;
    else if (ch === ',' && !inQ) {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

/** Extract one file from a zip buffer (central-directory-free, scans local headers). */
function readZipEntry(buf, wantName, inflateRawSync) {
  let off = 0;
  while (off < buf.length - 4) {
    if (buf.readUInt32LE(off) !== 0x04034b50) break;
    const method = buf.readUInt16LE(off + 8);
    const compSize = buf.readUInt32LE(off + 18);
    const nameLen = buf.readUInt16LE(off + 26);
    const extraLen = buf.readUInt16LE(off + 28);
    const name = buf.toString('utf8', off + 30, off + 30 + nameLen);
    const dataStart = off + 30 + nameLen + extraLen;
    if (name === wantName) {
      const raw = buf.subarray(dataStart, dataStart + compSize);
      return method === 8 ? inflateRawSync(raw).toString('utf8') : raw.toString('utf8');
    }
    off = dataStart + compSize;
  }
  return null;
}

// ── OKtraffic camera snapshot ────────────────────────────────
// Discovered via oktraffic.org bundle inspection: LoopBack REST API at
// https://oktraffic.org/api/MapCameras (no CORS — snapshot baked here; the
// dev server also proxies it for live status, see vite.config.ts).
async function bakeCameras() {
  console.log('OKtraffic: fetching camera list…');
  const res = await fetchRetry('https://oktraffic.org/api/MapCameras');
  const all = await res.json();
  const [s, w, n, e] = METRO;
  const out = all
    .filter((c) => {
      const la = +c.latitude;
      const lo = +c.longitude;
      return la > s && la < n && lo > w && lo < e;
    })
    .map((c) => ({
      id: c.id,
      lat: q5(+c.latitude),
      lon: q5(+c.longitude),
      loc: c.location,
      dir: c.direction || '',
    }));
  const path = resolve(OUT, 'cameras.json');
  writeFileSync(path, JSON.stringify(out));
  console.log(`  wrote ${out.length} Tulsa-metro cameras (of ${all.length} statewide) → ${path}`);
}

// ── main ─────────────────────────────────────────────────────
const mode = process.argv[2] ?? 'all';
if (mode === 'buildings' || mode === 'all') await bakeBuildings();
if (mode === 'buildings' || mode === 'streets' || mode === 'all') await bakeStreets();
if (mode === 'transit' || mode === 'all') await bakeTransit();
if (mode === 'cameras' || mode === 'all') await bakeCameras();
console.log('done.');
