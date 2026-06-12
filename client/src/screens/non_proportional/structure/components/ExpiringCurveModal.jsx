// components/ExpiringCurveModal.jsx — Expiring Structure Implied Pricing
// Curve modal (prototype: fitPowerCurve). Extracted verbatim from
// NpStructure.jsx (Phase 4.2). The curve fit is display-only analytics —
// it reads the expiring layers and never writes state.
import { toNum } from '../NpStructureHelpers';

export default function ExpiringCurveModal({ expiringLayerCount, expiringLayers, onClose }) {
  const eps = 1e-9;

  // ── Prototype fitPowerCurve: y = a * x^b, 1D search over b ──
  const fitPowerCurve = (points) => {
    const pts = (points || [])
      .map(p => ({ x: Math.max(eps, Number(p.x) || 0), y: Math.max(eps, Number(p.y) || 0) }))
      .filter(p => p.x > 0 && p.y > 0 && Number.isFinite(p.x) && Number.isFinite(p.y));
    if (pts.length < 2) return null;
    const sseForB = b => {
      let num = 0, den = 0;
      for (const p of pts) {
        const xb = Math.pow(p.x, b);
        if (!Number.isFinite(xb)) return { sse: Infinity, a: NaN };
        num += p.y * xb; den += xb * xb;
      }
      if (!den) return { sse: Infinity, a: NaN };
      const a = num / den;
      if (!Number.isFinite(a) || a <= 0) return { sse: Infinity, a };
      let sse = 0;
      for (const p of pts) { const e = p.y - a * Math.pow(p.x, b); sse += e * e; }
      return { sse, a };
    };
    let best = { sse: Infinity, a: NaN, b: NaN };
    for (let b = -6; b <= 6; b += 0.1) {
      const r = sseForB(b);
      if (r.sse < best.sse) best = { sse: r.sse, a: r.a, b };
    }
    if (!Number.isFinite(best.sse) || best.sse === Infinity) return null;
    let b0 = best.b;
    for (let step = 0.05; step >= 0.002; step /= 2) {
      let lb = best;
      for (let b = b0 - 0.2; b <= b0 + 0.2; b += step) {
        const r = sseForB(b);
        if (r.sse < lb.sse) lb = { sse: r.sse, a: r.a, b };
      }
      best = lb; b0 = best.b;
    }
    return (Number.isFinite(best.a) && Number.isFinite(best.b) && best.a > 0)
      ? { a: best.a, b: best.b } : null;
  };

  const r2ForPower = (pts, model) => {
    if (!model || pts.length < 2) return NaN;
    const meanY = pts.reduce((s, p) => s + p.y, 0) / pts.length;
    let ssTot = 0, ssRes = 0;
    for (const p of pts) {
      const yhat = model.a * Math.pow(Math.max(1e-6, p.x), model.b);
      ssTot += (p.y - meanY) ** 2;
      ssRes += (p.y - yhat) ** 2;
    }
    const r2 = 1 - ssRes / ssTot;
    return Number.isFinite(r2) ? r2 : NaN;
  };

  // ── Build points: x = √((Att+Lim)×Att) / EGNPI, y = ROL as fraction ──
  const expLys = Array.from({ length: expiringLayerCount }, (_, i) => ({
    layer: i + 1,
    limit: '', deductible: '', egnpi: '', earnedPremium: '', rate: '', rol: '',
    ...(expiringLayers[i] || {}),
  }));
  const egnpiOverall = Math.max(0, ...expLys.map(l => toNum(l.egnpi)).filter(n => n > 0));
  const pts = egnpiOverall > 0 ? expLys.map(l => {
    const ded = toNum(l.deductible ?? l.attachment);
    const lim = toNum(l.limit);
    if (ded <= 0 || lim <= 0) return null;
    const top = ded + lim;
    const epN = toNum(l.earnedPremium);
    const rolRaw = parseFloat(String(l.rol || l.rate || '').replace(/%/g, '')) || 0;
    const rol01 = (lim > 0 && epN > 0) ? epN / lim : rolRaw / 100;
    if (!rol01 || rol01 <= 0) return null;
    const x = Math.sqrt(top * ded) / egnpiOverall;
    return (Number.isFinite(x) && x > 0) ? { x, y: rol01, layer: l.layer } : null;
  }).filter(Boolean) : [];

  const model = fitPowerCurve(pts);
  const r2 = r2ForPower(pts, model);

  // ── SVG rendering ──
  const renderSVG = () => {
    if (pts.length < 2 || !model) return null;
    const W = 860, H = 300, padL = 54, padR = 18, padT = 24, padB = 38;
    const xs = pts.map(p => p.x), ys = pts.map(p => p.y);
    const x0 = Math.max(0, Math.min(...xs) * 0.85);
    const x1 = Math.max(...xs) * 1.15;
    const y0 = Math.max(0, Math.min(...ys) * 0.85);
    const y1 = Math.max(...ys) * 1.15;
    const sx = x => padL + ((x - x0) / (x1 - x0 || 1)) * (W - padL - padR);
    const sy = y => H - padB - ((y - y0) / (y1 - y0 || 1)) * (H - padT - padB);
    let pathD = '';
    for (let i = 0; i <= 80; i++) {
      const x = x0 + (i / 80) * (x1 - x0);
      const y = model.a * Math.pow(Math.max(eps, x), model.b);
      pathD += `${i === 0 ? 'M' : 'L'}${sx(x).toFixed(2)},${sy(y).toFixed(2)}`;
    }
    const label = `ROL = ${(model.a * 100).toFixed(4)}% × x^${model.b.toFixed(4)}${Number.isFinite(r2) ? `  |  R² = ${r2.toFixed(3)}` : ''}`;
    return (
      <svg width="100%" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMid meet" className="crisp-grid" style={{ display: 'block', fontFamily: 'inherit', fontVariantNumeric: 'tabular-nums' }} role="img" aria-label="Implied power curve">
        <line x1={padL} y1={padT} x2={padL} y2={H - padB} stroke="rgba(255,255,255,0.30)" shapeRendering="crispEdges" vectorEffect="non-scaling-stroke" />
        <line x1={padL} y1={H - padB} x2={W - padR} y2={H - padB} stroke="rgba(255,255,255,0.30)" shapeRendering="crispEdges" vectorEffect="non-scaling-stroke" />
        <text x={padL + 6} y={padT + 14} fontSize={12} fontWeight="600" fill="rgba(255,255,255,0.85)">{label}</text>
        <path d={pathD} fill="none" stroke="var(--accent, #3b82f6)" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" opacity={0.95} vectorEffect="non-scaling-stroke" />
        {pts.map((p, i) => (
          <g key={i}>
            <circle cx={sx(p.x).toFixed(2)} cy={sy(p.y).toFixed(2)} r={4} fill="var(--accent, #3b82f6)" opacity={0.95} />
            <text x={+sx(p.x).toFixed(2) + 6} y={+sy(p.y).toFixed(2) + 4} fontSize={10} fontWeight="500" fill="rgba(255,255,255,0.75)">L{p.layer}</text>
          </g>
        ))}
        <text x={padL} y={H - 8} fontSize={11} fontWeight="500" fill="rgba(255,255,255,0.65)">x = √((Att+Lim)×Att) / EGNPI</text>
        <text x={10} y={padT + 4} fontSize={11} fontWeight="500" fill="rgba(255,255,255,0.65)">ROL</text>
      </svg>
    );
  };

  return (
    <div
      className="modal-backdrop"
      role="presentation"
      style={{ position: 'fixed', inset: 0, zIndex: 1200, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(0,0,0,0.65)' }}
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="glass" role="dialog" aria-modal="true" style={{ background: 'var(--glass-bg, #0d1117)', border: '1px solid rgba(0,212,255,0.25)', borderRadius: 12, width: '92vw', maxWidth: 1000, maxHeight: '80vh', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '14px 20px', borderBottom: '1px solid rgba(255,255,255,0.08)' }}>
          <div>
            <div style={{ fontWeight: 800, fontSize: 14, letterSpacing: '.06em', color: '#e2e8f0' }}>IMPLIED PRICING CURVE</div>
            <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.45)', marginTop: 2 }}>
              Fitted from expiring layer attachments and tops. Requires at least two expiring layers with EGNPI and ROL.
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            style={{ background: 'none', border: '1px solid rgba(255,255,255,0.15)', color: 'rgba(255,255,255,0.6)', borderRadius: 6, padding: '4px 12px', cursor: 'pointer', fontSize: 13 }}>
            ✕ Close
          </button>
        </div>
        <div style={{ overflowY: 'auto', padding: '16px 20px', flex: 1 }}>
          {pts.length < 2 ? (
            <p style={{ color: 'rgba(255,255,255,0.4)', textAlign: 'center', padding: 32 }}>
              Enter Limit, Deductible, EGNPI and ROL (or Rate) for at least two expiring layers to display the implied power curve.
            </p>
          ) : !model ? (
            <p style={{ color: 'rgba(255,255,255,0.4)', textAlign: 'center', padding: 32 }}>
              Unable to fit a curve from the current layer points.
            </p>
          ) : (
            <>
              {renderSVG()}
              <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.32)', marginTop: 12, borderTop: '1px solid rgba(255,255,255,0.07)', paddingTop: 10 }}>
                Model: ROL = a × x^b &nbsp;|&nbsp; x = √((Attachment + Limit) × Attachment) / EGNPI &nbsp;|&nbsp; Fitted by least-squares search over b ∈ [−6, 6].
                {Number.isFinite(r2) && <span style={{ marginLeft: 16 }}>R² = {r2.toFixed(3)}</span>}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
