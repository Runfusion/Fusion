import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { useWorkspaceFileBrowser } from "../useWorkspaceFileBrowser";
import * as api from "../../api";
import type { FileListResponse } from "../../api";

vi.mock("../../api", () => ({
  fetchWorkspaceFileList: vi.fn(),
}));

const mockFetchWorkspaceFileList = vi.mocked(api.fetchWorkspaceFileList);

describe("useWorkspaceFileBrowser", () => {
  beforeEach(() => {
    mockFetchWorkspaceFileList.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("fetches workspace files when enabled", async () => {
    const mockResponse: FileListResponse = {
      path: ".",
      entries: [{ name: "src", type: "directory", mtime: "2024-01-01T00:00:00Z" }],
    };
    mockFetchWorkspaceFileList.mockResolvedValueOnce(mockResponse);

    const { result } = renderHook(() => useWorkspaceFileBrowser("FN-123", true));

    expect(result.current.loading).toBe(true);
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.entries).toEqual(mockResponse.entries);
    expect(mockFetchWorkspaceFileList).toHaveBeenCalledWith("FN-123", undefined);
  });

  it("resets path when workspace changes", async () => {
    mockFetchWorkspaceFileList
      .mockResolvedValueOnce({ path: ".", entries: [{ name: "src", type: "directory", mtime: "2024-01-01T00:00:00Z" }] })
      .mockResolvedValueOnce({ path: "src", entries: [{ name: "index.ts", type: "file", size: 1, mtime: "2024-01-01T00:00:00Z" }] })
      .mockResolvedValueOnce({ path: ".", entries: [{ name: "README.md", type: "file", size: 5, mtime: "2024-01-01T00:00:00Z" }] });

    const { result, rerender } = renderHook(
      ({ workspace }) => useWorkspaceFileBrowser(workspace, true),
      { initialProps: { workspace: "FN-123" } },
    );

    await waitFor(() => expect(result.current.loading).toBe(false));

    act(() => {
      result.current.setPath("src");
    });

    await waitFor(() => expect(result.current.currentPath).toBe("src"));
    await waitFor(() => expect(mockFetchWorkspaceFileList).toHaveBeenLastCalledWith("FN-123", "src"));

    rerender({ workspace: "project" });

    await waitFor(() => expect(result.current.currentPath).toBe("."));
    await waitFor(() => expect(mockFetchWorkspaceFileList).toHaveBeenLastCalledWith("project", undefined));
  });

  it("handles fetch errors", async () => {
    mockFetchWorkspaceFileList.mockRejectedValueOnce(new Error("Failed to load files"));

    const { result } = renderHook(() => useWorkspaceFileBrowser("FN-404", true));

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.error).toBe("Failed to load files");
    expect(result.current.entries).toEqual([]);
  });

  it("returns hidden files and directories from the API response", async () => {
    const mockResponse: FileListResponse = {
      path: ".",
      entries: [
        { name: ".env.example", type: "file", size: 42, mtime: "2024-01-01T00:00:00Z" },
        { name: ".github", type: "directory", mtime: "2024-01-01T00:00:00Z" },
        { name: "src", type: "directory", mtime: "2024-01-01T00:00:00Z" },
      ],
    };
    mockFetchWorkspaceFileList.mockResolvedValueOnce(mockResponse);

    const { result } = renderHook(() => useWorkspaceFileBrowser("project", true));

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.entries).toEqual(mockResponse.entries);
    const names = result.current.entries.map((e) => e.name);
    expect(names).toContain(".env.example");
    expect(names).toContain(".github");
    expect(names).toContain("src");
  });
});
