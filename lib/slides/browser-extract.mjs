export async function extractSlides(page, opts = {}) {
  const flexAutoLayout = Boolean(opts.flexAutoLayout ?? process.env.OPENFIG_FLEX_AUTO_LAYOUT);
  return await page.evaluate((extractOpts) => {
    const flexAutoLayoutEnabled = !!extractOpts.flexAutoLayout;
    const CANVAS_W = 1920;
    const CANVAS_H = 1080;

    const sections = Array.from(document.querySelectorAll('section'));
    if (sections.length === 0) return { slides: [] };

    const results = [];
    for (let i = 0; i < sections.length; i++) {
      const sec = sections[i];
      const saved = sections.map((s) => ({
        el: s,
        display: s.style.display,
        visibility: s.style.visibility,
        position: s.style.position,
        top: s.style.top,
        left: s.style.left,
        width: s.style.width,
        height: s.style.height,
        overflow: s.style.overflow,
      }));
      for (const s of sections) {
        if (s === sec) {
          s.style.display = 'block';
          s.style.visibility = 'visible';
          s.style.position = 'absolute';
          s.style.top = '0px';
          s.style.left = '0px';
          s.style.width = CANVAS_W + 'px';
          s.style.height = CANVAS_H + 'px';
          s.style.overflow = 'visible';
        } else {
          s.style.display = 'none';
        }
      }
      document.body.offsetHeight;
      results.push(collectSection(sec, i));
      for (const { el, display, visibility, position, top, left, width, height, overflow } of saved) {
        el.style.display = display;
        el.style.visibility = visibility;
        el.style.position = position;
        el.style.top = top;
        el.style.left = left;
        el.style.width = width;
        el.style.height = height;
        el.style.overflow = overflow;
      }
    }

    // Collect CSS custom properties from :root so the Node side can
    // resolve `var(--name)` references that Chromium leaves literal in
    // inline SVG attributes (e.g. fill="var(--accent)"). getComputedStyle
    // on the documentElement exposes every declared `--foo` in resolved
    // form.
    const cssVars = {};
    const rootCs = getComputedStyle(document.documentElement);
    for (let i = 0; i < rootCs.length; i++) {
      const prop = rootCs[i];
      if (prop.startsWith('--')) {
        cssVars[prop] = rootCs.getPropertyValue(prop).trim();
      }
    }

    return { slides: results, cssVars };

    function collectSection(root, index) {
      const secRect = root.getBoundingClientRect();
      const off = { x: secRect.left, y: secRect.top };
      const elements = [];
      const warnings = [];

      // currentTarget is the array that emissions push into. Defaults to the
      // slide's top-level `elements`. When walk() enters a flex/grid element
      // (and flexAutoLayoutEnabled is on), it creates a `layoutContainer` node,
      // pushes it to currentTarget, then routes descendant emissions into the
      // container's own `children` array. Elements with position:absolute/fixed
      // escape back to slide top-level regardless of surrounding containers.
      let currentTarget = elements;
      function pushElement(e) { currentTarget.push(e); }

      walk(root);
      insetTextsBehindLeftMarkers(elements);

      return {
        index,
        dataLabel: root.getAttribute('data-label'),
        background: getComputedStyle(root).backgroundColor,
        elements,
        warnings,
      };

      // Walk the emitted tree (top-level + nested layoutContainer children)
      // looking for bullet-marker ellipses whose left edge collides with a
      // text element's left edge. When found, inset the text past the marker
      // so the dot is not visually overlapped by the first word. We only move
      // the left edge — preserving the text's right edge and width preserves
      // the source's wrapping intent (e.g. an orphan <p> intended to span
      // full slide width remains full-width).
      function insetTextsBehindLeftMarkers(nodes) {
        const BULLET_GAP = 10;
        const inflow = (nodes ?? []).filter(Boolean);
        for (const marker of inflow) {
          if (!marker || !marker._leftMarker) continue;
          const my0 = marker.y;
          const my1 = marker.y + marker.height;
          const mx0 = marker.x;
          const mx1 = marker.x + marker.width;
          for (const el of inflow) {
            if (el === marker) continue;
            if (el.type !== 'text' && el.type !== 'richText') continue;
            if (typeof el.x !== 'number' || typeof el.width !== 'number') continue;
            const ey0 = el.y;
            const ey1 = el.y + (el.height ?? 0);
            const verticalOverlap = Math.min(ey1, my1) - Math.max(ey0, my0);
            if (verticalOverlap <= 0) continue;
            if (Math.abs(el.x - mx0) > 2) continue;
            const inset = mx1 - el.x + BULLET_GAP;
            el.x = el.x + inset;
            el.width = Math.max(0, el.width - inset);
          }
        }
        for (const el of inflow) {
          if (el && el.type === 'layoutContainer' && Array.isArray(el.children)) {
            insetTextsBehindLeftMarkers(el.children);
          }
          if (el) delete el._leftMarker;
        }
      }

      function toLocal(rect) {
        return {
          x: rect.left - off.x,
          y: rect.top - off.y,
          width: rect.width,
          height: rect.height,
        };
      }

      function walk(el) {
        if (!el || el.nodeType !== 1) return;
        const tag = el.tagName.toUpperCase();
        if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'TEMPLATE' || tag === 'HEAD') return;

        const cs = getComputedStyle(el);
        if (cs.display === 'none' || cs.visibility === 'hidden') return;

        const rect = toLocal(el.getBoundingClientRect());
        if (rect.width === 0 && rect.height === 0 && tag !== 'SECTION') {
          return;
        }

        // Absolute-positioned subtrees escape any surrounding Auto Layout
        // container: their emissions (and descendants') route to slide root
        // so their authored x/y coordinates are preserved verbatim.
        const positionKind = cs.position;
        const escapesContainer = positionKind === 'absolute' || positionKind === 'fixed';
        const savedTargetEntry = currentTarget;
        if (escapesContainer) currentTarget = elements;
        try {

        emitPseudo(el, cs, '::before', rect);

        if (tag === 'IMG') {
          const src = el.getAttribute('src');
          if (src) {
            pushElement({
              type: 'image',
              src,
              x: rect.x, y: rect.y, width: rect.width, height: rect.height,
              objectFit: cs.objectFit || 'contain',
              opacity: cs.opacity,
            });
          } else {
            warnings.push({ msg: '<img> without src — dropped', sample: elPath(el) });
          }
        } else if (tag === 'SVG' || tag === 'svg') {
          // CSS `opacity` cascades as a group effect — the SVG's own computed
          // opacity is 1, but an ancestor like `.s1-deco { opacity: 0.12 }`
          // fades everything inside. Climb to the slide <section> multiplying
          // opacities so decorative SVGs render at the right visual weight.
          let eff = 1;
          for (let a = el; a && a.tagName?.toUpperCase() !== 'SECTION'; a = a.parentElement) {
            const ocs = getComputedStyle(a);
            const op = parseFloat(ocs.opacity);
            if (!Number.isNaN(op)) eff *= op;
          }
          pushElement({
            type: 'svg',
            x: rect.x, y: rect.y, width: rect.width, height: rect.height,
            viewBox: el.getAttribute('viewBox') || `0 0 ${rect.width} ${rect.height}`,
            inline: el.outerHTML,
            ...(eff < 1 ? { opacity: eff } : {}),
          });
        } else {
          if (tag !== 'SECTION') maybeEmitShape(el, cs, rect);
          collectWarnings(el, cs);

          if (tag === 'SECTION') {
            for (const c of el.children) walk(c);
          } else {
            const role = classifyTextRole(el);
            if (role === 'leaf') {
              emitTextLeaf(el, cs, rect);
            } else if (role === 'mixed-inline') {
              emitInlineRuns(el, cs);
            } else {
              // role === 'container'. When enabled and the element lays out
              // its children via flex or single-axis grid, emit a
              // `layoutContainer` node and route descendant emissions into its
              // own `children` array. The handoff renders this as a Figma
              // Auto Layout frame; Chromium↔Figma glyph-metric divergence is
              // absorbed by re-flow inside the frame instead of causing a
              // child to cross a sibling's pre-computed coordinate.
              const wrap = flexAutoLayoutEnabled
                ? maybeBuildLayoutContainer(el, cs, rect)
                : null;
              if (wrap) {
                pushElement(wrap);
                const savedChildTarget = currentTarget;
                currentTarget = wrap.children;
                try {
                  for (const c of el.children) walk(c);
                  emitDirectTextInContainer(el, cs);
                } finally {
                  currentTarget = savedChildTarget;
                }
                // Reconcile the declared CSS `gap` against the actual
                // inter-emitted-child spacing. DOM children can be back-to-
                // back with gap=0 while the text RUNS inside them are
                // visually separated by padding / fixed-width / margins.
                // Auto Layout would otherwise pack the emitted text runs
                // with no space (e.g. "1Executive Summary"). Use the
                // measured spacing between emitted siblings instead.
                reconcileActualGap(wrap);
                // Post-emit overlap check. The pre-emit childrenMatchDeclaredGap
                // only sees the DOM children of `el`. But when a DOM child is
                // itself a composite (e.g. an icon whose background ellipse +
                // rotated bars both end up in our layoutContainer.children via
                // the maybeEmitShape + child-walk path), the EMITTED children
                // can overlap even if the DOM children don't. If so, unwrap.
                if (emittedChildrenOverlap(wrap)) {
                  const idx = savedChildTarget.lastIndexOf(wrap);
                  if (idx !== -1) {
                    savedChildTarget.splice(idx, 1, ...wrap.children);
                  }
                }
              } else {
                for (const c of el.children) walk(c);
                // Flex/block containers can also hold direct text adjacent to
                // block children (e.g. a legend row with a colored swatch div
                // plus a plain "Measured demand" label). The for-children loop
                // above only visits Element nodes, so direct text would otherwise
                // be lost. Emit each non-empty text node as its own text leaf.
                emitDirectTextInContainer(el, cs);
              }
            }
          }
        }

        emitPseudo(el, cs, '::after', rect);

        } finally {
          currentTarget = savedTargetEntry;
        }
      }

      // Returns a layoutContainer descriptor for a flex / single-axis-grid
      // element, or null if the element should be emitted flat (2-D grid,
      // unmapped justify-content). The returned object has an empty
      // `children` array that the caller fills by recursion.
      function maybeBuildLayoutContainer(el, cs, rect) {
        const d = cs.display;
        const isFlex = d === 'flex';
        // Grids are intentionally NOT wrapped. CSS grid with
        // `grid-template-columns: auto 1fr` and implicit rows is effectively
        // 2-D — Figma Auto Layout has no 2-D equivalent. Wrapping flattens
        // children into a single axis, which wrecks charts whose axis labels
        // sit at authored x/y inside the grid cell. Flex is a direct
        // analogue of Auto Layout; grid is not.
        if (!isFlex) return null;

        const direction = (cs.flexDirection || '').startsWith('column') ? 'COLUMN' : 'ROW';

        const gap = parseFloat(cs.rowGap || cs.columnGap || cs.gap || '0') || 0;
        const primary = mapJustifyContent(cs.justifyContent);
        if (primary === null) return null; // unsupported; fall back to flat

        // Only wrap when the authored flex layout is actually uniform. A flex
        // container used as a positioning scaffold (e.g. a chart whose title,
        // SVG, and legend sit at irregular y-offsets inside it) will have
        // children whose inter-gaps diverge from the declared `gap` property.
        // Auto Layout imposes uniform spacing, so wrapping these breaks
        // visual composition. Fall back to flat emission in that case.
        if (!childrenMatchDeclaredGap(el, direction, gap)) return null;

        // Skip wrapping when the flex subtree contains an SVG. handleSvg
        // decomposes the SVG into per-shape addText / addPath calls, so
        // inside an Auto Layout frame each shape becomes its own Auto Layout
        // sibling — chart axis labels end up stacked vertically instead of
        // positioned inside the chart. These containers are almost always
        // charts or diagrams that rely on internal absolute positioning.
        if (containsSvgDescendant(el)) return null;

        return {
          type: 'layoutContainer',
          direction,
          gap,
          x: rect.x, y: rect.y, width: rect.width, height: rect.height,
          paddingTop: pxFromCs(cs.paddingTop),
          paddingRight: pxFromCs(cs.paddingRight),
          paddingBottom: pxFromCs(cs.paddingBottom),
          paddingLeft: pxFromCs(cs.paddingLeft),
          primaryAxisAlignItems: primary,
          counterAxisAlignItems: mapAlignItems(cs.alignItems),
          children: [],
        };
      }

      // CSS align-items → Figma counterAxisAlignItems.
      // Figma has MIN / CENTER / MAX / BASELINE. CSS `baseline` maps directly.
      // CSS `stretch` has no Figma equivalent on counter-axis sizing mode; we
      // fall back to MIN (top) which is the closest neutral.
      function mapAlignItems(ai) {
        switch (ai) {
          case 'center': return 'CENTER';
          case 'flex-end':
          case 'end':
            return 'MAX';
          case 'baseline':
          case 'first baseline':
          case 'last baseline':
            return 'BASELINE';
          case 'flex-start':
          case 'start':
          case 'stretch':
          default:
            return 'MIN';
        }
      }

      // Returns true iff the in-flow children of `el` are spaced along
      // `direction` with a gap within 8px of the declared `gap`. Children
      // with position:absolute/fixed are excluded — they escape to slide root
      // in walk(). A single in-flow child trivially matches. Elements with
      // no in-flow children are considered non-auto-layoutable (the wrapping
      // adds no value and risks breaking other layers).
      function childrenMatchDeclaredGap(el, direction, gap) {
        const inflow = [];
        for (const c of el.children) {
          const ccs = getComputedStyle(c);
          if (ccs.display === 'none' || ccs.visibility === 'hidden') continue;
          if (ccs.position === 'absolute' || ccs.position === 'fixed') continue;
          inflow.push(c);
        }
        // A flex container with fewer than 2 in-flow children serves no
        // Auto Layout purpose — there is nothing to flow against. Wrapping
        // the lone child adds a phantom parent frame whose hover-bounds are
        // bigger than the child's select-bounds, which reads as a bug in
        // Figma. Fall back to flat emission so the child is placed at its
        // own rect.
        if (inflow.length < 2) return false;
        const axisStart = direction === 'ROW' ? 'left' : 'top';
        const axisSize = direction === 'ROW' ? 'width' : 'height';
        for (let i = 1; i < inflow.length; i++) {
          const prev = inflow[i - 1].getBoundingClientRect();
          const cur = inflow[i].getBoundingClientRect();
          const prevEnd = prev[axisStart] + prev[axisSize];
          const curStart = cur[axisStart];
          const actual = curStart - prevEnd;
          // Overlap on the flex axis means the container is being used as a
          // positioning scaffold (e.g. an icon where a red dot has two
          // rotated bars overlaid to form an X). Auto Layout would lay those
          // overlapping children out as side-by-side siblings, splitting the
          // icon into a scattered row. Fall back to flat emission.
          if (actual < -2) return false;
          if (Math.abs(actual - gap) > 8) return false;
        }
        return true;
      }

      // After children are emitted, replace the CSS-declared `gap` with
      // the actual measured inter-child spacing along the flex axis. This
      // handles the common pattern where a flex container has gap=0 but
      // children have internal padding / min-width / fixed-width that
      // creates visual spacing between the TEXT RUNS inside them. Without
      // this step, Auto Layout packs text runs back-to-back and collapses
      // authored visual gaps (e.g. TOC "1   Executive Summary" rendering
      // as "1Executive Summary"). Uses the median of pairwise gaps so an
      // odd outlier doesn't skew the result.
      function reconcileActualGap(wrap) {
        const kids = wrap.children ?? [];
        if (kids.length < 2) return;
        const axisStart = wrap.direction === 'ROW' ? 'x' : 'y';
        const axisSize = wrap.direction === 'ROW' ? 'width' : 'height';
        const gaps = [];
        for (let i = 1; i < kids.length; i++) {
          const prev = kids[i - 1];
          const cur = kids[i];
          if (typeof prev?.[axisStart] !== 'number') return;
          if (typeof cur?.[axisStart] !== 'number') return;
          const g = cur[axisStart] - (prev[axisStart] + (prev[axisSize] ?? 0));
          if (g < 0) return; // overlap — let emittedChildrenOverlap unwrap
          gaps.push(g);
        }
        if (gaps.length === 0) return;
        gaps.sort((a, b) => a - b);
        wrap.gap = Math.round(gaps[Math.floor(gaps.length / 2)]);
      }

      // After emission, verify no two children overlap on the flex axis.
      // Auto Layout would lay overlapping children out as side-by-side
      // siblings, which breaks composite icons (e.g. a red ✗ made from a
      // circle + two rotated bars: the bars overlap the circle on the ROW
      // axis). Nested layoutContainers are checked by their own x/width
      // (not their descendants').
      function emittedChildrenOverlap(wrap) {
        const children = wrap.children ?? [];
        if (children.length < 2) return false;
        const axisStart = wrap.direction === 'ROW' ? 'x' : 'y';
        const axisSize = wrap.direction === 'ROW' ? 'width' : 'height';
        for (let i = 1; i < children.length; i++) {
          const prev = children[i - 1];
          const cur = children[i];
          if (typeof prev?.[axisStart] !== 'number') continue;
          if (typeof cur?.[axisStart] !== 'number') continue;
          const prevEnd = prev[axisStart] + (prev[axisSize] ?? 0);
          const curStart = cur[axisStart];
          if (curStart - prevEnd < -2) return true;
        }
        return false;
      }

      function containsSvgDescendant(el) {
        if (!el) return false;
        if (el.querySelector && el.querySelector('svg')) return true;
        return false;
      }

      function mapJustifyContent(jc) {
        switch ((jc || 'flex-start').trim()) {
          case 'flex-start':
          case 'start':
          case 'left':
          case 'normal':
            return 'MIN';
          case 'center':
            return 'CENTER';
          case 'flex-end':
          case 'end':
          case 'right':
            return 'MAX';
          case 'space-between':
            return 'SPACE_BETWEEN';
          default:
            return null; // space-around, space-evenly → fall back
        }
      }

      function classifyTextRole(el) {
        let hasDirectText = false;
        let hasBlockChild = false;
        let hasInlineChild = false;
        let hasVisualChild = false;

        for (const c of el.childNodes) {
          if (c.nodeType === 3) {
            if (c.textContent && c.textContent.trim()) hasDirectText = true;
          } else if (c.nodeType === 1) {
            const ct = c.tagName.toUpperCase();
            if (ct === 'BR') continue;
            if (ct === 'SCRIPT' || ct === 'STYLE' || ct === 'TEMPLATE') continue;
            const ccs = getComputedStyle(c);
            if (ccs.display === 'none') continue;
            if (ct === 'SVG' || ct === 'IMG' || ct === 'CANVAS' || ct === 'VIDEO') {
              hasVisualChild = true;
            }
            // Empty inline element whose geometry + fill/border come purely
            // from CSS (e.g. a colour swatch <span>) is a visual child too.
            // Without this, an ancestor like <td> classifies as a text "leaf"
            // and emitTextLeaf silently drops the span without walking it,
            // so the swatch never emits a rect.
            if (isCssOnlyVisual(c, ccs)) hasVisualChild = true;
            if (['inline', 'inline-block', 'inline-flex'].includes(ccs.display)) {
              hasInlineChild = true;
            } else {
              hasBlockChild = true;
            }
          }
        }

        if (hasBlockChild) return 'container';
        if (hasVisualChild) return 'container';
        if (!hasDirectText && !hasInlineChild) return 'container';

        if (hasInlineChild && divergent(el)) return 'mixed-inline';
        return 'leaf';
      }

      function isCssOnlyVisual(c, ccs) {
        const text = (c.textContent || '').trim();
        if (text) return false;
        // Has the element got any non-text children that would themselves
        // render? If so leave classification to the normal path.
        for (const cc of c.childNodes) {
          if (cc.nodeType === 1) return false;
        }
        const w = pxFromCs(ccs.width);
        const h = pxFromCs(ccs.height);
        if (w <= 0 || h <= 0) {
          const rect = c.getBoundingClientRect && c.getBoundingClientRect();
          if (!rect || rect.width <= 0 || rect.height <= 0) return false;
        }
        if (isVisibleColor(ccs.backgroundColor)) return true;
        const borderW = pxFromCs(ccs.borderTopWidth) + pxFromCs(ccs.borderRightWidth)
          + pxFromCs(ccs.borderBottomWidth) + pxFromCs(ccs.borderLeftWidth);
        if (borderW > 0) return true;
        return false;
      }

      function divergent(el) {
        const pcs = getComputedStyle(el);
        const ref = {
          fontSize: pcs.fontSize,
          color: pcs.color,
          fontWeight: pcs.fontWeight,
          fontStyle: pcs.fontStyle,
        };
        for (const c of el.childNodes) {
          if (c.nodeType !== 1) continue;
          if (c.tagName.toUpperCase() === 'BR') continue;
          const ccs = getComputedStyle(c);
          if (ccs.display === 'none') continue;
          if (
            ccs.fontSize !== ref.fontSize ||
            ccs.color !== ref.color ||
            ccs.fontWeight !== ref.fontWeight ||
            ccs.fontStyle !== ref.fontStyle
          ) {
            return true;
          }
        }
        return false;
      }

      function countTextLines(el) {
        const range = document.createRange();
        range.selectNodeContents(el);
        const rects = range.getClientRects();
        if (rects.length <= 1) return rects.length;
        const tops = new Set();
        for (const rc of rects) tops.add(Math.round(rc.top));
        return tops.size;
      }

      // For elements classified as 'container' that also carry direct text
      // nodes in childNodes (flex row with an element sibling + a raw text
      // label). Each non-empty direct text node becomes its own text leaf,
      // positioned via a Range on that node so the rect is tight to the
      // rendered glyphs. Whitespace-only text nodes are skipped.
      function emitDirectTextInContainer(el, cs) {
        for (const c of el.childNodes) {
          if (c.nodeType !== 3) continue;
          const text = collapseText(c.textContent);
          if (!text) continue;
          const range = document.createRange();
          range.selectNode(c);
          const tr = range.getBoundingClientRect();
          if (tr.width === 0 && tr.height === 0) continue;
          const style = textStyle(cs);
          const el2 = {
            type: 'text',
            text,
            x: tr.left - off.x,
            y: tr.top - off.y,
            width: tr.width,
            height: tr.height,
            ...style,
          };
          // Text next to a block sibling in a flex row is effectively
          // single-line; prevent Figma from wrapping it.
          const lineTops = new Set();
          for (const lr of range.getClientRects()) lineTops.add(Math.round(lr.top));
          if (lineTops.size <= 1 && !style.align) el2.noWrap = true;
          pushElement(el2);
        }
      }

      function emitTextLeaf(el, cs, rect) {
        const hasHardBreak = [...el.childNodes].some(
          (c) => c.nodeType === 1 && c.tagName?.toUpperCase?.() === 'BR',
        );
        const text = hasHardBreak
          ? collapseTextPreservingBreaks(el.innerText ?? el.textContent ?? '')
          : collapseText(el.innerText ?? el.textContent ?? '');
        if (!text) return;
        const lines = countTextLines(el);
        const style = textStyle(cs);
        const el2 = {
          type: 'text',
          text,
          x: rect.x, y: rect.y, width: rect.width, height: rect.height,
          ...style,
        };
        const range = document.createRange();
        range.selectNodeContents(el);
        const rangeRects = [...range.getClientRects()];
        if (lines === 1 && !style.align) {
          const tr = range.getBoundingClientRect();
          const textW = tr.width;
          if (textW > 0 && Math.abs(textW - rect.width) < 2) {
            el2.noWrap = true;
          } else if (textW > 0 && textW < rect.width) {
            el2.x = tr.left - off.x;
            el2.y = tr.top - off.y;
            el2.width = tr.width;
            el2.height = tr.height;
            el2.noWrap = true;
          }
        } else if (hasHardBreak && !style.align) {
          let widest = 0;
          for (const r of rangeRects) if (r.width > widest) widest = r.width;
          if (widest > 0) {
            const padded = Math.ceil(widest * 1.08) + 4;
            if (padded > el2.width) el2.width = padded;
          }
          // Preserve authored line breaks while preventing Figma from
          // wrapping each line again with slightly different font metrics.
          el2.noWrap = true;
        }
        // Deliberately no padding for multi-line leaves: if Figma's wider
        // font metrics force one extra wrap, the paragraph grows by a line,
        // which is acceptable. Widening the box past its measured rect
        // breaks column layouts (box bleeds into the next column).
        pushElement(el2);
      }

      function squishInline(s) {
        return String(s || '').replace(/\s+/g, ' ');
      }

      function emitInlineRuns(el, parentCs) {
        emitInlineAsRichText(el, parentCs);
      }

      function emitInlineAsRichText(el, parentCs) {
        const runs = [];
        let hasHardBreak = false;
        for (const c of el.childNodes) {
          if (c.nodeType === 3) {
            const raw = squishInline(c.textContent);
            if (!raw) continue;
            runs.push({
              text: raw,
              ...runStyle(parentCs),
            });
          } else if (c.nodeType === 1) {
            const ct = c.tagName.toUpperCase();
            if (ct === 'BR') { runs.push({ text: '\n' }); hasHardBreak = true; continue; }
            if (ct === 'SCRIPT' || ct === 'STYLE' || ct === 'TEMPLATE') continue;
            const ccs = getComputedStyle(c);
            if (ccs.display === 'none' || ccs.visibility === 'hidden') continue;
            const raw = squishInline(c.textContent ?? '');
            if (!raw) continue;
            runs.push({
              text: raw,
              ...runStyle(ccs),
            });
          }
        }
        if (runs.length === 0) return;
        const rect = toLocal(el.getBoundingClientRect());
        const el2 = {
          type: 'richText',
          runs,
          x: rect.x, y: rect.y, width: rect.width, height: rect.height,
          ...textStyle(parentCs),
        };
        // Figma's font metrics often come out a few pixels wider than
        // Chromium's for the same string. A box Chromium sized tight will
        // then wrap a single line into two (e.g. "847TWh" → "847TW" + "h" on
        // the next row). For single-line runs with no hard break, pad the
        // box and mark noWrap so Figma never splits mid-word.
        //
        // Use range.getClientRects() (one rect per visual line) rather than
        // el.getClientRects() — on a block element the latter returns one
        // rect regardless of how many lines the text wraps to, which would
        // misclassify a wrapped paragraph as a single line.
        const range = document.createRange();
        range.selectNodeContents(el);
        const rangeRects = [...range.getClientRects()];
        const tops = new Set();
        for (const rc of rangeRects) tops.add(Math.round(rc.top));
        const lineCount = tops.size;
        if (lineCount === 1 && !hasHardBreak) {
          let widest = 0;
          for (const r of rangeRects) if (r.width > widest) widest = r.width;
          if (widest > 0) {
            const padded = Math.ceil(widest * 1.08) + 4;
            if (padded > el2.width) el2.width = padded;
          }
          el2.noWrap = true;
        }
        pushElement(el2);
      }

      function runStyle(cs) {
        const out = {};
        const w = parseInt(cs.fontWeight, 10);
        if (Number.isFinite(w)) out.weight = w;
        if (cs.fontStyle === 'italic') out.style = 'italic';
        if (cs.color) out.color = cs.color;
        return out;
      }

      function maybeEmitShape(el, cs, rect) {
        if (rect.width <= 0 || rect.height <= 0) return;
        const bg = cs.backgroundColor;
        const hasBg = isVisibleColor(bg);
        const bgImage = cs.backgroundImage;
        const bgLayers = parseBackgroundImage(bgImage, warnings, el);
        const sides = ['top', 'right', 'bottom', 'left']
          .map((side) => ({
            side,
            width: pxFromCs(cs.getPropertyValue(`border-${side}-width`)),
            style: cs.getPropertyValue(`border-${side}-style`),
            color: cs.getPropertyValue(`border-${side}-color`),
          }))
          .filter((b) => b.width > 0 && b.style !== 'none' && isVisibleColor(b.color));

        if (!hasBg && !bgLayers.length && sides.length === 0) return;

        const radius = pxFromCs(cs.borderRadius);
        const minSide = Math.min(rect.width, rect.height);
        const maxSide = Math.max(rect.width, rect.height);
        const isEllipse =
          minSide > 0 &&
          minSide / maxSide >= 0.8 &&
          radius > 0 &&
          radius >= minSide / 2 - 0.5;

        // All four borders identical → emit a single stroked shape instead of
        // four axis-aligned side rects, which can't form a rounded outline.
        const uniformBorder = sides.length === 4
          && sides.every((b) => b.width === sides[0].width && b.color === sides[0].color)
          ? sides[0] : null;

        // Peel an alpha channel off an rgba() background and surface it as
        // element.opacity so api.mjs's parseColor (6-hex-only) still accepts
        // the fill. Skip hex inputs (already opaque).
        let emitFill = hasBg ? bg : undefined;
        let fillAlpha = 1;
        if (hasBg) {
          const m = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)(?:\s*,\s*([\d.]+))?\s*\)$/i.exec(bg);
          if (m) {
            const r = Math.round(parseFloat(m[1]));
            const g = Math.round(parseFloat(m[2]));
            const b = Math.round(parseFloat(m[3]));
            fillAlpha = m[4] !== undefined ? parseFloat(m[4]) : 1;
            emitFill = '#' + [r, g, b].map((n) => n.toString(16).padStart(2, '0')).join('').toUpperCase();
          }
        }

        const blurRadius = parseBlurFilter(cs.filter);
        if (hasBg || bgLayers.length || uniformBorder) {
          const e = {
            type: isEllipse ? 'ellipse' : 'rect',
            x: rect.x, y: rect.y, width: rect.width, height: rect.height,
          };
          if (hasBg) e.fill = emitFill;
          if (hasBg && fillAlpha < 1) e.opacity = fillAlpha;
          if (bgLayers.length) e.backgroundLayers = bgLayers;
          if (radius > 0 && !isEllipse) e.cornerRadius = radius;
          if (uniformBorder) {
            e.stroke = uniformBorder.color;
            e.strokeWidth = uniformBorder.width;
          }
          if (blurRadius != null) e.filter = { blur: blurRadius };
          pushElement(e);
        }
        if (!uniformBorder) {
          for (const b of sides) {
            let r;
            if (b.side === 'top') r = { type: 'rect', x: rect.x, y: rect.y, width: rect.width, height: b.width, fill: b.color };
            else if (b.side === 'bottom') r = { type: 'rect', x: rect.x, y: rect.y + rect.height - b.width, width: rect.width, height: b.width, fill: b.color };
            else if (b.side === 'left') r = { type: 'rect', x: rect.x, y: rect.y, width: b.width, height: rect.height, fill: b.color };
            else if (b.side === 'right') r = { type: 'rect', x: rect.x + rect.width - b.width, y: rect.y, width: b.width, height: rect.height, fill: b.color };
            if (r) pushElement(r);
          }
        }
      }

      function emitPseudo(host, hostCs, which, hostRect) {
        const cs = getComputedStyle(host, which);
        const content = cs.content;
        if (!content || content === 'none' || content === 'normal') return;

        let text = content;
        const q = text.match(/^(['"])([\s\S]*)\1$/);
        if (q) text = q[2];
        else if (/^(attr|counter|counters|url|var)\s*\(/.test(text)) {
          warnings.push({ msg: `pseudo content uses ${text.match(/^(\w+)/)[1]}() — not rendered`, sample: elPath(host) });
          return;
        }

        const left = pxFromCs(cs.left);
        const top = pxFromCs(cs.top);
        const right = pxFromCs(cs.right);
        const bottom = pxFromCs(cs.bottom);
        const w = pxFromCs(cs.width);
        const h = pxFromCs(cs.height);
        const pos = cs.position;

        let px = hostRect.x;
        let py = hostRect.y;
        if (pos === 'absolute') {
          if (left > 0 || cs.left !== 'auto') px = hostRect.x + left;
          else if (cs.right !== 'auto' && w > 0) px = hostRect.x + hostRect.width - right - w;
          if (top > 0 || cs.top !== 'auto') py = hostRect.y + top;
          else if (cs.bottom !== 'auto' && h > 0) py = hostRect.y + hostRect.height - bottom - h;
        }

        const fontSize = pxFromCs(cs.fontSize) || 16;
        const pw = w > 0 ? w : (text === '' ? 0 : Math.ceil(text.length * fontSize * 0.6));
        const ph = h > 0 ? h : (text === '' ? 0 : Math.ceil(fontSize * 1.2));

        if (text === '') {
          if (pw <= 0 || ph <= 0) return;
          const bg = cs.backgroundColor;
          if (!isVisibleColor(bg)) return;
          const minSide = Math.min(pw, ph);
          const maxSide = Math.max(pw, ph);
          const radius = pxFromCs(cs.borderRadius);
          const isEllipse =
            minSide / maxSide >= 0.8 &&
            radius >= minSide / 2 - 0.5;
          // Mark absolute-positioned ::before dots at the host's left edge as
          // "bullet markers" so a later pass can inset any host text whose box
          // collides with them. Source HTML sometimes drops a <p> outside its
          // <ul> — the author's CSS positions a • via ::before but forgets
          // padding-left on that paragraph, so the dot overlaps the first word.
          const isMarkerCandidate =
            which === '::before' &&
            pos === 'absolute' &&
            isEllipse &&
            maxSide <= 16 &&
            Math.abs(px - hostRect.x) <= 2;
          const node = {
            type: isEllipse ? 'ellipse' : 'rect',
            x: px, y: py, width: pw, height: ph,
            fill: bg,
          };
          if (isMarkerCandidate) node._leftMarker = true;
          pushElement(node);
          return;
        }

        const pstyle = textStyle(cs);
        const pel = {
          type: 'text',
          text,
          x: px, y: py, width: pw, height: ph,
          ...pstyle,
        };
        if (!pstyle.align) pel.noWrap = true;
        pushElement(pel);
      }

      function collectWarnings(el, cs) {
        if (cs.transform && cs.transform !== 'none') {
          // getBoundingClientRect() already reflects CSS transforms, so a pure
          // translation is effectively already baked into the rect we
          // extracted. Only warn for rotate/scale/skew, which we can't yet
          // represent in the deck.
          if (!isPureTranslateTransform(cs.transform)) {
            warnings.push({ msg: `transform:${cs.transform} (non-translate) ignored`, sample: elPath(el) });
          }
        }
        if (cs.clipPath && cs.clipPath !== 'none') {
          warnings.push({ msg: `clip-path ignored`, sample: elPath(el) });
        }
        if (cs.filter && cs.filter !== 'none') {
          // blur() is now supported (mapped to Figma FOREGROUND_BLUR at
          // dispatch time). Every other filter value still warns.
          if (parseBlurFilter(cs.filter) == null) {
            warnings.push({ msg: `filter:${cs.filter} ignored`, sample: elPath(el) });
          }
        }
        if (cs.mixBlendMode && cs.mixBlendMode !== 'normal') {
          warnings.push({ msg: `mix-blend-mode:${cs.mixBlendMode} ignored`, sample: elPath(el) });
        }
      }

      function textStyle(cs) {
        const size = pxFromCs(cs.fontSize);
        const lh = parseLineHeight(cs.lineHeight, size);
        const out = {
          font: cs.fontFamily,
          size,
          weight: parseInt(cs.fontWeight, 10) || undefined,
        };
        if (cs.fontStyle === 'italic') out.style = 'italic';
        if (cs.color) out.color = cs.color;
        const ls = pxFromCs(cs.letterSpacing);
        if (ls) out.letterSpacing = ls;
        if (lh != null) out.lineHeight = lh;
        const al = cs.textAlign;
        if (al && al !== 'start' && al !== 'left' && al !== 'auto') out.align = al;
        // CSS vertical-align on table cells / flex / inline-block maps to
        // Figma's textAlignVertical. Only emit for the block-valign values
        // Figma supports; baseline/sub/super are inline-box adjustments that
        // don't translate to Figma's text alignment.
        const va = cs.verticalAlign;
        if (va === 'middle') out.verticalAlign = 'middle';
        else if (va === 'bottom') out.verticalAlign = 'bottom';
        const op = parseFloat(cs.opacity);
        if (!Number.isNaN(op) && op < 1) out.opacity = op;
        return out;
      }

      function parseLineHeight(v, fontSize) {
        if (!v || v === 'normal') return undefined;
        const n = pxFromCs(v);
        return Number.isFinite(n) ? n : undefined;
      }

      // True iff the computed `transform` value is equivalent to a pure
      // 2D translation. getBoundingClientRect already includes it.
      function isPureTranslateTransform(tr) {
        if (!tr || tr === 'none') return true;
        const s = String(tr).trim();
        if (/^translate(X|Y|3d)?\s*\(/.test(s)) {
          if (/^translate3d\s*\(/.test(s)) {
            const parts = s.replace(/^translate3d\s*\(/, '').replace(/\)\s*$/, '').split(',');
            const z = parts[2] ? parseFloat(parts[2]) : 0;
            return Math.abs(z) < 1e-6;
          }
          return true;
        }
        const m2 = s.match(/^matrix\s*\(\s*([^)]+)\)\s*$/);
        if (m2) {
          const p = m2[1].split(',').map((v) => parseFloat(v.trim()));
          if (p.length !== 6 || p.some((v) => !Number.isFinite(v))) return false;
          const [a, b, c, d] = p;
          return (
            Math.abs(a - 1) < 1e-6 &&
            Math.abs(b) < 1e-6 &&
            Math.abs(c) < 1e-6 &&
            Math.abs(d - 1) < 1e-6
          );
        }
        const m3 = s.match(/^matrix3d\s*\(\s*([^)]+)\)\s*$/);
        if (m3) {
          const p = m3[1].split(',').map((v) => parseFloat(v.trim()));
          if (p.length !== 16 || p.some((v) => !Number.isFinite(v))) return false;
          const expectOne = [0, 5, 10, 15];
          for (let i = 0; i < 16; i++) {
            if (i === 12 || i === 13 || i === 14) continue;
            const want = expectOne.includes(i) ? 1 : 0;
            if (Math.abs(p[i] - want) >= 1e-6) return false;
          }
          return true;
        }
        return false;
      }

      // Parse `cs.backgroundImage` into layer descriptors, CSS painting order
      // (first = topmost). Recognised: linear-gradient, radial-gradient.
      // url(...) is silently accepted but not rendered (falls back to bg-color).
      function parseBackgroundImage(bgImage, warnings, el) {
        if (!bgImage || bgImage === 'none') return [];
        const layers = splitTopLevel(bgImage, ',');
        const out = [];
        for (const raw of layers) {
          const layer = raw.trim();
          if (!layer || layer === 'none') continue;
          const headMatch = /^([a-z-]+)\s*\(([\s\S]*)\)\s*$/i.exec(layer);
          if (!headMatch) {
            warnings?.push({ msg: `background-image layer not a gradient/url — ignored`, sample: elPath(el) });
            continue;
          }
          const kind = headMatch[1].toLowerCase();
          const inner = headMatch[2];
          if (kind === 'linear-gradient') {
            const g = parseCssLinearGradient(inner);
            if (g) out.push(g);
          } else if (kind === 'radial-gradient') {
            const g = parseCssRadialGradient(inner);
            if (g) out.push(g);
          } else if (kind === 'url') {
            continue;
          }
        }
        return out;
      }

      function splitTopLevel(str, sep) {
        const out = [];
        let depth = 0;
        let start = 0;
        for (let i = 0; i < str.length; i++) {
          const c = str[i];
          if (c === '(') depth++;
          else if (c === ')') depth = Math.max(0, depth - 1);
          else if (c === sep && depth === 0) {
            out.push(str.slice(start, i));
            start = i + 1;
          }
        }
        out.push(str.slice(start));
        return out;
      }

      function parseCssLinearGradient(body) {
        const parts = splitTopLevel(body, ',').map(s => s.trim());
        if (parts.length === 0) return null;
        let angleDeg = 180;
        let first = parts[0];
        const angleMatch = /^(-?\d+(?:\.\d+)?)deg$/i.exec(first);
        const toMatch = /^to\s+(.+)$/i.exec(first);
        if (angleMatch) {
          angleDeg = parseFloat(angleMatch[1]);
          parts.shift();
        } else if (toMatch) {
          angleDeg = sideToAngleDeg(toMatch[1].trim().toLowerCase());
          parts.shift();
        } else if (/^(-?\d+(?:\.\d+)?)(rad|grad|turn)$/i.test(first)) {
          const um = /^(-?\d+(?:\.\d+)?)(rad|grad|turn)$/i.exec(first);
          const v = parseFloat(um[1]);
          const u = um[2].toLowerCase();
          if (u === 'rad') angleDeg = v * 180 / Math.PI;
          else if (u === 'grad') angleDeg = v * 0.9;
          else if (u === 'turn') angleDeg = v * 360;
          parts.shift();
        }
        const stops = parseColorStops(parts);
        if (!stops.length) return null;
        return { kind: 'linear', angleDeg, stops };
      }

      function sideToAngleDeg(side) {
        switch (side) {
          case 'top': return 0;
          case 'right': return 90;
          case 'bottom': return 180;
          case 'left': return 270;
          case 'top right': case 'right top': return 45;
          case 'bottom right': case 'right bottom': return 135;
          case 'bottom left': case 'left bottom': return 225;
          case 'top left': case 'left top': return 315;
          default: return 180;
        }
      }

      function parseCssRadialGradient(body) {
        const parts = splitTopLevel(body, ',').map(s => s.trim());
        if (parts.length === 0) return null;
        let cx = 0.5, cy = 0.5, rx = 0.5, ry = 0.5;
        let stops;
        const head = parts[0];
        const looksLikeShape = /^(circle|ellipse)\b/i.test(head)
          || /\bat\b/i.test(head)
          || /^\d/.test(head)
          || /^-?\d*\.?\d+%/.test(head);
        if (looksLikeShape) {
          const shapePart = parts.shift();
          const atIdx = shapePart.search(/\bat\b/i);
          const sizeStr = atIdx >= 0 ? shapePart.slice(0, atIdx).trim() : shapePart.trim();
          const posStr = atIdx >= 0 ? shapePart.slice(atIdx + 2).trim() : '';
          const sizeTokens = sizeStr.split(/\s+/).filter(Boolean).filter(t => !/^(ellipse|circle)$/i.test(t));
          if (sizeTokens.length >= 2) {
            rx = cssLengthToUnit(sizeTokens[0], 'x');
            ry = cssLengthToUnit(sizeTokens[1], 'y');
          } else if (sizeTokens.length === 1) {
            const v = cssLengthToUnit(sizeTokens[0], 'x');
            rx = ry = v;
          }
          if (posStr) {
            const pos = parsePosition(posStr);
            cx = pos.x;
            cy = pos.y;
          }
        }
        stops = parseColorStops(parts);
        if (!stops.length) return null;
        if (!(rx > 0) || !(ry > 0)) return null;
        return { kind: 'radial', cx, cy, rx, ry, stops };
      }

      function cssLengthToUnit(tok, axis) {
        const m = /^(-?\d*\.?\d+)(%|px)?$/.exec(tok);
        if (!m) return 0.5;
        const v = parseFloat(m[1]);
        const u = m[2] || 'px';
        if (u === '%') return v / 100;
        return 0.5;
      }

      function parsePosition(str) {
        const toks = str.split(/\s+/).filter(Boolean);
        const map = { left: 0, center: 0.5, right: 1, top: 0, bottom: 1 };
        if (toks.length === 1) {
          const t = toks[0].toLowerCase();
          if (t in map) {
            const v = map[t];
            if (t === 'left' || t === 'right') return { x: v, y: 0.5 };
            if (t === 'top' || t === 'bottom') return { x: 0.5, y: v };
            return { x: 0.5, y: 0.5 };
          }
          const v = cssLengthToUnit(toks[0], 'x');
          return { x: v, y: 0.5 };
        }
        const x = toks[0] in map ? map[toks[0]] : cssLengthToUnit(toks[0], 'x');
        const y = toks[1] in map ? map[toks[1]] : cssLengthToUnit(toks[1], 'y');
        return { x, y };
      }

      function parseColorStops(parts) {
        const raw = [];
        for (const p of parts) {
          const color = extractLeadingColor(p);
          if (!color) continue;
          const rest = p.slice(color.length).trim();
          const positions = [];
          if (rest) {
            const tokens = rest.split(/\s+/).filter(Boolean);
            for (const t of tokens) {
              const v = parsePositionValue(t);
              if (v != null) positions.push(v);
            }
          }
          if (positions.length === 0) {
            raw.push({ color, pos: null });
          } else {
            for (const pos of positions) raw.push({ color, pos });
          }
        }
        if (raw.length === 0) return [];
        if (raw[0].pos == null) raw[0].pos = 0;
        if (raw[raw.length - 1].pos == null) raw[raw.length - 1].pos = 1;
        for (let i = 0; i < raw.length; i++) {
          if (raw[i].pos == null) {
            let j = i;
            while (j < raw.length && raw[j].pos == null) j++;
            const startPos = raw[i - 1].pos;
            const endPos = raw[j].pos ?? 1;
            const gap = j - i + 1;
            for (let k = 0; k < j - i; k++) {
              raw[i + k].pos = startPos + (endPos - startPos) * (k + 1) / gap;
            }
            i = j - 1;
          }
        }
        return raw.map(s => ({ color: s.color, pos: Math.max(0, Math.min(1, s.pos)) }));
      }

      function parsePositionValue(tok) {
        const m = /^(-?\d*\.?\d+)(%|px)?$/.exec(tok);
        if (!m) return null;
        const v = parseFloat(m[1]);
        const u = m[2] || '%';
        if (u === '%') return v / 100;
        return null;
      }

      function extractLeadingColor(str) {
        const s = str.trim();
        if (s.startsWith('#')) {
          const m = /^#[0-9a-fA-F]+/.exec(s);
          return m ? m[0] : null;
        }
        const fn = /^([a-zA-Z]+)\s*\(/.exec(s);
        if (fn) {
          let depth = 0;
          for (let i = 0; i < s.length; i++) {
            if (s[i] === '(') depth++;
            else if (s[i] === ')') {
              depth--;
              if (depth === 0) return s.slice(0, i + 1);
            }
          }
          return null;
        }
        const name = /^[a-zA-Z]+/.exec(s);
        return name ? name[0] : null;
      }

      // Parse `filter: blur(Npx)`. Returns the radius as a number, or null
      // if the filter value isn't a single blur(...) token. Multi-filter
      // strings like `blur(2px) drop-shadow(...)` return null because we
      // can't represent the composite in Figma yet.
      function parseBlurFilter(v) {
        if (!v || v === 'none') return null;
        const s = String(v).trim();
        const m = /^blur\(\s*(-?\d*\.?\d+)(?:px)?\s*\)$/i.exec(s);
        if (!m) return null;
        const n = parseFloat(m[1]);
        return Number.isFinite(n) && n > 0 ? n : null;
      }

      function isVisibleColor(c) {
        if (!c) return false;
        if (c === 'transparent') return false;
        if (c === 'rgba(0, 0, 0, 0)') return false;
        return true;
      }

      function pxFromCs(v) {
        if (v == null) return 0;
        const m = String(v).match(/(-?[\d.]+)/);
        return m ? parseFloat(m[1]) : 0;
      }

      function collapseText(s) {
        return String(s || '').replace(/\s+/g, ' ').trim();
      }

      function collapseTextPreservingBreaks(s) {
        const lines = String(s || '')
          .replace(/\r\n?/g, '\n')
          .split('\n')
          .map((line) => line.replace(/\s+/g, ' ').trim());
        while (lines.length > 0 && !lines[0]) lines.shift();
        while (lines.length > 0 && !lines[lines.length - 1]) lines.pop();
        return lines.join('\n');
      }

      function elPath(el) {
        const t = (el.tagName || '').toLowerCase();
        const id = el.getAttribute?.('id');
        const cls = el.className && typeof el.className === 'string' ? el.className.split(/\s+/).slice(0, 2).join('.') : '';
        let s = t;
        if (id) s += '#' + id;
        else if (cls) s += '.' + cls;
        return s;
      }
    }
  }, { flexAutoLayout });
}
