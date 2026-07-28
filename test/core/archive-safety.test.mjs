/**
 * A `.deck` is a document people receive from others, so its archive entry
 * names are attacker-controlled. Extraction used to shell out to `unzip`,
 * which refuses `..` path components; doing it in-process means enforcing
 * containment ourselves, or a crafted deck can overwrite any file the user
 * can write — reachable from every command that opens a deck, including
 * read-only ones like `inspect`.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { FigDeck } from '../../lib/core/fig-deck.mjs';
import { unpackArchive, packArchive } from '../../lib/core/archive.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DECK_PATH = join(__dirname, '../fixtures/decks/reference/oil-machinations.deck');

let workDir;
let victim;
let sourceEntries;

/** Build a deck carrying one extra entry under `name`. */
function deckWithEntry(name, contents) {
  const entries = new Map(sourceEntries);
  entries.set(name, new TextEncoder().encode(contents));
  return packArchive(entries);
}

beforeAll(() => {
  workDir = mkdtempSync(join(tmpdir(), 'slip-'));
  victim = join(workDir, 'important.txt');
  writeFileSync(victim, 'ORIGINAL CONTENT');
  sourceEntries = unpackArchive(new Uint8Array(readFileSync(DECK_PATH)));
});

afterAll(() => {
  rmSync(workDir, { recursive: true, force: true });
});

describe('archive entries that escape the extraction directory', () => {
  it('refuses a traversal entry instead of writing outside the temp dir', () => {
    const escaped = `images/${'../'.repeat(12)}${victim.replace(/^\//, '')}`;
    const deck = FigDeck.fromDeckBytes(deckWithEntry(escaped, 'CLOBBERED'));

    expect(() => deck._materializeImages()).toThrow(/escapes the images directory/);
    expect(readFileSync(victim, 'utf8')).toBe('ORIGINAL CONTENT');
  });

  it('refuses an absolute entry name', () => {
    const deck = FigDeck.fromDeckBytes(deckWithEntry(`images/${victim}`, 'CLOBBERED'));

    expect(() => deck._materializeImages()).toThrow(/escapes the images directory/);
    expect(readFileSync(victim, 'utf8')).toBe('ORIGINAL CONTENT');
  });

  it('still extracts legitimate nested image paths', () => {
    const deck = FigDeck.fromDeckBytes(deckWithEntry('images/nested/dir/logo.bin', 'fine'));

    expect(() => deck._materializeImages()).not.toThrow();
    expect(existsSync(join(deck.imagesDir, 'nested/dir/logo.bin'))).toBe(true);
  });
});
