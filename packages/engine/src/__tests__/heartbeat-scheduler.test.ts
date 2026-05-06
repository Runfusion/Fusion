/* eslint-disable @typescript-eslint/no-unused-vars */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  HeartbeatMonitor,
  HeartbeatTriggerScheduler,
  type AgentSession,
  type HeartbeatExecutionOptions,
  HEARTBEAT_SYSTEM_PROMPT,
  HEARTBEAT_NO_TASK_SYSTEM_PROMPT,
  HEARTBEAT_PROCEDURE,
  HEARTBEAT_NO_TASK_PROCEDURE,
} from "../agent-heartbeat.js";
import { AgentLogger } from "../agent-logger.js";
import * as agentTools from "../agent-tools.js";
import type { AgentStore, AgentHeartbeatRun, TaskStore, TaskDetail, Agent, MessageStore, Message, AgentBudgetStatus } from "@fusion/core";
import { createMockStore, createMockSession, createMockMessageStore, createMessage, createBudgetStatus } from "./heartbeat-test-helpers.js";
vi.mock("../logger.js", async () => {
  const { createMockLogger, formatMockError } = await import("./heartbeat-test-helpers.js");
  return {
    createLogger: vi.fn(() => createMockLogger()),
    heartbeatLog: createMockLogger(),
    formatError: formatMockError,
  };
});
import { heartbeatLog } from "../logger.js";

