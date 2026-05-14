// client/src/components/market/MarketIntelligenceModal.test.jsx
//
// Smoke + flow tests for the market-intelligence child modal. The
// underlying api.* helpers are mocked module-wide so we exercise the
// state machine (LOADING_REPORT → GENERATING_REPORT → READY) without
// touching network or DOM-only timing pitfalls.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const apiMock = {
  getLatestMarketReport: vi.fn(),
  generateMarketReport:  vi.fn(),
  getTreatyBenchmarks:   vi.fn(),
  getTreatyRecommendations:      vi.fn(),
  generateTreatyRecommendations: vi.fn(),
  stageMarketRec:        vi.fn(),
  rejectMarketRec:       vi.fn(),
  logMarketReportView:   vi.fn(async () => undefined),
};

class FakeHttpError extends Error {
  constructor(status, body) { super(`HTTP ${status}`); this.status = status; this.body = body; }
}

vi.mock('../../api.js', () => ({
  api: apiMock,
  HttpError: FakeHttpError,
}));

// IMPORTANT: return a STABLE function reference. The real hook hands
// back a module-scoped no-op when no provider is mounted; mirroring
// that here matters because the modal's runFlow includes the toast
// function in its useCallback deps. A fresh vi.fn() per call would
// re-create runFlow every render and infinite-loop the useEffect that
// depends on it.
const stableToast = vi.fn();
vi.mock('../../hooks/useToast.js', () => ({
  useGlobalToast: () => stableToast,
}));

const { default: MarketIntelligenceModal } = await import('./MarketIntelligenceModal.jsx');

// ── Fixtures ─────────────────────────────────────────────────────
const REPORT_FIXTURE = {
  report_id: 'rep-1',
  country_id: 'c1',
  class_of_business_id: 'cob1',
  target_year: 2026,
  cached: false,
  executive_summary: 'Hardening market with elevated loss ratios.',
  market_landscape: {
    regulator: 'CMA',
    regulator_recent_actions: ['Solvency II overhaul', 'NatCat capital top-up', 'Domestic cession quota raised', 'Sanctions screening update', 'Filing deadline tightened'],
    top_carriers: [{ name: 'Carrier A', am_best_rating: 'A', market_share_pct: 22 }],
    market_size_premium: { value: 500_000_000, currency: 'USD', year: 2024, source_idx: 1 },
    market_growth_pct: 7.5,
    recent_context: 'Recent context with citation [1] inside.',
  },
  market_benchmarks: {
    loss_ratio_market_avg: 62,
    loss_ratio_year: 2024,
    commission_market_norm_pct: 25,
    retention_market_norm_pct: 30,
    roe_market_avg_pct: 12,
    notes: 'From regulator filings.',
  },
  trends: [
    { title: 'Hardening', body: 'Rates up 5%.', severity: 'OPPORTUNITY', source_idx: 1 },
  ],
  recommendations: [],
  sources: [
    { idx: 1, url: 'https://example.com/source', title: 'Source 1', snippet: 'snippet' },
  ],
  model: 'claude-sonnet-4-20250514',
  generated_at: new Date().toISOString(),
};

const BENCHMARKS_FIXTURE = {
  report_id: 'rep-1',
  report_generated_at: REPORT_FIXTURE.generated_at,
  treaty_metrics: { loss_ratio_pct: 65.2, commission_pct: 26, retention_pct: 35, margin_pct: 12 },
  market_metrics: { loss_ratio_pct: 62, commission_pct: 25, retention_pct: 30, margin_pct: null },
  deltas: { loss_ratio_pct_delta: 3.2, commission_pct_delta: 1, retention_pct_delta: 5, margin_pct_delta: null },
  benchmarks_table: [
    { metric: 'Loss Ratio', treaty_value: 65.2, market_value: 62, delta: 3.2, verdict: 'WORSE',   unit: '%' },
    { metric: 'Commission', treaty_value: 26,   market_value: 25, delta: 1,   verdict: 'ON_PAR',  unit: '%' },
    { metric: 'Retention',  treaty_value: 35,   market_value: 30, delta: 5,   verdict: 'ON_PAR',  unit: '%' },
    { metric: 'Margin',     treaty_value: 12,   market_value: null, delta: null, verdict: 'NO_DATA', unit: '%' },
  ],
};

const LINE_REC = {
  rec_id: 'rec-line', action_type: 'LINE_SIZE',
  title: 'Trim line', body: 'Margin under market.',
  recommended_line_pct: 0.18, recommended_terms_changes: null,
  rationale: 'Loss ratio elevated.', confidence: 0.8,
  compliance_warnings: [], status: 'PENDING',
  staging_supported: true, staging_disabled_reason: null,
};
const TERMS_REC = {
  rec_id: 'rec-terms', action_type: 'TERMS',
  title: 'Lower commission', body: 'Push 1pt down.',
  recommended_line_pct: null, recommended_terms_changes: { commission_pct: 24 },
  rationale: 'Market tighter.', confidence: 0.6,
  compliance_warnings: [], status: 'PENDING',
  staging_supported: false,
  staging_disabled_reason: 'Terms staging not yet implemented — accept manually on the relevant treaty screen.',
};
const WARN_REC = {
  ...LINE_REC, rec_id: 'rec-warn', compliance_warnings: ['Large change (+12.0 pts) — review.'],
};

