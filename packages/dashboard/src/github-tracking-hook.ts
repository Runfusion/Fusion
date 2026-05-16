import { setTaskCreatedHook, type TaskStore, type Task } from "@fusion/core";
import { maybeCreateTrackingIssue } from "./github-tracking.js";

export async function createTrackingIssueForTask(
  taskStore: TaskStore,
  task: Task,
  options?: { githubToken?: string; logger?: Pick<Console, "warn" | "info"> },
): Promise<void> {
  const logger = options?.logger ?? console;

  try {
    const projectSettings = await taskStore.getSettings();
    const globalSettings =
      (await taskStore.getGlobalSettingsStore?.()?.getSettings?.()) ?? {};
    const trackingProjectSettings = options?.githubToken
      ? {
          ...projectSettings,
          githubAuthToken: projectSettings.githubAuthToken ?? options.githubToken,
        }
      : projectSettings;

    await maybeCreateTrackingIssue(task, {
      taskStore,
      projectSettings: trackingProjectSettings,
      globalSettings,
      rootDir: taskStore.getRootDir(),
      logger,
    });
  } catch {
    // Best-effort only.
  }
}

/**
 * Register a post-create hook that calls `maybeCreateTrackingIssue` for every
 * new task.  Called once at process startup by the dashboard server, the CLI,
 * and the pi extension.
 *
 * Idempotent: calling this twice replaces the previous hook (no chaining).
 */
export function registerGithubTrackingHook(
  options?: { logger?: Pick<Console, "warn" | "info"> },
): void {
  const logger = options?.logger ?? console;

  setTaskCreatedHook(async (task: Task, store: TaskStore) => {
    try {
      await createTrackingIssueForTask(store, task, { logger });
    } catch (error) {
      // Best-effort: never propagate out of the hook.
      const message = error instanceof Error ? error.message : String(error);
      logger.warn?.(`[github-tracking-hook] ${task.id}: ${message}`);
    }
  });
}
