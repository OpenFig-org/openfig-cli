# Agent Guide

Project reference for AI agents and developers working on openfig.
Tool-agnostic — not specific to any assistant or IDE.

## Project Overview

**openfig** is a Node.js toolkit for reading, modifying, and rendering Figma
files natively. Package name: `openfig` (npm). Use `openfig` only in prose.

Currently supports `.deck` files (Figma Slides). Future: `.fig` files (Figma
Design). The binary codec is already format-agnostic — both formats share the
same kiwi schema + zstd pipeline.

## Architecture

```
.deck (ZIP)  →  FigDeck (codec)  →  node tree  →  Deck/Slide API  →  user code
.fig (raw)   →  FigDeck (codec)  →  node tree  →  (future API)    →  user code
                                         ↓
                                  svg-builder.mjs  →  SVG  →  resvg-wasm  →  PNG
```

### Layers

| Layer | Path | Format-agnostic? | Description |
|-------|------|-------------------|-------------|
| Binary codec | `lib/core/fig-deck.mjs` | Yes | Kiwi schema, zstd, node tree, blobs |
| Node helpers | `lib/core/node-helpers.mjs` | Yes | GUIDs, tree traversal, `nid()` |
| Image helpers | `lib/core/image-helpers.mjs` | Yes | SHA-1 hashing, thumbnails |
| High-level API | `lib/slides/api.mjs` | Slides-only | `Deck`, `Slide`, `Symbol`, `TextNode`, `ImageNode` |
| Templates | `lib/slides/template-deck.mjs` | Slides-only | Template inspection, authoring, instantiation |
| Rasterizer | `lib/rasterizer/` | Yes | SVG generation + PNG rendering |
| CLI commands | `commands/` | Slides-only | inspect, update-text, clone-slide, etc. |
| MCP server | `mcp-server.mjs` | Slides-only | Tool server for AI assistants |

### .deck vs .fig

Both `.deck` and `.fig` files are ZIP archives with the same internal structure:
`canvas.fig` + `meta.json` + `thumbnail.png` + `images/`. The only differences
are the file extension and the binary prelude inside `canvas.fig`:

| Format | Extension | Prelude | Top-level containers |
|--------|-----------|---------|---------------------|
| Figma Slides | `.deck` | `fig-deck` | SLIDE nodes inside SLIDE_GRID |
| Figma Design | `.fig` | `fig-kiwi` | CANVAS nodes (pages) containing FRAMEs |

`fromDeckFile()` works for both formats. The codec is fully format-agnostic.

## Key directories

```
lib/core/               Shared codec, helpers (format-agnostic)
lib/slides/             Slides-specific API, templates (.deck)
lib/rasterizer/         SVG builder + PNG renderer + font resolution
commands/               CLI command implementations
decks/reference/        .deck fixtures (Figma Slides)
figs/reference/         .fig fixtures (Figma Design)
decks/generated-for-validation/  Decks our code produces (user tests in Figma)
docs/format/            Binary format specification
docs/rasterizer/        Rendering pipeline, fonts, testing
test/                   Vitest test suites
```

## Development methodology

1. **Learn**: User creates X in Figma → saves `.deck` → we inspect to learn format
2. **Implement**: Write code based on observed format
3. **Validate**: Produce `.deck` → user uploads to Figma → confirm it renders correctly
4. **Regress**: Add SSIM test with reference PNG → threshold guards prevent regressions

Unknown format features must go through this loop before implementing. Never guess
at undocumented format behavior.

## Code conventions

### Parameter naming

- `deck` — Slides-specific (.deck), expects SLIDE nodes, 1920×1080 viewport
- `fig` — format-agnostic, works with any Figma file (.deck or .fig)
- Internal shared functions use `deck` for historical reasons — they are format-agnostic despite the name

### Module boundaries

- `lib/core/` — shared codec + helpers. Never imports from `lib/slides/`
- `lib/slides/` — Slides product layer. May import from `lib/core/`
- `lib/rasterizer/` — shared renderer. May import from `lib/core/`, never from `lib/slides/`
- `commands/` — CLI. May import from `lib/core/` and `lib/slides/`

