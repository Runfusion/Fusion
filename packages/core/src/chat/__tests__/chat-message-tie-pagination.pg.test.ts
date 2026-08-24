/**
 * FNXC:ChatStashBackfillTiePagination 2026-08-21-17:25:
 * RUFU-146 review (PRRT_kwDOSA-8Y86bNP8U, Greptile P1) regression: the Stash
 * backfill route (POST /chat/sessions/:id/backfill-stash) pages a session's
 * full history via getChatMessages({limit, offset, order:"asc"}). The read
 * used to order by created_at ALONE — a non-unique key (chat_messages.
 * created_at is a text ISO timestamp; bursts share values). When equal
 * values straddle a page boundary, PostgreSQL's tie order is plan-dependent:
 * a tied row can be returned on both pages while another tied row is omitted
 * entirely, so the backfill reports success with an incomplete or duplicated
 * Stash transcript. The fix makes the order a TOTAL order — (created_at, id)
 * — and these tests pin it:
 *   1. ties break by id in BOTH directions (fails pre-fix: tied rows came
 *      back in physical/insertion order, which the inserts deliberately
 *      arrange against id order),
 *   2. the backfill's own offset loop over a tie-heavy session loses nothing,
 *      duplicates nothing, and is stable across repeated passes.
 *
 * Skipped when PostgreSQL is unreachable (FUSION_PG_TEST_SKIP=1) so the merge
 * gate stays green without a running server. Uses the shared PG harness
 * (one template-cloned database per file, per-test reset).
 */

import { it, expect, beforeAll, beforeEach, afterEach, afterAll } from "vitest";
import type { AsyncDataLayer } from "../../postgres/data-layer.js";
import {
  pgDescribe,
  createSharedPgTaskStoreTestHarness,
  type SharedPgTaskStoreHarness,
} from "../../__test-utils__/pg-test-harness.js";
import {
  addChatMessage,
  createChatSession,
  getChatMessages,
} from "../../async-stores/async-chat-store.js";
import type { ChatMessage, ChatSession } from "../../chat/chat-types.js";

interface Ctx {
  layer: AsyncDataLayer;
}

let sessionCounter = 0;

async function makeSession(ctx: Ctx): Promise<ChatSession> {
  const now = new Date().toISOString();
  const id = `chat-tie-${++sessionCounter}`;
  return createChatSession(ctx.layer.db, {
    id,
    agentId: "agent-001",
    title: `Tie pagination session ${sessionCounter}`,
    status: "active",
    projectId: null,
    modelProvider: null,
    modelId: null,
    cliSessionFile: null,
    createdAt: now,
    updatedAt: now,
  } as ChatSession);
}

/** Insert a message with fully controlled id + createdAt (the public
 * ChatStore.addMessage generates both, which cannot express a tie). */
async function insertMessage(ctx: Ctx, sessionId: string, id: string, createdAt: string): Promise<ChatMessage> {
  return addChatMessage(ctx.layer.db, {
    id,
    sessionId,
    role: "user",
    content: `content-${id}`,
    thinkingOutput: null,
    metadata: null,
    attachments: undefined,
    createdAt,
  });
}

/** Mirror of the backfill route's read loop (asc, fixed page size, break on
 * a short page) — parameterized page size so ties straddle every boundary. */
async function pageAll(ctx: Ctx, sessionId: string, pageSize: number): Promise<string[]> {
  const seen: string[] = [];
  for (let offset = 0; offset < 100 * pageSize; offset += pageSize) {
    const page = await getChatMessages(ctx.layer.db, sessionId, { limit: pageSize, offset, order: "asc" });
    seen.push(...page.map((m) => m.id));
    if (page.length < pageSize) break;
  }
  return seen;
}

pgDescribe("async chat store message pagination tie ordering (RUFU-146 / PRRT_kwDOSA-8Y86bNP8U)", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({
    prefix: "fusion_chat_tie_test",
  });
  let ctx: Ctx;

  beforeAll(h.beforeAll);
  beforeEach(async () => {
    await h.beforeEach();
    ctx = { layer: h.layer() };
  });
  afterEach(h.afterEach);
  afterAll(h.afterAll);

  it("breaks createdAt ties by message id ascending (total order)", async () => {
    const session = await makeSession(ctx);
    // Insert OUT of id order so the pre-fix tied order (physical/insertion
    // order) provably differs from the asserted id order.
    const T = "2026-08-21T10:00:00.000Z";
    await insertMessage(ctx, session.id, "msg-tie-c", T);
    await insertMessage(ctx, session.id, "msg-tie-a", T);
    await insertMessage(ctx, session.id, "msg-tie-m", T);

    const asc = await getChatMessages(ctx.layer.db, session.id, { limit: 10, order: "asc" });
    expect(asc.map((m) => m.id)).toEqual(["msg-tie-a", "msg-tie-c", "msg-tie-m"]);
  });

  it("breaks createdAt ties by message id descending", async () => {
    const session = await makeSession(ctx);
    const T = "2026-08-21T10:00:00.000Z";
    await insertMessage(ctx, session.id, "msg-tie-c", T);
    await insertMessage(ctx, session.id, "msg-tie-a", T);
    await insertMessage(ctx, session.id, "msg-tie-m", T);

    const descRead = await getChatMessages(ctx.layer.db, session.id, { limit: 10, order: "desc" });
    expect(descRead.map((m) => m.id)).toEqual(["msg-tie-m", "msg-tie-c", "msg-tie-a"]);
  });

  it("backfill-style offset pagination across tied boundaries loses and duplicates nothing, and is stable", async () => {
    const session = await makeSession(ctx);
    // 11 messages; 9 share one createdAt straddling BOTH page boundaries of
    // limit-5 pagination. Tied rows are inserted in reverse id order so any
    // physical-order dependence is exercised, not masked.
    const TIE = "2026-08-21T11:00:00.000Z";
    const plan = [
      "2026-08-21T10:59:59.000Z",
      TIE, TIE, TIE, TIE,
      TIE, TIE, TIE, TIE, TIE,
      "2026-08-21T11:00:01.000Z",
    ];
    const ids: string[] = [];
    plan.forEach((createdAt, i) => ids.push(`msg-tie-bf-${String(i).padStart(2, "0")}`));
    await insertMessage(ctx, session.id, ids[0], plan[0]);
    for (let i = 9; i >= 1; i--) {
      await insertMessage(ctx, session.id, ids[i], plan[i]);
    }
    await insertMessage(ctx, session.id, ids[10], plan[10]);

    const seen = await pageAll(ctx, session.id, 5);
    expect(seen).toHaveLength(11);
    expect(new Set(seen).size).toBe(11);
    expect([...seen].sort()).toEqual([...ids].sort());
    // With (created_at, id) total order the exact sequence is also known.
    expect(seen).toEqual([...ids].sort());

    // Stability: a second pass yields the identical sequence.
    const again = await pageAll(ctx, session.id, 5);
    expect(again).toEqual(seen);
  });
});
