// client/src/types/domain.js
// JSDoc typedefs for the core domain objects used across the client.
//
// These are *not* runtime code — nothing here is imported. The file
// exists so that editors with TypeScript/JSDoc language services
// (VSCode, WebStorm, etc.) can autocomplete fields and flag typos
// when you annotate local variables with @type {Quote} etc.
//
// Usage:
//   /** @type {import('../types/domain').Layer} */
//   const l = layers[0];
//
// We deliberately omit fields that are rarely used or purely
// UI-internal (cobRows, layer visual state) — add them here as real
// bugs surface rather than documenting every field up front.

/**
 * Reference data shared between quotes and treaties.
 * @typedef {Object} RefName
 * @property {string} id
 * @property {string} name
 */

/**
 * Treaty/quote header — the five reference-table FK columns
 * the contract and quote tables carry identically.
 * @typedef {Object} ContractHeader
 * @property {string} cedant_id
 * @property {string} [broker_id]
 * @property {string} [currency_id]
 * @property {string} [country_id]
 * @property {string} [treaty_type_id]
 * @property {number} uw_year
 * @property {'DRAFT'|'WAITING_APPROVAL'|'APPROVED'|'AWAITING_SIGNED_LINE'|'SIGNED'|'NTU'|'DECLINED'} status
 * @property {'TRIANGLE'|'HISTORICAL'|'BURN'} [experience_source]
 * @property {string} [cedant_name]
 * @property {string} [broker_name]
 * @property {string} [country_name]
 * @property {string} [country_code]
 * @property {string} [treaty_type_name]
 * @property {string} [treaty_category]
 * @property {string} [currency_code]
 * @property {string} [renewal_date]
 * @property {string} [inception_date]
 * @property {string} [contract_description]
 */

/**
 * One non-proportional layer.
 * All numeric fields are stored as plain numbers (never strings with % suffixes)
 * on the wire; the client may format with % for display.
 * @typedef {Object} NpLayer
 * @property {number} layer_number         1-indexed position.
 * @property {number} [attachment]         USD attachment point / deductible.
 * @property {number} [layer_limit]        USD limit above attachment.
 * @property {number} [aggregate_limit]    USD annual aggregate limit (optional).
 * @property {number} [egnpi]              Estimated gross net premium income.
 * @property {number} [earned_premium]
 * @property {number} [rate]               Rate %.
 * @property {number} [rol]                Rate-on-line %.
 * @property {number} [num_reinstatements]
 * @property {number} [reinstatement_pct]
 * @property {number} [annual_agg_deductible]
 * @property {'RISK'|'CAT'|'BOTH'} [peril_scope]
 * @property {number} [mdp]
 * @property {number} [mdp_pct]
 * @property {string[]} [class_of_business_ids]
 */

/**
 * Per-layer pricing output row as stored by saveNpPricing.
 * @typedef {Object} NpLayerPricingOutput
 * @property {number} layer_number
 * @property {'RISK'|'CAT'|'BOTH'} section
 * @property {number} [pure_burning_cost]
 * @property {number} [pareto_pricing]
 * @property {number} [burn_plus_pareto]
 * @property {number} [exposure_rating]
 * @property {number} [burn_weight_pct]
 * @property {number} [exposure_weight_pct]
 * @property {number} [pricing_loading_pct]
 * @property {number} [total_price]
 * @property {number} [uw_price]
 * @property {number} [prob_attach]
 * @property {number} [prob_exhaust]
 */

/**
 * Full quote as returned by GET /api/quotes/:id.
 * @typedef {Object} Quote
 * @property {string} contract_id          Alias for quote_id on the wire.
 * @property {string} quote_id
 * @property {string|null} quote_ref
 * @property {number} quote_version
 * @property {string|null} quote_version_of
 * @property {string|null} bound_contract_id
 * @property {string[]} class_ids
 * @property {ContractHeader} header
 * @property {Object} detail
 * @property {Object} commissions
 * @property {Object} lossParticipation
 * @property {Array<{class_id:string,premium:number}>} epi_split
 * @property {Array<{class_of_business_id:string,limit_amount:number,basis:string}>} underwriting_limits
 */

/**
 * Full treaty as returned by GET /api/treaties/:id.
 * Same shape as Quote's header/detail/commissions, keyed by contract_id.
 * @typedef {Object} Treaty
 * @property {string} contract_id
 * @property {ContractHeader} header
 * @property {Object} detail
 * @property {Object} commissions
 * @property {Object} lossParticipation
 * @property {Array} epi_split
 * @property {Array} underwriting_limits
 */

/**
 * Approval trail entry.
 * @typedef {Object} ApprovalEvent
 * @property {string} event_id
 * @property {string} contract_id
 * @property {'SUBMITTED'|'APPROVED'|'RETURNED'|'SIGNED'|'NTU'|'DECLINED'} event_type
 * @property {string} actor
 * @property {string} [comment]
 * @property {string} created_at
 */

/**
 * Session payload stored in localStorage after login.
 * @typedef {Object} Session
 * @property {string} userId
 * @property {string} [username]
 * @property {string} displayName       Overridden client-side to the role title.
 * @property {'CE'|'CU'|'TD'|'TM'|'TUW'} roleCode
 * @property {string} [roleName]
 * @property {number} hierarchyLevel    1 (CE) … 5 (TUW).
 * @property {number|null} effectiveLimitUsd
 * @property {'PROP_ONLY'|'NP_ONLY'|'BOTH'} treatyTypeScope
 * @property {boolean} canOverrideBelow
 * @property {number} [approvalsRequired]
 */

// No runtime exports — this file is types only.
export {};
