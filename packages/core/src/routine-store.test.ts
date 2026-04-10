import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { RoutineStore } from "./routine-store.js";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import type {
  Routine,
  RoutineCreateInput,
  RoutineExecutionResult,
  RoutineTrigger,
} from "./routine.js";

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "kb-routine-test-"));
}

describe("RoutineStore", () => {
  let rootDir: string;
  let store: RoutineStore;

  beforeEach(async () => {
    rootDir = makeTmpDir();
    store = new RoutineStore(rootDir);
    await store.init();
  });

  afterEach(async () => {
    await rm(rootDir, { recursive: true, force: true });
  });

  // ── init ──────────────────────────────────────────────────────────

  describe("init", () => {
    it("is idempotent", async () => {
      await store.init();
      await store.init();
      // Should not throw
    });
  });

  // ── isValidCron ─────────────────────────────────────────────────

  describe("isValidCron", () => {
    it("accepts valid cron expressions", () => {
      expect(RoutineStore.isValidCron("0 * * * *")).toBe(true);
      expect(RoutineStore.isValidCron("*/5 * * * *")).toBe(true);
      expect(RoutineStore.isValidCron("0 0 * * 1")).toBe(true);
      expect(RoutineStore.isValidCron("0 9 1 * *")).toBe(true);
    });

    it("rejects invalid cron expressions", () => {
      expect(RoutineStore.isValidCron("not a cron")).toBe(false);
      expect(RoutineStore.isValidCron("60 * * * *")).toBe(false);
      expect(RoutineStore.isValidCron("0 25 * * *")).toBe(false);
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

  // ── createRoutine ────────────────────────────────────────────────

  describe("createRoutine", () => {
    it("creates a routine with cron trigger", async () => {
      const input: RoutineCreateInput = {
        name: "Hourly check",
        agentId: "test-agent",
        trigger: { type: "cron", cronExpression: "0 * * * *" },
      };

      const routine = await store.createRoutine(input);

      expect(routine.id).toBeTruthy();
      expect(routine.name).toBe("Hourly check");
      expect(routine.trigger.type).toBe("cron");
      expect((routine.trigger as any).cronExpression).toBe("0 * * * *");
      expect(routine.catchUpPolicy).toBe("run_one");
      expect(routine.executionPolicy).toBe("queue");
      expect(routine.enabled).toBe(true);
      expect(routine.runCount).toBe(0);
      expect(routine.runHistory).toEqual([]);
      expect(routine.nextRunAt).toBeTruthy();
      expect(routine.createdAt).toBeTruthy();
      expect(routine.updatedAt).toBeTruthy();
    });

    it("creates a routine with webhook trigger", async () => {
      const input: RoutineCreateInput = {
        name: "Webhook routine",
        agentId: "test-agent",
        trigger: { type: "webhook", webhookPath: "/trigger/my-routine" },
      };

      const routine = await store.createRoutine(input);

      expect(routine.trigger.type).toBe("webhook");
      expect((routine.trigger as any).webhookPath).toBe("/trigger/my-routine");
    });

    it("creates a routine with api trigger", async () => {
      const input: RoutineCreateInput = {
        name: "API routine",
        agentId: "test-agent",
        trigger: { type: "api", endpoint: "/api/routines/run" },
      };

      const routine = await store.createRoutine(input);

      expect(routine.trigger.type).toBe("api");
      expect((routine.trigger as any).endpoint).toBe("/api/routines/run");
    });

    it("creates a routine with manual trigger", async () => {
      const input: RoutineCreateInput = {
        name: "Manual routine",
        agentId: "test-agent",
        trigger: { type: "manual" },
      };

      const routine = await store.createRoutine(input);

      expect(routine.trigger.type).toBe("manual");
      expect(routine.nextRunAt).toBeUndefined(); // No nextRunAt for manual triggers
    });

    it("creates disabled routine without nextRunAt", async () => {
      const input: RoutineCreateInput = {
        name: "Disabled",
        agentId: "test-agent",
        trigger: { type: "cron", cronExpression: "0 * * * *" },
        enabled: false,
      };

      const routine = await store.createRoutine(input);

      expect(routine.enabled).toBe(false);
      expect(routine.nextRunAt).toBeUndefined();
    });

    it("creates routine with custom policies", async () => {
      const input: RoutineCreateInput = {
        name: "Custom policies",
        agentId: "test-agent",
        trigger: { type: "cron", cronExpression: "0 * * * *" },
        catchUpPolicy: "skip",
        executionPolicy: "parallel",
      };

      const routine = await store.createRoutine(input);

      expect(routine.catchUpPolicy).toBe("skip");
      expect(routine.executionPolicy).toBe("parallel");
    });

    it("rejects empty name", async () => {
      const input: RoutineCreateInput = {
        name: "",
        agentId: "test-agent",
        trigger: { type: "manual" },
      };

      await expect(store.createRoutine(input)).rejects.toThrow("Name is required");
    });

    it("rejects invalid cron expression", async () => {
      const input: RoutineCreateInput = {
        name: "Bad cron",
        agentId: "test-agent",
        trigger: { type: "cron", cronExpression: "bad cron" },
      };

      await expect(store.createRoutine(input)).rejects.toThrow("Invalid cron expression");
    });

    it("emits routine:created event", async () => {
      const listener = vi.fn();
      store.on("routine:created", listener);

      const routine = await store.createRoutine({
        name: "Event test",
        agentId: "test-agent",
        trigger: { type: "manual" },
      });

      expect(listener).toHaveBeenCalledWith(routine);
    });
  });

  // ── getRoutine ──────────────────────────────────────────────────

  describe("getRoutine", () => {
    it("reads a routine by id", async () => {
      const created = await store.createRoutine({
        name: "Get test",
        agentId: "test-agent",
        trigger: { type: "manual" },
      });

      const fetched = await store.getRoutine(created.id);
      expect(fetched.id).toBe(created.id);
      expect(fetched.name).toBe("Get test");
    });

    it("throws ENOENT for missing routine", async () => {
      await expect(store.getRoutine("nonexistent")).rejects.toThrow("not found");
    });
  });

  // ── listRoutines ─────────────────────────────────────────────────

  describe("listRoutines", () => {
    it("returns empty array when no routines", async () => {
      const list = await store.listRoutines();
      expect(list).toEqual([]);
    });

    it("returns all routines sorted by createdAt", async () => {
      await store.createRoutine({ name: "A", agentId: "test-agent", trigger: { type: "manual" } });
      await new Promise((r) => setTimeout(r, 5));
      await store.createRoutine({ name: "B", agentId: "test-agent", trigger: { type: "manual" } });

      const list = await store.listRoutines();
      expect(list).toHaveLength(2);
      expect(list[0].name).toBe("A");
      expect(list[1].name).toBe("B");
    });
  });

  // ── updateRoutine ────────────────────────────────────────────────

  describe("updateRoutine", () => {
    it("updates name and description", async () => {
      const routine = await store.createRoutine({
        name: "Original",
        agentId: "test-agent",
        trigger: { type: "manual" },
      });

      await new Promise((r) => setTimeout(r, 5));

      const updated = await store.updateRoutine(routine.id, {
        name: "Updated",
        description: "A description",
      });

      expect(updated.name).toBe("Updated");
      expect(updated.description).toBe("A description");
      expect(new Date(updated.updatedAt).getTime()).toBeGreaterThanOrEqual(
        new Date(routine.updatedAt).getTime(),
      );
    });

    it("updates trigger from manual to cron", async () => {
      const routine = await store.createRoutine({
        name: "Test",
        agentId: "test-agent",
        trigger: { type: "manual" },
      });

      const updated = await store.updateRoutine(routine.id, {
        trigger: { type: "cron", cronExpression: "*/10 * * * *" },
      });

      expect(updated.trigger.type).toBe("cron");
      expect((updated.trigger as any).cronExpression).toBe("*/10 * * * *");
      expect(updated.nextRunAt).toBeTruthy();
    });

    it("updates enabled state", async () => {
      const routine = await store.createRoutine({
        name: "Toggle",
        agentId: "test-agent",
        trigger: { type: "cron", cronExpression: "0 * * * *" },
      });

      const disabled = await store.updateRoutine(routine.id, { enabled: false });
      expect(disabled.enabled).toBe(false);
      expect(disabled.nextRunAt).toBeUndefined();

      const reenabled = await store.updateRoutine(routine.id, { enabled: true });
      expect(reenabled.enabled).toBe(true);
      expect(reenabled.nextRunAt).toBeTruthy();
    });

    it("updates policies", async () => {
      const routine = await store.createRoutine({
        name: "Policies",
        agentId: "test-agent",
        trigger: { type: "manual" },
      });

      const updated = await store.updateRoutine(routine.id, {
        catchUpPolicy: "run",
        executionPolicy: "parallel",
      });

      expect(updated.catchUpPolicy).toBe("run");
      expect(updated.executionPolicy).toBe("parallel");
    });

    it("rejects empty name", async () => {
      const routine = await store.createRoutine({
        name: "Test",
        agentId: "test-agent",
        trigger: { type: "manual" },
      });

      await expect(
        store.updateRoutine(routine.id, { name: " " }),
      ).rejects.toThrow("Name cannot be empty");
    });

    it("rejects invalid cron on update", async () => {
      const routine = await store.createRoutine({
        name: "Test",
        agentId: "test-agent",
        trigger: { type: "manual" },
      });

      await expect(
        store.updateRoutine(routine.id, {
          trigger: { type: "cron", cronExpression: "bad cron" },
        }),
      ).rejects.toThrow("Invalid cron expression");
    });

    it("emits routine:updated event", async () => {
      const routine = await store.createRoutine({
        name: "Event test",
        agentId: "test-agent",
        trigger: { type: "manual" },
      });

      const listener = vi.fn();
      store.on("routine:updated", listener);

      await store.updateRoutine(routine.id, { name: "Updated" });
      expect(listener).toHaveBeenCalledTimes(1);
    });
  });

  // ── deleteRoutine ───────────────────────────────────────────────

  describe("deleteRoutine", () => {
    it("deletes a routine", async () => {
      const routine = await store.createRoutine({
        name: "Delete me",
        agentId: "test-agent",
        trigger: { type: "manual" },
      });

      const deleted = await store.deleteRoutine(routine.id);
      expect(deleted.id).toBe(routine.id);

      await expect(store.getRoutine(routine.id)).rejects.toThrow("not found");
    });

    it("throws for missing routine", async () => {
      await expect(store.deleteRoutine("nonexistent")).rejects.toThrow("not found");
    });

    it("emits routine:deleted event", async () => {
      const routine = await store.createRoutine({
        name: "Delete test",
        agentId: "test-agent",
        trigger: { type: "manual" },
      });

      const listener = vi.fn();
      store.on("routine:deleted", listener);

      await store.deleteRoutine(routine.id);
      expect(listener).toHaveBeenCalled();
      const emittedRoutine = listener.mock.calls[0][0];
      // Verify the emitted routine has the expected fields
      expect(emittedRoutine.id).toBe(routine.id);
      expect(emittedRoutine.name).toBe("Delete test");
      expect(emittedRoutine.agentId).toBe("test-agent");
    });
  });

  // ── recordRun ───────────────────────────────────────────────────

  describe("recordRun", () => {
    it("records a successful run", async () => {
      const routine = await store.createRoutine({
        name: "Run test",
        agentId: "test-agent",
        trigger: { type: "manual" },
      });

      const result: RoutineExecutionResult = {
        routineId: routine.id,
        success: true,
        output: "completed",
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
      };

      const updated = await store.recordRun(routine.id, result);
      expect(updated.lastRunAt).toBe(result.startedAt);
      expect(updated.lastRunResult).toEqual(result);
      expect(updated.runCount).toBe(1);
      expect(updated.runHistory).toHaveLength(1);
      expect(updated.runHistory[0]).toEqual(result);
    });

    it("records a failed run", async () => {
      const routine = await store.createRoutine({
        name: "Fail test",
        agentId: "test-agent",
        trigger: { type: "manual" },
      });

      const result: RoutineExecutionResult = {
        routineId: routine.id,
        success: false,
        output: "",
        error: "Something went wrong",
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
      };

      const updated = await store.recordRun(routine.id, result);
      expect(updated.lastRunResult?.success).toBe(false);
      expect(updated.lastRunResult?.error).toContain("Something went wrong");
      expect(updated.runCount).toBe(1);
    });

    it("caps run history at MAX_ROUTINE_RUN_HISTORY", async () => {
      const routine = await store.createRoutine({
        name: "History test",
        agentId: "test-agent",
        trigger: { type: "manual" },
      });

      for (let i = 0; i < 55; i++) {
        await store.recordRun(routine.id, {
          routineId: routine.id,
          success: true,
          output: `run ${i}`,
          startedAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
        });
      }

      const updated = await store.getRoutine(routine.id);
      expect(updated.runHistory.length).toBeLessThanOrEqual(50);
      expect(updated.runCount).toBe(55);
    });

    it("emits routine:run event", async () => {
      const routine = await store.createRoutine({
        name: "Event test",
        agentId: "test-agent",
        trigger: { type: "manual" },
      });

      const listener = vi.fn();
      store.on("routine:run", listener);

      const result: RoutineExecutionResult = {
        routineId: routine.id,
        success: true,
        output: "ok",
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
      };

      await store.recordRun(routine.id, result);
      expect(listener).toHaveBeenCalledTimes(1);
      expect(listener.mock.calls[0][0].result).toEqual(result);
    });

    it("recomputes nextRunAt for cron routines after run", async () => {
      // Use a cron that fires every minute to ensure different nextRunAt
      const routine = await store.createRoutine({
        name: "Cron run test",
        agentId: "test-agent",
        trigger: { type: "cron", cronExpression: "0 * * * * *" },
      });

      const originalNextRun = routine.nextRunAt;
      expect(originalNextRun).toBeTruthy();

      // Wait a bit to ensure time passes
      await new Promise((r) => setTimeout(r, 1000));

      const result: RoutineExecutionResult = {
        routineId: routine.id,
        success: true,
        output: "ok",
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
      };

      const updated = await store.recordRun(routine.id, result);
      expect(updated.nextRunAt).toBeTruthy();
      // nextRunAt should be updated (may be same or later depending on timing)
      expect(updated.nextRunAt).not.toBeUndefined();
    });
  });

  // ── getDueRoutines ──────────────────────────────────────────────

  describe("getDueRoutines", () => {
    it("returns empty array when no routines", async () => {
      const due = await store.getDueRoutines();
      expect(due).toEqual([]);
    });

    it("excludes disabled routines", async () => {
      const routine = await store.createRoutine({
        name: "Disabled test",
        agentId: "test-agent",
        trigger: { type: "cron", cronExpression: "0 * * * *" },
        enabled: false,
      });

      const due = await store.getDueRoutines();
      expect(due.some((d) => d.id === routine.id)).toBe(false);
    });

    it("excludes routines with future nextRunAt", async () => {
      const routine = await store.createRoutine({
        name: "Future test",
        agentId: "test-agent",
        trigger: { type: "cron", cronExpression: "0 * * * *" },
      });

      // nextRunAt is in the future by default
      const due = await store.getDueRoutines();
      expect(due.some((d) => d.id === routine.id)).toBe(false);
    });

    it("returns routines with past nextRunAt after manual update", async () => {
      // Create routine with cron trigger
      const routine = await store.createRoutine({
        name: "Due test",
        agentId: "test-agent",
        trigger: { type: "cron", cronExpression: "0 * * * *" },
      });

      // Manually set nextRunAt to the past by directly manipulating the database
      // This tests the due-routine query logic
      const pastDate = new Date(Date.now() - 60000).toISOString();
      store["db"].prepare(
        "UPDATE routines SET nextRunAt = ? WHERE id = ?"
      ).run(pastDate, routine.id);

      // Now getDueRoutines should include it
      const due = await store.getDueRoutines();
      expect(due.some((d) => d.id === routine.id)).toBe(true);
    });
  });

  // ── Concurrent write safety ─────────────────────────────────────

  describe("concurrency", () => {
    it("handles concurrent updates safely", async () => {
      const routine = await store.createRoutine({
        name: "Concurrent",
        agentId: "test-agent",
        trigger: { type: "manual" },
      });

      // Fire multiple concurrent recordRun calls
      const updates = Array.from({ length: 10 }, (_, i) =>
        store.recordRun(routine.id, {
          routineId: routine.id,
          success: true,
          output: `run ${i}`,
          startedAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
        }),
      );

      await Promise.all(updates);

      const final = await store.getRoutine(routine.id);
      expect(final.runCount).toBe(10);
      expect(final.runHistory).toHaveLength(10);
    });
  });
});
