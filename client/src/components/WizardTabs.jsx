// src/components/WizardTabs.jsx — Sidebar tabs for wizard navigation
import { useNavigate } from 'react-router-dom';
import { useAppState } from '../context/AppContext';
import { PROP_TAB_GROUPS, NP_TAB_GROUPS, FAC_TAB_GROUPS, STEP_LABELS, ROUTE_PATHS, facStepVisible } from '../config/wizard';
import { isNpCatFlowDisabled, isNpRiskFlowDisabled, isNpStopLossTreaty } from '../utils/npTreatyType';

/**
 * @param {object} props
 * @param {string} props.activeKey  the current step's route key
 * @param {(path: string) => void|Promise<void>} [props.onNavigate]
 *   How to leave the current step. WizardLayout passes a handler that runs the
 *   screen's save first and only navigates if it succeeds — the same contract
 *   the Back/Next dock has always had. Without it these tabs navigated with a
 *   bare navigate() and silently discarded every unsaved edit, which is what
 *   users hit: the sidebar is nine always-visible buttons, while the Back/Next
 *   dock auto-hides. Falls back to a plain navigate so the component still
 *   works standalone (and in its own tests).
 */
export default function WizardTabs({ activeKey, onNavigate }) {
  const navigate = useNavigate();
  const { state } = useAppState();
  const mode = activeKey?.startsWith('FAC_') ? 'FAC' : activeKey?.startsWith('NP_') ? 'NP' : 'PROP';
  const groups = mode === 'FAC' ? FAC_TAB_GROUPS : mode === 'NP' ? NP_TAB_GROUPS : PROP_TAB_GROUPS;
  const triEnabled = state.propTreatyDetail?.triangulationsAvailable !== false;
  const npCatDisabled  = mode === 'NP' && isNpCatFlowDisabled(state);   // RISK XL → hide CAT tabs
  const npRiskDisabled = mode === 'NP' && isNpRiskFlowDisabled(state);  // CAT XL  → hide risk/large-loss tabs
  const npStopLoss     = mode === 'NP' && isNpStopLossTreaty(state);    // Stop Loss / Agg XL only

  function shouldShow(key) {
    // Sidebar visibility and Next/Back navigation must agree — this mirrors
    // the same filter getWizardNav applies to FAC_WIZARD_ORDER.
    if (mode === 'FAC' && !facStepVisible(key, state.facRiskDetail?.ratingFamilies)) return false;
    if (mode === 'PROP') {
      if (!triEnabled && (key.includes('TRIANGLES') || key.includes('DEV_FACTORS') || key === 'PROP_PROJECTED_SUMMARY')) return false;
      if (triEnabled && key === 'PROP_NO_TRIANGULATION') return false;
      if (key === 'PROP_FINAL_BIND') return false;
    }
    if (mode === 'NP') {
      // Quote-mode tab visibility — keep this list aligned with
      // NP_QUOTE_WIZARD_ORDER in config/wizard.js. Anything dropped from
      // the quote workflow has to also be hidden from the left sidebar,
      // otherwise users see tabs that aren't part of the flow.
      if (state.quoteMode) {
        const QUOTE_HIDDEN = new Set([
          'NP_EXPIRING_STRUCTURE',
          'NP_STRUCTURE',
          'NP_EXCESS_DEV_FACTORS',
          'NP_CLAIMS_PROFILE',
          'NP_EVENT_LOSS_TABLES',
          'NP_FINAL_PRICING',
          // History/Audit is a contract-only trail; quotes carry their own
          // negotiation history elsewhere.
          'NP_HISTORY',
        ]);
        if (QUOTE_HIDDEN.has(key)) return false;
      } else {
        // Contract mode hides quote-only screens.
        if (key === 'NP_EXPIRING_STRUCTURE') return false;
        if (key === 'NP_FINAL_QUOTE') return false;
      }
      // RISK XL: hide all CAT-related tabs + CRESTA + Event Loss Tables
      if (npCatDisabled && (
        key.startsWith('NP_CAT_LOSS_') ||
        key === 'NP_CRESTA_AGGREGATES' ||
        key === 'NP_EVENT_LOSS_TABLES'
      )) return false;
      // CAT XL: hide all risk/large-loss tabs
      if (npRiskDisabled && key.startsWith('NP_LARGE_LOSS_')) return false;
      // Stop Loss screen only shown for Stop Loss / Aggregate XL treaties.
      if (!npStopLoss && key === 'NP_STOP_LOSS_PRICING') return false;
      // For Stop Loss treaties hide the Final Pricing tab — pricing
      // is done on the dedicated Stop Loss Pricing screen instead.
      if (npStopLoss && key === 'NP_FINAL_PRICING') return false;
    }
    return true;
  }

  return (
    <nav className="wizard-tabs" aria-label="Wizard steps">
      {groups.map((g) => {
        const visibleKeys = g.keys.filter(shouldShow);
        if (visibleKeys.length === 0) return null;
        const groupId = `wiz-group-${g.label.replace(/\s+/g, '-').toLowerCase()}`;
        return (
          <div key={g.label} className="wizard-tab-group" role="group" aria-labelledby={groupId}>
            <div className="wizard-tab-group-label" id={groupId}>{g.label}</div>
            {visibleKeys.map((key) => {
              const isActive = key === activeKey;
              return (
                <button
                  key={key}
                  type="button"
                  className={`wizard-tab ${isActive ? 'wizard-tab--active' : ''}`}
                  aria-current={isActive ? 'step' : undefined}
                  onClick={() => (onNavigate ? onNavigate(ROUTE_PATHS[key]) : navigate(ROUTE_PATHS[key]))}
                >
                  {STEP_LABELS[key] || key}
                </button>
              );
            })}
          </div>
        );
      })}
    </nav>
  );
}
