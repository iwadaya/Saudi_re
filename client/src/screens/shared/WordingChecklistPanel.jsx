import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../../api.js';
import { useGlobalToast } from '../../hooks/useToast.js';

function statusTone(status) {
  if (status === 'found') return { label: 'Present', bg: 'rgba(74,222,128,0.12)', border: 'rgba(74,222,128,0.35)', color: '#4ade80' };
  if (status === 'missing') return { label: 'Missing', bg: 'rgba(248,113,113,0.12)', border: 'rgba(248,113,113,0.35)', color: '#f87171' };
  if (status === 'partial') return { label: 'Partial', bg: 'rgba(251,191,36,0.12)', border: 'rgba(251,191,36,0.35)', color: '#fbbf24' };
  return { label: 'Not checked', bg: 'rgba(148,163,184,0.08)', border: 'rgba(148,163,184,0.18)', color: 'rgba(203,213,225,0.7)' };
}

function StatusBadge({ status }) {
  const tone = statusTone(status);
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        marginLeft: 8,
        padding: '2px 7px',
        borderRadius: 999,
        border: `1px solid ${tone.border}`,
        background: tone.bg,
        color: tone.color,
        fontSize: 10,
        fontWeight: 800,
        lineHeight: 1.2,
        whiteSpace: 'nowrap',
      }}
    >
      {tone.label}
    </span>
  );
}

function SourceBadge({ source }) {
  if (!source) return null;
  const label = source === 'ai' ? 'AI' : source === 'heuristic' ? 'Keyword' : 'Manual';
  return (
    <span
      style={{
        marginLeft: 6,
        fontSize: 9,
        fontWeight: 800,
        color: source === 'manual' ? 'rgba(255,255,255,0.4)' : 'rgba(0,232,184,0.75)',
        textTransform: 'uppercase',
        letterSpacing: 0,
      }}
    >
      {label}
    </span>
  );
}

function groupSections(items) {
  const map = new Map();
  for (const item of items || []) {
    const sectionKey = item.section_key || 'other';
    if (!map.has(sectionKey)) {
      map.set(sectionKey, {
        key: sectionKey,
        title: item.section_title || 'Checklist',
        items: [],
      });
    }
    map.get(sectionKey).items.push(item);
  }
  return Array.from(map.values());
}

function requestOptions(isQuote) {
  return isQuote ? { quote: true } : undefined;
}

