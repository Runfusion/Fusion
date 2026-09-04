import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatInFlightGenerationState, ChatSession, ChatStore, TaskStore } from "@fusion/core";
import { CHAT_IN_FLIGHT_GENERATION_STALE_MS, SelfHealingManager } from "../self-healing.js";

/*
FNXC:ChatInFlightRecovery 2026-08-20-20:17 (RUFU-144):
A dashboard restart leaves `project.chat_sessions.in_flight_generation` stuck at
{"status":"generating"} forever, and every client re-attach reopens a streaming UI
state that never resolves (zombie "generating" thinking boxes — four stale rows 1–9
days old were observed 2026-08-20). A generation cannot outlive the dashboard process
that started it and no owner/PID is recorded, so `startedAt` (fallback: session
`updated_at` for pre-fix legacy rows) older than the staleness floor is the liveness
proof. These tests pin the engine self-healing sweep: it clears proven-stale rows,
keeps fresh rows, NEVER clears rows whose age cannot be proven, audits ids/counts
only (sessionIds capped at 20), and dedupes the no-action event until a clear re-arms
it.
*/

function inFlight(overrides: Partial<ChatInFlightGenerationState> = {}): ChatInFlightGenerationState {
  return {
    status: "generating",
    streamingText: "partial answer",
    streamingThinking: "still thinking",
    toolCalls: [],
    replayFromEventId: 0,
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function minutesAgo(minutes: number): string {
  return new Date(Date.now() - minutes * 60_000).toISOString();
}

function session(id: string, inFlightGeneration: ChatInFlightGenerationState | null, updatedAt = minutesAgo(5)): ChatSession {
  return {
    id,
    projectScope: "default",
    title: `session ${id}`,
    messages: [],
    updatedAt,
    inFlightGeneration,
  } as unknown as ChatSession;
}

function chatStoreFor(sessions: ChatSession[]): ChatStore {
  const byId = new Map(sessions.map((entry) => [entry.id, entry]));
  return {
    listSessions: vi.fn(async () => [...byId.values()]),
    setInFlightGeneration: vi.fn(async (id: string, snapshot: ChatInFlightGenerationState | null) => {
      const current = byId.get(id);
      if (current) current.inFlightGeneration = snapshot;
    }),
  } as unknown as ChatStore;
}

/*
FNXC:ChatInFlightRecovery 2026-09-04-05:38:
ThreatCrush CWE-377: SelfHealingManager rootDir in this suite is a dummy path, but a
predictable OS temporary-directory name still trips CWE-377. mkdtempSync + afterAll cleanup
keeps the fixture exclusive.
*/
const TEST_ROOT = mkdtempSync(join(tmpdir(), "rufu-144-chat-test-"));
afterAll(() => {
  rmSync(TEST_ROOT, { recursive: true, force: true });
});

function managerFor(sessions: ChatSession[], recordRunAuditEvent: ReturnType<typeof vi.fn>): {
  manager: SelfHealingManager;
  chatStore: ChatStore;
} {
  const chatStore = chatStoreFor(sessions);
  const manager = new SelfHealingManager(
    { recordRunAuditEvent } as unknown as TaskStore,
    { rootDir: TEST_ROOT, chatStore },
  );
  return { manager, chatStore };
}

describe("RUFU-144: reconcile stale in-flight chat generations", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.restoreAllMocks());

  it("clears a flag whose startedAt is older than the 30-minute floor and audits ids/counts only", async () => {
    const stale = session("chat-stale", inFlight({ startedAt: minutesAgo(45), updatedAt: minutesAgo(45) }));
    const recordRunAuditEvent = vi.fn().mockResolvedValue(undefined);
    const { manager, chatStore } = managerFor([stale], recordRunAuditEvent);

    expect(await manager.reconcileStaleInFlightChatGenerations()).toBe(1);
    expect(chatStore.setInFlightGeneration).toHaveBeenCalledTimes(1);
    expect(chatStore.setInFlightGeneration).toHaveBeenCalledWith("chat-stale", null);
    expect(recordRunAuditEvent).toHaveBeenCalledTimes(1);
    expect(recordRunAuditEvent.mock.calls[0]?.[0]).toMatchObject({
      mutationType: "chat:stale-in-flight-generation-cleared",
      target: "chat-sessions",
      metadata: { count: 1, sessionIds: ["chat-stale"], outcome: "cleared" },
    });
  });

  it("leaves a fresh flag (startedAt within the floor) untouched and emits no audit row", async () => {
    const fresh = session("chat-fresh", inFlight({ startedAt: minutesAgo(1) }));
    const recordRunAuditEvent = vi.fn().mockResolvedValue(undefined);
    const { manager, chatStore } = managerFor([fresh], recordRunAuditEvent);

    expect(await manager.reconcileStaleInFlightChatGenerations()).toBe(0);
    expect(chatStore.setInFlightGeneration).not.toHaveBeenCalled();
    // Candidate exists but is fresh: exactly one deduped no-action row on the first sweep.
    expect(recordRunAuditEvent).toHaveBeenCalledTimes(1);
    expect(recordRunAuditEvent.mock.calls[0]?.[0]).toMatchObject({
      mutationType: "chat:stale-in-flight-generation-no-action",
      metadata: { count: 0, outcome: "no-action" },
    });
  });

  it("uses session updated_at as the staleness reference for legacy rows without startedAt", async () => {
    const legacyStale = session("chat-legacy-stale", inFlight({ startedAt: undefined }), minutesAgo(120));
    const legacyFresh = session("chat-legacy-fresh", inFlight({ startedAt: undefined }), minutesAgo(2));
    const recordRunAuditEvent = vi.fn().mockResolvedValue(undefined);
    const { manager, chatStore } = managerFor([legacyStale, legacyFresh], recordRunAuditEvent);

    expect(await manager.reconcileStaleInFlightChatGenerations()).toBe(1);
    expect(chatStore.setInFlightGeneration).toHaveBeenCalledTimes(1);
    expect(chatStore.setInFlightGeneration).toHaveBeenCalledWith("chat-legacy-stale", null);
  });

  it("prefers startedAt over updated_at when both are parseable", async () => {
    // updated_at is stale but the generation is fresh: startedAt must win (live re-attach).
    const live = session("chat-live", inFlight({ startedAt: minutesAgo(5) }), minutesAgo(600));
    const recordRunAuditEvent = vi.fn().mockResolvedValue(undefined);
    const { manager, chatStore } = managerFor([live], recordRunAuditEvent);

    expect(await manager.reconcileStaleInFlightChatGenerations()).toBe(0);
    expect(chatStore.setInFlightGeneration).not.toHaveBeenCalled();
  });

  it("NEVER clears a row whose age cannot be proven (both timestamps unparseable)", async () => {
    const unknownAge = session("chat-unknown", inFlight({ startedAt: "not-a-date" }), "not-a-date");
    const recordRunAuditEvent = vi.fn().mockResolvedValue(undefined);
    const { manager, chatStore } = managerFor([unknownAge], recordRunAuditEvent);

    expect(await manager.reconcileStaleInFlightChatGenerations()).toBe(0);
    expect(chatStore.setInFlightGeneration).not.toHaveBeenCalled();
    expect(recordRunAuditEvent).toHaveBeenCalledTimes(1);
    expect(recordRunAuditEvent.mock.calls[0]?.[0]).toMatchObject({
      mutationType: "chat:stale-in-flight-generation-no-action",
    });
  });

  it("ignores sessions with no in-flight flag or a non-generating status", async () => {
    const cleared = session("chat-cleared", null);
    const none = session("chat-none", undefined);
    const recordRunAuditEvent = vi.fn().mockResolvedValue(undefined);
    const { manager, chatStore } = managerFor([cleared, none], recordRunAuditEvent);

    expect(await manager.reconcileStaleInFlightChatGenerations()).toBe(0);
    expect(chatStore.setInFlightGeneration).not.toHaveBeenCalled();
    // Zero candidates: no audit row at all (idle silence, not a finding).
    expect(recordRunAuditEvent).not.toHaveBeenCalled();
  });

  it("caps audited sessionIds at 20 while reporting the true cleared count", async () => {
    const staleSessions = Array.from({ length: 25 }, (_, index) =>
      session(`chat-${String(index).padStart(2, "0")}`, inFlight({ startedAt: minutesAgo(90) })),
    );
    const recordRunAuditEvent = vi.fn().mockResolvedValue(undefined);
    const { manager } = managerFor(staleSessions, recordRunAuditEvent);

    expect(await manager.reconcileStaleInFlightChatGenerations()).toBe(25);
    expect(recordRunAuditEvent).toHaveBeenCalledTimes(1);
    const input = recordRunAuditEvent.mock.calls[0]?.[0] as { metadata?: { count?: number; sessionIds?: string[] } };
    expect(input.metadata?.count).toBe(25);
    expect(input.metadata?.sessionIds).toHaveLength(20);
  });

  it("keeps sweeping past a per-row clear failure and reports only successful clears", async () => {
    const failing = session("chat-fail", inFlight({ startedAt: minutesAgo(120) }));
    const ok = session("chat-ok", inFlight({ startedAt: minutesAgo(120) }));
    const recordRunAuditEvent = vi.fn().mockResolvedValue(undefined);
    const { manager, chatStore } = managerFor([failing, ok], recordRunAuditEvent);
    const setInFlightGeneration = chatStore.setInFlightGeneration as unknown as ReturnType<typeof vi.fn>;
    setInFlightGeneration.mockImplementation(async (id: string) => {
      if (id === "chat-fail") throw new Error("simulated store failure");
    });

    expect(await manager.reconcileStaleInFlightChatGenerations()).toBe(1);
    const input = recordRunAuditEvent.mock.calls[0]?.[0] as { metadata?: { count?: number; sessionIds?: string[] } };
    expect(input.metadata?.count).toBe(1);
    expect(input.metadata?.sessionIds).toEqual(["chat-ok"]);
  });

  it("dedupes the no-action audit until a cleared sweep re-arms it", async () => {
    const fresh = session("chat-fresh", inFlight({ startedAt: minutesAgo(1) }));
    const recordRunAuditEvent = vi.fn().mockResolvedValue(undefined);
    const { manager } = managerFor([fresh], recordRunAuditEvent);

    expect(await manager.reconcileStaleInFlightChatGenerations()).toBe(0);
    expect(await manager.reconcileStaleInFlightChatGenerations()).toBe(0);
    expect(await manager.reconcileStaleInFlightChatGenerations()).toBe(0);
    // Three idle sweeps -> exactly ONE no-action audit.
    expect(recordRunAuditEvent).toHaveBeenCalledTimes(1);
    expect(recordRunAuditEvent.mock.calls[0]?.[0]).toMatchObject({
      mutationType: "chat:stale-in-flight-generation-no-action",
    });

    // A clear re-arms the diagnostic: the next idle sweep audits no-action again.
    fresh.inFlightGeneration = inFlight({ startedAt: minutesAgo(31) });
    expect(await manager.reconcileStaleInFlightChatGenerations()).toBe(1);
    fresh.inFlightGeneration = inFlight({ startedAt: minutesAgo(1) });
    expect(await manager.reconcileStaleInFlightChatGenerations()).toBe(0);
    expect(recordRunAuditEvent).toHaveBeenCalledTimes(3);
    expect(recordRunAuditEvent.mock.calls[1]?.[0]).toMatchObject({
      mutationType: "chat:stale-in-flight-generation-cleared",
    });
    expect(recordRunAuditEvent.mock.calls[2]?.[0]).toMatchObject({
      mutationType: "chat:stale-in-flight-generation-no-action",
    });
  });

  it("returns 0 without touching the store when no chatStore is configured", async () => {
    const recordRunAuditEvent = vi.fn().mockResolvedValue(undefined);
    const manager = new SelfHealingManager({ recordRunAuditEvent } as unknown as TaskStore, { rootDir: TEST_ROOT });

    expect(await manager.reconcileStaleInFlightChatGenerations()).toBe(0);
    expect(recordRunAuditEvent).not.toHaveBeenCalled();
  });

  it("survives a throwing listSessions without auditing or crashing", async () => {
    const recordRunAuditEvent = vi.fn().mockResolvedValue(undefined);
    const chatStore = {
      listSessions: vi.fn(async () => {
        throw new Error("simulated store failure");
      }),
      setInFlightGeneration: vi.fn(),
    } as unknown as ChatStore;
    const manager = new SelfHealingManager(
      { recordRunAuditEvent } as unknown as TaskStore,
      { rootDir: TEST_ROOT, chatStore },
    );

    expect(await manager.reconcileStaleInFlightChatGenerations()).toBe(0);
    expect(recordRunAuditEvent).not.toHaveBeenCalled();
  });

  /*
  FNXC:ChatInFlightRecovery 2026-08-20-21:10 (RUFU-144):
  Run-audit telemetry is best-effort (FN-9175): a hostile sink (synchronously throwing, then
  asynchronously rejecting) must never prevent the sweep from clearing stale rows or from
  resolving — the bounded audit seam absorbs both shapes.
  */
  it("keeps clearing and resolving when the audit sink is hostile (throwing, then rejecting)", async () => {
    {
      const stale = session("chat-hostile-throw", inFlight({ startedAt: minutesAgo(31) }));
      const recordRunAuditEvent = vi.fn().mockImplementation(() => {
        throw new Error("simulated sync audit sink failure");
      });
      const { manager, chatStore } = managerFor([stale], recordRunAuditEvent);

      await expect(manager.reconcileStaleInFlightChatGenerations()).resolves.toBe(1);
      expect(chatStore.setInFlightGeneration).toHaveBeenCalledWith("chat-hostile-throw", null);
    }
    {
      const stale = session("chat-hostile-reject", inFlight({ startedAt: minutesAgo(31) }));
      const recordRunAuditEvent = vi.fn().mockImplementation(async () => {
        throw new Error("simulated async audit sink failure");
      });
      const { manager, chatStore } = managerFor([stale], recordRunAuditEvent);

      await expect(manager.reconcileStaleInFlightChatGenerations()).resolves.toBe(1);
      expect(chatStore.setInFlightGeneration).toHaveBeenCalledWith("chat-hostile-reject", null);
    }
  });

  /*
  FNXC:ChatInFlightRecovery 2026-08-20-21:10 (RUFU-144):
  The sweep must be wired into BOTH liveness nets: the startup recovery steps array (catches
  flags stranded by a dashboard/engine restart) and maintenance batch 1 (catches a generation
  stranded while the process stayed up). Source-slice assertion mirrors the tested pattern in
  self-healing-reattach-orphaned-executions.test.ts.
  */
  it("is registered in startup recovery and maintenance batch 1", () => {
    const source = readFileSync("src/self-healing.ts", "utf8");
    const startup = source.slice(source.indexOf("async runStartupRecovery"), source.indexOf("  stop(): void"));
    expect(startup).toContain('name: "reconcile-stale-in-flight-chat-generations"');
    expect(startup).toContain("reconcileStaleInFlightChatGenerations");
    const maintenance = source.slice(source.indexOf("const batch1Fns"), source.indexOf("const batch2Fns"));
    expect(maintenance).toContain('name: "reconcile-stale-in-flight-chat-generations"');
  });
});

describe("RUFU-144: staleness floor constant", () => {
  it("is exactly 30 minutes, far above any single LLM turn", () => {
    expect(CHAT_IN_FLIGHT_GENERATION_STALE_MS).toBe(30 * 60_000);
  });
});
