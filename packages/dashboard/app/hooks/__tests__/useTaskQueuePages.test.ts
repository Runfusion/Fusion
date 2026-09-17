/*
FNXC:TaskQueueOrder 2026-09-17-13:51:
FN-509 — the board's lane-head reader. The contract under test is deliberately narrow:

- one request per visible lane, carrying that lane's own server order;
- a project switch or a lane-scope change fences every in-flight response, so an A -> B -> A walk
  can never paint the first incarnation's rows into the third;
- one unavailable lane degrades to "no extra rows" instead of blanking the others, because the
  generic board page still carries the project's live work;
- a host that supplies no lane reader at all is a supported degradation, not a crash.
*/
import { describe, expect, it, vi, beforeEach } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { Task } from "@fusion/core";

const fetchTaskQueuePage = vi.fn();
vi.mock("../../api", () => ({
  get fetchTaskQueuePage() {
    return fetchTaskQueuePage;
  },
}));

const { useTaskQueuePages } = await import("../useTaskQueuePages");
type TaskQueueScope = import("../useTaskQueuePages").TaskQueueScope;

function makeTask(id: string, column: string): Task {
  return { id, title: id, description: "", column, dependencies: [], createdAt: "2026-09-17T10:00:00.000Z", updatedAt: "2026-09-17T10:00:00.000Z" } as Task;
}

const page = (...tasks: Task[]) => ({ tasks, total: tasks.length, hasMore: false, nextCursor: null });

const IDEAS: TaskQueueScope = { key: "ideas", columns: ["ideas"], order: "intake" };
const QUEUE: TaskQueueScope = { key: "todo", columns: ["todo"], order: "queue" };

describe("useTaskQueuePages", () => {
  beforeEach(() => {
    fetchTaskQueuePage.mockReset();
  });

  it("requests each visible lane in its own order and merges the heads by id", async () => {
    fetchTaskQueuePage.mockImplementation(async (_projectId: string, options: { columns: readonly string[] }) =>
      options.columns[0] === "ideas" ? page(makeTask("FN-9", "ideas")) : page(makeTask("FN-1", "todo"), makeTask("FN-9", "ideas")));

    const { result } = renderHook(() => useTaskQueuePages("p-1", [IDEAS, QUEUE], { limit: 25 }));

    await waitFor(() => expect(result.current.tasks.length).toBe(2));
    expect(result.current.tasks.map((task) => task.id).sort()).toEqual(["FN-1", "FN-9"]);
    expect(fetchTaskQueuePage).toHaveBeenCalledWith("p-1", expect.objectContaining({ columns: ["ideas"], order: "intake", limit: 25 }));
    expect(fetchTaskQueuePage).toHaveBeenCalledWith("p-1", expect.objectContaining({ columns: ["todo"], order: "queue", limit: 25 }));
  });

  it("does not re-request when the parent re-renders with an equivalent scope array", async () => {
    fetchTaskQueuePage.mockResolvedValue(page(makeTask("FN-1", "todo")));
    const { rerender, result } = renderHook(
      ({ scopes }: { scopes: TaskQueueScope[] }) => useTaskQueuePages("p-1", scopes),
      { initialProps: { scopes: [{ ...QUEUE }] } },
    );
    await waitFor(() => expect(result.current.tasks.length).toBe(1));
    rerender({ scopes: [{ ...QUEUE }] });
    rerender({ scopes: [{ ...QUEUE }] });
    expect(fetchTaskQueuePage).toHaveBeenCalledTimes(1);
  });

  it("fences a late response from a previous project so A -> B -> A cannot paint stale rows", async () => {
    let releaseFirst: (() => void) | undefined;
    fetchTaskQueuePage.mockImplementation(async (projectId: string) => {
      if (projectId === "p-1") {
        await new Promise<void>((resolve) => { releaseFirst = resolve; });
        return page(makeTask("FN-STALE", "todo"));
      }
      return page(makeTask("FN-B", "todo"));
    });

    const { rerender, result } = renderHook(
      ({ projectId }: { projectId: string }) => useTaskQueuePages(projectId, [QUEUE]),
      { initialProps: { projectId: "p-1" } },
    );
    rerender({ projectId: "p-2" });
    await waitFor(() => expect(result.current.tasks.map((task) => task.id)).toEqual(["FN-B"]));

    await act(async () => {
      releaseFirst?.();
      await Promise.resolve();
    });
    expect(result.current.tasks.map((task) => task.id)).toEqual(["FN-B"]);
  });

  it("keeps the other lanes when one lane read fails", async () => {
    fetchTaskQueuePage.mockImplementation(async (_projectId: string, options: { columns: readonly string[] }) => {
      if (options.columns[0] === "ideas") throw new Error("lane unavailable");
      return page(makeTask("FN-1", "todo"));
    });
    const { result } = renderHook(() => useTaskQueuePages("p-1", [IDEAS, QUEUE]));
    await waitFor(() => expect(result.current.tasks.map((task) => task.id)).toEqual(["FN-1"]));
    expect(result.current.error).toBeNull();
  });

  it("performs no request and reports no rows when disabled, project-less, or scope-less", async () => {
    const { result: disabled } = renderHook(() => useTaskQueuePages("p-1", [QUEUE], { enabled: false }));
    const { result: projectless } = renderHook(() => useTaskQueuePages(undefined, [QUEUE]));
    const { result: scopeless } = renderHook(() => useTaskQueuePages("p-1", []));
    await waitFor(() => expect(fetchTaskQueuePage).not.toHaveBeenCalled());
    for (const result of [disabled, projectless, scopeless]) {
      expect(result.current.tasks).toEqual([]);
      expect(result.current.loading).toBe(false);
    }
  });

  it("re-reads every lane head on demand, which is how a confirmed Boost resurfaces", async () => {
    fetchTaskQueuePage.mockResolvedValue(page(makeTask("FN-1", "todo")));
    const { result } = renderHook(() => useTaskQueuePages("p-1", [QUEUE]));
    await waitFor(() => expect(fetchTaskQueuePage).toHaveBeenCalledTimes(1));
    fetchTaskQueuePage.mockResolvedValue(page(makeTask("FN-BOOSTED", "todo")));
    act(() => result.current.refresh());
    await waitFor(() => expect(result.current.tasks.map((task) => task.id)).toEqual(["FN-BOOSTED"]));
  });
});
