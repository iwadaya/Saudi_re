// paretoMonteCarlo.worker.js
// ─────────────────────────────────────────────────────────────────
// Thin Web Worker wrapper around the (framework-free) Monte-Carlo
// engine so a 10k-trial run never blocks the UI thread.
//
// Protocol: the main thread posts { id?, params }, the worker replies
// with { id, ok: true, results } or { id, ok: false, error }. The engine
// stays in paretoMonteCarlo.js — pure and unit-testable; this file only
// marshals messages. Spawn it (Vite) with:
//
//   const worker = new Worker(
//     new URL('./paretoMonteCarlo.worker.js', import.meta.url),
//     { type: 'module' },
//   );

import { runParetoMonteCarlo } from './paretoMonteCarlo.js';

// Guarded so the module is importable in non-worker contexts (tests/SSR)
// without throwing on a missing `self`.
if (typeof self !== 'undefined' && typeof self.addEventListener === 'function') {
  self.addEventListener('message', (event) => {
    const { id, params } = event.data || {};
    try {
      const results = runParetoMonteCarlo(params);
      self.postMessage({ id, ok: true, results });
    } catch (err) {
      self.postMessage({ id, ok: false, error: (err && err.message) || String(err) });
    }
  });
}
