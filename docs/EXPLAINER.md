# Dynamic Workflow Intelligence Platform — the whole thing, explained plainly

Read this end to end and you will be able to answer any question a judge asks.
It assumes you can program but knows nothing about scheduling theory or this
codebase. Section 12 is the AI layer, in full detail.

---

## 1 · What the product is, in one paragraph

You give it a workflow: a list of tasks, who is doing them, how much work each
one is, which tasks must finish before which others can start, and a deadline.
It then answers four questions — where the work is stuck right now, where it is
likely to get stuck next, what a proposed change would do, and whether there is
a better arrangement of the same work. It explains every answer, and it tells
you which checks it could not run and why. It works the same for a software
team, a film shoot, a hospital trial or a construction site, because the engine
does not know what industry it is in.

---

## 2 · The vocabulary — every term, defined

| Term | What it means |
|---|---|
| **Task** | A unit of work. Has a name, an effort figure, a status, and zero or more people assigned. |
| **Dependency** | "Task A must finish before task B can start." An arrow from A to B. |
| **DAG** | Directed Acyclic Graph. Directed = arrows have a direction. Acyclic = no loops. If your tasks form a loop (A waits on B waits on A) the plan is impossible, and we reject it with the loop named. |
| **Topological sort** | An ordering of tasks such that every task appears after everything it depends on. This is the order you have to walk the graph in to schedule it. |
| **Effort** | How much work a task is — e.g. 6 person-days. |
| **Duration** | How long the task actually takes in calendar terms, which depends on how many people are on it. Effort and duration are different, and conflating them is a classic planning bug. |
| **Earliest start (ES)** | The soonest a task could possibly begin, given everything it waits on. |
| **Latest start (LS)** | The last moment a task can begin without pushing the project's finish date. |
| **Slack / float** | `LS − ES`. How much a task can slip before it costs you the deadline. Slack of 5 means five days of cushion. Slack of 0 means none. |
| **Critical path** | The chain of tasks with zero slack. Any delay to any of them delays the entire project. This is *the* thing a project manager needs to know and Jira does not compute it. |
| **Resource** | A person or a team. Has a capacity. |
| **Assignment** | A link between a task and a resource. |
| **Overload / contention** | One person needed on two tasks at the same time. |
| **Snapshot** | A frozen, unchangeable picture of the whole workflow at one moment. |
| **Mutation** | One typed change to a workflow — e.g. "change task T3's duration to 5 days". |
| **Scenario** | A base snapshot plus an ordered list of mutations. A hypothetical. |
| **Version** | A snapshot that has been sealed and kept forever. |
| **Finding** | Something the system detected and is telling you about, with evidence. |

---

## 3 · The four capabilities

1. **Detect current bottlenecks.** Not "which tasks are late" — which task is
   *causing* the lateness, ranked by how much damage it is doing.
2. **Predict future bottlenecks.** Which tasks are likely to become problems,
   with the reasoning shown factor by factor.
3. **Simulate a hypothetical.** "What if the venue confirmation slips three
   days?" — answered fully, without touching the real workflow.
4. **Optimise.** Propose better arrangements of the same work, check each one
   actually helps, and rank the survivors.

**The insight that makes this one system instead of four:** all four reduce to
*schedule a graph, then compare two schedules*. What-if is one candidate a human
wrote. Optimisation is forty candidates the system wrote. Same code path — which
is why the four answers can never contradict each other. A dashboard product
computes each panel separately, so its panels *can* disagree.

---

## 4 · How the engine schedules — step by step

This is the Critical Path Method, invented in 1957. We use it deliberately
because it is auditable: you can always show *why* a date moved.

**Step 1 — validate.** Is the graph acyclic? If not, reject and name the cycle.

**Step 2 — topological sort.** Order the tasks so nothing comes before what it
depends on.

**Step 3 — forward pass.** Walk that order front to back:

```
ES[task] = max(EF of every predecessor)   (0 if it has none)
EF[task] = ES[task] + duration[task]
project_end = max(EF of all tasks)
```

`EF` is earliest finish. Now you know the soonest everything can happen and the
soonest the project can end.

**Step 4 — backward pass.** Walk the same order back to front:

```
LF[task] = min(LS of every successor)   (project_end if it has none)
LS[task] = LF[task] − duration[task]
```

