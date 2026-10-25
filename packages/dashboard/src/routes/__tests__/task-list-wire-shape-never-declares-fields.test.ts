// @vitest-environment node

/*
FNXC:ListReadFieldDeclaration 2026-10-25-23:39 (RUFU-627):
RUFU-627 lets a list-read CALLER declare the wide fields it reads (`ListTasksOptions.fields`) so the
SELECT stops carrying text nobody renders. Board parity is the hard constraint on this program — the
same constraint RUFU-201 wrote into `derive` ("omitted means `true`, because the dashboard board feed
must keep every badge it renders today") — so the two feeds the desktop board and the mobile board
poll must be provably OUTSIDE that mechanism, at the HTTP boundary rather than in a store test.

Both halves are pinned here:
  1. NEITHER ROUTE DECLARES. `GET /tasks` builds an option bag that names `slim` / `excludeLog` /
     `compactBoardFeed` and never `fields`; `GET /tasks/page` reaches the store through
     `listCurrentTasksPage`, whose options have no `fields` member at all. Asserted on the arguments
     the store actually received, because a route that quietly started declaring fields is exactly the
     change that would blank a column on the board with no failing test near it.
  2. THE WIRE CARRIES WHAT THE STORE RETURNED. The response body for a populated row keeps
     `description`, `steps`, `log`, `sourceType` and the `workflowStepResults` identities, so no layer
     between the store and the client drops a field on the theory that somebody declared it.

Surface enumeration: the same route serves desktop and mobile (one poll, one payload); the searched
arm (`?q=`) goes through `searchTasks`, not `listTasks`, and the paginated arm is a different store
method — both arms are asserted, not just the default one.
*/

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express from "express";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TaskStore, Task } from "@fusion/core";
import { createApiRoutes } from "../../routes.js";
import { request as REQUEST } from "../../test-request.js";

let tasksRoot: string;

/** A row carrying every wide field a declaration could name, so a drop cannot hide behind emptiness. */
function makeTask(): Task {
  return {
    id: "FN-WIRE-1",
    title: "A populated card",
    description: "A description with enough body to be worth dropping",
    summary: "a completion summary",
    column: "in-progress",
    status: "in-progress",
    dependencies: [],
    steps: [{ index: 0, heading: "Step 1: Ship", description: "Body", status: "done" }],
    currentStep: 1,
    log: [{ timestamp: "2026-05-15T00:00:00.000Z", action: "execution.started" }],
    attachments: [{ name: "probe.png", url: "/tmp/probe.png" }],
    sourceType: "automation",
    sourceMetadata: { fileScope: ["packages/core/src/task-store/reads.ts"] },
    workflowStepResults: [{
      id: "step-1", stepIndex: 0, stepName: "Implement", status: "approved", verdict: "APPROVE",
      output: "reviewer body", notes: "reviewer notes",
    }],
    createdAt: "2026-05-15T00:00:00.000Z",
    updatedAt: "2026-05-15T00:00:00.000Z",
  } as unknown as Task;
}

function createHarness(task: Task) {
  const store = {
    getRootDir: vi.fn(() => process.cwd()),
    getProjectScopedPluginMcpServers: vi.fn(async () => []),
    getTaskDir: vi.fn((id: string) => join(tasksRoot, id)),
    getSettingsFast: vi.fn(async () => ({})),
    listTasks: vi.fn(async () => [structuredClone(task)]),
    searchTasks: vi.fn(async () => [structuredClone(task)]),
    listCurrentTasksPage: vi.fn(async () => ({
      tasks: [structuredClone(task)], total: 1, hasMore: false, nextCursor: null,
    })),
  } as unknown as TaskStore;
  const app = express();
  app.use(express.json());
  app.use("/api", createApiRoutes(store));
  return { app, store };
}

beforeEach(async () => {
  tasksRoot = await mkdtemp(join(tmpdir(), "fusion-wire-shape-"));
});

afterEach(async () => {
  await rm(tasksRoot, { recursive: true, force: true });
});

/** The closed union's members, spelled out so a new one has to be considered here deliberately. */
const DECLARABLE_FIELDS = ["log", "description", "summary", "steps", "attachments", "workflowStepResults", "source"] as const;

function expectNoFieldDeclaration(options: unknown): void {
  expect(typeof options).toBe("object");
  const bag = options as Record<string, unknown>;
  expect(Object.keys(bag)).not.toContain("fields");
  expect(bag.fields).toBeUndefined();
  for (const field of DECLARABLE_FIELDS) {
    // A caller cannot half-declare: the mechanism is one `fields` array or nothing.
    expect(bag[field]).toBeUndefined();
  }
}

