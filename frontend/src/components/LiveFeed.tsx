"use client";

/**
 * The live stage: a running clock, events arriving, findings appearing and
 * clearing on their own.
 *
 * This component owns the whole stage and composes `Clock`, `ReplayControls`
 * and `DependencyGraph` itself, so `page.tsx` has one mount point and the
 * arrangement stays here.
 *
 * What is actually on screen, and why
 * -----------------------------------
 * Two headline figures, one per panel, and nothing else at that size (design
 * brief §3, last bullet): the simulated clock - the calendar date, the day
 * number in words under it, the transport controls in the same panel - and
 * the projected finish. Under that strip the dependency map takes the full
 * width, because it is the only thing here that answers *when* and *who* at
 * once and the only thing that shows the clock moving through the schedule.
 * Then the reconstruction line and the findings in the main column, with the
 * arriving events in the rail - the glance surface, not the work surface.
 *
 * The honesty layer is not decoration here, it is the feature
 * -----------------------------------------------------------
 * Every frame is a **reconstruction**. It is what the engine would have said
 * on that simulated day, computed from the events known by then and
 * deliberately not from the later ones, which still exist in the log. A
 * viewer who thinks they are looking at current truth is being misled, so
 * `derived` says so permanently, directly under the chart whose numbers it
 * qualifies: one sentence always visible, and every caveat the backend sent,
 * verbatim, one click behind it - relocated, never deleted (brief §2.2, §9).
 * The tier genuinely moves during a replay, so the evidence line names the
 * tier *this frame* reached and the checks that consequently could not run.
 * And `projection.is_probability` is `false`, so the projected finish says in
 * words that it is the schedule's arithmetic and not a likelihood.
 *
 * If the server tells us frames were dropped on the way to this browser, that
 * is said too, loudly and until the replay is re-synced. Silently disagreeing
 * with the engine is the failure this product exists to avoid.
 *
 * The stream
 * ----------
 * `openReplayStream` wraps `EventSource`. Its first message is always
 * `catchup` carrying a whole frame, so a viewer arriving mid-replay sees the
 * world rather than an empty screen - and the returned closer is called from
 * the effect's cleanup, because a stream that outlives its component is a
 * leak on the server as well as in the browser.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ChevronRightIcon,
  CircleSlash,
  Radio,
  TriangleAlert,
} from "lucide-react";
import {
  Analysis,
  analyze,
  ApiError,
  controlReplay,
  Finding,
  getReplay,
  getReplayTimeline,
  openReplayStream,
  ReplayEvent,
  ReplayFrame,
  ReplayState,
  ReplayTimeline,
  startReplay,
  UnavailableCheck,
  Workflow,
} from "@/lib/api";
import {
  calendarDate,
  findingKindLabel,
  humanize,
  prose,
  severityLabel,
  statusLabel,
  tierLabel,
  verdictLabel,
} from "@/lib/display";
import { severityClasses, severityFill } from "@/lib/severity";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ErrorNote, Spinner, days } from "./ui";
import DependencyGraph, { LiveOverlay } from "@/components/DependencyGraph";
import Clock from "@/components/Clock";
import ReplayControls from "@/components/ReplayControls";

/** The API's default, and the pace the demo is written for (D-138). */
const DEFAULT_SPEED = 60;

/**
 * How long a change stays highlighted, in real milliseconds.
 *
 * Deliberately decoupled from the frame rate. At 600 sim-days a minute a
 * frame lands every 100 ms, and a highlight that lasted exactly one frame
 * would be a flicker nobody could read. Fourteen hundred milliseconds is long
 * enough to notice and short enough that two consecutive changes do not blur
 * into one.
 */
const FLASH_MS = 1400;

/**
 * The client half of `services/replay.finding_id`.
 *
 * Kind, root cause and the tasks it is about - severity and evidence
 * excluded, because those are what we want to watch change on a finding that
 * is still the same finding. It matches the server's function exactly, which
 * is what lets a `cleared` row in the delta be matched against the row that
 * was on screen a moment ago.
 */
function findingId(f: {
  kind: string;
  root_cause?: string | null;
  task_ids?: string[];
}): string {
  return `${f.kind}:${f.root_cause || "-"}:${(f.task_ids ?? []).join(",")}`;
}

/* ------------------------------------------------------------- highlights */

type Flash = {
  /** What happened. `cleared` keeps the payload so a ghost row can be drawn. */
  kind: "appeared" | "severity" | "cleared" | "event";
  severity: string;
  until: number;
  day: number;
  /** The tasks this is about, so the chart can ring the right bars. */
  taskIds: string[];
  from?: string;
  cleared?: { kind: string; task_ids: string[]; explanation_was: string };
};

/* ---------------------------------------------------- replay, started once */

/**
 * One in-flight start per project, shared.
 *
 * React runs an effect twice in development's strict mode, and two
 * `POST /replay` calls race: the second replaces the first, and whichever
 * loses tells its subscribers the replay was `restarted` - which is a viewer
 * staring at a dead stream for reasons entirely of our own making. Both
 * invocations await the same promise instead, so exactly one replay is ever
 * created and the second effect run simply subscribes to it.
 *
 * It also does the right thing for the case this stage exists to handle: if a
 * replay is already running - started by this browser a minute ago or by
 * somebody else entirely - `getReplay` succeeds and nothing is started at
 * all, so arriving mid-replay joins it rather than resetting it for everyone.
 */
