import type { Task, TodoItem, TodoList, TodoListWithItems } from "@fusion/core";
export interface Agent { id: string; name: string; role?: string; }
const BASE = "/api/plugins/fusion-plugin-todos";
function query(projectId?: string): string { return projectId ? `?projectId=${encodeURIComponent(projectId)}` : ""; }
async function request<T>(path: string, init?: RequestInit): Promise<T> { const response = await fetch(`${BASE}${path}`, { headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) }, ...init }); if (!response.ok) { const body = await response.json().catch(() => ({})) as { error?: string }; throw new Error(body.error ?? response.statusText); } return response.status === 204 ? undefined as T : response.json() as Promise<T>; }
export const fetchTodoLists = (projectId?: string) => request<TodoListWithItems[]>(`/todos${query(projectId)}`);
export const createTodoList = (title: string, projectId?: string) => request<TodoList>(`/todos${query(projectId)}`, { method: "POST", body: JSON.stringify({ title, projectId }) });
export const updateTodoList = (id: string, title: string, projectId?: string) => request<TodoList>(`/todos/${encodeURIComponent(id)}${query(projectId)}`, { method: "PATCH", body: JSON.stringify({ title, projectId }) });
export const deleteTodoList = (id: string, projectId?: string) => request<void>(`/todos/${encodeURIComponent(id)}${query(projectId)}`, { method: "DELETE" });
export const createTodoItem = (id: string, text: string, projectId?: string) => request<TodoItem>(`/todos/${encodeURIComponent(id)}/items${query(projectId)}`, { method: "POST", body: JSON.stringify({ text, projectId }) });
export const updateTodoItem = (id: string, patch: { text?: string; completed?: boolean }, projectId?: string) => request<TodoItem>(`/todos/items/${encodeURIComponent(id)}${query(projectId)}`, { method: "PATCH", body: JSON.stringify({ ...patch, projectId }) });
export const deleteTodoItem = (id: string, projectId?: string) => request<void>(`/todos/items/${encodeURIComponent(id)}${query(projectId)}`, { method: "DELETE" });
export const reorderTodoItems = (id: string, itemIds: string[], projectId?: string) => request<void>(`/todos/${encodeURIComponent(id)}/items/reorder${query(projectId)}`, { method: "POST", body: JSON.stringify({ itemIds, projectId }) });
export const createTask = (input: unknown, projectId?: string) => request<Task>(`/todos/items/${encodeURIComponent(String((input as { todoItemId?: string }).todoItemId ?? ""))}/create-task${query(projectId)}`, { method: "POST", body: JSON.stringify(input) });
export const fetchAgents = async (_unused?: unknown, projectId?: string): Promise<Agent[]> => request<Agent[]>(`/host/agents${query(projectId)}`);
