// src/hooks/useWizard.js — Hook for wizard navigation
import { useNavigate } from 'react-router-dom';
import { useCallback } from 'react';
import { useAppState } from '../context/AppContext';
import { getWizardNav, ROUTE_PATHS } from '../config/wizard';
import { isNpCatFlowDisabled, isNpRiskFlowDisabled } from '../utils/npTreatyType';

export function useWizard(routeKey) {
  const navigate = useNavigate();
  const { state: appState } = useAppState();

  const triangulationsEnabled = appState.propTreatyDetail?.triangulationsAvailable !== false;
  const quoteMode = appState.quoteMode;
  const wizardMode = routeKey?.startsWith('FAC_') ? 'FAC' : routeKey?.startsWith('NP_') ? 'NP' : 'PROP';
  const npCatDisabled  = isNpCatFlowDisabled(appState);
  const npRiskDisabled = isNpRiskFlowDisabled(appState);

  const nav = getWizardNav(routeKey, { wizardMode, quoteMode, triangulationsEnabled, npCatDisabled, npRiskDisabled });

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
  };
}

export default useWizard;
