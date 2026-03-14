# Testing

## SSIM Quality Testing

Render quality is measured using **SSIM** (Structural Similarity Index), a
perceptual similarity metric. Scores range 0-1 where 1 = identical.

### How it works

1. Render a slide to PNG at 1920x1080
2. Load the reference PNG (exported from Figma at 2x, 4000x2250)
3. Downscale reference to 1920x1080 via sharp
4. Compute SSIM between rendered and reference (both as raw RGBA buffers)
5. Assert score meets the per-slide threshold

### Reference Decks

| Deck | Slides | Purpose |
|------|--------|---------|
| `decks/reference/oil-machinations.deck` | 7 | Complex real-world deck: mixed fonts, shapes, images, SHAPE_WITH_TEXT |
| `decks/reference/just-fonts.deck` | 1 | Font rendering: Inter Bold, Regular, Italic, Bold Italic, Underline + Irish Grover |
| `decks/reference/svg-deck.deck` | 1 | VECTOR node rendering: coat-of-arms with fillGeometry/strokeGeometry |
| `decks/reference/4-text-column.deck` | 1 | 4 numbered columns + rotated seal backdrop (tests affine transforms, per-path fills, node opacity) |

Reference PNGs live alongside the deck in a same-named directory:

```
decks/reference/oil-machinations/
  page-1.png   ← Figma export, 1920x1080 (1x) or 4000x2250 (2x)
  page-2.png
  ...
decks/reference/just-fonts/
  page-1.png
decks/reference/4-text-column/
  page-1.png
```

### Quality Gates

All tests use the same three universal thresholds — no per-slide overrides:

| Metric | Threshold | What it catches |
|--------|-----------|-----------------|
| **SSIM** | ≥ 0.90 | Global perceptual similarity — missing/shifted content |
| **meanDelta** | ≤ 10.0 | Average per-pixel deviation (0–255) — severity SSIM downweights |
| **offDelta** | ≤ 130 | Mean severity among divergent pixels — anti-aliasing ≈ 20–90, shadow filters ≈ 100–130, missing content ≈ 150+ |

If any single metric fails, that's a real rendering problem — not rasterizer noise.

### Running Tests

```bash
npm test                    # all tests
npx vitest run render.test  # just the SSIM tests
```

Rendered PNGs are saved to `/tmp/figmatk-test-slide-N.png` for manual inspection.

## HTML Comparison Reports

For visual side-by-side comparison:

```bash
# Oil machinations (default)
node lib/rasterizer/render-report.mjs

# Just fonts
node lib/rasterizer/render-report.mjs \
  decks/reference/just-fonts.deck \
  decks/reference/just-fonts \
  /tmp/figmatk-render-report-just-fonts.html

# Custom deck
node lib/rasterizer/render-report.mjs path/to.deck path/to/refs/ /tmp/report.html
```

Reports show three columns per slide:

1. **Reference** — Figma export (ground truth)
2. **FigmaTK Render** — our SVG→PNG output
3. **Overlay** — pre-composited difference image: `ref * 0.5 + inverted_render * 0.5`

The overlay makes missing or mispositioned elements glow — any difference from
the reference stands out as a bright artifact on a mid-grey background. Identical
areas become uniform grey.

Three-tier badges: **PASS** (green, SSIM ≥ 0.99), **WARN** (orange, ≥ 0.90), **FAIL** (red, < 0.90).
All images are click-to-zoom for close-up inspection.

**Note**: Overlay PNGs are pre-rendered via sharp pixel-by-pixel compositing, not
CSS canvas compositing. This avoids `file://` CORS restrictions that prevent
`canvas.toDataURL()` from working on local HTML files.

Open in browser: `file:///tmp/figmatk-render-report.html`

## Adding a New Reference Deck

1. Create or obtain the deck in Figma
2. Export each page as PNG at 2x (4000x2250) from Figma
3. Save the `.deck` file to `decks/reference/`
4. Save the PNGs to `decks/reference/<deck-name>/page-N.png`
5. Add a test case in `render.test.mjs` with conservative initial thresholds
6. Run tests, note actual SSIM scores, adjust thresholds upward

## Known Limitations Affecting SSIM

- **Color variables** — unresolved; SHAPE_WITH_TEXT nodes on variable-colored
  backgrounds show wrong fill
