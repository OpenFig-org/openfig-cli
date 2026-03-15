# Tasks — fix-cli-test-feedback

## Task 1: Fix addSlide for blank template (P0)
- [ ] Modify `addSlideFromTemplate()` in `lib/slides/api.mjs` to handle SLIDE nodes with FRAME children (no INSTANCE)
- [ ] Ensure `addBlankSlide()` works as first operation after `Deck.create()`
- [ ] Test: `Deck.create()` → `addBlankSlide()` → `addText()` → `save()` produces valid .deck
- **Files**: `lib/slides/api.mjs`, `lib/slides/blank-template.deck`
- **Depends on**: nothing
- **Parallelizable**: yes

## Task 2: Add importSymbols API (P1)
- [ ] Add `importSymbols(sourceDeck, symbolIds)` to `FigDeck` or as a utility in `template-deck.mjs`
- [ ] Handle GUID remapping for all descendants
- [ ] Handle blob index remapping and copying
- [ ] Re-home imported symbols under Internal Only Canvas
- [ ] Deduplicate by componentKey
- [ ] Test: import symbol from .fig into blank deck, verify structure
- **Files**: `lib/core/fig-deck.mjs` or `lib/slides/template-deck.mjs`
- **Depends on**: nothing
- **Parallelizable**: yes (independent of Task 1)

## Task 3: Color contrast validation (P2)
- [ ] Add contrast check to `FigDeck.validate()` in `lib/core/fig-deck.mjs`
- [ ] Compute relative luminance of TEXT fill vs parent slide background
- [ ] Warn when contrast ratio < 2:1
- [ ] Note when TEXT has colorVar binding (may resolve differently in Figma)
- [ ] Test: white-on-white produces warning, black-on-white does not
- **Files**: `lib/core/fig-deck.mjs`
- **Depends on**: nothing
- **Parallelizable**: yes

## Task 4: Document .fig support (P3)
- [ ] Add one-liner to README noting .fig support
- [ ] Update CLI help text in `bin/cli.mjs` to mention .fig alongside .deck
- [ ] Update skill SKILL.md to mention .fig
- **Files**: `README.md`, `bin/cli.mjs`, `.claude-plugin/skills/slides-creator/SKILL.md`
- **Depends on**: nothing
- **Parallelizable**: yes
