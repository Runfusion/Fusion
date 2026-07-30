import type { PluginContext } from "@fusion/plugin-sdk";
import { resolveDefaultWorkflowIr } from "@fusion/core";
import { taskToCard, type GlassesCard } from "./cards.js";
import type { TaskColumn } from "./settings.js";

export const FILLER_TOKENS = ["um", "uh", "er", "like", "you know"] as const;

const DEFAULT_MAX_TITLE_CHARS = 80;

export class GlassesInputError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "GlassesInputError";
  }
}

export function normalizeDescription(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (value == null) return "";
  return String(value).trim();
}

export function stripWakePhrases(text: string): string {
  const trimmed = text.trim();
  return trimmed
    .replace(/^\s*(?:hey\s+fusion|ok\s+fusion|fusion|note|task|capture)\s*,?\s*/i, "")
    .trim();
}

export function stripFillerTokens(text: string): string {
  let cleaned = text.replace(/\s+/g, " ").trim();
  cleaned = cleaned.replace(/[.\s]+$/g, "").trim();

  for (const token of FILLER_TOKENS) {
    const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    cleaned = cleaned.replace(new RegExp(`(^|[\\s,;:!?()-])${escaped}(?=$|[\\s,;:!?()-])`, "gi"), "$1");
  }

  return cleaned.replace(/\s+/g, " ").replace(/\s+([,;:!?])/g, "$1").trim().replace(/^[,;:!?]+\s*/, "");
}

export function splitTitleAndDescription(
  text: string,
  opts: { maxTitleChars?: number } = {},
): { title: string; description: string } {
  const maxTitleChars = opts.maxTitleChars ?? DEFAULT_MAX_TITLE_CHARS;
  const normalized = text.trim();
  if (!normalized) return { title: "", description: "" };

  const boundaryMatch = normalized.match(/[.!?]\s|\n/);
  const boundaryIndex = boundaryMatch?.index ?? -1;

  let title = boundaryIndex >= 0 ? normalized.slice(0, boundaryIndex + (boundaryMatch?.[0] === "\n" ? 0 : 1)).trim() : normalized;
  let remainder = boundaryIndex >= 0 ? normalized.slice(boundaryIndex + (boundaryMatch?.[0].length ?? 0)).trim() : "";

  if (title.length > maxTitleChars) {
    const candidate = title.slice(0, maxTitleChars);
    const lastSpace = candidate.lastIndexOf(" ");
    const cut = lastSpace > 0 ? lastSpace : maxTitleChars;
    const overflow = title.slice(cut).trim();
    title = title.slice(0, cut).trim();
    remainder = [overflow, remainder].filter(Boolean).join(" ").trim();
  }

  const descriptionBase = remainder || title;
  const description = normalizeDescription(descriptionBase).slice(0, 280);
  return { title, description };
}

export function parseUtterance(raw: unknown, opts: { maxTitleChars?: number } = {}): { title: string; description: string } {
  const text = normalizeDescription(raw);
  const stripped = stripFillerTokens(stripWakePhrases(text));
  if (!stripped) {
    throw new GlassesInputError(400, "empty utterance");
  }
  return splitTitleAndDescription(stripped, opts);
}

