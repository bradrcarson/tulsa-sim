import type { TransitStatus } from '../layers/transit';

/**
 * City Vitals dashboard (nycsim-style right-side panel).
 * Widgets: live Tulsa clock, Open-Meteo weather, static metro population,
 * active layer count, transit + crime summaries. See AGENTS.md Phase 2 §1.
 */
const WEATHER_URL =
  'https://api.open-meteo.com/v1/forecast?latitude=36.154&longitude=-95.992' +
  '&current=temperature_2m,weather_code,wind_speed_10m&timezone=America%2FChicago';
const WEATHER_REFRESH_MS = 10 * 60 * 1000;

/** WMO weather interpretation codes → label + glyph. */
const WMO: Array<[number[], string, string]> = [
  [[0], 'Clear', '✦'],
  [[1, 2], 'Partly cloudy', '⛅'],
  [[3], 'Overcast', '☁'],
  [[45, 48], 'Fog', '🌫'],
  [[51, 53, 55, 56, 57], 'Drizzle', '🌦'],
  [[61, 63, 65, 66, 67], 'Rain', '🌧'],
  [[71, 73, 75, 77], 'Snow', '❄'],
  [[80, 81, 82], 'Showers', '🌧'],
  [[85, 86], 'Snow showers', '❄'],
  [[95, 96, 99], 'Thunderstorm', '⛈'],
];

function wmoLabel(code: number): [string, string] {
  for (const [codes, label, glyph] of WMO) {
    if (codes.includes(code)) return [label, glyph];
  }
  return ['—', ''];
}

const $ = (id: string) => document.getElementById(id)!;

export interface VitalsHandle {
  setLayerCount(n: number): void;
  setTransit(status: TransitStatus | null, enabled: boolean): void;
  setCrime(text: string): void;
  setCameras(text: string): void;
  setCoverage(text: string): void;
}

export function initVitals(): VitalsHandle {
  // ── live Tulsa clock ─────────────────────────────────────
  const clockTime = $('vt-clock');
  const clockDate = $('vt-date');
  const timeFmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  const dateFmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago',
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  });
  const tickClock = () => {
    const now = new Date();
    clockTime.textContent = timeFmt.format(now);
    clockDate.textContent = dateFmt.format(now) + ' · CT';
  };
  tickClock();
  setInterval(tickClock, 1000);

  // ── weather (Open-Meteo, no key) ─────────────────────────
  const wxTemp = $('vt-wx-temp');
  const wxCond = $('vt-wx-cond');
  const wxWind = $('vt-wx-wind');
  async function refreshWeather() {
    try {
      const res = await fetch(WEATHER_URL, { signal: AbortSignal.timeout(10_000) });
      const data = await res.json();
      const cur = data.current;
      const tempF = Math.round((cur.temperature_2m * 9) / 5 + 32);
      const [label, glyph] = wmoLabel(cur.weather_code);
      wxTemp.textContent = `${tempF}°F`;
      wxCond.textContent = `${glyph} ${label}`.trim();
      wxWind.textContent = `wind ${Math.round(cur.wind_speed_10m * 0.621)} mph`;
    } catch (err) {
      console.warn('[vitals] weather fetch failed', err);
      wxTemp.textContent = '—';
      wxCond.textContent = 'weather unavailable';
      wxWind.textContent = '';
    }
  }
  refreshWeather();
  setInterval(refreshWeather, WEATHER_REFRESH_MS);

  // ── collapsible on small screens ─────────────────────────
  $('vitals-collapse').addEventListener('click', () => {
    $('vitals').classList.toggle('collapsed');
  });

  const layersEl = $('vt-layers');
  const transitEl = $('vt-transit');
  const crimeEl = $('vt-crime');
  const camerasEl = $('vt-cameras');
  const coverageEl = $('vt-coverage');

  return {
    setLayerCount(n: number) {
      layersEl.textContent = `${n} layer${n === 1 ? '' : 's'} live`;
    },
    setTransit(status, enabled) {
      transitEl.classList.remove('warn');
      if (!enabled) {
        transitEl.textContent = 'buses off';
        return;
      }
      if (!status || status.lastUpdate === null) {
        transitEl.textContent = status?.error ? 'feed unavailable' : 'connecting…';
        if (status?.error) transitEl.classList.add('warn');
        return;
      }
      const age = Math.round((Date.now() - status.lastUpdate) / 1000);
      const staleFlag = status.stale ? ' · STALE' : '';
      transitEl.textContent =
        status.count > 0
          ? `${status.count} buses tracked · ${age}s ago${staleFlag}`
          : `no vehicles reporting · ${age}s ago${staleFlag}`;
      if (status.stale || status.error) transitEl.classList.add('warn');
    },
    setCrime(text: string) {
      crimeEl.textContent = text;
    },
    setCameras(text: string) {
      camerasEl.textContent = text;
    },
    setCoverage(text: string) {
      coverageEl.textContent = text;
    },
  };
}
