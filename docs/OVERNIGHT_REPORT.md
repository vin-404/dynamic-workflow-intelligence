# Overnight run report — FlowTrace capability completion

Run on the night of 10–11 September 2026, unattended, on branch
`feat/capability-completion` created from `main` at `5a4cd82`. `main` was
not touched. Nothing was deployed; pushing the branch is the only deployment
this run may have caused (a Vercel preview).

**Read this first.** All six tasks were completed and each is its own commit
and tag. Two things need a human decision in the morning, both listed under
"defects found but not fixed". Two things I changed that I am less confident
about are named explicitly further down.

---

## Final state

| | |
|---|---|
| Branch | `feat/capability-completion` |
| Head | `0c0bbac` |
| Commits this run | 6, tagged `capability-1` … `capability-6` |
| Backend tests | 1071 passed (baseline 1067; +4 new, none weakened, none skipped) |
| `npx tsc --noEmit` | clean |
| `npm run build` | passes |
| `npx eslint src` | 12 errors before and after — all pre-existing `react-hooks/set-state-in-effect` in files I did not restructure; none introduced |
| Browser pass, this branch (local stack) | ALL PASSED — 90 checks across eight stages, the capability dialog, and the import route as guest and signed in |
| Browser pass, production `main` | all stages load and work for the guest; details below |

The order in the brief was 5, 2, 1, 3, 4, 6. The tags follow that order,
not the prompt numbers.

---

## Completed

### capability-1 · `2c33476` — Prompt 5, tell the truth about what this build cannot do

- **Point of use.** A shared `MethodLabel` (`frontend/src/components/AiMethod.tsx`)
  sits beside every AI-touched result and reads the `method` / `origin` the
  backend put on *that* response: the plain-language narration, the sentence
  box's interpretation, and each optimizer candidate's rationale now say
  "from model · <model>" or "deterministic fallback · no model configured",
  with the role's fallback and what a model would need in the tooltip. One
  `useAiStatus` hook shares a single `GET /api/ai/status` between them.
- **The optimizer stopped claiming "nothing here involves a language
  model".** That was true only by accident of deployment. It reads the live
  status before a search and the response's `llm_proposals` after one, and
  says which sources produced the ranking. `OptimizeResponse` gained the
  `llm_proposals` field the backend already sent.
- **One panel.** "What this build can and cannot do" is a dialog in the
  workspace header on every stage (`CapabilityPanel.tsx`). Every row is read
  live: `ai/status` for the three roles and what they need; `analyze` for
  which detector tiers ran and which could not, with `requires`, `why`,
  `unlocked_by`; `forecast/assumptions` for calibration and what is not
  modelled; `users/{me}/projects` for whether roles are enforced. A source
  that does not answer is drawn as "could not be determined" with the error,
  never as available. No hardcoded list.
- **Backend:** `ai_service.status()` gained `needs` — the specific thing that
  would turn a model on — with a test.
- **Already true, verified, not changed:** `unavailable_checks` was already
  rendered on the bottlenecks stage by `TierBanner`; live it shows "15 checks
  ran. 3 could not." with the tier-3 detail. "Structural estimate, not a
  probability" and every assumptions block are untouched.
- Roles: confirmed enforced live (`roles_enforced: true`, guest write → 403
  `insufficient_role`). The panel reads this from the API and says so.

### capability-2 · `9d6d9fc` — Prompt 2, the requirement surfaces

The audit premise was partly stale against this tree: `ImpactReport` and
`RequirementHistory` were already mounted by `RequirementChange`, and
`DiffView` by the what-if and sentence panels. What remained:

- `POST /requirement-impact` — the one requirement client called from
  nowhere — is now `RequirementStaleness.tsx`, shown the moment a requirement
  is picked, before any wording is typed: must-redo and must-recheck as two
  lists, never merged, finished tasks emphasised, the API's wasted-days
  figure in the header. It steps aside once a costed report is on screen.
- The replan is a stored scenario, so `ImpactReport`'s replan block now
  offers "Show the workflow before and after this replan", which evaluates it
  and renders `DiffView` on the requirements stage.
- `ImpactReport`, `RequirementHistory` and the preview each sit in their own
  `ErrorBoundary`, keyed to the requirement.

### capability-3 · `996553d` — Prompt 1, risk re-weighting on the engine

