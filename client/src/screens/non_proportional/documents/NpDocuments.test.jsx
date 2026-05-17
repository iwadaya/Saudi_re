// NpDocuments wrapper test — symmetric to PropDocuments. NP is the
// workflow that originally supported quote mode, so this acts as a
// regression guard around the header-pill phrasing the NP screens use
// elsewhere (NpStructure, NpTreatyDetail, …).

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

const { default: NpDocuments } = await import('./NpDocuments.jsx');

beforeEach(() => {
  lastProps.current = null;
});

describe('NpDocuments', () => {
  it('uses the NP treaty header pill and propagates quoteMode=false in pricing mode', () => {
    appState.current = { quoteMode: false };
    render(<NpDocuments />);
    expect(lastProps.current.headerPill).toBe('NON-PROPORTIONAL TREATY: DOCUMENTS');
    expect(lastProps.current.quoteMode).toBe(false);
    expect(lastProps.current.routeKey).toBe('NP_TREATY_DOCUMENTS');
  });

  it('uses the NP-QUOTE header pill and propagates quoteMode=true in quote mode', () => {
    appState.current = { quoteMode: true };
    render(<NpDocuments />);
    expect(lastProps.current.headerPill).toBe('NP-QUOTE TREATY: DOCUMENTS');
    expect(lastProps.current.quoteMode).toBe(true);
  });
});
