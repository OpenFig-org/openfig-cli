/**
 * Tests for the `create-deck` CLI command.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { run } from '../../bin/commands/create-deck.mjs';
import { FigDeck } from '../../lib/core/fig-deck.mjs';

let workDir;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'openfig-create-deck-'));
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

describe('create-deck command', () => {
  it('creates a valid .deck with a single default slide', async () => {
    const outPath = join(workDir, 'out.deck');
    await run([], { o: outPath });

    expect(existsSync(outPath)).toBe(true);
    const deck = await FigDeck.fromDeckFile(outPath);
    expect(deck.getActiveSlides().length).toBe(1);
    expect(deck.deckMeta?.file_name).toBe('Untitled');
  });

  it('honors --title and multiple --layout flags', async () => {
    const outPath = join(workDir, 'out.deck');
    await run([], {
      o: outPath,
      title: 'Demo',
      layout: ['cover', 'content', 'closing'],
    });

    const deck = await FigDeck.fromDeckFile(outPath);
    expect(deck.deckMeta?.file_name).toBe('Demo');
    const slides = deck.getActiveSlides();
    expect(slides.length).toBe(3);
    expect(slides.map(s => s.name)).toEqual(['layout:cover', 'layout:content', 'layout:closing']);
  });

  it('treats a single --layout value as one slide', async () => {
    const outPath = join(workDir, 'out.deck');
    await run([], { o: outPath, layout: 'cover' });

    const deck = await FigDeck.fromDeckFile(outPath);
    expect(deck.getActiveSlides().length).toBe(1);
  });

  it('exits non-zero when -o is missing', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('EXIT');
    });
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(run([], {})).rejects.toThrow('EXIT');
    expect(exitSpy).toHaveBeenCalledWith(1);
    const combined = errSpy.mock.calls.flat().join('\n');
    expect(combined).toMatch(/-o|--out/);

    exitSpy.mockRestore();
    errSpy.mockRestore();
  });
});
