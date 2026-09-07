# How to demo this

Eight minutes, two domains, one refusal. The exact commands, what to click,
what to say, and what you should see. Rehearse it three times.

Everything below runs **with no API key**. The model is optional; nothing on
this path depends on it. That is the point, and it is also the reason the
demo cannot fail because of someone else's uptime.

---

## Before you start

### 1 · Reset to a known state

From the repo root:

```bash
.venv/Scripts/python.exe -m backend.scripts.reset_db
```

```
database: sqlite+aiosqlite:///./dwi.db
dropping and recreating

seeded:
  campus-symposium     00000000-0000-0000-0000-000000000001
  battery-pilot-line   00000000-0000-0000-0000-000000000002
```

One command, both seed domains, deterministic project ids. Run it between
rehearsals and again immediately before the real thing.

### 2 · Check the whole demo still works

```bash
.venv/Scripts/python.exe -m backend.scripts.demo_check
```

This walks every beat below and asserts the thing each beat *claims* — that
the tier-0 findings arrive with no history, that the impact number can be
recomputed by hand, that the base workflow's content hash is byte-identical
after a simulation, that the refusal names its constraint. It ends with:

```
ALL BEATS PASSED
```

If it does not, do not go on stage. Fix it or cut the beat.

To rehearse the same walk with the AI layer switched on (replayed responses,
still no network):

```bash
.venv/Scripts/python.exe -m backend.scripts.demo_check --provider recorded
```

### 3 · Start it

Two terminals, from the repo root.

```bash
# Terminal 1 - backend on 8001, which is what the frontend proxies to
.venv/Scripts/python.exe -m uvicorn backend.app.main:app --reload --port 8001
```

```bash
# Terminal 2 - frontend
cd frontend
npm run dev
```

Open <http://localhost:3000>. Confirm both seeded workflows are listed before
you speak.

### 4 · Optional: turn the model on

```bash
export ANTHROPIC_API_KEY=sk-ant-...     # PowerShell: $env:ANTHROPIC_API_KEY="sk-ant-..."
```

Restart the backend. `GET /api/ai/status` will report `"available": true`. If
you leave it unset, every beat below still works — the Interpreter falls back
to a labelled pattern matcher and the Narrator to the engine's own wording,
and the UI says which you are looking at.

**Recommendation: demo with the key unset.** It is one less thing to fail, and
"this works with the model switched off" is a stronger claim than a nicer
paragraph.

---

## The walk

### 1 · The problem — 30s

> "A delivery lead is running one piece of work across five departments. She
> knows it is late. She does not know *which* thing is making it late, and
> every tool she has shows her tasks, not causes."

No screen yet. Just the sentence.

### 2 · Cold start, and honest limits — 60s

**Do:** From the project list, create a project. Give it a domain that does not
exist yet — type your own. Add four tasks in a chain, one person on all of
them, a deadline a few days out. Click **Bottlenecks**.

**Expect:** Four findings on a workflow with no history at all —
`serial_chain_no_parallelism`, `zero_slack_chain`, `critical_path_single_owner`,
`deadline_infeasible` — plus a panel listing what it *could not* assess and
what would unlock each check.

**Say:**

> "No history, no statuses, nothing but structure — and it already knows the
> shape of the problem. It also tells me what it cannot know yet, and why. It
> is not going to bluff at me."

**The beat:** the system knows the limits of its own evidence.

### 3 · Domain-agnosticism, proven not claimed — 45s

**Do:** Go back, open **Battery Pack Pilot Line**. Analyze.

**Say:**

> "Completely different structure, different vocabulary, same engine. There is
> no `if domain == manufacturing` anywhere in this codebase — and there is a
> test that fails if anyone adds one. The analysis payload has no domain field
> at all; the domain exists for you, not for the engine."

### 4 · Capability 1 — the blocker, not the blocked task — 60s

**Do:** Open **Campus Tech Symposium**. Analyze. Point at the top finding.

**Expect:** Root cause `T03`, not the tasks stuck behind it, with its evidence
open.

**Say:**