describe("HeartbeatTriggerScheduler", () => {
  let store: AgentStore;
  let callback: ReturnType<typeof vi.fn>;
  let scheduler: import("../agent-heartbeat.js").HeartbeatTriggerScheduler;

  beforeEach(() => {
    callback = vi.fn().mockResolvedValue(undefined);
    store = {
      getAgent: vi.fn().mockResolvedValue({
        id: "agent-001",
        name: "Agent 001",
        role: "executor",
        state: "active",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        metadata: {},
      }),
      getActiveHeartbeatRun: vi.fn().mockResolvedValue(null),
      getBudgetStatus: vi.fn().mockResolvedValue(createBudgetStatus()),
      on: vi.fn(),
      off: vi.fn(),
    } as unknown as AgentStore;
  });

  afterEach(() => {
    scheduler?.stop();
    vi.useRealTimers();
  });

  describe("constructor and lifecycle", () => {
    it("starts and stops cleanly", () => {
      scheduler = new HeartbeatTriggerScheduler(store, callback);
      expect(scheduler.isActive()).toBe(false);

      scheduler.start();
      expect(scheduler.isActive()).toBe(true);

      scheduler.stop();
      expect(scheduler.isActive()).toBe(false);
    });

    it("start is idempotent", () => {
      scheduler = new HeartbeatTriggerScheduler(store, callback);
      scheduler.start();
      scheduler.start(); // second call should be no-op
      expect(scheduler.isActive()).toBe(true);
    });

    it("stop is idempotent", () => {
      scheduler = new HeartbeatTriggerScheduler(store, callback);
      scheduler.start();
      scheduler.stop();
      scheduler.stop(); // second call should be no-op
      expect(scheduler.isActive()).toBe(false);
    });
  });

  describe("registerAgent", () => {
    beforeEach(() => {
      scheduler = new HeartbeatTriggerScheduler(store, callback);
      scheduler.start();
    });

    it("registers an agent with timer", () => {
      scheduler.registerAgent("agent-001", { heartbeatIntervalMs: 10000 });
      expect(scheduler.getRegisteredAgents()).toContain("agent-001");
    });

    it("does not register when heartbeat is explicitly disabled", () => {
      scheduler.registerAgent("agent-001", { heartbeatIntervalMs: 10000, enabled: false });
      expect(scheduler.getRegisteredAgents()).not.toContain("agent-001");
    });

    it("applies default 3600-second interval when intervalMs is undefined", async () => {
      vi.useFakeTimers();
      scheduler.registerAgent("agent-001", {});
      expect(scheduler.getRegisteredAgents()).toContain("agent-001");

      // Verify the default 3600-second interval fires
      expect(callback).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(3_600_000);
      expect(callback).toHaveBeenCalledOnce();
      vi.useRealTimers();
    });

    it("applies default 3600-second interval when intervalMs is 0", async () => {
      vi.useFakeTimers();
      scheduler.registerAgent("agent-001", { heartbeatIntervalMs: 0 });
      expect(scheduler.getRegisteredAgents()).toContain("agent-001");

      // Verify the default 3600-second interval fires
      expect(callback).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(3_600_000);
      expect(callback).toHaveBeenCalledOnce();
      vi.useRealTimers();
    });

    it("applies default 3600-second interval when heartbeatIntervalMs is not set", async () => {
      vi.useFakeTimers();
      scheduler.registerAgent("agent-001", { enabled: true });
      expect(scheduler.getRegisteredAgents()).toContain("agent-001");

      // Should fire at exactly 3600 seconds (default interval)
      await vi.advanceTimersByTimeAsync(3_599_999);
      expect(callback).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1); // Now at exactly 3600 seconds
      expect(callback).toHaveBeenCalledOnce();
      expect(callback).toHaveBeenCalledWith("agent-001", "timer", {
        wakeReason: "timer",
        triggerDetail: "scheduled",
        intervalMs: 3_600_000,
      });
      vi.useRealTimers();
    });

    it("uses explicit interval over default when both are provided", async () => {
      vi.useFakeTimers();
      scheduler.registerAgent("agent-001", { heartbeatIntervalMs: 15_000, enabled: true });
      expect(scheduler.getRegisteredAgents()).toContain("agent-001");

      // Should fire at 15 seconds (explicit), not 3600
      await vi.advanceTimersByTimeAsync(14_999);
      expect(callback).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1); // Now at exactly 15 seconds
      expect(callback).toHaveBeenCalledOnce();
      expect(callback).toHaveBeenCalledWith("agent-001", "timer", {
        wakeReason: "timer",
        triggerDetail: "scheduled",
        intervalMs: 15_000,
      });
      vi.useRealTimers();
    });

    it("applies heartbeatMultiplier to timer interval", async () => {
      scheduler.stop();
      const taskStore = {
        getSettings: vi.fn().mockResolvedValue({ heartbeatMultiplier: 0.5 }),
      } as unknown as TaskStore;
      scheduler = new HeartbeatTriggerScheduler(store, callback, taskStore);
      scheduler.start();

      vi.useFakeTimers();
      scheduler.registerAgent("agent-001", { heartbeatIntervalMs: 60_000, enabled: true });
      await Promise.resolve();
      await Promise.resolve();
      expect(taskStore.getSettings).toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(29_999);
      expect(callback).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      expect(callback).toHaveBeenCalledWith("agent-001", "timer", expect.objectContaining({ intervalMs: 30_000 }));
      vi.useRealTimers();
    });

    it("defaults multiplier to 1 when setting is missing", async () => {
      scheduler.stop();
      const taskStore = {
        getSettings: vi.fn().mockResolvedValue({}),
      } as unknown as TaskStore;
      scheduler = new HeartbeatTriggerScheduler(store, callback, taskStore);
      scheduler.start();

      vi.useFakeTimers();
      scheduler.registerAgent("agent-001", { heartbeatIntervalMs: 20_000, enabled: true });
      await Promise.resolve();
      await Promise.resolve();
      expect(taskStore.getSettings).toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(19_999);
      expect(callback).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      expect(callback).toHaveBeenCalledWith("agent-001", "timer", expect.objectContaining({ intervalMs: 20_000 }));
      vi.useRealTimers();
    });

    it("clamps multiplied interval to 1000ms minimum", async () => {
      scheduler.stop();
      const taskStore = {
        getSettings: vi.fn().mockResolvedValue({ heartbeatMultiplier: 0.1 }),
      } as unknown as TaskStore;
      scheduler = new HeartbeatTriggerScheduler(store, callback, taskStore);
      scheduler.start();

      vi.useFakeTimers();
      scheduler.registerAgent("agent-001", { heartbeatIntervalMs: 2_000, enabled: true });
      await Promise.resolve();
      await Promise.resolve();
      expect(taskStore.getSettings).toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(999);
      expect(callback).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      expect(callback).toHaveBeenCalledWith("agent-001", "timer", expect.objectContaining({ intervalMs: 1_000 }));
      vi.useRealTimers();
    });

    it("clears previous timer when re-registering", () => {
      scheduler.registerAgent("agent-001", { heartbeatIntervalMs: 10000 });
      scheduler.registerAgent("agent-001", { heartbeatIntervalMs: 20000 });
      expect(scheduler.getRegisteredAgents()).toHaveLength(1);
      expect(scheduler.getRegisteredAgents()).toContain("agent-001");
    });
  });

  describe("unregisterAgent", () => {
    beforeEach(() => {
      scheduler = new HeartbeatTriggerScheduler(store, callback);
      scheduler.start();
    });

    it("removes a registered agent", () => {
      scheduler.registerAgent("agent-001", { heartbeatIntervalMs: 10000 });
      expect(scheduler.getRegisteredAgents()).toContain("agent-001");

      scheduler.unregisterAgent("agent-001");
      expect(scheduler.getRegisteredAgents()).not.toContain("agent-001");
    });

    it("is no-op for unregistered agent", () => {
      scheduler.unregisterAgent("agent-999");
      expect(scheduler.getRegisteredAgents()).toHaveLength(0);
    });
  });

  describe("timer triggers", () => {
    beforeEach(() => {
      vi.useFakeTimers();
      scheduler = new HeartbeatTriggerScheduler(store, callback);
      scheduler.start();
    });

    it("fires callback at the configured interval", async () => {
      scheduler.registerAgent("agent-001", { heartbeatIntervalMs: 5000 });

      // Advance by one interval and let async callbacks settle
      await vi.advanceTimersByTimeAsync(5000);
      expect(callback).toHaveBeenCalledOnce();
      expect(callback).toHaveBeenCalledWith("agent-001", "timer", {
        wakeReason: "timer",
        triggerDetail: "scheduled",
        intervalMs: 5000,
      });
    });

    it("clamps configured interval to a minimum of 1000ms", async () => {
      scheduler.registerAgent("agent-001", { heartbeatIntervalMs: 10 });

      await vi.advanceTimersByTimeAsync(999);
      expect(callback).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      expect(callback).toHaveBeenCalledOnce();
      expect(callback).toHaveBeenCalledWith("agent-001", "timer", {
        wakeReason: "timer",
        triggerDetail: "scheduled",
        intervalMs: 1000,
      });
    });

    it("fires multiple times for multiple intervals", async () => {
      scheduler.registerAgent("agent-001", { heartbeatIntervalMs: 5000 });

      await vi.advanceTimersByTimeAsync(15000);
      expect(callback).toHaveBeenCalledTimes(3);
    });

    it("does not fire after stop", async () => {
      scheduler.registerAgent("agent-001", { heartbeatIntervalMs: 5000 });

      scheduler.stop();
      await vi.advanceTimersByTimeAsync(10000);
      expect(callback).not.toHaveBeenCalled();
    });

    it("does not fire after unregister", async () => {
      scheduler.registerAgent("agent-001", { heartbeatIntervalMs: 5000 });

      scheduler.unregisterAgent("agent-001");
      await vi.advanceTimersByTimeAsync(10000);
      expect(callback).not.toHaveBeenCalled();
    });

    it("phase-aligns the first tick to lastHeartbeatAt when supplied", async () => {
      // Simulate: last tick was 4s ago, interval is 5s.
      // The next tick is due in 1s, not in a fresh full 5s window.
      vi.setSystemTime(new Date("2026-04-30T05:00:00.000Z"));
      const lastHeartbeatAt = new Date("2026-04-30T04:59:56.000Z").toISOString();

      scheduler.registerAgent(
        "agent-001",
        { heartbeatIntervalMs: 5000 },
        { lastHeartbeatAt },
      );

      await vi.advanceTimersByTimeAsync(999);
      expect(callback).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      expect(callback).toHaveBeenCalledOnce();

      // Subsequent ticks resume the steady cadence.
      await vi.advanceTimersByTimeAsync(5000);
      expect(callback).toHaveBeenCalledTimes(2);
    });

    it("fires promptly with jitter when lastHeartbeatAt is already overdue", async () => {
      // Interval is 60s but the last tick was 10 minutes ago — fire immediately
      // (within the OVERDUE_FIRE_JITTER_MS window) instead of waiting another
      // full 60s. This is the core fix for "agents look unresponsive after a
      // dashboard restart" — the previous setInterval-only scheduler would
      // have made the user wait a full interval before the catch-up tick.
      vi.setSystemTime(new Date("2026-04-30T05:00:00.000Z"));
      const lastHeartbeatAt = new Date("2026-04-30T04:50:00.000Z").toISOString();

      scheduler.registerAgent(
        "agent-001",
        { heartbeatIntervalMs: 60_000 },
        { lastHeartbeatAt },
      );

      // Jitter window is 5s; advance past it to guarantee the fire happens.
      await vi.advanceTimersByTimeAsync(5_000);
      expect(callback).toHaveBeenCalledOnce();
    });

    it("falls back to full-interval delay when lastHeartbeatAt is missing", async () => {
      // No options provided — preserves the original "wait one full interval"
      // behavior for agents that have never ticked.
      scheduler.registerAgent("agent-001", { heartbeatIntervalMs: 5000 });

      await vi.advanceTimersByTimeAsync(4999);
      expect(callback).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      expect(callback).toHaveBeenCalledOnce();
    });

    it("skips tick when agent has active run", async () => {
      (store.getActiveHeartbeatRun as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: "run-active",
        status: "active",
      });

      scheduler.registerAgent("agent-001", { heartbeatIntervalMs: 5000 });

      await vi.advanceTimersByTimeAsync(5000);

      expect(callback).not.toHaveBeenCalled();
    });

    it("skips timer dispatch when global pause is active", async () => {
      scheduler.stop();
      const taskStore = {
        getSettings: vi.fn().mockResolvedValue({ globalPause: true, enginePaused: false }),
      } as unknown as TaskStore;
      scheduler = new HeartbeatTriggerScheduler(store, callback, taskStore);
      scheduler.start();

      scheduler.registerAgent("agent-001", { heartbeatIntervalMs: 5000 });
      await vi.advanceTimersByTimeAsync(5000);

      expect(callback).not.toHaveBeenCalled();
      expect(heartbeatLog.log).toHaveBeenCalledWith("Timer tick skipped for agent-001 (global pause active)");
    });

    it("skips timer dispatch when engine pause is active", async () => {
      scheduler.stop();
      const taskStore = {
        getSettings: vi.fn().mockResolvedValue({ globalPause: false, enginePaused: true }),
      } as unknown as TaskStore;
      scheduler = new HeartbeatTriggerScheduler(store, callback, taskStore);
      scheduler.start();

      scheduler.registerAgent("agent-001", { heartbeatIntervalMs: 5000 });
      await vi.advanceTimersByTimeAsync(5000);

      expect(callback).not.toHaveBeenCalled();
    });

    it("dispatches timer callback when pause flags are false", async () => {
      scheduler.stop();
      const taskStore = {
        getSettings: vi.fn().mockResolvedValue({ globalPause: false, enginePaused: false }),
      } as unknown as TaskStore;
      scheduler = new HeartbeatTriggerScheduler(store, callback, taskStore);
      scheduler.start();

      scheduler.registerAgent("agent-001", { heartbeatIntervalMs: 5000 });
      await vi.advanceTimersByTimeAsync(5000);

      expect(callback).toHaveBeenCalledOnce();
      expect(callback).toHaveBeenCalledWith("agent-001", "timer", {
        wakeReason: "timer",
        triggerDetail: "scheduled",
        intervalMs: 5000,
      });
    });

    it("respects maxConcurrentRuns from config", async () => {
      // Agent with active run should be skipped
      (store.getActiveHeartbeatRun as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: "run-active",
        status: "active",
      });

      scheduler.registerAgent("agent-001", {
        heartbeatIntervalMs: 5000,
        maxConcurrentRuns: 1,
      });

      await vi.advanceTimersByTimeAsync(5000);

      expect(callback).not.toHaveBeenCalled();
    });

    it("dispatches timer callback even when agent is over budget (budget enforcement in executeHeartbeat)", async () => {
      // Budget checks have been moved from the scheduler to executeHeartbeat().
      // The scheduler dispatches the callback so that executeHeartbeat() can create
      // explicit run records with budget_exhausted/budget_threshold_exceeded reasons.
      (store.getBudgetStatus as ReturnType<typeof vi.fn>).mockResolvedValue(
        createBudgetStatus({ isOverBudget: true, isOverThreshold: true, usagePercent: 100 })
      );

      scheduler.registerAgent("agent-001", { heartbeatIntervalMs: 5000 });
      await vi.advanceTimersByTimeAsync(5000);

      // Callback IS called so executeHeartbeat() can create a run record
      expect(callback).toHaveBeenCalledOnce();
      expect(callback).toHaveBeenCalledWith("agent-001", "timer", {
        wakeReason: "timer",
        triggerDetail: "scheduled",
        intervalMs: 5000,
      });
    });

    it("dispatches timer callback even when agent is over threshold (budget enforcement in executeHeartbeat)", async () => {
      // Budget checks have been moved from the scheduler to executeHeartbeat().
      // The scheduler dispatches the callback so that executeHeartbeat() can create
      // explicit run records with budget_exhausted/budget_threshold_exceeded reasons.
      (store.getBudgetStatus as ReturnType<typeof vi.fn>).mockResolvedValue(
        createBudgetStatus({
          budgetLimit: 1000,
          usagePercent: 85,
          thresholdPercent: 80,
          isOverBudget: false,
          isOverThreshold: true,
        })
      );

      scheduler.registerAgent("agent-001", { heartbeatIntervalMs: 5000 });
      await vi.advanceTimersByTimeAsync(5000);

      // Callback IS called so executeHeartbeat() can create a run record
      expect(callback).toHaveBeenCalledOnce();
      expect(callback).toHaveBeenCalledWith("agent-001", "timer", {
        wakeReason: "timer",
        triggerDetail: "scheduled",
        intervalMs: 5000,
      });
    });

    it("fires timer tick normally when below threshold", async () => {
      (store.getBudgetStatus as ReturnType<typeof vi.fn>).mockResolvedValue(
        createBudgetStatus({
          budgetLimit: 1000,
          usagePercent: 30,
          thresholdPercent: 80,
          isOverBudget: false,
          isOverThreshold: false,
        })
      );

      scheduler.registerAgent("agent-001", { heartbeatIntervalMs: 5000 });
      await vi.advanceTimersByTimeAsync(5000);

      expect(callback).toHaveBeenCalledOnce();
    });

    it("fires timer tick when getBudgetStatus throws", async () => {
      (store.getBudgetStatus as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("budget unavailable"));

      scheduler.registerAgent("agent-001", { heartbeatIntervalMs: 5000 });
      await vi.advanceTimersByTimeAsync(5000);

      expect(callback).toHaveBeenCalledOnce();
    });
  });

  describe("stop clears all timers", () => {
    it("clears all registered timers on stop", () => {
      vi.useFakeTimers();

      scheduler = new HeartbeatTriggerScheduler(store, callback);
      scheduler.start();
      scheduler.registerAgent("agent-001", { heartbeatIntervalMs: 5000 });
      scheduler.registerAgent("agent-002", { heartbeatIntervalMs: 10000 });

      expect(scheduler.getRegisteredAgents()).toHaveLength(2);

      scheduler.stop();
      expect(scheduler.getRegisteredAgents()).toHaveLength(0);

      vi.advanceTimersByTime(20000);
      expect(callback).not.toHaveBeenCalled();

      vi.useRealTimers();
    });
  });

  // ── FN-2289 Regression: Idle-state timer persistence ─────────────────────────────────────
  // These tests verify the fix for the defect where agent timers were unintentionally cleared
  // when agents transitioned to "idle" state. The isTickableState() function must include "idle"
  // as a valid state so that timers remain armed for agents between tasks.
  describe("FN-2289: idle-state timer persistence", () => {
    let eventStore: EventEmitter & {
      getAgent: ReturnType<typeof vi.fn>;
      getActiveHeartbeatRun: ReturnType<typeof vi.fn>;
      getBudgetStatus: ReturnType<typeof vi.fn>;
    };

    beforeEach(() => {
      vi.useFakeTimers();

      eventStore = Object.assign(new EventEmitter(), {
        getAgent: vi.fn().mockImplementation((agentId: string) => ({
          id: agentId,
          name: `Agent ${agentId}`,
          role: "executor" as const,
          state: "active" as const,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
          metadata: {},
        })),
        getActiveHeartbeatRun: vi.fn().mockResolvedValue(null),
        getBudgetStatus: vi.fn().mockResolvedValue(createBudgetStatus()),
      });

      scheduler = new HeartbeatTriggerScheduler(eventStore as unknown as AgentStore, callback);
      scheduler.start();
    });

    afterEach(() => {
      scheduler?.stop();
      vi.useRealTimers();
    });

    it("timer remains armed when agent transitions to idle state (regression test for FN-2289)", async () => {
      // Register agent with active state
      scheduler.registerAgent("agent-001", { heartbeatIntervalMs: 5000 });
      expect(scheduler.getRegisteredAgents()).toContain("agent-001");

      // Simulate agent transitioning to idle state
      (eventStore.getAgent as ReturnType<typeof vi.fn>).mockImplementation((agentId: string) => ({
        id: agentId,
        name: `Agent ${agentId}`,
        role: "executor" as const,
        state: "idle" as const, // Agent is now idle
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        metadata: {},
      }));
      eventStore.emit("agent:updated", { id: "agent-001", state: "idle", metadata: {} } as import("@fusion/core").Agent);

      // Timer should still be registered
      expect(scheduler.getRegisteredAgents()).toContain("agent-001");

      // Timer should fire for idle agent
      await vi.advanceTimersByTimeAsync(5000);
      expect(callback).toHaveBeenCalledOnce();
      expect(callback).toHaveBeenCalledWith("agent-001", "timer", {
        wakeReason: "timer",
        triggerDetail: "scheduled",
        intervalMs: 5000,
      });
    });

    it("timer fires correctly for idle agent at scheduled interval", async () => {
      scheduler.registerAgent("agent-001", { heartbeatIntervalMs: 10000 });
      expect(scheduler.getRegisteredAgents()).toContain("agent-001");

      // Update agent to idle state
      (eventStore.getAgent as ReturnType<typeof vi.fn>).mockImplementation((agentId: string) => ({
        id: agentId,
        name: `Agent ${agentId}`,
        role: "executor" as const,
        state: "idle" as const,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        metadata: {},
      }));
      eventStore.emit("agent:updated", { id: "agent-001", state: "idle", metadata: {} } as import("@fusion/core").Agent);

      // Timer should still be armed
      expect(scheduler.getRegisteredAgents()).toContain("agent-001");

      // Advance time and verify multiple fires
      await vi.advanceTimersByTimeAsync(30000);
      expect(callback).toHaveBeenCalledTimes(3);
    });

    it("timer fires for agent transitioning from idle back to active", async () => {
      // Start with idle state
      (eventStore.getAgent as ReturnType<typeof vi.fn>).mockImplementation((agentId: string) => ({
        id: agentId,
        name: `Agent ${agentId}`,
        role: "executor" as const,
        state: "idle" as const,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        metadata: {},
      }));
      scheduler.registerAgent("agent-001", { heartbeatIntervalMs: 5000 });

      // Timer should be armed even for idle agent
      expect(scheduler.getRegisteredAgents()).toContain("agent-001");

      // Advance time - timer should fire
      await vi.advanceTimersByTimeAsync(5000);
      expect(callback).toHaveBeenCalledOnce();
    });

    it("idle agent receives timer trigger with correct context", async () => {
      scheduler.registerAgent("agent-001", { heartbeatIntervalMs: 15000 });

      // Update to idle state
      (eventStore.getAgent as ReturnType<typeof vi.fn>).mockImplementation((agentId: string) => ({
        id: agentId,
        name: `Agent ${agentId}`,
        role: "executor" as const,
        state: "idle" as const,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        metadata: {},
      }));
      eventStore.emit("agent:updated", { id: "agent-001", state: "idle", metadata: {} } as import("@fusion/core").Agent);

      await vi.advanceTimersByTimeAsync(15000);

      expect(callback).toHaveBeenCalledWith("agent-001", "timer", expect.objectContaining({
        wakeReason: "timer",
        triggerDetail: "scheduled",
        intervalMs: 15000,
      }));
    });

    it("timer is still armed after multiple idle state transitions", async () => {
      scheduler.registerAgent("agent-001", { heartbeatIntervalMs: 10000 });

      // First transition to idle
      (eventStore.getAgent as ReturnType<typeof vi.fn>).mockImplementation((agentId: string) => ({
        id: agentId,
        name: `Agent ${agentId}`,
        role: "executor" as const,
        state: "idle" as const,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        metadata: {},
      }));
      eventStore.emit("agent:updated", { id: "agent-001", state: "idle", metadata: {} } as import("@fusion/core").Agent);

      // Second transition (still idle, but emit update)
      eventStore.emit("agent:updated", { id: "agent-001", state: "idle", metadata: {} } as import("@fusion/core").Agent);

      // Third transition back to active
      (eventStore.getAgent as ReturnType<typeof vi.fn>).mockImplementation((agentId: string) => ({
        id: agentId,
        name: `Agent ${agentId}`,
        role: "executor" as const,
        state: "active" as const,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        metadata: {},
      }));
      eventStore.emit("agent:updated", { id: "agent-001", state: "active", metadata: {} } as import("@fusion/core").Agent);

      // Timer should still be registered through all transitions
      expect(scheduler.getRegisteredAgents()).toContain("agent-001");

      // Timer should fire
      await vi.advanceTimersByTimeAsync(10000);
      expect(callback).toHaveBeenCalledOnce();
    });

    it("timer fires for running agent (pre-existing behavior)", async () => {
      scheduler.registerAgent("agent-001", { heartbeatIntervalMs: 5000 });

      // Update to running state
      (eventStore.getAgent as ReturnType<typeof vi.fn>).mockImplementation((agentId: string) => ({
        id: agentId,
        name: `Agent ${agentId}`,
        role: "executor" as const,
        state: "running" as const,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        metadata: {},
      }));
      eventStore.emit("agent:updated", { id: "agent-001", state: "running", metadata: {} } as import("@fusion/core").Agent);

      expect(scheduler.getRegisteredAgents()).toContain("agent-001");

      await vi.advanceTimersByTimeAsync(5000);
      expect(callback).toHaveBeenCalledOnce();
    });

    it("timer is unregistered when agent becomes terminated (should clear timer)", async () => {
      scheduler.registerAgent("agent-001", { heartbeatIntervalMs: 5000 });
      expect(scheduler.getRegisteredAgents()).toContain("agent-001");

      // Update to terminated state
      (eventStore.getAgent as ReturnType<typeof vi.fn>).mockImplementation((agentId: string) => ({
        id: agentId,
        name: `Agent ${agentId}`,
        role: "executor" as const,
        state: "paused" as const,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        metadata: {},
      }));
      eventStore.emit("agent:updated", { id: "agent-001", state: "paused", metadata: {} } as import("@fusion/core").Agent);

      // Timer should be cleared for terminated agents
      expect(scheduler.getRegisteredAgents()).not.toContain("agent-001");

      await vi.advanceTimersByTimeAsync(10000);
      expect(callback).not.toHaveBeenCalled();
    });

    it("timer is unregistered when agent becomes error state (should clear timer)", async () => {
      scheduler.registerAgent("agent-001", { heartbeatIntervalMs: 5000 });
      expect(scheduler.getRegisteredAgents()).toContain("agent-001");

      // Update to error state
      (eventStore.getAgent as ReturnType<typeof vi.fn>).mockImplementation((agentId: string) => ({
        id: agentId,
        name: `Agent ${agentId}`,
        role: "executor" as const,
        state: "error" as const,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        metadata: {},
      }));
      eventStore.emit("agent:updated", { id: "agent-001", state: "error", metadata: {} } as import("@fusion/core").Agent);

      // Timer should be cleared for error agents
      expect(scheduler.getRegisteredAgents()).not.toContain("agent-001");

      await vi.advanceTimersByTimeAsync(10000);
      expect(callback).not.toHaveBeenCalled();
    });

    it("timer is unregistered when agent becomes paused state (should clear timer)", async () => {
      scheduler.registerAgent("agent-001", { heartbeatIntervalMs: 5000 });
      expect(scheduler.getRegisteredAgents()).toContain("agent-001");

      // Update to paused state
      (eventStore.getAgent as ReturnType<typeof vi.fn>).mockImplementation((agentId: string) => ({
        id: agentId,
        name: `Agent ${agentId}`,
        role: "executor" as const,
        state: "paused" as const,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        metadata: {},
      }));
      eventStore.emit("agent:updated", { id: "agent-001", state: "paused", metadata: {} } as import("@fusion/core").Agent);

      // Timer should be cleared for paused agents
      expect(scheduler.getRegisteredAgents()).not.toContain("agent-001");

      await vi.advanceTimersByTimeAsync(10000);
      expect(callback).not.toHaveBeenCalled();
    });
  });

  // ── FN-2289 Regression: Multiplier stability across re-registration ─────────────────────
  describe("FN-2289: multiplier stability across re-registration", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      scheduler?.stop();
      vi.useRealTimers();
    });

    it("multiplier-adjusted interval remains stable when re-registering", async () => {
      const taskStore = {
        getSettings: vi.fn().mockResolvedValue({ heartbeatMultiplier: 0.5 }),
      } as unknown as TaskStore;

      scheduler = new HeartbeatTriggerScheduler(store, callback, taskStore);
      scheduler.start();

      // First registration with multiplier 0.5 -> effective interval 5000ms
      scheduler.registerAgent("agent-001", { heartbeatIntervalMs: 10000 });
      await vi.advanceTimersByTimeAsync(100); // Allow pending async operations to complete

      // Re-register (simulating settings change or config update)
      scheduler.registerAgent("agent-001", { heartbeatIntervalMs: 10000 });
      await vi.advanceTimersByTimeAsync(100);

      // Timer should still fire at the multiplied interval (5000ms)
      // The timer was set up immediately, so we need to ensure we advance past 5000ms total
      await vi.advanceTimersByTimeAsync(5000);
      expect(callback).toHaveBeenCalledOnce();
    });

    it("async multiplier registration does not stale-overwrite newer registration", async () => {
      const taskStore = {
        getSettings: vi.fn().mockResolvedValue({ heartbeatMultiplier: 2.0 }),
      } as unknown as TaskStore;

      scheduler = new HeartbeatTriggerScheduler(store, callback, taskStore);
      scheduler.start();

      // Register with multiplier 2.0 -> effective interval 20000ms
      scheduler.registerAgent("agent-001", { heartbeatIntervalMs: 10000 });
      await Promise.resolve();

      // Immediately re-register before async multiplier completes
      scheduler.registerAgent("agent-001", { heartbeatIntervalMs: 10000 });

      // Timer should still be registered
      expect(scheduler.getRegisteredAgents()).toContain("agent-001");

      // Advance time past the original interval (10s) but before multiplied (20s)
      // If stale-overwrite happens, callback would be called at 10s instead of 20s
      await vi.advanceTimersByTimeAsync(15000);
      expect(callback).not.toHaveBeenCalled();

      // Timer should fire at 20s (correct multiplied interval)
      await vi.advanceTimersByTimeAsync(5000);
      expect(callback).toHaveBeenCalledOnce();
    });
  });

  describe("assignment watching", () => {
    let eventStore: EventEmitter & {
      getActiveHeartbeatRun: ReturnType<typeof vi.fn>;
      getBudgetStatus: ReturnType<typeof vi.fn>;
      getRecentRuns: ReturnType<typeof vi.fn>;
    };

    beforeEach(() => {
      vi.useRealTimers(); // Ensure real timers for these tests

      eventStore = Object.assign(new EventEmitter(), {
        getActiveHeartbeatRun: vi.fn().mockResolvedValue(null),
        getBudgetStatus: vi.fn().mockRejectedValue(new Error("budget status unavailable")),
        getRecentRuns: vi.fn().mockResolvedValue([]),
      });

      scheduler = new HeartbeatTriggerScheduler(eventStore as unknown as AgentStore, callback);
      scheduler.start();
    }, 30000);

    afterEach(() => {
      scheduler?.stop();
    });

    it("triggers callback on agent:assigned event", async () => {
      const agent = { id: "agent-test", name: "Test", state: "active", metadata: {}, taskId: "FN-001" } as import("@fusion/core").Agent;

      eventStore.emit("agent:assigned", agent, "FN-001");

      // Allow asynchronous assignment listeners to run in heavily loaded test environments.
      await vi.waitFor(() => {
        expect(callback).toHaveBeenCalledOnce();
      }, { timeout: 1000 });

      expect(callback).toHaveBeenCalledWith("agent-test", "assignment", {
        taskId: "FN-001",
        wakeReason: "assignment",
        triggerDetail: "task-assigned",
      });
    });

    it("does NOT trigger when stopped", async () => {
      scheduler.stop();

      const agent = { id: "agent-test", name: "Test" } as import("@fusion/core").Agent;
      eventStore.emit("agent:assigned", agent, "FN-002");

      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(callback).not.toHaveBeenCalled();
    });

    it("skips trigger when agent heartbeat is disabled", async () => {
      const agent: import("@fusion/core").Agent = {
        id: "agent-test",
        name: "executor-FN-1661",
        role: "executor",
        state: "active",
        taskId: "FN-1661",
        metadata: {},
        runtimeConfig: { enabled: false },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      eventStore.emit("agent:assigned", agent, "FN-1661");

      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(callback).not.toHaveBeenCalled();
      expect(eventStore.getActiveHeartbeatRun).not.toHaveBeenCalled();
    });

    it("skips trigger when agent has active run", async () => {
      (eventStore.getActiveHeartbeatRun as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: "run-active",
        status: "active",
      });

      const agent = { id: "agent-test", name: "Test" } as import("@fusion/core").Agent;
      eventStore.emit("agent:assigned", agent, "FN-003");

      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(callback).not.toHaveBeenCalled();
    });

    it("blocks assignment trigger when agent is over budget", async () => {
      (eventStore as any).getBudgetStatus = vi.fn().mockResolvedValue(
        createBudgetStatus({
          agentId: "agent-test",
          isOverBudget: true,
          isOverThreshold: true,
          usagePercent: 100,
          budgetLimit: 1000,
          thresholdPercent: 80,
        })
      );

      const agent = { id: "agent-test", name: "Test" } as import("@fusion/core").Agent;
      eventStore.emit("agent:assigned", agent, "FN-003");

      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(callback).not.toHaveBeenCalled();
    });

    it("allows assignment trigger when agent is over threshold", async () => {
      const budgetStatus = createBudgetStatus({
        agentId: "agent-test",
        budgetLimit: 1000,
        usagePercent: 85,
        thresholdPercent: 80,
        isOverBudget: false,
        isOverThreshold: true,
      });
      (eventStore as any).getBudgetStatus = vi.fn().mockResolvedValue(budgetStatus);

      const agent = { id: "agent-test", name: "Test", state: "active", metadata: {} } as import("@fusion/core").Agent;
      eventStore.emit("agent:assigned", agent, "FN-003");

      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(callback).toHaveBeenCalledOnce();
      expect(callback).toHaveBeenCalledWith("agent-test", "assignment", {
        taskId: "FN-003",
        wakeReason: "assignment",
        triggerDetail: "task-assigned",
        budgetStatus,
      });
    });

    it("passes budgetStatus in WakeContext for assignment triggers", async () => {
      const budgetStatus = createBudgetStatus({
        agentId: "agent-test",
        budgetLimit: 1000,
        usagePercent: 45,
        thresholdPercent: 80,
      });
      (eventStore as any).getBudgetStatus = vi.fn().mockResolvedValue(budgetStatus);

      const agent = { id: "agent-test", name: "Test", state: "active", metadata: {} } as import("@fusion/core").Agent;
      eventStore.emit("agent:assigned", agent, "FN-005");

      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(callback).toHaveBeenCalledWith(
        "agent-test",
        "assignment",
        expect.objectContaining({
          taskId: "FN-005",
          budgetStatus,
        }),
      );
    });

    it("includes new steering comment IDs for assignment wakes when taskStore is available", async () => {
      scheduler.stop();

      (eventStore as any).getRecentRuns = vi.fn().mockResolvedValue([
        { startedAt: "2026-01-01T00:00:00.000Z" },
      ]);

      const assignmentTaskStore = {
        getTask: vi.fn().mockResolvedValue({
          id: "FN-006",
          steeringComments: [
            { id: "steer-old", text: "older", author: "user", createdAt: "2025-12-31T23:00:00.000Z" },
            { id: "steer-new", text: "new guidance", author: "user", createdAt: "2026-01-01T01:00:00.000Z" },
          ],
        }),
      } as unknown as TaskStore;

      scheduler = new HeartbeatTriggerScheduler(eventStore as unknown as AgentStore, callback, assignmentTaskStore);
      scheduler.start();

      const agent = { id: "agent-test", name: "Test", state: "active", metadata: {} } as import("@fusion/core").Agent;
      eventStore.emit("agent:assigned", agent, "FN-006");

      await vi.waitFor(() => {
        expect(callback).toHaveBeenCalledOnce();
      }, { timeout: 1000 });

      expect(callback).toHaveBeenCalledWith("agent-test", "assignment", expect.objectContaining({
        taskId: "FN-006",
        triggeringCommentIds: ["steer-new"],
        triggeringCommentType: "steering",
      }));
    });

    it("cleans up listener on unwatch", async () => {
      scheduler.unwatchAssignments();

      const agent = { id: "agent-test", name: "Test" } as import("@fusion/core").Agent;
      eventStore.emit("agent:assigned", agent, "FN-004");

      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(callback).not.toHaveBeenCalled();
    });
  });

  describe("Run context propagation", () => {
    it("createHeartbeatTools passes runContext to taskStore.logEntry", async () => {
      // Create a minimal mock TaskStore
      const mockTaskStore = {
        createTask: vi.fn().mockResolvedValue({ id: "FN-NEW", description: "New task" }),
        logEntry: vi.fn().mockResolvedValue({}),
        getTask: vi.fn().mockResolvedValue({
          id: "FN-001",
          description: "Test task",
          column: "todo",
          log: [],
        }),
      } as unknown as import("@fusion/core").TaskStore;

      const monitor = new HeartbeatMonitor({
        store,
        taskStore: mockTaskStore,
        rootDir: "/tmp",
      });

      const runContext = { runId: "run-123", agentId: "agent-456", source: "timer" };

      // Create tools with run context
      const tools = monitor.createHeartbeatTools("agent-456", mockTaskStore, "FN-001", runContext);

      // Find the fn_task_log tool and execute it
      const taskLogTool = tools.find(t => t.name === "fn_task_log");
      expect(taskLogTool).toBeDefined();

      const result = await taskLogTool!.execute("call-1", { message: "Test log entry", outcome: undefined }, undefined as any, undefined as any, undefined as any);

      // Verify logEntry was called with runContext
      expect(mockTaskStore.logEntry).toHaveBeenCalledWith(
        "FN-001",
        "Test log entry",
        undefined,
        runContext,
      );
    });

    it("createHeartbeatTools tracks task creations with runContext", async () => {
      // Create a minimal mock TaskStore
      const mockTaskStore = {
        createTask: vi.fn().mockResolvedValue({ id: "FN-200", description: "New task created", dependencies: [] }),
        logEntry: vi.fn().mockResolvedValue({}),
        getTask: vi.fn().mockResolvedValue({
          id: "FN-001",
          description: "Test task",
          column: "todo",
          log: [],
        }),
      } as unknown as import("@fusion/core").TaskStore;

      const monitor = new HeartbeatMonitor({
        store,
        taskStore: mockTaskStore,
        rootDir: "/tmp",
      });

      const runContext = { runId: "run-789", agentId: "agent-abc", source: "on_demand" };

      // Create tools with run context
      const tools = monitor.createHeartbeatTools("agent-abc", mockTaskStore, "FN-001", runContext);

      // Find the fn_task_create tool and execute it
      const taskCreateTool = tools.find(t => t.name === "fn_task_create");
      expect(taskCreateTool).toBeDefined();

      const result = await taskCreateTool!.execute("call-1", { description: "New task created" }, undefined as any, undefined as any, undefined as any);

      // Verify logEntry was called with runContext for the created task
      expect(mockTaskStore.logEntry).toHaveBeenCalledWith(
        "FN-200",
        "Created by agent agent-abc during heartbeat run",
        undefined,
        runContext,
      );
    });

    it("createHeartbeatTools works without runContext (backward compat)", async () => {
      // Create a minimal mock TaskStore
      const mockTaskStore = {
        createTask: vi.fn().mockResolvedValue({ id: "FN-NEW", description: "New task" }),
        logEntry: vi.fn().mockResolvedValue({}),
        getTask: vi.fn().mockResolvedValue({
          id: "FN-001",
          description: "Test task",
          column: "todo",
          log: [],
        }),
      } as unknown as import("@fusion/core").TaskStore;

      const monitor = new HeartbeatMonitor({
        store,
        taskStore: mockTaskStore,
        rootDir: "/tmp",
      });

      // Create tools without run context
      const tools = monitor.createHeartbeatTools("agent-456", mockTaskStore, "FN-001");

      // Find the fn_task_log tool and execute it
      const taskLogTool = tools.find(t => t.name === "fn_task_log");
      expect(taskLogTool).toBeDefined();

      const result = await taskLogTool!.execute("call-1", { message: "Test log entry", outcome: undefined }, undefined as any, undefined as any, undefined as any);

      // Verify logEntry was called without runContext
      expect(mockTaskStore.logEntry).toHaveBeenCalledWith(
        "FN-001",
        "Test log entry",
        undefined,
        undefined,
      );
    });
  });

  describe("allowParallelExecution gate", () => {
    function makeAgentWithConfig(overrides: Record<string, unknown> = {}) {
      return {
        id: "agent-par",
        name: "Parallel Agent",
        role: "executor",
        state: "active",
        taskId: "FN-TASK-1",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        metadata: {},
        runtimeConfig: overrides,
      };
    }

    it("timer tick skips when allowParallelExecution=false and task is executing", async () => {
      vi.useFakeTimers();
      const isTaskExecuting = vi.fn().mockReturnValue(true);

      const parallelStore = {
        getAgent: vi.fn().mockResolvedValue(makeAgentWithConfig({ allowParallelExecution: false })),
        getActiveHeartbeatRun: vi.fn().mockResolvedValue(null),
        getBudgetStatus: vi.fn().mockResolvedValue(createBudgetStatus()),
        on: vi.fn(),
        off: vi.fn(),
      } as unknown as AgentStore;

      scheduler = new HeartbeatTriggerScheduler(parallelStore, callback, undefined, { isTaskExecuting });
      scheduler.start();
      scheduler.registerAgent("agent-par", { heartbeatIntervalMs: 1000 });

      await vi.advanceTimersByTimeAsync(1100);

      expect(callback).not.toHaveBeenCalled();
      expect(isTaskExecuting).toHaveBeenCalledWith("FN-TASK-1");
    });

    it("timer tick fires when allowParallelExecution=false and task is NOT executing", async () => {
      vi.useFakeTimers();
      const isTaskExecuting = vi.fn().mockReturnValue(false);

      const parallelStore = {
        getAgent: vi.fn().mockResolvedValue(makeAgentWithConfig({ allowParallelExecution: false })),
        getActiveHeartbeatRun: vi.fn().mockResolvedValue(null),
        getBudgetStatus: vi.fn().mockResolvedValue(createBudgetStatus()),
        on: vi.fn(),
        off: vi.fn(),
      } as unknown as AgentStore;

      scheduler = new HeartbeatTriggerScheduler(parallelStore, callback, undefined, { isTaskExecuting });
      scheduler.start();
      scheduler.registerAgent("agent-par", { heartbeatIntervalMs: 1000 });

      await vi.advanceTimersByTimeAsync(1100);

      expect(callback).toHaveBeenCalledOnce();
    });

    it("timer tick fires when allowParallelExecution=true even while task is executing", async () => {
      vi.useFakeTimers();
      const isTaskExecuting = vi.fn().mockReturnValue(true);

      const parallelStore = {
        getAgent: vi.fn().mockResolvedValue(makeAgentWithConfig({ allowParallelExecution: true })),
        getActiveHeartbeatRun: vi.fn().mockResolvedValue(null),
        getBudgetStatus: vi.fn().mockResolvedValue(createBudgetStatus()),
        on: vi.fn(),
        off: vi.fn(),
      } as unknown as AgentStore;

      scheduler = new HeartbeatTriggerScheduler(parallelStore, callback, undefined, { isTaskExecuting });
      scheduler.start();
      scheduler.registerAgent("agent-par", { heartbeatIntervalMs: 1000 });

      await vi.advanceTimersByTimeAsync(1100);

      expect(callback).toHaveBeenCalledOnce();
    });

    it("timer tick fires when allowParallelExecution is unset (default) even while task is executing", async () => {
      vi.useFakeTimers();
      const isTaskExecuting = vi.fn().mockReturnValue(true);

      const parallelStore = {
        getAgent: vi.fn().mockResolvedValue(makeAgentWithConfig({})),
        getActiveHeartbeatRun: vi.fn().mockResolvedValue(null),
        getBudgetStatus: vi.fn().mockResolvedValue(createBudgetStatus()),
        on: vi.fn(),
        off: vi.fn(),
      } as unknown as AgentStore;

      scheduler = new HeartbeatTriggerScheduler(parallelStore, callback, undefined, { isTaskExecuting });
      scheduler.start();
      scheduler.registerAgent("agent-par", { heartbeatIntervalMs: 1000 });

      await vi.advanceTimersByTimeAsync(1100);

      expect(callback).toHaveBeenCalledOnce();
    });
  });
});

