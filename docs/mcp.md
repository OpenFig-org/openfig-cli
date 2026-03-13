# MCP / Claude Workflows

This page documents the `figmatk-mcp` tool surface and the supported Claude Desktop/Cowork install flow.

## Install in Claude Cowork

### Option 1 — GitHub-backed personal plugin

Use this when you want Claude Cowork's repo-based update checks to keep working.

This path uses the repository metadata in:

- [plugin.json](/Users/rob/Dev/figmatk/.claude-plugin/plugin.json)
- [marketplace.json](/Users/rob/Dev/figmatk/.claude-plugin/marketplace.json)

### Option 2 — Local MCPB extension bundle

Build the local extension bundle from the repository root:

```bash
npm install
npm run pack
```

That produces `dist/figmatk.mcpb`.

Install the bundle from Claude Desktop/Cowork's Extensions UI.

Click path:

1. Open Claude Cowork or Claude Desktop.
2. Go to `Settings`.
3. Open `Extensions`.
4. Choose the local install/add option.
5. Select [`dist/figmatk.mcpb`](/Users/rob/Dev/figmatk/dist/figmatk.mcpb).

This is the official Anthropic desktop-extension packaging format, but local `.mcpb` installs are file-based rather than GitHub-polled.

## Local development without a packaged extension

For repository development, you can still run the MCP server directly.

Use the checked-in [`/.mcp.json`](/Users/rob/Dev/figmatk/.mcp.json) or point Claude at:

```json
{
  "mcpServers": {
    "figmatk": {
      "command": "node",
      "args": ["/absolute/path/to/mcp-server.mjs"]
    }
  }
}
```

This manual config is a development path, not the primary end-user install path.

The MCP server is the primary interface for:

- creating new decks
- authoring reusable templates
- instantiating decks from templates
- inspecting and editing existing `.deck` files

## Tool Groups

### Create a deck from scratch

- `figmatk_create_deck`

Use this when the user wants a finished presentation and does not already have a `.deck` template.

### Author a reusable template

- `figmatk_create_template_draft`
- `figmatk_annotate_template_layout`
- `figmatk_publish_template_draft`

Use this when the user wants to build the template itself, not just fill one in.

### Instantiate from a template

- `figmatk_list_template_layouts`
- `figmatk_create_from_template`

Use this when the user already has a draft, published, or publish-like template deck and wants a new presentation from it.

### Inspect or edit an existing deck

- `figmatk_inspect`
- `figmatk_list_text`
- `figmatk_list_overrides`
- `figmatk_update_text`
- `figmatk_insert_image`
- `figmatk_clone_slide`
- `figmatk_remove_slide`
- `figmatk_roundtrip`

Use this when the user wants targeted changes to an existing `.deck`.

## Recommended Workflows

### Build a reusable template from references

1. Translate the reference images or example slides into a small layout system.
2. `figmatk_create_template_draft`
3. `figmatk_inspect` or `figmatk_list_template_layouts`
4. `figmatk_annotate_template_layout`
5. Repeat annotation until layout names and slot names are stable.
6. `figmatk_publish_template_draft`
7. `figmatk_list_template_layouts` again to confirm the wrapped template still exposes the expected slots.

See [template-workflows.md](template-workflows.md) for naming conventions and structural details.

### Populate a template

1. `figmatk_list_template_layouts`
2. Choose layouts by content structure, not just by visual resemblance.
3. Pass `text` values by slot name when possible.
4. Pass `images` values only for explicit image slots unless the user clearly wants heuristic placeholders overwritten.
5. `figmatk_create_from_template`
6. Validate with `figmatk_list_text` or a manual open in Figma Desktop.

### Edit an existing deck

1. `figmatk_inspect`
2. `figmatk_list_text`
3. `figmatk_list_overrides` if the deck uses symbol overrides
4. Apply edits with `figmatk_update_text`, `figmatk_insert_image`, `figmatk_clone_slide`, or `figmatk_remove_slide`
5. Save to a new output path
6. `figmatk_roundtrip` if you want a conservative codec check

## Notes

- `.deck` files are binary ZIP archives. Do not open them as text.
- The repo supports both GitHub-backed plugin metadata and a local `dist/figmatk.mcpb` bundle.
- Template discovery scans all main-canvas `SLIDE_ROW` nodes, not only the first row.
- `Internal Only Canvas` assets are preserved during wrapping and instantiation.
- Special nodes such as device mockups and interactive slide elements are preserved during cloning, even when FigmaTK cannot synthesize them from scratch.
