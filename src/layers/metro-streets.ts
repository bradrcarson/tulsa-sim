import * as THREE from 'three';
import { fetchWithRetry } from '../data/cache';
import { elevation } from '../geo/terrain';

/**
 * Tile-streamed metro street network (Phase 3).
 * Vertices are draped onto the terrain heightfield (+small offset by class).
 * A metro-wide "major roads" overlay (motorway→secondary) is always loaded
 * so the far view reads as a city; detail tiles stream in around the camera.
 */
const TILE = 2000;
const DETAIL_DIST = 8000; // stream residential/service detail within this radius

const CLASS_STYLE: Array<{ color: number; y: number; major: boolean }> = [
  { color: 0xffb347, y: 2.4, major: true }, // 0 motorway
  { color: 0xcc8833, y: 2.2, major: true }, // 1 motorway_link
  { color: 0xffa040, y: 2.0, major: true }, // 2 trunk
  { color: 0xbb7733, y: 1.8, major: true }, // 3 trunk_link
  { color: 0x6fd3ff, y: 1.6, major: true }, // 4 primary
  { color: 0x55a0cc, y: 1.4, major: true }, // 5 primary_link
  { color: 0x4a90c4, y: 1.2, major: true }, // 6 secondary
  { color: 0x3d7aa8, y: 1.0, major: false }, // 7 secondary_link
  { color: 0x3a6a94, y: 0.9, major: false }, // 8 tertiary
  { color: 0x2b4a66, y: 0.7, major: false }, // 9 residential
  { color: 0x263f57, y: 0.7, major: false }, // 10 unclassified
  { color: 0x1d3044, y: 0.6, major: false }, // 11 service
];

export class MetroStreetsLayer {
  group = new THREE.Group();
  private materials = new Map<number, THREE.LineBasicMaterial>();
  private tileKeys: string[] = [];
  private builtTiles = new Map<string, THREE.Object3D>();
  private focus = new THREE.Vector2(0, 0);
  private busy = false;

  constructor() {
    this.group.name = 'metro-streets';
  }

  setVisible(v: boolean) {
    this.group.visible = v;
  }

  setNightMode(on: boolean) {
    for (const mat of this.materials.values()) {
      const base = mat.userData.baseOpacity as number;
      mat.opacity = on ? base : base * 0.5;
    }
  }

  private matFor(cls: number): THREE.LineBasicMaterial {
    let mat = this.materials.get(cls);
    if (!mat) {
      const style = CLASS_STYLE[cls] ?? CLASS_STYLE[11];
      mat = new THREE.LineBasicMaterial({
        color: style.color,
        transparent: true,
        opacity: style.major ? 0.95 : 0.5,
      });
      mat.userData.baseOpacity = mat.opacity;
      this.materials.set(cls, mat);
    }
    return mat;
  }

  async load(): Promise<void> {
    const res = await fetchWithRetry('data/manifest.json');
    const manifest = await res.json();
    this.tileKeys = (manifest.streetTiles ?? []).map((t: { k: string }) => t.k);
    await this.loadMajor();
    void this.update(0, 0, true);
  }

  private async loadMajor(): Promise<void> {
    const res = await fetchWithRetry('data/streets-major.bin');
    const buf = await res.arrayBuffer();
    const dv = new DataView(buf);
    const count = dv.getUint32(0, true);
    let off = 4;
    const buckets = new Map<number, number[]>();
    for (let i = 0; i < count; i++) {
      const cls = dv.getUint8(off);
      const nVerts = dv.getUint16(off + 1, true);
      off += 3;
      let arr = buckets.get(cls);
      if (!arr) {
        arr = [];
        buckets.set(cls, arr);
      }
      let px = 0;
      let py = 0;
      let pz = 0;
      for (let v = 0; v < nVerts; v++) {
        const x = dv.getInt32(off, true) / 10;
        const z = dv.getInt32(off + 4, true) / 10;
        off += 8;
        const y = elevation(x, z) + (CLASS_STYLE[cls]?.y ?? 1);
        if (v > 0) arr.push(px, py, pz, x, y, z);
        px = x;
        py = y;
        pz = z;
      }
    }
    const majorGroup = new THREE.Group();
    majorGroup.name = 'streets-major';
    for (const [cls, verts] of buckets) {
      const geom = new THREE.BufferGeometry();
      geom.setAttribute('position', new THREE.BufferAttribute(new Float32Array(verts), 3));
      majorGroup.add(new THREE.LineSegments(geom, this.matFor(cls)));
    }
    this.group.add(majorGroup);
  }

