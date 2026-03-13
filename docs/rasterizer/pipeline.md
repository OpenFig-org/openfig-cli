# Rendering Pipeline

## SVG Generation (svg-builder.mjs)

### Node Type Dispatch

Each Figma node type maps to a render function. Unknown types emit a magenta
dashed placeholder so renders never crash.

| Node Type | Renderer | Description |
|-----------|----------|-------------|
| `ROUNDED_RECTANGLE` | `renderRect` | Fill, stroke, cornerRadius |
| `RECTANGLE` | `renderRect` | Same as ROUNDED_RECTANGLE |
| `SHAPE_WITH_TEXT` | `renderShapeWithText` | Pill/badge with embedded text |
| `ELLIPSE` | `renderEllipse` | Fill, stroke, cx/cy/rx/ry |
| `TEXT` | `renderText` | Full typography pipeline |
| `FRAME` | `renderFrame` | Container with fill/stroke/image, clips children |
| `GROUP` | `renderGroup` | Transform wrapper, recurses children |
| `SECTION` | `renderGroup` | Same as GROUP |
| `BOOLEAN_OPERATION` | `renderGroup` | Same as GROUP |
| `LINE` | `renderLine` | Uses full transform matrix for direction |
| `VECTOR` | `renderVector` | Fill/stroke geometry decoding, per-path fills |
| `INSTANCE` | `renderInstance` | Symbol resolution + overrides + scaling |
| `STAR` | placeholder | Not yet implemented |
| `POLYGON` | placeholder | Not yet implemented |

### Position, Size, and Transforms

All nodes use the same pattern:

- **Position**: `transform.m02` (x), `transform.m12` (y) — relative to parent
- **Size**: `size.x` (width), `size.y` (height)
- **LINE** is special: uses full transform matrix `(m00, m10)` for direction vector

#### Full Affine Transforms

FRAME, GROUP, and INSTANCE nodes can be rotated and scaled, not just translated.
The `svgTransform(node)` helper reads the full 2×3 affine matrix and emits either
`translate(x,y)` for pure translations or `matrix(m00,m10,m01,m11,m02,m12)` when
rotation/scale is present.

**Precision matters**: Rotation/scale components use 6 decimal places (`toFixed(6)`).
At 2dp, a 2% error on a 2000px element produces ~8px visual shift. Translation
components use 2dp since they're absolute pixel offsets.

```javascript
// Pure translation: translate(50,989)
// Rotated: matrix(0.986048,0.166459,-0.166459,0.986048,71.07,-271)
```

#### Node Opacity

Any node with `opacity < 1` is wrapped in `<g opacity="...">` by `renderNode()`.
This applies to the entire subtree, so a FRAME at 0.15 opacity makes all its
children (vectors, text, etc.) 15% transparent as a group.

### Color Resolution

Fill colors are resolved through a priority chain:

1. `node.fillPaints[]` — direct fills on the node
2. `node.nodeGenerationData.overrides[0].fillPaints` — for SHAPE_WITH_TEXT
3. Only `SOLID` type fills with `visible !== false` are used
4. Color format: `{ r, g, b, a }` where channels are 0-1 floats

## Text Rendering

Text is the most complex part of the pipeline. There are three paths, chosen
based on available data:

### Path 1: Mixed-style (glyph-level positioning)

**Used when**: `derivedTextData.baselines` + `derivedTextData.glyphs` +
`textData.characterStyleIDs` are all present.

This handles text with multiple fonts, weights, or decorations in a single node.

1. For each baseline (line of text):
   - Filter glyphs belonging to this line
   - Group consecutive glyphs by `characterStyleIDs[charIndex]`
   - Emit one `<tspan>` per run with per-run `font-family`, `font-weight`, `font-style`
2. Each glyph has an absolute `position.x/y` — no line-height guessing needed

Style overrides come from `textData.styleOverrideTable`:

```javascript
styleOverrideTable: [
  { styleID: 1, fontName: { family: 'Inter', style: 'Bold' } },
  { styleID: 2, textDecoration: 'UNDERLINE' },
]
```

A `characterStyleIDs` value of `0` means "use the base node style". Non-zero
values reference `styleID` entries in the table.

**Important**: Only override font properties from `styleOverrideTable` if the
entry has an explicit `fontName` — otherwise fall through to the node's base
`fontName`. This prevents decorations-only overrides from resetting font properties.

### Path 2: Uniform style (baseline positioning)

**Used when**: `derivedTextData.baselines` exists but glyphs/styleIDs don't.

One `<tspan>` per baseline with absolute `x/y` from `baseline.position`.

### Path 3: Fallback (line-height calculation)

**Used when**: No `derivedTextData` at all.

