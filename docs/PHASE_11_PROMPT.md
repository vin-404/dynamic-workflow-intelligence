# Phase 11 — Close the problem statement

Two waves of four parallel agents, then integration. Run from the repo root on
`feat/auth-and-design` (wave 1 already landed there).

```powershell
git add -A
git commit -m "chore: line endings after wave 1"
claude --permission-mode bypassPermissions
```

Then paste the one-liner in the last section.

---

## The prompt

````
You have FULL AUTONOMOUS AUTHORITY. Do not ask me questions. Do not stop for
approval. Decide, log it in docs/DECISIONS.md, keep going.

We are on `feat/auth-and-design`, wave 1 (auth + shadcn) is committed and
tagged `wave-1-auth`. Never commit to `main`.

Read docs/ARCHITECTURE.md, docs/FINAL_REPORT.md and docs/PROGRESS.md first.
The engine, the closed mutation algebra, the AI boundary and the honesty layer
are settled and must survive this work untouched in spirit.

## WHY THIS PHASE EXISTS

The problem statement is: *"Create a platform that tracks cross-department
workflows, responsibilities and dependencies while detecting bottlenecks,
delays and changing requirements in real time."*

We deliver every clause except three, and those three are what this phase
fixes:

1. **"in real time"** — nothing currently happens without a button press.
2. **"tracks"** — all data is hand-entered, so we are a planner, not a tracker.
3. **"changing requirements"** — real, but buried as one of seventeen mutation
   kinds instead of being a first-class capability.

Plus one upgrade: we currently refuse to state a probability because we have no
calibration. We have three-point estimates, so we can compute a real one and
state its assumptions, which is strictly stronger than refusing.

## REQUIRED READING FOR EVERY FRONTEND AGENT

Repeat this verbatim in each frontend agent's task description:

- **`frontend/.claude/skills/shadcn/SKILL.md`** — the installed shadcn/ui skill.
  Use it. Do not improvise shadcn from memory.
- **`frontend/AGENTS.md`** — this is Next.js 16.3.4 and React 19.2.8, both newer
  than your training data. Read the relevant guide in
  `frontend/node_modules/next/dist/docs/` before writing routing, middleware,
  server actions or streaming code. Getting this wrong is the most likely way
  this phase fails.

## WAVE 2 — FOUR BACKEND AGENTS IN PARALLEL

Launch all four in one message. Partitioned strictly by file ownership.

### Agent LIVE — make it real time
Owns: `backend/app/services/replay.py`, `backend/app/api/routers/stream.py`,
`backend/app/core/engine/incremental.py`, `backend/tests/test_stream.py`

Build a replay engine that streams a project's event log forward in accelerated
time over **Server-Sent Events** (not WebSocket — the traffic is one-directional
and SSE survives the Vercel proxy without extra configuration).

- `POST /api/projects/{id}/replay` starts a replay with a speed multiplier
  (default 60x) and an optional start day; `GET /api/projects/{id}/stream` is
  the SSE endpoint.
- Each emitted event carries: the simulated clock, the event itself, and the
  **delta** in findings — which findings appeared, which cleared, which changed
  severity — plus the new projected finish and slip.
- Re-evaluating the whole workflow per event is acceptable (analyze is ~24ms);
  do the simple correct thing before optimising. If you do add incremental
  evaluation, prove equivalence with a test that compares incremental output to
  a full re-evaluation at every step.
- Replay must be **pausable, resumable, seekable and restartable**, and must
  never mutate the stored workflow. It runs over an immutable snapshot exactly
  like a scenario does.
- Support multiple concurrent viewers on one replay.
- Tests: findings appear and clear at the correct simulated times; a replay
  leaves the base version's hash unchanged; a disconnect mid-stream does not
  leak a task.

### Agent FORECAST — a real probability, honestly stated
Owns: `backend/app/core/engine/montecarlo.py`,
`backend/app/core/engine/risk.py`, `backend/app/core/engine/feasibility.py`,
`backend/app/api/routers/forecast.py`, `backend/tests/test_montecarlo.py`

Tasks already carry optimistic/likely/pessimistic. Use them.

- Sample task durations and run N iterations (default 5,000, configurable,
  seeded so results are reproducible). Vectorise with numpy; the whole run must
  stay under ~2 seconds for a 40-task workflow.
