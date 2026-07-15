import { describe, expect, it } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { usePoppedOutTasks } from "../usePoppedOutTasks";

const task = (id: string) => ({ id, title: id, status: "todo" } as never);

describe("usePoppedOutTasks", () => {
  it("popOut adds a task and upgrades duplicate-id snapshots and origins", () => {
    const { result } = renderHook(() => usePoppedOutTasks());
    const stale = { ...task("1"), title: "stale" };
    const fresh = { ...task("1"), title: "fresh" };

    act(() => {
      result.current.popOut(stale, "board");
      result.current.popOut(fresh);
      result.current.popOut(task("2"));
    });

    expect(result.current.tasks.map((t) => t.id)).toEqual(["1", "2"]);
    expect(result.current.entries[0]).toEqual({ task: fresh, originTaskView: undefined });
  });

  it("records the originating task view for view-attached popups", () => {
    const { result } = renderHook(() => usePoppedOutTasks());

    act(() => {
      result.current.popOut(task("1"), "board");
      result.current.popOut(task("2"), "list");
    });

    expect(result.current.entries.map((entry) => [entry.task.id, entry.originTaskView])).toEqual([
      ["1", "board"],
      ["2", "list"],
    ]);
  });

  it("close removes only the matching id", () => {
    const { result } = renderHook(() => usePoppedOutTasks());

    act(() => {
      result.current.popOut(task("1"));
      result.current.popOut(task("2"));
      result.current.close("1");
    });

    expect(result.current.tasks.map((t) => t.id)).toEqual(["2"]);
  });
});
