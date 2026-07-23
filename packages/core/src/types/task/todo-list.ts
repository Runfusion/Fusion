/**
 * FNXC:CodeOrganization 2026-07-22-14:00:
 * Todo list types peeled from types.ts.
 */

// ── Todo List Types ──────────────────────────────────────────────────────



/** Canonical version for shared-state snapshots exchanged across mesh nodes. */
export const SHARED_STATE_SNAPSHOT_VERSION = 1 as const;

export interface TodoList {
  id: string;
  projectId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}

export interface TodoItem {
  id: string;
  listId: string;
  text: string;
  completed: boolean;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
  sortOrder: number;
}

export interface TodoListCreateInput {
  title: string;
}

export interface TodoListUpdateInput {
  title?: string;
}

export interface TodoItemCreateInput {
  text: string;
  sortOrder?: number;
}

export interface TodoItemUpdateInput {
  text?: string;
  completed?: boolean;
  sortOrder?: number;
}

export interface TodoListWithItems extends TodoList {
  items: TodoItem[];
}

