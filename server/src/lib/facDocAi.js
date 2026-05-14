// server/src/lib/facDocAi.js
//
// Pure-ish helpers that the /api/ai/fac/* routes compose around.
// Kept out of the Express handler so tests can mock the OpenAI call
// without spinning up a route.

import fs from 'node:fs/promises';
import path from 'node:path';
import { env } from '../config/env.js';
import { pool } from '../db/pool.js';
import { logger } from './logger.js';
import { buildFacSystemPrompt, facAiResponseSchema } from './facDocAiPrompts.js';

const OPENAI_API   = 'https://api.openai.com/v1/responses';
const OPENAI_MODEL = 'gpt-4o';
const PROVIDER     = 'openai';

/**
 * Read the document bytes off whatever storage the upload route used.
 *
 * For Cloudinary URLs (http/https) we fetch over the wire; for local
 * paths under env.uploadDir we read off disk. Anything else throws.
 */
export async function readDocumentBytes(doc) {
  const key = doc?.storage_key || doc?.file_path;
  if (!key) throw new Error('document has no storage_key');
  if (/^https?:\/\//i.test(key)) {
    const r = await fetch(key);
    if (!r.ok) throw new Error(`failed to fetch document from ${key}: ${r.status}`);
    const buf = Buffer.from(await r.arrayBuffer());
    return buf;
  }
  // Treat as a path relative to env.uploadDir; resolve to an absolute
  // path inside the upload dir and refuse anything that escapes it
  // (defence against a poisoned storage_key from a stale row).
  const abs = path.resolve(env.uploadDir, key);
  if (!abs.startsWith(path.resolve(env.uploadDir) + path.sep) && abs !== path.resolve(env.uploadDir)) {
    throw new Error('document path escapes upload directory');
  }
  return fs.readFile(abs);
}

/**
 * Pull the reference catalogues the prompt builders inline. One call
 * per analysis is cheap (these tables are tiny + cacheable).
 */
export async function loadFacAiContextLists() {
  const [factors, occupancies, clauses] = await Promise.all([
    pool.query(`SELECT factor_code, option_label FROM public.fac_factor_option ORDER BY factor_code, sort_order`),
    pool.query(`SELECT occupancy_name FROM public.fac_occupancy_master WHERE active = true ORDER BY occupancy_name`),
    pool.query(`SELECT clause_code, clause_name FROM public.fac_clause_master ORDER BY sort_order`),
  ]);
  const factorOptions = {};
  for (const row of factors.rows) {
    if (!factorOptions[row.factor_code]) factorOptions[row.factor_code] = [];
    factorOptions[row.factor_code].push(row.option_label);
  }
  return {
    factorOptions,
    occupancyNames: occupancies.rows.map((r) => r.occupancy_name),
    // Use clause_code: the prompt builder lists clause "names" but
    // the runner downstream filters by code, so showing both keeps
    // the prompt human-readable while still mappable.
    clauseNames: clauses.rows.map((r) => `${r.clause_code} — ${r.clause_name}`),
  };
}

/**
 * Default OpenAI caller — extracted so tests can inject a fake.
 */
export async function callOpenAi({ systemPrompt, base64, fetchFn = fetch }) {
  if (!env.openaiApiKey) throw new Error('OPENAI_API_KEY not configured');
  const payload = {
    model: OPENAI_MODEL,
    max_output_tokens: 2000,
    input: [
      { role: 'system', content: [{ type: 'input_text', text: systemPrompt }] },
      {
        role: 'user',
        content: [
          { type: 'input_file', filename: 'document.pdf', file_data: `data:application/pdf;base64,${base64}` },
          { type: 'input_text', text: 'Analyse this document and return the JSON object.' },
        ],
      },
    ],
  };
  const r = await fetchFn(OPENAI_API, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${env.openaiApiKey}`,
    },
    body: JSON.stringify(payload),
  });
  if (!r.ok) {
    const errBody = await r.json().catch(() => ({}));
    throw new Error(errBody?.error?.message || `OpenAI ${r.status}`);
  }
  const data = await r.json();
  let text = data?.output_text;
  if (!text) {
    const parts = [];
    for (const item of data?.output || []) {
      for (const c of item?.content || []) {
        if (typeof c?.text === 'string') parts.push(c.text);
      }
    }
    text = parts.join('');
  }
  if (!text) throw new Error('OpenAI returned no text');
  return { text, raw: data };
}

/**
 * Parse the model's JSON, strip markdown fences just in case, and
 * validate against facAiResponseSchema.
 */
export function parseFacAiResponse(text) {
  let trimmed = String(text || '').trim();
  // Some models still wrap output in ```json … ```; strip defensively.
  if (trimmed.startsWith('```')) {
    trimmed = trimmed.replace(/^```(?:json)?\s*/i, '').replace(/```$/i, '').trim();
  }
  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch (e) {
    throw new Error(`model returned non-JSON output: ${e.message}`);
  }
  return facAiResponseSchema.parse(parsed);
}