**Step 5 — slack.** `slack[task] = LS[task] − ES[task]`. Every task with slack
of zero is on the critical path.

That is the whole algorithm. Two passes over a sorted list. It is fast (23.9ms
on a 17-task project) because it is pure arithmetic with no database calls.

### What we added on top of textbook CPM

- **A working calendar** — weekends and holidays, so "three days" means three
  *working* days.
- **An effort model** — `duration = effort / (1 + 0.6 × (assignees − 1))`.
  Two people on a 6-day task take 3.75 days, not 3, because coordination costs
  something. The 0.6 is an efficiency factor. Tasks can be marked
  **non-divisible**, meaning extra people do not speed them up at all (you
  cannot parallelise "wait for legal approval").
- **Resource awareness, reported separately.** Textbook CPM assumes a person
  can be in two places at once. Rather than silently pretending, we compute the
  schedule CPM's way and then *detect and report* the overloads. This is an
  honest limitation, stated on screen.
- **Immutable versions** — every sealed state is kept, so any claim we made
  last week can be reproduced exactly.

### Why "pure core" matters

The engine has **no I/O at all**: no database, no network, no randomness, no
reading the clock. Same input, same output, forever.

That gives us three things: it is trivially testable, it is fast enough to run
40 hypothetical schedules in under a second, and — importantly — the LLM
*cannot* corrupt it, because the engine cannot call out to anything at all.

This is enforced, not just intended. A test called `test_core_purity.py` parses
the **source code** of every engine module and fails the build if any of them
imports the database, the network, or the clock.

---

## 5 · Detectors — finding what is wrong

A **detector** is a small function that looks at a scheduled workflow and
returns findings. There are about a dozen, in a registry.

**They are tiered by the data they need:**

| Tier | Needs | Example |
|---|---|---|
| **0** | structure alone | a task with zero slack and no owner |
| **1** | task statuses | a task that has been "ready" for 8 days and nobody started it |
| **2** | history | a task type that historically overruns |
| **3** | cross-project evidence | a person overcommitted across several projects |

**The bit that wins trust:** a brand-new workflow has no history, so the Tier 2
and 3 checks *cannot run*. Most products silently skip them and show a confident
green dashboard. We list every check that did not run and name the data it needs.

**Ranking.** A late task is a symptom; we want the cause. So findings are ranked
by:

```
impact = attributed delay in days × (1 + number of downstream tasks affected)
```

We found this the hard way during testing: a task with **16 days of slack** was
being ranked above the actual critical-path blocker. The formula fixed it.

**Accuracy check.** We built a test workflow with known bugs deliberately
planted in it. The detectors must find all of them and invent none. Current
result: **3 of 3 found, 0 false positives** — and the app displays that
verification on screen.

---

## 6 · Risk scoring — predicting the future, honestly

Two separate layers, and knowing which is which is the point.

### Layer A — an additive structural score

Nine factors, each weighted, summed:

| Factor | Weight | Meaning |
|---|---|---|
| slack ratio | 0.20 | how little cushion this task has |
| downstream fan-out | 0.15 | how many tasks break if this one slips |
| deadline pressure | 0.13 | how close the whole project is to its deadline |
| criticality proximity | 0.12 | how nearly on the critical path it is |
| resource pressure | 0.12 | how loaded its assignees are |
| duration uncertainty | 0.08 | how fuzzy the estimate is |
| predecessor health | 0.08 | whether the things it waits on are in trouble |
| remaining chain depth | 0.07 | how much work sits after it |
| assignment gap | 0.05 | whether anyone is actually on it |

Weights sum to 1.00, and the UI shows the per-factor breakdown for every task.
It is not one opaque number.

**The sentence that matters:** *"This is a structural estimate, not a
probability."* There is no calibration data behind Layer A. The product says so
in four separate places, not one. We know exactly what would fix it — per-domain
historical duration variance — and the seam for it exists and is empty, on
purpose.

### Layer B — Monte Carlo

*Monte Carlo* means: instead of one estimate, run the simulation thousands of
times with randomly sampled task durations and look at the distribution of
outcomes.

- **P50** — the date you finish by in 50% of simulated runs (the median).
- **P80 / P90** — the dates you finish by in 80% / 90% of runs. Later dates,
  more confidence.
