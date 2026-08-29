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

  describe("enabled option", () => {
    it("fetches when enabled is true (default)", async () => {
      mockFetchSessionFiles.mockResolvedValueOnce(["file.ts"]);

      const { result } = renderHook(() =>
        useSessionFiles("FN-123", "/repo/.worktrees/kb-123", "in-progress", undefined, { enabled: true }),
      );

      await waitFor(() => expect(result.current.loading).toBe(false));
      expect(result.current.files).toEqual(["file.ts"]);
      expect(mockFetchSessionFiles).toHaveBeenCalled();
    });

    it("fetches when enabled is not specified (default)", async () => {
      mockFetchSessionFiles.mockResolvedValueOnce(["file.ts"]);

      const { result } = renderHook(() =>
        useSessionFiles("FN-123", "/repo/.worktrees/kb-123", "in-progress"),
      );

      await waitFor(() => expect(result.current.loading).toBe(false));
      expect(result.current.files).toEqual(["file.ts"]);
      expect(mockFetchSessionFiles).toHaveBeenCalled();
    });

    it("does not fetch when enabled is false", async () => {
      const { result } = renderHook(() =>
        useSessionFiles("FN-123", "/repo/.worktrees/kb-123", "in-progress", undefined, { enabled: false }),
      );

      await waitFor(() => expect(result.current.loading).toBe(false));
      expect(result.current.files).toEqual([]);
      expect(mockFetchSessionFiles).not.toHaveBeenCalled();
    });

    it("returns stable state (loading: false) when disabled", async () => {
      const { result } = renderHook(() =>
        useSessionFiles("FN-123", "/repo/.worktrees/kb-123", "in-progress", undefined, { enabled: false }),
      );

      // Immediately check (before any async)
      expect(result.current.loading).toBe(false);
      expect(result.current.files).toEqual([]);

      await waitFor(() => expect(result.current.loading).toBe(false));
      expect(result.current.files).toEqual([]);
      expect(mockFetchSessionFiles).not.toHaveBeenCalled();
    });
  });
});

/*
FNXC:WorkflowLifecycleColumns 2026-07-31-07:30 (dashboard-app feed):

THE INVARIANT: the Files tab loads for any column whose ROLE carries a worktree.

CENSUS-INVISIBLE. The gate was a `Set` literal — a definition, not a comparison — so nothing in the
lifecycle backlog pointed at this hook. Found by grepping for lane-shaped list literals after the
same shape turned up in `duplicate-intake`, `blocker-fanout` and the ephemeral zombie sweep.

On a renamed board the set matched nothing, so the fetch NEVER FIRED and the Files tab was
permanently empty for every card that had one. An empty file list is indistinguishable from a task
that touched no files, which is why nobody would report it.

The flags are collapsed to a boolean before the effect on purpose: `columnFlags` is an object, and a
caller constructing it inline would hand this hook a fresh identity every render, so putting it in
the dep array would refetch on every parent render. That is asserted below — a re-render with an
equal-but-not-identical flags object must not trigger a second fetch.

REVERT PROOF, measured: restore `ACTIVE_COLUMNS.has(column)` and the renamed-wip case fails with
zero fetches.
*/
describe("useSessionFiles resolves the column's role", () => {
  const WIP_FLAGS = { countsTowardWip: true } as never;
  const HOLD_FLAGS = { hold: true } as never;

  it("fetches for a RENAMED wip lane", async () => {
    mockFetchSessionFiles.mockResolvedValueOnce(["src/a.ts"]);

    const { result } = renderHook(() =>
      useSessionFiles("FN-123", "/repo/.worktrees/kb-123", "building", undefined, { columnFlags: WIP_FLAGS }));

    await waitFor(() => expect(result.current.files).toEqual(["src/a.ts"]));
  });

  it("does NOT fetch for a column whose role carries no worktree", async () => {
    /*
    The gate must still gate — a hold-lane card has no worktree to read.

    Asserted as a DELTA rather than "not called at all": this file's hooks are not unmounted between
    cases, so a prior case's in-flight fetch can land inside this one. The absolute assertion passed
    in isolation and failed in the suite, which is the classic shape of a test that would have been
    "fixed" by reordering rather than by being made independent.
    */
    const before = mockFetchSessionFiles.mock.calls.length;

    renderHook(() =>
      useSessionFiles("FN-123", "/repo/.worktrees/kb-123", "backlog", undefined, { columnFlags: HOLD_FLAGS }));

    await waitFor(() => expect(mockFetchSessionFiles.mock.calls.length).toBe(before));
  });

  it("does not refetch when an equal-but-new flags object arrives", async () => {
    // The object-identity trap the derived boolean exists to avoid.
    mockFetchSessionFiles.mockResolvedValue(["src/a.ts"]);

    const { rerender, result } = renderHook(
      ({ flags }) => useSessionFiles("FN-123", "/repo/.worktrees/kb-123", "building", undefined, { columnFlags: flags }),
      { initialProps: { flags: { countsTowardWip: true } as never } },
    );

    await waitFor(() => expect(result.current.files).toEqual(["src/a.ts"]));
    const callsAfterFirst = mockFetchSessionFiles.mock.calls.length;

    rerender({ flags: { countsTowardWip: true } as never });

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(mockFetchSessionFiles.mock.calls.length).toBe(callsAfterFirst);
  });
});
