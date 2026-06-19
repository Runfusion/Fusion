// @vitest-environment node

/*
FNXC:Monitor 2026-06-16-09:48:
U13 monitor-store coverage (PR #1683): pins deployment/incident persistence and MTTR/deploy/incident
aggregation that close the SDLC loop, including the incident-level fix-task claim that prevents duplicate
auto-fix tasks under concurrent regression ingests.
*/
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { Database, aggregateMonitorMetrics } from "@fusion/core";
import {
  recordDeployment,
  ingestIncidentSignal,
  resolveIncident,
  getOpenIncidentByGroupingKey,
  attachFixTask,
  claimIncidentForFixTask,
  releaseIncidentFixTaskClaim,
  getIncident,
  decideStormGuard,
  countRecentAutoFixTasks,
  DEFAULT_STORM_GUARD,
  FIX_TASK_CLAIM_SENTINEL_PREFIX,
  type Incident,
} from "../monitor-store.js";

function makeDb(): { db: Database; tmpDir: string } {
  const tmpDir = mkdtempSync(join(tmpdir(), "kb-monitor-store-"));
  const db = new Database(join(tmpDir, ".fusion"));
  db.init();
  return { db, tmpDir };
}

describe("monitor-store (U13)", () => {
  let db: Database;
  let tmpDir: string;

  beforeEach(() => {
    ({ db, tmpDir } = makeDb());
  });
  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("deployments", () => {
    it("records a deployment and counts it toward deploy frequency", () => {
      recordDeployment(db, { service: "api", environment: "prod", deployedAt: "2026-03-05T12:00:00.000Z" });
      const m = aggregateMonitorMetrics(db, {});
      expect(m.deployments).toBe(1);
      expect(m.incidentsOpened).toBe(0);
    });

    it("is idempotent by deploymentId (upsert, not duplicate)", () => {
      recordDeployment(db, { deploymentId: "d1", deployedAt: "2026-03-05T12:00:00.000Z" });
      recordDeployment(db, { deploymentId: "d1", deployedAt: "2026-03-05T12:00:00.000Z", status: "rolled-back" });
      const m = aggregateMonitorMetrics(db, {});
      expect(m.deployments).toBe(1);
    });
  });

  describe("incidents + MTTR", () => {
    it("opens an incident then resolves it → correct MTTR", () => {
      ingestIncidentSignal(db, {
        groupingKey: "g1",
        title: "API 500s",
        at: "2026-03-02T10:00:00.000Z",
      });
      const resolved = resolveIncident(db, "g1", "2026-03-02T10:30:00.000Z");
      expect(resolved?.status).toBe("resolved");

      const m = aggregateMonitorMetrics(db, {
        from: "2026-03-01T00:00:00.000Z",
        to: "2026-03-31T00:00:00.000Z",
      });
      expect(m.mttr).toEqual({ value: 30, unavailable: false, sampleCount: 1 });
      expect(m.openIncidents).toBe(0);
    });

    it("a burst sharing one groupingKey absorbs into ONE open incident", () => {
      for (let i = 0; i < 100; i += 1) {
        ingestIncidentSignal(db, {
          groupingKey: "g-burst",
          title: "Flood",
          at: `2026-03-02T10:0${(i % 6)}:00.000Z`,
        });
      }
      const open = getOpenIncidentByGroupingKey(db, "g-burst");
      expect(open).not.toBeNull();
      expect(open?.meta?.occurrences).toBe(100);
      const m = aggregateMonitorMetrics(db, {});
      expect(m.openIncidents).toBe(1);
      expect(m.incidentsOpened).toBe(1);
    });

    it("unresolved incident → open incidents, not MTTR", () => {
      ingestIncidentSignal(db, { groupingKey: "g1", title: "Down", at: "2026-03-02T10:00:00.000Z" });
      const m = aggregateMonitorMetrics(db, {});
      expect(m.openIncidents).toBe(1);
      expect(m.mttr.unavailable).toBe(true);
    });

    it("resolveIncident returns null when nothing is open", () => {
      expect(resolveIncident(db, "nope")).toBeNull();
    });
  });

  describe("storm guard decision", () => {
    function incidentWith(partial: Partial<Incident>): Incident {
      return {
        id: 1,
        incidentId: "inc-1",
        groupingKey: "g1",
        title: "t",
        severity: "error",
        status: "open",
        source: "webhook",
        fixTaskId: null,
        openedAt: "2026-03-02T10:00:00.000Z",
        resolvedAt: null,
        link: null,
        meta: { occurrences: 1, firstFiredAt: "2026-03-02T10:00:00.000Z" },
        createdAt: "2026-03-02T10:00:00.000Z",
        updatedAt: "2026-03-02T10:00:00.000Z",
        ...partial,
      };
    }
    const NOW = Date.parse("2026-03-02T10:00:30.000Z"); // 30s after open

    it("suppresses a single flapping firing (gate not met)", () => {
      const d = decideStormGuard(incidentWith({ meta: { occurrences: 1, firstFiredAt: "2026-03-02T10:00:00.000Z" } }), 0, DEFAULT_STORM_GUARD, NOW);
      expect(d.action).toBe("suppress");
    });

    it("opens once the occurrence threshold is met", () => {
      const d = decideStormGuard(incidentWith({ meta: { occurrences: 3, firstFiredAt: "2026-03-02T10:00:00.000Z" } }), 0, DEFAULT_STORM_GUARD, NOW);
      expect(d.action).toBe("open-fix-task");
    });

    it("opens once the sustained-duration gate is met even below threshold", () => {
      const later = Date.parse("2026-03-02T10:10:00.000Z"); // 10 min open
      const d = decideStormGuard(incidentWith({ meta: { occurrences: 1, firstFiredAt: "2026-03-02T10:00:00.000Z" } }), 0, DEFAULT_STORM_GUARD, later);
      expect(d.action).toBe("open-fix-task");
    });

    it("absorbs when an incident already has a fix task (cooldown / no self-loop)", () => {
      const d = decideStormGuard(incidentWith({ fixTaskId: "FN-1", meta: { occurrences: 50 } }), 0, DEFAULT_STORM_GUARD, NOW);
      expect(d.action).toBe("absorb");
      if (d.action === "absorb") expect(d.existingFixTaskId).toBe("FN-1");
    });

    it("suppresses when the circuit breaker is tripped", () => {
      const d = decideStormGuard(
        incidentWith({ meta: { occurrences: 5, firstFiredAt: "2026-03-02T10:00:00.000Z" } }),
        DEFAULT_STORM_GUARD.maxTasksPerWindow,
        DEFAULT_STORM_GUARD,
        NOW,
      );
      expect(d.action).toBe("suppress");
      if (d.action === "suppress") expect(d.reason).toBe("circuit-breaker");
    });
  });

  describe("countRecentAutoFixTasks", () => {
    it("counts only incidents with a fix task in the window", () => {
      const { incident } = ingestIncidentSignal(db, { groupingKey: "g1", title: "t" });
      expect(countRecentAutoFixTasks(db)).toBe(0);
      attachFixTask(db, incident.incidentId, "FN-1");
      expect(countRecentAutoFixTasks(db)).toBe(1);
    });

    // FNXC:Monitor 2026-06-16-15:40: the breaker count must ignore in-flight /
    // stranded sentinel placeholders and only count real fix-task links.
    it("ignores sentinel placeholders but counts real fix-task links", () => {
      const { incident: a } = ingestIncidentSignal(db, { groupingKey: "ga", title: "a" });
      const { incident: b } = ingestIncidentSignal(db, { groupingKey: "gb", title: "b" });
      // a is only claimed (sentinel) → must NOT count.
      expect(claimIncidentForFixTask(db, a.incidentId)).toBe(true);
      expect(countRecentAutoFixTasks(db)).toBe(0);
      // b gets a real fix task → counts.
      attachFixTask(db, b.incidentId, "FN-2");
      expect(countRecentAutoFixTasks(db)).toBe(1);
    });
  });

  describe("releaseIncidentFixTaskClaim", () => {
    // FNXC:Monitor 2026-06-16-15:40: a claim must be releasable back to NULL when
    // task creation fails, but the release must never clobber a real attached id.
    it("clears a sentinel claim back to NULL", () => {
      const { incident } = ingestIncidentSignal(db, { groupingKey: "g-rel", title: "t" });
      expect(claimIncidentForFixTask(db, incident.incidentId)).toBe(true);
      const claimed = getIncident(db, incident.incidentId);
      expect(claimed?.fixTaskId).toBe(`${FIX_TASK_CLAIM_SENTINEL_PREFIX}${incident.incidentId}`);

      expect(releaseIncidentFixTaskClaim(db, incident.incidentId)).toBe(true);
      const released = getIncident(db, incident.incidentId);
      expect(released?.fixTaskId).toBeNull();

      // Releasing again is a no-op (nothing to clear).
      expect(releaseIncidentFixTaskClaim(db, incident.incidentId)).toBe(false);
    });

    it("does NOT clear a real attached fix task id", () => {
      const { incident } = ingestIncidentSignal(db, { groupingKey: "g-real", title: "t" });
      claimIncidentForFixTask(db, incident.incidentId);
      attachFixTask(db, incident.incidentId, "FN-99");

      // The release guard (fixTaskId = sentinel) must reject an attached row.
      expect(releaseIncidentFixTaskClaim(db, incident.incidentId)).toBe(false);
      expect(getIncident(db, incident.incidentId)?.fixTaskId).toBe("FN-99");
    });
  });
});
