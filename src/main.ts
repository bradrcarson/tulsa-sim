import * as THREE from 'three';
import { createScene } from './scene/scene';
import { MetroBuildingsLayer } from './layers/metro-buildings';
import { MetroStreetsLayer } from './layers/metro-streets';
import { TerrainLayer } from './layers/terrain';
import { ParcelsLayer } from './layers/parcels';
import { CrimeLayer } from './layers/crime';
import { HistoryLayer } from './layers/history';
import { TransitLayer } from './layers/transit';
import { CamerasLayer } from './layers/cameras';
import { PhotorealLayer, getStoredKey, storeKey } from './layers/photoreal';
import { localToLL, llToLocal } from './geo/projection';
import { loadTerrain, terrainReady, elevation } from './geo/terrain';
import {
  initPopup,
  showLoading,
  showParcel,
  showNoParcel,
  showError,
  showCamera,
  hidePopup,
} from './ui/popup';
import { initTimeline } from './ui/timeline';
import { initToolbar, populateCrimeCategories, setCrimeSubtitle, setStatus, setSubtitle } from './ui/toolbar';
import { initSearch } from './ui/search';
import { initVitals } from './ui/vitals';
import { initConcierge } from './ui/concierge';

const app = document.getElementById('app')!;
const city = createScene(app);

const terrain = new TerrainLayer();
const buildings = new MetroBuildingsLayer();
const streets = new MetroStreetsLayer();
const crime = new CrimeLayer();
const parcels = new ParcelsLayer(city.scene);
const history = new HistoryLayer(terrain);
const transit = new TransitLayer();
const cameras = new CamerasLayer();
const photoreal = new PhotorealLayer(city.camera, city.renderer, (msg) => setStatus(msg));

city.scene.add(terrain.group);
city.scene.add(buildings.group);
city.scene.add(streets.group);
city.scene.add(crime.group);
city.scene.add(transit.group);
city.scene.add(cameras.group);
city.scene.add(photoreal.group);

// ── UI wiring ────────────────────────────────────────────────
initPopup();
initSearch((x, z) => city.flyTo(x, z));
const vitals = initVitals();
initConcierge();

// active-layer accounting for the vitals panel
const layerState = new Map<string, boolean>([
  ['buildings', true],
  ['streets', true],
  ['crime', false],
  ['buses', false],
  ['cameras', false],
]);
function markLayer(name: string, on: boolean) {
  layerState.set(name, on);
  vitals.setLayerCount([...layerState.values()].filter(Boolean).length);
}
markLayer('buildings', true);

let lastTransitStatus: Parameters<typeof vitals.setTransit>[0] = null;
transit.onStatusChange((s) => {
  lastTransitStatus = s;
  vitals.setTransit(s, layerState.get('buses') ?? false);
  const sub = document.getElementById('buses-sub')!;
  if (s.lastUpdate !== null) {
    sub.textContent = s.count > 0 ? `${s.count} tracked · GTFS-RT` : 'no vehicles reporting';
  } else if (s.error) {
    sub.textContent = 'feed unavailable';
  }
});
// keep the "Xs ago" fresh even between polls
setInterval(() => {
  if (layerState.get('buses')) vitals.setTransit(lastTransitStatus, true);
}, 5000);

function applyNight(on: boolean) {
  city.setNightMode(on);
  buildings.setNightMode(on);
  streets.setNightMode(on);
  terrain.setNightMode(on);
}

// ── photoreal mode (optional Google Maps Platform key) ───────
const photoToggle = document.getElementById('tg-photoreal') as HTMLInputElement;
const photoKeyWrap = document.getElementById('photoreal-key-wrap')!;
const photoKeyInput = document.getElementById('photoreal-key') as HTMLInputElement;
photoKeyInput.value = getStoredKey();

function setPhotoreal(on: boolean) {
  const key = photoKeyInput.value.trim();
  if (on && !key) {
    photoKeyWrap.classList.add('visible', 'needs-key');
    photoToggle.checked = false;
    return;
  }
  if (on) {
    storeKey(key);
    if (!photoreal.enable(key)) return;
    // photogrammetry replaces the procedural ground + buildings; data
    // overlays (buses, cameras, crime, parcel picking) stay on top
    buildings.setVisible(false);
    terrain.group.visible = false;
    document.getElementById('photoreal-sub')!.textContent = 'streaming · Google';
  } else {
    photoreal.disable();
    buildings.setVisible(layerState.get('buildings') ?? true);
    terrain.group.visible = true;
    document.getElementById('photoreal-sub')!.textContent = 'needs Google Maps key';
  }
}
photoToggle.addEventListener('change', () => {
  photoKeyWrap.classList.toggle('visible', photoToggle.checked || !photoKeyInput.value);
  setPhotoreal(photoToggle.checked);
});
photoKeyInput.addEventListener('change', () => {
  storeKey(photoKeyInput.value.trim());
  if (photoToggle.checked) setPhotoreal(true);
});

initToolbar({
  onBuildings: (on) => {
    if (!photoreal.active) buildings.setVisible(on);
    markLayer('buildings', on);
  },
  onStreets: (on) => {
    streets.setVisible(on);
    markLayer('streets', on);
  },
  onCrime: (on) => {
    crime.setVisible(on);
    markLayer('crime', on);
  },
  onCrimeFilter: (cat) => crime.rebuild(cat),
  onBuses: (on) => {
    transit.setVisible(on);
    markLayer('buses', on);
    vitals.setTransit(lastTransitStatus, on);
  },
  onCameras: (on) => {
    cameras.setVisible(on);
    markLayer('cameras', on);
  },
  onNight: applyNight,
});

