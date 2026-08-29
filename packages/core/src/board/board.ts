import type { Column, Task } from "../types.js";
import { VALID_TRANSITIONS } from "../types.js";

export function canTransition(from: Column, to: Column): boolean {
  return VALID_TRANSITIONS[from].includes(to);
}

export function getValidTransitions(column: Column): Column[] {
  return [...VALID_TRANSITIONS[column]];
}

/**
 * Resolve dependency order for a set of tasks.
 * Returns task IDs in execution order — tasks with no unmet deps first.
 */
export function resolveDependencyOrder(tasks: Task[]): string[] {
  const taskMap = new Map(tasks.map((t) => [t.id, t]));
  const ordered: string[] = [];
  const visited = new Set<string>();
  const visiting = new Set<string>();

  function visit(id: string): void {
    if (visited.has(id)) return;
    if (visiting.has(id)) return; // circular — skip
    visiting.add(id);

    const task = taskMap.get(id);
    if (task) {
      for (const depId of task.dependencies) {
        if (taskMap.has(depId)) visit(depId);
      }
    }

    visiting.delete(id);
    visited.add(id);
    ordered.push(id);
  }

  for (const task of tasks) visit(task.id);
  return ordered;
}
