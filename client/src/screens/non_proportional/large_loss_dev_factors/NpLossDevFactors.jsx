/**
 * NpLossDevFactors.jsx — Shared component for NP Large Loss and Cat Loss development
 *
 * Loads selected losses from the loss selection snapshot, groups by accident year,
 * lets the underwriter apply LDFs to develop reported losses to ultimate.
 * Saves to contract_np_terms JSONB: large_loss_dev_factors | cat_loss_dev_factors
 */
import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { api } from '../../../api';
import { useContractId } from '../../../hooks/useContractId';
import { useAppState } from '../../../context/AppContext';
import WizardLayout from '../../../components/WizardLayout';
import { toN as cn } from '../../../utils/format';
import '../../../styles/proportional/dev_factors.css';
import { logger } from '../../../utils/logger';

const fmt4  = n => (n == null || !Number.isFinite(Number(n))) ? '' : Number(n).toFixed(4);
const fmtN  = n => (n == null || !Number.isFinite(Number(n))) ? '—' : Number(n).toLocaleString('en-US', { maximumFractionDigits: 0 });

// Derive CDFs from LDFs (tail = 1.0)
function ldfsTocdfs(ldfs) {
  const n = ldfs.length;
  const cdfs = new Array(n).fill(1.0);
  for (let i = n - 1; i >= 0; i--) cdfs[i] = ldfs[i] * (cdfs[i + 1] ?? 1.0);
  return cdfs;
}

