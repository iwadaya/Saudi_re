import { useState, useEffect, useCallback, useId, useRef, useMemo } from 'react';
import { api } from '../../../api';
import { useContractId } from '../../../hooks/useContractId';
import { useAppState } from '../../../context/AppContext';
import { ACTIVE_QUOTE_ID } from '../../../constants/storageKeys';
import WizardLayout from '../../../components/WizardLayout';
import PctInput from '../../../components/PctInput';
import { formatWithCommas, sanitizeNumber, toN, toNullableN } from '../../../utils/format';
import { getNpTreatyTypeMode, isNpStopLossTreaty } from '../../../utils/npTreatyType';
import { handleStaleWrite } from '../../../utils/handleStaleWrite';
import NpStopLossExpiring from './NpStopLossExpiring';
import { logger } from '../../../utils/logger';
import CoveredProportionalSection from './CoveredProportionalSection';

const ROUTE_KEY = 'NP_EXPIRING_STRUCTURE';

function toInt(v) { const n = parseInt(String(v ?? '').replace(/[^0-9-]/g, ''), 10); return Number.isFinite(n) ? n : 0; }
function fmtC(v) { return formatWithCommas(v); }
function pctVal(v) { const n = parseFloat(String(v ?? '').replace(/[^0-9.-]/g, '')); return Number.isFinite(n) ? n : 0; }

// Layer field mapping: screen state (camelCase) ↔ server DB (snake_case)
function serverLayerToLocal(sl, i) {
  return {
    layer:         `L${sl.layer_number || i + 1}`,
    layerNumber:   sl.layer_number || i + 1,
    limit:         sl.layer_limit        != null ? String(sl.layer_limit)        : '',
    deductible:    sl.attachment         != null ? String(sl.attachment)         : '',
    aggregateLimit:sl.aggregate_limit    != null ? String(sl.aggregate_limit)    : '',
    egnpi:         sl.egnpi              != null ? String(sl.egnpi)              : '',
    rate:          sl.rate               != null ? String(sl.rate)               : '',
    earnedPremium: sl.earned_premium     != null ? String(sl.earned_premium)     : '',
    mdp:           sl.mdp                != null ? String(sl.mdp)                : '',
    mdpPct:        sl.mdp_pct            != null ? String(sl.mdp_pct)            : '',
    noReinst:      sl.num_reinstatements != null ? String(sl.num_reinstatements) : '',
    pctReinst:     sl.reinstatement_pct  != null ? String(sl.reinstatement_pct)  : '',
    aad:           !!sl.annual_agg_deductible,
    aadAmount:     sl.annual_agg_deductible != null ? String(sl.annual_agg_deductible) : '',
    risk:          sl.peril_scope === 'RISK' || sl.peril_scope === 'BOTH',
    cat:           sl.peril_scope === 'CAT'  || sl.peril_scope === 'BOTH',
    rol:           sl.rol                != null ? String(sl.rol)                : '',
  };
}

function localLayerToServer(l, i) {
  const peril_scope = l.risk && l.cat ? 'BOTH' : l.risk ? 'RISK' : l.cat ? 'CAT' : 'BOTH';
  return {
    layer_number:          l.layerNumber || i + 1,
    attachment:            toNullableN(l.deductible),
    layer_limit:           toNullableN(l.limit),
    aggregate_limit:       toNullableN(l.aggregateLimit),
    egnpi:                 toNullableN(l.egnpi),
    earned_premium:        toNullableN(l.earnedPremium),
    rate:                  toNullableN(l.rate),
    rol:                   toNullableN(l.rol),
    num_reinstatements:    toNullableN(l.noReinst),
    reinstatement_pct:     toNullableN(l.pctReinst),
    annual_agg_deductible: l.aad ? toNullableN(l.aadAmount) : null,
    peril_scope,
    mdp:                   toNullableN(l.mdp),
    mdp_pct:               toNullableN(l.mdpPct),
  };
}

function emptyLayer(i) {
  return { layer: `L${i + 1}`, layerNumber: i + 1, limit: '', deductible: '', aggregateLimit: '',
    egnpi: '', rate: '', earnedPremium: '', mdp: '', mdpPct: '', noReinst: '', pctReinst: '',
    aad: false, aadAmount: '', risk: false, cat: false, rol: '' };
}

function emptyCoveredProp() {
  return { programme: '', qsLimit: '', retentionPct: '', surplusLines: '' };
}

// ── CoveredProportionalSection ─────────────────────────────────────────────

