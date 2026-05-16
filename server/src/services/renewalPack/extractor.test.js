// Tests for the renewal-pack LLM extractor.
//
// We inject a fake `callLlm` (no network) so the tests focus on:
//   1. the schema lookup + validation pipeline,
//   2. the retry behaviour on a malformed first response,
//   3. graceful degradation when both attempts fail validation.
//
// One PROP and one NP fixture are run end-to-end through parser → extractor
// to keep us honest about the parser/extractor contract.

import { describe, it, expect, vi } from 'vitest';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { parseRenewalPack } from './parser.js';
import { extractRenewalPack } from './extractor.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.resolve(__dirname, '../../../../test/fixtures/renewal-packs');

// ── shared leaf helpers ──────────────────────────────────────────────────────

const lf = (value, confidence = 1, source = 'test:A1') => ({ value, confidence, source });

function propResponseFromParsed(parsed) {
  const pt = parsed.sheets.premiumTriangle;
  const ct = parsed.sheets.claimsTriangle;
  const ost = parsed.sheets.osClaimsTriangle;
  return {
    cedant: lf(parsed.cedant || 'Test Cedant'),
    treatyName: lf('Property Quota Share 2025'),
    classes: lf(parsed.classes?.length ? parsed.classes : ['Fire']),
    uwYearRange: lf(parsed.uwYearRange || [2017, 2026]),
    premium: {
      triangle: pt ? { ...pt, source: 'Premium Triangle:A1:Z99', confidence: 1 } : null,
      latestEarned: lf(1_500_000),
      growthAssumption: lf(5),
    },
    claims: {
      triangle: ct ? { ...ct, source: 'Claims Triangle:A1:Z99', confidence: 1 } : null,
      ultimateLossRatio: lf(62.5, 0.7, 'Premium Triangle:derived'),
    },
    osTriangle: ost ? { ...ost, source: 'OS Claims Triangle:A1:Z99', confidence: 1 } : null,
    largeLosses: (parsed.sheets.largeLossRecords || []).slice(0, 3).map((l) => ({
      uwYear: lf(l.uwYear),
      insuredName: lf(l.insuredName),
      description: lf(l.lossName ?? ''),
      date: lf(l.dateOfLoss ?? ''),
      classOfBusiness: lf(l.classOfBusiness),
      paid: lf(l.paid),
      os: lf(l.os),
      incurred: lf(l.incurred),
    })),
    catLosses: [],
    riskProfile: {
      books: (parsed.sheets.riskProfile || []).map((p) => ({
        label: p.label,
        bands: (p.rows || []).slice(0, 2).map((b) => ({
          bandMin: lf(b.bandMin),
          bandMax: lf(b.bandMax),
          numPolicies: lf(b.numPolicies),
          sumInsured: lf(b.sumInsured),
          premiums: lf(b.premiums),
          avgSumInsured: lf(b.avgSumInsured),
          avgPremium: lf(b.avgPremium),
          ratePct: lf(b.ratePct),
        })),
        source: 'Risk Profile',
      })),
    },
    claimsProfile: { books: [] },
    cresta: { countries: [] },
    hasTriangles: !!(pt || ct || ost),
  };
}

function npResponseFromParsed(parsed) {
  return {
    cedant: lf(parsed.cedant || 'Test Cedant'),
    treatyName: lf('Property XL 2025'),
    classes: lf(parsed.classes || ['Property XL']),
    uwYearRange: lf(parsed.uwYearRange || [2017, 2025]),
    layers: (parsed.sheets.treatyLayers || []).map((l) => ({
      layer: lf(l.layer),
      limit: lf(l.limit),
      attachment: lf(l.attachment),
      aggLimit: lf(l.aggLimit),
      egnpi: lf(l.egnpi),
      rate: lf(l.rate),
      earnedPremium: lf(l.earnedPremium),
      mdp: lf(l.mdp),
      mdpAlt: lf(l.mdpAlt),
      reinstatements: lf(l.reinstatements),
      reinstatementPct: lf(l.reinstatementPct),
    })),
    egnpiHistory: (parsed.sheets.egnpi || []).map((row) => ({
      year: lf(row.year),
      egnpi: lf(row.egnpi),
    })),
    largeLosses: (parsed.sheets.largeLossRecords || []).slice(0, 2).map((l) => ({
      uwYear: lf(l.uwYear),
      insuredName: lf(l.insuredName),
      description: lf(l.lossName ?? ''),
      date: lf(l.dateOfLoss ?? ''),
      classOfBusiness: lf(l.classOfBusiness),
      paid: lf(l.paid),
      os: lf(l.os),
      incurred: lf(l.incurred),
    })),
    catLosses: [],
    riskProfile: { books: [] },
    claimsProfile: { books: [] },
    cresta: { countries: [] },
    hasTriangles: false,
  };
}

