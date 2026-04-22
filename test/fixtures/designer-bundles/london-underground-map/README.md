# Handoff: London Underground Map — Figma .deck

## Overview

Convert this HTML/CSS slide deck (12 slides, 1920×1080) into a Figma `.deck` file using **openfig-cli**. The HTML files in this bundle are **design references** — they show the exact intended look. Your task is to recreate each slide as a native Figma frame and save the result as a `.deck`.

## About the Design Files

The files here are **high-fidelity HTML/CSS prototypes** — the authoritative visual specification. Do not ship the HTML; use it as a pixel-accurate reference to build native Figma frames via openfig-cli.

- `London Underground Map.html` — the full interactive deck (open in a browser to see each slide)
- `deck-stage.js` — the deck shell component (handles navigation/scaling; not needed for .deck output)
- `media/` — all image assets referenced by the slides
- `manifest.json` — structured per-slide data (elements, positions, colors, typography, speaker notes)

## Fidelity

**High-fidelity.** Recreate each slide pixel-perfectly at 1920×1080px. All colors, font sizes, spacing, and layout values are exact — read them from the HTML/CSS source and `manifest.json`.

---

## Design Tokens

### Canvas
- **Slide size:** 1920 × 1080 px (16:9)
- **Safe margin:** 86px left/right, 72px top

### Colors
| Token | Hex | Usage |
|---|---|---|
| navy | `#0B1B33` | Primary dark bg, body text |
| red | `#DC241F` | Accents, Central line |
| white | `#FFFFFF` | Light slide bg |
| cream | `#F5F1E8` | Secondary bg (slides 4, 9) |
| lightBlue | `#C9D4E8` | Subtitle on dark |
| mutedBlue | `#5A6B82` | Secondary body text |
| darkBlue | `#1C3F95` | "FROM 1933" label |
| tflRed | `#E32017` | Central line card accent |
| tflBlue | `#003688` | Piccadilly line card accent |
| tflGreen | `#00782A` | District line card accent |
| tflBrown | `#B36305` | Bakerloo line card accent |
| tflGrey | `#A0A5A9` | Jubilee line |
| tflCyan | `#0098D4` | Victoria line card accent |
| hammersmith | `#9B0056` | 1931 timeline step |

### Typography
| Role | Font | Weight | Notes |
|---|---|---|---|
| Display titles | EB Garamond | 700 | Also italic 400 for subtitles/quotes |
| Body / UI | Calibri | 400/600/700 | Fallback: Gill Sans, Arial |
| Monospace (badge) | ui-monospace | 600 | SF Mono → Menlo → Consolas |

### Font sizes (px at 1920×1080)
| Usage | Size |
|---|---|
| Hero title (LONDON) | 136px |
| Section title (UNDERGROUND MAP) | 72px |
| Slide title | 56–64px |
| Column head | 44px |
| Large body / body1 | 28–32px |
| Body | 24–26px |
| Labels / captions | 24px |
| Micro type | 22px |

---

## Slides

Read `manifest.json` for full per-element positions and values. Below is a narrative summary of each slide's layout intention.

### Slide 1 — Title (bg: `#0B1B33`)
Centered layout. Underground roundel SVG top-center-right. Three stacked text lines: italic subtitle, bold "LONDON" (136px, letter-spacing 12px), bold "UNDERGROUND MAP" (72px). Byline with mixed color runs: white "HARRY BECK", red "·", muted "1933". Footer italic caption. OpenFig monospace badge bottom-right.

### Slide 2 — Geographic vs Diagrammatic (bg: `#FFFFFF`)
Two-column layout split at x=960 by a 2px `#E8EAEE` divider. Title + italic subtitle across full width. Each column: coloured era label (red left / dark-blue right), bold serif head, body paragraphs, bullet list.

### Slide 3 — The Electrical Circuit (bg: `#FFFFFF`)
Left panel (0–1080px): slide number, large title, two body text blocks. Right panel (1080–1920px): full-bleed `image-3-1.jpg` (object-fit: cover).

### Slide 4 — Four Principles (bg: `#F5F1E8`)
Title + italic subtitle. 2×2 grid of white cards (`#FFFFFF`, 1px `#E8EAEE` border). Each card has a 12px coloured left-edge bar, numbered label, serif title, body text. Top-left=red, top-right=dark-blue, bottom-left=cyan, bottom-right=brown.

