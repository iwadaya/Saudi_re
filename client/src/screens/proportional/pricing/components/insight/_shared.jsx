// Module-level numeric helper (used by TreatyMetricsPanel and others)
import { toN } from '../../../../../utils/format.js';

export const cn = toN;

/**
 * Inline SVG bar chart that lays out current-vs-previous pairs, one
 * metric per row. No external chart library — the pairs share a
 * per-row max so the two bars are comparable. Used by both Compare
 * Terms and Treaty Metrics at the bottom of each modal.
 *
 * @param {{ rows: Array<{key:string,label:string,cur:number,prev:number}> }} props
 */
export function MetricBars({ rows }) {
  if (!rows?.length) return null;
  const fmt = (n) => {
    if (!Number.isFinite(n) || n === 0) return '—';
    const abs = Math.abs(n);
    if (abs >= 1e9) return (n / 1e9).toFixed(1) + 'B';
    if (abs >= 1e6) return (n / 1e6).toFixed(1) + 'M';
    if (abs >= 1e3) return n.toLocaleString('en-US', { maximumFractionDigits: 0 });
    return n.toFixed(abs < 10 ? 2 : 1);
  };
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {rows.map((r) => {
        const max = Math.max(Math.abs(r.cur), Math.abs(r.prev), 1);
        const curW  = Math.max(2, (Math.abs(r.cur)  / max) * 100);
        const prevW = Math.max(2, (Math.abs(r.prev) / max) * 100);
        return (
          <div key={r.key}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: 'rgba(255,255,255,0.65)', marginBottom: 4 }}>
              <span>{r.label}</span>
              <span style={{ color: 'rgba(255,255,255,0.4)' }}>cur {fmt(r.cur)} · prev {fmt(r.prev)}</span>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
              <div style={{ height: 8, background: 'rgba(74,222,128,0.08)', borderRadius: 4, position: 'relative', overflow: 'hidden' }}>
                <div style={{ height: '100%', width: `${curW}%`, background: 'linear-gradient(90deg, rgba(74,222,128,0.9), rgba(74,222,128,0.5))', borderRadius: 4 }} />
              </div>
              <div style={{ height: 8, background: 'rgba(96,165,250,0.08)', borderRadius: 4, position: 'relative', overflow: 'hidden' }}>
                <div style={{ height: '100%', width: `${prevW}%`, background: 'linear-gradient(90deg, rgba(96,165,250,0.9), rgba(96,165,250,0.5))', borderRadius: 4 }} />
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

/**
 * Tiny tab switcher used by CompareTermsPanel and TreatyMetricsPanel
 * to split the data table and the comparison graphs into two views.
 */
export function ViewTabs({ value, onChange }) {
  const tab = (id, label) => {
    const active = value === id;
    return (
      <button
        key={id}
        type="button"
        onClick={() => onChange(id)}
        className={`view-tab${active ? ' is-active' : ''}`}
        role="tab"
        aria-selected={active}
      >{label}</button>
    );
  };
  return (
    <div className="view-tabs" role="tablist" aria-label="View">
      {tab('table', 'Table')}
      {tab('graphs', 'Graphs')}
    </div>
  );
}
