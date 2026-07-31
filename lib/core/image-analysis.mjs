/**
 * Small, host-independent source-colour analysis for editable image filters.
 *
 * Why this exists
 * ---------------
 * CSS brightness multiplies RGB channels. The closest editable native control
 * is Exposure, which instead bends the image's tone curve. Adding Highlights
 * and Shadows makes ordinary photographs look much closer to the CSS result,
 * but the same fixed treatment can visibly wash out bright saturated areas or
 * make some deep saturated colours too light.
 *
 * The converter must not solve that by flattening the CSS result into a new
 * bitmap: designers need the original photo and ordinary editable color
 * controls after conversion. OpenFig therefore inspects a tiny sample of the
 * *original* image and changes only the numeric native adjustment values.
 *
 * What the signal means visually
 * ------------------------------
 * CSS grayscale mixes gamma-encoded sRGB channels directly. Native image
 * desaturation behaves like a linear-light luminance conversion. The
 * difference between those two calculations is a compact indication that the
 * source contains colour whose apparent brightness may respond differently to
 * native tone controls.
 *
 * Two continuous risks are derived from the same sample:
 *
 * 1. Difference in bright pixels: fade Highlights/Shadows toward Exposure-only
 *    so bright saturated colour is not lifted and washed out.
 * 2. Large difference concentrated below highlights: keep Highlights, but
 *    slightly lower Exposure and Shadows so deep saturated colour does not
 *    become too bright.
 *
 * Neither path detects a filename, subject, or named hue. Values fade across
 * broad ranges, so a small decoding difference cannot flip an image between
 * two unrelated treatments.
 *
 * Validation contract
 * -------------------
 * The success gate is less than 5% absolute discrepancy in both mean luminance
 * and luminance spread for every automatic result in the 11-photo CC0 probe.
 * The previous fixed mapping averaged 2.29% mean / 2.80% spread and exceeded
 * the gate on saturated flower and magenta sources. The source-aware mapping
 * averages 1.04% / 1.24%; its worst cases are 2.81% mean and 3.80% spread.
 * All 11 unmodified controls measure zero error.
 *
 * Node and browser decoders need not return identical samples. Their profiles
 * may differ by at most SOURCE_COLOR_HOST_TOLERANCE (0.5 of one 8-bit level);
 * the 11 public sources differ by no more than 0.38 and remain on the same side
 * of every risk boundary.
 *
 * The output is still an approximation: native and CSS transfer functions are
 * different. These signals choose the closest tested editable treatment; they
 * do not claim pixel identity.
 *
 * CSS grayscale mixes gamma-encoded sRGB channels directly. Native image
 * desaturation behaves like a linear-light luminance conversion. Their
 * per-pixel difference is therefore a useful source signal for colours whose
 * native tone controls can diverge from CSS. Weighting that difference by
 * highlight luminance also predicts whether native Highlights will amplify the
 * mismatch, without identifying a particular file, hue, or subject.
 */

export const SOURCE_COLOR_ANALYSIS_MAX_DIMENSION = 64;

/** Maximum accepted Node-vs-browser profile difference, in 8-bit levels. */
export const SOURCE_COLOR_HOST_TOLERANCE = 0.5;

/**
 * The eleven-photo validation separates the source-weighted highlight signal:
 * ordinary, dark-red, and dark-magenta scenes measure 0–0.81 levels; a blue
 * sky measures 2.37, mixed bright colors 3.61, and the bright saturated
 * outlier 8.97. Use a broad transition so the selector is continuous and does
 * not encode one photograph's exact value.
 */
export const SOURCE_COLOR_RISK_RANGE = Object.freeze({
  safe: 2,
  full: 6,
});

/**
 * A second, complementary band detects a large gamma-vs-linear difference
 * concentrated below the highlight range. The eleven-photo set separates the
 * remaining dark-magenta outlier (23 levels) from the next source (9.15).
 */
export const SOURCE_DARK_COLOR_RISK_RANGE = Object.freeze({
  safe: 15,
  full: 22,
});

const clampUnit = (value) => Math.max(0, Math.min(1, value));

function srgbByteToLinear(value) {
  const encoded = value / 255;
  return encoded <= 0.04045
    ? encoded / 12.92
    : ((encoded + 0.055) / 1.055) ** 2.4;
}

