/**
 * FNXC:ChatSearch 2026-07-07-14:00:
 * PostgreSQL port of the upstream sqlite chat-store.content-search.test.ts (FN-7631) plus
 * coverage for the FN-7628 edit/rewind store primitives. The sqlite ChatStore path is gone on
 * this branch (Database.init throws — SqliteFinalRemoval), so these exercise the async
 * Drizzle helpers directly against a real PostgreSQL database:
 *   - searchChatSessionsByMessageContent: content match, dedup to most-recent match,
 *     wildcard escaping (%/_ literal), scope filtering, empty-query/empty-scope no-ops.
 *   - deleteChatMessagesFrom: truncation from a target message (inclusive), retained
 *     ordering, wrong-session/not-found no-op.
 *   - updateChatMessageMetadata: merge (default) vs replace, missing-message error.
 *
 * Skipped when PostgreSQL is unreachable (FUSION_PG_TEST_SKIP=1) so the merge gate stays
 * green without a running server. Mirrors the satellite-db-injected-stores harness.
 */

import { describe, it, expect, afterEach } from "vitest";
import { execSync } from "node:child_process";
import { createAsyncDataLayer, type AsyncDataLayer } from "../../postgres/data-layer.js";
import {
  addChatMessage,
  createChatSession,
  deleteChatMessagesFrom,
  getChatMessages,
  searchChatSessionsByMessageContent,
  updateChatMessageMetadata,
} from "../../async-chat-store.js";
import type { ChatMessage, ChatSession } from "../../chat-types.js";

const PG_TEST_URL_BASE =
  process.env.FUSION_PG_TEST_URL_BASE ?? "postgresql://localhost:5432";
const PG_AVAILABLE =
  process.env.FUSION_PG_TEST_SKIP !== "1" && Boolean(PG_TEST_URL_BASE);

const pgDescribe = PG_AVAILABLE ? describe : describe.skip;

