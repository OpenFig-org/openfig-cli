/**
 * The browser measurement realm: an iframe holding the export, exposed as a
 * `Surface` (see `../core/host-contract.mjs`).
 *
 * The Node analogue is `../playwright-layout.mjs`. Everything that is not
 * environment-specific — the fit correction, the font preload, the settle
 * ordering — lives in `../core/measurement-surface.mjs` and runs against
 * either host unchanged.
 *
 * Three properties of this file are load-bearing and each has a comment
 * saying so, because getting any of them wrong produces plausible geometry
 * rather than an error:
 *
 *   1. `evaluate` passes the *iframe's* `document`/`window`/`getComputedStyle`
 *      in through the payload argument. A payload that closed over its
 *      globals would bind them to the host page and measure the host's DOM.
 *   2. `resize` resizes an element, not a window, so an outer container can
 *      clamp it. The requested size is asserted against the realm's own
 *      `innerWidth`/`innerHeight` afterwards.
 *   3. `settle` races the double-rAF against a timer. rAF does not fire in a
 *      backgrounded tab, and this is called from inside the fit loop.
 */

// Scrollbars are the only legitimate reason the realm's inner size may differ
// from the size we asked the element to be. Anything larger means something
// clamped the iframe, and every coordinate measured afterwards would be
// uniformly wrong — the 0.5.0 failure, re-created from the other side.
const CLAMP_TOLERANCE_PX = 24;

// A backgrounded tab never runs rAF, and the fit loop calls `settle` up to
// five times. Bounded so a tabbed-away conversion finishes rather than hangs.
const SETTLE_TIMEOUT_MS = 1000;

// A stylesheet that never loads must not block the conversion; `loadWebFont`
// is best-effort by contract.
const WEB_FONT_TIMEOUT_MS = 10_000;

const IFRAME_LOAD_TIMEOUT_MS = 30_000;

// Applied with `important` so a host page's stylesheet cannot reach in and
// clamp, transform, or pad the surface. `zoom` and `transform` in particular
// would scale the realm without changing its inner size, which is invisible to
// the assertion in `applySize`.
const PINNED_STYLE = {
  position: 'fixed',
  left: '0px',
  top: '0px',
  margin: '0px',
  padding: '0px',
  border: '0px none',
  'box-sizing': 'content-box',
  transform: 'none',
  zoom: '1',
  'max-width': 'none',
  'max-height': 'none',
  'min-width': '0px',
  'min-height': '0px',
  // Not `display: none`, `visibility: hidden`, or a position far offscreen:
  // all three let Chromium throttle rendering for the frame, which stalls the
  // rAF pair `settle()` waits on and delays the layout we are here to read.
  // Transparent and non-interactive keeps it invisible while still rendered.
  opacity: '0',
  'pointer-events': 'none',
  'z-index': '-2147483648',
};

function pin(el, prop, value) {
  el.style.setProperty(prop, value, 'important');
}

function applySize(iframe, { width, height }) {
  pin(iframe, 'width', `${width}px`);
  pin(iframe, 'height', `${height}px`);
}

function assertRealmSize(iframe, requested) {
  const win = iframe.contentWindow;
  if (!win) throw new Error('openfig: the measurement iframe lost its browsing context');
  const dw = Math.abs(win.innerWidth - requested.width);
  const dh = Math.abs(win.innerHeight - requested.height);
  if (dw > CLAMP_TOLERANCE_PX || dh > CLAMP_TOLERANCE_PX) {
    throw new Error(
      `openfig: the measurement surface did not lay out at the size it was given ` +
      `(asked for ${requested.width}x${requested.height}, the realm reports ` +
      `${win.innerWidth}x${win.innerHeight}). Something in the host page is clamping ` +
      'the iframe — a max-width, a flex or grid parent, or a transform on an ancestor. ' +
      'Measuring anyway would scale every coordinate uniformly.',
    );
  }
}

function nextFrame(win) {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(finish, SETTLE_TIMEOUT_MS);
    try {
      win.requestAnimationFrame(finish);
    } catch {
      finish();
    }
  });
}

