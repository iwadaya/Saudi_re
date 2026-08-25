// components/retro/RetroImpactModal.jsx — "Retro Impact" for the offer modals.
//
// Opened from the Offer Treaty modal (proportional and non-proportional).
// Shows what the outwards retro programme does to the line being written —
// spend, expected recoveries, PML relief — and an AI line suggestion that
// optimises the risk-adjusted net result for retro cost and recoveries
// (shared/retroImpact.js — same maths as the server-side validators use).
//
// The programme itself (QS cession + retro XL) is editable in-place so the
// underwriter can test structures live; nothing here mutates the treaty
// until they hit "Apply" on the suggested line, which hands the % back to
// the host modal exactly like the existing AI-apply buttons do.

import { useEffect, useId, useMemo, useRef, useState } from 'react';
// (Mounted only while open — the host renders {showRetro && <RetroImpactModal/>}
// so the programme re-seeds from the live treaty numbers on every open.)
import { api } from '../../api';
import PctInput from '../PctInput';
import { logger } from '../../utils/logger';
import {
  defaultRetroProgramme,
  evaluateRetroAtLine,
  normaliseProgramme,
  optimiseRetroLine,
  programmeFromStored,
} from '../../../../shared/retroImpact.js';

const numOr = (v, fallback = 0) => {
  const n = parseFloat(String(v ?? '').replace(/[^0-9.eE+-]/g, ''));
  return Number.isFinite(n) ? n : fallback;
};

/** Sensitivity strip: risk-adjusted net result across the line grid. */
function RetroCurve({ curve, bestPct, currentPct }) {
  if (!curve || curve.length < 2) return null;
  const W = 560, H = 120, PAD = 8;
  const xs = curve.map((c) => c.linePct);
  const ys = curve.map((c) => c.riskAdjustedResult);
  const xMin = xs[0], xMax = xs[xs.length - 1];
  const yMin = Math.min(...ys, 0), yMax = Math.max(...ys, 0);
  const xTo = (x) => PAD + ((x - xMin) / (xMax - xMin || 1)) * (W - 2 * PAD);
  const yTo = (y) => H - PAD - ((y - yMin) / (yMax - yMin || 1)) * (H - 2 * PAD);
  const path = curve.map((c, i) => `${i === 0 ? 'M' : 'L'}${xTo(c.linePct).toFixed(1)},${yTo(c.riskAdjustedResult).toFixed(1)}`).join(' ');
  const zeroY = yTo(0);
  return (
    <svg className="rim-curve" viewBox={`0 0 ${W} ${H}`} role="img"
      aria-label="Risk-adjusted net result by line size">
      {zeroY >= PAD && zeroY <= H - PAD && (
        <line x1={PAD} x2={W - PAD} y1={zeroY} y2={zeroY} className="rim-curve-zero" />
      )}
      <path d={path} className="rim-curve-line" fill="none" />
      {Number.isFinite(currentPct) && currentPct >= xMin && currentPct <= xMax && (
        <line x1={xTo(currentPct)} x2={xTo(currentPct)} y1={PAD} y2={H - PAD} className="rim-curve-current" />
      )}
      {Number.isFinite(bestPct) && bestPct >= xMin && bestPct <= xMax && (
        <circle cx={xTo(bestPct)} cy={yTo(curve.reduce((b, c) => (Math.abs(c.linePct - bestPct) < Math.abs(b.linePct - bestPct) ? c : b)).riskAdjustedResult)} r={4} className="rim-curve-best" />
      )}
    </svg>
  );
}

function Field({ label, children }) {
  return (
    <div className="rim-field">
      <span className="rim-field-label">{label}</span>
      {children}
    </div>
  );
}

/**
 * @param {{
 *   onClose: () => void,
 *   subject: import('../../../../shared/retroImpact.js').RetroSubject,
 *   currentLinePct?: number|string,
 *   money: (n: number) => string,
 *   onApplyLine?: ((pct: number) => void) | null,
 *   contextLabel?: string,
 *   contractId?: string | null,
 *   isQuote?: boolean,
 * }} props
 */