export default function NpExpiringStructure() {
  const contractId = useContractId();
  const { state: appState, setSlice } = useAppState();
  const [layers, setLayers] = useState([]);
  const [terms, setTerms] = useState({ brokerage_pct: '', no_claims_bonus_pct: '', profit_commission_pct: '' });
  const [numLayersInput, setNumLayersInput] = useState('');
  const numLayersSelectId = useId();
  const [coveredProps, setCoveredProps] = useState([]);
  const [loading, setLoading] = useState(false);
  const [autoPopMsg, setAutoPopMsg] = useState('');
  const [saveMsg, setSaveMsg] = useState('');
  const [showCurveModal, setShowCurveModal] = useState(false);
  // Parent-entity timestamp for optimistic locking. Seeded from the load
  // response and updated after each successful save, so a concurrent
  // save by NpStructure (which writes the same expiring endpoint with
  // its own If-Unmodified-Since) returns STALE_WRITE here instead of
  // silently clobbering.
  const [lastUpdatedAt, setLastUpdatedAt] = useState(null);
  const dirty = useRef(false);
  const loaded = useRef(false);

  const npDetail = useMemo(() => appState.npTreatyDetail || {}, [appState.npTreatyDetail]);
  const mode = getNpTreatyTypeMode(appState);
  const currency = npDetail.currencyCode || npDetail.currency || 'SAR';

  const handleNumLayersChange = useCallback((val) => {
    const n = Math.max(0, parseInt(val, 10) || 0);
    setNumLayersInput(val);
    setLayers(prev => {
      const next = [...prev];
      while (next.length < n) next.push(emptyLayer(next.length));
      return next.slice(0, n);
    });
    dirty.current = true;
    setSlice('npTreatyDetail', { expiringNumberOfLayers: String(n) });
  }, [setSlice]);

  // Load from dedicated expiring endpoint
  useEffect(() => {
    if (!contractId) return;
    setLoading(true);
    // Cancel-token: if the effect re-fires (e.g. quoteMode toggles mid-edit)
    // before this fetch resolves, we must NOT apply the stale response on top
    // of the user's edits. Closure-captured boolean is enough — no abort
    // controller needed because we only need to ignore the result.
    let cancelled = false;
    // Determine quote mode: appState is authoritative, but fall back to localStorage
    // in case RESET_FLOW hasn't propagated yet when this effect fires
    const isQuote = appState.quoteMode || (() => {
      try { return localStorage.getItem(ACTIVE_QUOTE_ID) === contractId; } catch { return false; }
    })();
    api.getNpExpiring(contractId, isQuote ? { quote: true } : undefined)
      .then(data => {
        if (cancelled) return;
        // Seed the optimistic-lock baseline even if we're going to skip
        // the rest of the load (dirty + already-loaded path) — the
        // freshly-fetched parent timestamp is still the most recent
        // value we've seen for the lock.
        if (data?.updated_at) setLastUpdatedAt(data.updated_at);
        // Don't clobber unsaved edits with a fresh load. This matters when the
        // effect re-runs because of a non-contract dep change (quoteMode) and
        // the user already has dirty state on screen.
        if (dirty.current && loaded.current) return;
        const serverLayers = Array.isArray(data?.layers) ? data.layers : [];
        const serverTerms  = data?.terms || {};

        const localLayers = serverLayers.map((sl, i) => serverLayerToLocal(sl, i));
        const count = localLayers.length;

        // If server has no saved expiring layers yet, seed layer count from treaty detail field
        const seedCount = count > 0 ? count
          : parseInt(npDetail.expiringNumberOfLayers || npDetail.expiring_number_of_layers || '0', 10) || 0;

        if (seedCount > 0 && count === 0) {
          const seeded = Array.from({ length: seedCount }, (_, i) => emptyLayer(i));
          setNumLayersInput(String(seedCount));
          setLayers(seeded);
          dirty.current = false; // do NOT mark dirty — seeding empty layers should NOT trigger save
        } else {
          setNumLayersInput(count > 0 ? String(count) : '');
          setLayers(localLayers);
        }
        setTerms({
          brokerage_pct:         serverTerms.brokerage_pct         != null ? String(serverTerms.brokerage_pct)         : '',
          no_claims_bonus_pct:   serverTerms.no_claims_bonus_pct   != null ? String(serverTerms.no_claims_bonus_pct)   : '',
          profit_commission_pct: serverTerms.profit_commission_pct != null ? String(serverTerms.profit_commission_pct) : '',
        });

        if (data?.autoPopulated) {
          setAutoPopMsg('Auto-populated from parent contract structure. Review and save to confirm.');
        }

        if (seedCount > 0) setSlice('npTreatyDetail', { expiringNumberOfLayers: String(seedCount) });

        // coveredProps: prefer DB-returned value, fall back to JSONB appState for older contracts
        const dbCoveredProps = Array.isArray(data?.coveredProps) ? data.coveredProps : null;
        if (dbCoveredProps && dbCoveredProps.length > 0) {
          setCoveredProps(dbCoveredProps);
        } else {
          const jsonbExp = (appState.npStructure || {}).expiringStructure || {};
          const cp = jsonbExp.coveredProps || jsonbExp.covered_props || [];
          setCoveredProps(cp.length > 0 ? cp : [emptyCoveredProp()]);
        }
        loaded.current = true;
      })
      .catch((e) => {
        if (cancelled) return;
        // The server now returns a real 5xx on load failures (it used to mask
        // them as empty 200s). Refuse to overwrite local state with empties —
        // a subsequent save would then DELETE the user's saved row. Surface
        // the failure and let the user retry instead.
        logger.warn('NP Expiring Structure load failed:', e);
        setSaveMsg(dirty.current
          ? 'Load failed — your unsaved edits are preserved. Refresh to retry.'
          : 'Load failed — refresh to retry.');
        // First-ever load + nothing dirty: the form is blank either way, so
        // unblock saves by marking loaded. Otherwise we keep the prior good
        // state on screen and leave loaded as it was.
        if (!loaded.current && !dirty.current) {
          setNumLayersInput('');
          setLayers([]);
          setCoveredProps([emptyCoveredProp()]);
          loaded.current = true;
        }
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [contractId, appState.quoteMode, appState.npStructure, npDetail.expiringNumberOfLayers, npDetail.expiring_number_of_layers, setSlice]);

  // Recalculate derived fields per layer
  const recalcLayer = useCallback((l, idx, allLayers) => {
    const limit        = toInt(l.limit);
    const egnpi        = toInt(l.egnpi);
    const rate         = pctVal(l.rate);
    const earnedPremium = rate > 0 && egnpi > 0 ? Math.round(egnpi * rate / 100) : toInt(l.earnedPremium);
    const mdp          = toInt(l.mdp);
    const mdpPct       = earnedPremium > 0 && mdp > 0 ? ((mdp / earnedPremium) * 100).toFixed(2) : '';
    const rol          = limit > 0 && earnedPremium > 0 ? ((earnedPremium / limit) * 100).toFixed(4) : '';

    let deductible = l.deductible;
    if (idx === 0) {
      const fromDetail = toInt(npDetail.deductible || npDetail.retention || 0);
      if (!deductible && fromDetail) deductible = String(fromDetail);
    } else if (idx > 0 && allLayers[idx - 1]) {
      const prevDed = toInt(allLayers[idx - 1].deductible);
      const prevLim = toInt(allLayers[idx - 1].limit);
      if (prevDed + prevLim > 0) deductible = String(prevDed + prevLim);
    }
    return { ...l, deductible, earnedPremium: String(earnedPremium || l.earnedPremium || ''), mdpPct, rol };
  }, [npDetail]);

  const updateLayer = useCallback((idx, field, value) => {
    setLayers(prev => {
      const next = [...prev];
      next[idx] = { ...next[idx], [field]: value };
      return next.map((l, i) => recalcLayer(l, i, next));
    });
    dirty.current = true;
  }, [recalcLayer]);

  const updateTerms = useCallback((field, value) => {
    setTerms(prev => ({ ...prev, [field]: value }));
    dirty.current = true;
  }, []);

  // Save to dedicated expiring endpoint
  const save = useCallback(async (opts = {}) => {
    if (!contractId) return true;
    // Don't save if load hasn't completed — would overwrite DB with empty state
    if (!loaded.current) return true;
    // Don't save if nothing changed (unless explicitly forced)
    if (!dirty.current && !opts.force) return true;
    // Only block if absolutely nothing has been touched AND not forced
    // (dirty flag is the primary gate — don't block saves that user explicitly triggered)
    const payload = {
      layers: layers.map((l, i) => localLayerToServer(l, i)),
      terms: {
        brokerage_pct:         toNullableN(terms.brokerage_pct),
        no_claims_bonus_pct:   toNullableN(terms.no_claims_bonus_pct),
        profit_commission_pct: toNullableN(terms.profit_commission_pct),
      },
      coveredProps: coveredProps.filter(r => r.programme || r.qsLimit || r.retentionPct || r.surplusLines),
    };
    const isQuoteSave = appState.quoteMode || (() => {
      try { return localStorage.getItem(ACTIVE_QUOTE_ID) === contractId; } catch { return false; }
    })();
    // Optimistic-lock plumbing mirrors NpStructure: the special '*'
    // override is what the stale-write modal's "overwrite" branch
    // sends, bypassing the lock for that one retry.
    const lockOverride = opts?.ifUnmodifiedSince;
    const activeLock = lockOverride || lastUpdatedAt;
    const requestOpts = isQuoteSave
      ? { quote: true, ...(activeLock ? { ifUnmodifiedSince: activeLock } : {}) }
      : (activeLock ? { ifUnmodifiedSince: activeLock } : undefined);
    try {
      const response = await api.saveNpExpiring(contractId, payload, requestOpts);
      if (response?.updated_at) setLastUpdatedAt(response.updated_at);
      dirty.current = false;
      setSaveMsg('Saved ✓');
      setTimeout(() => setSaveMsg(''), 2000);
      return true;
    } catch (e) {
      logger.warn('NP Expiring Structure save failed:', e);
      if (lockOverride !== '*') {
        const stale = await handleStaleWrite(e, {
          entityType: isQuoteSave ? 'quote expiring structure' : 'expiring structure',
          onRefresh: () => window.location.reload(),
          onOverwrite: () => save({ ...opts, ifUnmodifiedSince: '*' }),
        });
        if (stale.handled) return stale.action === 'overwrite' ? !!stale.result : false;
      }
      setSaveMsg('Save failed');
      return opts.quiet ? true : false;
    }
  }, [contractId, layers, terms, coveredProps, appState.quoteMode, lastUpdatedAt]);

  const handleManualSave = useCallback(async () => {
    dirty.current = true; // force save even if no changes detected
    await save({ force: true });
  }, [save]);

  // Totals row
  const totals = layers.reduce((acc, l) => {
    const lim = toInt(l.limit);
    const rol = pctVal(l.rol);
    return {
      limit:          acc.limit          + lim,
      deductible:     acc.deductible,
      aggregateLimit: acc.aggregateLimit + toInt(l.aggregateLimit),
      egnpi:          acc.egnpi          + toInt(l.egnpi),
      earnedPremium:  acc.earnedPremium  + toInt(l.earnedPremium),
      mdp:            acc.mdp            + toInt(l.mdp),
      // SUMPRODUCT(limit × ROL) numerator — divide by totalLimit for weighted avg ROL
      rolNumerator:   acc.rolNumerator   + (lim > 0 && rol > 0 ? lim * rol : 0),
    };
  }, { limit: 0, deductible: 0, aggregateLimit: 0, egnpi: 0, earnedPremium: 0, mdp: 0, rolNumerator: 0 });

  // Weighted average ROL = SUMPRODUCT(limit × ROL) / totalLimit
  const weightedRol = totals.limit > 0 && totals.rolNumerator > 0
    ? (totals.rolNumerator / totals.limit).toFixed(4)
    : '';

  // coveredPropsWithCalc computed inside CoveredProportionalSection

  const stopLossTreaty = isNpStopLossTreaty(appState);

  return (
    <WizardLayout routeKey={ROUTE_KEY} title="Expiring Structure & Terms" headerPill="NP: EXPIRING STRUCTURE" onBeforeNext={save} onBeforeBack={save}>
      {() => (
        <div className="NP_EXPIRING_STRUCTURE">
          {stopLossTreaty ? (
            <NpStopLossExpiring currency={currency} />
          ) : loading ? (
            <div className="df-card df-card--notice"><div className="df-note">Loading…</div></div>
          ) : (
            <>
              {autoPopMsg && (
                <div className="df-card df-card--notice" style={{ marginBottom: 12 }}>
                  <div className="df-note" style={{ color: 'var(--accent)' }}>ℹ {autoPopMsg}</div>
                </div>
              )}

              {/* Header: layer count + terms */}
              <section className="np-struct-card glass" style={{ marginBottom: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 24, padding: '14px 18px', flexWrap: 'wrap' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <label htmlFor={numLayersSelectId} style={{ fontSize: 11, fontWeight: 800, letterSpacing: '0.14em', color: 'rgba(var(--text-rgb),0.7)', whiteSpace: 'nowrap', textTransform: 'uppercase' }}>LAYERS</label>
                    <select id={numLayersSelectId} className="np-mini-input np-mini-select" style={{ width: 90 }} value={numLayersInput} onChange={e => handleNumLayersChange(e.target.value)}>
                      <option value="">—</option>
                      {[1,2,3,4,5,6,7,8,9,10,11,12].map(n => <option key={n} value={n}>{n}</option>)}
                    </select>
                  </div>
                  {[
                    { key: 'brokerage_pct',         label: 'BROKERAGE %' },
                    { key: 'no_claims_bonus_pct',   label: 'NCB %' },
                    { key: 'profit_commission_pct', label: 'PROFIT COMM. %' },
                  ].map(({ key, label }) => (
                    <div key={key} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <label style={{ fontSize: 11, fontWeight: 800, letterSpacing: '0.14em', color: 'rgba(var(--text-rgb),0.58)', whiteSpace: 'nowrap', textTransform: 'uppercase' }}>{label}</label>
                      <PctInput
                        className="np-mini-input np-mini-input--center"
                        style={{ width: 90 }}
                        value={terms[key]}
                        placeholder="—%"
                        onChange={v => updateTerms(key, v)}
                      />
                    </div>
                  ))}
                  <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 10 }}>
                    {saveMsg && <span style={{ fontSize: 12, color: saveMsg.includes('failed') ? 'var(--accent-rose)' : 'var(--accent)' }}>{saveMsg}</span>}
                    <button className="np-green-pill" type="button" onClick={handleManualSave}>SAVE</button>
                  </div>
                </div>
              </section>

              {/* Layers table */}
              <section className="np-struct-card glass">
                <div className="np-struct-card-header">
                  <div>
                    <div className="np-struct-card-title">EXPIRING TREATY STRUCTURE – LAYERS</div>
                    <div className="np-struct-card-hint">New business — enter expiring market terms manually for YoY comparison in pricing metrics.</div>
                  </div>
                  <div className="np-struct-card-actions">
                    <button className="np-green-pill" type="button" onClick={() => setShowCurveModal(true)}>⬥ VIEW IMPLIED PRICING CURVE</button>
                    <div className="np-type-pills">
                      <span className={`np-type-pill ${mode === 'RISK' || mode === 'BOTH' ? 'is-on' : 'is-off'}`}>RISK XL</span>
                      <span className={`np-type-pill ${mode === 'CAT'  || mode === 'BOTH' ? 'is-on' : 'is-off'}`}>CAT XL</span>
                    </div>
                  </div>
                </div>
                <div className="np-table-wrap np-table-wrap--scroll np-table-wrap--wide">
                  <table className="np-struct-table np-struct-table--wide">
                    <thead>
                      <tr>
                        <th className="np-table-sticky cell-center">LAYER</th>
                        <th className="np-col">LIMIT</th>
                        <th className="np-col">DEDUCTIBLE / ATTACHMENT</th>
                        <th className="np-col">AGGREGATE LIMIT</th>
                        <th className="np-col">EGNPI</th>
                        <th className="np-col-rate cell-center">RATE %</th>
                        <th className="np-col">EARNED PREM</th>
                        <th className="np-col">MDP</th>
                        <th className="np-col-mdp-pct cell-center">MDP%</th>
                        <th className="np-col-reinst cell-center">REINST #</th>
                        <th className="np-col-reinst cell-center">REINST %</th>
                        <th className="np-col-chk cell-center">AAD</th>
                        <th className="np-col">AAD AMT</th>
                        <th className="np-col-chk cell-center">RISK</th>
                        <th className="np-col-chk cell-center">CAT</th>
                        <th className="np-col-rol cell-center">ROL%</th>
                      </tr>
                    </thead>
                    <tbody>
                      {layers.map((l, i) => (
                        <tr key={i}>
                          <th className="np-table-sticky cell-center">{l.layer || `L${i + 1}`}</th>
                          <td className="np-col"><div className="np-cell-input"><input className="np-mini-input np-mini-input--center" value={fmtC(l.limit)} onChange={e => updateLayer(i, 'limit', sanitizeNumber(e.target.value))} placeholder="—" /><span className="np-sfx">{currency}</span></div></td>
                          <td className="np-col"><div className="np-cell-input"><input className="np-mini-input np-mini-input--center" value={fmtC(l.deductible)} onChange={e => updateLayer(i, 'deductible', sanitizeNumber(e.target.value))} placeholder="—" /><span className="np-sfx">{currency}</span></div></td>
                          <td className="np-col"><div className="np-cell-input"><input className="np-mini-input np-mini-input--center" value={fmtC(l.aggregateLimit)} onChange={e => updateLayer(i, 'aggregateLimit', sanitizeNumber(e.target.value))} placeholder="—" /><span className="np-sfx">{currency}</span></div></td>
                          <td className="np-col"><div className="np-cell-input"><input className="np-mini-input np-mini-input--center" value={fmtC(l.egnpi)} onChange={e => updateLayer(i, 'egnpi', sanitizeNumber(e.target.value))} placeholder="—" /><span className="np-sfx">{currency}</span></div></td>
                          <td className="np-col-rate cell-center"><div className="np-cell-input"><PctInput className="np-mini-input np-mini-input--center" value={l.rate} onChange={v => updateLayer(i, 'rate', v)} placeholder="—%" /></div></td>
                          <td className="np-col"><div className="np-cell-input"><input className="np-mini-input np-mini-input--center" value={fmtC(l.earnedPremium)} onChange={e => updateLayer(i, 'earnedPremium', sanitizeNumber(e.target.value))} placeholder="—" /><span className="np-sfx">{currency}</span></div></td>
                          <td className="np-col"><div className="np-cell-input"><input className="np-mini-input np-mini-input--center" value={fmtC(l.mdp)} onChange={e => updateLayer(i, 'mdp', sanitizeNumber(e.target.value))} placeholder="—" /><span className="np-sfx">{currency}</span></div></td>
                          <td className="np-col-mdp-pct cell-center"><div className="np-cell-input"><PctInput className="np-mini-input np-mini-input--center np-mini-input--readonly" readOnly value={l.mdpPct || ''} onChange={() => {}} placeholder="—%" /></div></td>
                          <td className="np-col-reinst cell-center"><div className="np-cell-input"><input className="np-mini-input np-mini-input--center" value={l.noReinst} onChange={e => updateLayer(i, 'noReinst', e.target.value)} placeholder="—" /></div></td>
                          <td className="np-col-reinst cell-center"><div className="np-cell-input"><PctInput className="np-mini-input np-mini-input--center" value={l.pctReinst} onChange={v => updateLayer(i, 'pctReinst', v)} placeholder="—%" /></div></td>
                          <td className="np-col-chk cell-center"><input type="checkbox" className="np-check" checked={!!l.aad} onChange={e => updateLayer(i, 'aad', e.target.checked)} /></td>
                          <td className="np-col"><div className="np-cell-input"><input className={`np-mini-input np-mini-input--center${!l.aad ? ' np-mini-input--readonly' : ''}`} value={fmtC(l.aadAmount)} onChange={e => updateLayer(i, 'aadAmount', sanitizeNumber(e.target.value))} disabled={!l.aad} placeholder="—" /><span className="np-sfx">{currency}</span></div></td>
                          <td className="np-col-chk cell-center"><input type="checkbox" className="np-check" checked={!!l.risk} onChange={e => updateLayer(i, 'risk', e.target.checked)} /></td>
                          <td className="np-col-chk cell-center"><input type="checkbox" className="np-check" checked={!!l.cat} onChange={e => updateLayer(i, 'cat', e.target.checked)} /></td>
                          <td className="np-col-rol cell-center"><div className="np-cell-input"><input className="np-mini-input np-mini-input--center np-mini-input--readonly" readOnly value={l.rol ? `${l.rol}%` : ''} placeholder="—" style={l.rol ? { borderColor: 'rgba(0,212,255,0.55)', borderWidth: 2 } : undefined} /></div></td>
                        </tr>
                      ))}
                    </tbody>
                    {layers.length > 1 && (
                      <tfoot>
                        <tr style={{ borderTop: '2px solid rgba(0,212,255,0.45)', background: 'rgba(0,212,255,0.06)' }}>
                          <th className="np-table-sticky cell-center" style={{ color: 'var(--accent-blue)', fontSize: 10, letterSpacing: '.08em', fontWeight: 800, background: 'rgba(0,212,255,0.08)' }}>TOTAL</th>
                          <td className="np-col"><div className="np-cell-input"><input className="np-mini-input np-mini-input--center np-mini-input--readonly" readOnly value={fmtC(totals.limit)} placeholder="—" /><span className="np-sfx">{currency}</span></div></td>
                          <td className="np-col"><div className="np-cell-input"><input className="np-mini-input np-mini-input--center np-mini-input--readonly" readOnly value={layers[0]?.deductible ? fmtC(layers[0].deductible) : '—'} placeholder="—" /><span className="np-sfx">{currency}</span></div></td>
                          <td className="np-col"><div className="np-cell-input"><input className="np-mini-input np-mini-input--center np-mini-input--readonly" readOnly value={totals.aggregateLimit ? fmtC(totals.aggregateLimit) : ''} placeholder="—" /><span className="np-sfx">{currency}</span></div></td>
                          <td className="np-col"><div className="np-cell-input"><input className="np-mini-input np-mini-input--center np-mini-input--readonly" readOnly value={fmtC(totals.egnpi)} placeholder="—" /><span className="np-sfx">{currency}</span></div></td>
                          <td className="np-col-rate"><div className="np-cell-input"><input className="np-mini-input np-mini-input--center np-mini-input--readonly" readOnly value="" placeholder="—" /></div></td>
                          <td className="np-col"><div className="np-cell-input"><input className="np-mini-input np-mini-input--center np-mini-input--readonly" readOnly value={fmtC(totals.earnedPremium)} placeholder="—" /><span className="np-sfx">{currency}</span></div></td>
                          <td className="np-col"><div className="np-cell-input"><input className="np-mini-input np-mini-input--center np-mini-input--readonly" readOnly value={totals.mdp ? fmtC(totals.mdp) : ''} placeholder="—" /><span className="np-sfx">{currency}</span></div></td>
                          <td colSpan={3}></td>
                          <td className="np-col-rol cell-center"><div className="np-cell-input"><input className="np-mini-input np-mini-input--center np-mini-input--readonly" readOnly value={weightedRol ? `${weightedRol}%` : ''} placeholder="—" style={weightedRol ? { borderColor: 'rgba(0,212,255,0.55)', borderWidth: 2 } : undefined} /></div></td>
                          <td colSpan={4}></td>
                        </tr>
                      </tfoot>
                    )}
                  </table>
                </div>
                <div className="np-struct-footnote">
                  Expiring structure is used to auto-populate year-on-year metrics in Final Pricing.
                </div>
              </section>

              {/* Covered Proportional Structure */}
              <CoveredProportionalSection
                coveredProps={coveredProps}
                setCoveredProps={setCoveredProps}
                onDirty={() => { dirty.current = true; }}
                currency={currency}
                cedantId={npDetail.cedantId}
                countryId={npDetail.countryId}
              />

              {/* Implied Pricing Curve Modal */}
              {showCurveModal && (() => {
                const eps = 1e-9;

                // Power-law curve fit: ROL = a × x^b
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
                  return (Number.isFinite(best.a) && Number.isFinite(best.b) && best.a > 0) ? { a: best.a, b: best.b } : null;
                };

                const r2ForPower = (pts, model) => {
                  if (!model || pts.length < 2) return NaN;
                  const meanY = pts.reduce((s, p) => s + p.y, 0) / pts.length;
                  let ssTot = 0, ssRes = 0;
                  for (const p of pts) {
                    const yhat = model.a * Math.pow(Math.max(1e-6, p.x), model.b);
                    ssTot += (p.y - meanY) ** 2; ssRes += (p.y - yhat) ** 2;
                  }
                  const r2 = 1 - ssRes / ssTot;
                  return Number.isFinite(r2) ? r2 : NaN;
                };

                // Build points: x = √((Att+Lim)×Att) / EGNPI, y = ROL fraction
                const egnpiOverall = Math.max(0, ...layers.map(l => toN(l.egnpi)).filter(n => n > 0));
                const pts = egnpiOverall > 0 ? layers.map((l, i) => {
                  const ded = toN(l.deductible);
                  const lim = toN(l.limit);
                  if (ded <= 0 || lim <= 0) return null;
                  const epN = toN(l.earnedPremium);
                  const rolRaw = parseFloat(String(l.rol || l.rate || '').replace(/%/g, '')) || 0;
                  const rol01 = (lim > 0 && epN > 0) ? epN / lim : rolRaw / 100;
                  if (!rol01 || rol01 <= 0) return null;
                  const x = Math.sqrt((ded + lim) * ded) / egnpiOverall;
                  return (Number.isFinite(x) && x > 0) ? { x, y: rol01, layer: i + 1 } : null;
                }).filter(Boolean) : [];

                const model = fitPowerCurve(pts);
                const r2 = r2ForPower(pts, model);

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
                      <path d={pathD} fill="none" stroke="#00d4ff" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" opacity={0.95} vectorEffect="non-scaling-stroke" />
                      {pts.map((p, i) => (
                        <g key={i}>
                          <circle cx={sx(p.x).toFixed(2)} cy={sy(p.y).toFixed(2)} r={5} fill="#00d4ff" opacity={0.95} />
                          <text x={+sx(p.x).toFixed(2) + 7} y={+sy(p.y).toFixed(2) + 4} fontSize={11} fill="rgba(255,255,255,0.85)" fontWeight="700">L{p.layer}</text>
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
                    onClick={e => { if (e.target === e.currentTarget) setShowCurveModal(false); }}>
                    <div className="glass" role="dialog" aria-modal="true" style={{ background: '#0b1220', border: '1px solid rgba(0,212,255,0.25)', borderRadius: 14, width: '92vw', maxWidth: 1000, maxHeight: '80vh', display: 'flex', flexDirection: 'column', overflow: 'hidden', boxShadow: '0 24px 60px rgba(0,0,0,0.7)' }}>
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '14px 20px', borderBottom: '1px solid rgba(255,255,255,0.08)' }}>
                        <div>
                          <div style={{ fontWeight: 800, fontSize: 14, letterSpacing: '.06em', color: '#e2e8f0', textTransform: 'uppercase' }}>Implied Pricing Curve</div>
                          <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.45)', marginTop: 3 }}>
                            Power-law fit: ROL = a × x^b &nbsp;|&nbsp; x = √((Att+Lim)×Att) / EGNPI. Requires ≥2 layers with Limit, Deductible, EGNPI and ROL.
                          </div>
                        </div>
                        <button type="button" onClick={() => setShowCurveModal(false)} aria-label="Close"
                          style={{ background: 'none', border: '1px solid rgba(255,255,255,0.15)', color: 'rgba(255,255,255,0.6)', borderRadius: 6, padding: '4px 12px', cursor: 'pointer', fontSize: 13 }}>
                          ✕ Close
                        </button>
                      </div>
                      <div style={{ overflowY: 'auto', padding: '16px 20px', flex: 1 }}>
                        {pts.length < 2 ? (
                          <p style={{ color: 'rgba(255,255,255,0.4)', textAlign: 'center', padding: 32 }}>
                            Enter Limit, Deductible, EGNPI and ROL for at least two layers to display the curve.
                          </p>
                        ) : !model ? (
                          <p style={{ color: 'rgba(255,255,255,0.4)', textAlign: 'center', padding: 32 }}>
                            Unable to fit a curve from the current layer points.
                          </p>
                        ) : (
                          <>
                            <div style={{ background: 'rgba(0,212,255,0.03)', border: '1px solid rgba(0,212,255,0.12)', borderRadius: 10, padding: '12px 16px', marginBottom: 14 }}>
                              {renderSVG()}
                            </div>
                            <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.32)', borderTop: '1px solid rgba(255,255,255,0.07)', paddingTop: 10 }}>
                              Model: ROL = a × x^b &nbsp;|&nbsp; x = √((Attachment + Limit) × Attachment) / EGNPI &nbsp;|&nbsp; Fitted by least-squares search over b ∈ [−6, 6].
                              {Number.isFinite(r2) && <span style={{ marginLeft: 16, color: 'rgba(0,212,255,0.7)', fontWeight: 700 }}>R² = {r2.toFixed(3)}</span>}
                            </div>
                            <table className="np-struct-table" style={{ width: '100%', marginTop: 14 }}>
                              <thead><tr><th>Layer</th><th>Attachment</th><th>Top</th><th>ROL %</th><th>Fitted ROL %</th></tr></thead>
                              <tbody>
                                {layers.filter(l => toN(l.limit) > 0 && toN(l.deductible) > 0).map((l, i) => {
                                  const ded = toN(l.deductible), lim = toN(l.limit);
                                  const rolRaw = parseFloat(String(l.rol || l.rate || '').replace(/%/g,'')) || 0;
                                  const epN = toN(l.earnedPremium);
                                  const rol = lim > 0 && epN > 0 ? (epN / lim * 100).toFixed(4) : rolRaw ? rolRaw.toFixed(4) : '—';
                                  const x = egnpiOverall > 0 ? Math.sqrt((ded + lim) * ded) / egnpiOverall : 0;
                                  const fitted = model && x > 0 ? (model.a * Math.pow(Math.max(eps, x), model.b) * 100).toFixed(4) : '—';
                                  return (
                                    <tr key={i}>
                                      <td>L{i + 1}</td>
                                      <td>{fmtC(String(ded))}</td>
                                      <td>{fmtC(String(ded + lim))}</td>
                                      <td style={{ color: '#00d4ff', fontWeight: 700 }}>{rol}{rol !== '—' ? '%' : ''}</td>
                                      <td style={{ color: 'rgba(255,255,255,0.5)' }}>{fitted}{fitted !== '—' ? '%' : ''}</td>
                                    </tr>
                                  );
                                })}
                              </tbody>
                            </table>
                          </>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })()}
            </>
          )}
        </div>
      )}
    </WizardLayout>
  );
}
