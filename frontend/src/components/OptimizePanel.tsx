"use client";

/**
 * Capability 4 - propose and evaluate better workflows.
 *
 * The per-criterion table is the result. The blended total is shown as a
 * ranking aid and labelled as one, because a single number with invisible
 * weights is the thing this design is written against - so the weights are on
 * screen and adjustable.
 *
 * Refused candidates are shown, not hidden, and they are shown *first*. A
 * system that declines to delete the safety certification and cites the
 * reason on record is worth more than one that reports a miraculous
 * improvement. The constraint id and the human-written reason are quoted in a
 * ruled block, verbatim, in neutral ink: a constraint on record is a fact,
 * not a severity, so it does not get a colour of its own.
 *
 * Where the candidates came from is on screen too. The search has three
 * sources - the deterministic generators and, when a model is configured, the
 * language-model Proposer - and every candidate carries its `origin`. The
 * panel used to say "nothing here involves a language model", which was true
 * only by accident of deployment. Now it reads the live status before a
 * search and the response's `llm_proposals` after one, and each rationale is
 * labelled with what wrote it.
 *
 * The objectives are on screen before the first search, not only after it.
 * `GET /optimize/objectives` publishes the six criteria, what each measures,
 * which direction is better, its unit and its default weight; the panel reads
 * that on mount, so a reader can see - and change - what a ranking will be
 * scored on before asking for one. After a search the weights the response
 * echoes take over, since those are the ones that actually produced it.
 */

import { useEffect, useState } from "react";
import { Ban, LoaderCircle } from "lucide-react";
import {
  ApiError,
  OptimizeCandidate,
  OptimizeObjectives,
  OptimizeResponse,
  applyScenario,
  optimize,
  optimizeObjectives,
} from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { bandClasses, bandText } from "@/lib/severity";
import { cn } from "@/lib/utils";
import { MethodLabel, RoleAvailability } from "./AiMethod";
import MutationVocabulary from "./MutationVocabulary";
import { ErrorNote, Worked, days } from "./ui";

/** One inline icon size across every panel. */
const ICON = "size-3.5 shrink-0";
const LABEL = "text-[11px] font-medium uppercase tracking-wider text-dim";
/** A constraint id, a generator name: an identifier on record, not a status. */
const TOKEN =
  "rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-[11px]";
/**
 * The whole-field comparison scrolls in its own box.
 *
 * It is one row per candidate, and the budget above it goes to 500 — so the
 * one control on this screen that can make the table enormous is sitting
 * directly above the table. The per-candidate criterion table is not capped:
 * it is six rows, one per criterion, and it is the thing the panel exists to
 * show.
 */
const SCROLL =
  "max-h-[26rem] overflow-y-auto overscroll-contain rounded-md border border-border/60";

/** The server's own bounds on the budget, enforced before the request. */
const BUDGET = {
  candidates: { min: 1, max: 500 },
  seconds: { min: 1, max: 60 },
};

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.round(value)));
}

/**
 * What the search is doing, in the order it does it.
 *
 * The whole search is one request, so the client cannot know which stage the
 * server is in. These advance on a timer that is slower than the search
 * usually is (it finishes in about 250ms on a seeded workflow), so the label
 * never claims to be further along than it could be - it stops on the last
 * one and waits.
 */
const SEARCH_PHASES = [
  "Generating candidate workflows",
  "Checking each against your constraints",
  "Scoring the survivors on six criteria",
  "Ranking them",
];

/** Better, worse, or level, in the three states `severity.ts` owns. */
function deltaTone(improvement: number): string {
  if (improvement === 0) return "text-dim";
  return bandText(improvement > 0 ? "low" : "high");
}

function Head({
  children,
  right,
}: {
  children: React.ReactNode;
  right?: React.ReactNode;
}) {
  return (
    <div className="mb-2 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 border-b border-border pb-1.5">
      <h2 className="text-[13px] font-semibold tracking-tight">{children}</h2>
      {right && <span className="text-[11px] text-dim">{right}</span>}
    </div>
  );
}

