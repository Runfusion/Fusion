import type { PluginContext } from "@fusion/plugin-sdk";
import { isBuiltinWorkflowId, resolveDefaultWorkflowIr, resolveLifecycleColumns, resolveWorkflowIrById } from "@fusion/core";
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
FNXC:PluginLifecycleColumns 2026-07-31-10:50 (PR #2644 review — I split the snapshot AGAIN):

ONE RESOLUTION FOR BOTH ANSWERS. `declaredCaptureColumnIds` and the intake lookup each resolved the
workflow independently, so a workflow edit between them validated against one revision and selected the
intake column from another — persisting a card in a column the validated revision does not declare.

This is the THIRD place in this branch I have made the same mistake (the executor's resume lanes, the
glasses lane context, and now here), and the second time after fixing it elsewhere. The shape is always
the same: two helpers that each look correct, called in sequence, each doing its own read. If a function
needs two facts about one workflow, it needs one snapshot — not two helpers that happen to agree most of
the time.

WHAT THE BOARD IS: the PROJECT'S DEFAULT workflow, which is the workflow a quick-captured card is created
into. Not the builtin default (v1, which rejected a custom board's own columns) and not the union of all
workflows (v2, which accepted columns the card cannot land in). `getDefaultWorkflowId()` is the same
authority `resolveWorkflowIntakeFacts` uses in task-creation, so validation and creation agree by
construction rather than by coincidence.
*/
async function resolveCaptureBoard(
  taskStore: PluginContext["taskStore"],
): Promise<{ declared: ReadonlySet<string>; intake?: string }> {
  try {
    const store = taskStore as unknown as {
      getDefaultWorkflowId?: () => Promise<string | undefined>;
      getWorkflowDefinition?: (id: string) => Promise<{ ir?: unknown } | undefined>;
    };
    const workflowId = await store.getDefaultWorkflowId?.();
    let ir: unknown;
    if (workflowId && !isBuiltinWorkflowId(workflowId) && store.getWorkflowDefinition) {
      const definition = await store.getWorkflowDefinition(workflowId);
      /*
      FNXC:PluginLifecycleColumns 2026-07-31-12:30 (PR #2644 review — and I could NOT prove the fix, so
      it is not here):
      The reviewer is right that `resolveWorkflowIrById` silently substitutes the BUILTIN default IR when
      a configured custom workflow is missing or unparsable, so its columns get treated as this project's
      vocabulary. What I could not establish is a BETTER answer for that state:
        - falling back to the legacy five ACCEPTS `triage`, the column #2515 deleted — creating a card in
          a column no board has, which is the defect I fixed earlier in this same branch;
        - accepting nothing rejects every explicitly-named column on a project whose workflow row is
          merely missing, which is harsher than the substitution;
        - refusing the capture outright loses the operator's utterance.
      Every candidate trades one wrong behaviour for another, and my tests could not distinguish them —
      the isolated revert stayed green, which is the signal that I was about to ship an unprovable change.
      So the substitution stands, named here, and the DECISION is left to whoever owns the missing-workflow
      contract rather than guessed at in a plugin.

      What IS fixed and provable: the definition row we read IS the snapshot, so this stays to ONE read.
      A stored STRING ir is the only case needing core to parse it.
      */
      ir = definition?.ir != null && typeof definition.ir !== "string"
        ? definition.ir
        : await resolveWorkflowIrById(taskStore as never, workflowId);
    } else {
      ir = workflowId
        ? await resolveWorkflowIrById(taskStore as never, workflowId)
        : resolveDefaultWorkflowIr();
    }
    const declared = new Set<string>();
    for (const column of (ir as { columns?: Array<{ id?: unknown }> }).columns ?? []) {
      if (typeof column?.id === "string") declared.add(column.id);
    }
    if (declared.size === 0) return { declared: LEGACY_CAPTURE_COLUMN_IDS };
    return { declared, intake: resolveLifecycleColumns(ir as never)?.intake };
  } catch {
    /* A column-less or unresolvable workflow gives no basis to decide; the legacy five keep prior behavior. */
    return { declared: LEGACY_CAPTURE_COLUMN_IDS };
  }
}

const LEGACY_CAPTURE_COLUMN_IDS: ReadonlySet<string> = new Set([
  "triage", "todo", "in-progress", "in-review", "done",
]);

/*
FNXC:PluginLifecycleColumns 2026-07-31-08:50:
THE CONFIGURED DEFAULT IS ALSO A COLUMN, and it was the one path that never got checked. A capture with
no `column` returned the plugin SETTING verbatim — `triage` out of the box, the column #2515 deleted — so
on a project whose default workflow does not declare it, every voice capture created a card in an
undeclared column. When the configured default is not declared, the honest destination is the workflow's
own INTAKE column: that is where a new card belongs, and it now comes from the SAME snapshot as the
validation.
*/
async function normalizeCaptureColumn(
  taskStore: PluginContext["taskStore"],
  value: unknown,
  fallback: TaskColumn,
): Promise<TaskColumn> {
  const board = await resolveCaptureBoard(taskStore);
  const raw = normalizeDescription(value);
  if (raw && board.declared.has(raw)) return raw as TaskColumn;
  if (board.declared.has(fallback)) return fallback;
  return (board.intake ?? fallback) as TaskColumn;
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
