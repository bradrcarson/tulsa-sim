import * as THREE from 'three';
import { llToLocal } from '../geo/projection';
import { elevation } from '../geo/terrain';
import { MemoryCache, fetchWithRetry } from '../data/cache';

const PARCEL_SERVICE =
  'https://map11.incog.org/arcgis11wa/rest/services/Parcels_TulsaCo/FeatureServer/0/query';

const OUT_FIELDS = [
  'Owner',
  'PropertyAddress',
  'TotalAcctValue',
  'TaxableValue',
  'TotalLandValue',
  'TotalImpValue',
  'YearBuilt',
  'SalePrice',
  'SaleDate',
  'PropertyType',
  'ACCT_NUM',
].join(',');

export interface ParcelInfo {
  attributes: Record<string, unknown>;
  /** parcel polygon rings in [lon,lat] (WGS84) for outline highlight */
  rings: [number, number][][];
}

/**
 * Click-time spatial join against the INCOG assessor FeatureServer.
 * Results cached in-memory keyed by ~5 m grid so repeat clicks on the same
 * parcel are instant.
 *
 * NOTE: a GridIndex-based bulk prefetch of the visible area (src/geo/spatial.ts)
 * is the Phase 2 path once we draw parcel boundaries persistently.
 */
export class ParcelsLayer {
  private cache = new MemoryCache<ParcelInfo | null>(30 * 60 * 1000);
  private highlight: THREE.Group;

  constructor(scene: THREE.Scene) {
    this.highlight = new THREE.Group();
    this.highlight.name = 'parcel-highlight';
    scene.add(this.highlight);
  }

  clearHighlight() {
    for (const child of [...this.highlight.children]) {
      this.highlight.remove(child);
      (child as THREE.Line).geometry?.dispose();
    }
  }

  showHighlight(rings: [number, number][][]) {
    this.clearHighlight();
    const mat = new THREE.LineBasicMaterial({ color: 0x46b4ff, linewidth: 2 });
    for (const ring of rings) {
      const pts = ring.map(([lon, lat]) => {
        const [x, z] = llToLocal(lon, lat);
        return new THREE.Vector3(x, elevation(x, z) + 2.0, z);
      });
      const geom = new THREE.BufferGeometry().setFromPoints(pts);
      this.highlight.add(new THREE.LineLoop(geom, mat));
    }
  }

  async queryAt(lon: number, lat: number): Promise<ParcelInfo | null> {
    const key = lon.toFixed(5) + ',' + lat.toFixed(5);
    const cached = this.cache.get(key);
    if (cached !== undefined) return cached;

    const params = new URLSearchParams({
      geometry: `${lon},${lat}`,
      geometryType: 'esriGeometryPoint',
      inSR: '4326',
      spatialRel: 'esriSpatialRelIntersects',
      outFields: OUT_FIELDS,
      returnGeometry: 'true',
      outSR: '4326',
      f: 'json',
    });

    const res = await fetchWithRetry(`${PARCEL_SERVICE}?${params}`);
    const data = await res.json();
    // Overlapping ROW/utility slivers often carry no assessor attributes;
    // prefer the first feature that actually has an owner or valuation.
    const feats: Array<{
      attributes?: Record<string, unknown>;
      geometry?: { rings?: [number, number][][] };
    }> = data?.features ?? [];
    const feat =
      feats.find((f) => f.attributes?.['Owner'] || f.attributes?.['TotalAcctValue']) ?? feats[0];
    if (!feat) {
      this.cache.set(key, null);
      return null;
    }
    const info: ParcelInfo = {
      attributes: feat.attributes ?? {},
      rings: (feat.geometry?.rings ?? []) as [number, number][][],
    };
    this.cache.set(key, info);
    return info;
  }
}
