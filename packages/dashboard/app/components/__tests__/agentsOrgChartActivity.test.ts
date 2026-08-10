import { describe, expect, it } from "vitest";
import type { Agent, AgentActivityEvent, AgentActivityEventType } from "../../api";
import {
  ACTIVE_STATE_WINDOW_MS,
  compareActivityEvents,
  FLOW_EDGE_WINDOW_MS,
  orgChartEdgeKey,
  parseActivityOccurredAt,
  resolveFlowEdges,
  resolveNodeActivityState,
  withActivityWindowTimestamp,
} from "../agentsOrgChartActivity";

const NOW = Date.parse("2026-08-09T20:00:00.000Z");
const NOW_ISO = new Date(NOW).toISOString();

function agent(id = "agent-child", state: Agent["state"] = "idle"): Agent {
  return {
    id,
    name: id,
    role: "executor",
    state,
    metadata: {},
    createdAt: NOW_ISO,
    updatedAt: NOW_ISO,
  } as Agent;
}

function event(overrides: Partial<AgentActivityEvent> = {}): AgentActivityEvent {
  return {
    seq: "1",
    eventId: "event-1",
    projectId: "project-1",
    agentId: "agent-child",
    agentAttribution: "agent",
    taskId: "FN-1",
    type: "task:started" as AgentActivityEventType,
    fromAgentId: null,
    toAgentId: null,
    summary: "started task",
    occurredAt: NOW_ISO,
    metadata: null,
    ...overrides,
  };
}

describe("agentsOrgChartActivity", () => {
  it("keeps no activity data unknown rather than claiming idle", () => {
    expect(resolveNodeActivityState(agent(), undefined, NOW)).toBe("unknown");
  });

  it("uses roster error and running state even without activity data", () => {
    expect(resolveNodeActivityState(agent("agent-error", "error"), undefined, NOW)).toBe("error");
    expect(resolveNodeActivityState(agent("agent-running", "running"), undefined, NOW)).toBe("active");
  });

  it("uses the rendered health result so configured heartbeat multipliers stay consistent", () => {
    const healthyAtConfiguredMultiplier = { label: "Healthy" } as const;
    const defaultMultiplierWouldBeOverdue = { label: "Unresponsive" } as const;
    expect(resolveNodeActivityState(agent(), undefined, NOW, healthyAtConfiguredMultiplier)).toBe("unknown");
    expect(resolveNodeActivityState(agent(), undefined, NOW, defaultMultiplierWouldBeOverdue)).toBe("error");
  });

  it("derives active from an in-flight event, then idle after its window", () => {
    const activity = event();
    expect(resolveNodeActivityState(agent(), activity, NOW)).toBe("active");
    expect(resolveNodeActivityState(agent(), activity, NOW + ACTIVE_STATE_WINDOW_MS)).toBe("idle");
  });

  it("derives idle immediately from a terminal event", () => {
    expect(resolveNodeActivityState(agent(), event({ type: "task:completed" }), NOW)).toBe("idle");
  });

  it("keeps a non-terminal event unknown until it has aged into positive idle evidence", () => {
    const stateChange = event({ type: "agent:state-changed" });
    expect(resolveNodeActivityState(agent(), stateChange, NOW)).toBe("unknown");
    expect(resolveNodeActivityState(agent(), stateChange, NOW + ACTIVE_STATE_WINDOW_MS)).toBe("idle");
  });

  it("clamps future events at receipt so they expire on the normal window", () => {
    const future = withActivityWindowTimestamp(
      event({ occurredAt: new Date(NOW + ACTIVE_STATE_WINDOW_MS * 2).toISOString() }),
      NOW,
    );
    expect(resolveNodeActivityState(agent(), future, NOW)).toBe("active");
    expect(resolveNodeActivityState(agent(), future, NOW + ACTIVE_STATE_WINDOW_MS)).toBe("idle");
  });

  it("resolves parent delegation down and child reporting up", () => {
    const links = [{ parentId: "agent-parent", childId: "agent-child" }];
    const down = event({ type: "task:handed-off", fromAgentId: "agent-parent", toAgentId: "agent-child" });
    const up = event({ eventId: "event-2", type: "task:handed-off", fromAgentId: "agent-child", toAgentId: "agent-parent" });

    expect(resolveFlowEdges(links, [down], NOW).get(orgChartEdgeKey("agent-parent", "agent-child"))).toBe("down");
    expect(resolveFlowEdges(links, [up], NOW).get(orgChartEdgeKey("agent-parent", "agent-child"))).toBe("up");
  });

  it("expires flow edges and ignores non-adjacent or unknown-agent pairs", () => {
    const links = [{ parentId: "agent-parent", childId: "agent-child" }];
    const down = event({ type: "task:handed-off", fromAgentId: "agent-parent", toAgentId: "agent-child" });
    const unrelated = event({ eventId: "event-unknown", type: "task:handed-off", fromAgentId: "agent-unknown", toAgentId: "agent-child" });

    expect(resolveFlowEdges(links, [down], NOW + FLOW_EDGE_WINDOW_MS).get(orgChartEdgeKey("agent-parent", "agent-child"))).toBeNull();
    expect(resolveFlowEdges(links, [unrelated], NOW).get(orgChartEdgeKey("agent-parent", "agent-child"))).toBeNull();
  });

  it("chooses the comparator-newest competing delegation event and is idempotent for duplicates", () => {
    const links = [{ parentId: "agent-parent", childId: "agent-child" }];
    const olderDown = event({ eventId: "a", type: "task:handed-off", fromAgentId: "agent-parent", toAgentId: "agent-child" });
    const newerUp = event({ eventId: "b", type: "task:handed-off", fromAgentId: "agent-child", toAgentId: "agent-parent" });

    const once = resolveFlowEdges(links, [olderDown, newerUp], NOW);
    const duplicated = resolveFlowEdges(links, [olderDown, newerUp, newerUp], NOW);
    expect(once.get(orgChartEdgeKey("agent-parent", "agent-child"))).toBe("up");
    expect(duplicated.get(orgChartEdgeKey("agent-parent", "agent-child"))).toBe("up");
  });

  it("orders events totally by occurredAt and then actual eventId", () => {
    const early = event({ eventId: "z", occurredAt: new Date(NOW - 1).toISOString() });
    const sameTimeA = event({ eventId: "a" });
    const sameTimeB = event({ eventId: "b" });
    const shuffled = [sameTimeB, early, sameTimeA];

    expect([...shuffled].sort(compareActivityEvents).map((item) => item.eventId)).toEqual(["b", "a", "z"]);
    expect([...shuffled].sort(compareActivityEvents).map((item) => item.eventId)).toEqual(["b", "a", "z"]);
    expect(parseActivityOccurredAt("not-a-date")).toBeNull();
    expect(parseActivityOccurredAt(0)).toBeNull();
  });

  it("is pure for the same inputs and clock", () => {
    const activity = event();
    expect(resolveNodeActivityState(agent(), activity, NOW)).toBe(resolveNodeActivityState(agent(), activity, NOW));
    expect(resolveFlowEdges([{ parentId: "agent-parent", childId: "agent-child" }], [activity], NOW)).toEqual(
      resolveFlowEdges([{ parentId: "agent-parent", childId: "agent-child" }], [activity], NOW),
    );
  });
});
