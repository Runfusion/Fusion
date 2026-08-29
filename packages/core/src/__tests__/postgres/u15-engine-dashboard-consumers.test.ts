/**
 * U15 engine + dashboard consumers PostgreSQL integration tests.
 *
 * FNXC:EngineDashboardConsumers 2026-06-24-14:30:
 * Integration tests proving the async monitor-store and self-healing helpers
 * (U15) preserve the monitor-stage and soft-delete-column-drift semantics
 * against a real PostgreSQL instance. These helpers replace the direct sync
 * `Database`/`prepare()` call sites in `packages/dashboard/src/monitor-store.ts`
 * and `packages/engine/src/self-healing.ts`.
 *
 * Coverage targets:
 *   - Dashboard monitor deployments/incidents read and write via the async path.
 *   - The storm-guard atomic fix-task claim closes the create-then-link race
 *     (exactly one concurrent caller wins).
 *   - The circuit-breaker count ignores stranded sentinel placeholders.
 *   - Engine self-healing reconcileSoftDeletedColumnDrift reconciles soft-deleted
 *     non-archived tasks to archived, recording a per-row audit, and never moves
 *     live tasks (FN-5147 invariant).
 *
 * Skipped when PostgreSQL is unreachable (FUSION_PG_TEST_SKIP=1) so the merge
 * gate stays green without a running server.
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from "vitest";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { and, eq } from "drizzle-orm";
import type { AsyncDataLayer } from "../../postgres/data-layer.js";
import {
  pgDescribe,
  createSharedPgTaskStoreTestHarness,
  type SharedPgTaskStoreHarness,
} from "../../__test-utils__/pg-test-harness.js";
import * as schema from "../../postgres/schema/index.js";
import {
  recordDeploymentAsync,
  getOpenIncidentByGroupingKeyAsync,
  getIncidentAsync,
  ingestIncidentSignalAsync,
  resolveIncidentAsync,
  claimIncidentForFixTaskAsync,
  attachFixTaskAsync,
  releaseIncidentFixTaskClaimAsync,
  countRecentAutoFixTasksAsync,
  countOpenIncidentsAsync,
  decideStormGuard,
  DEFAULT_STORM_GUARD,
  FIX_TASK_CLAIM_SENTINEL_PREFIX,
} from "../../task-store/async/async-monitor.js";
import {
  listSoftDeletedColumnDriftCandidates,
  reconcileSoftDeletedColumnDriftAsync,
} from "../../task-store/async/async-self-healing.js";

/*
FNXC:PgTestHarnessAdoption 2026-08-16-03:45:
Migrated off the hand-rolled per-test CREATE DATABASE + applySchemaBaseline scaffolding
(~3-4s of DDL per test) onto the shared PG harness: one template-cloned database per file
with TRUNCATE-based reset per test. The database setup here was scaffolding, not the
subject under test (the async monitor-store and self-healing helpers are), and every
assertion is unchanged.
*/
interface TestCtx {
  layer: AsyncDataLayer;
  adminDb: PostgresJsDatabase;
}

/**
 * FNXC:EngineDashboardConsumers 2026-06-24-14:35:
 * Insert a raw task row directly via the admin Drizzle instance for the
 * self-healing test. The self-healing reconciler reads/writes the `tasks` table
 * directly (not through the task-store serialization context), so a raw insert
 * is the faithful seed.
 */
async function seedTask(
  ctx: TestCtx,
  id: string,
  options: { column?: string; deletedAt?: string | null; projectId?: string } = {},
): Promise<void> {
  const now = new Date().toISOString();
  await ctx.adminDb.insert(schema.project.tasks).values({
    projectId: options.projectId ?? "__legacy_unscoped__",
    id,
    description: `seeded ${id}`,
    column: options.column ?? "todo",
    currentStep: 0,
    createdAt: now,
    updatedAt: now,
    deletedAt: options.deletedAt ?? null,
  } as never);
}

