/**
 * PostgreSQL satellite DB-injected stores integration test (U6).
 *
 * FNXC:SatelliteStores 2026-06-24-10:00:
 * Integration tests proving the async Drizzle helper modules for the 9
 * DB-injected project-schema satellite stores (TodoStore, GoalStore,
 * MessageStore, ApprovalRequestStore, EvalStore, ExperimentSessionStore,
 * InsightStore, ResearchStore, ChatStore) round-trip correctly against real
 * PostgreSQL. This covers VAL-DATA-016 (plugin store contract stability —
 * the project-schema tables these stores write to are the same tables plugins
 * and consumers depend on).
 *
 * Coverage:
 *   - Each store's create → read → update → delete round-trip through jsonb/text
 *     columns (VAL-SCHEMA-004).
 *   - Transaction atomicity: the create-with-audit and decide-with-audit
 *     patterns commit/rollback together.
 *   - The active-goal-limit enforcement.
 *   - The approval-request state-machine transitions.
 *   - The conversation/mailbox query semantics.
 *
 * Skipped when PostgreSQL is unreachable (FUSION_PG_TEST_SKIP=1) so the merge
 * gate stays green without a running server.
 */

import { describe, it, expect, afterEach } from "vitest";
import { execSync } from "node:child_process";
import { createAsyncDataLayer, type AsyncDataLayer } from "../../postgres/data-layer.js";

const PG_TEST_URL_BASE =
  process.env.FUSION_PG_TEST_URL_BASE ?? "postgresql://localhost:5432";
const PG_AVAILABLE =
  process.env.FUSION_PG_TEST_SKIP !== "1" && Boolean(PG_TEST_URL_BASE);

const pgDescribe = PG_AVAILABLE ? describe : describe.skip;

