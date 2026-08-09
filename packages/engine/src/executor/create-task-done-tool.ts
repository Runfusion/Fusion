/**
 * FNXC:CodeOrganization 2026-08-03-13:10:
 * createTaskDoneTool peeled from TaskExecutor (U4).
 *
 * FNXC:Lifecycle 2026-07-16-10:20:
 * FN-8141: outcome=blocked is the sanctioned honest exit (no completion claim).
 *
 * FNXC:HonestBlockedExit 2026-08-02-23:59:
 * Blocked exits classify on Fusion task dependencies only (no open-PR blockers).
 *
 * FNXC:WorkflowResolvedColumns 2026-07-31-09:20:
 * Completed-task watchdog arms on resolved WIP column, not literal in-progress.
 */
import { Type } from "@earendil-works/pi-ai";
import type { Settings, Task, TaskDetail, TaskRecommendation, TaskStore } from "@fusion/core";
import {
  parseNoOpCompletionMarker,
  resolveWipTargetForTask,
} from "@fusion/core";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { ReviewVerdict } from "../execution/reviewer.js";
import {
  BLOCKED_THRASH_LIMIT,
  buildExternalBlockMetadataPatch,
  classifyBlockedExit,
  countBlockedThrashHits,
  partitionBlockedByRefs,
} from "../execution-block-classifier.js";
import { moveTaskToReplanColumn, resolveReplanTargetColumn } from "../execution/replan-target.js";
import { mergeEffectiveSettings } from "../project/effective-settings.js";
import { generateSyntheticRunId, type EngineRunContext, type RunAuditor } from "../util/run-audit.js";
import { executorLog } from "../logger.js";
import { resolveReboundColumnFor } from "./lifecycle-columns.js";
import { evaluateTaskDoneRefusal } from "./task-done-refusal.js";
import { skipBypassTaintUpdateForRefusal } from "./completion-predicates.js";
import { MAX_TASK_DONE_REQUEUE_RETRIES } from "./task-done-refusal-handler.js";
import { validateCompletionRecommendations } from "./validate-completion-recommendations.js";
import type { FinalizeAcceptedNoOpCompletionParams } from "./plan-review-no-op.js";

export type CreateTaskDoneToolDeps = {
  store: TaskStore;
  getRunContextFor: (taskId: string) => EngineRunContext | undefined;
  workflowLifecycleMovesInFlight: Set<string>;
  persistTokenUsage: (taskId: string) => Promise<void>;
  getTaskCompletionBlocker: (task: Task) => Promise<string | undefined>;
  evaluateTaskVerdictProviders: (
    task: TaskDetail,
    opts: Record<string, unknown>,
  ) => Promise<{ ok: true } | { ok: false; message: string }>;
  verifyWorktreeInvariants: (
    task: Task,
    worktreePathOverride?: string,
    allowReanchor?: boolean,
    options?: { noOpCompletion?: boolean; noOpCompletionReason?: string },
  ) => Promise<
    | { ok: true }
    | { ok: false; reason: string; observed: string; expected: string; repo?: string }
  >;
  evaluateTaskDoneScopeLeak: (
    task: Task,
    worktreePath: string,
    promptContent: string,
    settings: Settings,
    audit?: RunAuditor,
  ) => Promise<{ blocked: false } | { blocked: true; message: string }>;
  scheduleCompletedTaskWatchdog: (taskId: string, source: string) => void;
  /**
   * FNXC:PlanReviewNoOp 2026-08-09-22:10:
   * Shared terminalization for PREMISE STALE / DUPLICATE no-op completion (FN-8841).
   */
  finalizeAcceptedNoOpCompletion: (
    params: FinalizeAcceptedNoOpCompletionParams,
  ) => Promise<{ completed: boolean; hardPauseActive: boolean }>;
};

/**
 * Create fn_task_done for the executor coding session.
 * `codeReviewVerdicts` retained for refusal evaluation compatibility.
 */
