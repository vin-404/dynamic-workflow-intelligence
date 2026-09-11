"use client";

/**
 * What this build can and cannot do right now.
 *
 * The product's central claim is that it reports what it cannot assess
 * instead of showing a confident empty dashboard. This is the one place that
 * claim is made for the build as a whole rather than for a single number:
 * each capability, whether it is available on this deployment for this
 * workflow, and - when it is not - the specific thing it needs.
 *
 * Nothing here is a hardcoded list. Every row is read from a live response:
 *
 *   - `GET /api/ai/status`                       the three model roles, their
 *                                                fallbacks, what a model needs
 *   - `POST /api/projects/{id}/analyze`          which detector tiers ran and
 *                                                which could not, with why
 *   - `GET /api/projects/{id}/forecast/assumptions`  what the forecast rests
 *                                                on and what would calibrate it
 *   - `GET /api/users/{me}/projects`             whether roles are enforced
 *                                                or advisory on this instance
 *
 * A source that cannot be reached is shown as exactly that - "could not be
 * determined" with the error - rather than as "available" or as an empty
 * section. An unknown is a third state and it is drawn as one.
 *
 * Presentation (design brief §4): grouped by capability; each row is
 * name · status chip · one line, with anything longer behind a "Why"
 * disclosure that carries the API's text verbatim. The endpoint each group
 * was read from is kept, so the claim can be checked, but sits inside the
 * group's own disclosure rather than in a heading.
 *
 * The panel is per workflow, because the evidence tier is: the same build
 * reaches tier 2 on a project with an event log and tier 0 on a fresh one.
 */

import { ReactNode, useCallback, useEffect, useState } from "react";
import { LoaderCircle } from "lucide-react";
import {
  Analysis,
  ApiError,
  ForecastAssumptions,
  Person,
  UserProjects,
  analyze,
  getForecastAssumptions,
  userProjects,
} from "@/lib/api";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { findingKindLabel, humanize, providerLabel, roleLabel, tierLabel } from "@/lib/display";
import { cn } from "@/lib/utils";
import { useAiStatus } from "./AiMethod";

/* ------------------------------------------------------------- helpers */

/**
 * The lead of a passage: up to the first sentence end or the first colon,
 * whichever comes first. This is a cut, never a rewrite - the full text is
 * always offered verbatim behind the row's disclosure when there is more.
 */
function lead(text: string | null | undefined): string {
  if (!text) return "";
  const m = text.match(/^[^:]*?(?:[.!?](?=\s|$)|(?=:))/);
  const cut = m ? m[0].trim() : text.trim();
  return cut.length > 0 ? cut : text.trim();
}

/** Whether `lead()` left anything out, i.e. whether a "Why" is worth opening. */
function hasMore(text: string | null | undefined): boolean {
  if (!text) return false;
  return lead(text).length < text.trim().length;
}

/**
 * One entry of a withheld tier's `checks` list. The API writes it as
 * "kind: what it would find", so the kind goes through the display map and
 * the description stays as written.
 */
function checkLabel(entry: string): string {
  const at = entry.indexOf(":");
  if (at < 0) return findingKindLabel(entry);
  return `${findingKindLabel(entry.slice(0, at))}: ${entry.slice(at + 1).trim()}`;
}

/* ----------------------------------------------------------- primitives */

/** available: true / false / null-for-unknown. Three states, three chips. */
function Chip({ available }: { available: boolean | null }) {
  const tone =
    available === true
      ? "border-severity-low/30 bg-severity-low/10 text-severity-low"
      : available === false
        ? "border-line bg-panel2 text-dim"
        : "border-severity-medium/30 bg-severity-medium/10 text-severity-medium";
  const word =
    available === true
      ? "available"
      : available === false
        ? "not available"
        : "could not determine";
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center rounded-md border px-2 py-0.5 text-[12px] font-medium leading-5",
        tone,
      )}
    >
      {word}
    </span>
  );
}

