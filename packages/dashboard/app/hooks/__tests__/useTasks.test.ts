import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { useTasks } from "../useTasks";
import * as api from "../../api";
import type { Task, Column } from "@kb/core";

// Mock the api module
vi.mock("../../api", () => ({
  fetchTasks: vi.fn().mockResolvedValue([]),
  createTask: vi.fn(),
  moveTask: vi.fn(),
  deleteTask: vi.fn(),
  mergeTask: vi.fn(),
  retryTask: vi.fn(),
}));

const mockFetchTasks = vi.mocked(api.fetchTasks);

// Mock EventSource
class MockEventSource {
  static instances: MockEventSource[] = [];
  url: string;
  listeners: Record<string, ((e: any) => void)[]> = {};
  readyState = 0;
  close = vi.fn();

  constructor(url: string) {
    this.url = url;
    this.readyState = 1;
    MockEventSource.instances.push(this);
  }

  addEventListener(event: string, fn: (e: any) => void) {
    if (!this.listeners[event]) this.listeners[event] = [];
    this.listeners[event].push(fn);
  }

  // Helper to simulate a server event
  _emit(event: string, data: unknown) {
    for (const fn of this.listeners[event] || []) {
      fn({ data: JSON.stringify(data) });
    }
  }
}

const originalEventSource = globalThis.EventSource;

beforeEach(() => {
  MockEventSource.instances = [];
  (globalThis as any).EventSource = MockEventSource;
  mockFetchTasks.mockReset().mockResolvedValue([]);
});

afterEach(() => {
  (globalThis as any).EventSource = originalEventSource;
});

function createMockTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "KB-001",
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

    expect(result.current.tasks[0].id).toBe("KB-001");
  });

  describe("SSE event: task:created", () => {
    it("adds new task to the list", async () => {
      mockFetchTasks.mockResolvedValueOnce([]);
      const { result } = renderHook(() => useTasks());

      await waitFor(() => {
        expect(MockEventSource.instances).toHaveLength(1);
      });

      const newTask = createMockTask({ id: "KB-002", column: "triage" });

      act(() => {
        MockEventSource.instances[0]._emit("task:created", newTask);
      });

      expect(result.current.tasks).toHaveLength(1);
      expect(result.current.tasks[0].id).toBe("KB-002");
    });
  });

  describe("SSE event: task:moved", () => {
    it("updates task column using the 'to' field", async () => {
      const initialTask = createMockTask({ id: "KB-001", column: "in-progress" as Column });
      mockFetchTasks.mockResolvedValueOnce([initialTask]);

      const { result } = renderHook(() => useTasks());

      await waitFor(() => {
        expect(result.current.tasks[0].column).toBe("in-progress");
      });

      const movedTaskData = {
        task: createMockTask({
          id: "KB-001",
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
        createMockTask({ id: "KB-001", column: "in-progress" as Column }),
        createMockTask({ id: "KB-002", column: "in-progress" as Column }),
      ];
      mockFetchTasks.mockResolvedValueOnce(tasks);

      const { result } = renderHook(() => useTasks());

      await waitFor(() => {
        expect(result.current.tasks).toHaveLength(2);
      });

      // Move KB-001 to done
      const movedTaskData = {
        task: createMockTask({
          id: "KB-001",
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
      expect(inProgressTasks[0].id).toBe("KB-002");
      expect(doneTasks).toHaveLength(1);
      expect(doneTasks[0].id).toBe("KB-001");
    });
  });

  describe("SSE event: task:updated", () => {
    it("updates task fields", async () => {
      const initialTask = createMockTask({
        id: "KB-001",
        title: "Old Title",
        column: "in-progress" as Column,
      });
      mockFetchTasks.mockResolvedValueOnce([initialTask]);

      const { result } = renderHook(() => useTasks());

      await waitFor(() => {
        expect(result.current.tasks[0].title).toBe("Old Title");
      });

      const updatedTask = createMockTask({
        id: "KB-001",
        title: "New Title",
        column: "in-progress" as Column,
        columnMovedAt: "2026-01-02T00:00:00Z",
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
        id: "KB-001",
        column: "in-progress" as Column,
        columnMovedAt: "2026-01-01T00:00:00Z",
      });
      mockFetchTasks.mockResolvedValueOnce([initialTask]);

      const { result } = renderHook(() => useTasks());

      await waitFor(() => {
        expect(result.current.tasks[0].column).toBe("in-progress");
      });

      // First, move to done (newer timestamp)
      const movedTaskData = {
        task: createMockTask({
          id: "KB-001",
          column: "in-progress",
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

      // Then, stale update arrives with old column and older timestamp
      const staleUpdate = createMockTask({
        id: "KB-001",
        column: "in-progress" as Column, // stale column
        columnMovedAt: "2026-01-01T00:00:00Z", // older timestamp
        title: "Some other update", // but other fields are new
      });

      act(() => {
        MockEventSource.instances[0]._emit("task:updated", staleUpdate);
      });

      // Column should remain 'done' (not revert to in-progress)
      expect(result.current.tasks[0].column).toBe("done");
      expect(result.current.tasks[0].columnMovedAt).toBe("2026-01-02T00:00:00Z");
      // But other fields should be updated
      expect(result.current.tasks[0].title).toBe("Some other update");
    });

    it("preserves current column when incoming has no columnMovedAt (legacy data)", async () => {
      const initialTask = createMockTask({
        id: "KB-001",
        column: "done" as Column,
        columnMovedAt: "2026-01-02T00:00:00Z",
      });
      mockFetchTasks.mockResolvedValueOnce([initialTask]);

      const { result } = renderHook(() => useTasks());

      await waitFor(() => {
        expect(result.current.tasks[0].column).toBe("done");
      });

      // Incoming update has no columnMovedAt (legacy) and different column
      const legacyUpdate = {
        ...createMockTask({
          id: "KB-001",
          column: "in-progress" as Column,
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
        createMockTask({ id: "KB-001" }),
        createMockTask({ id: "KB-002" }),
      ];
      mockFetchTasks.mockResolvedValueOnce(tasks);

      const { result } = renderHook(() => useTasks());

      await waitFor(() => {
        expect(result.current.tasks).toHaveLength(2);
      });

      act(() => {
        MockEventSource.instances[0]._emit("task:deleted", { id: "KB-001" });
      });

      expect(result.current.tasks).toHaveLength(1);
      expect(result.current.tasks[0].id).toBe("KB-002");
    });
  });

  describe("SSE event: task:merged", () => {
    it("ensures column is always done after merge", async () => {
      const initialTask = createMockTask({
        id: "KB-001",
        column: "in-review" as Column,
      });
      mockFetchTasks.mockResolvedValueOnce([initialTask]);

      const { result } = renderHook(() => useTasks());

      await waitFor(() => {
        expect(result.current.tasks[0].column).toBe("in-review");
      });

      const mergeResult = {
        task: createMockTask({
          id: "KB-001",
          column: "in-review" as Column, // might have stale column
        }),
        branch: "kb/kb-001",
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
        id: "KB-001",
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
          id: "KB-001",
          column: "todo",
          columnMovedAt: "2026-01-02T00:00:00Z",
          title: "Original Title",
        }),
        from: "todo" as Column,
        to: "in-progress" as Column,
      };

      const staleUpdate = createMockTask({
        id: "KB-001",
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
});
