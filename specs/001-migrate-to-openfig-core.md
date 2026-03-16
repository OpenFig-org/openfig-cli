# SPEC-001: Migrate read-path parsing to openfig-core

**Status:** Draft
**Created:** 2026-03-16
**Repo:** openfig-cli

## Problem

The `.fig` binary parsing logic in `lib/core/fig-deck.mjs:_parseFig()` is duplicated across two packages. `openfig-core` (TypeScript, isomorphic, zero Node deps) is now the canonical implementation, already used by `openfig-design`. The CLI should consume it instead of maintaining its own copy.

## Goals

1. Replace `_parseFig()` with `parseFigBinary()` from `openfig-core`.
2. Replace `nid()` with `nodeId()` from `openfig-core`.
3. Remove `fzstd` as a direct dependency (consumed transitively via `openfig-core`).
4. Keep the write path (`encodeFig`, `saveDeck`, `saveFig`) unchanged.
5. All existing tests pass with no behavioral changes.

## Non-goals

- Porting the encode/write path to `openfig-core`.
- Removing `kiwi-schema`, `pako`, `zstd-codec`, or `yazl` (all still needed for encoding).
- Changing the public API surface of `FigDeck` or `node-helpers.mjs`.
- Migrating `deep-clone.mjs`, `image-helpers.mjs`, or `image-utils.mjs`.

## Background

### Current read path (`_parseFig`)

`lib/core/fig-deck.mjs`, lines 94-130:

```
_parseFig(buf)
  → Uint8Array + DataView
  → read 8-byte prelude, uint32 version → this.header
  → read length-prefixed chunks → this.rawFiles[]
  → chunk 0: inflateRaw → decodeBinarySchema → compileSchema → this.schema, this.compiledSchema
  → chunk 1: auto-detect zstd (fzstd.decompress) vs deflateRaw (pako.inflateRaw)
            → compiledSchema.decodeMessage → this.message
  → rebuildMaps()
```

Dependencies used on the read path:
- `fzstd` — zstd decompression
- `pako` — `inflateRaw` only
- `kiwi-schema` — `decodeBinarySchema`, `compileSchema`

### openfig-core API

```ts
parseFigBinary(data: Uint8Array): FigDocument
// FigDocument { header, schema, compiledSchema, message, nodes, nodeMap, childrenMap, rawFiles }

nodeId(node: FigNode): string | null
// Equivalent to nid(): formats guid as "sessionID:localID"
```

`parseFigBinary` performs the exact same algorithm: prelude, chunks, inflate, zstd detect, kiwi decode, map building. Its output is structurally identical.

### `nid()` in node-helpers.mjs

```js
export function nid(node) {
  if (!node?.guid) return null;
  return `${node.guid.sessionID}:${node.guid.localID}`;
}
```

This is identical to `openfig-core:nodeId()`.

## Design

### Phase 1: Add dependency, swap `_parseFig`

**1a. Install openfig-core**

```bash
npm install openfig-core
```

**1b. Refactor `_parseFig()` in `lib/core/fig-deck.mjs`**

Replace the body of `_parseFig(buf)` to delegate to `parseFigBinary`:

```js
import { parseFigBinary } from 'openfig-core';

_parseFig(buf) {
  const doc = parseFigBinary(new Uint8Array(buf.buffer ?? buf));
  this.header     = doc.header;
  this.schema     = doc.schema;
  this.compiledSchema = doc.compiledSchema;
  this.message    = doc.message;
  this.rawFiles   = doc.rawFiles;
  // nodeMap and childrenMap are rebuilt by rebuildMaps(),
  // but parseFigBinary already provides them — use directly:
  this.nodeMap    = doc.nodeMap;
  this.childrenMap = doc.childrenMap;
}
```

**Open question:** Does `parseFigBinary` return `compiledSchema` (needed by `encodeFig` for `compiledSchema.encodeMessage`)? If not, the CLI must keep calling `compileSchema(doc.schema)` itself, or `openfig-core` must expose it. **This must be verified against the actual openfig-core export before implementation.**

**Open question:** Does `parseFigBinary` return `rawFiles`? The encode path re-uses `this.rawFiles[0]` (the original compressed schema chunk) when writing. If not exposed, the CLI must either keep its own chunk reader or `openfig-core` must expose it.

**Open question:** Does `parseFigBinary` populate `nodeMap` and `childrenMap` with the same key format (`"sessionID:localID"`)? The CLI's `rebuildMaps()` uses inline formatting (`${node.parentIndex.guid.sessionID}:${node.parentIndex.guid.localID}`), not `nid()`. Confirm openfig-core matches.