function linearToSrgbByte(value) {
  const encoded = value <= 0.0031308
    ? 12.92 * value
    : (1.055 * (value ** (1 / 2.4))) - 0.055;
  return encoded * 255;
}

/**
 * Exact aspect-preserving sample dimensions shared by both image hosts.
 */
export function sourceColorAnalysisSize(
  width,
  height,
  maxDimension = SOURCE_COLOR_ANALYSIS_MAX_DIMENSION,
) {
  if (!Number.isFinite(width) || width <= 0
      || !Number.isFinite(height) || height <= 0) {
    throw new Error('sourceColorAnalysisSize: expected positive image dimensions');
  }
  if (!Number.isFinite(maxDimension) || maxDimension <= 0) {
    throw new Error('sourceColorAnalysisSize: expected a positive maximum dimension');
  }
  const scale = Math.min(1, maxDimension / Math.max(width, height));
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

/**
 * Measure the mean absolute difference, in 8-bit levels, between CSS's
 * gamma-encoded grayscale matrix and a linear-light luminance conversion.
 * Transparent pixels are weighted by alpha so invisible RGB cannot influence
 * the result.
 */
export function sourceColorProfileFromRgba(rgba, dimensions = {}) {
  if (!ArrayBuffer.isView(rgba) || rgba.byteLength % 4 !== 0) {
    throw new Error('sourceColorProfileFromRgba: expected an RGBA byte array');
  }

  let difference = 0;
  let highlightDifference = 0;
  let weight = 0;
  for (let offset = 0; offset < rgba.length; offset += 4) {
    const alpha = rgba[offset + 3] / 255;
    if (alpha === 0) continue;

    const red = rgba[offset];
    const green = rgba[offset + 1];
    const blue = rgba[offset + 2];
    const cssGray =
      (0.2126 * red) + (0.7152 * green) + (0.0722 * blue);
    const linearGray = linearToSrgbByte(
      (0.2126 * srgbByteToLinear(red))
      + (0.7152 * srgbByteToLinear(green))
      + (0.0722 * srgbByteToLinear(blue)),
    );

    const delta = Math.abs(linearGray - cssGray);
    // Highlights is not a binary band. Fade its influence in from level 96 to
    // 160 so nearby decoders cannot flip a pixel across a hard threshold and
    // so midtones contribute proportionally to the control that affects them.
    const highlightWeight = clampUnit((cssGray - 96) / 64);
    difference += delta * alpha;
    highlightDifference += delta * alpha * highlightWeight;
    weight += alpha;
  }

  return {
    cssLinearLumaDelta: weight === 0 ? 0 : difference / weight,
    highlightCssLinearLumaDelta:
      weight === 0 ? 0 : highlightDifference / weight,
    sampleWeight: weight,
    samples: rgba.byteLength / 4,
    width: dimensions.width,
    height: dimensions.height,
  };
}

/**
 * Convert a source profile into the amount of tone refinement to remove.
 *
 * The output is deliberately continuous. Callers retain the old calibration
 * when no profile is available, and only color-preserving brightening applies
 * this risk to native Highlights/Shadows.
 */
export function sourceColorRisk(profile) {
  const delta = Number(profile?.highlightCssLinearLumaDelta);
  if (!Number.isFinite(delta)) return 0;
  const { safe, full } = SOURCE_COLOR_RISK_RANGE;
  return clampUnit((delta - safe) / (full - safe));
}

/**
 * Detect strong source-colour divergence outside the highlight band.
 *
 * Gating by the inverse highlight risk keeps this correction orthogonal to the
 * bright-colour path: a bright saturated source trends toward Exposure-only,
 * while a dark saturated source retains Highlights and receives a small
 * exposure/shadow correction.
 */
export function sourceDarkColorRisk(profile) {
  const delta = Number(profile?.cssLinearLumaDelta);
  if (!Number.isFinite(delta)) return 0;
  const { safe, full } = SOURCE_DARK_COLOR_RISK_RANGE;
  const overallRisk = clampUnit((delta - safe) / (full - safe));
  return overallRisk * (1 - sourceColorRisk(profile));
}
