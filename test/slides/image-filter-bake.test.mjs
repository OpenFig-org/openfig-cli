/**
 * `bakeImageFilter` bakes CSS `invert(1)` and `brightness(0) invert(1)` into
 * raster bytes. It used to hand `addImage` a path to a `<stem>.<key>.png`
 * cache file it had just written; it now hands over the bytes directly, which
 * is what let `node:fs` and `node:path` leave the element dispatcher.
 *
 * No standalone fixture carries an image filter, so without this the whole
 * function is unexercised.
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

/** Run one image element through the dispatcher and capture what addImage got. */
async function bake(filter, src = redPath) {
  const seen = [];
  const slide = { addImage: async (source) => { seen.push(source); return {}; } };
  // `imageOps` is now required rather than defaulted to `sharpImageOps`:
  // the default was a module-scope import that dragged `sharp` — and through
  // it `node:fs` — into the browser bundle whether or not the branch ran.
  const ctx = { resolveMedia: () => src, slideIndex: 1, imageOps: sharpImageOps };
  await applyElement(slide, { type: 'image', src: 'media/red.png', filter, x: 0, y: 0, width: 64, height: 64 }, ctx);
  return seen[0];
}

const pixels = async (bytes) => {
  const { data } = await sharp(bytes).raw().toBuffer({ resolveWithObject: true });
  return [...data];
};

describe('image filter baking', () => {
  it('passes the path straight through when there is no filter', async () => {
    expect(await bake(undefined)).toBe(redPath);
  });

  it('inverts RGB and preserves alpha, as bytes', async () => {
    const out = await bake({ invert: 1 });
    expect(typeof out).not.toBe('string');
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

  it('caches by source and filter rather than by a file on disk', async () => {
    const first = await bake({ invert: 1 });
    const second = await bake({ invert: 1 });
    expect(second).toBe(first);
    // A different filter over the same source is a different entry.
    expect(await bake({ forceWhite: true })).not.toBe(first);
  });
});
