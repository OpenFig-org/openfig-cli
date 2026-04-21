/**
 * Tests for FigDeck.importSymbols() — cross-deck symbol import API.
 *
 * Strategy: construct two zero-seed decks via FigDeck.createEmpty(), inject
 * synthetic SYMBOL nodes (with children, nested INSTANCEs, overrideKeys) into
 * the "source" deck, then call importSymbols() on the "target" deck and verify
 * the results. No bundled fixture is required.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { FigDeck } from '../../lib/core/fig-deck.mjs';
import { nid } from '../../lib/core/node-helpers.mjs';
import { deepClone } from '../../lib/core/deep-clone.mjs';

/**
 * Inject a synthetic SYMBOL with children into a FigDeck for testing.
 * Returns the symbol ID.
 */
function injectTestSymbol(fd, opts = {}) {
  const internalCanvas = fd.message.nodeChanges.find(
    n => n.type === 'CANVAS' && n.name === 'Internal Only Canvas'
  );
  if (!internalCanvas) throw new Error('No Internal Only Canvas');

  let nextId = fd.maxLocalID() + 1;
  const sessionID = opts.sessionID ?? 99;

  // Create SYMBOL root
  const symbolGuid = { sessionID, localID: nextId++ };
  const symbol = {
    guid: symbolGuid,
    phase: 'CREATED',
    type: 'SYMBOL',
    name: opts.name ?? 'TestSymbol',
    componentKey: opts.componentKey ?? `test-key-${symbolGuid.localID}`,
    visible: true,
    opacity: 1,
    size: { x: 200, y: 100 },
    transform: { m00: 1, m01: 0, m02: 0, m10: 0, m11: 1, m12: 0 },
    parentIndex: {
      guid: deepClone(internalCanvas.guid),
      position: '!',
    },
  };

  // Create a TEXT child with overrideKey
  const textGuid = { sessionID, localID: nextId++ };
  const textNode = {
    guid: textGuid,
    phase: 'CREATED',
    type: 'TEXT',
    name: 'Label',
    visible: true,
    opacity: 1,
    size: { x: 180, y: 40 },
    transform: { m00: 1, m01: 0, m02: 10, m10: 0, m11: 1, m12: 10 },
    overrideKey: deepClone(textGuid),
    parentIndex: {
      guid: deepClone(symbolGuid),
      position: '!',
    },
  };

  // Create a FRAME child
  const frameGuid = { sessionID, localID: nextId++ };
  const frameNode = {
    guid: frameGuid,
    phase: 'CREATED',
    type: 'FRAME',
    name: 'Container',
    visible: true,
    opacity: 1,
    size: { x: 180, y: 50 },
    transform: { m00: 1, m01: 0, m02: 10, m10: 0, m11: 1, m12: 50 },
    parentIndex: {
      guid: deepClone(symbolGuid),
      position: '"',
    },
  };

  // Create a nested RECTANGLE inside the FRAME
  const rectGuid = { sessionID, localID: nextId++ };
  const rectNode = {
    guid: rectGuid,
    phase: 'CREATED',
    type: 'ROUNDED_RECTANGLE',
    name: 'Background',
    visible: true,
    opacity: 1,
    size: { x: 160, y: 40 },
    transform: { m00: 1, m01: 0, m02: 5, m10: 0, m11: 1, m12: 5 },
    overrideKey: deepClone(rectGuid),
    parentIndex: {
      guid: deepClone(frameGuid),
      position: '!',
    },
    fillPaints: [{
      type: 'SOLID',
      color: { r: 0.5, g: 0.5, b: 0.5, a: 1 },
      opacity: 1,
      visible: true,
      blendMode: 'NORMAL',
    }],
  };

  fd.message.nodeChanges.push(symbol, textNode, frameNode, rectNode);
  fd.rebuildMaps();

  return {
    symbolId: nid(symbol),
    textId: nid(textNode),
    frameId: nid(frameNode),
    rectId: nid(rectNode),
    componentKey: symbol.componentKey,
  };
}

/**
 * Inject a second SYMBOL with a nested INSTANCE referencing the first symbol.
 */
