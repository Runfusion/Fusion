import type { Task } from "@fusion/core";
import type { NotificationReason } from "./notifications/types.js";

export type GlassesCardAction = {
  type: "start-work" | "request-review" | "quick-capture";
  taskId?: string;
  label: string;
};

export type GlassesCard = {
  id: string;
  kind: "task" | "summary";
  title: string;
  lines: string[];
  badge: string;
  taskId?: string;
  updatedAt?: string;
  actions?: GlassesCardAction[];
};

export type BoardSummary = {
  counts: Record<string, number>;
  updatedAt: string | null;
};

export type CardDeck = {
  cards: GlassesCard[];
  summary: BoardSummary;
};

const COLUMN_ORDER: Array<Task["column"]> = ["triage", "todo", "in-progress", "in-review", "done", "archived"];

export const DEFAULT_MAX_CHARS_PER_LINE = 24;
export const DEFAULT_MAX_LINES_PER_CARD = 4;
export const DEFAULT_MAX_CARDS_PER_DECK = 8;
const DEFAULT_MAX_TITLE = 80;

export function truncateLine(value: string, maxChars = DEFAULT_MAX_TITLE): string {
  const trimmed = value.trim();
  if (trimmed.length <= maxChars) return trimmed;
  if (maxChars <= 1) return "…";
  return `${trimmed.slice(0, Math.max(0, maxChars - 1))}…`;
}

export function wrapLines(
  value: string,
  opts: { maxCharsPerLine?: number; maxLines?: number } = {},
): string[] {
  const maxCharsPerLine = Math.max(8, opts.maxCharsPerLine ?? 36);
  const maxLines = Math.max(1, opts.maxLines ?? 2);
  const words = value.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length > maxCharsPerLine && current) {
      lines.push(current);
      current = word;
      if (lines.length >= maxLines) break;
    } else {
      current = candidate;
    }
  }
  if (lines.length < maxLines && current) lines.push(current);
  if (lines.length > maxLines) return lines.slice(0, maxLines);
  if (words.join(" ").length > lines.join(" ").length && lines.length > 0) {
    lines[lines.length - 1] = truncateLine(lines[lines.length - 1], maxCharsPerLine);
  }
  return lines;
}

/*
FNXC:WorkflowLifecycleColumns 2026-07-31-11:05:
An unrecognised lane shows its OWN name, not "todo" — the fallback was actively wrong, not merely blank.

This read `COLUMN_BADGES[column] ?? "todo"`, where `COLUMN_BADGES` mapped the six legacy ids to
themselves. On a board whose lanes are named anything else every lookup missed and the badge came back
`"todo"` — a card sitting in review told the wearer it was un-started, and every card on the board
carried the same badge. On a display with room for one word that is a confident wrong answer, which is
worse than an unrecognised one.

The badge IS the column id, so the function now says so. That also retires the map: once the fallback
is the id, a table mapping each legacy id to itself decides nothing, and six lane literals were sitting
in this file doing no work. Behaviour for legacy boards is byte-identical either way — the map was an
identity — and it is deleted here rather than left as a decoy for the next reader of this file.

Mirrors `columnLabel` in the CLI (`COLUMN_LABELS[column] ?? column`) for the same reason: a board that
calls its lane `checking` should read `checking`, which is true and already what its operator
recognises. No resolution needed — the id is in hand at the call site.

Missed by #2968, which fixed the summary card's counts in this same file and did not look one function
further at the per-card badge those counts sit above.
*/
export function statusBadge(column: Task["column"]): string {
  return column;
}

