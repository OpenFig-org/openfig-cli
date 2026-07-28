/**
 * A weight the family does not ship must not reach the deck.
 *
 * Instrument Serif has exactly one weight, 400. A browser asked for 700 renders
 * a synthetic bold — it smears the 400 glyphs — and reports `font-weight: 700`
 * as if nothing were wrong. Figma has no synthetic bold: it looks for a real
 * "Instrument Serif Bold", does not find one, and opens the missing-font dialog
 * on a deck that otherwise converted cleanly. Found exactly that way, on a real
 * export, with 11 nodes named Instrument Serif Bold.
 *
 * It is also a measurement bug, which is the half that leaves no dialog to see:
 * the geometry was taken against Chrome's fake bold, which is wider than the
 * regular Figma substitutes.
 *
 * The realm walk is exercised here against a stub document, so these run
 * offline and do not depend on what Google Fonts serves today.
 */
import { describe, it, expect } from 'vitest';
import { prepareForMeasurement } from '../../lib/slides/core/measurement-surface.mjs';

/** A stub realm: a font set, and elements with computed styles. */
function makeRealm(fonts, elements) {
  return {
    document: {
      fonts,
      querySelectorAll: () => elements,
    },
    getComputedStyle: (el) => el.computed,
  };
}

function makeElement(fontFamily, fontWeight) {
  const applied = {};
  return {
    computed: { fontFamily, fontWeight: String(fontWeight) },
    style: { setProperty: (k, v) => { applied[k] = v; } },
    applied,
  };
}

/**
 * Runs prepareForMeasurement and returns what the clamp did. Only the clamp
 * walks elements, so the other evaluate() calls are harmless no-ops here.
 */
async function runClamp(fonts, elements) {
  const logs = [];
  const realm = makeRealm(fonts, elements);
  const surface = {
    waitForSelector: async () => {},
    evaluate: async (fn, arg) => fn({ realm, arg }),
    loadWebFont: async () => {},
    settle: async () => {},
  };
  await prepareForMeasurement(surface, { webFontPreload: false, log: (m) => logs.push(m) }, {});
  return { logs };
}

describe('clamping font-weight to faces the family ships', () => {
  it('drops a bold the family does not have down to its only weight', async () => {
    const el = makeElement('"Instrument Serif", serif', 700);
    await runClamp([{ family: 'Instrument Serif', weight: '400' }], [el]);
    expect(el.applied['font-weight']).toBe('400');
  });

  it('says so, because the deck silently loses the bold the design asked for', async () => {
    const el = makeElement('"Instrument Serif", serif', 700);
    const { logs } = await runClamp([{ family: 'Instrument Serif', weight: '400' }], [el]);
    expect(logs.join('\n')).toMatch(/Instrument Serif has no weight 700/);
  });

  it('leaves a weight the family does ship exactly alone', async () => {
    const el = makeElement('"Space Grotesk", sans-serif', 600);
    const fonts = [300, 400, 500, 600, 700].map((w) => ({ family: 'Space Grotesk', weight: String(w) }));
    const { logs } = await runClamp(fonts, [el]);
    expect(el.applied['font-weight']).toBeUndefined();
    expect(logs).toHaveLength(0);
  });

  it('treats a variable font as covering its whole range', async () => {
    const el = makeElement('"Space Grotesk", sans-serif', 550);
    await runClamp([{ family: 'Space Grotesk', weight: '300 700' }], [el]);
    expect(el.applied['font-weight']).toBeUndefined();
  });

  it('clamps to the end of a variable range when the ask is outside it', async () => {
    const el = makeElement('"Space Grotesk", sans-serif', 900);
    await runClamp([{ family: 'Space Grotesk', weight: '300 700' }], [el]);
    expect(el.applied['font-weight']).toBe('700');
  });

  it('picks the nearest weight, not simply Regular', async () => {
    // 600 sits between 500 and 700; both are one step away, and CSS resolves
    // ties above 500 upward. Collapsing this to Regular would be a second,
    // quieter version of the same bug.
    const el = makeElement('Nearest, sans-serif', 600);
    const fonts = [400, 500, 700].map((w) => ({ family: 'Nearest', weight: String(w) }));
    await runClamp(fonts, [el]);
    expect(el.applied['font-weight']).toBe('700');
  });

  it('leaves system families alone, since their weights cannot be inspected', async () => {
    // Nothing is registered for this family, so there is no evidence either
    // way — guessing here would corrupt text that was rendering correctly.
    const el = makeElement('"Helvetica Neue", sans-serif', 700);
    await runClamp([{ family: 'Space Grotesk', weight: '400' }], [el]);
    expect(el.applied['font-weight']).toBeUndefined();
  });
});
