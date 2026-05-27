import { describe, it, expect, vi } from 'vitest';
import { suggestLossQuarters, buildRowsByYear, devMonthsToReportedDate } from './lossQuarterMapper.js';

const annualRow = (year, vals) =>
  vals.map((v, i) => ({ origin_year: year, dev_months: (i + 1) * 12, cum_value: v }));

describe('buildRowsByYear', () => {
  it('groups cells by origin year with cumulative + incremental values', () => {
    const rows = buildRowsByYear(annualRow(2021, [100, 300, 320]));
    expect(rows.get(2021)).toEqual([
      { dev_months: 12, cum: 100, incr: 100 },
      { dev_months: 24, cum: 300, incr: 200 },
      { dev_months: 36, cum: 320, incr: 20 },
    ]);
  });
});

describe('devMonthsToReportedDate', () => {
  it('reverses the +1 quarter entry offset', () => {
    // entry 24m → reportedAge 21m from Jan 2021 → Oct 2022
    expect(devMonthsToReportedDate(2021, 24)).toBe('2022-10-01');
    expect(devMonthsToReportedDate(2021, 12)).toBe('2021-10-01');
    expect(devMonthsToReportedDate(2021, 3)).toBe('2021-01-01');
  });
});

describe('suggestLossQuarters', () => {
  const cells = annualRow(2021, [100, 300, 320]);
  const losses = [{ loss_id: 'a', uw_year: 2021, date_of_loss: '2021-03-10', incurred: 200 }];

  it('returns nothing and skips the LLM when there are no losses', async () => {
    const llm = vi.fn();
    const out = await suggestLossQuarters({ losses: [], triangleCells: cells, llm });
    expect(out).toEqual({ suggestions: [], provider: null });
    expect(llm).not.toHaveBeenCalled();
  });

  it('maps a suggestion and derives the reported date', async () => {
    const llm = vi.fn().mockResolvedValue({
      text: JSON.stringify({ suggestions: [{ loss_id: 'a', suggested_dev_months: 24, confidence: 'high', rationale: 'jump of 200 at 24m' }] }),
      provider: 'fake',
    });
    const out = await suggestLossQuarters({ losses, triangleCells: cells, llm });
    expect(out.provider).toBe('fake');
    expect(out.suggestions).toEqual([{
      loss_id: 'a', uw_year: 2021, suggested_dev_months: 24,
      suggested_reported_date: '2022-10-01', confidence: 'high', rationale: 'jump of 200 at 24m',
    }]);
  });

  it('clamps out-of-range dev months, defaults bad confidence, and drops unknown/invalid entries', async () => {
    const llm = vi.fn().mockResolvedValue({
      text: JSON.stringify({ suggestions: [
        { loss_id: 'a', suggested_dev_months: 999, confidence: 'bogus', rationale: 'x' }, // clamp to 36, conf→low
        { loss_id: 'z', suggested_dev_months: 12 },                                       // unknown loss → dropped
        { loss_id: 'a', suggested_dev_months: 'NaN' },                                    // invalid → dropped
      ] }),
      provider: 'fake',
    });
    const out = await suggestLossQuarters({ losses, triangleCells: cells, llm });
    expect(out.suggestions).toEqual([{
      loss_id: 'a', uw_year: 2021, suggested_dev_months: 36,
      suggested_reported_date: '2023-10-01', confidence: 'low', rationale: 'x',
    }]);
  });

  it('throws a clear error when the LLM output is not valid JSON', async () => {
    const llm = vi.fn().mockResolvedValue({ text: 'not json', provider: 'fake' });
    await expect(suggestLossQuarters({ losses, triangleCells: cells, llm })).rejects.toThrow(/parse/i);
  });
});
