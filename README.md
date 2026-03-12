# FigmaTK — Figma Toolkit (v0.0.6)

Swiss-army knife CLI for Figma Slides `.deck` files. Parse, inspect, modify, and rebuild presentations programmatically — no Figma API required.

## Figma File Formats

Each Figma product has its own native file format:

| Product | Extension | Supported |
|---------|-----------|-----------|
| Figma Slides | `.deck` | ✅ |
| Figma Design | `.fig` | ❌ not yet |
| Figma Jam (whiteboard) | `.jam` | ❌ not yet |
| Figma Buzz | `.buzz` | ❌ not yet |
| Figma Sites | `.site` | ❌ not yet |
| Figma Make | `.make` | ❌ not yet |

## Why native `.deck`?

Figma Slides lets you download presentations as `.deck` files and re-upload them. This is the **native** round-trip format. Exporting to `.pptx` is lossy — vectors get rasterized, fonts fall back to system defaults, layout breaks. By staying in `.deck`, you preserve everything exactly as Figma renders it.

FigmaTK makes this round-trip programmable. Download a `.deck`, modify it, re-upload. Everything stays native.

Plug in [Claude Code](https://claude.ai/code) or any coding agent and you have an AI that can read and edit Figma presentations end-to-end — without ever opening the Figma UI.

## Use Cases

- **AI agent for presentations** — let an LLM rewrite copy, insert images, and produce a ready-to-upload `.deck`
- **Batch-produce branded decks** — start from a template, feed in data per client/project, get pixel-perfect slides out
- **Inspect and audit** — understand the internal structure of any `.deck` file
- **Automate** text and image placement across dozens of slides in seconds

## Install

```bash
npm install -g figmatk
```

Node 18+. No build step. Pure ESM.

## Quick Start

```bash
figmatk inspect my-presentation.deck        # node hierarchy
figmatk list-text my-presentation.deck      # all text + images per slide
figmatk list-overrides my-presentation.deck # editable fields per symbol
```

→ Full CLI reference: [docs/cli.md](docs/cli.md)

## Claude Code / MCP Integration

FigmaTK ships as a **Cowork plugin** with an MCP server — Claude can manipulate `.deck` files directly as tool calls.

```bash
claude plugin marketplace add rcoenen/figmatk
claude plugin install figmatk
```

Or add manually in Claude Desktop → Settings → Developer → Edit Config:

```json
{
  "mcpServers": {
    "figmatk": { "command": "figmatk-mcp" }
  }
}
```

Available MCP tools: `figmatk_inspect`, `figmatk_list_text`, `figmatk_list_overrides`, `figmatk_update_text`, `figmatk_insert_image`, `figmatk_clone_slide`, `figmatk_remove_slide`, `figmatk_roundtrip`.

## Programmatic API

```javascript
import { Deck } from 'figmatk';

const deck = await Deck.open('template.deck');
const slide = deck.slides[0];
slide.addText('Hello world', { style: 'Title' });
await deck.save('output.deck');
```

| Docs | |
|------|---|
| High-level API | [docs/figmatk-api-spec.md](docs/figmatk-api-spec.md) |
| Low-level FigDeck API | [docs/library.md](docs/library.md) |
| File format internals | [docs/format/](docs/format/) |

## License

MIT
