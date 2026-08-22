// client/src/screens/facultative/pricing/FacClassAccumulationModal.jsx
//
// "What am I already carrying in this class?" — every bound facultative risk
// and every inforce treaty covering the class being priced, at our share, with
// the risk on the desk shown separately so its contribution is visible rather
// than folded into the total it is being judged against.
//
// The class is the TREATY class the fac class maps to (Industrial All Risks →
// Property), because that is the only level at which the two halves are
// commensurable. Each fac row names its own class so the mix stays legible.
//
// Everything is USD at our signed share — see facClassAccumulationService for
// why premium is not re-shared. When the class has no treaty mapping the modal
// says so instead of showing a zero that would read as "nothing accumulated".
//
// Styling lives in FacPricing.css: the screens layer is gated on inline-style
// count by scripts/frontend-budget.mjs (docs/frontend-hardening.md).
import { useEffect, useRef, useState } from 'react';
import { api } from '../../../api';
import { logger } from '../../../utils/logger';

const usd0 = (n) => (Number.isFinite(Number(n))
  ? `$${Math.round(Number(n)).toLocaleString('en-US')}`
  : '—');

/** Compact money for the headline tiles: $3.74bn reads faster than the digits. */
function compactUsd(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return '—';
  const abs = Math.abs(v);
  if (abs >= 1e9) return `$${(v / 1e9).toFixed(2)}bn`;
  if (abs >= 1e6) return `$${(v / 1e6).toFixed(1)}m`;
  if (abs >= 1e3) return `$${Math.round(v / 1e3)}k`;
  return `$${Math.round(v)}`;
}

function Tile({ label, exposure, premium, variant, note }) {
  return (
    <div className={`facacc-tile${variant ? ` facacc-tile--${variant}` : ''}`}>
      <div className="facacc-tile-label">{label}</div>
      <div className="facacc-tile-value">{compactUsd(exposure)}</div>
      <div className="facacc-tile-sub">premium {compactUsd(premium)}</div>
      {note && <div className="facacc-tile-note">{note}</div>}
    </div>
  );
}

function Rows({ lines, kind }) {
  if (!lines.length) {
    return (
      <tr><td colSpan={5} className="facacc-empty">
        {kind === 'fac'
          ? 'No other bound facultative risks in this class.'
          : 'No inforce treaties covering this class.'}
      </td></tr>
    );
  }
  return lines.map((l) => (
    <tr key={l.facRiskId || l.contractId} className="facacc-row">
      <td>
        <div className="facacc-name">
          {kind === 'fac' ? (l.insuredName || '—') : `${l.treatyType || 'Treaty'}${l.isNp ? ' (NP)' : ''}`}
        </div>
        <div className="facacc-meta">
          {kind === 'fac' ? (l.facRef || l.facClassName || '') : (l.uwStatus || '')}
        </div>
      </td>
      <td className="facacc-dim">{l.cedantName || '—'}</td>
      <td className="facacc-r facacc-dim">{l.uwYear ?? '—'}</td>
      <td className="facacc-r facacc-num">{usd0(l.exposureUsd)}</td>
      <td className="facacc-r facacc-num">{usd0(l.premiumUsd)}</td>
    </tr>
  ));
}

function SubtotalRow({ label, totals }) {
  return (
    <tr className="facacc-subtotal">
      <td colSpan={3}>{label} ({totals.count})</td>
      <td className="facacc-r">{usd0(totals.exposureUsd)}</td>
      <td className="facacc-r">{usd0(totals.premiumUsd)}</td>
    </tr>
  );
}

/**
 * @param {{ riskId: string, onClose: () => void }} props
 */