- **Criticality index** — for each task, the fraction of runs in which it landed
  on the critical path. A task on the critical path in 95% of runs is
  structurally dangerous even if today's single schedule says it has slack.

It is **seeded**, meaning the random numbers are reproducible: same seed, same
answer. Every run ships an **assumptions block** stating what it assumed.

*Why this matters for the pitch:* Jira's AI (Rovo) was tested on exactly this
kind of forecasting across 12 scenarios and **inverted the percentile
relationship** — it claimed higher confidence meant *more* items delivered,
which is backwards. It was closest to correct **0 times out of 12**.

---

## 7 · Mutations — the key invention

**Nothing in the system changes a workflow except by emitting one of seventeen
typed operations.** Not the user, not the optimiser, and not the language model.
There is no other vocabulary.

Roughly: add/remove a task, change duration, change effort, add/remove a
dependency, reassign, add/remove an assignee, split a task, merge tasks, change
the deadline, change status, set divisible, add/remove a resource, reorder.

Three properties, and each one buys something concrete:

- **Typed** — each operation has a fixed shape, so it can be validated *before*
  anything is touched. Does that task exist? Would this dependency create a
  cycle? Does it violate a declared constraint?
- **Invertible** — every change can be undone exactly. This is what makes
  what-if genuinely safe rather than "safe if we remembered to copy things".
- **Closed** — it is a *finite* set. The LLM can only speak this language, so
  its output is fully checkable before it runs.

**This is the answer to "how do you trust the AI?"** The model does not get to
*do* things. It gets to propose a list of typed operations, every one of which
is validated against the graph. An invalid proposal is rejected with a reason. A
valid one becomes a *pending* scenario that a human must apply.

---

## 8 · Scenarios and immutable versions

A scenario is **not a copy** of the workflow. It is:

```
scenario = base version id + [ordered list of mutations]
```

Small, exactly reproducible, and replayable against any version.

Immutability is real, not a convention: snapshots use frozen dataclasses and
`MappingProxyType` (a read-only view over a dict), so code that tries to mutate
one raises rather than quietly succeeding.

**The lifecycle:**

1. Sealed base version — immutable
2. `+` ordered mutations — validated against the graph before anything runs
3. `=` a pending scenario — evaluated, diffed, ranked, still not applied
4. A human presses apply — **the only write path that exists**

**What you get back** is a full diff: which dates moved, which tasks entered or
left the critical path, whether the deadline still holds, who became overloaded,
and which findings appeared or disappeared.

---

## 9 · Optimisation — generate, gate, verify, rank

The competitive research says nobody does the third step. This is our strongest
technical claim.

**Generate.** Six deterministic generators produce candidates:

| Generator | What it tries |
|---|---|
| `gen_transitive_reduction` | remove dependency arrows that are already implied by other paths |
| `gen_parallelize_zero_slack` | split divisible zero-slack tasks across more people |
| `gen_drop_soft_ordering` | remove orderings that were preference, not necessity |
| `gen_resource_levelling` | move work off overloaded people |
| `gen_resequence_contended` | reorder tasks fighting over the same person |
| `gen_drop_bottleneck_tasks` | test whether a blocking task is actually needed |

Plus the **LLM Proposer** as one more candidate source, with no special
privileges whatsoever.

**Gate.** Seven hard constraints reject candidates outright — mandatory tasks,
immutable dependencies, non-divisible work, fixed assignments, minimum
durations. A refusal names the constraint it hit, so "no, and here is why".

**Verify.** *This is the step nobody else does.* Every surviving candidate is
re-scheduled by the same CPM engine that found the problem. A candidate that
does not actually improve the finish date is discarded, not shown.

**Rank.** Scored deterministically against a stated objective, inside a time
budget, and it reports how many candidates it evaluated and whether it ran out
of time.

Measured: **11 ranked candidates in 136ms** against a 0.1s budget; 40 candidates
persisted in 706.5ms.

---

## 10 · Requirement change and staleness — the differentiator

PS 9 explicitly asks about "changing requirements". Most tools read that as
*re-plan the future*. The expensive question is about the past.

When a requirement changes, we compute **backwards**: which already-completed
work is now invalid and must be **redone**, and which must be **re-checked**.
That propagates through the dependency graph — if a spec change invalidates task
T4, everything downstream that consumed T4's output is suspect too.

No tool on our competitive map does this. It is the single most demo-able thing
in the product.

