/**
 * Tests for AgentStore — filesystem-based agent lifecycle management.
 *
 * Covers every public method: init, createAgent, getAgent, getAgentDetail,
 * updateAgent, updateAgentState, assignTask, listAgents, deleteAgent,
 * recordHeartbeat, getHeartbeatHistory, startHeartbeatRun, endHeartbeatRun,
 * getActiveHeartbeatRun, getCompletedHeartbeatRuns.
 *
 * Also tests event emissions (agent:created, agent:updated, agent:deleted,
 * agent:heartbeat, agent:stateChanged), error paths, state transition
 * validation, concurrency locking, and filesystem persistence.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { AgentStore } from "./agent-store.js";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { mkdtempSync, existsSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import type { AgentCapability, AgentState } from "./types.js";

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "kb-agent-store-test-"));
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
    await rm(rootDir, { recursive: true, force: true });
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

    it("also removes heartbeat file if present", async () => {
      const created = await store.createAgent({
        name: "With HB",
        role: "executor",
      });

      // Record a heartbeat to create the file
      await store.recordHeartbeat(created.id, "ok");

      const hbPath = join(rootDir, "agents", `${created.id}-heartbeats.jsonl`);
      expect(existsSync(hbPath)).toBe(true);

      await store.deleteAgent(created.id);
      expect(existsSync(hbPath)).toBe(false);
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

    it("skips corrupted JSON files without throwing", async () => {
      await store.createAgent({ name: "Valid", role: "executor" });

      // Write a corrupted file
      const corruptPath = join(rootDir, "agents", "agent-corrupt.json");
      writeFileSync(corruptPath, "not-valid-json{{{");

      const agents = await store.listAgents();
      expect(agents).toHaveLength(1);
      expect(agents[0].name).toBe("Valid");
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
    });

    it("throws for non-existent agent", async () => {
      await expect(
        store.resetAgent("agent-ghost")
      ).rejects.toThrow("Agent agent-ghost not found");
    });
  });

  // ── recordHeartbeat ───────────────────────────────────────────────

  describe("recordHeartbeat", () => {
    it("appends to the heartbeats JSONL file", async () => {
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

    it("endHeartbeatRun with 'completed' records an ok heartbeat", async () => {
      const agent = await store.createAgent({ name: "CompleteRun", role: "executor" });
      const run = await store.startHeartbeatRun(agent.id);

      await store.endHeartbeatRun(run.id, "completed");

      // A completed run records status "ok" (not "missed"), so the run
      // stays active in the reconstructed view (implementation detail).
      // The getActiveHeartbeatRun still sees it as active since only
      // "missed" status marks a run as terminated.
      const active = await store.getActiveHeartbeatRun(agent.id);
      expect(active).not.toBeNull();
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

      const keyPath = join(rootDir, "agents", `${agent.id}-keys.jsonl`);
      expect(existsSync(keyPath)).toBe(true);
      const persisted = readFileSync(keyPath, "utf-8");
      expect(persisted).not.toContain(result.token);
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

      const keys = await store2.listApiKeys(agent.id);
      expect(keys).toHaveLength(1);
      expect(keys[0].id).toBe(key.id);
      expect(keys[0].label).toBe("persist");
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

    it("concurrent recordHeartbeat calls don't corrupt the JSONL file", async () => {
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

    it("concurrent createApiKey calls don't corrupt the JSONL file", async () => {
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

  // ── filesystem persistence ────────────────────────────────────────

  describe("filesystem persistence", () => {
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
    });
  });
});
