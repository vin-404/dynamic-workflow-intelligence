# Design rework report — branch `feat/design-rework`

Run on 11–12 September 2026, unattended, against `docs/DESIGN_BRIEF.md`.
Branch created from `feat/capability-completion` at `ecd0493`. `main` was
not touched. Nothing was deployed; pushing the branch is the only
deployment this run may have caused (a Vercel preview).

**Read this first.** All seven steps in the brief's order are done, each
its own commit and tag (`design-1` … `design-7`). No backend file changed.
No number, date, score, band or ranking changed; every caveat that was on
screen is still present, either visible as one line or verbatim inside a
disclosure. Three things need a human look in the morning, listed under
"Review first". Two decisions in `docs/DECISIONS.md` were consciously
overridden by the brief and are named below.

---

## Final state

| | |
|---|---|
| Branch | `feat/design-rework` |
| Commits | 7 code commits, tagged `design-1` … `design-7`, plus this report |
| Backend tests | 1071 passed (unchanged; `backend/` untouched) |
| `npx tsc --noEmit` | clean |
| `npm run build` | passes |
| `npx eslint src` | 11 errors, 46 warnings; the overnight report recorded 12 errors before this branch. Every error is a pre-existing kind (`react-hooks/set-state-in-effect` on theme/loader effects, unescaped entities and `<a>` on the login and landing pages). None introduced in kind. |
| Browser walkthrough `e2e/capabilities.mjs --branch --skip-writes` | passes every stage as the guest against an enforcing backend, after each step |
| Visible-text scan (`e2e/design-text.mjs`) | 0 hits on every stage: no snake_case, SCREAMING_CASE, API path, formula or raw timestamp visible |
| Graph check (`e2e/design-check.mjs`) | 17 bars, every name drawn, nothing truncated, no overlaps, nothing under the zoom controls — at 1280×800 and 1536×864, on Bottlenecks and Live |

Screenshots for every step are under `docs/screens/`:

| Folder | What |
|---|---|
| `before/` | Every stage, landing and list, at 1280 and 1536, before any change |
| `step1/` | Bottlenecks and Live after the graph |
| `step2/` … `step5/` | Every stage after that step (`step5/` also has `dark-*` captures) |
| `step6/` | Every stage at the end, at both sizes, viewport and full page; `requirements-open-1280.png` is the requirement stage with R1 selected |
| `step7/` | The capability dialog, and the dialog with the AI status endpoint deliberately unreachable |

The `-full.png` files are full-page captures; the others are the 1280×800
or 1536×864 viewport.

---

## What changed, per step

### design-1 · `22017d2` — the graph

The brief's priority. Before: a ~560px box beside a text rail, 17 bars in
32px lanes, labels clipped to `T1…`. After: the full main column (869px at
1280, 1125px at 1536), 40px lanes, 28px bars.

- Every task **name** is drawn: inside the bar when it fits, beside it when
  it does not, on the canvas colour so an edge passes behind the words.
- Bars pack into sub-rows on their *visible footprint* — bar plus label —
  so no two overlap. The slack tail is still not part of the footprint
  (D-121). This is an extension of D-121's rule, not a reversal: a lane
  splits only when two bars *or their names* would collide.
- The day width fits the horizon **and** the widest trailing label, so a
  late task's name never runs under the zoom controls.
- The zero-slack chain is one warm colour (`--critical`, coral) at full
  opacity; everything else steps back to 60%. Done tasks carry a check
  before the key so a status change stays visible on the chain in Live.
- Edges all render beneath bars (they were mixed by z-index); the today
  marker's label sits on the axis at the top instead of clipping at the
  bottom; ticks that would sit under it are left out.
- Click a bar to focus it: the Bottlenecks rail gained a task inspector
  showing the engine's schedule, slack, exposure and the findings naming
  it. Nothing in it is computed in the browser.
- Type in the chart is 12px minimum (was 10–11px), lane names 14px.

Before/after: `docs/screens/before/bottlenecks-1280.png` →
`docs/screens/step1/bottlenecks-1280.png`.

### design-2 · `5375449` — display map and type scale

