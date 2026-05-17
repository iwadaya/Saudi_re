// src/screens/non_proportional/structure/NpAggregateXlStructure.jsx
//
// Aggregate XL-specific structure: layer table priced in absolute
// aggregate amounts (not loss ratios), plus two policy-shape toggles
// (Franchise Deductible, Structured Deal) and a Class-of-Business
// inner-limits table. Used on the Structure screen when the treaty
// type is "Aggregate XL", and rendered read-only on Final Pricing.
//
// State lives in AppContext slice `npAggregateXlInputs`:
//   {
//     franchiseDeductible: boolean,
//     structuredDeal:      boolean,
//     layers:              [{ aggregateLimit, aggregateDeductible,
//                             deductible, aad, risk, cat }],
//     classesOfBusiness:   [{ classOfBusiness, innerLimit,
//                             innerDeductible }],
//   }
//
// Layer count comes from npTreatyDetail.numberOfLayers (default 1).
// COB rows are user-driven (add / remove) since the treaty's COB
// list isn't necessarily the same set we want inner limits for.

import { useCallback, useMemo } from 'react';
import { useAppState } from '../../../context/AppContext';

const SLICE_KEY = 'npAggregateXlInputs';

const DEFAULT_LAYER = {
  aggregateLimit: '',
  aggregateDeductible: '',
  deductible: '',
  aad: '',
  risk: false,
  cat: false,
};
const DEFAULT_COB = { classOfBusiness: '', innerLimit: '', innerDeductible: '' };

function fmtMoney(v) {
  const n = Number(String(v ?? '').replace(/[^\d.-]/g, ''));
  return Number.isFinite(n) ? n.toLocaleString('en-US', { maximumFractionDigits: 0 }) : '';
}
function stripNum(v) {
  return String(v ?? '').replace(/[^\d.-]/g, '');
}

