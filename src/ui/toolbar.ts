export interface ToolbarCallbacks {
  onBuildings(on: boolean): void;
  onStreets(on: boolean): void;
  onCrime(on: boolean): void;
  onCrimeFilter(category: string): void;
  onBuses(on: boolean): void;
  onCameras(on: boolean): void;
  onNight(on: boolean): void;
}

/** Layer + display toggles now live inside the City Vitals panel. */
export function initToolbar(cb: ToolbarCallbacks) {
  const buildings = document.getElementById('tg-buildings') as HTMLInputElement;
  const streets = document.getElementById('tg-streets') as HTMLInputElement;
  const crime = document.getElementById('tg-crime') as HTMLInputElement;
  const buses = document.getElementById('tg-buses') as HTMLInputElement;
  const cameras = document.getElementById('tg-cameras') as HTMLInputElement;
  const night = document.getElementById('tg-night') as HTMLInputElement;
  const filter = document.getElementById('crime-filter') as HTMLSelectElement;
  const legend = document.getElementById('crime-legend')!;

  buildings.addEventListener('change', () => cb.onBuildings(buildings.checked));
  streets.addEventListener('change', () => cb.onStreets(streets.checked));
  crime.addEventListener('change', () => {
    cb.onCrime(crime.checked);
    filter.classList.toggle('visible', crime.checked);
    legend.classList.toggle('visible', crime.checked);
  });
  filter.addEventListener('change', () => cb.onCrimeFilter(filter.value));
  buses.addEventListener('change', () => cb.onBuses(buses.checked));
  cameras.addEventListener('change', () => cb.onCameras(cameras.checked));
  night.addEventListener('change', () => cb.onNight(night.checked));
}

export function populateCrimeCategories(categories: string[]) {
  const filter = document.getElementById('crime-filter') as HTMLSelectElement;
  for (const cat of categories) {
    const opt = document.createElement('option');
    opt.value = cat;
    opt.textContent = cat.length > 34 ? cat.slice(0, 32) + '…' : cat;
    filter.appendChild(opt);
  }
}

export function setCrimeSubtitle(text: string) {
  document.getElementById('crime-sub')!.textContent = text;
}

export function setStatus(text: string, busy = false) {
  document.getElementById('status-text')!.textContent = text;
  document.getElementById('status-dot')!.classList.toggle('busy', busy);
}

export function setSubtitle(text: string) {
  document.getElementById('brand-sub')!.textContent = text;
}
