import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootApp } from '../../tests/integration/helpers.js';

describe('facultative rate-governance endpoint auth', () => {
  /** @type {{ fetchApp: Function, close: Function } | null} */
  let harness = null;

  beforeAll(async () => {
    harness = await bootApp({ verifyDb: false });
  });

  afterAll(async () => {
    if (harness) await harness.close();
  });

  const lowAuthorityHeaders = {
    'x-user-id': '00000000-0000-0000-0000-000000000002',
    'x-user-role': 'TUW',
  };

  it('blocks TUW users from creating rate revisions', async () => {
    const res = await harness.fetchApp('POST', '/api/fac/admin/rate-versions', {
      headers: lowAuthorityHeaders,
      body: {
        version_label: 'AUTHZ-TEST',
        owner_note: 'Should never reach the handler',
      },
    });

    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toMatchObject({
      code: 'FORBIDDEN',
    });
  });

  it('blocks TUW users from listing rate revisions', async () => {
    const res = await harness.fetchApp('GET', '/api/fac/admin/rate-versions', {
      headers: lowAuthorityHeaders,
    });

    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toMatchObject({
      code: 'FORBIDDEN',
    });
  });
});
