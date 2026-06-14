// server/tests/setup/env-isolation.js — per-test process.env isolation.
//
// Loaded via vitest `setupFiles`, so it runs in every test worker. Several specs
// mutate process.env (NODE_ENV, ALLOW_DEMO_AUTH, ALLOW_OPEN_REGISTRATION,
// PRICING_STRICT, AUTH_JWT_SECRET, …). Today that is safe only because vitest's
// default `isolate: true` resets process.env between files; it makes those specs
// implicitly order-dependent if isolation is ever relaxed (isolate:false, a
// different pool, a future vitest change) — exactly the kind of thing that turns
// a green serial run into a flaky parallel one.
//
// Snapshotting before each test and restoring after makes every test hermetic in
// process.env by OUR code, not a runner implementation detail — so the suite is
// order-independent and parallel-safe by construction. Defense-in-depth, cheap,
// and proven harmless. (Specs set the env they need per test/beforeEach, so
// nothing relies on env persisting across tests.)
import { beforeEach, afterEach } from 'vitest';

let snapshot = null;

beforeEach(() => {
  snapshot = { ...process.env };
});

afterEach(() => {
  if (!snapshot) return;
  // Remove keys a test added…
  for (const key of Object.keys(process.env)) {
    if (!(key in snapshot)) delete process.env[key];
  }
  // …and reset keys a test changed or deleted.
  for (const key of Object.keys(snapshot)) {
    if (process.env[key] !== snapshot[key]) process.env[key] = snapshot[key];
  }
  snapshot = null;
});
