/**
 * Tests for the `deck-to-fig` CLI command.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { run } from '../../bin/commands/deck-to-fig.mjs';
import { FigDeck } from '../../lib/core/fig-deck.mjs';
import { convertDeckToFig } from 'openfig-core';

let workDir;
const JUST_FONTS_FIXTURE = join(process.cwd(), 'test/fixtures/decks/reference/just-fonts.deck');
const OIL_FIXTURE = join(process.cwd(), 'test/fixtures/decks/reference/oil-machinations.deck');

/**
 * Arrange a deck into a design document, without writing it.
 *
 * The arrangement is what this command is for, and it is correct; the encode
 * step behind it is not (see the first test). Reading the frames out of the
 * document keeps the layout under test either way.
 */
async function arrange(fixture, opts = {}) {
  const deck = await FigDeck.fromDeckFile(fixture);
  const doc = convertDeckToFig({
    header: deck.header,
    nodes: deck.message.nodeChanges,
    nodeMap: deck.nodeMap,
    childrenMap: deck.childrenMap,
    schema: deck.schema,
    compiledSchema: deck.compiledSchema,
    rawChunks: deck.rawFiles,
    message: deck.message,
    meta: deck.deckMeta,
    thumbnail: deck.deckThumbnail,
    images: new Map(),
  }, { title: undefined, layout: 'row', gap: 100, wrap: 5, ...opts });

  const canvas = doc.message.nodeChanges.find((n) => n.type === 'CANVAS');
  const key = (g) => `${g.sessionID}:${g.localID}`;
  const frames = doc.message.nodeChanges.filter(
    (n) => n.type === 'FRAME' && n.parentIndex?.guid && key(n.parentIndex.guid) === key(canvas.guid),
  );
  return { canvas, frames };
}

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'openfig-deck-to-fig-'));
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

describe('deck-to-fig command', () => {
  it('exits non-zero when inPath is missing', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('EXIT');
    });
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(run([], {})).rejects.toThrow('EXIT');
    expect(exitSpy).toHaveBeenCalledWith(1);

    exitSpy.mockRestore();
    errSpy.mockRestore();
  });

  it('exits non-zero when outPath is missing and not dry-run', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('EXIT');
    });
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(run([JUST_FONTS_FIXTURE], {})).rejects.toThrow('EXIT');
    expect(exitSpy).toHaveBeenCalledWith(1);

    exitSpy.mockRestore();
    errSpy.mockRestore();
  });

  it('exits non-zero when layout is invalid', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('EXIT');
    });
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(run([JUST_FONTS_FIXTURE], { o: join(workDir, 'out.fig'), layout: 'invalid' })).rejects.toThrow('EXIT');
    expect(exitSpy).toHaveBeenCalledWith(1);

    exitSpy.mockRestore();
    errSpy.mockRestore();
  });

  it('performs a successful dry-run without writing output', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const outPath = join(workDir, 'out.fig');

    await run([JUST_FONTS_FIXTURE], { 'dry-run': true, o: outPath });

    expect(existsSync(outPath)).toBe(false);
    const combined = logSpy.mock.calls.flat().join('\n');
    expect(combined).toContain('DRY RUN SUMMARY');
    expect(combined).toContain('Canvas Page Title: "just_fonts"');
    expect(combined).toContain('Frame count      : 1');

    logSpy.mockRestore();
  });

  it('writes a file whose every blob reference resolves', async () => {
    // `convertDeckToFig` used to renumber the blob table while leaving
    // `derivedTextData.glyphs[].commandsBlob` — the cached glyph outlines, and
    // the bulk of the references in a text-heavy deck — pointing at source
    // indices. just-fonts went from 73 blobs to 1 with references up to 72.
    // References still in range resolved to the wrong blob; the rest pointed
    // at nothing, which Figma reports as `Internal error during import` and
    // names nothing about.
    //
    // The old test here asserted the output was "a valid .fig file" while
    // checking only that it re-read and had the frames expected, so it passed
    // throughout. Counting the references is what actually catches it.
    const outPath = join(workDir, 'out.fig');
    await run([JUST_FONTS_FIXTURE], { o: outPath });
    expect(existsSync(outPath)).toBe(true);

    const outputDeck = await FigDeck.fromFile(outPath);
    expect(outputDeck.header.prelude).toBe('fig-kiwi');

    const blobCount = outputDeck.message.blobs.length;
    let refs = 0;
    const outOfRange = [];
    const walk = (o) => {
      if (!o || typeof o !== 'object') return;
      for (const [k, v] of Object.entries(o)) {
        if (/Blob$/.test(k) && typeof v === 'number') {
          refs += 1;
          if (v >= blobCount) outOfRange.push(`${k}=${v}`);
        } else if (v && typeof v === 'object') walk(v);
      }
    };
    outputDeck.message.nodeChanges.forEach(walk);

    expect(refs, 'no blob references at all — the walk is not reaching them').toBeGreaterThan(50);
    expect(outOfRange).toEqual([]);
  });

  it('names the canvas after the deck and puts one frame per slide on it', async () => {
    const { canvas, frames } = await arrange(JUST_FONTS_FIXTURE);
    expect(canvas.name).toBe('just_fonts');
    expect(frames).toHaveLength(1);
    const f1 = frames.find((f) => f.name.includes('Slide 01'));
    expect(f1.transform.m02).toBe(0);
    expect(f1.transform.m12).toBe(0);
  });

  it('supports multi-slide row layout arrangement', async () => {
    const { frames } = await arrange(OIL_FIXTURE, { layout: 'row', gap: 200 });
    expect(frames).toHaveLength(7);

    // Row, gap 200, slides 1920x1080: 0, then 1920+200, then twice that step.
    const at = (n) => frames.find((f) => f.name.includes(`Slide 0${n}`)).transform;
    expect([at(1).m02, at(1).m12]).toEqual([0, 0]);
    expect([at(2).m02, at(2).m12]).toEqual([2120, 0]);
    expect([at(3).m02, at(3).m12]).toEqual([4240, 0]);
  });

  it('supports grid layout arrangement', async () => {
    const { frames } = await arrange(OIL_FIXTURE, { layout: 'grid', gap: 300, wrap: 2 });
    expect(frames).toHaveLength(7);

    // Grid, wrap 2, gap 300: the third slide starts the second row.
    const at = (n) => frames.find((f) => f.name.includes(`Slide 0${n}`)).transform;
    expect([at(1).m02, at(1).m12]).toEqual([0, 0]);
    expect([at(2).m02, at(2).m12]).toEqual([2220, 0]);
    expect([at(3).m02, at(3).m12]).toEqual([0, 1380]);
  });
});