export default function WordingChecklistPanel({ contractId, isQuote = false }) {
  const showToast = useGlobalToast();
  const [items, setItems] = useState([]);
  const [latestRun, setLatestRun] = useState(null);
  const [sourceDoc, setSourceDoc] = useState(null);
  const [summary, setSummary] = useState('');
  const [loading, setLoading] = useState(false);
  const [savingKey, setSavingKey] = useState('');
  const [running, setRunning] = useState(false);
  const [error, setError] = useState('');

  const applyPayload = useCallback((payload) => {
    if (Array.isArray(payload?.items)) setItems(payload.items);
    setLatestRun(payload?.latest_run || null);
    setSourceDoc(payload?.source_document || null);
    setSummary(payload?.summary || payload?.latest_run?.summary || '');
    setError(payload?.ok === false ? payload?.message || 'Checklist could not be checked.' : '');
  }, []);

  useEffect(() => {
    let cancelled = false;
    if (!contractId) return undefined;
    setLoading(true);
    setError('');
    api.getWordingChecklist(contractId, requestOptions(isQuote))
      .then(payload => { if (!cancelled) applyPayload(payload); })
      .catch(err => {
        if (!cancelled) setError(err?.message || 'Could not load wording checklist.');
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [applyPayload, contractId, isQuote]);

  const sections = useMemo(() => groupSections(items), [items]);
  const total = items.length;
  const present = items.filter(item => item.status === 'found').length;
  const missing = items.filter(item => item.status === 'missing').length;
  const partial = items.filter(item => item.status === 'partial').length;

  const saveItems = useCallback(async (rows) => {
    if (!contractId || !rows.length) return;
    const payload = await api.saveWordingChecklist(
      contractId,
      { items: rows },
      requestOptions(isQuote),
    );
    applyPayload(payload);
  }, [applyPayload, contractId, isQuote]);

  const toggle = async (item) => {
    const nextStatus = item.status === 'found' ? 'missing' : 'found';
    // Snapshot before the optimistic write so we can roll back if the
    // save throws — otherwise the row stays in the new state on screen
    // while the DB still holds the old one.
    const snapshot = items;
    setSavingKey(item.item_key);
    setError('');
    setItems(prev => prev.map(row => (
      row.item_key === item.item_key
        ? { ...row, status: nextStatus, source: 'manual', evidence: null }
        : row
    )));
    try {
      await saveItems([{ item_key: item.item_key, status: nextStatus, source: 'manual' }]);
    } catch (err) {
      setItems(snapshot);
      setError(err?.message || 'Could not save checklist item.');
      showToast("Couldn't update checklist — please retry");
    } finally {
      setSavingKey('');
    }
  };

  const clearAll = async () => {
    if (!items.length) return;
    const snapshot = items;
    setSavingKey('__all__');
    setError('');
    const rows = items.map(item => ({ item_key: item.item_key, status: 'missing', source: 'manual' }));
    setItems(prev => prev.map(row => ({ ...row, status: 'missing', source: 'manual', evidence: null })));
    try {
      await saveItems(rows);
    } catch (err) {
      setItems(snapshot);
      setError(err?.message || 'Could not clear checklist.');
      showToast("Couldn't update checklist — please retry");
    } finally {
      setSavingKey('');
    }
  };

  const runAi = async () => {
    if (!contractId) return;
    setRunning(true);
    setError('');
    try {
      const payload = await api.runWordingChecklistAi(contractId, requestOptions(isQuote));
      applyPayload(payload);
    } catch (err) {
      setError(err?.message || 'Could not run wording check.');
    } finally {
      setRunning(false);
    }
  };

  const runDoc = sourceDoc || latestRun;
  const docLabel = runDoc
    ? [runDoc.doc_type || runDoc.document_type, runDoc.title || runDoc.document_title || runDoc.file_name || runDoc.document_file_name]
      .filter(Boolean)
      .join(' - ')
    : '';

  return (
    <div className="chk-wrap">
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 10, flexWrap: 'wrap' }}>
        <div>
          <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.55)', fontWeight: 800 }}>
            {present}/{total || 0} present
            {missing > 0 && <span style={{ color: '#f87171', marginLeft: 10 }}>{missing} missing</span>}
            {partial > 0 && <span style={{ color: '#fbbf24', marginLeft: 10 }}>{partial} partial</span>}
          </div>
          <div style={{ marginTop: 4, fontSize: 11, color: 'rgba(255,255,255,0.35)' }}>
            {docLabel ? `Last checked: ${docLabel}` : 'AI checks Final Slip, then Draft Slip, then Expiring Slip.'}
          </div>
        </div>
        <div className="chk-actions">
          <button type="button" className="bbg-btn" onClick={runAi} disabled={running || loading}>
            {running ? 'Checking...' : 'AI auto-check'}
          </button>
          <button type="button" className="bbg-btn" onClick={clearAll} disabled={loading || running || savingKey === '__all__'}>
            Clear
          </button>
        </div>
      </div>

      {summary && (
        <div style={{ marginBottom: 10, padding: '8px 10px', borderRadius: 8, border: '1px solid rgba(0,232,184,0.18)', background: 'rgba(0,232,184,0.06)', color: 'rgba(209,250,229,0.82)', fontSize: 11 }}>
          {summary}
        </div>
      )}
      {error && (
        <div style={{ marginBottom: 10, padding: '8px 10px', borderRadius: 8, border: '1px solid rgba(248,113,113,0.25)', background: 'rgba(248,113,113,0.08)', color: '#fca5a5', fontSize: 11 }}>
          {error}
        </div>
      )}
      {loading && <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.45)' }}>Loading checklist...</div>}

      {!loading && sections.map(sec => (
        <div key={sec.key} className="chk-sec">
          <div className="chk-sec-title">{sec.title}</div>
          <div className="chk-grid">
            {sec.items.map(item => {
              const checked = item.status === 'found';
              const disabled = running || savingKey === item.item_key || savingKey === '__all__';
              return (
                <label key={item.item_key} className="chk-row" title={item.evidence || ''}>
                  <input
                    type="checkbox"
                    checked={checked}
                    disabled={disabled}
                    onChange={() => toggle(item)}
                  />
                  <span style={{ minWidth: 0 }}>
                    {item.label}
                    <SourceBadge source={item.source} />
                    <StatusBadge status={item.status} />
                  </span>
                </label>
              );
            })}
          </div>
        </div>
      ))}

      <div className="chk-footer">
        <span style={{ opacity: .75, fontSize: 12 }}>Saved in database for this {isQuote ? 'quote' : 'treaty'}.</span>
      </div>
    </div>
  );
}
