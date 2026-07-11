/**
 * Headless verification of the Phase 1 + Phase 2 checklists. Captures:
 *  1. Intro fly-through frame (cinematic swoop)
 *  2. Night-mode 3D city view + City Vitals panel (clock + weather)
 *  3. Live buses toggle (≥1 marker or honest "no vehicles" state)
 *  4. Traffic cameras toggle + click → camera detail card
 *  5. Parcel click popup (INCOG assessor data)
 *  6. Crime heatmap toggle
 *  7. 1943 aerial time scrub
 *  8. Day mode (night toggle off)
 * Run: node scripts/verify.mjs  (dev server must be running on :5173)
 */
import { chromium } from 'playwright-core';

const OUT = process.env.SHOT_DIR ?? '/opt/cursor/artifacts/screenshots';
const URL = 'http://localhost:5173/';

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'OK' : 'FAIL'}: ${name}${detail ? ' — ' + detail : ''}`);
  if (!ok) failures++;
};

const browser = await chromium.launch({
  executablePath: '/usr/local/bin/google-chrome',
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
page.on('console', (m) => {
  if (m.type() === 'error') console.log('[console]', m.type(), m.text());
});
page.on('pageerror', (e) => console.log('[pageerror]', e.message));

await page.goto(URL, { waitUntil: 'domcontentloaded' });

// 1 — intro fly-through frame (capture mid-swoop before it ends)
await page.waitForTimeout(1200);
await page.screenshot({ path: `${OUT}/1-intro-flythrough.png` });
check('intro fly-through frame captured', true);

// 2 — wait for buildings; City Vitals must show a ticking clock + weather
await page.waitForFunction(
  () => document.getElementById('status-text')?.textContent?.includes('buildings'),
  { timeout: 90000 },
);
await page.waitForTimeout(3000); // let frames render + settle post-intro
const status = await page.textContent('#status-text');
check('buildings loaded', /[\d,]+ buildings/.test(status), status.trim());
check(
  'expanded coverage (beyond Phase 1 downtown ~9.5k)',
  Number(status.replace(/,/g, '').match(/(\d+) buildings/)?.[1] ?? 0) > 15000,
  status.trim(),
);

const clock1 = await page.textContent('#vt-clock');
await page.waitForTimeout(1500);
const clock2 = await page.textContent('#vt-clock');
check('vitals clock ticking', /\d\d:\d\d:\d\d/.test(clock2) && clock1 !== clock2, clock2);

await page.waitForFunction(
  () => {
    const t = document.getElementById('vt-wx-temp')?.textContent ?? '';
    return /°F/.test(t) || /unavailable/.test(document.getElementById('vt-wx-cond')?.textContent ?? '');
  },
  { timeout: 30000 },
);
const wx = (await page.textContent('#vt-wx-temp')) + ' ' + (await page.textContent('#vt-wx-cond'));
check('vitals weather', /°F/.test(wx), wx.trim());
check('vitals layer count', /\d+ layers? live/.test(await page.textContent('#vt-layers')));
await page.screenshot({ path: `${OUT}/2-night-city-vitals.png` });

// 3 — live buses toggle
await page.click('label:has(#tg-buses)');
await page.waitForFunction(
  () => {
    const t = document.getElementById('vt-transit')?.textContent ?? '';
    return /buses tracked|no vehicles|feed unavailable/.test(t);
  },
  { timeout: 45000 },
);
const transitText = await page.textContent('#vt-transit');
check('live buses state', /buses tracked|no vehicles|feed unavailable/.test(transitText), transitText.trim());
// fly to the bus nearest downtown so the marker is unmistakable in the shot
const busSeen = await page.evaluate(() => {
  const buses = window.__sim.buses();
  if (!buses.length) return false;
  const d = (b) => Math.hypot(b.lat - 36.154, b.lon + 95.9928);
  const bus = buses.reduce((best, b) => (d(b) < d(best) ? b : best), buses[0]);
  window.__sim.flyToLL(bus.lon, bus.lat, 350);
  return true;
});
await page.waitForTimeout(1800);
await page.screenshot({ path: `${OUT}/3-live-buses.png` });
console.log(busSeen ? 'INFO: bus close-up captured' : 'INFO: no buses in service window');

// 4 — traffic cameras toggle + click a marker
await page.click('label:has(#tg-cameras)');
await page.waitForFunction(
  () => /\d+ in metro/.test(document.getElementById('cameras-sub')?.textContent ?? ''),
  { timeout: 30000 },
);
const camSub = await page.textContent('#cameras-sub');
check('cameras loaded', /\d+ in metro/.test(camSub), camSub.trim());

// fly to a known camera (via the __sim test hook), project its marker to
// screen pixels, then click it
const camTarget = await page.evaluate(() => {
  const cams = window.__sim.cameras();
  // pick a camera near downtown so the fly-to is short
  const cam = cams.reduce((best, c) => {
    const d = (c2) => Math.hypot(c2.lat - 36.154, c2.lon + 95.9928);
    return d(c) < d(best) ? c : best;
  }, cams[0]);
  window.__sim.flyToLL(cam.lon, cam.lat, 400);
  return cam;
});
await page.waitForTimeout(1800); // fly animation
const camScreen = await page.evaluate(
  ({ lon, lat }) => window.__sim.screenPos(lon, lat),
  camTarget,
);
await page.mouse.click(camScreen.x, camScreen.y);
await page.waitForTimeout(600);
const camPopupOpen = await page.evaluate(
  () =>
    document.getElementById('popup')?.classList.contains('open') &&
    (document.getElementById('popup-title')?.textContent ?? '').includes('Camera'),
);
check('camera marker click opens card', camPopupOpen, camTarget.loc);
if (camPopupOpen) {
  const body = await page.textContent('#popup-body');
  check('camera card has OKtraffic link', body.includes('OKtraffic'), body.replace(/\s+/g, ' ').slice(0, 90));
}
await page.screenshot({ path: `${OUT}/4-camera-popup.png` });
if (camPopupOpen) await page.click('#popup-close');
await page.click('label:has(#tg-cameras)'); // cameras off
await page.click('label:has(#tg-buses)'); // buses off

// 5 — fly to a known parcel (Philtower) and click it → assessor popup
await page.fill('#search', 'Philtower');
await page.press('#search', 'Enter');
await page.waitForTimeout(1800); // fly animation
await page.mouse.click(800, 450);
await page.waitForFunction(
  () => {
    const b = document.getElementById('popup-body')?.textContent ?? '';
    return b.includes('Owner') || b.includes('no parcel') || b.includes('failed');
  },
  { timeout: 30000 },
);
await page.waitForTimeout(600);
const popupText = await page.textContent('#popup-body');
check('parcel popup shows assessor data', popupText.includes('Owner'), popupText.replace(/\s+/g, ' ').slice(0, 140));
await page.screenshot({ path: `${OUT}/5-parcel-popup.png` });

// 6 — toggle crime heatmap
await page.waitForFunction(
  () => {
    const s = document.getElementById('crime-sub')?.textContent ?? '';
    return s.includes('calls') || s.includes('incidents') || s.includes('unavailable');
  },
  { timeout: 60000 },
);
await page.click('#popup-close');
await page.click('label:has(#tg-crime)');
// zoom out so the block-level aggregation pattern is visible
await page.mouse.move(800, 450);
for (let i = 0; i < 6; i++) {
  await page.mouse.wheel(0, 600);
  await page.waitForTimeout(150);
}
await page.waitForTimeout(1500);
const crimeSub = await page.textContent('#crime-sub');
check('crime heatmap data', /calls|incidents/.test(crimeSub), crimeSub.trim());
await page.screenshot({ path: `${OUT}/6-crime-heatmap.png` });
await page.click('label:has(#tg-crime)'); // off again

// 7 — scrub timeline to 1943
await page.locator('#tl-slider').fill('1943');
await page.locator('#tl-slider').dispatchEvent('input');
await page.waitForTimeout(9000); // aerial exportImage fetch + texture upload
const tlYear = await page.textContent('#tl-year');
check('timeline at 1943', tlYear.trim() === '1943', tlYear.trim());
await page.screenshot({ path: `${OUT}/7-aerial-1943.png` });
await page.locator('#tl-slider').fill('2026');
await page.locator('#tl-slider').dispatchEvent('input');
await page.waitForTimeout(800);

// 8 — day mode (night toggle off)
await page.click('label:has(#tg-night)');
await page.waitForTimeout(1200);
await page.screenshot({ path: `${OUT}/8-day-mode.png` });
check('day mode screenshot captured', true);

await browser.close();
if (failures > 0) {
  console.log(`\n${failures} CHECK(S) FAILED → ${OUT}`);
  process.exit(1);
}
console.log(`\nALL CHECKS PASSED → ${OUT}`);
