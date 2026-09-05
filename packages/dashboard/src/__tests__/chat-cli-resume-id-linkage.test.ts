// @vitest-environment node
/**
 * FNXC:CliChatResumeIdLinkage 2026-08-23-02:51:
 * RUFU-142: spawn→kill→resume integration test on the chat-runner path — the
 * id-linkage gap RUFU-128 deliberately sidestepped (it tested at manager level
 * with the minted record id read back from the store). The chat runner's
 * `ensureSession` resumes with `resume: { sessionId: chatSessionId,
 * nativeSessionId }` — the CHAT session id, not the minted `cli-<…>` record
 * id (the record id is not available to the runner) — so without the
 * chat_session_id linkage resolution in the manager's resume branch, every
 * fresh runner instance (e.g. after an engine restart) died with
 * `UnknownCliSessionError`. These tests exercise the real
 * `CliSessionManager` + real `CliChatSessionRunner` against in-memory fakes:
 * no real PTY, process, or network.
 *
 * Harness mirrors `session-manager-chat-recall.test.ts` (fake pty, fake
 * `CliSessionStore`, `supportsResume` test adapter, real `CliAdapterRegistry`,
 * `loadPty`-injected seam) plus the `chat-cli-sessions.test.ts` chat-store
 * fake; the runner's manager slice is composed exactly as `server.ts` does.
 */
import { EventEmitter } from "node:events";
import type { IPty } from "node-pty";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CliSessionStore,
  type ChatMessage,
  type ChatMessageCreateInput,
  type ChatSession,
  type CliSession,
} from "@fusion/core";
import {
  CliAdapterRegistry,
  CliSessionManager,
  UnknownCliSessionError,
  type CliAgentAdapter,
} from "@fusion/engine";
import { CliChatSessionRunner, type ChatStoreLike } from "../cli-chat.js";

// ── Fakes ────────────────────────────────────────────────────────────────

interface FakePty {
  pid: number;
  onData(cb: (data: string) => void): void;
  onExit(cb: (result: { exitCode: number; signal?: number }) => void): void;
  kill(signal?: string): void;
  write(data: string): void;
  resize(cols: number, rows: number): void;
}

function makeFakePty(): FakePty {
  return {
    pid: 424242,
    onData: () => {},
    onExit: () => {},
    kill: () => {},
    write: () => {},
    resize: () => {},
  };
}

interface FakeCliStoreWorld {
  store: CliSessionStore;
  sessions: Map<string, CliSession>;
}

/**
 * In-memory `CliSessionStore`: mints deterministic `cli-<nnnn>` ids for fresh
 * records (spreading input last so tests can pin explicit ids), field-merges
 * updates (like the real store, stamping `updatedAt`), and implements
 * `listByChatSession` as filter + `updatedAt` desc sort, mirroring
 * `listSessions({ chatSessionId })` in cli-session-store.ts.
 */
function makeFakeCliStore(): FakeCliStoreWorld {
  const sessions = new Map<string, CliSession>();
  let counter = 0;
  const store = Object.assign(new EventEmitter(), {
    sessions,
    flush: vi.fn(async () => {}),
    createSession: vi.fn((input: Partial<CliSession>) => {
      counter += 1;
      const now = new Date().toISOString();
      const session: CliSession = {
        id: `cli-${String(counter).padStart(4, "0")}`,
        taskId: null,
        chatSessionId: null,
        purpose: "chat",
        projectId: "proj-1",
        adapterId: "test",
        agentState: "starting",
        terminationReason: null,
        nativeSessionId: null,
        resumeAttempts: 0,
        autonomyPosture: null,
        worktreePath: null,
        createdAt: now,
        updatedAt: now,
        ...input,
      } as CliSession;
      sessions.set(session.id, session);
      return session;
    }),
    getSession: vi.fn((id: string) => sessions.get(id)),
    updateSession: vi.fn((id: string, input: Partial<CliSession>) => {
      const existing = sessions.get(id);
      if (!existing) return undefined;
      const updated: CliSession = { ...existing, ...input, updatedAt: new Date().toISOString() };
      sessions.set(id, updated);
      return updated;
    }),
    listSessions: vi.fn(() => [...sessions.values()]),
    listByChatSession: vi.fn((chatSessionId: string) =>
      [...sessions.values()]
        .filter((s) => s.chatSessionId === chatSessionId)
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    ),
    deleteSession: vi.fn((id: string) => sessions.delete(id)),
  }) as unknown as CliSessionStore;
  return { store, sessions };
}

/**
 * In-memory `ChatStoreLike` — mirrors the fake in chat-cli-sessions.test.ts,
 * adding the fields `ChatSession` now requires (`tags`, `thinkingLevel`,
 * `memoryFocus`, `pinnedAt`).
 */
