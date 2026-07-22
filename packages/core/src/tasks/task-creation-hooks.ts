import type { Task } from "../types.js";
import type { TaskStore } from "../store.js";

export type TaskCreatedHook = (task: Task, store: TaskStore) => Promise<void> | void;

let taskCreatedHook: TaskCreatedHook | undefined;

export function setTaskCreatedHook(fn: TaskCreatedHook | undefined): void {
  taskCreatedHook = fn;
}

export function getTaskCreatedHook(): TaskCreatedHook | undefined {
  return taskCreatedHook;
}
