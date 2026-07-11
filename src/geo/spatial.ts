/** Point-in-polygon (ray casting) on [lon,lat] rings. */
export function pointInRing(pt: [number, number], ring: [number, number][]): boolean {
  let inside = false;
  const [x, y] = pt;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

/** Point in polygon with holes: first ring outer, rest holes. */
export function pointInPolygon(pt: [number, number], rings: [number, number][][]): boolean {
  if (rings.length === 0) return false;
  if (!pointInRing(pt, rings[0])) return false;
  for (let i = 1; i < rings.length; i++) {
    if (pointInRing(pt, rings[i])) return false;
  }
  return true;
}

/**
 * Simple uniform grid spatial index over lon/lat bboxes.
 * Adequate for a few thousand parcels; swap for flatbush if metro-scale.
 */
export class GridIndex<T> {
  private cells = new Map<string, T[]>();
  constructor(private cellSizeDeg = 0.002) {}

  private key(cx: number, cy: number) {
    return cx + ':' + cy;
  }

  insert(item: T, bbox: [number, number, number, number]) {
    const [w, s, e, n] = bbox;
    const x0 = Math.floor(w / this.cellSizeDeg);
    const x1 = Math.floor(e / this.cellSizeDeg);
    const y0 = Math.floor(s / this.cellSizeDeg);
    const y1 = Math.floor(n / this.cellSizeDeg);
    for (let cx = x0; cx <= x1; cx++) {
      for (let cy = y0; cy <= y1; cy++) {
        const k = this.key(cx, cy);
        let arr = this.cells.get(k);
        if (!arr) {
          arr = [];
          this.cells.set(k, arr);
        }
        arr.push(item);
      }
    }
  }

  query(lon: number, lat: number): T[] {
    const k = this.key(Math.floor(lon / this.cellSizeDeg), Math.floor(lat / this.cellSizeDeg));
    return this.cells.get(k) ?? [];
  }
}
