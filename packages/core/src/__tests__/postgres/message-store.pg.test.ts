/**
 * FNXC:PostgresBackend 2026-06-27-06:30:
 * PostgreSQL coverage for the mailbox (MessageStore) send path. MessageStore is
 * already dual-path (async-layer in backend mode), but POST /api/messages to an
 * AGENT 500'd: the agent-delivery hook (agent-heartbeat.handleMessageToAgent)
 * reads the not-yet-ported sync AgentStore and throws synchronously inside the
 * send, after the message was persisted. The fix wraps the hook so a wake-hook
 * failure logs-and-degrades instead of failing an already-persisted send. Runs
 * in the blocking test:pg-gate lane.
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from "vitest";

import {
  pgDescribe,
  createSharedPgTaskStoreTestHarness,
  type SharedPgTaskStoreHarness,
} from "../../__test-utils__/pg-test-harness.js";

const pgTest = pgDescribe;

pgTest("MessageStore send (PostgreSQL backend mode)", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({
    prefix: "fusion_message_store",
  });

  beforeAll(h.beforeAll);
  beforeEach(h.beforeEach);
  afterEach(h.afterEach);
  afterAll(h.afterAll);

  it("agent-to-agent send persists and survives a throwing wake-hook", async () => {
    const { MessageStore } = await import("../../message-store.js");
    const store = new MessageStore(null, { asyncLayer: h.layer() });

    // Mirror the engine wiring: the agent-delivery hook reads the sync AgentStore
    // and throws in PG mode. The send must NOT propagate that failure.
    let hookFired = false;
    store.setMessageToAgentHook(() => {
      hookFired = true;
      throw new Error("SQLite Database is not available in backend mode (asyncLayer injected)");
    });

    const msg = await store.sendMessage({
      fromId: "agent-a",
      fromType: "agent",
      toId: "agent-b",
      toType: "agent",
      content: "hello agent",
      type: "agent-to-agent",
    });

    expect(msg.id).toBeTruthy();
    expect(hookFired).toBe(true); // the hook ran (and threw) but did not fail the send

    // The message is durably persisted to project.messages.
    const fetched = await store.getMessage(msg.id);
    expect(fetched?.content).toBe("hello agent");
    const inbox = await store.getInbox("agent-b", "agent");
    expect(inbox.map((m) => m.id)).toContain(msg.id);
  });

  it("a non-agent send (no wake-hook) persists normally", async () => {
    const { MessageStore } = await import("../../message-store.js");
    const store = new MessageStore(null, { asyncLayer: h.layer() });
    const msg = await store.sendMessage({
      fromId: "agent-a",
      fromType: "agent",
      toId: "user-x",
      toType: "user",
      content: "hi user",
      type: "agent-to-user",
    });
    expect((await store.getMessage(msg.id))?.content).toBe("hi user");
  });

  it("round-trips native structure embeds through mailbox metadata", async () => {
    const { MessageStore } = await import("../../message-store.js");
    const store = new MessageStore(null, { asyncLayer: h.layer() });
    const nativeStructures = [
      { kind: "mission" as const, id: "M-1", label: "Launch roadmap" },
      { kind: "goal" as const, id: "G-1", projectId: "project-1" },
    ];
    const sent = await store.sendMessage({
      fromId: "agent-a",
      fromType: "agent",
      toId: "user-x",
      toType: "user",
      content: "Review these structures",
      type: "agent-to-user",
      metadata: { nativeStructures },
    });

    expect(sent.metadata?.nativeStructures).toEqual(nativeStructures);
    expect((await store.getMessage(sent.id))?.metadata?.nativeStructures).toEqual(nativeStructures);
  });

  /*
  FNXC:PostgresMigrationInbox 2026-07-14-12:10:
  Once-only inbox delivery must use PostgreSQL's primary-key conflict handling as the concurrency authority; parallel callers may share the resulting message, but only one may report inserting it.
  */
  it("atomically inserts an idempotent message once under concurrent sends", async () => {
    const { MessageStore } = await import("../../message-store.js");
    const store = new MessageStore(null, { asyncLayer: h.layer() });
    const input = {
      fromType: "system" as const,
      toType: "user" as const,
      toId: "dashboard",
      content: "migration complete",
      type: "system" as const,
      metadata: { kind: "postgres-migration-complete" },
    };

    const outcomes = await Promise.all([
      store.sendMessageOnce(input, "postgres-migration-complete"),
      store.sendMessageOnce(input, "postgres-migration-complete"),
    ]);

    expect(outcomes.filter((outcome) => outcome.inserted)).toHaveLength(1);
    expect(new Set(outcomes.map((outcome) => outcome.message.id)).size).toBe(1);
    const completionMessages = (await store.getInbox("dashboard", "user"))
      .filter((message) => message.metadata?.kind === "postgres-migration-complete");
    expect(completionMessages).toHaveLength(1);
  });

  /*
  FNXC:PostgresMigrationNulSanitize 2026-07-20:
  Same NUL-byte hazard as the chat-store regression (chat-store-content-search-edit.pg.test.ts):
  agent-to-agent/agent-to-user mailbox content can carry raw tool output
  containing a literal U+0000 byte, which Postgres's text/jsonb columns
  reject outright ("unsupported Unicode escape sequence" / "\u0000 cannot be
  converted to text"). sendMessage now sanitizes content/metadata before
  insert — verify a NUL-laden send round-trips instead of throwing.
  */
  it("sendMessage strips a raw U+0000 byte instead of throwing", async () => {
    const { MessageStore } = await import("../../message-store.js");
    const store = new MessageStore(null, { asyncLayer: h.layer() });

    const diagnosticDump =
      "===FUSION DB AGENTS===\n===NODES===\n\u0000===RUNNING PROCESSES===\n";
    const sent = await store.sendMessage({
      fromId: "agent-ceo",
      fromType: "agent",
      toId: "user-x",
      toType: "user",
      content: diagnosticDump,
      type: "agent-to-user",
      metadata: { toolOutput: "payload\u0000tail" },
    });

    expect(sent.content).toBe(
      "===FUSION DB AGENTS===\n===NODES===\n===RUNNING PROCESSES===\n",
    );
    expect(sent.metadata?.toolOutput).toBe("payloadtail");

    const fetched = await store.getMessage(sent.id);
    expect(fetched?.content).toBe(
      "===FUSION DB AGENTS===\n===NODES===\n===RUNNING PROCESSES===\n",
    );
    expect(fetched?.metadata?.toolOutput).toBe("payloadtail");
  });
});
