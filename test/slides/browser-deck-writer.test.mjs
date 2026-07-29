/**
 * A `.deck` produced in a real browser, checked against the Node writer.
 *
 * Group 3 made a browser able to *measure* an export; group 4b makes it able
 * to write one. That second half is what is under test here, and it is tested
 * where it will actually run: the adapter is bundled, loaded into a page
 * served from a real origin, and asked to turn a standalone export into deck
 * bytes — Chromium's own zip, its own WebCrypto, its own WebAssembly zstd.
 *
 * Two comparisons, because they answer different questions:
 *
 *   1. **Writer parity, exact.** The manifest the browser measured is fed back
 *      through the *Node* writer, and every archive entry is compared after
 *      decompression: `canvas.fig`'s deflate chunk inflated, its zstd chunk
 *      decoded by `fzstd` — an independent decoder, not the encoder under
 *      test. Same geometry in, so any difference is the writer's, which is the
 *      only way to get an exact assertion out of a path where measurement can
 *      legitimately differ.
 *   2. **The whole path.** The same fixture converted by the real Node CLI
 *      path, compared on entry names and on the decoded document — node
 *      composition, text, and the two anchors' coordinates. Not byte equality:
 *      a real browser and headless Chromium are entitled to disagree in the
 *      last decimal, and a byte assertion there would be a flake generator.
 *
 * The fixture is `synthetic-viewer-chrome` deliberately: it declares no
 * assets, so `images/*` is empty and the entry set is exactly the three Figma
 * writes. With images the two paths *cannot* agree — `sharp` and Canvas encode
 * different PNG bytes, `addImage` names each entry after the sha1 of those
 * bytes, so the entry names themselves diverge. That divergence is documented
 * in `lib/core/image-ops.mjs` and is not a defect; asserting against it here
 * would only encode a falsehood.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { inflateRaw } from 'pako';
import { decompress as zstdDecompress } from 'fzstd';
import { resolveBrowser } from '../../lib/slides/playwright-layout.mjs';
import { convertStandaloneHtml } from '../../lib/slides/html-converter.mjs';
import { convertHandoffBundleToBytes } from '../../lib/slides/handoff-converter.mjs';
import { createMemoryBundle } from '../../lib/slides/browser/memory-bundle.mjs';
import { Deck } from '../../lib/slides/api.mjs';
import { FigDeck } from '../../lib/core/fig-deck.mjs';
import { unpackArchive } from '../../lib/core/archive.mjs';
import { bundleForBrowser, repoWarnings } from './browser-bundle.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..');
const FIXTURE = join(
  REPO, 'test', 'fixtures', 'standalone-html',
  'synthetic-viewer-chrome', 'synthetic-viewer-chrome.html',
);
// The only fixture that produces `images/*` — 7 sources and their 7
// thumbnails. Nothing above touches the image path at all, and the image path
// is where `putImage` and `canvasImageOps` live.
const IMAGE_FIXTURE = join(
  REPO, 'test', 'fixtures', 'standalone-html',
  'london-underground-map', 'london-underground-map.html',
);
// An <image> *inside* an inline SVG, which reaches the deck by a different
// route from an <img>: its source is hashed out of the live realm and joined
// back to a decoded asset, then rewritten inside serialised markup rather than
// in a field of its own. Two hosts, two media stores — Node spills a data URI
// to a file and the browser keeps bytes in a Map — so this is where the two
// can silently disagree about what a slide contains.
const SVG_IMAGE_FIXTURE = join(
  REPO, 'test', 'fixtures', 'standalone-html',
  'synthetic-svg-image', 'synthetic-svg-image.html',
);

// Same reasoning as `browser-host.test.mjs`: a real origin, so
// `URL.createObjectURL` produces a `blob:` the measurement iframe is
// same-origin with. Nothing is served over the network.
const HOST_ORIGIN = 'https://openfig.test';
const HOST_PAGE = '<!doctype html><html><head><meta charset="utf-8"><title>host</title></head><body></body></html>';

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');

/**
 * Split a `canvas.fig` into its header and its chunk payloads, decompressed.
 *
 * Chunk 0 is deflateRaw and chunk 1 is zstd, and both are the *compressed*
 * form of what actually matters — an encoder is free to emit different bytes
 * for the same input, which is exactly what follow-up 8.8 records. So compare
 * what comes out, using decoders that are not the encoders under test:
 * `pako.inflateRaw` and `fzstd`.
 */
