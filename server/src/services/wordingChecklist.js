import fsp from 'fs/promises';
import path from 'path';
import { createRequire } from 'module';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';
import { assertAiEnabled, redactForLlm } from '../lib/aiGovernance.js';

const requireModule = createRequire(import.meta.url);

const SLIP_PRIORITY = ['Final Slip', 'Draft Slip', 'Expiring Slip'];
const VALID_STATUSES = new Set(['found', 'missing', 'partial', 'unknown']);
const VALID_SOURCES = new Set(['manual', 'ai', 'heuristic']);
const OPENAI_MODEL = 'gpt-4o';
const OPENAI_API_URL = 'https://api.openai.com/v1/responses';

const KEYWORD_HINTS = {
  claimClause: ['claim clause', 'claims clause', 'claims notification', 'notice of loss', 'loss notification'],
  contingentBusinessInterruptionClause: ['contingent business interruption', 'contingent interruption', 'cbi'],
  fullInterestAbroadClause: ['full interest abroad', 'interest abroad'],
  downgradingClause: ['downgrading clause', 'downgrade clause', 'downgrading', 'rating downgrade'],
  sanctionLimitationClause: ['sanction limitation', 'sanctions limitation', 'sanction clause', 'sanctions clause', 'sanction'],
  interlockingClause: ['interlocking clause', 'interlocking'],
  claimCooperationClause: ['claim cooperation', 'claims cooperation', 'claim co-operation', 'claims co-operation', 'claims control'],
  transmissionDistributionLine: ['transmission and distribution', 'transmission & distribution', 'transmission line', 'distribution line', '1,000 m', '1000 m'],
  russiaUkraineBelarus: ['russia', 'ukraine', 'belarus'],
  strikesRiotsCivilCommotion: ['strikes riots civil commotion', 'strikes, riots', 'civil commotion', 'srcc'],
  warTerrorismIncludingNCB: ['war and terrorism', 'war & terrorism', 'terrorism', 'ncb', 'nuclear chemical biological'],
  communicableDisease: ['communicable disease', 'infectious disease', 'pandemic', 'epidemic'],
  cyberLoss: ['cyber loss', 'cyber exclusion', 'cyber risk', 'electronic data'],
  usaCanada: ['usa / canada', 'usa and canada', 'united states', 'canada', 'u.s.a.'],
  nuclearEnergy: ['nuclear energy', 'nuclear exclusion', 'nuclear incident', 'radioactive contamination'],
  seepagePollutionContamination: ['seepage pollution contamination', 'seepage', 'pollution', 'contamination'],
  creditInsurance: ['credit insurance', 'trade credit', 'credit risk'],
  offshoreEnergy: ['offshore energy', 'offshore oil', 'offshore gas', 'offshore risks'],
  mandatoryPools: ['mandatory pool', 'mandatory pools', 'compulsory pool', 'risks ceded to mandatory pools'],
  scopeInclusions: ['territorial scope', 'territorial limits', 'territory', 'geographical scope', 'covered territories'],
  scopeExclusions: ['territorial exclusions', 'excluded territories', 'excluded countries', 'territory excluded'],
};

function normalizeEntity(entity) {
  const type = entity?.type === 'quote' ? 'quote' : 'contract';
  const id = entity?.id;
  if (!id) throw new Error('Missing wording checklist entity id');
  return { type, id };
}

function entityColumns(entity) {
  const e = normalizeEntity(entity);
  if (e.type === 'quote') return { ...e, idColumn: 'quote_id' };
  return { ...e, idColumn: 'contract_id' };
}

function normalizeStatus(value) {
  const status = String(value || '').trim().toLowerCase();
  return VALID_STATUSES.has(status) ? status : 'unknown';
}

function normalizeSource(value) {
  const source = String(value || '').trim().toLowerCase();
  return VALID_SOURCES.has(source) ? source : 'manual';
}

function cleanEvidence(value) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text ? text.slice(0, 800) : null;
}

function safeActorUserId(value) {
  const text = String(value || '').trim();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(text)
    ? text
    : null;
}

async function loadActiveItems(client) {
  const { rows } = await client.query(
    `SELECT item_key, section_key, section_title, label, display_order
       FROM public.wording_checklist_item
      WHERE is_active = true
      ORDER BY display_order, item_key`,
  );
  return rows;
}

