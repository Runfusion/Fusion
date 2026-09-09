import {
  buildEvalFollowUpSuggestionId,
  normalizeEvalFollowUpText,
  type EvalFollowUpPolicyMode,
  type EvalFollowUpSuggestion,
  type EvalScoreBand,
  type FollowUpDraft,
  type TaskStore,
} from "@fusion/core";
import { resolveTerminalColumnsFor } from "../executor.js";
import type { resolveWorkflowIrForTask } from "@fusion/core";

/*
FNXC:Evals 2026-07-26-00:00:
Eval follow-ups inline one dedup rule: never create a second card for the same `suggestionId` under the same parent while one is still open. Workflow Complete columns are excluded so a later evaluation can legitimately file a fresh follow-up.
*/
/*
FNXC:WorkflowResolvedColumns 2026-07-30-19:10 (the dedup blocked new follow-ups forever on a renamed board):
A finished follow-up in a renamed Complete lane must not read as open and suppress future work.
Resolve each candidate through `resolveTerminalColumnsFor`; degraded metadata uses the built-in `done`
fallback.
*/
const GENERIC_TITLE_PATTERNS = [/^follow\s*-?up$/i, /^todo$/i, /^fix\s+issue$/i, /^improve\s+task$/i, /^investigate$/i];

export interface NormalizeEvalFollowUpsInput {
  parentTaskId: string;
  runId: string;
  overallBand: EvalScoreBand;
  drafts: FollowUpDraft[];
  store: TaskStore;
  policyMode: EvalFollowUpPolicyMode;
}

export interface MaterializeEvalFollowUpsInput {
  parentTaskId: string;
  runId: string;
  policyMode: EvalFollowUpPolicyMode;
  overallScore: number;
  followUps: EvalFollowUpSuggestion[];
  store: TaskStore;
}

function inferPriority(overallBand: EvalScoreBand): EvalFollowUpSuggestion["priority"] {
  if (overallBand === "failing") return "urgent";
  if (overallBand === "weak") return "high";
  if (overallBand === "acceptable") return "normal";
  return "low";
}

function isGenericDraft(draft: FollowUpDraft): boolean {
  const title = draft.title?.trim() ?? "";
  const description = draft.description?.trim() ?? "";
  if (!title || !description) return true;
  if (description.length < 20) return true;
  return GENERIC_TITLE_PATTERNS.some((pattern) => pattern.test(title));
}

function isSignalInsufficient(draft: FollowUpDraft): boolean {
  return !draft.reason?.trim() || !Array.isArray(draft.evidenceRefs) || draft.evidenceRefs.length === 0;
}

function toBaseSuggestion(params: {
  parentTaskId: string;
  runId: string;
  draft: FollowUpDraft;
  overallBand: EvalScoreBand;
  policyMode: EvalFollowUpPolicyMode;
}): EvalFollowUpSuggestion {
  const { parentTaskId, runId, draft, overallBand, policyMode } = params;
  const dedupeSeed = `${parentTaskId}:${draft.title}:${draft.description}`;
  const dedupeKey = normalizeEvalFollowUpText(dedupeSeed);
  return {
    suggestionId: buildEvalFollowUpSuggestionId(`${runId}:${dedupeSeed}`),
    dedupeKey,
    title: draft.title.trim(),
    description: draft.description.trim(),
    priority: inferPriority(overallBand),
    severity: overallBand,
    rationale: draft.reason?.trim() || "No rationale provided.",
    evidenceRefs: (draft.evidenceRefs ?? []).map((evidenceId) => ({ evidenceId, source: "other" })),
    recommendation: {
      shouldCreate: false,
      reason: "Pending follow-up policy evaluation",
      policyQualified: false,
    },
    state: "suggested",
    policyMode,
    metadata: {
      parentTaskId,
      runId,
    },
  };
}

export function resolveEvalFollowUpPolicyMode(policy?: "off" | "suggest" | "create"): EvalFollowUpPolicyMode {
  if (policy === "create") return "auto_create_qualified";
  if (policy === "suggest") return "persist_only";
  return "persist_only";
}

