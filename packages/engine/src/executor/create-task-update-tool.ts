/**
 * FNXC:CodeOrganization 2026-08-03-12:50:
 * createTaskUpdateTool peeled from TaskExecutor (U4).
 *
 * FNXC:StepNumbering 2026-06-17-00:00:
 * FN-6607: step is 0-based matching PROMPT.md Step N numbers.
 *
 * FNXC:WorkflowReviewGates 2026-07-19-02:30:
 * U10: in-session code-review REVISE gate on fn_task_update(done) deleted with fn_review_step.
 *
 * FNXC:StepLifecycle 2026-07-22-09:50:
 * Persisted-status mismatch is a deterministic churn signal after loop recovery.
 */
import { Type, type Static } from "@earendil-works/pi-ai";
import type { StepStatus, TaskStore, WorkflowFieldDefinition } from "@fusion/core";
import type { ToolDefinition, AgentSession } from "@earendil-works/pi-coding-agent";
import type { ReviewVerdict } from "../execution/reviewer.js";
import type { StuckTaskDetector } from "../healing/stuck-task-detector.js";
import { executorLog } from "../logger.js";

const STEP_STATUSES: StepStatus[] = ["pending", "in-progress", "done", "skipped"];

const taskUpdateParams = Type.Object({
  step: Type.Optional(Type.Number({ description: "Step number (0-indexed; matches the `### Step N:` numbers in PROMPT.md — Step 0 is Preflight). Omit when updating only custom_fields/dependencies." })),
  status: Type.Optional(Type.Union(
    STEP_STATUSES.map((s) => Type.Literal(s)),
    { description: "New status: pending, in-progress, done, or skipped. Required when step is set." },
  )),
  dependencies: Type.Optional(Type.Array(Type.String(), {
    description: "Optional task dependency array. Replaces existing dependencies. Pass ['FN-001', 'FN-002'] to set dependencies. Pass [] to clear all dependencies. Omit parameter to preserve existing dependencies.",
  })),
  custom_fields: Type.Optional(Type.Record(Type.String(), Type.Unknown(), {
    description:
      "Optional patch of workflow-defined custom field values, keyed by field id. " +
      "Values are validated against the task's workflow field schema (type/enum membership); " +
      "pass null for a field to clear it. Rejected writes return the offending field id and reason. " +
      "Only fields declared by the task's workflow may be written.",
  })),
});

export type CreateTaskUpdateToolDeps = {
  store: TaskStore;
  resolveTaskCustomFieldDefs: (taskId: string) => Promise<WorkflowFieldDefinition[] | undefined>;
  loopRecoveryState: Map<string, { attempts: number; pending: boolean }>;
};

/**
 * Create fn_task_update for the executor coding session.
 * `codeReviewVerdicts` / `sessionRef` remain in the signature for call-site compatibility
 * (legacy review-gate args; U10 no longer consults them).
 */
