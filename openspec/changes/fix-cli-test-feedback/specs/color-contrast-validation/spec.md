# Color contrast validation

## ADDED Requirements

### REQ-1: validate() warns on low-contrast text

`FigDeck.validate()` warns when a TEXT node's fill color luminance is within a threshold of its parent background, indicating potentially invisible text.

#### Scenario: White text on white background
- **Given** a slide with white background (#FFFFFF)
- **And** a TEXT node with fill color #FFFFFF or near-white
- **When** `deck.validate()` is called
- **Then** a warning is emitted: "TEXT node has low contrast against background"

#### Scenario: Text with colorVar binding
- **Given** a TEXT node with a `colorVar` binding
- **And** the raw stored color matches the parent background
- **When** `deck.validate()` is called
- **Then** a warning is emitted noting the colorVar may resolve differently in Figma

#### Scenario: Normal contrast text
- **Given** a TEXT node with dark text on light background
- **When** `deck.validate()` is called
- **Then** no contrast warning is emitted
