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
import { NAMEABLE_WEIGHTS } from '../../lib/slides/font-normalize.mjs';

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
    //
    // Discrete faces specifically: a `wght` variation is inert on a family
    // with no axis, so nothing rescues the 600 here and the clamp still has to
    // act. This is the case that distinguishes "has an axis" from "has the
    // weight", and it is why the two are read separately.
    const el = makeElement('"Space Grotesk", sans-serif', 600);
    const fonts = [300, 400, 500, 600, 700].map((w) => face('Space Grotesk', w));
    await runClamp(fonts, [el]);
    expect(el.applied['font-weight']).toBe('700');
  });

  // These two used to assert the opposite — 550 clamped to 700 and 500 to 400,
  // on the grounds that the handoff could only name Regular or Bold. That is
  // still true of the *name*, but a deck now also carries the authored weight
  // as a `wght` variation, and Figma applies it continuously along a family's
  // axis. So on a variable family the authored weight is what
  // renders, and clamping it here would size the box for a face nobody sees.
  it('leaves a weight alone when the family has an axis that covers it', async () => {
    const el = makeElement('"Space Grotesk", sans-serif', 550);
    const { logs } = await runClamp([face('Space Grotesk', '300 700')], [el]);
    expect(el.applied['font-weight']).toBeUndefined();
    // Nothing was lost, so there is nothing to report either.
    expect(logs).toHaveLength(0);
  });

  it('keeps an authored 500 inside a variable range', async () => {
    const el = makeElement('"Space Grotesk", sans-serif', 500);
    await runClamp([face('Space Grotesk', '300 700')], [el]);
    expect(el.applied['font-weight']).toBeUndefined();
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

describe('NAMEABLE_WEIGHTS coupling', () => {
  it('is the vocabulary the clamp and the handoff share', () => {
    // Canary: widening mapFontStyle's vocabulary must widen this list too.
    expect(NAMEABLE_WEIGHTS).toEqual([400, 700]);
  });

  it('threads through prepareForMeasurement into the clamp', async () => {
    // A family with 300 and 400 but no 700. With the default vocabulary
    // ([400, 700]) a bold request clamps to 400. With a widened vocabulary
    // that includes 300, it should clamp to 300 instead — proving the
    // weights passed in are what the clamp actually uses.
    const el = makeElement('"Buda", serif', 700);
    const realm = makeRealm([face('Buda', 300), face('Buda', 400)], [el]);
    const surface = {
      waitForSelector: async () => {},
      evaluate: async (fn, arg) => fn({ realm, arg }),
      loadWebFont: async () => {},
      settle: async () => {},
    };
    await prepareForMeasurement(
      surface,
      { webFontPreload: false, log: () => {} },
      { nameableWeights: [300, 400, 700] },
    );
    expect(el.applied['font-weight']).toBe('400');
  });
});
