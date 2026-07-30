/**
 * Image filters are rendered automatically into the visible paint while the
 * untouched source is retained as an invisible recovery paint. The renderer
 * hands `addImage` bytes directly, keeping filesystem concerns out of the
 * element dispatcher.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { applyElement } from '../../lib/slides/handoff/element-dispatch.mjs';
import { sharpImageOps } from '../../lib/core/image-utils.mjs';

let work;
let redPath;

beforeAll(async () => {
  work = mkdtempSync(join(tmpdir(), 'image-filter-bake-'));
  redPath = join(work, 'red.png');
  // 2×2, pure red, half of it transparent.
  const rgba = Buffer.from([
    255, 0, 0, 255, 255, 0, 0, 255,
    255, 0, 0, 0, 255, 0, 0, 0,
  ]);
  writeFileSync(redPath, await sharp(rgba, { raw: { width: 2, height: 2, channels: 4 } }).png().toBuffer());
});

afterAll(() => { rmSync(work, { recursive: true, force: true }); });

/** Run one image element through the dispatcher and capture its image node. */
async function render(filter, src = redPath) {
  const seen = [];
  const originals = [];
  const node = {
    fillPaints: [{
      type: 'IMAGE',
      visible: true,
      blendMode: 'NORMAL',
      image: { name: 'rendered-image' },
    }],
  };
  const slide = {
    addImage: async (source) => {
      seen.push(source);
      return node;
    },
    createImagePaint: async (source) => {
      originals.push(source);
      return {
        type: 'IMAGE',
        visible: true,
        blendMode: 'NORMAL',
        image: { name: 'source-image' },
      };
    },
  };
  // `imageOps` is now required rather than defaulted to `sharpImageOps`:
  // the default was a module-scope import that dragged `sharp` — and through
  // it `node:fs` — into the browser bundle whether or not the branch ran.
  const ctx = { resolveMedia: () => src, slideIndex: 1, imageOps: sharpImageOps };
  await applyElement(slide, { type: 'image', src: 'media/red.png', filter, x: 0, y: 0, width: 64, height: 64 }, ctx);
  return { source: seen[0], originals, node };
}

const bake = async (filter, src = redPath) => (await render(filter, src)).source;

const pixels = async (bytes) => {
  const { data } = await sharp(bytes).raw().toBuffer({ resolveWithObject: true });
  return [...data];
};

describe('image filter baking', () => {
  it('passes the path straight through when there is no filter', async () => {
    const out = await render(undefined);
    expect(out.source).toBe(redPath);
    expect(out.originals).toEqual([]);
    expect(out.node.fillPaints).toHaveLength(1);
    expect(out.node.pluginData).toBeUndefined();
  });

  it('inverts RGB and preserves alpha, as bytes', async () => {
    const out = await bake({ invert: 1 });
    expect(typeof out).not.toBe('string');
    expect((await sharp(out).metadata()).format).toBe('png');
    const px = await pixels(out);
    // red → cyan, alpha untouched
    expect(px.slice(0, 4)).toEqual([0, 255, 255, 255]);
    expect(px[11]).toBe(0);
  });

  it('forces every visible pixel white and keeps the alpha mask', async () => {
    const px = await pixels(await bake({ forceWhite: true }));
    expect(px.slice(0, 4)).toEqual([255, 255, 255, 255]);
    expect(px[11]).toBe(0);
  });

  it('automatically renders a CSS chain and retains the source invisibly', async () => {
    const filter = {
      css: 'grayscale(1) contrast(.5) brightness(1.5)',
      ops: [
        { fn: 'grayscale', amount: 1 },
        { fn: 'contrast', amount: 0.5 },
        { fn: 'brightness', amount: 1.5 },
      ],
    };
    const out = await render(filter);

    expect((await pixels(out.source)).slice(0, 4)).toEqual([135, 135, 135, 255]);
    expect(out.originals).toEqual([redPath]);
    expect(out.node.fillPaints).toHaveLength(2);
    expect(out.node.fillPaints[0]).toMatchObject({ visible: true });
    expect(out.node.fillPaints[0].paintFilter).toBeUndefined();
    expect(out.node.fillPaints[1]).toMatchObject({
      visible: false,
      image: { name: 'source-image' },
    });

    const metadata = out.node.pluginData.find((entry) => entry.key === 'css-image-filter');
    expect(metadata.pluginID).toBe('org.openfig');
    expect(JSON.parse(metadata.value)).toEqual({
      version: 1,
      css: filter.css,
      renderedImage: 'rendered-image',
      sourceImage: 'source-image',
    });
  });

  it('caches by source and filter rather than by a file on disk', async () => {
    const first = await bake({ invert: 1 });
    const second = await bake({ invert: 1 });
    expect(second).toBe(first);
    // A different filter over the same source is a different entry.
    expect(await bake({ forceWhite: true })).not.toBe(first);
  });
});
