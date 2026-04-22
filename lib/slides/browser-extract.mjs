export async function extractSlides(page) {
  return await page.evaluate(() => {
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
    return { slides: results };

    function collectSection(root, index) {
      const secRect = root.getBoundingClientRect();
      const off = { x: secRect.left, y: secRect.top };
      const elements = [];
      const warnings = [];

      walk(root);

      return {
        index,
        dataLabel: root.getAttribute('data-label'),
        background: getComputedStyle(root).backgroundColor,
        elements,
        warnings,
      };

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

        emitPseudo(el, cs, '::before', rect);

        if (tag === 'IMG') {
          const src = el.getAttribute('src');
          if (src) {
            elements.push({
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
          elements.push({
            type: 'svg',
            x: rect.x, y: rect.y, width: rect.width, height: rect.height,
            viewBox: el.getAttribute('viewBox') || `0 0 ${rect.width} ${rect.height}`,
            inline: el.outerHTML,
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
              for (const c of el.children) walk(c);
            }
          }
        }

        emitPseudo(el, cs, '::after', rect);
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

      function emitTextLeaf(el, cs, rect) {
        const text = collapseText(el.innerText ?? el.textContent ?? '');
        if (!text) return;
        const lines = countTextLines(el);
        const style = textStyle(cs);
        const el2 = {
          type: 'text',
          text,
          x: rect.x, y: rect.y, width: rect.width, height: rect.height,
          ...style,
        };
        if (lines === 1 && !style.align) {
          const range = document.createRange();
          range.selectNodeContents(el);
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
        }
        elements.push(el2);
      }

      function squishInline(s) {
        return String(s || '').replace(/\s+/g, ' ');
      }

      function emitInlineRuns(el, parentCs) {
        emitInlineAsRichText(el, parentCs);
      }

      function emitInlineAsRichText(el, parentCs) {
        const runs = [];
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
            if (ct === 'BR') { runs.push({ text: '\n' }); continue; }
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
        elements.push({
          type: 'richText',
          runs,
          x: rect.x, y: rect.y, width: rect.width, height: rect.height,
          ...textStyle(parentCs),
        });
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
        if (bgImage && bgImage !== 'none') {
          warnings.push({ msg: `background-image ignored (only solid color supported)`, sample: elPath(el) });
        }
        const sides = ['top', 'right', 'bottom', 'left']
          .map((side) => ({
            side,
            width: pxFromCs(cs.getPropertyValue(`border-${side}-width`)),
            style: cs.getPropertyValue(`border-${side}-style`),
            color: cs.getPropertyValue(`border-${side}-color`),
          }))
          .filter((b) => b.width > 0 && b.style !== 'none' && isVisibleColor(b.color));

        if (!hasBg && sides.length === 0) return;

        const radius = pxFromCs(cs.borderRadius);
        const minSide = Math.min(rect.width, rect.height);
        const maxSide = Math.max(rect.width, rect.height);
        const isEllipse =
          minSide > 0 &&
          minSide / maxSide >= 0.8 &&
          radius > 0 &&
          radius >= minSide / 2 - 0.5;

        if (hasBg) {
          elements.push({
            type: isEllipse ? 'ellipse' : 'rect',
            x: rect.x, y: rect.y, width: rect.width, height: rect.height,
            fill: bg,
            ...(radius > 0 && !isEllipse ? { cornerRadius: radius } : {}),
          });
        }
        for (const b of sides) {
          let r;
          if (b.side === 'top') r = { type: 'rect', x: rect.x, y: rect.y, width: rect.width, height: b.width, fill: b.color };
          else if (b.side === 'bottom') r = { type: 'rect', x: rect.x, y: rect.y + rect.height - b.width, width: rect.width, height: b.width, fill: b.color };
          else if (b.side === 'left') r = { type: 'rect', x: rect.x, y: rect.y, width: b.width, height: rect.height, fill: b.color };
          else if (b.side === 'right') r = { type: 'rect', x: rect.x + rect.width - b.width, y: rect.y, width: b.width, height: rect.height, fill: b.color };
          if (r) elements.push(r);
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
          elements.push({
            type: isEllipse ? 'ellipse' : 'rect',
            x: px, y: py, width: pw, height: ph,
            fill: bg,
          });
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
        elements.push(pel);
      }

      function collectWarnings(el, cs) {
        if (cs.transform && cs.transform !== 'none') {
          warnings.push({ msg: `transform:${cs.transform} ignored`, sample: elPath(el) });
        }
        if (cs.clipPath && cs.clipPath !== 'none') {
          warnings.push({ msg: `clip-path ignored`, sample: elPath(el) });
        }
        if (cs.filter && cs.filter !== 'none') {
          warnings.push({ msg: `filter:${cs.filter} ignored`, sample: elPath(el) });
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
        const op = parseFloat(cs.opacity);
        if (!Number.isNaN(op) && op < 1) out.opacity = op;
        return out;
      }

      function parseLineHeight(v, fontSize) {
        if (!v || v === 'normal') return undefined;
        const n = pxFromCs(v);
        return Number.isFinite(n) ? n : undefined;
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
  });
}
