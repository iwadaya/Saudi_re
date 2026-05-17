// PropDocuments wrapper test — guards against the regression that
// hardcoded quoteMode=false, which silently hid the "Fill from
// renewal pack" button for any prop workflow that loaded a quote.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';

const lastProps = { current: null };
vi.mock('../../shared/DocumentsScreen', () => ({
  __esModule: true,
  default: function FakeDocumentsScreen(props) {
    lastProps.current = props;
    return null;
  },
}));

const appState = { current: { quoteMode: false } };
vi.mock('../../../context/AppContext', () => ({
  useAppState: () => ({ state: appState.current }),
}));

const { default: PropDocuments } = await import('./PropDocuments.jsx');

beforeEach(() => {
  lastProps.current = null;
});

describe('PropDocuments', () => {
  it('passes the proportional treaty header pill straight through', () => {
    appState.current = { quoteMode: false };
    render(<PropDocuments />);
    expect(lastProps.current.headerPill).toBe('PROPORTIONAL TREATY: DOCUMENTS');
    expect(lastProps.current.routeKey).toBe('PROP_TREATY_DOCUMENTS');
  });

  it('propagates quoteMode=false from AppContext (treaty/pricing workflow)', () => {
    appState.current = { quoteMode: false };
    render(<PropDocuments />);
    expect(lastProps.current.quoteMode).toBe(false);
  });

  it('propagates quoteMode=true from AppContext (quote workflow on the same wizard)', () => {
    appState.current = { quoteMode: true };
    render(<PropDocuments />);
    expect(lastProps.current.quoteMode).toBe(true);
  });
});
