# FlowTrace — design brief for the workspace rework

Written 11 Sep after walking every stage of the running app at 1100–1536px.
Everything in here was observed, not inferred.

**Read this first.** The engine, the API, the tests and the *content* of every
panel are in good shape. Do not touch the backend. Do not change a single
number, formula, caveat or finding. This brief is about **how things are
presented**: layout, hierarchy, visual encoding, copy, and consistency. The
honesty layer stays — its *form* changes from paragraphs to one labelled line
with the reasoning behind a disclosure.

The two rules from `FIX_PROMPTS.md` still hold: no number invented by the
frontend, and every unavailable capability named with what it needs.

---

## 1 · What is wrong, stage by stage

### Every stage

- Header wraps the project name to two lines; the version pill,
  "What this build can and cannot do" button, guest label, sign-in and theme
  toggle are jammed on one row and truncate below ~1200px.
- Type is uniformly small (mostly 11–13px) and uniformly grey. Headline
  numbers, body copy and footnotes have nearly the same visual weight.
- Engineering identifiers are shown verbatim: `in_review`, `not_started`,
  `MANDATORY_TASK`, `IMMUTABLE_DEPENDENCY`, `NON_DIVISIBLE_TASK`,
  `tier 2 · historical`, `structural_estimate`, `monte_carlo_probability`.
