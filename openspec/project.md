# OpenFig CLI — OpenSpec Project

OpenFig (`openfig-cli`) is an open-source CLI and Node.js library for parsing, rendering, and manipulating Figma Slides `.deck` files without the Figma API.

## Repository

- **Package**: `openfig-cli` (npm)
- **GitHub**: `OpenFig-org/openfig-cli`
- **License**: MIT

## Architecture

- `bin/cli.mjs` — CLI entry point
- `bin/commands/` — Individual CLI commands
- `lib/core/` — Core deck parsing (`fig-deck.mjs`), node helpers, image helpers
- `lib/rasterizer/` — SVG generation + PNG rendering pipeline
- `lib/slides/` — High-level API (`api.mjs`), template workflows (`template-deck.mjs`)
- `mcp-server.mjs` — MCP server for Claude Code plugin
