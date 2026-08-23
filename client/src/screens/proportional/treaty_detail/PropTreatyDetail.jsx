import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { useLocation } from 'react-router-dom';
import { api } from '../../../api';
import { useAppState } from '../../../context/AppContext';
import { useContractId, setActiveContractId } from '../../../hooks/useContractId';
import { useResource } from '../../../hooks/useResource';
import WizardLayout from '../../../components/WizardLayout';
import AsyncBoundary from '../../../components/AsyncBoundary';
import PctInput from '../../../components/PctInput';
import SlipIngestButton from '../../../components/SlipIngestButton';
import ImportedFromPackBanner from '../../../components/ImportedFromPackBanner';
import { logger } from '../../../utils/logger';
import { dateInputValue } from '../../../utils/format';
import { handleStaleWrite } from '../../../utils/handleStaleWrite';

const ROUTE_KEY = 'PROP_TREATY_DETAIL';

/* Intentional easter egg: entering this code in Alt. Contract ID stamps the
   company signature instead of the raw code. */
const DARCHVILLE_SIGNATURE_CODE = '+23051993';
const DARCHVILLE_SIGNATURE = 'Darchville Analytics';
import { ALLOWED_PROP_TYPES, NA_TYPE, PROP_SLIP_CURRENT_KEYS, pickKeys, numOrNull, clampPct, normalizeCommMode, cleanNum, extractLpSlides, getMissingRequiredFields, treatyModeFromType, addMonths, yearFromDateStr, canPersistTreatyHeader } from './propTreatyHelpers';
import { useEscapeKey, FR, TogglePill, CommaInput, CobSelectModal, SlidingScaleModal, EpiSplitModal } from './PropTreatyModals';

// Re-exported for the unit tests that import these helpers from this module.
export { yearFromDateStr, addMonths, extractLpSlides, getMissingRequiredFields, numOrNull } from './propTreatyHelpers';

