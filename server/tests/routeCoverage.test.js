// tests/routeCoverage.test.js
// Import + wiring coverage for the API surface.
//
// smoke.test.js imports a hand-picked subset of routers. This file goes
// further: it drives registerApiRoutes() against a fake app so EVERY router
// it mounts is exercised (a new router added to the list but broken at import
// time fails here), and it pins the paths of the routers that previously had
// no focused coverage — ldfBlending, aiCedant, renewalPack (export), and the
// renewal-pack import router.
//
// No DB needed: the pg pool is constructed lazily, so importing route modules
// and reading their `.stack` is safe without DATABASE_URL.

import { describe, it, expect } from 'vitest';
import { registerApiRoutes } from '../src/routes/registerApiRoutes.js';

/** Collect the concrete route paths an Express router exposes. */
function routePaths(router) {
  return router.stack
    .filter((layer) => layer.route)
    .map((layer) => layer.route.path);
}

/** Does the router expose a route at `path` answering `method`? */
function hasRoute(router, method, path) {
  return router.stack.some(
    (layer) => layer.route?.path === path && layer.route?.methods?.[method.toLowerCase()],
  );
}

describe('registerApiRoutes wires every router', () => {
  it('mounts all routers under /api without import errors', () => {
    const mounted = [];
    // Minimal Express-app stand-in: registerApiRoutes only calls app.use().
    const fakeApp = {
      use(prefix, router) {
        mounted.push({ prefix, router });
      },
    };

    registerApiRoutes(fakeApp);

    // The list in registerApiRoutes.js — keep this in lockstep with it.
    // 27 since facDashboardRouter (facultative portfolio dashboard) joined the list.
    expect(mounted.length).toBe(27);
    expect(mounted.every((m) => m.prefix === '/api')).toBe(true);
    // Every mounted value is an Express router (callable with a .stack array).
    expect(mounted.every((m) => typeof m.router === 'function' && Array.isArray(m.router.stack))).toBe(true);
  });
});

describe('focused route coverage for previously-uncovered routers', () => {
  it('ldfBlending exposes the GET/POST/PUT ldf-blend routes', async () => {
    const { default: router } = await import('../src/routes/ldfBlending.js');
    const path = '/contracts/:contractId/ldf-blend/:triangleType';
    expect(hasRoute(router, 'get', path)).toBe(true);
    expect(hasRoute(router, 'post', path)).toBe(true);
    expect(hasRoute(router, 'put', path)).toBe(true);
  });

  it('renewalPack exposes GET /renewal-pack/export', async () => {
    const { default: router } = await import('../src/routes/renewalPack.js');
    expect(hasRoute(router, 'get', '/renewal-pack/export')).toBe(true);
  });

  it('renewalPackImport exposes the import + snapshot routes for quotes and treaties', async () => {
    const { default: router } = await import('../src/routes/renewalPackImport.js');
    const paths = routePaths(router);
    for (const p of [
      '/quotes/:quoteId/import-renewal-pack',
      '/treaties/:contractId/import-renewal-pack',
      '/quotes/:quoteId/import-snapshots',
      '/treaties/:contractId/import-snapshots',
    ]) {
      expect(paths).toContain(p);
    }
    // Restore is a POST, mirrored for both parent types.
    expect(hasRoute(router, 'post', '/quotes/:quoteId/import-snapshots/:snapshotId/restore')).toBe(true);
    expect(hasRoute(router, 'post', '/treaties/:contractId/import-snapshots/:snapshotId/restore')).toBe(true);
  });

  it('aiCedant imports cleanly and exposes at least one route', async () => {
    const { default: router } = await import('../src/routes/aiCedant.js');
    expect(typeof router).toBe('function');
    expect(routePaths(router).length).toBeGreaterThan(0);
  });
});
