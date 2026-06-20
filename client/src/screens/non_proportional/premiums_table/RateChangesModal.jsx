// src/screens/non_proportional/premiums_table/RateChangesModal.jsx
// Compound on-level rate-change adjustment modal, extracted from NpPremiumsTable
// to keep that screen under the 800-line budget. Pure/presentational: it takes
// the years + UW rows + rate-change rows and reports edits via onChange.
import { useMemo, useCallback } from "react";
import PctInput from "../../../components/PctInput";
import { parseFlexNum, fmtMoney, fmtPct } from "./formatters";

export default function RateChangesModal({ years, uwRows, rateChangeRows, onChange, onClose }) {
  const egnpiByYear = useMemo(
    () => new Map(uwRows.map(r => [String(r.uwYear), parseFlexNum(r.egnpi)])),
    [uwRows],
  );
  const rateByYear = useMemo(
    () => new Map((rateChangeRows || []).map(r => [String(r.uwYear), parseFlexNum(r.rateChangePct)])),
    [rateChangeRows],
  );
  // Walk year-list from latest backward so the factor compounds the
  // rate changes that have happened SINCE year y. Most recent year's
  // factor = 1.0.
  const rows = useMemo(() => {
    const sortedYears = [...years].sort((a, b) => a - b);
    const result = [];
    let factor = 1.0;
    for (let i = sortedYears.length - 1; i >= 0; i--) {
      const y = sortedYears[i];
      const r = rateByYear.get(String(y));
      const onLevel = factor;
      const egnpi = egnpiByYear.get(String(y));
      const adjusted = Number.isFinite(egnpi) ? egnpi * onLevel : null;
      result.unshift({
        uwYear: y,
        egnpi,
        rateChangePct: rateChangeRows.find(rc => rc.uwYear === y)?.rateChangePct ?? '',
        onLevelFactor: onLevel,
        adjustedEgnpi: adjusted,
      });
      // Apply year y's rate change to compound the factor for the year before y.
      if (Number.isFinite(r)) factor *= 1 + r / 100;
    }
    return result;
  }, [years, egnpiByYear, rateByYear, rateChangeRows]);

  const updateRate = useCallback((year, value) => {
    onChange(prev => {
      const map = new Map((prev || []).map(r => [String(r.uwYear), { ...r }]));
      const next = years.map(y => {
        const cur = map.get(String(y)) || { uwYear: y, rateChangePct: '' };
        if (y === year) return { uwYear: y, rateChangePct: value };
        return { ...cur, uwYear: y };
      });
      return next;
    });
  }, [onChange, years]);

  return (
    <div
      className="modal-backdrop"
      role="presentation"
      style={{ position: 'fixed', inset: 0, zIndex: 1000, background: 'rgba(0,0,0,0.65)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        className="glass"
        role="dialog"
        aria-modal="true"
        style={{ background: '#0a1020', border: '1px solid rgba(255,255,255,0.10)', borderRadius: 18, width: 820, maxWidth: '95vw', maxHeight: '85vh', overflow: 'hidden', display: 'flex', flexDirection: 'column' }}
      >
        <div style={{ padding: '18px 24px', borderBottom: '1px solid rgba(255,255,255,0.08)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
            <div style={{ fontSize: 15, fontWeight: 800, color: 'rgba(226,232,240,0.92)' }}>Rate Changes</div>
            <div style={{ fontSize: 11, color: 'rgba(148,163,184,0.55)', marginTop: 2 }}>
              Compound on-level adjustment. Latest year's factor = 1.00.
            </div>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" style={{ appearance: 'none', border: 'none', background: 'transparent', color: 'rgba(148,163,184,0.60)', fontSize: 18, cursor: 'pointer' }}>✕</button>
        </div>
        <div style={{ flex: 1, overflowY: 'auto', padding: '16px 24px' }}>
          <div style={{ overflowX: 'auto', borderRadius: 10, border: '1px solid rgba(255,255,255,0.06)' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 720, tableLayout: 'fixed', fontVariantNumeric: 'tabular-nums' }}>
              <colgroup>
                <col style={{ width: '12%' }} />
                <col style={{ width: '24%' }} />
                <col style={{ width: '20%' }} />
                <col style={{ width: '18%' }} />
                <col style={{ width: '26%' }} />
              </colgroup>
              <thead>
                <tr style={{ background: '#050810' }}>
                  <th style={{ padding: '10px 8px', fontSize: 9, fontWeight: 800, letterSpacing: '.12em', textTransform: 'uppercase', color: 'rgba(255,255,255,0.45)', borderBottom: '1px solid rgba(255,255,255,0.10)' }}>UW Year</th>
                  <th style={{ padding: '10px 8px', fontSize: 9, fontWeight: 800, letterSpacing: '.12em', textTransform: 'uppercase', color: 'rgba(255,255,255,0.45)', borderBottom: '1px solid rgba(255,255,255,0.10)', textAlign: 'right' }}>Premium</th>
                  <th style={{ padding: '10px 8px', fontSize: 9, fontWeight: 800, letterSpacing: '.12em', textTransform: 'uppercase', color: '#00d4ff', borderBottom: '1px solid rgba(255,255,255,0.10)' }}>Rate Change %</th>
                  <th style={{ padding: '10px 8px', fontSize: 9, fontWeight: 800, letterSpacing: '.12em', textTransform: 'uppercase', color: 'rgba(255,255,255,0.45)', borderBottom: '1px solid rgba(255,255,255,0.10)', textAlign: 'right' }}>On-Level Factor</th>
                  <th style={{ padding: '10px 8px', fontSize: 9, fontWeight: 800, letterSpacing: '.12em', textTransform: 'uppercase', color: '#4ade80', borderBottom: '1px solid rgba(255,255,255,0.10)', textAlign: 'right' }}>Adjusted Premium</th>
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 ? (
                  <tr><td colSpan={5} style={{ padding: 18, textAlign: 'center', color: 'rgba(148,163,184,0.55)' }}>Set Start Year / Renewal Date on Treaty Detail.</td></tr>
                ) : rows.map((r, i) => (
                  <tr key={r.uwYear} style={{ background: i % 2 === 0 ? '#080f23' : '#0a1125' }}>
                    <td style={{ padding: '8px 8px', fontWeight: 700, color: 'rgba(0,212,255,0.70)', fontSize: 12 }}>{r.uwYear}</td>
                    <td style={{ padding: '8px 8px', textAlign: 'right', color: 'rgba(226,232,240,0.80)' }}>
                      {Number.isFinite(r.egnpi) ? fmtMoney(r.egnpi) : <span style={{ color: 'rgba(148,163,184,0.40)' }}>—</span>}
                    </td>
                    <td style={{ padding: '6px 8px' }}>
                      <PctInput
                        className="np-inp np-inp-pct"
                        placeholder="0.00%"
                        value={r.rateChangePct}
                        onChange={(v) => updateRate(r.uwYear, v)}
                        onBlur={() => {
                          const n = parseFlexNum(r.rateChangePct);
                          updateRate(r.uwYear, n === null ? '' : fmtPct(n));
                        }}
                      />
                    </td>
                    <td style={{ padding: '8px 8px', textAlign: 'right', color: 'rgba(226,232,240,0.70)' }}>
                      {r.onLevelFactor.toFixed(4)}
                    </td>
                    <td style={{ padding: '8px 8px', textAlign: 'right', color: '#4ade80', fontWeight: 700 }}>
                      {Number.isFinite(r.adjustedEgnpi) ? fmtMoney(r.adjustedEgnpi) : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div style={{ marginTop: 12, fontSize: 11, color: 'rgba(148,163,184,0.55)', lineHeight: 1.5 }}>
            Rate change <em>r</em> for year <em>y</em> means premium that year sits <em>r</em>% above the prior year's rate level.
            The on-level factor compounds every change <em>since</em> year <em>y</em>, bringing the historical premium to today's level.
          </div>
        </div>
      </div>
    </div>
  );
}
