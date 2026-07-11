/**
 * Tiny in-memory cache with TTL. Parcel attributes and aerial tiles are
 * cached here after first fetch so repeat clicks / scrubs are instant.
 * TODO(phase2): back with IndexedDB for persistence across sessions.
 */
export class MemoryCache<T> {
  private store = new Map<string, { value: T; expires: number }>();
  constructor(private ttlMs = 15 * 60 * 1000) {}

  get(key: string): T | undefined {
    const hit = this.store.get(key);
    if (!hit) return undefined;
    if (Date.now() > hit.expires) {
      this.store.delete(key);
      return undefined;
    }
    return hit.value;
  }

  set(key: string, value: T) {
    this.store.set(key, { value, expires: Date.now() + this.ttlMs });
  }

  has(key: string): boolean {
    return this.get(key) !== undefined;
  }
}

/** fetch with a single retry (per AGENTS.md guidance). */
export async function fetchWithRetry(url: string, init?: RequestInit, timeoutMs = 20000): Promise<Response> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), timeoutMs);
      const res = await fetch(url, { ...init, signal: ctrl.signal });
      clearTimeout(t);
      if (res.ok) return res;
      if (attempt === 1) return res;
    } catch (err) {
      if (attempt === 1) throw err;
    }
    await new Promise((r) => setTimeout(r, 800));
  }
  throw new Error('unreachable');
}
