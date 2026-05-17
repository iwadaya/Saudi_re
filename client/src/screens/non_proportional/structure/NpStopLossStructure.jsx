// src/screens/non_proportional/structure/NpStopLossStructure.jsx
//
// Stop Loss-specific layer setup that replaces the Risk XL / Cat XL
// layer table on the Structure screen when the treaty type is "Stop
// Loss". The cover is quoted as percentages of subject premium, so
// instead of a multi-layer matrix we capture just three numbers:
//   - Attachment LR (%)  — where the cover starts (e.g. 80%)
//   - Limit LR (%)       — layer width (e.g. 20% → 20% xs 80%)
//   - EPI                — current-year subject premium
//
// The values are mirrored into `npStructureLayers` as a single
// synthetic layer so downstream consumers (Pricing screen) can read
// the layer info via the same slice the Risk XL layout uses.

import { useCallback, useMemo } from 'react';
import PctInput from '../../../components/PctInput';
import { useAppState } from '../../../context/AppContext';

function fmtMoney(v) {
  const n = Number(String(v ?? '').replace(/[^\d.-]/g, ''));
  return Number.isFinite(n) ? n.toLocaleString('en-US', { maximumFractionDigits: 0 }) : '';
}
function parseNum(v) {
  const n = Number(String(v ?? '').replace(/[^\d.-]/g, ''));
  return Number.isFinite(n) ? n : null;
}

export default function NpStopLossStructure({ currency = 'SAR' }) {
  const { state: appState, setSlice } = useAppState();
  const slice = appState.npStopLossInputs || {};
  const attachmentLossRatio = slice.attachmentLossRatio ?? '';
  const limitLossRatio = slice.limitLossRatio ?? '';
  const epi = slice.epi ?? '';

  const setField = useCallback(
    (patch) => setSlice('npStopLossInputs', patch),
    [setSlice],
  );

  const epiN = parseNum(epi);
  const attLrN = parseNum(attachmentLossRatio);
  const limLrN = parseNum(limitLossRatio);
  const resolved = useMemo(() => {
    const attachment = (epiN != null && attLrN != null) ? (epiN * attLrN) / 100 : null;
    const limit = (epiN != null && limLrN != null) ? (epiN * limLrN) / 100 : null;
    return { attachment, limit };
  }, [epiN, attLrN, limLrN]);

  return (
    <div className="np-struct-card glass" style={{ marginBottom: 16 }}>
      <div className="np-struct-card-header">
        <div className="np-struct-card-title">STOP LOSS LAYER</div>
        <div className="np-struct-card-actions">
          <span className="np-tag">Loss-Ratio Basis</span>
        </div>
      </div>
      <div style={{ padding: '18px 22px' }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 18, alignItems: 'end' }}>
          <div>
            <div style={labelStyle}>Attachment LR (%)</div>
            <PctInput
              className="np-mini-input np-mini-input--center"
              value={attachmentLossRatio}
              onChange={(v) => setField({ attachmentLossRatio: v })}
              placeholder="80.00%"
            />
            <div style={hintStyle}>Where the cover starts (e.g. 80% LR)</div>
          </div>
          <div>
            <div style={labelStyle}>Limit LR (%)</div>
            <PctInput
              className="np-mini-input np-mini-input--center"
              value={limitLossRatio}
              onChange={(v) => setField({ limitLossRatio: v })}
              placeholder="20.00%"
            />
            <div style={hintStyle}>Layer width as % of EPI</div>
          </div>
          <div>
            <div style={labelStyle}>EPI ({currency})</div>
            <div className="np-cell-input">
              <input
                className="np-mini-input np-mini-input--center"
                value={fmtMoney(epi)}
                onChange={(e) => setField({ epi: e.target.value.replace(/[^\d.-]/g, '') })}
                placeholder="—"
              />
              <span className="np-sfx">{currency}</span>
            </div>
            <div style={hintStyle}>Current-year subject premium</div>
          </div>
        </div>

        {resolved.attachment != null && resolved.limit != null && (
          <div style={{
            marginTop: 18,
            padding: '12px 16px',
            background: 'rgba(0,212,255,0.04)',
            border: '1px solid rgba(0,212,255,0.20)',
            borderRadius: 8,
            fontSize: 12,
            color: 'rgba(226,232,240,0.85)',
            fontVariantNumeric: 'tabular-nums',
          }}>
            Resolved layer (currency):&nbsp;
            <strong style={{ color: '#00d4ff' }}>{resolved.limit.toLocaleString('en-US', { maximumFractionDigits: 0 })}</strong>
            &nbsp;xs&nbsp;
            <strong style={{ color: '#00d4ff' }}>{resolved.attachment.toLocaleString('en-US', { maximumFractionDigits: 0 })}</strong>
            <span style={{ marginLeft: 8, color: 'rgba(148,163,184,0.55)' }}>
              · ceiling at {(((attLrN ?? 0) + (limLrN ?? 0))).toFixed(0)}% LR
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

const labelStyle = {
  fontSize: 10,
  fontWeight: 800,
  letterSpacing: '.12em',
  textTransform: 'uppercase',
  color: 'rgba(148,163,184,0.65)',
  marginBottom: 6,
};

const hintStyle = {
  fontSize: 10,
  color: 'rgba(148,163,184,0.50)',
  marginTop: 4,
};
