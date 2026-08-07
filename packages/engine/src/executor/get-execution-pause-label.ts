/**
 * FNXC:CodeOrganization 2026-08-03-17:15:
 * getExecutionPauseLabel peeled from TaskExecutor (U4).
 */
import type { TaskStore } from "@fusion/core";

export type GetExecutionPauseLabelDeps = {
  store: TaskStore;
};

export async function getExecutionPauseLabel(
  deps: GetExecutionPauseLabelDeps,
): Promise<"global pause" | "engine pause" | null> {
  const settings = await deps.store.getSettings();
  if (settings.globalPause) return "global pause";
  if (settings.enginePaused) return "engine pause";
  return null;
}
