// DevFactorsScreen.jsx — Dev Factors screen orchestrator (Phase 4.2).
//
// All state, the three useResource loads (triangles primary with
// hydration-inside-fetcher, savedTick-keyed staleness, saved-factors +
// pricing-pattern side-load with its quote-mode 404 tolerance), the factor
// pipeline (chain ladder / BF / Munich) and save() live in
// hooks/useDevFactorsState.ts; pure calc helpers and shared types in
// state/devFactorsCalcs.ts. This file only routes between the three views
// (Dev Factors / Link Ratios / Comparison Graph) and wires the
// presentational islands in components/.
//
// The selection maths and both save payloads are pinned literal-by-literal
// in goldenMaster.test.jsx — keep it green when touching anything here.
import WizardLayout from '../../../components/WizardLayout';
import AsyncBoundary from '../../../components/AsyncBoundary';
import { useDevFactorsState } from './hooks/useDevFactorsState';
import { AVG_METHOD_LABEL } from './state/devFactorsCalcs';
import FactorTable from './components/FactorTable';
import LinkRatioView from './components/LinkRatioView';
import ComparisonGraph from './components/ComparisonGraph';
import StrippedTriangleModal from './components/StrippedTriangleModal';
import { BasisToggleBar, MetaToolbar, ViewToggle, AvgMethodToggle } from './components/TogglesToolbar';
import { BfIelrBar, BfPremiumAchievedBar, BFProjectionsTable, BFPremiumProjectionsTable } from './components/BfPanels';
import { MunichToggleCard, MclProjectionsTable } from './components/MclPanels';

/* ═══════════════════════════════════════════
   MAIN DevFactorsScreen
   ═══════════════════════════════════════════ */
