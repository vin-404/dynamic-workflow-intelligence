"use client";

/**
 * FlowTrace Replay Controls
 *
 * Controls the shared project replay:
 * - play / pause
 * - restart
 * - simulation speed
 * - timeline scrubbing
 * - keyboard navigation
 *
 * The component does not make requests itself. All actions are callbacks
 * supplied by LiveFeed, while displayed state comes from the replay stream.
 */

import { useMemo, useRef, useState } from "react";
import {
  Activity,
  Pause,
  Play,
  RotateCcw,
  Zap,
} from "lucide-react";

import { Button } from "@/components/ui/button";

import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

import { ReplayState } from "@/lib/api";
import { cn } from "@/lib/utils";
import { formatPace } from "@/components/Clock";

/**
 * Speed ladder.
 *
 * The API expects simulated days per real minute.
 */
export const SPEEDS = [15, 30, 60, 180, 600] as const;

export default function ReplayControls({
  state,
  simDay,
  stepDays,
  eventDaysByDay,
  pending,
  onPlayPause,
  onRestart,
  onSeek,
  onSpeed,
}: {
  state: ReplayState | null;
  simDay: number;
  stepDays: number[];
  eventDaysByDay: Record<number, number>;
  pending: boolean;
  onPlayPause: () => void;
  onRestart: () => void;
  onSeek: (day: number) => void;
  onSpeed: (speed: number) => void;
}) {
  const [dragDay, setDragDay] = useState<number | null>(null);

  const keyTarget = useRef<{
    day: number;
    at: number;
  } | null>(null);

  const start =
    state?.start_day ??
    stepDays[0] ??
    0;

  const horizon =
    state?.horizon_day ??
    stepDays[stepDays.length - 1] ??
    1;

  const span = Math.max(
    1e-9,
    horizon - start,
  );

  const shown =
    dragDay ?? simDay;

  const pct = Math.min(
    100,
    Math.max(
      0,
      ((shown - start) / span) * 100,
    ),
  );

  const snap = useMemo(() => {
    return (day: number) => {
      if (!stepDays.length) {
        return day;
      }

      let best = stepDays[0];

      for (const d of stepDays) {
        if (
          Math.abs(d - day) <
          Math.abs(best - day)
        ) {
          best = d;
        }
      }

      return best;
    };
  }, [stepDays]);

  const finished =
    state?.finished ?? false;

  const paused =
    state?.paused ?? false;

  const stopped =
    state?.stopped ?? false;

  const disabled =
    !state || stopped;

  function commit() {
    if (dragDay === null) {
      return;
    }

    const target = snap(dragDay);

    setDragDay(null);
    onSeek(target);
  }

  function onKey(
    e: React.KeyboardEvent<HTMLInputElement>,
  ) {
    if (!stepDays.length) {
      return;
    }

    const recent =
      keyTarget.current;

    const here =
      recent &&
      Date.now() - recent.at < 500
        ? recent.day
        : snap(
            dragDay ?? simDay,
          );

    const at =
      stepDays.indexOf(here);

    let next: number | null =
      null;

    if (
      e.key === "ArrowRight" ||
      e.key === "ArrowUp"
    ) {
      next =
        stepDays[
          Math.min(
            stepDays.length - 1,
            at + 1,
          )
        ];
    } else if (
      e.key === "ArrowLeft" ||
      e.key === "ArrowDown"
    ) {
      next =
        stepDays[
          Math.max(0, at - 1)
        ];
    } else if (
      e.key === "PageUp"
    ) {
      next =
        stepDays[
          Math.min(
            stepDays.length - 1,
            at + 5,
          )
        ];
    } else if (
      e.key === "PageDown"
    ) {
      next =
        stepDays[
          Math.max(0, at - 5)
        ];
    } else if (
      e.key === "Home"
    ) {
      next = stepDays[0];
    } else if (
      e.key === "End"
    ) {
      next =
        stepDays[
          stepDays.length - 1
        ];
    }

    if (next === null) {
      return;
    }

    e.preventDefault();

    setDragDay(null);

    keyTarget.current = {
      day: next,
      at: Date.now(),
    };

    if (
      next !== here ||
      dragDay !== null
    ) {
      onSeek(next);
    }
  }

  const modeLabel = finished
    ? "Complete"
    : paused
      ? "Paused"
      : "Running";

  const modeClass = finished
    ? "border-line bg-panel2 text-dim"
    : paused
      ? "border-line bg-panel2 text-dim"
      : "border-accent/30 bg-accent/10 text-accent";

  return (
    <div
      className="flex flex-col gap-3"
      aria-busy={pending}
    >
      {/* --------------------------------------------------
          CONTROL HEADER
          -------------------------------------------------- */}

      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="default"
          size="sm"
          disabled={disabled}
          onClick={onPlayPause}
          className="h-8 min-w-[88px]"
        >
          {paused || finished ? (
            <Play data-icon="inline-start" />
          ) : (
            <Pause data-icon="inline-start" />
          )}

          {paused || finished
            ? "Play"
            : "Pause"}
        </Button>

        <Button
          variant="outline"
          size="sm"
          disabled={disabled}
          onClick={onRestart}
          title="Back to the first simulated day"
          className="h-8"
        >
          <RotateCcw data-icon="inline-start" />
          Restart
        </Button>

        <Select
          value={String(
            state?.speed ?? 60,
          )}
          disabled={disabled}
          onValueChange={(value) =>
            onSpeed(Number(value))
          }
        >
          <SelectTrigger
            size="sm"
            aria-label="Replay speed"
            className="h-8 w-[150px]"
          >
            <div className="flex items-center gap-2">
              <Zap className="size-3.5 text-accent" />
              <SelectValue />
            </div>
          </SelectTrigger>

          <SelectContent>
            <SelectGroup>
              {SPEEDS.map((speed) => (
                <SelectItem
                  key={speed}
                  value={String(speed)}
                >
                  <span>
                    {formatPace(
                      60 / speed,
                    )}
                  </span>

                  <span className="ml-2 font-mono text-xs text-muted-foreground">
                    {speed}/min
                  </span>
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>

        <div
          className={cn(
            "ml-0 flex h-8 items-center gap-1.5 rounded-md border px-2.5 font-mono text-[10px] uppercase tracking-[0.08em]",
            modeClass,
          )}
        >
          <span
            className={cn(
              "size-1.5 rounded-full",
              finished
                ? "bg-dim"
                : paused
                  ? "bg-dim"
                  : "animate-pulse bg-accent",
            )}
          />

          {modeLabel}
        </div>

        <div className="ml-auto flex items-center gap-3 font-mono text-[10px] text-muted-foreground">
          <span className="hidden sm:inline">
            {stepDays.length} stops
          </span>

          <span className="hidden sm:inline text-line">
            /
          </span>

          <span>
            {state?.events_total ?? 0} events
          </span>

          <span className="hidden sm:inline text-line">
            /
          </span>

          <span className="flex items-center gap-1">
            <Activity className="size-3" />
            {state?.subscribers ?? 0}
          </span>
        </div>
      </div>

      {/* --------------------------------------------------
          TIMELINE
          -------------------------------------------------- */}

      <div className="rounded-lg border border-line bg-panel px-3 py-2.5">
        <div className="mb-2 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="text-[10px] font-medium uppercase tracking-[0.12em] text-dim">
              Replay timeline
            </span>

            <span className="font-mono text-[10px] text-muted-foreground">
              d{Math.round(shown)}
            </span>
          </div>

          <span className="font-mono text-[10px] text-muted-foreground">
            {dragDay !== null
              ? `seeking d${Math.round(
                  snap(dragDay),
                )}`
              : `d${Math.round(
                  start,
                )} — d${Math.round(
                  horizon,
                )}`}
          </span>
        </div>

        <div className="relative h-8 w-full select-none">
          {/* Rail */}

          <div className="absolute inset-x-0 top-3.5 h-1 -translate-y-1/2 rounded-full bg-panel2" />

          {/* Progress */}

          <div
            className="absolute top-3.5 left-0 h-1 -translate-y-1/2 rounded-full bg-accent"
            style={{
              width: `${pct}%`,
            }}
          />

          {/* Timeline stops */}

          {stepDays.map((day) => {
            const events =
              eventDaysByDay[day] ??
              0;

            const position =
              ((day - start) /
                span) *
              100;

            return (
              <span
                key={day}
                title={
                  events
                    ? `day ${day} · ${events} event${
                        events === 1
                          ? ""
                          : "s"
                      }`
                    : `day ${day} · no event, but the clock still steps here`
                }
                className={cn(
                  "absolute w-px -translate-x-1/2 rounded-full",
                  events
                    ? "top-[15px] h-3 bg-foreground/55"
                    : "top-[17px] h-2 bg-line",
                )}
                style={{
                  left: `${position}%`,
                }}
              />
            );
          })}

          {/* Scrubber */}

          <input
            type="range"
            aria-label="Scrub to a simulated day"
            min={start}
            max={horizon}
            step="any"
            value={shown}
            disabled={disabled}
            onChange={(event) =>
              setDragDay(
                Number(
                  event.target.value,
                ),
              )
            }
            onPointerUp={commit}
            onPointerCancel={commit}
            onKeyDown={onKey}
            onBlur={commit}
            className={cn(
              "absolute inset-x-0 top-0 h-7 w-full cursor-pointer appearance-none bg-transparent",
              "focus-visible:outline-none",
              "[&::-webkit-slider-runnable-track]:h-7",
              "[&::-webkit-slider-runnable-track]:bg-transparent",
              "[&::-webkit-slider-thumb]:size-3.5",
              "[&::-webkit-slider-thumb]:appearance-none",
              "[&::-webkit-slider-thumb]:rounded-full",
              "[&::-webkit-slider-thumb]:border-2",
              "[&::-webkit-slider-thumb]:border-panel",
              "[&::-webkit-slider-thumb]:bg-foreground",
              "[&::-webkit-slider-thumb]:shadow-sm",
              "[&::-moz-range-track]:h-7",
              "[&::-moz-range-track]:bg-transparent",
              "[&::-moz-range-thumb]:size-3.5",
              "[&::-moz-range-thumb]:rounded-full",
              "[&::-moz-range-thumb]:border-2",
              "[&::-moz-range-thumb]:border-panel",
              "[&::-moz-range-thumb]:bg-foreground",
              "disabled:cursor-not-allowed disabled:opacity-50",
            )}
          />
        </div>

        {/* Timeline labels */}

        <div className="flex items-center justify-between font-mono text-[9px] text-muted-foreground">
          <span>
            d{Math.round(start)}
          </span>

          <span>
            {dragDay !== null
              ? `seek → d${Math.round(
                  snap(dragDay),
                )}`
              : "event marks show replay stops"}
          </span>

          <span>
            d{Math.round(horizon)}
          </span>
        </div>
      </div>

      {/* --------------------------------------------------
          KEYBOARD HINT
          -------------------------------------------------- */}

      <div className="flex items-center justify-between text-[10px] text-muted-foreground">
        <span>
          Drag to seek · ← → move between
          events · Home / End jump
        </span>

        {pending && (
          <span className="font-mono text-accent">
            syncing replay…
          </span>
        )}
      </div>
    </div>
  );
}