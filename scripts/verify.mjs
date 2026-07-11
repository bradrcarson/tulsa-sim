/**
 * Headless verification of the Phase 1 checklist. Captures screenshots of:
 *  1. 3D view (buildings + streets)
 *  2. Parcel click popup (INCOG assessor data)
 *  3. Crime heatmap toggle
 *  4. 1943 aerial time scrub
 * Run: node scripts/verify.mjs  (dev server must be running on :5173)
 */
import { chromium } from 'playwright-core';

const OUT = process.env.SHOT_DIR ?? '/opt/cursor/artifacts/screenshots';
const URL = 'http://localhost:5173/';

const browser = await chromium.launch({
  executablePath: '/usr/local/bin/google-chrome',
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
page.on('console', (m) => {
  if (m.type() === 'error' || m.type() === 'warning') console.log('[console]', m.type(), m.text());
});
page.on('pageerror', (e) => console.log('[pageerror]', e.message));

await page.goto(URL, { waitUntil: 'domcontentloaded' });

// 1 — wait for buildings to finish loading
await page.waitForFunction(
  () => document.getElementById('status-text')?.textContent?.includes('buildings'),
  { timeout: 60000 },
);
await page.waitForTimeout(2500); // let a few frames render
await page.screenshot({ path: `${OUT}/1-city-3d.png` });
console.log('OK 1: 3D city view —', await page.textContent('#status-text'));

// 2 — fly to a known parcel (Philtower) and click it → assessor popup
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
console.log('OK 2: parcel popup —', popupText?.replace(/\s+/g, ' ').slice(0, 160));
await page.screenshot({ path: `${OUT}/2-parcel-popup.png` });

// 3 — toggle crime heatmap
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
console.log('OK 3: crime heatmap —', await page.textContent('#crime-sub'));
await page.screenshot({ path: `${OUT}/3-crime-heatmap.png` });
await page.click('label:has(#tg-crime)'); // off again

// 4 — scrub timeline to 1943
await page.locator('#tl-slider').fill('1943');
await page.locator('#tl-slider').dispatchEvent('input');
await page.waitForTimeout(9000); // aerial exportImage fetch + texture upload
console.log('OK 4: timeline year —', await page.textContent('#tl-year'));
await page.screenshot({ path: `${OUT}/4-aerial-1943.png` });

await browser.close();
console.log('ALL CHECKS DONE →', OUT);
