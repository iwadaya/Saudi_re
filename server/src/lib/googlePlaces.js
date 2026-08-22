// server/src/lib/googlePlaces.js
//
// Thin, hardened server-side client for the Google Places API (New).
//
// WHY THIS IS SERVER-SIDE. The obvious implementation is Google's browser JS
// SDK with a referrer-restricted key. We proxy instead, for three reasons that
// matter to this codebase specifically:
//
//   1. CSP. app.js ships an ENFORCING policy with `script-src 'self' + nonce`
//      and `connect-src 'self'`. The browser SDK would need maps.googleapis.com
//      in script-src AND connect-src, plus the tile hosts in img-src — a real
//      widening of the script surface for an address box. Proxying keeps every
//      request same-origin and the policy untouched.
//   2. The key stays secret. The client bundle carries no VITE_* secrets today
//      and this does not change that. A browser Maps key is public by design and
//      is only ever as good as its referrer restriction.
//   3. Spend control. Places is billed per request. Behind our own route it sits
//      under the existing API rate limiters and can be capped, audited and
//      switched off without a redeploy of the client.
//
// FAIL-CLOSED. With no GOOGLE_MAPS_API_KEY configured, isPlacesConfigured() is
// false and the routes answer 503 PLACES_NOT_CONFIGURED. Nothing throws at
// import time and no other route is affected — the same posture as the AI gate
// in lib/aiGovernance.js.
//
// SSRF. Every URL here is a module constant. No caller-supplied value ever
// reaches the URL — user input travels in the JSON body, and place ids go
// through a strict character allow-list before being placed in a path segment.
// Requests use `redirect: 'error'` and an AbortController timeout, matching
// lib/uploadStorage.js fetchRemoteAsset.

import { logger } from './logger.js';

const AUTOCOMPLETE_URL = 'https://places.googleapis.com/v1/places:autocomplete';
const PLACE_DETAILS_BASE = 'https://places.googleapis.com/v1/places/';

const DEFAULT_TIMEOUT_MS = 8_000;

// Places ids are opaque, but Google documents them as URL-safe tokens. Pinning
// the shape keeps anything path-traversal-ish (or a full URL) out of the
// details request, which is the only place a caller value touches a URL.
const PLACE_ID_RE = /^[A-Za-z0-9_-]{1,255}$/;

/** The configured API key, or '' when the feature is switched off. */
export function placesApiKey() {
  return String(process.env.GOOGLE_MAPS_API_KEY || '').trim();
}

/** Whether address lookup is available at all. */
export function isPlacesConfigured() {
  return placesApiKey().length > 0;
}

export class PlacesError extends Error {
  constructor(message, code, status = 502) {
    super(message);
    this.name = 'PlacesError';
    this.code = code;
    this.status = status;
  }
}

function assertConfigured() {
  if (!isPlacesConfigured()) {
    throw new PlacesError(
      'Address lookup is not configured on this deployment.',
      'PLACES_NOT_CONFIGURED',
      503,
    );
  }
}

/**
 * POST/GET a Google Places endpoint with a timeout, no redirects and a field
 * mask. `fetchImpl` is injectable so tests never touch the network.
 */
async function callGoogle(url, { method, body, fieldMask, timeoutMs, fetchImpl }) {
  const doFetch = fetchImpl || globalThis.fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs || DEFAULT_TIMEOUT_MS);
  try {
    const res = await doFetch(url, {
      method,
      redirect: 'error',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': placesApiKey(),
        'X-Goog-FieldMask': fieldMask,
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!res.ok) {
      // Google's error body can echo the request; log the status only, never the
      // body, so a mistyped address never lands in the logs.
      logger.warn('[places] upstream returned an error', { status: res.status });
      throw new PlacesError('Address lookup failed upstream.', 'PLACES_UPSTREAM', 502);
    }
    return await res.json();
  } catch (e) {
    if (e instanceof PlacesError) throw e;
    if (e?.name === 'AbortError') {
      throw new PlacesError('Address lookup timed out.', 'PLACES_TIMEOUT', 504);
    }
    logger.warn('[places] request failed', { error: e?.message });
    throw new PlacesError('Address lookup failed.', 'PLACES_UNAVAILABLE', 502);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Shape one Google suggestion into the minimal object the client needs. Google
 * nests the useful parts under placePrediction; anything else (query
 * predictions) is dropped by returning null.
 */
export function toSuggestion(raw) {
  const p = raw?.placePrediction;
  if (!p?.placeId) return null;
  const main = p.structuredFormat?.mainText?.text || '';
  const secondary = p.structuredFormat?.secondaryText?.text || '';
  return {
    placeId: p.placeId,
    // `text` is the full one-line description; main/secondary let the UI show a
    // bold primary line with the locality underneath.
    text: p.text?.text || [main, secondary].filter(Boolean).join(', '),
    mainText: main,
    secondaryText: secondary,
  };
}

/**
 * Address suggestions for a partial input.
 *
 * @param {string} input        what the underwriter has typed
 * @param {object} [opts]
 * @param {string} [opts.sessionToken] Google session token — groups the keystrokes
 *   of one lookup plus its details call into a single billable session. The client
 *   mints it and discards it after a pick.
 * @param {string} [opts.regionCode] ISO-3166-1 alpha-2 bias, e.g. 'SA'.
 * @returns {Promise<{suggestions: Array<{placeId:string,text:string,mainText:string,secondaryText:string}>}>}
 */
export async function autocompleteAddress(input, { sessionToken, regionCode, timeoutMs, fetchImpl } = {}) {
  assertConfigured();
  const q = String(input ?? '').trim();
  if (q.length < 3) return { suggestions: [] }; // too short to be worth a billed call

  const body = { input: q };
  if (sessionToken) body.sessionToken = sessionToken;
  if (regionCode) body.regionCode = String(regionCode).toLowerCase();

  const json = await callGoogle(AUTOCOMPLETE_URL, {
    method: 'POST',
    body,
    fieldMask: 'suggestions.placePrediction.placeId,suggestions.placePrediction.text,suggestions.placePrediction.structuredFormat',
    timeoutMs,
    fetchImpl,
  });

  const suggestions = (Array.isArray(json?.suggestions) ? json.suggestions : [])
    .map(toSuggestion)
    .filter(Boolean);
  return { suggestions };
}

/**
 * Resolve a chosen suggestion to a formatted address plus coordinates.
 *
 * @returns {Promise<{placeId:string, formattedAddress:string, latitude:number|null, longitude:number|null}>}
 */
export async function placeDetails(placeId, { sessionToken, timeoutMs, fetchImpl } = {}) {
  assertConfigured();
  const id = String(placeId ?? '').trim();
  if (!PLACE_ID_RE.test(id)) {
    throw new PlacesError('Invalid place id.', 'PLACES_BAD_PLACE_ID', 400);
  }

  // encodeURIComponent on top of the allow-list: belt and braces on the one
  // caller-influenced path segment in this module.
  const url = `${PLACE_DETAILS_BASE}${encodeURIComponent(id)}`
    + (sessionToken ? `?sessionToken=${encodeURIComponent(sessionToken)}` : '');

  const json = await callGoogle(url, {
    method: 'GET',
    fieldMask: 'id,formattedAddress,location',
    timeoutMs,
    fetchImpl,
  });

  const lat = Number(json?.location?.latitude);
  const lng = Number(json?.location?.longitude);
  return {
    placeId: json?.id || id,
    formattedAddress: json?.formattedAddress || '',
    latitude: Number.isFinite(lat) ? lat : null,
    longitude: Number.isFinite(lng) ? lng : null,
  };
}
