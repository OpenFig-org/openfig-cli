# Change: Add Template Workflows MVP

## Why

openfig currently supports template instantiation only in a narrow sense: it can inspect and clone existing `.deck` templates, but it does not provide a first-class workflow for authoring reusable templates. Recent inspection of Figma-generated files shows that draft templates, published templates, and instantiated decks are closely related but not identical.

The toolkit needs an explicit MVP for template workflows so Claude can:
- author draft templates from scratch
- turn draft templates into publish-like module-backed templates
- instantiate published templates reliably in later sessions

## What Changes

- Add a new `template-workflows` capability covering draft authoring, publish-like wrapping, and template instantiation.
- Support template layout discovery across all main-canvas slide rows, not only the first `SLIDE_ROW`.
- Introduce explicit slot conventions so editable text/image slots are distinguishable from decorative content.
- Preserve `Internal Only Canvas` assets and unsupported/special nodes during template cloning.
- Treat draft templates and published templates as distinct but related structural states.

## Impact

- Affected specs: `template-workflows`
- Affected code:
  - `lib/template-deck.mjs`
  - `lib/api.mjs`
  - `mcp-server.mjs`
  - `skills/figma-slides-creator/SKILL.md`
  - docs for template authoring and instantiation
