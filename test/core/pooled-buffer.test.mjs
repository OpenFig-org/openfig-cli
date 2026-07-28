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
 * allocator reproducing it.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { FigDeck } from '../../lib/core/fig-deck.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DECK_PATH = join(__dirname, '../fixtures/decks/reference/oil-machinations.deck');

let canvas;

beforeAll(async () => {
  // Pull a known-good canvas.fig out of a reference deck.
  const deck = await FigDeck.fromDeckFile(DECK_PATH);
  canvas = readFileSync(join(deck._tempDir, 'canvas.fig'));
});

describe('canvas.fig arriving as a view into a larger buffer', () => {
  it('parses when the buffer sits at a non-zero byteOffset', () => {
    const PAD = 960; // the offset actually observed from a pooled readFileSync
    const backing = new Uint8Array(PAD + canvas.byteLength + 512);
    backing.fill(0x41); // surround it with plausible-looking junk
    backing.set(canvas, PAD);
    const view = new Uint8Array(backing.buffer, PAD, canvas.byteLength);

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
