// client/src/test/bundleBudget.test.js
// Fails CI if the main bundle chunks grow beyond budget. Catches the
// "oops I statically imported exceljs again" regression and general creep.
//
// This gate is only meaningful after a build, so it must NOT silently skip when
// client/dist is absent — a skipped budget reading as green is how app-core
// drifted unnoticed before. `npm run verify` and .github/workflows/ci.yml both
// run `vite build` before this test; a missing dist/ here is a hard FAILURE.

import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, statSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { gzipSync } from 'node:zlib';

const DIST = resolve('client/dist/assets');

// ── app-core: measured in GZIP ───────────────────────────────────────────────
// Render serves gzip, so gzip ≈ real transfer cost — that's what we gate on for
// the initial-load app-core chunk (the rest below stay raw; only app-core grew
// enough to need re-baselining).
//
// 2026-06-18 RE-BASELINE after the manual-chunk fix (see client/vite.config.js).
// The old manualChunks matched the generic /components/, /hooks/, /utils/
// patterns BEFORE the screen patterns, so ~93 screen-local files (each screen's
// own components/, hooks/, config/ subfolders) were pulled into app-core —
// inflating the eagerly-loaded core to 760.9 KB raw / 201.3 KB gzip AND creating
// circular chunks (app-core <-> prop-/shared-/np-final-pricing). With screens
// matched first, that code now lives in its (lazy, per-route) screen chunk and
// app-core is a true shared core: 265.3 KB raw / 73.8 KB gzip — a net
// initial-load win. Budget = measured gzip + headroom, deliberately far below
// the old 226 so the gate actually catches app-core creep again.
const APP_CORE_BUDGET_KB = 95;                           // 73.8 KB gzip + ~29%
const APP_CORE_CEILING_KB = APP_CORE_BUDGET_KB * 1.20;   // hard ceiling: budget + 20%

// ── Other chunks: raw budgets (each carries ~10% headroom) ───────────────────
// Re-baselined alongside the app-core fix: the screen-local code that used to
// inflate app-core now lands in these per-route chunks, so they are larger but
// only load when their screen is visited (net initial-load improvement). Raw
// measurements (KiB) from the 2026-06-18 production build in parentheses.
const RAW_BUDGETS_KB = {
  vendor: 300,             // React + router, plus non-lazy deps      (285.4)
  'np-final-pricing': 330, // the big screen — still the biggest       (296.5)
  // np-screens covers the Aggregate XL structure (NpAggregateXlStructure +
  // read-only mount on Final Pricing) and the Stop Loss workflow.
  'np-screens': 280,       //                                          (254.1)
  'prop-screens': 405,     // proportional treaty + pricing screens    (367.1)
  'shared-screens': 265,   // loss/pareto + cross-tier shared screens  (237.6)
  // 2026-08-18 RE-BASELINE, fac only. Two things changed together:
  //   • shared/fac (the facultative pricing engine) got its own manual chunk.
  //     It is pure math read from both app-core (config/wizard.js, for the
  //     family registry) and the fac screens; unassigned it landed wherever
  //     rollup reached it first. Splitting it took app-core from 87.3 to
  //     79.6 KB gzip.
  //   • The fac screens gained the excess-tower grid (Phase 3), which is
  //     screen code and belongs in this chunk.
  // fac-screens had crept to 179.9 KiB against a 180 budget before either
  // change — the gate was one commit from firing on whoever came next. Both
  // numbers below are the measured build plus ~10% headroom, the same
  // convention as the rest of this table.
  // 2026-08-18, second pass: shared/fac split its family METADATA from its
  // family ENGINES (families/meta.js + engines.js). The browser needs to know
  // that Hull & Machinery rates per mille of agreed value; it does not need
  // the hull engine, because the server prices hull. fac-engine went from
  // 67.5 KiB (eleven engines) to 25.1 KiB — smaller than before Phase 4 added
  // six families, which is the point: a family the browser does not run now
  // costs it nothing.
  'fac-screens': 205,      // fac screens incl. tower + capacity panel  (189.6)
  'fac-engine': 32,        // shared/fac — registry metadata + property  (25.1)
  // exceljs is a lazy-loaded, pay-on-click chunk — generous on purpose.
  exceljs: 1100,
};

function findChunk(prefix) {
  if (!existsSync(DIST)) return null;
  return readdirSync(DIST).find((f) => f.startsWith(`${prefix}-`) && f.endsWith('.js')) || null;
}
const gzipKB = (name) => gzipSync(readFileSync(resolve(DIST, name))).length / 1024;
const rawKB = (name) => statSync(resolve(DIST, name)).size / 1024;

describe('bundle budget', () => {
  // A missing dist/ means the build did not run first — FAIL loudly rather than
  // skip, so a green run always reflects a real measurement.
  it('dist/ exists — `vite build` must run before this test', () => {
    expect(
      existsSync(DIST),
      'client/dist/assets is missing — run `npm run build` before the bundle budget (verify + CI do this)',
    ).toBe(true);
  });

  it(`app-core gzip is within ${APP_CORE_BUDGET_KB} KB`, () => {
    const name = findChunk('app-core');
    expect(name, 'app-core chunk not found — build incomplete').toBeTruthy();
    const kb = gzipKB(name);
    expect(kb, `${name} gzip ${kb.toFixed(1)}KB > ${APP_CORE_BUDGET_KB}KB budget`).toBeLessThanOrEqual(APP_CORE_BUDGET_KB);
  });

  it(`app-core gzip stays under the hard ceiling (${APP_CORE_CEILING_KB.toFixed(0)} KB = budget + 20%)`, () => {
    const name = findChunk('app-core');
    expect(name, 'app-core chunk not found — build incomplete').toBeTruthy();
    const kb = gzipKB(name);
    expect(
      kb,
      `${name} gzip ${kb.toFixed(1)}KB exceeds the +20% ceiling (${APP_CORE_CEILING_KB.toFixed(0)}KB) — likely an eager import; trim or lazy-split`,
    ).toBeLessThanOrEqual(APP_CORE_CEILING_KB);
  });

  for (const [prefix, budgetKB] of Object.entries(RAW_BUDGETS_KB)) {
    it(`${prefix} chunk (raw) is within ${budgetKB} KB`, () => {
      const name = findChunk(prefix);
      if (!name) return; // optional feature chunk — only present if imported
      const kb = rawKB(name);
      expect(kb, `${name} raw ${kb.toFixed(1)}KB > ${budgetKB}KB`).toBeLessThan(budgetKB);
    });
  }

  it('reports initial-load gzip size (info only)', () => {
    let totalGz = 0;
    for (const prefix of ['vendor', 'app-core', 'index']) {
      const name = findChunk(prefix);
      if (name) totalGz += gzipSync(readFileSync(resolve(DIST, name))).length;
    }
    console.log(`[bundle] initial JS gzip: ${(totalGz / 1024).toFixed(0)}KB`);
    expect(totalGz).toBeGreaterThan(0);
  });
});
