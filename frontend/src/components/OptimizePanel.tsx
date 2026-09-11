"use client";

/**
 * Capability 4 - propose and evaluate better workflows.
 *
 * The per-criterion table is the result. The blended total is shown as a
 * ranking aid and labelled as one, because a single number with invisible
 * weights is the thing this design is written against - so the weights are on
 * screen and adjustable.
 *
 * Refused candidates are shown, not hidden. A system that declines to delete
 * the safety certification and cites the reason on record is worth more than
 * one that reports a miraculous improvement. The constraint kind and the
 * human-written reason are quoted verbatim, in neutral ink: a constraint on
 * record is a fact, not a severity, so it does not get a colour of its own.
 *
 * Where the candidates came from is on screen too. The search has three
 * sources - the deterministic generators and, when a model is configured, the
 * language-model Proposer - and every candidate carries its `origin`. The
 * panel reads the live status before a search and the response's
 * `llm_proposals` after one, and each rationale is labelled with what wrote it.
 *
 * The objectives are on screen before the first search, not only after it.
 * `GET /optimize/objectives` publishes the six criteria, what each measures,
 * which direction is better, its unit and its default weight; the panel reads
 * that on mount, so a reader can see - and change - what a ranking will be
 * scored on before asking for one. After a search the weights the response
 * echoes take over, since those are the ones that actually produced it.
 *
 * Design brief §4, "Better workflows": the weights table sits above the
 * results; each candidate is a card ranked by score with the total as its one
 * headline figure, the changes in words, a "Verified by the engine" chip for
 * what the engine actually evaluated, and the effect on the finish day. The
 * per-criterion table, the engine's own change list, the whole-field
 * comparison and the longer notes are one click away, verbatim. The refused
 * group is collapsed, with the constraint on record that refused it always
 * visible beside the summary.
 */

import { useEffect, useState } from "react";
import { LoaderCircle } from "lucide-react";
import {
  ApiError,
  OptimizeCandidate,
  OptimizeObjectives,
  OptimizeResponse,
  applyScenario,
  optimize,
  optimizeObjectives,
} from "@/lib/api";
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
import {
  constraintKindLabel,
  describeMutation,
  generatorLabel,
  objectiveLabel,
} from "@/lib/display";
import { bandClasses, bandText } from "@/lib/severity";
import { cn } from "@/lib/utils";
import { MethodLabel, useAiStatus } from "./AiMethod";
import MutationVocabulary from "./MutationVocabulary";
import { ErrorNote, Worked, days } from "./ui";

/** One inline icon size across every panel. */
const ICON = "size-3.5 shrink-0";
/** The surface every section and card sits on. */
const SURFACE = "rounded-xl border border-line bg-panel p-5";
const TITLE = "text-[18px] font-semibold";
const META = "text-[12px] text-dim";
/** A disclosure's clickable line: accent, with a caret that turns. */
const SUMMARY =
  "flex cursor-pointer list-none items-center gap-1 text-[14px] text-accent marker:content-none hover:underline [&::-webkit-details-marker]:hidden";
const SUMMARY_META =
  "flex cursor-pointer list-none items-center gap-1 text-[12px] text-accent marker:content-none hover:underline [&::-webkit-details-marker]:hidden";
const CHIP =
  "inline-flex items-center rounded-full border px-2 py-0.5 text-[12px] leading-4 whitespace-nowrap";
/** Column headings in the two tables. */
const TH = "h-7 px-2 text-[12px] font-medium text-dim";
/** The whole-field comparison scrolls in its own box: one row per candidate,
 *  and the budget above it goes to 500. */
const SCROLL =
  "max-h-[26rem] overflow-y-auto overscroll-contain rounded-md border border-line";

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

function Caret() {
  return (
    <>
      <span className="inline-block w-3 group-open:hidden">▸</span>
      <span className="hidden w-3 group-open:inline-block">▾</span>
    </>
  );
}

function Head({
  children,
  right,
}: {
  children: React.ReactNode;
  right?: React.ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
      <h2 className={TITLE}>{children}</h2>
      {right && <span className={META}>{right}</span>}
    </div>
  );
}

