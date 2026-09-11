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
 * The dependency map is the hero: wide main column, narrow inspector rail,
 * exactly as the analyze stage settled it in D-115. The map is the only thing
 * here that answers *when* and *who* at once, and in live mode it is also the
 * only thing that shows the simulated clock moving through the schedule. The
 * rail holds what you glance at - the projected finish and the arriving
 * events - rather than what you work in.
 *
 * The honesty layer is not decoration here, it is the feature
 * -----------------------------------------------------------
 * Every frame is a **reconstruction**. It is what the engine would have said
 * on that simulated day, computed from the events known by then and
 * deliberately not from the later ones, which still exist in the log. A
 * viewer who thinks they are looking at current truth is being misled, so
 * `derived` is rendered in full, permanently, directly under the chart whose
 * numbers it qualifies - not behind a disclosure, not in a footer. The tier
 * genuinely moves during a replay, so `TierBanner` shows the tier *this
 * frame* reached and the checks that consequently could not run. And
 * `projection.is_probability` is `false`, so the projected finish says in
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

import { ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import { CircleSlash, Radio, TriangleAlert } from "lucide-react";
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
  Workflow,
} from "@/lib/api";
import { severityFill, severityText } from "@/lib/severity";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ErrorNote, Spinner, TierBanner, Worked, days } from "./ui";
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

function prettyKind(kind: string): string {
  return kind.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());
}

