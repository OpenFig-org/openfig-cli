/**
 * font-resolver.mjs — Auto-download Google Fonts for deck rendering.
 *
 * Scans a FigDeck for font families used, downloads missing ones from
 * Google Fonts, patches nameID 1 for resvg matching, and caches locally.
 *
 * Usage:
 *   import { resolveFonts } from './font-resolver.mjs';
 *   await resolveFonts(deck);  // downloads + registers missing fonts
 *   const pngs = await renderDeck(deck);
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { homedir } from 'os';
import { nid } from '../core/node-helpers.mjs';
import { registerFont } from './deck-rasterizer.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Built-in fonts (already loaded by deck-rasterizer.mjs) ──────────────────

const BUILTIN_FAMILIES = new Set([
  'inter',
  'darker grotesque',
  'irish grover',
]);

// ── Cache directory ──────────────────────────────────────────────────────────

const CACHE_DIR = join(homedir(), '.openfig', 'fonts');

function ensureCacheDir() {
  if (!existsSync(CACHE_DIR)) mkdirSync(CACHE_DIR, { recursive: true });
}

// ── Scan deck for font families + weights ────────────────────────────────────

/**
 * Walk all nodes in a deck and collect {family → Set<weight>} for fonts used.
 * @param {import('../fig-deck.mjs').FigDeck} deck
 * @returns {Map<string, Set<number>>}  family name → set of numeric weights
 */
export function scanDeckFonts(deck) {
  const fonts = new Map(); // family → Set<weight>

  function addFont(family, weight) {
    if (!family) return;
    const key = family.trim();
    if (!key) return;
    if (!fonts.has(key)) fonts.set(key, new Set());
    fonts.get(key).add(weight);
  }

  function weightFromStyle(style) {
    if (!style) return 400;
    if (/black|heavy/i.test(style)) return 900;
    if (/extrabold|ultra\s*bold/i.test(style)) return 800;
    if (/bold/i.test(style)) return 700;
    if (/semibold|demi\s*bold/i.test(style)) return 600;
    if (/medium/i.test(style)) return 500;
    if (/light/i.test(style)) return 300;
    if (/thin|hairline/i.test(style)) return 100;
    return 400;
  }

  function walkNode(node) {
    if (node.phase === 'REMOVED') return;

    // TEXT nodes
    if (node.fontName?.family) {
      addFont(node.fontName.family, weightFromStyle(node.fontName.style));
    }

    // Per-run style overrides
    if (node.textData?.styleOverrideTable) {
      for (const ov of node.textData.styleOverrideTable) {
        if (ov.fontName?.family) {
          addFont(ov.fontName.family, weightFromStyle(ov.fontName.style));
        }
      }
    }

    // SHAPE_WITH_TEXT text overrides
    const genOvs = node.nodeGenerationData?.overrides;
    if (genOvs?.[1]?.fontName?.family) {
      addFont(genOvs[1].fontName.family, weightFromStyle(genOvs[1].fontName.style));
    }

    // Recurse children
    for (const child of deck.getChildren(nid(node))) {
      walkNode(child);
    }
  }

  for (const slide of deck.getActiveSlides()) {
    walkNode(slide);
  }

  return fonts;
}

// ── Google Fonts download ────────────────────────────────────────────────────

/**
 * Fetch Google Fonts CSS and parse TTF URLs per weight.
 * @param {string} family  e.g. "Darker Grotesque"
 * @param {number[]} weights  e.g. [400, 500, 600, 700]
 * @returns {Promise<Map<number, string>>}  weight → TTF URL
 */
async function fetchGoogleFontUrls(family, weights) {
  const slug = family.replace(/\s+/g, '+');
  const wStr = weights.sort((a, b) => a - b).join(';');
  const url = `https://fonts.googleapis.com/css2?family=${slug}:wght@${wStr}`;

  const resp = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0' }, // gets TTF format
  });
  if (!resp.ok) return new Map();

  const css = await resp.text();
  const urls = new Map();

  // Parse @font-face blocks: font-weight: N ... src: url(...) format('truetype')
  const blocks = css.split('@font-face');
  for (const block of blocks) {
    const wMatch = block.match(/font-weight:\s*(\d+)/);
    const uMatch = block.match(/src:\s*url\(([^)]+\.ttf)\)/);
    if (wMatch && uMatch) {
      urls.set(parseInt(wMatch[1]), uMatch[1]);
    }
  }
  return urls;
}

