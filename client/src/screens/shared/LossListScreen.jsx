import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { api } from '../../api';
import { useContractId } from '../../hooks/useContractId';
import { useAppState } from '../../context/AppContext';
import WizardLayout from '../../components/WizardLayout';
import LoadErrorPanel from '../../components/LoadErrorPanel';
import { parseFlexibleNumber, dateInputValue } from '../../utils/format';
import LossAnalysisModal from './LossAnalysisModal';
import { logger } from '../../utils/logger';

const COLS = [
  // UW Year leads — it's the origin-year key stripping joins the triangle on.
  // The underwriter fills it in; it also auto-derives from Date of Loss when
  // left blank, but a typed/pasted value overrides the auto-calc.
  { key: 'uwYear',      label: 'UW Year',        type: 'year', w: 90 },
  { key: 'insuredName', label: 'Insured Name', type: 'text', w: 180 },
  { key: 'lossName',    label: 'Loss / Event',  type: 'text', w: 160 },
  { key: 'dateOfLoss',  label: 'Date of Loss',  type: 'date', w: 120 },
  // The actuarial-reported-date column and its "Map to quarters" Suggest
  // feature were removed from the UI: losses are now stripped outside the tool,
  // so per-loss in-tool placement is no longer entered by hand. The field still
  // round-trips (emptyRow / load map / save payload) and a blank value falls
  // back to the loss-date proxy server-side, so any already-saved value keeps
  // placing its loss precisely.
  { key: 'classOfBusiness', label: 'Class',      type: 'cob',  w: 140 },
  { key: 'paid',        label: 'Paid',           type: 'num',  w: 110 },
  { key: 'os',          label: 'O/S',            type: 'num',  w: 110 },
];

// UW Year auto-derivation: loss year (when not entered manually).
function yearOf(dateStr) {
  const m = /^(\d{4})/.exec(String(dateStr || '').trim());
  return m ? m[1] : '';
}
function deriveUwYear(row) {
  return yearOf(row.dateOfLoss) || '';
}

function emptyRow() { return { lossId: '', reportedDate: '', actuarialReportedDate: '', uwYear: '', uwYearManual: false, insuredName: '', lossName: '', dateOfLoss: '', classOfBusiness: '', paid: '', os: '' }; }

