import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { useBoardWorkflows } from "../useBoardWorkflows";
import type { BoardWorkflowsPayload } from "../../api";

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

  it("an SSE workflow event re-fetches", async () => {
    const deps = makeDeps(() => Promise.resolve(makePayload()));
    renderHook(() => useBoardWorkflows({ projectId: "p1", ...deps }));

    await waitFor(() => expect(deps.fetchBoardWorkflows).toHaveBeenCalledTimes(1));
    expect(typeof subscribeHandlers["workflow:updated"]).toBe("function");

    await act(async () => { subscribeHandlers["workflow:updated"](); });
    expect(deps.fetchBoardWorkflows).toHaveBeenCalledTimes(2);
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
