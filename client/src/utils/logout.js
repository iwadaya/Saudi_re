// Centralised sign-out. Tells the server to clear the httpOnly auth + CSRF
// cookies, then drops the local session metadata and the ref-data cache. The
// network call is best-effort: we always clear locally so the UI returns to a
// logged-out state even if the request fails (offline, expired session, …).
import { api, clearClientRefCache } from '../api';
import { clearSession } from './auth';

export async function performLogout() {
  try { await api.logout(); } catch { /* clear locally regardless */ }
  clearSession();
  // Guarded: under test mocks the api module may not export this helper.
  try { clearClientRefCache(); } catch { /* cache util unavailable */ }
}
