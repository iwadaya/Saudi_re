import { pool } from '../../../db/pool.js';
import { buildBatchInsert } from '../../../db/batchInsert.js';
import { logger } from '../../../lib/logger.js';
import { assertParentEntityUnchanged, touchParentEntity } from '../../../lib/parentEntityPersistence.js';
import { logAudit, SYSTEM_ACTOR } from '../../../services/audit.js';
import { getPricingSchemaFlags, numOrNull, upsertPricingOutputsWithClient, withTransaction } from './repositoryUtils.js';

// "Who modelled" — the scalar outputs summarised in the PRICED audit payload.
const PRICED_OUTPUT_KEYS = [
  'epi', 'attritional_ratio', 'large_loss_load', 'cat_loss_load',
  'commission_ratio', 'brokerage_ratio', 'tax_ratio', 'technical_result',
  'max_commission', 'target_margin',
];

/**
 * Build the PRICED audit payload: a compact summary of the key outputs the
 * modeller saved, plus a diff vs the prior pricing snapshot so the trail shows
 * what actually moved. NP saves arrive as an array of layer rows; prop saves as a
 * scalar outputs object.
 */
function buildPricedPayload({ outputs, priorOutputs }) {
  if (Array.isArray(outputs)) {
    return {
      type: 'NP',
      layer_count: outputs.length,
      layers: outputs.slice(0, 12).map((l) => ({
        layer: l.layer_number ?? l.layer ?? null,
        section: l.section ?? null,
        rol: numOrNull(l.rate_on_line ?? l.rol),
        premium: numOrNull(l.premium ?? l.layer_premium),
      })),
    };
  }
  const out = outputs || {};
  const summary = {};
  const changed = {};
  for (const k of PRICED_OUTPUT_KEYS) {
    const cur = numOrNull(out[k]);
    if (cur != null) summary[k] = cur;
    const before = priorOutputs ? numOrNull(priorOutputs[k]) : null;
    if (before !== cur && (before != null || cur != null)) changed[k] = { from: before, to: cur };
  }
  return { type: 'PROP', outputs: summary, ...(Object.keys(changed).length ? { changed } : {}) };
}

export async function getTreatyPricing(contractId) {
  const [outputs, yearly, components, leads, shareScenarios] = await Promise.all([
    pool.query('SELECT * FROM public.contract_pricing_outputs WHERE contract_id=$1', [contractId]),
    pool.query('SELECT * FROM public.contract_pricing_yearly WHERE contract_id=$1 ORDER BY uw_year', [contractId]),
    pool.query('SELECT * FROM public.pricing_components WHERE contract_id=$1', [contractId]),
    pool.query('SELECT * FROM public.pricing_leads WHERE contract_id=$1', [contractId]),
    pool.query('SELECT * FROM public.pricing_share_scenarios WHERE contract_id=$1 ORDER BY share_label', [contractId]),
  ]);
  return {
    outputs: outputs.rows[0] || null,
    yearly: yearly.rows,
    components: components.rows,
    leads: leads.rows[0] || null,
    share_scenarios: shareScenarios.rows,
  };
}

export async function getPricingOutputs(contractId) {
  const { rows } = await pool.query('SELECT * FROM public.contract_pricing_outputs WHERE contract_id=$1', [contractId]);
  return rows[0] || null;
}

export async function upsertPricingOutputs(contractId, data) {
  await pool.query(
    `INSERT INTO public.contract_pricing_outputs
      (contract_id,epi,attritional_ratio,large_loss_load,cat_loss_load,commission_ratio,brokerage_ratio,tax_ratio,technical_result,max_commission,target_margin)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     ON CONFLICT (contract_id) DO UPDATE SET
      epi=EXCLUDED.epi,
      attritional_ratio=EXCLUDED.attritional_ratio,
      large_loss_load=EXCLUDED.large_loss_load,
      cat_loss_load=EXCLUDED.cat_loss_load,
      commission_ratio=EXCLUDED.commission_ratio,
      brokerage_ratio=EXCLUDED.brokerage_ratio,
      tax_ratio=EXCLUDED.tax_ratio,
      technical_result=EXCLUDED.technical_result,
      max_commission=EXCLUDED.max_commission,
      target_margin=EXCLUDED.target_margin,
      updated_at=now()`,
    [
      contractId,
      numOrNull(data.epi),
      numOrNull(data.attritional_ratio),
      numOrNull(data.large_loss_load),
      numOrNull(data.cat_loss_load),
      numOrNull(data.commission_ratio),
      numOrNull(data.brokerage_ratio),
      numOrNull(data.tax_ratio),
      numOrNull(data.technical_result),
      numOrNull(data.max_commission),
      numOrNull(data.target_margin),
    ]
  );
}

