import { useState, useEffect, useId, useRef, useMemo, useCallback } from 'react';
import {
  toNum,
  emptyLayer,
  CommaInput, PctInput,
  parseClipboard, parseExcelInt,
  NUMERIC_FIELDS,
} from './NpStructureHelpers';
import { useAppState } from '../../../context/AppContext';

const PASTE_ORDER = ['limit', 'deductible', 'annualAggLimit', 'egnpi', 'reinstatements', 'reinstatementPct', 'aadAmount'];

export function QuoteStructureSection({
  structIdx, currency, cobOptions, reinstatementOptions, onDirty, initialData, mode,
}) {
  const { structRefsMap } = useAppState();
  const layersCountSelectId = useId();
  const [layersCount, setLayersCount] = useState('');
  const [layers, setLayers]           = useState([]);
  const [cobRows, setCobRows]         = useState([]);
  const initializedRef = useRef(false);

  /* ── Hydrate from saved data on first mount ── */
  useEffect(() => {
    if (initializedRef.current || !initialData) return;
    initializedRef.current = true;
    const lc = String(initialData.layersCount ?? initialData.layers_count ?? initialData.layers?.length ?? '');
    setLayersCount(lc);
    const n = Math.max(0, parseInt(lc, 10) || 0);
    const savedLayers = (initialData.layers || []).map((l, i) => ({ ...emptyLayer(i), ...l }));
    while (savedLayers.length < n) savedLayers.push(emptyLayer(savedLayers.length));
    setLayers(savedLayers.slice(0, Math.max(n, savedLayers.length)));
    setCobRows(initialData.cobRows || []);
  }, [initialData]);

  const numLayers  = Math.max(0, parseInt(layersCount, 10) || 0);
  const riskLocked = mode === 'RISK' || mode === 'CAT';
  const catLocked  = mode === 'RISK' || mode === 'CAT';

  /* ── Layer count change ── */
  const handleLayersCountChange = useCallback((val) => {
    const n = Math.max(0, parseInt(val, 10) || 0);
    setLayersCount(val);
    setLayers(prev => {
      const next = [...prev];
      while (next.length < n) next.push(emptyLayer(next.length));
      return next.slice(0, n);
    });
    if (onDirty) onDirty();
  }, [onDirty]);

  /* ── Cascade deductibles from layer 1 ── */
  const cascadeDeductibles = useCallback((allLayers) => {
    const result = [];
    for (let i = 0; i < allLayers.length; i++) {
      if (i === 0) { result.push({ ...allLayers[0] }); }
      else {
        const prev = result[i - 1];
        const next = toNum(prev.deductible) + toNum(prev.limit);
        result.push({ ...allLayers[i], deductible: next > 0 ? String(next) : allLayers[i].deductible });
      }
    }
    return result;
  }, []);

  /* ── Update single field ── */
  const updateLayer = useCallback((idx, field, value) => {
    setLayers(prev => {
      const next = [...prev];
      next[idx] = { ...next[idx], [field]: value };
      return (field === 'limit' || field === 'deductible') ? cascadeDeductibles(next) : next;
    });
    if (onDirty) onDirty();
  }, [onDirty, cascadeDeductibles]);

  /* ── Paste handler ── */
  const handlePaste = useCallback((e) => {
    const target = e.target;
    if (!target || !target.closest('tr[data-qs-row]')) return;
    const tr = target.closest('tr[data-qs-row]');
    const startRow = Number(tr.getAttribute('data-qs-row'));
    const field = target.getAttribute('data-paste-field');
    if (!Number.isFinite(startRow) || !field) return;
    const clip = e.clipboardData?.getData('text') ?? '';
    const matrix = parseClipboard(clip);
    if (matrix.length <= 1 && (!matrix[0] || matrix[0].length <= 1)) return;
    e.preventDefault();
    setLayers(prev => {
      const next = prev.map(l => ({ ...l }));
      const startCol = Math.max(0, PASTE_ORDER.indexOf(field));
      for (let r = 0; r < matrix.length; r++) {
        const idx = startRow + r;
        if (idx >= next.length) break;
        const rowVals = matrix[r] || [];
        for (let c = 0; c < rowVals.length; c++) {
          const f = PASTE_ORDER[startCol + c];
          if (!f) break;
          const val = rowVals[c] || '';
          next[idx][f] = NUMERIC_FIELDS.has(f) ? parseExcelInt(val) : val;
        }
      }
      if (onDirty) onDirty();
      return cascadeDeductibles(next);
    });
  }, [cascadeDeductibles, onDirty]);

  /* ── Totals ── */
  const totals = useMemo(() => {
    const vis = Array.from({ length: numLayers }, (_, i) => ({ limit:'', deductible:'', annualAggLimit:'', egnpi:'', reinstatements:'', ...(layers[i] || {}) }));
    const totLimit  = vis.reduce((s, l) => s + toNum(l.limit), 0);
    const firstDed  = toNum(vis[0]?.deductible);
    const totAgg    = vis.reduce((s, l) => s + toNum(l.annualAggLimit), 0);
    const totEgnpi  = Math.max(0, ...vis.map(l => toNum(l.egnpi)));
    const maxReinst = vis.reduce((max, l) => {
      if (l.reinstatements === 'UNLIMITED') return 'UNLIMITED';
      const n = parseInt(l.reinstatements, 10);
      return Number.isFinite(n) && n > (typeof max === 'number' ? max : 0) ? n : max;
    }, 0);
    const maxReinstLabel = maxReinst === 'UNLIMITED' ? 'Unlimited' : maxReinst > 0 ? String(maxReinst) : '';
    return { totLimit, firstDed, totAgg, totEgnpi, maxReinstLabel };
  }, [layers, numLayers]);

  /* ── Expose data for parent save ── */
  const getData = useCallback(() => ({
    structureNo: structIdx + 1, layersCount,
    layers: layers.map(l => ({
      layer: l.layer, limit: l.limit, deductible: l.deductible,
      annualAggLimit: l.annualAggLimit, egnpi: l.egnpi,
      aad: !!l.aad, aadAmount: l.aadAmount,
      reinstatements: l.reinstatements, reinstatementPct: l.reinstatementPct,
      riskCover: !!l.riskCover, catCover: !!l.catCover,
    })),
    cobRows,
  }), [structIdx, layersCount, layers, cobRows]);

  const getDataRef = useRef(getData);
  useEffect(() => { getDataRef.current = getData; }, [getData]);
  useEffect(() => {
    const refs = structRefsMap.current;
    refs[structIdx] = getDataRef;
    return () => { delete refs[structIdx]; };
  }, [structIdx, structRefsMap]);

  /* ── Cover pill ── */
  const coverLabel = mode === 'RISK' ? 'RISK XL' : mode === 'CAT' ? 'CAT XL' : 'RISK + CAT';
  const coverColor = mode === 'RISK' ? 'rgba(56,189,248,0.85)' : mode === 'CAT' ? 'rgba(251,146,60,0.85)' : 'rgba(0,255,170,0.85)';

  /* ── Empty row defaults ── */
  const emptyRow = (i) => ({
    layer: i + 1, limit: '', deductible: '', annualAggLimit: '', egnpi: '',
    reinstatements: '', reinstatementPct: '', aad: false, aadAmount: '',
    riskCover: mode !== 'CAT', catCover: mode !== 'RISK',
  });

  return (
    <section className="np-struct-card glass qss-section">

      {/* ── Header ── */}
      <div className="qss-header">
        <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
          <div className="qss-struct-badge">S{structIdx + 1}</div>
          <div>
            <div className="qss-struct-title">Structure {structIdx + 1}</div>
            <div className="qss-struct-sub">Define layers to quote for this structure</div>
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
          <div className="qss-cover-pill" style={{
            background: `linear-gradient(135deg, ${coverColor.replace('0.85','0.12')}, transparent)`,
            borderColor: coverColor.replace('0.85','0.35'),
          }}>
            <span style={{ width: 6, height: 6, borderRadius: '50%', background: coverColor, display: 'inline-block', marginRight: 6 }} />
            {coverLabel}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <label className="qss-field-label" htmlFor={layersCountSelectId}>NUMBER OF LAYERS</label>
            <select id={layersCountSelectId} className="np-mini-input np-mini-select" style={{ width: 80 }}
              value={layersCount} onChange={e => handleLayersCountChange(e.target.value)}>
              <option value="">—</option>
              {Array.from({ length: 20 }, (_, i) => <option key={i+1} value={i+1}>{i+1}</option>)}
            </select>
          </div>
        </div>
      </div>

      {/* ── Empty state ── */}
      {numLayers === 0 && (
        <div style={{ padding: '28px 18px', textAlign: 'center', color: 'rgba(var(--text-rgb),0.4)', fontSize: 13 }}>
          Select the number of layers above to define the quote structure.
        </div>
      )}

      {/* ── Layer table — all columns, benchmark styling ── */}
      {numLayers > 0 && (
        <>
          <div className="bm-np-table-wrap" style={{ margin: '0 0 2px', overflowX: 'auto' }}>
            <table className="bm-np-table" style={{ minWidth: 1200, width: 'max-content' }}>
              <thead>
                <tr>
                  <th style={{ width: 56, textAlign: 'center' }}>LAYER</th>
                  <th className="bm-np-th--limit">LIMIT</th>
                  <th className="bm-np-th--limit">DEDUCTIBLE / ATTACHMENT</th>
                  <th className="bm-np-th--limit">AGGREGATE LIMIT</th>
                  <th className="bm-np-th--limit">EGNPI</th>
                  <th style={{ minWidth: 120, textAlign: 'center' }}>NO. REINST.</th>
                  <th style={{ minWidth: 100, textAlign: 'center' }}>% REINST.</th>
                  <th style={{ minWidth: 60, textAlign: 'center' }}>AAD</th>
                  <th className="bm-np-th--limit">AAD AMOUNT</th>
                  <th style={{ minWidth: 60, textAlign: 'center' }}>RISK</th>
                  <th style={{ minWidth: 60, textAlign: 'center' }}>CAT</th>
                </tr>
              </thead>
              <tbody onPaste={handlePaste}>
                {Array.from({ length: numLayers }, (_, i) => {
                  const l = { ...emptyRow(i), ...(layers[i] || {}) };
                  return (
                    <tr key={i} className="bm-np-row" data-qs-row={i}>
                      <td style={{ textAlign: 'center' }}>
                        <span className="np-layer-badge">L{i+1}</span>
                      </td>
                      <td className="bm-np-td--limit">
                        <CommaInput value={l.limit} onChange={v => updateLayer(i,'limit',v)} suffix={currency} pasteField="limit" />
                      </td>
                      <td className="bm-np-td--limit">
                        <CommaInput value={l.deductible} onChange={i === 0 ? v => updateLayer(i,'deductible',v) : () => {}} readOnly={i > 0} suffix={currency} />
                      </td>
                      <td className="bm-np-td--limit">
                        <CommaInput value={l.annualAggLimit} onChange={v => updateLayer(i,'annualAggLimit',v)} suffix={currency} pasteField="annualAggLimit" />
                      </td>
                      <td className="bm-np-td--limit">
                        <CommaInput value={l.egnpi} onChange={v => updateLayer(i,'egnpi',v)} suffix={currency} pasteField="egnpi" />
                      </td>
                      <td className="bm-np-td--check">
                        <select className="qss-mini-select"
                          value={l.reinstatements || ''}
                          onChange={e => updateLayer(i,'reinstatements',e.target.value)}>
                          {reinstatementOptions.map(o => <option key={o.v} value={o.v}>{o.l}</option>)}
                        </select>
                      </td>
                      <td className="bm-np-td--check">
                        <PctInput value={l.reinstatementPct} onChange={v => updateLayer(i,'reinstatementPct',v)} pasteField="reinstatementPct" />
                      </td>
                      <td className="bm-np-td--check">
                        <input type="checkbox" className="np-check" checked={!!l.aad} onChange={e => updateLayer(i,'aad',e.target.checked)} />
                      </td>
                      <td className="bm-np-td--limit">
                        <CommaInput value={l.aadAmount} onChange={v => updateLayer(i,'aadAmount',v)} suffix={currency} disabled={!l.aad} pasteField="aadAmount" />
                      </td>
                      <td className={`bm-np-td--check np-cover-cell ${mode==='CAT'?'is-off':''} ${riskLocked?'is-locked':''}`}>
                        <input type="checkbox" className="np-check" checked={!!l.riskCover} onChange={e => updateLayer(i,'riskCover',e.target.checked)} disabled={riskLocked} />
                      </td>
                      <td className={`bm-np-td--check np-cover-cell ${mode==='RISK'?'is-off':''} ${catLocked?'is-locked':''}`}>
                        <input type="checkbox" className="np-check" checked={!!l.catCover} onChange={e => updateLayer(i,'catCover',e.target.checked)} disabled={catLocked} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
              {numLayers > 0 && (
                <tfoot>
                  <tr style={{ borderTop: '2px solid rgba(0,212,255,0.35)', background: 'rgba(0,212,255,0.05)' }}>
                    <td style={{ textAlign: 'center', color: 'var(--accent-blue)', fontSize: 10, fontWeight: 800, letterSpacing: '.08em', padding: '10px 6px' }}>TOTAL</td>
                    <td className="bm-np-td--limit"><CommaInput value={totals.totLimit ? String(totals.totLimit) : ''} readOnly suffix={currency} onChange={() => {}} /></td>
                    <td className="bm-np-td--limit"><CommaInput value={totals.firstDed ? String(totals.firstDed) : ''} readOnly suffix={currency} onChange={() => {}} /></td>
                    <td className="bm-np-td--limit"><CommaInput value={totals.totAgg ? String(totals.totAgg) : ''} readOnly suffix={currency} onChange={() => {}} /></td>
                    <td className="bm-np-td--limit"><CommaInput value={totals.totEgnpi ? String(totals.totEgnpi) : ''} readOnly suffix={currency} onChange={() => {}} /></td>
                    <td /><td /><td /><td /><td /><td />
                  </tr>
                </tfoot>
              )}
            </table>
          </div>
          <div className="np-struct-footnote">
            Layer 1 deductible is set manually. Subsequent deductibles auto-cascade as <b>prior deductible + prior limit</b>.
          </div>
        </>
      )}
      {/* ── COB participation table — benchmark dark-header style ── */}
      {numLayers > 0 && cobOptions.length > 0 && (
        <>
          <div className="bm-cob-section-header" style={{ padding: '16px 18px 10px' }}>
            <div className="bm-cob-section-title">Classes of Business &amp; Layer Participation</div>
            <div className="bm-cob-section-hint">Enter underwriting limit per class and tick which layers it participates in.</div>
          </div>
          <div className="bm-np-table-wrap">
            <table className="bm-np-table">
              <thead>
                <tr>
                  <th className="bm-np-th--cob">CLASS OF BUSINESS</th>
                  <th className="bm-np-th--limit">UNDERWRITING LIMIT</th>
                  {Array.from({ length: numLayers }, (_, i) => (
                    <th key={i} className="bm-np-th--layer">LAYER {i+1}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {cobOptions.map((c, ci) => {
                  const row = cobRows.find(r => String(r.cobId) === String(c.id)) || { cobId: c.id, name: c.name, underwritingLimit: '', layers: [] };
                  return (
                    <tr key={ci} className="bm-np-row">
                      <td className="bm-np-td--cob">{c.name || '—'}</td>
                      <td className="bm-np-td--limit">
                        <div className="bm-np-limit-cell">
                          <CommaInput value={row.underwritingLimit} onChange={v => {
                            setCobRows(prev => {
                              const next = [...prev];
                              const idx = next.findIndex(r => String(r.cobId) === String(c.id));
                              if (idx >= 0) next[idx] = { ...next[idx], underwritingLimit: v };
                              else next.push({ cobId: c.id, name: c.name, underwritingLimit: v, layers: [] });
                              return next;
                            });
                            if (onDirty) onDirty();
                          }} suffix={currency} />
                        </div>
                      </td>
                      {Array.from({ length: numLayers }, (_, li) => (
                        <td key={li} className="bm-np-td--check">
                          <input type="checkbox" className="np-check"
                            checked={!!(row.layers && row.layers[li])}
                            onChange={() => {
                              setCobRows(prev => {
                                const next = [...prev];
                                let existing = next.find(r => String(r.cobId) === String(c.id));
                                if (!existing) { existing = { cobId: c.id, name: c.name, underwritingLimit: '', layers: [] }; next.push(existing); }
                                const ls = [...(existing.layers || [])];
                                ls[li] = !ls[li];
                                existing.layers = ls;
                                return [...next];
                              });
                              if (onDirty) onDirty();
                            }} />
                        </td>
                      ))}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}


/* ═══════════════════════════════════════════════
   MAIN COMPONENT
   ═══════════════════════════════════════════════ */
