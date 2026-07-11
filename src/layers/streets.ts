import * as THREE from 'three';
import { llToLocal } from '../geo/projection';
import { fetchWithRetry } from '../data/cache';

interface StreetRec {
  c: [number, number][]; // polyline [lon,lat]
  t: string; // highway class
}

/** Glowing street grid, colored by road class (nycsim vibe). */
const CLASS_STYLE: Record<string, { color: number; y: number }> = {
  motorway: { color: 0xffb347, y: 1.2 },
  motorway_link: { color: 0xcc8833, y: 1.1 },
  trunk: { color: 0xffa040, y: 1.0 },
  trunk_link: { color: 0xbb7733, y: 0.9 },
  primary: { color: 0x6fd3ff, y: 0.8 },
  primary_link: { color: 0x55a0cc, y: 0.7 },
  secondary: { color: 0x4a90c4, y: 0.6 },
  secondary_link: { color: 0x3d7aa8, y: 0.5 },
  tertiary: { color: 0x3a6a94, y: 0.4 },
  residential: { color: 0x2b4a66, y: 0.3 },
  unclassified: { color: 0x263f57, y: 0.3 },
  service: { color: 0x1d3044, y: 0.2 },
};

export class StreetsLayer {
  group = new THREE.Group();
  private materials: THREE.LineBasicMaterial[] = [];

  constructor() {
    this.group.name = 'streets';
  }

  setVisible(v: boolean) {
    this.group.visible = v;
  }

  /** Night mode: intensify the glow; day mode: mute it so roads read as asphalt. */
  setNightMode(on: boolean) {
    for (const mat of this.materials) {
      const base = mat.userData.baseOpacity as number;
      mat.opacity = on ? base : base * 0.45;
    }
  }

  async load(url = 'data/streets.json'): Promise<void> {
    const res = await fetchWithRetry(url);
    const recs: StreetRec[] = await res.json();

    // one LineSegments per class bucket for minimal draw calls
    const buckets = new Map<string, number[]>();
    for (const rec of recs) {
      const style = CLASS_STYLE[rec.t] ?? CLASS_STYLE.service;
      const key = rec.t in CLASS_STYLE ? rec.t : 'service';
      let arr = buckets.get(key);
      if (!arr) {
        arr = [];
        buckets.set(key, arr);
      }
      for (let i = 0; i < rec.c.length - 1; i++) {
        const [x1, z1] = llToLocal(rec.c[i][0], rec.c[i][1]);
        const [x2, z2] = llToLocal(rec.c[i + 1][0], rec.c[i + 1][1]);
        arr.push(x1, style.y, z1, x2, style.y, z2);
      }
    }

    for (const [cls, verts] of buckets) {
      const style = CLASS_STYLE[cls];
      const geom = new THREE.BufferGeometry();
      geom.setAttribute('position', new THREE.BufferAttribute(new Float32Array(verts), 3));
      const isMajor = ['motorway', 'trunk', 'primary'].includes(cls);
      const mat = new THREE.LineBasicMaterial({
        color: style.color,
        transparent: true,
        opacity: isMajor ? 0.95 : 0.55,
      });
      mat.userData.baseOpacity = mat.opacity;
      this.materials.push(mat);
      const lines = new THREE.LineSegments(geom, mat);
      lines.name = 'streets-' + cls;
      this.group.add(lines);
    }
  }
}
