import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { CronRunner } from "./cron-runner.js";
import type { AiPromptExecutor } from "./cron-runner.js";
import type { TaskStore, AutomationStore, ScheduledTask, AutomationRunResult, AutomationStep, Settings } from "@fusion/core";
import { randomUUID } from "node:crypto";

// Default settings inline to avoid @fusion/core build dependency during tests
const DEFAULT_SETTINGS: Settings = {
  maxConcurrent: 2,
  maxWorktrees: 4,
  pollIntervalMs: 30000,
  autoResolveConflicts: true,
  requirePlanApproval: false,
  recycleWorktrees: false,
  worktreeNaming: "random",
  globalPause: false,
  enginePaused: false,
  ntfyEnabled: false,
  defaultProvider: "anthropic",
  defaultModelId: "claude-sonnet-4-5",
  planningProvider: "anthropic",
  planningModelId: "claude-sonnet-4-5",
  validatorProvider: "openai",
  validatorModelId: "gpt-4o",
  taskStuckTimeoutMs: undefined,
  groupOverlappingFiles: false,
  autoMerge: true,
};

function createMockSchedule(overrides: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id: "test-schedule-id",
    name: "Test Schedule",
    description: "A test schedule",
    scheduleType: "hourly",
    cronExpression: "0 * * * *",
    command: "echo hello",
    enabled: true,
    runCount: 0,
    runHistory: [],
    nextRunAt: new Date(Date.now() - 60000).toISOString(), // past = due
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function createMockStore(settingsOverrides: Partial<Settings> = {}): TaskStore {
  return {
    getSettings: vi.fn().mockResolvedValue({
      ...DEFAULT_SETTINGS,
      ...settingsOverrides,
    }),
    on: vi.fn(),
    off: vi.fn(),
  } as unknown as TaskStore;
}

function createMockAutomationStore(schedules: ScheduledTask[] = []): AutomationStore {
  return {
    getDueSchedules: vi.fn().mockResolvedValue(schedules),
    recordRun: vi.fn().mockResolvedValue(undefined),
    getSchedule: vi.fn().mockImplementation(async (id: string) => {
      const s = schedules.find((s) => s.id === id);
      if (!s) throw new Error(`Schedule ${id} not found`);
      return s;
    }),
  } as unknown as AutomationStore;
}

describe("CronRunner", () => {
  let runner: CronRunner;

  afterEach(() => {
    if (runner) runner.stop();
  });

  describe("start/stop", () => {
    it("starts and stops without error", () => {
      const store = createMockStore();
      const automationStore = createMockAutomationStore();
      runner = new CronRunner(store, automationStore);

      runner.start();
      expect(runner["running"]).toBe(true);

      runner.stop();
      expect(runner["running"]).toBe(false);
    });

    it("is idempotent on start", () => {
      const store = createMockStore();
      const automationStore = createMockAutomationStore();
      runner = new CronRunner(store, automationStore);

      runner.start();
      runner.start(); // should not double-start
      runner.stop();
    });

    it("is safe to stop when not started", () => {
      const store = createMockStore();
      const automationStore = createMockAutomationStore();
      runner = new CronRunner(store, automationStore);

      // Should not throw
      expect(() => runner.stop()).not.toThrow();
    });
  });

  describe("tick", () => {
    it("skips when globalPause is true", async () => {
      const store = createMockStore({ globalPause: true });
      const automationStore = createMockAutomationStore([createMockSchedule()]);
      runner = new CronRunner(store, automationStore);

      await runner.tick();

      expect(automationStore.getDueSchedules).not.toHaveBeenCalled();
    });

    it("skips when enginePaused is true", async () => {
      const store = createMockStore({ enginePaused: true });
      const automationStore = createMockAutomationStore([createMockSchedule()]);
      runner = new CronRunner(store, automationStore);

      await runner.tick();

      expect(automationStore.getDueSchedules).not.toHaveBeenCalled();
    });

    it("does nothing when no schedules are due", async () => {
      const store = createMockStore();
      const automationStore = createMockAutomationStore([]);
      runner = new CronRunner(store, automationStore);

      await runner.tick();

      expect(automationStore.getDueSchedules).toHaveBeenCalledTimes(1);
      expect(automationStore.recordRun).not.toHaveBeenCalled();
    });

    it("handles errors in tick gracefully", async () => {
      const store = createMockStore();
      const automationStore = createMockAutomationStore([createMockSchedule()]);
      
      // Make getDueSchedules throw an error
      (automationStore.getDueSchedules as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error("Database error")
      );
      
      runner = new CronRunner(store, automationStore);

      // Should not throw
      await expect(runner.tick()).resolves.toBeUndefined();
    });

    it("executes due schedules", async () => {
      const store = createMockStore();
      const schedule = createMockSchedule({ command: "echo test-output" });
      const automationStore = createMockAutomationStore([schedule]);
      runner = new CronRunner(store, automationStore);

      await runner.tick();

      expect(automationStore.recordRun).toHaveBeenCalledTimes(1);
      const [id, result] = (automationStore.recordRun as ReturnType<typeof vi.fn>).mock.calls[0] as [string, AutomationRunResult];
      expect(id).toBe(schedule.id);
      expect(result.success).toBe(true);
      expect(result.output).toContain("test-output");
    });

    it("re-entrance guard prevents overlapping ticks", async () => {
      const store = createMockStore();
      const schedule = createMockSchedule({ command: "sleep 0.1 && echo done" });
      const automationStore = createMockAutomationStore([schedule]);
      runner = new CronRunner(store, automationStore);

      // Start first tick
      const tick1 = runner.tick();
      // Attempt second tick immediately
      const tick2 = runner.tick();

      await Promise.all([tick1, tick2]);

      // Should only have recorded one run (second tick was a no-op)
      expect(automationStore.recordRun).toHaveBeenCalledTimes(1);
    });
  });

  describe("executeSchedule", () => {
    it("records successful execution", async () => {
      const store = createMockStore();
      const schedule = createMockSchedule({ command: "echo success" });
      const automationStore = createMockAutomationStore([schedule]);
      runner = new CronRunner(store, automationStore);

      const result = await runner.executeSchedule(schedule);

      expect(result.success).toBe(true);
      expect(result.output).toContain("success");
      expect(result.startedAt).toBeTruthy();
      expect(result.completedAt).toBeTruthy();
    });

    it("records failed execution", async () => {
      const store = createMockStore();
      const schedule = createMockSchedule({ command: "exit 1" });
      const automationStore = createMockAutomationStore([schedule]);
      runner = new CronRunner(store, automationStore);

      const result = await runner.executeSchedule(schedule);

      expect(result.success).toBe(false);
      expect(result.error).toBeTruthy();
    });

    it("records timeout execution", async () => {
      const store = createMockStore();
      const schedule = createMockSchedule({
        command: "sleep 60",
        timeoutMs: 100, // very short timeout
      });
      const automationStore = createMockAutomationStore([schedule]);
      runner = new CronRunner(store, automationStore);

      const result = await runner.executeSchedule(schedule);

      expect(result.success).toBe(false);
      expect(result.error).toContain("timed out");
    }, 10000);

    it("prevents concurrent runs of the same schedule", async () => {
      const store = createMockStore();
      const schedule = createMockSchedule({ command: "sleep 0.2 && echo done" });
      const automationStore = createMockAutomationStore([schedule]);
      runner = new CronRunner(store, automationStore);

      // Start execution
      const exec1 = runner.executeSchedule(schedule);

      // in-flight set should contain the schedule
      expect(runner["inFlight"].has(schedule.id)).toBe(true);

      await exec1;

      // After completion, in-flight should be cleared
      expect(runner["inFlight"].has(schedule.id)).toBe(false);
    });

    it("calls recordRun on automation store", async () => {
      const store = createMockStore();
      const schedule = createMockSchedule({ command: "echo recorded" });
      const automationStore = createMockAutomationStore([schedule]);
      runner = new CronRunner(store, automationStore);

      await runner.executeSchedule(schedule);

      expect(automationStore.recordRun).toHaveBeenCalledWith(
        schedule.id,
        expect.objectContaining({
          success: true,
          output: expect.stringContaining("recorded"),
        }),
      );
    });

    it("captures stderr output", async () => {
      const store = createMockStore();
      const schedule = createMockSchedule({ command: "echo err >&2" });
      const automationStore = createMockAutomationStore([schedule]);
      runner = new CronRunner(store, automationStore);

      const result = await runner.executeSchedule(schedule);

      expect(result.success).toBe(true);
      expect(result.output).toContain("err");
    });

    it("calls recordRun before callback on success", async () => {
      const store = createMockStore();
      const schedule = createMockSchedule({ command: "echo success" });
      const automationStore = createMockAutomationStore([schedule]);

      const callOrder: string[] = [];
      const onProcessed = vi.fn().mockImplementation(() => {
        callOrder.push("callback");
      });

      runner = new CronRunner(store, automationStore, { onScheduleRunProcessed: onProcessed });
      await runner.executeSchedule(schedule);

      expect(callOrder).toContain("callback");
      // recordRun should have been called first
      expect(automationStore.recordRun).toHaveBeenCalledBefore(onProcessed);
    });

    it("invokes callback on successful execution", async () => {
      const store = createMockStore();
      const schedule = createMockSchedule({ command: "echo success" });
      const automationStore = createMockAutomationStore([schedule]);

      const onProcessed = vi.fn();
      runner = new CronRunner(store, automationStore, { onScheduleRunProcessed: onProcessed });

      await runner.executeSchedule(schedule);

      expect(onProcessed).toHaveBeenCalledTimes(1);
      expect(onProcessed).toHaveBeenCalledWith(
        schedule,
        expect.objectContaining({ success: true }),
      );
    });

    it("invokes callback on failed execution", async () => {
      const store = createMockStore();
      const schedule = createMockSchedule({ command: "exit 1" });
      const automationStore = createMockAutomationStore([schedule]);

      const onProcessed = vi.fn();
      runner = new CronRunner(store, automationStore, { onScheduleRunProcessed: onProcessed });

      await runner.executeSchedule(schedule);

      expect(onProcessed).toHaveBeenCalledTimes(1);
      expect(onProcessed).toHaveBeenCalledWith(
        schedule,
        expect.objectContaining({ success: false }),
      );
    });

    it("does not invoke callback when not provided", async () => {
      const store = createMockStore();
      const schedule = createMockSchedule({ command: "echo test" });
      const automationStore = createMockAutomationStore([schedule]);
      runner = new CronRunner(store, automationStore);

      // Should not throw
      await runner.executeSchedule(schedule);
    });

    it("callback errors do not throw or alter returned result", async () => {
      const store = createMockStore();
      const schedule = createMockSchedule({ command: "echo success" });
      const automationStore = createMockAutomationStore([schedule]);

      const onProcessed = vi.fn().mockRejectedValue(new Error("callback failed"));
      runner = new CronRunner(store, automationStore, { onScheduleRunProcessed: onProcessed });

      // Should not throw
      const result = await runner.executeSchedule(schedule);

      expect(result.success).toBe(true);
      expect(result.output).toContain("success");
    });

    it("callback errors do not prevent recordRun", async () => {
      const store = createMockStore();
      const schedule = createMockSchedule({ command: "echo test" });
      const automationStore = createMockAutomationStore([schedule]);

      const onProcessed = vi.fn().mockRejectedValue(new Error("callback failed"));
      runner = new CronRunner(store, automationStore, { onScheduleRunProcessed: onProcessed });

      await runner.executeSchedule(schedule);

      expect(automationStore.recordRun).toHaveBeenCalledTimes(1);
    });

    it("passes schedule and result to callback", async () => {
      const store = createMockStore();
      const schedule = createMockSchedule({
        id: "custom-id",
        name: "Custom Schedule",
        command: "echo custom",
      });
      const automationStore = createMockAutomationStore([schedule]);

      let receivedSchedule: ScheduledTask | undefined;
      let receivedResult: AutomationRunResult | undefined;
      const onProcessed = vi.fn().mockImplementation((s: ScheduledTask, r: AutomationRunResult) => {
        receivedSchedule = s;
        receivedResult = r;
      });

      runner = new CronRunner(store, automationStore, { onScheduleRunProcessed: onProcessed });
      await runner.executeSchedule(schedule);

      expect(receivedSchedule).toEqual(schedule);
      expect(receivedResult).toBeDefined();
      expect(receivedResult!.success).toBe(true);
    });
  });

  describe("concurrent schedule prevention in tick", () => {
    it("skips schedule already in-flight during tick", async () => {
      const store = createMockStore();
      const schedule = createMockSchedule({ command: "sleep 0.3 && echo done" });
      const automationStore = createMockAutomationStore([schedule]);
      runner = new CronRunner(store, automationStore);

      // Start first execution (will block for 300ms)
      const exec1 = runner.executeSchedule(schedule);

      // Tick while execution in progress — should skip the in-flight schedule
      await runner.tick();

      await exec1;

      // Should only have recorded one run (tick skipped it)
      expect(automationStore.recordRun).toHaveBeenCalledTimes(1);
    });
  });

  describe("mid-tick pause detection", () => {
    it("stops executing schedules when pause is detected mid-tick", async () => {
      const store = createMockStore();
      const schedules = [
        createMockSchedule({ id: "s1", name: "First", command: "echo first" }),
        createMockSchedule({ id: "s2", name: "Second", command: "echo second" }),
      ];
      const automationStore = createMockAutomationStore(schedules);

      // Mock getSettings to return paused AFTER first two calls
      // (1st call = initial tick check, 2nd call = before first schedule)
      let callCount = 0;
      (store.getSettings as ReturnType<typeof vi.fn>).mockImplementation(async () => {
        callCount++;
        return {
          ...DEFAULT_SETTINGS,
          globalPause: callCount > 2, // pause before second schedule
        };
      });

      runner = new CronRunner(store, automationStore);
      await runner.tick();

      // Should only execute first schedule, not second
      expect(automationStore.recordRun).toHaveBeenCalledTimes(1);
      const [id] = (automationStore.recordRun as ReturnType<typeof vi.fn>).mock.calls[0] as [string, AutomationRunResult];
      expect(id).toBe("s1");
    });
  });

  describe("multiple schedules", () => {
    it("executes all due schedules in a single tick", async () => {
      const store = createMockStore();
      const schedules = [
        createMockSchedule({ id: "s1", name: "First", command: "echo first" }),
        createMockSchedule({ id: "s2", name: "Second", command: "echo second" }),
      ];
      const automationStore = createMockAutomationStore(schedules);
      runner = new CronRunner(store, automationStore);

      await runner.tick();

      expect(automationStore.recordRun).toHaveBeenCalledTimes(2);
    });
  });

  describe("output truncation", () => {
    it("truncates large output to prevent memory exhaustion", async () => {
      const store = createMockStore();
      // Generate output larger than 10KB using printf
      const schedule = createMockSchedule({
        command: "python3 -c \"print('x' * 15000)\"",
      });
      const automationStore = createMockAutomationStore([schedule]);
      runner = new CronRunner(store, automationStore);

      const result = await runner.executeSchedule(schedule);

      expect(result.success).toBe(true);
      // MAX_OUTPUT_LENGTH = 10 * 1024 = 10240
      expect(result.output.length).toBeLessThanOrEqual(10240 + 20);
      expect(result.output).toContain("[output truncated]");
    });
  });

  describe("error handling", () => {
    it("continues to next schedule when recordRun fails", async () => {
      const store = createMockStore();
      const schedules = [
        createMockSchedule({ id: "s1", name: "First", command: "echo first" }),
        createMockSchedule({ id: "s2", name: "Second", command: "echo second" }),
      ];
      const automationStore = createMockAutomationStore(schedules);

      // Make recordRun fail for first schedule
      let recordCalls = 0;
      (automationStore.recordRun as ReturnType<typeof vi.fn>).mockImplementation(async () => {
        recordCalls++;
        if (recordCalls === 1) throw new Error("Storage error");
        return undefined;
      });

      runner = new CronRunner(store, automationStore);
      await runner.tick();

      // Should still have attempted both schedules
      expect(automationStore.recordRun).toHaveBeenCalledTimes(2);
    });
  });

  describe("poll interval", () => {
    it("enforces minimum poll interval of 10 seconds", () => {
      const store = createMockStore();
      const automationStore = createMockAutomationStore();
      runner = new CronRunner(store, automationStore, { pollIntervalMs: 1000 });

      expect(runner["pollIntervalMs"]).toBe(10000);
    });

    it("defaults to 60 seconds", () => {
      const store = createMockStore();
      const automationStore = createMockAutomationStore();
      runner = new CronRunner(store, automationStore);

      expect(runner["pollIntervalMs"]).toBe(60000);
    });
  });

  // ── Multi-step execution ──────────────────────────────────────────

  describe("multi-step execution", () => {
    function makeStep(overrides: Partial<AutomationStep> = {}): AutomationStep {
      return {
        id: randomUUID(),
        type: "command",
        name: "Test step",
        command: "echo step-output",
        ...overrides,
      };
    }

    it("legacy single-command mode still works when no steps are defined", async () => {
      const store = createMockStore();
      const schedule = createMockSchedule({ command: "echo legacy-mode" });
      const automationStore = createMockAutomationStore([schedule]);
      runner = new CronRunner(store, automationStore);

      const result = await runner.executeSchedule(schedule);

      expect(result.success).toBe(true);
      expect(result.output).toContain("legacy-mode");
      expect(result.stepResults).toBeUndefined();
    });

    it("executes multiple command steps sequentially", async () => {
      const store = createMockStore();
      const schedule = createMockSchedule({
        command: "",
        steps: [
          makeStep({ name: "Step 1", command: "echo first" }),
          makeStep({ name: "Step 2", command: "echo second" }),
        ],
      });
      const automationStore = createMockAutomationStore([schedule]);
      runner = new CronRunner(store, automationStore);

      const result = await runner.executeSchedule(schedule);

      expect(result.success).toBe(true);
      expect(result.stepResults).toHaveLength(2);
      expect(result.stepResults![0].success).toBe(true);
      expect(result.stepResults![0].output).toContain("first");
      expect(result.stepResults![1].success).toBe(true);
      expect(result.stepResults![1].output).toContain("second");
    });

    it("stops on step failure when continueOnFailure is false", async () => {
      const store = createMockStore();
      const schedule = createMockSchedule({
        command: "",
        steps: [
          makeStep({ name: "Failing step", command: "exit 1" }),
          makeStep({ name: "Should not run", command: "echo should-not-run" }),
        ],
      });
      const automationStore = createMockAutomationStore([schedule]);
      runner = new CronRunner(store, automationStore);

      const result = await runner.executeSchedule(schedule);

      expect(result.success).toBe(false);
      expect(result.stepResults).toHaveLength(1); // Only the first step ran
      expect(result.stepResults![0].success).toBe(false);
      expect(result.error).toContain("1 step(s) failed");
      expect(result.error).toContain("execution stopped");
    });

    it("continues after failure when continueOnFailure is true", async () => {
      const store = createMockStore();
      const schedule = createMockSchedule({
        command: "",
        steps: [
          makeStep({ name: "Failing step", command: "exit 1", continueOnFailure: true }),
          makeStep({ name: "Should still run", command: "echo continued" }),
        ],
      });
      const automationStore = createMockAutomationStore([schedule]);
      runner = new CronRunner(store, automationStore);

      const result = await runner.executeSchedule(schedule);

      expect(result.success).toBe(false); // Overall failure
      expect(result.stepResults).toHaveLength(2); // Both steps ran
      expect(result.stepResults![0].success).toBe(false);
      expect(result.stepResults![1].success).toBe(true);
      expect(result.stepResults![1].output).toContain("continued");
    });

    it("uses per-step timeout override", async () => {
      const store = createMockStore();
      const schedule = createMockSchedule({
        command: "",
        timeoutMs: 30000, // schedule-level timeout (large)
        steps: [
          makeStep({ name: "Slow step", command: "sleep 60", timeoutMs: 100 }), // step-level timeout (tiny)
        ],
      });
      const automationStore = createMockAutomationStore([schedule]);
      runner = new CronRunner(store, automationStore);

      const result = await runner.executeSchedule(schedule);

      expect(result.success).toBe(false);
      expect(result.stepResults).toHaveLength(1);
      expect(result.stepResults![0].error).toContain("timed out");
    }, 10000);

    it("falls back to schedule-level timeout when step has no timeout", async () => {
      const store = createMockStore();
      const schedule = createMockSchedule({
        command: "",
        timeoutMs: 100, // tiny schedule-level timeout
        steps: [
          makeStep({ name: "Slow step", command: "sleep 60" }), // no step-level timeout
        ],
      });
      const automationStore = createMockAutomationStore([schedule]);
      runner = new CronRunner(store, automationStore);

      const result = await runner.executeSchedule(schedule);

      expect(result.success).toBe(false);
      expect(result.stepResults![0].error).toContain("timed out");
    }, 10000);

    it("handles AI prompt step execution with executor", async () => {
      const store = createMockStore();
      const mockFn = vi.fn()
        .mockResolvedValue("AI analysis complete: no issues found");
      const mockExecutor = mockFn as unknown as AiPromptExecutor;
      const schedule = createMockSchedule({
        command: "",
        steps: [
          makeStep({
            type: "ai-prompt",
            name: "AI Analysis",
            prompt: "Analyze the codebase",
            modelProvider: "anthropic",
            modelId: "claude-sonnet-4-5",
            command: undefined,
          }),
        ],
      });
      const automationStore = createMockAutomationStore([schedule]);
      runner = new CronRunner(store, automationStore, { aiPromptExecutor: mockExecutor });

      const result = await runner.executeSchedule(schedule);

      expect(result.success).toBe(true);
      expect(result.stepResults).toHaveLength(1);
      expect(result.stepResults![0].success).toBe(true);
      expect(result.stepResults![0].output).toContain("AI analysis complete");
      // Verify executor was called with correct model params from step
      expect(mockExecutor).toHaveBeenCalledWith(
        "Analyze the codebase",
        "anthropic",
        "claude-sonnet-4-5",
      );
    });

    it("fails AI prompt step when no prompt is provided", async () => {
      const store = createMockStore();
      const schedule = createMockSchedule({
        command: "",
        steps: [
          makeStep({
            type: "ai-prompt",
            name: "Empty prompt",
            prompt: "",
            command: undefined,
          }),
        ],
      });
      const automationStore = createMockAutomationStore([schedule]);
      runner = new CronRunner(store, automationStore);

      const result = await runner.executeSchedule(schedule);

      expect(result.success).toBe(false);
      expect(result.stepResults![0].error).toContain("no prompt specified");
    });

    it("fails command step when no command is provided", async () => {
      const store = createMockStore();
      const schedule = createMockSchedule({
        command: "",
        steps: [
          makeStep({ name: "Empty command", command: "" }),
        ],
      });
      const automationStore = createMockAutomationStore([schedule]);
      runner = new CronRunner(store, automationStore);

      const result = await runner.executeSchedule(schedule);

      expect(result.success).toBe(false);
      expect(result.stepResults![0].error).toContain("no command specified");
    });

    it("handles unknown step type gracefully", async () => {
      const store = createMockStore();
      const schedule = createMockSchedule({
        command: "",
        steps: [
          makeStep({ name: "Unknown step", type: "unknown-type" as any }),
        ],
      });
      const automationStore = createMockAutomationStore([schedule]);
      runner = new CronRunner(store, automationStore);

      const result = await runner.executeSchedule(schedule);

      expect(result.success).toBe(false);
      expect(result.stepResults).toHaveLength(1);
      expect(result.stepResults![0].success).toBe(false);
      expect(result.stepResults![0].error).toContain("Unknown step type");
    });

    it("aggregates output from all steps with headers", async () => {
      const store = createMockStore();
      const schedule = createMockSchedule({
        command: "",
        steps: [
          makeStep({ name: "Alpha", command: "echo alpha-output" }),
          makeStep({ name: "Beta", command: "echo beta-output" }),
        ],
      });
      const automationStore = createMockAutomationStore([schedule]);
      runner = new CronRunner(store, automationStore);

      const result = await runner.executeSchedule(schedule);

      expect(result.output).toContain("Step 1: Alpha");
      expect(result.output).toContain("alpha-output");
      expect(result.output).toContain("Step 2: Beta");
      expect(result.output).toContain("beta-output");
    });

    it("records run result with stepResults to automation store", async () => {
      const store = createMockStore();
      const schedule = createMockSchedule({
        command: "",
        steps: [makeStep({ name: "S1", command: "echo ok" })],
      });
      const automationStore = createMockAutomationStore([schedule]);
      runner = new CronRunner(store, automationStore);

      await runner.executeSchedule(schedule);

      expect(automationStore.recordRun).toHaveBeenCalledWith(
        schedule.id,
        expect.objectContaining({
          success: true,
          stepResults: expect.arrayContaining([
            expect.objectContaining({
              stepName: "S1",
              success: true,
            }),
          ]),
        }),
      );
    });

    it("mixed step types execute correctly", async () => {
      const store = createMockStore();
      const mockFn = vi.fn()
        .mockResolvedValue("Summary: all good");
      const mockExecutor = mockFn as unknown as AiPromptExecutor;
      const schedule = createMockSchedule({
        command: "",
        steps: [
          makeStep({ name: "Build", command: "echo build-done" }),
          makeStep({
            type: "ai-prompt",
            name: "Summarize",
            prompt: "Summarize results",
            command: undefined,
          }),
          makeStep({ name: "Deploy", command: "echo deployed" }),
        ],
      });
      const automationStore = createMockAutomationStore([schedule]);
      runner = new CronRunner(store, automationStore, { aiPromptExecutor: mockExecutor });

      const result = await runner.executeSchedule(schedule);

      expect(result.success).toBe(true);
      expect(result.stepResults).toHaveLength(3);
      expect(result.stepResults![0].stepName).toBe("Build");
      expect(result.stepResults![1].stepName).toBe("Summarize");
      expect(result.stepResults![2].stepName).toBe("Deploy");
      expect(result.stepResults![1].output).toContain("Summary: all good");
    });

    // ── AI prompt step execution ────────────────────────────────────────

    function createAiMockExecutor(
      response: string = "mock AI response",
    ): AiPromptExecutor {
      const fn = vi.fn().mockResolvedValue(response);
      return fn as unknown as AiPromptExecutor;
    }

    it("returns success with AI response when executor is configured", async () => {
      const store = createMockStore();
      const mockExecutor = createAiMockExecutor("Analysis complete: 3 findings");
      const schedule = createMockSchedule({
        command: "",
        steps: [
          makeStep({
            type: "ai-prompt",
            name: "Code Review",
            prompt: "Review the code for issues",
            command: undefined,
          }),
        ],
      });
      const automationStore = createMockAutomationStore([schedule]);
      runner = new CronRunner(store, automationStore, { aiPromptExecutor: mockExecutor });

      const result = await runner.executeSchedule(schedule);

      expect(result.success).toBe(true);
      expect(result.stepResults![0].success).toBe(true);
      expect(result.stepResults![0].output).toContain("Analysis complete: 3 findings");
    });

    it("passes step model provider and model ID to executor", async () => {
      const store = createMockStore();
      const mockExecutor = createAiMockExecutor("response");
      const schedule = createMockSchedule({
        command: "",
        steps: [
          makeStep({
            type: "ai-prompt",
            name: "Step with model",
            prompt: "Do something",
            modelProvider: "openai",
            modelId: "gpt-4o",
            command: undefined,
          }),
        ],
      });
      const automationStore = createMockAutomationStore([schedule]);
      runner = new CronRunner(store, automationStore, { aiPromptExecutor: mockExecutor });

      await runner.executeSchedule(schedule);

      expect(mockExecutor).toHaveBeenCalledWith("Do something", "openai", "gpt-4o");
    });

    it("falls back to settings defaults when step has no model", async () => {
      const store = createMockStore({
        defaultProvider: "anthropic",
        defaultModelId: "claude-sonnet-4-5",
      });
      const mockExecutor = createAiMockExecutor("response");
      const schedule = createMockSchedule({
        command: "",
        steps: [
          makeStep({
            type: "ai-prompt",
            name: "Step without model",
            prompt: "Use defaults",
            command: undefined,
          }),
        ],
      });
      const automationStore = createMockAutomationStore([schedule]);
      runner = new CronRunner(store, automationStore, { aiPromptExecutor: mockExecutor });

      await runner.executeSchedule(schedule);

      expect(mockExecutor).toHaveBeenCalledWith("Use defaults", "anthropic", "claude-sonnet-4-5");
    });

    it("returns configuration error when no executor is provided", async () => {
      const store = createMockStore();
      const schedule = createMockSchedule({
        command: "",
        steps: [
          makeStep({
            type: "ai-prompt",
            name: "No executor",
            prompt: "This should fail",
            command: undefined,
          }),
        ],
      });
      const automationStore = createMockAutomationStore([schedule]);
      runner = new CronRunner(store, automationStore);

      const result = await runner.executeSchedule(schedule);

      expect(result.success).toBe(false);
      expect(result.stepResults![0].success).toBe(false);
      expect(result.stepResults![0].error).toContain("AI execution is not configured");
      expect(result.stepResults![0].output).toBe("");
    });

    it("fails early when prompt is empty even with executor configured", async () => {
      const store = createMockStore();
      const mockExecutor = createAiMockExecutor("should not be called");
      const schedule = createMockSchedule({
        command: "",
        steps: [
          makeStep({
            type: "ai-prompt",
            name: "Empty prompt",
            prompt: "   ",
            command: undefined,
          }),
        ],
      });
      const automationStore = createMockAutomationStore([schedule]);
      runner = new CronRunner(store, automationStore, { aiPromptExecutor: mockExecutor });

      const result = await runner.executeSchedule(schedule);

      expect(result.success).toBe(false);
      expect(result.stepResults![0].error).toContain("no prompt specified");
      expect(mockExecutor).not.toHaveBeenCalled();
    });

    it("handles timeout by returning failure", async () => {
      const store = createMockStore();
      const mockFn = vi.fn()
        .mockImplementation(() => new Promise((resolve) => {
          setTimeout(() => resolve("too late"), 5000);
        }));
      const mockExecutor = mockFn as unknown as AiPromptExecutor;
      const schedule = createMockSchedule({
        command: "",
        timeoutMs: 100,
        steps: [
          makeStep({
            type: "ai-prompt",
            name: "Slow AI",
            prompt: "Take your time",
            command: undefined,
          }),
        ],
      });
      const automationStore = createMockAutomationStore([schedule]);
      runner = new CronRunner(store, automationStore, { aiPromptExecutor: mockExecutor });

      const result = await runner.executeSchedule(schedule);

      expect(result.success).toBe(false);
      expect(result.stepResults![0].success).toBe(false);
      expect(result.stepResults![0].error).toContain("timed out");
    });

    it("handles executor throwing an error", async () => {
      const store = createMockStore();
      const mockFn = vi.fn()
        .mockRejectedValue(new Error("API rate limit exceeded"));
      const mockExecutor = mockFn as unknown as AiPromptExecutor;
      const schedule = createMockSchedule({
        command: "",
        steps: [
          makeStep({
            type: "ai-prompt",
            name: "Failing AI",
            prompt: "Cause an error",
            command: undefined,
          }),
        ],
      });
      const automationStore = createMockAutomationStore([schedule]);
      runner = new CronRunner(store, automationStore, { aiPromptExecutor: mockExecutor });

      const result = await runner.executeSchedule(schedule);

      expect(result.success).toBe(false);
      expect(result.stepResults![0].success).toBe(false);
      expect(result.stepResults![0].error).toContain("API rate limit exceeded");
    });

    it("truncates output when AI response exceeds MAX_OUTPUT_LENGTH", async () => {
      const store = createMockStore();
      const longResponse = "x".repeat(15_000);
      const mockExecutor = createAiMockExecutor(longResponse);
      const schedule = createMockSchedule({
        command: "",
        steps: [
          makeStep({
            type: "ai-prompt",
            name: "Verbose AI",
            prompt: "Give me lots of text",
            command: undefined,
          }),
        ],
      });
      const automationStore = createMockAutomationStore([schedule]);
      runner = new CronRunner(store, automationStore, { aiPromptExecutor: mockExecutor });

      const result = await runner.executeSchedule(schedule);

      expect(result.success).toBe(true);
      expect(result.stepResults![0].success).toBe(true);
      expect(result.stepResults![0].output).toContain("[output truncated]");
      expect(result.stepResults![0].output.length).toBeLessThanOrEqual(10 * 1024 + 50);
    });

    it("uses per-step timeout override over schedule timeout", async () => {
      const store = createMockStore();
      const mockFn = vi.fn()
        .mockImplementation(() => new Promise((resolve) => {
          setTimeout(() => resolve("too late"), 5000);
        }));
      const mockExecutor = mockFn as unknown as AiPromptExecutor;
      const schedule = createMockSchedule({
        command: "",
        timeoutMs: 30000,
        steps: [
          makeStep({
            type: "ai-prompt",
            name: "Slow AI",
            prompt: "Take your time",
            timeoutMs: 100,
            command: undefined,
          }),
        ],
      });
      const automationStore = createMockAutomationStore([schedule]);
      runner = new CronRunner(store, automationStore, { aiPromptExecutor: mockExecutor });

      const result = await runner.executeSchedule(schedule);

      expect(result.success).toBe(false);
      expect(result.stepResults![0].error).toContain("timed out");
    });
  });
});
