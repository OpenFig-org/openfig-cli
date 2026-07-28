/**
 * `toBytes()` must carry a file-opened deck's images.
 *
 * Opening a `.deck` spills its images to `imagesDir` and empties the in-memory
 * map, so anything encoding from the map alone writes an archive with no
 * `images/` entries — a deck that opens in Figma with blank image fills rather
 * than failing. `saveDeck` passed the collected images in explicitly and was
 * fine; `toBytes()`, the portable entry point the browser path uses, did not.
 *
 * Asserting on entry counts alone would not catch it, since the fixture with
 * no images passes either way — so this pins a deck that actually has some.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { Deck } from '../../lib/slides/api.mjs';
import { FigDeck } from '../../lib/core/fig-deck.mjs';
import { unpackArchive } from '../../lib/core/archive.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DECK = join(__dirname, '../fixtures/decks/reference/oil-machinations.deck');

const imagesIn = (bytes) => [...unpackArchive(bytes).keys()].filter((k) => k.startsWith('images/'));

let sourceImageCount;

beforeAll(async () => {
  const fd = await FigDeck.fromDeckFile(DECK);
  // Opened from a file, the images live on disk and the map is empty — the
  // precondition that made the bug invisible to an in-memory test.
  expect(fd.images.size).toBe(0);
  expect(fd.imagesDir).toBeTruthy();
  sourceImageCount = imagesIn(await fd.toDeckBytes()).length;
});

describe('encoding a deck that was opened from a file', () => {
  it('carries its images through toDeckBytes', () => {
    expect(sourceImageCount).toBeGreaterThan(0);
  });

  it('gives Deck.toBytes() the same entries as Deck.save()', async () => {
    const deck = await Deck.open(DECK);
    const viaBytes = unpackArchive(await deck.toBytes());
    const viaSave = unpackArchive(await (await FigDeck.fromDeckFile(DECK)).toDeckBytes());

    expect([...viaBytes.keys()]).toEqual([...viaSave.keys()]);
    expect(imagesIn(await deck.toBytes()).length).toBe(sourceImageCount);
  });

  it('keeps every image byte-identical to the source archive', async () => {
    const { readFileSync } = await import('fs');
    const source = unpackArchive(new Uint8Array(readFileSync(DECK)));
    const encoded = unpackArchive(await (await Deck.open(DECK)).toBytes());

    for (const [name, bytes] of source) {
      if (!name.startsWith('images/')) continue;
      expect(encoded.has(name), name).toBe(true);
      expect(Buffer.compare(Buffer.from(encoded.get(name)), Buffer.from(bytes)), name).toBe(0);
    }
  });
});
