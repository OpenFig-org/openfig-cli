# FigmaTK

Swiss-army knife CLI for Figma `.deck` and `.fig` files. Parse, inspect, modify, and rebuild Figma Slides decks programmatically — no Figma API required.

## Why native `.deck`?

Figma Slides lets you download presentations as `.deck` files — and re-upload them. This is the **native** round-trip format. The alternative, exporting to `.pptx`, is lossy: vectors get rasterized to bitmaps, fonts fall back to system defaults, and precise layout breaks. By staying in `.deck`, you preserve everything — fonts, vector shapes, component overrides, styles — exactly as Figma renders them.

**FigmaTK** makes this round-trip programmable. Download a `.deck`, modify it with these utilities, re-upload to Figma. Everything stays native.

## Use Cases

- **AI agent for presentations** — let an LLM read slide content, rewrite copy, insert images, and produce a ready-to-upload `.deck` without ever touching the Figma UI
- **Batch-produce branded decks** — start from a company template, feed in data per client/project, get pixel-perfect slides out
- **Inspect and audit** — understand the internal structure of any `.deck` or `.fig` file
- **Automate** text and image placement across dozens of slides in seconds
- **Validate** your pipeline with lossless roundtrip encode/decode

## Install

```bash
git clone https://github.com/rcoenen/figmatk.git
cd figmatk
npm install
```

No build step. Pure ESM (`.mjs`). Node 18+.

## Quick Start

```bash
# See what's inside a deck
node cli.mjs inspect my-presentation.deck

# List every text field and image in every slide
node cli.mjs list-text my-presentation.deck

# Discover all override keys (what you can edit)
node cli.mjs list-overrides my-presentation.deck
```

## Commands

### `inspect` — Document structure

```bash
node cli.mjs inspect file.deck [--depth N] [--type TYPE] [--json]
```

Prints the full node hierarchy tree:

```
Nodes: 1314  Slides: 10 active / 10 total  Blobs: 465

DOCUMENT "Document" (0:0)
  CANVAS "Page 1" (0:1)
    SLIDE_GRID "Presentation" (0:3)
      SLIDE_ROW "Row" (1:1563)
        SLIDE "1" (1:1559)
          INSTANCE "Cover" (1:1564) sym=1:1322 overrides=3
        SLIDE "2" (1:1570)
          INSTANCE "Content" (1:1572) sym=1:1129 overrides=7
```

Filter by node type (`--type SLIDE`, `--type INSTANCE`, `--type SYMBOL`) or limit depth. Use `--json` for machine-readable output.

### `list-text` — All content

```bash
node cli.mjs list-text file.deck
```

Shows every text string and image hash in the deck — both direct node text and symbol override text. Useful for auditing content or extracting copy.

```
SLIDE "1" → INSTANCE (1:2001) sym=1:1322
  57:48  TEXT: "My Presentation Title"
  57:49  TEXT: "Subtitle Goes Here"
  75:126  IMAGE: 780960f6236bd1305ceeb2590ca395e36e705816 (1011x621)
```

### `list-overrides` — Editable fields

```bash
node cli.mjs list-overrides file.deck [--symbol "Symbol Name"]
```

For every symbol (component) in the file, lists each node that has an `overrideKey` — these are the fields you can modify via `symbolOverrides`. Shows the key ID, node type, name, and current default value.

```
SYMBOL "Image+Text" (1:1205)
  75:126  ROUNDED_RECTANGLE "Photo location" [IMAGE PLACEHOLDER]
  75:127  TEXT "Header" → "Header"
  75:131  TEXT "Subtitle" → "SUBTITLE 2"
  75:132  TEXT "Body" → "Body small lorem ipsum..."
```

### `update-text` — Change text

```bash
node cli.mjs update-text input.deck -o output.deck \
  --slide 1:2000 \
  --set "57:48=New Title" \
  --set "57:49=New Subtitle"
```

Finds the slide (by node ID or name), locates its instance, and adds or updates text overrides. Repeat `--set` for multiple fields. Empty strings are auto-replaced with a space (empty string crashes Figma).

### `insert-image` — Place images

```bash
node cli.mjs insert-image input.deck -o output.deck \
  --slide 1:2006 \
  --key 75:126 \
  --image screenshot.png \
  [--thumb thumbnail.png]
```

Overrides an image placeholder on a slide instance. Automatically:
- SHA-1 hashes the image and copies it to the `images/` directory
- Generates a ~320px thumbnail (or uses `--thumb` if provided)
- Sets the required `styleIdForFill` sentinel GUID
- Sets `imageThumbnail` with the thumbnail hash

### `clone-slide` — Duplicate with content

```bash
node cli.mjs clone-slide input.deck -o output.deck \
  --template 1:1559 \
  --name "New Slide" \
  --set "57:48=Title" \
  --set "57:49=Subtitle" \
  --set-image "75:126=photo.png"
```

Deep-clones a slide + instance pair from a template, assigns fresh GUIDs, applies text and image overrides, and appends to the deck. Uses `Uint8Array`-safe cloning (not `JSON.parse/stringify`).

### `remove-slide` — Delete slides

```bash
node cli.mjs remove-slide input.deck -o output.deck \
  --slide 1:1769 \
  --slide 1:1732
```