class FakeChatStore implements ChatStoreLike {
  sessions = new Map<string, ChatSession>();
  messages: ChatMessage[] = [];
  private seq = 0;

  putSession(partial: Partial<ChatSession> & { id: string }): ChatSession {
    const now = new Date().toISOString();
    const session: ChatSession = {
      id: partial.id,
      agentId: "agent-1",
      tags: [],
      title: null,
      status: "active",
      projectId: "proj-1",
      modelProvider: null,
      modelId: null,
      thinkingLevel: null,
      memoryFocus: null,
      pinnedAt: null,
      createdAt: now,
      updatedAt: now,
      cliSessionFile: null,
      cliExecutorAdapterId: "test",
      inFlightGeneration: null,
      ...partial,
    };
    this.sessions.set(session.id, session);
    return session;
  }

  getSession(id: string): ChatSession | undefined {
    return this.sessions.get(id);
  }

  addMessage(sessionId: string, input: ChatMessageCreateInput): ChatMessage {
    this.seq += 1;
    const msg: ChatMessage = {
      id: `msg-${this.seq}`,
      sessionId,
      role: input.role,
      content: input.content ?? "",
      thinkingOutput: null,
      metadata: input.metadata ?? null,
      createdAt: new Date().toISOString(),
    };
    this.messages.push(msg);
    return msg;
  }

  setCliExecutorAdapterId(id: string, adapterId: string | null): ChatSession | undefined {
    const s = this.sessions.get(id);
    if (!s) return undefined;
    s.cliExecutorAdapterId = adapterId;
    return s;
  }

  // Used by the runner to persist the native session id linkage.
  setCliSessionFile(id: string, value: string): void {
    const s = this.sessions.get(id);
    if (s) s.cliSessionFile = value;
  }
}

function makeAdapter(): CliAgentAdapter {
  return {
    id: "test",
    name: "Test",
    capabilities: {
      nativeDone: false,
      nativeWaiting: false,
      transcriptSource: "none",
      supportsResume: true,
    },
    buildLaunch: vi.fn(() => ({ command: "test-agent", args: ["--launch"] })),
    buildResume: vi.fn(() => ({ command: "test-agent", args: ["--resume"] })),
    buildEnvAllowlist: () => [],
    createReadinessDetector: () => ({ observe: () => true }),
    formatInjection: (text: string) => ({ payload: text }),
  } as unknown as CliAgentAdapter;
}

/** Read `.mock.calls` off a vi.fn behind a wider (store) type. */
function mockCalls(fn: unknown): unknown[][] {
  return (fn as { mock: { calls: unknown[][] } }).mock.calls;
}

interface World {
  manager: CliSessionManager;
  store: CliSessionStore;
  chatStore: FakeChatStore;
  provider: ReturnType<typeof vi.fn>;
  makeRunner: () => CliChatSessionRunner;
}

/**
 * Real `CliSessionManager` (loadPty seam injected) + the runner manager slice
 * composed exactly as server.ts does: spawn/inject passthrough plus a freshly
 * read store-record getter for flush decisions.
 */
function makeWorld(): World {
  const registry = new CliAdapterRegistry();
  registry.register(makeAdapter());
  const { store } = makeFakeCliStore();
  const chatStore = new FakeChatStore();
  const pty = makeFakePty();
  const provider = vi.fn(async () => null);
  const manager = new CliSessionManager({
    registry,
    store,
    loadPty: vi.fn(async () => ({ spawn: () => pty })) as unknown as () => Promise<{
      spawn: () => IPty;
    }>,
    launchSettingsProvider: provider,
  });
  const managerSlice = {
    spawn: (opts: {
      adapterId: string;
      projectId: string;
      purpose: "chat";
      chatSessionId: string;
      worktreePath?: string | null;
      resume?: { sessionId: string; nativeSessionId: string };
    }) => manager.spawn(opts),
    inject: (sessionId: string, text: string) => manager.inject(sessionId, text),
    getSession: (sessionId: string) => {
      const r = store.getSession(sessionId);
      return r
        ? { id: r.id, nativeSessionId: r.nativeSessionId, agentState: r.agentState }
        : undefined;
    },
  };
  return {
    manager,
    store,
    chatStore,
    provider,
    makeRunner: () => new CliChatSessionRunner({ store: chatStore, manager: managerSlice }),
  };
}

// ── Spawn → kill → resume on the chat-runner path ────────────────────────