async function loadLatestRun(client, entity) {
  const { idColumn, id } = entityColumns(entity);
  const { rows } = await client.query(
    `SELECT r.analysis_run_id, r.document_id, r.doc_type, r.provider, r.status, r.summary, r.created_at,
            d.file_name AS document_file_name, d.title AS document_title
       FROM public.contract_wording_checklist_run r
       LEFT JOIN public.contract_document d ON d.document_id = r.document_id
      WHERE r.${idColumn} = $1
      ORDER BY r.created_at DESC
      LIMIT 1`,
    [id],
  );
  return rows[0] || null;
}

export async function getWordingChecklist(pool, entity) {
  const { idColumn, id } = entityColumns(entity);
  const { rows } = await pool.query(
    `SELECT i.item_key, i.section_key, i.section_title, i.label, i.display_order,
            COALESCE(c.status, 'unknown') AS status,
            c.source, c.evidence, c.checked_at, c.document_id, c.analysis_run_id,
            d.doc_type AS document_type, d.title AS document_title, d.file_name AS document_file_name
       FROM public.wording_checklist_item i
       LEFT JOIN public.contract_wording_checklist c
         ON c.item_key = i.item_key
        AND c.${idColumn} = $1
       LEFT JOIN public.contract_document d ON d.document_id = c.document_id
      WHERE i.is_active = true
      ORDER BY i.display_order, i.item_key`,
    [id],
  );
  const latestRun = await loadLatestRun(pool, entity);
  return { items: rows, latest_run: latestRun };
}

export async function saveWordingChecklist(pool, entity, inputItems = [], options = {}) {
  const { type, id, idColumn } = entityColumns(entity);
  const actorUserId = safeActorUserId(options.actorUserId);
  const items = Array.isArray(inputItems) ? inputItems : [];
  if (!items.length) return getWordingChecklist(pool, entity);

  // Normalize up front, last-write-wins on duplicate keys (the old
  // per-item delete+insert loop had the same semantics), so the whole
  // save is two round-trips instead of 2N inside the transaction.
  const byKey = new Map();
  for (const item of items) {
    const itemKey = String(item?.item_key || item?.key || '').trim();
    if (!itemKey) continue;
    byKey.set(itemKey, {
      itemKey,
      status: normalizeStatus(item?.status),
      source: normalizeSource(item?.source || options.source || 'manual'),
      evidence: cleanEvidence(item?.evidence),
      documentId: item?.document_id || options.documentId || null,
      analysisRunId: item?.analysis_run_id || options.analysisRunId || null,
    });
  }
  const rows = [...byKey.values()];
  if (!rows.length) return getWordingChecklist(pool, entity);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `DELETE FROM public.contract_wording_checklist
        WHERE ${idColumn} = $1
          AND item_key = ANY($2::text[])`,
      [id, rows.map((r) => r.itemKey)],
    );
    await client.query(
      `INSERT INTO public.contract_wording_checklist
        (contract_id, quote_id, item_key, status, source, evidence, checked_at, checked_by_user_id, document_id, analysis_run_id)
       SELECT $1, $2, u.item_key, u.status, u.source, u.evidence, now(), $3, u.document_id, u.analysis_run_id
         FROM unnest($4::text[], $5::text[], $6::text[], $7::text[], $8::uuid[], $9::uuid[])
              AS u(item_key, status, source, evidence, document_id, analysis_run_id)`,
      [
        type === 'contract' ? id : null,
        type === 'quote' ? id : null,
        actorUserId,
        rows.map((r) => r.itemKey),
        rows.map((r) => r.status),
        rows.map((r) => r.source),
        rows.map((r) => r.evidence),
        rows.map((r) => r.documentId),
        rows.map((r) => r.analysisRunId),
      ],
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  return getWordingChecklist(pool, entity);
}

async function findBestSlip(pool, entity) {
  const { idColumn, id } = entityColumns(entity);
  const { rows } = await pool.query(
    `SELECT document_id, file_name, mime_type, size_bytes, description, doc_type, title, storage_path, uploaded_at
       FROM public.contract_document
      WHERE ${idColumn} = $1
        AND doc_type = ANY($2::text[])
      ORDER BY CASE doc_type
          WHEN 'Final Slip' THEN 1
          WHEN 'Draft Slip' THEN 2
          WHEN 'Expiring Slip' THEN 3
          ELSE 9
        END,
        uploaded_at DESC
      LIMIT 1`,
    [id, SLIP_PRIORITY],
  );
  return rows[0] || null;
}

