# Document .fig format support

## ADDED Requirements

### REQ-1: README documents .fig file support

The README and CLI help text state that `fromDeckFile()` and all CLI commands work on both `.deck` and `.fig` ZIP archives.

#### Scenario: User has a .fig export from Figma Design
- **Given** the user reads the README or runs `openfig --help`
- **Then** they see that .fig files are supported alongside .deck files

### REQ-2: CLI commands accept .fig files

All CLI commands that accept a `.deck` path also accept `.fig` paths without error.

#### Scenario: Inspect a .fig file
- **Given** a valid Figma .fig export
- **When** `openfig inspect myfile.fig`
- **Then** the node hierarchy is displayed (same as for .deck)
