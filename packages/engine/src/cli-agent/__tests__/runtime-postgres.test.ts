/**
 * FNXC:CliAgentPostgres 2026-07-14-12:00:
 * Enabling the experimental CLI Agent Executor must bootstrap from the shared
 * PostgreSQL data layer and flush its durable session queue on shutdown.
 */
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CliSessionStore, type AsyncDataLayer } from "@fusion/core";
import type { IPty } from "node-pty";
import { CliAdapterRegistry, type CliAgentAdapter } from "../adapter.js";
import { createCliAgentRuntime } from "../runtime.js";
import { CliSessionManager } from "../session-manager.js";

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

  it("preserves a PTY spawn failure when dead-state persistence also fails", async () => {
    /*
    FNXC:CliAgentPostgres 2026-07-14-21:33:
    Spawn-failure persistence is diagnostic cleanup; callers must receive the original PTY error even when the queued PostgreSQL flush rejects.
    */
    const spawnError = new Error("pty spawn failed");
    const flushError = new Error("postgres flush failed");
    const flush = vi.fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(flushError);
    const record = {
      id: "session-1",
      adapterId: "test",
      projectId: "project-a",
      purpose: "execute",
      taskId: null,
      chatSessionId: null,
      worktreePath: null,
      autonomyPosture: null,
      agentState: "starting",
    };
    const updateSession = vi.fn(() => record);
    const fakeStore = Object.assign(new EventEmitter(), {
      flush,
      createSession: vi.fn(() => record),
      updateSession,
      getSession: vi.fn(),
    }) as unknown as CliSessionStore;
    const registry = new CliAdapterRegistry();
    registry.register({
      id: "test",
      name: "Test",
      capabilities: {
        nativeDone: false,
        nativeWaiting: false,
        transcriptSource: "none",
        supportsResume: false,
      },
      buildLaunch: () => ({ command: "test-agent", args: [] }),
      buildEnvAllowlist: () => [],
      createReadinessDetector: () => ({ observe: () => true }),
      formatInjection: (text) => ({ payload: text }),
    } satisfies CliAgentAdapter);
    const manager = new CliSessionManager({
      registry,
      store: fakeStore,
      loadPty: vi.fn(async () => ({
        spawn: () => {
          throw spawnError;
        },
      })) as unknown as () => Promise<{ spawn: () => IPty }>,
    });

    try {
      await expect(manager.spawn({
        adapterId: "test",
        projectId: "project-a",
        purpose: "execute",
      })).rejects.toBe(spawnError);
      expect(flush).toHaveBeenCalledTimes(2);
      expect(updateSession).toHaveBeenCalledWith("session-1", {
        agentState: "dead",
        terminationReason: "crashed",
      });
    } finally {
      manager.dispose();
    }
  });
});
