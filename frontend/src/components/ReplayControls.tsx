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
 *
 * Presentation: this sits beside the clock in the clock's panel, so it says
 * nothing the clock already says - the state chip lives there. The speed
 * control shows a short pace ("1 day every 1s") so it cannot clip at 1280px;
 * the full sentence and the API's unit are in its title and in the list.
 */

import { useMemo, useRef, useState } from "react";
import { Pause, Play, RotateCcw, Zap } from "lucide-react";

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
import { formatPace, shortPace } from "@/components/Clock";

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

  const start = state?.start_day ?? stepDays[0] ?? 0;

  const horizon = state?.horizon_day ?? stepDays[stepDays.length - 1] ?? 1;

  const span = Math.max(1e-9, horizon - start);

  const shown = dragDay ?? simDay;

  const pct = Math.min(100, Math.max(0, ((shown - start) / span) * 100));

  const snap = useMemo(() => {
    return (day: number) => {
      if (!stepDays.length) {
        return day;
      }

      let best = stepDays[0];

      for (const d of stepDays) {
        if (Math.abs(d - day) < Math.abs(best - day)) {
          best = d;
        }
      }

      return best;
    };
  }, [stepDays]);

  const finished = state?.finished ?? false;

  const paused = state?.paused ?? false;

  const stopped = state?.stopped ?? false;

  const disabled = !state || stopped;

  const speed = state?.speed ?? 60;

  function commit() {
    if (dragDay === null) {
      return;
    }

    const target = snap(dragDay);

    setDragDay(null);
    onSeek(target);
  }

  function onKey(e: React.KeyboardEvent<HTMLInputElement>) {
    if (!stepDays.length) {
      return;
    }

    const recent = keyTarget.current;

    const here =
      recent && Date.now() - recent.at < 500
        ? recent.day
        : snap(dragDay ?? simDay);

    const at = stepDays.indexOf(here);

    let next: number | null = null;

    if (e.key === "ArrowRight" || e.key === "ArrowUp") {
      next = stepDays[Math.min(stepDays.length - 1, at + 1)];
    } else if (e.key === "ArrowLeft" || e.key === "ArrowDown") {
      next = stepDays[Math.max(0, at - 1)];
    } else if (e.key === "PageUp") {
      next = stepDays[Math.min(stepDays.length - 1, at + 5)];
    } else if (e.key === "PageDown") {
      next = stepDays[Math.max(0, at - 5)];
    } else if (e.key === "Home") {
      next = stepDays[0];
    } else if (e.key === "End") {
      next = stepDays[stepDays.length - 1];
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

    if (next !== here || dragDay !== null) {
      onSeek(next);
    }
  }

  const watching = state?.subscribers ?? 0;

  return (
    <div className="flex flex-col gap-3" aria-busy={pending}>
      {/* --------------------------------------------------
          CONTROL ROW
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

          {paused || finished ? "Play" : "Pause"}
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
          value={String(speed)}
          disabled={disabled}
          onValueChange={(value) => onSpeed(Number(value))}
        >
          <SelectTrigger
            size="sm"
            aria-label="Replay speed"
            title={`${formatPace(60 / speed)} · ${speed} simulated days per real minute`}
            className="h-8 min-w-[176px] text-[14px]"
          >
            <div className="flex items-center gap-2">
              <Zap className="size-3.5 text-accent" aria-hidden />
              <SelectValue>{shortPace(60 / speed)}</SelectValue>
            </div>
          </SelectTrigger>

          <SelectContent>
            <SelectGroup>
              {SPEEDS.map((s) => (
                <SelectItem key={s} value={String(s)}>
                  <span className="text-[14px]">{formatPace(60 / s)}</span>

                  <span className="ml-2 text-[12px] text-dim">
                    {s} days per minute
                  </span>
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>

        <span className="ml-auto text-[12px] text-dim">
          {stepDays.length} stops · {state?.events_total ?? 0} events ·{" "}
          {watching} {watching === 1 ? "viewer" : "viewers"}
        </span>
      </div>

      {/* --------------------------------------------------
          TIMELINE
          -------------------------------------------------- */}

      <div>
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
            const events = eventDaysByDay[day] ?? 0;

            const position = ((day - start) / span) * 100;

            return (
              <span
                key={day}
                title={
                  events
                    ? `Day ${day} · ${events} event${events === 1 ? "" : "s"}`
                    : `Day ${day} · no event, but the clock still steps here`
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
            // The site-wide rule `.flowtrace-site input { background: var(--panel) !important }`
            // paints this strip opaque, hiding the rail and the stops under it.
            // A class cannot beat `!important` and React's style prop cannot
            // carry it, so the one property is set with the same priority.
            ref={(el) =>
              el?.style.setProperty("background", "transparent", "important")
            }
            min={start}
            max={horizon}
            step="any"
            value={shown}
            disabled={disabled}
            onChange={(event) => setDragDay(Number(event.target.value))}
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

        <div className="flex items-baseline justify-between gap-3 text-[12px] text-dim">
          <span>Day {Math.round(start)}</span>

          <span className={cn(dragDay !== null && "text-foreground")}>
            {dragDay !== null
              ? `Seek to day ${Math.round(snap(dragDay))}`
              : pending
                ? "Syncing the replay…"
                : "Drag to seek · arrow keys step a day · Home and End jump to the ends"}
          </span>

          <span>Day {Math.round(horizon)}</span>
        </div>
      </div>
    </div>
  );
}
