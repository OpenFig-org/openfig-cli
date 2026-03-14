## ADDED Requirements

### Requirement: MCPB Desktop Extension Packaging

The system SHALL package the Claude Desktop/Cowork extension as an MCPB bundle with a root `manifest.json`.

#### Scenario: Build a local desktop-extension artifact

- **WHEN** a maintainer runs the project pack flow for Claude Desktop/Cowork distribution
- **THEN** the output artifact is an `.mcpb` bundle
- **AND** the bundle contains a valid `manifest.json`
- **AND** the bundle includes the local MCP server entry point required to run openfig inside Claude

### Requirement: Separate npm and Claude Distribution Metadata

The system SHALL maintain separate manifests for npm distribution and Claude Desktop/Cowork distribution while keeping shared version metadata aligned.

#### Scenario: Release a new version

- **WHEN** a maintainer performs a version bump for a release
- **THEN** `package.json` is updated for npm distribution
- **AND** `manifest.json` is updated for Claude Desktop/Cowork distribution
- **AND** the two manifests report the same released version number

### Requirement: Supported Claude Installation Path

The system SHALL document the MCPB desktop-extension flow as the primary Claude Desktop/Cowork installation path.

#### Scenario: Read Claude integration instructions

- **WHEN** a user reads the Claude integration documentation
- **THEN** the docs describe installing a `.mcpb` desktop extension through the Claude Desktop/Cowork extensions UI
- **AND** manual local MCP configuration is described, if at all, as a development or fallback path

### Requirement: Local Development Compatibility

The system SHALL preserve a local manual MCP development path while moving end-user distribution to MCPB.

#### Scenario: Develop against the local MCP server

- **WHEN** a contributor wants to run the openfig MCP server locally without installing a packaged extension
- **THEN** the repository still provides a documented local-development path
- **AND** that path does not require the contributor to unpack or modify the distributed `.mcpb` artifact