export function createTaskDoneTool(
  deps: CreateTaskDoneToolDeps,
  taskId: string,
  worktreePath: string,
  promptContent: string,
  codeReviewVerdicts: Map<number, ReviewVerdict>,
  onDone: () => void,
  audit?: RunAuditor,
): ToolDefinition {
    const store = deps.store;
    return {
      name: "fn_task_done",
      label: "Mark Task Done",
      description:
        "End the task. With outcome=\"completed\" (default): signal that all steps are complete, tests pass, and " +
        "documentation is updated — call as the final action after finishing all work; automatically marks all " +
        "remaining steps as done. At this accepted final checkpoint, when recommendation capture is enabled, submit up to " +
        "the project cap of genuine, task-ready out-of-scope recommendations with stable unique ids, or explicitly send " +
        "recommendations: [] when none qualify; at cap 0, omit recommendations (an empty list is accepted for compatibility). " +
        "Do not use recommendations for required fixes, blockers, secrets, commands, or reasoning. " +
        "With outcome=\"blocked\": honestly park the task when the work genuinely cannot proceed (upstream API break, " +
        "missing dependency task, unresolvable external blocker). Blocked is NOT a completion claim — it does not " +
        "trip the review/completion gates, does not auto-complete or auto-skip steps, and preserves your worktree/" +
        "branch/step progress so the task can be requeued once the blocker clears. Prefer blocked over marking steps " +
        "skipped when the task cannot be finished.",
      parameters: Type.Object({
        summary: Type.Optional(Type.String({
          description: "Optional summary of what was changed/fixed and what was verified (2-4 sentences). Used when outcome=\"completed\".",
        })),
        /*
        FNXC:TaskRecommendations 2026-08-08-05:02:
        Capture optional out-of-scope follow-ups only after every completion gate accepts.
        */
        recommendations: Type.Optional(Type.Array(Type.Object({
          id: Type.String(),
          title: Type.String(),
          description: Type.String(),
          category: Type.Union([Type.Literal("improvement"), Type.Literal("feature"), Type.Literal("bug"), Type.Literal("other")]),
        }), { description: "For accepted completed outcomes when capture is enabled: submit at most the project cap of task-ready out-of-scope suggestions with unique stable ids, or [] when none qualify. At cap 0, omit this field; an empty list is accepted for compatibility but populated input is rejected. Never send for blocked/refused outcomes or include mandatory fixes, secrets, executable commands, or reasoning." })),
        /*
        FNXC:Lifecycle 2026-07-16-10:20:
        FN-8141 laundered a genuinely-impossible task into `done`: fn_task_done only expressed success, the bulk-completion
        gate refused it, the requeue budget re-ran the doomed task 5 times, and the only remaining affordance (skip every
        step) made `isTaskComplete()` return true so self-healing + the AI merger finalized an empty diff as done. The
        `blocked` outcome is the sanctioned honest exit: it parks the task `failed` (error `BLOCKED: <reason>`) without any
        completion claim, so laundering is never the cheapest path.
        */
        outcome: Type.Optional(Type.Union(
          [Type.Literal("completed"), Type.Literal("blocked")],
          { description: "\"completed\" (default) finishes the task; \"blocked\" honestly parks it as failed because the work cannot proceed. Use \"blocked\" instead of skipping steps + completing when you are stuck." },
        )),
        blockedBy: Type.Optional(Type.Array(Type.String(), {
          description: "When outcome=\"blocked\": Fusion task IDs (e.g. [\"FN-8145\"]) that must complete before this task can proceed. Task IDs become real dependency edges. Open GitHub PRs are not valid blockers.",
        })),
        reason: Type.Optional(Type.String({
          description: "Required when outcome=\"blocked\": concrete explanation of what is blocking the work and what is needed to unblock it.",
        })),
      }),
      execute: async (_id: string, params: { summary?: string; recommendations?: TaskRecommendation[]; outcome?: "completed" | "blocked"; blockedBy?: string[]; reason?: string }) => {
        /*
        FNXC:Lifecycle 2026-07-16-10:20:
        FN-8141 — the blocked exit runs BEFORE every completion gate (completion blocker, verdict providers, worktree
        invariants, bulk-completion refusal). Blocked is not a completion claim, so none of those gates apply; parking
        `failed` with a `BLOCKED:` error + real dependency edges is the whole action. Steps keep their true statuses
        (no auto-done, no auto-skip) so a laundered "all steps skipped ⇒ complete" state can never form.
        */
        if (params.outcome === "blocked") {
          const reason = params.reason?.trim();
          if (!reason) {
            const message = "fn_task_done(outcome=\"blocked\") requires a non-empty `reason` describing what is blocking the work. Provide `reason` (and optional `blockedBy` task IDs) and call again.";
            return {
              content: [{ type: "text" as const, text: message }],
              details: { error: message },
            };
          }

          const blockedTask = await store.getTask(taskId);
          const rawBlockedBy = Array.from(
            new Set((params.blockedBy ?? []).map((id) => id.trim()).filter((id) => id.length > 0)),
          );
          /*
          FNXC:HonestBlockedExit 2026-08-02-23:59 (operator decision — FN-8728 vs PR #2398):
          Blocked exits classify on Fusion task dependencies ONLY. The FN-8700 file-claim/open-PR
          classification is removed: open PRs are never blockers, legacy pr:N refs are discarded,
          and reason prose never makes a block durable. Task deps → durable failed park (requeues
          when deps complete); no deps → plan defect → needs-replan (FN-8634).
          */
          const classification = classifyBlockedExit(reason, rawBlockedBy);
          const { taskIds: blockedByIds } = partitionBlockedByRefs(rawBlockedBy);
          const thrashCount = countBlockedThrashHits(
            blockedTask.log,
            classification.thrashSignature,
          ) + 1;
          const thrashExhausted = !classification.allowAutoReplan && thrashCount >= BLOCKED_THRASH_LIMIT;

          const parkError = thrashExhausted
            ? `BLOCKED: ${reason} [thrash-exhausted after ${thrashCount} identical durable blocks]`
            : `BLOCKED: ${reason}`;
          // Record blockedBy TASK ids as real dependency edges (union with existing).
          const mergedDependencies = blockedByIds.length > 0
            ? Array.from(new Set([...(blockedTask.dependencies ?? []), ...blockedByIds]))
            : undefined;
          /*
          FNXC:HonestBlockedExit 2026-08-01-01:40 (operator: FN-8634 "shouldn't show a failed badge"):
          When `blockedBy` is EMPTY, park needs-replan (auto-replan) — nothing external to wait for.
          Task-dependency blocks park failed so the scheduler leaves the card alone until deps complete.
          */
          const autoReplanPark = classification.allowAutoReplan && blockedByIds.length === 0 && !thrashExhausted;
          const metaPatch = !autoReplanPark
            ? buildExternalBlockMetadataPatch(classification, thrashCount)
            : undefined;
          if (autoReplanPark) {
            const replanColumn = await resolveReplanTargetColumn(deps.store, taskId);
            await store.logEntry(
              taskId,
              `${parkError} — no blocking dependencies recorded; parking for automatic replan in ${replanColumn} (steps preserved)`,
              undefined,
              deps.getRunContextFor(taskId),
            );
            deps.workflowLifecycleMovesInFlight.add(taskId);
            try {
              await moveTaskToReplanColumn(deps.store, { id: taskId, column: blockedTask.column }, replanColumn);
            } finally {
              deps.workflowLifecycleMovesInFlight.delete(taskId);
            }
            await store.updateTask(taskId, {
              status: "needs-replan",
              error: null,
              paused: false,
              pausedByAgentId: null,
            }, deps.getRunContextFor(taskId));
          } else {
            await store.updateTask(taskId, {
              status: "failed",
              error: parkError,
              paused: false,
              pausedByAgentId: null,
              ...(mergedDependencies ? { dependencies: mergedDependencies } : {}),
              ...(metaPatch ? { sourceMetadataPatch: metaPatch } : {}),
            }, deps.getRunContextFor(taskId));

            await store.logEntry(
              taskId,
              thrashExhausted
                ? `${parkError} — durable external block thrash-exhausted (signature=${classification.thrashSignature}); parked failed, no auto-requeue`
                : `${parkError} — recorded dependencies: ${blockedByIds.join(", ")} — parked failed (honest blocked exit; steps preserved)`,
              undefined,
              deps.getRunContextFor(taskId),
            );
          }
          await deps.store.recordRunAuditEvent?.({
            taskId,
            agentId: "executor",
            runId: generateSyntheticRunId("execution-blocked", taskId),
            domain: "database",
            mutationType: "task:execution-blocked-parked",
            target: taskId,
            metadata: {
              taskId,
              blockedBy: blockedByIds,
              hasReason: true,
              parkedAs: autoReplanPark ? "auto-replan" : "failed",
              blockedClass: classification.class,
              thrashCount,
              thrashExhausted,
            },
          });
          await deps.persistTokenUsage(taskId);
          executorLog.log(
            `⛔ ${taskId} ${
              autoReplanPark
                ? "parked for automatic replan via blocked exit (plan defect, no dependencies)"
                : thrashExhausted
                  ? `parked failed via blocked thrash-exhaustion (class=${classification.class})`
                  : `parked failed via durable blocked exit (class=${classification.class}; blockedBy tasks: ${blockedByIds.join(", ") || "none"})`
            }`,
          );

          return {
            content: [{
              type: "text" as const,
              text: autoReplanPark
                ? "Task parked as blocked with no blocking task dependencies — queued for automatic replan so the plan can resolve the conflict. Steps left in their true statuses; no completion recorded."
                : thrashExhausted
                  ? "Task parked as blocked (failed) after repeated identical durable blocks — no further automatic retries. Resolve the blocking tasks or replan manually."
                  : `Task parked as blocked (failed). Recorded ${blockedByIds.length} blocking task dependency(ies); it will requeue once they complete. Steps left in their true statuses; no completion recorded.`,
            }],
            details: {},
          };
        }

        const task = await store.getTask(taskId);
        const completionBlocker = await deps.getTaskCompletionBlocker(task);
        if (completionBlocker) {
          return {
            content: [{
              type: "text" as const,
              text: `Cannot mark task done yet — ${completionBlocker}. Resolve the blocker before calling fn_task_done().`,
            }],
            details: {},
          };
        }

        const providerVerdict = await deps.evaluateTaskVerdictProviders(task, {
          summary: params.summary,
          source: "fn_task_done",
        });
        if (!providerVerdict.ok) {
          await store.logEntry(taskId, providerVerdict.message, undefined, deps.getRunContextFor(task.id));
          executorLog.error(`${taskId}: ${providerVerdict.message}`);
          return {
            content: [{ type: "text" as const, text: providerVerdict.message }],
            details: {
              error: providerVerdict.message,
            },
          };
        }

        const noOpMarker = parseNoOpCompletionMarker(params.summary);
        const invariantCheck = await deps.verifyWorktreeInvariants(task, worktreePath, true, {
          noOpCompletion: Boolean(noOpMarker),
          noOpCompletionReason: noOpMarker
            ? `verified ${noOpMarker.kind} completion sentinel${noOpMarker.canonicalId ? ` (${noOpMarker.canonicalId})` : ""}`
            : undefined,
        });
        if (!invariantCheck.ok) {
          const refusalMessage = `fn_task_done refused: ${invariantCheck.reason} — observed=${invariantCheck.observed}, expected=${invariantCheck.expected}`;
          await store.logEntry(taskId, refusalMessage, undefined, deps.getRunContextFor(task.id));
          executorLog.error(`${taskId}: fn_task_done refused (${invariantCheck.reason}) — observed=${invariantCheck.observed}, expected=${invariantCheck.expected}`);

          const priorRequeues = task.taskDoneRetryCount ?? 0;
          const nextRequeueCount = priorRequeues + 1;
          if (priorRequeues < MAX_TASK_DONE_REQUEUE_RETRIES) {
            await store.updateTask(taskId, {
              status: "queued",
              error: null,
              taskDoneRetryCount: nextRequeueCount,
              paused: false,
              pausedByAgentId: null,
              worktree: null,
              branch: null,
              sessionFile: null,
            });
            await store.logEntry(
              taskId,
              `${refusalMessage} — requeued to todo immediately (${nextRequeueCount}/${MAX_TASK_DONE_REQUEUE_RETRIES})`,
              undefined,
              deps.getRunContextFor(task.id),
            );
            await store.moveTask(taskId, await resolveReboundColumnFor(store, taskId), { preserveProgress: true });
            executorLog.log(`✗ ${taskId} failed invariant check — requeued to todo (${nextRequeueCount}/${MAX_TASK_DONE_REQUEUE_RETRIES})`);
          } else {
            await store.updateTask(taskId, {
              status: "failed",
              error: refusalMessage,
              paused: false,
              pausedByAgentId: null,
              worktree: null,
              branch: null,
              sessionFile: null,
            });
            await store.logEntry(taskId, `${refusalMessage} — invariant-check retry budget exhausted`, undefined, deps.getRunContextFor(task.id));
            await deps.persistTokenUsage(taskId);
            executorLog.log(`✗ ${taskId} failed invariant check`);
          }

          return {
            content: [{ type: "text" as const, text: refusalMessage }],
            details: {
              error: refusalMessage,
            },
          };
        }

        const taskDoneRefusal = evaluateTaskDoneRefusal(task, params, codeReviewVerdicts);
        if (!taskDoneRefusal.ok) {
          const refusalMessage = taskDoneRefusal.message;
          await store.logEntry(taskId, refusalMessage, undefined, deps.getRunContextFor(task.id));
          executorLog.error(`${taskId}: fn_task_done refused (${taskDoneRefusal.refusalClass}) — ${taskDoneRefusal.reason}`);

          // FNXC:Lifecycle 2026-07-16-21:40: FN-8141 — stamp the skip-bypass taint marker so a
          // later skip-then-exit (in this or a requeued lifecycle) cannot auto-promote.
          const taintUpdate = skipBypassTaintUpdateForRefusal(taskDoneRefusal);
          const priorRequeues = task.taskDoneRetryCount ?? 0;
          const nextRequeueCount = priorRequeues + 1;
          if (priorRequeues < MAX_TASK_DONE_REQUEUE_RETRIES) {
            await store.updateTask(taskId, {
              status: "queued",
              error: null,
              taskDoneRetryCount: nextRequeueCount,
              ...taintUpdate,
              paused: false,
              pausedByAgentId: null,
              worktree: null,
              branch: null,
              sessionFile: null,
            });
            await store.logEntry(
              taskId,
              `${refusalMessage} — requeued to todo immediately (${nextRequeueCount}/${MAX_TASK_DONE_REQUEUE_RETRIES})`,
              undefined,
              deps.getRunContextFor(task.id),
            );
            await store.moveTask(taskId, await resolveReboundColumnFor(store, taskId), { preserveProgress: true });
            executorLog.log(`✗ ${taskId} fn_task_done refusal (${taskDoneRefusal.refusalClass}) — requeued to todo (${nextRequeueCount}/${MAX_TASK_DONE_REQUEUE_RETRIES})`);
          } else {
            await store.updateTask(taskId, {
              status: "failed",
              error: refusalMessage,
              ...taintUpdate,
              paused: false,
              pausedByAgentId: null,
              worktree: null,
              branch: null,
              sessionFile: null,
            });
            await store.logEntry(taskId, `${refusalMessage} — fn_task_done refusal retry budget exhausted`, undefined, deps.getRunContextFor(task.id));
            await deps.persistTokenUsage(taskId);
            executorLog.log(`✗ ${taskId} fn_task_done refusal (${taskDoneRefusal.refusalClass})`);
          }

          return {
            content: [{ type: "text" as const, text: refusalMessage }],
            details: {
              error: refusalMessage,
              refusalClass: taskDoneRefusal.refusalClass,
            },
          };
        }

        // Merge per-task effective workflow settings (U3, KTD-3) so the
        // planOnlyScopeLeakEnforcement read in evaluateTaskDoneScopeLeak picks up
        // workflow values. Behavior-inert by default.
        const settings = await mergeEffectiveSettings(store, task, await store.getSettings());
        const scopeLeakCheck = await deps.evaluateTaskDoneScopeLeak(task, worktreePath, promptContent, settings, audit)
          .catch((error: unknown) => {
            const errorMessage = error instanceof Error ? error.message : String(error);
            executorLog.warn(`${taskId}: scope-leak guard failed open: ${errorMessage}`);
            return { blocked: false } as const;
          });
        if (scopeLeakCheck.blocked) {
          await store.logEntry(taskId, `[scope-leak] blocked fn_task_done: ${scopeLeakCheck.message}`, undefined, deps.getRunContextFor(task.id));
          return {
            content: [{ type: "text" as const, text: scopeLeakCheck.message }],
            details: {
              error: scopeLeakCheck.message,
            },
          };
        }

        const completionRecommendations = params.recommendations === undefined
          ? undefined
          : validateCompletionRecommendations(params.recommendations, settings.maxRecommendationsPerTask ?? 3);
        if (typeof completionRecommendations === "string") {
          return {
            content: [{ type: "text" as const, text: `Cannot mark task done yet — ${completionRecommendations}.` }],
            details: { error: completionRecommendations },
          };
        }

        if (noOpMarker) {
          const completion = await deps.finalizeAcceptedNoOpCompletion({
            task,
            marker: noOpMarker,
            summary: params.summary?.trim() || `${noOpMarker.kind.toUpperCase()}: ${noOpMarker.reason}`,
            recommendations: completionRecommendations,
            onDone,
          });
          if (!completion.completed) {
            return {
              content: [{ type: "text" as const, text: "Cannot mark task done because completion handoff was interrupted." }],
              details: { error: "no-op-completion-interrupted" },
            };
          }
          const successMessage = completion.hardPauseActive
            ? "Task marked complete. Completion handoff deferred until pause is cleared."
            : params.summary
              ? "Task marked complete with summary. All steps done. Moving to in-review."
              : "Task marked complete. All steps done. Moving to in-review.";
          return { content: [{ type: "text" as const, text: successMessage }], details: {} };
        }

        onDone();

        // Mark all pending/in-progress steps as done
        for (let i = 0; i < task.steps.length; i++) {
          if (task.steps[i].status !== "done" && task.steps[i].status !== "skipped") {
            await store.updateStep(taskId, i, "done");
          }
        }
        // FN-4106: preserve the original completion summary on workflow-step reruns.
        const newSummary = params.summary?.trim();
        if (newSummary) {
          const currentTask = await store.getTask(taskId);
          const existingSummary = currentTask.summary?.trim();
          const hasRunWorkflowSteps = (currentTask.workflowStepResults?.length ?? 0) > 0;
          const rerunSuffix = `---\nRerun after workflow step revision:\n${newSummary}`;

          if (existingSummary && hasRunWorkflowSteps && !existingSummary.endsWith(rerunSuffix)) {
            await store.updateTask(taskId, {
              summary: `${currentTask.summary}\n\n${rerunSuffix}`,
            });
            await store.logEntry(taskId, "fn_task_done summary appended to existing summary (workflow-step rerun)", undefined, deps.getRunContextFor(taskId));
          } else if (!existingSummary || !hasRunWorkflowSteps) {
            await store.updateTask(taskId, { summary: params.summary });
          }
        }
        // FNXC:TaskRecommendations 2026-08-08-05:02: write only after every completion gate accepts; retries replace the list deterministically.
        if (completionRecommendations !== undefined) {
          await store.updateTask(taskId, { recommendations: completionRecommendations });
        }
        const hardPauseActive = Boolean(settings.globalPause);
        // Task-level pause prevents new work from starting, not completion of
        // in-flight work. Always clear it on explicit agent completion so the
        // board cannot strand a completed task in a paused state.
        await store.updateTask(taskId, {
          paused: false,
          pausedByAgentId: null,
          status: null,
          // FNXC:Lifecycle 2026-07-16-21:40: FN-8141 — an ACCEPTED explicit fn_task_done is the
          // honest completion signal (covers the PREMISE STALE skip-then-done flow); clear any
          // skip-bypass taint so a subsequent auto-promotion path is not blocked.
          bulkCompletionRefusalAt: null,
        });
        await store.logEntry(taskId, "Task marked done by agent", undefined, deps.getRunContextFor(taskId));

        const latestTask = await store.getTask(taskId);
        let latestColumn = latestTask.column;
        if (latestColumn === await resolveReboundColumnFor(store, taskId)) {
          await store.logEntry(
            taskId,
            hardPauseActive
              ? "fn_task_done called while task was in todo during pause — promoting to in-progress for deferred completion handoff"
              : "fn_task_done called while task was in todo — promoting to in-progress before completion handoff",
            undefined,
            deps.getRunContextFor(taskId),
          );
          /* FNXC:WorkflowResolvedColumns 2026-07-30-21:40: census-invisible moveTask DESTINATION, and `latestColumn` must be set from the SAME resolved value or the check below it compares against a lane the card is not in. */
          const wipTarget = await resolveWipTargetForTask(store, taskId);
          await store.moveTask(taskId, wipTarget);
          latestColumn = wipTarget;
        }

        /*
        FNXC:WorkflowResolvedColumns 2026-07-31-09:20 (fleet: executor lifecycle roles):
        The completed-task watchdog arms when the card is in its IMPLEMENTATION lane. Naming
        `in-progress` literally meant a renamed wip column never armed it — a watchdog that
        silently never fires, on exactly the boards this program converted. The branch directly
        above already resolves that lane through `resolveWipTargetForTask`; this asks the same
        question of the same resolver rather than of an id.
        */
        if (latestColumn === await resolveWipTargetForTask(store, taskId) && !hardPauseActive) {
          deps.scheduleCompletedTaskWatchdog(taskId, "fn_task_done");
        }

        const successMessage = hardPauseActive
          ? "Task marked complete. Completion handoff deferred until pause is cleared."
          : params.summary
          ? "Task marked complete with summary. All steps done. Moving to in-review."
          : "Task marked complete. All steps done. Moving to in-review.";
        return {
          content: [{ type: "text" as const, text: successMessage }],
          details: {},
        };
      },
    };
}