const STATUS_WORD: Record<string, string> = {
  done: "done",
  in_progress: "in progress",
  in_review: "in review",
  blocked: "blocked",
  not_started: "not started",
};

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
        <div className="border-l-2 border-severity-high bg-severity-high/5 py-2 pl-3 text-sm">
          <div className="flex items-center gap-1.5 font-semibold text-severity-high">
            <TriangleAlert className="size-3.5" aria-hidden />
            {dropped} frame{dropped === 1 ? "" : "s"} never reached this browser
          </div>
          <p className="mt-0.5 text-foreground/90">
            The server dropped them because this connection fell behind the
            replay. What is on screen may be behind what the engine has
            computed. Seek or restart to re-sync — the numbers here are only
            trustworthy once this notice is gone.
          </p>
        </div>
      )}

      {closedWhy && closedWhy !== "restarted" && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-l-2 border-line py-2 pl-3 text-sm">
          <CircleSlash className="size-3.5 text-muted-foreground" aria-hidden />
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
        <p className="border-l-2 border-line py-1.5 pl-3 text-[13px] text-muted-foreground">
          The stream is not connected. Nothing below is updating — it is the
          last frame this browser received, at simulated day{" "}
          {Math.round(frame.clock.sim_day)}.
        </p>
      )}

      {versionMismatch && (
        <p className="border-l-2 border-severity-medium py-1.5 pl-3 text-[13px]">
          The chart&rsquo;s schedule was computed for version{" "}
          <span className="font-mono">{base.version_no}</span> and the replay
          is running over version{" "}
          <span className="font-mono">{state?.version_no}</span>. Bar positions
          and statuses are therefore from two different versions.
        </p>
      )}

      {/* Tier, and what it consequently could not check. This moves during a
          replay - the engine reaches tier 0 before it has observed a single
          transition and tier 2 after - so it is the same shared component the
          analyze stage uses, re-rendered per frame rather than a static
          banner. */}
      <TierBanner
        tier={frame.tier_reached}
        checksRun={frame.checks_run}
        unavailable={frame.unavailable_checks}
      />

      {/* The transport. Clock left, controls right, one hairline under. */}
      <div className="flex flex-col gap-4 border-b border-line pb-4 lg:flex-row lg:items-start lg:gap-8">
        <div className="shrink-0 lg:w-[286px]">
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
        </div>
        <div className="min-w-0 flex-1">
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
        </div>
      </div>

      {/* Hero and rail, the arrangement D-115 settled: the map takes the
          width because it is the only thing here that needs it, and the
          numbers go in the rail because they are what you glance at. */}
      <DependencyGraph analysis={base} live={live} />

      <div className="flex flex-col gap-7 lg:flex-row lg:items-start">
        <div className="flex min-w-0 flex-1 flex-col gap-5">
          <Reconstruction
            derived={d}
            tier={frame.tier_reached}
            unavailableCount={frame.unavailable_checks.reduce(
              (n, g) => n + g.checks.length,
              0,
            )}
          />

          <LiveFindings
            frame={frame}
            flashes={flashes}
            ghosts={ghosts}
            criticalPath={criticalPath}
            jumped={jumped}
          />
        </div>

        <aside className="flex w-full shrink-0 flex-col gap-4 lg:w-[336px]">
          {/* ------------------------------------------------------------
              LIVE INSPECTOR
              The rail is intentionally compact: status first, evidence
              second. It is a glance surface, not another dashboard.
             ------------------------------------------------------------ */}

          <section className="overflow-hidden rounded-xl border border-line bg-panel">
            <div className="border-b border-line bg-panel2/45 px-4 py-3">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-dim">
                    Projected finish
                  </div>
                  <div className="mt-0.5 text-[11px] text-muted-foreground">
                    Live replay estimate
                  </div>
                </div>

                <span
                  className={cn(
                    "inline-flex items-center gap-1.5 rounded-full border px-2 py-1 text-[10px] font-medium",
                    slipped
                      ? "border-severity-high/25 bg-severity-high/5 text-severity-high"
                      : "border-severity-low/25 bg-severity-low/5 text-severity-low",
                  )}
                >
                  <span
                    className={cn(
                      "size-1.5 rounded-full",
                      slipped
                        ? "bg-severity-high"
                        : "bg-severity-low",
                    )}
                  />
                  {slipped ? "At risk" : "On plan"}
                </span>
              </div>
            </div>

            <div className="px-4 py-4">
              <div className="flex items-end justify-between gap-3">
                <div className="min-w-0">
                  <div
                    className={cn(
                      "truncate text-[27px] font-semibold leading-none tracking-[-0.025em]",
                      slipped
                        ? "text-severity-high"
                        : "text-foreground",
                    )}
                  >
                    {p.projected_end_date}
                  </div>

                  <div className="mt-2 font-mono text-[10px] text-muted-foreground">
                    simulated day {Math.round(p.projected_end_day)}
                  </div>
                </div>

                <div
                  className={cn(
                    "shrink-0 text-right text-sm font-semibold",
                    slipped
                      ? "text-severity-high"
                      : "text-severity-low",
                  )}
                >
                  {days(p.slip_days, true)}
                  <div className="mt-0.5 text-[9px] font-normal uppercase tracking-wide text-muted-foreground">
                    vs plan
                  </div>
                </div>
              </div>

              <div className="mt-4 grid grid-cols-2 divide-x divide-line rounded-lg border border-line bg-panel2/35">
                <div className="px-3 py-2.5">
                  <div className="text-[9px] uppercase tracking-wide text-muted-foreground">
                    Planned
                  </div>
                  <div className="mt-1 font-mono text-[12px]">
                    d{Math.round(p.planned_end_day)}
                  </div>
                  {p.planned_end_date && (
                    <div className="mt-0.5 text-[10px] text-muted-foreground">
                      {p.planned_end_date}
                    </div>
                  )}
                </div>

                <div className="px-3 py-2.5">
                  <div className="text-[9px] uppercase tracking-wide text-muted-foreground">
                    Deadline
                  </div>
                  <div
                    className={cn(
                      "mt-1 text-[12px] font-semibold capitalize",
                      p.verdict === "feasible"
                        ? "text-severity-low"
                        : p.verdict === "no_deadline_set"
                          ? "text-foreground"
                          : "text-severity-high",
                    )}
                  >
                    {p.verdict.replace(/_/g, " ")}
                  </div>
                  {p.margin_days !== null && (
                    <div className="mt-0.5 text-[10px] text-muted-foreground">
                      {days(p.margin_days, true)} margin
                    </div>
                  )}
                </div>
              </div>

              <div className="mt-4 border-t border-line pt-3">
                <div className="mb-1.5 flex items-center justify-between">
                  <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                    Open findings
                  </span>
                  <span className="font-mono text-[10px] text-muted-foreground">
                    {frame.findings.length}
                  </span>
                </div>

                <div className="flex items-center gap-1.5">
                  <span className="h-1.5 flex-1 rounded-full bg-severity-high/75" />
                  <span className="h-1.5 flex-1 rounded-full bg-severity-medium/65" />
                  <span className="h-1.5 flex-1 rounded-full bg-line" />
                </div>

                <div className="mt-1.5 flex justify-between font-mono text-[9px] text-muted-foreground">
                  <span>
                    {frame.finding_counts_by_severity.high} high
                  </span>
                  <span>
                    {frame.finding_counts_by_severity.medium} medium
                  </span>
                  <span>
                    {frame.finding_counts_by_severity.low} low
                  </span>
                </div>
              </div>

              <p className="mt-4 border-l-2 border-accent/35 pl-2.5 text-[11px] leading-relaxed text-foreground/80">
                {p.statement}
              </p>

              {p.is_probability === false && (
                <p className="mt-2 text-[10px] leading-relaxed text-muted-foreground">
                  Arithmetic from the critical path, not a probability. The
                  forecast stage contains the probabilistic view.
                </p>
              )}
            </div>
          </section>

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

function Row({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="text-right">{children}</dd>
    </div>
  );
}

