// Lightweight theme system — writes data-theme on <html> so themes.css
// can swap CSS custom properties. Persisted in localStorage so the user's
// choice survives reloads.

const KEY = 'UNIVERSE3_THEME_V1';

export const THEMES = [
  { key: 'midnight', label: 'Midnight',  hint: 'Executive dark · mint' },
  { key: 'ocean',    label: 'Ocean',     hint: 'Deep teal · cyan'      },
  { key: 'graphite', label: 'Graphite',  hint: 'Charcoal · violet'     },
  { key: 'sunset',   label: 'Sunset',    hint: 'Aubergine · amber'     },
  { key: 'daylight', label: 'Daylight',  hint: 'Light · emerald'       },
];

export const DEFAULT_THEME = 'daylight';

export function getTheme() {
  try {
    const v = window.localStorage.getItem(KEY);
    if (v && THEMES.some(t => t.key === v)) return v;
  } catch {}
  return DEFAULT_THEME;
}

export function setTheme(key) {
  if (!THEMES.some(t => t.key === key)) return;
  try { window.localStorage.setItem(KEY, key); } catch {}
  document.documentElement.setAttribute('data-theme', key);
  // Let any listening components re-render
  window.dispatchEvent(new CustomEvent('universe:theme-change', { detail: key }));
}

export function initTheme() {
  document.documentElement.setAttribute('data-theme', getTheme());
}
