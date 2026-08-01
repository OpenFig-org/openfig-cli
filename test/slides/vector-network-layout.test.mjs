/**
 * vectorNetworkBlob layout conformance for blobs this package emits.
 *
 * openfig-cli builds vector networks in api-core.mjs, independently of
 * openfig-core's encoder. This test holds that emitter to Figma's verified layout
 * so the two cannot drift, and so our output stays structurally indistinguishable
 * from Figma's own.
 *
 * The decoder below is deliberately hand-written rather than imported. openfig-cli
 * depends on the published openfig-core, which predates parseVectorNetworkBlob, and
 * a test that shared an implementation with the code under test would pass whatever
 * that implementation happened to do.
 *
 * Byte-exact consumption is necessary but NOT sufficient. Candidate layouts for
 * this format are one-word rotations of each other with identical strides, so a
 * wrong field order still consumes the blob exactly. Three checks together pin it
 * down, and each was confirmed by mutation to catch something the others miss:
 * byte-exact consumption, decoded coordinates spanning a real bounding box, and
 * the leading words holding values Figma actually writes.
 */
import { describe, it, expect } from 'vitest';
import { Deck } from '../../lib/slides/api.mjs';

/**
 * Walk a blob under Figma's verified layout:
 *   header  12B : vertexCount, segmentCount, regionCount
 *   vertex  12B : handleMirroring, x(f32), y(f32)
 *   segment 28B : word0, startVertex, tsx(f32), tsy(f32), endVertex, tex(f32), tey(f32)
 *   region      : packed, numLoops, then per loop: segCount, indices
 * Throws if the blob does not account for exactly its own length.
 */
function walkVerifiedLayout(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u32 = (o) => {
    if (o + 4 > bytes.length) throw new Error(`read past end at ${o} of ${bytes.length}`);
    return view.getUint32(o, true);
  };

  const vertexCount = u32(0);
  const segmentCount = u32(4);
  const regionCount = u32(8);

  const f32 = (o) => view.getFloat32(o, true);
  const vertexWords = [];
  const points = [];
  for (let i = 0; i < vertexCount; i++) {
    vertexWords.push(u32(12 + i * 12));
    points.push({ x: f32(12 + i * 12 + 4), y: f32(12 + i * 12 + 8) });
  }

  const segmentBase = 12 + vertexCount * 12;
  const segmentWords = [];
  for (let i = 0; i < segmentCount; i++) {
    const o = segmentBase + i * 28;
    segmentWords.push(u32(o));
    for (const vertex of [u32(o + 4), u32(o + 16)]) {
      if (vertex >= vertexCount) {
        throw new Error(`segment ${i} references vertex ${vertex} of ${vertexCount}`);
      }
    }
  }

  let off = segmentBase + segmentCount * 28;
  const regions = [];
  for (let r = 0; r < regionCount; r++) {
    const packed = u32(off); off += 4;
    const numLoops = u32(off); off += 4;
    const loops = [];
    for (let l = 0; l < numLoops; l++) {
      const segCount = u32(off); off += 4;
      const loop = [];
      for (let s = 0; s < segCount; s++) {
        const index = u32(off); off += 4;
        if (index >= segmentCount) {
          throw new Error(`region ${r} references segment ${index} of ${segmentCount}`);
        }
        loop.push(index);
      }
      loops.push(loop);
    }
    regions.push({ packed, loops });
  }

  if (off !== bytes.length) {
    throw new Error(`consumed ${off} of ${bytes.length} bytes — layout mismatch`);
  }
  return { vertexCount, segmentCount, regions, vertexWords, segmentWords, points };
}

/** Every vectorNetworkBlob reachable from a built deck. */
function collectBlobs(fig) {
  const found = [];
  for (const node of fig.message.nodeChanges) {
    const index = node.vectorData?.vectorNetworkBlob;
    if (index == null) continue;
    const blob = fig.message.blobs[index];
    const raw = blob?.bytes ?? blob;
    if (raw) found.push({ name: node.name, bytes: new Uint8Array(raw) });
  }
  return found;
}

