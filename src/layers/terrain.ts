import * as THREE from 'three';
import { elevation, terrainExtent } from '../geo/terrain';
import { localToLL } from '../geo/projection';
import { imageryTiers, type ImageryTier } from '../data/imagery';

/**
 * Terrain + aerial imagery ground (Phase 3).
 *
 * Geometry: displaced grids from the baked USGS 3DEP heightfield — the
 * Arkansas River valley, Turkey Mountain, and the Osage hills are real.
 * Imagery: three tiers from src/data/imagery.ts (core ~1.1 m/px downtown,
 * inset ~3 m/px, metro ~9 m/px), stacked with small lifts so the sharpest
 * sheet wins where available. Night mode tints the photo toward a dark
 * blue "city lights" read. The 1943 aerial (history layer) drapes onto the
 * inset-extent geometry above everything, following the relief.
 */
const NIGHT_TINT = new THREE.Color(0x3c4c68);
const DAY_TINT = new THREE.Color(0xffffff);

interface Sheet {
  mesh: THREE.Mesh;
  mat: THREE.MeshLambertMaterial;
  tier: ImageryTier;
}

export class TerrainLayer {
  group = new THREE.Group();
  /** meshes valid as raycast targets for parcel clicks */
  raycastTargets: THREE.Mesh[] = [];
  private sheets: Sheet[] = [];
  private historicMat = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0 });
  private historicMesh: THREE.Mesh | null = null;
  private night = true;

  constructor() {
    this.group.name = 'terrain';
  }

  /** Call after loadTerrain() + loadImagery() have resolved. */
  async load(): Promise<void> {
    const ext = terrainExtent();
    const tiers = imageryTiers();
    const configs: Array<{ name: string; seg: number; lift: number; box?: [number, number, number, number] }> = [
      { name: 'metro', seg: 200, lift: 0, box: [ext.minX, ext.minZ, ext.maxX, ext.maxZ] },
      { name: 'inset', seg: 150, lift: 0.35 },
      { name: 'core', seg: 110, lift: 0.6 },
    ];
    for (const cfg of configs) {
      const tier = tiers.find((t) => t.name === cfg.name);
      if (!tier) continue;
      if (cfg.name !== 'metro' && !tier.tex) continue; // no photo → metro sheet covers it
      const [minX, minZ, maxX, maxZ] = cfg.box ?? [tier.minX, tier.minZ, tier.maxX, tier.maxZ];
      const geom = buildGrid(minX, minZ, maxX, maxZ, cfg.seg, cfg.seg, cfg.lift);
      const mat = new THREE.MeshLambertMaterial({ color: 0x223041 });
      if (tier.tex) {
        mat.map = tier.tex;
        mat.color.set(0xffffff);
      }
      const mesh = new THREE.Mesh(geom, mat);
      mesh.name = `terrain-${cfg.name}`;
      this.group.add(mesh);
      this.raycastTargets.push(mesh);
      this.sheets.push({ mesh, mat, tier });
    }

    // historic overlay: inset extent, above all imagery sheets
    const histGeom = buildGrid(-6000, -6000, 6000, 6000, 150, 150, 0.95);
    this.historicMat.depthWrite = false;
    this.historicMesh = new THREE.Mesh(histGeom, this.historicMat);
    this.historicMesh.name = 'terrain-historic';
    this.historicMesh.visible = false;
    this.group.add(this.historicMesh);

    this.applyTint();
  }

  setNightMode(on: boolean) {
    this.night = on;
    this.applyTint();
  }

  private applyTint() {
    const tint = this.night ? NIGHT_TINT : DAY_TINT;
    for (const s of this.sheets) {
      if (s.mat.map) s.mat.color.copy(tint);
    }
  }

  /** Historic (1943) drape driven by the history layer. */
  setHistoric(tex: THREE.Texture | null, opacity: number) {
    if (tex && this.historicMat.map !== tex) {
      this.historicMat.map = tex;
      this.historicMat.needsUpdate = true;
    }
    this.historicMat.opacity = opacity;
    if (this.historicMesh) this.historicMesh.visible = opacity > 0.01;
  }

  /** Extent of the historic drape in WGS84, for exportImage bboxes. */
  insetBboxLL(): [number, number, number, number] {
    const [w, s] = localToLL(-6000, 6000);
    const [e, n] = localToLL(6000, -6000);
    return [w, s, e, n];
  }
}

/** Displaced, UV-mapped grid over [minX,maxX]×[minZ,maxZ] in local meters. */
function buildGrid(
  minX: number,
  minZ: number,
  maxX: number,
  maxZ: number,
  segX: number,
  segZ: number,
  lift: number,
): THREE.BufferGeometry {
  const w = maxX - minX;
  const d = maxZ - minZ;
  const geom = new THREE.PlaneGeometry(w, d, segX, segZ);
  // plane XY → scene XZ with v=1 (texture top) at north (minZ)
  geom.rotateX(-Math.PI / 2);
  geom.translate(minX + w / 2, 0, minZ + d / 2);
  const pos = geom.getAttribute('position') as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    pos.setY(i, elevation(pos.getX(i), pos.getZ(i)) + lift);
  }
  geom.computeVertexNormals();
  return geom;
}
