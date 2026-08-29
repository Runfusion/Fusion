import { EventEmitter } from "node:events";
import { expect, vi } from "vitest";
import type { Task, Column, MergeResult, Settings } from "@fusion/core";

/*
FNXC:EngineTests 2026-06-25-17:44:
Shared notifier test harness for the FN-7035 suite split. MockTaskStore, createTask, and flushAsyncWork stay in one helper so notifier.test.ts and notifier.runtime.test.ts can split whole describe blocks under the line-count cap without duplicating event-store behavior.
*/

interface MockTaskStoreEvents {
  "task:moved": [{ task: Task; from: Column; to: Column }];
  "task:updated": [Task];
  "task:merged": [MergeResult];
  "settings:updated": [{ settings: Settings; previous: Settings }];
}

/*
FNXC:EngineTests 2026-07-30-18:40:
DRAIN the fire-and-forget notification work, do not just yield once.

This was `vi.waitFor(() => expect(true).toBe(true))` — a condition that is true on the first tick, so
`waitFor` returned immediately. It never waited for anything; it happened to work only while
`handleTaskMovedAsync` finished within a single turn.

`notification-service` now resolves the task's workflow IR before deciding (lifecycle columns, then
the review-lane set), so the handler needs several more turns after `store.emit(...)` returns. One
yield stopped being enough and 32 cases across notifier.test / notifier.runtime.test failed with
"expected 1 call, got 0" — pointing at the notifier rather than at the harness.

Drains microtasks AND a macrotask turn, repeatedly, so an await chain of any realistic depth settles.
Tests asserting a specific outcome should still prefer `vi.waitFor(() => expect(...))` on that
outcome; this helper exists for the "let the fire-and-forget handler finish" case, and now actually
does it.
*/
export async function flushAsyncWork(): Promise<void> {
  /*
  MICROTASKS ONLY, deliberately. A `setTimeout(0)` drain also works but costs real wall-clock at every
  call site and STALLS under the fake timers several cases in notifier.test install — measured: the
  two files went from ~2s to over 2 minutes and four fake-timer cases hung. The awaits being drained
  are promise-based (workflow-IR resolution), so microtask turns are the right currency and cost
  nothing. See AGENTS.md "Do Not Add Slow Tests".
  */
  for (let turn = 0; turn < 16; turn += 1) await Promise.resolve();
}

export class MockTaskStore extends EventEmitter<MockTaskStoreEvents> {
  private settings: Settings = {
    maxConcurrent: 2,
    maxWorktrees: 4,
    pollIntervalMs: 15000,
    groupOverlappingFiles: false,
    autoMerge: true,
    ntfyEnabled: false,
    ntfyTopic: undefined,
    failureNotificationMode: "all",
    failureNotificationDelayMs: 0,
  };

  getSettings(): Settings {
    return { ...this.settings };
  }

  setSettings(settings: Partial<Settings>): void {
    const previous = { ...this.settings };
    this.settings = { ...this.settings, ...settings };
    this.emit("settings:updated", { settings: this.settings, previous });
  }

  triggerTaskMoved(task: Task, from: Column, to: Column): void {
    this.emit("task:moved", { task, from, to });
  }

  triggerTaskUpdated(task: Task): void {
    this.emit("task:updated", task);
  }

  triggerTaskMerged(result: MergeResult): void {
    this.emit("task:merged", result);
  }
}

export const createTask = (id: string, title?: string, status?: string): Task => ({
  id,
  title,
  description: "Test task",
  column: "in-progress",
  dependencies: [],
  steps: [],
  currentStep: 0,
  status,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  log: [],
});
