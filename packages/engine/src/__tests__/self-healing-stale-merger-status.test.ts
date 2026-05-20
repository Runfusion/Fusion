import { beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import type { Settings, Task, TaskStore } from "@fusion/core";

const { execMock } = vi.hoisted(() => ({
  execMock: vi.fn(),
}));
vi.mock("node:child_process", () => ({ exec: execMock, execSync: vi.fn() }));

const { logger } = vi.hoisted(() => ({
  logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("../logger.js", () => ({ createLogger: vi.fn(() => logger) }));

const { recordRunAuditEventMock } = vi.hoisted(() => ({
  recordRunAuditEventMock: vi.fn(async () => undefined),
}));
vi.mock("../run-audit.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../run-audit.js")>();
  return {
    ...actual,
    createRunAuditor: vi.fn(() => ({
      database: recordRunAuditEventMock,
      git: vi.fn(),
      filesystem: vi.fn(),
      sandbox: vi.fn(),
    })),
  };
});

import { SelfHealingManager } from "../self-healing.js";

function makeTask(id: string, overrides: Partial<Task> = {}): Task {
  return {
    id,
    title: id,
    description: id,
    column: "done",
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    createdAt: new Date(Date.now() - 12 * 60 * 60 * 1000).toISOString(),
    updatedAt: new Date(Date.now() - 12 * 60 * 60 * 1000).toISOString(),
    ...overrides,
  } as Task;
}

function createStore(tasks: Task[]): TaskStore & EventEmitter {
  const map = new Map(tasks.map((t) => [t.id, t]));
  const emitter = new EventEmitter();
  return Object.assign(emitter, {
    getSettings: vi.fn(async () => ({ globalPause: false, enginePaused: false } as Settings)),
    listTasks: vi.fn(async (opts?: { column?: Task["column"]; slim?: boolean }) => {
      const all = [...map.values()];
      if (!opts?.column) return all;
      return all.filter((t) => t.column === opts.column);
    }),
    getTask: vi.fn(async (id: string) => map.get(id)),
    updateTask: vi.fn(async (id: string, patch: Partial<Task>) => {
      const task = map.get(id)!;
      const merged = { ...task, ...patch } as Task;
      map.set(id, merged);
      return merged;
    }),
    logEntry: vi.fn(async () => undefined),
  }) as unknown as TaskStore & EventEmitter;
}

describe("FN-5092: reconcileStaleMergerStatus watchdog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("clears status=\"merging\" on a done task (the FN-5052 stranding case)", async () => {
    const stranded = makeTask("FN-5052", {
      column: "done",
      status: "merging" as Task["status"],
      mergeDetails: { commitSha: "abc123", mergeConfirmed: true } as Task["mergeDetails"],
    });
    const store = createStore([stranded]);
    const mgr = new SelfHealingManager(store, { rootDir: "/repo" });

    const cleared = await mgr.reconcileStaleMergerStatus();
    expect(cleared).toBe(1);
    const after = await store.getTask("FN-5052");
    expect(after?.status).toBeNull();
    expect(after?.column).toBe("done");
    // mergeDetails preserved
    expect(after?.mergeDetails?.commitSha).toBe("abc123");
    // Audit event recorded
    expect(recordRunAuditEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "task:auto-recover-stale-merger-status",
        target: "FN-5052",
        metadata: expect.objectContaining({
          previousColumn: "done",
          previousStatus: "merging",
          mergeConfirmed: true,
          commitSha: "abc123",
        }),
      }),
    );
    // Log entry recorded for forensics
    expect((store as any).logEntry).toHaveBeenCalledWith(
      "FN-5052",
      expect.stringContaining("Auto-recovered: cleared stale status=\"merging\""),
    );
  });

  it("clears status=\"merging-pr\" on a done task", async () => {
    const stranded = makeTask("FN-9999", {
      column: "done",
      status: "merging-pr" as Task["status"],
    });
    const store = createStore([stranded]);
    const mgr = new SelfHealingManager(store, { rootDir: "/repo" });

    const cleared = await mgr.reconcileStaleMergerStatus();
    expect(cleared).toBe(1);
    expect((await store.getTask("FN-9999"))?.status).toBeNull();
  });

  it("also catches the same leak on archived tasks", async () => {
    const stranded = makeTask("FN-ARCH", {
      column: "archived",
      status: "merging" as Task["status"],
    });
    const store = createStore([stranded]);
    const mgr = new SelfHealingManager(store, { rootDir: "/repo" });

    const cleared = await mgr.reconcileStaleMergerStatus();
    expect(cleared).toBe(1);
    expect((await store.getTask("FN-ARCH"))?.status).toBeNull();
  });

  it("does not touch in-review tasks that legitimately have status=\"merging\"", async () => {
    const legit = makeTask("FN-INREVIEW", {
      column: "in-review",
      status: "merging" as Task["status"],
    });
    const store = createStore([legit]);
    const mgr = new SelfHealingManager(store, { rootDir: "/repo" });

    const cleared = await mgr.reconcileStaleMergerStatus();
    expect(cleared).toBe(0);
    expect((await store.getTask("FN-INREVIEW"))?.status).toBe("merging");
  });

  it("does not touch done tasks with null status (the healthy case)", async () => {
    const healthy = makeTask("FN-HEALTHY", { column: "done", status: undefined });
    const store = createStore([healthy]);
    const mgr = new SelfHealingManager(store, { rootDir: "/repo" });

    const cleared = await mgr.reconcileStaleMergerStatus();
    expect(cleared).toBe(0);
    expect(recordRunAuditEventMock).not.toHaveBeenCalled();
  });

  it("handles multiple leaked tasks in one sweep", async () => {
    const tasks = [
      makeTask("FN-A", { column: "done", status: "merging" as Task["status"] }),
      makeTask("FN-B", { column: "done", status: "merging-pr" as Task["status"] }),
      makeTask("FN-C", { column: "archived", status: "merging" as Task["status"] }),
      makeTask("FN-D", { column: "done", status: undefined }), // healthy
    ];
    const store = createStore(tasks);
    const mgr = new SelfHealingManager(store, { rootDir: "/repo" });

    const cleared = await mgr.reconcileStaleMergerStatus();
    expect(cleared).toBe(3);
  });

  it("continues sweep when a single task update fails", async () => {
    const a = makeTask("FN-FAIL", { column: "done", status: "merging" as Task["status"] });
    const b = makeTask("FN-OK", { column: "done", status: "merging" as Task["status"] });
    const store = createStore([a, b]);
    let failOnce = true;
    (store as any).updateTask = vi.fn(async (id: string, patch: Partial<Task>) => {
      if (id === "FN-FAIL" && failOnce) {
        failOnce = false;
        throw new Error("simulated update failure");
      }
      const task = (store as any).getTask.mock.results[0]?.value;
      return { ...(task || a), ...patch };
    });
    const mgr = new SelfHealingManager(store, { rootDir: "/repo" });

    const cleared = await mgr.reconcileStaleMergerStatus();
    // FN-FAIL fails, FN-OK succeeds
    expect(cleared).toBe(1);
  });

  it("returns 0 on empty board (no done/archived tasks at all)", async () => {
    const store = createStore([makeTask("FN-INPROGRESS", { column: "in-progress" })]);
    const mgr = new SelfHealingManager(store, { rootDir: "/repo" });
    const cleared = await mgr.reconcileStaleMergerStatus();
    expect(cleared).toBe(0);
  });
});
