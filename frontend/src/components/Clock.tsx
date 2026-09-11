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
 * Presentation (design brief §3, last bullet): the calendar date is the one
 * headline figure of its panel, the simulated day number sits under it in
 * words ("Simulated day 7"), and the state is a plain-word chip - "Running",
 * "Paused", "Ended" - never a shouted label. Everything is laid out so nothing
 * reflows when a digit changes, and `LiveFeed` never keys or remounts it,
 * because a clock that remounts is a clock that flickers.
 */

import { Pause, Play, Square } from "lucide-react";
import { calendarDate } from "@/lib/display";
import { cn } from "@/lib/utils";

/** The three things a replay can be doing. Not a severity; not coloured. */
export type ClockState = "running" | "paused" | "ended";

const STATE_WORD: Record<ClockState, string> = {
  running: "Running",
  paused: "Paused",
  ended: "Ended",
};

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
  const day = Math.round(simDay);
  const date = calendarDate(simDate);
  const horizon = horizonDay === undefined ? null : Math.round(horizonDay);
  const horizonText = calendarDate(horizonDate);

  const span =
    horizonDay === undefined ? null : Math.max(1e-9, horizonDay - startDay);
  const pct =
    percentComplete !== undefined
      ? percentComplete
      : span === null
        ? 0
        : ((simDay - startDay) / span) * 100;

  /* The pace rides on the chip as hover text rather than as another line:
     the speed control beside the clock already says it in full. */
  const pace =
    secondsPerDay !== undefined
      ? `${formatPace(secondsPerDay)}${speed !== undefined ? ` · ${speed} simulated days per real minute` : ""}`
      : undefined;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        {/* The date is the headline because it is what a person reads; the
            engine's unit - the day number - is the line under it. */}
        <div className="text-[36px] font-semibold leading-none tracking-[-0.02em]">
          {date ?? `Day ${day}`}
        </div>
        <span
          title={pace}
          className={cn(
            "inline-flex h-6 items-center gap-1.5 rounded-full border px-2.5 text-[12px] font-medium",
            state === "running"
              ? "border-accent/30 bg-accent/10 text-accent"
              : "border-line bg-panel2 text-dim",
          )}
        >
          <Icon className="size-3" aria-hidden />
          {STATE_WORD[state]}
        </span>
      </div>

      <div className="text-[14px]">
        Simulated day {day}
        {horizon !== null && (
          <span className="text-dim">
            {" "}
            of {Math.round(startDay)}&ndash;{horizon}
            {horizonText ? ` · the window ends ${horizonText}` : ""}
          </span>
        )}
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

/**
 * The same pace, short enough for a control that must not clip at 1280px:
 * "1 day every 4s", "10 days a second". The full sentence goes in the
 * control's title.
 */
export function shortPace(secondsPerDay: number): string {
  if (secondsPerDay >= 1) {
    const s = Math.round(secondsPerDay * 10) / 10;
    return `1 day every ${s}s`;
  }
  const perSecond = Math.round((1 / secondsPerDay) * 10) / 10;
  return `${perSecond} days a second`;
}
