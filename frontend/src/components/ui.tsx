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
  // `primary` is a strong **neutral**, not the accent (D-94). The accent is
  // reserved for the zero-slack chain and high-severity emphasis, and a
  // product where every primary button is accent-coloured has reserved it for
  // nothing - which is what this variant used to do with `bg-accent`.
  const styles = {
    default: "bg-panel2 border border-line hover:border-dim",
    primary:
      "bg-primary text-primary-foreground font-medium hover:opacity-90",
    danger:
      "bg-transparent border border-severity-high/40 text-severity-high " +
      "hover:bg-severity-high/10",
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
      <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-dim border-t-transparent" />
      {label ?? "Working…"}
    </div>
  );
}

export function ErrorNote({
  children,
  onRetry,
  hint,
  requestId,
}: {
  children: ReactNode;
  onRetry?: () => void;
  /** The API's `hint`: what to do about it. Every 4xx and 5xx carries one. */
  hint?: string;
  /** The server's id for the failed request, for correlating with its logs. */
  requestId?: string;
}) {
  return (
    <div className="border-l-2 border-severity-high bg-severity-high/5 py-2 pl-3 text-sm">
      <div className="mb-0.5 font-semibold text-severity-high">
        That did not work
      </div>
      <div className="text-foreground/90">{children}</div>
      {hint && <div className="mt-1 text-muted-foreground">{hint}</div>}
      {onRetry && (
        <div className="mt-2">
          <button
            onClick={onRetry}
            className="rounded border border-line px-2 py-1 text-xs hover:border-dim"
          >
            Try again
          </button>
        </div>
      )}
      {requestId && (
        <div className="mt-1.5 text-[11px] text-muted-foreground">
          Request <span className="font-mono">{requestId}</span> — quote this
          if you report it.
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
  const couldNot = unavailable.reduce((n, g) => n + g.checks.length, 0);
  return (
    <div className="mb-4 border-b border-line pb-2">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-[13px]">
        <span className="font-medium">
          Evidence tier {tier}
          <span className="text-muted-foreground">
            {" · "}
            {TIER_NAMES[tier] ?? "?"}
          </span>
        </span>
        <span className="text-muted-foreground">
          {checksRun.length} check{checksRun.length === 1 ? "" : "s"} ran.
        </span>
        {couldNot > 0 && (
          <span className="text-muted-foreground">{couldNot} could not.</span>
        )}
      </div>
      {unavailable.length > 0 && (
        <details className="group mt-1 [&_summary::-webkit-details-marker]:hidden">
          <summary className="cursor-pointer list-none text-xs text-muted-foreground marker:content-none hover:text-foreground hover:underline">
            <span className="inline-block w-3 group-open:hidden">▸</span>
            <span className="hidden w-3 group-open:inline-block">▾</span>
            What this analysis cannot assess yet, and why
          </summary>
          <div className="mt-2 space-y-3 pl-3">
            {unavailable.map((gap) => (
              <div key={gap.tier} className="text-xs">
                <div className="font-medium text-foreground/90">
                  Tier {gap.tier} — needs {gap.requires}
                </div>
                <ul className="mt-1 space-y-0.5 text-muted-foreground">
                  {gap.checks.map((c) => (
                    <li key={c}>· {c}</li>
                  ))}
                </ul>
                <p className="mt-1 text-muted-foreground">{gap.why}</p>
                <p className="mt-0.5 text-accent">{gap.unlocked_by}</p>
              </div>
            ))}
          </div>
        </details>
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
    <div className="mt-3 border-t border-line pt-2 text-xs">
      <div className="mb-1 font-medium tracking-wide text-muted-foreground uppercase">
        {title}
      </div>
      {disclaimer && <p className="mb-1.5 text-foreground/80">{disclaimer}</p>}
      <dl className="grid grid-cols-1 gap-x-6 gap-y-0.5 sm:grid-cols-2">
        {entries.map(([k, v]) => (
          <div key={k} className="flex gap-2">
            <dt className="shrink-0 text-muted-foreground">{k}:</dt>
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
    <code className="rounded bg-panel2 px-1 py-px font-mono text-[11px] text-muted-foreground">
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
