"use client";

/**
 * Shared primitives.
 *
 * Two of these carry product commitments rather than styling:
 * `TierBanner` shows how far the evidence reached and what could not be
 * assessed, and `Assumptions` shows what an estimate rests on. Both appear
 * wherever a number does, because a number without its limits is the thing
 * this project is written against.
 */

import { ReactNode, useState } from "react";

/* ------------------------------------------------------------- containers */

export function Card({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={`bg-panel border border-line rounded-lg p-4 ${className}`}>
      {children}
    </div>
  );
}

export function CardTitle({
  children,
  right,
}: {
  children: ReactNode;
  right?: ReactNode;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3 mb-3">
      <h2 className="text-[13px] uppercase tracking-wider text-dim font-medium">
        {children}
      </h2>
      {right}
    </div>
  );
}

export function Section({
  title,
  subtitle,
  children,
  right,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
  right?: ReactNode;
}) {
  return (
    <section className="mb-6">
      <div className="flex items-start justify-between gap-4 mb-3">
        <div>
          <h1 className="text-xl font-semibold">{title}</h1>
          {subtitle && (
            <p className="text-dim text-sm mt-1 max-w-3xl">{subtitle}</p>
          )}
        </div>
        {right}
      </div>
      {children}
    </section>
  );
}

/* ---------------------------------------------------------------- controls */

export function Button({
  children,
  onClick,
  variant = "default",
  disabled,
  type = "button",
  className = "",
  title,
}: {
  children: ReactNode;
  onClick?: () => void;
  variant?: "default" | "primary" | "danger" | "ghost";
  disabled?: boolean;
  type?: "button" | "submit";
  className?: string;
  title?: string;
}) {
  const styles = {
    default: "bg-panel2 border border-line hover:border-dim",
    primary: "bg-accent text-background font-medium hover:opacity-90",
    danger: "bg-transparent border border-red/40 text-red hover:bg-red/10",
    ghost: "bg-transparent text-dim hover:text-foreground",
  }[variant];
  return (
    <button
      type={type}
      title={title}
      disabled={disabled}
      onClick={onClick}
      className={`px-3 py-1.5 rounded-md text-sm transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${styles} ${className}`}
    >
      {children}
    </button>
  );
}

export function Field({
  label,
  hint,
  children,
  className = "",
}: {
  label: string;
  hint?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <label className={`block ${className}`}>
      <span className="block text-xs text-dim mb-1">{label}</span>
      {children}
      {hint && <span className="block text-[11px] text-dim mt-1">{hint}</span>}
    </label>
  );
}

const inputBase =
  "w-full bg-panel2 border border-line rounded-md px-2.5 py-1.5 text-sm " +
  "focus:outline-none focus:border-accent placeholder:text-dim/60";

export function Input(
  props: React.InputHTMLAttributes<HTMLInputElement> & { className?: string },
) {
  const { className = "", ...rest } = props;
  return <input {...rest} className={`${inputBase} ${className}`} />;
}

export function Select(
  props: React.SelectHTMLAttributes<HTMLSelectElement> & { className?: string },
) {
  const { className = "", children, ...rest } = props;
  return (
    <select {...rest} className={`${inputBase} ${className}`}>
      {children}
    </select>
  );
}

export function Textarea(
  props: React.TextareaHTMLAttributes<HTMLTextAreaElement> & {
    className?: string;
  },
) {
  const { className = "", ...rest } = props;
  return <textarea {...rest} className={`${inputBase} ${className}`} />;
}

/* ------------------------------------------------------------------ atoms */

const TONES = {
  neutral: "bg-panel2 text-dim border-line",
  accent: "bg-accent/10 text-accent border-accent/30",
  red: "bg-red/10 text-red border-red/30",
  amber: "bg-amber/10 text-amber border-amber/30",
  green: "bg-green/10 text-green border-green/30",
  violet: "bg-violet/10 text-violet border-violet/30",
} as const;

export type Tone = keyof typeof TONES;

