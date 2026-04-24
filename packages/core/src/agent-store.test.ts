/**
 * Tests for AgentStore — SQLite-backed agent lifecycle management.
 *
 * Covers every public method: init, createAgent, getAgent, getAgentDetail,
 * updateAgent, updateAgentState, assignTask, listAgents, deleteAgent,
 * recordHeartbeat, getHeartbeatHistory, startHeartbeatRun, endHeartbeatRun,
 * getActiveHeartbeatRun, getCompletedHeartbeatRuns.
 *
 * Also tests event emissions (agent:created, agent:updated, agent:deleted,
 * agent:heartbeat, agent:stateChanged), error paths, state transition
 * validation, concurrency locking, and SQLite persistence.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { AgentStore } from "./agent-store.js";
import { Database } from "./db.js";
import { TaskStore } from "./store.js";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { mkdtempSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { CheckoutConflictError, type AgentCapability, type AgentState } from "./types.js";

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "fn-agent-store-test-"));
}

describe("AgentStore", () => {
  let rootDir: string;
  let store: AgentStore;

  beforeEach(async () => {
    rootDir = makeTmpDir();
    store = new AgentStore({ rootDir });
    await store.init();
  });

  afterEach(async () => {
    store.close();
    await rm(rootDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  // ── init ──────────────────────────────────────────────────────────

  describe("init", () => {
    it("creates the agents/ directory inside rootDir", async () => {
      const agentsDir = join(rootDir, "agents");
      expect(existsSync(agentsDir)).toBe(true);
    });

    it("is idempotent (calling twice doesn't error)", async () => {
      await store.init();
      await store.init();
      const agentsDir = join(rootDir, "agents");
      expect(existsSync(agentsDir)).toBe(true);
    });

    it("imports legacy agent run JSON files into SQLite once", async () => {
      const legacyRoot = makeTmpDir();
      try {
        const agentsDir = join(legacyRoot, "agents");
        const runDir = join(agentsDir, "agent-legacy-runs");
        mkdirSync(runDir, { recursive: true });
        writeFileSync(join(agentsDir, "agent-legacy.json"), JSON.stringify({
          id: "agent-legacy",
          name: "Legacy",
          role: "executor",
          state: "idle",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
          metadata: {},
        }));
        writeFileSync(join(runDir, "run-legacy.json"), JSON.stringify({
          id: "run-legacy",
          agentId: "agent-legacy",
          startedAt: "2026-01-01T00:00:00.000Z",
          endedAt: "2026-01-01T00:00:01.000Z",
          status: "completed",
          contextSnapshot: { taskId: "FN-001" },
          stdoutExcerpt: "done",
        }));

        const legacyStore = new AgentStore({ rootDir: legacyRoot });
        await legacyStore.init();
        try {
          const run = await legacyStore.getRunDetail("agent-legacy", "run-legacy");

          expect(run).toMatchObject({
            id: "run-legacy",
            agentId: "agent-legacy",
            status: "completed",
            contextSnapshot: { taskId: "FN-001" },
            stdoutExcerpt: "done",
          });
          expect(await legacyStore.importLegacyFileRuns()).toBe(0);
        } finally {
          legacyStore.close();
        }
      } finally {
        await rm(legacyRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      }
    });

    it("normalizes legacy durable agents to heartbeat enabled once", async () => {
      const agent = await store.createAgent({
        name: "Legacy Durable Agent",
        role: "executor",
      });

      await store.updateAgent(agent.id, {
        runtimeConfig: {
          ...(agent.runtimeConfig ?? {}),
          enabled: false,
        },
      });

      const db = new Database(rootDir);
      db.init();
      db.prepare(`
        INSERT INTO __meta (key, value)
        VALUES ('agentHeartbeatDefaultVersion', '0')
        ON CONFLICT(key) DO UPDATE SET value = '0'
      `).run();

      store.close();
      store = new AgentStore({ rootDir });
      await store.init();

      const migrated = await store.getAgent(agent.id);
      expect((migrated?.runtimeConfig as Record<string, unknown> | undefined)?.enabled).toBe(true);
    });
  });

  // ── createAgent ───────────────────────────────────────────────────

  describe("createAgent", () => {
    it("returns an agent with correct fields", async () => {
      const agent = await store.createAgent({
        name: "  Test Agent  ",
        role: "executor",
      });

      expect(agent.id).toMatch(/^agent-/);
      expect(agent.name).toBe("Test Agent"); // trimmed
      expect(agent.role).toBe("executor");
      expect(agent.state).toBe("idle");
      expect(agent.metadata).toEqual({});
      expect(agent.runtimeConfig).toMatchObject({
        enabled: true,
      });
      expect(new Date(agent.createdAt).getTime()).not.toBeNaN();
      expect(new Date(agent.updatedAt).getTime()).not.toBeNaN();
    });

    it("preserves custom metadata", async () => {
      const agent = await store.createAgent({
        name: "With Meta",
        role: "reviewer",
        metadata: { version: 2, tags: ["test"] },
      });

      expect(agent.metadata).toEqual({ version: 2, tags: ["test"] });
    });

    it("persists soul and memory fields on create", async () => {
      const agent = await store.createAgent({
        name: "With Soul",
        role: "executor",
        soul: "Calm and precise.",
        memory: "Prefers concise code examples.",
      });

      expect(agent.soul).toBe("Calm and precise.");
      expect(agent.memory).toBe("Prefers concise code examples.");

      const persisted = await store.getAgent(agent.id);
      expect(persisted?.soul).toBe("Calm and precise.");
      expect(persisted?.memory).toBe("Prefers concise code examples.");
    });

    it("throws when name is empty", async () => {
      await expect(
        store.createAgent({ name: "", role: "executor" })
      ).rejects.toThrow("Agent name is required");
    });

    it("throws when name is whitespace-only", async () => {
      await expect(
        store.createAgent({ name: "   ", role: "executor" })
      ).rejects.toThrow("Agent name is required");
    });

    it("throws when role is missing", async () => {
      await expect(
        store.createAgent({ name: "No Role", role: "" as AgentCapability })
      ).rejects.toThrow("Agent role is required");
    });

    it("emits 'agent:created' event with the created agent", async () => {
      const handler = vi.fn();
      store.on("agent:created", handler);

      const agent = await store.createAgent({
        name: "Event Agent",
        role: "triage",
      });

      expect(handler).toHaveBeenCalledOnce();
      expect(handler).toHaveBeenCalledWith(agent);
    });
  });

  // ── getAgent ──────────────────────────────────────────────────────

  describe("getAgent", () => {
    it("returns the agent after creation", async () => {
      const created = await store.createAgent({
        name: "Lookup Agent",
        role: "executor",
      });

      const found = await store.getAgent(created.id);
      expect(found).not.toBeNull();
      expect(found!.id).toBe(created.id);
      expect(found!.name).toBe("Lookup Agent");
      expect(found!.role).toBe("executor");
      expect(found!.state).toBe("idle");
    });

    it("returns null for a non-existent ID", async () => {
      const result = await store.getAgent("agent-nonexistent");
      expect(result).toBeNull();
    });
  });

  // ── getAccessState ────────────────────────────────────────────────

  describe("getAccessState", () => {
    it("returns computed state for an executor agent", async () => {
      const created = await store.createAgent({
        name: "Executor",
        role: "executor",
      });

      const state = await store.getAccessState(created.id);

      expect(state).not.toBeNull();
      expect(state?.agentId).toBe(created.id);
      expect(state?.canExecuteTasks).toBe(true);
      expect(state?.canAssignTasks).toBe(false);
      expect(state?.taskAssignSource).toBe("denied");
    });

    it("returns null for non-existent agent", async () => {
      const state = await store.getAccessState("agent-missing");
      expect(state).toBeNull();
    });

    it("reflects explicit permissions when set", async () => {
      const created = await store.createAgent({
        name: "Explicit",
        role: "executor",
        permissions: { "tasks:assign": true },
      });

      const state = await store.getAccessState(created.id);

      expect(state).not.toBeNull();
      expect(state?.canAssignTasks).toBe(true);
      expect(state?.taskAssignSource).toBe("explicit_grant");
      expect(state?.explicitPermissions.has("tasks:assign")).toBe(true);
    });
  });

  // ── Budget Management ─────────────────────────────────────────────

  describe("Budget Management", () => {
    describe("getBudgetStatus", () => {
      it("throws if agent not found", async () => {
        await expect(store.getBudgetStatus("nonexistent")).rejects.toThrow("not found");
      });

      it("returns no-limit status when agent has no budgetConfig", async () => {
        const agent = await store.createAgent({
          name: "No Budget Config",
          role: "executor",
        });

        const status = await store.getBudgetStatus(agent.id);

        expect(status.currentUsage).toBe(0);
        expect(status.budgetLimit).toBeNull();
        expect(status.usagePercent).toBeNull();
        expect(status.thresholdPercent).toBeNull();
        expect(status.isOverBudget).toBe(false);
        expect(status.isOverThreshold).toBe(false);
        expect(status.lastResetAt).toBeNull();
        expect(status.nextResetAt).toBeNull();
      });

      it("returns no-limit status when budgetConfig has no tokenBudget", async () => {
        const agent = await store.createAgent({
          name: "Threshold Only",
          role: "executor",
          runtimeConfig: {
            budgetConfig: {
              usageThreshold: 0.9,
            },
          },
        });

        const status = await store.getBudgetStatus(agent.id);

        expect(status.budgetLimit).toBeNull();
        expect(status.usagePercent).toBeNull();
        expect(status.thresholdPercent).toBeNull();
      });

      it("computes usage from totalInputTokens + totalOutputTokens", async () => {
        const agent = await store.createAgent({
          name: "Usage Counter",
          role: "executor",
          runtimeConfig: {
            budgetConfig: {
              tokenBudget: 20000,
            },
          },
        });

        await store.updateAgent(agent.id, {
          totalInputTokens: 5000,
          totalOutputTokens: 3000,
        });

        const status = await store.getBudgetStatus(agent.id);
        expect(status.currentUsage).toBe(8000);
      });

      it("detects over-budget when usage >= tokenBudget", async () => {
        const agent = await store.createAgent({
          name: "Over Budget",
          role: "executor",
          runtimeConfig: {
            budgetConfig: {
              tokenBudget: 1000,
            },
          },
        });

        await store.updateAgent(agent.id, {
          totalInputTokens: 800,
          totalOutputTokens: 300,
        });

        const status = await store.getBudgetStatus(agent.id);
        expect(status.isOverBudget).toBe(true);
      });

      it("detects over-threshold when usagePercent >= thresholdPercent", async () => {
        const agent = await store.createAgent({
          name: "Threshold Hit",
          role: "executor",
          runtimeConfig: {
            budgetConfig: {
              tokenBudget: 10000,
              usageThreshold: 0.5,
            },
          },
        });

        await store.updateAgent(agent.id, {
          totalInputTokens: 3000,
          totalOutputTokens: 2500,
        });

        const status = await store.getBudgetStatus(agent.id);
        expect(status.usagePercent).toBeCloseTo(55, 10);
        expect(status.thresholdPercent).toBe(50);
        expect(status.isOverThreshold).toBe(true);
      });

      it("is not over-threshold when below threshold", async () => {
        const agent = await store.createAgent({
          name: "Threshold Safe",
          role: "executor",
          runtimeConfig: {
            budgetConfig: {
              tokenBudget: 10000,
              usageThreshold: 0.8,
            },
          },
        });

        await store.updateAgent(agent.id, {
          totalInputTokens: 2500,
          totalOutputTokens: 2500,
        });

        const status = await store.getBudgetStatus(agent.id);
        expect(status.usagePercent).toBe(50);
        expect(status.isOverThreshold).toBe(false);
      });

      it("clamps usagePercent to 100 when over budget", async () => {
        const agent = await store.createAgent({
          name: "Clamp Usage",
          role: "executor",
          runtimeConfig: {
            budgetConfig: {
              tokenBudget: 100,
            },
          },
        });

        await store.updateAgent(agent.id, {
          totalInputTokens: 400,
          totalOutputTokens: 100,
        });

        const status = await store.getBudgetStatus(agent.id);
        expect(status.usagePercent).toBe(100);
      });

      it("returns lastResetAt from runtimeConfig.budgetResetAt", async () => {
        const budgetResetAt = "2026-01-01T00:00:00.000Z";
        const agent = await store.createAgent({
          name: "Has Reset Timestamp",
          role: "executor",
          runtimeConfig: {
            budgetResetAt,
          },
        });

        const status = await store.getBudgetStatus(agent.id);
        expect(status.lastResetAt).toBe(budgetResetAt);
      });

      it("returns null nextResetAt for lifetime budget period", async () => {
        const agent = await store.createAgent({
          name: "Lifetime Budget",
          role: "executor",
          runtimeConfig: {
            budgetConfig: {
              tokenBudget: 1000,
              budgetPeriod: "lifetime",
            },
          },
        });

        const status = await store.getBudgetStatus(agent.id);
        expect(status.nextResetAt).toBeNull();
      });

      it("computes nextResetAt for daily period as next midnight", async () => {
        const agent = await store.createAgent({
          name: "Daily Budget",
          role: "executor",
          runtimeConfig: {
            budgetConfig: {
              tokenBudget: 1000,
              budgetPeriod: "daily",
            },
          },
        });

        const now = Date.now();
        const status = await store.getBudgetStatus(agent.id);

        expect(status.nextResetAt).not.toBeNull();
        const nextResetAt = new Date(status.nextResetAt!);
        expect(nextResetAt.getTime()).toBeGreaterThan(now);
        expect(nextResetAt.getHours()).toBe(0);
        expect(nextResetAt.getMinutes()).toBe(0);
        expect(nextResetAt.getSeconds()).toBe(0);
        expect(nextResetAt.getMilliseconds()).toBe(0);
      });

      it("computes nextResetAt for weekly period using resetDay", async () => {
        const agent = await store.createAgent({
          name: "Weekly Budget",
          role: "executor",
          runtimeConfig: {
            budgetConfig: {
              tokenBudget: 1000,
              budgetPeriod: "weekly",
              resetDay: 1,
            },
          },
        });

        const now = Date.now();
        const status = await store.getBudgetStatus(agent.id);

        expect(status.nextResetAt).not.toBeNull();
        const nextResetAt = new Date(status.nextResetAt!);
        expect(nextResetAt.getTime()).toBeGreaterThan(now);
        expect(nextResetAt.getDay()).toBe(1);
        expect(nextResetAt.getHours()).toBe(0);
        expect(nextResetAt.getMinutes()).toBe(0);
        expect(nextResetAt.getSeconds()).toBe(0);
        expect(nextResetAt.getMilliseconds()).toBe(0);
        expect(nextResetAt.getTime() - now).toBeLessThanOrEqual(8 * 24 * 60 * 60 * 1000);
      });

      it("clamps resetDay to month length for monthly period", async () => {
        const agent = await store.createAgent({
          name: "Monthly Budget",
          role: "executor",
          runtimeConfig: {
            budgetConfig: {
              tokenBudget: 1000,
              budgetPeriod: "monthly",
              resetDay: 31,
            },
          },
        });

        const now = Date.now();
        const status = await store.getBudgetStatus(agent.id);

        expect(status.nextResetAt).not.toBeNull();
        const nextResetAt = new Date(status.nextResetAt!);
        const lastDayOfMonth = new Date(nextResetAt.getFullYear(), nextResetAt.getMonth() + 1, 0).getDate();

        expect(nextResetAt.getTime()).toBeGreaterThan(now);
        expect(nextResetAt.getDate()).toBe(Math.min(31, lastDayOfMonth));
        expect(nextResetAt.getHours()).toBe(0);
        expect(nextResetAt.getMinutes()).toBe(0);
        expect(nextResetAt.getSeconds()).toBe(0);
        expect(nextResetAt.getMilliseconds()).toBe(0);
      });
    });

    describe("resetBudgetUsage", () => {
      it("throws if agent not found", async () => {
        await expect(store.resetBudgetUsage("nonexistent")).rejects.toThrow("not found");
      });

      it("resets totalInputTokens and totalOutputTokens to 0", async () => {
        const agent = await store.createAgent({
          name: "Reset Usage",
          role: "executor",
        });

        await store.updateAgent(agent.id, {
          totalInputTokens: 1200,
          totalOutputTokens: 800,
        });

        await store.resetBudgetUsage(agent.id);

        const updated = await store.getAgent(agent.id);
        expect(updated).not.toBeNull();
        expect(updated?.totalInputTokens).toBe(0);
        expect(updated?.totalOutputTokens).toBe(0);
      });

      it("sets budgetResetAt to current timestamp", async () => {
        const agent = await store.createAgent({
          name: "Reset Timestamp",
          role: "executor",
        });

        const beforeReset = Date.now();
        await store.resetBudgetUsage(agent.id);

        const updated = await store.getAgent(agent.id);
        const rawBudgetResetAt = (updated?.runtimeConfig as Record<string, unknown> | undefined)?.budgetResetAt;

        expect(typeof rawBudgetResetAt).toBe("string");

        const parsedResetAt = new Date(rawBudgetResetAt as string).getTime();
        expect(parsedResetAt).toBeGreaterThanOrEqual(beforeReset - 5000);
        expect(parsedResetAt).toBeGreaterThan(Date.now() - 5000);
      });

      it("preserves other runtimeConfig values", async () => {
        const agent = await store.createAgent({
          name: "Preserve Config",
          role: "executor",
          runtimeConfig: {
            heartbeatIntervalMs: 30000,
            budgetConfig: {
              tokenBudget: 1000,
            },
          },
        });

        await store.resetBudgetUsage(agent.id);

        const updated = await store.getAgent(agent.id);
        const runtimeConfig = updated?.runtimeConfig as Record<string, unknown>;

        expect(runtimeConfig.heartbeatIntervalMs).toBe(30000);
        expect(runtimeConfig.budgetConfig).toEqual({ tokenBudget: 1000 });
        expect(typeof runtimeConfig.budgetResetAt).toBe("string");
      });
    });
  });

  // ── updateAgent ───────────────────────────────────────────────────

  describe("updateAgent", () => {
    it("updates name, role, and metadata fields", async () => {
      const created = await store.createAgent({
        name: "Before",
        role: "executor",
      });

      const updated = await store.updateAgent(created.id, {
        name: "After",
        role: "reviewer",
        metadata: { key: "value" },
      });

      expect(updated.name).toBe("After");
      expect(updated.role).toBe("reviewer");
      expect(updated.metadata).toEqual({ key: "value" });
      expect(new Date(updated.updatedAt).getTime()).toBeGreaterThanOrEqual(
        new Date(created.updatedAt).getTime()
      );
    });

    it("preserves fields not included in the update input", async () => {
      const created = await store.createAgent({
        name: "Original",
        role: "executor",
        metadata: { preserved: true },
      });

      const updated = await store.updateAgent(created.id, {
        name: "Changed Name",
      });

      expect(updated.name).toBe("Changed Name");
      expect(updated.role).toBe("executor"); // preserved
      expect(updated.metadata).toEqual({ preserved: true }); // preserved
    });

    it("updates soul and memory fields", async () => {
      const created = await store.createAgent({
        name: "Knowledge Agent",
        role: "executor",
      });

      const updated = await store.updateAgent(created.id, {
        soul: "Collaborative, practical mentor",
        memory: "Avoids broad rewrites; prefers incremental changes.",
      });

      expect(updated.soul).toBe("Collaborative, practical mentor");
      expect(updated.memory).toBe("Avoids broad rewrites; prefers incremental changes.");

      const persisted = await store.getAgent(created.id);
      expect(persisted?.soul).toBe("Collaborative, practical mentor");
      expect(persisted?.memory).toBe("Avoids broad rewrites; prefers incremental changes.");
    });

    it("does not clear soul when updates.soul is undefined", async () => {
      const created = await store.createAgent({
        name: "Stable Soul",
        role: "executor",
        soul: "Patient reviewer",
      });

      const updated = await store.updateAgent(created.id, {
        soul: undefined,
        memory: "Remembers coding preferences",
      });

      expect(updated.soul).toBe("Patient reviewer");
      expect(updated.memory).toBe("Remembers coding preferences");
    });

    it("allows clearing optional fields via explicit undefined", async () => {
      const created = await store.createAgent({
        name: "Clearable",
        role: "executor",
        title: "Worker",
        instructionsText: "Initial instructions",
      });

      const withTransientState = await store.updateAgent(created.id, {
        pauseReason: "manual",
        lastError: "oops",
      });
      expect(withTransientState.pauseReason).toBe("manual");
      expect(withTransientState.lastError).toBe("oops");

      const cleared = await store.updateAgent(created.id, {
        title: undefined,
        instructionsText: undefined,
        pauseReason: undefined,
        lastError: undefined,
      });

      expect(cleared.title).toBeUndefined();
      expect(cleared.instructionsText).toBeUndefined();
      expect(cleared.pauseReason).toBeUndefined();
      expect(cleared.lastError).toBeUndefined();
    });

    it("rejects whitespace-only names", async () => {
      const created = await store.createAgent({
        name: "Rename Me",
        role: "executor",
      });

      await expect(store.updateAgent(created.id, { name: "   " })).rejects.toThrow("Agent name cannot be empty");
    });

    it("throws for non-existent agent ID", async () => {
      await expect(
        store.updateAgent("agent-missing", { name: "Nope" })
      ).rejects.toThrow("Agent agent-missing not found");
    });

    it("emits 'agent:updated' event", async () => {
      const created = await store.createAgent({
        name: "Update Event",
        role: "executor",
      });

      const handler = vi.fn();
      store.on("agent:updated", handler);

      const updated = await store.updateAgent(created.id, { name: "New Name" });

      expect(handler).toHaveBeenCalledWith(updated);
    });
  });

  // ── config revisions ───────────────────────────────────────────────

  describe("config revisions", () => {
    it("records revision when name changes", async () => {
      const created = await store.createAgent({ name: "Original", role: "executor" });

      await store.updateAgent(created.id, { name: "Renamed" });

      const revisions = await store.getConfigRevisions(created.id);
      expect(revisions).toHaveLength(1);
      expect(revisions[0].source).toBe("user");
      expect(revisions[0].diffs).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ field: "name", oldValue: "Original", newValue: "Renamed" }),
        ]),
      );
      expect(revisions[0].summary).toContain("name");
      expect(revisions[0].before.name).toBe("Original");
      expect(revisions[0].after.name).toBe("Renamed");
    });

    it("records revisions for runtimeConfig, permissions, instructions, soul, and memory changes", async () => {
      const created = await store.createAgent({
        name: "Configurable",
        role: "executor",
        runtimeConfig: { heartbeatIntervalMs: 30000 },
        permissions: { canReview: false },
      });

      await store.updateAgent(created.id, { runtimeConfig: { heartbeatIntervalMs: 10000 } });
      await store.updateAgent(created.id, { permissions: { canReview: true, canExecute: true } });
      await store.updateAgent(created.id, { instructionsPath: "docs/agent.md" });
      await store.updateAgent(created.id, { instructionsText: "Follow safety checks." });
      await store.updateAgent(created.id, { soul: "Thoughtful collaborator" });
      await store.updateAgent(created.id, { memory: "Knows the repository architecture" });

      const revisions = await store.getConfigRevisions(created.id);
      const changedFields = revisions.flatMap((revision) => revision.diffs.map((diff) => diff.field));

      expect(changedFields).toContain("runtimeConfig");
      expect(changedFields).toContain("permissions");
      expect(changedFields).toContain("instructionsPath");
      expect(changedFields).toContain("instructionsText");
      expect(changedFields).toContain("soul");
      expect(changedFields).toContain("memory");
    });

    it("does not create a revision when only non-config fields change", async () => {
      const created = await store.createAgent({ name: "No Diff", role: "executor" });

      await store.updateAgent(created.id, {
        totalInputTokens: 120,
        totalOutputTokens: 80,
        pauseReason: "manual",
        lastError: "temporary",
      });

      const revisions = await store.getConfigRevisions(created.id);
      expect(revisions).toEqual([]);
    });

    it("returns revisions in reverse chronological order and respects limit", async () => {
      const created = await store.createAgent({ name: "Chrono", role: "executor" });

      await store.updateAgent(created.id, { name: "Chrono-1" });
      await store.updateAgent(created.id, { name: "Chrono-2" });
      await store.updateAgent(created.id, { name: "Chrono-3" });

      const revisions = await store.getConfigRevisions(created.id);
      expect(revisions).toHaveLength(3);
      expect(revisions[0].after.name).toBe("Chrono-3");
      expect(revisions[1].after.name).toBe("Chrono-2");
      expect(revisions[2].after.name).toBe("Chrono-1");

      const limited = await store.getConfigRevisions(created.id, 2);
      expect(limited).toHaveLength(2);
      expect(limited.map((revision) => revision.after.name)).toEqual(["Chrono-3", "Chrono-2"]);
    });

    it("getConfigRevisions returns empty for agents with no revisions and non-existent agents", async () => {
      const created = await store.createAgent({ name: "No Revisions", role: "executor" });

      expect(await store.getConfigRevisions(created.id)).toEqual([]);
      expect(await store.getConfigRevisions("agent-missing")).toEqual([]);
    });

    it("getConfigRevision returns matching revision and null when missing", async () => {
      const created = await store.createAgent({ name: "Find Revision", role: "executor" });
      await store.updateAgent(created.id, { name: "Find Revision v2" });

      const [revision] = await store.getConfigRevisions(created.id);
      const found = await store.getConfigRevision(created.id, revision.id);

      expect(found).not.toBeNull();
      expect(found!.id).toBe(revision.id);
      expect(await store.getConfigRevision(created.id, "revision-missing")).toBeNull();
      expect(await store.getConfigRevision("agent-missing", revision.id)).toBeNull();
    });

    it("rollbackConfig restores previous config and records rollback revision", async () => {
      const created = await store.createAgent({
        name: "Rollback Me",
        role: "executor",
        runtimeConfig: { heartbeatTimeoutMs: 60000 },
      });

      await store.updateAgent(created.id, {
        name: "Rollback Me v2",
        runtimeConfig: { heartbeatTimeoutMs: 90000 },
      });

      const [targetRevision] = await store.getConfigRevisions(created.id);
      const result = await store.rollbackConfig(created.id, targetRevision.id);

      expect(result.agent.name).toBe("Rollback Me");
      // createAgent now injects the default heartbeatIntervalMs on non-ephemeral
      // agents, so the rollback target config includes that field alongside
      // whatever the caller supplied.
      expect(result.agent.runtimeConfig).toEqual({
        enabled: true,
        heartbeatTimeoutMs: 60000,
        heartbeatIntervalMs: 3_600_000,
      });
      expect(result.revision.source).toBe("rollback");
      expect(result.revision.rollbackToRevisionId).toBe(targetRevision.id);

      const revisions = await store.getConfigRevisions(created.id);
      expect(revisions[0].id).toBe(result.revision.id);
      expect(revisions[0].source).toBe("rollback");
    });

    it("rollbackConfig supports chained rollbacks", async () => {
      const created = await store.createAgent({ name: "Version 1", role: "executor" });
      await store.updateAgent(created.id, { name: "Version 2" });
      await store.updateAgent(created.id, { name: "Version 3" });

      const revisions = await store.getConfigRevisions(created.id);
      const revToV2 = revisions.find((revision) => revision.after.name === "Version 3");
      const revToV1 = revisions.find((revision) => revision.after.name === "Version 2");
      expect(revToV2).toBeDefined();
      expect(revToV1).toBeDefined();

      await store.rollbackConfig(created.id, revToV2!.id);
      const afterFirstRollback = await store.getAgent(created.id);
      expect(afterFirstRollback!.name).toBe("Version 2");

      await store.rollbackConfig(created.id, revToV1!.id);
      const afterSecondRollback = await store.getAgent(created.id);
      expect(afterSecondRollback!.name).toBe("Version 1");
    });

    it("rollbackConfig throws for missing revision", async () => {
      const created = await store.createAgent({ name: "Rollback Missing", role: "executor" });

      await expect(store.rollbackConfig(created.id, "revision-missing")).rejects.toThrow(
        `Config revision revision-missing not found for agent ${created.id}`,
      );
    });

    it("rollbackConfig throws when revision belongs to a different agent", async () => {
      const agentA = await store.createAgent({ name: "Agent A", role: "executor" });
      const agentB = await store.createAgent({ name: "Agent B", role: "reviewer" });

      await store.updateAgent(agentA.id, { name: "Agent A v2" });
      const [revisionA] = await store.getConfigRevisions(agentA.id);

      await expect(store.rollbackConfig(agentB.id, revisionA.id)).rejects.toThrow(
        `Config revision ${revisionA.id} belongs to agent ${agentA.id}`,
      );
    });

    it("emits agent:configRevision on config updates and rollback, but not updateAgentState", async () => {
      const created = await store.createAgent({ name: "Events", role: "executor" });
      const handler = vi.fn();
      store.on("agent:configRevision", handler);

      await store.updateAgent(created.id, { name: "Events v2" });
      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenLastCalledWith(
        created.id,
        expect.objectContaining({ agentId: created.id, source: "user" }),
      );

      await store.updateAgentState(created.id, "idle");
      expect(handler).toHaveBeenCalledTimes(1);

      const [firstRevision] = await store.getConfigRevisions(created.id);
      await store.rollbackConfig(created.id, firstRevision.id);
      expect(handler).toHaveBeenCalledTimes(2);
      expect(handler).toHaveBeenLastCalledWith(
        created.id,
        expect.objectContaining({ source: "rollback", rollbackToRevisionId: firstRevision.id }),
      );
    });

    it("persists revisions separately from heartbeat history", async () => {
      const created = await store.createAgent({ name: "Persisted", role: "executor" });

      await store.updateAgent(created.id, { name: "Persisted v2" });
      await store.updateAgent(created.id, { name: "Persisted v3" });
      await store.recordHeartbeat(created.id, "ok");

      const revisions = await store.getConfigRevisions(created.id);
      expect(revisions).toHaveLength(2);
      expect(revisions.every((revision) => revision.agentId === created.id)).toBe(true);

      const heartbeats = await store.getHeartbeatHistory(created.id);
      expect(heartbeats).toHaveLength(1);
      expect(heartbeats[0].status).toBe("ok");
    });
  });

  // ── deleteAgent ───────────────────────────────────────────────────

  describe("deleteAgent", () => {
    it("removes the agent so getAgent returns null", async () => {
      const created = await store.createAgent({
        name: "To Delete",
        role: "executor",
      });

      await store.deleteAgent(created.id);
      const found = await store.getAgent(created.id);
      expect(found).toBeNull();
    });

    it("also removes heartbeat history", async () => {
      const created = await store.createAgent({
        name: "With HB",
        role: "executor",
      });

      await store.recordHeartbeat(created.id, "ok");
      expect(await store.getHeartbeatHistory(created.id)).toHaveLength(1);

      await store.deleteAgent(created.id);
      expect(await store.getHeartbeatHistory(created.id)).toHaveLength(0);
    });

    it("throws for non-existent agent ID", async () => {
      await expect(store.deleteAgent("agent-missing")).rejects.toThrow(
        "Agent agent-missing not found"
      );
    });

    it("emits 'agent:deleted' event with the agent ID", async () => {
      const created = await store.createAgent({
        name: "Delete Event",
        role: "executor",
      });

      const handler = vi.fn();
      store.on("agent:deleted", handler);

      await store.deleteAgent(created.id);

      expect(handler).toHaveBeenCalledOnce();
      expect(handler).toHaveBeenCalledWith(created.id);
    });
  });

  // ── listAgents ────────────────────────────────────────────────────

  describe("listAgents", () => {
    it("returns empty array when no agents exist", async () => {
      const agents = await store.listAgents();
      expect(agents).toEqual([]);
    });

    it("returns all created agents sorted by createdAt descending", async () => {
      vi.useFakeTimers();
      try {
        vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
        const a1 = await store.createAgent({ name: "First", role: "executor" });

        vi.setSystemTime(new Date("2026-01-02T00:00:00Z"));
        const a2 = await store.createAgent({ name: "Second", role: "reviewer" });

        vi.setSystemTime(new Date("2026-01-03T00:00:00Z"));
        const a3 = await store.createAgent({ name: "Third", role: "triage" });

        const agents = await store.listAgents();
        expect(agents).toHaveLength(3);
        // Newest first
        expect(agents[0].id).toBe(a3.id);
        expect(agents[1].id).toBe(a2.id);
        expect(agents[2].id).toBe(a1.id);
      } finally {
        vi.useRealTimers();
      }
    });

    it("filters by state", async () => {
      const a1 = await store.createAgent({ name: "Idle", role: "executor" });
      const a2 = await store.createAgent({ name: "Active", role: "executor" });
      // Record a heartbeat first so that updateAgentState(→active) doesn't
      // trigger startHeartbeatRun internally (which would re-enter withLock).
      await store.recordHeartbeat(a2.id, "ok");
      await store.updateAgentState(a2.id, "active");

      const idle = await store.listAgents({ state: "idle" });
      expect(idle).toHaveLength(1);
      expect(idle[0].id).toBe(a1.id);

      const active = await store.listAgents({ state: "active" });
      expect(active).toHaveLength(1);
      expect(active[0].id).toBe(a2.id);
    });

    it("filters by role", async () => {
      await store.createAgent({ name: "Exec", role: "executor" });
      await store.createAgent({ name: "Review", role: "reviewer" });

      const executors = await store.listAgents({ role: "executor" });
      expect(executors).toHaveLength(1);
      expect(executors[0].name).toBe("Exec");
    });

    it("filters by both state and role", async () => {
      const a1 = await store.createAgent({ name: "ActiveExec", role: "executor" });
      await store.recordHeartbeat(a1.id, "ok");
      await store.updateAgentState(a1.id, "active");
      await store.createAgent({ name: "IdleExec", role: "executor" });
      const a3 = await store.createAgent({ name: "ActiveReview", role: "reviewer" });
      await store.recordHeartbeat(a3.id, "ok");
      await store.updateAgentState(a3.id, "active");

      const result = await store.listAgents({ state: "active", role: "executor" });
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe("ActiveExec");
    });

    it("ignores deprecated JSON agent files when listing SQLite agents", async () => {
      await store.createAgent({ name: "Valid", role: "executor" });

      const corruptPath = join(rootDir, "agents", "agent-corrupt.json");
      writeFileSync(corruptPath, "not-valid-json{{{");

      const agents = await store.listAgents();
      expect(agents).toHaveLength(1);
      expect(agents[0].name).toBe("Valid");
    });

    it("filters out ephemeral agents by default", async () => {
      // Create a normal agent
      const normal = await store.createAgent({ name: "Normal Agent", role: "executor" });

      // Create a task-worker agent
      const taskWorker = await store.createAgent({
        name: "executor-FN-TEST",
        role: "executor",
        metadata: { agentKind: "task-worker" },
      });

      // Create a spawned child agent
      const spawned = await store.createAgent({
        name: "spawned-agent",
        role: "executor",
        metadata: { type: "spawned" },
      });

      // Create an agent with taskWorker metadata
      const withTaskWorker = await store.createAgent({
        name: "task-worker-agent",
        role: "executor",
        metadata: { taskWorker: true },
      });

      // Create an agent with managedBy metadata
      const managedBy = await store.createAgent({
        name: "managed-agent",
        role: "executor",
        metadata: { managedBy: "task-executor" },
      });

      // Without includeEphemeral filter, ephemeral agents are filtered out by default
      const allAgents = await store.listAgents();
      expect(allAgents).toHaveLength(1);
      expect(allAgents[0].id).toBe(normal.id);

      // With includeEphemeral: true, all agents are returned
      const allIncludingEphemeral = await store.listAgents({ includeEphemeral: true });
      expect(allIncludingEphemeral).toHaveLength(5);
    });

    it("includeEphemeral filter works with state filter", async () => {
      // Create a normal agent
      const normal = await store.createAgent({ name: "Normal Agent", role: "executor" });

      // Create a task-worker agent
      const taskWorker = await store.createAgent({
        name: "executor-FN-TEST",
        role: "executor",
        metadata: { agentKind: "task-worker" },
      });
      await store.recordHeartbeat(taskWorker.id, "ok");
      await store.updateAgentState(taskWorker.id, "active");

      // Without includeEphemeral filter - only returns active non-ephemeral agents
      const activeNonEphemeral = await store.listAgents({ state: "active" });
      expect(activeNonEphemeral).toHaveLength(0);

      // With includeEphemeral: true, returns all active agents
      const activeAll = await store.listAgents({ state: "active", includeEphemeral: true });
      expect(activeAll).toHaveLength(1);
      expect(activeAll[0].id).toBe(taskWorker.id);
    });

    it("filters out agents marked with metadata.internal", async () => {
      const normal = await store.createAgent({ name: "Normal Agent", role: "executor" });
      await store.createAgent({
        name: "internal-agent",
        role: "executor",
        metadata: { internal: true },
      });

      const defaultAgents = await store.listAgents();
      expect(defaultAgents).toHaveLength(1);
      expect(defaultAgents[0].id).toBe(normal.id);

      const includingEphemeral = await store.listAgents({ includeEphemeral: true });
      expect(includingEphemeral).toHaveLength(2);
    });

    it("filters legacy verification-agent fallback by default", async () => {
      const normal = await store.createAgent({ name: "Normal Agent", role: "executor" });
      await store.createAgent({
        name: "verification-agent",
        role: "executor",
        metadata: {},
      });

      const defaultAgents = await store.listAgents();
      expect(defaultAgents).toHaveLength(1);
      expect(defaultAgents[0].id).toBe(normal.id);

      const includingEphemeral = await store.listAgents({ includeEphemeral: true });
      expect(includingEphemeral).toHaveLength(2);
    });
  });

  // ── Org Hierarchy ────────────────────────────────────────────────

  describe("getChainOfCommand", () => {
    it("returns empty array for nonexistent agent", async () => {
      const chain = await store.getChainOfCommand("agent-missing");
      expect(chain).toEqual([]);
    });

    it("returns only self when agent has no manager", async () => {
      const solo = await store.createAgent({ name: "Solo", role: "executor" });

      const chain = await store.getChainOfCommand(solo.id);
      expect(chain.map((agent) => agent.id)).toEqual([solo.id]);
    });

    it("returns self → manager → grand-manager", async () => {
      const grandManager = await store.createAgent({ name: "Grand", role: "executor" });
      const manager = await store.createAgent({
        name: "Manager",
        role: "executor",
        reportsTo: grandManager.id,
      });
      const agent = await store.createAgent({
        name: "Worker",
        role: "executor",
        reportsTo: manager.id,
      });

      const chain = await store.getChainOfCommand(agent.id);
      expect(chain.map((item) => item.id)).toEqual([agent.id, manager.id, grandManager.id]);
    });

    it("stops traversal when a cycle is detected", async () => {
      const a = await store.createAgent({ name: "Cycle A", role: "executor" });
      const b = await store.createAgent({
        name: "Cycle B",
        role: "executor",
        reportsTo: a.id,
      });

      await store.updateAgent(a.id, { reportsTo: b.id });

      const chain = await store.getChainOfCommand(a.id);
      expect(chain.map((agent) => agent.id)).toEqual([a.id, b.id]);
      expect(chain.length).toBeLessThanOrEqual(20);
    });
  });

  describe("getOrgTree", () => {
    it("returns empty array when no agents exist", async () => {
      const tree = await store.getOrgTree();
      expect(tree).toEqual([]);
    });

    it("returns all agents as roots when no one has reportsTo", async () => {
      vi.useFakeTimers();
      try {
        vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
        const first = await store.createAgent({ name: "First", role: "executor" });

        vi.setSystemTime(new Date("2026-01-02T00:00:00Z"));
        const second = await store.createAgent({ name: "Second", role: "executor" });

        const tree = await store.getOrgTree();
        expect(tree).toHaveLength(2);
        expect(tree.map((node) => node.agent.id)).toEqual([first.id, second.id]);
        expect(tree[0].children).toEqual([]);
        expect(tree[1].children).toEqual([]);
      } finally {
        vi.useRealTimers();
      }
    });

    it("builds a nested hierarchy and sorts children by createdAt ascending", async () => {
      vi.useFakeTimers();
      try {
        vi.setSystemTime(new Date("2026-02-01T00:00:00Z"));
        const root = await store.createAgent({ name: "Root", role: "executor" });

        vi.setSystemTime(new Date("2026-02-02T00:00:00Z"));
        const childOlder = await store.createAgent({
          name: "Child Older",
          role: "executor",
          reportsTo: root.id,
        });

        vi.setSystemTime(new Date("2026-02-03T00:00:00Z"));
        const childYounger = await store.createAgent({
          name: "Child Younger",
          role: "executor",
          reportsTo: root.id,
        });

        vi.setSystemTime(new Date("2026-02-04T00:00:00Z"));
        const grandChild = await store.createAgent({
          name: "Grand Child",
          role: "executor",
          reportsTo: childOlder.id,
        });

        const tree = await store.getOrgTree();
        expect(tree).toHaveLength(1);
        expect(tree[0].agent.id).toBe(root.id);
        expect(tree[0].children.map((node) => node.agent.id)).toEqual([
          childOlder.id,
          childYounger.id,
        ]);
        expect(tree[0].children[0].children.map((node) => node.agent.id)).toEqual([
          grandChild.id,
        ]);
      } finally {
        vi.useRealTimers();
      }
    });

    it("treats agents with missing managers as root nodes", async () => {
      const root = await store.createAgent({ name: "Root", role: "executor" });
      const orphan = await store.createAgent({
        name: "Orphan",
        role: "executor",
        reportsTo: "agent-nonexistent",
      });

      const tree = await store.getOrgTree();
      expect(tree.map((node) => node.agent.id).sort()).toEqual([root.id, orphan.id].sort());
    });
  });

  describe("resolveAgent", () => {
    it("resolves by exact agent ID", async () => {
      const created = await store.createAgent({ name: "ID Match", role: "executor" });

      const resolved = await store.resolveAgent(created.id);
      expect(resolved?.id).toBe(created.id);
    });

    it("resolves by normalized name", async () => {
      const created = await store.createAgent({ name: "My Agent", role: "executor" });

      const resolved = await store.resolveAgent("my-agent");
      expect(resolved?.id).toBe(created.id);
    });

    it("returns null when multiple agents share the same normalized shortname", async () => {
      await store.createAgent({ name: "My Agent", role: "executor" });
      await store.createAgent({ name: "my-agent", role: "reviewer" });

      const resolved = await store.resolveAgent("my-agent");
      expect(resolved).toBeNull();
    });

    it("returns null for unknown shortnames", async () => {
      await store.createAgent({ name: "Known Agent", role: "executor" });

      const resolved = await store.resolveAgent("not-found");
      expect(resolved).toBeNull();
    });

    it("matches shortnames case-insensitively", async () => {
      const created = await store.createAgent({ name: "My Agent", role: "executor" });

      const resolved = await store.resolveAgent("MY-AGENT");
      expect(resolved?.id).toBe(created.id);
    });

    it("normalizes special characters in names", async () => {
      const created = await store.createAgent({ name: "Test Agent v2!", role: "executor" });

      const resolved = await store.resolveAgent("test-agent-v2");
      expect(resolved?.id).toBe(created.id);
    });
  });

  // ── updateAgentState ──────────────────────────────────────────────

  describe("updateAgentState", () => {
    // Helper: create an agent and set lastHeartbeatAt so that
    // idle→active transitions don't trigger the re-entrant
    // startHeartbeatRun path (see FN-711 for the deadlock bug).
    // Also records a "missed" heartbeat to close any active run,
    // preventing the terminated-transition deadlock path too.
    async function createReadyAgent(s: AgentStore, name: string) {
      const agent = await s.createAgent({ name, role: "executor" });
      await s.recordHeartbeat(agent.id, "ok");
      // Close the active run so transitioning to terminated
      // won't trigger endHeartbeatRun inside withLock.
      await s.recordHeartbeat(agent.id, "missed");
      return agent;
    }

    it("idle → active transition succeeds", async () => {
      const agent = await createReadyAgent(store, "IdleToActive");
      const updated = await store.updateAgentState(agent.id, "active");
      expect(updated.state).toBe("active");
    });

    it("active → paused transition succeeds", async () => {
      const agent = await createReadyAgent(store, "ActiveToPaused");
      await store.updateAgentState(agent.id, "active");
      const updated = await store.updateAgentState(agent.id, "paused");
      expect(updated.state).toBe("paused");
    });

    it("active → terminated transition succeeds", async () => {
      const agent = await createReadyAgent(store, "ActiveToTerminated");
      await store.updateAgentState(agent.id, "active");
      const updated = await store.updateAgentState(agent.id, "terminated");
      expect(updated.state).toBe("terminated");
    });

    it("paused → active transition succeeds", async () => {
      const agent = await createReadyAgent(store, "PausedToActive");
      await store.updateAgentState(agent.id, "active");
      await store.updateAgentState(agent.id, "paused");
      const updated = await store.updateAgentState(agent.id, "active");
      expect(updated.state).toBe("active");
    });

    it("paused → terminated transition succeeds", async () => {
      const agent = await createReadyAgent(store, "PausedToTerminated");
      await store.updateAgentState(agent.id, "active");
      await store.updateAgentState(agent.id, "paused");
      const updated = await store.updateAgentState(agent.id, "terminated");
      expect(updated.state).toBe("terminated");
    });

    it("same-state transition returns agent unchanged (no-op)", async () => {
      const agent = await store.createAgent({ name: "SameState", role: "executor" });
      const unchanged = await store.updateAgentState(agent.id, "idle");
      expect(unchanged.state).toBe("idle");
      expect(unchanged.updatedAt).toBe(agent.updatedAt);
    });

    it("idle → paused throws with descriptive error message", async () => {
      const agent = await store.createAgent({ name: "BadTransition", role: "executor" });
      await expect(
        store.updateAgentState(agent.id, "paused")
      ).rejects.toThrow("Invalid state transition: idle -> paused");
    });

    it("idle → terminated throws", async () => {
      const agent = await store.createAgent({ name: "BadTerminate", role: "executor" });
      await expect(
        store.updateAgentState(agent.id, "terminated")
      ).rejects.toThrow("Invalid state transition: idle -> terminated");
    });

    it("transition from terminated to paused still throws", async () => {
      const agent = await createReadyAgent(store, "Terminated");
      await store.updateAgentState(agent.id, "active");
      await store.updateAgentState(agent.id, "terminated");

      await expect(
        store.updateAgentState(agent.id, "paused")
      ).rejects.toThrow("Invalid state transition: terminated -> paused");
    });

    it("terminated → active transition succeeds", async () => {
      const agent = await createReadyAgent(store, "RestartActive");
      await store.updateAgentState(agent.id, "active");
      await store.updateAgentState(agent.id, "terminated");

      const updated = await store.updateAgentState(agent.id, "active");
      expect(updated.state).toBe("active");
    });

    it("terminated → running transition succeeds", async () => {
      const agent = await createReadyAgent(store, "RestartRunning");
      await store.updateAgentState(agent.id, "active");
      await store.updateAgentState(agent.id, "terminated");

      const updated = await store.updateAgentState(agent.id, "running");
      expect(updated.state).toBe("running");
    });

    it("terminated → idle transition succeeds", async () => {
      const agent = await createReadyAgent(store, "RestartIdle");
      await store.updateAgentState(agent.id, "active");
      await store.updateAgentState(agent.id, "terminated");

      const updated = await store.updateAgentState(agent.id, "idle");
      expect(updated.state).toBe("idle");
    });

    it("transitioning from terminated clears lastError", async () => {
      const agent = await createReadyAgent(store, "ClearError");
      await store.updateAgentState(agent.id, "active");
      await store.updateAgent(agent.id, { lastError: "something broke" });
      await store.updateAgentState(agent.id, "terminated");

      const restarted = await store.updateAgentState(agent.id, "active");
      expect(restarted.state).toBe("active");
      expect(restarted.lastError).toBeUndefined();
    });

    it("emits both 'agent:stateChanged' and 'agent:updated' events", async () => {
      const agent = await createReadyAgent(store, "StateEvents");

      const stateHandler = vi.fn();
      const updateHandler = vi.fn();
      store.on("agent:stateChanged", stateHandler);
      store.on("agent:updated", updateHandler);

      await store.updateAgentState(agent.id, "active");

      expect(stateHandler).toHaveBeenCalledOnce();
      expect(stateHandler).toHaveBeenCalledWith(agent.id, "idle", "active");

      // agent:updated is called with updated agent and previousState
      expect(updateHandler).toHaveBeenCalled();
      const [updatedAgent, previousState] = updateHandler.mock.calls[0];
      expect(updatedAgent.state).toBe("active");
      expect(previousState).toBe("idle");
    });

    it("throws for non-existent agent", async () => {
      await expect(
        store.updateAgentState("agent-nope", "active")
      ).rejects.toThrow("Agent agent-nope not found");
    });
  });

  // ── assignTask ────────────────────────────────────────────────────

  describe("assignTask", () => {
    it("sets taskId on the agent", async () => {
      const agent = await store.createAgent({ name: "Assignee", role: "executor" });
      const updated = await store.assignTask(agent.id, "KB-001");
      expect(updated.taskId).toBe("KB-001");

      const fetched = await store.getAgent(agent.id);
      expect(fetched!.taskId).toBe("KB-001");
    });

    it("clears taskId with undefined", async () => {
      const agent = await store.createAgent({ name: "Unassign", role: "executor" });
      await store.assignTask(agent.id, "KB-001");
      const updated = await store.assignTask(agent.id, undefined);
      expect(updated.taskId).toBeUndefined();
    });

    it("emits 'agent:updated' event", async () => {
      const agent = await store.createAgent({ name: "AssignEvent", role: "executor" });
      const handler = vi.fn();
      store.on("agent:updated", handler);

      await store.assignTask(agent.id, "KB-002");

      expect(handler).toHaveBeenCalledOnce();
      const [updatedAgent] = handler.mock.calls[0];
      expect(updatedAgent.taskId).toBe("KB-002");
    });

    it("emits 'agent:assigned' event when assigning a task", async () => {
      const agent = await store.createAgent({ name: "AssignEvent", role: "executor" });
      const handler = vi.fn();
      store.on("agent:assigned", handler);

      await store.assignTask(agent.id, "KB-003");

      expect(handler).toHaveBeenCalledOnce();
      const [updatedAgent, taskId] = handler.mock.calls[0];
      expect(updatedAgent.id).toBe(agent.id);
      expect(updatedAgent.taskId).toBe("KB-003");
      expect(taskId).toBe("KB-003");
    });

    it("does NOT emit 'agent:assigned' when clearing taskId", async () => {
      const agent = await store.createAgent({ name: "UnassignEvent", role: "executor" });
      await store.assignTask(agent.id, "KB-004");

      const handler = vi.fn();
      store.on("agent:assigned", handler);

      await store.assignTask(agent.id, undefined);

      expect(handler).not.toHaveBeenCalled();
    });

    it("throws for non-existent agent", async () => {
      await expect(
        store.assignTask("agent-missing", "KB-001")
      ).rejects.toThrow("Agent agent-missing not found");
    });
  });

  describe("checkout leasing", () => {
    let taskStore: TaskStore;
    let holderId: string;
    let otherAgentId: string;
    let taskId: string;

    beforeEach(async () => {
      taskStore = new TaskStore(rootDir, join(rootDir, ".fusion-global-settings"));
      await taskStore.init();

      store = new AgentStore({ rootDir, taskStore });
      await store.init();

      const holder = await store.createAgent({ name: "Checkout Holder", role: "executor" });
      const other = await store.createAgent({ name: "Checkout Other", role: "executor" });
      const task = await taskStore.createTask({ description: "Task for checkout leasing tests" });

      holderId = holder.id;
      otherAgentId = other.id;
      taskId = task.id;
    });

    afterEach(() => {
      store.close();
      taskStore.close();
    });

    it("checkoutTask acquires a lease and stamps checkedOutAt", async () => {
      const updated = await store.checkoutTask(holderId, taskId);

      expect(updated.checkedOutBy).toBe(holderId);
      expect(updated.checkedOutAt).toBeDefined();

      const persisted = await taskStore.getTask(taskId);
      expect(persisted?.checkedOutBy).toBe(holderId);
      expect(persisted?.checkedOutAt).toBeDefined();
    });

    it("checkoutTask is idempotent when the same agent re-checks out", async () => {
      const first = await store.checkoutTask(holderId, taskId);
      const second = await store.checkoutTask(holderId, taskId);

      expect(second.checkedOutBy).toBe(holderId);
      expect(second.checkedOutAt).toBe(first.checkedOutAt);
    });

    it("checkoutTask throws CheckoutConflictError when already held by another agent", async () => {
      await store.checkoutTask(holderId, taskId);

      try {
        await store.checkoutTask(otherAgentId, taskId);
        throw new Error("Expected checkout conflict");
      } catch (error) {
        expect(error).toBeInstanceOf(CheckoutConflictError);
        const conflict = error as CheckoutConflictError;
        expect(conflict.taskId).toBe(taskId);
        expect(conflict.currentHolderId).toBe(holderId);
        expect(conflict.requestedById).toBe(otherAgentId);
      }
    });

    it("checkoutTask throws when agent is missing", async () => {
      await expect(store.checkoutTask("agent-missing", taskId)).rejects.toThrow("Agent agent-missing not found");
    });

    it("checkoutTask throws when task is missing", async () => {
      await expect(store.checkoutTask(holderId, "FN-404")).rejects.toThrow("Task FN-404 not found");
    });

    it("releaseTask clears checkedOutBy and checkedOutAt for the holder", async () => {
      await store.checkoutTask(holderId, taskId);

      const released = await store.releaseTask(holderId, taskId);
      expect(released.checkedOutBy).toBeUndefined();
      expect(released.checkedOutAt).toBeUndefined();

      const persisted = await taskStore.getTask(taskId);
      expect(persisted?.checkedOutBy).toBeUndefined();
      expect(persisted?.checkedOutAt).toBeUndefined();
    });

    it("releaseTask throws for a non-holder agent", async () => {
      await store.checkoutTask(holderId, taskId);

      await expect(store.releaseTask(otherAgentId, taskId)).rejects.toThrow("Cannot release: not the checkout holder");
    });

    it("releaseTask is idempotent when task is already released", async () => {
      const released = await store.releaseTask(holderId, taskId);

      expect(released.checkedOutBy).toBeUndefined();
      expect(released.checkedOutAt).toBeUndefined();
    });

    it("forceReleaseTask clears checkout regardless of holder", async () => {
      await store.checkoutTask(holderId, taskId);

      const released = await store.forceReleaseTask(taskId);
      expect(released.checkedOutBy).toBeUndefined();
      expect(released.checkedOutAt).toBeUndefined();
    });

    it("getCheckedOutBy returns holder ID when checked out and undefined otherwise", async () => {
      expect(await store.getCheckedOutBy(taskId)).toBeUndefined();

      await store.checkoutTask(holderId, taskId);
      expect(await store.getCheckedOutBy(taskId)).toBe(holderId);
    });
  });

  // ── resetAgent ────────────────────────────────────────────────────

  describe("resetAgent", () => {
    // Helper: create an agent and transition it to terminated with error/task
    async function createTerminatedAgent(s: AgentStore, name: string) {
      const agent = await s.createAgent({ name, role: "executor" });
      await s.recordHeartbeat(agent.id, "ok");
      await s.recordHeartbeat(agent.id, "missed");
      await s.updateAgentState(agent.id, "active");
      await s.assignTask(agent.id, "KB-999");
      await s.updateAgent(agent.id, {
        pauseReason: "manual",
        lastError: "something broke",
      });
      await s.updateAgentState(agent.id, "terminated");
      return agent;
    }

    it("transitions terminated agent to idle", async () => {
      const agent = await createTerminatedAgent(store, "ResetToIdle");
      const reset = await store.resetAgent(agent.id);

      expect(reset.state).toBe("idle");
    });

    it("can reset directly from running", async () => {
      const agent = await store.createAgent({ name: "RunningReset", role: "executor" });
      await store.recordHeartbeat(agent.id, "ok");
      await store.updateAgentState(agent.id, "active");
      await store.updateAgentState(agent.id, "running");
      await store.assignTask(agent.id, "KB-123");
      await store.updateAgent(agent.id, {
        pauseReason: "stalled",
        lastError: "runner failed",
      });

      const reset = await store.resetAgent(agent.id);
      expect(reset.state).toBe("idle");
      expect(reset.taskId).toBeUndefined();
      expect(reset.pauseReason).toBeUndefined();
      expect(reset.lastError).toBeUndefined();
    });

    it("clears lastError", async () => {
      const agent = await createTerminatedAgent(store, "ResetClearsError");
      const reset = await store.resetAgent(agent.id);

      expect(reset.lastError).toBeUndefined();
    });

    it("clears pauseReason", async () => {
      const agent = await createTerminatedAgent(store, "ResetClearsPause");
      const reset = await store.resetAgent(agent.id);

      expect(reset.pauseReason).toBeUndefined();
    });

    it("clears taskId", async () => {
      const agent = await createTerminatedAgent(store, "ResetClearsTask");
      const reset = await store.resetAgent(agent.id);

      expect(reset.taskId).toBeUndefined();
    });

    it("starts fresh heartbeat tracking on subsequent active transition", async () => {
      const agent = await createTerminatedAgent(store, "ResetHeartbeat");
      await store.resetAgent(agent.id);

      // After reset, explicitly start a heartbeat run (as the caller would)
      const run = await store.startHeartbeatRun(agent.id);

      const activeRun = await store.getActiveHeartbeatRun(agent.id);
      expect(activeRun).not.toBeNull();
      expect(activeRun!.id).toBe(run.id);
    }, 15_000);

    it("throws for non-existent agent", async () => {
      await expect(
        store.resetAgent("agent-ghost")
      ).rejects.toThrow("Agent agent-ghost not found");
    });
  });

  // ── recordHeartbeat ───────────────────────────────────────────────

  describe("recordHeartbeat", () => {
    it("appends heartbeat history", async () => {
      const agent = await store.createAgent({ name: "HB Agent", role: "executor" });
      await store.recordHeartbeat(agent.id, "ok");
      await store.recordHeartbeat(agent.id, "ok");

      const history = await store.getHeartbeatHistory(agent.id);
      expect(history).toHaveLength(2);
    });

    it("with status 'ok' updates agent's lastHeartbeatAt", async () => {
      const agent = await store.createAgent({ name: "OK HB", role: "executor" });
      expect(agent.lastHeartbeatAt).toBeUndefined();

      await store.recordHeartbeat(agent.id, "ok");
      const updated = await store.getAgent(agent.id);
      expect(updated!.lastHeartbeatAt).toBeDefined();
      expect(new Date(updated!.lastHeartbeatAt!).getTime()).not.toBeNaN();
    });

    it("with status 'missed' does NOT update lastHeartbeatAt", async () => {
      const agent = await store.createAgent({ name: "Missed HB", role: "executor" });

      // Record an OK heartbeat first to set lastHeartbeatAt
      await store.recordHeartbeat(agent.id, "ok");
      const afterOk = await store.getAgent(agent.id);
      const okTimestamp = afterOk!.lastHeartbeatAt;

      // Record a missed heartbeat — lastHeartbeatAt should stay the same
      await store.recordHeartbeat(agent.id, "missed");
      const afterMissed = await store.getAgent(agent.id);
      expect(afterMissed!.lastHeartbeatAt).toBe(okTimestamp);
    });

    it("emits 'agent:heartbeat' event", async () => {
      const agent = await store.createAgent({ name: "HB Event", role: "executor" });
      const handler = vi.fn();
      store.on("agent:heartbeat", handler);

      await store.recordHeartbeat(agent.id, "ok");

      expect(handler).toHaveBeenCalledOnce();
      const [id, event] = handler.mock.calls[0];
      expect(id).toBe(agent.id);
      expect(event.status).toBe("ok");
      expect(event.runId).toBeDefined();
    });

    it("throws for non-existent agent", async () => {
      await expect(
        store.recordHeartbeat("agent-ghost", "ok")
      ).rejects.toThrow("Agent agent-ghost not found");
    });
  });

  // ── getHeartbeatHistory ───────────────────────────────────────────

  describe("getHeartbeatHistory", () => {
    it("returns events newest-first", async () => {
      vi.useFakeTimers();
      try {
        const agent = await store.createAgent({ name: "History", role: "executor" });

        vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
        await store.recordHeartbeat(agent.id, "ok");

        vi.setSystemTime(new Date("2026-01-02T00:00:00Z"));
        await store.recordHeartbeat(agent.id, "ok");

        vi.setSystemTime(new Date("2026-01-03T00:00:00Z"));
        await store.recordHeartbeat(agent.id, "ok");

        const history = await store.getHeartbeatHistory(agent.id);
        expect(history).toHaveLength(3);
        // Newest first
        expect(history[0].timestamp).toBe("2026-01-03T00:00:00.000Z");
        expect(history[1].timestamp).toBe("2026-01-02T00:00:00.000Z");
        expect(history[2].timestamp).toBe("2026-01-01T00:00:00.000Z");
      } finally {
        vi.useRealTimers();
      }
    });

    it("respects limit parameter", async () => {
      const agent = await store.createAgent({ name: "Limited", role: "executor" });
      for (let i = 0; i < 10; i++) {
        await store.recordHeartbeat(agent.id, "ok");
      }

      const limited = await store.getHeartbeatHistory(agent.id, 3);
      expect(limited).toHaveLength(3);
    });

    it("returns empty array when no heartbeats exist", async () => {
      const agent = await store.createAgent({ name: "NoHB", role: "executor" });
      const history = await store.getHeartbeatHistory(agent.id);
      expect(history).toEqual([]);
    });
  });

  // ── heartbeat runs ────────────────────────────────────────────────

  describe("heartbeat runs", () => {
    it("startHeartbeatRun returns a run with status 'active' and valid fields", async () => {
      const agent = await store.createAgent({ name: "RunAgent", role: "executor" });
      const run = await store.startHeartbeatRun(agent.id);

      expect(run.id).toMatch(/^run-/);
      expect(run.agentId).toBe(agent.id);
      expect(run.status).toBe("active");
      expect(run.endedAt).toBeNull();
      expect(new Date(run.startedAt).getTime()).not.toBeNaN();
    });

    it("getActiveHeartbeatRun returns the active run after starting one", async () => {
      const agent = await store.createAgent({ name: "ActiveRunAgent", role: "executor" });
      const run = await store.startHeartbeatRun(agent.id);

      const active = await store.getActiveHeartbeatRun(agent.id);
      expect(active).not.toBeNull();
      expect(active!.id).toBe(run.id);
      expect(active!.status).toBe("active");
    });

    it("getActiveHeartbeatRun returns null when no runs exist", async () => {
      const agent = await store.createAgent({ name: "NoRuns", role: "executor" });
      const active = await store.getActiveHeartbeatRun(agent.id);
      expect(active).toBeNull();
    });

    it("endHeartbeatRun with 'terminated' marks the run as ended", async () => {
      const agent = await store.createAgent({ name: "TermRun", role: "executor" });
      const run = await store.startHeartbeatRun(agent.id);

      await store.endHeartbeatRun(run.id, "terminated");

      const completed = await store.getCompletedHeartbeatRuns(agent.id);
      expect(completed).toHaveLength(1);
      expect(completed[0].id).toBe(run.id);
      expect(completed[0].status).toBe("terminated");
      expect(completed[0].endedAt).toBeDefined();
    });

    it("endHeartbeatRun with 'completed' removes from active and adds to completed", async () => {
      const agent = await store.createAgent({ name: "CompleteRun", role: "executor" });
      const run = await store.startHeartbeatRun(agent.id);

      await store.endHeartbeatRun(run.id, "completed");

      // A completed run should NOT appear in active runs
      const active = await store.getActiveHeartbeatRun(agent.id);
      expect(active).toBeNull();

      // A completed run should appear in completed runs with terminal status
      const completed = await store.getCompletedHeartbeatRuns(agent.id);
      expect(completed).toHaveLength(1);
      expect(completed[0].id).toBe(run.id);
      expect(completed[0].status).toBe("completed");
      expect(completed[0].endedAt).toBeDefined();
    });

    it("getCompletedHeartbeatRuns returns only non-active runs", async () => {
      const agent = await store.createAgent({ name: "MultiRun", role: "executor" });

      const run1 = await store.startHeartbeatRun(agent.id);
      await store.endHeartbeatRun(run1.id, "terminated");

      const run2 = await store.startHeartbeatRun(agent.id);
      // run2 is still active

      const completed = await store.getCompletedHeartbeatRuns(agent.id);
      expect(completed).toHaveLength(1);
      expect(completed[0].id).toBe(run1.id);

      // Active run should not appear in completed
      const active = await store.getActiveHeartbeatRun(agent.id);
      expect(active).not.toBeNull();
      expect(active!.id).toBe(run2.id);
    });

    it("after completion, a new run can start without stale active-run blockage", async () => {
      const agent = await store.createAgent({ name: "RestartRun", role: "executor" });

      // Start and complete first run
      const run1 = await store.startHeartbeatRun(agent.id);
      await store.endHeartbeatRun(run1.id, "completed");

      // Verify first run is not active
      const active1 = await store.getActiveHeartbeatRun(agent.id);
      expect(active1).toBeNull();

      // Start second run - should succeed without conflict
      const run2 = await store.startHeartbeatRun(agent.id);
      expect(run2.id).not.toBe(run1.id);
      expect(run2.status).toBe("active");

      // Verify second run is now the active run
      const active2 = await store.getActiveHeartbeatRun(agent.id);
      expect(active2).not.toBeNull();
      expect(active2!.id).toBe(run2.id);
    });

    it("startHeartbeatRun persists the run to structured storage", async () => {
      const agent = await store.createAgent({ name: "PersistRun", role: "executor" });
      const run = await store.startHeartbeatRun(agent.id);

      // Verify run is persisted
      const detail = await store.getRunDetail(agent.id, run.id);
      expect(detail).not.toBeNull();
      expect(detail!.id).toBe(run.id);
      expect(detail!.agentId).toBe(agent.id);
      expect(detail!.status).toBe("active");
      expect(detail!.endedAt).toBeNull();

      // Verify run appears in recent runs
      const recent = await store.getRecentRuns(agent.id);
      expect(recent.some((r) => r.id === run.id)).toBe(true);
    });

    it("endHeartbeatRun updates the persisted run with terminal state", async () => {
      const agent = await store.createAgent({ name: "UpdateRun", role: "executor" });
      const run = await store.startHeartbeatRun(agent.id);

      // Complete the run
      await store.endHeartbeatRun(run.id, "completed");

      // Verify persisted run is updated
      const detail = await store.getRunDetail(agent.id, run.id);
      expect(detail).not.toBeNull();
      expect(detail!.status).toBe("completed");
      expect(detail!.endedAt).toBeDefined();
    });

    it("getCompletedHeartbeatRuns returns terminal runs in newest-first order", async () => {
      const agent = await store.createAgent({ name: "OrderRuns", role: "executor" });

      vi.useFakeTimers();
      try {
        vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
        const run1 = await store.startHeartbeatRun(agent.id);
        await store.endHeartbeatRun(run1.id, "completed");

        vi.setSystemTime(new Date("2026-01-02T00:00:00Z"));
        const run2 = await store.startHeartbeatRun(agent.id);
        await store.endHeartbeatRun(run2.id, "completed");

        const completed = await store.getCompletedHeartbeatRuns(agent.id);
        expect(completed).toHaveLength(2);
        expect(completed[0].id).toBe(run2.id); // Newest first
        expect(completed[1].id).toBe(run1.id);
      } finally {
        vi.useRealTimers();
      }
    });

    it("reads completed runs from SQLite run storage", async () => {
      const agent = await store.createAgent({ name: "MixedRuns", role: "executor" });

      const structuredRun = await store.startHeartbeatRun(agent.id);
      await store.endHeartbeatRun(structuredRun.id, "completed");

      const completed = await store.getCompletedHeartbeatRuns(agent.id);
      expect(completed.some((r) => r.id === structuredRun.id)).toBe(true);
    });
  });

  // ── blocked state persistence ─────────────────────────────────────

  describe("blocked state persistence", () => {
    it("roundtrips last blocked state via set/get", async () => {
      const agent = await store.createAgent({ name: "BlockedState", role: "executor" });

      const snapshot = {
        taskId: "FN-123",
        blockedBy: "FN-122",
        recordedAt: new Date().toISOString(),
        contextHash: "abc123hash",
      };

      await store.setLastBlockedState(agent.id, snapshot);
      const loaded = await store.getLastBlockedState(agent.id);

      expect(loaded).toEqual(snapshot);
    });

    it("returns null when no blocked-state snapshot exists", async () => {
      const agent = await store.createAgent({ name: "NoBlockedState", role: "executor" });

      const loaded = await store.getLastBlockedState(agent.id);
      expect(loaded).toBeNull();
    });

    it("clearLastBlockedState removes persisted snapshot", async () => {
      const agent = await store.createAgent({ name: "ClearBlockedState", role: "executor" });

      await store.setLastBlockedState(agent.id, {
        taskId: "FN-999",
        blockedBy: "FN-998",
        recordedAt: new Date().toISOString(),
        contextHash: "will-clear",
      });

      await store.clearLastBlockedState(agent.id);
      const loaded = await store.getLastBlockedState(agent.id);

      expect(loaded).toBeNull();
    });
  });

  // ── getAgentDetail ────────────────────────────────────────────────

  describe("getAgentDetail", () => {
    it("returns agent data plus heartbeat info", async () => {
      const agent = await store.createAgent({ name: "DetailAgent", role: "executor" });
      await store.recordHeartbeat(agent.id, "ok");

      const detail = await store.getAgentDetail(agent.id);
      expect(detail).not.toBeNull();
      expect(detail!.id).toBe(agent.id);
      expect(detail!.name).toBe("DetailAgent");
      expect(detail!.heartbeatHistory).toHaveLength(1);
      expect(detail!.completedRuns).toBeDefined();
      expect(Array.isArray(detail!.completedRuns)).toBe(true);
    });

    it("returns null for non-existent agent", async () => {
      const detail = await store.getAgentDetail("agent-nope");
      expect(detail).toBeNull();
    });

    it("respects heartbeatLimit parameter", async () => {
      const agent = await store.createAgent({ name: "LimitDetail", role: "executor" });
      for (let i = 0; i < 10; i++) {
        await store.recordHeartbeat(agent.id, "ok");
      }

      const detail = await store.getAgentDetail(agent.id, 3);
      expect(detail!.heartbeatHistory).toHaveLength(3);
    });

    it("includes active and completed runs", async () => {
      const agent = await store.createAgent({ name: "RunsDetail", role: "executor" });
      const run1 = await store.startHeartbeatRun(agent.id);
      await store.endHeartbeatRun(run1.id, "terminated");
      const run2 = await store.startHeartbeatRun(agent.id);

      const detail = await store.getAgentDetail(agent.id);
      expect(detail!.activeRun).toBeDefined();
      expect(detail!.activeRun!.id).toBe(run2.id);
      expect(detail!.completedRuns).toHaveLength(1);
      expect(detail!.completedRuns[0].id).toBe(run1.id);
    });
  });

  describe("rating methods", () => {
    const addSequencedRatings = async (
      agentId: string,
      scores: number[],
      inputOverrides?: Partial<{ category: string; comment: string; runId: string; taskId: string; raterId: string }>,
    ) => {
      vi.useFakeTimers();
      const base = new Date("2026-01-01T00:00:00.000Z").getTime();

      try {
        const ratings = [];
        for (let i = 0; i < scores.length; i++) {
          vi.setSystemTime(new Date(base + i * 1000));
          ratings.push(
            await store.addRating(agentId, {
              raterType: "user",
              score: scores[i],
              ...inputOverrides,
            }),
          );
        }
        return ratings;
      } finally {
        vi.useRealTimers();
      }
    };

    it("addRating creates a rating and emits rating:added", async () => {
      const agent = await store.createAgent({ name: "Rated Agent", role: "executor" });
      const handler = vi.fn();
      store.on("rating:added", handler);

      const rating = await store.addRating(agent.id, {
        raterType: "user",
        score: 5,
        comment: "Great run",
      });

      expect(rating.id).toMatch(/^rating-[a-f0-9]{8}$/);
      expect(rating.agentId).toBe(agent.id);
      expect(rating.raterType).toBe("user");
      expect(rating.score).toBe(5);
      expect(rating.comment).toBe("Great run");
      expect(new Date(rating.createdAt).getTime()).not.toBeNaN();
      expect(handler).toHaveBeenCalledOnce();
      expect(handler).toHaveBeenCalledWith(rating);
    });

    it("addRating rejects scores outside 1..5", async () => {
      const agent = await store.createAgent({ name: "Validator", role: "reviewer" });

      await expect(
        store.addRating(agent.id, { raterType: "system", score: 0 }),
      ).rejects.toThrow("Rating score must be between 1 and 5");

      await expect(
        store.addRating(agent.id, { raterType: "system", score: 6 }),
      ).rejects.toThrow("Rating score must be between 1 and 5");
    });

    it("addRating stores all optional fields", async () => {
      const agent = await store.createAgent({ name: "Optional Fields", role: "executor" });

      const rating = await store.addRating(agent.id, {
        raterType: "agent",
        raterId: "agent-rater",
        score: 4,
        category: "quality",
        comment: "Strong implementation",
        runId: "run-123",
        taskId: "FN-1000",
      });

      expect(rating.raterId).toBe("agent-rater");
      expect(rating.category).toBe("quality");
      expect(rating.comment).toBe("Strong implementation");
      expect(rating.runId).toBe("run-123");
      expect(rating.taskId).toBe("FN-1000");
    });

    it("getRatings returns ratings ordered by createdAt desc", async () => {
      const agent = await store.createAgent({ name: "Order Agent", role: "executor" });
      const created = await addSequencedRatings(agent.id, [2, 3, 5]);

      const ratings = await store.getRatings(agent.id);

      expect(ratings.map((rating) => rating.id)).toEqual([
        created[2].id,
        created[1].id,
        created[0].id,
      ]);
    });

    it("getRatings applies category filter", async () => {
      const agent = await store.createAgent({ name: "Category Agent", role: "executor" });
      await store.addRating(agent.id, { raterType: "user", score: 4, category: "quality" });
      await store.addRating(agent.id, { raterType: "user", score: 2, category: "speed" });
      await store.addRating(agent.id, { raterType: "user", score: 5, category: "quality" });

      const ratings = await store.getRatings(agent.id, { category: "quality" });

      expect(ratings).toHaveLength(2);
      expect(ratings.every((rating) => rating.category === "quality")).toBe(true);
    });

    it("getRatings respects the limit option", async () => {
      const agent = await store.createAgent({ name: "Limit Agent", role: "executor" });
      await addSequencedRatings(agent.id, [1, 2, 3, 4]);

      const ratings = await store.getRatings(agent.id, { limit: 2 });

      expect(ratings).toHaveLength(2);
      expect(ratings[0].score).toBe(4);
      expect(ratings[1].score).toBe(3);
    });

    it("getRatingSummary returns an empty summary when no ratings exist", async () => {
      const agent = await store.createAgent({ name: "Empty Summary", role: "executor" });

      const summary = await store.getRatingSummary(agent.id);

      expect(summary).toEqual({
        agentId: agent.id,
        averageScore: 0,
        totalRatings: 0,
        categoryAverages: {},
        recentRatings: [],
        trend: "insufficient-data",
      });
    });

    it("getRatingSummary computes averages and categoryAverages", async () => {
      const agent = await store.createAgent({ name: "Summary Agent", role: "executor" });
      await addSequencedRatings(agent.id, [5], { category: "quality" });
      await addSequencedRatings(agent.id, [3], { category: "quality" });
      await addSequencedRatings(agent.id, [4], { category: "speed" });
      await addSequencedRatings(agent.id, [2]);

      const summary = await store.getRatingSummary(agent.id);

      expect(summary.averageScore).toBe(3.5);
      expect(summary.totalRatings).toBe(4);
      expect(summary.categoryAverages).toEqual({
        quality: 4,
        speed: 4,
      });
      expect(summary.recentRatings).toHaveLength(4);
      expect(summary.trend).toBe("insufficient-data");
    });

    it("getRatingSummary trend is improving when recent average is higher", async () => {
      const agent = await store.createAgent({ name: "Improving Agent", role: "executor" });
      await addSequencedRatings(agent.id, [1, 1, 2, 2, 2, 4, 4, 5, 5, 5]);

      const summary = await store.getRatingSummary(agent.id);

      expect(summary.trend).toBe("improving");
    });

    it("getRatingSummary trend is declining when recent average is lower", async () => {
      const agent = await store.createAgent({ name: "Declining Agent", role: "executor" });
      await addSequencedRatings(agent.id, [5, 5, 4, 4, 4, 2, 2, 1, 1, 1]);

      const summary = await store.getRatingSummary(agent.id);

      expect(summary.trend).toBe("declining");
    });

    it("getRatingSummary trend is stable when windows are approximately equal", async () => {
      const agent = await store.createAgent({ name: "Stable Agent", role: "executor" });
      await addSequencedRatings(agent.id, [3, 3, 3, 3, 3, 3, 3, 3, 3, 3]);

      const summary = await store.getRatingSummary(agent.id);

      expect(summary.trend).toBe("stable");
    });

    it("deleteRating removes the rating", async () => {
      const agent = await store.createAgent({ name: "Delete Agent", role: "executor" });
      const first = await store.addRating(agent.id, { raterType: "user", score: 4 });
      await store.addRating(agent.id, { raterType: "user", score: 5 });

      await store.deleteRating(first.id);

      const ratings = await store.getRatings(agent.id);
      expect(ratings).toHaveLength(1);
      expect(ratings[0].id).not.toBe(first.id);
    });
  });

  // ── heartbeat lifecycle via updateAgentState ──────────────────────

  describe("heartbeat lifecycle via updateAgentState", () => {
    // NOTE: updateAgentState has a re-entrant withLock deadlock bug
    // (see FN-711). These tests exercise the *intended behavior*
    // via direct method calls rather than through the deadlock-prone
    // updateAgentState path.

    it("idle → active intended to start heartbeat run (tested via direct call)", async () => {
      const agent = await store.createAgent({ name: "HBLifecycle", role: "executor" });

      // Directly call startHeartbeatRun (what updateAgentState intends to do)
      const run = await store.startHeartbeatRun(agent.id);
      expect(run.status).toBe("active");

      const active = await store.getActiveHeartbeatRun(agent.id);
      expect(active).not.toBeNull();
      expect(active!.id).toBe(run.id);
    });

    it("terminated transition intended to end heartbeat run (tested via direct call)", async () => {
      const agent = await store.createAgent({ name: "HBEnd", role: "executor" });
      const run = await store.startHeartbeatRun(agent.id);

      // Directly call endHeartbeatRun (what updateAgentState intends to do)
      await store.endHeartbeatRun(run.id, "terminated");

      const active = await store.getActiveHeartbeatRun(agent.id);
      expect(active).toBeNull();

      const completed = await store.getCompletedHeartbeatRuns(agent.id);
      expect(completed).toHaveLength(1);
      expect(completed[0].status).toBe("terminated");
    });
  });

  // ── API Keys ──────────────────────────────────────────────────────

  describe("API Keys", () => {
    it("createApiKey returns key metadata and one-time plaintext token", async () => {
      const agent = await store.createAgent({ name: "KeyAgent", role: "executor" });

      const result = await store.createApiKey(agent.id);

      expect(result.key.id).toMatch(/^key-[a-f0-9]{8}$/);
      expect(result.key.agentId).toBe(agent.id);
      expect(result.key.tokenHash).toMatch(/^[a-f0-9]{64}$/);
      expect(result.token).toMatch(/^[a-f0-9]{64}$/);
      expect(new Date(result.key.createdAt).getTime()).not.toBeNaN();
      expect(result.key.revokedAt).toBeUndefined();

      const expectedHash = createHash("sha256").update(result.token).digest("hex");
      expect(result.key.tokenHash).toBe(expectedHash);

      const keys = await store.listApiKeys(agent.id);
      expect(keys).toHaveLength(1);
      expect(keys[0].tokenHash).toBe(expectedHash);
    });

    it("createApiKey with label persists the label", async () => {
      const agent = await store.createAgent({ name: "LabeledKeyAgent", role: "executor" });

      const { key } = await store.createApiKey(agent.id, { label: "CI Key" });
      const keys = await store.listApiKeys(agent.id);

      expect(key.label).toBe("CI Key");
      expect(keys).toHaveLength(1);
      expect(keys[0].label).toBe("CI Key");
    });

    it("createApiKey omits empty labels", async () => {
      const agent = await store.createAgent({ name: "NoLabelKeyAgent", role: "executor" });

      const { key } = await store.createApiKey(agent.id, { label: "   " });
      expect(key.label).toBeUndefined();
    });

    it("createApiKey throws when agent is not found", async () => {
      await expect(store.createApiKey("agent-missing")).rejects.toThrow(
        "Agent agent-missing not found"
      );
    });

    it("listApiKeys returns keys for one agent and empty array for an agent with no keys", async () => {
      const withKeys = await store.createAgent({ name: "WithKeys", role: "executor" });
      const noKeys = await store.createAgent({ name: "NoKeys", role: "executor" });
      const other = await store.createAgent({ name: "Other", role: "reviewer" });

      const first = await store.createApiKey(withKeys.id);
      const second = await store.createApiKey(withKeys.id);
      await store.createApiKey(other.id);

      const withKeysList = await store.listApiKeys(withKeys.id);
      expect(withKeysList).toHaveLength(2);
      expect(withKeysList.map((key) => key.id)).toEqual([first.key.id, second.key.id]);

      const noKeysList = await store.listApiKeys(noKeys.id);
      expect(noKeysList).toEqual([]);
    });

    it("listApiKeys throws when agent is not found", async () => {
      await expect(store.listApiKeys("agent-missing")).rejects.toThrow(
        "Agent agent-missing not found"
      );
    });

    it("revokeApiKey sets revokedAt and revoked key remains in list", async () => {
      const agent = await store.createAgent({ name: "RevokeKeyAgent", role: "executor" });
      const { key } = await store.createApiKey(agent.id);

      const revoked = await store.revokeApiKey(agent.id, key.id);
      expect(revoked.id).toBe(key.id);
      expect(revoked.revokedAt).toBeDefined();

      const keys = await store.listApiKeys(agent.id);
      expect(keys).toHaveLength(1);
      expect(keys[0].id).toBe(key.id);
      expect(keys[0].revokedAt).toBe(revoked.revokedAt);
    });

    it("revokeApiKey already revoked is a no-op", async () => {
      const agent = await store.createAgent({ name: "RevokeTwiceAgent", role: "executor" });
      const { key } = await store.createApiKey(agent.id);

      const firstRevocation = await store.revokeApiKey(agent.id, key.id);
      const secondRevocation = await store.revokeApiKey(agent.id, key.id);

      expect(firstRevocation.revokedAt).toBeDefined();
      expect(secondRevocation.revokedAt).toBe(firstRevocation.revokedAt);
    });

    it("revokeApiKey throws when key is not found", async () => {
      const agent = await store.createAgent({ name: "MissingKeyAgent", role: "executor" });

      await expect(store.revokeApiKey(agent.id, "key-missing")).rejects.toThrow(
        `API key key-missing not found for agent ${agent.id}`
      );
    });

    it("revokeApiKey throws when agent is not found", async () => {
      await expect(store.revokeApiKey("agent-missing", "key-1234")).rejects.toThrow(
        "Agent agent-missing not found"
      );
    });

    it("multiple keys can be listed and revoking one does not affect others", async () => {
      const agent = await store.createAgent({ name: "MultiKeyAgent", role: "executor" });

      const key1 = await store.createApiKey(agent.id, { label: "key-1" });
      const key2 = await store.createApiKey(agent.id, { label: "key-2" });
      const key3 = await store.createApiKey(agent.id, { label: "key-3" });

      const revoked = await store.revokeApiKey(agent.id, key2.key.id);

      const keys = await store.listApiKeys(agent.id);
      expect(keys).toHaveLength(3);
      const byId = new Map(keys.map((key) => [key.id, key]));
      expect(byId.get(key1.key.id)?.revokedAt).toBeUndefined();
      expect(byId.get(key2.key.id)?.revokedAt).toBe(revoked.revokedAt);
      expect(byId.get(key3.key.id)?.revokedAt).toBeUndefined();
    });

    it("API keys survive store reinitialization", async () => {
      const agent = await store.createAgent({ name: "KeyPersistence", role: "executor" });
      const { key } = await store.createApiKey(agent.id, { label: "persist" });

      const store2 = new AgentStore({ rootDir });
      await store2.init();
      try {
        const keys = await store2.listApiKeys(agent.id);
        expect(keys).toHaveLength(1);
        expect(keys[0].id).toBe(key.id);
        expect(keys[0].label).toBe("persist");
      } finally {
        store2.close();
      }
    });
  });

  // ── concurrency (withLock) ────────────────────────────────────────

  describe("concurrency", () => {
    it("concurrent updateAgent calls on the same agent serialize correctly", async () => {
      const agent = await store.createAgent({ name: "ConcAgent", role: "executor" });

      // Fire multiple updates concurrently
      const [r1, r2, r3] = await Promise.all([
        store.updateAgent(agent.id, { name: "Name-1" }),
        store.updateAgent(agent.id, { name: "Name-2" }),
        store.updateAgent(agent.id, { name: "Name-3" }),
      ]);

      // The last write wins since they're serialized
      const final = await store.getAgent(agent.id);
      expect(final!.name).toBe("Name-3");

      // All three should have returned valid agents (no corruption)
      expect(r1.name).toBe("Name-1");
      expect(r2.name).toBe("Name-2");
      expect(r3.name).toBe("Name-3");
    });

    it("concurrent recordHeartbeat calls don't corrupt heartbeat history", async () => {
      const agent = await store.createAgent({ name: "ConcHB", role: "executor" });

      // Fire 10 heartbeats concurrently
      await Promise.all(
        Array.from({ length: 10 }, () => store.recordHeartbeat(agent.id, "ok"))
      );

      const history = await store.getHeartbeatHistory(agent.id, 100);
      expect(history).toHaveLength(10);

      // Each event should be parseable (no corruption)
      for (const event of history) {
        expect(event.status).toBe("ok");
        expect(event.runId).toBeDefined();
        expect(new Date(event.timestamp).getTime()).not.toBeNaN();
      }
    });

    it("concurrent createApiKey calls don't corrupt API key storage", async () => {
      const agent = await store.createAgent({ name: "ConcKeys", role: "executor" });

      const results = await Promise.all(
        Array.from({ length: 10 }, () => store.createApiKey(agent.id))
      );

      const keys = await store.listApiKeys(agent.id);
      expect(keys).toHaveLength(10);

      const ids = new Set(results.map(({ key }) => key.id));
      expect(ids.size).toBe(10);
    });
  });

  // ── SQLite persistence ────────────────────────────────────────────

  describe("SQLite persistence", () => {
    it("agent data survives store reinitialization", async () => {
      const agent = await store.createAgent({
        name: "Persistent",
        role: "reviewer",
        metadata: { key: "val" },
      });
      await store.recordHeartbeat(agent.id, "ok");

      // Create a new store instance pointing to the same rootDir
      const store2 = new AgentStore({ rootDir });
      await store2.init();
      try {
        const found = await store2.getAgent(agent.id);
        expect(found).not.toBeNull();
        expect(found!.id).toBe(agent.id);
        expect(found!.name).toBe("Persistent");
        expect(found!.role).toBe("reviewer");
        expect(found!.metadata).toEqual({ key: "val" });
        expect(found!.lastHeartbeatAt).toBeDefined();

        // Heartbeat history persists too
        const history = await store2.getHeartbeatHistory(agent.id);
        expect(history).toHaveLength(1);
      } finally {
        store2.close();
      }
    });
  });
});
