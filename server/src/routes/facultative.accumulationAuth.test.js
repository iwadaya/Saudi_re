import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootApp } from '../../tests/integration/helpers.js';

describe('facultative accumulation refresh endpoint auth', () => {
  /** @type {{ fetchApp: Function, close: Function } | null} */
  let harness = null;

  beforeAll(async () => {
    harness = await bootApp({ verifyDb: false });
  });

  afterAll(async () => {
    if (harness) await harness.close();
  });

  it('blocks TUW users from forcing a portfolio accumulation refresh', async () => {
    const res = await harness.fetchApp('POST', '/api/fac/accumulation/refresh', {
      headers: {
        'x-user-id': '00000000-0000-0000-0000-000000000002',
        'x-user-role': 'TUW',
      },
    });

    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toMatchObject({ code: 'FORBIDDEN' });
  });
});