> "Nine days lost, times one plus seven tasks stuck behind it, is seventy-two.
> That is the whole impact formula and it is printed next to the number. Check
> my arithmetic."

### 5 · Capability 2 — where it is *likely* to get stuck — 60s

**Do:** **Predicted risk**. Open the factor breakdown on the top task. Read one
factor's explanation out loud.

**Say:**

> "Nine factors, each with its weight and its reason. Add the contributions up
> and you get the score exactly — no hidden term. And it says plainly that this
> is a structural estimate and not a probability, with the assumptions listed
> and what would make it a real probability. A factor it cannot measure reports
> itself unavailable and contributes zero rather than guessing."

### 6 · Capability 3 — a hypothetical, provably harmless — 75s

**Do:** **What if**. In the sentence box, type:

```
Anitha is unavailable from day 14 to day 21
```

**Expect:** It shows you the typed mutation it produced —
`RESOURCE_UNAVAILABLE_WINDOW {"resource_key":"anitha","from_day":14,"to_day":21}`
— a badge saying `nothing applied`, and a badge saying whether a model or the
pattern matcher read it. Click **Simulate this**. Day 26 becomes day 33.

**Say:**

> "It showed me what it understood *before* it ran anything. And look at the
> bottom: the base workflow's content hash, before and after. Identical. The
> model has no write path at all — its output becomes a pending scenario, and
> only I can apply one."

**The beat:** the original workflow is provably unchanged.

### 7 · Capability 4 — a better workflow, scored — 105s

**Do:** **Better workflows**. Let it run (about a quarter of a second). Open the
recommended candidate's per-criterion table.

**Expect:** Roughly thirty surviving candidates, the recommendation with six
criteria each showing before, after, delta and weight, and the weights on
screen.

**Say:**

> "Every candidate was generated deterministically, checked against your
> constraints, then scored by the same engine that produced the original
> analysis. The total is a ranking aid — the table is the answer, and it says
> so. Change a weight and the ranking changes; the response echoes the weights
> it used."

**Do:** Apply it. Go to **History**.

**Say:** "New version. Old version still there, unchanged, with its hash."

### 8 · The refusal — 45s

**Do:** Back to **Battery Pack Pilot Line** → **Better workflows** → tick
**optimize with no limits** → run. Scroll to the refused candidates.

**Expect:**

> `MANDATORY_TASK` — "UN38.3 safety certification is a legal precondition to
> shipping."

**Say:**

> "I asked it to optimize with no limits. It found the change that would hit
> the date, and it refused it, and it told me which constraint and whose
> reason. It will not buy you the date by quietly deleting the work. A refused
> candidate is never even scored."

**The beat:** this is the moment that separates you from every optimizer that
found a miraculous improvement.

### 9 · Evidence and limits — 45s

**Say:**

> "738 tests. A purity test that fails if the core imports a web framework or a
> database. A domain-leak test that fails if anyone writes `if domain ==`. A
> test that parses every file in the AI package and fails on an import that
> could write to the database. And a test that fails if a narrated sentence
> contains a number the engine did not produce."

Then the limitations, out loud, before anyone asks — see the list in
`docs/FINAL_REPORT.md`. Volunteering them reads as confidence.

---

## If something goes wrong

| Symptom | Fix |
|---|---|
| Panels empty, console shows `ERR_CONNECTION_REFUSED` on `:8001` | Backend not running, or on the wrong port. It must be `--port 8001`. |
| A workflow looks edited from a previous rehearsal | `.venv/Scripts/python.exe -m backend.scripts.reset_db` |
| `/api/ai/*` returns 404 | You are proxying to a backend started before Phase 7. Restart it. |
| The optimizer returns nothing | You are on a workflow with nothing to improve. Use a seeded one. |
| Anything at all, 30 seconds before you start | `reset_db`, restart both, `demo_check`. In that order. |

## Rehearsal rules

1. Run the whole thing with the model disabled at least once, so you know the
   fallback path works. It is also the recommended way to present.
2. `demo_check` before every rehearsal and immediately before the real thing.
3. Freeze the seed data and this script before the last six hours.
4. Record a screen capture as backup.
