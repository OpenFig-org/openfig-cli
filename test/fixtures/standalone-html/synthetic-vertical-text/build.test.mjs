/**
 * CSS vertical writing modes must survive as node rotation.
 *
 * `writing-mode: vertical-rl` + `transform: rotate(180deg)` is the standard
 * way to write a side label that reads bottom-to-top. Both properties used to
 * be dropped — the transform with an "(non-translate) ignored" warning, the
 * writing mode silently — so the run was laid out horizontally inside its tall
 * narrow box and a band of four labels down the edge of a slide came out as
 * four squashed stacks.
 *
 * Figma has no writing mode, but a rotated node draws the same glyphs in the
 * same places. These tests check both the rotation and the arithmetic that
 * moves the origin onto the corner the rotation pivots about, since getting
 * the angle right and the origin wrong lands the label somewhere else
 * entirely.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { convertStandaloneHtml } from '../../../../lib/slides/html-converter.mjs';

const FIXTURE_DIR = dirname(fileURLToPath(import.meta.url));
const HTML_PATH = join(FIXTURE_DIR, 'synthetic-vertical-text.html');

let workDir;
let manifest;

const texts = () => {
  const out = [];
  const walk = (els) => {
    for (const el of els ?? []) {
      if (el.type === 'text') out.push(el);
      walk(el.children);
    }
  };
  walk(manifest.slides[0].elements);
  return out;
};

const byText = (needle) => texts().find((t) => (t.text ?? '').includes(needle));

/**
 * The on-screen box the rotated node covers, recovered from the node's own
 * geometry — the inverse of what the extractor computed. Figma rotates about
 * the node's top-left, so for a quarter turn the node's width becomes the
 * screen height and the origin sits on one of the other three corners.
 */
const screenBox = (el) => {
  const { x, y, width, height, rotate } = el;
  if (rotate === -90) return { x, y: y - width, width: height, height: width };
  if (rotate === 90) return { x: x - height, y, width: height, height: width };
  return { x, y, width, height };
};

beforeAll(async () => {
  workDir = mkdtempSync(join(tmpdir(), 'vtext-html-'));
  const buildDir = join(workDir, 'build');
  await convertStandaloneHtml(HTML_PATH, join(workDir, 'out.deck'), { scratchDir: buildDir });
  manifest = JSON.parse(readFileSync(join(buildDir, 'manifest.json'), 'utf8'));
}, 120_000);

afterAll(() => {
  rmSync(workDir, { recursive: true, force: true });
});

describe('CSS vertical writing modes', () => {
  it('turns a bottom-to-top label a quarter turn anticlockwise', () => {
    const el = byText('READS UP');
    expect(el, 'no text element for the vertical-rl + rotate(180deg) label').toBeTruthy();
    expect(el.rotate).toBe(-90);
  });

  it('turns a plain vertical-rl label a quarter turn clockwise', () => {
    expect(byText('READS DOWN')?.rotate).toBe(90);
  });

  it('stores the run unrotated, so the node is wider than it is tall', () => {
    for (const needle of ['READS UP', 'READS DOWN']) {
      const el = byText(needle);
      // The authored line-height is 40px; the run is several glyphs long.
      expect(el.height, needle).toBeLessThan(el.width);
      expect(el.height, needle).toBeLessThan(60);
    }
  });

  it('lands each label back on the box the browser painted', () => {
    // Authored left/top for #up and #down, from the fixture stylesheet.
    for (const [needle, left, top] of [['READS UP', 1600, 200], ['READS DOWN', 200, 200]]) {
      const box = screenBox(byText(needle));
      // A couple of pixels of slack: the box is tightened to the glyph range,
      // which sits a sub-pixel inside the authored div. Getting the pivot
      // corner wrong misplaces the label by a whole box dimension — tens of
      // pixels — so this is still a tight enough net for the bug it guards.
      expect(Math.abs(box.x - left), `${needle} x (got ${box.x})`).toBeLessThanOrEqual(2);
      expect(Math.abs(box.y - top), `${needle} y (got ${box.y})`).toBeLessThanOrEqual(2);
      // A vertical label is tall and narrow on screen — the transposition of
      // the node's own box, and the thing that was wrong before.
      expect(box.height, `${needle} is not tall on screen`).toBeGreaterThan(box.width);
    }
  });

  it('does not warn about a transform it now carries through', () => {
    const warnings = JSON.stringify(manifest.warnings ?? []);
    expect(warnings).not.toContain('non-translate');
  });
});
