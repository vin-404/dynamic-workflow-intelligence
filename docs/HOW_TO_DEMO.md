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

### 3b · It arrives from Jira, not from your keyboard — 75s

**Do:** From the project list, click **Import from Jira**, then **Load the
bundled sample**. It ships with the app, so this works with the network
unplugged. Click **Preview**.

**Expect:** 17 rows read → 14 tasks, 22 dependencies, 5 resources. **Three
rejected rows, each for a different reason** — no issue key, a duplicate key,
and story points that read `TBD`. **One dropped dependency**, because `DLV-99`
is not in the export. And on every row, the readings the importer *guessed*
are open by default while the ones it read straight from the file are folded
away.

**Say:**

> "This is a real Jira export, including the part every CSV parser gets wrong —
> Jira writes the link columns as four columns with the same name, and the
> standard library's own reader silently keeps one of them. Read them wrong
> and you lose most of the graph while every count still looks right.
>
> Now look at what it says it *guessed*. Story points read as days. A status
> mapped onto ours. An estimate that was missing and got defaulted. Three rows
> it would not import at all, and it names them rather than quietly dropping
> them into a total. Nothing here is silent."

Click **Commit**, then **Bottlenecks**.

**Expect:** ten findings, infeasible by three days on structure alone.

> "And notice the evidence tier: it says it is low, because importing statuses
> is not the same as having a history. It did not invent a backdated event log
> to look more capable."

**The beat:** it is a tracker, not a form.

---

### 3c · In real time — 90s. *This is the one they remember.*

**Do:** Open **Campus Tech Symposium**, click **Live**, press play.

Then stop talking and let it run for fifteen seconds.

**Expect:** the clock advances a simulated day per second. Events arrive in the
rail. **Findings appear and clear on their own** as the simulated day passes
their thresholds, each one flashing once as it lands. The projected finish
updates in place.

**Say**, after the pause:

> "Nothing was pressed. That is the event log replayed forward, and every frame
> you just watched is a full re-evaluation of the whole workflow at that
> simulated day — the same function that runs when you click Analyze, called
> once per day.
>
> The findings appear and clear because the clock is an argument to the engine,
> not a global it reads. So a check that fires after three idle days fires on
> the day it would have fired, not when I happen to refresh."

Then point at the reconstruction block under the chart:

> "And it will not let me overclaim. It says this frame is a reconstruction
> computed from the ten events known by that day — and that the later three
> were deliberately not applied. This is what the engine *would have said then*,
> not what it says now dressed up as history."

Pause, scrub backwards, press play again.

> "Pausable, seekable, and it writes nothing. The stored workflow's content
> hash is the same before and after — `demo_check` asserts exactly that."

**The beat:** "in real time" is a running clock, not a refresh button.

---

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

### 5b · A probability, and the estimate it is not — 75s

**Do:** Click **Risk & forecast**. Scroll past the structural score to the
forecast.

**Expect:** P50 / P80 / P90 dates, a probability of meeting the deadline, a
completion histogram, and every task's **criticality index**.

**Say:**

> "Ten minutes ago I showed you a number and told you it was *not* a
> probability. Here is one that is — and the first thing on screen is a table
> saying which of the two you are looking at, because they are different
> numbers on different scales and reading a band from one against a number from
> the other is a category error.
>
> Five thousand runs, seed on screen, so this number is reproducible. And the
> most useful column is this one: **criticality index** — the fraction of runs
> in which a task landed on the critical path. That is what 'at risk of
> becoming a bottleneck' actually means. A task on the critical path today is a
> fact; a task on the critical path in 96% of simulated futures is a warning."

Then, deliberately:

> "Now read what it admits. It says it is **uncalibrated** — nothing here has
> ever been checked against what really happened. It says durations are sampled
> **independently**, and that this is *optimistic*, because real delays
> correlate — the week the supplier is late is the week the reviewer is on
> leave. And it says resource contention was not simulated at all.
>
> We could have shipped the number without those three sentences. It would have
> looked stronger and been worth less."

**The beat:** adding a real probability did not cost a single caveat.

---

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

### 6b · A requirement changes — 90s. *The differentiator.*

**Do:** Click **Requirements**, pick **R1**, and type a genuinely different
wording — "Two-day event, 700 attendees, hybrid attendance". Read the report.

**Expect, leading the screen:** **3 days of completed work invalidated**, six
tasks that must be redone versus two that merely need rechecking, five owners
affected, and the arithmetic on every row.

**Say:**

> "Every tool on the market can tell you a requirement changed. The good ones
> flag the link and ask a human to look at it.
>
> This says which completed work is now *invalid* — not downstream, not
> 'affected', but consumed something that is now wrong and has to be done
> again. Three days of finished work, gone, and here is who has to be told."

Now the honest part, and do not skip it:

> "Notice the finish date does not move. That is not the change being free —
> and the report says so itself, right there. The scheduler is status-blind, so
> completed work already occupies its span in the plan; re-opening it cannot
> lengthen the critical path.
>
> We could have written a second scheduler to make that number move for this
> demo. The cost is on the left, in days of real work. That is the honest
> number, so that is the one the screen leads with."

Then point at the caveat under the headline:

> "And this: it computes the blast radius from the dependency graph — it does
> **not** read your two sentences and decide whether the meaning changed. That
> is your call, and it says so before it says anything else."

Finally, scroll to the replan:

> "And it hands you the fix as an ordinary scenario — the same seventeen
> mutation kinds, unapplied, that you can diff and apply through endpoints that
> already existed. No eighteenth kind was invented for this feature."

**The beat:** it reasons about the cost of change, and refuses to overstate it.

---

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

> "1,054 tests. A purity test that fails if the core imports a web framework or
> a database. A domain-leak test that fails if anyone writes `if domain ==`. A
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
| The live screen never starts, or the clock does not move | The backend must be **one process**. More than one worker and the replay you started is not the one the stream connects to (D-143). |
| The live screen is empty on arrival | Someone else's replay finished. Press restart; a viewer arriving mid-replay is handed current state, but a *finished* replay has nothing left to send. |
| The requirement report shows `+0d` on the finish date | Expected, and the screen says why. Lead with the wasted-effort figure on the left; the date not moving is the scheduler being status-blind, not the change being free. |
| The forecast says "structural estimate" instead of a probability | The workflow has nothing to sample — no three-point estimates and a zero variance prior. That is the honest fallback, and it is worth showing rather than hiding. |
| An imported project's forecast is entirely "assumed" | Correct: no Jira export carries three-point estimates, so the spread comes from the domain prior and every task says so. |
| **The code on disk and the behaviour on screen disagree** | Suspect the *process*, not the code. A server started without `--reload` serves the code it was started with, for as long as it runs — so a fix you made hours ago may simply not be loaded. Probe the running server (`curl` the endpoint, or read the field in the response) rather than re-reading the source, then restart it. Both of the sessions that built Phase 10 and Phase 11 hit this independently, and both initially misdiagnosed it as a bug in their own new code. |
| Anything at all, 30 seconds before you start | `reset_db`, restart both, `demo_check`. In that order. |

## Rehearsal rules

1. Run the whole thing with the model disabled at least once, so you know the
   fallback path works. It is also the recommended way to present.
2. `demo_check` before every rehearsal and immediately before the real thing.
3. Freeze the seed data and this script before the last six hours.
4. Record a screen capture as backup.
