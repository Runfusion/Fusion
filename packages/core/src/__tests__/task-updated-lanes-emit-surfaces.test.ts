import { describe, expect, it, vi } from "vitest";
import { createTaskStoreForTest, pgDescribe } from "../__test-utils__/pg-test-harness.js";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { TaskStore } from "../store.js";
import type { Task } from "../types.js";

const REPO_ROOT = resolve(__dirname, "../../../..");
const CORE_ROOT = join(REPO_ROOT, "packages/core/src");

type ProducerRoute = "emit" | "safe";

/*
FNXC:WorkflowEvents 2026-08-01-07:44:
The cache seam has two production entry points: ordinary EventEmitter `emit` and the failure-isolated
`emitTaskLifecycleEventSafely`. Inventory both forms, including safe-only producers, because a
source scan for only `emit("task:updated")` leaves a producer unexercised and can hide a bypass.
Each registered route below is driven warm and cold through its real TaskStore delivery method.
*/
const PRODUCERS = {
  "packages/core/src/store.ts": ["emit"],
  "packages/core/src/task-store/audit-ops.ts": ["emit", "safe"],
  "packages/core/src/task-store/branch-group-ops.ts": ["emit"],
  "packages/core/src/task-store/comments-ops.ts": ["emit"],
  "packages/core/src/task-store/merge-queue-ops.ts": ["emit"],
  "packages/core/src/task-store/moves.ts": ["emit"],
  "packages/core/src/task-store/project-store-ops.ts": ["emit"],
  "packages/core/src/task-store/task-artifacts-ops.ts": ["emit"],
  "packages/core/src/task-store/task-mutation-ops.ts": ["emit", "safe"],
  "packages/core/src/task-store/task-update.ts": ["safe"],
  "packages/core/src/task-store/update-task-deps.ts": ["safe"],
  "packages/core/src/task-store/workflow-integrity.ts": ["safe"],
  "packages/core/src/task-store/workflow-task-create-ops.ts": ["emit", "safe"],
} as const satisfies Record<string, readonly ProducerRoute[]>;

const EMIT_SURFACES = Object.keys(PRODUCERS) as Array<keyof typeof PRODUCERS>;

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    if (entry === "__tests__" || entry === "dist") continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) yield* walk(path);
    else if (path.endsWith(".ts")) yield path;
  }
}

const task = { id: "FN-surface", column: "building" } as Task;

/*
FNXC:WorkflowEvents 2026-08-01-07:44:
Every production core update producer invokes a TaskStore delivery method, not EventEmitter's
prototype or a private relay. That structural boundary is what lets one decorated seam cover every
producer warm and cold without adding an IR read to hot mutation paths.
*/
describe("core task:updated emit surface", () => {
  it("registers every direct and safe production producer", () => {
    const routesByModule = new Map<string, Set<ProducerRoute>>();
    for (const file of walk(CORE_ROOT)) {
      const source = readFileSync(file, "utf8");
      const routes = new Set<ProducerRoute>();
      if (source.includes('emit("task:updated"')) routes.add("emit");
      if (source.includes('emitTaskLifecycleEventSafely("task:updated"')) routes.add("safe");
      if (routes.size > 0) routesByModule.set(relative(REPO_ROOT, file).split("\\").join("/"), routes);
    }

    expect([...routesByModule.keys()].sort()).toEqual([...EMIT_SURFACES].sort());
    for (const [file, routes] of routesByModule) {
      const expectedRoutes = PRODUCERS[file as keyof typeof PRODUCERS];
      expect([...routes].sort(), `${file} must register every delivery route`).toEqual([...expectedRoutes].sort());
      const source = readFileSync(join(REPO_ROOT, file), "utf8");
      expect(source).not.toMatch(/EventEmitter\.prototype\.emit[^\n]*task:updated/);
    }
  });

});

