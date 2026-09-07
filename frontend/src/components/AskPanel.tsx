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
 */

import { useEffect, useState } from "react";
import {
  AiStatus,
  ApiError,
  Interpretation,
  SimulationResponse,
  Workflow,
  aiStatus,
  evaluateScenario,
  interpret,
} from "@/lib/api";
import DiffView from "./DiffView";
import {
  Badge,
  Button,
  Card,
  CardTitle,
  Disclose,
  ErrorNote,
  Input,
  Spinner,
  Tone,
} from "./ui";

/** Phrasings the deterministic matcher handles, so the box is never a guessing
 *  game about what it accepts. */
const EXAMPLES = [
  "T03 slips 5 days",
  "Anitha is unavailable from day 14 to day 21",
  "split T14 across 3 people",
];

function methodLabel(method: string): { text: string; tone: Tone } {
  return method === "model"
    ? { text: "interpreted by model", tone: "accent" }
    : { text: "matched by pattern (no model configured)", tone: "neutral" };
}

export default function AskPanel({ workflow }: { workflow: Workflow }) {
  const [utterance, setUtterance] = useState("");
  const [status, setStatus] = useState<AiStatus | null>(null);
  const [result, setResult] = useState<Interpretation | null>(null);
  const [simulation, setSimulation] = useState<SimulationResponse | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);
  const [simulating, setSimulating] = useState(false);

  useEffect(() => {
    aiStatus().then(setStatus).catch(() => setStatus(null));
  }, []);

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

  const method = result ? methodLabel(result.method) : null;

  return (
    <div className="space-y-4">
      <Card>
        <CardTitle
          right={
            status && (
              <Badge
                tone={status.available ? "accent" : "neutral"}
                title={
                  status.available
                    ? `Model: ${status.model}`
                    : "Every capability works without a model; this box uses a pattern matcher."
                }
              >
                {status.available ? status.model : "no model configured"}
              </Badge>
            )
          }
        >
          Ask in your own words
        </CardTitle>

        <div className="flex gap-2">
          <div className="flex-1">
            <Input
              value={utterance}
              onChange={(e) => setUtterance(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") ask(utterance);
              }}
              placeholder="e.g. Anitha is unavailable from day 14 to day 21"
              aria-label="Describe a change in your own words"
            />
          </div>
          <Button onClick={() => ask(utterance)} disabled={busy || !utterance.trim()}>
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
              className="px-1.5 py-0.5 rounded border border-line hover:border-accent"
            >
              {e}
            </button>
          ))}
        </div>

        <p className="mt-3 text-xs text-dim">
          This turns a sentence into typed changes and shows you them. It never
          edits your workflow — you see what it understood first, and applying
          is a separate step.
        </p>
      </Card>

      {error && (
        <ErrorNote>
          <p>{error.userMessage}</p>
          {error.constraint && (
            <p className="mt-2 text-xs">
              <Badge tone="violet">{error.constraint.constraint}</Badge>{" "}
              <span className="text-dim">
                {error.constraint.constraint_reason}
              </span>
            </p>
          )}
        </ErrorNote>
      )}

      {result && (
        <Card>
          <CardTitle
            right={
              <div className="flex items-center gap-1.5">
                {method && <Badge tone={method.tone}>{method.text}</Badge>}
                <Badge tone={result.applied ? "red" : "green"}>
                  {result.applied ? "applied" : "nothing applied"}
                </Badge>
              </div>
            }
          >
            {result.understood ? "What it understood" : "It did not understand"}
          </CardTitle>

          {result.understood ? (
            <>
              <p className="text-sm mb-3">{result.intent}</p>
              <div className="text-xs text-dim mb-1">
                As typed changes from the closed set:
              </div>
              <ol className="space-y-1 mb-3">
                {result.mutations.map((m, i) => (
                  <li
                    key={i}
                    className="text-xs font-mono bg-panel2 border border-line rounded px-2 py-1"
                  >
                    <span className="text-accent">{m.kind}</span>{" "}
                    {JSON.stringify(m.payload)}
                  </li>
                ))}
              </ol>
            </>
          ) : (
            <p className="text-sm mb-3">
              {result.clarification_needed ||
                "That is not a change this system can express."}
            </p>
          )}

          {result.unsupported.length > 0 && (
            <div className="mb-3 text-xs">
              <div className="text-dim mb-1">It could not express:</div>
              <ul className="list-disc list-inside space-y-0.5">
                {result.unsupported.map((u, i) => (
                  <li key={i}>{u}</li>
                ))}
              </ul>
            </div>
          )}

          {/* Understood, but the workflow refuses it. The refusal is the
              answer, so it gets the constraint and the reason on record. */}
          {result.understood && !result.validation.valid && (
            <div className="rounded border border-red/40 bg-red/5 p-2.5 text-sm">
              <div className="font-medium mb-1">
                The workflow refuses this change.
              </div>
              <ul className="space-y-1.5">
                {result.validation.rejections.map((r, i) => (
                  <li key={i}>
                    <div>{r.reason}</div>
                    {r.constraint && (
                      <div className="text-xs text-dim mt-0.5">
                        <Badge tone="red">{r.constraint}</Badge>{" "}
                        {r.constraint_reason}
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {result.scenario_id && (
            <div className="mt-3 pt-3 border-t border-line flex items-center gap-2">
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

          <div className="mt-3">
            <Disclose summary="Why you are being shown the typed changes">
              <p className="text-xs text-dim">
                The sentence is only used to pick changes from a closed set the
                engine already validates. Nothing that fails validation is
                stored, and the model never writes to your workflow — so a
                misreading costs you a rejected suggestion, not a plan.
              </p>
            </Disclose>
          </div>
        </Card>
      )}

      {simulating && <Spinner label="Evaluating the scenario" />}
      {simulation && <DiffView result={simulation} />}
    </div>
  );
}