function figChunks(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const prelude = new TextDecoder().decode(bytes.subarray(0, 8));
  const version = view.getUint32(8, true);
  const chunks = [];
  let off = 12;
  while (off < bytes.byteLength) {
    const len = view.getUint32(off, true);
    off += 4;
    chunks.push(bytes.subarray(off, off + len));
    off += len;
  }
  const payloads = chunks.map((c, i) => {
    if (i === 0) return inflateRaw(c);
    if (i === 1) return zstdDecompress(c);
    return c; // chunk 2+ is passed through uncompressed by `encodeFig`
  });
  return { prelude, version, chunkCount: chunks.length, payloads, trailing: off - bytes.byteLength };
}

/** Every entry, with `canvas.fig` reduced to its decompressed payload shas. */
function entryDigests(bytes) {
  const out = new Map();
  for (const [name, data] of unpackArchive(bytes)) {
    if (name === 'canvas.fig') {
      const { prelude, version, chunkCount, payloads } = figChunks(data);
      out.set(name, `${prelude}/${version}/${chunkCount}/${payloads.map(sha).join(',')}`);
    } else if (name === 'meta.json') {
      // `exported_at` is a wall clock and is contracted to differ.
      const meta = JSON.parse(new TextDecoder().decode(data));
      delete meta.exported_at;
      out.set(name, sha(Buffer.from(JSON.stringify(meta))));
    } else {
      out.set(name, sha(data));
    }
  }
  return out;
}

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

let browser;
let page;
let workDir;
let sourceHtml;
let inBrowser;          // { bytes, manifest, template, mediaCount, framesLeftBehind }
let nodeFromSameManifest; // Uint8Array
let nodeFromCli;        // Uint8Array

beforeAll(async () => {
  workDir = mkdtempSync(join(tmpdir(), 'browser-deck-writer-'));
  sourceHtml = readFileSync(FIXTURE, 'utf8');

  const { code, warnings } = await bundleForBrowser();
  const ours = repoWarnings(warnings);
  if (ours.length) {
    throw new Error(`bundling the browser adapter warned: ${ours.map((w) => w.message).join('; ')}`);
  }

  browser = await resolveBrowser();
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
  page = await context.newPage();
  await page.route(`${HOST_ORIGIN}/**`, (route) =>
    route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: HOST_PAGE }));
  await page.goto(`${HOST_ORIGIN}/`, { waitUntil: 'load' });
  await page.addScriptTag({ content: code });

  const raw = await page.evaluate(async (html) => {
    const { BrowserConversionHost, convertStandaloneToDeckBytes } = globalThis.OpenFigBrowser;
    const host = new BrowserConversionHost({
      // Offline and deterministic: this fixture's anchors are absolutely
      // positioned, so their coordinates do not depend on the font.
      sourceHtml: html, ensureInter: false, onLog: () => {},
    });
    const { bytes, manifest } = await convertStandaloneToDeckBytes(html, host, { silent: true });
    return {
      // Playwright serialises the return value, and a Uint8Array does not
      // survive that as itself.
      bytes: [...bytes],
      manifest,
      template: host.texts.get('template.html') ?? null,
      mediaCount: host.media.size,
      framesLeftBehind: document.querySelectorAll('iframe').length,
    };
  }, sourceHtml);
  inBrowser = { ...raw, bytes: new Uint8Array(raw.bytes) };

  // (1) The same geometry through the Node writer. `deckClass: Deck` is the
  // Node Deck, so this is `sharpImageOps` and the filesystem-backed `DeckIo` —
  // the writer every recorded baseline was produced with.
  const bundle = createMemoryBundle({
    manifest: inBrowser.manifest,
    html: inBrowser.template,
    media: [],
  });
  ({ bytes: nodeFromSameManifest } = await convertHandoffBundleToBytes(bundle, { deckClass: Deck }));

  // (2) The whole Node path, Playwright and all.
  const cliOut = join(workDir, 'node-path.deck');
  await convertStandaloneHtml(FIXTURE, cliOut, { scratchDir: join(workDir, 'build') });
  nodeFromCli = new Uint8Array(readFileSync(cliOut));
}, 300_000);

