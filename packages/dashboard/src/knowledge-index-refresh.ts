import type { TaskStore } from "@fusion/core";
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
    if (event.to !== "done") return;
    await refreshKnowledgeForTask(store, event.task.id);
  }
}
