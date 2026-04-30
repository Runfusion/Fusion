/**
 * EventSource Mock Cleanup Requirements:
 * 
 * This test file uses a MockEventSource class that tracks all instances in a static
 * `instances` array. To prevent test isolation issues, we must ensure:
 * 
 * 1. `MockEventSource.instances` is reset to empty before each test
 * 2. Any lingering EventSource instances are closed and removed after each test
 * 3. Fake timers are restored to real timers after each test (in case a test failed
 *    before it could restore them)
 * 4. The reconnectTimer from useTasks hook (3000ms) is cleared by closing all
 *    EventSources in afterEach
 * 
 * Without proper cleanup, fake timers from one test can leak to subsequent tests,
 * causing `waitFor()` calls to hang indefinitely.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { useTasks } from "../useTasks";
import * as api from "../../api";
import type { Task, Column } from "@fusion/core";

// Mock the api module
vi.mock("../../api", () => ({
  fetchTasks: vi.fn().mockResolvedValue([]),
  createTask: vi.fn(),
  moveTask: vi.fn(),
  deleteTask: vi.fn(),
  mergeTask: vi.fn(),
  retryTask: vi.fn(),
  duplicateTask: vi.fn(),
  updateTask: vi.fn(),
  archiveTask: vi.fn(),
  unarchiveTask: vi.fn(),
  archiveAllDone: vi.fn(),
}));

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

const mockFetchTasks = vi.mocked(api.fetchTasks);
const mockCreateTask = vi.mocked(api.createTask);
const mockDuplicateTask = vi.mocked(api.duplicateTask);
const mockUpdateTask = vi.mocked(api.updateTask);
const mockArchiveAllDone = vi.mocked(api.archiveAllDone);

// Mock EventSource
class MockEventSource {
  static instances: MockEventSource[] = [];
  static CLOSED = 2;
  url: string;
  listeners: Record<string, ((e: any) => void)[]> = {};
  readyState = 0;
  close = vi.fn(() => {
    this.readyState = MockEventSource.CLOSED;
  });

  constructor(url: string) {
    this.url = url;
    this.readyState = 1;
    MockEventSource.instances.push(this);
  }

  addEventListener(event: string, fn: (e: any) => void) {
    if (!this.listeners[event]) this.listeners[event] = [];
    this.listeners[event].push(fn);
  }

  removeEventListener(event: string, fn: (e: any) => void) {
    this.listeners[event] = (this.listeners[event] || []).filter((listener) => listener !== fn);
  }

  // Helper to simulate a server event
  _emit(event: string, data?: unknown) {
    for (const fn of this.listeners[event] || []) {
      fn(data === undefined ? {} : { data: JSON.stringify(data) });
    }
  }
}

const originalEventSource = globalThis.EventSource;

beforeEach(() => {
  // Reset all mock state
  MockEventSource.instances = [];
  (globalThis as any).EventSource = MockEventSource;
  mockFetchTasks.mockReset().mockResolvedValue([]);
  
  // Ensure we start with real timers for every test
  vi.useRealTimers();
});

afterEach(() => {
  // Close all lingering EventSource instances to clear reconnect timers
  for (const instance of MockEventSource.instances) {
    instance.close();
  }
  MockEventSource.instances = [];
  
  // Restore original EventSource
  (globalThis as any).EventSource = originalEventSource;
  
  // Safety: ensure real timers are restored even if a test failed
  vi.useRealTimers();
});

function createMockTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "FN-001",
    description: "Test task",
    column: "triage",
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    columnMovedAt: "2026-01-01T00:00:00Z",
    ...overrides,
  } as Task;
}

describe("useTasks", () => {
  it("fetches initial tasks on mount", async () => {
    const mockTasks = [createMockTask()];
    mockFetchTasks.mockResolvedValueOnce(mockTasks);

    const { result } = renderHook(() => useTasks());

    await waitFor(() => {
      expect(result.current.tasks).toHaveLength(1);
    });

    expect(result.current.tasks[0].id).toBe("FN-001");
  });

  describe("SSE event: task:created", () => {
    it("adds new task to the list", async () => {
      mockFetchTasks.mockResolvedValueOnce([]);
      const { result } = renderHook(() => useTasks());

      await waitFor(() => {
        expect(MockEventSource.instances).toHaveLength(1);
      });

      const newTask = createMockTask({ id: "FN-002", column: "triage" });

      act(() => {
        MockEventSource.instances[0]._emit("task:created", newTask);
      });

      expect(result.current.tasks).toHaveLength(1);
      expect(result.current.tasks[0].id).toBe("FN-002");
    });
  });

  describe("SSE event: task:moved", () => {
    it("updates task column using the 'to' field", async () => {
      const initialTask = createMockTask({ id: "FN-001", column: "in-progress" as Column });
      mockFetchTasks.mockResolvedValueOnce([initialTask]);

      const { result } = renderHook(() => useTasks());

      await waitFor(() => {
        expect(result.current.tasks[0].column).toBe("in-progress");
      });

      const movedTaskData = {
        task: createMockTask({
          id: "FN-001",
          column: "in-progress", // task object may have stale column
          columnMovedAt: "2026-01-02T00:00:00Z",
        }),
        from: "in-progress" as Column,
        to: "done" as Column,
      };

      act(() => {
        MockEventSource.instances[0]._emit("task:moved", movedTaskData);
      });

      expect(result.current.tasks[0].column).toBe("done");
      expect(result.current.tasks[0].columnMovedAt).toBe("2026-01-02T00:00:00Z");
    });

    it("task moved from in-progress to done appears only in done column", async () => {
      const tasks = [
        createMockTask({ id: "FN-001", column: "in-progress" as Column }),
        createMockTask({ id: "FN-002", column: "in-progress" as Column }),
      ];
      mockFetchTasks.mockResolvedValueOnce(tasks);

      const { result } = renderHook(() => useTasks());

      await waitFor(() => {
        expect(result.current.tasks).toHaveLength(2);
      });

      // Move KB-001 to done
      const movedTaskData = {
        task: createMockTask({
          id: "FN-001",
          column: "in-progress",
          columnMovedAt: "2026-01-02T00:00:00Z",
        }),
        from: "in-progress" as Column,
        to: "done" as Column,
      };

      act(() => {
        MockEventSource.instances[0]._emit("task:moved", movedTaskData);
      });

      const inProgressTasks = result.current.tasks.filter((t) => t.column === "in-progress");
      const doneTasks = result.current.tasks.filter((t) => t.column === "done");

      expect(inProgressTasks).toHaveLength(1);
      expect(inProgressTasks[0].id).toBe("FN-002");
      expect(doneTasks).toHaveLength(1);
      expect(doneTasks[0].id).toBe("FN-001");
    });
  });

  it("closes the SSE connection on unmount", async () => {
    const { unmount } = renderHook(() => useTasks());

    await waitFor(() => {
      expect(MockEventSource.instances).toHaveLength(1);
    });

    const es = MockEventSource.instances[0];
    unmount();

    expect(es.close).toHaveBeenCalledTimes(1);
  });

  it("closes the broken SSE connection and reconnects after an error", async () => {
    vi.useFakeTimers();
    const { unmount } = renderHook(() => useTasks());

    expect(MockEventSource.instances).toHaveLength(1);

    const first = MockEventSource.instances[0];

    act(() => {
      first._emit("error");
    });

    expect(first.close).toHaveBeenCalledTimes(1);

    await act(async () => {
      vi.advanceTimersByTime(3000);
      await flushPromises();
    });

    expect(MockEventSource.instances).toHaveLength(2);
    expect(mockFetchTasks).toHaveBeenCalledTimes(2);

    unmount();
  });

  it("resyncs tasks after SSE reconnect so the board does not stay stale when updates were missed during disconnect", async () => {
    vi.useFakeTimers();
    const initialTask = createMockTask({
      id: "FN-001",
      title: "Stale title",
      updatedAt: "2026-01-01T00:00:00Z",
    });
    const refreshedTask = createMockTask({
      id: "FN-001",
      title: "Fresh title",
      updatedAt: "2026-01-02T00:00:00Z",
    });
    mockFetchTasks
      .mockResolvedValueOnce([initialTask])
      .mockResolvedValueOnce([refreshedTask]);

    const { result } = renderHook(() => useTasks());

    await act(async () => {
      await flushPromises();
    });

    expect(result.current.tasks[0]?.title).toBe("Stale title");

    const first = MockEventSource.instances[0];

    act(() => {
      first._emit("error");
    });

    await act(async () => {
      vi.advanceTimersByTime(3000);
      await flushPromises();
    });

    expect(MockEventSource.instances).toHaveLength(2);
    expect(mockFetchTasks).toHaveBeenCalledTimes(2);
    expect(result.current.tasks[0]?.title).toBe("Fresh title");
  });


  describe("SSE event: task:updated", () => {
    it("updates task fields", async () => {
      const initialTask = createMockTask({
        id: "FN-001",
        title: "Old Title",
        column: "in-progress" as Column,
      });
      mockFetchTasks.mockResolvedValueOnce([initialTask]);

      const { result } = renderHook(() => useTasks());

      await waitFor(() => {
        expect(result.current.tasks[0].title).toBe("Old Title");
      });

      const updatedTask = createMockTask({
        id: "FN-001",
        title: "New Title",
        column: "in-progress" as Column,
        columnMovedAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-02T00:00:00Z",
      });

      act(() => {
        MockEventSource.instances[0]._emit("task:updated", updatedTask);
      });

      expect(result.current.tasks[0].title).toBe("New Title");
      expect(result.current.tasks[0].column).toBe("in-progress");
    });

    it("preserves stable execution metadata during sparse same-column updates", async () => {
      const initialTask = createMockTask({
        id: "FN-001",
        column: "in-progress" as Column,
        title: "Initial title",
        status: "planning",
        columnMovedAt: "2026-01-02T00:00:00Z",
        executionStartedAt: "2026-01-01T23:50:00Z",
        worktree: "/tmp/fn-001",
        modifiedFiles: ["packages/dashboard/app/components/QuickChatFAB.tsx"],
        timedExecutionMs: 120_000,
        workflowStepResults: [
          {
            workflowStepId: "WS-001",
            workflowStepName: "Verify",
            phase: "pre-merge",
            status: "pending",
            startedAt: "2026-01-02T00:00:00Z",
          },
        ],
        tokenUsage: {
          inputTokens: 100,
          outputTokens: 40,
          cachedTokens: 10,
          totalTokens: 150,
          firstUsedAt: "2026-01-02T00:00:00Z",
          lastUsedAt: "2026-01-02T00:01:00Z",
        },
        updatedAt: "2026-01-02T00:00:00Z",
      });
      mockFetchTasks.mockResolvedValueOnce([initialTask]);

      const { result } = renderHook(() => useTasks());

      await waitFor(() => {
        expect(result.current.tasks[0].status).toBe("planning");
      });

      const sparseUpdate = {
        ...createMockTask({
          id: "FN-001",
          column: "in-progress" as Column,
          title: "Updated title",
          status: "executing",
          updatedAt: "2026-01-03T00:00:00Z",
        }),
        columnMovedAt: undefined,
        executionStartedAt: undefined,
        worktree: undefined,
        modifiedFiles: undefined,
        timedExecutionMs: undefined,
        workflowStepResults: undefined,
        tokenUsage: undefined,
      };

      act(() => {
        MockEventSource.instances[0]._emit("task:updated", sparseUpdate);
      });

      expect(result.current.tasks[0].title).toBe("Updated title");
      expect(result.current.tasks[0].status).toBe("executing");
      expect(result.current.tasks[0].columnMovedAt).toBe("2026-01-02T00:00:00Z");
      expect(result.current.tasks[0].executionStartedAt).toBe("2026-01-01T23:50:00Z");
      expect(result.current.tasks[0].worktree).toBe("/tmp/fn-001");
      expect(result.current.tasks[0].modifiedFiles).toEqual([
        "packages/dashboard/app/components/QuickChatFAB.tsx",
      ]);
      expect(result.current.tasks[0].timedExecutionMs).toBe(120_000);
      expect(result.current.tasks[0].workflowStepResults).toHaveLength(1);
      expect(result.current.tasks[0].tokenUsage?.totalTokens).toBe(150);
    });

    it("does not overwrite newer column with stale data (timestamp comparison)", async () => {
      // Start with task in in-progress
      const initialTask = createMockTask({
        id: "FN-001",
        column: "in-progress" as Column,
        columnMovedAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      });
      mockFetchTasks.mockResolvedValueOnce([initialTask]);

      const { result } = renderHook(() => useTasks());

      await waitFor(() => {
        expect(result.current.tasks[0].column).toBe("in-progress");
      });

      // First, move to done (newer timestamp)
      const movedTaskData = {
        task: createMockTask({
          id: "FN-001",
          column: "in-progress",
          columnMovedAt: "2026-01-02T00:00:00Z",
          updatedAt: "2026-01-02T00:00:00Z",
        }),
        from: "in-progress" as Column,
        to: "done" as Column,
      };

      act(() => {
        MockEventSource.instances[0]._emit("task:moved", movedTaskData);
      });

      expect(result.current.tasks[0].column).toBe("done");
      expect(result.current.tasks[0].columnMovedAt).toBe("2026-01-02T00:00:00Z");

      // Then, stale update arrives with old column and older timestamp
      const staleUpdate = createMockTask({
        id: "FN-001",
        column: "in-progress" as Column, // stale column
        columnMovedAt: "2026-01-01T00:00:00Z", // older timestamp
        updatedAt: "2026-01-01T00:00:00Z", // older overall
        title: "Some other update",
      });

      act(() => {
        MockEventSource.instances[0]._emit("task:updated", staleUpdate);
      });

      // Column should remain 'done' (not revert to in-progress)
      expect(result.current.tasks[0].column).toBe("done");
      expect(result.current.tasks[0].columnMovedAt).toBe("2026-01-02T00:00:00Z");
      // Title should NOT be updated because the entire update is stale
      expect(result.current.tasks[0].title).toBeUndefined();
    });

    it("status updates are applied when updatedAt is newer even if columnMovedAt is older", async () => {
      // Task was moved to in-progress (columnMovedAt is newer)
      const initialTask = createMockTask({
        id: "FN-001",
        column: "in-progress" as Column,
        status: "planning",
        columnMovedAt: "2026-01-02T00:00:00Z",
        updatedAt: "2026-01-02T00:00:00Z",
      });
      mockFetchTasks.mockResolvedValueOnce([initialTask]);

      const { result } = renderHook(() => useTasks());

      await waitFor(() => {
        expect(result.current.tasks[0].column).toBe("in-progress");
      });

      // Status update arrives with older columnMovedAt but newer updatedAt
      // This simulates an executor status change after a column move
      const statusUpdate = createMockTask({
        id: "FN-001",
        column: "in-progress" as Column, // same column
        status: "executing", // status changed
        columnMovedAt: "2026-01-01T00:00:00Z", // older (from before move)
        updatedAt: "2026-01-03T00:00:00Z", // newer (status just changed)
      });

      act(() => {
        MockEventSource.instances[0]._emit("task:updated", statusUpdate);
      });

      // Status should be updated because updatedAt is newer
      expect(result.current.tasks[0].column).toBe("in-progress");
      expect(result.current.tasks[0].status).toBe("executing");
    });

    it("rapid status updates after column move are not rejected", async () => {
      // Task starts in todo
      const initialTask = createMockTask({
        id: "FN-001",
        column: "todo" as Column,
        status: "pending",
        columnMovedAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      });
      mockFetchTasks.mockResolvedValueOnce([initialTask]);

      const { result } = renderHook(() => useTasks());

      await waitFor(() => {
        expect(result.current.tasks[0].column).toBe("todo");
      });

      // Column move happens
      const movedTaskData = {
        task: createMockTask({
          id: "FN-001",
          column: "todo",
          status: "pending",
          columnMovedAt: "2026-01-02T00:00:00Z",
          updatedAt: "2026-01-02T00:00:00Z",
        }),
        from: "todo" as Column,
        to: "in-progress" as Column,
      };

      act(() => {
        MockEventSource.instances[0]._emit("task:moved", movedTaskData);
      });

      expect(result.current.tasks[0].column).toBe("in-progress");

      // Rapid status updates arrive (newer updatedAt, older columnMovedAt)
      const statusUpdate1 = createMockTask({
        id: "FN-001",
        column: "in-progress" as Column,
        status: "planning",
        columnMovedAt: "2026-01-01T00:00:00Z", // older (from before move)
        updatedAt: "2026-01-03T00:00:00Z", // newer
      });

      act(() => {
        MockEventSource.instances[0]._emit("task:updated", statusUpdate1);
      });

      expect(result.current.tasks[0].status).toBe("planning");

      // Another rapid status update
      const statusUpdate2 = createMockTask({
        id: "FN-001",
        column: "in-progress" as Column,
        status: "executing",
        columnMovedAt: "2026-01-01T00:00:00Z", // still older
        updatedAt: "2026-01-04T00:00:00Z", // even newer
      });

      act(() => {
        MockEventSource.instances[0]._emit("task:updated", statusUpdate2);
      });

      expect(result.current.tasks[0].column).toBe("in-progress");
      expect(result.current.tasks[0].status).toBe("executing");
    });

    it("preserves current column when incoming has no columnMovedAt (legacy data)", async () => {
      const initialTask = createMockTask({
        id: "FN-001",
        column: "done" as Column,
        columnMovedAt: "2026-01-02T00:00:00Z",
        updatedAt: "2026-01-02T00:00:00Z",
      });
      mockFetchTasks.mockResolvedValueOnce([initialTask]);

      const { result } = renderHook(() => useTasks());

      await waitFor(() => {
        expect(result.current.tasks[0].column).toBe("done");
      });

      // Incoming update has no columnMovedAt (legacy) and different column
      const legacyUpdate = {
        ...createMockTask({
          id: "FN-001",
          column: "in-progress" as Column,
          updatedAt: "2026-01-03T00:00:00Z", // newer updatedAt
        }),
        columnMovedAt: undefined,
      };

      act(() => {
        MockEventSource.instances[0]._emit("task:updated", legacyUpdate);
      });

      // Should preserve the done column since we have timestamp and incoming doesn't
      expect(result.current.tasks[0].column).toBe("done");
    });
  });

  describe("SSE event: task:deleted", () => {
    it("removes task from the list", async () => {
      const tasks = [
        createMockTask({ id: "FN-001" }),
        createMockTask({ id: "FN-002" }),
      ];
      mockFetchTasks.mockResolvedValueOnce(tasks);

      const { result } = renderHook(() => useTasks());

      await waitFor(() => {
        expect(result.current.tasks).toHaveLength(2);
      });

      act(() => {
        MockEventSource.instances[0]._emit("task:deleted", { id: "FN-001" });
      });

      expect(result.current.tasks).toHaveLength(1);
      expect(result.current.tasks[0].id).toBe("FN-002");
    });
  });

  describe("SSE event: task:merged", () => {
    it("ensures column is always done after merge", async () => {
      const initialTask = createMockTask({
        id: "FN-001",
        column: "in-review" as Column,
      });
      mockFetchTasks.mockResolvedValueOnce([initialTask]);

      const { result } = renderHook(() => useTasks());

      await waitFor(() => {
        expect(result.current.tasks[0].column).toBe("in-review");
      });

      const mergeResult = {
        task: createMockTask({
          id: "FN-001",
          column: "in-review" as Column, // might have stale column
        }),
        branch: "fusion/fn-001",
        merged: true,
        worktreeRemoved: true,
        branchDeleted: true,
      };

      act(() => {
        MockEventSource.instances[0]._emit("task:merged", mergeResult);
      });

      expect(result.current.tasks[0].column).toBe("done");
    });
  });

  describe("Race condition scenarios", () => {
    it("rapid task:moved + task:updated events maintain correct column state", async () => {
      const initialTask = createMockTask({
        id: "FN-001",
        column: "todo" as Column,
        columnMovedAt: "2026-01-01T00:00:00Z",
      });
      mockFetchTasks.mockResolvedValueOnce([initialTask]);

      const { result } = renderHook(() => useTasks());

      await waitFor(() => {
        expect(result.current.tasks[0].column).toBe("todo");
      });

      // Simulate rapid succession: moved then stale update
      const movedData = {
        task: createMockTask({
          id: "FN-001",
          column: "todo",
          columnMovedAt: "2026-01-02T00:00:00Z",
          title: "Original Title",
        }),
        from: "todo" as Column,
        to: "in-progress" as Column,
      };

      const staleUpdate = createMockTask({
        id: "FN-001",
        column: "todo" as Column, // stale
        columnMovedAt: "2026-01-01T00:00:00Z", // older
        title: "Updated Title", // fresh
      });

      act(() => {
        MockEventSource.instances[0]._emit("task:moved", movedData);
        MockEventSource.instances[0]._emit("task:updated", staleUpdate);
      });

      // Should have in-progress column (from move) but updated title
      expect(result.current.tasks[0].column).toBe("in-progress");
      expect(result.current.tasks[0].title).toBe("Updated Title");
    });
  });

  describe("heartbeat timeout", () => {
    it("reconnects when no SSE messages arrive within 45 seconds", async () => {
      vi.useFakeTimers();
      mockFetchTasks.mockResolvedValue([]);

      const { unmount } = renderHook(() => useTasks());

      expect(MockEventSource.instances).toHaveLength(1);
      const first = MockEventSource.instances[0];

      // Advance past the 45s heartbeat timeout
      await act(async () => {
        vi.advanceTimersByTime(45_000);
        await flushPromises();
      });

      // First connection should be closed
      expect(first.close).toHaveBeenCalled();

      // After reconnect delay (3s), a new connection should be created
      await act(async () => {
        vi.advanceTimersByTime(3000);
        await flushPromises();
      });

      expect(MockEventSource.instances.length).toBeGreaterThan(1);

      unmount();
    });

    it("does not reconnect when heartbeat events arrive regularly", async () => {
      vi.useFakeTimers();
      mockFetchTasks.mockResolvedValue([]);

      const { unmount } = renderHook(() => useTasks());

      expect(MockEventSource.instances).toHaveLength(1);
      const first = MockEventSource.instances[0];

      // Simulate heartbeat every 30s (before the 45s timeout)
      await act(async () => {
        vi.advanceTimersByTime(30_000);
        first._emit("heartbeat");
        await flushPromises();
      });

      await act(async () => {
        vi.advanceTimersByTime(30_000);
        first._emit("heartbeat");
        await flushPromises();
      });

      // Should still be on the first connection
      expect(MockEventSource.instances).toHaveLength(1);
      expect(first.close).not.toHaveBeenCalled();

      unmount();
    });

    it("resets heartbeat timeout on task events", async () => {
      vi.useFakeTimers();
      mockFetchTasks.mockResolvedValue([]);

      const { unmount } = renderHook(() => useTasks());

      expect(MockEventSource.instances).toHaveLength(1);
      const first = MockEventSource.instances[0];

      // Advance 40s (close to timeout)
      await act(async () => {
        vi.advanceTimersByTime(40_000);
        await flushPromises();
      });

      // Send a task event to reset the watchdog
      act(() => {
        first._emit("task:updated", createMockTask({ id: "FN-001" }));
      });

      // Advance another 40s (would have timed out without the reset)
      await act(async () => {
        vi.advanceTimersByTime(40_000);
        await flushPromises();
      });

      // Should still be on the first connection
      expect(MockEventSource.instances).toHaveLength(1);
      expect(first.close).not.toHaveBeenCalled();

      unmount();
    });
  });

  describe("cleanup", () => {
    it("closes EventSource on unmount", async () => {
      mockFetchTasks.mockResolvedValueOnce([]);

      const { unmount } = renderHook(() => useTasks());

      await waitFor(() => {
        expect(MockEventSource.instances).toHaveLength(1);
      });

      const es = MockEventSource.instances[0];
      unmount();

      expect(es.close).toHaveBeenCalled();
    });
  });

  describe("updateTask", () => {
    it("updates task optimistically and returns server response", async () => {
      const initialTask = createMockTask({
        id: "FN-001",
        title: "Old Title",
        description: "Old Description",
      });
      mockFetchTasks.mockResolvedValueOnce([initialTask]);

      const { result } = renderHook(() => useTasks());

      await waitFor(() => {
        expect(result.current.tasks).toHaveLength(1);
      });

      const updatedTask = createMockTask({
        id: "FN-001",
        title: "New Title",
        description: "New Description",
        updatedAt: "2026-01-02T00:00:00Z",
      });
      mockUpdateTask.mockResolvedValueOnce(updatedTask);

      let returnedTask: Task | undefined;
      await act(async () => {
        returnedTask = await result.current.updateTask("FN-001", {
          title: "New Title",
          description: "New Description",
        });
      });

      expect(mockUpdateTask).toHaveBeenCalledWith("FN-001", {
        title: "New Title",
        description: "New Description",
      }, undefined);
      expect(returnedTask).toEqual(updatedTask);
      expect(result.current.tasks[0].title).toBe("New Title");
      expect(result.current.tasks[0].description).toBe("New Description");
    });

    it("rolls back on error and rethrows", async () => {
      const initialTask = createMockTask({
        id: "FN-001",
        title: "Original Title",
        description: "Original Description",
      });
      mockFetchTasks.mockResolvedValueOnce([initialTask]);

      const { result } = renderHook(() => useTasks());

      await waitFor(() => {
        expect(result.current.tasks).toHaveLength(1);
      });

      mockUpdateTask.mockRejectedValueOnce(new Error("Update failed"));

      await expect(
        act(async () => {
          await result.current.updateTask("FN-001", {
            title: "New Title",
            description: "New Description",
          });
        })
      ).rejects.toThrow("Update failed");

      // Should have rolled back to original
      expect(result.current.tasks[0].title).toBe("Original Title");
      expect(result.current.tasks[0].description).toBe("Original Description");
    });

    it("supports updating only title", async () => {
      const initialTask = createMockTask({
        id: "FN-001",
        title: "Old Title",
        description: "Description",
      });
      mockFetchTasks.mockResolvedValueOnce([initialTask]);

      const { result } = renderHook(() => useTasks());

      await waitFor(() => {
        expect(result.current.tasks).toHaveLength(1);
      });

      const updatedTask = createMockTask({
        id: "FN-001",
        title: "New Title",
        description: "Description",
        updatedAt: "2026-01-02T00:00:00Z",
      });
      mockUpdateTask.mockResolvedValueOnce(updatedTask);

      await act(async () => {
        await result.current.updateTask("FN-001", { title: "New Title" });
      });

      expect(result.current.tasks[0].title).toBe("New Title");
      expect(result.current.tasks[0].description).toBe("Description");
    });

    it("supports updating only description", async () => {
      const initialTask = createMockTask({
        id: "FN-001",
        title: "Title",
        description: "Old Description",
      });
      mockFetchTasks.mockResolvedValueOnce([initialTask]);

      const { result } = renderHook(() => useTasks());

      await waitFor(() => {
        expect(result.current.tasks).toHaveLength(1);
      });

      const updatedTask = createMockTask({
        id: "FN-001",
        title: "Title",
        description: "New Description",
        updatedAt: "2026-01-02T00:00:00Z",
      });
      mockUpdateTask.mockResolvedValueOnce(updatedTask);

      await act(async () => {
        await result.current.updateTask("FN-001", { description: "New Description" });
      });

      expect(result.current.tasks[0].title).toBe("Title");
      expect(result.current.tasks[0].description).toBe("New Description");
    });

    it("supports updating dependencies", async () => {
      const initialTask = createMockTask({
        id: "FN-001",
        dependencies: ["FN-002"],
      });
      mockFetchTasks.mockResolvedValueOnce([initialTask]);

      const { result } = renderHook(() => useTasks());

      await waitFor(() => {
        expect(result.current.tasks).toHaveLength(1);
      });

      const updatedTask = createMockTask({
        id: "FN-001",
        dependencies: ["FN-002", "FN-003"],
        updatedAt: "2026-01-02T00:00:00Z",
      });
      mockUpdateTask.mockResolvedValueOnce(updatedTask);

      await act(async () => {
        await result.current.updateTask("FN-001", { dependencies: ["FN-002", "FN-003"] });
      });

      expect(result.current.tasks[0].dependencies).toEqual(["FN-002", "FN-003"]);
    });
  });

  describe("archiveAllDone", () => {
    it("archives all done tasks and updates local state", async () => {
      const doneTasks = [
        createMockTask({ id: "FN-001", column: "done" as Column }),
        createMockTask({ id: "FN-002", column: "done" as Column }),
      ];
      const todoTask = createMockTask({ id: "FN-003", column: "todo" as Column });
      mockFetchTasks.mockResolvedValueOnce([...doneTasks, todoTask]);

      const archivedTasks = [
        createMockTask({ id: "FN-001", column: "archived" as Column }),
        createMockTask({ id: "FN-002", column: "archived" as Column }),
      ];
      mockArchiveAllDone.mockResolvedValueOnce(archivedTasks);

      const { result } = renderHook(() => useTasks());

      await waitFor(() => {
        expect(result.current.tasks).toHaveLength(3);
      });

      await act(async () => {
        await result.current.archiveAllDone();
      });

      expect(mockArchiveAllDone).toHaveBeenCalled();
      // Done tasks should be archived
      expect(result.current.tasks.find((t) => t.id === "FN-001")?.column).toBe("archived");
      expect(result.current.tasks.find((t) => t.id === "FN-002")?.column).toBe("archived");
      // Todo task should remain unchanged
      expect(result.current.tasks.find((t) => t.id === "FN-003")?.column).toBe("todo");
    });

    it("returns empty array when no done tasks exist", async () => {
      const todoTask = createMockTask({ id: "FN-001", column: "todo" as Column });
      mockFetchTasks.mockResolvedValueOnce([todoTask]);
      mockArchiveAllDone.mockResolvedValueOnce([]);

      const { result } = renderHook(() => useTasks());

      await waitFor(() => {
        expect(result.current.tasks).toHaveLength(1);
      });

      const archived = await act(async () => {
        return await result.current.archiveAllDone();
      });

      expect(archived).toEqual([]);
      expect(result.current.tasks[0].column).toBe("todo");
    });
  });

  describe("createTask optimistic insertion", () => {
    it("adds task to state immediately", async () => {
      mockFetchTasks.mockResolvedValueOnce([]);
      const newTask = createMockTask({ id: "FN-010", column: "triage" });
      mockCreateTask.mockResolvedValueOnce(newTask);

      const { result } = renderHook(() => useTasks());

      await waitFor(() => {
        expect(MockEventSource.instances).toHaveLength(1);
      });

      await act(async () => {
        await result.current.createTask({ description: "New task" });
      });

      expect(result.current.tasks).toHaveLength(1);
      expect(result.current.tasks[0].id).toBe("FN-010");
    });

    it("does not produce duplicates when SSE event arrives", async () => {
      mockFetchTasks.mockResolvedValueOnce([]);
      const newTask = createMockTask({ id: "FN-010", column: "triage" });
      mockCreateTask.mockResolvedValueOnce(newTask);

      const { result } = renderHook(() => useTasks());

      await waitFor(() => {
        expect(MockEventSource.instances).toHaveLength(1);
      });

      await act(async () => {
        await result.current.createTask({ description: "New task" });
      });

      expect(result.current.tasks).toHaveLength(1);

      // SSE event arrives with the same task
      act(() => {
        MockEventSource.instances[0]._emit("task:created", newTask);
      });

      expect(result.current.tasks).toHaveLength(1);
      expect(result.current.tasks[0].id).toBe("FN-010");
    });
  });

  describe("ingestCreatedTasks", () => {
    it("adds planning-created tasks to local state immediately", async () => {
      mockFetchTasks.mockResolvedValueOnce([]);
      const createdTask = createMockTask({ id: "FN-020", column: "triage" });

      const { result } = renderHook(() => useTasks());

      await waitFor(() => {
        expect(MockEventSource.instances).toHaveLength(1);
      });

      act(() => {
        result.current.ingestCreatedTasks([createdTask]);
      });

      expect(result.current.tasks).toHaveLength(1);
      expect(result.current.tasks[0]?.id).toBe("FN-020");
    });

    it("does not overwrite fresher task data when SSE already updated the task", async () => {
      mockFetchTasks.mockResolvedValueOnce([]);
      const createdTask = createMockTask({
        id: "FN-021",
        updatedAt: "2026-01-01T00:00:00Z",
      });
      const refreshedTask = createMockTask({
        id: "FN-021",
        updatedAt: "2026-01-02T00:00:00Z",
        size: "L",
      });

      const { result } = renderHook(() => useTasks());

      await waitFor(() => {
        expect(MockEventSource.instances).toHaveLength(1);
      });

      act(() => {
        MockEventSource.instances[0]._emit("task:created", refreshedTask);
      });

      act(() => {
        result.current.ingestCreatedTasks([createdTask]);
      });

      expect(result.current.tasks).toHaveLength(1);
      expect(result.current.tasks[0]).toMatchObject({
        id: "FN-021",
        updatedAt: "2026-01-02T00:00:00Z",
        size: "L",
      });
    });
  });

  describe("duplicateTask optimistic insertion", () => {
    it("adds task to state immediately", async () => {
      const original = createMockTask({ id: "FN-001", column: "todo" as Column });
      mockFetchTasks.mockResolvedValueOnce([original]);
      const duplicated = createMockTask({ id: "FN-011", column: "triage", description: "Test task" });
      mockDuplicateTask.mockResolvedValueOnce(duplicated);

      const { result } = renderHook(() => useTasks());

      await waitFor(() => {
        expect(result.current.tasks).toHaveLength(1);
      });

      await act(async () => {
        await result.current.duplicateTask("FN-001");
      });

      expect(result.current.tasks).toHaveLength(2);
      expect(result.current.tasks.find((t) => t.id === "FN-011")).toBeDefined();
    });

    it("does not produce duplicates when SSE event arrives", async () => {
      const original = createMockTask({ id: "FN-001", column: "todo" as Column });
      mockFetchTasks.mockResolvedValueOnce([original]);
      const duplicated = createMockTask({ id: "FN-011", column: "triage", description: "Test task" });
      mockDuplicateTask.mockResolvedValueOnce(duplicated);

      const { result } = renderHook(() => useTasks());

      await waitFor(() => {
        expect(result.current.tasks).toHaveLength(1);
      });

      await act(async () => {
        await result.current.duplicateTask("FN-001");
      });

      expect(result.current.tasks).toHaveLength(2);

      // SSE event arrives with the same task
      act(() => {
        MockEventSource.instances[0]._emit("task:created", duplicated);
      });

      expect(result.current.tasks).toHaveLength(2);
      expect(result.current.tasks.filter((t) => t.id === "FN-011")).toHaveLength(1);
    });
  });

  describe("visibility change", () => {
    let originalVisibilityState: PropertyDescriptor | undefined;

    beforeEach(() => {
      // Store original descriptor to restore later
      originalVisibilityState = Object.getOwnPropertyDescriptor(document, "visibilityState");
    });

    afterEach(() => {
      // Restore original visibilityState property
      if (originalVisibilityState) {
        Object.defineProperty(document, "visibilityState", originalVisibilityState);
      } else {
        // If no original descriptor, just delete our mock
         
        delete (document as any).visibilityState;
      }
    });

    function setVisibilityState(state: "visible" | "hidden") {
      Object.defineProperty(document, "visibilityState", {
        value: state,
        writable: true,
        configurable: true,
      });
    }

    async function dispatchVisibilityChange() {
      await act(async () => {
        document.dispatchEvent(new Event("visibilitychange"));
        await Promise.resolve();
      });
    }

    it("refetches tasks when visibility changes from hidden to visible and normalizes refreshed data", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));

      const initialTask = createMockTask({ id: "FN-001", column: "todo" as Column });
      const refreshedTask = {
        ...createMockTask({
          id: "FN-001",
          column: "in-progress" as Column,
          updatedAt: "2026-01-02T00:00:00Z",
        }),
        dependencies: undefined,
        steps: undefined,
        log: undefined,
      } as unknown as Task;

      mockFetchTasks.mockResolvedValueOnce([initialTask]).mockResolvedValueOnce([refreshedTask]);

      const { result } = renderHook(() => useTasks());

      await act(async () => {
        await Promise.resolve();
      });

      expect(result.current.tasks).toHaveLength(1);

      vi.setSystemTime(new Date("2026-01-01T00:00:01.100Z"));
      setVisibilityState("hidden");
      await dispatchVisibilityChange();

      setVisibilityState("visible");
      await dispatchVisibilityChange();

      await act(async () => {
        await Promise.resolve();
      });

      expect(result.current.tasks[0].column).toBe("in-progress");
      expect(result.current.tasks[0].dependencies).toEqual([]);
      expect(result.current.tasks[0].steps).toEqual([]);
      expect(result.current.tasks[0].log).toEqual([]);
      expect(mockFetchTasks).toHaveBeenCalledTimes(2);
    });

    it("does not refetch when visibility changes to hidden", async () => {
      const initialTask = createMockTask({ id: "FN-001" });
      mockFetchTasks.mockResolvedValueOnce([initialTask]);

      renderHook(() => useTasks());

      await act(async () => {
        await Promise.resolve();
      });

      mockFetchTasks.mockClear();

      setVisibilityState("hidden");
      await dispatchVisibilityChange();

      expect(mockFetchTasks).not.toHaveBeenCalled();
    });

    it("debounces rapid visibility changes (minimum 1 second between fetches)", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));

      const initialTask = createMockTask({ id: "FN-001" });
      mockFetchTasks.mockResolvedValue([initialTask]);

      renderHook(() => useTasks());

      await act(async () => {
        await Promise.resolve();
      });

      mockFetchTasks.mockClear();

      vi.setSystemTime(new Date("2026-01-01T00:00:01.100Z"));
      setVisibilityState("hidden");
      await dispatchVisibilityChange();

      setVisibilityState("visible");
      await dispatchVisibilityChange();

      expect(mockFetchTasks).toHaveBeenCalledTimes(1);

      for (let i = 0; i < 5; i++) {
        setVisibilityState("hidden");
        await dispatchVisibilityChange();

        setVisibilityState("visible");
        await dispatchVisibilityChange();
      }

      expect(mockFetchTasks).toHaveBeenCalledTimes(1);

      vi.setSystemTime(new Date("2026-01-01T00:00:02.200Z"));
      setVisibilityState("hidden");
      await dispatchVisibilityChange();

      setVisibilityState("visible");
      await dispatchVisibilityChange();

      expect(mockFetchTasks).toHaveBeenCalledTimes(2);
    });

    it("cleans up visibility change listener on unmount", async () => {
      mockFetchTasks.mockResolvedValueOnce([]);

      const removeEventListenerSpy = vi.spyOn(document, "removeEventListener");

      const { unmount } = renderHook(() => useTasks());

      await waitFor(() => {
        expect(mockFetchTasks).toHaveBeenCalledTimes(1);
      });

      unmount();

      expect(removeEventListenerSpy).toHaveBeenCalledWith("visibilitychange", expect.any(Function));

      removeEventListenerSpy.mockRestore();
    });
  });

  describe("project switching", () => {
    it("keeps previous tasks visible while new project's fetch is in flight (stale-while-revalidate)", async () => {
      // Project A has tasks
      const projectATasks = [
        createMockTask({ id: "FN-A1", description: "Project A task 1" }),
        createMockTask({ id: "FN-A2", description: "Project A task 2" }),
      ];
      let resolveProjectB: (tasks: Task[]) => void;
      const projectBFetchPromise = new Promise<Task[]>((resolve) => {
        resolveProjectB = resolve;
      });
      mockFetchTasks
        .mockResolvedValueOnce(projectATasks)
        .mockImplementationOnce(() => projectBFetchPromise);

      // Start with project A
      const { result, rerender } = renderHook(
        ({ projectId }: { projectId?: string }) => useTasks({ projectId }),
        { initialProps: { projectId: "project-a" } }
      );

      await waitFor(() => {
        expect(result.current.tasks).toHaveLength(2);
      });

      // Verify we're showing project A tasks
      expect(result.current.tasks.map((t) => t.id)).toEqual(["FN-A1", "FN-A2"]);
      expect(mockFetchTasks).toHaveBeenLastCalledWith(
        undefined, undefined, "project-a", undefined, false
      );

      // Switch to project B — previous tasks should remain visible until new fetch lands
      await act(async () => {
        rerender({ projectId: "project-b" });
      });

      // Project B fetch should be in flight
      expect(mockFetchTasks).toHaveBeenLastCalledWith(
        undefined, undefined, "project-b", undefined, false
      );

      // Previous project's tasks remain visible (SWR) — avoids blank flash
      expect(result.current.tasks.map((t) => t.id)).toEqual(["FN-A1", "FN-A2"]);

      // Once project B resolves, its tasks replace the stale set
      const projectBTasks = [createMockTask({ id: "FN-B1", description: "Project B task" })];
      await act(async () => {
        resolveProjectB!(projectBTasks);
      });

      await waitFor(() => {
        expect(result.current.tasks.map((t) => t.id)).toEqual(["FN-B1"]);
      });
    });

    it("ignores late responses from the previous project after switching", async () => {
      // Use a more realistic mock that returns different promises per projectId
      // This simulates real API behavior where different projectIds result in different API calls

      const projectATasks = [
        createMockTask({ id: "FN-A1", description: "Project A task" }),
      ];

      // Create pending promises for each project
      let resolveProjectA: (tasks: Task[]) => void;
      const projectAFetchPromise = new Promise<Task[]>((resolve) => {
        resolveProjectA = resolve;
      });

      let resolveProjectB: (tasks: Task[]) => void;
      const projectBFetchPromise = new Promise<Task[]>((resolve) => {
        resolveProjectB = resolve;
      });

      // Mock to return different promises based on projectId
      mockFetchTasks.mockImplementation((_limit?: number, _offset?: number, projectId?: string) => {
        if (projectId === "project-a") {
          return projectAFetchPromise;
        }
        if (projectId === "project-b") {
          return projectBFetchPromise;
        }
        return Promise.resolve([]);
      });

      // Initial mount with project A
      const { result, rerender } = renderHook(
        ({ projectId }: { projectId?: string }) => useTasks({ projectId }),
        { initialProps: { projectId: "project-a" } }
      );

      await waitFor(() => {
        expect(MockEventSource.instances).toHaveLength(1);
      });

      // Project A's fetch has not resolved yet, so tasks start empty
      expect(result.current.tasks).toHaveLength(0);

      // Switch to project B before project A resolves
      await act(async () => {
        rerender({ projectId: "project-b" });
      });

      // Project A's fetch resolves late (should be ignored due to projectId mismatch)
      await act(async () => {
        resolveProjectA!(projectATasks);
      });

      // Project A data should NOT appear — late response from previous project is rejected
      expect(result.current.tasks.some((t) => t.id === "FN-A1")).toBe(false);

      // Now resolve project B's fetch
      const projectBTasks = [
        createMockTask({ id: "FN-B1", description: "Project B task" }),
      ];
      await act(async () => {
        resolveProjectB!(projectBTasks);
      });

      // Project B data should appear
      expect(result.current.tasks).toHaveLength(1);
      expect(result.current.tasks[0].id).toBe("FN-B1");
    });

    it("ignores SSE task:created events from stale EventSource after project switch", async () => {
      // Project A has a task
      const projectATasks = [
        createMockTask({ id: "FN-A1", description: "Project A task" }),
      ];
      // Project B fetch resolves to an empty list so we can cleanly observe SSE-added tasks
      mockFetchTasks
        .mockResolvedValueOnce(projectATasks)
        .mockResolvedValue([]);

      // Start with project A
      const { result, rerender } = renderHook(
        ({ projectId }: { projectId?: string }) => useTasks({ projectId }),
        { initialProps: { projectId: "project-a" } }
      );

      await waitFor(() => {
        expect(result.current.tasks).toHaveLength(1);
      });

      const projectAEventSource = MockEventSource.instances[0];

      // Switch to project B
      await act(async () => {
        rerender({ projectId: "project-b" });
      });

      // Wait for project B's (empty) fetch to replace the stale task set
      await waitFor(() => {
        expect(result.current.tasks).toHaveLength(0);
      });

      // Emit a task:created event from the OLD EventSource (project A)
      const newTaskFromStaleSource = createMockTask({ id: "FN-A2", description: "Should not appear" });
      await act(async () => {
        projectAEventSource._emit("task:created", newTaskFromStaleSource);
      });

      // The stale event should be ignored - tasks should still be empty
      expect(result.current.tasks).toHaveLength(0);

      // Now emit from the NEW EventSource (project B) - this should work
      await waitFor(() => {
        expect(MockEventSource.instances).toHaveLength(2);
      });

      const projectBEventSource = MockEventSource.instances[1];
      const newTaskFromProjectB = createMockTask({ id: "FN-B1", description: "Project B task" });

      await act(async () => {
        projectBEventSource._emit("task:created", newTaskFromProjectB);
      });

      // The new event should be accepted
      expect(result.current.tasks).toHaveLength(1);
      expect(result.current.tasks[0].id).toBe("FN-B1");
    });

    it("calls fetchTasks with correct projectId across switch sequence", async () => {
      mockFetchTasks.mockResolvedValue([]);

      const { result, rerender } = renderHook(
        ({ projectId }: { projectId?: string }) => useTasks({ projectId }),
        { initialProps: { projectId: "project-a" } }
      );

      await waitFor(() => {
        expect(mockFetchTasks).toHaveBeenCalledTimes(1);
      });
      expect(mockFetchTasks).toHaveBeenLastCalledWith(
        undefined, undefined, "project-a", undefined, false
      );

      // Switch to project B
      await act(async () => {
        rerender({ projectId: "project-b" });
      });

      // Fetch should be called again for project B
      await waitFor(() => {
        expect(mockFetchTasks).toHaveBeenCalledTimes(2);
      });
      expect(mockFetchTasks).toHaveBeenLastCalledWith(
        undefined, undefined, "project-b", undefined, false
      );

      // Switch to project C
      await act(async () => {
        rerender({ projectId: "project-c" });
      });

      await waitFor(() => {
        expect(mockFetchTasks).toHaveBeenCalledTimes(3);
      });
      expect(mockFetchTasks).toHaveBeenLastCalledWith(
        undefined, undefined, "project-c", undefined, false
      );

      // Switch back to project A
      await act(async () => {
        rerender({ projectId: "project-a" });
      });

      await waitFor(() => {
        expect(mockFetchTasks).toHaveBeenCalledTimes(4);
      });
      expect(mockFetchTasks).toHaveBeenLastCalledWith(
        undefined, undefined, "project-a", undefined, false
      );
    });

    it("keeps tasks visible when searchQuery changes", async () => {
      const initialTasks = [
        createMockTask({ id: "FN-001", description: "Task 1" }),
      ];
      mockFetchTasks.mockResolvedValue(initialTasks);

      const { result, rerender } = renderHook(
        ({ projectId, searchQuery }: { projectId?: string; searchQuery?: string }) =>
          useTasks({ projectId, searchQuery }),
        { initialProps: { projectId: "project-a", searchQuery: undefined as string | undefined } }
      );

      await waitFor(() => {
        expect(result.current.tasks).toHaveLength(1);
      });

      // Change only searchQuery
      await act(async () => {
        rerender({ projectId: "project-a", searchQuery: "bug" });
      });

      // Tasks should NOT be cleared (search query change doesn't affect project context)
      expect(result.current.tasks).toHaveLength(1);

      // Still showing the same task
      expect(result.current.tasks[0].id).toBe("FN-001");
    });

    it("does not trigger immediate refresh when searchQuery changes", async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      const initialTasks = [createMockTask({ id: "FN-001", description: "Task 1" })];
      const searchedTasks = [createMockTask({ id: "FN-002", description: "bug fix" })];

      mockFetchTasks
        .mockResolvedValueOnce(initialTasks)
        .mockResolvedValue(searchedTasks);

      const { rerender } = renderHook(
        ({ projectId, searchQuery }: { projectId?: string; searchQuery?: string }) =>
          useTasks({ projectId, searchQuery }),
        { initialProps: { projectId: "project-a", searchQuery: undefined as string | undefined } }
      );

      await waitFor(() => {
        expect(mockFetchTasks).toHaveBeenCalledTimes(1);
      });

      await act(async () => {
        rerender({ projectId: "project-a", searchQuery: "bug" });
      });

      // Search query change should not trigger the initial-load effect.
      expect(mockFetchTasks).toHaveBeenCalledTimes(1);

      await act(async () => {
        vi.advanceTimersByTime(299);
      });
      expect(mockFetchTasks).toHaveBeenCalledTimes(1);

      await act(async () => {
        vi.advanceTimersByTime(1);
      });

      await waitFor(() => {
        expect(mockFetchTasks).toHaveBeenCalledTimes(2);
      });

      expect(mockFetchTasks).toHaveBeenLastCalledWith(
        undefined,
        undefined,
        "project-a",
        "bug",
        false,
      );
    });

    it("creates new EventSource for each project switch", async () => {
      mockFetchTasks.mockResolvedValue([]);

      const { rerender } = renderHook(
        ({ projectId }: { projectId?: string }) => useTasks({ projectId }),
        { initialProps: { projectId: "project-a" } }
      );

      await waitFor(() => {
        expect(MockEventSource.instances).toHaveLength(1);
      });

      const firstEventSource = MockEventSource.instances[0];

      // Switch to project B
      await act(async () => {
        rerender({ projectId: "project-b" });
      });

      await waitFor(() => {
        expect(MockEventSource.instances).toHaveLength(2);
      });

      const secondEventSource = MockEventSource.instances[1];

      // EventSources should be different instances
      expect(secondEventSource).not.toBe(firstEventSource);

      // Switch to project C
      await act(async () => {
        rerender({ projectId: "project-c" });
      });

      await waitFor(() => {
        expect(MockEventSource.instances).toHaveLength(3);
      });
    });

    it("rejects stale SSE events from multiple project switches", async () => {
      // Project A, B, C each have EventSource
      mockFetchTasks.mockResolvedValue([]);

      const { rerender } = renderHook(
        ({ projectId }: { projectId?: string }) => useTasks({ projectId }),
        { initialProps: { projectId: "project-a" } }
      );

      await waitFor(() => expect(MockEventSource.instances).toHaveLength(1));
      const esA = MockEventSource.instances[0];

      await act(async () => { rerender({ projectId: "project-b" }); });
      await waitFor(() => expect(MockEventSource.instances).toHaveLength(2));
      const esB = MockEventSource.instances[1];

      await act(async () => { rerender({ projectId: "project-c" }); });
      await waitFor(() => expect(MockEventSource.instances).toHaveLength(3));
      const esC = MockEventSource.instances[2];

      // Emit task:created from ALL old EventSources
      const taskA = createMockTask({ id: "FN-A1" });
      const taskB = createMockTask({ id: "FN-B1" });

      await act(async () => {
        esA._emit("task:created", taskA);
        esB._emit("task:created", taskB);
      });

      // Only the current EventSource (project C) events should be accepted
      await act(async () => {
        esC._emit("task:created", createMockTask({ id: "FN-C1" }));
      });

      // Should only have project C's task
      // Since fetchTasks returns empty array, only the SSE-added task remains
      await waitFor(() => {
        expect(MockEventSource.instances.length).toBe(3);
      });
    });
  });

  describe("sseEnabled option", () => {
    it("subscribes to SSE when sseEnabled is omitted (default)", async () => {
      renderHook(() => useTasks({ projectId: "test-project" }));

      await waitFor(() => {
        expect(MockEventSource.instances.length).toBeGreaterThanOrEqual(1);
      });
    });

    it("subscribes to SSE when sseEnabled is true", async () => {
      renderHook(() => useTasks({ projectId: "test-project", sseEnabled: true }));

      await waitFor(() => {
        expect(MockEventSource.instances.length).toBeGreaterThanOrEqual(1);
      });
    });

    it("does not subscribe to SSE when sseEnabled is false", async () => {
      renderHook(() => useTasks({ projectId: "test-project", sseEnabled: false }));

      // Give some time for effects to run
      await act(async () => {
        await flushPromises();
      });

      expect(MockEventSource.instances.length).toBe(0);
    });

    it("unsubscribes from SSE when sseEnabled toggles from true to false", async () => {
      const { rerender } = renderHook(
        ({ sseEnabled }: { sseEnabled?: boolean }) => useTasks({ projectId: "test-project", sseEnabled }),
        { initialProps: { sseEnabled: true } }
      );

      await waitFor(() => {
        expect(MockEventSource.instances.length).toBeGreaterThanOrEqual(1);
      });

      const esBefore = MockEventSource.instances[0];

      await act(async () => {
        rerender({ sseEnabled: false });
      });

      // The previous EventSource should have been closed
      expect(esBefore.close).toHaveBeenCalled();

      // No new EventSource should have been created
      await act(async () => {
        await flushPromises();
      });
      expect(MockEventSource.instances.length).toBe(1); // Same instance, just closed
    });

    it("resubscribes to SSE when sseEnabled toggles from false to true", async () => {
      const { rerender } = renderHook(
        ({ sseEnabled }: { sseEnabled?: boolean }) => useTasks({ projectId: "test-project", sseEnabled }),
        { initialProps: { sseEnabled: false } }
      );

      // No EventSource initially
      await act(async () => {
        await flushPromises();
      });
      expect(MockEventSource.instances.length).toBe(0);

      // Toggle to true
      await act(async () => {
        rerender({ sseEnabled: true });
      });

      await waitFor(() => {
        expect(MockEventSource.instances.length).toBeGreaterThanOrEqual(1);
      });
    });

    it("still fetches initial tasks when sseEnabled is false", async () => {
      mockFetchTasks.mockResolvedValue([
        createMockTask({ id: "FN-001", title: "Test Task" }),
      ]);

      renderHook(() => useTasks({ projectId: "test-project", sseEnabled: false }));

      await waitFor(() => {
        expect(mockFetchTasks).toHaveBeenCalled();
      });

      expect(MockEventSource.instances.length).toBe(0);
    });

    it("does not grow EventSource instances on repeated sseEnabled toggles", async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      const { rerender } = renderHook(
        ({ sseEnabled }: { sseEnabled?: boolean }) => useTasks({ projectId: "test-project", sseEnabled }),
        { initialProps: { sseEnabled: true } }
      );

      await waitFor(() => {
        expect(MockEventSource.instances.length).toBeGreaterThanOrEqual(1);
      });

      // Toggle false → true multiple times
      for (let i = 0; i < 3; i++) {
        await act(async () => {
          rerender({ sseEnabled: false });
        });
        await act(async () => {
          rerender({ sseEnabled: true });
        });
      }

      const countAfterToggles = MockEventSource.instances.length;

      // Advance fake timers — no pending reconnect timers should fire after teardown
      vi.advanceTimersByTime(4_000);

      // Count must not grow after timer advancement (the closed flag in sse-bus prevents
      // reconnect timers from creating zombie connections after channel teardown).
      expect(MockEventSource.instances.length).toBe(countAfterToggles);
      vi.useRealTimers();
    });

    it("does not trigger onReconnect refetch after sseEnabled flips to false", async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      const { rerender } = renderHook(
        ({ sseEnabled }: { sseEnabled?: boolean }) => useTasks({ projectId: "test-project", sseEnabled }),
        { initialProps: { sseEnabled: true } }
      );

      await waitFor(() => {
        expect(MockEventSource.instances.length).toBeGreaterThanOrEqual(1);
      });

      const es = MockEventSource.instances[0];
      mockFetchTasks.mockClear();

      // Simulate an error on the EventSource (triggers reconnect flow)
      act(() => {
        es._emit("error");
      });
      expect(mockFetchTasks).toHaveBeenCalledTimes(1); // onReconnect fires once during error

      // Before the reconnect timer fires, flip sseEnabled to false
      await act(async () => {
        rerender({ sseEnabled: false });
      });

      // Advance timers past RECONNECT_DELAY_MS (3 seconds)
      vi.advanceTimersByTime(4_000);

      // No additional fetchTasks should have been called — active flag blocked it
      expect(mockFetchTasks).toHaveBeenCalledTimes(1);
      vi.useRealTimers();
    });
  });
});
