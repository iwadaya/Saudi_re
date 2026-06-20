import { describe, it, expect, vi } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';

// Capture the toast emitted on save failure (was a window.alert).
const { toastSpy } = vi.hoisted(() => ({ toastSpy: vi.fn() }));
vi.mock('./useToast.js', () => ({ useGlobalToast: () => toastSpy }));

import { useScreenSave } from './useScreenSave.js';

// We control the loader/save promises so we can assert ordering and
// the dirty-skip + alert-on-failure invariants the wizard relies on.

describe('useScreenSave', () => {
  it('does nothing when entityId is empty', async () => {
    const load = vi.fn();
    const save = vi.fn();
    renderHook(() =>
      useScreenSave({ entityId: '', load, save, currentState: () => ({}) }),
    );
    expect(load).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });

  it('loads on mount and calls onLoaded with the data', async () => {
    const onLoaded = vi.fn();
    renderHook(() =>
      useScreenSave({
        entityId: 'X',
        load: vi.fn().mockResolvedValue({ name: 'cedant' }),
        save: vi.fn(),
        currentState: () => ({}),
        onLoaded,
      }),
    );
    await waitFor(() => expect(onLoaded).toHaveBeenCalledWith({ name: 'cedant' }));
  });

  it('save() is a no-op when nothing is dirty', async () => {
    const save = vi.fn().mockResolvedValue();
    const { result } = renderHook(() =>
      useScreenSave({
        entityId: 'X',
        load: vi.fn().mockResolvedValue({}),
        save,
        currentState: () => ({}),
      }),
    );
    await waitFor(() => expect(result.current.loadedRef.current).toBe(true));

    let ok;
    await act(async () => { ok = await result.current.save(); });
    expect(ok).toBe(true);
    expect(save).not.toHaveBeenCalled();
  });

  it('save() persists current state and clears the dirty flag', async () => {
    const persisted = vi.fn().mockResolvedValue({ ok: true });
    let snapshot = { v: 1 };
    const { result } = renderHook(() =>
      useScreenSave({
        entityId: 'X',
        load: vi.fn().mockResolvedValue({}),
        save: persisted,
        currentState: () => snapshot,
        errorLabel: 'Test',
      }),
    );
    await waitFor(() => expect(result.current.loadedRef.current).toBe(true));

    act(() => result.current.markDirty());
    snapshot = { v: 2 };

    let ok;
    await act(async () => { ok = await result.current.save(); });
    expect(ok).toBe(true);
    expect(persisted).toHaveBeenCalledWith('X', { v: 2 });
    expect(result.current.dirtyRef.current).toBe(false);

    // Subsequent save with no edits should skip
    await act(async () => { ok = await result.current.save(); });
    expect(persisted).toHaveBeenCalledTimes(1);
  });

  it('save() returns false and toasts when the API throws', async () => {
    toastSpy.mockClear();
    const consoleErr = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const { result } = renderHook(() =>
        useScreenSave({
          entityId: 'X',
          load: vi.fn().mockResolvedValue({}),
          save: vi.fn().mockRejectedValue(new Error('boom')),
          currentState: () => ({}),
          errorLabel: 'Cope',
        }),
      );
      await waitFor(() => expect(result.current.loadedRef.current).toBe(true));
      act(() => result.current.markDirty());

      let ok;
      await act(async () => { ok = await result.current.save(); });
      expect(ok).toBe(false);
      expect(toastSpy).toHaveBeenCalledWith(expect.stringContaining('Cope save failed'));
      // dirty stays true so the user can retry
      expect(result.current.dirtyRef.current).toBe(true);
    } finally {
      consoleErr.mockRestore();
    }
  });

  it('captures load errors in loadError', async () => {
    const consoleErr = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const { result } = renderHook(() =>
        useScreenSave({
          entityId: 'X',
          load: vi.fn().mockRejectedValue(new Error('network')),
          save: vi.fn(),
          currentState: () => ({}),
          errorLabel: 'Test',
        }),
      );
      await waitFor(() => expect(result.current.loadError).toBeInstanceOf(Error));
    } finally { consoleErr.mockRestore(); }
  });
});
