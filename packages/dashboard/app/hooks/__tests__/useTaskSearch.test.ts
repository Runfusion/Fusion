/**
 * FNXC:TaskSearch 2026-09-17-09:41:
 * FN-477 header-search controller. Each case below is a way the panel can show a WRONG but plausible
 * result: a late response overwriting a newer query, an A→B→A revival, a foreign project's rows
 * surviving a context switch, a duplicate-only page ending pagination early, a typing keystroke
 * silently billing a model, or a failed AI search rendering as a successful empty answer.
 */
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Task } from "@fusion/core";
import { useTaskSearch } from "../useTaskSearch";

const fetchTaskPage = vi.hoisted(() => vi.fn());
const aiSearchTasks = vi.hoisted(() => vi.fn());
vi.mock("../../api", () => ({ fetchTaskPage }));
vi.mock("../../api/tasks/tasks-search", () => ({ aiSearchTasks }));

function makeTask(id: string, overrides: Partial<Task> = {}): Task {
  return { id, title: `Title ${id}`, column: "todo", createdAt: "2026-01-01T00:00:00.000Z", ...overrides } as Task;
}

function page(tasks: Task[], nextCursor: string | null, total = tasks.length) {
  return { tasks, total, hasMore: Boolean(nextCursor), nextCursor };
}

