// load-test/agents/underwriter.js
//
// The underwriter persona for the agent simulation. Each agent is a real
// authenticated session (name-login cookie + CSRF) that models treaties the
// way the SPA does: create -> save terms in wizard slices -> triangles ->
// dev factors -> losses -> workflow -> renew, plus the quote-side flows
// (create, save, renew, amend, submit/decline/delete). After EVERY PUT/POST
// the agent GETs the entity back and field-checks the round trip, so the run
// is simultaneously a load test and a data-fidelity audit.

import { propTreatyPlan, npTreatyPlan, triangleCells, devFactors, largeLosses, quotePlan } from './lib/gen.js';

const TREATY = (id) => `/api/treaties/${id}`;
const QUOTE = (id) => `/api/quotes/${id}`;

/** Extract detail-comparable expectations from a detail slice we sent. */
function expectedDetail(sent) {
  const e = { ...sent };
  delete e.inception_date; delete e.renewal_date; // live on header
  return e;
}

export class Underwriter {
  /**
   * @param {object} opts
   * @param {import('./lib/http.js').AgentSession} opts.session
   * @param {import('./lib/check.js').Checker} opts.checker
   * @param {import('./lib/gen.js').Rng} opts.rng
   * @param {object} opts.refs      lookup data {cedants, brokers, currencies, countries, treatyTypes, cobs}
   * @param {number} opts.uwYear
   * @param {number} opts.index     agent index (0-based)
   */
  constructor({ session, checker, rng, refs, uwYear, index }) {
    this.s = session;
    this.c = checker;
    this.rng = rng;
    this.refs = refs;
    this.uwYear = uwYear;
    this.index = index;
    this.treaties = [];   // { id, kind, plan, lastSeen, signed }
    this.quotes = [];     // { id, plan, lastSeen }
    this.peer = null;     // set by orchestrator: another agent's session
  }

  get name() { return this.s.name; }

  _chk(category, name, pass, detail, entity) {
    return this.c.add({ agent: this.name, category, name, pass, detail, entity });
  }

  _status(category, label, res, want, entity) {
    return this.c.status({ agent: this.name, category, entity, label, res, want });
  }

  _fields(category, label, actual, expected, types, entity) {
    return this.c.fields({ agent: this.name, category, entity, label, actual, expected, types });
  }

  // ── treaty creation ──────────────────────────────────────────────────────

  async createTreaty(kind) {
    const plan = kind === 'PROP'
      ? propTreatyPlan(this.rng, this.refs, this.uwYear)
      : npTreatyPlan(this.rng, this.refs, this.uwYear);
    const res = await this.s.post('/api/treaties', plan.create, { label: 'POST /treaties' });
    if (!this._status('treaty-create', 'create treaty', res, 201)) return null;
    const id = res.json.contract_id;
    const rec = { id, kind, plan, lastSeen: null, signed: false };
    this.treaties.push(rec);

    // Round-trip the create: header ids, DRAFT statuses, ownership.
    const g = await this.s.get(TREATY(id), { label: 'GET /treaties/:id' });
    if (this._status('treaty-get', 'read created treaty', g, 200, id)) {
      const h = g.json.header || {};
      this._fields('treaty-create', 'created.header', h, {
        cedant_id: plan.create.cedant_id,
        broker_id: plan.create.broker_id,
        currency_id: plan.create.currency_id,
        country_id: plan.create.country_id,
        treaty_type_id: plan.create.treaty_type_id,
        uw_year: plan.create.uw_year,
        status: 'DRAFT',
        uw_status: 'DRAFT',
        inception_date: plan.create.inception_date,
      }, { status: 'id', uw_status: 'id', inception_date: 'date' }, id);
      this._chk('permissions', 'creator is assignee with edit rights',
        g.json.ownership?.canEdit === true && g.json.ownership?.assignedToUserId === this.s.userId,
        `ownership=${JSON.stringify(g.json.ownership)}`, id);
      rec.lastSeen = g.json.updated_at;
    }
    return rec;
  }

  // ── PROP treaty modelling ────────────────────────────────────────────────