---

## 11 · Real-time replay

The system streams state changes over **Server-Sent Events** (SSE) — a simple
one-way HTTP channel where the server pushes updates to the browser. You can
replay a workflow's history forward, watch findings appear and disappear as
statuses change, and see the projected finish date move.

This is what makes "real time" in the problem statement true rather than
aspirational.

---

## 12 · The AI layer — in full

**This is the section to know cold.** It is also the part judges probe hardest,
because most hackathon projects are an LLM in a trench coat and yours is not.

### The one rule

> **The language model has no authority over any number.**

Every date, duration, slack figure, risk score, ranking and feasibility verdict
comes from the deterministic engine. Turn the model off entirely and **all four
capabilities still work.**

### Three roles — never one mega-prompt

Three separate roles, each with its own prompt and its own output schema. Why
not one combined prompt? Because they fail in different ways and need different
repair strategies. One prompt makes every failure indistinguishable.

**1 · Interpreter** — natural language in, a mutation list out.

"What if the venue confirmation slips three days?" becomes a validated list of
typed mutations and a **pending** scenario. It computes nothing. A human must
press apply.

*Without an API key:* a small, clearly-labelled pattern matcher over the same
handful of shapes the UI form already offers. It handles four phrasings, it says
so, and when it does not recognise a phrase it **returns nothing rather than
guessing**.

**2 · Proposer** — a third candidate source for the optimiser.

It suggests restructurings the heuristics cannot see: domain knowledge,
sequencing insight, what usually goes wrong in this kind of project. It does
**not** score its own proposals, does not apply them, and gets no shortcut — a
model candidate goes through the same validation, the same constraint gates and
the same deterministic scoring as a heuristic one.

*Without a key:* returns nothing. The six deterministic generators were always
the primary source. The model adds *insight*, not *capability*.

**3 · Narrator** — engine result in, prose out.

It receives **only** engine output and may only rephrase it. Every number it
writes must already exist in the payload it was given.

*Without a key:* the engine's own templated explanations — which were always the
primary source of the words anyway.

### The provider boundary

One interface, two implementations:

- `AnthropicProvider` — calls the real API. Model: `claude-opus-5`.
- `NullProvider` — **the default**, selected whenever no API key is present.

The reasoning, quoted from the source: *"Venue wifi fails and API keys
rate-limit; if the LLM being down breaks the demo, the architecture is wrong."*

### The call-and-validate discipline

One shared runner implements this so no role can skip it:

- **Structured output only** — a JSON schema per role, validated with Pydantic.
  No parsing of free text, ever.
- **Exactly one repair attempt.** If validation fails, retry once with the error
  appended. Then reject with a user-visible reason. No unbounded retries.
- **Responses cached by prompt hash** — so a rehearsed demo path cannot fail
  live, and costs nothing to repeat.
- **Every interaction logged** — role, provider, prompt hash, schema name,
  whether it validated, whether it was repaired, whether it came from cache,
  the rejection reason, and whether it fell back. *This log is the evidence that
  the model never had authority.*

### What the model actually sees

Not the full graph. A **compact projection**: task ids, names, effort,
dependencies, assignees, slack, the deadline, and the current findings.

Above 40 tasks it compacts further — only the tasks that matter (critical path,
tasks with findings, low-slack tasks) plus a count of the rest, with a hard
ceiling of 80 tasks sent.

Two reasons: a 200-task project must not blow the context window, and — quoting
the source again — *"a model that has been handed evidence it does not need is a
model with more to hallucinate about."*

### The two invariants, and how they are enforced

**1 · No write path.** Nothing in the AI package imports the services that write
workflow state. `test_ai_boundary.py` parses the source of every module in the
package and **fails the build** on such an import. A model proposal can only
ever become a pending scenario.

**2 · No authority over numbers.** A function called `verify_numbers` runs on
every model narration *before it is shown*. If the narration contains a number
that is not in the payload the model was given, the narration is **rejected**
and the engine's own wording is used instead.

Both are tested, not merely asserted. That distinction is the whole point.

### The honest limitation, which you should volunteer

**No live model call has ever been made.** Every AI test runs against a stub or
a recorded response. The request shape is checked against the installed SDK's
own type definitions — the strongest guarantee available without a key — but the
first live call will still be a first.

