// Tests for the Phase-2 async-state primitive. Coverage contract
// (docs/frontend-hardening.md): success, error, stale-write/drift
// normalization, dep-change supersession, cancel-on-unmount, enabled
// gating, and manual refetch.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { useResource, describeResourceError } from './useResource';

vi.mock('../utils/errorReporter.js', () => ({ reportError: vi.fn() }));
import { reportError } from '../utils/errorReporter.js';

/** A promise the test resolves/rejects on demand. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

beforeEach(() => {
  vi.mocked(reportError).mockClear();
});

describe('useResource', () => {
  it('moves loading→loaded and exposes the data', async () => {
    const d = deferred<string>();
    const { result } = renderHook(() => useResource(() => d.promise, []));

    expect(result.current.loading).toBe(true);
    expect(result.current.data).toBeNull();

    d.resolve('payload');
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.data).toBe('payload');
    expect(result.current.error).toBeNull();
  });

  it('moves loading→error, keeps prior data, and reports the failure', async () => {
    const boom = new Error('backend down');
    const fetcher = vi.fn()
      .mockResolvedValueOnce('first')
      .mockRejectedValueOnce(boom);

    const { result } = renderHook(() => useResource(fetcher, [], { reportLabel: 'losses' }));
    await waitFor(() => expect(result.current.data).toBe('first'));

    await act(async () => { await result.current.refetch(); });

    expect(result.current.error).toBe(boom);
    expect(result.current.loading).toBe(false);
    // stale data is kept so screens can render the last good value alongside the error
    expect(result.current.data).toBe('first');
    expect(reportError).toHaveBeenCalledWith('other', boom, { source: 'useResource', label: 'losses' });
  });

  it('does not fetch while enabled=false, then fetches when it flips on', async () => {
    const fetcher = vi.fn().mockResolvedValue(42);
    const { result, rerender } = renderHook(
      ({ enabled }: { enabled: boolean }) => useResource(fetcher, [], { enabled }),
      { initialProps: { enabled: false } },
    );

    expect(fetcher).not.toHaveBeenCalled();
    expect(result.current.loading).toBe(false);

    rerender({ enabled: true });
    await waitFor(() => expect(result.current.data).toBe(42));
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('reloads when deps change and ignores the superseded response', async () => {
    const first = deferred<string>();
    const second = deferred<string>();
    const fetcher = vi.fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);

    const { result, rerender } = renderHook(
      ({ id }: { id: number }) => useResource((signal) => fetcher(id, signal), [id]),
      { initialProps: { id: 1 } },
    );

    rerender({ id: 2 });
    // resolve the OLD request late — it must not clobber the new one
    first.resolve('old-id-1');
    second.resolve('new-id-2');

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.data).toBe('new-id-2');
  });

  it('aborts the in-flight request when deps change', async () => {
    const signals: AbortSignal[] = [];
    const fetcher = vi.fn((id: number, signal: AbortSignal) => {
      signals.push(signal);
      return new Promise(() => {}); // never settles
    });

    const { rerender } = renderHook(
      ({ id }: { id: number }) => useResource((signal) => fetcher(id, signal), [id]),
      { initialProps: { id: 1 } },
    );
    rerender({ id: 2 });

    expect(signals[0].aborted).toBe(true);
    expect(signals[1].aborted).toBe(false);
  });

  it('cancels on unmount: aborts the signal and never updates state', async () => {
    const d = deferred<string>();
    let signal: AbortSignal | undefined;
    const { result, unmount } = renderHook(() =>
      useResource((s) => { signal = s; return d.promise; }, []));

    unmount();
    expect(signal?.aborted).toBe(true);

    // settle after unmount — the aborted guard must swallow it (no act()
    // warning / no setState-after-unmount)
    d.resolve('too late');
    await d.promise;
    expect(result.current.loading).toBe(true); // frozen pre-unmount snapshot
  });

  it('treats abort rejections as cancellation, not error', async () => {
    const { result, rerender } = renderHook(
      ({ id }: { id: number }) =>
        useResource(
          (signal) =>
            new Promise((_, reject) => {
              signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
              if (id === 2) setTimeout(() => reject(new Error('unreachable')), 10_000);
            }),
          [id],
        ),
      { initialProps: { id: 1 } },
    );

    rerender({ id: 2 });
    await Promise.resolve(); // let the abort rejection propagate

    expect(result.current.error).toBeNull();
    expect(reportError).not.toHaveBeenCalled();
  });

  it('refetch re-runs the fetcher and clears a previous error', async () => {
    const fetcher = vi.fn()
      .mockRejectedValueOnce(new Error('flaky'))
      .mockResolvedValueOnce('recovered');

    const { result } = renderHook(() => useResource(fetcher, []));
    await waitFor(() => expect(result.current.error).toBeTruthy());

    await act(async () => { await result.current.refetch(); });

    expect(result.current.error).toBeNull();
    expect(result.current.data).toBe('recovered');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('flipping enabled off aborts the in-flight request and stops loading', async () => {
    let signal: AbortSignal | undefined;
    const { result, rerender } = renderHook(
      ({ enabled }: { enabled: boolean }) =>
        useResource((s) => { signal = s; return new Promise(() => {}); }, [], { enabled }),
      { initialProps: { enabled: true } },
    );
    expect(result.current.loading).toBe(true);

    rerender({ enabled: false });
    expect(signal?.aborted).toBe(true);
    expect(result.current.loading).toBe(false);
  });
});

describe('describeResourceError', () => {
  it('returns null for falsy input', () => {
    expect(describeResourceError(null)).toBeNull();
    expect(describeResourceError(undefined)).toBeNull();
  });

  it('recognises STALE_WRITE bodies (412 optimistic lock)', () => {
    const err = Object.assign(new Error('API PUT → 412'), {
      status: 412,
      body: JSON.stringify({ code: 'STALE_WRITE', error: 'Stale write', current: '2026-06-01T10:00:00Z' }),
    });
    const info = describeResourceError(err);
    expect(info?.kind).toBe('stale-write');
    expect(info?.message).toMatch(/refresh to load it/i);
  });

  it('recognises PRICING_DRIFT bodies with drift counts', () => {
    const err = Object.assign(new Error('API PUT → 422'), {
      status: 422,
      body: JSON.stringify({
        code: 'PRICING_DRIFT',
        error: 'Pricing outputs failed server-side spot check',
        drifts: [{ layer_number: 1 }, { layer_number: 2 }],
      }),
    });
    const info = describeResourceError(err);
    expect(info?.kind).toBe('pricing-drift');
    expect(info?.message).toMatch(/2 drifts found/);
  });

  it('maps HttpError-like failures to kind http with status', () => {
    const err = Object.assign(new Error('API GET /api/x → 503: oops'), { status: 503 });
    expect(describeResourceError(err)).toEqual({
      kind: 'http', status: 503, message: 'API GET /api/x → 503: oops',
    });
  });

  it('falls back to unknown for plain errors and non-errors', () => {
    expect(describeResourceError(new Error('boom'))?.kind).toBe('unknown');
    expect(describeResourceError('string failure')).toEqual({ kind: 'unknown', message: 'string failure' });
  });

  it('substitutes generic messages when error messages are empty', () => {
    const blankHttp = Object.assign(new Error(''), { status: 503 });
    expect(describeResourceError(blankHttp)).toEqual({
      kind: 'http', status: 503, message: 'Request failed (503)',
    });
    expect(describeResourceError(new Error(''))).toEqual({
      kind: 'unknown', message: 'Something went wrong',
    });
  });
});

describe('useResource error reporting', () => {
  it('stringifies non-Error rejections for the reporter', async () => {
    const fetcher = vi.fn().mockRejectedValue('plain string failure');
    const { result } = renderHook(() => useResource(fetcher, [], { reportLabel: 'x' }));
    await waitFor(() => expect(result.current.error).toBe('plain string failure'));
    expect(reportError).toHaveBeenCalledWith('other', 'plain string failure', {
      source: 'useResource',
      label: 'x',
    });
  });
});
