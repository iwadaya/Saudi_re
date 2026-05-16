import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import Toast from './Toast.jsx';

// The Toast host carries the live region the rest of the app relies on
// for screen-reader announcements (save success/failure etc). Locking
// the role + aria-live attributes down so a future refactor can't quietly
// remove them.

describe('Toast', () => {
  it('always renders a polite live region (even when empty)', () => {
    render(<Toast toasts={[]} />);
    const host = screen.getByRole('status');
    expect(host).toBeInTheDocument();
    expect(host).toHaveAttribute('aria-live', 'polite');
  });

  it('renders each toast message', () => {
    render(<Toast toasts={[
      { id: 1, msg: 'Saved' },
      { id: 2, msg: 'Loaded' },
    ]} />);
    expect(screen.getByText('Saved')).toBeInTheDocument();
    expect(screen.getByText('Loaded')).toBeInTheDocument();
  });

  it('keys by id so React reconciliation is stable on quick succession toasts', () => {
    const { rerender } = render(<Toast toasts={[{ id: 1, msg: 'First' }]} />);
    expect(screen.getByText('First')).toBeInTheDocument();
    rerender(<Toast toasts={[{ id: 2, msg: 'Second' }]} />);
    expect(screen.queryByText('First')).not.toBeInTheDocument();
    expect(screen.getByText('Second')).toBeInTheDocument();
  });

  it('renders an actionable toast as a button when onClick is provided', () => {
    const onClick = vi.fn();
    render(<Toast toasts={[{ id: 1, msg: 'Tap for details', onClick }]} />);
    const btn = screen.getByRole('button', { name: 'Tap for details' });
    fireEvent.click(btn);
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});
