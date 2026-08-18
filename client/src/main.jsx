// Self-hosted Inter (variable weight + optical size) — bundled by Vite so the
// app never falls back to system fonts when CDN access is blocked.
import '@fontsource-variable/inter/opsz.css';
import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import { initTheme } from './utils/theme';
import { installGlobalErrorReporter } from './utils/errorReporter';

// Mute info-level console noise in production so demo attendees opening
// DevTools don't see pages of debug output. Errors and warnings still surface.
if (!import.meta.env.DEV) {
  const noop = () => {};
  /* eslint-disable no-console -- intentional: reassigning the muted methods */
  console.log = noop;
  console.debug = noop;
  console.info = noop;
  /* eslint-enable no-console */
}

// Apply the persisted theme before React mounts so there's no flash
initTheme();

// Attach global error + unhandledrejection listeners that ship to
// /api/client-events for searchable production diagnostics.
installGlobalErrorReporter();

// Styles
import './styles/tokens.css';
import './styles/themes.css';
import './styles/layout.css';
import './styles/components.css';
import './styles/home/screen.css';
import './styles/dashboard/dashboard.css';
import './styles/proportional/triangles.css';
import './styles/proportional/dev_factors.css';
import './styles/proportional/no_triangulation.css';
import './styles/proportional/projected_summary.css';
import './styles/proportional/quick_summary.css';
import './styles/proportional/large_loss_list.css';
import './styles/proportional/large_loss_pareto.css';
import './styles/proportional/cat_loss_list.css';
import './styles/shared/loss_list.css';
import './styles/shared/loss_selection.css';
import './styles/shared/profile.css';
import './styles/shared/history.css';
import './styles/shared/claims_finance.css';
import './styles/proportional/cat_loss_pareto.css';
import './styles/proportional/cresta_zones.css';
import './styles/proportional/event_loss_tables.css';
import './styles/proportional/pricing.css';
import './styles/non_proportional/treaty_detail.css';
import './styles/non_proportional/structure.css';
import './styles/non_proportional/premiums_table.css';
import './styles/non_proportional/final_pricing.css';
import './styles/facultative/facSummary.css';
import './styles/cockpit.css';
import './styles/modal-safety.css';
// Must be last — canonical numeric typography that harmonizes number cells
// across every screen (matches the dev-factors look).
import './styles/numbers.css';

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <BrowserRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <App />
    </BrowserRouter>
  </React.StrictMode>
);
