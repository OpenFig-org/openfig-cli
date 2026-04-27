/**
 * End-to-end test for the Claude Design standalone HTML converter.
 * Drives convertStandaloneHtml against the LU standalone-HTML export and
 * asserts the resulting .deck contains the expected structure.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, statSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { convertStandaloneHtml } from '../../../../lib/slides/html-converter.mjs';
import { FigDeck } from '../../../../lib/core/fig-deck.mjs';

const FIXTURE_DIR = dirname(fileURLToPath(import.meta.url));
const HTML_PATH = join(FIXTURE_DIR, 'London-Underground-Map.html');

let workDir;
let outPath;
let fd;

beforeAll(async () => {
  workDir = mkdtempSync(join(tmpdir(), 'lu-html-'));
  outPath = join(workDir, 'lu.deck');
  await convertStandaloneHtml(HTML_PATH, outPath, { scratchDir: join(workDir, 'build') });
  fd = await FigDeck.fromDeckFile(outPath);
}, 60_000);

afterAll(() => {
  rmSync(workDir, { recursive: true, force: true });
});

const allNodes = () => fd.message.nodeChanges.filter(n => n.phase !== 'REMOVED');
const slidesOnly = () => allNodes().filter(n => n.type === 'SLIDE');

describe('LU standalone HTML → .deck build', () => {
  it('writes a non-empty .deck file', () => {
    expect(existsSync(outPath)).toBe(true);
    expect(statSync(outPath).size).toBeGreaterThan(10_000);
  });

  it('produces 12 slides from the 12 <section> tags', () => {
    expect(slidesOnly()).toHaveLength(12);
  });

  it('emits the cover title text on slide 1', () => {
    const texts = allNodes().filter(n => n.type === 'TEXT');
    const london = texts.find(n => n.textData?.characters === 'LONDON');
    const underground = texts.find(n => n.textData?.characters === 'UNDERGROUND MAP');
    expect(london).toBeTruthy();
    expect(underground).toBeTruthy();
  });

  it('flows block-layout children inside absolute-positioned columns on slide 2', () => {
    const texts = allNodes().filter(n => n.type === 'TEXT');
    const before = texts.find(n => n.textData?.characters === 'BEFORE 1933');
    const from = texts.find(n => n.textData?.characters === 'FROM 1933');
    expect(before).toBeTruthy();
    expect(from).toBeTruthy();
    expect(before.transform.m02).toBe(86);
    expect(before.transform.m12).toBe(290);
    expect(from.transform.m02).toBe(1003);
    expect(from.transform.m12).toBe(290);
  });

  it('gives paragraph text a realistic (not 2-px) computed height', () => {
    const texts = allNodes().filter(n => n.type === 'TEXT');
    const body = texts.find(n => n.textData?.characters?.startsWith('The Underground was drawn'));
    expect(body).toBeTruthy();
    expect(body.size.y).toBeGreaterThan(100);
  });

  it('resolves unitless CSS line-height by multiplying by font-size', () => {
    const texts = allNodes().filter(n => n.type === 'TEXT');
    const body = texts.find(n => n.textData?.characters?.startsWith('The Underground was drawn'));
    expect(body.lineHeight.units).toBe('PIXELS');
    expect(body.lineHeight.value).toBeGreaterThan(20);
  });

  it('decodes gzip-compressed media assets from the __bundler/manifest script', () => {
    const images = allNodes().filter(n => n.fillPaints?.some?.(p => p.type === 'IMAGE'));
    expect(images.length).toBeGreaterThanOrEqual(1);
  });

  it('maps the HTML <title> to the deck presentation name when --title is omitted', () => {
    expect(fd.deckMeta?.file_name).toMatch(/London/i);
  });
});