  async modelPropTreaty(rec) {
    const { id, plan } = rec;

    // Slice 1: header + detail (the treaty-detail wizard screen).
    let r = await this.s.put(TREATY(id), { terms: plan.sliceHeaderDetail, save_mode: 'MANUAL' }, {
      label: 'PUT /treaties/:id', headers: rec.lastSeen ? { 'if-unmodified-since': rec.lastSeen } : {},
    });
    if (this._status('treaty-put', 'save header+detail', r, 200, id)) rec.lastSeen = r.json.updated_at;

    let g = await this.s.get(TREATY(id), { label: 'GET /treaties/:id' });
    if (this._status('treaty-get', 'read after header+detail save', g, 200, id)) {
      this._fields('put-get-roundtrip', 'header', g.json.header, {
        ...plan.sliceHeaderDetail.header,
      }, { renewal_date: 'date', inception_date: 'date', contract_description: 'str' }, id);
      this._fields('put-get-roundtrip', 'detail', g.json.detail,
        expectedDetail(plan.sliceHeaderDetail.detail),
        { triangulations_available: 'bool', strip_large_cat_losses: 'bool' }, id);
      rec.lastSeen = g.json.updated_at;
    }

    // Slice 2: commissions. Partial-save safety: detail must survive.
    r = await this.s.put(TREATY(id), { terms: plan.sliceCommissions, save_mode: 'MANUAL' }, {
      label: 'PUT /treaties/:id', headers: { 'if-unmodified-since': rec.lastSeen },
    });
    if (this._status('treaty-put', 'save commissions', r, 200, id)) rec.lastSeen = r.json.updated_at;

    g = await this.s.get(TREATY(id), { label: 'GET /treaties/:id' });
    if (this._status('treaty-get', 'read after commissions save', g, 200, id)) {
      const cm = plan.sliceCommissions.commissions;
      const { sliding_table, ...cmScalar } = cm;
      this._fields('put-get-roundtrip', 'commissions', g.json.commissions, cmScalar,
        { mode: 'str', lcf_extinction: 'bool' }, id);
      const gotSlides = g.json.commissions?.sliding_table || [];
      this._chk('put-get-roundtrip', 'commissions.sliding_table rows',
        gotSlides.length === sliding_table.length
          && sliding_table.every((row, i) => gotSlides[i]
            && Number(gotSlides[i].loss_ratio_pct) === row.loss_ratio_pct
            && Math.abs(Number(gotSlides[i].commission_pct) - row.commission_pct) < 1e-9),
        `expected ${JSON.stringify(sliding_table)} got ${JSON.stringify(gotSlides)}`, id);
      // Partial-save safety: the detail slice saved earlier must be intact.
      this._fields('partial-save-safety', 'detail intact after commissions-only save',
        g.json.detail, expectedDetail(plan.sliceHeaderDetail.detail),
        { triangulations_available: 'bool', strip_large_cat_losses: 'bool' }, id);
      rec.lastSeen = g.json.updated_at;
    }

    // Slice 3: structure (loss participation, COBs, EPI split, UW limits).
    r = await this.s.put(TREATY(id), { terms: plan.sliceStructure, save_mode: 'MANUAL' }, {
      label: 'PUT /treaties/:id', headers: { 'if-unmodified-since': rec.lastSeen },
    });
    if (this._status('treaty-put', 'save structure slice', r, 200, id)) rec.lastSeen = r.json.updated_at;

    g = await this.s.get(TREATY(id), { label: 'GET /treaties/:id' });
    if (this._status('treaty-get', 'read after structure save', g, 200, id)) {
      const lp = plan.sliceStructure.lossParticipation;
      this._fields('put-get-roundtrip', 'lossParticipation', g.json.lossParticipation, {
        enabled: lp.enabled,
        min_loss_ratio_pct: lp.min_loss_ratio_pct,
        max_loss_ratio_pct: lp.max_loss_ratio_pct,
        reinsurer_share_pct: lp.reinsurer_share_pct,
      }, { enabled: 'bool' }, id);
      this.c.idSet({
        agent: this.name, category: 'put-get-roundtrip', entity: id,
        label: 'class_ids round-trip',
        actual: g.json.class_ids, expected: plan.sliceStructure.classIds,
      });
      const epiGot = new Map((g.json.epi_split || []).map((e) => [String(e.class_id), e.premium]));
      this._chk('put-get-roundtrip', 'epi_split round-trip',
        plan.sliceStructure.epi_split.every((e) => Number(epiGot.get(String(e.class_id))) === e.premium)
          && epiGot.size === plan.sliceStructure.epi_split.length,
        `expected ${JSON.stringify(plan.sliceStructure.epi_split)} got ${JSON.stringify(g.json.epi_split)}`, id);
      const uwGot = new Map((g.json.underwriting_limits || []).map((u) => [String(u.class_of_business_id), u]));
      this._chk('put-get-roundtrip', 'underwriting_limits round-trip',
        plan.sliceStructure.underwriting_limits.every((u) => {
          const got = uwGot.get(String(u.class_of_business_id));
          return got && Number(got.limit_amount) === u.limit_amount && got.basis === u.basis;
        }) && uwGot.size === plan.sliceStructure.underwriting_limits.length,
        `expected ${JSON.stringify(plan.sliceStructure.underwriting_limits)} got ${JSON.stringify(g.json.underwriting_limits)}`, id);
      // Commissions from slice 2 must be intact.
      this._chk('partial-save-safety', 'commissions intact after structure-only save',
        Math.abs(Number(g.json.commissions?.fixed_commission_pct)
          - plan.sliceCommissions.commissions.fixed_commission_pct) < 1e-9,
        `fixed_commission_pct drifted: ${g.json.commissions?.fixed_commission_pct}`, id);
      rec.lastSeen = g.json.updated_at;
    }

    await this.modelTriangles(rec);
    await this.modelLosses(rec);
  }

  // ── NP treaty modelling ──────────────────────────────────────────────────

  async modelNpTreaty(rec) {
    const { id, plan } = rec;

    let r = await this.s.put(TREATY(id), { terms: plan.sliceHeader, save_mode: 'MANUAL' }, {
      label: 'PUT /treaties/:id', headers: rec.lastSeen ? { 'if-unmodified-since': rec.lastSeen } : {},
    });
    if (this._status('treaty-put', 'save NP header', r, 200, id)) rec.lastSeen = r.json.updated_at;

    let g = await this.s.get(TREATY(id), { label: 'GET /treaties/:id' });
    if (this._status('treaty-get', 'read after NP header save', g, 200, id)) {
      this._fields('put-get-roundtrip', 'np.header', g.json.header, plan.sliceHeader.header,
        { renewal_date: 'date', inception_date: 'date', contract_description: 'str' }, id);
      rec.lastSeen = g.json.updated_at;
    }

    // COB participation lives on the shared junction table — save + verify.
    r = await this.s.put(TREATY(id), { terms: { classIds: plan.cobs.map((c) => c.id) } }, {
      label: 'PUT /treaties/:id', headers: { 'if-unmodified-since': rec.lastSeen },
    });
    if (this._status('treaty-put', 'save NP classIds', r, 200, id)) rec.lastSeen = r.json.updated_at;
    g = await this.s.get(TREATY(id), { label: 'GET /treaties/:id' });
    if (g.status === 200) {
      this.c.idSet({
        agent: this.name, category: 'put-get-roundtrip', entity: id,
        label: 'np class_ids round-trip',
        actual: g.json.class_ids, expected: plan.cobs.map((c) => c.id),
      });
      rec.lastSeen = g.json.updated_at;
    }

    // NP structure via the non-prop composite save.
    r = await this.s.post(`${TREATY(id)}/non-prop/save`, plan.npSave, {
      label: 'POST /treaties/:id/non-prop/save',
      headers: { 'if-unmodified-since': rec.lastSeen },
    });
    this._status('treaty-put', 'non-prop composite save', r, 200, id);

    g = await this.s.get(`${TREATY(id)}/non-prop`, { label: 'GET /treaties/:id/non-prop' });
    if (this._status('treaty-get', 'read non-prop', g, 200, id)) {
      const d = plan.npSave.detail;
      this._fields('put-get-roundtrip', 'np.detail', g.json.detail, {
        number_of_layers: d.number_of_layers,
        deductible: d.deductible,
        max_retention: d.max_retention,
        accounting_method: d.accounting_method,
        xl_type: d.xl_type,
        accounts: d.accounts,
        brokerage_pct: d.brokerage_pct,
        taxes_pct: d.taxes_pct,
        no_claims_bonus_pct: d.no_claims_bonus_pct,
        profit_commission_pct: d.profit_commission_pct,
        est_gnpi: d.est_gnpi,
        experience_start_year: d.experience_start_year,
      }, { accounting_method: 'str', xl_type: 'str', accounts: 'str' }, id);
      const layersGot = g.json.layers || [];
      this._chk('put-get-roundtrip', 'np.layers count',
        layersGot.length === plan.npSave.layers.length,
        `expected ${plan.npSave.layers.length} layers got ${layersGot.length}`, id);
      for (const want of plan.npSave.layers) {
        const got = layersGot.find((l) => Number(l.layer_number) === want.layer_number);
        this._chk('put-get-roundtrip', `np.layer[${want.layer_number}] round-trip`,
          !!got
            && Number(got.attachment) === want.attachment
            && Number(got.layer_limit) === want.layer_limit
            && Number(got.aggregate_limit) === want.aggregate_limit
            && Number(got.egnpi) === want.egnpi
            && Number(got.num_reinstatements) === want.num_reinstatements
            && got.peril_scope === want.peril_scope,
          `expected ${JSON.stringify(want)} got ${JSON.stringify(got)}`, id);
      }
      const cobLimGot = new Map((g.json.cob_underwriting_limits || []).map((u) => [String(u.cob_id), u.limit_amount]));
      this._chk('put-get-roundtrip', 'np.cob_underwriting_limits round-trip',
        plan.npSave.cob_underwriting_limits.every((u) => Number(cobLimGot.get(String(u.cob_id))) === u.limit_amount),
        `expected ${JSON.stringify(plan.npSave.cob_underwriting_limits)} got ${JSON.stringify([...cobLimGot])}`, id);
      rec.lastSeen = g.json.updated_at || rec.lastSeen;
    }
    await this.modelLosses(rec);
  }