/** A promise whose settlement the test controls, so response ORDER can be inverted deliberately. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const baseOptions = { projectId: "project-a", active: true };

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  fetchTaskPage.mockReset();
  aiSearchTasks.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

async function flushDebounce(ms = 250) {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
}

describe("useTaskSearch — text lane", () => {
  it("issues no request for a blank query or a project-less context", async () => {
    const { rerender } = renderHook((props: { query: string; projectId?: string }) =>
      useTaskSearch({ ...baseOptions, ...props }), { initialProps: { query: "   ", projectId: "project-a" } });
    await flushDebounce();
    expect(fetchTaskPage).not.toHaveBeenCalled();

    rerender({ query: "collapse", projectId: undefined });
    await flushDebounce();
    expect(fetchTaskPage).not.toHaveBeenCalled();
  });

  it("debounces typing into ONE request for the settled value", async () => {
    fetchTaskPage.mockResolvedValue(page([makeTask("FN-1")], null));
    const { rerender } = renderHook((props: { query: string }) => useTaskSearch({ ...baseOptions, ...props }),
      { initialProps: { query: "c" } });
    rerender({ query: "co" });
    rerender({ query: "collapse" });
    await flushDebounce();

    expect(fetchTaskPage).toHaveBeenCalledTimes(1);
    expect(fetchTaskPage.mock.calls[0][1]).toMatchObject({ query: "collapse" });
  });

  it("exposes more than eight results and pages past the old ceiling", async () => {
    const first = Array.from({ length: 8 }, (_unused, index) => makeTask(`FN-${index}`));
    const second = Array.from({ length: 4 }, (_unused, index) => makeTask(`FN-${index + 8}`));
    fetchTaskPage
      .mockResolvedValueOnce(page(first, "cursor-1", 12))
      .mockResolvedValueOnce(page(second, null, 12));

    const { result } = renderHook(() => useTaskSearch({ ...baseOptions, query: "collapse" }));
    await flushDebounce();

    await waitFor(() => expect(result.current.tasks).toHaveLength(8));
    expect(result.current.total).toBe(12);
    expect(result.current.hasMore).toBe(true);

    await act(async () => { await result.current.loadMore(); });

    // The ninth result — unreachable under the old fixed ceiling of eight — is now present.
    expect(result.current.tasks).toHaveLength(12);
    expect(result.current.tasks[8].id).toBe("FN-8");
    expect(result.current.hasMore).toBe(false);
  });

  it("keeps paging when a page contains only already-seen ids but advances the cursor", async () => {
    fetchTaskPage
      .mockResolvedValueOnce(page([makeTask("FN-1"), makeTask("FN-2")], "cursor-1", 3))
      .mockResolvedValueOnce(page([makeTask("FN-1"), makeTask("FN-2")], "cursor-2", 3))
      .mockResolvedValueOnce(page([makeTask("FN-3")], null, 3));

    const { result } = renderHook(() => useTaskSearch({ ...baseOptions, query: "collapse" }));
    await flushDebounce();
    await waitFor(() => expect(result.current.tasks).toHaveLength(2));

    await act(async () => { await result.current.loadMore(); });
    // Duplicates were absorbed, but the accepted continuation kept pagination alive.
    expect(result.current.tasks).toHaveLength(2);
    expect(result.current.hasMore).toBe(true);

    await act(async () => { await result.current.loadMore(); });
    expect(result.current.tasks.map((task) => task.id)).toEqual(["FN-1", "FN-2", "FN-3"]);
    expect(result.current.hasMore).toBe(false);
  });

  it("stops rather than looping when the server returns no continuation", async () => {
    fetchTaskPage.mockResolvedValue(page([makeTask("FN-1")], null, 1));
    const { result } = renderHook(() => useTaskSearch({ ...baseOptions, query: "collapse" }));
    await flushDebounce();
    await waitFor(() => expect(result.current.tasks).toHaveLength(1));

    await act(async () => { await result.current.loadMore(); });
    await act(async () => { await result.current.loadMore(); });

    expect(fetchTaskPage).toHaveBeenCalledTimes(1);
    expect(result.current.hasMore).toBe(false);
  });

  it("shows only the newest query when responses arrive in reverse order", async () => {
    const slow = deferred<ReturnType<typeof page>>();
    const fast = deferred<ReturnType<typeof page>>();
    fetchTaskPage.mockReturnValueOnce(slow.promise).mockReturnValueOnce(fast.promise);

    const { result, rerender } = renderHook((props: { query: string }) => useTaskSearch({ ...baseOptions, ...props }),
      { initialProps: { query: "collapse" } });
    await flushDebounce();
    rerender({ query: "autre" });
    await flushDebounce();

    // The SECOND query answers first, then the first query's stale response lands.
    await act(async () => { fast.resolve(page([makeTask("FN-AUTRE")], null)); await Promise.resolve(); });
    await act(async () => { slow.resolve(page([makeTask("FN-COLLAPSE")], null)); await Promise.resolve(); });

    expect(result.current.tasks.map((task) => task.id)).toEqual(["FN-AUTRE"]);
  });

  it("ignores the first A incarnation after an A → B → A cycle", async () => {
    const firstA = deferred<ReturnType<typeof page>>();
    fetchTaskPage
      .mockReturnValueOnce(firstA.promise)
      .mockResolvedValueOnce(page([makeTask("FN-B")], null))
      .mockResolvedValueOnce(page([makeTask("FN-A-SECOND")], null));

    const { result, rerender } = renderHook((props: { query: string }) => useTaskSearch({ ...baseOptions, ...props }),
      { initialProps: { query: "alpha" } });
    await flushDebounce();
    rerender({ query: "beta" });
    await flushDebounce();
    rerender({ query: "alpha" });
    await flushDebounce();

    await waitFor(() => expect(result.current.tasks.map((task) => task.id)).toEqual(["FN-A-SECOND"]));

    await act(async () => { firstA.resolve(page([makeTask("FN-A-FIRST")], null)); await Promise.resolve(); });

    // The revived text is identical, but the FIRST incarnation must still be fenced out.
    expect(result.current.tasks.map((task) => task.id)).toEqual(["FN-A-SECOND"]);
  });

  it("clears foreign rows immediately on a project switch that shares task ids", async () => {
    const pendingB = deferred<ReturnType<typeof page>>();
    fetchTaskPage
      .mockResolvedValueOnce(page([makeTask("FN-1", { title: "Projet A" })], null))
      .mockReturnValueOnce(pendingB.promise);

    const { result, rerender } = renderHook((props: { projectId: string }) =>
      useTaskSearch({ query: "collapse", active: true, ...props }), { initialProps: { projectId: "project-a" } });
    await flushDebounce();
    await waitFor(() => expect(result.current.tasks).toHaveLength(1));

    rerender({ projectId: "project-b" });

    // No render of project B ever carries project A's row, even though both use id FN-1.
    expect(result.current.tasks).toEqual([]);
    await act(async () => { pendingB.resolve(page([makeTask("FN-1", { title: "Projet B" })], null)); await Promise.resolve(); });
    await waitFor(() => expect(result.current.tasks[0]?.title).toBe("Projet B"));
  });

  it("clears foreign rows on a node switch that shares task ids", async () => {
    fetchTaskPage
      .mockResolvedValueOnce(page([makeTask("FN-1", { title: "Local" })], null))
      .mockResolvedValueOnce(page([makeTask("FN-1", { title: "Remote" })], null));

    const { result, rerender } = renderHook((props: { nodeId?: string }) =>
      useTaskSearch({ ...baseOptions, query: "collapse", ...props }), { initialProps: { nodeId: undefined } });
    await flushDebounce();
    await waitFor(() => expect(result.current.tasks[0]?.title).toBe("Local"));

    rerender({ nodeId: "node-b" });
    expect(result.current.tasks).toEqual([]);
    await flushDebounce();
    await waitFor(() => expect(result.current.tasks[0]?.title).toBe("Remote"));
    expect(fetchTaskPage.mock.calls[1][1]).toMatchObject({ nodeId: "node-b" });
  });

  it("reports a text failure without inventing an empty successful result", async () => {
    fetchTaskPage.mockRejectedValue(Object.assign(new Error("REQUEST_FAILED"), { status: 500 }));
    const { result } = renderHook(() => useTaskSearch({ ...baseOptions, query: "collapse" }));
    await flushDebounce();

    await waitFor(() => expect(result.current.error).toMatchObject({ kind: "text", status: 500 }));
    expect(result.current.loading).toBe(false);
  });

  it("does not let a stale request's teardown release the current request's loading state", async () => {
    const stale = deferred<ReturnType<typeof page>>();
    const current = deferred<ReturnType<typeof page>>();
    fetchTaskPage.mockReturnValueOnce(stale.promise).mockReturnValueOnce(current.promise);

    const { result, rerender } = renderHook((props: { query: string }) => useTaskSearch({ ...baseOptions, ...props }),
      { initialProps: { query: "alpha" } });
    await flushDebounce();
    rerender({ query: "beta" });
    await flushDebounce();

    await act(async () => { stale.reject(new Error("stale")); await Promise.resolve(); });

    // The old incarnation's rejection and its `finally` must leave the new request untouched.
    expect(result.current.error).toBeNull();
    expect(result.current.loading).toBe(true);

    await act(async () => { current.resolve(page([makeTask("FN-BETA")], null)); await Promise.resolve(); });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.tasks.map((task) => task.id)).toEqual(["FN-BETA"]);
  });
});

describe("useTaskSearch — AI lane", () => {
  it("never calls the AI route from typing alone", async () => {
    fetchTaskPage.mockResolvedValue(page([makeTask("FN-1")], null));
    const { rerender } = renderHook((props: { query: string }) => useTaskSearch({ ...baseOptions, ...props }),
      { initialProps: { query: "c" } });
    rerender({ query: "collapse" });
    await flushDebounce();
    expect(aiSearchTasks).not.toHaveBeenCalled();
  });

  it("runs exactly once per press, even before the text debounce has elapsed", async () => {
    fetchTaskPage.mockResolvedValue(page([], null));
    const pending = deferred<{ query: string; tasks: Task[] }>();
    aiSearchTasks.mockReturnValue(pending.promise);

    const { result } = renderHook(() => useTaskSearch({ ...baseOptions, query: "collapse" }));

    // Enter pressed immediately — the text debounce has NOT fired yet.
    await act(async () => { void result.current.runAiSearch(); });
    await act(async () => { void result.current.runAiSearch(); });
    await act(async () => { void result.current.runAiSearch(); });

    expect(aiSearchTasks).toHaveBeenCalledTimes(1);

    await act(async () => {
      pending.resolve({ query: "collapse", tasks: [makeTask("FN-1")] });
      await Promise.resolve();
    });
    await waitFor(() => expect(result.current.lane).toBe("ai"));
  });

  it("replaces the panel with the AI answer in the order the server returned", async () => {
    fetchTaskPage.mockResolvedValue(page([makeTask("FN-TEXT")], null));
    aiSearchTasks.mockResolvedValue({
      query: "collapse",
      tasks: ["FN-5", "FN-4", "FN-3", "FN-2", "FN-1"].map((id) => makeTask(id)),
    });

    const { result } = renderHook(() => useTaskSearch({ ...baseOptions, query: "collapse" }));
    await flushDebounce();
    await waitFor(() => expect(result.current.tasks.map((task) => task.id)).toEqual(["FN-TEXT"]));

    await act(async () => { await result.current.runAiSearch(); });

    expect(result.current.lane).toBe("ai");
    expect(result.current.tasks.map((task) => task.id)).toEqual(["FN-5", "FN-4", "FN-3", "FN-2", "FN-1"]);
    // The AI lane is not paginated.
    expect(result.current.hasMore).toBe(false);
  });

  it("discards an AI answer whose echoed query is no longer the field's value", async () => {
    fetchTaskPage.mockResolvedValue(page([], null));
    aiSearchTasks.mockResolvedValue({ query: "ancienne phrase", tasks: [makeTask("FN-STALE")] });

    const { result } = renderHook(() => useTaskSearch({ ...baseOptions, query: "collapse" }));
    await act(async () => { await result.current.runAiSearch(); });

    expect(result.current.tasks).toEqual([]);
    expect(result.current.lane).toBe("text");
  });

  it("returns to the text lane when the query changes, invalidating the AI answer", async () => {
    fetchTaskPage.mockResolvedValue(page([makeTask("FN-TEXT")], null));
    aiSearchTasks.mockResolvedValue({ query: "collapse", tasks: [makeTask("FN-AI")] });

    const { result, rerender } = renderHook((props: { query: string }) => useTaskSearch({ ...baseOptions, ...props }),
      { initialProps: { query: "collapse" } });
    await act(async () => { await result.current.runAiSearch(); });
    expect(result.current.lane).toBe("ai");

    rerender({ query: "collapse encore" });
    expect(result.current.lane).toBe("text");
    expect(result.current.tasks).toEqual([]);
  });

  it("keeps text matches labelled as text when the AI lane fails, and never auto-retries", async () => {
    fetchTaskPage.mockResolvedValue(page([makeTask("FN-TEXT")], null));
    aiSearchTasks.mockRejectedValue(Object.assign(new Error("AI_TASK_SEARCH_RATE_LIMIT"), { status: 429 }));

    const { result } = renderHook(() => useTaskSearch({ ...baseOptions, query: "collapse" }));
    await flushDebounce();
    await waitFor(() => expect(result.current.tasks).toHaveLength(1));

    await act(async () => { await result.current.runAiSearch(); });

    expect(result.current.error).toEqual({ kind: "ai", code: "AI_TASK_SEARCH_RATE_LIMIT", status: 429 });
    // The surviving rows are still the TEXT matches — they are not presented as an AI answer.
    expect(result.current.lane).toBe("text");
    expect(result.current.tasks.map((task) => task.id)).toEqual(["FN-TEXT"]);
    expect(result.current.aiLoading).toBe(false);

    // Nothing retries a model on its own; the operator may press Enter again.
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    expect(aiSearchTasks).toHaveBeenCalledTimes(1);

    await act(async () => { await result.current.runAiSearch(); });
    expect(aiSearchTasks).toHaveBeenCalledTimes(2);
  });

  it("does not leak a provider message into the reported error code", async () => {
    fetchTaskPage.mockResolvedValue(page([], null));
    aiSearchTasks.mockRejectedValue(new Error("upstream said: key sk-live-123 is invalid"));

    const { result } = renderHook(() => useTaskSearch({ ...baseOptions, query: "collapse" }));
    await act(async () => { await result.current.runAiSearch(); });

    expect(result.current.error?.code).toBe("REQUEST_FAILED");
    expect(JSON.stringify(result.current.error)).not.toContain("sk-live-123");
  });

  it("aborts the in-flight AI request when the panel closes and does not reopen it", async () => {
    fetchTaskPage.mockResolvedValue(page([], null));
    let observedSignal: AbortSignal | undefined;
    const pending = deferred<{ query: string; tasks: Task[] }>();
    aiSearchTasks.mockImplementation((_query: string, options: { signal?: AbortSignal }) => {
      observedSignal = options.signal;
      return pending.promise;
    });

    const { result, rerender } = renderHook((props: { active: boolean }) =>
      useTaskSearch({ ...baseOptions, query: "collapse", ...props }), { initialProps: { active: true } });
    await act(async () => { void result.current.runAiSearch(); });
    expect(observedSignal?.aborted).toBe(false);

    rerender({ active: false });
    expect(observedSignal?.aborted).toBe(true);

    await act(async () => { pending.resolve({ query: "collapse", tasks: [makeTask("FN-LATE")] }); await Promise.resolve(); });
    expect(result.current.tasks).toEqual([]);
    expect(result.current.aiLoading).toBe(false);
  });

  it("cancels in-flight work on unmount", async () => {
    fetchTaskPage.mockResolvedValue(page([], null));
    let observedSignal: AbortSignal | undefined;
    aiSearchTasks.mockImplementation((_query: string, options: { signal?: AbortSignal }) => {
      observedSignal = options.signal;
      return new Promise(() => undefined);
    });

    const { result, unmount } = renderHook(() => useTaskSearch({ ...baseOptions, query: "collapse" }));
    await act(async () => { void result.current.runAiSearch(); });
    unmount();
    expect(observedSignal?.aborted).toBe(true);
  });

  it("reset discards results and cancels work without changing the query", async () => {
    fetchTaskPage.mockResolvedValue(page([makeTask("FN-1")], null));
    const { result } = renderHook(() => useTaskSearch({ ...baseOptions, query: "collapse" }));
    await flushDebounce();
    await waitFor(() => expect(result.current.tasks).toHaveLength(1));

    act(() => { result.current.reset(); });

    expect(result.current.tasks).toEqual([]);
    expect(result.current.loading).toBe(false);
    expect(result.current.aiLoading).toBe(false);
  });
});