let currentYear = 2026;
initTimeline(async (year) => {
  if (year === currentYear) return;
  currentYear = year;
  const buildingOpacity = await history.setYear(year);
  buildings.setOpacity(buildingOpacity);
});

// ── Click → camera pick or parcel spatial join ───────────────
const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
let downAt: [number, number] | null = null;

city.renderer.domElement.addEventListener('pointerdown', (ev) => {
  downAt = [ev.clientX, ev.clientY];
});

city.renderer.domElement.addEventListener('pointerup', async (ev) => {
  // ignore drags (orbit)
  if (!downAt) return;
  const dx = ev.clientX - downAt[0];
  const dy = ev.clientY - downAt[1];
  downAt = null;
  if (dx * dx + dy * dy > 25) return;

  pointer.x = (ev.clientX / window.innerWidth) * 2 - 1;
  pointer.y = -(ev.clientY / window.innerHeight) * 2 + 1;
  raycaster.setFromCamera(pointer, city.camera);

  // traffic camera markers take priority when their layer is on
  const cam = cameras.pick(raycaster);
  if (cam) {
    parcels.clearHighlight();
    showCamera(cam, cameras.oktrafficUrl(cam));
    return;
  }

  const targets: THREE.Object3D[] = [...terrain.raycastTargets, city.groundPlane];
  if (buildings.group.visible) targets.push(buildings.group);
  if (photoreal.active) targets.push(photoreal.group);
  const hits = raycaster.intersectObjects(targets, true);
  if (!hits.length) return;

  const pt = hits[0].point;
  const [lon, lat] = localToLL(pt.x, pt.z);

  showLoading();
  setStatus('querying INCOG assessor…', true);
  try {
    const info = await parcels.queryAt(lon, lat);
    if (info) {
      showParcel(info);
      parcels.showHighlight(info.rings);
    } else {
      showNoParcel();
      parcels.clearHighlight();
    }
  } catch (err) {
    console.warn('[parcels] query failed', err);
    showError();
  } finally {
    setStatus('ready');
  }
});

document.getElementById('popup-close')!.addEventListener('click', () => {
  parcels.clearHighlight();
  hidePopup();
});

// ── Data loading ─────────────────────────────────────────────
async function boot() {
  setStatus('loading terrain…', true);
  await loadTerrain().catch((e) => console.error('[terrain]', e));
  await terrain.load().catch((e) => console.error('[terrain]', e));
  applyNight(true);

  setStatus('streaming metro tiles…', true);
  await Promise.all([
    buildings.load().catch((e) => console.error('[buildings]', e)),
    streets.load().catch((e) => console.error('[streets]', e)),
    transit.loadRoutes(),
  ]);
  setStatus(`${buildings.count.toLocaleString()} buildings · Tulsa metro`);
  setSubtitle('3D digital twin · Tulsa metro');
  vitals.setCoverage('full metro');

  // crime loads in the background; toggle works once it lands
  crime
    .load()
    .then(({ points, source }) => {
      populateCrimeCategories(crime.categories);
      const label =
        source === 'live'
          ? `${points.length.toLocaleString()} calls · last 90 days`
          : `${points.length.toLocaleString()} incidents · TPD snapshot`;
      setCrimeSubtitle(label);
      vitals.setCrime(
        source === 'live' ? `${points.length.toLocaleString()} calls` : `${points.length.toLocaleString()} (snapshot)`,
      );
    })
    .catch((e) => {
      console.error('[crime]', e);
      setCrimeSubtitle('crime data unavailable');
      vitals.setCrime('unavailable');
    });

  cameras
    .load()
    .then(() => {
      const sub = document.getElementById('cameras-sub')!;
      sub.textContent = `${cameras.cameras.length} in metro · ${cameras.source}`;
      vitals.setCameras(`${cameras.cameras.length} ODOT`);
    })
    .catch((e) => {
      console.error('[cameras]', e);
      vitals.setCameras('unavailable');
    });
}

const booted = boot();

// ── Debug/test hook (used by scripts/verify.mjs) ─────────────
Object.assign(window as unknown as Record<string, unknown>, {
  __sim: {
    flyToLL: (lon: number, lat: number, dist?: number) => {
      const [x, z] = llToLocal(lon, lat);
      city.flyTo(x, z, dist);
    },
    /** Project a lat/lon (at marker height) to CSS pixel coordinates. */
    screenPos: (lon: number, lat: number, y = 26) => {
      const [x, z] = llToLocal(lon, lat);
      const v = new THREE.Vector3(x, y, z).project(city.camera);
      return {
        x: ((v.x + 1) / 2) * window.innerWidth,
        y: ((1 - v.y) / 2) * window.innerHeight,
      };
    },
    cameras: () => cameras.cameras,
    buses: () => transit.buses,
    tileStats: () => ({ tiles: buildings.loadedTiles, buildings: buildings.count }),
    fps: () => city.fps,
    renderInfo: () => ({
      calls: city.renderer.info.render.calls,
      triangles: city.renderer.info.render.triangles,
      geometries: city.renderer.info.memory.geometries,
    }),
    elevationAt: (lon: number, lat: number) => {
      if (!terrainReady()) return null;
      const [x, z] = llToLocal(lon, lat);
      return elevation(x, z);
    },
  },
});

// ── Intro fly-through (skippable with any input) ─────────────
const introHint = document.getElementById('intro-hint')!;
void booted.then(() => city.playIntro(() => introHint.classList.add('gone')));

// ── Render loop ──────────────────────────────────────────────
city.renderer.setAnimationLoop(() => {
  city.controls.update();
  const t = city.controls.target;
  void buildings.update(t.x, t.z);
  void streets.update(t.x, t.z);
  photoreal.update();
  city.render();
});
