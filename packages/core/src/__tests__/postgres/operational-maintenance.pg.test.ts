/**
 * FNXC:PostgresRetention 2026-07-14-18:15:
 * Operational retention must delete only rows older than the cutoff in the bound project. Newer rows and equally old rows owned by another project must survive the same maintenance pass.
 */
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { eq, inArray } from "drizzle-orm";
import * as schema from "../../postgres/schema/index.js";
import { pruneOperationalLogsAsync } from "../../task-store/async/async-maintenance.js";
import {
  createSharedPgTaskStoreTestHarness,
  pgDescribe,
  type SharedPgTaskStoreHarness,
} from "../../__test-utils__/pg-test-harness.js";

pgDescribe("PostgreSQL operational maintenance", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({ prefix: "fusion_maintenance" });
  beforeAll(h.beforeAll);
  beforeEach(h.beforeEach);
  afterEach(h.afterEach);
  afterAll(h.afterAll);

  it("prunes expired rows only from the bound project", async () => {
    const old = new Date(Date.now() - 10 * 86_400_000).toISOString();
    const recent = new Date().toISOString();
    await h.adminDb().insert(schema.project.activityLog).values([
      { projectId: "project-a", id: "a-old", timestamp: old, type: "test", details: "old" },
      { projectId: "project-a", id: "a-new", timestamp: recent, type: "test", details: "new" },
      { projectId: "project-b", id: "b-old", timestamp: old, type: "test", details: "other project" },
    ]);

    const result = await pruneOperationalLogsAsync({ ...h.layer(), projectId: "project-a" }, 86_400_000);
    expect(result.deletedByTable.activityLog).toBe(1);
    const remaining = await h.adminDb()
      .select({ id: schema.project.activityLog.id })
      .from(schema.project.activityLog)
      .where(inArray(schema.project.activityLog.id, ["a-old", "a-new", "b-old"]));
    expect(remaining.map((row) => row.id).sort()).toEqual(["a-new", "b-old"]);

    await h.adminDb().delete(schema.project.activityLog).where(eq(schema.project.activityLog.type, "test"));
  });

  it("returns an aggregate delete count for a large expired set", async () => {
    const old = new Date(Date.now() - 10 * 86_400_000).toISOString();
    await h.adminDb().insert(schema.project.activityLog).values(
      Array.from({ length: 120 }, (_, index) => ({
        projectId: "project-a",
        id: `aggregate-old-${index}`,
        timestamp: old,
        type: "aggregate-test",
        details: "expired",
      })),
    );
    const result = await pruneOperationalLogsAsync({ ...h.layer(), projectId: "project-a" }, 86_400_000);
    expect(result.deletedByTable.activityLog).toBe(120);
    expect(result.deletedTotal).toBeGreaterThanOrEqual(120);
  });

  it("covers every operational table while retaining recent rows and each agent's newest revision", async () => {
    /*
    FNXC:PostgresRetentionCoverage 2026-07-14-18:55:
    Retention is an operational contract for every migrated history table, not only activity_log. Exercise every delete branch with real PostgreSQL rows so column drift and project-scope regressions cannot silently disable cleanup.
    */
    const old = new Date(Date.now() - 10 * 86_400_000).toISOString();
    const lessOld = new Date(Date.now() - 9 * 86_400_000).toISOString();
    const recent = new Date().toISOString();
    const projectId = h.layer().projectId?.trim() || "__legacy_unscoped__";
    const task = await h.store().createTask({ description: "Retention owner task" });
    await h.adminDb().insert(schema.project.agents).values({
      projectId,
      id: "retention-agent",
      name: "Retention agent",
      role: "executor",
      createdAt: old,
      updatedAt: recent,
    });
    await h.adminDb().insert(schema.project.runAuditEvents).values([
      { id: "audit-old", timestamp: old, taskId: task.id, agentId: "retention-agent", runId: "run", domain: "task", mutationType: "test", target: task.id },
      { id: "audit-new", timestamp: recent, taskId: task.id, agentId: "retention-agent", runId: "run", domain: "task", mutationType: "test", target: task.id },
    ]);
    await h.adminDb().insert(schema.project.agentHeartbeats).values([
      { projectId, agentId: "retention-agent", timestamp: old, status: "idle", runId: "run-old" },
      { projectId, agentId: "retention-agent", timestamp: recent, status: "idle", runId: "run-new" },
    ]);
    await h.adminDb().insert(schema.project.agentRuns).values([
      { projectId, id: "agent-run-old", agentId: "retention-agent", data: {}, startedAt: old, endedAt: old, status: "complete" },
      { projectId, id: "agent-run-new", agentId: "retention-agent", data: {}, startedAt: recent, endedAt: recent, status: "complete" },
      { projectId, id: "agent-run-active", agentId: "retention-agent", data: {}, startedAt: old, endedAt: null, status: "running" },
    ]);
    await h.adminDb().insert(schema.project.agentConfigRevisions).values([
      { projectId, id: "revision-old", agentId: "retention-agent", data: {}, createdAt: old },
      { projectId, id: "revision-newest", agentId: "retention-agent", data: {}, createdAt: lessOld },
    ]);
    await h.adminDb().insert(schema.project.usageEvents).values([
      { projectId, ts: old, kind: "test", taskId: task.id },
      { projectId, ts: recent, kind: "test", taskId: task.id },
    ]);

    const result = await pruneOperationalLogsAsync({ ...h.layer(), projectId }, 86_400_000);

    expect(result.deletedByTable).toMatchObject({
      runAuditEvents: 1,
      agentHeartbeats: 1,
      agentRuns: 1,
      agentConfigRevisions: 1,
      usageEvents: 1,
    });
    expect((await h.adminDb().select().from(schema.project.runAuditEvents).where(inArray(schema.project.runAuditEvents.id, ["audit-old", "audit-new"]))).map((row) => row.id)).toEqual(["audit-new"]);
    expect((await h.adminDb().select().from(schema.project.agentRuns).where(inArray(schema.project.agentRuns.id, ["agent-run-old", "agent-run-new", "agent-run-active"]))).map((row) => row.id).sort()).toEqual(["agent-run-active", "agent-run-new"]);
    expect((await h.adminDb().select().from(schema.project.agentConfigRevisions).where(inArray(schema.project.agentConfigRevisions.id, ["revision-old", "revision-newest"]))).map((row) => row.id)).toEqual(["revision-newest"]);
  });

  it("warns before using the legacy project sentinel and reports camelCase metric keys", async () => {
    /*
    FNXC:PostgresRetention 2026-07-14-21:55:
    An unbound retention pass remains compatible with legacy-unscoped data, but operators must see the scope fallback and receive the same camelCase metric naming used by every other maintenance table.
    */
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const result = await pruneOperationalLogsAsync({ ...h.layer(), projectId: undefined }, 86_400_000);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("legacy unscoped project sentinel"));
      expect(result.deletedByTable).toHaveProperty("usageEvents");
      expect(result.deletedByTable).not.toHaveProperty("usage_events");
    } finally {
      warn.mockRestore();
    }
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])("treats invalid retention %s as a no-op", async (retentionMs) => {
    const old = new Date(Date.now() - 10 * 86_400_000).toISOString();
    const id = `invalid-retention-${String(retentionMs)}`;
    await h.adminDb().insert(schema.project.activityLog).values({
      projectId: "project-a",
      id,
      timestamp: old,
      type: "invalid-retention-test",
      details: "must survive",
    });

    expect(await pruneOperationalLogsAsync({ ...h.layer(), projectId: "project-a" }, retentionMs)).toEqual({
      deletedByTable: {},
      deletedTotal: 0,
    });
    expect(await h.adminDb().select().from(schema.project.activityLog).where(eq(schema.project.activityLog.id, id))).toHaveLength(1);
  });
});
