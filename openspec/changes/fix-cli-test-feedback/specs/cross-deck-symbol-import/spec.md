# Cross-deck symbol import

## ADDED Requirements

### REQ-1: importSymbols copies symbols between decks

A new method `deck.importSymbols(sourceDeck, symbolIds)` copies SYMBOL nodes and their full subtrees from one FigDeck into another, handling ID remapping and blob index collision avoidance.

#### Scenario: Import a single symbol from a design file
- **Given** a source .fig/.deck with SYMBOL "Header Layout" containing text and image nodes
- **And** a target deck
- **When** `target.importSymbols(source, ['1:500'])`
- **Then** the symbol and all descendants exist in the target deck
- **And** all GUIDs are remapped to avoid collisions with existing target nodes
- **And** blob indices referenced by the symbol are remapped and copied
- **And** the symbol is parented under the Internal Only Canvas

#### Scenario: Import multiple symbols
- **Given** a source with symbols A, B, C where B contains a nested INSTANCE of A
- **When** `target.importSymbols(source, [idA, idB])`
- **Then** both symbols are imported
- **And** B's nested INSTANCE still references A (via remapped ID)

#### Scenario: Import symbol that already exists
- **Given** a target deck already containing a symbol with the same componentKey
- **When** `importSymbols` is called with that symbol
- **Then** the existing symbol is returned without creating a duplicate