- Emit: **P50/P80/P90 completion dates**, the probability of meeting the
  deadline, a completion-date histogram, and for every task its
  **criticality index** — the fraction of iterations in which it lies on the
  critical path. Criticality index is the rigorous definition of "at risk of
  becoming a bottleneck" and it is what this whole feature is for.
- Where a task has no three-point estimate, fall back to the domain's
  `duration_variance_prior` and **label that task's contribution as assumed**.
- The `assumptions` block must state: distribution family, spread and its
  provenance per task, iteration count, seed, whether resource contention was
  simulated, and — explicitly — that **durations are sampled independently,
  which is optimistic because real delays correlate**.
- Keep the existing Layer-A structural risk score. It is the cold-start answer
  when there is nothing to sample. The UI shows the structural estimate when
  Monte Carlo is unavailable and the probability when it is, and always says
  which one it is showing.
- Tests: a fixed seed reproduces exactly; a task on every critical path has
  criticality 1.0; P50 <= P80 <= P90; widening one task's spread widens the
  distribution and does not move the median much.

### Agent INGEST — stop making the user type everything
Owns: `backend/app/ingest/**`, `backend/app/api/routers/ingest.py`,
`backend/tests/test_ingest.py`, `backend/app/seed/fixtures.py` (import samples only)

- **Jira CSV import.** Accept a real Jira issue export. Map: Issue key -> task
  key, Summary -> name, Assignee -> resource, Story Points or Original Estimate
  -> effort, Status -> status, Due date, and **"Inward issue link (Blocks)" /
  "Outward issue link (Blocks)" columns -> dependencies**. Jira exports these
  as repeated same-named columns; handle that. Unmappable rows are reported,
  never silently dropped.
- A **preview-then-commit** flow: `POST /api/import/preview` returns what would
  be created, what could not be mapped and why, and any cycles the import would
  introduce. `POST /api/import/commit` creates the project. Never import
  straight into a live workflow.
- A generic CSV path with a column-mapping payload, for non-Jira sources.
- **A GitHub webhook receiver** at `POST /api/ingest/github` handling `issues`
  and `pull_request` events, signature-verified with a configurable secret,
  appending to the event log. If the signature secret is unset, reject rather
  than accept unverified.
- Ship one real anonymised Jira-shaped CSV as a fixture so the demo can import
  something on stage without a network call.
- Tests: a realistic Jira export imports with dependencies intact; a malformed
  file reports every bad row; an import that would create a cycle is rejected at
  preview with the cycle named.

### Agent REQUIRE — make requirement change a first-class capability
Owns: `backend/app/services/requirements.py`,
`backend/app/api/routers/requirements.py`,
`backend/app/core/engine/staleness.py`, `backend/tests/test_requirements.py`

This is our sharpest differentiator and it is currently buried. The best tool
on the market for this flags a *link* for a human to review. We reason about
whether completed work is now invalid and what the replan costs.

- `POST /api/projects/{id}/requirements/{key}/change` takes new text and returns
  a full **impact report** without applying anything:
  - `must_redo` (consumed an artifact that is now wrong) vs `must_recheck`
    (downstream only) — already exists, surface it properly
  - **wasted effort**: days of *completed* work invalidated, and the cost of
    redoing it
  - schedule impact: new projected finish, the delta, and whether the deadline
    survives
  - **who needs to know**: owners of affected work, grouped by resource
  - findings created and cleared by the change
  - a ready-to-apply scenario containing the implied mutations, unapplied
- Requirement **versions are first class**: full history, who changed what and
  when, and the ability to diff v1 against v2 and see the impact of that exact
  change.
- Comparison of two proposed wordings of the same change, so a user can pick
  the cheaper one.
- Tests: invalidated completed work is counted correctly; a change touching
  nothing reports no impact rather than an empty error; the impact report
  mutates nothing.

Integrate wave 2, run the full suite, commit, tag `wave-2-capability`.

## WAVE 3 — FOUR FRONTEND AGENTS IN PARALLEL

Only after wave 2 is green. This wave does the visual overhaul **and** the new
screens together, so nothing is designed twice.

- **Agent UI-LIVE** owns `LiveFeed.tsx`, `ReplayControls.tsx`, `Clock.tsx`,
  `DependencyGraph.tsx`
