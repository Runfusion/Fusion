/**
 * FNXC:PostgresBackend 2026-06-28-10:30:
 * PostgreSQL-backed coverage for the read path the agent wake-on-message hook now
 * uses. `agent-heartbeat.handleMessageToAgent` previously read the recipient via
 * the sync `AgentStore.getCachedAgent`/`readAgent`, which throws in PG backend
 * mode — the send succeeded (MessageStore wraps the hook in try/catch) but the
 * agent never woke. The hook is now async and reads via `AgentStore.getAgent`.
 * This proves that async path resolves a created agent against embedded Postgres,
 * so the rewritten hook can actually find its recipient.
 *
 * Auto-skipped via pgDescribe when PostgreSQL is absent.
 */

import { it, expect, beforeAll, beforeEach, afterEach, afterAll } from "vitest";
import {
  pgDescribe,
  createSharedPgTaskStoreTestHarness,
  type SharedPgTaskStoreHarness,
} from "../../__test-utils__/pg-test-harness.js";
import { AgentStore } from "../../agent-store.js";

const pgTest = pgDescribe;

pgTest("AgentStore.getAgent backs the async wake hook (PostgreSQL)", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({
    prefix: "fusion_agent_wake_getagent",
  });

  let agentStore: AgentStore;

  beforeAll(h.beforeAll);

  beforeEach(async () => {
    await h.beforeEach();
    agentStore = new AgentStore({ rootDir: h.rootDir(), asyncLayer: h.layer() });
    await agentStore.init();
  });

  afterEach(async () => {
    try {
      await agentStore.close();
    } catch {
      // best-effort
    }
    await h.afterEach();
  });

  afterAll(h.afterAll);

  it("async getAgent returns a created agent (the wake hook's new read path)", async () => {
    const created = await agentStore.createAgent({ name: "wake-target", role: "executor" });

    // This is exactly what handleMessageToAgent now awaits in place of the sync
    // getCachedAgent that threw in PG mode.
    const fetched = await agentStore.getAgent(created.id);

    expect(fetched).not.toBeNull();
    expect(fetched?.id).toBe(created.id);
    expect(fetched?.name).toBe("wake-target");
    // A valid wake state — handleMessageToAgent gates on active/idle/running.
    expect(["active", "idle", "running"]).toContain(fetched?.state);
  });

  it("async getAgent returns null for an unknown recipient (hook early-returns)", async () => {
    expect(await agentStore.getAgent("agent-does-not-exist")).toBeNull();
  });
});
