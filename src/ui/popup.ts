import type { ParcelInfo } from '../layers/parcels';

const el = () => document.getElementById('popup')!;
const body = () => document.getElementById('popup-body')!;

const money = (v: unknown): string =>
  typeof v === 'number' && isFinite(v) && v > 0
    ? '$' + Math.round(v).toLocaleString('en-US')
    : '—';

const text = (v: unknown): string => {
  const s = (v ?? '').toString().trim();
  return s.length ? s : '—';
};

export function initPopup() {
  document.getElementById('popup-close')!.addEventListener('click', hidePopup);
}

export function showLoading() {
  body().innerHTML = `<div class="loading">querying assessor…</div>`;
  el().classList.add('open');
  syncLegend();
}

export function showParcel(info: ParcelInfo) {
  const a = info.attributes;
  const saleDateMs = a['SaleDate'];
  let sale = '—';
  if (typeof a['SalePrice'] === 'number' && (a['SalePrice'] as number) > 0) {
    sale = money(a['SalePrice']);
    if (typeof saleDateMs === 'number') {
      sale += ' · ' + new Date(saleDateMs).getFullYear();
    }
  }
  const yearBuilt =
    typeof a['YearBuilt'] === 'number' && (a['YearBuilt'] as number) > 1800
      ? String(a['YearBuilt'])
      : '—';

  body().innerHTML = `
    <div class="addr">${text(a['PropertyAddress'])}</div>
    <div class="row"><span class="k">Owner</span><span class="v">${text(a['Owner'])}</span></div>
    <div class="row"><span class="k">Fair cash value</span><span class="v money">${money(a['TotalAcctValue'])}</span></div>
    <div class="row"><span class="k">Taxable value</span><span class="v money">${money(a['TaxableValue'])}</span></div>
    <div class="row"><span class="k">Land / Impr.</span><span class="v">${money(a['TotalLandValue'])} / ${money(a['TotalImpValue'])}</span></div>
    <div class="row"><span class="k">Year built</span><span class="v">${yearBuilt}</span></div>
    <div class="row"><span class="k">Last sale</span><span class="v">${sale}</span></div>
    <div class="row"><span class="k">Type</span><span class="v">${text(a['PropertyType'])}</span></div>
    <div class="row"><span class="k">Account</span><span class="v">${text(a['ACCT_NUM'])}</span></div>
  `;
  el().classList.add('open');
  syncLegend();
}

export function showNoParcel() {
  body().innerHTML = `<div class="loading">no parcel found here</div>`;
  el().classList.add('open');
  syncLegend();
}

export function showError() {
  body().innerHTML = `<div class="loading">assessor query failed — try again</div>`;
  el().classList.add('open');
  syncLegend();
}

export function hidePopup() {
  el().classList.remove('open');
  syncLegend();
}

/** Keep the crime legend from overlapping the popup. */
function syncLegend() {
  const legend = document.getElementById('crime-legend');
  if (legend) legend.classList.toggle('no-popup', !el().classList.contains('open'));
}
