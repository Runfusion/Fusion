/**
 * FNXC:CodeOrganization 2026-07-18-14:00:
 * Todo lists/items client API peeled from legacy.ts.
 */
import type {
  TodoList,
  TodoItem,
  TodoListWithItems,
  TodoListCreateInput,
  TodoListUpdateInput,
  TodoItemCreateInput,
  TodoItemUpdateInput,
} from "@fusion/core";
import { api } from "./client.js";
import { withProjectId } from "./health.js";

// ── Todo API ─────────────────────────────────────────────────────────────────

/** Fetch all todo lists with their items */
export function fetchTodoLists(projectId?: string): Promise<TodoListWithItems[]> {
  return api<TodoListWithItems[]>(withProjectId("/todos", projectId));
}

/** Create a new todo list */
export function createTodoList(title: string, projectId?: string): Promise<TodoList> {
  const input: TodoListCreateInput = { title };
  return api<TodoList>(withProjectId("/todos", projectId), {
    method: "POST",
    body: JSON.stringify(input),
  });
}

/** Update a todo list title */
export function updateTodoList(id: string, title: string, projectId?: string): Promise<TodoList> {
  const updates: TodoListUpdateInput = { title };
  return api<TodoList>(withProjectId(`/todos/${encodeURIComponent(id)}`, projectId), {
    method: "PATCH",
    body: JSON.stringify(updates),
  });
}

/** Delete a todo list and all its items */
export function deleteTodoList(id: string, projectId?: string): Promise<void> {
  return api<void>(withProjectId(`/todos/${encodeURIComponent(id)}`, projectId), {
    method: "DELETE",
  });
}

/** Create a new item in a todo list */
export function createTodoItem(listId: string, text: string, projectId?: string): Promise<TodoItem> {
  const input: TodoItemCreateInput = { text };
  return api<TodoItem>(withProjectId(`/todos/${encodeURIComponent(listId)}/items`, projectId), {
    method: "POST",
    body: JSON.stringify(input),
  });
}

/** Update a todo item (text and/or completed) */
export function updateTodoItem(
  id: string,
  data: { text?: string; completed?: boolean },
  projectId?: string
): Promise<TodoItem> {
  const updates: TodoItemUpdateInput = data;
  return api<TodoItem>(withProjectId(`/todos/items/${encodeURIComponent(id)}`, projectId), {
    method: "PATCH",
    body: JSON.stringify(updates),
  });
}

/** Delete a todo item */
export function deleteTodoItem(id: string, projectId?: string): Promise<void> {
  return api<void>(withProjectId(`/todos/items/${encodeURIComponent(id)}`, projectId), {
    method: "DELETE",
  });
}

/** Reorder items within a todo list */
export function reorderTodoItems(listId: string, itemIds: string[], projectId?: string): Promise<void> {
  return api<void>(withProjectId(`/todos/${encodeURIComponent(listId)}/items/reorder`, projectId), {
    method: "POST",
    body: JSON.stringify({ itemIds }),
  });
}

