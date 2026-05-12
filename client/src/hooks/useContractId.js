// src/hooks/useContractId.js — Unified active-entity resolution
//
// Single source of truth for the "currently selected" contract / quote / fac
// risk across every wizard. All screens read via the hooks; all writes go
// through the setters. Storage keys come from constants/storageKeys.js so
// they are never repeated in the codebase.
//
// Resolution priority for every entity:
//   1. React Router navigation state (location.state.{contractId|facRiskId})
//   2. AppContext slice (propTreatyDetail / npTreatyDetail / facRiskDetail)
//   3. localStorage (fallback for refresh / direct URL load)

import { useLocation } from 'react-router-dom';
import { useAppState } from '../context/AppContext';
import {
  ACTIVE_CONTRACT_ID,
  ACTIVE_QUOTE_ID,
  ACTIVE_FAC_RISK_ID,
  FAC_QUOTE_MODE,
} from '../constants/storageKeys';

const safeGet = (key) => {
  try { return localStorage.getItem(key); } catch { return null; }
};
const safeSet = (key, value) => {
  try { localStorage.setItem(key, String(value)); } catch {}
};
const safeRemove = (key) => {
  try { localStorage.removeItem(key); } catch {}
};

/**
 * Resolve the active contract or quote ID for the current screen (Prop / NP).
 * Priority: navigation state → AppContext → localStorage.
 * @returns {string} '' if nothing is selected (callers must guard).
 */
export function useContractId() {
  const { state } = useAppState();
  const location  = useLocation();
  const quoteMode = state.quoteMode;

  const fromNav = location?.state?.contractId;
  if (fromNav) return String(fromNav);

  const fromState =
    state.propTreatyDetail?.contractId ||
    state.npTreatyDetail?.contractId;
  if (fromState) return String(fromState);

  const v = safeGet(quoteMode ? ACTIVE_QUOTE_ID : ACTIVE_CONTRACT_ID);
  return v ? String(v) : '';
}

/**
 * Resolve the active facultative risk ID. Mirrors useContractId().
 * Priority: navigation state → AppContext → localStorage.
 */
export function useFacRiskId() {
  const { state } = useAppState();
  const location  = useLocation();

  const fromNav = location?.state?.facRiskId;
  if (fromNav) return String(fromNav);

  const fromState = state.facRiskDetail?.riskId;
  if (fromState) return String(fromState);

  const v = safeGet(ACTIVE_FAC_RISK_ID);
  return v ? String(v) : '';
}

// ────────────────────────────────────────────────────────────────────────────
// Setters — all writes to active-entity state go through these.
// They keep localStorage in sync so a refresh restores the same selection.
// ────────────────────────────────────────────────────────────────────────────

export function setActiveContractId(id) {
  if (id == null || id === '') return;
  safeSet(ACTIVE_CONTRACT_ID, id);
  safeRemove(ACTIVE_QUOTE_ID);
}

export function setActiveQuoteId(id) {
  if (id == null || id === '') return;
  safeSet(ACTIVE_QUOTE_ID, id);
  safeRemove(ACTIVE_CONTRACT_ID);
}

export function clearActiveContractId() {
  safeRemove(ACTIVE_CONTRACT_ID);
  safeRemove(ACTIVE_QUOTE_ID);
}

export function setActiveFacRiskId(id, opts = {}) {
  if (id == null || id === '') return;
  safeSet(ACTIVE_FAC_RISK_ID, id);
  // Only touch the quote-mode flag if the caller explicitly passes it,
  // otherwise leave the prior value alone (matches legacy open-risk behaviour).
  if (Object.prototype.hasOwnProperty.call(opts, 'quote')) {
    safeSet(FAC_QUOTE_MODE, opts.quote ? '1' : '0');
  }
}

export function clearActiveFacRiskId() {
  safeRemove(ACTIVE_FAC_RISK_ID);
  safeRemove(FAC_QUOTE_MODE);
}

export default useContractId;
