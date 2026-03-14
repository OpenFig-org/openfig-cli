/**
 * inspect — Show document structure (node hierarchy tree).
 *
 * Usage: node cli.mjs inspect <file.deck|file.fig> [--depth N] [--type TYPE] [--json]
 */
import { FigDeck } from '../lib/core/fig-deck.mjs';
import { nid } from '../lib/core/node-helpers.mjs';

export async function run(args, flags) {
  const file = args[0];
  if (!file) { console.error('Usage: inspect <file.deck|file.fig>'); process.exit(1); }

  const maxDepth = flags.depth ? parseInt(flags.depth) : Infinity;
  const filterType = flags.type || null;
  const jsonOut = flags.json != null;

  const deck = file.endsWith('.fig')
    ? FigDeck.fromFigFile(file)
    : await FigDeck.fromDeckFile(file);

  // Find root nodes (no parentIndex or parent not in nodeMap)
  const roots = deck.message.nodeChanges.filter(n => {
    if (!n.parentIndex?.guid) return true;
    const pid = `${n.parentIndex.guid.sessionID}:${n.parentIndex.guid.localID}`;
    return !deck.nodeMap.has(pid);
  });

  if (jsonOut) {
    const collect = [];
    for (const root of roots) {
      collectJson(deck, nid(root), 0, maxDepth, filterType, collect);
    }
    console.log(JSON.stringify(collect, null, 2));
    return;
  }

  // Summary
  const slides = deck.getSlides();
  const active = deck.getActiveSlides();
  console.log(`Nodes: ${deck.message.nodeChanges.length}  Slides: ${active.length} active / ${slides.length} total  Blobs: ${deck.message.blobs?.length || 0}`);
  if (deck.deckMeta) console.log(`Deck name: ${deck.deckMeta.file_name || '(unknown)'}`);
  console.log('');

  for (const root of roots) {
    printTree(deck, nid(root), 0, maxDepth, filterType);
  }
}

function printTree(deck, id, depth, maxDepth, filterType) {
  if (depth > maxDepth) return;
  const node = deck.getNode(id);
  if (!node) return;

  const type = node.type || '?';
  const show = !filterType || type === filterType;

  if (show) {
    const indent = '  '.repeat(depth);
    const name = node.name ? `"${node.name}"` : '';
    const removed = node.phase === 'REMOVED' ? ' [REMOVED]' : '';
    const sym = node.symbolData?.symbolID
      ? ` sym=${node.symbolData.symbolID.sessionID}:${node.symbolData.symbolID.localID}`
      : '';
    const ovCount = node.symbolData?.symbolOverrides?.length;
    const ovs = ovCount ? ` overrides=${ovCount}` : '';
    console.log(`${indent}${type} ${name} (${id})${removed}${sym}${ovs}`);
  }

  for (const child of deck.getChildren(id)) {
    printTree(deck, nid(child), depth + 1, maxDepth, filterType);
  }
}

function collectJson(deck, id, depth, maxDepth, filterType, out) {
  if (depth > maxDepth) return;
  const node = deck.getNode(id);
  if (!node) return;
  const type = node.type || '?';
  if (!filterType || type === filterType) {
    out.push({
      id, type, name: node.name || null,
      phase: node.phase || null,
      symbolID: node.symbolData?.symbolID ? nid({ guid: node.symbolData.symbolID }) : null,
      overrides: node.symbolData?.symbolOverrides?.length || 0,
      depth,
    });
  }
  for (const child of deck.getChildren(id)) {
    collectJson(deck, nid(child), depth + 1, maxDepth, filterType, out);
  }
}
