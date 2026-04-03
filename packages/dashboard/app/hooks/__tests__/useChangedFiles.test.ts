import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";
import { useChangedFiles } from "../useChangedFiles";
import * as api from "../../api";

vi.mock("../../api", () => ({
  fetchTaskFileDiffs: vi.fn(),
}));

const mockFetchTaskFileDiffs = vi.mocked(api.fetchTaskFileDiffs);

describe("useChangedFiles", () => {
  beforeEach(() => {
    mockFetchTaskFileDiffs.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("fetches changed files for active tasks with a worktree", async () => {
    mockFetchTaskFileDiffs.mockResolvedValueOnce([
      { path: "src/a.ts", status: "modified", diff: "diff --git a/src/a.ts b/src/a.ts" },
      { path: "src/b.ts", status: "added", diff: "diff --git a/src/b.ts b/src/b.ts" },
    ]);

    const { result } = renderHook(() => useChangedFiles("KB-651", "/repo/.worktrees/kb-651", "in-progress"));

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.error).toBeNull();
    expect(result.current.files).toHaveLength(2);
    // Hook no longer auto-selects; component handles selection
    expect(result.current.selectedFile).toBeNull();
    expect(mockFetchTaskFileDiffs).toHaveBeenCalledWith("KB-651", undefined);
  });

  it("does not fetch for tasks without worktrees or inactive columns", async () => {
    const { result: noWorktree } = renderHook(() => useChangedFiles("KB-651", undefined, "in-progress"));
    const { result: inactive } = renderHook(() => useChangedFiles("KB-651", "/repo/.worktrees/kb-651", "todo"));

    await waitFor(() => expect(noWorktree.current.loading).toBe(false));
    await waitFor(() => expect(inactive.current.loading).toBe(false));

    expect(noWorktree.current.files).toEqual([]);
    expect(noWorktree.current.selectedFile).toBeNull();
    expect(inactive.current.files).toEqual([]);
    expect(inactive.current.selectedFile).toBeNull();
    expect(mockFetchTaskFileDiffs).not.toHaveBeenCalled();
  });

  it("returns an error state on fetch failure", async () => {
    mockFetchTaskFileDiffs.mockRejectedValueOnce(new Error("boom"));

    const { result } = renderHook(() => useChangedFiles("KB-651", "/repo/.worktrees/kb-651", "in-review"));

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.files).toEqual([]);
    expect(result.current.selectedFile).toBeNull();
    expect(result.current.error).toBe("boom");
  });

  it("allows selecting a different file after data loads", async () => {
    mockFetchTaskFileDiffs.mockResolvedValueOnce([
      { path: "src/a.ts", status: "modified", diff: "first" },
      { path: "src/b.ts", status: "added", diff: "second" },
    ]);

    const { result } = renderHook(() => useChangedFiles("KB-651", "/repo/.worktrees/kb-651", "in-progress"));

    await waitFor(() => expect(result.current.loading).toBe(false));

    act(() => {
      result.current.setSelectedFile(result.current.files[1]!);
    });

    expect(result.current.selectedFile?.path).toBe("src/b.ts");
  });

  it("preserves selection when refetching finds a matching file", async () => {
    const fileA = { path: "src/a.ts", status: "modified" as const, diff: "first" };
    const fileB = { path: "src/b.ts", status: "added" as const, diff: "second" };

    mockFetchTaskFileDiffs.mockResolvedValueOnce([fileA, fileB]);

    const { result } = renderHook(() => useChangedFiles("KB-651", "/repo/.worktrees/kb-651", "in-progress"));

    await waitFor(() => expect(result.current.loading).toBe(false));

    // Manually select file B
    act(() => {
      result.current.setSelectedFile(fileB);
    });

    expect(result.current.selectedFile?.path).toBe("src/b.ts");
  });

  it("provides resetSelection that clears selectedFile", async () => {
    mockFetchTaskFileDiffs.mockResolvedValueOnce([
      { path: "src/a.ts", status: "modified", diff: "first" },
    ]);

    const { result } = renderHook(() => useChangedFiles("KB-651", "/repo/.worktrees/kb-651", "in-progress"));

    await waitFor(() => expect(result.current.loading).toBe(false));

    // Select a file
    act(() => {
      result.current.setSelectedFile(result.current.files[0]!);
    });

    expect(result.current.selectedFile?.path).toBe("src/a.ts");

    // Reset selection
    act(() => {
      result.current.resetSelection();
    });

    expect(result.current.selectedFile).toBeNull();
  });

  it("returns empty files and null selection when column is inactive", () => {
    const { result } = renderHook(() => useChangedFiles("KB-651", "/repo/.worktrees/kb-651", "done"));

    expect(result.current.files).toEqual([]);
    expect(result.current.loading).toBe(false);
    expect(result.current.selectedFile).toBeNull();
    expect(result.current.error).toBeNull();
  });
});
