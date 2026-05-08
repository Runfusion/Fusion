import { describe, expect, it, vi } from "vitest";
import plugin from "../index.js";
import type { FusionTask } from "../cards/types.js";

function makeTask(id: string, column: FusionTask["column"], updatedAt: string): FusionTask {
  return {
    id,
    title: id,
    description: id,
    column,
    status: "pending",
    priority: "normal",
    createdAt: "2026-05-08T10:00:00.000Z",
    updatedAt,
    currentStep: 0,
    steps: [],
    dependencies: [],
  } as FusionTask;
}

function createContext(tasks: FusionTask[], apiKey = "secret") {
  return {
    settings: { apiKey },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    taskStore: {
      listTasks: vi.fn(async () => tasks),
      getTask: vi.fn(async (id: string) => tasks.find((task) => task.id === id)),
    },
  } as any;
}

function route(path: string) {
  return plugin.routes!.find((entry) => entry.path === path)!;
}

describe("even cards routes", () => {
  it("returns 401 when auth header missing", async () => {
    const response = (await route("/board/cards").handler({ headers: {} }, createContext([]))) as any;
    expect(response.status).toBe(401);
  });

  it("returns 503 when plugin is not configured", async () => {
    const response = (await route("/board/cards").handler({ headers: { authorization: "Bearer secret" } }, createContext([], ""))) as any;
    expect(response.status).toBe(503);
  });

  it("returns deck on happy path", async () => {
    const tasks = [makeTask("FN-1", "todo", "2026-05-08T11:00:00.000Z"), makeTask("FN-2", "in-progress", "2026-05-08T12:00:00.000Z")];
    const response = (await route("/board/cards").handler({ headers: { authorization: "Bearer secret" } }, createContext(tasks))) as any;
    expect(response.status).toBe(200);
    expect(response.body.deck.cards[0].id).toBe("summary");
    expect(response.body.deck.cards).toHaveLength(3);
  });

  it("filters columns in memory", async () => {
    const tasks = [makeTask("FN-1", "todo", "2026-05-08T11:00:00.000Z"), makeTask("FN-2", "triage", "2026-05-08T12:00:00.000Z")];
    const response = (await route("/board/cards").handler(
      { headers: { authorization: "Bearer secret" }, query: { columns: "triage" } },
      createContext(tasks),
    )) as any;
    expect(response.body.deck.summary.counts.triage).toBe(1);
    expect(response.body.deck.summary.counts.todo).toBe(0);
  });

  it("clamps max bounds", async () => {
    const tasks = Array.from({ length: 30 }, (_, idx) => makeTask(`FN-${idx + 1}`, "todo", `2026-05-08T12:${String(idx).padStart(2, "0")}:00.000Z`));
    const low = (await route("/board/cards").handler(
      { headers: { authorization: "Bearer secret" }, query: { max: "0" } },
      createContext(tasks),
    )) as any;
    const high = (await route("/board/cards").handler(
      { headers: { authorization: "Bearer secret" }, query: { max: "99" } },
      createContext(tasks),
    )) as any;

    expect(low.body.deck.cards).toHaveLength(1);
    expect(high.body.deck.cards).toHaveLength(20);
  });

  it("returns board summary", async () => {
    const tasks = [makeTask("FN-1", "todo", "2026-05-08T11:00:00.000Z")];
    const response = (await route("/board").handler({ headers: { authorization: "Bearer secret" } }, createContext(tasks))) as any;
    expect(response.status).toBe(200);
    expect(response.body.summary.counts.todo).toBe(1);
  });

  it("returns task deck for known id", async () => {
    const tasks = [makeTask("FN-1", "todo", "2026-05-08T11:00:00.000Z")];
    const response = (await route("/tasks/:id/cards").handler(
      { headers: { authorization: "Bearer secret" }, params: { id: "FN-1" } },
      createContext(tasks),
    )) as any;
    expect(response.status).toBe(200);
    expect(response.body.deck.cards[0].id).toBe("FN-1");
  });

  it("returns 404 for unknown task id", async () => {
    const response = (await route("/tasks/:id/cards").handler(
      { headers: { authorization: "Bearer secret" }, params: { id: "FN-404" } },
      createContext([]),
    )) as any;
    expect(response.status).toBe(404);
  });

  it("excludes archived tasks from deck cards", async () => {
    const tasks = [makeTask("FN-1", "archived", "2026-05-08T12:00:00.000Z"), makeTask("FN-2", "todo", "2026-05-08T11:00:00.000Z")];
    const response = (await route("/board/cards").handler({ headers: { authorization: "Bearer secret" } }, createContext(tasks))) as any;
    const ids = response.body.deck.cards.map((card: any) => card.id);
    expect(ids).toEqual(["summary", "FN-2"]);
  });
});
