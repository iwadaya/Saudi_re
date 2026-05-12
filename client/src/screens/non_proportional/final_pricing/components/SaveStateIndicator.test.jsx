import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import SaveStateIndicator from './SaveStateIndicator.jsx';

describe('SaveStateIndicator', () => {
  it('renders nothing when idle', () => {
    const { container } = render(<SaveStateIndicator saveState={{ status: 'idle', at: null, error: null }} />);
    expect(container.firstChild).toBe(null);
  });

  it('renders a polite status while saving', () => {
    render(<SaveStateIndicator saveState={{ status: 'saving', at: null, error: null }} />);
    const el = screen.getByRole('status');
    expect(el).toHaveTextContent(/saving/i);
    expect(el).toHaveAttribute('aria-live', 'polite');
  });

  it('renders saved + timestamp', () => {
    const at = new Date('2026-04-22T13:45:00Z').getTime();
    render(<SaveStateIndicator saveState={{ status: 'saved', at, error: null }} />);
    expect(screen.getByRole('status')).toHaveTextContent(/saved at/i);
  });

  it('renders an assertive alert on error with a Retry button', () => {
    const onRetry = vi.fn();
    render(<SaveStateIndicator saveState={{ status: 'error', at: null, error: 'boom' }} onRetry={onRetry} />);
    expect(screen.getByRole('alert')).toHaveTextContent(/save failed: boom/i);
    fireEvent.click(screen.getByRole('button', { name: /retry save/i }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('renders a generic error message when error is missing', () => {
    render(<SaveStateIndicator saveState={{ status: 'error', at: null, error: null }} onRetry={() => {}} />);
    expect(screen.getByRole('alert')).toHaveTextContent(/unknown error/i);
  });
});