export default function FacClassAccumulationModal({ riskId, onClose }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const closeRef = useRef(null);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    api.facGetClassAccumulation(riskId)
      .then((d) => { if (alive) { setData(d); setError(null); } })
      .catch((e) => {
        if (!alive) return;
        logger.error('class accumulation failed:', e?.message || e);
        setError(e?.message || 'Could not load class accumulation.');
      })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [riskId]);

  // Escape closes. Bound on the document rather than the dialog element so it
  // works wherever focus sits inside a long scrolling table, and so the dialog
  // container itself carries no handlers.
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);
  // Focus starts on Close so keyboard users are not dropped at the top of the table.
  useEffect(() => { closeRef.current?.focus(); }, [loading]);

  const cls = data?.class;
  const heading = cls?.className || cls?.facClassName || 'Class';
  const pricingNote = cls?.facClassName && cls?.className && cls.facClassName !== cls.className
    ? ` · pricing ${cls.facClassName}` : '';

  return (
    <div className="facacc-overlay">
      {/* Backdrop is its own presentational element so the dialog carries no
          mouse handlers — click-outside for mouse users, Escape for keyboard. */}
      <div className="facacc-backdrop" role="presentation" onMouseDown={onClose} />

      <div className="facacc-dialog" role="dialog" aria-modal="true"
        aria-label={`Class accumulation — ${heading}`}>
        <div className="facacc-head">
          <div className="facacc-head-main">
            <div className="facacc-title">Class accumulation — {heading}</div>
            <div className="facacc-sub">
              Bound facultative risks and inforce treaties in this class · our share · USD{pricingNote}
            </div>
          </div>
          <button ref={closeRef} type="button" className="facacc-close" onClick={onClose} aria-label="Close">
            Close
          </button>
        </div>

        <div className="facacc-body">
          {loading && <div className="facacc-muted">Loading accumulation…</div>}

          {!loading && error && <div role="alert" className="facacc-error">{error}</div>}

          {!loading && !error && data && (
            <>
              {data.unavailableReason && (
                <div role="status" className="facacc-notice">{data.unavailableReason}</div>
              )}

              <div className="facacc-tiles">
                <Tile label="Facultative" exposure={data.facSubtotal.exposureUsd}
                  premium={data.facSubtotal.premiumUsd} note={`${data.facSubtotal.count} bound risks`} />
                <Tile label="Treaty" exposure={data.treatySubtotal.exposureUsd}
                  premium={data.treatySubtotal.premiumUsd} note={`${data.treatySubtotal.count} inforce`} />
                <Tile label="Total carried" exposure={data.total.exposureUsd}
                  premium={data.total.premiumUsd} variant="total" />
                {data.currentRisk && (
                  <Tile label="This risk adds" exposure={data.currentRisk.exposureUsd}
                    premium={data.currentRisk.premiumUsd} variant="subject"
                    note={data.currentRisk.status === 'BOUND' ? 'already bound' : 'not yet bound'} />
                )}
              </div>

              <div className="facacc-tablewrap">
                <table className="facacc-table">
                  <thead>
                    <tr>
                      <th scope="col">Risk / Treaty</th>
                      <th scope="col">Cedant</th>
                      <th scope="col" className="facacc-r">UW yr</th>
                      <th scope="col" className="facacc-r">Exposure</th>
                      <th scope="col" className="facacc-r">Premium</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr><td colSpan={5} className="facacc-group">Facultative — bound</td></tr>
                    <Rows lines={data.facRisks} kind="fac" />
                    <SubtotalRow label="Facultative subtotal" totals={data.facSubtotal} />

                    <tr><td colSpan={5} className="facacc-group">Treaty — inforce</td></tr>
                    <Rows lines={data.treaties} kind="treaty" />
                    <SubtotalRow label="Treaty subtotal" totals={data.treatySubtotal} />

                    <tr className="facacc-total">
                      <td colSpan={3}>Total carried in {heading}</td>
                      <td className="facacc-r">{usd0(data.total.exposureUsd)}</td>
                      <td className="facacc-r">{usd0(data.total.premiumUsd)}</td>
                    </tr>
                    {data.currentRisk && (
                      <tr className="facacc-subject">
                        <td colSpan={3}>
                          This risk — {data.currentRisk.insuredName || 'unnamed'}
                          <span className="facacc-subject-note"> (not in the totals above)</span>
                        </td>
                        <td className="facacc-r">{usd0(data.currentRisk.exposureUsd)}</td>
                        <td className="facacc-r">{usd0(data.currentRisk.premiumUsd)}</td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
