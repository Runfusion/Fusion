/**
 * FNXC:CodeOrganization 2026-08-03-10:25:
 * listWipLaneTasks peeled from TaskExecutor (U4).
 * Resume sweeps must read every column with countsTowardWip, not the literal "in-progress".
 *
 * FNXC:WorkflowLifecycleColumns 2026-07-30-21:40:
 * The wip-lane read for the two resume sweeps, resolved at PROJECT level.
 *
 * `listTasks`' `column` option filters in the store, so both sweeps returned an EMPTY array on a
 * renamed board and neither resume ran:
 *   - `resumeTaskForAgent` — a durable agent coming back up adopted nothing, so its in-flight task
 *     stayed orphaned;
 *   - `resumeOrphaned` — the engine-wide sweep found no orphans to re-dispatch after a restart.
 *
 * Both are recovery paths, which is the expensive place to be silently inert: the failure only shows
 * up after a crash or a restart, when the operator is already looking at something else. The census
 * cannot see either — it scores comparisons, and a query filter is not one.
 *
 * Project-level because a read has no task in hand, legacy ids unioned so a board mid-rename still
 * finds rows under the old one, deduped by id because one column can carry two roles.
 */
import type { Task, TaskStore } from "@fusion/core";
import { resolveProjectColumnsForRoles } from "@fusion/core";

export async function listWipLaneTasks(store: TaskStore): Promise<Task[]> {
  const columns = await resolveProjectColumnsForRoles(store, ["countsTowardWip"]);
  const byId = new Map<string, Task>();
  for (const column of columns) {
    for (const task of await store.listTasks({ slim: true, column })) byId.set(task.id, task as Task);
  }
  return [...byId.values()];
}
