// goldenMaster.test.jsx — Golden master for the NpStructure screen.
//
// Captures the EXACT computed output of the layer-structure math
// (deductible cascade, earned premium, ROL, MDP%, totals, expiring
// recalc, covered-props capacity) as literal values BEFORE the Phase 4.2
// decomposition. Every expectation below was verified against the
// pre-refactor screen; the refactor must keep them byte-identical.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import NpStructure from './NpStructure.jsx';
import { renderBindScreen } from '../../../test/bindPathTestUtils.jsx';
import { bindIds, makeBindPathApiMock } from '../../../test/bindPathFixtures.js';

const { apiMock } = vi.hoisted(() => ({ apiMock: {} }));

vi.mock('../../../api', () => ({ api: apiMock }));

function resetApi(overrides = {}) {
  Object.keys(apiMock).forEach((key) => delete apiMock[key]);
  Object.assign(apiMock, makeBindPathApiMock(vi.fn, overrides));
}

function renderScreen(detailOverrides = {}) {
  return renderBindScreen(<NpStructure />, {
    route: '/np/structure',
    contractId: bindIds.contract,
    appState: {
      wizardMode: 'NP',
      npTreatyDetail: {
        contractId: bindIds.contract,
        currencyCode: 'SAR',
        xlType: 'RISK',
        numberOfLayers: 2,
        expiringNumberOfLayers: 1,
        deductible: 100000,
        ...detailOverrides,
      },
      npStructureLayers: [],
    },
  });
}

/* Layer / expiring rows share one input layout:
   [0]=limit [1]=deductible [2]=aggLimit [3]=egnpi [4]=rate [5]=earnedPremium
   [6]=mdp [7]=mdpPct [8]=reinstatementPct [9]=aad(chk) [10]=aadAmount
   [11]=risk(chk) [12]=cat(chk) [13]=rol — the reinstatements <select> sits
   between [7] and [8] but is not an <input>. */
function rowValues(row) {
  const inputs = row.querySelectorAll('input');
  const select = row.querySelector('select');
  return {
    limit: inputs[0].value,
    deductible: inputs[1].value,
    aggLimit: inputs[2].value,
    egnpi: inputs[3].value,
    rate: inputs[4].value,
    earnedPremium: inputs[5].value,
    mdp: inputs[6].value,
    mdpPct: inputs[7].value,
    reinstatements: select.value,
    reinstatementPct: inputs[8].value,
    aad: inputs[9].checked,
    aadAmount: inputs[10].value,
    risk: inputs[11].checked,
    cat: inputs[12].checked,
    rol: inputs[13].value,
  };
}

/* tfoot totals row: [0]=limit [1]=deductible [2]=aggLimit [3]=egnpi [4]=rate
   [5]=earnedPremium [6]=mdp [7]=mdpPct [8]=maxReinstatements [9]=rol */
function totalsValues(tfootRow) {
  const inputs = tfootRow.querySelectorAll('input');
  return {
    limit: inputs[0].value,
    deductible: inputs[1].value,
    aggLimit: inputs[2].value,
    egnpi: inputs[3].value,
    rate: inputs[4].value,
    earnedPremium: inputs[5].value,
    mdp: inputs[6].value,
    mdpPct: inputs[7].value,
    maxReinstatements: inputs[8].value,
    rol: inputs[9].value,
  };
}

