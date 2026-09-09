import type { Task } from "../types.js";
import { taskHoldsUnmergedCheckout } from "../tasks/file-scope-lease.js";
import { isRunningAgentTask, type RunningAgentTaskShape } from "./live-agent-count.js";

export type WorktreeCapacityTaskShape = RunningAgentTaskShape
  & Pick<Task, "worktree" | "workspaceWorktrees">;

/*
FNXC:CapacityModel 2026-09-01-14:49:
Worktree capacity counts a live WIP task before acquisition because dispatch commits the slot before
its checkout path is persisted; counting only acquired paths would under-count that transfer window
and over-admit execution. A task with a retained singular or workspace checkout also counts in any
eligible non-terminal lane, because a replan bounce keeps real on-disk work that execution will resume.
Planning-only tasks satisfy neither condition and therefore consume no worktree slot.

FNXC:CapacityModel 2026-09-01-16:01:
A Plan Review replan bounce carries `status:"needs-replan"`, which is intentionally not a live-agent
status, while retaining the execution checkout it will resume onto. Count that real checkout before
consulting agent liveness so it cannot disappear from the host-resource gate; pause, failure, and
terminal lifecycle state still release the slot.

DELIBERATE-LITERAL — resolved lifecycle metadata wins when present. The legacy `done` and
`in-progress` names are compatibility fallbacks for callers whose task shape predates those fields;
historical-sentinel rows are excluded from the live inventory before this predicate runs.
*/
export function isWorktreeCapacityHolder(task: WorktreeCapacityTaskShape): boolean {
  const terminalKind = task.columnTerminalKind
    ?? (task.column === "done" ? "complete" : "none");
  if (terminalKind !== "none" || task.paused || task.userPaused || task.status === "failed") return false;
  if (taskHoldsUnmergedCheckout(task)) return true;
  if (!isRunningAgentTask(task)) return false;
  return task.columnCountsTowardWip ?? task.column === "in-progress";
}
