# Claude Cowork / MCP Integration

OpenFig supports two Claude Cowork install paths:

- GitHub-backed personal plugin install, which preserves Claude Cowork's repo update-check behavior
- Local `.mcpb` bundle install, which matches Anthropic's current desktop-extension packaging model

## Option 1 — Install from GitHub in Claude Cowork

If you want Claude Cowork to keep checking the repo for updates, install `openfig` from GitHub/personal plugins inside Claude Cowork.

That path uses the checked-in [plugin.json](../../.claude-plugin/plugin.json) and [marketplace.json](../../.claude-plugin/marketplace.json) metadata.

## Option 2 — Install the local MCPB bundle

Build the extension bundle:

```bash
npm install
npm run pack
```

This creates `dist/openfig.mcpb`. Install that bundle from Claude Desktop/Cowork's Extensions UI.

Install in Claude Cowork:

1. Open Claude Cowork or Claude Desktop.
2. Go to `Settings`.
3. Open `Extensions`.
4. Choose the local install/add option.
5. Select `dist/openfig.mcpb`.

Use this path when you want a local extension artifact. Unlike the GitHub-backed personal plugin path, local `.mcpb` installs do not poll the repo for updates automatically.

## MCP Workflows

The MCP server covers four high-level workflows:

- create a new deck from scratch
- author a reusable Slides template
- instantiate a new deck from a template
- inspect or edit an existing deck

> MCP tool reference: [docs/mcp.md](../mcp.md)

## Template Workflows

OpenFig supports two related template states:

- Draft templates: `SLIDE_ROW -> SLIDE -> ...`
- Published templates: `SLIDE_ROW -> MODULE -> SLIDE -> ...`

Reusable template authoring is built around explicit layout and slot naming, then a publish-like wrapping step before later instantiation.

> Template workflow guide: [docs/template-workflows.md](../template-workflows.md)