Splits `characters` on `\n`, uses `dy` with computed line height. Line height
resolution: `RAW` = multiplier, `PERCENT` = percentage, `PIXELS` = absolute.

## derivedTextData — Key Fields

Figma pre-computes layout data and stores it in the deck. This is authoritative —
use it instead of computing from font metrics.

### baselines

```javascript
baselines: [
  {
    firstCharacter: 0,     // char index of line start
    endCharacter: 15,      // char index of line end (exclusive)
    position: { x: 0, y: 91.6 },  // absolute position relative to node
    width: 632.98,         // rendered width of this line
    lineHeight: 115.2,     // total line height
    lineAscent: 91.636,    // ascent from baseline position
  },
  // ...
]
```

### glyphs

```javascript
glyphs: [
  {
    firstCharacter: 0,     // char index this glyph represents
    position: { x: 0, y: 91.6 },  // absolute glyph position
    fontSize: 96,          // font size for this glyph
  },
  // ...
]
```

### decorations

Figma pre-computes exact underline/strikethrough rectangles. These are the
**authoritative** decoration positions — do not compute from font metrics.

```javascript
decorations: [
  {
    rects: [
      { x: 0, y: 226.09, w: 632.98, h: 6.55 },  // relative to node top-left
    ],
    styleID: 6,  // references styleOverrideTable entry
  },
]
```

The rasterizer draws these as explicit `<rect>` elements after the `<text>`
element, giving pixel-perfect underline placement for any font.

**Why not SVG `text-decoration`?** resvg uses the font's `post.underlinePosition`
table, which varies between fonts and versions. Figma computes its own positions.
Manual `<rect>` elements match Figma exactly.

### fontMetaData

```javascript
fontMetaData: [
  {
    key: { family: 'Inter', style: 'Bold' },
    fontWeight: 700,
    fontDigest: Uint8Array(20),  // SHA-1 hash of the font binary Figma used
  },
]
```

`fontWeight` from here is used as the authoritative weight (overrides parsing
the style string).

## SHAPE_WITH_TEXT Nodes

Pill/badge nodes store shape and text in `nodeGenerationData.overrides`:

- `overrides[0]` — shape: `fillPaints`, `strokePaints`, `strokeWeight`, `cornerRadius`
- `overrides[1]` — text: `textData.characters`, `fontName`, `fontSize`, `textCase`

Text positioning comes from `derivedImmutableFrameData.overrides[]` — find the
entry with `derivedTextData` and use its `transform` for the text box offset.

**Important**: `derivedImmutableFrameData` values are authoritative.
`nodeGenerationData` can contain stale/wrong values for font properties.

## Image Fills

FRAME nodes can have `IMAGE` type fills. Supported scale modes:

| Mode | SVG | Description |
|------|-----|-------------|
| `FILL` | `preserveAspectRatio="xMidYMid slice"` | Cover (crop to fill) |
| `FIT` | `preserveAspectRatio="xMidYMid meet"` | Contain (fit within bounds) |
| `TILE` | `<pattern>` element | Repeat at `scale * originalImageWidth/Height` |

Images are read from `deck.imagesDir` by SHA-1 hash name, base64-encoded inline
as data URIs.

## Letter Spacing

- `PERCENT`: `(value / 100) * fontSize` in pixels
- `PIXELS`: direct pixel value
- Applied as SVG `letter-spacing` attribute on the `<text>` element
- In glyph path: each run already starts at the correct absolute position
  (accounting for letter spacing), so the attribute only affects intra-run spacing

## VECTOR Nodes

VECTOR nodes contain paths stored as pre-computed binary blobs. The renderer
decodes these and emits SVG `<path>` elements.

### Fill Geometry

`node.fillGeometry[]` — array of filled path entries:

```javascript
{
  commandsBlob: 522,       // index into deck.message.blobs[]
  windingRule: 'NONZERO',  // or 'EVENODD'
  styleID: 2,              // optional — per-path fill override
}
```

Each blob encodes path commands as `[cmdByte][float32LE params...]`:

| Byte | Command | Params |
|------|---------|--------|
| 0x01 | moveTo  | x, y (2×f32) |
| 0x02 | lineTo  | x, y (2×f32) |
| 0x04 | cubicTo | c1x, c1y, c2x, c2y, x, y (6×f32) |
| 0x00 | close   | none |

Coordinates are in node-size space. The full affine transform matrix positions
the vector in the slide.

### Per-Path Fills (styleOverrideTable)

A single VECTOR node can have different fill colors on different sub-paths (e.g.
a coat-of-arms with red and white regions). This is stored as:

1. `fillGeometry[].styleID` — references a style in the override table
2. `node.vectorData.styleOverrideTable[]` — maps `styleID` to per-path `fillPaints`

