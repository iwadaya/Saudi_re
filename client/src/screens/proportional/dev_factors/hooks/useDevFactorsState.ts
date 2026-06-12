// hooks/useDevFactorsState.ts — all state, effects and persistence for the
// Dev Factors screen (Phase 4.2 decomposition of DevFactorsScreen.jsx).
//
// The orchestrator (DevFactorsScreen.jsx) renders; this hook owns:
//   • every piece of screen state (view / basis / projection / averaging
//     toggles, chosen LDF/CDF sets, exclusions, BF inputs, modal flags, dirty)
//   • the three useResource loads — triangles (primary, hydration inside the
//     fetcher so triData/exclusions land before `loading` flips), the
//     savedTick-keyed staleness probe, and the saved-factors + pricing-pattern
//     side-load with its deliberate quote-mode 404 tolerance
//   • the derived factor pipeline (buildCalcs per basis, BF loss/premium,
//     Munich chain ladder) and save() with its dirty gate + first-save
//     exception + post-save staleness refetch
//
// Every effect body and dependency array was carried over VERBATIM from the
// pre-refactor screen — goldenMaster.test.jsx pins the observable behaviour
// (factor maths, save payloads, banner states) literal-by-literal.

import { useState, useEffect, useRef, useCallback, useMemo, useId } from 'react';
import { api } from '../../../../api';
import { useContractId } from '../../../../hooks/useContractId';
import { useResource, type Resource } from '../../../../hooks/useResource';
import { useAppState } from '../../../../context/AppContext';
import { buildMatrixFromCells } from '../../../../logic/chainLadder';
import { calculateBF, calculateBFPremium } from '../../../../logic/bornhuetterFerguson';
import { calculateMunichChainLadder } from '../../../../logic/munichChainLadder';
import type { TriangleCell, TriangleWithExclusions, DevFactorRow } from '../../../../types/pricing';
import {
  TYPE_MAP, TRIANGLE_SOURCE, buildCalcs, parseNum, sameNumberArray, serializeChosenSource,
} from '../state/devFactorsCalcs';
import type {
  AvgMethod, CalcBundle, ChosenBase, DevFactorsView, ExclusionsSummary,
  FactorValue, ProjMethod, TriangleBasis, TriCellsByType,
} from '../state/devFactorsCalcs';

/* ── Server payload shapes the hook reads (loose on purpose — the API
      client types these endpoints as `unknown`; see api.ts header) ── */

interface StalenessInfo {
  stale?: boolean;
  factorsSavedAt?: string | null;
  triangleUpdatedAt?: string | null;
  [extra: string]: unknown;
}

interface SavedSelectedFactors {
  excluded_ratios?: unknown;
  excluded_for_year_window?: string;
  proj_method?: string;
  chosen_base?: string;
  use_munich?: unknown;
  bf_percent_achieved?: unknown;
  bf_epi_per_year?: unknown;
  [extra: string]: unknown;
}

interface SavedPricingPattern {
  selected_factors?: SavedSelectedFactors | null;
  selection_method?: string | null;
  bf_ielr?: unknown;
  [extra: string]: unknown;
}

export interface BenchmarkRow { ldf: number | null; [extra: string]: unknown }
export interface BenchmarkSet {
  country?: BenchmarkRow[];
  region?: BenchmarkRow[];
  all?: BenchmarkRow[];
  [extra: string]: unknown;
}

interface MclProjectionRow {
  year: number | string;
  latestPaid: number;
  latestIncurred: number;
  ultimatePaid: number;
  ultimateIncurred: number;
  ibnrPaid: number;
  ibnrIncurred: number;
  [extra: string]: unknown;
}

export interface MclResult {
  lambdaP: number | null;
  lambdaI: number | null;
  projections: MclProjectionRow[];
  warnings?: string[];
  [extra: string]: unknown;
}

type TriDataByType = Record<string, { full: TriangleCell[]; stripped: TriangleCell[] }>;

