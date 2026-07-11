import * as THREE from 'three';
import type { TerrainLayer } from './terrain';

/**
 * Historical basemap drape + era model.
 *
 * Eras are keyframes on the timeline. Each may provide an ImageServer whose
 * export gets draped onto the terrain inset (Phase 3: follows real relief
 * instead of a flat plane). Adding 1967 / 1921 later is just a new entry
 * here (see AGENTS.md — e.g. Sanborn footprints, NYT 1921 Greenwood data).
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
  // TODO(phase4): { year: 1967, label: '1967 aerial', imageServer: ... }
  // TODO(phase4): { year: 1921, label: '1921 Greenwood (Sanborn/NYT data)' }
  { year: 2026, label: 'Today' },
];

const IMG_PIXELS = 2048;

export class HistoryLayer {
  private texture: THREE.Texture | null = null;
  private loading: Promise<void> | null = null;

  constructor(private terrain: TerrainLayer) {}

  /** Lazy-fetch the 1943 aerial the first time the user scrubs back. */
  private ensureLoaded(): Promise<void> {
    if (this.texture) return Promise.resolve();
    if (this.loading) return this.loading;

    const era = ERAS.find((e) => e.imageServer);
    if (!era?.imageServer) return Promise.resolve();

    const [w, s, e, n] = this.terrain.insetBboxLL();
    const url =
      `${era.imageServer}/exportImage?bbox=${w},${s},${e},${n}` +
      `&bboxSR=4326&imageSR=4326&size=${IMG_PIXELS},${IMG_PIXELS}&format=jpgpng&f=image`;

    this.loading = new THREE.TextureLoader()
      .loadAsync(url)
      .then((tex) => {
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.anisotropy = 4;
        this.texture = tex;
      })
      .catch(() => {
        console.warn('[history] 1943 aerial exportImage failed');
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
      this.terrain.setHistoric(this.texture, this.texture ? aerialOpacity : 0);
    } else {
      this.terrain.setHistoric(this.texture, 0);
    }

    // modern buildings: ghosts at 1943, solid today
    return 0.22 + 0.78 * t;
  }
}
