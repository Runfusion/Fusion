import type { TaskStore } from "@fusion/core";
import { completeColumnsForTask } from "./task-lifecycle-lanes.js";
import { refreshKnowledgeForTask } from "./knowledge-index.js";

/**
 * Task-completion refresh hook for the persistent knowledge index (U14).
 *
 * Listens for `task:moved` and, when a task reaches `done`, incrementally
 * re-indexes just that task as a knowledge page (one upsert, never a full
 * re-index). Mirrors the attach/detach/start/stop lifecycle of
 * `GitHubSourceIssueCloseService` so it can be wired the same way alongside the
 * other `task:moved` listeners. All refresh work is fail-soft (see
 * {@link refreshKnowledgeForTask}) so it can never disrupt task completion.
 */
interface TaskMovedEvent {
  task: { id: string };
  // store's `task:moved` carries `ColumnId`; this handler only literal-compares
  // legacy ids, so the widened string field is safe.
  from: string;
  to: string;
}

export class KnowledgeIndexRefreshService {
  private readonly defaultStore: TaskStore;
  private readonly listeners = new Map<TaskStore, { onTaskMoved: (event: TaskMovedEvent) => void }>();
  private started = false;

  constructor(store: TaskStore) {
    this.defaultStore = store;
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.attach(this.defaultStore);
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;
    for (const store of this.listeners.keys()) {
      this.detach(store);
    }
  }

  attach(store: TaskStore): void {
    if (this.listeners.has(store)) return;
    const onTaskMoved = (event: TaskMovedEvent): void => {
      void this.handleTaskMoved(store, event);
    };
    this.listeners.set(store, { onTaskMoved });
    if (this.started) {
      store.on("task:moved", onTaskMoved);
    }
  }

  detach(store: TaskStore): void {
    const handlers = this.listeners.get(store);
    if (!handlers) return;
    store.off("task:moved", handlers.onTaskMoved);
    this.listeners.delete(store);
  }

  private async handleTaskMoved(store: TaskStore, event: TaskMovedEvent): Promise<void> {
    /*
    FNXC:WorkflowResolvedColumns 2026-07-30-06:05 (batch-core):
    Knowledge is re-indexed when a task COMPLETES. Keyed on the literal, a board that renamed its
    complete lane never refreshed the index for any task, so the knowledge index silently drifted
    further from reality with every finished card and nothing reported it.

    Complete only, not the landed set: archival is a separate event and the original literal never
    fired on it. Widening a role set during a rename is a behaviour change, which this is not.
    */
    if (!(await completeColumnsForTask(store, event.task.id)).has(event.to)) return;
    await refreshKnowledgeForTask(store, event.task.id);
  }
}
