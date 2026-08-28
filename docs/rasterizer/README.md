# Rasterizer

Render Figma Slides `.deck` files to PNG images without Figma.

## Architecture

```
FigDeck  →  slideToSvg()  →  SVG string  →  svgToPng()  →  PNG bytes
             svg-builder.mjs                  deck-rasterizer.mjs
                                              (resvg-wasm)
```

1. **svg-builder.mjs** — Walks the slide's node tree, dispatching each node type
   to a renderer that emits SVG elements. Uses Figma's `derivedTextData` for
   exact glyph positions, baseline offsets, and decoration rectangles.

2. **deck-rasterizer.mjs** — Loads fonts, initializes resvg-wasm once per process,
   and converts SVG strings to PNG bytes. Exposes `svgToPng()`, `renderDeck()`,
   `registerFont()`, and `registerFontDir()`.

## Documents

| Document | Description |
|----------|-------------|
| [fonts.md](fonts.md) | Font loading, automatic resolution (Google Fonts + system fallback), Inter v3 vs v4, nameID patching, TTC support |
| [pipeline.md](pipeline.md) | SVG generation pipeline, node type dispatch, derivedTextData fields |
| [testing.md](testing.md) | SSIM quality testing, reference decks, HTML comparison reports |

## Pixel Parity

To the human eye, OpenFig renders look identical to Figma's native exports. You
would not be able to spot the difference without advanced diff tooling — the
differences live entirely in subpixel territory, at the edges of shapes and
characters where anti-aliasing blends foreground into background.

Bit-for-bit pixel parity is not achievable because Figma and OpenFig use
different rendering engines under the hood. Figma renders via Skia (Google's 2D
engine); OpenFig renders via resvg (Rust, built on tiny-skia). Even given
identical geometry and identical fonts, the two engines make different subpixel
coverage decisions at every anti-aliased edge. This is inherent to having two
independent rasterizers — the same reason two browsers never render the same
CSS identically at the pixel level.

On well-supported content we consistently reach SSIM ≥ 0.99 (Structural
Similarity Index), the standard threshold for "perceptually identical." The
remaining sub-1% delta is rasterizer noise that no human can see.

## Quick Start

```javascript
import { FigDeck } from 'openfig-cli/deck';
import { nid } from 'openfig-cli/node-helpers';
import { frameToSvg, svgToPng } from 'openfig-cli/rasterizer';

const fig = await FigDeck.fromDeckFile('design.fig');
const page = fig.getPages()[0];
const frame = fig.getChildren(nid(page))
  .find(node => node.type === 'FRAME');

const svg = frameToSvg(fig, frame);
const png = await svgToPng(svg, { scale: 1 });
writeFileSync('frame.svg', svg);
writeFileSync('frame.png', png);
```

`openfig-cli/rasterizer` is the supported package boundary for frame SVG and
PNG export. Internal files under `lib/rasterizer/` are not public entry points.