  // ── triangles + dev factors (PROP treaties) ──────────────────────────────

  async modelTriangles(rec) {
    const { id } = rec;
    const tri = {
      PREMIUM: triangleCells(this.rng, this.uwYear, { base: 5_000_000, growth: 0.10 }),
      CLAIMS_PAID: triangleCells(this.rng, this.uwYear, { base: 2_000_000, growth: 0.45 }),
      CLAIMS_OS: triangleCells(this.rng, this.uwYear, { base: 800_000, growth: 0.25 }),
    };
    for (const [type, cells] of Object.entries(tri)) {
      const r = await this.s.post(`${TREATY(id)}/triangles/${type}`, { cells, variant: 'MODIFIED' }, {
        label: 'POST /treaties/:id/triangles/:type',
      });
      if (this._status('triangles', `save ${type} triangle`, r, 200, id)) {
        this._chk('triangles', `${type} no cells dropped by bounds filter`,
          r.json.saved === cells.length && r.json.dropped === 0,
          `saved=${r.json.saved} dropped=${r.json.dropped} sent=${cells.length}`, id);
      }
      const g = await this.s.get(`${TREATY(id)}/triangles/${type}?variant=MODIFIED`, {
        label: 'GET /treaties/:id/triangles/:type',
      });
      if (this._status('triangles', `read ${type} triangle`, g, 200, id)) {
        const got = g.json.cells || [];
        const key = (c) => `${c.origin_year}:${c.dev_months}`;
        const gotMap = new Map(got.map((c) => [key(c), Number(c.cum_value)]));
        this._chk('put-get-roundtrip', `${type} triangle cells round-trip`,
          got.length === cells.length && cells.every((c) => gotMap.get(key(c)) === c.cum_value),
          `sent ${cells.length} cells, got ${got.length}; first mismatch: ${
            cells.find((c) => gotMap.get(key(c)) !== c.cum_value)
              ? JSON.stringify(cells.find((c) => gotMap.get(key(c)) !== c.cum_value)) : 'none'}`, id);
      }
    }

    // Variant isolation: ACTUAL save must not disturb MODIFIED.
    const originalCells = tri.PREMIUM.map((c) => ({ ...c, cum_value: Math.round(c.cum_value * 1.11) }));
    const rOrig = await this.s.post(`${TREATY(id)}/triangles/PREMIUM`, { cells: originalCells, variant: 'ACTUAL' }, {
      label: 'POST /treaties/:id/triangles/:type',
    });
    this._status('triangles', 'save PREMIUM ACTUAL variant', rOrig, 200, id);
    const gMod = await this.s.get(`${TREATY(id)}/triangles/PREMIUM?variant=MODIFIED`, {
      label: 'GET /treaties/:id/triangles/:type',
    });
    if (gMod.status === 200) {
      const gotMap = new Map((gMod.json.cells || []).map((c) => [`${c.origin_year}:${c.dev_months}`, Number(c.cum_value)]));
      this._chk('triangles', 'MODIFIED variant untouched by ACTUAL save',
        tri.PREMIUM.every((c) => gotMap.get(`${c.origin_year}:${c.dev_months}`) === c.cum_value),
        'ACTUAL save bled into MODIFIED cells', id);
    }

    // Dev factors + the staleness contract.
    const factors = devFactors(this.rng);
    const rDf = await this.s.put(`${TREATY(id)}/dev-factors/CLAIMS_PAID`, {
      factors, method: 'CHAIN_LADDER', basis: 'MODIFIED',
    }, { label: 'PUT /treaties/:id/dev-factors/:type' });
    this._status('dev-factors', 'save dev factors', rDf, 200, id);

    const gDf = await this.s.get(`${TREATY(id)}/dev-factors/CLAIMS_PAID`, {
      label: 'GET /treaties/:id/dev-factors/:type',
    });
    if (this._status('dev-factors', 'read dev factors', gDf, 200, id)) {
      const got = gDf.json || [];
      const gotMap = new Map(got.map((f) => [Number(f.dev_month), f]));
      this._chk('put-get-roundtrip', 'dev factors round-trip',
        got.length === factors.length && factors.every((f) => {
          const gf = gotMap.get(f.dev_month);
          return gf && Math.abs(Number(gf.selected_ldf) - f.selected_ldf) < 1e-9
            && Math.abs(Number(gf.selected_cdf) - f.selected_cdf) < 1e-9
            && gf.chosen_source === f.chosen_source;
        }),
        `sent ${factors.length} got ${got.length}`, id);
    }

    let st = await this.s.get(`${TREATY(id)}/dev-factors/CLAIMS_PAID/staleness`, {
      label: 'GET /treaties/:id/dev-factors/:type/staleness',
    });
    if (st.status === 200) {
      this._chk('staleness', 'factors fresh right after save', st.json.stale === false,
        `staleness=${JSON.stringify(st.json)}`, id);
    }
    // Re-save the source triangle -> factors must now read stale.
    await this.s.post(`${TREATY(id)}/triangles/CLAIMS_PAID`, {
      cells: tri.CLAIMS_PAID, variant: 'MODIFIED',
    }, { label: 'POST /treaties/:id/triangles/:type' });
    st = await this.s.get(`${TREATY(id)}/dev-factors/CLAIMS_PAID/staleness`, {
      label: 'GET /treaties/:id/dev-factors/:type/staleness',
    });
    if (st.status === 200) {
      this._chk('staleness', 'factors stale after triangle re-save', st.json.stale === true,
        `staleness=${JSON.stringify(st.json)}`, id);
    }
  }