/**
 * `step_days` if the payload has it, else the days out of `steps`.
 *
 * `lib/api.ts` types the timeline with `step_days: number[]`; the running
 * backend returns `steps: [{day, date, events}]`. Both are read here rather
 * than one being picked, because `lib/api.ts` is not this agent's file to
 * change and a scrubber with no stops is a scrubber that cannot seek.
 */
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

/* --------------------------------------------------------- the honesty bit */

/**
 * What this frame is, and what it is not.
 *
 * Permanently on screen, immediately under the chart whose numbers it
 * qualifies, and every sentence the backend sent - not a summary of them, and
 * not behind a disclosure. `caveats` is rendered by iteration rather than by
 * key, so a caveat the backend adds tomorrow appears here without a frontend
 * change; the day someone adds one must not be the day it stops showing.
 */
function Reconstruction({
  derived,
  tier,
  unavailableCount,
}: {
  derived: ReplayFrame["derived"];
  tier: number;
  unavailableCount: number;
}) {
  return (
    <section className="border-t border-line pt-2">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-[13px]">
        <span className="font-medium">
          {derived.is_reconstruction
            ? "Reconstruction, not current truth"
            : "Current state"}
        </span>
        <span className="font-mono text-muted-foreground">
          computed at simulated day {derived.computed_at_simulated_day} ·{" "}
          {derived.events_known} of {derived.events_total} events known ·{" "}
          {derived.events_pending} pending · evidence tier {tier}
          {unavailableCount > 0 ? ` · ${unavailableCount} checks could not run` : ""}
        </span>
      </div>
      <ul className="mt-1.5 flex flex-col gap-1">
        {/* Not part of `caveats`, and it belongs with them: the tier at the
            top of this stage is the tier *this frame* reached, and it climbs
            as the replay observes transitions. A reader who took it for the
            project's standing tier would over-read an early frame. */}
        <li className="border-l border-line pl-2.5 text-[12px] leading-snug text-muted-foreground">
          Evidence tier {tier} is what this frame reached, not this
          project&rsquo;s tier today. It is recomputed on every simulated day
          and climbs as the replay observes transitions
          {unavailableCount > 0
            ? `, so the ${unavailableCount} checks listed as unavailable above are the ones this day's evidence could not support.`
            : "."}
        </li>
        {derived.caveats.map((c) => (
          <li
            key={c}
            className="border-l border-line pl-2.5 text-[12px] leading-snug text-muted-foreground"
          >
            {c}
          </li>
        ))}
      </ul>
    </section>
  );
}

/* --------------------------------------------------------------- findings */

