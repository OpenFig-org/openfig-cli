---
name: figmatk
description: >
  Inspect and modify Figma Slides .deck files. Use when the user asks to
  "edit a deck", "modify a presentation", "inspect slides", "update slide text",
  "insert an image into a slide", "clone a slide", "remove a slide",
  "list slide content", or works with .deck or .fig files.
metadata:
  version: "0.0.3"
---

Use the FigmaTK MCP tools to manipulate Figma .deck files. The tools are prefixed with `figmatk_`.

## Available tools

- `figmatk_inspect` — Show the node hierarchy tree
- `figmatk_list_text` — List all text and image content per slide
- `figmatk_list_overrides` — List editable override keys per symbol
- `figmatk_update_text` — Apply text overrides to a slide instance
- `figmatk_insert_image` — Apply image fill override with hash + thumbnail
- `figmatk_clone_slide` — Duplicate a slide
- `figmatk_remove_slide` — Mark a slide as REMOVED
- `figmatk_roundtrip` — Decode and re-encode for validation

## Workflow

1. Start with `figmatk_inspect` to understand the deck structure
2. Use `figmatk_list_text` to see current content
3. Use `figmatk_list_overrides` to find editable keys
4. Apply changes with `figmatk_update_text` or `figmatk_insert_image`
5. Always write to a new output path — never overwrite the source

## Critical rules

- Text overrides use `overrideKey: text` pairs where keys are `"sessionID:localID"` format
- Blank text fields must be a single space `" "`, never empty string (crashes Figma)
- Image overrides require both a full image hash and a thumbnail hash (40-char hex SHA-1)
- Removed nodes use `phase: 'REMOVED'` — never delete from nodeChanges
- Always roundtrip-test after modifications to validate the pipeline