  // ── large + cat losses ───────────────────────────────────────────────────

  async modelLosses(rec) {
    const { id } = rec;
    const reportDate = `${this.uwYear - 1}-12-31`;
    const losses = largeLosses(this.rng, this.uwYear);
    let r = await this.s.put(`${TREATY(id)}/large-losses`, { report_date: reportDate, losses }, {
      label: 'PUT /treaties/:id/large-losses',
    });
    if (this._status('losses', 'save large losses', r, 200, id)) {
      this._chk('losses', 'large-loss ids returned', (r.json.loss_ids || []).length === losses.length,
        `sent ${losses.length} got ${JSON.stringify(r.json.loss_ids)}`, id);
    }
    let g = await this.s.get(`${TREATY(id)}/large-losses`, { label: 'GET /treaties/:id/large-losses' });
    if (this._status('losses', 'read large losses', g, 200, id)) {
      const got = g.json.losses || [];
      const sum = (arr, f) => arr.reduce((s, x) => s + (Number(x[f]) || 0), 0);
      this._chk('put-get-roundtrip', 'large losses round-trip',
        got.length === losses.length
          && Math.abs(sum(got, 'paid') - sum(losses, 'paid')) < 0.01
          && Math.abs(sum(got, 'os') - sum(losses, 'os')) < 0.01
          && Math.abs(sum(got, 'incurred') - sum(losses, 'incurred')) < 0.01
          && losses.every((l) => got.some((gl) => gl.insured_name === l.insured_name
            && Number(gl.uw_year) === l.uw_year && Number(gl.paid) === l.paid)),
        `sent ${losses.length} rows / paid ${sum(losses, 'paid')}, got ${got.length} rows / paid ${sum(got, 'paid')}`, id);
      this._chk('put-get-roundtrip', 'large losses report_date round-trip',
        g.json.report && String(g.json.report.report_date).slice(0, 10) === reportDate
          || new Date(g.json.report?.report_date).toISOString().slice(0, 10) === reportDate,
        `report_date=${g.json.report?.report_date}`, id);
    }

    // Second save preserves is_selected via loss_id (the preserve contract).
    if (g.status === 200 && (g.json.losses || []).length) {
      const withIds = g.json.losses.map((l) => ({
        loss_id: l.loss_id,
        uw_year: l.uw_year,
        insured_name: l.insured_name,
        loss_name: l.loss_name,
        date_of_loss: l.date_of_loss,
        class_of_business: l.class_of_business,
        paid: Number(l.paid),
        os: Number(l.os),
        incurred: Number(l.incurred),
        // is_selected deliberately OMITTED — server must preserve prior value.
      }));
      const prevSelected = new Map(g.json.losses.map((l) => [String(l.loss_id), l.is_selected]));
      r = await this.s.put(`${TREATY(id)}/large-losses`, { report_date: reportDate, losses: withIds }, {
        label: 'PUT /treaties/:id/large-losses',
      });
      this._status('losses', 're-save large losses with ids', r, 200, id);
      g = await this.s.get(`${TREATY(id)}/large-losses`, { label: 'GET /treaties/:id/large-losses' });
      if (g.status === 200) {
        this._chk('losses', 'is_selected preserved across id-keyed re-save',
          (g.json.losses || []).every((l) => l.is_selected === prevSelected.get(String(l.loss_id))),
          'a re-save that omitted is_selected reset the selection', id);
      }
    }

    const catLosses = largeLosses(this.rng, this.uwYear, 2).map((l) => ({ ...l, loss_name: 'Cat event' }));
    r = await this.s.put(`${TREATY(id)}/cat-losses`, { report_date: reportDate, losses: catLosses }, {
      label: 'PUT /treaties/:id/cat-losses',
    });
    this._status('losses', 'save cat losses', r, 200, id);
    g = await this.s.get(`${TREATY(id)}/cat-losses`, { label: 'GET /treaties/:id/cat-losses' });
    if (this._status('losses', 'read cat losses', g, 200, id)) {
      const got = g.json.losses || [];
      this._chk('put-get-roundtrip', 'cat losses round-trip',
        got.length === catLosses.length
          && catLosses.every((l) => got.some((gl) => Number(gl.paid) === l.paid && Number(gl.uw_year) === l.uw_year)),
        `sent ${catLosses.length} got ${got.length}`, id);
    }
  }

  // ── locking, permissions, workflow ───────────────────────────────────────

  async probeOptimisticLock(rec) {
    const { id } = rec;
    const g0 = await this.s.get(TREATY(id), { label: 'GET /treaties/:id' });
    if (g0.status !== 200) return;
    const t0 = g0.json.updated_at;

    // Intervening save moves updated_at… (alt_contract_id is a COALESCE-set
    // header field: it neither disturbs the description the renewal check
    // depends on nor creates a prop-details row on an NP treaty.)
    const r1 = await this.s.put(TREATY(id), {
      terms: { header: { alt_contract_id: `SIM-${String(id).slice(0, 8)}` } },
    }, { label: 'PUT /treaties/:id', headers: { 'if-unmodified-since': t0 } });
    if (!this._status('optimistic-lock', 'fresh-baseline save accepted', r1, 200, id)) return;
    rec.lastSeen = r1.json.updated_at;

    // …so a second save still holding the old baseline must 409.
    const r2 = await this.s.put(TREATY(id), {
      terms: { header: { contract_description: 'stale write should not land' } },
    }, { label: 'PUT /treaties/:id', headers: { 'if-unmodified-since': t0 } });
    const conflicted = this._status('optimistic-lock', 'stale-baseline save rejected 409', r2, 409, id);
    if (conflicted) {
      this._chk('optimistic-lock', 'stale rejection carries STALE_WRITE code',
        r2.json?.code === 'STALE_WRITE' || /modified/i.test(r2.json?.error || ''),
        `body=${JSON.stringify(r2.json).slice(0, 200)}`, id);
    }
    // And the stale payload must NOT have landed.
    const g1 = await this.s.get(TREATY(id), { label: 'GET /treaties/:id' });
    if (g1.status === 200) {
      this._chk('optimistic-lock', 'stale payload did not persist',
        g1.json.header?.contract_description !== 'stale write should not land',
        'the 409-rejected description is visible on the treaty', id);
      rec.lastSeen = g1.json.updated_at;
    }
  }