**1c. Remove read-path imports**

After delegating to `parseFigBinary`, remove from `fig-deck.mjs`:
- `import { decompress } from 'fzstd'` — no longer called
- `import { decodeBinarySchema, compileSchema } from 'kiwi-schema'` — **only if** `parseFigBinary` returns a usable `compiledSchema`. Keep `encodeBinarySchema` (used in `encodeFig`).
- `inflateRaw` from `pako` — **only if** not used elsewhere in the file. Check `encodeFig` — it uses `deflateRaw`, not `inflateRaw`, so `inflateRaw` can go.

### Phase 2: Replace `nid()` with `nodeId()`

**Option A — Alias re-export (minimal diff, recommended):**

In `lib/core/node-helpers.mjs`:
```js
import { nodeId as nid } from 'openfig-core';
export { nid };
```

This is a zero-diff change for all 13+ consumers. The rest of `node-helpers.mjs` (`parseId`, `makeGuid`, `ov`, `nestedOv`, `removeNode`, `positionChar`) stays — these are CLI-specific and not in `openfig-core`.

**Option B — Direct import (larger diff):**

Replace `import { nid } from '...node-helpers.mjs'` with `import { nodeId } from 'openfig-core'` across all 13+ files. This is cleaner long-term but touches many files for no functional benefit today.

**Recommendation:** Option A for this PR. Option B can be a follow-up if desired.

### Phase 3: Remove `fzstd` dependency

```bash
npm uninstall fzstd
```

Only used in the read path (one import in `fig-deck.mjs`), which is now delegated to `openfig-core`.

### Phase 4: Verify public exports

`package.json` exports `"./node-helpers"` and `"./deck"`. Downstream consumers (if any) that import `nid` from `openfig-cli/node-helpers` must continue to work. The alias approach in Phase 2 ensures this.

## Affected files

| File | Change |
|------|--------|
| `package.json` | Add `openfig-core`, remove `fzstd` |
| `lib/core/fig-deck.mjs` | Replace `_parseFig` body, remove `fzstd`/`inflateRaw`/`decodeBinarySchema` imports |
| `lib/core/node-helpers.mjs` | Replace `nid` implementation with re-export from openfig-core |

No other files change.

## Open questions

1. **`compiledSchema` availability** — Does `parseFigBinary()` return a `compiledSchema` that supports `encodeMessage()`? The write path calls `this.compiledSchema.encodeMessage(this.message)` in `encodeFig()`. If openfig-core only provides decode, the CLI must keep `compileSchema()` for the round-trip.

2. **`rawFiles` availability** — Does `parseFigBinary()` expose the raw length-prefixed chunks? `encodeFig()` references `this.rawFiles` when rebuilding the binary. If not, the CLI needs to keep its own chunk-reading code alongside the core parse call.

3. **`decodeBinarySchema` / `compileSchema` re-export** — If the CLI still needs to call `compileSchema` for the write path, should openfig-core re-export these from `kiwi-schema`, or should the CLI keep its direct `kiwi-schema` dependency? Keeping the direct dep is simpler for now.

4. **`nodeMap` / `childrenMap` identity** — The CLI's `rebuildMaps()` is also called after mutations (e.g., `importSymbols`). Even if we use the core's maps on initial parse, `rebuildMaps()` must stay as a method. Confirm the core's map format is compatible so we can skip the initial `rebuildMaps()` call.

5. **openfig-core version** — What is the current published version? Is it stable enough for a production dependency? Pin to exact version or use caret?

## Acceptance criteria

- [ ] `npm test` passes (all existing tests green)
- [ ] `openfig roundtrip` produces byte-identical output for test fixtures
- [ ] `fzstd` is no longer in `package.json` dependencies
- [ ] `openfig-core` is in `package.json` dependencies
- [ ] `_parseFig()` delegates to `parseFigBinary()` — no manual chunk parsing
- [ ] `nid()` delegates to or re-exports `nodeId()` from openfig-core
- [ ] Write path (`encodeFig`, `saveDeck`, `saveFig`) is unchanged and functional
- [ ] No new Node.js-only deps introduced (openfig-core is isomorphic)

## Rollback

Revert the single PR. The old `_parseFig` implementation and `fzstd` dep are restored from git history. No data migration involved.

## Future work

- Port `encodeFig()` to `openfig-core` (eliminates `pako`, `kiwi-schema`, `zstd-codec` from CLI)
- Move `deep-clone.mjs` and `image-helpers.mjs` to openfig-core if other consumers need them
- Option B rename: `nid` → `nodeId` across the codebase
