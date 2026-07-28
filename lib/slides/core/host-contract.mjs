/**
 * The contract between the environment-agnostic converter core and its host.
 *
 * Documentation only — this module has no runtime exports. Two objects:
 *
 *   - a **Host**, constructed once per conversion, supplying byte codecs, the
 *     artifact sink, and access to a measurement realm;
 *   - a **Surface**, one live measurement realm obtained from the host.
 *
 * The core (`./convert-standalone.mjs`) touches the outside world only through
 * these two. Node implements them in `../node/node-conversion-host.mjs` over
 * Playwright and `fs`; a browser implements them over an iframe and memory.
 *
 * @typedef {object} ConversionHost
 *
 * // --- byte codecs -------------------------------------------------------
 * @property {(b64: string) => Uint8Array} bytesFromBase64
 * @property {(bytes: Uint8Array) => string} base64FromBytes
 *   Standard alphabet, padded, no newlines.
 * @property {(bytes: Uint8Array) => Uint8Array|Promise<Uint8Array>} gunzip
 *   Inflate a gzip member. Awaited by the core, so a host may implement it
 *   asynchronously (the browser's `DecompressionStream` is async).
 * @property {(bytes: Uint8Array) => Promise<string>} sha1Hex
 *   Lowercase hex. Async because `crypto.subtle.digest` is.
 *
 * // --- artifact sink: the ONLY way anything leaves the core --------------
 * @property {(filename: string, bytes: Uint8Array) => Promise<MediaRef>} putMedia
 *   `filename` is derived from a key in the export's own JSON, so it is
 *   attacker-controlled: an implementation MUST reject any name containing a
 *   path separator or a `..` segment.
 * @property {(name: string, text: string) => Promise<void>} putText
 *   Named artifacts (`template.html`, `manifest.json`, `warnings.json`).
 *   A host that materialises these as files must keep `manifest.json` directly
 *   in the bundle root and must not add a second `.html` beside
 *   `template.html` — `handoff/bundle-loader.mjs` re-discovers both by
 *   scanning, and takes the *first* `.html` it finds. An in-memory host has
 *   nothing to scan, so those two constraints are vacuous for it — but the
 *   three names stay identical anyway, so the two hosts' outputs can be
 *   compared artifact for artifact.
 *
 * // --- html-string parsing (not the live page) ---------------------------
 * @property {(templateHtml: string) => TemplateMeta} readTemplateMeta
 *
 * // --- measurement realm --------------------------------------------------
 * @property {(init: {viewport: {width: number, height: number}}) => Promise<Surface>} openSurface
 *
 * // --- capabilities & diagnostics -----------------------------------------
 * @property {boolean} webFontPreload
 *   False skips the Google-Fonts preload pass entirely, including the
 *   full-document walk that collects the families to preload.
 * @property {boolean} flexAutoLayout
 *   Passed through to `browser-extract.mjs`, which must not read `process`.
 * @property {(line: string) => void} log - Default warning sink.
 */

/**
 * @typedef {object} TemplateMeta
 * @property {string|null} title - Trimmed `<title>` text, or null if absent.
 * @property {string|null} speakerNotesJson
 *   Raw text of `script#speaker-notes`, or null if absent. Left unparsed: the
 *   core owns the parse so both hosts fail the same way on malformed JSON.
 */

/**
 * A record of one asset the host has taken custody of.
 *
 * `path` is Node-only and exists because the Node deck-emission tail
 * (`handoff/bundle-loader.mjs` → `handoff/element-dispatch.mjs`) consumes
 * media as file paths; the browser tail takes `bytes` instead, through
 * `browser/memory-bundle.mjs`. Nothing in the core reads either — it reads
 * `filename` (to build the `media/<filename>` src the manifest carries),
 * `bytes` (to hash and to inline SVGs), and `mime`.
 *
 * `mime` is **not** supplied by the host: neither implementation returns one,
 * and `decodeAssets` stamps it onto the core's own copy of the record straight
 * after `putMedia` returns. A host that guessed would be a second source of
 * truth for a field nobody reads from the host's copy.
 *
 * @typedef {object} MediaRef
 * @property {string} filename
 * @property {string} [mime] - Stamped by the core, not returned by the host.
 * @property {string} [path] - Node host only.
 * @property {Uint8Array} [bytes] - Browser host; also retained by the core.
 */

/**
 * One live measurement realm — a Playwright page, or an iframe.
 *
 * @typedef {object} Surface
 *
 * @property {<A, R>(fn: (arg: A) => R|Promise<R>, arg?: A) => Promise<R>} evaluate
 *   Run `fn` against the export's realm. This is the pivotal method, and the
 *   contract is stronger than "call `fn`": the payload's `document`, `window`
 *   and `getComputedStyle` MUST be the *export's*, not the caller's.
 *
 *   `fn` is called as `fn({ realm, arg })` and destructures its globals out of
 *   `realm` — it never closes over them. That is the only shape both hosts can
 *   supply: Playwright bound free globals correctly by accident, because it
 *   serialises the payload and re-parses it inside the page, but a host that
 *   invokes the function object from its own realm cannot, and would measure
 *   the wrong document silently rather than throwing. Re-parsing inside an
 *   iframe is not an option — it needs `unsafe-eval`.
 *
 *   `realm` is `{ document, window, getComputedStyle }`, with
 *   `getComputedStyle` bound to `window` (the payloads call it as a free
 *   function). `arg` and the return value must be structured-cloneable: Node
 *   clones them across a process boundary, so a browser host must clone too,
 *   or a payload that mutated `arg` or returned a live node would work in one
 *   host and fail in the other.
 *
 * @property {(size: {width: number, height: number}) => Promise<void>} resize
 *   Resize the realm's viewport. The realm must actually lay out at the literal
 *   size requested — no clamping by an outer container. An iframe is an
 *   element, so this is a real risk there and the browser host both prevents
 *   it (every geometry-critical property pinned inline `!important`) and
 *   checks for it (the realm's own `innerWidth` after the resize).
 * @property {() => {width: number, height: number}} viewport
 *   The size the surface was last *told* to be, never a measured one:
 *   `fitSurfaceToCanvas` divides by a scale derived from this, so returning a
 *   measured value would fold the error the fit exists to remove back in.
 * @property {() => Promise<void>} settle
 *   Exactly two `requestAnimationFrame` turns *in the target realm*. One is not
 *   enough: the first fires before style and layout flush. A host must bound
 *   the wait — rAF does not fire in a backgrounded tab, and this is called
 *   from inside the fit loop.
 * @property {(selector: string, o: {timeout: number}) => Promise<void>} waitForSelector
 * @property {(family: string, cssUrl: string) => Promise<void>} loadWebFont
 *   Best-effort; must not reject when a family is unavailable.
 * @property {() => Promise<string>} content - Serialised DOM after our mutations.
 * @property {() => Promise<void>} close
 */

export {};
