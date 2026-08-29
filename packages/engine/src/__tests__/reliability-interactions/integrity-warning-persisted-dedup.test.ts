/**
 * Real-git wallclock under parallel CI load; do not lower per-test timeouts
 * without re-measuring under pnpm test:full. (FN-4839)
 *
 * FN-4811 follow-up: persisted dedup of done-task finalize-integrity warnings.
 *
 * Before this change, `SelfHealingManager.reconcileDoneTaskIntegrity()` deduped
 * warnings via an in-memory `finalizeUnprovenWarned: Set<string>` per instance.
 * Every engine restart created a fresh instance, so the periodic sweep re-emitted
 * the same "Integrity warning: done-task finalize evidence is unproven" log entry
 * for the same task every cycle — significant log noise on done tasks that
 * legitimately had no on-main evidence (often residue of FN-4811 contamination).
 *
 * The fix persists the first-warning state on `task.mergeDetails.integrityWarning`
 * (warnedAt + reason) and the sweep checks that field before emitting again.
 *
 * This is the canonical real-git regression backstop for the persisted dedup contract.
 */
import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { EventEmitter } from "node:events";
import type { Settings, Task, TaskStore } from "@fusion/core";
import { SelfHealingManager } from "../../self-healing.js";

function git(dir: string, cmd: string): string {
  return execSync(cmd, { cwd: dir, stdio: "pipe" }).toString().trim();
}

function makeStore(task: Task, events: unknown[] = []): TaskStore & EventEmitter {
  const emitter = new EventEmitter();
  const mergedSettings = {
    autoMerge: true,
    globalPause: false,
    enginePaused: false,
    mergeStrategy: "direct",
    directMergeCommitStrategy: "auto",
    includeTaskIdInCommit: false,
    commitAuthorEnabled: false,
    useAiMergeCommitSummary: false,
    baseBranch: "main",
  } as unknown as Settings;
  return Object.assign(emitter, {
    getSettings: vi.fn(async () => mergedSettings),
    getTask: vi.fn(async () => task),
    listTasks: vi.fn(async ({ column }: { column?: string } = {}) =>
      column ? [task].filter((t) => t.column === column) : [task],
    ),
    updateTask: vi.fn(async (_id: string, updates: Partial<Task>) => Object.assign(task, updates)),
    moveTask: vi.fn(async (_id: string, column: Task["column"]) => {
      task.column = column;
      return task;
    }),
    logEntry: vi.fn(async () => undefined),
    appendAgentLog: vi.fn(async () => undefined),
    updateSettings: vi.fn(async () => mergedSettings),
    clearStaleExecutionStartBranchReferences: vi.fn(() => []),
    recordRunAuditEvent: vi.fn(async (event: unknown) => {
      events.push(event);
    }),
    walCheckpoint: vi.fn(() => ({ busy: 0, log: 0, checkpointed: 0 })),
    archiveTaskAndCleanup: vi.fn(async () => ({})),
    mergeTask: vi.fn(async () => undefined),
    getRootDir: vi.fn(() => ""),
  }) as unknown as TaskStore & EventEmitter;
}

/**
 * Set up a real git repo where the task branch has only foreign-attributed commits,
 * so `classifyOwnedLandedEvidence` returns `kind: "unproven"` with reason
 * `"no-owned-commit-foreign-deltas"` — the canonical FN-4771/FN-4778 production shape.
 */
function setupForeignOnlyRepo(dir: string, taskId: string): void {
  git(dir, "git init -b main");
  git(dir, 'git config user.email "test@example.com"');
  git(dir, 'git config user.name "Test"');
  git(dir, "git commit --allow-empty -m init");
  git(dir, `git checkout -b fusion/${taskId.toLowerCase()}`);
  writeFileSync(join(dir, "foreign.txt"), "from foreign\n");
  git(dir, "git add foreign.txt");
  git(dir, "git commit -m 'feat(FN-OTHER): foreign' -m 'Fusion-Task-Id: FN-OTHER'");
  git(dir, "git checkout main");
}

function makeUnprovenDoneTask(taskId: string): Task {
  return {
    id: taskId,
    title: "test",
    description: "test",
    column: "done",
    branch: `fusion/${taskId.toLowerCase()}`,
    baseBranch: "main",
    modifiedFiles: ["some/file.ts"],
    mergeDetails: {},
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  } as Task;
}

