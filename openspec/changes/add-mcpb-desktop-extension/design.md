## Context

openfig already has the correct core architecture for Claude integration: a local stdio MCP server in `mcp-server.mjs`. The gap is packaging and distribution.

Today the repo uses:
- `.claude-plugin/plugin.json`
- `.claude-plugin/marketplace.json`
- `.mcp.json`
- a custom ZIP pack script that stages files into `dist/openfig-plugin.zip`

That layout worked for local experimentation, but it diverges from Anthropic's currently documented desktop-extension workflow:
- a `manifest.json` file at the extension root
- an `.mcpb` bundle built from the extension directory
- install/update via the Claude Desktop/Cowork extensions UI

At the same time, openfig is not only a Claude extension. It is also:
- an npm library
- a CLI
- a standalone MCP server binary (`openfig-mcp`)

The design therefore needs to separate:
- **runtime/package metadata for npm**
- **extension metadata for Claude Desktop/Cowork**

without duplicating the actual server implementation.

## Goals / Non-Goals

- Goals:
  - Package openfig for Claude Desktop/Cowork as an official `.mcpb` desktop extension
  - Keep the npm package and standalone CLI/MCP entry points intact
  - Make `manifest.json` the authoritative Claude extension metadata file
  - Provide a deterministic `pack` flow that stages production dependencies and emits a validated `.mcpb`
  - Update user docs to reflect the supported install/update flow

- Non-Goals:
  - Replace the existing MCP server implementation
  - Build or host a remote MCP connector in this change
  - Remove the ability to run the MCP server manually via `openfig-mcp` or `.mcp.json`
  - Solve signing/notarization beyond leaving a compatible path open for later

## Decisions

- Decision: Keep dual distribution channels
  - npm remains the distribution channel for the JS library, CLI, and standalone MCP binary
  - MCPB becomes the distribution channel for Claude Desktop/Cowork installation

- Decision: Introduce `manifest.json` at the repository root
  - Claude extension metadata lives in `manifest.json`
  - `package.json` remains the npm package manifest
  - Release tooling must keep their shared fields aligned where appropriate

- Decision: Stage a clean bundle before packing
  - The pack flow continues to build from a temporary staging directory
  - Only runtime files and production dependencies are included
  - The output artifact changes from ZIP to `.mcpb`

- Decision: Keep `.mcp.json` only as a development convenience
  - `.mcp.json` may remain for local/manual MCP development
  - It is not the primary install surface described to Claude Desktop/Cowork users

- Decision: Keep hybrid Claude distribution metadata
  - MCPB is the documented bundle format for local extension installation
  - `.claude-plugin` metadata remains in the repo for Claude Cowork's GitHub-backed personal plugin/update flow
  - Release tooling must keep both paths version-aligned

## Risks / Trade-offs

- Risk: MCPB pack/validate may impose bundle-layout constraints not captured by the current ZIP script
  - Mitigation: scaffold and validate against the official `mcpb` CLI before removing the old pack path

- Risk: Two manifests can drift
  - Mitigation: `scripts/release.mjs` must update both `package.json` and `manifest.json`

- Risk: Two Claude distribution paths can confuse users
  - Mitigation: document the GitHub-backed plugin path and the local `.mcpb` path separately in `docs/mcp.md`

- Risk: Desktop-extension signing may become important later
  - Mitigation: keep the bundle compatible with `mcpb sign`/`verify`, but defer signing policy to a later change

## Migration Plan

1. Define MCPB desktop-extension distribution as an explicit capability
2. Add `manifest.json` and map existing extension metadata into it
3. Update pack tooling to stage and emit `dist/openfig.mcpb`
4. Update release tooling to sync versions across npm and MCPB manifests
5. Update README/docs to describe MCPB install/update and dev-only `.mcp.json`
6. Keep `.claude-plugin` metadata as the GitHub-backed update-check path while deprecating only the old ZIP artifact

## Open Questions

- Should the generated `.mcpb` be attached to GitHub releases automatically, or stay as a local `pack` artifact for now?
