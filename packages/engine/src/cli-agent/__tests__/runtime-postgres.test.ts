/**
 * FNXC:CliAgentPostgres 2026-07-14-12:00:
 * Enabling the experimental CLI Agent Executor must bootstrap from the shared
 * PostgreSQL data layer and flush its durable session queue on shutdown.
 */
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CliSessionStore, type AsyncDataLayer } from "@fusion/core";
import { createCliAgentRuntime } from "../runtime.js";

describe("createCliAgentRuntime PostgreSQL wiring", () => {
  afterEach(() => vi.restoreAllMocks());

  it("hydrates from AsyncDataLayer and flushes persistence during disposal", async () => {
    const flush = vi.fn(async () => {});
    const fakeStore = Object.assign(new EventEmitter(), {
      flush,
      listSessions: () => [],
      listByTask: () => [],
      getSession: () => undefined,
      createSession: vi.fn(),
      updateSession: vi.fn(),
      deleteSession: vi.fn(),
    }) as unknown as CliSessionStore;
    const layer = { db: {} } as AsyncDataLayer;
    const create = vi.spyOn(CliSessionStore, "create").mockResolvedValue(fakeStore);

    const runtime = await createCliAgentRuntime({
      fusionDir: "/tmp/fusion-cli-agent-test",
      asyncLayer: layer,
      projectId: "project-a",
      hookEndpointUrl: "http://127.0.0.1:4545/api/cli-agent/hooks",
    });

    expect(create).toHaveBeenCalledWith(layer, "project-a");
    expect(runtime.bundle.store).toBe(fakeStore);
    await runtime.dispose();
    expect(flush).toHaveBeenCalledOnce();
  });
});
