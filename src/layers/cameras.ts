import * as THREE from 'three';
import { llToLocal } from '../geo/projection';
import { fetchWithRetry } from '../data/cache';

/**
 * ODOT / OKtraffic highway camera markers.
 *
 * Discovery (see scripts/bake-data.mjs): oktraffic.org is an Angular app on
 * a LoopBack REST API — `https://oktraffic.org/api/MapCameras` returns all
 * ~800 statewide cameras with lat/lon/location. That endpoint sends no CORS
 * headers, so a snapshot filtered to the Tulsa metro bbox is baked into
 * public/data/cameras.json. In dev, a Vite proxy (/oktraffic-api) refreshes
 * the list live and falls back to the snapshot when unreachable.
 *
 * No public still-image URL pattern was found (streams are negotiated
 * per-session behind their video backend), so clicking a marker opens a
 * details card with a deep link into the OKtraffic map — documented in
 * README known-limitations.
 */
export interface CameraRec {
  id: number;
  lat: number;
  lon: number;
  loc: string;
  dir: string;
}

const MARKER_Y = 26; // float above the roadway like a signpost

export class CamerasLayer {
  group = new THREE.Group();
  cameras: CameraRec[] = [];
  source: 'live' | 'snapshot' = 'snapshot';
  private sprites: THREE.Points | null = null;
  private masts: THREE.LineSegments | null = null;

  constructor() {
    this.group.name = 'traffic-cameras';
    this.group.visible = false;
  }

  setVisible(v: boolean) {
    this.group.visible = v;
  }

  async load(): Promise<void> {
    // live refresh through the dev proxy first; snapshot fallback keeps the
    // layer working on static hosting
    try {
      const res = await fetch('/oktraffic-api/MapCameras', { signal: AbortSignal.timeout(8000) });
      if (res.ok) {
        const all: Array<Record<string, unknown>> = await res.json();
        const parsed = all
          .map((c) => ({
            id: Number(c.id),
            lat: Number(c.latitude),
            lon: Number(c.longitude),
            loc: String(c.location ?? ''),
            dir: String(c.direction ?? ''),
          }))
          .filter((c) => c.lat > 36.02 && c.lat < 36.25 && c.lon > -96.15 && c.lon < -95.75);
        if (parsed.length >= 5) {
          this.cameras = parsed;
          this.source = 'live';
        }
      }
    } catch {
      /* proxy unavailable (static hosting) — snapshot below */
    }
    if (!this.cameras.length) {
      const res = await fetchWithRetry('data/cameras.json');
      this.cameras = await res.json();
      this.source = 'snapshot';
    }
    this.build();
  }

  private build() {
    const n = this.cameras.length;
    const pos = new Float32Array(n * 3);
    const mastVerts = new Float32Array(n * 6);
    for (let i = 0; i < n; i++) {
      const [x, z] = llToLocal(this.cameras[i].lon, this.cameras[i].lat);
      pos[i * 3] = x;
      pos[i * 3 + 1] = MARKER_Y;
      pos[i * 3 + 2] = z;
      mastVerts[i * 6] = x;
      mastVerts[i * 6 + 1] = 0;
      mastVerts[i * 6 + 2] = z;
      mastVerts[i * 6 + 3] = x;
      mastVerts[i * 6 + 4] = MARKER_Y;
      mastVerts[i * 6 + 5] = z;
    }

    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const mat = new THREE.PointsMaterial({
      size: 30,
      sizeAttenuation: true,
      map: cameraSpriteTexture(),
      transparent: true,
      alphaTest: 0.08,
      depthWrite: false,
    });
    this.sprites = new THREE.Points(geom, mat);
    this.sprites.name = 'camera-billboards';
    this.sprites.renderOrder = 7;
    this.group.add(this.sprites);

    const mastGeom = new THREE.BufferGeometry();
    mastGeom.setAttribute('position', new THREE.BufferAttribute(mastVerts, 3));
    this.masts = new THREE.LineSegments(
      mastGeom,
      new THREE.LineBasicMaterial({ color: 0xffb347, transparent: true, opacity: 0.35 }),
    );
    this.group.add(this.masts);
  }

  /** Raycast pick — Points raycasting needs a generous threshold at city scale. */
  pick(raycaster: THREE.Raycaster): CameraRec | null {
    if (!this.group.visible || !this.sprites) return null;
    const prev = raycaster.params.Points.threshold;
    raycaster.params.Points.threshold = 22;
    const hits = raycaster.intersectObject(this.sprites, false);
    raycaster.params.Points.threshold = prev;
    const idx = hits[0]?.index;
    return idx !== undefined ? this.cameras[idx] : null;
  }

  oktrafficUrl(cam: CameraRec): string {
    return `https://oktraffic.org/#/map?lat=${cam.lat}&lon=${cam.lon}`;
  }
}

/** Procedural CCTV icon: warm rounded square + camera glyph. */
function cameraSpriteTexture(): THREE.Texture {
  const size = 96;
  const cv = document.createElement('canvas');
  cv.width = cv.height = size;
  const ctx = cv.getContext('2d')!;

  ctx.fillStyle = 'rgba(255, 156, 70, 0.95)';
  roundRect(ctx, 10, 10, size - 20, size - 20, 20);
  ctx.fill();
  ctx.strokeStyle = 'rgba(255, 226, 190, 0.9)';
  ctx.lineWidth = 4;
  roundRect(ctx, 10, 10, size - 20, size - 20, 20);
  ctx.stroke();

  // camera body + lens glyph
  ctx.fillStyle = '#1a1208';
  roundRect(ctx, 24, 34, 34, 26, 6);
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(58, 40);
  ctx.lineTo(74, 32);
  ctx.lineTo(74, 62);
  ctx.lineTo(58, 54);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = '#ffd9a8';
  ctx.beginPath();
  ctx.arc(41, 47, 6, 0, Math.PI * 2);
  ctx.fill();

  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