  /**
   * Concurrency race: two simultaneous PUTs carrying the SAME baseline.
   * Airtight optimistic locking admits exactly one. Both landing = lost
   * update (the second writer silently overwrote the first).
   */
  async raceSameBaselinePuts(rec) {
    const { id } = rec;
    const g0 = await this.s.get(TREATY(id), { label: 'GET /treaties/:id' });
    if (g0.status !== 200) return null;
    const t0 = g0.json.updated_at;
    const mk = (tag) => this.s.put(TREATY(id), {
      terms: { header: { contract_description: `race-winner-${tag}` } },
    }, { label: 'PUT /treaties/:id (race)', headers: { 'if-unmodified-since': t0 } });
    const [a, b] = await Promise.all([mk('A'), mk('B')]);
    const codes = [a.status, b.status].sort((x, y) => x - y).join('+');
    const strict = codes === '200+409';
    this._chk('lock-race', 'same-baseline concurrent PUTs: exactly one wins', strict,
      `outcome ${codes} — 200+200 means the optimistic lock has a lost-update race window`, id);
    const g1 = await this.s.get(TREATY(id), { label: 'GET /treaties/:id' });
    if (g1.status === 200) rec.lastSeen = g1.json.updated_at;
    return { id, codes, strict };
  }

  /** A peer (another underwriter, same seniority) can read but not write. */
  async probePeerPermissions(rec) {
    if (!this.peer) return;
    const { id } = rec;
    const gr = await this.peer.get(TREATY(id), { label: 'GET /treaties/:id (peer)' });
    this._status('permissions', 'peer read allowed', gr, 200, id);

    const pw = await this.peer.put(TREATY(id), {
      terms: { header: { contract_description: 'peer should not be able to write this' } },
    }, { label: 'PUT /treaties/:id (peer)' });
    this._status('permissions', 'peer write rejected 403', pw, 403, id);

    const pd = await this.peer.del(TREATY(id), { label: 'DELETE /treaties/:id (peer)' });
    this._status('permissions', 'peer delete rejected 403', pd, 403, id);

    const anon = await this.anonSession?.put(TREATY(id), {
      terms: { header: { contract_description: 'anonymous write' } },
    }, { label: 'PUT /treaties/:id (anon)' });
    if (anon) this._status('permissions', 'anonymous write rejected', anon, [401, 403], id);

    const g1 = await this.s.get(TREATY(id), { label: 'GET /treaties/:id' });
    if (g1.status === 200) {
      this._chk('permissions', 'peer/anon payloads did not persist',
        !/should not be able|anonymous write/.test(g1.json.header?.contract_description || ''),
        `description=${g1.json.header?.contract_description}`, id);
      rec.lastSeen = g1.json.updated_at;
    }
  }

  /** Walk a treaty DRAFT -> AWAITING_APPROVAL -> AWAITING_SIGNED_LINE -> SIGNED. */
  async signTreaty(rec) {
    const { id } = rec;
    const steps = ['AWAITING_APPROVAL', 'AWAITING_SIGNED_LINE', 'SIGNED'];
    for (const to of steps) {
      const body = { terms: { header: { uw_status: to, ...(to === 'SIGNED' ? { signed_line_pct: this.rng.pct(50, 100) } : {}) } } };
      const r = await this.s.put(TREATY(id), body, {
        label: 'PUT /treaties/:id (workflow)', headers: { 'if-unmodified-since': rec.lastSeen },
      });
      if (!this._status('workflow', `transition to ${to}`, r, 200, id)) return false;
      rec.lastSeen = r.json.updated_at;
      const g = await this.s.get(TREATY(id), { label: 'GET /treaties/:id' });
      if (g.status === 200) {
        this._chk('workflow', `uw_status now ${to}`, g.json.header?.uw_status === to,
          `uw_status=${g.json.header?.uw_status}`, id);
        rec.lastSeen = g.json.updated_at;
      }
    }
    rec.signed = true;
    // Terminal is frozen: SIGNED -> DRAFT must 422 and roll back atomically.
    const canary = `canary-${Date.now()}`;
    const rIll = await this.s.put(TREATY(id), {
      terms: { header: { uw_status: 'DRAFT', contract_description: canary } },
    }, { label: 'PUT /treaties/:id (workflow)' });
    this._status('workflow', 'SIGNED -> DRAFT rejected 422', rIll, 422, id);
    const g = await this.s.get(TREATY(id), { label: 'GET /treaties/:id' });
    if (g.status === 200) {
      this._chk('workflow', 'illegal transition rolled back atomically (canary header absent)',
        g.json.header?.uw_status === 'SIGNED' && g.json.header?.contract_description !== canary,
        `uw_status=${g.json.header?.uw_status} description=${g.json.header?.contract_description}`, id);
      rec.lastSeen = g.json.updated_at;
    }
    // History must show the workflow trail.
    const h = await this.s.get(`/api/contracts/${id}/history`, { label: 'GET /contracts/:id/history' });
    if (this._status('workflow', 'history readable', h, 200, id)) {
      const items = Array.isArray(h.json) ? h.json : [];
      this._chk('workflow', 'history records the SIGNED transition',
        items.some((e) => JSON.stringify(e).includes('SIGNED')),
        `history has ${items.length} items, none mention SIGNED`, id);
    }
    return true;
  }

  /** Illegal jump from DRAFT and terminal freeze probes. */
  async probeIllegalTransition(rec) {
    const { id } = rec;
    const r = await this.s.put(TREATY(id), {
      terms: { header: { uw_status: 'SIGNED' } },
    }, { label: 'PUT /treaties/:id (workflow)' });
    this._status('workflow', 'DRAFT -> SIGNED rejected 422', r, 422, id);
    const g = await this.s.get(TREATY(id), { label: 'GET /treaties/:id' });
    if (g.status === 200) {
      this._chk('workflow', 'treaty still DRAFT after illegal jump',
        g.json.header?.uw_status === 'DRAFT', `uw_status=${g.json.header?.uw_status}`, id);
      rec.lastSeen = g.json.updated_at;
    }
  }

  // ── renewal ──────────────────────────────────────────────────────────────

