import { getBenchmarkLdfForClass } from './benchmark.js';
import { logger } from '../../lib/logger.js';

/**
 * Compute the weighted LDF curve for a contract × triangle_type.
 *
 * Inputs (resolved by caller from DB):
 *   - epiSplit: [{ classOfBusinessId, premium }]
 *   - countryId, region: from contracts row
 *   - triangleType: 'PREMIUM' | 'CLAIMS_PAID' | 'CLAIMS_OS' | 'INCURRED'
 *   - treatyCategory: 'PROPORTIONAL' | 'NON_PROPORTIONAL' — segregates the
 *       benchmark pool. Proportional treaties only see proportional benchmarks
 *       and vice versa.
 *   - overrideWeights: optional map { [classOfBusinessId]: weightFloat }
 *
 * Returns:
 *   {
 *     classes: [{ classOfBusinessId, weight, scope, nContracts, curve: [{devMonth, ldf}] }],
 *     blended: [{ devMonth, ldf, cdf }],
 *     allDevMonths: number[],
 *     degenerate: boolean   // true when there was no class weight/premium to
 *                           //   blend, so the curve collapsed to CDF 1.0 (a
 *                           //   "no development" answer that isn't a real one).
 *                           //   Callers should surface this rather than treat
 *                           //   the CDF-1.0 curve as a genuine result.
 *   }
 */
export async function computeBlendedLdfCurve(client, {
  epiSplit, countryId, region, triangleType, treatyCategory, overrideWeights = null,
}) {
  if (!Array.isArray(epiSplit) || epiSplit.length === 0) {
    return { classes: [], blended: [], allDevMonths: [], degenerate: false };
  }

  // Default weights = EPI share. Override if provided.
  const totalPremium = epiSplit.reduce((s, e) => s + Number(e.premium || 0), 0) || 1;
  const epiShare = Object.fromEntries(
    epiSplit.map((e) => [e.classOfBusinessId, Number(e.premium || 0) / totalPremium]),
  );
  let weights = epiShare;
  if (overrideWeights) {
    // Normalise overrides so they sum to 1 (defensive)
    const sum = Object.values(overrideWeights).reduce((s, w) => s + Number(w || 0), 0);
    if (sum > 0) {
      weights = Object.fromEntries(
        Object.entries(overrideWeights).map(([k, v]) => [k, Number(v) / sum]),
      );
    }
  }

  // Fetch per-class benchmark curves in parallel
  const perClass = await Promise.all(epiSplit.map(async (e) => {
    const bench = await getBenchmarkLdfForClass(client, {
      classOfBusinessId: e.classOfBusinessId,
      countryId, region, triangleType, treatyCategory,
    });
    const curve = bench.rows.map((r) => ({
      devMonth: Number(r.dev_month),
      ldf: Number(r.weighted_ldf),
    }));
    return {
      classOfBusinessId: e.classOfBusinessId,
      weight: weights[e.classOfBusinessId] ?? 0,
      scope: bench.scope,
      // The MINIMUM contract count across the curve's dev months — not
      // rows[0]'s (F108): the earliest dev month almost always has the most
      // contributing contracts, so reporting it overstated the support the
      // sparse tail actually has.
      nContracts: bench.rows.length > 0
        ? Math.min(...bench.rows.map((r) => Number(r.n_contracts)))
        : 0,
      // The last dev month the class's benchmark curve reaches. Beyond it
      // the class is fully developed (see the blend loop below).
      maxDevMonth: curve.length > 0 ? Math.max(...curve.map((p) => p.devMonth)) : null,
      curve,
    };
  }));

  // Union of dev_months across all classes (sorted ascending)
  const devSet = new Set();
  for (const cls of perClass) for (const p of cls.curve) devSet.add(p.devMonth);
  const allDevMonths = [...devSet].sort((a, b) => a - b);

  // Blend at each dev_month
  const blended = allDevMonths.map((dm) => {
    let weightedSum = 0;
    let weightAccountedFor = 0;
    for (const cls of perClass) {
      if (!(cls.weight > 0)) continue;
      const pt = cls.curve.find((p) => p.devMonth === dm);
      if (pt) {
        weightedSum += pt.ldf * cls.weight;
        weightAccountedFor += cls.weight;
      } else if (cls.maxDevMonth != null && dm > cls.maxDevMonth) {
        // The class HAS a benchmark curve but it ends before this dev month:
        // a selected-LDF curve that stops means the business is fully
        // developed from there on, so the class contributes an implicit
        // factor of 1.0 (F70). Renormalising its weight away instead — as
        // for a class with no data at all — silently applied the long-tail
        // classes' development to the whole book, overstating tail LDFs and
        // IBNR for any mixed short-tail/long-tail blend.
        weightedSum += 1.0 * cls.weight;
        weightAccountedFor += cls.weight;
      }
      // Otherwise the class has no curve at all (scope NONE) or no point at
      // a dev month within/before its curve — renormalise across the classes
      // that do have data, so missing-data classes don't drag the blend to 0.
    }
    const ldf = weightAccountedFor > 0 ? weightedSum / weightAccountedFor : 1.0;
    return { devMonth: dm, ldf };
  });

  // CDF = cumulative product backwards
  let cdf = 1.0;
  for (let i = blended.length - 1; i >= 0; i--) {
    cdf *= blended[i].ldf;
    blended[i].cdf = Math.round(cdf * 1000000) / 1000000;
  }

  // If no class carried any weight/premium, every dev_month fell through to
  // the ldf = 1.0 fallback and the CDF collapsed to a flat 1.0 — indistinguishable
  // from a genuine "no development" curve. Flag it (and warn) so the caller can
  // tell the difference instead of pricing off a silent no-op curve.
  const hadWeight = perClass.some((cls) => cls.weight > 0);
  const degenerate = blended.length > 0 && !hadWeight;
  if (degenerate) {
    logger.warn('[ldf-blend] no class weight/premium to blend; curve collapsed to CDF 1.0', {
      triangleType, treatyCategory, countryId, region, classCount: perClass.length,
    });
  }

  return { classes: perClass, blended, allDevMonths, degenerate };
}

