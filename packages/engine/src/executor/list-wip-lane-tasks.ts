/**
 * FNXC:CodeOrganization 2026-08-03-10:25:
 * listWipLaneTasks peeled from TaskExecutor (U4).
 * Resume sweeps must read every column with countsTowardWip, not the literal "in-progress".
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
