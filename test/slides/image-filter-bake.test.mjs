/**
 * Image filters use the original image and Figma's native editable Color
 * Adjust fields whenever possible. The two legacy mask transforms that have
 * no native equivalent still exercise the raster fallback.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import {
  applyElement,
  contrastForCss,
  exposureForBrightness,
  toneAdjustmentsForBrightness,
} from '../../lib/slides/handoff/element-dispatch.mjs';
import { sharpImageOps } from '../../lib/core/image-utils.mjs';

let work;
let redPath;
let neutralPath;
let brightOrangePath;

beforeAll(async () => {
  work = mkdtempSync(join(tmpdir(), 'image-filter-bake-'));
  redPath = join(work, 'red.png');
  neutralPath = join(work, 'neutral.png');
  brightOrangePath = join(work, 'bright-orange.png');
  // 2×2, pure red, half of it transparent.
  const rgba = Buffer.from([
    255, 0, 0, 255, 255, 0, 0, 255,
    255, 0, 0, 0, 255, 0, 0, 0,
  ]);
  writeFileSync(redPath, await sharp(rgba, { raw: { width: 2, height: 2, channels: 4 } }).png().toBuffer());
  writeFileSync(
    neutralPath,
    await sharp({
      create: {
        width: 2,
        height: 2,
        channels: 4,
        background: { r: 116, g: 116, b: 116, alpha: 1 },
      },
    }).png().toBuffer(),
  );
  writeFileSync(
    brightOrangePath,
    await sharp({
      create: {
        width: 2,
        height: 2,
        channels: 4,
        background: { r: 255, g: 128, b: 0, alpha: 1 },
      },
    }).png().toBuffer(),
  );
});

afterAll(() => { rmSync(work, { recursive: true, force: true }); });

/** Run one image element through the dispatcher and capture its image node. */
async function render(filter, src = redPath, element = {}) {
  const seen = [];
  const originals = [];
  const warnings = [];
  const node = {
    fillPaints: [{
      type: 'IMAGE',
      visible: true,
      blendMode: 'NORMAL',
      image: { name: 'rendered-image' },
      imageScaleMode: 'FILL',
      transform: { m00: 1, m01: 0, m02: 0, m10: 0, m11: 1, m12: 0 },
      originalImageWidth: 200,
      originalImageHeight: 100,
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
  const ctx = {
    resolveMedia: () => src,
    slideIndex: 1,
    imageOps: sharpImageOps,
    warn: (message) => warnings.push(message),
  };
  await applyElement(slide, {
    type: 'image',
    src: 'media/red.png',
    filter,
    x: 0,
    y: 0,
    width: 64,
    height: 64,
    ...element,
  }, ctx);
  return { source: seen[0], originals, warnings, node };
}

const bake = async (filter, src = redPath) => (await render(filter, src)).source;

const pixels = async (bytes) => {
  const { data } = await sharp(bytes).raw().toBuffer({ resolveWithObject: true });
  return [...data];
};

describe('image filter handoff', () => {
  it('passes the path straight through when there is no filter', async () => {
    const out = await render(undefined);
    expect(out.source).toBe(redPath);
    expect(out.originals).toEqual([]);
    expect(out.node.fillPaints).toHaveLength(1);
    expect(out.node.pluginData).toBeUndefined();
  });

  it('maps a non-centered cover position to the native crop window', async () => {
    const out = await render(undefined, redPath, {
      objectFit: 'cover',
      objectPosition: '25% 50%',
    });
    expect(out.node.fillPaints[0]).toMatchObject({
      imageScaleMode: 'STRETCH',
      transform: {
        m00: 0.5,
        m01: 0,
        m02: 0.125,
        m10: 0,
        m11: 1,
        m12: 0,
      },
    });
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

  it('keeps a CSS chain native, self-contained and editable', async () => {
    const filter = {
      css: 'grayscale(1) contrast(.5) brightness(1.5)',
      ops: [
        { fn: 'grayscale', amount: 1 },
        { fn: 'contrast', amount: 0.5 },
        { fn: 'brightness', amount: 1.5 },
      ],
    };
    const out = await render(filter);

    expect(out.source).toBe(redPath);
    expect((await pixels(out.source)).slice(0, 4)).toEqual([255, 0, 0, 255]);
    expect(out.originals).toEqual([]);
    expect(out.warnings).toEqual([]);
    expect(out.node.fillPaints).toHaveLength(1);
    expect(out.node.fillPaints[0]).toMatchObject({ visible: true });
    expect(out.node.fillPaints[0].paintFilter).toEqual({
      vibrance: -1,
      contrast: contrastForCss(0.5),
      ...toneAdjustmentsForBrightness(1.5),
    });
    expect(out.node.pluginData).toBeUndefined();
  });

  it('combines repeated native operations before calibrating the controls', async () => {
    const out = await render({
      css: 'saturate(1.5) grayscale(.5) brightness(1.1) brightness(1.2)',
      ops: [
        { fn: 'saturate', amount: 1.5 },
        { fn: 'grayscale', amount: 0.5 },
        { fn: 'brightness', amount: 1.1 },
        { fn: 'brightness', amount: 1.2 },
      ],
    });

    expect(out.source).toBe(redPath);
    expect(out.node.fillPaints[0].paintFilter).toEqual({
      vibrance: -0.25,
      // Pure red is saturated below the highlight band, so the retained 75%
      // of its color receives the continuous dark-color correction.
      ...toneAdjustmentsForBrightness(1.32, { darkColorRisk: 0.75 }),
    });
  });

  it('uses Exposure-only for fully source-risky color brightening', async () => {
    const out = await render({
      css: 'brightness(1.18)',
      ops: [{ fn: 'brightness', amount: 1.18 }],
    }, brightOrangePath);

    expect(out.source).toBe(brightOrangePath);
    expect(out.node.fillPaints[0].paintFilter).toEqual({
      exposure: exposureForBrightness(1.18),
    });
  });

  it('keeps the measured tone refinement for a neutral source', async () => {
    const out = await render({
      css: 'brightness(1.18)',
      ops: [{ fn: 'brightness', amount: 1.18 }],
    }, neutralPath);

    expect(out.source).toBe(neutralPath);
    expect(out.node.fillPaints[0].paintFilter).toEqual(
      toneAdjustmentsForBrightness(1.18),
    );
  });

  it('warns rather than baking a chain with no editable native equivalent', async () => {
    const filter = {
      css: 'sepia(1)',
      ops: [{ fn: 'sepia', amount: 1 }],
    };
    const out = await render(filter);

    expect(out.source).toBe(redPath);
    expect(out.node.fillPaints[0].paintFilter).toBeUndefined();
    expect(out.node.fillPaints).toHaveLength(1);
    expect(out.warnings).toEqual([
      'image filter "sepia(1)" has no editable Figma equivalent',
    ]);
  });

  it('caches by source and filter rather than by a file on disk', async () => {
    const first = await bake({ invert: 1 });
    const second = await bake({ invert: 1 });
    expect(second).toBe(first);
    // A different filter over the same source is a different entry.
    expect(await bake({ forceWhite: true })).not.toBe(first);
  });
});
