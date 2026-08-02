/**
 * Portable ZIP layer for .deck/.fig archives.
 *
 * Bytes in, bytes out — this module never learns what a path is. It has no
 * `node:*` imports and no `Buffer`, so it runs unchanged in a browser. The
 * filesystem side (reading the archive off disk, materialising `images/` into
 * a temp dir) lives in the Node wrappers on `FigDeck`.
 *
 * Replaces the two Node-only pieces of the old codec: `execSync unzip` on the
 * read path and `yazl` on the write path.
 */
import { unzipSync, zipSync } from 'fflate';

/**
 * Unpack a ZIP archive.
 *
 * Directory entries (a key ending in "/") are dropped — a reference deck
 * carries an explicit zero-length `images/` entry, which would otherwise
 * surface as a bogus zero-byte asset.
 *
 * The caller's view is passed straight through to fflate, which indexes and
 * `subarray`s it, so a pooled Buffer at a non-zero byteOffset is read
 * correctly. Every returned value is a fresh zero-offset array.
 *
 * @param {Uint8Array} bytes - Archive bytes
 * @returns {Map<string, Uint8Array>} entry path (forward slashes) → contents
 */
export function unpackArchive(bytes) {
  let raw;
  try {
    raw = unzipSync(bytes);
  } catch (err) {
    throw new Error(`Not a valid archive: ${err.message}`);
  }
  const entries = new Map();
  for (const name of Object.keys(raw)) {
    if (name.endsWith('/')) continue;
    entries.set(name, raw[name]);
  }
  return entries;
}

/**
 * Pack entries into a ZIP.
 *
 * Iteration order of `entries` becomes the entry order in the output, so the
 * caller controls it (canvas.fig, thumbnail.png, meta.json, images/*) — with
 * one caveat: `fflate.zipSync` takes an object, and JS property order puts
 * integer-like keys first, so entries named "1", "2" and so on would be
 * hoisted. No deck entry name is integer-like (canvas.fig, thumbnail.png,
 * meta.json, 40-hex image names), so this does not arise in practice; naming
 * an entry after a bare integer would need fflate's streaming Zip API.
 *
 * @param {Map<string, Uint8Array>|Iterable<[string, Uint8Array]>} entries
 * @param {object} [opts]
 * @param {number} [opts.level] - Deflate level 0–9, default 6 (matches yazl's)
 * @param {Date|number} [opts.mtime] - Entry timestamp, default now
 * @returns {Uint8Array} Archive bytes
 */
export function packArchive(entries, opts = {}) {
  const files = {};
  for (const [name, data] of entries) files[name] = data;
  const zipOpts = { level: opts.level ?? 6 };
  if (opts.mtime !== undefined) zipOpts.mtime = opts.mtime;
  return zipSync(files, zipOpts);
}

/**
 * True if `bytes` starts with the "PK" ZIP magic. Deliberately the two-byte
 * check, not the four-byte local-file signature: a `.fig` binary starts with
 * an ASCII prelude, so two bytes already separate the two formats.
 *
 * @param {Uint8Array} bytes
 * @returns {boolean}
 */
export function looksLikeZip(bytes) {
  return bytes.length >= 2 && bytes[0] === 0x50 && bytes[1] === 0x4b;
}