describe("board feeds never declare list-read fields", () => {
  it("GET /tasks reads with an undeclared shape and emits the wide fields it got", async () => {
    const task = makeTask();
    const { app, store } = createHarness(task);

    const res = await REQUEST(app, "GET", "/api/tasks");
    expect(res.status).toBe(200);

    const listTasks = store.listTasks as unknown as { mock: { calls: unknown[][] } };
    expect(listTasks.mock.calls).toHaveLength(1);
    expectNoFieldDeclaration(listTasks.mock.calls[0]![0]);

    const [row] = res.body as Array<Record<string, unknown>>;
    expect(row!.id).toBe("FN-WIRE-1");
    expect(row!.description).toBe(task.description);
    expect(row!.log).toEqual(task.log);
    expect(row!.steps).toEqual(task.steps);
    expect(row!.sourceType).toBe("automation");
    expect(row!.attachments).toEqual(task.attachments);
    expect(row!.attachments).toEqual(task.attachments);
    // Step identity plus reviewer bodies: the store handed this route a full row, and the route
    // forwarded every field of it.
    const results = row!.workflowStepResults as Array<Record<string, unknown>>;
    expect(results.length).toBe(1);
    expect(results[0]!.id).toBe("step-1");
    expect(results[0]!.status).toBe("approved");
    expect(results[0]!.output).toBe("reviewer body");
    /*
    Everything the store returned is what the wire carries — including `summary`, which the FEED
    compacts inside the store read via `compactBoardFeed` (RUFU-378), not in the route. Asserted as
    pass-through on purpose: this leg's claim is that no route-layer filter exists to drop a field on
    the theory that a caller declared it, and a mock store cannot exhibit a store-side compaction it
    does not perform. The store side is `list-read-projection-parity.pg.test.ts` and
    `task-log-projections.pg.test.ts`.
    */
    expect(row!.summary).toBe(task.summary);
    // A non-Todo row carries no `awaitingPlanning`, so the route's own additive enrichment stayed additive.
    expect(row!.awaitingPlanning).toBeUndefined();
  });

  it("GET /tasks with a lane scope and the searched arm both stay undeclared", async () => {
    const task = makeTask();
    const { app, store } = createHarness(task);

    const columnRes = await REQUEST(app, "GET", "/api/tasks?column=in-progress");
    expect(columnRes.status).toBe(200);
    const listTasks = store.listTasks as unknown as { mock: { calls: unknown[][] } };
    expectNoFieldDeclaration(listTasks.mock.calls[0]![0]);
    expect((listTasks.mock.calls[0]![0] as Record<string, unknown>).column).toBe("in-progress");
    expect((columnRes.body as Array<Record<string, unknown>>)[0]!.description).toBe(task.description);

    const searchRes = await REQUEST(app, "GET", "/api/tasks?q=description");
    expect(searchRes.status).toBe(200);
    const searchTasks = store.searchTasks as unknown as { mock: { calls: unknown[][] } };
    expect(searchTasks.mock.calls).toHaveLength(1);
    expectNoFieldDeclaration(searchTasks.mock.calls[0]![1]);
    expect((searchRes.body as Array<Record<string, unknown>>)[0]!.description).toBe(task.description);
  });

  it("GET /tasks/page cannot declare fields and emits the page row unchanged", async () => {
    const task = makeTask();
    const { app, store } = createHarness(task);

    const res = await REQUEST(app, "GET", "/api/tasks/page?limit=10");
    expect(res.status).toBe(200);

    const page = store.listCurrentTasksPage as unknown as { mock: { calls: unknown[][] } };
    expect(page.mock.calls).toHaveLength(1);
    const options = page.mock.calls[0]![0] as Record<string, unknown>;
    expectNoFieldDeclaration(options);
    // The whole option bag, spelled: `fields` is not even a member of `listCurrentTasksPage`'s option
    // type, so this route could not pass it if it wanted to.
    expect(options).toEqual({ limit: 10 });

    const body = res.body as { tasks: Array<Record<string, unknown>>; total: number; hasMore: boolean };
    expect(body.total).toBe(1);
    expect(body.hasMore).toBe(false);
    expect(body.tasks[0]!.description).toBe(task.description);
    expect(body.tasks[0]!.log).toEqual(task.log);
    expect(body.tasks[0]!.summary).toBe(task.summary);
    expect(body.tasks[0]!.sourceMetadata).toEqual(task.sourceMetadata);
  });
});