- Raw timestamps: `2026-09-06 05:12:38 UTC`.
- The guest indicator in the sidebar footer is clipped ("…g as a read-only
  guest").

### Build

- Functional and complete. Resource cards truncate their meta line
  ("person · cap 1 · in M…"). The task table is dense; the assignee column
  wraps with "add…" on its own line. Works, but reads as a spreadsheet.

### Live

- Replay works: clock, pause/restart, speed, timeline scrubber, projected
  finish, findings bar. But the graph beneath it is a ~200px postage stamp,
  and the stage is a grid of six small boxes of equal weight. The moving
  clock and the changing findings — the point of the stage — are not the
  focus.

### Bottlenecks

- **The dependency graph is illegible.** ~200px wide, 17 nodes and 22 edges
  overlapping, labels clipped to `T1…`. A text list of eight lanes sits
  beside it consuming the width the graph needs. This is the worst single
  defect in the product.
- The findings themselves are excellent — cause, evidence, "Do this", impact
  formula — but each is a block of prose of equal weight with no scan path.
  The "Do this" line, which is the action, is not visually distinguished
  from the explanation.
- Summary card ("0d projected slip / 11 critical / 10 findings") is fine
  but small and placed to the right where the eye does not start.

### Risk & forecast

- The three-point range (day 17 / 22 / 28) is good.
- Directly beneath it: a tinted box with **five paragraphs** of
  methodological caveat, including the literal API path
  `POST /api/projects/{project_id}/forecast` and the phrase "category
  error". This is a code comment rendered as UI.
- Factor decomposition is a paragraph per task ("driven mainly by slack
  ratio, criticality proximity, resource pressure. Slack ratio: 0 day(s) of
  slack against 3 day(s) of work (ratio 0.00)…"). Nine weighted factors are
  a bar chart, not a sentence.
- The Monte Carlo result and the structural score are both present, both
  correctly separated, and both buried.

### Requirements, What if, Better workflows, History

- All functional. Same issues: dense, small, grey, engineering labels.
- What if: "Saved scenarios — 35: 4 authored, 31 optimizer candidates".
  Scenario names are `R1: Option 2`. Timestamps raw.
- The "no model configured" badge on the natural-language input is a dark
  pill on the right of the field — correct information, wrong emphasis.

### Landing → workspace list → workspace

- Three visual systems. Landing: light, purple accent, large type, marketing
  layout. Workspace list: dark navy. Workspace: light grey, dev-tool. Moving
  between them feels like changing products.

---

## 2 · Principles — every panel is checked against these

1. **Visual before prose.** If a value has a range, a share, a rank or a
   trend, draw it. The sentence explaining it goes behind a disclosure or a
   tooltip. Applies to: factor weights (bars), forecast range (band),
   slack (bar tail — the graph already does this), impact (badge + bar),
   band counts (segmented bar).

2. **One caveat line, one click to the reasoning.** Every place the honesty
   layer speaks, it says one precise sentence in the UI's own voice, always
   visible, then offers "Why?" or "How this was computed" as a disclosure.
   The full text that is there today moves *into* the disclosure verbatim —
   nothing is deleted, only relocated. Never more than one caveat line
   visible per panel by default.

3. **Nothing from the codebase in the copy.** No snake_case, no
   SCREAMING_CASE, no API paths, no field names, no "category error". Enum
   values are rendered through one display map (see §5). Formulas appear
   only inside evidence disclosures, never as headings.

4. **A type scale, used.** Four sizes only, and the largest is reserved for
   the one number a panel is about:
   - Headline figure: 32–40px, semibold — "0d", "day 22", "54"
   - Section title: 18–20px, semibold
   - Body: 14px
   - Meta / label: 12px, muted — nothing smaller anywhere
   Every panel has exactly one headline figure or none.

5. **The action is the loudest text in a finding.** In every finding card,
   "Do this: …" is the visually dominant line. Cause and evidence support it.

6. **The graph gets the room it was designed for.** Full width of the main
   column on Bottlenecks and Live. Lanes are swimlane rows *inside* the
   graph, not a list beside it. See §3.

7. **One visual system.** One background, one surface colour, one accent,
   one type family, across landing, workspace list and workspace. The
   landing's purple accent and light ground are the most developed — carry
   those through. The dark workspace list becomes light.

8. **Dense is fine; clipped is not.** Tables can be tight. But no label may
   truncate at ≥1280px, the header may not wrap, and the sidebar footer must
   show the whole guest label.

---

## 3 · The dependency graph — specification

This is the priority. Fix it before anything else.

- **Width:** the full main column, minimum 800px at a 1280px viewport. The
  inspector rail (findings summary, lane stats) moves to the right at
  ≤ 320px, or below on narrow screens. The lane list *as a separate text
  block* is removed.
- **Layout:** time on the x-axis (already so), **one swimlane row per
  resource** on the y-axis, resource name as the row label at the left edge.
  Tasks render in their owner's row. This dissolves most edge crossings
  because dependencies tend to run left-to-right within and between lanes.
- **Nodes:** show the task *name*, not just the key, when width ≥ 96px;
  key + name on hover always. Minimum node height 28px. Duration bar plus
  slack tail as today.
- **Critical path** in the accent colour at full opacity; everything else
  at reduced opacity. Zero-slack should be readable from ten feet.
- **Edges:** solid for artifact, dashed for ordering (as today), but routed
  with orthogonal or gentle-curve connectors, never straight lines through
  other nodes.
- **Today marker** as a vertical line with the date label at the top, not
  clipped at the bottom.
- **Interaction:** pan and zoom (already partly there — make the controls
  visible and place them consistently), click a node to focus it in the
  inspector, hover for the full label.
- **In Live mode:** the same component, with the moving clock as the today
  line and status changes animating in place. The clock and the projected
  finish are the two headline figures on that stage; everything else is
  secondary.

Verification: at 1280×800, every task name on the seeded project must be
readable without zooming, and no two nodes may overlap.

---

## 4 · Panel-by-panel specification

### Header (all stages)

Two rows. Row one: stage name (meta size) · project name (section title,
single line, truncate with ellipsis only past ~40 chars). Row two: version
pill · capability button · identity (guest / signed-in name) · theme toggle.
Never wraps at ≥ 1024px.

### Bottlenecks

- Top: the graph, full width (§3).
- Beneath it, a **summary strip**: three headline figures in a row —
  projected slip, critical tasks, open findings — plus the one honesty line:
  *"15 checks ran, 3 could not — see why"* with the disclosure.
- Then the **finding cards**, one per finding, sorted by impact:
  - severity chip (high / medium / low) · task key + name · tier as a small
    muted label using the display map ("from history", not "tier 2")
  - **Do this:** … in body-size semibold — the loudest line
  - one sentence of cause, body size
  - impact as a numeric badge on the right, with a tiny bar proportional to
    the max impact on the page
  - "Evidence ▸" disclosure containing the formula and full reasoning,
    verbatim from today
- Suppressed findings behind a single "1 finding suppressed — why" link.

### Risk & forecast

- **Forecast band** at the top: a horizontal range from optimistic to
  pessimistic with the likely marker, the deadline as a vertical line. Three
  headline figures beneath the band. One honesty line:
  *"Three deterministic runs — a range, not a probability. Why?"* with the
  five current paragraphs inside the disclosure, verbatim.
- If Monte Carlo has run: a second, visually distinct band (P50/P80/P90)
  labelled *"Simulated — a probability under stated assumptions"*, with its
  own "Assumptions ▸". The two bands are never merged and never adjacent
  without their labels.
- **Per-task exposure**: a sorted list, each row = task name · band chip ·
  score · a stacked horizontal bar of the nine factor contributions in
  nine muted shades. Hover a segment for the factor name, weight and value.
  The current paragraph goes behind "How this was scored ▸".
- **Re-weighting** controls (the nine sliders) in a collapsible panel; on
  change, show a busy state and re-render from the engine's response.
- One honesty line for the whole section: *"Structural exposure — not a
  probability."* Once. Not four times.

### Requirements

- Staleness result as two clearly separated columns or groups: **Must
  redo** and **Must re-check**, each with count as a headline figure.
- History as a vertical timeline. Diff as a two-column comparison.

### What if

- The natural-language input first, with the provider state as a small
  muted line *beneath* it ("Interpreting with the built-in pattern matcher —
  no model configured"), not a dark badge inside the field.
- The structured form second.
- **Saved scenarios**: authored what-ifs listed first, each with a name the
  user gave (or a generated one from its mutation: "Anitha unavailable d14–
  d21"), relative time ("2 days ago", absolute on hover), and the headline
  effect ("finish +7d") in colour. Optimizer candidates collapsed under one
  row: "31 optimizer candidates from 2 runs ▸".

### Better workflows (optimize)

- Objectives shown as a small weights table above the results, editable if
  the API allows, read-only otherwise.
- Candidates as cards ranked by score: name · score as headline figure ·
  the mutation list rendered through the display map · "Verified by the
  engine" as a chip · effect on finish date. Refused candidates in a
  collapsed group with the constraint that refused each.

### Build

- Keep the structure. Fix truncation: resource cards get two lines (name /
  meta) at fixed height; the table's assignee cell shows chips with a "+"
  button rather than the word "add…".
- Constraints: render kind through the display map. `MANDATORY_TASK` →
  "Mandatory". The declaration form's kind list already uses plain English —
  use the same strings in the list.

### History

- Versions as a vertical timeline with the sealed/draft state as a chip and
  the accuracy figure as the row's headline number.

### Capability dialog

- Grouped by capability, each row: name · status chip (available /
  unavailable) · one line of what it needs. The AI row says which provider
  is active and what each of the three roles is doing right now. Keep it
  driven from the API.

---

## 5 · The display map — one file, used everywhere

Create `frontend/src/lib/display.ts` and route **every** enum and identifier
through it. Nothing else may render a raw enum.

| Raw | Shown |
|---|---|
| `not_started` | Not started |
| `in_progress` | In progress |
| `in_review` | In review |
| `done` | Done |
| `blocked` | Blocked |
| `MANDATORY_TASK` | Mandatory |
| `IMMUTABLE_DEPENDENCY` | Cannot be removed |
| `NON_DIVISIBLE_TASK` | Cannot be split |
| `FIXED_ASSIGNMENT` | Fixed assignment |
| `MIN_DURATION` | Minimum duration |
| `tier 0` / `structural` | From the structure |
| `tier 1` / `stateful` | From current status |
| `tier 2` / `historical` | From history |
| `tier 3` | From other projects |
| `structural_estimate` | Structural exposure |
| `monte_carlo_probability` | Simulated probability |
| `artifact` (edge) | Uses the output |
| `ordering` (edge) | Ordering only |
| `read_only_guest` | Read-only guest |
| any ISO timestamp | relative ("3 days ago"), absolute on hover |
| any mutation kind | a short verb phrase: "Slip T03 by 5 days", "Reassign T11 to Arjun" |

Add to this table as you find more. The test: `grep -rn "_" frontend/src
--include=*.tsx` on string literals inside JSX should find no snake_case
intended for display.

---

## 6 · Theme unification

- Ground: the landing page's light background. Surface: white cards with a
  1px border, 12px radius. Accent: the landing's purple. Critical path /
  high severity: one warm colour (amber or coral) used for nothing else.
  Verified / good: one green, used for nothing else.
- The workspace list (`/workspace`) is currently dark navy. Make it light,
  same tokens as the workspace stages.
- Dark mode: keep the toggle, but both modes must use the same tokens —
  only the values change.
- Type family: one, throughout. Whatever the landing uses.

---

## 7 · Order of work

1. The graph (§3). Until this is right nothing else matters.
2. Type scale + display map (§2.4, §5) — mechanical, touches everything,
   do it once.
3. Bottlenecks stage layout (§4).
4. Risk & forecast (§4) — the wall-of-text stage.
5. Header + sidebar footer + theme unification (§4, §6).
6. What if, Better workflows, Requirements, History, Build, Live in that
   order.
7. Capability dialog.

Commit after each numbered step. Tag `design-<n>`.

---

## 8 · Verification — screenshots, not test counts

After each step, run the frontend at **1280×800** and **1536×864** against
the seeded project and capture every stage. Then check, per screenshot:

- [ ] Every task name in the graph is readable; no two nodes overlap
- [ ] The header is on two rows and nothing in it truncates
- [ ] Exactly one headline figure per panel, or none
- [ ] No paragraph longer than two sentences is visible without opening a
      disclosure
- [ ] No snake_case, SCREAMING_CASE, API path or formula in visible text
      (formulas inside open disclosures are fine)
- [ ] No raw timestamp
- [ ] "Do this:" is the visually dominant line of every finding card
- [ ] The nine factors render as bars
- [ ] The forecast range renders as a band
- [ ] Landing, `/workspace` and every stage share background, surface and
      accent colours
- [ ] The sidebar footer shows the full guest label
- [ ] The Playwright walkthroughs still pass — they assert the *numbers*,
      which must not have changed

The existing browser walkthroughs assert content and must keep passing
untouched. If a walkthrough breaks because a label changed, update the
walkthrough to use the display-mapped string — that is the only kind of
test edit permitted.

---

## 9 · What must not change

- Any number, date, score, band or ranking. The engine is the only source.
- The *content* of any caveat or assumptions block — relocate into
  disclosures, never delete or soften.
- The unavailable-checks list — it stays visible as the one honesty line
  with its disclosure.
- Backend code. None of this touches `backend/`.
- The public read-only guest behaviour, the auth gate, `proxy.ts`.