/** A 12px "Why ▸" disclosure. Its body is where verbatim API text lives. */
function Why({
  label = "Why",
  children,
}: {
  label?: string;
  children: ReactNode;
}) {
  return (
    <details className="group mt-1">
      <summary className="inline-flex cursor-pointer list-none items-center gap-1 text-[12px] text-dim hover:text-foreground [&::-webkit-details-marker]:hidden">
        {label}
        <span aria-hidden className="group-open:hidden">
          ▸
        </span>
        <span aria-hidden className="hidden group-open:inline">
          ▾
        </span>
      </summary>
      <div className="mt-1.5 flex flex-col gap-1.5 border-l-2 border-line pl-3 text-[12px] text-dim">
        {children}
      </div>
    </details>
  );
}

/**
 * One capability: name · chip · one line. Anything longer goes in `why`.
 * `note` is a dim suffix on the name (the role's job, the active provider).
 */
function Row({
  name,
  note,
  available,
  line,
  why,
  children,
}: {
  name: ReactNode;
  note?: ReactNode;
  available: boolean | null;
  /** What runs, what it needs, or why it could not be read. One line. */
  line: ReactNode;
  /** The full text behind the line, verbatim from the API. */
  why?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <li className="py-2.5">
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
        <span className="text-[14px] font-medium text-foreground">
          {name}
          {note && <span className="font-normal text-dim"> · {note}</span>}
        </span>
        <Chip available={available} />
      </div>
      <p className="mt-1 text-[14px] text-foreground/85">{line}</p>
      {why && <Why>{why}</Why>}
      {children}
    </li>
  );
}

function Group({
  title,
  source,
  children,
}: {
  title: string;
  /** The endpoint this group was read from, so the claim can be checked. */
  source: string;
  children: ReactNode;
}) {
  return (
    <section>
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 border-b border-line pb-1.5">
        <h3 className="text-[18px] font-semibold tracking-tight">{title}</h3>
        <details className="group">
          <summary className="inline-flex cursor-pointer list-none items-center gap-1 text-[12px] text-dim hover:text-foreground [&::-webkit-details-marker]:hidden">
            Where this was read
            <span aria-hidden className="group-open:hidden">
              ▸
            </span>
            <span aria-hidden className="hidden group-open:inline">
              ▾
            </span>
          </summary>
          <p className="mt-1 text-[12px] text-dim">
            Read live from{" "}
            <span className="rounded border border-line bg-panel2 px-1.5 py-0.5 font-mono">
              {source}
            </span>
          </p>
        </details>
      </div>
      {children}
    </section>
  );
}

function Loading({ what }: { what: string }) {
  return (
    <p className="flex items-center gap-1.5 py-2.5 text-[12px] text-dim">
      <LoaderCircle className="size-3.5 shrink-0 animate-spin" aria-hidden />
      Reading {what}…
    </p>
  );
}

/**
 * A source that did not answer. Drawn as the third state, "could not
 * determine", never as "available" and never as an empty section.
 */
function Unreachable({
  name,
  what,
  error,
  onRetry,
}: {
  /** The row's name: the thing that could not be read. */
  name: string;
  /** Completes "Could not determine …". */
  what: string;
  error: ApiError | string;
  onRetry?: () => void;
}) {
  const message = error instanceof ApiError ? error.userMessage : String(error);
  const hint = error instanceof ApiError ? error.hint : undefined;
  const requestId = error instanceof ApiError ? error.requestId : undefined;
  return (
    <ul>
      <Row
        name={name}
        available={null}
        line={`Could not determine ${what}: the API did not answer.`}
        why={
          <>
            <p>{message}</p>
            {hint && <p>{hint}</p>}
            {requestId && (
              <p>
                Request <span className="font-mono">{requestId}</span> — quote
                this if you report it.
              </p>
            )}
          </>
        }
      >
        {onRetry && (
          <button
            onClick={onRetry}
            className="mt-1.5 rounded border border-line px-2 py-0.5 text-[12px] text-dim hover:border-dim hover:text-foreground"
          >
            Try again
          </button>
        )}
      </Row>
    </ul>
  );
}

