import { ERAS } from '../layers/history';

/** Year scrubber. Emits the selected year; snapping feel near keyframes. */
export function initTimeline(onYear: (year: number) => void) {
  const slider = document.getElementById('tl-slider') as HTMLInputElement;
  const yearLabel = document.getElementById('tl-year')!;
  const marks = document.querySelectorAll<HTMLElement>('#timeline .tl-marks span');

  slider.min = String(ERAS[0].year);
  slider.max = String(ERAS[ERAS.length - 1].year);
  slider.value = slider.max;

  const apply = (raw: number) => {
    // gentle snap: within 4 years of a keyframe, lock onto it
    let year = raw;
    for (const era of ERAS) {
      if (Math.abs(raw - era.year) <= 4) {
        year = era.year;
        break;
      }
    }
    slider.value = String(year);
    yearLabel.textContent = String(year);
    yearLabel.classList.toggle('historic', year < 2000);
    marks.forEach((m) => m.classList.toggle('active', Number(m.dataset.year) === year && year < 2000));
    onYear(year);
  };

  slider.addEventListener('input', () => apply(Number(slider.value)));

  // clicking the keyframe labels jumps straight to that era
  marks.forEach((m) =>
    m.addEventListener('click', () => apply(Number(m.dataset.year))),
  );
}
