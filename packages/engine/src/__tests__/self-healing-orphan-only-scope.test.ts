import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("node:child_process", async () => {
  const { promisify: utilPromisify } = await import("node:util");
  const execSyncFn = vi.fn();
  const execFn: any = vi.fn((cmd: string, opts: any, cb: any) => {
    const callback = typeof opts === "function" ? opts : cb;
    const options = typeof opts === "object" && opts !== null ? opts : {};
    try {
      const out = execSyncFn(cmd, { ...options, stdio: ["pipe", "pipe", "pipe"] });
      const stdout = out === undefined ? "" : out.toString();
      if (typeof callback === "function") callback(null, stdout, "");
    } catch (err) {
      if (typeof callback === "function") {
        const error = err as { stdout?: string; stderr?: string };
        callback(err, error?.stdout?.toString?.() ?? "", error?.stderr?.toString?.() ?? "");
      }
    }
  });
  execFn[utilPromisify.custom] = (cmd: string, opts?: any) => new Promise((resolve, reject) => {
    execFn(cmd, opts, (err: any, stdout: string, stderr: string) => {
      if (err) {
        (err as Record<string, unknown>).stdout = stdout;
        (err as Record<string, unknown>).stderr = stderr;
        reject(err);
      } else {
        resolve({ stdout, stderr });
      }
    });
  });
  return { execSync: execSyncFn, exec: execFn, execFile: vi.fn() };
});

import { EventEmitter } from "node:events";
import { execSync } from "node:child_process";
import type { Settings, Task, TaskStore } from "@fusion/core";
import { SelfHealingManager } from "../self-healing.js";

const mockedExecSync = vi.mocked(execSync);

function createMockStore(overrides: Record<string, unknown> = {}): TaskStore & EventEmitter {
  const emitter = new EventEmitter();
  return Object.assign(emitter, {
    getSettings: vi.fn().mockResolvedValue({ globalPause: false, enginePaused: false } as Settings),
    listTasks: vi.fn().mockResolvedValue([]),
    updateTask: vi.fn().mockResolvedValue({} as Task),
    moveTask: vi.fn().mockResolvedValue(undefined),
    logEntry: vi.fn().mockResolvedValue(undefined),
    getAgentLogs: vi.fn().mockResolvedValue([]),
    ...overrides,
  }) as unknown as TaskStore & EventEmitter;
}

function failedReviewTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "FN-4350",
    column: "in-review",
    status: "failed",
    paused: false,
    scopeOverride: false,
    mergeDetails: undefined,
    branch: "fusion/fn-4350",
    baseBranch: "main",
    steps: [],
    log: [],
    ...overrides,
  } as Task;
}

const DETAIL = [
  "taskId: FN-4350",
  "declaredScope:",
  "- packages/dashboard/app/components/QuickChatFAB.tsx",
  "stagedFiles:",
  "- packages/dashboard/app/components/__tests__/QuickChatFAB.test.tsx",
].join("\n");

