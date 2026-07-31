import { describe, expect, it } from 'vitest';
import {
  COLOR_SAFE_PROFILES,
  MAGENTA_REFINEMENT_PROFILES,
  PROBE_PLAN,
  PROFILES,
  SOURCE_AWARE_PROFILES,
  SOURCE_AWARE_SOURCES,
  STOCK_SOURCES,
  paintFilterForProfile,
  probePlanForMode,
  profilesForMode,
  sourcesForMode,
} from '../../scripts/build-paint-filter-stock-probe.mjs';

describe('public-domain paint-filter stock probe', () => {
  it('records an auditable CC0 source for every photograph', () => {
    expect(STOCK_SOURCES).toHaveLength(5);
    for (const source of STOCK_SOURCES) {
      expect(source.license).toBe('CC0 1.0');
      expect(source.attributionRequired).toBe(false);
      expect(source.downloadUrl).toMatch(/^https:\/\/upload\.wikimedia\.org\//);
      expect(source.sourcePage).toMatch(/^https:\/\/commons\.wikimedia\.org\/wiki\/File:/);
    }
  });

  it('adds hue, skin-tone, and mixed-color coverage without changing history', () => {
    expect(SOURCE_AWARE_SOURCES).toHaveLength(11);
    expect(SOURCE_AWARE_SOURCES.slice(0, STOCK_SOURCES.length))
      .toEqual(STOCK_SOURCES);
    expect(SOURCE_AWARE_SOURCES.map((source) => source.id)).toEqual([
      'portrait',
      'landscape',
      'night',
      'interior',
      'flowers',
      'red',
      'blue',
      'magenta',
      'green',
      'skin',
      'mixed',
    ]);
    for (const source of SOURCE_AWARE_SOURCES) {
      expect(source.license).toBe('CC0 1.0');
      expect(source.attributionRequired).toBe(false);
      expect(source.downloadUrl).toMatch(/^https:\/\/upload\.wikimedia\.org\//);
      expect(source.sourcePage).toMatch(/^https:\/\/commons\.wikimedia\.org\/wiki\/File:/);
    }
  });

  it('keeps the default generalization matrix stable', () => {
    expect(PROFILES.map((profile) => profile.id)).toEqual([
      'control',
      'mild',
      'strong',
    ]);
    expect(PROBE_PLAN).toHaveLength(15);
    expect(probePlanForMode('generalization')).toEqual(PROBE_PLAN);
  });

  it('keeps current and candidate mappings side by side', () => {
    expect(COLOR_SAFE_PROFILES.map((profile) => profile.id)).toEqual([
      'current-color',
      'color-safe',
      'grayscale-refined',
    ]);
    expect(profilesForMode('color-safe')).toBe(COLOR_SAFE_PROFILES);
    expect(probePlanForMode('color-safe')).toHaveLength(15);
  });

  it('builds a separate source-aware validation matrix', () => {
    expect(SOURCE_AWARE_PROFILES.map((profile) => profile.id)).toEqual([
      'control',
      'global-baseline',
      'source-aware',
      'exposure-only',
    ]);
    expect(profilesForMode('source-aware')).toBe(SOURCE_AWARE_PROFILES);
    expect(sourcesForMode('source-aware')).toBe(SOURCE_AWARE_SOURCES);
    expect(probePlanForMode('source-aware')).toHaveLength(44);
    expect(probePlanForMode('source-aware')[4]).toMatchObject({
      profile: { id: 'control' },
      source: { id: 'flowers' },
    });
  });

  it('derives a continuous editable paint filter from the source profile', () => {
    const sourceAware = SOURCE_AWARE_PROFILES.find(
      (profile) => profile.id === 'source-aware',
    );
    const safe = paintFilterForProfile(sourceAware, {
      cssLinearLumaDelta: 0,
      highlightCssLinearLumaDelta: 0,
    });
    const middle = paintFilterForProfile(sourceAware, {
      cssLinearLumaDelta: 0,
      highlightCssLinearLumaDelta: 4,
    });
    const risky = paintFilterForProfile(sourceAware, {
      cssLinearLumaDelta: 0,
      highlightCssLinearLumaDelta: 20,
    });
    const darkRisky = paintFilterForProfile(sourceAware, {
      cssLinearLumaDelta: 22,
      highlightCssLinearLumaDelta: 0,
    });

    expect(safe.highlights).toBeGreaterThan(middle.highlights);
    expect(middle.highlights).toBeGreaterThan(0);
    expect(risky.highlights).toBeUndefined();
    expect(risky.shadows).toBeUndefined();
    expect(darkRisky).toEqual({
      exposure: 0.07,
      highlights: 0.55,
      shadows: -0.3,
    });
  });

  it('provides a focused grid for the remaining magenta residual', () => {
    expect(MAGENTA_REFINEMENT_PROFILES).toHaveLength(12);
    expect(profilesForMode('magenta-refinement'))
      .toBe(MAGENTA_REFINEMENT_PROFILES);
    expect(sourcesForMode('magenta-refinement').map((source) => source.id))
      .toEqual(['magenta']);
    expect(probePlanForMode('magenta-refinement')).toHaveLength(12);
  });

  it('rejects an unknown probe mode', () => {
    expect(() => profilesForMode('mystery')).toThrow('unknown probe mode mystery');
    expect(() => sourcesForMode('mystery')).toThrow('unknown probe mode mystery');
  });
});
