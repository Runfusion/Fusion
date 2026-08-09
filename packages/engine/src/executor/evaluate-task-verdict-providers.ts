/**
 * FNXC:CodeOrganization 2026-08-03-13:50:
 * evaluateTaskVerdictProviders peeled from TaskExecutor (U4).
 *
 * Runs registered workflow verdict-provider extensions before fn_task_done acceptance.
 */
import type { TaskDetail, TaskStore, WorkflowIr } from "@fusion/core";
import { resolveWorkflowIrForTask, getWorkflowExtensionRegistry } from "@fusion/core";
import { executorLog } from "../logger.js";

export type EvaluateTaskVerdictProvidersDeps = {
  store: TaskStore;
};

export async function evaluateTaskVerdictProviders(
  deps: EvaluateTaskVerdictProvidersDeps,
  task: TaskDetail,
  context: Record<string, unknown> = {},
): Promise<{ ok: true } | { ok: false; message: string }> {
    let workflow: WorkflowIr;
    try {
      workflow = await resolveWorkflowIrForTask(deps.store, task.id);
    } catch (error) {
      executorLog.warn(`${task.id}: failed to resolve workflow for verdict providers: ${error instanceof Error ? error.message : String(error)}`);
      return { ok: true };
    }

    const providers = getWorkflowExtensionRegistry().list("verdict-provider");
    for (const definition of providers) {
      const extension = definition.extension;
      if (definition.degraded || extension.kind !== "verdict-provider" || !extension.evaluate) continue;
      try {
        const verdict = await extension.evaluate({
          task,
          workflow,
          reworkRound: 0,
          metadata: context,
        });
        if (verdict.status === "pass") continue;
        const reasons = verdict.failureReasons?.map((reason) => reason.message).filter(Boolean).join("; ");
        return {
          ok: false,
          message: `fn_task_done refused (verdict-provider): ${verdict.summary}${reasons ? ` — ${reasons}` : ""}`,
        };
      } catch (error) {
        if (extension.fallback === "degradeToDefault") continue;
        const message = error instanceof Error ? error.message : String(error);
        return {
          ok: false,
          message: `fn_task_done refused (verdict-provider): provider '${definition.id}' failed — ${message}`,
        };
      }
    }

    return { ok: true };
}
