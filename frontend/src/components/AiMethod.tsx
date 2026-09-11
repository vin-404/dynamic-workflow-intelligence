"use client";

/**
 * Which machinery produced an AI-touched result, said where the result is.
 *
 * Three surfaces show something a language model *could* have written: the
 * sentence box (Interpreter), the plain-language narration (Narrator) and the
 * optimizer's candidate rationales (Proposer). Each has a deterministic
 * fallback that runs when no model is configured, and the fallback is a
 * designed behaviour, not an error. The one thing a reader could not do until
 * now was tell which of the two they were looking at - the label lived in a
 * response field nobody rendered, or in a footer.
 *
 * `useAiStatus` fetches `GET /api/ai/status` once per page load and shares
 * it, so three panels on one stage do not make three identical requests.
 * `MethodLabel` is the point-of-use label. It reads the `method` the backend
 * put on *that* response, not the global status, because the two can differ
 * (a model that was up when the status was read and down when the answer was
 * written) and the response is the one that knows what actually happened.
 *
 * Both readings are neutral on purpose: a model is not a badge of quality
 * and the fallback is not an apology. The label is a fact about provenance.
 */

import { useEffect, useState } from "react";
import { AiStatus, aiStatus } from "@/lib/api";
import { cn } from "@/lib/utils";

/** A provenance token: an identifier on record, not a status colour. */
const TOKEN =
  "rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-[12px]";

/** One request per page, shared by every caller. Reset on failure so a
 *  retry is possible rather than a page-long cached rejection. */
let pending: Promise<AiStatus> | null = null;
let settled: AiStatus | null = null;

function fetchOnce(): Promise<AiStatus> {
  if (settled) return Promise.resolve(settled);
  if (!pending) {
    pending = aiStatus()
      .then((s) => {
        settled = s;
        return s;
      })
      .catch((e) => {
        pending = null;
        throw e;
      });
  }
  return pending;
}

/**
 * The AI layer's status, or `null` while loading, with `failed` set when the
 * status endpoint itself could not be reached - which is reported, not
 * treated as "no model", because those are different facts.
 */
export function useAiStatus(): { status: AiStatus | null; failed: boolean } {
  const [status, setStatus] = useState<AiStatus | null>(settled);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let live = true;
    fetchOnce()
      .then((s) => {
        if (live) setStatus(s);
      })
      .catch(() => {
        if (live) setFailed(true);
      });
    return () => {
      live = false;
    };
  }, []);

  return { status, failed };
}

/** The three roles the backend publishes, by the names it uses. */
export type AiRole = "interpreter" | "proposer" | "narrator";

/** Did this response come from a model? The backend's `method` values. */
export function fromModel(method: string | null | undefined): boolean {
  return method === "model" || method === "llm_proposal";
}

/**
 * The provenance of one result, beside that result.
 *
 * `method` is the field the backend put on the response being shown. When it
 * says a model answered, the label names the model. When it says the
 * fallback answered, the label says so and - with the status loaded - what
 * the fallback for this role is and what a model would need. If the status
 * could not be read, the label still says "fallback", because that is what
 * the response said; it just cannot add the why.
 */
export function MethodLabel({
  role,
  method,
  className,
}: {
  role: AiRole;
  method: string | null | undefined;
  className?: string;
}) {
  const { status } = useAiStatus();
  const model = fromModel(method);

  if (model) {
    return (
      <span
        className={cn(TOKEN, "text-dim", className)}
        title={`This output was written by a language model${
          status?.model ? ` (${status.model})` : ""
        } and validated against the engine before it was shown.`}
      >
        from model{status?.model ? ` · ${status.model}` : ""}
      </span>
    );
  }

  const fallback = status?.degraded_behaviour?.[role];
  const needs = status?.needs;
  const title = [
    "This output came from the deterministic fallback, not a language model.",
    fallback ? `Fallback for the ${role}: ${fallback}` : null,
    needs ? `A model would need: ${needs}` : null,
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <span className={cn(TOKEN, "text-dim", className)} title={title}>
      deterministic fallback · no model configured
    </span>
  );
}

/**
 * The same fact for a surface that has not produced a result yet - the
 * optimizer before a search, say - so a reader knows before pressing the
 * button whether a model will take part. Reads the live status; says so when
 * that status could not be read rather than assuming either answer.
 */
export function RoleAvailability({ role }: { role: AiRole }) {
  const { status, failed } = useAiStatus();
  if (failed) {
    return (
      <span className="text-xs text-severity-medium">
        Could not read the AI layer&apos;s status, so whether a model takes
        part here is unknown.
      </span>
    );
  }
  if (!status) {
    return <span className="text-xs text-dim">Checking the AI layer…</span>;
  }
  if (status.available) {
    return (
      <span className="text-xs text-dim">
        Model {status.model} is configured for the {role}.
      </span>
    );
  }
  return (
    <span className="text-xs text-dim">
      No model is configured. The {role} runs its deterministic fallback:{" "}
      {status.degraded_behaviour[role]}
      {status.needs ? ` A model would need: ${status.needs}` : ""}
    </span>
  );
}
