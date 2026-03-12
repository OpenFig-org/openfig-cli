# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

FigmaTK is a CLI tool for programmatically parsing, inspecting, and modifying Figma Slides `.deck` files (and raw `.fig` files) without the Figma API. It enables lossless round-trip editing of presentations.

## Commands

```bash
npm install              # Install dependencies
node cli.mjs <cmd> ...   # Run a command (npm start aliases to node cli.mjs)
```

No build step — pure ESM `.mjs` modules. No test framework or linter configured. Use `roundtrip` command to validate encode/decode pipeline.

## Architecture

**Entry point:** `cli.mjs` — manual arg parser + command dispatcher (8 subcommands).

**Core class:** `FigDeck` in `lib/fig-deck.mjs` — handles the full lifecycle:
1. Load `.deck` (ZIP containing `canvas.fig`, `thumbnail.png`, `meta.json`, `images/`) or raw `.fig`
2. Decode kiwi-schema binary → `message.nodeChanges[]` array of nodes
3. Build `nodeMap` (keyed by `"sessionID:localID"`) and `childrenMap` for O(1) lookups
4. Expose query APIs: `getSlides()`, `getActiveSlides()`, `getSymbols()`, `walkTree()`, etc.
5. Encode back: kiwi encode → zstd compress → write ZIP

**Commands** (`commands/*.mjs`): each exports `async function run(positional, flags)`.
- `inspect` — tree view of document structure
- `list-text` — extract text + image content per slide
- `list-overrides` — show editable override keys per symbol
- `update-text` — set text overrides on a slide instance
- `insert-image` — image fill override with auto-thumbnail (uses macOS `sips`)
- `clone-slide` — deep-clone a template slide with new content
- `remove-slide` — mark slides as REMOVED
- `roundtrip` — decode/re-encode validation

**Helpers:**
- `lib/node-helpers.mjs` — node ID formatting (`nid()`, `parseId()`), override builders (`ov()`, `nestedOv()`)
- `lib/image-helpers.mjs` — SHA-1 hash conversion, `imageOv()` builder
- `lib/deep-clone.mjs` — Uint8Array-safe deep clone (JSON.parse/stringify corrupts typed arrays)

## Critical Rules

- **Node IDs** are always `"sessionID:localID"` colon-separated strings.
- **Never delete nodes** from `nodeChanges` — mark them `phase: 'REMOVED'` instead.
- **Empty text strings crash Figma** — always replace with a single space.
- **Chunk 1 must use zstd** (level 3) when writing; Figma rejects deflateRaw. Chunk 0 uses deflateRaw.
- **Image overrides require both** a full-res image hash AND a thumbnail hash (~320px PNG). The `styleIdForFill` sentinel GUID (`0xFFFFFFFF, 0xFFFFFFFF`) is required. `thumbHash` must be `new Uint8Array(0)`, not `{}`.
- **Call `deck.rebuildMaps()`** after any mutation to nodeChanges.
- **New nodes** use `sessionID=1`, `localID = deck.maxLocalID() + 1`, and `phase: 'CREATED'`.

## Binary Format

See `docs/deck-format.md` for the full spec. Key points:
- `.deck` is a ZIP; `.fig` is raw binary
- `canvas.fig` layout: 8-byte prelude → uint32 version → length-prefixed chunks
- Zstd magic bytes: `0x28 0xB5 0x2F 0xFD` (auto-detected on read)

## Dependencies

5 npm packages: `kiwi-schema` (binary encoding), `fzstd`/`zstd-codec` (zstd compression), `pako` (deflate), `archiver` (ZIP creation).
