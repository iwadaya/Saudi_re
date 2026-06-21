import { beforeEach, describe, expect, it, vi } from 'vitest';

const buildContractWorkbook = vi.fn(async () => ({ sheets: 1 }));
const fetchJson = vi.fn(async () => null);

vi.mock('../../../utils/contractWorkbook', () => ({
  buildContractWorkbook,
  fetchJson,
  tableSheet: (rows) => rows,
  kvSheet: (obj) => obj,
  autoSheet: (data) => data,
  noteSheet: (text) => [[text || '']],
}));

import { PROP_SCREEN_EXPORTERS, exportPropContractWorkbook } from './propWorkbookExporters.js';

describe('propWorkbookExporters quote routing', () => {
  beforeEach(() => {
    buildContractWorkbook.mockClear();
    fetchJson.mockClear();
  });

  it('uses quote endpoints when quote mode is enabled', async () => {
    const ctx = { contractId: 'quote-123', isQuote: true, signal: undefined };

    await PROP_SCREEN_EXPORTERS.PROP_TREATY_DETAIL.fetch(ctx);
    await PROP_SCREEN_EXPORTERS.PROP_TREATY_DOCUMENTS.fetch(ctx);
    await PROP_SCREEN_EXPORTERS.PROP_PREMIUM_TRIANGLES.fetch(ctx);
    await PROP_SCREEN_EXPORTERS.PROP_PROJECTED_SUMMARY.fetch(ctx);
    await PROP_SCREEN_EXPORTERS.PROP_QUICK_SUMMARY.fetch(ctx);
    await PROP_SCREEN_EXPORTERS.PROP_CRESTA_AGGREGATES.fetch(ctx);

    expect(fetchJson).toHaveBeenNthCalledWith(1, '/api/quotes/quote-123', undefined);
    expect(fetchJson).toHaveBeenNthCalledWith(2, '/api/quotes/quote-123/documents', undefined);
    expect(fetchJson).toHaveBeenNthCalledWith(3, '/api/quotes/quote-123/triangles/PREMIUM', undefined);
    expect(fetchJson).toHaveBeenNthCalledWith(4, '/api/quotes/quote-123/pricing-yearly', undefined);
    expect(fetchJson).toHaveBeenNthCalledWith(5, '/api/quotes/quote-123/pricing-outputs', undefined);
    expect(fetchJson).toHaveBeenNthCalledWith(6, '/api/quotes/quote-123/cresta', undefined);
  });

  it('keeps treaty endpoints for treaty mode', async () => {
    const ctx = { contractId: 'contract-456', isQuote: false, signal: undefined };

    await PROP_SCREEN_EXPORTERS.PROP_TREATY_DOCUMENTS.fetch(ctx);
    await PROP_SCREEN_EXPORTERS.PROP_CAT_LOSS_SELECTION.fetch(ctx);

    expect(fetchJson).toHaveBeenNthCalledWith(1, '/api/treaties/contract-456/documents', undefined);
    expect(fetchJson).toHaveBeenNthCalledWith(2, '/api/treaties/contract-456/loss-selection/CAT/latest', undefined);
  });

  it('forwards quote context into buildContractWorkbook', async () => {
    await exportPropContractWorkbook({
      contractId: 'quote-789',
      finalData: { isQuote: true },
      propDetail: {},
      triangulationsEnabled: true,
    });

    expect(buildContractWorkbook).toHaveBeenCalledTimes(1);
    const args = buildContractWorkbook.mock.calls[0][0];
    expect(args.contractId).toBe('quote-789');
    expect(args.ctx.isQuote).toBe(true);
  });
});