afterAll(async () => {
  await browser?.close();
  rmSync(workDir, { recursive: true, force: true });
});

describe('a .deck written in a real browser', () => {
  it('comes back as bytes, not as a promise of one', () => {
    expect(inBrowser.bytes.byteLength).toBeGreaterThan(10_000);
    // Local zip header. The browser produced a real archive, not JSON.
    expect([...inBrowser.bytes.subarray(0, 4)]).toEqual([0x50, 0x4b, 0x03, 0x04]);
  });

  it('parses as a Slides deck, with the fixture in it', () => {
    const fd = FigDeck.fromDeckBytes(inBrowser.bytes);
    expect(fd.header.prelude).toBe('fig-deck');
    expect(fd.getActiveSlides()).toHaveLength(1);
    const texts = fd.message.nodeChanges
      .filter((n) => n.type === 'TEXT')
      .map((n) => n.textData?.characters ?? '');
    expect(texts.some((t) => t.includes('ANCHOR ALPHA'))).toBe(true);
    expect(texts.some((t) => t.includes('ANCHOR BETA'))).toBe(true);
    // The host page must not have been measured. `browser-host.test.mjs`
    // proves the decoy is reachable; here it must simply be absent.
    expect(texts.some((t) => t.includes('HOST DECOY'))).toBe(false);
  });

  it('declares no assets, so the entry set is the three Figma writes', () => {
    expect(inBrowser.mediaCount).toBe(0);
    expect([...unpackArchive(inBrowser.bytes).keys()])
      .toEqual(['canvas.fig', 'thumbnail.png', 'meta.json']);
  });

  it('takes the measurement surface back down', () => {
    expect(inBrowser.framesLeftBehind).toBe(0);
  });
});

describe('browser writer vs Node writer, same geometry in', () => {
  it('produces the same entry names, in the same order', () => {
    const a = [...unpackArchive(inBrowser.bytes).keys()];
    const b = [...unpackArchive(nodeFromSameManifest).keys()];
    expect(a).toEqual(b);
  });

  it('produces the same entry contents after decompression', () => {
    const a = entryDigests(inBrowser.bytes);
    const b = entryDigests(nodeFromSameManifest);
    const differing = [...a].filter(([name, digest]) => b.get(name) !== digest).map(([n]) => n);
    expect(differing).toEqual([]);
  });

  it('agrees on the canvas.fig header and chunk table', () => {
    const a = figChunks(unpackArchive(inBrowser.bytes).get('canvas.fig'));
    const b = figChunks(unpackArchive(nodeFromSameManifest).get('canvas.fig'));
    expect(a.prelude).toBe(b.prelude);
    expect(a.version).toBe(b.version);
    expect(a.chunkCount).toBe(b.chunkCount);
    // No trailing bytes: a length-prefixed walk that ends anywhere but exactly
    // at the end means the writer emitted something the parser will not read.
    expect(a.trailing).toBe(0);
    expect(b.trailing).toBe(0);
  });
});

