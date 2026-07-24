import { describe, expect, it } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { usePoppedOutTasks } from "../usePoppedOutTasks";

const task = (id: string) => ({ id, title: id, status: "todo" } as never);

describe("usePoppedOutTasks", () => {
  it("refreshes duplicate snapshots only for the same task and origin view", () => {
    const { result } = renderHook(() => usePoppedOutTasks());
    const stale = { ...task("1"), title: "stale" };
    const fresh = { ...task("1"), title: "fresh" };

    act(() => {
      result.current.popOut(stale, "board");
      result.current.popOut(fresh, "board");
      result.current.popOut(task("1"), "planning");
    });

    expect(result.current.entries).toEqual([
      { task: fresh, originTaskView: "board" },
      { task: task("1"), originTaskView: "planning" },
    ]);
  });

  it("refreshes the requested tab when reopening the same task and view", () => {
    const { result } = renderHook(() => usePoppedOutTasks());

    act(() => {
      result.current.popOut(task("1"), "board", "changes");
      result.current.popOut(task("1"), "board", "workflow");
    });

    expect(result.current.entries).toEqual([
      { task: task("1"), originTaskView: "board", initialTab: "workflow" },
    ]);
  });

  it("keeps the same task independently open on different origin views", () => {
    const { result } = renderHook(() => usePoppedOutTasks());

    act(() => {
      result.current.popOut(task("1"), "board");
      result.current.popOut(task("1"), "planning");
    });

    expect(result.current.entries.map((entry) => [entry.task.id, entry.originTaskView])).toEqual([
      ["1", "board"],
      ["1", "planning"],
    ]);
  });

  it("closes only the matching task and origin view", () => {
    const { result } = renderHook(() => usePoppedOutTasks());

    act(() => {
      result.current.popOut(task("1"), "board");
      result.current.popOut(task("1"), "planning");
      result.current.close("1", "planning");
    });

    expect(result.current.entries).toEqual([{ task: task("1"), originTaskView: "board" }]);
  });

  /*
  FNXC:ProjectSwitchModalReset 2026-07-23-00:00:
  A project swap dismisses every popped-out task window regardless of origin view — they
  are task-detail surfaces for the previous project.
  */
  it("closeAll dismisses every popped-out task across origin views", () => {
    const { result } = renderHook(() => usePoppedOutTasks());

    act(() => {
      result.current.popOut(task("1"), "board");
      result.current.popOut(task("2"), "planning");
      result.current.closeAll();
    });

    expect(result.current.entries).toEqual([]);
  });
});
