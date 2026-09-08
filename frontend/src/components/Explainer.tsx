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
 *
 * Both of those, and the note saying this text cannot introduce a number,
 * are unconditional: there is no disclosure to open and no card to close.
 * The narration reads as a quoted aside off a rule, not as a boxed panel.
 */

import { useState } from "react";
import { ApiError, Narration, explain } from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ErrorNote } from "./ui";

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
    <div className="flex flex-col gap-2">
      {!narration && (
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" onClick={run} disabled={busy}>
            {busy ? "Writing…" : "Say this in plain language"}
          </Button>
          <span className="text-xs text-muted-foreground">
            Rewords the analysis above. It cannot change a number.
          </span>
        </div>
      )}

      {error && (
        <ErrorNote onRetry={run} hint={error.hint} requestId={error.requestId}>
          <p>{error.userMessage}</p>
        </ErrorNote>
      )}

      {narration && (
        <div className="flex flex-col gap-2 border-l-2 border-border pl-3">
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
            <h3 className="text-sm font-semibold">
              {narration.headline || "In plain language"}
            </h3>
            <Badge
              variant={byModel ? "secondary" : "outline"}
              className="ml-auto"
            >
              {byModel ? "rephrased by model" : "engine wording"}
            </Badge>
            <Button size="xs" variant="ghost" onClick={run} disabled={busy}>
              {busy ? "…" : "Again"}
            </Button>
          </div>

          <p className="max-w-4xl whitespace-pre-line text-[13px] leading-relaxed">
            {narration.explanation}
          </p>

          {narration.rejected_reason && (
            <div className="border-l-2 border-severity-medium bg-severity-medium/5 py-1.5 pl-2.5 text-xs">
              <p className="font-medium">A model narration was discarded.</p>
              <p className="text-muted-foreground">
                {narration.rejected_reason}
              </p>
              <p className="text-muted-foreground">
                You are reading the engine&apos;s own wording instead.
              </p>
            </div>
          )}

          {narration.numbers_checked.length > 0 && (
            <p className="text-xs text-muted-foreground">
              Numbers checked against the engine output:{" "}
              <span className="font-mono">
                {narration.numbers_checked.join(", ")}
              </span>
            </p>
          )}

          <p className="text-xs text-muted-foreground">{narration.note}</p>
        </div>
      )}
    </div>
  );
}
