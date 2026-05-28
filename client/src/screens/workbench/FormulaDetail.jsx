// client/src/screens/workbench/FormulaDetail.jsx
//
// Per-formula detail screen. Layout (left → right):
//   • Header: label, Technical/Plain toggle, source pill
//   • Parameter editor (kind: 'number' or 'array-number')
//   • Live preview panel that re-runs the formula's preview() with the
//     edited values, so an actuary sees the impact before submitting.
//   • Pending-change banner with Approve / Reject buttons (CU/CE only)
//   • Change history (last 50 events)
//   • Comments thread (flat — V1 doesn't render replies inline)

import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import Topbar from '../../components/Topbar';
import { api } from '../../api';
import { getSession, isAtLeast, ROLE_LABELS } from '../../utils/auth';
import { findFormula } from './formulaCatalog';

function Pill({ tone = 'neutral', children, style }) {
  const palette = {
    neutral: { bg: 'rgba(255,255,255,.06)', border: 'rgba(255,255,255,.14)', color: 'rgba(255,255,255,.7)' },
    warn:    { bg: 'rgba(251,191,36,.10)',  border: 'rgba(251,191,36,.30)',  color: '#fbbf24' },
    ok:      { bg: 'rgba(35,209,139,.10)',  border: 'rgba(35,209,139,.30)',  color: '#23d18b' },
    bad:     { bg: 'rgba(248,113,113,.10)', border: 'rgba(248,113,113,.30)', color: '#f87171' },
    info:    { bg: 'rgba(96,165,250,.10)',  border: 'rgba(96,165,250,.30)',  color: '#60a5fa' },
  }[tone] || {};
  return (
    <span style={{
      display: 'inline-block', padding: '2px 8px', borderRadius: 10,
      fontSize: 10, fontWeight: 700, letterSpacing: 0,
      background: palette.bg, border: `1px solid ${palette.border}`, color: palette.color,
      ...style,
    }}>{children}</span>
  );
}

const card = {
  background: 'rgba(255,255,255,.03)',
  border: '1px solid rgba(255,255,255,.08)',
  borderRadius: 12, padding: 16,
};

const inputStyle = {
  background: 'rgba(255,255,255,.04)',
  border: '1px solid rgba(255,255,255,.12)',
  borderRadius: 6, padding: '6px 10px',
  color: 'rgba(255,255,255,.9)', fontSize: 13,
  width: '100%', boxSizing: 'border-box',
};

const btn = (variant = 'default') => {
  const v = {
    default: { bg: 'rgba(255,255,255,.06)', border: 'rgba(255,255,255,.15)', color: 'rgba(255,255,255,.85)' },
    primary: { bg: 'rgba(96,165,250,.18)',  border: 'rgba(96,165,250,.5)',   color: '#bfdbfe' },
    ok:      { bg: 'rgba(35,209,139,.18)',  border: 'rgba(35,209,139,.5)',   color: '#86efac' },
    bad:     { bg: 'rgba(248,113,113,.15)', border: 'rgba(248,113,113,.4)',  color: '#fecaca' },
  }[variant];
  return {
    padding: '6px 14px', borderRadius: 6, fontSize: 12, fontWeight: 600,
    background: v.bg, border: `1px solid ${v.border}`, color: v.color, cursor: 'pointer',
  };
};

function parseEditedValue(kind, raw) {
  if (kind === 'number') {
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  }
  if (kind === 'array-number') {
    if (Array.isArray(raw)) return raw.map(Number).filter(Number.isFinite);
    return String(raw || '')
      .split(',')
      .map(s => s.trim())
      .filter(Boolean)
      .map(Number)
      .filter(Number.isFinite);
  }
  return raw;
}

function formatJsonDelta(oldV, newV) {
  const o = JSON.stringify(oldV ?? null);
  const n = JSON.stringify(newV ?? null);
  if (o === n) return n;
  return `${o} → ${n}`;
}

