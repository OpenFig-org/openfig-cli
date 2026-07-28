/**
 * `stroke="url(#id)"` must resolve like `fill="url(#id)"` does.
 *
 * Gradient fills were resolved; gradient strokes were not, so the raw
 * `url(#lg2)` reached the colour parser and threw `Unknown color`, failing the
 * whole conversion. Ordinary SVG, and charting exports emit them for line
 * series — one gradient-stroked path is enough to lose a ten-slide deck.
 *
 * Every shape branch resolves its own stroke, so this covers each of them
 * rather than the one that happened to break.
 */
import { describe, it, expect } from 'vitest';
import { parseSvgShapes } from '../../lib/slides/handoff/element-dispatch.mjs';

const GRADIENT_DEFS = `
  <defs>
    <linearGradient id="lg2" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="#12A594"/>
      <stop offset="1" stop-color="#E5484D"/>
    </linearGradient>
  </defs>
`;

describe('SVG gradient references on stroke', () => {
  it('parses a gradient-stroked path without throwing', () => {
    const { shapes, gradients } = parseSvgShapes(`
      ${GRADIENT_DEFS}
      <path d="M0 0 L100 100" stroke="url(#lg2)" stroke-width="5" fill="none"/>
    `);
    expect(shapes).toHaveLength(1);
    expect(shapes[0].stroke).toBe('url(#lg2)');
    expect(gradients.has('lg2')).toBe(true);
  });

  it('keeps the reference intact on every shape that can carry a stroke', () => {
    const { shapes } = parseSvgShapes(`
      ${GRADIENT_DEFS}
      <path d="M0 0 L10 10" stroke="url(#lg2)"/>
      <line x1="0" y1="0" x2="10" y2="10" stroke="url(#lg2)"/>
      <rect x="0" y="0" width="10" height="10" stroke="url(#lg2)"/>
      <circle cx="5" cy="5" r="4" stroke="url(#lg2)"/>
      <ellipse cx="5" cy="5" rx="4" ry="2" stroke="url(#lg2)"/>
    `);
    expect(shapes).toHaveLength(5);
    for (const shape of shapes) {
      expect(shape.stroke, shape.type).toBe('url(#lg2)');
    }
  });

  it('still reads a plain colour stroke', () => {
    const { shapes } = parseSvgShapes('<path d="M0 0 L1 1" stroke="#E5484D"/>');
    expect(shapes[0].stroke).toBe('#E5484D');
  });
});
