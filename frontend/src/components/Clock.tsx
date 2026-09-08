"use client";

/**
 * The simulated clock.
 *
 * It reports the day the engine last computed a frame for, and nothing else.
 *
 * It would have been easy to make this tick smoothly: `speed` and
 * `seconds_per_simulated_day` are both in every state payload, so the browser
 * could interpolate between frames and the digits would roll like a real
 * clock. That was rejected. An interpolated clock shows a simulated day that
 * the engine never evaluated, sitting next to a projected finish that was
 * computed at a different day - which is the precise shape of the mistake
 * this whole product exists to avoid. So the clock steps when a frame lands,
 * one whole simulated day at a time, and the pace comes from the replay's own
 * speed rather than from a `requestAnimationFrame` loop of ours.
 *
 * Everything here is laid out so nothing reflows when a digit changes. Days
 * and dates sit in fixed slots, the state word has a fixed width, and the
 * whole element is one stable subtree - `LiveFeed` never keys or remounts it,
 * because a clock that remounts is a clock that flickers.
 */

import { Pause, Play, Square } from "lucide-react";
import { cn } from "@/lib/utils";

/** The three things a replay can be doing. Not a severity; not coloured. */
export type ClockState = "running" | "paused" | "ended";

export default function Clock({
  simDay,
  simDate,
  startDay = 0,
  horizonDay,
  horizonDate,
  percentComplete,
  state = "running",
  secondsPerDay,
  speed,
}: {
  simDay: number;
  simDate?: string;
  startDay?: number;
  horizonDay?: number;
  horizonDate?: string;
  percentComplete?: number;
  state?: ClockState;
  /** Real seconds one simulated day takes at the current speed. */
  secondsPerDay?: number;
  /** Simulated days per real minute - the unit the API uses (D-138). */
  speed?: number;
}) {
  const Icon = state === "running" ? Play : state === "paused" ? Pause : Square;
  const word =
    state === "running" ? "running" : state === "paused" ? "paused" : "ended";

  const span =
    horizonDay === undefined ? null : Math.max(1e-9, horizonDay - startDay);
  const pct =
    percentComplete !== undefined
      ? percentComplete
      : span === null
        ? 0
        : ((simDay - startDay) / span) * 100;

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline gap-3">
        {/* The date is the headline because it is what a person reads; the
            day number is the engine's unit and rides beside it in mono. */}
        <div className="text-2xl leading-none font-semibold">
          {simDate ?? `day ${Math.round(simDay)}`}
        </div>
        <div className="font-mono text-sm text-muted-foreground">
          d{Math.round(simDay * 10) / 10}
        </div>
        <div
          className={cn(
            "flex items-center gap-1 text-[11px] tracking-wide uppercase",
            state === "running" ? "text-foreground" : "text-muted-foreground",
          )}
        >
          <Icon className="size-3" aria-hidden />
          {word}
        </div>
      </div>

      {/* Progress through the replay, not progress of the project. Labelled
          as such, because those are two very different numbers and this bar
          is the one a reader is most likely to mistake for the other. */}
      <div
        className="h-[3px] w-full overflow-hidden rounded-full bg-panel2"
        role="progressbar"
        aria-label="Replay progress through the simulated window"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(pct)}
      >
        <div
          className="h-full bg-foreground/40 transition-[width] duration-200 ease-linear motion-reduce:transition-none"
          style={{ width: `${Math.min(100, Math.max(0, pct))}%` }}
        />
      </div>

      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 text-[11px] text-muted-foreground">
        <span>
          simulated window d{Math.round(startDay)}&ndash;d
          {horizonDay === undefined ? "?" : Math.round(horizonDay)}
          {horizonDate ? ` · ends ${horizonDate}` : ""}
        </span>
        {secondsPerDay !== undefined && (
          <span className="font-mono">
            {formatPace(secondsPerDay)}
            {speed !== undefined ? ` · speed ${speed} sim-days/min` : ""}
          </span>
        )}
      </div>
    </div>
  );
}

/**
 * The pace, in the direction a person reads it.
 *
 * The API's unit is simulated days per real minute (D-138), which is exact
 * and unambiguous but is not how anybody thinks about watching something. So
 * the raw unit is printed too, right beside this, rather than replaced by it.
 */
export function formatPace(secondsPerDay: number): string {
  if (secondsPerDay >= 1) {
    const s = Math.round(secondsPerDay * 10) / 10;
    return `1 simulated day every ${s}s`;
  }
  const perSecond = Math.round((1 / secondsPerDay) * 10) / 10;
  return `${perSecond} simulated days a second`;
}
