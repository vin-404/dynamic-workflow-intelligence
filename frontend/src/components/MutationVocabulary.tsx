"use client";

/**
 * The closed algebra of change, wherever a change is authored or read.
 *
 * Every hypothetical, every optimizer candidate and every interpreted
 * sentence is a list of typed mutations drawn from one closed set the backend
 * publishes at `GET /api/scenarios/mutation-kinds`. That closure is why a
 * proposal can be validated before it runs and why a model cannot ask for
 * "restructure the project". It was invisible: the kinds appeared as tokens
 * on results with nothing saying they came from a finite, published list.
 *
 * `useMutationKinds` reads the list once per page and shares it (the same
 * shape as `useAiStatus`). `MutationVocabulary` is a disclosure that names
 * the count and, opened, lists each kind with its required and optional
 * payload fields - from the response, never from a table kept here. If the
 * endpoint cannot be read the disclosure says so; it does not fall back to a
 * hardcoded list that would then be the thing that rots.
 */

import { useEffect, useState } from "react";
import { ChevronRight } from "lucide-react";
import { MutationKindSpec, mutationKinds } from "@/lib/api";
import { cn } from "@/lib/utils";
import { humanize, mutationKindLabel } from "@/lib/display";

type Vocabulary = { closed: boolean; note: string; kinds: MutationKindSpec[] };

const ICON = "size-3.5 shrink-0";
/** A kind, named through the display map: a chip, not an engine token. */
const CHIP = "rounded border border-line bg-panel2 px-1.5 py-0.5 text-[12px]";
/** The one disclosure style on this stage: a link in the accent, no marker. */
const SUMMARY =
  "inline-flex cursor-pointer list-none items-center gap-1 text-[12px] text-accent " +
  "marker:content-none hover:underline [&::-webkit-details-marker]:hidden";

/** Payload field names as words, lower-case so they read on from "optional". */
function fieldWords(fields: string[]): string {
  return fields.map((f) => humanize(f).toLowerCase()).join(", ");
}

let pending: Promise<Vocabulary> | null = null;
let settled: Vocabulary | null = null;

function fetchOnce(): Promise<Vocabulary> {
  if (settled) return Promise.resolve(settled);
  if (!pending) {
    pending = mutationKinds()
      .then((v) => {
        settled = v;
        return v;
      })
      .catch((e) => {
        pending = null;
        throw e;
      });
  }
  return pending;
}

export function useMutationKinds(): {
  vocabulary: Vocabulary | null;
  failed: boolean;
} {
  const [vocabulary, setVocabulary] = useState<Vocabulary | null>(settled);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let live = true;
    fetchOnce()
      .then((v) => {
        if (live) setVocabulary(v);
      })
      .catch(() => {
        if (live) setFailed(true);
      });
    return () => {
      live = false;
    };
  }, []);

  return { vocabulary, failed };
}

/**
 * A one-line disclosure naming the closed set, with the full list behind it.
 *
 * `highlight` marks the kinds present in whatever the reader is looking at,
 * so a result's tokens can be traced back to the vocabulary they came from.
 */
export default function MutationVocabulary({
  highlight = [],
  className,
}: {
  highlight?: string[];
  className?: string;
}) {
  const { vocabulary, failed } = useMutationKinds();
  const marked = new Set(highlight);

  if (failed) {
    return (
      <p className={cn("text-[12px] text-severity-medium", className)}>
        The list of change kinds could not be read from the API, so it is not
        shown here. Every change is still validated against it on the server.
      </p>
    );
  }
  if (!vocabulary) {
    return (
      <p className={cn("text-[12px] text-dim", className)}>
        Reading the closed set of change kinds…
      </p>
    );
  }

  return (
    <details className={cn("group", className)}>
      <summary className={SUMMARY}>
        <ChevronRight
          className={cn(ICON, "transition-transform group-open:rotate-90")}
          aria-hidden
        />
        {vocabulary.closed ? "A closed set of " : ""}
        {vocabulary.kinds.length} kinds of change this system can express
        {marked.size > 0 ? ` · ${marked.size} used here` : ""}
      </summary>
      <div className="mt-1.5 pl-4">
        <p className="mb-1.5 max-w-2xl text-[12px] text-dim">{vocabulary.note}</p>
        <ul className="grid grid-cols-1 gap-x-6 gap-y-1 sm:grid-cols-2">
          {vocabulary.kinds.map((k) => (
            <li
              key={k.kind}
              className="flex flex-wrap items-baseline gap-x-1.5 text-[12px]"
            >
              <span
                className={cn(
                  CHIP,
                  marked.has(k.kind) ? "text-foreground" : "text-dim",
                )}
                title={k.kind}
              >
                {mutationKindLabel(k.kind)}
              </span>
              <span className="text-dim">
                {k.required.length > 0 ? fieldWords(k.required) : "no fields"}
                {k.optional.length > 0 && (
                  <span className="opacity-70">
                    {" "}
                    · optional {fieldWords(k.optional)}
                  </span>
                )}
              </span>
            </li>
          ))}
        </ul>
      </div>
    </details>
  );
}