Marks slides and their child instances as `REMOVED`. Repeat `--slide` for multiple. Nodes are never deleted from the array — Figma requires them to remain with `phase: 'REMOVED'`.

### `roundtrip` — Validate the pipeline

```bash
node cli.mjs roundtrip input.deck -o output.deck
```

Decodes and re-encodes with zero changes. If Figma opens the output, your pipeline is sound. Prints node/slide/blob counts.

## Using as a Library

```javascript
import { FigDeck } from './lib/fig-deck.mjs';
import { ov, nestedOv, removeNode } from './lib/node-helpers.mjs';
import { imageOv } from './lib/image-helpers.mjs';
import { deepClone } from './lib/deep-clone.mjs';

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
const slide = deck.getActiveSlides()[0];
const inst = deck.getSlideInstance('1:2000');
console.log(inst.symbolData.symbolOverrides);

// Save
await deck.saveDeck('output.deck');
```

### Key classes and functions

| Module | Export | Description |
|--------|--------|-------------|
| `lib/fig-deck.mjs` | `FigDeck` | Core class — parse, query, encode, save |
| `lib/node-helpers.mjs` | `nid(node)` | Format node ID as `"sessionID:localID"` |
| | `parseId(str)` | Parse `"57:48"` to `{ sessionID, localID }` |
| | `ov(key, text)` | Build a text override for `symbolOverrides` |
| | `nestedOv(instKey, textKey, text)` | Text override for nested instances |
| | `removeNode(node)` | Mark node as REMOVED |
| `lib/image-helpers.mjs` | `imageOv(key, hash, thumbHash, w, h)` | Build a complete image fill override |
| | `hexToHash(hex)` / `hashToHex(arr)` | Convert between hex strings and `Uint8Array(20)` |
| `lib/deep-clone.mjs` | `deepClone(obj)` | `Uint8Array`-safe deep clone |

### FigDeck API

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

## Figma Binary Format

A `.deck` file is a ZIP archive containing:

| File | Description |
|------|-------------|
| `canvas.fig` | Binary Figma document |
| `thumbnail.png` | Deck thumbnail |
| `meta.json` | `{ file_name, version, ... }` |
| `images/` | Image assets, each named by its SHA-1 hash (no extension) |

The `canvas.fig` binary layout:

```
[8 bytes]  Prelude — "fig-deck", "fig-kiwi", or "fig-jam."
[4 bytes]  Version — uint32 little-endian
[4 bytes]  Chunk 0 length
[N bytes]  Chunk 0 — Kiwi binary schema (deflateRaw compressed)
[4 bytes]  Chunk 1 length
[N bytes]  Chunk 1 — Message data (zstd compressed)
[...]      Optional additional chunks (pass through)
```

The message contains `nodeChanges[]` (every node in the document) and `blobs[]` (binary data for paths, etc.). Nodes form a tree via `parentIndex.guid`. Each node has a `type` (DOCUMENT, CANVAS, SLIDE, INSTANCE, TEXT, SYMBOL, etc.) and optionally `symbolData` with `symbolOverrides` for component instances.

## Format Rules

Important constraints discovered while building this toolkit. Violating any of them produces silent failures or crashes:

| Rule | Detail |
|------|--------|
| **Chunk 1 = zstd** | Figma silently rejects deflateRaw for the message chunk |
| **`styleIdForFill` required for images** | Must be `{ guid: { sessionID: 0xFFFFFFFF, localID: 0xFFFFFFFF } }` — without this, Figma ignores `fillPaints` overrides entirely |
| **`imageThumbnail` required** | Image overrides need a real ~320px PNG thumbnail in `images/`, referenced by SHA-1 hash |
| **No empty strings** | `''` crashes Figma — use `' '` (space) for blank fields |
| **Never delete nodes** | Set `phase: 'REMOVED'` instead — Figma expects all nodes to remain in `nodeChanges` |
| **`thumbHash: new Uint8Array(0)`** | Must be a typed array, not `{}` — kiwi-schema enforces this |
| **Delete `derivedTextData`** | Stale layout cache — must be removed when modifying text directly on nodes (not needed for overrides) |
| **Don't JSON-clone nodes** | `JSON.parse(JSON.stringify())` corrupts `Uint8Array` fields — use `deepClone()` |

## Architecture

```
figmatk/
  cli.mjs                    # CLI entry point — arg parsing + subcommand dispatch
  lib/
    fig-deck.mjs             # FigDeck class — own binary parser, no third-party deps
    deep-clone.mjs           # Uint8Array-safe recursive deep clone
    node-helpers.mjs         # Node ID utils, override builders, removal helper
    image-helpers.mjs        # SHA-1 hash conversion, image override builder
  commands/
    inspect.mjs              # Tree view of document structure
    list-text.mjs            # All text + image content per slide
    list-overrides.mjs       # Editable override keys per symbol
    update-text.mjs          # Set text overrides on a slide
    insert-image.mjs         # Image fill override with auto-thumbnail
    clone-slide.mjs          # Duplicate a slide with content
    remove-slide.mjs         # Mark slides REMOVED
    roundtrip.mjs            # Decode/re-encode validation
```

No framework dependencies for CLI parsing. Five npm packages total: `kiwi-schema`, `fzstd`, `zstd-codec`, `pako`, `archiver`.

## License

MIT
