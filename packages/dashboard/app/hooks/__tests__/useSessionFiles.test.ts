import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { useSessionFiles } from "../useSessionFiles";
import * as api from "../../api";

vi.mock("../../api", () => ({
  fetchSessionFiles: vi.fn(),
}));

const mockFetchSessionFiles = vi.mocked(api.fetchSessionFiles);

describe("useSessionFiles", () => {
  beforeEach(() => {
    mockFetchSessionFiles.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("fetches session files for active tasks with a worktree", async () => {
    mockFetchSessionFiles.mockResolvedValueOnce(["src/a.ts", "src/b.ts"]);

    const { result } = renderHook(() => useSessionFiles("FN-123", "/repo/.worktrees/kb-123", "in-progress"));

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.files).toEqual(["src/a.ts", "src/b.ts"]);
    expect(mockFetchSessionFiles).toHaveBeenCalledWith("FN-123", undefined);
  });

  it("does not fetch for tasks without worktrees or inactive columns", async () => {
    const { result: noWorktree } = renderHook(() => useSessionFiles("FN-123", undefined, "in-progress"));
    const { result: inactive } = renderHook(() => useSessionFiles("FN-123", "/repo/.worktrees/kb-123", "todo"));

    await waitFor(() => expect(noWorktree.current.loading).toBe(false));
    await waitFor(() => expect(inactive.current.loading).toBe(false));

    expect(noWorktree.current.files).toEqual([]);
    expect(inactive.current.files).toEqual([]);
    expect(mockFetchSessionFiles).not.toHaveBeenCalled();
  });

  it("returns empty files on fetch failure", async () => {
    mockFetchSessionFiles.mockRejectedValueOnce(new Error("boom"));

    const { result } = renderHook(() => useSessionFiles("FN-123", "/repo/.worktrees/kb-123", "in-review"));

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.files).toEqual([]);
  });

  it("fetches session files for done column tasks with a worktree", async () => {
    mockFetchSessionFiles.mockResolvedValueOnce(["src/x.ts", "src/y.ts", "src/z.ts"]);

    const { result } = renderHook(() => useSessionFiles("FN-456", "/repo/.worktrees/kb-456", "done"));

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.files).toEqual(["src/x.ts", "src/y.ts", "src/z.ts"]);
    expect(mockFetchSessionFiles).toHaveBeenCalledWith("FN-456", undefined);
  });

  it("does not fetch for done column tasks without a worktree", async () => {
    const { result } = renderHook(() => useSessionFiles("FN-456", undefined, "done"));

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.files).toEqual([]);
    expect(mockFetchSessionFiles).not.toHaveBeenCalled();
  });
});