export default function PropTreatyDetail() {
  const { state: appState, setSlice } = useAppState();
  const contractId = useContractId();

  const [cedants, setCedants] = useState([]);
  const [brokers, setBrokers] = useState([]);
  const [treatyTypes, setTreatyTypes] = useState([]);
  const [classes, setClasses] = useState([]);
  const [currencies, setCurrencies] = useState([]);
  const [countries, setCountries] = useState([]);
  const [pendingCedantName, setPendingCedantName] = useState(null);

  const [showSliding, setShowSliding] = useState(false);
  const [showEpiSplit, setShowEpiSplit] = useState(false);
  const [showCobModal, setShowCobModal] = useState(false);
  const [showLpSlides, setShowLpSlides] = useState(false);
  const [, setSaving] = useState(false);
  const [loaded, setLoaded] = useState(false);
  /* Labels of required fields the most recent save() blocked on.
     Renders red * + red border via FR's missing prop. Cleared on any
     edit through the wrapped update() below. */
  const [missingFields, setMissingFields] = useState(new Set());

  /* For a NEW treaty (no contractId), mark as loaded once lookups are ready
     so that auto-calc effects can fire. */
  const [lookupsReady, setLookupsReady] = useState(false);

  const s = appState.propTreatyDetail || {};
  const update = useCallback(patch => {
    setMissingFields(prev => prev.size ? new Set() : prev);
    setSlice('propTreatyDetail', patch);
  }, [setSlice]);

  /* ── Clean slate: when the route's contractId clears, reset the slice so
     old data doesn't bleed through. Reads s.contractId / s._loadedFromServer
     deliberately stale — re-running on those would re-clear the slice we
     just populated. */
  useEffect(() => {
    if (!contractId && !s.contractId && s._loadedFromServer) {
      setSlice('propTreatyDetail', {
        contractId: null, status: 'DRAFT',
        countryId: '', cedantId: '', brokerId: '', currencyId: '', currencyCode: '',
        treatyTypeId: '', classIds: [], startYear: '', experienceStartYear: '', renewalDate: '', inceptionDate: '', altContractId: '',
        qsLimit: '', retentionPct: '', retentionAmt: '', cessionPct: '', cessionAmt: '',
        surplusMaxRetention: '', numLines: '', totalCapacity: '', eventLimit: '', aal: '',
        commissionMode: 'fixed', fixedCommissionQSPct: '', fixedCommissionSurplusPct: '',
        slidingMinLossRatio: '', slidingMaxLossRatio: '', slidingMinCommission: '', slidingMaxCommission: '',
        slidingTable: [], provisionalCommissionPct: '', mgmtExpensesPct: '', profitCommissionPct: '', lcfYears: '', lcfExtinction: false,
        lossPartEnabled: true, minLossRatioPct: '', maxLossRatioPct: '', reinsurerSharePct: '', lpSlides: [{minLr:'',maxLr:'',share:''},{minLr:'',maxLr:'',share:''},{minLr:'',maxLr:'',share:''},{minLr:'',maxLr:'',share:''},{minLr:'',maxLr:'',share:''}],
        quotaShareEpi: '', surplusEpi: '', epiSplit: [],
        brokeragePct: '', taxesPct: '', lossCapPct: '',
        _loadedFromServer: false,
      });
    }
  }, [contractId, s.contractId, s._loadedFromServer, setSlice]);

  /* derived */
  const selectedTypeName = useMemo(() => treatyTypes.find(x => String(x.id) === String(s.treatyTypeId))?.name || '', [treatyTypes, s.treatyTypeId]);
  const tMode = useMemo(() => treatyModeFromType(selectedTypeName), [selectedTypeName]);
  const commMode = normalizeCommMode(s.commissionMode);
  const isFixed = commMode === 'fixed';
  const isSliding = commMode === 'sliding';
  const currencyCode = useMemo(() => currencies.find(x => String(x.id) === String(s.currencyId))?.code || currencies.find(x => String(x.id) === String(s.currencyId))?.name || '', [currencies, s.currencyId]);
  // Sync currencyCode into slice so PropPricing and other screens pick it up on currency change
  useEffect(() => {
    if (currencyCode && currencyCode !== s.currencyCode) {
      update({ currencyCode });
    }
  }, [currencyCode, s.currencyCode, update]);
  const isQS = tMode === 'quota' || tMode === 'both';
  const isSurplus = tMode === 'surplus' || tMode === 'both';
  const epiSplitCount = (s.epiSplit || []).filter(r => String(r.premium || '').trim()).length;

  const cobText = useMemo(() => {
    const ids = s.classIds || [];
    if (!ids.length) return 'Select classes…';
    const names = ids.map(id => classes.find(c => c.id === id)?.name).filter(Boolean);
    if (names.length <= 2) return names.join(', ');
    return `${names.slice(0, 2).join(', ')} +${names.length - 2} more`;
  }, [s.classIds, classes]);

  const countryCode = useMemo(() => countries.find(c => String(c.id) === String(s.countryId))?.code || '', [countries, s.countryId]);
  const countryName = useMemo(() => countries.find(c => String(c.id) === String(s.countryId))?.name || '', [countries, s.countryId]);
  const cedantName = useMemo(() => cedants.find(c => String(c.id) === String(s.cedantId))?.name || '', [cedants, s.cedantId]);
  const brokerName = useMemo(() => brokers.find(b => String(b.id) === String(s.brokerId))?.name || '', [brokers, s.brokerId]);
  const cobNames = useMemo(() => (s.classIds || []).map(id => classes.find(c => c.id === id)?.name).filter(Boolean), [s.classIds, classes]);
  // Sync display names into slice so PropPricing topbar reflects live changes without re-fetch
  useEffect(() => {
    const patch = {};
    if (cedantName && cedantName !== s.cedantName) patch.cedantName = cedantName;
    if (brokerName && brokerName !== s.brokerName) patch.brokerName = brokerName;
    if (countryName && countryName !== s.countryName) patch.countryName = countryName;
    if (Object.keys(patch).length) update(patch);
  }, [cedantName, brokerName, countryName, s.cedantName, s.brokerName, s.countryName, update]);

  /* contract description auto-gen */
  const contractDescription = useMemo(() => {
    const yr = yearFromDateStr(s.inceptionDate) || '';
    const parts = [yr, cedantName, selectedTypeName, cobNames.length ? `(${cobNames.join(', ')})` : '', countryCode].filter(Boolean);
    return parts.join(' ') || '';
  }, [s.inceptionDate, cedantName, selectedTypeName, cobNames, countryCode]);

  /* auto-calc: retention/cession amounts (skip during hydration to avoid overwrite) */
  useEffect(() => {
    if (!loaded || !isQS || !s.treatyTypeId || !treatyTypes.length) return;
    const qs = numOrNull(s.qsLimit) || 0;
    const rPct = clampPct(s.retentionPct);
    const cPct = clampPct(s.cessionPct);
    const retAmt = qs > 0 ? String(Math.round((qs * rPct) / 100)) : '';
    const cesAmt = qs > 0 ? String(Math.round((qs * cPct) / 100)) : '';
    if (retAmt !== String(s.retentionAmt || '') || cesAmt !== String(s.cessionAmt || ''))
      update({ retentionAmt: retAmt, cessionAmt: cesAmt });
  }, [s.qsLimit, s.retentionPct, s.cessionPct, isQS, loaded, s.treatyTypeId, treatyTypes, update, s.retentionAmt, s.cessionAmt]);

  /* auto-calc: total capacity (skip during hydration and until treaty type is resolved) */
  useEffect(() => {
    if (!loaded || !s.treatyTypeId || !treatyTypes.length) return;
    const QS = numOrNull(s.qsLimit) || 0, MR = numOrNull(s.surplusMaxRetention) || 0, N = numOrNull(s.numLines) || 0;
    const cap = tMode === 'quota' ? QS : tMode === 'both' ? QS + MR * N : MR + MR * N;
    const capStr = cap ? String(Math.round(cap)) : '';
    if (capStr !== String(s.totalCapacity || '')) update({ totalCapacity: capStr });
  }, [s.qsLimit, s.surplusMaxRetention, s.numLines, tMode, loaded, treatyTypes, s.treatyTypeId, update, s.totalCapacity]);

  /* auto-calc: renewal = inception + 12 months (skip during hydration) */
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

  const handleRetPctChange = v => update({ retentionPct: v, cessionPct: String(+(100 - clampPct(v)).toFixed(6)) });
  const handleCesPctChange = v => update({ cessionPct: v, retentionPct: String(+(100 - clampPct(v)).toFixed(6)) });

  /* load lookups (mount-only) */
  useEffect(() => {
    Promise.all([
      api.listBrokers().catch(() => []),
      api.listTreatyTypes().catch(() => []),
      api.listClassOfBusiness().catch(() => []),
      api.getRefListItems('currency').catch(() => []),
      api.getRefListItems('country').catch(() => []),
    ]).then(([b, t, cl, cur, cty]) => {
      setBrokers(Array.isArray(b) ? b : []);
      setTreatyTypes((Array.isArray(t) ? t : []).filter(x => ALLOWED_PROP_TYPES.has(x.name)));
      setClasses(Array.isArray(cl) ? cl : []);
      setCurrencies(Array.isArray(cur) ? cur : []);
      setCountries(Array.isArray(cty) ? cty : []);
      setLookupsReady(true);
    });
  }, []);

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

  /* For a NEW treaty (no contractId), set loaded=true once lookups are available
     so auto-calc effects will fire when the user enters values. */
  useEffect(() => {
    if (!loaded && !contractId && lookupsReady) {
      setLoaded(true);
    }
  }, [loaded, contractId, lookupsReady]);

  /* sync triangle meta from treaty dates */
  useEffect(() => {
    const uwYr     = Number(s.startYear) || null;
    const inceptionYr = yearFromDateStr(s.inceptionDate);
    const expStartYr  = Number(s.experienceStartYear) || null;
    const triStart = expStartYr || (inceptionYr ? inceptionYr - 10 : (uwYr ? uwYr - 10 : 2015));
    const triEnd   = inceptionYr || uwYr || new Date().getFullYear();
    if (triStart || inceptionYr) {
      setSlice('triangleMeta', {
        startYear:     triStart,
        renewalYear:   triEnd,
        inceptionYear: inceptionYr,
        version: Date.now(),
      });
    }
  }, [s.startYear, s.experienceStartYear, s.inceptionDate, setSlice]);

  /* ── Primary fetch: the contract bundle rides useResource (Phase 2.2).
     In-flight loads are aborted when contractId / quoteMode change or the
     screen unmounts, and failures surface through the AsyncBoundary around
     the form below (with Retry) instead of being swallowed. Hydration runs
     inside the fetcher — slice patch → renewal-override detection →
     active-id sync → loaded=true — so the ordering matches the old
     hand-rolled effect exactly and never runs for a superseded request.

     The fetch is skipped (`enabled` false) when the slice already holds
     this contract's data: hydrated from the server earlier (navigated back
     via a tab) or already loaded by this mount (`loaded` — e.g. the save
     path just created the contract). Mirrors the old effect's
     `if (loaded) return` + `_loadedFromServer` shortcuts; a contract switch
     from Home changes `contractId` away from `s.contractId`, re-arming the
     fetch exactly like the old "drop the loaded flag" reset did. */
  const bundleInSlice = String(s.contractId || '') === String(contractId) &&
    (loaded || !!s._loadedFromServer);
  const {
    loading: bundleLoading,
    error: bundleError,
    refetch: refetchBundle,
  } = useResource(
    async (signal) => {
      setLoaded(false);
      const data = await api.getContract(contractId, {
        ...(appState.quoteMode ? { quote: true } : {}),
        signal,
      });
      if (signal.aborted) return data; /* superseded/unmounted — don't hydrate */
      if (!data) { setLoaded(true); return data; }
      const h = data.header || {}, d = data.detail || {}, cm = data.commissions || {};
      const lp = data.lossParticipation || data.loss_participation || {};
      update({
        contractId: data.contract_id || contractId, status: h.status || h.uw_status || 'DRAFT',
        parentContractId: h.parent_contract_id || null,
        countryId: h.country_id || '', cedantId: h.cedant_id || '', brokerId: h.broker_id || '',
        currencyId: h.currency_id || '', treatyTypeId: h.treaty_type_id || '',
        currencyCode: h.currency_code || '',
        startYear: h.uw_year || h.start_year || '',
        experienceStartYear: d.experience_start_year || d.start_year || '',
        classIds: (data.class_ids && data.class_ids.length > 0)
          ? data.class_ids
          : (h.primary_class_of_business_id ? [h.primary_class_of_business_id] : []),
        primaryClassOfBusinessId: h.primary_class_of_business_id || null,
        altContractId: h.alt_contract_id || data.alt_contract_id || '',
        inceptionDate: dateInputValue(d.inception_date || ''),
        renewalDate: dateInputValue(d.renewal_date || ''),
        triangulationsAvailable: d.triangulations_available ?? true,
        qsLimit: cleanNum(d.qs_limit), retentionPct: cleanNum(d.retention_pct), retentionAmt: cleanNum(d.retention_amt),
        cessionPct: cleanNum(d.cession_pct), cessionAmt: cleanNum(d.cession_amt),
        surplusMaxRetention: cleanNum(d.surplus_max_retention), numLines: cleanNum(d.num_lines),
        totalCapacity: cleanNum(d.total_capacity), eventLimit: cleanNum(d.event_limit), aal: cleanNum(d.aal),
        commissionMode: cm.mode ? normalizeCommMode(cm.mode) : 'fixed',
        fixedCommissionQSPct: cleanNum(cm.fixed_commission_qs_pct), fixedCommissionSurplusPct: cleanNum(cm.fixed_commission_surplus_pct),
        slidingMinLossRatio: cleanNum(cm.sliding_min_loss_ratio), slidingMaxLossRatio: cleanNum(cm.sliding_max_loss_ratio),
        slidingMinCommission: cleanNum(cm.sliding_min_commission), slidingMaxCommission: cleanNum(cm.sliding_max_commission),
        slidingTable: Array.isArray(cm.sliding_table) ? cm.sliding_table.map(r => ({ lossRatioPct: cleanNum(r.loss_ratio_pct ?? r.lossRatioPct), commissionPct: cleanNum(r.commission_pct ?? r.commissionPct) })) : [],
        provisionalCommissionPct: cleanNum(cm.provisional_commission_pct),
        mgmtExpensesPct: cleanNum(cm.mgmt_expenses_pct), profitCommissionPct: cleanNum(cm.profit_commission_pct), lcfYears: cm.lcf_extinction && !cm.lcf_years ? 'extinction' : (cm.lcf_years ? String(cm.lcf_years) : ''), lcfExtinction: !!cm.lcf_extinction,
        lossPartEnabled: lp.enabled !== false, minLossRatioPct: cleanNum(lp.min_loss_ratio_pct),
        maxLossRatioPct: cleanNum(lp.max_loss_ratio_pct), reinsurerSharePct: cleanNum(lp.reinsurer_share_pct),
        lpSlides: lp.slides?.length ? lp.slides.map(r=>({minLr:cleanNum(r.min_lr),maxLr:cleanNum(r.max_lr),share:cleanNum(r.share)})).concat(Array(Math.max(0,5-lp.slides.length)).fill({minLr:'',maxLr:'',share:''})) : [{minLr:'',maxLr:'',share:''},{minLr:'',maxLr:'',share:''},{minLr:'',maxLr:'',share:''},{minLr:'',maxLr:'',share:''},{minLr:'',maxLr:'',share:''}],
        quotaShareEpi: cleanNum(d.quota_share_epi), surplusEpi: cleanNum(d.surplus_epi),
        epiSplit: Array.isArray(data.epi_split) ? data.epi_split.map(r => ({ classId: r.class_id, premium: cleanNum(r.premium) })) : [],
        brokeragePct: cleanNum(d.brokerage_pct), taxesPct: cleanNum(d.taxes_pct), lossCapPct: cleanNum(d.loss_cap_pct),
        stripLargeCat: d.strip_large_cat_losses === true,
        _updatedAt: data.updated_at || data.updatedAt || null,
        _loadedFromServer: true,
      });
      // Detect manual renewal override: if the saved renewal date is not
      // exactly inception + 12 months, the user must have overridden it.
      // Set _renewalManual so the auto-recalc effect doesn't clobber the
      // saved value the next time the user edits inception.
      const inceptionISO = dateInputValue(d.inception_date || '');
      const renewalISO   = dateInputValue(d.renewal_date || '');
      if (inceptionISO && renewalISO && addMonths(inceptionISO, 12) !== renewalISO) {
        update({ _renewalManual: true });
      }
      setActiveContractId(data.contract_id || contractId);
      setLoaded(true);
      return data;
    },
    [contractId, appState.quoteMode],
    { enabled: !!contractId && !bundleInSlice, reportLabel: 'treaty detail' },
  );

  /* If propTreatyDetail already has data for this contract (e.g. navigated
     back via tab), the resource above stays disabled — just flip the
     hydration flag so the auto-calc effects arm, exactly like the old
     `_loadedFromServer` shortcut did. */
  useEffect(() => {
    if (!loaded && contractId && s._loadedFromServer && String(s.contractId) === String(contractId)) {
      setLoaded(true);
    }
  }, [loaded, contractId, s._loadedFromServer, s.contractId]);

  /* save */
  const saveRef = React.useRef(null);
  const stateRef = React.useRef(appState);
  const lastExplicitSaveAtRef = React.useRef(0);
  useEffect(() => { stateRef.current = appState; }, [appState]);
  const save = useCallback(async () => {
    // Read the slice from the ref so save() stays referentially stable across
    // keystrokes — saveRef.current and the unmount effect both depend on this.
    const cur = stateRef.current?.propTreatyDetail || {};
    const isSlidingNow = normalizeCommMode(cur.commissionMode) === 'sliding';
    // Allow save to proceed for new contracts (no contractId yet) if user has entered data
    const hasContent = !!(cur.cedantId || cur.treatyTypeId || cur.countryId);
    if (!contractId && !cur.contractId && !hasContent) { setSaving(false); return true; }
    // Surface required-field gaps via the SaveStateIndicator banner before the
    // backend rejects with a generic 400. Only enforce when the user has
    // actually started the form — typed-Error message is rendered by
    // WizardLayout's runTrackedSave catch block.
    if (hasContent) {
      const selectedTypeName = treatyTypes.find(x => String(x.id) === String(cur.treatyTypeId))?.name || '';
      const missing = getMissingRequiredFields(cur, {
        tMode:    treatyModeFromType(selectedTypeName),
        commMode: normalizeCommMode(cur.commissionMode),
      });
      if (missing.length) {
        setMissingFields(new Set(missing));
        throw new Error(`Required fields missing: ${missing.join(', ')}`);
      }
    }
    setSaving(true);
    let attemptedPayload = null;
    let attemptedQm = null;
    let attemptedId = null;
    try {
      // Auto-include primary COB in classIds if classIds is empty
      const effectiveClassIds = (cur.classIds || []).length > 0
        ? (cur.classIds || [])
        : (cur.primaryClassOfBusinessId ? [cur.primaryClassOfBusinessId] : []);
      const primaryCobId = effectiveClassIds[0] || cur.primaryClassOfBusinessId || null;

      const payload = {
        classIds: effectiveClassIds,
        header: { cedant_id: cur.cedantId, broker_id: cur.brokerId, currency_id: cur.currencyId, country_id: cur.countryId, treaty_type_id: cur.treatyTypeId, start_year: cur.startYear, uw_year: cur.startYear, status: cur.status || 'DRAFT', contract_description: contractDescription, primary_class_of_business_id: primaryCobId, alt_contract_id: cur.altContractId || null },
        detail: {
          triangulations_available: cur.triangulationsAvailable !== false,
          inception_date: cur.inceptionDate, renewal_date: cur.renewalDate, start_year: cur.startYear,
          experience_start_year: numOrNull(cur.experienceStartYear),
          qs_limit: numOrNull(cur.qsLimit), retention_pct: numOrNull(cur.retentionPct), retention_amt: numOrNull(cur.retentionAmt),
          cession_pct: numOrNull(cur.cessionPct), cession_amt: numOrNull(cur.cessionAmt),
          surplus_max_retention: numOrNull(cur.surplusMaxRetention), num_lines: numOrNull(cur.numLines),
          total_capacity: numOrNull(cur.totalCapacity), event_limit: numOrNull(cur.eventLimit), aal: numOrNull(cur.aal),
          quota_share_epi: numOrNull(cur.quotaShareEpi), surplus_epi: numOrNull(cur.surplusEpi),
          brokerage_pct: numOrNull(cur.brokeragePct), taxes_pct: numOrNull(cur.taxesPct), loss_cap_pct: numOrNull(cur.lossCapPct),
          strip_large_cat_losses: cur.stripLargeCat === true,
        },
        commissions: { mode: isSlidingNow ? 'SLIDING' : 'FIXED', fixed_commission_qs_pct: numOrNull(cur.fixedCommissionQSPct), fixed_commission_surplus_pct: numOrNull(cur.fixedCommissionSurplusPct), sliding_min_loss_ratio: numOrNull(cur.slidingMinLossRatio), sliding_max_loss_ratio: numOrNull(cur.slidingMaxLossRatio), sliding_min_commission: numOrNull(cur.slidingMinCommission), sliding_max_commission: numOrNull(cur.slidingMaxCommission), sliding_table: cur.slidingTable || [], provisional_commission_pct: numOrNull(cur.provisionalCommissionPct), mgmt_expenses_pct: numOrNull(cur.mgmtExpensesPct), profit_commission_pct: numOrNull(cur.profitCommissionPct), lcf_years: cur.lcfYears === 'extinction' ? null : numOrNull(cur.lcfYears), lcf_extinction: cur.lcfYears === 'extinction' || cur.lcfExtinction || false },
        lossParticipation: {
          enabled: cur.lossPartEnabled !== false,
          min_loss_ratio_pct: numOrNull(cur.minLossRatioPct),
          max_loss_ratio_pct: numOrNull(cur.maxLossRatioPct),
          reinsurer_share_pct: numOrNull(cur.reinsurerSharePct),
          slides: extractLpSlides(cur.lpSlides),
        },
        epi_split: (cur.epiSplit || []).map(r => ({ class_id: r.classId, premium: numOrNull(r.premium) })),
      };
      // EPI Split defaults to equal split across COBs when the user
      // never opened the modal. Saves a round-trip and matches what the
      // pre-fill in EpiSplitModal would have produced.
      const totalEpi = (numOrNull(cur.quotaShareEpi) || 0) + (numOrNull(cur.surplusEpi) || 0);
      if ((!payload.epi_split || !payload.epi_split.length) && effectiveClassIds.length && totalEpi > 0) {
        const share = totalEpi / effectiveClassIds.length;
        payload.epi_split = effectiveClassIds.map(cid => ({ class_id: cid, premium: share }));
      }
      const qm = stateRef.current?.quoteMode ? { quote: true } : undefined;
      attemptedPayload = payload;
      attemptedQm = qm;
      attemptedId = cur.contractId || contractId;
      if (cur.contractId) {
        const res = await api.saveContract(cur.contractId, { terms: payload }, { ...(qm || {}), ...(cur._updatedAt ? { ifUnmodifiedSince: cur._updatedAt } : {}) });
        if (res?.updated_at) update({ _updatedAt: res.updated_at });
      }
      else {
        const res = await api.createContract({
          cedant_id:        cur.cedantId,
          broker_id:        cur.brokerId,
          currency_id:      cur.currencyId,
          treaty_type_id:   cur.treatyTypeId,
          country_id:       cur.countryId,
          underwriting_year: Number(cur.startYear) || new Date().getFullYear(),
          inception_date:   cur.inceptionDate,
        }, qm);
        const newId = res?.contract_id || res?.id;
        if (newId) {
          attemptedId = newId;
          update({ contractId: newId });
          setActiveContractId(newId);
          const saved = await api.saveContract(newId, { terms: payload }, qm);
          if (saved?.updated_at) update({ _updatedAt: saved.updated_at });
        }
      }
      lastExplicitSaveAtRef.current = Date.now();
      return true;
    } catch (e) {
      const stale = await handleStaleWrite(e, {
        entityType: attemptedQm ? 'quote' : 'treaty',
        onRefresh: () => window.location.reload(),
        onOverwrite: async () => {
          if (!attemptedId || !attemptedPayload) return null;
          const res = await api.saveContract(attemptedId, { terms: attemptedPayload }, { ...(attemptedQm || {}), ifUnmodifiedSince: '*' });
          if (res?.updated_at) update({ _updatedAt: res.updated_at });
          lastExplicitSaveAtRef.current = Date.now();
          return res;
        },
      });
      if (stale.handled) return stale.action === 'overwrite';
      logger.error('Save failed:', e); return false;
    }
    finally { setSaving(false); }
  }, [contractId, update, contractDescription, treatyTypes]);

  /* Keep saveRef current so the unmount effect can call the latest save */
  useEffect(() => { saveRef.current = save; }, [save]);

  /* Close the inline LP Slides modal on Escape (other modals handle their
     own listener via useEscapeKey at component level). */
  const closeLpSlides = useCallback(() => setShowLpSlides(false), []);
  useEscapeKey(showLpSlides, closeLpSlides);

  /* Auto-save on unmount (e.g. when navigating via sidebar tabs).
     Fires for existing treaties (contractId set) AND for new treaties where
     the user has filled at least one identifying field — otherwise sidebar
     navigation silently discards their work. Respects the AppContext-level
     autosave flag so a user who explicitly turned autosave off in
     WizardLayout doesn't get a surprise save when they navigate away. */
  useEffect(() => {
    return () => {
      const snap = stateRef.current || {};
      const autosaveOn = snap.settings?.autosave !== false;
      if (!autosaveOn) return;
      const cur = snap.propTreatyDetail;
      if (Date.now() - lastExplicitSaveAtRef.current < 2000) return;
      // Only autosave a brand-new treaty when every NOT NULL header column is
      // present (migration 104) — otherwise the create POST is rejected by the
      // DB. An existing row (contractId set) can always be re-saved.
      const persistable = cur?.contractId || canPersistTreatyHeader(cur);
      if (persistable && saveRef.current) {
        saveRef.current().catch(e => logger.error('[PropTreatyDetail] unmount save failed:', e));
      }
    };
  }, []);

  /* ─── input style ─── */
  const fi = "fi"; // className alias

  // Import-flow nav state: when the wizard was reached via the renewal-
  // pack import modal we land here with location.state.importedFromPack.
  const location = useLocation();
  const importedFromState = location?.state?.importedFromPack ? {
    sourceFilename: location.state.sourceFilename,
    priorTreatyId: location.state.priorTreatyId,
  } : null;

  /* ═══ RENDER ═══ */
  return (
    <WizardLayout routeKey={ROUTE_KEY} title="Treaty Detail" headerPill="PROPORTIONAL TREATY: TREATY DETAIL" onBeforeNext={save} onBeforeBack={save}>
      {({ showToast }) => (<>

        <ImportedFromPackBanner quoteId={contractId} importedFromState={importedFromState} />

        {/* ── Summary bar ── */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12, flexWrap: 'wrap', gap: 8 }}>
          <div style={{ fontSize: 12, color: 'rgba(var(--text-rgb),.7)' }}>
            Cedant: <b>{cedantName || '—'}</b>{' · '}Country: <b>{countries.find(c => String(c.id) === String(s.countryId))?.name || '—'}</b>
            {' · '}Broker: <b>{brokerName || '—'}</b>{' · '}Currency: <b>{currencyCode || '—'}</b>{' · '}Treaty Type: <b>{selectedTypeName || '—'}</b>
            {cobNames.length > 0 && <>{' · '}COB: <b>{cobNames.join(', ')}</b></>}
          </div>
          {s.parentContractId && (
            <div style={{ display:'inline-flex', alignItems:'center', gap:6, padding:'4px 10px', borderRadius:8,
              background:'rgba(96,165,250,0.10)', border:'1px solid rgba(96,165,250,0.30)', fontSize:11, color:'var(--accent-blue)', fontWeight:700 }}>
              🔄 Renewal — linked to prior year contract
            </div>
          )}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 12, color: 'rgba(var(--text-rgb),.7)' }}>Triangulations available</span>
            <TogglePill options={[{ value: true, label: 'YES' }, { value: false, label: 'NO' }]}
              value={s.triangulationsAvailable !== false} onChange={v => update({ triangulationsAvailable: v })}
              ariaLabel="Triangulations available" />
          </div>
        </div>

        {/* ── Contract description ── */}
        {contractDescription && (
          <div style={{ padding: '8px 14px', marginBottom: 14, borderRadius: 10, background: 'var(--surface-hover)', border: '1px solid var(--hairline)', fontSize: 12, color: 'rgba(var(--text-rgb),.7)' }}>
            <span style={{ color: 'rgba(var(--text-rgb),.58)', marginRight: 8 }}>Contract:</span>{contractDescription}
          </div>
        )}

        {/* ── 2×2 Grid — equal-sized cards. The grid + its modals are the
            primary async region: hidden behind the boundary until the
            contract bundle hydrates, replaced by an error + Retry panel
            when the load fails. Chrome above stays mounted throughout. ── */}
        <AsyncBoundary loading={bundleLoading} error={bundleError} onRetry={refetchBundle} label="treaty detail">
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 18 }}>

          {/* ═══ CONTRACT DETAILS ═══ */}
          <div className="card glass" style={{ display: 'flex', flexDirection: 'column' }}>
            <div className="card-head">
              <span className="card-header-label">CONTRACT DETAILS</span>
              <span className="card-header-tag">INPUT</span>
              <SlipIngestButton
                mode="PROP"
                currentValues={pickKeys(s, PROP_SLIP_CURRENT_KEYS)}
                countries={countries}
                treatyTypes={treatyTypes}
                brokers={brokers}
                cedants={cedants}
                currencies={currencies}
                classes={classes}
                onFill={fields => {
                  const direct = {};
                  const scalars = ['inceptionDate','renewalDate','experienceStartYear',
                    'currencyId','treatyTypeId','brokerId','classIds',
                    'qsLimit','retentionPct','cessionPct','surplusMaxRetention','numLines',
                    'eventLimit','aal','quotaShareEpi','surplusEpi','brokeragePct','taxesPct','lossCapPct',
                    'fixedCommissionQSPct'];
                  scalars.forEach(k => { if (fields[k] != null) direct[k] = fields[k]; });
                  if (fields.countryId) { direct.countryId = fields.countryId; direct.cedantId = ''; }
                  if (fields.cedantId) {
                    direct.cedantId = fields.cedantId;
                  } else if (fields._cedantNameRaw) {
                    setPendingCedantName(fields._cedantNameRaw);
                  }
                  ['brokeragePct','taxesPct','lossCapPct','retentionPct','cessionPct',
                   'fixedCommissionQSPct'].forEach(k => {
                    if (direct[k] != null) direct[k] = String(direct[k]);
                  });
                  ['qsLimit','surplusMaxRetention','eventLimit','aal','quotaShareEpi','surplusEpi'].forEach(k => {
                    if (direct[k] != null) direct[k] = String(direct[k]).replace(/,/g,'');
                  });
                  if (direct.experienceStartYear != null) direct.experienceStartYear = String(direct.experienceStartYear);
                  // Slip often quotes only one side of retention/cession; derive the
                  // missing half so downstream calcs (retentionAmt, cessionAmt) work.
                  if (direct.retentionPct != null && direct.cessionPct == null && !s.cessionPct) {
                    direct.cessionPct = String(+(100 - clampPct(direct.retentionPct)).toFixed(6));
                  } else if (direct.cessionPct != null && direct.retentionPct == null && !s.retentionPct) {
                    direct.retentionPct = String(+(100 - clampPct(direct.cessionPct)).toFixed(6));
                  }
                  update(direct);
                }}
              />
            </div>
            <div style={{ padding: '14px 18px', display: 'flex', flexDirection: 'column', gap: 8, flex: 1 }}>
              <FR label="Country" missing={missingFields.has('Country')}><select className={fi} value={s.countryId || ''} onChange={e => update({ countryId: e.target.value, cedantId: '' })}>
                <option value="">Select country…</option>{countries.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select></FR>
              <FR label="Cedant Name" missing={missingFields.has('Cedant Name')}><select className={fi} value={s.cedantId || ''} onChange={e => update({ cedantId: e.target.value })} disabled={!s.countryId}>
                <option value="">{s.countryId ? 'Select cedant…' : 'Select country first…'}</option>{cedants.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select></FR>
              <FR label="Treaty Type" missing={missingFields.has('Treaty Type')}><select className={fi} value={s.treatyTypeId || ''} onChange={e => update({ treatyTypeId: e.target.value })}>
                <option value="">Select treaty type…</option>{treatyTypes.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}</select></FR>
              <FR label="Line of Business" missing={missingFields.has('Line of Business')}>
                <button className={fi} type="button" onClick={() => setShowCobModal(true)}
                  style={{ textAlign: 'left', cursor: 'pointer', color: (s.classIds || []).length ? 'rgba(var(--text-rgb),.9)' : 'rgba(var(--text-rgb),.4)' }}>
                  {cobText} <span style={{ float: 'right', opacity: 0.3 }}>▾</span>
                </button>
              </FR>
              <FR label="Broker" missing={missingFields.has('Broker')}><select className={fi} value={s.brokerId || ''} onChange={e => update({ brokerId: e.target.value })}>
                <option value="">Select broker…</option>{brokers.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}</select></FR>
              <FR label="Contract ID"><input className={fi} value={s.contractId || ''} readOnly style={{ opacity: 0.5 }} /></FR>
              <FR label="Alt. Contract ID"><input className={fi} value={s.altContractId || ''} onChange={e => update({ altContractId: e.target.value.trim() === DARCHVILLE_SIGNATURE_CODE ? DARCHVILLE_SIGNATURE : e.target.value })} placeholder="External system reference…" /></FR>
              <FR label="Currency" missing={missingFields.has('Currency')}><select className={fi} value={s.currencyId || ''} onChange={e => update({ currencyId: e.target.value })}>
                <option value="">Select currency…</option>{currencies.map(c => <option key={c.id} value={c.id}>{c.code || c.name}</option>)}</select></FR>
              {/* Don't clear _renewalManual on inception edit: a user who
                 saved a manual renewal then comes back and tweaks
                 inception expects the renewal they explicitly set to
                 stay put (the load-time detection in the hydration
                 effect restores _renewalManual from the saved data). */}
              <FR label="Treaty Inception Date" missing={missingFields.has('Treaty Inception Date')}><input className={fi} type="date" value={s.inceptionDate || ''} onChange={e => update({ inceptionDate: e.target.value })} /></FR>
              <FR label="Treaty Renewal Date"><input className={fi} type="date" value={s.renewalDate || ''} onChange={e => update({ renewalDate: e.target.value, _renewalManual: true })} /></FR>
              <FR label="UW Year"><input className={fi} value={s.startYear || (yearFromDateStr(s.inceptionDate) ? String(yearFromDateStr(s.inceptionDate)) : '')} readOnly title="Auto-derived from Treaty Inception Date" style={{ opacity: 0.7 }} /></FR>
              <FR label="Experience Start Year" missing={missingFields.has('Experience Start Year')}>
                <select className={fi} value={s.experienceStartYear || ''} onChange={e => update({ experienceStartYear: e.target.value })}>
                  <option value="">Select start year…</option>
                  {Array.from({ length: 41 }, (_, i) => new Date().getFullYear() - 40 + i).map(y => <option key={y} value={y}>{y}</option>)}
                </select>
              </FR>
              <FR label="Contract Description"><input className={fi} value={contractDescription} readOnly style={{ opacity: 0.6, fontSize: 11 }} /></FR>
            </div>
          </div>

          {/* ═══ LIMIT DETAILS ═══ */}
          <div className="card glass" style={{ display: 'flex', flexDirection: 'column' }}>
            <div className="card-head"><span className="card-header-label">LIMIT DETAILS</span><span className="card-header-tag">CAPACITY</span></div>
            <div style={{ padding: '14px 18px', display: 'flex', flexDirection: 'column', gap: 8, flex: 1 }}>
              <FR label="QS 100% Limit" missing={missingFields.has('QS 100% Limit')}><CommaInput value={s.qsLimit} onChange={v => update({ qsLimit: v })} placeholder="e.g. 1,000,000" disabled={!isQS} title={!isQS ? NA_TYPE : undefined} /></FR>
              <FR label="Retention %" missing={missingFields.has('Retention %')}><PctInput className={fi} placeholder="e.g. 50%" value={s.retentionPct || ''} onChange={v => handleRetPctChange(v)} disabled={!isQS} title={!isQS ? NA_TYPE : undefined} /></FR>
              <FR label="Retention Amount"><CommaInput value={s.retentionAmt} placeholder="auto" readOnly /></FR>
              <FR label="Cession %"><PctInput className={fi} placeholder="e.g. 50%" value={s.cessionPct || ''} onChange={v => handleCesPctChange(v)} disabled={!isQS} title={!isQS ? NA_TYPE : undefined} /></FR>
              <FR label="Cession Amount"><CommaInput value={s.cessionAmt} placeholder="auto" readOnly /></FR>
              <FR label="Surplus Max Retention" missing={missingFields.has('Surplus Max Retention')}><CommaInput value={s.surplusMaxRetention} onChange={v => update({ surplusMaxRetention: v })} placeholder="e.g. 1,000,000" disabled={!isSurplus} title={!isSurplus ? NA_TYPE : undefined} /></FR>
              <FR label="Number of Lines" missing={missingFields.has('Number of Lines')}><input className={fi} type="number" min="0" placeholder="e.g. 5" value={s.numLines || ''} onChange={e => update({ numLines: e.target.value })} disabled={!isSurplus} title={!isSurplus ? NA_TYPE : undefined} /></FR>
              <FR label="Total Treaty Capacity"><CommaInput value={s.totalCapacity} placeholder="" readOnly /></FR>
              <FR label="Event Limit"><CommaInput value={s.eventLimit} onChange={v => update({ eventLimit: v })} placeholder="e.g. 3,000,000" /></FR>
              <FR label="AAL"><CommaInput value={s.aal} onChange={v => update({ aal: v })} placeholder="e.g. 10,000,000" /></FR>
            </div>
          </div>

          {/* ═══ COMMISSIONS ═══ */}
          <div className="card glass" style={{ display: 'flex', flexDirection: 'column' }}>
            <div className="card-head"><span className="card-header-label">COMMISSIONS</span>
              <TogglePill options={[{ value: 'fixed', label: 'FIXED COMMISSION' }, { value: 'sliding', label: 'SLIDING SCALE' }]}
                value={commMode} onChange={v => update({ commissionMode: v })}
                ariaLabel="Commission mode" />
            </div>
            <div style={{ padding: '10px 18px 18px', flex: 1 }}>
              <div style={{ fontSize: 12, color: 'rgba(var(--text-rgb),.7)', marginBottom: 12 }}>Choose between a single fixed commission or a sliding scale commission structure.</div>
              <div style={{ opacity: isFixed ? 1 : 0.35, pointerEvents: isFixed ? 'auto' : 'none' }}>
                <div className="mini-title">FIXED COMMISSION</div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <FR label="QS Commission %" missing={missingFields.has('Fixed QS Commission %')}><PctInput className={fi} placeholder="e.g. 30%" value={s.fixedCommissionQSPct || ''} onChange={v => update({ fixedCommissionQSPct: v })} disabled={!isQS} title={!isQS ? NA_TYPE : undefined} /></FR>
                  <FR label="Surplus Commission %" missing={missingFields.has('Fixed Surplus Commission %')}><PctInput className={fi} placeholder="e.g. 30%" value={s.fixedCommissionSurplusPct || ''} onChange={v => update({ fixedCommissionSurplusPct: v })} disabled={!isSurplus} title={!isSurplus ? NA_TYPE : undefined} /></FR>
                </div>
              </div>
              <div style={{ opacity: isSliding ? 1 : 0.35, pointerEvents: isSliding ? 'auto' : 'none', marginTop: 14 }}>
                <div className="mini-title">SLIDING SCALE</div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <FR label="Min Loss Ratio %" missing={missingFields.has('Sliding Min Loss Ratio %')}><PctInput className={fi} placeholder="e.g. 40%" value={s.slidingMinLossRatio || ''} onChange={v => update({ slidingMinLossRatio: v })} /></FR>
                  <FR label="Max Loss Ratio %" missing={missingFields.has('Sliding Max Loss Ratio %')}><PctInput className={fi} placeholder="e.g. 80%" value={s.slidingMaxLossRatio || ''} onChange={v => update({ slidingMaxLossRatio: v })} /></FR>
                  <FR label="Min Commission %" missing={missingFields.has('Sliding Min Commission %')}><PctInput className={fi} placeholder="e.g. 20%" value={s.slidingMinCommission || ''} onChange={v => update({ slidingMinCommission: v })} /></FR>
                  <FR label="Max Commission %" missing={missingFields.has('Sliding Max Commission %')}><PctInput className={fi} placeholder="e.g. 35%" value={s.slidingMaxCommission || ''} onChange={v => update({ slidingMaxCommission: v })} /></FR>
                </div>
                <div style={{ marginTop: 10, display: 'flex', alignItems: 'center', gap: 10 }}>
                  <button className="orange-gloss-btn" onClick={() => setShowSliding(true)}>Enter slide manually</button>
                  <span style={{ fontSize: 11, color: 'rgba(var(--text-rgb),.7)' }}>{(s.slidingTable || []).filter(r => r.lossRatioPct || r.commissionPct).length} row(s)</span>
                </div>
              </div>
              <div style={{ marginTop: 14 }}>
                <div className="mini-title">ADDITIONAL</div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <FR label="Management Expenses %"><PctInput className={fi} placeholder="e.g. 5%" value={s.mgmtExpensesPct || ''} onChange={v => update({ mgmtExpensesPct: v })} /></FR>
                  <FR label="Profit Commission %"><PctInput className={fi} placeholder="e.g. 10%" value={s.profitCommissionPct || ''} onChange={v => update({ profitCommissionPct: v })} /></FR>
                  <FR label="Loss Carry Forward (LCF)">
                    <select className={fi} value={s.lcfYears || ''} onChange={e => update({ lcfYears: e.target.value })}>
                      <option value="">None</option>
                      {[1,2,3,4,5,6,7,8,9].map(n => <option key={n} value={n}>{n} year{n > 1 ? 's' : ''}</option>)}
                      <option value="extinction">Extinction</option>
                    </select>
                  </FR>
                </div>
              </div>
            </div>
          </div>

          {/* ═══ LOSS PARTICIPATION + EPI + BROKERAGE ═══ */}
          <div className="card glass" style={{ display: 'flex', flexDirection: 'column' }}>
            <div className="card-head"><span className="card-header-label">LOSS PARTICIPATION</span>
              <TogglePill options={[{ value: true, label: 'YES' }, { value: false, label: 'NO' }]}
                value={s.lossPartEnabled !== false} onChange={v => update({ lossPartEnabled: v })}
                ariaLabel="Loss participation enabled" />
            </div>
            <div style={{ padding: '10px 18px 18px', flex: 1 }}>
              <div style={{ fontSize: 12, color: 'rgba(var(--text-rgb),.7)', marginBottom: 12 }}>Capture loss participation corridors where the reinsurer share changes above a given loss ratio.</div>
              <div style={{ opacity: s.lossPartEnabled !== false ? 1 : 0.35, pointerEvents: s.lossPartEnabled !== false ? 'auto' : 'none' }}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <FR label="Min Loss Ratio %" missing={missingFields.has('LP Min Loss Ratio %')}><PctInput className={fi} placeholder="e.g. 70%" value={s.minLossRatioPct || ''} onChange={v => update({ minLossRatioPct: v })} /></FR>
                  <FR label="Max Loss Ratio %" missing={missingFields.has('LP Max Loss Ratio %')}><PctInput className={fi} placeholder="e.g. 100%" value={s.maxLossRatioPct || ''} onChange={v => update({ maxLossRatioPct: v })} /></FR>
                  <FR label="Reinsurer Share %" missing={missingFields.has('LP Reinsurer Share %')}><PctInput className={fi} placeholder="e.g. 50%" value={s.reinsurerSharePct || ''} onChange={v => update({ reinsurerSharePct: v })} /></FR>
                </div>
                <div style={{ marginTop: 10, display: 'flex', alignItems: 'center', gap: 8 }}>
                  <button className="orange-gloss-btn" type="button" onClick={() => setShowLpSlides(true)}>Enter Slides Manually</button>
                  {(s.lpSlides || []).some(r => r.minLr || r.maxLr || r.share) && (
                    <span style={{ fontSize: 10, color: 'var(--accent)', fontWeight: 700 }}>
                      ✓ {(s.lpSlides||[]).filter(r => r.minLr||r.maxLr||r.share).length} corridor(s)
                    </span>
                  )}
                </div>
              </div>
              <div className="mini-title" style={{ marginTop: 16 }}>EPI</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <FR label="Quota Share EPI" missing={missingFields.has('Quota Share EPI')}><CommaInput value={s.quotaShareEpi} onChange={v => update({ quotaShareEpi: v })} placeholder="e.g. 10,000,000" disabled={!isQS} title={!isQS ? NA_TYPE : undefined} /></FR>
                <FR label="Surplus EPI" missing={missingFields.has('Surplus EPI')}><CommaInput value={s.surplusEpi} onChange={v => update({ surplusEpi: v })} placeholder="e.g. 5,000,000" disabled={!isSurplus} title={!isSurplus ? NA_TYPE : undefined} /></FR>
              </div>
              <div style={{ marginTop: 10, display: 'flex', alignItems: 'center', gap: 10 }}>
                <button className="orange-gloss-btn" onClick={() => { if (!(s.classIds || []).length) { showToast?.('Select Lines of Business first'); return; } setShowEpiSplit(true); }}>EPI Split</button>
                <span style={{ fontSize: 11, color: 'rgba(var(--text-rgb),.7)' }}>{epiSplitCount > 0 ? `${epiSplitCount} class(es)` : ''}</span>
              </div>
              <div className="mini-title" style={{ marginTop: 16 }}>BROKERAGE &amp; TAXES</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <FR label="Brokerage %"><PctInput className={fi} placeholder="e.g. 5%" value={s.brokeragePct || ''} onChange={v => update({ brokeragePct: v })} /></FR>
                <FR label="Taxes %"><PctInput className={fi} placeholder="e.g. 2%" value={s.taxesPct || ''} onChange={v => update({ taxesPct: v })} /></FR>
                <FR label="Loss Cap %"><PctInput className={fi} placeholder="e.g. 5%" value={s.lossCapPct || ''} onChange={v => update({ lossCapPct: v })} /></FR>
              </div>
            </div>
          </div>
        </div>

        {/* ── Modals ── */}
        {showSliding && <SlidingScaleModal table={s.slidingTable} provisional={s.provisionalCommissionPct}
          onSave={(rows, prov) => { update({ slidingTable: rows, provisionalCommissionPct: prov }); setShowSliding(false); showToast?.('Sliding scale saved.'); }}
          onClose={() => setShowSliding(false)} />}
        {showEpiSplit && <EpiSplitModal split={s.epiSplit} classIds={s.classIds || []} classList={classes}
          qsEpi={s.quotaShareEpi} surplusEpi={s.surplusEpi}
          onSave={rows => { update({ epiSplit: rows }); setShowEpiSplit(false); showToast?.('EPI split saved.'); }}
          onClose={() => setShowEpiSplit(false)} />}
        {/* ── LP Slides Modal ── */}
        {showLpSlides && (
          <div className="modal-backdrop" role="presentation" style={{ position: 'fixed', inset: 0, zIndex: 9000, background: 'rgba(0,0,0,0.75)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
            onClick={e => { if (e.target === e.currentTarget) setShowLpSlides(false); }}>
            <div className="glass" role="dialog" aria-modal="true" aria-labelledby="lp-slides-title"
              style={{ width: 460, borderRadius: 16, border: '1px solid var(--hairline-strong)', padding: 24 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 20 }}>
                <div>
                  <div id="lp-slides-title" style={{ fontSize: 13, fontWeight: 800, color: 'var(--text)' }}>Stepped Loss Participation</div>
                  <div style={{ fontSize: 11, color: 'rgba(var(--text-rgb),.7)', marginTop: 2 }}>Define up to 5 corridors with different reinsurer shares</div>
                </div>
                <button type="button" aria-label="Close" onClick={() => setShowLpSlides(false)} style={{ background: 'none', border: 'none', color: 'rgba(var(--text-rgb),.7)', fontSize: 18, cursor: 'pointer' }}>✕</button>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '28px 1fr 1fr 1fr', gap: 8, marginBottom: 8 }}>
                <div />
                {['Min LR %', 'Max LR %', 'Re Share %'].map(h => (
                  <div key={h} style={{ fontSize: 9, fontWeight: 700, color: 'rgba(var(--text-rgb),.7)', textTransform: 'uppercase', letterSpacing: '0.05em', textAlign: 'center' }}>{h}</div>
                ))}
              </div>
              {(s.lpSlides || []).slice(0, 5).map((row, i) => (
                <div key={i} style={{ display: 'grid', gridTemplateColumns: '28px 1fr 1fr 1fr', gap: 8, marginBottom: 8, alignItems: 'center' }}>
                  <div style={{ fontSize: 11, fontWeight: 700, color: 'rgba(var(--text-rgb),.5)', textAlign: 'center' }}>{i + 1}</div>
                  <PctInput className={fi} placeholder="e.g. 70%" value={row.minLr || ''}
                    aria-label={`Corridor ${i + 1} minimum loss ratio`}
                    onChange={v => { const sl = [...(s.lpSlides||[])]; sl[i] = {...sl[i], minLr: v}; update({ lpSlides: sl }); }}
                    style={{ textAlign: 'center' }} />
                  <PctInput className={fi} placeholder="e.g. 100%" value={row.maxLr || ''}
                    aria-label={`Corridor ${i + 1} maximum loss ratio`}
                    onChange={v => { const sl = [...(s.lpSlides||[])]; sl[i] = {...sl[i], maxLr: v}; update({ lpSlides: sl }); }}
                    style={{ textAlign: 'center' }} />
                  <PctInput className={fi} placeholder="e.g. 50%" value={row.share || ''}
                    aria-label={`Corridor ${i + 1} reinsurer share`}
                    onChange={v => { const sl = [...(s.lpSlides||[])]; sl[i] = {...sl[i], share: v}; update({ lpSlides: sl }); }}
                    style={{ textAlign: 'center' }} />
                </div>
              ))}
              <div style={{ fontSize: 10, color: 'rgba(var(--text-rgb),.5)', marginBottom: 16 }}>Leave unused rows blank.</div>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <button type="button" className="bbg-btn" onClick={() => update({ lpSlides: [{minLr:'',maxLr:'',share:''},{minLr:'',maxLr:'',share:''},{minLr:'',maxLr:'',share:''},{minLr:'',maxLr:'',share:''},{minLr:'',maxLr:'',share:''}] })}>Clear All</button>
                <button type="button" className="action-pill action-pill--primary" style={{ padding: '6px 20px' }} onClick={() => setShowLpSlides(false)}>Done</button>
              </div>
            </div>
          </div>
        )}

        {showCobModal && <CobSelectModal selected={s.classIds || []} classList={classes}
          onSave={ids => { update({ classIds: ids, primaryClassOfBusinessId: ids[0] || null }); setShowCobModal(false); }}
          onClose={() => setShowCobModal(false)} />}
        </AsyncBoundary>
      </>)}
    </WizardLayout>
  );
}