Say this before you are asked. It costs nothing and buys enormous credibility.

---

## 13 · Domain-agnosticism, proven by a test

The engine has no idea what industry it is in. No hardcoded notion of a sprint,
a shoot day, a clinical visit or a construction phase — only tasks,
dependencies, effort, people and a deadline.

A **domain** is a configuration row: display names, a working calendar, and which
detector tiers have the data to run. Adding an industry is data entry, not code.

**The domain-leak test:** take a workflow, rename every task and team to a
completely different industry keeping the structure identical, and run the full
analysis on both. The output must be **byte-identical**. If it is not, domain
knowledge has leaked into the engine and the build fails.

That is the kind of test that only exists if you actually meant the
architectural claim.

---

## 14 · Auth and roles

- **Google OAuth** via Auth.js v5. Sessions are JWTs — no separate user database
  on the frontend, because the backend already owns user rows and two sources of
  truth about identity is a bug waiting to happen.
- **Three roles**: `owner` > `editor` > `viewer`. Viewer may read and may ask
  questions (analyse, risk, optimise, explain). Editor may author and apply.
  Owner may also change the member list.
- **Identity is injected server-side.** The browser never talks to the backend
  directly. Every API call goes through the Next.js server, which verifies the
  session and injects the identity headers — so a client physically cannot claim
  to be someone else. An absolute backend URL in the browser bundle would have
  made auth decorative, so the frontend hard-codes a relative base and reads no
  variable at all.
- **Public read-only guest.** With `PUBLIC_DEMO_VIEWER=1`, a visitor with no
  session becomes a real user row held to a read-only bar by the backend. That
  is how the public demo link works without a Google account. The refusal comes
  from the server, not from the frontend hiding buttons.

---

## 15 · The stack, and why each piece

**Engine** — Python 3.14, pure functions, zero I/O. NetworkX for DAG validation
and topological sort. Frozen dataclasses + `MappingProxyType` for real
immutability. Seeded Monte Carlo for reproducibility.

**Backend** — FastAPI: 68 routes across 16 routers. SQLAlchemy async with
Alembic migrations. SQLite by default (so a teammate clones and runs with zero
setup), PostgreSQL by configuration. Server-Sent Events for the live feed.
Pydantic for validation everywhere.

**Frontend** — Next.js 16.3.4, React 19.2.8, TypeScript. Tailwind + shadcn/ui.
Auth.js v5. 21 components.

**Delivery** — Render (Singapore) runs the Docker backend. Vercel runs the
frontend and proxies the API on the same origin. Anthropic API optional.
Playwright browser walkthroughs.

---

## 16 · Testing — what each unusual test proves

| Test | What it proves |
|---|---|
| **Purity test** | parses the source of every core module; fails on an import of the database, network or clock |
| **AI boundary test** | fails if any AI module imports a service that writes state |
| **Domain-leak test** | same structure, different industry → byte-identical output |
| **Planted-fault suite** | known bugs injected; detectors must find all and invent none |
| **5 Playwright walkthroughs** | real browser, zero console errors permitted |
| **Postgres run** | full suite against real PostgreSQL from an empty database — 780 passed; container restarted twice, no duplicate rows |

Roughly **1,054 tests** passing in total.

---

## 17 · Honest limitations — volunteer these

1. **The Layer-A risk score is not a probability.** No calibration data. Fix:
   per-domain historical duration variance.
2. **CPM is resource-blind.** The schedule assumes a person can be in two places
   at once; overload is detected and reported separately. Solving RCPSP properly
   is a different project.
3. **The optimiser is a local search, not an optimum.** It finds what its six
   generators can express.
4. **The key-less Interpreter is a pattern matcher**, handles four phrasings,
   and is labelled as such.
5. **No live model call has ever been made.**
6. **Cold start is real.** Tiers 1–3 need statuses, history and cross-project
   evidence.
7. **The effort model is a defensible curve, not a measured one.**

A judge cannot break a claim you already made yourself.

---

## 18 · The commercial case

**Position as an add-on, not a replacement.** Jira stays the system of record;
we are the layer that *computes* with what it records. That turns "we could sell
this to Atlassian" from bravado into a business plan.

**The evidence Jira does not do this** (all public, all still open):

- `JSWCLOUD-21122` "Add Critical Path Analysis" — 99 votes, opened January 2021,
  status still "Gathering Interest".
