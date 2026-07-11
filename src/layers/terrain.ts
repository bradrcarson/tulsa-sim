import * as THREE from 'three';
import { elevation, terrainExtent } from '../geo/terrain';
import { localToLL } from '../geo/projection';

/**
 * Terrain + aerial imagery ground (Phase 3).
 *
 * Geometry: displaced grid from the baked USGS 3DEP heightfield — the
 * Arkansas River valley, Turkey Mountain, and the Osage hills are real.
 * Imagery: USGS ImageryOnly basemap (public domain NAIP composite), fetched
 * live via exportImage at two levels:
 *   - metro-wide sheet (whole heightfield extent)
 *   - downtown inset (12×12 km, ~3 m/px) draped on a denser sub-grid
 * Night mode tints the imagery toward a dark blue "city lights" read.
 * The 1943 aerial (history layer) drapes onto the same inset geometry, so
 * the time machine now follows the terrain instead of a flat plane.
 */
const IMG_SERVICE =
  'https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer/export';
const INSET_HALF = 6000; // meters around downtown origin

const NIGHT_TINT = new THREE.Color(0x3c4c68);
const DAY_TINT = new THREE.Color(0xffffff);

export class TerrainLayer {
  group = new THREE.Group();
  /** meshes valid as raycast targets for parcel clicks */
  raycastTargets: THREE.Mesh[] = [];
  private metroMat = new THREE.MeshLambertMaterial({ color: 0x223041 });
  private insetMat = new THREE.MeshLambertMaterial({ color: 0x223041 });
  private historicMat = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0 });
  private historicMesh: THREE.Mesh | null = null;
  private night = true;

  constructor() {
    this.group.name = 'terrain';
  }

  async load(): Promise<void> {
    const ext = terrainExtent();

    // ── metro sheet ──
    const metroGeom = buildGrid(ext.minX, ext.minZ, ext.maxX, ext.maxZ, 220, 160, 0);
    const metro = new THREE.Mesh(metroGeom, this.metroMat);
    metro.name = 'terrain-metro';
    metro.renderOrder = 0;
    this.group.add(metro);
    this.raycastTargets.push(metro);

    // ── downtown inset (denser, higher-res imagery, slight lift) ──
    const insetGeom = buildGrid(-INSET_HALF, -INSET_HALF, INSET_HALF, INSET_HALF, 160, 160, 0.35);
    const inset = new THREE.Mesh(insetGeom, this.insetMat);
    inset.name = 'terrain-inset';
    inset.renderOrder = 1;
    this.group.add(inset);
    this.raycastTargets.push(inset);

    // historic overlay shares the inset geometry (lifted a touch more)
    this.historicMat.depthWrite = false;
    this.historicMesh = new THREE.Mesh(insetGeom.clone().translate(0, 0.3, 0), this.historicMat);
    this.historicMesh.name = 'terrain-historic';
    this.historicMesh.renderOrder = 2;
    this.historicMesh.visible = false;
    this.group.add(this.historicMesh);

    // imagery loads in the background; terrain shows as dark relief until then
    void this.loadImagery(this.metroMat, ext.minX, ext.minZ, ext.maxX, ext.maxZ, 4096, 2914);
    void this.loadImagery(this.insetMat, -INSET_HALF, -INSET_HALF, INSET_HALF, INSET_HALF, 4096, 4096);
    this.applyTint();
  }

  private async loadImagery(
    mat: THREE.MeshLambertMaterial,
    minX: number,
    minZ: number,
    maxX: number,
    maxZ: number,
    w: number,
    h: number,
  ): Promise<void> {
    const [west, south] = localToLL(minX, maxZ);
    const [east, north] = localToLL(maxX, minZ);
    const url =
      `${IMG_SERVICE}?bbox=${west},${south},${east},${north}&bboxSR=4326&imageSR=4326` +
      `&size=${w},${h}&format=jpg&f=image`;
    try {
      const tex = await new THREE.TextureLoader().loadAsync(url);
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.anisotropy = 8;
      mat.map = tex;
      mat.color.set(0xffffff);
      mat.needsUpdate = true;
      this.applyTint();
    } catch (err) {
      console.warn('[terrain] imagery fetch failed (dark relief fallback)', err);
    }
  }

  setNightMode(on: boolean) {
    this.night = on;
    this.applyTint();
  }

  private applyTint() {
    const tint = this.night ? NIGHT_TINT : DAY_TINT;
    for (const mat of [this.metroMat, this.insetMat]) {
      if (mat.map) mat.color.copy(tint);
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

  /** Extent of the inset in WGS84, for the history layer's exportImage bbox. */
  insetBboxLL(): [number, number, number, number] {
    const [w, s] = localToLL(-INSET_HALF, INSET_HALF);
    const [e, n] = localToLL(INSET_HALF, -INSET_HALF);
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
  // plane XY → scene XZ: x stays, plane +Y (up) must map to -Z→... we want
  // v=1 (top of texture) at north (minZ). PlaneGeometry has +Y up, so rotate
  // -90° about X: plane (x, y) → (x, 0, -y). North (minZ) = plane maxY. ✓
  geom.rotateX(-Math.PI / 2);
  geom.translate(minX + w / 2, 0, minZ + d / 2);
  const pos = geom.getAttribute('position') as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    pos.setY(i, elevation(pos.getX(i), pos.getZ(i)) + lift);
  }
  geom.computeVertexNormals();
  return geom;
}
