# Change: Add MCPB Desktop Extension Distribution

## Why

openfig currently ships Claude-focused packaging through `.claude-plugin/` metadata, a local ZIP pack script, and documentation that assumes an older Claude plugin installation flow. Recent Anthropic documentation positions Claude Desktop/Cowork extensions as MCP-based desktop bundles packaged as `.mcpb` files with `manifest.json`, but the repo-backed plugin metadata still matters for Claude Cowork's GitHub update-check behavior.

The project should align its Claude distribution path with the documented MCPB flow while preserving both the existing npm package for the CLI/library/MCP binary and the repo-backed Claude metadata that powers GitHub update checks.

## What Changes

- Add a new `desktop-extension-distribution` capability covering official Claude Desktop/Cowork packaging as an MCPB bundle.
- Introduce a top-level `manifest.json` as the source of truth for Claude extension metadata.
- Replace the current ZIP-based plugin pack flow with MCPB-based packing and validation.
- Update release/version-sync tooling so `package.json` and `manifest.json` stay aligned.
- Update Claude-facing docs to describe MCPB installation and local development clearly.
- Retain repo-backed `.claude-plugin` metadata as a compatibility path for Claude Cowork GitHub update checks.

## Impact

- Affected specs: `desktop-extension-distribution`
- Affected code:
  - `manifest.json`
  - `package.json`
  - `scripts/pack.mjs`
  - `scripts/release.mjs`
  - `README.md`
  - `docs/mcp.md`
  - `.claude-plugin/*` metadata
