import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { createSharedPgTaskStoreTestHarness, pgDescribe } from "../../__test-utils__/pg-test-harness.js";
import { externalSessionDigest, externalSessionIngestionSchema } from "../../external-sessions/contract.js";
import { ExternalSessionStore } from "../../external-sessions/store.js";
import { ExternalSessionReader } from "../../external-sessions/reader.js";
import { externalSessions, externalSessionStreams, externalSessionHosts, externalSessionTurns, tasks } from "../../postgres/schema/project.js";
import { applySchemaBaseline } from "../../postgres/schema-applier.js";
import type { AsyncDataLayer } from "../../postgres/data-layer.js";
import { ExternalSessionFeedback } from "../../external-sessions/feedback.js";
import { externalSessionTurnSchema } from "../../external-sessions/turn-contract.js";
import { ExternalSessionTurnConflict, ExternalSessionTurnReader, ExternalSessionTurnStore, ExternalSessionTurnRestamp } from "../../external-sessions/turn-store.js";
import { ExternalSessionTurnSearch } from "../../external-sessions/turn-search.js";
import { externalSessionUsageIncrements } from "../../postgres/schema/project.js";
import { ExternalSessionUsageIncrementReader } from "../../external-sessions/usage-increments.js";
import { ExternalSessionRankings } from "../../external-sessions/rankings.js";
import { ExternalSessionSummaryStore } from "../../external-sessions/summary.js";

const principal = { projectId: "external-test", hostId: "host-1" };
const envelope = (sequence = 1, revision = sequence) => ({ schemaVersion: 1, streamId: "spool", sequence,
  eventId: `event-${sequence}`, collectorVersion: "1.0",
  session: { provider: "runtime", nativeSessionId: "native-1", revision, activity: "working",
    observedAt: "2026-09-17T00:00:00Z", title: "Session", projectPath: "/same/path" } });
const turnEnvelope = (sessionId: string, nativeTurnId = "turn-1", ordinal = 0, revision = 1) => ({ schemaVersion: 1,
  eventId: `event-${nativeTurnId}-${revision}`, sessionId, turn: { nativeTurnId, revision, ordinal,
    state: "completed" as const, prompts: [{ at: null, text: "Fix it" }], response: "Done",
    startedAt: null, endedAt: null, durationMs: null, durationSource: null, toolCallCount: 2,
    fileChanges: [{ path: "src/a.ts", operation: "modify" as const, addedLines: 1, removedLines: 0,
      patchAvailable: true, patch: "@@ -1 +1 @@\n-old\n+new", truncated: false }] } });

