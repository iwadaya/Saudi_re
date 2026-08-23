import { lazy } from 'react';

const LoginScreen = lazy(() => import('../screens/login/LoginScreen'));
const SsoCallback = lazy(() => import('../screens/login/SsoCallback'));
const SelectScreen = lazy(() => import('../screens/select/SelectScreen'));
const HomeScreen = lazy(() => import('../screens/home/HomeScreen'));
const FacHomeScreen = lazy(() => import('../screens/facultative/home/FacHomeScreen'));
const DashboardScreen = lazy(() => import('../screens/dashboard/DashboardScreen'));
const FacDashboardScreen = lazy(() => import('../screens/facdashboard/FacDashboardScreen'));
const ApprovalsScreen = lazy(() => import('../screens/approvals/ApprovalsScreen'));

const PropTreatyDetail = lazy(() => import('../screens/proportional/treaty_detail/PropTreatyDetail'));
const PropDocuments = lazy(() => import('../screens/proportional/documents/PropDocuments'));
const PropPremiumTriangles = lazy(() => import('../screens/proportional/triangles/PropPREMIUMTRIANGLES'));
const PropClaimsPaidTriangles = lazy(() => import('../screens/proportional/triangles/PropCLAIMSPAIDTRIANGLES'));
const PropOSClaimsTriangles = lazy(() => import('../screens/proportional/triangles/PropOSCLAIMSTRIANGLES'));
const PropIncurredClaimsTriangles = lazy(() => import('../screens/proportional/triangles/PropINCURREDCLAIMSTRIANGLES'));
const PropPremiumDevFactors = lazy(() => import('../screens/proportional/dev_factors/PropPREMIUMDEVFACTORS'));
const PropPaidClaimsDevFactors = lazy(() => import('../screens/proportional/dev_factors/PropPAIDCLAIMSDEVFACTORS'));
const PropOSClaimsDevFactors = lazy(() => import('../screens/proportional/dev_factors/PropOSCLAIMSDEVFACTORS'));
const PropIncurredDevFactors = lazy(() => import('../screens/proportional/dev_factors/PropINCURREDDEVFACTORS'));
const PropNoTriangulation = lazy(() => import('../screens/proportional/no_triangulation/PropNoTriangulation'));
const PropProjectedSummary = lazy(() => import('../screens/proportional/projected_summary/PropProjectedSummary'));
const PropQuickSummary = lazy(() => import('../screens/proportional/quick_summary/PropQuickSummary'));
const PropLargeLossList = lazy(() => import('../screens/proportional/large_loss_list/PropLargeLossList'));
const PropLargeLossSelection = lazy(() => import('../screens/proportional/large_loss_selection/PropLargeLossSelection'));
const PropLargeLossPareto = lazy(() => import('../screens/proportional/large_loss_pareto/PropLargeLossPareto'));
const PropCatLossList = lazy(() => import('../screens/proportional/cat_loss_list/PropCatLossList'));
const PropCatLossSelection = lazy(() => import('../screens/proportional/cat_loss_selection/PropCatLossSelection'));
const PropCatLossPareto = lazy(() => import('../screens/proportional/cat_loss_pareto/PropCatLossPareto'));
const PropRiskProfile = lazy(() => import('../screens/proportional/risk_profile/PropRiskProfile'));
const PropClaimsProfile = lazy(() => import('../screens/proportional/claims_profile/PropClaimsProfile'));
const PropCrestaAggregates = lazy(() => import('../screens/proportional/cresta_zones/PropCrestaAggregates'));
const PropEventLossTables = lazy(() => import('../screens/proportional/event_loss_tables/PropEventLossTables'));
const PropPricing = lazy(() => import('../screens/proportional/pricing/PropPricing'));

