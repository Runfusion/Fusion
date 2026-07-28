import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { getAgentHealthStatus, getAgentHealthColorVar } from "../agentHealth";
import { elapsedSinceMs, isOverdue } from "../dataFreshness";
import type { Agent } from "../../api";

/*
FNXC:MobileTabDiscard 2026-07-26-10:16:
Regression coverage for the dataAsOfMs invariant on the AGENT surface. After a mobile tab discard the
agents list hydrates from an SWR snapshot that can be hours old; heartbeat freshness must be measured
against the age of that snapshot, not wall-clock now, or every healthy agent renders "Unresponsive".
Same defect class as the task "stuck" false positive (utils/taskStuck.ts).

The assertions are two-sided on purpose: seeding dataAsOfMs must not blind the label either — an agent
genuinely overdue RELATIVE TO THE SAME SNAPSHOT still reports Unresponsive.
*/

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** Wall clock at render time — two hours after the snapshot was written. */
const NOW = new Date("2026-04-10T12:00:00.000Z").getTime();
/** When the hydrated agents snapshot was last confirmed fresh by the server. */
const SNAPSHOT_SAVED_AT = NOW - 2 * HOUR;

/**
 * 15m configured interval -> staleness threshold is 15m * 4 = 60m (above the 5m floor).
 * Chosen so a 2h-old snapshot straddles the threshold: anything measured against `Date.now()` is
 * unconditionally past it, which is exactly the false positive under test.
 */
const INTERVAL_MS = 15 * MINUTE;
const THRESHOLD_MS = 60 * MINUTE;

type AgentHealthInput = Pick<
  Agent,
  "state" | "lastHeartbeatAt" | "lastError" | "pauseReason" | "runtimeConfig" | "metadata" | "name" | "role" | "taskId"
>;

function makeAgent(lastHeartbeatAtMs: number): AgentHealthInput {
  return {
    name: "durable-agent",
    role: "engineer",
    state: "active",
    taskId: undefined,
    metadata: {},
    lastError: undefined,
    pauseReason: undefined,
    runtimeConfig: { enabled: true, heartbeatIntervalMs: INTERVAL_MS },
    lastHeartbeatAt: new Date(lastHeartbeatAtMs).toISOString(),
  };
}

describe("agentHealth freshness is measured against the data's age, not wall-clock now", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not report Unresponsive for a heartbeat that is recent relative to a 2h-old snapshot", () => {
    // Beat landed 1 minute before the snapshot was written: 1m of data-relative age vs a 60m threshold.
    const agent = makeAgent(SNAPSHOT_SAVED_AT - MINUTE);

    const status = getAgentHealthStatus(agent, 1, SNAPSHOT_SAVED_AT);

    expect(status.label).toBe("Healthy");
    expect(status.reason).toBeUndefined();
  });

  it("still reports Unresponsive for a heartbeat genuinely overdue relative to that same snapshot", () => {
    // Beat landed 90 minutes before the snapshot was written: 90m of data-relative age, past 60m.
    const agent = makeAgent(SNAPSHOT_SAVED_AT - 90 * MINUTE);

    const status = getAgentHealthStatus(agent, 1, SNAPSHOT_SAVED_AT);

    expect(status.label).toBe("Unresponsive");
    // The elapsed figure quoted to the operator is data-relative too — not the 3h30m wall-clock lie.
    expect(status.reason).toBe("No heartbeat for 1h 30m (threshold: 1h)");
  });

  it("reproduces the original defect when dataAsOfMs is omitted (documents the wall-clock fallback)", () => {
    const agent = makeAgent(SNAPSHOT_SAVED_AT - MINUTE);

    // This is the pre-fix behavior every hydrated render used to take.
    expect(getAgentHealthStatus(agent, 1).label).toBe("Unresponsive");
    // Live data is unaffected by the fix: a beat one minute before NOW is Healthy either way.
    expect(getAgentHealthStatus(makeAgent(NOW - MINUTE), 1).label).toBe("Healthy");
    expect(getAgentHealthStatus(makeAgent(NOW - MINUTE), 1, NOW).label).toBe("Healthy");
  });

  it("threshold boundary is evaluated in data-relative time", () => {
    expect(getAgentHealthStatus(makeAgent(SNAPSHOT_SAVED_AT - THRESHOLD_MS), 1, SNAPSHOT_SAVED_AT).label)
      .toBe("Healthy");
    expect(getAgentHealthStatus(makeAgent(SNAPSHOT_SAVED_AT - THRESHOLD_MS - 1), 1, SNAPSHOT_SAVED_AT).label)
      .toBe("Unresponsive");
  });

  it("clamps a heartbeat newer than its own snapshot instead of reporting negative age", () => {
    // SSE can deliver a beat after the envelope was written; that is not proof of staleness.
    const status = getAgentHealthStatus(makeAgent(SNAPSHOT_SAVED_AT + 5 * MINUTE), 1, SNAPSHOT_SAVED_AT);
    expect(status.label).toBe("Healthy");
  });

  it("keeps the invalid-timestamp verdict independent of the clock source", () => {
    const agent: AgentHealthInput = { ...makeAgent(NOW), lastHeartbeatAt: "not-a-date" };
    expect(getAgentHealthStatus(agent, 1, SNAPSHOT_SAVED_AT).reason).toBe("Last heartbeat timestamp is invalid");
    expect(getAgentHealthStatus(agent, 1).reason).toBe("Last heartbeat timestamp is invalid");
  });

  it("getAgentHealthColorVar honors the same data-relative clock", () => {
    const fresh = makeAgent(SNAPSHOT_SAVED_AT - MINUTE);
    expect(getAgentHealthColorVar(fresh, SNAPSHOT_SAVED_AT)).toBe("--state-active-text");
    expect(getAgentHealthColorVar(fresh)).toBe("--state-error-text");
  });
});

describe("dataFreshness helper", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("ages a timestamp against dataAsOfMs and falls back to Date.now() only when it is undefined", () => {
    expect(elapsedSinceMs(SNAPSHOT_SAVED_AT - MINUTE, SNAPSHOT_SAVED_AT)).toBe(MINUTE);
    expect(elapsedSinceMs(SNAPSHOT_SAVED_AT - MINUTE, undefined)).toBe(2 * HOUR + MINUTE);
  });

  it("clamps negative age to zero and never calls an unparseable timestamp overdue", () => {
    expect(elapsedSinceMs(NOW + MINUTE, NOW)).toBe(0);
    expect(isOverdue(Number.NaN, MINUTE, NOW)).toBe(false);
  });

  it("uses a strict greater-than comparison at the threshold", () => {
    expect(isOverdue(NOW - MINUTE, MINUTE, NOW)).toBe(false);
    expect(isOverdue(NOW - MINUTE - 1, MINUTE, NOW)).toBe(true);
  });
});