describe("recoverOrphanOnlyScopeViolations (FN-4379 / FN-4350)", () => {
  let store: TaskStore & EventEmitter;
  let manager: SelfHealingManager;

  beforeEach(() => {
    store = createMockStore();
    manager = new SelfHealingManager(store, { rootDir: "/tmp/test-project" });
    mockedExecSync.mockReset();
  });

  afterEach(() => {
    manager.stop();
  });

  it("recovers orphan-only FileScopeViolationError when task work is on main (FN-4350)", async () => {
    (store.listTasks as ReturnType<typeof vi.fn>).mockResolvedValue([failedReviewTask()]);
    (store.getAgentLogs as ReturnType<typeof vi.fn>).mockResolvedValue([{ type: "tool_error", detail: DETAIL }]);
    mockedExecSync.mockImplementation((command: string | Buffer) => {
      if (String(command).includes("Fusion-Task-Id: FN-4350")) return "abc123456789\n" as any;
      return "" as any;
    });

    const recovered = await manager.recoverOrphanOnlyScopeViolations();

    expect(recovered).toBe(1);
    expect(store.moveTask).toHaveBeenCalledWith("FN-4350", "done");
    expect(store.updateTask).toHaveBeenCalledWith("FN-4350", expect.objectContaining({
      mergeDetails: expect.objectContaining({ mergeConfirmed: true, resolutionStrategy: "orphan-discard-no-op" }),
    }));
    expect(store.logEntry).toHaveBeenCalledWith("FN-4350", expect.stringContaining("Auto-finalized from in-review/paused: content proven on main"));
  });

  /*
  FNXC:WorkflowResolvedColumns 2026-07-31-20:50:
  `orphanReviewColumns` — the PROJECT-level query that selects candidates — was UNCOVERED on the
  #3115 map, and the reason is worth stating: every case in this file stubs `listTasks` to return the
  same task whatever column is asked for, so the query is never exercised. Blinding the resolver
  changes which column is requested and the fake answers identically, so nothing fails.

  A fake that ignores its own filter cannot see a filter bug. That is the same blindness this sweep's
  production code had, reproduced in the harness.

  Here `listTasks` HONOURS the column, so a card resting in a renamed review lane is found only if
  the query asked for that lane. Keyed on the id it asked for `in-review`, got nothing, and a failed
  orphan-only card stayed failed forever.
  */
  it("finds a candidate resting in a RENAMED review lane (the project query)", async () => {
    const renamed = failedReviewTask({ id: "FN-RENAMED", column: "checking", branch: "fusion/fn-renamed" });
    const RENAMED_IR = {
      version: "v2",
      id: "custom:renamed",
      nodes: [],
      edges: [],
      columns: [
        { id: "building", name: "building", traits: [{ trait: "wip", config: { limitSetting: "maxConcurrent" } }] },
        { id: "checking", name: "checking", traits: [{ trait: "merge" }] },
      ],
    };
    (store.listTasks as ReturnType<typeof vi.fn>).mockImplementation(
      async (opts?: { column?: string }) => (opts?.column === "checking" ? [renamed] : []),
    );
    Object.assign(store as unknown as Record<string, unknown>, {
      listWorkflowDefinitions: vi.fn(async () => [{ id: "custom:renamed", ir: RENAMED_IR }]),
      getTaskWorkflowSelection: vi.fn(() => ({ workflowId: "custom:renamed", stepIds: [] })),
      getTaskWorkflowSelectionAsync: vi.fn(async () => ({ workflowId: "custom:renamed", stepIds: [] })),
      getWorkflowDefinition: vi.fn(async () => ({ ir: RENAMED_IR })),
    });
    (store.getAgentLogs as ReturnType<typeof vi.fn>).mockResolvedValue([
      { type: "tool_error", detail: DETAIL.replace("FN-4350", "FN-RENAMED") },
    ]);
    mockedExecSync.mockImplementation((command: string | Buffer) => {
      if (String(command).includes("Fusion-Task-Id: FN-RENAMED")) return "abc123456789\n" as any;
      return "" as any;
    });

    expect(await manager.recoverOrphanOnlyScopeViolations()).toBe(1);
    expect(store.moveTask).toHaveBeenCalledWith("FN-RENAMED", "done");
  });

  it("does NOT recover when landed commit cannot be verified (FN-4280)", async () => {
    (store.listTasks as ReturnType<typeof vi.fn>).mockResolvedValue([failedReviewTask()]);
    (store.getAgentLogs as ReturnType<typeof vi.fn>).mockResolvedValue([{ type: "tool_error", detail: DETAIL }]);
    mockedExecSync.mockImplementation(() => "" as any);

    const recovered = await manager.recoverOrphanOnlyScopeViolations();

    expect(recovered).toBe(0);
    expect(store.moveTask).not.toHaveBeenCalled();
    expect(store.updateTask).not.toHaveBeenCalled();
  });

  it("does NOT recover mixed staging that overlaps declared scope", async () => {
    (store.listTasks as ReturnType<typeof vi.fn>).mockResolvedValue([failedReviewTask()]);
    (store.getAgentLogs as ReturnType<typeof vi.fn>).mockResolvedValue([{ type: "tool_error", detail: [
      "taskId: FN-4350",
      "declaredScope:",
      "- packages/dashboard/app/components/QuickChatFAB.tsx",
      "stagedFiles:",
      "- .changeset/fn-4379.md",
      "- packages/dashboard/app/components/QuickChatFAB.tsx",
    ].join("\n") }]);

    const recovered = await manager.recoverOrphanOnlyScopeViolations();

    expect(recovered).toBe(0);
    expect(store.moveTask).not.toHaveBeenCalled();
  });

  it("skips scopeOverride tasks entirely", async () => {
    (store.listTasks as ReturnType<typeof vi.fn>).mockResolvedValue([failedReviewTask({ scopeOverride: true })]);

    const recovered = await manager.recoverOrphanOnlyScopeViolations();

    expect(recovered).toBe(0);
    expect(store.getAgentLogs).not.toHaveBeenCalled();
  });

  it("returns 0 when global pause or engine pause is active", async () => {
    (store.getSettings as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ globalPause: true, enginePaused: false });
    expect(await manager.recoverOrphanOnlyScopeViolations()).toBe(0);
    (store.getSettings as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ globalPause: false, enginePaused: true });
    expect(await manager.recoverOrphanOnlyScopeViolations()).toBe(0);
  });

  it("is idempotent across runs", async () => {
    (store.listTasks as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce([failedReviewTask()])
      .mockResolvedValueOnce([]);
    (store.getAgentLogs as ReturnType<typeof vi.fn>).mockResolvedValue([{ type: "tool_error", detail: DETAIL }]);
    mockedExecSync.mockImplementation((command: string | Buffer) => {
      if (String(command).includes("Fusion-Task-Id: FN-4350")) return "abc123456789\n" as any;
      return "" as any;
    });

    expect(await manager.recoverOrphanOnlyScopeViolations()).toBe(1);
    expect(await manager.recoverOrphanOnlyScopeViolations()).toBe(0);
  });

  it("skips empty declared scope payload", async () => {
    (store.listTasks as ReturnType<typeof vi.fn>).mockResolvedValue([failedReviewTask()]);
    (store.getAgentLogs as ReturnType<typeof vi.fn>).mockResolvedValue([{ type: "tool_error", detail: [
      "taskId: FN-4350",
      "declaredScope:",
      "stagedFiles:",
      "- packages/dashboard/app/components/__tests__/QuickChatFAB.test.tsx",
    ].join("\n") }]);

    const recovered = await manager.recoverOrphanOnlyScopeViolations();

    expect(recovered).toBe(0);
    expect(store.moveTask).not.toHaveBeenCalled();
  });

  it("still evaluates paused failed tasks for landed-content proof", async () => {
    (store.listTasks as ReturnType<typeof vi.fn>).mockResolvedValue([failedReviewTask({ paused: true })]);

    const recovered = await manager.recoverOrphanOnlyScopeViolations();

    expect(recovered).toBe(0);
    expect(store.getAgentLogs).toHaveBeenCalled();
  });
});
