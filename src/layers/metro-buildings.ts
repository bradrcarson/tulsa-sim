import * as THREE from 'three';
import { fetchWithRetry } from '../data/cache';
import { elevation } from '../geo/terrain';
import { createFacadeMaterial, setFacadeNight } from '../materials/facade';
import { tierForBbox, tierUV, sampleColor, type ImageryTier } from '../data/imagery';

/**
 * Tile-streamed metro buildings (Phase 3).
 *
 * Source: Microsoft ML footprints with per-building height estimates,
 * OSM-surveyed heights for tagged downtown towers, land-use codes from OSM
 * polygons — baked to compact binary tiles by scripts/bake-metro.mjs
 * (2 km grid, decimeter-quantized rings).
 *
 * LOD by distance from the camera target:
 *   LOD0 (<2.6 km):  full extrusion, facade window shader, hip roofs on houses
 *   LOD1 (<9 km):    extrusion ≥70 m², flat shading, no facades
 *   LOD2 (<26 km):   extrusion ≥220 m² only (big-box / schools / apartments)
 * Tiles rebuild asynchronously as the camera moves; far tiles are disposed.
 */
const TILE = 2000;
const LOD_DIST: [number, number, number] = [3200, 8000, 19000];
const LOD_MIN_AREA: [number, number, number] = [0, 90, 380];

interface TileRec {
  ring: Float32Array; // x0,z0,x1,z1… local meters (open ring)
  h: number;
  lu: number;
  area: number;
}

interface BuiltTile {
  lod: number;
  meshes: THREE.Mesh[];
}

// land-use palettes (base wall albedo; roofs derived darker)
const PAL = {
  residential: [new THREE.Color(0x8a7f72), new THREE.Color(0x7d746c), new THREE.Color(0x93867a)],
  commercial: [new THREE.Color(0x5d7186), new THREE.Color(0x66798c), new THREE.Color(0x536880)],
  industrial: [new THREE.Color(0x6e7276), new THREE.Color(0x63676c)],
  unknown: [new THREE.Color(0x736f6b), new THREE.Color(0x7b7672)],
};
// tower ramp: steel-blue curtain wall (desaturated so day mode reads as
// glass/limestone rather than placeholder blue; night keeps the cool cast)
const COLOR_MID = new THREE.Color(0x4a5a6e);
const COLOR_HIGH = new THREE.Color(0x8fb6cf);

function hash01(x: number, y: number): number {
  const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return s - Math.floor(s);
}

function wallColor(h: number, lu: number, rand: number): THREE.Color {
  // towers keep the signature blue glow ramp; low-rise gets land-use albedo
  if (h > 35) return COLOR_MID.clone().lerp(COLOR_HIGH, Math.min(1, (h - 35) / 60));
  const pick = <T,>(arr: T[]): T => arr[Math.floor(rand * arr.length) % arr.length];
  let base: THREE.Color;
  if (lu === 1) base = pick(PAL.residential);
  else if (lu === 2) base = pick(PAL.commercial);
  else if (lu === 3) base = pick(PAL.industrial);
  else base = pick(PAL.unknown);
  base = base.clone().multiplyScalar(0.9 + rand * 0.25);
  // mid-rise blends toward the tower ramp (kept mild so the imagery-sampled
  // tint still differentiates brick from concrete from glass)
  if (h > 14) base.lerp(COLOR_MID, Math.min(1, (h - 14) / 21) * 0.45);
  return base;
}

export class MetroBuildingsLayer {
  group = new THREE.Group();
  count = 0; // total baked buildings (from manifest)
  loadedTiles = 0;
  private facadeMat: THREE.MeshLambertMaterial;
  private plainMat: THREE.MeshLambertMaterial;
  private roofMats = new Map<string, THREE.MeshLambertMaterial>();
  private night = true;
  private tileIndex = new Map<string, number>();
  private tileCache = new Map<string, TileRec[] | Promise<TileRec[]>>();
  private built = new Map<string, BuiltTile>();
  private focus = new THREE.Vector2(0, 0);
  private rebuilding = false;

  constructor() {
    this.group.name = 'metro-buildings';
    this.facadeMat = createFacadeMaterial();
    this.plainMat = new THREE.MeshLambertMaterial({ vertexColors: true, transparent: true });
  }

  setVisible(v: boolean) {
    this.group.visible = v;
  }

  setOpacity(o: number) {
    this.facadeMat.opacity = o;
    this.plainMat.opacity = o;
    for (const m of this.roofMats.values()) m.opacity = o;
  }

  setNightMode(on: boolean) {
    this.night = on;
    setFacadeNight(this.facadeMat, on);
    for (const m of this.roofMats.values()) this.tintRoof(m);
  }

