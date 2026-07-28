import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { useBoardWorkflows } from "../useBoardWorkflows";
import type { BoardWorkflowsPayload } from "../../api";
import { ALL_WORKFLOWS_BOARD_VIEW_ID, readBoardWorkflowViewSelection } from "../../utils/boardWorkflowSelection";
import {
  __test_clearWorkflowSettingValuesRevisions,
  getWorkflowSettingValuesRevision,
} from "../../utils/workflowSettingValuesEvents";

function makePayload(overrides: Partial<BoardWorkflowsPayload> = {}): BoardWorkflowsPayload {
  return {
    flagEnabled: true,
    defaultWorkflowId: "wf-a",
    workflows: [
      { id: "wf-a", name: "Alpha", columns: [] },
      { id: "wf-b", name: "Beta", columns: [] },
    ],
    taskWorkflowIds: {},
    ...overrides,
  } as BoardWorkflowsPayload;
}

describe("useBoardWorkflows", () => {
  let subscribeHandlers: Record<string, (payload?: unknown) => void>;
  let unsubscribe: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    subscribeHandlers = {};
    unsubscribe = vi.fn();
    localStorage.clear();
    sessionStorage.clear();
    __test_clearWorkflowSettingValuesRevisions();
  });

  function makeDeps(fetchImpl: () => Promise<BoardWorkflowsPayload>) {
    return {
      fetchBoardWorkflows: vi.fn(fetchImpl),
      subscribeSse: vi.fn((_url: string, sub: { events?: Record<string, (p?: unknown) => void> }) => {
        subscribeHandlers = { ...(sub.events ?? {}) };
        return unsubscribe;
      }),
      readBoardWorkflowsCache: vi.fn(() => null),
      writeBoardWorkflowsCache: vi.fn(),
      /*
      FNXC:OriginWorkflowSelection 2026-07-26-19:40:
      Injected in the SHARED harness, not only in the mirror tests below: without it every
      lane change in this file would issue a real network call through the api module.
      */
      persistBoardWorkflowSelection: vi.fn(() => Promise.resolve({ workflowId: null })),
    };
  }

  it("initial fetch populates workflow options, writes cache, and selects the default", async () => {
    const payload = makePayload();
    const deps = makeDeps(() => Promise.resolve(payload));
    const { result } = renderHook(() => useBoardWorkflows({ projectId: "p1", ...deps }));

    await waitFor(() => expect(result.current.workflowOptions.length).toBe(2));
    expect(deps.fetchBoardWorkflows).toHaveBeenCalledTimes(1);
    expect(result.current.workflowMode).toBe(true);
    // Default sorts first.
    expect(result.current.workflowOptions[0].id).toBe("wf-a");
    expect(result.current.selectedWorkflow?.id).toBe("wf-a");
    expect(deps.writeBoardWorkflowsCache).toHaveBeenCalledWith("p1", payload);
  });

  it("hydrates board workflows synchronously from cache before refetch resolves", () => {
    const cachedPayload = makePayload({
      defaultWorkflowId: "wf-b",
      workflows: [
        { id: "wf-a", name: "Alpha", columns: [] },
        { id: "wf-b", name: "Beta", columns: [] },
      ],
    });
    const deps = makeDeps(() => new Promise<BoardWorkflowsPayload>(() => {}));
    deps.readBoardWorkflowsCache.mockReturnValue(cachedPayload);

    const { result } = renderHook(() => useBoardWorkflows({ projectId: "p1", ...deps }));

    expect(deps.readBoardWorkflowsCache).toHaveBeenCalledWith("p1");
    expect(result.current.boardWorkflows).toEqual(cachedPayload);
    expect(result.current.workflowOptions.map((workflow) => workflow.id)).toEqual(["wf-b", "wf-a"]);
    expect(result.current.selectedWorkflow?.id).toBe("wf-b");
    expect(deps.fetchBoardWorkflows).toHaveBeenCalledTimes(1);
  });

  it("re-hydrates per-project cache entries when the project changes", async () => {
    const projectOnePayload = makePayload({ defaultWorkflowId: "wf-a" });
    const projectTwoPayload = makePayload({
      defaultWorkflowId: "wf-c",
      workflows: [{ id: "wf-c", name: "Gamma", columns: [] }],
    });
    const deps = makeDeps(() => new Promise<BoardWorkflowsPayload>(() => {}));
    deps.readBoardWorkflowsCache.mockImplementation((projectId?: string) => {
      if (projectId === "p1") return projectOnePayload;
      if (projectId === "p2") return projectTwoPayload;
      return null;
    });

    const { result, rerender } = renderHook(
      ({ projectId }) => useBoardWorkflows({ projectId, ...deps }),
      { initialProps: { projectId: "p1" } },
    );

    expect(result.current.selectedWorkflow?.id).toBe("wf-a");

    rerender({ projectId: "p2" });

    await waitFor(() => expect(result.current.boardWorkflows).toEqual(projectTwoPayload));
    expect(result.current.workflowOptions.map((workflow) => workflow.id)).toEqual(["wf-c"]);
    expect(result.current.selectedWorkflow?.id).toBe("wf-c");
    expect(deps.readBoardWorkflowsCache).toHaveBeenCalledWith("p1");
    expect(deps.readBoardWorkflowsCache).toHaveBeenCalledWith("p2");
  });

  it("stale-response guard drops an out-of-order response", async () => {
    let resolveFirst: (p: BoardWorkflowsPayload) => void = () => {};
    let resolveSecond: (p: BoardWorkflowsPayload) => void = () => {};
    const promises = [
      new Promise<BoardWorkflowsPayload>((r) => { resolveFirst = r; }),
      new Promise<BoardWorkflowsPayload>((r) => { resolveSecond = r; }),
    ];
    let call = 0;
    const deps = makeDeps(() => promises[call++] ?? Promise.resolve(makePayload()));

    const { result } = renderHook(() => useBoardWorkflows({ projectId: "p1", ...deps }));
    // First fetch fired on mount; fire a second (newer) refresh.
    act(() => { result.current.refreshBoardWorkflows(); });

    // Resolve the SECOND (newest) request first — this should win.
    await act(async () => {
      resolveSecond(makePayload({ workflows: [{ id: "wf-new", name: "New", columns: [] }], defaultWorkflowId: "wf-new" }));
    });
    await waitFor(() => expect(result.current.selectedWorkflow?.id).toBe("wf-new"));

    // Now resolve the older request — it is stale and must be dropped.
    await act(async () => {
      resolveFirst(makePayload());
    });
    expect(result.current.selectedWorkflow?.id).toBe("wf-new");
    expect(result.current.workflowOptions.map((w) => w.id)).toEqual(["wf-new"]);
  });

  it("an SSE workflow event force-refreshes so chat-created workflows replace stale payloads", async () => {
    let payload = makePayload();
    const deps = makeDeps(() => Promise.resolve(payload));
    const { result } = renderHook(() => useBoardWorkflows({ projectId: "p1", ...deps }));

    await waitFor(() => expect(deps.fetchBoardWorkflows).toHaveBeenCalledTimes(1));
    expect(typeof subscribeHandlers["workflow:created"]).toBe("function");
    expect(typeof subscribeHandlers["workflow:updated"]).toBe("function");
    expect(typeof subscribeHandlers["workflow:deleted"]).toBe("function");

    payload = makePayload({
      workflows: [
        { id: "wf-a", name: "Alpha", columns: [] },
        { id: "wf-chat", name: "Chat Created", columns: [] },
      ],
    });
    await act(async () => { subscribeHandlers["workflow:created"](); });

    await waitFor(() => expect(result.current.workflowOptions.map((workflow) => workflow.id)).toContain("wf-chat"));
    expect(deps.fetchBoardWorkflows).toHaveBeenLastCalledWith("p1", { forceFresh: true });
    expect(deps.writeBoardWorkflowsCache).toHaveBeenLastCalledWith("p1", payload);
  });

  it("bridges authoritative oversight setting SSE once across duplicate consumers", async () => {
    const deps = makeDeps(() => Promise.resolve(makePayload()));
    renderHook(() => useBoardWorkflows({ projectId: "p1", ...deps }));
    await waitFor(() => expect(deps.fetchBoardWorkflows).toHaveBeenCalledTimes(1));

    const handler = subscribeHandlers["workflow:setting-values-updated"];
    expect(typeof handler).toBe("function");
    const event = new MessageEvent("workflow:setting-values-updated", {
      data: JSON.stringify({
        workflowId: "wf-a",
        projectId: "p1",
        settingIds: ["plannerOversightLevel"],
        mutationId: "revision-1",
      }),
    });
    act(() => {
      handler(event);
      handler(event);
    });

    expect(getWorkflowSettingValuesRevision("wf-a", "p1")).toBe(1);
  });

  it("preserves the Board-only aggregate sentinel while resolving a concrete fallback workflow", async () => {
    localStorage.setItem("kb:p1:kb-dashboard-board-workflow-selection", ALL_WORKFLOWS_BOARD_VIEW_ID);
    const deps = makeDeps(() => Promise.resolve(makePayload()));
    const { result } = renderHook(() => useBoardWorkflows({ projectId: "p1", ...deps }));

    await waitFor(() => expect(result.current.selectedWorkflow?.id).toBe("wf-a"));
    expect(result.current.selectedWorkflowId).toBe(ALL_WORKFLOWS_BOARD_VIEW_ID);
    expect(result.current.isAllWorkflowsSelected).toBe(true);
    expect(localStorage.getItem("kb:p1:kb-dashboard-board-workflow-selection")).toBe(ALL_WORKFLOWS_BOARD_VIEW_ID);
  });

  it("falls back to the default workflow when the selected workflow is deleted", async () => {
    let payload = makePayload();
    const deps = makeDeps(() => Promise.resolve(payload));
    const { result } = renderHook(() => useBoardWorkflows({ projectId: "p1", ...deps }));

    await waitFor(() => expect(result.current.selectedWorkflow?.id).toBe("wf-a"));
    act(() => { result.current.setSelectedWorkflowId("wf-b"); });
    await waitFor(() => expect(result.current.selectedWorkflow?.id).toBe("wf-b"));

    payload = makePayload({ workflows: [{ id: "wf-a", name: "Alpha", columns: [] }] });
    await act(async () => { result.current.refreshBoardWorkflows(); });

    await waitFor(() => {
      expect(result.current.selectedWorkflow?.id).toBe("wf-a");
      expect(result.current.selectedWorkflowId).toBe("wf-a");
    });
  });

  it("falls back to the first workflow when the default workflow is absent", async () => {
    let payload = makePayload();
    const deps = makeDeps(() => Promise.resolve(payload));
    const { result } = renderHook(() => useBoardWorkflows({ projectId: "p1", ...deps }));

    await waitFor(() => expect(result.current.selectedWorkflow?.id).toBe("wf-a"));
    act(() => { result.current.setSelectedWorkflowId("wf-b"); });
    await waitFor(() => expect(result.current.selectedWorkflow?.id).toBe("wf-b"));

    payload = makePayload({
      defaultWorkflowId: "wf-missing",
      workflows: [{ id: "wf-c", name: "Gamma", columns: [] }],
    });
    await act(async () => { result.current.refreshBoardWorkflows(); });

    await waitFor(() => {
      expect(result.current.selectedWorkflow?.id).toBe("wf-c");
      expect(result.current.selectedWorkflowId).toBe("wf-c");
    });
  });

  it("resets selection when workflow mode turns off", async () => {
    let payload = makePayload();
    const deps = makeDeps(() => Promise.resolve(payload));
    const { result } = renderHook(() => useBoardWorkflows({ projectId: "p1", ...deps }));

    await waitFor(() => expect(result.current.selectedWorkflow?.id).toBe("wf-a"));
    act(() => { result.current.setSelectedWorkflowId("wf-b"); });
    await waitFor(() => expect(result.current.selectedWorkflowId).toBe("wf-b"));

    payload = makePayload({ flagEnabled: false, workflows: [] });
    await act(async () => { result.current.refreshBoardWorkflows(); });

    await waitFor(() => {
      expect(result.current.workflowMode).toBe(false);
      expect(result.current.selectedWorkflow).toBeNull();
      expect(result.current.selectedWorkflowId).toBeNull();
    });
  });

  it("preserves the current payload and durable selection when a refresh fetch fails", async () => {
    let shouldReject = false;
    const deps = makeDeps(() => {
      if (shouldReject) return Promise.reject(new Error("temporary workflow API failure"));
      return Promise.resolve(makePayload());
    });
    const { result } = renderHook(() => useBoardWorkflows({ projectId: "p1", ...deps }));

    await waitFor(() => expect(result.current.selectedWorkflow?.id).toBe("wf-a"));
    act(() => { result.current.setSelectedWorkflowId("wf-b"); });
    await waitFor(() => expect(result.current.selectedWorkflow?.id).toBe("wf-b"));
    expect(localStorage.getItem("kb:p1:kb-dashboard-board-workflow-selection")).toBe("wf-b");

    shouldReject = true;
    await act(async () => {
      result.current.refreshBoardWorkflows();
      await Promise.resolve();
    });

    await waitFor(() => expect(deps.fetchBoardWorkflows).toHaveBeenCalledTimes(2));
    expect(result.current.workflowMode).toBe(true);
    expect(result.current.boardWorkflows).toEqual(makePayload());
    expect(result.current.selectedWorkflow?.id).toBe("wf-b");
    expect(result.current.selectedWorkflowId).toBe("wf-b");
    expect(localStorage.getItem("kb:p1:kb-dashboard-board-workflow-selection")).toBe("wf-b");
  });

  it("keeps selected workflow state isolated per hook consumer", async () => {
    const depsOne = makeDeps(() => Promise.resolve(makePayload()));
    const depsTwo = makeDeps(() => Promise.resolve(makePayload()));

    const first = renderHook(() => useBoardWorkflows({ projectId: "p1", ...depsOne }));
    const second = renderHook(() => useBoardWorkflows({ projectId: "p1", ...depsTwo }));

    await waitFor(() => expect(first.result.current.selectedWorkflow?.id).toBe("wf-a"));
    await waitFor(() => expect(second.result.current.selectedWorkflow?.id).toBe("wf-a"));

    act(() => { first.result.current.setSelectedWorkflowId("wf-b"); });

    await waitFor(() => expect(first.result.current.selectedWorkflow?.id).toBe("wf-b"));
    expect(second.result.current.selectedWorkflow?.id).toBe("wf-a");
    expect(second.result.current.selectedWorkflowId).toBe("wf-a");
  });

  it("unmount removes visibility/focus listeners and unsubscribes from SSE", async () => {
    const addSpy = vi.spyOn(document, "addEventListener");
    const removeSpy = vi.spyOn(document, "removeEventListener");
    const winRemoveSpy = vi.spyOn(window, "removeEventListener");

    const deps = makeDeps(() => Promise.resolve(makePayload()));
    const { unmount } = renderHook(() => useBoardWorkflows({ projectId: "p1", ...deps }));
    await waitFor(() => expect(deps.fetchBoardWorkflows).toHaveBeenCalled());

    expect(addSpy).toHaveBeenCalledWith("visibilitychange", expect.any(Function));

    unmount();
    expect(removeSpy).toHaveBeenCalledWith("visibilitychange", expect.any(Function));
    expect(winRemoveSpy).toHaveBeenCalledWith("focus", expect.any(Function));
    expect(unsubscribe).toHaveBeenCalledTimes(1);

    addSpy.mockRestore();
    removeSpy.mockRestore();
    winRemoveSpy.mockRestore();
  });
});

