/**
 * Regression test for the Carbon Question standalone HTML fixture.
 *
 * A full twelve-slide export, and the closest thing in the suite to a real
 * document: SVG charts mixing fill shapes, dashed grid lines and stroke-only
 * curves; blockquotes; a vertical writing-mode band; and text set in four
 * families, two of which lack faces the design asks for.
 *
 * Slides 11 and 12 exist only to be converted — an asset check for SVG
 * constructs and a set of blockquote variants. They are where unsupported
 * constructs surface first, so a change in what they produce is a signal
 * rather than noise.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, statSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { convertStandaloneHtml } from '../../../../lib/slides/html-converter.mjs';
import { FigDeck } from '../../../../lib/core/fig-deck.mjs';
import { slideToSvg } from '../../../../lib/rasterizer/svg-builder.mjs';

const FIXTURE_DIR = dirname(fileURLToPath(import.meta.url));
const HTML_PATH = join(FIXTURE_DIR, 'The-Carbon-Question.html');

let workDir;
let outPath;
let fd;
let slide2Svg;
let slide10Svg;

const textNodes = () => fd.message.nodeChanges.filter((n) => n.type === 'TEXT');
const byText = (s) => textNodes().find((n) => n.textData?.characters === s);

beforeAll(async () => {
  workDir = mkdtempSync(join(tmpdir(), 'carbon-html-'));
  outPath = join(workDir, 'carbon.deck');
  await convertStandaloneHtml(HTML_PATH, outPath, { scratchDir: join(workDir, 'build') });
  fd = await FigDeck.fromDeckFile(outPath);
  slide2Svg = slideToSvg(fd, fd.getSlide(2));
  slide10Svg = slideToSvg(fd, fd.getSlide(10));
}, 120_000);

afterAll(() => {
  rmSync(workDir, { recursive: true, force: true });
});

describe('Carbon Question standalone HTML → .deck build', () => {
  it('writes a non-empty .deck file', () => {
    expect(existsSync(outPath)).toBe(true);
    expect(statSync(outPath).size).toBeGreaterThan(20_000);
  });

  it('produces 12 slides from the 12 <section> tags', () => {
    expect(fd.getActiveSlides()).toHaveLength(12);
  });

  it('renders the slide 2 chart without vector placeholder fallbacks', () => {
    expect(slide2Svg).toContain('Measured demand');
    // Magenta is the rasterizer's "I could not build this shape" colour.
    expect(slide2Svg).not.toContain('#ff00ff');
  });

  it('renders the slide 10 chart without vector placeholder fallbacks', () => {
    expect(slide10Svg).toContain('Projected demand vs.');
    expect(slide10Svg).not.toContain('#ff00ff');
  });

  it('preserves authored hard breaks, and hugs the text that carries them', () => {
    const caption = byText("What the labels do\nand don't mean");
    expect(caption, 'authored line break was lost').toBeTruthy();
    // WIDTH_AND_HEIGHT means the box hugs the run rather than re-wrapping it
    // to a measured width, which is what keeps an authored break authored.
    expect(caption.textAutoResize).toBe('WIDTH_AND_HEIGHT');
  });

  it('keeps the vertical band labels rotated a quarter turn', () => {
    // `writing-mode: vertical-rl` with `transform: rotate(180deg)`. Figma has
    // no writing mode, so these survive only as rotated nodes; unrotated, they
    // lay out horizontally in a tall narrow box and come out as squashed
    // stacks.
    const rotated = textNodes().filter((n) => {
      const t = n.transform;
      if (!t) return false;
      return Math.round((Math.atan2(t.m10, t.m00) * 180) / Math.PI) % 360 !== 0;
    });
    expect(rotated.length).toBeGreaterThanOrEqual(4);
  });

  it('keeps a figure and its unit on one line', () => {
    // The unit is a <sub>, so it sits lower than the number beside it while
    // sharing the line. Counting lines by distinct rect tops made that two
    // lines, so the run missed the branch that sets noWrap, and Figma — free
    // to re-wrap a fixed-width box — put "TWh" on its own line on top of the
    // caption below it. All three figures were misclassified; only the widest
    // was wide enough for Figma's metrics to actually push it over.
    for (const figure of ['847 TWh', '1.5 °C', '$420 BN']) {
      const node = byText(figure);
      expect(node, `no text node for ${figure}`).toBeTruthy();
      expect(node.textAutoResize, figure).toBe('WIDTH_AND_HEIGHT');
    }
  });

  it('never names a font face the family does not provide', () => {
    // Instrument Serif ships one weight and no bold; Space Grotesk ships no
    // italic. A browser fakes both and reports them as real, so these pairs
    // reached the deck and opened Figma's missing-font dialog on a conversion
    // that had otherwise reported success.
    const pairs = new Set();
    for (const c of fd.message.nodeChanges) {
      if (c.fontName) pairs.add(`${c.fontName.family}|${c.fontName.style}`);
      for (const o of c.textData?.styleOverrideTable ?? []) {
        if (o.fontName) pairs.add(`${o.fontName.family}|${o.fontName.style}`);
      }
    }
    expect([...pairs]).not.toContain('Instrument Serif|Bold');
    expect([...pairs]).not.toContain('Instrument Serif|Bold Italic');
    expect([...pairs]).not.toContain('Space Grotesk|Italic');
  });

  it('gives every styled run a PostScript name', () => {
    // An empty PostScript name makes Figma substitute a fallback even when the
    // family is present, so a run override without one is a silent
    // substitution rather than a visible error.
    for (const c of fd.message.nodeChanges) {
      for (const o of c.textData?.styleOverrideTable ?? []) {
        if (!o.fontName) continue;
        expect(o.fontName.postscript, `${o.fontName.family} ${o.fontName.style}`).toBeTruthy();
      }
    }
  });

  it('keeps image filters native, self-contained and editable', () => {
    const filteredNodes = fd.message.nodeChanges.filter((node) =>
      node.fillPaints?.some((paint) => paint.type === 'IMAGE' && paint.paintFilter));

    expect(filteredNodes.length).toBeGreaterThan(0);
    for (const node of filteredNodes) {
      const images = node.fillPaints?.filter((paint) => paint.type === 'IMAGE') ?? [];
      expect(images).toHaveLength(1);
      expect(images[0].visible).not.toBe(false);
      expect(images[0].paintFilter).toMatchObject({
        vibrance: -1,
      });
      expect(images[0].paintFilter.exposure).toBeGreaterThan(0);
      expect(images[0].paintFilter.contrast).toBeGreaterThan(0);
      expect(node.pluginData).toBeUndefined();
    }
  });
});