/**
 * Download a TTF from a URL.
 * @param {string} url
 * @returns {Promise<Buffer>}
 */
async function downloadFont(url) {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Failed to download font: ${resp.status} ${url}`);
  return Buffer.from(await resp.arrayBuffer());
}

// ── System font lookup ───────────────────────────────────────────────────────

/**
 * Platform-specific system font directories.
 * Figma supports local fonts installed via the OS font manager (TTF/OTF only).
 */
function getSystemFontDirs() {
  const home = homedir();
  switch (process.platform) {
    case 'darwin':
      return [
        '/System/Library/Fonts',
        '/Library/Fonts',
        join(home, 'Library/Fonts'),
      ];
    case 'win32':
      return [
        join(process.env.WINDIR || 'C:\\Windows', 'Fonts'),
        join(home, 'AppData/Local/Microsoft/Windows/Fonts'),
      ];
    default: // linux
      return [
        '/usr/share/fonts',
        '/usr/local/share/fonts',
        join(home, '.local/share/fonts'),
      ];
  }
}

/**
 * Search system font directories for a font family.
 * Matches filenames heuristically: "DarkerGrotesque-Medium.ttf" for family
 * "Darker Grotesque" weight 500. Returns found file paths.
 *
 * @param {string} family  e.g. "Darker Grotesque"
 * @param {number[]} weights  e.g. [400, 500, 600, 700]
 * @returns {Map<number, string>}  weight → file path (only found weights)
 */
function findSystemFonts(family, weights) {
  const results = new Map();
  // Build filename patterns: "darkergrotesque", "darker-grotesque", "darker_grotesque"
  const slug = family.toLowerCase().replace(/\s+/g, '');
  const slugDash = family.toLowerCase().replace(/\s+/g, '-');
  const slugUnderscore = family.toLowerCase().replace(/\s+/g, '_');
  const patterns = [slug, slugDash, slugUnderscore];

  const weightNames = {
    100: ['thin', 'hairline'],
    200: ['extralight', 'ultralight'],
    300: ['light'],
    400: ['regular', 'normal', ''],
    500: ['medium'],
    600: ['semibold', 'demibold'],
    700: ['bold'],
    800: ['extrabold', 'ultrabold'],
    900: ['black', 'heavy'],
  };

  function scanDir(dir) {
    try {
      const entries = readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) { scanDir(full); continue; }
        if (!/\.(ttf|otf|ttc)$/i.test(entry.name)) continue;
        const lower = entry.name.toLowerCase();
        // Check if filename contains the family slug
        if (!patterns.some(p => lower.includes(p))) continue;

        // TTC files bundle all weights — map to every requested weight
        if (/\.ttc$/i.test(entry.name)) {
          for (const w of weights) {
            if (!results.has(w)) results.set(w, full);
          }
          continue;
        }

        // TTF/OTF: try to match weight from filename
        for (const w of weights) {
          if (results.has(w)) continue;
          const names = weightNames[w] || [];
          for (const wn of names) {
            if (wn === '' && (lower.includes('-regular') || lower.includes('regular') || !/-\w+\./.test(lower))) {
              results.set(w, full);
            } else if (wn && lower.includes(wn)) {
              results.set(w, full);
            }
          }
        }
      }
    } catch { /* dir doesn't exist or permission denied */ }
  }

  for (const dir of getSystemFontDirs()) {
    scanDir(dir);
    if (results.size === weights.length) break; // found all weights
  }
  return results;
}

// ── TTF name table patcher (zero dependencies) ──────────────────────────────
//
// Patches nameID 1 (font family) and nameID 16 (preferred family) in a TTF
// file so resvg can match font-family="X" in SVG to the font binary.
//
// Approach: rebuild the name table with new strings, then reconstruct the
// entire TTF file with updated table directory and checksums.

function u16(buf, off) { return buf.readUInt16BE(off); }
function u32(buf, off) { return buf.readUInt32BE(off); }

function calcChecksum(buf) {
  // OpenType table checksum: sum of uint32 values (pad to 4 bytes)
  const padded = Buffer.alloc(Math.ceil(buf.length / 4) * 4);
  buf.copy(padded);
  let sum = 0;
  for (let i = 0; i < padded.length; i += 4) {
    sum = (sum + padded.readUInt32BE(i)) >>> 0;
  }
  return sum;
}

function pad4(n) { return (n + 3) & ~3; }

/**
 * Patch a TTF buffer's nameID 1 and 16 (font family) to a target name.
 * Returns a new Buffer with the patched font.
 * @param {Buffer} ttf
 * @param {string} targetFamily  e.g. "Darker Grotesque"
 * @returns {Buffer}
 */
function patchFontFamily(ttf, targetFamily) {
  // Guard: only handle plain TTF files (sfVersion 0x00010000 or 'OTTO' for CFF)
  const sfVersion = u32(ttf, 0);
  if (sfVersion !== 0x00010000 && sfVersion !== 0x4F54544F) {
    const tag = ttf.toString('ascii', 0, 4);
    process.stderr.write(
      `[openfig] Cannot patch font nameID: unsupported format "${tag}" ` +
      `(expected TTF or OTF). Font will be registered unpatched — ` +
      `resvg may not match it by family name.\n`
    );
    return ttf;
  }

  const numTables = u16(ttf, 4);

  // Read table directory
  const tables = [];
  for (let i = 0; i < numTables; i++) {
    const off = 12 + i * 16;
    tables.push({
      tag: ttf.toString('ascii', off, off + 4),
      checksum: u32(ttf, off + 4),
      offset: u32(ttf, off + 8),
      length: u32(ttf, off + 12),
    });
  }

  // Extract table data, replacing 'name' table
  const tableBuffers = new Map();
  for (const t of tables) {
    if (t.tag === 'name') {
      tableBuffers.set(t.tag, buildPatchedNameTable(ttf, t.offset, t.length, targetFamily));
    } else {
      tableBuffers.set(t.tag, ttf.subarray(t.offset, t.offset + t.length));
    }
  }

  // Rebuild TTF: offset table + table directory + table data
  const headerSize = 12 + numTables * 16;
  let dataOffset = pad4(headerSize);

  // Calculate offsets for each table
  const offsets = new Map();
  for (const t of tables) {
    offsets.set(t.tag, dataOffset);
    dataOffset += pad4(tableBuffers.get(t.tag).length);
  }

  const out = Buffer.alloc(dataOffset);

  // Write offset table (copy first 12 bytes: sfVersion, numTables, searchRange, etc.)
  ttf.copy(out, 0, 0, 12);

  // Write table directory
  for (let i = 0; i < tables.length; i++) {
    const off = 12 + i * 16;
    const t = tables[i];
    const data = tableBuffers.get(t.tag);
    const cs = calcChecksum(data);
    out.write(t.tag, off, 4, 'ascii');
    out.writeUInt32BE(cs, off + 4);
    out.writeUInt32BE(offsets.get(t.tag), off + 8);
    out.writeUInt32BE(data.length, off + 12);
  }

  // Write table data
  for (const t of tables) {
    tableBuffers.get(t.tag).copy(out, offsets.get(t.tag));
  }

  // Fix head.checksumAdjustment (offset 8 within 'head' table)
  const headEntry = tables.find(t => t.tag === 'head');
  if (headEntry) {
    const headOff = offsets.get('head');
    // Zero out checksumAdjustment, compute whole-file checksum, then set adjustment
    out.writeUInt32BE(0, headOff + 8);
    const fileChecksum = calcChecksum(out);
    out.writeUInt32BE((0xB1B0AFBA - fileChecksum) >>> 0, headOff + 8);
  }

  return out;
}

/**
 * Build a new 'name' table buffer with nameID 1 and 16 replaced.
 */
function buildPatchedNameTable(ttf, tableOff, tableLen, targetFamily) {
  const format = u16(ttf, tableOff);
  if (format !== 0) {
    // Format 1 has extra language tag records — we don't handle that.
    // Return the original table unmodified with a warning.
    process.stderr.write(
      `[openfig] Name table format ${format} not supported for patching ` +
      `(expected format 0). Font will keep its original nameID.\n`
    );
    return Buffer.from(ttf.subarray(tableOff, tableOff + tableLen));
  }

  const count = u16(ttf, tableOff + 2);
  const stringOff = u16(ttf, tableOff + 4);
  const stringBase = tableOff + stringOff;

  // Read all name records
  const records = [];
  for (let i = 0; i < count; i++) {
    const r = tableOff + 6 + i * 12;
    records.push({
      platformID: u16(ttf, r),
      encodingID: u16(ttf, r + 2),
      languageID: u16(ttf, r + 4),
      nameID: u16(ttf, r + 6),
      length: u16(ttf, r + 8),
      offset: u16(ttf, r + 10),
    });
  }

  // Build new string data
  const strings = [];
  let totalLen = 0;
  for (const rec of records) {
    let strBuf;
    if (rec.nameID === 1 || rec.nameID === 16) {
      if (rec.platformID === 3 || rec.platformID === 0) {
        // Windows/Unicode: UTF-16BE
        strBuf = Buffer.alloc(targetFamily.length * 2);
        for (let j = 0; j < targetFamily.length; j++) {
          strBuf.writeUInt16BE(targetFamily.charCodeAt(j), j * 2);
        }
      } else {
        // Mac: ASCII/Latin-1
        strBuf = Buffer.from(targetFamily, 'latin1');
      }
    } else {
      strBuf = Buffer.from(ttf.subarray(stringBase + rec.offset, stringBase + rec.offset + rec.length));
    }
    rec._newLen = strBuf.length;
    rec._newOff = totalLen;
    strings.push(strBuf);
    totalLen += strBuf.length;
  }

  // Assemble new name table
  const headerLen = 6 + records.length * 12;
  const newTable = Buffer.alloc(headerLen + totalLen);
  newTable.writeUInt16BE(0, 0);            // format
  newTable.writeUInt16BE(count, 2);        // count
  newTable.writeUInt16BE(headerLen, 4);    // stringOffset

  for (let i = 0; i < records.length; i++) {
    const off = 6 + i * 12;
    const rec = records[i];
    newTable.writeUInt16BE(rec.platformID, off);
    newTable.writeUInt16BE(rec.encodingID, off + 2);
    newTable.writeUInt16BE(rec.languageID, off + 4);
    newTable.writeUInt16BE(rec.nameID, off + 6);
    newTable.writeUInt16BE(rec._newLen, off + 8);
    newTable.writeUInt16BE(rec._newOff, off + 10);
  }

  for (let i = 0; i < strings.length; i++) {
    strings[i].copy(newTable, headerLen + records[i]._newOff);
  }

  return newTable;
}

// ── Cache helpers ────────────────────────────────────────────────────────────

/**
 * Cache key for a font: family-weight-normal.ttf
 */
function cacheKey(family, weight) {
  const slug = family.toLowerCase().replace(/\s+/g, '-');
  return `${slug}-${weight}-normal.ttf`;
}

/**
 * Check if a font weight is already cached.
 */
function isCached(family, weight) {
  return existsSync(join(CACHE_DIR, cacheKey(family, weight)));
}

/**
 * Read a cached font.
 */
function readCached(family, weight) {
  return readFileSync(join(CACHE_DIR, cacheKey(family, weight)));
}

/**
 * Write a font to cache.
 */
function writeCache(family, weight, buffer) {
  ensureCacheDir();
  writeFileSync(join(CACHE_DIR, cacheKey(family, weight)), Buffer.from(buffer));
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Scan a deck for font families, download missing ones from Google Fonts,
 * patch nameID 1 for resvg matching, cache locally, and register.
 *
 * @param {import('../fig-deck.mjs').FigDeck} deck
 * @param {object} [opts]
 * @param {boolean} [opts.quiet=false]  Suppress warnings
 * @returns {Promise<{resolved: string[], failed: string[]}>}
 */
export async function resolveFonts(deck, opts = {}) {
  const deckFonts = scanDeckFonts(deck);
  const resolved = [];
  const failed = [];

  for (const [family, weights] of deckFonts) {
    // Skip built-in fonts
    if (BUILTIN_FAMILIES.has(family.toLowerCase())) continue;

    const weightsArr = [...weights].sort((a, b) => a - b);
    const missing = weightsArr.filter(w => !isCached(family, w));

    // If all weights are cached, just register them
    if (missing.length === 0) {
      for (const w of weightsArr) {
        registerFont(readCached(family, w));
      }
      resolved.push(family);
      continue;
    }

    // Try Google Fonts first, then system fonts, then give up
    let googleOk = false;
    try {
      const urls = await fetchGoogleFontUrls(family, missing);
      if (urls.size > 0) {
        for (const w of missing) {
          const url = urls.get(w);
          if (!url) continue;
          const ttfBuf = await downloadFont(url);
          const patched = patchFontFamily(ttfBuf, family);
          writeCache(family, w, patched);
        }
        googleOk = true;
      }
    } catch (err) {
      if (!opts.quiet) {
        process.stderr.write(
          `[openfig] Google Fonts download failed for "${family}": ${err.message}\n`
        );
      }
    }

    // Check what's still missing after Google Fonts
    const stillMissing = weightsArr.filter(w => !isCached(family, w));

    // Fallback: search system font directories for remaining weights
    if (stillMissing.length > 0) {
      const systemFonts = findSystemFonts(family, stillMissing);
      const registeredPaths = new Set(); // avoid registering same TTC twice
      for (const [w, path] of systemFonts) {
        if (/\.ttc$/i.test(path)) {
          // TTC (TrueType Collection): register raw file — resvg parses all
          // fonts inside and matches by internal nameID. No patching needed
          // since system fonts already have correct family names.
          if (!registeredPaths.has(path)) {
            registerFont(readFileSync(path));
            registeredPaths.add(path);
          }
          // Mark as resolved in cache via empty sentinel
          writeCache(family, w, Buffer.from('TTC:' + path));
        } else {
          const ttfBuf = readFileSync(path);
          const patched = patchFontFamily(ttfBuf, family);
          writeCache(family, w, patched);
        }
        if (!opts.quiet) {
          process.stderr.write(`[openfig] Loaded "${family}" weight ${w} from system: ${path}\n`);
        }
      }
    }

    // Register all cached weights
    const finalMissing = [];
    const registeredTtcPaths = new Set();
    for (const w of weightsArr) {
      if (isCached(family, w)) {
        const cached = readCached(family, w);
        // TTC sentinel: "TTC:/path/to/Font.ttc" — re-read and register system file
        if (cached.length < 512 && cached.toString().startsWith('TTC:')) {
          const ttcPath = cached.toString().slice(4);
          if (!registeredTtcPaths.has(ttcPath) && existsSync(ttcPath)) {
            registerFont(readFileSync(ttcPath));
            registeredTtcPaths.add(ttcPath);
          }
        } else {
          registerFont(cached);
        }
      } else {
        finalMissing.push(w);
      }
    }

    if (finalMissing.length === 0) {
      resolved.push(family);
    } else {
      if (!opts.quiet) {
        process.stderr.write(
          `[openfig] Font "${family}" missing weights [${finalMissing.join(', ')}] — ` +
          `not on Google Fonts, not found in system fonts. ` +
          `Text will render in Inter as fallback. ` +
          `Use registerFont() to supply this font manually.\n`
        );
      }
      // Partial success: some weights resolved
      if (finalMissing.length < weightsArr.length) {
        resolved.push(family);
      } else {
        failed.push(family);
      }
    }
  }

  return { resolved, failed };
}
