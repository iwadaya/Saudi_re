// src/utils/readOnlyError.js
// Detects the server's "you are not the assignee" verdict so a pricing editor
// can flip itself read-only and STOP re-POSTing.
//
// services/permissions.js → assertCanEdit throws
//   Object.assign(new Error('This treaty is read-only…'), { status: 403, code: 'READ_ONLY' })
// for every mutating route when the requester isn't the current assignee.
//
// A READ_ONLY is an authorization verdict, NOT a transient failure — it must
// never be retried (httpClient already excludes 4xx from its retry set; this
// helper lets the save paths bail out of their stale-write/overwrite branches
// too, and lock the UI so navigation/workflow saves stop firing).

import { parseErrorBody } from './errorBody.js';

export function isReadOnlyError(error) {
  if (!error) return false;
  // Primary signal: the structured error body carries code: 'READ_ONLY'.
  const body = parseErrorBody(error);
  if (body?.code === 'READ_ONLY') return true;
  // Fallback: a 403 from a mutating route is a not-assignee verdict even if the
  // body didn't parse (e.g. a non-JSON proxy/error page in front of the API).
  const status = error.status ?? error.response?.status;
  return status === 403 && /read[\s-]?only/i.test(String(body?.error || error.message || ''));
}

export default isReadOnlyError;
