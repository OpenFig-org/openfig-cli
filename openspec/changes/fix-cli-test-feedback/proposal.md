# fix-cli-test-feedback

## Summary

Fix four issues discovered during a real-world deck-building session. The issues range from a blocking bug (#1) to documentation gaps (#4), ordered by impact.

## Motivation

A test agent built an 18-slide research presentation and encountered these issues:

1. **`Deck.create()` + `addSlide()` throws** — The most natural API usage pattern is broken. `blank-template.deck` has a FRAME child on its starter SLIDE, but `addSlide()` expects an INSTANCE. This means the high-level API's `addSlideFromTemplate()` cannot use the blank template's own slide as a source.

2. **No cross-deck symbol import** — Building presentations from design files requires manually walking subtrees, collecting blob indices, remapping to avoid collisions, and re-homing symbols. This is error-prone and should be a single API call.

3. **Color variable resolution gap** — Text nodes with `colorVar` bindings may store a raw color that differs from what Figma resolves. When the raw color matches the background, text becomes invisible in exports with no warning.

4. **`.fig` format support undocumented** — `FigDeck.fromDeckFile()` works on `.fig` ZIP archives (same format as `.deck`), but this is never mentioned. Users don't know they can use openfig on Figma Design exports.

## Scope

- **In scope**: Fix the addSlide bug, add `importSymbols()` API, add color contrast validation, document .fig support
- **Out of scope**: Full color variable resolution engine, Figma API integration

## Capabilities

| Capability | Priority | Spec |
|-----------|----------|------|
| Fix addSlide for blank template | P0 — blocking bug | `specs/fix-addslide-bug/spec.md` |
| Cross-deck symbol import | P1 — missing API | `specs/cross-deck-symbol-import/spec.md` |
| Color contrast validation | P2 — quality | `specs/color-contrast-validation/spec.md` |
| Document .fig format support | P3 — docs | `specs/fig-format-docs/spec.md` |

## Status

`proposal` — awaiting approval