export interface DevFactorsState {
  /* identity / window */
  contractId: string | null;
  devType: string;
  isIncurred: boolean;
  isPremium: boolean;
  startYear: number | null;
  inceptionYear: number;
  numDevYears: number;
  years: number[];
  /* basis (persisted per treaty via AppContext + setStripLargeCat) */
  stripLargeCat: boolean;
  basis: TriangleBasis;
  setBasis: (next: TriangleBasis) => void;
  /* toggles */
  view: DevFactorsView;
  setView: (v: DevFactorsView) => void;
  projMethod: ProjMethod;
  selectProjMethod: (m: ProjMethod) => void;
  avgMethod: AvgMethod;
  selectAvgMethod: (m: AvgMethod) => void;
  /* loads */
  triangles: Resource<TriDataByType>;
  exclusions: ExclusionsSummary;
  stale: boolean;
  /* derived factor pipeline */
  calcs: CalcBundle | null;
  fullCalcs: CalcBundle | null;
  strippedCalcs: CalcBundle | null;
  hasData: boolean;
  benchmarks: BenchmarkSet | null;
  /* chosen factors */
  chosenBase: ChosenBase;
  chosenLdfs: FactorValue[];
  chosenCdfs: FactorValue[];
  handleChosenChange: (type: 'ldf' | 'cdf', idx: number, val: string) => void;
  switchBase: (base: ChosenBase) => void;
  /* link-ratio exclusions */
  excluded: Set<string>;
  handleLinkRatioExcludedChange: (value: Set<string> | ((prev: Set<string>) => Set<string>)) => void;
  applyLinkRatioPattern: (filteredLdfs: number[], filteredCdfs: number[]) => void;
  /* BF (loss) */
  ielr: string;
  changeIelr: (value: string) => void;
  ielrInputId: string;
  bfResults: ReturnType<typeof calculateBF> | null;
  /* BF (premium) */
  percentAchieved: string;
  changePercentAchieved: (value: string) => void;
  achievedPremiumInputId: string;
  epiPerYear: string[];
  changeEpi: (index: number, value: string) => void;
  suggestedPercentAchieved: number | null;
  applySuggestedPercentAchieved: () => void;
  bfPremiumResults: ReturnType<typeof calculateBFPremium> | null;
  /* Munich chain ladder */
  munichAvailable: boolean;
  useMunich: boolean;
  toggleMunich: (checked: boolean) => void;
  showMunichHelp: boolean;
  toggleMunichHelp: () => void;
  mclResult: MclResult | null;
  /* banners + modal */
  showZeroLossWarning: boolean;
  dismissLossWarning: () => void;
  showStrippedBanner: boolean;
  showStrippedModal: boolean;
  setShowStrippedModal: (open: boolean) => void;
  /* persistence */
  dirty: boolean;
  save: () => Promise<boolean>;
}

