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
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { bandClasses, severityText } from "@/lib/severity";
import { cn } from "@/lib/utils";
import DiffView from "./DiffView";
import { ErrorNote } from "./ui";

/** One inline icon size across every panel. */
const ICON = "size-3.5 shrink-0";
/** A constraint id, a mutation kind: an identifier on record, not a status. */
const TOKEN =
  "rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-[11px]";

/** Phrasings the deterministic matcher handles, so the box is never a guessing
 *  game about what it accepts. */
const EXAMPLES = [
  "T03 slips 5 days",
  "Anitha is unavailable from day 14 to day 21",
  "split T14 across 3 people",
];

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
      {right}
    </div>
  );
}

export default function AskPanel({ workflow }: { workflow: Workflow }) {
  const [utterance, setUtterance] = useState("");
  // Shared with every other AI-touched panel on the page: one request.
  const { status, failed: statusFailed } = useAiStatus();
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
      setResult(await interpret(workflow.project_id, trimmed));
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
      <section>
        <Head
          right={
            status ? (
              <span
                className={cn(TOKEN, "text-dim")}
                title={
                  status.available
                    ? `Model: ${status.model}`
                    : `Every capability works without a model; this box uses a pattern matcher. ${status.degraded_behaviour.interpreter}${status.needs ? ` A model would need: ${status.needs}` : ""}`
                }
              >
                {status.available ? status.model : "no model configured"}
              </span>
            ) : statusFailed ? (
              <span className="text-[11px] text-severity-medium">
                AI status unreadable
              </span>
            ) : null
          }
        >
          Ask in your own words
        </Head>

        <div className="flex gap-2">
          <Input
            value={utterance}
            onChange={(e) => setUtterance(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") ask(utterance);
            }}
            placeholder="e.g. Anitha is unavailable from day 14 to day 21"
            aria-label="Describe a change in your own words"
            className="max-w-xl"
          />
          <Button
            variant="secondary"
            onClick={() => ask(utterance)}
            disabled={busy || !utterance.trim()}
          >
            {busy ? "Reading…" : "Interpret"}
          </Button>
        </div>

        <div className="mt-2 flex flex-wrap items-center gap-1.5 text-xs text-dim">
          <span>Try:</span>
          {EXAMPLES.map((e) => (
            <button
              key={e}
              onClick={() => {
                setUtterance(e);
                ask(e);
              }}
              className="rounded border border-border px-1.5 py-0.5 font-mono text-[11px] transition-colors hover:bg-muted hover:text-foreground"
            >
              {e}
            </button>
          ))}
        </div>

        <p className="mt-3 max-w-2xl text-xs text-dim">
          This turns a sentence into typed changes and shows you them. It never
          edits your workflow — you see what it understood first, and applying
          is a separate step.
        </p>
      </section>

      {error && (
        <ErrorNote hint={error.hint} requestId={error.requestId}>
          <p>{error.userMessage}</p>
          {error.constraint && (
            <p className="mt-2 flex flex-wrap items-baseline gap-x-2 text-xs">
              <span className={TOKEN}>{error.constraint.constraint}</span>
              <span className="text-dim">
                {error.constraint.constraint_reason}
              </span>
            </p>
          )}
        </ErrorNote>
      )}

      {result && (
        <section>
          <Head
            right={
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
            }
          >
            {result.understood ? "What it understood" : "It did not understand"}
          </Head>

          {result.understood ? (
            <>
              <p className="mb-3 max-w-3xl text-sm">{result.intent}</p>
              {/* Sentences keep their sentence case; small caps are for
                  column heads, not for claims. */}
              <div className="mb-1.5 text-[11px] text-dim">
                As typed changes from the closed set:
              </div>
              <ol className="mb-3 flex flex-col items-start gap-1">
                {result.mutations.map((m, i) => (
                  <li
                    key={i}
                    className="max-w-full rounded border border-border bg-muted px-2 py-1 font-mono text-[11px] break-all"
                  >
                    <span className="font-medium">{m.kind}</span>{" "}
                    <span className="text-dim">
                      {JSON.stringify(m.payload)}
                    </span>
                  </li>
                ))}
              </ol>
            </>
          ) : (
            <p className="mb-3 max-w-3xl text-sm">
              {result.clarification_needed ||
                "That is not a change this system can express."}
            </p>
          )}

          {result.unsupported.length > 0 && (
            <div className="mb-3 text-xs">
              <div className="mb-1 text-[11px] text-dim">
                It could not express:
              </div>
              <ul className="flex flex-col gap-0.5">
                {result.unsupported.map((u, i) => (
                  <li key={i} className="text-dim">
                    {u}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Understood, but the workflow refuses it. The refusal is the
              answer, so it gets the constraint and the reason on record. */}
          {result.understood && !result.validation.valid && (
            <div className="rounded-md border border-severity-high/30 bg-severity-high/5 p-2.5 text-sm">
              <div className={cn("mb-1 font-medium", severityText("high"))}>
                The workflow refuses this change.
              </div>
              <ul className="flex flex-col gap-1.5">
                {result.validation.rejections.map((r, i) => (
                  <li key={i}>
                    <div>{r.reason}</div>
                    {r.constraint && (
                      <div className="mt-1 flex flex-wrap items-baseline gap-x-2 text-xs">
                        <span className={TOKEN}>{r.constraint}</span>
                        <span className="text-dim">{r.constraint_reason}</span>
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {result.scenario_id && (
            <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-border pt-3">
              <Button
                onClick={() => simulate(result.scenario_id as string)}
                disabled={simulating}
              >
                {simulating ? "Running…" : "Simulate this"}
              </Button>
              <span className="text-xs text-dim">
                Saved as a pending scenario. Your workflow is untouched until
                you apply it.
              </span>
            </div>
          )}

          <details className="group mt-3">
            <summary className="inline-flex cursor-pointer list-none items-center gap-1 text-[11px] text-dim hover:text-foreground [&::-webkit-details-marker]:hidden">
              <ChevronRight
                className={cn(ICON, "transition-transform group-open:rotate-90")}
                aria-hidden
              />
              Why you are being shown the typed changes
            </summary>
            <p className="mt-1.5 max-w-2xl pl-4 text-xs text-dim">
              The sentence is only used to pick changes from a closed set the
              engine already validates. Nothing that fails validation is
              stored, and the model never writes to your workflow — so a
              misreading costs you a rejected suggestion, not a plan.
            </p>
          </details>
        </section>
      )}

      {simulating && (
        <div className="flex items-center gap-1.5 text-xs text-dim">
          <LoaderCircle className={cn(ICON, "animate-spin")} aria-hidden />
          Evaluating the scenario
        </div>
      )}
      {simulation && <DiffView result={simulation} />}
    </div>
  );
}
