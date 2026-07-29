/**
 * Sibling ordering must stay inside the alphabet Figma accepts.
 *
 * `positionChar` was `String.fromCharCode(0x21 + index)` with no upper bound,
 * so index 94 walked out of printable ASCII and produced characters like `Ř`
 * and `Ɖ`. Figma rejects a file containing them outright — the whole import,
 * not the node — so any node with more than 94 children yielded a deck that
 * would not open. A slide carrying 693 children had 599 such positions.
 *
 * Nothing else caught it: the archive was intact, the message parsed, GUIDs
 * were unique, no references dangled, and the deck round-tripped through our
 * own reader unchanged. 241 tests passed while the converter emitted files
 * Figma refused, which is why the validator here checks the *output* rather
 * than our agreement with ourselves.
 */
import { describe, it, expect } from 'vitest';
import { positionChar, isValidPosition } from '../../lib/core/node-helpers.mjs';
import { validateDeck, deckErrors } from '../../lib/core/validate-deck.mjs';

describe('positionChar', () => {
  it('keeps the values it always had below the overflow point', () => {
    // Existing decks must not shift. Index 0..92 is the range that was already
    // correct, and it stays byte-identical.
    for (let i = 0; i <= 92; i++) {
      expect(positionChar(i)).toBe(String.fromCharCode(0x21 + i));
    }
  });

  it('never emits a character outside the accepted alphabet', () => {
    for (let i = 0; i < 2000; i++) {
      for (const ch of positionChar(i)) {
        const cp = ch.codePointAt(0);
        expect(cp, `index ${i}`).toBeGreaterThanOrEqual(0x21);
        expect(cp, `index ${i}`).toBeLessThanOrEqual(0x7E);
      }
    }
  });

  it('orders lexicographically, which is how Figma compares positions', () => {
    // The reason a naive second character does not work: "!" < "!!" < '"', so
    // an overflowed node would sort between the first two siblings rather than
    // after all of them.
    let prev = positionChar(0);
    for (let i = 1; i < 2000; i++) {
      const cur = positionChar(i);
      expect(prev < cur, `index ${i}: ${JSON.stringify(prev)} should sort before ${JSON.stringify(cur)}`).toBe(true);
      prev = cur;
    }
  });

  it('crosses the old ceiling without a discontinuity', () => {
    expect(positionChar(92)).toBe('}');
    expect(positionChar(93)).toBe('~!');
    expect('}' < '~!').toBe(true);
  });

  it('rejects a nonsensical index rather than emitting a bad position', () => {
    expect(() => positionChar(-1)).toThrow();
    expect(() => positionChar(1.5)).toThrow();
  });
});

describe('isValidPosition', () => {
  it('accepts a bare tilde, which working decks carry on the canvas', () => {
    // The generator holds `~` back as a continuation marker, but it is a valid
    // position in its own right. Validating against our convention rather than
    // the format's rejected files that import perfectly well.
    expect(isValidPosition('~')).toBe(true);
  });

  it('rejects what the old generator produced past the ceiling', () => {
    expect(isValidPosition('Ř')).toBe(false);   // U+0158, seen in a real deck
    expect(isValidPosition('˕')).toBe(false);   // U+02D5, the worst observed
    expect(isValidPosition('')).toBe(false);
  });
});

describe('validateDeck', () => {
  const node = (over = {}) => ({
    guid: { sessionID: 1, localID: 1 },
    type: 'RECTANGLE',
    parentIndex: { guid: { sessionID: 1, localID: 0 }, position: '!' },
    ...over,
  });
  const parent = { guid: { sessionID: 1, localID: 0 }, type: 'SLIDE' };

  it('catches the position overflow that made decks unopenable', () => {
    const message = { nodeChanges: [parent, node({ parentIndex: { guid: parent.guid, position: 'Ř' } })] };
    const errs = deckErrors(message);
    expect(errs.map((e) => e.code)).toContain('position-out-of-range');
  });

  it('passes a deck whose positions are all in range', () => {
    const message = { nodeChanges: [parent, node()] };
    expect(deckErrors(message)).toHaveLength(0);
  });

  it('catches a duplicate guid', () => {
    const message = { nodeChanges: [parent, node(), node()] };
    expect(deckErrors(message).map((e) => e.code)).toContain('duplicate-guid');
  });

  it('catches a parent that is not in the file', () => {
    const message = { nodeChanges: [node({ parentIndex: { guid: { sessionID: 9, localID: 9 }, position: '!' } })] };
    expect(deckErrors(message).map((e) => e.code)).toContain('dangling-parent');
  });

  it('catches a blob reference past the end of the blob table', () => {
    const message = {
      blobs: [{ bytes: new Uint8Array(1) }],
      nodeChanges: [parent, node({ vectorData: { vectorNetworkBlob: 7 } })],
    };
    expect(deckErrors(message).map((e) => e.code)).toContain('blob-out-of-range');
  });

  it('catches NaN geometry', () => {
    const message = { nodeChanges: [parent, node({ size: { x: NaN, y: 10 } })] };
    expect(deckErrors(message).map((e) => e.code)).toContain('non-finite-geometry');
  });

  it('catches a paint pointing at an image the archive does not have', () => {
    const message = {
      nodeChanges: [parent, node({ fillPaints: [{ type: 'IMAGE', image: { hash: new Uint8Array([0xab, 0xcd]) } }] })],
    };
    const errs = deckErrors(message, { imageHashes: new Set(['0000']) });
    expect(errs.map((e) => e.code)).toContain('image-missing');
  });

  it('reports a font with no PostScript name as a warning, not an error', () => {
    // Figma substitutes a fallback rather than refusing the file, so this must
    // not block a write.
    const message = { nodeChanges: [parent, node({ fontName: { family: 'Inter', style: 'Regular', postscript: '' } })] };
    const all = validateDeck(message);
    expect(all.find((f) => f.code === 'font-no-postscript')?.level).toBe('warning');
    expect(deckErrors(message)).toHaveLength(0);
  });
});
