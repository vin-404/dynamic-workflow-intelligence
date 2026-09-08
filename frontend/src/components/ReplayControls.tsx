"use client";

/**
 * Play, pause, speed, scrub, restart.
 *
 * This component issues no requests. Every control is a callback and every
 * piece of displayed state comes from the last `ReplayState` the stream
 * delivered, which means the buttons say what the *server's* replay is doing
 * rather than what this browser last asked for. That matters because a replay
 * is shared: someone else pausing it has to make this pause button change,
 * and it does, because the `control` SSE event carries a new `ReplayState` to
 * every viewer (D-141).
 *
 * The scrubber
 * ------------
 * Its stops come from `GET /replay/timeline`, so you can seek to a simulated
 * day the replay has not reached yet - the point of having a timeline
 * endpoint at all. The rail is drawn in *day* space rather than in
 * step-index space so that the ticks, the event marks and the thumb all agree
 * even when the steps are not evenly spaced; the dragged value is snapped to
 * the nearest real stop before it is sent, because seeking to day 4.37 would
 * ask the engine for a frame between two frames.
 *
 * While a drag is in progress the thumb follows the pointer and incoming
 * frames are ignored for position only - otherwise the replay would drag the
 * handle out from under the user's finger. The commit happens on pointer-up,
 * key-up and blur, not on every input event, so a drag across a fourteen-day
 * project is one seek and not forty.
 */

