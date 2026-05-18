// server/src/types/domain.js
// JSDoc typedefs for server-side domain objects. Runtime-free; only
// consumed by editors with JSDoc language services.
//
// Usage in a route handler:
//   /** @type {import('../types/domain.js').QuoteRow} */
//   const q = mainRows[0];

/**
 * Raw row from public.quote after the standard JOIN chain
 * (see db/contractJoins.js → contractContextColumns).
 * @typedef {Object} QuoteRow
 * @property {string} quote_id
 * @property {string|null} quote_ref
 * @property {number} quote_version
 * @property {'DRAFT'|'AWAITING_APPROVAL'|'APPROVED'|'AWAITING_SIGNED_LINE'|'SIGNED'|'NTU'|'DECLINED'} status
 * @property {number} uw_year
 * @property {string|null} cedant_id
 * @property {string|null} broker_id
 * @property {string|null} country_id
 * @property {string|null} treaty_type_id
 * @property {string|null} currency_id
 * @property {string|null} cedant_name
 * @property {string|null} broker_name
 * @property {string|null} country_name
 * @property {string|null} country_code
 * @property {string|null} treaty_type_name
 * @property {string|null} treaty_category
 * @property {string|null} currency_code
 * @property {string} created_at
 * @property {string} updated_at
 */

/**
 * Raw row from public.contract after the standard JOIN chain.
 * @typedef {QuoteRow & {contract_id: string, uw_status: string}} ContractRow
 */

/**
 * User role codes in hierarchy order (1 = highest).
 * @typedef {'CE'|'CU'|'TD'|'TM'|'TUW'} RoleCode
 */

/**
 * User context attached to req by middleware/requestContext.
 * @typedef {Object} RequestUser
 * @property {string} [userId]
 * @property {string} [displayName]
 * @property {RoleCode} [roleCode]
 * @property {number} [hierarchyLevel]
 */

/**
 * Actor label written to contract_audit_event / audit_log.
 * Falls back to 'SYSTEM' when no session user is present.
 * @typedef {string} Actor
 */

/**
 * Approval trail entry.
 * @typedef {Object} ApprovalEvent
 * @property {string} event_id
 * @property {string} contract_id
 * @property {string} event_type
 * @property {Actor} actor
 * @property {object|null} payload
 * @property {string} created_at
 */

export {};