const NpTreatyDetail = lazy(() => import('../screens/non_proportional/treaty_detail/NpTreatyDetail'));
const NpDocuments = lazy(() => import('../screens/non_proportional/documents/NpDocuments'));
const NpStructure = lazy(() => import('../screens/non_proportional/structure/NpStructure'));
const NpExpiringStructure = lazy(() => import('../screens/non_proportional/expiring_structure/NpExpiringStructure'));
const NpPremiumsTable = lazy(() => import('../screens/non_proportional/premiums_table/NpPremiumsTable'));
const NpExcessDevFactors = lazy(() => import('../screens/non_proportional/excess_dev_factors/NpExcessDevFactors'));
const NpHistoricalPerformance = lazy(() => import('../screens/non_proportional/historical_performance/NpHistoricalPerformance'));
const NpLargeLossList = lazy(() => import('../screens/non_proportional/large_loss_list/NpLargeLossList'));
const NpLargeLossSelection = lazy(() => import('../screens/non_proportional/large_loss_selection/NpLargeLossSelection'));
const NpLargeLossPareto = lazy(() => import('../screens/non_proportional/large_loss_pareto/NpLargeLossPareto'));
const NpLargeLossDevFactors = lazy(() => import('../screens/non_proportional/large_loss_dev_factors/NpLargeLossDevFactors'));
const NpCatLossList = lazy(() => import('../screens/non_proportional/cat_loss_list/NpCatLossList'));
const NpCatLossSelection = lazy(() => import('../screens/non_proportional/cat_loss_selection/NpCatLossSelection'));
const NpCatLossPareto = lazy(() => import('../screens/non_proportional/cat_loss_pareto/NpCatLossPareto'));
const NpCatLossDevFactors = lazy(() => import('../screens/non_proportional/cat_loss_dev_factors/NpCatLossDevFactors'));
const NpRiskProfile = lazy(() => import('../screens/non_proportional/risk_profile/NpRiskProfile'));
const NpClaimsProfile = lazy(() => import('../screens/non_proportional/claims_profile/NpClaimsProfile'));
const NpCrestaAggregates = lazy(() => import('../screens/non_proportional/cresta_zones/NpCrestaAggregates'));
const NpEventLossTables = lazy(() => import('../screens/non_proportional/event_loss_tables/NpEventLossTables'));
const NpFinalPricing    = lazy(() => import('../screens/non_proportional/final_pricing/NpFinalPricing'));
const NpStopLossPricing = lazy(() => import('../screens/non_proportional/stop_loss_pricing/NpStopLossPricing'));
const PropHistory       = lazy(() => import('../screens/proportional/history/PropHistory'));
const NpHistory         = lazy(() => import('../screens/non_proportional/history/NpHistory'));
const ExcelImportAgent  = lazy(() => import('../screens/shared/ExcelImportAgent'));
const QuickBenchmark    = lazy(() => import('../screens/benchmark/QuickBenchmark'));
const ClaimsHomeScreen  = lazy(() => import('../screens/claims/ClaimsHomeScreen'));
const ClaimDetailScreen = lazy(() => import('../screens/claims/ClaimDetailScreen'));
const FinanceHomeScreen = lazy(() => import('../screens/finance/FinanceHomeScreen'));
const UserManagementScreen = lazy(() => import('../screens/admin/UserManagementScreen'));
const FormulaWorkbench     = lazy(() => import('../screens/workbench/FormulaWorkbench'));
const FormulaDetail        = lazy(() => import('../screens/workbench/FormulaDetail'));

// Facultative wizard screens
const FacRiskDetail = lazy(() => import('../screens/facultative/risk_detail/FacRiskDetail'));
const FacLocations = lazy(() => import('../screens/facultative/locations/FacLocations'));
const FacCope = lazy(() => import('../screens/facultative/cope/FacCope'));
const FacCoverageStructure = lazy(() => import('../screens/facultative/coverage_structure/FacCoverageStructure'));
const FacDeductibles = lazy(() => import('../screens/facultative/deductibles/FacDeductibles'));
const FacLossHistory = lazy(() => import('../screens/facultative/loss_history/FacLossHistory'));
const FacPricing = lazy(() => import('../screens/facultative/pricing/FacPricing'));
const FacDocuments = lazy(() => import('../screens/facultative/documents/FacDocuments'));
const FacSummary = lazy(() => import('../screens/facultative/summary/FacSummary'));

