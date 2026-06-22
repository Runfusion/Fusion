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

  it("initial fetch populates workflow options and selects the default", async () => {
    const deps = makeDeps(() => Promise.resolve(makePayload()));
    const { result } = renderHook(() => useBoardWorkflows({ projectId: "p1", ...deps }));

    await waitFor(() => expect(result.current.workflowOptions.length).toBe(2));
    expect(deps.fetchBoardWorkflows).toHaveBeenCalledTimes(1);
    expect(result.current.workflowMode).toBe(true);
    // Default sorts first.
    expect(result.current.workflowOptions[0].id).toBe("wf-a");
    expect(result.current.selectedWorkflow?.id).toBe("wf-a");
    expect(deps.writeBoardWorkflowsCache).toHaveBeenCalledWith("p1", expect.objectContaining({ flagEnabled: true }));
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
    const { result } = renderHook(() => useBoardWorkflows({ projectId: "p1", ...deps }));

    await waitFor(() => expect(deps.fetchBoardWorkflows).toHaveBeenCalledTimes(1));
    expect(typeof subscribeHandlers["workflow:updated"]).toBe("function");

    await act(async () => { subscribeHandlers["workflow:updated"](); });
    expect(deps.fetchBoardWorkflows).toHaveBeenCalledTimes(2);
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
