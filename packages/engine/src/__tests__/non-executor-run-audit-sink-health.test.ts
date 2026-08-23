import { describe, expect, it, vi } from "vitest";

const mergerAiAuditCapture = vi.hoisted(() => ({ fences: [] as Array<{ recordAudit?: (category: string, interaction: string, suppressedCount: number) => Promise<void> }> }));
const projectEngineAuditCapture = vi.hoisted(() => ({ promotionOptions: [] as Array<{ recordAudit?: (event: Record<string, unknown>) => Promise<void> }> }));

vi.mock("../merge/group-merge-coordinator.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../merge/group-merge-coordinator.js")>();
  return {
    ...actual,
    promoteBranchGroup: vi.fn(async (options: { recordAudit?: (event: Record<string, unknown>) => Promise<void> }) => {
      projectEngineAuditCapture.promotionOptions.push(options);
      return { ok: true, reason: "captured" };
    }),
  };
});

vi.mock("../merge/merge-write-fence.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../merge/merge-write-fence.js")>();
  return {
    ...actual,
    createMergeWriteFence: (options: Parameters<typeof actual.createMergeWriteFence>[0]) => {
      mergerAiAuditCapture.fences.push(options);
      return actual.createMergeWriteFence(options);
    },
  };
});
import { createRunAuditor } from "../util/run-audit.js";
import { SelfHealingManager } from "../self-healing.js";
import { Scheduler } from "../scheduler.js";
import { ProjectEngine, emitMergeRequestShadowDequeueParityAudit } from "../project-engine.js";
import { MissionExecutionLoop } from "../missions/mission-execution-loop.js";
import { PrReconciler } from "../merge/pr-reconcile.js";
import { aiMergeTask } from "../merger.js";
import { recordBranchGroupPrSyncFailureAudit, runAiMerge } from "../merge/merger-ai.js";
import { createMergeAbortedError } from "../merge/merge-write-fence.js";
import { PluginRunner } from "../plugins/plugin-runner.js";
import { getWorkflowExtensionRegistry, workflowExtensionRegistryId } from "@fusion/core";
import { RUN_AUDIT_EMIT_TIMEOUT_MS } from "../util/emit-bounded-run-audit.js";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, existsSync: vi.fn(() => true) };
});

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, readFile: vi.fn(async () => "# Task\nBody") };
});

/**
 * FNXC:RunAudit 2026-08-20-05:12:
 * FN-9175 exercises lifecycle-owned audit entry points with hostile store sinks rather than only
 * inspecting imports. The matrix preserves the observable owner result while the shared seam
 * absorbs absent, throwing, rejecting, stalled, and late-settling telemetry dependencies.
 */
type SinkMode = "absent" | "throw" | "reject" | "pending" | "late-resolve" | "late-reject";

function sinkFor(mode: SinkMode) {
  let settle: (() => void) | undefined;
  let reject: ((error: Error) => void) | undefined;
  const recordRunAuditEvent = mode === "absent" ? undefined : vi.fn(() => {
    if (mode === "throw") throw new Error("sync audit failure");
    if (mode === "reject") return Promise.reject(new Error("rejected audit failure"));
    if (mode === "pending") return new Promise<void>(() => undefined);
    return new Promise<void>((resolve, rejectPromise) => {
      settle = resolve;
      reject = rejectPromise;
    });
  });
  return { mode, host: recordRunAuditEvent ? { recordRunAuditEvent } : {}, recordRunAuditEvent, settle: () => settle?.(), reject: () => reject?.(new Error("late audit failure")) };
}

async function settleBounded<T>(sink: ReturnType<typeof sinkFor>, run: () => Promise<T> | T): Promise<T> {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  vi.useFakeTimers();
  try {
    const pending = Promise.resolve().then(run);
    // Lifecycle entry points cross several resolved store awaits before registering the bound.
    // Advance in bounded turns so the audit timer is observed regardless of that depth.
    for (let turn = 0; turn < 4; turn += 1) {
      await vi.advanceTimersByTimeAsync(RUN_AUDIT_EMIT_TIMEOUT_MS + 1);
    }
    const result = await pending;
    // FNXC:RunAudit 2026-08-20-05:22:
    // A timed-out audit promise may settle after its owning lifecycle branch returned. Exercise
    // both terminal paths here so every module proves the seam pre-observes late rejection.
    if (sink.mode === "late-resolve") sink.settle();
    if (sink.mode === "late-reject") sink.reject();
    await Promise.resolve();
    await Promise.resolve();
    expect(unhandled).toEqual([]);
    return result;
  } finally {
    process.off("unhandledRejection", onUnhandled);
    vi.useRealTimers();
  }
}