function layerRow(container, i) {
  return container.querySelector(`tr[data-layer-row="${i}"]`);
}
function expRow(container, i) {
  return container.querySelector(`tr[data-exp-row="${i}"]`);
}
function layersTfoot(container) {
  return container.querySelector('#npLayersCard tfoot tr');
}
function expiringTfoot(container) {
  return expRow(container, 0).closest('table').querySelector('tfoot tr');
}
function termInput(label) {
  return screen.getByText(label).parentElement.querySelector('input');
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

beforeEach(() => {
  resetApi();
});

describe('NpStructure golden master (standard mode, BOTH peril mode)', () => {
  it('reproduces every computed cell across load, cascade edits, layer count changes and save', async () => {
    const { container } = renderScreen();

    /* ═══ 1. Initial render with saved relational layers ═══ */
    expect(await screen.findByText(/Treaty Structure/i)).toBeInTheDocument();
    await waitFor(() => expect(container.querySelectorAll('tr[data-layer-row]')).toHaveLength(2));
    // EGNPI 1,000,000 × rate 5% → earned premium 50,000 (recalc applied on load)
    await waitFor(() => expect(rowValues(layerRow(container, 0)).earnedPremium).toBe('50,000'));

    expect(rowValues(layerRow(container, 0))).toEqual({
      limit: '500,000',
      deductible: '100,000',
      aggLimit: '750,000',
      egnpi: '1,000,000',
      rate: '5%',
      earnedPremium: '50,000',   // 1,000,000 × 5 / 100
      mdp: '10,000',
      mdpPct: '20%',             // 10,000 / 50,000
      reinstatements: '2',
      reinstatementPct: '100%',
      aad: true,
      aadAmount: '5,000',
      risk: true,                // peril_scope BOTH
      cat: true,
      rol: '10%',                // 50,000 / 500,000
    });
    expect(rowValues(layerRow(container, 1))).toEqual({
      limit: '1,000,000',
      deductible: '600,000',     // from DB; load does NOT re-cascade
      aggLimit: '1,500,000',
      egnpi: '1,000,000',
      rate: '3%',
      earnedPremium: '30,000',   // 1,000,000 × 3 / 100
      mdp: '',
      mdpPct: '',
      reinstatements: '1',
      reinstatementPct: '100%',
      aad: false,
      aadAmount: '',
      risk: true,                // peril_scope RISK
      cat: false,
      rol: '3%',                 // 30,000 / 1,000,000
    });
    expect(totalsValues(layersTfoot(container))).toEqual({
      limit: '1,500,000',
      deductible: '100,000',     // layer 1 attachment
      aggLimit: '2,250,000',
      egnpi: '1,000,000',        // max, not sum
      rate: '8%',                // 5 + 3
      earnedPremium: '80,000',
      mdp: '10,000',
      mdpPct: '12.5%',           // 10,000 / 80,000
      maxReinstatements: '2',
      rol: '5.33%',              // (5%×1,000,000 + 3%×1,000,000) / 1,500,000
    });

    /* COB participation reconstructed from UW limits + junction ids */
    await screen.findByText('Motor');
    const cobTable = container.querySelector('.np-cob-table');
    const cobRows = cobTable.querySelectorAll('tbody tr');
    expect(cobRows).toHaveLength(2);
    const motorInputs = cobRows[0].querySelectorAll('input');
    expect(cobRows[0].textContent).toContain('Motor');
    expect(motorInputs[0].value).toBe('550,000');
    expect(motorInputs[1].checked).toBe(true);   // L1: motor in junction ids
    expect(motorInputs[2].checked).toBe(false);  // L2: not participating
    const propInputs = cobRows[1].querySelectorAll('input');
    expect(cobRows[1].textContent).toContain('Property');
    expect(propInputs[0].value).toBe('1,200,000');
    expect(propInputs[1].checked).toBe(true);
    expect(propInputs[2].checked).toBe(true);

    /* Covered props gated off for non-Net-XL treaties */
    expect(screen.getByText('Proportional structure is only required for Net XL treaties.')).toBeInTheDocument();
    expect(screen.getByText('Only required for Net XL treaties.')).toBeInTheDocument();

    /* ═══ 2. Expiring structure hydration + recalc ═══ */
    await waitFor(() => expect(expRow(container, 0)).not.toBeNull());
    // EP recomputed from EGNPI×rate (800,000 × 4% = 32,000), overwriting DB 700,000
    await waitFor(() => expect(rowValues(expRow(container, 0)).earnedPremium).toBe('32,000'));
    expect(rowValues(expRow(container, 0))).toEqual({
      limit: '400,000',
      deductible: '90,000',
      aggLimit: '500,000',
      egnpi: '800,000',
      rate: '4%',
      earnedPremium: '32,000',   // recomputed, overrides DB earned_premium=700,000
      mdp: '5,000',
      mdpPct: '15.63%',          // 5,000 / 32,000
      reinstatements: '1',
      reinstatementPct: '100%',
      aad: true,
      aadAmount: '3,000',
      risk: true,                // peril RISK
      cat: false,
      rol: '8%',                 // 32,000 / 400,000 — overrides DB rol=9
    });
    expect(totalsValues(expiringTfoot(container))).toEqual({
      limit: '400,000',
      deductible: '90,000',
      aggLimit: '500,000',
      egnpi: '800,000',
      rate: '4%',
      earnedPremium: '32,000',
      mdp: '5,000',
      mdpPct: '15.63%',
      maxReinstatements: '1',
      rol: '8%',
    });
    expect(termInput('Brokerage %').value).toBe('6');
    expect(termInput('NCB %').value).toBe('1');
    expect(termInput('Profit Comm. %').value).toBe('2');

    /* ═══ 3. Layer-field edit → deductible cascade recalc ═══ */
    fireEvent.change(layerRow(container, 0).querySelectorAll('input')[0], { target: { value: '600000' } });
    await waitFor(() => expect(rowValues(layerRow(container, 1)).deductible).toBe('700,000')); // 100,000 + 600,000
    expect(rowValues(layerRow(container, 0)).rol).toBe('8.33%');          // 50,000 / 600,000
    expect(rowValues(layerRow(container, 0)).earnedPremium).toBe('50,000'); // unchanged by limit edit
    expect(totalsValues(layersTfoot(container)).limit).toBe('1,600,000');
    expect(totalsValues(layersTfoot(container)).rol).toBe('5%');           // 80,000 / 1,600,000
    // COB auto-coverage after cascade: UW limit must EXCEED new attachment
    expect(cobRows[0].querySelectorAll('input')[2].checked).toBe(false);   // motor 550,000 < 700,000
    expect(cobRows[1].querySelectorAll('input')[2].checked).toBe(true);    // property 1,200,000 > 700,000

    /* Rate edit → earned premium / ROL / MDP% recompute */
    fireEvent.change(layerRow(container, 0).querySelectorAll('input')[4], { target: { value: '4' } });
    await waitFor(() => expect(rowValues(layerRow(container, 0)).earnedPremium).toBe('40,000')); // 1,000,000 × 4%
    expect(rowValues(layerRow(container, 0)).rol).toBe('6.67%');           // 40,000 / 600,000
    expect(rowValues(layerRow(container, 0)).mdpPct).toBe('25%');          // 10,000 / 40,000
    expect(totalsValues(layersTfoot(container))).toEqual({
      limit: '1,600,000',
      deductible: '100,000',
      aggLimit: '2,250,000',
      egnpi: '1,000,000',
      rate: '7%',
      earnedPremium: '70,000',
      mdp: '10,000',
      mdpPct: '14.29%',          // 10,000 / 70,000
      maxReinstatements: '2',
      rol: '4.38%',              // (4%×1,000,000 + 3%×1,000,000) / 1,600,000
    });

    /* ═══ 4. Layer count change ═══ */
    fireEvent.click(screen.getByRole('button', { name: /\+ add layer/i }));
    await waitFor(() => expect(container.querySelectorAll('tr[data-layer-row]')).toHaveLength(3));
    expect(rowValues(layerRow(container, 2))).toEqual({
      limit: '',
      deductible: '1,700,000',   // 700,000 + 1,000,000 cascade
      aggLimit: '',
      egnpi: '',
      rate: '',
      earnedPremium: '',
      mdp: '',
      mdpPct: '',
      reinstatements: '',
      reinstatementPct: '',
      aad: false,
      aadAmount: '',
      risk: true,
      cat: true,
      rol: '',
    });
    // COB table grows a LAYER 3 column; neither UW limit exceeds 1,700,000
    expect(cobRows[0].querySelectorAll('input')[3].checked).toBe(false);
    expect(cobRows[1].querySelectorAll('input')[3].checked).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: /delete layer/i }));
    await waitFor(() => expect(container.querySelectorAll('tr[data-layer-row]')).toHaveLength(2));
    expect(totalsValues(layersTfoot(container)).limit).toBe('1,600,000');

    /* ═══ 5. Expiring layer edit → expiring recalc ═══ */
    fireEvent.change(expRow(container, 0).querySelectorAll('input')[0], { target: { value: '320000' } });
    await waitFor(() => expect(rowValues(expRow(container, 0)).rol).toBe('10%')); // 32,000 / 320,000
    expect(rowValues(expRow(container, 0)).earnedPremium).toBe('32,000');
    expect(totalsValues(expiringTfoot(container)).rol).toBe('10%');
    fireEvent.change(termInput('Brokerage %'), { target: { value: '7.5' } });
    expect(termInput('Brokerage %').value).toBe('7.5');

    /* ═══ 6. Implied pricing curve modal (needs ≥2 expiring layers) ═══ */
    fireEvent.click(screen.getByRole('button', { name: /view implied pricing curve/i }));
    expect(await screen.findByText(/at least two expiring layers to display the implied power curve/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /close/i }));
    await waitFor(() =>
      expect(screen.queryByText(/at least two expiring layers to display the implied power curve/i)).not.toBeInTheDocument());

    /* ═══ 7. Save payloads (relational + JSONB + expiring) ═══ */
    fireEvent.click(screen.getByRole('button', { name: /go to next step/i }));
    await waitFor(() => expect(apiMock.saveNpExpiring).toHaveBeenCalled());

    const [, payload] = apiMock.saveNonPropTreaty.mock.calls.at(-1);
    expect(payload).toEqual({
      layers: [
        {
          layer_number: 1,
          attachment: 100000,
          layer_limit: 600000,
          aggregate_limit: 750000,
          egnpi: 1000000,
          earned_premium: 40000,
          rate: 4,
          rol: 6.67,
          num_reinstatements: 2,
          reinstatement_pct: 100,
          annual_agg_deductible: 5000,
          peril_scope: 'BOTH',
          mdp: 10000,
          mdp_pct: 25,
          class_of_business_ids: [bindIds.cobMotor, bindIds.cobProperty],
        },
        {
          layer_number: 2,
          attachment: 700000,
          layer_limit: 1000000,
          aggregate_limit: 1500000,
          egnpi: 1000000,
          earned_premium: 30000,
          rate: 3,
          rol: 3,
          num_reinstatements: 1,
          reinstatement_pct: 100,
          annual_agg_deductible: null,
          peril_scope: 'RISK',
          mdp: null,
          mdp_pct: null,
          class_of_business_ids: [bindIds.cobProperty],
        },
      ],
      cob_underwriting_limits: [
        { cob_id: bindIds.cobMotor, limit_amount: 550000 },
        { cob_id: bindIds.cobProperty, limit_amount: 1200000 },
      ],
      terms: {
        np_structure: {
          layers: [
            {
              layer: 1, limit: '600000', deductible: '100000',
              annualAggLimit: '750000', egnpi: '1000000', rate: '4',
              earnedPremium: '40000', mdp: '10000', mdpPct: '25%',
              reinstatements: '2', reinstatementPct: '100',
              aad: true, aadAmount: '5000',
              riskCover: true, catCover: true, rol: '6.67%',
            },
            {
              layer: 2, limit: '1000000', deductible: '700000',
              annualAggLimit: '1500000', egnpi: '1000000', rate: '3',
              earnedPremium: '30000', mdp: '', mdpPct: '',
              reinstatements: '1', reinstatementPct: '100',
              aad: false, aadAmount: '',
              riskCover: true, catCover: false, rol: '3%',
            },
          ],
          // Add-then-delete leaves the stale 3rd flag — current behaviour.
          cobRows: [
            {
              cobId: bindIds.cobMotor, name: 'Motor', code: '',
              underwritingLimit: '550000',
              layers: [true, false, false], manual: [false, false, false],
            },
            {
              cobId: bindIds.cobProperty, name: 'Property', code: '',
              underwritingLimit: '1200000',
              layers: [true, true, false], manual: [false, false, false],
            },
          ],
          coveredProps: [],
        },
      },
    });

    const [, expPayload] = apiMock.saveNpExpiring.mock.calls.at(-1);
    expect(expPayload).toEqual({
      layers: [
        {
          layer_number: 1,
          attachment: 90000,
          layer_limit: 320000,
          aggregate_limit: 500000,
          egnpi: 800000,
          earned_premium: 32000,
          rate: 4,
          rol: 10,
          num_reinstatements: 1,
          reinstatement_pct: 100,
          annual_agg_deductible: 3000,
          peril_scope: 'RISK',
          mdp: 5000,
          mdp_pct: 15.63,
        },
      ],
      terms: {
        egnpi: '800000',
        deductible: '9000',
        risk_limit: '400000',
        cat_limit: '0',
        brokerage_pct: '7.5',
        no_claims_bonus_pct: '1',
        profit_commission_pct: '2',
        notes: 'expiring audit',
      },
      coveredProps: [],
    });
  });
});

