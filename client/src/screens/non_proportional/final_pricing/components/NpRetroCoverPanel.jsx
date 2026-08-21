// components/NpRetroCoverPanel.jsx
//
// Retro cover analysis for the offer modal: what the suggested written line
// does to our own outward programme, and which line gets the most out of the
// retro capacity it consumes.
//
// Three scenarios sit side by side — the line currently written across the
// layers, the AI-suggested line, and the retro-optimal line — each priced
// through the programme (quota share → retro XL) so the underwriter can see the
// cost of cover, the net retention and the net margin before committing. The
// curve underneath sweeps every line on the grid so the trade-off, and the
// point where the programme runs out, are visible rather than inferred.
//
// The programme assumptions are editable and persist locally: one outward
// programme applies across treaties, so once entered they stick.
//
// All maths lives in ../retroCover.js; all styling in the .retro-* block of
// styles/non_proportional/final_pricing.css — this file is structure only.

import { useState } from 'react';
import { fmtC } from '../formatters.js';
import { analyseRetroCover, buildRetroLayers, defaultProgrammeFor, retroVerdict } from '../retroCover.js';

const STORE_KEY = 'u3.retroProgramme.v1';

/** Programme fields, in the order they read on the strip. */
const FIELDS = [
  { k: 'retentionAmt', label: 'Retention', kind: 'money', hint: 'Net priority per event' },
  { k: 'limitAmt', label: 'Retro Limit', kind: 'money', hint: 'Cover above the retention' },
  { k: 'usedLimitAmt', label: 'Limit Used', kind: 'money', hint: 'Burned by the rest of the book' },
  { k: 'rolPct', label: 'Retro ROL', kind: 'pct', hint: 'Cost of cover per unit of limit' },
  { k: 'cessionPct', label: 'Retro QS', kind: 'pct', hint: 'Proportional cession off the top' },
  { k: 'commissionPct', label: 'QS Comm', kind: 'pct', hint: 'Commission earned on the cession' },
];

const VERDICT_ICON = { BREACH: '⚠', OVER: '◐', HEADROOM: '↑', ALIGNED: '✓', NONE: '•' };

const readStored = () => {
  try { return JSON.parse(window.localStorage.getItem(STORE_KEY) || 'null') || null; } catch { return null; }
};
const writeStored = p => { try { window.localStorage.setItem(STORE_KEY, JSON.stringify(p)); } catch { /* ignore */ } };

/** Stored programme if the underwriter has entered one, else derived from the tower. */
function initialProgramme(layers) {
  const derived = defaultProgrammeFor(layers);
  const stored = readStored() || {};
  const out = {};
  Object.keys(derived).forEach(k => {
    const v = stored[k] !== undefined && stored[k] !== '' ? stored[k] : derived[k];
    out[k] = typeof v === 'number' && Math.abs(v) >= 1000 ? fmtC(v) : String(v);
  });
  return out;
}

/** Lines sit on a quarter-point grid: keep 2dp, drop dead zeros. */
const lineLabel = n => `${(Number.isFinite(n) ? n : 0).toFixed(2).replace(/\.?0+$/, '')}%`;