function uniqueDbName(): string {
  return `fusion_chat_search_test_${process.pid}_${Math.random().toString(36).slice(2, 8)}`;
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

interface Ctx {
  dbName: string;
  layer: AsyncDataLayer;
}

async function setupCtx(): Promise<Ctx> {
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

async function teardownCtx(ctx: Ctx | null): Promise<void> {
  if (!ctx) return;
  try { await ctx.layer.close(); } catch { /* best-effort */ }
  try { adminExec(`DROP DATABASE IF EXISTS "${ctx.dbName}"`); } catch { /* best-effort */ }
}

let sessionCounter = 0;
let messageCounter = 0;

async function makeSession(ctx: Ctx, title: string | null = "Untitled"): Promise<ChatSession> {
  const now = new Date().toISOString();
  const id = `chat-cs-${++sessionCounter}`;
  return createChatSession(ctx.layer.db, {
    id,
    agentId: "agent-001",
    title,
    status: "active",
    projectId: null,
    modelProvider: null,
    modelId: null,
    cliSessionFile: null,
    createdAt: now,
    updatedAt: now,
  } as ChatSession);
}

async function addMessage(
  ctx: Ctx,
  sessionId: string,
  role: "user" | "assistant",
  content: string,
  metadata: Record<string, unknown> | null = null,
): Promise<ChatMessage> {
  // Monotonic createdAt so most-recent-match dedup is deterministic.
  const createdAt = new Date(Date.now() + ++messageCounter).toISOString();
  return addChatMessage(ctx.layer.db, {
    id: `msg-cs-${messageCounter}`,
    sessionId,
    role,
    content,
    thinkingOutput: null,
    metadata,
    attachments: undefined,
    createdAt,
  });
}

pgDescribe("async chat store content search + edit primitives (PostgreSQL)", () => {
  let ctx: Ctx | null = null;

  afterEach(async () => {
    await teardownCtx(ctx);
    ctx = null;
  });

  it("matches by message content, dedups to the most recent match, and respects scope", async () => {
    ctx = await setupCtx();

    const session = await makeSession(ctx, "Weekend plans");
    await addMessage(ctx, session.id, "user", "Let's talk about the quarterly roadmap");
    const single = await searchChatSessionsByMessageContent(ctx.layer.db, "roadmap", [session.id]);
    expect(single.get(session.id)).toBe("Let's talk about the quarterly roadmap");

    // Assistant-only match.
    const deploySession = await makeSession(ctx);
    await addMessage(ctx, deploySession.id, "user", "How do I deploy?");
    await addMessage(ctx, deploySession.id, "assistant", "Use the falcon deploy script");
    const assistantMatch = await searchChatSessionsByMessageContent(ctx.layer.db, "falcon", [deploySession.id]);
    expect(assistantMatch.get(deploySession.id)).toBe("Use the falcon deploy script");

    // Dedup: one entry per session, most recent matching message wins.
    const multi = await makeSession(ctx);
    await addMessage(ctx, multi.id, "user", "first mention of gizmo");
    await addMessage(ctx, multi.id, "assistant", "second mention of gizmo here");
    await addMessage(ctx, multi.id, "user", "third gizmo reference, most recent");
    const deduped = await searchChatSessionsByMessageContent(ctx.layer.db, "gizmo", [multi.id]);
    expect(deduped.size).toBe(1);
    expect(deduped.get(multi.id)).toBe("third gizmo reference, most recent");

    // No match / empty query / empty scope.
    expect((await searchChatSessionsByMessageContent(ctx.layer.db, "nonexistent-term", [session.id])).size).toBe(0);
    expect((await searchChatSessionsByMessageContent(ctx.layer.db, "   ", [session.id])).size).toBe(0);
    expect((await searchChatSessionsByMessageContent(ctx.layer.db, "anything", [])).size).toBe(0);

    // Scope: an identical message in an out-of-scope session is not returned.
    const outOfScope = await makeSession(ctx);
    await addMessage(ctx, outOfScope.id, "user", "Let's talk about the quarterly roadmap");
    const scoped = await searchChatSessionsByMessageContent(ctx.layer.db, "roadmap", [session.id]);
    expect(scoped.size).toBe(1);
    expect(scoped.has(outOfScope.id)).toBe(false);
  });

  it("treats literal % and _ as literal characters, not LIKE wildcards", async () => {
    ctx = await setupCtx();

    const literalSession = await makeSession(ctx);
    await addMessage(ctx, literalSession.id, "user", "Discount is 50% off, use code A_B");
    const otherSession = await makeSession(ctx);
    await addMessage(ctx, otherSession.id, "user", "Discount is 50X off, use code AZB");

    const percentResult = await searchChatSessionsByMessageContent(
      ctx.layer.db, "50%", [literalSession.id, otherSession.id],
    );
    expect(percentResult.has(literalSession.id)).toBe(true);
    expect(percentResult.has(otherSession.id)).toBe(false);

    const underscoreResult = await searchChatSessionsByMessageContent(
      ctx.layer.db, "A_B", [literalSession.id, otherSession.id],
    );
    expect(underscoreResult.has(literalSession.id)).toBe(true);
    expect(underscoreResult.has(otherSession.id)).toBe(false);
  });

  it("deleteChatMessagesFrom truncates from the target (inclusive) and preserves retained order", async () => {
    ctx = await setupCtx();

    const session = await makeSession(ctx);
    const m1 = await addMessage(ctx, session.id, "user", "first turn");
    const m2 = await addMessage(ctx, session.id, "assistant", "first reply");
    const m3 = await addMessage(ctx, session.id, "user", "second turn");
    const m4 = await addMessage(ctx, session.id, "assistant", "second reply");

    const { deletedIds, retained } = await deleteChatMessagesFrom(ctx.layer.db, session.id, m3.id);
    expect(deletedIds).toEqual([m3.id, m4.id]);
    expect(retained.map((m) => m.id)).toEqual([m1.id, m2.id]);

    const remaining = await getChatMessages(ctx.layer.db, session.id);
    expect(remaining.map((m) => m.content)).toEqual(["first turn", "first reply"]);
  });

  it("deleteChatMessagesFrom is a no-op for a wrong-session or unknown target", async () => {
    ctx = await setupCtx();

    const sessionA = await makeSession(ctx);
    const sessionB = await makeSession(ctx);
    const a1 = await addMessage(ctx, sessionA.id, "user", "keep me");
    const b1 = await addMessage(ctx, sessionB.id, "user", "other session");

    const wrongSession = await deleteChatMessagesFrom(ctx.layer.db, sessionA.id, b1.id);
    expect(wrongSession.deletedIds).toEqual([]);
    expect(wrongSession.retained.map((m) => m.id)).toEqual([a1.id]);

    const unknown = await deleteChatMessagesFrom(ctx.layer.db, sessionA.id, "msg-does-not-exist");
    expect(unknown.deletedIds).toEqual([]);
    expect((await getChatMessages(ctx.layer.db, sessionA.id)).length).toBe(1);
  });

  it("updateChatMessageMetadata merges by default, replaces on merge:false, and throws for missing messages", async () => {
    ctx = await setupCtx();

    const session = await makeSession(ctx);
    const message = await addMessage(ctx, session.id, "user", "hello", { mentions: ["@a"] });

    const merged = await updateChatMessageMetadata(ctx.layer.db, message.id, { piParentLeafId: "leaf-1" });
    expect(merged.metadata).toEqual({ mentions: ["@a"], piParentLeafId: "leaf-1" });

    const replaced = await updateChatMessageMetadata(
      ctx.layer.db, message.id, { only: true }, { merge: false },
    );
    expect(replaced.metadata).toEqual({ only: true });

    await expect(
      updateChatMessageMetadata(ctx.layer.db, "msg-missing", { x: 1 }),
    ).rejects.toThrow(/not found/);
  });
});