/**
 * Whether a model will take part in the next search, from the live status.
 *
 * The same facts `RoleAvailability` states, in the same words, laid out to
 * this panel's rule of two visible sentences: what is configured and what
 * runs in its place stay on screen; what a model would need sits one click
 * away, verbatim. Says so when the status could not be read rather than
 * assuming either answer.
 */
function ProposerAvailability() {
  const { status, failed } = useAiStatus();
  if (failed) {
    return (
      <p className={META}>
        Could not read the AI layer&apos;s status, so whether a model takes
        part here is unknown.
      </p>
    );
  }
  if (!status) {
    return <p className={META}>Checking the AI layer…</p>;
  }
  if (status.available) {
    return (
      <p className={META}>Model {status.model} is configured for the proposer.</p>
    );
  }
  return (
    <div className="flex flex-col gap-1">
      <p className={META}>
        No model is configured. The proposer runs its deterministic fallback:{" "}
        {status.degraded_behaviour.proposer}
      </p>
      {status.needs && (
        <details className="group">
          <summary className={SUMMARY_META}>
            <Caret />
            What a model would need
          </summary>
          <p className={cn("mt-1 max-w-2xl pl-4", META)}>
            A model would need: {status.needs}
          </p>
        </details>
      )}
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
      <section data-panel="optimize-search" className={SURFACE}>
        <Head
          right={
            result
              ? `${result.generated} generated · ${result.evaluated} evaluated · ${result.rejected.length} refused · ${result.elapsed_seconds}s`
              : undefined
          }
        >
          Search for a better workflow
        </Head>
        <p className="mt-1 max-w-3xl text-[14px] text-dim">
          Every candidate is a real list of typed changes, scored by the same
          engine that produced the numbers you have already seen. Candidates
          come from the deterministic generators and, when a model is
          configured, from a language-model proposer whose suggestions pass
          the same validation, constraint gates and scoring.
        </p>
        <div className="mt-2 max-w-3xl">
          {result?.llm_proposals ? (
            <div className="flex flex-col gap-1">
              <p className={META}>
                This search:{" "}
                {result.llm_proposals.available
                  ? `${result.llm_proposals.count} candidate${
                      result.llm_proposals.count === 1 ? "" : "s"
                    } proposed by the model, the rest by the generators.`
                  : "every candidate came from the deterministic generators; the model proposer did not take part."}
              </p>
              {result.llm_proposals.note && (
                <details className="group">
                  <summary className={SUMMARY_META}>
                    <Caret />
                    What the model proposer reported
                  </summary>
                  <p className={cn("mt-1 max-w-2xl pl-4", META)}>
                    {result.llm_proposals.note}
                  </p>
                </details>
              )}
            </div>
          ) : (
            <ProposerAvailability />
          )}
        </div>

        <div className="mt-4 flex flex-wrap items-end gap-x-4 gap-y-3">
          {/* The budget fields share one row so their inputs sit on one
              baseline; the hint below belongs to both of them. */}
          <label className="flex w-32 flex-col gap-1">
            <span className={META}>Max candidates</span>
            <Input
              type="number"
              min={BUDGET.candidates.min}
              max={BUDGET.candidates.max}
              value={maxCandidates}
              onChange={(e) => setMaxCandidates(Number(e.target.value))}
            />
          </label>
          <label className="flex w-28 flex-col gap-1">
            <span className={META}>Max seconds</span>
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
          <label className="flex items-start gap-2 pb-0.5 text-[14px]">
            <input
              type="checkbox"
              checked={aggressive}
              onChange={(e) => setAggressive(e.target.checked)}
              className="mt-0.5 accent-primary"
            />
            <span>
              No limits
              <span className={cn("block", META)}>also propose cutting scope</span>
            </span>
          </label>
          <Button onClick={() => run()} disabled={busy}>
            {result ? "Search again" : "Find better workflows"}
          </Button>
          {busy && (
            <span className={cn("inline-flex items-center gap-1.5 pb-1.5", META)}>
              <LoaderCircle className={cn(ICON, "animate-spin")} aria-hidden />
              {SEARCH_PHASES[phase]}…
            </span>
          )}
          {result && (
            <span className="pb-1">
              <span
                className={cn(
                  CHIP,
                  bandClasses(result.stopped_early ? "moderate" : "low"),
                )}
              >
                {result.stopped_early ? result.stop_reason : "search completed"}
              </span>
            </span>
          )}
        </div>
        <p className={cn("mt-2", META)}>the search is never unbounded</p>
      </section>

      {error && (
        <ErrorNote hint={error.hint} requestId={error.requestId}>
          {error.userMessage}
        </ErrorNote>
      )}

      {/* ---------------------------- what it scores on, above the results */}
      <ObjectivesSection
        objectives={objectives}
        objectivesError={objectivesError}
        weights={weights ?? result?.weights ?? null}
        usedNote={result?.note}
        onWeights={setWeights}
        onReset={() =>
          setWeights(
            result ? (objectives?.weights ?? result.weights) : null,
          )
        }
        onRerank={result ? () => run() : undefined}
        busy={busy}
      />

      {result && (
        <>
          {/* --------------------------------------------- the candidates */}
          {result.recommended ? (
            <section data-panel="optimize-candidates" className="flex flex-col gap-4">
              <Head
                right={`${result.candidates.length} scored · weights total ${result.weights_total.toFixed(2)}`}
              >
                Ranked candidates
              </Head>
              {result.candidates.map((candidate, i) => (
                <CandidateCard
                  key={candidate.name}
                  rank={i + 1}
                  candidate={candidate}
                  recommended={candidate.name === result.recommended?.name}
                  recommendationReason={
                    candidate.name === result.recommended?.name
                      ? result.recommendation_reason
                      : undefined
                  }
                  sameScope={
                    candidate.name === result.recommended_same_scope?.name &&
                    candidate.name !== result.recommended?.name
                  }
                  sameScopeNote={result.recommended_same_scope_note}
                  onApply={() => apply(candidate)}
                  applying={applying === candidate.scenario_id}
                />
              ))}

              {result.candidates.length > 1 && (
                <details className={cn("group", SURFACE)}>
                  <summary className={SUMMARY}>
                    <Caret />
                    Compare all {result.candidates.length} candidates across
                    every criterion
                  </summary>
                  <div className="mt-3">
                    <ComparisonTable result={result} />
                  </div>
                </details>
              )}
            </section>
          ) : (
            <section className={SURFACE}>
              <Head>No candidate improved on what you have</Head>
              <p className="mt-1 max-w-3xl text-[14px] text-dim">
                {result.recommendation_reason}
              </p>
            </section>
          )}

          {/* --------------------------------------------------- refusals */}
          {result.rejected.length > 0 && <RefusedGroup rejected={result.rejected} />}
        </>
      )}
    </div>
  );
}

