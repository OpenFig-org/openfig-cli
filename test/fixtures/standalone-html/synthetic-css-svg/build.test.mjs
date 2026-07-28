/**
 * Regression tests for two constructs real Claude Design exports use that no
 * recorded fixture covered:
 *
 *  - a pie chart drawn as a CSS conic-gradient (no vector geometry to extract,
 *    and a transparent background-color, so an extractor that skips
 *    conic-gradient emits nothing at all for the element)
 *  - SVG geometry nested under <g transform="translate(...)">
 *
 * Guards conic handling in browser-extract.mjs and the transform flattening
 * in handoff/element-dispatch.mjs.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { convertStandaloneHtml } from '../../../../lib/slides/html-converter.mjs';
import { parseSvgShapes, flattenShapeCtm } from '../../../../lib/slides/handoff/element-dispatch.mjs';

const FIXTURE_DIR = dirname(fileURLToPath(import.meta.url));
const HTML_PATH = join(FIXTURE_DIR, 'synthetic-css-svg.html');

let workDir;
let manifest;

const svgs = () => {
  const out = [];
  const walk = (els) => {
    for (const el of els ?? []) {
      if (el.type === 'svg') out.push(el);
      walk(el.children);
    }
  };
  walk(manifest.slides[0].elements);
  return out;
};

beforeAll(async () => {
  workDir = mkdtempSync(join(tmpdir(), 'cssvg-html-'));
  const buildDir = join(workDir, 'build');
  await convertStandaloneHtml(HTML_PATH, join(workDir, 'out.deck'), { scratchDir: buildDir });
  manifest = JSON.parse(readFileSync(join(buildDir, 'manifest.json'), 'utf8'));
}, 120_000);

afterAll(() => {
  rmSync(workDir, { recursive: true, force: true });
});

describe('CSS conic-gradient pie chart', () => {
  it('emits geometry for the conic element at its authored box', () => {
    const pie = svgs().find(s => Math.round(s.x) === 100 && Math.round(s.y) === 100);
    expect(pie, 'conic-gradient element produced no geometry').toBeTruthy();
    expect(pie.width).toBeCloseTo(300, 0);
    expect(pie.height).toBeCloseTo(300, 0);
  });

  it('splits the cone into one wedge per hard stop', () => {
    const pie = svgs().find(s => Math.round(s.x) === 100);
    // 25% blue + 75% red -> exactly two wedges, no subdivision.
    expect((pie.inline.match(/<path/g) ?? []).length).toBe(2);
  });

  it('keeps both stop colours', () => {
    const pie = svgs().find(s => Math.round(s.x) === 100);
    expect(pie.inline).toContain('rgb(0, 0, 255)');
    expect(pie.inline).toContain('rgb(255, 0, 0)');
  });
});

describe('SVG geometry under a group transform', () => {
  it('extracts the icon at its authored box', () => {
    const icon = svgs().find(s => Math.round(s.x) === 600);
    expect(icon).toBeTruthy();
    expect(icon.width).toBeCloseTo(120, 0);
  });

  it('carries the group transform through to the parsed shape', () => {
    const icon = svgs().find(s => Math.round(s.x) === 600);
    const inner = icon.inline.replace(/^[\s\S]*?<svg\b[^>]*>|<\/svg>\s*$/g, '');
    const { shapes } = parseSvgShapes(inner);
    expect(shapes).toHaveLength(1);
    // translate(20,30) as a 2x3 affine [a,b,c,d,e,f].
    expect(shapes[0].ctm).toEqual([1, 0, 0, 1, 20, 30]);
  });

  it('bakes translate(20,30) into the path coordinates', () => {
    const icon = svgs().find(s => Math.round(s.x) === 600);
    const inner = icon.inline.replace(/^[\s\S]*?<svg\b[^>]*>|<\/svg>\s*$/g, '');
    const flat = flattenShapeCtm(parseSvgShapes(inner).shapes[0]);
    // Authored 0,0 -> 40,0 -> 40,40 becomes 20,30 -> 60,30 -> 60,70.
    // Dropping the transform leaves it collapsed on the SVG origin.
    const nums = (flat.d.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number);
    expect(nums.slice(0, 6)).toEqual([20, 30, 60, 30, 60, 70]);
    expect(flat.ctm).toBeNull();
  });
});
