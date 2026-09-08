import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchCompletedTasks } from "./tasks";

describe("fetchCompletedTasks", () => {
  afterEach(() => vi.restoreAllMocks());

  it("omits the cursor on page zero and serializes an opaque continuation unchanged", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(JSON.stringify({
      tasks: [], total: 0, hasMore: false, nextCursor: null,
      counts: { byColumn: {}, byWorkflow: {} },
    }), { status: 200, headers: { "content-type": "application/json" } }));

    await fetchCompletedTasks("project-a", 50, undefined, "completion-date-desc");
    await fetchCompletedTasks("project-a", 50, "opaque+/=cursor", "task-id-desc");

    const firstUrl = String(fetchMock.mock.calls[0]?.[0]);
    const nextUrl = String(fetchMock.mock.calls[1]?.[0]);
    expect(firstUrl).toContain("/tasks/done?limit=50&sort=completion-date-desc&projectId=project-a");
    expect(firstUrl).not.toContain("cursor=");
    expect(nextUrl).toContain("cursor=opaque%2B%2F%3Dcursor");
    expect(nextUrl).toContain("sort=task-id-desc");
  });
});
