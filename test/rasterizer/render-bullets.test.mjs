/**
 * Bullet / numbered list marker rendering tests.
 * Verifies that fallbackTextTspans emits list markers for programmatically
 * created text nodes with lineType metadata.
 */
import { describe, it, expect } from 'vitest';
import { Deck } from '../../lib/slides/api.mjs';
import { FigDeck } from '../../lib/core/fig-deck.mjs';
import { slideToSvg } from '../../lib/rasterizer/svg-builder.mjs';
import { resolveFonts } from '../../lib/rasterizer/font-resolver.mjs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { writeFileSync, mkdirSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TMP = join(__dirname, '../../.tmp-test');

describe('bullet and numbered list rendering', () => {
  let deckPath;

  it('creates a test deck with bullet and numbered lists', async () => {
    mkdirSync(TMP, { recursive: true });
    deckPath = join(TMP, 'bullet-test.deck');

    const deck = await Deck.create('Bullet Test');

    const s1 = deck.addBlankSlide();
    s1.setBackground('White');
    s1.addText('Apple\nBanana\nCherry', {
      style: 'Body 1', color: 'Black',
      x: 80, y: 80, width: 1760, align: 'LEFT', list: 'bullet',
    });

    const s2 = deck.addBlankSlide();
    s2.setBackground('White');
    s2.addText('First\nSecond\nThird', {
      style: 'Body 1', color: 'Black',
      x: 80, y: 80, width: 1760, align: 'LEFT', list: 'number',
    });

    await deck.save(deckPath);
  });

  it('renders bullet markers (•) for unordered lists', async () => {
    const deck = await FigDeck.fromDeckFile(deckPath);
    await resolveFonts(deck, { quiet: true });
    const svg = slideToSvg(deck, deck.getSlide(1));

    expect(svg).toContain('\u2022 Apple');
    expect(svg).toContain('\u2022 Banana');
    expect(svg).toContain('\u2022 Cherry');
  });

  it('renders numbered markers (1. 2. 3.) for ordered lists', async () => {
    const deck = await FigDeck.fromDeckFile(deckPath);
    await resolveFonts(deck, { quiet: true });
    const svg = slideToSvg(deck, deck.getSlide(2));

    expect(svg).toContain('1. First');
    expect(svg).toContain('2. Second');
    expect(svg).toContain('3. Third');
  });

  it('does not add markers to plain text', async () => {
    const plainPath = join(TMP, 'plain-test.deck');
    const deck = await Deck.create('Plain Test');
    const s = deck.addBlankSlide();
    s.setBackground('White');
    s.addText('No bullets here\nJust plain text', {
      style: 'Body 1', color: 'Black',
      x: 80, y: 80, width: 1760, align: 'LEFT',
    });
    await deck.save(plainPath);

    const fd = await FigDeck.fromDeckFile(plainPath);
    await resolveFonts(fd, { quiet: true });
    const svg = slideToSvg(fd, fd.getSlide(1));

    expect(svg).not.toContain('\u2022');
    expect(svg).not.toMatch(/\d+\. No bullets/);
    expect(svg).toContain('No bullets here');
  });
});