export default function FormulaDetail() {
  const navigate = useNavigate();
  const { module: mod, name } = useParams();
  const session = getSession();
  const formula = findFormula(mod, name);

  const [serverData, setServerData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [explainMode, setExplainMode] = useState('plain'); // 'plain' | 'tech'
  const [editValues, setEditValues] = useState({});
  const [submitComment, setSubmitComment] = useState('');
  const [busy, setBusy] = useState(false);
  const [newCommentText, setNewCommentText] = useState('');

  const canEdit = isAtLeast(3);
  const canApprove = isAtLeast(2);

  useEffect(() => {
    if (!session) { navigate('/login'); return; }
    if (!formula) return;
    let mounted = true;
    setLoading(true);
    api.workbenchGetFormula(mod, name)
      .then(data => {
        if (!mounted) return;
        setServerData(data);
        // seed edit values from server's current_value, falling back to JS defaults
        const seed = {};
        for (const p of formula.parameters) {
          const row = (data.parameters || []).find(r => r.parameter_key === p.key);
          seed[p.key] = row?.current_value ?? p.defaultValue;
        }
        setEditValues(seed);
      })
      .catch(e => { if (mounted) setErr(e.message || 'Failed to load formula'); })
      .finally(() => { if (mounted) setLoading(false); });
    return () => { mounted = false; };
  }, [mod, name, navigate, session, formula]);

  const preview = useMemo(() => {
    if (!formula) return null;
    try {
      const parsed = {};
      for (const p of formula.parameters) {
        parsed[p.key] = parseEditedValue(p.kind, editValues[p.key] ?? p.defaultValue);
      }
      return formula.preview(parsed);
    } catch (e) {
      return { headline: `Preview error: ${e.message}`, rows: [], rowColumns: [] };
    }
  }, [formula, editValues]);

  if (!formula) {
    return (
      <div style={{ padding: 40, color: 'rgba(255,255,255,.7)' }}>
        Unknown formula: {mod}/{name}.
        <button onClick={() => navigate('/workbench')} style={{ ...btn(), marginLeft: 12 }}>Back</button>
      </div>
    );
  }

  const submitProposal = async (paramKey) => {
    if (!canEdit) return;
    setBusy(true); setErr('');
    try {
      const p = formula.parameters.find(x => x.key === paramKey);
      const proposed = parseEditedValue(p.kind, editValues[paramKey]);
      await api.workbenchSubmitParameter({
        module: mod, formula_name: name, parameter_key: paramKey,
        proposed_value: proposed,
        comment: submitComment || null,
      });
      setSubmitComment('');
      const data = await api.workbenchGetFormula(mod, name);
      setServerData(data);
    } catch (e) { setErr(e.message); }
    finally { setBusy(false); }
  };

  const decide = async (paramId, decision) => {
    if (!canApprove) return;
    setBusy(true); setErr('');
    try {
      const fn = decision === 'approve' ? api.workbenchApproveParameter : api.workbenchRejectParameter;
      await fn(paramId, submitComment || null);
      setSubmitComment('');
      const data = await api.workbenchGetFormula(mod, name);
      setServerData(data);
    } catch (e) { setErr(e.message); }
    finally { setBusy(false); }
  };

  const postComment = async () => {
    if (!newCommentText.trim()) return;
    setBusy(true); setErr('');
    try {
      await api.workbenchPostComment({ module: mod, formula_name: name, comment_text: newCommentText.trim() });
      setNewCommentText('');
      const data = await api.workbenchGetFormula(mod, name);
      setServerData(data);
    } catch (e) { setErr(e.message); }
    finally { setBusy(false); }
  };

  return (
    <div style={{ minHeight: '100vh', background: 'var(--bg, #0a0e14)', color: 'rgba(255,255,255,.88)' }}>
      <Topbar title="Formula Workbench" subtitle={formula.label} />
      <div style={{ maxWidth: 1280, margin: '0 auto', padding: '20px 28px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
          <button onClick={() => navigate('/workbench')} style={btn()}>← Back</button>
          <Pill tone="neutral">{mod}</Pill>
          <h2 style={{ fontSize: 18, margin: 0, fontWeight: 600 }}>{formula.label}</h2>
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 6, fontSize: 11 }}>
            <button
              onClick={() => setExplainMode('plain')}
              style={{ ...btn(explainMode === 'plain' ? 'primary' : 'default') }}
            >Plain English</button>
            <button
              onClick={() => setExplainMode('tech')}
              style={{ ...btn(explainMode === 'tech' ? 'primary' : 'default') }}
            >Technical</button>
          </div>
        </div>

        {Array.isArray(formula.formula) && formula.formula.length > 0 && (
          <div style={{
            ...card,
            marginBottom: 14,
            background: 'rgba(96,165,250,.04)',
            border: '1px solid rgba(96,165,250,.18)',
          }}>
            <div style={{
              fontSize: 10, letterSpacing: 0, fontWeight: 700,
              color: 'rgba(191,219,254,.7)', marginBottom: 8,
            }}>FORMULA</div>
            <pre style={{
              margin: 0,
              fontFamily: 'var(--font-mono)',
              fontSize: 12.5, lineHeight: 1.7,
              color: '#dbeafe',
              whiteSpace: 'pre-wrap', wordBreak: 'break-word',
            }}>{formula.formula.join('\n')}</pre>
          </div>
        )}

        <div style={{ ...card, marginBottom: 14, fontSize: 12, lineHeight: 1.5, color: 'rgba(255,255,255,.7)' }}>
          {explainMode === 'plain' ? formula.plainEnglish : formula.technical}
        </div>

        {err && <div style={{ ...card, marginBottom: 14, color: '#f87171', fontSize: 12 }}>{err}</div>}

        {loading || !serverData ? (
          <div style={{ padding: 40, textAlign: 'center', color: 'rgba(255,255,255,.4)' }}>Loading…</div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
            {/* ── Editor ── */}
            <div style={card}>
              <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 12 }}>Parameters</div>
              {formula.parameters.map(p => {
                const row = (serverData.parameters || []).find(r => r.parameter_key === p.key);
                const status = row?.status || 'APPROVED';
                const hasPending = !!row?.pending_value && status === 'PENDING';
                const value = editValues[p.key] ?? p.defaultValue;
                const display = p.kind === 'array-number'
                  ? (Array.isArray(value) ? value.join(', ') : String(value || ''))
                  : String(value ?? '');
                return (
                  <div key={p.key} style={{ marginBottom: 16 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                      <div style={{ fontSize: 12, color: 'rgba(255,255,255,.75)' }}>{p.label}</div>
                      {hasPending && <Pill tone="warn">PENDING</Pill>}
                      {row?.current_value === null && <Pill tone="info">JS DEFAULT</Pill>}
                    </div>
                    <input
                      type="text"
                      style={inputStyle}
                      value={display}
                      disabled={!canEdit || busy}
                      onChange={e => setEditValues(v => ({
                        ...v,
                        [p.key]: p.kind === 'array-number' ? e.target.value : e.target.value,
                      }))}
                    />
                    {p.defaultMeta?.source && (
                      <div style={{ fontSize: 10, color: 'rgba(255,255,255,.4)', marginTop: 4 }}>
                        Source: {p.defaultMeta.source}
                        {p.defaultMeta.reviewed && ` · reviewed ${p.defaultMeta.reviewed}`}
                      </div>
                    )}
                    {hasPending && (
                      <div style={{
                        marginTop: 8, padding: 8, borderRadius: 6,
                        background: 'rgba(251,191,36,.06)', border: '1px solid rgba(251,191,36,.25)',
                        fontSize: 11, color: 'rgba(255,255,255,.7)',
                      }}>
                        <div style={{ marginBottom: 6 }}>
                          Pending: <code style={{ color: '#fbbf24' }}>
                            {formatJsonDelta(row.current_value, row.pending_value)}
                          </code>
                          {row.updated_by_name && <> · proposed by {row.updated_by_name}</>}
                        </div>
                        {canApprove && (
                          <div style={{ display: 'flex', gap: 8 }}>
                            <button onClick={() => decide(row.id, 'approve')} disabled={busy} style={btn('ok')}>
                              Approve
                            </button>
                            <button onClick={() => decide(row.id, 'reject')} disabled={busy} style={btn('bad')}>
                              Reject
                            </button>
                          </div>
                        )}
                      </div>
                    )}
                    {canEdit && (
                      <div style={{ marginTop: 6 }}>
                        <button
                          onClick={() => submitProposal(p.key)}
                          disabled={busy}
                          style={btn('primary')}
                        >
                          Submit for approval
                        </button>
                      </div>
                    )}
                  </div>
                );
              })}
              {canEdit && (
                <div style={{ marginTop: 12 }}>
                  <div style={{ fontSize: 11, color: 'rgba(255,255,255,.55)', marginBottom: 4 }}>
                    Reason / comment (attached to the change log)
                  </div>
                  <input
                    type="text"
                    style={inputStyle}
                    value={submitComment}
                    placeholder="e.g. Q1 calibration to cedant data"
                    onChange={e => setSubmitComment(e.target.value)}
                  />
                </div>
              )}
            </div>

            {/* ── Preview ── */}
            <div style={card}>
              <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>Live preview</div>
              <div style={{ fontSize: 11, color: 'rgba(255,255,255,.45)', marginBottom: 10 }}>
                Edits flow through the formula in-memory so you can see the impact before submitting.
              </div>
              {preview && (
                <>
                  <div style={{
                    fontSize: 12, padding: 8, borderRadius: 6,
                    background: 'rgba(96,165,250,.06)', border: '1px solid rgba(96,165,250,.2)',
                    color: '#bfdbfe', marginBottom: 10,
                  }}>{preview.headline}</div>
                  {preview.rowColumns?.length > 0 && (
                    <div style={{ overflowX: 'auto' }}>
                      <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: 11 }}>
                        <thead>
                          <tr>
                            {preview.rowColumns.map(c => (
                              <th key={c.key} style={{
                                textAlign: 'left', padding: '6px 8px',
                                color: 'rgba(255,255,255,.4)', fontWeight: 500,
                                borderBottom: '1px solid rgba(255,255,255,.08)',
                              }}>{c.label}</th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {(preview.rows || []).map((r, i) => (
                            <tr key={i}>
                              {preview.rowColumns.map(c => (
                                <td key={c.key} style={{
                                  padding: '6px 8px', borderBottom: '1px solid rgba(255,255,255,.04)',
                                }}>
                                  {c.format ? c.format(r[c.key]) : r[c.key]}
                                </td>
                              ))}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </>
              )}
            </div>

            {/* ── History ── */}
            <div style={{ ...card, gridColumn: '1 / -1' }}>
              <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>Change history</div>
              {(serverData.history || []).length === 0 ? (
                <div style={{ fontSize: 12, color: 'rgba(255,255,255,.4)' }}>No edits yet.</div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {serverData.history.map(h => (
                    <div key={h.id} style={{
                      padding: 10, borderRadius: 8,
                      background: 'rgba(255,255,255,.02)',
                      border: '1px solid rgba(255,255,255,.06)',
                      fontSize: 11,
                    }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                          <Pill tone={
                            h.action === 'APPROVE' ? 'ok'
                              : h.action === 'REJECT' ? 'bad'
                                : 'info'
                          }>{h.action}</Pill>
                          <span style={{ color: 'rgba(255,255,255,.65)' }}>{h.parameter_key}</span>
                        </div>
                        <span style={{ color: 'rgba(255,255,255,.4)' }}>
                          {h.changed_by_name || '—'} · {new Date(h.changed_at).toLocaleString()}
                        </span>
                      </div>
                      <code style={{ color: 'rgba(255,255,255,.75)' }}>
                        {formatJsonDelta(h.old_value, h.new_value)}
                      </code>
                      {h.comment && (
                        <div style={{ marginTop: 4, color: 'rgba(255,255,255,.55)' }}>“{h.comment}”</div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* ── Comments ── */}
            <div style={{ ...card, gridColumn: '1 / -1' }}>
              <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>Discussion</div>
              <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
                <input
                  type="text"
                  style={inputStyle}
                  value={newCommentText}
                  placeholder="Leave a comment for the team — anyone can post"
                  onChange={e => setNewCommentText(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') postComment(); }}
                />
                <button onClick={postComment} disabled={busy || !newCommentText.trim()} style={btn('primary')}>Post</button>
              </div>
              {(serverData.comments || []).length === 0 ? (
                <div style={{ fontSize: 12, color: 'rgba(255,255,255,.4)' }}>No comments yet.</div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {serverData.comments.map(c => (
                    <div key={c.id} style={{
                      padding: 10, borderRadius: 8,
                      background: 'rgba(255,255,255,.02)',
                      border: '1px solid rgba(255,255,255,.06)',
                      fontSize: 12,
                    }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                        <div style={{ color: 'rgba(255,255,255,.7)' }}>
                          {c.author_name || 'Anonymous'}
                          {c.author_role && (
                            <span style={{ marginLeft: 6, fontSize: 10, color: 'rgba(255,255,255,.4)' }}>
                              ({ROLE_LABELS[c.author_role] || c.author_role})
                            </span>
                          )}
                        </div>
                        <span style={{ color: 'rgba(255,255,255,.4)', fontSize: 10 }}>
                          {new Date(c.created_at).toLocaleString()}
                        </span>
                      </div>
                      <div style={{ color: 'rgba(255,255,255,.85)' }}>{c.comment_text}</div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
