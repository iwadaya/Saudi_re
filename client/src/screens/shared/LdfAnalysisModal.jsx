// LdfAnalysisModal.jsx
// Two-tab modal (Premium / Claims) for the LDF Analysis flow.
//
// On open: fetches the current saved blend (or a fresh EPI-defaulted
// one) for both triangle types in parallel. The underwriter can adjust
// per-class weights; each blur fires a debounced server-side preview
// that recomputes the weighted curve. Apply & Save persists whichever
// tabs the underwriter actually touched.
//
// Scope = NONE means the database has no contributing contracts for
// that class — the curve can't be computed, so we surface a hard
// warning and disable Apply until the offending class is removed
// from the EPI split.

import { useEffect, useState, useRef, useCallback, useMemo } from 'react';
import { api } from '../../api';
import LdfCurveTable from './LdfCurveTable';

const TABS = [
  { key: 'PREMIUM',     label: 'Premium LDFs' },
  { key: 'CLAIMS_PAID', label: 'Claims LDFs' },
];

// Render-friendly scope decorations. Tooltip is composed at render
// time so it can include the n-contracts count.
const SCOPE_STYLE = {
  COUNTRY: { bg: 'rgba(var(--accent-rgb), 0.14)',       fg: 'var(--accent)',       label: 'COUNTRY' },
  REGION:  { bg: 'rgba(var(--accent-amber-rgb), 0.14)', fg: 'var(--accent-amber)', label: 'REGION'  },
  GLOBAL:  { bg: 'rgba(var(--accent-rose-rgb), 0.14)',  fg: 'var(--accent-rose)',  label: 'GLOBAL'  },
  NONE:    { bg: 'rgba(255,255,255,0.06)',              fg: 'var(--muted)',        label: 'NONE'    },
};

const MIN_CONTRACTS = 5;
const PREVIEW_DEBOUNCE_MS = 250;

// Build a { classId: epiPercent } map from a blend.classes array.
function weightsToPct(classes) {
  return Object.fromEntries((classes || []).map(c => [
    c.classOfBusinessId, Number(c.weight) * 100,
  ]));
}

// Drafts (percent) → server payload (fractions, normalised by service).
function pctDraftsToFractions(drafts) {
  return Object.fromEntries(Object.entries(drafts).map(([k, v]) => [k, Number(v) / 100]));
}

function sumPct(drafts) {
  return Object.values(drafts).reduce((s, v) => s + Number(v || 0), 0);
}