/** A figure, its label and the arithmetic under it. Not a tile. */
function Metric({
  label,
  value,
  sub,
  tone,
  lead,
}: {
  label: string;
  value: React.ReactNode;
  sub?: React.ReactNode;
  tone?: string;
  /** The one figure that carries the answer reads larger than its siblings. */
  lead?: boolean;
}) {
  return (
    <div className="min-w-0">
      <div className={LABEL}>{label}</div>
      <div
        className={cn(
          "mt-0.5 leading-tight font-medium",
          lead ? "text-lg" : "text-sm",
          tone,
        )}
      >
        {value}
      </div>
      {sub && <div className="mt-0.5 text-[11px] text-dim">{sub}</div>}
    </div>
  );
}

export default function OptimizePanel({
  projectId,
  onApplied,
}: {
  projectId: string;
  onApplied: () => void;
}) {
  const [result, setResult] = useState<OptimizeResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [phase, setPhase] = useState(0);
  const [error, setError] = useState<ApiError | null>(null);
  const [aggressive, setAggressive] = useState(false);
  const [maxCandidates, setMaxCandidates] = useState(40);
  const [maxSeconds, setMaxSeconds] = useState(5);
  const [weights, setWeights] = useState<Record<string, number> | null>(null);
  const [applying, setApplying] = useState<string | null>(null);
  const [objectives, setObjectives] = useState<OptimizeObjectives | null>(null);
  const [objectivesError, setObjectivesError] = useState<ApiError | null>(null);

  // The criteria and default weights, read once so the ranking's inputs are
  // visible before the first search. A failure is shown, not papered over:
  // the search still runs and echoes whatever weights it used.
  useEffect(() => {
    let live = true;
    optimizeObjectives(projectId)
      .then((o) => {
        if (live) setObjectives(o);
      })
      .catch((e) => {
        if (live && e instanceof ApiError) setObjectivesError(e);
      });
    return () => {
      live = false;
    };
  }, [projectId]);

  // Advance the label while a search is in flight. The reset lives in `run`
  // rather than in this effect's `!busy` branch: setting state synchronously
  // inside an effect body triggers a cascading render (and is what
  // react-hooks/set-state-in-effect flags), while resetting it in the event
  // handler that starts the run puts it in the same batch as `setBusy(true)`
  // and every run still starts from the first label.
  useEffect(() => {
    if (!busy) return;
    const timer = setInterval(
      () => setPhase((p) => Math.min(p + 1, SEARCH_PHASES.length - 1)),
      700,
    );
    return () => clearInterval(timer);
  }, [busy]);

  async function run(withAggressive = aggressive) {
    setPhase(0);
    setBusy(true);
    setError(null);
    try {
      // Clamped here rather than on every keystroke: `min`/`max` on a number
      // input are advisory, and clearing the field makes `Number("")` zero -
      // which is a budget of nothing, refused by the server with a message
      // about a field the user was only in the middle of retyping. Clamping
      // at the request keeps the field editable and the request valid.
      const response = await optimize(projectId, {
        aggressive: withAggressive,
        budget: {
          max_candidates: clamp(
            maxCandidates,
            BUDGET.candidates.min,
            BUDGET.candidates.max,
          ),
          max_seconds: clamp(maxSeconds, BUDGET.seconds.min, BUDGET.seconds.max),
        },
        objectives: weights ?? undefined,
      });
      setResult(response);
      setWeights(response.weights);
    } catch (e) {
      if (e instanceof ApiError) setError(e);
      else throw e;
    } finally {
      setBusy(false);
    }
  }

  async function apply(candidate: OptimizeCandidate) {
    if (!candidate.scenario_id) return;
    setApplying(candidate.scenario_id);
    setError(null);
    try {
      await applyScenario(
        candidate.scenario_id,
        `Applied from optimizer: ${candidate.name}`,
      );
      setResult(null);
      onApplied();
    } catch (e) {
      if (e instanceof ApiError) setError(e);
      else throw e;
    } finally {
      setApplying(null);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      {/* ------------------------------------------------------- the search */}
      <section>
        <Head
          right={
            result
              ? `${result.generated} generated · ${result.evaluated} evaluated · ${result.rejected.length} refused · ${result.elapsed_seconds}s`
              : undefined
          }
        >
          Search for a better workflow
        </Head>
        <p className="mb-1.5 max-w-3xl text-sm text-dim">
          Every candidate is a real list of typed changes, scored by the same
          engine that produced the numbers you have already seen. Candidates
          come from the deterministic generators and, when a model is
          configured, from a language-model proposer whose suggestions pass
          the same validation, constraint gates and scoring.
        </p>
        <p className="mb-3 max-w-3xl">
          {result?.llm_proposals ? (
            <span className="text-xs text-dim">
              This search:{" "}
              {result.llm_proposals.available
                ? `${result.llm_proposals.count} candidate${
                    result.llm_proposals.count === 1 ? "" : "s"
                  } proposed by the model, the rest by the generators.`
                : "every candidate came from the deterministic generators; the model proposer did not take part."}{" "}
              {result.llm_proposals.note}
            </span>
          ) : (
            <RoleAvailability role="proposer" />
          )}
        </p>

        <div className="flex flex-wrap items-end gap-x-4 gap-y-3">
          {/* The budget fields share one row so their inputs sit on one
              baseline; the hint below belongs to both of them. */}
          <label className="flex w-32 flex-col gap-1">
            <span className={LABEL}>Max candidates</span>
            <Input
              type="number"
              min={BUDGET.candidates.min}
              max={BUDGET.candidates.max}
              value={maxCandidates}
              onChange={(e) => setMaxCandidates(Number(e.target.value))}
            />
          </label>
          <label className="flex w-28 flex-col gap-1">
            <span className={LABEL}>Max seconds</span>
            <Input
              type="number"
              min={BUDGET.seconds.min}
              max={BUDGET.seconds.max}
              value={maxSeconds}
              onChange={(e) => setMaxSeconds(Number(e.target.value))}
            />
          </label>
          {/* Native checkbox: the walkthrough drives the first
              role=checkbox on this surface. */}
          <label className="flex items-start gap-2 pb-0.5 text-sm">
            <input
              type="checkbox"
              checked={aggressive}
              onChange={(e) => setAggressive(e.target.checked)}
              className="mt-0.5 accent-primary"
            />
            <span>
              No limits
              <span className="block text-[11px] text-dim">
                also propose cutting scope
              </span>
            </span>
          </label>
          <Button onClick={() => run()} disabled={busy}>
            {result ? "Search again" : "Find better workflows"}
          </Button>
          {busy && (
            <span className="inline-flex items-center gap-1.5 pb-1.5 text-xs text-dim">
              <LoaderCircle className={cn(ICON, "animate-spin")} aria-hidden />
              {SEARCH_PHASES[phase]}…
            </span>
          )}
          {result && (
            <span className="pb-1">
              <Badge
                variant="outline"
                className={cn(
                  "font-normal",
                  bandClasses(result.stopped_early ? "moderate" : "low"),
                )}
              >
                {result.stopped_early ? result.stop_reason : "search completed"}
              </Badge>
            </span>
          )}
        </div>
        <p className="mt-1.5 text-[11px] text-dim">
          the search is never unbounded
        </p>
      </section>

      {error && (
        <ErrorNote hint={error.hint} requestId={error.requestId}>
          {error.userMessage}
        </ErrorNote>
      )}

      {/* -------------------------------------- what it scores on, up front */}
      {!result && (
        <ObjectivesSection
          objectives={objectives}
          objectivesError={objectivesError}
          weights={weights}
          onWeights={setWeights}
          onReset={() => setWeights(null)}
        />
      )}

      {result && (
        <>
          {/* --------------------------------------------------- refusals */}
          {result.rejected.length > 0 && (
            <section>
              <Head right={`${result.rejected.length} on record`}>
                Refused — and this is the point
              </Head>
              <p className="mb-3 max-w-3xl text-xs text-dim">
                These candidates were generated and then declined before they
                were scored, because they break something you declared
                inviolable.
              </p>
              <div className="flex flex-col divide-y divide-border/60">
                {result.rejected.map((candidate, i) => (
                  <div key={i} className="flex flex-col gap-1 py-2 first:pt-0">
                    <h3 className="flex items-center gap-1.5 text-sm font-semibold tracking-tight">
                      <Ban className={cn(ICON, "text-dim")} aria-hidden />
                      {candidate.name}
                    </h3>
                    {candidate.constraint_violations.map((v, j) => (
                      <div key={j} className="text-xs">
                        <p className="max-w-3xl">{v.reason}</p>
                        {v.constraint && (
                          <div className="mt-1 flex flex-col gap-1 border-l-2 border-border pl-2.5">
                            <span className={cn(TOKEN, "w-fit")}>
                              {v.constraint}
                            </span>
                            <p className="max-w-2xl text-dim">
                              {v.constraint_reason}
                            </p>
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            </section>
          )}

          {/* ------------------------------------------------ the winner */}
          {result.recommended ? (
            <>
              <section>
                <div className="mb-2 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 border-b border-border pb-1.5">
                  <h2 className="text-base font-semibold tracking-tight">
                    {result.recommended.name}
                  </h2>
                  <Badge
                    variant="outline"
                    className={cn("font-normal", bandClasses("low"))}
                  >
                    recommended
                  </Badge>
                </div>
                <p className="mb-3 max-w-3xl text-sm">
                  {result.recommendation_reason}
                </p>
                <CandidateBody
                  candidate={result.recommended}
                  onApply={() => apply(result.recommended!)}
                  applying={applying === result.recommended.scenario_id}
                />
              </section>

              {result.recommended_same_scope &&
                result.recommended_same_scope.name !==
                  result.recommended.name && (
                  <section>
                    <div className="mb-2 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 border-b border-border pb-1.5">
                      <h2 className="text-base font-semibold tracking-tight">
                        {result.recommended_same_scope.name}
                      </h2>
                      <Badge variant="outline" className="font-normal">
                        same scope
                      </Badge>
                    </div>
                    <p className="mb-3 max-w-3xl text-xs text-dim">
                      {result.recommended_same_scope_note}
                    </p>
                    <CandidateBody
                      candidate={result.recommended_same_scope}
                      onApply={() => apply(result.recommended_same_scope!)}
                      applying={
                        applying === result.recommended_same_scope.scenario_id
                      }
                    />
                  </section>
                )}
            </>
          ) : (
            <section>
              <Head>No candidate improved on what you have</Head>
              <p className="max-w-3xl text-sm text-dim">
                {result.recommendation_reason}
              </p>
            </section>
          )}

          {/* --------------------------------------------- the whole field */}
          {result.candidates.length > 1 && (
            <section>
              <Head right={`weights total ${result.weights_total.toFixed(2)}`}>
                Current vs every candidate
              </Head>
              <ComparisonTable result={result} />
            </section>
          )}

          {/* ------------------------------------------------- the weights */}
          <ObjectivesSection
            objectives={objectives}
            objectivesError={objectivesError}
            weights={weights ?? result.weights}
            usedNote={result.note}
            onWeights={setWeights}
            onReset={() => setWeights(objectives?.weights ?? result.weights)}
            onRerank={() => run()}
            busy={busy}
          />
        </>
      )}
    </div>
  );
}

/* --------------------------------------------------------- one candidate */

function CandidateBody({
  candidate,
  onApply,
  applying,
}: {
  candidate: OptimizeCandidate;
  onApply: () => void;
  applying: boolean;
}) {
  const completion = candidate.scores?.criteria.find(
    (c) => c.name === "expected_completion",
  );
  return (
    <div>
      <div className="mb-3 flex max-w-3xl flex-wrap items-baseline gap-x-2 gap-y-1">
        <p className="text-sm">{candidate.rationale}</p>
        {/* Who wrote this rationale: the generator's template or a model.
            `origin` is the backend's provenance field on the candidate. */}
        <MethodLabel role="proposer" method={candidate.origin} />
      </div>

      <div className="mb-3 flex flex-wrap items-start gap-x-8 gap-y-3 border-y border-border py-2.5">
        <Metric
          lead
          label="expected completion"
          value={
            completion
              ? `day ${Math.round(completion.before)} → day ${Math.round(completion.after)}`
              : "—"
          }
          sub={completion ? days(completion.delta, true) : undefined}
          tone={completion ? deltaTone(completion.improvement) : undefined}
        />
        <Metric
          label="Ranking total"
          value={candidate.scores?.total.toFixed(3) ?? "—"}
          sub="a ranking aid, not a measurement"
        />
        <Metric
          label="Scope"
          value={candidate.scope_change ? "changes" : "unchanged"}
          sub={
            candidate.scope_change
              ? `${days(candidate.effort_delta_days, true)} of work`
              : "same work, arranged differently"
          }
          tone={bandText(candidate.scope_change ? "moderate" : "low")}
        />
        <Metric
          label="Typed changes"
          value={candidate.mutations.length}
          sub={candidate.generator.replace(/_/g, " ")}
        />
      </div>

      {candidate.scope_change_note && (
        <p className={cn("mb-3 max-w-3xl text-xs", bandText("moderate"))}>
          {candidate.scope_change_note}
        </p>
      )}

      <div className="mb-3">
        <div className="mb-1 text-[11px] text-dim">The exact changes:</div>
        <div className={cn(SCROLL, "max-w-3xl px-2.5 py-1.5")}>
          <ol className="flex flex-col gap-0.5 font-mono text-[11px]">
            {candidate.mutation_summary.map((m, i) => (
              <li key={i} className="flex gap-2">
                <span className="w-4 shrink-0 text-right text-dim">{i + 1}</span>
                <span className="min-w-0">{m}</span>
              </li>
            ))}
          </ol>
        </div>
        <MutationVocabulary
          className="mt-1.5"
          highlight={candidate.mutations.map((m) => m.kind)}
        />
      </div>

      {candidate.scores && (
        <>
          <Table className="min-w-[600px] text-xs">
            <TableHeader>
              <TableRow className="border-border hover:bg-transparent">
                <TableHead className={cn("h-7 px-2", LABEL)}>
                  Criterion
                </TableHead>
                <TableHead className={cn("h-7 w-16 px-2 text-right", LABEL)}>
                  Before
                </TableHead>
                <TableHead className={cn("h-7 w-16 px-2 text-right", LABEL)}>
                  After
                </TableHead>
                <TableHead className={cn("h-7 w-16 px-2 text-right", LABEL)}>
                  Delta
                </TableHead>
                <TableHead className={cn("h-7 w-14 px-2 text-right", LABEL)}>
                  Weight
                </TableHead>
                <TableHead className={cn("h-7 w-20 px-2 text-right", LABEL)}>
                  Contrib.
                </TableHead>
                <TableHead className={cn("h-7 px-2", LABEL)}>Unit</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {candidate.scores.criteria.map((c) => (
                <TableRow
                  key={c.name}
                  data-state={c.improvement !== 0 ? "selected" : undefined}
                  className="border-border/50"
                >
                  <TableCell
                    className={cn(
                      "px-2 py-1",
                      c.improvement === 0 && "text-dim",
                    )}
                  >
                    {c.name.replace(/_/g, " ")}
                  </TableCell>
                  <TableCell className="px-2 py-1 text-right text-dim">
                    {c.before.toFixed(2)}
                  </TableCell>
                  <TableCell
                    className={cn(
                      "px-2 py-1 text-right",
                      c.improvement !== 0 ? "font-medium" : "text-dim",
                    )}
                  >
                    {c.after.toFixed(2)}
                  </TableCell>
                  <TableCell
                    className={cn(
                      "px-2 py-1 text-right",
                      deltaTone(c.improvement),
                    )}
                  >
                    {c.delta > 0 ? "+" : ""}
                    {c.delta.toFixed(2)}
                  </TableCell>
                  <TableCell className="px-2 py-1 text-right text-dim">
                    {c.weight.toFixed(2)}
                  </TableCell>
                  <TableCell className="px-2 py-1 text-right">
                    {c.contribution >= 0 ? "+" : ""}
                    {c.contribution.toFixed(3)}
                  </TableCell>
                  <TableCell className="px-2 py-1 text-dim">{c.unit}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <p className="mt-1.5 max-w-3xl text-[11px] text-dim">
            <Worked>{candidate.scores.formula}</Worked> {candidate.scores.note}
          </p>
        </>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-border pt-3">
        <Button onClick={onApply} disabled={applying}>
          {applying ? "Applying…" : "Apply this"}
        </Button>
        <span className="text-xs text-dim">
          Creates a new version. The current one stays in history, unchanged.
        </span>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------- objectives */

/**
 * The criteria and their weights - before a search, the defaults the
 * optimizer publishes; after one, the weights the response echoed.
 *
 * Every row says what the criterion measures, which way is better and in
 * what unit, so "expected_completion 0.35" reads as a sentence rather than a
 * bare number. The weights are editable in both states.
 */
function ObjectivesSection({
  objectives,
  objectivesError,
  weights,
  usedNote,
  onWeights,
  onReset,
  onRerank,
  busy,
}: {
  objectives: OptimizeObjectives | null;
  objectivesError: ApiError | null;
  /** The weights on screen; null means "the published defaults". */
  weights: Record<string, number> | null;
  /** The response's own note about its weights, after a search. */
  usedNote?: string;
  onWeights: (next: Record<string, number>) => void;
  onReset: () => void;
  onRerank?: () => void;
  busy?: boolean;
}) {
  const shown = weights ?? objectives?.weights ?? null;
  const total = shown
    ? Object.values(shown).reduce((a, b) => a + b, 0)
    : null;
  const describe = (name: string) =>
    objectives?.criteria.find((c) => c.name === name);

  return (
    <section>
      <Head right={total !== null ? `weights total ${total.toFixed(2)}` : undefined}>
        {usedNote ? "The weights that produced this ranking" : "What a ranking will be scored on"}
      </Head>

      {objectivesError && (
        <div className="mb-2">
          <ErrorNote hint={objectivesError.hint} requestId={objectivesError.requestId}>
            The optimizer&apos;s criteria could not be read. {objectivesError.userMessage}{" "}
            A search still echoes the weights it used, so the ranking is
            readable after the fact.
          </ErrorNote>
        </div>
      )}
      {!objectives && !objectivesError && !shown && (
        <p className="text-xs text-dim">Reading the optimizer&apos;s criteria…</p>
      )}

      {shown && (
        <div className="flex flex-col divide-y divide-border/60 border-y border-border/60">
          {Object.entries(shown).map(([name, value]) => {
            const c = describe(name);
            return (
              <div
                key={name}
                className="flex flex-wrap items-center gap-x-4 gap-y-1 py-1.5"
              >
                <label className="flex w-24 shrink-0 flex-col gap-0.5">
                  <span className="sr-only">{name.replace(/_/g, " ")} weight</span>
                  <Input
                    type="number"
                    min={0}
                    max={1}
                    step={0.01}
                    value={value}
                    className="h-7"
                    onChange={(e) =>
                      onWeights({ ...shown, [name]: Number(e.target.value) })
                    }
                  />
                </label>
                <span className="w-44 shrink-0 text-[13px] font-medium">
                  {name.replace(/_/g, " ")}
                </span>
                {c ? (
                  <span className="min-w-0 flex-1 text-xs text-dim">
                    {c.describes} · {c.better} is better · {c.unit}
                  </span>
                ) : (
                  <span className="min-w-0 flex-1 text-xs text-dim">
                    not described by the objectives endpoint
                  </span>
                )}
              </div>
            );
          })}
        </div>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        {onRerank && (
          <Button variant="secondary" onClick={onRerank} disabled={busy}>
            Re-rank with these weights
          </Button>
        )}
        <Button variant="ghost" onClick={onReset} disabled={busy}>
          Reset to the published defaults
        </Button>
        {!onRerank && shown && (
          <span className="text-xs text-dim">
            Edited weights are sent with the next search.
          </span>
        )}
      </div>
      <p className="mt-2 max-w-3xl text-[11px] text-dim">
        {usedNote ?? objectives?.note}
      </p>
    </section>
  );
}

/* ------------------------------------------------------ the whole field */

function ComparisonTable({ result }: { result: OptimizeResponse }) {
  // The header comes from whichever candidate actually carries scores, not
  // from the first one: an unscored candidate at the head of the list left
  // the table with no column headings while every row below it had cells.
  const criteria =
    result.candidates.find((c) => c.scores)?.scores?.criteria ?? [];
  return (
    <div>
      <div className={SCROLL}>
      <Table className="min-w-[760px] text-xs">
        <TableHeader>
          <TableRow className="border-border hover:bg-transparent">
            <TableHead className={cn("h-9 px-2 align-bottom", LABEL)}>
              Option
            </TableHead>
            {criteria.map((c) => (
              <TableHead
                key={c.name}
                className={cn("h-9 px-2 text-right align-bottom", LABEL)}
              >
                {c.name.replace(/_/g, " ")}
                <span className="block text-[9px] font-normal normal-case">
                  {c.better} is better
                </span>
              </TableHead>
            ))}
            <TableHead className={cn("h-9 px-2 text-right align-bottom", LABEL)}>
              Total
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          <TableRow className="border-border bg-muted/60">
            <TableCell className="px-2 py-1.5 font-medium">
              Current workflow
            </TableCell>
            {criteria.map((c) => (
              <TableCell key={c.name} className="px-2 py-1.5 text-right">
                {c.before.toFixed(2)}
              </TableCell>
            ))}
            <TableCell className="px-2 py-1.5 text-right text-dim">—</TableCell>
          </TableRow>
          {result.candidates.map((candidate) => (
            <TableRow key={candidate.name} className="border-border/50">
              <TableCell className="px-2 py-1.5 whitespace-normal">
                <span className="mr-1.5">{candidate.name}</span>
                {candidate.scope_change && (
                  <Badge
                    variant="outline"
                    className={cn("font-normal", bandClasses("moderate"))}
                    title="Changes how much work there is"
                  >
                    scope
                  </Badge>
                )}
              </TableCell>
              {candidate.scores?.criteria.map((c) => (
                <TableCell
                  key={c.name}
                  className={cn("px-2 py-1.5 text-right", deltaTone(c.improvement))}
                >
                  {c.after.toFixed(2)}
                </TableCell>
              ))}
              <TableCell className="px-2 py-1.5 text-right font-semibold">
                {candidate.scores?.total.toFixed(3)}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      </div>
      <p className="mt-2 max-w-3xl text-[11px] text-dim">
        <span className="font-medium text-foreground">
          Why the total is not the answer.
        </span>{" "}
        {result.candidates[0]?.scores?.note} Read across a row, not down the
        Total column: a candidate can win on completion and lose on resource
        overload, and which of those you care about is not something the
        optimizer can know.
      </p>
    </div>
  );
}
