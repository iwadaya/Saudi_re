// src/constants/storageKeys.js
// Canonical keys for the "active entity" selection (contract / quote / fac
// risk) shared across every wizard via hooks/useContractId. Defined here so
// the IDs are never repeated across screens.
//
// Keys that only one module reads stay with that module (e.g. the session
// key in utils/auth.js, the theme key in utils/theme.js).

export const ACTIVE_CONTRACT_ID = 'ACTIVE_CONTRACT_ID_V1';
export const ACTIVE_QUOTE_ID    = 'ACTIVE_QUOTE_ID_V1';
export const ACTIVE_FAC_RISK_ID = 'ACTIVE_FAC_RISK_ID';
export const FAC_QUOTE_MODE     = 'FAC_QUOTE_MODE';
