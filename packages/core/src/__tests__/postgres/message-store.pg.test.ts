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
});
