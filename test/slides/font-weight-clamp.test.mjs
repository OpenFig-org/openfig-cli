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

function makeElement(fontFamily, fontWeight, fontStyle = 'normal') {
  const applied = {};
  return {
    computed: { fontFamily, fontWeight: String(fontWeight), fontStyle },
    style: { setProperty: (k, v) => { applied[k] = v; } },
    applied,
  };
}

/** A registered face, as `document.fonts` reports one. */
const face = (family, weight, style = 'normal') => ({ family, weight: String(weight), style });

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

  it('leaves a weight alone when it is already the face it will be named as', async () => {
    const el = makeElement('"Space Grotesk", sans-serif', 400);
    const fonts = [300, 400, 500, 600, 700].map((w) => face('Space Grotesk', w));
    const { logs } = await runClamp(fonts, [el]);
    expect(el.applied['font-weight']).toBeUndefined();
    expect(logs).toHaveLength(0);
  });

  it('snaps an unnameable weight to one it can name, even when the family has it', async () => {
    // Space Grotesk really does ship a 600, but the handoff has no style name
    // for it — it can only say Regular or Bold. Measuring at 600 and writing
    // "Bold" sizes the box for a face that will not be rendered, so the weight
    // moves to the one that will be.
    const el = makeElement('"Space Grotesk", sans-serif', 600);
    const fonts = [300, 400, 500, 600, 700].map((w) => face('Space Grotesk', w));
    await runClamp(fonts, [el]);
    expect(el.applied['font-weight']).toBe('700');
  });

  it('applies the same rule inside a variable range', async () => {
    // A variable font can render 550, but the handoff still has only two names
    // for it. 550 is equidistant from both, and the tie goes to the heavier
    // face, as CSS font matching does above 500.
    const el = makeElement('"Space Grotesk", sans-serif', 550);
    await runClamp([face('Space Grotesk', '300 700')], [el]);
    expect(el.applied['font-weight']).toBe('700');
  });

  it('rounds a light-side weight down rather than up', async () => {
    const el = makeElement('"Space Grotesk", sans-serif', 500);
    await runClamp([face('Space Grotesk', '300 700')], [el]);
    expect(el.applied['font-weight']).toBe('400');
  });

  it('clamps to the end of a variable range when the ask is outside it', async () => {
    const el = makeElement('"Space Grotesk", sans-serif', 900);
    await runClamp([face('Space Grotesk', '300 700')], [el]);
    expect(el.applied['font-weight']).toBe('700');
  });

  it('does not land on a heavy face it has no name for', async () => {
    // Coda ships 400 and 800 and no 700. Snapping a bold request to the
    // nearest available weight put it on 800, which the handoff then wrote as
    // "Bold" — a face Coda does not have. Eight Google families behave this
    // way, so the clamp must choose only among weights it can name.
    const el = makeElement('Coda, sans-serif', 700);
    await runClamp([face('Coda', 400), face('Coda', 800)], [el]);
    expect(el.applied['font-weight']).toBe('400');
  });

  it('leaves a family with no nameable weight at all untouched', async () => {
    // Buda ships only 300 — the one family in Google's catalogue with neither
    // a 400 nor a 700. Inventing a face for it would be worse than declining.
    const el = makeElement('Buda, serif', 300);
    await runClamp([face('Buda', 300)], [el]);
    expect(el.applied['font-weight']).toBeUndefined();
  });

  it('sets a family with no italic upright', async () => {
    // Space Grotesk ships no italic. A browser slants the upright glyphs
    // itself; Figma will not, and reported "Space Grotesk / Italic" missing on
    // a real deck. Same class of bug as the synthetic bold, other axis.
    const el = makeElement('"Space Grotesk", sans-serif', 400, 'italic');
    const { logs } = await runClamp([face('Space Grotesk', 400)], [el]);
    expect(el.applied['font-style']).toBe('normal');
    expect(logs.join('\n')).toMatch(/Space Grotesk has no italic/);
  });

  it('keeps italic where the family has a real italic face', async () => {
    const el = makeElement('"Instrument Serif", serif', 400, 'italic');
    const fonts = [face('Instrument Serif', 400), face('Instrument Serif', 400, 'italic')];
    const { logs } = await runClamp(fonts, [el]);
    expect(el.applied['font-style']).toBeUndefined();
    expect(logs).toHaveLength(0);
  });

  it('handles a family missing both the weight and the italic', async () => {
    const el = makeElement('"Space Grotesk", sans-serif', 900, 'italic');
    await runClamp([face('Space Grotesk', 400), face('Space Grotesk', 700)], [el]);
    expect(el.applied['font-style']).toBe('normal');
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
