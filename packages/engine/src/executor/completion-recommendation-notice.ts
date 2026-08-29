/*
FNXC:TaskRecommendations 2026-08-13-03:56:
The durable recommendation write precedes several abort/rollback returns in no-op completion, so
notifying there would announce proposals for a rejected handoff. Dispatch only after accepted
completion. It is fire-and-forget because mailbox latency or failure must never extend or fail
`fn_task_done`; attach a catch synchronously so rejection cannot escape unhandled.
*/

import {
  notifyOperatorOfTaskRecommendations,
  type Settings,
  type TaskRecommendation,
  type TaskStore,
} from "@fusion/core";

const pendingNotices = new Set<Promise<void>>();

export function dispatchAcceptedCompletionRecommendationNotice(args: {
  store: TaskStore;
  taskId: string;
  taskTitle?: string;
  recommendations?: TaskRecommendation[];
  settings?: Settings;
  log?: { warn(msg: string): void };
}): void {
  if (!args.recommendations?.length) return;

  const pending = (async () => {
    const settings = args.settings ?? await args.store.getSettings();
    const task = await args.store.getTask(args.taskId);
    if (!task || task.deletedAt) return;
    await notifyOperatorOfTaskRecommendations(
      args.store,
      { id: args.taskId, title: args.taskTitle ?? task.title },
      args.recommendations,
      settings,
    );
  })();
  pendingNotices.add(pending);
  void pending.catch((error: unknown) => {
    args.log?.warn(
      `Failed to dispatch recommendation mailbox notice for ${args.taskId}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }).finally(() => {
    pendingNotices.delete(pending);
  });
}

/** Test-only drain; production completion callers must remain strictly non-awaiting. */
export async function __flushPendingRecommendationNotices(): Promise<void> {
  await Promise.allSettled([...pendingNotices]);
}
