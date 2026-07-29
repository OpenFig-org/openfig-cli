/**
 * Node ID formatting, tree walking, override builders.
 */

/** Format a node's guid as "sessionID:localID" */
import { nodeId as nid } from 'openfig-core';
export { nid };

/** Parse "57:48" → { sessionID: 57, localID: 48 } */
export function parseId(str) {
  const [s, l] = str.split(':').map(Number);
  return { sessionID: s, localID: l };
}

/** Shorthand for { sessionID, localID } */
export function makeGuid(sessionID, localID) {
  return { sessionID, localID };
}

/**
 * Build a text override for symbolOverrides.
 * Empty string is replaced with ' ' (space) — empty crashes Figma.
 */
export function ov(key, text) {
  const chars = (text === '' || text == null) ? ' ' : text;
  return { guidPath: { guids: [key] }, textData: { characters: chars } };
}

/**
 * Build a nested text override (e.g., quote inside paraGrid).
 * guidPath has 2 guids: [instanceKey, textKey].
 */
export function nestedOv(instKey, textKey, text) {
  const chars = (text === '' || text == null) ? ' ' : text;
  return { guidPath: { guids: [instKey, textKey] }, textData: { characters: chars } };
}

/** Mark a node as REMOVED (never delete from nodeChanges array). */
export function removeNode(node) {
  node.phase = 'REMOVED';
  delete node.prototypeInteractions;
}

// Sibling order lives in `parentIndex.position`, a fractional index that Figma
// compares as a string. The alphabet is printable ASCII, `!` (0x21) through
// `}` (0x7D), with `~` (0x7E) held back — see below.
const POSITION_FIRST = 0x21;
const POSITION_LAST = 0x7D;
const POSITION_BASE = POSITION_LAST - POSITION_FIRST + 1; // 93
const POSITION_MORE = String.fromCharCode(POSITION_LAST + 1); // '~'

/**
 * Position string for sibling ordering in `parentIndex`.
 *
 * This was `String.fromCharCode(0x21 + index)` with no upper bound, so index 94
 * walked straight out of printable ASCII and produced characters like `Ř` and
 * `Ɖ`. Figma rejects a file containing them outright — not the node, the whole
 * import — so **any node with more than 94 children yielded an unopenable
 * deck**. That is reached easily: every SVG `<path>` becomes a node, so one
 * icon of 234 paths contributes 234 children to a slide.
 *
 * Positions are compared as strings, which rules out the obvious repairs. A
 * naive overflow into a second character reorders siblings, because `"!"` sorts
 * before `"!!"` sorts before `'"'` — the overflowed node lands between the
 * first and second, not after them. A uniform fixed width avoids that but
 * rewrites every position we have ever emitted.
 *
 * So `~`, the last character of the alphabet, is reserved as a continuation
 * marker and never used as a value. Every ordinary position is `}` or lower, so
 * any string starting with `~` sorts after all of them, and the same holds
 * recursively. Indices below 93 keep exactly the values they had.
 */
export function positionChar(index) {
  if (!Number.isInteger(index) || index < 0) {
    throw new Error(`positionChar: index must be a non-negative integer, got ${index}`);
  }
  let out = '';
  let n = index;
  while (n >= POSITION_BASE) {
    out += POSITION_MORE;
    n -= POSITION_BASE;
  }
  return out + String.fromCharCode(POSITION_FIRST + n);
}

/**
 * True if `position` uses only characters Figma accepts.
 *
 * The constraint is the printable-ASCII range and nothing more. `~` is held
 * back by the generator above as a continuation marker, but it is a perfectly
 * valid position on its own — decks that import successfully carry a bare `~`
 * on the canvas — so validating against the generator's convention rather than
 * the format's would reject working files.
 */
export function isValidPosition(position) {
  if (typeof position !== 'string' || position === '') return false;
  for (const ch of position) {
    const cp = ch.codePointAt(0);
    if (cp < POSITION_FIRST || cp > POSITION_LAST + 1) return false;
  }
  return true;
}
