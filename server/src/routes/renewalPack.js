// server/src/routes/renewalPack.js — portfolio renewal pack Excel export.
import { Router } from "express";
import { pool } from "../db/pool.js";
import { asyncHandler } from "../helpers.js";
import { buildRenewalPackWorkbook } from "../services/renewalPackExport/builder.js";
const router = Router();

router.get("/renewal-pack/export", asyncHandler(async (_req, res) => {
  const wb = await buildRenewalPackWorkbook(pool);
  const date = new Date().toISOString().slice(0, 10);
  res.setHeader("Content-Type",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition",
    `attachment; filename="renewal-pack-${date}.xlsx"`);
  await wb.xlsx.write(res);
  res.end();
}));

export default router;