export default function NpAggregateXlStructure({ currency = 'SAR', readOnly = false }) {
  const { state: appState, setSlice } = useAppState();
  const npDetail = appState.npTreatyDetail || {};
  const stored = appState[SLICE_KEY];

  const franchiseDeductible = !!stored?.franchiseDeductible;
  const structuredDeal = !!stored?.structuredDeal;

  // Layer count from Treaty Detail; cap at 20 to match the Risk XL flow.
  const layerCount = useMemo(() => {
    const n = parseInt(npDetail.numberOfLayers || npDetail.number_of_layers || '1', 10);
    return Number.isFinite(n) && n > 0 ? Math.min(n, 20) : 1;
  }, [npDetail.numberOfLayers, npDetail.number_of_layers]);

  const layers = useMemo(() => {
    const saved = Array.isArray(stored?.layers) ? stored.layers : [];
    const out = [];
    for (let i = 0; i < layerCount; i++) {
      out.push(saved[i] ? { ...DEFAULT_LAYER, ...saved[i] } : { ...DEFAULT_LAYER });
    }
    return out;
  }, [stored?.layers, layerCount]);

  const cobs = useMemo(() => {
    const saved = Array.isArray(stored?.classesOfBusiness) ? stored.classesOfBusiness : [];
    return saved.length > 0 ? saved : [{ ...DEFAULT_COB }];
  }, [stored?.classesOfBusiness]);

  const setToggle = useCallback(
    (key, value) => {
      setSlice(SLICE_KEY, { [key]: value });
    },
    [setSlice],
  );

  const updateLayer = useCallback(
    (i, patch) => {
      const next = layers.map((l, idx) => (idx === i ? { ...l, ...patch } : { ...l }));
      setSlice(SLICE_KEY, { layers: next });
    },
    [layers, setSlice],
  );

  const updateCob = useCallback(
    (i, patch) => {
      const next = cobs.map((c, idx) => (idx === i ? { ...c, ...patch } : { ...c }));
      setSlice(SLICE_KEY, { classesOfBusiness: next });
    },
    [cobs, setSlice],
  );

  const addCob = useCallback(() => {
    setSlice(SLICE_KEY, { classesOfBusiness: [...cobs, { ...DEFAULT_COB }] });
  }, [cobs, setSlice]);

  const removeCob = useCallback(
    (i) => {
      const next = cobs.filter((_, idx) => idx !== i);
      setSlice(SLICE_KEY, { classesOfBusiness: next.length > 0 ? next : [{ ...DEFAULT_COB }] });
    },
    [cobs, setSlice],
  );

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <>
      {/* ── Policy-shape toggles ── */}
      <section className="np-struct-card glass" style={{ marginBottom: 16 }}>
        <div className="np-struct-card-header">
          <div className="np-struct-card-title">AGGREGATE XL · POLICY SHAPE</div>
          {readOnly && <div className="np-struct-card-actions"><span className="np-tag">Read-Only</span></div>}
        </div>
        <div style={{ display: 'flex', gap: 24, padding: '14px 22px', flexWrap: 'wrap' }}>
          <Toggle
            label="Franchise Deductible"
            hint="Deductible disappears once a loss breaches it (no offset)"
            checked={franchiseDeductible}
            disabled={readOnly}
            onChange={(v) => setToggle('franchiseDeductible', v)}
          />
          <Toggle
            label="Structured Deal"
            hint="Multi-year or commutation-linked structure"
            checked={structuredDeal}
            disabled={readOnly}
            onChange={(v) => setToggle('structuredDeal', v)}
          />
        </div>
      </section>

      {/* ── Layer table ── */}
      <section className="np-struct-card glass" style={{ marginBottom: 16 }}>
        <div className="np-struct-card-header">
          <div className="np-struct-card-title">AGGREGATE XL STRUCTURE · By Layer</div>
          <div className="np-struct-card-actions" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            {readOnly && <span className="np-tag">Read-Only</span>}
            <span className="np-tag">{layerCount} layer{layerCount === 1 ? '' : 's'}</span>
          </div>
        </div>
        <div className="np-table-wrap np-table-wrap--scroll">
          <table className="np-struct-table">
            <thead>
              <tr>
                <th className="np-table-sticky cell-center">LAYER</th>
                <th className="np-col">AGGREGATE LIMIT ({currency})</th>
                <th className="np-col">AGGREGATE DEDUCTIBLE ({currency})</th>
                <th className="np-col">DEDUCTIBLE ({currency})</th>
                <th className="np-col">AAD ({currency})</th>
                <th className="np-col-chk cell-center">RISK</th>
                <th className="np-col-chk cell-center">CAT</th>
              </tr>
            </thead>
            <tbody>
              {layers.map((l, i) => (
                <tr key={i}>
                  <th className="np-table-sticky cell-center">L{i + 1}</th>
                  <MoneyCell value={l.aggregateLimit} currency={currency} readOnly={readOnly}
                    onChange={(v) => updateLayer(i, { aggregateLimit: v })} />
                  <MoneyCell value={l.aggregateDeductible} currency={currency} readOnly={readOnly}
                    onChange={(v) => updateLayer(i, { aggregateDeductible: v })} />
                  <MoneyCell value={l.deductible} currency={currency} readOnly={readOnly}
                    onChange={(v) => updateLayer(i, { deductible: v })} />
                  <MoneyCell value={l.aad} currency={currency} readOnly={readOnly}
                    onChange={(v) => updateLayer(i, { aad: v })} />
                  <td className="np-col-chk cell-center">
                    <input type="checkbox" className="np-check" checked={!!l.risk}
                      disabled={readOnly}
                      onChange={(e) => updateLayer(i, { risk: e.target.checked })} />
                  </td>
                  <td className="np-col-chk cell-center">
                    <input type="checkbox" className="np-check" checked={!!l.cat}
                      disabled={readOnly}
                      onChange={(e) => updateLayer(i, { cat: e.target.checked })} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div style={{ padding: '10px 16px 14px', fontSize: 11, color: 'rgba(148,163,184,0.55)', lineHeight: 1.5 }}>
          Number of layers comes from Treaty Detail. Aggregate Limit
          /&nbsp;Deductible apply to the annual aggregate; Deductible and
          AAD apply per-loss.
        </div>
      </section>

      {/* ── Class of Business · Inner Limits ── */}
      <section className="np-struct-card glass" style={{ marginBottom: 16 }}>
        <div className="np-struct-card-header">
          <div className="np-struct-card-title">CLASS OF BUSINESS · Inner Limits</div>
          <div className="np-struct-card-actions" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            {readOnly && <span className="np-tag">Read-Only</span>}
            {!readOnly && (
              <button type="button" className="dock-btn dock-btn--ghost" onClick={addCob}>
                + Add Class
              </button>
            )}
          </div>
        </div>
        <div className="np-table-wrap np-table-wrap--scroll">
          <table className="np-struct-table">
            <thead>
              <tr>
                <th className="np-table-sticky">CLASS OF BUSINESS</th>
                <th className="np-col">INNER LIMIT ({currency})</th>
                <th className="np-col">INNER DEDUCTIBLE ({currency})</th>
                {!readOnly && <th className="cell-center" style={{ width: 40 }} aria-label="row actions" />}
              </tr>
            </thead>
            <tbody>
              {cobs.map((c, i) => (
                <tr key={i}>
                  <td className="np-table-sticky">
                    {readOnly ? (
                      <span style={{ padding: '0 8px', color: 'rgba(226,232,240,0.85)', fontWeight: 600 }}>
                        {c.classOfBusiness || <em style={{ color: 'rgba(148,163,184,0.40)' }}>—</em>}
                      </span>
                    ) : (
                      <input
                        className="np-mini-input"
                        style={{ minWidth: 200 }}
                        value={c.classOfBusiness}
                        onChange={(e) => updateCob(i, { classOfBusiness: e.target.value })}
                        placeholder="e.g. Property"
                      />
                    )}
                  </td>
                  <MoneyCell value={c.innerLimit} currency={currency} readOnly={readOnly}
                    onChange={(v) => updateCob(i, { innerLimit: v })} />
                  <MoneyCell value={c.innerDeductible} currency={currency} readOnly={readOnly}
                    onChange={(v) => updateCob(i, { innerDeductible: v })} />
                  {!readOnly && (
                    <td className="cell-center" style={{ width: 40 }}>
                      <button
                        type="button"
                        onClick={() => removeCob(i)}
                        aria-label={`Remove class row ${i + 1}`}
                        title="Remove"
                        style={{
                          appearance: 'none',
                          background: 'transparent',
                          border: 'none',
                          color: 'rgba(248,113,113,0.65)',
                          cursor: 'pointer',
                          fontSize: 14,
                        }}
                      >
                        ✕
                      </button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div style={{ padding: '10px 16px 14px', fontSize: 11, color: 'rgba(148,163,184,0.55)', lineHeight: 1.5 }}>
          Inner Limit / Inner Deductible cap or floor an individual
          class of business inside the aggregate cover. Leave a row blank
          if a class has no inner sublimit.
        </div>
      </section>
    </>
  );
}

// ── Inline helpers ──────────────────────────────────────────────────────────

function Toggle({ label, hint, checked, disabled, onChange }) {
  return (
    <label
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 10,
        cursor: disabled ? 'default' : 'pointer',
        userSelect: 'none',
        opacity: disabled ? 0.85 : 1,
      }}
    >
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        style={{ accentColor: '#00d4ff', width: 16, height: 16 }}
      />
      <span>
        <span style={{ fontSize: 12, fontWeight: 700, color: 'rgba(226,232,240,0.90)' }}>{label}</span>
        {hint && (
          <span style={{ marginLeft: 8, fontSize: 11, color: 'rgba(148,163,184,0.55)' }}>· {hint}</span>
        )}
      </span>
    </label>
  );
}

function MoneyCell({ value, currency, readOnly, onChange }) {
  const display = fmtMoney(value);
  return (
    <td className="np-col">
      {readOnly ? (
        <div className="np-cell-input">
          <input
            className="np-mini-input np-mini-input--center np-mini-input--readonly"
            readOnly
            value={display}
            placeholder="—"
          />
          <span className="np-sfx">{currency}</span>
        </div>
      ) : (
        <div className="np-cell-input">
          <input
            className="np-mini-input np-mini-input--center"
            value={display}
            onChange={(e) => onChange(stripNum(e.target.value))}
            placeholder="—"
          />
          <span className="np-sfx">{currency}</span>
        </div>
      )}
    </td>
  );
}
