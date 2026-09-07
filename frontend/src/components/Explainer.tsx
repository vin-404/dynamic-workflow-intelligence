"use client";

/**
 * "Say that in plain language."
 *
 * Presentation only, and labelled as such. Two things are deliberately on
 * screen rather than hidden:
 *
 * - **The method.** "Rephrased by model" or "engine wording" - the user knows
 *   which they are reading.
 * - **A discarded narration.** If the model wrote a number the engine did not
 *   produce, the backend throws the prose away and returns the engine's own
 *   wording with the reason. Showing that is the point: it is the guarantee
 *   working, not an error.
 */

import { useState } from "react";
import { ApiError, Narration, explain } from "@/lib/api";
import { Badge, Button, Card, CardTitle, ErrorNote } from "./ui";

export default function Explainer({ projectId }: { projectId: string }) {
  const [narration, setNarration] = useState<Narration | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);

  async function run() {
    setBusy(true);
    setError(null);
    try {
      setNarration(await explain(projectId));
    } catch (e) {
      if (e instanceof ApiError) setError(e);
      else throw e;
    } finally {
      setBusy(false);
    }
  }

  const byModel = narration?.method === "model";

  return (
    <div className="space-y-3">
      {!narration && (
        <div className="flex items-center gap-2">
          <Button onClick={run} disabled={busy}>
            {busy ? "Writing…" : "Say this in plain language"}
          </Button>
          <span className="text-xs text-dim">
            Rewords the analysis above. It cannot change a number.
          </span>
        </div>
      )}

      {error && (
        <ErrorNote onRetry={run}>
          <p>{error.userMessage}</p>
        </ErrorNote>
      )}

      {narration && (
        <Card>
          <CardTitle
            right={
              <div className="flex items-center gap-1.5">
                <Badge tone={byModel ? "accent" : "neutral"}>
                  {byModel ? "rephrased by model" : "engine wording"}
                </Badge>
                <Button onClick={run} disabled={busy}>
                  {busy ? "…" : "Again"}
                </Button>
              </div>
            }
          >
            {narration.headline || "In plain language"}
          </CardTitle>

          <p className="text-sm whitespace-pre-line">{narration.explanation}</p>

          {narration.rejected_reason && (
            <div className="mt-3 rounded border border-amber/40 bg-amber/5 p-2.5 text-xs">
              <div className="font-medium mb-1">
                A model narration was discarded.
              </div>
              <p className="text-dim">{narration.rejected_reason}</p>
              <p className="mt-1 text-dim">
                You are reading the engine&apos;s own wording instead.
              </p>
            </div>
          )}

          {narration.numbers_checked.length > 0 && (
            <p className="mt-3 text-xs text-dim">
              Numbers checked against the engine output:{" "}
              <span className="font-mono">
                {narration.numbers_checked.join(", ")}
              </span>
            </p>
          )}

          <p className="mt-2 text-xs text-dim">{narration.note}</p>
        </Card>
      )}
    </div>
  );
}
