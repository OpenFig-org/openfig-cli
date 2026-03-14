# MCP / Claude Workflows

This page documents the `openfig-mcp` tool surface and the supported Claude Desktop/Cowork install flow.

## Install in Claude Cowork

### Option 1 — GitHub-backed personal plugin

Use this when you want Claude Cowork's repo-based update checks to keep working.

This path uses the repository metadata in:

- [plugin.json](/Users/rob/Dev/openfig/.claude-plugin/plugin.json)
- [marketplace.json](/Users/rob/Dev/openfig/.claude-plugin/marketplace.json)

Release note for this path:

- In practice, Claude Cowork has only detected new openfig releases reliably after the version bump was committed to `main` and the matching Git tag `vX.Y.Z` was pushed to GitHub.
- Treat `push main` plus `push tag` as part of the required release process for the GitHub-backed plugin path.

### Option 2 — Local MCPB extension bundle

Build the local extension bundle from the repository root:

```bash
npm install
npm run pack
```

That produces `dist/openfig.mcpb`.

Install the bundle from Claude Desktop/Cowork's Extensions UI.

Click path:

1. Open Claude Cowork or Claude Desktop.
2. Go to `Settings`.
3. Open `Extensions`.
4. Choose the local install/add option.
5. Select [`dist/openfig.mcpb`](/Users/rob/Dev/openfig/dist/openfig.mcpb).

This is the official Anthropic desktop-extension packaging format, but local `.mcpb` installs are file-based rather than GitHub-polled.

## Local development without a packaged extension

For repository development, you can still run the MCP server directly.

Use the checked-in [`/.mcp.json`](/Users/rob/Dev/openfig/.mcp.json) or point Claude at:

```json
{
  "mcpServers": {
    "openfig": {
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

- `openfig_create_deck`

Use this when the user wants a finished presentation and does not already have a `.deck` template.

### Author a reusable template

- `openfig_create_template_draft`
- `openfig_annotate_template_layout`
- `openfig_publish_template_draft`

Use this when the user wants to build the template itself, not just fill one in.

### Instantiate from a template

- `openfig_list_template_layouts`
- `openfig_create_from_template`

Use this when the user already has a draft, published, or publish-like template deck and wants a new presentation from it.

### Inspect or edit an existing deck

- `openfig_inspect`
- `openfig_list_text`
- `openfig_list_overrides`
- `openfig_update_text`
- `openfig_insert_image`
- `openfig_clone_slide`
- `openfig_remove_slide`
- `openfig_roundtrip`

Use this when the user wants targeted changes to an existing `.deck`.

## Recommended Workflows

### Build a reusable template from references

1. Translate the reference images or example slides into a small layout system.
2. `openfig_create_template_draft`
3. `openfig_inspect` or `openfig_list_template_layouts`
4. `openfig_annotate_template_layout`
5. Repeat annotation until layout names and slot names are stable.
6. `openfig_publish_template_draft`
7. `openfig_list_template_layouts` again to confirm the wrapped template still exposes the expected slots.

See [template-workflows.md](template-workflows.md) for naming conventions and structural details.

### Populate a template

1. `openfig_list_template_layouts`
2. Treat the result as a layout library, not a fixed slide sequence.
3. Classify each candidate layout by purpose and content capacity.
4. Plan the target deck slide by slide, choosing only the layouts you want to use.
5. Pass `text` values by slot name when possible.
6. Pass `images` values only for explicit image slots unless the user clearly wants heuristic placeholders overwritten.
7. `openfig_create_from_template`
8. Validate with `openfig_list_text` or a manual open in Figma Desktop.

Anti-pattern:

- walking through the template from start to finish and filling every layout as if it were a form

Preferred pattern:

- inventory the layouts
- select a subset
- order them for the presentation you actually want to build

Do not do this instead:

- remove unused slides from the source template
- reorder the source template to force a narrative sequence
- inspect raw `FigDeck` internals or write custom generator scripts for normal template instantiation

### Edit an existing deck

1. `openfig_inspect`
2. `openfig_list_text`
3. `openfig_list_overrides` if the deck uses symbol overrides
4. Apply edits with `openfig_update_text`, `openfig_insert_image`, `openfig_clone_slide`, or `openfig_remove_slide`
5. Save to a new output path
6. `openfig_roundtrip` if you want a conservative codec check

## Notes

- `.deck` files are binary ZIP archives. Do not open them as text.
- The repo supports both GitHub-backed plugin metadata and a local `dist/openfig.mcpb` bundle.
- `openfig_create_from_template` instantiates only the layouts you pass in the `slides` array, in that array's order.
- Template discovery scans all main-canvas `SLIDE_ROW` nodes, not only the first row.
- `Internal Only Canvas` assets are preserved during wrapping and instantiation.
- Special nodes such as device mockups and interactive slide elements are preserved during cloning, even when OpenFig cannot synthesize them from scratch.
