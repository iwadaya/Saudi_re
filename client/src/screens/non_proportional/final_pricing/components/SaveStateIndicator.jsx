// src/screens/non_proportional/final_pricing/components/SaveStateIndicator.jsx
//
// The save-state banner now lives at src/components/SaveStateIndicator.jsx
// (app-core) so the shared chunk doesn't depend on a screen chunk — that
// back-reference used to create a circular app-core ↔ np-final-pricing
// chunk. This thin re-export keeps the historical import path
// (`./components/SaveStateIndicator.jsx`) and the co-located test working.
export { default } from '../../../../components/SaveStateIndicator.jsx';