export default function RetroImpactModal({
  onClose, subject, currentLinePct, money, onApplyLine, contextLabel,
  contractId = null, isQuote = false,
}) {
  const uid = useId();
  // Seed once per mount from the live treaty; edits take over from there.
  const [prog, setProg] = useState(() => defaultRetroProgramme({
    grossPremium100: subject?.grossPremium100,
    expectedLossRatio: subject?.expectedLossRatio,
    seedLinePct: numOr(currentLinePct, 10) || 10,
  }));
  const [lossCv, setLossCv] = useState(String(subject?.lossCv ?? 0.9));

  // ── Stored programmes (the Retro module) ──────────────────────────────────
  // When the host names the treaty, seed the programme from the stored ACTIVE
  // programmes that cover it (year × class × country — GET /api/retro/
  // applicable) instead of the illustrative default. Edits flip the source to
  // 'custom'; "Reset to stored" re-applies the stored seed. Without a
  // contractId (or when nothing matches) the heuristic default stands.
  const [stored, setStored] = useState(null);          // programmeFromStored() output once loaded
  const [source, setSource] = useState('default');     // 'default' | 'stored' | 'custom'
  const touchedRef = useRef(false);
  useEffect(() => {
    if (!contractId) return undefined;
    let cancelled = false;
    (async () => {
      try {
        const res = await api.getApplicableRetroProgrammes(
          isQuote ? { quoteId: contractId } : { contractId },
        );
        if (cancelled) return;
        const seed = programmeFromStored(res?.programmes);
        setStored(seed);
        if (seed.hasStored) {
          // Edited before the fetch landed → keep the edits, offer the reset.
          if (touchedRef.current) setSource('custom');
          else { setProg(seed.programme); setSource('stored'); }
        }
      } catch (e) {
        logger.warn('retro applicable-programmes load failed', e);
      }
    })();
    return () => { cancelled = true; };
  }, [contractId, isQuote]);

  const setP = (key) => (v) => {
    touchedRef.current = true;
    setSource((s) => (s === 'stored' ? 'custom' : s));
    setProg((p) => ({ ...p, [key]: v }));
  };
  const resetToStored = () => {
    if (!stored?.hasStored) return;
    touchedRef.current = false;
    setProg(stored.programme);
    setSource('stored');
  };

  const result = useMemo(() => optimiseRetroLine({
    subject: { ...subject, lossCv: numOr(lossCv, 0.9) || 0.9 },
    programme: prog,
    currentLinePct: numOr(currentLinePct),
  }), [subject, prog, lossCv, currentLinePct]);

  const currentEval = useMemo(() => {
    if (!(numOr(currentLinePct) > 0)) return null;
    return evaluateRetroAtLine({
      linePct: numOr(currentLinePct),
      subject: { ...subject, lossCv: numOr(lossCv, 0.9) || 0.9 },
      programme: prog,
    });
  }, [subject, prog, lossCv, currentLinePct]);

  const best = result?.best || null;
  const noRetro = result?.noRetro || null;
  const p = normaliseProgramme(prog);
  const hasCurrent = !!currentEval;
  const fmtM = (n) => (Number.isFinite(n) && Math.round(n) !== 0 ? money(Math.round(n)) : '—');
  const signCls = (n) => (n > 0 ? 'ok' : n < 0 ? 'bad' : '');

  const rows = [
    { k: 'Gross premium',         f: (r) => fmtM(r.grossPremium) },
    { k: 'Retro spend',           f: (r) => fmtM(-r.retroSpend), cls: () => 'bad' },
    { k: '· QS ceded (net of comm.)', f: (r) => fmtM(-(r.qsCededPremium - r.qsCommission)), sub: true },
    { k: '· XL premium + reinst.',    f: (r) => fmtM(-r.xlSpend), sub: true },
    { k: 'Expected recoveries',   f: (r) => fmtM(r.retroRecovery), cls: () => 'ok' },
    { k: '· QS share of losses',  f: (r) => fmtM(r.qsRecovery), sub: true },
    { k: '· XL layer recovery',   f: (r) => fmtM(r.xlRecovery), sub: true },
    { k: 'Net retro cost',        f: (r) => fmtM(-r.retroNetCost), cls: (r) => signCls(-r.retroNetCost) },
    { k: 'Net result',            f: (r) => fmtM(r.netResult), cls: (r) => signCls(r.netResult), strong: true },
    { k: '1-in-100 net PML',      f: (r) => fmtM(r.netPml) },
    { k: 'PML relief from retro', f: (r) => fmtM(r.pmlRelief), cls: () => 'ok' },
    { k: 'Capital charge',        f: (r) => fmtM(-r.capitalCharge), cls: () => 'bad' },
    { k: 'Risk-adjusted result',  f: (r) => fmtM(r.riskAdjustedResult), cls: (r) => signCls(r.riskAdjustedResult), strong: true },
  ];

  const cols = [
    hasCurrent ? { key: 'current', label: `Current ${currentEval.linePct.toFixed(1)}%`, r: currentEval } : null,
    best ? { key: 'best', label: `✦ Suggested ${best.linePct.toFixed(1)}%`, r: best, hot: true } : null,
    noRetro ? { key: 'noretro', label: `No retro @ ${noRetro.linePct.toFixed(1)}%`, r: noRetro } : null,
  ].filter(Boolean);

  return (
    <div className="bbg-modal-backdrop rim-backdrop" role="presentation"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="bbg-modal bbg-modal--wide rim-modal">
        <div className="bbg-modal-head">
          <span className="bbg-modal-title">⛨ Retro Impact on Line Size{contextLabel ? ` — ${contextLabel}` : ''}</span>
          <button className="bbg-modal-x" onClick={onClose}>✕</button>
        </div>
        <div className="bbg-modal-body rim-body">

          {/* ── Programme inputs ── */}
          <div className="off-card rim-programme">
            <div className="off-card-title">Outwards Retro Programme</div>
            {source === 'stored' && stored?.hasStored && (
              <div className="rim-source rim-source--stored">
                ⛨ Seeded from stored programme{stored.sourceNames.length === 1 ? '' : 's'}: <b>{stored.sourceNames.join(', ')}</b>
                {stored.unusedNames.length > 0 && (
                  <span className="rim-source-sub"> · also covering (not modelled): {stored.unusedNames.join(', ')}</span>
                )}
              </div>
            )}
            {source === 'custom' && stored?.hasStored && (
              <div className="rim-source rim-source--custom">
                Edited — differs from the stored programme.
                <button type="button" className="rim-source-reset" onClick={resetToStored}>↺ Reset to stored</button>
              </div>
            )}
            {contractId && stored && !stored.hasStored && (
              <div className="rim-source rim-source--none">
                No stored retro programme covers this treaty — showing illustrative defaults. Programmes are maintained in the Retro module.
              </div>
            )}
            <div className="rim-fields">
              <Field label="QS cession">
                <PctInput className="rim-inp" value={String(prog.qsCessionPct ?? '')} onChange={setP('qsCessionPct')} placeholder="0%" />
              </Field>
              <Field label="QS commission">
                <PctInput className="rim-inp" value={String(prog.qsCommissionPct ?? '')} onChange={setP('qsCommissionPct')} placeholder="0%" />
              </Field>
              <Field label="Cost of capital">
                <PctInput className="rim-inp" value={String(prog.costOfCapitalPct ?? '')} onChange={setP('costOfCapitalPct')} placeholder="0%" />
              </Field>
              <Field label="Aggregate loss CV">
                <input className="rim-inp" type="text" inputMode="decimal" value={lossCv}
                  aria-label="Aggregate loss coefficient of variation"
                  onChange={(e) => setLossCv(e.target.value)} />
              </Field>
            </div>
            <div className="rim-xl-head">
              <span className="off-card-title rim-xl-title">Retro XL</span>
              <label className="rim-toggle" htmlFor={`${uid}-xl`}>
                <input id={`${uid}-xl`} type="checkbox" checked={prog.xlEnabled !== false}
                  onChange={(e) => setP('xlEnabled')(e.target.checked)} />
                <span>{prog.xlEnabled !== false ? 'Bought' : 'Not bought'}</span>
              </label>
            </div>
            <div className="rim-fields">
              <Field label="Attachment">
                <input className="rim-inp" type="text" inputMode="numeric" value={String(prog.xlAttachment ?? '')}
                  aria-label="Retro XL attachment" disabled={prog.xlEnabled === false}
                  onChange={(e) => setP('xlAttachment')(e.target.value)} />
              </Field>
              <Field label="Limit">
                <input className="rim-inp" type="text" inputMode="numeric" value={String(prog.xlLimit ?? '')}
                  aria-label="Retro XL limit" disabled={prog.xlEnabled === false}
                  onChange={(e) => setP('xlLimit')(e.target.value)} />
              </Field>
              <Field label="Rate on line">
                <PctInput className="rim-inp" value={String(prog.xlRolPct ?? '')} onChange={setP('xlRolPct')}
                  placeholder="0%" disabled={prog.xlEnabled === false} />
              </Field>
              <Field label="Reinstatements">
                <input className="rim-inp" type="text" inputMode="numeric" value={String(prog.xlReinstatements ?? '')}
                  aria-label="Retro XL reinstatements" disabled={prog.xlEnabled === false}
                  onChange={(e) => setP('xlReinstatements')(e.target.value)} />
              </Field>
            </div>
            <div className="rim-hint">
              XL sits on the net-of-QS aggregate · cover {fmtM(p.xlLimit * (1 + p.xlReinstatements))} xs {fmtM(p.xlAttachment)}
            </div>
          </div>

          {/* ── AI suggestion given retro ── */}
          <div className="off-ai rim-ai">
            <div className="off-ai-head">
              <div className="off-ai-label">✦ AI Suggested Line Given Retro</div>
              {onApplyLine && best && (
                <button className="off-ai-apply" type="button"
                  onClick={() => onApplyLine(best.linePct)}>Apply →</button>
              )}
            </div>
            <div className="off-ai-number">
              <div className="off-ai-pct">{best ? best.linePct.toFixed(1) : '—'}</div>
              <div className="off-ai-unit">%</div>
            </div>
            <div className="off-ai-reason">{result?.reason}</div>
            <div className="off-ai-econ">
              <div className="off-ai-econ-item">
                <span className="off-ai-econ-k">Retro spend</span>
                <span className="off-ai-econ-v">{best ? fmtM(best.retroSpend) : '—'}</span>
              </div>
              <div className="off-ai-econ-item">
                <span className="off-ai-econ-k">Recoveries</span>
                <span className="off-ai-econ-v">{best ? fmtM(best.retroRecovery) : '—'}</span>
              </div>
              <div className="off-ai-econ-item">
                <span className="off-ai-econ-k">Cost recovery</span>
                <span className={`off-ai-econ-v ${best && best.retroEfficiency >= 1 ? 'ok' : ''}`}>
                  {best && best.retroSpend > 0 ? `${(best.retroEfficiency * 100).toFixed(0)}%` : '—'}
                </span>
              </div>
              <div className="off-ai-econ-item">
                <span className="off-ai-econ-k">Vs current line</span>
                <span className={`off-ai-econ-v ${result && hasCurrent ? signCls(result.uplift) : ''}`}>
                  {result && hasCurrent ? fmtM(result.uplift) : '—'}
                </span>
              </div>
            </div>
            <RetroCurve curve={result?.curve} bestPct={best?.linePct}
              currentPct={hasCurrent ? currentEval.linePct : NaN} />
            <div className="rim-curve-caption">Risk-adjusted net result by written line{result && result.capPct < 100 ? ` · authority caps the line at ${result.capPct.toFixed(1)}%` : ''}</div>
          </div>

          {/* ── Gross → net walk ── */}
          <div className="off-card rim-table-card">
            <div className="off-card-title">Retro Impact — Gross → Net</div>
            <div className="rim-table-scroll">
              <table className="rim-table">
                <thead>
                  <tr>
                    <th className="rim-th rim-th-metric">Metric</th>
                    {cols.map((c) => (
                      <th key={c.key} className={`rim-th ${c.hot ? 'rim-th-hot' : ''}`}>{c.label}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={row.k} className={row.sub ? 'rim-tr-sub' : row.strong ? 'rim-tr-strong' : ''}>
                      <td className="rim-td rim-td-metric">{row.k}</td>
                      {cols.map((c) => (
                        <td key={c.key} className={`rim-td ${row.cls ? row.cls(c.r) : ''}`}>{row.f(c.r)}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="rim-hint">
              Recoveries are expected values on a lognormal aggregate (CV {numOr(lossCv, 0.9) || 0.9}); PML is the 1-in-100 outcome.
              Suggested line maximises net result less a {p.costOfCapitalPct}% capital charge on the retained 1-in-100 downside.
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