function injectSymbolWithInstance(fd, referencedSymbolId, opts = {}) {
  const internalCanvas = fd.message.nodeChanges.find(
    n => n.type === 'CANVAS' && n.name === 'Internal Only Canvas'
  );

  let nextId = fd.maxLocalID() + 1;
  const sessionID = opts.sessionID ?? 99;

  const [refS, refL] = referencedSymbolId.split(':').map(Number);

  // SYMBOL root
  const symbolGuid = { sessionID, localID: nextId++ };
  const symbol = {
    guid: symbolGuid,
    phase: 'CREATED',
    type: 'SYMBOL',
    name: opts.name ?? 'WrapperSymbol',
    componentKey: opts.componentKey ?? `wrapper-key-${symbolGuid.localID}`,
    visible: true,
    opacity: 1,
    size: { x: 400, y: 200 },
    transform: { m00: 1, m01: 0, m02: 0, m10: 0, m11: 1, m12: 0 },
    parentIndex: {
      guid: deepClone(internalCanvas.guid),
      position: '"',
    },
  };

  // Nested INSTANCE referencing the first symbol
  const instanceGuid = { sessionID, localID: nextId++ };
  const instance = {
    guid: instanceGuid,
    phase: 'CREATED',
    type: 'INSTANCE',
    name: 'NestedInstance',
    visible: true,
    opacity: 1,
    size: { x: 200, y: 100 },
    transform: { m00: 1, m01: 0, m02: 50, m10: 0, m11: 1, m12: 50 },
    overrideKey: deepClone(instanceGuid),
    symbolData: {
      symbolID: { sessionID: refS, localID: refL },
    },
    parentIndex: {
      guid: deepClone(symbolGuid),
      position: '!',
    },
  };

  fd.message.nodeChanges.push(symbol, instance);
  fd.rebuildMaps();

  return {
    symbolId: nid(symbol),
    instanceId: nid(instance),
    componentKey: symbol.componentKey,
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('FigDeck.importSymbols()', () => {
  let sourceDeck, targetDeck;
  let sym1, sym2;

  beforeAll(async () => {
    sourceDeck = FigDeck.createEmpty({ name: 'source' });
    targetDeck = FigDeck.createEmpty({ name: 'target' });

    // Inject test symbols into source deck
    sym1 = injectTestSymbol(sourceDeck, { name: 'IconButton', componentKey: 'ck-icon-button' });
    sym2 = injectSymbolWithInstance(sourceDeck, sym1.symbolId, {
      name: 'CardWithIcon',
      componentKey: 'ck-card-with-icon',
    });
  });

  it('imports a single symbol with its full subtree', () => {
    const idMap = targetDeck.importSymbols(sourceDeck, [sym1.symbolId]);

    expect(idMap.size).toBe(4); // symbol + text + frame + rect
    expect(idMap.has(sym1.symbolId)).toBe(true);
    expect(idMap.has(sym1.textId)).toBe(true);
    expect(idMap.has(sym1.frameId)).toBe(true);
    expect(idMap.has(sym1.rectId)).toBe(true);

    // Verify new IDs are different from old IDs
    const newSymId = idMap.get(sym1.symbolId);
    expect(newSymId).not.toBe(sym1.symbolId);

    // Verify the node exists in the target deck
    const newSym = targetDeck.getNode(newSymId);
    expect(newSym).toBeTruthy();
    expect(newSym.type).toBe('SYMBOL');
    expect(newSym.name).toBe('IconButton');
    expect(newSym.componentKey).toBe('ck-icon-button');
  });

  it('parents imported symbols under Internal Only Canvas', () => {
    const newSymId = targetDeck.importSymbols(sourceDeck, [sym1.symbolId]).get(sym1.symbolId);
    // Dedup will return the already-imported one; check its parent
    const existingSym = targetDeck.getNode(newSymId);
    // It was imported in the previous test; parent should be Internal Only Canvas
    const parentId = `${existingSym.parentIndex.guid.sessionID}:${existingSym.parentIndex.guid.localID}`;
    const parent = targetDeck.getNode(parentId);
    expect(parent).toBeTruthy();
    expect(parent.type).toBe('CANVAS');
    expect(parent.name).toBe('Internal Only Canvas');
  });

  it('remaps parentIndex.guid references within the subtree', () => {
    // Get the first import's mapping
    const symbols = targetDeck.getSymbols().filter(s => s.name === 'IconButton');
    expect(symbols.length).toBeGreaterThanOrEqual(1);
    const importedSym = symbols[0];
    const symId = nid(importedSym);

    // Check that children have correct parent references
    const children = targetDeck.getChildren(symId);
    expect(children.length).toBe(2); // text + frame

    const frame = children.find(c => c.type === 'FRAME');
    expect(frame).toBeTruthy();

    // Frame's children should also have remapped parents
    const frameChildren = targetDeck.getChildren(nid(frame));
    expect(frameChildren.length).toBe(1);
    expect(frameChildren[0].type).toBe('ROUNDED_RECTANGLE');
  });

  it('remaps overrideKey references', () => {
    const symbols = targetDeck.getSymbols().filter(s => s.name === 'IconButton');
    const importedSym = symbols[0];
    const symId = nid(importedSym);

    // Walk the subtree and find nodes with overrideKey
    const nodesWithOverrideKey = [];
    targetDeck.walkTree(symId, node => {
      if (node.overrideKey) nodesWithOverrideKey.push(node);
    });

    expect(nodesWithOverrideKey.length).toBe(2); // text + rect

    // Each overrideKey should use sessionID=1 (remapped)
    for (const node of nodesWithOverrideKey) {
      expect(node.overrideKey.sessionID).toBe(1);
      // overrideKey should match the node's own guid (common pattern)
      expect(node.overrideKey.localID).toBe(node.guid.localID);
    }
  });

  it('deduplicates by componentKey', () => {
    const beforeCount = targetDeck.getSymbols().filter(s => s.name === 'IconButton').length;

    // Import the same symbol again
    const idMap = targetDeck.importSymbols(sourceDeck, [sym1.symbolId]);

    const afterCount = targetDeck.getSymbols().filter(s => s.name === 'IconButton').length;
    expect(afterCount).toBe(beforeCount); // no new symbol created

    // idMap should still contain the mapping, pointing to the existing symbol
    expect(idMap.has(sym1.symbolId)).toBe(true);
  });

  it('imports a symbol with nested INSTANCE and remaps symbolData.symbolID', () => {
    // First ensure sym1 is imported (dedup), then import sym2
    const target2 = new FigDeck();
    // We need a fresh target; copy the approach
    // Actually let's just use the existing targetDeck which already has sym1
    const idMap = targetDeck.importSymbols(sourceDeck, [sym1.symbolId, sym2.symbolId]);

    // sym2 should have been imported
    expect(idMap.has(sym2.symbolId)).toBe(true);
    expect(idMap.has(sym2.instanceId)).toBe(true);

    const newWrapperSymId = idMap.get(sym2.symbolId);
    const wrapperSym = targetDeck.getNode(newWrapperSymId);
    expect(wrapperSym).toBeTruthy();
    expect(wrapperSym.type).toBe('SYMBOL');
    expect(wrapperSym.name).toBe('CardWithIcon');

    // Find the nested INSTANCE
    const wrapperChildren = targetDeck.getChildren(newWrapperSymId);
    const inst = wrapperChildren.find(c => c.type === 'INSTANCE');
    expect(inst).toBeTruthy();

    // The instance's symbolData.symbolID should point to the remapped sym1 ID
    const symRef = `${inst.symbolData.symbolID.sessionID}:${inst.symbolData.symbolID.localID}`;
    // It should NOT point to the old source deck ID
    expect(symRef).not.toBe(sym1.symbolId);
    // It should point to the already-imported IconButton symbol in the target
    const referencedSym = targetDeck.getNode(symRef);
    expect(referencedSym).toBeTruthy();
    expect(referencedSym.type).toBe('SYMBOL');
    expect(referencedSym.name).toBe('IconButton');
  });

  it('returns empty map for empty symbolIds array', () => {
    const idMap = targetDeck.importSymbols(sourceDeck, []);
    expect(idMap.size).toBe(0);
  });

  it('throws for non-existent symbol ID', () => {
    expect(() => {
      targetDeck.importSymbols(sourceDeck, ['999:999']);
    }).toThrow('SYMBOL not found in source deck: 999:999');
  });

  it('sets phase to CREATED on all cloned nodes', () => {
    // Load a fresh target
    // Use the existing one — find all CardWithIcon subtree nodes
    const wrapperSyms = targetDeck.getSymbols().filter(s => s.name === 'CardWithIcon');
    expect(wrapperSyms.length).toBeGreaterThanOrEqual(1);
    const sym = wrapperSyms[0];

    targetDeck.walkTree(nid(sym), node => {
      expect(node.phase).toBe('CREATED');
    });
  });
});
