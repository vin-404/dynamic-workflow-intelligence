# Overnight autonomous run — FlowTrace capability completion

You are running unattended. Nobody will answer a question until morning, so
every rule below exists to make "keep going safely" possible without a human.

---

## The project

FlowTrace (formerly Dynamic Workflow Intelligence Platform). FastAPI backend
in `backend/app/`, Next.js 16 frontend in `frontend/src/`. Live at
`dynamic-workflow-intelligence.vercel.app`, API on Render. Seeded demo
project: `00000000-0000-0000-0000-000000000001` ("Campus Tech Symposium").
Eight workspace stages — build, live, bottlenecks, risk, requirements,
whatif, optimize, history — routed at
`frontend/src/app/workspace/[projectId]/[stage]/page.tsx`.

**Facts confirmed against production tonight. Do not re-derive or contradict
these:**

- `GET /api/ai/status` → `{"provider":"null","available":false,"model":null,
  "roles":["interpreter","proposer","narrator"]}`. Every AI-touched surface
  is running its deterministic fallback.
- Roles **are** enforced. `PROXY_SHARED_SECRET` is set on both sides. A
  signed-out visitor is the public read-only guest: project-scoped writes are
  refused with `insufficient_role` / `your_role: viewer`, project-less writes
  with `read_only_guest`.
- The backend is healthy. `analyze`, `risk`, `forecast/assumptions`,
  `optimize/objectives`, `accuracy`, `versions`, `requirements`, `scenarios`,
  `members`, `analysis-runs`, `import/samples`, `ai/status`, project and
  workflow all return real data to an anonymous caller. `/forecast` is a POST
  (GET returns 405 — not a bug). `/replay/timeline` 404s with "No replay is
  running" when none is — also not a bug.

## Two rules that override everything else

1. **No number shown to a user may be invented by the frontend.** Every
   figure comes from the engine via the API. If the API cannot be reached,
   the UI says so rather than substituting anything. A hardcoded
   `lib/demo.ts` was deleted for breaking this. Do not reintroduce anything
   like it, under any name, for any reason.
2. **When a capability cannot run, name it and say what it needs.** Never
   hide it, and never show an empty state that looks like success.

---

## Safety rules — these are absolute

- **Work only on a new branch** `feat/capability-completion`, created from
  the current `main`. Create it before your first edit.
- **Never touch `main`.** No merging, no rebasing onto it, no committing to
  it. Production serves `main` and must be unaffected all night.
- **Never `git push --force`**, never rewrite published history, never
  `git reset --hard` onto anything you did not create this session.
- **Never change deployment configuration or secrets.** Not Vercel env vars,
  not Render env vars, not `.env.local`, not OAuth settings. If a task seems
  to need one, write it in the report instead and move on.
- **Never weaken a test to make it pass.** If a suite was green before your
  change and red after, your change is wrong. Fix the code or revert that
  piece. Deleting an assertion, adding a skip, or loosening a threshold to
  get green is a failure, not a fix.
- **Never delete a file** unless you can show it is imported by nothing and
  it duplicates something that survives. Say so in the commit message.
- **Do not deploy anything.** Pushing the branch is fine and will produce a
  Vercel preview; that is the only deployment you may cause.

## Stop conditions — write it down and move on, do not guess

If any of these happen, stop that task, record it in the report, and start
the next one:

- the same test fails three times running
- a change would require editing an existing test's assertions
- the task is genuinely ambiguous and a wrong guess would be expensive
- you would need a credential, an API key, or a dashboard you cannot reach
- you would need to change the database schema in a way that is not additive

Never sit idle waiting for input. Never invent a workaround that violates the
two rules above in order to keep moving.

---

## The work, in this order

The full text of each is in `docs/FIX_PROMPTS.md`. Read that file first.

1. **Prompt 5** — Tell the truth about what this build cannot do
2. **Prompt 2** — Mount the requirement surfaces that already exist
3. **Prompt 1** — Move risk re-weighting to the engine
4. **Prompt 3** — Scenario management
5. **Prompt 4** — Constraints and optimizer objectives
6. **Prompt 6** — Verify the whole thing end to end

This order is deliberate: honesty surface first, then the capability nothing
else on the market has, then a correctness fix, then the two genuine gaps.
If you run out of time, having 1–3 done properly beats all six done badly.

## For each task, in this loop

1. Read the relevant existing code before changing it. These components were
   written with reasons; read the docstrings. Do not rewrite a component to
   fit a new shape when a prop would do.
2. Make the change.
3. Run `cd frontend && npx tsc --noEmit` — must be clean.
4. Run `cd frontend && npm run build` — must pass.
5. Run `pytest backend/tests -q` from the repo root — must pass, with the
   same or a higher count than before you started.
6. Commit with a message that says what changed and why, in the style of the
   existing history (look at `git log`). Tag it `capability-<n>`.
7. Move to the next task.

Do not batch six tasks into one commit. Each must be independently
reviewable and revertable in the morning.

## When you finish, or run out of things you can safely do

Write `docs/OVERNIGHT_REPORT.md` containing:

- what you completed, with the commit and tag for each
- what you attempted and abandoned, with the stop condition that fired
- every defect you found but did not fix, as: stage, what you did, what you
  expected, what happened
- anything you changed that you are less than confident about, named
  explicitly, so it gets reviewed first
- the final state: branch name, head commit, test counts, whether the build
  passes

Then push the branch (`git push -u origin feat/capability-completion`) and
stop. Do not open a pull request, do not merge, do not deploy.

**Be honest in the report.** A run that completed two tasks well and says so
plainly is worth far more than one claiming six and hiding two broken ones.
The report is read before the code.
