import * as THREE from 'three';
import { TilesRenderer } from '3d-tiles-renderer';
import { GoogleCloudAuthPlugin, GLTFExtensionsPlugin } from '3d-tiles-renderer/plugins';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { ORIGIN } from '../geo/projection';

/**
 * Google Photorealistic 3D Tiles mode (Phase 3, optional).
 *
 * True photogrammetry of Tulsa — real trees, real facades — streamed as
 * 3D Tiles and re-based from ECEF into the local ENU scene frame so it
 * aligns with the procedural layers (buses, cameras, crime, parcels still
 * work on top of it).
 *
 * Requires a Google Maps Platform API key with the Map Tiles API enabled
 * (generous free tier; nothing is committed to the repo — the key is kept
 * in localStorage only). Without a key the toggle shows a hint instead.
 */
const LS_KEY = 'tulsa-sim.google-tiles-key';

// Tulsa geoid height (EGM96) ≈ -26.6 m; downtown ground ≈ 194 m NAVD88.
// Ellipsoidal height of the scene origin ≈ 194 - 26.6.
const ORIGIN_ELLIPSOID_H = 167.4;
const WGS84_A = 6378137;
const WGS84_E2 = 6.69437999014e-3;

export function getStoredKey(): string {
  try {
    return localStorage.getItem(LS_KEY) ?? '';
  } catch {
    return '';
  }
}

export function storeKey(key: string) {
  try {
    if (key) localStorage.setItem(LS_KEY, key);
    else localStorage.removeItem(LS_KEY);
  } catch {
    /* private mode */
  }
}

/** lat/lon/ellipsoidal-h → ECEF. */
function llhToEcef(latDeg: number, lonDeg: number, h: number): THREE.Vector3 {
  const lat = (latDeg * Math.PI) / 180;
  const lon = (lonDeg * Math.PI) / 180;
  const sinLat = Math.sin(lat);
  const cosLat = Math.cos(lat);
  const N = WGS84_A / Math.sqrt(1 - WGS84_E2 * sinLat * sinLat);
  return new THREE.Vector3(
    (N + h) * cosLat * Math.cos(lon),
    (N + h) * cosLat * Math.sin(lon),
    (N * (1 - WGS84_E2) + h) * sinLat,
  );
}

/** ECEF → local scene frame (x=east, y=up, z=south) at the downtown origin. */
function ecefToSceneMatrix(): THREE.Matrix4 {
  const lat = (ORIGIN.lat * Math.PI) / 180;
  const lon = (ORIGIN.lon * Math.PI) / 180;
  const east = new THREE.Vector3(-Math.sin(lon), Math.cos(lon), 0);
  const north = new THREE.Vector3(
    -Math.sin(lat) * Math.cos(lon),
    -Math.sin(lat) * Math.sin(lon),
    Math.cos(lat),
  );
  const up = new THREE.Vector3(
    Math.cos(lat) * Math.cos(lon),
    Math.cos(lat) * Math.sin(lon),
    Math.sin(lat),
  );
  const originEcef = llhToEcef(ORIGIN.lat, ORIGIN.lon, ORIGIN_ELLIPSOID_H);
  // scene basis in ECEF coordinates: X=east, Y=up, Z=-north (south)
  const basis = new THREE.Matrix4().makeBasis(east, up, north.clone().negate());
  basis.setPosition(originEcef);
  return basis.invert(); // ECEF point → scene point
}

export class PhotorealLayer {
  group = new THREE.Group();
  active = false;
  private tiles: TilesRenderer | null = null;
  private camera: THREE.Camera;
  private renderer: THREE.WebGLRenderer;
  private onStatus: (msg: string) => void;

  constructor(
    camera: THREE.Camera,
    renderer: THREE.WebGLRenderer,
    onStatus: (msg: string) => void = () => {},
  ) {
    this.camera = camera;
    this.renderer = renderer;
    this.onStatus = onStatus;
    this.group.name = 'photoreal-tiles';
    this.group.visible = false;
  }

  /** Enable with an API key. Returns false if no key was provided. */
  enable(apiKey: string): boolean {
    if (!apiKey) return false;
    if (!this.tiles) {
      const tiles = new TilesRenderer();
      tiles.registerPlugin(new GoogleCloudAuthPlugin({ apiToken: apiKey, autoRefreshToken: true }));
      const draco = new DRACOLoader();
      draco.setDecoderPath('https://www.gstatic.com/draco/versioned/decoders/1.5.7/');
      tiles.registerPlugin(new GLTFExtensionsPlugin({ dracoLoader: draco }));
      tiles.setCamera(this.camera);
      tiles.setResolutionFromRenderer(this.camera, this.renderer);
      tiles.errorTarget = 20;
      tiles.group.matrixAutoUpdate = false;
      tiles.group.matrix.copy(ecefToSceneMatrix());
      tiles.addEventListener('load-error' as never, () => {
        this.onStatus('Google 3D Tiles failed — check the API key / Map Tiles API');
      });
      this.group.add(tiles.group);
      this.tiles = tiles;
    }
    this.active = true;
    this.group.visible = true;
    this.onStatus('streaming Google photorealistic tiles…');
    return true;
  }

  disable() {
    this.active = false;
    this.group.visible = false;
  }

  /** Call every frame while active. */
  update() {
    if (this.active && this.tiles) {
      this.tiles.setResolutionFromRenderer(this.camera as THREE.PerspectiveCamera, this.renderer);
      this.tiles.update();
    }
  }
}
