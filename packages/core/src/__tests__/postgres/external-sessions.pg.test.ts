import { randomBytes } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { createSharedPgTaskStoreTestHarness, pgDescribe } from "../../__test-utils__/pg-test-harness.js";
import { externalSessionDigest, externalSessionIngestionSchema } from "../../external-sessions/contract.js";
import { ExternalSessionStore } from "../../external-sessions/store.js";
import { externalSessions, externalSessionStreams, externalSessionHosts, tasks } from "../../postgres/schema/project.js";
import { applySchemaBaseline } from "../../postgres/schema-applier.js";
import type { AsyncDataLayer } from "../../postgres/data-layer.js";

const principal = { projectId: "external-test", hostId: "host-1" };
const envelope = (sequence = 1, revision = sequence) => ({ schemaVersion: 1, streamId: "spool", sequence,
  eventId: `event-${sequence}`, collectorVersion: "1.0",
  session: { provider: "runtime", nativeSessionId: "native-1", revision, activity: "working",
    observedAt: "2026-09-17T00:00:00Z", title: "Session", projectPath: "/same/path" } });

pgDescribe("external sessions: durable observation ingestion", () => {
  const h = createSharedPgTaskStoreTestHarness({ prefix: "fusion_external", projectId: principal.projectId });
  const store = () => new ExternalSessionStore(h.layer(), principal);
  beforeAll(h.beforeAll); beforeEach(h.beforeEach); afterEach(h.afterEach); afterAll(h.afterAll);

  it("deduplicates response-loss replay after reopening and never creates tasks or heartbeat", async () => {
    const first = await store().ingest(envelope());
    const replay = await store().ingest(envelope());
    expect(first.applied).toBe(true);
    expect(replay).toEqual({ ...first, applied: false });
    expect(await h.layer().db.select().from(externalSessions)).toHaveLength(1);
    expect(await h.layer().db.select().from(tasks)).toHaveLength(0);
    expect((await store().getHost())?.lastHeartbeatAt).toBeNull();
    expect((await store().get(first.sessionId))?.origin).toBe("observed");
  });

  it("acknowledges late revisions without regressing state and ignores old delivery positions", async () => {
    const first = await store().ingest(envelope(1, 10));
    expect((await store().ingest(envelope(2, 2))).applied).toBe(false);
    expect((await store().ingest(envelope(1, 1))).acknowledgedSequence).toBe(2);
    expect((await store().get(first.sessionId))?.revision).toBe(10);
    expect((await store().ingest(envelope(3, 11))).applied).toBe(true);
    expect((await store().get(first.sessionId))?.revision).toBe(11);
  });

  it("returns conflicts for gaps, changed delivery positions and changed same-revision snapshots", async () => {
    await expect(store().ingest(envelope(2))).rejects.toMatchObject({ code: "sequence-gap", acknowledgedSequence: 0 });
    await store().ingest(envelope());
    await expect(store().ingest({ ...envelope(), eventId: "different" })).rejects.toMatchObject({ code: "sequence-conflict" });
    const conflicting = envelope(2, 1); conflicting.session.title = "changed";
    await expect(store().ingest(conflicting)).rejects.toMatchObject({ code: "revision-conflict", acknowledgedSequence: 1 });
    expect((await store().ingest(envelope(2, 1))).acknowledgedSequence).toBe(2);
  });

  it("serializes concurrent retries and cross-stream revisions", async () => {
    const results = await Promise.all([store().ingest(envelope()), store().ingest(envelope())]);
    expect(results.filter(row => row.applied)).toHaveLength(1);
    await Promise.all([store().ingest(envelope(2, 20)), store().ingest({ ...envelope(1, 10), streamId: "import" })]);
    expect((await store().get(results[0].sessionId))?.revision).toBe(20);
  });

  it("commits acknowledgement with the snapshot and rolls both back on durability failure", async () => {
    await h.adminDb().execute(sql.raw(`CREATE FUNCTION public.fail_external_ack() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test ack failure'; END $$;
      CREATE TRIGGER fail_external_ack BEFORE UPDATE ON project.external_session_streams FOR EACH ROW EXECUTE FUNCTION public.fail_external_ack();`));
    try {
      await expect(store().ingest(envelope())).rejects.toThrow();
      expect(await h.layer().db.select().from(externalSessions)).toHaveLength(0);
      expect(await h.layer().db.select().from(externalSessionStreams)).toHaveLength(0);
    } finally {
      await h.adminDb().execute(sql.raw("DROP TRIGGER fail_external_ack ON project.external_session_streams; DROP FUNCTION public.fail_external_ack();"));
    }
    expect((await store().ingest(envelope())).applied).toBe(true);
  });

  it("separates native identities despite equal titles/paths and redacts display secrets", async () => {
    const a = await store().ingest(envelope());
    const other = envelope(2); other.session.nativeSessionId = "native-2";
    const b = await store().ingest(other);
    expect(a.sessionId).not.toBe(b.sessionId);
    const fixture = randomBytes(32).toString("hex");
    const secret = envelope(3); secret.session.title = `Bearer ${fixture}`;
    secret.session.projectPath = `/test/password=${fixture}`;
    await store().ingest(secret);
    const saved = await store().get(a.sessionId);
    expect(saved?.observation.title).toBe("Bearer [REDACTED]");
    expect(saved?.observation.projectPath).not.toContain(fixture);
    const raw = externalSessionIngestionSchema.parse(secret);
    expect(saved?.observationDigest).toBe(externalSessionDigest(saved!.observation));
    expect(saved?.observationDigest).not.toBe(externalSessionDigest(raw.session));
    const [stream] = await h.layer().db.select().from(externalSessionStreams);
    expect(stream.lastEventDigest).toBe(externalSessionDigest({ ...raw, session: saved!.observation }));
    expect(stream.lastEventDigest).not.toBe(externalSessionDigest(raw));
    // Different removed secret bytes have the same persisted snapshot and replay fingerprint.
    const equivalent = structuredClone(secret);
    const replacement = randomBytes(32).toString("hex");
    equivalent.session.title = `Bearer ${replacement}`;
    equivalent.session.projectPath = `/test/password=${replacement}`;
    expect((await store().ingest(equivalent)).applied).toBe(false);
    expect((await store().ingest({ ...equivalent, sequence: 4, eventId: "redacted-revision-retry" })).applied).toBe(false);
  });

  it("records server-receipt heartbeat monotonically without modifying observations", async () => {
    const observation = await store().ingest(envelope());
    const heartbeat = { schemaVersion: 1, collectorVersion: "2.0" };
    await store().heartbeat(heartbeat, "2026-09-17T00:01:00.000Z");
    await store().heartbeat(heartbeat, "2026-09-17T00:00:00.000Z");
    expect((await store().getHost())?.lastHeartbeatAt).toBe("2026-09-17T00:01:00.000Z");
    expect((await store().get(observation.sessionId))?.observation.activity).toBe("working");
  });

  it("enforces explicit project/host predicates even on an owner-connected layer", async () => {
    const ownerLayer = (projectId: string): AsyncDataLayer => ({ ...h.layer(), projectId,
      db: h.adminDb(), transactionImmediate: callback => h.adminDb().transaction(callback) });
    const a = new ExternalSessionStore(ownerLayer("project-a"), { projectId: "project-a", hostId: "shared-host" });
    const b = new ExternalSessionStore(ownerLayer("project-b"), { projectId: "project-b", hostId: "shared-host" });
    const first = await a.ingest(envelope());
    const second = await b.ingest(envelope());
    expect(second.sessionId).not.toBe(first.sessionId);
    expect(await b.get(first.sessionId)).toBeNull();
    const otherHost = new ExternalSessionStore(ownerLayer("project-a"), { projectId: "project-a", hostId: "other-host" });
    expect(await otherHost.get(first.sessionId)).toBeNull();
    expect(() => new ExternalSessionStore(h.layer(), { ...principal, projectId: "wrong" })).toThrow(/matching project-bound/);
  });

  it("enforces database RLS for the non-superuser runtime role", async () => {
    await store().ingest(envelope());
    await h.adminDb().transaction(async tx => {
      await tx.execute(sql.raw("SET LOCAL ROLE fusion_runtime"));
      await tx.execute(sql`SELECT set_config('fusion.project_bypass', 'off', true), set_config('fusion.project_id', ${principal.projectId}, true)`);
      expect(await tx.select().from(externalSessions)).toHaveLength(1);
      expect(await tx.select().from(externalSessionHosts)).toHaveLength(1);
      expect(await tx.select().from(externalSessionStreams)).toHaveLength(1);
      await tx.execute(sql`SELECT set_config('fusion.project_id', 'different-project', true)`);
      expect(await tx.select().from(externalSessions)).toHaveLength(0);
      expect(await tx.select().from(externalSessionHosts)).toHaveLength(0);
      expect(await tx.select().from(externalSessionStreams)).toHaveLength(0);
    });
    await expect(h.adminDb().transaction(async tx => {
      await tx.execute(sql.raw("SET LOCAL ROLE fusion_runtime"));
      await tx.execute(sql`SELECT set_config('fusion.project_bypass', 'off', true), set_config('fusion.project_id', 'different-project', true)`);
      await tx.insert(externalSessionHosts).values({ ...principal, collectorVersion: "1.0" });
    })).rejects.toThrow();
  });

  it("bounds durable streams per host while preserving all existing replay positions", async () => {
    for (let i = 0; i < 16; i++) await store().ingest({ ...envelope(), streamId: `spool-${i}` });
    await expect(store().ingest({ ...envelope(), streamId: "overflow" })).rejects.toMatchObject({ code: "stream-limit" });
    expect((await store().ingest({ ...envelope(), streamId: "spool-0" })).acknowledgedSequence).toBe(1);
  });

  it.each([
    ["external_session_hosts", "last_heartbeat_at"],
    ["external_session_streams", "last_event_digest"],
    ["external_sessions", "origin"],
  ])("repairs missing %s.%s with surviving data and ledger", async (table, column) => {
    const first = await store().ingest(envelope());
    await h.adminDb().execute(sql`ALTER TABLE project.${sql.identifier(table)} DROP COLUMN ${sql.identifier(column)} CASCADE`);
    expect((await applySchemaBaseline(h.adminDb())).applied).toBe(true);
    expect((await store().get(first.sessionId))?.revision).toBe(1);
    expect((await store().ingest(envelope(2))).applied).toBe(true);
    expect((await applySchemaBaseline(h.adminDb())).applied).toBe(false);
  });

  it.each([
    ["external_session_hosts", "collector_version"],
    ["external_session_streams", "acknowledged_sequence"],
    ["external_sessions", "revision"],
    ["external_sessions", "observation_digest"],
  ])("repairs missing required %s.%s on an empty restored schema", async (table, column) => {
    await h.adminDb().execute(sql`ALTER TABLE project.${sql.identifier(table)} DROP COLUMN ${sql.identifier(column)} CASCADE`);
    expect((await applySchemaBaseline(h.adminDb())).applied).toBe(true);
    expect((await store().ingest(envelope())).applied).toBe(true);
    expect((await applySchemaBaseline(h.adminDb())).applied).toBe(false);
  });

  it("fails closed rather than resetting lost acknowledgement positions in populated schemas", async () => {
    const first = await store().ingest(envelope());
    await h.adminDb().execute(sql`ALTER TABLE project.external_session_streams DROP COLUMN acknowledged_sequence CASCADE`);
    await expect(applySchemaBaseline(h.adminDb())).rejects.toThrow();
    expect((await store().get(first.sessionId))?.revision).toBe(1);
    expect(await h.layer().db.select({ id: externalSessions.id }).from(externalSessions)).toHaveLength(1);
  });

  it("installs migration 0086 on an upgrade and reopening is idempotent", async () => {
    await h.adminDb().execute(sql.raw("DROP TABLE project.external_sessions, project.external_session_streams, project.external_session_hosts; DELETE FROM public.fusion_schema_migrations WHERE version = '0086';"));
    expect((await applySchemaBaseline(h.adminDb())).applied).toBe(true);
    expect((await store().ingest(envelope())).applied).toBe(true);
    expect((await applySchemaBaseline(h.adminDb())).applied).toBe(false);
    const ledger = await h.adminDb().execute(sql`SELECT version FROM public.fusion_schema_migrations WHERE version = '0086'`);
    expect(ledger).toHaveLength(1);
  });
});
