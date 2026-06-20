// client/src/screens/insights/ProfitabilityInsightsModal.jsx
//
// Portfolio Intelligence — unsupervised view of what drives profitability across
// the decisioned book (SIGNED / NTU / DECLINED + in-flight written states).
// Data comes from /api/portfolio-insights (one row per contract); all the maths
// — driver ranking (eta² / correlation), K-means segmentation, PCA projection —
// run client-side in ../../logic/portfolioClustering, mirroring how the
// Reinsurer Analysis modal fits its curves on the client.
//
// Three tabs:
//   Drivers  — the six requested components ranked by how much they determine
//              UW margin (η² for categoricals; |r| + decile lift for numerics).
//   Segments — natural clusters (margin EXCLUDED from clustering, overlaid after)
//              with profit label, status mix (a selection-quality read) and the
//              dominant country / region / treaty type / class of business.
//   Map      — 2-D PCA scatter, points coloured by segment.

import { useState, useEffect, useMemo } from 'react';
import {
  ResponsiveContainer, ScatterChart, Scatter, XAxis, YAxis, ZAxis,
  Tooltip, Cell, CartesianGrid,
} from 'recharts';
import { Modal } from '../../components/ui';
import { api } from '../../api';
import { analyzePortfolio } from '../../logic/portfolioClustering';

const CLUSTER_COLORS = ['#1fe08d', '#38bdf8', '#a78bfa', '#fbbf24', '#fb7185', '#34d399'];
const PROFIT_COLORS = { Profitable: '#1fe08d', Marginal: '#fbbf24', 'Loss-making': '#fb7185', Unscored: 'rgba(226,232,240,0.5)' };

const DRIVER_LABELS = {
  country: 'Country', region: 'Region', treatyType: 'Treaty type',
  cob: 'Class of business', balance: 'Balance of treaty', rol: 'Rate on line',
};

const pct = (v, d = 1) => (Number.isFinite(v) ? `${(v * 100).toFixed(d)}%` : '—');
const pp = (v, d = 1) => (Number.isFinite(v) ? `${v >= 0 ? '+' : ''}${(v * 100).toFixed(d)} pp` : '—');
const num = (v, d = 2) => (Number.isFinite(v) ? v.toFixed(d) : '—');
const money = (v) => {
  if (!Number.isFinite(v) || v <= 0) return '—';
  if (v >= 1e9) return `$${(v / 1e9).toFixed(1)}b`;
  if (v >= 1e6) return `$${(v / 1e6).toFixed(1)}m`;
  if (v >= 1e3) return `$${(v / 1e3).toFixed(0)}k`;
  return `$${v.toFixed(0)}`;
};

const card = {
  background: 'rgba(8,14,30,0.62)', border: '1px solid rgba(255,255,255,0.09)',
  borderRadius: 12, padding: 14,
};
const label = {
  fontSize: 10, fontWeight: 850, letterSpacing: '.14em', textTransform: 'uppercase',
  color: 'rgba(148,163,184,0.72)',
};
const th = {
  padding: '8px 10px', fontSize: 9, fontWeight: 850, letterSpacing: '.11em',
  color: 'rgba(148,163,184,0.68)', textTransform: 'uppercase', textAlign: 'left',
  borderBottom: '1px solid rgba(255,255,255,0.08)', whiteSpace: 'nowrap',
};
const td = { padding: '8px 10px', fontVariantNumeric: 'tabular-nums', borderBottom: '1px solid rgba(255,255,255,0.04)' };

function Stat({ k, v }) {
  return (
    <div style={{ ...card, flex: '1 1 120px', minWidth: 110 }}>
      <div style={label}>{k}</div>
      <div style={{ fontSize: 20, fontWeight: 800, color: 'var(--text)', marginTop: 6, fontVariantNumeric: 'tabular-nums' }}>{v}</div>
    </div>
  );
}

