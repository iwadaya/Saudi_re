// src/utils/httpClient.js
// Resilient fetch primitive used by api.js. Adds four production-grade
// behaviours that bare fetch lacks:
//
//   1. Retries with exponential backoff on transient failures
//      (network errors, 502/503/504). Mutating verbs (POST/PUT/DELETE)
//      are NOT retried by default — the caller can opt in if the
//      operation is idempotent.
//
//   2. Per-request timeout via AbortController. A stuck endpoint can't
//      hold the UI hostage indefinitely.
//
//   3. External AbortSignal pass-through so a React component that
//      unmounts mid-request can cancel and free up resources.
//
//   4. X-Request-Id generation + forwarding. Every outbound request
//      gets a unique ID; the server reuses it and echoes it back on
//      every log line. Client-side errors can then be traced to the
//      exact server trace by matching IDs.
//
// Usage:
//   const data = await httpFetch('/api/quotes', { method: 'GET' });
//   const data = await httpFetch('/api/quotes', { method: 'GET', signal: ctrl.signal });
//   const data = await httpFetch('/api/quotes', {
//     method: 'PUT', body: { … }, retry: { attempts: 3 },
//   });

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_RETRY_ATTEMPTS = 3;
const DEFAULT_RETRY_BASE_MS = 250;
const RETRYABLE_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);
const RETRYABLE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

class HttpError extends Error {
  constructor(message, { status, body, path, method } = {}) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.body = body;
    this.path = path;
    this.method = method;
  }
}
export { HttpError };

function shouldRetry(method, error, attempt, maxAttempts, allowedMethods) {
  if (attempt >= maxAttempts) return false;
  if (!allowedMethods.has(method)) return false;
  // Network error (no status) → retry
  if (!(error instanceof HttpError)) return true;
  // HTTP error → only specific transient statuses
  return RETRYABLE_STATUSES.has(error.status);
}

/**
 * Generate a short, URL-safe unique ID for X-Request-Id. We avoid
 * crypto.randomUUID() for the tiny chance it's missing in odd browser
 * surfaces; a 16-char alphabet-hex id is plenty for request correlation.
 */
function makeRequestId() {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
  } catch {}
  // Fallback: timestamp + random
  const t = Date.now().toString(36);
  const r = Math.random().toString(36).slice(2, 10);
  return `${t}-${r}`;
}

// Exposed for error-reporter correlation — the last request ID we
// emitted is worth attaching to any crash report so the backend trace
// is findable. Not a persistent store; just "most recent outbound".
let lastRequestId = null;
export function getLastRequestId() { return lastRequestId; }

function backoffDelay(attempt, baseMs) {
  // Exponential: base, base*2, base*4, ... + jitter ±25%
  const exp = baseMs * Math.pow(2, attempt - 1);
  const jitter = exp * 0.25 * (Math.random() * 2 - 1);
  return Math.max(0, Math.round(exp + jitter));
}

/**
 * Compose two AbortSignals so we can both honour the caller's cancel
 * AND apply our own timeout. Modern Chromium has AbortSignal.any but
 * jsdom + older browsers don't, so we polyfill.
 */
function combineSignals(...signals) {
  const present = signals.filter(Boolean);
  if (present.length === 0) return null;
  if (present.length === 1) return present[0];
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.any === 'function') {
    return AbortSignal.any(present);
  }
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  for (const s of present) {
    if (s.aborted) { controller.abort(); break; }
    s.addEventListener('abort', onAbort, { once: true });
  }
  return controller.signal;
}

/**
 * Fetch with retries + timeout + abort propagation.
 *
 * @param {string} url Full URL or path relative to origin.
 * @param {RequestInit & {
 *   timeoutMs?: number,
 *   retry?: { attempts?: number, baseMs?: number, methods?: Set<string> },
 *   onAttempt?: (attempt: number) => void,
 *   sleep?: (ms: number) => Promise<void>,
 * }} init
 */
export async function httpFetch(url, init = {}) {
  const {
    timeoutMs = DEFAULT_TIMEOUT_MS,
    retry,
    signal: externalSignal,
    onAttempt,
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
    ...fetchInit
  } = init;

  const maxAttempts = retry?.attempts ?? DEFAULT_RETRY_ATTEMPTS;
  const baseMs = retry?.baseMs ?? DEFAULT_RETRY_BASE_MS;
  const allowedMethods = retry?.methods ?? RETRYABLE_METHODS;
  const method = (fetchInit.method || 'GET').toUpperCase();
  const path = url; // for error context

  // One request ID per call — reused across retry attempts so the
  // server sees a single trace rather than N separate traces for a
  // flaky connection.
  const existingHeaders = fetchInit.headers || {};
  const alreadyHasId = Object.keys(existingHeaders).some(
    (k) => k.toLowerCase() === 'x-request-id',
  );
  const requestId = alreadyHasId ? null : makeRequestId();
  const headers = requestId
    ? { ...existingHeaders, 'X-Request-Id': requestId }
    : existingHeaders;
  if (requestId) lastRequestId = requestId;

  let attempt = 0;
  while (true) {
    attempt++;
    if (onAttempt) onAttempt(attempt);

    // Per-attempt timeout signal, combined with the caller's signal
    const timeoutCtrl = new AbortController();
    const timeoutId = setTimeout(() => timeoutCtrl.abort(), timeoutMs);
    const signal = combineSignals(externalSignal, timeoutCtrl.signal);

    try {
      const res = await fetch(url, { ...fetchInit, headers, signal });
      clearTimeout(timeoutId);

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        const err = new HttpError(
          `API ${method} ${path} → ${res.status}: ${text || res.statusText}`,
          { status: res.status, body: text, path, method },
        );
        if (shouldRetry(method, err, attempt, maxAttempts, allowedMethods)) {
          await sleep(backoffDelay(attempt, baseMs));
          continue;
        }
        throw err;
      }
      return res;
    } catch (err) {
      clearTimeout(timeoutId);
      // Caller cancelled — do not retry, surface to caller
      if (externalSignal?.aborted) throw err;
      // Our timeout fired — convert to a clear error
      if (err?.name === 'AbortError' && timeoutCtrl.signal.aborted) {
        const timeoutErr = new HttpError(
          `API ${method} ${path} → timeout after ${timeoutMs}ms`,
          { status: 0, path, method },
        );
        if (shouldRetry(method, timeoutErr, attempt, maxAttempts, allowedMethods)) {
          await sleep(backoffDelay(attempt, baseMs));
          continue;
        }
        throw timeoutErr;
      }
      // Network error — retry if appropriate
      if (shouldRetry(method, err, attempt, maxAttempts, allowedMethods)) {
        await sleep(backoffDelay(attempt, baseMs));
        continue;
      }
      throw err;
    }
  }
}
