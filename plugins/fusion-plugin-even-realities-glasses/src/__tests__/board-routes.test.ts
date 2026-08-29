import { describe, expect, it, vi } from "vitest";
import plugin from "../index.js";
import type { Task } from "@fusion/core";

function makeTask(id: string, column: Task["column"], updatedAt: string): Task {
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
  } as unknown as Task;
}

function createContext(tasks: Task[], apiKey = "secret") {
  return {
    pluginId: "fusion-plugin-even-realities-glasses",
    settings: { apiKey },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    taskStore: {
      listTasks: vi.fn(async () => tasks),
      getTask: vi.fn(async (id: string) => tasks.find((task) => task.id === id)),
    },
  } as never;
}

function route(path: string) {
  return plugin.routes!.find((entry) => entry.path === path)!;
}

describe("board routes", () => {
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

  /*
  FNXC:WorkflowResolvedColumns 2026-07-31-00:45:
  THE INVARIANT: `?columns=` filters on the board's OWN lane ids, whatever they are named.

  The parameter was validated against a hardcoded six-id allow-list and the filter had NO coverage
  at all, which is how the inversion survived: on a renamed board every requested id was discarded,
  the parser returned `null` — the SAME value it returns for "no filter requested" — and the route
  answered 200 with the ENTIRE board. Asking for one column got you all of them, silently.

  Both directions are asserted. A filter that matched nothing would satisfy the renamed-lane case on
  its own while being equally broken, and a filter that matched everything satisfies neither.

  REVERT PROOF, measured: restore the allow-list and BOTH new cases fail with `expected 3 to be 2`
  — the deck carries the summary plus every card instead of the requested subset.
  */
  it("filters on a RENAMED lane instead of silently returning the whole board", async () => {
    const tasks = [
      makeTask("FN-1", "backlog", "2026-05-08T11:00:00.000Z"),
      makeTask("FN-2", "building", "2026-05-08T12:00:00.000Z"),
    ];

    const response = (await route("/board/cards").handler(
      { headers: { authorization: "Bearer secret" }, query: { columns: "building" } },
      createContext(tasks),
    )) as any;

    expect(response.status).toBe(200);
    // Summary card + exactly the one requested task.
    expect(response.body.deck.cards).toHaveLength(2);
    expect(response.body.deck.cards[1].id).toBe("FN-2");
  });

  it("answers an unknown column with an EMPTY deck, not with everything", async () => {
    // The old allow-list turned "I do not recognise that id" into "no filter was requested".
    const tasks = [makeTask("FN-1", "todo", "2026-05-08T11:00:00.000Z"), makeTask("FN-2", "todo", "2026-05-08T12:00:00.000Z")];

    const response = (await route("/board/cards").handler(
      { headers: { authorization: "Bearer secret" }, query: { columns: "nonsense" } },
      createContext(tasks),
    )) as any;

    expect(response.status).toBe(200);
    expect(response.body.deck.cards).toHaveLength(1);
    expect(response.body.deck.cards[0].id).toBe("summary");
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
});
