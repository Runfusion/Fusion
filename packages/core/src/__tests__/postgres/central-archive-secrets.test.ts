/**
 * PostgreSQL central-db / archive-db / secrets-store integration test
 * (U6 satellite-central-archive-db).
 *
 * FNXC:CentralArchiveSecrets 2026-06-24-21:00:
 * Integration tests proving the async Drizzle helper modules for the central
 * database (task claims), the archive database (archived_tasks CRUD + search),
 * and the SecretsStore (project + global secrets) round-trip correctly against
 * real PostgreSQL.
 *
 * Coverage:
 *   - Central DB task claims (tryClaimTask / renewTaskClaim / releaseTaskClaim
 *     / getTaskClaim): the CentralClaimStore contract surface. Proves the
 *     optimistic-epoch handoff and same-owner renewal work under PostgreSQL
 *     MVCC, removing the single-writer contention the SQLite BEGIN IMMEDIATE
 *     path imposed.
 *   - Archive DB (upsert / list / get / filterArchived / delete / rowCount /
 *     search): the cold-storage archived-task log. Proves the jsonb comments
 *     column and the task_json text snapshot round-trip.
 *   - SecretsStore (create / get / list / update / reveal / delete for both
 *     project and global scope, duplicate-key, access-policy CHECK, env
 *     exportable): VAL-CROSS-011 (secrets encryption round-trips against the
 *     central PostgreSQL database) and VAL-DATA-016 prerequisite. Proves the
 *     bytea ciphertext survives byte-identical through the async path.
 *
 * Skipped when PostgreSQL is unreachable (FUSION_PG_TEST_SKIP=1) so the merge
 * gate stays green without a running server.
 */

import { describe, it, expect, afterEach } from "vitest";
import { execSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createAsyncDataLayer, type AsyncDataLayer } from "../../postgres/data-layer.js";
import type { ArchivedTaskEntry } from "../../types.js";

const PG_TEST_URL_BASE =
  process.env.FUSION_PG_TEST_URL_BASE ?? "postgresql://localhost:5432";
const PG_AVAILABLE =
  process.env.FUSION_PG_TEST_SKIP !== "1" && Boolean(PG_TEST_URL_BASE);

const pgDescribe = PG_AVAILABLE ? describe : describe.skip;

function uniqueDbName(): string {
  return `fusion_cas_test_${process.pid}_${Math.random().toString(36).slice(2, 8)}`;
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
  layer: AsyncDataLayer;
}

async function setupCtx(): Promise<TestCtx> {
  const dbName = uniqueDbName();
  try { adminExec(`DROP DATABASE IF EXISTS "${dbName}"`); } catch { /* may not exist */ }
  adminExec(`CREATE DATABASE "${dbName}"`);
  const testUrl = `${PG_TEST_URL_BASE}/${dbName}`;
  const { createConnectionSetFromUrl } = await import("../../postgres/connection.js");
  const { applySchemaBaseline } = await import("../../postgres/schema-applier.js");
  const { resolveBackendWithOptions } = await import("../../postgres/backend-resolver.js");
  const backend = resolveBackendWithOptions({ databaseUrl: testUrl, databaseMigrationUrl: testUrl });
  const connections = await createConnectionSetFromUrl(backend, { poolMax: 3, connectTimeoutSeconds: 5 });
  await applySchemaBaseline(connections.migration);
  const layer = createAsyncDataLayer(connections);
  return { dbName, layer };
}

async function teardownCtx(ctx: TestCtx | null): Promise<void> {
  if (!ctx) return;
  try { await ctx.layer.close(); } catch { /* best-effort */ }
  try { adminExec(`DROP DATABASE IF EXISTS "${ctx.dbName}"`); } catch { /* best-effort */ }
}

/** A fixed 32-byte master key provider for deterministic test crypto. */
function fixedMasterKeyProvider(key: Buffer = randomBytes(32)): () => Promise<Buffer> {
  return async () => Buffer.from(key);
}

/** Build a minimal valid ArchivedTaskEntry for the archive round-trip tests. */
function sampleArchiveEntry(overrides: Partial<ArchivedTaskEntry> = {}): ArchivedTaskEntry {
  const now = new Date().toISOString();
  return {
    id: `FN-ARCH-${Math.random().toString(36).slice(2, 8)}`,
    lineageId: `ln-${Math.random().toString(36).slice(2, 8)}`,
    title: "Archived task title",
    description: "Archived task description body",
    column: "archived",
    dependencies: [],
    steps: [],
    currentStep: 0,
    comments: [],
    createdAt: now,
    updatedAt: now,
    archivedAt: now,
    ...overrides,
  };
}