export function createTaskUpdateTool(
  deps: CreateTaskUpdateToolDeps,
  taskId: string,
  _codeReviewVerdicts: Map<number, ReviewVerdict>,
  _sessionRef: { current: AgentSession | null },
  stuckDetector?: StuckTaskDetector,
): ToolDefinition {
    const store = deps.store;
    return {
      name: "fn_task_update",
      label: "Update Step",
      description:
        "Update a step's status. Call before starting a step (in-progress), " +
        "after completing it (done), or to skip it (skipped). " +
        "Optionally update task dependencies by passing a dependencies array. " +
        "Optionally set workflow-defined custom field values by passing a custom_fields patch " +
        "(keyed by field id; validated against the workflow's field schema; pass null to clear a field). " +
        "step/status may be omitted to update only custom_fields or dependencies. " +
        "The board updates in real-time.",
      parameters: taskUpdateParams,
      execute: async (_id: string, params: Static<typeof taskUpdateParams>) => {
        const { step, status, dependencies, custom_fields } = params;

        // Bare-call guard (P1 api-contract): a call with none of
        // step/status/dependencies/custom_fields silently no-op'd, which the
        // agent cannot observe. Reject it up front so the failure is visible and
        // self-describing. The legacy no-op text is preserved as the detail.
        if (step === undefined && status === undefined && dependencies === undefined && custom_fields === undefined) {
          return {
            content: [{
              type: "text" as const,
              text: "ERROR: fn_task_update requires at least one of: step+status (report step progress), " +
                "dependencies (array of task ids), or custom_fields (workflow-defined field patch). " +
                "No-op: provide a step+status, dependencies, or custom_fields to update.",
            }],
            details: {},
            isError: true,
          };
        }

        // Custom-field patch (KTD-13): routed through the store's single write
        // authority, which validates each value against the task's workflow field
        // schema. A typed rejection surfaces the offending field id + reason as a
        // tool error so the agent can correct it. Applied first so a field-only
        // call (step omitted) returns here.
        if (custom_fields !== undefined) {
          const res = await store.updateTaskCustomFields(taskId, custom_fields);
          if (!res.ok) {
            const r = res.rejection;
            // Self-correcting rejection text: append the valid field ids (and,
            // for an enum violation, the valid values for the offending field)
            // resolved from the task's workflow field schema so a failed write
            // carries everything the agent needs to retry. Best-effort: a
            // resolution failure just omits the hint (the base reason still ships).
            let hint = "";
            try {
              const defs = await deps.resolveTaskCustomFieldDefs(taskId);
              if (defs && defs.length > 0) {
                if (r.code === "unknown-field" || r.code === "no-fields-defined") {
                  hint = ` Valid field ids: ${defs.map((f) => f.id).join(", ")}.`;
                } else if (r.code === "enum-violation") {
                  const field = defs.find((f) => f.id === r.fieldId);
                  const opts = field?.options?.map((o) => o.value) ?? [];
                  if (opts.length > 0) hint = ` Valid values for '${r.fieldId}': ${opts.join(", ")}.`;
                }
              }
            } catch { /* hint is best-effort */ }
            return {
              content: [{
                type: "text" as const,
                text: `ERROR: custom field '${r.fieldId}' rejected (${r.code}): ${r.detail}${hint}`,
              }],
              details: { fieldId: r.fieldId, code: r.code, detail: r.detail },
              isError: true,
            };
          }
          // A custom-fields-only update (no step) succeeds here.
          if (step === undefined && status === undefined && dependencies === undefined) {
            const updatedKeys = Object.keys(custom_fields);
            return {
              content: [{
                type: "text" as const,
                text: `Updated custom field(s): ${updatedKeys.join(", ")}.`,
              }],
              details: { updatedFields: updatedKeys },
            };
          }
        }

        // Record step progress for stuck task detection.
        // Step transitions (in-progress, done, skipped) indicate real progress
        // and reset the loop detection counter. Generic activity (text deltas,
        // tool calls) is tracked separately via recordActivity in AgentLogger.
        if (status === "in-progress" || status === "done" || status === "skipped") {
          stuckDetector?.recordProgress(taskId);
        }

        // Dependencies-only update (no step) is permitted; handle deps then return.
        if (step === undefined) {
          if (dependencies !== undefined) {
            if (dependencies.includes(taskId)) {
              return {
                content: [{ type: "text" as const, text: `Cannot add self-dependency: ${taskId} cannot depend on itself.` }],
                details: {},
              };
            }
            const invalidIds: string[] = [];
            for (const depId of dependencies) {
              try { await store.getTask(depId); } catch { invalidIds.push(depId); }
            }
            if (invalidIds.length > 0) {
              return {
                content: [{ type: "text" as const, text: `Cannot set dependencies — the following task(s) do not exist: ${invalidIds.join(", ")}` }],
                details: {},
              };
            }
            await store.updateTask(taskId, { dependencies });
            return {
              content: [{ type: "text" as const, text: `Dependencies updated.` }],
              details: {},
            };
          }
          return {
            content: [{ type: "text" as const, text: `No-op: provide a step+status, dependencies, or custom_fields to update.` }],
            details: {},
          };
        }

        if (status === undefined) {
          return {
            content: [{ type: "text" as const, text: `Step ${step} provided without a status. Pass status (pending/in-progress/done/skipped).` }],
            details: {},
          };
        }

        if (!Number.isInteger(step) || step < 0) {
          return {
            content: [{
              type: "text" as const,
              text: `Invalid step number: ${step}. Steps are 0-indexed; Step 0 is Preflight.`,
            }],
            details: {},
          };
        }

        /*
         * FNXC:StepNumbering 2026-06-17-00:00:
         * FN-6607 makes fn_task_update.step the same 0-based number agents see in PROMPT.md (`### Step N:`) and TaskStore.updateStep uses internally. The prior `step - 1` conversion made Step 0 impossible to mark done and shifted every review/progress update one array slot early.
         */
        const stepIndex = step;

        if (status === "in-progress") {
          try {
            const latestTask = await store.getTask(taskId);
            const otherInProgressStepIndex = latestTask.steps.findIndex(
              (taskStep, index) => index !== stepIndex && taskStep.status === "in-progress",
            );
            if (otherInProgressStepIndex !== -1) {
              executorLog.warn(
                `${taskId}: fn_task_update marking step ${step} in-progress while step ${otherInProgressStepIndex} is already in-progress`,
              );
            }
          } catch (err) {
            executorLog.warn(`${taskId}: failed to inspect step lease state before fn_task_update: ${err}`);
          }
        }

        /*
        FNXC:WorkflowReviewGates 2026-07-19-02:30:
        U10 (R9): the in-session code-review REVISE gate on `fn_task_update(status="done")` is
        deleted. Its verdict source was the legacy `fn_review_step` tool, which no longer exists,
        so the map it read is permanently empty. A REVISE from a graph-owned Code Review node routes back to
        the implementation node as a graph edge instead of blocking a step-status tool call.
        */

        // Handle dependencies parameter if provided
        if (dependencies !== undefined) {
          // Validate: prevent self-dependency
          if (dependencies.includes(taskId)) {
            return {
              content: [{
                type: "text" as const,
                text: `Cannot add self-dependency: ${taskId} cannot depend on itself.`,
              }],
              details: {},
            };
          }

          // Validate: all dependency task IDs must exist
          const invalidIds: string[] = [];
          for (const depId of dependencies) {
            try {
              await store.getTask(depId);
            } catch {
              invalidIds.push(depId);
            }
          }

          if (invalidIds.length > 0) {
            return {
              content: [{
                type: "text" as const,
                text: `Cannot set dependencies — the following task(s) do not exist: ${invalidIds.join(", ")}`,
              }],
              details: {},
            };
          }

          // Update dependencies
          await store.updateTask(taskId, { dependencies });
        }

        const task = await store.updateStep(taskId, stepIndex, status as StepStatus);
        const stepInfo = task.steps[stepIndex];
        if (!stepInfo) {
          return {
            content: [{
              type: "text" as const,
              text: `Invalid step number: ${step}. This task has ${task.steps.length} step(s) (0-indexed; valid range 0-${Math.max(0, task.steps.length - 1)}).`,
            }],
            details: {},
          };
        }
        const persistedStatus = stepInfo.status;
        const progress = task.steps.filter((s) => s.status === "done").length;

        /*
        FNXC:WorkflowReviewGates 2026-07-19-02:30:
        U10 (R9): the pre-step conversation-checkpoint capture is deleted with `fn_review_step`.
        Its only consumer was that tool's RETHINK rewind (`session.navigateTree`); a graph-owned
        RETHINK re-enters the implementation node instead of rewinding the live conversation.
        */

        // FNXC:StepLifecycle 2026-07-22-09:50: A persisted-status mismatch means
        // the store rejected the transition (for example, a completed-step
        // regression or an out-of-order start/completion). FN-5168 treats
        // repeated rebuffs after loop recovery as a deterministic churn signal.
        if (persistedStatus !== status) {
          stuckDetector?.recordIgnoredStepUpdate(taskId);

          const ignoredStepUpdates = stuckDetector?.getIgnoredStepUpdateCount(taskId) ?? 0;
          const loopAttempts = deps.loopRecoveryState.get(taskId)?.attempts ?? 0;
          if (loopAttempts >= 1 && ignoredStepUpdates === 25) {
            executorLog.warn(
              `${taskId}: no-progress churn detected ` +
              `(ignoredStepUpdates=${ignoredStepUpdates}, stuckKillStreak=${task.stuckKillCount ?? 0}) — ` +
              `escalating to STUCK_NO_PROGRESS_CHURN`,
            );
          }

          return {
            content: [{
              type: "text" as const,
              text: `Step ${step} (${stepInfo.name}) remains ${persistedStatus} — ${status} request ignored to preserve step lifecycle invariants. Progress: ${progress}/${task.steps.length} done.`,
            }],
            details: {},
          };
        }

        return {
          content: [{
            type: "text" as const,
            text: `Step ${step} (${stepInfo.name}) → ${persistedStatus}. Progress: ${progress}/${task.steps.length} done.`,
          }],
          details: {},
        };
      },
    };
}
