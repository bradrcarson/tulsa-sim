import * as THREE from 'three';
import { elevation } from '../geo/terrain';
import { sampleColor } from '../data/imagery';

/**
 * Procedural tree canopy (Phase 4 realism pass).
 *
 * Tulsa is one of the leafiest cities in the plains; a flat aerial photo
 * ground undersells it. This layer walks a jittered grid over the inset
 * (±6 km) and drops a low-poly instanced tree wherever the NAIP imagery
 * pixel is actually vegetation-green — so groves, park edges, and
 * neighborhood canopies emerge from the photo itself. Trunk+crown cost
 * ~14 tris per tree; a single instanced draw call.
 */
const SPACING = 42; // meters between grid candidates
const EXTENT = 5800; // half-size of the seeded area (matches inset sheet)
const MAX_TREES = 30000;

const NIGHT_CROWN = new THREE.Color(0x0d1a14);

function hash01(x: number, y: number): number {
  const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return s - Math.floor(s);
}

export class TreesLayer {
  group = new THREE.Group();
  count = 0;
  private crowns: THREE.InstancedMesh | null = null;
  private crownMat = new THREE.MeshLambertMaterial({ vertexColors: false });
  private dayColors: Float32Array | null = null;
  private night = true;

  constructor() {
    this.group.name = 'trees';
  }

  /** Requires terrain + imagery to be loaded (reads both). */
  build(): void {
    const positions: Array<{ x: number; z: number; s: number; c: THREE.Color }> = [];
    for (let gx = -EXTENT; gx <= EXTENT; gx += SPACING) {
      for (let gz = -EXTENT; gz <= EXTENT; gz += SPACING) {
        const j1 = hash01(gx, gz);
        const j2 = hash01(gz + 17.3, gx - 5.1);
        const x = gx + (j1 - 0.5) * SPACING * 0.9;
        const z = gz + (j2 - 0.5) * SPACING * 0.9;
        const c = sampleColor(x, z);
        if (!c) continue;
        // vegetation test: green channel dominates, not too bright (roads)
        // and not too dark (water/shadow)
        const { r, g, b } = c;
        if (!(g > r * 1.06 && g > b * 1.18 && g > 0.12 && g < 0.55)) continue;
        if (j1 * j2 > 0.42) continue; // thin out for perf + natural clumping
        positions.push({ x, z, s: 0.75 + j1 * 0.7, c: c.clone() });
        if (positions.length >= MAX_TREES) break;
      }
      if (positions.length >= MAX_TREES) break;
    }
    if (!positions.length) return;

    // crown: squat 5-sided cone; trunk skipped (invisible at these scales)
    const crownGeo = new THREE.ConeGeometry(3.4, 7.5, 5);
    crownGeo.translate(0, 4.4, 0);
    this.crowns = new THREE.InstancedMesh(crownGeo, this.crownMat, positions.length);
    this.crowns.instanceColor = new THREE.InstancedBufferAttribute(
      new Float32Array(positions.length * 3),
      3,
    );
    this.dayColors = new Float32Array(positions.length * 3);
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const up = new THREE.Vector3(0, 1, 0);
    for (let i = 0; i < positions.length; i++) {
      const p = positions[i];
      q.setFromAxisAngle(up, hash01(p.x, p.z) * Math.PI);
      m.compose(
        new THREE.Vector3(p.x, elevation(p.x, p.z), p.z),
        q,
        new THREE.Vector3(p.s, p.s * (0.8 + hash01(p.z, p.x) * 0.5), p.s),
      );
      this.crowns.setMatrixAt(i, m);
      // deepen the photo green a touch so crowns read darker than lawn
      const col = p.c.multiplyScalar(0.78);
      this.dayColors[i * 3] = col.r;
      this.dayColors[i * 3 + 1] = col.g;
      this.dayColors[i * 3 + 2] = col.b;
    }
    this.crowns.instanceMatrix.needsUpdate = true;
    this.count = positions.length;
    this.group.add(this.crowns);
    this.applyColors();
    console.info(`[trees] ${this.count} trees seeded from imagery`);
  }

  setNightMode(on: boolean) {
    this.night = on;
    this.applyColors();
  }

  private applyColors() {
    if (!this.crowns || !this.dayColors) return;
    const attr = this.crowns.instanceColor!;
    const arr = attr.array as Float32Array;
    if (this.night) {
      for (let i = 0; i < this.count; i++) {
        arr[i * 3] = NIGHT_CROWN.r;
        arr[i * 3 + 1] = NIGHT_CROWN.g;
        arr[i * 3 + 2] = NIGHT_CROWN.b;
      }
    } else {
      arr.set(this.dayColors);
    }
    attr.needsUpdate = true;
  }
}
