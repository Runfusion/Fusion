import type { TaskStore } from "@fusion/core";

import type { RunAuditor } from "./run-audit.js";

/** Goal context was injected into heartbeat/executor prompts for the Slice 2 cite-rate experiment. */
export const GOAL_INJECTION_APPLIED = "goal:injection-applied";
/** Goal injector ran but produced no prompt context for the Slice 2 cite-rate experiment. */
export const GOAL_INJECTION_SKIPPED = "goal:injection-skipped";
/** Goal retrieval tools were invoked at runtime for the Slice 2 cite-rate experiment. */
export const GOAL_RETRIEVAL_INVOKED = "goal:retrieval-invoked";

const GOAL_AUDIT_TYPES = [GOAL_INJECTION_APPLIED, GOAL_INJECTION_SKIPPED, GOAL_RETRIEVAL_INVOKED] as const;
if (new Set(GOAL_AUDIT_TYPES).size !== GOAL_AUDIT_TYPES.length || GOAL_AUDIT_TYPES.some((value) => typeof value !== "string" || !value.startsWith("goal:"))) {
  throw new Error("Goal anchoring audit mutation types must be unique goal:* strings.");
}

/** Engine lane that attempted goal anchoring; powers dashboard filtering for cite-rate observability. */
export type GoalAnchoringLane = "heartbeat" | "executor" | "planning";

/**
 * Structured goal-injection audit payload.
 * Counts/IDs only: never include prompt bodies, goal titles, or goal descriptions.
 */
export type GoalInjectionAuditInput = {
  lane: GoalAnchoringLane;
  taskId?: string;
  goalsInjected: number;
  goalIds?: string[];
  truncated?: boolean;
  reason?: "no-active-goals" | "injector-empty";
};

/**
 * Structured goal-retrieval audit payload.
 * Counts/IDs only: never include goal titles/descriptions or any prompt text.
 */
export type GoalRetrievalAuditInput = {
  toolName: "fn_goal_list" | "fn_goal_show";
  resultCount: number;
  goalId?: string;
  goalIds?: string[];
  notFound?: boolean;
};

/**
 * Emit a database-domain run-audit event for goal injection observability.
 * These events are consumed from the existing run-audit dashboard timeline with start/end time filters.
 */
export async function emitGoalAnchoringAudit(auditor: RunAuditor, input: GoalInjectionAuditInput): Promise<void> {
  const isApplied = input.goalsInjected > 0;
  await auditor.database({
    type: isApplied ? GOAL_INJECTION_APPLIED : GOAL_INJECTION_SKIPPED,
    target: input.taskId ?? "goals",
    metadata: {
      lane: input.lane,
      count: input.goalsInjected,
      goalIds: input.goalIds ?? [],
      ...(typeof input.truncated === "boolean" ? { truncated: input.truncated } : {}),
      ...(input.reason ? { reason: input.reason } : {}),
    },
  });
}

/**
 * Emit a database-domain run-audit event when goal retrieval tools are invoked.
 * Uses only identifiers/counts so cite-rate monitoring can query the timeline without sensitive payloads.
 */
export function emitGoalRetrievalAudit(
  store: TaskStore,
  ctx: { runId?: string; agentId?: string; taskId?: string },
  input: GoalRetrievalAuditInput,
): void {
  if (!ctx.runId || !ctx.agentId) return;

  try {
    void store.recordRunAuditEvent({
      runId: ctx.runId,
      agentId: ctx.agentId,
      taskId: ctx.taskId,
      domain: "database",
      mutationType: GOAL_RETRIEVAL_INVOKED,
      target: input.goalId ?? "goals",
      metadata: {
        toolName: input.toolName,
        count: input.resultCount,
        goalIds: input.goalIds ?? [],
        notFound: input.notFound ?? false,
      },
    });
  } catch (error) {
    console.warn("[fusion-extension] goal retrieval audit emission skipped", error);
  }
}