### Slide 5 — The Diagram, Reduced (bg: `#0B1B33`)
Left half: full-bleed `image-5-1.jpg` (0–840px). Right half: small all-caps pink label, large bold serif title, italic body.

### Slide 6 — Pocket Maps Printed 1933 (bg: `#FFFFFF`)
Title + subtitle. SVG area/line chart below. X-axis: 8 weeks. Y-axis: 0–800k. Red dashed annotation at Week 4 "Reprint ordered". Navy fill area + line + dots. Italic footnote at bottom.

### Slide 7 — From Sketch to Standard (bg: `#FFFFFF`)
Title + subtitle. Horizontal timeline of 5 cards connected by grey right-arrows. Each card: solid-color header (year, white text), white body (serif event name, grey description). Colors: `#9B0056`, `#DC241F`, `#B36305`, `#00782A`, `#1C3F95`.

### Slide 8 — A Colour Per Line (bg: `#FFFFFF`)
Title + subtitle. Full-width data table. Header row: `#0B1B33` bg, white text. Alternating rows: white / `#F5F1E8`. Columns: Line | Swatch (colored rectangle) | Opened | Stations | Character.

### Slide 9 — Johnston Sans / Beck Quote (bg: `#F5F1E8`)
Left: `image-9-1.png` specimen (504×756px, object-fit: contain, white bg). Caption below. Right: large red decorative `"` (280px, 15% opacity). Large italic serif quote below. Red 80px rule. Attribution with bold name + muted date.

### Slide 10 — The Map Rewired London (bg: `#0B1B33`)
Small all-caps eyebrow "LEGACY". Large bold title. 80px red rule. Large italic quote (4 lines, `#DCE3F1`). Attribution (bold light, muted detail). 1px divider. Three-column fact row with red labels (`PREDECESSORS`, `USER-CENTRED`, `AFTER BECK`) and `#C9D4E8` body text.

### Slide 11 — A Viral Reimagining (bg: `#FFFFFF`)
Left panel (0–900px): slide number, title, italic subtitle, red "1M+" stat, stat label, two body paragraphs, blockquote with red left border, bold attribution. Right panel (920–1860px): SVG circles-and-spokes diagram (4 concentric grey circles, 6 coloured line spokes, yellow Circle Line ring, station dots).

### Slide 12 — Closing (bg: `#0B1B33`)
Four small roundel PNGs in a row (~x=593, y=187, gap=150px). Three stacked centred text lines: italic light-blue "Ninety-two years on,", bold white "the diagram remains", bold white "the Underground." Red 115px rule. All-caps white label "END OF FIXTURE". Muted italic caption.

---

## Speaker Notes

All 12 notes are in `manifest.json` under each slide's `speakerNotes` field. Attach them to the corresponding Figma frames when building the `.deck`.

---

## Assets

| File | Used on slide | Notes |
|---|---|---|
| `media/underground-roundel.svg` | 1 | Transparent bg SVG; renders on dark navy |
| `media/image-3-1.jpg` | 3 | District line train, Sloane Square; full-bleed right |
| `media/image-5-1.jpg` | 5 | Underground escalator; full-bleed left |
| `media/image-9-1.png` | 9 | Johnston Sans type specimen; object-fit contain |
| `media/image-10-1.png` | 12 | Central line roundel |
| `media/image-10-2.png` | 12 | Piccadilly line roundel |
| `media/image-10-3.png` | 12 | Victoria line roundel |
| `media/image-10-4.png` | 12 | Jubilee line roundel |

---

## Building with openfig-cli

```bash
npm install openfig-cli
```

1. Read `manifest.json` — every element's position, size, font, color, and content is specified there.
2. Open `London Underground Map.html` in a browser to visually verify each slide as you build.
3. Build each slide as a Figma frame at **1920×1080px**.
4. Attach speaker notes to each frame.
5. Save as `london-underground-map.deck`.

All coordinates in `manifest.json` use the same 1920×1080 space as the HTML source.

---

_OpenFig Demo Deck · openfig.org_