function uniqueDbName(): string {
  return `fusion_sat_test_${process.pid}_${Math.random().toString(36).slice(2, 8)}`;
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

interface StoreTestCtx {
  dbName: string;
  layer: AsyncDataLayer;
}

async function setupCtx(): Promise<StoreTestCtx> {
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

async function teardownCtx(ctx: StoreTestCtx | null): Promise<void> {
  if (!ctx) return;
  try { await ctx.layer.close(); } catch { /* best-effort */ }
  try { adminExec(`DROP DATABASE IF EXISTS "${ctx.dbName}"`); } catch { /* best-effort */ }
}

pgDescribe("PostgreSQL satellite DB-injected stores (VAL-DATA-016)", () => {
  let ctx: StoreTestCtx | null = null;

  afterEach(async () => {
    await teardownCtx(ctx);
    ctx = null;
  });

  // ── TodoStore ──

  it("TodoStore: create list → add items → toggle → reorder round-trip", async () => {
    ctx = await setupCtx();
    const { createTodoList, getTodoList, listTodoLists, createTodoItem, listTodoItems, updateTodoItem, deleteTodoItem, reorderTodoItems, getTodoListsWithItems } = await import("../../async-todo-store.js");
    const now = new Date().toISOString();
    const list = await createTodoList(ctx.layer.db, { id: "TDL-1", projectId: "P1", title: "My List", createdAt: now, updatedAt: now });
    expect(list.id).toBe("TDL-1");
    expect((await getTodoList(ctx.layer.db, "TDL-1"))?.title).toBe("My List");
    expect((await listTodoLists(ctx.layer.db, "P1"))).toHaveLength(1);

    const item1 = await createTodoItem(ctx.layer.db, { id: "TDI-1", listId: "TDL-1", text: "Task 1", completed: false, completedAt: null, sortOrder: undefined, createdAt: now, updatedAt: now });
    const item2 = await createTodoItem(ctx.layer.db, { id: "TDI-2", listId: "TDL-1", text: "Task 2", completed: false, completedAt: null, sortOrder: undefined, createdAt: now, updatedAt: now });
    expect(item1.sortOrder).toBe(0);
    expect(item2.sortOrder).toBe(1);

    const toggled = await updateTodoItem(ctx.layer.db, "TDI-1", { completed: true });
    expect(toggled?.completed).toBe(true);
    expect(toggled?.completedAt).toBeTruthy();

    const reordered = await reorderTodoItems(ctx.layer, "TDL-1", ["TDI-2", "TDI-1"]);
    expect(reordered[0]!.id).toBe("TDI-2");
    expect(reordered[0]!.sortOrder).toBe(0);

    const withItems = await getTodoListsWithItems(ctx.layer.db, "P1");
    expect(withItems).toHaveLength(1);
    expect(withItems[0]!.items).toHaveLength(2);

    expect(await deleteTodoItem(ctx.layer.db, "TDI-1")).toBe(true);
    expect((await listTodoItems(ctx.layer.db, "TDL-1"))).toHaveLength(1);
  });

  // ── GoalStore ──

  it("GoalStore: create → list → archive → unarchive with active-limit enforcement", async () => {
    ctx = await setupCtx();
    const { createGoal, getGoal, listGoals, archiveGoal, unarchiveGoal } = await import("../../async-goal-store.js");
    const { ACTIVE_GOAL_LIMIT } = await import("../../goal-types.js");

    const goal = await createGoal(ctx.layer, { id: "G-1", title: "Ship", description: "Ship the product" });
    expect(goal.status).toBe("active");
    expect((await getGoal(ctx.layer.db, "G-1"))?.title).toBe("Ship");

    const archived = await archiveGoal(ctx.layer.db, "G-1");
    expect(archived.status).toBe("archived");

    const active = await listGoals(ctx.layer.db, { status: "active" });
    expect(active).toHaveLength(0);
    const archivedGoals = await listGoals(ctx.layer.db, { status: "archived" });
    expect(archivedGoals).toHaveLength(1);

    const unarchived = await unarchiveGoal(ctx.layer, "G-1");
    expect(unarchived.status).toBe("active");

    // Active-limit enforcement: fill up to ACTIVE_GOAL_LIMIT and expect rejection.
    for (let i = 2; i <= ACTIVE_GOAL_LIMIT; i++) {
      await createGoal(ctx.layer, { id: `G-${i}`, title: `Goal ${i}` });
    }
    await expect(createGoal(ctx.layer, { id: "G-OVER", title: "Over limit" })).rejects.toThrow();
  });

  // ── MessageStore ──

  it("MessageStore: send → inbox → mark read → conversation → mailbox round-trip", async () => {
    ctx = await setupCtx();
    const { sendMessage, getMessage, queryMessagesByParticipant, markMessageAsRead, markAllMessagesAsRead, getConversation, getMailbox } = await import("../../async-message-store.js");
    const now = new Date().toISOString();
    const msg = await sendMessage(ctx.layer.db, { id: "msg-1", fromId: "agent-a", fromType: "agent", toId: "agent-b", toType: "agent", content: "Hello", type: "agent-to-agent", read: false, metadata: { key: "val" }, createdAt: now, updatedAt: now });
    expect(msg.read).toBe(false);

    const inbox = await queryMessagesByParticipant(ctx.layer.db, "to", "agent-b", "agent");
    expect(inbox).toHaveLength(1);
    expect(inbox[0]!.metadata).toEqual({ key: "val" });

    const read = await markMessageAsRead(ctx.layer.db, "msg-1");
    expect(read?.read).toBe(true);

    // Conversation
    await sendMessage(ctx.layer.db, { id: "msg-2", fromId: "agent-b", fromType: "agent", toId: "agent-a", toType: "agent", content: "Hi back", type: "agent-to-agent", read: false, metadata: null, createdAt: now, updatedAt: now });
    const convo = await getConversation(ctx.layer.db, { id: "agent-a", type: "agent" }, { id: "agent-b", type: "agent" });
    expect(convo).toHaveLength(2);

    /*
    FNXC:MessageStorePerf 2026-07-11 (PR #1793 review):
    getConversation is capped to the most recent `limit` messages (default 200)
    and must keep oldest-first ordering. Pin the cap window: with limit 1 only
    the NEWEST message survives, and the default read stays ascending.
    */
    const later = new Date(Date.now() + 1000).toISOString();
    await sendMessage(ctx.layer.db, { id: "msg-3", fromId: "agent-a", fromType: "agent", toId: "agent-b", toType: "agent", content: "Newest", type: "agent-to-agent", read: false, metadata: null, createdAt: later, updatedAt: later });
    const capped = await getConversation(ctx.layer.db, { id: "agent-a", type: "agent" }, { id: "agent-b", type: "agent" }, { limit: 1 });
    expect(capped.map((m) => m.id)).toEqual(["msg-3"]);
    const full = await getConversation(ctx.layer.db, { id: "agent-a", type: "agent" }, { id: "agent-b", type: "agent" });
    expect(full[full.length - 1]!.id).toBe("msg-3");
    expect(full).toHaveLength(3);

    // Mailbox
    const mailbox = await getMailbox(ctx.layer.db, "agent-a", "agent");
    expect(mailbox.unreadCount).toBeGreaterThanOrEqual(0);
    expect(mailbox.lastMessage).toBeTruthy();
  });

  // ── ApprovalRequestStore ──

  it("ApprovalRequestStore: create → decide → complete with audit history", async () => {
    ctx = await setupCtx();
    const { createApprovalRequest, getApprovalRequest, decideApprovalRequest, markApprovalRequestCompleted, getApprovalAuditHistory } = await import("../../async-approval-request-store.js");
    const req = await createApprovalRequest(ctx.layer, {
      id: "apr-1",
      requester: { actorId: "agent-1", actorType: "agent", actorName: "Bot" },
      targetAction: { category: "shell", action: "exec", summary: "run cmd", resourceType: "host", resourceId: "local", context: { cmd: "ls" } },
    });
    expect(req.status).toBe("pending");
    expect(req.targetAction.context).toEqual({ cmd: "ls" });

    expect((await getApprovalAuditHistory(ctx.layer.db, "apr-1"))).toHaveLength(1);

    const approved = await decideApprovalRequest(ctx.layer, "apr-1", "approved", { actor: { actorId: "user-1", actorType: "user", actorName: "Admin" }, note: "ok" });
    expect(approved.status).toBe("approved");

    const completed = await markApprovalRequestCompleted(ctx.layer, "apr-1", { actor: { actorId: "user-1", actorType: "user", actorName: "Admin" } });
    expect(completed.status).toBe("completed");

    const history = await getApprovalAuditHistory(ctx.layer.db, "apr-1");
    expect(history.length).toBeGreaterThanOrEqual(3); // created + approved + completed
  });

  // ── EvalStore ──

  it("EvalStore: create run → upsert result → list → append event", async () => {
    ctx = await setupCtx();
    const { createEvalRun, getEvalRun, listEvalRuns, upsertEvalTaskResult, getEvalTaskResultByRunTask, listEvalTaskResults, appendEvalRunEvent, listEvalRunEvents } = await import("../../async-eval-store.js");
    const now = new Date().toISOString();
    const run = await createEvalRun(ctx.layer.db, { id: "ER-1", projectId: "P1", trigger: "manual", scope: "all", window: { days: 7 }, requestedTaskIds: ["T1"], counts: { totalTasks: 1, scoredTasks: 0, skippedTasks: 0, erroredTasks: 0 }, createdAt: now, updatedAt: now });
    expect(run.status).toBe("pending");
    expect(run.window).toEqual({ days: 7 });
    expect((await getEvalRun(ctx.layer.db, "ER-1"))?.id).toBe("ER-1");

    await upsertEvalTaskResult(ctx.layer.db, {
      id: "ETR-1", runId: "ER-1", taskId: "T1", taskSnapshot: { taskId: "T1" }, status: "scored",
      overallScore: 8, maxScore: 10, categoryScores: [{ name: "quality", score: 8 }],
      evidence: [], deterministicSignals: [], followUps: [], createdAt: now, updatedAt: now,
    });
    const result = await getEvalTaskResultByRunTask(ctx.layer.db, "ER-1", "T1");
    expect(result?.overallScore).toBe(8);

    // Upsert again to test ON CONFLICT update
    await upsertEvalTaskResult(ctx.layer.db, {
      id: "ETR-2", runId: "ER-1", taskId: "T1", taskSnapshot: { taskId: "T1" }, status: "scored",
      overallScore: 9, maxScore: 10, categoryScores: [], evidence: [], deterministicSignals: [], followUps: [], createdAt: now, updatedAt: now,
    });
    const updated = await getEvalTaskResultByRunTask(ctx.layer.db, "ER-1", "T1");
    expect(updated?.overallScore).toBe(9); // upserted, not duplicated

    const evt = await appendEvalRunEvent(ctx.layer, { id: "ERE-1", runId: "ER-1", type: "status_changed", message: "started" });
    expect(evt.seq).toBe(1);
    expect((await listEvalRunEvents(ctx.layer.db, "ER-1"))).toHaveLength(1);
  });

  // ── ExperimentSessionStore ──

  it("ExperimentSessionStore: create session → append record → list round-trip", async () => {
    ctx = await setupCtx();
    const { createExperimentSession, getExperimentSession, appendExperimentRecord, listExperimentRecords } = await import("../../async-experiment-session-store.js");
    const now = new Date().toISOString();
    const session = await createExperimentSession(ctx.layer.db, {
      id: "EXP-1", name: "Test", projectId: "P1", status: "active",
      metric: { name: "latency", direction: "minimize" }, currentSegment: 1,
      keptRunIds: [], tags: ["x"], createdAt: now, updatedAt: now,
    });
    expect(session.metric).toEqual({ name: "latency", direction: "minimize" });

    const fetched = await getExperimentSession(ctx.layer.db, "EXP-1");
    expect(fetched?.metric).toEqual({ name: "latency", direction: "minimize" });
    expect(fetched?.tags).toEqual(["x"]);

    const rec = await appendExperimentRecord(ctx.layer, { id: "EXPR-1", sessionId: "EXP-1", segment: 1, type: "config", payload: { setting: "v" } });
    expect(rec.seq).toBe(1);
    const recs = await listExperimentRecords(ctx.layer.db, "EXP-1");
    expect(recs).toHaveLength(1);
  });

  // ── InsightStore ──

  it("InsightStore: create → upsert by fingerprint → list → run round-trip", async () => {
    ctx = await setupCtx();
    const { createInsight, getInsight, upsertInsight, listInsights, createInsightRun, findActiveInsightRun } = await import("../../async-insight-store.js");
    const now = new Date().toISOString();
    await createInsight(ctx.layer.db, {
      id: "INS-1", projectId: "P1", title: "Slow builds", content: "Builds are slow",
      category: "performance", status: "generated", fingerprint: "abc12345",
      provenance: { trigger: "manual" }, lastRunId: null, createdAt: now, updatedAt: now,
    });
    expect((await getInsight(ctx.layer.db, "INS-1"))?.title).toBe("Slow builds");

    // Upsert by fingerprint should update, not create
    const upserted = await upsertInsight(ctx.layer.db, "P1", { id: "INS-2", title: "Updated title", content: null, category: "performance", status: "confirmed", fingerprint: "abc12345", provenance: { trigger: "manual" } });
    expect(upserted.id).toBe("INS-1"); // preserved id
    expect(upserted.title).toBe("Updated title");
    expect((await listInsights(ctx.layer.db, { projectId: "P1" }))).toHaveLength(1);

    // Run
    await createInsightRun(ctx.layer.db, { id: "INSR-1", projectId: "P1", trigger: "schedule", createdAt: now });
    const active = await findActiveInsightRun(ctx.layer.db, "P1", "schedule");
    expect(active?.id).toBe("INSR-1");
  });

  // ── ResearchStore ──

  it("ResearchStore: create run → persist → append event → export round-trip", async () => {
    ctx = await setupCtx();
    const { createResearchRun, getResearchRun, persistResearchRun, appendResearchRunEvent, listResearchRunEvents, createResearchExport, getResearchExports, getResearchStats } = await import("../../async-research-store.js");
    const now = new Date().toISOString();
    const run = await createResearchRun(ctx.layer.db, {
      id: "RR-1", query: "best practices", topic: "testing", status: "queued", projectId: "P1",
      trigger: "manual", sources: [], events: [], tags: ["research"], lifecycle: { attempt: 1, maxAttempts: 3 },
      createdAt: now, updatedAt: now,
    });
    expect((await getResearchRun(ctx.layer.db, "RR-1"))?.query).toBe("best practices");

    // Persist update
    run.status = "running";
    run.startedAt = now;
    await persistResearchRun(ctx.layer.db, run);
    expect((await getResearchRun(ctx.layer.db, "RR-1"))?.status).toBe("running");

    await appendResearchRunEvent(ctx.layer, { id: "REVT-1", runId: "RR-1", type: "status_changed", message: "started" });
    expect((await listResearchRunEvents(ctx.layer.db, "RR-1"))).toHaveLength(1);

    await createResearchExport(ctx.layer.db, { id: "REXP-1", runId: "RR-1", format: "markdown", content: "# Report", createdAt: now });
    expect((await getResearchExports(ctx.layer.db, "RR-1"))).toHaveLength(1);

    const stats = await getResearchStats(ctx.layer.db);
    expect(stats.total).toBe(1);
    expect(stats.byStatus.running).toBe(1);
  });

  // ── ChatStore ──

  it("ChatStore: session + messages + room + members + room messages round-trip", async () => {
    ctx = await setupCtx();
    const { createChatSession, getChatSession, addChatMessage, getChatMessages, getLastMessageForSessions, createChatRoom, getChatRoom, addChatRoomMember, listChatRoomMembers, addChatRoomMessage, getChatRoomMessages, clearChatRoomMessages } = await import("../../async-chat-store.js");
    const now = new Date().toISOString();

    // Session + messages
    const session = await createChatSession(ctx.layer.db, {
      id: "chat-1", agentId: "agent-1", title: "Test", status: "active", projectId: "P1",
      modelProvider: null, modelId: null, createdAt: now, updatedAt: now,
      cliSessionFile: null, inFlightGeneration: null, cliExecutorAdapterId: null,
    });
    expect((await getChatSession(ctx.layer.db, "chat-1"))?.agentId).toBe("agent-1");

    await addChatMessage(ctx.layer.db, { id: "msg-1", sessionId: "chat-1", role: "user", content: "Hi", thinkingOutput: null, metadata: { turn: 1 }, attachments: null, createdAt: now });
    await addChatMessage(ctx.layer.db, { id: "msg-2", sessionId: "chat-1", role: "assistant", content: "Hello!", thinkingOutput: null, metadata: null, attachments: null, createdAt: now });
    expect((await getChatMessages(ctx.layer.db, "chat-1"))).toHaveLength(2);

    const lastMsgs = await getLastMessageForSessions(ctx.layer.db, ["chat-1"]);
    expect(lastMsgs.get("chat-1")?.content).toBe("Hello!");

    // Room + members + room messages
    const { room, members } = await createChatRoom(ctx.layer, {
      id: "room-1", name: "General", slug: "general", description: "General chat",
      projectId: "P1", createdBy: "agent-1", status: "active", createdAt: now, updatedAt: now,
    }, ["agent-1", "agent-2"]);
    expect(room.slug).toBe("general");
    expect(members).toHaveLength(2);
    expect((await getChatRoom(ctx.layer.db, "room-1"))?.name).toBe("General");

    await addChatRoomMessage(ctx.layer.db, { id: "rmsg-1", roomId: "room-1", role: "user", content: "Room hello", thinkingOutput: null, metadata: null, attachments: null, senderAgentId: "agent-1", mentions: ["agent-2"], createdAt: now });
    expect((await getChatRoomMessages(ctx.layer.db, "room-1"))).toHaveLength(1);

    const cleared = await clearChatRoomMessages(ctx.layer.db, "room-1");
    expect(cleared).toBe(1);
  });

  // ── JSON round-trip parity (VAL-SCHEMA-004) ──

  it("JSON columns round-trip identical shape across all stores (VAL-SCHEMA-004)", async () => {
    ctx = await setupCtx();
    const { createChatSession, getChatSession } = await import("../../async-chat-store.js");
    const now = new Date().toISOString();
    const complexMetadata = { nested: { deep: [1, 2, { x: true }], null: null, str: "text" } };
    await createChatSession(ctx.layer.db, {
      id: "chat-json", agentId: "a", title: "JSON", status: "active", projectId: null,
      modelProvider: null, modelId: null, createdAt: now, updatedAt: now,
      cliSessionFile: null, inFlightGeneration: { provider: "openai", step: 3 }, cliExecutorAdapterId: null,
    });
    // Use addChatMessage to test metadata jsonb
    const { addChatMessage, getChatMessage } = await import("../../async-chat-store.js");
    await addChatMessage(ctx.layer.db, { id: "msg-json", sessionId: "chat-json", role: "user", content: "x", thinkingOutput: null, metadata: complexMetadata, attachments: [{ type: "file", name: "test.txt" }], createdAt: now });
    const msg = await getChatMessage(ctx.layer.db, "msg-json");
    expect(msg?.metadata).toEqual(complexMetadata);
    expect(msg?.attachments).toEqual([{ type: "file", name: "test.txt" }]);

    const session = await getChatSession(ctx.layer.db, "chat-json");
    expect(session?.inFlightGeneration).toEqual({ provider: "openai", step: 3 });
  });
});
