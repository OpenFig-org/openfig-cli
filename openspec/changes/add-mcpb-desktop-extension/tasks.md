## 1. Specification

- [x] 1.1 Define Claude Desktop/Cowork distribution as an MCPB-based capability
- [x] 1.2 Define the relationship between `package.json`, `manifest.json`, and local development config

## 2. Packaging

- [x] 2.1 Add a root `manifest.json` for the desktop extension
- [x] 2.2 Update the pack flow to stage runtime files and emit a validated `.mcpb` bundle
- [x] 2.3 Retain `.claude-plugin/` metadata for the GitHub-backed Claude Cowork update path while removing the old ZIP artifact

## 3. Release Tooling

- [x] 3.1 Sync version updates across `package.json` and `manifest.json`
- [x] 3.2 Ensure the release flow still supports npm publishing for the library/CLI while documenting MCPB as the Claude install artifact

## 4. Documentation

- [x] 4.1 Keep `README.md` high-level while updating Claude install guidance
- [x] 4.2 Update `docs/mcp.md` to describe MCPB install, update, and local development flows

## 5. Validation

- [x] 5.1 Validate the manifest with the official `mcpb` CLI
- [x] 5.2 Produce a local `.mcpb` bundle successfully
- [x] 5.3 Confirm the resulting artifact is suitable for Claude Desktop/Cowork installation
