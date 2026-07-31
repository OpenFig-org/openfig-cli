/**
 * End-to-end guard for source-aware editable image-filter calibration.
 *
 * This intentionally starts at a standalone export rather than a hand-written
 * manifest. It proves the live blob asset is joined back to its original bytes,
 * analyzed locally, and emitted as one editable IMAGE paint without replacing
 * or re-encoding the source.
 */
import { createHash } from 'node:crypto';
import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
} from 'vitest';
import {
  mkdtempSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import {
  dirname,
  join,
} from 'node:path';
import { fileURLToPath } from 'node:url';
import { convertStandaloneHtml } from '../../../../lib/slides/html-converter.mjs';
import { FigDeck } from '../../../../lib/core/fig-deck.mjs';
import {
  exposureForBrightness,
  toneAdjustmentsForBrightness,
} from '../../../../lib/slides/handoff/element-dispatch.mjs';

const FIXTURE_DIR = dirname(fileURLToPath(import.meta.url));
const HTML_PATH = join(FIXTURE_DIR, 'synthetic-source-aware-filter.html');
const ORANGE = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAYAAACp8Z5+AAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEklEQVR4nGP438DwHxkzkC4AAFBPJ+HrAPilAAAAAElFTkSuQmCC',
  'base64',
);
const NEUTRAL = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAYAAACp8Z5+AAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEklEQVR4nGMoKSn5j4wZSBcAAPTYJbFsJBCwAAAAAElFTkSuQmCC',
  'base64',
);
const MAGENTA = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAYAAACp8Z5+AAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEklEQVR4nGP4z/D/PzJmIF0AAFJGL9GxFZDvAAAAAElFTkSuQmCC',
  'base64',
);

let workDir;
let deck;
let images;

const sha1 = (bytes) => createHash('sha1').update(bytes).digest('hex');

beforeAll(async () => {
  workDir = mkdtempSync(join(tmpdir(), 'source-aware-filter-'));
  const out = join(workDir, 'out.deck');
  await convertStandaloneHtml(HTML_PATH, out, {
    scratchDir: join(workDir, 'build'),
    silent: true,
  });
  deck = FigDeck.fromDeckBytes(readFileSync(out));
  images = deck.message.nodeChanges
    .filter((node) =>
      node.fillPaints?.some((paint) => paint.type === 'IMAGE'))
    .sort((a, b) => a.transform.m02 - b.transform.m02);
}, 180_000);

afterAll(() => {
  rmSync(workDir, { recursive: true, force: true });
});

describe('source-aware editable filter conversion', () => {
  it('keeps one original IMAGE paint per source', () => {
    expect(images).toHaveLength(3);
    for (const node of images) {
      expect(node.fillPaints).toHaveLength(1);
      expect(node.fillPaints[0].type).toBe('IMAGE');
      expect(node.pluginData).toBeUndefined();
    }
  });

  it('uses both source-aware paths and the neutral global refinement', () => {
    expect(images[0].fillPaints[0].paintFilter.exposure)
      .toBeCloseTo(exposureForBrightness(1.18), 4);
    expect(images[0].fillPaints[0].paintFilter.highlights).toBeUndefined();
    expect(images[0].fillPaints[0].paintFilter.shadows).toBeUndefined();
    const magenta = images[1].fillPaints[0].paintFilter;
    const expectedMagenta = toneAdjustmentsForBrightness(1.18, {
      darkColorRisk: 1,
    });
    expect(magenta.exposure).toBeCloseTo(expectedMagenta.exposure, 4);
    expect(magenta.highlights).toBeCloseTo(expectedMagenta.highlights, 4);
    expect(magenta.shadows).toBeCloseTo(expectedMagenta.shadows, 4);
    const neutral = images[2].fillPaints[0].paintFilter;
    const expected = toneAdjustmentsForBrightness(1.18);
    expect(neutral.exposure).toBeCloseTo(expected.exposure, 4);
    expect(neutral.highlights).toBeCloseTo(expected.highlights, 4);
    expect(neutral.shadows).toBeCloseTo(expected.shadows, 4);
  });

  it('stores every source asset byte-for-byte rather than baking it', () => {
    expect(Buffer.from(deck.images.get(sha1(ORANGE)))).toEqual(ORANGE);
    expect(Buffer.from(deck.images.get(sha1(MAGENTA)))).toEqual(MAGENTA);
    expect(Buffer.from(deck.images.get(sha1(NEUTRAL)))).toEqual(NEUTRAL);
    expect(images[0].fillPaints[0].image.name).toBe(sha1(ORANGE));
    expect(images[1].fillPaints[0].image.name).toBe(sha1(MAGENTA));
    expect(images[2].fillPaints[0].image.name).toBe(sha1(NEUTRAL));
  });
});
