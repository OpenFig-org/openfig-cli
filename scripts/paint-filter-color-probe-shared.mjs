/**
 * Geometry and inputs shared by the paint-filter vibrance probe and its
 * measurement script.
 *
 * The target contains saturated and neutral patches. Saturated patches answer
 * whether `paintFilter.vibrance = -1` removes chroma; neutral patches measure
 * any per-channel noise introduced by the Figma -> PDF -> PNG pipeline.
 */
export const SLIDE = { w: 1920, h: 1080 };
export const TARGET = { x: 160, y: 330, w: 1600, h: 600 };
export const GRID = { columns: 4, rows: 3 };

export const PATCHES = [
  { name: 'red', rgb: [232, 24, 24], neutral: false },
  { name: 'green', rgb: [24, 232, 24], neutral: false },
  { name: 'blue', rgb: [24, 24, 232], neutral: false },
  { name: 'cyan', rgb: [24, 232, 232], neutral: false },
  { name: 'magenta', rgb: [232, 24, 232], neutral: false },
  { name: 'yellow', rgb: [232, 232, 24], neutral: false },
  { name: 'orange', rgb: [232, 96, 24], neutral: false },
  { name: 'violet', rgb: [112, 24, 232], neutral: false },
  { name: 'teal', rgb: [24, 176, 112], neutral: false },
  { name: 'dark gray', rgb: [48, 48, 48], neutral: true },
  { name: 'mid gray', rgb: [128, 128, 128], neutral: true },
  { name: 'light gray', rgb: [208, 208, 208], neutral: true },
];

export const PROBE_STEPS = [
  { value: null, label: 'REFERENCE — no paintFilter' },
  { value: -0.25, label: 'vibrance -0.25' },
  { value: -0.5, label: 'vibrance -0.5' },
  { value: -0.75, label: 'vibrance -0.75' },
  { value: -1, label: 'vibrance -1' },
];

export function patchRect(index) {
  const column = index % GRID.columns;
  const row = Math.floor(index / GRID.columns);
  const width = TARGET.w / GRID.columns;
  const height = TARGET.h / GRID.rows;
  return {
    x: TARGET.x + column * width,
    y: TARGET.y + row * height,
    w: width,
    h: height,
  };
}
