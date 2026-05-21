import { getBenchmarkLdfForClass } from './benchmark.js';

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
 *     allDevMonths: number[]
 *   }
 */
export async function computeBlendedLdfCurve(client, {
  epiSplit, countryId, region, triangleType, treatyCategory, overrideWeights = null,
}) {
  if (!Array.isArray(epiSplit) || epiSplit.length === 0) {
    return { classes: [], blended: [], allDevMonths: [] };
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
    return {
      classOfBusinessId: e.classOfBusinessId,
      weight: weights[e.classOfBusinessId] ?? 0,
      scope: bench.scope,
      nContracts: bench.rows.length > 0 ? Number(bench.rows[0].n_contracts) : 0,
      curve: bench.rows.map((r) => ({
        devMonth: Number(r.dev_month),
        ldf: Number(r.weighted_ldf),
      })),
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
      const pt = cls.curve.find((p) => p.devMonth === dm);
      if (pt && cls.weight > 0) {
        weightedSum += pt.ldf * cls.weight;
        weightAccountedFor += cls.weight;
      }
    }
    // Renormalise across classes that have data at this dev_month
    // — so missing-data classes don't drag the blend to 0.
    const ldf = weightAccountedFor > 0 ? weightedSum / weightAccountedFor : 1.0;
    return { devMonth: dm, ldf };
  });

  // CDF = cumulative product backwards
  let cdf = 1.0;
  for (let i = blended.length - 1; i >= 0; i--) {
    cdf *= blended[i].ldf;
    blended[i].cdf = Math.round(cdf * 1000000) / 1000000;
  }

  return { classes: perClass, blended, allDevMonths };
}

/**
 * Persist the blend selection (used after the underwriter clicks "Save" in the modal).
 * Wipes existing rows for (contract_id, triangle_type) then inserts fresh.
 */
export async function saveContractLdfBlend(client, {
  contractId, triangleType, overridden, classes, blended,
}) {
  await client.query('BEGIN');
  try {
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
    await client.query('COMMIT');
    return blendId;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
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
