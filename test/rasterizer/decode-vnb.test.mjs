/**
 * vectorNetworkBlob curve classification.
 *
 * decodeVnb is the only geometry source for stroke-only vector nodes — those with
 * neither fillGeometry nor strokeGeometry. It previously classified a segment as a
 * straight line by reading a word out of the segment record and testing it against
 * zero. In reference blobs that word is 0 on curved segments too, so curves
 * collapsed into straight-line polygons.
 *
 * The correct rule: a segment is straight if and only if all four bezier tangent
 * components are zero.
 *
 * These blobs are hand-built rather than taken from a fixture, deliberately. No deck
 * fixture reaches this path with reference geometry: openfig's own converter
 * writes a non-zero value in that word, so the old rule happened to classify its
 * output correctly and no rendering difference was observable. Only a blob shaped
 * like Figma's — curved tangents alongside word0 === 0 — exercises the regression.
 */
import { describe, it, expect } from 'vitest';
import { decodeVnb } from '../../lib/rasterizer/svg-builder.mjs';

/**
 * Build a vectorNetworkBlob in Figma's verified layout.
 *
 *   header  12B : vertexCount, segmentCount, regionCount
 *   vertex  12B : word0, x(f32), y(f32)
 *   segment 28B : word0, startVertex, tsx(f32), tsy(f32), endVertex, tex(f32), tey(f32)
 *   region      : packed(styleID<<1|winding), numLoops, then per loop: segCount, indices
 *
 * word0 is written as 0 throughout, matching reference output — this is the
 * value that made the old classification rule fail.
 */
function buildVnb({ vertices, segments, regions }) {
  const words = [];
  const f32 = (v) => ({ f32: v });
  words.push(vertices.length, segments.length, regions.length);
  for (const [x, y] of vertices) words.push(0, f32(x), f32(y));
  for (const s of segments) {
    words.push(0, s.sv, f32(s.tsx), f32(s.tsy), s.ev, f32(s.tex), f32(s.tey));
  }
  for (const region of regions) {
    words.push(1, region.length); // packed = styleID 0, winding NONZERO
    for (const loop of region) words.push(loop.length, ...loop);
  }

  const buf = Buffer.alloc(words.length * 4);
  words.forEach((word, i) => {
    if (typeof word === 'object') buf.writeFloatLE(word.f32, i * 4);
    else buf.writeUInt32LE(word, i * 4);
  });
  return buf;
}

const UNIT = { x: 1, y: 1 };

describe('decodeVnb curve classification', () => {
  it('emits a cubic for a segment with non-zero tangents and word0 === 0', () => {
    // The exact regression: a curve that the old `type === 0` rule flattened.
    const blob = buildVnb({
      vertices: [[0, 0], [100, 0]],
      segments: [{ sv: 0, tsx: 20, tsy: 40, ev: 1, tex: -20, tey: 40 }],
      regions: [[[0]]],
    });

    const d = decodeVnb([{ bytes: blob }], 0, UNIT, UNIT);

    expect(d).toBeTruthy();
    expect(d, 'curved segment must emit a cubic').toContain('C');
    expect(d, 'curved segment must not be flattened to a line').not.toContain('L');
    // Control points are the endpoints offset by their tangents.
    expect(d).toContain('C20,40 80,40 100,0');
  });

  it('emits a line only when all four tangent components are zero', () => {
    const blob = buildVnb({
      vertices: [[0, 0], [100, 0]],
      segments: [{ sv: 0, tsx: 0, tsy: 0, ev: 1, tex: 0, tey: 0 }],
      regions: [[[0]]],
    });

    const d = decodeVnb([{ bytes: blob }], 0, UNIT, UNIT);

    expect(d).toContain('L100,0');
    expect(d, 'straight segment must not emit a cubic').not.toContain('C');
  });

  it('classifies per segment within one loop', () => {
    const blob = buildVnb({
      vertices: [[0, 0], [100, 0], [100, 100]],
      segments: [
        { sv: 0, tsx: 0, tsy: 0, ev: 1, tex: 0, tey: 0 },      // straight
        { sv: 1, tsx: 10, tsy: 0, ev: 2, tex: 0, tey: -10 },   // curved
      ],
      regions: [[[0, 1]]],
    });

    const d = decodeVnb([{ bytes: blob }], 0, UNIT, UNIT);

    expect((d.match(/L/g) ?? []).length, 'one straight segment').toBe(1);
    expect((d.match(/C/g) ?? []).length, 'one curved segment').toBe(1);
  });

  it('treats a single non-zero tangent component as curved', () => {
    // Guards against an `isStraight` written with || instead of &&.
    for (const tangent of ['tsx', 'tsy', 'tex', 'tey']) {
      const segment = { sv: 0, tsx: 0, tsy: 0, ev: 1, tex: 0, tey: 0, [tangent]: 5 };
      const blob = buildVnb({
        vertices: [[0, 0], [100, 0]],
        segments: [segment],
        regions: [[[0]]],
      });

      const d = decodeVnb([{ bytes: blob }], 0, UNIT, UNIT);
      expect(d, `non-zero ${tangent} must produce a cubic`).toContain('C');
    }
  });

  it('walks multi-loop regions', () => {
    // Outline-stroked shapes and letterforms with counters produce these.
    const blob = buildVnb({
      vertices: [[0, 0], [10, 0], [20, 0], [30, 0]],
      segments: [
        { sv: 0, tsx: 1, tsy: 1, ev: 1, tex: -1, tey: 1 },
        { sv: 2, tsx: 1, tsy: 1, ev: 3, tex: -1, tey: 1 },
      ],
      regions: [[[0], [1]]],
    });

    const d = decodeVnb([{ bytes: blob }], 0, UNIT, UNIT);

    expect((d.match(/M/g) ?? []).length, 'one subpath per loop').toBe(2);
    expect((d.match(/C/g) ?? []).length, 'both segments curved').toBe(2);
  });
});
