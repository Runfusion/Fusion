import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { useDocuments } from "../useDocuments";
import type { TaskDocumentWithTask } from "@fusion/core";
import type { MarkdownFileEntry } from "../../api";

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

function createDocumentsFetchMock(options: {
  documents: TaskDocumentWithTask[];
  projectFiles: MarkdownFileEntry[];
  failProjectFiles?: boolean;
  failDocuments?: boolean;
}) {
  return vi.fn().mockImplementation((input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;

    if (url.includes("/project-files/md")) {
      if (options.failProjectFiles) {
        return mockFetchResponse(false, { error: "Project files failed" }, 500);
      }
      return mockFetchResponse(true, options.projectFiles);
    }

    if (url.includes("/documents")) {
      if (options.failDocuments) {
        return mockFetchResponse(false, { error: "Documents failed" }, 500);
      }
      return mockFetchResponse(true, options.documents);
    }

    throw new Error(`Unexpected fetch URL: ${url}`);
  });
}

describe("useDocuments", () => {
  const originalFetch = globalThis.fetch;

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

  const mockProjectFiles: MarkdownFileEntry[] = [
    {
      path: "README.md",
      name: "README.md",
      size: 1024,
      mtime: "2024-01-03T00:00:00.000Z",
      contentPreview: "# Project README",
    },
    {
      path: "docs/CONTRIBUTING.md",
      name: "CONTRIBUTING.md",
      size: 900,
      mtime: "2024-01-04T00:00:00.000Z",
      contentPreview: "Contribution guide",
    },
  ];

  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.useRealTimers();
  });

  it("loads task documents and project markdown files on mount", async () => {
    globalThis.fetch = createDocumentsFetchMock({
      documents: mockDocuments,
      projectFiles: mockProjectFiles,
    });

    const { result } = renderHook(() => useDocuments());

    expect(result.current.loading).toBe(true);
    expect(result.current.documents).toEqual([]);
    expect(result.current.projectFiles).toEqual([]);

    await act(async () => {
      await vi.runAllTimersAsync();
    });

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.error).toBeNull();
    expect(result.current.documents).toHaveLength(2);
    expect(result.current.projectFiles).toHaveLength(2);
    expect(result.current.projectFiles[0].name).toBe("README.md");
  });

  it("continues rendering documents when project file fetch fails", async () => {
    globalThis.fetch = createDocumentsFetchMock({
      documents: mockDocuments,
      projectFiles: [],
      failProjectFiles: true,
    });

    const { result } = renderHook(() => useDocuments());

    await act(async () => {
      await vi.runAllTimersAsync();
    });

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.documents).toHaveLength(2);
    expect(result.current.projectFiles).toEqual([]);
    expect(result.current.error).toBeNull();
  });

  it("surfaces task document fetch errors", async () => {
    globalThis.fetch = createDocumentsFetchMock({
      documents: [],
      projectFiles: mockProjectFiles,
      failDocuments: true,
    });

    const { result } = renderHook(() => useDocuments());

    await act(async () => {
      await vi.runAllTimersAsync();
    });

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.error).toBe("Documents failed");
    expect(result.current.documents).toEqual([]);
    expect(result.current.projectFiles).toHaveLength(2);
  });

  it("passes search query to both document and project file endpoints", async () => {
    globalThis.fetch = createDocumentsFetchMock({
      documents: mockDocuments,
      projectFiles: mockProjectFiles,
    });

    const { rerender } = renderHook(
      ({ searchQuery }) => useDocuments({ searchQuery }),
      { initialProps: { searchQuery: undefined as string | undefined } },
    );

    await act(async () => {
      await vi.runAllTimersAsync();
    });

    rerender({ searchQuery: "readme" });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(350);
    });

    await waitFor(() => {
      const urls = globalThis.fetch.mock.calls.map((call) => String(call[0]));
      expect(urls.some((url) => url.includes("/documents?q=readme"))).toBe(true);
      expect(urls.some((url) => url.includes("/project-files/md?q=readme"))).toBe(true);
    });
  });

  it("uses projectId for both document and project file requests", async () => {
    globalThis.fetch = createDocumentsFetchMock({
      documents: mockDocuments,
      projectFiles: mockProjectFiles,
    });

    renderHook(() => useDocuments({ projectId: "proj-123" }));

    await act(async () => {
      await vi.runAllTimersAsync();
    });

    await waitFor(() => {
      const urls = globalThis.fetch.mock.calls.map((call) => String(call[0]));
      expect(urls.some((url) => url.includes("/documents") && url.includes("projectId=proj-123"))).toBe(true);
      expect(urls.some((url) => url.includes("/project-files/md") && url.includes("projectId=proj-123"))).toBe(true);
    });
  });

  it("cancels in-flight request on unmount", async () => {
    const abortMock = vi.fn();
    const originalAbortController = globalThis.AbortController;

    globalThis.AbortController = vi.fn().mockImplementation(() => ({
      signal: {},
      abort: abortMock,
    })) as unknown as typeof AbortController;

    globalThis.fetch = vi.fn().mockReturnValue(
      new Promise(() => {
        // Keep pending to simulate in-flight requests
      }),
    );

    const { unmount } = renderHook(() => useDocuments());

    await act(async () => {
      await Promise.resolve();
    });

    unmount();

    expect(abortMock).toHaveBeenCalled();

    globalThis.AbortController = originalAbortController;
  });
});
