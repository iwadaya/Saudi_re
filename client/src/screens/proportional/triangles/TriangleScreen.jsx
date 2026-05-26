import { useState, useEffect, useCallback, useMemo } from 'react';
import { api } from '../../../api';
import { useContractId } from '../../../hooks/useContractId';
import { useAppState } from '../../../context/AppContext';
import WizardLayout from '../../../components/WizardLayout';

const TYPE_MAP = {
  PROP_PREMIUM_TRIANGLES: 'PREMIUM',
  PROP_CLAIMS_PAID_TRIANGLES: 'CLAIMS_PAID',
  PROP_OS_CLAIMS_TRIANGLES: 'CLAIMS_OS',
  PROP_INCURRED_CLAIMS_TRIANGLES: 'INCURRED',
};

function parseNum(v) {
  if (v == null || v === '') return null;
  let s = String(v).trim();
  const lc = s.lastIndexOf(','), ld = s.lastIndexOf('.');
  if (lc > ld && s.length - lc <= 3) s = s.replace(/[\s.]/g, '').replace(',', '.');
  else s = s.replace(/[\s,]/g, '');
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}
function fmtCell(v) {
  if (v == null || v === '') return '';
  const n = typeof v === 'number' ? v : parseNum(v);
  if (n == null) return String(v);
  return n.toLocaleString('en-US', { maximumFractionDigits: 2, minimumFractionDigits: n % 1 === 0 ? 0 : 2 });
}

