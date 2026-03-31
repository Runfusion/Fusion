import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { AutomationStore } from "./automation-store.js";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import type { ScheduledTask, AutomationRunResult, AutomationStep } from "./automation.js";
import { randomUUID } from "node:crypto";

/** Create a test automation step. */
function makeStep(overrides: Partial<AutomationStep> = {}): AutomationStep {
  return {
    id: randomUUID(),
    type: "command",
    name: "Test step",
    command: "echo hello",
    ...overrides,
  };
}

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "kb-automation-test-"));
}

describe("AutomationStore", () => {
  let rootDir: string;
  let store: AutomationStore;

  beforeEach(async () => {
    rootDir = makeTmpDir();
    store = new AutomationStore(rootDir);
    await store.init();
  });

  afterEach(async () => {
    await rm(rootDir, { recursive: true, force: true });
  });

  // ── init ──────────────────────────────────────────────────────────

  describe("init", () => {
    it("creates the automations directory", async () => {
      const dir = join(rootDir, ".kb", "automations");
      expect(existsSync(dir)).toBe(true);
    });

    it("is idempotent", async () => {
      await store.init();
      await store.init();
      const dir = join(rootDir, ".kb", "automations");
      expect(existsSync(dir)).toBe(true);
    });
  });

  // ── isValidCron ───────────────────────────────────────────────────

  describe("isValidCron", () => {
    it("accepts valid cron expressions", () => {
      expect(AutomationStore.isValidCron("0 * * * *")).toBe(true);
      expect(AutomationStore.isValidCron("*/5 * * * *")).toBe(true);
      expect(AutomationStore.isValidCron("0 0 * * 1")).toBe(true);
      expect(AutomationStore.isValidCron("0 9 1 * *")).toBe(true);
    });

    it("rejects invalid cron expressions", () => {
      expect(AutomationStore.isValidCron("not a cron")).toBe(false);
      expect(AutomationStore.isValidCron("60 * * * *")).toBe(false);
      expect(AutomationStore.isValidCron("0 25 * * *")).toBe(false);
    });
  });

  // ── computeNextRun ────────────────────────────────────────────────

  describe("computeNextRun", () => {
    it("returns a future ISO timestamp", () => {
      const fromDate = new Date("2026-01-01T00:00:00Z");
      const next = store.computeNextRun("0 * * * *", fromDate);
      expect(new Date(next).getTime()).toBeGreaterThan(fromDate.getTime());
    });

    it("computes correct next run for hourly", () => {
      const fromDate = new Date("2026-01-01T12:30:00Z");
      const next = store.computeNextRun("0 * * * *", fromDate);
      expect(new Date(next).getUTCHours()).toBe(13);
      expect(new Date(next).getUTCMinutes()).toBe(0);
    });
  });

  // ── createSchedule ────────────────────────────────────────────────

  describe("createSchedule", () => {
    it("creates a schedule with preset type", async () => {
      const schedule = await store.createSchedule({
        name: "Hourly check",
        command: "echo hello",
        scheduleType: "hourly",
      });

      expect(schedule.id).toBeTruthy();
      expect(schedule.name).toBe("Hourly check");
      expect(schedule.command).toBe("echo hello");
      expect(schedule.scheduleType).toBe("hourly");
      expect(schedule.cronExpression).toBe("0 * * * *");
      expect(schedule.enabled).toBe(true);
      expect(schedule.runCount).toBe(0);
      expect(schedule.runHistory).toEqual([]);
      expect(schedule.nextRunAt).toBeTruthy();
      expect(schedule.createdAt).toBeTruthy();
      expect(schedule.updatedAt).toBeTruthy();
    });

    it("creates a schedule with custom cron", async () => {
      const schedule = await store.createSchedule({
        name: "Every 5 min",
        command: "ls",
        scheduleType: "custom",
        cronExpression: "*/5 * * * *",
      });

      expect(schedule.cronExpression).toBe("*/5 * * * *");
      expect(schedule.scheduleType).toBe("custom");
    });

    it("creates disabled schedule without nextRunAt", async () => {
      const schedule = await store.createSchedule({
        name: "Disabled",
        command: "echo",
        scheduleType: "daily",
        enabled: false,
      });

      expect(schedule.enabled).toBe(false);
      expect(schedule.nextRunAt).toBeUndefined();
    });

    it("rejects empty name", async () => {
      await expect(
        store.createSchedule({ name: "", command: "echo", scheduleType: "hourly" }),
      ).rejects.toThrow("Name is required");
    });

    it("rejects empty command when no steps are provided", async () => {
      await expect(
        store.createSchedule({ name: "Test", command: "", scheduleType: "hourly" }),
      ).rejects.toThrow("Command is required");
    });

    it("allows empty command when steps are provided", async () => {
      const step = makeStep();
      const schedule = await store.createSchedule({
        name: "Steps only",
        command: "",
        scheduleType: "hourly",
        steps: [step],
      });
      expect(schedule.steps).toHaveLength(1);
      expect(schedule.steps![0].id).toBe(step.id);
      expect(schedule.command).toBe("");
    });

    it("rejects custom type without cron expression", async () => {
      await expect(
        store.createSchedule({ name: "Test", command: "echo", scheduleType: "custom" }),
      ).rejects.toThrow("Cron expression is required");
    });

    it("rejects invalid cron expression", async () => {
      await expect(
        store.createSchedule({
          name: "Test",
          command: "echo",
          scheduleType: "custom",
          cronExpression: "bad cron",
        }),
      ).rejects.toThrow("Invalid cron expression");
    });

    it("persists schedule to disk", async () => {
      const schedule = await store.createSchedule({
        name: "Persist test",
        command: "echo persist",
        scheduleType: "weekly",
      });

      const filePath = join(rootDir, ".kb", "automations", `${schedule.id}.json`);
      expect(existsSync(filePath)).toBe(true);
    });

    it("emits schedule:created event", async () => {
      const listener = vi.fn();
      store.on("schedule:created", listener);

      const schedule = await store.createSchedule({
        name: "Event test",
        command: "echo event",
        scheduleType: "hourly",
      });

      expect(listener).toHaveBeenCalledWith(schedule);
    });

    it("stores optional timeoutMs", async () => {
      const schedule = await store.createSchedule({
        name: "Timeout test",
        command: "echo",
        scheduleType: "hourly",
        timeoutMs: 60000,
      });

      expect(schedule.timeoutMs).toBe(60000);
    });
  });

  // ── getSchedule ───────────────────────────────────────────────────

  describe("getSchedule", () => {
    it("reads a schedule by id", async () => {
      const created = await store.createSchedule({
        name: "Get test",
        command: "echo get",
        scheduleType: "daily",
      });

      const fetched = await store.getSchedule(created.id);
      expect(fetched.id).toBe(created.id);
      expect(fetched.name).toBe("Get test");
    });

    it("throws ENOENT for missing schedule", async () => {
      await expect(store.getSchedule("nonexistent")).rejects.toThrow("not found");
    });
  });

  // ── listSchedules ─────────────────────────────────────────────────

  describe("listSchedules", () => {
    it("returns empty array when no schedules", async () => {
      const list = await store.listSchedules();
      expect(list).toEqual([]);
    });

    it("returns all schedules sorted by createdAt", async () => {
      await store.createSchedule({ name: "A", command: "echo a", scheduleType: "hourly" });
      // Ensure different timestamps
      await new Promise((r) => setTimeout(r, 5));
      await store.createSchedule({ name: "B", command: "echo b", scheduleType: "daily" });

      const list = await store.listSchedules();
      expect(list).toHaveLength(2);
      expect(list[0].name).toBe("A");
      expect(list[1].name).toBe("B");
    });
  });

  // ── updateSchedule ────────────────────────────────────────────────

  describe("updateSchedule", () => {
    it("updates name and command", async () => {
      const schedule = await store.createSchedule({
        name: "Original",
        command: "echo original",
        scheduleType: "hourly",
      });

      // Small delay to ensure different timestamp
      await new Promise((r) => setTimeout(r, 5));

      const updated = await store.updateSchedule(schedule.id, {
        name: "Updated",
        command: "echo updated",
      });

      expect(updated.name).toBe("Updated");
      expect(updated.command).toBe("echo updated");
      expect(new Date(updated.updatedAt).getTime()).toBeGreaterThanOrEqual(
        new Date(schedule.updatedAt).getTime(),
      );
    });

    it("updates schedule type from preset to custom", async () => {
      const schedule = await store.createSchedule({
        name: "Test",
        command: "echo",
        scheduleType: "hourly",
      });

      const updated = await store.updateSchedule(schedule.id, {
        scheduleType: "custom",
        cronExpression: "*/10 * * * *",
      });

      expect(updated.scheduleType).toBe("custom");
      expect(updated.cronExpression).toBe("*/10 * * * *");
    });

    it("updates enabled state", async () => {
      const schedule = await store.createSchedule({
        name: "Toggle",
        command: "echo",
        scheduleType: "hourly",
      });

      const disabled = await store.updateSchedule(schedule.id, { enabled: false });
      expect(disabled.enabled).toBe(false);
      expect(disabled.nextRunAt).toBeUndefined();

      const reenabled = await store.updateSchedule(schedule.id, { enabled: true });
      expect(reenabled.enabled).toBe(true);
      expect(reenabled.nextRunAt).toBeTruthy();
    });

    it("rejects empty name", async () => {
      const schedule = await store.createSchedule({
        name: "Test",
        command: "echo",
        scheduleType: "hourly",
      });

      await expect(
        store.updateSchedule(schedule.id, { name: " " }),
      ).rejects.toThrow("Name cannot be empty");
    });

    it("rejects invalid cron on custom type", async () => {
      const schedule = await store.createSchedule({
        name: "Test",
        command: "echo",
        scheduleType: "hourly",
      });

      await expect(
        store.updateSchedule(schedule.id, {
          scheduleType: "custom",
          cronExpression: "bad cron",
        }),
      ).rejects.toThrow("Invalid cron expression");
    });

    it("emits schedule:updated event", async () => {
      const schedule = await store.createSchedule({
        name: "Event test",
        command: "echo",
        scheduleType: "hourly",
      });

      const listener = vi.fn();
      store.on("schedule:updated", listener);

      await store.updateSchedule(schedule.id, { name: "Updated" });
      expect(listener).toHaveBeenCalledTimes(1);
    });
  });

  // ── deleteSchedule ────────────────────────────────────────────────

  describe("deleteSchedule", () => {
    it("deletes a schedule", async () => {
      const schedule = await store.createSchedule({
        name: "Delete me",
        command: "echo",
        scheduleType: "hourly",
      });

      const deleted = await store.deleteSchedule(schedule.id);
      expect(deleted.id).toBe(schedule.id);

      const filePath = join(rootDir, ".kb", "automations", `${schedule.id}.json`);
      expect(existsSync(filePath)).toBe(false);
    });

    it("throws for missing schedule", async () => {
      await expect(store.deleteSchedule("nonexistent")).rejects.toThrow("not found");
    });

    it("emits schedule:deleted event", async () => {
      const schedule = await store.createSchedule({
        name: "Delete test",
        command: "echo",
        scheduleType: "hourly",
      });

      const listener = vi.fn();
      store.on("schedule:deleted", listener);

      await store.deleteSchedule(schedule.id);
      expect(listener).toHaveBeenCalledWith(schedule);
    });
  });

  // ── recordRun ─────────────────────────────────────────────────────

  describe("recordRun", () => {
    it("records a successful run", async () => {
      const schedule = await store.createSchedule({
        name: "Run test",
        command: "echo hello",
        scheduleType: "hourly",
      });

      const result: AutomationRunResult = {
        success: true,
        output: "hello\n",
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
      };

      const updated = await store.recordRun(schedule.id, result);
      expect(updated.lastRunAt).toBe(result.startedAt);
      expect(updated.lastRunResult).toEqual(result);
      expect(updated.runCount).toBe(1);
      expect(updated.runHistory).toHaveLength(1);
      expect(updated.runHistory[0]).toEqual(result);
      expect(updated.nextRunAt).toBeTruthy();
    });

    it("records a failed run", async () => {
      const schedule = await store.createSchedule({
        name: "Fail test",
        command: "false",
        scheduleType: "hourly",
      });

      const result: AutomationRunResult = {
        success: false,
        output: "",
        error: "Command failed with exit code 1",
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
      };

      const updated = await store.recordRun(schedule.id, result);
      expect(updated.lastRunResult?.success).toBe(false);
      expect(updated.lastRunResult?.error).toContain("exit code 1");
      expect(updated.runCount).toBe(1);
    });

    it("caps run history at MAX_RUN_HISTORY", async () => {
      const schedule = await store.createSchedule({
        name: "History test",
        command: "echo",
        scheduleType: "hourly",
      });

      for (let i = 0; i < 55; i++) {
        await store.recordRun(schedule.id, {
          success: true,
          output: `run ${i}`,
          startedAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
        });
      }

      const updated = await store.getSchedule(schedule.id);
      expect(updated.runHistory.length).toBeLessThanOrEqual(50);
      expect(updated.runCount).toBe(55);
    });

    it("emits schedule:run event", async () => {
      const schedule = await store.createSchedule({
        name: "Event test",
        command: "echo",
        scheduleType: "hourly",
      });

      const listener = vi.fn();
      store.on("schedule:run", listener);

      const result: AutomationRunResult = {
        success: true,
        output: "ok",
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
      };

      await store.recordRun(schedule.id, result);
      expect(listener).toHaveBeenCalledTimes(1);
      expect(listener.mock.calls[0][0].result).toEqual(result);
    });
  });

  // ── getDueSchedules ───────────────────────────────────────────────

  describe("getDueSchedules", () => {
    it("returns schedules that are due", async () => {
      const schedule = await store.createSchedule({
        name: "Due test",
        command: "echo",
        scheduleType: "hourly",
      });

      // Force nextRunAt to the past by writing directly
      const filePath = join(rootDir, ".kb", "automations", `${schedule.id}.json`);
      const { readFile: rf, writeFile: wf } = await import("node:fs/promises");
      const raw = await rf(filePath, "utf-8");
      const parsed = JSON.parse(raw) as ScheduledTask;
      parsed.nextRunAt = new Date(Date.now() - 60000).toISOString();
      await wf(filePath, JSON.stringify(parsed, null, 2));

      const due = await store.getDueSchedules();
      expect(due.length).toBeGreaterThanOrEqual(1);
      expect(due.some((d) => d.id === schedule.id)).toBe(true);
    });

    it("excludes disabled schedules", async () => {
      const schedule = await store.createSchedule({
        name: "Disabled test",
        command: "echo",
        scheduleType: "hourly",
        enabled: false,
      });

      const due = await store.getDueSchedules();
      expect(due.some((d) => d.id === schedule.id)).toBe(false);
    });

    it("excludes schedules with future nextRunAt", async () => {
      const schedule = await store.createSchedule({
        name: "Future test",
        command: "echo",
        scheduleType: "hourly",
      });

      // nextRunAt is in the future by default
      const due = await store.getDueSchedules();
      expect(due.some((d) => d.id === schedule.id)).toBe(false);
    });
  });

  // ── Steps persistence ─────────────────────────────────────────────

  describe("steps", () => {
    it("creates schedule with steps and persists them", async () => {
      const steps: AutomationStep[] = [
        makeStep({ name: "Step A", command: "echo a" }),
        makeStep({ name: "Step B", type: "ai-prompt", prompt: "Summarize", command: undefined }),
      ];
      const schedule = await store.createSchedule({
        name: "Multi-step",
        command: "",
        scheduleType: "daily",
        steps,
      });

      expect(schedule.steps).toHaveLength(2);
      expect(schedule.steps![0].name).toBe("Step A");
      expect(schedule.steps![1].type).toBe("ai-prompt");

      // Verify round-trip persistence
      const fetched = await store.getSchedule(schedule.id);
      expect(fetched.steps).toHaveLength(2);
      expect(fetched.steps![0].id).toBe(steps[0].id);
      expect(fetched.steps![1].prompt).toBe("Summarize");
    });

    it("creates schedule without steps (legacy mode)", async () => {
      const schedule = await store.createSchedule({
        name: "Legacy",
        command: "echo hello",
        scheduleType: "hourly",
      });

      expect(schedule.steps).toBeUndefined();
    });

    it("updates steps on existing schedule", async () => {
      const schedule = await store.createSchedule({
        name: "Updateable",
        command: "echo old",
        scheduleType: "hourly",
      });
      expect(schedule.steps).toBeUndefined();

      const steps = [makeStep({ name: "New step" })];
      const updated = await store.updateSchedule(schedule.id, { steps });
      expect(updated.steps).toHaveLength(1);
      expect(updated.steps![0].name).toBe("New step");
    });

    it("clears steps when updating with empty array", async () => {
      const schedule = await store.createSchedule({
        name: "Clear steps",
        command: "echo hello",
        scheduleType: "hourly",
        steps: [makeStep()],
      });
      expect(schedule.steps).toHaveLength(1);

      const updated = await store.updateSchedule(schedule.id, { steps: [] });
      expect(updated.steps).toBeUndefined();
    });

    it("preserves step model fields through round-trip", async () => {
      const step = makeStep({
        type: "ai-prompt",
        name: "AI Step",
        prompt: "Analyze this",
        modelProvider: "anthropic",
        modelId: "claude-sonnet-4-5",
        timeoutMs: 60000,
        continueOnFailure: true,
        command: undefined,
      });
      const schedule = await store.createSchedule({
        name: "AI schedule",
        command: "",
        scheduleType: "daily",
        steps: [step],
      });

      const fetched = await store.getSchedule(schedule.id);
      const fetchedStep = fetched.steps![0];
      expect(fetchedStep.type).toBe("ai-prompt");
      expect(fetchedStep.prompt).toBe("Analyze this");
      expect(fetchedStep.modelProvider).toBe("anthropic");
      expect(fetchedStep.modelId).toBe("claude-sonnet-4-5");
      expect(fetchedStep.timeoutMs).toBe(60000);
      expect(fetchedStep.continueOnFailure).toBe(true);
    });
  });

  // ── reorderSteps ──────────────────────────────────────────────────

  describe("reorderSteps", () => {
    it("reorders steps by ID array", async () => {
      const stepA = makeStep({ name: "A" });
      const stepB = makeStep({ name: "B" });
      const stepC = makeStep({ name: "C" });
      const schedule = await store.createSchedule({
        name: "Reorder test",
        command: "",
        scheduleType: "daily",
        steps: [stepA, stepB, stepC],
      });

      const reordered = await store.reorderSteps(
        schedule.id,
        [stepC.id, stepA.id, stepB.id],
      );

      expect(reordered.steps![0].name).toBe("C");
      expect(reordered.steps![1].name).toBe("A");
      expect(reordered.steps![2].name).toBe("B");

      // Verify persisted
      const fetched = await store.getSchedule(schedule.id);
      expect(fetched.steps![0].name).toBe("C");
    });

    it("throws when schedule has no steps", async () => {
      const schedule = await store.createSchedule({
        name: "No steps",
        command: "echo",
        scheduleType: "hourly",
      });

      await expect(
        store.reorderSteps(schedule.id, []),
      ).rejects.toThrow("no steps to reorder");
    });

    it("throws on step ID count mismatch", async () => {
      const stepA = makeStep({ name: "A" });
      const stepB = makeStep({ name: "B" });
      const schedule = await store.createSchedule({
        name: "Mismatch test",
        command: "",
        scheduleType: "daily",
        steps: [stepA, stepB],
      });

      await expect(
        store.reorderSteps(schedule.id, [stepA.id]),
      ).rejects.toThrow("count mismatch");
    });

    it("throws on unknown step ID", async () => {
      const stepA = makeStep({ name: "A" });
      const stepB = makeStep({ name: "B" });
      const schedule = await store.createSchedule({
        name: "Unknown ID test",
        command: "",
        scheduleType: "daily",
        steps: [stepA, stepB],
      });

      await expect(
        store.reorderSteps(schedule.id, [stepA.id, "nonexistent"]),
      ).rejects.toThrow('Unknown step ID: "nonexistent"');
    });

    it("emits schedule:updated event", async () => {
      const stepA = makeStep({ name: "A" });
      const stepB = makeStep({ name: "B" });
      const schedule = await store.createSchedule({
        name: "Event test",
        command: "",
        scheduleType: "daily",
        steps: [stepA, stepB],
      });

      const listener = vi.fn();
      store.on("schedule:updated", listener);

      await store.reorderSteps(schedule.id, [stepB.id, stepA.id]);
      expect(listener).toHaveBeenCalledTimes(1);
    });
  });

  // ── Concurrent write safety ───────────────────────────────────────

  describe("concurrency", () => {
    it("handles concurrent updates safely", async () => {
      const schedule = await store.createSchedule({
        name: "Concurrent",
        command: "echo",
        scheduleType: "hourly",
      });

      // Fire multiple concurrent updates
      const updates = Array.from({ length: 10 }, (_, i) =>
        store.recordRun(schedule.id, {
          success: true,
          output: `run ${i}`,
          startedAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
        }),
      );

      await Promise.all(updates);

      const final = await store.getSchedule(schedule.id);
      expect(final.runCount).toBe(10);
      expect(final.runHistory).toHaveLength(10);
    });
  });
});
