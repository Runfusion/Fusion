import type { ColumnId, RunMutationContext, Task } from "../types.js";
import { UNATTRIBUTED_MUTATION_CONTEXT } from "../identity/mutation-context.js";

/*
FNXC:Identity 2026-08-09-03:04 (U18):
This is a STRUCTURAL store interface, not `TaskStore`, so the U18 overload pair on the real store
does not reach it - the required parameter has to be spelled here too or this seam silently keeps
accepting unattributed writes. Its consumers are the dashboard board routes, so the actor lands with
U9; until then `createBoardActionServices` supplies the marker and the debt is counted.
*/
export interface BoardActionTaskStore {
  moveTask(id: string, column: ColumnId, options: { preserveProgress?: boolean; moveSource?: "user" | "engine" | "scheduler" } | undefined, runContext: RunMutationContext): Promise<Task>;
  updateTask(id: string, updates: Record<string, unknown>, runContext: RunMutationContext): Promise<Task>;
}

export interface MoveBoardTaskInput {
  taskId: string;
  column: ColumnId;
  preserveProgress?: boolean;
  source?: "user" | "engine" | "scheduler";
}

export interface UpdateBoardTaskInput {
  taskId: string;
  updates: Record<string, unknown>;
}

export function createBoardActionServices(store: BoardActionTaskStore) {
  return {
    moveTask(input: MoveBoardTaskInput): Promise<Task> {
      return store.moveTask(input.taskId, input.column, {
        preserveProgress: input.preserveProgress,
        moveSource: input.source ?? "user",
      }, UNATTRIBUTED_MUTATION_CONTEXT);
    },
    updateTask(input: UpdateBoardTaskInput): Promise<Task> {
      return store.updateTask(input.taskId, input.updates, UNATTRIBUTED_MUTATION_CONTEXT);
    },
  };
}

export type BoardActionServices = ReturnType<typeof createBoardActionServices>;
