"use client";

/**
 * Import a Jira export: preview what would be created, then commit it as a
 * new workflow.
 *
 * **An import is almost entirely inference, and this screen exists to make
 * that legible before anything is written.** A foreign status mapped onto
 * ours, a story point read as a working day, an absent estimate defaulted —
 * every one of those is a guess, and the backend returns each of them with
 * the caller's own raw text beside it (`interpretation`, per row, per field).
 * So the preview leads with what was *guessed*, not with what was read: for
 * every row, the assumed readings and their reasons are on screen by default,
 * and the readings that came straight out of the file are the ones behind a
 * disclosure. That ordering is the whole design.
 *
 * Four things are reported and never hidden, in a fixed order, because each
 * of them is a way the import could quietly lie:
 *
 *   - **rejected rows** — every one, with its number, its raw content and the
 *     reason. `counts.rows_rejected` at the top is a pointer to the list, not
 *     a substitute for it, and the list is repeated in the commit result on
 *     purpose (the backend carries it there for exactly this reason).
 *   - **dropped dependencies** — a link that points outside the export is
 *     named rather than silently invented as a task.
 *   - **cycles** — shown as a closed task-key path with the rows that caused
 *     it. These block the commit; rejected rows deliberately do not (D-150).
 *   - **unmapped columns** — present in the file, not read, with the reason.
 *
 * Preview is stateless: the same body is posted again at commit (D-145), so
 * there is no half-finished import living on the server, and what gets
 * written is what these same bytes produce.
 *
 * Committing creates a *new* project. There is no merge into a live workflow
 * and no `project_id` on the body (D-151); `onImported` hands the new id back
 * to `page.tsx`, which selects it.
 */

import { useState } from "react";
import {
  Check,
  ChevronRight,
  LoaderCircle,
  TriangleAlert,
  Upload,
} from "lucide-react";
import {
  ApiError,
  AssumptionsBlock,
  DroppedDependency,
  ImportBody,
  ImportCommitResult,
  ImportCycle,
  ImportPreview,
  ImportSample,
  PreviewRow,
  RejectedRow,
  RowInterpretation,
  assumptionSentences,
  getImportSample,
  humanizeKey,
  importCommit,
  importPreview,
  listImportSamples,
} from "@/lib/api";
import { humanize, resourceKindLabel, statusLabel } from "@/lib/display";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { bandClasses, bandText } from "@/lib/severity";
import { cn } from "@/lib/utils";
import { ErrorNote, days } from "./ui";

/** One inline icon size across every panel. */
const ICON = "size-3.5 shrink-0";
/** Column and section labels: small, quiet, upper. */
const LABEL = "text-[12px] font-medium uppercase tracking-wider text-dim";
/** An identifier on record — a task key, a column name, a hash. Form, not hue. */
const TOKEN =
  "rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-[12px]";
/**
 * "This value was not in the file; the importer chose it."
 *
 * A **dashed** border and no colour at all, for the same reason D-102 gave a
 * constraint on record a mono chip rather than a hue: there are exactly three
 * severity states and an assumption is not one of them. Dashed is the form
 * that reads as "provisional" without spending a colour, and it survives both
 * themes because it borrows `dim`, which is defined in both.
 */
const ASSUMED =
  "ml-1.5 inline-block shrink-0 rounded border border-dashed border-dim/70 " +
  "px-1 align-[1px] text-[12px] font-medium uppercase tracking-wider text-dim";
/**
 * A long table scrolls inside its own box; the page never scrolls sideways.
 *
 * The header is deliberately *not* sticky. The `Table` primitive owns its own
 * `overflow-x-auto` wrapper div and does not forward a className to it, and
 * because a box with `overflow-x: auto` computes `overflow-y: auto` too, that
 * wrapper is already the nearest scrollport — so a `sticky` thead sticks to a
 * container that never scrolls and scrolls out of view anyway. Radix's
 * `ScrollArea` is no help either: its viewport wraps children in a
 * `display: table` div, which defeats sticky as well (checked in
 * `@radix-ui/react-scroll-area`, not assumed). Each table sits under its own
 * visible heading instead, which is what the header was for.
 */
const SCROLL =
  "max-h-[26rem] overflow-y-auto overscroll-contain rounded-md border border-border/60";
/**
 * Chromium draws a date input's calendar indicator from the element's
 * `color-scheme`, and nothing in `globals.css` sets that property — so in dark
 * mode the glyph is painted black on a near-black field and effectively
 * disappears. Declaring it here fixes the two date fields this panel owns.
 * (`SetupPanel`'s two have the same fault; it is not this agent's file.)
 */
const DATE_SCHEME = "[color-scheme:light] dark:[color-scheme:dark]";
/** A native control drawn to match the shadcn `Input` beside it. */
const TEXTAREA =
  "w-full min-w-0 rounded-lg border border-input bg-transparent px-2.5 py-1.5 " +
  "font-mono text-xs leading-relaxed outline-none transition-colors " +
  "focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 " +
  "dark:bg-input/30";

/* -------------------------------------------------------------- scaffolding */

/** A heading and a hairline. No card: type carries the hierarchy. */
function Head({
  children,
  right,
}: {
  children: React.ReactNode;
  right?: React.ReactNode;
}) {
  return (
    <div className="mb-2 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 border-b border-border pb-1.5">
      <h2 className="text-[13px] font-semibold tracking-tight">{children}</h2>
      {right && <span className="text-[12px] text-dim">{right}</span>}
    </div>
  );
}

