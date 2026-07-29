/**
 * Structural checks on a deck before it is written.
 *
 * Every check here exists because a deck failed to open in Figma while every
 * other signal said it was fine: the ZIP was intact, `canvas.fig` parsed, chunk
 * compression was right, GUIDs were unique, nothing dangled, and the file
 * round-tripped through our own reader unchanged. Figma reports one line —
 * "Internal error during import" — and names nothing, so a defect that reaches
 * a user costs an evening of bisecting decks to find.
 *
 * The point is to fail loudly at conversion time instead. These are invariants
 * about the *output*, not assertions about our own data structures, which is
 * what makes them catch things a unit test cannot: the bug that prompted this
 * file sat behind 241 passing tests.
 *
 * Portable: no Node builtins, so both hosts can run it.
 */
import { isValidPosition } from './node-helpers.mjs';

/** @typedef {{ level: 'error'|'warning', code: string, message: string }} Finding */

const guidKey = (g) => (g ? `${g.sessionID}:${g.localID}` : null);

/**
 * @param {object} message - the decoded `canvas.fig` message
 * @param {object} [opts]
 * @param {Set<string>|string[]} [opts.imageHashes] - hashes present in the archive
 * @returns {Finding[]} errors first, then warnings
 */
export function validateDeck(message, opts = {}) {
  /** @type {Finding[]} */
  const findings = [];
  const nodes = message?.nodeChanges ?? [];
  const add = (level, code, m) => findings.push({ level, code, message: m });

  // --- sibling ordering ---------------------------------------------------
  // `parentIndex.position` is compared as a string and must stay inside the
  // alphabet Figma accepts. Out-of-range characters reject the entire file.
  const badPositions = new Map(); // parent -> count
  let firstBad = null;
  for (const c of nodes) {
    const p = c.parentIndex?.position;
    if (p === undefined) continue;
    if (isValidPosition(p)) continue;
    const parent = guidKey(c.parentIndex?.guid) ?? '(none)';
    badPositions.set(parent, (badPositions.get(parent) ?? 0) + 1);
    if (!firstBad) {
      const cps = [...p].map((ch) => 'U+' + ch.codePointAt(0).toString(16).toUpperCase().padStart(4, '0'));
      firstBad = `${c.type} under ${parent} has position ${JSON.stringify(p)} (${cps.join(' ')})`;
    }
  }
  if (badPositions.size) {
    const total = [...badPositions.values()].reduce((a, b) => a + b, 0);
    add('error', 'position-out-of-range',
      `${total} node${total === 1 ? '' : 's'} across ${badPositions.size} parent${badPositions.size === 1 ? '' : 's'} ` +
      `carry a parentIndex.position outside the accepted alphabet. Figma refuses the whole file. ` +
      `First: ${firstBad}`);
  }

  // Two siblings sharing a position have no defined order between them.
  const byParent = new Map();
  for (const c of nodes) {
    const parent = guidKey(c.parentIndex?.guid);
    if (!parent) continue;
    if (!byParent.has(parent)) byParent.set(parent, new Map());
    const seen = byParent.get(parent);
    const p = c.parentIndex.position;
    seen.set(p, (seen.get(p) ?? 0) + 1);
  }
  let dupPositions = 0;
  for (const seen of byParent.values()) {
    for (const n of seen.values()) if (n > 1) dupPositions += n - 1;
  }
  if (dupPositions) {
    add('warning', 'position-duplicate',
      `${dupPositions} sibling${dupPositions === 1 ? '' : 's'} share a position with another, so their order is undefined.`);
  }

  // --- references ---------------------------------------------------------
  const present = new Set();
  const dupGuids = [];
  for (const c of nodes) {
    const k = guidKey(c.guid);
    if (!k) continue;
    if (present.has(k)) dupGuids.push(k);
    present.add(k);
  }
  if (dupGuids.length) {
    add('error', 'duplicate-guid',
      `${dupGuids.length} node${dupGuids.length === 1 ? '' : 's'} reuse a guid (first: ${dupGuids[0]}).`);
  }

  const dangling = new Set();
  for (const c of nodes) {
    const p = guidKey(c.parentIndex?.guid);
    if (p && !present.has(p)) dangling.add(p);
  }
  if (dangling.size) {
    add('error', 'dangling-parent',
      `${dangling.size} parent reference${dangling.size === 1 ? '' : 's'} point at nodes that are not in the file ` +
      `(first: ${[...dangling][0]}).`);
  }

  // Blobs are referenced by index from any field whose name ends in "Blob".
  const blobCount = (message?.blobs ?? []).length;
  const badBlobRefs = [];
  const walkBlobs = (o) => {
    if (!o || typeof o !== 'object') return;
    for (const [k, v] of Object.entries(o)) {
      if (/Blob$/.test(k) && typeof v === 'number') {
        if (!Number.isInteger(v) || v < 0 || v >= blobCount) badBlobRefs.push(`${k}=${v}`);
      } else if (v && typeof v === 'object') walkBlobs(v);
    }
  };
  for (const c of nodes) walkBlobs(c);
  if (badBlobRefs.length) {
    add('error', 'blob-out-of-range',
      `${badBlobRefs.length} blob reference${badBlobRefs.length === 1 ? '' : 's'} fall outside the ${blobCount} blobs ` +
      `in the file (first: ${badBlobRefs[0]}).`);
  }

  // --- geometry -----------------------------------------------------------
  let nonFinite = 0;
  for (const c of nodes) {
    const t = c.transform;
    if (t && ['m00', 'm01', 'm02', 'm10', 'm11', 'm12'].some((k) => !Number.isFinite(t[k]))) nonFinite++;
    else if (c.size && (!Number.isFinite(c.size.x) || !Number.isFinite(c.size.y))) nonFinite++;
  }
  if (nonFinite) {
    add('error', 'non-finite-geometry',
      `${nonFinite} node${nonFinite === 1 ? '' : 's'} carry a NaN or Infinity in a transform or size.`);
  }

  // --- fonts --------------------------------------------------------------
  // An empty PostScript name makes Figma substitute a fallback even when the
  // family is present, which is a silent wrong-font rather than a visible error.
  let emptyPostscript = 0;
  const checkFont = (f) => {
    if (!f) return;
    if (!f.postscript) emptyPostscript++;
  };
  for (const c of nodes) {
    checkFont(c.fontName);
    for (const o of c.textData?.styleOverrideTable ?? []) checkFont(o.fontName);
  }
  if (emptyPostscript) {
    add('warning', 'font-no-postscript',
      `${emptyPostscript} font reference${emptyPostscript === 1 ? '' : 's'} have no PostScript name, so Figma may ` +
      'substitute a fallback even where the family is available.');
  }

  // --- images -------------------------------------------------------------
  if (opts.imageHashes) {
    const have = opts.imageHashes instanceof Set ? opts.imageHashes : new Set(opts.imageHashes);
    const missing = new Set();
    const visit = (paints) => {
      for (const p of paints ?? []) {
        const h = p?.image?.hash;
        if (!h) continue;
        const hex = [...h].map((b) => b.toString(16).padStart(2, '0')).join('');
        if (!have.has(hex)) missing.add(hex);
      }
    };
    for (const c of nodes) {
      visit(c.fillPaints);
      visit(c.strokePaints);
      for (const o of c.textData?.styleOverrideTable ?? []) visit(o.fillPaints);
    }
    if (missing.size) {
      add('error', 'image-missing',
        `${missing.size} image${missing.size === 1 ? '' : 's'} referenced by a paint are not in the archive ` +
        `(first: ${[...missing][0]}).`);
    }
  }

  return findings.sort((a, b) => (a.level === b.level ? 0 : a.level === 'error' ? -1 : 1));
}

/** Convenience: the error-level findings only. */
export function deckErrors(message, opts) {
  return validateDeck(message, opts).filter((f) => f.level === 'error');
}