/**
 * Open a standalone export in an iframe and wrap it as a `Surface`.
 *
 * The export arrives as text rather than a path, so it is written straight
 * into an `about:blank` frame. Not `srcdoc` — the whole document would have to
 * be attribute-escaped and exports run to megabytes; not a `data:` URL — Chrome
 * refuses to navigate a frame to one; and not a `blob:` URL, which was the
 * first choice and works locally but is *navigation*, so it needs `frame-src
 * blob:`. Under a policy of `default-src 'self'` — which is what a Claude
 * artifact serves — the frame is blocked outright. Measured, with the page
 * reporting `frame-src <- blob`.
 *
 * Writing into `about:blank` involves no URL at all, so neither `frame-src`
 * nor `connect-src` applies, and the frame still inherits the creating
 * document's origin, which is what makes `contentDocument` readable.
 *
 * @param {object} init
 * @param {string} init.sourceHtml - The export, as authored.
 * @param {{width: number, height: number}} init.viewport
 * @param {Document} [init.ownerDocument] - Defaults to the ambient document.
 * @param {Element} [init.container] - Defaults to `ownerDocument.body`.
 * @returns {Promise<import('../core/host-contract.mjs').Surface>}
 */
export async function openIframeSurface({ sourceHtml, viewport, ownerDocument, container }) {
  const hostDoc = ownerDocument ?? globalThis.document;
  if (!hostDoc) throw new Error('openfig: openIframeSurface needs a DOM document');

  let size = { ...viewport };
  const iframe = hostDoc.createElement('iframe');
  for (const [prop, value] of Object.entries(PINNED_STYLE)) pin(iframe, prop, value);
  applySize(iframe, size);
  // Deprecated but still honoured by Chromium, and the only way to keep
  // scrollbars from eating into the realm's inner size.
  iframe.setAttribute('scrolling', 'no');
  iframe.setAttribute('aria-hidden', 'true');
  iframe.setAttribute('title', 'openfig measurement surface');

  // Appended before writing: a frame has no document until it is in one.
  (container ?? hostDoc.body).appendChild(iframe);

  const cleanup = () => iframe.remove();

  const frameDoc = iframe.contentDocument;
  if (!frameDoc) {
    cleanup();
    throw new Error('openfig: the measurement surface could not be created');
  }

  try {
    frameDoc.open();
    frameDoc.write(sourceHtml);
    frameDoc.close();
  } catch (err) {
    cleanup();
    throw new Error(`openfig: the export could not be written into the measurement surface: ${err.message}`);
  }

  // `document.write` completes synchronously, but the export's own runtime
  // rehydrates afterwards. Wait for the document to finish parsing rather than
  // for a `load` event, which a written frame does not fire the same way.
  await new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`openfig: the export did not load within ${IFRAME_LOAD_TIMEOUT_MS}ms`)),
      IFRAME_LOAD_TIMEOUT_MS,
    );
    const done = () => { clearTimeout(timer); resolve(); };
    if (frameDoc.readyState === 'complete') return done();
    iframe.contentWindow?.addEventListener('load', done, { once: true });
    frameDoc.addEventListener('DOMContentLoaded', done, { once: true });
  }).catch((err) => { cleanup(); throw err; });

  if (!iframe.contentDocument || !iframe.contentWindow) {
    cleanup();
    throw new Error(
      'openfig: the measurement surface is not same-origin, so its document cannot be read. ' +
      'Extraction needs direct access to the export\'s DOM.',
    );
  }

  const realmOf = () => {
    const doc = iframe.contentDocument;
    const win = iframe.contentWindow;
    if (!doc || !win) throw new Error('openfig: the measurement surface has been closed');
    return {
      document: doc,
      window: win,
      // Bound to the window being measured. The host's own works cross-realm
      // in Chromium and returns identical values, but `el.ownerDocument
      // .defaultView.getComputedStyle` is the form the spec guarantees, and
      // the payloads call it as a free function so it cannot stay unbound.
      getComputedStyle: win.getComputedStyle.bind(win),
    };
  };

  return {
    // The realm goes in through the payload's single argument, exactly as the
    // Node surface passes its `JSHandle`. Playwright serialises the payload
    // across a process boundary, so `arg` in and the result out are cloned
    // here too: otherwise a payload that mutated `arg` or returned a live node
    // would work in the browser and fail in Node, and Node is the reference.
    evaluate: async (fn, arg) => {
      const result = await fn({
        realm: realmOf(),
        arg: arg === undefined ? undefined : structuredClone(arg),
      });
      return result === undefined ? undefined : structuredClone(result);
    },

    // Resizing an element, not a window. The realm follows — its `innerWidth`
    // tracks the iframe's content box — but nothing stops an outer container
    // from clamping it, so the result is checked rather than assumed.
    resize: async (next) => {
      applySize(iframe, next);
      size = { ...next };
      // Force the host to lay the element out before reading the child's view.
      iframe.getBoundingClientRect();
      const win = iframe.contentWindow;
      if (win && (Math.abs(win.innerWidth - next.width) > CLAMP_TOLERANCE_PX
        || Math.abs(win.innerHeight - next.height) > CLAMP_TOLERANCE_PX)) {
        // One frame for the child's own resize handling to run before judging.
        await nextFrame(win);
      }
      assertRealmSize(iframe, next);
    },

    // The size we asked for, not a measured one — same as the Node surface.
    // `fitSurfaceToCanvas` divides by a scale derived from this, so a measured
    // value would fold the very error the fit exists to remove back in.
    viewport: () => ({ ...size }),

    settle: async () => {
      const win = iframe.contentWindow;
      if (!win) return;
      await nextFrame(win);
      await nextFrame(win);
    },

    waitForSelector: (selector, o = {}) => new Promise((resolve, reject) => {
      const timeout = o.timeout ?? 30_000;
      const doc = iframe.contentDocument;
      const win = iframe.contentWindow;
      if (!doc || !win) return reject(new Error('openfig: the measurement surface has been closed'));
      // Synchronous first look: a fast export can have finished rehydrating
      // before this is ever called, and a MutationObserver only reports
      // mutations that happen after it starts observing.
      if (doc.querySelector(selector)) return resolve();

      let observer = null;
      let timer = null;
      const finish = (err) => {
        observer?.disconnect();
        clearTimeout(timer);
        if (err) reject(err); else resolve();
      };
      timer = setTimeout(() => finish(new Error(
        `openfig: timed out after ${timeout}ms waiting for "${selector}" in the export. ` +
        'The export rehydrates itself from its own inline scripts, so a content-security ' +
        'policy without \'unsafe-inline\' for script-src leaves the document empty.',
      )), timeout);
      // The realm's own MutationObserver, for the same reason `evaluate` uses
      // the realm's globals.
      observer = new win.MutationObserver(() => {
        if (iframe.contentDocument?.querySelector(selector)) finish(null);
      });
      observer.observe(doc.documentElement, { childList: true, subtree: true });
    }),

    // Best effort by contract: resolves on load *or* error, and on a timer, so
    // a family Google Fonts does not host cannot stall the conversion.
    // Rejects on failure, matching Playwright's `addStyleTag`. It is still
    // best-effort *for the conversion* — the caller catches and carries on —
    // but the caller has to be able to tell, because a font that silently
    // fails to load means text is measured in a substitute while the deck
    // names the original. Resolving on error made that undetectable.
    loadWebFont: (family, cssUrl) => new Promise((resolve, reject) => {
      const doc = iframe.contentDocument;
      if (!doc) return reject(new Error(`loadWebFont(${family}): the surface has no document`));
      const link = doc.createElement('link');
      link.rel = 'stylesheet';
      link.href = cssUrl;
      let done = false;
      const settle = (err) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (err) reject(err); else resolve();
      };
      const timer = setTimeout(
        () => settle(new Error(`loadWebFont(${family}): timed out after ${WEB_FONT_TIMEOUT_MS}ms`)),
        WEB_FONT_TIMEOUT_MS,
      );
      link.addEventListener('load', () => settle(), { once: true });
      link.addEventListener('error', () => settle(new Error(`loadWebFont(${family}): stylesheet failed to load`)), { once: true });
      (doc.head ?? doc.documentElement).appendChild(link);
    }),

    // Matches Playwright's `page.content()` byte for byte: the serialised
    // doctype, if there is one, immediately followed by the root element. The
    // handoff stage only regex-scans this string, but the parity harness
    // diffs it.
    content: async () => {
      const doc = iframe.contentDocument;
      if (!doc) throw new Error('openfig: the measurement surface has been closed');
      let out = '';
      if (doc.doctype) out += new XMLSerializer().serializeToString(doc.doctype);
      if (doc.documentElement) out += doc.documentElement.outerHTML;
      return out;
    },

    close: async () => {
      cleanup();
    },
  };
}
