import { describe, expect, it } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useMainPanelTaskDetail } from "../useMainPanelTaskDetail";

const task = (id: string) => ({ id, title: id, status: "todo" } as never);

describe("useMainPanelTaskDetail", () => {
  it("setTask accepts both a value and an updater", () => {
    const { result } = renderHook(() => useMainPanelTaskDetail());

    act(() => {
      result.current.setTask(task("1"));
    });
    expect(result.current.task?.id).toBe("1");

    act(() => {
      result.current.setTask((previous) => (previous ? { ...previous, title: "renamed" } : previous));
    });
    expect(result.current.task?.title).toBe("renamed");
  });

  it("setInitialTab updates the tab", () => {
    const { result } = renderHook(() => useMainPanelTaskDetail());

    act(() => {
      result.current.setInitialTab("changes");
    });
    expect(result.current.initialTab).toBe("changes");
  });
});
