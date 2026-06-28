import type { Goal } from "@fusion/core";
import { MissionStore, GoalStore } from "@fusion/core";
import { buildGoalContextSection, type GoalInjectionResult } from "./goal-context-injector.js";
import type { TaskStore } from "@fusion/core";
import type { GoalAnchoringLane } from "./goal-anchoring-audit.js";
import { emitGoalAnchoringAudit } from "./goal-anchoring-audit.js";
import type { EngineRunContext } from "./run-audit.js";
import type { RunAuditor } from "./run-audit.js";
import { createLogger } from "./logger.js";

const diagnosticsLog = createLogger("goal-injection-diagnostics");

export type GoalInjectionOutcome = "applied" | "no-goals" | "disabled-or-failed";

export type GoalInjectionDisabledReason =
  | "config-disabled"
  | "store-unavailable"
  | "list-failed"
  | "injector-threw";

export interface GoalInjectionDiagnostic {
  lane: GoalAnchoringLane;
  outcome: GoalInjectionOutcome;
  goalCount: number;
  goalIds: string[];
  provenanceGoalIds: string[];
  truncated: boolean;
  reason?: GoalInjectionDisabledReason;
  errorClass?: string;
  runId?: string;
  agentId?: string;
  taskId?: string;
  timestamp: string;
}

export interface GoalInjectionDiagnosticInput extends Omit<GoalInjectionDiagnostic, "timestamp" | "provenanceGoalIds"> {
  provenanceGoalIds?: string[];
  store?: TaskStore;
  runContext?: EngineRunContext | null;
}

export interface GoalInjectionClassification {
  outcome: GoalInjectionOutcome;
  goalCount: number;
  goalIds: string[];
  truncated: boolean;
  reason?: GoalInjectionDisabledReason;
  errorClass?: string;
}

export function classifyGoalInjectionResult(result: GoalInjectionResult): GoalInjectionClassification {
  if (result.emittedGoalIds.length === 0) {
    return {
      outcome: "no-goals",
      goalCount: 0,
      goalIds: [],
      truncated: false,
    };
  }

  return {
    outcome: "applied",
    goalCount: result.emittedGoalIds.length,
    goalIds: result.emittedGoalIds,
    truncated: result.truncated !== null,
  };
}

export function classifyGoalInjectionFailure(
  reason: GoalInjectionDisabledReason,
  error?: unknown,
): GoalInjectionClassification {
  const resolvedErrorClass =
    error && typeof error === "object" && "constructor" in error && typeof (error as { constructor?: { name?: unknown } }).constructor?.name === "string"
      ? (error as { constructor: { name: string } }).constructor.name
      : undefined;

  return {
    outcome: "disabled-or-failed",
    goalCount: 0,
    goalIds: [],
    truncated: false,
    reason,
    ...(resolvedErrorClass ? { errorClass: resolvedErrorClass } : {}),
  };
}

export interface GoalContextResolution {
  goalContext: string;
  classification: GoalInjectionClassification;
}

export interface ResolveAndEmitGoalContextInput {
  lane: GoalAnchoringLane;
  store: TaskStore;
  audit: RunAuditor;
  taskId?: string;
  runContext?: EngineRunContext | null;
}

export interface ResolveGoalContextInput {
  listActiveGoals?: () => Goal[];
  injector?: (activeGoals: Goal[]) => GoalInjectionResult;
  disabledReason?: GoalInjectionDisabledReason;
}

export function resolveGoalContextForDiagnostics(input: ResolveGoalContextInput): GoalContextResolution {
  if (!input.listActiveGoals) {
    return {
      goalContext: "",
      classification: classifyGoalInjectionFailure(input.disabledReason ?? "store-unavailable"),
    };
  }

  try {
    const activeGoals = input.listActiveGoals();
    const injector = input.injector ?? ((goals: Goal[]) => buildGoalContextSection({ activeGoals: goals }));
    try {
      const injectionResult = injector(activeGoals);
      return {
        goalContext: injectionResult.text,
        classification: classifyGoalInjectionResult(injectionResult),
      };
    } catch (injectorError) {
      return {
        goalContext: "",
        classification: classifyGoalInjectionFailure("injector-threw", injectorError),
      };
    }
  } catch (listError) {
    return {
      goalContext: "",
      classification: classifyGoalInjectionFailure("list-failed", listError),
    };
  }
}

