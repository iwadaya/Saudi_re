# Retro Cover Analysis — Offer Modal

**Status:** Implemented (NP treaty offer modal).
**Audience:** Underwriting / actuarial / engineering.
**Code:** `client/src/screens/non_proportional/final_pricing/retroCover.js`
(maths, pure), `.../components/NpRetroCoverPanel.jsx` (panel),
`.retro-*` in `client/src/styles/non_proportional/final_pricing.css`.

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

There is no retro programme in the database today. The panel therefore:

- **derives** a starting programme from the tower in front of the underwriter —
  retention at 5% of the 100% tower, retro limit at 25% of it, 8% ROL, no quota
  share — so it says something useful before anyone touches it; and
- **persists** whatever the underwriter enters under `u3.retroProgramme.v1` in
  `localStorage`, since one outward programme applies across treaties.

That is the main limitation of the feature as built: the assumptions are
per-browser, not per-company, and nothing validates them against the actual
outward placement. Promoting them to a company-level record (with the retro
placement, its reinstatements and the limit consumed to date by bound business)
is the natural next step, and the maths module is already shaped for it — it
takes a programme object and nothing else.

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
