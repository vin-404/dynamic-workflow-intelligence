# Positioning & evidence — the commercial pitch

Everything below is checkable. Every claim links to a public source. Use it in
the deck, in Q&A, and nowhere near the product UI (marketing inside the product
reads as insecurity).

---

## 1 · The four claims you can stake the pitch on

### Claim 1 — Native Jira has no critical path, no float, no slack. Anywhere.

- [JSWCLOUD-21122](https://jira.atlassian.com/browse/JSWCLOUD-21122) "Add Critical
  Path Analysis" — **99 votes, opened January 2021, status still "Gathering
  Interest."**
- [JPOSERVER-3116](https://jira.atlassian.com/browse/JPOSERVER-3116) — the same
  request against Advanced Roadmaps, February 2022, also unresolved.
- An Atlassian Community Champion, answering directly: *"No, there is no native
  tool in Jira to show a critical path."*
- Advanced Roadmaps' Dependencies report is documented by Atlassian as
  *"a view-only tool"* — arrows turn red on date misalignment, and that is all.

### Claim 2 — Dependencies in Jira are annotations, not constraints

- [JSWSERVER-24937](https://jira.atlassian.com/browse/JSWSERVER-24937)
  "Automatically shift dates of dependent issues based on blocker end date
  change" — **219 votes, opened December 2021, no Atlassian response.**
- [JRACLOUD-43369](https://jira.atlassian.com/browse/JRACLOUD-43369) — make
  `blocks` actually block a transition: **519 votes, open since May 2015.**
  Eleven years.
- Atlassian community leader Nic Brough: *"A link in Jira is just a link. It
  shows a relationship between two issues, and nothing more."*
- Advanced Roadmaps supports only "sequential" or "concurrent" — effectively
  finish-to-start or nothing. No start-to-start, finish-to-finish, or
  user-configurable lag.

### Claim 3 — "Scenarios" are a sandbox, not a solver

- Atlassian docs: changes in a scenario *"only live in Advanced Roadmaps unless
  you save the changes to Jira Software."*
- A community answer puts it plainly: *"The logic behind these changes isn't
  written in a code-like format, but instead, it's the modifications you make
  while working in a scenario."*
- Moving a task in a scenario **does not recompute its dependents**; the
  recommended workaround is Jira Automation.
- **Atlassian's own engineer, on the record:** the auto-scheduler's *"reasoning
  ... is somewhat opaque and it's not obvious why things are scheduled where
  they are,"* it is **less sophisticated than its predecessor**, and improving
  it is *"not an immediate priority."*
- They **deprecated** Portfolio's skill-and-role scheduling engine ("Live
  Plans") in July 2021 and never replaced it. Atlassian moved *away* from
  scheduling sophistication.

### Claim 4 — Their AI answers confidently and wrongly

A practitioner tested Jira's Rovo AI on probabilistic forecasting across 12
scenarios ([write-up](https://medium.com/thrivve-partners/using-rovo-jiras-ai-for-probabilistic-forecasting-time-saver-or-frustrater-6e49265ac42a)):

- It conflated throughput with cycle time.
- It reported throughput as zero when completed items existed.
- It **inverted the percentile relationship** — reporting that a higher
  confidence level meant *more* items delivered, which is backwards.
- It was closest to the actual answer **0 times out of 12.** Human-built tools
  won 11 of 12.

**This is your strongest single slide.** Their AI was wrong twelve times out of
twelve. Yours declines to answer when the evidence isn't there, and states its
assumptions when it does.

---

## 2 · Four claims that would get you corrected on stage — never say these

| Do not say | Why |
|---|---|
| "Jira can't detect resource overallocation" | **Individual Capacity Planning went GA 27 July 2026** — cross-space, flags >100% in red |
| "Atlassian AI does nothing about delivery risk" | **Jira Delivery Agent shipped 13 July 2026** — stale work, blocked items, slipping deadlines |
| "Jira has no bottleneck detection" | Cumulative Flow Diagram and Control Chart have shipped for years |
| "Jira can't track cross-project dependencies" | That is precisely what Advanced Roadmaps exists for |

The safe framing throughout: **Jira records dependencies; it does not compute
with them.** That is analytical depth, not feature absence, and it is true.

---

## 3 · The academic gap — why this is research-grade, not just a tool

*"Prescriptive process monitoring: Quo vadis?"*, PeerJ Computer Science —
a systematic review of 37 papers on systems that recommend interventions.
[Paper](https://peerj.com/articles/cs-1097/)

Its four documented open problems, and where you stand:

| Open problem (quoted) | Your architecture |
|---|---|
| *"Current methods do not incorporate mechanisms to explain why an intervention is recommended"* | Every finding carries root cause and evidence; every candidate carries its explicit mutation list |
| *"Intervention discovery is unsolved"* — methods assume the action set is given | The 17-kind mutation algebra **is** a defined intervention space; six generators discover candidates within it |
| *"No methods address unintended consequences (e.g. reassigning resources creates cascading delays elsewhere)"* | The engine computes downstream effects for every candidate; constraint gates reject the harmful ones before scoring |
| Validation deficit — in the one real deployment, *"predictions were rather accurate, but the interventions did not lead to desired outcomes"* | Every candidate is verified by the same deterministic engine before it is recommended |

**Say it as:** *"Prescriptive process monitoring has four documented open
problems. Our architecture addresses three of them. Here is the survey."*

---

## 4 · The competitive map — where the white space is

Nobody has all four of: live dependency graph · explainable root-cause
bottleneck detection · what-if on an immutable snapshot · constraint-gated
optimization that proposes **and verifies**.

| Product | Has | Missing |
|---|---|---|
| **Celonis** ($150K–$5M/yr) | Bottlenecks, discrete-event simulation | Root cause is lift-correlation only; simulation changes **do not cascade** |
| **Apromore** (Salesforce, Nov 2025) | Real roundtrip simulation | No optimization, no verification |
| **IBM Process Mining** (from $4,250/mo) | What-if, ROI-ranked recommendations | Recommendations unverified |
| **Primavera P6** (~$2.5–3.5K/seat) | Full CPM, float, levelling, Monte Carlo | No explanation, no live telemetry, specialist-only |
| **MS Project** ($30–55/user/mo) | CPM, float, levelling | No Monte Carlo natively, no explanation |
| **LinearB** ($29–59/user/mo) | Throughput Monte Carlo | **Structurally blind to dependencies** |
| **Asana** | A "critical path" label | It's the longest chain *by calendar date*, and computes **no float at all** |
| **Moovila** | Live critical path, proposes dates | Does not verify its proposals |
| **Epicflow** (€22.50/user/mo) | Genuine what-if sandbox | Optimization limited to project staggering |
| **Planview Connected Work Graph** (Jan 2026) | Live enterprise dependency graph + AI | **Simulation and verification not mentioned at all** — watch this one |
| **Safran / Acumen / Full Monte** ($1,195–$10K/seat) | Proper Monte Carlo, criticality index | One-shot offline reports; no live graph; specialist-only |

**Nobody has verified optimization.** The research says nobody knows how yet.

---

## 5 · Pricing anchors — what "we could sell this" is worth

| Product | Price |
|---|---|
| Jira Premium (needed for Plans) | ~$18.30/user/mo |
| BigPicture (Jira add-on, less capable than yours) | **$24,780/yr at 1,000 users** |
| Structure + Gantt (Tempo) | ~$4.79/user/mo combined |
| Barbecana Full Monte (Monte Carlo only) | $1,195/seat perpetual |
| Deltek Acumen Fuse | ~AUD $9,779/user perpetual |
| Celonis | $150K–$5M/yr |
| IBM Process Mining | from $4,250/mo |

**BigPicture is the direct comp.** A Jira Marketplace add-on charging nearly
$25K a year at enterprise scale, whose own documentation admits **no
slack/float calculation** and a critical path that breaks when a task loses its
dates.

---

## 6 · The pitch, in one paragraph

> Atlassian has had a request for critical path analysis open since 2021, for
> dependency propagation since 2021, and for "blocks should actually block"
> since 2015 with 519 votes. This is not an oversight — they deprecated their
> scheduling engine in 2021, and their own engineer says the replacement is
> opaque and not a priority. Their newest AI answered forecasting questions
> incorrectly twelve times out of twelve. We built the engine they walked away
> from: it computes the critical path, propagates every slip, simulates changes
> against an immutable snapshot, and proposes restructurings it verifies before
> recommending. Every number is explainable and none of them come from a
> language model. We are not a Jira competitor — we are the analytical layer on
> top of it, and the one they would have to buy rather than build.

**Position as an add-on, not a replacement.** It makes "we could sell this to
Atlassian" a business plan rather than bravado — and BigPicture proves the
market exists at $25K a year for less.

---

## 7 · Answers to the three questions that will hurt

**"Isn't this just Microsoft Project in a browser?"**
> MS Project computes a critical path and won't tell you why. It knows your plan
> and nothing about the work actually happening. It can't import your Jira
> board, can't replay what occurred, won't tell you a spec change invalidated
> three days of finished work, and has never proposed a better arrangement of
> the same work. We do all four, and we explain every number.

**"CPM is from 1957. What's new?"**
> The scheduling maths is old and deliberately so — it's auditable, which
> matters when you're making a claim about someone's deadline. What's new is the
> composition: a closed algebra of typed changes that is the only vocabulary
> anything — including the language model — can use; optimization gated by
> constraints and verified by the same engine that found the problem; and a
> system that reports what it cannot assess and why. A peer-reviewed survey
> lists four open problems in this area. We address three.

**"Did AI write this?"**
> We designed the architecture and used Claude Code to implement it. The
> decisions that matter were ours: the four-capability scope, immutable
> versions, the closed mutation algebra, the constraint gates, and keeping the
> model away from every number. Here's the decisions log with the reasoning for
> each, and here's the test suite that proves the system does what we claim.