export const appRoutes = [
  { path: '/login', component: LoginScreen, public: true },
  { path: '/auth/callback', component: SsoCallback, public: true },
  { path: '/select', component: SelectScreen },
  { path: '/claims', component: ClaimsHomeScreen },
  { path: '/claims/:id', component: ClaimDetailScreen },
  { path: '/finance', component: FinanceHomeScreen },
  { path: '/', component: HomeScreen },
  { path: '/fac', component: FacHomeScreen },
  { path: '/dashboard', component: DashboardScreen },
  { path: '/fac/dashboard', component: FacDashboardScreen },
  { path: '/approvals', component: ApprovalsScreen, approvalsOnly: true },
  { path: '/import',    component: ExcelImportAgent },
  { path: '/admin/users', component: UserManagementScreen, approvalsOnly: true },
  { path: '/workbench', component: FormulaWorkbench },
  { path: '/workbench/:module/:name', component: FormulaDetail },

  { path: '/prop/treaty-detail', component: PropTreatyDetail },
  { path: '/prop/documents', component: PropDocuments },
  { path: '/prop/premium-triangles', component: PropPremiumTriangles },
  { path: '/prop/claims-paid-triangles', component: PropClaimsPaidTriangles },
  { path: '/prop/os-claims-triangles', component: PropOSClaimsTriangles },
  { path: '/prop/incurred-claims-triangles', component: PropIncurredClaimsTriangles },
  { path: '/prop/premium-dev-factors', component: PropPremiumDevFactors },
  { path: '/prop/paid-claims-dev-factors', component: PropPaidClaimsDevFactors },
  { path: '/prop/os-claims-dev-factors', component: PropOSClaimsDevFactors },
  { path: '/prop/incurred-dev-factors', component: PropIncurredDevFactors },
  { path: '/prop/no-triangulation', component: PropNoTriangulation },
  { path: '/prop/projected-summary', component: PropProjectedSummary },
  { path: '/prop/quick-summary', component: PropQuickSummary },
  { path: '/prop/large-loss-list', component: PropLargeLossList },
  { path: '/prop/large-loss-selection', component: PropLargeLossSelection },
  { path: '/prop/large-loss-pareto', component: PropLargeLossPareto },
  { path: '/prop/cat-loss-list', component: PropCatLossList },
  { path: '/prop/cat-loss-selection', component: PropCatLossSelection },
  { path: '/prop/cat-loss-pareto', component: PropCatLossPareto },
  { path: '/prop/risk-profile', component: PropRiskProfile },
  { path: '/prop/claims-profile', component: PropClaimsProfile },
  { path: '/prop/cresta-aggregates', component: PropCrestaAggregates },
  { path: '/prop/event-loss-tables', component: PropEventLossTables },
  { path: '/prop/pricing', component: PropPricing },
  { path: '/prop/history', component: PropHistory },

  { path: '/np/treaty-detail', component: NpTreatyDetail },
  { path: '/np/documents', component: NpDocuments },
  { path: '/np/structure', component: NpStructure },
  { path: '/np/expiring-structure', component: NpExpiringStructure },
  { path: '/np/premiums-table', component: NpPremiumsTable },
  { path: '/np/excess-dev-factors', component: NpExcessDevFactors },
  { path: '/np/historical-performance', component: NpHistoricalPerformance },
  { path: '/np/large-loss-list', component: NpLargeLossList },
  { path: '/np/large-loss-selection', component: NpLargeLossSelection },
  { path: '/np/large-loss-pareto', component: NpLargeLossPareto },
  { path: '/np/large-loss-dev-factors', component: NpLargeLossDevFactors },
  { path: '/np/cat-loss-list', component: NpCatLossList },
  { path: '/np/cat-loss-selection', component: NpCatLossSelection },
  { path: '/np/cat-loss-pareto', component: NpCatLossPareto },
  { path: '/np/cat-loss-dev-factors', component: NpCatLossDevFactors },
  { path: '/np/risk-profile', component: NpRiskProfile },
  { path: '/np/claims-profile', component: NpClaimsProfile },
  { path: '/np/cresta-aggregates', component: NpCrestaAggregates },
  { path: '/np/event-loss-tables', component: NpEventLossTables },
  { path: '/np/stop-loss-pricing', component: NpStopLossPricing },
  { path: '/np/final-pricing', component: NpFinalPricing },
  { path: '/np/final-quote', component: NpFinalPricing },
  { path: '/np/history', component: NpHistory },
  { path: '/benchmark', component: QuickBenchmark },

  // Facultative wizard
  { path: '/fac/risk/detail', component: FacRiskDetail },
  { path: '/fac/risk/locations', component: FacLocations },
  { path: '/fac/risk/cope', component: FacCope },
  { path: '/fac/risk/structure', component: FacCoverageStructure },
  { path: '/fac/risk/deductibles', component: FacDeductibles },
  { path: '/fac/risk/losses', component: FacLossHistory },
  { path: '/fac/risk/pricing', component: FacPricing },
  { path: '/fac/risk/documents', component: FacDocuments },
  { path: '/fac/risk/summary', component: FacSummary },
];