- The client-side multiply/sum/re-band in `page.tsx` is deleted, thresholds
  included. `onReweight` posts to `POST /risk` (pinned to the analysis's
  version via a new `versionId` parameter on `getRisk`) and replaces the
  risk block with the engine's tasks, top, band counts and echoed weights.
- In flight: the exposure section is dimmed, `aria-busy`, and labelled as
  the previous weights' answer being recomputed. On failure: the error is
  shown beside the weights with retry; the old ranking stays visibly old.
- "Reset" restores the engine's defaults captured on first mount rather than
  the last echoed weights.
- Test: every task's band equals the engine's `_band(score)` under custom
  weights, asserted at 0.57 / 0.32 / 0.29 — the scores the drifted client
  copy got wrong. Verified live: slack_ratio 0.9 → 7 high / 3 moderate /
  7 low on screen and from the API.

### capability-4 · `ab00f5c` — Prompt 3, scenario management

- `ScenarioList.tsx` on the what-if stage: name, origin, status, created
  instant (UTC, `instantUTC` moved to `ui.tsx` from `RequirementHistory`
  rather than copied), typed changes, and the headline finish-date effect
  read from `GET /api/scenarios/{id}/diff` — a pure read; a new
  `scenarioDiff` client and `ScenarioDiff` type. Rows say "computing" until
  the diff returns, show the error if it fails, or the rejection reason for
  a rejected scenario. No placeholder figure.
- Open → `evaluateScenario` → `DiffView`. Delete → confirmation stating it
  touches the scenario only, never a version → `deleteScenario`; the
  backend's refusals (applied scenario; viewer 403) are shown.
- Empty list is real copy that says how scenarios come to exist.
- The composer's default is unchanged (`keep: false`). An opt-in "keep it as
  a saved scenario" checkbox stores it and refreshes the list; the sentence
  box refreshes it after an interpretation that produced a scenario.

### capability-5 · `6da3442` — Prompt 4, constraints and objectives

- `ConstraintPanel.tsx` on the build stage lists constraints with reasons
  and declares any of the five `ConstraintIn` kinds (there are five, not
  seven: MANDATORY_TASK, IMMUTABLE_DEPENDENCY, NON_DIVISIBLE_TASK,
  FIXED_ASSIGNMENT, MIN_DURATION). Reason required by the composer.
- **Backend:** there was no way to remove a constraint. Added
  `DELETE /api/projects/{id}/constraints/{kind}/{target:path}` on the draft,
  identified by `(kind, target)` as the engine reads it, guarded at the
  router like every authoring write. Two tests (declare / honour /
  withdraw / 404, and `FROM->TO` round-tripping through the path). Frontend
  `deleteConstraint` client added.
- `OptimizePanel` reads `GET /optimize/objectives` on mount: the six
  criteria with what each measures, direction, unit and default weight are
  on screen and editable before the first search; after a search the same
  section shows the weights the response echoed. Failure to read is shown.
- `MutationVocabulary.tsx` reads `GET /scenarios/mutation-kinds` once and
  shows the closed set as a disclosure under the what-if composer, beside an
  interpretation's typed changes, and beside each candidate's exact changes,
  with the kinds in use highlighted.

### capability-6 · `0c0bbac` — Prompt 6, verify end to end

- `frontend/e2e/capabilities.mjs`: a Playwright walkthrough of all eight
  stages as the guest, plus the capability dialog and the import route.
  Records console errors per stage, that panels carry API data, that every
  visible control sends a real request, and that a deliberately failed
  request (`/analyze` → 503, `/api/ai/status` aborted) shows an error, not an
  empty success state. Flags: `--branch`, `--skip-writes`,
  `--import-signed-in`.
- Fixed from what it found: the header's hardcoded "v1 draft" pill (and the
  duplicated project-name pill); the scenario list burying what-ifs under
  optimizer candidates.

---

## Verification detail

### Branch, local stack

Backend on a scratch SQLite database in the session scratchpad, seeded,
`PROXY_SHARED_SECRET` set (enforcing), port 8001. Frontend `next dev -p
3100` with `PUBLIC_DEMO_VIEWER=1 E2E_AUTH_ENABLED=1
API_REWRITE_URL=http://localhost:8001`. No file under `frontend/.env.local`
or any deployment configuration was changed; the flags were process
environment only.

Result: **ALL PASSED**. Notable proofs:

- live: a replay starts, the simulated clock advances, Pause sends
  `POST /replay/control` and the clock stops, speed and seek send control
  requests, the frame is labelled a reconstruction, the evidence tier is
  shown per frame.
- risk: re-weighting sends `POST /risk`; the band counts on screen equal
  the engine's for the same weights.
- requirements: staleness preview before a wording; report from
  `POST .../change` keeps redo and recheck apart; the replan's full diff
  renders.
- whatif: a kept what-if appears in the list with the engine's
  "+5d · day 26 → 31"; opening shows its diff; the guest's delete is refused
  403 and the row shows it.
- optimize: objectives before a search; a search runs; rationales labelled
  "deterministic fallback"; the response says every candidate came from the
  generators.
- capability dialog: `ANTHROPIC_API_KEY` named as what the model needs;
  "Tier 2 reached", "Tier 3 · cross-project" not available with what it
  needs; "Roles are enforced on this instance" from the API; with
  `/api/ai/status` aborted the row says "Could not determine".
- import, guest: sample loads; preview refused 403 `read_only_guest`, shown
  in the panel (see defects).
- import, signed in through the e2e provider: preview → mapping → commit
  creates a real project with the imported tasks.
- `/analyze` forced to 503: the stage shows the error, and no "nothing
  found" copy pretends the check ran.
- Guest mutation via the API: 403 `insufficient_role`, `your_role: viewer`.

### Production `main` (https://dynamic-workflow-intelligence.vercel.app), signed out

Run with `--skip-writes`, so the optimizer search and the requirement
change were **not** exercised on production: both persist scratch scenarios
on the live database (up to forty per search). Both were exercised on the
local stack of this branch instead. Everything else passed on production:

- All eight stages load; no unexpected console errors on any stage (the
  browser's own log lines for a deliberate 503 and a designed 403 excluded).
- Live: replay starts, frames arrive, Pause stops the clock. Speed and seek
  sent control requests in the first production pass and on the branch;
  in the third production pass, after Pause, those two checks failed.
  Recorded as **intermittent**, not confirmed — see below.
- Bottlenecks: tier banner, 15 ran / 3 could not, narration labelled with
  its method.
- Risk: re-weighting recomputes in the browser, no request — the defect
  `capability-3` fixes.
- Requirements rail, composer and history render from the API.
- What-if: a simulation runs; the base is proved untouched.
- History renders the seeded version.

---

## Defects found — every one, as stage · what I did · expected · happened

1. **risk** · moved a weight, re-ranked · a `POST /risk` so the engine bands
   the scores · (main) no request; the browser recomputed with its own
   thresholds, 0.6/0.35 against the engine's 0.55/0.30. **Fixed**
   (`capability-3`).
2. **header, every stage** · looked at the version pill · the real version ·
   (main) "v1 draft" as a literal for every project, plus the project name
   repeated in a second pill. The seeded project's version is sealed.
   **Fixed** (`capability-6`): reads `workflow.version`, shows nothing until
   it loads.
3. **whatif** · ran the optimizer twice, then opened the scenario list ·
   the what-ifs and replans · ~90 optimizer candidates buried them. **Fixed**
   (`capability-6`): candidates counted in the header and collapsed behind a
   disclosure; diffs computed only when shown.
4. **import** · loaded the bundled sample as the guest, pressed "Preview the
   import" · a preview — the panel says it "reads the file and writes
   nothing" · 403 `read_only_guest` from `POST /api/import/preview`. The
   guest cannot see the mapping step at all. **Not fixed** — an
   authorization-policy decision (adding a project-less POST that parses
   user-supplied text to `READS_THAT_POST` in `backend/app/api/deps.py`).
   The refusal is honest and the backend's own; it just makes the import
   demo invisible to a signed-out visitor. Your call.
5. **live** · paused, then changed speed / seeked · a `POST /replay/control`
   for each · passed twice (production run 1, branch), failed once
   (production run 3, after Pause). **Not fixed, not confirmed** — could be
   the Radix select on a slow network or a genuine "controls ignored while
   paused" edge. Worth one manual look: pause the replay on production,
   change the speed, watch the network tab.
6. **optimizer, by design but worth knowing** · every search as any visitor
   (guest included) persists its candidates as scenarios on the live
   database · — · the seeded project's scenario list will grow with every
   public demo click. Mitigated on screen by (3); the rows themselves
   accumulate. Consider `persist_candidates: false` for guests, or a
   sweep.
7. **capability panel's "needs" for calibration** · the forecast group's
   "modelling of X" rows · a `needs` from the API · the API's `not_modelled`
   entries carry `why_it_matters` but no "what would unlock it", so the row
   uses a one-line frontend sentence ("a model extension; a known limit of
   the simulator"). It is copy, not a number, but it is the one place in the
   panel where the "needs" text is not the backend's. **Not fixed**; the
   right fix is a `what_would_unlock_it` field on the backend.

---

## Side effects on production you should know about

- **One scratch scenario on the production seeded project.** Verifying the
  scenario endpoints, I created a kept what-if named
  **"overnight probe - delete me"** (T03 +5d, id
  `78252c23-8185-4d34-9fed-245f0bb914fd`) through the public API as the
  guest. The guest cannot delete it (403, by design), so it is still there
  and will appear at the top of the saved-scenarios list once this branch
  deploys. An editor can delete it from that list or via
  `DELETE /api/scenarios/78252c23-8185-4d34-9fed-245f0bb914fd`.
- The production browser passes started three replays on the seeded
  project (`POST /replay`) and left them running or finished; that is what
  the live stage does for any visitor and writes no workflow state.
- Nothing else on production was written. No optimizer search and no
  requirement change was run against it.

---

## Changed with less confidence — review these first

1. **The what-if "keep it as a saved scenario" checkbox** (`WhatIfPanel`,
   `capability-4`). Prompt 3 said to keep the create-and-evaluate flow
   "exactly as it does now". The default is unchanged (`keep: false`) and
   the request is byte-identical unless the box is ticked, but it is a new
   control on that surface. Without it, nothing from the composer ever
   reaches the list. Easy to remove if unwanted.
2. **`DELETE /constraints/{kind}/{target:path}`** (`capability-5`). A new
   backend route, additive, guarded by the router-level guard (the
   `test_auth` sweep that asserts every non-GET is guarded still passes).
   The identity is `(kind, target)` rather than the row's uuid because the
   workflow projection does not expose constraint ids and the engine reads
   them that way; if two identical constraints were ever declared, the
   route deletes one and a second call deletes the other. `target:path`
   is used so `FROM->TO` and `TASK:RESOURCE` survive the URL.
3. **`ai_service.status()["needs"]`** wording names `ANTHROPIC_API_KEY` and
   `AI_PROVIDER`, read from `provider.py`. If the provider selection changes
   the sentence goes stale; it is one string in one place.
4. **The capability dialog runs `POST /analyze` when opened.** It is the
   same call the bottlenecks stage makes, on demand, once per open. Fine
   for the seeded project; on a very large workflow it is a second full
   analysis.

---

## Attempted and abandoned

Nothing. No stop condition fired. Two things were consciously left as they
are and reported instead of changed: the guest import-preview policy
(defect 4) and the `not_modelled` "needs" text (defect 7).

---

## What the audit got wrong, for the record

- "Three finished components are imported by nothing." Against this tree,
  `ImpactReport` and `RequirementHistory` were already mounted by
  `RequirementChange`, and `DiffView` by two panels. The unused pieces were
  narrower: the `requirementImpact`, `listScenarios`, `getScenario`,
  `deleteScenario`, `createConstraint`, `optimizeObjectives`,
  `mutationKinds` and `userProjects` clients — all of which are now used.
- "Seven hard constraints." `ConstraintIn` accepts five kinds. The optimizer
  may run more than five *gates*, but a user can declare five things.

---

## How to re-run the verification

```bash
# backend, scratch DB, enforcing
export $(grep '^PROXY_SHARED_SECRET=' frontend/.env.local | tr -d '\r')
DATABASE_URL="sqlite+aiosqlite:///$PWD/e2e.db" DATABASE_URL_SYNC="sqlite:///$PWD/e2e.db" \
  .venv/Scripts/python.exe -m uvicorn backend.app.main:app --port 8001

# frontend, public viewer + e2e provider
cd frontend && PUBLIC_DEMO_VIEWER=1 E2E_AUTH_ENABLED=1 API_REWRITE_URL=http://localhost:8001 npx next dev -p 3100

# the branch pass
node e2e/capabilities.mjs http://localhost:3100 --branch --import-signed-in --shots e2e/.shots/branch

# the production pass (no scratch rows written)
node e2e/capabilities.mjs https://dynamic-workflow-intelligence.vercel.app --skip-writes
```