### File naming

- `.mjs` — all lib files are ES modules
- `.deck` — Figma Slides archive (ZIP containing canvas.fig)
- `.fig` — Figma Design archive (same ZIP structure, different prelude)

## Access is 1-indexed

```javascript
// Slides (.deck)
deck.getSlide(1)        // first slide
deck.slide(1)           // first slide (Deck high-level API)
deck.getActiveSlides()  // all slides as array

// Pages (.fig)
fd.getPage(1)           // first page (sorted by Figma's display order)
fd.getPages()           // all user-facing pages (excludes Internal Only Canvas)

// Page contents (.fig) — top-level children are exportable frames
fd.getChildren(nid(page))  // FRAMEs, TEXT, etc. on a page
```

There is no slide 0 or page 0.

## Format rules (crash if violated)

See `docs/format/invariants.md` for the full list. The critical ones:

- **Never filter `nodeChanges`** — set `phase: 'REMOVED'` instead
- **Never use `''` empty string for text** — use `' '` (space); empty crashes Figma
- **Chunk 1 must be zstd** — Figma silently rejects deflateRaw
- **Preserve original kiwi schema** verbatim — never regenerate
- **`thumbHash` must be `new Uint8Array(0)`**, never `{}`

## Rendering principles

See `docs/rasterizer/pipeline.md` for full details. Key non-obvious behaviors:

- **Full affine transforms**: FRAME/GROUP/INSTANCE can be rotated+scaled, not just
  translated. Use the full `matrix()` SVG transform with 6dp precision for
  rotation/scale components.
- **Per-path vector fills**: A single VECTOR node can have different fill colors on
  different sub-paths via `fillGeometry[].styleID` → `vectorData.styleOverrideTable`.
- **Stroke geometry is pre-expanded**: strokeGeometry blobs are filled outline shapes,
  not SVG strokes. Fill them with the stroke color.
- **INSIDE stroke clipping**: Figma's stroke geometry extends symmetrically outside the
  frame edge. Clip to frame bounds to show only the inside portion.
- **Node opacity**: Applied as SVG group opacity on the entire subtree.
- **frameMaskDisabled=false**: Clips children to frame bounds (Figma default).
- **derivedTextData is authoritative**: Always use Figma's pre-computed glyph positions,
  baselines, and decoration rectangles over manual font metric calculation.

## SSIM testing

Rendered slides are compared pixel-by-pixel against Figma reference PNGs.
See `docs/rasterizer/testing.md`.

- Thresholds are regression guards — raise as rendering improves, never lower
- Reports show 3 columns: Reference, Render, Overlay (50% diff composite)
- Run `npm test` to execute all SSIM tests

## Validation approach

- Use **high-contrast, obviously different colors** in test decks — subtle hues are
  easy to miss
- When regenerating a validation deck, bump a numeric suffix `_01`, `_02`, `_03` —
  user keeps multiple versions open in Figma simultaneously
- Always fix rendering issues at the **root cause level** — first-principles fixes
  that improve all slides, not per-slide hacks

## Documentation index

| Document | What it covers |
|----------|----------------|
| `docs/architecture.md` | Multi-product architecture: shared core, product layers, migration path |
| `docs/format/` | Binary format: ZIP structure, nodes, shapes, text, images, overrides |
| `docs/rasterizer/pipeline.md` | SVG generation: node dispatch, transforms, VECTOR, INSTANCE |
| `docs/rasterizer/fonts.md` | Font resolution, Google Fonts, Inter v3/v4, TTC |
| `docs/rasterizer/testing.md` | SSIM testing, reference decks, HTML comparison reports |
| `docs/openfig-api-spec.md` | High-level API design (phases 1–5) |
| `docs/feature-map.md` | python-pptx → openfig feature mapping |
| `docs/library.md` | Library usage examples |
