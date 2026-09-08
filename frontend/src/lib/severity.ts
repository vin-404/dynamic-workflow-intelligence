/**
 * Severity and risk bands, in exactly three states.
 *
 * One implementation, shared, because the alternative is three panels that
 * each invented their own mapping and disagree by one shade — and the brief's
 * rule is that severity has three states and not a rainbow. If you need a
 * fourth, you don't: `text-dim` carries "nothing notable".
 *
 * `low` is deliberately **not** green here. A low-severity *finding* is not a
 * good thing, it is a small thing, so it reads as muted rather than as a pass.
 * Green belongs to a risk *band*, where "low" genuinely is the good end —
 * which is why `bandClasses` exists separately rather than being the same
 * function.
 *
 * The accent colour appears in neither. It is reserved for the critical path
 * and for high-severity emphasis in the dependency map, so spending it on a
 * badge would un-reserve it.
 */

/** The three states, in the order a reader should scan them. */
export type Severity = "high" | "medium" | "low";

/** Tinted background, readable text, faint border — the badge recipe. */
export function severityClasses(severity: string): string {
  switch (severity) {
    case "high":
      return "bg-severity-high/10 text-severity-high border-severity-high/30";
    case "medium":
      return "bg-severity-medium/10 text-severity-medium border-severity-medium/30";
    default:
      return "bg-panel2 text-dim border-line";
  }
}

/** Just the text colour, for a severity word inline in a sentence or a row. */
export function severityText(severity: string): string {
  switch (severity) {
    case "high":
      return "text-severity-high";
    case "medium":
      return "text-severity-medium";
    default:
      return "text-dim";
  }
}

/** A solid fill, for the bar in a factor table. */
export function severityFill(severity: string): string {
  switch (severity) {
    case "high":
      return "bg-severity-high";
    case "medium":
      return "bg-severity-medium";
    default:
      return "bg-dim";
  }
}

/**
 * Risk bands, where `low` is the good end and green is honest.
 *
 * The engine's bands are `low` / `moderate` / `high` — note `moderate`, not
 * `medium`. Keeping the engine's word rather than normalising it means a
 * mismatch shows up here instead of silently falling through to a default.
 */
export function bandClasses(band: string): string {
  switch (band) {
    case "high":
      return "bg-severity-high/10 text-severity-high border-severity-high/30";
    case "moderate":
      return "bg-severity-medium/10 text-severity-medium border-severity-medium/30";
    case "low":
      return "bg-severity-low/10 text-severity-low border-severity-low/30";
    default:
      return "bg-panel2 text-dim border-line";
  }
}

export function bandText(band: string): string {
  switch (band) {
    case "high":
      return "text-severity-high";
    case "moderate":
      return "text-severity-medium";
    case "low":
      return "text-severity-low";
    default:
      return "text-dim";
  }
}

/**
 * Tabular numerals are already on `body`, so nothing needs this for figures
 * in prose or tables. It exists for the one case the base rule cannot reach:
 * a number rendered inside a component that resets `font-variant-numeric`.
 */
export const TABULAR = "[font-variant-numeric:tabular-nums]";