export function Badge({
  children,
  tone = "neutral",
  title,
}: {
  children: ReactNode;
  tone?: Tone;
  title?: string;
}) {
  return (
    <span
      title={title}
      className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] border ${TONES[tone]}`}
    >
      {children}
    </span>
  );
}

export function severityTone(severity: string): Tone {
  return severity === "high" ? "red" : severity === "medium" ? "amber" : "neutral";
}

export function bandTone(band: string): Tone {
  return band === "high" ? "red" : band === "moderate" ? "amber" : "green";
}

export function Stat({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  tone?: Tone;
}) {
  const colour =
    tone === "red"
      ? "text-red"
      : tone === "green"
        ? "text-green"
        : tone === "amber"
          ? "text-amber"
          : "text-foreground";
  return (
    <div className="bg-panel border border-line rounded-lg px-3 py-2.5">
      <div className="text-[11px] uppercase tracking-wider text-dim">{label}</div>
      <div className={`text-lg font-semibold mt-0.5 ${colour}`}>{value}</div>
      {sub && <div className="text-[11px] text-dim mt-0.5">{sub}</div>}
    </div>
  );
}

export function EmptyState({
  title,
  children,
  action,
}: {
  title: string;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="border border-dashed border-line rounded-lg p-8 text-center">
      <p className="font-medium mb-1">{title}</p>
      <p className="text-dim text-sm max-w-lg mx-auto">{children}</p>
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function Spinner({ label }: { label?: string }) {
  return (
    <div className="flex items-center gap-2 text-dim text-sm py-4">
      <span className="w-3.5 h-3.5 border-2 border-accent border-t-transparent rounded-full animate-spin" />
      {label ?? "Working…"}
    </div>
  );
}

export function ErrorNote({
  children,
  onRetry,
}: {
  children: ReactNode;
  onRetry?: () => void;
}) {
  return (
    <div className="border border-red/40 bg-red/5 rounded-lg p-3 text-sm">
      <div className="text-red font-medium mb-1">That did not work</div>
      <div className="text-foreground/90">{children}</div>
      {onRetry && (
        <div className="mt-2">
          <Button onClick={onRetry}>Try again</Button>
        </div>
      )}
    </div>
  );
}

export function Disclose({
  summary,
  children,
  defaultOpen = false,
}: {
  summary: ReactNode;
  children: ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div>
      <button
        onClick={() => setOpen(!open)}
        className="text-xs text-accent hover:underline"
      >
        {open ? "▾ " : "▸ "}
        {summary}
      </button>
      {open && <div className="mt-2">{children}</div>}
    </div>
  );
}

/* ----------------------------------------------- product-bearing components */

const TIER_NAMES = ["structural", "stateful", "historical", "cross-project"];

export function TierBanner({
  tier,
  checksRun,
  unavailable,
}: {
  tier: number;
  checksRun: string[];
  unavailable: {
    tier: number;
    checks: string[];
    requires: string;
    why: string;
    unlocked_by: string;
  }[];
}) {
  return (
    <div className="border border-line bg-panel rounded-lg p-3 mb-4">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <Badge tone="accent">
          Evidence tier {tier} · {TIER_NAMES[tier] ?? "?"}
        </Badge>
        <span className="text-dim">
          {checksRun.length} check{checksRun.length === 1 ? "" : "s"} ran.
        </span>
        {unavailable.length > 0 && (
          <span className="text-dim">
            {unavailable.reduce((n, g) => n + g.checks.length, 0)} could not.
          </span>
        )}
      </div>
      {unavailable.length > 0 && (
        <div className="mt-2">
          <Disclose summary="What this analysis cannot assess yet, and why">
            <div className="space-y-3">
              {unavailable.map((gap) => (
                <div key={gap.tier} className="text-xs">
                  <div className="text-foreground/90 font-medium">
                    Tier {gap.tier} — needs {gap.requires}
                  </div>
                  <ul className="text-dim mt-1 space-y-0.5">
                    {gap.checks.map((c) => (
                      <li key={c}>· {c}</li>
                    ))}
                  </ul>
                  <p className="text-dim mt-1">{gap.why}</p>
                  <p className="text-accent mt-0.5">{gap.unlocked_by}</p>
                </div>
              ))}
            </div>
          </Disclose>
        </div>
      )}
    </div>
  );
}

export function Assumptions({
  entries,
  disclaimer,
  title = "What this rests on",
}: {
  entries: [string, ReactNode][];
  disclaimer?: string;
  title?: string;
}) {
  return (
    <div className="border border-line bg-panel2/40 rounded-md p-3 mt-3 text-xs">
      <div className="text-dim uppercase tracking-wider mb-2">{title}</div>
      {disclaimer && <p className="text-foreground/80 mb-2">{disclaimer}</p>}
      <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-1">
        {entries.map(([k, v]) => (
          <div key={k} className="flex gap-2">
            <dt className="text-dim shrink-0">{k}:</dt>
            <dd className="text-foreground/90">{v}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

/** A number and the arithmetic behind it, never a bare score. */
export function Worked({ children }: { children: ReactNode }) {
  return (
    <code className="text-[11px] text-dim font-mono bg-panel2 px-1.5 py-0.5 rounded">
      {children}
    </code>
  );
}

export function days(value: number | null | undefined, signed = false): string {
  if (value === null || value === undefined) return "—";
  const rounded = Math.round(value * 10) / 10;
  const text = signed && rounded > 0 ? `+${rounded}` : `${rounded}`;
  return `${text}d`;
}
