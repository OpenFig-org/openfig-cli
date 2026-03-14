# Implementation Status

## Summary

| Component      | Progress |
|----------------|----------|
| Format Docs    | 90%      |
| Parser         | 85%      |
| Rasterizer     | 70%      |

## Legend

| Symbol | Meaning                    |
|--------|---------------------------|
| ✅     | Implemented               |
| 🔶     | Partial / known gaps      |
| ❌     | Not yet implemented       |

---

## Format Documentation

Understanding the .deck and .fig binary format. See [format/](format/) for details.

### Node Types

| Type               | Documented | Notes                              |
|--------------------|------------|------------------------------------|
| DOCUMENT           | ✅         |                                    |
| CANVAS             | ✅         |                                    |
| SLIDE_GRID         | ✅         |                                    |
| SLIDE_ROW          | ✅         |                                    |
| SLIDE              | ✅         |                                    |
| MODULE             | ✅         | Published template wrapper         |
| INSTANCE           | ✅         | [overrides.md](format/overrides.md)|
| SYMBOL             | ✅         |                                    |
| FRAME              | ✅         | [shapes.md](format/shapes.md)      |
| TEXT               | ✅         | [text.md](format/text.md)          |
| VECTOR             | ✅         | [shapes.md](format/shapes.md)      |
| ROUNDED_RECTANGLE  | ✅         |                                    |
| SHAPE_WITH_TEXT    | ✅         |                                    |
| ELLIPSE            | ✅         |                                    |
| LINE               | ✅         |                                    |
| TABLE              | ✅         |                                    |
| GROUP              | ✅         |                                    |
| BOOLEAN_OPERATION  | 🔶         | Rendered as GROUP                  |
| STAR               | ❌         |                                    |
| POLYGON            | ❌         |                                    |

### Format Features

| Feature                    | Documented | Notes                              |
|----------------------------|------------|------------------------------------|
| Node hierarchy             | ✅         | [nodes.md](format/nodes.md)        |
| GUID system                | ✅         |                                    |
| ParentIndex / position     | ✅         |                                    |
| Phase (CREATED/REMOVED)    | ✅         |                                    |
| Fill paints                | ✅         |                                    |
| Stroke paints              | ✅         |                                    |
| Image fills                | ✅         | [images.md](format/images.md)      |
| Text overrides             | ✅         | [overrides.md](format/overrides.md)|
| Image overrides            | ✅         |                                    |
| derivedTextData            | ✅         |                                    |
| derivedSymbolData          | ✅         |                                    |
| overrideKey mapping        | ✅         |                                    |
| Auto-layout                | 🔶         | Documented, some edge cases        |
| Variable sets / colors     | ✅         | [colors.md](format/colors.md)      |

---

## Parser (Codec)

Reading and writing .deck and .fig files. See [library.md](library.md) for API.

### Core Codec

| Feature                | Read | Write | Notes                    |
|------------------------|------|-------|--------------------------|
| .deck (ZIP)            | ✅   | ✅    |                          |
| .fig (raw binary)      | ✅   | ❌    | Read-only for now        |
| Kiwi schema            | ✅   | ✅    |                          |
| zstd compression       | ✅   | ✅    |                          |
| Node tree traversal    | ✅   | ✅    |                          |
| Blob decoding          | ✅   | ✅    |                          |
| Image blob handling    | ✅   | ✅    |                          |

### High-Level API (Slides)

| Feature                | Status | Notes                    |
|------------------------|--------|--------------------------|
| Deck.open() / save()   | ✅     |                          |
| Slide access (1-index) | ✅     |                          |
| addText()              | ✅     |                          |
| addImage()             | ✅     |                          |
| addFrame()             | ✅     |                          |
| addShape() variants    | ✅     |                          |
| addTable()             | ✅     |                          |
| addSVG()               | ✅     |                          |
| Text formatting        | ✅     | Bold, italic, underline  |
| Fill / stroke          | ✅     |                          |
| Template instantiation | ✅     |                          |
| Symbol overrides       | ✅     |                          |

---

## Rasterizer

Converting nodes to images. SVG is used as an intermediate format. See [rasterizer/pipeline.md](rasterizer/pipeline.md).

### Node Rendering

| Type               | Rendered | Notes                              |
|--------------------|----------|------------------------------------|
| FRAME              | ✅       | Fill, stroke, image, clips children|
| TEXT               | ✅       | Per-glyph positioning              |
| VECTOR             | ✅       | Fill/stroke geometry, per-path fills|
| ROUNDED_RECTANGLE  | ✅       |                                    |
| SHAPE_WITH_TEXT    | ✅       |                                    |
| ELLIPSE            | ✅       |                                    |
| LINE               | ✅       | Full transform matrix              |
| TABLE              | 🔶      | Basic rendering                    |
| INSTANCE           | ✅       | Symbol resolution, scaling, overrides|
| SYMBOL             | ✅       | Via INSTANCE                       |
| GROUP              | ✅       | Transform wrapper                  |
| BOOLEAN_OPERATION  | ✅       | Rendered as GROUP                  |
| STAR               | ❌       |                                    |
| POLYGON            | ❌       |                                    |

### Rendering Features

| Feature                    | Status | Notes                              |
|----------------------------|--------|------------------------------------|
| Fill paints                | ✅     | SOLID type                         |
| Stroke paints              | ✅     | Pre-expanded geometry              |
| Image fills (FILL/FIT/TILE)| ✅     |                                    |
| Node opacity               | ✅     | Group-level                        |
| Affine transforms          | ✅     | Full matrix, 6dp precision         |
| Per-path vector fills      | ✅     | styleOverrideTable                 |
| derivedTextData            | ✅     | Baselines, glyphs, decorations     |
| derivedSymbolData          | ✅     | Auto-layout, scaling               |
| Font resolution            | ✅     | Google Fonts, TTC, system fallback |
| Underlines / strikethrough | ✅     | Explicit rects from Figma          |
| SSIM testing               | ✅     | Pixel comparison against reference |

### Output Formats

| Format | Status | Notes          |
|--------|--------|----------------|
| PNG    | ✅     | resvg-wasm     |
| JPG    | ❌     | Planned        |
| WEBP   | ❌     | Planned        |
| SVG    | 🔶     | Intermediate only |

---

## Product Support

| Product       | Extension | Parse | Modify | Rasterize |
|---------------|-----------|-------|--------|-----------|
| Figma Slides  | `.deck`   | ✅    | ✅     | ✅        |
| Figma Design  | `.fig`    | ✅    | ❌     | 🔶        |
| Figma Jam     | `.jam`    | ❌    | ❌     | ❌        |
| Figma Buzz    | `.buzz`   | ❌    | ❌     | ❌        |
| Figma Sites   | `.site`   | ❌    | ❌     | ❌        |
| Figma Make    | `.make`   | ❌    | ❌     | ❌        |

---

## Disclaimer

Figma is a trademark of Figma, Inc.

OpenFig is an independent open-source project and is not affiliated with, endorsed by, or sponsored by Figma, Inc.