  async update(x: number, z: number, force = false): Promise<void> {
    if (this.busy) return;
    if (!force && Math.hypot(x - this.focus.x, z - this.focus.y) < 500) return;
    this.busy = true;
    this.focus.set(x, z);
    try {
      const wanted = new Set<string>();
      for (const key of this.tileKeys) {
        const [tx, tz] = key.split('_').map(Number);
        const d = Math.hypot((tx + 0.5) * TILE - x, (tz + 0.5) * TILE - z);
        if (d < DETAIL_DIST) wanted.add(key);
      }
      for (const [key, obj] of this.builtTiles) {
        if (!wanted.has(key)) {
          this.group.remove(obj);
          obj.traverse((o) => (o as THREE.LineSegments).geometry?.dispose());
          this.builtTiles.delete(key);
        }
      }
      for (const key of wanted) {
        if (this.builtTiles.has(key)) continue;
        const obj = await this.buildTile(key);
        if (obj && !this.builtTiles.has(key)) {
          this.builtTiles.set(key, obj);
          this.group.add(obj);
        }
        await new Promise((r) => setTimeout(r, 0));
      }
    } finally {
      this.busy = false;
    }
  }

  private async buildTile(key: string): Promise<THREE.Object3D | null> {
    const [tx, tz] = key.split('_').map(Number);
    const ox = tx * TILE;
    const oz = tz * TILE;
    let buf: ArrayBuffer;
    try {
      const res = await fetchWithRetry(`data/tiles/s_${key}.bin`);
      buf = await res.arrayBuffer();
    } catch {
      return null;
    }
    const dv = new DataView(buf);
    const count = dv.getUint32(0, true);
    let off = 4;
    const buckets = new Map<number, number[]>();
    for (let i = 0; i < count; i++) {
      const cls = dv.getUint8(off);
      const nVerts = dv.getUint16(off + 1, true);
      off += 3;
      const isMajor = CLASS_STYLE[cls]?.major ?? false;
      let arr: number[] | null = null;
      if (!isMajor) {
        // major classes already covered by the always-on overlay
        arr = buckets.get(cls) ?? null;
        if (!arr) {
          arr = [];
          buckets.set(cls, arr);
        }
      }
      let px = 0;
      let py = 0;
      let pz = 0;
      for (let v = 0; v < nVerts; v++) {
        const x = ox + dv.getInt16(off, true) / 10;
        const z = oz + dv.getInt16(off + 2, true) / 10;
        off += 4;
        if (!arr) continue;
        const y = elevation(x, z) + (CLASS_STYLE[cls]?.y ?? 1);
        if (v > 0) arr.push(px, py, pz, x, y, z);
        px = x;
        py = y;
        pz = z;
      }
    }
    if (!buckets.size) return null;
    const tileGroup = new THREE.Group();
    tileGroup.name = `stile-${key}`;
    for (const [cls, verts] of buckets) {
      if (!verts.length) continue;
      const geom = new THREE.BufferGeometry();
      geom.setAttribute('position', new THREE.BufferAttribute(new Float32Array(verts), 3));
      tileGroup.add(new THREE.LineSegments(geom, this.matFor(cls)));
    }
    return tileGroup;
  }
}
