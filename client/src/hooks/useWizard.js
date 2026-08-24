// src/hooks/useWizard.js — Hook for wizard navigation
import { useNavigate } from 'react-router-dom';
import { useCallback } from 'react';
import { useAppState } from '../context/AppContext';
import { useContractId } from './useContractId';
import { useNpTreatyDetail } from './useNpTreatyDetail';
import { getWizardNav, ROUTE_PATHS, STEP_LABELS } from '../config/wizard';
import { isNpCatFlowDisabled, isNpRiskFlowDisabled, isNpStopLossTreaty } from '../utils/npTreatyType';

export function useWizard(routeKey) {
  const navigate = useNavigate();
  const { state: appState } = useAppState();

  const triangulationsEnabled = appState.propTreatyDetail?.triangulationsAvailable !== false;
  const quoteMode = appState.quoteMode;
  const wizardMode = routeKey?.startsWith('FAC_') ? 'FAC' : routeKey?.startsWith('NP_') ? 'NP' : 'PROP';
  // NP treaty-type gating with server fallback: on a deep link the raw slice
  // is empty and would render Risk-XL/large-loss tabs on a CAT XL treaty
  // (audit F6). Enabled only on NP routes — the fallback fetch would 409 on a
  // proportional contract.
  const contractId = useContractId();
  const npDetail = useNpTreatyDetail(contractId, !!quoteMode, { enabled: wizardMode === 'NP' });
  const npShim = { npTreatyDetail: npDetail };
  const npCatDisabled  = isNpCatFlowDisabled(npShim);
  const npRiskDisabled = isNpRiskFlowDisabled(npShim);
  const npStopLoss     = isNpStopLossTreaty(npShim);
  // Rating families on the active fac risk, published by FacRiskDetail. When
  // it is absent (deep link, or no class picked yet) every fac step shows.
  const facFamilies    = appState.facRiskDetail?.ratingFamilies;

  const nav = getWizardNav(routeKey, { wizardMode, quoteMode, triangulationsEnabled, npCatDisabled, npRiskDisabled, npStopLoss, facFamilies });

  const goTo = useCallback((key) => {
    const path = ROUTE_PATHS[key];
    if (path) navigate(path);
  }, [navigate]);

  const goPrev = useCallback(() => {
    if (nav.prev) goTo(nav.prev);
  }, [nav.prev, goTo]);

  const goNext = useCallback(() => {
    if (nav.next) goTo(nav.next);
  }, [nav.next, goTo]);

  return {
    ...nav,
    goTo,
    goPrev,
    goNext,
    wizardMode,
    quoteMode,
    routeKey,
    // Display labels for the adjacent steps so the nav dock can read
    // "Next: <step> →" / "← Back: <step>" without hardcoding routes.
    nextLabel: nav.next ? STEP_LABELS[nav.next] || null : null,
    prevLabel: nav.prev ? STEP_LABELS[nav.prev] || null : null,
  };
}

export default useWizard;