  async renewTreaty(rec) {
    const { id, plan, kind } = rec;
    const before = await this.s.get(TREATY(id), { label: 'GET /treaties/:id' });
    const r = await this.s.post(`${TREATY(id)}/renew`, {}, { label: 'POST /treaties/:id/renew' });
    if (!this._status('renewal', 'renew treaty', r, 201, id)) return null;
    const newId = r.json.contract_id;
    this._chk('renewal', 'renewal reports parent id', r.json.parent_contract_id === id,
      `parent_contract_id=${r.json.parent_contract_id}`, id);

    const g = await this.s.get(TREATY(newId), { label: 'GET /treaties/:id' });
    if (!this._status('renewal', 'read renewal', g, 200, newId)) return null;
    const h = g.json.header || {};
    const expInception = plan.renewal;                       // rolls from parent renewal_date
    const expRenewal = `${Number(plan.renewal.slice(0, 4)) + 1}${plan.renewal.slice(4)}`;
    const expYear = Number(plan.renewal.slice(0, 4));
    this._fields('renewal', 'renewal.header', h, {
      cedant_id: plan.create.cedant_id,
      broker_id: plan.create.broker_id,
      currency_id: plan.create.currency_id,
      country_id: plan.create.country_id,
      treaty_type_id: plan.create.treaty_type_id,
      uw_year: expYear,
      uw_status: 'DRAFT',
      status: 'DRAFT',
      parent_contract_id: id,
      inception_date: expInception,
      renewal_date: expRenewal,
      contract_description: plan.description,
    }, { uw_status: 'id', status: 'id', parent_contract_id: 'id',
      inception_date: 'date', renewal_date: 'date', contract_description: 'str' }, newId);

    this.c.idSet({
      agent: this.name, category: 'renewal', entity: newId,
      label: 'renewal copies COB set',
      actual: g.json.class_ids,
      expected: kind === 'PROP' ? rec.plan.sliceStructure.classIds : rec.plan.cobs.map((c) => c.id),
    });

    // Financial terms must start BLANK on a renewal.
    this._chk('renewal', 'renewal financial terms start blank',
      g.json.detail?.qs_limit == null && g.json.commissions?.fixed_commission_pct == null
        && (g.json.epi_split || []).length === 0,
      `qs_limit=${g.json.detail?.qs_limit} fixed_commission=${g.json.commissions?.fixed_commission_pct} epi=${(g.json.epi_split || []).length}`, newId);
    this._chk('renewal', 'renewal assigned to the renewing underwriter',
      g.json.ownership?.assignedToUserId === this.s.userId, JSON.stringify(g.json.ownership), newId);

    // Parent untouched by the renewal.
    const after = await this.s.get(TREATY(id), { label: 'GET /treaties/:id' });
    if (before.status === 200 && after.status === 200) {
      this._chk('renewal', 'parent treaty unchanged by renewal',
        after.json.header?.uw_status === before.json.header?.uw_status
          && after.json.header?.contract_description === before.json.header?.contract_description,
        `before=${before.json.header?.uw_status} after=${after.json.header?.uw_status}`, id);
    }

    const newRec = { id: newId, kind, plan, lastSeen: g.json.updated_at, signed: false, isRenewal: true };
    this.treaties.push(newRec);
    return newRec;
  }

  // ── quotes ───────────────────────────────────────────────────────────────