export default function NpRetroCoverPanel({
  layerData = [],
  rawLayers = [],
  techRatioAvgPct = 0,
  suggestedLinePct = 0,
  currentLines = [],
  currency = 'USD',
  readOnly = false,
  onApplyLine,
}) {
  const layers = buildRetroLayers(layerData, rawLayers, techRatioAvgPct);
  const [programme, setProgramme] = useState(() => initialProgramme(layers));
  const [editing, setEditing] = useState(false);

  const money = n => (Math.abs(n) >= 0.5 ? `${currency} ${fmtC(Math.round(n))}` : '—');
  const signedMoney = n => (Math.abs(n) < 0.5 ? '—' : `${n < 0 ? '−' : ''}${currency} ${fmtC(Math.abs(Math.round(n)))}`);

  // Cheap enough to run on every render (a hundred grid points over a handful
  // of layers), and re-running keeps it honest as the written lines are typed.
  const analysis = analyseRetroCover(layers, programme, { suggestedLinePct, currentLines });
  const verdict = retroVerdict(analysis, { money });

  const setField = (k, v) => {
    const next = { ...programme, [k]: v };
    setProgramme(next);
    writeStored(next);
  };

  const { suggested, current, optimal, capacity, programme: prog } = analysis;
  const scenarios = [
    current && { key: 'current', name: 'Written now', mark: '●', row: current },
    suggested && { key: 'suggested', name: 'AI suggested', mark: '✦', row: suggested, apply: true },
    optimal && { key: 'optimal', name: 'Retro-optimal', mark: '◎', row: optimal, apply: true },
  ].filter(Boolean);
  const showApply = !readOnly && !!onApplyLine;

  return (
    <div className="off-card retro-panel" data-testid="retro-cover-panel">

      {/* ── HEADER: what the programme is, and the way into editing it ── */}
      <div className="retro-head">
        <div>
          <div className="off-card-title retro-title">⛨ Retro Cover Analysis</div>
          <div className="retro-sub">
            {money(prog.limitAmt)} xs {money(prog.retentionAmt)} @ {prog.rolPct}% ROL
            {prog.usedLimitAmt > 0 ? ` · ${money(prog.usedLimitAmt)} already used` : ''}
            {prog.cessionPct > 0 ? ` · ${prog.cessionPct}% retro QS` : ' · no retro QS'}
          </div>
        </div>
        <button type="button" className="retro-toggle" onClick={() => setEditing(v => !v)}>
          {editing ? 'Hide assumptions' : 'Programme assumptions'}
        </button>
      </div>

      {/* ── PROGRAMME ASSUMPTIONS ── */}
      {editing && (
        <div className="retro-assumptions" data-testid="retro-assumptions">
          {FIELDS.map(f => (
            <div key={f.k} className="retro-field">
              <label className="retro-field-label" htmlFor={`retro-${f.k}`}>
                {f.label} {f.kind === 'pct' ? '%' : `(${currency})`}
              </label>
              <input id={`retro-${f.k}`} className="retro-field-input" inputMode="decimal"
                value={programme[f.k] ?? ''} onChange={e => setField(f.k, e.target.value)} />
              <div className="retro-field-hint">{f.hint}</div>
            </div>
          ))}
        </div>
      )}

      {/* ── VERDICT ── */}
      <div className={`retro-verdict retro-verdict--${verdict.status.toLowerCase()}`} data-testid="retro-verdict">
        <span className="retro-verdict-icon">{VERDICT_ICON[verdict.status] || VERDICT_ICON.NONE}</span>
        <div>
          <div className="retro-verdict-head">{verdict.headline}</div>
          <div className="retro-verdict-detail">{verdict.detail}</div>
        </div>
      </div>

      {/* ── SCENARIOS: written / suggested / optimal through the programme ── */}
      {scenarios.length > 0 && (
        <div className="retro-table-wrap">
          <table className="retro-table">
            <thead>
              <tr>
                <th className="retro-c-scenario">Scenario</th>
                <th className="retro-c-line">Line</th>
                <th className="retro-c-gross">Gross Exposure</th>
                <th className="retro-c-recovery">Retro Recovery</th>
                <th className="retro-c-retained">Net Retained</th>
                <th className="retro-c-cost">Cost Of Cover</th>
                <th className="retro-c-netprem">Net Premium</th>
                <th className="retro-c-margin">Net Margin</th>
                <th className="retro-c-util">Limit Used</th>
                {showApply && <th className="retro-c-apply" />}
              </tr>
            </thead>
            <tbody>
              {scenarios.map(s => (
                <tr key={s.key} className={`retro-row retro-row--${s.key}`} data-testid={`retro-scenario-${s.key}`}>
                  <td className="retro-c-scenario">{s.mark} {s.name}</td>
                  <td className="retro-c-line">{lineLabel(s.row.linePct)}</td>
                  <td className="retro-c-gross">{money(s.row.grossEventLoss)}</td>
                  <td className="retro-c-recovery">{money(s.row.retroRecovery)}</td>
                  <td className={`retro-c-retained${s.row.fullyProtected ? '' : ' retro-breach'}`}>
                    {money(s.row.netRetainedEvent)}
                    {!s.row.fullyProtected && (
                      <div className="retro-note retro-note--bad">{money(s.row.unprotected)} unprotected</div>
                    )}
                  </td>
                  <td className="retro-c-cost">
                    {money(s.row.retroCost)}
                    {s.row.retroCost > 0 && (
                      <div className="retro-note retro-note--cost">{s.row.retroCostRatioPct.toFixed(1)}% of premium</div>
                    )}
                  </td>
                  <td className="retro-c-netprem">{money(s.row.netPremium)}</td>
                  <td className={`retro-c-margin${s.row.netMargin > 0 ? '' : ' retro-breach'}`}>
                    {signedMoney(s.row.netMargin)}
                    <div className="retro-note">{s.row.netMarginPct.toFixed(1)}% margin</div>
                  </td>
                  <td className="retro-c-util">
                    <UtilBar pct={s.row.retroLimitUtilPct} breached={!s.row.fullyProtected} />
                  </td>
                  {showApply && (
                    <td className="retro-c-apply">
                      {s.apply && (
                        <button type="button" className="retro-apply" data-testid={`retro-apply-${s.key}`}
                          onClick={() => onApplyLine(Math.round(s.row.linePct * 100) / 100)}>
                          apply {lineLabel(s.row.linePct)} →
                        </button>
                      )}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* ── OPTIMISATION CURVE ── */}
      <RetroCurve analysis={analysis} suggested={suggested} optimal={optimal} capacity={capacity} money={money} />
    </div>
  );
}

/**
 * Retro limit consumption. Drawn as SVG rather than a styled div so the width
 * rides on an attribute — the screens layer gates inline styles.
 */
function UtilBar({ pct, breached }) {
  const w = Math.max(0, Math.min(100, pct));
  const tone = breached ? 'bad' : w > 80 ? 'warn' : 'ok';
  return (
    <span className="retro-util">
      <svg className="retro-util-bar" width="54" height="5" viewBox="0 0 54 5" aria-hidden="true">
        <rect className="retro-util-track" x="0" y="0" width="54" height="5" rx="2.5" />
        <rect className={`retro-util-fill retro-util-fill--${tone}`} x="0" y="0" width={(w * 54) / 100} height="5" rx="2.5" />
      </svg>
      <span className={`retro-util-val retro-util-val--${tone}`}>{pct.toFixed(0)}%</span>
    </span>
  );
}

/**
 * Net margin against the line, with the net retention it rides on and the point
 * where the programme runs out of limit. Plain SVG — the modal has no room for
 * a charting library and this is a hundred points of a monotone-ish curve.
 */
function RetroCurve({ analysis, suggested, optimal, capacity, money }) {
  const curve = analysis.curve || [];
  if (!analysis.hasExposure || curve.length === 0) return null;

  const W = 620, H = 130, L = 8, R = 8, T = 14, B = 20;
  const xMax = analysis.programme.maxLinePct;
  const marginMax = Math.max(1, ...curve.map(r => Math.abs(r.netMargin)));
  const retainedMax = Math.max(1, ...curve.map(r => r.netRetainedEvent));
  const x = line => L + (line / xMax) * (W - L - R);
  const yTop = T, yBot = H - B;
  // Leave room under the baseline only when the margin actually goes negative.
  const base = curve.some(r => r.netMargin < 0) ? yTop + (yBot - yTop) * 0.72 : yBot;
  const yMargin = v => (v >= 0 ? base - (v / marginMax) * (base - yTop) : base + (Math.abs(v) / marginMax) * (yBot - base));
  const yRetained = v => yBot - (v / retainedMax) * (yBot - yTop);

  const marginArea = `M ${x(curve[0].linePct)} ${base} `
    + curve.map(r => `L ${x(r.linePct).toFixed(1)} ${yMargin(r.netMargin).toFixed(1)}`).join(' ')
    + ` L ${x(curve.at(-1).linePct)} ${base} Z`;
  const retainedPath = 'M ' + curve.map(r => `${x(r.linePct).toFixed(1)} ${yRetained(r.netRetainedEvent).toFixed(1)}`).join(' L ');

  const capLine = capacity ? capacity.linePct : 0;
  const marks = [
    suggested && { key: 'suggested', line: suggested.linePct, label: `✦ ${lineLabel(suggested.linePct)}` },
    optimal && { key: 'optimal', line: optimal.linePct, label: `◎ ${lineLabel(optimal.linePct)}` },
  ].filter(Boolean);

  return (
    <div className="retro-curve" data-testid="retro-curve">
      <div className="retro-curve-head">
        <div className="retro-curve-title">Line Optimisation — net margin vs retained exposure</div>
        <div className="retro-legend">
          <span className="retro-legend-item retro-legend-item--margin">▬ net margin</span>
          <span className="retro-legend-item retro-legend-item--retained">▬ net retained</span>
          <span className="retro-legend-item retro-legend-item--breach">▨ beyond retro limit</span>
        </div>
      </div>
      {/* Sized by CSS (width 100%, height auto) so the curve fills the panel
          instead of letterboxing inside it; text scales with the viewBox. */}
      <svg className="retro-chart" viewBox={`0 0 ${W} ${H}`} role="img"
        aria-label={`Net margin and net retained exposure by written line, up to ${xMax}%`}>
        {/* Zone the programme can no longer protect. */}
        {capLine < xMax && (
          <rect className="retro-chart-breach" x={capLine > 0 ? x(capLine) : L} y={T - 4}
            width={W - R - (capLine > 0 ? x(capLine) : L)} height={H - B - T + 4} />
        )}
        <line className="retro-chart-base" x1={L} y1={base} x2={W - R} y2={base} />
        <path className="retro-chart-margin" d={marginArea} />
        <path className="retro-chart-retained" d={retainedPath} />
        {marks.map(m => (
          <g key={m.key} className={`retro-mark retro-mark--${m.key}`}>
            <line x1={x(m.line)} y1={T - 4} x2={x(m.line)} y2={H - B} />
            <text x={Math.min(x(m.line) + 4, W - 60)} y={T + 4}>{m.label}</text>
          </g>
        ))}
        <text className="retro-chart-axis" x={L} y={H - 6}>0%</text>
        <text className="retro-chart-axis" x={W - R} y={H - 6} textAnchor="end">{xMax}% line</text>
        {capLine > 0 && capLine < xMax && (
          <text className="retro-chart-axis retro-chart-axis--bad" x={x(capLine) + 4} y={H - 6}>
            retro limit exhausted at {lineLabel(capLine)}
          </text>
        )}
      </svg>
      {optimal && (
        <div className="retro-curve-foot">
          Peak return on retained capacity at {lineLabel(optimal.linePct)} — {money(optimal.netMargin)} of net margin
          on {money(optimal.netRetainedEvent)} retained per event.
        </div>
      )}
    </div>
  );
}
