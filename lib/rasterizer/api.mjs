/**
 * Supported rendering boundary for Figma Design frames.
 *
 * Keep consumers on this facade instead of importing rasterizer internals.
 */
export { frameToSvg } from './svg-builder.mjs';
export { svgToPng } from './deck-rasterizer.mjs';
