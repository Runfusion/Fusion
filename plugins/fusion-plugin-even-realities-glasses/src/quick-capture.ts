import type { PluginContext } from "@fusion/plugin-sdk";
import { resolveDefaultWorkflowIr, resolveWorkflowIrById } from "@fusion/core";
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
FNXC:PluginLifecycleColumns 2026-07-31-06:10 (PR #2644 review, greptile P1 — third revision, and the
union was wrong):

ACCEPT ONLY THE COLUMNS OF THE WORKFLOW THE NEW CARD WILL ACTUALLY USE.

  v1: the builtin default IR      -> rejected a custom board's own columns.
  v2: the union of ALL workflows  -> accepted `checking` from workflow B while the card lands on
                                     workflow A, which has no such column. The create then fails at
                                     the server, or the card lands somewhere the operator did not ask
                                     for. I called that "deliberately permissive"; it is just wrong,
                                     and the reviewer was right to say so.
  v3 (this): the PROJECT'S DEFAULT workflow, which is the workflow a quick-captured card is created
     into. `getDefaultWorkflowId()` is the same authority `resolveWorkflowIntakeFacts` uses in
     task-creation, so capture validation and card creation now agree by construction rather than by
     coincidence.

The union felt safer because it rejected less. "Rejects less" is not the same as "correct": accepting
a column the card cannot land in moves the failure downstream, past the point where the operator could
still hear about it.
*/
async function declaredCaptureColumnIds(
  taskStore: PluginContext["taskStore"],
): Promise<ReadonlySet<string>> {
  const ids = new Set<string>();
  try {
    const store = taskStore as unknown as { getDefaultWorkflowId?: () => Promise<string | undefined> };
    const workflowId = await store.getDefaultWorkflowId?.();
    const ir = workflowId
      ? await resolveWorkflowIrById(taskStore as never, workflowId)
      : resolveDefaultWorkflowIr();
    for (const column of (ir as { columns?: Array<{ id?: unknown }> }).columns ?? []) {
      if (typeof column?.id === "string") ids.add(column.id);
    }
  } catch {
    /* fall through to the legacy vocabulary */
  }
  if (ids.size > 0) return ids;
  /* A column-less IR gives no basis to decide; the legacy five keep prior behavior. */
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