function fakeCallLlm({ text, provider = 'gemini' }) {
  return vi.fn(async () => ({ text, provider, raw: { fake: true } }));
}

// ── tests ────────────────────────────────────────────────────────────────────

describe('extractRenewalPack — PROP', () => {
  it('parses a happy-path PROP fixture end-to-end through a mocked LLM', async () => {
    const buf = fs.readFileSync(path.join(FIXTURES_DIR, 'PROP_01.xlsx'));
    const parsed = await parseRenewalPack(buf);
    const fake = fakeCallLlm({ text: JSON.stringify(propResponseFromParsed(parsed)) });
    const out = await extractRenewalPack(parsed, { callLlm: fake });

    expect(fake).toHaveBeenCalledTimes(1);
    expect(out.type).toBe('proportional');
    expect(out.provider).toBe('gemini');
    expect(out.extraction).not.toBeNull();
    expect(out.extraction.cedant.value).toBe('Acme Insurance Co');
    expect(out.extraction.hasTriangles).toBe(true);
    expect(out.extraction.premium.triangle).not.toBeNull();
    expect(out.warnings).toEqual([]);
  });

  it('passes maxOutputTokens=16384 by default', async () => {
    const buf = fs.readFileSync(path.join(FIXTURES_DIR, 'PROP_01.xlsx'));
    const parsed = await parseRenewalPack(buf);
    const fake = fakeCallLlm({ text: JSON.stringify(propResponseFromParsed(parsed)) });
    await extractRenewalPack(parsed, { callLlm: fake });

    expect(fake.mock.calls[0][0].maxOutputTokens).toBe(16_384);
    expect(fake.mock.calls[0][0].temperature).toBe(0);
  });

  it('retries once when the first attempt is malformed JSON, succeeds on retry', async () => {
    const buf = fs.readFileSync(path.join(FIXTURES_DIR, 'PROP_01.xlsx'));
    const parsed = await parseRenewalPack(buf);
    const valid = JSON.stringify(propResponseFromParsed(parsed));
    const fake = vi
      .fn()
      .mockResolvedValueOnce({ text: 'not even JSON {{{', provider: 'gemini', raw: {} })
      .mockResolvedValueOnce({ text: valid, provider: 'gemini', raw: {} });

    const out = await extractRenewalPack(parsed, { callLlm: fake });

    expect(fake).toHaveBeenCalledTimes(2);
    expect(out.extraction).not.toBeNull();
    expect(out.extraction.cedant.value).toBe('Acme Insurance Co');
    expect(out.warnings.some((w) => w.includes('non-JSON on first attempt'))).toBe(true);
  });

  it('retries once when the first attempt fails Zod validation', async () => {
    const buf = fs.readFileSync(path.join(FIXTURES_DIR, 'PROP_01.xlsx'));
    const parsed = await parseRenewalPack(buf);
    const valid = JSON.stringify(propResponseFromParsed(parsed));
    // First response: missing required field hasTriangles.
    const broken = propResponseFromParsed(parsed);
    delete broken.hasTriangles;
    const fake = vi
      .fn()
      .mockResolvedValueOnce({ text: JSON.stringify(broken), provider: 'gemini', raw: {} })
      .mockResolvedValueOnce({ text: valid, provider: 'gemini', raw: {} });

    const out = await extractRenewalPack(parsed, { callLlm: fake });

    expect(fake).toHaveBeenCalledTimes(2);
    expect(out.extraction).not.toBeNull();
    expect(out.warnings.some((w) => w.includes('Schema validation failed on first attempt'))).toBe(true);
  });

  it('returns the partial extraction in warnings when retry also fails', async () => {
    const buf = fs.readFileSync(path.join(FIXTURES_DIR, 'PROP_01.xlsx'));
    const parsed = await parseRenewalPack(buf);
    const broken = propResponseFromParsed(parsed);
    delete broken.hasTriangles;
    const fake = vi
      .fn()
      .mockResolvedValue({ text: JSON.stringify(broken), provider: 'gemini', raw: {} });

    const out = await extractRenewalPack(parsed, { callLlm: fake });

    expect(fake).toHaveBeenCalledTimes(2);
    expect(out.extraction).not.toBeNull();
    expect(out.extraction.cedant.value).toBe('Acme Insurance Co');
    expect(out.warnings.filter((w) => w.includes('Schema validation failed')).length).toBe(2);
  });

  it('propagates a hard LLM failure on attempt 1', async () => {
    const buf = fs.readFileSync(path.join(FIXTURES_DIR, 'PROP_01.xlsx'));
    const parsed = await parseRenewalPack(buf);
    const fake = vi.fn(async () => {
      throw new Error('All LLM providers failed: gemini: 500 | openai: 500');
    });
    await expect(extractRenewalPack(parsed, { callLlm: fake })).rejects.toThrow(/LLM call failed/);
  });
});

