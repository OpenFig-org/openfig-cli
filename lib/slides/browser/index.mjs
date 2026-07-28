/**
 * The browser adapter, as one import.
 *
 * A barrel and nothing more: the conversion page that assembles these into a
 * user-facing flow is a separate piece of work, and keeping the orchestration
 * out of here means the adapter can be driven from a test without a page.
 *
 * The Node equivalent of "everything below this line" is
 * `../html-converter.mjs` plus `../node/node-conversion-host.mjs`.
 */
export { BrowserConversionHost, precheckStandaloneExport, REQUIRES_STANDALONE_EXPORT } from './browser-conversion-host.mjs';
export { openIframeSurface } from './iframe-surface.mjs';
export { createMemoryBundle } from './memory-bundle.mjs';
export { canvasImageOps } from './canvas-image-ops.mjs';
export {
  convertStandaloneCore,
  checkStandaloneExport,
  NOT_A_STANDALONE_EXPORT,
} from '../core/convert-standalone.mjs';
export { prepareForMeasurement, fitSurfaceToCanvas } from '../core/measurement-surface.mjs';
export { extractSlides } from '../browser-extract.mjs';

// The deck writer. Until group 4b this line could not exist: `api.mjs` and
// `core/fig-deck.mjs` were Node-bound, so a browser could measure an export
// and hand back nothing. `convertStandaloneToDeckBytes` is the whole path in
// one call; the pieces are exported beside it so a page can drive the stages
// separately and report between them.
export { convertStandaloneToDeckBytes } from './convert-to-deck.mjs';
export { convertHandoffBundleToBytes } from '../core/convert-bundle.mjs';
// `Symbol` is deliberately not re-exported: the model's class of that name
// would shadow the global on any page that destructures this barrel, and
// nothing on the write path needs it.
export { Deck, Slide, Shape, PORTABLE_DECK_IO } from '../api-core.mjs';
export { FigDeckCore } from '../../core/fig-deck-core.mjs';

// Lets a page supply the zstd `.wasm` bytes rather than have the encoder fetch
// them. The build inlines the binary and calls this at startup; see
// `scripts/build-browser-bundle.mjs` for why fetching is not an option.
export { setZstdWasmBinary } from '../../core/zstd.mjs';
