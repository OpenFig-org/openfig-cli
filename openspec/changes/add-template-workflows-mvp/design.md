## Context

Recent inspection of Figma Slides files established three related states:

1. Draft template
- Structure: `SLIDE_ROW -> SLIDE -> ...`
- No `MODULE` nodes
- Style and variable assets live on `Internal Only Canvas`
- Direct slide/frame/text nodes already carry `overrideKey` values

2. Published template
- Structure: `SLIDE_ROW -> MODULE -> SLIDE -> ...`
- The visible slide subtree is largely preserved
- A thin publishable `MODULE` wrapper is introduced
- Local publishable style assets are renamed/reversioned

3. Instantiated deck from template
- In the minimal observed case, structure matches the published template
- No `SYMBOL` or `INSTANCE` nodes were introduced
- The instantiated deck preserved the same module-backed layout shape

Official templates also revealed additional constraints:
- layouts can span many slide rows, not just the first row
- some templates include helper slides on `Internal Only Canvas`, some do not
- some image fills are true placeholders, others are decorative sample content
- special nodes such as device frames and `INTERACTIVE_SLIDE_ELEMENT` must be preserved even if the toolkit cannot synthesize them from scratch

## Goals / Non-Goals

- Goals:
  - Support authoring reusable draft templates from scratch
  - Support publish-like wrapping into module-backed layouts
  - Support reliable instantiation from published or publish-like templates
  - Support explicit layout and slot metadata discoverable from the `.deck` alone
  - Preserve internal style assets and unsupported nodes during transformations

- Non-Goals:
  - Reproduce Figma’s team/community publishing backend behavior
  - Infer all editable image slots from raw image fills without explicit markup
  - Synthesize unsupported node types such as interactive slide elements from scratch in the MVP
  - Solve public/private template visibility concerns at the file-format layer

## Decisions

- Decision: Model template workflows as two structural states, not one
  - Draft templates are plain slide decks
  - Published templates are module-backed decks
  - Instantiation in the MVP targets module-backed templates

- Decision: Layout discovery is main-canvas-wide, not first-row-only
  - All `SLIDE_ROW` nodes under the main `SLIDE_GRID` are scanned
  - `Internal Only Canvas` assets are preserved but not treated as primary instantiable layouts

- Decision: Slot metadata is explicit
  - The toolkit must not assume every image-filled node is editable
  - The MVP uses explicit naming conventions to distinguish editable slots from decorative content
  - Recommended conventions:
    - layout names: `layout:<name>`
    - text slots: `slot:text:<name>`
    - image slots: `slot:image:<name>`
    - decorative fixed content: `fixed:image:<name>` or unmarked

- Decision: Publish-like wrapping is thin
  - Wrapping a draft template inserts a publishable `MODULE` above each target slide
  - Existing slide/frame/text subtrees are preserved
  - `Internal Only Canvas` assets remain intact
  - Version/key bookkeeping beyond the observed minimal pattern is treated as implementation detail and validated empirically

- Decision: Unsupported/special nodes are preserved verbatim
  - Device frames, vector masks, and interactive slide elements are cloned and retained
  - The MVP does not require synthetic creation of those node types

## Risks / Trade-offs

- Risk: Figma publish may do more bookkeeping than the minimal observed diff
  - Mitigation: validate the publish-like transform against the captured before/after samples before relying on it broadly

- Risk: Naming-convention metadata could conflict with user-authored layer names
  - Mitigation: reserve explicit prefixes (`layout:`, `slot:`) and document them clearly

- Risk: Some official templates use helper slides or assets on `Internal Only Canvas`
  - Mitigation: treat the internal canvas as preserved support data and avoid deleting or regenerating it in the MVP

- Risk: Existing template discovery may over-detect editable image slots
  - Mitigation: explicit slot markup takes precedence over heuristic image-fill detection

## Migration Plan

1. Define the capability and conventions in OpenSpec
2. Update discovery to support draft and published template states
3. Add draft-template authoring helpers
4. Add publish-like wrapping helpers
5. Update MCP tools and skill guidance
6. Validate against captured draft/published/instantiated samples

## Open Questions

- Should unmarked image-filled nodes be treated as read-only by default, or remain heuristically discoverable as a fallback?
- Should publish-like wrapping operate on every visible draft slide or only slides explicitly marked as layouts?
- Should slot role metadata remain encoded only in node names for the MVP, or should a lightweight sidecar manifest be introduced later?
