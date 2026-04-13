import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { useFileEditor } from "../useFileEditor";
import * as api from "../../api";
import type { FileContentResponse, SaveFileResponse } from "../../api";

vi.mock("../../api", () => ({
  fetchFileContent: vi.fn(),
  saveFileContent: vi.fn(),
}));

const mockFetchFileContent = vi.mocked(api.fetchFileContent);
const mockSaveFileContent = vi.mocked(api.saveFileContent);

function contentResponse(content: string, mtime = "2026-01-01T00:00:00.000Z"): FileContentResponse {
  return {
    content,
    mtime,
    size: content.length,
  };
}

function saveResponse(mtime = "2026-01-02T00:00:00.000Z", size = 100): SaveFileResponse {
  return {
    success: true,
    mtime,
    size,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("useFileEditor", () => {
  beforeEach(() => {
    mockFetchFileContent.mockReset();
    mockSaveFileContent.mockReset();
    mockFetchFileContent.mockResolvedValue(contentResponse("hello"));
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("returns empty content when disabled or filePath is null", async () => {
    const disabled = renderHook(() => useFileEditor("FN-001", "README.md", false));
    expect(disabled.result.current.content).toBe("");
    expect(disabled.result.current.originalContent).toBe("");
    expect(disabled.result.current.mtime).toBeNull();

    const noPath = renderHook(() => useFileEditor("FN-001", null, true));
    expect(noPath.result.current.content).toBe("");
    expect(noPath.result.current.originalContent).toBe("");
    expect(noPath.result.current.mtime).toBeNull();

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(mockFetchFileContent).not.toHaveBeenCalled();
  });

  it("fetches file content when enabled and filePath is set", async () => {
    mockFetchFileContent.mockResolvedValueOnce(contentResponse("file body"));

    const { result } = renderHook(() => useFileEditor("FN-001", "README.md", true, "project-1"));

    await waitFor(() => {
      expect(result.current.loading).toBe(true);
    });

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
      expect(result.current.content).toBe("file body");
    });

    expect(mockFetchFileContent).toHaveBeenCalledWith("FN-001", "README.md", "project-1");
  });

  it("sets content and originalContent from fetch response", async () => {
    mockFetchFileContent.mockResolvedValueOnce(contentResponse("abc"));

    const { result } = renderHook(() => useFileEditor("FN-001", "a.txt", true));

    await waitFor(() => {
      expect(result.current.content).toBe("abc");
      expect(result.current.originalContent).toBe("abc");
    });
  });

  it("sets mtime from fetchFileContent response", async () => {
    mockFetchFileContent.mockResolvedValueOnce(contentResponse("abc", "2026-02-01T10:00:00.000Z"));

    const { result } = renderHook(() => useFileEditor("FN-001", "a.txt", true));

    await waitFor(() => {
      expect(result.current.mtime).toBe("2026-02-01T10:00:00.000Z");
    });
  });

  it("handles fetch error by setting error and clearing content/mtime", async () => {
    mockFetchFileContent.mockRejectedValueOnce(new Error("load failed"));

    const { result } = renderHook(() => useFileEditor("FN-001", "missing.txt", true));

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
      expect(result.current.error).toBe("load failed");
    });

    expect(result.current.content).toBe("");
    expect(result.current.originalContent).toBe("");
    expect(result.current.mtime).toBeNull();
  });

  it("setContent updates content and clears error", async () => {
    mockFetchFileContent.mockRejectedValueOnce(new Error("broken"));

    const { result } = renderHook(() => useFileEditor("FN-001", "bad.txt", true));

    await waitFor(() => {
      expect(result.current.error).toBe("broken");
    });

    act(() => {
      result.current.setContent("new content");
    });

    expect(result.current.content).toBe("new content");
    expect(result.current.error).toBeNull();
  });

  it("hasChanges is false when content equals originalContent", async () => {
    mockFetchFileContent.mockResolvedValueOnce(contentResponse("same"));

    const { result } = renderHook(() => useFileEditor("FN-001", "same.txt", true));

    await waitFor(() => {
      expect(result.current.hasChanges).toBe(false);
    });
  });

  it("hasChanges is true when content differs from originalContent", async () => {
    mockFetchFileContent.mockResolvedValueOnce(contentResponse("start"));

    const { result } = renderHook(() => useFileEditor("FN-001", "edit.txt", true));

    await waitFor(() => {
      expect(result.current.content).toBe("start");
    });

    act(() => {
      result.current.setContent("changed");
    });

    expect(result.current.hasChanges).toBe(true);
  });

  it("save calls saveFileContent with taskId, filePath, and current content", async () => {
    mockFetchFileContent.mockResolvedValueOnce(contentResponse("original"));
    mockSaveFileContent.mockResolvedValueOnce(saveResponse());

    const { result } = renderHook(() => useFileEditor("FN-001", "file.txt", true, "project-1"));

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    act(() => {
      result.current.setContent("updated");
    });

    await act(async () => {
      await result.current.save();
    });

    expect(mockSaveFileContent).toHaveBeenCalledWith("FN-001", "file.txt", "updated", "project-1");
  });

  it("save updates originalContent and mtime after success", async () => {
    mockFetchFileContent.mockResolvedValueOnce(contentResponse("before", "2026-01-01T00:00:00.000Z"));
    mockSaveFileContent.mockResolvedValueOnce(saveResponse("2026-02-01T00:00:00.000Z"));

    const { result } = renderHook(() => useFileEditor("FN-001", "file.txt", true));

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    act(() => {
      result.current.setContent("after");
    });

    await act(async () => {
      await result.current.save();
    });

    expect(result.current.originalContent).toBe("after");
    expect(result.current.mtime).toBe("2026-02-01T00:00:00.000Z");
    expect(result.current.hasChanges).toBe(false);
  });

  it("save sets error on failure and re-throws", async () => {
    mockFetchFileContent.mockResolvedValueOnce(contentResponse("before"));
    mockSaveFileContent.mockRejectedValueOnce(new Error("save failed"));

    const { result } = renderHook(() => useFileEditor("FN-001", "file.txt", true));

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    act(() => {
      result.current.setContent("changed");
    });

    await act(async () => {
      await expect(result.current.save()).rejects.toThrow("save failed");
    });

    await waitFor(() => {
      expect(result.current.error).toBe("save failed");
    });
  });

  it("save is a no-op when hasChanges is false", async () => {
    mockFetchFileContent.mockResolvedValueOnce(contentResponse("same"));

    const { result } = renderHook(() => useFileEditor("FN-001", "file.txt", true));

    await waitFor(() => {
      expect(result.current.hasChanges).toBe(false);
    });

    await act(async () => {
      await result.current.save();
    });

    expect(mockSaveFileContent).not.toHaveBeenCalled();
  });

  it("cancels in-flight load on filePath change and ignores stale response", async () => {
    const first = deferred<FileContentResponse>();
    const second = deferred<FileContentResponse>();

    mockFetchFileContent
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);

    const { result, rerender } = renderHook(
      ({ filePath }) => useFileEditor("FN-001", filePath, true),
      { initialProps: { filePath: "first.txt" as string | null } },
    );

    rerender({ filePath: "second.txt" });

    second.resolve(contentResponse("second-content", "2026-03-02T00:00:00.000Z"));

    await waitFor(() => {
      expect(result.current.content).toBe("second-content");
      expect(result.current.mtime).toBe("2026-03-02T00:00:00.000Z");
    });

    first.resolve(contentResponse("stale-first", "2026-03-01T00:00:00.000Z"));

    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(result.current.content).toBe("second-content");
    expect(result.current.mtime).toBe("2026-03-02T00:00:00.000Z");
  });
});