/*
FNXC:PluginLifecycleColumns 2026-07-30-13:10 (Phase C convergence — quick capture):

THE ACCEPTED COLUMNS ARE THE BOARD'S, not a hand-listed five. The old list was wrong in BOTH
directions after U11 (#2515):

  - it ACCEPTED `triage`, a column the default board no longer declares, so quick capture
    happily forwarded it and the create failed at the server — at the far end of a voice
    interaction, where the operator hears a generic failure;
  - it REJECTED every column of a renamed or custom board, so an operator saying "put it in
    checking" got a 400 for a column their own board declares.

Resolved from `resolveDefaultWorkflowIr()`, which is the same default the dashboard's own
board-workflows payload reports (`DEFAULT_WORKFLOW_LANE_ID`). Deliberately NOT a per-task
resolution: the task does not exist yet, so there is no selection to resolve through.

CORRECTION to what I wrote on PR #2607: I described this as SILENT substitution. It is not —
`runQuickCapture` already compares the normalized value against the request and throws 400 on a
mismatch, so an unusable column was visibly rejected, not quietly swapped. The bug is a wrong
accept/reject set, which is milder than I claimed.
*/
async function declaredCaptureColumnIds(
  taskStore: PluginContext["taskStore"],
): Promise<ReadonlySet<string>> {
  const ids = new Set<string>();
  try {
    const ir = resolveDefaultWorkflowIr() as { columns?: Array<{ id?: unknown }> };
    for (const column of ir.columns ?? []) {
      if (typeof column?.id === "string") ids.add(column.id);
    }
  } catch {
    /* fall through */
  }
  /*
  FNXC:PluginLifecycleColumns 2026-07-31-02:10 (PR #2644 review, greptile P1):
  THE BUILT-IN DEFAULT IS NOT NECESSARILY THIS PROJECT'S BOARD. `resolveDefaultWorkflowIr()` takes no
  project and no task, so on a board built from a CUSTOM workflow it rejected that board's own
  columns — `checking` came back "invalid column" for an operator whose board declares it. My earlier
  note claimed this matched "the same default the dashboard reports", which is true only for projects
  that use the builtin lineage.

  Quick capture creates a NEW task, so there is no selection to resolve through — the honest answer is
  the union of every column any workflow in this project declares. That accepts a custom board's own
  columns and still rejects a column no board has, which is the operator-visible distinction. It is
  deliberately PERMISSIVE across workflows rather than guessing which one a new card will land on: the
  server validates the final create, so a wrong-workflow column surfaces as a real error instead of
  the silent default-substitution this replaces.
  */
  try {
    const store = taskStore as unknown as {
      listWorkflowDefinitions?: () => Promise<Array<{ ir?: unknown }>>;
    };
    for (const definition of (await store.listWorkflowDefinitions?.()) ?? []) {
      const ir = typeof definition?.ir === "string" ? undefined : definition?.ir;
      for (const column of (ir as { columns?: Array<{ id?: unknown }> } | undefined)?.columns ?? []) {
        if (typeof column?.id === "string") ids.add(column.id);
      }
    }
  } catch {
    /* a store without the workflows surface keeps the builtin answer */
  }
  if (ids.size > 0) return ids;
  /* A column-less IR and no definitions give no basis to decide; the legacy five keep prior behavior. */
  return LEGACY_CAPTURE_COLUMN_IDS;
}

const LEGACY_CAPTURE_COLUMN_IDS: ReadonlySet<string> = new Set([
  "triage", "todo", "in-progress", "in-review", "done",
]);

async function normalizeCaptureColumn(
  taskStore: PluginContext["taskStore"],
  value: unknown,
  fallback: TaskColumn,
): Promise<TaskColumn> {
  const raw = normalizeDescription(value);
  if (raw && (await declaredCaptureColumnIds(taskStore)).has(raw)) {
    return raw as TaskColumn;
  }
  return fallback;
}

export async function runQuickCapture(
  input: { text: unknown; column?: unknown },
  deps: {
    taskStore: PluginContext["taskStore"];
    pluginId: string;
    defaultColumn: TaskColumn;
  },
): Promise<{ task: Awaited<ReturnType<PluginContext["taskStore"]["createTask"]>>; card: GlassesCard }> {
  const { title, description } = parseUtterance(input.text);
  const requested = input.column;
  const normalizedColumn = await normalizeCaptureColumn(deps.taskStore, requested, deps.defaultColumn);
  if (requested !== undefined && normalizeDescription(requested) !== normalizedColumn) {
    throw new GlassesInputError(400, "invalid column");
  }

  const persistedDescription = `${title}\n${description}`.trim();
  const task = await deps.taskStore.createTask({
    description: persistedDescription,
    column: normalizedColumn,
    source: {
      sourceType: "api",
      sourceMetadata: {
        pluginId: deps.pluginId,
        channel: "glasses-quick-capture",
      },
    },
  });

  return {
    task,
    card: taskToCard(task as never),
  };
}
