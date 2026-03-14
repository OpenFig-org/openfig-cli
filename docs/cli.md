# OpenFig CLI Reference

The CLI is focused on inspection, override-based editing, and roundtrip validation.

For Claude/MCP workflows such as template authoring and template instantiation, see [mcp.md](mcp.md) and [template-workflows.md](template-workflows.md).

## `inspect` — Document structure

```bash
openfig inspect file.deck [--depth N] [--type TYPE] [--json]
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

---

## `list-text` — All content

```bash
openfig list-text file.deck
```

Shows every text string and image hash in the deck — both direct node text and symbol override text. Useful for auditing content or extracting copy.

```
SLIDE "1" → INSTANCE (1:2001) sym=1:1322
  57:48  TEXT: "My Presentation Title"
  57:49  TEXT: "Subtitle Goes Here"
  75:126  IMAGE: 780960f6236bd1305ceeb2590ca395e36e705816 (1011x621)
```

---

## `list-overrides` — Editable fields

```bash
openfig list-overrides file.deck [--symbol "Symbol Name"]
```

For every symbol (component) in the file, lists each node that has an `overrideKey` — these are the fields you can modify via `symbolOverrides`. Shows the key ID, node type, name, and current default value.

```
SYMBOL "Image+Text" (1:1205)
  75:126  ROUNDED_RECTANGLE "Photo location" [IMAGE PLACEHOLDER]
  75:127  TEXT "Header" → "Header"
  75:131  TEXT "Subtitle" → "SUBTITLE 2"
  75:132  TEXT "Body" → "Body small lorem ipsum..."
```

---

## `update-text` — Change text

```bash
openfig update-text input.deck -o output.deck \
  --slide 1:2000 \
  --set "57:48=New Title" \
  --set "57:49=New Subtitle"
```

Finds the slide (by node ID or name), locates its instance, and adds or updates text overrides. Repeat `--set` for multiple fields. Empty strings are auto-replaced with a space (empty string crashes Figma).

---

## `insert-image` — Place images

```bash
openfig insert-image input.deck -o output.deck \
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

---

## `clone-slide` — Duplicate with content

```bash
openfig clone-slide input.deck -o output.deck \
  --template 1:1559 \
  --name "New Slide" \
  --set "57:48=Title" \
  --set "57:49=Subtitle" \
  --set-image "75:126=photo.png"
```

Deep-clones a slide + instance pair from a template, assigns fresh GUIDs, applies text and image overrides, and appends to the deck. Uses `Uint8Array`-safe cloning (not `JSON.parse/stringify`).

---

## `remove-slide` — Delete slides

```bash
openfig remove-slide input.deck -o output.deck \
  --slide 1:1769 \
  --slide 1:1732
```

Marks slides and their child instances as `REMOVED`. Repeat `--slide` for multiple. Nodes are never deleted from the array — Figma requires them to remain with `phase: 'REMOVED'`.

---

## `roundtrip` — Validate the pipeline

```bash
openfig roundtrip input.deck -o output.deck
```

Decodes and re-encodes with zero changes. If Figma opens the output, your pipeline is sound. Prints node/slide/blob counts.