const baseProps = {
  show: true,
  onClose: vi.fn(),
  contractId: '33333333-3333-3333-3333-333333333333',
  countryId:  '11111111-1111-1111-1111-111111111111',
  classOfBusinessId: '22222222-2222-2222-2222-222222222222',
  countryName: 'Kenya',
  cobName: 'Fire',
  targetYear: 2026,
  currency: 'USD',
  treatyMetrics: { loss_ratio_pct: 65.2, commission_pct: 26, retention_pct: 35, margin_pct: 12 },
};

function renderModal(over = {}, recsOver = [LINE_REC, TERMS_REC]) {
  apiMock.getLatestMarketReport.mockResolvedValue(REPORT_FIXTURE);
  apiMock.getTreatyBenchmarks.mockResolvedValue(BENCHMARKS_FIXTURE);
  apiMock.getTreatyRecommendations.mockResolvedValue({ recommendations: recsOver });
  apiMock.generateMarketReport.mockResolvedValue(REPORT_FIXTURE);
  apiMock.generateTreatyRecommendations.mockResolvedValue({ recommendations: recsOver });
  return render(
    <MemoryRouter>
      <MarketIntelligenceModal {...baseProps} {...over} />
    </MemoryRouter>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('MarketIntelligenceModal', () => {
  it('does not render when show=false', () => {
    renderModal({ show: false });
    expect(screen.queryByText(/Market Intelligence/i)).toBeNull();
  });

  it('renders all six sections after the fetch flow resolves', async () => {
    renderModal();
    await waitFor(() => expect(screen.getByText(/Executive Summary/i)).toBeInTheDocument());
    expect(screen.getByText(/Market Landscape/i)).toBeInTheDocument();
    expect(screen.getByText(/This Treaty vs Market/i)).toBeInTheDocument();
    expect(screen.getByText(/Beyond the Model/i)).toBeInTheDocument();
    expect(screen.getAllByText(/Recommendations/i).length).toBeGreaterThan(0);
    expect(screen.getByText(/^Sources$/i)).toBeInTheDocument();
    expect(screen.getByText(/Hardening market/i)).toBeInTheDocument();
  });

  it('falls back to generate when latest returns 404', async () => {
    apiMock.getLatestMarketReport.mockRejectedValueOnce(new FakeHttpError(404, '{"error":"none"}'));
    apiMock.generateMarketReport.mockResolvedValue(REPORT_FIXTURE);
    apiMock.getTreatyBenchmarks.mockResolvedValue(BENCHMARKS_FIXTURE);
    apiMock.getTreatyRecommendations.mockResolvedValue({ recommendations: [LINE_REC] });
    render(
      <MemoryRouter><MarketIntelligenceModal {...baseProps} /></MemoryRouter>
    );
    await waitFor(() => expect(screen.getByText(/Executive Summary/i)).toBeInTheDocument());
    expect(apiMock.generateMarketReport).toHaveBeenCalledTimes(1);
    // First-mount fallback should NOT force a refresh — that's the
    // Refresh button's job. We just want a fresh generation.
    expect(apiMock.generateMarketReport.mock.calls[0][0]).not.toHaveProperty('force_refresh');
  });

  it('Refresh button calls generate with force_refresh:true', async () => {
    renderModal();
    await waitFor(() => expect(screen.getByText(/Executive Summary/i)).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /Refresh/i }));
    await waitFor(() => expect(apiMock.generateMarketReport).toHaveBeenCalledWith(
      expect.objectContaining({ force_refresh: true })
    ));
  });

  it('shows disabled tooltip when country/cob/year are missing', async () => {
    renderModal({ countryId: '', classOfBusinessId: '' });
    await waitFor(() => expect(
      screen.getByText(/Country and class of business required/i)
    ).toBeInTheDocument());
  });

  it('renders benchmarks_table with verdict chips', async () => {
    renderModal();
    await waitFor(() => expect(screen.getByText(/This Treaty vs Market/i)).toBeInTheDocument());
    expect(screen.getByText('Loss Ratio')).toBeInTheDocument();
    expect(screen.getByText('WORSE')).toBeInTheDocument();
    expect(screen.getAllByText('ON PAR').length).toBeGreaterThan(0);
    expect(screen.getByText('NO DATA')).toBeInTheDocument();
  });

  it('LINE_SIZE rec with no warnings stages without confirmation', async () => {
    apiMock.stageMarketRec.mockResolvedValue({ staging: {} });
    renderModal({}, [LINE_REC]);
    await waitFor(() => expect(screen.getByText('Trim line')).toBeInTheDocument());
    const stageBtn = screen.getByRole('button', { name: /^Stage$/ });
    fireEvent.click(stageBtn);
    await waitFor(() => expect(apiMock.stageMarketRec).toHaveBeenCalledTimes(1));
    expect(apiMock.stageMarketRec).toHaveBeenCalledWith('rec-line', {});
  });

  it('LINE_SIZE rec with warnings opens the confirm dialog', async () => {
    renderModal({}, [WARN_REC]);
    await waitFor(() => expect(screen.getByText('Trim line')).toBeInTheDocument());
    // No dialog yet — Acknowledge & Stage button only exists after click
    expect(screen.queryByRole('button', { name: /Acknowledge & Stage/i })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /^Stage$/ }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Acknowledge & Stage/i })).toBeInTheDocument()
    );
  });

  it('TERMS rec has Stage disabled with tooltip', async () => {
    renderModal({}, [TERMS_REC]);
    await waitFor(() => expect(screen.getByText('Lower commission')).toBeInTheDocument());
    const stageBtn = screen.getByRole('button', { name: /^Stage$/ });
    expect(stageBtn).toBeDisabled();
    expect(stageBtn).toHaveAttribute('title', expect.stringMatching(/Terms staging not yet implemented/));
  });

  it('empty recs renders the Generate recommendations CTA', async () => {
    renderModal({}, []);
    // After mount, the modal generates recs because the initial list is empty;
    // mock that path to also return empty so the empty-state renders.
    apiMock.generateTreatyRecommendations.mockResolvedValueOnce({ recommendations: [] });
    await waitFor(() => expect(
      screen.getByRole('button', { name: /Generate recommendations/i })
    ).toBeInTheDocument());
  });

  it('ESC closes the modal', async () => {
    const onClose = vi.fn();
    renderModal({ onClose });
    await waitFor(() => expect(screen.getByText(/Executive Summary/i)).toBeInTheDocument());
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('MarketIntelligenceModal — stale-cache banner', () => {
  it('shows an amber banner when cached report is > 30 days old', async () => {
    const STALE_AGE_MS = 31 * 24 * 3600 * 1000;
    const staleReport = {
      ...REPORT_FIXTURE,
      cached: true,
      generated_at: new Date(Date.now() - STALE_AGE_MS).toISOString(),
    };
    apiMock.getLatestMarketReport.mockResolvedValue(staleReport);
    apiMock.getTreatyBenchmarks.mockResolvedValue(BENCHMARKS_FIXTURE);
    apiMock.getTreatyRecommendations.mockResolvedValue({ recommendations: [LINE_REC] });
    render(<MemoryRouter><MarketIntelligenceModal {...baseProps} /></MemoryRouter>);
    await waitFor(() => expect(screen.getByText(/Executive Summary/i)).toBeInTheDocument());
    expect(screen.getByText(/days old/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Refresh now/i })).toBeInTheDocument();
  });

  it('no banner when cached report is ≤ 30 days old', async () => {
    const freshReport = {
      ...REPORT_FIXTURE,
      cached: true,
      generated_at: new Date(Date.now() - 5 * 24 * 3600 * 1000).toISOString(),
    };
    apiMock.getLatestMarketReport.mockResolvedValue(freshReport);
    apiMock.getTreatyBenchmarks.mockResolvedValue(BENCHMARKS_FIXTURE);
    apiMock.getTreatyRecommendations.mockResolvedValue({ recommendations: [LINE_REC] });
    render(<MemoryRouter><MarketIntelligenceModal {...baseProps} /></MemoryRouter>);
    await waitFor(() => expect(screen.getByText(/Executive Summary/i)).toBeInTheDocument());
    expect(screen.queryByText(/days old/i)).toBeNull();
  });

  it('no banner when report is freshly generated (cached:false)', async () => {
    // VALID_REPORT_OUTPUT in REPORT_FIXTURE has cached:false by default
    renderModal();
    await waitFor(() => expect(screen.getByText(/Executive Summary/i)).toBeInTheDocument());
    expect(screen.queryByText(/days old/i)).toBeNull();
  });
});

describe('MarketIntelligenceModal — REPORT_VIEWED logging', () => {
  // The modal's _viewLogged Set is module-scoped — it persists across
  // tests. Use a unique report_id here so this test isn't a no-op
  // when prior tests already logged the standard fixture's id.
  it('calls logMarketReportView with the report and contract IDs', async () => {
    const uniqueReport = { ...REPORT_FIXTURE, report_id: 'rep-unique-view-log' };
    apiMock.getLatestMarketReport.mockResolvedValue(uniqueReport);
    apiMock.getTreatyBenchmarks.mockResolvedValue(BENCHMARKS_FIXTURE);
    apiMock.getTreatyRecommendations.mockResolvedValue({ recommendations: [LINE_REC] });
    render(<MemoryRouter><MarketIntelligenceModal {...baseProps} /></MemoryRouter>);
    await waitFor(() => expect(screen.getByText(/Executive Summary/i)).toBeInTheDocument());
    await waitFor(() => expect(apiMock.logMarketReportView).toHaveBeenCalledWith({
      report_id: 'rep-unique-view-log',
      contract_id: baseProps.contractId,
    }));
  });
});
