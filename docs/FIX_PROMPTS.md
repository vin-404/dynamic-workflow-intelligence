# FlowTrace — prompts to make every backend capability real in the UI

Audited 10 Sep against the codebase and the live deployment. Run these **in
order**, one at a time, verifying each before starting the next.

**Shared context — paste this at the top of every prompt if the agent starts
fresh:**

> Repo: FlowTrace (formerly Dynamic Workflow Intelligence Platform). Backend
> is FastAPI in `backend/app/`, frontend is Next.js 16 in `frontend/src/`.
> Live at `dynamic-workflow-intelligence.vercel.app` (Vercel) with the API on
> Render. The seeded demo project is
> `00000000-0000-0000-0000-000000000001` ("Campus Tech Symposium").
> The workspace has eight stages: build, live, bottlenecks, risk,
> requirements, whatif, optimize, history — routed at
> `frontend/src/app/workspace/[projectId]/[stage]/page.tsx`.
>
> **Two rules that override everything else in this repo.** First: no number
> shown to a user may be invented by the frontend — every figure comes from
> the engine via the API, and if the API cannot be reached the UI says so
> rather than substituting anything. Second: when a capability cannot run,
> the UI names it and says what it needs, instead of hiding it or showing an
> empty success state. A hardcoded `lib/demo.ts` was deleted for breaking the
> first rule; do not reintroduce anything like it.

---

## Prompt 1 — Move risk re-weighting to the engine

```
The risk stage lets a user move the nine factor weights and see the ranking
change. Right now that recomputation happens in the browser: the handler in
frontend/src/app/workspace/[projectId]/[stage]/page.tsx maps over
analysis.risk.tasks, multiplies each factor value by the new weight, re-sums,
and re-bands client-side.

The backend already does this properly. POST /api/projects/{id}/risk accepts
{version_id?, weights?} and returns a full recomputed risk payload from the
engine — see risk_post in backend/app/api/routers/analysis.py.

Replace the client-side recomputation with a call to that endpoint.

- Use the existing getRisk client in frontend/src/lib/api.ts, or add a POST
  variant if getRisk is GET-only. Do not write a new fetch by hand.
- While the request is in flight, show the panel busy rather than stale
  numbers presented as current.
- On failure, surface the error in the panel. Do not fall back to the
  previous ranking silently.
- Delete the client-side band thresholds entirely. They were a duplicate of
  _band() in backend/app/core/engine/risk.py and had drifted (0.6/0.35 in the
  client against 0.55/0.30 in the engine), so the same score could show a
  different band in each. Once the server returns the band, there is nothing
  to keep in sync.

Verify against the live seeded project: move a weight, confirm a network
request goes out, and confirm the returned bands match what the engine
returns for the same weights. Add a test if there is a natural place for one.
```

---

## Prompt 2 — Mount the requirement surfaces that already exist

```
Three components were built and are imported by nothing:

  frontend/src/components/RequirementHistory.tsx
  frontend/src/components/ImpactReport.tsx
  frontend/src/components/DiffView.tsx

Their endpoints are live and return real data:

  GET  /api/projects/{id}/requirements/{key}/history
  GET  /api/projects/{id}/requirements/{key}/diff
  POST /api/projects/{id}/requirement-impact

and the clients for them (requirementHistory, requirementDiff,
requirementImpact) exist in frontend/src/lib/api.ts and are called from
nowhere.

Mount them on the "requirements" stage alongside the existing
RequirementChange panel. The stage currently only supports change / compare /
apply; it should also let a user see a requirement's history, diff two of its
versions, and view the impact report for a proposed change.

Read each component's props and its docstring first and mount it as it was
designed to be used — do not rewrite them to fit a new shape unless a prop is
genuinely wrong.

Staleness propagation is the differentiator here: when a requirement changes,
the system computes which completed work must be redone and which must be
re-checked. Make sure that distinction is visible on screen and not collapsed
into one list.

Wrap each in the existing ErrorBoundary the way the other panels on that page
are wrapped. Verify against the live seeded project.
```

---

## Prompt 3 — Scenario management

```
A user can create a what-if but cannot see, revisit or delete the scenarios
they have created. These clients exist in frontend/src/lib/api.ts and are
unused: listScenarios, getScenario, deleteScenario. The endpoints are live —
GET /api/projects/{id}/scenarios returns an array (currently empty for the
seeded project, which is correct, not broken).

Add scenario management to the "whatif" stage:

- List the project's saved scenarios, newest first, each showing its name,
  when it was created, and its headline effect on the finish date.
- Open one to see its full diff. Use the existing DiffView component if
  Prompt 2 has not already mounted it elsewhere; otherwise reuse it.
- Allow deleting a scenario, with a confirmation step. Deleting a scenario
  must never touch a WorkflowVersion — a scenario is scratch paper over a
  version, and that distinction is load-bearing.
- An empty list is a real state with real copy ("no saved scenarios yet"),
  not a spinner that never resolves and not a fabricated example.

Keep the existing create-and-evaluate flow working exactly as it does now.
Verify by creating a scenario against the live seeded project, seeing it in
the list, opening its diff, and deleting it.
```

---

## Prompt 4 — Constraints and optimizer objectives

