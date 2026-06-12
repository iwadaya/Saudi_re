import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import AsyncBoundary from './AsyncBoundary';

vi.mock('../utils/errorReporter.js', () => ({ reportError: vi.fn() }));

describe('AsyncBoundary', () => {
  it('renders the loading state with a polite live region', () => {
    render(
      <AsyncBoundary loading label="dev factors">
        <div>content</div>
      </AsyncBoundary>,
    );
    expect(screen.getByRole('status')).toHaveTextContent('Loading dev factors…');
    expect(screen.queryByText('content')).toBeNull();
  });

  it('renders the error state as an alert with a working retry button', async () => {
    const onRetry = vi.fn();
    render(
      <AsyncBoundary error={new Error('backend down')} onRetry={onRetry}>
        <div>content</div>
      </AsyncBoundary>,
    );
    expect(screen.getByRole('alert')).toHaveTextContent('backend down');
    screen.getByRole('button', { name: 'Retry' }).click();
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('uses the shared stale-write language for 412 conflicts', () => {
    const err = Object.assign(new Error('API PUT → 412'), {
      status: 412,
      body: JSON.stringify({ code: 'STALE_WRITE', error: 'Stale write' }),
    });
    render(<AsyncBoundary error={err} />);
    expect(screen.getByRole('alert')).toHaveTextContent('Concurrent edit detected');
  });

  it('renders the empty state when empty and not loading/error', () => {
    render(
      <AsyncBoundary empty emptyMessage="No losses recorded.">
        <div>content</div>
      </AsyncBoundary>,
    );
    expect(screen.getByText('No losses recorded.')).toBeInTheDocument();
    expect(screen.queryByText('content')).toBeNull();
  });

  it('renders children when settled with data', () => {
    render(
      <AsyncBoundary loading={false} error={null} empty={false}>
        <div>content</div>
      </AsyncBoundary>,
    );
    expect(screen.getByText('content')).toBeInTheDocument();
  });
});
