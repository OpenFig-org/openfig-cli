/**
 * A handoff bundle held in memory must produce the same deck as the same
 * bundle read off disk.
 *
 * The browser path has no filesystem, so `handoff/bundle-loader.mjs` — with
 * its `realpath` containment, its manifest-root scan and its temp-directory
 * extraction — has no analogue there. `browser/memory-bundle.mjs` supplies the
 * small object the element dispatcher actually consumes instead. This drives
 * the *Node* deck writer from both, so the substitution is checked against the
 * reference implementation rather than against itself.
 *
 * The fixture is the only one in the suite with images, which is the whole
 * point: `resolveMedia` is where the two differ, returning a path on one side
 * and `{ filename, bytes, mime }` on the other.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { convertHandoffBundle } from '../../lib/slides/handoff-converter.mjs';
import { createMemoryBundle } from '../../lib/slides/browser/memory-bundle.mjs';
import { unpackArchive } from '../../lib/core/archive.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, '..', 'fixtures', 'designer-bundles', 'london-underground-map');

let workDir;
let fromDisk;
let fromMemory;

function entryDigests(deckPath) {
  const out = new Map();
  for (const [name, data] of unpackArchive(readFileSync(deckPath))) {
    out.set(name, createHash('sha256').update(data).digest('hex'));
  }
  return out;
}

beforeAll(async () => {
  workDir = mkdtempSync(join(tmpdir(), 'memory-bundle-'));

  const diskDeck = join(workDir, 'disk.deck');
  await convertHandoffBundle(FIXTURE, diskDeck);
  fromDisk = entryDigests(diskDeck);

  // Read the same bundle into the shape a browser conversion produces: the
  // parsed manifest, the template HTML as a string, and every media asset as
  // bytes with its mime type.
  const manifest = JSON.parse(readFileSync(join(FIXTURE, 'manifest.json'), 'utf8'));
  const htmlName = readdirSync(FIXTURE).find((f) => f.toLowerCase().endsWith('.html'));
  const html = readFileSync(join(FIXTURE, htmlName), 'utf8');
  const media = readdirSync(join(FIXTURE, 'media')).map((filename) => ({
    filename,
    bytes: new Uint8Array(readFileSync(join(FIXTURE, 'media', filename))),
  }));

  const memoryDeck = join(workDir, 'memory.deck');
  await convertHandoffBundle(createMemoryBundle({ manifest, html, media }), memoryDeck);
  fromMemory = entryDigests(memoryDeck);
}, 180_000);

afterAll(() => {
  rmSync(workDir, { recursive: true, force: true });
});

describe('an in-memory handoff bundle', () => {
  it('produces the same set of archive entries', () => {
    expect([...fromMemory.keys()].sort()).toEqual([...fromDisk.keys()].sort());
  });

  it('carries the fixture\'s images across', () => {
    // Eight sources plus their eight sharp thumbnails. A resolver that quietly
    // resolved nothing would still produce a valid deck, just an imageless one,
    // so the count is asserted rather than assumed from the entry-set match.
    const images = [...fromDisk.keys()].filter((n) => n.startsWith('images/'));
    expect(images).toHaveLength(16);
  });

  it('produces byte-identical entries, canvas.fig included', () => {
    // `meta.json` carries a wall-clock `exported_at` and is the one entry
    // contracted to differ between any two runs.
    const differing = [...fromDisk]
      .filter(([name, digest]) => fromMemory.get(name) !== digest)
      .map(([name]) => name);
    expect(differing).toEqual(['meta.json']);
  });
});

describe('the in-memory media resolver', () => {
  const bundle = createMemoryBundle({
    manifest: { slides: [] },
    media: [{ filename: 'logo.svg', bytes: new Uint8Array([1, 2, 3]) }],
  });

  it('resolves the manifest\'s `media/<name>` form', () => {
    const hit = bundle.resolveMedia('media/logo.svg');
    expect([...hit.bytes]).toEqual([1, 2, 3]);
  });

  it('infers the mime type, which is the only SVG signal left once the path is gone', () => {
    // `bakeImageFilter` used to detect SVG by testing the path for `.svg`.
    // Handed bytes it would silently answer "no" and rasterise at default
    // density — blurry rather than wrong, so nothing downstream notices.
    expect(bundle.resolveMedia('media/logo.svg').mime).toBe('image/svg+xml');
  });

  it('decodes a data: URL, as the on-disk loader does', () => {
    const hit = bundle.resolveMedia('data:image/png;base64,AAEC');
    expect(hit.mime).toBe('image/png');
    expect([...hit.bytes]).toEqual([0, 1, 2]);
  });

  it('reports a missing asset rather than resolving to nothing', () => {
    expect(() => bundle.resolveMedia('media/absent.png')).toThrow(/Media asset not found/);
  });
});
