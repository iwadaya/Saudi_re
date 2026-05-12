// LossAnalysisModal.jsx
// Renewal-cycle comparison view for large/cat losses on a contract.
//
// Each loss row carries a `reported_date` — the date the loss first entered
// this contract's loss list. Grouping by reported_date gives us the natural
// "report batches" and lets us answer two questions on renewal:
//   1. Which losses are NEW since the previous report?
//   2. Which losses already existed but show different paid/os figures
//      between the latest batch and the prior batch (potential discrepancy)?
//
// The modal is intentionally read-only — it's an analysis surface. Editing
// happens on the loss list grid behind it.
import { useCallback, useMemo, useState } from 'react';
import { dateInputValue, toN as cn } from '../../utils/format';

const fmt = n => n === 0 ? '–' : Number(n).toLocaleString('en-US', { maximumFractionDigits: 0 });

// Stable identity for matching the same loss across report batches.
// We don't have a perfect key, so use insured + loss_name + date_of_loss.
function lossKey(l) {
  return [
    String(l.insured_name || '').trim().toLowerCase(),
    String(l.loss_name || '').trim().toLowerCase(),
    dateInputValue(l.date_of_loss || ''),
  ].join('|');
}

function batchTotals(rows) {
  let paid = 0, os = 0, inc = 0;
  for (const r of rows) { paid += cn(r.paid); os += cn(r.os); inc += cn(r.incurred) || (cn(r.paid) + cn(r.os)); }
  return { paid, os, inc, count: rows.length };
}

const TABS = [
  { key: 'batches', label: 'Report Batches' },
  { key: 'compare', label: 'Compare' },
];

