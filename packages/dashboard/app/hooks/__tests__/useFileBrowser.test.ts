import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { useFileBrowser } from "../useFileBrowser";
import * as api from "../../api";
import type { FileListResponse } from "../../api";

vi.mock("../../api", () => ({
  fetchFileList: vi.fn(),
}));

const mockFetchFileList = vi.mocked(api.fetchFileList);

function response(path: string, names: string[]): FileListResponse {
  return {
    path,
    entries: names.map((name) => ({
      name,
      type: name.includes(".") ? "file" : "directory",
      mtime: "2026-01-01T00:00:00.000Z",
      ...(name.includes(".") ? { size: 123 } : {}),
    })),
  };
}

describe("useFileBrowser", () => {
  beforeEach(() => {
    mockFetchFileList.mockReset();
    mockFetchFileList.mockResolvedValue(response(".", ["src", "README.md"]));
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("returns empty entries and loading=false when enabled=false", async () => {
    const { result } = renderHook(() => useFileBrowser("FN-001", false));

    expect(result.current.entries).toEqual([]);
    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBeNull();

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(mockFetchFileList).not.toHaveBeenCalled();
  });

  it("returns empty entries and loading=false when taskId is empty", async () => {
    const { result } = renderHook(() => useFileBrowser("", true));

    expect(result.current.entries).toEqual([]);
    expect(result.current.loading).toBe(false);

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(mockFetchFileList).not.toHaveBeenCalled();
  });

  it("fetches file list when enabled and sets loading then entries", async () => {
    const { result } = renderHook(() => useFileBrowser("FN-001", true));

    await waitFor(() => {
      expect(result.current.loading).toBe(true);
    });

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
      expect(result.current.entries).toHaveLength(2);
    });
  });

  it("populates entries from FileListResponse", async () => {
    mockFetchFileList.mockResolvedValueOnce(response(".", ["docs", "notes.md", "index.ts"]));

    const { result } = renderHook(() => useFileBrowser("FN-001", true));

    await waitFor(() => {
      expect(result.current.entries.map((entry) => entry.name)).toEqual(["docs", "notes.md", "index.ts"]);
    });
  });

  it("handles fetch error by setting error message and clearing entries", async () => {
    mockFetchFileList.mockRejectedValueOnce(new Error("Failed to load files"));

    const { result } = renderHook(() => useFileBrowser("FN-001", true));

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
      expect(result.current.error).toBe("Failed to load files");
    });

    expect(result.current.entries).toEqual([]);
  });

  it("setPath updates currentPath, clears error, and triggers new fetch", async () => {
    mockFetchFileList
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce(response("src", ["index.ts"]));

    const { result } = renderHook(() => useFileBrowser("FN-001", true, "project-1"));

    await waitFor(() => {
      expect(result.current.error).toBe("boom");
    });

    act(() => {
      result.current.setPath("src");
    });

    expect(result.current.currentPath).toBe("src");
    expect(result.current.error).toBeNull();

    await waitFor(() => {
      expect(mockFetchFileList).toHaveBeenLastCalledWith("FN-001", "src", "project-1");
      expect(result.current.entries.map((entry) => entry.name)).toEqual(["index.ts"]);
    });
  });

  it("normalizes '.' path to undefined when calling fetchFileList", async () => {
    const { result } = renderHook(() => useFileBrowser("FN-001", true, "project-1"));

    await waitFor(() => {
      expect(mockFetchFileList).toHaveBeenCalledWith("FN-001", undefined, "project-1");
    });

    act(() => {
      result.current.setPath(".");
    });

    await waitFor(() => {
      expect(mockFetchFileList).toHaveBeenLastCalledWith("FN-001", undefined, "project-1");
    });
  });

  it("passes non-dot paths directly to fetchFileList", async () => {
    const { result } = renderHook(() => useFileBrowser("FN-001", true, "project-1"));

    await waitFor(() => {
      expect(mockFetchFileList).toHaveBeenCalled();
    });

    act(() => {
      result.current.setPath("subdir");
    });

    await waitFor(() => {
      expect(mockFetchFileList).toHaveBeenLastCalledWith("FN-001", "subdir", "project-1");
    });
  });

  it("refresh increments refresh key and triggers re-fetch", async () => {
    mockFetchFileList
      .mockResolvedValueOnce(response(".", ["a.txt"]))
      .mockResolvedValueOnce(response(".", ["a.txt", "b.txt"]));

    const { result } = renderHook(() => useFileBrowser("FN-001", true));

    await waitFor(() => {
      expect(result.current.entries.map((entry) => entry.name)).toEqual(["a.txt"]);
    });

    act(() => {
      result.current.refresh();
    });

    await waitFor(() => {
      expect(result.current.entries.map((entry) => entry.name)).toEqual(["a.txt", "b.txt"]);
      expect(mockFetchFileList).toHaveBeenCalledTimes(2);
    });
  });

  it("cancels in-flight fetch on unmount", async () => {
    let resolveFetch!: (value: FileListResponse) => void;
    mockFetchFileList.mockReturnValueOnce(
      new Promise<FileListResponse>((resolve) => {
        resolveFetch = resolve;
      }),
    );

    const { unmount } = renderHook(() => useFileBrowser("FN-001", true));
    unmount();

    resolveFetch(response(".", ["late.txt"]));

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(mockFetchFileList).toHaveBeenCalledTimes(1);
  });
});
