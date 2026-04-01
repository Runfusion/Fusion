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
      });
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
});
