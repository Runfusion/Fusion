/*
FNXC:BoardNavigation 2026-07-26-11:05:
Regression coverage for the mobile tab-discard reload: iOS Safari (tab + installed PWA) and Chrome
Android throw away a backgrounded dashboard and reload it when the operator returns, which used to
drop them at the top of the board because the scroll snapshot lived only in a useRef.
The invariant under test is the whole restore path, not just the storage round trip: the snapshot is
written at hide time, replayed only once the reloaded board actually has columns, and never wins over
the in-memory board -> task-detail -> back restore.
*/
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import {
  captureBoardScrollSnapshot,
  persistBoardScrollSnapshot,
  readPersistedBoardScrollSnapshot,
} from "../../utils/boardScrollSnapshot";
import type { ProjectInfo } from "../../api";
import { useBoardScrollRestore } from "../useBoardScrollRestore";
import { useViewState } from "../useViewState";

function mountBoard(options: { withColumns: boolean }): void {
  document.body.innerHTML = options.withColumns
    ? `
      <div class="project-content">
        <main id="board">
          <section class="column" data-column="todo"><div class="column-body"></div></section>
          <section class="column" data-column="in-progress"><div class="column-body"></div></section>
        </main>
      </div>
    `
    : `
      <div class="project-content">
        <main id="board"></main>
      </div>
    `;
}

function board(): HTMLElement {
  return document.getElementById("board") as HTMLElement;
}

function columnBody(columnId: string): HTMLElement {
  return document.querySelector(`[data-column="${columnId}"] .column-body`) as HTMLElement;
}

describe("board scroll restore across a reload", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    window.sessionStorage.clear();
    document.body.innerHTML = "";
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    window.sessionStorage.clear();
    document.body.innerHTML = "";
  });

  it("persists the board snapshot on hide and replays it after a simulated reload", () => {
    mountBoard({ withColumns: true });
    board().scrollLeft = 240;
    columnBody("todo").scrollTop = 380;

    const first = renderHook(() => useBoardScrollRestore("board"));

    // The tab is backgrounded/discarded: pagehide is the last callback we are guaranteed to run.
    act(() => {
      window.dispatchEvent(new Event("pagehide"));
    });

    expect(readPersistedBoardScrollSnapshot()).toMatchObject({
      boardLeft: 240,
      columnTops: { todo: 380, "in-progress": 0 },
    });

    // Simulated reload: hook state and DOM scroll offsets are gone, sessionStorage is not.
    first.unmount();
    mountBoard({ withColumns: true });
    expect(board().scrollLeft).toBe(0);

    renderHook(() => useBoardScrollRestore("board"));
    act(() => {
      vi.advanceTimersByTime(200);
    });

    expect(board().scrollLeft).toBe(240);
    expect(columnBody("todo").scrollTop).toBe(380);
  });

  it("does not restore against an empty board, and waits for the board to render", () => {
    persistBoardScrollSnapshot({
      boardLeft: 240,
      boardTop: 0,
      columnTops: { todo: 380 },
      projectContentLeft: 0,
      projectContentTop: 0,
      documentLeft: 0,
      documentTop: 0,
    });

    // A freshly reloaded board renders before its first fetch resolves: no columns yet.
    mountBoard({ withColumns: false });
    renderHook(() => useBoardScrollRestore("board"));

    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(board().scrollLeft).toBe(0);

    // Board content arrives; the bounded replay picks it up on a later tick.
    mountBoard({ withColumns: true });
    act(() => {
      vi.advanceTimersByTime(200);
    });

    expect(board().scrollLeft).toBe(240);
    expect(columnBody("todo").scrollTop).toBe(380);
  });

  it("gives up after the bounded replay budget instead of polling forever", () => {
    persistBoardScrollSnapshot({
      boardLeft: 240,
      boardTop: 0,
      columnTops: { todo: 380 },
      projectContentLeft: 0,
      projectContentTop: 0,
      documentLeft: 0,
      documentTop: 0,
    });
    mountBoard({ withColumns: false });
    renderHook(() => useBoardScrollRestore("board"));

    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    expect(vi.getTimerCount()).toBe(0);

    mountBoard({ withColumns: true });
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(board().scrollLeft).toBe(0);
  });

  it("ignores a stale persisted snapshot whose columns no longer exist", () => {
    persistBoardScrollSnapshot({
      boardLeft: 240,
      boardTop: 0,
      columnTops: { "column-from-another-project": 380 },
      projectContentLeft: 0,
      projectContentTop: 0,
      documentLeft: 0,
      documentTop: 0,
    });
    mountBoard({ withColumns: true });
    renderHook(() => useBoardScrollRestore("board"));

    act(() => {
      vi.advanceTimersByTime(10_000);
    });

    expect(board().scrollLeft).toBe(0);
  });

  it("lets the in-memory back-navigation restore win over the persisted snapshot", () => {
    // A stale persisted position from before the operator scrolled again.
    persistBoardScrollSnapshot({
      boardLeft: 999,
      boardTop: 0,
      columnTops: { todo: 999 },
      projectContentLeft: 0,
      projectContentTop: 0,
      documentLeft: 0,
      documentTop: 0,
    });
    mountBoard({ withColumns: true });
    board().scrollLeft = 120;
    columnBody("todo").scrollTop = 40;

    vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb: FrameRequestCallback) => {
      cb(0);
      return 0;
    });

    const { result, rerender } = renderHook(
      ({ taskView }: { taskView: "board" | "task-detail" }) => useBoardScrollRestore(taskView),
      { initialProps: { taskView: "board" } as { taskView: "board" | "task-detail" } },
    );

    // Opening task detail captures the live position; back-to-board restores it.
    act(() => {
      result.current.capture();
      rerender({ taskView: "task-detail" });
    });

    board().scrollLeft = 0;
    columnBody("todo").scrollTop = 0;

    act(() => {
      result.current.requestRestore();
      rerender({ taskView: "board" });
      vi.advanceTimersByTime(500);
    });

    expect(board().scrollLeft).toBe(120);
    expect(columnBody("todo").scrollTop).toBe(40);
    // capture() also refreshes the persisted copy so a discard right now restores the same place.
    expect(readPersistedBoardScrollSnapshot()).toMatchObject({ boardLeft: 120 });
  });

  it("captures nothing to persist when the board is not mounted", () => {

    document.body.innerHTML = "";
    expect(captureBoardScrollSnapshot()).toBeNull();

    renderHook(() => useBoardScrollRestore("board"));
    act(() => {
      window.dispatchEvent(new Event("pagehide"));
    });

    expect(readPersistedBoardScrollSnapshot()).toBeNull();
  });
});

