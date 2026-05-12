// server/src/validation/cresta.js
// Zod schema for the CRESTA aggregates PUT payload — shared by both the
// /api/treaties/:id/cresta and /api/quotes/:id/cresta routes since the
// payload shape is identical.

import { z } from 'zod';
import { optionalUuid, money, pct100 } from './common.js';

const zoneId   = z.string().trim().min(1).max(64).optional().nullable();
const zoneName = z.string().trim().max(256).optional().nullable();
const cobName  = z.string().trim().max(256).optional().nullable();

/** Single zone row. All aggregates and percentages are optional. */
const crestaRow = z.object({
  country_id:           optionalUuid,
  zone_id:              zoneId,
  zone_name:            zoneName,
  eq_agg:               money,
  ws_agg:               money,
  flood_agg:            money,
  srcc_agg:             money,
  others_agg:           money,
  residential_bldg_pct: pct100,
  commercial_bldg_pct:  pct100,
  commercial_cont_pct:  pct100,
  industrial_bldg_pct:  pct100,
  industrial_cont_pct:  pct100,
  cob_name:             cobName,
}).passthrough();

/**
 * Hard cap on rows per save. Real CRESTA tables max out at ~30 zones per
 * country; 500 leaves headroom for unusual countries (Indonesia ~100)
 * while still cutting off DoS-via-fat-body.
 */
export const crestaSaveSchema = z.object({
  rows:        z.array(crestaRow).max(500).default([]),
  treaty_type: z.string().trim().max(64).optional(),
  cob_id:      optionalUuid,
  cob_name:    cobName,
  country_id:  optionalUuid,
}).passthrough();
