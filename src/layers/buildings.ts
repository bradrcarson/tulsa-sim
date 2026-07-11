import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { llToLocal } from '../geo/projection';
import { fetchWithRetry } from '../data/cache';

/** Compact pre-baked building record (see scripts/bake-data.mjs → public/data/buildings.json). */
interface BuildingRec {
  c: [number, number][]; // footprint ring [lon,lat]
  h?: number; // height meters (from OSM height / levels)
  n?: string; // name
}

/** Deterministic hash → [0,1) so unknown heights are stable across reloads. */
function hash01(x: number, y: number): number {
  const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return s - Math.floor(s);
}

const COLOR_LOW = new THREE.Color(0x2b3a4d);
const COLOR_MID = new THREE.Color(0x3d5a80);
const COLOR_HIGH = new THREE.Color(0x66c7ff);

function colorForHeight(h: number): THREE.Color {
  // 0–15 m: low, 15–60 m: mid blend, 60+ m: highlight towers
  if (h <= 15) return COLOR_LOW.clone().lerp(COLOR_MID, h / 15);
  if (h <= 60) return COLOR_MID.clone().lerp(COLOR_HIGH, (h - 15) / 45);
  return COLOR_HIGH.clone();
}

const MAX_WINDOW_LIGHTS = 160_000;
// warm sodium / cool fluorescent / cyan office — weighted toward warm
const WINDOW_PALETTE = [
  new THREE.Color(0xffd9a0),
  new THREE.Color(0xffe9c8),
  new THREE.Color(0xa8d8ff),
  new THREE.Color(0xfff6e8),
];

export class BuildingsLayer {
  group = new THREE.Group();
  private material: THREE.MeshLambertMaterial;
  private windowLights: THREE.Points | null = null;
  private windowsOn = true;
  count = 0;