```javascript
styleOverrideTable: [
  { styleID: 1, fillPaints: [] },                    // no fill (transparent)
  { styleID: 2, fillPaints: [{ type: 'SOLID',        // white override
      color: { r: 1, g: 1, b: 1 }, opacity: 1 }] },
  { styleID: 3, ... },                               // stroke-only props
]
```

- `styleID: 0` (or absent) → use node-level `fillPaints`
- `styleID` matching a table entry → use that entry's `fillPaints`
- Empty `fillPaints: []` → no fill for that path

The renderer groups paths by effective fill color and emits one `<path>` per
color group. Figma shows this as "Click + to replace mixed content" in the
Fill inspector.

### Stroke Geometry

`node.strokeGeometry[]` — pre-expanded stroke outlines, same blob format as
fillGeometry. These are rendered as filled `<path>` elements (not SVG strokes),
since Figma pre-computes the stroke outline shapes.

For stroke-only vectors (no fillPaints, only strokePaints), the stroke geometry
paths are filled with the stroke color.

### VNB Fallback

When neither `fillGeometry` nor `strokeGeometry` exists, the renderer falls back
to decoding `vectorData.vectorNetworkBlob` — a binary format storing vertices,
bezier segments, and regions. See `memory/reference_vnb_format.md` for the full
binary layout.

## INSTANCE Nodes (Symbol Resolution)

INSTANCE nodes reference a SYMBOL definition and optionally override child
properties (text, fills). This pattern is used for template-based slides —
simple slides with direct content have no INSTANCE node.

### 1. Symbol Resolution

The INSTANCE's `symbolData.symbolID` maps to a SYMBOL node. The SYMBOL's
children define the visual content.

### 2. Override Application

`symbolData.symbolOverrides[]` modify specific children:

```javascript
symbolOverrides: [
  { guidPath: { guids: [{ sessionID: 100, localID: 656 }] },
    textData: { characters: 'Override text' } },
  { guidPath: { guids: [...] },
    fillPaints: [{ type: 'SOLID', color: { r: 1, g: 0, b: 0 } }] },
]
```

**Override key mapping**: Override GUIDs may use library-original IDs (e.g.
`100:656`) rather than local node IDs (e.g. `1:1131`). Nodes expose their
library-original ID via `overrideKey`. The renderer builds a recursive
`overrideKey → local node` map for cross-ID resolution.

### 3. Derived Symbol Data

`node.derivedSymbolData[]` contains Figma-computed layout (size, transform,
derivedTextData) for children as they appear in this specific INSTANCE.

**This data is critical for correct rendering.** Without it:
- SYMBOL children render at their original size, not scaled to INSTANCE dimensions
- Text glyphs use wrong positions, causing misalignment
- Auto-layout resizing is lost

The derivedSymbolData entries are keyed by `guidPath.guids` — a path from the
SYMBOL root to each descendant node. Each entry provides:

- **Auto-layout symbols** (`symbol.stackMode` is set): Apply per-node
  `size` + `transform` from derivedSymbolData. Skip global scale.
- **Non-auto-layout symbols**: Apply only `derivedTextData` (glyph re-layout).
  Use global scale for positioning.

### 4. Scaling

When INSTANCE dimensions differ from SYMBOL dimensions and it's NOT auto-layout,
the entire content is wrapped in `<g transform="scale(sx,sy)">`.

### 5. Stroke Rendering

INSTANCE nodes may have their own `strokeGeometry` (pre-computed for instance
dimensions). For `borderStrokeWeightsIndependent` strokes with INSIDE alignment:
- The stroke geometry extends ±N px outside the frame edge (symmetric expansion)
- A `<clipPath>` matching the instance bounds clips to show only the inside portion

```svg
<clipPath id="stroke-clip-1"><rect width="1820" height="56"/></clipPath>
<path d="..." fill="#8f2727" clip-path="url(#stroke-clip-1)"/>
```

## PNG Rendering (deck-rasterizer.mjs)

### Scale Options

```javascript
svgToPng(svg, { scale: 0.5 });  // 960x540
svgToPng(svg, { width: 800 });  // fit to width, preserve aspect ratio
svgToPng(svg, { height: 400 }); // fit to height, preserve aspect ratio
```

Native resolution is 1920x1080. The renderer never upscales beyond native.

### WASM Initialization

`@resvg/resvg-wasm` is initialized lazily on first render call. The WASM binary
is loaded synchronously from `node_modules`. Initialization happens once per
process — subsequent calls reuse the initialized instance.

System fonts are disabled (`loadSystemFonts: false`). Only explicitly registered
font buffers are available, ensuring reproducible renders across machines.