/** A figure and its label. Not a tile — the brief's card grid is the enemy. */
function Metric({
  label,
  value,
  sub,
  tone,
  lead,
}: {
  label: string;
  value: React.ReactNode;
  sub?: React.ReactNode;
  tone?: string;
  lead?: boolean;
}) {
  return (
    <div className="min-w-0">
      <div className={LABEL}>{label}</div>
      <div
        className={cn(
          "mt-0.5 leading-tight font-medium",
          lead ? "text-lg" : "text-sm",
          tone,
        )}
      >
        {value}
      </div>
      {sub && <div className="mt-0.5 text-[12px] text-dim">{sub}</div>}
    </div>
  );
}

/**
 * A callout as token markup rather than shadcn's `Alert`, per D-112: `Alert`
 * is not installed, and installing it means writing into `src/components/ui/`
 * in a tree three other agents are editing.
 */
function Callout({
  tone,
  title,
  children,
}: {
  tone: "high" | "medium" | "low";
  title: React.ReactNode;
  children?: React.ReactNode;
}) {
  const rule =
    tone === "high"
      ? "border-severity-high bg-severity-high/5"
      : tone === "medium"
        ? "border-severity-medium bg-severity-medium/5"
        : "border-severity-low bg-severity-low/5";
  return (
    <div className={cn("border-l-2 py-2 pl-3 text-sm", rule)}>
      <div className={cn("font-semibold", bandText(tone === "medium" ? "moderate" : tone))}>
        {title}
      </div>
      {children && <div className="mt-1 text-foreground/90">{children}</div>}
    </div>
  );
}

/** Native `<details>`, per D-111. No state, no client boundary, no component. */
function Reveal({
  summary,
  children,
}: {
  summary: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <details className="group mt-1.5">
      <summary className="inline-flex cursor-pointer list-none items-center gap-1 text-[12px] text-dim hover:text-foreground [&::-webkit-details-marker]:hidden">
        <ChevronRight
          className={cn(ICON, "transition-transform group-open:rotate-90")}
          aria-hidden
        />
        {summary}
      </summary>
      <div className="mt-1.5 pl-4">{children}</div>
    </details>
  );
}

/* ------------------------------------------------------------- the honesty */

/**
 * Backend prose, with its `backticked` spans set in mono.
 *
 * Several of these sentences name a field or a column inside backticks
 * because they were written to be read in a JSON payload. Rendering the
 * backtick characters literally makes a careful sentence look like an escaping
 * bug, and stripping them loses the distinction the author drew — so they are
 * honoured as the code spans they are. The words themselves are untouched.
 */