- **Agent UI-REQUIRE** owns `RequirementChange.tsx`, `ImpactReport.tsx`,
  `RequirementHistory.tsx`
- **Agent UI-ANALYSIS** owns `FindingsPanel.tsx`, `RiskPanel.tsx`,
  `ForecastPanel.tsx`, `Explainer.tsx`
- **Agent UI-CHANGE** owns `WhatIfPanel.tsx`, `OptimizePanel.tsx`,
  `DiffView.tsx`, `ImportPanel.tsx`

`frontend/src/app/page.tsx` is owned by NOBODY — you integrate the shell
yourself so agents cannot collide on layout.

### The visual direction

Remove: gradients, emoji-as-icons, "AI-powered" badges, and the uniform
card-grid where every tile has equal weight.

Adopt a dense, information-first aesthetic in the spirit of Linear or a Vercel
dashboard:
- **One primary surface** — the live dependency map is the hero. Wide main
  column, narrow inspector rail. Not three equal columns.
- **Density over air.** Tight rows, small type, real information per screen.
- **Typography carries the hierarchy, not boxes.** Most panels need no border.
- **Tabular numerals on every number** (`font-variant-numeric: tabular-nums`).
- **One accent colour**, reserved for critical path and high severity. Three
  severity states, not a rainbow.
- **Domain vocabulary**: "slack", "critical path", "attributed delay", "must
  redo". Never "Insights", "Overview", "Analytics".
- **Evidence inline** — task keys, timestamps and arithmetic on the row.
- lucide-react icons, sparingly, one size. Dark and light both correct.

### The live screen is the demo, so give it the most care

A running clock, events arriving in a feed, and findings that **appear and
clear on their own**. When a finding appears it should be obvious something
happened — a brief highlight, not an animation festival. The projected finish
date updates in place. Replay controls: play, pause, speed, scrub, restart.
A viewer arriving mid-replay sees current state, not an empty screen.

### The requirement screen is the differentiator

Lead with the cost: *"6 tasks across 3 departments invalid. 3 days of completed
work lost. Finish date moves from 23 Sep to 27 Sep."* Then the affected work
grouped by owner, then the ready-to-apply replan.

Integrate, verify, commit, tag `wave-3-design`.

## WAVE 4 — INTEGRATION, DEMO, DEPLOY

- Update `docs/HOW_TO_DEMO.md` for the new flow: import from Jira CSV -> live
  replay -> requirement change -> forecast -> optimize -> the constraint refusal.
- Extend `backend/scripts/demo_check.py` to assert every new claim.
- Update `.env.example` and `docs/DEPLOY.md` with every new variable.
- Run `scripts/smoke.sh`, the full pytest suite, and `npm run e2e:all`.
- Update `docs/FINAL_REPORT.md`.
- Commit, tag `phase-11-complete`.

## ABSOLUTE CONSTRAINTS

- **The honesty layer survives, everywhere.** The unavailable-checks list, the
  assumptions blocks, the "structural estimate, not a probability" labelling
  when Monte Carlo is unavailable, the "nothing here involves a language model"
  note on the optimizer. Adding a real probability does not license removing a
  single caveat — it means stating the new assumptions just as plainly.
- **Do not touch `backend/app/core/` semantics.** Extending the engine with new
  modules is fine; changing what existing functions mean is not.
- **`core/` stays pure.** No I/O, no framework imports. The purity test must
  keep passing.
- **The LLM gains no new authority.** Monte Carlo, criticality, impact and
  forecast numbers all come from deterministic code.
- **No feature creep.** No notifications, no analytics dashboards, no
  onboarding tour, no chatbot, no extra seed domains, no more detectors.
- Every existing test stays green. Commit per wave, tag each, never leave a
  red commit.

## WHEN A WAVE FINISHES

Append to docs/PROGRESS.md: what changed, what each agent produced, tests added
and passing, how to test it, decisions, anything that worries you.

## BEGIN

Start wave 2 now. Launch all four agents in parallel in one message. Do not ask
me anything.
````

---

## The one-liner to type

```
Read docs/PHASE_11_PROMPT.md and follow the prompt inside it exactly, starting now. Launch all four wave-2 agents in parallel in one message. Do not ask me anything — I am unavailable.
```
