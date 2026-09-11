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
 * The panel is per workflow, because the evidence tier is: the same build
 * reaches tier 2 on a project with an event log and tier 0 on a fresh one.
 */

import { ReactNode, useCallback, useEffect, useState } from "react";
import { CircleCheck, CircleHelp, CircleOff, LoaderCircle } from "lucide-react";
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
import { findingKindLabel, humanize, roleLabel, tierLabel } from "@/lib/display";
import { cn } from "@/lib/utils";
import { useAiStatus } from "./AiMethod";
import { ErrorNote } from "./ui";

const ICON = "size-3.5 shrink-0";
const TOKEN =
  "rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-[12px]";

/* ------------------------------------------------------------ one row */

/** available: true / false / null-for-unknown. Three states, three glyphs. */
function Row({
  name,
  available,
  detail,
  needs,
  children,
}: {
  name: ReactNode;
  available: boolean | null;
  /** What runs, or what would run. One sentence. */
  detail?: ReactNode;
  /** When unavailable: the specific thing it needs. Never shown as empty. */
  needs?: ReactNode;
  children?: ReactNode;
}) {
  const glyph =
    available === true ? (
      <CircleCheck className={cn(ICON, "text-severity-low")} aria-hidden />
    ) : available === false ? (
      <CircleOff className={cn(ICON, "text-severity-medium")} aria-hidden />
    ) : (
      <CircleHelp className={cn(ICON, "text-dim")} aria-hidden />
    );
  const word =
    available === true
      ? "available"
      : available === false
        ? "not available"
        : "could not be determined";
  return (
    <li className="flex gap-2.5 py-2">
      <span className="mt-0.5">{glyph}</span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <span className="text-[13px] font-medium">{name}</span>
          <span
            className={cn(
              "text-[12px]",
              available === false ? "text-severity-medium" : "text-dim",
            )}
          >
            {word}
          </span>
        </div>
        {detail && <p className="mt-0.5 text-xs text-foreground/85">{detail}</p>}
        {available === false && (
          <p className="mt-0.5 text-xs">
            <span className="font-medium">Needs: </span>
            <span className="text-foreground/85">
              {needs ?? "not stated by the API - that is itself a gap."}
            </span>
          </p>
        )}
        {children}
      </div>
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
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 border-b border-border pb-1">
        <h3 className="text-[13px] font-semibold tracking-tight">{title}</h3>
        <span className={cn(TOKEN, "text-dim")}>{source}</span>
      </div>
      {children}
    </section>
  );
}

function Loading({ what }: { what: string }) {
  return (
    <p className="flex items-center gap-1.5 py-2 text-xs text-dim">
      <LoaderCircle className={cn(ICON, "animate-spin")} aria-hidden />
      Reading {what}…
    </p>
  );
}

