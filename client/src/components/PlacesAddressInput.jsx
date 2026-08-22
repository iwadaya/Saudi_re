// client/src/components/PlacesAddressInput.jsx
//
// Address input with Google Places autocomplete, talking to our own
// same-origin proxy (routes/facPlaces.js) rather than Google's browser SDK —
// see lib/googlePlaces.js for why.
//
// Degrades to a plain text input, with no visible difference, when the
// deployment has no GOOGLE_MAPS_API_KEY or when lookup fails. The address stays
// free text either way: picking a suggestion is an enrichment (a normalised
// one-line address plus coordinates), never a requirement. An underwriter can
// always type an address Google has never heard of — remote industrial sites
// routinely are not on the map.
//
// Accessibility follows the ARIA combobox pattern: the input owns the listbox,
// aria-activedescendant tracks the highlighted row, and ↑/↓/Enter/Escape work
// without a mouse.
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { api } from '../api';
import { logger } from '../utils/logger';

const DEBOUNCE_MS = 250;
const MIN_CHARS = 3; // matches the server, which will not spend a billed call below this

/** Session token: groups the keystrokes of one lookup + its details call into a
 *  single billable Places session. Minted per lookup, discarded after a pick. */
function newSessionToken() {
  try {
    if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  } catch { /* fall through */ }
  return `s-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/**
 * @param {object}   props
 * @param {string}   props.value          current address text
 * @param {(next: string) => void} props.onChange  free-text edits
 * @param {(picked: {address: string, latitude: number|null, longitude: number|null, placeId: string}) => void} [props.onPlacePicked]
 *        fired only when a suggestion is chosen and resolved
 * @param {() => void} [props.onPlaceCleared] fired when the text is edited away
 *        from a previously picked place, so the caller can drop stale coordinates
 * @param {boolean}  [props.hasCoords]    whether the caller currently holds coordinates
 * @param {string}   [props.regionCode]   ISO-3166-1 alpha-2 bias, e.g. 'SA'
 * @param {string}   [props.placeholder]
 * @param {string}   [props.className]
 * @param {string}   [props.id]
 */
export default function PlacesAddressInput({
  value,
  onChange,
  onPlacePicked,
  onPlaceCleared,
  hasCoords = false,
  regionCode,
  placeholder,
  className = 'fi',
  id,
}) {
  const [configured, setConfigured] = useState(null); // null = not yet known
  const [suggestions, setSuggestions] = useState([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [busy, setBusy] = useState(false);

  const wrapRef = useRef(null);
  const sessionRef = useRef(null);
  // Bumped on every keystroke; a resolved request whose id is stale is dropped.
  // Without this a slow early request can land after a fast later one and
  // repopulate the list with suggestions for a prefix the user has moved past.
  const reqIdRef = useRef(0);
  // Set while we programmatically write a picked address, so the resulting
  // onChange does not immediately reopen the dropdown or clear the coordinates.
  const pickingRef = useRef(false);

  const reactId = useId();
  const listboxId = `${id || reactId}-places-listbox`;
  const optionId = (i) => `${listboxId}-opt-${i}`;

  // One status probe per mount. A failure is treated as "not configured", so a
  // flaky probe degrades to a plain input rather than a dead dropdown.
  useEffect(() => {
    let alive = true;
    api.facPlacesStatus()
      .then(r => { if (alive) setConfigured(Boolean(r?.configured)); })
      .catch(() => { if (alive) setConfigured(false); });
    return () => { alive = false; };
  }, []);

  // Close on an outside click.
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const query = String(value ?? '');

  // Debounced lookup. Skipped entirely until we know lookup is available.
  useEffect(() => {
    if (configured !== true) return undefined;
    if (pickingRef.current) { pickingRef.current = false; return undefined; }
    const q = query.trim();
    if (q.length < MIN_CHARS) { setSuggestions([]); setOpen(false); return undefined; }

    const myReq = ++reqIdRef.current;
    const timer = setTimeout(() => {
      if (!sessionRef.current) sessionRef.current = newSessionToken();
      setBusy(true);
      api.facPlacesSuggest({ input: q, sessionToken: sessionRef.current, regionCode })
        .then((r) => {
          if (myReq !== reqIdRef.current) return; // a newer keystroke won
          const list = Array.isArray(r?.suggestions) ? r.suggestions : [];
          setSuggestions(list);
          setActive(-1);
          setOpen(list.length > 0);
        })
        .catch((e) => {
          if (myReq !== reqIdRef.current) return;
          // Lookup is a convenience; a failure must never block typing. Log and
          // go quiet — the field keeps working as free text.
          logger.error('address lookup failed:', e?.message || e);
          setSuggestions([]);
          setOpen(false);
        })
        .finally(() => { if (myReq === reqIdRef.current) setBusy(false); });
    }, DEBOUNCE_MS);

    return () => clearTimeout(timer);
  }, [query, configured, regionCode]);

  const handleChange = useCallback((e) => {
    const next = e.target.value;
    onChange(next);
    // Editing the text invalidates any coordinates we are holding: they belong
    // to the address that WAS there. Better no coordinates than ones silently
    // pointing at a different building.
    if (hasCoords) onPlaceCleared?.();
  }, [onChange, hasCoords, onPlaceCleared]);

  const pick = useCallback(async (s) => {
    if (!s?.placeId) return;
    setOpen(false);
    setSuggestions([]);
    setActive(-1);
    // Show the chosen line immediately; the details call replaces it with
    // Google's canonical formatting a moment later.
    pickingRef.current = true;
    onChange(s.text);
    try {
      setBusy(true);
      const d = await api.facPlaceDetails({ placeId: s.placeId, sessionToken: sessionRef.current || undefined });
      pickingRef.current = true;
      onPlacePicked?.({
        address: d?.formattedAddress || s.text,
        latitude: d?.latitude ?? null,
        longitude: d?.longitude ?? null,
        placeId: d?.placeId || s.placeId,
      });
    } catch (e) {
      // The suggestion text is already in the field, so the underwriter keeps a
      // usable address; only the coordinates are lost.
      logger.error('address details lookup failed:', e?.message || e);
    } finally {
      setBusy(false);
      sessionRef.current = null; // the billable session ends with the pick
    }
  }, [onChange, onPlacePicked]);

  const onKeyDown = useCallback((e) => {
    if (!open || !suggestions.length) {
      if (e.key === 'ArrowDown' && suggestions.length) { setOpen(true); e.preventDefault(); }
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive(i => (i + 1) % suggestions.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive(i => (i <= 0 ? suggestions.length - 1 : i - 1));
    } else if (e.key === 'Enter') {
      // Only swallow Enter when a row is actually highlighted, so Enter with the
      // list merely open still submits/blurs as the user expects.
      if (active >= 0 && active < suggestions.length) {
        e.preventDefault();
        pick(suggestions[active]);
      }
    } else if (e.key === 'Escape') {
      setOpen(false);
      setActive(-1);
    }
  }, [open, suggestions, active, pick]);

  const showList = open && suggestions.length > 0;

  const inputProps = useMemo(() => (configured === true ? {
    role: 'combobox',
    'aria-expanded': showList,
    'aria-controls': listboxId,
    'aria-autocomplete': 'list',
    'aria-activedescendant': showList && active >= 0 ? optionId(active) : undefined,
    autoComplete: 'off',
  } : {}), [configured, showList, listboxId, active]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div ref={wrapRef} style={{ position: 'relative' }}>
      <input
        id={id}
        className={className}
        value={query}
        onChange={handleChange}
        onKeyDown={onKeyDown}
        onFocus={() => { if (suggestions.length) setOpen(true); }}
        placeholder={placeholder}
        {...inputProps}
      />

      {/* Coordinate confirmation. Deliberately quiet — it tells the underwriter
          the address resolved to a point without competing with the field. */}
      {hasCoords && (
        <div style={{ fontSize: 10, color: 'var(--accent)', marginTop: 3 }}>
          📍 Location captured
        </div>
      )}

      {busy && configured === true && (
        <div aria-hidden="true" style={{ position: 'absolute', right: 8, top: 8, fontSize: 10, color: 'rgba(var(--text-rgb),0.45)' }}>…</div>
      )}

      {showList && (
        <ul
          id={listboxId}
          role="listbox"
          aria-label="Address suggestions"
          style={{
            position: 'absolute', zIndex: 50, top: '100%', left: 0, right: 0, marginTop: 2,
            listStyle: 'none', padding: 4, maxHeight: 240, overflowY: 'auto',
            background: 'var(--panel-bg-strong)', border: '1px solid var(--hairline-strong)',
            borderRadius: 10, boxShadow: '0 18px 48px rgba(0,0,0,0.28)',
          }}
        >
          {suggestions.map((s, i) => (
            <li
              key={s.placeId}
              id={optionId(i)}
              role="option"
              aria-selected={i === active}
              onMouseEnter={() => setActive(i)}
              // mousedown, not click: the input's blur would close the list first.
              onMouseDown={(e) => { e.preventDefault(); pick(s); }}
              style={{
                padding: '7px 10px', borderRadius: 6, cursor: 'pointer',
                background: i === active ? 'rgba(var(--accent-rgb),0.12)' : 'transparent',
              }}
            >
              <div style={{ fontSize: 12, color: 'rgba(var(--text-rgb),0.90)' }}>{s.mainText || s.text}</div>
              {s.secondaryText && (
                <div style={{ fontSize: 10, color: 'rgba(var(--text-rgb),0.55)' }}>{s.secondaryText}</div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