export default function TriangleScreen({ routeKey, title, headerPill }) {
  const contractId = useContractId();
  const { state: appState } = useAppState();
  const triType = TYPE_MAP[routeKey] || 'PREMIUM';
  // Incurred is derived (paid + OS); the cells are not stored.
  const isDerived = triType === 'INCURRED';

  const meta = appState.triangleMeta || {};
  const startYear = meta.startYear ?? null;
  const inceptionYear = meta.inceptionYear || meta.renewalYear || new Date().getFullYear();
  const numDevYears = Math.max(1, Math.min(60, inceptionYear - startYear));
  const years = useMemo(() => Array.from({ length: numDevYears }, (_, i) => startYear + i), [numDevYears, startYear]);
  const devYears = useMemo(() => Array.from({ length: numDevYears }, (_, i) => i + 1), [numDevYears]);
  // When the wizard is editing a quote, the active id is a quote_id
  // and the API must hit /api/quotes/:id/triangles/:type. Without
  // this, saves go to the contract path and FK-fail under migration
  // 057 because the quote_id isn't a contract_id.
  const apiOpts = useMemo(
    () => (appState.quoteMode ? { quote: true } : undefined),
    [appState.quoteMode],
  );

  const [grid, setGrid] = useState(() => years.map(() => new Array(devYears.length).fill('')));
  const [loading, setLoading] = useState(false);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    if (!contractId) return;
    setLoading(true);
    setDirty(false);
    const buildFromCells = (cells, target) => {
      cells.forEach(c => {
        const r = years.indexOf(c.origin_year);
        const d = Math.round(c.dev_months / 12) - 1;
        if (r >= 0 && d >= 0 && d < devYears.length) {
          const n = parseNum(c.cum_value);
          if (n != null) target[r][d] = (target[r][d] ?? 0) + n;
        }
      });
    };
    const loader = isDerived
      ? Promise.all([
          api.getTriangle(contractId, 'CLAIMS_PAID', apiOpts).catch(() => ({ cells: [] })),
          api.getTriangle(contractId, 'CLAIMS_OS', apiOpts).catch(() => ({ cells: [] })),
        ]).then(([p, o]) => {
          const sumGrid = years.map(() => new Array(devYears.length).fill(null));
          buildFromCells(p?.cells || (Array.isArray(p) ? p : []), sumGrid);
          buildFromCells(o?.cells || (Array.isArray(o) ? o : []), sumGrid);
          return sumGrid.map(row => row.map(v => v == null ? '' : fmtCell(v)));
        })
      : api.getTriangle(contractId, triType, apiOpts).then(data => {
          const cells = data?.cells || (Array.isArray(data) ? data : []);
          const newGrid = years.map(() => new Array(devYears.length).fill(''));
          cells.forEach(c => { const r = years.indexOf(c.origin_year); const d = Math.round(c.dev_months / 12) - 1; if (r >= 0 && d >= 0 && d < devYears.length) newGrid[r][d] = fmtCell(c.cum_value); });
          return newGrid;
        });
    loader.then(setGrid).catch(e => console.warn('Load triangle:', e)).finally(() => setLoading(false));
    // Re-run on year-window changes too: triangleMeta arrives from
    // PropTreatyDetail asynchronously, and the grid is sized by it. Without
    // these deps the cells get dropped by the index-based copy below when
    // startYear/numDevYears shift after the initial fetch.
  }, [contractId, triType, startYear, numDevYears, apiOpts, isDerived, years, devYears.length]);

  // Note: the year window is owned by the load effect above (which re-runs
  // when startYear/numDevYears change). An index-based prev→current copy on
  // years.length would silently drop cells whenever startYear shifts, since
  // row r maps to a different origin year before vs. after the change.

  const updateCell = (r, c, val) => { setGrid(prev => { const n = prev.map(row => [...row]); n[r][c] = val; return n; }); setDirty(true); };
  const handleBlur = (r, c) => { const raw = grid[r]?.[c]; const n = parseNum(raw); if (n !== null) setGrid(prev => { const x = prev.map(row => [...row]); x[r][c] = fmtCell(n); return x; }); };

  // Triangle-shape gate: row r only has data through dev period
  // (numDevYears - r). Paste & save both honour this so the DB never
  // accumulates off-diagonal placeholder cells from accidental pastes.
  const inTriangle = useCallback((r, c) => c <= numDevYears - r - 1, [numDevYears]);

  const save = useCallback(async () => {
    if (isDerived) return true;
    if (!contractId) return false; if (!dirty) return true;
    const cells = [];
    grid.forEach((row, r) => { row.forEach((val, c) => {
      if (!inTriangle(r, c)) return;
      const n = parseNum(val);
      if (n !== null) cells.push({ origin_year: years[r], dev_months: (c + 1) * 12, cum_value: n });
    }); });
    // Re-throw on failure so WizardLayout's runTrackedSave reports the
    // actual server error in the SaveStateIndicator instead of the
    // generic "Save returned false" message.
    await api.saveTriangle(contractId, triType, { cells }, apiOpts);
    setDirty(false);
    return true;
  }, [isDerived, contractId, dirty, grid, triType, apiOpts, inTriangle, years]);

  const handlePaste = useCallback((e, showToast) => {
    const text = e.clipboardData?.getData('text/plain');
    if (!text) return;
    e.preventDefault();
    const pastedRows = text.split('\n').filter(r => r.trim()).map(r => r.split('\t'));
    const r = parseInt(e.target.dataset.row);
    const c = parseInt(e.target.dataset.col);
    if (isNaN(r) || isNaN(c)) return;

    // Resolve patches + drop counts up front so the toast fires
    // deterministically. Doing this inside the setGrid updater is unsafe
    // — React may defer or double-invoke the updater (strict mode), which
    // would skew the counts that drive the toast message.
    const patches = [];
    let droppedOutOfGrid = 0;
    let droppedOffTriangle = 0;
    let droppedNonNumeric = 0;
    pastedRows.forEach((pr, ri) => {
      pr.forEach((val, ci) => {
        const tr = r + ri;
        const tc = c + ci;
        if (tr >= numDevYears || tc >= numDevYears) { droppedOutOfGrid++; return; }
        // Skip cells that fall outside the upper triangle so an
        // accidental "paste 6×6 from Excel" doesn't seed the lower
        // diagonal with placeholders that linger in the DB.
        if (!inTriangle(tr, tc)) { droppedOffTriangle++; return; }
        const parsed = parseNum(val.trim());
        if (parsed === null) {
          // Non-numeric token (e.g. an Excel header row dragged in by
          // accident): leave the existing cell value alone instead of
          // blanking it. Explicit deletion still works via keyboard.
          if (String(val).trim() !== '') droppedNonNumeric++;
          return;
        }
        patches.push({ tr, tc, val: fmtCell(parsed) });
      });
    });

    if (patches.length) {
      setGrid(prev => {
        const n = prev.map(row => [...row]);
        patches.forEach(({ tr, tc, val }) => { n[tr][tc] = val; });
        return n;
      });
      setDirty(true);
    }

    const parts = [];
    if (droppedOutOfGrid)   parts.push(`${droppedOutOfGrid} cell${droppedOutOfGrid === 1 ? '' : 's'} past the grid edge`);
    if (droppedOffTriangle) parts.push(`${droppedOffTriangle} cell${droppedOffTriangle === 1 ? '' : 's'} below the triangle diagonal`);
    if (droppedNonNumeric)  parts.push(`${droppedNonNumeric} non-numeric value${droppedNonNumeric === 1 ? '' : 's'}`);
    if (parts.length && showToast) {
      showToast(`Skipped ${parts.join(', ')}.`, 5000);
    }
  }, [inTriangle, numDevYears]);

  // triangleMeta not yet loaded (e.g. just after a hard reset, before
  // PropTreatyDetail re-fetches the contract). Avoid rendering with a bogus year range.
  // Guard must stay after all hooks — Rules of Hooks.
  if (!startYear) return <div style={{ padding: 32, color: 'rgba(255,255,255,0.5)' }}>Loading triangle…</div>;

  return (
    <WizardLayout routeKey={routeKey} title={title} headerPill={headerPill} onBeforeNext={save} onBeforeBack={save}>
      {({ showToast }) => (
        <div className="PROP_TRIANGLES">
          <div style={{ display: 'flex', gap: 24, padding: '10px 16px', marginBottom: 14, borderRadius: 10, background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.06)', fontSize: 13, flexWrap: 'wrap' }}>
            <div style={{ color: 'var(--text-subtle)' }}>Start Year: <b style={{ color: 'var(--text)' }}>{startYear}</b></div>
            <div style={{ color: 'var(--text-subtle)' }}>Inception Year: <b style={{ color: 'var(--text)' }}>{inceptionYear}</b></div>
            <div style={{ color: 'var(--text-subtle)' }}>Development Years: <b style={{ color: 'var(--accent)' }}>{numDevYears}</b></div>
          </div>
          {loading ? <div className="muted">Loading…</div> : (
            <div style={{ overflowX: 'auto' }}>
              <table className="tri-table">
                <thead><tr><th className="tri-hdr tri-yr-hdr">YEAR</th>{devYears.map(d => <th key={d} className="tri-hdr">{d}</th>)}</tr></thead>
                <tbody>{years.map((yr, r) => (
                  <tr key={yr}>
                    <td className="tri-yr">{yr}</td>
                    {devYears.map((_, c) => { const maxCol = numDevYears - r - 1; const off = c > maxCol; return (
                      <td key={c} className={off ? 'tri-off' : 'tri-cell'}>{off ? '' : isDerived
                        ? <div className="tri-inp" style={{ color: 'rgba(226,232,240,0.88)' }}>{grid[r]?.[c] ?? ''}</div>
                        : <input className="tri-inp" type="text" value={grid[r]?.[c] ?? ''} data-row={r} data-col={c} onChange={e => updateCell(r, c, e.target.value)} onBlur={() => handleBlur(r, c)} onPaste={(e) => handlePaste(e, showToast)} />}</td>
                    ); })}
                  </tr>
                ))}</tbody>
              </table>
              {isDerived && (
                <div style={{ marginTop: 10, padding: '8px 12px', borderRadius: 8, background: 'rgba(34,197,94,0.06)', border: '1px solid rgba(34,197,94,0.20)', color: 'rgba(167,243,208,0.85)', fontSize: 12 }}>
                  Derived view — incurred = paid + outstanding. Edit the Claims Paid and OS Claims triangles to update these values.
                </div>
              )}
              {!isDerived && dirty && (
                <div style={{ marginTop: 10, display: 'flex', alignItems: 'center', gap: 12 }}>
                  <button className="orange-gloss-btn" onClick={async () => {
                    try { await save(); showToast?.('Triangle saved'); }
                    catch (e) { showToast?.(`Save failed: ${e?.message || 'server error'}`); }
                  }}>Save Triangle</button>
                </div>
              )}
              {!contractId && <div style={{ marginTop: 10, padding: '8px 12px', borderRadius: 8, background: 'rgba(251,146,60,0.1)', border: '1px solid rgba(251,146,60,0.3)', color: '#fb923c', fontSize: 12 }}>No contract ID — save treaty detail first.</div>}
            </div>
          )}
        </div>
      )}
    </WizardLayout>
  );
}
