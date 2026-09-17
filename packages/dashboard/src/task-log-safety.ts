import { createLogger, isTaskLogWriteRefusal } from "@fusion/core";
import type { TaskStore } from "@fusion/core";

const taskLogSafetyLog = createLogger("dashboard-task-log-safety");
type WarningLogger = { warn(message: string): void };

/**
 * FNXC:TerminalTaskWrites 2026-09-15-21:41:
 * Store event listeners are synchronous dispatch boundaries. Their asynchronous maintenance work must
 * classify terminal-row refusals and report other failures instead of leaking unhandled rejections.
 */
export function reportTaskListenerFailure(
  logger: WarningLogger,
  context: string,
  error: unknown,
): void {
  const message = error instanceof Error ? error.message : String(error);
  if (isTaskLogWriteRefusal(error)) {
    logger.warn(`[${context}] terminal task write was refused: ${message}`);
    return;
  }
  logger.warn(`[${context}] lifecycle listener failed: ${message}`);
}

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
  options: { logger: WarningLogger; context: string } = { logger: taskLogSafetyLog, context: "task-log" },
): Promise<void> {
  try {
    await store.logEntry(taskId, action, details);
  } catch (error) {
    if (!isTaskLogWriteRefusal(error, taskId)) throw error;
    options.logger.warn(`[${options.context}] Unable to write log entry for deleted task ${taskId}: ${action}`);
  }
}