/**
 * One fetch with loading / error / value, retried on demand.
 *
 * `busy` is derived rather than stored: the source is loading exactly when it
 * has neither a value nor an error. That keeps every setState inside the
 * promise callbacks, which is what the effect rule asks for, and a retry is
 * just "forget both and bump the attempt".
 */
function useSource<T>(load: (() => Promise<T>) | null) {
  const [value, setValue] = useState<T | null>(null);
  const [error, setError] = useState<ApiError | string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!load) return;
    let live = true;
    load()
      .then((v) => {
        if (live) setValue(v);
      })
      .catch((e) => {
        if (live) setError(e instanceof ApiError ? e : String(e));
      });
    return () => {
      live = false;
    };
  }, [load, attempt]);

  const retry = useCallback(() => {
    setValue(null);
    setError(null);
    setAttempt((n) => n + 1);
  }, []);

  const busy = load !== null && value === null && error === null;
  return { value, error, busy, retry };
}

/* ---------------------------------------------------------- the groups */

const ROLE_WHAT: Record<string, string> = {
  interpreter: "turns a sentence into typed changes",
  proposer: "suggests extra optimizer candidates",
  narrator: "rewords engine output in plain language",
};

function AiGroup() {
  const { status, failed } = useAiStatus();
  return (
    <Group title="Language model" source="GET /api/ai/status">
      {failed && (
        <Unreachable
          name="The AI layer"
          what="the AI layer's status"
          error="The status endpoint did not respond, so nothing about the model can be claimed."
        />
      )}
      {!failed && !status && <Loading what="the AI layer's status" />}
      {status && (
        <ul className="divide-y divide-line/60">
          <Row
            name="A configured model"
            note={`provider ${providerLabel(status.provider)}`}
            available={status.available}
            line={
              status.available
                ? `${status.model} is answering; every output is validated against the engine before it is shown.`
                : status.needs
                  ? `Needs ${status.needs.charAt(0).toLowerCase()}${status.needs.slice(1)}`
                  : "Not stated by the API - that is itself a gap."
            }
            why={
              status.available
                ? undefined
                : "No model is answering. Every role below runs its deterministic fallback, and each result is labelled at the point of use."
            }
          />
          {status.roles.map((role) => {
            const fallback = status.degraded_behaviour[role];
            return (
              <Row
                key={role}
                name={humanize(role)}
                note={ROLE_WHAT[role]}
                available={status.available}
                line={
                  status.available
                    ? `Right now: answered by ${status.model}, checked against the engine.`
                    : "Right now: its deterministic fallback is answering, not a model."
                }
                why={
                  status.available ? undefined : (
                    <>
                      <p>
                        <span className="font-medium text-foreground/85">
                          The fallback:{" "}
                        </span>
                        {fallback ?? "not described by the API."}
                      </p>
                      <p>
                        <span className="font-medium text-foreground/85">
                          A model needs:{" "}
                        </span>
                        {status.needs ?? "not stated by the API."}
                      </p>
                    </>
                  )
                }
              />
            );
          })}
        </ul>
      )}
    </Group>
  );
}

function WithoutModelGroup() {
  const { status, failed } = useAiStatus();
  if (failed || !status) return null;
  return (
    <Group title="Works with or without a model" source="GET /api/ai/status">
      <ul className="divide-y divide-line/60">
        {Object.entries(status.capabilities_without_model).map(
          ([capability, mechanism]) => (
            <Row
              key={capability}
              name={humanize(capability)}
              available={true}
              line={`Computed by ${mechanism}.`}
            />
          ),
        )}
      </ul>
      {status.guarantees.length > 0 && (
        <Why label="What the model may never do here">
          {status.guarantees.map((g) => (
            <p key={g}>{g}</p>
          ))}
        </Why>
      )}
    </Group>
  );
}

