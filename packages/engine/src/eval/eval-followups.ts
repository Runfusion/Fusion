import {
  buildEvalFollowUpSuggestionId,
  normalizeEvalFollowUpText,
  type EvalFollowUpPolicyMode,
  type EvalFollowUpSuggestion,
  type EvalScoreBand,
  type FollowUpDraft,
  type TaskStore,
} from "@fusion/core";
import { createAutomatedFollowup } from "../execution/verification-followup-dedup.js";

const OPEN_COLUMNS = new Set(["triage", "todo", "in-progress", "in-review"]);
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
  const openTasks = (await store.listTasks({ slim: true, includeArchived: false })).filter((task) =>
    OPEN_COLUMNS.has(task.column)
  );
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

export async function materializeEvalFollowUps(input: MaterializeEvalFollowUpsInput): Promise<EvalFollowUpSuggestion[]> {
  const { parentTaskId, runId, policyMode, overallScore, followUps, store } = input;
  const created: EvalFollowUpSuggestion[] = [];

  for (const followUp of followUps) {
    if (!followUp.recommendation.shouldCreate || followUp.state !== "suggested") {
      created.push(followUp);
      continue;
    }

    const result = await createAutomatedFollowup(store, {
      kind: "eval",
      parentTaskId,
      extraMatchKeys: { suggestionId: followUp.suggestionId },
      createInput: {
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
        column: "triage",
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
      },
    });

    const createdTaskId = result.outcome === "created" ? result.task.id : result.existingTaskId;
    created.push({
      ...followUp,
      state: "created",
      createdTaskId,
      recommendation: {
        ...followUp.recommendation,
        reason: result.outcome === "created"
          ? `Created as ${createdTaskId} by follow-up policy`
          : `Reused existing follow-up ${createdTaskId} by follow-up policy`,
      },
    });
  }

  return created;
}
