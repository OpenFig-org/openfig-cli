# Fix addSlide for blank template

## MODIFIED Requirements

### REQ-1: addSlideFromTemplate handles FRAME-only slides

When a template SLIDE has no INSTANCE child (only a FRAME), `addSlideFromTemplate()` must construct a bare SLIDE node directly instead of throwing. The blank-template.deck's starter slide uses this structure.

#### Scenario: Create deck and add slide from blank template
- **Given** a deck created via `Deck.create()`
- **When** `addSlideFromTemplate()` is called with the blank template's starter slide
- **Then** a new SLIDE is created successfully without throwing
- **And** the new slide is visible in `deck.getActiveSlides()`

#### Scenario: Create deck and add slide from symbol-backed template
- **Given** a deck with SYMBOL-backed template slides (INSTANCE children)
- **When** `addSlideFromTemplate()` is called
- **Then** existing behavior is preserved — INSTANCE is cloned with symbolData

### REQ-2: addBlankSlide works after Deck.create()

`Deck.addBlankSlide()` must work as the first operation after `Deck.create()`.

#### Scenario: Minimal deck creation
- **Given** `const deck = await Deck.create('Test')`
- **When** `const slide = deck.addBlankSlide()`
- **Then** slide is returned with setBackground, addText, addImage methods available
- **And** `deck.save()` produces a valid .deck file
