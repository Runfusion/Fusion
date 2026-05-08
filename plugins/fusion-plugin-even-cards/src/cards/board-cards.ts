import { DEFAULT_MAX_CARDS_PER_DECK, DEFAULT_MAX_CHARS_PER_LINE, DEFAULT_MAX_LINES_PER_CARD, statusBadge, truncateLine, wrapLines } from "./format.js";
import { taskToCard } from "./task-cards.js";
import type { BoardSummary, CardDeck, FusionColumn, FusionTask, GlassesCard } from "./types.js";

const COLUMN_ORDER: FusionColumn[] = ["triage", "todo", "in-progress", "in-review", "done", "archived"];

function boardSummary(tasks: FusionTask[]): BoardSummary {
  const counts = Object.fromEntries(COLUMN_ORDER.map((column) => [column, 0]));
  let updatedAt: string | null = null;
  for (const task of tasks) {
    counts[task.column] = (counts[task.column] ?? 0) + 1;
    if (!updatedAt || task.updatedAt > updatedAt) updatedAt = task.updatedAt;
  }
  return { counts, updatedAt };
}

function summaryCard(summary: BoardSummary, now: string, maxCharsPerLine: number, maxLines: number): GlassesCard {
  const summaryText = `Triage ${summary.counts.triage} Todo ${summary.counts.todo} Doing ${summary.counts["in-progress"]} Review ${summary.counts["in-review"]} Done ${summary.counts.done}`;
  return {
    id: "summary",
    kind: "summary",
    title: truncateLine("Fusion board", maxCharsPerLine),
    lines: wrapLines(summaryText, maxCharsPerLine, maxLines),
    badge: statusBadge("todo"),
    updatedAt: summary.updatedAt ?? now,
  };
}

export function boardToDeck(tasks: FusionTask[], opts?: { maxCharsPerLine?: number; maxLines?: number; maxCards?: number; now?: string }): CardDeck {
  const maxCharsPerLine = opts?.maxCharsPerLine ?? DEFAULT_MAX_CHARS_PER_LINE;
  const maxLines = opts?.maxLines ?? DEFAULT_MAX_LINES_PER_CARD;
  const maxCards = opts?.maxCards ?? DEFAULT_MAX_CARDS_PER_DECK;
  const now = opts?.now ?? new Date().toISOString();

  const summary = boardSummary(tasks);
  const active = tasks
    .filter((task) => task.column !== "archived" && task.column !== "done")
    .sort((a, b) => (b.updatedAt === a.updatedAt ? b.id.localeCompare(a.id) : b.updatedAt.localeCompare(a.updatedAt)))
    .slice(0, Math.max(0, maxCards - 1));

  const cards: GlassesCard[] = [summaryCard(summary, now, maxCharsPerLine, maxLines), ...active.map((task) => taskToCard(task, { maxCharsPerLine, maxLines, now }))];
  return { cards, summary };
}