export async function resolveAndEmitGoalContext(input: ResolveAndEmitGoalContextInput): Promise<GoalContextResolution> {
  // FNXC:GoalStore 2026-06-27-18:25:
  // resolveGoalContextForDiagnostics consumes a SYNC listActiveGoals (() => Goal[])
  // on the synchronous agent-execution path. The PG-backed AsyncGoalStore returns
  // Promises, so only the sync SQLite GoalStore can supply this. Guard with
  // instanceof GoalStore (mirrors the AsyncMissionStore guard below) and leave it
  // undefined in PG backend mode — goal context degrades to store-unavailable
  // rather than injecting an unresolved Promise. Converting the injection pipeline
  // to async is out of scope for the GoalStore port.
  const resolvedGoalStore =
    typeof input.store.getGoalStore === "function" ? input.store.getGoalStore() : undefined;
  const syncGoalStore = resolvedGoalStore instanceof GoalStore ? resolvedGoalStore : undefined;
  const resolution = resolveGoalContextForDiagnostics({
    listActiveGoals: syncGoalStore
      ? () => syncGoalStore.listGoals({ status: "active" })
      : undefined,
  });

  let provenanceGoalIds: string[] = [];
  if (input.taskId && typeof input.store.getMissionStore === "function") {
    try {
      // FNXC:MissionStore 2026-06-27-15:40:
      // listGoalIdsForTask is a sync-only MissionStore method (not ported to the
      // AsyncMissionStore). In PG backend mode getMissionStore() returns the async
      // store; guard with instanceof and leave provenance empty (graceful fallback).
      const resolvedMissionStore = input.store.getMissionStore();
      if (resolvedMissionStore instanceof MissionStore) {
        provenanceGoalIds = resolvedMissionStore.listGoalIdsForTask(input.taskId);
      }
    } catch (error) {
      diagnosticsLog.warn(
        `failed to resolve goal provenance for task ${input.taskId} in ${input.lane}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  await emitGoalAnchoringAudit(input.audit, {
    lane: input.lane,
    taskId: input.taskId,
    goalsInjected: resolution.classification.goalCount,
    goalIds: resolution.classification.goalIds,
    truncated: resolution.classification.truncated,
    reason: resolution.classification.outcome === "no-goals" ? "no-active-goals" : undefined,
  });

  await emitGoalInjectionDiagnostic({
    lane: input.lane,
    ...resolution.classification,
    provenanceGoalIds,
    runId: input.runContext?.runId,
    agentId: input.runContext?.agentId,
    taskId: input.taskId,
    store: input.store,
    runContext: input.runContext,
  });

  return resolution;
}

function formatAgentLogLine(input: GoalInjectionDiagnostic): string {
  const ids = JSON.stringify(input.goalIds);
  const provenanceIds = JSON.stringify(input.provenanceGoalIds);
  const reason = input.reason ? ` reason=${input.reason}` : "";
  const errorClass = input.errorClass ? ` err=${input.errorClass}` : "";
  return `[goal-injection] ${input.outcome} count=${input.goalCount} ids=${ids} provenance=${provenanceIds} truncated=${String(input.truncated)}${reason}${errorClass}`;
}

/**
 * Emit per-run goal-context injection diagnostics for executor/heartbeat lanes.
 *
 * Outcomes:
 * - `applied`: at least one active goal ID was injected.
 * - `no-goals`: injector executed successfully but active goal set was empty.
 * - `disabled-or-failed`: injection was disabled or list/injector execution failed.
 *
 * Guardrail: this emitter stores goal IDs/counts only and must never persist
 * prompt body text, goal titles, or goal descriptions to avoid prompt/PII leakage.
 *
 * This helper is called from FN-5653 wiring sites (executor/heartbeat), not from
 * inside the pure goal-context injector module.
 */
export async function emitGoalInjectionDiagnostic(
  input: GoalInjectionDiagnosticInput,
): Promise<GoalInjectionDiagnostic> {
  const record: GoalInjectionDiagnostic = {
    lane: input.lane,
    outcome: input.outcome,
    goalCount: input.goalCount,
    goalIds: [...input.goalIds],
    provenanceGoalIds: [...(input.provenanceGoalIds ?? [])],
    truncated: input.truncated,
    ...(input.reason ? { reason: input.reason } : {}),
    ...(input.errorClass ? { errorClass: input.errorClass } : {}),
    ...(input.runId ? { runId: input.runId } : {}),
    ...(input.agentId ? { agentId: input.agentId } : {}),
    ...(input.taskId ? { taskId: input.taskId } : {}),
    timestamp: new Date().toISOString(),
  };

  if (input.store && record.taskId) {
    try {
      await input.store.logEntry(record.taskId, formatAgentLogLine(record), undefined, input.runContext ?? undefined);
    } catch (error) {
      diagnosticsLog.warn(
        `failed to append goal-injection task log for ${record.taskId}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  const auditStore = input.store;
  const hasAuditWriter = Boolean(auditStore && typeof auditStore.recordRunAuditEvent === "function");
  if (!input.runContext || !hasAuditWriter || !auditStore) {
    diagnosticsLog.warn(
      `goal-injection diagnostic emitted without run-audit side effect (lane=${record.lane}, hasContext=${Boolean(input.runContext)}, hasWriter=${Boolean(hasAuditWriter)})`,
    );
    return record;
  }

  try {
    await auditStore.recordRunAuditEvent({
      taskId: input.runContext.taskId,
      agentId: input.runContext.agentId,
      runId: input.runContext.runId,
      domain: "database",
      mutationType: "prompt:goal-injection",
      target: record.lane,
      metadata: {
        lane: record.lane,
        outcome: record.outcome,
        goalCount: record.goalCount,
        goalIds: record.goalIds,
        provenanceGoalIds: record.provenanceGoalIds,
        truncated: record.truncated,
        ...(record.reason ? { reason: record.reason } : {}),
        ...(record.errorClass ? { errorClass: record.errorClass } : {}),
        ...(record.runId ? { runId: record.runId } : {}),
        ...(record.agentId ? { agentId: record.agentId } : {}),
        ...(record.taskId ? { taskId: record.taskId } : {}),
      },
    });
  } catch (error) {
    diagnosticsLog.warn(
      `failed to append goal-injection run-audit event for lane=${record.lane}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  return record;
}
