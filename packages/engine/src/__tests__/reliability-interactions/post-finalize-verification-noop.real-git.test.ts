import { beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { EventEmitter } from "node:events";
import type { Settings, Task, TaskStore } from "@fusion/core";
import { commitOrAmendMergeWithFixes } from "../../merger.js";
import { SelfHealingManager } from "../../self-healing.js";

const testState = vi.hoisted(() => ({
  runAiMerge: vi.fn(),
  currentStore: null as (TaskStore & EventEmitter) | null,
}));

// FNXC:MergerUnification 2026-06-21-19:05: master-plan U0 unified the merge
// dispatch onto runAiMerge (merger-ai.js). This test injects a verification
// failure through the merge seam, so it now mocks runAiMerge. merger.js stays
// real (importOriginal) for commitOrAmendMergeWithFixes used below.
vi.mock("../../merger-ai.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../merger-ai.js")>();
  return {
    ...actual,
    runAiMerge: testState.runAiMerge,
  };
});

vi.mock("../../runtimes/in-process-runtime.js", () => ({
  InProcessRuntime: vi.fn().mockImplementation(function () {
    return {
      start: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined),
      getTaskStore: () => testState.currentStore,
      getAgentStore: vi.fn(),
      getMessageStore: vi.fn(),
      getRoutineStore: vi.fn(),
      getRoutineRunner: vi.fn(),
      getHeartbeatMonitor: vi.fn(),
      getTriggerScheduler: vi.fn(),
    };
  }),
}));

import { ProjectEngine } from "../../project-engine.js";

function git(dir: string, cmd: string): string {
  return execSync(cmd, { cwd: dir, stdio: "pipe" }).toString().trim();
}

function createStore(task: Task, taskSequence?: Task[]) {
  const emitter = new EventEmitter();
  const comments: string[] = [];
  const logs: string[] = [];
  let taskIdx = 0;
  const sequence = taskSequence ?? [task];

  const store = Object.assign(emitter, {
    getSettings: vi.fn(async () => ({
      autoMerge: true,
      autoResolveConflicts: true,
      globalPause: false,
      enginePaused: false,
      pollIntervalMs: 15_000,
      // FNXC:MergerUnification 2026-06-21-19:05: U0 unified merges onto runAiMerge;
      // no `merger.mode` pin needed (dispatch ignores it).
    } as Settings)),
    listTasks: vi.fn(async () => [task]),
    getTask: vi.fn(async () => {
      const current = sequence[Math.min(taskIdx, sequence.length - 1)] ?? task;
      taskIdx += 1;
      return current;
    }),
    updateTask: vi.fn(async (_id: string, updates: Partial<Task>) => Object.assign(task, updates)),
    addTaskComment: vi.fn(async (_id: string, comment: string) => {
      comments.push(comment);
    }),
    moveTask: vi.fn(async (_id: string, column: Task["column"]) => {
      task.column = column;
    }),
    logEntry: vi.fn(async (_id: string, message: string) => {
      logs.push(message);
    }),
    getActiveMergingTask: vi.fn(() => null),
    createTask: vi.fn(),
    on: emitter.on.bind(emitter),
    off: emitter.off.bind(emitter),
    walCheckpoint: () => ({ busy: 0, log: 0, checkpointed: 0 }),
    archiveTaskAndCleanup: async () => ({}),
    clearStaleExecutionStartBranchReferences: () => [],
    updateSettings: async () => ({}),
    mergeTask: async () => undefined,
    getRootDir: () => "",
    recordRunAuditEvent: async () => undefined,
  }) as unknown as TaskStore & EventEmitter;

  return { store, comments, logs };
}

async function runMergeCycle(engine: ProjectEngine, taskId: string): Promise<void> {
  const privateEngine = engine as unknown as {
    mergeQueue: string[];
    mergeActive: Set<string>;
    drainMergeQueue: () => Promise<void>;
  };

  privateEngine.mergeActive.add(taskId);
  privateEngine.mergeQueue.push(taskId);
  await privateEngine.drainMergeQueue();
}

describe("post-finalize verification failure reliability interactions (real git)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    testState.runAiMerge.mockReset();
    testState.currentStore = null;
  });

  it("keeps finalized already-on-main tasks in done when delayed verification fails", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fn-4944-ri-"));
    try {
      git(dir, "git init -b main");
      git(dir, 'git config user.email "test@example.com"');
      git(dir, 'git config user.name "Test"');
      git(dir, "git commit --allow-empty -m init");

      git(dir, "git commit --allow-empty -m 'feat(FN-4944): unrelated'");
      const branchTip = git(dir, "git rev-parse HEAD");
      writeFileSync(join(dir, "file.txt"), "task\n");
      git(dir, "git add file.txt");
      git(dir, "git commit -m 'feat(FN-4944): landed' -m 'Fusion-Task-Id: FN-4944'");
      const landedSha = git(dir, "git rev-parse HEAD");
      git(dir, "git commit --allow-empty -m 'chore: post'");
      const preAttemptHeadSha = git(dir, "git rev-parse HEAD");
      git(dir, `git branch fusion/fn-4944 ${branchTip}`);

      const finalized = await commitOrAmendMergeWithFixes(
        dir,
        "FN-4944",
        "fusion/fn-4944",
        "feat(FN-4944): merge",
        true,
        preAttemptHeadSha,
        "",
        undefined,
        undefined,
        undefined,
        null,
        null,
        null,
        new Set<string>(),
      );
      expect(finalized.ok && finalized.reason === "branch-already-merged-on-main").toBe(true);

      const task = {
        id: "FN-4944",
        title: "t",
        description: "d",
        column: "done",
        dependencies: [],
        steps: [],
        currentStep: 0,
        log: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        branch: "fusion/fn-4944",
        baseBranch: "main",
        status: null,
        mergeDetails: { mergeConfirmed: true, commitSha: landedSha, mergedAt: new Date().toISOString() },
      } as unknown as Task;

      const preFinalizeTask = {
        ...task,
        column: "in-review",
        status: "merging",
        mergeDetails: undefined,
      } as unknown as Task;
      const { store, comments, logs } = createStore(task, [preFinalizeTask, task]);
      testState.currentStore = store;

      const verificationError = new Error("Deterministic test verification failed");
      verificationError.name = "VerificationError";
      testState.runAiMerge.mockRejectedValueOnce(verificationError);

      const engine = new ProjectEngine(
        {
          projectId: "proj_test",
          workingDirectory: dir,
          isolationMode: "in-process",
          maxConcurrent: 1,
          maxWorktrees: 1,
        },
        {} as never,
        { skipNotifier: true },
      );

      await runMergeCycle(engine, task.id);

      expect(task.column).toBe("done");
      expect(task.status ?? null).toBeNull();
      expect(task.mergeDetails?.mergeConfirmed).toBe(true);
      expect(comments.some((comment) => comment.includes("Please fix the failing"))).toBe(false);
      expect(logs.some((entry) => entry.includes("[verification] post-finalize verification failed for already-on-main fast-path; no action"))).toBe(true);

      const manager = new SelfHealingManager(store, { rootDir: dir, getExecutingTaskIds: () => new Set() });
      await expect(manager.recoverStaleMergingStatus()).resolves.toBe(0);
      await expect(manager.recoverInterruptedMergingTasks()).resolves.toBe(0);
      expect(task.column).toBe("done");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);
});
