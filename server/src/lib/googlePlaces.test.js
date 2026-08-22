// Places client — the gate, the request shaping and the SSRF fences.
// fetch is always injected, so nothing here reaches the network.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  autocompleteAddress,
  placeDetails,
  isPlacesConfigured,
  toSuggestion,
  PlacesError,
} from './googlePlaces.js';

const KEY = 'test-maps-key';

function okFetch(payload) {
  return vi.fn().mockResolvedValue({ ok: true, json: async () => payload });
}

beforeEach(() => { process.env.GOOGLE_MAPS_API_KEY = KEY; });
afterEach(() => { delete process.env.GOOGLE_MAPS_API_KEY; vi.restoreAllMocks(); });

describe('the configuration gate', () => {
  it('is off with no key and on with one', () => {
    expect(isPlacesConfigured()).toBe(true);
    delete process.env.GOOGLE_MAPS_API_KEY;
    expect(isPlacesConfigured()).toBe(false);
    process.env.GOOGLE_MAPS_API_KEY = '   ';
    expect(isPlacesConfigured()).toBe(false); // whitespace is not a key
  });

  it('fails closed with 503, never a network call, when unconfigured', async () => {
    delete process.env.GOOGLE_MAPS_API_KEY;
    const fetchImpl = okFetch({});
    await expect(autocompleteAddress('riyadh', { fetchImpl }))
      .rejects.toMatchObject({ code: 'PLACES_NOT_CONFIGURED', status: 503 });
    await expect(placeDetails('abc', { fetchImpl }))
      .rejects.toMatchObject({ code: 'PLACES_NOT_CONFIGURED', status: 503 });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('autocomplete', () => {
  it('does not spend a billed call on an input below three characters', async () => {
    const fetchImpl = okFetch({});
    await expect(autocompleteAddress('ri', { fetchImpl })).resolves.toEqual({ suggestions: [] });
    await expect(autocompleteAddress('   ', { fetchImpl })).resolves.toEqual({ suggestions: [] });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('posts to the pinned Google host with the key, a field mask and no redirects', async () => {
    const fetchImpl = okFetch({ suggestions: [] });
    await autocompleteAddress('king fahd road', { sessionToken: 'sess-1', regionCode: 'SA', fetchImpl });

    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://places.googleapis.com/v1/places:autocomplete');
    expect(init.method).toBe('POST');
    expect(init.redirect).toBe('error');
    expect(init.signal).toBeDefined();
    expect(init.headers['X-Goog-Api-Key']).toBe(KEY);
    expect(init.headers['X-Goog-FieldMask']).toContain('placeId');
    expect(JSON.parse(init.body)).toEqual({
      input: 'king fahd road', sessionToken: 'sess-1', regionCode: 'sa',
    });
  });

  it('flattens Google suggestions and drops non-place predictions', async () => {
    const fetchImpl = okFetch({
      suggestions: [
        { placePrediction: {
          placeId: 'PLACE_1',
          text: { text: '12 King Fahd Rd, Riyadh' },
          structuredFormat: { mainText: { text: '12 King Fahd Rd' }, secondaryText: { text: 'Riyadh, Saudi Arabia' } },
        } },
        { queryPrediction: { text: { text: 'king fahd road' } } }, // not a place
      ],
    });
    const { suggestions } = await autocompleteAddress('king fahd', { fetchImpl });
    expect(suggestions).toEqual([{
      placeId: 'PLACE_1',
      text: '12 King Fahd Rd, Riyadh',
      mainText: '12 King Fahd Rd',
      secondaryText: 'Riyadh, Saudi Arabia',
    }]);
  });

  it('maps an upstream failure to 502 without leaking the upstream body', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 403, json: async () => ({ error: { message: 'key blocked for referer x' } }) });
    await expect(autocompleteAddress('riyadh', { fetchImpl }))
      .rejects.toMatchObject({ code: 'PLACES_UPSTREAM', status: 502 });
    await expect(autocompleteAddress('riyadh', { fetchImpl }))
      .rejects.not.toThrow(/referer/);
  });

  it('maps an abort to 504', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    await expect(autocompleteAddress('riyadh', { fetchImpl }))
      .rejects.toMatchObject({ code: 'PLACES_TIMEOUT', status: 504 });
  });
});

describe('place details', () => {
  it('returns the formatted address and coordinates', async () => {
    const fetchImpl = okFetch({
      id: 'PLACE_1',
      formattedAddress: '12 King Fahd Rd, Al Olaya, Riyadh 12214, Saudi Arabia',
      location: { latitude: 24.6911, longitude: 46.6853 },
    });
    await expect(placeDetails('PLACE_1', { sessionToken: 'sess-1', fetchImpl })).resolves.toEqual({
      placeId: 'PLACE_1',
      formattedAddress: '12 King Fahd Rd, Al Olaya, Riyadh 12214, Saudi Arabia',
      latitude: 24.6911,
      longitude: 46.6853,
    });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://places.googleapis.com/v1/places/PLACE_1?sessionToken=sess-1');
    expect(init.method).toBe('GET');
    expect(init.redirect).toBe('error');
  });

  it('nulls coordinates Google did not return rather than emitting NaN', async () => {
    const fetchImpl = okFetch({ id: 'P', formattedAddress: 'Somewhere' });
    await expect(placeDetails('P', { fetchImpl })).resolves.toMatchObject({ latitude: null, longitude: null });
  });

  // The one place a caller value touches a URL. The prior audit's SSRF finding
  // came from exactly this shape, so the allow-list is asserted directly.
  it.each([
    ['a traversal', '../../../secret'],
    ['a full URL', 'https://169.254.169.254/latest/meta-data/'],
    ['a query injection', 'PLACE?key=leak'],
    ['an empty id', ''],
    ['a slash', 'a/b'],
  ])('refuses %s as a place id, before any fetch', async (_label, bad) => {
    const fetchImpl = okFetch({});
    await expect(placeDetails(bad, { fetchImpl }))
      .rejects.toMatchObject({ code: 'PLACES_BAD_PLACE_ID', status: 400 });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('toSuggestion', () => {
  it('returns null for anything without a place id', () => {
    expect(toSuggestion(null)).toBeNull();
    expect(toSuggestion({})).toBeNull();
    expect(toSuggestion({ placePrediction: {} })).toBeNull();
  });

  it('falls back to main + secondary when Google omits the one-line text', () => {
    expect(toSuggestion({ placePrediction: {
      placeId: 'X',
      structuredFormat: { mainText: { text: 'Main' }, secondaryText: { text: 'Second' } },
    } })).toMatchObject({ text: 'Main, Second' });
  });
});

describe('PlacesError', () => {
  it('carries the status and code errorHandler reads off it', () => {
    const e = new PlacesError('nope', 'CODE', 418);
    expect(e).toBeInstanceOf(Error);
    expect(e.status).toBe(418);
    expect(e.code).toBe('CODE');
  });
});