/* --------------------------------------------------------- one candidate */

function CandidateCard({
  rank,
  candidate,
  recommended,
  recommendationReason,
  sameScope,
  sameScopeNote,
  onApply,
  applying,
}: {
  rank: number;
  candidate: OptimizeCandidate;
  recommended: boolean;
  recommendationReason?: string;
  sameScope: boolean;
  sameScopeNote: string;
  onApply: () => void;
  applying: boolean;
}) {
  const completion = candidate.scores?.criteria.find(
    (c) => c.name === "expected_completion",
  );
  const verified = candidate.evaluated && candidate.scores !== null;

  return (
    <article
      data-panel="optimize-candidate"
      className={cn(SURFACE, recommended && "border-accent/40")}
    >
      <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className={META}>#{rank}</span>
            <h3 className={TITLE}>{candidate.name}</h3>
            {recommended && (
              <span className={cn(CHIP, "border-accent/30 bg-accent/10 text-accent")}>
                recommended
              </span>
            )}
            {sameScope && (
              <span className={cn(CHIP, "border-line bg-panel2 text-dim")}>
                same scope
              </span>
            )}
            {verified && (
              <span
                className={cn(
                  CHIP,
                  "border-severity-low/30 bg-severity-low/10 text-severity-low",
                )}
                title="Validated, checked against your constraints and scored by the engine"
              >
                Verified by the engine
              </span>
            )}
            {candidate.scope_change && (
              <span
                className={cn(CHIP, bandClasses("moderate"))}
                title="Changes how much work there is"
              >
                changes scope · {days(candidate.effort_delta_days, true)} of work
              </span>
            )}
          </div>

          {/* The rationale and who wrote it: the generator's template or a
              model. `origin` is the backend's provenance field. */}
          <p className="mt-2 max-w-3xl text-[14px]">
            {candidate.rationale}{" "}
            <MethodLabel role="proposer" method={candidate.origin} />
          </p>

          {/* The effect on the finish day - body, not a second headline. */}
          <p className="mt-2 flex flex-wrap items-baseline gap-x-2 text-[14px]">
            <span className="text-dim">expected completion</span>
            {completion ? (
              <>
                <span className={cn("font-medium", deltaTone(completion.improvement))}>
                  day {Math.round(completion.before)} → day{" "}
                  {Math.round(completion.after)}
                </span>
                <span className={deltaTone(completion.improvement)}>
                  {days(completion.delta, true)}
                </span>
              </>
            ) : (
              <span className="text-dim">—</span>
            )}
          </p>
        </div>

        {/* The card's one headline figure: the blended total, labelled as
            the aid it is, never as the answer. */}
        <div className="shrink-0 text-right">
          <div className="text-[36px] leading-none font-semibold tracking-[-0.02em]">
            {candidate.scores?.total.toFixed(3) ?? "—"}
          </div>
          <div className={cn("mt-1.5", META)}>ranking total</div>
          <div className={META}>a ranking aid, not a measurement</div>
        </div>
      </div>

      {candidate.scope_change_note && (
        <p className={cn("mt-3 max-w-3xl text-[12px]", bandText("moderate"))}>
          {candidate.scope_change_note}
        </p>
      )}

      {/* ------------------------------------------- the changes, in words */}
      <div className="mt-4">
        <div className={META}>
          {candidate.mutations.length}{" "}
          {candidate.mutations.length === 1 ? "change" : "changes"} ·{" "}
          {generatorLabel(candidate.generator)}
        </div>
        <ol className="mt-1 max-h-[12rem] max-w-3xl list-decimal overflow-y-auto overscroll-contain pl-6 text-[14px]">
          {candidate.mutations.map((m, i) => (
            <li key={i} className="py-0.5">
              {describeMutation(m)}
            </li>
          ))}
        </ol>
        {candidate.mutation_summary.length > 0 && (
          <details className="group mt-1.5">
            <summary className={SUMMARY_META}>
              <Caret />
              The exact changes, as the engine recorded them
            </summary>
            <ol className="mt-1 flex max-w-3xl flex-col gap-0.5 pl-4 font-mono text-[12px]">
              {candidate.mutation_summary.map((m, i) => (
                <li key={i} className="flex gap-2">
                  <span className="w-4 shrink-0 text-right text-dim">{i + 1}</span>
                  <span className="min-w-0">{m}</span>
                </li>
              ))}
            </ol>
          </details>
        )}
        <MutationVocabulary
          className="mt-1.5"
          highlight={candidate.mutations.map((m) => m.kind)}
        />
      </div>

      {/* ------------------------------------------------ how it scored */}
      {candidate.scores && (
        <details className="group mt-4">
          <summary className={SUMMARY}>
            <Caret />
            How it scored
          </summary>
          <div className="mt-2 overflow-x-auto">
            <Table className="min-w-[600px] text-[12px]">
              <TableHeader>
                <TableRow className="border-line hover:bg-transparent">
                  <TableHead className={TH}>Criterion</TableHead>
                  <TableHead className={cn(TH, "w-16 text-right")}>Before</TableHead>
                  <TableHead className={cn(TH, "w-16 text-right")}>After</TableHead>
                  <TableHead className={cn(TH, "w-16 text-right")}>Delta</TableHead>
                  <TableHead className={cn(TH, "w-14 text-right")}>Weight</TableHead>
                  <TableHead className={cn(TH, "w-20 text-right")}>Contrib.</TableHead>
                  <TableHead className={TH}>Unit</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {candidate.scores.criteria.map((c) => (
                  <TableRow
                    key={c.name}
                    data-state={c.improvement !== 0 ? "selected" : undefined}
                    className="border-line/50"
                  >
                    <TableCell
                      className={cn("px-2 py-1", c.improvement === 0 && "text-dim")}
                    >
                      {objectiveLabel(c.name)}
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
                      className={cn("px-2 py-1 text-right", deltaTone(c.improvement))}
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
          </div>
          <p className={cn("mt-1.5 max-w-3xl", META)}>
            <Worked>{candidate.scores.formula}</Worked> {candidate.scores.note}
          </p>
        </details>
      )}

      {recommended && recommendationReason && (
        <details className="group mt-2">
          <summary className={SUMMARY}>
            <Caret />
            Why this one is recommended
          </summary>
          <p className="mt-1 max-w-3xl pl-4 text-[14px]">{recommendationReason}</p>
        </details>
      )}

      {sameScope && (
        <details className="group mt-2">
          <summary className={SUMMARY}>
            <Caret />
            What &ldquo;same scope&rdquo; means here
          </summary>
          <p className={cn("mt-1 max-w-3xl pl-4", META)}>{sameScopeNote}</p>
        </details>
      )}

      <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-line pt-3">
        <Button onClick={onApply} disabled={applying}>
          {applying ? "Applying…" : "Apply this"}
        </Button>
        <span className={META}>
          Creates a new version. The current one stays in history, unchanged.
        </span>
      </div>
    </article>
  );
}

/* ------------------------------------------------------------- refusals */

/**
 * The candidates declined before scoring, collapsed, with the constraint on
 * record that refused them always visible beside the summary. A refusal is
 * the point of the constraint layer, so the reason is quoted verbatim, in
 * neutral ink.
 */
function RefusedGroup({ rejected }: { rejected: OptimizeCandidate[] }) {
  // The distinct constraints on record, so the summary line can say what
  // refused the group without opening it.
  const onRecord = new Map<string, string | null>();
  for (const candidate of rejected) {
    for (const v of candidate.constraint_violations) {
      if (v.constraint && !onRecord.has(v.constraint)) {
        onRecord.set(v.constraint, v.constraint_reason);
      }
    }
  }

  return (
    <section data-panel="optimize-refused" className={SURFACE}>
      <details className="group">
        <summary className={SUMMARY}>
          <Caret />
          <span className="text-[18px] font-semibold text-foreground">
            {rejected.length} Refused
          </span>
          <span className="ml-1 text-[14px]">
            {rejected.length === 1 ? "candidate" : "candidates"} — see each one
          </span>
        </summary>

        <p className={cn("mt-3 max-w-3xl", META)}>
          These candidates were generated and then declined before they were
          scored, because they break something you declared inviolable.
        </p>
        <div className="mt-2 flex flex-col divide-y divide-line/60">
          {rejected.map((candidate, i) => (
            <div key={i} className="flex flex-col gap-1.5 py-3 first:pt-0 last:pb-0">
              <h3 className="text-[14px] font-semibold">{candidate.name}</h3>
              {candidate.constraint_violations.map((v, j) => (
                <div key={j} className="text-[14px]">
                  <p className="max-w-3xl">{v.reason}</p>
                  {v.constraint && (
                    <div className="mt-1 flex flex-col gap-0.5 border-l-2 border-line pl-2.5">
                      <span className={cn(CHIP, "w-fit border-line bg-panel2 text-dim")}>
                        {constraintKindLabel(v.constraint)}
                      </span>
                      {v.constraint_reason && (
                        <p className={cn("max-w-2xl", META)}>{v.constraint_reason}</p>
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>
          ))}
        </div>
      </details>

      {/* The one line that stays visible: the constraint(s) on record. */}
      {onRecord.size > 0 && (
        <ul className="mt-2 flex flex-col gap-0.5">
          {[...onRecord.entries()].map(([constraint, reason]) => (
            <li key={constraint} className="flex flex-wrap items-baseline gap-x-2 text-[14px]">
              <span className="text-dim">Refused by</span>
              <span className="font-medium">{constraintKindLabel(constraint)}</span>
              {reason && <span className="text-dim">— {reason}</span>}
            </li>
          ))}
        </ul>
      )}
    </section>
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
    <section data-panel="optimize-objectives" className={SURFACE}>
      <Head right={total !== null ? `weights total ${total.toFixed(2)}` : undefined}>
        {usedNote ? "The weights that produced this ranking" : "What a ranking will be scored on"}
      </Head>
      <p className={cn("mt-1 max-w-3xl text-[14px] text-dim")}>
        {usedNote ?? objectives?.note}
      </p>

      {objectivesError && (
        <div className="mt-3">
          <ErrorNote hint={objectivesError.hint} requestId={objectivesError.requestId}>
            The optimizer&apos;s criteria could not be read. {objectivesError.userMessage}{" "}
            A search still echoes the weights it used, so the ranking is
            readable after the fact.
          </ErrorNote>
        </div>
      )}
      {!objectives && !objectivesError && !shown && (
        <p className={cn("mt-3", META)}>Reading the optimizer&apos;s criteria…</p>
      )}

      {shown && (
        <div className="mt-3 overflow-x-auto">
          <Table className="min-w-[640px] text-[14px]">
            <TableHeader>
              <TableRow className="border-line hover:bg-transparent">
                <TableHead className={cn(TH, "w-24")}>Weight</TableHead>
                <TableHead className={cn(TH, "w-48")}>Criterion</TableHead>
                <TableHead className={TH}>Measures</TableHead>
                <TableHead className={cn(TH, "w-32")}>Better</TableHead>
                <TableHead className={cn(TH, "w-40")}>Unit</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {Object.entries(shown).map(([name, value]) => {
                const c = describe(name);
                return (
                  <TableRow key={name} className="border-line/50 hover:bg-transparent">
                    <TableCell className="px-2 py-1.5">
                      <label className="flex flex-col">
                        <span className="sr-only">{objectiveLabel(name)} weight</span>
                        <Input
                          type="number"
                          min={0}
                          max={1}
                          step={0.01}
                          value={value}
                          className="h-7 w-20"
                          onChange={(e) =>
                            onWeights({ ...shown, [name]: Number(e.target.value) })
                          }
                        />
                      </label>
                    </TableCell>
                    <TableCell className="px-2 py-1.5 font-medium whitespace-normal">
                      {objectiveLabel(name)}
                    </TableCell>
                    {c ? (
                      <>
                        <TableCell className="px-2 py-1.5 whitespace-normal text-dim">
                          {c.describes}
                        </TableCell>
                        <TableCell className="px-2 py-1.5 whitespace-normal text-dim">
                          {c.better} is better
                        </TableCell>
                        <TableCell className="px-2 py-1.5 whitespace-normal text-dim">
                          {c.unit}
                        </TableCell>
                      </>
                    ) : (
                      <TableCell colSpan={3} className="px-2 py-1.5 whitespace-normal text-dim">
                        not described by the objectives endpoint
                      </TableCell>
                    )}
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
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
          <span className={META}>Edited weights are sent with the next search.</span>
        )}
      </div>
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
        <Table className="min-w-[760px] text-[12px]">
          <TableHeader>
            <TableRow className="border-line hover:bg-transparent">
              <TableHead className={cn(TH, "h-10 align-bottom")}>Option</TableHead>
              {criteria.map((c) => (
                <TableHead
                  key={c.name}
                  className={cn(TH, "h-10 text-right align-bottom whitespace-normal")}
                >
                  {objectiveLabel(c.name)}
                  <span className="block font-normal">{c.better} is better</span>
                </TableHead>
              ))}
              <TableHead className={cn(TH, "h-10 text-right align-bottom")}>Total</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            <TableRow className="border-line bg-panel2/60">
              <TableCell className="px-2 py-1.5 font-medium">Current workflow</TableCell>
              {criteria.map((c) => (
                <TableCell key={c.name} className="px-2 py-1.5 text-right">
                  {c.before.toFixed(2)}
                </TableCell>
              ))}
              <TableCell className="px-2 py-1.5 text-right text-dim">—</TableCell>
            </TableRow>
            {result.candidates.map((candidate) => (
              <TableRow key={candidate.name} className="border-line/50">
                <TableCell className="px-2 py-1.5 whitespace-normal">
                  <span className="mr-1.5">{candidate.name}</span>
                  {candidate.scope_change && (
                    <span
                      className={cn(CHIP, bandClasses("moderate"))}
                      title="Changes how much work there is"
                    >
                      scope
                    </span>
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
      <p className={cn("mt-2 max-w-3xl", META)}>
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
