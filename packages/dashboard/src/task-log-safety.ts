import { isTaskLogWriteRefusal } from "@fusion/core";
import type { TaskStore } from "@fusion/core";

type WarningLogger = { warn(message: string): void };

/*
FNXC:GithubTrackingReconcile 2026-09-15-15:19:
A delete-path log write can legitimately be refused because its task is soft-deleted or historical.
Treat that known refusal as a service diagnostic so one stale row cannot starve its reconciliation
pass, while unrelated storage errors retain their normal failure path.
*/
export async function safeLogTaskEntry(
  store: TaskStore,
  taskId: string,
  action: string,
  details: string,
  options: { logger: WarningLogger; context: string },
): Promise<void> {
  try {
    await store.logEntry(taskId, action, details);
  } catch (error) {
    if (!isTaskLogWriteRefusal(error, taskId)) throw error;
    options.logger.warn(`[${options.context}] Unable to write log entry for deleted task ${taskId}: ${action}`);
  }
}