// COB dropdown cell — shows treaty classes, flags unknowns, supports paste
function CobCell({ value, cobOptions, onChange, onPaste, dataRow, dataCol }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  const inputRef = useRef(null);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handler = e => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const isUnknown = value && cobOptions.length > 0 && !cobOptions.some(c => c.name === value);

  return (
    <div ref={ref} style={{ position: 'relative', width: '100%' }}>
      {/* Hidden input — only purpose is to receive paste events with correct data-row/col */}
      <input
        ref={inputRef}
        readOnly
        data-row={dataRow}
        data-col={dataCol}
        onPaste={onPaste}
        style={{ position: 'absolute', opacity: 0, width: 0, height: 0, pointerEvents: 'none' }}
        tabIndex={-1}
      />
      <div
        role="button"
        tabIndex={0}
        aria-expanded={open}
        onClick={() => { setOpen(o => !o); inputRef.current?.focus(); }}
        onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpen(o => !o); inputRef.current?.focus(); } }}
        style={{
          display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer',
          padding: '4px 6px', borderRadius: 4, fontSize: 12, minHeight: 28,
          background: isUnknown ? 'rgba(251,191,36,0.12)' : 'transparent',
          border: isUnknown ? '1px solid rgba(251,191,36,0.4)' : '1px solid var(--hairline)',
          color: isUnknown ? 'var(--accent-amber)' : value ? 'var(--text)' : 'rgba(var(--text-rgb),.4)',
        }}
        title={isUnknown ? `"${value}" is not in the treaty's class of business list` : ''}
        onPaste={e => { if (onPaste) { e.target.dataset.row = dataRow; e.target.dataset.col = dataCol; onPaste(e); } }}
      >
        {isUnknown && <span style={{ fontSize: 10 }}>⚠</span>}
        <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {value || 'Select…'}
        </span>
        <span style={{ fontSize: 9, opacity: 0.5 }}>▾</span>
      </div>
      {open && (
        <div style={{
          position: 'absolute', top: '100%', left: 0, zIndex: 999,
          minWidth: 200, maxHeight: 220, overflowY: 'auto',
          background: 'var(--surface-elevated)', border: '1px solid var(--hairline-strong)',
          borderRadius: 6, boxShadow: '0 8px 24px rgba(0,0,0,0.5)',
        }}>
          {cobOptions.length === 0 ? (
            <div style={{ padding: '8px 12px', fontSize: 11, color: 'rgba(var(--text-rgb),.7)' }}>
              No classes on treaty — add in Treaty Detail
            </div>
          ) : (
            <>
              <div
                role="button"
                tabIndex={0}
                onClick={() => { onChange(''); setOpen(false); }}
                onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onChange(''); setOpen(false); } }}
                style={{ padding: '7px 12px', fontSize: 12, color: 'rgba(var(--text-rgb),.7)', cursor: 'pointer', borderBottom: '1px solid var(--hairline)' }}
              >
                — Clear —
              </div>
              {cobOptions.map(c => (
                <div
                  key={c.id}
                  role="button"
                  tabIndex={0}
                  onClick={() => { onChange(c.name); setOpen(false); }}
                  onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onChange(c.name); setOpen(false); } }}
                  style={{
                    padding: '7px 12px', fontSize: 12, cursor: 'pointer',
                    background: value === c.name ? 'rgba(0,232,184,0.12)' : 'transparent',
                    color: value === c.name ? 'var(--accent)' : 'var(--text)',
                  }}
                  onMouseEnter={e => e.currentTarget.style.background = 'var(--surface-hover)'}
                  onMouseLeave={e => e.currentTarget.style.background = value === c.name ? 'rgba(0,232,184,0.12)' : 'transparent'}
                >
                  {c.name}
                </div>
              ))}
            </>
          )}
          {/* Allow freetext not in list */}
          {isUnknown && (
            <div style={{ padding: '6px 12px', borderTop: '1px solid var(--hairline)', fontSize: 10, color: 'var(--accent-amber)' }}>
              ⚠ Current value "{value}" not in treaty classes
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function parseNum(v) { return parseFlexibleNumber(v) || 0; }

function incurred(r) { return parseNum(r.paid) + parseNum(r.os); }

function fmtN(n) { return n === 0 ? '–' : n.toLocaleString('en-US', { maximumFractionDigits: 0 }); }
function fmtInput(v) { const n = parseNum(v); return n === 0 && String(v ?? '').trim() === '' ? '' : n.toLocaleString('en-US', { maximumFractionDigits: 0 }); }

function NumCell({ value, onChange, onPaste, dataRow, dataCol }) {
  const [editing, setEditing] = React.useState(false);
  const [raw, setRaw] = React.useState('');
  return (
    <input className="ll-inp ll-inp--num" type="text"
      value={editing ? raw : fmtInput(value)}
      placeholder="0" data-row={dataRow} data-col={dataCol}
      onFocus={() => { setEditing(true); setRaw(String(value ?? '').replace(/,/g, '')); }}
      onChange={e => { setRaw(e.target.value); onChange(e.target.value); }}
      onBlur={() => setEditing(false)}
      onPaste={onPaste} />
  );
}

function isRowEmpty(r) {
  return !r.insuredName && !r.lossName && !r.dateOfLoss && !r.classOfBusiness && !r.paid && !r.os;
}

const MIN_ROWS = 5;

export default function LossListScreen({ routeKey, title, headerPill, lossType = 'large', quoteMode: quoteModeprop, pageClass = '' }) {
  const { state: appState } = useAppState();
  // quoteMode: prop override wins; otherwise read from global app state
  const quoteMode = quoteModeprop !== undefined ? quoteModeprop : !!appState.quoteMode;
  const contractId = useContractId();
  const [rows, setRows] = useState(() => Array.from({ length: MIN_ROWS }, emptyRow));
  const [reportDate, setReportDate] = useState('');
  const [dirty, setDirty] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState(null);
  const [saveMsg, setSaveMsg] = useState(null);
  const [showAnalysis, setShowAnalysis] = useState(false);
  // Server-side losses (fully populated, with loss_id and reported_date) —
  // kept separately for the analysis modal so we don't tangle it with the
  // editable grid state.
  const [serverLosses, setServerLosses] = useState([]);
  const tableRef = useRef(null);

  const loadFn = lossType === 'cat' ? api.getCatLosses : api.getLargeLosses;
  const saveFn = lossType === 'cat' ? api.saveCatLosses : api.saveLargeLosses;

  // COB options: treaty classes from AppState + server junction fallback.
  // NP quote mode uses npTreatyDetail.classIds; proportional uses
  // propTreatyDetail.classIds. If the user lands directly on this screen,
  // refresh /cobs so the loss-list class dropdown still follows the
  // persisted treaty-detail COB selection.
  const [allCobs, setAllCobs] = useState([]);
  const [serverCobs, setServerCobs] = useState([]);
  const isNpMode = quoteMode || appState.wizardMode === 'NP';
  const treatyClassIds = useMemo(() => {
    const detail = isNpMode ? appState.npTreatyDetail : appState.propTreatyDetail;
    return (detail?.classIds || detail?.class_ids || []).map(String);
  }, [isNpMode, appState.npTreatyDetail, appState.propTreatyDetail]);
  useEffect(() => {
    api.listClassOfBusiness().then(list => {
      if (Array.isArray(list)) setAllCobs(list);
    }).catch(() => {});
  }, []);
  useEffect(() => {
    if (!contractId) { setServerCobs([]); return; }
    api.getContractCobs(contractId, quoteMode ? { quote: true } : undefined)
      .then(rows => setServerCobs(Array.isArray(rows) ? rows : []))
      .catch(() => setServerCobs([]));
  }, [contractId, quoteMode]);
  // Only show COBs that are linked to this treaty; if none linked, show all
  const cobOptions = useMemo(() => {
    const serverIds = serverCobs
      .map(c => c.id || c.class_of_business_id || c.cob_id)
      .filter(Boolean)
      .map(String);
    const linkedIds = treatyClassIds.length ? treatyClassIds : serverIds;
    if (linkedIds.length) {
      const filtered = allCobs.filter(c => linkedIds.includes(String(c.id)));
      if (filtered.length) return filtered;
      return serverCobs.map((c, i) => ({
        id: c.id || c.class_of_business_id || c.cob_id || `server-cob-${i}`,
        name: c.name || c.cob_name || c.class_of_business || c.label || c.code || `Class ${i + 1}`,
        code: c.code || '',
      }));
    }
    return allCobs;
  }, [allCobs, treatyClassIds, serverCobs]);

  // Report date is only set from saved server data (in loadData below).
  // Do NOT auto-populate from inception — new treaties should start with a blank date.

  // Load data
  const loadData = useCallback(async () => {
    if (!contractId) { setRows(Array.from({ length: MIN_ROWS }, emptyRow)); return; }
    setLoading(true);
    setLoadError(null);
    try {
      const data = await loadFn(contractId, quoteMode ? { quote: true } : undefined);
      const losses = data?.losses || data?.rows || [];
      setServerLosses(losses);
      if (losses.length > 0) {
        const loaded = losses.map(l => {
          const dateOfLoss = dateInputValue(l.date_of_loss || l.dateOfLoss || '');
          const uwYear = (l.uw_year ?? l.uwYear) != null ? String(l.uw_year ?? l.uwYear) : '';
          const derived = yearOf(dateOfLoss) || '';
          return {
            lossId: l.loss_id || l.lossId || '',
            reportedDate: dateInputValue(l.reported_date || l.reportedDate || ''),
            actuarialReportedDate: dateInputValue(l.actuarial_reported_date || l.actuarialReportedDate || ''),
            uwYear,
            // Treat a stored UW year that differs from the derived value as a
            // manual override so editing the date of loss won't clobber it.
            uwYearManual: !!uwYear && uwYear !== derived,
            insuredName: l.insured_name || l.insuredName || '',
            lossName: l.loss_name || l.lossName || '',
            dateOfLoss,
            classOfBusiness: l.class_of_business || l.classOfBusiness || '',
            paid: l.paid != null && l.paid !== 0 ? String(l.paid) : '',
            os: l.os != null && l.os !== 0 ? String(l.os) : '',
          };
        });
        // Pad to MIN_ROWS
        while (loaded.length < MIN_ROWS) loaded.push(emptyRow());
        setRows(loaded);
        setDirty(false);
      } else {
        // New treaty or no data: start with blank rows
        setRows(Array.from({ length: MIN_ROWS }, emptyRow));
        setDirty(false);
      }
      if (data?.report?.report_date || data?.report_date) {
        setReportDate(dateInputValue(data?.report?.report_date || data?.report_date));
      }
      setSaveMsg({ type: 'ok', text: `Loaded ${losses.length} records` });
      setTimeout(() => setSaveMsg(null), 2000);
    } catch (e) {
      // Surface the failure instead of silently leaving an empty grid the user
      // could overwrite the server's good data with. Save is disabled while
      // loadError is set (see below); Retry re-runs loadData.
      logger.warn('Load losses:', e);
      setLoadError(e);
    }
    setLoading(false);
  }, [contractId, loadFn, quoteMode]);

  useEffect(() => { loadData(); }, [loadData]);

  // Save
  const save = useCallback(async () => {
    if (!contractId) return true;
    // Never persist over a failed load — the grid may not reflect server state.
    if (loadError) { setSaveMsg({ type: 'error', text: 'Cannot save: loss data failed to load. Retry first.' }); return false; }
    const payload = rows.filter(r => !isRowEmpty(r)).map(r => ({
      loss_id: r.lossId || null,
      // Actuarial reporting date drives where the loss is stripped from
      // (nullable → server falls back to date_of_loss + a quarter). The
      // "saved in Universe" date (reported_date) is set server-side from the
      // report date, so it isn't sent from here.
      actuarial_reported_date: r.actuarialReportedDate || null,
      insured_name: r.insuredName, loss_name: r.lossName,
      // Underwriting year drives which triangle row the loss strips from.
      uw_year: r.uwYear ? Number(String(r.uwYear).replace(/[^0-9]/g, '')) || null : null,
      date_of_loss: dateInputValue(r.dateOfLoss) || null, class_of_business: r.classOfBusiness,
      paid: parseNum(r.paid), os: parseNum(r.os), incurred: incurred(r),
    }));
    try {
      await saveFn(contractId, { losses: payload, report_date: reportDate }, quoteMode ? { quote: true } : undefined);
      setDirty(false);
      setSaveMsg({ type: 'ok', text: `Saved ${payload.length} records` });
      setTimeout(() => setSaveMsg(null), 2500);
      // Reload to pick up authoritative loss_id / reported_date for new rows.
      loadData();
      return true;
    } catch (e) {
      logger.error('Save losses:', e);
      setSaveMsg({ type: 'err', text: 'Save failed' });
      setTimeout(() => setSaveMsg(null), 3000);
      return false;
    }
  }, [contractId, rows, saveFn, reportDate, quoteMode, loadData, loadError]);

  // Clear
  const clear = () => {
    setRows(Array.from({ length: MIN_ROWS }, emptyRow));
    setDirty(true);
  };

  // Paste handler — auto-expands rows
  const handlePaste = useCallback((e) => {
    const text = e.clipboardData?.getData('text/plain');
    if (!text) return;
    e.preventDefault();
    const target = e.target;
    const ri = parseInt(target.dataset.row, 10);
    const ci = parseInt(target.dataset.col, 10);
    if (isNaN(ri) || isNaN(ci)) return;
    // Excel / Sheets on Windows emits CRLF; split on \r?\n and trim any
    // stray \r so it doesn't end up baked into the last cell of each row
    // (which silently breaks date parsing and isRowEmpty checks).
    const pastedRows = text.split(/\r?\n/).filter(l => l.trim());
    setRows(prev => {
      const n = [...prev];
      pastedRows.forEach((line, pr) => {
        const cells = line.replace(/\r$/, '').split('\t');
        const rowIdx = ri + pr;
        // Auto-expand
        while (n.length <= rowIdx) n.push(emptyRow());
        cells.forEach((val, pc) => {
          const colIdx = ci + pc;
          if (colIdx < COLS.length) {
            let v = val.trim();
            const key = COLS[colIdx].key;
            // Normalize date values on paste
            if ((key === 'dateOfLoss' || key === 'actuarialReportedDate') && v) v = dateInputValue(v);
            n[rowIdx] = { ...n[rowIdx], [key]: v };
            // A pasted UW year is a manual override.
            if (key === 'uwYear') n[rowIdx].uwYearManual = String(v).trim() !== '';
          }
        });
        // Auto-derive UW year for rows where it wasn't pasted manually.
        if (!n[rowIdx].uwYearManual) {
          const d = deriveUwYear(n[rowIdx]);
          if (d) n[rowIdx] = { ...n[rowIdx], uwYear: d };
        }
      });
      // Ensure minimum trailing empty rows
      let lastFilled = n.length - 1;
      while (lastFilled >= 0 && isRowEmpty(n[lastFilled])) lastFilled--;
      const needed = Math.max(MIN_ROWS, lastFilled + 3);
      while (n.length < needed) n.push(emptyRow());
      return n;
    });
    setDirty(true);
  }, []);

  // Auto-add row when typing in last row
  const handleChange = (idx, field, val) => {
    const v = (field === 'dateOfLoss' || field === 'actuarialReportedDate')
      ? dateInputValue(val) || val
      : val;
    setRows(prev => {
      const n = [...prev];
      const row = { ...n[idx], [field]: v };
      if (field === 'uwYear') {
        // A typed UW year is a manual override; clearing it re-enables auto.
        row.uwYearManual = String(v).trim() !== '';
        if (!row.uwYearManual) row.uwYear = deriveUwYear(row);
      } else if (field === 'dateOfLoss' && !row.uwYearManual) {
        row.uwYear = deriveUwYear(row) || row.uwYear;
      }
      n[idx] = row;
      if (idx >= n.length - 2 && val) { while (n.length < idx + 3) n.push(emptyRow()); }
      return n;
    });
    setDirty(true);
  };

  // Total
  const totalPaid = rows.reduce((a, r) => a + parseNum(r.paid), 0);
  const totalOS = rows.reduce((a, r) => a + parseNum(r.os), 0);
  const totalInc = totalPaid + totalOS;
  const filledCount = rows.filter(r => !isRowEmpty(r)).length;
  const unknownCobCount = useMemo(() =>
    rows.filter(r => !isRowEmpty(r) && r.classOfBusiness &&
      cobOptions.length > 0 && !cobOptions.some(c => c.name === r.classOfBusiness)
    ).length,
  [rows, cobOptions]);

  return (
    <WizardLayout routeKey={routeKey} title={title} headerPill={headerPill}
      onBeforeNext={save} onBeforeBack={save}>
      {() => (
        <div className={`LOSS_LIST_PAGE ${pageClass}`}>
          {/* Toolbar */}
          <div className="ll-toolbar">
            <div className="ll-toolbar-left">
              <div className="ll-report-date">
                <span className="ll-label">Report Date</span>
                <input type="date" className="ll-date-input"
                  value={reportDate}
                  onChange={e => { setReportDate(e.target.value); setDirty(true); }} />
              </div>
              <div className="ll-count">{filledCount} record{filledCount !== 1 ? 's' : ''}</div>
              {unknownCobCount > 0 && (
                <div style={{ display:'flex', alignItems:'center', gap:5, padding:'3px 10px',
                  borderRadius:5, background:'rgba(251,191,36,0.12)', border:'1px solid rgba(251,191,36,0.35)',
                  fontSize:11, color:'var(--accent-amber)', fontWeight:600 }}>
                  ⚠ {unknownCobCount} row{unknownCobCount !== 1 ? 's' : ''} with unrecognised class
                </div>
              )}
            </div>
            <div className="ll-toolbar-right">
              {saveMsg && <span className={`ll-msg ll-msg--${saveMsg.type}`}>{saveMsg.text}</span>}
              <button className="ll-btn ll-btn--analysis"
                onClick={() => setShowAnalysis(true)}
                disabled={serverLosses.length === 0}
                title={serverLosses.length === 0 ? 'Save losses first to enable analysis' : 'Compare losses across reports'}
                style={{ opacity: serverLosses.length === 0 ? 0.5 : 1 }}>
                📊 Loss Analysis
              </button>
              <button className="ll-btn ll-btn--load" onClick={loadData} title="Reload from server">⟳ Load</button>
              <button className="ll-btn ll-btn--clear" onClick={clear} title="Clear all rows" disabled={!!loadError}>✕ Clear</button>
              <button
                className={`ll-btn ll-btn--save ${dirty ? 'll-btn--dirty' : ''}`}
                onClick={save}
                disabled={!!loadError}
                title={loadError ? 'Loss data failed to load — retry before saving' : 'Save to server'}
              >💾 Save</button>
            </div>
          </div>

          {loadError && (
            <LoadErrorPanel
              message="Couldn’t load saved losses. Saving is disabled to avoid overwriting server data with a blank grid."
              onRetry={loadData}
            />
          )}

          {loading ? (
            <div className="ll-loading">Loading...</div>
          ) : (
            <div className="ll-table-wrap" ref={tableRef}>
              <table className="ll-table">
                <thead>
                  <tr>
                    <th className="ll-th ll-th--num">#</th>
                    {COLS.map(c => <th key={c.key} className="ll-th" style={{ minWidth: c.w }}>{c.label}</th>)}
                    <th className="ll-th ll-th--calc">Incurred</th>
                    <th className="ll-th" style={{ minWidth: 100 }} title="Saved in Universe — mirrors the loss-list report date. Set automatically on save.">Saved</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r, i) => {
                    const inc = incurred(r);
                    const empty = isRowEmpty(r);
                    return (
                      <tr key={i} className={empty ? 'll-row--empty' : ''}>
                        <td className="ll-td ll-td--num">{i + 1}</td>
                        {COLS.map((c, ci) => (
                          <td key={c.key} className="ll-td">
                            {c.type === 'num' ? (
                              <NumCell value={r[c.key]} onChange={v => handleChange(i, c.key, v)}
                                onPaste={handlePaste} dataRow={i} dataCol={ci} />
                            ) : c.type === 'cob' ? (
                              <CobCell
                                value={r[c.key] || ''}
                                cobOptions={cobOptions}
                                onChange={v => handleChange(i, c.key, v)}
                                onPaste={handlePaste}
                                dataRow={i} dataCol={ci}
                              />
                            ) : (
                              <input
                                className="ll-inp"
                                type={c.type === 'date' ? 'date' : c.type === 'year' ? 'number' : 'text'}
                                value={r[c.key] || ''}
                                data-row={i} data-col={ci}
                                onChange={e => handleChange(i, c.key, e.target.value)}
                                onPaste={handlePaste}
                                placeholder=""
                              />
                            )}
                          </td>
                        ))}
                        <td className="ll-td ll-td--calc">{inc > 0 ? fmtN(inc) : '–'}</td>
                        <td className="ll-td" style={{ fontSize: 11, color: empty ? 'rgba(var(--text-rgb),.35)' : 'rgba(var(--text-rgb),.55)' }}>
                          {empty ? '' : (r.reportedDate || (r.lossId ? '—' : <span style={{ color: 'var(--accent)' }}>on save</span>))}
                        </td>
                      </tr>
                    );
                  })}
                  {/* Totals */}
                  <tr className="ll-total">
                    <td className="ll-td ll-td--num"></td>
                    {/* # + 7 data cols + Incurred + Saved = 10 columns; the label
                        spans the 5 non-numeric data cols so the three totals land
                        under Paid / O/S / Incurred. */}
                    <td className="ll-td" colSpan={5}><span className="ll-total-label">Total</span></td>
                    <td className="ll-td ll-td--calc">{fmtN(totalPaid)}</td>
                    <td className="ll-td ll-td--calc">{fmtN(totalOS)}</td>
                    <td className="ll-td ll-td--calc ll-td--total">{fmtN(totalInc)}</td>
                    <td className="ll-td"></td>
                  </tr>
                </tbody>
              </table>
            </div>
          )}
          {showAnalysis && (
            <LossAnalysisModal
              losses={serverLosses}
              lossType={lossType}
              onClose={() => setShowAnalysis(false)}
            />
          )}
        </div>
      )}
    </WizardLayout>
  );
}
