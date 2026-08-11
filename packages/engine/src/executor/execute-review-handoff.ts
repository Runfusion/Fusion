/**
 * FNXC:CodeOrganization 2026-08-03-09:25:
 * executeReviewHandoff peeled from TaskExecutor (U4).
 * Agent-requested review handoff: awaiting-user-review, handoff to in-review, dispose session.
 */
import type { Task, TaskStore } from "@fusion/core";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { executorLog } from "../logger.js";
import type { EngineRunContext } from "../util/run-audit.js";

export type ExecuteReviewHandoffDeps = {
  store: TaskStore;
  getRunContextFor: (taskId: string) => EngineRunContext | undefined;
  persistTokenUsage: (taskId: string) => Promise<void>;
  handoffTaskToReview: (task: Task, reason: string) => Promise<unknown>;
  activeSessions: Map<string, { session: AgentSession }>;
  deleteActiveSession: (taskId: string) => void;
  untrackStuckTask: (taskId: string) => void;
};

export async function executeReviewHandoff(
  deps: ExecuteReviewHandoffDeps,
  task: Task,
  _session: AgentSession,
  _sessionEntry: unknown,
): Promise<void> {
  try {
    executorLog.log(`Executing review handoff for ${task.id}`);

    await deps.store.logEntry(
      task.id,
      "Review handoff requested by agent — moving to in-review for user review",
      undefined,
      deps.getRunContextFor(task.id),
    );

    await deps.store.updateTask(
      task.id,
      {
        status: "awaiting-user-review",
        assigneeUserId: "requesting-user",
      },
      deps.getRunContextFor(task.id),
    );

    await deps.persistTokenUsage(task.id);
    await deps.handoffTaskToReview(task, "review-handoff-requested");

    if (deps.activeSessions.has(task.id)) {
      const { session: activeSession } = deps.activeSessions.get(task.id)!;
      activeSession.dispose();
      deps.deleteActiveSession(task.id);
    }

    deps.untrackStuckTask(task.id);

    executorLog.log(`Review handoff complete for ${task.id} — task moved to in-review`);
  } catch (err: unknown) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    executorLog.error(`Failed to execute review handoff for ${task.id}: ${errorMessage}`);
  }
}
