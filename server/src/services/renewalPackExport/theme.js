// server/src/services/renewalPackExport/theme.js
// The Universe spreadsheet theme now lives in shared/ so the renewal pack
// (server) and the portfolio export (client) share one source of truth and
// can't drift apart. Re-exported here so this module's import path is stable.
export * from '../../../../shared/universeXlsxTheme.js';