export default function DevFactorsScreen({ routeKey, title, headerPill }) {
  const {
    isIncurred, isPremium,
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
  } = useDevFactorsState(routeKey);

  // triangleMeta not yet loaded (e.g. just after a hard reset, before
  // PropTreatyDetail re-fetches the contract). Avoid rendering with a bogus year range.
  // Guard must stay after all hooks — Rules of Hooks.
  if (!startYear) return <WizardLayout routeKey={routeKey} title={title} headerPill={headerPill}><div style={{ padding: 32, color: 'rgba(255,255,255,0.5)' }}>Loading…</div></WizardLayout>;

  return (
    <WizardLayout routeKey={routeKey} title={title} headerPill={headerPill} onBeforeNext={save} onBeforeBack={save}>
      {({ showToast, wizard }) => (
        <div className="DEV_FACTORS_PAGE">
          {/* Staleness — triangle saved more recently than these factors */}
          {stale && (
            <div role="alert" style={{ margin: '0 0 12px', padding: '10px 14px', borderRadius: 10, background: 'rgba(251,146,60,0.08)', border: '1px solid rgba(251,146,60,0.30)', color: '#fbbf24', fontSize: 12, lineHeight: 1.5 }}>
              Triangle updated since factors were last saved — consider reviewing dev factors.
            </div>
          )}
          {/* Zero-loss warning — no large/cat losses identified yet */}
          {showZeroLossWarning && (
            <div role="alert" style={{ margin: '0 0 12px', padding: '10px 14px', borderRadius: 10, background: 'rgba(251,146,60,0.08)', border: '1px solid rgba(251,146,60,0.30)', color: '#fbbf24', fontSize: 12, lineHeight: 1.5, display: 'flex', alignItems: 'flex-start', gap: 12 }}>
              <div style={{ flex: 1 }}>
                No large losses or cat losses have been identified. Consider reviewing the Large Loss and Cat Loss screens before finalising factors.
                <div style={{ marginTop: 8 }}>
                  <button type="button" onClick={() => wizard?.goTo?.('PROP_LARGE_LOSS_LIST')} style={{ fontSize: 11, padding: '4px 10px', borderRadius: 6, cursor: 'pointer', border: '1px solid rgba(251,146,60,0.4)', background: 'rgba(251,146,60,0.10)', color: '#fbbf24' }}>
                    Go to Large Loss screen →
                  </button>
                </div>
              </div>
              <button type="button" aria-label="Dismiss warning" onClick={dismissLossWarning} style={{ background: 'none', border: 'none', color: '#fbbf24', cursor: 'pointer', fontSize: 16, lineHeight: 1 }}>×</button>
            </div>
          )}

          {/* Triangle basis toggle — persisted per treaty. Claims screens only;
              premium isn't reduced by losses. */}
          {!isPremium && (
            <BasisToggleBar
              basis={basis}
              onSetBasis={setBasis}
              isIncurred={isIncurred}
              onShowStrippedModal={() => setShowStrippedModal(true)}
            />
          )}

          {/* Stripped-mode info banner */}
          {showStrippedBanner && (
            <div role="status" style={{ margin: '0 0 12px', padding: '10px 14px', borderRadius: 10, background: 'rgba(34,197,94,0.07)', border: '1px solid rgba(34,197,94,0.25)', color: '#86efac', fontSize: 12, lineHeight: 1.5 }}>
              {exclusions.largeLossCount} large loss{exclusions.largeLossCount === 1 ? '' : 'es'} and {exclusions.catLossCount} cat loss{exclusions.catLossCount === 1 ? '' : 'es'} have been excluded from this triangle. Selected factors reflect the underlying attritional experience.
              {exclusions.proxyPlaced > 0 && (
                <div style={{ marginTop: 6, color: '#fbbf24' }}>
                  ⚠ {exclusions.proxyPlaced} loss{exclusions.proxyPlaced === 1 ? '' : 'es'} placed by loss date (actuarial reported date not set) — their development period is an estimate. Set a reported date on the loss screens to place them precisely.
                </div>
              )}
            </div>
          )}

          {/* Meta bar + projection method */}
          <MetaToolbar
            startYear={startYear}
            inceptionYear={inceptionYear}
            numDevYears={numDevYears}
            projMethod={projMethod}
            onSelectProjMethod={selectProjMethod}
          />

          {/* Munich Chain Ladder toggle — only meaningful while Chain Ladder
              is the active projection method. */}
          {projMethod === 'CHAIN' && (
            <MunichToggleCard
              munichAvailable={munichAvailable}
              useMunich={useMunich}
              onToggleMunich={toggleMunich}
              showMunichHelp={showMunichHelp}
              onToggleHelp={toggleMunichHelp}
              mclResult={mclResult}
            />
          )}

          {/* BF IELR (loss BF) */}
          {projMethod === 'BF' && !isPremium && (
            <BfIelrBar inputId={ielrInputId} ielr={ielr} onIelrChange={changeIelr} />
          )}

          {/* BF % Achieved Premium (premium BF) */}
          {projMethod === 'BF' && isPremium && (
            <BfPremiumAchievedBar
              inputId={achievedPremiumInputId}
              percentAchieved={percentAchieved}
              onPercentAchievedChange={changePercentAchieved}
              suggestedPercentAchieved={suggestedPercentAchieved}
              onApplySuggested={applySuggestedPercentAchieved}
            />
          )}

          {/* ── VIEW TOGGLE ── */}
          <ViewToggle view={view} onSetView={setView} />

          {/* Primary content region — loading / error (with Retry) states come
              from the triangle resource; chrome above stays interactive. */}
          <AsyncBoundary loading={triangles.loading} error={triangles.error} onRetry={triangles.refetch} label="triangle data">
          {!hasData ? (
            <div className="df-card df-card--notice" style={{ marginTop: 14 }}>
              <div className="df-note">No triangle data found. Enter data in the triangle screens first, then return here.</div>
            </div>
          ) : (<>

            {/* ═══ DEV FACTORS VIEW ═══ */}
            {view === 'DEV_FACTORS' && (<>
              {/* Average method */}
              <AvgMethodToggle avgMethod={avgMethod} onSelectAvgMethod={selectAvgMethod} />

              {/* Actual */}
              <div className="df-section">
                <div className="df-section-head"><div className="df-section-title">Actual Development Factors</div><div className="df-section-sub">Derived from triangle data ({avgMethod})</div></div>
                <FactorTable pattern={calcs.pattern} cdfs={calcs.cdfs} />
              </div>

              {/* Parametrized */}
              <div className="df-section df-section--parametrized">
                <div className="df-section-head"><div className="df-section-title">Parametrized Development Factors</div><div className="df-section-sub">Exponential fit to cumulative development</div></div>
                <FactorTable pattern={calcs.paramLdfs} cdfs={calcs.paramCdfs} sectionClass="df-card--param" />
              </div>

              {/* Munich Chain Ladder projections (Chain Ladder mode + checkbox on) */}
              {projMethod === 'CHAIN' && useMunich && mclResult && (
                <MclProjectionsTable mcl={mclResult} />
              )}

              {/* BF */}
              {projMethod === 'BF' && !isPremium && bfResults && <BFProjectionsTable bfResults={bfResults} />}
              {projMethod === 'BF' && isPremium && bfPremiumResults && (
                <BFPremiumProjectionsTable
                  bfResults={bfPremiumResults}
                  epiPerYear={epiPerYear}
                  onEpiChange={changeEpi}
                />
              )}

              {/* Underwriter Chosen */}
              <div className="df-section df-section--underwriter">
                <div className="df-section-head"><div className="df-section-title">Underwriter Chosen Factors</div></div>
                <div className="df-chosen-controls">
                  <div className="df-chosen-left">
                    <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.5)', marginBottom: 4 }}>Chosen factors base</div>
                    <div className="toggle-group df-chosen-toggle">
                      <button type="button" className={`toggle-option${chosenBase === 'ACTUAL' ? ' active' : ''}`} onClick={() => switchBase('ACTUAL')}>ACTUAL</button>
                      <button type="button" className={`toggle-option${chosenBase === 'PARAM' ? ' active' : ''}`} onClick={() => switchBase('PARAM')}>PARAMETRIZED</button>
                      <button type="button" className={`toggle-option${chosenBase === 'LINK_RATIO' ? ' active' : ''}`} onClick={() => {/* read-only — set from Link Ratios tab */}} style={chosenBase === 'LINK_RATIO' ? {} : { opacity: 0.35 }}>LINK RATIOS</button>
                    </div>
                  </div>
                  <div className="df-chosen-right">
                    <button className="orange-gloss-btn" onClick={async () => {
                      try { await save(); showToast?.('Dev factors saved'); }
                      catch (e) { showToast?.(`Save failed: ${e?.message || 'server error'}`); }
                    }}>💾 Save Factors</button>
                  </div>
                </div>
                <FactorTable pattern={chosenLdfs} cdfs={chosenCdfs} editable onChange={handleChosenChange} sectionClass="df-card--chosen" fullLdfs={basis === 'STRIPPED' ? fullCalcs?.pattern : undefined} fullCdfs={basis === 'STRIPPED' ? fullCalcs?.cdfs : undefined} />
              </div>
            </>)}

            {/* ═══ LINK RATIOS VIEW ═══ */}
            {view === 'LINK_RATIOS' && (<>
              <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.55)', marginBottom: 8, padding: '8px 14px', borderRadius: 10, background: 'rgba(249,115,22,0.06)', border: '1px solid rgba(249,115,22,0.15)' }}>
                Excluding link ratios here will <b style={{ color: '#fb923c' }}>override</b> the Underwriter Chosen Factors with the recalculated {(AVG_METHOD_LABEL[avgMethod] || 'Weighted').toLowerCase()} averages.
              </div>
              <LinkRatioView
                matrix={calcs.matrix}
                years={years}
                numDevYears={numDevYears}
                excluded={excluded}
                setExcluded={handleLinkRatioExcludedChange}
                onPatternChange={applyLinkRatioPattern}
                method={avgMethod}
              />
              <div style={{ marginTop: 12, display: 'flex', alignItems: 'center', gap: 12 }}>
                <button className="orange-gloss-btn" onClick={async () => {
                  try { await save(); showToast?.('Link ratio factors saved'); }
                  catch (e) { showToast?.(`Save failed: ${e?.message || 'server error'}`); }
                }}>💾 Save Link Ratio Factors</button>
                {excluded.size > 0 && <span style={{ fontSize: 11, color: 'rgba(248,113,113,0.8)' }}>{excluded.size} ratio(s) excluded</span>}
                {dirty && <span className="muted">Unsaved changes</span>}
              </div>
            </>)}

            {/* ═══ GRAPH VIEW ═══ */}
            {view === 'GRAPH' && (
              <ComparisonGraph pattern={calcs.pattern} paramCdfs={calcs.paramCdfs} benchmarks={benchmarks} />
            )}

          </>)}
          </AsyncBoundary>
          {showStrippedModal && (
            <StrippedTriangleModal
              onClose={() => setShowStrippedModal(false)}
              stripLargeCat={stripLargeCat}
              exclusions={exclusions}
              fullMatrix={fullCalcs?.matrix}
              strippedMatrix={strippedCalcs?.matrix}
              years={years}
              numDevYears={numDevYears}
            />
          )}
        </div>
      )}
    </WizardLayout>
  );
}
