// src/components/ThemeSwitcher.jsx — small dropdown for choosing a theme.
// Reads/writes via utils/theme.js; listens for external theme changes so
// multiple mount points (login + topbar) stay in sync.
//
// Memoized because it's mounted in the topbar of every wizard screen
// and would otherwise re-render whenever the parent does (keystrokes
// on pricing edits, etc.). Its only prop is a boolean `compact`.
import { memo, useEffect, useMemo, useState } from 'react';
import { THEMES, getTheme, setTheme } from '../utils/theme';

function ThemeSwitcher({ compact = false }) {
  const [current, setCurrent] = useState(getTheme());

  useEffect(() => {
    const handler = (e) => setCurrent(e.detail || getTheme());
    window.addEventListener('universe:theme-change', handler);
    return () => window.removeEventListener('universe:theme-change', handler);
  }, []);

  const onChange = (e) => {
    setTheme(e.target.value);
    setCurrent(e.target.value);
  };

  const currentTheme = useMemo(
    () => THEMES.find((t) => t.key === current) || THEMES[0],
    [current]
  );

  return (
    <label className={`theme-switcher${compact ? ' theme-switcher--compact' : ''}`}>
      {!compact && <span className="theme-switcher__label">Theme</span>}
      <span
        className="theme-switcher__swatch"
        data-theme-key={currentTheme.key}
        aria-hidden="true"
      />
      <select
        className="theme-switcher__select"
        value={current}
        onChange={onChange}
        aria-label="Theme"
      >
        {THEMES.map(t => (
          <option key={t.key} value={t.key}>{t.label}</option>
        ))}
      </select>
      {!compact && <span className="theme-switcher__hint">{currentTheme.hint}</span>}
    </label>
  );
}

export default memo(ThemeSwitcher);
