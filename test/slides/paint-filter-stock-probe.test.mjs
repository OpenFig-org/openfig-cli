import { describe, expect, it } from 'vitest';
import {
  COLOR_SAFE_PROFILES,
  PROBE_PLAN,
  PROFILES,
  STOCK_SOURCES,
  probePlanForMode,
  profilesForMode,
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

  it('rejects an unknown probe mode', () => {
    expect(() => profilesForMode('mystery')).toThrow('unknown probe mode mystery');
  });
});