pgDescribe("external sessions: durable observation ingestion", () => {
  const h = createSharedPgTaskStoreTestHarness({ prefix: "fusion_external", projectId: principal.projectId });
  const store = () => new ExternalSessionStore(h.layer(), principal);
  beforeAll(h.beforeAll); beforeEach(h.beforeEach); afterEach(h.afterEach); afterAll(h.afterAll);

  async function feedbackSession() {
    const now = new Date().toISOString();
    const input = { ...envelope(), session: { ...envelope().session, observedAt: now, feedback: { generation: "runtime-1", expiresAt: new Date(Date.parse(now) + 3600000).toISOString() } } };
    const ack = await store().ingest(input); await store().heartbeat({ schemaVersion: 1, collectorVersion: "1.0" }, now);
    return { now, sessionId: ack.sessionId, feedback: new ExternalSessionFeedback(h.layer(), principal.projectId) };
  }
  it("queues idempotently and fences native generation, host and ambiguous claims", async () => {
    const s = await feedbackSession(); const b = { commandId: randomUUID(), generation: "runtime-1", text: "Check the failing route" };
    const results = await Promise.all([s.feedback.submit(s.sessionId, b, s.now), s.feedback.submit(s.sessionId, b, s.now)]);
    expect(results[0]).toEqual(results[1]); expect(results[0].status).toBe("queued");
    await expect(s.feedback.submit(s.sessionId, { ...b, text: "Different feedback" }, s.now)).rejects.toThrow("already used");
    expect(await s.feedback.claim("other-host", { sessionId: s.sessionId, generation: b.generation }, s.now)).toEqual({ command: null });
    expect(await s.feedback.claim(principal.hostId, { sessionId: s.sessionId, generation: "resumed-runtime" }, s.now)).toEqual({ command: null });
    expect((await s.feedback.claim(principal.hostId, { sessionId: s.sessionId, generation: b.generation }, s.now)).command?.commandId).toBe(b.commandId);
    const reopened = new ExternalSessionFeedback(h.layer(), principal.projectId);
    expect(await reopened.claim(principal.hostId, { sessionId: s.sessionId, generation: b.generation }, s.now)).toEqual({ command: null });
    expect((await reopened.list(s.sessionId, s.now))[0].status).toBe("uncertain");
    await expect(reopened.acknowledge("other-host", { sessionId: s.sessionId, generation: b.generation, commandId: b.commandId, status: "delivered" }, s.now)).rejects.toThrow("scope mismatch");
    expect(await reopened.acknowledge(principal.hostId, { sessionId: s.sessionId, generation: b.generation, commandId: b.commandId, status: "delivered" }, s.now)).toEqual({ acknowledged: true });
    expect((await reopened.list(s.sessionId, s.now))[0].status).toBe("delivered");
    const row = (await h.adminDb().execute(sql`SELECT text FROM project.external_session_feedback WHERE project_id=${principal.projectId} AND id=${b.commandId}`))[0];
    expect(row.text).toBe("");
  });
  it("expires queued feedback and rejects offline capabilities", async () => {
    const s = await feedbackSession(); const b = { commandId: randomUUID(), generation: "runtime-1", text: "Review this" };
    await s.feedback.submit(s.sessionId, b, s.now);
    const later = new Date(Date.parse(s.now) + 301000).toISOString();
    expect((await s.feedback.list(s.sessionId, later))[0].status).toBe("expired");
    expect(await s.feedback.claim(principal.hostId, { sessionId: s.sessionId, generation: b.generation }, later)).toEqual({ command: null });
    await expect(s.feedback.submit(s.sessionId, { ...b, commandId: randomUUID() }, later)).rejects.toThrow("offline");
  });

  it("reads across hosts with exact filters, bounded pages and independent heartbeat freshness", async () => {
    const a = await store().ingest(envelope());
    const second = new ExternalSessionStore(h.layer(), { ...principal, hostId: "host-2" });
    const b = await second.ingest({ ...envelope(), session: { ...envelope().session, provider: "other" } });
    await second.heartbeat({ schemaVersion: 1, collectorVersion: "1.0" }, "2026-09-17T00:05:00Z");
    const reader = new ExternalSessionReader(h.layer(), principal.projectId);
    const now = Date.parse("2026-09-17T00:05:10Z");
    const first = await reader.list({ limit: 1 }, now);
    const next = await reader.list({ limit: 1, cursor: first.nextCursor! }, now);
    expect(new Set([...first.sessions, ...next.sessions].map(session => session.id))).toEqual(new Set([a.sessionId, b.sessionId]));
    expect(next.nextCursor).toBeNull();
    expect((await reader.get(a.sessionId, now))).toMatchObject({ collectorConnected: false, activityStale: true });
    expect((await reader.get(b.sessionId, now))).toMatchObject({ collectorConnected: true, activityStale: true });
    expect((await reader.list({ hostId: "host-2", provider: "other" })).sessions.map(session => session.id)).toEqual([b.sessionId]);
    expect((await reader.list({ hostId: "host-2", provider: "runtime" })).sessions).toEqual([]);
    expect(first.sessions[0]).not.toHaveProperty("observationDigest");
  });

  it("keeps reads project-isolated under an owner connection with RLS bypass", async () => {
    const first = await store().ingest(envelope());
    const otherLayer: AsyncDataLayer = { ...h.layer(), projectId: "other-project",
      db: h.adminDb(), transactionImmediate: callback => h.adminDb().transaction(callback) };
    await new ExternalSessionStore(otherLayer, { projectId: "other-project", hostId: principal.hostId }).ingest(envelope());
    const reader = new ExternalSessionReader(otherLayer, "other-project");
    expect(await reader.get(first.sessionId)).toBeNull();
    expect((await reader.list()).sessions).toHaveLength(1);
    expect(() => new ExternalSessionReader(h.layer(), "other-project")).toThrow("matching project-bound");
  });

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

  it("stores bounded historical turns under the observed session and cascades them on deletion", async () => {
    const sessionId = (await store().ingest(envelope())).sessionId;
    const turn = externalSessionTurnSchema.parse({ nativeTurnId: "turn-1", revision: 1, ordinal: 0,
      state: "completed", prompts: [{ at: null, text: "Fix it" }], response: "Done",
      startedAt: null, endedAt: null, durationMs: null, durationSource: null, toolCallCount: 2,
      fileChanges: [{ path: "src/a.ts", operation: "modify", addedLines: 1, removedLines: 0,
        patchAvailable: true, patch: "@@ -1 +1 @@\n-old\n+new", truncated: false }] });
    await h.layer().db.insert(externalSessionTurns).values({ projectId: principal.projectId, sessionId,
      nativeTurnId: turn.nativeTurnId, revision: turn.revision, ordinal: turn.ordinal, turn,
      turnDigest: externalSessionDigest(turn), receivedAt: "2026-09-22T17:42:00Z" });
    expect(await h.layer().db.select().from(externalSessionTurns)).toMatchObject([{ sessionId, nativeTurnId: "turn-1", revision: 1 }]);
    await h.layer().db.delete(externalSessions).where(sql`${externalSessions.projectId} = ${principal.projectId} AND ${externalSessions.id} = ${sessionId}`);
    expect(await h.layer().db.select().from(externalSessionTurns)).toEqual([]);
  });

  it("ingests turn revisions idempotently, rejects conflicts and ignores late delivery", async () => {
    const sessionId = (await store().ingest(envelope())).sessionId;
    const turns = new ExternalSessionTurnStore(h.layer(), principal);
    const first = await turns.ingest(turnEnvelope(sessionId));
    expect(first).toMatchObject({ applied: true, revision: 1, nativeTurnId: "turn-1" });
    expect(await turns.ingest(turnEnvelope(sessionId))).toEqual({ ...first, applied: false });
    await expect(turns.ingest({ ...turnEnvelope(sessionId), turn: { ...turnEnvelope(sessionId).turn, response: "Changed" } }))
      .rejects.toBeInstanceOf(ExternalSessionTurnConflict);
    expect((await turns.ingest(turnEnvelope(sessionId, "turn-1", 0, 3))).applied).toBe(true);
    expect(await turns.ingest(turnEnvelope(sessionId, "turn-1", 0, 2))).toMatchObject({ applied: false, revision: 3 });
    expect((await h.layer().db.select().from(externalSessionTurns))[0]).toMatchObject({ revision: 3, turn: { revision: 3 } });
  });

  it("fences turn ingestion to the collector host and paginates stable ordinal ties", async () => {
    const sessionId = (await store().ingest(envelope())).sessionId;
    await expect(new ExternalSessionTurnStore(h.layer(), { ...principal, hostId: "host-2" }).ingest(turnEnvelope(sessionId)))
      .rejects.toMatchObject({ code: "session-scope" });
    const turns = new ExternalSessionTurnStore(h.layer(), principal);
    await turns.ingest(turnEnvelope(sessionId, "turn-b", 0));
    await turns.ingest(turnEnvelope(sessionId, "turn-a", 0));
    await turns.ingest(turnEnvelope(sessionId, "turn-c", 1));
    const reader = new ExternalSessionTurnReader(h.layer(), principal.projectId);
    const first = await reader.list(sessionId, { limit: 2 });
    const second = await reader.list(sessionId, { limit: 2, cursor: first.nextCursor! });
    expect(first.turns.map(turn => turn.nativeTurnId)).toEqual(["turn-a", "turn-b"]);
    expect(second.turns.map(turn => turn.nativeTurnId)).toEqual(["turn-c"]);
    expect(second.nextCursor).toBeNull();
    const otherLayer: AsyncDataLayer = { ...h.layer(), projectId: "other-project",
      db: h.adminDb(), transactionImmediate: callback => h.adminDb().transaction(callback) };
    await expect(new ExternalSessionTurnReader(otherLayer, "other-project").list(sessionId)).resolves.toMatchObject({ turns: [] });
    await expect(new ExternalSessionTurnReader(otherLayer, "other-project").list(sessionId, { cursor: first.nextCursor! })).rejects.toThrow("cursor scope");
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

  it("repairs a damaged external-session schema even when project.tasks is absent", async () => {
    await h.adminDb().execute(sql.raw("ALTER TABLE project.tasks RENAME TO tasks_hidden; ALTER TABLE project.external_sessions DROP COLUMN observation_digest CASCADE;"));
    try {
      expect((await applySchemaBaseline(h.adminDb())).applied).toBe(true);
    } finally {
      await h.adminDb().execute(sql.raw("ALTER TABLE project.tasks_hidden RENAME TO tasks"));
    }
    expect((await store().ingest(envelope())).applied).toBe(true);
  });

  const sessionsContract = sql`
    SELECT
      to_regclass('project."idxExternalSessionsRecent"') IS NOT NULL AS recent_index,
      (SELECT count(*)::int FROM pg_trigger WHERE tgname = 'fusion_assign_project_id'
         AND tgrelid IN ('project.external_session_hosts'::regclass, 'project.external_session_streams'::regclass, 'project.external_sessions'::regclass)) AS triggers,
      (SELECT count(*)::int FROM pg_constraint WHERE contype IN ('p', 'f', 'c')
         AND conrelid IN ('project.external_session_hosts'::regclass, 'project.external_session_streams'::regclass, 'project.external_sessions'::regclass)) AS constraints`;

  it("repairs 0086 even when another project table reuses a constraint name", async () => {
    // A same-named CHECK on an unrelated table must not make the probe read the schema as intact.
    // The decoy satisfies the project-ownership audit, so only the constraint-name collision is under test.
    await h.adminDb().execute(sql.raw(`
      CREATE TABLE project.external_sessions_decoy (
        project_id text NOT NULL DEFAULT current_setting('fusion.project_id', true),
        revision bigint,
        CONSTRAINT external_sessions_revision CHECK (revision > 0)
      );
      ALTER TABLE project.external_sessions_decoy ENABLE ROW LEVEL SECURITY;
      ALTER TABLE project.external_sessions_decoy FORCE ROW LEVEL SECURITY;
      CREATE POLICY fusion_project_isolation ON project.external_sessions_decoy
        USING (current_setting('fusion.project_bypass', true) = 'on' OR project_id = current_setting('fusion.project_id', true))
        WITH CHECK (current_setting('fusion.project_bypass', true) = 'on' OR project_id = current_setting('fusion.project_id', true));
      ALTER TABLE project.external_sessions DROP CONSTRAINT external_sessions_revision;
    `));
    try {
      expect((await applySchemaBaseline(h.adminDb())).applied).toBe(true);
      const restored = await h.adminDb().execute(sql`SELECT 1 FROM pg_constraint WHERE conrelid = 'project.external_sessions'::regclass AND conname = 'external_sessions_revision'`);
      expect(restored).toHaveLength(1);
    } finally {
      await h.adminDb().execute(sql.raw("DROP TABLE project.external_sessions_decoy"));
    }
  });

  it.each([
    ["missing recent index", 'DROP INDEX project."idxExternalSessionsRecent"'],
    ["missing project trigger", "DROP TRIGGER fusion_assign_project_id ON project.external_sessions"],
    ["missing revision constraint", "ALTER TABLE project.external_sessions DROP CONSTRAINT external_sessions_revision"],
    ["missing native identity constraint", "ALTER TABLE project.external_sessions DROP CONSTRAINT external_sessions_native_identity"],
  ])("repairs a recorded 0086 session schema with a %s", async (_label, damage) => {
    const intact = (await h.adminDb().execute(sessionsContract))[0];
    await h.adminDb().execute(sql.raw(damage));
    expect((await applySchemaBaseline(h.adminDb())).applied).toBe(true);
    expect((await h.adminDb().execute(sessionsContract))[0]).toEqual(intact);
    expect((await applySchemaBaseline(h.adminDb())).applied).toBe(false);
    expect((await store().ingest(envelope())).applied).toBe(true);
  });

  const feedbackContract = sql`
    SELECT
      (SELECT count(*)::int FROM information_schema.columns WHERE table_schema = 'project' AND table_name = 'external_session_feedback') AS columns,
      to_regclass('project.external_session_feedback_queue') IS NOT NULL AS queue_index,
      (SELECT relrowsecurity AND relforcerowsecurity FROM pg_class WHERE oid = 'project.external_session_feedback'::regclass) AS rls,
      EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'project' AND tablename = 'external_session_feedback' AND policyname = 'fusion_project_isolation') AS policy,
      EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'project.external_session_feedback'::regclass AND tgname = 'fusion_assign_project_id') AS trigger,
      (SELECT count(*)::int FROM pg_constraint WHERE conrelid = 'project.external_session_feedback'::regclass AND contype IN ('p', 'f', 'c')) AS constraints`;

  it.each([
    ["missing required column", "ALTER TABLE project.external_session_feedback DROP COLUMN fingerprint CASCADE"],
    ["missing nullable column", "ALTER TABLE project.external_session_feedback DROP COLUMN delivered_at CASCADE"],
    ["missing queue index", "DROP INDEX project.external_session_feedback_queue"],
    ["missing project trigger", "DROP TRIGGER fusion_assign_project_id ON project.external_session_feedback"],
    ["missing state constraint", "ALTER TABLE project.external_session_feedback DROP CONSTRAINT external_session_feedback_state_check"],
    ["missing session foreign key", "ALTER TABLE project.external_session_feedback DROP CONSTRAINT external_session_feedback_project_id_session_id_fkey"],
  ])("repairs a recorded 0087 feedback schema with a %s", async (_label, damage) => {
    const intact = (await h.adminDb().execute(feedbackContract))[0];
    await h.adminDb().execute(sql.raw(damage));
    expect((await applySchemaBaseline(h.adminDb())).applied).toBe(true);
    expect((await h.adminDb().execute(feedbackContract))[0]).toEqual(intact);
    expect((await applySchemaBaseline(h.adminDb())).applied).toBe(false);
    const s = await feedbackSession();
    const b = { commandId: randomUUID(), generation: "runtime-1", text: "Repaired schema" };
    expect((await s.feedback.submit(s.sessionId, b, s.now)).status).toBe("queued");
  });
  async function searchCorpus() {
    const first = await store().ingest(envelope());
    const turns = new ExternalSessionTurnStore(h.layer(), principal);
    const a = turnEnvelope(first.sessionId, "turn-a", 0);
    await turns.ingest({ ...a, turn: { ...a.turn, prompts: [{ at: null, text: "Please migrate the postgres schema applier" }], response: "Applied the migration and verified constraints" } });
    const b = turnEnvelope(first.sessionId, "turn-b", 1);
    await turns.ingest({ ...b, turn: { ...b.turn, prompts: [{ at: null, text: "Now render the dashboard panel" }], response: "Rendered the panel with tokens" } });
    return first.sessionId;
  }

  it("finds collected output by word and returns a highlighted excerpt", async () => {
    const sessionId = await searchCorpus();
    const page = await new ExternalSessionTurnSearch(h.layer(), principal.projectId).search({ q: "migration" });
    expect(page.hits).toHaveLength(1);
    expect(page.hits[0]).toMatchObject({ sessionId, nativeTurnId: "turn-a", hostId: principal.hostId, provider: "runtime", title: "Session" });
    expect(page.hits[0]!.snippet).toContain("<mark>");
    // The English configuration stems, so the typed word need not match the stored form exactly.
    expect((await new ExternalSessionTurnSearch(h.layer(), principal.projectId).search({ q: "migrating" })).hits).toHaveLength(1);
  });

  it("searches prompts as well as responses and supports quoted phrases and exclusion", async () => {
    await searchCorpus();
    const search = new ExternalSessionTurnSearch(h.layer(), principal.projectId);
    expect((await search.search({ q: "dashboard" })).hits.map(hit => hit.nativeTurnId)).toEqual(["turn-b"]);
    expect((await search.search({ q: '"postgres schema"' })).hits.map(hit => hit.nativeTurnId)).toEqual(["turn-a"]);
    expect((await search.search({ q: "panel -dashboard" })).hits.map(hit => hit.nativeTurnId)).toEqual([]);
  });

  it("returns no searchable term instead of matching everything for stopword-only input", async () => {
    await searchCorpus();
    expect(await new ExternalSessionTurnSearch(h.layer(), principal.projectId).search({ q: "the and of" }))
      .toMatchObject({ hits: [], more: false, query: null });
  });

  it("never raises on punctuation an operator can type into a search box", async () => {
    await searchCorpus();
    const search = new ExternalSessionTurnSearch(h.layer(), principal.projectId);
    for (const q of ['"unbalanced', "a & b | c", "!!!", "' OR 1=1 --", "<script>"]) {
      await expect(search.search({ q })).resolves.toMatchObject({ schemaVersion: 1 });
    }
  });

  it("keeps search inside its project and honours host and session filters", async () => {
    const sessionId = await searchCorpus();
    const search = new ExternalSessionTurnSearch(h.layer(), principal.projectId);
    expect((await search.search({ q: "migration", hostId: principal.hostId })).hits).toHaveLength(1);
    expect((await search.search({ q: "migration", hostId: "other-host" })).hits).toEqual([]);
    expect((await search.search({ q: "migration", sessionId })).hits).toHaveLength(1);
    expect((await search.search({ q: "migration", sessionId: "b".repeat(64) })).hits).toEqual([]);
    expect(() => new ExternalSessionTurnSearch(h.layer(), "other-project")).toThrow();
  });

  it("caps the page and reports that more matched", async () => {
    const first = await store().ingest(envelope());
    const turns = new ExternalSessionTurnStore(h.layer(), principal);
    for (let i = 0; i < 4; i += 1) {
      const base = turnEnvelope(first.sessionId, `bulk-${i}`, i);
      await turns.ingest({ ...base, turn: { ...base.turn, prompts: [{ at: null, text: "repeated needle text" }], response: "needle" } });
    }
    const page = await new ExternalSessionTurnSearch(h.layer(), principal.projectId).search({ q: "needle", limit: 2 });
    expect(page.hits).toHaveLength(2);
    expect(page.more).toBe(true);
  });

  it("installs the 0089 search index and keeps it valid", async () => {
    await searchCorpus();
    const [index] = (await h.adminDb().execute(sql`SELECT indisvalid AS valid FROM pg_class c JOIN pg_index i ON i.indexrelid = c.oid WHERE c.relname = 'external_session_turn_search'`)) as unknown as Array<{ valid: boolean }>;
    expect(index?.valid).toBe(true);
    const ledger = await h.adminDb().execute(sql`SELECT version FROM public.fusion_schema_migrations WHERE version = '0089'`);
    expect(ledger).toHaveLength(1);
  });

  it("reinstalls the search index when it is dropped but the ledger row remains", async () => {
    await h.adminDb().execute(sql.raw("DROP INDEX project.external_session_turn_search"));
    expect((await applySchemaBaseline(h.adminDb())).applied).toBe(true);
    const [index] = (await h.adminDb().execute(sql`SELECT indisvalid AS valid FROM pg_class c JOIN pg_index i ON i.indexrelid = c.oid WHERE c.relname = 'external_session_turn_search'`)) as unknown as Array<{ valid: boolean }>;
    expect(index?.valid).toBe(true);
  });

  it("records collector-reported health and keeps unreported counters null", async () => {
    await store().heartbeat({ schemaVersion: 1, collectorVersion: "1.0" });
    const [bare] = await new ExternalSessionReader(h.layer(), principal.projectId).hosts();
    // An older collector reports nothing; null must not be flattened to a reassuring zero.
    expect(bare).toMatchObject({ spoolDepth: null, spoolBytes: null, parseFailures: null, deliveryFailures: null, healthReportedAt: null });
    expect(bare!.heartbeatAgeMs).toBeGreaterThanOrEqual(0);
    await store().heartbeat({ schemaVersion: 1, collectorVersion: "1.1", spoolDepth: 12, spoolBytes: 3456, parseFailures: 2, deliveryFailures: 1 });
    const [reported] = await new ExternalSessionReader(h.layer(), principal.projectId).hosts();
    expect(reported).toMatchObject({ spoolDepth: 12, spoolBytes: 3456, parseFailures: 2, deliveryFailures: 1, collectorVersion: "1.1" });
    expect(reported!.healthReportedAt).not.toBeNull();
  });

  it("does not let a collector without counters blank the last known health", async () => {
    await store().heartbeat({ schemaVersion: 1, collectorVersion: "1.1", spoolDepth: 9, parseFailures: 4 });
    await store().heartbeat({ schemaVersion: 1, collectorVersion: "1.0" });
    const [host] = await new ExternalSessionReader(h.layer(), principal.projectId).hosts();
    expect(host).toMatchObject({ spoolDepth: 9, parseFailures: 4 });
  });

  it("reports a reported zero spool distinctly from an unreported one", async () => {
    await store().heartbeat({ schemaVersion: 1, collectorVersion: "1.1", spoolDepth: 0, spoolBytes: 0 });
    const [host] = await new ExternalSessionReader(h.layer(), principal.projectId).hosts();
    expect(host!.spoolDepth).toBe(0);
    expect(host!.spoolDepth).not.toBeNull();
  });

  it("rejects a malformed health counter rather than storing it", async () => {
    for (const bad of [{ spoolDepth: -1 }, { parseFailures: 1.5 }, { spoolBytes: "many" }, { unknownCounter: 1 }]) {
      await expect(store().heartbeat({ schemaVersion: 1, collectorVersion: "1.1", ...bad })).rejects.toThrow();
    }
  });

  it("installs 0090 health columns and restores them when dropped", async () => {
    await h.adminDb().execute(sql.raw("ALTER TABLE project.external_session_hosts DROP COLUMN spool_depth"));
    expect((await applySchemaBaseline(h.adminDb())).applied).toBe(true);
    await store().heartbeat({ schemaVersion: 1, collectorVersion: "1.1", spoolDepth: 5 });
    const [host] = await new ExternalSessionReader(h.layer(), principal.projectId).hosts();
    expect(host).toMatchObject({ spoolDepth: 5 });
  });

  it("stores measured per-turn usage and context without inventing either", async () => {
    const first = await store().ingest(envelope());
    const turns = new ExternalSessionTurnStore(h.layer(), principal);
    const base = turnEnvelope(first.sessionId, "turn-usage", 0);
    await turns.ingest({ ...base, turn: { ...base.turn,
      usage: [{ requestId: "msg-1", model: "claude-sonnet-5", inputTokens: 1050, cachedInputTokens: 900,
        cacheWriteTokens: 50, cacheWriteHourTokens: 0, outputTokens: 20, reasoningTokens: null, fast: false, longContext: false }],
      usageComplete: true, contextTokens: 1050, contextCapacity: 200000 } });
    const [stored] = (await new ExternalSessionTurnReader(h.layer(), principal.projectId).list(first.sessionId)).turns;
    expect(stored).toMatchObject({ contextTokens: 1050, contextCapacity: 200000, usageComplete: true });
    expect(stored!.usage).toHaveLength(1);
    expect(stored!.usage![0]).toMatchObject({ requestId: "msg-1", inputTokens: 1050, outputTokens: 20 });
  });

  it("keeps a turn without usage absent rather than zeroed", async () => {
    const first = await store().ingest(envelope());
    const turns = new ExternalSessionTurnStore(h.layer(), principal);
    await turns.ingest(turnEnvelope(first.sessionId, "turn-bare", 0));
    const [stored] = (await new ExternalSessionTurnReader(h.layer(), principal.projectId).list(first.sessionId)).turns;
    expect(stored!.usage).toBeUndefined();
    expect(stored!.contextTokens ?? null).toBeNull();
  });

  it("rejects turn usage that contradicts itself", async () => {
    const first = await store().ingest(envelope());
    const turns = new ExternalSessionTurnStore(h.layer(), principal);
    const base = turnEnvelope(first.sessionId, "turn-bad", 0);
    const usage = { requestId: "msg-1", model: "m", inputTokens: 10, cachedInputTokens: 0, cacheWriteTokens: 0,
      cacheWriteHourTokens: 0, outputTokens: 1, reasoningTokens: null, fast: false, longContext: false };
    for (const bad of [{ inputTokens: -1 }, { contextTokens: -5 }, { usage: [{ ...usage, requestId: "" }] }]) {
      const broken = "usage" in bad ? { ...base.turn, ...bad } : { ...base.turn, usage: [{ ...usage, ...bad }] };
      await expect(turns.ingest({ ...base, turn: broken as never })).rejects.toThrow();
    }
  });

  it("stores a recorded pricing stamp with its turn and leaves unstamped turns unstamped", async () => {
    const first = await store().ingest(envelope());
    const turns = new ExternalSessionTurnStore(h.layer(), principal);
    const base = turnEnvelope(first.sessionId, "turn-priced", 0);
    const pricing = { asOf: "2026-07-16", source: "Fusion model pricing",
      rates: { "claude_code:claude-sonnet-5": { inputPer1M: 3, outputPer1M: 15, cacheReadPer1M: 0.3, cacheWritePer1M: 3.75, source: "docs" } } };
    await turns.ingest({ ...base, turn: { ...base.turn, pricing } });
    await turns.ingest(turnEnvelope(first.sessionId, "turn-unstamped", 1));
    const stored = (await new ExternalSessionTurnReader(h.layer(), principal.projectId).list(first.sessionId)).turns;
    expect(stored.find(t => t.nativeTurnId === "turn-priced")!.pricing).toMatchObject(pricing);
    // An old turn stays without a stamp; it must never be back-filled from today's catalog.
    expect(stored.find(t => t.nativeTurnId === "turn-unstamped")!.pricing).toBeUndefined();
  });

  it("rejects a malformed pricing stamp rather than storing an unusable rate", async () => {
    const first = await store().ingest(envelope());
    const turns = new ExternalSessionTurnStore(h.layer(), principal);
    const base = turnEnvelope(first.sessionId, "turn-bad-rate", 0);
    const good = { inputPer1M: 3, outputPer1M: 15, cacheReadPer1M: 0.3, cacheWritePer1M: 3.75, source: "docs" };
    for (const bad of [
      { asOf: "", source: "s", rates: { "a:b": good } },
      { asOf: "2026-07-16", source: "s", rates: { "a:b": { ...good, inputPer1M: -1 } } },
      { asOf: "2026-07-16", source: "s", rates: { "a:b": { ...good, source: "" } } },
      { asOf: "2026-07-16", source: "s", rates: { "a:b": { inputPer1M: 3 } } },
    ]) {
      await expect(turns.ingest({ ...base, turn: { ...base.turn, pricing: bad } as never })).rejects.toThrow();
    }
  });

  async function rankingCorpus() {
    const first = await store().ingest(envelope());
    const turns = new ExternalSessionTurnStore(h.layer(), principal);
    const usage = (model: string) => [{ requestId: `r-${model}`, model, inputTokens: 1000, cachedInputTokens: 0,
      cacheWriteTokens: 0, cacheWriteHourTokens: 0, outputTokens: 100, reasoningTokens: null, fast: false, longContext: false }];
    const a = turnEnvelope(first.sessionId, "rank-a", 0);
    await turns.ingest({ ...a, turn: { ...a.turn, endedAt: "2026-09-01T00:00:00.000Z", usage: usage("model-a"), usageComplete: true } });
    const b = turnEnvelope(first.sessionId, "rank-b", 1);
    await turns.ingest({ ...b, turn: { ...b.turn, endedAt: "2026-09-10T00:00:00.000Z", usage: usage("model-b"), usageComplete: true } });
    const bare = turnEnvelope(first.sessionId, "rank-bare", 2);
    await turns.ingest({ ...bare, turn: { ...bare.turn, endedAt: "2026-09-11T00:00:00.000Z" } });
    return first.sessionId;
  }

  it("returns ranking candidates with their usage and counts rows that can never be ranked", async () => {
    await rankingCorpus();
    const scan = await new ExternalSessionRankings(h.layer(), principal.projectId).turns();
    expect(scan.candidates).toHaveLength(3);
    // A turn with no usage is reported, not dropped: coverage has to be able to say it exists.
    expect(scan.withoutUsage).toBe(1);
    expect(scan.truncated).toBe(false);
  });

  it("filters ranking candidates by date, host and model", async () => {
    await rankingCorpus();
    const rankings = new ExternalSessionRankings(h.layer(), principal.projectId);
    expect((await rankings.turns({ from: "2026-09-05T00:00:00.000Z" })).candidates.map(c => c.nativeTurnId).sort())
      .toEqual(["rank-b", "rank-bare"]);
    expect((await rankings.turns({ to: "2026-09-05T00:00:00.000Z" })).candidates.map(c => c.nativeTurnId)).toEqual(["rank-a"]);
    expect((await rankings.turns({ model: "model-a" })).candidates.map(c => c.nativeTurnId)).toEqual(["rank-a"]);
    expect((await rankings.turns({ hostId: "other" })).candidates).toEqual([]);
    expect((await rankings.turns({ hostId: principal.hostId })).candidates).toHaveLength(3);
  });

  it("reports truncation instead of silently ranking part of the range", async () => {
    await rankingCorpus();
    const scan = await new ExternalSessionRankings(h.layer(), principal.projectId).turns({ scanLimit: 2 });
    expect(scan.candidates).toHaveLength(2);
    expect(scan.truncated).toBe(true);
  });

  it("ranks sessions by their own usage and keeps them project-scoped", async () => {
    await rankingCorpus();
    const rankings = new ExternalSessionRankings(h.layer(), principal.projectId);
    const scan = await rankings.sessions();
    expect(scan.candidates).toHaveLength(1);
    expect(scan.candidates[0]).toMatchObject({ hostId: principal.hostId, provider: "runtime" });
    expect(() => new ExternalSessionRankings(h.layer(), "other-project")).toThrow();
  });

  it("rejects a malformed ranking query rather than scanning everything", async () => {
    const rankings = new ExternalSessionRankings(h.layer(), principal.projectId);
    for (const bad of [{ scanLimit: 0 }, { scanLimit: 99999 }, { from: "yesterday" }, { hostId: "" }]) {
      await expect(rankings.turns(bad as never)).rejects.toThrow();
    }
  });

  const stampRate = { inputPer1M: 3, outputPer1M: 15, cacheReadPer1M: 0.3, cacheWritePer1M: 3.75, source: "docs" };
  const correctedRate = { ...stampRate, inputPer1M: 9, source: "catalog correction" };

  async function stampedSession() {
    const first = await store().ingest(envelope());
    const turns = new ExternalSessionTurnStore(h.layer(), principal);
    const a = turnEnvelope(first.sessionId, "stamped", 0);
    await turns.ingest({ ...a, turn: { ...a.turn,
      pricing: { asOf: "2026-07-16", source: "Fusion model pricing", rates: { "claude_code:m": stampRate } } } });
    const b = turnEnvelope(first.sessionId, "unstamped", 1);
    await turns.ingest(b);
    return first.sessionId;
  }

  it("preserves a frozen stamp by default: ingest never restamps", async () => {
    const sessionId = await stampedSession();
    const turns = new ExternalSessionTurnStore(h.layer(), principal);
    const again = turnEnvelope(sessionId, "stamped", 0, 2);
    await turns.ingest({ ...again, turn: { ...again.turn, revision: 2,
      pricing: { asOf: "2026-09-24", source: "newer", rates: { "claude_code:m": correctedRate } } } });
    const [stamped] = (await new ExternalSessionTurnReader(h.layer(), principal.projectId).list(sessionId)).turns
      .filter(t => t.nativeTurnId === "stamped");
    // A later ingest may carry its own stamp, but nothing in this path rewrites history behind the operator.
    expect(stamped!.pricing?.restamp).toBeUndefined();
  });

  it("records actor, reason and the replaced basis when an operator restamps", async () => {
    const sessionId = await stampedSession();
    const result = await new ExternalSessionTurnRestamp(h.layer(), principal.projectId).apply(sessionId, {
      actor: "operator@example.test", reason: "catalog had the wrong input rate",
      rates: { "claude_code:m": correctedRate }, asOf: "2026-09-24", source: "Corrected catalog" });
    expect(result).toMatchObject({ restamped: 1, skippedUnstamped: 1 });
    const turns = (await new ExternalSessionTurnReader(h.layer(), principal.projectId).list(sessionId)).turns;
    const stamped = turns.find(t => t.nativeTurnId === "stamped")!;
    expect(stamped.pricing).toMatchObject({ asOf: "2026-09-24", source: "Corrected catalog" });
    expect(stamped.pricing!.rates["claude_code:m"]).toMatchObject({ inputPer1M: 9 });
    expect(stamped.pricing!.restamp).toMatchObject({ actor: "operator@example.test",
      reason: "catalog had the wrong input rate", previousAsOf: "2026-07-16", previousSource: "Fusion model pricing" });
    expect(Date.parse(stamped.pricing!.restamp!.at)).toBeGreaterThan(0);
  });

  it("never stamps a turn that was never stamped, so an operator cannot invent a basis", async () => {
    const sessionId = await stampedSession();
    await new ExternalSessionTurnRestamp(h.layer(), principal.projectId).apply(sessionId, {
      actor: "op", reason: "fix", rates: { "claude_code:m": correctedRate }, asOf: "2026-09-24", source: "Corrected" });
    const turns = (await new ExternalSessionTurnReader(h.layer(), principal.projectId).list(sessionId)).turns;
    expect(turns.find(t => t.nativeTurnId === "unstamped")!.pricing).toBeUndefined();
  });

  it("rewrites only the stamp and leaves the measured work untouched", async () => {
    const sessionId = await stampedSession();
    const before = (await new ExternalSessionTurnReader(h.layer(), principal.projectId).list(sessionId)).turns
      .find(t => t.nativeTurnId === "stamped")!;
    await new ExternalSessionTurnRestamp(h.layer(), principal.projectId).apply(sessionId, {
      actor: "op", reason: "fix", rates: { "claude_code:m": correctedRate }, asOf: "2026-09-24", source: "Corrected" });
    const after = (await new ExternalSessionTurnReader(h.layer(), principal.projectId).list(sessionId)).turns
      .find(t => t.nativeTurnId === "stamped")!;
    // A catalog correction changes what work cost, never what happened.
    expect({ ...after, pricing: undefined }).toEqual({ ...before, pricing: undefined });
  });

  it("refuses a restamp with no replacement rates or a missing actor or reason", async () => {
    const sessionId = await stampedSession();
    const restamp = new ExternalSessionTurnRestamp(h.layer(), principal.projectId);
    for (const bad of [{ rates: {} }, { actor: "" }, { reason: "" }, { asOf: "" }]) {
      await expect(restamp.apply(sessionId, { actor: "op", reason: "fix", rates: { "claude_code:m": correctedRate },
        asOf: "2026-09-24", source: "Corrected", ...bad } as never)).rejects.toThrow();
    }
    expect(() => new ExternalSessionTurnRestamp(h.layer(), "other-project")).toThrow();
  });

  const band = (model: string, input: number, output: number, extra: Record<string, unknown> = {}) => ({
    model, inputTokens: input, cachedInputTokens: 0, cacheWriteTokens: 0, cacheWriteHourTokens: 0,
    outputTokens: output, reasoningTokens: null, fast: false, longContext: false, ...extra });
  const withUsage = (sequence: number, revision: number, usage: unknown[], pricing?: unknown) => [{
    ...envelope(sequence, revision),
    session: { ...envelope(sequence, revision).session, usage, usageComplete: true },
  }, pricing] as const;
  const increments = async (sessionId: string) => (await h.adminDb().execute(sql`
    SELECT revision, usage, pricing FROM project.external_session_usage_increments
    WHERE project_id=${principal.projectId} AND session_id=${sessionId} ORDER BY revision`)) as unknown as Array<{ revision: number; usage: unknown[]; pricing: unknown }>;

  it("records only what each revision added, so a mid-session model change prices at its own rate", async () => {
    const rateA = { asOf: "2026-07-16", source: "baseline", rates: { "claude_code:model-a": { inputPer1M: 3, outputPer1M: 15, cacheReadPer1M: 0.3, cacheWritePer1M: 3.75, source: "docs" } } };
    const rateB = { asOf: "2026-09-24", source: "later", rates: { "claude_code:model-b": { inputPer1M: 9, outputPer1M: 45, cacheReadPer1M: 0.9, cacheWritePer1M: 11.25, source: "docs" } } };
    const [first, p1] = withUsage(1, 1, [band("model-a", 1000, 100)], rateA);
    const created = await store().ingest(first, p1);
    // Revision 2 keeps model-a's cumulative total and adds model-b: only the new work is an increment.
    const [second, p2] = withUsage(2, 2, [band("model-a", 1000, 100), band("model-b", 500, 50)], rateB);
    await store().ingest(second, p2);
    const rows = await increments(created.sessionId);
    expect(rows).toHaveLength(2);
    expect(rows[0]!.usage).toEqual([expect.objectContaining({ model: "model-a", inputTokens: 1000, outputTokens: 100 })]);
    expect(rows[0]!.pricing).toMatchObject({ asOf: "2026-07-16" });
    // The second increment must NOT restate model-a, or its earlier work would be repriced at the later rate.
    expect(rows[1]!.usage).toEqual([expect.objectContaining({ model: "model-b", inputTokens: 500, outputTokens: 50 })]);
    expect(rows[1]!.pricing).toMatchObject({ asOf: "2026-09-24" });
  });

  it("records the growth of a single model rather than its running total", async () => {
    const [first] = withUsage(1, 1, [band("model-a", 1000, 100)]);
    const created = await store().ingest(first);
    const [second] = withUsage(2, 2, [band("model-a", 2500, 260)]);
    await store().ingest(second);
    const rows = await increments(created.sessionId);
    expect(rows[1]!.usage).toEqual([expect.objectContaining({ inputTokens: 1500, outputTokens: 160 })]);
  });

  it("writes no increment for a revision that added nothing", async () => {
    const [first] = withUsage(1, 1, [band("model-a", 1000, 100)]);
    const created = await store().ingest(first);
    const [second] = withUsage(2, 2, [band("model-a", 1000, 100)]);
    await store().ingest(second);
    expect(await increments(created.sessionId)).toHaveLength(1);
  });

  it("treats a counter that goes backwards as unknown rather than negative work", async () => {
    const [first] = withUsage(1, 1, [band("model-a", 5000, 500)]);
    const created = await store().ingest(first);
    // A collector that re-derived its accounting can report a LOWER cumulative total.
    const [second] = withUsage(2, 2, [band("model-a", 100, 10)]);
    await store().ingest(second);
    const rows = await increments(created.sessionId);
    expect(rows).toHaveLength(1);
    expect(Number(rows[0]!.revision)).toBe(1);
  });

  it("prices the same model at different tiers separately", async () => {
    const [first] = withUsage(1, 1, [band("model-a", 1000, 100)]);
    const created = await store().ingest(first);
    const [second] = withUsage(2, 2, [band("model-a", 1000, 100), band("model-a", 700, 70, { longContext: true })]);
    await store().ingest(second);
    const rows = await increments(created.sessionId);
    expect(rows[1]!.usage).toEqual([expect.objectContaining({ model: "model-a", longContext: true, inputTokens: 700 })]);
  });

  it("keeps an increment immutable when the same revision is replayed", async () => {
    const rate = { asOf: "2026-07-16", source: "baseline", rates: {} };
    const [first, p1] = withUsage(1, 1, [band("model-a", 1000, 100)], rate);
    const created = await store().ingest(first, p1);
    await expect(store().ingest(first, { asOf: "2099-01-01", source: "later", rates: {} })).resolves.toMatchObject({ applied: false });
    const rows = await increments(created.sessionId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.pricing).toMatchObject({ asOf: "2026-07-16" });
  });

  it("reads increments in revision order and groups a page in one query", async () => {
    const [first, p1] = withUsage(1, 1, [band("model-a", 1000, 100)], { asOf: "2026-07-16", source: "early", rates: {} });
    const created = await store().ingest(first, p1);
    const [second, p2] = withUsage(2, 2, [band("model-a", 2000, 200)], { asOf: "2026-09-24", source: "later", rates: {} });
    await store().ingest(second, p2);
    const reader = new ExternalSessionUsageIncrementReader(h.layer(), principal.projectId);
    const list = await reader.list(created.sessionId);
    expect(list.map(i => i.revision)).toEqual([1, 2]);
    expect(list[0]!.pricing).toMatchObject({ asOf: "2026-07-16" });
    expect(list[1]!.pricing).toMatchObject({ asOf: "2026-09-24" });
    const grouped = await reader.listForSessions([created.sessionId]);
    expect(grouped.get(created.sessionId)!.map(i => i.revision)).toEqual([1, 2]);
    // An unknown session must be absent rather than an empty-but-present entry that reads as "no cost".
    expect(grouped.has("b".repeat(64))).toBe(false);
    expect(() => new ExternalSessionUsageIncrementReader(h.layer(), "other-project")).toThrow();
  });

  it("records an increment unpriced when no rates were available at ingest", async () => {
    const [first] = withUsage(1, 1, [band("model-a", 1000, 100)]);
    const created = await store().ingest(first);
    const [only] = await new ExternalSessionUsageIncrementReader(h.layer(), principal.projectId).list(created.sessionId);
    expect(only!.pricing).toBeNull();
    expect(only!.usage).toHaveLength(1);
  });

  /*
  FNXC:ExternalSessionSummary 2026-09-24-07:05 (operator decision F3 = A): the durable summary record. The
  invariant worth a PG test is that a FAILED attempt never destroys the previous summary — during an inference
  outage the older summary plus an explicit failure is strictly more useful than an empty pane.
  */
  const summaries = () => new ExternalSessionSummaryStore(h.layer(), principal.projectId);

  it("preserves the previous summary when a later attempt fails, and recovers on the next success", async () => {
    const created = await store().ingest(envelope());
    await summaries().recordSuccess(created.sessionId, { summary: "Fixed the parser.", provider: "anthropic",
      model: "model-a", coverage: { throughOrdinal: 2, turnCount: 3 } }, "2026-09-24T01:00:00.000Z");

    const failed = await summaries().recordFailure(created.sessionId, "AI engine not available", "2026-09-24T02:00:00.000Z");
    expect(failed.status).toBe("failed");
    expect(failed.failure).toBe("AI engine not available");
    // Everything describing the last GOOD summary survives untouched.
    expect(failed.summary).toBe("Fixed the parser.");
    expect(failed.generatedAt).toBe("2026-09-24T01:00:00.000Z");
    expect(failed.throughOrdinal).toBe(2);
    expect(failed.turnCount).toBe(3);
    expect(failed.model).toBe("model-a");
    expect(failed.attemptedAt).toBe("2026-09-24T02:00:00.000Z");

    const recovered = await summaries().recordSuccess(created.sessionId, { summary: "Fixed the parser and its tests.",
      provider: "anthropic", model: "model-b", coverage: { throughOrdinal: 5, turnCount: 6 } }, "2026-09-24T03:00:00.000Z");
    expect(recovered.status).toBe("ready");
    expect(recovered.failure).toBeNull();
    expect((await summaries().read(created.sessionId))!.summary).toBe("Fixed the parser and its tests.");
  });

  it("records a first-attempt failure with no summary rather than inventing one", async () => {
    const created = await store().ingest(envelope());
    const failed = await summaries().recordFailure(created.sessionId, "  ");
    expect(failed.status).toBe("failed");
    expect(failed.summary).toBeNull();
    expect(failed.throughOrdinal).toBeNull();
    // An empty reason still has to say something an operator can act on.
    expect(failed.failure).toBe("Summary generation failed");
  });

  it("reads the tail of the transcript and derives staleness from the session's real turns", async () => {
    const created = await store().ingest(envelope());
    const turns = new ExternalSessionTurnStore(h.layer(), principal);
    for (let ordinal = 0; ordinal < 3; ordinal++) await turns.ingest(turnEnvelope(created.sessionId, `turn-${ordinal}`, ordinal));
    expect((await summaries().latestOrdinal(created.sessionId))).toBe(2);
    const tail = await summaries().tail(created.sessionId, 2);
    expect(tail.map(t => t.ordinal)).toEqual([1, 2]);
    expect((await summaries().latestOrdinal("c".repeat(64)))).toBeNull();
    expect(() => new ExternalSessionSummaryStore(h.layer(), "other-project")).toThrow();
  });

  it("bounds a stored summary and refuses a summary for a session that does not exist", async () => {
    const created = await store().ingest(envelope());
    const stored = await summaries().recordSuccess(created.sessionId, { summary: "x".repeat(5000),
      provider: null, model: null, coverage: { throughOrdinal: 0, turnCount: 1 } });
    expect(stored.summary).toHaveLength(2000);
    // The foreign key is the guard: a summary can only exist for a real session.
    await expect(summaries().recordSuccess("d".repeat(64), { summary: "orphan", provider: null, model: null,
      coverage: { throughOrdinal: 0, turnCount: 1 } })).rejects.toThrow();
  });

  it("installs external-session migrations on an upgrade and reopening is idempotent", async () => {
    // 0091's increments reference external_sessions, so a pre-0086 upgrade must drop them too.
    await h.adminDb().execute(sql.raw("DROP TABLE project.external_session_summaries, project.external_session_usage_increments, project.external_session_turns, project.external_session_feedback, project.external_sessions, project.external_session_streams, project.external_session_hosts; DELETE FROM public.fusion_schema_migrations WHERE version IN ('0086', '0087', '0088', '0091', '0092');"));
    expect((await applySchemaBaseline(h.adminDb())).applied).toBe(true);
    expect((await store().ingest(envelope())).applied).toBe(true);
    expect((await applySchemaBaseline(h.adminDb())).applied).toBe(false);
    const ledger = await h.adminDb().execute(sql`SELECT version FROM public.fusion_schema_migrations WHERE version IN ('0086', '0087', '0088') ORDER BY version`);
    expect(ledger.map(row => row.version)).toEqual(["0086", "0087", "0088"]);
  });
});
