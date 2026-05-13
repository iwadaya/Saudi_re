# MVP Readiness Audit For 10 Underwriters

Audit date: 2026-05-13

## Verdict

Universe is technically capable of handling a 10-underwriter local smoke workload, but it is not yet ready for a clean 10-person pilot until the environment and tester identity blockers below are fixed.

Use this build for controlled internal workflow testing only. Do not treat the current setup as production-ready.

## Evidence Collected

| Check | Result | Notes |
| --- | --- | --- |
| Local app health | Pass | `/api/health` and `/api/health/deep` returned 200 after the load run. Pool waiting count was 0. |
| Production client build | Pass | `npm run build` completed. Vite reported existing circular manual chunk warnings. |
| Server unit/default suite | Pass | 253 passed, 59 skipped. DB integration tests are skipped by default. |
| Server DB integration suite | Pass | 59 passed against `postgresql://postgres@127.0.0.1:55433/reinsurance_tool` with `TEST_WITH_DB=1`. |
| Client suite | Fail | 311 passed, 1 failed: `app-core` bundle was 340.5 KB against a 320 KB budget. |
| 10 VU smoke load | Pass | 2,985 iterations, 12,136 HTTP requests, 0 failed checks, 0 rate limits. |

10 VU p95 timings:

| Surface | p95 |
| --- | ---: |
| Health | 1.29 ms |
| Lookups | 1.13 ms |
| Quote list | 4.41 ms |
| Quote CRUD | 13 ms total custom trend / 3.68 ms HTTP endpoint trend |
| Dashboard | 7.36 ms |

## Workflow Coverage

| Workflow | Current State | MVP Testing Risk |
| --- | --- | --- |
| Login and role session | Demo login works for CU and TUW with shared password. | High for 10 named testers: login screen deduplicates by role, so 10 individual underwriter identities are not usable through the UI today. |
| Home work queue | Live home summary returns drafts, quotes, submitted history, renewals, and region premium data. | Low. Needs manual UX test for findability. |
| Proportional treaty | Routes and screens exist. Client integration tests cover treaty detail, modals, pricing, triangles, dev factors, and bind-path surfaces. | Medium. Actuarial interpretation and manual end-to-end approval still need human validation. |
| Non-proportional treaty | Routes and screens exist. Tests cover treaty detail, structure, expiring structure, final pricing, stale-write handling, pricing drift handling, and quote mode. | Medium-high. Prior actuarial audit has high-severity formula/source gaps, so use for UX/process testing unless pricing assumptions are signed off. |
| Quote workflow | Quote CRUD passed DB integration and 10 VU smoke. Quote mode is represented across API and client. | Medium. Manual quote-to-approval-to-bind path should be run by real users. |
| Approval workflow | Role-gated approvals screen has integration coverage. Status transition guard passed DB integration. | Medium. Needs named users before the audit trail is meaningful for 10 testers. |
| Facultative workflow | Full screen set and API routes exist for risk detail, locations, COPE, structure, deductibles, losses, pricing, documents, and renewal. | Medium-high. Automated coverage is thinner than treaty/NP; include manual pilot tasks. |
| Dashboard and reporting | Dashboard endpoint passed load test. Portfolio export path exists. | Medium. Browser/UI dashboard workflow is not covered by the load test. |
| Documents and wording checklist | Treaty/quote document and wording checklist routes exist. Persistence integration covers document surfaces. | Medium. AI wording check requires API configuration. Manual upload/download test needed. |
| AI slip/wording features | Routes/UI exist, but local `.env` has empty AI keys. | High if testers are expected to use AI. Hide or configure before pilot. |
| Formula workbench | Server workbench tests pass; client workbench routes exist. | Low-medium. Include only if actuaries are in the test group. |
| Import/export | Excel adapter tests pass; import route exists. | Medium. Run one browser import/export test with a real workbook. |

## Blockers Before 10-Underwriter Pilot

1. Fix the active `.env` database URL before any restart or redeploy.

   Current PM2 is still healthy because it is using the old environment. The edited `.env` points at `localhost:5432`, database `universe`, user `universe`, and previously failed authentication. Restarting with that `.env` can take the app down.

2. Provide 10 distinct tester identities.

   Current login is demo-role based, not named-user based. The login UI intentionally deduplicates users by role code, so even if the database has 10 TUW accounts, the tester can only choose one visible Underwriter role row. For a real 10-underwriter audit, update login to allow named user selection or username entry, create 10 test users, and verify audit events carry distinct `x-user-id` values.

3. Resolve the red client release gate.

   `client/src/test/bundleBudget.test.js` fails because `app-core` is 340.5 KB and the budget is 320 KB. Either reduce the chunk or intentionally raise the budget with a clear note. Do not call the automated suite green until this is addressed.

4. Decide AI behavior for the pilot.

   `OPENAI_API_KEY` is empty. Either configure it or hide/disable slip ingestion and wording AI buttons for the pilot so underwriters do not hit predictable runtime errors.

## High-Risk Non-Blockers For Controlled Testing

1. Authentication is header-trusted demo auth.

   The server accepts role identity from request headers after login. This is acceptable for controlled local/staging UX testing, not production.