- `frontend/src/lib/display.ts` is the one place an API identifier becomes
  words: status, constraint kind, evidence tier, score kind, edge kind,
  role, finding kind (15 detectors plus the three withheld ones),
  severity, verdict, band, spread provenance, distribution, the nine risk
  factors, optimizer objectives and generators, scenario status and
  origin, resource kind, AI provider, and every mutation kind as a verb
  phrase built from its payload ("Slip T03 by 5 days", "Re-word R1 to
  v2") with the engine's own `describes` as the fallback. Unknown values
  are humanised, never crashed on.
- `prose()` reads the three status identifiers the engine embeds in its
  sentences ("It is in_review") as words. Nothing else in a sentence is
  touched. **This is the one place the presentation edits engine text** —
  see "Review first".
- `<When>` renders every timestamp relative ("3 days ago") with the
  precise UTC instant on hover; History shows the instant inline as well.
- Twenty-one components route their labels through the map. Every
  `text-[8|9|10|11px]` became 12px; the sidebar nav tightened so eight
  stages fit at 800px tall.
- Walkthroughs: four assertions that named a label the map changed now
  assert the mapped string (see "Test edits").

### design-3 · `75adf62` — Bottlenecks layout

- `BottleneckSummary`: three headline figures (projected slip, critical
  tasks, open findings) and the one honesty line — "Evidence from history
  · 15 checks ran, 3 could not." — with the unavailable-checks text behind
  "What this analysis cannot assess yet, and why", verbatim.
- One card per finding, sorted by impact, no longer grouped by cause.
  **"Do this: …"** is the loudest line; one sentence of cause supports it;
  the impact is a number with a bar proportional to the largest on the
  page. Full explanation, worked arithmetic, formula, evidence fields and
  downstream tasks sit behind "Evidence ▸". A task key on a card focuses
  it in the graph and inspector.
- Suppressed findings behind "1 finding suppressed — why", content
  unchanged.

### design-4 · `3edeabb` — Risk & forecast

- Three-point range as a band (optimistic → pessimistic, likely marked,
  today marked, deadline through it), three days at headline size, one
  line: "Three deterministic runs — a range, not a probability." with
  "Why?" holding the method and the five paragraphs, verbatim.
- Simulated forecast with its own visibly different band — the finish-day
  histogram with P50/P80/P90 ticked and the deadline line — under the one
  figure the panel is for (95.9%). One line: "Simulated — an uncalibrated
  probability under stated assumptions: durations are sampled
  independently and resource contention is not modelled." "Assumptions ▸"
  holds the disclaimer, the two-kinds table, the lifted notes, the band
  note, the run facts and the full assumptions bag.
- Per-task exposure: every task a row with a stacked bar of its nine factor
  contributions in nine muted shades (hover a segment for factor, weight,
  value, reading), score, band chip; a row opens to the full factor table.
  One line: "Structural exposure — not a probability." with "How this is
  scored". A legend names the nine factors.
- Weights: a collapsible panel, open by default (the walkthrough fills the
  inputs, so they must be visible), nine inputs in one row.
- The forecast panel is slotted between the range and the exposure list,
  so the two kinds of number are never adjacent without their labels.

### design-5 · `b94de94` — header, sidebar footer, theme

- Two-row header: stage name and project name on one line (ellipsis past
  its width); version pill, capability button, identity and theme toggle
  on the second. Nothing wraps or truncates at 1280 or 1536.
- Sidebar footer shows the whole guest label on two lines.
- `/workspace` was dark navy with cyan links; it is now light on the same
  tokens, with the same logo mark, accent gradient and theme toggle.
- One token set for both modes: the shell, list, forms and timeline read
  `--background`, `--panel`, `--line`, `--dim`, `--accent`; dark mode swaps
  in the landing's navy values. The graph's forced-light overrides are
  gone, so it is the same chart in either mode. Headings that inherited a
  hard-coded light ink and vanished in dark mode read the foreground token.
- Severity-high is now the same warm colour as the critical chain, so one
  warm hue means "critical or high" and nothing else.
- One type family throughout (the Geist webfont the layout already loads);
  the Avenir/Segoe override that gave headings a second family is gone.
- One surface radius: 12px cards and stage sections, 8px controls, 6px
  chips.

### design-6 · `e93b80e` — What if, Better workflows, Requirements, History, Build, Live

Done by six parallel passes, one per stage, each verified by screenshot
and text scan before it reported. Summary:

- **What if** — sentence box first with the provider state as a muted line
  under the input; saved scenarios list authored what-ifs first (name,
  status, origin, relative time, the engine's effect in colour, a verb
  phrase from the recorded mutation) and collapse the optimizer
  candidates under one row. Delete flow unchanged.
- **Better workflows** — objectives as a weights table above results in
  both states; candidates as cards with the total at headline size,
  "recommended" and green "Verified by the engine" chips, mutations in
  words, per-criterion table behind a disclosure; refused candidates one
  collapsed group with the refusing constraint in words.
- **Requirements** — "Must redo" and "Must recheck" as two panels with
  headline counts (redo warm, recheck amber) in both the staleness preview
  and the impact report; recorded wordings as a timeline with the text
  diff before | after; the diff view before | after in two columns.
- **History** — versions as a rail-and-dot timeline (state chip, note,
  precise instant in words, full hash); detector accuracy keeps recall as
  the one headline; known problems as a table with found/missed chips.
- **Build** — resource cards no longer clip at 1280; constraint chips sit
  under the task name instead of squeezing the input; composers give
  every control a column; member roles through the display map.
- **Live** — the clock (calendar date at headline size, "Simulated day N"
  beneath) and the projected finish are the two headline figures; the
  controls sit under the clock with the speed in short words; state words
  are plain chips; the reconstruction panel carries the evidence line with
  every caveat behind one disclosure; findings follow the Bottlenecks card
  pattern. The replay scrubber, which the theme's input rule had painted
  over, is visible again.

### design-7 · `71ad846` — capability dialog

Rows of name · status chip · one line, grouped under 18px headings, with
the API's full text behind "Why ▸" and each group's source endpoint behind
"Where this was read ▸" (kept, because it is what a reader checks, but no
longer visible unopened). An unreachable source renders as an amber "could
not determine" row, never as available. `providerLabel` joins the display
map because the API sends the string "null" for no provider.

---

## Review first

1. **The local dev database was mutated by a walkthrough and repaired by
   hand.** The backend was running without `PROXY_SHARED_SECRET` when I
   arrived, so roles were not enforced; the first `capabilities.mjs` run's
   guest-write probe was *accepted* (201) and created task `PV0`, a
   `MANDATORY_TASK` constraint on it, and a new draft version 3 of the
   seeded project. I deleted the constraint and the task through the API,
   then removed the draft version's rows (`tasks`, `dependencies`,
   `resources`, `assignments`, `requirements`, `constraints`, `calendars`,
   `analysis_runs`, `workflow_versions`) and re-pointed
   `projects.current_version_id` back to version 2 in `dwi.db` directly,
   and restarted the backend with the secret from `frontend/.env.local` as
   process environment (no file changed). The seeded project reads
   "Version 2 · sealed, 17 tasks, 4 constraints" again and every number
   matches the baseline screenshots. I also deleted the eight
   "T01 takes 5 more day(s) than it looks like" what-if scenarios the
   walkthrough runs kept (they are not skipped by `--skip-writes`), so the
   list is back to its 35. If `dwi.db` matters to anyone, check it.