export function formatRelativeAge(updatedAt: string, opts: { now?: () => Date } = {}): string {
  const now = opts.now?.() ?? new Date();
  const at = new Date(updatedAt);
  const diffMs = Math.max(0, now.getTime() - at.getTime());
  const mins = Math.floor(diffMs / 60_000);
  if (mins < 1) return "updated just now";
  if (mins < 60) return `updated ${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `updated ${hours}h ago`;
  return `updated ${Math.floor(hours / 24)}d ago`;
}

function boardSummary(tasks: Task[]): BoardSummary {
  const counts = Object.fromEntries(COLUMN_ORDER.map((column) => [column, 0]));
  let updatedAt: string | null = null;
  for (const task of tasks) {
    counts[task.column] = (counts[task.column] ?? 0) + 1;
    if (!updatedAt || task.updatedAt > updatedAt) updatedAt = task.updatedAt;
  }
  return { counts, updatedAt };
}

/*
FNXC:WorkflowLifecycleColumns 2026-07-30-22:20:
The summary card names the lanes the BOARD actually has, not five hardcoded ids.

This line read `Triage ${counts.triage} Todo ${counts.todo} Doing ${counts["in-progress"]} Review
${counts["in-review"]} Done ${counts.done}`. `boardSummary` seeds those five keys to 0 and then
counts by real `task.column`, so on a board whose lanes are named anything else EVERY interpolated
value is the seeded 0: the summary card — the FIRST card in every deck, and the whole payload of
`GET /board/summary` — reads "Triage 0 Todo 0 Doing 0 Review 0 Done 0" while the real work sits in
lanes it never mentions. The wearer is told the board is empty.

It is also wrong on the DEFAULT board today: U11 (#2515) deleted the `triage` lane, so `Triage 0` is
always dead text — 9 of the 24 characters this display gets per line, spent on a lane no board has.

Derived from `counts` rather than taken as a resolved-lanes parameter. That is deliberate: this
program's recurring defect is the "optional lane answer + documented literal fallback" shape shipped
without wiring the caller (see `unwired-lane-parameter-guard.test.ts` — five were live on `main` at
once), and `counts` is already keyed by real `task.column` values, so the lane vocabulary is in hand
with no resolution, no new plumbing, and nothing that can be left unwired.

Zero-count lanes are dropped so the scarce line budget goes to lanes with work; legacy ids keep their
familiar order and labels, unknown ids sort after them alphabetically so output stays deterministic.
`counts` itself is unchanged — the route returns it as the API body and consumers still see every key.
*/
const LANE_LABELS: Record<string, string> = {
  triage: "Triage",
  todo: "Todo",
  "in-progress": "Doing",
  "in-review": "Review",
  done: "Done",
  archived: "Archived",
};

function orderedLanes(counts: Record<string, number>): string[] {
  const rank = (id: string) => {
    const index = COLUMN_ORDER.indexOf(id as Task["column"]);
    return index === -1 ? COLUMN_ORDER.length : index;
  };
  return Object.keys(counts).sort((a, b) => (rank(a) === rank(b) ? a.localeCompare(b) : rank(a) - rank(b)));
}

function boardSummaryCardFromCounts(summary: BoardSummary, now: string, maxCharsPerLine: number, maxLines: number): GlassesCard {
  const occupied = orderedLanes(summary.counts).filter((id) => (summary.counts[id] ?? 0) > 0);
  const summaryText = occupied.length
    ? occupied.map((id) => `${LANE_LABELS[id] ?? id} ${summary.counts[id]}`).join(" ")
    : "No active work";
  return {
    id: "summary",
    kind: "summary",
    title: truncateLine("Fusion board", maxCharsPerLine),
    lines: wrapLines(summaryText, { maxCharsPerLine, maxLines }),
    badge: statusBadge("todo"),
    updatedAt: summary.updatedAt ?? now,
  };
}

export function taskToCard(
  task: Task,
  opts: { maxCharsPerLine?: number; maxLines?: number; now?: () => Date } = {},
): GlassesCard {
  const title = typeof task.title === "string" && task.title.trim() ? task.title : task.description;
  const maxCharsPerLine = opts.maxCharsPerLine ?? DEFAULT_MAX_CHARS_PER_LINE;
  const maxLines = opts.maxLines ?? DEFAULT_MAX_LINES_PER_CARD;
  return {
    id: task.id,
    kind: "task",
    title: truncateLine(`${task.id.toUpperCase()} ${title}`, maxCharsPerLine),
    lines: wrapLines(
      `Priority ${task.priority ?? "normal"} Assignee ${task.assignedAgentId ?? task.assigneeUserId ?? "unassigned"} Age ${formatRelativeAge(task.createdAt ?? task.updatedAt, { now: opts.now })}`,
      { maxCharsPerLine, maxLines },
    ),
    badge: statusBadge(task.column),
    taskId: task.id,
    updatedAt: task.updatedAt,
    actions: [
      { type: "start-work", taskId: task.id, label: "Start work" },
      { type: "request-review", taskId: task.id, label: "Request review" },
    ],
  };
}

/*
FNXC:WorkflowLifecycleColumns 2026-07-31-02:40:
`terminalColumns` — which lanes mean "finished" — supplied by the route, not guessed here.

The filter below named `archived` and `done`, and on a board that calls its finished lane anything
else the consequence is not cosmetic: the deck is capped at `maxCards`, so every completed card
counts as active and PUSHES REAL WORK OFF the glasses display. The wearer sees a shorter list of
live tasks the more work the team finishes.

Optional with a documented default so the existing `boardToDeck([task], { maxCards: 1 })` summary
call is unchanged, and because the earlier audit of this deck was right that `cards.ts` itself has no
resolution source — it takes plain `Task` rows. What that audit got wrong is the conclusion: the note
it inherited was written for the DEPRECATED `fusion-plugin-even-cards`, which depends on
`@fusion/plugin-sdk` alone. This package lists `@fusion/core` as a runtime dependency and already
calls `resolveWorkflowIrById`/`resolveLifecycleColumns` in `quick-capture.ts` and `agent-actions.ts`,
so the caller can resolve; only this function cannot.

The route resolves it once per request. `scripts/lib/unwired-lane-parameter.mjs` watches the name, so
an unwired version of this parameter fails the build rather than sitting here looking converted.
*/
export function boardToDeck(
  tasks: Task[],
  opts: { maxCharsPerLine?: number; maxLines?: number; maxCards?: number; now?: string; terminalColumns?: ReadonlySet<string> } = {},
): CardDeck {
  const maxCharsPerLine = opts.maxCharsPerLine ?? DEFAULT_MAX_CHARS_PER_LINE;
  const maxLines = opts.maxLines ?? DEFAULT_MAX_LINES_PER_CARD;
  const maxCards = opts.maxCards ?? DEFAULT_MAX_CARDS_PER_DECK;
  const now = opts.now ?? new Date().toISOString();
  const summary = boardSummary(tasks);
  /* DELIBERATE-LITERAL — the degraded default when the caller resolved no lanes; see above. */
  const isTerminal = (column: string) =>
    opts.terminalColumns ? opts.terminalColumns.has(column) : column === "archived" || column === "done";
  const active = tasks
    .filter((task) => !isTerminal(task.column))
    .sort((a, b) => (b.updatedAt === a.updatedAt ? b.id.localeCompare(a.id) : b.updatedAt.localeCompare(a.updatedAt)))
    .slice(0, Math.max(0, maxCards - 1));

  return {
    cards: [
      boardSummaryCardFromCounts(summary, now, maxCharsPerLine, maxLines),
      ...active.map((task) => taskToCard(task, { maxCharsPerLine, maxLines, now: () => new Date(now) })),
    ],
    summary,
  };
}

export function boardSummaryCard(tasksByColumn: Record<string, number>): GlassesCard {
  const ordered = ["triage", "todo", "in-progress", "in-review", "done"];
  return {
    id: "board-summary",
    kind: "summary",
    title: "Fusion Board Summary",
    lines: ordered.map((column) => `${column}: ${tasksByColumn[column] ?? 0}`),
    badge: "todo",
  };
}

export function notificationCard(
  task: Task,
  reason: NotificationReason,
  opts: { now?: () => Date; maxCharsPerLine?: number; maxLines?: number } = {},
): GlassesCard {
  const baseTitle = typeof task.title === "string" && task.title.trim() ? task.title : task.description;
  const reasonTitle =
    reason === "entered-column"
      ? task.column === "in-review"
        ? "In review"
        : "Moved in"
      : reason === "new-task"
        ? "New task"
        : reason === "completed"
          ? "Done"
          : "Moved out";

  return {
    id: `notif:${task.id}:${reason}`,
    kind: "task",
    title: `${reasonTitle} · ${truncateLine(baseTitle, opts.maxCharsPerLine ?? DEFAULT_MAX_TITLE)}`,
    lines: [
      `assignee: ${task.assignedAgentId ?? task.assigneeUserId ?? "unassigned"}`,
      ...wrapLines(formatRelativeAge(task.updatedAt, { now: opts.now }), {
        maxCharsPerLine: opts.maxCharsPerLine,
        maxLines: opts.maxLines ?? 1,
      }),
    ],
    badge: statusBadge(task.column),
    taskId: task.id,
    updatedAt: task.updatedAt,
  };
}