import { useMemo, useRef, useState } from "react";
import { Pause, Play, RotateCcw } from "lucide-react";
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
 * The speed ladder, in the API's unit: simulated days per real minute.
 *
 * 60 is the API's own default and means one simulated day a second (D-138),
 * which is the pace the demo is written for. The labels state the derived
 * unit because "60" alone is not a pace anybody can picture, and the raw
 * number is kept beside it because it is the number the API actually takes.
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
  /** The day of the last frame - authoritative, not the state's cursor. */
  simDay: number;
  /** Every simulated day the replay will stop on. */
  stepDays: number[];
  /** How many events land on each of those days. */
  eventDaysByDay: Record<number, number>;
  pending: boolean;
  onPlayPause: () => void;
  onRestart: () => void;
  onSeek: (day: number) => void;
  onSpeed: (speed: number) => void;
}) {
  /** Non-null only while a pointer drag is in progress. */
  const [dragDay, setDragDay] = useState<number | null>(null);
  /**
   * The last stop an arrow key asked for, and when.
   *
   * A seek is a round trip: the day this component renders only moves once
   * the resulting frame comes back over the stream. Without this, two arrow
   * presses in quick succession both compute "one stop on from day 3" and
   * both ask for day 4. It carries a timestamp because the replay also
   * advances on its own, so a target more than half a second old is not where
   * the replay is any more and must not be trusted.
   */
  const keyTarget = useRef<{ day: number; at: number } | null>(null);

  const start = state?.start_day ?? stepDays[0] ?? 0;
  const horizon = state?.horizon_day ?? stepDays[stepDays.length - 1] ?? 1;
  const span = Math.max(1e-9, horizon - start);

  const shown = dragDay ?? simDay;
  const pct = Math.min(100, Math.max(0, ((shown - start) / span) * 100));

  const snap = useMemo(() => {
    return (day: number) => {
      if (!stepDays.length) return day;
      let best = stepDays[0];
      for (const d of stepDays) {
        if (Math.abs(d - day) < Math.abs(best - day)) best = d;
      }
      return best;
    };
  }, [stepDays]);

  const finished = state?.finished ?? false;
  const paused = state?.paused ?? false;
  /**
   * `pending` deliberately does **not** disable anything.
   *
   * A control round trip is ~10 ms, and disabling the range input for even
   * that long makes the browser blur it - so a second arrow key press lands
   * nowhere and keyboard scrubbing appears to stop after one stop. Found by
   * driving it. Every control here is idempotent (pausing a paused replay,
   * seeking to the day you are on), so the cost of a double send is nothing
   * and the cost of the guard was a broken keyboard.
   */
  const disabled = !state || state.stopped;

  function commit() {
    if (dragDay === null) return;
    const target = snap(dragDay);
    setDragDay(null);
    onSeek(target);
  }

  /**
   * Arrow keys move stop to stop, not by a fraction of the axis.
   *
   * `step="any"` is what lets a mouse drag be continuous, but it also makes a
   * browser's arrow key move by a hundredth of the range - which on a
   * fourteen-day project is 0.14 of a day, snaps straight back to the stop it
   * started on, and makes the scrubber look broken from the keyboard. Found
   * by driving it, not by reading it. So the keys are handled here and each
   * press is one real stop.
   */
  function onKey(e: React.KeyboardEvent<HTMLInputElement>) {
    if (!stepDays.length) return;
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
    if (next === null) return;
    e.preventDefault();
    setDragDay(null);
    keyTarget.current = { day: next, at: Date.now() };
    if (next !== here || dragDay !== null) onSeek(next);
  }

  return (
    <div className="flex flex-col gap-2" aria-busy={pending}>
      {/* No `aria-label` on the two buttons that carry visible text: an
          aria-label replaces the accessible name outright, so "Play" labelled
          "Resume the replay" is a control a voice user cannot address by the
          word printed on it. The text is the label. */}
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          disabled={disabled}
          onClick={onPlayPause}
        >
          {paused || finished ? (
            <Play data-icon="inline-start" />
          ) : (
            <Pause data-icon="inline-start" />
          )}
          {paused || finished ? "Play" : "Pause"}
        </Button>

        <Button
          variant="ghost"
          size="sm"
          disabled={disabled}
          onClick={onRestart}
          title="Back to the first simulated day"
        >
          <RotateCcw data-icon="inline-start" />
          Restart
        </Button>

        <Select
          value={String(state?.speed ?? 60)}
          disabled={disabled}
          onValueChange={(v) => onSpeed(Number(v))}
        >
          <SelectTrigger size="sm" aria-label="Replay speed">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              {SPEEDS.map((s) => (
                <SelectItem key={s} value={String(s)}>
                  {formatPace(60 / s)}
                  <span className="ml-2 font-mono text-muted-foreground">
                    {s}/min
                  </span>
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>

        <span className="ml-auto font-mono text-[11px] text-muted-foreground">
          {stepDays.length} stops · {state?.events_total ?? 0} events ·{" "}
          {state?.subscribers ?? 0} watching
        </span>
      </div>

      {/* The scrubber. The rail, the ticks and the thumb are all in day space,
          so a tick is under the thumb when the thumb is on that day. */}
      <div className="relative h-7 w-full select-none">
        <div className="absolute inset-x-0 top-3 h-[3px] -translate-y-1/2 rounded-full bg-panel2" />
        <div
          className="absolute top-3 left-0 h-[3px] -translate-y-1/2 rounded-full bg-foreground/45"
          style={{ width: `${pct}%` }}
        />

        {stepDays.map((d) => {
          const events = eventDaysByDay[d] ?? 0;
          return (
            <span
              key={d}
              title={
                events
                  ? `day ${d} · ${events} event${events === 1 ? "" : "s"}`
                  : `day ${d} · no event, but the clock still steps here`
              }
              className={cn(
                "absolute w-px -translate-x-1/2 rounded-full",
                events
                  ? "top-[18px] h-[9px] bg-foreground/55"
                  : "top-[19px] h-[5px] bg-line",
              )}
              style={{ left: `${((d - start) / span) * 100}%` }}
            />
          );
        })}

        <input
          type="range"
          aria-label="Scrub to a simulated day"
          min={start}
          max={horizon}
          step="any"
          value={shown}
          disabled={disabled}
          onChange={(e) => setDragDay(Number(e.target.value))}
          onPointerUp={commit}
          onPointerCancel={commit}
          onKeyDown={onKey}
          onBlur={commit}
          className={cn(
            "absolute inset-x-0 top-0 h-6 w-full cursor-pointer appearance-none bg-transparent",
            "focus-visible:outline-none",
            "[&::-webkit-slider-runnable-track]:h-6 [&::-webkit-slider-runnable-track]:bg-transparent",
            "[&::-webkit-slider-thumb]:size-3 [&::-webkit-slider-thumb]:appearance-none",
            "[&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:border-2",
            "[&::-webkit-slider-thumb]:border-panel [&::-webkit-slider-thumb]:bg-foreground",
            "[&::-moz-range-track]:h-6 [&::-moz-range-track]:bg-transparent",
            "[&::-moz-range-thumb]:size-3 [&::-moz-range-thumb]:rounded-full",
            "[&::-moz-range-thumb]:border-2 [&::-moz-range-thumb]:border-panel",
            "[&::-moz-range-thumb]:bg-foreground",
            "disabled:cursor-not-allowed disabled:opacity-50",
          )}
        />
      </div>

      <div className="flex items-baseline justify-between font-mono text-[10px] text-muted-foreground">
        <span>d{Math.round(start)}</span>
        <span className={cn(dragDay !== null && "text-foreground")}>
          {dragDay !== null
            ? `seek to d${Math.round(snap(dragDay))}`
            : "taller marks are days an event lands on"}
        </span>
        <span>d{Math.round(horizon)}</span>
      </div>
    </div>
  );
}
