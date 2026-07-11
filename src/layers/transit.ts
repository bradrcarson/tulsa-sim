import * as THREE from 'three';
import { llToLocal, METRO_BBOX } from '../geo/projection';
import { elevation } from '../geo/terrain';
import { fetchWithRetry } from '../data/cache';
import { decodeVehiclePositions, type BusPosition } from '../data/gtfsrt';

/**
 * Live Tulsa Transit buses via GTFS-Realtime.
 *
 * The feed serves `access-control-allow-origin: *`, so the browser polls it
 * directly (no proxy needed). Positions are decoded from protobuf by
 * src/data/gtfsrt.ts, filtered to the metro bbox, and rendered as an
 * instanced fleet: rounded bus bodies colored by route + heading arrows when
 * the feed provides a bearing. Poll cadence 15 s; the UI shows a stale flag
 * when the last successful update is older than 60 s.
 */
const FEED_URL = 'https://tulsa.rideralerts.com/InfoPoint/GTFS-Realtime.ashx?Type=VehiclePosition';
const POLL_MS = 15_000;
const STALE_MS = 60_000;
const MAX_BUSES = 256;
const BUS_Y = 3; // meters above ground so markers ride on the street ribbons

interface RouteMeta {
  short: string;
  long: string;
  color: string;
}

export interface TransitStatus {
  count: number;
  lastUpdate: number | null; // epoch ms of last successful poll
  stale: boolean;
  error: boolean;
}

/** Soft radial glow sprite for the beacon points. */
function glowTexture(): THREE.Texture {
  const size = 64;
  const cv = document.createElement('canvas');
  cv.width = cv.height = size;
  const ctx = cv.getContext('2d')!;
  const grad = ctx.createRadialGradient(size / 2, size / 2, 2, size / 2, size / 2, size / 2);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.35, 'rgba(255,255,255,0.45)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);
  return new THREE.CanvasTexture(cv);
}

/** Stable hue from a route id when GTFS static colors are unavailable. */
function routeFallbackColor(routeId: string): THREE.Color {
  let h = 0;
  for (let i = 0; i < routeId.length; i++) h = (h * 31 + routeId.charCodeAt(i)) >>> 0;
  return new THREE.Color().setHSL((h % 360) / 360, 0.75, 0.55);
}

export class TransitLayer {
  group = new THREE.Group();
  buses: BusPosition[] = [];
  private routes: Record<string, RouteMeta> = {};
  private bodies: THREE.InstancedMesh;
  private arrows: THREE.InstancedMesh;
  private beacons: THREE.Points;
  private beaconPos: Float32Array;
  private beaconCol: Float32Array;
  private timer: number | null = null;
  private lastUpdate: number | null = null;
  private lastError = false;
  private onStatus: ((s: TransitStatus) => void) | null = null;

