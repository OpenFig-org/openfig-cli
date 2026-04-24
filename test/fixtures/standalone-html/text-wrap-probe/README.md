# text-wrap-probe fixture

Synthetic repro for the Chromium-vs-Figma wrap-point divergence tracked
in `openspec/changes/fix-html-converter-figma-fidelity/` (Phase 2).

## **Known overflow — expected and intentional**

**The 24 px and 32 px slides overflow the authored 1920×1080 section.**
This is by design and is the whole point of the probe: the columns are
deliberately over-packed so every paragraph wraps enough times to
surface any Chromium-vs-Figma wrap-point divergence. Trimming the
content would destroy the probe's diagnostic value.

### How the overflow was verified

Opening `text-wrap-probe.html` via `file://` in Chrome (with Google
Fonts Inter loading over the network, i.e. the *real* Inter — not a
system fallback) shows the same overflow: paragraphs run past the
bottom of the 1080 px `<section>` at the 24 px and 32 px sizes. So
this is a fixture-authoring choice baked into the HTML, **not** a
converter bug and **not** a font-metric rounding artifact.
`convert-html` faithfully emits what the DOM contains, including the
overflowing run.

### What a regression would look like

When comparing probe output before/after a converter change, compare:

- **Wrap count per paragraph** — should match between Chromium
  (browser render) and Figma (post-`convert-html` deck render) within
  ±0 lines on the 16 px slide and within the tolerance documented in
  Phase 2 for the 24 px / 32 px slides.
- **Line-break positions inside each wrapped paragraph** — a shift in
  which word starts a new line indicates Chromium-vs-Figma metric
  divergence.
- **Total rendered height of each column** — a change of more than one
  line-height across the whole column is a regression signal.

A regression is **not** "the slide overflows"; the slide is *supposed*
to overflow. A regression is "the wrap points inside the overflowing
text have moved."

## What this is

Three slides, each a two-column flex layout with four paragraphs per
column, rendered at Inter 24 px / 16 px / 32 px. Each paragraph opens
with a styled bold label so the run structure matches the real-world
cases where the bug has shown up.

The fixture is committed so every contributor can reproduce the same
convert-html output without needing access to any private deck. It is
deliberately content-free: no client names, no real UXR material.

## Regenerate

```
node build-fixture.mjs
```

Regenerate after editing paragraphs, font size, column widths, or the
font source. The generator writes `text-wrap-probe.html` in this
directory.

## Swapping the Inter source

Phase 2 compares Chromium's wrap points across three Inter candidates:

1. **Google Fonts CSS2 Inter WOFF2** — the default. See `FONT_CSS` at the
   top of `build-fixture.mjs`.
2. **Rasmus Andersson's official Inter release** — replace `FONT_CSS`
   with an `@font-face` block pointing at a local or CDN copy of the
   static or variable WOFF2.
3. **Claude Design's bundled Inter** — copy the relevant `@font-face`
   block from a real Claude Design standalone HTML export (anywhere in
   this repo's committed fixtures will do) and replace `FONT_CSS` with
   that block.

After each swap, regenerate and re-run convert-html to observe wrap
points.

## Running the probe

```
node bin/cli.mjs convert-html \
    test/fixtures/standalone-html/text-wrap-probe/text-wrap-probe.html \
    -o /tmp/probe.deck
```

Open `/tmp/probe.deck` in Figma, paste the same paragraphs into a fresh
Figma deck at the same widths as a control, and compare wrap points.

When `convert-html --dry-run` lands (Phase 2 task 2.2), run with that
flag instead — it writes the intermediate manifest without emitting a
`.deck`, and the per-paragraph `height` values directly reveal Chromium's
wrap counts for side-by-side inspection.
