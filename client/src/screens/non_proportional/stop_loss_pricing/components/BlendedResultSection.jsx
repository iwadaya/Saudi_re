// @ts-check
// components/BlendedResultSection.jsx — per-layer blended result table
// (annual layer loss, pure ROL, loaded total rate, premium), the
// multi-layer programme TOTAL row, and the engine warnings box. Pure
// presentation, moved VERBATIM from NpStopLossPricing.jsx (Phase 4.2);
// every cell is pinned by goldenMaster.test.jsx.

import { COLORS, styles, fmtMoneyFull, fmtPct } from './stopLossUi';

/**
 * @param {{
 *   layerResults: import('../state/stopLossPricingState').StopLossResult[],
 *   result: import('../state/stopLossPricingState').StopLossResult,
 * }} props
 */
export default function BlendedResultSection({ layerResults, result }) {
  return (
    <div style={styles.section}>
      <div style={styles.sectionTitle}>Blended Result · By Layer</div>
      <div style={{ overflowX: 'auto', borderRadius: 10, border: '1px solid rgba(255,255,255,0.06)' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              <th style={styles.th}>Layer</th>
              <th style={styles.th}>Limit xs Attach</th>
              <th style={styles.th}>Annual Layer Loss</th>
              <th style={styles.th}>Pure ROL</th>
              <th style={styles.th}>Total Rate</th>
              <th style={styles.th}>Premium</th>
            </tr>
          </thead>
          <tbody>
            {layerResults.map((lr, i) => (
              <tr key={i} style={{ background: i % 2 === 0 ? COLORS.rowEven : COLORS.rowOdd }}>
                <td style={{ ...styles.td, fontWeight: 800, color: 'rgba(0,212,255,0.70)', fontSize: 13 }}>
                  L{i + 1}
                </td>
                <td style={{ ...styles.td, ...styles.readonlyCell, fontWeight: 600, textAlign: 'center' }}>
                  {lr.limit > 0 ? <>{fmtMoneyFull(lr.limit)} xs {fmtMoneyFull(lr.attachment)}</> : '—'}
                </td>
                <td style={{ ...styles.td, ...styles.readonlyCell, fontWeight: 700, color: COLORS.cyan, textAlign: 'center' }}>
                  {lr.blended.annualLoss > 0 ? fmtMoneyFull(lr.blended.annualLoss) : '—'}
                </td>
                <td style={{ ...styles.td, ...styles.readonlyCell, fontWeight: 700, color: COLORS.amber }}>
                  {fmtPct(lr.blended.rol, 3)}
                </td>
                <td style={{ ...styles.td, ...styles.readonlyCell, fontWeight: 700, color: COLORS.green }}>
                  {fmtPct(lr.blended.totalRate, 3)}
                </td>
                <td style={{ ...styles.td, ...styles.readonlyCell, fontWeight: 700, color: COLORS.green, textAlign: 'center' }}>
                  {lr.limit > 0 ? fmtMoneyFull(lr.blended.totalRate * lr.limit) : '—'}
                </td>
              </tr>
            ))}
          </tbody>
          {layerResults.length > 1 && (() => {
            const totalLoss = layerResults.reduce((s, lr) => s + (lr.blended?.annualLoss || 0), 0);
            const totalPremium = layerResults.reduce((s, lr) => s + (lr.blended?.totalRate || 0) * (lr.limit || 0), 0);
            const totalLimit = layerResults.reduce((s, lr) => s + (lr.limit || 0), 0);
            const programmeRol = totalLimit > 0 ? totalLoss / totalLimit : 0;
            return (
              <tfoot>
                <tr style={{ background: 'rgba(0,212,255,0.06)', borderTop: '2px solid rgba(0,212,255,0.30)' }}>
                  <td style={{ ...styles.td, fontWeight: 800, color: COLORS.cyan, letterSpacing: '.08em' }}>TOTAL</td>
                  <td style={{ ...styles.td, ...styles.readonlyCell, fontWeight: 700, textAlign: 'center' }}>
                    {fmtMoneyFull(totalLimit)}
                  </td>
                  <td style={{ ...styles.td, ...styles.readonlyCell, fontWeight: 800, color: COLORS.cyan, textAlign: 'center' }}>
                    {fmtMoneyFull(totalLoss)}
                  </td>
                  <td style={{ ...styles.td, ...styles.readonlyCell, fontWeight: 800, color: COLORS.amber }}>
                    {fmtPct(programmeRol, 3)}
                  </td>
                  <td style={{ ...styles.td, ...styles.readonlyCell, color: 'rgba(148,163,184,0.55)' }}>—</td>
                  <td style={{ ...styles.td, ...styles.readonlyCell, fontWeight: 800, color: COLORS.green, textAlign: 'center' }}>
                    {fmtMoneyFull(totalPremium)}
                  </td>
                </tr>
              </tfoot>
            );
          })()}
        </table>
      </div>

      {result.warnings && result.warnings.length > 0 && (
        <div style={styles.warningBox}>
          <div style={{ fontWeight: 800, marginBottom: 4, letterSpacing: '.08em', textTransform: 'uppercase', fontSize: 10 }}>
            Warnings
          </div>
          <ul style={{ margin: 0, paddingLeft: 16 }}>
            {result.warnings.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
