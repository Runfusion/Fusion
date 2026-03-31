import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { CronRunner } from "./cron-runner.js";
import type { TaskStore, AutomationStore, ScheduledTask, AutomationRunResult, AutomationStep, Settings } from "@kb/core";
import { DEFAULT_SETTINGS } from "@kb/core";
import { randomUUID } from "node:crypto";

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

    it("handles AI prompt step execution (mocked)", async () => {
      const store = createMockStore();
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
      runner = new CronRunner(store, automationStore);

      const result = await runner.executeSchedule(schedule);

      expect(result.success).toBe(true);
      expect(result.stepResults).toHaveLength(1);
      expect(result.stepResults![0].success).toBe(true);
      expect(result.stepResults![0].output).toContain("anthropic/claude-sonnet-4-5");
      expect(result.stepResults![0].output).toContain("Analyze the codebase");
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
      runner = new CronRunner(store, automationStore);

      const result = await runner.executeSchedule(schedule);

      expect(result.success).toBe(true);
      expect(result.stepResults).toHaveLength(3);
      expect(result.stepResults![0].stepName).toBe("Build");
      expect(result.stepResults![1].stepName).toBe("Summarize");
      expect(result.stepResults![2].stepName).toBe("Deploy");
    });
  });
});