const hostileModes: SinkMode[] = ["absent", "throw", "reject", "pending", "late-resolve", "late-reject"];

describe("FN-9175 non-executor audit sink health", () => {
  describe("util/run-audit.ts createRunAuditor", () => {
    it.each(hostileModes)("keeps every domain auditor callable with a %s sink", async (mode) => {
      const sink = sinkFor(mode);
      const auditor = createRunAuditor(sink.host as any, { taskId: "FN-9175", agentId: "engine", runId: "run-9175", phase: "sink-health" });
      await settleBounded(sink, async () => {
        await Promise.all([
          auditor.git({ type: "git:commit", target: "HEAD", metadata: { revision: "a" } } as any),
          auditor.database({ type: "task:update", target: "FN-9175", metadata: { outcome: "ok" } } as any),
          auditor.filesystem({ type: "file:write", target: "x", metadata: {} } as any),
          auditor.sandbox({ type: "sandbox:run", target: "x", metadata: {} } as any),
        ]);
        return "domains-survived";
      }).then((result) => expect(result).toBe("domains-survived"));
    });

    it("preserves the domain payload", async () => {
      const recordRunAuditEvent = vi.fn().mockResolvedValue(undefined);
      const auditor = createRunAuditor({ recordRunAuditEvent } as any, { taskId: "FN-9175", agentId: "engine", runId: "run-9175", phase: "sink-health" });
      await auditor.database({ type: "task:update", target: "FN-9175", metadata: { outcome: "ok" } } as any);
      expect(recordRunAuditEvent).toHaveBeenCalledWith({ taskId: "FN-9175", agentId: "engine", runId: "run-9175", domain: "database", mutationType: "task:update", target: "FN-9175", metadata: { phase: "sink-health", outcome: "ok" } });
    });
  });

  describe("self-healing.ts recovery entry points", () => {
    it.each(hostileModes)("returns the reconciled count with a %s audit sink", async (mode) => {
      const sink = sinkFor(mode);
      const store = { ...sink.host, reconcileStaleSymbolLocks: vi.fn().mockResolvedValue({ reconciled: ["task:FN-9175"] }) };
      const manager = new SelfHealingManager(store as any, { rootDir: "/tmp/fn-9175" });
      await expect(settleBounded(sink, () => manager.reconcileStaleSymbolLocks())).resolves.toBe(1);
      expect(store.reconcileStaleSymbolLocks).toHaveBeenCalledOnce();
      manager.stop();
    });

    it.each(hostileModes)("keeps no-progress retry and exhaustion mutations bounded with a %s audit sink", async (mode) => {
      const sink = sinkFor(mode);
      const task = {
        id: `FN-9186-${mode}`,
        column: "in-progress",
        status: "failed",
        error: "Agent finished without calling fn_task_done: sandbox unavailable",
        paused: false,
        steps: [],
      };
      const store = {
        ...sink.host,
        getSettings: vi.fn().mockResolvedValue({ maintenanceIntervalMs: 0 }),
        listTasks: vi.fn(async ({ column }: { column: string }) => column === task.column ? [{ ...task }] : []),
        updateTaskAtomic: vi.fn(async (_id: string, updater: (live: typeof task) => Partial<typeof task> | null) => {
          const patch = await updater({ ...task });
          if (patch) Object.assign(task, patch);
          return { ...task };
        }),
        moveTask: vi.fn(async () => { task.column = "todo"; }),
        logEntry: vi.fn().mockResolvedValue(undefined),
        getRootDir: vi.fn(() => "/tmp/fn-9175"),
      };
      const manager = new SelfHealingManager(store as any, { rootDir: "/tmp/fn-9175", getExecutingTaskIds: () => new Set() });
      vi.spyOn(manager as any, "hasRecoverableGitWork").mockResolvedValue(false);
      vi.spyOn(manager as any, "evaluateBackwardMoveTripleProof").mockResolvedValue({ ok: true });
      await expect(settleBounded(sink, () => manager.recoverNoProgressNoTaskDoneFailures())).resolves.toBe(1);
      expect(store.moveTask).toHaveBeenCalledOnce();

      Object.assign(task, {
        column: "in-progress",
        status: "failed",
        error: "Agent finished without calling fn_task_done: sandbox unavailable",
        taskDoneRetryCount: 3,
        recoveryRetryCount: 3,
        nextRecoveryAt: undefined,
      });
      await expect(settleBounded(sink, () => manager.recoverNoProgressNoTaskDoneFailures())).resolves.toBe(0);
      expect(task.error).toMatch(/^NO_PROGRESS_REQUEUE_BUDGET_EXHAUSTED:/);
      expect(store.moveTask).toHaveBeenCalledOnce();
      manager.stop();
    });

    it.each(hostileModes)("reclaims a wedged active merge with a %s audit sink", async (mode) => {
      const sink = sinkFor(mode);
      const task = { id: "FN-WEDGE", title: "wedged", description: "", column: "in-review", status: "reviewing", paused: false, dependencies: [], steps: [], updatedAt: "2026-01-01T00:00:00.000Z" };
      const store = {
        ...sink.host,
        getSettings: vi.fn().mockResolvedValue({ globalPause: false, enginePaused: false, autoMerge: true, taskStuckTimeoutMs: 1 }),
        getTask: vi.fn().mockResolvedValue(task),
        updateTask: vi.fn().mockResolvedValue(undefined),
        logEntry: vi.fn().mockResolvedValue(undefined),
        getAgentLogs: vi.fn().mockResolvedValue([]),
        parseFileScopeFromPrompt: vi.fn().mockResolvedValue([]),
      };
      const manager = new SelfHealingManager(store as any, {
        rootDir: "/tmp/fn-9175",
        getActiveMergeTaskId: () => task.id,
        getActiveMergeStartedAtMs: () => Date.now() - 1_000,
        abortActiveMerge: vi.fn(() => true),
        clearMergeActive: vi.fn(),
      });
      await expect(settleBounded(sink, () => manager.recoverWedgedActiveMerge())).resolves.toBe(1);
      expect(store.updateTask).toHaveBeenCalledWith(task.id, { status: null, error: null });
      expect(store.logEntry).toHaveBeenCalledOnce();
      manager.stop();
    });
  });

  describe("scheduler.ts dispatch entry point", () => {
    it.each(hostileModes)("completes the owning-node handoff with a %s audit sink", async (mode) => {
      const sink = sinkFor(mode);
      const task = {
        id: "FN-9175", description: "x", column: "todo", workflowStepResults: [{ workflowStepId: "plan-review", workflowStepName: "Plan Review", status: "passed", source: "node", phase: "pre-merge" }], dependencies: [], steps: [], currentStep: 0, log: [], createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", nodeId: "node-task", checkedOutBy: "agent-owner", checkoutNodeId: "node-owner",
      };
      const store = {
        ...sink.host, listTasks: vi.fn().mockResolvedValue([task]), getSettings: vi.fn().mockResolvedValue({ maxConcurrent: 1, maxWorktrees: 1, owningNodeHandoffPolicy: "block", unavailableNodePolicy: "block" }), getTask: vi.fn().mockResolvedValue(task), updateSettings: vi.fn().mockResolvedValue(undefined), updateTask: vi.fn().mockResolvedValue(undefined), moveTask: vi.fn().mockResolvedValue(undefined), parseFileScopeFromPrompt: vi.fn().mockResolvedValue([]), logEntry: vi.fn().mockResolvedValue(undefined), getRootDir: vi.fn(() => "/tmp/fn-9175"), getTasksDir: vi.fn(() => "/tmp/fn-9175/.fusion/tasks"), on: vi.fn(), off: vi.fn(),
      };
      const scheduler = new Scheduler(store as any, { nodeHealthMonitor: { getNodeHealth: vi.fn(() => "offline") } as any });
      (scheduler as any).running = true;
      await expect(settleBounded(sink, () => scheduler.schedule())).resolves.toBeUndefined();
      // The real scheduler branch returned after its post-audit dispatch bookkeeping.
      scheduler.stop();
    });
  });

  describe("project-engine.ts shadow dequeue audit", () => {
    it.each(hostileModes)("keeps shadow dequeue synchronous for %s", async (mode) => {
      const sink = sinkFor(mode);
      await expect(settleBounded(sink, () => {
        expect(() => emitMergeRequestShadowDequeueParityAudit(sink.host, "FN-9175", null)).not.toThrow();
      })).resolves.toBeUndefined();
    });
  });

  describe("merge/pr-reconcile.ts poller entry point", () => {
    it.each(hostileModes)("returns the unchanged reconcile outcome with a %s audit sink", async (mode) => {
      const sink = sinkFor(mode);
      const entity = { id: "PR-9175", sourceType: "task", sourceId: "FN-9175", repo: "fusion/test", prNumber: 9175, state: "open", unverified: false };
      const reconciler = new PrReconciler({
        store: { ...sink.host, listActivePrEntities: vi.fn().mockResolvedValue([entity]) } as any,
        ops: { probe: vi.fn().mockResolvedValue({ changed: true }), fetchPrState: vi.fn().mockRejectedValue(new Error("GitHub unavailable")) },
      });
      await expect(settleBounded(sink, () => reconciler.reconcileRepoOnce(entity.repo))).resolves.toEqual([]);
      reconciler.stopAll();
    });
  });

  describe("missions/mission-execution-loop.ts validator reaper", () => {
    it.each(hostileModes)("retains reapedCount with a %s audit sink", async (mode) => {
      const sink = sinkFor(mode);
      const missionStore = {
        listStaleRunningValidatorRuns: vi.fn().mockResolvedValue([{ id: "VR-9175", featureId: "F-9175", milestoneId: "MS-9175", triggerType: "manual", startedAt: new Date().toISOString() }]),
        reapValidatorRun: vi.fn().mockResolvedValue({ id: "VR-9175", featureId: "F-9175", milestoneId: "MS-9175", triggerType: "manual" }),
        getMilestone: vi.fn().mockResolvedValue({ missionId: "M-9175" }),
        getMission: vi.fn().mockResolvedValue({ id: "M-9175" }),
      };
      const loop = new MissionExecutionLoop({ taskStore: sink.host as any, missionStore: missionStore as any, rootDir: "/tmp/fn-9175" });
      await expect(settleBounded(sink, () => loop.reapStaleValidatorRuns(1))).resolves.toEqual({ reapedCount: 1 });
    });
  });

  describe("project-engine.ts promotion audit closure", () => {
    it.each(hostileModes)("keeps the public promotion callback resolving for a %s sink", async (mode) => {
      projectEngineAuditCapture.promotionOptions.length = 0;
      const sink = sinkFor(mode);
      const engine = new ProjectEngine({ projectId: `audit-${mode}`, workingDirectory: "/tmp/fn-9175", isolationMode: "in-process", maxConcurrent: 1, maxWorktrees: 1 } as any, { on: vi.fn(), off: vi.fn() } as any, { skipNotifier: true });
      // The runtime normally owns this field after start; this narrow injected store lets the
      // public promotion method reach the callback it hands to the coordinator.
      (engine as any).runtime = { getTaskStore: () => ({ ...sink.host, getSettings: vi.fn().mockResolvedValue({}) }) };
      await expect(engine.promoteBranchGroup("BG-9175")).resolves.toMatchObject({ ok: true });
      const recordAudit = projectEngineAuditCapture.promotionOptions.at(-1)?.recordAudit;
      expect(recordAudit).toBeTypeOf("function");
      await expect(settleBounded(sink, () => recordAudit!({ domain: "git", mutationType: "branch-group:promotion", target: "BG-9175", metadata: {} }))).resolves.toBeUndefined();
    });
  });

  describe("merge/merger-ai.ts fenced audit closure", () => {
    it.each(hostileModes)("returns a resolving fence audit promise with a %s sink", async (mode) => {
      mergerAiAuditCapture.fences.length = 0;
      const sink = sinkFor(mode);
      /* FNXC:RequiredPreMergeSteps 2026-08-23-18:07: this fixture must REACH runAiMerge's generation
         fence (see the note below), so it must clear the merge door first. An unspecified optional-step
         list makes the door refuse on the workflow's default-on Plan/Code Review groups before any
         fence is constructed, leaving `fences` empty and `recordAudit` undefined. */
      const task = { id: "FN-9175", title: "merge", description: "", column: "in-review", branch: "missing-fn-9175", enabledWorkflowSteps: [], steps: [{ name: "Ship", status: "done" }], currentStep: 1, workflowStepResults: [], dependencies: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
      const store = { ...sink.host, getTask: vi.fn().mockResolvedValue(task), getSettings: vi.fn().mockResolvedValue({ integrationBranch: "main" }), getTaskWorkflowSelection: vi.fn().mockReturnValue(undefined), updateTask: vi.fn().mockResolvedValue(undefined), logEntry: vi.fn().mockResolvedValue(undefined), appendAgentLog: vi.fn().mockResolvedValue(undefined) };
      // The missing branch is intentional: runAiMerge constructs its real generation fence before
      // git rejects the branch, allowing this test to exercise the closure the production path gave it.
      const mergeError = await runAiMerge(store as any, process.cwd(), task.id).then(() => "resolved", (error) => String(error));
      expect(mergeError).not.toBe("resolved");
      const recordAudit = mergerAiAuditCapture.fences.at(-1)?.recordAudit;
      expect(recordAudit).toBeTypeOf("function");
      await expect(settleBounded(sink, () => recordAudit!("orphan", "suppressed", 1))).resolves.toBeUndefined();
    });

    it("rethrows an aborted PR sync before its production audit helper writes", () => {
      const recordRunAuditEvent = vi.fn();
      const abort = createMergeAbortedError("FN-9175");
      expect(() => recordBranchGroupPrSyncFailureAudit({ recordRunAuditEvent }, "FN-9175", "BG-9175", abort)).toThrow(abort);
      expect(recordRunAuditEvent).not.toHaveBeenCalled();
    });
  });

  describe("merger.ts finalized-task branch", () => {
    it.each(hostileModes)("returns the finalization outcome with a %s audit sink", async (mode) => {
      const sink = sinkFor(mode);
      const task = { id: "FN-9175", title: "done", description: "", column: "done", steps: [], dependencies: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
      const store = { ...sink.host, getTask: vi.fn().mockResolvedValue(task), getSettings: vi.fn().mockResolvedValue({}), getTaskWorkflowSelection: vi.fn().mockReturnValue(undefined) };
      await expect(settleBounded(sink, () => aiMergeTask(store as any, "/tmp/fn-9175", task.id))).resolves.toMatchObject({ reason: "already-finalized", noOp: true });
      expect(store.getTask).toHaveBeenCalledWith(task.id);
    });
  });

  describe("plugins/plugin-runner.ts forced workflow-extension degradation", () => {
    it.each(hostileModes)("returns degraded extensions with a %s audit sink", async (mode) => {
      const sink = sinkFor(mode);
      const pluginId = `sink-health-${mode}`;
      const extensionId = "move-policy";
      const registryId = workflowExtensionRegistryId(pluginId, extensionId);
      const loader = { getPluginWorkflowExtensions: vi.fn(() => [{ pluginId, extension: { extensionId, name: "Move policy", kind: "move-policy", schemaVersion: 1, fallback: "degradeToDefault" } }]) };
      const runner = new PluginRunner({ pluginLoader: loader, pluginStore: {} as any, taskStore: sink.host as any, rootDir: "/tmp/fn-9175" });
      runner.syncPluginWorkflowExtensions();
      try {
        await expect(settleBounded(sink, () => runner.disablePluginWorkflowExtensions(pluginId, { force: true }))).resolves.toEqual({ degraded: [registryId], dependents: [] });
      } finally {
        getWorkflowExtensionRegistry().unregister(registryId);
      }
    });
  });
});