  /** Orthophoto roofs share the terrain's night tint so the photo reads as one city. */
  private tintRoof(mat: THREE.MeshLambertMaterial) {
    mat.color.set(this.night ? 0x55668a : 0xffffff);
  }

  private roofMatFor(tier: ImageryTier): THREE.MeshLambertMaterial {
    let mat = this.roofMats.get(tier.name);
    if (!mat) {
      mat = new THREE.MeshLambertMaterial({ map: tier.tex, transparent: true });
      this.tintRoof(mat);
      this.roofMats.set(tier.name, mat);
    }
    return mat;
  }

  async load(): Promise<void> {
    const res = await fetchWithRetry('data/manifest.json');
    const manifest = await res.json();
    for (const t of manifest.buildingTiles ?? []) {
      this.tileIndex.set(t.k, t.n);
      this.count += t.n;
    }
    // stream tiles in the background — the intro plays over the city
    // assembling, and the status bar reports totals immediately
    void this.update(0, 0, true);
  }

  /** Called from the render loop with the current camera target. */
  async update(x: number, z: number, force = false): Promise<void> {
    if (this.rebuilding) return;
    if (!force && Math.hypot(x - this.focus.x, z - this.focus.y) < 500) return;
    this.rebuilding = true;
    this.focus.set(x, z);
    try {
      await this.rebuildTiles();
    } finally {
      this.rebuilding = false;
    }
  }

  private lodFor(tx: number, tz: number): number {
    const cx = (tx + 0.5) * TILE;
    const cz = (tz + 0.5) * TILE;
    const d = Math.hypot(cx - this.focus.x, cz - this.focus.y);
    if (d < LOD_DIST[0]) return 0;
    if (d < LOD_DIST[1]) return 1;
    if (d < LOD_DIST[2]) return 2;
    return -1;
  }

  private async rebuildTiles(): Promise<void> {
    // decide target LOD per tile
    const wanted = new Map<string, number>();
    for (const key of this.tileIndex.keys()) {
      const [tx, tz] = key.split('_').map(Number);
      const lod = this.lodFor(tx, tz);
      if (lod >= 0) wanted.set(key, lod);
    }

    // dispose tiles that fell out of range or changed LOD
    for (const [key, built] of this.built) {
      const want = wanted.get(key);
      if (want === undefined || want !== built.lod) {
        for (const mesh of built.meshes) {
          this.group.remove(mesh);
          mesh.geometry.dispose();
        }
        this.built.delete(key);
      }
    }

    // build missing, nearest first, yielding between tiles
    const queue = [...wanted.entries()]
      .filter(([key]) => !this.built.has(key))
      .sort((a, b) => this.tileDist(a[0]) - this.tileDist(b[0]));
    for (const [key, lod] of queue) {
      const recs = await this.fetchTile(key);
      if (this.built.has(key)) continue; // raced
      const meshes = this.buildTileMesh(key, recs, lod);
      this.built.set(key, { lod, meshes });
      for (const mesh of meshes) this.group.add(mesh);
      await new Promise((r) => setTimeout(r, 0)); // let frames through
    }
    this.loadedTiles = this.built.size;
  }

  private tileDist(key: string): number {
    const [tx, tz] = key.split('_').map(Number);
    return Math.hypot((tx + 0.5) * TILE - this.focus.x, (tz + 0.5) * TILE - this.focus.y);
  }

  private fetchTile(key: string): Promise<TileRec[]> {
    const cached = this.tileCache.get(key);
    if (cached) return Promise.resolve(cached);
    const promise = (async () => {
      const res = await fetchWithRetry(`data/tiles/b_${key}.bin`);
      const buf = await res.arrayBuffer();
      const recs = parseTile(buf, key);
      this.tileCache.set(key, recs);
      return recs;
    })();
    this.tileCache.set(key, promise);
    return promise;
  }

