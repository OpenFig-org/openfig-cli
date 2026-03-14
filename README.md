<img src="assets/logo.webp" alt="OpenFig" width="320" />

Open tools for Figma files.

Parse, inspect, and render `.deck` and `.fig` files without the Figma application — including PNG export.

OpenFig is an open-source implementation of the Figma file format that allows developers to inspect, parse, and render Figma files without using the Figma application or API. The primary use case is Figma Slides (`.deck`), with `.fig` design file support also available.

## Figma File Formats

Each Figma product has its own native file format. Active development — status may change:

| Product | Extension | Status |
|---------|-----------|--------|
| Figma Slides | `.deck` | ✅ |
| Figma Design | `.fig` | ✅ read + PNG render |
| Figma Jam (whiteboard) | `.jam` | ❌ not yet |
| Figma Buzz | `.buzz` | ❌ not yet |
| Figma Sites | `.site` | ❌ not yet |
| Figma Make | `.make` | ❌ not yet |

## Render Quality

OpenFig achieves **≥99% SSIM** (Structural Similarity Index) against Figma reference exports across all test cases. Render fidelity is verified with visual regression tests against real Figma-exported PNGs.

| Test suite | Visual results |
|------------|----------------|
| `.deck` slides | [render-report-deck.html](https://rcoenen.github.io/OpenFig/test/rasterizer/reports/openfig-render-report-deck.html) |
| `.fig` design frames | [render-report-fig.html](https://rcoenen.github.io/OpenFig/test/rasterizer/reports/openfig-render-report-fig.html) |

## Why native `.deck`?

Figma Slides lets you download presentations as `.deck` files and re-upload them. This is the **native** round-trip format. Exporting to `.pptx` is lossy — vectors get rasterized, fonts fall back to system defaults, layout breaks. By staying in `.deck`, you preserve everything exactly as Figma renders it.

OpenFig makes this round-trip programmable. Download a `.deck`, modify it, re-upload. Everything stays native.

Plug in Claude Cowork or any coding agent and you have an AI that can read and edit Figma presentations end-to-end — without ever opening the Figma UI.

## Use Cases

- **AI agent for presentations** — let an LLM rewrite copy, insert images, and produce a ready-to-upload `.deck`
- **Batch-produce branded decks** — start from a template, feed in data per client/project, get pixel-perfect slides out
- **Inspect and audit** — understand the internal structure of any `.deck` file
- **Automate** text and image placement across dozens of slides in seconds

## Install

```bash
npm install -g openfig
```

Node 18+. No build step. Pure ESM.

## Quick Start

```bash
openfig inspect my-presentation.deck        # node hierarchy
openfig list-text my-presentation.deck      # all text + images per slide
openfig list-overrides my-presentation.deck # editable fields per symbol
```

> Full CLI reference: [docs/cli.md](docs/cli.md)

## Claude Cowork / MCP Integration

> Install guide, MCP workflows, and template states: [docs/agentic/claude-cowork.md](docs/agentic/claude-cowork.md)

## Programmatic API

```javascript
import { Deck } from 'openfig';

const deck = await Deck.open('template.deck');
const slide = deck.slides[0];
slide.addText('Hello world', { style: 'Title' });
await deck.save('output.deck');
```

| Docs | |
|------|---|
| MCP / Claude workflows | [docs/mcp.md](docs/mcp.md) |
| High-level API | [docs/api-spec.md](docs/api-spec.md) |
| Low-level FigDeck API | [docs/library.md](docs/library.md) |
| Template workflows | [docs/template-workflows.md](docs/template-workflows.md) |
| File format internals | [docs/format/](docs/format/) |

## License

MIT

## Disclaimer

Figma is a trademark of Figma, Inc.

OpenFig is an independent open-source project and is not affiliated with, endorsed by, or sponsored by Figma, Inc.
