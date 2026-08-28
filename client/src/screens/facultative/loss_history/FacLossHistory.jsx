// src/screens/facultative/loss_history/FacLossHistory.jsx
import { useCallback, useMemo, useState } from 'react';
import api from '../../../api';
import { dateInputValue, numOrNull, formatWithCommasDecimal, sanitizeNumber, cleanNum } from '../../../utils/format';
import WizardLayout from '../../../components/WizardLayout';
import PctInput from '../../../components/PctInput';
import { useScreenSave } from '../../../hooks/useScreenSave';
import { useFacRiskId } from '../../../hooks/useContractId';
import './FacLossHistory.css';

const ROUTE_KEY = 'FAC_LOSS_HISTORY';

// The grid opens with a block of empty rows so an underwriter can paste a loss
// run straight out of Excel without clicking "add" twenty times, and grows to
// fit whatever is pasted.
const MIN_ROWS = 20;
// Trailing blanks kept below the last filled row, so there is always somewhere
// to type or paste next.
const TRAILING_BLANKS = 3;

// Editable columns in the order they appear, which is the order a pasted block
// maps onto. FGU Incurred is computed and therefore NOT here: a block copied
// with an incurred column will land it in Mitigation, so the expected order is
// spelled out above the table.
const PASTE_COLS = [
  'loss_year', 'loss_date', 'loss_description', 'cause_of_loss',
  'fgu_paid', 'fgu_outstanding', 'mitigation_measures',
];

// A blank row carries NO year. It used to default to the current one, which was
// harmless for a hand-added row but would make all twenty opening rows look
// filled to the save filter and persist twenty phantom losses.
const BLANK = () => ({ loss_year: '', loss_date: '', loss_description: '', cause_of_loss: '', fgu_paid: '', fgu_outstanding: '', mitigation_measures: '', is_open: true, _key: Math.random() });

/** A row with nothing an underwriter typed in it. */
const isRowEmpty = (r) => !String(r?.loss_year ?? '').trim()
  && !String(r?.loss_date ?? '').trim()
  && !String(r?.loss_description ?? '').trim()
  && !String(r?.cause_of_loss ?? '').trim()
  && !String(r?.mitigation_measures ?? '').trim()
  && numOrNull(r?.fgu_paid) == null
  && numOrNull(r?.fgu_outstanding) == null;

/** Pad to MIN_ROWS and keep a few blanks under the last filled row. */
function padRows(rows) {
  const out = [...rows];
  let lastFilled = out.length - 1;
  while (lastFilled >= 0 && isRowEmpty(out[lastFilled])) lastFilled--;
  const needed = Math.max(MIN_ROWS, lastFilled + 1 + TRAILING_BLANKS);
  while (out.length < needed) out.push(BLANK());
  return out;
}

