## ADDED Requirements

### Requirement: Draft Template Authoring

The system SHALL support authoring draft templates as standard slide decks on the main presentation canvas without requiring `MODULE` nodes.

#### Scenario: Create a new draft template

- **WHEN** a user creates a new draft template from scratch
- **THEN** the resulting `.deck` uses normal slide-deck structure on the main canvas
- **AND** no `MODULE` node is required for the draft to be considered a valid template draft
- **AND** internal style and variable assets are preserved on the internal canvas

### Requirement: Multi-Row Template Layout Discovery

The system SHALL discover template layouts across every main-canvas `SLIDE_ROW`, rather than only the first slide row.

#### Scenario: Discover layouts in a multi-row official template

- **WHEN** a template contains layouts spread across multiple `SLIDE_ROW` nodes on the main presentation canvas
- **THEN** every layout on those rows is included in the layout catalog
- **AND** layouts on `Internal Only Canvas` are not treated as primary instantiable layouts unless explicitly requested

#### Scenario: Discover layouts in a draft template

- **WHEN** a draft template contains slides directly under `SLIDE_ROW` nodes without `MODULE` wrappers
- **THEN** those slides are discoverable as draft layouts

### Requirement: Explicit Slot Metadata

The system SHALL support explicit slot metadata so editable text and image placeholders can be distinguished from decorative content.

#### Scenario: Explicit text slot naming

- **WHEN** a text node is marked with the `slot:text:` naming convention
- **THEN** template discovery reports it as an editable text slot
- **AND** the reported slot name excludes the `slot:text:` prefix

#### Scenario: Explicit image slot naming

- **WHEN** an image-bearing node is marked with the `slot:image:` naming convention
- **THEN** template discovery reports it as an editable image slot
- **AND** the reported slot name excludes the `slot:image:` prefix

#### Scenario: Decorative image content is not treated as a slot

- **WHEN** an image-bearing node is marked as fixed content or left unmarked in a template that contains explicit slot metadata
- **THEN** template discovery does not promote that node to an editable slot solely because it has an image fill

### Requirement: Publish-Like Template Wrapping

The system SHALL support a publish-like transform that converts a draft template layout into a module-backed published-template layout while preserving the slide subtree.

#### Scenario: Wrap a draft slide in a publishable module

- **WHEN** a draft template slide is publish-wrapped
- **THEN** a publishable `MODULE` node is inserted above the slide
- **AND** the existing slide subtree remains intact beneath the module
- **AND** the internal style and variable assets remain present after the transform

### Requirement: Template Instantiation Preserves Layout Structure

The system SHALL instantiate published or publish-like module-backed template layouts by cloning their module-backed structure without flattening or regenerating unsupported nodes.

#### Scenario: Instantiate a module-backed layout

- **WHEN** a user instantiates a published or publish-like template layout
- **THEN** the new deck preserves the `MODULE -> SLIDE -> node subtree` structure of the source layout
- **AND** the instantiated layout remains compatible with later text and image population

#### Scenario: Instantiate a layout with special nodes

- **WHEN** a layout contains unsupported-but-known nodes such as device frames, vector masks, or interactive slide elements
- **THEN** those nodes are preserved during instantiation
- **AND** the system does not drop or regenerate them during cloning

### Requirement: Internal Canvas Preservation

The system SHALL preserve `Internal Only Canvas` assets throughout draft authoring, publish-like wrapping, and template instantiation workflows.

#### Scenario: Keep internal styles during template transformations

- **WHEN** a draft template is wrapped or a published template is instantiated
- **THEN** internal canvases, style definitions, and variable sets remain in the output deck
