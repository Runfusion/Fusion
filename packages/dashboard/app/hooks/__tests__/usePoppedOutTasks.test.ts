import { describe, expect, it } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { usePoppedOutTasks } from "../usePoppedOutTasks";

const task = (id: string) => ({ id, title: id, status: "todo" } as never);

/*
FNXC:TaskWindowIdentity 2026-09-14-17:46:
FN-392: a task owns exactly one window per project, identified by its task id alone. Opening it again from any other
view refreshes its snapshot and requested tab in place and advances the focus nonce, so the window is raised rather
than duplicated or remounted. Closing and project-wide dismissal use the same id-only identity.
*/
describe("usePoppedOutTasks", () => {
  it("keeps one entry per task and refreshes its snapshot in place", () => {
    const { result } = renderHook(() => usePoppedOutTasks());
    const stale = { ...task("1"), title: "stale" };
    const fresh = { ...task("1"), title: "fresh" };

    act(() => {
      result.current.popOut(stale);
      result.current.popOut(fresh);
      result.current.popOut(task("2"));
    });

    expect(result.current.entries).toEqual([
      { task: fresh, focusNonce: 2 },
      { task: task("2"), focusNonce: 1 },
    ]);
    expect(result.current.tasks.map((entry) => entry.id)).toEqual(["1", "2"]);
  });

  it("refreshes the requested tab when reopening a task and keeps the previous one otherwise", () => {
    const { result } = renderHook(() => usePoppedOutTasks());

    act(() => {
      result.current.popOut(task("1"), "changes");
      result.current.popOut(task("1"), "workflow");
    });
    expect(result.current.entries).toEqual([{ task: task("1"), initialTab: "workflow", focusNonce: 2 }]);

    act(() => result.current.popOut(task("1")));
    expect(result.current.entries).toEqual([{ task: task("1"), initialTab: "workflow", focusNonce: 3 }]);
  });

  it("never opens the same task twice, whichever surface requests it", () => {
    const { result } = renderHook(() => usePoppedOutTasks());

    act(() => {
      result.current.popOut(task("1"));
      result.current.popOut(task("1"));
      result.current.popOut(task("1"), "chat");
    });

    expect(result.current.entries).toHaveLength(1);
    expect(result.current.entries[0].focusNonce).toBe(3);
  });

  it("closes only the matching task", () => {
    const { result } = renderHook(() => usePoppedOutTasks());

    act(() => {
      result.current.popOut(task("1"));
      result.current.popOut(task("2"));
      result.current.close("2");
    });

    expect(result.current.entries).toEqual([{ task: task("1"), focusNonce: 1 }]);
  });

  /*
  FNXC:ProjectSwitchModalReset 2026-07-23-00:00:
  A project swap dismisses every popped-out task window — they are task-detail surfaces for the previous project.
  */
  it("closeAll dismisses every popped-out task", () => {
    const { result } = renderHook(() => usePoppedOutTasks());

    act(() => {
      result.current.popOut(task("1"));
      result.current.popOut(task("2"));
      result.current.closeAll();
    });

    expect(result.current.entries).toEqual([]);
  });
});
