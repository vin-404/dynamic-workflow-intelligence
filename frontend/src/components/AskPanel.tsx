"use client";

/**
 * Ask in your own words.
 *
 * This is the only place natural language enters the product, and the panel
 * is built to make the boundary visible rather than to hide it:
 *
 * - What it understood is shown as **typed mutations**, before anything runs.
 *   The user reads the interpretation and can reject it.
 * - Nothing is applied. The interpretation becomes a pending scenario; the
 *   user chooses to simulate it, and applying is a separate act elsewhere.
 * - Where it understood the shape but the workflow refuses it, the constraint
 *   and the reason on record are shown - the refusal is the answer.
 * - The method is labelled. With no model configured, a deterministic pattern
 *   matcher handles the same phrasings and says so, rather than pretending.
 *
 * Nothing on this surface is dressed as intelligence. There is no sparkle, no
 * "AI" badge, and the reserved accent is spent on neither the method label nor
 * the mutation kinds: a sentence being read by a regex is not an achievement
 * to advertise, and neither is one being read by a model.
 *
 * Presentation (design brief §4, "What if"): the input comes first, and the
 * provider state is a muted line *beneath* it rather than a badge beside it.
 * The interpreter's exact payloads are still on the page, behind a disclosure,
 * so the sentence the reader sees is the display map's and the record is one
 * click away.
 */

import { useState } from "react";
import { ChevronRight, LoaderCircle } from "lucide-react";
import {
  ApiError,
  Interpretation,
  SimulationResponse,
  Workflow,
  evaluateScenario,
  interpret,
} from "@/lib/api";
import { MethodLabel, useAiStatus } from "./AiMethod";
import MutationVocabulary from "./MutationVocabulary";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { bandClasses } from "@/lib/severity";
import { cn } from "@/lib/utils";
import {
  constraintKindLabel,
  describeMutation,
  mutationKindLabel,
} from "@/lib/display";
import DiffView from "./DiffView";
import { ErrorNote } from "./ui";

/** One inline icon size across every panel. */
const ICON = "size-3.5 shrink-0";
/** A constraint's kind, named through the display map: a chip, not a token. */
const CHIP =
  "rounded border border-line bg-panel2 px-1.5 py-0.5 text-[12px] text-foreground";
/** The one disclosure style on this stage: a link in the accent, no marker. */
const SUMMARY =
  "inline-flex cursor-pointer list-none items-center gap-1 text-[12px] text-accent " +
  "marker:content-none hover:underline [&::-webkit-details-marker]:hidden";

/** Phrasings the deterministic matcher handles, so the box is never a guessing
 *  game about what it accepts. */
const EXAMPLES = [
  "T03 slips 5 days",
  "Anitha is unavailable from day 14 to day 21",
  "split T14 across 3 people",
];

/**
 * Which interpreter will read the sentence, said under the box in one muted
 * line. Reads the live status; when the status itself cannot be read that is
 * reported as its own fact rather than assumed to mean "no model".
 */
function ProviderLine() {
  const { status, failed } = useAiStatus();
  if (failed) {
    return (
      <p className="text-[12px] text-severity-medium">
        Could not read the AI layer&apos;s status, so which interpreter reads
        this is unknown.
      </p>
    );
  }
  if (!status) {
    return (
      <p className="text-[12px] text-dim">Checking which interpreter reads this…</p>
    );
  }
  if (status.available) {
    return (
      <p className="text-[12px] text-dim" title={`Model: ${status.model}`}>
        Interpreting with the model {status.model}
      </p>
    );
  }
  return (
    <p
      className="text-[12px] text-dim"
      title={`Every capability works without a model; this box uses a pattern matcher. ${status.degraded_behaviour.interpreter}${status.needs ? ` A model would need: ${status.needs}` : ""}`}
    >
      Interpreting with the built-in pattern matcher — no model configured
    </p>
  );
}

