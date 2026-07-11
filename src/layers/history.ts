import * as THREE from 'three';
import { localToLL } from '../geo/projection';

/**
 * Historical basemap drape + era model.
 *
 * Eras are keyframes on the timeline. Each may provide an ImageServer that
 * gets draped on a ground-aligned plane. Adding 1967 / 1921 later is just a
 * new entry here (see AGENTS.md Phase 2 — e.g. Sanborn footprints for
 * pre-aerial eras, NYT 1921 Greenwood GeoJSON).
 */
export interface Era {
  year: number;
  label: string;
  imageServer?: string;
}

export const ERAS: Era[] = [
  {
    year: 1943,
    label: '1943 aerial',
    imageServer: 'https://map11.incog.org/arcgis11wa/rest/services/Aerial_1943BW/ImageServer',
  },
  // TODO(phase2): { year: 1967, label: '1967 aerial', imageServer: ... }
  // TODO(phase2): { year: 1921, label: '1921 Greenwood (Sanborn/NYT data)' }
  { year: 2026, label: 'Today' },
];

const EXTENT_METERS = 4200; // half-size of the draped square around origin
const IMG_PIXELS = 2048;

export class HistoryLayer {
  private aerialPlane: THREE.Mesh;
  private aerialMat: THREE.MeshBasicMaterial;
  private loaded = false;
  private loading: Promise<void> | null = null;

  constructor(scene: THREE.Scene) {
    this.aerialMat = new THREE.MeshBasicMaterial({
      transparent: true,
      opacity: 0,
      depthWrite: false,
    });
    const geom = new THREE.PlaneGeometry(EXTENT_METERS * 2, EXTENT_METERS * 2);
    geom.rotateX(-Math.PI / 2);
    this.aerialPlane = new THREE.Mesh(geom, this.aerialMat);
    this.aerialPlane.position.y = 0.4; // just above the dark ground plane
    this.aerialPlane.name = 'aerial-1943';
    this.aerialPlane.visible = false;
    this.aerialPlane.renderOrder = 1;
    scene.add(this.aerialPlane);
  }

  /** Lazy-fetch the 1943 aerial the first time the user scrubs back. */
  private ensureLoaded(): Promise<void> {
    if (this.loaded) return Promise.resolve();
    if (this.loading) return this.loading;

    const era = ERAS.find((e) => e.imageServer);
    if (!era?.imageServer) return Promise.resolve();

    // plane corners → WGS84 bbox
    const [w, s] = localToLL(-EXTENT_METERS, EXTENT_METERS);
    const [e, n] = localToLL(EXTENT_METERS, -EXTENT_METERS);
    const url =
      `${era.imageServer}/exportImage?bbox=${w},${s},${e},${n}` +
      `&bboxSR=4326&imageSR=4326&size=${IMG_PIXELS},${IMG_PIXELS}&format=jpgpng&f=image`;

    this.loading = new Promise<void>((resolve) => {
      const loader = new THREE.TextureLoader();
      loader.load(
        url,
        (tex) => {
          tex.colorSpace = THREE.SRGBColorSpace;
          tex.anisotropy = 4;
          this.aerialMat.map = tex;
          this.aerialMat.needsUpdate = true;
          this.loaded = true;
          resolve();
        },
        undefined,
        () => {
          console.warn('[history] 1943 aerial exportImage failed');
          resolve();
        },
      );
    });
    return this.loading;
  }

  /**
   * Drive the visual blend for a timeline year.
   * Returns the building opacity the caller should apply.
   */
  async setYear(year: number): Promise<number> {
    const minYear = ERAS[0].year;
    const maxYear = ERAS[ERAS.length - 1].year;
    const t = (year - minYear) / (maxYear - minYear); // 0 = 1943, 1 = today

    // aerial: fully opaque at 1943, gone by ~mid-century scrub
    const aerialOpacity = Math.max(0, 1 - t * 2.2);
    if (aerialOpacity > 0) {
      await this.ensureLoaded();
      this.aerialPlane.visible = true;
      this.aerialMat.opacity = aerialOpacity;
    } else {
      this.aerialPlane.visible = false;
    }

    // modern buildings: ghosts at 1943 (0.12), solid today
    return 0.12 + 0.88 * t;
  }
}
