/**
 * Regression test for the Carbon Question standalone HTML fixture.
 * This fixture exercises SVG chart handoff with a mix of fill shapes,
 * dashed grid lines, and stroke-only curves.
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

beforeAll(async () => {
  workDir = mkdtempSync(join(tmpdir(), 'carbon-html-'));
  outPath = join(workDir, 'carbon.deck');
  await convertStandaloneHtml(HTML_PATH, outPath, { scratchDir: join(workDir, 'build') });
  fd = await FigDeck.fromDeckFile(outPath);
  slide2Svg = slideToSvg(fd, fd.getSlide(2));
  slide10Svg = slideToSvg(fd, fd.getSlide(10));
}, 60_000);

afterAll(() => {
  rmSync(workDir, { recursive: true, force: true });
});

describe('Carbon Question standalone HTML → .deck build', () => {
  it('writes a non-empty .deck file', () => {
    expect(existsSync(outPath)).toBe(true);
    expect(statSync(outPath).size).toBeGreaterThan(20_000);
  });

  it('produces 10 slides from the 10 <section> tags', () => {
    expect(fd.getActiveSlides()).toHaveLength(10);
  });

  it('renders the slide 2 chart without vector placeholder fallbacks', () => {
    expect(slide2Svg).toContain('Measured demand');
    expect(slide2Svg).not.toContain('#ff00ff');
  });

  it('renders the slide 10 charts without vector placeholder fallbacks', () => {
    expect(slide10Svg).toContain('Crossover');
    expect(slide10Svg).toContain('Renewable supply (accelerated');
    expect(slide10Svg).not.toContain('#ff00ff');
  });

  it('preserves authored hard breaks in slide 4 ring captions', () => {
    const texts = fd.message.nodeChanges.filter(n => n.type === 'TEXT');
    const captions = [
      'Share of\nworld power',
      'Decision\nhorizon',
      'vs. prior\n5-yr cycle',
    ].map(label => texts.find(n => n.textData?.characters === label));

    for (const caption of captions) {
      expect(caption).toBeTruthy();
      expect(caption.textAutoResize).toBe('WIDTH_AND_HEIGHT');
    }
  });

  it('keeps slide 4 ring captions aligned with measured label stacks', () => {
    const texts = fd.message.nodeChanges.filter(n => n.type === 'TEXT');
    const firstLabel = texts.find(
      n => n.textData?.characters === 'Estimated global data-center electricity consumption in 2025 — 3.2% of world total',
    );
    const firstCaption = texts.find(
      n => n.textData?.characters === 'Share of\nworld power',
    );

    expect(firstLabel).toBeTruthy();
    expect(firstCaption).toBeTruthy();
    expect(firstLabel.size.y).toBe(144);
    expect(firstCaption.transform.m12).toBe(611);
  });
});
