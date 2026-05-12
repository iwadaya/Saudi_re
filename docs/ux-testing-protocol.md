# UX testing protocol — 30-minute session

A lightweight protocol for validating the heuristic audit with one
real underwriter. Run this with 1–3 people; even one session
catches the findings that matter most.

## Before the session

- **Environment:** a staging URL (ideally a fresh DB seeded with the
  demo data) so the user can't harm production work.
- **Recording:** screen + audio via QuickTime / OBS / Zoom local
  recording. Ask consent first.
- **Account:** pre-log the user in as a Chief Underwriter
  (`x-user-role: CU`) so every action is available; this keeps
  the session about UX, not permissions.
- **Materials:** printed (or a second screen showing) the task
  cards below. You read each task aloud; they work.
- **Your seat:** silent observer. Don't help unless they're truly
  stuck for >90 s on a single step. Don't answer leading questions
  ("do I click here?" → "what would you expect?").

## During the session

### Task 1 — Price a new NP treaty (8 min)

> *"You've been asked to price a new Non-Proportional XL treaty for a
> new cedant. Starting from the home screen, create it with these
> values: UW year 2027, cedant Alpha Re, one Risk + Cat layer with
> limit USD 10 M, deductible USD 1 M, EGNPI USD 20 M, rate 2.5%. Enter
> a written line of 10%. Submit it for approval."*

**Watch for:**
- Does the user know where "new treaty" lives?
- When they type `2.5` in the rate field, do they pause or second-guess?
- Do they click "Save" or expect autosave? Does the wizard's Back/Next
  behaviour match their mental model?
- Where does their cursor rest on NP Final Pricing? Do they find the
  "Submit for Approval" button, and do they know which fields are
  required before it enables?

**Success =** they complete without prompting, the treaty is in
`WAITING_APPROVAL`, the pricing saved.

### Task 2 — Approve someone else's treaty (6 min)

> *"Another underwriter has submitted an NP treaty. Review their
> numbers and approve it. Pay attention to whether the pricing looks
> reasonable for the layer structure."*

**Watch for:**
- Do they find the Approvals queue?
- Which numbers do they look at first? (Tech ratio, margin, ROL per
  layer, expiring comparison)
- Do they click Compare Terms or Treaty Metrics modals? If so, do
  they understand what they're looking at?
- Can they articulate why they would/wouldn't approve?

**Success =** informed approve or decline, not a blind click.

### Task 3 — Recover from a mistake (6 min)

> *"You realise the written line you entered on the NP you created
> earlier was wrong — it should have been 5%, not 10%. Fix it and get
> the treaty back to the state where it can be re-submitted."*

**Watch for:**
- Do they know how to reopen a submitted treaty?
- Do they find the Recall action? Do they understand what it does?
- Once back in Draft, do they change the number and re-submit, or do
  they go looking for an "edit submission" flow that doesn't exist?

**Success =** recall → edit → re-submit, without prompting.

### Task 4 — Find a prior year comparison (5 min)

> *"Is this year's treaty structure similar to last year's for the same
> cedant? Show me where you'd check."*

**Watch for:**
- Do they navigate to Compare Terms?
- Do they understand the "Change" column? Do they switch to the Graphs
  tab? Did they know that tab existed?
- Where do they go looking that doesn't exist?

**Success =** they find the comparison and can name at least one
meaningful YoY delta.

### Close (5 min) — open questions

Ask, in order:

1. "On a scale of 1–10, how confident would you be pricing an NP
   treaty in this tool for a real submission?" (record the number, then
   ask why)
2. "What was the most confusing moment?"
3. "What's one thing that would make your daily work faster?"
4. "Was there any number or column you weren't sure how to interpret?"
5. "Did anything feel unsafe — like a click that could cost money?"

## Scoring (after the session)

For each task, record:

| Score | Meaning |
|-------|---------|
| 4 | Completed without hesitation |
| 3 | Completed with minor hesitation (self-recovered, < 10 s) |
| 2 | Completed with major hesitation or wrong-turn (> 30 s) |
| 1 | Needed prompting to complete |
| 0 | Could not complete |

Also tally:

- **Data-loss moments** — any time the user entered data they
  assumed was saved but wasn't, or navigated past a failed save.
- **Wrong-unit entries** — rate vs ROL, % vs fraction, money with
  currency prefixes.
- **Dead ends** — buttons clicked that did nothing, dropdowns
  opened and closed.

## Map findings back to the heuristic audit

After the session, walk the heuristic audit's 15 findings
(`audit summary` in the corresponding commit message) and mark each
CONFIRMED / NOT SEEN / ADDITIONAL. Items confirmed by even one real
user jump to HIGH priority.

## Bad-session escape hatches

If the user is clearly frustrated:
- Offer to skip a task rather than burn 10 min on one step.
- Tell them "this is testing the app, not you" after the second
  hesitation — people clam up when they feel judged.
- Absolutely don't walk them through a task you want to test; if
  they can't find it, that's the finding.

## Sample size

- **1 session** catches ~33% of the findings above.
- **3 sessions** catches ~80%.
- **5 sessions** is the Nielsen sweet spot; anything more has
  diminishing returns until you redesign.

For a 3-week demo window, one session this week and one after the
first week of real usage is enough.