// FN-5518 (FN-4807 pattern): the file header already documents this is real-git wallclock under parallel CI load (FN-4839); lift the per-test deadline above Vitest's 5s default rather than weakening or removing the real-git regression backstop.
describe("FN-4811 follow-up: integrity warning dedup persists across restarts", { timeout: 30_000 }, () => {
  it("emits the unproven warning once, persists it on mergeDetails.integrityWarning", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fn-4811-dedup-first-"));
    try {
      const taskId = "FN-DEDUP-1";
      setupForeignOnlyRepo(dir, taskId);
      const task = makeUnprovenDoneTask(taskId);

      const events: unknown[] = [];
      const store = makeStore(task, events);
      const manager = new SelfHealingManager(store, { rootDir: dir });

      await manager.reconcileDoneTaskIntegrity();

      const logCalls = (store.logEntry as ReturnType<typeof vi.fn>).mock.calls;
      const warningEmitted = logCalls.some((c: any[]) =>
        /Integrity warning: done-task finalize evidence is unproven/.test(String(c[1] ?? "")),
      );
      expect(warningEmitted).toBe(true);

      // Persisted record must be present.
      expect(task.mergeDetails?.integrityWarning).toBeDefined();
      expect(task.mergeDetails?.integrityWarning?.reason).toBe("no-owned-commit-foreign-deltas");
      expect(typeof task.mergeDetails?.integrityWarning?.warnedAt).toBe("string");
      expect(events.filter((event: any) => event?.mutationType === "task:integrity-warning")).toHaveLength(1);

      manager.stop();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does NOT re-emit the warning on a second sweep within the same instance", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fn-4811-dedup-same-"));
    try {
      const taskId = "FN-DEDUP-2";
      setupForeignOnlyRepo(dir, taskId);
      const task = makeUnprovenDoneTask(taskId);

      const events: unknown[] = [];
      const store = makeStore(task, events);
      const manager = new SelfHealingManager(store, { rootDir: dir });

      await manager.reconcileDoneTaskIntegrity();
      (store.logEntry as ReturnType<typeof vi.fn>).mockClear();
      await manager.reconcileDoneTaskIntegrity();

      const logCalls = (store.logEntry as ReturnType<typeof vi.fn>).mock.calls;
      const reWarned = logCalls.some((c: any[]) =>
        /Integrity warning: done-task finalize evidence is unproven/.test(String(c[1] ?? "")),
      );
      expect(reWarned).toBe(false);
      expect(events.filter((event: any) => event?.mutationType === "task:integrity-warning")).toHaveLength(1);

      manager.stop();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does NOT re-emit the warning across a simulated engine restart (persisted dedup)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fn-4811-dedup-restart-"));
    try {
      const taskId = "FN-DEDUP-3";
      setupForeignOnlyRepo(dir, taskId);
      // Seed task with the warning persisted from a prior session.
      const task = makeUnprovenDoneTask(taskId);
      task.mergeDetails = {
        integrityWarning: {
          warnedAt: "2026-05-16T22:00:00.000Z",
          reason: "no-owned-commit-foreign-deltas",
        },
      };

      const store = makeStore(task);
      // Fresh manager == fresh in-memory dedup Set, simulating restart.
      const manager = new SelfHealingManager(store, { rootDir: dir });

      await manager.reconcileDoneTaskIntegrity();

      const logCalls = (store.logEntry as ReturnType<typeof vi.fn>).mock.calls;
      const warned = logCalls.some((c: any[]) =>
        /Integrity warning: done-task finalize evidence is unproven/.test(String(c[1] ?? "")),
      );
      expect(warned).toBe(false);

      manager.stop();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("DOES re-emit the warning if the classification reason changes (different problem)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fn-4811-dedup-reason-"));
    try {
      const taskId = "FN-DEDUP-4";
      setupForeignOnlyRepo(dir, taskId);
      const task = makeUnprovenDoneTask(taskId);
      // Seed a persisted warning with a DIFFERENT reason than the current classification.
      task.mergeDetails = {
        integrityWarning: {
          warnedAt: "2026-05-16T22:00:00.000Z",
          reason: "missing-evidence",
        },
      };

      const events: unknown[] = [];
      const store = makeStore(task, events);
      const manager = new SelfHealingManager(store, { rootDir: dir });

      await manager.reconcileDoneTaskIntegrity();

      const logCalls = (store.logEntry as ReturnType<typeof vi.fn>).mock.calls;
      const warned = logCalls.some((c: any[]) =>
        /Integrity warning: done-task finalize evidence is unproven/.test(String(c[1] ?? "")),
      );
      expect(warned).toBe(true);
      // Persisted record updated to the new reason.
      expect(task.mergeDetails?.integrityWarning?.reason).toBe("no-owned-commit-foreign-deltas");
      expect(events.filter((event: any) => event?.mutationType === "task:integrity-warning")).toHaveLength(1);

      manager.stop();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
