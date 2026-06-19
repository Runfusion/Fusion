import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { Database } from "../db.js";
import { emitUsageEvent } from "../usage-events.js";
import {
  aggregateActivityAnalytics,
  aggregateMonitorMetrics,
  aggregateSdlcFunnel,
  buildColumnStageMap,
  stageForTraits,
} from "../activity-analytics.js";

let incidentSeq = 0;
function insertIncident(
  db: Database,
  fields: {
    groupingKey: string;
    status: "open" | "resolved";
    openedAt: string;
    resolvedAt?: string | null;
    severity?: string;
  },
): string {
  const incidentId = `inc-${incidentSeq++}`;
  const now = "2026-03-01T00:00:00.000Z";
  db.prepare(
    `INSERT INTO incidents
       (incidentId, groupingKey, title, severity, status, source, openedAt, resolvedAt, createdAt, updatedAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    incidentId,
    fields.groupingKey,
    `Incident ${incidentId}`,
    fields.severity ?? "error",
    fields.status,
    "webhook",
    fields.openedAt,
    fields.resolvedAt ?? null,
    now,
    now,
  );
  return incidentId;
}

let deploySeq = 0;
function insertDeployment(db: Database, deployedAt: string): void {
  const id = `dep-${deploySeq++}`;
  db.prepare(
    `INSERT INTO deployments (deploymentId, service, environment, deployedAt, createdAt)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(id, "svc", "prod", deployedAt, deployedAt);
}

let moveSeq = 0;
function insertMove(
  db: Database,
  taskId: string,
  from: string,
  to: string,
  timestamp: string,
): void {
  db.prepare(
    `INSERT INTO activityLog (id, timestamp, type, taskId, taskTitle, details, metadata)
     VALUES (?, ?, 'task:moved', ?, ?, ?, ?)`,
  ).run(
    `mv-${moveSeq++}`,
    timestamp,
    taskId,
    `Task ${taskId}`,
    `Task ${taskId} moved: ${from} → ${to}`,
    JSON.stringify({ from, to }),
  );
}

function insertCliSession(db: Database, id: string, createdAt: string): void {
  db.prepare(
    `INSERT INTO cli_sessions
       (id, purpose, projectId, adapterId, agentState, createdAt, updatedAt)
     VALUES (?, 'task', 'proj-1', 'claude-local', 'running', ?, ?)`,
  ).run(id, createdAt, createdAt);
}

let agentRunSeq = 0;
function insertAgentRun(
  db: Database,
  fields: {
    agentId?: string;
    startedAt: string;
    endedAt?: string | null;
    status: string;
  },
): string {
  const id = `run-${agentRunSeq++}`;
  const agentId = fields.agentId ?? "agent-1";
  db.prepare(
    `INSERT OR IGNORE INTO agents (id, name, role, state, createdAt, updatedAt)
     VALUES (?, ?, 'executor', 'idle', ?, ?)`,
  ).run(agentId, agentId, fields.startedAt, fields.startedAt);
  db.prepare(
    `INSERT INTO agentRuns (id, agentId, data, startedAt, endedAt, status)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(id, agentId, JSON.stringify({ taskId: `task-${id}` }), fields.startedAt, fields.endedAt ?? null, fields.status);
  return id;
}

describe("activity-analytics", () => {
  let tmpDir: string;
  let db: Database;

  beforeEach(() => {
    incidentSeq = 0;
    deploySeq = 0;
    moveSeq = 0;
    agentRunSeq = 0;
    tmpDir = mkdtempSync(join(tmpdir(), "kb-activity-analytics-"));
    db = new Database(join(tmpDir, ".fusion"));
    db.init();
  });

  afterEach(async () => {
    db.close();
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("counts sessions, messages, and distinct active nodes/agents over a range", () => {
    insertCliSession(db, "s1", "2026-03-01T00:00:00.000Z");
    insertCliSession(db, "s2", "2026-03-02T00:00:00.000Z");
    // session outside range
    insertCliSession(db, "s-old", "2025-01-01T00:00:00.000Z");

    emitUsageEvent(db, { kind: "user_message", agentId: "agent-1", nodeId: "node-1", ts: "2026-03-01T00:00:00.000Z" });
    emitUsageEvent(db, { kind: "user_message", agentId: "agent-2", nodeId: "node-1", ts: "2026-03-01T01:00:00.000Z" });
    emitUsageEvent(db, { kind: "tool_call", agentId: "agent-2", nodeId: "node-2", ts: "2026-03-02T00:00:00.000Z" });

    const result = aggregateActivityAnalytics(db, { from: "2026-03-01T00:00:00.000Z", to: "2026-03-31T00:00:00.000Z" });
    expect(result.sessions).toBe(2);
    expect(result.messages).toBe(2);
    expect(result.activeNodes).toBe(2); // node-1, node-2
    expect(result.activeAgents).toBe(2); // agent-1, agent-2
  });

  it("produces a per-day breakdown ascending by day", () => {
    emitUsageEvent(db, { kind: "user_message", agentId: "agent-1", nodeId: "node-1", ts: "2026-03-01T08:00:00.000Z" });
    emitUsageEvent(db, { kind: "tool_call", agentId: "agent-1", nodeId: "node-1", ts: "2026-03-01T09:00:00.000Z" });
    emitUsageEvent(db, { kind: "user_message", agentId: "agent-2", nodeId: "node-2", ts: "2026-03-02T08:00:00.000Z" });

    const result = aggregateActivityAnalytics(db, { from: "2026-03-01T00:00:00.000Z", to: "2026-03-31T00:00:00.000Z" });
    expect(result.daily.map((d) => d.day)).toEqual(["2026-03-01", "2026-03-02"]);
    expect(result.daily[0]).toMatchObject({ day: "2026-03-01", activeNodes: 1, activeAgents: 1, messages: 1 });
    expect(result.daily[1]).toMatchObject({ day: "2026-03-02", activeNodes: 1, activeAgents: 1, messages: 1 });
  });

  it("counts agent runs by status over startedAt range and includes unknown statuses only in total", () => {
    insertAgentRun(db, { agentId: "agent-a", startedAt: "2026-03-01T00:00:00.000Z", status: "active" });
    insertAgentRun(db, { agentId: "agent-b", startedAt: "2026-03-02T00:00:00.000Z", endedAt: "2026-03-02T00:10:00.000Z", status: "completed" });
    insertAgentRun(db, { agentId: "agent-c", startedAt: "2026-03-03T00:00:00.000Z", endedAt: "2026-03-03T00:05:00.000Z", status: "failed" });
    insertAgentRun(db, { agentId: "agent-d", startedAt: "2026-03-04T00:00:00.000Z", endedAt: "2026-03-04T00:01:00.000Z", status: "cancelled" });
    insertAgentRun(db, { agentId: "agent-old", startedAt: "2026-02-28T23:59:59.000Z", status: "completed" });
    insertAgentRun(db, { agentId: "agent-new", startedAt: "2026-04-01T00:00:00.000Z", status: "failed" });

    const result = aggregateActivityAnalytics(db, { from: "2026-03-01T00:00:00.000Z", to: "2026-03-31T23:59:59.999Z" });

    expect(result.agentRuns).toEqual({ total: 4, active: 1, completed: 1, failed: 1 });
  });

  it("aligns per-day agent run counts with usage days and run-only days", () => {
    emitUsageEvent(db, { kind: "user_message", agentId: "a", nodeId: "n1", ts: "2026-03-01T08:00:00.000Z" });
    emitUsageEvent(db, { kind: "user_message", agentId: "b", nodeId: "n2", ts: "2026-03-03T08:00:00.000Z" });
    insertAgentRun(db, { startedAt: "2026-03-02T00:00:00.000Z", status: "completed" });
    insertAgentRun(db, { startedAt: "2026-03-03T00:00:00.000Z", status: "failed" });
    insertAgentRun(db, { startedAt: "2026-03-03T02:00:00.000Z", status: "active" });

    const result = aggregateActivityAnalytics(db, { from: "2026-03-01T00:00:00.000Z", to: "2026-03-31T00:00:00.000Z" });

    expect(result.daily).toEqual([
      { day: "2026-03-01", activeNodes: 1, activeAgents: 1, messages: 1, agentRuns: 0 },
      { day: "2026-03-02", activeNodes: 0, activeAgents: 0, messages: 0, agentRuns: 1 },
      { day: "2026-03-03", activeNodes: 1, activeAgents: 1, messages: 1, agentRuns: 2 },
    ]);
  });

  it("returns zero agent-run metrics when the agentRuns table is absent", () => {
    db.prepare("DROP TABLE agentRuns").run();

    const result = aggregateActivityAnalytics(db, { from: "2026-03-01T00:00:00.000Z", to: "2026-03-31T00:00:00.000Z" });

    expect(result.agentRuns).toEqual({ total: 0, active: 0, completed: 0, failed: 0 });
    expect(result.daily).toEqual([]);
  });

  it("computes stickiness = DAU/MAU", () => {
    // Day 1: agents a,b active. Day 2: agent a active. MAU = {a,b} = 2.
    // DAU = mean(2, 1) = 1.5. stickiness = 1.5 / 2 = 0.75.
    emitUsageEvent(db, { kind: "tool_call", agentId: "a", nodeId: "n1", ts: "2026-03-01T00:00:00.000Z" });
    emitUsageEvent(db, { kind: "tool_call", agentId: "b", nodeId: "n1", ts: "2026-03-01T01:00:00.000Z" });
    emitUsageEvent(db, { kind: "tool_call", agentId: "a", nodeId: "n1", ts: "2026-03-02T00:00:00.000Z" });

    const result = aggregateActivityAnalytics(db, { from: "2026-03-01T00:00:00.000Z", to: "2026-03-31T00:00:00.000Z" });
    expect(result.activeAgents).toBe(2);
    expect(result.stickiness).toBeCloseTo(0.75, 5);
  });

  it("empty range returns zeroed structures, not nulls", () => {
    insertCliSession(db, "s1", "2026-03-01T00:00:00.000Z");
    emitUsageEvent(db, { kind: "user_message", agentId: "a", nodeId: "n1", ts: "2026-03-01T00:00:00.000Z" });

    const result = aggregateActivityAnalytics(db, { from: "2027-01-01T00:00:00.000Z", to: "2027-12-31T00:00:00.000Z" });
    expect(result.sessions).toBe(0);
    expect(result.messages).toBe(0);
    expect(result.activeNodes).toBe(0);
    expect(result.activeAgents).toBe(0);
    expect(result.agentRuns).toEqual({ total: 0, active: 0, completed: 0, failed: 0 });
    expect(result.daily).toEqual([]);
    expect(result.stickiness).toBe(0);
  });

  it("MTTR is unavailable (not 0) when no incident has been resolved", () => {
    const result = aggregateActivityAnalytics(db, {});
    expect(result.mttr).toEqual({ value: null, unavailable: true, sampleCount: 0 });
    expect(result.monitor.openIncidents).toBe(0);
    expect(result.monitor.deployments).toBe(0);
  });

  describe("SDLC funnel (U7)", () => {
    const RANGE = { from: "2026-03-01T00:00:00.000Z", to: "2026-03-08T00:00:00.000Z" };

    function stage(result: ReturnType<typeof aggregateSdlcFunnel>, name: string) {
      return result.stages.find((s) => s.stage === name);
    }

    it("maps the built-in workflow columns to stages by trait", () => {
      expect(stageForTraits(["intake"])).toBe("triage");
      expect(stageForTraits(["hold", "reset-on-entry"])).toBe("todo");
      expect(stageForTraits(["wip", "timing"])).toBe("in-progress");
      expect(stageForTraits(["merge-blocker", "human-review", "merge"])).toBe("in-review");
      expect(stageForTraits(["complete"])).toBe("done");
      // No recognized trait -> other.
      expect(stageForTraits(["archived"])).toBe("other");
      expect(stageForTraits([])).toBe("other");
    });

    it("renders correct per-stage counts for tasks distributed across columns", () => {
      // t1: triage -> todo -> in-progress -> in-review -> done (full funnel)
      insertMove(db, "t1", "triage", "todo", "2026-03-02T00:00:00.000Z");
      insertMove(db, "t1", "todo", "in-progress", "2026-03-02T01:00:00.000Z");
      insertMove(db, "t1", "in-progress", "in-review", "2026-03-02T02:00:00.000Z");
      insertMove(db, "t1", "in-review", "done", "2026-03-02T03:00:00.000Z");
      // t2: triage -> todo -> in-progress (stalls)
      insertMove(db, "t2", "triage", "todo", "2026-03-03T00:00:00.000Z");
      insertMove(db, "t2", "todo", "in-progress", "2026-03-03T01:00:00.000Z");
      // t3: triage -> todo (stalls earlier)
      insertMove(db, "t3", "triage", "todo", "2026-03-04T00:00:00.000Z");

      const result = aggregateSdlcFunnel(db, RANGE);
      // Entry counts destination columns of moves. Nothing moved INTO triage
      // here, so triage entered = 0; todo = 3, in-progress = 2, in-review = 1,
      // done = 1.
      expect(stage(result, "triage")?.entered).toBe(0);
      expect(stage(result, "todo")?.entered).toBe(3);
      expect(stage(result, "in-progress")?.entered).toBe(2);
      expect(stage(result, "in-review")?.entered).toBe(1);
      expect(stage(result, "done")?.entered).toBe(1);
    });

    it("counts a task once per stage even if it re-enters", () => {
      insertMove(db, "t1", "in-review", "in-progress", "2026-03-02T00:00:00.000Z");
      insertMove(db, "t1", "in-progress", "in-review", "2026-03-02T01:00:00.000Z");
      insertMove(db, "t1", "in-review", "in-progress", "2026-03-02T02:00:00.000Z");

      const result = aggregateSdlcFunnel(db, RANGE);
      expect(stage(result, "in-progress")?.entered).toBe(1);
      expect(stage(result, "in-review")?.entered).toBe(1);
    });

    it("maps custom workflow columns by trait, folding unknown into other", () => {
      // Custom column ids that are NOT the builtin names, carrying standard traits.
      const columns = [
        { id: "backlog", traits: [{ trait: "intake" }] },
        { id: "ready", traits: [{ trait: "reset-on-entry" }] },
        { id: "doing", traits: [{ trait: "wip" }] },
        { id: "shipped", traits: [{ trait: "complete" }] },
        { id: "icebox", traits: [{ trait: "some-unknown-trait" }] },
      ];
      insertMove(db, "c1", "backlog", "ready", "2026-03-02T00:00:00.000Z");
      insertMove(db, "c1", "ready", "doing", "2026-03-02T01:00:00.000Z");
      insertMove(db, "c1", "doing", "shipped", "2026-03-02T02:00:00.000Z");
      insertMove(db, "c2", "ready", "icebox", "2026-03-03T00:00:00.000Z");

      const result = aggregateSdlcFunnel(db, { ...RANGE, columns });
      expect(stage(result, "todo")?.entered).toBe(1); // moved into "ready"
      expect(stage(result, "in-progress")?.entered).toBe(1); // "doing"
      expect(stage(result, "done")?.entered).toBe(1); // "shipped"
      expect(stage(result, "other")?.entered).toBe(1); // "icebox" (unknown trait)

      // Map helper resolves by trait, not name.
      const map = buildColumnStageMap(columns);
      expect(map.get("backlog")).toBe("triage");
      expect(map.get("shipped")).toBe("done");
      expect(map.get("icebox")).toBe("other");
    });

    it("completion rate is cohort completed triage entrants / entered-in-range", () => {
      // 4 tasks enter triage; 2 of those in-range entrants reach done.
      insertMove(db, "t1", "todo", "triage", "2026-03-02T00:00:00.000Z");
      insertMove(db, "t2", "todo", "triage", "2026-03-02T01:00:00.000Z");
      insertMove(db, "t3", "todo", "triage", "2026-03-02T02:00:00.000Z");
      insertMove(db, "t4", "todo", "triage", "2026-03-02T03:00:00.000Z");
      insertMove(db, "t1", "in-review", "done", "2026-03-03T00:00:00.000Z");
      insertMove(db, "t2", "in-review", "done", "2026-03-03T01:00:00.000Z");

      const result = aggregateSdlcFunnel(db, RANGE);
      expect(result.enteredInRange).toBe(4);
      expect(result.doneInRange).toBe(2);
      expect(result.completionRate).toBe(0.5);
    });

    it("keeps completion rate bounded when older triage entrants finish in range", () => {
      insertMove(db, "old-1", "todo", "triage", "2026-02-20T00:00:00.000Z");
      insertMove(db, "old-2", "todo", "triage", "2026-02-21T00:00:00.000Z");
      insertMove(db, "new-1", "todo", "triage", "2026-03-02T00:00:00.000Z");
      insertMove(db, "old-1", "in-review", "done", "2026-03-03T00:00:00.000Z");
      insertMove(db, "old-2", "in-review", "done", "2026-03-03T01:00:00.000Z");
      insertMove(db, "new-1", "in-review", "done", "2026-03-03T02:00:00.000Z");

      const result = aggregateSdlcFunnel(db, RANGE);
      expect(result.enteredInRange).toBe(1);
      expect(result.doneInRange).toBe(3);
      expect(result.completionRate).toBe(1);
      expect(result.completionRate).toBeLessThanOrEqual(1);
      expect(result.completionRate).not.toBeGreaterThan(1);
    });

    it("reports exactly 100 percent when all in-range triage entrants reach done", () => {
      insertMove(db, "t1", "todo", "triage", "2026-03-02T00:00:00.000Z");
      insertMove(db, "t2", "todo", "triage", "2026-03-02T01:00:00.000Z");
      insertMove(db, "t1", "in-review", "done", "2026-03-03T00:00:00.000Z");
      insertMove(db, "t2", "in-review", "done", "2026-03-03T01:00:00.000Z");

      const result = aggregateSdlcFunnel(db, RANGE);
      expect(result.enteredInRange).toBe(2);
      expect(result.doneInRange).toBe(2);
      expect(result.completionRate).toBe(1);
    });

    it("handles the zero-denominator completion rate as null, not NaN", () => {
      // No triage entrants in range; one done move.
      insertMove(db, "t1", "in-review", "done", "2026-03-02T00:00:00.000Z");
      const result = aggregateSdlcFunnel(db, RANGE);
      expect(result.enteredInRange).toBe(0);
      expect(result.completionRate).toBeNull();
      expect(result.doneInRange).toBe(1);
    });

    it("computes throughput per day over the range", () => {
      insertMove(db, "t1", "in-review", "done", "2026-03-02T00:00:00.000Z");
      insertMove(db, "t2", "in-review", "done", "2026-03-03T00:00:00.000Z");
      // 7-day range, 2 done -> ~0.2857/day
      const result = aggregateSdlcFunnel(db, RANGE);
      expect(result.rangeDays).toBe(7);
      expect(result.throughputPerDay).toBeCloseTo(2 / 7, 5);
    });

    it("is exposed on the aggregated activity analytics payload (rides /activity)", () => {
      insertMove(db, "t1", "todo", "in-progress", "2026-03-02T00:00:00.000Z");
      const result = aggregateActivityAnalytics(db, RANGE);
      expect(result.funnel).toBeDefined();
      expect(result.funnel.stages.find((s) => s.stage === "in-progress")?.entered).toBe(1);
    });

    it("empty range yields zeroed funnel, not nulls in counts", () => {
      const result = aggregateSdlcFunnel(db, RANGE);
      expect(result.doneInRange).toBe(0);
      expect(result.enteredInRange).toBe(0);
      expect(result.completionRate).toBeNull();
      for (const s of result.stages) {
        expect(s.entered).toBe(0);
      }
    });
  });

  describe("monitor metrics / MTTR (U13)", () => {
    const RANGE = { from: "2026-03-01T00:00:00.000Z", to: "2026-03-31T23:59:59.999Z" };

    it("incident opened then resolved yields correct MTTR (minutes)", () => {
      // Opened 10:00, resolved 10:30 → 30 minutes.
      insertIncident(db, {
        groupingKey: "g1",
        status: "resolved",
        openedAt: "2026-03-02T10:00:00.000Z",
        resolvedAt: "2026-03-02T10:30:00.000Z",
      });
      const m = aggregateMonitorMetrics(db, RANGE);
      expect(m.mttr).toEqual({ value: 30, unavailable: false, sampleCount: 1 });
      expect(m.incidentsResolved).toBe(1);
      expect(m.openIncidents).toBe(0);
    });

    it("averages MTTR across multiple resolved incidents", () => {
      insertIncident(db, { groupingKey: "g1", status: "resolved", openedAt: "2026-03-02T10:00:00.000Z", resolvedAt: "2026-03-02T10:20:00.000Z" }); // 20m
      insertIncident(db, { groupingKey: "g2", status: "resolved", openedAt: "2026-03-03T10:00:00.000Z", resolvedAt: "2026-03-03T11:00:00.000Z" }); // 60m
      const m = aggregateMonitorMetrics(db, RANGE);
      expect(m.mttr.value).toBe(40);
      expect(m.mttr.sampleCount).toBe(2);
    });

    it("unresolved incident contributes to open incidents, NOT to MTTR", () => {
      insertIncident(db, { groupingKey: "g1", status: "open", openedAt: "2026-03-02T10:00:00.000Z" });
      const m = aggregateMonitorMetrics(db, RANGE);
      expect(m.mttr).toEqual({ value: null, unavailable: true, sampleCount: 0 });
      expect(m.openIncidents).toBe(1);
      expect(m.incidentsOpened).toBe(1);
      expect(m.incidentsResolved).toBe(0);
    });

    it("a resolution outside the range does not count toward MTTR", () => {
      insertIncident(db, { groupingKey: "g1", status: "resolved", openedAt: "2026-02-01T10:00:00.000Z", resolvedAt: "2026-02-01T10:30:00.000Z" });
      const m = aggregateMonitorMetrics(db, RANGE);
      expect(m.mttr.unavailable).toBe(true);
      expect(m.incidentsResolved).toBe(0);
    });

    it("deploy with no incident counts toward deploy frequency", () => {
      insertDeployment(db, "2026-03-05T12:00:00.000Z");
      insertDeployment(db, "2026-03-06T12:00:00.000Z");
      const m = aggregateMonitorMetrics(db, RANGE);
      expect(m.deployments).toBe(2);
      expect(m.incidentsOpened).toBe(0);
      expect(m.mttr.unavailable).toBe(true);
    });

    it("rides the aggregated activity payload (mttr + monitor surfaced)", () => {
      insertIncident(db, { groupingKey: "g1", status: "resolved", openedAt: "2026-03-02T10:00:00.000Z", resolvedAt: "2026-03-02T10:30:00.000Z" });
      const result = aggregateActivityAnalytics(db, RANGE);
      expect(result.mttr.value).toBe(30);
      expect(result.monitor.mttr.value).toBe(30);
    });
  });
});