export default function FacLossHistory() {
  const riskId = useFacRiskId();
  const [rows, setRows] = useState(() => padRows([]));
  // ── Exposure basis ────────────────────────────────────────────────────
  // The denominator a burning cost divides by (migration 135). Loss history
  // on its own gives a total, not a rate — and the years with no claims are
  // exactly the ones that must not be dropped, because leaving them out is
  // the commonest way a burn rate comes out too high. Keyed by year so a
  // clean year still carries an exposure.
  const [basis, setBasis] = useState({});      // { [year]: {exposure_base, premium, rate_change_pct} }
  const [assumptions, setAssumptions] = useState({ severity_trend_pct: '', experience_years: '' });

  const hydrate = useCallback((data) => {
    setRows(padRows((data || []).map(r => ({
      ...r,
      loss_year: r.loss_year || '',
      loss_date: r.loss_date ? String(r.loss_date).substring(0, 10) : '',
      fgu_paid: cleanNum(r.fgu_paid) || '',
      fgu_outstanding: cleanNum(r.fgu_outstanding) || '',
      _key: r.loss_id || Math.random(),
    }))));
  }, []);

  const saveLosses = useCallback(
    (id, state) => api.facSaveLosses(
      id,
      state.filter(r => r.loss_year || r.loss_description || numOrNull(r.fgu_paid) || numOrNull(r.fgu_outstanding)).map(r => ({
        loss_year: numOrNull(r.loss_year), loss_date: r.loss_date || null,
        loss_description: r.loss_description, cause_of_loss: r.cause_of_loss,
        fgu_paid: numOrNull(r.fgu_paid), fgu_outstanding: numOrNull(r.fgu_outstanding),
        mitigation_measures: r.mitigation_measures, is_open: r.is_open,
        // Preserve section attribution loaded from the server — the save is a
        // wipe-and-reinsert, so omitting this silently detached every loss
        // from its section.
        section_id: r.section_id ?? null,
      })),
    ),
    [],
  );

  const { save: saveLossRows, markDirty } = useScreenSave({
    entityId: riskId || '',
    load: api.facGetLosses,
    save: saveLosses,
    currentState: () => rows,
    onLoaded: hydrate,
    errorLabel: 'Loss history',
  });

  const hydrateBasis = useCallback((data) => {
    const next = {};
    for (const b of data?.basis || []) {
      next[b.loss_year] = {
        exposure_base: cleanNum(b.exposure_base) || '',
        premium: cleanNum(b.premium) || '',
        rate_change_pct: cleanNum(b.rate_change_pct) || '',
      };
    }
    setBasis(next);
    setAssumptions({
      severity_trend_pct: cleanNum(data?.severity_trend_pct) || '',
      experience_years: cleanNum(data?.experience_years) || '',
    });
  }, []);

  const saveBasis = useCallback((id, state) => api.facSaveExperience(id, {
    basis: Object.entries(state.basis)
      .filter(([, v]) => numOrNull(v.exposure_base) != null || numOrNull(v.premium) != null)
      .map(([year, v]) => ({
        loss_year: Number(year),
        exposure_base: numOrNull(v.exposure_base),
        premium: numOrNull(v.premium),
        rate_change_pct: numOrNull(v.rate_change_pct),
      })),
    severity_trend_pct: numOrNull(state.assumptions.severity_trend_pct),
    experience_years: numOrNull(state.assumptions.experience_years),
  }), []);

  const { save: saveBasisRows, markDirty: markBasisDirty } = useScreenSave({
    entityId: riskId || '',
    load: api.facGetExperience,
    save: saveBasis,
    currentState: () => ({ basis, assumptions }),
    onLoaded: hydrateBasis,
    errorLabel: 'Experience basis',
  });

  // Both entities have to land before the wizard advances.
  const save = useCallback(async () => {
    const a = await saveLossRows();
    const b = await saveBasisRows();
    return Boolean(a) && Boolean(b);
  }, [saveLossRows, saveBasisRows]);

  const setBasisCell = (year, key, value) => {
    setBasis((prev) => ({ ...prev, [year]: { ...(prev[year] || {}), [key]: value } }));
    markBasisDirty();
  };
  const setAssumption = (key, value) => {
    setAssumptions((prev) => ({ ...prev, [key]: value }));
    markBasisDirty();
  };

  const setRow = (i, k, v) => {
    // Typing in the last rows grows the grid, so there is always somewhere to
    // carry on — same as the treaty loss list.
    setRows(prev => padRows(prev.map((r, j) => j === i ? { ...r, [k]: v } : r)));
    markDirty();
  };
  const addRow = () => { setRows(prev => [...prev, BLANK()]); markDirty(); };
  const removeRow = i => { setRows(prev => padRows(prev.filter((_, j) => j !== i))); markDirty(); };
  const clearRows = () => { setRows(padRows([])); markDirty(); };

  // ── Paste ─────────────────────────────────────────────────────────────
  // One handler on the table body rather than per input: the origin cell comes
  // from data-row/data-col on the target, and the block grows the grid to fit.
  // Excel and Sheets on Windows emit CRLF, so rows split on /\r?\n/ and any
  // stray \r is trimmed — left in, it silently breaks date parsing and makes
  // the last cell of every row look non-empty.
  const handlePaste = useCallback((e) => {
    const text = e.clipboardData?.getData('text/plain');
    if (!text) return;
    const ri = parseInt(e.target?.dataset?.row, 10);
    const ci = parseInt(e.target?.dataset?.col, 10);
    if (Number.isNaN(ri) || Number.isNaN(ci)) return; // not a grid cell — let it through
    const lines = text.split(/\r?\n/).filter((l) => l.trim());
    // A single cell with no tabs is an ordinary paste; leave the browser to it
    // so pasting one value into one field behaves as expected.
    if (lines.length === 1 && !lines[0].includes('\t')) return;
    e.preventDefault();

    setRows((prev) => {
      const next = [...prev];
      lines.forEach((line, pr) => {
        const cells = line.replace(/\r$/, '').split('\t');
        const rowIdx = ri + pr;
        while (next.length <= rowIdx) next.push(BLANK());
        cells.forEach((raw, pc) => {
          const key = PASTE_COLS[ci + pc];
          if (!key) return; // past the last editable column
          let v = String(raw).trim();
          if (key === 'loss_date') v = dateInputValue(v) || '';
          // Money arrives with thousands separators and sometimes a currency
          // symbol; the inputs hold bare digits.
          if (key === 'fgu_paid' || key === 'fgu_outstanding') v = sanitizeNumber(v);
          if (key === 'loss_year') v = v.replace(/[^\d]/g, '');
          next[rowIdx] = { ...next[rowIdx], [key]: v };
        });
        // A pasted date with no year fills the year in, since the 10-year
        // matrix buckets on it and a loss with no year silently disappears.
        const r = next[rowIdx];
        if (!String(r.loss_year ?? '').trim() && r.loss_date) {
          const y = Number(String(r.loss_date).slice(0, 4));
          if (Number.isFinite(y) && y > 1900) next[rowIdx] = { ...r, loss_year: String(y) };
        }
      });
      return padRows(next);
    });
    markDirty();
  }, [markDirty]);

  const filledRows = useMemo(() => rows.filter((r) => !isRowEmpty(r)), [rows]);
  const totalPaid = rows.reduce((s, r) => s + (numOrNull(r.fgu_paid) || 0), 0);
  const totalOS = rows.reduce((s, r) => s + (numOrNull(r.fgu_outstanding) || 0), 0);

  // ── Ten-year rolling matrix ───────────────────────────────────────────
  // Rows: current UW year + 9 prior years (always 10, even when sparse).
  // Columns: claim count, FGU paid / O/S / incurred, RI incurred, as-if
  // claim ratio. Premium-per-year isn't captured anywhere yet, so the
  // claim-ratio column shows '—' until a future change wires it in.
  const matrix = useMemo(() => {
    const thisYear = new Date().getFullYear();
    const years = Array.from({ length: 10 }, (_, i) => thisYear - i);
    const buckets = new Map(years.map((y) => [y, {
      year: y, count: 0, fguPaid: 0, fguOS: 0, fguIncurred: 0, riIncurred: 0,
    }]));
    for (const r of rows) {
      const y = Number(r.loss_year);
      if (!Number.isFinite(y)) continue;
      const b = buckets.get(y);
      if (!b) continue;
      const paid = numOrNull(r.fgu_paid) || 0;
      const os = numOrNull(r.fgu_outstanding) || 0;
      // ri_paid / ri_outstanding aren't captured by this screen yet, but
      // they may arrive through other flows — include defensively so the
      // RI incurred column is right when they exist.
      const riPaid = numOrNull(r.ri_paid) || 0;
      const riOs = numOrNull(r.ri_outstanding) || 0;
      b.count += 1;
      b.fguPaid += paid;
      b.fguOS += os;
      b.fguIncurred += paid + os;
      b.riIncurred += riPaid + riOs;
    }
    return Array.from(buckets.values()).map((b) => {
      const premium = numOrNull(basis[b.year]?.premium);
      return { ...b, claimRatio: premium && premium > 0 ? b.fguIncurred / premium : null };
    });
  }, [rows, basis]);
  const fmt0 = (n) => (Number.isFinite(n) && n !== 0 ? Math.round(n).toLocaleString('en-US') : '—');

  return (
    <WizardLayout routeKey={ROUTE_KEY} title="Loss History" headerPill="FACULTATIVE" onBeforeNext={save} onBeforeBack={save}>
      <div style={{ maxWidth: 1000, margin: '0 auto', padding: '8px 0 40px' }}>
        <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 16 }}>
          FGU (from the ground up) loss experience — minimum 3 years. Enter all material losses with details and mitigation measures taken.
        </div>

        {/* ── Ten-year matrix ── */}
        <div style={{ marginBottom: 24 }}>
          <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: '.14em',
                        textTransform: 'uppercase', color: 'rgba(var(--accent-blue-rgb),0.75)',
                        marginBottom: 10, paddingBottom: 6,
                        borderBottom: '1px solid var(--hairline)' }}>
            10-Year Loss Matrix
          </div>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
            <thead>
              <tr style={{ background: 'var(--table-head-bg)' }}>
                {['Year', 'Claims', 'FGU Paid', 'FGU O/S', 'FGU Incurred', 'Exposure (SI)', 'Premium', 'Claim Ratio'].map((h) => (
                  <th key={h} style={{ padding: '8px 10px',
                                       textAlign: h === 'Year' ? 'left' : 'right',
                                       fontSize: 9, fontWeight: 800, letterSpacing: '.10em',
                                       textTransform: 'uppercase', color: 'var(--muted)',
                                       borderBottom: '1px solid var(--hairline)',
                                       whiteSpace: 'nowrap' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {matrix.map((m) => (
                <tr key={m.year} style={{ borderBottom: '1px solid var(--hairline)' }}>
                  <td style={{ padding: '6px 10px', fontVariantNumeric: 'tabular-nums',
                                color: 'rgba(var(--text-rgb),0.80)', fontWeight: 700 }}>{m.year}</td>
                  <td style={{ padding: '6px 10px', textAlign: 'right',
                                fontVariantNumeric: 'tabular-nums',
                                color: m.count ? 'rgba(var(--text-rgb),0.85)' : 'rgba(var(--text-rgb),0.4)' }}>
                    {m.count || '—'}
                  </td>
                  <td style={{ padding: '6px 10px', textAlign: 'right',
                                fontVariantNumeric: 'tabular-nums',
                                color: m.fguPaid ? 'var(--accent-rose)' : 'rgba(var(--text-rgb),0.4)' }}>
                    {fmt0(m.fguPaid)}
                  </td>
                  <td style={{ padding: '6px 10px', textAlign: 'right',
                                fontVariantNumeric: 'tabular-nums',
                                color: m.fguOS ? 'var(--accent-amber)' : 'rgba(var(--text-rgb),0.4)' }}>
                    {fmt0(m.fguOS)}
                  </td>
                  <td style={{ padding: '6px 10px', textAlign: 'right',
                                fontVariantNumeric: 'tabular-nums',
                                fontWeight: 700,
                                color: m.fguIncurred ? 'var(--accent)' : 'rgba(var(--text-rgb),0.4)' }}>
                    {fmt0(m.fguIncurred)}
                  </td>
                  <td className="facexp-cell">
                    <input className="fi facexp-input" inputMode="decimal" aria-label={`Exposure ${m.year}`}
                           value={formatWithCommasDecimal(basis[m.year]?.exposure_base)}
                           onChange={(e) => setBasisCell(m.year, 'exposure_base', sanitizeNumber(e.target.value))} />
                  </td>
                  <td className="facexp-cell">
                    <input className="fi facexp-input--narrow" inputMode="decimal" aria-label={`Premium ${m.year}`}
                           value={formatWithCommasDecimal(basis[m.year]?.premium)}
                           onChange={(e) => setBasisCell(m.year, 'premium', sanitizeNumber(e.target.value))} />
                  </td>
                  <td className={`facexp-ratio${m.claimRatio == null ? ''
                    : m.claimRatio > 1 ? ' facexp-ratio--over' : ' facexp-ratio--set'}`}>
                    {m.claimRatio == null ? '—' : `${(m.claimRatio * 100).toFixed(0)}%`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div style={{ marginTop: 6, fontSize: 10, color: 'rgba(var(--text-rgb),0.7)' }}>
            Exposure and premium are the denominator the burning cost divides by. Enter a row for
            every year on risk — including the clean ones, which are what stop the burn rate
            coming out too high.
          </div>

          <div className="facexp-assumptions">
            <label htmlFor="fac-severity-trend" className="facexp-assumption">
              Claims inflation % p.a.
              <PctInput id="fac-severity-trend" className="fi facexp-years"
                        value={assumptions.severity_trend_pct}
                        onChange={(v) => setAssumption('severity_trend_pct', v)} />
            </label>
            <label className="facexp-assumption">
              Experience years
              <input className="fi facexp-years" type="number" min={0} max={20}
                     value={assumptions.experience_years}
                     onChange={(e) => setAssumption('experience_years', e.target.value)} />
            </label>
            <span className="facexp-hint">
              Losses are trended from their year to the current one before they are rated.
            </span>
          </div>
        </div>

        {/* The grid always shows MIN_ROWS, so the old "no losses recorded"
            empty state is unreachable — its one useful line survives as the
            hint below, next to the paste instructions. */}
        <div className="faclh-gridnote">
          Paste a block straight from Excel — click the cell to start at, then paste.
          Rows are added to fit. Columns map in this order:
          <b> Year · Date · Description · Cause · FGU Paid · FGU O/S · Mitigation</b>
          {' '}(FGU Incurred is calculated). A clean loss history is positive for pricing.
        </div>
        {(
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
            <thead>
              <tr style={{ background: 'var(--table-head-bg)' }}>
                {['Year', 'Date', 'Description', 'Cause', 'FGU Paid', 'FGU O/S', 'FGU Incurred', 'Mitigation', ''].map(h => (
                  <th key={h} style={{ padding: '8px 8px', textAlign: ['FGU Paid','FGU O/S','FGU Incurred'].includes(h) ? 'right' : 'left', fontSize: 9, fontWeight: 800, letterSpacing: '.10em', textTransform: 'uppercase', color: 'var(--muted)', borderBottom: '1px solid var(--hairline)', whiteSpace: 'nowrap' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody onPaste={handlePaste}>
              {rows.map((r, i) => {
                const incurred = (numOrNull(r.fgu_paid) || 0) + (numOrNull(r.fgu_outstanding) || 0);
                return (
                  <tr key={r._key} style={{ borderBottom: '1px solid var(--hairline)' }}>
                    <td style={{ padding: '4px 4px', width: 70 }}><input className="fi" type="number" data-row={i} data-col={0} value={r.loss_year} onChange={e => setRow(i, 'loss_year', e.target.value)} style={{ width: 65, fontSize: 12 }} /></td>
                    <td style={{ padding: '4px 4px', width: 120 }}><input className="fi" type="date" data-row={i} data-col={1} value={r.loss_date} onChange={e => setRow(i, 'loss_date', e.target.value)} style={{ fontSize: 11 }} /></td>
                    <td style={{ padding: '4px 4px' }}><input className="fi" data-row={i} data-col={2} value={r.loss_description || ''} onChange={e => setRow(i, 'loss_description', e.target.value)} placeholder="Loss details" style={{ fontSize: 12 }} /></td>
                    <td style={{ padding: '4px 4px', width: 110 }}><input className="fi" data-row={i} data-col={3} value={r.cause_of_loss || ''} onChange={e => setRow(i, 'cause_of_loss', e.target.value)} placeholder="Cause" style={{ fontSize: 12 }} /></td>
                    <td style={{ padding: '4px 4px', width: 110 }}><input className="fi" type="text" inputMode="decimal" data-row={i} data-col={4} value={formatWithCommasDecimal(r.fgu_paid)} onChange={e => setRow(i, 'fgu_paid', sanitizeNumber(e.target.value))} style={{ textAlign: 'right', fontSize: 12 }} /></td>
                    <td style={{ padding: '4px 4px', width: 110 }}><input className="fi" type="text" inputMode="decimal" data-row={i} data-col={5} value={formatWithCommasDecimal(r.fgu_outstanding)} onChange={e => setRow(i, 'fgu_outstanding', sanitizeNumber(e.target.value))} style={{ textAlign: 'right', fontSize: 12 }} /></td>
                    <td style={{ padding: '6px 8px', textAlign: 'right', fontVariantNumeric: 'tabular-nums', color: incurred ? 'var(--accent-amber)' : 'rgba(var(--text-rgb),0.4)', width: 110 }}>{incurred ? incurred.toLocaleString('en-US') : '—'}</td>
                    <td style={{ padding: '4px 4px', width: 140 }}><input className="fi" data-row={i} data-col={6} value={r.mitigation_measures || ''} onChange={e => setRow(i, 'mitigation_measures', e.target.value)} placeholder="Actions taken" style={{ fontSize: 11 }} /></td>
                    <td style={{ padding: '4px 4px', width: 28 }}><span role="button" tabIndex={0} aria-label="Remove loss record"
                      style={{ cursor: 'pointer', color: 'var(--accent-rose)', fontSize: 16 }}
                      onClick={() => removeRow(i)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); removeRow(i); }
                      }}>×</span></td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot>
              <tr style={{ borderTop: '2px solid rgba(var(--accent-blue-rgb),0.20)' }}>
                <td colSpan={4} style={{ padding: '8px 8px', fontSize: 11, fontWeight: 700, color: 'rgba(var(--accent-blue-rgb),0.80)' }}>TOTAL ({filledRows.length} losses)</td>
                <td style={{ padding: '8px 8px', textAlign: 'right', fontWeight: 700, color: 'var(--accent-rose)', fontSize: 12 }}>{totalPaid ? totalPaid.toLocaleString('en-US') : '—'}</td>
                <td style={{ padding: '8px 8px', textAlign: 'right', fontWeight: 700, color: 'var(--accent-amber)', fontSize: 12 }}>{totalOS ? totalOS.toLocaleString('en-US') : '—'}</td>
                <td style={{ padding: '8px 8px', textAlign: 'right', fontWeight: 900, color: 'var(--accent)', fontSize: 12 }}>{(totalPaid + totalOS) ? (totalPaid + totalOS).toLocaleString('en-US') : '—'}</td>
                <td colSpan={2}></td>
              </tr>
            </tfoot>
          </table>
        )}

        <div className="faclh-actions">
          <button type="button" className="faclh-add" onClick={addRow}>+ Add Loss Record</button>
          <button type="button" className="faclh-clear" onClick={clearRows}>Clear all rows</button>
        </div>
      </div>
    </WizardLayout>
  );
}