2. Actuarial math needs sign-off before business reliance.

   `docs/actuarial-audit.md` flags high-severity issues around parser mismatch, loading handling, quote-mode NP helper logic, and undocumented exposure/Pareto assumptions. Keep pilot scoring focused on workflow usability unless actuaries explicitly approve the assumptions.

3. Facultative and document workflows need manual smoke.

   Treaty and quote persistence are well covered. Facultative, browser dashboard interactions, file upload/download, and import/export should get manual task coverage before inviting all 10 testers.

4. npm audit warnings exist.

   Dependency install reported vulnerabilities. For an internal MVP pilot this is not the main gating issue, but it must be resolved before external or production use.

## Recommended 10-Underwriter MVP Scope

For the first pilot, use a controlled staging/local deployment with:

| Role group | Count | Tasks |
| --- | ---: | --- |
| Underwriters | 8 | Create prop treaty, create NP treaty or quote, save pricing inputs, upload a document, submit for approval. |
| Chief/manager reviewers | 2 | Review approval queue, approve/return, mark signed/NTU, inspect dashboard. |

Minimum task script:

1. Login as a named underwriter.
2. Create a proportional treaty and save treaty detail, COB, one loss/profile input, and pricing.
3. Create an NP quote with one layer, save structure, expiring terms, and final pricing.
4. Submit the NP quote for approval.
5. Login as reviewer, approve or return the submitted quote.
6. Reopen as underwriter, correct a field, and resubmit.
7. Upload and view a document.
8. Check dashboard totals and home queue state.
9. Run one facultative risk from risk detail through pricing summary.

Track:

- Failed saves or data loss
- Stale-write prompts
- Confusing units: percentages, ROL, limits, shares
- Approval state mismatches
- Any pool waiting count above 0
- Any PM2 error log entries

## Go/No-Go

Go for 10-person controlled workflow testing when:

- `.env` DB URL is valid and PM2 has been restarted with it.
- 10 named test users can log in distinctly.
- Client test suite is green or the bundle budget change is intentionally accepted.
- AI buttons are either configured or hidden.
- A facilitator has the task script and knows how to monitor `/api/health/deep` and PM2 logs.

No-go for production or business-signoff pricing until:

- Real auth/session validation replaces header-trusted role auth.
- Actuarial audit high findings are resolved or formally accepted.
- npm audit/security items are triaged.
- Browser/manual smoke passes for documents, import/export, dashboard, and facultative.

## Save And Retrieval Alignment Pass

Audit update: 2026-05-13

This pass focused on whether wizard saves reload into the same treaty or quote context a tester expects after navigation, refresh, or a later screen load.

| Area | Result | Notes |
| --- | --- | --- |
| Active treaty/quote resolution | Aligned | Wizard screens resolve IDs through `useContractId()`. Excel import now uses the same resolver instead of reading non-existent `activeContractId` and snake_case detail fields. |
| Excel import persistence | Fixed | Import now pre-fills the active contract/quote ID and passes `{ quote: true }` in quote mode, so imported losses, triangles, profiles, CRESTA, EGNPI, and NP layers save to quote endpoints when the quote wizard is active. |
| Quote-mode parsing | Fixed | Server `entityContext()` now treats `?quote=1` the same way the client API already did. `?quote=yes` still stays false to avoid broad truthy parsing. |
| NP quote historical performance | Fixed | Added `quote_np_historical_performance`, quote routes, client API switching, and screen load/save quote options. This was a real gap because Historical Performance is included in the NP quote wizard. |
| Loss list and loss selection | Good for MVP | Large/CAT loss list, selection snapshot, LDF, and latest snapshot paths are quote-aware. Snapshot sidecar save failure surfaces a warning while preserving the main loss-list save. |
| Contract-only sidecar paths | Accept for current MVP | Proportional pricing-pattern sidecar, straight-stats, and component snapshots remain contract-only. Current NP quote MVP either skips these or does not expose them as quote-owned workflows. Add quote storage if proportional quote workflows become pilot scope. |

Validation run:

- `npx vitest run --config server/vitest.config.js server/src/lib/entityContext.test.js` passed.
- `DATABASE_URL=postgresql://postgres@localhost:55433/reinsurance_tool npm --prefix server run migrate` applied `076_quote_np_historical_performance.sql`.
- `DATABASE_URL=postgresql://postgres@127.0.0.1:55433/reinsurance_tool TEST_WITH_DB=1 npx vitest run --config server/vitest.config.js server/tests/integration/quotes.integration.test.js` passed.
- `DATABASE_URL=postgresql://postgres@127.0.0.1:55433/reinsurance_tool TEST_WITH_DB=1 npx vitest run --config server/vitest.config.js server/tests/integration/contractPersistence.integration.test.js` passed.
- `npm run build` passed with existing circular chunk warnings.

Remaining save/retrieval manual smoke for 10-underwriter testing:

1. Create an NP quote, enter Historical Performance rows, navigate away, refresh, and confirm the rows reload.
2. In quote mode, use Excel import against the active quote and confirm the imported rows are visible on the target quote screens.
3. Run one contract historical-performance save to confirm contract and quote rows do not cross-populate.
4. Keep watching failed save toasts and stale-write prompts during the pilot; those are now the primary UX risks rather than obvious endpoint mismatch.