export async function saveCompositePricing(payload) {
  const { contractId, outputs, yearly, components, leads, share_scenarios, comment, ifUnmodifiedSince, actor } = payload;
  const { rows: contractCheck } = await pool.query('SELECT contract_id FROM public.contract WHERE contract_id=$1', [contractId]);
  if (!contractCheck.length) {
    const error = new Error(`Contract ${contractId} not found`);
    error.statusCode = 400;
    throw error;
  }

  const schemaFlags = await getPricingSchemaFlags();
  // Snapshot the prior outputs BEFORE the write so the PRICED audit can diff them.
  const priorOutputs = await getPricingOutputs(contractId).catch(() => null);

  const updatedAt = await withTransaction(async (client) => {
    await assertParentEntityUnchanged(client, {
      parentTable: 'contract',
      idColumn: 'contract_id',
      id: contractId,
      ifUnmodifiedSince,
    });

    const output = outputs || {};
    if (schemaFlags.hasOfferCols) {
      await client.query(
        `INSERT INTO public.contract_pricing_outputs
          (contract_id, epi, attritional_ratio, large_loss_load, cat_loss_load, commission_ratio, brokerage_ratio, tax_ratio, technical_result, max_commission, target_margin,
           uw_comment, offer_status, offer_line, offer_comment, offer_approver, signed_line_pct,
           actuarial_margin, actual_margin, uw_margin)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
         ON CONFLICT (contract_id) DO UPDATE SET
          epi=COALESCE(EXCLUDED.epi, contract_pricing_outputs.epi),
          attritional_ratio=COALESCE(EXCLUDED.attritional_ratio, contract_pricing_outputs.attritional_ratio),
          large_loss_load=COALESCE(EXCLUDED.large_loss_load, contract_pricing_outputs.large_loss_load),
          cat_loss_load=COALESCE(EXCLUDED.cat_loss_load, contract_pricing_outputs.cat_loss_load),
          commission_ratio=COALESCE(EXCLUDED.commission_ratio, contract_pricing_outputs.commission_ratio),
          brokerage_ratio=COALESCE(EXCLUDED.brokerage_ratio, contract_pricing_outputs.brokerage_ratio),
          tax_ratio=COALESCE(EXCLUDED.tax_ratio, contract_pricing_outputs.tax_ratio),
          technical_result=COALESCE(EXCLUDED.technical_result, contract_pricing_outputs.technical_result),
          max_commission=COALESCE(EXCLUDED.max_commission, contract_pricing_outputs.max_commission),
          target_margin=COALESCE(EXCLUDED.target_margin, contract_pricing_outputs.target_margin),
          uw_comment=EXCLUDED.uw_comment,
          offer_status=EXCLUDED.offer_status,
          offer_line=EXCLUDED.offer_line,
          offer_comment=EXCLUDED.offer_comment,
          offer_approver=EXCLUDED.offer_approver,
          signed_line_pct=COALESCE(EXCLUDED.signed_line_pct, contract_pricing_outputs.signed_line_pct),
          actuarial_margin=COALESCE(EXCLUDED.actuarial_margin, contract_pricing_outputs.actuarial_margin),
          actual_margin=COALESCE(EXCLUDED.actual_margin, contract_pricing_outputs.actual_margin),
          uw_margin=COALESCE(EXCLUDED.uw_margin, contract_pricing_outputs.uw_margin),
          updated_at=now()`,
        [
          contractId,
          numOrNull(output.epi),
          numOrNull(output.attritional_ratio),
          numOrNull(output.large_loss_load),
          numOrNull(output.cat_loss_load),
          numOrNull(output.commission_ratio),
          numOrNull(output.brokerage_ratio),
          numOrNull(output.tax_ratio),
          numOrNull(output.technical_result),
          numOrNull(output.max_commission),
          numOrNull(output.target_margin),
          comment || output.comment || null,
          output.status || null,
          output.offer_line || null,
          output.offer_comment || null,
          output.offer_approver || null,
          numOrNull(output.signed_line_pct),
          numOrNull(output.actuarial_margin),
          numOrNull(output.actual_margin),
          numOrNull(output.uw_margin),
        ]
      );
    } else {
      await upsertPricingOutputsWithClient(client, contractId, output);
    }

    if (Array.isArray(yearly)) {
      await client.query('DELETE FROM public.contract_pricing_yearly WHERE contract_id=$1', [contractId]);
      // One multi-row INSERT instead of a round-trip per year — see db/batchInsert.js.
      const yearlyInsert = buildBatchInsert({
        table: 'public.contract_pricing_yearly',
        columns: ['contract_id', 'uw_year', 'ultimate_premium', 'ultimate_loss', 'loss_ratio', 'commission_amt', 'brokerage_amt', 'technical_result', 'record_type'],
        rows: yearly.map((row) => [
          row.uw_year,
          numOrNull(row.ultimate_premium),
          numOrNull(row.ultimate_loss),
          numOrNull(row.loss_ratio),
          numOrNull(row.commission_amt),
          numOrNull(row.brokerage_amt),
          numOrNull(row.technical_result),
          row.record_type || 'PROJECTED',
        ]),
        leadingId: contractId,
      });
      if (yearlyInsert) await client.query(yearlyInsert.sql, yearlyInsert.params);
    }

    if (Array.isArray(components)) {
      await client.query('SAVEPOINT sp_components');
      try {
        await client.query('DELETE FROM public.pricing_components WHERE contract_id=$1', [contractId]);
        const componentColumns = schemaFlags.componentColumns || new Set();
        // Optional columns are gated on the live schema, but the gate is identical
        // for every component — so resolve the present set once and batch every row
        // into a single INSERT instead of one round-trip per component.
        const optionalColumns = [
          ['selected', (c) => (c.selected == null ? true : c.selected)],
          ['actuarial_value', (c) => c.actuarial_value ?? null],
          ['uw_value', (c) => c.uw_value ?? c.underwriter_value ?? null],
          ['underwriter_value', (c) => c.underwriter_value ?? c.uw_value ?? null],
          ['market_value', (c) => c.market_value ?? null],
          ['actual_stats_value', (c) => c.actual_stats_value ?? null],
          ['comment', (c) => c.comment ?? null],
          ['display_order', (c) => c.display_order ?? null],
          ['exposure_value', (c) => c.exposure_value ?? null],
        ].filter(([column]) => componentColumns.has(column));
        const componentsInsert = buildBatchInsert({
          table: 'public.pricing_components',
          columns: ['contract_id', 'component_name', ...optionalColumns.map(([column]) => column)],
          rows: components.map((component) => [
            component.component_name,
            ...optionalColumns.map(([, valueOf]) => valueOf(component)),
          ]),
          leadingId: contractId,
        });
        if (componentsInsert) await client.query(componentsInsert.sql, componentsInsert.params);
      } catch (error) {
        logger.error('[pricing/save] components save failed, continuing without components', { error: error.message });
        await client.query('ROLLBACK TO SAVEPOINT sp_components').catch(() => {});
      }
    }

    if (leads) {
      await client.query(
        `INSERT INTO public.pricing_leads (contract_id,lead_reinsurer,expiring_reinsurer,lead_share_pct)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT (contract_id) DO UPDATE SET
          lead_reinsurer=EXCLUDED.lead_reinsurer,
          expiring_reinsurer=EXCLUDED.expiring_reinsurer,
          lead_share_pct=EXCLUDED.lead_share_pct,
          updated_at=now()`,
        [contractId, leads.lead_reinsurer, leads.expiring_reinsurer, numOrNull(leads.lead_share_pct)]
      );
    }

    if (Array.isArray(share_scenarios)) {
      await client.query('DELETE FROM public.pricing_share_scenarios WHERE contract_id=$1', [contractId]);
      // One multi-row INSERT instead of a round-trip per scenario — see db/batchInsert.js.
      const scenariosInsert = buildBatchInsert({
        table: 'public.pricing_share_scenarios',
        columns: ['contract_id', 'share_label', 'limit_amt', 'premium_amt', 'cedant_limit', 'agg_contrib', 'country_agg', 'event_limit', 'downside_amt', 'shortfall_amt'],
        rows: share_scenarios.map((scenario) => [
          scenario.share_label,
          numOrNull(scenario.limit_amt),
          numOrNull(scenario.premium_amt),
          numOrNull(scenario.cedant_limit),
          numOrNull(scenario.agg_contrib),
          numOrNull(scenario.country_agg),
          numOrNull(scenario.event_limit),
          numOrNull(scenario.downside_amt),
          numOrNull(scenario.shortfall_amt),
        ]),
        leadingId: contractId,
      });
      if (scenariosInsert) await client.query(scenariosInsert.sql, scenariosInsert.params);
    }

    // "Who modelled" — record the modeller + a summary/diff of what they saved.
    // Best-effort (non-critical): a pricing save must not fail on an audit hiccup,
    // but it commits in the same transaction so it never becomes a phantom row.
    await logAudit(client, {
      entityType: 'CONTRACT', entityId: contractId, eventType: 'PRICED',
      actor: actor || SYSTEM_ACTOR,
      payload: buildPricedPayload({ outputs, priorOutputs }),
      comment: comment || null,
    });

    return touchParentEntity(client, {
      parentTable: 'contract',
      idColumn: 'contract_id',
      id: contractId,
    });
  });

  return { updated_at: updatedAt };
}
