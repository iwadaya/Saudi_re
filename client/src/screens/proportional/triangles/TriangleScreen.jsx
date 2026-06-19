import { useState, useEffect, useCallback, useMemo } from 'react';
import { api } from '../../../api';
import { useContractId } from '../../../hooks/useContractId';
import { useAppState } from '../../../context/AppContext';
import WizardLayout from '../../../components/WizardLayout';
import LoadErrorPanel from '../../../components/LoadErrorPanel';

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

  // Both variants are held in one state object. For editable types they are
  // independently-edited grids and switching the tab only changes which one is
  // *rendered* (activeGrid below), so unsaved edits in the hidden variant stay
  // untouched. For derived INCURRED nothing is edited: grids[variant] holds the
  // read-only paid+OS sum, recomputed on tab switch by the derive effect.
  const [grids, setGrids] = useState(() => ({
    MODIFIED: years.map(() => new Array(devYears.length).fill('')),
    ACTUAL: years.map(() => new Array(devYears.length).fill('')),
  }));
  // Init to true when a contract is present so the first paint is "Loading…"
  // rather than a flash of the empty grid before the load effect's setLoading
  // lands (effects run after paint). One of the load effects below always
  // clears it when contractId is truthy.
  const [loading, setLoading] = useState(() => Boolean(contractId));
  // Real load failure (network / 5xx) vs the normal "no triangle yet" empty
  // case: the per-fetch `.catch(()=>({cells:[]}))` below used to mask both, so
  // a failed load silently showed an empty editable grid the user could save
  // over real server data. loadError surfaces the failure; reloadNonce lets the
  // Retry button re-run the load effects.
  const [loadError, setLoadError] = useState(null);
  const [reloadNonce, setReloadNonce] = useState(0);
  const [dirty, setDirty] = useState({ MODIFIED: false, ACTUAL: false });
  // MODIFIED is the projected triangle the tool prices off — default-active.
  // ACTUAL is the gross reference triangle the underwriter also enters.
  const [variant, setVariant] = useState('MODIFIED');

  // ── Load: editable types (PREMIUM / CLAIMS_PAID / CLAIMS_OS) ──
  // Both variants are fetched up front and held in `grids`, so switching the
  // tab is instant and never refetches or clears unsaved edits. `variant` is
  // deliberately NOT a dep here.
  useEffect(() => {
    if (!contractId || isDerived) return;
    setLoading(true);
    setLoadError(null);
    setDirty({ MODIFIED: false, ACTUAL: false });
    // Index-based origin_year→row / dev_months→col mapping, shared by both
    // variants.
    const mapCells = (data) => {
      const cells = data?.cells || (Array.isArray(data) ? data : []);
      const newGrid = years.map(() => new Array(devYears.length).fill(''));
      cells.forEach(c => { const r = years.indexOf(c.origin_year); const d = Math.round(c.dev_months / 12) - 1; if (r >= 0 && d >= 0 && d < devYears.length) newGrid[r][d] = fmtCell(c.cum_value); });
      return newGrid;
    };
    // No per-fetch swallow: a real failure on either variant must surface as a
    // load error (the empty "no data yet" case still returns 200 {cells:[]}).
    Promise.all([
      api.getTriangle(contractId, triType, { ...apiOpts, variant: 'MODIFIED' }),
      api.getTriangle(contractId, triType, { ...apiOpts, variant: 'ACTUAL' }),
    ]).then(([m, a]) => setGrids({ MODIFIED: mapCells(m), ACTUAL: mapCells(a) }))
      .catch(e => { console.warn('Load triangle:', e); setLoadError(e); })
      .finally(() => setLoading(false));
    // Re-run on year-window changes: triangleMeta arrives from PropTreatyDetail
    // asynchronously and sizes the grids; without these deps the index-based
    // mapping drops cells when startYear/numDevYears shift.
  }, [contractId, triType, startYear, numDevYears, apiOpts, isDerived, years, devYears.length, reloadNonce]);

  // ── Reset derived grids on shape change (INCURRED only) ──
  // The derive effect below recomputes only grids[variant], so on a shape
  // change (contract/type/year-window) the *inactive* variant's grid would
  // stay mapped to the stale window and show wrong data when selected. Clear
  // BOTH here. `variant` is intentionally excluded: a pure tab switch must NOT
  // reset — that case is a merge handled by the derive effect. The dep arrays
  // are what tell the two refire causes apart (shape change vs tab switch).
  useEffect(() => {
    if (!isDerived) return;
    setGrids({
      MODIFIED: years.map(() => new Array(devYears.length).fill('')),
      ACTUAL: years.map(() => new Array(devYears.length).fill('')),
    });
  }, [contractId, triType, startYear, numDevYears, isDerived, years, devYears.length]);

  // ── Derive INCURRED for the active variant (read-only) ──
  // INCURRED isn't stored: derive it client-side by summing the active
  // variant's CLAIMS_PAID + CLAIMS_OS. Re-runs on tab switch (variant dep) so
  // ACTUAL incurred = actual paid + actual OS; MODIFIED incurred = modified
  // paid + modified OS. Writes only grids[variant] (merge, not reset). The
  // server-side incurred-combine stays pinned to MODIFIED — this is a
  // display-only derivation.
  useEffect(() => {
    if (!contractId || !isDerived) return;
    setLoading(true);
    setLoadError(null);
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
    Promise.all([
      api.getTriangle(contractId, 'CLAIMS_PAID', { ...apiOpts, variant }),
      api.getTriangle(contractId, 'CLAIMS_OS', { ...apiOpts, variant }),
    ]).then(([p, o]) => {
      const sumGrid = years.map(() => new Array(devYears.length).fill(null));
      buildFromCells(p?.cells || (Array.isArray(p) ? p : []), sumGrid);
      buildFromCells(o?.cells || (Array.isArray(o) ? o : []), sumGrid);
      const derived = sumGrid.map(row => row.map(v => v == null ? '' : fmtCell(v)));
      setGrids(prev => ({ ...prev, [variant]: derived }));
    }).catch(e => { console.warn('Load incurred:', e); setLoadError(e); }).finally(() => setLoading(false));
  }, [contractId, triType, startYear, numDevYears, apiOpts, isDerived, years, devYears.length, variant, reloadNonce]);

  // Note: the year window is owned by the load effect above (which re-runs
  // when startYear/numDevYears change). An index-based prev→current copy on
  // years.length would silently drop cells whenever startYear shifts, since
  // row r maps to a different origin year before vs. after the change.

  const updateCell = (r, c, val) => { setGrids(prev => { const g = prev[variant].map(row => [...row]); g[r][c] = val; return { ...prev, [variant]: g }; }); setDirty(prev => ({ ...prev, [variant]: true })); };
  const handleBlur = (r, c) => { const raw = grids[variant]?.[r]?.[c]; const n = parseNum(raw); if (n !== null) setGrids(prev => { const g = prev[variant].map(row => [...row]); g[r][c] = fmtCell(n); return { ...prev, [variant]: g }; }); };

  // Triangle-shape gate: row r only has data through dev period
  // (numDevYears - r). Paste & save both honour this so the DB never
  // accumulates off-diagonal placeholder cells from accidental pastes.
  const inTriangle = useCallback((r, c) => c <= numDevYears - r - 1, [numDevYears]);

  const save = useCallback(async () => {
    if (isDerived) return true;
    if (!contractId) return false;
    // Never persist over a failed load — the grid may be empty/partial.
    if (loadError) return false;
    const pending = ['MODIFIED', 'ACTUAL'].filter(v => dirty[v]);
    if (!pending.length) return true;
    for (const v of pending) {
      const cells = [];
      grids[v].forEach((row, r) => { row.forEach((val, c) => {
        if (!inTriangle(r, c)) return;
        const n = parseNum(val);
        if (n !== null) cells.push({ origin_year: years[r], dev_months: (c + 1) * 12, cum_value: n });
      }); });
      // Re-throw on failure so WizardLayout's runTrackedSave reports the
      // actual server error in the SaveStateIndicator instead of the
      // generic "Save returned false" message.
      await api.saveTriangle(contractId, triType, { cells }, { ...apiOpts, variant: v });
      setDirty(prev => ({ ...prev, [v]: false }));
    }
    return true;
  }, [isDerived, contractId, dirty, grids, triType, apiOpts, inTriangle, years, loadError]);

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
      setGrids(prev => {
        const n = prev[variant].map(row => [...row]);
        patches.forEach(({ tr, tc, val }) => { n[tr][tc] = val; });
        return { ...prev, [variant]: n };
      });
      setDirty(prev => ({ ...prev, [variant]: true }));
    }

    const parts = [];
    if (droppedOutOfGrid)   parts.push(`${droppedOutOfGrid} cell${droppedOutOfGrid === 1 ? '' : 's'} past the grid edge`);
    if (droppedOffTriangle) parts.push(`${droppedOffTriangle} cell${droppedOffTriangle === 1 ? '' : 's'} below the triangle diagonal`);
    if (droppedNonNumeric)  parts.push(`${droppedNonNumeric} non-numeric value${droppedNonNumeric === 1 ? '' : 's'}`);
    if (parts.length && showToast) {
      showToast(`Skipped ${parts.join(', ')}.`, 5000);
    }
  }, [inTriangle, numDevYears, variant]);

  // triangleMeta not yet loaded (e.g. just after a hard reset, before
  // PropTreatyDetail re-fetches the contract). Avoid rendering with a bogus year range.
  // Guard must stay after all hooks — Rules of Hooks.
  if (!startYear) return <div style={{ padding: 32, color: 'rgba(255,255,255,0.5)' }}>Loading triangle…</div>;

  // The grid currently shown/edited. For INCURRED this is the derived sum in
  // the MODIFIED slot; otherwise it's whichever variant the tab selects.
  const activeGrid = grids[variant];

  return (
    <WizardLayout routeKey={routeKey} title={title} headerPill={headerPill} onBeforeNext={save} onBeforeBack={save}>
      {({ showToast }) => (
        <div className="PROP_TRIANGLES">
          <div style={{ display: 'flex', gap: 24, padding: '10px 16px', marginBottom: 14, borderRadius: 10, background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.06)', fontSize: 13, flexWrap: 'wrap' }}>
            <div style={{ color: 'var(--text-subtle)' }}>Start Year: <b style={{ color: 'var(--text)' }}>{startYear}</b></div>
            <div style={{ color: 'var(--text-subtle)' }}>Inception Year: <b style={{ color: 'var(--text)' }}>{inceptionYear}</b></div>
            <div style={{ color: 'var(--text-subtle)' }}>Development Years: <b style={{ color: 'var(--accent)' }}>{numDevYears}</b></div>
          </div>
          {loading ? <div className="muted">Loading…</div> : loadError ? (
            <LoadErrorPanel
              message="Couldn’t load this triangle. Editing is disabled to avoid saving over server data."
              onRetry={() => setReloadNonce(n => n + 1)}
            />
          ) : (
            <>
              {/* ACTUAL | MODIFIED tab — shown for every triangle type. For the
                  editable types, switching only changes which grid is rendered;
                  unsaved edits in the hidden variant stay in state and the •
                  marks a variant with unsaved edits. For derived INCURRED it
                  re-derives the displayed grid from that variant's paid + OS. */}
              <div role="tablist" aria-label="Triangle variant" style={{ display: 'inline-flex', marginBottom: 12, borderRadius: 8, overflow: 'hidden', border: '1px solid rgba(255,255,255,0.12)' }}>
                {['MODIFIED', 'ACTUAL'].map(v => { const active = variant === v; return (
                  <button key={v} type="button" role="tab" aria-selected={active} onClick={() => setVariant(v)}
                    style={{ padding: '6px 18px', fontSize: 13, fontWeight: 600, cursor: 'pointer', border: 'none', background: active ? 'var(--accent)' : 'transparent', color: active ? 'var(--accent-contrast)' : 'var(--text-subtle)' }}>
                    {v === 'MODIFIED' ? 'Modified' : 'Actual'}{!isDerived && dirty[v] ? ' •' : ''}
                  </button>
                ); })}
              </div>
            <div style={{ overflowX: 'auto' }}>
              <table className="tri-table">
                <thead><tr><th className="tri-hdr tri-yr-hdr">YEAR</th>{devYears.map(d => <th key={d} className="tri-hdr">{d}</th>)}</tr></thead>
                <tbody>{years.map((yr, r) => (
                  <tr key={yr}>
                    <td className="tri-yr">{yr}</td>
                    {devYears.map((_, c) => { const maxCol = numDevYears - r - 1; const off = c > maxCol; return (
                      <td key={c} className={off ? 'tri-off' : 'tri-cell'}>{off ? '' : isDerived
                        ? <div className="tri-inp" style={{ color: 'rgba(226,232,240,0.88)' }}>{activeGrid[r]?.[c] ?? ''}</div>
                        : <input className="tri-inp" type="text" value={activeGrid[r]?.[c] ?? ''} data-row={r} data-col={c} onChange={e => updateCell(r, c, e.target.value)} onBlur={() => handleBlur(r, c)} onPaste={(e) => handlePaste(e, showToast)} />}</td>
                    ); })}
                  </tr>
                ))}</tbody>
              </table>
              {isDerived && (
                <div style={{ marginTop: 10, padding: '8px 12px', borderRadius: 8, background: 'rgba(34,197,94,0.06)', border: '1px solid rgba(34,197,94,0.20)', color: 'rgba(167,243,208,0.85)', fontSize: 12 }}>
                  Read-only derived view — {variant === 'ACTUAL' ? 'Actual' : 'Modified'} incurred = {variant === 'ACTUAL' ? 'Actual' : 'Modified'} paid + outstanding. Edit the Claims Paid and OS Claims triangles (on their own tabs) to change these values.
                </div>
              )}
              {!isDerived && (dirty.MODIFIED || dirty.ACTUAL) && (
                <div style={{ marginTop: 10, display: 'flex', alignItems: 'center', gap: 12 }}>
                  <button className="orange-gloss-btn" onClick={async () => {
                    try { await save(); showToast?.('Triangle saved'); }
                    catch (e) { showToast?.(`Save failed: ${e?.message || 'server error'}`); }
                  }}>Save Triangle</button>
                </div>
              )}
              {!contractId && <div style={{ marginTop: 10, padding: '8px 12px', borderRadius: 8, background: 'rgba(251,146,60,0.1)', border: '1px solid rgba(251,146,60,0.3)', color: '#fb923c', fontSize: 12 }}>No contract ID — save treaty detail first.</div>}
            </div>
            </>
          )}
        </div>
      )}
    </WizardLayout>
  );
}