export default function LossAnalysisModal({ losses = [], lossType = 'large', onClose }) {
  const [tab, setTab] = useState('batches');

  // Group by reported_date. Losses without one fall into "Unknown".
  const batches = useMemo(() => {
    const m = new Map();
    for (const l of losses) {
      const d = dateInputValue(l.reported_date || l.reportedDate || '') || '—';
      if (!m.has(d)) m.set(d, []);
      m.get(d).push(l);
    }
    // Sort: real dates desc, "—" last
    return [...m.entries()]
      .sort((a, b) => {
        if (a[0] === '—') return 1;
        if (b[0] === '—') return -1;
        return b[0].localeCompare(a[0]);
      })
      .map(([date, rows]) => ({ date, rows, ...batchTotals(rows) }));
  }, [losses]);

  // Compare tab: pick two batches (defaults to latest two).
  const realBatches = batches.filter(b => b.date !== '—');
  const [leftDate, setLeftDate] = useState(realBatches[1]?.date || '');
  const [rightDate, setRightDate] = useState(realBatches[0]?.date || '');

  // For "Compare", consider all losses with reported_date <= the chosen date
  // (snapshot-as-of-date semantics) so we capture every loss that existed at
  // that point in time, not just ones reported on that exact day.
  const snapshotAsOf = useCallback((asOfDate) => {
    if (!asOfDate) return [];
    return losses.filter(l => {
      const d = dateInputValue(l.reported_date || l.reportedDate || '');
      return d && d <= asOfDate;
    });
  }, [losses]);

  const compare = useMemo(() => {
    if (!leftDate || !rightDate) return null;
    const leftRows = snapshotAsOf(leftDate);
    const rightRows = snapshotAsOf(rightDate);
    const leftMap = new Map(leftRows.map(l => [lossKey(l), l]));
    const rightMap = new Map(rightRows.map(l => [lossKey(l), l]));
    const added = [];      // in right, not in left
    const removed = [];    // in left, not in right
    const changed = [];    // in both, different paid/os
    for (const [k, r] of rightMap) {
      const prev = leftMap.get(k);
      if (!prev) { added.push(r); continue; }
      const pPaid = cn(prev.paid), rPaid = cn(r.paid);
      const pOs = cn(prev.os), rOs = cn(r.os);
      if (pPaid !== rPaid || pOs !== rOs) {
        changed.push({ prev, curr: r, dPaid: rPaid - pPaid, dOs: rOs - pOs });
      }
    }
    for (const [k, l] of leftMap) if (!rightMap.has(k)) removed.push(l);
    return { leftRows, rightRows, added, removed, changed };
  }, [leftDate, rightDate, snapshotAsOf]);

  const card = { padding: '14px 16px', borderRadius: 10, background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)', marginBottom: 14 };
  const cardTitle = { fontSize: 11, fontWeight: 700, color: 'rgba(255,255,255,0.5)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 10 };
  const th = { textAlign: 'left', padding: '6px 8px', fontSize: 10, fontWeight: 700, color: 'rgba(255,255,255,0.5)', textTransform: 'uppercase', letterSpacing: '0.04em', borderBottom: '1px solid rgba(255,255,255,0.08)' };
  const td = { padding: '6px 8px', fontSize: 12, color: '#fff', borderBottom: '1px solid rgba(255,255,255,0.04)' };
  const tdNum = { ...td, textAlign: 'right', fontVariantNumeric: 'tabular-nums' };

  const lossLabel = lossType === 'cat' ? 'Cat Losses' : 'Large Losses';

  return (
    <div className="modal-backdrop" style={{ position: 'fixed', inset: 0, background: 'rgba(2,6,18,0.88)', backdropFilter: 'blur(8px)',
      zIndex: 4500, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="glass" role="dialog" aria-modal="true" style={{ width: 'calc(100vw - 20px)', maxWidth: 1000, height: 'calc(100vh - 40px)',
        background: 'linear-gradient(160deg,#0c1628,#060c18)',
        border: '1px solid rgba(0,232,184,0.2)', borderRadius: 16,
        boxShadow: '0 32px 80px rgba(0,0,0,0.7)', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>

        <div style={{ padding: '14px 20px', borderBottom: '1px solid rgba(255,255,255,0.08)', display: 'flex', alignItems: 'center', gap: 14, flexShrink: 0 }}>
          <div style={{ flex: 1 }}>
            <div style={{ fontWeight: 800, fontSize: 15, color: '#fff' }}>📊 Loss Analysis — {lossLabel}</div>
            <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.35)', marginTop: 2 }}>
              {losses.length} loss{losses.length !== 1 ? 'es' : ''} across {realBatches.length} report batch{realBatches.length !== 1 ? 'es' : ''}
            </div>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" style={{ background: 'none', border: 'none', color: 'rgba(255,255,255,0.4)', fontSize: 20, cursor: 'pointer' }}>✕</button>
        </div>

        <div style={{ display: 'flex', borderBottom: '1px solid rgba(255,255,255,0.08)', flexShrink: 0 }}>
          {TABS.map(t => (
            <button key={t.key} onClick={() => setTab(t.key)}
              style={{ padding: '10px 20px', fontSize: 12, fontWeight: 700, border: 'none', cursor: 'pointer',
                background: tab === t.key ? 'rgba(0,232,184,0.1)' : 'transparent',
                color: tab === t.key ? '#00e8b8' : 'rgba(255,255,255,0.45)',
                borderBottom: tab === t.key ? '2px solid #00e8b8' : '2px solid transparent',
                letterSpacing: '0.04em', textTransform: 'uppercase' }}>
              {t.label}
            </button>
          ))}
        </div>

        <div style={{ flex: 1, overflow: 'auto', padding: '16px 20px' }}>

          {tab === 'batches' && (
            <>
              {batches.length === 0 ? (
                <div style={{ padding: 40, textAlign: 'center', color: 'rgba(255,255,255,0.4)', fontSize: 13 }}>
                  No losses recorded yet.
                </div>
              ) : batches.map((b, i) => (
                <div key={b.date} style={card}>
                  <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 10 }}>
                    <div style={{ ...cardTitle, marginBottom: 0 }}>
                      Reported {b.date === '—' ? '(date unknown)' : b.date}
                    </div>
                    {i === 0 && b.date !== '—' && (
                      <span style={{ fontSize: 9, fontWeight: 800, padding: '2px 8px', borderRadius: 999,
                        background: 'rgba(0,232,184,0.15)', color: '#00e8b8', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                        Latest
                      </span>
                    )}
                    <div style={{ marginLeft: 'auto', fontSize: 11, color: 'rgba(255,255,255,0.5)' }}>
                      {b.count} loss{b.count !== 1 ? 'es' : ''} · paid {fmt(b.paid)} · o/s {fmt(b.os)} · <span style={{ color: '#fff', fontWeight: 700 }}>incurred {fmt(b.inc)}</span>
                    </div>
                  </div>
                  <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                    <thead>
                      <tr>
                        <th style={th}>Insured</th>
                        <th style={th}>Event</th>
                        <th style={th}>Date of Loss</th>
                        <th style={th}>Class</th>
                        <th style={{ ...th, textAlign: 'right' }}>Paid</th>
                        <th style={{ ...th, textAlign: 'right' }}>O/S</th>
                        <th style={{ ...th, textAlign: 'right' }}>Incurred</th>
                      </tr>
                    </thead>
                    <tbody>
                      {b.rows.map((l, ri) => (
                        <tr key={l.loss_id || ri}>
                          <td style={td}>{l.insured_name || '—'}</td>
                          <td style={td}>{l.loss_name || '—'}</td>
                          <td style={td}>{dateInputValue(l.date_of_loss) || '—'}</td>
                          <td style={td}>{l.class_of_business || '—'}</td>
                          <td style={tdNum}>{fmt(cn(l.paid))}</td>
                          <td style={tdNum}>{fmt(cn(l.os))}</td>
                          <td style={{ ...tdNum, fontWeight: 700 }}>{fmt(cn(l.incurred) || cn(l.paid) + cn(l.os))}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ))}
            </>
          )}

          {tab === 'compare' && (
            <>
              {realBatches.length < 2 ? (
                <div style={{ padding: 40, textAlign: 'center', color: 'rgba(255,255,255,0.4)', fontSize: 13 }}>
                  Need at least two report batches to compare. Currently have {realBatches.length}.
                </div>
              ) : (
                <>
                  <div style={{ ...card, display: 'flex', alignItems: 'center', gap: 14, marginBottom: 14 }}>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                      <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.4)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Prior</span>
                      <select value={leftDate} onChange={e => setLeftDate(e.target.value)}
                        style={{ background: '#0f1a2e', border: '1px solid rgba(255,255,255,0.15)', borderRadius: 6, color: '#fff', padding: '6px 10px', fontSize: 12 }}>
                        {realBatches.map(b => <option key={b.date} value={b.date}>{b.date}</option>)}
                      </select>
                    </div>
                    <div style={{ fontSize: 18, color: 'rgba(255,255,255,0.4)' }}>→</div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                      <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.4)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Current</span>
                      <select value={rightDate} onChange={e => setRightDate(e.target.value)}
                        style={{ background: '#0f1a2e', border: '1px solid rgba(255,255,255,0.15)', borderRadius: 6, color: '#fff', padding: '6px 10px', fontSize: 12 }}>
                        {realBatches.map(b => <option key={b.date} value={b.date}>{b.date}</option>)}
                      </select>
                    </div>
                    {compare && (
                      <div style={{ marginLeft: 'auto', display: 'flex', gap: 14, fontSize: 11 }}>
                        <span style={{ color: '#4ade80' }}>+{compare.added.length} new</span>
                        <span style={{ color: '#fbbf24' }}>~{compare.changed.length} changed</span>
                        <span style={{ color: '#f87171' }}>−{compare.removed.length} removed</span>
                      </div>
                    )}
                  </div>

                  {compare && compare.added.length > 0 && (
                    <div style={card}>
                      <div style={{ ...cardTitle, color: '#4ade80' }}>🆕 New losses ({compare.added.length})</div>
                      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                        <thead><tr>
                          <th style={th}>Insured</th><th style={th}>Event</th><th style={th}>Date of Loss</th>
                          <th style={{ ...th, textAlign: 'right' }}>Paid</th><th style={{ ...th, textAlign: 'right' }}>O/S</th>
                          <th style={{ ...th, textAlign: 'right' }}>Incurred</th>
                        </tr></thead>
                        <tbody>
                          {compare.added.map((l, i) => (
                            <tr key={i}>
                              <td style={td}>{l.insured_name || '—'}</td>
                              <td style={td}>{l.loss_name || '—'}</td>
                              <td style={td}>{dateInputValue(l.date_of_loss) || '—'}</td>
                              <td style={tdNum}>{fmt(cn(l.paid))}</td>
                              <td style={tdNum}>{fmt(cn(l.os))}</td>
                              <td style={{ ...tdNum, fontWeight: 700 }}>{fmt(cn(l.incurred) || cn(l.paid) + cn(l.os))}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}

                  {compare && compare.changed.length > 0 && (
                    <div style={card}>
                      <div style={{ ...cardTitle, color: '#fbbf24' }}>⚠ Discrepancies — figures changed ({compare.changed.length})</div>
                      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                        <thead><tr>
                          <th style={th}>Insured / Event</th>
                          <th style={{ ...th, textAlign: 'right' }}>Paid (prior → curr)</th>
                          <th style={{ ...th, textAlign: 'right' }}>Δ Paid</th>
                          <th style={{ ...th, textAlign: 'right' }}>O/S (prior → curr)</th>
                          <th style={{ ...th, textAlign: 'right' }}>Δ O/S</th>
                        </tr></thead>
                        <tbody>
                          {compare.changed.map((c, i) => (
                            <tr key={i}>
                              <td style={td}>
                                <div>{c.curr.insured_name || '—'}</div>
                                <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.4)' }}>{c.curr.loss_name || ''}</div>
                              </td>
                              <td style={tdNum}>{fmt(cn(c.prev.paid))} → {fmt(cn(c.curr.paid))}</td>
                              <td style={{ ...tdNum, color: c.dPaid > 0 ? '#f87171' : c.dPaid < 0 ? '#4ade80' : 'rgba(255,255,255,0.5)' }}>
                                {c.dPaid > 0 ? '+' : ''}{fmt(c.dPaid)}
                              </td>
                              <td style={tdNum}>{fmt(cn(c.prev.os))} → {fmt(cn(c.curr.os))}</td>
                              <td style={{ ...tdNum, color: c.dOs > 0 ? '#f87171' : c.dOs < 0 ? '#4ade80' : 'rgba(255,255,255,0.5)' }}>
                                {c.dOs > 0 ? '+' : ''}{fmt(c.dOs)}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}

                  {compare && compare.removed.length > 0 && (
                    <div style={card}>
                      <div style={{ ...cardTitle, color: '#f87171' }}>− Removed losses ({compare.removed.length})</div>
                      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                        <thead><tr>
                          <th style={th}>Insured</th><th style={th}>Event</th><th style={th}>Date of Loss</th>
                          <th style={{ ...th, textAlign: 'right' }}>Last incurred</th>
                        </tr></thead>
                        <tbody>
                          {compare.removed.map((l, i) => (
                            <tr key={i}>
                              <td style={td}>{l.insured_name || '—'}</td>
                              <td style={td}>{l.loss_name || '—'}</td>
                              <td style={td}>{dateInputValue(l.date_of_loss) || '—'}</td>
                              <td style={tdNum}>{fmt(cn(l.incurred) || cn(l.paid) + cn(l.os))}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}

                  {compare && compare.added.length === 0 && compare.changed.length === 0 && compare.removed.length === 0 && (
                    <div style={{ padding: 30, textAlign: 'center', color: 'rgba(255,255,255,0.4)', fontSize: 13 }}>
                      No differences between the two snapshots.
                    </div>
                  )}
                </>
              )}
            </>
          )}

        </div>
      </div>
    </div>
  );
}