async function readDocumentBuffer(doc) {
  const storagePath = doc?.storage_path || '';
  if (!storagePath) return null;
  if (storagePath.startsWith('http://') || storagePath.startsWith('https://')) {
    const response = await fetch(storagePath);
    if (!response.ok) throw new Error(`Could not fetch document (${response.status})`);
    return Buffer.from(await response.arrayBuffer());
  }
  const candidates = [
    path.join(env.uploadDir, storagePath),
    path.join(env.rootDir, 'server', 'uploads', storagePath),
  ];
  for (const candidate of candidates) {
    try {
      return await fsp.readFile(candidate);
    } catch (err) {
      if (err?.code !== 'ENOENT') throw err;
    }
  }
  throw new Error('Document file not found on disk');
}

async function extractDocumentText(doc) {
  const buffer = await readDocumentBuffer(doc);
  if (!buffer) return '';
  const mime = doc?.mime_type || '';
  const name = `${doc?.file_name || ''} ${doc?.storage_path || ''}`;
  if (mime === 'application/pdf' || /\.pdf\b/i.test(name)) {
    const pdfParse = requireModule('pdf-parse');
    const parsed = await pdfParse(buffer);
    return parsed.text || '';
  }
  if (mime.startsWith('text') || /\.(txt|csv|md)\b/i.test(name)) {
    return buffer.toString('utf-8');
  }
  return '';
}

function extractJson(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  try { return JSON.parse(raw); } catch {}
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  return JSON.parse(raw.slice(start, end + 1));
}