/*
FNXC:OriginWorkflowSelection 2026-07-26-19:40:
The Board lane lives in browser-local storage, which `fn task create`, the `fn_task_create`
agent tool, and refinement-from-CLI cannot read. These pin the server-side mirror that makes
the "Selected workflow" option of `taskCreateWorkflowId` / `refinementTaskWorkflowId` resolvable
off-browser, and pin that a failing mirror never disturbs the operator's lane.
*/
describe("useBoardWorkflows — board lane server mirror", () => {
  let subscribeHandlers: Record<string, (payload?: unknown) => void>;

  beforeEach(() => {
    subscribeHandlers = {};
    localStorage.clear();
    sessionStorage.clear();
  });

  function makeMirrorDeps(persist: ReturnType<typeof vi.fn>) {
    return {
      fetchBoardWorkflows: vi.fn(() => Promise.resolve(makePayload())),
      subscribeSse: vi.fn((_url: string, sub: { events?: Record<string, (p?: unknown) => void> }) => {
        subscribeHandlers = { ...(sub.events ?? {}) };
        return vi.fn();
      }),
      readBoardWorkflowsCache: vi.fn(() => null),
      writeBoardWorkflowsCache: vi.fn(),
      persistBoardWorkflowSelection: persist,
    };
  }

  it("mirrors a user lane change to the server alongside the local write", async () => {
    const persist = vi.fn(() => Promise.resolve({ workflowId: "wf-b" }));
    const { result } = renderHook(() => useBoardWorkflows({ projectId: "p1", ...makeMirrorDeps(persist) }));
    await waitFor(() => expect(result.current.workflowOptions.length).toBe(2));

    act(() => result.current.setSelectedWorkflowId("wf-b"));

    await waitFor(() => expect(persist).toHaveBeenCalledWith("wf-b", "p1"));
    expect(result.current.selectedWorkflowId).toBe("wf-b");
  });

  // The aggregate view is a Board-only sentinel, never a real workflow id. Mirroring it
  // would hand task creation "__all_workflows__" as a workflow to resolve.
  it("clears the mirror instead of persisting the all-workflows sentinel", async () => {
    const persist = vi.fn(() => Promise.resolve({ workflowId: null }));
    const { result } = renderHook(() => useBoardWorkflows({ projectId: "p1", ...makeMirrorDeps(persist) }));
    await waitFor(() => expect(result.current.workflowOptions.length).toBe(2));

    act(() => result.current.setSelectedWorkflowId(ALL_WORKFLOWS_BOARD_VIEW_ID));

    await waitFor(() => expect(persist).toHaveBeenCalledWith(null, "p1"));
    expect(persist).not.toHaveBeenCalledWith(ALL_WORKFLOWS_BOARD_VIEW_ID, "p1");
    expect(result.current.selectedWorkflowId).toBe(ALL_WORKFLOWS_BOARD_VIEW_ID);
  });

  it("clears the mirror when the selection is cleared", async () => {
    const persist = vi.fn(() => Promise.resolve({ workflowId: null }));
    const { result } = renderHook(() => useBoardWorkflows({ projectId: "p1", ...makeMirrorDeps(persist) }));
    await waitFor(() => expect(result.current.workflowOptions.length).toBe(2));

    act(() => result.current.setSelectedWorkflowId(null));

    await waitFor(() => expect(persist).toHaveBeenCalledWith(null, "p1"));
  });

  // localStorage already holds the authoritative selection; a mirror failure is a
  // best-effort miss, not a reason to revert or surface an error to the operator.
  it("keeps the lane switch when the mirror request rejects", async () => {
    const persist = vi.fn(() => Promise.reject(new Error("offline")));
    const { result } = renderHook(() => useBoardWorkflows({ projectId: "p1", ...makeMirrorDeps(persist) }));
    await waitFor(() => expect(result.current.workflowOptions.length).toBe(2));

    act(() => result.current.setSelectedWorkflowId("wf-b"));

    await waitFor(() => expect(persist).toHaveBeenCalled());
    expect(result.current.selectedWorkflowId).toBe("wf-b");
    expect(readBoardWorkflowViewSelection("p1")).toBe("wf-b");
  });

  it("does not mirror on mount, before the operator has chosen a lane", async () => {
    const persist = vi.fn(() => Promise.resolve({ workflowId: null }));
    const { result } = renderHook(() => useBoardWorkflows({ projectId: "p1", ...makeMirrorDeps(persist) }));
    await waitFor(() => expect(result.current.workflowOptions.length).toBe(2));

    expect(persist).not.toHaveBeenCalled();
    expect(subscribeHandlers).toBeDefined();
  });
});
