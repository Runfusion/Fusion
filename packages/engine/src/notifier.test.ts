import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import type { Task, Column, MergeResult, Settings } from "@fusion/core";
import { NtfyNotifier } from "./notifier.js";

// Mock the logger
vi.mock("./logger.js", () => ({
  schedulerLog: { log: vi.fn(), error: vi.fn() },
}));

interface MockTaskStoreEvents {
  "task:moved": [{ task: Task; from: Column; to: Column }];
  "task:updated": [Task];
  "task:merged": [MergeResult];
  "settings:updated": [{ settings: Settings; previous: Settings }];
}

class MockTaskStore extends EventEmitter<MockTaskStoreEvents> {
  private settings: Settings = {
    maxConcurrent: 2,
    maxWorktrees: 4,
    pollIntervalMs: 15000,
    groupOverlappingFiles: false,
    autoMerge: true,
    ntfyEnabled: false,
    ntfyTopic: undefined,
  };

  getSettings(): Settings {
    return { ...this.settings };
  }

  setSettings(settings: Partial<Settings>): void {
    const previous = { ...this.settings };
    this.settings = { ...this.settings, ...settings };
    this.emit("settings:updated", { settings: this.settings, previous });
  }

  // Helper to trigger events
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

describe("NtfyNotifier", () => {
  let store: MockTaskStore;
  let notifier: NtfyNotifier;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    store = new MockTaskStore();
    fetchMock = vi.fn();
    global.fetch = fetchMock;
  });

  afterEach(() => {
    if (notifier) {
      notifier.stop();
    }
    vi.restoreAllMocks();
  });

