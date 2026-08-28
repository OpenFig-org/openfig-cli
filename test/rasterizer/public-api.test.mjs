import { join } from 'node:path';

import { describe, expect, it } from 'vitest';
import { FigDeck } from 'openfig-cli/deck';
import { nid } from 'openfig-cli/node-helpers';
import { frameToSvg, svgToPng } from 'openfig-cli/rasterizer';

const FIXTURE = join(
  import.meta.dirname,
  '../fixtures/figs/reference/basic-shapes.fig',
);

describe('public rasterizer API', () => {
  it('exports one supported .fig frame-to-SVG-to-PNG boundary', async () => {
    const fig = await FigDeck.fromDeckFile(FIXTURE);
    const page = fig.getPages()[0];
    const frame = fig.getChildren(nid(page))
      .filter(node => node.phase !== 'REMOVED' && node.type === 'FRAME')
      .find(node => node.name === 'basic_shapes');

    expect(frame).toBeTruthy();

    const svg = frameToSvg(fig, frame);
    expect(svg).toMatch(/^<svg\b/);
    expect(svg).toContain('<path');

    const png = await svgToPng(svg, {
      background: 'rgba(0,0,0,0)',
      scale: 1,
    });
    expect(Buffer.from(png.subarray(1, 4)).toString('ascii')).toBe('PNG');
  });
});
