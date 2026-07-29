/**
 * End-to-end guard for <image> inside an inline SVG, from a standalone export
 * through the extractor and the asset join to the nodes in a real .deck.
 *
 * The unit tests in test/slides/svg-image-embed.test.mjs drive the parser
 * directly, on markup written by hand. This file exists because two of the
 * three things that have to work are not in the parser at all:
 *
 *   - A real export writes `href="<asset uuid>"` and its own runtime replaces
 *     it with a blob: URL before anything measures the page. Nothing carries
 *     the uuid forward, so the bytes have to be hashed and matched back to a
 *     decoded asset — the same join <img> already goes through, which nobody
 *     had extended to SVG. A parser that handles <image> perfectly still
 *     produces an empty slide if that join is missing.
 *   - The refusal to fetch an external URL is a privacy boundary. It is worth
 *     asserting against a live browser, because that is the only place a
 *     regression could actually make the request.
 *
 * The deck is opened rather than the manifest inspected: image *content* is
 * what was lost, and the manifest only carries markup.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { convertStandaloneHtml } from '../../../../lib/slides/html-converter.mjs';
import { FigDeck } from '../../../../lib/core/fig-deck.mjs';

const FIXTURE_DIR = dirname(fileURLToPath(import.meta.url));
const HTML_PATH = join(FIXTURE_DIR, 'synthetic-svg-image.html');

let workDir;
let manifest;
let warnings;
let imageNodes;
let patternNodes;

/** Every node in the deck carrying an IMAGE paint, in creation order. */
const imagePlacements = () => imageNodes.map((n) => ({
  x: n.transform.m02,
  y: n.transform.m12,
  width: n.size.x,
  height: n.size.y,
}));

beforeAll(async () => {
  workDir = mkdtempSync(join(tmpdir(), 'svgimg-html-'));
  const buildDir = join(workDir, 'build');
  const deckPath = join(workDir, 'out.deck');
  const res = await convertStandaloneHtml(HTML_PATH, deckPath, {
    scratchDir: buildDir,
    silent: true,
  });
  warnings = res.warnings;
  manifest = JSON.parse(readFileSync(join(buildDir, 'manifest.json'), 'utf8'));
  const deck = await FigDeck.fromFile(deckPath);
  const paints = (n) => (Array.isArray(n.fillPaints) ? n.fillPaints : []);
  // Nodes the <image> branch created. A TILE paint is a *pattern* fill — the
  // <image> inside <defs><pattern> now reaches the deck as one, painted
  // through the reference rather than where it stands — so counting it here
  // would say the pattern definition had been drawn in place, which is the
  // failure the fixture's third case exists to catch.
  imageNodes = deck.message.nodeChanges.filter(
    (n) => paints(n).some((p) => p.type === 'IMAGE' && p.imageScaleMode !== 'TILE'),
  );
  patternNodes = deck.message.nodeChanges.filter(
    (n) => paints(n).some((p) => p.type === 'IMAGE' && p.imageScaleMode === 'TILE'),
  );
}, 180_000);

afterAll(() => {
  rmSync(workDir, { recursive: true, force: true });
});

describe('<image> embedded in an inline SVG', () => {
  it('converts the two readable images and neither of the other two', () => {
    // Three would mean the <pattern> definition was painted where it stands;
    // four would mean the external URL was fetched. One means the asset join
    // failed and only the data: URI survived — the failure mode the blob
    // rehydration in the fixture exists to catch.
    expect(imagePlacements()).toHaveLength(2);
  });

  it('places each image where the SVG puts it, in slide coordinates', () => {
    // viewBox 0 0 800 400 rendered into an 800x400 box at (100,100), so the
    // mapping is a pure translate and the numbers are checkable by hand.
    // The second image is authored at 10,20 / 50x40 under
    // `translate(300,0) scale(2)`.
    expect(imagePlacements()).toEqual([
      { x: 120, y: 130, width: 200, height: 150 },
      { x: 420, y: 140, width: 100, height: 80 },
    ]);
  });

  it('carries real pixels for both, not a placeholder', () => {
    // originalImageWidth comes from decoding the bytes that reached addImage.
    // A source that resolved to nothing would not get this far, but a source
    // that resolved to the *wrong* bytes would, and this is the cheapest
    // thing that notices.
    for (const n of imageNodes) {
      const paint = n.fillPaints.find((p) => p.type === 'IMAGE');
      expect(paint.originalImageWidth).toBe(4);
      expect(paint.originalImageHeight).toBe(4);
    }
  });

  it('rewrites the blob: href to the extracted asset', () => {
    // The blob: URL is meaningless outside the realm that minted it. Left in
    // the manifest the handoff sees a scheme it refuses to read, and the image
    // is dropped for a reason that looks exactly like the privacy rule doing
    // its job.
    const svg = manifest.slides[0].elements.find((el) => el.type === 'svg');
    expect(svg.inline).not.toContain('blob:');
    expect(svg.inline).toContain('media/a1b2c3d4-0000-4000-8000-000000000001.png');
  });

  it('reports the external source and does not fetch it', () => {
    const external = warnings.filter((w) => /<image> with an external source/.test(w.msg));
    expect(external).toHaveLength(1);
    // The host is .invalid — reserved and unresolvable — so a fetch could only
    // ever fail. What proves it was not attempted is that the conversion
    // reported the skip rather than an unreachable asset.
    expect(external[0].msg).toContain('images.example.invalid');
  });

  it('no longer reports embedded images as an unconverted construct', () => {
    // They were on the unsupported list while they really were being dropped.
    // Leaving them there once they convert trains people to ignore the list,
    // which is the one thing the list cannot survive.
    const stale = warnings.filter((w) => /images embedded in the SVG/.test(w.msg));
    expect(stale).toEqual([]);
  });

  it('reaches the pattern fill through the reference instead of in place', () => {
    // This assertion used to read the other way round: the pattern fill was a
    // known remaining loss and the conversion said so. It converts now, and
    // the distinction the fixture was built around still has to hold — the
    // <image> is painted where the *fill* is, not where the definition sits.
    //
    // The rect carrying `fill="url(#pat)"` is authored at 0,350 100x40 in a
    // viewBox mapped by a translate of (100,100). A tile whose paint landed on
    // some other node, or a definition drawn at the SVG origin, both fail here.
    expect(patternNodes).toHaveLength(1);
    const [node] = patternNodes;
    expect({
      x: node.transform.m02, y: node.transform.m12, width: node.size.x, height: node.size.y,
    }).toEqual({ x: 100, y: 450, width: 100, height: 40 });
    // The pattern's period is 100x100 user units, of which only the shape's
    // own 100x40 is ever visible — but the tile is a full period, rasterised
    // at 2x. Cropping it to the shape instead would repeat a squashed copy.
    const paint = node.fillPaints.find((p) => p.type === 'IMAGE');
    expect([paint.originalImageWidth, paint.originalImageHeight]).toEqual([200, 200]);
  });

  it('no longer reports pattern fills as an unconverted construct', () => {
    expect(warnings.filter((w) => /pattern fills/.test(w.msg))).toEqual([]);
  });
});