async function callOpenAiChecklist(items, doc, documentText) {
  assertAiEnabled(); // fail-closed AI gate before any provider request
  if (!env.openaiApiKey) return null;
  const checklistJson = JSON.stringify(items.map(item => ({
    item_key: item.item_key,
    label: item.label,
    section: item.section_title,
  })));
  const prompt = [
    'Selected document:',
    `${doc.doc_type || 'Slip'} - ${doc.title || doc.file_name || doc.document_id}`,
    '',
    'Checklist items:',
    checklistJson,
    '',
    'Treaty slip text:',
    redactForLlm(documentText.slice(0, 18000)).text, // strip PII/identifiers before egress
    '',
    'Return valid JSON only in this shape:',
    '{"summary":"short summary","items":[{"item_key":"same key","status":"found|missing|partial|unknown","evidence":"short evidence or reason"}]}',
    'Every checklist item_key must appear exactly once. Mark missing when the slip does not contain the wording.',
  ].join('\n');
  const response = await fetch(OPENAI_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${env.openaiApiKey}`,
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      max_output_tokens: 3500,
      input: [
        {
          role: 'system',
          content: [{
            type: 'input_text',
            text: 'You are a senior reinsurance treaty wording analyst. Check whether required wording clauses are present in the selected slip. Return JSON only.',
          }],
        },
        {
          role: 'user',
          content: [{ type: 'input_text', text: prompt }],
        },
      ],
    }),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`OpenAI wording check failed (${response.status}): ${body.slice(0, 200)}`);
  }
  const data = await response.json();
  let text = data?.output_text;
  if (!text) {
    const parts = [];
    for (const item of data?.output || []) {
      for (const content of item?.content || []) {
        if (typeof content?.text === 'string') parts.push(content.text);
      }
    }
    text = parts.join('\n');
  }
  return extractJson(text);
}

function normalizeText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9/.,-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function keywordResults(items, documentText, reason = '') {
  const haystack = normalizeText(documentText);
  return {
    summary: reason || 'Keyword fallback completed. Please review the flags before relying on them.',
    items: items.map(item => {
      const hints = KEYWORD_HINTS[item.item_key] || normalizeText(item.label).split(' ').filter(w => w.length > 4);
      const matched = hints.find(hint => haystack.includes(normalizeText(hint)));
      return {
        item_key: item.item_key,
        status: matched ? 'found' : 'missing',
        evidence: matched ? `Matched "${matched}".` : 'No matching wording found in the selected slip.',
      };
    }),
  };
}

function normalizeAiResults(items, result) {
  const byKey = new Map();
  for (const row of Array.isArray(result?.items) ? result.items : []) {
    const key = String(row?.item_key || '').trim();
    if (!key) continue;
    byKey.set(key, {
      item_key: key,
      status: normalizeStatus(row?.status) === 'unknown' ? 'missing' : normalizeStatus(row?.status),
      evidence: cleanEvidence(row?.evidence),
    });
  }
  return {
    summary: cleanEvidence(result?.summary) || 'Wording checklist completed.',
    items: items.map(item => byKey.get(item.item_key) || {
      item_key: item.item_key,
      status: 'missing',
      evidence: 'No result returned for this wording.',
    }),
  };
}

export async function runWordingChecklistAi(pool, entity, options = {}) {
  const normalizedEntity = entityColumns(entity);
  const actorUserId = safeActorUserId(options.actorUserId);
  const items = await loadActiveItems(pool);
  const doc = await findBestSlip(pool, normalizedEntity);
  if (!doc) {
    return {
      ok: false,
      code: 'NO_SLIP_DOCUMENT',
      message: 'No Final Slip, Draft Slip, or Expiring Slip document is available.',
      ...(await getWordingChecklist(pool, normalizedEntity)),
    };
  }

  let documentText = '';
  let warning = '';
  try {
    documentText = await extractDocumentText(doc);
  } catch (err) {
    warning = err.message;
    logger.warn('[wording-checklist] text extraction failed', { error: err.message, documentId: doc.document_id });
  }

  let provider = 'heuristic';
  let rawResult = null;
  if (documentText.trim().length >= 100 && env.openaiApiKey) {
    try {
      const aiResult = await callOpenAiChecklist(items, doc, documentText);
      if (aiResult) {
        rawResult = aiResult;
        provider = 'openai';
      }
    } catch (err) {
      warning = err.message;
      logger.warn('[wording-checklist] AI check failed, using fallback', { error: err.message });
    }
  }

  if (!rawResult) {
    rawResult = keywordResults(
      items,
      documentText,
      documentText.trim()
        ? 'Keyword fallback completed because AI was unavailable.'
        : 'Selected slip had no extractable text; all items were flagged missing for review.',
    );
  }

  const normalized = normalizeAiResults(items, rawResult);
  const source = provider === 'heuristic' ? 'heuristic' : 'ai';
  const client = await pool.connect();
  let analysisRunId = null;
  try {
    await client.query('BEGIN');
    const runResult = await client.query(
      `INSERT INTO public.contract_wording_checklist_run
        (contract_id, quote_id, document_id, doc_type, provider, status, summary, raw_result)
       VALUES ($1, $2, $3, $4, $5, 'completed', $6, $7::jsonb)
       RETURNING analysis_run_id`,
      [
        normalizedEntity.type === 'contract' ? normalizedEntity.id : null,
        normalizedEntity.type === 'quote' ? normalizedEntity.id : null,
        doc.document_id,
        doc.doc_type || null,
        provider,
        normalized.summary,
        JSON.stringify(rawResult),
      ],
    );
    analysisRunId = runResult.rows[0]?.analysis_run_id || null;
    for (const item of normalized.items) {
      await client.query(
        `DELETE FROM public.contract_wording_checklist
          WHERE ${normalizedEntity.idColumn} = $1
            AND item_key = $2`,
        [normalizedEntity.id, item.item_key],
      );
      await client.query(
        `INSERT INTO public.contract_wording_checklist
          (contract_id, quote_id, item_key, status, source, evidence, checked_at, checked_by_user_id, document_id, analysis_run_id)
         VALUES ($1, $2, $3, $4, $5, $6, now(), $7, $8, $9)`,
        [
          normalizedEntity.type === 'contract' ? normalizedEntity.id : null,
          normalizedEntity.type === 'quote' ? normalizedEntity.id : null,
          item.item_key,
          item.status,
          source,
          item.evidence,
          actorUserId,
          doc.document_id,
          analysisRunId,
        ],
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  return {
    ok: true,
    provider,
    warning: warning || null,
    analysis_run_id: analysisRunId,
    source_document: doc,
    summary: normalized.summary,
    ...(await getWordingChecklist(pool, normalizedEntity)),
  };
}