function EvidenceGroup({ projectId }: { projectId: string }) {
  const load = useCallback(() => analyze(projectId), [projectId]);
  const { value, error, busy, retry } = useSource<Analysis>(load);
  return (
    <Group
      title="Detector evidence tiers, for this workflow"
      source="POST /api/projects/{id}/analyze"
    >
      {error && (
        <Unreachable
          name="Which checks can run"
          what="which checks can run"
          error={error}
          onRetry={retry}
        />
      )}
      {!error && busy && !value && <Loading what="the analysis" />}
      {value && (
        <ul className="divide-y divide-line/60">
          <Row
            name={`Evidence reached · ${tierLabel(value.tier_reached) || "?"}`}
            available={true}
            line={`${value.checks_run.length} check${
              value.checks_run.length === 1 ? "" : "s"
            } ran on this workflow.`}
            why={
              <p>
                <span className="font-medium text-foreground/85">
                  The checks that ran:{" "}
                </span>
                {value.checks_run.map(findingKindLabel).join(", ")}
              </p>
            }
          />
          {value.unavailable_checks.length === 0 && (
            <Row
              name="Every detector tier"
              available={true}
              line="Nothing was withheld: every check the engine has ran."
            />
          )}
          {value.unavailable_checks.map((gap) => (
            <Row
              key={gap.tier}
              name={tierLabel(gap.tier) || "?"}
              available={false}
              line={`Needs ${gap.requires}.`}
              why={
                <>
                  <p>{gap.why}</p>
                  <p>{gap.unlocked_by}</p>
                  {gap.checks.length > 0 && (
                    <ul className="flex flex-col gap-0.5">
                      {gap.checks.map((c) => (
                        <li key={c}>· {checkLabel(c)}</li>
                      ))}
                    </ul>
                  )}
                </>
              }
            />
          ))}
        </ul>
      )}
    </Group>
  );
}

function ForecastGroup({ projectId }: { projectId: string }) {
  const load = useCallback(() => getForecastAssumptions(projectId), [projectId]);
  const { value, error, busy, retry } = useSource<ForecastAssumptions>(load);
  return (
    <Group
      title="Probabilistic forecast"
      source="GET /api/projects/{id}/forecast/assumptions"
    >
      {error && (
        <Unreachable
          name="The forecast's basis"
          what="the forecast's basis"
          error={error}
          onRetry={retry}
        />
      )}
      {!error && busy && !value && <Loading what="the forecast's assumptions" />}
      {value && (
        <ul className="divide-y divide-line/60">
          <Row
            name="Seeded simulation of finish dates"
            available={true}
            line={`${value.distribution_name ?? "The configured distribution"}${
              value.default_iterations
                ? `, ${value.default_iterations} iterations by default`
                : ""
            }.`}
            why={value.disclaimer ? <p>{value.disclaimer}</p> : undefined}
          />
          <Row
            name="A calibrated probability"
            available={value.is_calibrated === true}
            line={
              value.is_calibrated === true
                ? "Calibrated against recorded outcomes."
                : value.what_would_calibrate_it
                  ? `Needs ${lead(value.what_would_calibrate_it).charAt(0).toLowerCase()}${lead(value.what_would_calibrate_it).slice(1)}`
                  : "Not stated by the API - that is itself a gap."
            }
            why={
              value.is_calibrated === true ? undefined : (
                <>
                  <p>
                    The forecast is a real probability under its assumptions,
                    but it has not been checked against any real outcome.
                  </p>
                  {value.what_would_calibrate_it && (
                    <p>
                      <span className="font-medium text-foreground/85">
                        What would calibrate it:{" "}
                      </span>
                      {value.what_would_calibrate_it}
                    </p>
                  )}
                </>
              )
            }
          />
          {(value.not_modelled ?? []).map((n) => (
            <Row
              key={n.what}
              name={`Modelling of ${n.what}`}
              available={false}
              line={lead(n.why_it_matters) || "Not modelled by the simulator."}
              why={hasMore(n.why_it_matters) ? <p>{n.why_it_matters}</p> : undefined}
            />
          ))}
        </ul>
      )}
    </Group>
  );
}

