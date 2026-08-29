// client/src/screens/workbench/FormulaWorkbench.jsx
//
// Index page for the Actuarial Formula Workbench. Shows one card per
// formula in FORMULA_CATALOG. Cards display:
//   • formula label + module
//   • #parameters and #pending-approval (from the server)
//   • a "needs review" flag when the JS-file source is still
//     "Internal benchmark — placeholder" (i.e. no actuarial sign-off)
//
// Clicking a card navigates to /workbench/:module/:name.

import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import Topbar from '../../components/Topbar';
import { api } from '../../api';
import { getSession, isAtLeast } from '../../utils/auth';
import { FORMULA_CATALOG } from './formulaCatalog';

function Pill({ tone = 'neutral', children }) {
  const palette = {
    neutral: { bg: 'rgba(255,255,255,.06)', border: 'rgba(255,255,255,.14)', color: 'rgba(255,255,255,.65)' },
    warn:    { bg: 'rgba(251,191,36,.10)',  border: 'rgba(251,191,36,.30)',  color: '#fbbf24' },
    ok:      { bg: 'rgba(35,209,139,.10)',  border: 'rgba(35,209,139,.30)',  color: '#23d18b' },
    info:    { bg: 'rgba(96,165,250,.10)',  border: 'rgba(96,165,250,.30)',  color: '#60a5fa' },
  }[tone] || {};
  return (
    <span style={{
      display: 'inline-block', padding: '2px 8px', borderRadius: 10,
      fontSize: 10, fontWeight: 700, letterSpacing: 0.3,
      background: palette.bg, border: `1px solid ${palette.border}`, color: palette.color,
    }}>
      {children}
    </span>
  );
}

export default function FormulaWorkbench() {
  const navigate = useNavigate();
  // getSession() JSON-parses localStorage, so it returns a NEW object on every
  // render. Effects must depend on the stable userId primitive, never the
  // object itself — an object dep re-runs the effect after every render, and
  // each fetch completion triggers a render, producing an unbounded refetch
  // loop (hundreds of requests per second until the rate limiter starves it).
  const userId = getSession()?.userId ?? null;
  const [serverFormulas, setServerFormulas] = useState([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');

  useEffect(() => {
    if (!userId) { navigate('/login'); return; }
    let mounted = true;
    api.workbenchListFormulas()
      .then(rows => { if (mounted) setServerFormulas(Array.isArray(rows) ? rows : []); })
      .catch(e => { if (mounted) setErr(e.message || 'Failed to load formula list'); })
      .finally(() => { if (mounted) setLoading(false); });
    return () => { mounted = false; };
  }, [navigate, userId]);

  const indexed = useMemo(() => {
    const map = new Map();
    serverFormulas.forEach(r => map.set(`${r.module}::${r.formula_name}`, r));
    return map;
  }, [serverFormulas]);

  const canEdit = isAtLeast(3);
  const canApprove = isAtLeast(2);

  return (
    <div style={{ minHeight: '100vh', background: 'var(--bg, #0a0e14)', color: 'rgba(255,255,255,.88)' }}>
      <Topbar title="Actuarial Formula Workbench" subtitle="Edit, propose, approve" />
      <div style={{ maxWidth: 1280, margin: '0 auto', padding: '24px 28px' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
          <div>
            <h1 style={{ fontSize: 22, margin: 0, fontWeight: 600 }}>Formulas</h1>
            <div style={{ fontSize: 12, color: 'rgba(255,255,255,.45)', marginTop: 4 }}>
              {canEdit
                ? canApprove
                  ? 'You can edit, submit and approve changes.'
                  : 'You can edit and submit changes for approval.'
                : 'You can view and comment. Editing requires Treaty Director or above.'}
            </div>
          </div>
          {err && (
            <div style={{ fontSize: 12, color: '#f87171' }}>{err}</div>
          )}
        </div>

        {loading ? (
          <div style={{ padding: 40, textAlign: 'center', color: 'rgba(255,255,255,.4)' }}>
            Loading workbench…
          </div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: 14 }}>
            {FORMULA_CATALOG.map(f => {
              const sv = indexed.get(`${f.module}::${f.name}`);
              const pending = sv?.pending_count || 0;
              const benchmarkOnly = (f.parameters || []).every(p =>
                !p.defaultMeta?.reviewed && p.defaultMeta?.source?.toLowerCase().includes('benchmark'),
              );
              return (
                <button
                  key={`${f.module}-${f.name}`}
                  onClick={() => navigate(`/workbench/${encodeURIComponent(f.module)}/${encodeURIComponent(f.name)}`)}
                  style={{
                    textAlign: 'left', padding: 16, borderRadius: 12,
                    background: 'rgba(255,255,255,.03)',
                    border: '1px solid rgba(255,255,255,.08)',
                    cursor: 'pointer', color: 'inherit',
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 10 }}>
                    <div>
                      <div style={{ fontSize: 10, color: 'rgba(255,255,255,.4)', letterSpacing: 1, marginBottom: 4 }}>
                        {f.module}
                      </div>
                      <div style={{ fontSize: 14, fontWeight: 600 }}>{f.label}</div>
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, alignItems: 'flex-end' }}>
                      {pending > 0 && <Pill tone="warn">{pending} PENDING</Pill>}
                      {benchmarkOnly && <Pill tone="info">BENCHMARK</Pill>}
                    </div>
                  </div>
                  <div style={{ marginTop: 10, fontSize: 12, color: 'rgba(255,255,255,.5)', lineHeight: 1.45 }}>
                    {f.plainEnglish}
                  </div>
                  <div style={{ marginTop: 10, display: 'flex', gap: 8, fontSize: 10, color: 'rgba(255,255,255,.4)' }}>
                    <span>{(f.parameters || []).length} parameter{(f.parameters || []).length === 1 ? '' : 's'}</span>
                    {sv?.last_updated_at && <span>· last edit {new Date(sv.last_updated_at).toLocaleDateString()}</span>}
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