// ── Ultimate Summary Table ─────────────────────────────────────────────────
function UltimateSummaryTable({ ayRows, ldfs, tailFactor }) {
  const cdfs = useMemo(() => {
    const tail = Number(tailFactor) || 1.0;
    const raw = ldfs.map(v => Number(v) || 1.0);
    // Build full CDF array: cdfs[0] = CDF from dev 1 to ultimate
    const full = new Array(raw.length + 1).fill(1.0);
    full[raw.length] = tail;
    for (let i = raw.length - 1; i >= 0; i--) full[i] = raw[i] * full[i + 1];
    return full;
  }, [ldfs, tailFactor]);

  const rows = useMemo(() => {
    const sorted = [...ayRows].sort((a, b) => a.year - b.year);
    const n = sorted.length;
    return sorted.map((r, i) => {
      // Oldest year = most developed = highest CDF index (tail end)
      const ageIdx = Math.max(0, Math.min(cdfs.length - 1, n - 1 - i));
      const cdf = cdfs[ageIdx] ?? 1.0;
      const ultimate = r.reported * cdf;
      const ibnr = ultimate - r.reported;
      return { ...r, cdf, ultimate, ibnr };
    });
  }, [ayRows, cdfs]);

  const totReported = rows.reduce((s, r) => s + r.reported, 0);
  const totUltimate = rows.reduce((s, r) => s + r.ultimate, 0);
  const totIbnr     = rows.reduce((s, r) => s + r.ibnr, 0);

  if (!rows.length) return (
    <div className="df-card df-card--notice" style={{ marginTop: 14 }}>
      <div className="df-note">No selected losses found. Complete loss selection first.</div>
    </div>
  );

  return (
    <div className="df-section">
      <div className="df-section-head">
        <div className="df-section-title">Ultimate Loss Summary</div>
        <div className="df-section-sub">Selected losses aggregated by accident year, developed to ultimate using chosen LDFs</div>
      </div>
      <div className="df-card"><div className="df-scrollX">
        <table className="df-table">
          <thead><tr>
            <th className="df-h df-h--sticky">Acc. Year</th>
            <th className="df-h">No. Losses</th>
            <th className="df-h">Reported (Inflated)</th>
            <th className="df-h">Applied CDF</th>
            <th className="df-h">IBNR</th>
            <th className="df-h">Ultimate</th>
          </tr></thead>
          <tbody>
            {rows.map(r => (
              <tr key={r.year}>
                <td className="df-r df-r--sticky">{r.year}</td>
                <td className="df-c"><div className="df-val">{r.count}</div></td>
                <td className="df-c"><div className="df-val">{fmtN(r.reported)}</div></td>
                <td className="df-c"><div className="df-val">{fmt4(r.cdf)}</div></td>
                <td className="df-c"><div className="df-val" style={{ color: r.ibnr > 0 ? '#f87171' : 'rgba(226,232,240,0.7)' }}>{fmtN(r.ibnr)}</div></td>
                <td className="df-c"><div className="df-val" style={{ fontWeight: 700 }}>{fmtN(r.ultimate)}</div></td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr style={{ borderTop: '2px solid rgba(34,197,94,0.25)' }}>
              <td className="df-r df-r--sticky" style={{ color: '#4ade80' }}>Total</td>
              <td className="df-c"><div className="df-val">—</div></td>
              <td className="df-c"><div className="df-val" style={{ color: '#4ade80' }}>{fmtN(totReported)}</div></td>
              <td className="df-c"><div className="df-val">—</div></td>
              <td className="df-c"><div className="df-val" style={{ color: '#f87171' }}>{fmtN(totIbnr)}</div></td>
              <td className="df-c"><div className="df-val" style={{ color: '#4ade80', fontWeight: 700 }}>{fmtN(totUltimate)}</div></td>
            </tr>
          </tfoot>
        </table>
      </div></div>
    </div>
  );
}

// ── Individual Loss Detail Table ───────────────────────────────────────────
function LossDetailTable({ losses }) {
  if (!losses.length) return null;
  return (
    <div className="df-section">
      <div className="df-section-head">
        <div className="df-section-title">Selected Losses</div>
        <div className="df-section-sub">{losses.length} losses included in this analysis</div>
      </div>
      <div className="df-card"><div className="df-scrollX">
        <table className="df-table">
          <thead><tr>
            <th className="df-h df-h--sticky">Acc. Year</th>
            <th className="df-h">Insured / Event</th>
            <th className="df-h">Date of Loss</th>
            <th className="df-h">Paid</th>
            <th className="df-h">OS</th>
            <th className="df-h">Incurred</th>
            <th className="df-h">Infl. Factor</th>
            <th className="df-h">Inflated</th>
          </tr></thead>
          <tbody>
            {[...losses].sort((a, b) => (a.uw_year || 0) - (b.uw_year || 0)).map((l, i) => {
              const inc = cn(l.incurred);
              const inflated = inc * cn(l.inflation_factor || 1);
              return (
                <tr key={i}>
                  <td className="df-r df-r--sticky">{l.uw_year || '—'}</td>
                  <td className="df-c"><div className="df-val" style={{ textAlign: 'left', fontSize: 11 }}>{l.insured_name || l.loss_name || '—'}</div></td>
                  <td className="df-c"><div className="df-val">{(l.date_of_loss || '').slice(0, 10) || '—'}</div></td>
                  <td className="df-c"><div className="df-val">{fmtN(cn(l.paid))}</div></td>
                  <td className="df-c"><div className="df-val">{fmtN(cn(l.os))}</div></td>
                  <td className="df-c"><div className="df-val">{fmtN(inc)}</div></td>
                  <td className="df-c"><div className="df-val">{fmt4(cn(l.inflation_factor || 1))}</div></td>
                  <td className="df-c"><div className="df-val" style={{ fontWeight: 600 }}>{fmtN(inflated)}</div></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div></div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════
//  MAIN COMPONENT
// ══════════════════════════════════════════════════════════════════════════
export default function NpLossDevFactors({ routeKey, title, headerPill, lossType = 'large' }) {
  const contractId = useContractId();
  const { state: appState } = useAppState();
  const quoteMode = !!appState.quoteMode;

  const storageKey = lossType === 'cat' ? 'cat_loss_dev_factors' : 'large_loss_dev_factors';

  // ── State ────────────────────────────────────────────────────────────────
  const [selectedLosses, setSelectedLosses] = useState([]); // from snapshot
  const [loading, setLoading] = useState(true);

  const [manualLdfCount, setManualLdfCount] = useState(5);
  const [manualLdfs, setManualLdfs]         = useState(Array(15).fill(''));
  const [tailFactor, setTailFactor]         = useState('1.0');
  const [view, setView]                     = useState('FACTORS'); // FACTORS | DETAIL
  const [dirty, setDirty]                   = useState(false);
  const [saveMsg, setSaveMsg]               = useState(null);

  const loaded = useRef(false);

  // ── Load selected losses + saved LDFs ────────────────────────────────────
  useEffect(() => {
    if (!contractId) return;
    loaded.current = false;
    setLoading(true);

    Promise.all([
      api.getLossSelectionLatest(contractId, lossType, quoteMode ? { quote: true } : undefined).catch(() => null),
      api.getNonPropTreaty(contractId, quoteMode ? { quote: true } : undefined).catch(() => null),
    ]).then(([snapData, npData]) => {
      // Restore selected losses from snapshot
      const snapItems = snapData?.items || snapData?.snapshot?.selected_losses || [];
      setSelectedLosses(Array.isArray(snapItems) ? snapItems : []);

      // Restore saved LDF settings
      const saved = npData?.terms?.[storageKey];
      if (saved) {
        if (Array.isArray(saved.manualLdfs)) setManualLdfs(saved.manualLdfs.map(v => v != null ? String(v) : ''));
        if (saved.manualLdfCount) setManualLdfCount(Number(saved.manualLdfCount) || 5);
        if (saved.tailFactor != null) setTailFactor(String(saved.tailFactor));
      }

      loaded.current = true;
      setLoading(false);
    }).catch(() => { loaded.current = true; setLoading(false); });
  }, [contractId, lossType, quoteMode, storageKey]);

  // ── Group selected losses by accident year ────────────────────────────────
  const ayRows = useMemo(() => {
    const map = {};
    selectedLosses.forEach(l => {
      const year = l.uw_year || l.uwYear || '?';
      const inc = cn(l.incurred);
      const inflFactor = cn(l.inflation_factor || l.inflationFactor || 1);
      const inflated = cn(l.inflated_incurred || l.inflatedIncurred) || inc * inflFactor;
      if (!map[year]) map[year] = { year, reported: 0, count: 0 };
      map[year].reported += inflated || inc;
      map[year].count += 1;
    });
    return Object.values(map).sort((a, b) => a.year - b.year);
  }, [selectedLosses]);

  // ── LDFs from manual inputs ───────────────────────────────────────────────
  const computedLdfs = useMemo(() => {
    return manualLdfs.slice(0, manualLdfCount).map(v => Number(v) || 1.0);
  }, [manualLdfs, manualLdfCount]);

  const computedCdfs = useMemo(() => ldfsTocdfs(computedLdfs), [computedLdfs]);

  // ── Save ──────────────────────────────────────────────────────────────────
  const save = useCallback(async (quiet = false) => {
    if (!contractId || !loaded.current) return true;
    try {
      // Compute ultimates
      const cdfs = ldfsTocdfs(computedLdfs);
      const tail = Number(tailFactor) || 1.0;
      const sorted = [...ayRows].sort((a, b) => a.year - b.year);
      const ultimates = sorted.map((r, i) => {
        const ageIdx = Math.max(0, Math.min(cdfs.length - 1, sorted.length - 1 - i));
        const cdf = cdfs[ageIdx] ?? tail;
        return { year: r.year, reported: r.reported, cdf, ultimate: r.reported * cdf, ibnr: r.reported * cdf - r.reported, count: r.count };
      });

      // 1. Write to relational tables (primary store for NpFinalPricing queries)
      const ldfRows = computedLdfs.map((ldf, i) => ({
        dev_month: (i + 1) * 12,
        chosen_ldf: ldf,
        chosen_cdf: cdfs[i] ?? tail,
      }));
      const saveLdfs = lossType === 'cat' ? api.saveNpCatLossLdfs : api.saveNpLargeLossLdfs;
      await saveLdfs(contractId, {
        ldfs: ldfRows,
        ultimates,
        tail_factor: tail,
      }, quoteMode ? { quote: true } : undefined);

      // 2. Also write to JSONB terms for quick rehydration within wizard
      await api.saveNonPropTreaty(contractId, {
        terms: {
          [storageKey]: {
            manualLdfs: manualLdfs.map(v => Number(v) || 0),
            manualLdfCount,
            tailFactor: tail,
            ultimates,
            totalUltimate: ultimates.reduce((s, r) => s + r.ultimate, 0),
            totalReported: ultimates.reduce((s, r) => s + r.reported, 0),
            updatedAt: new Date().toISOString(),
          }
        }
      }, quoteMode ? { quote: true } : undefined);

      setDirty(false);
      if (!quiet) {
        setSaveMsg({ type: 'ok', text: 'Saved' });
        setTimeout(() => setSaveMsg(null), 2000);
      }
      return true;
    } catch (e) {
      logger.error(`NpLossDevFactors [${lossType}] save:`, e);
      setSaveMsg({ type: 'err', text: 'Save failed' });
      setTimeout(() => setSaveMsg(null), 3000);
      return false;
    }
  }, [contractId, computedLdfs, tailFactor, ayRows, storageKey, manualLdfs, manualLdfCount, quoteMode, lossType]);

  const hasLdfs = computedLdfs.some(v => v !== 1.0);

  return (
    <WizardLayout
      routeKey={routeKey}
      title={title}
      headerPill={headerPill}
      onBeforeNext={() => save(true)}
      onBeforeBack={() => save(true)}
    >
      {({ showToast }) => (
        <div className="DEV_FACTORS_PAGE">

          {/* ── Top bar ── */}
          <div className="df-toprow">
            <div className="df-controls">
              <div className="df-mini">
                <div className="df-mini-label">Selected Losses</div>
                <div className="df-mini-value">{selectedLosses.length}</div>
              </div>
              <div className="df-mini">
                <div className="df-mini-label">Accident Years</div>
                <div className="df-mini-value">{ayRows.length}</div>
              </div>
              <div className="df-mini">
                <div className="df-mini-label">Total Reported</div>
                <div className="df-mini-value" style={{ fontSize: 11 }}>{fmtN(ayRows.reduce((s, r) => s + r.reported, 0))}</div>
              </div>
              <div className="df-mini">
                <div className="df-mini-label">Tail Factor</div>
                <input
                  type="number" step="0.01" min="1"
                  value={tailFactor}
                  onChange={e => { setTailFactor(e.target.value); setDirty(true); }}
                  style={{ width: 72, textAlign: 'center', background: 'rgba(8,16,40,0.4)', border: '1px solid rgba(148,163,184,0.2)', borderRadius: 6, color: 'rgba(226,232,240,0.9)', fontSize: 12, padding: '2px 6px' }}
                />
              </div>
            </div>

            <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
              {saveMsg && (
                <span style={{ fontSize: 11, padding: '4px 10px', borderRadius: 6,
                  background: saveMsg.type === 'ok' ? 'rgba(74,222,128,0.12)' : 'rgba(248,113,113,0.12)',
                  color: saveMsg.type === 'ok' ? '#4ade80' : '#f87171',
                  border: `1px solid ${saveMsg.type === 'ok' ? 'rgba(74,222,128,0.3)' : 'rgba(248,113,113,0.3)'}` }}>
                  {saveMsg.text}
                </span>
              )}
              {dirty && <span className="muted">Unsaved changes</span>}
              <button className="orange-gloss-btn" onClick={async () => { const ok = await save(); showToast?.(ok ? 'Saved' : 'Save failed'); }}>
                💾 Save
              </button>
            </div>
          </div>

          {/* ── View toggle ── */}
          <div style={{ margin: '12px 0 10px' }}>
            <div className="toggle-group" style={{ display: 'inline-flex' }}>
              {[['FACTORS', '📊 Dev Factors'], ['DETAIL', '📋 Loss Detail']].map(([key, label]) => (
                <button type="button" key={key} className={`toggle-option${view === key ? ' active' : ''}`}
                  onClick={() => setView(key)} style={{ fontSize: 12, padding: '8px 16px' }}>
                  {label}
                </button>
              ))}
            </div>
          </div>

          {loading ? (
            <div className="muted" style={{ padding: 16 }}>Loading selected losses…</div>
          ) : (<>

            {/* ══ DEV FACTORS VIEW ══ */}
            {view === 'FACTORS' && (<>

              {/* LDF Input grid */}
              <div className="df-section">
                <div className="df-section-head">
                  <div className="df-section-title">Development Factors</div>
                  <div className="df-section-sub">
                    Enter LDFs to develop {lossType === 'cat' ? 'cat' : 'large'} losses to ultimate.
                    <span style={{ marginLeft: 14, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                      <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.4)' }}>Dev periods:</span>
                      <input
                        type="number" min={1} max={15} value={manualLdfCount}
                        onChange={e => { setManualLdfCount(Math.max(1, Math.min(15, Number(e.target.value) || 1))); setDirty(true); }}
                        style={{ width: 52, textAlign: 'center', background: 'rgba(8,16,40,0.4)', border: '1px solid rgba(148,163,184,0.2)', borderRadius: 6, color: 'rgba(226,232,240,0.9)', fontSize: 12, padding: '2px 4px' }}
                      />
                    </span>
                  </div>
                </div>
                <div className="df-card"><div className="df-scrollX">
                  <table className="df-table">
                    <thead><tr>
                      <th className="df-h df-h--sticky">Factor</th>
                      {Array.from({ length: manualLdfCount }, (_, i) => (
                        <th key={i} className="df-h">{i + 1}–{i + 2}</th>
                      ))}
                      <th className="df-h">Tail</th>
                    </tr></thead>
                    <tbody>
                      <tr>
                        <td className="df-r df-r--sticky">LDF</td>
                        {Array.from({ length: manualLdfCount }, (_, i) => (
                          <td key={i} className="df-c">
                            <input className="df-input"
                              value={manualLdfs[i] ?? ''}
                              placeholder="1.000"
                              onChange={e => { const a = [...manualLdfs]; a[i] = e.target.value; setManualLdfs(a); setDirty(true); }}
                            />
                          </td>
                        ))}
                        <td className="df-c">
                          <input className="df-input" value={tailFactor} onChange={e => { setTailFactor(e.target.value); setDirty(true); }} />
                        </td>
                      </tr>
                      <tr>
                        <td className="df-r df-r--sticky" style={{ color: 'rgba(147,197,253,0.9)' }}>CDF</td>
                        {computedCdfs.map((v, i) => (
                          <td key={i} className="df-c">
                            <div className="df-val" style={{ color: 'rgba(147,197,253,0.9)' }}>{fmt4(v)}</div>
                          </td>
                        ))}
                        <td className="df-c"><div className="df-val" style={{ color: 'rgba(147,197,253,0.9)' }}>1.0000</div></td>
                      </tr>
                    </tbody>
                  </table>
                </div></div>
              </div>

              {/* Hint when LDFs are all 1.0 — ultimates will equal reported,
                  IBNR will be zero. Easy to miss otherwise. */}
              {ayRows.length > 0 && !hasLdfs && (
                <div className="df-card df-card--notice" style={{ marginTop: 14 }}>
                  <div className="df-note">
                    All LDFs are 1.0 — ultimates equal reported losses and IBNR is zero.
                    Enter development factors above to project to ultimate.
                  </div>
                </div>
              )}

              {/* Ultimate summary */}
              {ayRows.length > 0 && (
                <UltimateSummaryTable ayRows={ayRows} ldfs={computedLdfs} tailFactor={tailFactor} />
              )}

              {ayRows.length === 0 && (
                <div className="df-card df-card--notice" style={{ marginTop: 14 }}>
                  <div className="df-note">
                    No selected losses found. Go back to the {lossType === 'cat' ? 'Cat' : 'Large'} Loss Selection screen and select losses to include.
                  </div>
                </div>
              )}
            </>)}

            {/* ══ LOSS DETAIL VIEW ══ */}
            {view === 'DETAIL' && (
              <LossDetailTable losses={selectedLosses} />
            )}

          </>)}
        </div>
      )}
    </WizardLayout>
  );
}