export async function normalizeEvalFollowUps(input: NormalizeEvalFollowUpsInput): Promise<EvalFollowUpSuggestion[]> {
  const { parentTaskId, runId, drafts, overallBand, store, policyMode } = input;
  /*
  FNXC:WorkflowLifecycleColumns 2026-07-31-06:40 (engine feed):
  "Open" is the negation of the task's OWN terminal lanes, not a hard-coded list of four ids.

  Census-invisible: `OPEN_COLUMNS` is a `Set` literal — a definition, not a comparison — so nothing
  in the lifecycle backlog pointed here. Found by grepping for lane-shaped list literals.

  Consequence on a renamed board: the set matched NOTHING, so `openTasks` was empty and the
  dedupe below had no live work to compare against. Every eval run then re-filed follow-ups it had
  already filed — the failure is DUPLICATE TASK CREATION, which looks like the evaluator being
  thorough rather than like a bug.

  Uses `resolveTerminalColumnsFor` — ALREADY IMPORTED IN THIS FILE for the candidate loop below, and
  the same helper the executor uses. It unions the task's resolved terminals with the legacy pair for
  the degraded-IR reason documented at its definition, so there is no fallback to hand-write here.

  My first draft manufactured synthetic trait flags from lane equality to call `isTerminalColumnRole`
  instead. That is the anti-pattern I flagged in `task-update.ts` two commits ago — a longer way to
  write the same comparison while LOOKING like it consulted the trait registry — and it ignored a
  correct helper sitting three lines above the import. Replaced before commit.
  */
  const allLiveTasks = await store.listTasks({ slim: true, includeArchived: false });
  /*
  FNXC:WorkflowLifecycleColumns 2026-07-31-09:30 (#2787 review — greptile P2):
  ONE IR read per WORKFLOW, not per card. This loop runs over every live task on the board, so
  without the shared cache a large board paid a store read per card before a single follow-up draft
  was processed — measurable added latency on every scheduled evaluation. The cache is the
  caller-owned shape the rest of this program already uses.
  */
  const openIrCache = new Map<string, Awaited<ReturnType<typeof resolveWorkflowIrForTask>>>();
  const openTasks: typeof allLiveTasks = [];
  for (const task of allLiveTasks) {
    const terminal = await resolveTerminalColumnsFor(store, task.id, openIrCache);
    if (!terminal.includes(task.column)) openTasks.push(task);
  }
  // FNXC:Evals 2026-06-27-12:40:
  // getEvalStore() returns EvalStore | AsyncEvalStore (PG backend mode); await
  // resolves the sync array and the async promise alike.
  const priorResults = await store.getEvalStore().listTaskResults({ taskId: parentTaskId });
  const priorKeys = new Set(
    priorResults
      .flatMap((result) => result.followUps)
      .map((suggestion) => suggestion.dedupeKey)
      .filter((key): key is string => Boolean(key)),
  );

  return drafts.map((draft) => {
    const suggestion = toBaseSuggestion({ parentTaskId, runId, draft, overallBand, policyMode });

    if (isGenericDraft(draft)) {
      return {
        ...suggestion,
        state: "suppressed",
        suppressedReason: "empty_or_generic",
        recommendation: {
          shouldCreate: false,
          reason: "Suppressed due to empty/generic title or weak description",
          policyQualified: false,
        },
      };
    }

    if (isSignalInsufficient(draft)) {
      return {
        ...suggestion,
        state: "suppressed",
        suppressedReason: "insufficient_signal",
        recommendation: {
          shouldCreate: false,
          reason: "Suppressed due to missing rationale/evidence",
          policyQualified: false,
        },
      };
    }

    const matchingOpenTask = openTasks.find((task) => {
      const title = normalizeEvalFollowUpText(task.title ?? task.description);
      return title.includes(suggestion.dedupeKey) || suggestion.dedupeKey.includes(title);
    });
    if (matchingOpenTask) {
      return {
        ...suggestion,
        state: "suppressed",
        suppressedReason: "duplicate_open_task",
        matchedTaskId: matchingOpenTask.id,
        recommendation: {
          shouldCreate: false,
          reason: `Suppressed as duplicate of open task ${matchingOpenTask.id}`,
          policyQualified: false,
        },
      };
    }

    if (priorKeys.has(suggestion.dedupeKey)) {
      return {
        ...suggestion,
        state: "suppressed",
        suppressedReason: "duplicate_prior_suggestion",
        matchedSuggestionId: suggestion.dedupeKey,
        recommendation: {
          shouldCreate: false,
          reason: "Suppressed as duplicate from prior eval result",
          policyQualified: false,
        },
      };
    }

    const shouldCreate = policyMode === "create_all_non_duplicates"
      || (policyMode === "auto_create_qualified" && (suggestion.priority === "high" || suggestion.priority === "urgent"));

    return {
      ...suggestion,
      recommendation: {
        shouldCreate,
        policyQualified: shouldCreate,
        reason: shouldCreate
          ? "Qualified for creation by follow-up policy"
          : "Persisted for manual review",
      },
    };
  });
}

