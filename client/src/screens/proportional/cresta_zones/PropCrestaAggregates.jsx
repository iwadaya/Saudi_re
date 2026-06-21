import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { api } from '../../../api';
import { useContractId } from '../../../hooks/useContractId';
import { useAppState } from '../../../context/AppContext';
import WizardLayout from '../../../components/WizardLayout';
import PctInput from '../../../components/PctInput';
import { sanitizeNumber, toN as cn } from '../../../utils/format';
import { logger } from '../../../utils/logger';

const ROUTE_KEY = 'PROP_CRESTA_AGGREGATES';
const PERILS = [
  { key: 'eq_agg', label: 'Earthquake' },
  { key: 'flood_agg', label: 'Flood' },
  { key: 'srcc_agg', label: 'SRCC' },
  { key: 'ws_agg', label: 'Windstorm' },
  { key: 'others_agg', label: 'Others' },
];
const NUM_COLS = PERILS.map(p => p.key);
const COL_ORDER = ['zone_id', 'zone_name', ...NUM_COLS];

const ELIGIBLE_COBS = ['fire', 'property', 'engineering', 'energy'];
function isEligibleCob(name) {
  const lc = String(name || '').toLowerCase();
  return ELIGIBLE_COBS.some(e => lc.includes(e));
}

// ── PROP treaty type tabs ──
// Order matters: most specific first. Plain "Surplus" with no qualifier
// is treated as First Surplus.
function inferPropTreatyTypes(name) {
  const n = String(name || '').toLowerCase();
  if (n.includes('quota') && n.includes('surplus')) return ['Quota Share', 'First Surplus'];
  if (n.includes('quota')) return ['Quota Share'];
  if (n.includes('first') && n.includes('surplus')) return ['First Surplus'];
  if (n.includes('second') && n.includes('surplus')) return ['Second Surplus'];
  if (n.includes('third') && n.includes('surplus')) return ['Third Surplus'];
  if (n.includes('fac oblig') || n.includes('facoblig') || n.includes('facultative oblig')) return ['Fac Oblig'];
  if (n.includes('surplus')) return ['First Surplus'];
  return ['Quota Share'];
}

// ── NP treaty types that require aggregates ──
// Whitelist: matching by substring is too loose (e.g. a future
// "Catalogue XL" would have falsely qualified). Pure Risk XL is excluded
// because it doesn't need CRESTA exposure.
const NP_AGG_TYPES = new Set([
  'Cat XL', 'Catastrophe XL',
  'Risk & Cat XL', 'Risk and Cat XL',
  'Aggregate XL', 'Agg XL',
  'Stop Loss',
]);
function isNpAggType(name) {
  const n = String(name || '').trim().toLowerCase();
  if (!n) return false;
  return Array.from(NP_AGG_TYPES).some(t => t.toLowerCase() === n);
}

const DISTRIBUTION_CATS = [
  { key: 'residential_bldg_pct', label: 'Residential Buildings' },
  { key: 'commercial_bldg_pct', label: 'Commercial Buildings' },
  { key: 'commercial_cont_pct', label: 'Commercial Contents' },
  { key: 'industrial_bldg_pct', label: 'Industrial Buildings' },
  { key: 'industrial_cont_pct', label: 'Industrial Contents' },
];
const DEFAULT_DIST = { residential_bldg_pct: 30, commercial_bldg_pct: 25, commercial_cont_pct: 15, industrial_bldg_pct: 20, industrial_cont_pct: 10 };

function fmt(n) { if (n == null || n === 0) return ''; return Number(n).toLocaleString('en-US', { maximumFractionDigits: 0 }); }
function fmtInput(v) { const n = cn(v); return n === 0 && String(v ?? '').trim() === '' ? '' : n.toLocaleString('en-US', { maximumFractionDigits: 0 }); }

function CaNumCell({ value, disabled, onChange, onBlur, onPaste }) {
  const [editing, setEditing] = React.useState(false);
  const [raw, setRaw] = React.useState('');
  // When parent value changes while we're in editing mode (e.g. paste updated state),
  // sync raw so the focused cell reflects the pasted value instead of showing stale text.
  const prevValueRef = React.useRef(value);
  React.useEffect(() => {
    if (editing && prevValueRef.current !== value) {
      setRaw(String(value ?? '').replace(/,/g, ''));
    }
    prevValueRef.current = value;
  }, [value, editing]);
  return (
    <input className="ca-inp ca-inp--num" placeholder="0" inputMode="decimal" disabled={disabled}
      value={editing ? raw : fmtInput(value)}
      onFocus={() => { setEditing(true); setRaw(String(value ?? '').replace(/,/g, '')); }}
      onChange={e => { setRaw(e.target.value); onChange(e); }}
      onBlur={e => { setEditing(false); onBlur(e); }}
      onPaste={onPaste} />
  );
}
function blankZero(v) { const s = String(v ?? ''); const n = parseFloat(s.replace(/,/g, '')); return (!Number.isFinite(n) || n === 0) ? '' : s; }
function optNum(v) { const s = String(v ?? '').trim(); if (!s) return null; const n = parseFloat(sanitizeNumber(s)); return Number.isFinite(n) ? n : null; }

