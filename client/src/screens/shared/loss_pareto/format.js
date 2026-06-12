// loss_pareto/format.js — display formatters shared by the LossPareto
// orchestrator, its subcomponents, and the math module's paramStr labels.
// Moved verbatim from LossParetoScreen.jsx (Phase 4.2) — formatting is
// part of the golden-mastered output; do not change rounding behaviour.

export function fmt(n) { return n == null || !Number.isFinite(Number(n)) ? '—' : Number(n).toLocaleString('en-US', { maximumFractionDigits: 0 }); }
export function fPct(n) { return n == null || !Number.isFinite(n) ? '—' : `${(n * 100).toFixed(1)}%`; }
export function fDec(n, d = 4) { return n == null || !Number.isFinite(n) ? '—' : Number(n).toFixed(d); }
