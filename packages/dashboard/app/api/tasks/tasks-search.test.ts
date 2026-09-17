/**
 * FNXC:TaskSearch 2026-09-17-09:41:
 * FN-477 AI search client. The assertions pin the parts an operator cannot see going wrong: the
 * request must carry ONLY the phrase, must reach the remote node's proxy when a remote node is
 * selected, must never quietly answer a remote search from the local endpoint, and must expose a
 * bounded timeout so a wedged transport cannot leave the panel generating forever.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { aiSearchTasks } from "./tasks-search";
import { AI_TASK_SEARCH_CLIENT_TIMEOUT_MS, AI_TASK_SEARCH_PROXY_TIMEOUT_MS, AI_TASK_SEARCH_GENERATION_TIMEOUT_MS } from "../../../src/shared/task-search";

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function okResponse(body: unknown) {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

describe("aiSearchTasks", () => {
  it("POSTs only the query to the local endpoint with the shared client headers", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(okResponse({ query: "collapse", tasks: [] }));

    await aiSearchTasks("collapse", { projectId: "project-a" });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(String(url)).toBe("/api/ai/search-tasks?projectId=project-a");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({ query: "collapse" });
    // The client never selects a model, a lane, or a candidate set.
    expect(Object.keys(JSON.parse(String(init.body)))).toEqual(["query"]);
    const headers = new Headers(init.headers as HeadersInit);
    expect(headers.get("Content-Type")).toBe("application/json");
    expect(headers.get("x-fusion-client")).toBe("dashboard-ui");
  });

  it("routes a remote node through its proxy and never falls back to the local endpoint", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(okResponse({ query: "q", tasks: [] }));

    await aiSearchTasks("q", { projectId: "project-a", nodeId: "node-b", localNodeId: "local-1" });

    expect(String(fetchMock.mock.calls[0]?.[0])).toBe("/api/proxy/node-b/ai/search-tasks?projectId=project-a");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("stays local when the named node IS the local node", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(okResponse({ query: "q", tasks: [] }));
    await aiSearchTasks("q", { projectId: "project-a", nodeId: "local-1", localNodeId: "local-1" });
    expect(String(fetchMock.mock.calls[0]?.[0])).not.toContain("/proxy/");
  });

  it("does not retry after a remote failure", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: "AI_TASK_SEARCH_SERVICE_UNAVAILABLE" }), {
        status: 503,
        headers: { "content-type": "application/json" },
      }),
    );

    await expect(aiSearchTasks("q", { projectId: "project-a", nodeId: "node-b" })).rejects.toMatchObject({ status: 503 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("forwards a caller abort straight through to the request", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation((_url, init) =>
      new Promise((_resolve, reject) => {
        (init as RequestInit).signal?.addEventListener("abort", () => {
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        });
      }));

    const controller = new AbortController();
    const pending = aiSearchTasks("q", { projectId: "project-a", signal: controller.signal });
    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("aborts before dispatch when the caller signal is already aborted", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation((_url, init) =>
      new Promise((_resolve, reject) => {
        const signal = (init as RequestInit).signal;
        if (signal?.aborted) {
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
          return;
        }
        signal?.addEventListener("abort", () => reject(new Error("late")));
      }));

    const controller = new AbortController();
    controller.abort();
    await expect(aiSearchTasks("q", { projectId: "project-a", signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("bounds a wedged transport with its own client timeout", async () => {
    vi.useFakeTimers();
    vi.spyOn(globalThis, "fetch").mockImplementation((_url, init) =>
      new Promise((_resolve, reject) => {
        (init as RequestInit).signal?.addEventListener("abort", () => {
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        });
      }));

    const pending = aiSearchTasks("q", { projectId: "project-a" });
    const assertion = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    await vi.advanceTimersByTimeAsync(AI_TASK_SEARCH_CLIENT_TIMEOUT_MS + 10);
    await assertion;
  });

  it("keeps the timeout ladder ordered so each layer fails with its own diagnosis", () => {
    // Server generation < client ceiling < proxy budget: a real answer is never masked as a gateway
    // timeout, and a wedged transport is never masked as a model timeout.
    expect(AI_TASK_SEARCH_GENERATION_TIMEOUT_MS).toBeLessThan(AI_TASK_SEARCH_CLIENT_TIMEOUT_MS);
    expect(AI_TASK_SEARCH_CLIENT_TIMEOUT_MS).toBeLessThan(AI_TASK_SEARCH_PROXY_TIMEOUT_MS);
  });
});