function RolesGroup({
  projectId,
  person,
  isGuest,
}: {
  projectId: string;
  person: Person | null;
  isGuest: boolean;
}) {
  const load = useCallback(
    () => (person ? userProjects(person.id) : Promise.reject("no identity")),
    [person],
  );
  const { value, error, busy, retry } = useSource<UserProjects>(
    person ? load : null,
  );
  const mine = value?.projects.find((p) => p.id === projectId);
  return (
    <Group
      title="Who may change this workflow"
      source="GET /api/users/{me}/projects"
    >
      {!person && (
        <ul>
          <Row
            name="Roles are enforced by the API"
            available={null}
            line="Your identity has not resolved yet, so whether roles bind you cannot be read."
          />
        </ul>
      )}
      {person && error && (
        <Unreachable
          name="Roles are enforced by the API"
          what="whether roles are enforced"
          error={error}
          onRetry={retry}
        />
      )}
      {person && !error && busy && !value && <Loading what="your role" />}
      {value && (
        <ul className="divide-y divide-line/60">
          <Row
            name="Roles are enforced by the API"
            available={value.roles_enforced}
            line={lead(value.note) || (value.roles_enforced ? "Enforced." : "Advisory only.")}
            why={
              hasMore(value.note) || !value.roles_enforced ? (
                <>
                  {hasMore(value.note) && <p>{value.note}</p>}
                  {!value.roles_enforced && (
                    <p>
                      <span className="font-medium text-foreground/85">
                        Needs:{" "}
                      </span>
                      a PROXY_SHARED_SECRET set on both the API server and the
                      web app, so the identity header can be trusted. Until then
                      a role is a label, not a permission.
                    </p>
                  )}
                </>
              ) : undefined
            }
          />
          <Row
            name="Your seat here"
            available={true}
            line={
              isGuest
                ? "You are the public read-only guest; the API refuses anything that changes the workflow."
                : mine
                  ? `Signed in as ${person!.name}; your role on this project is ${roleLabel(mine.role).toLowerCase()}.`
                  : `Signed in as ${person!.name}; you are not a member of this project, so you can read and evaluate it but not change it.`
            }
            why={
              isGuest ? (
                <p>
                  Reading, analysing, forecasting, optimising and asking a
                  what-if all work. Anything that changes the workflow is
                  refused by the API itself, not hidden by this page.
                </p>
              ) : undefined
            }
          />
        </ul>
      )}
    </Group>
  );
}

/* ------------------------------------------------------------ the panel */

export default function CapabilityPanel({
  projectId,
  person,
  isGuest,
}: {
  projectId: string;
  person: Person | null;
  isGuest: boolean;
}) {
  return (
    <div className="flex flex-col gap-6">
      <AiGroup />
      <EvidenceGroup projectId={projectId} />
      <ForecastGroup projectId={projectId} />
      <RolesGroup projectId={projectId} person={person} isGuest={isGuest} />
      <WithoutModelGroup />
    </div>
  );
}

/**
 * The panel behind a button, for the workspace header. The content mounts
 * when the dialog opens, so the reads above happen on demand and not on
 * every stage change.
 */
export function CapabilityDialog(props: {
  projectId: string;
  person: Person | null;
  isGuest: boolean;
}) {
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" className="whitespace-nowrap">
          What this build can and cannot do
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[85vh] overflow-y-auto bg-panel sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle className="text-[18px] font-semibold leading-tight">
            What this build can and cannot do right now
          </DialogTitle>
          <DialogDescription className="text-[14px] text-dim">
            Read live from the API for this workflow. What is not available
            says what it needs; a source that did not answer says so.
          </DialogDescription>
        </DialogHeader>
        <CapabilityPanel {...props} />
      </DialogContent>
    </Dialog>
  );
}
