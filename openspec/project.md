# Project Context

## Purpose

openfig is a CLI + programmatic JS library for reading and writing Figma Slides `.deck` files.
It reverse-engineers the Figma binary format to enable automation of slide creation, content
population, and template-based deck generation — analogous to what python-pptx does for PowerPoint.

Primary use cases:
- Populate slide templates with dynamic content (text, images) programmatically
- Clone slides from symbol templates and batch-fill them
- Inspect and extract content from existing `.deck` files
- Build pipelines that produce Figma Slides from data sources

## Tech Stack

- **Runtime:** Node.js 18+ (ES modules only, `.mjs` throughout)
- **Format:** Figma `.deck` = ZIP archive containing `canvas.fig` (kiwi-encoded binary)
- **Codec:** `kiwi-schema` (binary schema decode/encode), `fzstd` (zstd decompress), `zstd-codec` (zstd compress), `pako` (deflateRaw)
- **ZIP:** `archiver` (write), `unzip` via shell (read)
- **CLI:** Custom arg parser in `cli.mjs`
- **MCP server:** `@modelcontextprotocol/sdk`

## Project Conventions

### Code Style
- ES modules only — all files are `.mjs`, never `.js` or `.cjs`, never `require()`
- No TypeScript — plain JS with JSDoc comments where helpful
- Async/await throughout; no callback style
- Named exports only — no default exports

### Architecture Patterns
- **Two-layer API:**
  - Low-level: `FigDeck` in `lib/fig-deck.mjs` — raw codec, ZIP, kiwi encode/decode
  - High-level: `Deck/Slide/Symbol` in `lib/api.mjs` — clean object model, user-facing
- **Commands** in `commands/` are thin CLI wrappers around lib functions
- Never add logic to commands that belongs in lib
- `FigDeck` is stable — do not modify without understanding the full kiwi/zstd pipeline

### Testing Strategy
- No automated test suite yet
- **Learn loop:** ask user to create X in Figma → save `.deck` → inspect raw nodes to learn format
- **Validate loop:** produce `.deck` with our code → user uploads to Figma → confirm correct render
- Each Phase 2 feature must pass the validate loop before being considered shipped
- One validation gate per feature — don't over-test, move on when core behavior confirmed

### Git Workflow
- Single `main` branch
- Commit per logical unit of work
- Co-authored commits with Claude: `Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>`

## Domain Context

The `.deck` format is partially reverse-engineered. Key hard-won rules:

- `.deck` = ZIP (store mode) containing `canvas.fig`, `thumbnail.png`, `meta.json`, `images/`
- `canvas.fig` = 8-byte prelude + uint32 version + length-prefixed chunks
- Chunk 0 = kiwi binary schema, deflateRaw compressed — **never regenerate, preserve verbatim**
- Chunk 1 = kiwi message data, **must be zstd compressed** — Figma silently rejects deflateRaw
- `nodeChanges` is a flat array of all nodes — **never filter it**, set `phase: 'REMOVED'` instead
- Empty string `''` in text crashes Figma — always use `' '` (space) for blank fields
- Image overrides require `styleIdForFill` sentinel (`0xFFFFFFFF:0xFFFFFFFF`) or Figma ignores them
- `thumbHash` must be `new Uint8Array(0)`, never `{}`
- Images stored in `images/` dir named by 40-char hex SHA-1, no extension
- Thumbnails are ~320px wide PNGs generated via `sips` (macOS)

See `docs/openfig-api-spec.md` for the full phased feature plan.
See `docs/feature-map.md` for the python-pptx → openfig feature mapping.
See `docs/deck-format.md` for the complete format specification.

## Important Constraints

- **Package name:** `openfig` on npm. Never use `figmatoolkit` in code — prose docs only.
- **macOS dependency:** `sips` used for image dimensions + thumbnail generation. Non-macOS support is future work.
- **No kiwi regeneration:** The kiwi schema in chunk 0 must always be the original from the source file.
- **Phase 2 features are unvalidated:** Shape properties, text formatting, shape creation — none of these are confirmed working. Follow the learn/validate loop before implementing.

## External Dependencies

- **Figma Slides** — the target application; all output is validated by uploading to Figma
- **npm registry** — package published as `openfig` by user `rcoenen`
- **GitHub** — `github.com/rcoenen/openfig`
