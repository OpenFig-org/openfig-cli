---
name: figma-template-builder
description: >
  Author reusable Figma Slides templates as .deck files. Use when the user
  wants to build a template from reference images or examples, derive a new
  template from an existing deck, define reusable layouts, mark editable
  text/image slots, or prepare a draft template for later instantiation.
metadata:
  version: "0.3.18"
---

# Figma Template Builder

## ⚠️ Never open .deck files directly

`.deck` files are binary ZIP archives. **Never open, read, or display a `.deck` file** — it will show garbage bytes in the panel. To inspect or modify a `.deck` file, always use the MCP tools shown below.

Use this skill when the goal is to build or refine the template itself. For the common workflow of taking an existing template and producing a new presentation, use `skills/figma-slides-creator/SKILL.md`.

## MCP First

In Claude Cowork, keep template authoring inside the MCP plugin.

- Do not inspect the installed `openfig` package to discover template features.
- Do not write direct Node.js scripts for draft creation, annotation, wrapping, or instantiation when MCP tools exist for those steps.
- Prefer `openfig_create_template_draft`, `openfig_annotate_template_layout`, `openfig_publish_template_draft`, and `openfig_list_template_layouts`.

Only fall back to direct library code if the MCP server is unavailable or the required capability is missing from the MCP surface.

## Skill Boundary

Use this skill when the deliverable is a reusable template, not a one-off deck.

Stay here when the user wants to:

- translate reference images or screenshots into template layouts
- create a new layout family
- define placeholder semantics for later sessions
- turn an ordinary deck into a reusable template

Hand off to `skills/figma-slides-creator/SKILL.md` once the template exists and the task becomes simple content population.

## Core Model

Template work happens in two states:

- Draft template: `SLIDE_ROW -> SLIDE -> ...`
- Published or publish-like template: `SLIDE_ROW -> MODULE -> SLIDE -> ...`

Draft templates are easier to author. Publish-like wrapping is the final step before later instantiation.

## Design-First Workflow

When the user provides reference images, screenshots, or example decks:

1. Read the references first and infer the layout family before touching the `.deck`.
2. Decide which parts are reusable structure versus one-off sample content.
3. Create only the smallest set of layouts that captures the system.
4. Use semantic slot names so later sessions can populate them without re-reading the design intent.

Do not mirror every visual variation as its own layout unless the content structure changes materially.

## Naming Conventions

Always use explicit metadata when authoring reusable layouts:

- Layouts: `layout:<name>`
- Text slots: `slot:text:<name>`
- Image slots: `slot:image:<name>`
- Decorative fixed imagery: `fixed:image:<name>`

These conventions are how later sessions discover what is editable.

Prefer semantic names over visual or auto-generated names.

Good:

- `title`
- `subtitle`
- `hero_image`
- `device_screen_primary`
- `quote_author`

Bad:

- `text1`
- `frame183`
- `image-left`
- `rectangle2`

## Recommended Flow

### 1. Create or inspect a draft template

- New draft from scratch: `openfig_create_template_draft`
- Existing deck/template: `openfig_list_template_layouts`
- Structural inspection: `openfig_inspect`

### 2. Annotate reusable layouts

Use `openfig_annotate_template_layout` to:

- rename a slide as a layout
- mark text nodes as editable text slots
- mark image-bearing nodes as editable image slots
- mark decorative imagery as fixed

The tool accepts node ID maps, so inspect first if you need the raw node IDs.

While annotating:

- rename the slide itself to the stable layout name
- mark only true placeholders as `slot:*`
- mark decorative or sample imagery as `fixed:image:*`
- prefer stable semantic names over spatial names like `left_box`

### 3. Publish-wrap when the template is ready

Use `openfig_publish_template_draft` to add publish-like `MODULE` wrappers while preserving the slide subtree and internal assets.

### 4. Verify the result

- `openfig_list_template_layouts`
- `openfig_list_text`
- `openfig_roundtrip` if you want a conservative encode/decode check
- open the wrapped template in Figma Desktop when validating real upload behavior

## Practical Rules

- Prefer explicit slot names over heuristic placeholders.
- Do not assume every image fill is editable content.
- Preserve `Internal Only Canvas` assets.
- Preserve special nodes such as device mockups and interactive slide elements; do not try to recreate them from scratch unless necessary.

## Template Authoring Heuristics

- Start with 4-8 reusable layouts, not an exhaustive library.
- Reuse one layout when only copy length changes; create a new layout when hierarchy or media structure changes.
- Separate content slots from chrome. For device mockups, the screen is usually the slot and the hardware frame is usually fixed.
- If a layout has explicit slot metadata, do not rely on heuristic image placeholders for that layout.
- After publish-wrapping, re-run `openfig_list_template_layouts` and confirm the layout names and slot names survived unchanged.

## Example

```json
{
  "path": "/tmp/draft-template.deck",
  "output": "/tmp/draft-template-annotated.deck",
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
