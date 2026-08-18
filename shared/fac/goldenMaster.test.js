// shared/fac/goldenMaster.test.js
//
// A golden master per rating family.
//
// The unit tests beside each family check that its arithmetic is right. This
// checks something different and harder: that it has not CHANGED. Eleven
// families share a pipeline, a credibility blend and a gross-up, so a change
// to any of them moves numbers in the others, and the change that matters is
// the one nobody meant to make.
//
// When this fails, the engine and the committed master disagree. That is a
// question, not a defect: either the change was intended — regenerate with
// `node scripts/update-fac-golden-master.mjs`, read the diff, and say in the
// commit message why the numbers moved — or it was not, in which case this
// test has done its job.
//
// The fixtures pin behaviour with rates that are FIXTURES, not shipped
// reference data. Every rate table in the module ships empty (design doc §8).

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { priceFacRiskFull } from './index.js';
import { FIXTURES, pinnedShape } from './goldenMaster.fixtures.js';
import { listFamilies } from './registry.js';

const here = dirname(fileURLToPath(import.meta.url));
const MASTER = JSON.parse(readFileSync(resolve(here, '__golden__/families.json'), 'utf8'));

describe('fac golden masters', () => {
  it('covers every implemented family — a family with no master is unguarded', () => {
    const implemented = listFamilies().filter((f) => f.implemented).map((f) => f.code).sort();
    const pinned = FIXTURES.map((f) => f.family).sort();
    // MARINE_LIABILITY shares LIABILITY_LIMIT's engine on a marine curve; the
    // liability master covers the maths, and the curve selection has its own
    // unit test. Everything else needs its own frozen answer.
    expect(pinned).toEqual(implemented.filter((c) => c !== 'MARINE_LIABILITY'));
  });

  for (const fixture of FIXTURES) {
    describe(fixture.family, () => {
      const expected = MASTER.families[fixture.family]?.expected;
      const actual = pinnedShape(priceFacRiskFull(fixture.args));

      it(`is unchanged — ${fixture.why}`, () => {
        expect(expected, `no committed master for ${fixture.family}`).toBeTruthy();
        expect(actual).toEqual(expected);
      });

      it('prices, rather than reporting itself unavailable', () => {
        // A master that froze "unavailable" would pass for ever while proving
        // nothing, so every fixture has to reach a price.
        expect(actual.ok).toBe(true);
        expect(actual.technical_gross_pm).toBeGreaterThan(0);
      });
    });
  }

  it('keeps the property invariant: the pipeline does not move the workbook rate', () => {
    // With the workbook rate as the only candidate and no loads configured,
    // the technical gross rate IS the engine's own final gross rate. This is
    // the property that made it safe to put the pipeline in front of the
    // existing engine, and it is now pinned in the committed master too.
    const property = MASTER.families.SCHEDULE_PROPERTY.expected;
    expect(property.technical_gross_pm).toBeCloseTo(property.engine_final_gross_rate_pm, 8);
  });

  it('keeps war and sub-limits out of the blend and beside it', () => {
    const hull = MASTER.families.HULL_VALUE.expected;
    const energy = MASTER.families.ENERGY_ASSET.expected;
    for (const priced of [hull, energy]) {
      // The additive sections raise the expected loss without touching the
      // blended loss cost — averaging them in is the error being guarded.
      expect(priced.additive_load_pm).toBeGreaterThan(0);
      expect(priced.expected_loss_pm).toBeCloseTo(
        priced.blended_loss_cost_pm + priced.additive_load_pm, 8,
      );
    }
  });

  it('rates each family against its own premium base', () => {
    const base = (code) => MASTER.families[code].expected.sections[0]?.premium_base;
    // Casualty against turnover, cargo against sendings, hull against agreed
    // value, cyber against revenue. One sum insured for all of them was the
    // shortcut this design removed.
    expect(base('LIABILITY_LIMIT')).toBe(250_000_000);
    expect(base('TRANSIT_VALUES')).toBe(100_000_000);
    expect(base('HULL_VALUE')).toBe(30_000_000);
    expect(base('CYBER_LIMIT')).toBe(400_000_000);
    expect(base('PROJECT_WORKS')).toBe(200_000_000);
  });
});
