# OpenFig Library (Low-Level API)

For the high-level programmatic API (`Deck`, `Slide`, `addText`, `addImage`, etc.) see [openfig-api-spec.md](openfig-api-spec.md).

For reusable-template authoring and instantiation workflows, see [mcp.md](mcp.md) and [template-workflows.md](template-workflows.md). Those workflows are currently driven through the MCP layer and internal helpers, not this low-level `FigDeck` page.

This page covers the low-level `FigDeck` class and helper utilities — useful when you need direct access to the node graph.

## Install

```bash
npm install openfig
```

## Basic Usage

```javascript
import { FigDeck } from 'openfig/deck';
import { ov, nestedOv, removeNode } from 'openfig/node-helpers';
import { imageOv } from 'openfig/image-helpers';
import { deepClone } from 'openfig/deep-clone';

// Load
const deck = await FigDeck.fromDeckFile('template.deck');

// Explore
console.log(deck.getActiveSlides().length, 'slides');
console.log(deck.getSymbols().map(s => s.name));

// Walk the tree
deck.walkTree('0:0', (node, depth) => {
  console.log('  '.repeat(depth) + node.type + ' ' + (node.name || ''));
});

// Find a slide's instance and read its overrides
const inst = deck.getSlideInstance('1:2000');
console.log(inst.symbolData.symbolOverrides);

// Save
await deck.saveDeck('output.deck');
```

## FigDeck API

| Method | Returns | Description |
|--------|---------|-------------|
| `FigDeck.fromDeckFile(path)` | `Promise<FigDeck>` | Load from `.deck` ZIP |
| `FigDeck.fromFigFile(path)` | `FigDeck` | Load from raw `.fig` |
| `deck.getSlides()` | `node[]` | All SLIDE nodes |
| `deck.getActiveSlides()` | `node[]` | Non-REMOVED slides |
| `deck.getInstances()` | `node[]` | All INSTANCE nodes |
| `deck.getSymbols()` | `node[]` | All SYMBOL nodes |
| `deck.getNode(id)` | `node` | Lookup by `"s:l"` string |
| `deck.getChildren(id)` | `node[]` | Child nodes |
| `deck.getSlideInstance(slideId)` | `node` | INSTANCE child of a SLIDE |
| `deck.walkTree(rootId, fn)` | void | DFS traversal |
| `deck.maxLocalID()` | `number` | Highest ID in use |
| `deck.rebuildMaps()` | void | Re-index after mutations |
| `deck.encodeFig()` | `Promise<Uint8Array>` | Encode to `canvas.fig` binary |
| `deck.saveDeck(path, opts?)` | `Promise<number>` | Write complete `.deck` ZIP |
| `deck.saveFig(path)` | `Promise<void>` | Write raw `.fig` binary |

## Helper Modules

| Module | Export | Description |
|--------|--------|-------------|
| `openfig/node-helpers` | `nid(node)` | Format node ID as `"sessionID:localID"` |
| | `parseId(str)` | Parse `"57:48"` to `{ sessionID, localID }` |
| | `ov(key, text)` | Build a text override for `symbolOverrides` |
| | `nestedOv(instKey, textKey, text)` | Text override for nested instances |
| | `removeNode(node)` | Mark node as REMOVED |
| `openfig/image-helpers` | `imageOv(key, hash, thumbHash, w, h)` | Build a complete image fill override |
| | `hexToHash(hex)` / `hashToHex(arr)` | Convert between hex strings and `Uint8Array(20)` |
| `openfig/deep-clone` | `deepClone(obj)` | `Uint8Array`-safe deep clone |