  /** Build merged meshes for a tile at the given LOD (walls + orthophoto roofs). */
  private buildTileMesh(key: string, recs: TileRec[], lod: number): THREE.Mesh[] {
    const minArea = LOD_MIN_AREA[lod];
    const facades = lod === 0;
    const pos: number[] = [];
    const nrm: number[] = [];
    const col: number[] = [];
    const wallDist: number[] = [];
    const floorY: number[] = [];
    const rand: number[] = [];
    const idx: number[] = [];

    // orthophoto roof buffers, grouped by imagery tier (chosen per building
    // so downtown roofs use the sharpest sheet available)
    const roofBufs = new Map<ImageryTier, { pos: number[]; uv: number[]; idx: number[] }>();

    for (const rec of recs) {
      if (rec.area < minArea) continue;
      const seed = hash01(rec.ring[0], rec.ring[1]);
      const n = rec.ring.length / 2;
      const cx = centroidX(rec.ring);
      const cz = centroidZ(rec.ring);
      const base = elevation(cx, cz) - 1.5; // sink foundations into slopes
      const top = base + 1.5 + rec.h;
      const color = wallColor(rec.h, rec.lu, seed);
      // pull the wall albedo toward the photographed roof color: brick reads
      // brick, white stone reads white (towers keep more of the stylized ramp)
      if (lod <= 1) {
        const photo = sampleColor(cx, cz);
        if (photo) {
          const hsl = { h: 0, s: 0, l: 0 };
          photo.getHSL(hsl);
          photo.setHSL(hsl.h, Math.min(hsl.s * 1.15, 0.6), Math.min(Math.max(hsl.l, 0.3), 0.62));
          color.lerp(photo, rec.h > 35 ? 0.35 : 0.55);
        }
      }
      const roofColor = color.clone().multiplyScalar(rec.h > 35 ? 0.72 : 0.62);
      const hipRoof = facades && rec.lu === 1 && rec.area < 280 && rec.h < 10 && n <= 8;

      // ── walls ──
      let dist = 0;
      for (let i = 0; i < n; i++) {
        const ax = rec.ring[i * 2];
        const az = rec.ring[i * 2 + 1];
        const bx = rec.ring[((i + 1) % n) * 2];
        const bz = rec.ring[((i + 1) % n) * 2 + 1];
        const len = Math.hypot(bx - ax, bz - az);
        if (len < 0.01) continue;
        // outward normal — bake guarantees negative shoelace area in (x,z)
        const nx = -(bz - az) / len;
        const nz = (bx - ax) / len;
        const v0 = pos.length / 3;
        pos.push(ax, base, az, bx, base, bz, bx, top, bz, ax, top, az);
        for (let k = 0; k < 4; k++) {
          nrm.push(nx, 0, nz);
          col.push(color.r, color.g, color.b);
          floorY.push(base);
          rand.push(seed);
        }
        if (facades) wallDist.push(dist, dist + len, dist + len, dist);
        else wallDist.push(-1, -1, -1, -1);
        idx.push(v0, v0 + 1, v0 + 2, v0, v0 + 2, v0 + 3);
        dist += len;
      }

      // ── roof ──
      if (hipRoof) {
        const apexY = top + Math.min(3.2, rec.h * 0.45);
        const apexIdx = pos.length / 3;
        pos.push(cx, apexY, cz);
        nrm.push(0, 1, 0);
        col.push(roofColor.r, roofColor.g, roofColor.b);
        wallDist.push(-1);
        floorY.push(base);
        rand.push(seed);
        for (let i = 0; i < n; i++) {
          const ax = rec.ring[i * 2];
          const az = rec.ring[i * 2 + 1];
          const bx = rec.ring[((i + 1) % n) * 2];
          const bz = rec.ring[((i + 1) % n) * 2 + 1];
          const v0 = pos.length / 3;
          pos.push(ax, top, az, bx, top, bz);
          // slope normal (approx): blend of face outward + up
          const len = Math.hypot(bx - ax, bz - az) || 1;
          const nx = -(bz - az) / len;
          const nz = (bx - ax) / len;
          for (let k = 0; k < 2; k++) {
            nrm.push(nx * 0.55, 0.83, nz * 0.55);
            col.push(roofColor.r, roofColor.g, roofColor.b);
            wallDist.push(-1);
            floorY.push(base);
            rand.push(seed);
          }
          idx.push(v0, v0 + 1, apexIdx);
        }
      } else {
        // flat cap via ear-cut triangulation (contour is CCW in (x,-z))
        const contour: THREE.Vector2[] = [];
        for (let i = 0; i < n; i++) contour.push(new THREE.Vector2(rec.ring[i * 2], -rec.ring[i * 2 + 1]));
        let tris: number[][];
        try {
          tris = THREE.ShapeUtils.triangulateShape(contour, []);
        } catch {
          tris = [];
        }
        let bMinX = Infinity, bMinZ = Infinity, bMaxX = -Infinity, bMaxZ = -Infinity;
        for (let i = 0; i < n; i++) {
          const x = rec.ring[i * 2];
          const z = rec.ring[i * 2 + 1];
          if (x < bMinX) bMinX = x;
          if (x > bMaxX) bMaxX = x;
          if (z < bMinZ) bMinZ = z;
          if (z > bMaxZ) bMaxZ = z;
        }
        const tier = tierForBbox(bMinX, bMinZ, bMaxX, bMaxZ);
        if (tier) {
          // orthophoto roof: the actual Tulsa rooftop from NAIP
          let buf = roofBufs.get(tier);
          if (!buf) {
            buf = { pos: [], uv: [], idx: [] };
            roofBufs.set(tier, buf);
          }
          const v0 = buf.pos.length / 3;
          for (let i = 0; i < n; i++) {
            const x = rec.ring[i * 2];
            const z = rec.ring[i * 2 + 1];
            buf.pos.push(x, top, z);
            const [u, v] = tierUV(tier, x, z);
            buf.uv.push(u, v);
          }
          for (const [a, b, c] of tris) buf.idx.push(v0 + a, v0 + b, v0 + c);
        } else {
          const v0 = pos.length / 3;
          for (let i = 0; i < n; i++) {
            pos.push(rec.ring[i * 2], top, rec.ring[i * 2 + 1]);
            nrm.push(0, 1, 0);
            col.push(roofColor.r, roofColor.g, roofColor.b);
            wallDist.push(-1);
            floorY.push(base);
            rand.push(seed);
          }
          for (const [a, b, c] of tris) idx.push(v0 + a, v0 + b, v0 + c);
        }
      }
    }

    const meshes: THREE.Mesh[] = [];
    if (pos.length) {
      const geom = new THREE.BufferGeometry();
      geom.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      geom.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
      geom.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
      if (facades) {
        geom.setAttribute('aWallDist', new THREE.Float32BufferAttribute(wallDist, 1));
        geom.setAttribute('aFloorY', new THREE.Float32BufferAttribute(floorY, 1));
        geom.setAttribute('aRand', new THREE.Float32BufferAttribute(rand, 1));
      }
      geom.setIndex(idx);
      const mesh = new THREE.Mesh(geom, facades ? this.facadeMat : this.plainMat);
      mesh.name = `btile-${key}-lod${lod}`;
      mesh.renderOrder = 2;
      meshes.push(mesh);
    }
    for (const [tier, buf] of roofBufs) {
      const geom = new THREE.BufferGeometry();
      geom.setAttribute('position', new THREE.Float32BufferAttribute(buf.pos, 3));
      geom.setAttribute('uv', new THREE.Float32BufferAttribute(buf.uv, 2));
      const nrmArr = new Float32Array(buf.pos.length);
      for (let i = 0; i < nrmArr.length; i += 3) nrmArr[i + 1] = 1;
      geom.setAttribute('normal', new THREE.BufferAttribute(nrmArr, 3));
      geom.setIndex(buf.idx);
      const mesh = new THREE.Mesh(geom, this.roofMatFor(tier));
      mesh.name = `btile-${key}-roofs-${tier.name}`;
      mesh.renderOrder = 2;
      meshes.push(mesh);
    }
    return meshes;
  }
}