/*
FNXC:WorkflowEvents 2026-08-01-08:08:
A source inventory alone only proves where an update could originate. Execute public operations from
its producer modules so warm and cold assertions cover the producer-to-listener path, rather than
calling the central seam directly and mistaking seam coverage for producer coverage.
*/
pgDescribe("task:updated producer integration", () => {
  async function withWarmAndColdUpdate(
    description: string,
    operation: (store: TaskStore, taskId: string, pass: "warm" | "cold") => Promise<unknown>,
    setup?: (store: TaskStore, taskId: string) => Promise<unknown>,
  ): Promise<void> {
    const harness = await createTaskStoreForTest({ prefix: `fusion_${description.replaceAll(/[^a-z]/g, "_")}_lanes` });
    try {
      const store = harness.store;
      const created = await store.createTask({
        description: `${description} lane surface`,
        steps: [{ name: "surface step", status: "pending" }],
      });
      await setup?.(store, created.id);
      const received: Array<{ lanes?: { wip?: string } } | undefined> = [];
      store.on("task:updated", (emitted, meta) => {
        if (emitted.id === created.id) received.push(meta);
      });

      store.laneCache.set(created.id, { wip: "building" });
      await operation(store, created.id, "warm");
      store.laneCache.invalidate(created.id);
      await operation(store, created.id, "cold");

      expect(received[0], `${description} warm operation`).toEqual({ lanes: { wip: "building" } });
      expect(received.at(-1), `${description} cold operation`).toBeUndefined();
    } finally {
      await harness.teardown();
    }
  }

  it("delivers warm then cold metadata through TaskStore's direct emit producer", async () => {
    const harness = await createTaskStoreForTest({ prefix: "fusion_store_emit_lanes_surface" });
    try {
      const store = harness.store;
      const created = await store.createTask({ description: "store emit lane surface" });
      const received: Array<{ lanes?: { wip?: string } } | undefined> = [];
      store.on("task:updated", (_task, meta) => received.push(meta));

      store.laneCache.set(created.id, { wip: "building" });
      store.emit("task:updated", created);
      store.laneCache.invalidate(created.id);
      store.emit("task:updated", created);

      expect(received).toEqual([{ lanes: { wip: "building" } }, undefined]);
    } finally {
      await harness.teardown();
    }
  });

  it("executes audit-ops logEntry through its real update producer", async () => {
    await withWarmAndColdUpdate("audit", (store, id, pass) => store.logEntry(id, `surface ${pass}`));
  });

  it("executes branch-group-ops pauseTask through its real update producer", async () => {
    await withWarmAndColdUpdate("branch", (store, id, pass) => store.pauseTask(id, pass === "warm"));
  });

  it("executes comments-ops addComment through its real update producer", async () => {
    await withWarmAndColdUpdate("comment", (store, id, pass) => store.addComment(id, `surface ${pass}`, "agent", { skipRefinement: true }));
  });

  it("executes merge-queue-ops updateStep through its real update producer", async () => {
    await withWarmAndColdUpdate(
      "merge_step",
      (store, id, pass) => store.updateStep(id, 0, pass === "warm" ? "in-progress" : "done"),
      (store, id) => store.updateTask(id, { steps: [{ name: "surface step", status: "pending" }] }),
    );
  });


  it("executes workflow-task-create-ops branch assignment through its real update producer", async () => {
    await withWarmAndColdUpdate("workflow_task_create", (store, id) => store.setTaskBranchGroup(id, null));
  });

  it("executes project-store-ops updateIssueInfo through its real update producer", async () => {
    await withWarmAndColdUpdate("issue", (store, id, pass) => store.updateIssueInfo(id, {
      number: pass === "warm" ? 1 : 2,
      url: `https://example.test/issues/${pass}`,
      state: "open",
      title: `surface ${pass}`,
    }));
  });

  it("executes task-artifacts-ops steering comments through its real update producer", async () => {
    await withWarmAndColdUpdate("artifact", (store, id, pass) => store.addSteeringComment(id, `surface ${pass}`));
  });

  it("executes task-mutation-ops atomic updates through its real update producer", async () => {
    await withWarmAndColdUpdate("mutation", (store, id, pass) => store.updateTaskAtomic(id, () => ({ title: `surface ${pass}` })));
  });


  it("executes moves' same-column completion update producer", async () => {
    const harness = await createTaskStoreForTest({ prefix: "fusion_moves_lanes_surface" });
    try {
      const store = harness.store;
      const created = await store.createTask({ description: "move lane surface" });
      await store.moveTask(created.id, "in-progress");
      await store.moveTask(created.id, "done");
      await store.updateTask(created.id, { status: "failed" });
      const received: Array<{ lanes?: { wip?: string } } | undefined> = [];
      store.on("task:updated", (_task, meta) => received.push(meta));

      store.laneCache.set(created.id, { wip: "building" });
      await store.moveTask(created.id, "done");
      store.laneCache.invalidate(created.id);
      await store.updateTask(created.id, { status: "failed" });
      await store.moveTask(created.id, "done");

      expect(received[0]).toEqual({ lanes: { wip: "building" } });
      expect(received.at(-1)).toBeUndefined();
    } finally {
      await harness.teardown();
    }
  });

  it("executes workflow-integrity's real safe update producer", async () => {
    const store = new TaskStore(process.cwd());
    const stampableTask = { ...task, column: "in-review", autoMerge: true };
    const received: Array<{ lanes?: { wip?: string } } | undefined> = [];
    let marked = false;
    store.on("task:updated", (_task, meta) => received.push(meta));
    Object.defineProperty(store, "db", {
      value: {
        prepare: vi.fn(() => ({
          get: () => marked ? { value: "1" } : undefined,
          run: () => { marked = true; },
        })),
        bumpLastModified: vi.fn(),
      },
    });
    vi.spyOn(store, "listLegacyAutoMergeStampCandidates").mockResolvedValue([stampableTask]);
    vi.spyOn(store, "getTask").mockResolvedValue(stampableTask);
    vi.spyOn(store, "isLegacyAutoMergeStampCandidate").mockReturnValue(true);
    vi.spyOn(store, "atomicWriteTaskJson").mockResolvedValue();
    vi.spyOn(store, "recordRunAuditEvent").mockResolvedValue({} as never);

    store.laneCache.set(task.id, { wip: "building" });
    await store.markLegacyAutoMergeStampsOnce();
    marked = false;
    store.laneCache.invalidate(task.id);
    await store.markLegacyAutoMergeStampsOnce();

    expect(received).toEqual([{ lanes: { wip: "building" } }, undefined]);
  });

  it("delivers warm then cold metadata through task-update's real safe emission", async () => {
    const harness = await createTaskStoreForTest({ prefix: "fusion_update_lanes_surface" });
    try {
      const store = harness.store;
      const created = await store.createTask({ description: "update lane surface" });
      const received: Array<{ lanes?: { wip?: string } } | undefined> = [];
      store.on("task:updated", (_task, meta) => received.push(meta));

      store.laneCache.set(created.id, { wip: "building" });
      await store.updateTask(created.id, { title: "warm update" });
      store.laneCache.invalidate(created.id);
      await store.updateTask(created.id, { title: "cold update" });

      expect(received).toEqual([{ lanes: { wip: "building" } }, undefined]);
    } finally {
      await harness.teardown();
    }
  });

  it("delivers warm then cold metadata through dependency updates' real safe emission", async () => {
    const harness = await createTaskStoreForTest({ prefix: "fusion_dependency_lanes_surface" });
    try {
      const store = harness.store;
      const prerequisite = await store.createTask({ description: "dependency prerequisite" });
      const dependent = await store.createTask({ description: "dependency lane surface" });
      const received: Array<{ lanes?: { wip?: string } } | undefined> = [];
      store.on("task:updated", (_task, meta) => {
        if (_task.id === dependent.id) received.push(meta);
      });

      store.laneCache.set(dependent.id, { wip: "building" });
      await store.updateTaskDependencies(dependent.id, { operation: "add", dependency: prerequisite.id });
      store.laneCache.invalidate(dependent.id);
      await store.updateTaskDependencies(dependent.id, { operation: "remove", dependency: prerequisite.id });

      expect(received).toEqual([{ lanes: { wip: "building" } }, undefined]);
    } finally {
      await harness.teardown();
    }
  });
});