/**
 * FNXC:Evals 2026-07-26-00:00:
 * Inlined replacement for the deleted shared follow-up dedup engine. Returns the id of an
 * already-open eval follow-up filed for the same `suggestionId` under the same parent, or
 * undefined when this suggestion has no live card yet. Fails open (undefined) if the store
 * listing throws, matching the old engine's fail-open-and-create behavior.
 */
async function findOpenEvalFollowUpTaskId(
  store: TaskStore,
  parentTaskId: string,
  suggestionId: string,
): Promise<string | undefined> {
  const tasks = await store.listTasks({ slim: true }).catch(() => []);
  /*
  Cheap identity filters FIRST, so only genuine candidates for this parent+suggestion pay a workflow
  resolution — usually zero or one card rather than the whole board.
  */
  const candidates = tasks.filter(
    (task) =>
      task.id !== parentTaskId &&
      task.sourceParentTaskId === parentTaskId &&
      task.sourceMetadata?.suggestionId === suggestionId,
  );
  for (const task of candidates) {
    const terminal = await resolveTerminalColumnsFor(store, task.id);
    if (!terminal.includes(task.column)) return task.id;
  }
  return undefined;
}

export async function materializeEvalFollowUps(input: MaterializeEvalFollowUpsInput): Promise<EvalFollowUpSuggestion[]> {
  const { parentTaskId, runId, policyMode, overallScore, followUps, store } = input;
  const created: EvalFollowUpSuggestion[] = [];

  for (const followUp of followUps) {
    if (!followUp.recommendation.shouldCreate || followUp.state !== "suggested") {
      created.push(followUp);
      continue;
    }

    const existingTaskId = await findOpenEvalFollowUpTaskId(store, parentTaskId, followUp.suggestionId);
    const createdTaskId = existingTaskId ?? (await store.createTask({
      title: followUp.title,
      description: [
        `Follow-up generated from evaluation run ${runId} for ${parentTaskId}.`,
        "",
        `Problem summary: ${followUp.description}`,
        "Expected outcome: Investigate and resolve the issue identified by evaluation findings.",
        `Eval severity/score: ${followUp.severity} (${overallScore})`,
        `Rationale: ${followUp.rationale}`,
        `Evidence refs: ${followUp.evidenceRefs.map((ref) => ref.evidenceId).join(", ") || "none"}`,
      ].join("\n"),
      /* FNXC:WorkflowLifecycleColumns 2026-07-29-20:15 (U11): no explicit column —
         `createTaskImpl` resolves the WORKFLOW'S intake column, and `input.column` would
         override it. Hard-coding `"triage"` created the card in a column the default
         lineage no longer declares (#2515), i.e. straight into the stranded state. */
      priority: followUp.priority,
      source: {
        sourceType: "automation",
        sourceParentTaskId: parentTaskId,
        sourceMetadata: {
          type: "eval_follow_up",
          runId,
          suggestionId: followUp.suggestionId,
          policyMode,
          dedupeKey: followUp.dedupeKey,
        },
      },
    })).id;

    created.push({
      ...followUp,
      state: "created",
      createdTaskId,
      recommendation: {
        ...followUp.recommendation,
        reason: existingTaskId
          ? `Reused existing follow-up ${createdTaskId} by follow-up policy`
          : `Created as ${createdTaskId} by follow-up policy`,
      },
    });
  }

  return created;
}
