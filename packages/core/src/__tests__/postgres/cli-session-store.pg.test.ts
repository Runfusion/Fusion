/**
 * FNXC:CliAgentPostgres 2026-07-14-12:00:
 * The experimental CLI Agent Executor must persist and rehydrate its session
 * lifecycle through PostgreSQL; no SQLite database is available at runtime.
 */
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { CliSessionStore } from "../../cli/cli-session-store.js";
import {
  createSharedPgTaskStoreTestHarness,
  pgDescribe,
  type SharedPgTaskStoreHarness,
} from "../../__test-utils__/pg-test-harness.js";

pgDescribe("CliSessionStore PostgreSQL persistence", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({
    prefix: "fusion_cli_session_store",
  });

  beforeAll(h.beforeAll);
  beforeEach(h.beforeEach);
  afterEach(h.afterEach);
  afterAll(h.afterAll);

  it("persists, updates, filters, deletes, and rehydrates project sessions", async () => {
    const store = await CliSessionStore.create(h.layer(), "project-a");
    const created = store.createSession({
      id: "cli-pg-1",
      projectId: "project-a",
      adapterId: "codex",
      purpose: "execute",
      taskId: "FN-9000",
      autonomyPosture: { autoApprove: true },
    });
    await store.flush();

    expect(created.agentState).toBe("starting");
    expect(store.listByTask("FN-9000")).toHaveLength(1);
    store.updateSession(created.id, {
      agentState: "waitingOnInput",
      nativeSessionId: "native-1",
      resumeAttempts: 2,
    });
    await store.flush();

    const rehydrated = await CliSessionStore.create(h.layer(), "project-a");
    expect(rehydrated.getSession(created.id)).toMatchObject({
      agentState: "waitingOnInput",
      nativeSessionId: "native-1",
      resumeAttempts: 2,
      autonomyPosture: { autoApprove: true },
    });
    expect(rehydrated.listSessions({ agentState: "waitingOnInput" })).toHaveLength(1);
    expect((await CliSessionStore.create(h.layer(), "project-b")).listSessions()).toEqual([]);

    expect(rehydrated.deleteSession(created.id)).toBe(true);
    await rehydrated.flush();
    expect((await CliSessionStore.create(h.layer(), "project-a")).getSession(created.id)).toBeUndefined();
  });

  it("surfaces a queued PostgreSQL write failure at every durability boundary", async () => {
    /*
    FNXC:CliAgentPostgresDurability 2026-07-14-19:00:
    Session mutations are synchronous for event-driven callers, but a rejected queued write must remain observable at flush instead of becoming an unhandled rejection or a false durability success.
    */
    const layer = h.layer();
    const store = await CliSessionStore.create(layer, "project-a");
    const failure = new Error("forced queued write failure");
    const insert = vi.spyOn(layer.db, "insert").mockImplementationOnce(() => ({
      values: () => Promise.reject(failure),
    }) as never);
    try {
      store.createSession({
        id: "cli-pg-write-failure",
        projectId: "project-a",
        adapterId: "codex",
        purpose: "execute",
      });

      await expect(store.flush()).rejects.toBe(failure);
      await expect(store.flush()).rejects.toBe(failure);
      expect(store.getSession("cli-pg-write-failure")).toBeDefined();
    } finally {
      insert.mockRestore();
    }
  });
});
