// The beforeunload guard: armed only while dirtyRef.current is true, and the
// listener is removed on unmount. jsdom never fires real beforeunload, so the
// captured handler is exercised directly.
import { describe, expect, it, vi, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useUnsavedChangesGuard } from './useUnsavedChangesGuard';

afterEach(() => vi.restoreAllMocks());

function capture() {
  let handler = null;
  const add = vi.spyOn(window, 'addEventListener').mockImplementation((type, fn) => {
    if (type === 'beforeunload') handler = fn;
  });
  const remove = vi.spyOn(window, 'removeEventListener').mockImplementation(() => {});
  return { add, remove, getHandler: () => handler };
}

describe('useUnsavedChangesGuard', () => {
  it('does nothing while the form is clean', () => {
    const { getHandler } = capture();
    const dirtyRef = { current: false };
    renderHook(() => useUnsavedChangesGuard(dirtyRef));
    const e = { preventDefault: vi.fn(), returnValue: undefined };
    getHandler()(e);
    expect(e.preventDefault).not.toHaveBeenCalled();
    expect(e.returnValue).toBeUndefined();
  });

  it('asks the browser for the leave prompt while dirty', () => {
    const { getHandler } = capture();
    const dirtyRef = { current: true };
    renderHook(() => useUnsavedChangesGuard(dirtyRef));
    const e = { preventDefault: vi.fn(), returnValue: undefined };
    getHandler()(e);
    expect(e.preventDefault).toHaveBeenCalled();
    expect(e.returnValue).toBe('');
  });

  it('removes the listener on unmount', () => {
    const { remove, getHandler } = capture();
    const dirtyRef = { current: true };
    const { unmount } = renderHook(() => useUnsavedChangesGuard(dirtyRef));
    const handler = getHandler();
    unmount();
    expect(remove).toHaveBeenCalledWith('beforeunload', handler);
  });
});
