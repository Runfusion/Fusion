import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import type { Task } from "@fusion/core";

vi.mock("../../utils/projectStorage", () => ({
  getScopedItem: vi.fn(() => null),
  setScopedItem: vi.fn(),
}));

import { getScopedItem, setScopedItem } from "../../utils/projectStorage";
import { useBranchTaskFilters } from "../useBranchTaskFilters";
import { NO_BRANCH_FILTER_VALUE } from "../../utils/appLifecycle";

const task = (id: string, branch?: string, baseBranch?: string): Task =>
  ({ id, title: id, branch, baseBranch } as Task);

describe("useBranchTaskFilters", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("derives unique, sorted branch options and drops empty branches", () => {
    const { result } = renderHook(() =>
      useBranchTaskFilters({
        boardSourceTasks: [task("1", "zebra"), task("2", "  "), task("3", "alpha"), task("4", "alpha")],
        currentProjectId: "p1",
      }),
    );

    expect(result.current.branchOptions).toEqual(["alpha", "zebra"]);
  });

  it("excludes tasks that have a branch under the no-branch sentinel", () => {
    const { result } = renderHook(() =>
      useBranchTaskFilters({
        boardSourceTasks: [task("1", "feat"), task("2")],
        currentProjectId: "p1",
      }),
    );

    act(() => {
      result.current.onBranchFilterChange(NO_BRANCH_FILTER_VALUE);
    });

    expect(result.current.filteredBoardTasks.map((t) => t.id)).toEqual(["2"]);
  });

  it("excludes tasks whose branch does not match a concrete filter", () => {
    const { result } = renderHook(() =>
      useBranchTaskFilters({
        boardSourceTasks: [task("1", "feat"), task("2", "main")],
        currentProjectId: "p1",
      }),
    );

    act(() => {
      result.current.onBranchFilterChange("feat");
    });

    expect(result.current.filteredBoardTasks.map((t) => t.id)).toEqual(["1"]);
  });

  it("composes the base-branch filter independently", () => {
    const { result } = renderHook(() =>
      useBranchTaskFilters({
        boardSourceTasks: [
          task("1", "feat", "main"),
          task("2", "feat", "release"),
          task("3", "other", "main"),
        ],
        currentProjectId: "p1",
      }),
    );

    act(() => {
      result.current.onBranchFilterChange("feat");
      result.current.onBaseBranchFilterChange("main");
    });

    expect(result.current.filteredBoardTasks.map((t) => t.id)).toEqual(["1"]);
  });

  it("persists filter changes to scoped storage", () => {
    const { result } = renderHook(() =>
      useBranchTaskFilters({ boardSourceTasks: [], currentProjectId: "p1" }),
    );

    act(() => {
      result.current.onBaseBranchFilterChange("release");
    });

    expect(setScopedItem).toHaveBeenCalledWith(expect.any(String), "release", "p1");
  });

  it("re-reads scoped values when the project changes", () => {
    const { rerender } = renderHook(
      (props: { currentProjectId: string | undefined }) =>
        useBranchTaskFilters({ boardSourceTasks: [], currentProjectId: props.currentProjectId }),
      { initialProps: { currentProjectId: "p1" } },
    );

    rerender({ currentProjectId: "p2" });

    expect(getScopedItem).toHaveBeenCalledWith(expect.any(String), "p2");
  });
});
