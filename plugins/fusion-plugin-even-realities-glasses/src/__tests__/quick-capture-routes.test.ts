import { describe, expect, it, vi } from "vitest";
import { quickCaptureRoutes } from "../routes/quick-capture-routes.js";

function getRoute() {
  const route = quickCaptureRoutes.find((entry) => entry.method === "POST" && entry.path === "/quick-capture");
  if (!route) throw new Error("missing /quick-capture route");
  return route;
}

function createCtx(overrides: Record<string, unknown> = {}) {
  return {
    pluginId: "fusion-plugin-even-realities-glasses",
    // `triage` was removed from the default lineage by #2515; capture now falls to the
    // workflow's own intake column rather than creating a card in a column it does not declare.
    settings: { apiKey: "secret", quickCaptureDefaultColumn: "triage" },
    taskStore: {
      createTask: vi.fn(async (input) => ({ id: "FN-100", ...input, title: "write the spec", column: input.column })),
    },
    logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
    ...overrides,
  } as never;
}

describe("quickCaptureRoutes", () => {
  it("returns 401 for missing or wrong api key", async () => {
    const route = getRoute();
    const ctx = createCtx();
    const missing = await route.handler({ body: { text: "hello" }, headers: {} } as never, ctx);
    const wrong = await route.handler(
      { body: { text: "hello" }, headers: { authorization: "Bearer nope" } } as never,
      ctx,
    );
    expect(missing).toMatchObject({ status: 401 });
    expect(wrong).toMatchObject({ status: 401 });
  });

  it.each([undefined, "", "   "])("returns 400 for empty text: %p", async (text) => {
    const route = getRoute();
    const ctx = createCtx();
    const res = await route.handler(
      { body: { text }, headers: { authorization: "Bearer secret" } } as never,
      ctx,
    );
    expect(res).toMatchObject({ status: 400, body: { error: "empty utterance" } });
  });

  it("returns 400 for invalid column", async () => {
    const route = getRoute();
    const ctx = createCtx();
    const res = await route.handler(
      { body: { text: "hello", column: "bad" }, headers: { authorization: "Bearer secret" } } as never,
      ctx,
    );
    expect(res).toMatchObject({ status: 400 });
  });

  it("returns 201 with task and card, using default column", async () => {
    const route = getRoute();
    const createTask = vi.fn(async (input) => ({ id: "FN-9", ...input, title: "write the spec", column: input.column }));
    const ctx = createCtx({ taskStore: { createTask } });

    const res = await route.handler(
      { body: { text: "hey fusion, um, write the spec" }, headers: { authorization: "Bearer secret" } } as never,
      ctx,
    );

    expect(res).toMatchObject({ status: 201, body: { task: { id: "FN-9" }, card: { id: expect.any(String), kind: "task" } } });
    expect(createTask).toHaveBeenCalledTimes(1);
    expect(createTask).toHaveBeenCalledWith(
      expect.objectContaining({
        column: "todo",
        description: expect.stringContaining("write the spec"),
        source: expect.objectContaining({ sourceMetadata: expect.objectContaining({ channel: "glasses-quick-capture" }) }),
      }),
    );
  });

  it("returns 201 for valid column override", async () => {
    const route = getRoute();
    const createTask = vi.fn(async (input) => ({ id: "FN-10", ...input, title: "x", column: input.column }));
    const ctx = createCtx({ taskStore: { createTask } });
    const res = await route.handler(
      { body: { text: "write docs", column: "done" }, headers: { authorization: "Bearer secret" } } as never,
      ctx,
    );
    expect(res).toMatchObject({ status: 201 });
    expect(createTask).toHaveBeenCalledWith(expect.objectContaining({ column: "done" }));
  });

  it("returns 500 with generic message when createTask throws", async () => {
    const route = getRoute();
    const ctx = createCtx({ taskStore: { createTask: vi.fn(async () => {
      throw new Error("db down");
    }) } });
    const res = await route.handler(
      { body: { text: "write docs" }, headers: { authorization: "Bearer secret" } } as never,
      ctx,
    );
    expect(res).toMatchObject({ status: 500, body: { error: "quick capture failed" } });
  });
});
