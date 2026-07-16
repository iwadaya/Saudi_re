// @ts-check
// components/BurningCostSection.jsx — on-level burning-cost table (one
// editable aggregate-loss input per UW year, Excel-paste aware) plus the
// burning-cost summary cards. Pure presentation, moved VERBATIM from
// NpStopLossPricing.jsx (Phase 4.2); the adjusted-premium / loss-ratio /
// layer-hit cells are pinned by goldenMaster.test.jsx.

import { COLORS, styles, fmtMoneyFull } from './stopLossUi';
import { BurningCostSummary } from './MethodSummaries';
import { formatWithCommasDecimal, sanitizeNumber } from '../../../../utils/format';

/**
 * @param {{
 *   burningCostRows: import('../state/stopLossPricingState').BurningCostRow[],
 *   layerResults: import('../state/stopLossPricingState').StopLossResult[],
 *   result: import('../state/stopLossPricingState').StopLossResult,
 *   setYearAggregate: (year: number, raw: string) => void,
 *   handleAggregatePaste: (e: import('react').ClipboardEvent<HTMLInputElement>, startIdx: number) => void,
 * }} props
 */
export default function BurningCostSection({
  burningCostRows, layerResults, result, setYearAggregate, handleAggregatePaste,
}) {
  return (
    <div style={styles.section}>
      <div style={styles.sectionTitle}>Burning Cost · Loss Ratios by UW Year</div>
      <div style={styles.sectionSub}>
        Premium comes from the Premiums Table and is on-levelled by
        the rate changes captured there. Loss Ratio = Aggregate
        Loss ÷ Premium (adjusted); Layer Hit applies the LR layer
        to that ratio and converts back to currency at the current
        EPI. Paste a column of losses from Excel.
      </div>
      <div style={{ overflowX: 'auto', borderRadius: 10, border: '1px solid rgba(255,255,255,0.06)' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              <th style={styles.th}>UW Year</th>
              <th style={styles.th}>Premium (Adjusted)</th>
              <th style={styles.th}>Aggregate Loss</th>
              <th style={styles.th}>Loss Ratio</th>
              {layerResults.map((_, li) => (
                <th key={li} style={styles.th}>
                  {layerResults.length === 1 ? 'Layer Hit' : `L${li + 1} Hit`}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {burningCostRows.map((r, i) => {
              const lrColor = r.lossRatio == null
                ? 'rgba(148,163,184,0.40)'
                : r.lossRatio > 1.0
                  ? COLORS.red
                  : r.lossRatio > 0.8
                    ? COLORS.amber
                    : COLORS.green;
              return (
                <tr key={r.year} style={{ background: i % 2 === 0 ? COLORS.rowEven : COLORS.rowOdd }}>
                  <td style={{ ...styles.td, fontWeight: 800, color: 'rgba(0,212,255,0.70)', fontSize: 13 }}>
                    {r.year}
                  </td>
                  <td style={{ ...styles.td, ...styles.readonlyCell, textAlign: 'center' }}>
                    {Number.isFinite(r.adjustedPremium) ? (
                      <>
                        {fmtMoneyFull(r.adjustedPremium)}
                        {Math.abs(r.onLevelFactor - 1) > 1e-6 && (
                          <span style={{ marginLeft: 6, fontSize: 10, color: 'rgba(148,163,184,0.45)' }}>
                            ×{r.onLevelFactor.toFixed(3)}
                          </span>
                        )}
                      </>
                    ) : (
                      <span style={{ color: 'rgba(148,163,184,0.40)' }}>— (set premium)</span>
                    )}
                  </td>
                  <td style={styles.td}>
                    <input
                      style={{ ...styles.input, maxWidth: 220, margin: '0 auto', textAlign: 'center' }}
                      inputMode="decimal"
                      value={formatWithCommasDecimal(r.aggregateRaw ?? '')}
                      onChange={(e) => setYearAggregate(r.year, sanitizeNumber(e.target.value))}
                      onPaste={(e) => handleAggregatePaste(e, i)}
                      placeholder="0"
                    />
                  </td>
                  <td style={{ ...styles.td, ...styles.readonlyCell, color: lrColor, fontWeight: 700 }}>
                    {r.lossRatio == null ? '—' : `${(r.lossRatio * 100).toFixed(1)}%`}
                  </td>
                  {layerResults.map((lr, li) => {
                    const hit = lr.burningCost?.byYear?.find((b) => b.year === r.year)?.inLayer ?? 0;
                    return (
                      <td
                        key={li}
                        style={{
                          ...styles.td,
                          ...styles.readonlyCell,
                          color: hit > 0 ? COLORS.amber : 'rgba(148,163,184,0.40)',
                          fontWeight: 700,
                          textAlign: 'center',
                        }}
                      >
                        {hit > 0 ? fmtMoneyFull(hit) : '—'}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <BurningCostSummary result={result.burningCost} />
    </div>
  );
}
