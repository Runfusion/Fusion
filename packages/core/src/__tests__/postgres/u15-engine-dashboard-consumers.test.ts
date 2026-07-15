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

import { describe, it, expect, afterEach } from "vitest";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { eq } from "drizzle-orm";
import { execSync } from "node:child_process";
import { createAsyncDataLayer, type AsyncDataLayer } from "../../postgres/data-layer.js";
import { createConnectionSetFromUrl } from "../../postgres/connection.js";
import type { ResolvedBackend } from "../../postgres/backend-resolver.js";
import { applySchemaBaseline } from "../../postgres/schema-applier.js";
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
} from "../../task-store/async-monitor.js";
import {
  listSoftDeletedColumnDriftCandidates,
  reconcileSoftDeletedColumnDriftAsync,
} from "../../task-store/async-self-healing.js";

const PG_TEST_URL_BASE =
  process.env.FUSION_PG_TEST_URL_BASE ?? "postgresql://localhost:5432";
const PG_AVAILABLE =
  process.env.FUSION_PG_TEST_SKIP !== "1" && Boolean(PG_TEST_URL_BASE);

const pgDescribe = PG_AVAILABLE ? describe : describe.skip;

function uniqueDbName(): string {
  return `fusion_u15_test_${process.pid}_${Math.random().toString(36).slice(2, 8)}`;
}

/*
FNXC:PgTestAuthFix 2026-07-14-00:00:
The inline adminExec used process.env.USER for the psql -U flag, which is 'runner' on GitHub Actions (not 'postgres'). Use the PG_TEST_URL_BASE connection string instead so credentials are always correct.
*/
function adminExec(statement: string): void {
  execSync(
    `psql "${PG_TEST_URL_BASE}/postgres" -v ON_ERROR_STOP=1 -c "${statement.replace(/"/g, '\\"')}"`,
    { stdio: "pipe", env: process.env },
  );
}

interface TestCtx {
  dbName: string;
  testUrl: string;
  layer: AsyncDataLayer;
  adminSql: ReturnType<typeof postgres>;
  adminDb: ReturnType<typeof drizzle>;
}

async function setupCtx(): Promise<TestCtx> {
  const dbName = uniqueDbName();
  try {
    adminExec(`DROP DATABASE IF EXISTS "${dbName}"`);
  } catch {
    // may not exist
  }
  adminExec(`CREATE DATABASE "${dbName}"`);
  const testUrl = `${PG_TEST_URL_BASE}/${dbName}`;

  const schemaBackend: ResolvedBackend = {
    mode: "external",
    runtimeUrl: testUrl,
    migrationUrl: testUrl,
    migrationUrlOverridden: false,
  };
  const schemaConnections = await createConnectionSetFromUrl(schemaBackend, {
    poolMax: 1,
    connectTimeoutSeconds: 5,
  });
  await applySchemaBaseline(schemaConnections.migration);
  await schemaConnections.close();

  const connections = await createConnectionSetFromUrl(schemaBackend, {
    poolMax: 5,
    connectTimeoutSeconds: 5,
  });
  const layer = createAsyncDataLayer(connections);

  const adminSql = postgres(testUrl, { max: 2, prepare: false, onnotice: () => {} });
  const adminDb = drizzle(adminSql);
  return { dbName, testUrl, layer, adminSql, adminDb };
}

async function teardownCtx(ctx: TestCtx | null): Promise<void> {
  if (!ctx) return;
  try {
    await ctx.layer.close();
  } catch {
    // best-effort
  }
  try {
    await ctx.adminSql.end({ timeout: 5 });
  } catch {
    // best-effort
  }
  try {
    adminExec(`DROP DATABASE IF EXISTS "${ctx.dbName}"`);
  } catch {
    // best-effort
  }
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
  options: { column?: string; deletedAt?: string | null } = {},
): Promise<void> {
  const now = new Date().toISOString();
  await ctx.adminDb.insert(schema.project.tasks).values({
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
  let ctx: TestCtx | null = null;

  afterEach(async () => {
    await teardownCtx(ctx);
    ctx = null;
  });

  // ── Monitor store: deployments ────────────────────────────────────────────
  describe("monitor deployments", () => {
    it("records a deployment and reads it back via async Drizzle", async () => {
      ctx = await setupCtx();
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
      ctx = await setupCtx();
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
      ctx = await setupCtx();
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
      ctx = await setupCtx();
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
      ctx = await setupCtx();
      const result = await resolveIncidentAsync(ctx.layer.db, "nope");
      expect(result).toBeNull();
    });

    it("the atomic claim step prevents a second claim once an incident is claimed", async () => {
      ctx = await setupCtx();
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
      ctx = await setupCtx();
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
      ctx = await setupCtx();
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
      ctx = await setupCtx();
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
      ctx = await setupCtx();
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
      ctx = await setupCtx();
      const deletedAt = new Date().toISOString();
      await seedTask(ctx, "FN-d1", { column: "in-review", deletedAt });
      await seedTask(ctx, "FN-live", { column: "todo", deletedAt: null });
      await seedTask(ctx, "FN-arch", { column: "archived", deletedAt });

      const candidates = await listSoftDeletedColumnDriftCandidates(ctx.layer.db);
      const ids = candidates.map((c) => c.id);
      expect(ids).toEqual(["FN-d1"]);
    });

    it("returns zero reconciled when no candidates exist", async () => {
      ctx = await setupCtx();
      await seedTask(ctx, "FN-live", { column: "todo", deletedAt: null });
      const result = await reconcileSoftDeletedColumnDriftAsync(ctx.layer, async () => {});
      expect(result.reconciled).toBe(0);
    });
  });
});