// A checked-out transaction client has a .query and a .release; the Pool has
// .query but no .release. Same guard as pricingOfferRepository.js — used to
// decide whether we must check out a dedicated connection ourselves.
function isTxClient(db) {
  return Boolean(db) && typeof db.query === 'function' && typeof db.release === 'function';
}

// The wipe-and-reinsert statements, run on a single dedicated client whose
// transaction is managed by saveContractLdfBlend (or by the caller, when a
// transaction client is passed in).
async function saveBlendStatements(client, {
  contractId, triangleType, overridden, classes, blended,
}) {
  const existing = await client.query(
    `SELECT blend_id FROM public.contract_ldf_blend
      WHERE contract_id = $1 AND triangle_type = $2`,
    [contractId, triangleType],
  );
  let blendId;
  if (existing.rows.length > 0) {
    blendId = existing.rows[0].blend_id;
    await client.query(
      `UPDATE public.contract_ldf_blend
          SET overridden = $1, updated_at = now()
        WHERE blend_id = $2`,
      [overridden, blendId],
    );
    await client.query('DELETE FROM public.contract_ldf_blend_weight WHERE blend_id = $1', [blendId]);
    await client.query('DELETE FROM public.contract_ldf_blend_curve  WHERE blend_id = $1', [blendId]);
  } else {
    const ins = await client.query(
      `INSERT INTO public.contract_ldf_blend (contract_id, triangle_type, overridden)
       VALUES ($1, $2, $3) RETURNING blend_id`,
      [contractId, triangleType, overridden],
    );
    blendId = ins.rows[0].blend_id;
  }
  for (const cls of classes) {
    await client.query(
      `INSERT INTO public.contract_ldf_blend_weight
         (blend_id, class_of_business_id, weight, benchmark_scope, n_contracts)
       VALUES ($1, $2, $3, $4, $5)`,
      [blendId, cls.classOfBusinessId, cls.weight, cls.scope, cls.nContracts],
    );
  }
  for (const pt of blended) {
    await client.query(
      `INSERT INTO public.contract_ldf_blend_curve (blend_id, dev_month, weighted_ldf, weighted_cdf)
       VALUES ($1, $2, $3, $4)`,
      [blendId, pt.devMonth, pt.ldf, pt.cdf],
    );
  }
  return blendId;
}

/**
 * Persist the blend selection (used after the underwriter clicks "Save" in the modal).
 * Wipes existing rows for (contract_id, triangle_type) then inserts fresh.
 *
 * `db` may be the shared Pool or an already-checked-out transaction client:
 *   - Pool: a dedicated client is checked out and the whole wipe-and-reinsert
 *     runs as ONE transaction on that connection (BEGIN/COMMIT/ROLLBACK,
 *     release in finally). Issuing BEGIN/COMMIT through the Pool itself is
 *     NOT a transaction — each statement can land on a different pooled
 *     connection, so a mid-save failure could persist a truncated curve and
 *     leak an aborted transaction onto a shared connection.
 *   - Transaction client (per the withTransaction contract, already inside
 *     BEGIN): statements run on it directly so they commit or roll back with
 *     the caller's transaction; no nested BEGIN/COMMIT is issued.
 */
export async function saveContractLdfBlend(db, {
  contractId, triangleType, overridden, classes, blended,
}) {
  if (isTxClient(db)) {
    return saveBlendStatements(db, { contractId, triangleType, overridden, classes, blended });
  }
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const blendId = await saveBlendStatements(client, {
      contractId, triangleType, overridden, classes, blended,
    });
    await client.query('COMMIT');
    return blendId;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

/**
 * Load the saved blend for a contract (no recomputation).
 * Returns null if no blend has been saved yet.
 */
export async function loadContractLdfBlend(client, contractId, triangleType) {
  const blend = await client.query(
    `SELECT blend_id, overridden FROM public.contract_ldf_blend
      WHERE contract_id = $1 AND triangle_type = $2`,
    [contractId, triangleType],
  );
  if (blend.rows.length === 0) return null;
  const blendId = blend.rows[0].blend_id;
  const overridden = blend.rows[0].overridden;
  const [weights, curve] = await Promise.all([
    client.query(
      `SELECT class_of_business_id, weight, benchmark_scope, n_contracts
         FROM public.contract_ldf_blend_weight WHERE blend_id = $1`,
      [blendId],
    ),
    client.query(
      `SELECT dev_month, weighted_ldf, weighted_cdf
         FROM public.contract_ldf_blend_curve
        WHERE blend_id = $1 ORDER BY dev_month`,
      [blendId],
    ),
  ]);
  return {
    blendId,
    overridden,
    classes: weights.rows.map((r) => ({
      classOfBusinessId: r.class_of_business_id,
      weight: Number(r.weight),
      scope: r.benchmark_scope,
      nContracts: Number(r.n_contracts),
    })),
    blended: curve.rows.map((r) => ({
      devMonth: Number(r.dev_month),
      ldf: Number(r.weighted_ldf),
      cdf: Number(r.weighted_cdf),
    })),
  };
}
