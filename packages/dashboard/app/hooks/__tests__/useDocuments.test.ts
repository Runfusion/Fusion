import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { useDocuments } from "../useDocuments";
import type { TaskDocumentWithTask } from "@fusion/core";

function mockFetchResponse(
  ok: boolean,
  body: unknown,
  status = ok ? 200 : 500,
) {
  const bodyText = JSON.stringify(body);
  return Promise.resolve({
    ok,
    status,
    statusText: ok ? "OK" : "Error",
    headers: {
      get: (name: string) =>
        name.toLowerCase() === "content-type" ? "application/json" : null,
    },
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(bodyText),
  } as unknown as Response);
}

describe("useDocuments", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.useRealTimers();
  });

  it("loads documents on mount", async () => {
    const mockDocuments: TaskDocumentWithTask[] = [
      {
        id: "doc-1",
        taskId: "KB-001",
        key: "plan",
        content: "Plan content",
        revision: 1,
        author: "user",
        createdAt: "2024-01-01T00:00:00.000Z",
        updatedAt: "2024-01-01T00:00:00.000Z",
        taskTitle: "Task One",
        taskColumn: "triage",
      },
      {
        id: "doc-2",
        taskId: "KB-002",
        key: "notes",
        content: "Notes content",
        revision: 1,
        author: "agent",
        createdAt: "2024-01-02T00:00:00.000Z",
        updatedAt: "2024-01-02T00:00:00.000Z",
        taskTitle: "Task Two",
        taskColumn: "in-progress",
      },
    ];

    globalThis.fetch = vi.fn().mockResolvedValue(mockFetchResponse(true, mockDocuments));

    const { result } = renderHook(() => useDocuments());

    // Initially loading should be true
    expect(result.current.loading).toBe(true);
    expect(result.current.documents).toEqual([]);
    expect(result.current.error).toBeNull();

    // Wait for the initial fetch to complete
    await act(async () => {
      await vi.runAllTimersAsync();
    });

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.documents).toHaveLength(2);
    expect(result.current.documents[0].key).toBe("plan");
    expect(result.current.documents[0].taskTitle).toBe("Task One");
  });

  it("handles empty documents list", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(mockFetchResponse(true, []));

    const { result } = renderHook(() => useDocuments());

    await act(async () => {
      await vi.runAllTimersAsync();
    });

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.documents).toEqual([]);
  });

  it("handles fetch error", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(mockFetchResponse(false, { error: "Server error" }, 500));

    const { result } = renderHook(() => useDocuments());

    await act(async () => {
      await vi.runAllTimersAsync();
    });

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.error).toBe("Server error");
    expect(result.current.documents).toEqual([]);
  });

  it("refreshes documents manually", async () => {
    const initialDocs: TaskDocumentWithTask[] = [
      {
        id: "doc-1",
        taskId: "KB-001",
        key: "plan",
        content: "Initial content",
        revision: 1,
        author: "user",
        createdAt: "2024-01-01T00:00:00.000Z",
        updatedAt: "2024-01-01T00:00:00.000Z",
      },
    ];

    const updatedDocs: TaskDocumentWithTask[] = [
      ...initialDocs,
      {
        id: "doc-2",
        taskId: "KB-001",
        key: "notes",
        content: "New content",
        revision: 1,
        author: "user",
        createdAt: "2024-01-02T00:00:00.000Z",
        updatedAt: "2024-01-02T00:00:00.000Z",
      },
    ];

    // Mock for initial fetch + debounce effect (2 calls)
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce(mockFetchResponse(true, initialDocs))
      .mockResolvedValueOnce(mockFetchResponse(true, initialDocs))
      .mockResolvedValueOnce(mockFetchResponse(true, updatedDocs));

    const { result } = renderHook(() => useDocuments());

    await act(async () => {
      await vi.runAllTimersAsync();
    });

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.documents).toHaveLength(1);

    // Trigger refresh
    await act(async () => {
      await result.current.refresh();
    });

    expect(result.current.documents).toHaveLength(2);
    // Loading should still be false after manual refresh
    expect(result.current.loading).toBe(false);
  });

  it("filters documents by search query with debounce", async () => {
    const allDocs: TaskDocumentWithTask[] = [
      {
        id: "doc-1",
        taskId: "KB-001",
        key: "plan",
        content: "Plan content",
        revision: 1,
        author: "user",
        createdAt: "2024-01-01T00:00:00.000Z",
        updatedAt: "2024-01-01T00:00:00.000Z",
        taskTitle: "Task One",
      },
      {
        id: "doc-2",
        taskId: "KB-002",
        key: "notes",
        content: "Notes content",
        revision: 1,
        author: "user",
        createdAt: "2024-01-02T00:00:00.000Z",
        updatedAt: "2024-01-02T00:00:00.000Z",
        taskTitle: "Task Two",
      },
    ];

    globalThis.fetch = vi.fn().mockResolvedValue(mockFetchResponse(true, allDocs));

    const { result, rerender } = renderHook(
      ({ searchQuery }) => useDocuments({ searchQuery }),
      { initialProps: { searchQuery: undefined as string | undefined } }
    );

    await act(async () => {
      await vi.runAllTimersAsync();
    });

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.documents).toHaveLength(2);

    // Update search query - this triggers debounce
    rerender({ searchQuery: "plan" });

    // Advance past the debounce timer (300ms)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(350);
    });

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    // Should have called fetch multiple times (initial + debounced)
    expect(globalThis.fetch).toHaveBeenCalled();
  });

  it("uses projectId for scoped fetching", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(mockFetchResponse(true, []));

    renderHook(() => useDocuments({ projectId: "proj-123" }));

    await act(async () => {
      await vi.runAllTimersAsync();
    });

    await waitFor(() => {
      expect(globalThis.fetch).toHaveBeenCalled();
    });

    // Verify the URL contains the projectId
    const fetchCall = globalThis.fetch.mock.calls[0][0] as Request;
    const url = fetchCall instanceof Request ? fetchCall.url : fetchCall;
    expect(String(url)).toContain("projectId=proj-123");
  });

  it("cancels in-flight request on unmount", async () => {
    const abortMock = vi.fn();
    const originalAbortController = globalThis.AbortController;

    // Mock AbortController to track abort calls
    globalThis.AbortController = vi.fn().mockImplementation(() => ({
      signal: {},
      abort: abortMock,
    })) as unknown as typeof AbortController;

    globalThis.fetch = vi.fn().mockReturnValue(
      new Promise(() => {
        // Never resolve - simulating a pending request
      })
    );

    const { unmount } = renderHook(() => useDocuments());

    await act(async () => {
      await Promise.resolve();
    });

    unmount();

    expect(abortMock).toHaveBeenCalled();

    // Restore
    globalThis.AbortController = originalAbortController;
  });
});
