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
});