export function useDevFactorsState(routeKey: string): DevFactorsState {
  const contractId = useContractId();
  const { state: appState, setSlice } = useAppState();
  const devType = TYPE_MAP[routeKey] || 'PREMIUM';
  const triSources = useMemo(() => TRIANGLE_SOURCE[routeKey] || ['PREMIUM'], [routeKey]);
  const isIncurred = devType === 'INCURRED';
  const isPremium = devType === 'PREMIUM';

  const meta = appState.triangleMeta || {};
  const startYear: number | null = meta.startYear ?? null;
  const inceptionYear: number = meta.inceptionYear || meta.renewalYear || new Date().getFullYear();
  // `?? 0` mirrors the original `inceptionYear - startYear` arithmetic, where
  // a null startYear coerced to 0 — behaviour, including the 60 cap, is identical.
  const numDevYears = Math.max(1, Math.min(60, inceptionYear - (startYear ?? 0)));
  const years = useMemo(
    () => Array.from({ length: numDevYears }, (_, i) => (startYear ?? 0) + i),
    [numDevYears, startYear],
  );
  // Quote-mode opts thread through every triangle/dev-factor API call
  // so the wizard can edit a quote's factors without hitting the
  // contract path (which would FK-fail under migration 057).
  const apiOpts = useMemo(
    () => (appState.quoteMode ? { quote: true as const } : undefined),
    [appState.quoteMode],
  );

  const [view, setView] = useState<DevFactorsView>('DEV_FACTORS');
  // Triangle basis is a persisted per-treaty choice: STRIPPED (the attritional
  // basis — strip large/cat) or FULL (use original data, which also folds
  // large/cat into attritional on the summaries). FULL is now the default —
  // the underwriter imports pre-stripped triangles, so stripping is opt-in.
  // The basis is derived from the saved strip_large_cat_losses flag (default
  // false → FULL) and written through on toggle.
  const stripLargeCat = appState.propTreatyDetail?.stripLargeCat === true;
  const basis: TriangleBasis = stripLargeCat ? 'STRIPPED' : 'FULL';
  const setBasis = (next: TriangleBasis): void => {
    const strip = next === 'STRIPPED';
    setSlice('propTreatyDetail', { ...(appState.propTreatyDetail || {}), stripLargeCat: strip });
    api.setStripLargeCat(contractId, strip, apiOpts).catch(() => {});
  };
  // Per-type { full: cells[], stripped: cells[] } from the with-exclusions
  // endpoint. Both variants are always fetched so the conservative
  // (full-basis) reference column is available regardless of the basis shown.
  const [triData, setTriData] = useState<TriDataByType>({});
  // Munich Chain Ladder needs the paid and OS legs separately (full only — MCL
  // does not use stripped data). The Incurred screen now sources a single
  // combined INCURRED triangle, so fetch paid + OS here just for MCL.
  const [mclCells, setMclCells] = useState<Record<string, TriangleCell[]>>({ CLAIMS_PAID: [], CLAIMS_OS: [] });
  const [exclusions, setExclusions] = useState<ExclusionsSummary>({ largeLossCount: 0, catLossCount: 0, applies: false, proxyPlaced: 0 });
  const [lossWarningDismissed, setLossWarningDismissed] = useState(false);
  const [projMethod, setProjMethod] = useState<ProjMethod>('CHAIN');
  const [avgMethod, setAvgMethod] = useState<AvgMethod>('weighted');
  const [chosenBase, setChosenBase] = useState<ChosenBase>('ACTUAL');
  const [chosenLdfs, setChosenLdfs] = useState<FactorValue[]>([]);
  const [chosenCdfs, setChosenCdfs] = useState<FactorValue[]>([]);
  const ielrInputId = useId();
  const achievedPremiumInputId = useId();
  const [ielr, setIelr] = useState('0.65');
  const [premiums, setPremiums] = useState<number[]>([]);
  // Premium-flavoured BF inputs — used when devType === 'PREMIUM'.
  // EPI is the client's start-of-year premium estimate, % Achieved is the
  // ratio of actual to estimated premium (default 100 %).
  const [epiPerYear, setEpiPerYear] = useState<string[]>([]);
  const [percentAchieved, setPercentAchieved] = useState('1.00');
  const [dirty, setDirty] = useState(false);
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const [benchmarks, setBenchmarks] = useState<BenchmarkSet | null>(null);
  const [useMunich, setUseMunich] = useState(false);
  const [showMunichHelp, setShowMunichHelp] = useState(false);
  const [showStrippedModal, setShowStrippedModal] = useState(false);
  const [savedTick, setSavedTick] = useState(0);
  // Both paid + OS triangles are required for Munich Chain Ladder, so on
  // screens that already source both (Incurred Dev Factors) the toggle
  // does meaningful work. On Premium / Paid-only / OS-only screens we
  // still surface the checkbox so the underwriter can see it exists,
  // but mark it disabled and point them at the right screen.
  const munichAvailable = isIncurred;

  /* Clear position-keyed exclusions when the year range changes.
   * Excluded ratios are stored as "row:col" strings, so when startYear or
   * numDevYears shifts the same key reinterprets to a totally different
   * cell — the table keeps a strikethrough on a cell the user never
   * clicked. Drop them whenever the year window moves. The first render
   * is skipped so loaded saved exclusions survive their initial hydration. */
  const yearWindowKeyRef = useRef<string | null>(null);
  useEffect(() => {
    const key = `${startYear}:${numDevYears}`;
    if (yearWindowKeyRef.current === null) { yearWindowKeyRef.current = key; return; }
    if (yearWindowKeyRef.current !== key) {
      yearWindowKeyRef.current = key;
      setExcluded(new Set());
    }
  }, [startYear, numDevYears]);

  /* Load triangle cells — both full + stripped variants for every source.
     This is the screen's PRIMARY load (it gates the factor tables below), so
     it rides useResource: in-flight requests abort when the contract/type
     changes or the screen unmounts, failures surface in the <AsyncBoundary>
     with a Retry, and hydration happens inside the fetcher — triData /
     exclusions are set before `loading` flips off, exactly like the old
     .then(setTriData).finally(setLoading(false)) ordering. */
  const triangles = useResource<TriDataByType>(
    async (signal) => {
      const results = await Promise.all(triSources.map(t =>
        api.getTriangleWithExclusions(contractId as string, t, { ...apiOpts, signal })
          .then((d): [string, { full: TriangleCell[]; stripped: TriangleCell[]; excl: TriangleWithExclusions['exclusions'] | null }] => [t, {
            full: d?.full?.cells || [],
            stripped: d?.stripped?.cells || [],
            excl: d?.exclusions || null,
          }]),
      ));
      const map: TriDataByType = {};
      let excl: ExclusionsSummary = { largeLossCount: 0, catLossCount: 0, applies: false, proxyPlaced: 0 };
      results.forEach(([t, data]) => {
        map[t] = { full: data.full, stripped: data.stripped };
        // Loss counts are contract-wide (identical across types); fold to be safe.
        if (data.excl) {
          excl = {
            largeLossCount: Math.max(excl.largeLossCount, data.excl.largeLossCount || 0),
            catLossCount: Math.max(excl.catLossCount, data.excl.catLossCount || 0),
            applies: excl.applies || !!data.excl.applies,
            proxyPlaced: Math.max(excl.proxyPlaced, data.excl.proxyPlaced || 0),
          };
        }
      });
      if (signal.aborted) return map; // superseded/unmounted — don't hydrate
      setTriData(map);
      setExclusions(excl);
      return map;
    },
    [contractId, apiOpts, triSources],
    { enabled: !!contractId, reportLabel: 'dev factor triangles' },
  );

  /* Load the paid + OS legs (full only) for Munich Chain Ladder. Only the
     Incurred screen offers MCL, and it no longer fetches paid/OS via the
     combined INCURRED source, so pull them separately here. */
  useEffect(() => {
    if (!contractId || !isIncurred) return;
    const pickCells = (d: unknown): TriangleCell[] => {
      const r = d as { cells?: TriangleCell[] } | TriangleCell[] | null | undefined;
      return (r as { cells?: TriangleCell[] } | null | undefined)?.cells || (Array.isArray(r) ? r : []);
    };
    Promise.all([
      api.getTriangle(contractId, 'CLAIMS_PAID', apiOpts).then(pickCells).catch((): TriangleCell[] => []),
      api.getTriangle(contractId, 'CLAIMS_OS', apiOpts).then(pickCells).catch((): TriangleCell[] => []),
    ]).then(([paid, os]) => setMclCells({ CLAIMS_PAID: paid, CLAIMS_OS: os }));
  }, [contractId, isIncurred, apiOpts]);

  // Cells for the basis currently shown, and always-full cells for the
  // conservative reference. `calcs` reads triCells so it recomputes when
  // the basis toggles.
  const triCells = useMemo<TriCellsByType>(() => {
    const map: TriCellsByType = {};
    for (const t of triSources) {
      const d = triData[t];
      map[t] = d ? (basis === 'STRIPPED' ? d.stripped : d.full) : [];
    }
    return map;
  }, [triData, triSources, basis]);
  const fullTriCells = useMemo<TriCellsByType>(() => {
    const map: TriCellsByType = {};
    for (const t of triSources) map[t] = triData[t]?.full || [];
    return map;
  }, [triData, triSources]);
  // Always-stripped cells (large + cat removed), used by the comparison modal
  // regardless of the basis currently shown on screen.
  const strippedTriCells = useMemo<TriCellsByType>(() => {
    const map: TriCellsByType = {};
    for (const t of triSources) map[t] = triData[t]?.stripped || [];
    return map;
  }, [triData, triSources]);

  /* Load premium data for BF */
  useEffect(() => {
    if (!contractId) return;
    api.getTriangle(contractId, 'PREMIUM', apiOpts).then(d => {
      const cells: TriangleCell[] = d?.cells || (Array.isArray(d) ? (d as TriangleCell[]) : []);
      const prems = years.map(yr => { const latest = cells.filter(c => c.origin_year === yr).sort((a, b) => b.dev_months - a.dev_months)[0]; return latest ? Number(latest.cum_value) || 0 : 0; });
      setPremiums(prems);
    }).catch(() => {});
  }, [contractId, startYear, numDevYears, apiOpts, years]);

  /* Load benchmarks */
  useEffect(() => {
    const countryId = appState.propTreatyDetail?.countryId;
    if (!countryId) return;
    api.getBenchmarks(countryId, devType).then((d) => setBenchmarks(d as BenchmarkSet | null)).catch(() => {});
  }, [appState.propTreatyDetail?.countryId, devType]);

  /* Staleness + never-saved: were the source triangles saved after these
     factors, and have any factors been saved for this type at all?
     useResource replaces the old hand-rolled cancelled flag; `savedTick` in
     the deps re-fetches after a successful save so the banner reflects
     server ground truth rather than an optimistic local clear. A failed
     fetch keeps the previous data (banner state), matching the old
     swallow-and-keep behaviour. */
  const stalenessRes = useResource<{ d: StalenessInfo | null }>(
    (signal) => api.getDevFactorStaleness(contractId as string, devType, { ...apiOpts, signal })
      // Wrap so `data` is non-null once ANY response has arrived — the
      // derived flags below must stay at their pre-fetch defaults (false)
      // until then, exactly like the old setState-on-success effect.
      .then(d => ({ d: d as StalenessInfo | null })),
    [contractId, devType, apiOpts, savedTick],
    { enabled: !!contractId, reportLabel: 'dev factor staleness' },
  );
  // True when the source triangle has been saved more recently than these
  // factors — the underwriter should re-review.
  const stale = !!stalenessRes.data?.d?.stale;
  // True when no factors have ever been saved for this type — the projected
  // summary / pricing then rest on placeholder curves until a selection is saved.
  const factorsNeverSaved = !!stalenessRes.data && !stalenessRes.data.d?.factorsSavedAt;

  /* Build matrix + calculations for the displayed basis, plus the full
     (unstripped) basis used for the conservative reference column. */
  const calcParams = useMemo(
    () => ({ triSources, startYear, numDevYears, avgMethod, years, excluded }),
    [triSources, startYear, numDevYears, avgMethod, years, excluded],
  );
  const calcs = useMemo(() => buildCalcs(triCells, calcParams), [triCells, calcParams]);
  const fullCalcs = useMemo(() => buildCalcs(fullTriCells, calcParams), [fullTriCells, calcParams]);
  const strippedCalcs = useMemo(() => buildCalcs(strippedTriCells, calcParams), [strippedTriCells, calcParams]);

  const bfResults = useMemo(() => {
    if (!calcs?.clProjections || projMethod !== 'BF' || isPremium) return null;
    return calculateBF(calcs.clProjections, premiums, Number(ielr) || 0);
  }, [calcs, projMethod, premiums, ielr, isPremium]);

  /* Munich Chain Ladder — needs both the paid and incurred (paid + OS)
     matrices, with the paid leg separate. Uses the full paid/OS legs fetched
     into `mclCells` (MCL never runs on stripped data). */
  const mclResult = useMemo<MclResult | null>(() => {
    if (!useMunich || projMethod !== 'CHAIN' || !munichAvailable) return null;
    const paidObj = buildMatrixFromCells(mclCells['CLAIMS_PAID'] || [], startYear, numDevYears);
    const osObj   = buildMatrixFromCells(mclCells['CLAIMS_OS']   || [], startYear, numDevYears);
    if (!paidObj || !osObj) return null;
    const incurred = paidObj.matrix.map((row: Array<number | null>, r: number) =>
      row.map((v, c) => {
        const p = v, o = osObj.matrix[r]?.[c];
        return (p == null && o == null) ? null : (p ?? 0) + (o ?? 0);
      }),
    );
    return calculateMunichChainLadder({ paid: paidObj.matrix, incurred, years }) as MclResult;
  }, [useMunich, projMethod, munichAvailable, mclCells, startYear, numDevYears, years]);

  // Keep epiPerYear in sync with the year window. When the window
  // shifts, pad/trim so input cells line up with displayed years.
  useEffect(() => {
    if (!isPremium) return;
    setEpiPerYear((prev) => {
      if (prev.length === years.length) return prev;
      const next = years.map((_, i) => prev[i] ?? '');
      return next;
    });
  }, [isPremium, years, years.length]);

  // Auto-suggest % achieved from observed premium vs EPI across past
  // years that have both an EPI and a current premium > 0. The user
  // can still override via the input — we only seed when the field is
  // still at the 1.00 default.
  const suggestedPercentAchieved = useMemo<number | null>(() => {
    if (!isPremium) return null;
    const ratios: number[] = [];
    for (let i = 0; i < years.length; i++) {
      const epi = parseNum(epiPerYear[i]);
      const cur = premiums[i] || 0;
      if (epi > 0 && cur > 0) ratios.push(cur / epi);
    }
    if (!ratios.length) return null;
    return ratios.reduce((a, b) => a + b, 0) / ratios.length;
  }, [isPremium, years.length, epiPerYear, premiums]);

  const clProjections = calcs?.clProjections;
  const bfPremiumResults = useMemo(() => {
    if (!clProjections || projMethod !== 'BF' || !isPremium) return null;
    const epis = years.map((_, i) => parseNum(epiPerYear[i]));
    const pa = Number(percentAchieved);
    return calculateBFPremium(clProjections, epis, Number.isFinite(pa) ? pa : 1);
  }, [clProjections, projMethod, isPremium, years, percentAchieved, epiPerYear]);

  /* Init chosen — only seed from computed factors when chosenLdfs is
     genuinely empty. The prior `length !== src.ldfs.length` test fired on
     a length mismatch too, which silently overwrote saved underwriter
     overrides whenever the year window had shifted between sessions
     (saved with N=8 → reopened with N=10). Explicit base toggles still
     re-seed via switchBase below, so we only need to populate on the
     initial empty render. */
  useEffect(() => {
    if (!calcs) return;
    if (chosenLdfs.length > 0) return;
    const src = chosenBase === 'PARAM' ? { ldfs: calcs.paramLdfs, cdfs: calcs.paramCdfs } : { ldfs: calcs.pattern, cdfs: calcs.cdfs };
    if (!src.ldfs?.length) return;
    setChosenLdfs(src.ldfs.map(v => v));
    setChosenCdfs((src.cdfs || []).slice(0, src.ldfs.length).map(v => v));
  }, [calcs, chosenBase, chosenLdfs.length]);

  /* Load saved factors + pricing pattern (excluded ratios + settings).
     Rides useResource so a superseded response can never hydrate over a
     newer contract/type's state. Each call keeps its own failure tolerance
     (resolve to null) on purpose: a missing pricing pattern is normal in
     quote mode (the endpoint is contract-only) and neither load should
     block the screen — the factor tables still render from triangle data. */
  useResource(
    async (signal) => {
      const [factorsData, patternData] = await Promise.all([
        api.getDevFactors(contractId as string, devType, { ...apiOpts, signal }).catch(() => null),
        api.getPricingPattern(contractId as string, devType).catch(() => null) as Promise<SavedPricingPattern | null>,
      ]);
      if (signal.aborted) return { factorsData, patternData }; // superseded/unmounted — don't hydrate
      const factorsRaw = factorsData as { factors?: DevFactorRow[] } | DevFactorRow[] | null;
      const factors: DevFactorRow[] = (factorsRaw as { factors?: DevFactorRow[] } | null)?.factors
        || (Array.isArray(factorsRaw) ? factorsRaw : []);
      if (factors.length > 0) { setChosenLdfs(factors.map(f => f.chosen_ldf ?? f.selected_ldf ?? null)); setChosenCdfs(factors.map(f => f.chosen_cdf ?? f.selected_cdf ?? null)); }
      // chosenBase stays at its initial 'ACTUAL' — the toggle is reset on every
      // page-land so the underwriter always starts from a known baseline.
      if (patternData) {
        const sf: SavedSelectedFactors = patternData.selected_factors || {};
        if (Array.isArray(sf.excluded_ratios) && sf.excluded_ratios.length > 0) {
          // Position-keyed ("r:c") exclusions are only valid for the year
          // window they were saved under. If the user has since shifted the
          // start year or the number of dev years, those keys would silently
          // strike through different cells. Drop them in that case.
          const currentKey = `${startYear}:${numDevYears}`;
          if (!sf.excluded_for_year_window || sf.excluded_for_year_window === currentKey) {
            setExcluded(new Set(sf.excluded_ratios as string[]));
          }
        }
        if (sf.proj_method) setProjMethod(sf.proj_method as ProjMethod);
        // Intentionally do not restore sf.chosen_base — the toggle always
        // re-defaults to ACTUAL on page land. Saved chosenLdfs still load above.
        if (typeof sf.use_munich === 'boolean') setUseMunich(sf.use_munich);
        if (patternData.selection_method) setAvgMethod(patternData.selection_method.toLowerCase() as AvgMethod);
        if (patternData.bf_ielr != null && Number(patternData.bf_ielr) > 0) setIelr(String(patternData.bf_ielr));
        if (sf.bf_percent_achieved != null) setPercentAchieved(String(sf.bf_percent_achieved));
        if (Array.isArray(sf.bf_epi_per_year) && sf.bf_epi_per_year.length > 0) {
          setEpiPerYear(sf.bf_epi_per_year.map((v: unknown) => v == null ? '' : String(v)));
        }
      }
      return { factorsData, patternData };
    },
    [contractId, devType, apiOpts, startYear, numDevYears],
    { enabled: !!contractId, reportLabel: 'saved dev factors' },
  );

  const handleChosenChange = (type: 'ldf' | 'cdf', idx: number, val: string): void => {
    const n = val === '' ? null : Number(val);
    if (type === 'ldf') setChosenLdfs(prev => { const a = [...prev]; a[idx] = (n != null && Number.isFinite(n)) ? n : prev[idx]; return a; });
    else setChosenCdfs(prev => { const a = [...prev]; a[idx] = (n != null && Number.isFinite(n)) ? n : prev[idx]; return a; });
    setDirty(true);
  };

  const switchBase = (base: ChosenBase): void => {
    if (base === 'LINK_RATIO') return; // Link ratio base is set only from the Link Ratios tab
    setChosenBase(base);
    if (!calcs) return;
    const src = base === 'PARAM' ? { ldfs: calcs.paramLdfs, cdfs: calcs.paramCdfs } : { ldfs: calcs.pattern, cdfs: calcs.cdfs };
    setChosenLdfs((src.ldfs || []).map(v => v)); setChosenCdfs((src.cdfs || []).slice(0, src.ldfs?.length || 0).map(v => v)); setDirty(true);
  };

  const handleLinkRatioExcludedChange = useCallback((value: Set<string> | ((prev: Set<string>) => Set<string>)) => {
    setExcluded(value);
    setDirty(true);
  }, []);

  const applyLinkRatioPattern = useCallback((filteredLdfs: number[], filteredCdfs: number[]) => {
    setChosenLdfs(prev => sameNumberArray(prev, filteredLdfs) ? prev : filteredLdfs.map(v => v));
    setChosenCdfs(prev => sameNumberArray(prev, filteredCdfs) ? prev : filteredCdfs.map(v => v));
    setChosenBase(prev => prev === 'LINK_RATIO' ? prev : 'LINK_RATIO');
    setDirty(true);
  }, []);

  const save = useCallback(async (): Promise<boolean> => {
    if (!contractId) return false;
    /* Skip the server round-trip when the user hasn't actually edited
       anything on this screen — otherwise every Back/Next click rewrites
       contract_dev_factor + contract_pricing_patterns and stamps an audit
       row, even when the on-screen factors are unchanged from the saved
       values. Mirrors the same dirty-gate TriangleScreen and useScreenSave
       use. Exception: when no factors have ever been saved for this type,
       persist the currently-displayed selection on the way out so the
       underwriter doesn't have to click Save explicitly. */
    if (!dirty && !(factorsNeverSaved && chosenLdfs.length > 0)) return true;
    const N = chosenLdfs.length;
    const factors = Array.from({ length: N }, (_, i) => ({
      dev_month: (i + 1) * 12, actual_ldf: calcs?.pattern?.[i] ?? null, actual_cdf: calcs?.cdfs?.[i] ?? null,
      parametrized_ldf: calcs?.paramLdfs?.[i] ?? null, parametrized_cdf: calcs?.paramCdfs?.[i] ?? null,
      chosen_source: serializeChosenSource(chosenBase), chosen_ldf: chosenLdfs[i] ?? null, chosen_cdf: chosenCdfs[i] ?? null,
      selected_ldf: chosenLdfs[i] ?? null, selected_cdf: chosenCdfs[i] ?? null,
    }));
    await api.saveDevFactors(contractId, devType, { factors, method: avgMethod, tail_factor: 1.0, basis: basis === 'STRIPPED' ? 'stripped' : 'full' }, apiOpts);
    // Pricing-pattern is contract-only on the server. In quote mode we
    // skip it rather than 404 — the dev factors themselves still save.
    if (!appState.quoteMode) {
      await api.savePricingPattern(contractId, devType, {
        selection_method: avgMethod.toUpperCase(), tail_factor: 1.0, bf_ielr: Number(ielr) || 0,
        selected_factors: {
          chosen_ldfs: chosenLdfs, chosen_cdfs: chosenCdfs, chosen_base: chosenBase,
          proj_method: projMethod, excluded_ratios: [...excluded],
          use_munich: !!useMunich,
          // Year window the position-keyed exclusions are valid for.
          excluded_for_year_window: `${startYear}:${numDevYears}`,
          ...(isPremium ? {
            bf_percent_achieved: Number(percentAchieved) || 1,
            bf_epi_per_year: years.map((_, i) => parseNum(epiPerYear[i])),
          } : {}),
        },
      });
    }
    setDirty(false);
    setSavedTick(t => t + 1); // re-fetch staleness from the DB (ground truth)
    return true;
  }, [contractId, dirty, factorsNeverSaved, chosenLdfs, devType, avgMethod, apiOpts, appState.quoteMode, calcs?.pattern, calcs?.cdfs, calcs?.paramLdfs, calcs?.paramCdfs, chosenBase, chosenCdfs, ielr, projMethod, excluded, useMunich, startYear, numDevYears, isPremium, percentAchieved, years, epiPerYear, basis]);

  /* ── Composed UI callbacks (statement-for-statement copies of the
        orchestrator's old inline handlers) ── */
  const selectProjMethod = (m: ProjMethod): void => { setProjMethod(m); setDirty(true); };
  const selectAvgMethod = (m: AvgMethod): void => { setAvgMethod(m); setDirty(true); };
  const changeIelr = (value: string): void => { setIelr(value); setDirty(true); };
  const changePercentAchieved = (value: string): void => { setPercentAchieved(value); setDirty(true); };
  const applySuggestedPercentAchieved = (): void => {
    if (suggestedPercentAchieved == null) return;
    setPercentAchieved(suggestedPercentAchieved.toFixed(4)); setDirty(true);
  };
  const changeEpi = (i: number, v: string): void => {
    setEpiPerYear((prev) => { const a = [...prev]; a[i] = v; return a; });
    setDirty(true);
  };
  const toggleMunich = (checked: boolean): void => { setUseMunich(checked); setDirty(true); };
  const toggleMunichHelp = (): void => setShowMunichHelp(s => !s);
  const dismissLossWarning = (): void => setLossWarningDismissed(true);

  const hasData = !!(calcs && calcs.pattern?.length > 0);
  const totalLossCount = (exclusions.largeLossCount || 0) + (exclusions.catLossCount || 0);
  const stripApplies = !isPremium && exclusions.applies;
  const showStrippedBanner = stripApplies && basis === 'STRIPPED' && totalLossCount > 0;
  // Surface the "no losses identified" nudge only when this is a claims
  // screen that actually has triangle data to price against.
  const showZeroLossWarning = !lossWarningDismissed && !isPremium && hasData && totalLossCount === 0;

  return {
    contractId, devType, isIncurred, isPremium,
    startYear, inceptionYear, numDevYears, years,
    stripLargeCat, basis, setBasis,
    view, setView,
    projMethod, selectProjMethod,
    avgMethod, selectAvgMethod,
    triangles, exclusions, stale,
    calcs, fullCalcs, strippedCalcs, hasData, benchmarks,
    chosenBase, chosenLdfs, chosenCdfs, handleChosenChange, switchBase,
    excluded, handleLinkRatioExcludedChange, applyLinkRatioPattern,
    ielr, changeIelr, ielrInputId, bfResults,
    percentAchieved, changePercentAchieved, achievedPremiumInputId,
    epiPerYear, changeEpi, suggestedPercentAchieved, applySuggestedPercentAchieved,
    bfPremiumResults,
    munichAvailable, useMunich, toggleMunich, showMunichHelp, toggleMunichHelp, mclResult,
    showZeroLossWarning, dismissLossWarning, showStrippedBanner,
    showStrippedModal, setShowStrippedModal,
    dirty, save,
  };
}

export default useDevFactorsState;