  const createTask = (id: string, title?: string, status?: string): Task => ({
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

  describe("when disabled", () => {
    it("does not send any notifications when ntfyEnabled is false", async () => {
      store.setSettings({ ntfyEnabled: false, ntfyTopic: "my-topic" });
      notifier = new NtfyNotifier(store);
      await notifier.start();

      store.triggerTaskMoved(createTask("FN-001", "Test Task"), "in-progress", "in-review");

      // Wait for any async operations
      await new Promise(resolve => setTimeout(resolve, 10));

      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("does not send notifications when ntfyTopic is not set", async () => {
      store.setSettings({ ntfyEnabled: true, ntfyTopic: undefined });
      notifier = new NtfyNotifier(store);
      await notifier.start();

      store.triggerTaskMoved(createTask("FN-001", "Test Task"), "in-progress", "in-review");

      await new Promise(resolve => setTimeout(resolve, 10));

      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe("when enabled", () => {
    beforeEach(() => {
      store.setSettings({ ntfyEnabled: true, ntfyTopic: "test-topic" });
      fetchMock.mockResolvedValue({ ok: true });
    });

    it("sends notification when task moves to in-review", async () => {
      notifier = new NtfyNotifier(store);
      await notifier.start();

      store.triggerTaskMoved(createTask("FN-001", "Test Task"), "in-progress", "in-review");

      await new Promise(resolve => setTimeout(resolve, 10));

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock).toHaveBeenCalledWith(
        "https://ntfy.sh/test-topic",
        expect.objectContaining({
          method: "POST",
          headers: expect.objectContaining({
            "Title": "Task FN-001 completed",
            "Priority": "default",
          }),
          body: 'Task "Test Task" is ready for review',
        })
      );
    });

    it("does not send notification when task moves to done (merged notification comes from task:merged)", async () => {
      notifier = new NtfyNotifier(store);
      await notifier.start();

      store.triggerTaskMoved(createTask("FN-001", "Test Task"), "in-review", "done");

      await new Promise(resolve => setTimeout(resolve, 10));

      // handleTaskMoved should NOT send notification for "done" - that's handleTaskMerged's job
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("sends high priority notification when task fails", async () => {
      notifier = new NtfyNotifier(store);
      await notifier.start();

      const failedTask = createTask("FN-001", "Test Task", "failed");
      store.triggerTaskUpdated(failedTask);

      await new Promise(resolve => setTimeout(resolve, 10));

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock).toHaveBeenCalledWith(
        "https://ntfy.sh/test-topic",
        expect.objectContaining({
          method: "POST",
          headers: expect.objectContaining({
            "Title": "Task FN-001 failed",
            "Priority": "high",
          }),
          body: 'Task "Test Task" has failed and needs attention',
        })
      );
    });

    it("sends notification when task is merged", async () => {
      notifier = new NtfyNotifier(store);
      await notifier.start();

      const mergeResult: MergeResult = {
        task: createTask("FN-001", "Test Task"),
        branch: "fusion/fn-001",
        merged: true,
        worktreeRemoved: true,
        branchDeleted: true,
      };
      store.triggerTaskMerged(mergeResult);

      await new Promise(resolve => setTimeout(resolve, 10));

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock).toHaveBeenCalledWith(
        "https://ntfy.sh/test-topic",
        expect.objectContaining({
          method: "POST",
          headers: expect.objectContaining({
            "Title": "Task FN-001 merged",
            "Priority": "default",
          }),
          body: 'Task "Test Task" has been merged to main',
        })
      );
    });

    it("does not send notification for failed merges", async () => {
      notifier = new NtfyNotifier(store);
      await notifier.start();

      const mergeResult: MergeResult = {
        task: createTask("FN-001", "Test Task"),
        branch: "fusion/fn-001",
        merged: false,
        worktreeRemoved: false,
        branchDeleted: false,
        error: "Merge conflict",
      };
      store.triggerTaskMerged(mergeResult);

      await new Promise(resolve => setTimeout(resolve, 10));

      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("uses task ID and description when title is not available", async () => {
      notifier = new NtfyNotifier(store);
      await notifier.start();

      const taskWithoutTitle = { ...createTask("FN-001"), description: "Implement user authentication flow" };
      store.triggerTaskMoved(taskWithoutTitle, "in-progress", "in-review");

      await new Promise(resolve => setTimeout(resolve, 10));

      expect(fetchMock).toHaveBeenCalledWith(
        "https://ntfy.sh/test-topic",
        expect.objectContaining({
          body: 'Task "FN-001: Implement user authentication flow" is ready for review',
        })
      );
    });

    it("truncates description to 200 characters when no title is set", async () => {
      notifier = new NtfyNotifier(store);
      await notifier.start();

      const longDescription = "A".repeat(250);
      const taskWithoutTitle = { ...createTask("FN-001"), description: longDescription };
      store.triggerTaskMoved(taskWithoutTitle, "in-progress", "in-review");

      await new Promise(resolve => setTimeout(resolve, 10));

      const expectedSnippet = "A".repeat(200) + "...";
      expect(fetchMock).toHaveBeenCalledWith(
        "https://ntfy.sh/test-topic",
        expect.objectContaining({
          body: `Task "FN-001: ${expectedSnippet}" is ready for review`,
        })
      );
    });

    it("does not truncate description at exactly 200 characters", async () => {
      notifier = new NtfyNotifier(store);
      await notifier.start();

      const exactDescription = "B".repeat(200);
      const taskWithoutTitle = { ...createTask("FN-001"), description: exactDescription };
      store.triggerTaskMoved(taskWithoutTitle, "in-progress", "in-review");

      await new Promise(resolve => setTimeout(resolve, 10));

      expect(fetchMock).toHaveBeenCalledWith(
        "https://ntfy.sh/test-topic",
        expect.objectContaining({
          body: `Task "FN-001: ${exactDescription}" is ready for review`,
        })
      );
    });
  });

  describe("runtime reconfiguration", () => {
    it("starts sending notifications when enabled at runtime", async () => {
      store.setSettings({ ntfyEnabled: false, ntfyTopic: "test-topic" });
      notifier = new NtfyNotifier(store);
      await notifier.start();

      // Initially disabled
      store.triggerTaskMoved(createTask("FN-001", "Test Task"), "in-progress", "in-review");
      await new Promise(resolve => setTimeout(resolve, 10));
      expect(fetchMock).not.toHaveBeenCalled();

      // Enable at runtime
      fetchMock.mockResolvedValue({ ok: true });
      store.setSettings({ ntfyEnabled: true });

      store.triggerTaskMoved(createTask("FN-002", "Test Task 2"), "in-progress", "in-review");
      await new Promise(resolve => setTimeout(resolve, 10));
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("stops sending notifications when disabled at runtime", async () => {
      store.setSettings({ ntfyEnabled: true, ntfyTopic: "test-topic" });
      fetchMock.mockResolvedValue({ ok: true });
      notifier = new NtfyNotifier(store);
      await notifier.start();

      // Initially enabled
      store.triggerTaskMoved(createTask("FN-001", "Test Task"), "in-progress", "in-review");
      await new Promise(resolve => setTimeout(resolve, 10));
      expect(fetchMock).toHaveBeenCalledTimes(1);

      // Disable at runtime
      store.setSettings({ ntfyEnabled: false });

      store.triggerTaskMoved(createTask("FN-002", "Test Task 2"), "in-progress", "in-review");
      await new Promise(resolve => setTimeout(resolve, 10));
      expect(fetchMock).toHaveBeenCalledTimes(1); // No new calls
    });

    it("uses updated topic when changed at runtime", async () => {
      store.setSettings({ ntfyEnabled: true, ntfyTopic: "old-topic" });
      fetchMock.mockResolvedValue({ ok: true });
      notifier = new NtfyNotifier(store);
      await notifier.start();

      store.triggerTaskMoved(createTask("FN-001", "Test Task"), "in-progress", "in-review");
      await new Promise(resolve => setTimeout(resolve, 10));
      expect(fetchMock).toHaveBeenCalledWith("https://ntfy.sh/old-topic", expect.any(Object));

      // Change topic
      store.setSettings({ ntfyTopic: "new-topic" });

      store.triggerTaskMoved(createTask("FN-002", "Test Task 2"), "in-progress", "in-review");
      await new Promise(resolve => setTimeout(resolve, 10));
      expect(fetchMock).toHaveBeenLastCalledWith("https://ntfy.sh/new-topic", expect.any(Object));
    });
  });

  describe("error handling", () => {
    it("catches and logs fetch errors without throwing", async () => {
      store.setSettings({ ntfyEnabled: true, ntfyTopic: "test-topic" });
      fetchMock.mockRejectedValue(new Error("Network error"));

      notifier = new NtfyNotifier(store);
      await notifier.start();

      // Should not throw
      store.triggerTaskMoved(createTask("FN-001", "Test Task"), "in-progress", "in-review");
      await new Promise(resolve => setTimeout(resolve, 10));

      expect(fetchMock).toHaveBeenCalled();
    });

    it("handles HTTP error responses without throwing", async () => {
      store.setSettings({ ntfyEnabled: true, ntfyTopic: "test-topic" });
      fetchMock.mockResolvedValue({ ok: false, status: 500, statusText: "Server Error" });

      notifier = new NtfyNotifier(store);
      await notifier.start();

      // Should not throw
      store.triggerTaskMoved(createTask("FN-001", "Test Task"), "in-progress", "in-review");
      await new Promise(resolve => setTimeout(resolve, 10));

      expect(fetchMock).toHaveBeenCalled();
    });
  });

  describe("deduplication", () => {
    beforeEach(() => {
      store.setSettings({ ntfyEnabled: true, ntfyTopic: "test-topic" });
      fetchMock.mockResolvedValue({ ok: true });
    });

    it("prevents duplicate notifications for the same event type", async () => {
      notifier = new NtfyNotifier(store);
      await notifier.start();

      const task = createTask("FN-001", "Test Task");

      // Multiple in-review events for the same task
      store.triggerTaskMoved(task, "in-progress", "in-review");
      store.triggerTaskMoved(task, "in-progress", "in-review");
      store.triggerTaskMoved(task, "in-progress", "in-review");

      await new Promise(resolve => setTimeout(resolve, 10));

      // Should only send one notification due to deduplication
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("allows different event types for the same task", async () => {
      notifier = new NtfyNotifier(store);
      await notifier.start();

      const task = createTask("FN-001", "Test Task");

      // First: in-review notification
      store.triggerTaskMoved(task, "in-progress", "in-review");
      await new Promise(resolve => setTimeout(resolve, 10));
      expect(fetchMock).toHaveBeenCalledTimes(1);

      // Second: merged notification (different event type - should be allowed)
      const mergeResult: MergeResult = {
        task,
        branch: "fusion/fn-001",
        merged: true,
        worktreeRemoved: true,
        branchDeleted: true,
      };
      store.triggerTaskMerged(mergeResult);
      await new Promise(resolve => setTimeout(resolve, 10));

      // Should have two notifications now
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("sends notification only once on merge when task:moved and task:merged both fire", async () => {
      notifier = new NtfyNotifier(store);
      await notifier.start();

      const task = createTask("FN-001", "Test Task");
      const mergeResult: MergeResult = {
        task,
        branch: "fusion/fn-001",
        merged: true,
        worktreeRemoved: true,
        branchDeleted: true,
      };

      // completeTask() emits task:moved to done before task:merged
      store.triggerTaskMoved(task, "in-review", "done");
      store.triggerTaskMerged(mergeResult);

      await new Promise(resolve => setTimeout(resolve, 10));

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock).toHaveBeenCalledWith(
        "https://ntfy.sh/test-topic",
        expect.objectContaining({
          method: "POST",
          headers: expect.objectContaining({
            "Title": "Task FN-001 merged",
            "Priority": "default",
          }),
          body: 'Task "Test Task" has been merged to main',
        })
      );
    });

    it("prevents duplicate task:merged events for the same task", async () => {
      notifier = new NtfyNotifier(store);
      await notifier.start();

      const task = createTask("FN-001", "Test Task");
      const mergeResult: MergeResult = {
        task,
        branch: "fusion/fn-001",
        merged: true,
        worktreeRemoved: true,
        branchDeleted: true,
      };

      // Multiple merged events for the same task
      store.triggerTaskMerged(mergeResult);
      store.triggerTaskMerged(mergeResult);
      store.triggerTaskMerged(mergeResult);

      await new Promise(resolve => setTimeout(resolve, 10));

      // Should only send one notification
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("allows notifications for different tasks independently", async () => {
      notifier = new NtfyNotifier(store);
      await notifier.start();

      const task1 = createTask("FN-001", "Test Task 1");
      const task2 = createTask("FN-002", "Test Task 2");

      store.triggerTaskMoved(task1, "in-progress", "in-review");
      store.triggerTaskMoved(task2, "in-progress", "in-review");

      await new Promise(resolve => setTimeout(resolve, 10));

      // Different tasks should each get their own notification
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
  });

  describe("custom base URL", () => {
    it("uses custom ntfy base URL when provided", async () => {
      store.setSettings({ ntfyEnabled: true, ntfyTopic: "test-topic" });
      fetchMock.mockResolvedValue({ ok: true });

      notifier = new NtfyNotifier(store, { ntfyBaseUrl: "https://my-ntfy.example.com" });
      await notifier.start();

      store.triggerTaskMoved(createTask("FN-001", "Test Task"), "in-progress", "in-review");

      await new Promise(resolve => setTimeout(resolve, 10));

      expect(fetchMock).toHaveBeenCalledWith(
        "https://my-ntfy.example.com/test-topic",
        expect.any(Object)
      );
    });
  });

  describe("stop()", () => {
    it("stops listening to events after stop() is called", async () => {
      store.setSettings({ ntfyEnabled: true, ntfyTopic: "test-topic" });
      fetchMock.mockResolvedValue({ ok: true });

      notifier = new NtfyNotifier(store);
      await notifier.start();

      store.triggerTaskMoved(createTask("FN-001", "Test Task"), "in-progress", "in-review");
      await new Promise(resolve => setTimeout(resolve, 10));
      expect(fetchMock).toHaveBeenCalledTimes(1);

      notifier.stop();

      store.triggerTaskMoved(createTask("FN-002", "Test Task 2"), "in-progress", "in-review");
      await new Promise(resolve => setTimeout(resolve, 10));

      // Should not increase after stop
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });

  describe("edge cases", () => {
    it("allows in-review and failed notifications for the same task", async () => {
      store.setSettings({ ntfyEnabled: true, ntfyTopic: "test-topic" });
      fetchMock.mockResolvedValue({ ok: true });
      notifier = new NtfyNotifier(store);
      await notifier.start();

      const task = createTask("FN-001", "Test Task");

      // First: in-review notification
      store.triggerTaskMoved(task, "in-progress", "in-review");
      await new Promise(resolve => setTimeout(resolve, 10));
      expect(fetchMock).toHaveBeenCalledTimes(1);

      // Second: failed notification (different event type - should be allowed)
      const failedTask = { ...task, status: "failed" };
      store.triggerTaskUpdated(failedTask);
      await new Promise(resolve => setTimeout(resolve, 10));

      // Should have two notifications
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("does not notify on task:moved to columns other than in-review", async () => {
      store.setSettings({ ntfyEnabled: true, ntfyTopic: "test-topic" });
      fetchMock.mockResolvedValue({ ok: true });
      notifier = new NtfyNotifier(store);
      await notifier.start();

      // Move to todo - should not notify
      store.triggerTaskMoved(createTask("FN-001", "Test Task"), "triage", "todo");
      await new Promise(resolve => setTimeout(resolve, 10));

      // Move to in-progress - should not notify
      store.triggerTaskMoved(createTask("FN-002", "Test Task 2"), "todo", "in-progress");
      await new Promise(resolve => setTimeout(resolve, 10));

      // Move to done - should not notify (merged notification comes from task:merged)
      store.triggerTaskMoved(createTask("FN-003", "Test Task 3"), "in-review", "done");
      await new Promise(resolve => setTimeout(resolve, 10));

      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("does not notify on task:updated when status is not failed", async () => {
      store.setSettings({ ntfyEnabled: true, ntfyTopic: "test-topic" });
      fetchMock.mockResolvedValue({ ok: true });
      notifier = new NtfyNotifier(store);
      await notifier.start();

      const task = createTask("FN-001", "Test Task", "in-progress");
      store.triggerTaskUpdated(task);
      await new Promise(resolve => setTimeout(resolve, 10));

      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("handles empty topic gracefully", async () => {
      store.setSettings({ ntfyEnabled: true, ntfyTopic: "" });
      fetchMock.mockResolvedValue({ ok: true });
      notifier = new NtfyNotifier(store);
      await notifier.start();

      store.triggerTaskMoved(createTask("FN-001", "Test Task"), "in-progress", "in-review");
      await new Promise(resolve => setTimeout(resolve, 10));

      // Empty topic should be treated as no topic
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });
});