/** Lookup of every allowed field_code so the runner can drop hallucinated keys. */
async function loadAllowedFieldCodes() {
  const { rows } = await pool.query(
    `SELECT field_code, data_type, screen FROM public.fac_ai_extraction_field`,
  );
  const map = new Map();
  for (const r of rows) map.set(r.field_code, r);
  return map;
}

/** Resolve a free-text occupancy name to a code, returning null if unknown. */
async function resolveOccupancyCodeByName(name) {
  if (!name) return null;
  const trimmed = String(name).trim();
  const { rows } = await pool.query(
    `SELECT occupancy_code FROM public.fac_occupancy_master
      WHERE active = true AND LOWER(occupancy_name) = LOWER($1)
      LIMIT 1`,
    [trimmed],
  );
  return rows.length ? Number(rows[0].occupancy_code) : null;
}

/** Best-effort check that a FACTOR_OPTION value matches an option in the master. */
async function isValidFactorOption(factorCode, optionLabel) {
  if (!factorCode || !optionLabel) return false;
  const { rowCount } = await pool.query(
    `SELECT 1 FROM public.fac_factor_option
      WHERE factor_code = $1 AND option_label = $2`,
    [factorCode, String(optionLabel)],
  );
  return rowCount > 0;
}

/**
 * Filter the model's recommendations: drop unknown field codes,
 * drop FACTOR_OPTION values that aren't in the master, and (when
 * possible) resolve occupancy names to integer codes.
 */
export async function sanitizeRecommendations(recs) {
  const allowed = await loadAllowedFieldCodes();
  const kept = [];
  for (const rec of recs) {
    const cfg = allowed.get(rec.target_field);
    if (!cfg) continue; // hallucinated key

    if (cfg.data_type === 'FACTOR_OPTION') {
      const factorCode = rec.target_field.replace(/^factor\./, '');
      const ok = await isValidFactorOption(factorCode, rec.suggested_value);
      if (!ok) continue;
    }

    if (rec.target_field === 'occupancy_code') {
      const resolved = await resolveOccupancyCodeByName(rec.suggested_value);
      if (resolved == null) continue;
      kept.push({ ...rec, suggested_value: resolved });
      continue;
    }

    kept.push(rec);
  }
  return kept;
}

/**
 * Look up the current_value of a target_field on the risk so the UI
 * can render "current → suggested" diffs.
 */
export async function lookupCurrentValue(facRiskId, field) {
  // Risk-level simple fields
  if (['cedant_name', 'original_insured', 'inception_date', 'expiry_date', 'occupancy_code'].includes(field)) {
    const cols = {
      cedant_name: `(SELECT company_name FROM public.companies c WHERE c.company_id = r.cedant_id)`,
      original_insured: `r.insured_name`,
      inception_date: `r.inception_date::text`,
      expiry_date: `r.expiry_date::text`,
      occupancy_code: `r.occupancy_code`,
    };
    const { rows } = await pool.query(
      `SELECT ${cols[field]} AS v FROM public.fac_risk r WHERE r.fac_risk_id = $1`,
      [facRiskId],
    );
    return rows.length ? rows[0].v : null;
  }
  if (field.startsWith('factor.')) {
    const code = field.replace(/^factor\./, '');
    const { rows } = await pool.query(
      `SELECT selections->>$2 AS v FROM public.fac_underwriting_factors WHERE fac_risk_id = $1`,
      [facRiskId, code],
    );
    return rows.length ? rows[0].v : null;
  }
  if (field.startsWith('clause.')) {
    const code = field.replace(/^clause\./, '');
    const { rows } = await pool.query(
      `SELECT is_checked AS v FROM public.fac_clauses_checklist
        WHERE fac_risk_id = $1 AND clause_code = $2`,
      [facRiskId, code],
    );
    return rows.length ? rows[0].v : false;
  }
  // location.append / loss_history.append / cope.* / generic — current
  // value is not single-valued enough to surface meaningfully; the UI
  // will fall back to showing only the suggestion.
  return null;
}