  constructor() {
    this.group.name = 'transit-buses';
    this.group.visible = false;

    // bus body — box with slightly rounded feel via scaled sphere cap is
    // overkill; a 12×4×3.2 m box reads as "bus" at city scale
    const bodyGeom = new THREE.BoxGeometry(4, 3.2, 12);
    // basic (unlit) so route colors stay saturated in night mode
    const bodyMat = new THREE.MeshBasicMaterial();
    this.bodies = new THREE.InstancedMesh(bodyGeom, bodyMat, MAX_BUSES);
    this.bodies.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    // pre-create the color buffer: instanceColor added after first render
    // doesn't trigger a shader recompile, leaving instances black
    this.bodies.instanceColor = new THREE.InstancedBufferAttribute(
      new Float32Array(MAX_BUSES * 3).fill(1),
      3,
    );
    this.bodies.count = 0;
    this.group.add(this.bodies);

    // heading arrow — small cone ahead of the body
    const arrowGeom = new THREE.ConeGeometry(2.2, 5, 6);
    arrowGeom.rotateX(Math.PI / 2); // point along +Z (local forward)
    // per-instance route color (white blows out under night bloom)
    const arrowMat = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.8 });
    this.arrows = new THREE.InstancedMesh(arrowGeom, arrowMat, MAX_BUSES);
    this.arrows.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.arrows.instanceColor = new THREE.InstancedBufferAttribute(
      new Float32Array(MAX_BUSES * 3).fill(1),
      3,
    );
    this.arrows.count = 0;
    this.group.add(this.arrows);

    // additive glow beacon above each bus so the fleet reads from far zoom
    this.beaconPos = new Float32Array(MAX_BUSES * 3);
    this.beaconCol = new Float32Array(MAX_BUSES * 3);
    const beaconGeom = new THREE.BufferGeometry();
    beaconGeom.setAttribute('position', new THREE.BufferAttribute(this.beaconPos, 3));
    beaconGeom.setAttribute('color', new THREE.BufferAttribute(this.beaconCol, 3));
    beaconGeom.setDrawRange(0, 0);
    const beaconMat = new THREE.PointsMaterial({
      size: 18,
      sizeAttenuation: true,
      vertexColors: true,
      transparent: true,
      opacity: 0.55,
      map: glowTexture(),
      alphaTest: 0.01,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    this.beacons = new THREE.Points(beaconGeom, beaconMat);
    this.beacons.renderOrder = 6;
    this.beacons.frustumCulled = false;
    this.group.add(this.beacons);
  }

  routeLabel(routeId: string): string {
    const meta = this.routes[routeId];
    return meta ? `${meta.short} ${meta.long}` : routeId || '?';
  }

  /** Load baked GTFS static route metadata (colors / names). */
  async loadRoutes(): Promise<void> {
    try {
      const res = await fetchWithRetry('data/transit-routes.json');
      this.routes = await res.json();
    } catch (err) {
      console.warn('[transit] route metadata unavailable, hashing colors', err);
    }
  }

  setVisible(v: boolean) {
    this.group.visible = v;
    if (v) this.startPolling();
    else this.stopPolling();
  }

  onStatusChange(cb: (s: TransitStatus) => void) {
    this.onStatus = cb;
  }

  private emitStatus() {
    this.onStatus?.({
      count: this.buses.length,
      lastUpdate: this.lastUpdate,
      stale: this.lastUpdate !== null && Date.now() - this.lastUpdate > STALE_MS,
      error: this.lastError,
    });
  }

  startPolling() {
    if (this.timer !== null) return;
    const tick = () => void this.poll();
    tick();
    this.timer = window.setInterval(tick, POLL_MS);
  }

  stopPolling() {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async poll(): Promise<void> {
    try {
      const res = await fetchWithRetry(FEED_URL, { cache: 'no-store' }, 12_000);
      const buf = await res.arrayBuffer();
      const [w, s, e, n] = METRO_BBOX;
      this.buses = decodeVehiclePositions(buf)
        .filter((b) => b.lat > s && b.lat < n && b.lon > w && b.lon < e)
        .slice(0, MAX_BUSES);
      this.lastUpdate = Date.now();
      this.lastError = false;
      this.rebuildInstances();
    } catch (err) {
      // graceful fallback: keep last-known positions, flag the error
      console.warn('[transit] GTFS-RT poll failed', err);
      this.lastError = true;
    }
    this.emitStatus();
  }

  private rebuildInstances() {
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    // oversized ~2× for legibility at city zoom (nycsim-style markers)
    const scale = new THREE.Vector3(2.2, 2.2, 2.2);
    const up = new THREE.Vector3(0, 1, 0);
    let arrowCount = 0;

    for (let i = 0; i < this.buses.length; i++) {
      const bus = this.buses[i];
      const [x, z] = llToLocal(bus.lon, bus.lat);
      const busY = elevation(x, z) + BUS_Y;
      // GTFS bearing: degrees clockwise from north. Scene: north = -Z.
      const heading = bus.bearing !== null ? THREE.MathUtils.degToRad(-bus.bearing) + Math.PI : 0;
      q.setFromAxisAngle(up, heading);
      m.compose(new THREE.Vector3(x, busY, z), q, scale);
      this.bodies.setMatrixAt(i, m);

      const meta = this.routes[bus.routeId];
      const color = meta ? new THREE.Color('#' + meta.color) : routeFallbackColor(bus.routeId);
      // GTFS brand colors are tuned for white backgrounds — lift lightness
      // so the fleet stays legible against the night city
      const hsl = { h: 0, s: 0, l: 0 };
      color.getHSL(hsl);
      color.setHSL(hsl.h, Math.max(hsl.s, 0.6), Math.max(hsl.l, 0.58));
      this.bodies.setColorAt(i, color);

      this.beaconPos[i * 3] = x;
      this.beaconPos[i * 3 + 1] = busY + 22;
      this.beaconPos[i * 3 + 2] = z;
      this.beaconCol[i * 3] = color.r;
      this.beaconCol[i * 3 + 1] = color.g;
      this.beaconCol[i * 3 + 2] = color.b;

      if (bus.bearing !== null) {
        const fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(q).multiplyScalar(19);
        m.compose(new THREE.Vector3(x + fwd.x, busY, z + fwd.z), q, scale);
        this.arrows.setColorAt(arrowCount, color.clone().lerp(new THREE.Color(0xffffff), 0.35));
        this.arrows.setMatrixAt(arrowCount++, m);
      }
    }

    this.bodies.count = this.buses.length;
    this.bodies.instanceMatrix.needsUpdate = true;
    if (this.bodies.instanceColor) this.bodies.instanceColor.needsUpdate = true;
    this.arrows.count = arrowCount;
    this.arrows.instanceMatrix.needsUpdate = true;
    if (this.arrows.instanceColor) this.arrows.instanceColor.needsUpdate = true;
    this.beacons.geometry.setDrawRange(0, this.buses.length);
    this.beacons.geometry.attributes.position.needsUpdate = true;
    this.beacons.geometry.attributes.color.needsUpdate = true;
  }
}