// ── Drivers tab ──
function DriversTab({ result }) {
  const drivers = result.drivers || [];
  const maxStrength = Math.max(0.0001, ...drivers.map((d) => d.strength));
  const [openKey, setOpenKey] = useState(null);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ fontSize: 12, color: 'var(--text-subtle)', lineHeight: 1.6 }}>
        How much each component determines modelled UW margin across the book. Categoricals are scored with
        the correlation ratio η² (share of margin variance the factor explains); numerics with the absolute
        correlation, shown alongside their top-vs-bottom-decile margin lift. Bars share one 0–100% strength scale.
      </div>
      {drivers.map((d, i) => {
        const open = openKey === d.key;
        const color = CLUSTER_COLORS[i % CLUSTER_COLORS.length];
        return (
          <div key={d.key} style={card}>
            <button
              onClick={() => setOpenKey(open ? null : d.key)}
              style={{ all: 'unset', cursor: 'pointer', display: 'block', width: '100%' }}
            >
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
                <div style={{ fontSize: 13, fontWeight: 800, color: 'var(--text)' }}>
                  <span style={{ color: 'rgba(148,163,184,0.6)', marginRight: 8 }}>{i + 1}</span>
                  {DRIVER_LABELS[d.key] || d.key}
                  <span style={{ ...label, marginLeft: 8 }}>{d.kind === 'numeric' ? 'numeric' : 'categorical'}</span>
                </div>
                <div style={{ fontSize: 13, fontWeight: 800, color, fontVariantNumeric: 'tabular-nums' }}>
                  {pct(d.strength, 0)}
                  <span style={{ fontSize: 10, color: 'rgba(148,163,184,0.7)', marginLeft: 6 }}>
                    {d.kind === 'numeric' ? `r=${num(d.r)}` : `η²=${num(d.eta2)}`}
                  </span>
                </div>
              </div>
              <div style={{ marginTop: 8, height: 8, borderRadius: 5, background: 'rgba(255,255,255,0.06)', overflow: 'hidden' }}>
                <div style={{ width: `${(d.strength / maxStrength) * 100}%`, height: '100%', background: color, borderRadius: 5 }} />
              </div>
            </button>

            {open && (
              <div style={{ marginTop: 12 }}>
                {d.kind === 'categorical' ? (
                  <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
                    <LevelList title="Most profitable levels" levels={d.topLevels} color="#1fe08d" />
                    <LevelList title="Least profitable levels" levels={d.bottomLevels} color="#fb7185" />
                  </div>
                ) : (
                  <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', fontSize: 12, color: 'var(--text-subtle)' }}>
                    <span>Correlation with margin: <b style={{ color: 'var(--text)' }}>{num(d.r)}</b> (n={d.n})</span>
                    <span>Top-decile margin: <b style={{ color: 'var(--text)' }}>{pct(d.topMargin)}</b></span>
                    <span>Bottom-decile margin: <b style={{ color: 'var(--text)' }}>{pct(d.bottomMargin)}</b></span>
                    <span>Decile lift: <b style={{ color: d.lift >= 0 ? '#1fe08d' : '#fb7185' }}>{pp(d.lift)}</b></span>
                  </div>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function LevelList({ title, levels, color }) {
  return (
    <div style={{ flex: '1 1 240px', minWidth: 220 }}>
      <div style={{ ...label, marginBottom: 6 }}>{title}</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        {(levels || []).filter((l) => l.label !== '(thin)').map((l) => (
          <div key={l.label} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, gap: 10 }}>
            <span style={{ color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{l.label}</span>
            <span style={{ color, fontVariantNumeric: 'tabular-nums', flex: '0 0 auto' }}>{pct(l.meanMargin)} <span style={{ color: 'rgba(148,163,184,0.6)' }}>· {l.n}</span></span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Segments tab ──
function SegmentsTab({ result }) {
  const clusters = result.clusters || [];
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ fontSize: 12, color: 'var(--text-subtle)', lineHeight: 1.6 }}>
        {result.k} natural segments found by K-means over structural features (margin excluded from clustering,
        then overlaid). The status mix doubles as a selection-quality read: ideally the profitable segments are
        mostly SIGNED and the loss-making ones mostly DECLINED / NTU.
      </div>
      <div style={{ ...card, padding: 0, overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
          <thead>
            <tr>
              <th style={th}>Segment</th>
              <th style={th}>Size</th>
              <th style={th}>Premium</th>
              <th style={{ ...th, textAlign: 'right' }}>Avg margin</th>
              <th style={{ ...th, textAlign: 'right' }}>Avg ROL</th>
              <th style={{ ...th, textAlign: 'right' }}>Avg balance</th>
              <th style={th}>Dominant profile</th>
              <th style={th}>Status mix</th>
            </tr>
          </thead>
          <tbody>
            {clusters.map((c, i) => (
              <tr key={c.cluster}>
                <td style={td}>
                  <span style={{ display: 'inline-block', width: 10, height: 10, borderRadius: 3, background: CLUSTER_COLORS[i % CLUSTER_COLORS.length], marginRight: 8 }} />
                  <span style={{ fontWeight: 800, color: PROFIT_COLORS[c.profitLabel] || 'var(--text)' }}>{c.profitLabel}</span>
                </td>
                <td style={td}>{c.size}</td>
                <td style={td}>{money(c.premium)}</td>
                <td style={{ ...td, textAlign: 'right', color: c.avgMargin >= 0 ? '#1fe08d' : '#fb7185', fontWeight: 700 }}>{pct(c.avgMargin)}</td>
                <td style={{ ...td, textAlign: 'right' }}>{Number.isFinite(c.avgRol) && c.avgRol > 0 ? pct(c.avgRol) : '—'}</td>
                <td style={{ ...td, textAlign: 'right' }}>{Number.isFinite(c.avgBalance) && c.avgBalance > 0 ? `${num(c.avgBalance)}×` : '—'}</td>
                <td style={td}>
                  <div style={{ color: 'var(--text)' }}>{c.dominantTreatyType.label} · {c.dominantCob.label}</div>
                  <div style={{ color: 'rgba(148,163,184,0.7)', fontSize: 11 }}>{c.dominantCountry.label} · {c.dominantRegion.label}</div>
                </td>
                <td style={td}><StatusBar mix={c.statusMix} size={c.size} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

const STATUS_COLORS = { SIGNED: '#1fe08d', APPROVED: '#34d399', AWAITING_SIGNED_LINE: '#38bdf8', NTU: '#fbbf24', DECLINED: '#fb7185' };
function StatusBar({ mix, size }) {
  const order = ['SIGNED', 'APPROVED', 'AWAITING_SIGNED_LINE', 'NTU', 'DECLINED'];
  const entries = order.filter((s) => mix[s]).map((s) => [s, mix[s]]);
  for (const k of Object.keys(mix)) if (!order.includes(k)) entries.push([k, mix[k]]);
  return (
    <div>
      <div style={{ display: 'flex', height: 8, borderRadius: 4, overflow: 'hidden', background: 'rgba(255,255,255,0.06)' }}>
        {entries.map(([s, n]) => (
          <div key={s} title={`${s}: ${n}`} style={{ width: `${(n / size) * 100}%`, background: STATUS_COLORS[s] || 'rgba(226,232,240,0.4)' }} />
        ))}
      </div>
      <div style={{ fontSize: 10, color: 'rgba(148,163,184,0.7)', marginTop: 4 }}>
        {entries.map(([s, n]) => `${n} ${s.replace('AWAITING_SIGNED_LINE', 'AWAIT')}`).join(' · ')}
      </div>
    </div>
  );
}

// ── Map tab (PCA scatter) ──
function MapTab({ result, rows }) {
  const data = useMemo(() => {
    const coords = result.projection?.coords || [];
    return coords.map((p, i) => ({
      x: p[0], y: p[1],
      cluster: result.assignments[i],
      margin: rows[i]?.margin,
      contractId: rows[i]?.contractId,
      treatyType: rows[i]?.treatyType,
      country: rows[i]?.country,
    }));
  }, [result, rows]);

  const byCluster = useMemo(() => {
    const m = new Map();
    for (const d of data) {
      if (!m.has(d.cluster)) m.set(d.cluster, []);
      m.get(d.cluster).push(d);
    }
    return [...m.entries()].sort((a, b) => a[0] - b[0]);
  }, [data]);

  const ex = result.projection?.explained || [0, 0];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ fontSize: 12, color: 'var(--text-subtle)', lineHeight: 1.6 }}>
        Each point is one contract, projected to the top two principal components
        (PC1 {pct(ex[0], 0)} · PC2 {pct(ex[1], 0)} of variance). Colour = segment. Tight, separated colour
        clouds mean the book really does fall into distinct structural groups.
      </div>
      <div style={{ ...card, height: 420 }}>
        <ResponsiveContainer width="100%" height="100%">
          <ScatterChart margin={{ top: 10, right: 16, bottom: 10, left: 0 }}>
            <CartesianGrid stroke="rgba(255,255,255,0.06)" />
            <XAxis type="number" dataKey="x" name="PC1" tick={{ fill: 'rgba(148,163,184,0.7)', fontSize: 11 }} stroke="rgba(148,163,184,0.3)" />
            <YAxis type="number" dataKey="y" name="PC2" tick={{ fill: 'rgba(148,163,184,0.7)', fontSize: 11 }} stroke="rgba(148,163,184,0.3)" />
            <ZAxis range={[36, 36]} />
            <Tooltip
              cursor={{ strokeDasharray: '3 3', stroke: 'rgba(255,255,255,0.2)' }}
              content={({ active, payload }) => {
                if (!active || !payload?.length) return null;
                const d = payload[0].payload;
                return (
                  <div style={{ background: 'rgba(10,16,32,0.98)', border: '1px solid rgba(255,255,255,0.12)', borderRadius: 8, padding: '8px 10px', fontSize: 11 }}>
                    <div style={{ fontWeight: 800, color: 'var(--text)' }}>{d.treatyType || '—'} · {d.country || '—'}</div>
                    <div style={{ color: 'rgba(148,163,184,0.8)' }}>Segment {d.cluster + 1} · margin {pct(d.margin)}</div>
                  </div>
                );
              }}
            />
            {byCluster.map(([cl, pts]) => (
              <Scatter key={cl} data={pts} fill={CLUSTER_COLORS[cl % CLUSTER_COLORS.length]} fillOpacity={0.78}>
                {pts.map((_, idx) => <Cell key={idx} />)}
              </Scatter>
            ))}
          </ScatterChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

// ── Shell ──
const TABS = [['drivers', 'Drivers'], ['segments', 'Segments'], ['map', 'Map']];

export default function ProfitabilityInsightsModal({ open, onClose, scope = 'treaty' }) {
  const [payload, setPayload] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [tab, setTab] = useState('drivers');

  useEffect(() => {
    if (!open) return undefined;
    let alive = true;
    setLoading(true);
    setError('');
    api.getPortfolioInsights()
      .then((d) => { if (alive) setPayload(d); })
      .catch((e) => { if (alive) setError(e?.message || 'Failed to load portfolio insights'); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [open]);

  const rows = useMemo(() => payload?.rows || [], [payload]);
  const result = useMemo(() => {
    if (!rows.length) return null;
    return analyzePortfolio(rows);
  }, [rows]);

  const meta = payload?.meta;

  return (
    <Modal open={open} onClose={onClose} title="Portfolio Intelligence — Profitability Drivers" className="pi-modal">
      <style>{`
        .ui-modal-backdrop:has(.pi-modal){padding:0;}
        .ui-modal.pi-modal{
          width:100vw;max-width:100vw;
          height:100vh;height:100dvh;max-height:100vh;max-height:100dvh;
          border-radius:0;border-left:none;border-right:none;
        }
      `}</style>

      {loading && <div style={{ padding: 40, textAlign: 'center', color: 'var(--text-subtle)' }}>Analysing the book…</div>}
      {error && <div style={{ ...card, color: '#fb7185' }}>{error}</div>}

      {!loading && !error && result && (
        <>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 14 }}>
            <Stat k="Contracts" v={meta?.count ?? rows.length} />
            <Stat k="Scored" v={meta?.scored ?? '—'} />
            <Stat k="Segments" v={result.k} />
            <Stat k="Silhouette" v={num(result.silhouette)} />
            <Stat k="Top driver" v={DRIVER_LABELS[result.drivers?.[0]?.key] || '—'} />
          </div>

          {meta?.byStatus && (
            <div style={{ ...label, marginBottom: 12 }}>
              {Object.entries(meta.byStatus).map(([s, n]) => `${s} ${n}`).join('   ·   ')}
              {scope === 'fac' && '   ·   (treaty book — fac feed pending)'}
            </div>
          )}

          <div style={{ display: 'flex', gap: 6, marginBottom: 14, borderBottom: '1px solid rgba(255,255,255,0.08)' }}>
            {TABS.map(([key, lbl]) => (
              <button
                key={key}
                onClick={() => setTab(key)}
                style={{
                  all: 'unset', cursor: 'pointer', padding: '8px 14px', fontSize: 12, fontWeight: 800,
                  letterSpacing: '.02em',
                  color: tab === key ? 'var(--accent)' : 'rgba(148,163,184,0.75)',
                  borderBottom: tab === key ? '2px solid var(--accent)' : '2px solid transparent',
                }}
              >
                {lbl}
              </button>
            ))}
          </div>

          {tab === 'drivers' && <DriversTab result={result} />}
          {tab === 'segments' && <SegmentsTab result={result} />}
          {tab === 'map' && <MapTab result={result} rows={rows} />}
        </>
      )}

      {!loading && !error && result === null && (
        <div style={{ ...card, color: 'var(--text-subtle)' }}>
          Not enough decisioned contracts to analyse yet. The module needs at least a handful of priced
          contracts across SIGNED / NTU / DECLINED.
        </div>
      )}
    </Modal>
  );
}
