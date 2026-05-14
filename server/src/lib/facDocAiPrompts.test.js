import { describe, it, expect } from 'vitest';
import { buildFacSystemPrompt, facAiResponseSchema, FAC_AI_DOCUMENT_KINDS }
  from './facDocAiPrompts.js';

describe('buildFacSystemPrompt', () => {
  it('exports the canonical document-kind list', () => {
    expect(FAC_AI_DOCUMENT_KINDS).toEqual([
      'PLACEMENT_SLIP', 'SURVEY_REPORT', 'CLAIMS_BORDEREAU',
      'COPE_REPORT', 'WORDING', 'OTHER',
    ]);
  });

  it('inlines the supplied occupancy catalogue into the placement-slip prompt', () => {
    const out = buildFacSystemPrompt('PLACEMENT_SLIP', {
      occupancyNames: ['Hospitals', 'Aerated Water Factories'],
    });
    expect(out).toMatch(/Hospitals/);
    expect(out).toMatch(/Aerated Water Factories/);
    expect(out).toMatch(/Return ONLY a JSON object/);
  });

  it('inlines the factor options for the survey-report prompt', () => {
    const out = buildFacSystemPrompt('SURVEY_REPORT', {
      factorOptions: {
        CONSTRUCTION: ['Class A - RCC roof and Structure', 'Class C - Partially Combustible Construction'],
        SURVEY_RATING: ['Excellent', 'Average'],
      },
    });
    expect(out).toMatch(/factor\.CONSTRUCTION:/);
    expect(out).toMatch(/Class A - RCC roof and Structure/);
    expect(out).toMatch(/factor\.SURVEY_RATING:/);
    expect(out).toMatch(/Excellent/);
  });

  it('claims bordereau prompt asks for loss_history.append entries', () => {
    const out = buildFacSystemPrompt('CLAIMS_BORDEREAU');
    expect(out).toMatch(/loss_history\.append/);
    expect(out).toMatch(/FAC_LOSS_HISTORY/);
  });

  it('wording prompt lists the clause names', () => {
    const out = buildFacSystemPrompt('WORDING', { clauseNames: ['LM7', 'LMA 3100'] });
    expect(out).toMatch(/LM7/);
    expect(out).toMatch(/LMA 3100/);
  });

  it('throws on an unknown document kind', () => {
    expect(() => buildFacSystemPrompt('NOT_A_KIND')).toThrow(/Unknown document_kind/);
  });

  it('every prompt ends with the "Return ONLY a JSON object" instruction', () => {
    for (const kind of FAC_AI_DOCUMENT_KINDS) {
      const out = buildFacSystemPrompt(kind, { factorOptions: {}, occupancyNames: [], clauseNames: [] });
      expect(out).toMatch(/Return ONLY a JSON object\. No markdown\. No backticks\./);
    }
  });
});

describe('facAiResponseSchema', () => {
  it('accepts a well-formed example', () => {
    const sample = {
      summary: 'A short summary of the document.',
      extracted: { cedant_name: 'ACME Re' },
      recommendations: [
        {
          target_screen: 'FAC_PRICING',
          target_field: 'factor.CONSTRUCTION',
          suggested_value: 'Class A - RCC roof and Structure',
          rationale: 'Section 3.1 of the survey describes the building.',
          confidence: 0.85,
        },
      ],
    };
    const out = facAiResponseSchema.parse(sample);
    expect(out.recommendations).toHaveLength(1);
    expect(out.recommendations[0].confidence).toBe(0.85);
  });

  it('rejects a non-string summary', () => {
    const sample = {
      summary: 1234,
      extracted: {},
      recommendations: [],
    };
    expect(() => facAiResponseSchema.parse(sample))
      .toThrow();
  });

  it('rejects a recommendation with confidence > 1', () => {
    const sample = {
      summary: 'ok',
      extracted: {},
      recommendations: [{
        target_screen: 'FAC_RISK_DETAIL',
        target_field: 'cedant_name',
        suggested_value: 'ACME',
        rationale: 'header block of slip',
        confidence: 1.5,
      }],
    };
    expect(() => facAiResponseSchema.parse(sample)).toThrow(/less than or equal to 1/);
  });

  it('rejects a recommendation with an unknown target_screen', () => {
    const sample = {
      summary: 'ok', extracted: {},
      recommendations: [{
        target_screen: 'SOMEWHERE_ELSE',
        target_field: 'x',
        suggested_value: 1,
        rationale: 'r',
        confidence: 0.5,
      }],
    };
    expect(() => facAiResponseSchema.parse(sample)).toThrow();
  });

  it('truncation-aware: rejects rationale > 500 chars', () => {
    const long = 'a'.repeat(501);
    expect(() => facAiResponseSchema.parse({
      summary: 'ok', extracted: {},
      recommendations: [{
        target_screen: 'FAC_RISK_DETAIL',
        target_field: 'cedant_name',
        suggested_value: 'ACME',
        rationale: long,
        confidence: 0.5,
      }],
    })).toThrow(/≤ 500 chars/);
  });
});