/** A source that did not answer. Shown as a failure, never as "available". */
function Unreachable({
  what,
  error,
  onRetry,
}: {
  what: string;
  error: ApiError | string;
  onRetry?: () => void;
}) {
  return (
    <div className="py-2">
      <ErrorNote
        onRetry={onRetry}
        hint={error instanceof ApiError ? error.hint : undefined}
        requestId={error instanceof ApiError ? error.requestId : undefined}
      >
        Could not determine {what}: the API did not answer.{" "}
        {error instanceof ApiError ? error.userMessage : String(error)}
      </ErrorNote>
    </div>
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
        <Unreachable what="the AI layer's status" error="ai/status failed" />
      )}
      {!failed && !status && <Loading what="the AI layer's status" />}
      {status && (
        <ul className="divide-y divide-border/60">
          <Row
            name="A configured model"
            available={status.available}
            detail={
              status.available
                ? `Provider ${humanize(status.provider)}, model ${status.model}.`
                : `Provider "${humanize(status.provider)}": no model is answering. Every role below runs its deterministic fallback, and each result is labelled at the point of use.`
            }
            needs={status.needs}
          />
          {status.roles.map((role) => (
            <Row
              key={role}
              name={
                <>
                  {role[0].toUpperCase() + role.slice(1)}
                  <span className="text-dim"> · {ROLE_WHAT[role] ?? ""}</span>
                </>
              }
              available={status.available}
              detail={
                status.available
                  ? `Answered by ${status.model}; output is validated against the engine before it is shown.`
                  : `Running its fallback: ${status.degraded_behaviour[role] ?? "not described by the API"}`
              }
              needs={status.needs}
            />
          ))}
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
      <ul className="divide-y divide-border/60">
        {Object.entries(status.capabilities_without_model).map(
          ([capability, mechanism]) => (
            <Row
              key={capability}
              name={capability[0].toUpperCase() + capability.slice(1)}
              available={true}
              detail={`Computed by ${mechanism}.`}
            />
          ),
        )}
      </ul>
      {status.guarantees.length > 0 && (
        <div className="mt-2 border-l-2 border-border pl-2.5 text-xs text-foreground/85">
          <p className="mb-1 font-medium">What the model may never do here</p>
          <ul className="flex flex-col gap-0.5">
            {status.guarantees.map((g) => (
              <li key={g}>{g}</li>
            ))}
          </ul>
        </div>
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
        <Unreachable what="which checks can run" error={error} onRetry={retry} />
      )}
      {!error && busy && !value && <Loading what="the analysis" />}
      {value && (
        <ul className="divide-y divide-border/60">
          <Row
            name={`Evidence reached · ${tierLabel(value.tier_reached) || "?"}`}
            available={true}
            detail={`${value.checks_run.length} check${
              value.checks_run.length === 1 ? "" : "s"
            } ran on this workflow.`}
          >
            <details className="group mt-1">
              <summary className="cursor-pointer list-none text-[12px] text-dim hover:text-foreground [&::-webkit-details-marker]:hidden">
                <span className="inline-block w-3 group-open:hidden">▸</span>
                <span className="hidden w-3 group-open:inline-block">▾</span>
                The checks that ran
              </summary>
              <p className="mt-1 pl-3 text-[12px] text-dim">
                {value.checks_run.map(findingKindLabel).join(", ")}
              </p>
            </details>
          </Row>
          {value.unavailable_checks.length === 0 && (
            <Row
              name="Every detector tier"
              available={true}
              detail="Nothing was withheld: every check the engine has ran."
            />
          )}
          {value.unavailable_checks.map((gap) => (
            <Row
              key={gap.tier}
              name={tierLabel(gap.tier) || "?"}
              available={false}
              detail={gap.why}
              needs={
                <>
                  {gap.requires}. {gap.unlocked_by}
                </>
              }
            >
              <ul className="mt-1 flex flex-col gap-0.5 pl-3 text-[12px] text-dim">
                {gap.checks.map((c) => (
                  <li key={c}>· {findingKindLabel(c)}</li>
                ))}
              </ul>
            </Row>
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
        <Unreachable what="the forecast's basis" error={error} onRetry={retry} />
      )}
      {!error && busy && !value && <Loading what="the forecast's assumptions" />}
      {value && (
        <ul className="divide-y divide-border/60">
          <Row
            name="Seeded simulation of finish dates"
            available={true}
            detail={
              <>
                {value.distribution_name ?? "The configured distribution"}
                {value.default_iterations
                  ? `, ${value.default_iterations} iterations by default`
                  : ""}
                . {value.disclaimer ?? ""}
              </>
            }
          />
          <Row
            name="A calibrated probability"
            available={value.is_calibrated === true}
            detail={
              value.is_calibrated === true
                ? "Calibrated against recorded outcomes."
                : "The forecast is a real probability under its assumptions, but it has not been checked against any real outcome."
            }
            needs={value.what_would_calibrate_it}
          />
          {(value.not_modelled ?? []).map((n) => (
            <Row
              key={n.what}
              name={`Modelling of ${n.what}`}
              available={false}
              detail={n.why_it_matters}
              needs="a model extension; this is a known limit of the simulator, stated rather than papered over."
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
        <p className="py-2 text-xs text-dim">
          Your identity has not resolved yet, so whether roles bind you cannot
          be read.
        </p>
      )}
      {person && error && (
        <Unreachable
          what="whether roles are enforced"
          error={error}
          onRetry={retry}
        />
      )}
      {person && !error && busy && !value && <Loading what="your role" />}
      {value && (
        <ul className="divide-y divide-border/60">
          <Row
            name="Roles are enforced by the API"
            available={value.roles_enforced}
            detail={value.note}
            needs="a PROXY_SHARED_SECRET set on both the API server and the web app, so the identity header can be trusted. Until then a role is a label, not a permission."
          />
          <Row
            name="Your seat here"
            available={true}
            detail={
              isGuest
                ? "You are the public read-only guest. Reading, analysing, forecasting, optimising and asking a what-if all work; anything that changes the workflow is refused by the API itself, not hidden by this page."
                : mine
                  ? `Signed in as ${person!.name}; your role on this project is ${roleLabel(mine.role).toLowerCase()}.`
                  : `Signed in as ${person!.name}; you are not a member of this project, so you can read and evaluate it but not change it.`
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
    <div className="flex flex-col gap-5">
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
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>What this build can and cannot do right now</DialogTitle>
          <DialogDescription>
            Read live from the API for this workflow. Where something is not
            available, the row says what it needs. Where a source did not
            answer, the row says that instead of guessing.
          </DialogDescription>
        </DialogHeader>
        <CapabilityPanel {...props} />
      </DialogContent>
    </Dialog>
  );
}
