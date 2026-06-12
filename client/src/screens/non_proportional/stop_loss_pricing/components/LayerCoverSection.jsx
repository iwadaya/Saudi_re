// @ts-check
// components/LayerCoverSection.jsx — read-only mirror of the Structure
// page's layer cover (attach LR / limit LR / EPI) plus the resolved
// "limit xs attach" currency line per layer. Pure presentation, moved
// VERBATIM from NpStopLossPricing.jsx (Phase 4.2); cell text is pinned
// by goldenMaster.test.jsx.

import { COLORS, styles, fmtMoneyFull } from './stopLossUi';

/**
 * @param {{
 *   layers: import('../state/stopLossPricingState').NormalizedLayer[],
 *   layerResults: import('../state/stopLossPricingState').StopLossResult[],
 *   layerCount: number,
 * }} props
 */
export default function LayerCoverSection({ layers, layerResults, layerCount }) {
  return (
    <div style={styles.section}>
      <div style={styles.sectionTitle}>Layer Cover · Loss-Ratio Basis</div>
      <div style={styles.sectionSub}>
        Read-only — edit on the <strong>Structure</strong> page.
        Stop Loss attaches at a loss ratio of subject premium
        (e.g. "20% xs 80% LR" pays losses between 80% and 100% LR).
        {layerCount > 1 ? ` ${layerCount} layers` : ' One layer'} from
        Treaty Detail.
      </div>

      <div style={{ overflowX: 'auto', borderRadius: 10, border: '1px solid rgba(255,255,255,0.06)' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <colgroup>
            <col style={{ width: '10%' }} />
            <col style={{ width: '18%' }} />
            <col style={{ width: '18%' }} />
            <col style={{ width: '22%' }} />
            <col style={{ width: '32%' }} />
          </colgroup>
          <thead>
            <tr>
              <th style={styles.th}>Layer</th>
              <th style={styles.th}>Attach LR %</th>
              <th style={styles.th}>Limit LR %</th>
              <th style={styles.th}>EPI</th>
              <th style={styles.th}>Resolved · Limit xs Attach</th>
            </tr>
          </thead>
          <tbody>
            {layers.map((l, i) => {
              const r = layerResults[i] || { attachment: 0, limit: 0 };
              const att = l.attachmentLossRatio === '' || l.attachmentLossRatio == null
                ? '—'
                : `${l.attachmentLossRatio}%`;
              const lim = l.limitLossRatio === '' || l.limitLossRatio == null
                ? '—'
                : `${l.limitLossRatio}%`;
              const epi = (l.epi === '' || l.epi == null || Number(l.epi) === 0)
                ? '—'
                : fmtMoneyFull(Number(l.epi));
              return (
                <tr key={i} style={{ background: i % 2 === 0 ? COLORS.rowEven : COLORS.rowOdd }}>
                  <td style={{ ...styles.td, fontWeight: 800, color: 'rgba(0,212,255,0.70)', fontSize: 13 }}>
                    L{i + 1}
                  </td>
                  <td style={{ ...styles.td, ...styles.readonlyCell, fontWeight: 700 }}>{att}</td>
                  <td style={{ ...styles.td, ...styles.readonlyCell, fontWeight: 700 }}>{lim}</td>
                  <td style={{ ...styles.td, ...styles.readonlyCell, fontWeight: 700, textAlign: 'center' }}>{epi}</td>
                  <td style={{ ...styles.td, ...styles.readonlyCell, fontWeight: 700, color: r.limit > 0 ? COLORS.cyan : 'rgba(148,163,184,0.40)' }}>
                    {r.limit > 0
                      ? <>{fmtMoneyFull(r.limit)} xs {fmtMoneyFull(r.attachment)}</>
                      : '—'}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
