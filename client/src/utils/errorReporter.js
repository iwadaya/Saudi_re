// src/utils/errorReporter.js
// Ship runtime errors caught by React error boundaries (and anything
// else worth recording) to the server, where they become structured
// log lines tagged with the request/user context.
//
// Design notes:
//   • Fire-and-forget. The user has already seen the error UI; we
//     don't want their recovery path blocked on our telemetry
//     succeeding.
//   • Rate-limited per-session in-memory (RATE_CAP over RATE_WINDOW_MS)
//     so a crash loop doesn't DDOS our own server.
//   • De-duplicated by message+stack hash within a short window so a
//     component re-rendering in an error state doesn't post ten times
//     a second.
//   • No PII: we send message + stack + path. If future callers
//     include user context explicitly we log it; we never grab session
//     data implicitly.

import { getAuthHeaders } from './auth';
import { getLastRequestId } from './httpClient.js';

const ENDPOINT = '/api/client-events';
const RATE_CAP = 20;              // at most 20 events per window
const RATE_WINDOW_MS = 60_000;    // 1 minute rolling
const DEDUPE_MS = 5_000;          // swallow identical events within 5s

const sent = [];                   // timestamps for rate-limiting
const recent = new Map();          // hash -> lastSeenMs for dedupe

/**
 * Serialise an Error into a small, wire-safe shape. Long stack traces
 * are trimmed on the server side too, but trimming here saves bytes.
 */
function serialise(err) {
  if (!err) return { message: 'unknown', stack: undefined };
  if (err instanceof Error) {
    return {
      message: String(err.message || err.name || 'Error').slice(0, 2_000),
      stack:   err.stack ? String(err.stack).slice(0, 10_000) : undefined,
    };
  }
  try {
    return { message: String(err).slice(0, 2_000), stack: undefined };
  } catch {
    return { message: 'unserialisable error', stack: undefined };
  }
}

function dedupeKey(type, payload) {
  return `${type}:${payload.message}:${(payload.stack || '').slice(0, 200)}`;
}

function withinRateLimit() {
  const now = Date.now();
  // Drop timestamps outside the window
  while (sent.length && now - sent[0] > RATE_WINDOW_MS) sent.shift();
  if (sent.length >= RATE_CAP) return false;
  sent.push(now);
  return true;
}

/**
 * Report a runtime error to the server. Never throws; returns a
 * Promise that resolves to true on success, false otherwise.
 *
 * @param {'boundary'|'unhandled'|'chunk_load'|'other'} type
 * @param {Error|string} error
 * @param {object} [extra]   Optional context (componentStack, route, etc.)
 */
export async function reportError(type, error, extra = {}) {
  try {
    // Attach the last outbound request ID so operators can jump from
    // the crash breadcrumb straight to the backend trace that was
    // in-flight when things went wrong.
    const lastReq = getLastRequestId();
    const payload = {
      type,
      ...serialise(error),
      path: typeof window !== 'undefined' ? window.location?.pathname : undefined,
      userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : undefined,
      context: {
        ...(extra && typeof extra === 'object' ? extra : {}),
        ...(lastReq ? { lastRequestId: lastReq } : {}),
      },
    };

    // Dedupe: same event within DEDUPE_MS → silently drop
    const key = dedupeKey(type, payload);
    const now = Date.now();
    const lastSeen = recent.get(key);
    if (lastSeen && now - lastSeen < DEDUPE_MS) return false;
    recent.set(key, now);
    // Prune map when it gets big
    if (recent.size > 200) {
      for (const [k, t] of recent) {
        if (now - t > RATE_WINDOW_MS) recent.delete(k);
      }
    }

    if (!withinRateLimit()) return false;

    const base = (() => {
      try {
        const { hostname, port } = window.location;
        if ((hostname === 'localhost' || hostname === '127.0.0.1') && port && port !== '4000') {
          return `http://${hostname}:4000`;
        }
      } catch {}
      return '';
    })();

    await fetch(`${base}${ENDPOINT}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
      body: JSON.stringify(payload),
      keepalive: true,  // allow the request to outlive the page on unload
    });
    return true;
  } catch {
    // Swallow — reporter failures must never cascade
    return false;
  }
}

/**
 * Wire global error handlers once, early in boot. Idempotent.
 */
let installed = false;
export function installGlobalErrorReporter() {
  if (installed || typeof window === 'undefined') return;
  installed = true;

  window.addEventListener('error', (event) => {
    const err = event.error || event.message;
    reportError('unhandled', err, { filename: event.filename, lineno: event.lineno });
  });

  window.addEventListener('unhandledrejection', (event) => {
    reportError('unhandled', event.reason, { kind: 'promise' });
  });
}

// Exposed for tests
export const __internals__ = { sent, recent };
