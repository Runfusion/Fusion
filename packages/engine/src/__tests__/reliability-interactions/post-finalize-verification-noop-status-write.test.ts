import { beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import type { Settings, Task, TaskStore } from "@fusion/core";

const testState = vi.hoisted(() => ({
  runAiMerge: vi.fn(),
  currentStore: null as (TaskStore & EventEmitter) | null,
}));

// FNXC:MergerUnification 2026-06-21-19:05: master-plan U0 unified the merge
// dispatch onto runAiMerge (merger-ai.js). This test uses the merge fn as a
// mockable seam to inject a verification failure; it now mocks runAiMerge.
vi.mock("../../merge/merger-ai.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../merge/merger-ai.js")>();
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
      /*
      FNXC:EngineTests 2026-07-15-11:50:
      ProjectEngine.merge forwards pluginRunner via runtime.getPluginRunner(); incomplete
      runtime mocks throw during AI merge and force tasks to failed instead of exercising
      the post-finalize verification noop path under test.
      */
      getPluginRunner: vi.fn(() => undefined),
    };
  }),
}));

import { ProjectEngine } from "../../project-engine.js";

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "FN-5003",
    title: "t",
    description: "d",
    column: "in-review",
    status: "merging",
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    verificationFailureCount: 0,
    ...overrides,
  } as Task;
}

function createStore(task: Task, sequence: Task[]) {
  const emitter = new EventEmitter();
  const logs: string[] = [];
  const audits: Array<{ mutationType: string; metadata?: Record<string, unknown> }> = [];
  let taskIdx = 0;
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
    updateTask: vi.fn(async () => undefined),
    addTaskComment: vi.fn(async () => undefined),
    moveTask: vi.fn(async () => undefined),
    logEntry: vi.fn(async (_id: string, message: string) => {
      logs.push(message);
    }),
    getActiveMergingTask: vi.fn(() => null),
    createTask: vi.fn(async () => ({ id: "FN-CHILD" })),
    on: emitter.on.bind(emitter),
    off: emitter.off.bind(emitter),
    walCheckpoint: () => ({ busy: 0, log: 0, checkpointed: 0 }),
    archiveTaskAndCleanup: async () => ({}),
    clearStaleExecutionStartBranchReferences: () => [],
    updateSettings: async () => ({}),
    mergeTask: async () => undefined,
    getRootDir: () => "",
    recordRunAuditEvent: vi.fn(async (input: { mutationType: string; metadata?: Record<string, unknown> }) => {
      audits.push({ mutationType: input.mutationType, metadata: input.metadata });
    }),
  }) as unknown as TaskStore & EventEmitter;

  return { store, logs, audits };
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

describe("post-finalize verification noop status-write guard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    testState.runAiMerge.mockReset();
    testState.currentStore = null;
  });

  it.each([
    { name: "under-cap", failureCount: 1, blockedStatus: "merging-fix" },
    { name: "at-cap", failureCount: 2, blockedStatus: "failed" },
  ])("keeps done task unchanged on $name write path", async ({ failureCount, blockedStatus }) => {
    const verificationError = new Error("Deterministic test verification failed: no-op race");
    verificationError.name = "VerificationError";
    testState.runAiMerge.mockRejectedValueOnce(verificationError);

    const inReviewTask = makeTask({ verificationFailureCount: failureCount });
    const doneTask = makeTask({
      column: "done",
      verificationFailureCount: failureCount,
      mergeDetails: { mergeConfirmed: true, commitSha: "abcdef1234567890" },
    });

    // FNXC:MergerUnification 2026-06-21-19:05: the U0 R7 guard adds one
    // store.getTask read at the merge dispatch before runAiMerge, so the read
    // sequence gains one leading in-review entry; the post-failure recovery still
    // resolves the same done-task tail (the "already-done task" no-op path).
    const { store, logs, audits } = createStore(inReviewTask, [inReviewTask, inReviewTask, inReviewTask, inReviewTask, doneTask]);
    testState.currentStore = store;

    const engine = new ProjectEngine(
      {
        projectId: "proj_test",
        workingDirectory: process.cwd(),
        isolationMode: "in-process",
        maxConcurrent: 1,
        maxWorktrees: 1,
      },
      {} as never,
      { skipNotifier: true },
    );

    await runMergeCycle(engine, inReviewTask.id);

    expect(store.updateTask).not.toHaveBeenCalledWith(
      inReviewTask.id,
      expect.objectContaining({ status: blockedStatus }),
    );
    expect(store.moveTask).not.toHaveBeenCalledWith(inReviewTask.id, "in-progress");
    expect(store.createTask).not.toHaveBeenCalledWith(
      expect.objectContaining({ source: expect.objectContaining({ sourceType: "recovery" }) }),
    );

    // FNXC:MergerUnification 2026-07-07-08:35:
    // FN-4944's post-finalize guard added an earlier "already-on-main fast-path"
    // no-op that fires whenever a done + merge-confirmed task hits a verification
    // error, BEFORE the bounce-cap logic. This scenario (done task, VerificationError)
    // now resolves through that fast-path, whose log message differs from the older
    // cap-reached "already-done task" wording. Pin the fast-path message text here;
    // the no-op count (1) and the task:post-finalize-verification-no-op audit are
    // unchanged across both paths.
    const noopLogs = logs.filter((entry) =>
      entry.includes("[verification] post-finalize verification failed for already-on-main fast-path; no action"),
    );
    expect(noopLogs).toHaveLength(1);

    const noopAudits = audits.filter((event) => event.mutationType === "task:post-finalize-verification-no-op");
    expect(noopAudits).toHaveLength(1);
    expect(noopAudits[0]?.metadata).toEqual(expect.objectContaining({
      failedCommand: null,
      exitCode: null,
    }));
  });
});