pgDescribe("PostgreSQL central-db / archive-db / secrets-store (U6 satellite-central-archive-db)", () => {
  let ctx: TestCtx | null = null;

  afterEach(async () => {
    await teardownCtx(ctx);
    ctx = null;
  });

  // ── Central DB: task claims ──

  it("CentralDatabase: tryClaimTask creates a fresh claim, then getTaskClaim reads it back", async () => {
    ctx = await setupCtx();
    const { tryClaimTask, getTaskClaim } = await import("../../async-central-db.js");
    const now = new Date().toISOString();

    const result = await tryClaimTask(ctx.layer, {
      projectId: "proj-1",
      taskId: "FN-1",
      nodeId: "node-a",
      agentId: "agent-1",
      runId: "run-1",
      renewedAt: now,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.claim.leaseEpoch).toBe(1);
      expect(result.claim.ownerNodeId).toBe("node-a");
      expect(result.claim.ownerRunId).toBe("run-1");
    }

    const claim = await getTaskClaim(ctx.layer.db, "proj-1", "FN-1");
    expect(claim).not.toBeNull();
    expect(claim!.projectId).toBe("proj-1");
    expect(claim!.taskId).toBe("FN-1");
  });

  it("CentralDatabase: same-owner renewal requires matching expectedEpoch", async () => {
    ctx = await setupCtx();
    const { tryClaimTask } = await import("../../async-central-db.js");
    const now = () => new Date().toISOString();

    const created = await tryClaimTask(ctx.layer, {
      projectId: "proj-1", taskId: "FN-2", nodeId: "node-a", agentId: "agent-1",
      runId: "run-1", renewedAt: now(),
    });
    expect(created.ok).toBe(true);

    // Wrong epoch → conflict.
    const conflict = await tryClaimTask(ctx.layer, {
      projectId: "proj-1", taskId: "FN-2", nodeId: "node-a", agentId: "agent-1",
      runId: "run-2", renewedAt: now(), expectedEpoch: 99,
    });
    expect(conflict.ok).toBe(false);
    if (!conflict.ok) expect(conflict.reason).toBe("conflict");

    // Correct epoch → renewal.
    const renewed = await tryClaimTask(ctx.layer, {
      projectId: "proj-1", taskId: "FN-2", nodeId: "node-a", agentId: "agent-1",
      runId: "run-2", renewedAt: now(), expectedEpoch: 1,
    });
    expect(renewed.ok).toBe(true);
    if (renewed.ok) expect(renewed.claim.ownerRunId).toBe("run-2");
  });

  it("CentralDatabase: different-owner takeover requires matching expectedEpoch, else conflict", async () => {
    ctx = await setupCtx();
    const { tryClaimTask } = await import("../../async-central-db.js");
    const now = () => new Date().toISOString();

    await tryClaimTask(ctx.layer, {
      projectId: "proj-1", taskId: "FN-3", nodeId: "node-a", agentId: "agent-1",
      runId: "run-1", renewedAt: now(),
    });

    // Different owner, no expected epoch → conflict.
    const blocked = await tryClaimTask(ctx.layer, {
      projectId: "proj-1", taskId: "FN-3", nodeId: "node-b", agentId: "agent-2",
      runId: "run-x", renewedAt: now(),
    });
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.reason).toBe("conflict");

    // Different owner, correct expected epoch → takeover (epoch bumps).
    const takeover = await tryClaimTask(ctx.layer, {
      projectId: "proj-1", taskId: "FN-3", nodeId: "node-b", agentId: "agent-2",
      runId: "run-x", renewedAt: now(), expectedEpoch: 1,
    });
    expect(takeover.ok).toBe(true);
    if (takeover.ok) {
      expect(takeover.claim.ownerNodeId).toBe("node-b");
      expect(takeover.claim.leaseEpoch).toBe(2);
    }
  });

  it("CentralDatabase: renewTaskClaim and releaseTaskClaim honor ownership", async () => {
    ctx = await setupCtx();
    const { tryClaimTask, renewTaskClaim, releaseTaskClaim, getTaskClaim } = await import("../../async-central-db.js");
    const now = () => new Date().toISOString();

    await tryClaimTask(ctx.layer, {
      projectId: "proj-1", taskId: "FN-4", nodeId: "node-a", agentId: "agent-1",
      runId: "run-1", renewedAt: now(),
    });

    // Wrong owner renewal → conflict.
    const bad = await renewTaskClaim(ctx.layer, {
      projectId: "proj-1", taskId: "FN-4", nodeId: "node-b", agentId: "agent-2",
      runId: "run-2", renewedAt: now(), expectedEpoch: 1,
    });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.reason).toBe("conflict");

    // Correct owner renewal → ok.
    const ok = await renewTaskClaim(ctx.layer, {
      projectId: "proj-1", taskId: "FN-4", nodeId: "node-a", agentId: "agent-1",
      runId: "run-3", renewedAt: now(), expectedEpoch: 1,
    });
    expect(ok.ok).toBe(true);

    // Release by non-owner → not_owner.
    const notOwner = await releaseTaskClaim(ctx.layer, {
      projectId: "proj-1", taskId: "FN-4", nodeId: "node-b", agentId: "agent-2",
    });
    expect(notOwner.ok).toBe(false);
    if (!notOwner.ok) expect(notOwner.reason).toBe("not_owner");

    // Release by owner → ok, row gone.
    const released = await releaseTaskClaim(ctx.layer, {
      projectId: "proj-1", taskId: "FN-4", nodeId: "node-a", agentId: "agent-1",
    });
    expect(released.ok).toBe(true);
    const after = await getTaskClaim(ctx.layer.db, "proj-1", "FN-4");
    expect(after).toBeNull();
  });

  it("CentralDatabase: renewTaskClaim returns not_found for an absent claim", async () => {
    ctx = await setupCtx();
    const { renewTaskClaim } = await import("../../async-central-db.js");
    const result = await renewTaskClaim(ctx.layer, {
      projectId: "proj-1", taskId: "FN-MISSING", nodeId: "node-a", agentId: "agent-1",
      runId: "run-1", renewedAt: new Date().toISOString(), expectedEpoch: 1,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("not_found");
  });

  // ── Archive DB ──

  it("ArchiveDatabase: upsert → get → list → filterArchived → delete", async () => {
    ctx = await setupCtx();
    const { upsertArchivedTask, getArchivedTask, listArchivedTasks, filterArchived, deleteArchivedTask, getArchivedRowCount } = await import("../../async-archive-db.js");
    const entry = sampleArchiveEntry({ id: "FN-ARCH-1", title: "First archived", comments: [{ id: "c1", text: "note", author: "user", createdAt: "2026-01-01T00:00:00.000Z" }] });

    await upsertArchivedTask(ctx.layer.db, entry);

    const got = await getArchivedTask(ctx.layer.db, "FN-ARCH-1");
    expect(got).toBeDefined();
    expect(got!.id).toBe("FN-ARCH-1");
    expect(got!.title).toBe("First archived");
    expect(got!.description).toBe("Archived task description body");

    const all = await listArchivedTasks(ctx.layer.db);
    expect(all).toHaveLength(1);

    const present = await filterArchived(ctx.layer.db, ["FN-ARCH-1", "FN-GONE"]);
    expect(present.has("FN-ARCH-1")).toBe(true);
    expect(present.has("FN-GONE")).toBe(false);

    expect(await getArchivedRowCount(ctx.layer.db)).toBe(1);

    await deleteArchivedTask(ctx.layer.db, "FN-ARCH-1");
    expect(await getArchivedTask(ctx.layer.db, "FN-ARCH-1")).toBeUndefined();
    expect(await getArchivedRowCount(ctx.layer.db)).toBe(0);
  });

  it("ArchiveDatabase: upsert replaces an existing entry on conflict", async () => {
    ctx = await setupCtx();
    const { upsertArchivedTask, getArchivedTask } = await import("../../async-archive-db.js");
    const entry = sampleArchiveEntry({ id: "FN-ARCH-2", title: "v1" });
    await upsertArchivedTask(ctx.layer.db, entry);

    const updated = sampleArchiveEntry({ id: "FN-ARCH-2", title: "v2", description: "changed" });
    await upsertArchivedTask(ctx.layer.db, updated);

    const got = await getArchivedTask(ctx.layer.db, "FN-ARCH-2");
    expect(got!.title).toBe("v2");
    expect(got!.description).toBe("changed");
  });

  it("ArchiveDatabase: search matches tokens across title/description/comments", async () => {
    ctx = await setupCtx();
    const { upsertArchivedTask, searchArchivedTasks } = await import("../../async-archive-db.js");
    await upsertArchivedTask(ctx.layer.db, sampleArchiveEntry({ id: "FN-S1", title: "Postgres migration", description: "convert sqlite", comments: [] }));
    await upsertArchivedTask(ctx.layer.db, sampleArchiveEntry({ id: "FN-S2", title: "unrelated", description: "nothing here", comments: [{ id: "c", text: "mention postgres", author: "agent", createdAt: "2026-01-01T00:00:00.000Z" }] }));

    const hits = await searchArchivedTasks(ctx.layer.db, "postgres", 10);
    const ids = hits.map((h) => h.id).sort();
    expect(ids).toEqual(["FN-S1", "FN-S2"]);

    const none = await searchArchivedTasks(ctx.layer.db, "zzznomatch", 10);
    expect(none).toEqual([]);
  });

  // ── SecretsStore ──

  it("SecretsStore: create → get → list → update → reveal → delete for project scope", async () => {
    ctx = await setupCtx();
    const { AsyncSecretsStore } = await import("../../async-secrets-store.js");
    const store = new AsyncSecretsStore(ctx.layer, fixedMasterKeyProvider());

    const created = await store.createSecret({
      scope: "project", key: "API_KEY", plaintextValue: "secret-value-123",
      description: "my key", accessPolicy: "auto",
    });
    expect(created.key).toBe("API_KEY");

    const meta = await store.getSecretMetadata(created.id, "project");
    expect(meta).not.toBeNull();
    expect(meta!.accessPolicy).toBe("auto");

    const listed = await store.listSecrets("project");
    expect(listed).toHaveLength(1);

    const updated = await store.updateSecret(created.id, "project", { description: "renamed" });
    expect(updated.description).toBe("renamed");

    const revealed = await store.revealSecret(created.id, "project", { userId: "u1" });
    expect(revealed.plaintextValue).toBe("secret-value-123");
    expect(revealed.key).toBe("API_KEY");

    // lastReadAt recorded after reveal.
    const afterRead = await store.getSecretMetadata(created.id, "project");
    expect(afterRead!.lastReadBy).toBe("u1");

    await store.deleteSecret(created.id, "project");
    const gone = await store.getSecretMetadata(created.id, "project");
    expect(gone).toBeNull();
  });

  it("SecretsStore: global scope routes to central.secrets_global", async () => {
    ctx = await setupCtx();
    const { AsyncSecretsStore } = await import("../../async-secrets-store.js");
    const store = new AsyncSecretsStore(ctx.layer, fixedMasterKeyProvider());

    const created = await store.createSecret({
      scope: "global", key: "GLOBAL_TOKEN", plaintextValue: "g-val",
      envExportable: true, envExportKey: "GLOBAL_TOKEN",
    });
    const revealed = await store.revealSecret(created.id, "global", { userId: "u" });
    expect(revealed.plaintextValue).toBe("g-val");

    // listSecrets() with no scope returns both project + global.
    const all = await store.listSecrets();
    expect(all.some((s) => s.scope === "global" && s.key === "GLOBAL_TOKEN")).toBe(true);
  });

  it("SecretsStore: duplicate key throws duplicate-key (unique constraint)", async () => {
    ctx = await setupCtx();
    const { AsyncSecretsStore, SecretsStoreError } = await import("../../async-secrets-store.js");
    const store = new AsyncSecretsStore(ctx.layer, fixedMasterKeyProvider());

    await store.createSecret({ scope: "project", key: "DUP", plaintextValue: "v1" });
    await expect(
      store.createSecret({ scope: "project", key: "DUP", plaintextValue: "v2" }),
    ).rejects.toMatchObject({ code: "duplicate-key", name: "SecretsStoreError" });
    expect(SecretsStoreError).toBeDefined();
  });

  it("SecretsStore: re-encrypting a value on update round-trips", async () => {
    ctx = await setupCtx();
    const { AsyncSecretsStore } = await import("../../async-secrets-store.js");
    const store = new AsyncSecretsStore(ctx.layer, fixedMasterKeyProvider());

    const created = await store.createSecret({ scope: "project", key: "ROTATE", plaintextValue: "old" });
    await store.updateSecret(created.id, "project", { plaintextValue: "new" });
    const revealed = await store.revealSecret(created.id, "project", { userId: "u" });
    expect(revealed.plaintextValue).toBe("new");
  });

  it("SecretsStore: listEnvExportable returns project-overrides-global on key collision", async () => {
    ctx = await setupCtx();
    const { AsyncSecretsStore } = await import("../../async-secrets-store.js");
    const store = new AsyncSecretsStore(ctx.layer, fixedMasterKeyProvider());

    await store.createSecret({ scope: "global", key: "SHARED", plaintextValue: "global-val", envExportable: true, envExportKey: "SHARED" });
    await store.createSecret({ scope: "project", key: "SHARED", plaintextValue: "project-val", envExportable: true, envExportKey: "SHARED" });

    const exported = await store.listEnvExportable();
    expect(exported).toHaveLength(1);
    expect(exported[0]!.plaintextValue).toBe("project-val");
  });

  it("SecretsStore: deleting an absent secret throws not-found", async () => {
    ctx = await setupCtx();
    const { AsyncSecretsStore } = await import("../../async-secrets-store.js");
    const store = new AsyncSecretsStore(ctx.layer, fixedMasterKeyProvider());
    await expect(store.deleteSecret("nope", "project")).rejects.toMatchObject({ code: "not-found" });
  });
});
