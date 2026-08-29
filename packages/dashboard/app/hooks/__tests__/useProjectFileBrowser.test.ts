import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { useProjectFileBrowser } from "../useProjectFileBrowser";
import * as api from "../../api";
import type { FileListResponse } from "../../api";

// Mock the api module
vi.mock("../../api", () => ({
  fetchWorkspaceFileList: vi.fn(),
}));

const mockFetchWorkspaceFileList = vi.mocked(api.fetchWorkspaceFileList);

describe("useProjectFileBrowser", () => {
  beforeEach(() => {
    mockFetchWorkspaceFileList.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("initializes with empty entries and loading false when disabled", () => {
    const { result } = renderHook(() => useProjectFileBrowser("/project", false));

    expect(result.current.entries).toEqual([]);
    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBeNull();
    expect(result.current.currentPath).toBe(".");
  });

  it("fetches file list when enabled", async () => {
    const mockResponse: FileListResponse = {
      path: ".",
      entries: [
        { name: "src", type: "directory", mtime: "2024-01-01T00:00:00Z" },
        { name: "package.json", type: "file", size: 100, mtime: "2024-01-01T00:00:00Z" },
      ],
    };
    mockFetchWorkspaceFileList.mockResolvedValueOnce(mockResponse);

    const { result } = renderHook(() => useProjectFileBrowser("/project", true));

    expect(result.current.loading).toBe(true);
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.entries).toHaveLength(2);
    expect(result.current.entries[0].name).toBe("src");
    expect(result.current.entries[1].name).toBe("package.json");
    expect(mockFetchWorkspaceFileList).toHaveBeenCalledWith("project", undefined);
  });

  it("fetches subdirectory when path changes", async () => {
    const rootResponse: FileListResponse = {
      path: ".",
      entries: [{ name: "src", type: "directory", mtime: "2024-01-01T00:00:00Z" }],
    };
    const subdirResponse: FileListResponse = {
      path: "src",
      entries: [{ name: "index.ts", type: "file", size: 200, mtime: "2024-01-01T00:00:00Z" }],
    };

    mockFetchWorkspaceFileList
      .mockResolvedValueOnce(rootResponse)
      .mockResolvedValueOnce(subdirResponse);

    const { result } = renderHook(() => useProjectFileBrowser("/project", true));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.entries).toHaveLength(1);

    act(() => {
      result.current.setPath("src");
    });

    await waitFor(() => expect(result.current.currentPath).toBe("src"));
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(mockFetchWorkspaceFileList).toHaveBeenLastCalledWith("project", "src");
  });

  it("handles fetch errors", async () => {
    mockFetchWorkspaceFileList.mockRejectedValueOnce(new Error("Failed to load files"));

    const { result } = renderHook(() => useProjectFileBrowser("/project", true));

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.error).toBe("Failed to load files");
    expect(result.current.entries).toEqual([]);
  });

  it("refreshes file list when refresh is called", async () => {
    const initialResponse: FileListResponse = {
      path: ".",
      entries: [{ name: "file1.txt", type: "file", size: 100, mtime: "2024-01-01T00:00:00Z" }],
    };
    const refreshedResponse: FileListResponse = {
      path: ".",
      entries: [
        { name: "file1.txt", type: "file", size: 100, mtime: "2024-01-01T00:00:00Z" },
        { name: "file2.txt", type: "file", size: 200, mtime: "2024-01-02T00:00:00Z" },
      ],
    };

    mockFetchWorkspaceFileList
      .mockResolvedValueOnce(initialResponse)
      .mockResolvedValueOnce(refreshedResponse);

    const { result } = renderHook(() => useProjectFileBrowser("/project", true));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.entries).toHaveLength(1);

    act(() => {
      result.current.refresh();
    });

    await waitFor(() => expect(result.current.entries).toHaveLength(2));
    expect(mockFetchWorkspaceFileList).toHaveBeenCalledTimes(2);
  });

  it("clears error when path changes", async () => {
    mockFetchWorkspaceFileList
      .mockRejectedValueOnce(new Error("Failed to load files"))
      .mockResolvedValueOnce({
        path: ".",
        entries: [{ name: "file.txt", type: "file", size: 100, mtime: "2024-01-01T00:00:00Z" }],
      });

    const { result } = renderHook(() => useProjectFileBrowser("/project", true));

    await waitFor(() => expect(result.current.error).toBe("Failed to load files"));

    act(() => {
      result.current.setPath("subdir");
    });

    expect(result.current.error).toBeNull();
  });

  it("does not fetch when disabled", async () => {
    renderHook(() => useProjectFileBrowser("/project", false));

    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(mockFetchWorkspaceFileList).not.toHaveBeenCalled();
  });

  it("cancels in-flight requests on unmount", async () => {
    let resolveFetch: (value: FileListResponse) => void;
    const fetchPromise = new Promise<FileListResponse>((resolve) => {
      resolveFetch = resolve;
    });
    mockFetchWorkspaceFileList.mockReturnValueOnce(fetchPromise);

    const { unmount } = renderHook(() => useProjectFileBrowser("/project", true));

    unmount();

    resolveFetch!({
      path: ".",
      entries: [{ name: "file.txt", type: "file", size: 100, mtime: "2024-01-01T00:00:00Z" }],
    });

    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(mockFetchWorkspaceFileList).toHaveBeenCalledTimes(1);
  });
});