/*
FNXC:ViewState 2026-07-26-11:30:
Companion coverage for the same discard-restore story on the VIEW axis: a tab that comes back from an
OS discard must keep the view the operator was on (Command Center / Settings included), while a
genuinely fresh boot keeps the FN-7649 bounce to Board.
*/
describe("task view restore across a reload", () => {
  const PROJECT: ProjectInfo = {
    id: "proj_reload",
    name: "Demo",
    path: "/demo",
    status: "active",
    isolationMode: "in-process",
    createdAt: "",
    updatedAt: "",
  };

  function options(): Parameters<typeof useViewState>[0] {
    return {
      projectsLoading: false,
      projectsError: null,
      currentProjectLoading: false,
      currentProject: PROJECT,
      projectsLength: 1,
      setupWizardOpen: false,
      openSetupWizard: vi.fn(),
      themeMode: "dark",
      setThemeMode: vi.fn(),
    };
  }

  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
  });

  afterEach(() => {
    localStorage.clear();
    sessionStorage.clear();
  });

  it("keeps command-center across a same-tab reload but bounces a fresh boot to board", async () => {
    const first = renderHook(() => useViewState(options()));
    await waitFor(() => {
      expect(first.result.current.taskView).toBe("board");
    });
    act(() => {
      first.result.current.handleChangeTaskView("command-center");
    });
    await waitFor(() => {
      expect(sessionStorage.getItem("kb:proj_reload:kb-dashboard-task-view-session")).toBe("command-center");
    });

    // Same tab, reloaded/restored: sessionStorage survives.
    first.unmount();
    const restored = renderHook(() => useViewState(options()));
    await waitFor(() => {
      expect(restored.result.current.taskView).toBe("command-center");
    });
    restored.unmount();

    // Fresh tab: sessionStorage is not inherited, so the landing guard still applies.
    sessionStorage.clear();
    const freshBoot = renderHook(() => useViewState(options()));
    await waitFor(() => {
      expect(freshBoot.result.current.taskView).toBe("board");
    });
  });

  it("does not restore task-detail, whose task snapshot is in-memory only", async () => {
    const first = renderHook(() => useViewState(options()));
    await waitFor(() => {
      expect(first.result.current.taskView).toBe("board");
    });
    act(() => {
      first.result.current.handleChangeTaskView("task-detail");
    });
    await waitFor(() => {
      expect(sessionStorage.getItem("kb:proj_reload:kb-dashboard-task-view-session")).toBe("task-detail");
    });
    first.unmount();

    const restored = renderHook(() => useViewState(options()));
    await waitFor(() => {
      expect(restored.result.current.taskView).toBe("board");
    });
  });
});