export default function AskPanel({
  workflow,
  onScenarioCreated,
}: {
  workflow: Workflow;
  /** Fired when an interpretation was kept as a pending scenario. */
  onScenarioCreated?: () => void;
}) {
  const [utterance, setUtterance] = useState("");
  const [result, setResult] = useState<Interpretation | null>(null);
  const [simulation, setSimulation] = useState<SimulationResponse | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);
  const [simulating, setSimulating] = useState(false);

  async function ask(text: string) {
    const trimmed = text.trim();
    if (!trimmed) return;
    setBusy(true);
    setError(null);
    setResult(null);
    setSimulation(null);
    try {
      const interpretation = await interpret(workflow.project_id, trimmed);
      setResult(interpretation);
      if (interpretation.scenario_id) {
        try {
          onScenarioCreated?.();
        } catch {
          /* The list's refresh is not this panel's correctness. */
        }
      }
    } catch (e) {
      if (e instanceof ApiError) setError(e);
      else throw e;
    } finally {
      setBusy(false);
    }
  }

  async function simulate(scenarioId: string) {
    setSimulating(true);
    setError(null);
    try {
      setSimulation(await evaluateScenario(scenarioId));
    } catch (e) {
      if (e instanceof ApiError) setError(e);
      else throw e;
    } finally {
      setSimulating(false);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <section className="flex flex-col gap-3">
        <h2 className="text-[18px] font-semibold">Ask in your own words</h2>

        <div>
          <div className="flex flex-wrap gap-2">
            <Input
              value={utterance}
              onChange={(e) => setUtterance(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") ask(utterance);
              }}
              placeholder="e.g. Anitha is unavailable from day 14 to day 21"
              aria-label="Describe a change in your own words"
              className="max-w-xl text-[14px]"
            />
            <Button
              variant="secondary"
              onClick={() => ask(utterance)}
              disabled={busy || !utterance.trim()}
            >
              {busy ? "Reading…" : "Interpret"}
            </Button>
          </div>
          <div className="mt-1.5">
            <ProviderLine />
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-1.5 text-[12px] text-dim">
          <span>Try:</span>
          {EXAMPLES.map((e) => (
            <button
              key={e}
              type="button"
              onClick={() => {
                setUtterance(e);
                ask(e);
              }}
              className="rounded border border-line px-1.5 py-0.5 text-[12px] transition-colors hover:bg-panel2 hover:text-foreground"
            >
              {e}
            </button>
          ))}
        </div>

        {/* The panel's one caveat, always visible. */}
        <p className="max-w-2xl text-[14px] text-dim">
          This turns a sentence into typed changes and shows you them. It never
          edits your workflow — you see what it understood first, and applying
          is a separate step.
        </p>
      </section>

      {error && (
        <ErrorNote hint={error.hint} requestId={error.requestId}>
          <p>{error.userMessage}</p>
          {error.constraint && (
            <p className="mt-2 flex flex-wrap items-baseline gap-x-2 text-[12px]">
              <span className={CHIP}>
                {constraintKindLabel(error.constraint.constraint)}
              </span>
              <span className="text-dim">
                {error.constraint.constraint_reason}
              </span>
            </p>
          )}
        </ErrorNote>
      )}

      {result && (
        <section className="flex flex-col gap-3">
          <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
            <h2 className="text-[18px] font-semibold">
              {result.understood ? "What it understood" : "It did not understand"}
            </h2>
            <span className="flex flex-wrap items-center gap-1.5">
              <MethodLabel role="interpreter" method={result.method} />
              <Badge
                variant="outline"
                className={cn(
                  "font-normal",
                  bandClasses(result.applied ? "high" : "low"),
                )}
              >
                {result.applied ? "applied" : "nothing applied"}
              </Badge>
            </span>
          </div>

          {result.understood ? (
            <>
              <p className="max-w-3xl text-[14px]">{result.intent}</p>
              <div>
                {/* Sentences keep their sentence case; small caps are for
                    column heads, not for claims. */}
                <div className="mb-1.5 text-[12px] text-dim">
                  As typed changes from the closed set:
                </div>
                <ol className="flex max-w-3xl flex-col divide-y divide-line border-y border-line">
                  {result.mutations.map((m, i) => (
                    <li
                      key={i}
                      className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 py-1.5 text-[14px]"
                    >
                      <span className="w-4 shrink-0 text-right text-[12px] text-dim">
                        {i + 1}
                      </span>
                      <span className="min-w-0 flex-1 font-medium">
                        {describeMutation(m)}
                      </span>
                      <span className="text-[12px] text-dim">
                        {mutationKindLabel(m.kind)}
                      </span>
                    </li>
                  ))}
                </ol>
                {/* The interpreter's exact record - the fields it filled in -
                    relocated from the row to a disclosure. */}
                <details className="group mt-2">
                  <summary className={SUMMARY}>
                    <ChevronRight
                      className={cn(ICON, "transition-transform group-open:rotate-90")}
                      aria-hidden
                    />
                    The exact changes, as recorded
                  </summary>
                  <ol className="mt-1.5 flex flex-col items-start gap-1 pl-4">
                    {result.mutations.map((m, i) => (
                      <li
                        key={i}
                        className="max-w-full rounded border border-line bg-panel2 px-2 py-1 font-mono text-[12px] break-all text-dim"
                      >
                        {JSON.stringify(m.payload)}
                      </li>
                    ))}
                  </ol>
                </details>
              </div>
              <MutationVocabulary
                highlight={result.mutations.map((m) => m.kind)}
              />
            </>
          ) : (
            <p className="max-w-3xl text-[14px]">
              {result.clarification_needed ||
                "That is not a change this system can express."}
            </p>
          )}

          {result.unsupported.length > 0 && (
            <div>
              <div className="mb-1 text-[12px] text-dim">It could not express:</div>
              <ul className="flex flex-col gap-0.5 text-[14px] text-dim">
                {result.unsupported.map((u, i) => (
                  <li key={i}>{u}</li>
                ))}
              </ul>
            </div>
          )}

          {/* Understood, but the workflow refuses it. The refusal is the
              answer, so it gets the constraint and the reason on record. */}
          {result.understood && !result.validation.valid && (
            <div className="rounded-xl border border-critical/30 bg-critical/5 p-3 text-[14px]">
              <div className="mb-1 font-medium text-critical">
                The workflow refuses this change.
              </div>
              <ul className="flex flex-col gap-1.5">
                {result.validation.rejections.map((r, i) => (
                  <li key={i}>
                    <div>{r.reason}</div>
                    {r.constraint && (
                      <div className="mt-1 flex flex-wrap items-baseline gap-x-2 text-[12px]">
                        <span className={CHIP}>
                          {constraintKindLabel(r.constraint)}
                        </span>
                        <span className="text-dim">{r.constraint_reason}</span>
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {result.scenario_id && (
            <div className="flex flex-wrap items-center gap-2 border-t border-line pt-3">
              <Button
                onClick={() => simulate(result.scenario_id as string)}
                disabled={simulating}
              >
                {simulating ? "Running…" : "Simulate this"}
              </Button>
              <span className="text-[12px] text-dim">
                Saved as a pending scenario. Your workflow is untouched until
                you apply it.
              </span>
            </div>
          )}

          <details className="group">
            <summary className={SUMMARY}>
              <ChevronRight
                className={cn(ICON, "transition-transform group-open:rotate-90")}
                aria-hidden
              />
              Why you are being shown the typed changes
            </summary>
            <p className="mt-1.5 max-w-2xl pl-4 text-[14px] text-dim">
              The sentence is only used to pick changes from a closed set the
              engine already validates. Nothing that fails validation is
              stored, and the model never writes to your workflow — so a
              misreading costs you a rejected suggestion, not a plan.
            </p>
          </details>
        </section>
      )}

      {simulating && (
        <div className="flex items-center gap-1.5 text-[12px] text-dim">
          <LoaderCircle className={cn(ICON, "animate-spin")} aria-hidden />
          Evaluating the scenario
        </div>
      )}
      {simulation && <DiffView result={simulation} />}
    </div>
  );
}
