import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { useLocation } from 'react-router-dom';
import { api } from '../../../api';
import { useAppState } from '../../../context/AppContext';
import { useContractId, setActiveContractId, setActiveQuoteId } from '../../../hooks/useContractId';
import { ACTIVE_QUOTE_ID } from '../../../constants/storageKeys';
import WizardLayout from '../../../components/WizardLayout';
import PctInput from '../../../components/PctInput';
import SlipIngestButton from '../../../components/SlipIngestButton';
import ImportedFromPackBanner from '../../../components/ImportedFromPackBanner';
import {
  addMonthsClamped,
  dateInputValue,
  yearFromDateInput,
} from '../../../utils/format';
import { handleStaleWrite } from '../../../utils/handleStaleWrite';

const ROUTE_KEY = 'NP_TREATY_DETAIL';

/* ─── helpers (exported helpers are covered by NpTreatyDetail.test.js) ─── */
export const numOrNull = v => { const c = String(v ?? '').replace(/,/g,'').trim(); if (!c) return null; const n = Number(c); return Number.isFinite(n) ? n : null; };
const fmtComma = v => { const d = String(v ?? '').replace(/[^\d]/g,''); return d ? Number(d).toLocaleString('en-US') : ''; };
const stripDigits = v => String(v ?? '').replace(/[^\d]/g,'');
const cleanNum = v => { if (v == null || v === '') return ''; const n = Number(v); if (!Number.isFinite(n)) return String(v); return n === Math.floor(n) ? String(Math.floor(n)) : String(n); };

/**
 * Add months to a 'YYYY-MM-DD' string with day clamping. Date.setMonth
 * overflows when the source day doesn't exist in the target month
 * (e.g. Jan 31 → Mar 3, Feb 29 → Mar 1 next year). Clamp to the last
 * valid day instead.
 */
export function addMonths(dateStr, months) {
  return addMonthsClamped(dateStr, months);
}

/** Year from an ISO date input ('YYYY-MM-DD') without timezone conversion. */
export const yearFromDateStr = yearFromDateInput;

/* Close-on-Escape — wired by every screen-level modal in this file. */
function useEscapeKey(enabled, onEscape) {
  useEffect(() => {
    if (!enabled) return undefined;
    const onKey = e => { if (e.key === 'Escape') onEscape(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [enabled, onEscape]);
}

/* ─── Form Row: label left, input right (matches proportional) ─── */
function FR({ label, children }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '160px 1fr', gap: 10, alignItems: 'center', minHeight: 36 }}>
      <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.55)' }}>{label}</div>
      <div>{children}</div>
    </div>
  );
}

/* ─── Comma-formatted number input ─── */
function CommaInput({ value, onChange, placeholder, readOnly, disabled, suffix }) {
  const [display, setDisplay] = useState(fmtComma(value));
  useEffect(() => { setDisplay(fmtComma(value)); }, [value]);
  const handleChange = e => { const raw = stripDigits(e.target.value); setDisplay(fmtComma(raw)); onChange(raw); };
  return (
    <div style={{ position: 'relative' }}>
      <input className="fi" type="text" inputMode="numeric" placeholder={placeholder}
        value={display} onChange={handleChange} readOnly={readOnly} disabled={disabled}
        style={suffix ? { paddingRight: 40 } : {}} />
      {suffix && <span style={{ position:'absolute',right:10,top:'50%',transform:'translateY(-50%)',fontSize:11,color:'rgba(255,255,255,.35)',pointerEvents:'none' }}>{suffix}</span>}
    </div>
  );
}

