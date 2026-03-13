# Template Workflows

This page documents the reusable-template workflow implemented in the MCP server and the internal `lib/template-deck.mjs` helpers.

FigmaTK supports two related template states and one downstream instantiation flow.

## States

### Draft template

- Structure: `SLIDE_ROW -> SLIDE -> ...`
- No `MODULE` node required
- Internal styles and variables remain on `Internal Only Canvas`
- Best for authoring new layouts and naming slots

### Published or publish-like template

- Structure: `SLIDE_ROW -> MODULE -> SLIDE -> ...`
- The slide subtree stays intact under a thin publishable `MODULE`
- Internal canvases and special nodes are preserved
- Best for later instantiation

### Instantiated deck

- In the current observed Figma flow, instantiation preserves the published module-backed structure
- FigmaTK follows that model and clones `MODULE -> SLIDE -> subtree` layouts directly

## Naming Conventions

Use explicit names so editable slots are discoverable from the `.deck` alone.

- Layouts: `layout:<name>`
- Text slots: `slot:text:<name>`
- Image slots: `slot:image:<name>`
- Decorative or fixed sample imagery: `fixed:image:<name>`

Examples:

- `layout:cover`
- `slot:text:title`
- `slot:text:subtitle`
- `slot:image:hero_image`
- `fixed:image:brand_texture`

If a layout contains any explicit slot metadata, FigmaTK will only promote explicitly marked image slots as editable. Unmarked image fills stay decorative by default.

## Recommended MCP Flow

### Author a draft template

1. `figmatk_create_template_draft`
2. `figmatk_inspect` or `figmatk_list_template_layouts`
3. `figmatk_annotate_template_layout`
4. Repeat until the draft layout names and slots are stable

Example annotation payload:

```json
{
  "path": "/tmp/product-template.deck",
  "output": "/tmp/product-template-annotated.deck",
  "slideId": "1:42",
  "layoutName": "cover",
  "textSlots": {
    "1:120": "title",
    "1:121": "subtitle"
  },
  "imageSlots": {
    "1:144": "hero_image"
  },
  "fixedImages": {
    "1:199": "background_texture"
  }
}
```

### Publish-wrap the draft

1. `figmatk_publish_template_draft`
2. `figmatk_list_template_layouts`
3. Confirm the wrapped layout catalog still exposes the same slot names

### Instantiate a new deck

1. `figmatk_list_template_layouts`
2. `figmatk_create_from_template`

`figmatk_create_from_template` accepts:

- `text`: map of slot name, node ID, or fallback node name to string value
- `images`: map of slot name, node ID, or fallback node name to absolute image path

Example:

```json
{
  "template": "/tmp/product-template-published.deck",
  "output": "/tmp/q2-review.deck",
  "slides": [
    {
      "slideId": "1:42",
      "text": {
        "title": "Q2 Product Review",
        "subtitle": "What shipped, what changed, what is next"
      },
      "images": {
        "hero_image": "/tmp/launch-photo.png"
      }
    }
  ]
}
```

## Heuristics vs Explicit Metadata

Explicit slot metadata is preferred.

Without explicit metadata:

- text fields fall back to direct `TEXT` nodes and `SHAPE_WITH_TEXT` content
- image fields fall back to large image-bearing or empty frame-like nodes

With any explicit slot metadata present on a layout:

- explicit text slots replace fallback text naming for those nodes
- only explicit image slots are treated as editable placeholders
- unmarked image fills remain decorative by default

## Multi-Row Discovery

Template discovery scans every main-canvas `SLIDE_ROW`. It does not limit itself to the first row.

`Internal Only Canvas` assets are preserved during wrapping and instantiation, but slides on that canvas are not treated as primary instantiable layouts unless you explicitly inspect them.

## Special Nodes

FigmaTK preserves unsupported-but-known nodes during cloning and wrapping, including:

- device mockups
- vector masks
- interactive slide elements

The MVP does not synthesize those node types from scratch. It preserves them when they already exist in the source template.
