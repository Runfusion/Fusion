import { describe, expect, it } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { usePoppedOutTasks } from "../usePoppedOutTasks";

const task = (id: string) => ({ id, title: id, status: "todo" } as never);

describe("usePoppedOutTasks", () => {
  it("popOut adds a task and dedupes by id", () => {
    const { result } = renderHook(() => usePoppedOutTasks());

    act(() => {
      result.current.popOut(task("1"));
      result.current.popOut(task("1"));
      result.current.popOut(task("2"));
    });

    expect(result.current.tasks.map((t) => t.id)).toEqual(["1", "2"]);
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