const SVG_TWO_SUBPATHS =
  '<svg viewBox="0 0 100 100">' +
  '<path d="M10 10 C30 0 70 0 90 10 L90 40 Z M20 60 L60 60 L60 90 Z" fill="#000"/>' +
  '</svg>';

/** A deck holding filled, closed-subpath geometry, so regions are emitted. */
async function buildDeckWithVectors() {
  const deck = await Deck.create({ name: 'vnb-layout' });
  const slide = deck.addBlankSlide();
  slide.addSVG(100, 100, 200, SVG_TWO_SUBPATHS);
  return deck._fd;
}

describe('emitted vectorNetworkBlob layout', () => {
  it('emits blobs that parse byte-exact under Figma\'s verified layout', async () => {
    const fig = await buildDeckWithVectors();
    const blobs = collectBlobs(fig);

    // Guards against the assertions below silently covering nothing.
    expect(blobs.length, 'deck should contain at least one vectorNetworkBlob').toBeGreaterThan(0);

    for (const { name, bytes } of blobs) {
      expect(
        () => walkVerifiedLayout(bytes),
        `${name}: blob must parse byte-exact under the verified layout`,
      ).not.toThrow();

      // Byte-exactness alone does NOT pin the field order: a rotated vertex record
      // has the same 12-byte stride, so the walk still lands on the end. Reading
      // coordinates out of the wrong slots is what actually shows — a rotation puts
      // an integer word where a float belongs, collapsing the geometry. Verified by
      // mutation: restoring the old [x, y, mirroring] order fails this, not the
      // byte count.
      const { points } = walkVerifiedLayout(bytes);
      const xs = points.map((p) => p.x);
      const ys = points.map((p) => p.y);
      expect(points.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y)),
        `${name}: coordinates must be finite`).toBe(true);
      expect(Math.max(...xs) - Math.min(...xs),
        `${name}: decoded geometry must span a real width`).toBeGreaterThan(1);
      expect(Math.max(...ys) - Math.min(...ys),
        `${name}: decoded geometry must span a real height`).toBeGreaterThan(1);
    }
  });

  it('never emits the value 4 in the vertex or segment leading word', async () => {
    // 4 appears in no reference blob. Our emitter once wrote it in both slots,
    // which identified openfig-produced files on sight.
    const fig = await buildDeckWithVectors();
    const blobs = collectBlobs(fig);
    expect(blobs.length).toBeGreaterThan(0);

    for (const { name, bytes } of blobs) {
      const { vertexWords, segmentWords } = walkVerifiedLayout(bytes);
      expect(vertexWords.every((w) => w === 0), `${name}: vertex handleMirroring`).toBe(true);
      expect(segmentWords.every((w) => w === 0), `${name}: segment word0`).toBe(true);
    }
  });

  it('packs region winding as styleID<<1|NONZERO, with no trailing word', async () => {
    const fig = await buildDeckWithVectors();
    const blobs = collectBlobs(fig);

    const withRegions = blobs
      .map(({ name, bytes }) => ({ name, ...walkVerifiedLayout(bytes) }))
      .filter((blob) => blob.regions.length > 0);
    expect(withRegions.length, 'addSVG should emit regions').toBeGreaterThan(0);

    for (const blob of withRegions) {
      for (const region of blob.regions) {
        expect(region.packed, `${blob.name}: packed word`).toBe(1);
      }
    }
  });

  it('keeps multi-subpath geometry as separate loops in one region', async () => {
    // A single flat loop makes Figma join the end of one subpath to the start of
    // the next — a diagonal bar through multi-letter wordmarks.
    const fig = await buildDeckWithVectors();
    const blobs = collectBlobs(fig);

    const loopCounts = blobs
      .flatMap(({ bytes }) => walkVerifiedLayout(bytes).regions)
      .map((region) => region.loops.length);
    expect(Math.max(0, ...loopCounts), 'the two-subpath SVG should yield a 2-loop region').toBe(2);
  });
});
