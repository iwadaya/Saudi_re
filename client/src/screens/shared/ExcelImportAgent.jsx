/**
 * ExcelImportAgent.jsx
 * ─────────────────────────────────────────────────────────────────────────────
 * Standalone Universe3 screen — drop into client/src/screens/shared/
 * Add route in appRoutes.jsx:
 *   { path: '/import', component: lazy(() => import('../screens/shared/ExcelImportAgent')) }
 *
 * Reads both:
 *   • Proportional treaty Excel  (Premium Triangle, Claims Triangle, OS Claims,
 *     Large Loss Records, Cat Loss Records, Risk Profile, Claims Profile, CRESTA Zones)
 *   • NP treaty Excel            (Treaty Layers, Large Loss Records, Cat Loss Records,
 *     EGNPI, Risk Profile, Claims Profile, Cresta)
 *
 * Maps every sheet to the correct Universe3 API endpoint, shows a per-field
 * diff/preview before committing, and lets the user pick which contract to
 * import into.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { useState, useCallback, useEffect, useRef, useMemo } from 'react';
import { readWorkbook } from '../../utils/excel';
import { useAppState } from '../../context/AppContext';
import { formatWithCommas } from '../../utils/format';
import { useGlobalToast } from '../../hooks/useToast';
import useContractId from '../../hooks/useContractId';
import { parseSheet, SHEET_MAP, pushSheet } from './excelParsers';

// ── tiny helpers ──────────────────────────────────────────────────────────────
const fmt  = v => (v != null && v !== '') ? formatWithCommas(Math.round(Number(v))) : '–';
const fmtP = v => (v != null && v !== '') ? (Number(v) * (Number(v) < 1.5 ? 100 : 1)).toFixed(2) + '%' : '–';
// Value already in percent points (the app convention for NP layer rates) —
// no fraction-vs-percent guessing, which read a 1.2% rate as 120%.
const fmtPts = v => (v != null && v !== '') ? `${Number(v).toFixed(2)}%` : '–';

// ── Preview renderers ─────────────────────────────────────────────────────────
function TrianglePreview({ data }) {
  if (!data?.rows?.length) return <div className="ia-empty">No data parsed</div>;
  const cols = data.dev_years.slice(0, 8);
  return (
    <div className="ia-scroll-x">
      <table className="ia-table">
        <thead><tr>
          <th>UW Year</th>
          {cols.map(d => <th key={d}>Dev {d}</th>)}
          {data.dev_years.length > 8 && <th>…+{data.dev_years.length - 8} more</th>}
        </tr></thead>
        <tbody>
          {data.rows.slice(0, 6).map(row => (
            <tr key={row.uw_year}>
              <td className="ia-td-key">{row.uw_year}</td>
              {cols.map((_, i) => <td key={i} className="ia-td-num">{row.values[i] != null ? fmt(row.values[i]) : '–'}</td>)}
              {data.dev_years.length > 8 && <td className="ia-td-muted">…</td>}
            </tr>
          ))}
          {data.rows.length > 6 && <tr><td colSpan={cols.length + 2} className="ia-td-muted">…and {data.rows.length - 6} more years</td></tr>}
        </tbody>
      </table>
    </div>
  );
}

function LossPreview({ data, isCat }) {
  if (!data?.length) return <div className="ia-empty">No losses found</div>;
  return (
    <div className="ia-scroll-x">
      <table className="ia-table">
        <thead><tr>
          <th>UW Year</th>
          <th>Insured</th>
          <th>{isCat ? 'Event' : 'Loss'} Name</th>
          <th>Class</th>
          <th>Paid</th>
          <th>OS</th>
          <th>Incurred</th>
        </tr></thead>
        <tbody>
          {data.slice(0, 8).map((r, i) => (
            <tr key={i}>
              <td className="ia-td-key">{r.uw_year}</td>
              <td className="ia-td-str">{(r.insured_name || '').slice(0, 28)}</td>
              <td className="ia-td-str">{(r.loss_name || r.event_name || '').slice(0, 28)}</td>
              <td><span className="ia-cob">{r.class_of_business || r.class}</span></td>
              <td className="ia-td-num">{fmt(r.paid)}</td>
              <td className="ia-td-num">{fmt(r.os)}</td>
              <td className="ia-td-num ia-td-incurred">{fmt(r.incurred)}</td>
            </tr>
          ))}
          {data.length > 8 && <tr><td colSpan={7} className="ia-td-muted">…and {data.length - 8} more rows</td></tr>}
        </tbody>
      </table>
    </div>
  );
}

function ProfilePreview({ data }) {
  if (!data?.length) return <div className="ia-empty">No profiles parsed</div>;
  return (
    <>
      {data.map((prof, pi) => (
        <div key={pi} style={{ marginBottom: pi < data.length - 1 ? 16 : 0 }}>
          <div className="ia-profile-label">{prof.label}</div>
          <div className="ia-scroll-x">
            <table className="ia-table">
              <thead><tr>
                <th>Min Band</th><th>Max Band</th><th>Policies</th>
                <th>Sum Insured</th><th>Premiums</th><th>Rate %</th>
              </tr></thead>
              <tbody>
                {prof.rows.slice(0, 6).map((r, i) => (
                  <tr key={i}>
                    <td className="ia-td-num">{fmt(r.band_min)}</td>
                    <td className="ia-td-num">{fmt(r.band_max)}</td>
                    <td className="ia-td-num">{fmt(r.num_policies)}</td>
                    <td className="ia-td-num">{fmt(r.sum_insured)}</td>
                    <td className="ia-td-num">{fmt(r.premiums)}</td>
                    <td className="ia-td-num">{fmtP(r.rate_pct / 100)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ))}
    </>
  );
}

function CrestaPreview({ data }) {
  if (!data?.length) return <div className="ia-empty">No zones parsed</div>;
  return (
    <div className="ia-scroll-x">
      <table className="ia-table">
        <thead><tr>
          <th>Zone</th><th>Name</th><th>Earthquake</th><th>Windstorm</th><th>Flood</th><th>SRCC</th><th>Others</th>
        </tr></thead>
        <tbody>
          {data.map((r, i) => (
            <tr key={i}>
              <td className="ia-td-key">{r.zone_code}</td>
              <td className="ia-td-str">{r.zone_name}</td>
              <td className="ia-td-num">{fmt(r.earthquake)}</td>
              <td className="ia-td-num">{fmt(r.windstorm)}</td>
              <td className="ia-td-num">{fmt(r.flood)}</td>
              <td className="ia-td-num">{fmt(r.srcc)}</td>
              <td className="ia-td-num">{fmt(r.others)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function NpLayersPreview({ data }) {
  if (!data?.length) return <div className="ia-empty">No layers parsed</div>;
  return (
    <div className="ia-scroll-x">
      <table className="ia-table">
        <thead><tr>
          <th>Layer</th><th>Limit</th><th>Deductible</th><th>EGNPI</th>
          <th>Rate</th><th>Earned Prem</th><th>Reinst.</th>
        </tr></thead>
        <tbody>
          {data.map((r, i) => (
            <tr key={i}>
              <td className="ia-td-key">L{r.layer_number}</td>
              <td className="ia-td-num">{fmt(r.limit)}</td>
              <td className="ia-td-num">{fmt(r.deductible)}</td>
              <td className="ia-td-num">{fmt(r.egnpi)}</td>
              <td className="ia-td-num">{fmtPts(r.rate)}</td>
              <td className="ia-td-num">{fmt(r.earned_premium)}</td>
              <td className="ia-td-num">{r.num_reinstatements}@{r.reinstatement_pct}%</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function EgnpiPreview({ data }) {
  if (!data?.length) return <div className="ia-empty">No EGNPI data</div>;
  return (
    <div className="ia-scroll-x">
      <table className="ia-table">
        <thead><tr><th>Year</th><th>EGNPI</th></tr></thead>
        <tbody>
          {data.map(r => (
            <tr key={r.year}><td className="ia-td-key">{r.year}</td><td className="ia-td-num">{fmt(r.egnpi)}</td></tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function SheetPreview({ sheet }) {
  if (!sheet?.data) return null;
  switch (sheet.type) {
    case 'triangle':      return <TrianglePreview data={sheet.data} />;
    case 'largeLosses':   return <LossPreview data={sheet.data} isCat={false} />;
    case 'catLosses':     return <LossPreview data={sheet.data} isCat={true} />;
    case 'riskProfile':
    case 'claimsProfile': return <ProfilePreview data={sheet.data} />;
    case 'cresta':        return <CrestaPreview data={sheet.data} />;
    case 'npLayers':      return <NpLayersPreview data={sheet.data} />;
    case 'egnpi':         return <EgnpiPreview data={sheet.data} />;
    default:              return <div className="ia-empty">Unknown sheet type</div>;
  }
}

function countRows(sheet) {
  if (!sheet?.data) return 0;
  if (Array.isArray(sheet.data)) {
    if (sheet.data[0]?.rows) return sheet.data.reduce((s, p) => s + p.rows.length, 0);
    return sheet.data.length;
  }
  if (sheet.data?.rows) return sheet.data.rows.length;
  return 0;
}

// ── main component ────────────────────────────────────────────────────────────
export default function ExcelImportAgent() {
  const { state: appState } = useAppState();
  const showToast = useGlobalToast();
  const contractId = useContractId();

  const [sheets, setSheets]           = useState([]);        // parsed sheets
  const [selected, setSelected]       = useState({});        // sheetName → bool
  const [expandedSheet, setExpanded]  = useState(null);
  const [contractInput, setContractInput] = useState(contractId || '');
  const [importing, setImporting]     = useState(false);
  const [results, setResults]         = useState([]);        // {name, ok, error}
  const [dragOver, setDragOver]       = useState(false);
  const [fileName, setFileName]       = useState('');
  const [detectedType, setDetectedType] = useState('');      // 'prop' | 'np' | 'mixed'
  // Which variant imported triangles land in (migration 116). MODIFIED is the
  // projected triangle (default); ACTUAL is the gross reference triangle.
  const [triangleVariant, setTriangleVariant] = useState('MODIFIED');
  const fileRef = useRef();
  const contractInputTouched = useRef(false);

  useEffect(() => {
    if (!contractInputTouched.current) setContractInput(contractId || '');
  }, [contractId]);

  const processFile = useCallback((file) => {
    if (!file) return;
    setFileName(file.name);
    setResults([]);
    const reader = new FileReader();
    reader.onload = async (e) => {
      try {
        const sheets = await readWorkbook(e.target.result);
        const parsed = [];
        for (const { name: sn, rows } of sheets) {
          // Try direct name match first, then fuzzy
          let key = Object.keys(SHEET_MAP).find(k => sn === k);
          if (!key) key = Object.keys(SHEET_MAP).find(k => sn.toLowerCase().includes(k.toLowerCase()));
          if (!key) continue;
          const sheet = parseSheet(key, rows);
          if (!sheet) continue;
          parsed.push({ ...sheet, sheetName: sn, originalKey: key });
        }
        setSheets(parsed);
        // Auto-select all
        const sel = {};
        parsed.forEach(s => { sel[s.sheetName] = true; });
        setSelected(sel);
        if (parsed.length) setExpanded(parsed[0].sheetName);
        // Detect treaty type
        const hasNp   = parsed.some(s => s.treaty === 'np');
        const hasProp = parsed.some(s => s.treaty === 'prop');
        setDetectedType(hasNp && hasProp ? 'mixed' : hasNp ? 'np' : hasProp ? 'prop' : 'both');
      } catch (err) {
        showToast('Failed to parse Excel file: ' + err.message);
      }
    };
    reader.readAsArrayBuffer(file);
  }, [showToast]);

  const onDrop = useCallback((e) => {
    e.preventDefault(); setDragOver(false);
    const file = e.dataTransfer.files[0];
    if (file?.name.match(/\.xlsx?$/i)) processFile(file);
  }, [processFile]);

  const onFileChange = useCallback((e) => {
    processFile(e.target.files[0]);
    e.target.value = '';
  }, [processFile]);

  const selectedSheets = useMemo(() => sheets.filter(s => selected[s.sheetName]), [sheets, selected]);

  const doImport = useCallback(async () => {
    if (!contractInput.trim()) { showToast('Please enter a Contract ID.'); return; }
    if (!selectedSheets.length) { showToast('No sheets selected.'); return; }
    // Resolve real class-of-business ids so profile imports can hit a
    // valid FK on the server. NP wizard owns npTreatyDetail.classIds,
    // Prop owns propTreatyDetail.classIds — fall through to whichever
    // is populated so the agent works under either entry point.
    const classIds = (appState.npTreatyDetail?.classIds
      ?? appState.npTreatyDetail?.class_ids
      ?? appState.propTreatyDetail?.classIds
      ?? appState.propTreatyDetail?.class_ids
      ?? []).map(String).filter(Boolean);
    const baseOpts = {
      ...(appState.quoteMode ? { quote: true } : {}),
      classIds,
      // Sidecar consumed by pushSheet for triangle saves only.
      variant: triangleVariant,
    };
    setImporting(true);
    setResults([]);
    const out = [];
    for (const sheet of selectedSheets) {
      try {
        await pushSheet(contractInput.trim(), sheet, baseOpts);
        out.push({ name: sheet.label, ok: true });
      } catch (err) {
        showToast(err?.message || `Failed to import ${sheet.label}`);
        out.push({ name: sheet.label, ok: false, error: err?.message || 'Failed' });
      }
      setResults([...out]);
    }
    setImporting(false);
  }, [appState.quoteMode, appState.npTreatyDetail, appState.propTreatyDetail, contractInput, selectedSheets, triangleVariant, showToast]);

  const hasFile  = sheets.length > 0;
  const allDone  = results.length > 0 && results.length === selectedSheets.length;
  const anyError = results.some(r => !r.ok);

  const TYPE_BADGE = {
    prop: { label: 'PROPORTIONAL', color: '#38bdf8' },
    np:   { label: 'NON-PROPORTIONAL', color: '#a78bfa' },
    both: { label: 'UNIVERSAL', color: '#4ade80' },
    mixed:{ label: 'MIXED', color: '#fbbf24' },
  };
  const typeBadge = TYPE_BADGE[detectedType] || TYPE_BADGE['both'];

  return (
    <>
      <style>{`
        .ia-root {
          min-height: 100vh;
          background: #080c14;
          font-family: var(--font-mono);
          color: #e2e8f0;
          padding: 32px 28px;
        }
        .ia-header {
          display: flex; align-items: flex-start; justify-content: space-between;
          margin-bottom: 28px;
        }
        .ia-title {
          font-size: 22px; font-weight: 800; letter-spacing: -.02em;
          color: #f8fafc;
        }
        .ia-subtitle {
          font-size: 11px; color: rgba(226,232,240,0.4); margin-top: 4px;
          letter-spacing: .08em; text-transform: uppercase;
        }
        .ia-badge {
          padding: 3px 12px; border-radius: 20px; font-size: 10px;
          font-weight: 800; letter-spacing: .12em; border: 1px solid;
        }

        /* drop zone */
        .ia-drop {
          border: 2px dashed rgba(255,255,255,0.12);
          border-radius: 12px;
          padding: 40px 24px;
          text-align: center;
          cursor: pointer;
          transition: all .2s;
          margin-bottom: 24px;
          background: rgba(255,255,255,0.02);
        }
        .ia-drop:hover, .ia-drop.over {
          border-color: rgba(0,212,255,0.4);
          background: rgba(0,212,255,0.04);
        }
        .ia-drop-icon { font-size: 36px; margin-bottom: 12px; }
        .ia-drop-primary { font-size: 15px; font-weight: 700; color: #e2e8f0; margin-bottom: 6px; }
        .ia-drop-sub { font-size: 11px; color: rgba(226,232,240,0.4); }
        .ia-drop-filename {
          margin-top: 10px; font-size: 12px; color: #00d4ff;
          background: rgba(0,212,255,0.08); padding: 4px 14px; border-radius: 20px;
          display: inline-block;
        }

        /* contract row */
        .ia-contract-row {
          display: flex; align-items: center; gap: 10px; margin-bottom: 20px;
        }
        .ia-input-label {
          font-size: 10px; font-weight: 700; letter-spacing: .1em;
          text-transform: uppercase; color: rgba(226,232,240,0.45); white-space: nowrap;
        }
        .ia-input {
          flex: 1; background: rgba(255,255,255,0.05);
          border: 1px solid rgba(255,255,255,0.12); border-radius: 8px;
          padding: 9px 14px; font-family: inherit; font-size: 13px;
          color: #e2e8f0; outline: none;
        }
        .ia-input:focus { border-color: rgba(0,212,255,0.4); background: rgba(0,212,255,0.04); }

        /* sheets list */
        .ia-sheets { display: flex; flex-direction: column; gap: 8px; margin-bottom: 24px; }
        .ia-sheet-row {
          border: 1px solid rgba(255,255,255,0.08); border-radius: 10px;
          overflow: hidden; background: rgba(255,255,255,0.025);
        }
        .ia-sheet-head {
          display: flex; align-items: center; gap: 10px;
          padding: 11px 16px; cursor: pointer;
          transition: background .15s;
        }
        .ia-sheet-head:hover { background: rgba(255,255,255,0.04); }
        .ia-sheet-check {
          width: 16px; height: 16px; border-radius: 4px;
          border: 1.5px solid rgba(255,255,255,0.25);
          background: transparent; cursor: pointer;
          display: flex; align-items: center; justify-content: center;
          flex-shrink: 0; transition: all .15s;
        }
        .ia-sheet-check.checked {
          background: #00d4ff; border-color: #00d4ff; color: #0a0f1a;
        }
        .ia-sheet-name { font-size: 13px; font-weight: 700; flex: 1; }
        .ia-sheet-meta { font-size: 10px; color: rgba(226,232,240,0.4); }
        .ia-sheet-rows {
          font-size: 11px; color: rgba(226,232,240,0.4);
          background: rgba(0,212,255,0.07); padding: 2px 8px; border-radius: 10px;
        }
        .ia-sheet-chevron {
          font-size: 10px; color: rgba(255,255,255,0.3);
          transition: transform .2s;
        }
        .ia-sheet-chevron.open { transform: rotate(90deg); }
        .ia-sheet-body { padding: 0 16px 16px; }

        /* table */
        .ia-scroll-x { overflow-x: auto; }
        .ia-table {
          width: 100%; border-collapse: collapse;
          font-size: 11px; min-width: 500px;
        }
        .ia-table th {
          padding: 6px 10px; text-align: right;
          font-size: 9px; font-weight: 700; letter-spacing: .09em;
          text-transform: uppercase; color: rgba(226,232,240,0.35);
          border-bottom: 1px solid rgba(255,255,255,0.07);
        }
        .ia-table th:first-child { text-align: left; }
        .ia-table td { padding: 6px 10px; border-bottom: 1px solid rgba(255,255,255,0.04); }
        .ia-table tr:last-child td { border-bottom: none; }
        .ia-td-key { color: #00d4ff; font-weight: 700; text-align: left; }
        .ia-td-num { text-align: right; font-variant-numeric: tabular-nums; }
        .ia-td-str { color: rgba(226,232,240,0.75); max-width: 180px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .ia-td-muted { color: rgba(226,232,240,0.3); font-style: italic; text-align: center; }
        .ia-td-incurred { color: #fbbf24; font-weight: 600; }
        .ia-cob {
          padding: 2px 6px; border-radius: 4px;
          background: rgba(148,163,184,0.1); font-size: 10px;
          color: rgba(226,232,240,0.6);
        }
        .ia-profile-label {
          font-size: 10px; font-weight: 700; letter-spacing: .1em;
          text-transform: uppercase; color: rgba(226,232,240,0.4);
          margin-bottom: 8px;
        }
        .ia-empty {
          padding: 12px; color: rgba(226,232,240,0.3); font-style: italic; font-size: 12px;
        }

        /* actions */
        .ia-action-row {
          display: flex; align-items: center; gap: 12px; margin-top: 8px;
        }
        .ia-btn {
          padding: 11px 28px; border-radius: 8px; border: none; cursor: pointer;
          font-family: inherit; font-size: 12px; font-weight: 800;
          letter-spacing: .08em; text-transform: uppercase; transition: all .18s;
        }
        .ia-btn--primary {
          background: linear-gradient(135deg, #00d4ff, #0090b5);
          color: #0a0f1a;
        }
        .ia-btn--primary:hover:not(:disabled) { filter: brightness(1.12); }
        .ia-btn--primary:disabled { opacity: .4; cursor: default; }
        .ia-btn--ghost {
          background: rgba(255,255,255,0.06); color: rgba(226,232,240,0.7);
          border: 1px solid rgba(255,255,255,0.1);
        }
        .ia-btn--ghost:hover { background: rgba(255,255,255,0.1); }

        /* results */
        .ia-results {
          margin-top: 20px; display: flex; flex-direction: column; gap: 6px;
        }
        .ia-result-row {
          display: flex; align-items: center; gap: 10px;
          padding: 8px 14px; border-radius: 8px; font-size: 12px;
        }
        .ia-result-row.ok { background: rgba(74,222,128,0.07); border: 1px solid rgba(74,222,128,0.15); }
        .ia-result-row.err { background: rgba(248,113,113,0.07); border: 1px solid rgba(248,113,113,0.15); }
        .ia-result-dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
        .ok .ia-result-dot { background: #4ade80; }
        .err .ia-result-dot { background: #f87171; }
        .ia-result-name { flex: 1; font-weight: 600; }
        .ia-result-status { font-size: 11px; }
        .ok .ia-result-status { color: #4ade80; }
        .err .ia-result-status { color: #f87171; }

        /* summary bar */
        .ia-summary {
          margin-top: 16px; padding: 14px 18px; border-radius: 10px;
          background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.08);
          display: flex; align-items: center; gap: 20px; font-size: 12px;
        }
        .ia-sum-stat { display: flex; flex-direction: column; gap: 2px; }
        .ia-sum-label { font-size: 9px; letter-spacing: .1em; text-transform: uppercase; color: rgba(226,232,240,0.35); }
        .ia-sum-val { font-size: 18px; font-weight: 800; }
        .ia-sum-divider { width: 1px; background: rgba(255,255,255,0.08); align-self: stretch; }

        .ia-spinner {
          display: inline-block; width: 14px; height: 14px;
          border: 2px solid rgba(255,255,255,0.2);
          border-top-color: #00d4ff; border-radius: 50%;
          animation: ia-spin .7s linear infinite; margin-right: 6px;
        }
        @keyframes ia-spin { to { transform: rotate(360deg); } }

        .ia-select-all {
          /* Reset <button> defaults so the rule below fully styles the
             rendered control (kept tabbable + keyboard-activatable). */
          background: none; border: none; padding: 0;
          font-family: inherit; font-weight: inherit;
          line-height: inherit; letter-spacing: inherit;
          font-size: 11px; color: rgba(0,212,255,0.8); cursor: pointer;
          text-decoration: underline; text-underline-offset: 2px;
        }
        .ia-type-badge {
          font-size: 10px; font-weight: 800; letter-spacing: .1em;
          padding: 3px 10px; border-radius: 6px; text-transform: uppercase;
        }
      `}</style>

      <div className="ia-root">
        {/* Header */}
        <div className="ia-header">
          <div>
            <div className="ia-title">⬆ Excel Import Agent</div>
            <div className="ia-subtitle">The Universe™ · Automated data ingestion from broker / cedant workbooks</div>
          </div>
          {detectedType && (
            <span
              className="ia-type-badge"
              style={{ background: typeBadge.color + '18', color: typeBadge.color, border: `1px solid ${typeBadge.color}30` }}
            >
              {typeBadge.label}
            </span>
          )}
        </div>

        {/* Drop zone */}
        <div
          className={`ia-drop${dragOver ? ' over' : ''}`}
          role="button"
          tabIndex={0}
          onDragOver={e => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={onDrop}
          onClick={() => fileRef.current?.click()}
          onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileRef.current?.click(); } }}
        >
          <input ref={fileRef} type="file" accept=".xlsx,.xls" style={{ display: 'none' }} onChange={onFileChange} />
          <div className="ia-drop-icon">📊</div>
          <div className="ia-drop-primary">Drop Excel workbook here or click to browse</div>
          <div className="ia-drop-sub">Supports proportional (.xlsx) and non-proportional treaty formats</div>
          {fileName && <div className="ia-drop-filename">📎 {fileName}</div>}
        </div>

        {hasFile && (
          <>
            {/* Summary bar */}
            <div className="ia-summary">
              <div className="ia-sum-stat">
                <div className="ia-sum-label">Sheets found</div>
                <div className="ia-sum-val" style={{ color: '#00d4ff' }}>{sheets.length}</div>
              </div>
              <div className="ia-sum-divider" />
              <div className="ia-sum-stat">
                <div className="ia-sum-label">Selected</div>
                <div className="ia-sum-val" style={{ color: '#4ade80' }}>{selectedSheets.length}</div>
              </div>
              <div className="ia-sum-divider" />
              <div className="ia-sum-stat">
                <div className="ia-sum-label">Total rows</div>
                <div className="ia-sum-val" style={{ color: '#fbbf24' }}>
                  {sheets.reduce((s, sh) => s + countRows(sh), 0).toLocaleString()}
                </div>
              </div>
              <div style={{ flex: 1 }} />
              <button
                type="button"
                className="ia-select-all"
                onClick={() => {
                  const allSelected = selectedSheets.length === sheets.length;
                  const s = {}; sheets.forEach(sh => { s[sh.sheetName] = !allSelected; });
                  setSelected(s);
                }}
              >
                {selectedSheets.length === sheets.length ? 'Deselect all' : 'Select all'}
              </button>
            </div>

            {/* Contract ID */}
            <div className="ia-contract-row" style={{ marginTop: 20 }}>
              <div className="ia-input-label">{appState.quoteMode ? 'Quote ID' : 'Contract ID'}</div>
              <input
                className="ia-input"
                value={contractInput}
                onChange={e => {
                  contractInputTouched.current = true;
                  setContractInput(e.target.value);
                }}
                placeholder={appState.quoteMode ? 'Quote UUID from URL or quote list' : 'Contract UUID from URL or treaty list'}
              />
            </div>

            {/* Sheet list */}
            <div className="ia-sheets">
              {sheets.map(sheet => {
                const isOpen = expandedSheet === sheet.sheetName;
                const isChecked = !!selected[sheet.sheetName];
                const rows = countRows(sheet);
                return (
                  <div key={sheet.sheetName} className="ia-sheet-row">
                    <div
                      className="ia-sheet-head"
                      role="button"
                      tabIndex={0}
                      aria-expanded={isOpen}
                      onClick={() => setExpanded(isOpen ? null : sheet.sheetName)}
                      onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setExpanded(isOpen ? null : sheet.sheetName); } }}
                    >
                      {/* checkbox */}
                      <div
                        className={`ia-sheet-check${isChecked ? ' checked' : ''}`}
                        role="checkbox"
                        aria-checked={isChecked}
                        aria-label={`Include sheet ${sheet.sheetName}`}
                        tabIndex={0}
                        onClick={e => {
                          e.stopPropagation();
                          setSelected(prev => ({ ...prev, [sheet.sheetName]: !prev[sheet.sheetName] }));
                        }}
                        onKeyDown={e => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault();
                            e.stopPropagation();
                            setSelected(prev => ({ ...prev, [sheet.sheetName]: !prev[sheet.sheetName] }));
                          }
                        }}
                      >
                        {isChecked && '✓'}
                      </div>
                      <span className="ia-sheet-name">{sheet.label}</span>
                      <span className="ia-sheet-meta">{sheet.sheetName}</span>
                      <span className="ia-sheet-rows">{rows} row{rows !== 1 ? 's' : ''}</span>
                      <span className={`ia-sheet-chevron${isOpen ? ' open' : ''}`}>▶</span>
                    </div>
                    {isOpen && (
                      <div className="ia-sheet-body">
                        <SheetPreview sheet={sheet} />
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            {/* Variant target — only when a triangle sheet is in the batch.
                On its own row so it never displaces the action-row buttons.
                Default MODIFIED; pick ACTUAL to import the gross triangle. */}
            {selectedSheets.some(s => s.type === 'triangle') && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 }}>
                <span style={{ fontSize: 12, color: 'rgba(226,232,240,0.6)' }}>Import triangles as</span>
                <div role="group" aria-label="Triangle variant" style={{ display: 'inline-flex', borderRadius: 8, overflow: 'hidden', border: '1px solid rgba(255,255,255,0.12)' }}>
                  {['MODIFIED', 'ACTUAL'].map(v => { const active = triangleVariant === v; return (
                    <button key={v} type="button" aria-pressed={active} onClick={() => setTriangleVariant(v)}
                      style={{ padding: '4px 14px', fontSize: 12, fontWeight: 600, cursor: 'pointer', border: 'none', background: active ? 'var(--accent)' : 'transparent', color: active ? 'var(--accent-contrast)' : 'rgba(226,232,240,0.6)' }}>
                      {v === 'MODIFIED' ? 'Modified' : 'Actual'}
                    </button>
                  ); })}
                </div>
              </div>
            )}

            {/* Import button */}
            <div className="ia-action-row">
              <button
                className="ia-btn ia-btn--primary"
                disabled={importing || !selectedSheets.length || !contractInput.trim()}
                onClick={doImport}
              >
                {importing && <span className="ia-spinner" />}
                {importing ? 'Importing…' : `Import ${selectedSheets.length} sheet${selectedSheets.length !== 1 ? 's' : ''} →`}
              </button>
              <button className="ia-btn ia-btn--ghost" onClick={() => { setSheets([]); setResults([]); setFileName(''); setDetectedType(''); }}>
                Clear
              </button>
              {allDone && !anyError && (
                <span style={{ fontSize: 13, color: '#4ade80', fontWeight: 700 }}>
                  ✓ All imports completed successfully
                </span>
              )}
              {allDone && anyError && (
                <span style={{ fontSize: 13, color: '#fbbf24', fontWeight: 700 }}>
                  ⚠ Completed with {results.filter(r => !r.ok).length} error(s)
                </span>
              )}
            </div>

            {/* Results */}
            {results.length > 0 && (
              <div className="ia-results">
                {results.map((r, i) => (
                  <div key={i} className={`ia-result-row ${r.ok ? 'ok' : 'err'}`}>
                    <div className="ia-result-dot" />
                    <div className="ia-result-name">{r.name}</div>
                    <div className="ia-result-status">
                      {r.ok ? '✓ Saved' : `✗ ${r.error || 'Error'}`}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </>
        )}

        {!hasFile && (
          <div style={{ padding: '40px 0', textAlign: 'center', color: 'rgba(226,232,240,0.5)', fontSize: 13 }}>
            No workbook loaded. Drop a file above to begin.
          </div>
        )}
      </div>
    </>
  );
}
