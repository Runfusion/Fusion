import { describe, expect, it, vi } from "vitest";
import { FusionApiClient, FusionApiError } from "../fusion-api-client.js";

function makeResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

describe("FusionApiClient", () => {
  it("sends auth header and parses list tasks", async () => {
    const fetchImpl = vi.fn(async () => makeResponse(200, [{ id: "FN-1", title: "a", description: "d", column: "todo", status: "todo" }]));
    const client = new FusionApiClient("http://localhost:4040", "secret", fetchImpl as typeof fetch);

    const tasks = await client.listTasks({ column: "todo", q: "abc" });

    expect(tasks).toHaveLength(1);
    const [url, options] = fetchImpl.mock.calls[0]! as unknown as [string, RequestInit];
    expect(url).toContain("/api/tasks?q=abc");
    expect(options.headers).toMatchObject({ Authorization: "Bearer secret", "Content-Type": "application/json" });
  });

  it("filters by status client-side", async () => {
    const fetchImpl = vi.fn(async () =>
      makeResponse(200, [
        { id: "FN-1", title: "a", description: "d", column: "todo", status: "todo" },
        { id: "FN-2", title: "b", description: "d", column: "in-review", status: "in-review" },
      ]),
    );
    const client = new FusionApiClient("http://localhost:4040", "secret", fetchImpl as typeof fetch);

    const tasks = await client.listTasks({ status: "in-review" });

    expect(tasks.map((task) => task.id)).toEqual(["FN-2"]);
  });

  it("encodes json body for create and move", async () => {
    const fetchImpl = vi
      .fn()
      .mockImplementationOnce(async () => makeResponse(200, { id: "FN-3", title: "x", description: "y", column: "triage" }))
      .mockImplementationOnce(async () => makeResponse(200, { id: "FN-3", title: "x", description: "y", column: "in-progress" }));
    const client = new FusionApiClient("http://localhost:4040", "secret", fetchImpl as typeof fetch);

    await client.createTask({ title: "x", description: "y", column: "triage" });
    await client.moveTask("FN-3", "in-progress");

    const [, firstOptions] = fetchImpl.mock.calls[0]! as unknown as [string, RequestInit];
    const [secondUrl, secondOptions] = fetchImpl.mock.calls[1]! as unknown as [string, RequestInit];
    expect(firstOptions.body).toBe(JSON.stringify({ title: "x", description: "y", column: "triage" }));
    expect(secondUrl).toContain("/api/tasks/FN-3/move");
    expect(secondOptions.method).toBe("POST");
    expect(secondOptions.body).toBe(JSON.stringify({ column: "in-progress" }));
  });

  it("maps non-2xx errors", async () => {
    const fetchImpl = vi.fn(async () => makeResponse(400, { error: "bad request" }));
    const client = new FusionApiClient("http://localhost:4040", "secret", fetchImpl as typeof fetch);

    await expect(client.getTask("FN-404")).rejects.toEqual(expect.any(FusionApiError));
    await expect(client.getTask("FN-404")).rejects.toMatchObject({ status: 400, body: { error: "bad request" } });
  });
});