/**
 * Full analysis runner: writes the RUNNING / SUCCEEDED / FAILED rows
 * for one document. Returns the analysis row plus the sanitized
 * recommendations.
 *
 * @param {{
 *   facRiskId: string,
 *   document: object,
 *   documentKind: string,
 *   callerName?: string,
 *   openAiCaller?: typeof callOpenAi
 * }} params
 */
export async function runFacDocumentAnalysis(params) {
  const { facRiskId, document, documentKind, openAiCaller = callOpenAi } = params;
  const docId = document.document_id;

  // Insert a RUNNING row first so a crash / timeout never leaves the
  // status ambiguous.
  const startedAt = new Date();
  const { rows: insertedRows } = await pool.query(
    `INSERT INTO public.fac_document_analysis
       (document_id, fac_risk_id, analysis_kind, status, provider, model, started_at)
     VALUES ($1, $2, $3, 'RUNNING', $4, $5, $6)
     RETURNING *`,
    [docId, facRiskId, documentKind, PROVIDER, OPENAI_MODEL, startedAt],
  );
  const analysisId = insertedRows[0].analysis_id;

  try {
    const bytes = await readDocumentBytes(document);
    const base64 = bytes.toString('base64');
    const lists = await loadFacAiContextLists();
    const systemPrompt = buildFacSystemPrompt(documentKind, lists);

    const { text, raw } = await openAiCaller({ systemPrompt, base64 });
    const parsed = parseFacAiResponse(text);
    const sanitized = await sanitizeRecommendations(parsed.recommendations);

    // Look up current values once per recommendation — cheap and
    // bounded by the number of recs.
    const withCurrent = [];
    for (const rec of sanitized) {
      const current = await lookupCurrentValue(facRiskId, rec.target_field);
      withCurrent.push({ ...rec, current_value: current });
    }

    const completedAt = new Date();
    const durationMs = completedAt.getTime() - startedAt.getTime();

    await pool.query(
      `UPDATE public.fac_document_analysis
          SET status='SUCCEEDED',
              completed_at = $2,
              duration_ms  = $3,
              raw_response = $4::jsonb,
              extracted    = $5::jsonb,
              summary      = $6
        WHERE analysis_id = $1`,
      [analysisId, completedAt, durationMs, JSON.stringify(raw),
       JSON.stringify(parsed.extracted || {}), parsed.summary],
    );

    const inserted = [];
    for (const rec of withCurrent) {
      const { rows } = await pool.query(
        `INSERT INTO public.fac_ai_recommendation
           (analysis_id, fac_risk_id, target_screen, target_field,
            current_value, suggested_value, rationale, confidence)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, $8)
         RETURNING *`,
        [
          analysisId, facRiskId, rec.target_screen, rec.target_field,
          rec.current_value === undefined ? null : JSON.stringify(rec.current_value),
          JSON.stringify(rec.suggested_value),
          rec.rationale, rec.confidence,
        ],
      );
      inserted.push(rows[0]);
    }

    return {
      analysisId,
      summary: parsed.summary,
      extracted: parsed.extracted,
      recommendations: inserted,
    };
  } catch (err) {
    const completedAt = new Date();
    const durationMs = completedAt.getTime() - startedAt.getTime();
    logger.error('[fac-doc-ai] analysis failed', { analysisId, error: err?.message });
    await pool.query(
      `UPDATE public.fac_document_analysis
          SET status='FAILED', completed_at=$2, duration_ms=$3, error=$4
        WHERE analysis_id=$1`,
      [analysisId, completedAt, durationMs, String(err?.message || err)],
    );
    const e = new Error(err?.message || 'AI analysis failed');
    e.analysisId = analysisId;
    throw e;
  }
}
