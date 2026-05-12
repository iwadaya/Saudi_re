# CSS Roadmap: Tokens -> Ratchet -> Pilot

Audit date: 2026-05-01.

## Audit Snapshot

The app currently has about 16.5k lines of CSS under
`client/src/styles`, plus a large amount of inline style in JSX. Tokens
exist in `client/src/styles/tokens.css`, and some screens already use
them well (`components.css`, `numbers.css`, theme variables). The main
debt is not absence of tokens; it is uneven adoption.

Observed hotspots:

* hardcoded colors, radii, borders, and shadows in pricing/final-pricing
  JSX;
* repeated table/input styling across proportional and NP workflows;
* screen CSS files that predate the shared numeric typography tokens;
* status/peril colors mixed with structural UI colors.

## Sequence

### 1. Tokens

Expand `tokens.css` only for values that recur across screens:

| Token family | Examples |
| --- | --- |
| Surface | page, panel, table header, editable input, read-only input |
| Text | strong, body, muted, disabled, inverse |
| Border | subtle, regular, focus, danger, warning |
| Status | success, warning, danger, info |
| Data/peril | risk, cat, both, premium, loss, aggregate |
| Sizing | table cell height, dense input height, compact radius |

Keep actuarial/data colors separate from theme surface colors. A CAT
color should not be repurposed as a generic blue border.

### 2. Ratchet

Add gradual rules that prevent new drift without breaking the current
app all at once:

1. No new hardcoded hex colors in CSS outside `tokens.css`, except
   documented data/status colors.
2. No new inline `boxShadow`, `borderRadius`, or large style objects in
   pricing screens unless the value is dynamic.
3. New repeated table controls must use shared classes or components.
4. Tests/screenshots for migrated screens must cover desktop and narrow
   widths before ratcheting further.

The ratchet should begin as documentation plus review checklist. Once
the pilot is stable, promote it to lint-style checks with an allowlist.

### 3. Pilot

Pilot on pricing surfaces because they are high-value and already under
test expansion:

1. `client/src/screens/non_proportional/final_pricing`:
   move static inline style clusters from layer/offer tables into
   `final_pricing.css`.
2. `client/src/screens/proportional/pricing`:
   normalize table cells, scenario grid inputs, and snapshot history
   against shared dense table/input tokens.
3. Shared modal/table primitives:
   extract reusable dense table, numeric input, and status chip classes
   only after both pricing surfaces converge.

## Acceptance Criteria

* New pricing UI uses tokenized surface/text/border/radius values.
* Inline styles remain only for dynamic widths, computed colors, or
  layout values that truly depend on runtime data.
* No visible regressions in pricing screens at desktop and mobile widths.
* Color usage distinguishes product theme, workflow status, and actuarial
  data categories.