function Prose({ children }: { children: string }) {
  const parts = children.split(/`([^`]+)`/g);
  return (
    <>
      {parts.map((part, i) =>
        i % 2 === 1 ? (
          <span key={i} className="font-mono text-[0.95em]">
            {part}
          </span>
        ) : (
          <span key={i}>{part}</span>
        ),
      )}
    </>
  );
}

/** Render a value the importer produced, without hardcoding the field name. */
function readingValue(field: string, value: unknown): React.ReactNode {
  if (value === null || value === undefined || value === "") {
    return <span className="text-dim">nothing</span>;
  }
  if (typeof value === "number") {
    // The one field name this file knows about. Rendering effort as a bare
    // "2" next to a raw "2" hides the entire conversion the row is here to
    // show; every other numeric field can speak for itself.
    return field === "effort" ? days(value) : String(value);
  }
  if (field === "status" && typeof value === "string") return statusLabel(value);
  return String(value);
}

/** One field of one row: what the file said, what it became, and how. */
function Reading({
  field,
  reading,
}: {
  field: string;
  reading: RowInterpretation;
}) {
  return (
    <div className="grid grid-cols-[6rem_1fr] gap-x-3 gap-y-0.5 py-0.5">
      <dt className="text-[12px] text-dim">{humanize(field)}</dt>
      <dd className="min-w-0">
        <div className="flex flex-wrap items-baseline gap-x-1.5 text-[13px]">
          <span className="font-mono text-[12px] break-all text-dim">
            {reading.raw ? `"${reading.raw}"` : "(nothing in this row)"}
          </span>
          <ChevronRight className={cn(ICON, "text-dim")} aria-hidden />
          <span className="font-medium">
            {readingValue(field, reading.value)}
          </span>
          {reading.assumed && <span className={ASSUMED}>assumed</span>}
        </div>
        <p className="mt-0.5 text-[12px] leading-snug text-dim">
          <Prose>{reading.how}</Prose>
          {reading.source && (
            <span>
              {" "}
              · <span className="font-mono">{reading.source}</span>
            </span>
          )}
        </p>
      </dd>
    </div>
  );
}

/** One imported row: the guesses first, the plain readings behind a click. */
function RowReadings({ row }: { row: PreviewRow }) {
  const entries = Object.entries(row.interpretation);
  const assumed = entries.filter(([, r]) => r.assumed);
  const read = entries.filter(([, r]) => !r.assumed);

  return (
    <li className="py-2">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-[13px]">
        <span className="w-12 shrink-0 text-right text-[12px] text-dim">
          row {row.row}
        </span>
        <span className={TOKEN}>{row.task_key}</span>
        <span className="min-w-0 flex-1 truncate">{row.name}</span>
        <span className="text-[12px] text-dim">
          {assumed.length === 0
            ? `${entries.length} readings, none assumed`
            : `${assumed.length} of ${entries.length} readings assumed`}
        </span>
        {row.line !== row.row && (
          <span className="text-[12px] text-dim">line {row.line}</span>
        )}
      </div>

      {assumed.length > 0 && (
        <dl className="mt-1 ml-14 divide-y divide-border/40 border-l border-dashed border-border pl-2.5">
          {assumed.map(([field, reading]) => (
            <Reading key={field} field={field} reading={reading} />
          ))}
        </dl>
      )}

      {row.notes.length > 0 && (
        <ul className="mt-1 ml-14 flex flex-col gap-0.5 text-[12px] text-dim">
          {row.notes.map((note, i) => (
            <li key={i}>
              · <Prose>{note}</Prose>
            </li>
          ))}
        </ul>
      )}

      {read.length > 0 && (
        <div className="ml-14">
          <Reveal
            summary={`${read.length} reading${read.length === 1 ? "" : "s"} taken straight from the file`}
          >
            <dl className="divide-y divide-border/40">
              {read.map(([field, reading]) => (
                <Reading key={field} field={field} reading={reading} />
              ))}
            </dl>
          </Reveal>
        </div>
      )}
    </li>
  );
}

/**
 * Every assumption block in this API, rendered without knowing its keys.
 *
 * `assumptionSentences()` picks up top-level prose, which is what the rest of
 * the product's blocks are made of. The import's block is shaped differently
 * — lists of sentences (`stated_plainly`, `notes`) and `{value, assumed, how}`
 * objects (`start_date`, `deadline`) beside a settings dictionary — so this
 * walks those shapes too rather than naming the keys. The point of doing it
 * structurally is the one `lib/api.ts` states: the day the backend adds a
 * caveat must not be the day it stops being shown.
 */
function AssumptionsView({ block }: { block: AssumptionsBlock }) {
  const prose = assumptionSentences(block);
  const entries = Object.entries(block ?? {});

  const lists = entries.filter(
    ([, v]) => Array.isArray(v) && v.every((x) => typeof x === "string"),
  ) as [string, string[]][];

  const derived = entries.filter(
    ([, v]) =>
      v !== null &&
      typeof v === "object" &&
      !Array.isArray(v) &&
      "how" in (v as object),
  ) as [string, { value: unknown; assumed?: boolean; how?: string }][];

  const settings = entries.filter(
    ([, v]) =>
      v !== null &&
      typeof v === "object" &&
      !Array.isArray(v) &&
      !("how" in (v as object)),
  ) as [string, Record<string, unknown>][];

  const sentences = [
    ...prose.map((p) => p.text),
    ...lists.flatMap(([, v]) => v),
  ];

  return (
    <div className="flex flex-col gap-3 text-xs">
      {sentences.length > 0 && (
        <ul className="flex max-w-3xl flex-col gap-1.5">
          {sentences.map((text, i) => (
            <li key={i} className="flex gap-2">
              <span className="text-dim">·</span>
              <span className="text-foreground/90">
                <Prose>{text}</Prose>
              </span>
            </li>
          ))}
        </ul>
      )}

      {derived.length > 0 && (
        <dl className="grid grid-cols-[7rem_1fr] gap-x-3 gap-y-1">
          {derived.map(([key, value]) => (
            <div key={key} className="col-span-2 grid grid-cols-subgrid">
              <dt className="text-dim">{humanizeKey(key)}</dt>
              <dd className="min-w-0">
                <span className="font-medium">
                  {value.value === null || value.value === undefined
                    ? "none"
                    : String(value.value)}
                </span>
                {value.assumed && <span className={ASSUMED}>assumed</span>}
                {value.how && (
                  <span className="block text-[12px] leading-snug text-dim">
                    {value.how}
                  </span>
                )}
              </dd>
            </div>
          ))}
        </dl>
      )}

      {settings.map(([key, value]) => (
        <div key={key}>
          <div className={cn("mb-1", LABEL)}>{humanizeKey(key)}</div>
          <dl className="flex flex-wrap gap-x-5 gap-y-1">
            {Object.entries(value).map(([k, v]) => (
              <div key={k} className="flex gap-1.5">
                <dt className="text-dim">{humanize(k)}</dt>
                <dd className="font-mono">
                  {v === null || v === undefined ? "—" : String(v)}
                </dd>
              </div>
            ))}
          </dl>
        </div>
      ))}
    </div>
  );
}

/* ------------------------------------------------ the four honesty sections */

function RejectedRows({
  rows,
  rowsRead,
}: {
  rows: RejectedRow[];
  rowsRead?: number;
}) {
  if (rows.length === 0) return null;
  return (
    <section>
      <Head
        right={
          rowsRead
            ? `${rows.length} of ${rowsRead} rows read`
            : `${rows.length} row${rows.length === 1 ? "" : "s"}`
        }
      >
        Rows that could not be imported
      </Head>
      <p className="mb-2 max-w-3xl text-xs text-dim">
        Every one of them, with the reason. A rejected row does not stop the
        import — a real export usually carries a few — but it does mean that
        issue is simply not in the workflow, so nothing downstream will account
        for it.
      </p>
      <div className={SCROLL}>
        <Table className="text-[13px]">
          <TableHeader>
            <TableRow className="border-border hover:bg-transparent">
              <TableHead className={cn("h-7 w-14 px-2 text-right", LABEL)}>
                Row
              </TableHead>
              <TableHead className={cn("h-7 px-2", LABEL)}>Why</TableHead>
              <TableHead className={cn("h-7 px-2", LABEL)}>
                As the file has it
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => {
              const filled = row.raw.filter(([, v]) => v.trim() !== "");
              const empty = row.raw.length - filled.length;
              return (
                <TableRow key={`${row.row}-${row.line}`} className="border-border/50">
                  <TableCell className="px-2 py-1.5 text-right align-top text-dim">
                    {row.row}
                    {row.line !== row.row && (
                      <span className="block text-[12px]">line {row.line}</span>
                    )}
                  </TableCell>
                  <TableCell className="max-w-[26rem] px-2 py-1.5 align-top leading-snug whitespace-normal">
                    <Prose>{row.reason}</Prose>
                  </TableCell>
                  <TableCell className="max-w-[24rem] px-2 py-1.5 align-top">
                    {/* The cells run on as one wrapped line rather than one
                        line each. A Jira export is eighteen columns wide, so
                        a column-per-line raw cell made three rejected rows
                        taller than the box they sit in - which is a way of
                        hiding the third one, and the whole point of this
                        table is that none of them get hidden. */}
                    <p className="font-mono text-[12px] leading-relaxed break-words">
                      {filled.map(([column, value], i) => (
                        <span key={i}>
                          {i > 0 && <span className="text-dim"> · </span>}
                          <span className="text-dim">{column}: </span>
                          {value}
                        </span>
                      ))}
                      {empty > 0 && (
                        <span className="text-dim italic">
                          {filled.length > 0 && " · "}
                          and {empty} empty column{empty === 1 ? "" : "s"}
                        </span>
                      )}
                    </p>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
    </section>
  );
}

function DroppedDependencies({ dropped }: { dropped: DroppedDependency[] }) {
  if (dropped.length === 0) return null;
  return (
    <section>
      <Head right={`${dropped.length} link${dropped.length === 1 ? "" : "s"}`}>
        Dependencies that were dropped
      </Head>
      <p className="mb-2 max-w-3xl text-xs text-dim">
        A blocking link that names something this file does not contain. It is
        reported rather than turned into an invented task, so the imported
        graph is missing an edge that the tracker believes exists.
      </p>
      <div className={SCROLL}>
        <Table className="text-[13px]">
          <TableHeader>
            <TableRow className="border-border hover:bg-transparent">
              <TableHead className={cn("h-7 w-14 px-2 text-right", LABEL)}>
                Row
              </TableHead>
              <TableHead className={cn("h-7 px-2", LABEL)}>On</TableHead>
              <TableHead className={cn("h-7 px-2", LABEL)}>Link</TableHead>
              <TableHead className={cn("h-7 px-2", LABEL)}>Why</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {dropped.map((d, i) => (
              <TableRow key={i} className="border-border/50">
                <TableCell className="px-2 py-1.5 text-right align-top text-dim">
                  {d.row}
                </TableCell>
                <TableCell className="px-2 py-1.5 align-top">
                  <span className={TOKEN}>{d.task_key}</span>
                </TableCell>
                <TableCell className="px-2 py-1.5 align-top font-mono text-[12px] break-all">
                  {d.raw || "(empty)"}
                  <span className="block text-dim">{d.column}</span>
                </TableCell>
                <TableCell className="max-w-[26rem] px-2 py-1.5 align-top leading-snug whitespace-normal">
                  <Prose>{d.reason}</Prose>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </section>
  );
}

function UnmappedColumns({
  columns,
}: {
  columns: { column: string; reason: string }[];
}) {
  if (columns.length === 0) return null;
  return (
    <section>
      <Head right={`${columns.length} column${columns.length === 1 ? "" : "s"}`}>
        Columns in the file that were not read
      </Head>
      <dl className="grid grid-cols-[minmax(8rem,14rem)_1fr] gap-x-3 gap-y-1 text-xs">
        {columns.map((c) => (
          <div key={c.column} className="col-span-2 grid grid-cols-subgrid">
            <dt className="min-w-0">
              <span className={cn(TOKEN, "break-all")}>{c.column}</span>
            </dt>
            <dd className="text-dim">
              <Prose>{c.reason}</Prose>
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

function Cycles({ cycles }: { cycles: ImportCycle[] }) {
  if (cycles.length === 0) return null;
  return (
    <section>
      <Head right={`${cycles.length} loop${cycles.length === 1 ? "" : "s"}`}>
        Blocking links that form a loop
      </Head>
      <p className="mb-2 max-w-3xl text-xs text-dim">
        No order satisfies all of these at once, so nothing in the file can be
        scheduled. This is the one thing that stops the import: fix the links
        in the source and export again.
      </p>
      <div className="flex flex-col gap-3">
        {cycles.map((cycle, i) => (
          <div key={i} className="border-l-2 border-severity-high pl-3">
            <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
              <span className={cn("font-mono text-[13px] break-all", bandText("high"))}>
                {cycle.path.join(" → ")}
              </span>
              <span className="text-[12px] text-dim">
                {cycle.length} task{cycle.length === 1 ? "" : "s"} · from row
                {cycle.from_rows.length === 1 ? " " : "s "}
                {cycle.from_rows.join(", ")}
              </span>
            </div>
            <p className="mt-1 max-w-3xl text-xs">{cycle.message}</p>
            {cycle.evidence.length > 0 && (
              <ul className="mt-1.5 flex flex-col gap-0.5 text-[12px]">
                {cycle.evidence.map((e, j) => (
                  <li key={j} className="flex flex-wrap gap-x-2">
                    <span className="shrink-0 text-dim">row {e.row}</span>
                    {/* `because` already opens with the column name, so
                        printing it again beside the cell reads as a stutter. */}
                    <span className="font-mono break-all">{e.raw}</span>
                    <span className="text-dim">{e.because}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}

/* ---------------------------------------------------------------- the panel */

type Stage = "source" | "preview" | "done";

const UNITS: { value: NonNullable<ImportBody["estimate_unit"]>; label: string }[] =
  [
    { value: "seconds", label: "seconds (Jira's own export)" },
    { value: "hours", label: "hours" },
    { value: "days", label: "working days" },
  ];

export default function ImportPanel({
  onImported,
}: {
  onImported: (projectId: string) => void;
}) {
  const [stage, setStage] = useState<Stage>("source");

  // -- the file ------------------------------------------------------------
  const [csv, setCsv] = useState("");
  const [origin, setOrigin] = useState("");
  const [sample, setSample] = useState<ImportSample | null>(null);
  const [samples, setSamples] = useState<ImportSample[] | null>(null);

  // -- how to read the numbers --------------------------------------------
  const [storyPointDays, setStoryPointDays] = useState("1");
  const [estimateUnit, setEstimateUnit] =
    useState<NonNullable<ImportBody["estimate_unit"]>>("seconds");
  const [hoursPerDay, setHoursPerDay] = useState("8");
  const [defaultEffort, setDefaultEffort] = useState("1");
  const [startDate, setStartDate] = useState("");
  const [deadline, setDeadline] = useState("");

  // -- results -------------------------------------------------------------
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  /** The exact body the preview was computed from; commit re-posts it. */
  const [previewed, setPreviewed] = useState<ImportBody | null>(null);
  const [result, setResult] = useState<ImportCommitResult | null>(null);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState<"" | "sample" | "preview" | "commit">("");
  const [error, setError] = useState<ApiError | null>(null);

  function body(): ImportBody {
    return {
      source: "jira",
      csv_text: csv,
      story_point_days: Number(storyPointDays) || 1,
      hours_per_day: Number(hoursPerDay) || 8,
      estimate_unit: estimateUnit,
      default_effort_days: Number(defaultEffort) || 0,
      ...(startDate ? { start_date: startDate } : {}),
      ...(deadline ? { deadline } : {}),
    };
  }

  async function loadSample(chosen?: ImportSample) {
    setBusy("sample");
    setError(null);
    try {
      let pick = chosen;
      if (!pick) {
        const listed = await listImportSamples();
        setSamples(listed.samples);
        if (listed.samples.length !== 1) return;
        pick = listed.samples[0];
      }
      const full = await getImportSample(pick.name);
      setCsv(full.suggested.csv_text ?? "");
      setSample(full);
      setSamples(null);
      setOrigin(full.filename);
      if (!name) setName(full.title);
    } catch (e) {
      if (e instanceof ApiError) setError(e);
      else throw e;
    } finally {
      setBusy("");
    }
  }

  async function onFile(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setError(null);
    // The one-call form of the `FileReader` this needs: the API takes the
    // file as text in a JSON body (D-145), so there is no multipart upload.
    const text = await file.text();
    setCsv(text);
    setSample(null);
    setSamples(null);
    setOrigin(file.name);
    if (!name) setName(file.name.replace(/\.[^.]+$/, ""));
  }

  async function runPreview() {
    setBusy("preview");
    setError(null);
    const sent = body();
    try {
      const out = await importPreview(sent);
      setPreview(out);
      setPreviewed(sent);
      setStage("preview");
    } catch (e) {
      if (e instanceof ApiError) setError(e);
      else throw e;
    } finally {
      setBusy("");
    }
  }

  async function runCommit() {
    if (!previewed) return;
    setBusy("commit");
    setError(null);
    try {
      // The same body the preview was computed from, re-posted. The server
      // re-parses it rather than trusting anything the preview left behind.
      const out = await importCommit({ ...previewed, name: name.trim() });
      setResult(out);
      setStage("done");
    } catch (e) {
      if (e instanceof ApiError) setError(e);
      else throw e;
    } finally {
      setBusy("");
    }
  }

  const lines = csv ? csv.trimEnd().split("\n").length : 0;

  return (
    <div className="flex flex-col gap-6">
      <section>
        <div className="mb-2 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 border-b border-border pb-1.5">
          <h1 className="text-base font-semibold tracking-tight">
            Import from a Jira export
          </h1>
          <span className="text-[12px] text-dim">
            {stage === "source"
              ? "step 1 of 2 · choose a file"
              : stage === "preview"
                ? "step 2 of 2 · read what it would create"
                : "imported"}
          </span>
        </div>
        <p className="max-w-3xl text-sm text-dim">
          An import is inference: a foreign status mapped onto ours, a story
          point read as a day, an absent estimate defaulted. Nothing is created
          until you have read what it would create — and committing makes a new
          workflow. It never merges into one you already have.
        </p>
      </section>

      {error && (
        <ErrorNote hint={error.hint} requestId={error.requestId}>
          <p>{error.userMessage}</p>
          {/* Checked against `deps.py` rather than paraphrased from the
              brief, which said a viewer cannot commit. There is no such
              distinction here: neither import route is project-scoped, so
              `project_role_guard` never resolves a project and the bar is
              simply being somebody. Saying otherwise would put a permission
              rule on screen that the server does not enforce. */}
          <p className="mt-2 text-xs text-dim">
            Nothing was created. An import is authorship, so it needs a
            signed-in identity — but it is not scoped to an existing project,
            so there is no role to hold: any signed-in account can import, and
            the workflow it creates is owned by whoever imported it.
          </p>
        </ErrorNote>
      )}

      {stage === "source" && (
        <>
          <section>
            <Head right={origin || undefined}>Choose a file</Head>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant="secondary"
                onClick={() => loadSample()}
                disabled={busy !== ""}
              >
                {busy === "sample" && (
                  <LoaderCircle
                    className="animate-spin"
                    data-icon="inline-start"
                    aria-hidden
                  />
                )}
                Load the bundled sample
              </Button>
              <Button variant="outline" asChild>
                <label>
                  <Upload data-icon="inline-start" aria-hidden />
                  Choose a CSV file
                  <input
                    type="file"
                    accept=".csv,text/csv,text/plain"
                    className="sr-only"
                    onChange={onFile}
                  />
                </label>
              </Button>
              <span className="text-[12px] text-dim">
                …or paste the export below. It never leaves this instance.
              </span>
            </div>

            {samples && samples.length !== 1 && (
              <ul className="mt-3 flex flex-col divide-y divide-border/60 border-y border-border/60">
                {samples.map((s) => (
                  <li
                    key={s.name}
                    className="flex items-center gap-2 py-1.5 text-[13px]"
                  >
                    <span className="min-w-0 flex-1">
                      {s.title}
                      <span className="block text-[12px] text-dim">
                        {s.description}
                      </span>
                    </span>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => loadSample(s)}
                    >
                      Load
                    </Button>
                  </li>
                ))}
              </ul>
            )}

            {sample && (
              <div className="mt-3 border-l-2 border-border pl-3">
                <div className="flex flex-wrap items-baseline gap-x-2 text-[13px]">
                  <span className="font-medium">{sample.title}</span>
                  <span className={TOKEN}>{sample.filename}</span>
                  <span className="text-[12px] text-dim">
                    {sample.lines} lines · {sample.bytes} bytes · sha256{" "}
                    {sample.sha256.slice(0, 12)}…
                  </span>
                </div>
                <p className="mt-1 max-w-3xl text-xs text-dim">
                  {sample.description}
                </p>
                <Reveal
                  summary={`what this file is built to exercise (${sample.demonstrates.length})`}
                >
                  <ul className="flex max-w-3xl flex-col gap-1 text-[12px] text-dim">
                    {sample.demonstrates.map((d, i) => (
                      <li key={i}>· {d}</li>
                    ))}
                  </ul>
                </Reveal>
              </div>
            )}

            <label className="mt-3 block">
              <span className={cn("mb-1 block", LABEL)}>
                The export, as text
              </span>
              <textarea
                rows={8}
                spellCheck={false}
                value={csv}
                onChange={(e) => {
                  setCsv(e.target.value);
                  setSample(null);
                }}
                placeholder="Issue key,Issue Type,Summary,Status,…"
                className={TEXTAREA}
              />
            </label>
            <p className="mt-1 text-[12px] text-dim">
              {csv
                ? `${csv.length.toLocaleString()} characters · ${lines} lines. Editable — change a blocking link here to see the importer refuse a cycle.`
                : "Nothing loaded yet."}
            </p>
          </section>

          <section>
            <Head right="echoed back on every row that uses one">
              How the numbers will be read
            </Head>
            <p className="mb-3 max-w-3xl text-xs text-dim">
              A story point is a relative unit with no time in it, and a bare
              estimate has no unit at all. These conversions are yours, not the
              file&apos;s, so they are set here rather than sniffed — and every
              row that used one says so.
            </p>
            <div className="flex flex-wrap items-end gap-x-4 gap-y-3">
              <label className="flex w-32 flex-col gap-1">
                <span className={LABEL}>Days per point</span>
                <Input
                  type="number"
                  min={0.1}
                  step={0.1}
                  value={storyPointDays}
                  onChange={(e) => setStoryPointDays(e.target.value)}
                />
              </label>
              {/* A Radix `Select`, not a native one — the opposite answer to
                  D-104, for the reason D-125 gives: the walkthrough drives
                  `locator("select")` by DOM position on the what-if stage,
                  and this panel is only ever mounted on the project picker,
                  where no walkthrough reaches. Two surfaces, two answers, one
                  test: what the walkthrough can actually touch. */}
              <label className="flex w-56 flex-col gap-1">
                <span className={LABEL}>A bare estimate means</span>
                <Select
                  value={estimateUnit}
                  onValueChange={(v) =>
                    setEstimateUnit(v as NonNullable<ImportBody["estimate_unit"]>)
                  }
                >
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      {UNITS.map((u) => (
                        <SelectItem key={u.value} value={u.value}>
                          {u.label}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </label>
              <label className="flex w-32 flex-col gap-1">
                <span className={LABEL}>Hours per day</span>
                <Input
                  type="number"
                  min={1}
                  max={24}
                  value={hoursPerDay}
                  onChange={(e) => setHoursPerDay(e.target.value)}
                />
              </label>
              <label className="flex w-36 flex-col gap-1">
                <span className={LABEL}>Default effort</span>
                <Input
                  type="number"
                  min={0}
                  step={0.5}
                  value={defaultEffort}
                  onChange={(e) => setDefaultEffort(e.target.value)}
                />
              </label>
              <label className="flex w-40 flex-col gap-1">
                <span className={LABEL}>Start date</span>
                <Input
                  type="date"
                  className={DATE_SCHEME}
                  value={startDate}
                  onChange={(e) => setStartDate(e.target.value)}
                />
              </label>
              <label className="flex w-40 flex-col gap-1">
                <span className={LABEL}>Deadline</span>
                <Input
                  type="date"
                  className={DATE_SCHEME}
                  value={deadline}
                  onChange={(e) => setDeadline(e.target.value)}
                />
              </label>
            </div>
            <p className="mt-1.5 text-[12px] text-dim">
              Leave the two dates empty and they are derived from the file — the
              earliest date found and the latest due date — and reported as
              derived.
            </p>
          </section>

          <section className="flex flex-wrap items-center gap-2 border-t border-border pt-3">
            <Button onClick={runPreview} disabled={!csv.trim() || busy !== ""}>
              {busy === "preview" && (
                <LoaderCircle
                  className="animate-spin"
                  data-icon="inline-start"
                  aria-hidden
                />
              )}
              Preview the import
            </Button>
            <span className="text-xs text-dim">
              Reads the file and writes nothing.
            </span>
          </section>

          <p className="max-w-3xl text-[12px] text-dim">
            This screen reads a Jira issue export, which is the only source with
            a preset. The API also takes a generic CSV with an explicit column
            mapping — which column is the key, the name, the estimate, the
            blocking links — and that path has no screen yet, because guessing
            those for you is exactly the kind of inference this feature exists
            to make visible.
          </p>
        </>
      )}

      {stage === "preview" && preview && (
        <PreviewView
          preview={preview}
          origin={origin}
          name={name}
          onName={setName}
          busy={busy}
          onCommit={runCommit}
          onBack={() => {
            setStage("source");
            setPreview(null);
            setPreviewed(null);
            setError(null);
          }}
        />
      )}

      {stage === "done" && result && (
        <CommittedView result={result} onOpen={() => onImported(result.project.project_id)} />
      )}
    </div>
  );
}

/* --------------------------------------------------------------- the preview */

function PreviewView({
  preview,
  origin,
  name,
  onName,
  busy,
  onCommit,
  onBack,
}: {
  preview: ImportPreview;
  origin: string;
  name: string;
  onName: (value: string) => void;
  busy: string;
  onCommit: () => void;
  onBack: () => void;
}) {
  const c = preview.counts;
  const w = preview.would_create;
  const assumedRows = preview.rows.filter((r) =>
    Object.values(r.interpretation).some((i) => i.assumed),
  ).length;

  return (
    <>
      {/* --------------------------------------------------- the headline */}
      <section>
        <Head
          right={
            <>
              {origin && <span className="mr-2">{origin}</span>}
              sha256 {preview.csv_sha256.slice(0, 12)}…
            </>
          }
        >
          What this file would create
        </Head>
        <div className="flex flex-wrap items-start gap-x-8 gap-y-3 border-y border-border py-2.5">
          <Metric
            lead
            label="tasks"
            value={c.tasks}
            sub={`from ${c.rows_read} rows read`}
          />
          <Metric
            label="dependencies"
            value={c.dependencies}
            sub="ordering only"
          />
          <Metric
            label="resources"
            value={c.resources}
            sub={`${c.assignments} assignment${c.assignments === 1 ? "" : "s"}`}
          />
          <Metric
            label="rows rejected"
            value={c.rows_rejected}
            sub={c.rows_rejected ? "listed in full below" : "none"}
            tone={c.rows_rejected ? bandText("high") : undefined}
          />
          <Metric
            label="links dropped"
            value={c.dependencies_dropped}
            sub={
              c.dependencies_dropped ? "named below" : "every link resolved"
            }
            tone={c.dependencies_dropped ? bandText("moderate") : undefined}
          />
          <Metric
            label="rows with a guess"
            value={`${assumedRows} of ${preview.rows.length}`}
            sub="every one is shown"
          />
        </div>
        <p className="mt-2 text-xs text-dim">
          Starts {w.project.start_date}
          {w.project.deadline
            ? ` · deadline ${w.project.deadline} (day ${w.project.deadline_day})`
            : " · no deadline, so nothing is claimed about feasibility"}
        </p>
      </section>

      {/* ---------------------------------------------------- the verdict */}
      {preview.can_commit ? (
        <Callout
          tone="low"
          title={
            <span className="inline-flex items-center gap-1.5">
              <Check className={ICON} aria-hidden />
              Nothing blocks this import
            </span>
          }
        >
          <span className="text-xs text-dim">
            {c.rows_rejected > 0
              ? `${c.rows_rejected} row${c.rows_rejected === 1 ? " does" : "s do"} not import, which is not a reason to refuse the rest — but read them before you commit.`
              : "Every row in the file produced a task."}
          </span>
        </Callout>
      ) : (
        <Callout
          tone="high"
          title={
            <span className="inline-flex items-center gap-1.5">
              <TriangleAlert className={ICON} aria-hidden />
              This cannot be committed
            </span>
          }
        >
          <ul className="flex max-w-3xl flex-col gap-1 text-xs">
            {preview.blocking.map((reason, i) => (
              <li key={i}>
                · <Prose>{reason}</Prose>
              </li>
            ))}
          </ul>
        </Callout>
      )}

      <Cycles cycles={preview.cycles} />
      <RejectedRows rows={preview.rejected_rows} rowsRead={c.rows_read} />
      <DroppedDependencies dropped={preview.dropped_dependencies} />
      <UnmappedColumns columns={preview.unmapped_columns} />

      {/* ------------------------------------------- every reading, per row */}
      <section>
        <Head right={`${preview.rows.length} rows`}>
          How every value was read
        </Head>
        <p className="mb-2 max-w-3xl text-xs text-dim">
          What the file said, what it became, and why. The readings the
          importer <em>chose</em> are open; the ones it took straight out of
          the file are one click away — that way round, because a guess you did
          not know about is the only one that can hurt you.{" "}
          <Prose>{preview.row_numbering}</Prose>
        </p>
        <div className={cn(SCROLL, "px-3")}>
          <ul className="flex flex-col divide-y divide-border/60">
            {preview.rows.map((row) => (
              <RowReadings key={`${row.row}-${row.task_key}`} row={row} />
            ))}
          </ul>
        </div>
      </section>

      {/* -------------------------------------------------- what it becomes */}
      <section>
        <Head right={`${w.tasks.length} tasks · ${w.dependencies.length} dependencies · ${w.resources.length} resources`}>
          The workflow this would be
        </Head>
        <div className={SCROLL}>
          <Table className="text-[13px]">
            <TableHeader>
              <TableRow className="border-border hover:bg-transparent">
                <TableHead className={cn("h-7 px-2", LABEL)}>Task key</TableHead>
                <TableHead className={cn("h-7 px-2", LABEL)}>Name</TableHead>
                <TableHead className={cn("h-7 w-20 px-2 text-right", LABEL)}>
                  Effort
                </TableHead>
                <TableHead className={cn("h-7 w-28 px-2", LABEL)}>
                  Status
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {w.tasks.map((t) => (
                <TableRow key={t.key} className="border-border/50">
                  <TableCell className="px-2 py-1 font-mono text-xs text-dim">
                    {t.key}
                  </TableCell>
                  <TableCell className="max-w-[22rem] truncate px-2 py-1">
                    {t.name}
                  </TableCell>
                  <TableCell className="px-2 py-1 text-right">
                    {days(t.effort)}
                  </TableCell>
                  <TableCell className="px-2 py-1 text-dim">
                    {statusLabel(t.status)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>

        <Reveal
          summary={`the ${w.dependencies.length} dependencies, and the link in the file behind each`}
        >
          <div className={SCROLL}>
            <Table className="text-[13px]">
              <TableHeader>
                <TableRow className="border-border hover:bg-transparent">
                  <TableHead className={cn("h-7 px-2", LABEL)}>Waits</TableHead>
                  <TableHead className={cn("h-7 w-20 px-2", LABEL)}>
                    Consumes
                  </TableHead>
                  <TableHead className={cn("h-7 px-2", LABEL)}>
                    Because the file said
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {w.dependencies.map((d, i) => (
                  <TableRow key={i} className="border-border/50">
                    <TableCell className="px-2 py-1 font-mono text-xs whitespace-nowrap">
                      {d.from_task} → {d.to_task}
                    </TableCell>
                    <TableCell className="px-2 py-1 text-dim">
                      {d.consumes ? "yes" : "no"}
                    </TableCell>
                    <TableCell className="max-w-[26rem] px-2 py-1 leading-snug whitespace-normal text-dim">
                      {d.because}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </Reveal>

        <Reveal
          summary={`the ${w.resources.length} resources this would create`}
        >
          <ul className="flex flex-col gap-0.5 text-xs">
            {w.resources.map((r) => (
              <li key={r.key} className="flex flex-wrap gap-x-2">
                <span className={TOKEN}>{r.key}</span>
                <span>{r.name}</span>
                <span className="text-dim">
                  {resourceKindLabel(r.kind)} · capacity {r.capacity} · {r.task_count} task
                  {r.task_count === 1 ? "" : "s"}
                </span>
              </li>
            ))}
          </ul>
        </Reveal>
      </section>

      {/* ------------------------------------------------ what it rests on */}
      <section>
        <Head>What this import rests on</Head>
        <AssumptionsView block={preview.assumptions} />
      </section>

      {/* ------------------------------------------------------ the commit */}
      <section>
        <Head>Create the workflow</Head>
        <div className="flex flex-wrap items-end gap-x-4 gap-y-3">
          <label className="flex w-full max-w-md flex-col gap-1">
            <span className={LABEL}>Name</span>
            <Input
              value={name}
              onChange={(e) => onName(e.target.value)}
              placeholder="What to call the imported workflow"
            />
          </label>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Button
            onClick={onCommit}
            disabled={!preview.can_commit || !name.trim() || busy !== ""}
          >
            {busy === "commit" && (
              <LoaderCircle
                className="animate-spin"
                data-icon="inline-start"
                aria-hidden
              />
            )}
            Import as a new workflow
          </Button>
          <Button variant="ghost" onClick={onBack} disabled={busy !== ""}>
            Choose a different file
          </Button>
          {!preview.can_commit && (
            <Badge
              variant="outline"
              className={cn("font-normal", bandClasses("high"))}
            >
              blocked
            </Badge>
          )}
        </div>
        <p className="mt-2 max-w-3xl text-xs text-dim">
          This creates a new workflow with its own version 1. It never merges
          into one you already have, and the import writes no history: the event
          log starts empty, so the analysis will honestly report a lower
          evidence tier and name the checks it could not run.
        </p>
      </section>
    </>
  );
}

/* -------------------------------------------------------------- committed */

function CommittedView({
  result,
  onOpen,
}: {
  result: ImportCommitResult;
  onOpen: () => void;
}) {
  const p = result.project;
  const c = result.counts;
  return (
    <>
      <section>
        <Head right={`version ${p.version_no}${p.is_draft ? " · draft" : ""}`}>
          Imported
        </Head>
        <div className="flex flex-wrap items-start gap-x-8 gap-y-3 border-y border-border py-2.5">
          <Metric lead label="workflow" value={p.name} sub={`starts ${p.start_date}`} />
          <Metric label="tasks" value={c.tasks} sub={`${c.dependencies} dependencies`} />
          <Metric label="resources" value={c.resources} />
          <Metric
            label="rows rejected"
            value={c.rows_rejected}
            sub={c.rows_rejected ? "still listed below" : "none"}
            tone={c.rows_rejected ? bandText("high") : undefined}
          />
          <Metric
            label="links dropped"
            value={c.dependencies_dropped}
            tone={c.dependencies_dropped ? bandText("moderate") : undefined}
          />
        </div>
        <p className="mt-2 max-w-3xl text-xs text-dim">{result.next}</p>
      </section>

      {/* These are carried into the commit response on purpose, and shown
          again here for the same reason: committing must not be a way to
          stop seeing what did not come across. */}
      <RejectedRows rows={result.rejected_rows} rowsRead={c.rows_read} />
      <DroppedDependencies dropped={result.dropped_dependencies} />
      <UnmappedColumns columns={result.unmapped_columns} />

      <section>
        <Head>What this import rests on</Head>
        <AssumptionsView block={result.assumptions} />
      </section>

      <section className="flex flex-wrap items-center gap-2 border-t border-border pt-3">
        <Button onClick={onOpen}>Open {p.name}</Button>
        <span className="text-xs text-dim">
          Every dependency came across as ordering only. Mark the consuming
          edges by hand in the builder to get the requirement-change blast
          radius back.
        </span>
      </section>
    </>
  );
}
