import { describe, expect, it, vi, afterEach } from 'vitest';
import { handleStaleWrite } from './handleStaleWrite.js';

afterEach(() => {
  document.body.innerHTML = '';
});

function staleError() {
  return {
    status: 409,
    body: JSON.stringify({
      code: 'STALE_WRITE',
      current: '2026-05-01T10:15:00.000Z',
      expected: '2026-05-01T10:00:00.000Z',
    }),
  };
}

describe('handleStaleWrite', () => {
  it('requires an explicit refresh choice', async () => {
    const onRefresh = vi.fn();
    const promise = handleStaleWrite(staleError(), { entityType: 'treaty', onRefresh });

    expect(document.body.textContent).toContain('Your colleague saved this treaty at');
    expect(document.body.textContent).toContain('Refresh and lose my changes');
    expect(document.body.textContent).toContain('Save anyway, overwriting theirs');

    document.querySelector('[data-action="refresh"]').click();
    await expect(promise).resolves.toMatchObject({ handled: true, action: 'refresh' });
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it('runs the explicit overwrite callback', async () => {
    const onOverwrite = vi.fn().mockResolvedValue({ ok: true });
    const promise = handleStaleWrite(staleError(), { entityType: 'quote', onOverwrite });

    document.querySelector('[data-action="overwrite"]').click();
    await expect(promise).resolves.toMatchObject({
      handled: true,
      action: 'overwrite',
      result: { ok: true },
    });
    expect(onOverwrite).toHaveBeenCalledTimes(1);
  });
});