function parseTile(buf: ArrayBuffer, key: string): TileRec[] {
  const [tx, tz] = key.split('_').map(Number);
  const ox = tx * TILE;
  const oz = tz * TILE;
  const dv = new DataView(buf);
  const count = dv.getUint32(0, true);
  const recs: TileRec[] = new Array(count);
  let off = 4;
  for (let i = 0; i < count; i++) {
    const nVerts = dv.getUint8(off);
    const lu = dv.getUint8(off + 1);
    const h = dv.getUint16(off + 2, true) / 10;
    off += 4;
    const ring = new Float32Array(nVerts * 2);
    for (let v = 0; v < nVerts; v++) {
      ring[v * 2] = ox + dv.getInt16(off, true) / 10;
      ring[v * 2 + 1] = oz + dv.getInt16(off + 2, true) / 10;
      off += 4;
    }
    // shoelace in xz (open ring)
    let area = 0;
    for (let v = 0; v < nVerts; v++) {
      const x1 = ring[v * 2];
      const z1 = ring[v * 2 + 1];
      const x2 = ring[((v + 1) % nVerts) * 2];
      const z2 = ring[((v + 1) % nVerts) * 2 + 1];
      area += x1 * z2 - x2 * z1;
    }
    recs[i] = { ring, h, lu, area: Math.abs(area / 2) };
  }
  return recs;
}

function centroidX(ring: Float32Array): number {
  let s = 0;
  for (let i = 0; i < ring.length; i += 2) s += ring[i];
  return s / (ring.length / 2);
}
function centroidZ(ring: Float32Array): number {
  let s = 0;
  for (let i = 1; i < ring.length; i += 2) s += ring[i];
  return s / (ring.length / 2);
}
