import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import LoadErrorPanel from './LoadErrorPanel.jsx';

describe('LoadErrorPanel', () => {
  it('renders as an alert with the message', () => {
    render(<LoadErrorPanel message="Couldn’t load losses." />);
    expect(screen.getByRole('alert')).toHaveTextContent('Couldn’t load losses.');
  });

  it('shows the block title only in block variant', () => {
    const { rerender } = render(<LoadErrorPanel variant="inline" title="Boom" message="x" />);
    expect(screen.queryByRole('heading', { name: 'Boom' })).toBeNull();
    rerender(<LoadErrorPanel variant="block" title="Boom" message="x" />);
    expect(screen.getByRole('heading', { name: 'Boom' })).toBeInTheDocument();
  });

  it('calls onRetry when the retry button is clicked', () => {
    const onRetry = vi.fn();
    render(<LoadErrorPanel message="x" onRetry={onRetry} retryLabel="Try again" />);
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('omits the retry button when no handler is provided', () => {
    render(<LoadErrorPanel message="x" />);
    expect(screen.queryByRole('button')).toBeNull();
  });
});