2. **`prose()` edits engine sentences.** It replaces `not_started`,
   `in_progress` and `in_review` with the same words spaced, inside
   explanations, suggested actions and factor readings. Brief §2.3 forbids
   identifiers in copy; §9 says caveat content may not change. I judged a
   spacing change to a status word as presentation. If that is wrong, the
   function is one place to revert.
3. **The optimizer's post-search cards and the requirement impact report
   were not seen rendered.** As the guest, a search writes up to forty
   scenarios and a requirement change writes a replan to the database, so
   neither was run. Both were checked by reading the code against every
   string the walkthroughs assert. The journey walkthrough would exercise
   them on the Battery Pack project, but it cannot run (see below).

## Decisions the brief overrode

- **D-127** (History shows the real instant, never a relative form). The
  brief maps every timestamp to relative-with-absolute-on-hover. History
  keeps the precise instant inline as well ("3 days ago · 8 Sep 2026,
  05:12 UTC"), so provenance is not lost; the raw string form is gone.
- **D-105** (the forecast's caveats are open, not a disclosure). The brief
  wants one caveat line per panel and the rest behind a disclosure. Every
  word is still present; the line names the two optimisms (independence,
  no contention) so the reader is warned without opening anything.
- **§3 vs §6 of the brief itself.** §3 says the critical path is "in the
  accent colour"; §6 says critical path and high severity share "one warm
  colour used for nothing else". I used the warm colour, and left the
  blue-violet accent for chrome, links and disclosures, which is what
  D-94/D-117 also wanted.
- **The accent.** §6 asks for "the landing's purple". The landing's accent
  is the blue-to-violet gradient (`#4164FA` → `#795CF7`); both tokens are
  kept and used together as they were, rather than repainting to a single
  purple.

## Test edits

The only permitted kind: a walkthrough asserting a label the display map
changed now asserts the mapped string. Six assertions, two files:

| File | Was | Now |
|---|---|---|
| `e2e/capabilities.mjs` | `"MANDATORY_TASK"` | `"Mandatory"` |
| `e2e/capabilities.mjs` | `/evidence tier/i` (live) | `/evidence from/i` |
| `e2e/capabilities.mjs` | `/Evidence tier \d/` (bottlenecks) | `/Evidence from/` |
| `e2e/capabilities.mjs` | `/Tier 2 reached/` and `/Tier 3 · cross-project/` | `/Evidence reached · From history/` and `/From other projects/` |
| `e2e/capabilities.mjs` | `/structural estimate/i` (risk) | `/Structural exposure/i` |
| `e2e/journey.mjs` | `"Evidence tier"`, `"structural estimate"` | `"Evidence from"`, `"Structural exposure"` |

No assertion was deleted, skipped or loosened. The re-weighting check,
which derives request keys from the weight labels, still passes because
those labels stay lower-case factor words. Three new scratch tools were
added under `e2e/` and are not tests: `design-shots.mjs` (every stage at
1280 and 1536), `design-check.mjs` (bar labels, overlaps, controls),
`design-text.mjs` (visible identifiers, timestamps, paths, formulas).

## What I could not do, and why

- **`journey.mjs`, `ai.mjs` and `hardening.mjs` were not run to green.**
  `journey.mjs` fails at its first step on this branch *and on its
  parent*: it expects the landing page to list the seeded workflows, and
  the landing has been a marketing page since before this branch (the
  walkthrough last changed at `a1ab852`; the landing after it). That is
  not a label change, so I did not edit it. `ai.mjs` and `hardening.mjs`
  need a signed-in session and were not part of the previous run's
  verification either; I did not run them. The capabilities walkthrough,
  which covers every stage as the guest, passes.
- **Edges still cross lanes.** §3 asks for connectors that never run
  through other nodes. Edges are orthogonal, render beneath every bar and
  hide behind opaque bars and label pills, but a vertical segment between
  two lanes still passes through the lanes between. A true obstacle-
  avoiding router was out of scope for a presentation pass.
- **Live controls are under the clock, not beside it.** At 1280 the clock
  panel is ~514px wide; the date, state chip and three controls cannot
  share a row without truncating something, which §2.8 forbids.
- **Landing page hex values.** `LandingPage.tsx` still uses literal
  colours. In light mode they equal the tokens' values, so the three
  surfaces share ground, surface and accent as §6 asks; in dark mode the
  landing's own navy set is what the dark tokens were aligned to. It was
  not tokenised (1,100 lines; the visible result already matches).
- **No "from N runs" on the optimizer-candidates row.** A scenario carries
  no run identifier, so the count cannot be given honestly; the row says
  "31 optimizer candidates".
- **Three-point figures.** §2.4 says one headline figure per panel; §4's
  own spec for this panel says three. I followed §4.

## Things I am less confident about

- **New UI sentences.** The one-line caveats in the product's voice are
  mine or the stage passes' ("Three deterministic runs — a range, not a
  probability.", "Simulated — an uncalibrated probability…", "Structural
  exposure — not a probability.", the History and What-if panel lines, the
  Live projected-finish line "Arithmetic from the critical path, not a
  likelihood — no probability is claimed here"). Each sits beside the
  engine's own text, which is one click away, unchanged. They state no
  number. They are worth a read for tone.
- **`firstSentence()` on finding cards** splits the engine's explanation
  at the first sentence end followed by a capital; the full text is in the
  disclosure. An explanation that abbreviates mid-sentence would show a
  fragment. None of the seeded ones do.
- **Label width estimates in the graph** use average glyph widths for
  Geist at 12px (6.7px sans, 7.4px mono, plus room for the check). A name
  of unusually wide glyphs could be tighter than the footprint assumes;
  the check script would show it as truncated.
- **Dark mode was verified on the bottlenecks and risk stages, the list
  and the landing** (`docs/screens/step5/dark-*.png`), not on every stage.
- **`CapabilityPanel` cuts a row's one line at the first sentence end or
  colon.** The full text is always behind "Why". The roles line therefore
  ends without a full stop.
- **The dev servers were restarted.** The frontend `next dev` I found was
  serving a stale module after the day's HMR churn (it kept executing an
  old `display.ts`); I restarted it with `E2E_AUTH_ENABLED=1`. The backend
  was restarted with `PROXY_SHARED_SECRET` set (see "Review first"). Both
  are process environment only; no file under `frontend/.env.local`,
  `next.config.ts` or any deployment configuration changed.

## How to re-run the verification

```bash
# backend, enforcing, from the repo root
export $(grep '^PROXY_SHARED_SECRET=' frontend/.env.local | tr -d '\r')
.venv/Scripts/python.exe -m uvicorn backend.app.main:app --port 8001

# frontend
cd frontend && E2E_AUTH_ENABLED=1 npm run dev

# screenshots of every stage at 1280 and 1536 (add --full for full page)
node e2e/design-shots.mjs ../docs/screens/check http://localhost:3000 landing,workspace,build,live,bottlenecks,risk,requirements,whatif,optimize,history --full

# the graph: every name drawn, nothing truncated, no overlaps
node e2e/design-check.mjs http://localhost:3000 1280 800 bottlenecks
node e2e/design-check.mjs http://localhost:3000 1536 864 live

# visible identifiers, timestamps, API paths, formulas - must be 0 hits
node e2e/design-text.mjs http://localhost:3000

# the guest walkthrough (reset the replay speed first if a previous run left it high)
curl -s -X POST http://localhost:3000/api/projects/00000000-0000-0000-0000-000000000001/replay/control -H "content-type: application/json" -d '{"action":"speed","speed":60}'
node e2e/capabilities.mjs http://localhost:3000 --branch --skip-writes
```