  async runQuoteFlow() {
    const plan = quotePlan(this.rng, this.refs, this.uwYear);
    const r = await this.s.post('/api/quotes', plan.create, { label: 'POST /quotes' });
    if (!this._status('quote-create', 'create quote', r, 201)) return null;
    const id = r.json.quote_id;
    this._chk('quote-create', 'quote_ref assigned (QT-YYYY-NNNN)',
      /^QT-\d{4}-\d{4,}$/.test(r.json.quote_ref || ''), `quote_ref=${r.json.quote_ref}`, id);
    const rec = { id, plan, lastSeen: null, ref: r.json.quote_ref };
    this.quotes.push(rec);

    let g = await this.s.get(QUOTE(id), { label: 'GET /quotes/:id' });
    if (this._status('quote-get', 'read created quote', g, 200, id)) {
      this._fields('quote-create', 'quote.created.header', g.json.header, {
        cedant_id: plan.create.cedant_id,
        uw_year: plan.create.uw_year,
        status: 'DRAFT',
        inception_date: plan.create.inception_date,
        contract_description: plan.create.contract_description,
      }, { status: 'id', inception_date: 'date', contract_description: 'str' }, id);
      rec.lastSeen = g.json.updated_at;
    }

    // Full terms save + round-trip.
    const rPut = await this.s.put(QUOTE(id), { terms: plan.put }, {
      label: 'PUT /quotes/:id', headers: { 'if-unmodified-since': rec.lastSeen },
    });
    if (this._status('quote-put', 'save quote terms', rPut, 200, id)) rec.lastSeen = rPut.json.updated_at;

    g = await this.s.get(QUOTE(id), { label: 'GET /quotes/:id' });
    if (this._status('quote-get', 'read after quote save', g, 200, id)) {
      this._fields('put-get-roundtrip', 'quote.header', g.json.header, plan.put.header,
        { inception_date: 'date', renewal_date: 'date', contract_description: 'str' }, id);
      this._fields('put-get-roundtrip', 'quote.detail', g.json.detail, expectedDetail(plan.put.detail),
        { triangulations_available: 'bool', strip_large_cat_losses: 'bool' }, id);
      this._fields('put-get-roundtrip', 'quote.commissions', g.json.commissions, plan.put.commissions,
        { mode: 'str' }, id);
      this.c.idSet({
        agent: this.name, category: 'put-get-roundtrip', entity: id,
        label: 'quote class_ids round-trip',
        actual: g.json.class_ids, expected: plan.put.classIds,
      });
      const lp = plan.put.lossParticipation;
      this._fields('put-get-roundtrip', 'quote.lossParticipation', g.json.lossParticipation, {
        enabled: lp.enabled,
        min_loss_ratio_pct: lp.min_loss_ratio_pct,
        max_loss_ratio_pct: lp.max_loss_ratio_pct,
        reinsurer_share_pct: lp.reinsurer_share_pct,
      }, { enabled: 'bool' }, id);
      rec.lastSeen = g.json.updated_at;
    }

    // Quote-side optimistic lock.
    const t0 = rec.lastSeen;
    const rFresh = await this.s.put(QUOTE(id), {
      terms: { detail: { ...expectedDetail(plan.put.detail), aal: 1_234_000 } },
    }, { label: 'PUT /quotes/:id', headers: { 'if-unmodified-since': t0 } });
    if (this._status('optimistic-lock', 'quote fresh-baseline save accepted', rFresh, 200, id)) {
      rec.lastSeen = rFresh.json.updated_at;
    }
    const rStale = await this.s.put(QUOTE(id), {
      terms: { header: { contract_description: 'stale quote write' } },
    }, { label: 'PUT /quotes/:id', headers: { 'if-unmodified-since': t0 } });
    this._status('optimistic-lock', 'quote stale-baseline save rejected 409', rStale, 409, id);

    // Peer permission checks on quotes.
    if (this.peer) {
      const pg = await this.peer.get(QUOTE(id), { label: 'GET /quotes/:id (peer)' });
      this._status('permissions', 'peer quote read allowed', pg, 200, id);
      const pp = await this.peer.put(QUOTE(id), {
        terms: { header: { contract_description: 'peer quote write' } },
      }, { label: 'PUT /quotes/:id (peer)' });
      this._status('permissions', 'peer quote write rejected 403', pp, 403, id);
    }

    // Renew the quote (rolls the period, links parent).
    const rRen = await this.s.post(`${QUOTE(id)}/renew`, {}, { label: 'POST /quotes/:id/renew' });
    let renewedId = null;
    if (this._status('quote-renewal', 'renew quote', rRen, 201, id)) {
      renewedId = rRen.json.quote_id;
      const gr = await this.s.get(QUOTE(renewedId), { label: 'GET /quotes/:id' });
      if (this._status('quote-renewal', 'read renewed quote', gr, 200, renewedId)) {
        const expInception = plan.renewal;
        const expYear = Number(plan.renewal.slice(0, 4));
        this._fields('quote-renewal', 'renewed.header', gr.json.header, {
          cedant_id: plan.create.cedant_id,
          uw_year: expYear,
          status: 'DRAFT',
          inception_date: expInception,
        }, { status: 'id', inception_date: 'date' }, renewedId);
        this._chk('quote-renewal', 'renewed quote links parent quote',
          gr.json.header?.parent_contract_id === id || rRen.json.parent_contract_id === id,
          `parent_contract_id=${rRen.json.parent_contract_id}`, renewedId);
        this.quotes.push({ id: renewedId, plan, lastSeen: gr.json.updated_at, isRenewal: true });
      }
    }

    // Divergent lifecycle endings, spread across agents.
    const mode = this.index % 4;
    if (mode === 0) {
      // Amend: version 2 appears, original -> SUPERSEDED, terms copied.
      const rAm = await this.s.post(`${QUOTE(id)}/amend`, { reason: 'agent-sim amendment' }, { label: 'POST /quotes/:id/amend' });
      if (this._status('quote-lifecycle', 'amend quote', rAm, [200, 201], id)) {
        const v2 = rAm.json.new_quote_id;
        const [gOld, gNew, gVers] = await Promise.all([
          this.s.get(QUOTE(id), { label: 'GET /quotes/:id' }),
          this.s.get(QUOTE(v2), { label: 'GET /quotes/:id' }),
          this.s.get(`${QUOTE(id)}/versions`, { label: 'GET /quotes/:id/versions' }),
        ]);
        this._chk('quote-lifecycle', 'original superseded after amend',
          gOld.status === 200 && gOld.json.header?.status === 'SUPERSEDED',
          `status=${gOld.json?.header?.status}`, id);
        this._chk('quote-lifecycle', 'amendment is DRAFT v2 with same ref',
          gNew.status === 200 && gNew.json.header?.status === 'DRAFT'
            && Number(gNew.json.quote_version) === 2 && gNew.json.quote_ref === rec.ref,
          `v=${gNew.json?.quote_version} ref=${gNew.json?.quote_ref} status=${gNew.json?.header?.status}`, v2);
        this._chk('quote-lifecycle', 'amendment copies detail terms',
          gNew.status === 200 && Number(gNew.json.detail?.qs_limit) === plan.put.detail.qs_limit,
          `qs_limit=${gNew.json?.detail?.qs_limit} expected ${plan.put.detail.qs_limit}`, v2);
        this._chk('quote-lifecycle', 'version chain lists both versions',
          gVers.status === 200 && (gVers.json.versions || []).length >= 2,
          `versions=${(gVers.json?.versions || []).length}`, id);
      }
    } else if (mode === 1) {
      const rSub = await this.s.post(`${QUOTE(id)}/offer/submit-for-approval`, { comment: 'agent-sim submit' }, {
        label: 'POST /quotes/:id/offer/submit-for-approval',
      });
      if (this._status('quote-lifecycle', 'submit quote for approval', rSub, 200, id)) {
        const gq = await this.s.get(QUOTE(id), { label: 'GET /quotes/:id' });
        this._chk('quote-lifecycle', 'quote now AWAITING_APPROVAL',
          gq.status === 200 && gq.json.header?.status === 'AWAITING_APPROVAL',
          `status=${gq.json?.header?.status}`, id);
      }
    } else if (mode === 2) {
      const rDec = await this.s.post(`${QUOTE(id)}/decline`, { reason: 'agent-sim decline' }, {
        label: 'POST /quotes/:id/decline',
      });
      if (this._status('quote-lifecycle', 'decline quote', rDec, 200, id)) {
        const gq = await this.s.get(QUOTE(id), { label: 'GET /quotes/:id' });
        this._chk('quote-lifecycle', 'quote now DECLINED',
          gq.status === 200 && gq.json.header?.status === 'DECLINED',
          `status=${gq.json?.header?.status}`, id);
        // Re-decline is an allowed self-transition (200); a forward move out
        // of the terminal state must be a 422.
        const rAgain = await this.s.post(`${QUOTE(id)}/decline`, { reason: 'double decline' }, {
          label: 'POST /quotes/:id/decline',
        });
        this._status('quote-lifecycle', 're-decline allowed as self-transition', rAgain, 200, id);
        const rRevive = await this.s.post(`${QUOTE(id)}/offer/submit-for-approval`, { comment: 'revive attempt' }, {
          label: 'POST /quotes/:id/offer/submit-for-approval',
        });
        this._status('quote-lifecycle', 'DECLINED -> AWAITING_APPROVAL rejected 422', rRevive, 422, id);
      }
    } else if (renewedId) {
      // Delete the RENEWED quote; the original survives.
      const rDel = await this.s.del(QUOTE(renewedId), { label: 'DELETE /quotes/:id' });
      if (this._status('quote-lifecycle', 'delete renewed quote', rDel, 200, renewedId)) {
        const gGone = await this.s.get(QUOTE(renewedId), { label: 'GET /quotes/:id' });
        this._status('quote-lifecycle', 'deleted quote 404s', gGone, 404, renewedId);
        const gOrig = await this.s.get(QUOTE(id), { label: 'GET /quotes/:id' });
        this._status('quote-lifecycle', 'original survives child delete', gOrig, 200, id);
        this.quotes = this.quotes.filter((q) => q.id !== renewedId);
      }
    }
    return rec;
  }

