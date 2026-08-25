import lookupsRouter from './lookups.js';
import assignmentsRouter from './assignments.js';
import treatiesRouter from './treaties.js';
import treatyDataRouter from './treatyData.js';
import pricingRouter from './pricing.js';
import nonPropRouter from './nonProp.js';
import quotesRouter from './quotes.js';
import homeRouter from './home.js';
import dashboardRouter from './dashboard.js';
import facDashboardRouter from './facDashboard.js';
import quoteLifecycleRouter from './quoteLifecycle.js';
import aiRouter from './ai.js';
import aiCedantRouter from './aiCedant.js';
import aiMarketRouter from './aiMarket.js';
import facultativeRouter from './facultative.js';
import facultativeReferenceRouter from './facultativeReference.js';
import facPlacesRouter from './facPlaces.js';
import clientEventsRouter from './clientEvents.js';
import workbenchRouter from './workbench.js';
import peerStructuresRouter from './peerStructures.js';
import reinsurerAnalysisRouter from './reinsurerAnalysis.js';
import portfolioInsightsRouter from './portfolioInsights.js';
import renewalPackImportRouter from './renewalPackImport.js';
import renewalPackRouter from './renewalPack.js';
import ldfBlendingRouter from './ldfBlending.js';
import claimsRouter from './claims.js';
import financeRouter from './finance.js';
import retroRouter from './retro.js';

const routers = [
  lookupsRouter,
  assignmentsRouter,
  treatiesRouter,
  treatyDataRouter,
  pricingRouter,
  nonPropRouter,
  quotesRouter,
  homeRouter,
  dashboardRouter,
  facDashboardRouter,
  quoteLifecycleRouter,
  aiRouter,
  aiCedantRouter,
  aiMarketRouter,
  facultativeRouter,
  facultativeReferenceRouter,
  facPlacesRouter,
  clientEventsRouter,
  workbenchRouter,
  peerStructuresRouter,
  reinsurerAnalysisRouter,
  portfolioInsightsRouter,
  renewalPackImportRouter,
  renewalPackRouter,
  ldfBlendingRouter,
  claimsRouter,
  financeRouter,
  retroRouter,
];

export function registerApiRoutes(app) {
  for (const router of routers) {
    app.use('/api', router);
  }
}