const COB_COLORS = [
  { border: 'rgba(34,197,94,.45)', bg: 'rgba(34,197,94,.10)', text: 'rgba(34,197,94,.95)', active: 'rgba(34,197,94,.18)' },
  { border: 'rgba(59,130,246,.45)', bg: 'rgba(59,130,246,.10)', text: 'rgba(59,130,246,.95)', active: 'rgba(59,130,246,.18)' },
  { border: 'rgba(245,158,11,.45)', bg: 'rgba(245,158,11,.10)', text: 'rgba(245,158,11,.95)', active: 'rgba(245,158,11,.18)' },
  { border: 'rgba(168,85,247,.45)', bg: 'rgba(168,85,247,.10)', text: 'rgba(168,85,247,.95)', active: 'rgba(168,85,247,.18)' },
  { border: 'rgba(236,72,153,.45)', bg: 'rgba(236,72,153,.10)', text: 'rgba(236,72,153,.95)', active: 'rgba(236,72,153,.18)' },
  { border: 'rgba(20,184,166,.45)', bg: 'rgba(20,184,166,.10)', text: 'rgba(20,184,166,.95)', active: 'rgba(20,184,166,.18)' },
];

/* ─────────────────────────────────────────────────
   A unique "context key" identifies each slice of
   aggregate data: contract × country × cob × treaty-type.
   contractId leads so two contracts with the same country/cob/
   treaty-type can't collide in the shared useRef cache, which
   otherwise persists across navigation and would silently
   serve up stale aggregates when the user switched contracts.
   ───────────────────────────────────────────────── */
function ctxKey(contractId, countryId, cobId, treatyType) {
  return `${contractId || ''}|${countryId || ''}|${cobId || ''}|${treatyType || ''}`;
}

