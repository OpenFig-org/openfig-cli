# Archive Structure & Binary Layout

## ZIP Archive

A `.deck` file is a standard **ZIP archive** (uncompressed / store mode) containing:

| File | Required | Description |
|------|----------|-------------|
| `canvas.fig` | Yes | Binary Figma document (kiwi-schema encoded) |
| `thumbnail.png` | Yes | Deck thumbnail shown in Figma's file browser |
| `meta.json` | Yes | Metadata — file name, version |
| `images/` | No | Image assets, each named by SHA-1 hash (no extension) |

### meta.json

```json
{
  "file_name": "My Presentation",
  "version": "1"
}
```

---

## canvas.fig Binary Layout

The `canvas.fig` file is a length-prefixed binary format. There is no checksum or integrity field.

### Header

```
Offset  Size     Description
──────  ───────  ──────────────────────────────
0       8 bytes  Prelude — ASCII string identifying the format
8       4 bytes  Version — uint32 little-endian
12      ...      Chunks begin
```

**Known preludes:**

| Prelude | Format |
|---------|--------|
| `fig-kiwi` | Figma Design files (`.fig`) |
| `fig-deck` | Figma Slides files (`.deck`) |
| `fig-jam.` | FigJam files (`.jam`) |

All preludes are exactly 8 bytes (padded if needed). The version field observed in the wild is typically `106`.

### Chunks

After the header, the file contains a sequence of length-prefixed chunks:

```
Offset  Size     Description
──────  ───────  ──────────────────────────────
0       4 bytes  Chunk length N — uint32 little-endian
4       N bytes  Chunk data (compressed)
```

Chunks repeat until end of file. Typically there are 2 chunks, occasionally 3+.

### Chunk 0 — Kiwi Binary Schema

| Property | Value |
|----------|-------|
| Compression | **deflateRaw** (RFC 1951, no zlib/gzip wrapper) |
| Content | Kiwi binary schema definition |
| Purpose | Defines the structure of all message types |

Decode with `decodeBinarySchema()` from the `kiwi-schema` package, then compile with `compileSchema()` to get encode/decode functions.

The schema from the file should always be preserved and re-used — never generate a new one.

### Chunk 1 — Message Data

| Property | Value |
|----------|-------|
| Compression | **zstd** (required for writing; Figma rejects deflateRaw) |
| Magic bytes | `0x28 0xB5 0x2F 0xFD` at offset 0 (zstd frame magic) |
| Content | Kiwi-encoded message |
| Purpose | Contains all document nodes, blobs, and metadata |

When **reading**, auto-detect the compression by checking for zstd magic bytes. Fall back to deflateRaw for older files.

When **writing**, always use zstd compression (level 3). Figma silently rejects files where chunk 1 is deflateRaw-compressed.

### Chunk 2+ — Additional Data

Optional. Pass through as-is during roundtrip — content and compression are opaque.

---

## Message Structure

The decoded message object contains:

```javascript
{
  nodeChanges: [ ... ],  // Array of ALL nodes in the document
  blobs: [ ... ],        // Binary data (paths, masks, geometry)
  // ... other fields defined by the kiwi schema
}
```

### nodeChanges

This is the heart of the document. Every node — from the root DOCUMENT down to individual text runs — lives in this flat array. The tree structure is encoded via `parentIndex` references.

**The array must never be filtered.** To remove a node, set its `phase` to `'REMOVED'`. Nodes removed from the array cause import failures.

### blobs

Array of `{ bytes: Uint8Array }` objects. Referenced by **index** from node fields
like `fillGeometry[].commandsBlob` and `vectorData.vectorNetworkBlob`.

Known blob types:
- **fillGeometry commandsBlob** — encoded path commands for rendering shapes/vectors.
  See [shapes.md](shapes.md) for the binary format (moveTo/lineTo/cubicTo/close).
- **vectorNetworkBlob** — editable vector network for VECTOR nodes.
  See [shapes.md](shapes.md) for the binary format (vertices/segments/regions).

Blobs are encoded inline in the kiwi message — the `kiwi-schema` package handles
serialization automatically via `ByteBuffer.readByteArray()`/`writeByteArray()`.
When cloning blobs, use `deepClone()` to preserve `Uint8Array` instances
(`JSON.stringify` corrupts them into plain objects).

---

## Encoding Pipeline

To produce a valid `canvas.fig`:

```
1. Encode message     →  compiledSchema.encodeMessage(message)
2. Compress schema    →  deflateRaw(encodeBinarySchema(schema))
3. Compress message   →  zstd.compress(encodedMessage, level=3)
4. Assemble binary:
   [8B prelude][4B version][4B schema_len][schema][4B msg_len][msg][optional chunks...]
5. Pack into ZIP with thumbnail.png, meta.json, images/
```