describe('extractRenewalPack — NP', () => {
  it('parses a happy-path NP fixture end-to-end through a mocked LLM', async () => {
    const buf = fs.readFileSync(path.join(FIXTURES_DIR, 'NP_01.xlsx'));
    const parsed = await parseRenewalPack(buf);
    const fake = fakeCallLlm({ text: JSON.stringify(npResponseFromParsed(parsed)) });
    const out = await extractRenewalPack(parsed, { callLlm: fake });

    expect(out.type).toBe('non_proportional');
    expect(out.extraction).not.toBeNull();
    expect(out.extraction.cedant.value).toBe('Lambda Re');
    expect(out.extraction.hasTriangles).toBe(false);
    expect(out.extraction.layers.length).toBeGreaterThan(0);
    expect(out.extraction.layers[0].layer.value).toMatch(/^L\d+/);
    expect(out.extraction.egnpiHistory.length).toBeGreaterThan(0);
    expect(out.warnings).toEqual([]);
  });

  it('rejects an NP response that sets hasTriangles=true', async () => {
    const buf = fs.readFileSync(path.join(FIXTURES_DIR, 'NP_01.xlsx'));
    const parsed = await parseRenewalPack(buf);
    const bad = npResponseFromParsed(parsed);
    bad.hasTriangles = true; // violates z.literal(false)

    // Retry returns the same bad payload — both attempts fail validation.
    const fake = vi.fn().mockResolvedValue({ text: JSON.stringify(bad), provider: 'gemini', raw: {} });
    const out = await extractRenewalPack(parsed, { callLlm: fake });

    expect(fake).toHaveBeenCalledTimes(2);
    expect(out.warnings.filter((w) => w.includes('Schema validation failed')).length).toBe(2);
    // Best-effort: the partial JSON is returned so a UI can still render
    // whatever survived (layers, EGNPI, etc.).
    expect(out.extraction).not.toBeNull();
  });

  it('refuses unknown parser types', async () => {
    await expect(
      extractRenewalPack({ type: 'something_else', sheets: {}, unknown: [], warnings: [] }, { callLlm: vi.fn() }),
    ).rejects.toThrow(/unsupported type/);
  });

  it('throws when input is not a parsed pack object', async () => {
    await expect(extractRenewalPack(null, { callLlm: vi.fn() })).rejects.toThrow(/parsedPack must be/);
  });
});

describe('extractRenewalPack — warning passthrough', () => {
  it('carries parser warnings forward into the extractor result', async () => {
    const buf = fs.readFileSync(path.join(FIXTURES_DIR, 'PROP_01.xlsx'));
    const parsed = await parseRenewalPack(buf);
    parsed.warnings = ['parser noticed something weird'];
    const fake = fakeCallLlm({ text: JSON.stringify(propResponseFromParsed(parsed)) });
    const out = await extractRenewalPack(parsed, { callLlm: fake });

    expect(out.warnings).toContain('parser noticed something weird');
  });
});
