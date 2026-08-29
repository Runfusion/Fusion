import type { ColumnId, Task } from "../types.js";

export interface BoardActionTaskStore {
  moveTask(id: string, column: ColumnId, options?: { preserveProgress?: boolean; moveSource?: "user" | "engine" | "scheduler" }): Promise<Task>;
  updateTask(id: string, updates: Record<string, unknown>): Promise<Task>;
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
      });
    },
    updateTask(input: UpdateBoardTaskInput): Promise<Task> {
      return store.updateTask(input.taskId, input.updates);
    },
  };
}

export type BoardActionServices = ReturnType<typeof createBoardActionServices>;
