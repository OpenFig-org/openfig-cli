/**
 * Regression test for parsing a canvas.fig that arrives as a *view* into a
 * larger ArrayBuffer.
 *
 * `readFileSync` frequently returns a Buffer backed by a shared pool, with a
 * non-zero `byteOffset` and a backing ArrayBuffer far larger than the file.
 * Reconstructing it as `new Uint8Array(buf.buffer)` drops both the offset and
 * the length, handing the parser unrelated neighbouring memory instead of the
 * file. The symptom varied with whatever happened to be in the pool — an
 * "Unknown prelude" error, a DataView RangeError, or silently wrong data — so
 * it looked like flakiness rather than one bug.
 *
 * This test builds that hostile shape explicitly rather than relying on the
 * allocator reproducing it. It covers both the parser (`_parseFig`) and the
 * whole portable codec (`fromDeckBytes` → `toDeckBytes`), since a browser
 * hands the codec a view just as readily as Node does.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { FigDeck } from '../../lib/core/fig-deck.mjs';
import { unpackArchive } from '../../lib/core/archive.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DECK_PATH = join(__dirname, '../fixtures/decks/reference/oil-machinations.deck');

const PAD = 960; // the offset actually observed from a pooled readFileSync

/** Copy `bytes` into a larger backing buffer and return a view onto it. */
function asOffsetView(bytes) {
  const backing = new Uint8Array(PAD + bytes.byteLength + 512);
  backing.fill(0x41); // surround it with plausible-looking junk
  backing.set(bytes, PAD);
  return new Uint8Array(backing.buffer, PAD, bytes.byteLength);
}

let deckBytes;
let canvas;

beforeAll(() => {
  deckBytes = new Uint8Array(readFileSync(DECK_PATH));
  // Pull a known-good canvas.fig out of a reference deck.
  canvas = unpackArchive(deckBytes).get('canvas.fig');
});

describe('canvas.fig arriving as a view into a larger buffer', () => {
  it('parses when the buffer sits at a non-zero byteOffset', () => {
    const view = asOffsetView(canvas);

    const deck = new FigDeck();
    expect(() => deck._parseFig(view)).not.toThrow();
    expect(deck.getSlides().length).toBeGreaterThan(0);
  });

  it('parses a plain zero-offset buffer identically', () => {
    const a = new FigDeck();
    const b = new FigDeck();
    a._parseFig(canvas);
    b._parseFig(new Uint8Array(canvas)); // fresh copy, offset 0

    expect(a.getSlides().length).toBe(b.getSlides().length);
    expect(a.getSlides().length).toBeGreaterThan(0);
  });
});

describe('.deck archive arriving as a view into a larger buffer', () => {
  it('round-trips identically from offset 0 and from a non-zero offset', async () => {
    const flat = FigDeck.fromDeckBytes(deckBytes);
    const offset = FigDeck.fromDeckBytes(asOffsetView(deckBytes));

    expect(offset.header).toEqual(flat.header);
    expect(offset.deckMeta).toEqual(flat.deckMeta);
    expect(offset.getSlides().length).toBe(flat.getSlides().length);
    expect(offset.getSlides().length).toBeGreaterThan(0);
    expect(offset.images.size).toBe(flat.images.size);
    expect(offset.images.size).toBeGreaterThan(0);

    // Re-encode both and compare entry by entry. The zip container itself
    // carries a wall-clock mtime, so the contract is entry name, order and
    // content — not the archive's own bytes.
    const a = unpackArchive(await flat.toDeckBytes());
    const b = unpackArchive(await offset.toDeckBytes());

    expect([...b.keys()]).toEqual([...a.keys()]);
    expect(a.has('canvas.fig')).toBe(true);
    for (const [name, bytes] of a) {
      expect(Buffer.compare(Buffer.from(b.get(name)), Buffer.from(bytes)), name).toBe(0);
    }
  });

  it('re-encodes the source deck\'s images and thumbnail unchanged', async () => {
    const source = unpackArchive(deckBytes);
    const encoded = unpackArchive(await FigDeck.fromDeckBytes(deckBytes).toDeckBytes());

    for (const [name, bytes] of source) {
      if (name !== 'thumbnail.png' && !name.startsWith('images/')) continue;
      expect(encoded.has(name), name).toBe(true);
      expect(Buffer.compare(Buffer.from(encoded.get(name)), Buffer.from(bytes)), name).toBe(0);
    }
  });
});
