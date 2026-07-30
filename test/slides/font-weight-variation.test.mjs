/**
 * An authored weight of 500 or 600 must survive into the deck.
 *
 * A deck can only *name* Regular and Bold, because a family's named instances
 * live in its `fvar` table and no metadata API exposes them — Google serves
 * Space Grotesk at 600 while Figma's picker offers no SemiBold for it, so
 * widening the vocabulary from Google's weight list would reintroduce the
 * missing-font dialog the clamp exists to prevent. The cost was 21 elements
 * authored at 600 written as Bold and 2 at 500 written as Regular.
 *
 * A `wght` font variation buys that fidelity back without touching the name.
 * Regular + wght 500 and Regular + wght 600 render at distinct, monotonically
 * increasing stem widths between plain Regular and plain Bold, so the axis is
 * applied continuously rather than snapped. The same variation on Instrument
 * Serif, which has no weight axis, is inert. It also overrides the base style
 * in both directions — `Bold` + wght 400 is indistinguishable from plain
 * `Regular` — which is what the run-level tests below turn on.
 *
 * These tests go through the deck writer and read the file back, because the
 * whole point is what a `.deck` carries, not what an object literal says.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Deck } from '../../lib/slides/api.mjs';
import { FigDeck } from '../../lib/core/fig-deck.mjs';
import { applyElement } from '../../lib/slides/handoff/element-dispatch.mjs';

/** 'wght' packed big-endian, the uint the kiwi schema stores an axis tag as. */
const WGHT = 2003265652;

let workDir;
beforeEach(() => { workDir = mkdtempSync(join(tmpdir(), 'openfig-wght-')); });
afterEach(() => { rmSync(workDir, { recursive: true, force: true }); });

/**
 * Run one extracted element through the real handoff and read the TEXT node
 * back out of a saved deck, so nothing between here and the bytes is stubbed.
 */
async function convertElement(el) {
  const deck = await Deck.create({ name: 'Weight variation test' });
  const slide = deck.addBlankSlide();
  await applyElement(slide, el, { slideIndex: 1 });
  const out = join(workDir, 'out.deck');
  await deck.save(out);
  const fd = await FigDeck.fromDeckFile(out);
  const text = fd.message.nodeChanges.filter((n) => n.type === 'TEXT');
  // The template's own placeholder text nodes come first; the one added here
  // is the last.
  return text[text.length - 1];
}

const wghtOf = (variations) =>
  (variations ?? []).filter((v) => v.axisTag === WGHT).map((v) => v.value);

const runVariations = (node) =>
  (node.textData.styleOverrideTable ?? []).map((e) => wghtOf(e.fontVariations));

describe('authored weight carried as a wght variation', () => {
  it('writes the authored 600 while still naming a face that exists', async () => {
    const node = await convertElement({
      type: 'text', text: 'SCOPE 3', x: 0, y: 0, width: 400,
      size: 24, font: 'Space Grotesk', weight: 600,
    });
    expect(wghtOf(node.fontVariations)).toEqual([600]);
    // The name is the safety net and must not move: Space Grotesk has no
    // SemiBold in Figma, so naming one would be the missing-font dialog again.
    expect(node.fontName.style).toBe('Bold');
  });

  it('writes an authored 500, which the style name rounds the wrong way', async () => {
    // 500 is nearer 400 than 700, so the name says Regular and the design's
    // Medium disappeared entirely. This is the half of the loss that leaves
    // nothing to see in Figma's font dialog.
    const node = await convertElement({
      type: 'text', text: 'Jane Thornton', x: 0, y: 0, width: 400,
      size: 18, font: 'Space Grotesk', weight: 500,
    });
    expect(wghtOf(node.fontVariations)).toEqual([500]);
    expect(node.fontName.style).toBe('Regular');
  });

  it('writes no variation where the style name already says the weight', async () => {
    // 400 and 700 are exactly what Regular and Bold mean. Writing a redundant
    // variation would churn every existing deck's bytes for nothing.
    for (const weight of [400, 700]) {
      const node = await convertElement({
        type: 'text', text: 'plain', x: 0, y: 0, width: 400,
        size: 18, font: 'Space Grotesk', weight,
      });
      expect(node.fontVariations ?? []).toEqual([]);
    }
  });

  it('carries a run\'s own weight rather than the paragraph\'s', async () => {
    const node = await convertElement({
      type: 'richText', x: 0, y: 0, width: 600, size: 18,
      font: 'Space Grotesk', weight: 400,
      runs: [{ text: '847' }, { text: ' TWh', weight: 600 }],
    });
    expect(node.fontVariations ?? []).toEqual([]);
    expect(runVariations(node)).toContainEqual([600]);
  });

  it('lets a run cancel a variation it would otherwise inherit', async () => {
    // The variation overrides the base style completely, so a Bold run inside
    // a paragraph carrying wght 500 renders at 500 unless it says otherwise —
    // the run would come out lighter than the text around it, which is the
    // opposite of what the markup asked for.
    const node = await convertElement({
      type: 'richText', x: 0, y: 0, width: 600, size: 18,
      font: 'Space Grotesk', weight: 500,
      runs: [{ text: 'medium ' }, { text: 'bold', weight: 700 }],
    });
    expect(wghtOf(node.fontVariations)).toEqual([500]);
    expect(runVariations(node)).toContainEqual([700]);
  });

  it('gives two runs at different weights separate style IDs', async () => {
    // The style key is what decides whether runs share an override entry. A
    // key blind to the variation would hand the second run the first one's
    // weight, exactly as it once handed it the first one's family.
    const node = await convertElement({
      type: 'richText', x: 0, y: 0, width: 600, size: 18,
      font: 'Space Grotesk', weight: 400,
      runs: [{ text: 'a', weight: 500 }, { text: 'b', weight: 600 }],
    });
    const seen = runVariations(node).filter((v) => v.length);
    expect(seen).toContainEqual([500]);
    expect(seen).toContainEqual([600]);
    expect(new Set(node.textData.characterStyleIDs).size).toBe(2);
  });
});
