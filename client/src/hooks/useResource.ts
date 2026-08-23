// client/src/hooks/useResource.ts
//
// The one async-state primitive for screens (docs/frontend-hardening.md
// Phase 2). Replaces the per-screen setLoading / try-catch / cancelled-flag
// boilerplate with a single tested implementation so loading, error, and
// stale-response behaviour is uniform everywhere:
//
//   const { data, error, loading, refetch } = useResource(
//     (signal) => api.getDevFactors(contractId, type, { signal }),
//     [contractId, type],
//   );
//
// Guarantees:
//   • In-flight requests are aborted when deps change, when `enabled` flips
//     off, and on unmount — a late response can never clobber newer state.
//   • Errors are reported through the existing errorReporter path
//     (rate-limited + deduped server-side log line), never swallowed.
//   • STALE_WRITE (409 optimistic lock) and PRICING_DRIFT errors are
//     recognised via the shared extractors so every screen surfaces them
//     with the same language (see describeResourceError / AsyncBoundary).
//
// Deliberately dependency-free. If the app outgrows this (request dedupe
// across screens, cache invalidation graphs, pagination), TanStack Query
// slots in here: keep this hook's signature, re-implement it over
// useQuery, and screens never notice.

import { useCallback, useEffect, useRef, useState } from 'react';
import { getStaleWritePayload } from '../utils/handleStaleWrite.js';
import { getPricingDriftPayload, formatPricingDriftMessage } from '../utils/pricingErrors.js';
import { reportError } from '../utils/errorReporter.js';

interface UseResourceOptions {
  /** When false the fetcher never runs and any in-flight request is aborted. */
  enabled?: boolean;
  /** Label attached to the error report so server logs say which resource failed. */
  reportLabel?: string;
}

export interface Resource<T> {
  /** Last successfully loaded value. Kept (stale) while a refetch is in flight. */
  data: T | null;
  error: unknown;
  loading: boolean;
  /** Manually re-run the fetcher (aborts any in-flight run first). */
  refetch: () => Promise<void>;
}

/**
 * Fetch + hold an async resource. `deps` lists the values the fetcher
 * reads (ids, filters); changing them aborts the in-flight request and
 * reloads, exactly like a useEffect dependency array.
 */
export function useResource<T>(
  fetcher: (signal: AbortSignal) => Promise<T>,
  deps: ReadonlyArray<unknown> = [],
  { enabled = true, reportLabel = 'resource' }: UseResourceOptions = {},
): Resource<T> {
  const [state, setState] = useState<{ data: T | null; error: unknown; loading: boolean }>(() => ({
    data: null,
    error: null,
    loading: enabled,
  }));

  // Latest fetcher without making it a dependency — screens pass inline
  // closures; the deps array is the reload contract, not function identity.
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;
  const labelRef = useRef(reportLabel);
  labelRef.current = reportLabel;
  const ctrlRef = useRef<AbortController | null>(null);

  const load = useCallback(async (): Promise<void> => {
    ctrlRef.current?.abort();
    const ctrl = new AbortController();
    ctrlRef.current = ctrl;
    setState((s) => (s.loading && s.error === null ? s : { ...s, loading: true, error: null }));
    try {
      const data = await fetcherRef.current(ctrl.signal);
      if (ctrl.signal.aborted) return; // superseded or unmounted — drop it
      setState({ data, error: null, loading: false });
    } catch (error) {
      if (ctrl.signal.aborted) return; // abort rejections are not failures
      // 'other' (not a new enum value): the server's clientEvents schema
      // rejects unknown types, so the discriminator rides in context.
      reportError('other', error instanceof Error ? error : String(error), {
        source: 'useResource',
        label: labelRef.current,
      });
      setState((s) => ({ ...s, error, loading: false }));
    }
  }, []);

  useEffect(() => {
    if (!enabled) {
      ctrlRef.current?.abort();
      setState((s) => (s.loading ? { ...s, loading: false } : s));
      return;
    }
    void load();
    // The caller-supplied deps array IS the dependency contract here, the
    // same way useEffect's own array works; it cannot be statically listed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, load, ...deps]);

  // Abort whatever is still in flight when the component unmounts.
  useEffect(() => () => ctrlRef.current?.abort(), []);

  return { data: state.data, error: state.error, loading: state.loading, refetch: load };
}

type ResourceErrorKind = 'stale-write' | 'pricing-drift' | 'http' | 'unknown';

interface ResourceErrorInfo {
  kind: ResourceErrorKind;
  /** Human-readable, screen-ready message. */
  message: string;
  /** HTTP status when the failure came from the API client. */
  status?: number;
}

/**
 * Normalize any thrown value into the uniform shape AsyncBoundary (and
 * toasts) render, recognising the two domain error codes that must look
 * the same on every screen: STALE_WRITE and PRICING_DRIFT.
 */
export function describeResourceError(error: unknown): ResourceErrorInfo | null {
  if (!error) return null;

  const stale = getStaleWritePayload(error);
  if (stale) {
    return {
      kind: 'stale-write',
      message: `${stale.message}. Someone else saved a newer version — refresh to load it before editing.`,
    };
  }

  const drift = getPricingDriftPayload(error);
  if (drift) {
    return {
      kind: 'pricing-drift',
      message: formatPricingDriftMessage(error) || drift.message,
    };
  }

  const status = (error as { status?: unknown }).status;
  if (typeof status === 'number' && status > 0) {
    return {
      kind: 'http',
      status,
      message: (error as Error).message || `Request failed (${status})`,
    };
  }

  if (error instanceof Error) return { kind: 'unknown', message: error.message || 'Something went wrong' };
  return { kind: 'unknown', message: String(error) };
}

export default useResource;
