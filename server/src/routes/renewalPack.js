// server/src/routes/renewalPack.js — portfolio renewal pack Excel export.
import { Router } from "express";
import { pool } from "../db/pool.js";
import { asyncHandler } from "../helpers.js";
import { buildRenewalPackWorkbook } from "../services/renewalPackExport/builder.js";
import { resolveExportScope } from "../services/renewalPackExport/scope.js";
import { requireMinLevel, actorFromReq } from "../middleware/requestContext.js";
import { logAudit } from "../services/audit.js";
const router = Router();

// 'portfolio.export' capability — the full-portfolio renewal-pack workbook is a
// privileged bulk extract, restricted to Chief Underwriter / Chief Executive
// (hierarchy level ≤ 2) and above via the existing role mechanism.
const requirePortfolioExport = requireMinLevel(2);

// audit_log.entity_id is uuid-typed; the portfolio export is not a single
// entity, so it audits against a fixed sentinel id with the human-readable
// target carried in the payload.
const PORTFOLIO_EXPORT_ID = '00000000-0000-0000-0000-000000000000';

router.get("/renewal-pack/export", requirePortfolioExport, asyncHandler(async (req, res) => {
  // Scope the export to the rows this user's MANDATE permits (treaty-type + COB).
  // A null scope = unrestricted mandate → the full portfolio.
  const scope = await resolveExportScope(pool, req.user?.userId);
  const contractCount = scope.contractIds
    ? scope.contractIds.length
    : Number((await pool.query('SELECT count(*)::int AS n FROM public.contract')).rows[0].n);

  const wb = await buildRenewalPackWorkbook(pool, { contractIds: scope.contractIds });

  // Audit the export BEFORE streaming (actor + ts + applied filters + row count).
  // Headers aren't sent yet, so a stream failure can't corrupt the audit.
  await logAudit(pool, {
    entityType: 'PORTFOLIO', entityId: PORTFOLIO_EXPORT_ID, eventType: 'PORTFOLIO_EXPORTED',
    actor: actorFromReq(req),
    payload: {
      target: 'renewal-pack',
      scoped: scope.contractIds !== null,
      treatyTypeScope: scope.treatyTypeScope,
      restrictedCobIds: scope.restrictedCobIds,
      contractCount,
    },
  });

  const date = new Date().toISOString().slice(0, 10);
  res.setHeader("Content-Type",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition",
    `attachment; filename="renewal-pack-${date}.xlsx"`);
  await wb.xlsx.write(res);
  res.end();
}));

export default router;
