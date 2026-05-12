// src/screens/non_proportional/final_pricing/constants.js
// Statics that were inline at the top of the 4K-line NpFinalPricing
// file. Extracted so every submodule can import what it needs without
// pulling in the whole screen.

export const ROUTE_KEY = 'NP_FINAL_PRICING';

/**
 * Dropdown options presented to underwriters when they route a
 * pricing decision up the chain. Order matters — displayed top-down.
 */
export const APPROVER_OPTIONS = [
  '',
  'Treaty Head',
  'Chief Underwriting Officer',
  'Head of Retro',
  'CEO Office',
];

/** Hard cap per layer in USD — used by UI validation. */
export const UW_MAX_LIMIT = 50_000_000;

/**
 * NP treaty checklist sections. The panel renders these by iterating;
 * adding/removing an item is purely a config change — no component
 * rewiring required.
 */
export const NP_CHECKLIST_SECTIONS = [
  { key: 'generalClauses', title: 'General Clauses', items: [
    { key: 'claimClause',                           label: 'Claim Clause' },
    { key: 'contingentBusinessInterruptionClause',  label: 'Contingent Business Interruption Clause' },
    { key: 'fullInterestAbroadClause',              label: 'Full Interest Abroad Clause' },
    { key: 'downgradingClause',                     label: 'Downgrading Clause' },
    { key: 'sanctionLimitationClause',              label: 'Sanction & Limitation Clause' },
    { key: 'interlockingClause',                    label: 'Interlocking Clause' },
    { key: 'claimCooperationClause',                label: 'Claim Cooperation Clause' },
  ]},
  { key: 'exclusionClausesPerils', title: 'Exclusion Clauses / Perils', items: [
    { key: 'transmissionDistributionLine',   label: 'Transmission and Distribution Line (1,000 m)' },
    { key: 'russiaUkraineBelarus',           label: 'Russia, Ukraine and Belarus' },
    { key: 'strikesRiotsCivilCommotion',     label: 'Strikes, riots, civil commotion' },
    { key: 'warTerrorismIncludingNCB',       label: 'War & Terrorism including NCB' },
    { key: 'communicableDisease',            label: 'Communicable disease' },
    { key: 'cyberLoss',                      label: 'Cyber loss' },
    { key: 'usaCanada',                      label: 'USA / CANADA' },
    { key: 'nuclearEnergy',                  label: 'Nuclear Energy' },
    { key: 'seepagePollutionContamination',  label: 'Seepage, Pollution and Contamination' },
    { key: 'creditInsurance',                label: 'Credit Insurance' },
    { key: 'offshoreEnergy',                 label: 'Offshore Energy' },
    { key: 'mandatoryPools',                 label: 'Risks ceded to mandatory pools' },
  ]},
  { key: 'territorialScope', title: 'Territorial Scope', items: [
    { key: 'scopeInclusions', label: 'Territorial scope (inclusions) confirmed' },
    { key: 'scopeExclusions', label: 'Territorial exclusions confirmed' },
  ]},
];
