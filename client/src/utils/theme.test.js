import { describe, it, expect, beforeEach, vi } from 'vitest';
import { THEMES, DEFAULT_THEME, getTheme, setTheme, initTheme } from './theme.js';

beforeEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute('data-theme');
});

describe('theme utilities', () => {
  it('exposes the canonical theme list', () => {
    const keys = THEMES.map(t => t.key);
    expect(keys).toEqual(['midnight', 'ocean', 'graphite', 'sunset', 'daylight']);
    THEMES.forEach(t => {
      expect(t.key).toBeTypeOf('string');
      expect(t.label).toBeTypeOf('string');
    });
  });

  it('returns the default when localStorage is empty', () => {
    expect(getTheme()).toBe(DEFAULT_THEME);
    expect(DEFAULT_THEME).toBe('daylight');
  });

  it('returns the persisted theme when valid', () => {
    localStorage.setItem('UNIVERSE3_THEME_V1', 'ocean');
    expect(getTheme()).toBe('ocean');
  });

  it('falls back to default when persisted value is unknown', () => {
    localStorage.setItem('UNIVERSE3_THEME_V1', 'neon-pink-explosion');
    expect(getTheme()).toBe(DEFAULT_THEME);
  });

  it('persists + applies theme on setTheme', () => {
    setTheme('sunset');
    expect(localStorage.getItem('UNIVERSE3_THEME_V1')).toBe('sunset');
    expect(document.documentElement.getAttribute('data-theme')).toBe('sunset');
  });

  it('rejects unknown theme keys silently', () => {
    setTheme('not-a-theme');
    expect(localStorage.getItem('UNIVERSE3_THEME_V1')).toBe(null);
  });

  it('emits a universe:theme-change event so multi-mounted switchers stay in sync', () => {
    const handler = vi.fn();
    window.addEventListener('universe:theme-change', handler);
    setTheme('graphite');
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0][0].detail).toBe('graphite');
    window.removeEventListener('universe:theme-change', handler);
  });

  it('initTheme writes the resolved theme to <html data-theme>', () => {
    localStorage.setItem('UNIVERSE3_THEME_V1', 'daylight');
    initTheme();
    expect(document.documentElement.getAttribute('data-theme')).toBe('daylight');
  });
});