describe("CliChatSessionRunner resume id-linkage (RUFU-142)", () => {
  let world: World;

  beforeEach(() => {
    world = makeWorld();
  });

  afterEach(() => {
    world.manager.dispose();
  });

  it("resumes the minted record via the chat_session_id linkage after a restart", async () => {
    const { manager, store, chatStore, provider, makeRunner } = world;
    chatStore.putSession({ id: "chat-1" });

    // Fresh spawn: the store mints a cli-<…> record id distinct from the chat id.
    const runner1 = makeRunner();
    const cliId = await runner1.ensureSession("chat-1", { projectId: "proj-1" });
    expect(cliId).toMatch(/^cli-/);
    expect(cliId).not.toBe("chat-1");

    // Telemetry learns the native session id; the runner persists it on the
    // chat record (the cliSessionFile column is the native-id linkage here).
    await runner1.handleTelemetry("chat-1", {
      kind: "sessionStart",
      nativeSessionId: "native-X",
    });
    expect(chatStore.getSession("chat-1")?.cliSessionFile).toBe("native-X");

    // Engine restart: the live session is killed (record → dead, live map
    // cleared) and the runner instance's in-memory map is gone.
    manager.kill(cliId);

    // A fresh runner instance resumes by the CHAT session id — pre-fix this
    // step threw UnknownCliSessionError("chat-1").
    const runner2 = makeRunner();
    const resumedId = await runner2.ensureSession("chat-1", { projectId: "proj-1" });

    // Symptom gone: the resume resolves the MINTED record, not a new one.
    expect(resumedId).toBe(cliId);
    // No record was ever stored under the chat id.
    expect(store.getSession("chat-1")).toBeUndefined();
    // Resolution went through the persisted chat_session_id linkage.
    expect(mockCalls(store.listByChatSession).some((c) => c[0] === "chat-1")).toBe(true);
    // The record is moved back to "starting" by its OWN id — never by the
    // chat id (last updateSession call is the resume's; kill's precedes it).
    const updates = mockCalls(store.updateSession);
    expect(updates[updates.length - 1][0]).toBe(cliId);
    expect(
      (updates[updates.length - 1][1] as { agentState: string }).agentState,
    ).toBe("starting");
    for (const call of updates) {
      expect(call[0]).not.toBe("chat-1");
    }
    // The launch-settings provider is keyed by the record id, never the chat id.
    for (const call of mockCalls(provider)) {
      expect(call[0]).not.toBe("chat-1");
    }
    expect(mockCalls(provider).at(-1)?.[0]).toBe(cliId);
    // Final durable state.
    expect(store.getSession(cliId)).toMatchObject({ agentState: "starting" });
  });

  it("still throws UnknownCliSessionError for a chat with zero cli_sessions records", async () => {
    const { store, chatStore, makeRunner } = world;
    // The chat believes it has a native session id, but no record exists.
    chatStore.putSession({ id: "chat-2", cliSessionFile: "native-Y" });

    const runner = makeRunner();
    const err = await runner
      .ensureSession("chat-2", { projectId: "proj-1" })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(UnknownCliSessionError);
    // The error carries the caller's (chat) id for operator traceability.
    expect((err as UnknownCliSessionError).sessionId).toBe("chat-2");
    // No over-resolution: the resume path mints no new record.
    expect(mockCalls(store.createSession)).toHaveLength(0);
  });

  it("prefers the record whose nativeSessionId matches over the newest record", async () => {
    const { store, chatStore, makeRunner } = world;
    const base = Date.parse("2026-08-23T00:00:00Z");
    const iso = (ms: number) => new Date(ms).toISOString();

    // Record A: OLDER, but carries the native id the chat record points at.
    const a = store.createSession({
      id: "cli-chat3-a",
      purpose: "chat",
      projectId: "proj-1",
      adapterId: "test",
      chatSessionId: "chat-3",
      nativeSessionId: "native-OLD",
    });
    // Record B: NEWER, but a different native id.
    const b = store.createSession({
      id: "cli-chat3-b",
      purpose: "chat",
      projectId: "proj-1",
      adapterId: "test",
      chatSessionId: "chat-3",
      nativeSessionId: "native-NEW",
    });
    // Pin explicit timestamps (A older than B) on the stored references —
    // createSession inputs do not carry createdAt/updatedAt.
    a.updatedAt = iso(base - 5_000);
    b.updatedAt = iso(base - 1_000);

    chatStore.putSession({ id: "chat-3", cliSessionFile: "native-OLD" });

    const runner = makeRunner();
    const resumedId = await runner.ensureSession("chat-3", { projectId: "proj-1" });

    // The nativeSessionId match wins over the newest-record fallback.
    expect(resumedId).toBe(a.id);
    expect(store.getSession(a.id)).toMatchObject({ agentState: "starting" });
    // The newer record B is untouched.
    for (const call of mockCalls(store.updateSession)) {
      expect(call[0]).not.toBe(b.id);
    }
  });
});