describe('browser deck vs the Node path end to end', () => {
  it('writes the same archive entries', () => {
    expect([...unpackArchive(inBrowser.bytes).keys()])
      .toEqual([...unpackArchive(nodeFromCli).keys()]);
  });

  it('describes the same document', () => {
    // Composition rather than bytes: measurement in a real browser and in
    // headless Chromium may legitimately differ in the last decimal, and this
    // is where that shows up. A missing or extra node is not a rounding
    // difference, so it is worth asserting exactly.
    const histogram = (bytes) => {
      const fd = FigDeck.fromDeckBytes(bytes);
      const out = {};
      for (const n of fd.message.nodeChanges.filter((x) => x.phase !== 'REMOVED')) {
        out[n.type] = (out[n.type] ?? 0) + 1;
      }
      return out;
    };
    expect(histogram(inBrowser.bytes)).toEqual(histogram(nodeFromCli));

    const texts = (bytes) => FigDeck.fromDeckBytes(bytes).message.nodeChanges
      .filter((n) => n.type === 'TEXT')
      .map((n) => n.textData?.characters ?? '')
      .sort();
    expect(texts(inBrowser.bytes)).toEqual(texts(nodeFromCli));
  });

  it('carries images, named by the hash of their own bytes', async () => {
    // The image path is the half everything above misses, and it is the half
    // 4b.4 rewrote: `copyToImagesDir` staged every image through `tmpdir()`,
    // and `putImage` keeps them in memory. A browser has neither, so if that
    // rewrite were wrong the deck would come back valid and imageless.
    //
    // Byte parity with Node is impossible here — `sharp` and Canvas encode
    // different PNGs, and `addImage` names each entry after the sha1 of those
    // bytes, so even the entry *names* diverge. What must hold instead is
    // internal consistency: every entry is named by its own sha1, and every
    // name `canvas.fig` references exists in the archive. A hash/entry
    // mismatch is precisely how this fails silently — Figma shows blanks.
    const html = readFileSync(IMAGE_FIXTURE, 'utf8');
    const b64 = await page.evaluate(async (source) => {
      const { BrowserConversionHost, convertStandaloneToDeckBytes } = globalThis.OpenFigBrowser;
      const host = new BrowserConversionHost({
        sourceHtml: source,
        // Offline: this asserts image plumbing, not geometry, and the font
        // preload is a network round trip.
        webFontPreload: false, ensureInter: false, onLog: () => {},
      });
      const { bytes } = await convertStandaloneToDeckBytes(source, host, { silent: true });
      // base64 rather than a plain array: this deck is megabytes, and
      // Playwright would serialise a `[...bytes]` element by element.
      return host.base64FromBytes(bytes);
    }, html);

    const bytes = new Uint8Array(Buffer.from(b64, 'base64'));
    const entries = unpackArchive(bytes);
    const images = [...entries].filter(([n]) => n.startsWith('images/'));
    expect(images.length).toBe(14);

    for (const [name, data] of images) {
      expect(data.byteLength).toBeGreaterThan(0);
      expect(createHash('sha1').update(data).digest('hex')).toBe(name.slice('images/'.length));
    }

    const fd = FigDeck.fromDeckBytes(bytes);
    const referenced = new Set();
    for (const node of fd.message.nodeChanges) {
      for (const paint of node.fillPaints ?? []) {
        if (paint.image?.name) referenced.add(paint.image.name);
        if (paint.imageThumbnail?.name) referenced.add(paint.imageThumbnail.name);
      }
    }
    expect(referenced.size).toBe(14);
    const present = new Set(images.map(([n]) => n.slice('images/'.length)));
    expect([...referenced].filter((h) => !present.has(h))).toEqual([]);
  }, 300_000);

  it('places the far anchor at its authored coordinates, in both', () => {
    // The scale bug's signature: at the unfitted 0.902 this lands near
    // (1263, 722) instead of (1400, 800), and only a far anchor makes a
    // uniform scale error look like an error rather than rounding.
    const beta = findText(inBrowser.manifest.slides[0], 'ANCHOR BETA');
    expect(beta.x).toBeCloseTo(1400, 0);
    expect(beta.y).toBeCloseTo(800, 0);

    const placed = (bytes) => {
      const fd = FigDeck.fromDeckBytes(bytes);
      const node = fd.message.nodeChanges.find(
        (n) => n.type === 'TEXT' && (n.textData?.characters ?? '').includes('ANCHOR BETA'),
      );
      return { x: node.transform.m02, y: node.transform.m12 };
    };
    const fromBrowser = placed(inBrowser.bytes);
    const fromNode = placed(nodeFromCli);
    expect(fromBrowser.x).toBeCloseTo(fromNode.x, 0);
    expect(fromBrowser.y).toBeCloseTo(fromNode.y, 0);
  });

  it('converts an <image> and a pattern fill inside an inline SVG identically in both hosts', async () => {
    // The two hosts resolve a media reference through entirely different
    // machinery — Node writes a data URI out to the bundle's media directory
    // and hands `addImage` a path, the browser decodes it to bytes and hands
    // over a record — and neither one fails loudly when it comes up empty. The
    // symptom of a host-specific break is a slide that converts, reports
    // success, and is missing its picture in one host only.
    //
    // The fixture's <pattern> goes through a *third* piece of machinery that
    // differs per host: a pattern fill is rasterised, and the two backends are
    // librsvg under sharp and Chromium's own SVG decoder behind an <img>.
    // Neither is obliged to produce the same PNG, but a tile at a different
    // size repeats at a different pitch, which is a visibly different fill.
    //
    // Placement and raster *dimensions* rather than bytes, for the reason at
    // the top of this file: sharp and Canvas encode different PNGs for the
    // same pixels, so the archive entry names are contracted to differ. What
    // must match is how many images there are, where they sit, and how big
    // their pixels are.
    const html = readFileSync(SVG_IMAGE_FIXTURE, 'utf8');
    const b64 = await page.evaluate(async (source) => {
      const { BrowserConversionHost, convertStandaloneToDeckBytes } = globalThis.OpenFigBrowser;
      const host = new BrowserConversionHost({
        sourceHtml: source, webFontPreload: false, ensureInter: false, onLog: () => {},
      });
      const { bytes } = await convertStandaloneToDeckBytes(source, host, { silent: true });
      return host.base64FromBytes(bytes);
    }, html);

    const cliOut = join(workDir, 'svg-image.deck');
    await convertStandaloneHtml(SVG_IMAGE_FIXTURE, cliOut, {
      scratchDir: join(workDir, 'svg-image-build'),
      silent: true,
    });

    const placements = (bytes) => FigDeck.fromDeckBytes(bytes).message.nodeChanges
      .filter((n) => (n.fillPaints ?? []).some((p) => p.type === 'IMAGE'))
      .map((n) => {
        const paint = n.fillPaints.find((p) => p.type === 'IMAGE');
        return {
          x: n.transform.m02,
          y: n.transform.m12,
          width: n.size.x,
          height: n.size.y,
          scaleMode: paint.imageScaleMode,
          rasterWidth: paint.originalImageWidth,
          rasterHeight: paint.originalImageHeight,
          scale: paint.scale,
        };
      });

    const fromBrowser = placements(new Uint8Array(Buffer.from(b64, 'base64')));
    // Three: the asset-backed image, the data: URI, and the rect whose fill is
    // the <pattern>. The fixture's fourth <image> is an external URL, and both
    // hosts have to agree about refusing it as well as about drawing the rest.
    expect(fromBrowser).toHaveLength(3);
    expect(fromBrowser.filter((p) => p.scaleMode === 'TILE')).toHaveLength(1);
    expect(fromBrowser).toEqual(placements(new Uint8Array(readFileSync(cliOut))));
  }, 300_000);
});
