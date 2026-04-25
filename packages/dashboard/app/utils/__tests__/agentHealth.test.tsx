import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { getAgentHealthStatus, getAgentHealthColorVar } from "../agentHealth";
import type { Agent } from "../../api";

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
      expect(status.stateDerived).toBe(true);
      expect(status.color).toBe("var(--state-error-text)");
    });

    it("ignores heartbeat data for terminated agents", () => {
      const agent = makeAgent({
        state: "terminated",
        lastHeartbeatAt: new Date(FIXED_NOW - 1000).toISOString(),
      });
      const status = getAgentHealthStatus(agent);
      expect(status.label).toBe("Terminated");
      expect(status.stateDerived).toBe(true);
    });
  });

  describe("error state", () => {
    it('returns "Error" for error agents without lastError', () => {
      const agent = makeAgent({ state: "error" });
      const status = getAgentHealthStatus(agent);
      expect(status.label).toBe("Error");
      expect(status.stateDerived).toBe(true);
      expect(status.color).toBe("var(--state-error-text)");
    });

    it("uses lastError as label when available", () => {
      const agent = makeAgent({ state: "error", lastError: "Agent crashed" });
      const status = getAgentHealthStatus(agent);
      expect(status.label).toBe("Agent crashed");
      expect(status.stateDerived).toBe(false);
    });

    it("ignores heartbeat data for error agents", () => {
      const agent = makeAgent({
        state: "error",
        lastHeartbeatAt: new Date(FIXED_NOW - 1000).toISOString(),
      });
      const status = getAgentHealthStatus(agent);
      expect(status.label).toBe("Error");
      expect(status.stateDerived).toBe(true);
    });
  });

  describe("paused state", () => {
    it('returns "Paused" for paused agents without pauseReason', () => {
      const agent = makeAgent({ state: "paused" });
      const status = getAgentHealthStatus(agent);
      expect(status.label).toBe("Paused");
      expect(status.stateDerived).toBe(true);
      expect(status.color).toBe("var(--state-paused-text)");
    });

    it("includes pauseReason in label when available", () => {
      const agent = makeAgent({ state: "paused", pauseReason: "User requested" });
      const status = getAgentHealthStatus(agent);
      expect(status.label).toBe("Paused: User requested");
      expect(status.stateDerived).toBe(false);
    });

    it("ignores heartbeat data for paused agents", () => {
      const agent = makeAgent({
        state: "paused",
        lastHeartbeatAt: new Date(FIXED_NOW - 1000).toISOString(),
      });
      const status = getAgentHealthStatus(agent);
      expect(status.label).toBe("Paused");
      expect(status.stateDerived).toBe(true);
    });
  });

  describe("running state", () => {
    it('returns "Running" for running agents', () => {
      const agent = makeAgent({ state: "running" });
      const status = getAgentHealthStatus(agent);
      expect(status.label).toBe("Running");
      expect(status.stateDerived).toBe(true);
      expect(status.color).toBe("var(--state-active-text)");
    });

    it("ignores heartbeat data for running agents", () => {
      const agent = makeAgent({
        state: "running",
        lastHeartbeatAt: new Date(FIXED_NOW - 100_000).toISOString(), // 100s ago - would be "unresponsive" without this
      });
      const status = getAgentHealthStatus(agent);
      expect(status.label).toBe("Running");
      expect(status.stateDerived).toBe(true);
    });
  });

  // Heartbeat scheduling is driven by agent.state on the server; there is no
  // separate "disabled" UI concept anymore. Non-task-worker agents with a
  // legacy `runtimeConfig.enabled === false` on disk are rendered by state
  // just like any other agent.

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
      expect(status.stateDerived).toBe(true);
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
      expect(status.stateDerived).toBe(true);
      expect(status.color).toBe("var(--state-active-text)");
    });

    it('ignores legacy runtimeConfig.enabled=false on non-task-worker agents', () => {
      const agent = makeAgent({
        name: "Reviewer",
        role: "reviewer",
        state: "active",
        runtimeConfig: { enabled: false },
      });
      const status = getAgentHealthStatus(agent);
      // No persisted heartbeat, no lastHeartbeatAt → Starting... not Disabled.
      expect(status.label).toBe("Starting...");
    });
  });

  // ── No heartbeat data ──────────────────────────────────────────────────────

  describe("no heartbeat data", () => {
    it('returns "Starting..." for active agents with no lastHeartbeatAt', () => {
      const agent = makeAgent({ state: "active" });
      const status = getAgentHealthStatus(agent);
      expect(status.label).toBe("Starting...");
      expect(status.stateDerived).toBe(false);
      expect(status.color).toBe("var(--text-secondary)");
    });

    it('returns "Idle" for non-active agents with no lastHeartbeatAt', () => {
      const agent = makeAgent({ state: "idle" });
      const status = getAgentHealthStatus(agent);
      expect(status.label).toBe("Idle");
      expect(status.stateDerived).toBe(false);
      expect(status.color).toBe("var(--text-secondary)");
    });

    it('returns "Idle" for terminated agents without heartbeat (edge case)', () => {
      // Although terminated state takes precedence, testing the fallback
      const agent = makeAgent({ state: "idle", lastHeartbeatAt: undefined });
      const status = getAgentHealthStatus(agent);
      expect(status.label).toBe("Idle");
      expect(status.stateDerived).toBe(false);
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
      expect(status.stateDerived).toBe(false);
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
      expect(status.stateDerived).toBe(false);
    });

    it('returns "Unresponsive" when heartbeat exceeds the freshness threshold with periodic heartbeat', () => {
      const agent = makeAgent({
        state: "active",
        lastHeartbeatAt: new Date(FIXED_NOW - 24 * 60 * 1000 - 1).toISOString(), // just over 24 minutes ago
        runtimeConfig: { heartbeatIntervalMs: 6 * 60 * 1000 }, // 6 minute interval
      });
      const status = getAgentHealthStatus(agent);
      expect(status.label).toBe("Unresponsive");
      expect(status.stateDerived).toBe(false);
      expect(status.color).toBe("var(--state-error-text)");
    });

    it("ignores heartbeatTimeoutMs — that's the per-run work budget, not freshness", () => {
      // 30s interval → staleness threshold = max(60s floor, 60s) = 60s. A
      // 45s-old heartbeat is healthy regardless of what heartbeatTimeoutMs says.
      const agent = makeAgent({
        state: "active",
        lastHeartbeatAt: new Date(FIXED_NOW - 45_000).toISOString(),
        runtimeConfig: { heartbeatIntervalMs: 30_000, heartbeatTimeoutMs: 30_000 },
      });
      expect(getAgentHealthStatus(agent).label).toBe("Healthy");
    });
  });

  // ── Agents without explicit heartbeatIntervalMs ───────────────────────────
  //
  // Agents that never had an interval persisted still get the server-side
  // default interval (1h), so they render Healthy within ~4h of the last
  // heartbeat and tip into Unresponsive beyond that.

  describe("agents without explicit heartbeatIntervalMs", () => {
    it('returns "Healthy" within the default-interval grace window', () => {
      const agent = makeAgent({
        state: "active",
        lastHeartbeatAt: new Date(FIXED_NOW - 60_000).toISOString(), // 1m ago
        runtimeConfig: {}, // no interval — falls back to 1h default
      });
      expect(getAgentHealthStatus(agent).label).toBe("Healthy");
    });

    it('returns "Unresponsive" once elapsed exceeds 4× the default 1h interval', () => {
      const agent = makeAgent({
        state: "active",
        lastHeartbeatAt: new Date(FIXED_NOW - 5 * 3_600_000).toISOString(), // 5h ago
        runtimeConfig: {},
      });
      expect(getAgentHealthStatus(agent).label).toBe("Unresponsive");
    });

    it("clamps invalid intervals (0/negative) to the dashboard minimum (5m)", () => {
      // 0 clamp to 300000ms (5m minimum) → threshold = max(300000 × 4, 300000) = 1,200,000ms (20 minutes).
      // A heartbeat 21 minutes old is stale.
      const agent = makeAgent({
        state: "active",
        lastHeartbeatAt: new Date(FIXED_NOW - 1_260_000).toISOString(), // 21 minutes ago
        runtimeConfig: { heartbeatIntervalMs: 0 },
      });
      expect(getAgentHealthStatus(agent).label).toBe("Unresponsive");
    });
  });

  // ── Staleness floor ───────────────────────────────────────────────────────
  //
  // Short intervals get a 5m floor so the UI doesn't flicker between
  // Healthy and Unresponsive every tick for second-level heartbeats.

  describe("staleness floor", () => {
    it("holds Healthy below the 5m floor even for sub-minute intervals", () => {
      const agent = makeAgent({
        state: "active",
        lastHeartbeatAt: new Date(FIXED_NOW - 30_000).toISOString(),
        runtimeConfig: { heartbeatIntervalMs: 10_000 },
      });
      expect(getAgentHealthStatus(agent).label).toBe("Healthy");
    });

    it("tips to Unresponsive past the floor", () => {
      // 6 minute interval → threshold = max(6m × 4, 5m floor) = 24 minutes.
      // A heartbeat 25 minutes old exceeds the threshold.
      const agent = makeAgent({
        state: "active",
        lastHeartbeatAt: new Date(FIXED_NOW - 25 * 60 * 1000).toISOString(), // 25 minutes ago
        runtimeConfig: { heartbeatIntervalMs: 6 * 60 * 1000 }, // 6 minute interval
      });
      expect(getAgentHealthStatus(agent).label).toBe("Unresponsive");
    });
  });

  describe("stateDerived semantics", () => {
    it.each([
      {
        name: "paused without reason",
        agent: makeAgent({ state: "paused" }),
        expectedLabel: "Paused",
        expectedStateDerived: true,
      },
      {
        name: "paused with reason",
        agent: makeAgent({ state: "paused", pauseReason: "Backoff" }),
        expectedLabel: "Paused: Backoff",
        expectedStateDerived: false,
      },
      {
        name: "running",
        agent: makeAgent({ state: "running" }),
        expectedLabel: "Running",
        expectedStateDerived: true,
      },
      {
        name: "error without lastError",
        agent: makeAgent({ state: "error" }),
        expectedLabel: "Error",
        expectedStateDerived: true,
      },
      {
        name: "error with lastError",
        agent: makeAgent({ state: "error", lastError: "OOM" }),
        expectedLabel: "OOM",
        expectedStateDerived: false,
      },
      {
        name: "terminated",
        agent: makeAgent({ state: "terminated" }),
        expectedLabel: "Terminated",
        expectedStateDerived: true,
      },
      {
        name: "healthy",
        agent: makeAgent({ state: "active", lastHeartbeatAt: new Date(FIXED_NOW - 10_000).toISOString() }),
        expectedLabel: "Healthy",
        expectedStateDerived: false,
      },
      {
        name: "unresponsive",
        agent: makeAgent({
          state: "active",
          lastHeartbeatAt: new Date(FIXED_NOW - 25 * 60 * 1000).toISOString(), // 25 minutes ago
          runtimeConfig: { heartbeatIntervalMs: 6 * 60 * 1000 }, // 6 minute interval
        }),
        expectedLabel: "Unresponsive",
        expectedStateDerived: false,
      },
      {
        name: "idle",
        agent: makeAgent({ state: "idle", lastHeartbeatAt: undefined }),
        expectedLabel: "Idle",
        expectedStateDerived: false,
      },
      {
        name: "starting",
        agent: makeAgent({ state: "active", lastHeartbeatAt: undefined }),
        expectedLabel: "Starting...",
        expectedStateDerived: false,
      },
    ])("sets stateDerived correctly for $name", ({ agent, expectedLabel, expectedStateDerived }) => {
      const status = getAgentHealthStatus(agent);
      expect(status.label).toBe(expectedLabel);
      expect(status.stateDerived).toBe(expectedStateDerived);
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
      expect(status.stateDerived).toBe(false);
    });

    it("handles empty runtimeConfig object", () => {
      const agent = makeAgent({
        state: "active",
        lastHeartbeatAt: new Date(FIXED_NOW - 30_000).toISOString(),
        runtimeConfig: {},
      });
      const status = getAgentHealthStatus(agent);
      expect(status.label).toBe("Healthy");
      expect(status.stateDerived).toBe(false);
    });

    it("100s stale heartbeat with no explicit interval → Healthy (default 1h applies)", () => {
      // 1h default interval → 2h threshold, so 100s is well within range.
      const agent = makeAgent({
        state: "active",
        lastHeartbeatAt: new Date(FIXED_NOW - 100_000).toISOString(),
        runtimeConfig: { heartbeatTimeoutMs: 120_000 }, // no heartbeatIntervalMs
      });
      expect(getAgentHealthStatus(agent).label).toBe("Healthy");
    });

    it("ignores runtimeConfig.enabled and uses interval-based staleness", () => {
      // 6 minute interval → 24 minute threshold. 25 minutes elapsed is stale regardless of any
      // legacy enabled flag or per-run timeout.
      const agent = makeAgent({
        state: "active",
        lastHeartbeatAt: new Date(FIXED_NOW - 25 * 60 * 1000).toISOString(), // 25 minutes ago
        runtimeConfig: { enabled: true, heartbeatIntervalMs: 6 * 60 * 1000, heartbeatTimeoutMs: 120_000 },
      });
      expect(getAgentHealthStatus(agent).label).toBe("Unresponsive");
    });

    it("returns consistent icons for all states", () => {
      const testCases: Array<{ agent: ReturnType<typeof makeAgent>; expectedIconType: string }> = [
        { agent: makeAgent({ state: "terminated" }), expectedIconType: "Square" },
        { agent: makeAgent({ state: "error" }), expectedIconType: "Activity" },
        { agent: makeAgent({ state: "paused" }), expectedIconType: "Pause" },
        { agent: makeAgent({ state: "running" }), expectedIconType: "Activity" },
        { agent: makeAgent({ state: "idle" }), expectedIconType: "Bot" },
        // state=active + no lastHeartbeatAt → "Starting..." → Bot icon
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