/* ─── COB Multi-Select Modal (matches proportional) ─── */
function CobSelectModal({ selected, classList, onSave, onClose }) {
  const [sel, setSel] = useState(new Set(selected || []));
  const toggle = id => { const n = new Set(sel); if (n.has(id)) n.delete(id); else n.add(id); setSel(n); };
  useEscapeKey(true, onClose);
  return (
    <div className="modal-backdrop" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="modal glass" role="dialog" aria-modal="true" aria-labelledby="np-cob-select-title" style={{ maxWidth: 500 }}>
        <div className="modal-title" id="np-cob-select-title">
          <span>Select Lines of Business</span>
          <button type="button" className="modal-close" onClick={onClose} aria-label="Close">✕</button>
        </div>
        <div style={{ padding: '12px 24px', maxHeight: '50vh', overflowY: 'auto' }}>
          {(classList || []).map(c => (
            <label key={c.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0', cursor: 'pointer', fontSize: 13 }}>
              <input type="checkbox" checked={sel.has(c.id)} onChange={() => toggle(c.id)} style={{ width: 16, height: 16, accentColor: '#23d18b' }} />
              {c.name}
            </label>
          ))}
        </div>
        <div className="modal-actions">
          <button className="btn ghost" onClick={onClose}>Cancel</button>
          <button className="btn primary" onClick={() => onSave([...sel])}>Apply</button>
        </div>
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════
   MAIN COMPONENT
   ═══════════════════════════════════════════════ */
export default function NpTreatyDetail() {
  const { state: appState, setSlice } = useAppState();
  const contractId = useContractId();

  /* Quote mode: detected from appState */
  // Resolve quoteMode: appState is authoritative after RESET_FLOW, but also check
  // localStorage in case we arrived before appState propagated
  const quoteMode = !!(appState.quoteMode) || (() => {
    try { return !!localStorage.getItem(ACTIVE_QUOTE_ID); } catch { return false; }
  })();

  const [cedants, setCedants] = useState([]);
  const [brokers, setBrokers] = useState([]);
  const [treatyTypes, setTreatyTypes] = useState([]);
  const [classes, setClasses] = useState([]);
  const [pendingCedantName, setPendingCedantName] = useState(null);
  const [countries, setCountries] = useState([]);
  const [currencies, setCurrencies] = useState([]);

  const [showCobModal, setShowCobModal] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [lookupsReady, setLookupsReady] = useState(false);

  const s = appState.npTreatyDetail || {};
  const update = useCallback((patch) => setSlice('npTreatyDetail', patch), [setSlice]);

  /* ── Clean slate: when there is no contractId, reset the slice so old data
     doesn't bleed through. Reads s.contractId / s._loadedFromServer
     deliberately stale — re-running on those would re-clear the slice we just
     populated. ── */
  useEffect(() => {
    if (!contractId && !s.contractId && s._loadedFromServer) {
      setSlice('npTreatyDetail', {
        contractId: null, status: 'DRAFT',
        countryId: '', cedantId: '', brokerId: '', currencyId: '', treatyTypeId: '',
        treatyTypeName: '', currencyCode: '', cedantName: '', brokerName: '', countryName: '',
        lineOfBusinessLabels: [], classIds: [], startYear: '', experienceStartYear: '', renewalDate: '', inceptionDate: '',
        deductible: '', maxRetention: '', accountingMethod: '', xlType: '', accounts: '',
        numberOfLayers: '', expiringNumberOfLayers: '',
        estGnpi: '', brokeragePct: '', taxesPct: '', noClaimsBonusPct: '', profitCommissionPct: '',
        _loadedFromServer: false, _renewalManual: false,
      });
    }
  }, [contractId, s.contractId, s._loadedFromServer, setSlice]);

  /* derived */
  const selectedTypeName = useMemo(() => treatyTypes.find(x => String(x.id) === String(s.treatyTypeId))?.name || '', [treatyTypes, s.treatyTypeId]);

  // Sync treatyTypeName into the state slice so other screens (Structure) can read it
  useEffect(() => {
    if (selectedTypeName && selectedTypeName !== s.treatyTypeName) {
      update({ treatyTypeName: selectedTypeName });
    }
  }, [selectedTypeName, s.treatyTypeName, update]);
  const currencyCode = useMemo(() => currencies.find(x => String(x.id) === String(s.currencyId))?.code || currencies.find(x => String(x.id) === String(s.currencyId))?.name || '', [currencies, s.currencyId]);
  // Sync currencyCode into slice so Structure, Pricing etc. can read it without refetching
  useEffect(() => {
    if (currencyCode && currencyCode !== s.currencyCode) {
      update({ currencyCode });
    }
  }, [currencyCode, s.currencyCode, update]);
  const countryName = useMemo(() => countries.find(c => String(c.id) === String(s.countryId))?.name || '', [countries, s.countryId]);
  const cedantName = useMemo(() => cedants.find(c => String(c.id) === String(s.cedantId))?.name || '', [cedants, s.cedantId]);
  const brokerName = useMemo(() => brokers.find(b => String(b.id) === String(s.brokerId))?.name || '', [brokers, s.brokerId]);
  const cobNames = useMemo(() => (s.classIds || []).map(id => classes.find(c => c.id === id)?.name).filter(Boolean), [s.classIds, classes]);

  const cobText = useMemo(() => {
    const ids = s.classIds || [];
    if (!ids.length) return 'Select classes…';
    const names = ids.map(id => classes.find(c => c.id === id)?.name).filter(Boolean);
    if (names.length <= 2) return names.join(', ');
    return `${names.slice(0, 2).join(', ')} +${names.length - 2} more`;
  }, [s.classIds, classes]);

  const countryCode = useMemo(() => countries.find(c => String(c.id) === String(s.countryId))?.code || '', [countries, s.countryId]);

  /* contract description auto-gen (matches proportional) */
  const contractDescription = useMemo(() => {
    const dateAnchor = quoteMode ? (s.inceptionDate || s.renewalDate) : s.inceptionDate;
    const yr = yearFromDateStr(dateAnchor) || '';
    const parts = [yr, cedantName, selectedTypeName, cobNames.length ? `(${cobNames.join(', ')})` : '', countryCode].filter(Boolean);
    const base = parts.join(' ') || '';
    return base ? (quoteMode ? `${base} Q` : base) : '';
  }, [s.inceptionDate, s.renewalDate, cedantName, selectedTypeName, cobNames, countryCode, quoteMode]);

  // Keep lineOfBusinessLabels in slice in sync so downstream screens
  // (losses, profiles, aggregates, final quote) can read COB names.
  // This also clears stale labels when the user removes all COBs.
  const cobNamesKey = cobNames.join(',');
  const savedCobNamesKey = (s.lineOfBusinessLabels || []).join(',');
  useEffect(() => {
    if (cobNamesKey !== savedCobNamesKey) update({ lineOfBusinessLabels: cobNames });
  }, [cobNamesKey, savedCobNamesKey, cobNames, update]);

  /* auto-calc: renewal = inception + 12 months (matches proportional) */
  useEffect(() => {
    if (!loaded) return;
    if (s.inceptionDate && !s._renewalManual) {
      const auto = addMonths(s.inceptionDate, 12);
      if (auto !== s.renewalDate) update({ renewalDate: auto });
    }
  }, [s.inceptionDate, loaded, update, s._renewalManual, s.renewalDate]);

  /* auto-derive: UW year = year of inception date */
  useEffect(() => {
    if (!loaded) return;
    const yr = yearFromDateStr(s.inceptionDate);
    if (yr && String(yr) !== String(s.startYear)) update({ startYear: String(yr) });
  }, [s.inceptionDate, loaded, update, s.startYear]);

  /* ── Load lookups (mount-only) ── */
  useEffect(() => {
    Promise.all([
      api.listBrokers().catch(() => []),
      api.listTreatyTypes().catch(() => []),
      api.listClassOfBusiness().catch(() => []),
      api.getRefListItems('currency').catch(() => []),
      api.getRefListItems('country').catch(() => []),
    ]).then(([b, t, cl, cur, cty]) => {
      setBrokers(Array.isArray(b) ? b : []);
      setTreatyTypes((Array.isArray(t) ? t : []).filter(x => String(x.category || '').toUpperCase() === 'NON_PROPORTIONAL'));
      setClasses(Array.isArray(cl) ? cl : []);
      setCurrencies(Array.isArray(cur) ? cur : []);
      setCountries(Array.isArray(cty) ? cty : []);
      setLookupsReady(true);
    });
  }, []);

  /* ── Country → Cedants cascade (matches proportional) ── */
  useEffect(() => {
    if (!s.countryId) { setCedants([]); return; }
    api.listCedants({ countryId: s.countryId }).then(r => setCedants(Array.isArray(r) ? r : [])).catch(() => setCedants([]));
  }, [s.countryId]);

  /* ── Deferred cedant match: after slip ingest sets countryId, cedants reload, then auto-match ── */
  useEffect(() => {
    if (!pendingCedantName || !cedants.length || s.cedantId) return;
    const v = pendingCedantName.toLowerCase();
    const match = cedants.find(c => c.name.toLowerCase() === v)
      || cedants.find(c => c.name.toLowerCase().includes(v) || v.includes(c.name.toLowerCase()));
    if (match) { update({ cedantId: String(match.id) }); setPendingCedantName(null); }
  }, [cedants, pendingCedantName, s.cedantId, update]);

  /* ── Mark loaded for new treaties once lookups ready ── */
  useEffect(() => {
    if (!loaded && !contractId && lookupsReady) {
      setLoaded(true);
    }
  }, [loaded, contractId, lookupsReady]);

  /* ── Load existing ── */
  useEffect(() => {
    if (!contractId || loaded) return;
    if (s._loadedFromServer && String(s.contractId) === String(contractId)) {
      setLoaded(true);
      return;
    }
    Promise.all([
      api.getContract(contractId, quoteMode ? { quote: true } : undefined).catch(() => null),
      api.getNonPropTreaty(contractId, quoteMode ? { quote: true } : undefined).catch(() => null),
    ]).then(([data, np]) => {
      if (!data) { setLoaded(true); return; }
      const h = data.header || {};
      const d = np?.detail || {};
      const inceptionDate = dateInputValue(h.inception_date || d.inception_date || (np && np.terms && np.terms.treaty_detail || {}).inceptionDate || '');
      const renewalDate   = dateInputValue(h.renewal_date || ((np && np.terms && np.terms.treaty_detail) || {}).renewalDate || '');
      // Treat the persisted renewal as user-picked when it differs from
      // inception+12mo. Otherwise the auto-calc effect would overwrite a
      // manually-set renewal as soon as `loaded` flips to true.
      const renewalIsManual = !!renewalDate && !!inceptionDate && renewalDate !== addMonths(inceptionDate, 12);
      update({
        contractId: data.contract_id || contractId,
        status: h.uw_status || h.status || 'DRAFT',
        parentContractId: h.parent_contract_id || null,
        quoteRef: data.quote_ref || h.quote_ref || null,
        quoteVersion: data.quote_version || h.quote_version || null,
        cedantId: h.cedant_id || '', cedantName: h.cedant_name || '', brokerId: h.broker_id || '', brokerName: h.broker_name || '',
        currencyId: h.currency_id || '', countryId: h.country_id || '', countryName: h.country_name || '',
        treatyTypeId: h.treaty_type_id || '', treatyTypeName: h.treaty_type_name || '', startYear: h.uw_year || '',
        experienceStartYear: d.experience_start_year || d.start_year || '',
        renewalDate,
        inceptionDate,
        _renewalManual: renewalIsManual,
        classIds: data.class_ids || [],
        deductible: cleanNum(d.deductible), maxRetention: cleanNum(d.max_retention),
        accountingMethod: d.accounting_method || '', xlType: d.xl_type || '',
        accounts: d.accounts || '',
        numberOfLayers: cleanNum(d.number_of_layers) || '',
        brokeragePct: cleanNum(d.brokerage_pct), taxesPct: cleanNum(d.taxes_pct), noClaimsBonusPct: cleanNum(d.no_claims_bonus_pct),
        profitCommissionPct: cleanNum(d.profit_commission_pct),
        estGnpi: cleanNum(d.est_gnpi || ((np && np.terms && np.terms.treaty_detail) || {}).estGnpi),
        /* quote-mode fields (from JSONB terms or relational) */
        quoteStructuresCount: cleanNum(d.structures_to_quote || d.quote_structures_count || np?.terms?.treaty_detail?.quoteStructuresCount || np?.terms?.np_terms?.quote?.structures_count) || '',
        expiringNumberOfLayers: cleanNum(d.expiring_number_of_layers || np?.terms?.treaty_detail?.expiringNumberOfLayers || np?.terms?.np_terms?.quote?.expiring_number_of_layers) || '',
        _updatedAt: data.updated_at || data.updatedAt || null,
        _loadedFromServer: true,
      });
      (quoteMode ? setActiveQuoteId : setActiveContractId)(data.contract_id || data.quote_id || contractId);
      setLoaded(true);
    });
  }, [contractId, loaded, quoteMode, s.contractId, s._loadedFromServer, update]);

  /* ── Save ── */
  const saveRef = React.useRef(null);
  const stateRef = React.useRef(appState);
  const lastExplicitSaveAtRef = React.useRef(0);
  useEffect(() => { stateRef.current = appState; }, [appState]);
  const save = useCallback(async () => {
    // Read the slice from the ref so save() stays referentially stable across
    // keystrokes — saveRef.current and the unmount effect both depend on this.
    const cur = stateRef.current?.npTreatyDetail || {};
    const qm = (stateRef.current?.quoteMode || quoteMode) ? { quote: true } : undefined;
    const isQuoteSave = !!qm;
    const hasContent = !!(cur.cedantId || cur.treatyTypeId || cur.countryId);
    if (!contractId && !cur.contractId && !hasContent) return true;
    // Surface required-field gaps via the SaveStateIndicator banner before the
    // backend rejects with a generic 400. Only enforce when the user has
    // actually started the form — typed-Error message is rendered by
    // WizardLayout's runTrackedSave catch block.
    if (hasContent) {
      const missing = [];
      if (!cur.cedantId)      missing.push('Cedant');
      if (!cur.treatyTypeId)  missing.push('Treaty Type');
      if (!cur.countryId)     missing.push('Country');
      if (!isQuoteSave && !cur.inceptionDate) missing.push('Inception Date');
      if (missing.length) throw new Error(`Required: ${missing.join(', ')}`);
    }
    let attemptedHeaderPayload = null;
    let attemptedId = cur.contractId || contractId;
    const attemptedQm = qm;
    try {
      const effectiveUwYear =
        cur.startYear ||
        yearFromDateStr(cur.inceptionDate) ||
        yearFromDateStr(cur.renewalDate) ||
        new Date().getFullYear();
      const headerPayload = {
        terms: {
          header: {
            cedant_id: cur.cedantId, broker_id: cur.brokerId, currency_id: cur.currencyId,
            country_id: cur.countryId, treaty_type_id: cur.treatyTypeId,
            uw_year: effectiveUwYear, renewal_date: cur.renewalDate,
            inception_date: cur.inceptionDate, contract_description: contractDescription,
          },
          class_ids: cur.classIds || [],
        },
      };
      let cid = cur.contractId;
      if (cid) {
        attemptedHeaderPayload = headerPayload;
        const res = await api.saveContract(cid, headerPayload, { ...(qm || {}), ...(cur._updatedAt ? { ifUnmodifiedSince: cur._updatedAt } : {}) });
        if (res?.updated_at) update({ _updatedAt: res.updated_at });
      } else {
        const createFn = qm ? api.createQuote : api.createContract;
        const res = await createFn({
          cedant_id: cur.cedantId, broker_id: cur.brokerId, currency_id: cur.currencyId,
          treaty_type_id: cur.treatyTypeId, country_id: cur.countryId, uw_year: effectiveUwYear,
          renewal_date: cur.renewalDate || null,
          inception_date: cur.inceptionDate || null,
          contract_description: contractDescription || null,
        });
        cid = res?.contract_id || res?.quote_id || res?.id;
        if (cid) {
          attemptedId = cid;
          attemptedHeaderPayload = headerPayload;
          const savedHeader = await api.saveContract(cid, headerPayload, qm || undefined).catch(() => null);
          update({
            contractId: cid,
            startYear: String(effectiveUwYear),
            quoteRef: qm ? (res?.quote_ref || savedHeader?.quote_ref || null) : undefined,
            quoteVersion: qm ? (res?.quote_version || savedHeader?.quote_version || null) : undefined,
            _updatedAt: savedHeader?.updated_at || res?.updated_at || null,
          });
          (qm ? setActiveQuoteId : setActiveContractId)(cid);
        }
      }
      if (cid) {
        await api.saveNonPropTreaty(cid, {
          detail: {
            number_of_layers: cur.numberOfLayers ? parseInt(cur.numberOfLayers) : null,
            expiring_number_of_layers: cur.expiringNumberOfLayers ? parseInt(cur.expiringNumberOfLayers) : null,
            deductible: cur.deductible,
            max_retention: cur.maxRetention, accounting_method: cur.accountingMethod,
            xl_type: cur.xlType, accounts: cur.accounts,
            brokerage_pct: cur.brokeragePct, taxes_pct: cur.taxesPct, no_claims_bonus_pct: cur.noClaimsBonusPct,
            profit_commission_pct: cur.profitCommissionPct,
            est_gnpi: cur.estGnpi,
            experience_start_year: cur.experienceStartYear ? parseInt(cur.experienceStartYear) : null,
            structures_to_quote: cur.quoteStructuresCount ? parseInt(cur.quoteStructuresCount) : null,
          },
          layers: [],
          terms: {
            treaty_detail: {
              quoteStructuresCount: cur.quoteStructuresCount || '',
              expiringNumberOfLayers: cur.expiringNumberOfLayers || '',
              inceptionDate: cur.inceptionDate || '',
              renewalDate: cur.renewalDate || '',
              estGnpi: cur.estGnpi || '',
              startYear: String(effectiveUwYear),
            },
            np_terms: {
              quote: {
                structures_count: numOrNull(cur.quoteStructuresCount),
                expiring_number_of_layers: numOrNull(cur.expiringNumberOfLayers),
              },
            },
          },
        }, qm);
        // Always sync the COB junction so removing all classes actually clears
        // the rows downstream screens (NpStructure) read.
        try {
          await Promise.resolve(api.saveContractCobs(
            cid,
            { class_ids: cur.classIds || [] },
            qm,
          ));
        } catch (e) {
          console.warn('[NpTreatyDetail] saveContractCobs failed (non-fatal, header already saved):', e?.message);
        }
      }
      lastExplicitSaveAtRef.current = Date.now();
      return true;
    } catch (e) {
      // Re-throw typed errors (e.g. required-field gate) so WizardLayout's
      // SaveStateIndicator banner can show the missing list.
      if (e instanceof Error && /^Required:/.test(e.message)) throw e;
      const stale = await handleStaleWrite(e, {
        entityType: attemptedQm ? 'quote' : 'treaty',
        onRefresh: () => window.location.reload(),
        onOverwrite: async () => {
          if (!attemptedId || !attemptedHeaderPayload) return null;
          const res = await api.saveContract(attemptedId, attemptedHeaderPayload, { ...(attemptedQm || {}), ifUnmodifiedSince: '*' });
          if (res?.updated_at) update({ _updatedAt: res.updated_at });
          lastExplicitSaveAtRef.current = Date.now();
          return res;
        },
      });
      if (stale.handled) return stale.action === 'overwrite';
      console.error('Save:', e);
      return false;
    }
  }, [contractId, update, contractDescription, quoteMode]);

  useEffect(() => { saveRef.current = save; }, [save]);

  const quoteIdentifier = quoteMode
    ? (s.quoteRef || (s.contractId
      ? `QT-${s.startYear || yearFromDateStr(s.renewalDate) || new Date().getFullYear()}-${String(s.contractId).slice(-6).toUpperCase()}`
      : 'Auto-generated on first save'))
    : (s.contractId || '(new)');

  /* Auto-save on unmount (e.g. sidebar nav). Gate on any meaningful field —
     for a brand-new treaty there is no contractId yet, so the original
     contractId-only gate silently dropped the form contents. */
  useEffect(() => {
    return () => {
      const cur = stateRef.current?.npTreatyDetail;
      const hasContent = !!(cur?.contractId || cur?.cedantId || cur?.treatyTypeId || cur?.countryId);
      if (Date.now() - lastExplicitSaveAtRef.current < 2000) return;
      if (hasContent && saveRef.current) {
        saveRef.current().catch(e => console.error('[NpTreatyDetail] unmount save failed:', e));
      }
    };
  }, []);

  // Same import-flow nav state read as PropTreatyDetail.
  const location = useLocation();
  const importedFromState = location?.state?.importedFromPack ? {
    sourceFilename: location.state.sourceFilename,
    priorTreatyId: location.state.priorTreatyId,
  } : null;

  /* ═══ RENDER ═══ */
  return (
    <WizardLayout routeKey={ROUTE_KEY} title="Treaty Detail" headerPill={`${quoteMode ? 'NP-QUOTE TREATY' : 'NON-PROPORTIONAL TREATY'}: TREATY DETAIL`}
      onBeforeNext={save} onBeforeBack={save}>
      {() => (<>

        <ImportedFromPackBanner quoteId={contractId} importedFromState={importedFromState} />

        {/* ── Summary bar (matches proportional) ── */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12, flexWrap: 'wrap', gap: 8 }}>
          {quoteMode && s.contractId && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 12px', borderRadius: 8,
              background: 'rgba(251,191,36,0.08)', border: '1px solid rgba(251,191,36,0.30)', fontSize: 12 }}>
              <span style={{ color: '#fbbf24', fontWeight: 700 }}>
                📋 {s.quoteRef || `QT-${s.startYear || new Date().getFullYear()}-${s.contractId?.slice(-6)?.toUpperCase()}`}
              </span>
              {s.quoteVersion > 1 && (
                <span style={{ fontSize: 10, color: 'rgba(251,191,36,0.65)', fontWeight: 600 }}>v{s.quoteVersion}</span>
              )}
              <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.35)', fontFamily: 'monospace' }}>
                {s.contractId?.slice(0,8)}…
              </span>
            </div>
          )}
          {s.parentContractId && (
            <div style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 6, padding: '4px 10px', borderRadius: 8,
              background: 'rgba(96,165,250,0.10)', border: '1px solid rgba(96,165,250,0.30)', fontSize: 11, color: '#60a5fa', fontWeight: 700 }}>
              🔄 Renewal — linked to prior year contract
            </div>
          )}
          <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.55)' }}>
            Cedant: <b>{cedantName || '—'}</b>{' · '}Country: <b>{countryName || '—'}</b>
            {' · '}Broker: <b>{brokerName || '—'}</b>{' · '}Currency: <b>{currencyCode || '—'}</b>{' · '}Type: <b>{selectedTypeName || '—'}</b>
            {cobNames.length > 0 && <>{' · '}COB: <b>{cobNames.join(', ')}</b></>}
          </div>
        </div>

        {/* ── Contract description (matches proportional) ── */}
        {contractDescription && (
          <div style={{ padding: '8px 14px', marginBottom: 14, borderRadius: 10, background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.06)', fontSize: 12, color: 'rgba(255,255,255,0.7)' }}>
            <span style={{ color: 'rgba(255,255,255,0.4)', marginRight: 8 }}>Contract:</span>{contractDescription}
          </div>
        )}

        {/* ── Two-column grid (matches proportional 2×2 but 1×2) ── */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 18 }}>

          {/* ═══ CONTRACT DETAILS ═══ */}
          <div className="card glass" style={{ display: 'flex', flexDirection: 'column' }}>
            <div className="card-head">
              <span className="card-header-label">CONTRACT DETAILS</span>
              <span className="card-header-tag">INPUT</span>
              <SlipIngestButton
                mode="NP"
                currentValues={{
                  countryId: s.countryId,
                  cedantId: s.cedantId,
                  treatyTypeId: s.treatyTypeId,
                  classIds: s.classIds,
                  brokerId: quoteMode ? '' : s.brokerId,
                  currencyId: s.currencyId,
                  inceptionDate: quoteMode ? '' : s.inceptionDate,
                  renewalDate: s.renewalDate,
                  experienceStartYear: s.experienceStartYear,
                  numberOfLayers: quoteMode ? '' : s.numberOfLayers,
                  expiringNumberOfLayers: quoteMode ? '' : s.expiringNumberOfLayers,
                  deductible: quoteMode ? '' : s.deductible,
                  maxRetention: quoteMode ? '' : s.maxRetention,
                  xlType: quoteMode ? '' : s.xlType,
                  accountingMethod: quoteMode ? '' : s.accountingMethod,
                  accounts: quoteMode ? '' : s.accounts,
                  estGnpi: quoteMode ? '' : s.estGnpi,
                  brokeragePct: s.brokeragePct,
                  taxesPct: s.taxesPct,
                  noClaimsBonusPct: quoteMode ? '' : s.noClaimsBonusPct,
                  profitCommissionPct: quoteMode ? '' : s.profitCommissionPct,
                }}
                countries={countries}
                treatyTypes={treatyTypes}
                brokers={brokers}
                cedants={cedants}
                currencies={currencies}
                classes={classes}
                onFill={fields => {
                  // Apply all directly-mappable scalar fields
                  const direct = {};
                  const scalars = ['inceptionDate','renewalDate','numberOfLayers','deductible','maxRetention',
                    'xlType','accountingMethod','accounts','estGnpi','brokeragePct','taxesPct',
                    'noClaimsBonusPct','profitCommissionPct','experienceStartYear',
                    'currencyId','treatyTypeId','brokerId','classIds'];
                  scalars.forEach(k => { if (fields[k] != null) direct[k] = fields[k]; });

                  // countryId: set + clear cedantId so cedant list reloads
                  if (fields.countryId) {
                    direct.countryId = fields.countryId;
                    direct.cedantId = ''; // will be re-set below after list loads if possible
                  }
                  // If cedantId resolved immediately (cedants already loaded for this country)
                  if (fields.cedantId) {
                    direct.cedantId = fields.cedantId;
                  } else if (fields._cedantNameRaw) {
                    setPendingCedantName(fields._cedantNameRaw);
                  }

                  // Convert numeric strings for percent fields
                  ['brokeragePct','taxesPct','noClaimsBonusPct','profitCommissionPct'].forEach(k => {
                    if (direct[k] != null) direct[k] = String(direct[k]);
                  });
                  // Numeric fields stored as raw string (CommaInput)
                  ['deductible','maxRetention','estGnpi'].forEach(k => {
                    if (direct[k] != null) direct[k] = String(direct[k]).replace(/,/g,'');
                  });
                  // numberOfLayers / experienceStartYear
                  if (direct.numberOfLayers != null) direct.numberOfLayers = String(direct.numberOfLayers);
                  if (direct.experienceStartYear != null) direct.experienceStartYear = String(direct.experienceStartYear);

                  update(direct);
                }}
              />
            </div>
            <div style={{ padding: '14px 18px', display: 'flex', flexDirection: 'column', gap: 8, flex: 1 }}>
              {/* Treaty detail card.
                  Quote mode is intentionally minimal per spec: only Country,
                  Cedant, Treaty Type are inputs the underwriter must fill;
                  Classes of Business, Quote ID, Currency, Renewal, Experience Start Year and the
                  description are shown as outputs (currency/renewal/start
                  year remain editable so the user can override the smart
                  defaults). Broker, Inception Date and UW Year are
                  hidden — they aren't needed to produce a quote. */}
              <FR label="Country"><select className="fi" value={s.countryId || ''} onChange={e => update({ countryId: e.target.value, cedantId: '' })}>
                <option value="">Select country…</option>{countries.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select></FR>
              <FR label="Cedant Name"><select className="fi" value={s.cedantId || ''} onChange={e => update({ cedantId: e.target.value })} disabled={!s.countryId}>
                <option value="">{s.countryId ? 'Select cedant…' : 'Select country first…'}</option>{cedants.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select></FR>
              <FR label="Treaty Type"><select className="fi" value={s.treatyTypeId || ''} onChange={e => {
                const sel = treatyTypes.find(t => String(t.id) === e.target.value);
                update({ treatyTypeId: e.target.value, treatyTypeName: sel?.name || '' });
              }}>
                <option value="">Select treaty type…</option>{treatyTypes.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}</select></FR>
              <FR label="Classes of Business">
                <button className="fi" type="button" onClick={() => setShowCobModal(true)}
                  style={{ textAlign: 'left', cursor: 'pointer', color: (s.classIds || []).length ? 'rgba(255,255,255,0.9)' : 'rgba(255,255,255,0.3)' }}>
                  {cobText} <span style={{ float: 'right', opacity: 0.3 }}>▾</span>
                </button>
              </FR>
              {!quoteMode && (
                <FR label="Broker"><select className="fi" value={s.brokerId || ''} onChange={e => update({ brokerId: e.target.value })}>
                  <option value="">Select broker…</option>{brokers.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}</select></FR>
              )}
              <FR label={quoteMode ? 'Quote ID' : 'Contract ID'}><input className="fi" value={quoteIdentifier} readOnly style={{ opacity: 0.5 }} /></FR>
              <FR label="Currency"><select className="fi" value={s.currencyId || ''} onChange={e => update({ currencyId: e.target.value })}>
                <option value="">Select currency…</option>{currencies.map(c => <option key={c.id} value={c.id}>{c.code || c.name}</option>)}</select></FR>
              {!quoteMode && (
                <FR label="Treaty Inception Date"><input className="fi" type="date" value={s.inceptionDate || ''} onChange={e => update({ inceptionDate: e.target.value, _renewalManual: false })} /></FR>
              )}
              <FR label={quoteMode ? 'Renewal' : 'Treaty Renewal Date'}><input className="fi" type="date" value={s.renewalDate || ''} onChange={e => update({ renewalDate: e.target.value, _renewalManual: true })} /></FR>
              {!quoteMode && (
                <FR label="UW Year"><input className="fi" value={s.startYear || (yearFromDateStr(s.inceptionDate) ? String(yearFromDateStr(s.inceptionDate)) : '')} readOnly title="Auto-derived from Treaty Inception Date" style={{ opacity: 0.7 }} /></FR>
              )}
              <FR label="Experience Start Year">
                <select className="fi" value={s.experienceStartYear || ''} onChange={e => update({ experienceStartYear: e.target.value })}>
                  <option value="">Select start year…</option>
                  {Array.from({ length: 41 }, (_, i) => new Date().getFullYear() - 40 + i).map(y => <option key={y} value={y}>{y}</option>)}
                </select>
              </FR>
              <FR label={quoteMode ? 'Description' : 'Contract Description'}><input className="fi" value={contractDescription} readOnly style={{ opacity: 0.6, fontSize: 11 }} /></FR>
            </div>
          </div>

          {/* Right column.
              In quote mode this collapses to a Brokerage & Taxes card per
              spec — layer config, retention, accounting method, GNPI and
              the secondary commission fields all live on later screens or
              the quote screen redesign. The contract flow keeps the full
              Structure card unchanged. */}
          {quoteMode ? (
            <div className="card glass" style={{ display: 'flex', flexDirection: 'column' }}>
              <div className="card-head"><span className="card-header-label">BROKERAGE &amp; TAXES</span><span className="card-header-tag">QUOTE INPUT</span></div>
              <div style={{ padding: '14px 18px', display: 'flex', flexDirection: 'column', gap: 8, flex: 1 }}>
                <FR label="Brokerage %"><PctInput className="fi" placeholder="e.g. 10%" value={s.brokeragePct || ''} onChange={v => update({ brokeragePct: v })} /></FR>
                <FR label="Taxes %"><PctInput className="fi" placeholder="e.g. 2%" value={s.taxesPct || ''} onChange={v => update({ taxesPct: v })} /></FR>
              </div>
            </div>
          ) : (
            <div className="card glass" style={{ display: 'flex', flexDirection: 'column' }}>
              <div className="card-head"><span className="card-header-label">STRUCTURE</span><span className="card-header-tag">TERMS</span></div>
              <div style={{ padding: '14px 18px', display: 'flex', flexDirection: 'column', gap: 8, flex: 1 }}>
                <div className="mini-title">LAYER CONFIGURATION</div>
                <FR label="Number of Layers"><input className="fi" type="number" min="1" max="20" placeholder="e.g. 4" value={s.numberOfLayers || ''} onChange={e => update({ numberOfLayers: e.target.value })} /></FR>
                <FR label="Expiring · Number of Layers"><input className="fi" type="number" min="0" placeholder="e.g. 4" value={s.expiringNumberOfLayers || ''} onChange={e => update({ expiringNumberOfLayers: e.target.value })} /></FR>
                <FR label="Deductible"><CommaInput value={s.deductible} onChange={v => update({ deductible: v })} placeholder="e.g. 1,000,000" suffix={currencyCode} /></FR>
                <FR label="Maximum Retention"><CommaInput value={s.maxRetention} onChange={v => update({ maxRetention: v })} placeholder="e.g. 5,000,000" suffix={currencyCode} /></FR>
                <FR label="Accounting Method"><select className="fi" value={s.accountingMethod || ''} onChange={e => update({ accountingMethod: e.target.value })}>
                  <option value="">Select…</option>
                  <option value="Losses Occurring">Losses Occurring</option>
                  <option value="Risks Attaching">Risks Attaching</option>
                </select></FR>
                <FR label="Type of XL"><select className="fi" value={s.xlType || ''} onChange={e => update({ xlType: e.target.value })}>
                  <option value="">Select…</option>
                  <option value="Gross XL">Gross XL</option>
                  <option value="Net XL">Net XL</option>
                </select></FR>
                <FR label="Accounts"><select className="fi" value={s.accounts || ''} onChange={e => update({ accounts: e.target.value })}>
                  <option value="">Select…</option>
                  <option value="Half yearly">Half yearly</option>
                  <option value="Quarterly">Quarterly</option>
                  <option value="Annual">Annual</option>
                </select></FR>

                <div className="mini-title" style={{ marginTop: 12 }}>PREMIUM &amp; COMMISSIONS</div>
                <FR label="Est. GNPI"><CommaInput value={s.estGnpi} onChange={v => update({ estGnpi: v })} placeholder="e.g. 50,000,000" suffix={currencyCode} /></FR>
                <FR label="Brokerage %"><PctInput className="fi" placeholder="e.g. 10%" value={s.brokeragePct || ''} onChange={v => update({ brokeragePct: v })} /></FR>
                <FR label="Taxes %"><PctInput className="fi" placeholder="e.g. 2%" value={s.taxesPct || ''} onChange={v => update({ taxesPct: v })} /></FR>
                <FR label="No Claims Bonus %"><PctInput className="fi" placeholder="e.g. 5%" value={s.noClaimsBonusPct || ''} onChange={v => update({ noClaimsBonusPct: v })} /></FR>
                <FR label="Profit Commission %"><PctInput className="fi" placeholder="e.g. 10%" value={s.profitCommissionPct || ''} onChange={v => update({ profitCommissionPct: v })} /></FR>
              </div>
            </div>
          )}

        </div>

        {/* ── COB Modal ── */}
        {showCobModal && <CobSelectModal selected={s.classIds || []} classList={classes}
          onSave={ids => { update({ classIds: ids }); setShowCobModal(false); }}
          onClose={() => setShowCobModal(false)} />}
      </>)}
    </WizardLayout>
  );
}
