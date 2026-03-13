## 1. Specification

- [ ] 1.1 Define the draft-template, published-template, and instantiated-deck states
- [ ] 1.2 Define layout discovery rules across multiple main-canvas slide rows
- [ ] 1.3 Define explicit slot naming rules for text and image placeholders

## 2. Engine

- [ ] 2.1 Update template discovery to scan all main-canvas slide rows and exclude internal-only canvases from instantiable layouts
- [ ] 2.2 Add helpers for draft template authoring with explicit layout and slot naming
- [ ] 2.3 Add a publish-like transform that wraps slides in publishable `MODULE` nodes while preserving the slide subtree
- [ ] 2.4 Preserve `Internal Only Canvas` assets and unsupported node types during cloning and wrapping

## 3. MCP Surface

- [ ] 3.1 Add or revise MCP tools so template authoring is a first-class workflow, not only template instantiation
- [ ] 3.2 Ensure layout listing returns explicit slot metadata instead of relying on raw image-fill inference alone
- [ ] 3.3 Ensure instantiation works for multi-row module-backed templates

## 4. Validation

- [ ] 4.1 Validate draft-template output against the captured minimal draft template sample
- [ ] 4.2 Validate publish-like wrapping against the captured draft-to-published diff
- [ ] 4.3 Validate instantiation against the captured published-to-instantiated diff
- [ ] 4.4 Confirm special nodes and internal canvas assets survive cloning

## 5. Documentation

- [ ] 5.1 Document the template workflow states and slot naming conventions
- [ ] 5.2 Split skill guidance between template authoring and template instantiation paths
