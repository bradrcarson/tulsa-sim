import * as THREE from 'three';
import { createScene } from './scene/scene';
import { BuildingsLayer } from './layers/buildings';
import { StreetsLayer } from './layers/streets';
import { ParcelsLayer } from './layers/parcels';
import { CrimeLayer } from './layers/crime';
import { HistoryLayer } from './layers/history';
import { localToLL } from './geo/projection';
import { initPopup, showLoading, showParcel, showNoParcel, showError, hidePopup } from './ui/popup';
import { initTimeline } from './ui/timeline';
import { initToolbar, populateCrimeCategories, setCrimeSubtitle, setStatus } from './ui/toolbar';
import { initSearch } from './ui/search';

const app = document.getElementById('app')!;
const city = createScene(app);

const buildings = new BuildingsLayer();
const streets = new StreetsLayer();
const crime = new CrimeLayer();
const parcels = new ParcelsLayer(city.scene);
const history = new HistoryLayer(city.scene);

city.scene.add(buildings.group);
city.scene.add(streets.group);
city.scene.add(crime.group);

// ── UI wiring ────────────────────────────────────────────────
initPopup();
initSearch((x, z) => city.flyTo(x, z));

initToolbar({
  onBuildings: (on) => buildings.setVisible(on),
  onStreets: (on) => streets.setVisible(on),
  onCrime: (on) => crime.setVisible(on),
  onCrimeFilter: (cat) => crime.rebuild(cat),
});

let currentYear = 2026;
initTimeline(async (year) => {
  if (year === currentYear) return;
  currentYear = year;
  const buildingOpacity = await history.setYear(year);
  buildings.setOpacity(buildingOpacity);
});

// ── Click → parcel spatial join ──────────────────────────────
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

  const targets: THREE.Object3D[] = [city.groundPlane];
  if (buildings.group.visible) targets.push(buildings.group);
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
  setStatus('loading buildings + streets…', true);
  await Promise.all([
    buildings.load().catch((e) => console.error('[buildings]', e)),
    streets.load().catch((e) => console.error('[streets]', e)),
  ]);
  setStatus(`${buildings.count.toLocaleString()} buildings · downtown Tulsa`);

  // crime loads in the background; toggle works once it lands
  crime
    .load()
    .then(({ points, source }) => {
      populateCrimeCategories(crime.categories);
      setCrimeSubtitle(
        source === 'live'
          ? `${points.length.toLocaleString()} calls · last 90 days`
          : `${points.length.toLocaleString()} incidents · TPD snapshot`,
      );
    })
    .catch((e) => {
      console.error('[crime]', e);
      setCrimeSubtitle('crime data unavailable');
    });
}

boot();

// ── Render loop ──────────────────────────────────────────────
city.renderer.setAnimationLoop(() => {
  city.controls.update();
  city.renderer.render(city.scene, city.camera);
});
