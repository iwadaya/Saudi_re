// components/FactorTable.jsx — the factor grid (Phase 4.2 decomposition of
// DevFactorsScreen.jsx). JSX moved VERBATIM; numbers pinned by
// goldenMaster.test.jsx.
import { fmt4, OVER_FULL_EPS } from '../state/devFactorsCalcs';

/* ═══════════════ Factor Table ═══════════════ */
// `fullLdfs`/`fullCdfs`, when supplied, add a greyed-out reference row showing
// what each factor would have been on the full (unstripped) triangle — the
// "conservative" basis including large/cat events. When the table is editable
// we also amber-flag any selected LDF that exceeds its full-basis counterpart,
// which is unusual (stripping losses normally lowers factors) and worth a check.
export default function FactorTable({ pattern, cdfs, editable, onChange, sectionClass, fullLdfs, fullCdfs }) {
  const N = pattern?.length || 0;
  if (!N) return <div className="muted" style={{ padding: 12 }}>No factors calculated yet.</div>;
  const headers = Array.from({ length: N }, (_, i) => `${i + 1}–${i + 2}`);
  const hasConservative = Array.isArray(fullLdfs) && fullLdfs.length > 0;
  const refStyle = { color: 'var(--text-muted)', opacity: 0.7 };
  return (
    <div className={`df-card ${sectionClass || ''}`}>
      <div className="df-scrollX">
        <table className="df-table">
          <thead><tr>
            <th className="df-h df-h--sticky">Factor</th>
            {headers.map(h => <th key={h} className="df-h">{h}</th>)}
          </tr></thead>
          <tbody>
            <tr>
              <td className="df-r df-r--sticky">Link Ratio (LDF)</td>
              {(pattern || []).map((v, i) => {
                const overFull = editable && hasConservative
                  && Number.isFinite(Number(v)) && Number.isFinite(Number(fullLdfs[i]))
                  && Number(v) > Number(fullLdfs[i]) + OVER_FULL_EPS;
                return (
                  <td
                    key={i}
                    className="df-c"
                    title={overFull ? 'Selected factor exceeds the full-triangle factor — please verify.' : undefined}
                    style={overFull ? { background: 'rgba(251,146,60,0.16)' } : undefined}
                  >{editable
                    ? <input
                        className="df-input"
                        value={fmt4(v)}
                        onChange={e => onChange?.('ldf', i, e.target.value)}
                        style={overFull ? { borderColor: 'rgba(251,146,60,0.8)', color: '#fbbf24' } : undefined}
                      />
                    : <div className="df-val">{fmt4(v)}</div>}</td>
                );
              })}
            </tr>
            <tr>
              <td className="df-r df-r--sticky">Cumulative (CDF)</td>
              {(cdfs || []).slice(0, N).map((v, i) => (
                <td key={i} className="df-c">{editable
                  ? <input className="df-input" value={fmt4(v)} onChange={e => onChange?.('cdf', i, e.target.value)} />
                  : <div className="df-val">{fmt4(v)}</div>}</td>
              ))}
            </tr>
            {hasConservative && (<>
              <tr title="What this factor would be on the full (unstripped) triangle — reference only.">
                <td className="df-r df-r--sticky" style={refStyle}>Incl. L/C — LDF (ref)</td>
                {Array.from({ length: N }, (_, i) => (
                  <td key={i} className="df-c"><div className="df-val" style={refStyle}>{fmt4(fullLdfs[i])}</div></td>
                ))}
              </tr>
              <tr title="Cumulative factor on the full (unstripped) triangle — reference only.">
                <td className="df-r df-r--sticky" style={refStyle}>Incl. L/C — CDF (ref)</td>
                {Array.from({ length: N }, (_, i) => (
                  <td key={i} className="df-c"><div className="df-val" style={refStyle}>{fmt4((fullCdfs || [])[i])}</div></td>
                ))}
              </tr>
            </>)}
          </tbody>
        </table>
      </div>
    </div>
  );
}
