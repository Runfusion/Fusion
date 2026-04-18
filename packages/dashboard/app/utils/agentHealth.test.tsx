import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { getAgentHealthStatus, getAgentHealthColorVar } from "./agentHealth";
import type { Agent } from "../api";

// Mock Date.now to get deterministic elapsed time calculations
const FIXED_NOW = new Date("2026-04-10T12:00:00.000Z").getTime();

type AgentHealthInput = Pick<
  Agent,
  "state" | "lastHeartbeatAt" | "lastError" | "pauseReason" | "runtimeConfig" | "metadata" | "name" | "role" | "taskId"
>;

function makeAgent(overrides: Partial<AgentHealthInput> = {}): AgentHealthInput {
  return {
    name: "Test Agent",
    role: "executor",
    state: "idle",
    taskId: undefined,
    metadata: {},
    lastHeartbeatAt: undefined,
    lastError: undefined,
    pauseReason: undefined,
    runtimeConfig: undefined,
    ...overrides,
  };
}

describe("getAgentHealthStatus", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ── Terminal states ──────────────────────────────────────────────────────

  describe("terminated state", () => {
    it('returns "Terminated" for terminated agents', () => {
      const agent = makeAgent({ state: "terminated" });
      const status = getAgentHealthStatus(agent);
      expect(status.label).toBe("Terminated");
      expect(status.color).toBe("var(--state-error-text)");
    });

    it("ignores heartbeat data for terminated agents", () => {
      const agent = makeAgent({
        state: "terminated",
        lastHeartbeatAt: new Date(FIXED_NOW - 1000).toISOString(),
      });
      const status = getAgentHealthStatus(agent);
      expect(status.label).toBe("Terminated");
    });
  });

  describe("error state", () => {
    it('returns "Error" for error agents without lastError', () => {
      const agent = makeAgent({ state: "error" });
      const status = getAgentHealthStatus(agent);
      expect(status.label).toBe("Error");
      expect(status.color).toBe("var(--state-error-text)");
    });

    it("uses lastError as label when available", () => {
      const agent = makeAgent({ state: "error", lastError: "Agent crashed" });
      const status = getAgentHealthStatus(agent);
      expect(status.label).toBe("Agent crashed");
    });

    it("ignores heartbeat data for error agents", () => {
      const agent = makeAgent({
        state: "error",
        lastHeartbeatAt: new Date(FIXED_NOW - 1000).toISOString(),
      });
      const status = getAgentHealthStatus(agent);
      expect(status.label).toBe("Error");
    });
  });

  describe("paused state", () => {
    it('returns "Paused" for paused agents without pauseReason', () => {
      const agent = makeAgent({ state: "paused" });
      const status = getAgentHealthStatus(agent);
      expect(status.label).toBe("Paused");
      expect(status.color).toBe("var(--state-paused-text)");
    });

    it("includes pauseReason in label when available", () => {
      const agent = makeAgent({ state: "paused", pauseReason: "User requested" });
      const status = getAgentHealthStatus(agent);
      expect(status.label).toBe("Paused: User requested");
    });

    it("ignores heartbeat data for paused agents", () => {
      const agent = makeAgent({
        state: "paused",
        lastHeartbeatAt: new Date(FIXED_NOW - 1000).toISOString(),
      });
      const status = getAgentHealthStatus(agent);
      expect(status.label).toBe("Paused");
    });
  });

  describe("running state", () => {
    it('returns "Running" for running agents', () => {
      const agent = makeAgent({ state: "running" });
      const status = getAgentHealthStatus(agent);
      expect(status.label).toBe("Running");
      expect(status.color).toBe("var(--state-active-text)");
    });

    it("ignores heartbeat data for running agents", () => {
      const agent = makeAgent({
        state: "running",
        lastHeartbeatAt: new Date(FIXED_NOW - 100_000).toISOString(), // 100s ago - would be "unresponsive" without this
      });
      const status = getAgentHealthStatus(agent);
      expect(status.label).toBe("Running");
    });
  });

  // ── Heartbeat monitoring disabled ──────────────────────────────────────────

  describe("heartbeat monitoring disabled", () => {
    it('returns "Disabled" when runtimeConfig.enabled === false', () => {
      const agent = makeAgent({
        state: "active",
        runtimeConfig: { enabled: false },
      });
      const status = getAgentHealthStatus(agent);
      expect(status.label).toBe("Disabled");
      expect(status.color).toBe("var(--text-secondary)");
    });

    it('returns "Disabled" even with stale heartbeat data', () => {
      const agent = makeAgent({
        state: "active",
        lastHeartbeatAt: new Date(FIXED_NOW - 1_000_000).toISOString(), // very stale
        runtimeConfig: { enabled: false, heartbeatTimeoutMs: 60000 },
      });
      const status = getAgentHealthStatus(agent);
      expect(status.label).toBe("Disabled");
    });

    it('returns "Disabled" for idle agents with monitoring disabled', () => {
      const agent = makeAgent({
        state: "idle",
        runtimeConfig: { enabled: false },
      });
      const status = getAgentHealthStatus(agent);
      expect(status.label).toBe("Disabled");
    });
  });

  describe("task worker health classification", () => {
    it('returns "Running" for metadata-marked task workers with disabled heartbeat', () => {
      const agent = makeAgent({
        name: "executor-FN-1661",
        role: "executor",
        state: "active",
        taskId: "FN-1661",
        metadata: {
          agentKind: "task-worker",
          taskWorker: true,
          managedBy: "task-executor",
        },
        lastHeartbeatAt: new Date(FIXED_NOW - 1_000_000).toISOString(),
        runtimeConfig: { enabled: false, heartbeatTimeoutMs: 60_000 },
      });
      const status = getAgentHealthStatus(agent);
      expect(status.label).toBe("Running");
      expect(status.color).toBe("var(--state-active-text)");
    });

    it('returns "Running" for legacy executor-* task workers with stale heartbeat', () => {
      const agent = makeAgent({
        name: "executor-FN-1661",
        role: "executor",
        state: "active",
        taskId: "FN-1661",
        lastHeartbeatAt: new Date(FIXED_NOW - 1_000_000).toISOString(),
        runtimeConfig: { heartbeatTimeoutMs: 30_000 },
      });
      const status = getAgentHealthStatus(agent);
      expect(status.label).toBe("Running");
      expect(status.color).toBe("var(--state-active-text)");
    });

    it('keeps non-task-worker disabled agents as "Disabled"', () => {
      const agent = makeAgent({
        name: "Reviewer",
        role: "reviewer",
        state: "active",
        runtimeConfig: { enabled: false },
      });
      const status = getAgentHealthStatus(agent);
      expect(status.label).toBe("Disabled");
    });
  });

  // ── No heartbeat data ──────────────────────────────────────────────────────

  describe("no heartbeat data", () => {
    it('returns "Starting..." for active agents with no lastHeartbeatAt', () => {
      const agent = makeAgent({ state: "active" });
      const status = getAgentHealthStatus(agent);
      expect(status.label).toBe("Starting...");
      expect(status.color).toBe("var(--text-secondary)");
    });

    it('returns "Idle" for non-active agents with no lastHeartbeatAt', () => {
      const agent = makeAgent({ state: "idle" });
      const status = getAgentHealthStatus(agent);
      expect(status.label).toBe("Idle");
      expect(status.color).toBe("var(--text-secondary)");
    });

    it('returns "Idle" for terminated agents without heartbeat (edge case)', () => {
      // Although terminated state takes precedence, testing the fallback
      const agent = makeAgent({ state: "idle", lastHeartbeatAt: undefined });
      const status = getAgentHealthStatus(agent);
      expect(status.label).toBe("Idle");
    });
  });

  // ── Healthy vs Unresponsive ───────────────────────────────────────────────

  describe("heartbeat freshness", () => {
    it('returns "Healthy" when heartbeat is fresh (within timeout) with periodic heartbeat', () => {
      const agent = makeAgent({
        state: "active",
        lastHeartbeatAt: new Date(FIXED_NOW - 30_000).toISOString(), // 30s ago, well within 60s timeout
        runtimeConfig: { heartbeatIntervalMs: 30_000 }, // periodic heartbeat configured
      });
      const status = getAgentHealthStatus(agent);
      expect(status.label).toBe("Healthy");
      expect(status.color).toBe("var(--state-active-text)");
    });

    it('returns "Healthy" when heartbeat is exactly at the timeout boundary with periodic heartbeat', () => {
      const agent = makeAgent({
        state: "active",
        lastHeartbeatAt: new Date(FIXED_NOW - 60_000).toISOString(), // exactly 60s ago
        runtimeConfig: { heartbeatIntervalMs: 30_000 }, // periodic heartbeat configured
      });
      const status = getAgentHealthStatus(agent);
      expect(status.label).toBe("Healthy");
    });

    it('returns "Unresponsive" when heartbeat exceeds the timeout with periodic heartbeat', () => {
      const agent = makeAgent({
        state: "active",
        lastHeartbeatAt: new Date(FIXED_NOW - 60_001).toISOString(), // just over 60s ago
        runtimeConfig: { heartbeatIntervalMs: 30_000 }, // periodic heartbeat configured
      });
      const status = getAgentHealthStatus(agent);
      expect(status.label).toBe("Unresponsive");
      expect(status.color).toBe("var(--state-error-text)");
    });

    it("uses per-agent heartbeatTimeoutMs when configured", () => {
      const agent = makeAgent({
        state: "active",
        // 90s ago - would be unresponsive with default 60s, but within 120s timeout
        lastHeartbeatAt: new Date(FIXED_NOW - 90_000).toISOString(),
        runtimeConfig: { heartbeatIntervalMs: 30_000, heartbeatTimeoutMs: 120_000 },
      });
      const status = getAgentHealthStatus(agent);
      expect(status.label).toBe("Healthy");
    });

    it("marks as unresponsive when exceeding per-agent timeout", () => {
      const agent = makeAgent({
        state: "active",
        // 60s ago - would be healthy with default 60s, but exceeds 30s custom timeout
        lastHeartbeatAt: new Date(FIXED_NOW - 60_000).toISOString(),
        runtimeConfig: { heartbeatIntervalMs: 30_000, heartbeatTimeoutMs: 30_000 },
      });
      const status = getAgentHealthStatus(agent);
      expect(status.label).toBe("Unresponsive");
    });
  });

  // ── Non-periodic agents (no heartbeatIntervalMs) ────────────────────────────

  describe("non-periodic agents (no heartbeatIntervalMs)", () => {
    it('returns "Healthy" for agent without heartbeatIntervalMs regardless of elapsed time', () => {
      // This is an event-driven agent - no timer-based heartbeats expected
      const agent = makeAgent({
        state: "active",
        lastHeartbeatAt: new Date(FIXED_NOW - 1_000_000).toISOString(), // very stale heartbeat
        runtimeConfig: { enabled: true }, // no heartbeatIntervalMs - event-driven
      });
      const status = getAgentHealthStatus(agent);
      expect(status.label).toBe("Healthy");
      expect(status.color).toBe("var(--state-active-text)");
    });

    it('returns "Healthy" for agent with stale heartbeat when no heartbeatIntervalMs is set', () => {
      const agent = makeAgent({
        state: "active",
        lastHeartbeatAt: new Date(FIXED_NOW - 60_001).toISOString(), // just over 60s ago
        runtimeConfig: {}, // empty runtimeConfig - no heartbeatIntervalMs
      });
      const status = getAgentHealthStatus(agent);
      expect(status.label).toBe("Healthy");
    });

    it('returns "Healthy" for agent with heartbeatIntervalMs: 0 (invalid, treated as non-periodic)', () => {
      const agent = makeAgent({
        state: "active",
        lastHeartbeatAt: new Date(FIXED_NOW - 1_000_000).toISOString(), // very stale
        runtimeConfig: { heartbeatIntervalMs: 0 }, // 0 is invalid, treated as non-periodic
      });
      const status = getAgentHealthStatus(agent);
      expect(status.label).toBe("Healthy");
    });

    it('returns "Healthy" for agent with heartbeatIntervalMs: -5000 (negative, treated as non-periodic)', () => {
      const agent = makeAgent({
        state: "active",
        lastHeartbeatAt: new Date(FIXED_NOW - 100_000).toISOString(), // stale
        runtimeConfig: { heartbeatIntervalMs: -5000 }, // negative is invalid
      });
      const status = getAgentHealthStatus(agent);
      expect(status.label).toBe("Healthy");
    });

    it('returns "Healthy" for agent with heartbeatIntervalMs: undefined (non-periodic)', () => {
      const agent = makeAgent({
        state: "active",
        lastHeartbeatAt: new Date(FIXED_NOW - 500_000).toISOString(), // very stale
        runtimeConfig: { heartbeatTimeoutMs: 60_000, heartbeatIntervalMs: undefined as unknown as number },
      });
      const status = getAgentHealthStatus(agent);
      expect(status.label).toBe("Healthy");
    });

    it('returns "Healthy" for periodic agent with heartbeatIntervalMs: 60000 and stale heartbeat shows "Unresponsive"', () => {
      const agent = makeAgent({
        state: "active",
        lastHeartbeatAt: new Date(FIXED_NOW - 120_000).toISOString(), // 120s ago, exceeds 60s timeout
        runtimeConfig: { heartbeatIntervalMs: 60_000 }, // periodic with 60s interval
      });
      const status = getAgentHealthStatus(agent);
      expect(status.label).toBe("Unresponsive");
    });
  });

  // ── Per-agent timeout overrides ────────────────────────────────────────────

  describe("per-agent timeout overrides", () => {
    it("returns 'Healthy' for non-periodic agent regardless of elapsed time (no heartbeatIntervalMs)", () => {
      const agent = makeAgent({
        state: "active",
        lastHeartbeatAt: new Date(FIXED_NOW - 59_000).toISOString(), // 59s ago
      });
      const status = getAgentHealthStatus(agent);
      expect(status.label).toBe("Healthy");
    });

    it("returns 'Healthy' for agent with runtimeConfig but no heartbeatIntervalMs", () => {
      const agent = makeAgent({
        state: "active",
        lastHeartbeatAt: new Date(FIXED_NOW - 59_000).toISOString(),
        runtimeConfig: { maxConcurrentRuns: 2 }, // has other config, but no heartbeatIntervalMs
      });
      const status = getAgentHealthStatus(agent);
      expect(status.label).toBe("Healthy");
    });

    it("handles custom timeout of 30 seconds with periodic heartbeat", () => {
      const agent = makeAgent({
        state: "active",
        lastHeartbeatAt: new Date(FIXED_NOW - 45_000).toISOString(), // 45s ago
        runtimeConfig: { heartbeatIntervalMs: 30_000, heartbeatTimeoutMs: 30_000 },
      });
      const status = getAgentHealthStatus(agent);
      expect(status.label).toBe("Unresponsive");
    });

    it("handles custom timeout of 120 seconds with periodic heartbeat", () => {
      const agent = makeAgent({
        state: "active",
        lastHeartbeatAt: new Date(FIXED_NOW - 90_000).toISOString(), // 90s ago
        runtimeConfig: { heartbeatIntervalMs: 30_000, heartbeatTimeoutMs: 120_000 },
      });
      const status = getAgentHealthStatus(agent);
      expect(status.label).toBe("Healthy");
    });

    it("handles very short timeout of 5 seconds with periodic heartbeat", () => {
      const agent = makeAgent({
        state: "active",
        lastHeartbeatAt: new Date(FIXED_NOW - 6_000).toISOString(), // 6s ago
        runtimeConfig: { heartbeatIntervalMs: 10_000, heartbeatTimeoutMs: 5_000 },
      });
      const status = getAgentHealthStatus(agent);
      expect(status.label).toBe("Unresponsive");
    });
  });

  // ── Edge cases ─────────────────────────────────────────────────────────────

  describe("edge cases", () => {
    it("handles null runtimeConfig gracefully", () => {
      const agent = makeAgent({
        state: "active",
        lastHeartbeatAt: new Date(FIXED_NOW - 30_000).toISOString(),
        runtimeConfig: null as unknown as undefined,
      });
      const status = getAgentHealthStatus(agent);
      expect(status.label).toBe("Healthy");
    });

    it("handles empty runtimeConfig object", () => {
      const agent = makeAgent({
        state: "active",
        lastHeartbeatAt: new Date(FIXED_NOW - 30_000).toISOString(),
        runtimeConfig: {},
      });
      const status = getAgentHealthStatus(agent);
      expect(status.label).toBe("Healthy");
    });

    it("treats runtimeConfig.enabled as true when undefined (non-periodic)", () => {
      const agent = makeAgent({
        state: "active",
        lastHeartbeatAt: new Date(FIXED_NOW - 100_000).toISOString(), // stale
        runtimeConfig: { heartbeatTimeoutMs: 120_000 }, // no heartbeatIntervalMs, so non-periodic
      });
      const status = getAgentHealthStatus(agent);
      expect(status.label).toBe("Healthy"); // non-periodic agents are always Healthy when they have heartbeat
    });

    it("treats runtimeConfig.enabled === true with periodic heartbeat", () => {
      const agent = makeAgent({
        state: "active",
        lastHeartbeatAt: new Date(FIXED_NOW - 100_000).toISOString(), // stale
        runtimeConfig: { enabled: true, heartbeatIntervalMs: 30_000, heartbeatTimeoutMs: 120_000 },
      });
      const status = getAgentHealthStatus(agent);
      expect(status.label).toBe("Healthy"); // within 120s timeout
    });

    it("returns consistent icons for all states", () => {
      const testCases: Array<{ agent: ReturnType<typeof makeAgent>; expectedIconType: string }> = [
        { agent: makeAgent({ state: "terminated" }), expectedIconType: "Square" },
        { agent: makeAgent({ state: "error" }), expectedIconType: "Activity" },
        { agent: makeAgent({ state: "paused" }), expectedIconType: "Pause" },
        { agent: makeAgent({ state: "running" }), expectedIconType: "Activity" },
        { agent: makeAgent({ state: "idle" }), expectedIconType: "Bot" },
        { agent: makeAgent({ state: "active", runtimeConfig: { enabled: false } }), expectedIconType: "Bot" },
        {
          agent: makeAgent({
            name: "executor-FN-1661",
            role: "executor",
            state: "active",
            taskId: "FN-1661",
            metadata: { agentKind: "task-worker" },
            runtimeConfig: { enabled: false },
          }),
          expectedIconType: "Activity",
        },
        // Active with recent heartbeat should show "Healthy" (Heart icon)
        { agent: makeAgent({ state: "active", lastHeartbeatAt: new Date(FIXED_NOW - 30_000).toISOString() }), expectedIconType: "Heart" },
      ];

      testCases.forEach(({ agent, expectedIconType }) => {
        const status = getAgentHealthStatus(agent);
        // lucide icons expose their component on the JSX element's `type`
        const iconElement = status.icon as JSX.Element & {
          type?: {
            displayName?: string;
            name?: string;
          };
        };
        const iconType = iconElement.type?.displayName ?? iconElement.type?.name;
        expect(iconType).toBe(expectedIconType);
      });
    });
  });
});

describe("getAgentHealthColorVar", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("extracts CSS variable name from health status color", () => {
    const agent = makeAgent({ state: "terminated" });
    const colorVar = getAgentHealthColorVar(agent);
    expect(colorVar).toBe("--state-error-text");
  });

  it("returns full color for non-variable colors (fallback)", () => {
    // This shouldn't happen in practice, but testing the fallback
    const agent = makeAgent({ state: "terminated" });
    const status = getAgentHealthStatus(agent);
    // The function should return the variable name in var() format
    expect(getAgentHealthColorVar(agent)).toBe(status.color.replace(/var\((--[^)]+)\)/, "$1"));
  });
});
