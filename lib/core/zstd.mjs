/**
 * zstd, over `@foxglove/wasm-zstd`'s WebAssembly module but not its JS wrapper.
 *
 * The package's own `dist/index.js` copies results out of the wasm heap with
 * `Buffer.allocUnsafe` + `Buffer.prototype.copy`, so `compress()` throws
 * `ReferenceError: Buffer is not defined` the moment it runs in a browser.
 * That is invisible to an import scan and to a bundler — it is a global, not
 * an import — and it was found by actually encoding a deck in Chrome.
 *
 * The alternatives were a `Buffer` polyfill (design.md rejects those: they add
 * weight and hide which code is genuinely portable) or a different encoder
 * (which would move every `canvas.fig` chunk-1 byte). So the wrapper is
 * reimplemented here — 30 lines over the same wasm exports, with `Uint8Array`
 * where the original used `Buffer`.
 *
 * **Byte-identical to the package by construction**: same `.wasm`, same
 * `_compress`, same level. Only the copy out of the heap differs, and that
 * copy is a memcpy either way. Verified against the frozen byte baseline —
 * all eight reference `.fig` files re-encode identically.
 *
 * The deep import reaches past the package's `main`. It has no `exports` map,
 * and `dist/wasm-zstd.js` is in its `files` list, so this is a supported path
 * rather than a reach into a build artifact.
 */
import createZstdModule from '@foxglove/wasm-zstd/dist/wasm-zstd.js';

/** @type {Uint8Array|null} */
let providedBinary = null;
/** @type {Promise<void>|null} */
let loading = null;
/** @type {any} */
let Module = null;

/**
 * Supply the `.wasm` bytes directly instead of letting the module fetch them.
 *
 * Emscripten's default is to `fetch` the binary — either from a URL next to
 * the bundle, or, when the binary is inlined for a self-contained page, from a
 * `data:` URL. The second is the case that matters here and it does not work
 * where it is needed most: a Claude artifact's CSP is `connect-src 'self'`,
 * and `fetch` of a `data:` URL counts as a connect, so it is blocked. Measured,
 * not assumed.
 *
 * Handing the bytes in skips fetching entirely, so no CSP directive is
 * involved. Decoding them is a one-off at startup; nothing per-compression
 * changes, since the module copies through the wasm heap either way.
 *
 * Must be called before the first `compress`/`decompress`/`await isLoaded`.
 *
 * @param {Uint8Array|ArrayBuffer} binary
 */
export function setZstdWasmBinary(binary) {
  if (loading) {
    throw new Error('setZstdWasmBinary: the zstd module has already started loading');
  }
  providedBinary = binary instanceof Uint8Array ? binary : new Uint8Array(binary);
}

function startLoading() {
  loading ??= createZstdModule(providedBinary ? { wasmBinary: providedBinary } : {})
    .then(async (mod) => {
      await mod.ready;
      Module = mod;
    });
  return loading;
}

/**
 * Resolves when the encoder is usable. Same contract as the package's own
 * `isLoaded`: awaitable, and it *rejects* rather than hanging when the
 * WebAssembly compile is blocked — which is what let task 4.1 be a
 * `Promise.race` instead of callback plumbing.
 */
export const isLoaded = {
  // A thenable rather than a promise, so that awaiting it is what starts the
  // load. A promise created at import time would begin fetching before
  // `setZstdWasmBinary` could be called, which is the whole point of it.
  then(onFulfilled, onRejected) {
    return startLoading().then(onFulfilled, onRejected);
  },
};

function ensureLoaded() {
  if (!Module) {
    startLoading();
    throw new Error('zstd has not finished loading. Await `isLoaded` before calling any method.');
  }
}

/** Upper bound on the compressed size of `srcSize` bytes. */
export function compressBound(srcSize) {
  ensureLoaded();
  return Module._compressBound(srcSize);
}

/**
 * @param {Uint8Array} src
 * @param {number} [compressionLevel] - Defaults to 3, as the package does.
 * @returns {Uint8Array}
 */
export function compress(src, compressionLevel = 3) {
  ensureLoaded();
  const srcSize = src.byteLength;
  const destSize = compressBound(srcSize);

  const srcPointer = Module._malloc(srcSize);
  const destPointer = Module._malloc(destSize);
  try {
    // A view into the heap, then copy the source in. The heap's ArrayBuffer is
    // re-created whenever wasm memory grows, so every view is taken fresh
    // rather than cached — the same reason the original re-reads `HEAPU8`.
    new Uint8Array(Module.HEAPU8.buffer, srcPointer, srcSize).set(src);

    const resultSize = Module._compress(destPointer, destSize, srcPointer, srcSize, compressionLevel);
    if (resultSize === -1) throw new Error('Error during compression');

    // `slice`, not `subarray`: the result must outlive the `_free` below and
    // must not alias the wasm heap.
    return new Uint8Array(Module.HEAPU8.buffer, destPointer, resultSize).slice();
  } finally {
    Module._free(srcPointer);
    Module._free(destPointer);
  }
}

/**
 * @param {Uint8Array} src
 * @param {number} destSize - Decompressed size; zstd needs it up front here.
 * @returns {Uint8Array}
 */
export function decompress(src, destSize) {
  ensureLoaded();
  const srcSize = src.byteLength;

  const srcPointer = Module._malloc(srcSize);
  const destPointer = Module._malloc(destSize);
  try {
    new Uint8Array(Module.HEAPU8.buffer, srcPointer, srcSize).set(src);

    const resultSize = Module._decompress(destPointer, destSize, srcPointer, srcSize);
    if (resultSize === -1) throw new Error('Error during decompression');

    return new Uint8Array(Module.HEAPU8.buffer, destPointer, resultSize).slice();
  } finally {
    Module._free(srcPointer);
    Module._free(destPointer);
  }
}