const starting = new Map<string, Promise<void>>();

function ensureReplay(projectId: string): Promise<void> {
  const existing = starting.get(projectId);
  if (existing) return existing;
  const attempt = (async () => {
    try {
      await getReplay(projectId);
      return;
    } catch (e) {
      if (!(e instanceof ApiError) || e.status !== 404) throw e;
    }
    await startReplay(projectId, { speed: DEFAULT_SPEED });
  })();
  const tracked = attempt.finally(() => {
    if (starting.get(projectId) === tracked) starting.delete(projectId);
  });
  starting.set(projectId, tracked);
  return tracked;
}

/* ------------------------------------------------------------------- main */

export default function LiveFeed({
  projectId,
  workflow,
  analysis,
}: {
  projectId: string;
  workflow: Workflow;
  analysis: Analysis | null;
}) {
  const [state, setState] = useState<ReplayState | null>(null);
  const [frame, setFrame] = useState<ReplayFrame | null>(null);
  const [timelineEvents, setTimelineEvents] = useState<ReplayEvent[]>([]);
  const [stepDays, setStepDays] = useState<number[]>([]);
  const [flashes, setFlashes] = useState<Record<string, Flash>>({});
  const [dropped, setDropped] = useState(0);
  const [closedWhy, setClosedWhy] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<ApiError | string | null>(null);
  const [pending, setPending] = useState(false);
  const [nonce, setNonce] = useState(0);
  const [fetchedAnalysis, setFetchedAnalysis] = useState<Analysis | null>(null);

  /* The chart's geometry. A replay frame carries statuses and a critical
     path, never a schedule, so the bars have to come from an analysis. The
     stage is reachable without visiting the analyze stage first, in which
     case `analysis` arrives null and this fetches one - the same read the
     analyze stage does, which changes no workflow. */
  const base = analysis ?? fetchedAnalysis;

  useEffect(() => {
    if (analysis) return;
    let cancelled = false;
    analyze(projectId)
      .then((a) => {
        if (!cancelled) setFetchedAnalysis(a);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof ApiError ? e : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, analysis]);

  /* ------------------------------------------------------------- the frame */

  /**
   * Take a frame, and decide whether anything on it should be highlighted.
   *
   * `catchup` and the frames produced by a seek or a restart do **not**
   * highlight. Their delta is real, but it means "different from where you
   * were", not "this just happened" - lighting up eight findings because
   * somebody dragged the scrubber would train a viewer to ignore the one
   * signal on the screen that is supposed to mean something. Those cases get
   * a sentence saying a jump occurred instead.
   */
  const applyFrame = useCallback((f: ReplayFrame, highlight: boolean) => {
    setFrame(f);
    if (f.dropped_frames) setDropped(f.dropped_frames);
    if (!highlight) return;

    const now = Date.now();
    const day = f.clock.sim_day;
    const next: Record<string, Flash> = {};
    for (const finding of f.delta.appeared) {
      next[`f:${findingId(finding)}`] = {
        kind: "appeared",
        severity: finding.severity,
        until: now + FLASH_MS,
        day,
        taskIds: finding.task_ids,
      };
    }
    for (const changed of f.delta.severity_changed) {
      next[`f:${changed.id}`] = {
        kind: "severity",
        severity: changed.severity_to,
        from: changed.severity_from,
        until: now + FLASH_MS,
        day,
        taskIds: changed.task_ids,
      };
    }
    for (const gone of f.delta.cleared) {
      next[`f:${gone.id}`] = {
        kind: "cleared",
        severity: gone.severity_was,
        until: now + FLASH_MS,
        day,
        taskIds: gone.task_ids,
        cleared: {
          kind: gone.kind,
          task_ids: gone.task_ids,
          explanation_was: gone.explanation_was,
        },
      };
    }
    for (const e of f.events) {
      next[`e:${e.day}|${e.task_key}|${e.to_status}`] = {
        kind: "event",
        severity: "low",
        until: now + FLASH_MS,
        day: e.day,
        taskIds: [e.task_key],
      };
    }
    if (Object.keys(next).length === 0) return;
    setFlashes((prev) => ({ ...prev, ...next }));
  }, []);

  /* Expire highlights on a single timer rather than one per highlight. The
     effect only exists while something is lit, and the setter returns the
     same object when nothing expired, so a steady state costs no renders. */
  useEffect(() => {
    if (Object.keys(flashes).length === 0) return;
    const timer = setInterval(() => {
      const now = Date.now();
      setFlashes((prev) => {
        const live = Object.entries(prev).filter(([, f]) => f.until > now);
        if (live.length === Object.keys(prev).length) return prev;
        return Object.fromEntries(live);
      });
    }, 250);
    return () => clearInterval(timer);
  }, [flashes]);

  /* -------------------------------------------------------------- the wire */

  useEffect(() => {
    let abandoned = false;
    let close: (() => void) | null = null;

    /* Nothing is reset here on purpose. `react-hooks/set-state-in-effect` is
       right that a synchronous setState in an effect body is a cascading
       render, and D-103 settled the shape of the fix for this repo: the reset
       belongs in the handler that caused the re-run. So `error` and
       `closedWhy` are cleared by whichever action bumped `nonce`, and by the
       `catchup` that proves the new stream is alive. */
    (async () => {
      try {
        await ensureReplay(projectId);
        if (abandoned) return;

        /* The scrubber's stops, so a viewer can seek to a day the replay has
           not reached. Denser than the event list, because the replay steps
           on every whole simulated day and not only on days something
           happened (D-139). */
        const timeline = await getReplayTimeline(projectId);
        if (abandoned) return;
        setStepDays(readStepDays(timeline));
        setTimelineEvents(
          Array.isArray(timeline.events) ? timeline.events : [],
        );

        close = openReplayStream(projectId, {
          onCatchup: (s, f) => {
            // A `catchup` is proof the stream is alive, so it is the honest
            // place to clear a connection complaint - not the effect body.
            setConnected(true);
            setClosedWhy(null);
            setError(null);
            setState(s);
            if (f) applyFrame(f, false);
          },
          onFrame: (f) => applyFrame(f, f.reason === "tick"),
          onControl: (_action, s) => setState(s),
          onEnd: () =>
            setState((prev) => (prev ? { ...prev, finished: true } : prev)),
          onClosed: (why) => {
            setConnected(false);
            if (why === "restarted") {
              // Somebody replaced this replay. Follow it rather than making
              // the viewer click to rejoin a replay that is already running,
              // and say nothing about it - from here it is just a new stream.
              setNonce((n) => n + 1);
            } else {
              setClosedWhy(why);
            }
          },
          onError: (e) => {
            const source = e.target as EventSource | null;
            if (source && source.readyState === EventSource.CLOSED) {
              setConnected(false);
            }
          },
        });
        if (abandoned) {
          close();
          close = null;
        }
      } catch (e) {
        if (!abandoned) setError(e instanceof ApiError ? e : String(e));
      }
    })();

    return () => {
      abandoned = true;
      // The whole leak story, in one line: the last subscriber leaving arms
      // the server's reaper, which cancels the driver task 30s later. We do
      // not stop the replay - somebody else may still be watching it.
      close?.();
    };
  }, [projectId, nonce, applyFrame]);

  /* --------------------------------------------------------------- actions */

  const send = useCallback(
    async (body: Parameters<typeof controlReplay>[1]) => {
      setPending(true);
      setError(null);
      try {
        setState(await controlReplay(projectId, body));
      } catch (e) {
        setError(e instanceof ApiError ? e : String(e));
      } finally {
        setPending(false);
      }
    },
    [projectId],
  );

  const restartFromScratch = useCallback(async () => {
    setPending(true);
    setError(null);
    try {
      setState(await startReplay(projectId, { speed: DEFAULT_SPEED }));
      setFlashes({});
      setNonce((n) => n + 1);
    } catch (e) {
      setError(e instanceof ApiError ? e : String(e));
    } finally {
      setPending(false);
    }
  }, [projectId]);

  /* ------------------------------------------------------------ derivation */

  const eventDaysByDay = useMemo(() => {
    const counts: Record<number, number> = {};
    for (const e of timelineEvents) counts[e.day] = (counts[e.day] ?? 0) + 1;
    return counts;
  }, [timelineEvents]);

  const taskNames = useMemo(() => {
    const names: Record<string, string> = {};
    for (const t of workflow.tasks) names[t.key] = t.name;
    return names;
  }, [workflow.tasks]);

  const simDay = frame?.clock.sim_day ?? state?.sim_day ?? 0;

  /* The feed is derived from the timeline rather than accumulated from
     frames, so it is correct after a seek backwards or a restart without
     anything having to be reset. It is exactly the events the frame says it
     knew: `derived.events_known` is printed beside it as the check. */
  const observedEvents = useMemo(
    () =>
      timelineEvents
        .filter((e) => e.day <= simDay + 1e-9)
        .sort((a, b) => b.day - a.day),
    [timelineEvents, simDay],
  );

  const criticalPath = useMemo(
    () => new Set(frame?.critical_path ?? []),
    [frame?.critical_path],
  );

  /** What the chart needs from the replay, memoised on the frame itself. */
  const live = useMemo<LiveOverlay | undefined>(() => {
    if (!frame) return undefined;
    const flashTasks: Record<string, string> = {};
    for (const f of Object.values(flashes)) {
      // A cleared finding has no bar to ring any more, and an event is not a
      // finding - the ring means "a finding landed here", nothing else.
      if (f.kind === "cleared" || f.kind === "event") continue;
      for (const task of f.taskIds) flashTasks[task] = f.severity;
    }
    return {
      statuses: frame.statuses,
      criticalPath: frame.critical_path,
      simDay: frame.clock.sim_day,
      projectedEndDay: frame.projection.projected_end_day,
      flashTasks,
    };
  }, [frame, flashes]);

  const ghosts = useMemo(
    () =>
      Object.entries(flashes)
        .filter(([, f]) => f.kind === "cleared" && f.cleared)
        .map(([key, f]) => ({ key, flash: f })),
    [flashes],
  );

  /* ------------------------------------------------------------------ view */

  if (error && !frame) {
    return (
      <ErrorNote
        onRetry={() => {
          setError(null);
          setNonce((n) => n + 1);
        }}
        hint={error instanceof ApiError ? error.hint : undefined}
        requestId={error instanceof ApiError ? error.requestId : undefined}
      >
        {error instanceof ApiError ? error.userMessage : String(error)}
      </ErrorNote>
    );
  }

  if (!frame || !base) {
    return <Spinner label="Opening the replay…" />;
  }

  const d = frame.derived;
  const p = frame.projection;
  const slipped = p.slip_days > 0;
  const jumped =
    frame.reason === "seek" ||
    frame.reason === "restart" ||
    frame.reason === "start";
  const versionMismatch = !!state && base.version_id !== state.version_id;

  return (
    <div className="flex flex-col gap-4">
      {error && (
        <ErrorNote
          hint={error instanceof ApiError ? error.hint : undefined}
          requestId={error instanceof ApiError ? error.requestId : undefined}
        >
          {error instanceof ApiError ? error.userMessage : String(error)}
        </ErrorNote>
      )}

      {/* The engine and this screen disagree, and it says so. A dropped frame
          means this viewer's queue overflowed server-side; every number below
          may therefore be behind the replay. Sticky until a seek or a restart
          re-syncs, because a warning that scrolls past in 200ms is not one. */}
      {dropped > 0 && (
        <div className="border-l-2 border-severity-high bg-severity-high/5 py-2 pl-3 text-[14px]">
          <div className="flex items-center gap-1.5 font-semibold text-severity-high">
            <TriangleAlert className="size-3.5" aria-hidden />
            {dropped} frame{dropped === 1 ? "" : "s"} never reached this browser
          </div>
          <p className="mt-0.5 text-foreground/90">
            The server dropped them because this connection fell behind the
            replay, so what is on screen may be behind what the engine has
            computed. Seek or restart to re-sync — the numbers here are only
            trustworthy once this notice is gone.
          </p>
        </div>
      )}

      {closedWhy && closedWhy !== "restarted" && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-l-2 border-line py-2 pl-3 text-[14px]">
          <CircleSlash className="size-3.5 text-dim" aria-hidden />
          <span>
            {closedWhy === "expired"
              ? "This replay was collected after everybody stopped watching it."
              : "This replay was stopped."}{" "}
            The frame below is the last one it produced.
          </span>
          <Button size="sm" variant="outline" onClick={restartFromScratch}>
            Start a new replay
          </Button>
        </div>
      )}

      {!connected && !closedWhy && (
        <p className="border-l-2 border-line py-1.5 pl-3 text-[14px] text-dim">
          The stream is not connected. Nothing below is updating — it is the
          last frame this browser received, at simulated day{" "}
          {Math.round(frame.clock.sim_day)}.
        </p>
      )}

      {versionMismatch && (
        <p className="border-l-2 border-severity-medium py-1.5 pl-3 text-[14px]">
          The chart&rsquo;s schedule was computed for version{" "}
          <span className="font-mono">{base.version_no}</span> and the replay
          is running over version{" "}
          <span className="font-mono">{state?.version_no}</span>. Bar positions
          and statuses are therefore from two different versions.
        </p>
      )}

      {/* ------------------------------------------------------------------
          THE TOP STRIP - the two headline figures, one per panel.
          Left: the clock with the transport under it. Right: the projected
          finish. Nothing else on this stage is set at headline size.
         ------------------------------------------------------------------ */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
        <section
          data-panel="live-clock"
          className="flex flex-col gap-4 rounded-xl border border-line bg-panel px-5 py-4"
        >
          <Clock
            simDay={simDay}
            simDate={frame.clock.sim_date}
            startDay={frame.clock.start_day}
            horizonDay={frame.clock.horizon_day}
            horizonDate={frame.clock.horizon_date}
            percentComplete={frame.clock.percent_complete}
            state={
              state?.finished ? "ended" : state?.paused ? "paused" : "running"
            }
            secondsPerDay={state?.seconds_per_simulated_day}
            speed={state?.speed}
          />
          <ReplayControls
            state={state}
            simDay={simDay}
            stepDays={stepDays}
            eventDaysByDay={eventDaysByDay}
            pending={pending}
            onPlayPause={() => {
              // Pressing play on a replay that has run out of log restarts
              // it. `resume` on a finished replay is a documented no-op, and
              // a play button that does nothing is worse than one that does
              // the only thing left to do.
              if (state?.finished) {
                setFlashes({});
                void send({ action: "restart" });
              } else {
                void send({ action: state?.paused ? "resume" : "pause" });
              }
            }}
            onRestart={() => {
              setFlashes({});
              void send({ action: "restart" });
            }}
            onSeek={(day) => {
              setFlashes({});
              void send({ action: "seek", to_day: day });
            }}
            onSpeed={(speed) => send({ action: "speed", speed })}
          />
        </section>

        <ProjectedFinish projection={p} slipped={slipped} />
      </div>

      {/* The map, full width: the only thing here that needs it. */}
      <DependencyGraph analysis={base} live={live} />

      <div className="flex flex-col gap-4 lg:flex-row lg:items-start">
        <div className="flex min-w-0 flex-1 flex-col gap-4">
          <Reconstruction
            derived={d}
            tier={frame.tier_reached}
            checksRun={frame.checks_run.length}
            unavailable={frame.unavailable_checks}
          />

          <LiveFindings
            frame={frame}
            flashes={flashes}
            ghosts={ghosts}
            criticalPath={criticalPath}
            taskNames={taskNames}
            jumped={jumped}
          />
        </div>

        <aside className="flex w-full shrink-0 flex-col gap-4 lg:w-[320px]">
          <EventFeed
            events={observedEvents}
            total={d.events_total}
            known={d.events_known}
            taskNames={taskNames}
            flashes={flashes}
            connected={connected}
          />
        </aside>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- helpers */

const SUMMARY =
  "flex cursor-pointer list-none items-center gap-1 marker:content-none [&::-webkit-details-marker]:hidden";

/** The first sentence of a piece of engine prose; the rest waits in the disclosure. */
function firstSentence(text: string): string {
  const m = /^([\s\S]*?[.!?])(?:\s+(?=[A-Z0-9"(])|$)/.exec(text.trim());
  return m ? m[1] : text;
}

/** "chronic_underestimation: estimates that ..." → the kind as words, the rest verbatim. */
function checkLine(check: string): string {
  const colon = check.indexOf(":");
  if (colon === -1) return findingKindLabel(check);
  return `${findingKindLabel(check.slice(0, colon))}:${check.slice(colon + 1)}`;
}

/**
 * The scrubber's stops.
 *
 * This was written defensively against two possible payload shapes, because
 * `lib/api.ts` typed the timeline as `step_days: number[]` and the running
 * backend returned `steps: [{day, date, events}]`. The type was wrong; it has
 * been corrected against a real response, so the guesswork is gone and the
 * remaining filter is ordinary defence against a malformed body rather than
 * an unresolved disagreement about the contract.
 */
function readStepDays(timeline: ReplayTimeline): number[] {
  const steps = timeline.steps;
  if (!Array.isArray(steps)) return [];
  return steps
    .map((s) => s?.day)
    .filter((d): d is number => typeof d === "number");
}

/* ------------------------------------------------------- projected finish */

/**
 * The second headline figure. The date is the number; the plan, the deadline
 * and the slip are the meta under it; the one caveat line says in words that
 * this is arithmetic and not a likelihood, and the engine's own statement
 * sits behind the disclosure, verbatim.
 */
function ProjectedFinish({
  projection: p,
  slipped,
}: {
  projection: ReplayFrame["projection"];
  slipped: boolean;
}) {
  const verdictTone =
    p.verdict === "feasible"
      ? "text-severity-low"
      : p.verdict === "no_deadline_set"
        ? "text-foreground"
        : "text-severity-high";

  return (
    <section
      data-panel="live-projected-finish"
      className="flex flex-col rounded-xl border border-line bg-panel px-5 py-4"
    >
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-[14px] font-medium">Projected finish</h2>
        <span
          className={cn(
            "inline-flex h-6 items-center gap-1.5 rounded-full border px-2.5 text-[12px] font-medium",
            slipped
              ? "border-severity-high/25 bg-severity-high/5 text-severity-high"
              : "border-severity-low/25 bg-severity-low/5 text-severity-low",
          )}
        >
          <span
            aria-hidden
            className={cn(
              "size-1.5 rounded-full",
              slipped ? "bg-severity-high" : "bg-severity-low",
            )}
          />
          {slipped ? "At risk" : "On plan"}
        </span>
      </div>

      <div
        className={cn(
          "mt-3 text-[36px] font-semibold leading-none tracking-[-0.02em]",
          slipped ? "text-critical" : "text-foreground",
        )}
      >
        {calendarDate(p.projected_end_date) ?? p.projected_end_date}
      </div>

      <div className="mt-2 text-[14px]">
        Ends on day {Math.round(p.projected_end_day)}
        <span className="text-dim">
          {" · "}
          <span className={cn(slipped && "font-medium text-critical")}>
            {days(p.slip_days, true)}
          </span>{" "}
          against the plan
        </span>
      </div>

      <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 border-t border-line pt-3 text-[12px]">
        <div>
          <dt className="text-dim">Planned</dt>
          <dd className="mt-0.5 text-foreground">
            Day {Math.round(p.planned_end_day)}
            {p.planned_end_date && (
              <span className="text-dim">
                {" · "}
                {calendarDate(p.planned_end_date) ?? p.planned_end_date}
              </span>
            )}
          </dd>
        </div>
        <div>
          <dt className="text-dim">Deadline</dt>
          <dd className="mt-0.5">
            <span className={cn("font-medium", verdictTone)}>
              {verdictLabel(p.verdict)}
            </span>
            {p.margin_days !== null && (
              <span className="text-dim">
                {" · "}
                {days(p.margin_days, true)} margin
              </span>
            )}
          </dd>
        </div>
      </dl>

      {/* The caveat line, always visible. `is_probability` is false on every
          frame today; if the engine ever sends true, this line is wrong and
          must not show. */}
      {p.is_probability === false && (
        <p className="mt-3 text-[12px] text-dim">
          Arithmetic from the critical path, not a likelihood — no probability
          is claimed here; the forecast stage has the probabilistic view.
        </p>
      )}

      <details className="group mt-2">
        <summary className={cn(SUMMARY, "text-[12px] text-accent hover:underline")}>
          <ChevronRightIcon
            aria-hidden
            className="size-3.5 transition-transform group-open:rotate-90"
          />
          How this was projected
        </summary>
        <p className="mt-2 border-l border-line pl-3 text-[12px] leading-relaxed text-foreground/90">
          {prose(p.statement)}
        </p>
      </details>
    </section>
  );
}

/* --------------------------------------------------------- the honesty bit */

/**
 * What this frame is, and what it is not.
 *
 * Permanently on screen, immediately under the chart whose numbers it
 * qualifies. One sentence is always visible - the frame was computed at this
 * simulated day from this many of the events - with the evidence tier beside
 * it; every sentence the backend sent, and the tier note, sit one click
 * behind, verbatim. `caveats` is rendered by iteration rather than by key, so
 * a caveat the backend adds tomorrow appears here without a frontend change;
 * the day someone adds one must not be the day it stops showing.
 */
function Reconstruction({
  derived,
  tier,
  checksRun,
  unavailable,
}: {
  derived: ReplayFrame["derived"];
  tier: number;
  checksRun: number;
  unavailable: UnavailableCheck[];
}) {
  const couldNot = unavailable.reduce((n, g) => n + g.checks.length, 0);
  const evidence = tierLabel(tier).toLowerCase();

  return (
    <section className="rounded-xl border border-line bg-panel px-5 py-4">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 className="text-[18px] font-semibold">
          {derived.is_reconstruction
            ? "Reconstruction, not current truth"
            : "Current state"}
        </h2>
        <span className="text-[12px] text-dim">
          <span className="font-medium text-foreground">Evidence {evidence}</span>
          {" · "}
          {checksRun} {checksRun === 1 ? "check" : "checks"} ran
          {couldNot > 0 ? `, ${couldNot} could not` : ""}
        </span>
      </div>

      <p className="mt-1 text-[14px]">
        Computed at simulated day {derived.computed_at_simulated_day} from the{" "}
        {derived.events_known} of {derived.events_total} events known by then,
        with {derived.events_pending} events pending — the later ones exist in
        the log and are deliberately not used.
      </p>

      <details className="group mt-2">
        <summary className={cn(SUMMARY, "text-[12px] text-accent hover:underline")}>
          <ChevronRightIcon
            aria-hidden
            className="size-3.5 transition-transform group-open:rotate-90"
          />
          Why these numbers are what they are
        </summary>
        <div className="mt-2 flex flex-col gap-3 border-l border-line pl-3 text-[12px]">
          <ul className="flex flex-col gap-1.5 text-dim">
            {/* Not part of `caveats`, and it belongs with them: the tier on
                this stage is the tier *this frame* reached, and it climbs as
                the replay observes transitions. A reader who took it for the
                project's standing tier would over-read an early frame. */}
            <li>
              The evidence level ({evidence}) is what this frame reached, not
              this project&rsquo;s level today. It is recomputed on every
              simulated day and climbs as the replay observes transitions
              {couldNot > 0
                ? `, so the ${couldNot} checks listed as unavailable below are the ones this day's evidence could not support.`
                : "."}
            </li>
            {derived.caveats.map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ul>

          {unavailable.length > 0 && (
            <div className="flex flex-col gap-3 border-t border-line pt-3">
              <div className="font-medium text-foreground/90">
                What this frame cannot assess yet, and why
              </div>
              {unavailable.map((gap) => (
                <div key={gap.tier}>
                  <div className="font-medium text-foreground/90">
                    {tierLabel(gap.tier)} — needs {gap.requires}
                  </div>
                  <ul className="mt-1 space-y-0.5 text-dim">
                    {gap.checks.map((c) => (
                      <li key={c}>· {checkLine(c)}</li>
                    ))}
                  </ul>
                  <p className="mt-1 text-dim">{gap.why}</p>
                  <p className="mt-0.5 text-accent">{gap.unlocked_by}</p>
                </div>
              ))}
            </div>
          )}
        </div>
      </details>
    </section>
  );
}

/* --------------------------------------------------------------- findings */

function LiveFindings({
  frame,
  flashes,
  ghosts,
  criticalPath,
  taskNames,
  jumped,
}: {
  frame: ReplayFrame;
  flashes: Record<string, Flash>;
  ghosts: { key: string; flash: Flash }[];
  criticalPath: Set<string>;
  taskNames: Record<string, string>;
  jumped: boolean;
}) {
  const delta = frame.delta;
  const day = Math.round(frame.clock.sim_day);
  const counts = frame.finding_counts_by_severity;
  const maxImpact = Math.max(
    1,
    ...frame.findings.map((f) => f.impact_score),
  );

  return (
    <section className="flex flex-col gap-3">
      <div>
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
          <h2 className="text-[18px] font-semibold">
            Findings at simulated day {day}
          </h2>
          <span className="text-[12px] text-dim">
            {frame.findings.length} open · {counts.high} high · {counts.medium}{" "}
            medium · {counts.low} low
          </span>
        </div>
        <p className="mt-0.5 text-[12px] text-dim">
          Since the last frame: {delta.appeared.length} appeared ·{" "}
          {delta.cleared.length} cleared · {delta.severity_changed.length}{" "}
          changed severity · {delta.unchanged} unchanged.
        </p>
        {jumped && (
          <p
            className="mt-0.5 text-[12px] text-dim"
            title={
              frame.reason === "start"
                ? "Nothing is highlighted, because nothing has changed yet."
                : "Nothing is highlighted for a jump."
            }
          >
            {frame.reason === "start"
              ? "This is the replay's first frame, so everything the engine found at this simulated day is counted as having appeared."
              : `That was a ${frame.reason}, so the counts above are the difference from where the replay was, not things that happened on this simulated day.`}
          </p>
        )}
      </div>

      {frame.findings.length === 0 && ghosts.length === 0 ? (
        <p className="rounded-xl border border-line bg-panel px-5 py-4 text-[14px] text-dim">
          Nothing is open at this simulated day. That is a real result, not an
          empty screen — {frame.checks_run.length} checks ran over the events
          known by day {day}.
        </p>
      ) : (
        <div className="flex flex-col gap-3">
          {/* Cleared findings stay for the length of the highlight, struck
              through, then leave. A finding that vanishes silently is a
              finding nobody saw clear, and "findings clear on their own" is
              half of what this screen is for. */}
          {ghosts.map(({ key, flash }) => (
            <ClearedCard key={key} flash={flash} />
          ))}
          {frame.findings.map((f) => (
            <FindingCard
              key={findingId(f)}
              finding={f}
              flash={flashes[`f:${findingId(f)}`]}
              onCriticalPath={f.task_ids.some((k) => criticalPath.has(k))}
              taskNames={taskNames}
              maxImpact={maxImpact}
            />
          ))}
        </div>
      )}
    </section>
  );
}

/**
 * The highlight.
 *
 * A tint and a hairline, transitioned over 150ms and not transitioned at all
 * under `prefers-reduced-motion` — where the tint still appears, because the
 * information is the point and only the movement is the accommodation.
 */
const FLASH_ROW =
  "transition-colors duration-150 motion-reduce:transition-none";

/**
 * One finding, laid out as the Bottlenecks stage lays its cards out: kind,
 * severity chip, task, tier on the top line; "Do this:" the loudest line;
 * one sentence of cause; the impact as a number with a bar proportional to
 * the largest impact on screen; the engine's full explanation, worked
 * arithmetic and evidence fields behind one disclosure, verbatim.
 */
function FindingCard({
  finding,
  flash,
  onCriticalPath,
  taskNames,
  maxImpact,
}: {
  finding: Finding;
  flash?: Flash;
  onCriticalPath: boolean;
  taskNames: Record<string, string>;
  maxImpact: number;
}) {
  const explanation = prose(finding.explanation);
  const cause = firstSentence(explanation);
  const impact = Math.round(finding.impact_score);
  const share = Math.max(0, Math.min(1, finding.impact_score / maxImpact));
  const few = finding.task_ids.length <= 2;

  return (
    <article
      className={cn(
        "rounded-xl border bg-panel p-4",
        FLASH_ROW,
        finding.severity === "high" ? "border-critical/40" : "border-line",
        flash && "bg-foreground/[0.055]",
      )}
    >
      <div className="flex items-start gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-dim">
            <Badge
              variant="outline"
              className={cn("text-[12px]", severityClasses(finding.severity))}
            >
              {severityLabel(finding.severity)}
            </Badge>

            <span className="font-medium text-foreground">
              {findingKindLabel(finding.kind)}
            </span>

            <span aria-hidden>·</span>

            {few ? (
              finding.task_ids.map((key) => (
                <span key={key} className="inline-flex items-baseline gap-1">
                  <span className="font-mono">{key}</span>
                  {taskNames[key] && <span>{taskNames[key]}</span>}
                </span>
              ))
            ) : (
              <span>{finding.task_ids.length} tasks</span>
            )}

            <span aria-hidden>·</span>
            <span>{tierLabel(finding.tier)}</span>

            {onCriticalPath && (
              <span
                className="font-medium text-critical"
                title="Zero slack in this frame's schedule."
              >
                zero-slack chain
              </span>
            )}

            {flash && (
              <span className="font-medium text-accent">
                {flash.kind === "appeared"
                  ? `appeared on day ${Math.round(flash.day)}`
                  : `${severityLabel(flash.from).toLowerCase()} → ${severityLabel(flash.severity).toLowerCase()} on day ${Math.round(flash.day)}`}
              </span>
            )}
          </div>

          <p className="mt-2 text-[14px] font-semibold leading-snug">
            <span>Do this: </span>
            {prose(finding.suggested_action)}
          </p>

          <p className="mt-1 text-[14px] leading-snug text-dim">{cause}</p>
        </div>

        <div className="w-20 shrink-0 text-right">
          <div className="text-[18px] font-semibold leading-none">{impact}</div>
          <div className="mt-0.5 text-[12px] text-dim">impact</div>
          <div className="mt-1.5 h-1 w-full overflow-hidden rounded-full bg-panel2">
            <div
              className={cn(
                "h-full rounded-full",
                finding.severity === "high" ? "bg-critical" : "bg-dim/60",
              )}
              style={{ width: `${Math.round(share * 100)}%` }}
            />
          </div>
        </div>
      </div>

      <details className="group mt-3">
        <summary className={cn(SUMMARY, "text-[12px] text-accent hover:underline")}>
          <ChevronRightIcon
            aria-hidden
            className="size-3.5 transition-transform group-open:rotate-90"
          />
          Evidence
        </summary>

        <div className="mt-2 flex flex-col gap-2 border-l border-line pl-3 text-[12px]">
          {explanation !== cause && (
            <p className="leading-relaxed text-foreground/90">{explanation}</p>
          )}

          <p className="text-dim">
            <span className="font-medium text-foreground/90">Impact:</span>{" "}
            <span className="font-mono">{finding.impact.worked}</span>
            <span className="ml-2 font-mono">{finding.impact.formula}</span>
          </p>

          <dl className="grid grid-cols-1 gap-x-6 gap-y-1 sm:grid-cols-2">
            {Object.entries(finding.evidence).map(([key, value]) => (
              <div key={key} className="flex gap-1.5">
                <dt className="shrink-0 text-dim">{humanize(key)}:</dt>
                <dd className="min-w-0 font-mono break-words">
                  {Array.isArray(value) ? value.join(", ") : String(value)}
                </dd>
              </div>
            ))}
          </dl>

          {!few && (
            <p className="text-dim">
              Tasks: <span className="font-mono">{finding.task_ids.join(", ")}</span>
            </p>
          )}

          {finding.downstream_affected.length > 0 && (
            <p className="text-dim">
              Downstream:{" "}
              <span className="font-mono">
                {finding.downstream_affected.join(", ")}
              </span>
            </p>
          )}
        </div>
      </details>
    </article>
  );
}

function ClearedCard({ flash }: { flash: Flash }) {
  const gone = flash.cleared;
  if (!gone) return null;
  const said = prose(gone.explanation_was);
  const first = firstSentence(said);
  return (
    <article
      className={cn("rounded-xl border border-line bg-panel p-4 opacity-70", FLASH_ROW)}
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-dim line-through decoration-1">
        <Badge
          variant="outline"
          className={cn("text-[12px]", severityClasses(flash.severity))}
        >
          {severityLabel(flash.severity)}
        </Badge>
        <span className="font-medium text-foreground">
          {findingKindLabel(gone.kind)}
        </span>
        <span aria-hidden>·</span>
        <span className="font-mono">{gone.task_ids.join(" ")}</span>
      </div>
      <p className="mt-2 text-[14px] leading-snug text-dim">
        <span className="font-semibold text-foreground">
          Cleared on day {Math.round(flash.day)}.
        </span>{" "}
        It said: {first}
      </p>
      {first !== said && (
        <details className="group mt-2">
          <summary className={cn(SUMMARY, "text-[12px] text-accent hover:underline")}>
            <ChevronRightIcon
              aria-hidden
              className="size-3.5 transition-transform group-open:rotate-90"
            />
            What it said in full
          </summary>
          <p className="mt-2 border-l border-line pl-3 text-[12px] leading-relaxed text-foreground/90">
            {said}
          </p>
        </details>
      )}
    </article>
  );
}

/* ------------------------------------------------------------- event feed */

function EventFeed({
  events,
  known,
  total,
  taskNames,
  flashes,
  connected,
}: {
  events: ReplayEvent[];
  known: number;
  total: number;
  taskNames: Record<string, string>;
  flashes: Record<string, Flash>;
  connected: boolean;
}) {
  return (
    <section className="overflow-hidden rounded-xl border border-line bg-panel">
      <div className="flex items-baseline justify-between gap-3 border-b border-line px-5 py-3">
        <h2 className="flex items-center gap-2 text-[18px] font-semibold">
          <Radio
            className={cn("size-4", connected ? "text-accent" : "text-dim")}
            aria-hidden
          />
          Events observed
        </h2>
        <span className="text-[12px] text-dim">
          {known} of {total}
        </span>
      </div>

      {events.length === 0 ? (
        <p className="px-5 py-4 text-[14px] leading-relaxed text-dim">
          {total === 0
            ? `This project has no event log at all, so there is nothing to replay and no observed evidence to reason from. That is why the evidence is only "${tierLabel(0).toLowerCase()}" and why so many checks could not run.`
            : `No transition has been observed at this simulated day yet. All ${total} in this project's log happen later and are not reflected in any number on this screen.`}
        </p>
      ) : (
        <ul className="flex max-h-[520px] flex-col divide-y divide-line overflow-y-auto">
          {events.map((e) => {
            const flash = flashes[`e:${e.day}|${e.task_key}|${e.to_status}`];
            return (
              <li
                key={`${e.day}|${e.task_key}|${e.to_status}`}
                className={cn(
                  "px-5 py-2.5",
                  FLASH_ROW,
                  flash && "bg-foreground/[0.055]",
                )}
              >
                <div className="flex items-baseline gap-2 text-[12px] text-dim">
                  <span>Day {Math.round(e.day)}</span>
                  <span className="font-mono text-foreground">{e.task_key}</span>
                  <span className="ml-auto">{calendarDate(e.date) ?? e.date}</span>
                </div>
                <div className="truncate text-[14px]">
                  {e.task_name || taskNames[e.task_key] || e.task_key}
                </div>
                <div className="text-[12px] text-dim">
                  {statusLabel(e.from_status)} →{" "}
                  <span className="text-foreground">
                    {statusLabel(e.to_status)}
                  </span>
                  {e.actor ? ` · ${e.actor}` : ""}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
