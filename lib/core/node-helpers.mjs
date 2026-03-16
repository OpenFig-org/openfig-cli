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

/** Position character for sibling ordering in parentIndex. */
export function positionChar(index) {
  return String.fromCharCode(0x21 + index); // '!' = 0, '"' = 1, etc.
}
