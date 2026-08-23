// src/utils/errorBody.js
// Pull a structured error body out of a thrown error regardless of which
// HTTP layer raised it: our httpClient's `error.body`, an axios-style
// `error.response.data`, or a raw `error.data`. JSON strings are parsed;
// anything unparseable is wrapped as `{ error: <string> }`.
//
// Shared by the STALE_WRITE and PRICING_DRIFT payload extractors so the
// extraction logic lives in exactly one place.

export function parseErrorBody(error) {
  const body = error?.body ?? error?.response?.data ?? error?.data;
  if (!body) return null;
  if (typeof body === 'string') {
    try { return JSON.parse(body); } catch { return { error: body }; }
  }
  return body;
}

/**
 * Human-readable message for a thrown API error: the server's own
 * error/message field when the body carries one, then the Error message,
 * then the caller's fallback. The single implementation of the errMsg
 * helper the ledger screens used to copy around.
 *
 * @param {unknown} error
 * @param {string} fallback
 * @returns {string}
 */
export function errorMessage(error, fallback) {
  const b = parseErrorBody(error);
  if (b && typeof b === 'object' && (b.error || b.message)) return String(b.error || b.message);
  return error?.message ? String(error.message) : fallback;
}

export default parseErrorBody;
