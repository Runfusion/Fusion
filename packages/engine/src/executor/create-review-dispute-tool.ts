import type { RunMutationContext } from "@fusion/core";
import { Type, type Static } from "@earendil-works/pi-ai";
import { isOpenWorkflowReviewFinding, type TaskStore, type WorkflowStepResult } from "@fusion/core";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { generateSyntheticRunId } from "../util/run-audit.js";
import { emitBoundedRunAudit } from "./emit-bounded-run-audit.js";
/*
FNXC:ReviewConvergence 2026-08-22-05:20:
FN-149 gives implementers a durable way to contest a review finding without resolving it. A dispute
is an open annotation: only a later review verdict may uphold or rebut it, so this tool cannot
reduce a finding's blocking power or release a merge gate.
*/

const MAX_DISPUTE_RATIONALE_LENGTH = 4_000;
const reviewDisputeParams = Type.Object({
  findingId: Type.String({ description: "The open workflow-review finding ID to dispute." }),
  rationale: Type.String({ description: "Why the finding should not require a change." }),
});

export type ReviewDisputeToolDeps = {
  store: TaskStore;
  getRunContextFor: (taskId: string) => RunMutationContext | undefined;
  runContextFor?: (taskId: string, fallbackAgentId?: string | null) => RunMutationContext;
};

type DisputeResult = { outcome: "disputed"; workflowStepId: string } | { outcome: "not-found" | "already-resolved" | "already-disputed" | "ambiguous" };

type FindingLocation = { workflowStepId: string; priorAttemptIndex?: number; findingIndex: number };

type RankedFindingLocation = FindingLocation & { recency: number; entryIndex: number };

/*
FNXC:ReviewConvergence 2026-08-22-06:36:
FN-149 finding IDs are not globally unique: concurrent review gates may use the same ID. Refuse a
cross-gate collision rather than relying on array order, because a dispute must never annotate a
gate other than the one the implementer meant to contest. Within an unambiguous gate, select the
current result before archived attempts, then the newest archived attempt, so a reused ID cannot
cause a resumed implementer session to dispute stale evidence.
*/
function findDisputeLocation(results: WorkflowStepResult[], findingId: string): FindingLocation | DisputeResult {
  const matches: RankedFindingLocation[] = [];
  for (const [entryIndex, entry] of results.entries()) {
    entry.findings?.forEach((finding, findingIndex) => {
      if (finding.id === findingId) {
        matches.push({ workflowStepId: entry.workflowStepId, findingIndex, recency: -1, entryIndex });
      }
    });
    entry.priorAttempts?.forEach((attempt, priorAttemptIndex) => {
      attempt.findings?.forEach((finding, findingIndex) => {
        if (finding.id === findingId) {
          matches.push({ workflowStepId: entry.workflowStepId, priorAttemptIndex, findingIndex, recency: priorAttemptIndex, entryIndex });
        }
      });
    });
  }
  if (matches.length === 0) return { outcome: "not-found" };
  if (new Set(matches.map((match) => match.workflowStepId)).size > 1) return { outcome: "ambiguous" };
  return matches.sort((left, right) => left.recency - right.recency || left.entryIndex - right.entryIndex)[0]!;
}

function addDispute(results: WorkflowStepResult[] | undefined, findingId: string, rationale: string, now: string): { results: WorkflowStepResult[] | undefined; result: DisputeResult } {
  if (!results) return { results, result: { outcome: "not-found" } };
  const location = findDisputeLocation(results, findingId);
  if ("outcome" in location) return { results, result: location };
  const entryIndex = results.findIndex((entry) => entry.workflowStepId === location.workflowStepId);
  const entry = results[entryIndex]!;
  const container = location.priorAttemptIndex === undefined ? entry : entry.priorAttempts?.[location.priorAttemptIndex];
  const finding = container?.findings?.[location.findingIndex];
  if (!finding || !isOpenWorkflowReviewFinding(finding)) return { results, result: { outcome: "already-resolved" } };
  if (finding.disputedAt) return { results, result: { outcome: "already-disputed" } };
  const findings = container.findings!.map((item, index) => index === location.findingIndex
    ? { ...item, disputeRationale: rationale, disputedAt: now }
    : item);
  const updatedEntry = location.priorAttemptIndex === undefined
    ? { ...entry, findings }
    : {
      ...entry,
      priorAttempts: entry.priorAttempts!.map((attempt, index) => index === location.priorAttemptIndex
        ? { ...attempt, findings }
        : attempt),
    };
  const next = results.map((item, index) => index === entryIndex ? updatedEntry : item);
  return { results: next, result: { outcome: "disputed", workflowStepId: entry.workflowStepId } };
}

export function createReviewDisputeTool(deps: ReviewDisputeToolDeps, taskId: string): ToolDefinition {
  return {
    name: "fn_review_dispute",
    label: "Dispute Review Finding",
    description: "Record a rationale contesting one open review finding. The finding remains open and blocking until a reviewer rules.",
    parameters: reviewDisputeParams,
    execute: async (_id: string, params: Static<typeof reviewDisputeParams>) => {
      const rationale = params.rationale.trim();
      if (!rationale || rationale.length > MAX_DISPUTE_RATIONALE_LENGTH) {
        return { content: [{ type: "text" as const, text: `rationale must contain 1–${MAX_DISPUTE_RATIONALE_LENGTH} characters.` }], details: { outcome: "invalid-rationale" } };
      }
      const now = new Date().toISOString();
      let outcome: DisputeResult | undefined;
      await deps.store.updateTaskAtomic(taskId, (current) => {
        const updated = addDispute(current.workflowStepResults, params.findingId, rationale, now);
        outcome = updated.result;
        return updated.result.outcome === "disputed" ? { workflowStepResults: updated.results } : null;
      }, deps.getRunContextFor(taskId));
      const finalOutcome = outcome ?? { outcome: "not-found" as const };
      if (finalOutcome.outcome !== "disputed") {
        const message = finalOutcome.outcome === "not-found"
          ? `Review finding ${params.findingId} was not found.`
          : finalOutcome.outcome === "already-resolved"
            ? `Review finding ${params.findingId} is already resolved.`
            : finalOutcome.outcome === "already-disputed"
              ? `Review finding ${params.findingId} is already disputed.`
              : `Review finding ${params.findingId} is ambiguous across review gates and was not changed.`;
        return { content: [{ type: "text" as const, text: message }], details: { outcome: finalOutcome.outcome } };
      }
      await deps.store.logEntry(taskId, `Implementer disputed review finding ${params.findingId}; it remains open pending reviewer adjudication.`, undefined, deps.getRunContextFor(taskId));
      await emitBoundedRunAudit(deps.store, {
        taskId,
        agentId: "executor",
        runId: generateSyntheticRunId("review-finding-disputed", taskId),
        domain: "database",
        mutationType: "task:review-finding-disputed",
        target: taskId,
        metadata: { taskId, workflowStepId: finalOutcome.workflowStepId, findingId: params.findingId, outcome: "disputed" },
      });
      return { content: [{ type: "text" as const, text: `Recorded dispute for ${params.findingId}. It remains open and blocking until the reviewer rules.` }], details: { outcome: "disputed", workflowStepId: finalOutcome.workflowStepId } };
    },
  };
}