- `JSWSERVER-24937` shift dependent dates when a blocker slips — 219 votes,
  December 2021, no Atlassian response.
- `JRACLOUD-43369` make "blocks" actually block — **519 votes, open since May
  2015.** Eleven years.
- They **deprecated** Portfolio's scheduling engine in July 2021 and never
  replaced it. Their own engineer, on record: the auto-scheduler's reasoning is
  "somewhat opaque", it is less sophisticated than its predecessor, and improving
  it is "not an immediate priority".

**The safe framing, and stick to it:** *Jira records dependencies; it does not
compute with them.* That is analytical depth, not feature absence, and it is
true.

### ⚠️ Four things you must NOT say

| Do not say | Why it is wrong |
|---|---|
| "Jira can't detect resource overallocation" | Individual Capacity Planning went GA 27 July 2026 |
| "Atlassian AI does nothing about delivery risk" | Jira Delivery Agent shipped 13 July 2026 |
| "Jira has no bottleneck detection" | Cumulative Flow Diagram and Control Chart have shipped for years |
| "Jira can't track cross-project dependencies" | That is exactly what Advanced Roadmaps is for |

One correction on stage discounts everything else you said. Stay on the
defensible claim.

**Pricing anchors:** BigPicture, a Jira add-on whose own docs admit no
slack/float calculation, charges **$24,780/yr at 1,000 users**. Celonis is
$150K–$5M/yr. Barbecana Full Monte sells Monte Carlo *alone* for $1,195/seat. We
ship it as one feature of four.

---

## 19 · The academic angle

*"Prescriptive process monitoring: Quo vadis?"* — PeerJ Computer Science, a
systematic review of 37 papers. It lists four open problems:

| Open problem | Where we stand |
|---|---|
| methods do not explain *why* an intervention is recommended | every finding carries root cause and evidence; every candidate carries its mutation list |
| intervention discovery is unsolved — methods assume the action set is given | the 17-kind mutation algebra **is** a defined intervention space |
| nothing addresses unintended consequences | the engine computes downstream effects; gates reject harmful candidates before scoring |
| validation deficit — predictions were accurate but interventions did not help | every candidate is verified by the same engine before being recommended |

**Say it exactly like this:** *"A peer-reviewed survey lists four open problems
in this field. Our architecture addresses three of them. Here is the paper."*

Be precise: we **address** them architecturally. We have not **solved** them and
have not published. That distinction keeps the claim credible.

---

## 20 · The questions that will hurt, and the answers

**"Isn't this just Microsoft Project in a browser?"**
> MS Project computes a critical path and won't tell you why. It knows your plan
> and nothing about the work actually happening. It can't import your Jira board,
> can't replay what occurred, won't tell you a spec change invalidated three days
> of finished work, and has never proposed a better arrangement of the same work.
> We do all four, and we explain every number.

**"CPM is from 1957. What's new?"**
> The scheduling maths is old and deliberately so — it's auditable, which matters
> when you're making a claim about someone's deadline. What's new is the
> composition: a closed algebra of typed changes that is the only vocabulary
> anything — including the language model — can use; optimisation gated by
> constraints and verified by the same engine that found the problem; and a
> system that reports what it cannot assess and why.

**"Did AI write this?"**
> We designed the architecture and used Claude Code to implement it. The
> decisions that matter were ours: the four-capability scope, immutable versions,
> the closed mutation algebra, the constraint gates, and keeping the model away
> from every number. Here's the decisions log with the reasoning for each, and
> here's the test suite that proves the system does what we claim.

**"Is this just an LLM wrapper?"**
> Turn the model off and all four capabilities still work — that's the default
> configuration. The model has no write path, enforced by a test that parses our
> own source code, and no authority over any number, enforced by a function that
> rejects any narration containing a figure the engine didn't produce.

**"How do I know your risk scores are right?"**
> The Monte Carlo percentiles are what they say they are. The Layer-A structural
> score is explicitly *not* a probability, and the product says so in four
> places. We separate the calibrated thing from the uncalibrated one and label
> which is which — that distinction is the product.

**"What happens with a brand-new project and no data?"**
> Ten structural checks run, and the app lists every check that couldn't run and
> names the data it needs. That's the cold-start answer, and it's on screen
> rather than hidden.
