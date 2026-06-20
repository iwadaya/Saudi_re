// src/utils/logger.js
// The ONE sanctioned place the client touches `console`. Screens/components route
// through this shim instead of littering raw console.* calls, so logging can be
// silenced, level-gated, or shipped to a real sink (Sentry/LogRocket) from a
// single chokepoint later — without touching every call site.
//
// Levels:
//   error / warn  — always surface (real problems should never be hidden).
//   info / debug / log — DEV only; compiled to no-ops by the bundler in prod.
/* eslint-disable no-console */

const isDev = (() => {
  try { return !!import.meta.env?.DEV; } catch { return false; }
})();

function safe(fn, args) {
  try { fn(...args); } catch { /* logging must never throw */ }
}

export const logger = {
  error: (...args) => safe(console.error, args),
  warn: (...args) => safe(console.warn, args),
  info: (...args) => { if (isDev) safe(console.info, args); },
  debug: (...args) => { if (isDev) safe(console.debug, args); },
  log: (...args) => { if (isDev) safe(console.log, args); },
};

export default logger;
