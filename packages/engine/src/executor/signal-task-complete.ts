/**
 * FNXC:CodeOrganization 2026-08-03-10:15:
 * signalTaskComplete + triggerPostTaskReflectionCapture peeled from TaskExecutor (U4).
 *
 * FNXC:AgentReflection 2026-07-04-00:00:
 * FN-7528: single seam for every `onComplete` call site. Fires the deterministic, non-LLM
 * post-task performance capture (best-effort, fire-and-forget — a capture failure must never
 * block or fail task completion) before forwarding to the configured `onComplete` callback.
 * Capture is completion-gated: only runs once per taskId (see `capturedReflectionTaskIds`),
 * guarded by `reflectionService` presence, `settings.reflectionEnabled`, and an assigned agent id
 * mirroring the existing in-session reflection-tool guard.
 */
import type { Task, TaskStore } from "@fusion/core";
import { executorLog } from "../logger.js";
import { triggerTaskMemoryCapture } from "./memory-capture.js";

export type SignalTaskCompleteDeps = {
  store: TaskStore;
  capturedReflectionTaskIds: Set<string>;
  /** Root working-directory for the project (used as the capture project root). */
  rootDir: string;
  /** Task ids that have already had their memory capture attempted (completion-gated). */
  capturedMemoryTaskIds: Set<string>;
  reflectionService?: {
    captureTaskPerformance: (agentId: string, taskId: string) => Promise<unknown>;
  } | null;
  onComplete?: (task: Task) => void;
};

export function signalTaskComplete(deps: SignalTaskCompleteDeps, task: Task): void {
  triggerPostTaskReflectionCapture(deps, task);
  /*
  FNXC:StashSessionCapture 2026-08-19-06:24:
  (RUFU-122 review fix) The completion seam always captures the task_completion
  anchor — the anchor kind is the seam's identity, not a task.status read (the
  engine never writes status "done" onto the row; see TaskCaptureAnchorKind in
  memory-capture.ts).
  */
  triggerTaskMemoryCapture(deps, task, "completion");
  deps.onComplete?.(task);
}

export function triggerPostTaskReflectionCapture(
  deps: Pick<SignalTaskCompleteDeps, "store" | "capturedReflectionTaskIds" | "reflectionService">,
  task: Task,
): void {
  const reflectionService = deps.reflectionService;
  if (!reflectionService) return;

  const assignedAgentId = task.assignedAgentId?.trim();
  if (!assignedAgentId) return;

  if (deps.capturedReflectionTaskIds.has(task.id)) return;
  deps.capturedReflectionTaskIds.add(task.id);

  void (async () => {
    try {
      const settings = await deps.store.getSettings();
      if (!settings.reflectionEnabled) return;
      await reflectionService.captureTaskPerformance(assignedAgentId, task.id);
    } catch (error) {
      executorLog.warn(
        `${task.id}: post-task performance capture failed (best-effort, non-blocking): ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  })();
}
