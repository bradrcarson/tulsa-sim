export interface ToolbarCallbacks {
  onBuildings(on: boolean): void;
  onStreets(on: boolean): void;
  onCrime(on: boolean): void;
  onCrimeFilter(category: string): void;
}

export function initToolbar(cb: ToolbarCallbacks) {
  const buildings = document.getElementById('tg-buildings') as HTMLInputElement;
  const streets = document.getElementById('tg-streets') as HTMLInputElement;
  const crime = document.getElementById('tg-crime') as HTMLInputElement;
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
