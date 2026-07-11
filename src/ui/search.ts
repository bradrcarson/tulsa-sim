import { llToLocal, DOWNTOWN_BBOX } from '../geo/projection';

/**
 * Fly-to search: hardcoded downtown landmarks answer instantly; anything
 * else falls through to Nominatim geocoding scoped to the Tulsa viewbox.
 */
const LANDMARKS: Array<{ name: string; lon: number; lat: number }> = [
  { name: 'Centennial Green', lon: -95.9891, lat: 36.1524 },
  { name: "Cain's Ballroom", lon: -95.9898, lat: 36.1614 },
  { name: 'Greenwood District', lon: -95.9862, lat: 36.1622 },
  { name: 'BOK Tower', lon: -95.9926, lat: 36.1563 },
  { name: 'BOK Center', lon: -95.9945, lat: 36.1528 },
  { name: 'Tulsa Union Depot', lon: -95.9903, lat: 36.1574 },
  { name: 'Philtower', lon: -95.9899, lat: 36.1533 },
  { name: 'Blue Dome District', lon: -95.9868, lat: 36.1553 },
  { name: 'Tulsa Arts District', lon: -95.9915, lat: 36.1600 },
  { name: 'ONEOK Field', lon: -95.9853, lat: 36.1600 },
];

export function initSearch(flyTo: (x: number, z: number) => void) {
  const input = document.getElementById('search') as HTMLInputElement;
  const results = document.getElementById('search-results')!;

  const close = () => {
    results.classList.remove('open');
    results.innerHTML = '';
  };

  const go = (lon: number, lat: number) => {
    const [x, z] = llToLocal(lon, lat);
    flyTo(x, z);
    close();
    input.blur();
  };

  const renderMatches = (matches: Array<{ name: string; lon: number; lat: number }>, hint?: string) => {
    results.innerHTML = '';
    for (const m of matches.slice(0, 6)) {
      const btn = document.createElement('button');
      btn.textContent = m.name;
      btn.addEventListener('click', () => go(m.lon, m.lat));
      results.appendChild(btn);
    }
    if (hint) {
      const div = document.createElement('div');
      div.className = 'hint';
      div.textContent = hint;
      results.appendChild(div);
    }
    results.classList.toggle('open', results.children.length > 0);
  };

  input.addEventListener('input', () => {
    const q = input.value.trim().toLowerCase();
    if (!q) return close();
    const matches = LANDMARKS.filter((l) => l.name.toLowerCase().includes(q));
    renderMatches(matches, matches.length ? undefined : 'press Enter to geocode');
  });

  input.addEventListener('keydown', async (ev) => {
    if (ev.key !== 'Enter') return;
    const q = input.value.trim();
    if (!q) return;
    const local = LANDMARKS.find((l) => l.name.toLowerCase().includes(q.toLowerCase()));
    if (local) return go(local.lon, local.lat);

    renderMatches([], 'geocoding…');
    try {
      const [w, s, e, n] = DOWNTOWN_BBOX;
      const url =
        `https://nominatim.openstreetmap.org/search?format=json&limit=5&q=${encodeURIComponent(q + ', Tulsa, OK')}` +
        `&viewbox=${w},${n},${e},${s}`;
      const res = await fetch(url, { headers: { Accept: 'application/json' } });
      const data: Array<{ display_name: string; lon: string; lat: string }> = await res.json();
      if (!data.length) return renderMatches([], 'no results');
      renderMatches(
        data.map((d) => ({
          name: d.display_name.split(',').slice(0, 3).join(','),
          lon: Number(d.lon),
          lat: Number(d.lat),
        })),
      );
    } catch {
      renderMatches([], 'geocoding failed');
    }
  });

  document.addEventListener('click', (ev) => {
    if (!(ev.target as HTMLElement).closest('#search-wrap')) close();
  });
}