describe('NpStructure golden master (Risk XL mode + Net XL covered props)', () => {
  it('locks peril covers to the treaty mode and computes covered-prop capacity', async () => {
    const { container } = renderScreen({ treatyTypeName: 'Risk XL', xlType: 'Net XL' });

    await screen.findByText(/Treaty Structure/i);
    await waitFor(() => expect(container.querySelectorAll('tr[data-layer-row]')).toHaveLength(2));
    await waitFor(() => expect(rowValues(layerRow(container, 0)).earnedPremium).toBe('50,000'));

    /* RISK mode forces risk on / cat off on every layer (L1 was BOTH in DB) */
    const r0 = rowValues(layerRow(container, 0));
    expect(r0.risk).toBe(true);
    expect(r0.cat).toBe(false);
    const r1 = rowValues(layerRow(container, 1));
    expect(r1.risk).toBe(true);
    expect(r1.cat).toBe(false);
    expect(layerRow(container, 0).querySelectorAll('input')[11]).toBeDisabled();
    expect(layerRow(container, 0).querySelectorAll('input')[12]).toBeDisabled();
    expect(screen.getByText('RISK XL').className).toContain('is-on');
    expect(screen.getByText('CAT XL').className).toContain('is-off');

    /* Net XL → covered props table active; capacity math */
    const coveredSection = screen.getByText('Proportional Structure Covered').closest('section');
    const coveredRow = coveredSection.querySelector('tbody tr');
    const coveredInputs = coveredRow.querySelectorAll('input');
    fireEvent.change(coveredInputs[0], { target: { value: '1000000' } });  // QS limit
    fireEvent.change(coveredInputs[1], { target: { value: '20' } });       // retention %
    fireEvent.change(coveredInputs[3], { target: { value: '3' } });        // surplus lines
    await waitFor(() => {
      const inputs = coveredSection.querySelector('tbody tr').querySelectorAll('input');
      expect(inputs[2].value).toBe('200,000');     // 1,000,000 × 20%
      expect(inputs[4].value).toBe('4,000,000');   // 1,000,000 × (1 + 3)
    });

    /* Expiring covered props: add row, edit, capacity math, remove row */
    const expSection = screen.getByText('Expiring Proportional Structure Covered').closest('section');
    expect(expSection.querySelectorAll('tbody tr')).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: /\+ add row/i }));
    await waitFor(() => expect(expSection.querySelectorAll('tbody tr')).toHaveLength(2));
    const expCoveredRow = expSection.querySelectorAll('tbody tr')[1];
    fireEvent.change(expCoveredRow.querySelectorAll('input')[0], { target: { value: '500000' } });
    fireEvent.change(expCoveredRow.querySelectorAll('input')[1], { target: { value: '10' } });
    await waitFor(() => {
      const inputs = expSection.querySelectorAll('tbody tr')[1].querySelectorAll('input');
      expect(inputs[2].value).toBe('50,000');      // 500,000 × 10%
      expect(inputs[4].value).toBe('500,000');     // 500,000 × (1 + 0)
    });
    fireEvent.click(screen.getByRole('button', { name: /− remove/i }));
    await waitFor(() => expect(expSection.querySelectorAll('tbody tr')).toHaveLength(1));
  });
});
