/**
 * Tests for the `deck-to-fig` CLI command.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { run } from '../../bin/commands/deck-to-fig.mjs';
import { FigDeck } from '../../lib/core/fig-deck.mjs';

let workDir;
const JUST_FONTS_FIXTURE = join(process.cwd(), 'test/fixtures/decks/reference/just-fonts.deck');
const OIL_FIXTURE = join(process.cwd(), 'test/fixtures/decks/reference/oil-machinations.deck');

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

  it('performs a successful conversion and writes a valid .fig file', async () => {
    const outPath = join(workDir, 'out.fig');
    await run([JUST_FONTS_FIXTURE], { o: outPath });

    expect(existsSync(outPath)).toBe(true);

    // Verify the output can be read using the unified FigDeck.fromFile method
    const outputDeck = await FigDeck.fromFile(outPath);
    expect(outputDeck.header.prelude).toBe('fig-kiwi');

    const canvas = outputDeck.message.nodeChanges.find(n => n.type === 'CANVAS');
    expect(canvas).toBeDefined();
    expect(canvas.name).toBe('just_fonts');

    const frames = outputDeck.message.nodeChanges.filter(
      n => n.type === 'FRAME' && n.parentIndex?.guid &&
           `${n.parentIndex.guid.sessionID}:${n.parentIndex.guid.localID}` === `${canvas.guid.sessionID}:${canvas.guid.localID}`
    );
    expect(frames.length).toBe(1);

    // Check position of slide 1
    const f1 = frames.find(f => f.name.includes('Slide 01'));
    expect(f1).toBeDefined();
    expect(f1.transform.m02).toBe(0);
    expect(f1.transform.m12).toBe(0);
  });

  it('supports multi-slide row layout arrangement', async () => {
    const outPath = join(workDir, 'out-row.fig');
    await run([OIL_FIXTURE], { o: outPath, layout: 'row', gap: 200 });

    expect(existsSync(outPath)).toBe(true);

    const outputDeck = await FigDeck.fromFile(outPath);
    const canvas = outputDeck.message.nodeChanges.find(n => n.type === 'CANVAS');
    const frames = outputDeck.message.nodeChanges.filter(
      n => n.type === 'FRAME' && n.parentIndex?.guid &&
           `${n.parentIndex.guid.sessionID}:${n.parentIndex.guid.localID}` === `${canvas.guid.sessionID}:${canvas.guid.localID}`
    );

    expect(frames.length).toBe(7);

    // Check positions in ROW layout (gap 200)
    // Slide 1 size: 1920x1080 -> x=0, y=0
    // Slide 2 size: 1920x1080 -> x=1920+200=2120, y=0
    // Slide 3 size: 1920x1080 -> x=4240, y=0
    const f1 = frames.find(f => f.name.includes('Slide 01'));
    const f2 = frames.find(f => f.name.includes('Slide 02'));
    const f3 = frames.find(f => f.name.includes('Slide 03'));

    expect(f1.transform.m02).toBe(0);
    expect(f1.transform.m12).toBe(0);

    expect(f2.transform.m02).toBe(2120);
    expect(f2.transform.m12).toBe(0);

    expect(f3.transform.m02).toBe(4240);
    expect(f3.transform.m12).toBe(0);
  });

  it('supports grid layout arrangement', async () => {
    const outPath = join(workDir, 'out-grid.fig');
    await run([OIL_FIXTURE], { o: outPath, layout: 'grid', gap: 300, wrap: 2 });

    expect(existsSync(outPath)).toBe(true);

    const outputDeck = await FigDeck.fromFile(outPath);
    const canvas = outputDeck.message.nodeChanges.find(n => n.type === 'CANVAS');
    const frames = outputDeck.message.nodeChanges.filter(
      n => n.type === 'FRAME' && n.parentIndex?.guid &&
           `${n.parentIndex.guid.sessionID}:${n.parentIndex.guid.localID}` === `${canvas.guid.sessionID}:${canvas.guid.localID}`
    );

    expect(frames.length).toBe(7);

    const f1 = frames.find(f => f.name.includes('Slide 01'));
    const f2 = frames.find(f => f.name.includes('Slide 02'));
    const f3 = frames.find(f => f.name.includes('Slide 03'));

    // Grid layout: wrap = 2, gap = 300, size = 1920x1080
    // Index 0: col=0, row=0 -> x=0, y=0
    // Index 1: col=1, row=0 -> x=1920+300=2220, y=0
    // Index 2: col=0, row=1 -> x=0, y=1080+300=1380
    expect(f1.transform.m02).toBe(0);
    expect(f1.transform.m12).toBe(0);

    expect(f2.transform.m02).toBe(2220);
    expect(f2.transform.m12).toBe(0);

    expect(f3.transform.m02).toBe(0);
    expect(f3.transform.m12).toBe(1380);
  });
});