pgDescribe("U15 engine + dashboard consumers (PostgreSQL)", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({
    prefix: "fusion_u15_test",
  });
  let ctx: TestCtx;

  beforeAll(h.beforeAll);
  beforeEach(async () => {
    await h.beforeEach();
    ctx = { layer: h.layer(), adminDb: h.adminDb() };
  });
  afterEach(h.afterEach);
  afterAll(h.afterAll);

  // ── Monitor store: deployments ────────────────────────────────────────────
  describe("monitor deployments", () => {
    it("records a deployment and reads it back via async Drizzle", async () => {
      const deployment = await recordDeploymentAsync(ctx.layer.db, {
        service: "api",
        environment: "prod",
        version: "1.2.3",
        deployedAt: "2026-06-24T10:00:00.000Z",
        meta: { commit: "abc123" },
      });
      expect(deployment.deploymentId).toBeTruthy();
      expect(deployment.service).toBe("api");
      expect(deployment.meta).toEqual({ commit: "abc123" });

      const reloaded = await getIncidentAsync(ctx.layer.db, "nope");
      expect(reloaded).toBeNull();
    });

    it("is idempotent by deploymentId (upsert, not duplicate)", async () => {
      const first = await recordDeploymentAsync(ctx.layer.db, {
        deploymentId: "dep-1",
        status: "deployed",
        deployedAt: "2026-06-24T10:00:00.000Z",
      });
      const second = await recordDeploymentAsync(ctx.layer.db, {
        deploymentId: "dep-1",
        status: "rolled-back",
        deployedAt: "2026-06-24T11:00:00.000Z",
      });
      expect(first.deploymentId).toBe("dep-1");
      expect(second.deploymentId).toBe("dep-1");
      expect(second.status).toBe("rolled-back");
      expect(second.deployedAt).toBe("2026-06-24T11:00:00.000Z");
    });
  });

  // ── Monitor store: incidents + storm guard ────────────────────────────────
  describe("monitor incidents + storm guard", () => {
    it("opens an incident then resolves it", async () => {
      const { incident, created } = await ingestIncidentSignalAsync(ctx.layer.db, {
        groupingKey: "g1",
        title: "API 500s",
        at: "2026-06-24T10:00:00.000Z",
      });
      expect(created).toBe(true);
      expect(incident.status).toBe("open");
      expect(incident.meta?.occurrences).toBe(1);

      const open = await getOpenIncidentByGroupingKeyAsync(ctx.layer.db, "g1");
      expect(open?.incidentId).toBe(incident.incidentId);

      const resolved = await resolveIncidentAsync(ctx.layer.db, "g1", "2026-06-24T10:30:00.000Z");
      expect(resolved?.status).toBe("resolved");
      expect(resolved?.resolvedAt).toBe("2026-06-24T10:30:00.000Z");

      // Resolved incident is no longer the open incident.
      const openAfter = await getOpenIncidentByGroupingKeyAsync(ctx.layer.db, "g1");
      expect(openAfter).toBeNull();

      const count = await countOpenIncidentsAsync(ctx.layer.db);
      expect(count).toBe(0);
    });

    it("absorbs a burst sharing one groupingKey into ONE open incident", async () => {
      for (let i = 0; i < 100; i += 1) {
        await ingestIncidentSignalAsync(ctx.layer.db, {
          groupingKey: "g-burst",
          title: "Flood",
        });
      }
      const open = await getOpenIncidentByGroupingKeyAsync(ctx.layer.db, "g-burst");
      expect(open).not.toBeNull();
      expect(open?.meta?.occurrences).toBe(100);
    });

    it("resolveIncident returns null when nothing is open", async () => {
      const result = await resolveIncidentAsync(ctx.layer.db, "nope");
      expect(result).toBeNull();
    });

    it("the atomic claim step prevents a second claim once an incident is claimed", async () => {
      const { incident } = await ingestIncidentSignalAsync(ctx.layer.db, {
        groupingKey: "g-claim",
        title: "Claim me",
      });
      // First claim wins.
      expect(await claimIncidentForFixTaskAsync(ctx.layer.db, incident.incidentId)).toBe(true);
      // A second concurrent caller loses the claim (fixTaskId no longer NULL).
      expect(await claimIncidentForFixTaskAsync(ctx.layer.db, incident.incidentId)).toBe(false);

      const claimed = await getIncidentAsync(ctx.layer.db, incident.incidentId);
      expect(claimed?.fixTaskId).toBe(`${FIX_TASK_CLAIM_SENTINEL_PREFIX}${incident.incidentId}`);

      // Attaching the real task id overwrites the sentinel.
      await attachFixTaskAsync(ctx.layer.db, incident.incidentId, "FN-1");
      const attached = await getIncidentAsync(ctx.layer.db, incident.incidentId);
      expect(attached?.fixTaskId).toBe("FN-1");
    });

    it("releases a stranded sentinel claim back to NULL but never clobbers a real id", async () => {
      const { incident } = await ingestIncidentSignalAsync(ctx.layer.db, {
        groupingKey: "g-rel",
        title: "t",
      });
      expect(await claimIncidentForFixTaskAsync(ctx.layer.db, incident.incidentId)).toBe(true);

      // Release the sentinel → clears back to NULL.
      expect(await releaseIncidentFixTaskClaimAsync(ctx.layer.db, incident.incidentId)).toBe(true);
      const released = await getIncidentAsync(ctx.layer.db, incident.incidentId);
      expect(released?.fixTaskId).toBeNull();

      // Now claim + attach a real id; release must NOT clobber it.
      await claimIncidentForFixTaskAsync(ctx.layer.db, incident.incidentId);
      await attachFixTaskAsync(ctx.layer.db, incident.incidentId, "FN-99");
      expect(await releaseIncidentFixTaskClaimAsync(ctx.layer.db, incident.incidentId)).toBe(false);
      const real = await getIncidentAsync(ctx.layer.db, incident.incidentId);
      expect(real?.fixTaskId).toBe("FN-99");
    });

    it("countRecentAutoFixTasks ignores sentinel placeholders but counts real links", async () => {
      const { incident: a } = await ingestIncidentSignalAsync(ctx.layer.db, { groupingKey: "ga", title: "a" });
      const { incident: b } = await ingestIncidentSignalAsync(ctx.layer.db, { groupingKey: "gb", title: "b" });
      // a is only claimed (sentinel) → must NOT count.
      await claimIncidentForFixTaskAsync(ctx.layer.db, a.incidentId);
      expect(await countRecentAutoFixTasksAsync(ctx.layer.db)).toBe(0);
      // b gets a real fix task → counts.
      await attachFixTaskAsync(ctx.layer.db, b.incidentId, "FN-2");
      expect(await countRecentAutoFixTasksAsync(ctx.layer.db)).toBe(1);
    });

    it("decideStormGuard preserves threshold, sustained, absorb, and circuit-breaker gates", async () => {
      const incident = (await ingestIncidentSignalAsync(ctx.layer.db, { groupingKey: "g", title: "t" })).incident;
      const now = Date.parse("2026-06-24T10:00:00.000Z");

      // Single flapping firing → suppress (gate not met).
      const suppressed = decideStormGuard(
        { ...incident, meta: { occurrences: 1, firstFiredAt: "2026-06-24T10:00:00.000Z" } },
        0,
        DEFAULT_STORM_GUARD,
        now,
      );
      expect(suppressed.action).toBe("suppress");

      // Threshold met → open.
      const opened = decideStormGuard(
        { ...incident, meta: { occurrences: DEFAULT_STORM_GUARD.threshold, firstFiredAt: "2026-06-24T10:00:00.000Z" } },
        0,
        DEFAULT_STORM_GUARD,
        now,
      );
      expect(opened.action).toBe("open-fix-task");

      // Already has a fix task → absorb.
      const absorbed = decideStormGuard(
        { ...incident, fixTaskId: "FN-1", meta: { occurrences: 50 } },
        0,
        DEFAULT_STORM_GUARD,
        now,
      );
      expect(absorbed.action).toBe("absorb");

      // Circuit breaker tripped → suppress.
      const breaker = decideStormGuard(
        { ...incident, meta: { occurrences: 5, firstFiredAt: "2026-06-24T10:00:00.000Z" } },
        DEFAULT_STORM_GUARD.maxTasksPerWindow,
        DEFAULT_STORM_GUARD,
        now,
      );
      expect(breaker.action).toBe("suppress");
    });
  });

  // ── Self-healing: reconcileSoftDeletedColumnDrift ─────────────────────────
  describe("self-healing reconcileSoftDeletedColumnDrift", () => {
    it("reconciles soft-deleted non-archived tasks to archived and records an audit per row", async () => {
      const deletedAt = new Date().toISOString();
      // Soft-deleted tasks that drifted off archived.
      await seedTask(ctx, "FN-drift-1", { column: "in-review", deletedAt });
      await seedTask(ctx, "FN-drift-2", { column: "todo", deletedAt });
      // Live task — must NOT be moved (FN-5147 invariant).
      await seedTask(ctx, "FN-live", { column: "in-review", deletedAt: null });
      // Already-archived soft-deleted task — no-op.
      await seedTask(ctx, "FN-archived", { column: "archived", deletedAt });

      const audited: Array<{ id: string; previousColumn: string }> = [];
      const result = await reconcileSoftDeletedColumnDriftAsync(ctx.layer, async (c) => {
        audited.push(c);
      });

      expect(result.reconciled).toBe(2);
      expect(audited).toEqual(
        expect.arrayContaining([
          { id: "FN-drift-1", previousColumn: "in-review" },
          { id: "FN-drift-2", previousColumn: "todo" },
        ]),
      );

      // The drifted tasks are now archived.
      const drift1 = await ctx.adminDb.select().from(schema.project.tasks).where(eq(schema.project.tasks.id, "FN-drift-1"));
      const drift2 = await ctx.adminDb.select().from(schema.project.tasks).where(eq(schema.project.tasks.id, "FN-drift-2"));
      expect(drift1[0]?.column).toBe("archived");
      expect(drift2[0]?.column).toBe("archived");

      // The live task is untouched.
      const live = await ctx.adminDb.select().from(schema.project.tasks).where(eq(schema.project.tasks.id, "FN-live"));
      expect(live[0]?.column).toBe("in-review");
      expect(live[0]?.deletedAt).toBeNull();

      // The already-archived task is untouched (no audit).
      const archived = await ctx.adminDb.select().from(schema.project.tasks).where(eq(schema.project.tasks.id, "FN-archived"));
      expect(archived[0]?.column).toBe("archived");
      expect(audited.find((a) => a.id === "FN-archived")).toBeUndefined();
    });

    it("lists only soft-deleted non-archived candidates", async () => {
      const deletedAt = new Date().toISOString();
      await seedTask(ctx, "FN-d1", { column: "in-review", deletedAt });
      await seedTask(ctx, "FN-live", { column: "todo", deletedAt: null });
      await seedTask(ctx, "FN-arch", { column: "archived", deletedAt });

      const candidates = await listSoftDeletedColumnDriftCandidates(ctx.layer.db);
      const ids = candidates.map((c) => c.id);
      expect(ids).toEqual(["FN-d1"]);
    });

    it("scopes drift reconciliation to the data layer project partition", async () => {
      const deletedAt = new Date().toISOString();
      await seedTask(ctx, "FN-shared", { column: "todo", deletedAt, projectId: "project-a" });
      await seedTask(ctx, "FN-shared", { column: "in-review", deletedAt, projectId: "project-b" });
      const projectALayer = { ...ctx.layer, projectId: "project-a" } as AsyncDataLayer;

      const audited: Array<{ id: string; previousColumn: string }> = [];
      const result = await reconcileSoftDeletedColumnDriftAsync(projectALayer, async (candidate) => {
        audited.push(candidate);
      });

      expect(result.reconciled).toBe(1);
      expect(audited).toEqual([{ id: "FN-shared", previousColumn: "todo" }]);
      const projectARow = await ctx.adminDb.select().from(schema.project.tasks).where(and(
        eq(schema.project.tasks.projectId, "project-a"),
        eq(schema.project.tasks.id, "FN-shared"),
      ));
      const projectBRow = await ctx.adminDb.select().from(schema.project.tasks).where(and(
        eq(schema.project.tasks.projectId, "project-b"),
        eq(schema.project.tasks.id, "FN-shared"),
      ));
      expect(projectARow[0]?.column).toBe("archived");
      expect(projectBRow[0]?.column).toBe("in-review");
    });

    it("returns zero reconciled when no candidates exist", async () => {
      await seedTask(ctx, "FN-live", { column: "todo", deletedAt: null });
      const result = await reconcileSoftDeletedColumnDriftAsync(ctx.layer, async () => {});
      expect(result.reconciled).toBe(0);
    });
  });
});
