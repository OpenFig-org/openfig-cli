/**
 * Regression test for standalones that render their slide inside a scaling
 * viewer stage.
 *
 * The converter loads the standalone as authored so the page's own runtime
 * applies its own tweaks. That also brings the viewer chrome along: the slide
 * is fitted into the space beside a sidebar, so a naive measurement at a
 * 1920-wide viewport reads every coordinate at ~90% of true size.
 *
 * Guards `fitViewportToCanvas` in playwright-layout.mjs.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { convertStandaloneHtml } from '../../../../lib/slides/html-converter.mjs';

const FIXTURE_DIR = dirname(fileURLToPath(import.meta.url));
const HTML_PATH = join(FIXTURE_DIR, 'synthetic-viewer-chrome.html');

let workDir;
let manifest;

function findText(slide, needle) {
  let hit = null;
  const walk = (els) => {
    for (const el of els ?? []) {
      if (typeof el.text === 'string' && el.text.includes(needle)) hit = el;
      walk(el.children);
    }
  };
  walk(slide.elements);
  return hit;
}

beforeAll(async () => {
  workDir = mkdtempSync(join(tmpdir(), 'chrome-html-'));
  const buildDir = join(workDir, 'build');
  await convertStandaloneHtml(HTML_PATH, join(workDir, 'out.deck'), { scratchDir: buildDir });
  manifest = JSON.parse(readFileSync(join(buildDir, 'manifest.json'), 'utf8'));
}, 120_000);

afterAll(() => {
  rmSync(workDir, { recursive: true, force: true });
});

describe('standalone rendered inside a scaling viewer stage', () => {
  it('extracts one slide from the runtime-rehydrated DOM', () => {
    expect(manifest.slides).toHaveLength(1);
  });

  it('reports the canvas at full 1920x1080', () => {
    expect(manifest.dimensions).toEqual({ width: 1920, height: 1080 });
  });

  it('measures geometry at true scale, not the stage-fitted scale', () => {
    const a = findText(manifest.slides[0], 'ANCHOR ALPHA');
    expect(a).toBeTruthy();
    // Authored at left:200px / top:300px. Before the viewport fit these came
    // out at ~180 / ~271 (x0.902), which is the exact failure being guarded.
    expect(a.x).toBeCloseTo(200, 0);
    expect(a.y).toBeCloseTo(300, 0);
  });

  it('holds true scale for anchors far from the origin', () => {
    const b = findText(manifest.slides[0], 'ANCHOR BETA');
    expect(b).toBeTruthy();
    // Error from a uniform scale grows with distance: at x0.902 this landed
    // near 1263 instead of 1400, so it is the strongest signal in the fixture.
    expect(b.x).toBeCloseTo(1400, 0);
    expect(b.y).toBeCloseTo(800, 0);
  });
});
