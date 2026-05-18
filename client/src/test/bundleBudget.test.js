// client/src/test/bundleBudget.test.js
// Fails CI if any of the main bundle chunks grow beyond a budget.
// Catches the "oops I statically imported exceljs again" regression
// and general bundle creep.
//
// Budgets are gzipped sizes in KB. Bump deliberately when a feature
// justifies it — every bump should be a conscious commit message
// line, not a silent drift upward.
//
// The test skips if client/dist doesn't exist (e.g. on a fresh clone
// before `npm run build`). Treat it as an optional check locally and
// a hard gate in CI after the build step.

import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, statSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { gzipSync } from 'node:zlib';

const DIST = resolve('client/dist/assets');

// Match chunks by prefix — Vite adds a content hash to each filename.
// Budgets in KB (uncompressed). gzipped budget is roughly 30-35% of
// this, so uncompressed is the simpler knob to tune.
//
// Each budget carries ~10% headroom over the actual chunk size at the
// time it was set, so a small follow-up feature doesn't immediately
// trip the gate. When you legitimately need to bump, do it here with
// a commit-message line explaining what justified the growth.
const BUDGETS_KB = {
  vendor: 300,             // React + router, plus non-lazy deps
  'app-core': 460,         // global components + utils + context + api surface
  'np-final-pricing': 250, // the big screen — still the biggest after the split
  // Bumped to 260 for the Aggregate XL structure (NpAggregateXlStructure
  // + read-only mount on Final Pricing) and the Stop Loss workflow
  // (NpStopLossStructure, NpStopLossExpiring, rate-changes modal, the
  // burning-cost restructure).
  'np-screens': 260,
  'prop-screens': 240,
  'shared-screens': 200,
  'fac-screens': 180,      // facultative AI doc-ingest + reference data + clauses
  // exceljs is a lazy-loaded chunk, NOT added to the initial page load —
  // we budget it separately because it represents pay-on-click cost.
  // (exceljs is larger than xlsx was — ~900KB raw, ~200KB gz — so the
  // budget here is generous. We accept the tradeoff for the CVE fix.)
  exceljs: 1100,
};

function findChunk(prefix) {
  if (!existsSync(DIST)) return null;
  const files = readdirSync(DIST);
  return files.find((f) => f.startsWith(`${prefix}-`) && f.endsWith('.js')) || null;
}

describe.skipIf(!existsSync(DIST))('bundle budget', () => {
  for (const [prefix, budgetKB] of Object.entries(BUDGETS_KB)) {
    it(`${prefix} chunk is within ${budgetKB} KB`, () => {
      const name = findChunk(prefix);
      if (!name) {
        // Some chunks only exist if the corresponding feature is
        // imported; skip silently rather than fail on an absent one.
        return;
      }
      const path = resolve(DIST, name);
      const bytes = statSync(path).size;
      const kb = bytes / 1024;
      expect(kb, `${name} exceeds budget: ${kb.toFixed(1)}KB > ${budgetKB}KB`).toBeLessThan(budgetKB);
    });
  }

  it('reports total initial-load bundle size (not a budget, info only)', () => {
    // "Initial load" = vendor + app-core + index (the first chunks
    // the browser fetches before any lazy route kicks in). We want to
    // see this number in test output so creep is visible; no assertion.
    if (!existsSync(DIST)) return;
    const files = readdirSync(DIST);
    const initial = ['vendor', 'app-core', 'index'];
    let totalRaw = 0;
    let totalGz = 0;
    for (const prefix of initial) {
      const name = files.find((f) => f.startsWith(`${prefix}-`) && f.endsWith('.js'));
      if (!name) continue;
      const bytes = readFileSync(resolve(DIST, name));
      totalRaw += bytes.length;
      totalGz += gzipSync(bytes).length;
    }
     
    console.log(`[bundle] initial JS: ${(totalRaw / 1024).toFixed(0)}KB raw, ${(totalGz / 1024).toFixed(0)}KB gz`);
    expect(totalGz).toBeGreaterThan(0);
  });
});