export default function PropCrestaAggregates({ embedded = false, routeKeyOverride, forceNp = false }) {
  const effectiveRouteKey = routeKeyOverride || ROUTE_KEY;
  const contractId = useContractId();
  const { state: appState } = useAppState();
  const td = useMemo(() => appState.propTreatyDetail || {}, [appState.propTreatyDetail]);
  const npTd = useMemo(() => appState.npTreatyDetail || {}, [appState.npTreatyDetail]);
  const isNpMode = forceNp || appState.wizardMode === 'NP';

  // ── Master cache: country|cob|type → rows[] ──
  const cache = useRef(new Map());
  // Bumped on every cache mutation so memoized derived values
  // (e.g. savedCountryIds) recompute deterministically rather than
  // riding on `rows` as an indirect proxy.
  const [cacheVersion, setCacheVersion] = useState(0);
  const bumpCache = useCallback(() => setCacheVersion(v => v + 1), []);

  const [countries, setCountries] = useState([]);
  const [rows, setRows] = useState([]);
  const [activeCountry, setActiveCountry] = useState('');
  const [dirty, setDirty] = useState(false);
  const [saveMsg, setSaveMsg] = useState(null);
  const [contractInfo, setContractInfo] = useState(null);
  const [allCobs, setAllCobs] = useState([]);
  const [activeCobId, setActiveCobId] = useState(null);
  const [aggTreatyType, setAggTreatyType] = useState('');
  const [showDistModal, setShowDistModal] = useState(false);
  const [distribution, setDistribution] = useState({ ...DEFAULT_DIST });
  const [zoneRefMissing, setZoneRefMissing] = useState(false);
  const [combined, setCombined] = useState(false);

  // ── Derive treaty type tabs based on prop vs NP ──
  const treatyTypeName = useMemo(() => {
    const hdr = contractInfo?.header || contractInfo || {};
    return hdr.treaty_type_name || td.treatyTypeName || npTd.treatyTypeName || '';
  }, [contractInfo, td, npTd]);

  const availableTreatyTypes = useMemo(() => {
    if (isNpMode) {
      // NP: only show the single NP type (e.g. "Cat XL") if it qualifies
      return isNpAggType(treatyTypeName) ? [treatyTypeName] : [];
    }
    return inferPropTreatyTypes(treatyTypeName);
  }, [isNpMode, treatyTypeName]);

  const contractCobs = useMemo(() => {
    return allCobs.map((cob, i) => ({
      id: cob.id, name: cob.name || cob.label || `COB ${i + 1}`,
      eligible: isEligibleCob(cob.name || cob.label || ''),
      color: COB_COLORS[i % COB_COLORS.length],
    }));
  }, [allCobs]);

  const activeCob = useMemo(() => contractCobs.find(c => c.id === activeCobId), [contractCobs, activeCobId]);
  const isCobEligible = activeCob?.eligible ?? true;

  // ── Helpers ──
  const storeCtx = useCallback((countryId, cobId, treatyType, data, dist, mode) => {
    const key = ctxKey(contractId, countryId, cobId, treatyType);
    cache.current.set(key, { rows: data, distribution: dist || { ...DEFAULT_DIST }, mode: mode || 'zones' });
    bumpCache();
  }, [contractId, bumpCache]);

  const loadCtx = useCallback((countryId, cobId, treatyType) => {
    return cache.current.get(ctxKey(contractId, countryId, cobId, treatyType)) || null;
  }, [contractId]);

  const loadZonesForCountry = async (countryId) => {
    try {
      const zones = await api.getRefCrestaZones(countryId).catch(() => []);
      if (zones?.length > 0) {
        setZoneRefMissing(false);
        return zones.map(z => ({ country_id: countryId, zone_id: z.zone_id, zone_name: z.zone_name, eq_agg: '', ws_agg: '', flood_agg: '', srcc_agg: '', others_agg: '' }));
      }
    } catch { /* fall through */ }
    // Surface that we're using a generic 1-10 fallback so the data
    // steward knows to seed ref_cresta_zone for this country.
    setZoneRefMissing(true);
    return Array.from({ length: 10 }, (_, i) => ({ country_id: countryId, zone_id: String(i + 1), zone_name: `Zone ${i + 1}`, eq_agg: '', ws_agg: '', flood_agg: '', srcc_agg: '', others_agg: '' }));
  };

  /* ── Switch to a new context: save current → load target ── */
  const switchTo = useCallback(async (newCountry, newCob, newType) => {
    // 1. Stash current context in cache (in-memory only; server save happens below)
    if (activeCountry) {
      storeCtx(activeCountry, activeCobId, aggTreatyType, rows, distribution, combined ? 'combined' : 'zones');
    }
    // 2. Try cache first
    const cached = loadCtx(newCountry, newCob, newType);
    if (cached) {
      setRows(cached.rows.map(r => ({ ...r })));
      setDistribution({ ...cached.distribution });
      setCombined(cached.mode === 'combined');
    } else {
      // 3. Fall back to server data already in the master cache (loaded on mount)
      const fromServer = cache.current.get('__server__') || [];
      const existing = fromServer.filter(r =>
        String(r.country_id) === String(newCountry) &&
        String(r.treaty_type || '') === String(newType) &&
        (newCob ? String(r.cob_id) === String(newCob) : !r.cob_id)
      );
      if (existing.length > 0) {
        setRows(existing.map(r => ({ ...r, eq_agg: blankZero(r.eq_agg), ws_agg: blankZero(r.ws_agg), flood_agg: blankZero(r.flood_agg), srcc_agg: blankZero(r.srcc_agg), others_agg: blankZero(r.others_agg) })));
        const r0 = existing[0];
        setDistribution({
          residential_bldg_pct: cn(r0.residential_bldg_pct) || 30, commercial_bldg_pct: cn(r0.commercial_bldg_pct) || 25,
          commercial_cont_pct: cn(r0.commercial_cont_pct) || 15, industrial_bldg_pct: cn(r0.industrial_bldg_pct) || 20,
          industrial_cont_pct: cn(r0.industrial_cont_pct) || 10,
        });
        setCombined(existing.length === 1 && String(existing[0].zone_id) === 'COMBINED');
      } else {
        // 4. Load blank zones for country
        const blank = await loadZonesForCountry(newCountry);
        setRows(blank);
        setDistribution({ ...DEFAULT_DIST });
        setCombined(false);
      }
    }
    setActiveCountry(newCountry);
    setActiveCobId(newCob);
    setAggTreatyType(newType);
    setDirty(false);
  }, [activeCountry, activeCobId, aggTreatyType, rows, distribution, combined, storeCtx, loadCtx]);

  // ── Load on mount ──
  useEffect(() => {
    if (!contractId) return;
    let cancelled = false;
    (async () => {
      try {
        const [c, cList, saved, cobs] = await Promise.all([
          api.getContract(contractId, appState.quoteMode ? { quote: true } : undefined).catch(() => ({})),
          api.getRefListItems('country').catch(() => []),
          api.getCrestaData(contractId, appState.quoteMode ? { quote: true } : undefined).catch(() => []),
          api.getContractCobs(contractId, appState.quoteMode ? { quote: true } : undefined).catch(() => []),
        ]);
        if (cancelled) return;
        setContractInfo(c);
        setCountries(cList || []);
        // Store raw server data for later context lookups
        cache.current.set('__server__', saved || []);
        bumpCache();

        const cobList = (cobs?.rows || cobs || []).map(x => ({ id: x.cob_id || x.id || x.class_of_business_id, name: x.cob_name || x.name || x.label || '' }));
        setAllCobs(cobList);

        const hdr = c?.header || c || {};
        const typeName = hdr.treaty_type_name || td.treatyTypeName || npTd.treatyTypeName || '';
        let types;
        if (appState.wizardMode === 'NP') {
          types = isNpAggType(typeName) ? [typeName] : [];
        } else {
          types = inferPropTreatyTypes(typeName);
        }
        const initType = types[0] || '';

        // Pick initial country: prefer contract's country, else first in list
        const tdCountry = td.countryId || npTd.countryId || hdr.country_id;
        const initCountry = tdCountry && (cList || []).find(x => String(x.id) === String(tdCountry)) ? tdCountry : (cList || [])[0]?.id || '';

        // Pick initial COB: first eligible
        const eligibleCob = cobList.find(x => isEligibleCob(x.name));
        const initCob = eligibleCob?.id || cobList[0]?.id || null;

        // Load initial context from server data
        const cleaned = (saved || []);
        const existing = cleaned.filter(r =>
          String(r.country_id) === String(initCountry) &&
          String(r.treaty_type || '') === String(initType) &&
          (initCob ? String(r.cob_id) === String(initCob) : !r.cob_id)
        );
        if (existing.length > 0) {
          setRows(existing.map(r => ({ ...r, eq_agg: blankZero(r.eq_agg), ws_agg: blankZero(r.ws_agg), flood_agg: blankZero(r.flood_agg), srcc_agg: blankZero(r.srcc_agg), others_agg: blankZero(r.others_agg) })));
          const r0 = existing[0];
          setDistribution({
            residential_bldg_pct: cn(r0.residential_bldg_pct) || 30, commercial_bldg_pct: cn(r0.commercial_bldg_pct) || 25,
            commercial_cont_pct: cn(r0.commercial_cont_pct) || 15, industrial_bldg_pct: cn(r0.industrial_bldg_pct) || 20,
            industrial_cont_pct: cn(r0.industrial_cont_pct) || 10,
          });
          setCombined(existing.length === 1 && String(existing[0].zone_id) === 'COMBINED');
        } else if (initCountry) {
          const blank = await loadZonesForCountry(initCountry);
          if (cancelled) return;
          setRows(blank);
          setCombined(false);
        }

        setActiveCountry(initCountry);
        setActiveCobId(initCob);
        setAggTreatyType(initType);
      } catch (e) { if (!cancelled) logger.error('CRESTA load failed', e); }
    })();
    return () => { cancelled = true; };
  }, [appState.quoteMode, appState.wizardMode, bumpCache, contractId, npTd.countryId, npTd.treatyTypeName, td.countryId, td.treatyTypeName]);

  /* Run N async tasks at most `limit` at a time. Avoids exhausting the
     server's pg connection pool when saveAllContexts fans out to many
     country/COB/treaty-type combos at once. */
  async function withConcurrency(items, limit, worker) {
    const results = new Array(items.length);
    let i = 0;
    const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (i < items.length) {
        const idx = i++;
        results[idx] = await worker(items[idx], idx);
      }
    });
    await Promise.all(runners);
    return results;
  }

  // ── Save current context to server ──
  // Server defaults `treaty_type` to 'Both' when omitted; keep this in
  // sync (prop screens that haven't inferred a type yet should land in
  // the same slice as the server's default to avoid orphaning rows).
  const normalizeTreatyType = (t) => (t && String(t).trim()) || 'Both';

  // Save ALL stashed contexts (used on nav away so nothing is lost)
  const saveAllContexts = useCallback(async () => {
    if (!contractId) return true;
    // First stash the current active context
    if (activeCountry) storeCtx(activeCountry, activeCobId, aggTreatyType, rows, distribution, combined ? 'combined' : 'zones');
    // Iterate every key in the cache and queue one save task per slice
    const tasks = [];
    for (const [key, ctx] of cache.current.entries()) {
      if (key === '__server__') continue;
      // Key format is `contractId|countryId|cobId|treatyType` — see ctxKey().
      const [keyContractId, countryId, cobId, tType] = key.split('|');
      // Cache may carry stale entries from contracts the user previously
      // worked on; only persist rows that belong to the current contract.
      if (keyContractId !== String(contractId)) continue;
      if (!countryId || countryId === 'undefined') continue;
      const validRows = ctx.rows.filter(r => NUM_COLS.some(c => { const v = r[c]; return (typeof v === 'number') || (typeof v === 'string' && v.trim() !== ''); }));
      if (!validRows.length) continue;
      const payload = validRows.map(r => ({
        country_id: countryId, zone_id: r.zone_id, zone_name: r.zone_name,
        eq_agg: optNum(r.eq_agg), ws_agg: optNum(r.ws_agg), flood_agg: optNum(r.flood_agg),
        srcc_agg: optNum(r.srcc_agg), others_agg: optNum(r.others_agg),
        residential_bldg_pct: cn(ctx.distribution?.residential_bldg_pct||30),
        commercial_bldg_pct: cn(ctx.distribution?.commercial_bldg_pct||25),
        commercial_cont_pct: cn(ctx.distribution?.commercial_cont_pct||15),
        industrial_bldg_pct: cn(ctx.distribution?.industrial_bldg_pct||20),
        industrial_cont_pct: cn(ctx.distribution?.industrial_cont_pct||10),
      }));
      const cobName = contractCobs.find(c => String(c.id) === String(cobId))?.name || null;
      tasks.push({ key, payload, tType, cobId, cobName, countryId });
    }
    // Cap parallelism: each save opens a pg pool client, so 80 fan-out
    // tasks would happily exhaust the server's connection pool.
    const results = await withConcurrency(tasks, 4, async (t) => {
      try {
        await api.saveCrestaData(contractId, {
          rows: t.payload,
          treaty_type: normalizeTreatyType(t.tType || aggTreatyType),
          cob_id: t.cobId || null,
          cob_name: t.cobName || null,
          country_id: t.countryId,
        }, appState.quoteMode ? { quote: true } : undefined);
        return { key: t.key, ok: true };
      } catch (e) { return { key: t.key, ok: false, error: e }; }
    });
    const failures = results.filter(r => !r.ok);
    if (failures.length) {
      failures.forEach(f => logger.error('[PropCrestaAggregates] batch save failed for', f.key, f.error));
      const msg = failures[0].error?.message || 'Server error';
      setSaveMsg({ type: 'err', text: `CRESTA save failed for ${failures.length} of ${results.length} contexts: ${msg}` });
      setTimeout(() => setSaveMsg(null), 4000);
      return false;
    }
    // Refresh server snapshot so subsequent context switches read what
    // we just wrote, not the snapshot taken on mount.
    try {
      const refreshed = await api.getCrestaData(contractId, appState.quoteMode ? { quote: true } : undefined);
      cache.current.set('__server__', refreshed || []);
      bumpCache();
    } catch { /* non-fatal */ }
    setDirty(false);
    return true;
  }, [contractId, activeCountry, activeCobId, aggTreatyType, rows, distribution, combined, storeCtx, appState.quoteMode, bumpCache, contractCobs]);

  const saveData = useCallback(async (quiet = false) => {
    if (!contractId || !activeCountry) return true;
    // Gate on distribution totalling 100% — bypassing the modal's
    // disabled "Apply" button by clicking the global Save button used
    // to persist invalid splits silently.
    const distSum = DISTRIBUTION_CATS.reduce((s, c) => s + cn(distribution[c.key]), 0);
    if (Math.abs(distSum - 100) > 0.01) {
      if (!quiet) {
        setSaveMsg({ type: 'err', text: `Occupancy distribution must total 100% (currently ${distSum.toFixed(1)}%)` });
        setTimeout(() => setSaveMsg(null), 3500);
      }
      return false;
    }
    // Stash in cache
    storeCtx(activeCountry, activeCobId, aggTreatyType, rows, distribution, combined ? 'combined' : 'zones');

    const validRows = rows.filter(r => NUM_COLS.some(c => { const v = r[c]; return (typeof v === 'number') || (typeof v === 'string' && v.trim() !== ''); }));
    const payload = validRows.map(r => ({
      country_id: activeCountry, zone_id: r.zone_id, zone_name: r.zone_name,
      eq_agg: optNum(r.eq_agg), ws_agg: optNum(r.ws_agg), flood_agg: optNum(r.flood_agg),
      srcc_agg: optNum(r.srcc_agg), others_agg: optNum(r.others_agg),
      residential_bldg_pct: cn(distribution.residential_bldg_pct), commercial_bldg_pct: cn(distribution.commercial_bldg_pct),
      commercial_cont_pct: cn(distribution.commercial_cont_pct), industrial_bldg_pct: cn(distribution.industrial_bldg_pct),
      industrial_cont_pct: cn(distribution.industrial_cont_pct),
    }));

    try {
      await api.saveCrestaData(contractId, {
        rows: payload,
        treaty_type: normalizeTreatyType(aggTreatyType),
        cob_id: activeCobId || null,
        cob_name: activeCob?.name || null,
        country_id: activeCountry,
      }, appState.quoteMode ? { quote: true } : undefined);
      setDirty(false);
      if (!quiet) { setSaveMsg({ type: 'ok', text: 'Saved' }); setTimeout(() => setSaveMsg(null), 2000); }
      return true;
    } catch (e) {
      logger.error('CRESTA save error', e);
      if (!quiet) {
        setSaveMsg({ type: 'err', text: `Save failed: ${e?.message || 'server error'}` });
        setTimeout(() => setSaveMsg(null), 4000);
      }
      return false;
    }
  }, [contractId, activeCountry, aggTreatyType, activeCobId, activeCob, rows, distribution, combined, storeCtx, appState.quoteMode]);

  // ── Cell edit / paste / clear ──
  const updateCell = (idx, col, val) => { setRows(prev => { const n = [...prev]; n[idx] = { ...n[idx], [col]: val }; return n; }); setDirty(true); };
  const clearScreen = () => { setRows(prev => prev.map(r => ({ ...r, eq_agg: '', ws_agg: '', flood_agg: '', srcc_agg: '', others_agg: '' }))); setDirty(true); };

  const handlePaste = (e, rowIdx, colKey) => {
    const startCol = COL_ORDER.indexOf(colKey); if (startCol < 2) return;
    const text = e.clipboardData?.getData('text/plain'); if (!text) return;
    e.preventDefault();
    // Strip trailing newline that Excel/Google Sheets always appends, normalise \r\n
    const grid = text.replace(/\r/g, '').replace(/\n$/, '').split('\n').map(l => l.split('\t'));
    setRows(prev => {
      const next = prev.map(r => ({ ...r }));
      for (let rOff = 0; rOff < grid.length; rOff++) {
        const rr = rowIdx + rOff; if (!next[rr]) break;
        for (let cOff = 0; cOff < grid[rOff].length; cOff++) {
          const cc = startCol + cOff; if (cc >= COL_ORDER.length) break;
          const key = COL_ORDER[cc];
          if (key !== 'zone_id' && key !== 'zone_name') next[rr][key] = sanitizeNumber(grid[rOff][cOff]);
        }
      }
      return next;
    });
    setDirty(true);
  };

  // ── Derived ──
  const totals = useMemo(() => { const t = {}; NUM_COLS.forEach(c => { t[c] = rows.reduce((s, r) => s + cn(r[c]), 0); }); return t; }, [rows]);
  const distTotal = DISTRIBUTION_CATS.reduce((s, c) => s + cn(distribution[c.key]), 0);

  // Countries that have saved data — scan cache + server data.
  // Recomputes when cacheVersion ticks (storeCtx, server snapshot
  // refresh) so we don't ride on `rows` as an indirect proxy.
  const savedCountryIds = useMemo(() => {
    // cacheVersion invalidates cache.current, which is intentionally held in a ref.
    void cacheVersion;
    const ids = new Set();
    const server = cache.current.get('__server__') || [];
    server.forEach(r => { if (r.country_id) ids.add(r.country_id); });
    // Key format is contractId|country|cob|treatyType (see ctxKey()), so the
    // country is at index 1; entries belonging to other contracts are
    // skipped.
    for (const [key] of cache.current) {
      if (key === '__server__') continue;
      const [keyContractId, country] = key.split('|');
      if (keyContractId !== String(contractId)) continue;
      if (country) ids.add(country);
    }
    return [...ids];
  }, [cacheVersion, contractId]);

  // ── Context switching handlers ──
  const onCountryChange = async (newCountry) => {
    if (String(newCountry) === String(activeCountry)) return;
    if (dirty) await saveData(true);
    await switchTo(newCountry, activeCobId, aggTreatyType);
  };

  const onCobChange = async (newCob) => {
    if (String(newCob) === String(activeCobId)) return;
    if (dirty) await saveData(true);
    await switchTo(activeCountry, newCob, aggTreatyType);
  };

  const onTypeChange = async (newType) => {
    if (newType === aggTreatyType) return;
    if (dirty) await saveData(true);
    await switchTo(activeCountry, activeCobId, newType);
  };

  const onCombinedToggle = async (checked) => {
    if (checked) {
      setRows([{
        country_id: activeCountry, zone_id: 'COMBINED', zone_name: 'Combined',
        eq_agg: '', ws_agg: '', flood_agg: '', srcc_agg: '', others_agg: '',
      }]);
      setDirty(true);
      setCombined(true);
    } else {
      const blank = await loadZonesForCountry(activeCountry);
      setRows(blank);
      setDirty(true);
      setCombined(false);
    }
  };

  // ── NP: show message if treaty type doesn't need aggregates ──
  if (isNpMode && availableTreatyTypes.length === 0) {
    const emptyContent = (
          <div className="CRESTA_AGGREGATES_PAGE">
            <div className="ca-hero">
              <div className="ca-title">Aggregate Exposure by Cresta Zone</div>
              <div className="ca-sub">Aggregate exposure entry is only required for <strong>Cat XL, Risk & Cat XL, Aggregate XL, and Stop Loss</strong> treaty types. The current treaty type (<strong>{treatyTypeName || 'Unknown'}</strong>) does not require this.</div>
            </div>
          </div>
    );
    if (embedded) return emptyContent;
    return (
      <WizardLayout routeKey={effectiveRouteKey} title="CRESTA Aggregates" headerPill={appState.quoteMode ? "NP-QUOTE TREATY: CRESTA ZONES" : "NON-PROPORTIONAL TREATY: CRESTA ZONES"}>
        {() => emptyContent}
      </WizardLayout>
    );
  }

  const mainContent = (
        <div className="CRESTA_AGGREGATES_PAGE">
          <div className="ca-hero">
            <div className="ca-title">Aggregate Exposure by Cresta Zone</div>
            <div className="ca-sub">Capture earthquake, flood, SRCC and windstorm aggregates per zone. Only applicable to <strong>Fire, Engineering & Energy</strong> classes.
              {isNpMode && <> Treaty type: <strong>{treatyTypeName}</strong>.</>}
            </div>
          </div>

          {/* ═══ COB TABS ═══ */}
          {contractCobs.length > 0 && (
            <div className="ca-cob-tabs">
              <span className="ca-cob-tabs-label">Class of Business</span>
              <div className="ca-cob-tabs-row">
                {contractCobs.map(cob => {
                  const isActive = cob.id === activeCobId;
                  const tabStyle = isActive
                    ? { borderColor: cob.color.border, background: cob.color.active, color: cob.color.text }
                    : cob.eligible
                      ? { borderColor: 'rgba(255,255,255,.12)', background: 'rgba(255,255,255,.04)', color: 'rgba(255,255,255,.7)' }
                      : { borderColor: 'rgba(255,255,255,.06)', background: 'rgba(255,255,255,.02)', color: 'rgba(255,255,255,.25)', cursor: 'not-allowed' };
                  return (
                    <button key={cob.id} className={`ca-cob-tab ${isActive?'active':''} ${!cob.eligible?'ca-cob-tab--disabled':''}`}
                      style={tabStyle} disabled={!cob.eligible}
                      title={!cob.eligible ? 'Aggregates only apply to Fire, Engineering & Energy' : ''}
                      onClick={() => { if (cob.eligible) onCobChange(cob.id); }}>
                      {isActive && <span className="ca-cob-dot" style={{ background: cob.color.text }} />}
                      {cob.name}
                      {!cob.eligible && <span className="ca-cob-lock"> 🔒</span>}
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {activeCob && !isCobEligible && (
            <div className="ca-disabled-banner">
              Aggregate exposure does not apply to <strong>{activeCob.name}</strong>. Only Fire, Engineering and Energy classes require aggregate entry.
            </div>
          )}
          {zoneRefMissing && (
            <div className="ca-disabled-banner" style={{ background: 'rgba(245,158,11,.10)', borderColor: 'rgba(245,158,11,.45)', color: 'rgba(245,158,11,.95)' }}>
              No reference zones are seeded for this country in <code>ref_cresta_zone</code>. Showing generic Zone&nbsp;1–10 placeholders — please ask the data steward to populate the table.
            </div>
          )}

          <div className={!isCobEligible && activeCob ? 'ca-greyed' : ''}>
            <div className="ca-savedline">
              <div className="ca-savedlabel">Countries with aggregates</div>
              <div className="ca-pills-area">
                {savedCountryIds.length === 0 ? <span className="ca-pill-none">None yet</span> :
                  savedCountryIds.map(id => {
                    const c = countries.find(x => String(x.id) === String(id));
                    return <button key={id} className={`ca-saved-pill ${String(id)===String(activeCountry)?'active':''}`}
                      onClick={() => onCountryChange(id)}>{c?.name||'Unknown'}</button>;
                  })}
              </div>
            </div>

            <div className="ca-goldbar">
              <div className="ca-gold-left">
                <div className="ca-field">
                  <span className="ca-flabel">Country</span>
                  <select className="ca-select" value={activeCountry} onChange={e => onCountryChange(e.target.value)}>
                    {countries.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                  </select>
                </div>
                {!isNpMode && availableTreatyTypes.length > 1 && (
                  <div className="ca-field">
                    <span className="ca-flabel">Treaty Type</span>
                    <div className="ca-toggle-group">
                      {availableTreatyTypes.map(t => (
                        <button key={t} className={`ca-toggle-btn ${aggTreatyType===t?'active':''}`}
                          onClick={() => onTypeChange(t)}>{t}</button>
                      ))}
                    </div>
                  </div>
                )}
              </div>
              <div className="ca-gold-right">
                {saveMsg && <span className={`ca-msg ca-msg--${saveMsg.type}`}>{saveMsg.text}</span>}
                <label className="ca-combined-toggle" style={{ display: 'flex', alignItems: 'center', gap: '6px', color: 'rgba(255,255,255,.7)', fontSize: '13px', cursor: 'pointer', marginRight: '8px' }}>
                  <input
                    type="checkbox"
                    checked={combined}
                    onChange={e => onCombinedToggle(e.target.checked)}
                    style={{ cursor: 'pointer' }}
                  />
                  Combined aggregates
                </label>
                <button className="ca-btn" onClick={() => setShowDistModal(true)}>📊 Distribution</button>
                <button className="ca-btn ca-btn--ghost" onClick={clearScreen}>Clear</button>
                <button className={`ca-btn ca-btn--save ${dirty?'ca-btn--dirty':''}`} onClick={() => saveData(false)}>💾 Save</button>
              </div>
            </div>

            <div className="ca-info-bar">
              <span className="ca-info-tag">Treaty: <strong>{treatyTypeName || '—'}</strong></span>
              <span className="ca-info-tag">Aggregates for: <strong>{aggTreatyType || treatyTypeName}</strong></span>
              {activeCob && <span className="ca-info-tag">LOB: <strong>{activeCob.name}</strong></span>}
              <span className="ca-info-tag">Country: <strong>{countries.find(c => String(c.id) === String(activeCountry))?.name || '—'}</strong></span>
              <span className="ca-info-tag">Occupancy: <strong>{distTotal.toFixed(0)}%</strong> {Math.abs(distTotal-100)<0.01?'✓':'⚠'}</span>
            </div>

            <div className="ca-table-wrap">
              <table className="ca-table">
                <thead><tr>
                  <th className="ca-th" style={{width:80}}>Zone #</th>
                  <th className="ca-th">Cresta Zone</th>
                  {PERILS.map(p => <th key={p.key} className="ca-th ca-th--c">{p.label}</th>)}
                </tr></thead>
                <tbody>
                  {rows.map((r, i) => (
                    <tr key={i}>
                      <td className="ca-td ca-td--id"><input className="ca-inp ca-inp--ro" value={r.zone_id||''} readOnly tabIndex={-1} /></td>
                      <td className="ca-td ca-td--name"><input className="ca-inp ca-inp--ro" value={r.zone_name||''} readOnly tabIndex={-1} /></td>
                      {NUM_COLS.map(col => (
                        <td key={col} className="ca-td">
                          <CaNumCell value={r[col]||''} disabled={!isCobEligible && !!activeCob}
                            onChange={e => updateCell(i, col, e.target.value)}
                            onBlur={e => { const v = sanitizeNumber(e.target.value); updateCell(i, col, v); }}
                            onPaste={e => handlePaste(e, i, col)} />
                        </td>
                      ))}
                    </tr>
                  ))}
                  <tr className="ca-total-row">
                    <td className="ca-td" colSpan={2}><span className="ca-total-label">Total</span></td>
                    {NUM_COLS.map(col => <td key={col} className="ca-td ca-td--total">{fmt(totals[col])}</td>)}
                  </tr>
                </tbody>
              </table>
            </div>
          </div>

          {showDistModal && (
            <div className="ca-modal-backdrop" role="presentation" onClick={e => { if (e.target === e.currentTarget) setShowDistModal(false); }}>
              <div className="ca-modal">
                <div className="ca-modal-head">
                  <div className="ca-modal-title">Occupancy Distribution{activeCob ? ` — ${activeCob.name}` : ''}</div>
                  <button className="ca-modal-x" onClick={() => setShowDistModal(false)}>✕</button>
                </div>
                <div className="ca-modal-body">
                  <div className="ca-modal-sub">Distribute aggregate exposure between occupancy categories. Must total 100%.
                    {activeCob && <span> Applied to <strong>{activeCob.name}</strong> / <strong>{aggTreatyType}</strong>.</span>}
                  </div>
                  <div className="ca-dist-grid">
                    {DISTRIBUTION_CATS.map(cat => (
                      <div key={cat.key} className="ca-dist-row">
                        <span className="ca-dist-label">{cat.label}</span>
                        <div className="ca-dist-inp-wrap">
                          <PctInput className="ca-dist-inp"
                            value={distribution[cat.key]} onChange={v => setDistribution(p => ({...p,[cat.key]:cn(v)}))} />
                        </div>
                        <div className="ca-dist-bar"><div className="ca-dist-fill" style={{width:`${Math.min(100,cn(distribution[cat.key]))}%`}} /></div>
                      </div>
                    ))}
                  </div>
                  <div className={`ca-dist-total ${Math.abs(distTotal-100)<0.01?'ca-dist-total--ok':'ca-dist-total--err'}`}>
                    Total: <strong>{distTotal.toFixed(1)}%</strong>{Math.abs(distTotal-100)<0.01?' ✓':' — must equal 100%'}
                  </div>
                  <button className="ca-btn ca-btn--ghost" style={{marginTop:8}} onClick={() => setDistribution({...DEFAULT_DIST})}>Reset to Defaults</button>
                </div>
                <div className="ca-modal-foot">
                  <button className="ca-btn" onClick={() => setShowDistModal(false)}>Cancel</button>
                  <button className="ca-btn ca-btn--save" disabled={Math.abs(distTotal-100)>0.01}
                    onClick={() => { setShowDistModal(false); setDirty(true); }}>Apply Distribution</button>
                </div>
              </div>
            </div>
          )}
        </div>
  );

  if (embedded) return mainContent;

  return (
    <WizardLayout routeKey={effectiveRouteKey} title="CRESTA Aggregates"
      headerPill={isNpMode ? (appState.quoteMode ? 'NP-QUOTE TREATY: CRESTA ZONES' : 'NON-PROPORTIONAL TREATY: CRESTA ZONES') : 'PROPORTIONAL TREATY: CRESTA ZONES'}
      onBeforeNext={saveAllContexts} onBeforeBack={saveAllContexts}>
      {() => mainContent}
    </WizardLayout>
  );
}
