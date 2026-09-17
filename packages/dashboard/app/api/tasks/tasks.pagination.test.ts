import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchTaskPage } from "./tasks";

afterEach(() => vi.restoreAllMocks());

describe("fetchTaskPage", () => {
  it("forwards the opaque cursor, search query, and AbortSignal", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      tasks: [], total: 0, hasMore: false, nextCursor: null,
    }), { status: 200, headers: { "content-type": "application/json" } }));
    const controller = new AbortController();

    await fetchTaskPage("project-a", { limit: 100, cursor: "opaque+/=cursor", query: "done work", signal: controller.signal });

    const url = String(fetchMock.mock.calls[0]?.[0]);
    expect(url).toContain("limit=100");
    expect(url).toContain("cursor=opaque%2B%2F%3Dcursor");
    expect(url).toContain("q=done+work");
    expect(url).toContain("projectId=project-a");
    expect(fetchMock.mock.calls[0]?.[1]).toEqual(expect.objectContaining({ signal: controller.signal }));
  });

  /*
  FNXC:TaskSearch 2026-09-17-09:41:
  FN-477 made the node optional so the header search can page a remote node. The two pre-existing
  `useTasks` call sites pass no node, so the request they issue must remain byte-identical.
  */
  it("stays a direct local request when no node is named", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      tasks: [], total: 0, hasMore: false, nextCursor: null,
    }), { status: 200, headers: { "content-type": "application/json" } }));

    await fetchTaskPage("project-a", { limit: 50, query: "collapse" });

    const url = String(fetchMock.mock.calls[0]?.[0]);
    expect(url).toBe("/api/tasks/page?limit=50&q=collapse&projectId=project-a");
    expect(url).not.toContain("/proxy/");
  });

  it("stays a direct local request when the named node IS the local node", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      tasks: [], total: 0, hasMore: false, nextCursor: null,
    }), { status: 200, headers: { "content-type": "application/json" } }));

    await fetchTaskPage("project-a", { query: "collapse", nodeId: "local-1", localNodeId: "local-1" });

    expect(String(fetchMock.mock.calls[0]?.[0])).not.toContain("/proxy/");
  });

  it("routes through the node proxy for a remote node, preserving every query parameter", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      tasks: [], total: 0, hasMore: false, nextCursor: null,
    }), { status: 200, headers: { "content-type": "application/json" } }));

    await fetchTaskPage("project-a", {
      limit: 50,
      cursor: "cur",
      query: "collapse",
      nodeId: "node b/1",
      localNodeId: "local-1",
    });

    const url = String(fetchMock.mock.calls[0]?.[0]);
    expect(url).toContain("/api/proxy/node%20b%2F1/tasks/page");
    expect(url).toContain("limit=50");
    expect(url).toContain("cursor=cur");
    expect(url).toContain("q=collapse");
    expect(url).toContain("projectId=project-a");
  });
});
