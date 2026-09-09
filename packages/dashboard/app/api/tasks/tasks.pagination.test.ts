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
});
