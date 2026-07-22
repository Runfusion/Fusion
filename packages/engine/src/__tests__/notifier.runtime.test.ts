/*
FNXC:EngineTests 2026-06-25-17:44:
Notifier runtime suite split extracts the later NtfyNotifier reconfiguration, error, deduplication, runtime wiring, URL, stop, edge-case, and event-filtering describe blocks from notifier.test.ts so both sibling suites stay under MAX_LINES without weakening assertions.
*/

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { MergeResult } from "@fusion/core";
import { NtfyNotifier, notifyFallbackUsed } from "../util/notifier.js";
import { NotificationService } from "../notification/notification-service.js";
import { MockTaskStore, createTask, flushAsyncWork } from "./notifier.test-harness.js";

vi.mock("../logger.js", () => ({
  schedulerLog: { log: vi.fn(), error: vi.fn() },
}));

describe("NtfyNotifier runtime behaviors", () => {
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

  describe("runtime reconfiguration", () => {
    it("starts sending notifications when enabled at runtime", async () => {
      store.setSettings({ ntfyEnabled: false, ntfyTopic: "test-topic" });
      notifier = new NtfyNotifier(store);
      await notifier.start();

      // Initially disabled
      store.triggerTaskMoved(createTask("FN-001", "Test Task"), "in-progress", "in-review");
      await flushAsyncWork();
      expect(fetchMock).not.toHaveBeenCalled();

      // Enable at runtime
      fetchMock.mockResolvedValue({ ok: true });
      store.setSettings({ ntfyEnabled: true });

      store.triggerTaskMoved(createTask("FN-002", "Test Task 2"), "in-progress", "in-review");
      await flushAsyncWork();
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("stops sending notifications when disabled at runtime", async () => {
      store.setSettings({ ntfyEnabled: true, ntfyTopic: "test-topic" });
      fetchMock.mockResolvedValue({ ok: true });
      notifier = new NtfyNotifier(store);
      await notifier.start();

      // Initially enabled
      store.triggerTaskMoved(createTask("FN-001", "Test Task"), "in-progress", "in-review");
      await flushAsyncWork();
      expect(fetchMock).toHaveBeenCalledTimes(1);

      // Disable at runtime
      store.setSettings({ ntfyEnabled: false });

      store.triggerTaskMoved(createTask("FN-002", "Test Task 2"), "in-progress", "in-review");
      await flushAsyncWork();
      expect(fetchMock).toHaveBeenCalledTimes(1); // No new calls
    });

    it("uses updated topic when changed at runtime", async () => {
      store.setSettings({ ntfyEnabled: true, ntfyTopic: "old-topic" });
      fetchMock.mockResolvedValue({ ok: true });
      notifier = new NtfyNotifier(store);
      await notifier.start();

      store.triggerTaskMoved(createTask("FN-001", "Test Task"), "in-progress", "in-review");
      await flushAsyncWork();
      expect(fetchMock).toHaveBeenCalledWith("https://ntfy.sh/old-topic", expect.any(Object));

      // Change topic
      store.setSettings({ ntfyTopic: "new-topic" });

      store.triggerTaskMoved(createTask("FN-002", "Test Task 2"), "in-progress", "in-review");
      await flushAsyncWork();
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
      await flushAsyncWork();

      expect(fetchMock).toHaveBeenCalled();
    });

    it("handles HTTP error responses without throwing", async () => {
      store.setSettings({ ntfyEnabled: true, ntfyTopic: "test-topic" });
      fetchMock.mockResolvedValue({ ok: false, status: 500, statusText: "Server Error" });

      notifier = new NtfyNotifier(store);
      await notifier.start();

      // Should not throw
      store.triggerTaskMoved(createTask("FN-001", "Test Task"), "in-progress", "in-review");
      await flushAsyncWork();

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

      await flushAsyncWork();

      // Should only send one notification due to deduplication
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("prevents duplicate awaiting-approval notifications for the same task", async () => {
      notifier = new NtfyNotifier(store);
      await notifier.start();

      const task = createTask("FN-004", "Approval Task", "awaiting-approval");

      store.triggerTaskUpdated(task);
      store.triggerTaskUpdated(task);
      store.triggerTaskUpdated(task);

      await flushAsyncWork();

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock).toHaveBeenCalledWith(
        "https://ntfy.sh/test-topic",
        expect.objectContaining({
          headers: expect.objectContaining({
            "Title": "Plan needs approval for FN-004",
          }),
        }),
      );
    });

    it("prevents duplicate awaiting-user-review notifications for the same task", async () => {
      notifier = new NtfyNotifier(store);
      await notifier.start();

      const task = createTask("FN-005", "User Review Task", "awaiting-user-review");

      store.triggerTaskUpdated(task);
      store.triggerTaskUpdated(task);
      store.triggerTaskUpdated(task);

      await flushAsyncWork();

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock).toHaveBeenCalledWith(
        "https://ntfy.sh/test-topic",
        expect.objectContaining({
          headers: expect.objectContaining({
            "Title": "User review needed for FN-005",
          }),
        }),
      );
    });

    it("allows different event types for the same task", async () => {
      notifier = new NtfyNotifier(store);
      await notifier.start();

      const task = createTask("FN-001", "Test Task");

      // First: in-review notification
      store.triggerTaskMoved(task, "in-progress", "in-review");
      await flushAsyncWork();
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
      await flushAsyncWork();

      // Should have two notifications now
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("allows awaiting-approval alongside other event types for the same task", async () => {
      notifier = new NtfyNotifier(store);
      await notifier.start();

      const task = createTask("FN-005", "Approval + Failure");

      store.triggerTaskUpdated({ ...task, status: "awaiting-approval" });
      await flushAsyncWork();
      expect(fetchMock).toHaveBeenCalledTimes(1);

      store.triggerTaskUpdated({ ...task, status: "failed" });
      await flushAsyncWork();
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

      await flushAsyncWork();

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

      await flushAsyncWork();

      // Should only send one notification
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("emits a single merged notification when notifier shares the same already-started NotificationService (ProjectEngine wiring)", async () => {
      const sharedService = new NotificationService(store, { projectId: "proj-1" });
      await sharedService.start();

      notifier = new NtfyNotifier(store, { projectId: "proj-1" }, sharedService);
      await notifier.start();

      const task = createTask("FN-777", "Single Merge Notification");
      const mergeResult: MergeResult = {
        task,
        branch: "fusion/fn-777",
        merged: true,
        worktreeRemoved: true,
        branchDeleted: true,
      };

      store.triggerTaskMerged(mergeResult);
      await flushAsyncWork();

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock).toHaveBeenCalledWith(
        "https://ntfy.sh/test-topic",
        expect.objectContaining({
          headers: expect.objectContaining({
            Title: "Task FN-777 merged",
          }),
        }),
      );

      await sharedService.stop();
    });

    it("dispatches and deduplicates fallback-used notifications", async () => {
      notifier = new NtfyNotifier(store);
      await notifier.start();

      await notifyFallbackUsed({
        primaryModel: "anthropic/claude-sonnet-4-5",
        fallbackModel: "openai/gpt-4o",
        triggerPoint: "session-creation",
        taskId: "FN-900",
        taskTitle: "Fallback task",
      });
      await notifyFallbackUsed({
        primaryModel: "anthropic/claude-sonnet-4-5",
        fallbackModel: "openai/gpt-4o",
        triggerPoint: "session-creation",
        taskId: "FN-900",
        taskTitle: "Fallback task",
      });
      await flushAsyncWork();

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock).toHaveBeenCalledWith(
        "https://ntfy.sh/test-topic",
        expect.objectContaining({
          body: expect.stringContaining("switched from anthropic/claude-sonnet-4-5 to openai/gpt-4o"),
        }),
      );
    });

    it("allows notifications for different tasks independently", async () => {
      notifier = new NtfyNotifier(store);
      await notifier.start();

      const task1 = createTask("FN-001", "Test Task 1");
      const task2 = createTask("FN-002", "Test Task 2");

      store.triggerTaskMoved(task1, "in-progress", "in-review");
      store.triggerTaskMoved(task2, "in-progress", "in-review");

      await flushAsyncWork();

      // Different tasks should each get their own notification
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
  });

  describe("dashboard runtime wiring", () => {
    /**
     * These tests simulate the pattern used in packages/cli/src/commands/dashboard.ts
     * where the NtfyNotifier is constructed with an optional projectId resolved
     * from the central project registry. When a registered project is found,
     * deep links include ?project=...&task=...; when no project is registered
     * (legacy / single-project mode), links fall back to ?task=... only.
     */
    beforeEach(() => {
      fetchMock.mockResolvedValue({ ok: true });
    });

    it("produces project-aware deep links when constructed with registered project ID", async () => {
      store.setSettings({
        ntfyEnabled: true,
        ntfyTopic: "test-topic",
        ntfyDashboardHost: "http://localhost:3000",
      });

      // Simulates: const notifier = new NtfyNotifier(store, { projectId: registered.id });
      notifier = new NtfyNotifier(store, { projectId: "proj_abc123" });
      await notifier.start();

      store.triggerTaskMoved(createTask("FN-001", "Test Task"), "in-progress", "in-review");
      await flushAsyncWork();

      expect(fetchMock).toHaveBeenCalledWith(
        "https://ntfy.sh/test-topic",
        expect.objectContaining({
          headers: expect.objectContaining({
            "Click": "http://localhost:3000/?project=proj_abc123&task=FN-001",
          }),
        }),
      );
    });

    it("produces task-only deep links when no project ID is available (legacy mode)", async () => {
      store.setSettings({
        ntfyEnabled: true,
        ntfyTopic: "test-topic",
        ntfyDashboardHost: "http://localhost:3000",
      });

      // Simulates: const notifier = new NtfyNotifier(store); // no projectId
      notifier = new NtfyNotifier(store);
      await notifier.start();

      store.triggerTaskMoved(createTask("FN-001", "Test Task"), "in-progress", "in-review");
      await flushAsyncWork();

      expect(fetchMock).toHaveBeenCalledWith(
        "https://ntfy.sh/test-topic",
        expect.objectContaining({
          headers: expect.objectContaining({
            "Click": "http://localhost:3000/?task=FN-001",
          }),
        }),
      );
      // Verify no "project=" in the URL
      const callArgs = fetchMock.mock.calls[0][1] as { headers: Record<string, string> };
      expect(callArgs.headers["Click"]).not.toContain("project=");
    });

    it("produces project-aware deep links for all notification event types", async () => {
      store.setSettings({
        ntfyEnabled: true,
        ntfyTopic: "test-topic",
        ntfyDashboardHost: "https://fusion.example.com",
      });

      notifier = new NtfyNotifier(store, { projectId: "proj_xyz" });
      await notifier.start();

      // in-review event
      store.triggerTaskMoved(createTask("FN-001", "Task A"), "in-progress", "in-review");
      await flushAsyncWork();

      // merged event
      const mergeResult: MergeResult = {
        task: createTask("FN-001", "Task A"),
        branch: "fusion/fn-001",
        merged: true,
        worktreeRemoved: true,
        branchDeleted: true,
      };
      store.triggerTaskMerged(mergeResult);
      await flushAsyncWork();

      // Verify both calls include project
      const calls = fetchMock.mock.calls;
      for (const call of calls) {
        const headers = call[1].headers as Record<string, string>;
        expect(headers["Click"]).toContain("project=proj_xyz");
      }
    });
  });

  describe("custom base URL", () => {
    it("uses custom ntfy base URL when provided in notifier options", async () => {
      store.setSettings({ ntfyEnabled: true, ntfyTopic: "test-topic" });
      fetchMock.mockResolvedValue({ ok: true });

      notifier = new NtfyNotifier(store, { ntfyBaseUrl: "https://my-ntfy.example.com" });
      await notifier.start();

      store.triggerTaskMoved(createTask("FN-001", "Test Task"), "in-progress", "in-review");

      await flushAsyncWork();

      expect(fetchMock).toHaveBeenCalledWith(
        "https://my-ntfy.example.com/test-topic",
        expect.any(Object)
      );
    });

    it("uses ntfyBaseUrl from settings when configured", async () => {
      store.setSettings({
        ntfyEnabled: true,
        ntfyTopic: "test-topic",
        ntfyBaseUrl: "https://ntfy.internal.example///",
      });
      fetchMock.mockResolvedValue({ ok: true });

      notifier = new NtfyNotifier(store);
      await notifier.start();

      store.triggerTaskMoved(createTask("FN-101", "Configured URL Task"), "in-progress", "in-review");
      await flushAsyncWork();

      expect(fetchMock).toHaveBeenCalledWith(
        "https://ntfy.internal.example/test-topic",
        expect.any(Object),
      );
    });

    it("falls back to default ntfy.sh when settings ntfyBaseUrl is blank", async () => {
      store.setSettings({
        ntfyEnabled: true,
        ntfyTopic: "test-topic",
        ntfyBaseUrl: "   ",
      });
      fetchMock.mockResolvedValue({ ok: true });

      notifier = new NtfyNotifier(store);
      await notifier.start();

      store.triggerTaskMoved(createTask("FN-102", "Blank URL Task"), "in-progress", "in-review");
      await flushAsyncWork();

      expect(fetchMock).toHaveBeenCalledWith(
        "https://ntfy.sh/test-topic",
        expect.any(Object),
      );
    });

    it("applies updated ntfyBaseUrl from settings changes at runtime", async () => {
      store.setSettings({ ntfyEnabled: true, ntfyTopic: "test-topic" });
      fetchMock.mockResolvedValue({ ok: true });

      notifier = new NtfyNotifier(store);
      await notifier.start();

      store.triggerTaskMoved(createTask("FN-103", "Before Update"), "in-progress", "in-review");
      await flushAsyncWork();
      expect(fetchMock).toHaveBeenLastCalledWith("https://ntfy.sh/test-topic", expect.any(Object));

      store.setSettings({ ntfyBaseUrl: "https://ntfy.changed.example" });
      store.triggerTaskMoved(createTask("FN-104", "After Update"), "in-progress", "in-review");
      await flushAsyncWork();

      expect(fetchMock).toHaveBeenLastCalledWith(
        "https://ntfy.changed.example/test-topic",
        expect.any(Object),
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
      await flushAsyncWork();
      expect(fetchMock).toHaveBeenCalledTimes(1);

      notifier.stop();

      store.triggerTaskMoved(createTask("FN-002", "Test Task 2"), "in-progress", "in-review");
      await flushAsyncWork();

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
      await flushAsyncWork();
      expect(fetchMock).toHaveBeenCalledTimes(1);

      // Second: failed notification (different event type - should be allowed)
      const failedTask = { ...task, status: "failed" };
      store.triggerTaskUpdated(failedTask);
      await flushAsyncWork();

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
      await flushAsyncWork();

      // Move to in-progress - should not notify
      store.triggerTaskMoved(createTask("FN-002", "Test Task 2"), "todo", "in-progress");
      await flushAsyncWork();

      // Move to done - should not notify (merged notification comes from task:merged)
      store.triggerTaskMoved(createTask("FN-003", "Test Task 3"), "in-review", "done");
      await flushAsyncWork();

      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("does not notify on task:updated when status is neither failed nor awaiting-approval", async () => {
      store.setSettings({ ntfyEnabled: true, ntfyTopic: "test-topic" });
      fetchMock.mockResolvedValue({ ok: true });
      notifier = new NtfyNotifier(store);
      await notifier.start();

      const task = createTask("FN-001", "Test Task", "in-progress");
      store.triggerTaskUpdated(task);
      await flushAsyncWork();

      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("handles empty topic gracefully", async () => {
      store.setSettings({ ntfyEnabled: true, ntfyTopic: "" });
      fetchMock.mockResolvedValue({ ok: true });
      notifier = new NtfyNotifier(store);
      await notifier.start();

      store.triggerTaskMoved(createTask("FN-001", "Test Task"), "in-progress", "in-review");
      await flushAsyncWork();

      // Empty topic should be treated as no topic
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe("event filtering", () => {
    beforeEach(() => {
      store.setSettings({ ntfyEnabled: true, ntfyTopic: "test-topic" });
      fetchMock.mockResolvedValue({ ok: true });
    });

    it("does not send in-review notification when 'in-review' is not in ntfyEvents", async () => {
      store.setSettings({ ntfyEnabled: true, ntfyTopic: "test-topic", ntfyEvents: ["merged", "failed", "awaiting-approval"] });
      notifier = new NtfyNotifier(store);
      await notifier.start();

      store.triggerTaskMoved(createTask("FN-001", "Test Task"), "in-progress", "in-review");
      await flushAsyncWork();

      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("does not send merged notification when 'merged' is not in ntfyEvents", async () => {
      store.setSettings({ ntfyEnabled: true, ntfyTopic: "test-topic", ntfyEvents: ["in-review", "failed", "awaiting-approval"] });
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
      await flushAsyncWork();

      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("does not send failed notification when 'failed' is not in ntfyEvents", async () => {
      store.setSettings({ ntfyEnabled: true, ntfyTopic: "test-topic", ntfyEvents: ["in-review", "merged", "awaiting-approval"] });
      notifier = new NtfyNotifier(store);
      await notifier.start();

      const failedTask = createTask("FN-001", "Test Task", "failed");
      store.triggerTaskUpdated(failedTask);
      await flushAsyncWork();

      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("does not send awaiting-approval notification when 'awaiting-approval' is not in ntfyEvents", async () => {
      store.setSettings({ ntfyEnabled: true, ntfyTopic: "test-topic", ntfyEvents: ["in-review", "merged", "failed"] });
      notifier = new NtfyNotifier(store);
      await notifier.start();

      const awaitingApprovalTask = createTask("FN-006", "Approval Task", "awaiting-approval");
      store.triggerTaskUpdated(awaitingApprovalTask);
      await flushAsyncWork();

      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("does not send awaiting-user-review notification when 'awaiting-user-review' is not in ntfyEvents", async () => {
      store.setSettings({ ntfyEnabled: true, ntfyTopic: "test-topic", ntfyEvents: ["in-review", "merged", "failed", "awaiting-approval"] });
      notifier = new NtfyNotifier(store);
      await notifier.start();

      const awaitingUserReviewTask = createTask("FN-007", "User Review Task", "awaiting-user-review");
      store.triggerTaskUpdated(awaitingUserReviewTask);
      await flushAsyncWork();

      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("sends notification for enabled events while others are disabled", async () => {
      store.setSettings({ ntfyEnabled: true, ntfyTopic: "test-topic", ntfyEvents: ["in-review"] });
      notifier = new NtfyNotifier(store);
      await notifier.start();

      // in-review - should send
      store.triggerTaskMoved(createTask("FN-001", "Test Task"), "in-progress", "in-review");
      await flushAsyncWork();
      expect(fetchMock).toHaveBeenCalledTimes(1);

      // merged - should NOT send
      const mergeResult: MergeResult = {
        task: createTask("FN-002", "Test Task 2"),
        branch: "fusion/fn-002",
        merged: true,
        worktreeRemoved: true,
        branchDeleted: true,
      };
      store.triggerTaskMerged(mergeResult);
      await flushAsyncWork();
      expect(fetchMock).toHaveBeenCalledTimes(1); // Still 1, no new call

      // failed - should NOT send
      const failedTask = createTask("FN-003", "Test Task 3", "failed");
      store.triggerTaskUpdated(failedTask);
      await flushAsyncWork();
      expect(fetchMock).toHaveBeenCalledTimes(1); // Still 1, no new call

      // awaiting-approval - should NOT send
      const awaitingApprovalTask = createTask("FN-004", "Test Task 4", "awaiting-approval");
      store.triggerTaskUpdated(awaitingApprovalTask);
      await flushAsyncWork();
      expect(fetchMock).toHaveBeenCalledTimes(1); // Still 1, no new call

      // awaiting-user-review - should NOT send
      const awaitingUserReviewTask = createTask("FN-005", "Test Task 5", "awaiting-user-review");
      store.triggerTaskUpdated(awaitingUserReviewTask);
      await flushAsyncWork();
      expect(fetchMock).toHaveBeenCalledTimes(1); // Still 1, no new call
    });

    it("defaults to all events when ntfyEvents is undefined", async () => {
      store.setSettings({ ntfyEnabled: true, ntfyTopic: "test-topic", ntfyEvents: undefined });
      notifier = new NtfyNotifier(store);
      await notifier.start();

      store.triggerTaskMoved(createTask("FN-001", "Test Task"), "in-progress", "in-review");
      await flushAsyncWork();
      expect(fetchMock).toHaveBeenCalledTimes(1);

      const mergeResult: MergeResult = {
        task: createTask("FN-002", "Test Task 2"),
        branch: "fusion/fn-002",
        merged: true,
        worktreeRemoved: true,
        branchDeleted: true,
      };
      store.triggerTaskMerged(mergeResult);
      await flushAsyncWork();
      expect(fetchMock).toHaveBeenCalledTimes(2);

      const failedTask = createTask("FN-003", "Test Task 3", "failed");
      store.triggerTaskUpdated(failedTask);
      await flushAsyncWork();
      expect(fetchMock).toHaveBeenCalledTimes(3);

      const awaitingApprovalTask = createTask("FN-004", "Test Task 4", "awaiting-approval");
      store.triggerTaskUpdated(awaitingApprovalTask);
      await flushAsyncWork();
      expect(fetchMock).toHaveBeenCalledTimes(4);

      const awaitingUserReviewTask = createTask("FN-005", "Test Task 5", "awaiting-user-review");
      store.triggerTaskUpdated(awaitingUserReviewTask);
      await flushAsyncWork();
      expect(fetchMock).toHaveBeenCalledTimes(5);
    });

    it("updates notifications when ntfyEvents changes at runtime", async () => {
      store.setSettings({ ntfyEnabled: true, ntfyTopic: "test-topic", ntfyEvents: ["in-review", "merged", "failed", "awaiting-approval", "awaiting-user-review", "planning-awaiting-input"] });
      notifier = new NtfyNotifier(store);
      await notifier.start();

      // Initially all events enabled
      store.triggerTaskMoved(createTask("FN-001", "Test Task"), "in-progress", "in-review");
      await flushAsyncWork();
      expect(fetchMock).toHaveBeenCalledTimes(1);

      // Disable in-review
      store.setSettings({ ntfyEvents: ["merged", "failed", "awaiting-approval", "awaiting-user-review"] });

      store.triggerTaskMoved(createTask("FN-002", "Test Task 2"), "in-progress", "in-review");
      await flushAsyncWork();
      expect(fetchMock).toHaveBeenCalledTimes(1); // No new call for in-review

      // Enable in-review again
      store.setSettings({ ntfyEvents: ["in-review", "merged", "failed", "awaiting-approval", "awaiting-user-review", "planning-awaiting-input"] });

      store.triggerTaskMoved(createTask("FN-003", "Test Task 3"), "in-progress", "in-review");
      await flushAsyncWork();
      expect(fetchMock).toHaveBeenCalledTimes(2); // New call for in-review
    });
  });
});