```
Two headline capabilities have no user interface at all.

CONSTRAINTS. The optimizer refuses candidates that violate seven hard
constraints, and a refusal names the constraint it hit. But a user cannot
declare a constraint: POST /api/projects/{id}/constraints exists (see
create_constraint in backend/app/api/routers/workflow.py, body is
{kind, target, reason, value}) and the createConstraint client in
frontend/src/lib/api.ts is called from nowhere.

Add constraint declaration to the "build" stage — read the ConstraintIn
schema for the exact kinds rather than guessing them. A user should be able
to mark a task mandatory, a dependency immutable, work non-divisible, an
assignment fixed, and a minimum duration, each with the reason they gave.
Show the project's existing constraints and allow removing one.

OBJECTIVES. GET /api/projects/{id}/optimize/objectives returns the scoring
weights the optimizer actually uses (expected_completion 0.35,
feasibility_margin 0.2, peak_resource_overload 0.15, ...). The
optimizeObjectives client is unused, so the optimize stage ranks candidates
against weights the user cannot see. Surface them on the optimize stage so a
ranking can be read rather than trusted.

Also surface the mutation vocabulary: the mutationKinds client is unused, and
the closed 17-kind algebra is the reason a proposal can be validated before
it runs. Show it wherever a user is about to author or read a change.

Verify each against the live seeded project.
```

---

## Prompt 5 — Tell the truth about what this build cannot do

```
This is the most important prompt in the sequence. Do not treat it as
cosmetic.

The product's central claim is that it reports what it cannot assess instead
of showing a confident empty dashboard. Several things are currently
unavailable in the deployed build and the UI says nothing about any of them:

1. The AI layer is running with no API key. GET /api/ai/status returns
   {"provider":"null","available":false,"model":null,
   "roles":["interpreter","proposer","narrator"]}. So the Interpreter is the
   labelled pattern matcher that handles four phrasings, the Proposer
   contributes nothing and the optimizer runs on its six deterministic
   generators, and the Narrator uses the engine's own templated wording.
   Every one of those is a correct, designed fallback — but a user currently
   cannot tell which they are looking at.

2. Detector tiers 2 and 3 need history and cross-project evidence. On a fresh
   workflow they cannot run.

3. Nothing has been enforced by PROXY_SHARED_SECRET unless it is set on
   Render — check whether it is, and if roles are advisory, say so rather
   than implying they are enforced.

Build one honest capability surface:

- Call GET /api/ai/status and show, wherever an AI-touched result appears
  (AskPanel, the narration, the optimizer's candidate rationales), whether
  that specific output came from the model or from the deterministic
  fallback. Label it at the point of use, not in a footer nobody reads.
- Add a "What this build can and cannot do right now" panel, reachable from
  the workspace, listing each capability, whether it is available, and — when
  it is not — the specific thing it needs. Drive it from live API responses,
  never from a hardcoded list that will rot.
- The analyze response already carries an unavailable-checks list. Make sure
  it is rendered on the bottlenecks stage rather than dropped.

Do not soften anything. "Structural estimate, not a probability" and the
assumptions blocks must survive verbatim wherever they already appear.
```

---

## Prompt 6 — Verify the whole thing end to end

```
Go through every one of the eight workspace stages against the live deployed
site (dynamic-workflow-intelligence.vercel.app) using the seeded project
00000000-0000-0000-0000-000000000001, signed out, as the public read-only
guest.

For each stage — build, live, bottlenecks, risk, requirements, whatif,
optimize, history — record:

  * does it load without a console error
  * does every panel show real data from the API
  * does every control that is visible actually do something
  * on a deliberately failing request, does it show an error rather than an
    empty success state

Then check these specifically:

  * the live stage: start a replay, confirm frames arrive over SSE, confirm
    pause/seek/speed work, confirm the evidence tier changes as events land
  * the import route (/workspace/import): preview a bundled sample, confirm
    the mapping step, confirm a commit creates a real project
  * as a signed-out guest, attempt a mutation anywhere and confirm it is
    refused by the backend with a 403, not by a hidden button

Produce a written report listing every defect found, each as: the stage, what
you did, what you expected, what happened. Do not fix anything in this pass —
report first so the list can be triaged. Then fix them in a second pass,
highest user impact first, and say which ones you did not fix and why.
```

---

## What the audit found

**The backend is not the problem.** Probed live and signed out, these all
return real data: `ai/status`, `import/samples`, project, workflow, `analyze`,
`risk`, `forecast/assumptions`, `optimize/objectives`, `accuracy`, `versions`,
`requirements`, `scenarios`, `members`, `analysis-runs`. Two apparent failures
were correct behaviour: `/forecast` is a POST (405 on GET) and
`/replay/timeline` 404s with "No replay is running", which is the right answer.

**The frontend is where the gap is.** Seventeen API client functions are
called from nowhere, and three finished components are imported by nothing:
`RequirementHistory`, `ImpactReport`, `DiffView`.

**Priority if you run short of time:** Prompt 5 first, then 2, then 1.
Prompt 5 because an honest system that admits its gaps beats a prettier one
that hides them, and it is the claim everything else rests on. Prompt 2
because requirement staleness is the capability nothing else on the
competitive map has, and it is fully built and simply not on screen. Prompt 1
because a number computed in the browser contradicts the core promise.

Prompts 3 and 4 are real gaps but neither breaks a claim you have made.
