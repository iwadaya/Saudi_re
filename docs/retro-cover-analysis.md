# Retro Cover Analysis — Offer Modal

**Status:** Implemented (NP treaty offer modal + admin capture).
**Audience:** Underwriting / actuarial / engineering.
**Code:** `client/src/screens/non_proportional/final_pricing/retroCover.js`
(maths, pure), `.../components/NpRetroCoverPanel.jsx` (panel),
`.retro-*` in `client/src/styles/non_proportional/final_pricing.css`,
`client/src/screens/admin/RetroProgrammeScreen.jsx` (admin capture),
`server/src/routes/retroProgrammes.js` + migration
`140_retro_programme.sql` (the record).

---

## 1. What it answers

The offer modal already suggests a written line. It did not say what that line
does to our own outward programme, so the underwriter had to hold the retro
position in their head — or find out at the next retro renewal. The panel
answers three questions on the screen where the line is committed:

1. **Is the suggested line covered?** How much of a full-tower event comes back
   from retro, what stays net, and whether any of it sits above the programme.
2. **What does it cost?** The retro limit the line consumes, priced at the
   programme's rate on line, and what that does to the margin.
3. **What line is best?** The line that gets the most out of the retro capacity
   it consumes — with an apply button that writes it onto every layer.

## 2. The model

For a written line `L` on the inward tower, a full-tower event produces:

| Quantity | Definition |
|---|---|
| Gross event loss | Σ layer limit × L |
| Gross premium | Σ layer 100% premium × L |
| Gross expected loss | Σ layer limit × technical ROL × L |

The technical ratio on an NP layer is the break-even rate on line — the same
units as the ROL — so it converts limit to expected loss directly. Layers
without their own technical ratio fall back to the treaty average.

The outward programme is applied in the usual order:

1. **Retro quota share** — cedes `cessionPct` of premium and loss and earns
   `commissionPct` of the ceded premium as commission.
2. **Retro XL** — `limitAmt` xs `retentionAmt` on what the quota share leaves,
   less `usedLimitAmt` already burned by the rest of the book. The recovery is
   `clamp(net event − retention, 0, available limit)`.

Anything above retention + available limit is **unprotected**: exposure the
programme was not bought to carry. A line carrying any of it is flagged as a
breach rather than merely expensive.

**Cost of cover** is charged at `rolPct` on the limit *this treaty consumes* —
a marginal cost-of-capacity allocation. It is deliberately not a pro-rata share
of the whole retro spend: the question on the screen is what the next line
costs, not how last year's spend is apportioned. It is a conservative charge —
the same limit protects the rest of the book at the same time.

## 3. Optimisation

The optimiser sweeps the line in quarter-point steps up to `maxLinePct` and
maximises **return on retained capacity** — net margin per unit of net retained
event loss — subject to the line being fully protected and profitable. Ties go
to the larger line: the same return for more absolute margin.

The shape of that curve is the point of the panel:

- **Below the retention** every point of line is fully retained, so the return
  is flat — retro is doing nothing yet.
- **Above the retention** the retro absorbs the exposure while the premium keeps
  growing against a fixed retention, so the return climbs — provided the cost of
  cover is less than the margin each extra point earns. Where the cover is dear,
  the peak sits at the retention and the honest answer is a smaller line.
- **Past the limit** the retention starts growing again, unprotected. Those
  lines are excluded, and the point where that starts is drawn on the chart.

The verdict banner reads the suggested line against that optimum: `HEADROOM`
(room above), `OVER` (the line is buying more retro than it earns), `ALIGNED`,
or `BREACH` (not fully protected).

## 4. Where the programme comes from

The retro contract is **company data, captured manually by an admin for each
underwriting year** — never derived, never guessed. It lives in
`public.retro_programme` (migration 140), one row per `(uw_year, currency)`,
maintained under **Admin → Retro Programme** (`/admin/retro-programme`, level 2:
Chief Executive / Chief Underwriter / Chief Actuary, enforced again on the
server). Reads are open to any authenticated user — every underwriter needs the
programme to see what their line does to it.

| Field | Meaning |
|---|---|
| `uw_year`, `currency` | The key. Saving an existing pair replaces it (upsert). |
| `label`, `reinsurer`, `inception_date`, `expiry_date` | Placement identity. |
| `retention_amt`, `limit_amt`, `rol_pct` | The retro XL: limit xs retention, at that rate on line. |
| `used_limit_amt` | Limit the rest of the book has already burned — the admin maintains it as the year runs. |
| `cession_pct`, `commission_pct` | The retro quota share above the XL. |
| `max_line_pct` | Largest line the optimiser may recommend. |

The offer modal looks the contract up by the treaty's underwriting year (its
start year, else the year of its inception date) and its currency. Two
deliberate refusals:

- **No FX.** A programme placed in another currency is not this treaty's cover,
  so the lookup matches the currency exactly and reports which currencies that
  year does have rather than converting.
- **No stand-in.** With no record for that year and currency the panel says so
  and shows nothing — no scenarios, no curve, no invented retention.

The underwriter can layer **what-if** assumptions on top of the record inside the
modal. Those are never saved and are labelled as such while they are in force;
changing the contract of record is the admin's job.

Still outstanding: the record carries no reinstatement terms, and
`used_limit_amt` is maintained by hand rather than accumulated from bound
business.

## 5. Known simplifications

- **One event, full tower.** Exposure is the full vertical limit on a single
  event. It is the standard capacity view, and conservative for a treaty whose
  layers cannot all be exhausted by one loss.
- **No reinstatements** on either the inward layers or the retro. Inward
  reinstatement premium is ignored, as is the cost of reinstating the retro.
- **Expected loss is the technical ratio.** No separate frequency/severity view
  and no allowance for the retro recovering part of the expected loss — for a
  programme attaching well above the working layer that is close to right, and
  it overstates net expected loss where it attaches low.
- **The quota share cedes losses at the same rate as premium**, with no
  sliding-scale or loss-participation commission.
- **The panel is NP treaty-only.** Quote mode shows the submission summary
  instead, and the proportional offer modal has no equivalent yet.
- **One programme per year and currency.** A tower of several retro layers, or a
  mid-year replacement placement, has to be entered as one blended set of terms.