function LiveFindings({
  frame,
  flashes,
  ghosts,
  criticalPath,
  jumped,
}: {
  frame: ReplayFrame;
  flashes: Record<string, Flash>;
  ghosts: { key: string; flash: Flash }[];
  criticalPath: Set<string>;
  jumped: boolean;
}) {
  const delta = frame.delta;
  const day = Math.round(frame.clock.sim_day);

  return (
    <section>
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 className="text-sm font-medium">
          What the engine says at simulated day {day}
        </h2>
        <p className="font-mono text-[11px] text-dim">
          {frame.findings.length} open · {delta.appeared.length} appeared ·{" "}
          {delta.cleared.length} cleared · {delta.severity_changed.length}{" "}
          changed severity · {delta.unchanged} unchanged
        </p>
      </div>

      {jumped && (
        <p className="mt-1 text-[11px] text-muted-foreground">
          {frame.reason === "start"
            ? "This is the replay's first frame, so everything the engine found at this simulated day is counted as having appeared. Nothing is highlighted, because nothing has changed yet."
            : `That was a ${frame.reason}, so the counts above are the difference from where the replay was, not things that happened on this simulated day. Nothing is highlighted for a jump.`}
        </p>
      )}

      {frame.findings.length === 0 && ghosts.length === 0 ? (
        <p className="mt-2 border-t border-line pt-2 text-[13px] text-muted-foreground">
          Nothing is open at this simulated day. That is a real result, not an
          empty screen — with {frame.checks_run.length} checks run over the
          events known by day {day}.
        </p>
      ) : (
        <div className="mt-2 divide-y divide-line border-t border-line">
          {/* Cleared findings stay for the length of the highlight, struck
              through, then leave. A finding that vanishes silently is a
              finding nobody saw clear, and "findings clear on their own" is
              half of what this screen is for. */}
          {ghosts.map(({ key, flash }) => (
            <ClearedRow key={key} flash={flash} />
          ))}
          {frame.findings.map((f) => (
            <FindingRow
              key={findingId(f)}
              finding={f}
              flash={flashes[`f:${findingId(f)}`]}
              onCriticalPath={f.task_ids.some((k) => criticalPath.has(k))}
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

function FindingRow({
  finding,
  flash,
  onCriticalPath,
}: {
  finding: Finding;
  flash?: Flash;
  onCriticalPath: boolean;
}) {
  return (
    <div
      className={cn(
        "flex gap-2.5 px-1 py-2",
        FLASH_ROW,
        flash && "bg-foreground/[0.055]",
      )}
    >
      <span
        aria-hidden
        className={cn(
          "w-0.5 shrink-0 self-stretch rounded-full",
          severityFill(finding.severity),
        )}
      />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <span className="font-mono text-xs">{finding.task_ids.join(" ")}</span>
          <span className="text-[13px] font-medium">
            {prettyKind(finding.kind)}
          </span>
          <span className={cn("text-[11px]", severityText(finding.severity))}>
            {finding.severity}
          </span>
          {onCriticalPath && (
            <span className="text-[11px] text-accent">critical path</span>
          )}
          <span className="text-[11px] text-muted-foreground">
            tier {finding.tier} · {finding.tier_name}
          </span>
          {flash && (
            <Badge variant="outline" className="text-[10px]">
              {flash.kind === "appeared"
                ? `appeared d${Math.round(flash.day)}`
                : `${flash.from} → ${flash.severity} at d${Math.round(flash.day)}`}
            </Badge>
          )}
          <span className="ml-auto flex items-baseline gap-2">
            <Worked>{finding.impact.worked}</Worked>
            <span className="text-[13px] font-semibold">
              {Math.round(finding.impact_score)}
            </span>
          </span>
        </div>
        <p className="mt-1 text-[13px] leading-snug text-foreground/90">
          {finding.explanation}
        </p>
        <p className="mt-0.5 text-[13px] leading-snug">
          <span className="text-muted-foreground">Do this: </span>
          {finding.suggested_action}
        </p>
      </div>
    </div>
  );
}

function ClearedRow({ flash }: { flash: Flash }) {
  const gone = flash.cleared;
  if (!gone) return null;
  return (
    <div className={cn("flex gap-2.5 px-1 py-2 opacity-70", FLASH_ROW)}>
      <span
        aria-hidden
        className={cn(
          "w-0.5 shrink-0 self-stretch rounded-full opacity-40",
          severityFill(flash.severity),
        )}
      />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 line-through decoration-1">
          <span className="font-mono text-xs">{gone.task_ids.join(" ")}</span>
          <span className="text-[13px] font-medium">
            {prettyKind(gone.kind)}
          </span>
          <span className={cn("text-[11px]", severityText(flash.severity))}>
            was {flash.severity}
          </span>
        </div>
        <p className="mt-1 text-[13px] leading-snug text-muted-foreground">
          Cleared at simulated day {Math.round(flash.day)}. It said:{" "}
          {gone.explanation_was}
        </p>
      </div>
    </div>
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
      <div className="border-b border-line bg-panel2/45 px-4 py-3">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-1.5 text-[10px] font-semibold tracking-[0.12em] text-dim uppercase">
            <Radio
              className={cn(
                "size-3",
                connected ? "text-accent" : "opacity-40",
              )}
              aria-hidden
            />
            Events observed
          </div>
          <span className="font-mono text-[10px] text-muted-foreground">
            {known} / {total}
          </span>
        </div>
      </div>

      {events.length === 0 ? (
        <p className="px-4 py-4 text-[11px] leading-relaxed text-muted-foreground">
          {total === 0
            ? "This project has no event log at all, so there is nothing to replay and no observed evidence to reason from. That is why the tier above is 0 and why so many checks could not run."
            : `No transition has been observed at this simulated day yet. All ${total} in this project's log happen later and are not reflected in any number on this screen.`}
        </p>
      ) : (
        <ul className="flex max-h-[420px] flex-col divide-y divide-line overflow-y-auto">
          {events.map((e) => {
            const flash = flashes[`e:${e.day}|${e.task_key}|${e.to_status}`];
            return (
              <li
                key={`${e.day}|${e.task_key}|${e.to_status}`}
                className={cn(
                  "px-1 py-1.5 text-[12px]",
                  FLASH_ROW,
                  flash && "bg-foreground/[0.055]",
                )}
              >
                <div className="flex items-baseline gap-1.5">
                  <span className="font-mono text-[11px] text-muted-foreground">
                    d{Math.round(e.day)}
                  </span>
                  <span className="font-mono text-[11px]">{e.task_key}</span>
                  <span className="ml-auto font-mono text-[10px] text-muted-foreground">
                    {e.date}
                  </span>
                </div>
                <div className="truncate text-foreground/90">
                  {e.task_name || taskNames[e.task_key] || e.task_key}
                </div>
                <div className="text-[11px] text-muted-foreground">
                  {STATUS_WORD[e.from_status] ?? e.from_status} →{" "}
                  <span className="text-foreground/90">
                    {STATUS_WORD[e.to_status] ?? e.to_status}
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
