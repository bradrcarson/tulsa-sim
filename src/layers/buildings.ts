import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { llToLocal } from '../geo/projection';
import { fetchWithRetry } from '../data/cache';

/** Compact pre-baked building record (see scripts/ and public/data/buildings.json). */
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

export class BuildingsLayer {
  group = new THREE.Group();
  private material: THREE.MeshLambertMaterial;
  count = 0;

  constructor() {
    this.group.name = 'buildings';
    this.material = new THREE.MeshLambertMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 1,
    });
  }

  /** Fade for historical mode (1943 aerial view). */
  setOpacity(o: number) {
    this.material.opacity = o;
    this.material.needsUpdate = false;
  }

  setVisible(v: boolean) {
    this.group.visible = v;
  }

  async load(url = 'data/buildings.json'): Promise<void> {
    const res = await fetchWithRetry(url);
    const recs: BuildingRec[] = await res.json();
    this.count = recs.length;

    const geoms: THREE.BufferGeometry[] = [];
    let batch: THREE.BufferGeometry[] = [];

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

      // per-vertex color by height
      const col = colorForHeight(height);
      const n = geom.getAttribute('position').count;
      const colors = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) {
        colors[i * 3] = col.r;
        colors[i * 3 + 1] = col.g;
        colors[i * 3 + 2] = col.b;
      }
      geom.setAttribute('color', new THREE.BufferAttribute(colors, 3));
      batch.push(geom);

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
  }
}