  constructor() {
    this.group.name = 'buildings';
    this.material = new THREE.MeshLambertMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 1,
    });
  }

  /** Fade for historical mode (1943 aerial view). Windows fade with the walls. */
  setOpacity(o: number) {
    this.material.opacity = o;
    if (this.windowLights) {
      (this.windowLights.material as THREE.PointsMaterial).opacity = 0.85 * o;
      this.windowLights.visible = this.windowsOn && o > 0.3;
    }
  }

  setVisible(v: boolean) {
    this.group.visible = v;
  }

  /** Procedural window scatter only makes sense after dark. */
  setNightMode(on: boolean) {
    this.windowsOn = on;
    if (this.windowLights) this.windowLights.visible = on;
  }

  async load(url = 'data/buildings.json'): Promise<void> {
    const res = await fetchWithRetry(url);
    const recs: BuildingRec[] = await res.json();
    this.count = recs.length;

    const geoms: THREE.BufferGeometry[] = [];
    let batch: THREE.BufferGeometry[] = [];
    const winPos: number[] = [];
    const winCol: number[] = [];

    for (const rec of recs) {
      const ring = rec.c;
      if (ring.length < 4) continue;

      const pts: THREE.Vector2[] = [];
      for (let i = 0; i < ring.length - 1; i++) {
        // shape lives in XY; we rotate so Y→ -Z later. Use (x, -z) = (x, north)
        const [x, z] = llToLocal(ring[i][0], ring[i][1]);
        pts.push(new THREE.Vector2(x, -z));
      }
      if (pts.length < 3) continue;

      const height = rec.h ?? 4 + hash01(pts[0].x, pts[0].y) * 6;

      let geom: THREE.BufferGeometry;
      try {
        const shape = new THREE.Shape(pts);
        geom = new THREE.ExtrudeGeometry(shape, { depth: height, bevelEnabled: false });
      } catch {
        continue; // skip degenerate footprints
      }
      // Extrude grows along +Z of the shape; rotate so it grows along +Y,
      // and shape-Y maps back to scene -Z (north).
      geom.rotateX(-Math.PI / 2);

      // per-vertex color by height; roof cap gets a subtle emissive-style rim
      // (brighter tint) so towers read against the night sky
      const col = colorForHeight(height);
      const roofCol = col.clone().multiplyScalar(1.45);
      const posAttr = geom.getAttribute('position');
      const n = posAttr.count;
      const colors = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) {
        const isRoof = posAttr.getY(i) > height - 0.01;
        const c = isRoof ? roofCol : col;
        colors[i * 3] = c.r;
        colors[i * 3 + 1] = c.g;
        colors[i * 3 + 2] = c.b;
      }
      geom.setAttribute('color', new THREE.BufferAttribute(colors, 3));
      batch.push(geom);

      if (winPos.length / 3 < MAX_WINDOW_LIGHTS && height >= 6) {
        this.scatterWindows(pts, height, winPos, winCol);
      }

      // merge in chunks to bound memory
      if (batch.length >= 512) {
        geoms.push(mergeGeometries(batch, false)!);
        batch.forEach((g) => g.dispose());
        batch = [];
      }
    }
    if (batch.length) {
      geoms.push(mergeGeometries(batch, false)!);
      batch.forEach((g) => g.dispose());
    }

    for (const g of geoms) {
      const mesh = new THREE.Mesh(g, this.material);
      mesh.name = 'building-batch';
      // draw after the historical aerial plane (renderOrder 1) so faded
      // buildings blend over the photo instead of depth-occluding it
      mesh.renderOrder = 2;
      this.group.add(mesh);
    }

    this.buildWindowLights(winPos, winCol);
  }

  /**
   * Random lit windows along the facade, seeded per building so the pattern
   * is stable across reloads. Points sit on the walls, nudged outward from
   * the footprint centroid to avoid z-fighting.
   */
  private scatterWindows(pts: THREE.Vector2[], height: number, outPos: number[], outCol: number[]) {
    let cx = 0;
    let cy = 0;
    for (const p of pts) {
      cx += p.x;
      cy += p.y;
    }
    cx /= pts.length;
    cy /= pts.length;

    const floors = Math.max(1, Math.floor(height / 3.4));
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i];
      const b = pts[(i + 1) % pts.length];
      const len = a.distanceTo(b);
      // one candidate window every ~9 m of facade per 3 floors, ~40% lit
      const candidates = Math.floor((len / 9) * Math.min(floors, 30) * 0.34);
      for (let k = 0; k < candidates; k++) {
        const seed = hash01(a.x * 3.7 + k * 17.31, a.y * 5.1 + i * 7.7);
        if (seed > 0.42) continue; // most windows dark
        const t = hash01(k * 31.7 + a.x, i * 13.3 + a.y);
        let wx = a.x + (b.x - a.x) * t;
        let wy = a.y + (b.y - a.y) * t;
        // nudge away from centroid so the point clears the wall
        const dx = wx - cx;
        const dy = wy - cy;
        const d = Math.hypot(dx, dy) || 1;
        wx += (dx / d) * 0.7;
        wy += (dy / d) * 0.7;
        const floorY = 2.5 + Math.floor(hash01(t * 91.3, seed * 47.9) * floors) * 3.4;
        if (floorY > height - 1) continue;
        // shape (x, y) → scene (x, h, -y)
        outPos.push(wx, floorY, -wy);
        const c = WINDOW_PALETTE[Math.floor(hash01(wx, wy) * WINDOW_PALETTE.length)];
        const bright = 0.75 + hash01(wy, wx) * 0.55;
        outCol.push(c.r * bright, c.g * bright, c.b * bright);
        if (outPos.length / 3 >= MAX_WINDOW_LIGHTS) return;
      }
    }
  }

  private buildWindowLights(pos: number[], col: number[]) {
    if (!pos.length) return;
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
    geom.setAttribute('color', new THREE.BufferAttribute(new Float32Array(col), 3));
    const mat = new THREE.PointsMaterial({
      size: 2.6,
      sizeAttenuation: true,
      vertexColors: true,
      transparent: true,
      opacity: 0.85,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    this.windowLights = new THREE.Points(geom, mat);
    this.windowLights.name = 'window-lights';
    this.windowLights.renderOrder = 3;
    this.windowLights.visible = this.windowsOn;
    this.group.add(this.windowLights);
    console.info(`[buildings] ${pos.length / 3} window lights scattered`);
  }
}