export default function LdfAnalysisModal({
  contractId, contractName, isOpen, onClose, onApply,
}) {
  const [activeTab, setActiveTab]   = useState('PREMIUM');
  const [loading, setLoading]       = useState(true);
  const [saving, setSaving]         = useState(false);
  const [error, setError]           = useState(null);

  // Per-tab blend state: { classes, blended, overridden, saved, epiWeightsPct }
  const [blends, setBlends] = useState({ PREMIUM: null, CLAIMS_PAID: null });
  // Per-tab editable weight drafts in PERCENT (0..100).
  const [drafts, setDrafts] = useState({ PREMIUM: {}, CLAIMS_PAID: {} });
  // Dirty tracking — only dirty tabs get saved.
  const [dirty, setDirty]   = useState({ PREMIUM: false, CLAIMS_PAID: false });
  // Class label cache (uuid → human name).
  const [classLabelById, setClassLabelById] = useState({});
  // Per-tab preview-in-flight indicator.
  const [previewing, setPreviewing] = useState({ PREMIUM: false, CLAIMS_PAID: false });

  const previewTimer = useRef({ PREMIUM: null, CLAIMS_PAID: null });

  // Escape to close.
  useEffect(() => {
    if (!isOpen) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isOpen, onClose]);

  // Initial load — fetch both tabs' saved blends plus a fresh EPI
  // baseline (for the Reset button) plus the class-of-business labels.
  useEffect(() => {
    if (!isOpen || !contractId) return;
    let cancelled = false;
    setLoading(true); setError(null);

    (async () => {
      try {
        const [premSaved, claimsSaved, premFresh, claimsFresh, cobs] = await Promise.all([
          api.getLdfBlend(contractId, 'PREMIUM'),
          api.getLdfBlend(contractId, 'CLAIMS_PAID'),
          api.previewLdfBlend(contractId, 'PREMIUM', null),
          api.previewLdfBlend(contractId, 'CLAIMS_PAID', null),
          api.listClassOfBusiness().catch(() => []),
        ]);
        if (cancelled) return;

        const labels = Object.fromEntries(
          (Array.isArray(cobs) ? cobs : []).map(c => [
            c.id || c.class_of_business_id || c.classOfBusinessId,
            c.name || c.class_of_business || c.class_name || '',
          ])
        );
        setClassLabelById(labels);

        const buildTab = (saved, fresh) => ({
          ...saved,
          // EPI baseline weights come from the fresh (no-override) preview.
          epiWeightsPct: weightsToPct(fresh.classes),
        });

        setBlends({
          PREMIUM:     buildTab(premSaved, premFresh),
          CLAIMS_PAID: buildTab(claimsSaved, claimsFresh),
        });
        setDrafts({
          PREMIUM:     weightsToPct(premSaved.classes),
          CLAIMS_PAID: weightsToPct(claimsSaved.classes),
        });
        setDirty({ PREMIUM: false, CLAIMS_PAID: false });
      } catch (e) {
        if (!cancelled) setError(e?.message || 'Failed to load LDF blend');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => { cancelled = true; };
  }, [isOpen, contractId]);

  // Cancel any pending preview timers when the modal closes.
  useEffect(() => {
    if (isOpen) return undefined;
    // The ref holds one stable object for the component's lifetime, so capturing
    // it here is equivalent to reading .current at cleanup time.
    const t = previewTimer.current;
    return () => {
      if (t.PREMIUM) { clearTimeout(t.PREMIUM); t.PREMIUM = null; }
      if (t.CLAIMS_PAID) { clearTimeout(t.CLAIMS_PAID); t.CLAIMS_PAID = null; }
    };
  }, [isOpen]);

  const requestPreview = useCallback((tab, nextDrafts) => {
    if (previewTimer.current[tab]) clearTimeout(previewTimer.current[tab]);
    previewTimer.current[tab] = setTimeout(async () => {
      setPreviewing((p) => ({ ...p, [tab]: true }));
      try {
        const result = await api.previewLdfBlend(
          contractId, tab, pctDraftsToFractions(nextDrafts),
        );
        setBlends((b) => ({
          ...b,
          [tab]: {
            ...(b[tab] || {}),
            classes: result.classes,
            blended: result.blended,
          },
        }));
      } catch (e) {
        setError(e?.message || 'Preview failed');
      } finally {
        setPreviewing((p) => ({ ...p, [tab]: false }));
      }
    }, PREVIEW_DEBOUNCE_MS);
  }, [contractId]);

  const onWeightChange = (tab, classId, value) => {
    setDrafts((d) => ({ ...d, [tab]: { ...d[tab], [classId]: value } }));
  };

  const onWeightBlur = (tab) => {
    setDirty((dd) => ({ ...dd, [tab]: true }));
    requestPreview(tab, drafts[tab]);
  };

  const resetToEpi = (tab) => {
    const epi = blends[tab]?.epiWeightsPct || {};
    setDrafts((d) => ({ ...d, [tab]: { ...epi } }));
    setDirty((dd) => ({ ...dd, [tab]: true }));
    requestPreview(tab, epi);
  };

  const normaliseToHundred = (tab) => {
    const cur = drafts[tab] || {};
    const total = sumPct(cur);
    if (!Number.isFinite(total) || total <= 0) return;
    const scaled = Object.fromEntries(
      Object.entries(cur).map(([k, v]) => [k, (Number(v) / total) * 100]),
    );
    setDrafts((d) => ({ ...d, [tab]: scaled }));
    setDirty((dd) => ({ ...dd, [tab]: true }));
    requestPreview(tab, scaled);
  };

  // Aggregate scope info across both tabs — any NONE blocks Apply.
  const anyNoneClass = useMemo(() => {
    const tabs = ['PREMIUM', 'CLAIMS_PAID'];
    for (const t of tabs) {
      const cs = blends[t]?.classes || [];
      if (cs.some(c => c.scope === 'NONE')) return true;
    }
    return false;
  }, [blends]);

  const apply = async () => {
    if (anyNoneClass) return; // safety — button is disabled anyway
    setSaving(true); setError(null);
    try {
      for (const tab of ['PREMIUM', 'CLAIMS_PAID']) {
        if (!dirty[tab]) continue;
        const b = blends[tab];
        if (!b || !(b.classes || []).length || !(b.blended || []).length) continue;
        await api.saveLdfBlend(contractId, tab, {
          overridden: true,
          classes: b.classes.map(c => ({
            classOfBusinessId: c.classOfBusinessId,
            weight: Number(c.weight),
            scope: c.scope,
            nContracts: Number(c.nContracts || 0),
          })),
          blended: b.blended.map(p => ({
            devMonth: Number(p.devMonth),
            ldf: Number(p.ldf),
            cdf: Number(p.cdf),
          })),
        });
      }
      const premiumCurve = blends.PREMIUM?.blended || [];
      const claimsCurve  = blends.CLAIMS_PAID?.blended || [];
      if (typeof onApply === 'function') onApply(premiumCurve, claimsCurve);
      onClose();
    } catch (e) {
      setError(e?.message || 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  if (!isOpen) return null;

  const tabBlend  = blends[activeTab];
  const tabDrafts = drafts[activeTab] || {};
  const draftTotal = sumPct(tabDrafts);
  const noneInTab  = (tabBlend?.classes || []).some(c => c.scope === 'NONE');
  const region = null; // currently unused in display; reserved for header context

  return (
    <div
      className="modal-backdrop"
      style={{
        position: 'fixed', inset: 0, zIndex: 9000,
        background: 'rgba(0,0,0,0.72)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: 20,
      }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        className="glass"
        role="dialog"
        aria-modal="true"
        aria-labelledby="ldf-analysis-title"
        style={{
          width: 'min(1100px, 98vw)',
          maxHeight: '92vh',
          overflowY: 'auto',
          background: 'var(--surface-elevated)',
          border: '1px solid var(--hairline-strong)',
          borderRadius: 16,
          padding: 22,
          color: 'var(--text)',
        }}
      >
        {/* ── Header ─────────────────────────────────────────────────── */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 14 }}>
          <div>
            <div id="ldf-analysis-title" style={{
              fontSize: 14, fontWeight: 900, letterSpacing: 0, textTransform: 'uppercase', color: 'var(--text)',
            }}>
              LDF Analysis{contractName ? ` — ${contractName}` : ''}
            </div>
            <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 4 }}>
              Per-class benchmark curves blended by EPI share (or your override).
              {region && <span> Country/region context: {region}.</span>}
            </div>
            <div style={{
              marginTop: 8,
              fontSize: 11,
              color: 'var(--muted)',
              background: 'rgba(var(--accent-rgb), 0.08)',
              border: '1px solid rgba(var(--accent-rgb), 0.25)',
              padding: '6px 10px',
              borderRadius: 6,
              display: 'inline-block',
              lineHeight: 1.5,
            }}>
              Benchmarks draw from <strong>matching-category</strong> treaties only
              (proportional ↔ proportional, non-proportional ↔ non-proportional).
              A country or region benchmark requires <strong>≥ {MIN_CONTRACTS} terminal
              treaties</strong> (SIGNED / DECLINED / NTU); below that, the scope
              falls back automatically — country → region → global.
            </div>
          </div>
          <button
            type="button" aria-label="Close" onClick={onClose}
            style={{ background: 'none', border: 'none', color: 'var(--text-subtle)', fontSize: 20, cursor: 'pointer' }}
          >✕</button>
        </div>

        {/* ── Tabs ────────────────────────────────────────────────────── */}
        <div style={{
          display: 'inline-flex', gap: 4, padding: 3,
          background: 'var(--surface-2)',
          border: '1px solid var(--hairline)',
          borderRadius: 10, marginBottom: 14,
        }}>
          {TABS.map((t) => {
            const active = activeTab === t.key;
            return (
              <button
                key={t.key} type="button" onClick={() => setActiveTab(t.key)}
                style={{
                  padding: '7px 14px', borderRadius: 7, fontSize: 12, fontWeight: 700,
                  letterSpacing: 0, textTransform: 'uppercase',
                  border: 'none', cursor: 'pointer',
                  background: active ? 'var(--accent)' : 'transparent',
                  color: active ? 'var(--accent-contrast)' : 'var(--muted)',
                }}
              >
                {t.label}
                {dirty[t.key] && <span style={{ marginLeft: 6, opacity: 0.7 }}>•</span>}
              </button>
            );
          })}
        </div>

        {loading && <div style={{ color: 'var(--muted)', padding: 20, textAlign: 'center' }}>Loading…</div>}

        {error && !loading && (
          <div style={{
            background: 'rgba(var(--accent-rose-rgb), 0.12)',
            border: '1px solid var(--accent-rose)',
            color: 'var(--accent-rose)',
            padding: 10, borderRadius: 8, marginBottom: 12, fontSize: 12,
          }}>{error}</div>
        )}

        {!loading && tabBlend && (
          <>
            {/* Hard warning if any class has scope=NONE on this tab. */}
            {noneInTab && (
              <div style={{
                background: 'rgba(var(--accent-rose-rgb), 0.10)',
                border: '1px solid var(--accent-rose)',
                color: 'var(--accent-rose)',
                padding: 10, borderRadius: 8, marginBottom: 12, fontSize: 12,
              }}>
                No benchmark LDFs available for{' '}
                {(tabBlend.classes || []).filter(c => c.scope === 'NONE').map(c =>
                  classLabelById[c.classOfBusinessId] || c.classOfBusinessId.slice(0, 8)
                ).join(', ')}.{' '}
                Apply is disabled until the class is removed from the EPI split or a
                manual-entry fallback is added.
              </div>
            )}

            {/* ── Per-class weight table ───────────────────────────── */}
            <div style={{
              border: '1px solid var(--hairline)', borderRadius: 10,
              overflow: 'hidden', marginBottom: 14,
            }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                <thead style={{ background: 'var(--surface-2)' }}>
                  <tr>
                    <th style={th('left')}>Class</th>
                    <th style={th('right')}>EPI %</th>
                    <th style={th('right')}>Weight %</th>
                    <th style={th('center')}>Scope</th>
                    <th style={th('right')}>n</th>
                  </tr>
                </thead>
                <tbody>
                  {(tabBlend.classes || []).map((c) => {
                    const epi = tabBlend.epiWeightsPct?.[c.classOfBusinessId];
                    const w   = tabDrafts[c.classOfBusinessId] ?? 0;
                    const scope = SCOPE_STYLE[c.scope] || SCOPE_STYLE.NONE;
                    const lowN = Number(c.nContracts || 0) < MIN_CONTRACTS && c.scope !== 'NONE';
                    return (
                      <tr key={c.classOfBusinessId} style={{ borderTop: '1px solid var(--hairline)' }}>
                        <td style={td('left')}>
                          {classLabelById[c.classOfBusinessId] || c.classOfBusinessId.slice(0, 8)}
                        </td>
                        <td style={td('right', 'mono')}>
                          {epi != null ? `${epi.toFixed(1)}%` : '—'}
                        </td>
                        <td style={td('right')}>
                          <input
                            type="number" min="0" step="0.1"
                            value={Number.isFinite(Number(w)) ? Number(w) : ''}
                            onChange={(e) => onWeightChange(activeTab, c.classOfBusinessId, e.target.value)}
                            onBlur={() => onWeightBlur(activeTab)}
                            style={{
                              width: 80, textAlign: 'right',
                              background: 'rgba(0,0,0,0.25)',
                              border: '1px solid var(--hairline)',
                              color: 'var(--text)',
                              padding: '4px 8px', borderRadius: 6,
                              fontFamily: 'var(--font-mono)',
                              fontSize: 12,
                            }}
                          />
                        </td>
                        <td style={td('center')}>
                          <span
                            title={
                              c.scope === 'NONE'
                                ? 'No contributing contracts — manual entry required'
                                : `${scope.label.toLowerCase()} (${c.nContracts} contracts)`
                            }
                            style={{
                              display: 'inline-block', padding: '3px 8px', borderRadius: 6,
                              fontSize: 10, fontWeight: 800, letterSpacing: 0,
                              background: scope.bg, color: scope.fg,
                            }}
                          >{scope.label}</span>
                        </td>
                        <td style={{ ...td('right', 'mono'), color: lowN ? 'var(--accent-amber)' : undefined }}>
                          {c.nContracts}{lowN && ' ⚠'}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
                <tfoot>
                  <tr style={{
                    borderTop: '2px solid rgba(var(--accent-rgb), 0.40)',
                    background: 'rgba(var(--accent-rgb), 0.06)',
                  }}>
                    <td style={{ ...td('left'), fontWeight: 800 }}>Sum</td>
                    <td />
                    <td style={{
                      ...td('right', 'mono'), fontWeight: 800,
                      color: Math.abs(draftTotal - 100) < 0.1 ? 'var(--accent)' : 'var(--accent-amber)',
                    }}>
                      {draftTotal.toFixed(1)}%
                    </td>
                    <td colSpan={2} style={{ ...td('right'), paddingRight: 10 }}>
                      <button type="button" onClick={() => resetToEpi(activeTab)} style={miniBtn}>
                        Reset to EPI
                      </button>
                      <button type="button" onClick={() => normaliseToHundred(activeTab)} style={{ ...miniBtn, marginLeft: 8 }}>
                        Normalise to 100%
                      </button>
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>

            {/* ── Curve table (per-class + weighted + CDF) ─────────── */}
            <div style={{
              border: '1px solid var(--hairline)', borderRadius: 10,
              overflow: 'hidden', marginBottom: 14, position: 'relative',
            }}>
              {previewing[activeTab] && (
                <div style={{
                  position: 'absolute', top: 6, right: 10,
                  fontSize: 10, color: 'var(--muted)', letterSpacing: 0,
                }}>updating…</div>
              )}
              <LdfCurveTable
                classes={tabBlend.classes}
                blended={tabBlend.blended}
                classLabelById={classLabelById}
              />
            </div>

            {/* ── Footer ───────────────────────────────────────────── */}
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
              <button type="button" onClick={onClose} disabled={saving} style={secondaryBtn}>
                Discard
              </button>
              <button
                type="button"
                onClick={apply}
                disabled={saving || anyNoneClass || (!dirty.PREMIUM && !dirty.CLAIMS_PAID)}
                style={{
                  ...primaryBtn,
                  opacity: (saving || anyNoneClass || (!dirty.PREMIUM && !dirty.CLAIMS_PAID)) ? 0.5 : 1,
                  cursor: (saving || anyNoneClass) ? 'not-allowed' : 'pointer',
                }}
                title={
                  anyNoneClass
                    ? 'Cannot apply while any class has no benchmark data'
                    : (!dirty.PREMIUM && !dirty.CLAIMS_PAID ? 'No changes to save' : '')
                }
              >
                {saving ? 'Saving…' : 'Apply & Save'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ── style helpers — kept local since these are modal-private ────────────
const th = (align) => ({
  padding: '10px 12px', textAlign: align,
  fontSize: 9, fontWeight: 800, letterSpacing: 0, textTransform: 'uppercase',
  color: 'var(--muted)',
  borderBottom: '1px solid var(--hairline)',
});
const td = (align, mono) => ({
  padding: '8px 12px', textAlign: align,
  fontSize: 12, color: 'var(--text)',
  fontFamily: mono === 'mono' ? 'var(--font-mono)' : undefined,
});
const miniBtn = {
  background: 'transparent',
  border: '1px solid var(--hairline)',
  color: 'var(--muted)',
  padding: '4px 10px', borderRadius: 6,
  fontSize: 11, cursor: 'pointer',
};
const primaryBtn = {
  background: 'var(--accent)', color: 'var(--accent-contrast)',
  border: 'none', padding: '8px 18px', borderRadius: 8,
  fontWeight: 800, fontSize: 12, letterSpacing: 0, textTransform: 'uppercase',
  cursor: 'pointer',
};
const secondaryBtn = {
  background: 'transparent', color: 'var(--muted)',
  border: '1px solid var(--hairline)', padding: '8px 18px', borderRadius: 8,
  fontWeight: 700, fontSize: 12, letterSpacing: 0, textTransform: 'uppercase',
  cursor: 'pointer',
};