  // ── list endpoints ───────────────────────────────────────────────────────

  async probeLists() {
    if (this.treaties.length) {
      const t = this.treaties[0];
      const cedantId = t.plan.create.cedant_id;
      const r = await this.s.get(`/api/treaties?uw_year=${this.uwYear}&cedant_id=${cedantId}&limit=200`, {
        label: 'GET /treaties (list)',
      });
      if (this._status('lists', 'treaty list filtered read', r, 200)) {
        const rows = r.json || [];
        this._chk('lists', 'own treaty visible in filtered list',
          rows.some((row) => row.contract_id === t.id),
          `list of ${rows.length} rows lacks treaty ${t.id}`, t.id);
        const total = Number(r.headers.get?.('x-total-count'));
        this._chk('lists', 'treaty list X-Total-Count consistent',
          Number.isFinite(total) && total >= rows.filter((row) => row.contract_id === t.id).length && total >= rows.length,
          `X-Total-Count=${r.headers.get?.('x-total-count')} rows=${rows.length}`);
      }
      const rPage = await this.s.get(`/api/treaties?uw_year=${this.uwYear}&limit=5&page=1`, {
        label: 'GET /treaties (list)',
      });
      if (rPage.status === 200) {
        this._chk('lists', 'treaty list pagination honours limit',
          (rPage.json || []).length <= 5, `rows=${(rPage.json || []).length}`);
      }
      const rStatus = await this.s.get(`/api/treaties?status=SIGNED&uw_year=${this.uwYear}&limit=500`, {
        label: 'GET /treaties (list)',
      });
      if (rStatus.status === 200) {
        const signedMine = this.treaties.filter((x) => x.signed).map((x) => x.id);
        const listed = new Set((rStatus.json || []).map((row) => row.contract_id));
        this._chk('lists', 'status filter returns only SIGNED and includes mine',
          (rStatus.json || []).every((row) => row.uw_status === 'SIGNED')
            && signedMine.every((sid) => listed.has(sid)),
          `signedMine=${signedMine.length} listed=${listed.size}`);
      }
    }
    if (this.quotes.length) {
      const q = this.quotes[0];
      const r = await this.s.get(`/api/quotes?uw_year=${this.uwYear}&limit=500`, { label: 'GET /quotes (list)' });
      if (this._status('lists', 'quote list read', r, 200)) {
        this._chk('lists', 'own quote visible in list',
          (r.json || []).some((row) => row.quote_id === q.id),
          `list lacks quote ${q.id}`, q.id);
      }
    }
  }

  // ── negative probes (malformed input) ────────────────────────────────────

  async probeBadInput() {
    const rNoDate = await this.s.post('/api/treaties', { uw_year: this.uwYear }, { label: 'POST /treaties' });
    this._status('validation', 'treaty create without inception_date rejected 400', rNoDate, 400);

    const r404 = await this.s.get(TREATY('00000000-0000-4000-8000-000000000000'), { label: 'GET /treaties/:id' });
    this._status('validation', 'unknown treaty id 404s', r404, 404);

    if (this.treaties.length) {
      const id = this.treaties[0].id;
      const rBadTri = await this.s.post(`${TREATY(id)}/triangles/NOT_A_TYPE`, { cells: [], variant: 'MODIFIED' }, {
        label: 'POST /treaties/:id/triangles/:type',
      });
      this._status('validation', 'invalid triangle type rejected 400', rBadTri, 400, id);
      const rBadVar = await this.s.post(`${TREATY(id)}/triangles/PREMIUM`, { cells: [], variant: 'BOGUS' }, {
        label: 'POST /treaties/:id/triangles/:type',
      });
      this._status('validation', 'invalid triangle variant rejected 400', rBadVar, 400, id);
      const rBadStatus = await this.s.put(TREATY(id), { terms: { header: { uw_status: 'NOT_A_STATUS' } } }, {
        label: 'PUT /treaties/:id',
      });
      this._status('validation', 'invalid uw_status enum rejected 400', rBadStatus, 400, id);
    }
    const rBadQuote = await this.s.post('/api/quotes', { uw_year: this.uwYear }, { label: 'POST /quotes' });
    this._status('validation', 'quote create without inception_date rejected 400', rBadQuote, 400);
  }

  // ── the full workbook ────────────────────────────────────────────────────

  /**
   * @param {{ baseTreaties: number, renewals: number, kinds: string[] }} quota
   */
  async run(quota) {
    for (let i = 0; i < quota.baseTreaties; i += 1) {
      const kind = quota.kinds[i % quota.kinds.length];
      const rec = await this.createTreaty(kind);
      if (!rec) continue;
      if (kind === 'PROP') await this.modelPropTreaty(rec);
      else await this.modelNpTreaty(rec);
      await this.probeOptimisticLock(rec);
      await this.probePeerPermissions(rec);
    }

    // First treaty walks the full workflow to SIGNED (renewals need one);
    // second (when present) hosts the illegal-transition probe from DRAFT.
    if (this.treaties[0]) await this.signTreaty(this.treaties[0]);
    if (this.treaties[1]) await this.probeIllegalTransition(this.treaties[1]);

    for (let i = 0; i < quota.renewals; i += 1) {
      const signed = this.treaties.find((t) => t.signed && !t.renewedAlready);
      const target = signed || this.treaties[0];
      if (!target) break;
      target.renewedAlready = true;
      const renewed = await this.renewTreaty(target);
      // Model the renewal like a real next-season file: fresh terms, then sign it.
      if (renewed && this.rng.chance(0.5)) {
        const r = await this.s.put(TREATY(renewed.id), {
          terms: {
            detail: {
              qs_limit: this.rng.money(500_000, 5_000_000),
              cession_pct: this.rng.pct(50, 90),
              experience_start_year: this.uwYear - 9,
            },
          },
        }, { label: 'PUT /treaties/:id', headers: { 'if-unmodified-since': renewed.lastSeen } });
        if (this._status('treaty-put', 'model renewal terms', r, 200, renewed.id)) {
          renewed.lastSeen = r.json.updated_at;
        }
      }
    }

    await this.runQuoteFlow();
    await this.probeLists();
    await this.probeBadInput();

    // Concurrency race probe on this agent's own first treaty.
    if (this.treaties[0]) await this.raceSameBaselinePuts(this.treaties[0]);
  }
}
