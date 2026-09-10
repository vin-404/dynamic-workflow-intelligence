"use client";

/**
 * "Say that in plain language."
 *
 * Presentation only, and labelled as such. Two things are deliberately on
 * screen rather than hidden:
 *
 * - **The method.** "From model" or "deterministic fallback - no model
 *   configured" - the user knows which they are reading, and the label's
 *   tooltip says what the fallback is and what a model would need. It reads
 *   the `method` on *this* narration, not a global flag.
 * - **A discarded narration.** If the model wrote a number the engine did not
 *   produce, the backend throws the prose away and returns the engine's own
 *   wording with the reason. Showing that is the point: it is the guarantee
 *   working, not an error.
 *
 * Both of those, and the note saying this text cannot introduce a number,
 * are unconditional: there is no disclosure to open and no card to close.
 * The narration reads as a quoted aside off a rule, not as a boxed panel.
 *
 * So is the third: **which numbers were checked**. That line used to appear
 * only when the list was non-empty, which meant the guarantee was invisible
 * in exactly the case where it had nothing to report - and "no numbers were
 * checked" and "the check did not run" looked identical on screen. It is
 * unconditional now, and says `none` in words.
 *
 * Phase 11 added a real probability to this product, on the forecast stage.
 * This component gained nothing from it. It narrates the deterministic
 * analysis of the stage it is mounted on; it is never handed a forecast
 * number and has no numeric claim of its own, and the scope line beside the
 * button says so rather than leaving a reader to assume the reach of a
 * "plain language" button.
 */

import { useState } from "react";
import { ApiError, Narration, explain } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { MethodLabel } from "./AiMethod";
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

  return (
    <div className="flex flex-col gap-2">
      {!narration && (
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" onClick={run} disabled={busy}>
            {busy ? "Writing…" : "Say this in plain language"}
          </Button>
          <span className="text-xs text-muted-foreground">
            Rewords the findings and the schedule above. It cannot change a
            number, and it is never given the forecast&apos;s.
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
            <MethodLabel
              role="narrator"
              method={narration.method}
              className="ml-auto"
            />
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

          {/* Unconditional: "none" is a result, not an absence of one. */}
          <p className="text-xs text-muted-foreground">
            Numbers checked against the engine output:{" "}
            {narration.numbers_checked.length > 0 ? (
              <span className="font-mono">
                {narration.numbers_checked.join(", ")}
              </span>
            ) : (
              <span>none — this wording states no figure of its own</span>
            )}
          </p>

          <p className="text-xs text-muted-foreground">{narration.note}</p>
        </div>
      )}
    </div>
  );
}
