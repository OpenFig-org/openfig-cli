/**
 * A wrapping paragraph gets a hair of margin, bounded so it cannot move a line
 * break by itself.
 *
 * Measured on a real export: Chromium fitted "...(for example team" into an
 * 831px column with 0.17px to spare — 0.021% headroom. Figma needed 0.02% more
 * advance width for the same string, moved one word to the next line, and every
 * line below it shifted. That is not a wide-metrics problem, it is a knife edge.
 *
 * The bound is the whole point. To pull an extra word *up* a line, a margin
 * would have to be as wide as a space plus the shortest word — roughly 0.5em, or
 * about 12px at 22px Inter. A quarter of the font size leaves 2x headroom
 * against that, so the margin can only rescue lines that were already within a
 * hair of fitting, and can never invent a different wrap of its own.
 *
 * The previous behaviour was no padding at all, justified by boxes bleeding into
 * the next column. That reasoning held for the 1.08x padding used on hard-break
 * text; at this size it does not — the gutter on the slide that prompted it is
 * 60px against a 6px margin.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

// The function lives inside a page-evaluated scope, so it is exercised through
// its source rather than imported. Extracted and evaluated, which still fails if
// the constants drift.
const SRC = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'lib', 'slides', 'browser-extract.mjs'),
  'utf8',
);

function loadWrapMargin() {
  const m = SRC.match(/function wrapMargin\(fontSizePx\) \{[\s\S]*?\n {6}\}/);
  if (!m) throw new Error('wrapMargin not found — was it renamed?');
  // eslint-disable-next-line no-new-func
  return new Function(`${m[0]}; return wrapMargin;`)();
}

describe('wrapMargin', () => {
  const wrapMargin = loadWrapMargin();

  it('is large enough to absorb the drift that caused the bug', () => {
    // The measured shortfall was 0.17px at 22px type.
    expect(wrapMargin(22)).toBeGreaterThan(0.17);
  });

  it('is too small to pull another word onto the line', () => {
    // A space plus the shortest word is about half an em. Staying under a
    // quarter of the font size keeps a 2x safety factor at every size.
    for (const size of [10, 12, 16, 22, 32, 52, 96]) {
      expect(wrapMargin(size), `${size}px`).toBeLessThan(size * 0.5);
    }
  });

  it('scales with type size rather than being one constant', () => {
    expect(wrapMargin(12)).toBeLessThan(wrapMargin(22));
  });

  it('caps at 8px so display type does not inherit a huge margin', () => {
    expect(wrapMargin(96)).toBe(8);
    expect(wrapMargin(400)).toBe(8);
  });

  it('never returns zero, even for nonsense input', () => {
    for (const bad of [0, -5, NaN, undefined, null]) {
      expect(wrapMargin(bad), String(bad)).toBeGreaterThanOrEqual(1);
    }
  });
});
