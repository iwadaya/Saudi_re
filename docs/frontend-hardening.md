# Frontend Hardening — Screens Layer

Tracking doc for the enterprise-hardening effort on `client/src/screens/**`.
The plan runs in phases (guardrails → type safety → async unification →
design-system primitives → god-component decomposition → accessibility →
test coverage). Each phase must leave `npm run verify` green.

## Metric baseline

Counts cover `client/src/screens/**` source files (`*.test.*` excluded),
measured by `scripts/frontend-budget.mjs`. Update this table at the end of
every phase. The goal is monotonic improvement — no regression on any row.

| Metric | Plan baseline (2026-06) | Phase 0 | Phase 1 | Phase 2 | Phase 3 |
|---|---|---|---|---|---|
| Screen source files | 157 | 122 | — | — | — |
| Inline `style={{}}` (gated) | 3,256 | 3,293 | — | — | — |
| Files > 800 LOC (gated) | 15 | 15 | — | — | — |
| `onClick` on div/span/td/tr (gated) | 86 | 116 | — | — | — |
| `console.*` (gated) | 82 | 78 | — | — | — |
| `useState` calls (info) | 715 | 650 | — | — | — |
| `setLoading` calls (info) | 139 | 80 | — | — | — |
| TypeScript / typecheck coverage | 0 | 0 | api.ts + types/pricing.ts + @ts-check core math | — | — |
| Raw `fetch()` in screens | 0 | 0 (keep at 0) | 0 | — | — |

> The plan-baseline column came from one-line greps over all `.jsx` files
> (tests included). Phase 0 onward uses `scripts/frontend-budget.mjs`, which
> excludes test files and scans multi-line JSX tags, so some counts shifted
> (e.g. `onClick` on non-interactive elements is *higher* because multi-line
> opening tags are now caught). The budget script numbers are authoritative
> from Phase 0 on.

## The budget gate

`npm run budget:frontend` (wired into `npm run verify`) compares the current
counts against `scripts/frontend-budget.baseline.json` and **fails if any
gated metric exceeds its baseline** — the ratchet only turns one way.

After a genuine improvement, lock it in:

```sh
npm run budget:frontend -- --update-baseline
git add scripts/frontend-budget.baseline.json
```

Never re-baseline upward. If the gate blocks you, remove the regression
(use the `ui/` primitives instead of inline styles, a `<button>` instead of a
clickable `<div>`, the toast/errorReporter path instead of `console.*`).

## Lint ratchet (Phase 0)

`eslint.config.js` enforces, for `client/src/screens/**` (tests excluded):

- `no-console`: **error** (`console.warn`/`console.error` allowed — they are
  mirrored by `errorReporter`; everything else belongs in the toast path).
- `max-lines`: warn at 800 (an error in CI since lint runs `--max-warnings=0`);
  files already over 800 at baseline are pinned in `OVERSIZED_SCREENS_LEGACY`
  with a hard error at 1,500.
- `react-hooks/exhaustive-deps`: **error** (stale closures in pricing screens
  are silent money bugs).

### Oversized-file ledger (decomposition targets, Phase 4)

Files carrying a file-level `eslint-disable max-lines` (already > 1,500 LOC at
baseline) — each must be decomposed, then have its disable removed:

| File | LOC at baseline | Status |
|---|---|---|
| `non_proportional/final_pricing/NpFinalPricing.jsx` | 4,131 | TODO(hardening): split |
| `non_proportional/structure/NpStructure.jsx` | 1,710 | TODO(hardening): split |
| `shared/LossParetoScreen.jsx` | 1,634 | TODO(hardening): split |

Files pinned at the 1,500 hard cap (between 800 and 1,500 at baseline) are
listed in `OVERSIZED_SCREENS_LEGACY` in `eslint.config.js`; shrink one below
800 and delete its entry.

## Type-safety notes (Phase 1)

- `client/tsconfig.json` runs `tsc --noEmit` in **strict** mode: all `.ts`
  files are fully checked; `.js`/`.jsx` opt in via a leading `// @ts-check`.
  `npm run typecheck` is wired into `verify`.
- `client/src/api.ts` (converted from api.js): every endpoint has an explicit
  return type. Money-path endpoints return the canonical interfaces in
  `client/src/types/pricing.ts`, derived from the actual server responses.
  Unverified long-tail endpoints return `unknown` on purpose — verify against
  `server/src` and promote to a real interface before consuming from typed code.
- **The NumericLike trap**: Postgres NUMERIC columns arrive as JSON *strings*
  (no pg type parser is registered server-side). Typed code must coerce with
  `cn()`/`toN()` before any arithmetic or comparison.
- `@ts-check` now guards `shared/pricingMath.js` and
  `client/src/utils/npPricingEngine.js` (the core pricing math).

### Genuine type defects surfaced by Phase 1

| Where | Defect | Resolution |
|---|---|---|
| `npPricingEngine.js` `calcParetoROL` | `savedParams?.pareto_alpha > 0` compared a DB NUMERIC **string** with relational coercion (`"1,250" > 0` is `false`; plain `"123.4" > 0` only works by accident) | Coerce with `cn()` before comparing |
| `npPricingEngine.js` `calcParetoROL` (raw-fit branch) | `years` could be assigned the raw `observation_years` string and flow into division | Coerce with `cn()` |
| `client/src/test/bundleBudget.test.js` | Latent pre-existing failure: `shared-screens` chunk is 229 KiB vs the test's 200 KiB budget. The test self-skips when `client/dist` is absent, which is why CI never sees it — building locally before `npm test` will fail. Verified pre-existing on the base branch (chunk sizes byte-identical before/after the api.ts conversion). | Track for Phase 4 (decomposition should shave the chunk); do not raise the budget |

## Phase log

- **Phase 0 (guardrails)** — screens lint ratchet (`no-console`,
  `max-lines`, `exhaustive-deps=error`), budget gate script + baseline wired
  into `verify`, removed 4 debug `console.log` from `PropPricing.jsx`, fixed
  the two pre-existing `exhaustive-deps` violations (`PropPricing.jsx` missing
  `td.treatyTypeId` — market averages did not refresh on treaty-type change;
  `NpStructure.jsx` missing the referentially-stable `replaceSlice`).
- **Phase 1.1 (type safety: contracts)** — strict incremental TS (`tsc
  --noEmit` in `verify`), `api.js → api.ts` with typed returns for all
  endpoints, canonical pricing interfaces in `types/pricing.ts`, `@ts-check`
  on `shared/pricingMath.js` + `npPricingEngine.js`. Bundle verified
  size-identical pre/post conversion.
