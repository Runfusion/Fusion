/**
 * FNXC:CodeOrganization 2026-08-03-13:55:
 * hasTrailingConsecutiveToolFailures peeled from TaskExecutor (U4).
 *
 * FNXC:ExecutorToolFailureRetry 2026-07-17-06:30:
 * Optional log APIs on minimal/test stores: missing getAgentLogCount/getAgentLogs cannot prove a trailing failure streak.
 */
import type { TaskStore } from "@fusion/core";

export type HasTrailingConsecutiveToolFailuresDeps = {
  store: TaskStore;
};

export async function hasTrailingConsecutiveToolFailures(
  deps: HasTrailingConsecutiveToolFailuresDeps,
  taskId: string,
  cursor: number | null | undefined,
  threshold: number,
): Promise<boolean> {
  if (cursor == null) return false;
  /*
  FNXC:ExecutorToolFailureRetry 2026-07-17-06:30:
  Optional log APIs on minimal/test stores: missing getAgentLogCount/getAgentLogs cannot
  prove a trailing failure streak, so return false rather than throw mid-failure handling.
  */
  if (typeof deps.store.getAgentLogCount !== "function" || typeof deps.store.getAgentLogs !== "function") {
    return false;
  }
  const currentCount = await deps.store.getAgentLogCount(taskId).catch(() => cursor);
  if (currentCount <= cursor) return false;
  const entries = await deps.store.getAgentLogs(taskId, { limit: currentCount - cursor }).catch(() => []);
  let failures = 0;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const type = entries[index]!.type;
    if (type === "tool_result") return false;
    if (type === "tool_error") {
      failures += 1;
      if (failures >= threshold) return true;
    }
    // Invocation markers and non-completion entries intentionally do not reset the run.
  }
  return false;
}
