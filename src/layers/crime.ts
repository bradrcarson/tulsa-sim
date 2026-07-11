import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { llToLocal, METRO_BBOX } from '../geo/projection';
import { fetchWithRetry } from '../data/cache';

/**
 * Crime calls-for-service, aggregated to a block-scale grid (privacy: no
 * individual incident pins / narratives — see AGENTS.md).
 *
 * The endpoint from the spec is queried live first, filtered to the last 90
 * days inside the Tulsa metro bbox. At build time that service contained no
 * records geocoded inside Tulsa, so a bundled snapshot of real TPD incident
 * data (public "Tulsa Crime" ArcGIS layer, 2016–2019 extract) ships as a
 * fallback so the heatmap is always demonstrable. The UI labels which source
 * is active.
 */
const CFS_SERVICE =
  'https://services2.arcgis.com/kXGqZY4GIOcEYxoF/ArcGIS/rest/services/Crime_Data_vw_crimes_public_cfs/FeatureServer/0/query';

const CELL_METERS = 160; // ~1 downtown block
const DAYS_BACK = 90;

export interface CrimePoint {
  x: number; // lon
  y: number; // lat
  p: string; // problem / category
  d: number | null; // epoch ms
}

export interface CrimeLoadResult {
  points: CrimePoint[];
  source: 'live' | 'snapshot';
}

async function fetchLive(): Promise<CrimePoint[]> {
  const since = new Date(Date.now() - DAYS_BACK * 86400_000);
  const iso = since.toISOString().slice(0, 19).replace('T', ' ');
  const [w, s, e, n] = METRO_BBOX;
  const points: CrimePoint[] = [];
  let offset = 0;
  for (let page = 0; page < 10; page++) {
    const params = new URLSearchParams({
      where: `Response_Date >= TIMESTAMP '${iso}' AND Latitude > ${s} AND Latitude < ${n} AND Longitude > ${w} AND Longitude < ${e}`,
      outFields: 'Problem,Response_Date,Latitude,Longitude',
      returnGeometry: 'false',
      resultOffset: String(offset),
      resultRecordCount: '2000',
      f: 'json',
    });
    const res = await fetchWithRetry(`${CFS_SERVICE}?${params}`);
    const data = await res.json();
    const feats: Array<{ attributes: Record<string, unknown> }> = data?.features ?? [];
    for (const f of feats) {
      const a = f.attributes;
      points.push({
        x: a['Longitude'] as number,
        y: a['Latitude'] as number,
        p: (a['Problem'] as string) ?? 'Unknown',
        d: (a['Response_Date'] as number) ?? null,
      });
    }
    if (feats.length < 2000) break;
    offset += 2000;
  }
  return points;
}

export class CrimeLayer {
  group = new THREE.Group();
  points: CrimePoint[] = [];
  source: 'live' | 'snapshot' = 'live';
  categories: string[] = [];
  private mesh: THREE.Mesh | null = null;

  constructor() {
    this.group.name = 'crime-heatmap';
    this.group.visible = false;
  }

  setVisible(v: boolean) {
    this.group.visible = v;
  }

  async load(): Promise<CrimeLoadResult> {
    try {
      const live = await fetchLive();
      if (live.length > 25) {
        this.points = live;
        this.source = 'live';
        this.finishLoad();
        return { points: live, source: 'live' };
      }
    } catch (err) {
      console.warn('[crime] live CFS fetch failed, using snapshot', err);
    }
    const res = await fetchWithRetry('data/crime-fallback.json');
    this.points = (await res.json()) as CrimePoint[];
    this.source = 'snapshot';
    this.finishLoad();
    return { points: this.points, source: 'snapshot' };
  }

  private finishLoad() {
    // top categories for the filter dropdown
    const counts = new Map<string, number>();
    for (const pt of this.points) counts.set(pt.p, (counts.get(pt.p) ?? 0) + 1);
    this.categories = [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 14)
      .map(([k]) => k);
    this.rebuild();
  }

  /** Aggregate points into grid cells and build the heat surface mesh. */
  rebuild(categoryFilter = '') {
    if (this.mesh) {
      this.group.remove(this.mesh);
      this.mesh.geometry.dispose();
      (this.mesh.material as THREE.Material).dispose();
      this.mesh = null;
    }

    const cells = new Map<string, number>();
    let maxCount = 1;
    for (const pt of this.points) {
      if (categoryFilter && pt.p !== categoryFilter) continue;
      const [x, z] = llToLocal(pt.x, pt.y);
      const cx = Math.floor(x / CELL_METERS);
      const cz = Math.floor(z / CELL_METERS);
      const key = cx + ':' + cz;
      const c = (cells.get(key) ?? 0) + 1;
      cells.set(key, c);
      if (c > maxCount) maxCount = c;
    }
    if (cells.size === 0) return;

    const ramp = [
      new THREE.Color(0xffdc5a), // low  — pale amber
      new THREE.Color(0xffb347), // mid  — orange
      new THREE.Color(0xff5c33), // high — red-orange
      new THREE.Color(0xd40f2c), // max  — crimson
    ];
    const colorFor = (t: number): THREE.Color => {
      const k = Math.min(0.999, Math.pow(t, 0.55)) * (ramp.length - 1);
      const i = Math.floor(k);
      return ramp[i].clone().lerp(ramp[i + 1], k - i);
    };

    const geoms: THREE.BufferGeometry[] = [];
    for (const [key, count] of cells) {
      const [cx, cz] = key.split(':').map(Number);
      const t = count / maxCount;
      const col = colorFor(t);
      const g = new THREE.PlaneGeometry(CELL_METERS * 0.96, CELL_METERS * 0.96);
      g.rotateX(-Math.PI / 2);
      g.translate((cx + 0.5) * CELL_METERS, 2.2 + t * 2, (cz + 0.5) * CELL_METERS);
      const n = g.getAttribute('position').count;
      const colors = new Float32Array(n * 4);
      const alpha = 0.16 + t * 0.65; // additive: sparse cells glow faintly, hotspots burn
      for (let i = 0; i < n; i++) {
        colors[i * 4] = col.r;
        colors[i * 4 + 1] = col.g;
        colors[i * 4 + 2] = col.b;
        colors[i * 4 + 3] = alpha;
      }
      g.setAttribute('color', new THREE.BufferAttribute(colors, 4));
      geoms.push(g);
    }

    const merged = mergeGeometries(geoms, false)!;
    geoms.forEach((g) => g.dispose());
    const mat = new THREE.MeshBasicMaterial({
      vertexColors: true,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
    });
    this.mesh = new THREE.Mesh(merged, mat);
    this.mesh.name = 'crime-heat-surface';
    this.mesh.renderOrder = 5;
    this.group.add(this.mesh);
  }
}
